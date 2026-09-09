package sessiond

// Lane argv, in the daemon.
//
// WHY THIS MOVED HERE. mcp.HarnessArgv was the one place lane argv was built,
// and it still is -- it now calls this. What changed is that a lane can be
// started by something with no MCP connection at all: a TRIGGER fires inside
// the daemon, at a moment when nobody is attached (trigger_fire.go). Package
// mcp imports sessiond, so sessiond cannot call back into mcp; the choice was
// to move the builder down or to freeze an argv string into every trigger at
// creation time.
//
// Freezing was rejected, and the reason is the bug this file's own comments
// warn about at length. A goal lane's argv is a two-phase shell wrapper whose
// shape has already changed once, to fix a real user-visible failure. A trigger
// created before that fix and carrying its own frozen copy of the old argv
// would keep reproducing the fixed bug forever, silently, months after the fix
// shipped -- and the user would have no way to see why their trigger behaves
// differently from a hand-started lane. Building at fire time means a trigger
// gets whatever the current daemon believes is correct.
//
// mcp.HarnessArgv remains the name the rest of that package calls, and its
// commentary -- which is the real documentation for why the two branches must
// not be merged -- stays there.

import (
	"fmt"
	"strings"
)

// LaunchableHarnesses lists the harnesses LaneArgv can start, in schema order.
//
// HarnessAmplifier and HarnessClaude are declared in sessionstate.go, where the
// harness vocabulary already lives. That list is longer than this one on
// purpose: the agent catalog also RECOGNISES codex and opencode, but neither is
// launchable, because recognising a process that is already running is not the
// same as knowing the argv that starts one mid-conversation.
var LaunchableHarnesses = []string{HarnessAmplifier, HarnessClaude}

// LaneArgv returns the argv that starts harness with its opening turn already
// in hand. See mcp.HarnessArgv for the full reasoning; the load-bearing facts
// are repeated in short form at each branch below.
func LaneArgv(harness, prompt, goal string) ([]string, error) {
	// A PROMPT IS NOT A COMMAND. Both harnesses read a leading "/" as a slash
	// command, so a prompt of "/clear" or "/goal ..." would not be delegated
	// work at all. It is a refusal, not an escape, because amplifier strips
	// before testing so a leading space does not neutralise it.
	if err := CheckPromptIsNotCommand(prompt); err != nil {
		return nil, err
	}
	switch harness {
	case HarnessClaude:
		// Claude Code has no goal mode. Silently dropping the condition would
		// hand back a lane that looks delegated but declares no intent.
		if goal != "" {
			return nil, fmt.Errorf("harness %q has no goal mode: only %q can run /goal loops (drop goal, or switch harness)",
				HarnessClaude, HarnessAmplifier)
		}
		if prompt == "" {
			return nil, fmt.Errorf("prompt is required for harness %q", HarnessClaude)
		}
		return []string{"claude", prompt}, nil

	case HarnessAmplifier:
		if goal != "" {
			// A goal of only whitespace yields "/goal " with nothing after it,
			// which fails amplifier's startswith test and degrades silently to
			// a literal-prompt lane that declares no intent.
			if strings.TrimSpace(goal) == "" {
				return nil, fmt.Errorf("goal is blank: a /goal loop needs a stop condition to declare (drop goal to start an interactive lane)")
			}
			// NO `--mode chat` HERE. /goal is only honoured on amplifier's
			// headless path; in --mode chat the condition arrives as ordinary
			// prompt text and the loop never arms. GoalLaneArgv wraps the
			// headless loop and the interactive resume that follows it.
			return GoalLaneArgv(goal)
		}
		if prompt == "" {
			return nil, fmt.Errorf("prompt is required for harness %q (or pass a goal)", HarnessAmplifier)
		}
		// `--mode chat` is load-bearing HERE: without it an interactive lane is
		// single-shot and the pane dies after its first turn. It is exactly
		// wrong in the goal branch above.
		return []string{"amplifier", "run", prompt, "--mode", "chat"}, nil

	case "":
		return nil, fmt.Errorf("harness is required (launchable: %s)", strings.Join(LaunchableHarnesses, ", "))

	default:
		return nil, fmt.Errorf("unknown harness %q (launchable: %s)", harness, strings.Join(LaunchableHarnesses, ", "))
	}
}

// CheckPromptIsNotCommand rejects a prompt a harness would read as a slash
// command rather than as work.
func CheckPromptIsNotCommand(prompt string) error {
	trimmed := strings.TrimSpace(prompt)
	if !strings.HasPrefix(trimmed, "/") {
		return nil
	}
	head := trimmed
	if len(head) > 40 {
		head = head[:40] + "..."
	}
	return fmt.Errorf("prompt starts with %q, which the harness reads as a slash command "+
		"rather than as work: rephrase it, or pass a goal to start a /goal loop", head)
}
