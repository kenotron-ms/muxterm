package sessiond

import (
	"testing"
)

// TestBrowserActionBroadcast and TestBrowserActionResultBroadcast lived here.
// They were removed when muxterm dropped browser pane support: their subjects
// (TypeBrowserAction / TypeBrowserActionResult) no longer exist. The file is
// kept — and TestLayoutCommandBroadcast below with it — because TypeLayoutCommand
// is a surviving, unrelated relay.

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
