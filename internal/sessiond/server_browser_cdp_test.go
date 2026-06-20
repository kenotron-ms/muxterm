package sessiond

import (
	"testing"
)

// TestCreateBrowserCDPPane_SucceedsAndBroadcasts verifies the full lifecycle of
// creating a browser-cdp pane via TypeCreateBrowserPane: the actor gets a
// pane-created ACK with a positive pane id, a pane-added broadcast carries
// "browser-cdp" as SurfaceKind with Title "Browser", and a second observer
// also receives the broadcast.
func TestCreateBrowserCDPPane_SucceedsAndBroadcasts(t *testing.T) {
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

	// A sends TypeCreateBrowserPane.
	a.send(&Message{
		Type:        TypeCreateBrowserPane,
		CID:         3,
		Placement:   "split-right",
		ReferencePaneID: 0,
	})

	// A gets a pane-created reply with a positive pane id and correct CID.
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
		t.Fatalf("A pane-added SurfaceKind = %q, want %q", addedA.SurfaceKind, "browser-cdp")
	}
	if addedA.Title != "Browser" {
		t.Fatalf("A pane-added Title = %q, want %q", addedA.Title, "Browser")
	}
	if addedA.Placement != "split-right" {
		t.Fatalf("A pane-added Placement = %q, want %q", addedA.Placement, "split-right")
	}

	// B also receives the pane-added broadcast with the same pane id and surface kind.
	addedB := b.waitCtrl(TypePaneAdded)
	if addedB.PaneID != paneID {
		t.Fatalf("B pane-added PaneID = %d, want %d", addedB.PaneID, paneID)
	}
	if addedB.SurfaceKind != "browser-cdp" {
		t.Fatalf("B pane-added SurfaceKind = %q, want %q", addedB.SurfaceKind, "browser-cdp")
	}

	// Verify the pane is in the registry with the correct surface kind.
	p, ok := srv.Registry().Pane(wsID, paneID)
	if !ok {
		t.Fatal("pane not found in registry after creation")
	}
	if p.SurfaceKind != "browser-cdp" {
		t.Fatalf("registry Pane SurfaceKind = %q, want %q", p.SurfaceKind, "browser-cdp")
	}
}

// TestCreateBrowserCDPPane_NotAttached_Errors verifies that TypeCreateBrowserPane
// returns CodeUnknownWorkspace when the client is not attached.
func TestCreateBrowserCDPPane_NotAttached_Errors(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	a := newTClient(t, socketPath)
	// Do NOT attach — send TypeCreateBrowserPane directly.
	a.send(&Message{Type: TypeCreateBrowserPane, CID: 5})

	errMsg := a.waitCtrl(TypeError)
	if errMsg.CID != 5 {
		t.Fatalf("error CID = %d, want 5", errMsg.CID)
	}
	if errMsg.Code != CodeUnknownWorkspace {
		t.Fatalf("error Code = %q, want %q", errMsg.Code, CodeUnknownWorkspace)
	}
}

// TestCloseBrowserCDPPane_ViaBrowserPaneType verifies that TypeCloseBrowserPane
// removes the pane and broadcasts TypePaneClosed, reusing the closePane handler.
func TestCloseBrowserCDPPane_ViaBrowserPaneType(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	// Create the browser-cdp pane.
	a.send(&Message{Type: TypeCreateBrowserPane, CID: 2})
	created := a.waitCtrl(TypePaneCreated)
	paneID := created.PaneID
	a.waitCtrl(TypePaneAdded)

	// Close it via TypeCloseBrowserPane.
	a.send(&Message{Type: TypeCloseBrowserPane, CID: 3, PaneID: paneID})
	okMsg := a.waitCtrl(TypeOK)
	if okMsg.CID != 3 {
		t.Fatalf("ok CID = %d, want 3", okMsg.CID)
	}

	// Verify pane-closed was broadcast.
	closed := a.waitCtrl(TypePaneClosed)
	if closed.PaneID != paneID {
		t.Fatalf("pane-closed PaneID = %d, want %d", closed.PaneID, paneID)
	}

	// Verify the pane is gone from the registry.
	_, ok := srv.Registry().Pane(wsID, paneID)
	if ok {
		t.Fatal("pane still in registry after close via TypeCloseBrowserPane")
	}
}
