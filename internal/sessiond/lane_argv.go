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
// The Harness* names are declared in sessionstate.go, where the harness
// vocabulary already lives. That list is still longer than this one: the agent
// catalog also RECOGNISES opencode, but it is not launchable, because
// recognising a process that is already running is not the same as knowing the
// argv that starts one mid-conversation.
var LaunchableHarnesses = []string{HarnessAmplifier, HarnessClaude, HarnessCodex}

// LaneArgv returns the argv that starts harness with its opening turn already
// in hand. The launching daemon applies ApplyLaneApproval before exec so
// browser and remote callers inherit the destination policy too. See
// mcp.HarnessArgv for the full reasoning; the load-bearing facts are repeated
// in short form at each branch below.
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

	case HarnessCodex:
		// Codex has no goal mode either. It does carry a `thread_goals` table
		// internally on 0.149.0, but nothing on the CLI starts a session
		// against one, so muxterm cannot launch a loop that declares its own
		// stop condition. Refused rather than dropped, for HarnessClaude's
		// reason: a lane that looks delegated but declares no intent is worse
		// than a lane that did not start.
		if goal != "" {
			return nil, fmt.Errorf("harness %q has no goal mode: only %q can run /goal loops (drop goal, or switch harness)",
				HarnessCodex, HarnessAmplifier)
		}
		if prompt == "" {
			return nil, fmt.Errorf("prompt is required for harness %q", HarnessCodex)
		}
		// `codex [OPTIONS] [PROMPT]` with no subcommand is the INTERACTIVE
		// form, and the positional prompt is delivered as the session's first
		// user message. `codex exec` is the other one and is exactly wrong
		// here: it is single-shot and headless, so the pane would die after
		// one turn -- the same failure `--mode chat` exists to prevent on the
		// amplifier branch.
		//
		// THE `--` IS LOAD-BEARING, and this is the one place in muxterm that
		// has it. Codex parses its command line with clap, so a prompt
		// beginning with "-" is read as an unknown FLAG: verified on 0.149.0,
		// where `codex exec "-hello world"` prints usage and exits while
		// `codex exec -- "-hello world"` runs the prompt. Without the
		// separator a lane whose opening turn happened to start with a dash
		// would die instantly with a usage message in the pane.
		//
		// The notify override goes BEFORE the separator because it is an
		// option; see CodexNotifyOverride (codex_notify.go) for what it buys
		// and what it costs. It is spliced rather than appended so that an
		// operator opt-out simply produces a shorter argv.
		argv := []string{"codex"}
		argv = append(argv, CodexNotifyOverride()...)
		return append(argv, "--", prompt), nil

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
