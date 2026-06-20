package sessiond

import (
	"context"
	"testing"
)

// TestBrowserManagerAuthorityField is a compile-time check that BrowserManager
// has an authority map[int]string field (via NewBrowserManager returning a
// struct that accepts SetAuthority/IsAuthority calls).
func TestBrowserManagerAuthorityField(t *testing.T) {
	bm := NewBrowserManager(nil, nil)
	// If authority is not initialized, SetAuthority would panic.
	// This call proves the field is both declared and initialized.
	bm.SetAuthority(1, "client-a")
}

// TestBrowserManagerSetAuthority verifies that SetAuthority makes a client the
// authority for a pane and returns true from IsAuthority.
func TestBrowserManagerSetAuthority(t *testing.T) {
	bm := NewBrowserManager(nil, nil)

	if bm.IsAuthority(1, "client-a") {
		t.Fatal("expected no authority initially")
	}

	bm.SetAuthority(1, "client-a")

	if !bm.IsAuthority(1, "client-a") {
		t.Fatal("expected client-a to be authority after SetAuthority")
	}
	if bm.IsAuthority(1, "client-b") {
		t.Fatal("client-b should not be authority for pane 1")
	}
}

// TestBrowserManagerLastFocusWins verifies that a second SetAuthority call
// replaces the current authority (last-focus-wins semantics).
func TestBrowserManagerLastFocusWins(t *testing.T) {
	bm := NewBrowserManager(nil, nil)

	bm.SetAuthority(1, "client-a")
	// client-b takes over
	bm.SetAuthority(1, "client-b")

	if bm.IsAuthority(1, "client-a") {
		t.Fatal("client-a should NOT be authority after client-b claimed focus")
	}
	if !bm.IsAuthority(1, "client-b") {
		t.Fatal("client-b should be authority after last-focus-wins SetAuthority")
	}
}

// TestBrowserManagerClearAuthority verifies that a client can clear its own
// authority, after which IsAuthority returns false.
func TestBrowserManagerClearAuthority(t *testing.T) {
	bm := NewBrowserManager(nil, nil)

	bm.SetAuthority(1, "client-a")
	bm.ClearAuthority(1, "client-a")

	if bm.IsAuthority(1, "client-a") {
		t.Fatal("expected no authority after ClearAuthority")
	}
}

// TestBrowserManagerClearAuthorityWrongClient verifies that ClearAuthority is a
// no-op when the caller is not the current authority.
func TestBrowserManagerClearAuthorityWrongClient(t *testing.T) {
	bm := NewBrowserManager(nil, nil)

	bm.SetAuthority(1, "client-a")
	// client-b cannot evict client-a
	bm.ClearAuthority(1, "client-b")

	if !bm.IsAuthority(1, "client-a") {
		t.Fatal("client-a should still be authority after wrong-client ClearAuthority")
	}
}

// TestBrowserManagerAuthorityPerPane verifies that authority is tracked per
// pane, so different panes can have different authorities.
func TestBrowserManagerAuthorityPerPane(t *testing.T) {
	bm := NewBrowserManager(nil, nil)

	bm.SetAuthority(1, "client-a")
	bm.SetAuthority(2, "client-b")

	if !bm.IsAuthority(1, "client-a") {
		t.Fatal("pane 1: expected client-a authority")
	}
	if !bm.IsAuthority(2, "client-b") {
		t.Fatal("pane 2: expected client-b authority")
	}
	if bm.IsAuthority(1, "client-b") {
		t.Fatal("pane 1: client-b should not have authority")
	}
}

// TestBrowserPageSetViewportExists is a compile-time check that BrowserPage
// has a SetViewport(context.Context, int, int) error method.
func TestBrowserPageSetViewportExists(t *testing.T) {
	// This just needs to compile. The method expression has type:
	// func(*BrowserPage, context.Context, int, int) error
	var f = (*BrowserPage).SetViewport
	_ = f
	// Also verify context package is imported (prevents unused-import compiler error).
	var _ context.Context
}
