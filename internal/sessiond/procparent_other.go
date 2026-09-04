//go:build !linux

package sessiond

// parentPID is unimplemented on this platform, following the same reasoning
// (and the same graceful-degradation contract) as foregroundCwdArgv: Linux
// resolves process ancestry via /proc, and there is no zero-cost, cgo-free
// equivalent here worth guessing at. Darwin in particular builds with
// CGO_ENABLED=0.
//
// ok=false unconditionally. The only caller is the session-state pane join,
// which treats an unresolvable ancestor as "this snapshot belongs to no known
// pane" and drops the row. The consequence is that muxterm's home view is
// empty on this platform, not that anything breaks: the hook still writes its
// snapshots, every other pane feature is unaffected, and the day a
// KERN_PROCARGS2-equivalent lands here the feature starts working with no
// change above this line.
func parentPID(pid int) (int, bool) {
	return 0, false
}

// processStartTime is unimplemented off Linux, for the same reason parentPID
// is. ok=false means "cannot verify", which snapshotPIDMatches treats as
// permissive rather than as a mismatch -- consistent with the pane join already
// returning nothing on this platform.
func processStartTime(pid int) (uint64, bool) {
	return 0, false
}

// processSessionID is unimplemented off Linux, for the same reason parentPID
// is. ok=false means the snapshot carries no sid, and the reader falls back to
// the ancestor walk -- which is also unimplemented here, so the home view stays
// empty on this platform rather than behaving differently.
func processSessionID(pid int) (int, bool) {
	return 0, false
}
