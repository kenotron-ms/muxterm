package sessiond

import (
	"strings"
	"testing"
)

// The shape of the argv is asserted rather than merely exercised, because the
// shape IS the safety property: `bash -c <fixed script> <argv0> <goal>` is what
// keeps caller-written goal text out of shell source.
func TestGoalLaneArgvShape(t *testing.T) {
	goal := "the tests pass"
	argv, err := GoalLaneArgv(goal)
	if err != nil {
		t.Fatalf("GoalLaneArgv: %v", err)
	}
	if len(argv) != goalLaneArgvLen {
		t.Fatalf("argv has %d elements, want %d: %q", len(argv), goalLaneArgvLen, argv)
	}
	if argv[0] != "bash" || argv[1] != "-c" {
		t.Errorf("argv does not start with `bash -c`: %q", argv[:2])
	}
	if argv[2] != goalLaneScript {
		t.Errorf("argv[2] is not the fixed script")
	}
	if argv[3] != GoalLaneArgv0 {
		t.Errorf("argv[3] = %q, want the recognisable $0 %q", argv[3], GoalLaneArgv0)
	}
	if argv[goalLaneGoalIndex] != goal {
		t.Errorf("goal at index %d = %q, want %q", goalLaneGoalIndex, argv[goalLaneGoalIndex], goal)
	}
}

// A goal is routinely written by a model and routinely contains shell
// metacharacters. It must appear in the argv EXACTLY once, verbatim, as its own
// element -- never spliced into the script.
func TestGoalLaneArgvDoesNotInterpolateGoalIntoScript(t *testing.T) {
	hostile := "x\"; touch /tmp/pwned; echo `id` $(id) '\n'"
	argv, err := GoalLaneArgv(hostile)
	if err != nil {
		t.Fatalf("GoalLaneArgv: %v", err)
	}
	if argv[goalLaneGoalIndex] != hostile {
		t.Errorf("goal was altered on the way into argv:\n got %q\nwant %q", argv[goalLaneGoalIndex], hostile)
	}
	if strings.Contains(argv[2], "touch /tmp/pwned") {
		t.Error("goal text reached the script body: it must be an argument, never source")
	}
	// The script must read the goal from $1 and from nowhere else.
	if !strings.Contains(argv[2], "goal=${1:-}") {
		t.Error("script does not take the goal from $1")
	}
}

// The blank check exists because "/goal " with nothing after it silently fails
// amplifier's startswith test and degrades to a literal-prompt lane.
func TestGoalLaneArgvRejectsBlank(t *testing.T) {
	for _, blank := range []string{"", "   ", "\t\n "} {
		if _, err := GoalLaneArgv(blank); err == nil {
			t.Errorf("GoalLaneArgv(%q) returned no error", blank)
		}
	}
}

// The recogniser and the builder must not drift: everything downstream that
// knows a goal lane when it sees one goes through goalLaneGoal.
func TestGoalLaneGoalRoundTrips(t *testing.T) {
	goal := "every item carries a terminal verdict"
	argv, err := GoalLaneArgv(goal)
	if err != nil {
		t.Fatalf("GoalLaneArgv: %v", err)
	}
	got, ok := goalLaneGoal(argv)
	if !ok {
		t.Fatal("goalLaneGoal did not recognise argv built by GoalLaneArgv")
	}
	if got != goal {
		t.Errorf("goalLaneGoal = %q, want %q", got, goal)
	}
}

func TestGoalLaneGoalRejectsOtherArgv(t *testing.T) {
	cases := map[string][]string{
		"empty":            nil,
		"interactive lane": {"amplifier", "run", "do the thing", "--mode", "chat"},
		"claude lane":      {"claude", "do the thing"},
		"plain bash -c":    {"bash", "-c", "echo hi"},
		"wrong argv0":      {"bash", "-c", goalLaneScript, "something-else", "goal"},
		"short":            {"bash", "-c", goalLaneScript, GoalLaneArgv0},
	}
	for name, argv := range cases {
		if _, ok := goalLaneGoal(argv); ok {
			t.Errorf("%s: goalLaneGoal accepted %q", name, argv)
		}
	}
}

// A goal lane's pane must still get a label. Before the wrapper existed the
// label came from `amplifier run <prompt>`; argv[0] is `bash` now, and a pane
// that loses its label reads "Pane 7" forever.
func TestPromptFromArgvLabelsGoalLane(t *testing.T) {
	goal := "ship the release notes"
	argv, err := GoalLaneArgv(goal)
	if err != nil {
		t.Fatalf("GoalLaneArgv: %v", err)
	}
	if got := promptFromArgv(argv); got != goal {
		t.Errorf("promptFromArgv = %q, want %q", got, goal)
	}
	if label := labelFromPrompt(promptFromArgv(argv)); label == "" {
		t.Error("a goal lane produced no label at all")
	}
}

// Phase 1 must stay headless. `--mode chat` anywhere in this command means no
// goal loop at all, which is the bug the whole two-phase design exists around.
func TestGoalLaneScriptKeepsPhaseOneHeadless(t *testing.T) {
	if strings.Contains(goalLaneScript, "--mode") {
		t.Error("goalLaneScript contains --mode: phase 1 must be headless or /goal never arms")
	}
	if !strings.Contains(goalLaneScript, `amplifier run "/goal $goal"`) {
		t.Error("goalLaneScript no longer runs the headless /goal phase")
	}
	if !strings.Contains(goalLaneScript, `exec amplifier resume "$session"`) {
		t.Error("goalLaneScript no longer resumes the finished session")
	}
}

// Each of the three endings named in the design must be reachable from the
// script, including the one that matters most: a failed run is still resumed.
func TestGoalLaneScriptHandlesEveryEnding(t *testing.T) {
	// The resume is unconditional on rc -- there is no `if [ $rc` guard
	// between the run and the resume.
	if strings.Contains(goalLaneScript, "if [ $rc") || strings.Contains(goalLaneScript, `if [ "$rc"`) {
		t.Error("the resume is gated on the exit code; a failed goal run is exactly when its context is worth most")
	}
	// The undeterminable-session fallback leaves a shell rather than losing
	// the pane.
	if !strings.Contains(goalLaneScript, `exec "${SHELL:-/bin/sh}"`) {
		t.Error("no plain-shell fallback for an undeterminable session id")
	}
	// The handover has to be legible: the user must be able to tell which
	// phase they are looking at.
	for _, want := range []string{"Goal run finished", "INTERACTIVE session", "verdict"} {
		if !strings.Contains(goalLaneScript, want) {
			t.Errorf("handover banner does not mention %q", want)
		}
	}
	// Only a snapshot from a run that actually armed a loop may be resumed.
	if !strings.Contains(goalLaneScript, `"mode":"autonomous"`) {
		t.Error("the session match does not require an autonomous run: an empty session would be resumed under a banner promising context")
	}
}
