//go:build unix

package sessiond

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// socketDir resolves the directory that holds the daemon's Unix socket and
// log file. It follows the XDG Base Directory spec for the runtime dir:
//   - If XDG_RUNTIME_DIR is set, uses $XDG_RUNTIME_DIR/muxterm.
//   - Otherwise falls back to a uid-scoped directory under the system temp
//     dir (e.g. /tmp/muxterm-1000) so two users never collide.
func socketDir() string {
	if base := os.Getenv("XDG_RUNTIME_DIR"); base != "" {
		return filepath.Join(base, "muxterm")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("muxterm-%d", os.Getuid()))
}

// SocketPath returns the path to the daemon's Unix socket.
//
// The (string, error) signature is part of the frozen daemon contract: later
// phases import and error-check this exact arity even though the current
// implementation is a pure path join that never errors.
func SocketPath() (string, error) {
	return filepath.Join(socketDir(), "sessiond.sock"), nil
}

// DefaultLogPath returns the path to the daemon's log file, which sits beside
// the socket in the same directory.
//
// The (string, error) signature is part of the frozen daemon contract; see
// SocketPath for details.
func DefaultLogPath() (string, error) {
	return filepath.Join(socketDir(), "sessiond.log"), nil
}

// SpawnCommand launches name with args as a detached child process and returns
// its handle. Stdin is detached and both stdout and stderr are redirected to the
// append-mode log file at logPath (its parent directory is created if needed).
//
// The child is placed in a brand-new session via Setsid, so it has no
// controlling terminal and is the leader of its own process group. When the
// launching process exits, the child reparents to init and survives — this is
// the manual/dev/SSH persistence path.
func SpawnCommand(name string, args []string, logPath string) (*os.Process, error) {
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return nil, fmt.Errorf("creating log directory: %w", err)
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("opening log file: %w", err)
	}
	defer logFile.Close()

	cmd := exec.Command(name, args...)
	cmd.Stdin = nil
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting %s: %w", name, err)
	}
	return cmd.Process, nil
}

// Spawn launches the current executable as a detached sessiond daemon, logging
// to logPath. It is a thin convenience wrapper over SpawnCommand.
func Spawn(logPath string) (*os.Process, error) {
	exe, _ := os.Executable()
	return SpawnCommand(exe, []string{"sessiond"}, logPath)
}

// spawnLockPath returns the path to the file whose flock serializes daemon
// spawns. It lives beside the socket, inside socketDir's uid-scoped 0700
// directory, so it is per-user exactly like the socket it guards.
func spawnLockPath() string {
	return filepath.Join(socketDir(), "sessiond.spawn.lock")
}

