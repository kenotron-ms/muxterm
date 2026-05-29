//go:build integration

package tmux

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"
)

// waitForEvent drains the events channel until the predicate matches or the timeout expires.
func waitForEvent(t *testing.T, events <-chan Event, timeout time.Duration, desc string, predicate func(Event) bool) Event {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				t.Fatalf("waitForEvent(%s): events channel closed before matching event", desc)
			}
			if predicate(ev) {
				return ev
			}
		case <-deadline:
			t.Fatalf("waitForEvent(%s): timed out after %v", desc, timeout)
		}
	}
}

// containsBytes performs a byte-level substring search.
func containsBytes(haystack, needle []byte) bool {
	return bytes.Contains(haystack, needle)
}

// filterTestEnv returns the current environment with TMUX and TMUX_PANE removed.
// This allows control mode to work when tests run inside a tmux session.
func filterTestEnv() []string {
	var env []string
	for _, e := range os.Environ() {
		if len(e) >= 5 && e[:5] == "TMUX=" {
			continue
		}
		if len(e) >= 10 && e[:10] == "TMUX_PANE=" {
			continue
		}
		env = append(env, e)
	}
	return env
}

func TestIntegration_ControlMode(t *testing.T) {
	// Skip if tmux not in PATH.
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not found in PATH, skipping integration test")
	}

	sessionName := "muxterm-integration-test"
	env := filterTestEnv()

	// Start tmux in control mode, creating a new session directly.
	// Using -C (single C) which works without a TTY; -CC requires terminal
	// attributes that aren't available when stdin/stdout are pipes.
	// new-session in control mode sends %window-add and %session-changed,
	// which properly populates the controller state.
	cmd := exec.Command("tmux", "-C", "new-session", "-s", sessionName, "-x", "80", "-y", "24")
	cmd.Env = env

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("failed to get stdin pipe: %v", err)
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("failed to get stdout pipe: %v", err)
	}

	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start tmux -C: %v", err)
	}

	// Cleanup: kill the session when the test finishes.
	t.Cleanup(func() {
		kill := exec.Command("tmux", "kill-session", "-t", sessionName)
		_ = kill.Run()
	})

	// Create the controller with events channel capacity 100.
	events := make(chan Event, 100)
	ctrl := NewController(ControllerConfig{
		Reader: stdoutPipe,
		Writer: stdinPipe,
		Events: events,
	})

	// Run the controller in a goroutine.
	runErr := make(chan error, 1)
	go func() {
		runErr <- ctrl.Run()
	}()

	// ---------- 1. SessionChangedEvent on connect ----------
	// tmux sends %window-add before %session-changed on new-session.
	// The controller's ApplyWindowAdd drops the window because there's no
	// active session yet. We capture the WindowAddEvent so we can replay
	// the window add after the session is established.
	t.Log("Step 1: Waiting for SessionChangedEvent...")
	var pendingWindowID string
	ev := waitForEvent(t, events, 5*time.Second, "SessionChangedEvent", func(e Event) bool {
		if wa, ok := e.(WindowAddEvent); ok {
			pendingWindowID = wa.WindowID
			return false
		}
		_, ok := e.(SessionChangedEvent)
		return ok
	})
	sce := ev.(SessionChangedEvent)
	if sce.Name != sessionName {
		t.Errorf("SessionChangedEvent: got name %q, want %q", sce.Name, sessionName)
	}
	t.Logf("  Got SessionChangedEvent: session=%s name=%s", sce.SessionID, sce.Name)

	// Replay the window-add that was missed due to event ordering.
	state := ctrl.State()
	if pendingWindowID != "" {
		t.Logf("  Replaying WindowAddEvent for %s", pendingWindowID)
		state.ApplyWindowAdd(pendingWindowID)
	}

	// ---------- 2. LayoutChangeEvent for initial layout ----------
	// tmux does not emit %layout-change on initial connect, so we trigger
	// it by requesting the current layout via select-layout.
	t.Log("Step 2: Triggering and waiting for LayoutChangeEvent (initial layout)...")
	if _, err := fmt.Fprintln(stdinPipe, "select-layout even-horizontal"); err != nil {
		t.Fatalf("failed to send select-layout: %v", err)
	}

	ev = waitForEvent(t, events, 5*time.Second, "LayoutChangeEvent (initial)", func(e Event) bool {
		_, ok := e.(LayoutChangeEvent)
		return ok
	})
	lce := ev.(LayoutChangeEvent)
	if lce.WindowID == "" {
		t.Error("LayoutChangeEvent: empty window ID")
	}
	t.Logf("  Got LayoutChangeEvent: window=%s layout=%s", lce.WindowID, lce.Layout)

	// ---------- 3. RenameWindow -> WindowRenamedEvent ----------
	t.Log("Step 3: Sending RenameWindow command...")
	windowID := lce.WindowID
	if err := ctrl.Commands().RenameWindow(windowID, "test-window"); err != nil {
		t.Fatalf("RenameWindow failed: %v", err)
	}

	ev = waitForEvent(t, events, 5*time.Second, "WindowRenamedEvent", func(e Event) bool {
		wre, ok := e.(WindowRenamedEvent)
		return ok && wre.Name == "test-window"
	})
	wre := ev.(WindowRenamedEvent)
	t.Logf("  Got WindowRenamedEvent: window=%s name=%s", wre.WindowID, wre.Name)

	// ---------- 4. SendKeys -> OutputEvent containing marker ----------
	t.Log("Step 4: Sending keys to echo a marker...")
	// Get a pane ID from state.
	var paneID string
	state.mu.RLock()
	for _, sess := range state.Sessions {
		for _, win := range sess.Windows {
			if len(win.Panes) > 0 {
				paneID = win.Panes[0].ID
				break
			}
		}
		if paneID != "" {
			break
		}
	}
	state.mu.RUnlock()

	if paneID == "" {
		t.Fatal("no pane found in state")
	}
	t.Logf("  Using pane %s", paneID)

	marker := "muxterm-test-marker"
	if err := ctrl.Commands().SendKeys(paneID, "echo "+marker); err != nil {
		t.Fatalf("SendKeys (echo) failed: %v", err)
	}
	if err := ctrl.Commands().SendKeys(paneID, "Enter"); err != nil {
		t.Fatalf("SendKeys (Enter) failed: %v", err)
	}

	ev = waitForEvent(t, events, 5*time.Second, "OutputEvent with marker", func(e Event) bool {
		oe, ok := e.(OutputEvent)
		return ok && containsBytes(oe.Data, []byte(marker))
	})
	oe := ev.(OutputEvent)
	t.Logf("  Got OutputEvent with marker: pane=%s len=%d", oe.PaneID, len(oe.Data))

	// ---------- 5. SplitWindow -> LayoutChangeEvent with >=2 panes ----------
	t.Log("Step 5: Splitting window horizontally...")
	if err := ctrl.Commands().SplitWindow(paneID, true); err != nil {
		t.Fatalf("SplitWindow failed: %v", err)
	}

	ev = waitForEvent(t, events, 5*time.Second, "LayoutChangeEvent (after split)", func(e Event) bool {
		_, ok := e.(LayoutChangeEvent)
		return ok
	})
	lce2 := ev.(LayoutChangeEvent)
	t.Logf("  Got LayoutChangeEvent after split: window=%s layout=%s", lce2.WindowID, lce2.Layout)

	// Verify state has >=2 panes.
	win := state.FindWindow(windowID)
	paneCount := 0
	if win != nil {
		paneCount = len(win.Panes)
	}

	if paneCount < 2 {
		t.Errorf("expected >=2 panes after split, got %d", paneCount)
	}
	t.Logf("  State has %d panes after split", paneCount)

	// ---------- 6. Clean shutdown ----------
	t.Log("Step 6: Clean shutdown...")
	stdinPipe.Close()

	select {
	case err := <-runErr:
		if err != nil {
			t.Errorf("Controller.Run() returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Controller.Run() did not return within 5s after stdin close")
	}

	// Wait for tmux process to exit.
	_ = cmd.Wait()

	t.Log("Integration test passed!")
}
