package sessiond

import (
	"context"
	"fmt"
	"sync"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

// ChromiumManager is defined in browser_chromium.go.

// BrowserManager manages all CDP browser pages for a single muxterm server.
// v1 allows at most one browser page (maxPages: 1). The underlying Chromium
// process is shared across all pages (one process, N tabs) and is started
// lazily on the first OpenPage call. BrowserManager is instantiated in the
// HTTP server layer (alongside TunnelRegistry) and injected into Hub so that
// /ws/browser WebSocket handlers can reach it.
type BrowserManager struct {
	mu            sync.Mutex
	chromium      *ChromiumManager
	browser       *rod.Browser
	pages         map[int]*BrowserPage
	maxPages      int                  // v1: 1; remove check for multi-window
	broadcast     func(paneID int, data []byte) // sends JPEG frames to /ws/browser clients
	broadcastJSON func(msg any)                 // sends URL/error/progress JSON to /ws/browser
}

// BrowserPage manages one live Chromium tab. It owns the screencast goroutine
// and routes input to rod CDP calls.
type BrowserPage struct {
	paneID  int
	page    *rod.Page
	stopCh  chan struct{}
	manager *BrowserManager
}

// NewBrowserManager creates a BrowserManager with broadcast callbacks.
// broadcast is called with (paneID, jpegBytes) for each screencast frame.
// broadcastJSON is called with BrowserURLMsg/BrowserErrorMsg/BrowserProgressMsg
// values to fan-out as JSON.
func NewBrowserManager(broadcast func(paneID int, data []byte), broadcastJSON func(msg any)) *BrowserManager {
	return &BrowserManager{
		chromium:      NewChromiumManager(),
		pages:         make(map[int]*BrowserPage),
		maxPages:      1,
		broadcast:     broadcast,
		broadcastJSON: broadcastJSON,
	}
}

// OpenPage starts a new browser page for the given paneID. The entire
// operation is performed while holding mu to prevent concurrent opens.
func (bm *BrowserManager) OpenPage(paneID int) (*BrowserPage, error) {
	bm.mu.Lock()
	defer bm.mu.Unlock()

	if len(bm.pages) >= bm.maxPages {
		return nil, fmt.Errorf("browser: v1 limit reached (%d page(s) already open)", len(bm.pages))
	}

	if bm.browser == nil {
		browser, err := bm.chromium.Ensure(context.Background(), func(pct int) {
			bm.broadcastJSON(BrowserProgressMsg{
				Type:    TypeBrowserDownloadProgress,
				PaneID:  paneID,
				Percent: pct,
			})
		})
		if err != nil {
			bm.broadcastJSON(BrowserErrorMsg{
				Type:   TypeBrowserError,
				PaneID: paneID,
				Error:  err.Error(),
			})
			return nil, fmt.Errorf("browser: ensure chromium: %w", err)
		}
		bm.browser = browser
	}

	page, err := bm.browser.Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return nil, fmt.Errorf("browser: open page: %w", err)
	}

	if err := page.SetViewport(&proto.EmulationSetDeviceMetricsOverride{
		Width:             1280,
		Height:            720,
		DeviceScaleFactor: 1,
	}); err != nil {
		_ = page.Close()
		return nil, fmt.Errorf("browser: set viewport: %w", err)
	}

	bp := &BrowserPage{
		paneID:  paneID,
		page:    page,
		stopCh:  make(chan struct{}),
		manager: bm,
	}
	bm.pages[paneID] = bp
	bp.startScreencast()
	return bp, nil
}

// ClosePage stops the screencast, closes the tab, and removes the page from
// the manager. Safe to call with an unknown paneID (no-op).
func (bm *BrowserManager) ClosePage(paneID int) {
	bm.mu.Lock()
	bp := bm.pages[paneID]
	delete(bm.pages, paneID)
	bm.mu.Unlock()

	if bp != nil {
		bp.stopScreencast()
		if bp.page != nil {
			_ = bp.page.Close()
		}
	}
}

// GetPage returns the BrowserPage for paneID and whether it was found.
func (bm *BrowserManager) GetPage(paneID int) (*BrowserPage, bool) {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	bp, ok := bm.pages[paneID]
	return bp, ok
}

// Close stops all browser pages and kills the Chromium process. Called at
// server shutdown. Safe to call multiple times.
func (bm *BrowserManager) Close() {
	bm.mu.Lock()
	pages := make([]*BrowserPage, 0, len(bm.pages))
	for _, bp := range bm.pages {
		pages = append(pages, bp)
	}
	bm.pages = make(map[int]*BrowserPage)
	browser := bm.browser
	bm.browser = nil
	bm.mu.Unlock()

	for _, bp := range pages {
		bp.stopScreencast()
		if bp.page != nil {
			_ = bp.page.Close()
		}
	}
	if browser != nil {
		_ = browser.Close()
	}
}

// newBrowserCDPPane creates a minimal *Pane placeholder for a browser-cdp
// surface. It has no PTY, no buffer, and no child process.
func newBrowserCDPPane(localID int) *Pane {
	return &Pane{
		LocalID:     localID,
		Title:       "Browser",
		SurfaceKind: "browser-cdp",
	}
}
