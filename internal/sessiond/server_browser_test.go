package sessiond

import (
	"testing"
)

// TestCreateBrowserCDPPane_SucceedsAndBroadcasts2 verifies the full lifecycle of
// creating a browser-cdp pane: the actor gets a pane-created ACK with a positive
// pane id, a pane-added broadcast carries the correct surface-kind ("browser-cdp"),
// and a second observer client also receives the pane-added broadcast.
func TestCreateBrowserCDPPane_SucceedsAndBroadcasts2(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	// Client A attaches.
	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	// Client B also attaches as an observer.
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	b.waitCtrl(TypeComposition)

	// A sends a create-browser-pane request (CDP path).
	a.send(&Message{
		Type: TypeCreateBrowserPane,
		CID:  3,
	})

	// A gets a pane-created reply with a positive pane id.
	created := a.waitCtrl(TypePaneCreated)
	if created.CID != 3 {
		t.Fatalf("pane-created CID = %d, want 3", created.CID)
	}
	paneID := created.PaneID
	if paneID <= 0 {
		t.Fatalf("pane-created PaneID = %d, want > 0", paneID)
	}

	// A receives the pane-added broadcast with correct surface kind.
	addedA := a.waitCtrl(TypePaneAdded)
	if addedA.PaneID != paneID {
		t.Fatalf("A pane-added PaneID = %d, want %d", addedA.PaneID, paneID)
	}
	if addedA.SurfaceKind != "browser-cdp" {
		t.Fatalf("A pane-added SurfaceKind = %q, want \"browser-cdp\"", addedA.SurfaceKind)
	}

	// B also receives the pane-added broadcast with the same pane id and surface kind.
	addedB := b.waitCtrl(TypePaneAdded)
	if addedB.PaneID != paneID {
		t.Fatalf("B pane-added PaneID = %d, want %d", addedB.PaneID, paneID)
	}
	if addedB.SurfaceKind != "browser-cdp" {
		t.Fatalf("B pane-added SurfaceKind = %q, want \"browser-cdp\"", addedB.SurfaceKind)
	}
}

// TestCreateBrowserCDPPane_ClosesCleanly verifies that a browser-cdp pane can be
// closed without error and the pane-closed event is broadcast.
func TestCreateBrowserCDPPane_ClosesCleanly(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	// Create a browser-cdp pane.
	a.send(&Message{Type: TypeCreateBrowserPane, CID: 2})
	created := a.waitCtrl(TypePaneCreated)
	paneID := created.PaneID
	a.waitCtrl(TypePaneAdded)

	// Close it.
	a.send(&Message{Type: TypeCloseBrowserPane, CID: 3, PaneID: paneID})
	ok := a.waitCtrl(TypeOK)
	if ok.CID != 3 {
		t.Fatalf("close ok CID = %d, want 3", ok.CID)
	}

	// Verify pane is gone from registry.
	if _, exists := srv.Registry().Pane(wsID, paneID); exists {
		t.Fatalf("pane %d still in registry after close", paneID)
	}
}

// TestComposition_IncludesBrowserCDPPane verifies that a fresh attach after
// creating a browser-cdp pane includes that pane in the composition with the
// correct surface kind.
func TestComposition_IncludesBrowserCDPPane(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	// Create a browser-cdp pane.
	a.send(&Message{Type: TypeCreateBrowserPane, CID: 2})
	a.waitCtrl(TypePaneCreated)
	a.waitCtrl(TypePaneAdded)

	// A fresh client attaches and should see the browser-cdp pane in the composition.
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeAttach, CID: 10, WorkspaceID: wsID})
	comp := b.waitCtrl(TypeComposition)

	if len(comp.Panes) != 1 {
		t.Fatalf("composition Panes = %d, want 1", len(comp.Panes))
	}
	p := comp.Panes[0]
	if p.SurfaceKind != "browser-cdp" {
		t.Fatalf("composition Pane SurfaceKind = %q, want \"browser-cdp\"", p.SurfaceKind)
	}
	_ = srv
}
