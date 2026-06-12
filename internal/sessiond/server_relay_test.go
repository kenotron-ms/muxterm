package sessiond

import (
	"testing"
)

// TestBrowserActionBroadcast proves that when an attached conn sends a
// browser-action request, every subscriber to that workspace receives a
// TypeBrowserAction event with CID == 0 and the action fields preserved.
func TestBrowserActionBroadcast(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	// Actor: the client that sends the browser-action request.
	actor := newTClient(t, socketPath)
	actor.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	actor.waitCtrl(TypeComposition)

	// Observer: a second client attached to the same workspace.
	observer := newTClient(t, socketPath)
	observer.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	observer.waitCtrl(TypeComposition)

	// Actor sends a browser-action with CID=99 (a request correlation id).
	actor.send(&Message{
		Type:        TypeBrowserAction,
		CID:         99,
		WorkspaceID: wsID,
		PaneID:      3,
		Action:      "click",
		Ref:         "e5",
	})

	// Observer should receive a TypeBrowserAction broadcast with CID cleared to 0.
	msg := observer.waitCtrl(TypeBrowserAction)
	if msg.CID != 0 {
		t.Fatalf("broadcast CID = %d, want 0 (CID must be cleared on broadcast)", msg.CID)
	}
	if msg.Action != "click" {
		t.Fatalf("broadcast Action = %q, want %q", msg.Action, "click")
	}
	if msg.Ref != "e5" {
		t.Fatalf("broadcast Ref = %q, want %q", msg.Ref, "e5")
	}
	if msg.PaneID != 3 {
		t.Fatalf("broadcast PaneID = %d, want 3", msg.PaneID)
	}
}

// TestBrowserActionResultBroadcast proves that when an attached conn sends a
// browser-action-result, every subscriber to that workspace receives a
// TypeBrowserActionResult event with CID == 0 (event fan-out; the MCP client
// correlates by its own pending request).
func TestBrowserActionResultBroadcast(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	// conn A: the browser client that sends the result (shim → Go side).
	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	// conn B: the MCP client that should receive the broadcast.
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	b.waitCtrl(TypeComposition)

	// conn A sends a browser-action-result with CID=77 (its own correlation id).
	a.send(&Message{
		Type:  TypeBrowserActionResult,
		CID:   77,
		Error: "bridge-not-ready",
	})

	// conn B should receive a TypeBrowserActionResult broadcast with CID cleared to 0.
	msg := b.waitCtrl(TypeBrowserActionResult)
	if msg.CID != 0 {
		t.Fatalf("broadcast CID = %d, want 0 (CID must be cleared on broadcast)", msg.CID)
	}
}

// TestLayoutCommandBroadcast proves that when an attached conn sends a
// layout-command request, every subscriber to that workspace receives a
// TypeLayoutCommand event with CID == 0 and the action field preserved.
func TestLayoutCommandBroadcast(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	// Actor: the client that sends the layout-command request.
	actor := newTClient(t, socketPath)
	actor.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	actor.waitCtrl(TypeComposition)

	// Observer: a second client attached to the same workspace.
	observer := newTClient(t, socketPath)
	observer.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	observer.waitCtrl(TypeComposition)

	// Actor sends a layout-command with CID=42 (a request correlation id).
	actor.send(&Message{
		Type:        TypeLayoutCommand,
		CID:         42,
		WorkspaceID: wsID,
		Action:      "create-pane",
		PaneID:      0,
	})

	// Observer should receive a TypeLayoutCommand broadcast with CID cleared to 0.
	msg := observer.waitCtrl(TypeLayoutCommand)
	if msg.CID != 0 {
		t.Fatalf("broadcast CID = %d, want 0 (CID must be cleared on broadcast)", msg.CID)
	}
	if msg.Action != "create-pane" {
		t.Fatalf("broadcast Action = %q, want %q", msg.Action, "create-pane")
	}
}
