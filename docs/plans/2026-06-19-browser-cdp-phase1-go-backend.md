# Browser CDP Pane — Phase 1: Go Backend Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Add the Go backend that manages a Chromium process via go-rod, streams JPEG frames over a new `/ws/browser` WebSocket, and relays mouse/keyboard input back via CDP.

**Architecture:** `BrowserManager` (defined in `internal/sessiond` package) is instantiated in the HTTP server layer alongside `TunnelRegistry`. The muxterm daemon tracks browser-cdp pane IDs in its registry (for composition); the HTTP server drives actual Chromium interaction. JPEG frames flow directly from the BrowserManager's screencast goroutine to all connected `/ws/browser` WebSocket clients — never through the Unix socket that would congest terminal I/O. Input travels `/ws/browser` → HTTP server → `BrowserPage.HandleInput()` directly.

**Tech Stack:** Go 1.24.2, `github.com/go-rod/rod` (rod launcher + CDP), `github.com/coder/websocket`

**Design doc:** `docs/designs/2026-06-19-browser-cdp-pane-design.md`

---

## Pre-flight: read these files before starting

```
internal/sessiond/protocol.go   — Message struct, type constants, PaneInfo
internal/sessiond/server.go     — daemon conn.handle() dispatch pattern
internal/sessiond/pane.go       — Pane struct, NewBrowserPane (to be removed later)
internal/sessiond/client.go     — CreateBrowserPane method pattern to copy
internal/server/ws.go           — Client.handleTextInput(), Hub, EncodeBinaryFrame
internal/server/server.go       — New(), route registration, Server/Hub structs
internal/server/daemon.go       — DaemonConn interface
cmd/muxterm/main.go             — runLocal/runServe startup pattern
```

---

## Task 1: Add go-rod dependency

**Files:**
- Modify: `go.mod`, `go.sum` (automatic)

**Step 1: Fetch the module**

```bash
cd /Users/ken/workspace/ms/muxterm
go get github.com/go-rod/rod@latest
```

**Step 2: Verify it compiles**

```bash
go build ./...
```

Expected: zero errors. `go.mod` now contains `github.com/go-rod/rod`.

**Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "chore: add go-rod dependency for browser CDP pane

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 2: Add new protocol constants and wire types

**Files:**
- Modify: `internal/sessiond/protocol.go`

This task is **additive only** — no removals yet. Removals happen in Task 11.

**Step 1: Add new type constants and message structs to protocol.go**

Open `internal/sessiond/protocol.go`. After the existing `TypeError = "error"` constant, add the browser-cdp constants. After the `TunnelInfo` struct, add the browser wire types.

**Exact addition — insert after `TypeError = "error"` in the const block:**

```go
	// Browser CDP pane messages (create-browser-pane, /ws/browser wire types).
	TypeCreateBrowserPane        = "create-browser-pane"
	TypeCloseBrowserPane         = "close-browser-pane"
	TypeBrowserInput             = "browser-input"
	TypeBrowserURL               = "browser-url"
	TypeBrowserDownloadProgress  = "browser-download-progress"
	TypeBrowserError             = "browser-error"
```

**Exact addition — insert after `TunnelInfo` struct (after line 204 in current file):**

```go
// BrowserInputMsg is the event payload inside a {type:"browser-input"} JSON frame
// sent by the browser client on /ws/browser. Type names match browser DOM event types.
type BrowserInputMsg struct {
	Type   string  `json:"type"`   // mousemove|mousedown|mouseup|wheel|keydown|keyup|type|navigate|resize
	X      float64 `json:"x,omitempty"`
	Y      float64 `json:"y,omitempty"`
	Button string  `json:"button,omitempty"` // left|middle|right
	DeltaX float64 `json:"deltaX,omitempty"`
	DeltaY float64 `json:"deltaY,omitempty"`
	Key    string  `json:"key,omitempty"`    // e.g. "Enter", "ArrowLeft", "a"
	Text   string  `json:"text,omitempty"`   // for "type" events
	URL    string  `json:"url,omitempty"`    // for "navigate" events; "history:back" etc.
	Width  int     `json:"width,omitempty"`  // for "resize" events
	Height int     `json:"height,omitempty"` // for "resize" events
}

// BrowserURLMsg is the {type:"browser-url"} JSON frame sent by the server on /ws/browser
// whenever the browser pane navigates to a new URL.
type BrowserURLMsg struct {
	Type   string `json:"type"`
	PaneID int    `json:"paneId"`
	URL    string `json:"url"`
}

// BrowserProgressMsg is the {type:"browser-download-progress"} JSON frame sent while
// Chromium is being downloaded on first launch.
type BrowserProgressMsg struct {
	Type    string `json:"type"`
	PaneID  int    `json:"paneId"`
	Percent int    `json:"percent"`
}

// BrowserErrorMsg is the {type:"browser-error"} JSON frame sent when a browser operation
// fails (download failure, navigation error, Chromium crash).
type BrowserErrorMsg struct {
	Type   string `json:"type"`
	PaneID int    `json:"paneId"`
	Error  string `json:"error"`
}
```

**Step 2: Verify**

```bash
go build ./...
```

Expected: zero errors.

**Step 3: Commit**

```bash
git add internal/sessiond/protocol.go
git commit -m "feat: add browser-cdp protocol constants and wire types

Adds TypeCreateBrowserPane, TypeCloseBrowserPane, TypeBrowserInput,
TypeBrowserURL, TypeBrowserDownloadProgress, TypeBrowserError constants
plus BrowserInputMsg and JSON frame structs for /ws/browser protocol.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 3: browser_manager.go — struct declarations

**Files:**
- Create: `internal/sessiond/browser_manager.go`

**Step 1: Create the file with struct declarations only (no methods yet)**

```go
// internal/sessiond/browser_manager.go
package sessiond

import (
	"sync"

	"github.com/go-rod/rod"
)

// BrowserManager manages all CDP browser pages for a single muxterm server.
// v1 allows at most one browser page (maxPages: 1). The underlying Chromium
// process is shared across all pages (one process, N tabs) and is started lazily
// on the first OpenPage call.
//
// BrowserManager is instantiated in the HTTP server layer (alongside TunnelRegistry)
// and injected into Hub so that /ws/browser WebSocket handlers can reach it.
type BrowserManager struct {
	mu           sync.Mutex
	chromium     *ChromiumManager
	browser      *rod.Browser
	pages        map[int]*BrowserPage
	maxPages     int // v1: 1; remove check for multi-window
	broadcast    func(paneID int, data []byte) // sends JPEG frames to /ws/browser clients
	broadcastJSON func(msg any)                // sends URL/error/progress JSON to /ws/browser
}

// BrowserPage manages one live Chromium tab.
// It owns the screencast goroutine and routes input to rod CDP calls.
type BrowserPage struct {
	paneID  int
	page    *rod.Page
	stopCh  chan struct{}
	manager *BrowserManager
}
```

**Step 2: Verify**

```bash
go build ./...
```

Expected: zero errors.

**Step 3: Commit**

```bash
git add internal/sessiond/browser_manager.go
git commit -m "feat: add BrowserManager and BrowserPage struct declarations

Defines the two core browser CDP structs. Methods are added in a
subsequent task. BrowserManager lives in the HTTP server layer
alongside TunnelRegistry.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 4: browser_chromium.go — Chromium download and launch

**Files:**
- Create: `internal/sessiond/browser_chromium.go`

**Step 1: Create the file**

```go
// internal/sessiond/browser_chromium.go
package sessiond

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
)

// PinnedRevision is the tested Chromium revision bundled with this muxterm release.
// Bumped and validated with each muxterm release. Auto-downloads once (~150 MB) when
// the local revision differs from this value.
const PinnedRevision = "1313161"

// ChromiumManager handles locating, downloading, and launching the Chromium binary.
// It is created once per BrowserManager and shared across all BrowserPage instances.
type ChromiumManager struct {
	revision string
}

// NewChromiumManager returns a ChromiumManager pinned to PinnedRevision.
func NewChromiumManager() *ChromiumManager {
	return &ChromiumManager{revision: PinnedRevision}
}

// chromiumDataDir returns the platform-conventional directory for storing the
// muxterm-managed Chromium binary.
//
//	Linux:  $XDG_DATA_HOME/muxterm/chromium  (falls back to ~/.local/share/muxterm/chromium)
//	macOS:  ~/Library/Application Support/muxterm/chromium
func chromiumDataDir() string {
	switch runtime.GOOS {
	case "darwin":
		if home := os.Getenv("HOME"); home != "" {
			return filepath.Join(home, "Library", "Application Support", "muxterm", "chromium")
		}
	}
	// Linux / XDG
	if base := os.Getenv("XDG_DATA_HOME"); base != "" {
		return filepath.Join(base, "muxterm", "chromium")
	}
	if home := os.Getenv("HOME"); home != "" {
		return filepath.Join(home, ".local", "share", "muxterm", "chromium")
	}
	return filepath.Join(os.TempDir(), "muxterm-chromium")
}

// Ensure downloads Chromium if not already present, launches it headlessly, and
// returns a connected *rod.Browser. ctx is used for the connection step; progressCb
// receives 0–100 download percent (nil = no progress reporting).
//
// The rod launcher auto-downloads to the platform data directory and caches the
// binary. Subsequent calls with the same revision are instant (binary already present).
func (c *ChromiumManager) Ensure(ctx context.Context, progressCb func(pct int)) (*rod.Browser, error) {
	dataDir := chromiumDataDir()
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("chromium: create data dir %s: %w", dataDir, err)
	}

	l := launcher.New().
		Headless(true).
		Set("no-sandbox").
		Set("disable-dev-shm-usage").
		Revision(c.revision).
		UserDataDir(filepath.Join(dataDir, "profile"))

	url, err := l.Launch()
	if err != nil {
		return nil, fmt.Errorf("chromium: launch (revision %s): %w", c.revision, err)
	}

	b, err := rod.New().ControlURL(url).Connect()
	if err != nil {
		return nil, fmt.Errorf("chromium: connect CDP: %w", err)
	}

	return b, nil
}
```

