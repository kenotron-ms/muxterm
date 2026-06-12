package mcp

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/user/muxterm/internal/sessiond"
)

// TestBrowserSnapshotReturnsTree verifies that browserSnapshot sends action
// "snapshot" to the shim and returns {"snapshot":"..."} containing the
// accessibility tree text from the reply.
func TestBrowserSnapshotReturnsTree(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, wsID := attachedMCPClient(t, socketPath)
	actions, closeB := browserResponder(t, socketPath, wsID, sessiond.Message{
		OK:       true,
		Snapshot: `button "OK" e1`,
	})
	defer closeB()

	out, err := newBrowserTools(mc).browserSnapshot(map[string]any{"pane_id": 1})
	if err != nil {
		t.Fatalf("browserSnapshot: %v", err)
	}
	select {
	case a := <-actions:
		if a.Action != "snapshot" {
			t.Errorf("shim received action=%q, want snapshot", a.Action)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no browser-action received")
	}
	if !strings.Contains(out, "snapshot") {
		t.Errorf("browserSnapshot result = %s, want to contain 'snapshot'", out)
	}
	if !strings.Contains(out, "e1") {
		t.Errorf("browserSnapshot result = %s, want to contain 'e1'", out)
	}
}

// TestBrowserEvalReturnsResult verifies that browserEval sends action "eval_"
// and returns {"result":<json>} with the value from the shim's Result field.
func TestBrowserEvalReturnsResult(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, wsID := attachedMCPClient(t, socketPath)
	actions, closeB := browserResponder(t, socketPath, wsID, sessiond.Message{
		OK:     true,
		Result: json.RawMessage(`"hello"`),
	})
	defer closeB()

	out, err := newBrowserTools(mc).browserEval(map[string]any{"pane_id": 1, "expr": "document.title"})
	if err != nil {
		t.Fatalf("browserEval: %v", err)
	}
	select {
	case a := <-actions:
		if a.Action != "eval_" {
			t.Errorf("shim received action=%q, want eval_", a.Action)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no browser-action received")
	}
	if out != `{"result":"hello"}` {
		t.Errorf("browserEval result = %s, want {\"result\":\"hello\"}", out)
	}
}

// TestBrowserScreenshotPlaceholder verifies that browserScreenshot returns the
// Phase 5 placeholder error without contacting the daemon.
func TestBrowserScreenshotPlaceholder(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, _ := attachedMCPClient(t, socketPath)

	out, err := newBrowserTools(mc).browserScreenshot(map[string]any{"pane_id": 2})
	if err != nil {
		t.Fatalf("browserScreenshot: %v", err)
	}
	if !strings.Contains(out, "not available") {
		t.Errorf("browserScreenshot result = %s, want to contain 'not available'", out)
	}
}
