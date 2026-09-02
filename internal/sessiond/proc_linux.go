//go:build linux

package sessiond

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// processLive reports whether pid names a process that is still running --
// specifically NOT a zombie. The distinction matters because sessiond is
// spawned with cmd.Start() and never Wait()ed, so it lingers as an unreaped
// child of whoever spawned it; kill(pid, 0) succeeds against a zombie
// indefinitely, which would hang any poll built on it (see waitForExit).
//
// The state character is the third field of /proc/<pid>/stat, but the second
// field (comm) is parenthesized and may itself contain spaces and parens
// (a process can rename itself to ") Z 1 "), so the only safe split point is
// the LAST ')' in the line -- everything after it is fixed-width fields.
//
// Any parse failure falls back to kill(pid, 0). That answer cannot see
// zombies, but it is strictly better than declaring a live daemon dead and
// spawning a second one on top of it.
func processLive(pid int) bool {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		if os.IsNotExist(err) {
			return false
		}
		return syscall.Kill(pid, 0) == nil
	}
	line := string(data)
	i := strings.LastIndex(line, ")")
	if i < 0 {
		return syscall.Kill(pid, 0) == nil
	}
	fields := strings.Fields(line[i+1:])
	if len(fields) == 0 {
		return syscall.Kill(pid, 0) == nil
	}
	// Z: zombie, awaiting reap. X/x: dead. Everything else (R, S, D, T, t, I)
	// is a process that still exists.
	switch fields[0] {
	case "Z", "X":
		return false
	}
	return true
}