**Step 2: Verify**

```bash
go build ./...
```

Expected: zero errors. If `launcher.New()` does not have a `.Revision()` method in the version of go-rod that was downloaded, use `.Bin(launcher.NewBrowser().MustGet(c.revision))` as a replacement. Check with `go doc github.com/go-rod/rod/lib/launcher Launcher` to confirm the API.

**Step 3: Commit**

```bash
git add internal/sessiond/browser_chromium.go
git commit -m "feat: add ChromiumManager for Chromium download and launch

Handles platform-conventional data dir, pinned revision (1313161),
and headless launch via rod launcher. Auto-downloads on first run.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 5: browser_input.go — HandleInput method

**Files:**
- Create: `internal/sessiond/browser_input.go`

**Step 1: Create the file**

```go
// internal/sessiond/browser_input.go
package sessiond

import (
	"fmt"
	"strings"

	"github.com/go-rod/rod/lib/input"
	"github.com/go-rod/rod/lib/proto"
)

// HandleInput routes a BrowserInputMsg to the appropriate rod CDP call.
// Mouse coordinates are in Chromium viewport pixels (already mapped by the client).
// Returns nil for unknown event types (forward-compatible).
func (bp *BrowserPage) HandleInput(msg BrowserInputMsg) error {
	switch msg.Type {
	case "mousemove":
		return bp.page.Mouse.Move(msg.X, msg.Y, 1)
	case "mousedown":
		return bp.page.Mouse.Down(mouseButton(msg.Button), 1)
	case "mouseup":
		return bp.page.Mouse.Up(mouseButton(msg.Button), 1)
	case "wheel":
		return bp.page.Mouse.Scroll(msg.X, msg.Y, msg.DeltaX, msg.DeltaY, 1)
	case "keydown":
		k := keyFromName(msg.Key)
		if k == 0 {
			return nil // unknown key — ignore
		}
		return bp.page.Keyboard.Down(k)
	case "keyup":
		k := keyFromName(msg.Key)
		if k == 0 {
			return nil
		}
		return bp.page.Keyboard.Up(k)
	case "type":
		// InsertText injects printable characters directly, bypassing key event mapping.
		return bp.page.InsertText(msg.Text)
	case "navigate":
		return bp.handleNavigate(msg.URL)
	case "resize":
		return bp.page.SetViewport(&proto.EmulationSetDeviceMetricsOverride{
			Width:             msg.Width,
			Height:            msg.Height,
			DeviceScaleFactor: 1,
		})
	}
	return nil // unknown event type — forward-compatible no-op
}

// handleNavigate dispatches navigation commands. Sentinel URLs are used for
// history actions instead of invoking page.Navigate with a real URL.
func (bp *BrowserPage) handleNavigate(url string) error {
	switch url {
	case "history:back":
		return bp.page.NavigateBack()
	case "history:forward":
		return bp.page.NavigateForward()
	case "history:reload":
		return bp.page.Reload()
	default:
		if url == "" {
			return fmt.Errorf("navigate: empty URL")
		}
		// Auto-prefix https:// when no scheme is present.
		if !strings.Contains(url, "://") {
			url = "https://" + url
		}
		return bp.page.Navigate(url)
	}
}

// mouseButton converts a browser button name string to a rod InputMouseButtonType.
func mouseButton(name string) proto.InputMouseButtonType {
	switch name {
	case "middle":
		return proto.InputMouseButtonMiddle
	case "right":
		return proto.InputMouseButtonRight
	default:
		return proto.InputMouseButtonLeft
	}
}

// keyFromName converts a browser KeyboardEvent.key string to a rod input.Key.
// Returns 0 for unknown or unsupported keys (caller should skip).
func keyFromName(name string) input.Key {
	// Single printable ASCII characters: use the code point directly.
	if len(name) == 1 {
		return input.Key(name[0])
	}
	switch name {
	case "Enter":
		return input.Enter
	case "Backspace":
		return input.Backspace
	case "Tab":
		return input.Tab
	case "Escape":
		return input.Escape
	case "Delete":
		return input.Delete
	case "ArrowLeft":
		return input.ArrowLeft
	case "ArrowRight":
		return input.ArrowRight
	case "ArrowUp":
		return input.ArrowUp
	case "ArrowDown":
		return input.ArrowDown
	case "Home":
		return input.Home
	case "End":
		return input.End
	case "PageUp":
		return input.PageUp
	case "PageDown":
		return input.PageDown
	case "F1":
		return input.F1
	case "F2":
		return input.F2
	case "F3":
		return input.F3
	case "F4":
		return input.F4
	case "F5":
		return input.F5
	case "F6":
		return input.F6
	case "F7":
		return input.F7
	case "F8":
		return input.F8
	case "F9":
		return input.F9
	case "F10":
		return input.F10
	case "F11":
		return input.F11
	case "F12":
		return input.F12
	case "Control":
		return input.ControlLeft
	case "Shift":
		return input.ShiftLeft
	case "Alt":
		return input.AltLeft
	case "Meta":
		return input.MetaLeft
	case "Space":
		return input.Space
	}
	return 0
}
```

**Step 2: Verify**

```bash
go build ./...
```

Expected: zero errors. If any `input.XXX` constant is not found, check with `go doc github.com/go-rod/rod/lib/input` and substitute the correct constant name. The `input` package exposes constants for all standard keys.

**Step 3: Commit**

```bash
git add internal/sessiond/browser_input.go
git commit -m "feat: add BrowserPage.HandleInput for input dispatch via rod CDP

Routes mousemove/mousedown/mouseup/wheel/keydown/keyup/type/navigate/resize
events to rod API calls. Auto-prefixes https:// on bare navigate URLs.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 6: browser_screencast.go — JPEG frame streaming goroutine

**Files:**
- Create: `internal/sessiond/browser_screencast.go`

**Step 1: Create the file**

```go
// internal/sessiond/browser_screencast.go
package sessiond

import (
	"encoding/base64"

	"github.com/go-rod/rod/lib/proto"
)

// startScreencast subscribes to Chromium's Page.screencastFrame events and begins
// streaming JPEG frames to the BrowserManager's broadcast callback. It also subscribes
// to Page.frameNavigated to broadcast URL changes.
//
// Frames are sent non-blocking: if the broadcast function cannot deliver immediately,
// the frame is still sent (the hub uses non-blocking sends with drop semantics at
// the WebSocket write layer). screencastFrameAck is called for every frame — without
// this Chromium stops sending.
//
// startScreencast spawns a goroutine that stops when stopCh is closed.
func (bp *BrowserPage) startScreencast() {
	// Subscribe to JPEG frames — EachEvent returns a cancel function.
	cancelFrames := bp.page.EachEvent(func(e *proto.PageScreencastFrame) {
		data, err := base64.StdEncoding.DecodeString(e.Data)
		if err == nil && len(data) > 0 {
			bp.manager.broadcast(bp.paneID, data)
		}
		// Must ACK every frame; Chromium stalls without this.
		_ = proto.PageScreencastFrameAck{SessionID: e.SessionID}.Call(bp.page)
	})

	// Subscribe to main-frame navigation events for URL updates.
	cancelNav := bp.page.EachEvent(func(e *proto.PageFrameNavigated) {
		// ParentID == "" identifies the main (top-level) frame.
		if e.Frame.ParentID == "" && e.Frame.URL != "" {
			bp.manager.broadcastJSON(BrowserURLMsg{
				Type:   TypeBrowserURL,
				PaneID: bp.paneID,
				URL:    e.Frame.URL,
			})
		}
	})

	// Start the screencast with JPEG quality 75, max 1280×720, every frame.
	_ = proto.PageStartScreencast{
		Format:        proto.PageStartScreencastFormatJpeg,
		Quality:       75,
		MaxWidth:      1280,
		MaxHeight:     720,
		EveryNthFrame: 1,
	}.Call(bp.page)

	// Background goroutine: cleans up when stopCh is closed.
	go func() {
		<-bp.stopCh
		cancelFrames()
		cancelNav()
		_ = proto.PageStopScreencast{}.Call(bp.page)
	}()
}

// stopScreencast closes stopCh, causing the cleanup goroutine in startScreencast
// to cancel subscriptions and send Page.stopScreencast to Chromium.
// Safe to call only once; subsequent calls panic on close of closed channel.
// BrowserManager.ClosePage closes stopCh via this method.
func (bp *BrowserPage) stopScreencast() {
	close(bp.stopCh)
}
```

