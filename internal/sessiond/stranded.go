package sessiond

import "fmt"

// StrandedDaemon describes a daemon that is alive and listening on a Unix
// socket whose FILENAME no longer exists.
//
// This is the terminal state of the bind-over-a-live-daemon bug: the socket
// itself is fine -- the kernel still has it in LISTENING state, and clients
// that connected before the unlink keep working forever -- but the name is
// gone, so no NEW client can ever reach it. A Unix socket cannot be re-bound
// to a name once created, so the daemon cannot repair itself, and nothing in
// the filesystem hints that anything is wrong: `ls` simply reports that the
// socket does not exist.
type StrandedDaemon struct {
	// Path is the socket name the daemon bound and subsequently lost.
	Path string
	// Inode is the kernel socket inode still in LISTENING state.
	Inode uint64
	// PID is the process holding it, or 0 when it could not be identified
	// (which happens when the daemon runs as another user).
	PID int
}

// RecoveryHint returns the plain-words explanation and the exact command that
// recovers, including what that recovery costs.
//
// It deliberately does NOT recover automatically. The only way to free the
// name is to stop the daemon holding it, and that daemon owns every running
// pane on this machine -- every shell, every editor, every long-running job.
// Killing it silently to fix a connection error would destroy far more than it
// repairs, so this states the price and lets a human decide.
func (s *StrandedDaemon) RecoveryHint() string {
	pidText := "the sessiond process"
	killCmd := "  (could not identify the pid; find it with: sudo ss -lx | grep sessiond)"
	if s.PID > 0 {
		pidText = fmt.Sprintf("sessiond pid %d", s.PID)
		killCmd = fmt.Sprintf("  kill %d && muxterm serve", s.PID)
	}
	return fmt.Sprintf(`a muxterm sessiond is running but UNREACHABLE.

  %s is alive and still listening (socket inode %d), but the socket
  filename it was bound to no longer exists:

    %s

  This happens when a second sessiond binds over a live one's socket and then
  exits, unlinking the name on the way out. A Unix socket cannot be re-bound to
  a name, so the running daemon cannot repair itself and every new connection
  will keep failing with "no such file or directory".

  To recover:
%s

  WHAT THIS COSTS: it stops the daemon that owns every running pane. Shells,
  editors and jobs inside those panes are killed. Panes are restored from the
  crash snapshot, their PROCESSES are not. Any client still connected from
  before the unlink is working normally and will also be disconnected.`,
		pidText, s.Inode, s.Path, killCmd)
}