// acquireSpawnLock takes an exclusive advisory lock on spawnLockPath, polling
// until it succeeds or timeout elapses, and returns a release func that is
// safe to call once (and harmless if called again).
//
// Why a lock at all: Server.ListenAndServe closes its listener the instant its
// context is cancelled, and Go unlinks the Unix socket on Close(). So IsAlive
// reads "dead" for the entire window in which the outgoing daemon is still
// alive writing its shutdown snapshot. Any EnsureDaemon landing in that window
// would spawn a SECOND daemon on top of the one still shutting down; the lock
// is what closes that window, because the restart path (RestartDaemon) holds
// it across the whole stop-then-start sequence.
//
// flock locks the open file description rather than the process, so two
// separate OpenFile calls block each other even inside one process -- which is
// precisely what is needed here, since the racing callers (a browser reconnect
// via EnsureDaemon and a self-update via RestartDaemon) both live in the web
// process.
func acquireSpawnLock(timeout time.Duration) (func(), error) {
	if err := os.MkdirAll(socketDir(), 0o700); err != nil {
		return nil, fmt.Errorf("create socket dir: %w", err)
	}
	path := spawnLockPath()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open spawn lock %s: %w", path, err)
	}
	deadline := time.Now().Add(timeout)
	for {
		flockErr := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if flockErr == nil {
			var once sync.Once
			return func() {
				once.Do(func() {
					_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
					_ = f.Close()
				})
			}, nil
		}
		if !time.Now().Before(deadline) {
			_ = f.Close()
			return nil, fmt.Errorf("acquire spawn lock %s within %s: %w", path, timeout, flockErr)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// EnsureDaemon makes sure a sessiond daemon is reachable at socketPath,
// spawning one (logging to logPath) if necessary. It is the single entry point
// the web server calls on startup.
//
// The (socketPath, logPath string) error signature is frozen: Phase 3 imports
// this exact shape.
//
// Order of operations:
//  1. systemd gate. When running under systemd, INVOCATION_ID is set for every
//     unit it starts. There the daemon runs as its own unit
//     (muxterm-sessiond.service) in its own cgroup, so auto-spawning a second
//     copy inside the web unit's cgroup would double-spawn and race. Bail out
//     before touching the lock -- there is nothing to serialize.
//  2. If a daemon is already live, there is nothing to do. This fast path sits
//     ahead of the lock so the overwhelmingly common case costs one dial.
//  3. Otherwise serialize on the spawn lock, re-check liveness under it (a
//     fresh daemon may have come up while we waited), then clear any stale
//     socket file left by a crashed daemon so the new one can bind, spawn a
//     fresh detached daemon, and poll until it comes up.
func EnsureDaemon(socketPath, logPath string) error {
	if os.Getenv("INVOCATION_ID") != "" {
		return nil
	}
	if IsAlive(socketPath) {
		return nil
	}
	release, err := acquireSpawnLock(5 * time.Second)
	if err != nil {
		// Deliberately does NOT fall through and spawn anyway. The lock is
		// held across a self-update's daemon restart, and a second daemon
		// spawned into that window is the exact failure it exists to prevent.
		// Failing here is correct: the browser reconnects with backoff and
		// finds the replacement daemon.
		return fmt.Errorf("ensure sessiond: %w", err)
	}
	defer release()
	if IsAlive(socketPath) {
		return nil
	}
	return ensureDaemonLocked(socketPath, logPath)
}

// ensureDaemonLocked clears any stale socket file, spawns a fresh detached
// daemon, and polls until it answers.
//
// The caller MUST already hold the spawn lock. RestartDaemon calls this
// directly rather than EnsureDaemon: it holds the lock for the whole restart
// window, and re-entering acquireSpawnLock would deadlock against itself.
func ensureDaemonLocked(socketPath, logPath string) error {
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale socket: %w", err)
	}
	if _, err := Spawn(logPath); err != nil {
		return fmt.Errorf("spawn sessiond: %w", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if IsAlive(socketPath) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("sessiond did not become reachable at %s within timeout", socketPath)
}

// IsAlive reports whether a daemon is currently accepting connections on the
// Unix socket at socketPath. It attempts a short-timeout dial: a successful
// connection means the daemon is live, while any error (missing file, a stale
// socket file left by a crashed daemon, or a non-socket file) reads as dead.
func IsAlive(socketPath string) bool {
	conn, err := net.DialTimeout("unix", socketPath, 250*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// serverURLPath returns the path to the file that records the serve layer's
// HTTP base URL. It lives alongside the daemon socket in socketDir.
func serverURLPath() string {
	return filepath.Join(socketDir(), "server.url")
}

// WriteServerURL writes the HTTP base URL of the running serve layer to a
// well-known file so that the MCP server process can discover it. addr is the
// net.Listener address (e.g. ":8311" or "localhost:8311"); WriteServerURL
// normalises it to "http://localhost:<port>".
func WriteServerURL(addr string) error {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("parse addr %q: %w", addr, err)
	}
	if err := os.MkdirAll(socketDir(), 0o700); err != nil {
		return fmt.Errorf("create socket dir: %w", err)
	}
	return os.WriteFile(serverURLPath(), []byte("http://localhost:"+port), 0o600)
}

// ServerURL returns the HTTP base URL of the running muxterm serve layer. It
// reads the URL written by WriteServerURL at serve startup. Returns an error
// when the file does not exist (serve process not running) or cannot be read.
func ServerURL() (string, error) {
	data, err := os.ReadFile(serverURLPath())
	if err != nil {
		return "", fmt.Errorf("server URL file (%s): %w (is muxterm serve running?)", serverURLPath(), err)
	}
	return strings.TrimSpace(string(data)), nil
}
