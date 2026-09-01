// internal/update/sessiond.go
//
// Why this probe exists: install.sh's upgrade path restarts the `muxterm` unit
// only, never `muxterm-sessiond`, so a user who has upgraded across releases
// can be running a brand-new web binary against a daemon started by a much
// older one -- on <= v0.11.1 that daemon has no snapshot writer at all.
// Restarting a daemon that cannot restore does not "reload" anything: it
// destroys every pane and comes back with nothing to bring them back from.
// So the daemon is only restarted after the RUNNING daemon has proved, by
// writing a recent snapshot, that it will actually restore afterward.
package update

import (
	"fmt"
	"os"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// RestoreCapability reports whether restarting sessiond is safe -- i.e.
// whether the RUNNING daemon will bring the user's panes back afterward.
type RestoreCapability struct {
	OK bool
	// Reason is populated for both outcomes: it is what the browser and the
	// log say about what happened (or did not happen) to the daemon.
	Reason string
}

// CheckRestoreCapability probes the running daemon. It resolves the config,
// socket, and snapshot paths itself so callers need no wiring.
//
// Every check is fail-closed, matching the rest of this package: anything it
// cannot positively verify reads as "do not restart the daemon". Leaving an
// old daemon running costs the user a stale daemon until their next reboot;
// getting this wrong costs them every open pane.
func CheckRestoreCapability() RestoreCapability {
	cfg, err := config.Load(config.DefaultPath())
	if err != nil {
		return RestoreCapability{Reason: fmt.Sprintf("could not read the muxterm config: %v", err)}
	}
	if !cfg.Restore.Enabled {
		return RestoreCapability{Reason: "session restore is disabled in config"}
	}

	sock, err := sessiond.SocketPath()
	if err != nil {
		return RestoreCapability{Reason: fmt.Sprintf("could not resolve the sessiond socket path: %v", err)}
	}
	if !sessiond.IsAlive(sock) {
		return RestoreCapability{Reason: "sessiond is not running"}
	}

	snapPath := sessiond.DefaultSnapshotPath()
	fi, err := os.Stat(snapPath)
	if err != nil {
		// Deliberately does not assert WHY the file is absent. The common
		// cause is a daemon old enough to have no snapshot writer at all,
		// but a stray deletion produces the same observation, and a
		// user-facing message must not state an inference as a fact.
		return RestoreCapability{Reason: fmt.Sprintf("no restore snapshot at %s: the running daemon has not written one (it may predate snapshot support)", snapPath)}
	}

	// WriteSnapshot is a temp-write plus rename, so mtime is a reliable
	// liveness signal: it moves only when a whole snapshot lands. Two
	// intervals of slack absorbs one missed tick and the clock skew between
	// this check and the writer's ticker. The <= 0 fallback mirrors
	// StartSnapshotWriter's own, so the window matches what the daemon is
	// actually doing rather than what the config literally says.
	interval := cfg.Restore.SnapshotInterval
	if interval <= 0 {
		interval = 30 * time.Second
	}
	window := 2 * interval
	age := time.Since(fi.ModTime())
	if age > window {
		return RestoreCapability{Reason: fmt.Sprintf("restore snapshot is stale (age %s, expected under %s): the running daemon is not writing snapshots", age.Round(time.Second), window)}
	}

	return RestoreCapability{
		OK:     true,
		Reason: fmt.Sprintf("sessiond is writing restore snapshots (last write %s ago)", age.Round(time.Second)),
	}
}
