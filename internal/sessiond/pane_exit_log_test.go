package sessiond

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

// captureLog redirects the standard logger for the duration of a test and
// returns the accumulated output. The daemon logs to the standard logger
// (journald captures it under muxterm-sessiond.service), so that is what a
// test has to read to prove an event is attributable in production.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prevOut := log.Writer()
	prevFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	})
	return &buf
}

// TestPaneExitReapIsLogged pins the answer to the question this file exists
// for: when a lane's agent process exits, muxterm removes the pane and -- if
// that was the workspace's last pane -- the workspace with it, WITHOUT anyone
// having asked. That behaviour is deliberate and stays. What is not acceptable
// is that it used to happen in total silence, which made a lane that crashed
// three seconds after birth indistinguishable, after the fact, from one that
// ran its goal loop to completion and from one an agent explicitly closed.
//
// If this test fails because the log lines moved, move the test. If it fails
// because they were deleted, do not delete the test -- the silence is the bug.
func TestPaneExitReapIsLogged(t *testing.T) {
	srv, err := NewServer(t.TempDir() + "/sessiond.sock")
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}

	// One workspace, one pane: exactly the shape spawn-lane creates.
	wsID := srv.reg.AddWorkspace("lane under test", "")
	paneID, ok := srv.reg.AllocPaneID(wsID)
	if !ok {
		t.Fatalf("AllocPaneID(%s) failed", wsID)
	}
	srv.reg.PutPane(wsID, &Pane{LocalID: paneID})

	buf := captureLog(t)
	srv.handlePaneExit(wsID, paneID, 9, 3200)
	out := buf.String()

	if srv.reg.Has(wsID) {
		t.Fatalf("workspace %s survived its last pane exiting; this test assumes the reap, "+
			"so the reap changing means this test needs rewriting, not deleting", wsID)
	}

	// The pane line has to carry the exit code and runtime, because "did it
	// finish or did it die?" is unanswerable without them once the pane is
	// gone.
	for _, want := range []string{"pane " + wsID, "process exited", "code=9", "runtime=3200ms"} {
		if !strings.Contains(out, want) {
			t.Errorf("pane-exit log missing %q\ngot:\n%s", want, out)
		}
	}

	// The workspace line has to say nobody asked, so it is never confused
	// with an explicit close.
	for _, want := range []string{"workspace " + wsID, "reaped", "nobody closed it"} {
		if !strings.Contains(out, want) {
			t.Errorf("workspace-reap log missing %q\ngot:\n%s", want, out)
		}
	}
}

// TestPaneExitWithSurvivingPaneDoesNotReap guards the other half: a lane is
// only destroyed when its LAST pane exits. A workspace with a second pane
// keeps living, and must not emit a reap line that would send a future
// investigator chasing a workspace that is still there.
func TestPaneExitWithSurvivingPaneDoesNotReap(t *testing.T) {
	srv, err := NewServer(t.TempDir() + "/sessiond.sock")
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}

	wsID := srv.reg.AddWorkspace("two panes", "")
	first, _ := srv.reg.AllocPaneID(wsID)
	srv.reg.PutPane(wsID, &Pane{LocalID: first})
	second, _ := srv.reg.AllocPaneID(wsID)
	srv.reg.PutPane(wsID, &Pane{LocalID: second})

	buf := captureLog(t)
	srv.handlePaneExit(wsID, first, 0, 120)
	out := buf.String()

	if !srv.reg.Has(wsID) {
		t.Fatalf("workspace %s reaped while a second pane was still open", wsID)
	}
	if strings.Contains(out, "reaped") {
		t.Errorf("reap logged for a workspace that still has a pane\ngot:\n%s", out)
	}
	if !strings.Contains(out, "remaining=1") {
		t.Errorf("pane-exit log missing remaining count\ngot:\n%s", out)
	}
}

// TestPaneExitOnUnknownPaneIsSilent keeps the log honest. handlePaneExit is
// deliberately a no-op when the pane is already gone (close-workspace killed
// it first, and the PTY exit arrives afterwards). That second arrival must not
// produce a phantom removal line for a pane nobody removed twice.
func TestPaneExitOnUnknownPaneIsSilent(t *testing.T) {
	srv, err := NewServer(t.TempDir() + "/sessiond.sock")
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	wsID := srv.reg.AddWorkspace("empty", "")

	buf := captureLog(t)
	srv.handlePaneExit(wsID, 42, 0, 10)
	if out := buf.String(); out != "" {
		t.Errorf("handlePaneExit on an unknown pane logged %q, want silence", out)
	}
}
