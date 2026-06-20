package sessiond

import (
	"sync"

	"github.com/go-rod/rod"
)

// ChromiumManager is defined in browser_chromium.go (added by Task 4).
// This placeholder stub exists solely so that the browser_manager.go struct
// field `chromium *ChromiumManager` compiles before Task 4 runs.
// Task 4 replaces this stub with the full implementation.
type ChromiumManager struct{}

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
