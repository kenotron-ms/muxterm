package sessiond

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"sync"
)

// BrowserManager manages all CDP browser pages for a single muxterm server.
// v1 allows at most one browser page (maxPages: 1). The underlying Chromium
// process is shared across all pages (one process, N tabs) and is started
// lazily on the first OpenPage call. BrowserManager is instantiated in the
// HTTP server layer (alongside TunnelRegistry) and injected into Hub so that
// /ws/browser WebSocket handlers can reach it.
type BrowserManager struct {
	mu            sync.Mutex
	chromiumCmd   *exec.Cmd  // nil until first OpenPage call
	cdp           *CDPConn   // nil until first OpenPage call
	pages         map[int]*BrowserPage
	maxPages      int                 // v1: 1; remove check for multi-window
	broadcast     func(paneID int, data []byte) // sends JPEG frames to /ws/browser clients
	broadcastJSON func(msg any)                  // sends URL/error/progress JSON to /ws/browser
}

// BrowserPage manages one live Chromium tab. It owns the event loop goroutine
// and routes input to raw CDP calls.
type BrowserPage struct {
	paneID    int
	sessionID string          // CDP flattened session ID for this tab
	targetID  string
	cdp       *CDPConn        // shared with BrowserManager
	manager   *BrowserManager
	cancel    context.CancelFunc
}

// NewBrowserManager creates a BrowserManager with broadcast callbacks.
// broadcast is called with (paneID, jpegBytes) for each screencast frame.
// broadcastJSON is called with BrowserURLMsg/BrowserErrorMsg/BrowserProgressMsg
// values to fan-out as JSON.
func NewBrowserManager(broadcast func(paneID int, data []byte), broadcastJSON func(msg any)) *BrowserManager {
	return &BrowserManager{
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

	ctx := context.Background()

	if bm.chromiumCmd == nil {
		// Broadcast that we are starting (0%)
		bm.broadcastJSON(BrowserProgressMsg{
			Type:    TypeBrowserDownloadProgress,
			PaneID:  paneID,
			Percent: 0,
		})

		binPath, err := chromiumBin()
		if err != nil {
			bm.broadcastJSON(BrowserErrorMsg{
				Type:   TypeBrowserError,
				PaneID: paneID,
				Error:  err.Error(),
			})
			return nil, fmt.Errorf("browser: chromium binary: %w", err)
		}

		profileDir := filepath.Join(chromiumDataDir(), "profile")
		cmd, wsURL, err := launchChromium(ctx, binPath, profileDir, nil)
		if err != nil {
			bm.broadcastJSON(BrowserErrorMsg{
				Type:   TypeBrowserError,
				PaneID: paneID,
				Error:  err.Error(),
			})
			return nil, fmt.Errorf("browser: launch chromium: %w", err)
		}

		cdp, err := dialCDP(ctx, wsURL)
		if err != nil {
			cmd.Process.Kill() //nolint:errcheck
			return nil, fmt.Errorf("browser: dial CDP: %w", err)
		}

		bm.chromiumCmd = cmd
		bm.cdp = cdp

		// Broadcast that Chrome is ready (100%)
		bm.broadcastJSON(BrowserProgressMsg{
			Type:    TypeBrowserDownloadProgress,
			PaneID:  paneID,
			Percent: 100,
		})
	}

	// Create a new tab
	result, err := bm.cdp.Call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"})
	if err != nil {
		return nil, fmt.Errorf("browser: create target: %w", err)
	}
	var target struct {
		TargetID string `json:"targetId"`
	}
	if err := json.Unmarshal(result, &target); err != nil {
		return nil, fmt.Errorf("browser: parse target: %w", err)
	}

	// Attach to tab with a flattened session
	result, err = bm.cdp.Call(ctx, "", "Target.attachToTarget", map[string]any{
		"targetId": target.TargetID,
		"flatten":  true,
	})
	if err != nil {
		return nil, fmt.Errorf("browser: attach to target: %w", err)
	}
	var session struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(result, &session); err != nil {
		return nil, fmt.Errorf("browser: parse session: %w", err)
	}

	// Enable page events
	if _, err := bm.cdp.Call(ctx, session.SessionID, "Page.enable", nil); err != nil {
		return nil, fmt.Errorf("browser: Page.enable: %w", err)
	}

	// Set viewport to 1280×720
	if _, err := bm.cdp.Call(ctx, session.SessionID, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             1280,
		"height":            720,
		"deviceScaleFactor": 1,
		"mobile":            false,
	}); err != nil {
		return nil, fmt.Errorf("browser: set viewport: %w", err)
	}

	pageCtx, cancel := context.WithCancel(ctx)
	bp := &BrowserPage{
		paneID:    paneID,
		sessionID: session.SessionID,
		targetID:  target.TargetID,
		cdp:       bm.cdp,
		manager:   bm,
		cancel:    cancel,
	}
	bm.pages[paneID] = bp
	go bp.runEventLoop(pageCtx)
	return bp, nil
}

// ClosePage cancels the page context, closes the CDP target, and removes the
// page from the manager. Safe to call with an unknown paneID (no-op).
func (bm *BrowserManager) ClosePage(paneID int) {
	bm.mu.Lock()
	bp := bm.pages[paneID]
	delete(bm.pages, paneID)
	cdp := bm.cdp
	bm.mu.Unlock()

	if bp != nil {
		if bp.cancel != nil {
			bp.cancel()
		}
		if cdp != nil && bp.targetID != "" {
			_, _ = cdp.Call(context.Background(), "", "Target.closeTarget", map[string]any{"targetId": bp.targetID})
		}
	}
}

// ActivePaneIDs returns the pane IDs of all currently open browser pages. The
// returned slice is a snapshot and not kept in any particular order.
func (bm *BrowserManager) ActivePaneIDs() []int {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	ids := make([]int, 0, len(bm.pages))
	for id := range bm.pages {
		ids = append(ids, id)
	}
	return ids
}

// ScreenshotPage takes a JPEG screenshot of the browser page for paneID and
// returns the raw JPEG bytes. Returns an error if no page is open for paneID.
func (bm *BrowserManager) ScreenshotPage(paneID int) ([]byte, error) {
	bm.mu.Lock()
	bp := bm.pages[paneID]
	bm.mu.Unlock()
	if bp == nil {
		return nil, fmt.Errorf("no browser page for pane %d", paneID)
	}
	return bp.captureScreenshot(context.Background())
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
	cdp := bm.cdp
	bm.cdp = nil
	cmd := bm.chromiumCmd
	bm.chromiumCmd = nil
	bm.mu.Unlock()

	for _, bp := range pages {
		if bp.cancel != nil {
			bp.cancel()
		}
	}
	if cdp != nil {
		cdp.Close()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
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