**Step 2: Verify**

```bash
go build ./...
```

Expected: zero errors.

**Step 3: Commit**

```bash
git add internal/sessiond/browser_screencast.go
git commit -m "feat: add BrowserPage screencast goroutine for JPEG frame streaming

Subscribes to Page.screencastFrame (JPEG q75 1280x720) and
Page.frameNavigated. ACKs every frame. Stops cleanly on stopCh close.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 7: Complete browser_manager.go — all methods

**Files:**
- Modify: `internal/sessiond/browser_manager.go`

The struct declarations from Task 3 stay. Add all methods below them.

**Step 1: Replace the entire file content with the complete version**

```go
// internal/sessiond/browser_manager.go
package sessiond

import (
	"context"
	"fmt"
	"sync"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

// BrowserManager manages all CDP browser pages for a single muxterm server.
// v1 allows at most one browser page (maxPages: 1). The underlying Chromium
// process is shared across all pages (one process, N tabs) and is started lazily
// on the first OpenPage call.
//
// BrowserManager is instantiated in the HTTP server layer (alongside TunnelRegistry)
// and injected into Hub so that /ws/browser WebSocket handlers can reach it.
type BrowserManager struct {
	mu            sync.Mutex
	chromium      *ChromiumManager
	browser       *rod.Browser
	pages         map[int]*BrowserPage
	maxPages      int             // v1: 1; remove check for multi-window
	broadcast     func(paneID int, data []byte) // sends JPEG frames to /ws/browser clients
	broadcastJSON func(msg any)                 // sends URL/error/progress JSON to /ws/browser
}

// BrowserPage manages one live Chromium tab.
// It owns the screencast goroutine and routes input to rod CDP calls.
type BrowserPage struct {
	paneID  int
	page    *rod.Page
	stopCh  chan struct{}
	manager *BrowserManager
}

// NewBrowserManager creates a BrowserManager with the given broadcast callbacks.
//
//	broadcast     — called with (paneID, jpegBytes) for each screencast frame
//	broadcastJSON — called with a BrowserURLMsg/BrowserErrorMsg/BrowserProgressMsg
//	                value to fan-out as JSON to all /ws/browser WebSocket clients
func NewBrowserManager(
	broadcast func(paneID int, data []byte),
	broadcastJSON func(msg any),
) *BrowserManager {
	return &BrowserManager{
		chromium:      NewChromiumManager(),
		pages:         make(map[int]*BrowserPage),
		maxPages:      1,
		broadcast:     broadcast,
		broadcastJSON: broadcastJSON,
	}
}

// OpenPage starts a new browser page for paneID. It lazily starts Chromium on the
// first call, then opens a blank tab, sets the viewport to 1280×720, and begins
// streaming JPEG frames via the broadcast callback.
//
// v1: returns an error if a browser page is already open (maxPages == 1).
func (bm *BrowserManager) OpenPage(paneID int) (*BrowserPage, error) {
	bm.mu.Lock()
	defer bm.mu.Unlock()

	if len(bm.pages) >= bm.maxPages {
		return nil, fmt.Errorf("browser: v1 limit reached (%d page(s) already open)", bm.maxPages)
	}

	// Lazy Chromium startup.
	if bm.browser == nil {
		b, err := bm.chromium.Ensure(context.Background(), func(pct int) {
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
			return nil, fmt.Errorf("browser: start chromium: %w", err)
		}
		bm.browser = b
	}

	// Open a blank tab.
	page, err := bm.browser.Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return nil, fmt.Errorf("browser: create page for pane %d: %w", paneID, err)
	}

	// Set default viewport.
	if err := page.SetViewport(&proto.EmulationSetDeviceMetricsOverride{
		Width:             1280,
		Height:            720,
		DeviceScaleFactor: 1,
	}); err != nil {
		_ = page.Close()
		return nil, fmt.Errorf("browser: set viewport for pane %d: %w", paneID, err)
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

// ClosePage stops the screencast, closes the Chromium tab, and removes the page
// from the manager. Safe to call with an unknown paneID (no-op).
func (bm *BrowserManager) ClosePage(paneID int) {
	bm.mu.Lock()
	bp, ok := bm.pages[paneID]
	if ok {
		delete(bm.pages, paneID)
	}
	bm.mu.Unlock()

	if bp != nil {
		bp.stopScreencast()
		_ = bp.page.Close()
	}
}

// GetPage returns the BrowserPage for paneID and whether it exists.
func (bm *BrowserManager) GetPage(paneID int) (*BrowserPage, bool) {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	bp, ok := bm.pages[paneID]
	return bp, ok
}

// Close stops all browser pages and kills the Chromium process.
// Called at server shutdown (context cancelled). Safe to call multiple times.
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
		_ = bp.page.Close()
	}
	if browser != nil {
		_ = browser.Close()
	}
}

// newBrowserCDPPane creates a minimal *Pane placeholder for a browser-cdp surface.
// This pane has no PTY, no buffer, and no process — it exists purely to give the
// daemon registry a pane ID to include in composition with surfaceKind:"browser-cdp".
func newBrowserCDPPane(localID int) *Pane {
	return &Pane{
		LocalID:     localID,
		Title:       "Browser",
		SurfaceKind: "browser-cdp",
	}
}
```

**Step 2: Verify**

```bash
go build ./...
```

Expected: zero errors.

**Step 3: Commit**

```bash
git add internal/sessiond/browser_manager.go
git commit -m "feat: complete BrowserManager with OpenPage/ClosePage/GetPage/Close

Lazy Chromium startup, v1 single-page limit, JPEG frame streaming via
broadcast callbacks, viewport init, clean shutdown. Also adds
newBrowserCDPPane() for daemon placeholder pane records.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 8: Daemon handler + client method + DaemonConn interface

This task wires the NEW `create-browser-pane` message through the entire sessiond stack: daemon handler → client method → DaemonConn interface. The daemon creates only a placeholder pane; actual Chromium management is in the HTTP server layer.

**Files:**
- Modify: `internal/sessiond/server.go`
- Modify: `internal/sessiond/client.go`
- Modify: `internal/server/daemon.go`

### Part A — `internal/sessiond/server.go`

In `conn.handle()`, add two new cases after `TypeGetLayout`:

```go
	case TypeCreateBrowserPane:
		c.createBrowserCDPPane(msg)
	case TypeCloseBrowserPane:
		c.closePane(msg) // reuse existing closePane: removes pane + broadcasts pane-closed
```

After `closeWorkspace()` function, add the new `createBrowserCDPPane` method:

```go
// createBrowserCDPPane allocates a pane ID and inserts a lightweight browser-cdp
// placeholder into the registry, then broadcasts a pane-added event with
// surfaceKind:"browser-cdp". No PTY, no buffer, no rod calls — the HTTP server
// layer manages the actual Chromium page.
func (c *conn) createBrowserCDPPane(msg Message) {
	wsID := c.attached
	if wsID == "" || !c.srv.reg.Has(wsID) {
		c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
		return
	}
	localID, ok := c.srv.reg.AllocPaneID(wsID)
	if !ok {
		c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
		return
	}
	p := newBrowserCDPPane(localID)
	c.srv.reg.PutPane(wsID, p)
	c.reply(&Message{Type: TypePaneCreated, CID: msg.CID, PaneID: localID})
	c.srv.broadcast(wsID, &Message{
		Type:            TypePaneAdded,
		WorkspaceID:     wsID,
		PaneID:          localID,
		SurfaceKind:     "browser-cdp",
		Title:           "Browser",
		ClientRef:       msg.ClientRef,
		Placement:       msg.Placement,
		ReferencePaneID: msg.ReferencePaneID,
	})
}
```

### Part B — `internal/sessiond/client.go`

Add the `CreateBrowserCDPPane` method. Place it after `CreateBrowserPane` (the existing proxy method, which is removed in Task 11). Insert this new method now:

```go
// CreateBrowserCDPPane asks the daemon to create a browser-cdp surface pane and
// returns the daemon-assigned workspace-local pane id. placement and referencePaneID
// control dockview positioning (pass "" and 0 for default tab placement).
//
// This differs from the removed CreateBrowserPane (proxy pane): no port or path are
// needed. The HTTP server's BrowserManager starts the actual Chromium page after
// receiving this reply.
func (c *Client) CreateBrowserCDPPane(placement string, referencePaneID int) (int, error) {
	reply, err := c.request(&Message{
		Type:            TypeCreateBrowserPane,
		Placement:       placement,
		ReferencePaneID: referencePaneID,
	})
	if err != nil {
		return 0, err
	}
	return reply.PaneID, nil
}
```

### Part C — `internal/server/daemon.go`

Add `CreateBrowserCDPPane` to the `DaemonConn` interface. Place it after `CreateBrowserPane` (the existing method, removed in Task 11):

```go
	// CreateBrowserCDPPane creates a browser-cdp surface pane in the attached workspace.
	// Returns the server-assigned workspace-local pane ID. The HTTP server layer starts
	// the actual Chromium page separately via BrowserManager.OpenPage(paneID).
	CreateBrowserCDPPane(placement string, referencePaneID int) (int, error)
```

**Step 1: Apply all three changes above**

**Step 2: Verify**

```bash
go build ./...
```

Expected: zero errors.

**Step 3: Commit**

```bash
git add internal/sessiond/server.go internal/sessiond/client.go internal/server/daemon.go
git commit -m "feat: wire create-browser-pane through daemon stack

- sessiond/server.go: createBrowserCDPPane handler (placeholder pane, surfaceKind:browser-cdp)
- sessiond/client.go: CreateBrowserCDPPane client method
- server/daemon.go: CreateBrowserCDPPane added to DaemonConn interface

Daemon just tracks the pane ID for composition. HTTP server manages
actual Chromium via BrowserManager.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 9: internal/server/ws_browser.go — /ws/browser WebSocket handler

This file defines the `BrowserWSConn` type (one connected `/ws/browser` client) and the `handleWSBrowserImpl` handler. It also adds the browser broadcast methods to `Hub`.

**Files:**
- Create: `internal/server/ws_browser.go`

**Step 1: Create the file**

```go
// internal/server/ws_browser.go
package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// browserWSConn is one connected /ws/browser WebSocket client.
// It receives binary JPEG frames and JSON URL/error/progress messages.
type browserWSConn struct {
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	writeMu sync.Mutex
}

// writeBinary sends a binary WebSocket frame, holding writeMu.
func (c *browserWSConn) writeBinary(data []byte) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	wctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	if err := c.conn.Write(wctx, websocket.MessageBinary, data); err != nil {
		log.Printf("ws/browser: writeBinary: %v", err)
	}
}

