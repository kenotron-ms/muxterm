package server

import (
	"errors"
	"sync"
	"testing"
)

// mockSurfaceClient is a test double for surfaceClient.
type mockSurfaceClient struct {
	mu sync.Mutex

	selectWindowCalls     []string
	aggressiveResizeCalls int
	refreshCalls          []struct{ cols, rows int }
	closeCalled           bool

	selectWindowErr     error
	aggressiveResizeErr error
	refreshErr          error
	closeErr            error
}

func (m *mockSurfaceClient) SelectWindow(windowID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.selectWindowCalls = append(m.selectWindowCalls, windowID)
	return m.selectWindowErr
}

func (m *mockSurfaceClient) SetAggressiveResize() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.aggressiveResizeCalls++
	return m.aggressiveResizeErr
}

func (m *mockSurfaceClient) RefreshClientSize(cols, rows int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refreshCalls = append(m.refreshCalls, struct{ cols, rows int }{cols, rows})
	return m.refreshErr
}

func (m *mockSurfaceClient) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closeCalled = true
	return m.closeErr
}

// TestSurfaceRouter_MountSelectsWindowAndEnablesAggressiveResize verifies that
// Mount calls SelectWindow with the provided windowID and then SetAggressiveResize.
func TestSurfaceRouter_MountSelectsWindowAndEnablesAggressiveResize(t *testing.T) {
	r := NewSurfaceRouter()
	c := &mockSurfaceClient{}

	if err := r.Mount("surf-1", "@2", c); err != nil {
		t.Fatalf("Mount returned unexpected error: %v", err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if len(c.selectWindowCalls) != 1 || c.selectWindowCalls[0] != "@2" {
		t.Errorf("expected SelectWindow(\"@2\") to be called once; got %v", c.selectWindowCalls)
	}
	if c.aggressiveResizeCalls != 1 {
		t.Errorf("expected SetAggressiveResize to be called once; got %d", c.aggressiveResizeCalls)
	}
}

// TestSurfaceRouter_ResizeRoutesToOwningClient verifies that Resize calls
// RefreshClientSize on the client registered for that surface.
func TestSurfaceRouter_ResizeRoutesToOwningClient(t *testing.T) {
	r := NewSurfaceRouter()
	c := &mockSurfaceClient{}

	if err := r.Mount("surf-3", "@5", c); err != nil {
		t.Fatalf("Mount returned unexpected error: %v", err)
	}

	if err := r.Resize("surf-3", 120, 40); err != nil {
		t.Fatalf("Resize returned unexpected error: %v", err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if len(c.refreshCalls) != 1 {
		t.Fatalf("expected 1 RefreshClientSize call; got %d", len(c.refreshCalls))
	}
	call := c.refreshCalls[0]
	if call.cols != 120 || call.rows != 40 {
		t.Errorf("expected RefreshClientSize(120, 40); got (%d, %d)", call.cols, call.rows)
	}
}

// TestSurfaceRouter_ResizeUnknownSurfaceErrors verifies that Resize returns an
// error when no client is registered for the requested surface ID.
func TestSurfaceRouter_ResizeUnknownSurfaceErrors(t *testing.T) {
	r := NewSurfaceRouter()

	err := r.Resize("surf-99", 80, 24)
	if err == nil {
		t.Fatal("expected error for unknown surface ID; got nil")
	}
}

// TestSurfaceRouter_UnmountClosesClient verifies that Unmount calls Close on the
// client that was registered for the surface and that subsequent calls with a
// nil/missing client return nil.
func TestSurfaceRouter_UnmountClosesClient(t *testing.T) {
	r := NewSurfaceRouter()
	c := &mockSurfaceClient{}

	if err := r.Mount("surf-2", "@3", c); err != nil {
		t.Fatalf("Mount returned unexpected error: %v", err)
	}

	if err := r.Unmount("surf-2"); err != nil {
		t.Fatalf("Unmount returned unexpected error: %v", err)
	}

	c.mu.Lock()
	closed := c.closeCalled
	c.mu.Unlock()

	if !closed {
		t.Error("expected Close to be called on the surface client; it was not")
	}

	// A second Unmount for the same (now-absent) surface should return nil.
	if err := r.Unmount("surf-2"); err != nil {
		t.Errorf("second Unmount (no client) should return nil; got: %v", err)
	}
}

// TestSurfaceRouter_AcceptDedupsByGlobalPaneID verifies that the first surface to
// see a pane claims ownership, subsequent surfaces are rejected, and the owner
// surface continues to be accepted.
func TestSurfaceRouter_AcceptDedupsByGlobalPaneID(t *testing.T) {
	r := NewSurfaceRouter()

	// First sighting of pane 5 on surf-a: should be accepted and claim ownership.
	if !r.Accept(5, "surf-a") {
		t.Fatal("expected Accept(5, surf-a) to return true (first claim)")
	}

	// Same pane 5 on surf-b: duplicate — should be dropped.
	if r.Accept(5, "surf-b") {
		t.Fatal("expected Accept(5, surf-b) to return false (duplicate on non-owner)")
	}

	// Ongoing output for pane 5 on the owner surf-a: should still be accepted.
	if !r.Accept(5, "surf-a") {
		t.Fatal("expected Accept(5, surf-a) to return true (ongoing output on owner)")
	}
}

// TestSurfaceRouter_AcceptReassignsAfterUnmount verifies that after the owning
// surface is unmounted, its pane can be re-claimed by a new surface.
func TestSurfaceRouter_AcceptReassignsAfterUnmount(t *testing.T) {
	r := NewSurfaceRouter()
	cA := &mockSurfaceClient{}

	// Mount surf-a so we can unmount it later.
	if err := r.Mount("surf-a", "@1", cA); err != nil {
		t.Fatalf("Mount returned unexpected error: %v", err)
	}

	// Pane 7 claimed by surf-a.
	if !r.Accept(7, "surf-a") {
		t.Fatal("expected Accept(7, surf-a) to return true (first claim)")
	}

	// Unmount surf-a — this should free pane 7 from r.owner.
	if err := r.Unmount("surf-a"); err != nil {
		t.Fatalf("Unmount returned unexpected error: %v", err)
	}

	// Pane 7 should now be re-claimable by surf-c.
	if !r.Accept(7, "surf-c") {
		t.Fatal("expected Accept(7, surf-c) to return true after surf-a was unmounted")
	}
}

// Compile-time guard: ensure errors package is used (for future error-wrapping tests).
var _ = errors.New
