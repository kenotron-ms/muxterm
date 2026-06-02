//go:build unix

package sessiond

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
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