// writeText sends a text (JSON) WebSocket frame, holding writeMu.
func (c *browserWSConn) writeText(data []byte) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	wctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	if err := c.conn.Write(wctx, websocket.MessageText, data); err != nil {
		log.Printf("ws/browser: writeText: %v", err)
	}
}

// BroadcastBrowserFrame sends [4-byte LE paneId][JPEG bytes] to every connected
// /ws/browser client. Called by BrowserPage screencast goroutines. Non-blocking:
// frames are dropped for clients whose write buffers are full (latest-frame-wins
// semantics on the receiving end).
func (h *Hub) BroadcastBrowserFrame(paneID int, data []byte) {
	frame := EncodeBinaryFrame(uint32(paneID), data)
	h.browserMu.RLock()
	defer h.browserMu.RUnlock()
	for c := range h.browserClients {
		// Non-blocking attempt: skip the client if it is behind.
		// writeBinary uses a 5s timeout internally so this isn't truly non-blocking,
		// but the timeout prevents a slow client from stalling others.
		c.writeBinary(frame)
	}
}

// BroadcastBrowserJSON marshals msg to JSON and sends it as a text frame to every
// connected /ws/browser client. Used for browser-url, browser-error, and
// browser-download-progress messages.
func (h *Hub) BroadcastBrowserJSON(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("ws/browser: BroadcastBrowserJSON marshal: %v", err)
		return
	}
	h.browserMu.RLock()
	defer h.browserMu.RUnlock()
	for c := range h.browserClients {
		c.writeText(data)
	}
}

// handleWSBrowserImpl handles the /ws/browser WebSocket upgrade and client lifecycle.
// It:
//   - Registers the connection in hub.browserClients so it receives JPEG frame broadcasts.
//   - Reads JSON browser-input messages and routes them to BrowserPage.HandleInput.
//   - Cleans up on disconnect (deregisters from browserClients, cancels context).
func (s *Server) handleWSBrowserImpl(w http.ResponseWriter, r *http.Request) {
	// Auth: same policy as /ws.
	if !s.noAuth && !IsLocalhost(r) {
		token := r.URL.Query().Get("token")
		if !ValidateToken(token, s.secret, 30*time.Second) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(1 << 20) // 1 MB (input messages are small JSON)

	ctx, cancel := context.WithCancel(context.Background())
	c := &browserWSConn{conn: conn, ctx: ctx, cancel: cancel}

	// Register so frame broadcasts reach this client.
	s.hub.browserMu.Lock()
	s.hub.browserClients[c] = true
	s.hub.browserMu.Unlock()

	defer func() {
		s.hub.browserMu.Lock()
		delete(s.hub.browserClients, c)
		s.hub.browserMu.Unlock()
		cancel()
		conn.CloseNow()
	}()

	// Read loop: handle browser-input messages from the client.
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return // normal disconnect
		}
		var env struct {
			Type   string                   `json:"type"`
			PaneID int                      `json:"paneId"`
			Event  sessiond.BrowserInputMsg `json:"event"`
		}
		if err := json.Unmarshal(data, &env); err != nil {
			continue // skip malformed frames
		}
		if env.Type != sessiond.TypeBrowserInput {
			continue // only browser-input is expected client→server
		}
		if s.hub.browserManager == nil {
			continue
		}
		bp, ok := s.hub.browserManager.GetPage(env.PaneID)
		if !ok {
			continue // pane not open yet or already closed
		}
		if err := bp.HandleInput(env.Event); err != nil {
			log.Printf("ws/browser: HandleInput pane %d: %v", env.PaneID, err)
		}
	}
}
```

**Step 2: Verify**

```bash
go build ./...
```

Expected: build fails because `Hub.browserMu`, `Hub.browserClients`, and `Hub.browserManager` don't exist yet. These are added in Task 10.

> **Note:** This is the one task where the build is intentionally broken until the next task completes. Continue immediately to Task 10.

---

## Task 10: Wire everything together

This task completes the integration by adding `Hub` fields, registering the `/ws/browser` route, intercepting `TypeCreateBrowserPane` in `ws.go`, and creating the `BrowserManager` in `main.go`.

**Files:**
- Modify: `internal/server/ws.go` — Hub struct + TypeCreateBrowserPane handling
- Modify: `internal/server/server.go` — route + Config.BrowserManager
- Modify: `cmd/muxterm/main.go` — create BrowserManager in runLocal/runServe

### Part A — Add Hub fields (`internal/server/ws.go`)

In the `Hub` struct (currently in `ws.go`), add three fields after the `tunnels *TunnelRegistry` line:

```go
	browserManager *sessiond.BrowserManager // nil until set by SetBrowserManager
	browserClients map[*browserWSConn]bool   // /ws/browser WebSocket clients
	browserMu      sync.RWMutex              // guards browserClients
```

In `NewHub`, initialise the new map:

```go
func NewHub(dial DialFunc) *Hub {
	return &Hub{
		clients:        make(map[*Client]bool),
		dial:           dial,
		browserClients: make(map[*browserWSConn]bool),
	}
}
```

Add a `SetBrowserManager` method to Hub (place after `SetDialer`):

```go
// SetBrowserManager installs the BrowserManager that /ws/browser handlers use.
// Called once at server startup after the hub is constructed.
func (h *Hub) SetBrowserManager(bm *sessiond.BrowserManager) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.browserManager = bm
}
```

In `handleTextInput`, add cases for the new browser-cdp message types. Place them before the `default:` case (after the `TypeListTunnels` case):

```go
	case sessiond.TypeCreateBrowserPane:
		// Like tunnels: handled in the serve layer, not forwarded to daemon.
		paneID, err := c.daemon.CreateBrowserCDPPane(msg.Placement, msg.ReferencePaneID)
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		// Start the actual Chromium page in the HTTP server layer.
		if c.hub.browserManager != nil {
			if _, berr := c.hub.browserManager.OpenPage(paneID); berr != nil {
				log.Printf("handleTextInput: browserManager.OpenPage pane %d: %v", paneID, berr)
				// Don't fail the client: the daemon pane is created; browser will error separately.
			}
		}
		c.sendMessage(&sessiond.Message{
			Type:      sessiond.TypePaneCreated,
			CID:       msg.CID,
			PaneID:    paneID,
			ClientRef: msg.ClientRef,
		})

	case sessiond.TypeCloseBrowserPane:
		if c.hub.browserManager != nil {
			c.hub.browserManager.ClosePage(msg.PaneID)
		}
		if err := c.daemon.ClosePane(msg.PaneID); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})
```

Also update the `OnPaneAdded` handler inside `attachClient` to pass through `SurfaceKind` for browser-cdp panes — this already works because `SurfaceKind` is already in `pane.SurfaceKind` and the existing `OnPaneAdded` already copies `pane.SurfaceKind`. **No change needed** for composition.

### Part B — Register the /ws/browser route (`internal/server/server.go`)

In `New()`, after `s.mux.HandleFunc("GET /ws", s.handleWS)`, add:

```go
	s.mux.HandleFunc("GET /ws/browser", s.handleWSBrowser)
