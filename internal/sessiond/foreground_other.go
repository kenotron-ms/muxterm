//go:build !linux && !darwin

package sessiond

// paneForegrounded returns the argv used to spawn the pane, an empty dir, and
// a nil env. Foreground process detection via TIOCGPGRP + /proc is
// Linux/Darwin-only; on other platforms we fall back to the spawn argv.
func paneForegrounded(p *Pane) (argv []string, dir string, env map[string]string) {
	return p.argv, "", nil
}
