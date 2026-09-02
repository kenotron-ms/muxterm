//go:build unix

package sessiond

import (
	"errors"
	"fmt"
	"net"
	"syscall"
	"time"
)

// DaemonPID returns the pid of the daemon currently listening on socketPath,
// via SO_PEERCRED on a throwaway connection.
//
// Asking the kernel who is on the other end of a live connection is the only
// answer that cannot be stale: a pidfile survives a crash and a recycled pid
// would then name an unrelated process, which is unacceptable for a caller
// that goes on to signal what it finds.
func DaemonPID(socketPath string) (int, error) {
	conn, err := net.DialTimeout("unix", socketPath, 250*time.Millisecond)
	if err != nil {
		return 0, fmt.Errorf("dial sessiond at %s: %w", socketPath, err)
	}
	defer func() { _ = conn.Close() }()
	pid, err := peerPID(conn)
	if err != nil {
		return 0, fmt.Errorf("read sessiond pid: %w", err)
	}
	return pid, nil
}

// RestartDaemon stops the daemon listening on socketPath and brings a fresh
// one up in its place, holding the spawn lock across the entire window.
//
// Used by the self-update path: a new web binary talking to an old daemon is
// exactly the mismatch this avoids. Callers must first confirm the running
// daemon will actually restore panes (update.CheckRestoreCapability) --
// restarting one that cannot restore destroys every pane with nothing to
// bring back.
func RestartDaemon(socketPath, logPath string, timeout time.Duration) error {
	// The lock is taken FIRST and held to the end. Go unlinks the Unix socket
	// as soon as the outgoing daemon closes its listener, so IsAlive reads
	// "dead" while it is still writing its shutdown snapshot; without the lock
	// a browser reconnect landing in that window spawns a second daemon on top
	// of the one still shutting down.
	release, err := acquireSpawnLock(5 * time.Second)
	if err != nil {
		return fmt.Errorf("restart sessiond: %w", err)
	}
	defer release()

	// Identify the daemon BEFORE signalling anything. A failure here returns
	// without killing: never SIGTERM a pid we did not positively identify as
	// the process serving this socket.
	pid, err := DaemonPID(socketPath)
	if err != nil {
		return fmt.Errorf("identify running sessiond: %w", err)
	}

	// SIGTERM, not SIGKILL: the daemon's own shutdown path writes the restore
	// snapshot that its replacement reads back. ESRCH means it exited between
	// the dial above and this signal -- already gone is the outcome we wanted.
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("signal sessiond (pid %d): %w", pid, err)
	}
	if err := waitForExit(pid, timeout); err != nil {
		return err
	}

	// Still holding the lock, so go straight to the locked spawn body:
	// EnsureDaemon would try to take the same lock and deadlock on it.
	if err := ensureDaemonLocked(socketPath, logPath); err != nil {
		return fmt.Errorf("respawn sessiond: %w", err)
	}
	return nil
}

// waitForExit blocks until pid is gone, bounded by timeout.
//
// The zombie subtlety this exists for: sessiond is launched by SpawnCommand
// via cmd.Start() and is never Wait()ed, so when this process is the one that
// spawned it, the daemon is our child and becomes a ZOMBIE on exit rather than
// disappearing. kill(pid, 0) succeeds against a zombie forever, so a naive
// liveness poll would never terminate. Wait4 with WNOHANG reaps it and reports
// that it really exited; processLive covers the other case, where the daemon
// is not our child (spawned by a previous web process, or by systemd) and
// Wait4 fails with ECHILD -- an expected, ignorable outcome, not an error.
//
// It deliberately does NOT wait on the socket file disappearing. That unlinks
// the instant the listener closes, long before the shutdown snapshot is
// written, so returning on it would hand the socket back while the outgoing
// daemon is still mid-capture -- the exact race this function exists to avoid.
func waitForExit(pid int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		var ws syscall.WaitStatus
		if wpid, err := syscall.Wait4(pid, &ws, syscall.WNOHANG, nil); err == nil && wpid == pid {
			return nil
		}
		if !processLive(pid) {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("sessiond (pid %d) did not exit within %s", pid, timeout)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