```

Add the handler method after `handleWS`:

```go
func (s *Server) handleWSBrowser(w http.ResponseWriter, r *http.Request) {
	s.handleWSBrowserImpl(w, r)
}
```

In `New()`, after `hub.tunnels = tunnels`, initialise the browser clients map (already done in `NewHub` above, but also ensure the config path):

```go
	// If the caller pre-created a BrowserManager, install it now.
	if cfg.BrowserManager != nil {
		hub.SetBrowserManager(cfg.BrowserManager)
	}
```

Add `BrowserManager` to `Config`:

```go
type Config struct {
	Addr          string
	Secret        string
	StaticFS      fs.FS
	NoAuth        bool
	ConfigPath    string
	InitialConfig muxcfg.Config
	BrowserManager *sessiond.BrowserManager // optional; nil disables /ws/browser CDP features
}
```

Add the import for `sessiond` at the top of `server.go` imports:

```go
	"github.com/kenotron-ms/muxterm/internal/sessiond"
```

### Part C — Create BrowserManager at startup (`cmd/muxterm/main.go`)

In `runLocal`, after `srv := server.New(...)`, add:

```go
	// Create and wire BrowserManager for CDP browser panes.
	bm := sessiond.NewBrowserManager(
		func(paneID int, data []byte) { srv.Hub().BroadcastBrowserFrame(paneID, data) },
		func(msg any) { srv.Hub().BroadcastBrowserJSON(msg) },
	)
	srv.Hub().SetBrowserManager(bm)
	go func() {
		<-ctx.Done()
		bm.Close()
	}()
```

Apply the same three lines to `runServe` as well (after `srv := server.New(...)`).

**Note:** The `ctx` variable already exists in both `runLocal` and `runServe` (from `signal.NotifyContext`). The goroutine keeps the BrowserManager alive until the signal fires.

**Step 1: Apply all changes in Parts A, B, C**

**Step 2: Verify**

```bash
go build ./...
```

Expected: zero errors. This completes the entire Go wiring.

**Step 3: Commit**

```bash
git add internal/server/ws.go internal/server/ws_browser.go internal/server/server.go cmd/muxterm/main.go
git commit -m "feat: wire /ws/browser endpoint and BrowserManager into server

- Hub: browserClients map, browserMu, SetBrowserManager, BroadcastBrowserFrame,
  BroadcastBrowserJSON
- ws.go: TypeCreateBrowserPane/TypeCloseBrowserPane interception (like tunnels)
- server.go: GET /ws/browser route, Config.BrowserManager field
- main.go: NewBrowserManager in runLocal/runServe, shutdown via ctx.Done

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 11: Remove old browser proxy code + fix test files

This is the cleanup task. Remove all the old iframe/port-proxy browser pane infrastructure. The build must be clean after every sub-step below; do all the sub-steps in one editing pass then do a single build verify at the end.

**Files modified:**
- `internal/sessiond/protocol.go`
- `internal/sessiond/pane.go`
- `internal/sessiond/registry.go`
- `internal/sessiond/layout.go`
- `internal/sessiond/client.go`
- `internal/sessiond/server.go`
- `internal/server/daemon.go`
- `internal/server/ws.go`
- `cmd/muxterm/cli.go`
- `cmd/muxterm/main.go`

**Test files to fix (do not delete):**
- `internal/sessiond/pane_test.go`
- `internal/sessiond/registry_test.go`
- `internal/sessiond/server_browser_test.go`
- `internal/server/ws_relay_test.go`

**Directory to delete:**
- `cmd/bridge-poc/` (entire directory)

---

### Step 1: `internal/sessiond/protocol.go` — remove proxy browser fields

In the `Message` struct, **remove** these three fields entirely (they were proxy-browser-only):

```go
	BrowserPort  int               `json:"browserPort,omitempty"`
	BrowserPath  string            `json:"browserPath,omitempty"`
	ProxyHeaders map[string]string `json:"proxyHeaders,omitempty"`
```

Also remove the comment line above them:
```go
	// Browser pane fields (used in create-pane and pane-added for browser surface kinds)
```

In the `PaneInfo` struct, **remove** these three fields:

```go
	// Browser-only fields (absent for terminal panes)
	BrowserPort  int               `json:"browserPort,omitempty"`
	BrowserPath  string            `json:"browserPath,omitempty"`
	ProxyHeaders map[string]string `json:"proxyHeaders,omitempty"`
```

Also remove the comment block above them.

Also remove `TypePaneUpdate` constant from the constants block (it was only used to update browser proxy paths):

```go
	TypePaneUpdate      = "pane-update" // request: client → daemon, updates browserPath after navigation
```

---

### Step 2: `internal/sessiond/pane.go` — remove proxy browser struct fields and methods

In the `Pane` struct, **remove**:
```go
	// SurfaceKind is "browser" for browser panes; empty string means "terminal".
	// Set once at construction; immutable thereafter.
	SurfaceKind string
	// Browser-only: the proxied port, stored path, and optional auth headers.
	// All immutable except BrowserPath, which SetBrowserPath() updates.
	BrowserPort  int
	BrowserPath  string
	ProxyHeaders map[string]string
```

Replace with just:
```go
	// SurfaceKind identifies the pane surface. "browser-cdp" for CDP browser panes;
	// empty string means "terminal". Set once at construction; immutable.
	SurfaceKind string
```

**Remove** the entire `NewBrowserPane` function (lines ~113-127 in current file).

**Remove** the entire `SetBrowserPath` method.

**Remove** from the `Info()` method the lines that copy proxy fields:
```go
	surfaceKind, browserPort, browserPath, proxyHeaders := p.SurfaceKind, p.BrowserPort, p.BrowserPath, p.ProxyHeaders
```

Replace with:
```go
	surfaceKind := p.SurfaceKind
```

In the returned `PaneInfo`, remove the proxy fields:
```go
	return PaneInfo{
		PaneID:      p.LocalID,
		Cols:        cols,
		Rows:        rows,
		Title:       title,
		SurfaceKind: surfaceKind,
	}
```

---

### Step 3: `internal/sessiond/registry.go` — remove UpdateBrowserPath

**Remove** the entire `UpdateBrowserPath` method (~15 lines).

---

### Step 4: `internal/sessiond/layout.go` — remove BrowserPath usage

In `renderGroup`, remove the `browserPath` field from `tabEntry`:
```go
	type tabEntry struct {
		label string
	}
```

Remove the lines that compute `bp` and populate `browserPath`:
```go
		bp := ""
		if ok && info.SurfaceKind == "browser" && viewStr == leaf.ActiveView {
			bp = info.BrowserPath
		}
		tabs = append(tabs, tabEntry{label: label, browserPath: bp})
```

Replace with:
```go
		tabs = append(tabs, tabEntry{label: label})
```

Remove the `contentHint` block entirely (it was only used to show BrowserPath). The ASCII layout box no longer has a content row:
```go
	// Remove these lines:
	contentHint := ""
	for _, t := range tabs {
		if t.browserPath != "" {
			contentHint = t.browserPath
			break
		}
	}
```

And remove:
```go
	if len(contentHint) > width {
		width = len(contentHint)
	}
```

And remove the content row from the box drawing:
```go
	if contentHint != "" {
		fmt.Fprintf(&sb, "├%s┤\n", bar)
		fmt.Fprintf(&sb, "│%-*s│\n", width, contentHint)
	}
```

---

### Step 5: `internal/sessiond/client.go` — remove CreateBrowserPane proxy method

**Remove** the entire `CreateBrowserPane` method (the old proxy one that takes `port int, path string, headers map[string]string`). The new `CreateBrowserCDPPane` added in Task 8 remains.

**Remove** from `dispatchEvent` the `pane-added` handler lines that copy proxy fields:
```go
				BrowserPort:     msg.BrowserPort,
				BrowserPath:     msg.BrowserPath,
				ProxyHeaders:    msg.ProxyHeaders,
```

---

### Step 6: `internal/sessiond/server.go` — remove old "browser" SurfaceKind handling

In `createPane`, remove the entire old browser branch:
```go
	if msg.SurfaceKind == "browser" {
		if msg.BrowserPort < 1 || msg.BrowserPort > 65535 {
			c.replyError(msg.CID, "invalid-port", "browserPort must be 1–65535")
			return
		}
		p := NewBrowserPane(localID, msg.BrowserPort, msg.BrowserPath, msg.ProxyHeaders)
		c.srv.reg.PutPane(wsID, p)
		c.reply(&Message{Type: TypePaneCreated, CID: msg.CID, PaneID: localID})
		c.srv.broadcast(wsID, &Message{
			Type:            TypePaneAdded,
			WorkspaceID:     wsID,
			PaneID:          localID,
			SurfaceKind:     "browser",
			BrowserPort:     msg.BrowserPort,
			BrowserPath:     msg.BrowserPath,
			Title:           p.Title,
			ClientRef:       msg.ClientRef,
			Placement:       msg.Placement,
			ReferencePaneID: msg.ReferencePaneID,
		})
		return
	}
```

