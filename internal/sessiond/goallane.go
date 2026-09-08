package sessiond

// A goal lane's two phases, chained inside one pane.
//
// THE PROBLEM THIS SOLVES. A goal lane used to be launched as the single
// command `amplifier run "/goal <condition>"`. That is headless on purpose --
// `/goal` is only honoured on amplifier's headless path, so `--mode chat` would
// mean no loop at all (see mcp.HarnessArgv, which spells that out at length and
// is still true). But headless means the process EXITS when the loop ends, and
// a pane whose process exits is removed (Server.handlePaneExit), which reaps
// the workspace with it when it was the last pane. The user watched a lane that
// had done 80% of the work disappear, taking its context with it, leaving them
// to write a fresh goal that re-derives everything.
//
// THE FIX, AND WHY IT IS SHAPED LIKE THIS. The two phases are chained in the
// pane's own command rather than in muxterm's pane lifecycle:
//
//	phase 1  amplifier run "/goal <condition>"   headless, loops, exits
//	phase 2  amplifier resume <session-id>       interactive, same session
//
// Phase 2 is not a second lane and not a fresh session: `amplifier resume` (see
// amplifier_app_cli/commands/session.py, `sessions_resume`) loads the stored
// transcript and hands it to interactive_chat, so the pane comes back holding
// the ACTUAL conversation the goal run had -- verified: a resumed goal session
// answers questions about what it did from context, with the files it wrote
// deleted. It takes no `--mode chat`: resume is interactive by construction,
// and the flag does not exist on that verb.
//
// Chained HERE rather than in the daemon because the daemon alternative is to
// let the pane's process exit and then restart it in place, which means new
// restart machinery in Pane, driven from the read-loop's exit callback, in the
// one file where a mistake takes out every pane on the machine. This does the
// same job with no daemon change at all: the process never exits, so nothing in
// the pane lifecycle is asked to behave differently.
//
// WHAT THIS COSTS, stated plainly because it is a real cost: a goal lane now
// holds a live process indefinitely instead of exiting. Its workspace will not
// self-reap, and workspaces accumulate until a human closes them. That is the
// deliberate trade -- the accumulating workspace is the finished lane's context,
// which is the thing that was being thrown away. Quitting the resumed session
// (Ctrl-D) ends the pane exactly like any other, which is both the way out and
// what writes the completion record.

import (
	"fmt"
	"strings"
)

// GoalLaneArgv0 is the $0 the goal-lane wrapper runs under.
//
// It exists to be RECOGNISED, not to be executed: `bash -c <script> <argv0>
// <goal>` sets $0 from this, so it is what `ps` shows, and it is how
// promptFromArgv (autolabel.go) tells a goal lane's argv from any other
// `bash -c` and finds the goal text to label the pane with. A pane launched
// this way would otherwise be titled after nothing at all.
const GoalLaneArgv0 = "muxterm-goal-lane"

// goalLaneArgvLen is the exact length of the argv GoalLaneArgv builds, and
// goalLaneGoalIndex is where the goal condition sits in it. Named so the
// recogniser in autolabel.go cannot drift from the builder below.
const (
	goalLaneArgvLen   = 5
	goalLaneGoalIndex = 4
)

// GoalLaneArgv returns the argv that runs a /goal loop and then leaves the
// finished session open, interactively, in the same pane.
//
// THE GOAL TEXT IS AN ARGUMENT, NEVER SOURCE. It is passed as $1 to a FIXED
// script, which is why this is safe: a lane's stop condition is routinely
// written by a model (spawn_lane is an MCP tool the chief of staff calls) and
// routinely contains quotes, backticks, newlines and $. Interpolating that into
// shell source would hand whoever wrote the goal a shell in the user's pane.
// The `bash -c <script> <argv0> <arg>` form is the one shape that keeps a shell
// in the pipeline without ever letting caller text be parsed as shell.
//
// goal must already be validated non-blank by the caller (mcp.HarnessArgv does
// it, and says why: "/goal " with nothing after it fails amplifier's startswith
// test and degrades silently to a literal-prompt lane).
func GoalLaneArgv(goal string) ([]string, error) {
	if strings.TrimSpace(goal) == "" {
		return nil, fmt.Errorf("goal is blank: a /goal loop needs a stop condition to declare")
	}
	return []string{"bash", "-c", goalLaneScript, GoalLaneArgv0, goal}, nil
}

// goalLaneGoal returns the goal condition out of an argv built by
// GoalLaneArgv, and whether argv is one.
//
// The match is on $0 rather than on the script body: the script is long,
// changes for unrelated reasons, and comparing it byte-for-byte would silently
// stop recognising goal lanes the first time a comment in it was edited.
func goalLaneGoal(argv []string) (string, bool) {
	if len(argv) != goalLaneArgvLen {
		return "", false
	}
	if argv[0] != "bash" || argv[1] != "-c" || argv[3] != GoalLaneArgv0 {
		return "", false
	}
	return argv[goalLaneGoalIndex], true
}

