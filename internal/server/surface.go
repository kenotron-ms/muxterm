package server

import (
	"fmt"
	"sync"
)

// SurfaceID is a stable string minted by the frontend (e.g. "surf-3").
type SurfaceID string

// surfaceClient is the interface for a tmux control-mode client dedicated to a
// single visible surface.
type surfaceClient interface {
	// SelectWindow switches the control client's view to the given tmux window.
	SelectWindow(windowID string) error
	// SetAggressiveResize enables aggressive-resize on the control client so
	// tmux sizes the window to fit the surface's viewport, not the smallest client.
	SetAggressiveResize() error
	// RefreshClientSize sends refresh-client -C WxH so tmux reports the correct
	// dimensions for this surface's viewport.
	RefreshClientSize(cols, rows int) error
	// Close shuts down the control client connection.
	Close() error
}

// SurfaceRouter routes per-surface control operations to their dedicated tmux
// control clients. Each visible surface gets its own client so resize and
// window-selection operations are isolated and do not interfere with each other.
type SurfaceRouter struct {
	mu      sync.Mutex
	clients map[SurfaceID]surfaceClient
	// owner tracks which surface currently owns each pane (by numeric pane ID).
	// Used in Task 10 for pane deduplication across surfaces.
	owner map[uint32]SurfaceID
}

// NewSurfaceRouter returns an initialised, empty SurfaceRouter.
func NewSurfaceRouter() *SurfaceRouter {
	return &SurfaceRouter{
		clients: make(map[SurfaceID]surfaceClient),
		owner:   make(map[uint32]SurfaceID),
	}
}

// Mount registers a dedicated control client for surface id, selects the given
// tmux window on that client, and enables aggressive-resize. It returns an error
// if either tmux call fails; in that case the client is not registered.
func (r *SurfaceRouter) Mount(id SurfaceID, windowID string, c surfaceClient) error {
	if err := c.SelectWindow(windowID); err != nil {
		return fmt.Errorf("SurfaceRouter.Mount %q: SelectWindow: %w", id, err)
	}
	if err := c.SetAggressiveResize(); err != nil {
		return fmt.Errorf("SurfaceRouter.Mount %q: SetAggressiveResize: %w", id, err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.clients[id] = c
	return nil
}

// Resize routes a RefreshClientSize call to the control client registered for
// surface id. It returns an error if no client is registered for that surface.
func (r *SurfaceRouter) Resize(id SurfaceID, cols, rows int) error {
	r.mu.Lock()
	c, ok := r.clients[id]
	r.mu.Unlock()

	if !ok {
		return fmt.Errorf("SurfaceRouter.Resize: no client for surface %q", id)
	}
	return c.RefreshClientSize(cols, rows)
}

// Unmount closes the control client registered for surface id, removes it from
// the registry, and drops any pane ownership entries for that surface. If no
// client is registered for id, Unmount is a no-op and returns nil.
func (r *SurfaceRouter) Unmount(id SurfaceID) error {
	r.mu.Lock()
	c, ok := r.clients[id]
	if ok {
		delete(r.clients, id)
		// Drop pane ownership for this surface.
		for pane, owner := range r.owner {
			if owner == id {
				delete(r.owner, pane)
			}
		}
	}
	r.mu.Unlock()

	if !ok {
		return nil
	}
	return c.Close()
}