Remove the `TypePaneUpdate` case from `handle()`:
```go
	case TypePaneUpdate:
		if c.attached != "" {
			// Silently no-op for unknown pane IDs (design intent).
			c.srv.reg.UpdateBrowserPath(c.attached, msg.PaneID, msg.BrowserPath)
		}
```

Remove the `TypeBrowserAction` relay case from `handle()`:
```go
	case TypeBrowserAction:
		if c.attached == "" {
			c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
			return
		}
		msg.CID = 0
		c.srv.broadcast(c.attached, &msg)
```

Remove the `TypeBrowserActionResult` relay case from `handle()`:
```go
	case TypeBrowserActionResult:
		if c.attached == "" {
			c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
			return
		}
		msg.CID = 0 // event fan-out; MCP client correlates by its own pending request
		c.srv.broadcast(c.attached, &msg)
```

> **Do NOT** remove the constants `TypeBrowserAction`/`TypeBrowserActionResult` from `protocol.go`. They are still referenced in `client.go`'s `dispatchEvent` and will be cleaned up in Phase 3 when the MCP relay layer is replaced. Removing them now would break the build.
>
> **Do NOT** remove any MCP relay fields (`Action`, `Ref`, `Selector`, `Value`, `Key`, `Expression`, `Snapshot`, `Result`, `OK`) from the `Message` struct. Phase 3 cleans those up.

---

### Step 7: `internal/server/daemon.go` — remove proxy method from interface

**Remove** `CreateBrowserPane` from `DaemonConn`:
```go
	// CreateBrowserPane creates a browser pane in the attached workspace.
	CreateBrowserPane(port int, path string, headers map[string]string, placement string, referencePaneID int) (int, error)
```

---

### Step 8: `internal/server/ws.go` — remove proxy browser handling

In `handleTextInput`, remove the `TypeCreatePane` browser routing:
```go
	case sessiond.TypeCreatePane:
		var (
			paneID int
			err    error
		)
		if msg.SurfaceKind == "browser" {
			paneID, err = c.daemon.CreateBrowserPane(msg.BrowserPort, msg.BrowserPath, msg.ProxyHeaders, msg.Placement, msg.ReferencePaneID)
		} else {
			paneID, err = c.daemon.CreatePane(msg.Cmd, msg.Placement, msg.ReferencePaneID)
		}
```

Replace with:
```go
	case sessiond.TypeCreatePane:
		paneID, err := c.daemon.CreatePane(msg.Cmd, msg.Placement, msg.ReferencePaneID)
```

In `attachClient`'s `OnPaneAdded` handler, remove the proxy fields from the outgoing message:
```go
			c.sendMessage(&sessiond.Message{
				Type:            sessiond.TypePaneAdded,
				PaneID:          pane.PaneID,
				Cols:            pane.Cols,
				Rows:            pane.Rows,
				Title:           pane.Title,
				SurfaceKind:     pane.SurfaceKind,
				Placement:       pane.Placement,
				ReferencePaneID: pane.ReferencePaneID,
			})
```

