package sessiond

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
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
	authorityID   map[int]string              // paneID → current input authority clientID
	broadcast     func(paneID int, data []byte) // sends JPEG frames to /ws/browser clients
	broadcastJSON func(msg any)                  // sends URL/error/progress JSON to /ws/browser
}

// BrowserPage manages one live Chromium tab. It owns the event loop goroutine
// and routes input to raw CDP calls.
type BrowserPage struct {
	paneID     int
	sessionID  string          // CDP flattened session ID for this tab
	targetID   string
	cdp        *CDPConn        // shared with BrowserManager
	manager    *BrowserManager
	cancel     context.CancelFunc
	currentURL      string  // last navigated URL; set by handleEvent Page.frameNavigated
	devicePixelRatio float64 // 1.0 when unset; set from browser-focus DevicePixelRatio
	renderWidth     int     // last viewport width from browser-focus; used to re-apply on navigation
	renderHeight    int     // last viewport height from browser-focus; used to re-apply on navigation
	// currentURL is written only from runEventLoop and read from the
	// TypeBrowserFocus goroutine — a plain field is acceptable for this
	// non-critical URL display (no mutex needed).
}

// NewBrowserManager creates a BrowserManager with broadcast callbacks.
// broadcast is called with (paneID, jpegBytes) for each screencast frame.
// broadcastJSON is called with BrowserURLMsg/BrowserErrorMsg/BrowserProgressMsg
// values to fan-out as JSON.
func NewBrowserManager(broadcast func(paneID int, data []byte), broadcastJSON func(msg any)) *BrowserManager {
	return &BrowserManager{
		pages:         make(map[int]*BrowserPage),
		authorityID:   make(map[int]string),
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

	// Activate the target so headless Chrome treats it as the foreground tab.
	// Without this, mouse drag events don't extend text selection because the
	// document isn't considered "focused" by the browser process.
	if _, err := bm.cdp.Call(ctx, "", "Target.activateTarget", map[string]any{
		"targetId": target.TargetID,
	}); err != nil {
			_ = err // non-fatal
	}

	// Enable focus emulation so headless Chrome behaves as if the page has
	// window focus. Playwright uses this same call. Without it, Blink's
	// selection-extension logic on mousemove (buttons=1) is suppressed
	// because the renderer considers the document unfocused.
	if _, err := bm.cdp.Call(ctx, session.SessionID, "Emulation.setFocusEmulationEnabled", map[string]any{
		"enabled": true,
	}); err != nil {
		_ = err // non-fatal
	}

	// Set initial viewport to 1280×720 at scale 1.0. The real deviceScaleFactor
	// is not known yet — it arrives with the first browser-focus event from the
	// client and is applied via SetViewport at that point.
	dpr := 1.0
	if _, err := bm.cdp.Call(ctx, session.SessionID, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             1280,
		"height":            720,
		"deviceScaleFactor": dpr,
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

// SetViewport updates Chromium's render resolution for this page.
// Calls Emulation.setDeviceMetricsOverride with the given dimensions and the
// stored devicePixelRatio (set from the client's browser-focus event).
// A 5-second deadline is applied. Returns an error if CDP fails.
func (bp *BrowserPage) SetViewport(ctx context.Context, width, height int) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	dpr := bp.devicePixelRatio
	if dpr <= 0 {
		dpr = 1.0
	}
	_, err := bp.cdp.Call(ctx, bp.sessionID, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             width,
		"height":            height,
		"deviceScaleFactor": dpr,
		"mobile":            false,
	})
	if err == nil {
		// Store so we can re-apply after Page.frameNavigated (Chrome resets
		// deviceScaleFactor on navigation, causing the first frame of a new
		// page to arrive at DPR=1 until the client's next browser-focus).
		bp.renderWidth = width
		bp.renderHeight = height
	}
	return err
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
// A 5-second deadline is applied so callers are never blocked permanently if
// the Chrome CDP connection is slow or dead.
func (bm *BrowserManager) ScreenshotPage(paneID int) ([]byte, error) {
	bm.mu.Lock()
	bp := bm.pages[paneID]
	bm.mu.Unlock()
	if bp == nil {
		return nil, fmt.Errorf("no browser page for pane %d", paneID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return bp.captureScreenshot(ctx)
}

// GetPage returns the BrowserPage for paneID and whether it was found.
func (bm *BrowserManager) GetPage(paneID int) (*BrowserPage, bool) {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	bp, ok := bm.pages[paneID]
	return bp, ok
}

// SetAuthority records clientID as the current input authority for paneID.
// Last-focus-wins: the most recent browser-focus event always wins.
// Lazily initializes authorityID if nil.
func (bm *BrowserManager) SetAuthority(paneID int, clientID string) {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	if bm.authorityID == nil {
		bm.authorityID = make(map[int]string)
	}
	bm.authorityID[paneID] = clientID
}

// ClearAuthority clears the input authority for paneID if the current authority
// matches clientID. Calling with the wrong clientID is a no-op (another client
// has already claimed authority).
func (bm *BrowserManager) ClearAuthority(paneID int, clientID string) {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	if bm.authorityID[paneID] == clientID {
		delete(bm.authorityID, paneID)
	}
}

// IsAuthority reports whether clientID holds input authority for paneID.
// Empty clientID never matches.
func (bm *BrowserManager) IsAuthority(paneID int, clientID string) bool {
	if clientID == "" {
		return false
	}
	bm.mu.Lock()
	defer bm.mu.Unlock()
	return bm.authorityID[paneID] == clientID
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