// goalLaneScript is phase 1, the handover, and phase 2.
//
// Deliberately POSIX shell and deliberately dependency-free: it runs in the
// user's pane, on whatever machine muxterm was installed on, and a goal lane
// that dies because `jq` is missing is worse than no chaining at all. It reads
// two things off disk and greps both.
//
// FINDING THE SESSION ID is the whole difficulty, and it is solved with
// muxterm's own session-state spool rather than by guessing at amplifier's
// storage layout. The hook (modules/hooks-muxterm-session) writes
// <spool>/<session-id>.json for every amplifier session and records in it the
// POSIX session id of the process. A pane's root shell -- this script -- leads
// its own POSIX session (the pty is started with setsid), so every amplifier
// process in this pane carries "sid":<this shell's pid>. That single integer is
// the whole join, it needs no polling and no race, and it is the SAME join the
// daemon uses to attach a session's row to a pane (sessionStore.placeSnapshot).
// The file also carries the goal's own terminal verdict, so the same read that
// identifies the session says how it went.
//
// The three endings, all of which are deliberate:
//
//   - loop finished, session id found      -> resume interactively (the point)
//   - loop crashed or exited non-zero      -> resume ANYWAY, and say so. A run
//     that failed is exactly when the context is worth the most; dropping it
//     would throw away the diagnosis along with the failure.
//   - session id not determinable          -> leave a plain shell and say why.
//     That is the old behaviour minus the disappearing pane. It happens when
//     the hook is not installed, which is also when there was never a fleet row
//     to lose, so nothing here fails louder than the situation warrants.
//
// `exec` on the resume is intentional: the pane's process becomes the
// interactive session, so quitting that session ends the pane the way quitting
// any other pane's program does -- which is both the user's way out and what
// triggers the completion record.
const goalLaneScript = `
set -u
goal=${1:-}
if [ -z "$goal" ]; then
  echo "muxterm: goal lane started with no stop condition" >&2
  exec "${SHELL:-/bin/sh}"
fi

amplifier run "/goal $goal"
rc=$?

# The spool path is computed exactly as the hook computes it
# (state.py spool_dir), which is exactly as the daemon computes it
# (internal/sessiond/spawn.go socketDir).
spool=${MUXTERM_SESSION_STATE_DIR:-${XDG_RUNTIME_DIR:-/tmp}/muxterm/session-state}

session=""
verdict=""
best=""
for f in "$spool"/*.json; do
  [ -f "$f" ] || continue
  # "sid":<pid> followed by , or } -- the guard stops "sid":12 matching
  # "sid":123, and keeps working whether or not optional fields follow.
  grep -qE "\"sid\":$$[,}]" "$f" 2>/dev/null || continue
  # AND it has to be a goal run. Measured, not theoretical: a /goal that
  # amplifier rejects before arming the loop (a bad --max-turns value) still
  # creates a session, still leaves a snapshot, and still exits -- and
  # resuming THAT lands the user at a prompt over an empty conversation,
  # under a banner promising the run's full context. "Resuming session: ...
  # Messages: 0" is worse than not resuming at all, because it looks like a
  # working session. A session that never armed a loop is interactive here,
  # so requiring autonomous is exactly the "did a goal actually run" test.
  grep -q '"mode":"autonomous"' "$f" 2>/dev/null || continue
  if [ -z "$best" ] || [ "$f" -nt "$best" ]; then best=$f; fi
done
if [ -n "$best" ]; then
  session=$(basename "$best" .json)
  verdict=$(sed -n 's/.*"state":"\([a-z]*\)".*/\1/p' "$best" | head -1)
fi

printf '\n'
printf '\033[2m--------------------------------------------------------------\033[0m\n'
if [ -n "$verdict" ]; then
  printf '\033[1mGoal run finished\033[0m -- verdict: %s (exit %s)\n' "$verdict" "$rc"
else
  printf '\033[1mGoal run finished\033[0m -- exit %s\n' "$rc"
fi
if [ -z "$session" ]; then
  printf 'No finished goal run was found for this pane, so there is nothing\n'
  printf 'to resume. Whatever went wrong is in the scrollback above.\n'
  printf 'Leaving a shell so this pane and that scrollback stay put.\n'
  printf '\033[2m--------------------------------------------------------------\033[0m\n'
  exec "${SHELL:-/bin/sh}"
fi
printf 'You are now in an INTERACTIVE session holding that run'"'"'s full context.\n'
printf 'Type to continue the work; Ctrl-D ends the lane and closes this pane.\n'
printf '\033[2m--------------------------------------------------------------\033[0m\n'
printf '\n'

exec amplifier resume "$session"
`
