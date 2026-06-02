//go:build unix

package sessiond

import (
	"fmt"
	"os"
	"path/filepath"
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