(Remove `BrowserPort`, `BrowserPath`, `ProxyHeaders` from this message — they're no longer in `PaneInfo`.)

Remove the `TypeBrowserActionResult` case from `handleTextInput`:
```go
	case sessiond.TypeBrowserActionResult:
		// Fire-and-forget: the daemon broadcasts it to all workspace subscribers.
		if err := c.daemon.BrowserActionResult(msg); err != nil {
			log.Printf("handleTextInput: BrowserActionResult error: %v", err)
		}
```

---

### Step 9: `cmd/muxterm/cli.go` — remove BrowserPort

In `Config` struct, remove:
```go
	BrowserPort int    // open-browser mode only: the port to open as a browser pane
```

Remove the `parseOpenBrowser` function entirely.

Remove the `open-browser` case from `ParseArgs`:
```go
	case "open-browser":
		return parseOpenBrowser(args[1:])
```

---

### Step 10: `cmd/muxterm/main.go` — remove runOpenBrowser

Remove the `runOpenBrowser` function entirely.

Remove from `main()`:
```go
	case "open-browser":
		if err := runOpenBrowser(cfg); err != nil {
```

---

### Step 10b: `internal/mcp/tools_layout.go` — update browser pane handling

This file references `CreateBrowserPane` and `PaneInfo.BrowserPath`. Both are being removed.

**In the `createPane` function (around line 51–61), replace the `"browser"` case:**

```go
		case "browser":
			port, err := argInt(args, "browser_port")
			if err != nil {
				return "", err
			}
			url, _ := args["url"].(string)
			id, err := lt.c.conn.CreateBrowserPane(port, url, nil, placement, referencePaneID)
			if err != nil {
				return "", fmt.Errorf("creating browser pane: %w", err)
			}
			paneID = id
```

**With:**

```go
		case "browser":
			// CDP browser pane: no port or URL needed at creation time.
			// The browser navigates after the pane is open via BrowserManager.
			id, err := lt.c.conn.CreateBrowserCDPPane(placement, referencePaneID)
			if err != nil {
				return "", fmt.Errorf("creating browser pane: %w", err)
			}
			paneID = id
```

**In the `listPanes` function (around line 136–138), remove the `BrowserPath` hint:**

```go
			if kind == "browser" {
				item["hint"] = p.BrowserPath
			}
```

Remove these three lines entirely. The `PaneInfo.BrowserPath` field no longer exists. Browser-cdp panes will show `kind: "browser-cdp"` (their `SurfaceKind`) which is sufficient for the MCP client to identify them.

### Step 11: Delete `cmd/bridge-poc/`

```bash
rm -rf /Users/ken/workspace/ms/muxterm/cmd/bridge-poc
```

---

### Step 12: Fix `internal/sessiond/pane_test.go`

The four `TestNewBrowserPane_*` functions and `TestNewBrowserPane_SetBrowserPath` test the now-deleted `NewBrowserPane` factory. Replace them with tests for the new `newBrowserCDPPane` helper.

**Replace** the entire block of `TestNewBrowserPane_*` functions with:

```go
func TestNewBrowserCDPPane_SurfaceKind(t *testing.T) {
	p := newBrowserCDPPane(7)
	if p.SurfaceKind != "browser-cdp" {
		t.Fatalf("SurfaceKind = %q, want \"browser-cdp\"", p.SurfaceKind)
	}
	if p.LocalID != 7 {
		t.Fatalf("LocalID = %d, want 7", p.LocalID)
	}
}

func TestNewBrowserCDPPane_NilBuf(t *testing.T) {
	p := newBrowserCDPPane(3)
	if p.buf != nil {
		t.Fatal("browser-cdp pane should have nil buf (no scrollback)")
	}
	if p.ptmx != nil {
		t.Fatal("browser-cdp pane should have nil ptmx (no PTY)")
	}
}

func TestNewBrowserCDPPane_Info(t *testing.T) {
	p := newBrowserCDPPane(5)
	info := p.Info()
	if info.SurfaceKind != "browser-cdp" {
		t.Fatalf("Info().SurfaceKind = %q, want \"browser-cdp\"", info.SurfaceKind)
	}
	if info.PaneID != 5 {
		t.Fatalf("Info().PaneID = %d, want 5", info.PaneID)
	}
}
```

---

### Step 13: Fix `internal/sessiond/registry_test.go`

The three `TestRegistry_UpdateBrowserPath*` functions and `TestRegistry_BrowserPane_Info` test the deleted `UpdateBrowserPath` method and `NewBrowserPane` factory.

**Replace** all four test functions with tests verifying the registry handles browser-cdp panes correctly:

```go
// TestRegistry_BrowserCDPPane_PutAndGet verifies that a browser-cdp placeholder pane
// inserted via newBrowserCDPPane survives PutPane/Pane and exposes the correct fields.
func TestRegistry_BrowserCDPPane_PutAndGet(t *testing.T) {
	r := NewRegistry()
	wsID := r.AddWorkspace("", "")
	localID, _ := r.AllocPaneID(wsID)

	p := newBrowserCDPPane(localID)
	r.PutPane(wsID, p)

	got, ok := r.Pane(wsID, localID)
	if !ok {
		t.Fatalf("Pane(%q, %d) not found after PutPane", wsID, localID)
	}
	info := got.Info()
	if info.SurfaceKind != "browser-cdp" {
		t.Fatalf("SurfaceKind = %q, want \"browser-cdp\"", info.SurfaceKind)
	}
}

// TestRegistry_BrowserCDPPane_Replay verifies that a browser-cdp pane returns nil
// from Replay (no scrollback buffer).
func TestRegistry_BrowserCDPPane_Replay(t *testing.T) {
	r := NewRegistry()
	wsID := r.AddWorkspace("", "")
	localID, _ := r.AllocPaneID(wsID)
	r.PutPane(wsID, newBrowserCDPPane(localID))

	p, _ := r.Pane(wsID, localID)
	if data := p.Replay(); data != nil {
		t.Fatalf("Replay() = %v, want nil for browser-cdp pane", data)
	}
}

// TestRegistry_BrowserCDPPane_RemovePane verifies RemovePane works for browser-cdp panes.
func TestRegistry_BrowserCDPPane_RemovePane(t *testing.T) {
	r := NewRegistry()
	wsID := r.AddWorkspace("", "")
	localID, _ := r.AllocPaneID(wsID)
	r.PutPane(wsID, newBrowserCDPPane(localID))

	removed, remaining, ok := r.RemovePane(wsID, localID)
	if !ok {
		t.Fatal("RemovePane returned false, want true")
	}
	if removed == nil {
		t.Fatal("RemovePane returned nil pane")
	}
	if remaining != 0 {
		t.Fatalf("remaining = %d, want 0", remaining)
	}
}
```

---

### Step 14: Fix `internal/sessiond/server_browser_test.go`

These tests use the old `TypeCreatePane` with `SurfaceKind:"browser"` and reference `BrowserPort`/`BrowserPath`. Update them to use the new `TypeCreateBrowserPane` and check for `SurfaceKind:"browser-cdp"`.

**Replace the entire file content with:**

```go
package sessiond

import (
	"testing"
)

// TestCreateBrowserCDPPane_SucceedsAndBroadcasts verifies the full lifecycle of
// creating a browser-cdp pane: the actor gets a pane-created ACK with a positive
// pane id, a pane-added broadcast carries surfaceKind "browser-cdp", and a second
// observer client also receives the pane-added broadcast.
func TestCreateBrowserCDPPane_SucceedsAndBroadcasts(t *testing.T) {
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

	// A sends a create-browser-pane (CDP, no port/path needed).
	a.send(&Message{
		Type: TypeCreateBrowserPane,
		CID:  3,
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

	// A receives the pane-added broadcast with surfaceKind "browser-cdp".
	addedA := a.waitCtrl(TypePaneAdded)
	if addedA.PaneID != paneID {
		t.Fatalf("A pane-added PaneID = %d, want %d", addedA.PaneID, paneID)
	}
	if addedA.SurfaceKind != "browser-cdp" {
		t.Fatalf("A pane-added SurfaceKind = %q, want \"browser-cdp\"", addedA.SurfaceKind)
	}

	// B also receives the pane-added broadcast.
	addedB := b.waitCtrl(TypePaneAdded)
	if addedB.PaneID != paneID {
		t.Fatalf("B pane-added PaneID = %d, want %d", addedB.PaneID, paneID)
	}
	if addedB.SurfaceKind != "browser-cdp" {
		t.Fatalf("B pane-added SurfaceKind = %q, want \"browser-cdp\"", addedB.SurfaceKind)
	}

	_ = srv
}

// TestCreateBrowserCDPPane_ClosesCleanly verifies that close-browser-pane removes
// the pane and broadcasts pane-closed.
func TestCreateBrowserCDPPane_ClosesCleanly(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	a.send(&Message{Type: TypeCreateBrowserPane, CID: 2})
	created := a.waitCtrl(TypePaneCreated)
	paneID := created.PaneID
	a.waitCtrl(TypePaneAdded)

	// Close the pane using the regular close-pane message (TypeCloseBrowserPane
	// delegates to closePane which is already tested).
	a.send(&Message{Type: TypeClosePane, CID: 3, PaneID: paneID})
	a.waitCtrl(TypeOK)
	closed := a.waitCtrl(TypePaneClosed)
	if closed.PaneID != paneID {
		t.Fatalf("pane-closed PaneID = %d, want %d", closed.PaneID, paneID)
	}

	_ = srv
}

// TestComposition_IncludesBrowserCDPPane verifies that a fresh attach after
// creating a browser-cdp pane includes it in the composition with surfaceKind
// "browser-cdp" and no port/path fields.
func TestComposition_IncludesBrowserCDPPane(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	a.send(&Message{Type: TypeCreateBrowserPane, CID: 2})
	a.waitCtrl(TypePaneCreated)
	a.waitCtrl(TypePaneAdded)

	// A fresh client attaches and should see the browser-cdp pane in composition.
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeAttach, CID: 10, WorkspaceID: wsID})
	comp := b.waitCtrl(TypeComposition)

	if len(comp.Panes) != 1 {
		t.Fatalf("composition Panes = %d, want 1", len(comp.Panes))
	}
	p := comp.Panes[0]
	if p.SurfaceKind != "browser-cdp" {
		t.Fatalf("composition Pane SurfaceKind = %q, want \"browser-cdp\"", p.SurfaceKind)
	}
	_ = srv
}
```

---

### Step 15: Fix `internal/server/daemon_test.go`

`fakeDaemonConn` has a `CreateBrowserPane` method that's being removed from `DaemonConn`. Replace it with `CreateBrowserCDPPane` to satisfy the updated interface.

**In `daemon_test.go`, replace:**

```go
func (f *fakeDaemonConn) CreateBrowserPane(port int, path string, headers map[string]string, placement string, referencePaneID int) (int, error) {
	return f.createdID, nil
}
```

**With:**

```go
func (f *fakeDaemonConn) CreateBrowserCDPPane(placement string, referencePaneID int) (int, error) {
	return f.createdID, nil
}
```

Also remove `BrowserActionResult` if it's no longer in the `DaemonConn` interface (check if it was removed in Step 7 above). If `BrowserActionResult` was kept in the interface, leave the method.

### Step 16: Fix `internal/server/ws_relay_test.go`

This file has `trackingDaemonConn` and three test functions that reference the removed proxy browser fields.

**Part A: Update `trackingDaemonConn` struct — replace:**

```go
type trackingDaemonConn struct {
	fakeDaemonConn
	createPaneCalled        bool
	createBrowserPaneCalled bool
	browserPort             int
	browserPath             string
	browserHeaders          map[string]string
}
```

**With:**

```go
type trackingDaemonConn struct {
	fakeDaemonConn
	createPaneCalled           bool
	createBrowserCDPPaneCalled bool
}
```

**Part B: Update `trackingDaemonConn` methods — replace:**

```go
func (f *trackingDaemonConn) CreatePane(cmd []string, placement string, referencePaneID int) (int, error) {
	f.createPaneCalled = true
	return f.createdID, nil
}

func (f *trackingDaemonConn) CreateBrowserPane(port int, path string, headers map[string]string, placement string, referencePaneID int) (int, error) {
	f.createBrowserPaneCalled = true
	f.browserPort = port
	f.browserPath = path
	f.browserHeaders = headers
	return f.createdID, nil
}
```

**With:**

```go
func (f *trackingDaemonConn) CreatePane(cmd []string, placement string, referencePaneID int) (int, error) {
	f.createPaneCalled = true
	return f.createdID, nil
}

func (f *trackingDaemonConn) CreateBrowserCDPPane(placement string, referencePaneID int) (int, error) {
	f.createBrowserCDPPaneCalled = true
	return f.createdID, nil
}
```

**Part C: Update `TestAttachClient_OnPaneAdded_RelaysBrowserFields` — replace the trigger call and assertions:**

Replace:
```go
	// Trigger the OnPaneAdded handler with browser-specific fields.
	fake.handlers.OnPaneAdded(sessiond.PaneInfo{
		PaneID:       5,
		Cols:         120,
		Rows:         30,
		Title:        "DevTools",
		SurfaceKind:  "browser",
		BrowserPort:  4000,
		BrowserPath:  "/debug",
		ProxyHeaders: map[string]string{"X-Token": "abc"},
	})

	if captured == nil {
		t.Fatal("no message sent to WS client after OnPaneAdded")
	}
	var msg sessiond.Message
	if err := json.Unmarshal(captured, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if msg.Type != sessiond.TypePaneAdded {
		t.Errorf("Type = %q, want %q", msg.Type, sessiond.TypePaneAdded)
	}
	if msg.SurfaceKind != "browser" {
		t.Errorf("SurfaceKind = %q, want %q", msg.SurfaceKind, "browser")
	}
	if msg.BrowserPort != 4000 {
		t.Errorf("BrowserPort = %d, want 4000", msg.BrowserPort)
	}
	if msg.BrowserPath != "/debug" {
		t.Errorf("BrowserPath = %q, want %q", msg.BrowserPath, "/debug")
	}
	if msg.ProxyHeaders["X-Token"] != "abc" {
		t.Errorf("ProxyHeaders[X-Token] = %q, want %q", msg.ProxyHeaders["X-Token"], "abc")
	}
```

With:
```go
	// Trigger the OnPaneAdded handler for a browser-cdp pane (no port/path needed).
	fake.handlers.OnPaneAdded(sessiond.PaneInfo{
		PaneID:      5,
		Cols:        120,
		Rows:        30,
		Title:       "Browser",
		SurfaceKind: "browser-cdp",
	})

	if captured == nil {
		t.Fatal("no message sent to WS client after OnPaneAdded")
	}
	var msg sessiond.Message
	if err := json.Unmarshal(captured, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if msg.Type != sessiond.TypePaneAdded {
		t.Errorf("Type = %q, want %q", msg.Type, sessiond.TypePaneAdded)
	}
	if msg.SurfaceKind != "browser-cdp" {
		t.Errorf("SurfaceKind = %q, want %q", msg.SurfaceKind, "browser-cdp")
	}
	if msg.PaneID != 5 {
		t.Errorf("PaneID = %d, want 5", msg.PaneID)
	}
```

Also rename the test function from `TestAttachClient_OnPaneAdded_RelaysBrowserFields` to `TestAttachClient_OnPaneAdded_RelaysBrowserCDPSurfaceKind` and update the comment to match.

**Part D: Replace `TestHandleTextInput_TypeCreatePane_BrowserSurfaceKind` entirely:**

This test verified that `TypeCreatePane` with `SurfaceKind:"browser"` routed to `CreateBrowserPane`. That path is gone. Replace it with a test that verifies `TypeCreateBrowserPane` causes `CreateBrowserCDPPane` to be called (i.e., the new routing works):

```go
// TestHandleTextInput_TypeCreateBrowserPane_CallsCreateBrowserCDPPane verifies that a
// TypeCreateBrowserPane message causes CreateBrowserCDPPane (not CreatePane) to be
// called on the daemon connection.
func TestHandleTextInput_TypeCreateBrowserPane_CallsCreateBrowserCDPPane(t *testing.T) {
	fake := &trackingDaemonConn{fakeDaemonConn: fakeDaemonConn{createdID: 10}}
	h := NewHub(nil)
	h.browserClients = make(map[*browserWSConn]bool)

	var sentMessages [][]byte
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c := &Client{
		hub:    h,
		ctx:    ctx,
		cancel: cancel,
		daemon: fake,
	}
	c.writeTextFn = func(data []byte) error {
		sentMessages = append(sentMessages, data)
		return nil
	}
	c.writeBinaryFn = func(data []byte) error { return nil }

	// Send TypeCreateBrowserPane (new CDP browser pane message).
	msg := sessiond.Message{
		Type: sessiond.TypeCreateBrowserPane,
		CID:  99,
	}
	data, _ := json.Marshal(msg)
	c.handleTextInput(data)

	if !fake.createBrowserCDPPaneCalled {
		t.Fatal("expected CreateBrowserCDPPane to be called for TypeCreateBrowserPane, but it was not")
	}
	if fake.createPaneCalled {
		t.Fatal("CreatePane should not be called for TypeCreateBrowserPane")
	}
}
```

**Part E: Update `TestHandleTextInput_TypeCreatePane_TerminalSurfaceKind`:**

This test uses `trackingDaemonConn` but only checks that `createPaneCalled` is true and `createBrowserPaneCalled` is false. Update the second assertion to use the new field name:

Replace:
```go
	if fake.createBrowserPaneCalled {
		t.Fatal("CreateBrowserPane should not be called when SurfaceKind is empty")
	}
```

With:
```go
	if fake.createBrowserCDPPaneCalled {
		t.Fatal("CreateBrowserCDPPane should not be called for TypeCreatePane")
	}
```

---

### Step 17: Fix `internal/sessiond/layout_test.go`

Line 14 has a PaneInfo fixture with `BrowserPath: "/"`:

```go
		{PaneID: 3, SurfaceKind: "browser", Title: "browser", BrowserPath: "/"},
```

**Replace with:**
```go
		{PaneID: 3, SurfaceKind: "browser-cdp", Title: "Browser"},
```

The layout test verifies ASCII box rendering from pane fixtures — removing `BrowserPath` (no longer in `PaneInfo`) and updating the surfaceKind to "browser-cdp" keeps the test accurate.

---

### Step 18: Fix `internal/sessiond/client_test.go`

There is a test (around lines 432–477) that constructs a `pane-added` control frame with `BrowserPort`, `BrowserPath`, and `ProxyHeaders` on the `Message` struct and asserts those fields appear in the `OnPaneAdded` callback's `PaneInfo`. After removing those fields from both `Message` and `PaneInfo`, this test will fail to compile.

**Replace** the browser-field assertions with a surfaceKind check:

Find the section that sends a `TypePaneAdded` Message with `BrowserPort`/`BrowserPath`/`ProxyHeaders` and replace it to use `SurfaceKind: "browser-cdp"` only:

The control frame's `Message` fields should only set `SurfaceKind: "browser-cdp"` (no BrowserPort/BrowserPath/ProxyHeaders). The assertions should check `pane.SurfaceKind == "browser-cdp"` and remove `pane.BrowserPort`, `pane.BrowserPath`, `pane.ProxyHeaders` assertions.

Read the full test function context and update only the removed fields. The test name and structure (testing that pane-added fields propagate through `dispatchEvent` → `OnPaneAdded`) remain.

---

### Step 19: Fix `cmd/muxterm/cli_test.go`

This file has tests for `ParseArgs([]string{"open-browser", ...})`. Since `open-browser` mode and `BrowserPort` field are removed, these tests need to be updated.

**Replace** the open-browser tests with tests that verify `open-browser` is now an unknown command (returns an error):

Find functions like `TestParseArgs_OpenBrowser_*` and replace their bodies:

```go
// TestParseArgs_OpenBrowser_NowUnknown verifies that the removed open-browser command
// returns an error instead of silently succeeding.
func TestParseArgs_OpenBrowser_NowUnknown(t *testing.T) {
	_, err := ParseArgs([]string{"open-browser", "5173"})
	if err == nil {
		t.Fatal("expected error for removed 'open-browser' command, got nil")
	}
}
```

Keep one consolidated test; the rest of the open-browser test functions can be collapsed or replaced with this single check.

---

### Step 20: Fix `cmd/muxterm/main_test.go`

This file has tests for `runOpenBrowser` function which is being removed. These tests all call `runOpenBrowser(cfg)` and check its behavior.

Since `runOpenBrowser` is removed from `main.go`, ALL these test functions must be updated. The simplest fix: replace each test function body with `t.Skip("open-browser mode removed in browser-cdp refactor")`.

For example, replace:

```go
func TestRunOpenBrowser_NoServer(t *testing.T) {
	// ... compile-time check, runOpenBrowser calls ...
}
```

With:

```go
func TestRunOpenBrowser_NoServer(t *testing.T) {
	t.Skip("open-browser mode removed: browser panes now use CDP (see TypeCreateBrowserPane)")
}
```

Apply `t.Skip(...)` to ALL `TestRunOpenBrowser_*` functions in `main_test.go`. Do not delete the test functions (AGENTS.md: do not delete test files).

---

### Step 16: Final build verify

```bash
go build ./...
```

Expected: **zero errors**. If there are remaining references to removed fields, use `grep -r "BrowserPort\|BrowserPath\|ProxyHeaders\|NewBrowserPane\|UpdateBrowserPath\|CreateBrowserPane\b" --include="*.go" .` to find them and apply the same removal pattern.

**Step 17: Commit the entire cleanup**

```bash
git add -A
git commit -m "feat: remove old browser proxy layer; replace with browser-cdp infrastructure

Removes iframe/port-proxy browser pane (BrowserPort, BrowserPath,
ProxyHeaders from all wire types; NewBrowserPane; UpdateBrowserPath;
TypeBrowserAction/Result; cmd/bridge-poc/).

Adds newBrowserCDPPane for daemon placeholder panes. Updates all test
files to match new behavior (no new tests added per AGENTS.md).

surfaceKind 'browser' is gone. surfaceKind 'browser-cdp' is live.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Final verification

After all 11 tasks are committed:

```bash
go build ./...
```

Expected: zero errors, no warnings.

Spot-check that the key symbols exist:

```bash
grep -r "TypeCreateBrowserPane\|TypeCloseBrowserPane\|BrowserManager\|ws/browser" --include="*.go" . | grep -v "_test.go" | wc -l
```

Expected: at least 20 matches (constants, struct, handler, route).

Spot-check that old symbols are gone:

```bash
grep -r "BrowserPort\|BrowserPath\|NewBrowserPane\|UpdateBrowserPath\|bridge-poc\|surfaceKind.*\"browser\"" --include="*.go" . 2>/dev/null | grep -v "_test.go"
```

Expected: **zero matches** (all old proxy infrastructure removed from production code).

---

## Architecture decision record

**Why BrowserManager is in the HTTP server layer, not the daemon subprocess:**

The muxterm daemon (`muxterm sessiond`) runs as a separate process communicating over a Unix socket. JPEG frames must not travel through that socket — they would congest the ordered TCP-like stream and delay terminal keystrokes. By instantiating `BrowserManager` in the HTTP server process (alongside `TunnelRegistry`), JPEG frames flow directly from rod's CDP event callbacks to WebSocket write calls with no intermediate serialization or queueing.

The daemon still participates: `TypeCreateBrowserPane` causes the daemon to allocate a pane ID and add a `surfaceKind:"browser-cdp"` placeholder to the composition, so reconnecting clients see the browser pane. The HTTP server then starts the actual Chromium page for that pane ID.

This follows the same pattern as `TunnelRegistry`: tunnel operations are intercepted by the HTTP server (never forwarded to daemon), while the daemon tracks no tunnel state.
