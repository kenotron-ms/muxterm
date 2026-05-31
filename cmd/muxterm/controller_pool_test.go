package main

import (
	"io"
	"os"
	"strings"
	"testing"

	"github.com/user/muxterm/internal/tmux"
)

// fakeAttach builds a real (un-Run) tmux.Controller over in-memory streams.
// It records each session name that was attached.
// Returns nil for *os.File — not needed in tests.
func fakeAttach(attached *[]string) attachFunc {
	return func(sessionName string) (*tmux.Controller, *os.File, chan tmux.Event, func(), error) {
		*attached = append(*attached, sessionName)
		events := make(chan tmux.Event, 16)
		ctrl := tmux.NewController(tmux.ControllerConfig{
			Reader: strings.NewReader(""),
			Writer: io.Discard,
			Events: events,
		})
		return ctrl, nil, events, func() {}, nil
	}
}

// TestControllerPool_EnsureAttachesOncePerSession verifies that ensure() is
// idempotent: calling it twice for the same session name attaches only once,
// and get() returns non-nil after a successful ensure().
func TestControllerPool_EnsureAttachesOncePerSession(t *testing.T) {
	var attached []string
	pool := newControllerPool(fakeAttach(&attached))

	// First ensure should attach
	s1, err := pool.ensure("alpha")
	if err != nil {
		t.Fatalf("ensure alpha: %v", err)
	}
	if s1 == nil {
		t.Fatal("ensure returned nil session")
	}

	// Second ensure for same session should be idempotent (no new attach)
	s2, err := pool.ensure("alpha")
	if err != nil {
		t.Fatalf("second ensure alpha: %v", err)
	}
	if s2 != s1 {
		t.Error("ensure should return same session on second call")
	}

	if len(attached) != 1 {
		t.Errorf("expected 1 attach, got %d: %v", len(attached), attached)
	}

	// get() should return non-nil after ensure()
	got := pool.get("alpha")
	if got == nil {
		t.Fatal("get() returned nil after ensure()")
	}
	if got != s1 {
		t.Error("get() should return the same session as ensure()")
	}
}

// TestControllerPool_ActiveRouting verifies active-session routing:
// activeController() is nil before setActive; activeName() returns the correct
// name after setActive; and names() contains all attached sessions.
func TestControllerPool_ActiveRouting(t *testing.T) {
	var attached []string
	pool := newControllerPool(fakeAttach(&attached))

	// Before setActive, activeController() should return nil
	if pool.activeController() != nil {
		t.Error("expected nil activeController before setActive")
	}

	// Attach two sessions
	if _, err := pool.ensure("alpha"); err != nil {
		t.Fatalf("ensure alpha: %v", err)
	}
	if _, err := pool.ensure("beta"); err != nil {
		t.Fatalf("ensure beta: %v", err)
	}

	// Set active to alpha
	pool.setActive("alpha")
	if pool.activeName() != "alpha" {
		t.Errorf("expected activeName=alpha, got %q", pool.activeName())
	}

	// activeController should now be non-nil
	if pool.activeController() == nil {
		t.Error("expected non-nil activeController after setActive")
	}

	// names() should contain both attached sessions
	names := pool.names()
	if len(names) != 2 {
		t.Errorf("expected 2 names, got %v", names)
	}
	nameSet := map[string]bool{}
	for _, n := range names {
		nameSet[n] = true
	}
	if !nameSet["alpha"] || !nameSet["beta"] {
		t.Errorf("expected alpha and beta in names, got %v", names)
	}
}

// TestControllerPool_PaneOwnershipDedup verifies first-attached-wins pane ownership:
// the first session to claimPane wins, subsequent claims by other sessions fail,
// and ownership is released when the owning session is removed.
func TestControllerPool_PaneOwnershipDedup(t *testing.T) {
	var attached []string
	pool := newControllerPool(fakeAttach(&attached))

	// Attach both sessions so remove() can find them in p.sessions.
	if _, err := pool.ensure("dev"); err != nil {
		t.Fatalf("ensure dev: %v", err)
	}
	if _, err := pool.ensure("ops"); err != nil {
		t.Fatalf("ensure ops: %v", err)
	}

	// dev claims %1 first → should succeed
	if !pool.claimPane("dev", "%1") {
		t.Fatal("dev: claimPane(%1) should return true on first claim")
	}
	if !pool.ownsPane("dev", "%1") {
		t.Error("dev: ownsPane(%1) should be true after claiming")
	}

	// ops claims the same %1 → should fail (dev already owns it)
	if pool.claimPane("ops", "%1") {
		t.Fatal("ops: claimPane(%1) should return false — dev already owns it")
	}
	if pool.ownsPane("ops", "%1") {
		t.Error("ops: ownsPane(%1) should be false — ops does not own it")
	}

	// ops claims a different pane %2 → should succeed
	if !pool.claimPane("ops", "%2") {
		t.Fatal("ops: claimPane(%2) should return true on first claim for that pane")
	}

	// After remove("dev"), ops can re-claim %1
	pool.remove("dev")
	if !pool.claimPane("ops", "%1") {
		t.Fatal("ops: claimPane(%1) should return true after dev was removed")
	}
	if !pool.ownsPane("ops", "%1") {
		t.Error("ops: ownsPane(%1) should be true after re-claiming")
	}
}

// TestControllerPool_RememberSize verifies that rememberSize stores dimensions
// and ignores non-positive values.
func TestControllerPool_RememberSize(t *testing.T) {
	pool := newControllerPool(fakeAttach(new([]string)))

	// rememberSize(120, 40) should store dims
	pool.rememberSize(120, 40)
	cols, rows := pool.size()
	if cols != 120 || rows != 40 {
		t.Errorf("expected 120x40, got %dx%d", cols, rows)
	}

	// rememberSize(0, 0) should be ignored — previous dims should remain
	pool.rememberSize(0, 0)
	cols, rows = pool.size()
	if cols != 120 || rows != 40 {
		t.Errorf("zero dims should be ignored; expected 120x40, got %dx%d", cols, rows)
	}

	// rememberSize with one negative dim should also be ignored
	pool.rememberSize(-1, 40)
	cols, rows = pool.size()
	if cols != 120 || rows != 40 {
		t.Errorf("negative cols should be ignored; expected 120x40, got %dx%d", cols, rows)
	}
}
