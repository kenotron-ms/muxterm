package sessiond

import "path/filepath"

// isClaudeArgv classifies only executable positions. A prompt argument named
// "claude" in an Amplifier invocation must not change its recovery behavior.
// This is a replay veto, not proof of a native conversation's identity.
func isClaudeArgv(argv []string) bool {
	if len(argv) == 0 {
		return false
	}
	isClaude := func(arg string) bool {
		switch filepath.Base(arg) {
		case "claude", "claude.js", "claude.mjs", "claude.cjs":
			return true
		}
		return false
	}
	if isClaude(argv[0]) {
		return true
	}
	switch filepath.Base(argv[0]) {
	case "node", "nodejs", "bun":
		return len(argv) > 1 && isClaude(argv[1])
	}
	return false
}

// isClaudePaneSnapshot is deliberately independent of any persisted
// Amplifier-oriented fields. A historical or malformed snapshot that says
// Agent=claude, or whose argv is recognizably Claude, is always prevented from
// entering generic argv replay or Amplifier-session resume paths.
func isClaudePaneSnapshot(paneSnap PaneSnapshot) bool {
	return paneSnap.Agent == HarnessClaude || isClaudeArgv(paneSnap.Argv)
}
