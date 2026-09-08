//go:build linux

package sessiond

import (
	"os"
	"strconv"
)

// startedBySystemd reports whether THIS process was launched directly by
// systemd as a unit, as opposed to merely being a descendant of one.
//
// Why the INVOCATION_ID environment variable is not sufficient on its own:
// systemd sets it for the processes of a unit it starts, and exec() then
// propagates it to EVERY descendant forever. On a machine where muxterm runs
// as a user unit, that means the serve process has it, sessiond inherits it,
// every pane's shell inherits it from sessiond, and every command a user or an
// agent runs inside a pane inherits it from the shell. Measured on the
// development machine: a shell inside a muxterm pane reports a populated
// INVOCATION_ID with a parent chain of amplifier -> bash, nowhere near systemd.
//
// The consequence of testing the variable alone was a guard that fired for
// everything and protected nothing:
//
//   - False positive, the damaging one. A dev `muxterm serve` started from a
//     pane -- with its own isolated runtime directory, needing its own daemon
//     -- concluded "systemd supervises my daemon" and spawned nothing, so it
//     came up with a serve and no sessiond and every browser attach failed.
//     `make dev-local` has to `unset INVOCATION_ID` to work around exactly
//     this.
//   - False confidence. Because the workaround is to unset the variable, the
//     guard is absent precisely in the dev scenarios where a second daemon is
//     most likely, and it never covered `muxterm sessiond` typed directly,
//     which does not call EnsureDaemon at all.
//
// Checking the parent process separates the two cases exactly: a process
// systemd started has systemd as its parent (pid 1 for the system manager, or
// the `systemd --user` manager process), while an inheriting descendant has
// something else -- a shell, an agent, a supervisor. Both checks together mean
// "I am a unit", which is what the caller actually wants to know.
func startedBySystemd() bool {
	if os.Getenv("INVOCATION_ID") == "" {
		return false
	}
	return parentIsSystemd()
}

// parentIsSystemd reports whether this process's immediate parent is a systemd
// manager. It reads the parent's comm rather than its cmdline because a user
// manager's cmdline is "/usr/lib/systemd/systemd --user" while its comm is the
// stable, short "systemd".
func parentIsSystemd() bool {
	ppid := os.Getppid()
	if ppid <= 0 {
		return false
	}
	// Reparenting to init is indistinguishable from being started by it, so
	// treat pid 1 as systemd only when it really is: read its comm too.
	comm, err := os.ReadFile("/proc/" + strconv.Itoa(ppid) + "/comm")
	if err != nil {
		// Cannot tell. Fall back to the old, permissive behaviour rather than
		// spawning a daemon we might not be entitled to spawn: ClaimSocket is
		// what actually prevents damage now, so being conservative here costs
		// nothing.
		return true
	}
	return string(trimNewline(comm)) == "systemd"
}

// trimNewline drops a single trailing newline, which every /proc "comm" file
// carries.
func trimNewline(b []byte) []byte {
	if n := len(b); n > 0 && b[n-1] == '\n' {
		return b[:n-1]
	}
	return b
}
