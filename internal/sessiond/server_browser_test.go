package sessiond

import (
	"testing"
	"time"
)

// TestCreateBrowserPane_SucceedsAndBroadcasts verifies the full lifecycle of
// creating a browser pane: the actor gets a pane-created ACK with a positive
// pane id, a pane-added broadcast carries the correct surface-kind and port,
// and a second observer client also receives the pane-added broadcast.
func TestCreateBrowserPane_SucceedsAndBroadcasts(t *testing.T) {
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

	// A sends a create-pane for a browser surface.
	a.send(&Message{
		Type:        TypeCreatePane,
		CID:         3,
		SurfaceKind: "browser",
		BrowserPort: 5173,
		BrowserPath: "/",
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

	// A receives the pane-added broadcast with correct surface kind and port.
	addedA := a.waitCtrl(TypePaneAdded)
	if addedA.PaneID != paneID {
		t.Fatalf("A pane-added PaneID = %d, want %d", addedA.PaneID, paneID)
	}
	if addedA.SurfaceKind != "browser" {
		t.Fatalf("A pane-added SurfaceKind = %q, want %q", addedA.SurfaceKind, "browser")
	}
	if addedA.BrowserPort != 5173 {
		t.Fatalf("A pane-added BrowserPort = %d, want 5173", addedA.BrowserPort)
	}

	// B also receives the pane-added broadcast with the same pane id and surface kind.
	addedB := b.waitCtrl(TypePaneAdded)
	if addedB.PaneID != paneID {
		t.Fatalf("B pane-added PaneID = %d, want %d", addedB.PaneID, paneID)
	}
	if addedB.SurfaceKind != "browser" {
		t.Fatalf("B pane-added SurfaceKind = %q, want %q", addedB.SurfaceKind, "browser")
	}
}

// TestCreateBrowserPane_InvalidPort_Errors verifies that a browser pane with
// port 0 is rejected with a TypeError reply carrying the correct CID.
func TestCreateBrowserPane_InvalidPort_Errors(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	a.send(&Message{
		Type:        TypeCreatePane,
		CID:         3,
		SurfaceKind: "browser",
		BrowserPort: 0,
	})

	errMsg := a.waitCtrl(TypeError)
	if errMsg.CID != 3 {
		t.Fatalf("error CID = %d, want 3", errMsg.CID)
	}
	_ = srv
}

// TestPaneUpdate_UpdatesStoredPath verifies that a pane-update message updates
// the stored browser path in the registry for the named pane.
func TestPaneUpdate_UpdatesStoredPath(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	// Create a browser pane on port 9002.
	a.send(&Message{
		Type:        TypeCreatePane,
		CID:         2,
		SurfaceKind: "browser",
		BrowserPort: 9002,
		BrowserPath: "/",
	})
	created := a.waitCtrl(TypePaneCreated)
	paneID := created.PaneID
	a.waitCtrl(TypePaneAdded)

	// Send a pane-update to navigate to /dashboard.
	a.send(&Message{
		Type:        TypePaneUpdate,
		PaneID:      paneID,
		BrowserPath: "/dashboard",
	})

	// Spin briefly to allow the server goroutine to process the update.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		p, ok := srv.Registry().Pane(wsID, paneID)
		if ok {
			info := p.Info()
			if info.BrowserPath == "/dashboard" {
				return // success
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	p, _ := srv.Registry().Pane(wsID, paneID)
	t.Fatalf("BrowserPath = %q after pane-update, want %q", p.Info().BrowserPath, "/dashboard")
}

// TestComposition_IncludesBrowserPane verifies that a fresh attach after
// creating a browser pane includes that pane in the composition with the
// correct surface kind and browser port.
func TestComposition_IncludesBrowserPane(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	// Create a browser pane.
	a.send(&Message{
		Type:        TypeCreatePane,
		CID:         2,
		SurfaceKind: "browser",
		BrowserPort: 5173,
		BrowserPath: "/",
	})
	a.waitCtrl(TypePaneCreated)
	a.waitCtrl(TypePaneAdded)

	// A fresh client attaches and should see the browser pane in the composition.
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeAttach, CID: 10, WorkspaceID: wsID})
	comp := b.waitCtrl(TypeComposition)

	if len(comp.Panes) != 1 {
		t.Fatalf("composition Panes = %d, want 1", len(comp.Panes))
	}
	p := comp.Panes[0]
	if p.SurfaceKind != "browser" {
		t.Fatalf("composition Pane SurfaceKind = %q, want %q", p.SurfaceKind, "browser")
	}
	if p.BrowserPort != 5173 {
		t.Fatalf("composition Pane BrowserPort = %d, want 5173", p.BrowserPort)
	}
	_ = srv
}
