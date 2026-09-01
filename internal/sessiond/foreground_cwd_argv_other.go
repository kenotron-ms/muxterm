//go:build !linux

package sessiond

// foregroundCwdArgv is unimplemented on this platform. Linux resolves cwd
// and argv via /proc (see foreground_cwd_argv_linux.go); there is no
// equivalent zero-cost, cgo-free mechanism available here with real
// confidence -- Darwin in particular builds with CGO_ENABLED=0 (see
// .goreleaser.yaml), and this repo just fixed one darwin cross-compile break
// from an unguarded unix.* call (commit aa28f63), so a speculative KERN_PROCARGS2
// sysctl implementation was deliberately not attempted here.
//
// ok=false unconditionally: callers already treat that as "unknown" and fall
// back safely (empty cwd -> today's forced-$HOME spawn behavior in NewPane;
// empty argv -> no catalog match -> plain shell). Session-restore itself
// still works on this platform -- a restored pane simply always reopens as a
// plain shell in $HOME rather than in its last cwd, and never relaunches a
// recognized agent's argv.
func foregroundCwdArgv(pid int) (cwd string, argv []string, ok bool) {
	return "", nil, false
}
