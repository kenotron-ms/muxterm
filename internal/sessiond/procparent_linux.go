//go:build linux

package sessiond

import (
	"os"
	"strconv"
	"strings"
)

// parentPID returns pid's parent process id.
//
// This exists so the daemon can answer "which pane is this Amplifier session
// running in?". The session's hook knows only its own pid (teaching it about
// muxterm's pane model would put the same knowledge in two places), and the
// registry knows only each pane's root shell pid. Walking up from the former
// to the latter is the join, and the parent link is the only primitive it
// needs.
//
// Upward, not downward, deliberately: an ancestor walk is O(process depth) --
// typically two or three hops from `amplifier` to the pane's shell -- whereas
// finding descendants means scanning every entry in /proc on every tick.
//
// The parse follows processLive's rule exactly, and for the same reason: ppid
// is the fourth field of /proc/<pid>/stat, but the second field (comm) is
// parenthesized and may itself contain spaces and parens, since a process can
// rename itself to something like ") Z 1 ". The only safe split point is the
// LAST ')' in the line; everything after it is fixed-width fields.
func parentPID(pid int) (int, bool) {
	if pid <= 1 {
		return 0, false
	}
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, false
	}
	line := string(data)
	i := strings.LastIndex(line, ")")
	if i < 0 {
		return 0, false
	}
	// After the comm field: [0] state, [1] ppid, ...
	fields := strings.Fields(line[i+1:])
	if len(fields) < 2 {
		return 0, false
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil || ppid <= 0 {
		return 0, false
	}
	return ppid, true
}
