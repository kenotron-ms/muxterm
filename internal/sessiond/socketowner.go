package sessiond

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"syscall"
	"time"
)

// probeTimeout bounds the bind-time ownership probe. It is short because the
// only thing being measured is whether a listener on the LOCAL filesystem
// accepts a connection -- there is no network in the path, so anything slower
// than this is a full backlog, which counts as "someone is there" anyway.
const probeTimeout = 250 * time.Millisecond

// SocketState is what a bind-time probe of a Unix socket path found. It exists
// to make the difference between "nothing is there" and "something answered"
// a decision the caller must handle explicitly, rather than the implicit
// os.Remove that used to precede every net.Listen.
type SocketState int

const (
	// SocketFree means no file exists at the path. Bind directly; there is
	// nothing to unlink.
	SocketFree SocketState = iota

	// SocketStale means a socket file exists but no process is listening on
	// it -- the residue of a daemon that was killed without unlinking. Safe
	// to remove and rebind: this is the normal restart-after-crash path.
	SocketStale

	// SocketOwned means a live listener answered. Another daemon owns this
	// name. Binding over it would strand that daemon: it keeps its listening
	// socket, loses its filename, and every subsequent client dial fails with
	// ENOENT while the process itself stays alive and invisible.
	SocketOwned

	// SocketBlocked means the probe could not determine the answer -- a
	// permission error, or a non-socket file sitting at the path. Refusing is
	// the only safe response: the alternative is unlinking something we do
	// not understand.
	SocketBlocked
)

func (s SocketState) String() string {
	switch s {
	case SocketFree:
		return "free"
	case SocketStale:
		return "stale"
	case SocketOwned:
		return "owned"
	case SocketBlocked:
		return "blocked"
	}
	return "unknown"
}

// ProbeSocket asks whether anything is listening at path, WITHOUT modifying
// anything. The reason it dials rather than stat-ing is that the filesystem
// cannot answer the question: a socket file's existence says only that some
// process once bound it, not that any process still holds it. Only a connect
// distinguishes a live owner from a corpse.
//
// The returned error is non-nil only for SocketBlocked, and explains what the
// probe could not resolve.
func ProbeSocket(path string) (SocketState, error) {
	conn, err := net.DialTimeout("unix", path, probeTimeout)
	if err == nil {
		_ = conn.Close()
		return SocketOwned, nil
	}

	switch {
	// Nothing at the path at all. Nothing to clean up.
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, syscall.ENOENT):
		return SocketFree, nil

	// The kernel refused the connection. On an AF_UNIX path that means the
	// inode exists but has no listener -- EITHER a stale socket file OR a
	// path that is not a socket at all (connecting to a regular file also
	// yields ECONNREFUSED). Those two need opposite responses, so verify the
	// file type before deciding anything may be removed.
	case errors.Is(err, syscall.ECONNREFUSED):
		fi, statErr := os.Lstat(path)
		if statErr != nil {
			// It vanished between the dial and the stat. Free, then.
			if errors.Is(statErr, fs.ErrNotExist) {
				return SocketFree, nil
			}
			return SocketBlocked, fmt.Errorf("cannot inspect %s: %w", path, statErr)
		}
		if fi.Mode()&os.ModeSocket == 0 {
			return SocketBlocked, fmt.Errorf(
				"%s exists but is not a socket (mode %s); refusing to remove it", path, fi.Mode())
		}
		return SocketStale, nil

	// A listener exists but its backlog is full, or it is not accepting fast
	// enough. Something IS there; treat it as owned rather than racing it.
	case errors.Is(err, syscall.EAGAIN), errors.Is(err, syscall.ETIMEDOUT), errors.Is(err, os.ErrDeadlineExceeded):
		return SocketOwned, nil

	// Permission problems and everything unrecognised: we cannot tell, so we
	// do not touch it.
	default:
		return SocketBlocked, fmt.Errorf("cannot determine whether a daemon is listening on %s: %w", path, err)
	}
}

// ErrSocketOwned is returned by ClaimSocket when a live daemon already holds
// the socket name. Callers that want to distinguish "someone else is running"
// from a genuine failure test for this.
var ErrSocketOwned = errors.New("sessiond: socket already owned by a running daemon")

// ClaimSocket makes path safe to bind, or refuses.
//
// It replaces the unconditional `os.Remove(path)` that used to precede
// net.Listen. That remove was silent and destructive: a second daemon sharing
// a runtime directory would unlink a LIVE daemon's socket name and bind its
// own in place. The first daemon kept running with a listening socket that no
// longer had a filename, so every new dial failed instantly with ENOENT while
// the process stayed alive holding every pane. When the second daemon later
// exited, Go unlinked the name on listener close and the first daemon became
// permanently unreachable -- a browser reconnect loop with no error anywhere.
//
// The rule is: ask before you unlink. Only a name that provably has no
// listener behind it may be removed.
func ClaimSocket(path string) error {
	state, err := ProbeSocket(path)
	switch state {
	case SocketFree:
		return nil

	case SocketStale:
		if rmErr := os.Remove(path); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
			return fmt.Errorf("remove stale socket %s: %w", path, rmErr)
		}
		return nil

	case SocketOwned:
		// Loud and specific, because the failure it prevents is silent. A
		// daemon that declines to start with a clear message is a good
		// outcome; one that starts by breaking a running daemon is not.
		return fmt.Errorf(
			"%w: another muxterm sessiond is already listening on %s.\n"+
				"  Refusing to start: binding over a live daemon's socket would strand it --\n"+
				"  it would keep every running pane but lose its filename, and every client\n"+
				"  would fail to reach it.\n"+
				"  If you meant to run a second instance, give it its own runtime directory:\n"+
				"    XDG_RUNTIME_DIR=/tmp/muxterm-dev XDG_DATA_HOME=/tmp/muxterm-dev/data muxterm serve\n"+
				"  To replace the running daemon instead, stop it first.",
			ErrSocketOwned, path)

	default: // SocketBlocked
		return fmt.Errorf("refusing to bind %s: %w", path, err)
	}
}
