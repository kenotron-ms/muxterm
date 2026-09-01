//go:build linux

package sessiond

import (
	"bytes"
	"fmt"
	"os"
)

// foregroundCwdArgv resolves the working directory and full argv of pid via
// /proc, for the session-restore snapshot's best-effort "what was this pane
// running, and where" capture (see snapshot.go). It is read-only and never
// touches the target process.
//
// ok=false means "unknown" (not an error) -- callers must treat this as "no
// information available" and fall back safely (empty cwd -> today's $HOME
// behavior in NewPane; empty argv -> no catalog match -> plain shell). ok is
// true as soon as at least one of cwd/argv was resolved; either individual
// field can still be empty/nil even when ok is true (e.g. the process exited
// between the two /proc reads), which callers already handle the same way.
func foregroundCwdArgv(pid int) (cwd string, argv []string, ok bool) {
	if pid <= 0 {
		return "", nil, false
	}

	haveCwd := false
	if link, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid)); err == nil {
		cwd = link
		haveCwd = true
	}

	haveArgv := false
	if raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid)); err == nil {
		if parsed := parseProcCmdline(raw); len(parsed) > 0 {
			argv = parsed
			haveArgv = true
		}
	}

	if !haveCwd && !haveArgv {
		return "", nil, false
	}
	return cwd, argv, true
}

// parseProcCmdline splits a /proc/<pid>/cmdline NUL-separated byte blob into
// its argv strings, dropping the single trailing empty element the final
// terminating NUL produces.
func parseProcCmdline(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	parts := bytes.Split(raw, []byte{0})
	if len(parts) > 0 && len(parts[len(parts)-1]) == 0 {
		parts = parts[:len(parts)-1]
	}
	if len(parts) == 0 {
		return nil
	}
	argv := make([]string, len(parts))
	for i, p := range parts {
		argv[i] = string(p)
	}
	return argv
}
