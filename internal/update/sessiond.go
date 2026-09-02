// internal/update/sessiond.go
//
// Restarting sessiond is what keeps the daemon from being left on the old
// binary after an update. It is also destructive: the daemon owns every pane's
// pty, so restarting one that will not restore afterward does not "reload"
// anything -- it kills every pane with nothing to bring them back from.
//
// Session restore is therefore the precondition, and configuration is the only
// thing consulted. A deeper probe (is the daemon actually writing snapshots
// right now?) was tried and removed: it is fail-closed, so any false negative
// -- clock skew, a divergent XDG_DATA_HOME, a slow disk -- silently leaves the
// daemon on the old binary, which is the exact version skew this restart
// exists to prevent.
package update

import (
	"fmt"

	"github.com/kenotron-ms/muxterm/internal/config"
)

// RestoreCapability reports whether restarting sessiond will bring the user's
// panes back afterward.
type RestoreCapability struct {
	OK bool
	// Reason is populated for both outcomes: it is what the browser and the
	// log say about what happened (or did not happen) to the daemon.
	Reason string
}

// CheckRestoreCapability reports whether session restore is configured, and so
// whether restarting the daemon will bring panes back. It resolves the config
// path itself so callers need no wiring.
//
// An unreadable config reads as "do not restart": the daemon's own restore path
// keys off the same setting, and guessing wrong costs the user every open pane.
func CheckRestoreCapability() RestoreCapability {
	cfg, err := config.Load(config.DefaultPath())
	if err != nil {
		return RestoreCapability{Reason: fmt.Sprintf("could not read the muxterm config: %v", err)}
	}
	if !cfg.Restore.Enabled {
		return RestoreCapability{Reason: "session restore is disabled in config"}
	}
	return RestoreCapability{OK: true, Reason: "session restore is enabled"}
}
