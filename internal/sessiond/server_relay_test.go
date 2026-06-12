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
