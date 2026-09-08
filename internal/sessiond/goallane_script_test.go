package sessiond

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The script is executed for real here, against a stub `amplifier`, because the
// three endings it has to get right are all shell control flow and none of them
// is visible in a Go-level assertion about strings. The stub also makes the
// expensive half free: no model, no provider, no minutes.
//
// What the stub has to imitate is small and exact:
//   - `amplifier run "/goal ..."` writes the session-state snapshot the real
//     hook writes (modules/hooks-muxterm-session), keyed by the POSIX session
//     id of the pane's root shell, and exits with a chosen code.
//   - `amplifier resume <id>` prints which id it was handed.

type goalLaneRun struct {
	stdout string
	err    error
}

// runGoalLaneScript executes the real goalLaneScript with a stub amplifier on
// PATH. writeSnapshot decides what phase 1 leaves in the spool: it receives the
// spool dir and the pid the shell will report as its own POSIX session id.
func runGoalLaneScript(t *testing.T, goal string, exitCode int, writeSnapshot bool, snapshotState string) goalLaneRun {
	t.Helper()
	return runGoalLaneScriptMode(t, goal, exitCode, writeSnapshot, snapshotState, "autonomous")
}

func runGoalLaneScriptMode(t *testing.T, goal string, exitCode int, writeSnapshot bool, snapshotState, snapshotMode string) goalLaneRun {
	t.Helper()

	dir := t.TempDir()
	binDir := filepath.Join(dir, "bin")
	spool := filepath.Join(dir, "session-state")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}

	// The stub writes the snapshot under its PARENT's pid, which is the shell
	// running the script -- exactly the relationship the real hook records,
	// where the pane's root shell leads the POSIX session every amplifier
	// process in the pane belongs to.
	snapshot := ""
	if writeSnapshot {
		snapshot = fmt.Sprintf(`
sid=$PPID
cat > "%s/11111111-2222-3333-4444-555555555555.json" <<EOF
{"v":1,"pid":$$,"pidStart":1,"sessionId":"11111111-2222-3333-4444-555555555555","harness":"amplifier","mode":"%s","state":"%s","updatedAt":1,"sid":$sid,"doneMeans":"whatever"}
EOF
`, spool, snapshotMode, snapshotState)
	}

	stub := fmt.Sprintf(`#!/bin/sh
case "$1" in
  run)
    printf 'STUB-RAN-PHASE-1 %%s\n' "$2"
    %s
    exit %d
    ;;
  resume)
    printf 'STUB-RESUMED %%s\n' "$2"
    exit 0
    ;;
esac
exit 99
`, snapshot, exitCode)

	if err := os.WriteFile(filepath.Join(binDir, "amplifier"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	// The no-session-id fallback execs $SHELL. Point it at something that
	// terminates and identifies itself instead of an interactive shell that
	// would hang the test.
	fakeShell := "#!/bin/sh\nprintf 'STUB-SHELL\\n'\n"
	if err := os.WriteFile(filepath.Join(binDir, "fakeshell"), []byte(fakeShell), 0o755); err != nil {
		t.Fatal(err)
	}

	argv, err := GoalLaneArgv(goal)
	if err != nil {
		t.Fatalf("GoalLaneArgv: %v", err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(),
		"PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"),
		"MUXTERM_SESSION_STATE_DIR="+spool,
		"SHELL="+filepath.Join(binDir, "fakeshell"),
	)
	out, err := cmd.CombinedOutput()
	return goalLaneRun{stdout: string(out), err: err}
}

// The ordinary ending: the loop met its condition, and the pane keeps the
// session open interactively instead of dying with it.
func TestGoalLaneScriptResumesAfterASuccessfulRun(t *testing.T) {
	run := runGoalLaneScript(t, "the tests pass", 0, true, "done")
	if run.err != nil {
		t.Fatalf("script failed: %v\n%s", run.err, run.stdout)
	}
	if !strings.Contains(run.stdout, "STUB-RAN-PHASE-1 /goal the tests pass") {
		t.Errorf("phase 1 did not run as a headless /goal:\n%s", run.stdout)
	}
	if !strings.Contains(run.stdout, "STUB-RESUMED 11111111-2222-3333-4444-555555555555") {
		t.Errorf("phase 2 did not resume the session phase 1 created:\n%s", run.stdout)
	}
	if !strings.Contains(run.stdout, "verdict: done") {
		t.Errorf("handover did not report the verdict:\n%s", run.stdout)
	}
	if strings.Contains(run.stdout, "STUB-SHELL") {
		t.Errorf("fell back to a shell despite having a session to resume:\n%s", run.stdout)
	}
}

// The ending that matters most for the human: a run that failed is exactly when
// its context is worth the most, so it is resumed too -- and says so.
func TestGoalLaneScriptResumesAfterAFailedRun(t *testing.T) {
	run := runGoalLaneScript(t, "the tests pass", 3, true, "failed")
	if run.err != nil {
		t.Fatalf("script failed: %v\n%s", run.err, run.stdout)
	}
	if !strings.Contains(run.stdout, "STUB-RESUMED 11111111-2222-3333-4444-555555555555") {
		t.Errorf("a non-zero goal run was not resumed:\n%s", run.stdout)
	}
	if !strings.Contains(run.stdout, "verdict: failed") {
		t.Errorf("handover did not report the failed verdict:\n%s", run.stdout)
	}
	if !strings.Contains(run.stdout, "exit 3") {
		t.Errorf("handover did not report the exit code:\n%s", run.stdout)
	}
}

// A goal loop that stopped short of its condition (cap hit, cancelled) reports
// `stopped`, and must not be dressed up as anything better on the way through.
func TestGoalLaneScriptReportsAStoppedRunHonestly(t *testing.T) {
	run := runGoalLaneScript(t, "the tests pass", 0, true, "stopped")
	if run.err != nil {
		t.Fatalf("script failed: %v\n%s", run.err, run.stdout)
	}
	if !strings.Contains(run.stdout, "verdict: stopped") {
		t.Errorf("a capped-out run was not reported as stopped:\n%s", run.stdout)
	}
	if strings.Contains(run.stdout, "verdict: done") {
		t.Errorf("a capped-out run was reported as done:\n%s", run.stdout)
	}
}

// No snapshot means no session id -- which happens when the muxterm hook is not
// installed at all. Leave a shell rather than losing the pane, and say why.
func TestGoalLaneScriptFallsBackToAShellWithNoSessionID(t *testing.T) {
	run := runGoalLaneScript(t, "the tests pass", 0, false, "")
	if run.err != nil {
		t.Fatalf("script failed: %v\n%s", run.err, run.stdout)
	}
	if !strings.Contains(run.stdout, "STUB-SHELL") {
		t.Errorf("no shell fallback when the session id could not be determined:\n%s", run.stdout)
	}
	if strings.Contains(run.stdout, "STUB-RESUMED") {
		t.Errorf("resumed something despite having no session id:\n%s", run.stdout)
	}
	if !strings.Contains(run.stdout, "No finished goal run was found") {
		t.Errorf("fallback did not say why it fell back:\n%s", run.stdout)
	}
}

// REGRESSION, observed live. `/goal --max-turns abc <cond>` is rejected by
// amplifier BEFORE the loop arms -- but the session is already created, the
// hook has already written a snapshot for it, and the process then exits 1.
// Matching that snapshot resumed a session with nothing in it: "Resuming
// session: ... Messages: 0", a prompt over an empty conversation, under a
// banner promising the run's full context. That is worse than not resuming,
// because it looks like a working session. A run that never armed a loop is
// `interactive`, so requiring `autonomous` is the test for "a goal actually
// ran here".
func TestGoalLaneScriptDoesNotResumeARunThatNeverArmedALoop(t *testing.T) {
	run := runGoalLaneScriptMode(t, "the tests pass", 1, true, "done", "interactive")
	if run.err != nil {
		t.Fatalf("script failed: %v\n%s", run.err, run.stdout)
	}
	if strings.Contains(run.stdout, "STUB-RESUMED") {
		t.Errorf("resumed a session that never ran a goal loop:\n%s", run.stdout)
	}
	if !strings.Contains(run.stdout, "STUB-SHELL") {
		t.Errorf("expected the shell fallback so the pane and its error stay readable:\n%s", run.stdout)
	}
	if !strings.Contains(run.stdout, "No finished goal run was found") {
		t.Errorf("fallback did not say what was missing:\n%s", run.stdout)
	}
}

// REGRESSION, observed live under SIGKILL against a running goal loop. A killed
// run leaves a NON-terminal snapshot ("working"), because the hook only writes a
// verdict from on_session_end -- and amplifier only saves the transcript on that
// same clean exit. Resuming it printed `verdict: working (exit 137)` followed by
// `Messages: 0`: a prompt over an empty conversation, under a banner promising
// the run's full context. The mode check does not catch this one, because a
// crashed goal run IS autonomous. The verdict check does.
func TestGoalLaneScriptDoesNotResumeAKilledRun(t *testing.T) {
	run := runGoalLaneScript(t, "the tests pass", 137, true, "working")
	if run.err != nil {
		t.Fatalf("script failed: %v\n%s", run.err, run.stdout)
	}
	if strings.Contains(run.stdout, "STUB-RESUMED") {
		t.Errorf("resumed a killed run, whose transcript was never saved:\n%s", run.stdout)
	}
	if strings.Contains(run.stdout, "verdict: working") {
		t.Errorf("reported a non-terminal state as if it were a verdict:\n%s", run.stdout)
	}
	if !strings.Contains(run.stdout, "interrupted") {
		t.Errorf("did not say the run was interrupted:\n%s", run.stdout)
	}
	if !strings.Contains(run.stdout, "exit 137") {
		t.Errorf("did not report the exit code:\n%s", run.stdout)
	}
	if !strings.Contains(run.stdout, "STUB-SHELL") {
		t.Errorf("expected the shell fallback so the pane and its output stay readable:\n%s", run.stdout)
	}
}

// The other half of that rule, and the one the design cares about most: a run
// that ENDED badly still has a verdict, so it is still resumed with its context.
func TestGoalLaneScriptStillResumesAnEndedRunThatFailed(t *testing.T) {
	run := runGoalLaneScript(t, "the tests pass", 3, true, "failed")
	if run.err != nil {
		t.Fatalf("script failed: %v\n%s", run.err, run.stdout)
	}
	if !strings.Contains(run.stdout, "STUB-RESUMED") {
		t.Errorf("a run that ended `failed` was not resumed -- that is the case the context is worth most in:\n%s", run.stdout)
	}
}

// A snapshot belonging to a DIFFERENT pane must not be adopted: the sid join is
// the whole reason this is safe to do by scanning a shared directory.
func TestGoalLaneScriptIgnoresAnotherPanesSnapshot(t *testing.T) {
	dir := t.TempDir()
	binDir := filepath.Join(dir, "bin")
	spool := filepath.Join(dir, "session-state")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	// sid 999999 is nobody's shell here.
	other := `{"v":1,"pid":424242,"pidStart":1,"sessionId":"99999999-9999-9999-9999-999999999999",` +
		`"harness":"amplifier","mode":"autonomous","state":"done","updatedAt":1,"sid":999999}`
	if err := os.WriteFile(filepath.Join(spool, "99999999-9999-9999-9999-999999999999.json"), []byte(other), 0o600); err != nil {
		t.Fatal(err)
	}

	stub := "#!/bin/sh\ncase \"$1\" in\n  run) exit 0 ;;\n  resume) printf 'STUB-RESUMED %s\\n' \"$2\"; exit 0 ;;\nesac\nexit 99\n"
	if err := os.WriteFile(filepath.Join(binDir, "amplifier"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "fakeshell"), []byte("#!/bin/sh\nprintf 'STUB-SHELL\\n'\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	argv, err := GoalLaneArgv("the tests pass")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(),
		"PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"),
		"MUXTERM_SESSION_STATE_DIR="+spool,
		"SHELL="+filepath.Join(binDir, "fakeshell"),
	)
	out, _ := cmd.CombinedOutput()
	if strings.Contains(string(out), "STUB-RESUMED") {
		t.Errorf("resumed a session belonging to another pane:\n%s", out)
	}
	if !strings.Contains(string(out), "STUB-SHELL") {
		t.Errorf("expected the shell fallback:\n%s", out)
	}
}

// A goal full of shell metacharacters must reach phase 1 as text, and must not
// be executed on the way.
func TestGoalLaneScriptDoesNotExecuteGoalText(t *testing.T) {
	canary := filepath.Join(t.TempDir(), "pwned")
	goal := "x\"; touch " + canary + "; echo `touch " + canary + "` $(touch " + canary + ")"
	run := runGoalLaneScript(t, goal, 0, true, "done")
	if run.err != nil {
		t.Fatalf("script failed: %v\n%s", run.err, run.stdout)
	}
	if _, err := os.Stat(canary); err == nil {
		t.Fatal("goal text was executed as shell")
	}
	if !strings.Contains(run.stdout, "STUB-RAN-PHASE-1 /goal "+goal) {
		t.Errorf("goal did not reach phase 1 verbatim:\n%s", run.stdout)
	}
}

// Every test above sets MUXTERM_SESSION_STATE_DIR, so the two arms the script
// falls back to were never executed -- and one of them was wrong: it resolved
// to /tmp/muxterm/session-state while socketDir() (spawn.go) and spool_dir()
// (state.py) both resolve to <tmp>/muxterm-<uid>/session-state. On a host with
// no XDG_RUNTIME_DIR the lane scanned an empty directory and reported "no
// finished goal run", which is a path mismatch wearing the words for a missing
// run. Both fallback arms are exercised here against the same stub, and each
// asserts the resume actually happened -- the only outcome that proves the
// script and the writers agree on where the spool is.
func runGoalLaneScriptInSpool(t *testing.T, spool string, extraEnv []string) string {
	t.Helper()

	dir := t.TempDir()
	binDir := filepath.Join(dir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}

	snapshot := fmt.Sprintf(`
sid=$PPID
cat > "%s/11111111-2222-3333-4444-555555555555.json" <<EOF
{"v":1,"pid":$$,"pidStart":1,"sessionId":"11111111-2222-3333-4444-555555555555","harness":"amplifier","mode":"autonomous","state":"done","updatedAt":1,"sid":$sid,"doneMeans":"whatever"}
EOF
`, spool)

	stub := fmt.Sprintf(`#!/bin/sh
case "$1" in
  run)
    printf 'STUB-RAN-PHASE-1 %%s\n' "$2"
    %s
    exit 0
    ;;
  resume)
    printf 'STUB-RESUMED %%s\n' "$2"
    exit 0
    ;;
esac
exit 99
`, snapshot)
	if err := os.WriteFile(filepath.Join(binDir, "amplifier"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	fakeShell := "#!/bin/sh\nprintf 'STUB-SHELL\\n'\n"
	if err := os.WriteFile(filepath.Join(binDir, "fakeshell"), []byte(fakeShell), 0o755); err != nil {
		t.Fatal(err)
	}

	argv, err := GoalLaneArgv("the fallback resolves")
	if err != nil {
		t.Fatalf("GoalLaneArgv: %v", err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	// A fresh environment, not os.Environ(): the point of the test is which
	// variables are ABSENT, and the test process inherits a real
	// XDG_RUNTIME_DIR from whatever runs it.
	cmd.Env = append([]string{
		"PATH=" + binDir + string(os.PathListSeparator) + os.Getenv("PATH"),
		"SHELL=" + filepath.Join(binDir, "fakeshell"),
		"HOME=" + dir,
	}, extraEnv...)
	out, _ := cmd.CombinedOutput()
	return string(out)
}

// No MUXTERM_SESSION_STATE_DIR, no XDG_RUNTIME_DIR: the plain headless server.
func TestGoalLaneScriptSpoolFallbackIsUIDScoped(t *testing.T) {
	tmp := t.TempDir()
	spool := filepath.Join(tmp, fmt.Sprintf("muxterm-%d", os.Getuid()), "session-state")
	out := runGoalLaneScriptInSpool(t, spool, []string{"TMPDIR=" + tmp})
	if !strings.Contains(out, "STUB-RESUMED 11111111-2222-3333-4444-555555555555") {
		t.Errorf("did not find the snapshot at the uid-scoped fallback %s:\n%s", spool, out)
	}
	if strings.Contains(out, "STUB-SHELL") {
		t.Errorf("fell back to a shell despite a resumable run in the spool:\n%s", out)
	}
}

// XDG_RUNTIME_DIR set, MUXTERM_SESSION_STATE_DIR unset: the ordinary desktop
// and the production instance.
func TestGoalLaneScriptSpoolFollowsXDGRuntimeDir(t *testing.T) {
	runtimeDir := t.TempDir()
	spool := filepath.Join(runtimeDir, "muxterm", "session-state")
	out := runGoalLaneScriptInSpool(t, spool, []string{"XDG_RUNTIME_DIR=" + runtimeDir})
	if !strings.Contains(out, "STUB-RESUMED 11111111-2222-3333-4444-555555555555") {
		t.Errorf("did not find the snapshot under XDG_RUNTIME_DIR at %s:\n%s", spool, out)
	}
	if strings.Contains(out, "STUB-SHELL") {
		t.Errorf("fell back to a shell despite a resumable run in the spool:\n%s", out)
	}
}
