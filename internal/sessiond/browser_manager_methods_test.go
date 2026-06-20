package sessiond

import (
	"testing"
)

// TestNewBrowserManager verifies that NewBrowserManager initialises the struct
// with the expected zero/default values and stores the provided callbacks.
func TestNewBrowserManager(t *testing.T) {
	var broadcastCalled bool
	var broadcastJSONCalled bool

	broadcast := func(paneID int, data []byte) { broadcastCalled = true }
	broadcastJSON := func(msg any) { broadcastJSONCalled = true }

	bm := NewBrowserManager(broadcast, broadcastJSON)
	if bm == nil {
		t.Fatal("NewBrowserManager returned nil")
	}
	if bm.chromium == nil {
		t.Error("chromium should be initialised")
	}
	if bm.pages == nil {
		t.Error("pages map should be initialised")
	}
	if len(bm.pages) != 0 {
		t.Errorf("pages map should be empty, got %d entries", len(bm.pages))
	}
	if bm.maxPages != 1 {
		t.Errorf("maxPages should be 1, got %d", bm.maxPages)
	}
	if bm.browser != nil {
		t.Error("browser should be nil (lazy start)")
	}

	// Verify callbacks are wired.
	bm.broadcast(0, nil)
	if !broadcastCalled {
		t.Error("broadcast callback not wired")
	}
	bm.broadcastJSON(nil)
	if !broadcastJSONCalled {
		t.Error("broadcastJSON callback not wired")
	}
}

// TestBrowserManagerOpenPageLimitReached verifies that OpenPage returns an
// error when the page limit is already reached (without needing real Chromium).
func TestBrowserManagerOpenPageLimitReached(t *testing.T) {
	bm := NewBrowserManager(func(int, []byte) {}, func(any) {})

	// Manually insert a fake page to fill the limit.
	bm.mu.Lock()
	bm.pages[1] = &BrowserPage{paneID: 1}
	bm.mu.Unlock()

	_, err := bm.OpenPage(2)
	if err == nil {
		t.Fatal("expected error when limit reached, got nil")
	}

	want := "browser: v1 limit reached (1 page(s) already open)"
	if err.Error() != want {
		t.Errorf("error message = %q, want %q", err.Error(), want)
	}
}

// TestBrowserManagerClosePageUnknown verifies that ClosePage is a no-op for an
// unknown paneID (does not panic).
func TestBrowserManagerClosePageUnknown(t *testing.T) {
	bm := NewBrowserManager(func(int, []byte) {}, func(any) {})
	// Should not panic.
	bm.ClosePage(999)
}

// TestBrowserManagerGetPageNotFound verifies that GetPage returns false for an
// unknown paneID.
func TestBrowserManagerGetPageNotFound(t *testing.T) {
	bm := NewBrowserManager(func(int, []byte) {}, func(any) {})

	bp, ok := bm.GetPage(42)
	if ok {
		t.Error("GetPage should return false for unknown paneID")
	}
	if bp != nil {
		t.Error("GetPage should return nil for unknown paneID")
	}
}

// TestBrowserManagerGetPageFound verifies that GetPage returns the stored page.
func TestBrowserManagerGetPageFound(t *testing.T) {
	bm := NewBrowserManager(func(int, []byte) {}, func(any) {})

	fake := &BrowserPage{paneID: 7}
	bm.mu.Lock()
	bm.pages[7] = fake
	bm.mu.Unlock()

	bp, ok := bm.GetPage(7)
	if !ok {
		t.Error("GetPage should return true for known paneID")
	}
	if bp != fake {
		t.Error("GetPage returned wrong BrowserPage")
	}
}

// TestBrowserManagerCloseEmpty verifies that Close does not panic when there
// are no open pages and no browser instance.
func TestBrowserManagerCloseEmpty(t *testing.T) {
	bm := NewBrowserManager(func(int, []byte) {}, func(any) {})
	// Should not panic.
	bm.Close()
}

// TestBrowserManagerCloseIdempotent verifies that Close can be called multiple
// times safely.
func TestBrowserManagerCloseIdempotent(t *testing.T) {
	bm := NewBrowserManager(func(int, []byte) {}, func(any) {})
	bm.Close()
	bm.Close() // must not panic
}

// TestBrowserManagerCloseRemovesPages verifies that Close empties the pages map.
func TestBrowserManagerCloseRemovesPages(t *testing.T) {
	bm := NewBrowserManager(func(int, []byte) {}, func(any) {})

	// Insert a fake page with a non-nil stopCh so stopScreencast won't panic.
	fake := &BrowserPage{paneID: 3, stopCh: make(chan struct{}), manager: bm}
	bm.mu.Lock()
	bm.pages[3] = fake
	bm.mu.Unlock()

	bm.Close()

	bm.mu.Lock()
	remaining := len(bm.pages)
	bm.mu.Unlock()

	if remaining != 0 {
		t.Errorf("Close should clear pages map, got %d remaining", remaining)
	}
}

// TestNewBrowserCDPPane verifies the Pane returned by newBrowserCDPPane has the
// expected fields set.
func TestNewBrowserCDPPane(t *testing.T) {
	p := newBrowserCDPPane(5)
	if p == nil {
		t.Fatal("newBrowserCDPPane returned nil")
	}
	if p.LocalID != 5 {
		t.Errorf("LocalID = %d, want 5", p.LocalID)
	}
	if p.Title != "Browser" {
		t.Errorf("Title = %q, want %q", p.Title, "Browser")
	}
	if p.SurfaceKind != "browser-cdp" {
		t.Errorf("SurfaceKind = %q, want %q", p.SurfaceKind, "browser-cdp")
	}
	// Verify no PTY/process fields are set.
	if p.ptmx != nil {
		t.Error("ptmx should be nil for browser-cdp pane")
	}
	if p.cmd != nil {
		t.Error("cmd should be nil for browser-cdp pane")
	}
	if p.buf != nil {
		t.Error("buf should be nil for browser-cdp pane")
	}
}
