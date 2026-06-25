# Browser Session Architecture — Phase 2: Focus-Driven Viewport & Letterbox Rendering

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Replace `browser-ready` with `browser-focus` unified signal, add focus-driven viewport sizing, JS letterbox rendering with letterbox-aware coordinate mapping, and last-focus-wins input authority.

**Architecture:** `BrowserManager` gains authority tracking (paneID → clientID map). `BrowserPage.HandleInput` adds `browser-focus` and `browser-blur` cases: focus sets viewport via CDP, sets authority, takes a screenshot, and restarts screencast; blur clears authority. The frontend replaces `browser-ready` with `browser-focus` (carrying `clientId`, `deviceId`, `renderWidth`, `renderHeight`). A `ResizeObserver` sets the canvas pixel buffer to the CSS container size; letterbox math centers the JPEG frame maintaining aspect ratio; `_toViewport` maps mouse offsets through the letterbox transform and rejects clicks in the black bars. Input authority is communicated back to all clients via `browser-granted` JSON.

**Tech Stack:** Go 1.24, TypeScript 5, Lit 3, Canvas 2D API, Chrome DevTools Protocol (CDP), dockview-core

**Design Document:** `docs/designs/2026-06-20-browser-session-architecture-design.md`

---

## Prerequisites

**Phase 1 must be complete before starting Phase 2.** Phase 2 assumes:
- `BrowserManager` is owned and instantiated by sessiond (not the HTTP server)
- `browser-focus` and `browser-blur` message types route from `/ws/browser` → daemon socket → `BrowserPage.HandleInput()`
- `BrowserInputMsg` already has `ClientID` and `DeviceID` fields added in Phase 1 (check — if not, they are added here in Task 3)

If Phase 1 is not complete, stop. Do not work around it.

---

## Code Reference

Before coding each task, confirm the current state by reading the relevant file. These were the exact shapes at plan-write time:

| File | Key type/func |
|------|---------------|
| `internal/sessiond/browser_manager.go` | `BrowserManager` struct (mu, pages, broadcast, broadcastJSON); `BrowserPage` (paneID, sessionID, cdp, manager, cancel) |
| `internal/sessiond/browser_input.go` | `BrowserPage.HandleInput(ctx, BrowserInputMsg)` — switch on msg.Type; has `browser-ready` case |
| `internal/sessiond/browser_screencast.go` | `startScreencast`, `captureScreenshot` on `BrowserPage` |
| `internal/sessiond/protocol.go` | `BrowserInputMsg` struct; `TypeBrowserInput` constant |
| `web/src/lib/ws-browser.ts` | `BrowserSocket` class; `send()` method; `onFrame`, `onBrowserUrl`, `onBrowserCursor`, etc. callbacks |
| `web/src/lib/browser-registry.ts` | `BrowserPaneCallbacks` interface; `browserRegistry` singleton |
| `web/src/components/mux-browser-pane.ts` | `MuxBrowserPane` LitElement; `firstUpdated`, `_flushFrame`, `_toViewport` |
| `web/src/components/mux-dock.ts` | `onDidActivePanelChange` at line ~642; `BrowserRenderer` at line ~107 |
| `web/src/app.ts` | `wsBrowser.onXxx` wiring in `connectedCallback` |

---

## Task 1: Add focus authority tracking to BrowserManager

**Files:**
- Modify: `internal/sessiond/browser_manager.go`

### Step 1: Read the file

```bash
cat -n internal/sessiond/browser_manager.go | head -30
```

Confirm `BrowserManager` struct ends around line 27 and has no `authorityMu` or `authorityID` fields.

### Step 2: Add authority fields and methods

After the closing brace of `BrowserManager` struct definition, add a new `authorityMu` and `authorityID` field. Then add three methods at the **bottom** of the file (before the final `newBrowserCDPPane` function):

```go
// SetAuthority records clientID as the input authority for paneID.
// Last-focus-wins: replaces any prior authority unconditionally.
func (bm *BrowserManager) SetAuthority(paneID int, clientID string) {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	if bm.authorityID == nil {
		bm.authorityID = make(map[int]string)
	}
	bm.authorityID[paneID] = clientID
}

// ClearAuthority removes clientID as the input authority for paneID.
// No-op if clientID is not the current authority (guards races on blur).
func (bm *BrowserManager) ClearAuthority(paneID int, clientID string) {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	if bm.authorityID[paneID] == clientID {
		delete(bm.authorityID, paneID)
	}
}

// IsAuthority returns true if clientID is the current input authority for paneID.
// Empty clientID never matches (no authority).
func (bm *BrowserManager) IsAuthority(paneID int, clientID string) bool {
	if clientID == "" {
		return false
	}
	bm.mu.Lock()
	defer bm.mu.Unlock()
	return bm.authorityID[paneID] == clientID
}
```

Add `authorityID map[int]string` as a new field inside the `BrowserManager` struct. The struct now looks like:

```go
type BrowserManager struct {
	mu            sync.Mutex
	chromiumCmd   *exec.Cmd
	cdp           *CDPConn
	pages         map[int]*BrowserPage
	maxPages      int
	authorityID   map[int]string              // paneID → current input authority clientID
	broadcast     func(paneID int, data []byte)
	broadcastJSON func(msg any)
}
```

### Step 3: Verify compilation

```bash
go build ./...
```

Expected: clean, 0 errors.

### Step 4: Commit

```bash
git add internal/sessiond/browser_manager.go
git commit -m "feat(browser): add focus authority tracking to BrowserManager

SetAuthority/ClearAuthority/IsAuthority on BrowserManager.
Last-focus-wins: SetAuthority replaces previous authority unconditionally.
ClearAuthority is a no-op if clientID is not the current holder.

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Task 2: Add SetViewport method to BrowserPage

**Files:**
- Modify: `internal/sessiond/browser_manager.go`

### Step 1: Locate existing viewport call

Read `internal/sessiond/browser_manager.go` around line 143 to confirm the inline `Emulation.setDeviceMetricsOverride` call in `OpenPage`.

Also read `internal/sessiond/browser_input.go` around line 97 to confirm the `"resize"` case calls the same CDP method inline.

### Step 2: Add SetViewport method to BrowserPage

Add this method to `browser_manager.go` near the other `BrowserPage` methods (after `OpenPage` or after the struct definition):

```go
// SetViewport updates Chromium's render resolution for this page.
// Calls Emulation.setDeviceMetricsOverride with the given dimensions.
// A 5-second deadline is applied. Returns an error if CDP fails.
func (bp *BrowserPage) SetViewport(ctx context.Context, width, height int) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := bp.cdp.Call(ctx, bp.sessionID, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             width,
		"height":            height,
		"deviceScaleFactor": 1,
		"mobile":            false,
	})
	return err
}
```

Make sure `"time"` is already imported (it is, from the `ScreenshotPage` method).

### Step 3: Verify compilation

```bash
go build ./...
```

Expected: clean, 0 errors.

### Step 4: Commit

```bash
git add internal/sessiond/browser_manager.go
git commit -m "feat(browser): add BrowserPage.SetViewport method

Extracts Emulation.setDeviceMetricsOverride into a named method on
BrowserPage so browser-focus handling can call it cleanly.

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Task 3: Add browser-focus fields to BrowserInputMsg and new protocol types

**Files:**
- Modify: `internal/sessiond/protocol.go`

### Step 1: Read the file

Read `internal/sessiond/protocol.go`. Confirm `BrowserInputMsg` starts around line 214 and has `Type`, `X`, `Y`, `Button`, `DeltaX`, `DeltaY`, `Key`, `Text`, `URL`, `Width`, `Height`. Confirm there is no `TypeBrowserGranted` constant.

### Step 2: Add TypeBrowserGranted constant

In the constants block (around line 61–68), add `TypeBrowserGranted` after `TypeBrowserError`:

```go
// Browser CDP pane messages (/ws/browser WebSocket).
TypeCreateBrowserPane       = "create-browser-pane"
TypeCloseBrowserPane        = "close-browser-pane"
TypeBrowserInput            = "browser-input"
TypeBrowserURL              = "browser-url"
TypeBrowserDownloadProgress = "browser-download-progress"
TypeBrowserError            = "browser-error"
TypeBrowserGranted          = "browser-granted"   // ← add this line
```

### Step 3: Add ClientID, DeviceID, RenderWidth, RenderHeight to BrowserInputMsg

The `BrowserInputMsg` struct (around line 214) becomes:

```go
// BrowserInputMsg is the event payload for {type:"browser-input"} JSON frames
// sent by the browser client on /ws/browser. The Type field names the input
// event (e.g. "mousemove", "mousedown", "keydown", "navigate", "resize",
// "browser-focus", "browser-blur").
// All geometry and value fields are optional; omit those not relevant to the event.
type BrowserInputMsg struct {
	Type         string  `json:"type"`
	X            float64 `json:"x,omitempty"`            // pointer X coordinate
	Y            float64 `json:"y,omitempty"`            // pointer Y coordinate
	Button       string  `json:"button,omitempty"`       // left|middle|right
	DeltaX       float64 `json:"deltaX,omitempty"`       // scroll delta X
	DeltaY       float64 `json:"deltaY,omitempty"`       // scroll delta Y
	Key          string  `json:"key,omitempty"`          // e.g. "Enter", "ArrowLeft", "a"
	Text         string  `json:"text,omitempty"`         // for "type" events
	URL          string  `json:"url,omitempty"`          // for "navigate" events
	Width        int     `json:"width,omitempty"`        // for "resize" events
	Height       int     `json:"height,omitempty"`       // for "resize" events
	ClientID     string  `json:"clientId,omitempty"`     // stable per-connection ID (browser-focus/blur)
	DeviceID     string  `json:"deviceId,omitempty"`     // stable per-device ID (browser-focus/blur)
	RenderWidth  int     `json:"renderWidth,omitempty"`  // canvas CSS width at focus time
	RenderHeight int     `json:"renderHeight,omitempty"` // canvas CSS height at focus time
}
```

### Step 4: Add BrowserGrantedMsg struct

After `BrowserErrorMsg` (around line 249), add:

```go
// BrowserGrantedMsg is the {type:"browser-granted"} frame sent to all /ws/browser
// clients when a client claims input authority via browser-focus.
type BrowserGrantedMsg struct {
	Type     string `json:"type"`
	PaneID   int    `json:"paneId"`
	ClientID string `json:"clientId"` // the client that now holds authority
}
```

### Step 5: Verify compilation

```bash
go build ./...
```

Expected: clean, 0 errors.

### Step 6: Commit

```bash
git add internal/sessiond/protocol.go
git commit -m "feat(protocol): add browser-focus fields and TypeBrowserGranted

BrowserInputMsg gains ClientID, DeviceID, RenderWidth, RenderHeight for
browser-focus and browser-blur events. New TypeBrowserGranted constant and
BrowserGrantedMsg struct for authority-grant notifications.

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Task 4: Handle browser-focus and browser-blur in HandleInput; enforce authority on input events

**Files:**
- Modify: `internal/sessiond/browser_input.go`

### Step 1: Read the file

Read `internal/sessiond/browser_input.go`. Confirm:
- `HandleInput` has a `"browser-ready"` case at the bottom of the switch
- Mouse/keyboard cases do NOT yet check authority
- The `context` import is present

### Step 2: Add browser-focus and browser-blur cases

Replace the `"browser-ready"` case and add the two new cases. Find this block (around line 106–110):

```go
case "browser-ready":
    // Client canvas is mounted and ready. Restart screencast to ensure
    // frames flow. The direct-to-client screenshot is handled in ws_browser.go.
    return bp.startScreencast(ctx)
```

Replace it with:

```go
case "browser-focus":
    // Client claims input authority and reports its canvas render size.
    // 1. Update Chromium viewport to match this client's canvas dimensions.
    if msg.RenderWidth > 0 && msg.RenderHeight > 0 {
        if err := bp.SetViewport(ctx, msg.RenderWidth, msg.RenderHeight); err != nil {
            return fmt.Errorf("browser-focus SetViewport: %w", err)
        }
    }
    // 2. Record this client as the input authority (last-focus-wins).
    bp.manager.SetAuthority(bp.paneID, msg.ClientID)
    // 3. Notify all connected clients who holds authority.
    bp.manager.broadcastJSON(BrowserGrantedMsg{
        Type:     TypeBrowserGranted,
        PaneID:   bp.paneID,
        ClientID: msg.ClientID,
    })
    // 4. Take a fresh screenshot so the canvas is not blank while the
    //    screencast (re)starts. Broadcast to ALL clients.
    if shot, err := bp.captureScreenshot(ctx); err == nil && len(shot) > 0 {
        bp.manager.broadcast(bp.paneID, shot)
    }
    // 5. (Re)start the screencast.
    return bp.startScreencast(ctx)

case "browser-blur":
    // Client releases input authority.
    bp.manager.ClearAuthority(bp.paneID, msg.ClientID)
    return nil

case "browser-ready":
    // Legacy signal kept for backward compatibility during the Phase 1→2 transition.
    // New clients send browser-focus instead. Restart screencast only.
    return bp.startScreencast(ctx)
```

Make sure `"fmt"` is in the import block. It already is (used by `handleNavigate`).

### Step 3: Add authority enforcement to mouse and keyboard events

In the switch, the mouse cases (`"mousemove"`, `"mousedown"`, `"mouseup"`, `"wheel"`) and keyboard cases (`"keydown"`, `"keyup"`) currently dispatch directly to CDP with no authority check. Add an authority guard at the **top** of each group.

Find the `"mousemove"` case (around line 17) and add a guard before the CDP call. The pattern: if `msg.ClientID` is non-empty AND the client is NOT the authority, silently drop the event. If `msg.ClientID` is empty (legacy clients without Phase 2 frontend), allow the event through unchanged.

Add a helper check at the start of the `HandleInput` function body (after the switch opens), as a local inline check — OR add an explicit guard in each mouse/keyboard case. The simplest approach: add a guard inside the switch, before the first mouse case:

```go
func (bp *BrowserPage) HandleInput(ctx context.Context, msg BrowserInputMsg) error {
    // Authority guard: if the event carries a clientId and the client is not
    // the current authority, silently drop mouse/keyboard input. Events without
    // a clientId (legacy format) are allowed through for backward compat.
    isInputEvent := msg.Type == "mousemove" || msg.Type == "mousedown" ||
        msg.Type == "mouseup" || msg.Type == "wheel" ||
        msg.Type == "keydown" || msg.Type == "keyup"
    if isInputEvent && msg.ClientID != "" && !bp.manager.IsAuthority(bp.paneID, msg.ClientID) {
        return nil // silently drop from non-authority clients
    }

    switch msg.Type {
    // ... rest of switch unchanged
```

Insert the authority guard block at the very start of `HandleInput`, before the `switch msg.Type {` line.

### Step 4: Verify compilation

```bash
go build ./...
```

Expected: clean, 0 errors.

### Step 5: Check for any existing tests that test HandleInput

```bash
grep -l "HandleInput\|browser-ready\|browser-focus" internal/sessiond/*_test.go
```

If any test file references `browser-ready` and breaks, update the test to use `browser-focus` or keep `browser-ready` working (the fallback case is still present).

### Step 6: Verify tests still compile

```bash
go build ./...
```

Expected: clean. (No new test files are written per AGENTS.md policy.)

### Step 7: Commit

```bash
git add internal/sessiond/browser_input.go
git commit -m "feat(browser): handle browser-focus/blur in HandleInput; enforce input authority

browser-focus: SetViewport → SetAuthority → broadcastJSON(browser-granted)
  → captureScreenshot broadcast → startScreencast.
browser-blur: ClearAuthority.
Input events with a clientId are silently dropped for non-authority clients.
browser-ready kept as legacy fallback (restarts screencast only).

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Task 5: Add onBrowserGranted callback to ws-browser.ts

**Files:**
- Modify: `web/src/lib/ws-browser.ts`

### Step 1: Read the file

Read `web/src/lib/ws-browser.ts`. Confirm the `BrowserSocket` class has `onBrowserCursor` as the last public callback field (around line 36) and the JSON message handler ends at the `browser-cursor` case inside `ws.onmessage`.

### Step 2: Add onBrowserGranted field

After the `onBrowserCursor` field declaration (line 36), add:

```typescript
onBrowserGranted: ((paneId: number, clientId: string) => void) | null = null;
```

### Step 3: Add browser-granted case to the message handler

Inside the `ws.onmessage` handler, after the `case 'browser-cursor':` block (around line 121), add:

```typescript
case 'browser-granted':
    if (typeof msg['clientId'] === 'string') {
        this.onBrowserGranted?.(msg.paneId as number, msg['clientId'] as string);
    }
    break;
```

### Step 4: Verify

```bash
cd web && npm run check:fast
```

Expected: 0 errors.

### Step 5: Commit

```bash
git add web/src/lib/ws-browser.ts
git commit -m "feat(ws-browser): add onBrowserGranted callback for browser-granted messages

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Task 6: Add onGranted callback to browser-registry and wire onBrowserGranted in app.ts

**Files:**
- Modify: `web/src/lib/browser-registry.ts`
- Modify: `web/src/app.ts`

### Step 1: Read both files

Read `web/src/lib/browser-registry.ts`. Confirm `BrowserPaneCallbacks` interface has 6 fields ending with `onCursor`. Confirm `_blankEntry()`, `setCallbacks()`, and `prune()` exist.

Read `web/src/app.ts` around line 599–605 where `wsBrowser.onFrame`, `onBrowserUrl`, etc. are wired.

### Step 2: Update BrowserPaneCallbacks interface

In `web/src/lib/browser-registry.ts`, add `onGranted` to the `BrowserPaneCallbacks` interface:

```typescript
export interface BrowserPaneCallbacks {
  onFrame: ((jpegBytes: Uint8Array) => void) | null;
  onUrl: ((url: string) => void) | null;
  onError: ((error: string) => void) | null;
  onDownload: ((percent: number) => void) | null;
  onStatus: ((statusText: string) => void) | null;
  onCursor: ((cursor: string) => void) | null;
  /** Invoked when this client is granted or loses input authority. */
  onGranted: ((isAuthority: boolean) => void) | null;
}
```

### Step 3: Update _blankEntry to include onGranted: null

```typescript
function _blankEntry(): BrowserPaneCallbacks {
  return {
    onFrame: null,
    onUrl: null,
    onError: null,
    onDownload: null,
    onStatus: null,
    onCursor: null,
    onGranted: null,
  };
}
```

### Step 4: Update setCallbacks to handle onGranted

In `setCallbacks`, add:

```typescript
if ('onGranted' in cbs) entry.onGranted = cbs.onGranted ?? null;
```

### Step 5: Update prune to null out onGranted

In `prune`, add `entry.onGranted = null;` alongside the other nulled fields.

### Step 6: Add dispatchGranted method

After `dispatchCursor`, add:

```typescript
/**
 * Dispatch an authority-granted event to the registered onGranted callback
 * for the pane that holds authority.
 * Called with (paneId, grantedClientId); the pane component compares
 * grantedClientId to its own _clientId to determine isAuthority.
 * No-op if pane is unknown or callback is not registered.
 */
dispatchGranted(paneId: number, grantedClientId: string, ownClientId: string): void {
    _map.get(paneId)?.onGranted?.(grantedClientId === ownClientId);
},
```

Wait — the registry doesn't know the pane's own `_clientId`. Instead, pass the raw `grantedClientId` to the callback and let `mux-browser-pane` decide. Change the signature:

```typescript
/**
 * Dispatch a browser-granted notification to all panes for paneId.
 * The grantedClientId is the client that now holds authority.
 * No-op if pane is unknown or callback is not registered.
 */
dispatchGranted(paneId: number, grantedClientId: string): void {
    // Future: could call onGranted on ALL pane IDs to clear non-authorities.
    // For now, the server sends browser-granted to all clients; the pane
    // component compares grantedClientId to its own _clientId.
    _map.get(paneId)?.onGranted?.(grantedClientId !== '' /* placeholder: true if any client */);
},
```

Actually, simpler: just pass `grantedClientId` through. Update `onGranted` callback signature to receive the raw string:

Update `BrowserPaneCallbacks`:
```typescript
/** Invoked when a browser-granted message arrives for this pane.
 *  grantedClientId is the client that now holds input authority. */
onGranted: ((grantedClientId: string) => void) | null;
```

And `dispatchGranted`:
```typescript
dispatchGranted(paneId: number, grantedClientId: string): void {
    _map.get(paneId)?.onGranted?.(grantedClientId);
},
```

### Step 7: Wire onBrowserGranted in app.ts

In `app.ts`, after the `wsBrowser.onBrowserCursor` line (around line 604), add:

```typescript
wsBrowser.onBrowserGranted = (paneId, clientId) => browserRegistry.dispatchGranted(paneId, clientId);
```

### Step 8: Verify

```bash
cd web && npm run check:fast
```

Expected: 0 errors. If type errors appear about `onGranted` not existing on `Partial<BrowserPaneCallbacks>`, they're expected — any call to `setCallbacks` with an object missing `onGranted` will now need it. Check `disconnectedCallback` in `mux-browser-pane.ts` (which passes `onGranted: null`) — add that field when you update that file in Task 7.

### Step 9: Commit

```bash
git add web/src/lib/browser-registry.ts web/src/app.ts
git commit -m "feat(browser): add onGranted callback to browser-registry; wire onBrowserGranted in app.ts

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Task 7: Replace browser-ready with browser-focus in mux-browser-pane.ts

**Files:**
- Modify: `web/src/components/mux-browser-pane.ts`

This is the largest frontend task. Read the full file before starting — it's 823 lines.

### Step 1: Read the file

Pay attention to:
- `firstUpdated()` (line 388): sends `browser-ready`, sets up FPS timer, attaches event listeners
- `connectedCallback()` (line 356): registers callbacks with browserRegistry
- `disconnectedCallback()` (line 369): unregisters callbacks
- Private fields section (line 343): `_ctx`, `_pendingFrame`, `_renderScheduled`, `_fpsFrameCount`, `_fpsTimer`

### Step 2: Add stable client identity fields

After the private field declarations (after line 348 where `_fpsTimer` is declared), add:

```typescript
// Stable per-WebSocket-connection ID. Generated once per component instance
// and used to claim input authority via browser-focus.
private readonly _clientId: string = Math.random().toString(36).slice(2);

// Stable per-device ID persisted in localStorage. Distinguishes different
// physical machines from multiple tabs on the same machine.
private readonly _deviceId: string = MuxBrowserPane._getOrCreateDeviceId();

private static _getOrCreateDeviceId(): string {
    const key = 'muxterm-device-id';
    let id = localStorage.getItem(key);
    if (!id) {
        id = Math.random().toString(36).slice(2);
        localStorage.setItem(key, id);
    }
    return id;
}
```

### Step 3: Add _sendBrowserFocus() method

Add this private method after `_getOrCreateDeviceId()`:

```typescript
/**
 * Send browser-focus to sessiond: claims input authority and reports the
 * canvas render size so the server can update Chromium's viewport.
 * No-op when canvas has not yet been sized (width/height are 0).
 */
private _sendBrowserFocus(): void {
    if (!this._canvas) return;
    const rect = this._canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w > 0 && h > 0) {
        wsBrowser.send({
            type: SessiondType.BrowserInput,
            paneId: this.paneId,
            event: {
                type: 'browser-focus',
                clientId: this._clientId,
                deviceId: this._deviceId,
                renderWidth: w,
                renderHeight: h,
            },
        });
    }
}
```

### Step 4: Replace browser-ready with browser-focus in firstUpdated

Find this block in `firstUpdated()` (around line 392–397):

```typescript
// Signal server that canvas is ready — triggers immediate screenshot
wsBrowser.send({
    type: SessiondType.BrowserInput,
    paneId: this.paneId,
    event: { type: 'browser-ready' },
});
```

Replace it with:

```typescript
// Claim input authority and report canvas render size.
this._sendBrowserFocus();
```

Also remove the large comment block below it that says "No ResizeObserver resize relay to the server" — it will be replaced in Task 9.

### Step 5: Add onGranted to connectedCallback and disconnectedCallback

In `connectedCallback()`, the `setCallbacks` call currently passes 6 callbacks. Add `onGranted: null` (the component ignores the granted signal for now — future: dim canvas if not authority):

```typescript
browserRegistry.setCallbacks(this.paneId, {
    onFrame: this._onFrame,
    onUrl: this._onUrl,
    onError: this._onError,
    onDownload: this._onDownload,
    onStatus: this._onStatus,
    onCursor: this._onCursor,
    onGranted: null, // future: visual indicator when not authority
});
```

In `disconnectedCallback()`, the `setCallbacks` call must also include `onGranted: null`:

```typescript
browserRegistry.setCallbacks(this.paneId, {
    onFrame: null,
    onUrl: null,
    onError: null,
    onDownload: null,
    onStatus: null,
    onCursor: null,
    onGranted: null,
});
```

Also add a `browser-blur` send to `disconnectedCallback()`, before the `this._ctx = null` cleanup:

```typescript
// Release input authority on unmount.
wsBrowser.send({
    type: SessiondType.BrowserInput,
    paneId: this.paneId,
    event: { type: 'browser-blur', clientId: this._clientId, deviceId: this._deviceId },
});
```

### Step 6: Verify

```bash
cd web && npm run check:fast
```

Expected: 0 errors.

### Step 7: Commit

```bash
git add web/src/components/mux-browser-pane.ts
git commit -m "feat(browser-pane): replace browser-ready with browser-focus; add client/device IDs

_clientId and _deviceId provide stable identity per connection and device.
_sendBrowserFocus() sends browser-focus with renderWidth/renderHeight.
disconnectedCallback sends browser-blur to release authority on unmount.

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Task 8: Add panel-activated and window focus/blur listeners

**Files:**
- Modify: `web/src/components/mux-dock.ts`
- Modify: `web/src/components/mux-browser-pane.ts`

### Step 1: Read mux-dock.ts around line 642

Read `web/src/components/mux-dock.ts` from line 640 to 660. Confirm `onDidActivePanelChange` dispatches `pane-select` but does NOT dispatch any browser-pane event.

### Step 2: Dispatch browser-pane-activated from mux-dock.ts

In the `onDidActivePanelChange` callback (line 642), after the `requestAnimationFrame(() => terminalRegistry.focus(paneId))` call, add:

```typescript
// For browser-cdp panes: dispatch a window event so mux-browser-pane
// can send browser-focus and resume the Chromium screencast.
const paneInfo = this.panes.find((p) => p.paneId === paneId);
if (paneInfo?.surfaceKind === 'browser-cdp') {
    window.dispatchEvent(new CustomEvent('browser-pane-activated', { detail: { paneId } }));
}
```

`this.panes` is a `@property` that holds the current composition — `surfaceKind` is stable and doesn't change mid-session.

### Step 3: Add panel-activated and window focus/blur listeners to mux-browser-pane.ts

Read the current `connectedCallback` and `disconnectedCallback` methods in `mux-browser-pane.ts`.

In `connectedCallback()`, after `browserRegistry.setCallbacks(...)`, add:

```typescript
window.addEventListener('browser-pane-activated', this._onPanelActivated);
window.addEventListener('focus', this._onWindowFocus);
window.addEventListener('blur', this._onWindowBlur);
```

In `disconnectedCallback()`, after the `browserRegistry.setCallbacks(...)` call that nulls everything out, add:

```typescript
window.removeEventListener('browser-pane-activated', this._onPanelActivated);
window.removeEventListener('focus', this._onWindowFocus);
window.removeEventListener('blur', this._onWindowBlur);
```

### Step 4: Add the three handler methods

Add these after `_sendBrowserFocus()`:

```typescript
private readonly _onPanelActivated = (e: Event): void => {
    const detail = (e as CustomEvent<{ paneId: number }>).detail;
    if (detail?.paneId !== this.paneId) return;
    this._sendBrowserFocus();
};

private readonly _onWindowFocus = (): void => {
    // Re-claim authority when the OS window regains focus.
    this._sendBrowserFocus();
};

private readonly _onWindowBlur = (): void => {
    wsBrowser.send({
        type: SessiondType.BrowserInput,
        paneId: this.paneId,
        event: { type: 'browser-blur', clientId: this._clientId, deviceId: this._deviceId },
    });
};
```

### Step 5: Verify both files

```bash
cd web && npm run check:fast
```

Expected: 0 errors.

### Step 6: Commit

```bash
git add web/src/components/mux-dock.ts web/src/components/mux-browser-pane.ts
git commit -m "feat(browser): dispatch browser-pane-activated on dockview tab switch; add window focus/blur listeners

mux-dock dispatches 'browser-pane-activated' on onDidActivePanelChange for
browser-cdp panes. mux-browser-pane listens and calls _sendBrowserFocus().
Window focus/blur listeners complete the three-signal browser-focus model:
  1. firstUpdated (mount)
  2. panel-activated (tab switch)
  3. window focus (OS window regains focus)

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Task 9: Fix canvas buffer sizing with ResizeObserver

**Files:**
- Modify: `web/src/components/mux-browser-pane.ts`

Currently `_flushFrame()` sets `canvas.width = img.naturalWidth; canvas.height = img.naturalHeight`. This must change: the canvas buffer size should match the CSS container size (so `drawImage` math is pixel-accurate), not the frame size (which changes when Chromium's viewport changes).

### Step 1: Read _flushFrame and private fields

Read lines 340–474 in `mux-browser-pane.ts`. Confirm:
- `_resizeObserver` comment says "intentionally removed"
- `_flushFrame` sets canvas width/height from img.naturalWidth/naturalHeight
- There is no ResizeObserver

### Step 2: Add ResizeObserver field and letterbox state

After the `_fpsTimer` field (line 348), add:

```typescript
private _resizeObserver: ResizeObserver | undefined;
// Letterbox transform computed during the last frame draw.
// Used by _toViewport to map mouse coordinates into Chromium space.
private _letterbox = { dx: 0, dy: 0, scale: 1, fw: 0, fh: 0 };
```

### Step 3: Wire ResizeObserver in firstUpdated

In `firstUpdated()`, after `this._ctx = this._canvas.getContext('2d');`, add:

```typescript
// ResizeObserver: set canvas pixel buffer = CSS container size.
// This ensures drawImage math is accurate regardless of Chromium's viewport.
// Also re-sends browser-focus so the server can update Chromium's viewport
// to match (only when the canvas already has a rendered frame, i.e. after mount).
this._resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const { width, height } = entry.contentRect;
    const w = Math.round(width);
    const h = Math.round(height);
    if (w > 0 && h > 0) {
        this._canvas.width = w;
        this._canvas.height = h;
        // Re-get context: some browsers invalidate it on canvas resize.
        this._ctx = this._canvas.getContext('2d');
        // Report new render size to server so Chromium viewport tracks it.
        this._sendBrowserFocus();
    }
});
this._resizeObserver.observe(this._canvas);
```

### Step 4: Disconnect ResizeObserver in disconnectedCallback

In `disconnectedCallback()`, after the window.removeEventListener calls, add:

```typescript
this._resizeObserver?.disconnect();
this._resizeObserver = undefined;
```

### Step 5: Remove canvas-size-from-frame lines in _flushFrame

Find the `img.onload` block in `_flushFrame()` (around line 453). Currently it reads:

```typescript
img.onload = () => {
    URL.revokeObjectURL(url);
    if (!this._ctx) return;
    // Adjust canvas backing-store size to match natural image size
    if (
        this._canvas.width !== img.naturalWidth ||
        this._canvas.height !== img.naturalHeight
    ) {
        this._canvas.width = img.naturalWidth;
        this._canvas.height = img.naturalHeight;
    }
    this._ctx.drawImage(img, 0, 0);
    this._fpsFrameCount++;
};
```

Replace it with (letterbox draw — see Task 10 for the full implementation):

```typescript
img.onload = () => {
    URL.revokeObjectURL(url);
    if (!this._ctx) return;
    // Canvas buffer is sized by ResizeObserver (CSS container size).
    // Draw the frame with letterbox math — see _drawLetterboxed.
    this._drawLetterboxed(img);
    this._fpsFrameCount++;
};
```

Add the `_drawLetterboxed` stub (full implementation in Task 10):

```typescript
private _drawLetterboxed(img: HTMLImageElement): void {
    // Stub — full implementation in Task 10.
    if (!this._ctx) return;
    this._ctx.drawImage(img, 0, 0);
}
```

### Step 6: Verify

```bash
cd web && npm run check:fast
```

Expected: 0 errors.

### Step 7: Commit

```bash
git add web/src/components/mux-browser-pane.ts
git commit -m "feat(browser-pane): use ResizeObserver for canvas buffer sizing

Canvas pixel buffer now tracks CSS container size via ResizeObserver.
Frame natural size no longer drives canvas dimensions — the letterbox
draw handles any aspect ratio mismatch. _drawLetterboxed stub in place.

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Task 10: Implement JS letterboxing in _drawLetterboxed

**Files:**
- Modify: `web/src/components/mux-browser-pane.ts`

### Step 1: Verify the stub is in place

After Task 9, `_drawLetterboxed(img)` should be a stub that just calls `this._ctx.drawImage(img, 0, 0)`. Confirm.

### Step 2: Replace the stub with the full letterbox implementation

Find and replace the `_drawLetterboxed` method:

```typescript
/**
 * Draw img centered in the canvas buffer maintaining aspect ratio.
 * Fills the canvas width or height with the frame, leaving black bars
 * on the opposite axis (pillarbox / letterbox). Stores the transform
 * in this._letterbox for use by _toViewport().
 *
 * Design doc math:
 *   s  = Math.min(cw / fw, ch / fh)   uniform scale to fit
 *   dx = (cw - fw * s) / 2             horizontal offset (pillarbox bars)
 *   dy = (ch - fh * s) / 2             vertical offset (letterbox bars)
 */
private _drawLetterboxed(img: HTMLImageElement): void {
    if (!this._ctx) return;
    const cw = this._canvas.width;
    const ch = this._canvas.height;
    const fw = img.naturalWidth;
    const fh = img.naturalHeight;

    if (cw === 0 || ch === 0 || fw === 0 || fh === 0) return;

    const scale = Math.min(cw / fw, ch / fh);
    const dx = (cw - fw * scale) / 2;
    const dy = (ch - fh * scale) / 2;

    // Store for coordinate mapping in _toViewport.
    this._letterbox = { dx, dy, scale, fw, fh };

    this._ctx.clearRect(0, 0, cw, ch);
    this._ctx.drawImage(img, dx, dy, fw * scale, fh * scale);
}
```

### Step 3: Verify

```bash
cd web && npm run check:fast
```

Expected: 0 errors.

### Step 4: Commit

```bash
git add web/src/components/mux-browser-pane.ts
git commit -m "feat(browser-pane): implement JS letterbox rendering in _drawLetterboxed

Maintains aspect ratio by computing uniform scale s = min(cw/fw, ch/fh).
Stores dx, dy, scale, fw, fh in _letterbox for coordinate mapping.
When focused client matches Chromium viewport exactly: s≈1, dx=dy=0.

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Task 11: Implement letterbox-aware _toViewport; update all mouse handlers

**Files:**
- Modify: `web/src/components/mux-browser-pane.ts`

### Step 1: Read the current _toViewport and its callers

Read lines 499–558 of `mux-browser-pane.ts`. Current `_toViewport` uses `getBoundingClientRect` + scaleX/scaleY. The callers (`_onMouseMove`, `_onMouseDown`, `_onMouseUp`, `_onWheel`) all destructure the return directly: `const { x, y } = this._toViewport(e)`.

### Step 2: Change _toViewport signature to return null for out-of-bounds clicks

Replace the current `_toViewport` method:

```typescript
/**
 * Map a MouseEvent's offsetX/offsetY into Chromium viewport coordinates
 * using the stored letterbox transform.
 *
 * Returns null when:
 *   - The letterbox transform is not yet initialised (no frames received)
 *   - The click is in the black bars (outside the rendered frame area)
 *
 * offsetX/offsetY are relative to the canvas element itself (i.e. already
 * in canvas-local CSS pixels), so no clientX/clientRect math is needed.
 */
private _toViewport(e: MouseEvent): { x: number; y: number } | null {
    const { dx, dy, scale, fw, fh } = this._letterbox;
    if (scale === 0 || fw === 0 || fh === 0) return null;

    const x = (e.offsetX - dx) / scale;
    const y = (e.offsetY - dy) / scale;

    // Reject clicks in the black bars (outside the rendered frame).
    if (x < 0 || x > fw || y < 0 || y > fh) return null;

    return { x: Math.round(x), y: Math.round(y) };
}
```

### Step 3: Update all mouse event handlers to handle null

Each handler currently uses `const { x, y } = this._toViewport(e)`. Because `_toViewport` now returns `null` for out-of-bounds, add a null guard. Replace each handler:

**_onMouseMove:**

```typescript
private readonly _onMouseMove = (e: MouseEvent): void => {
    const coords = this._toViewport(e);
    if (!coords) return;
    wsBrowser.send({
        type: SessiondType.BrowserInput,
        paneId: this.paneId,
        event: { type: 'mousemove', x: coords.x, y: coords.y },
    });
};
```

**_onMouseDown:**

```typescript
private readonly _onMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    this._canvas.focus();
    const coords = this._toViewport(e);
    if (!coords) return;
    wsBrowser.send({
        type: SessiondType.BrowserInput,
        paneId: this.paneId,
        event: {
            type: 'mousedown',
            button: (['left', 'middle', 'right'][e.button] ?? 'left'),
            x: coords.x,
            y: coords.y,
        },
    });
};
```

**_onMouseUp:**

```typescript
private readonly _onMouseUp = (e: MouseEvent): void => {
    const coords = this._toViewport(e);
    if (!coords) return;
    wsBrowser.send({
        type: SessiondType.BrowserInput,
        paneId: this.paneId,
        event: {
            type: 'mouseup',
            button: (['left', 'middle', 'right'][e.button] ?? 'left'),
            x: coords.x,
            y: coords.y,
        },
    });
};
```

**_onWheel:**

```typescript
private readonly _onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const coords = this._toViewport(e);
    if (!coords) return;
    wsBrowser.send({
        type: SessiondType.BrowserInput,
        paneId: this.paneId,
        event: { type: 'wheel', x: coords.x, y: coords.y, deltaX: e.deltaX, deltaY: e.deltaY },
    });
};
```

### Step 4: Verify

```bash
cd web && npm run check:fast
```

Expected: 0 errors.

### Step 5: Commit

```bash
git add web/src/components/mux-browser-pane.ts
git commit -m "feat(browser-pane): letterbox-aware _toViewport; reject clicks in black bars

_toViewport now uses stored _letterbox transform (dx, dy, scale) instead
of getBoundingClientRect scaleX/scaleY. Returns null for clicks outside
the rendered frame area. All mouse handlers guard the null case.

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Task 12: Final cleanup — remove remaining browser-ready references; verify end-to-end

**Files:**
- Audit: throughout codebase
- Fix: any remaining `browser-ready` references that shouldn't exist post-Phase-2

### Step 1: Search for remaining browser-ready references

```bash
grep -rn "browser-ready\|browserReady\|browser_ready" \
    internal/ web/src/ \
    --include="*.go" --include="*.ts"
```

Expected survivors (these are intentional):
- `internal/sessiond/browser_input.go` — the `case "browser-ready":` legacy fallback kept for Phase 1→2 transition
- `internal/sessiond/browser_screencast.go` — the comment "Used for on-demand frames (e.g. browser-ready, reconnect)" — update this comment only
- `internal/server/ws_browser.go` — the comment "browser-ready" in line 140 and line 200–210 — after Phase 1, `ws_browser.go` is a relay and no longer special-cases browser-ready; if these lines still exist in the post-Phase-1 codebase, update or remove them

### Step 2: Update stale comments

In `internal/sessiond/browser_screencast.go`, find:
```go
// captureScreenshot takes a JPEG screenshot of the current page and returns
// the raw JPEG bytes. Used for on-demand frames (e.g. browser-ready, reconnect).
```

Replace with:
```go
// captureScreenshot takes a JPEG screenshot of the current page and returns
// the raw JPEG bytes. Used for on-demand frames (e.g. browser-focus, reconnect).
```

### Step 3: Check for any TypeScript references to 'browser-ready'

```bash
grep -rn "browser-ready" web/src/ --include="*.ts"
```

Expected: 0 matches (browser-ready was removed from `mux-browser-pane.ts` in Task 7). If any remain, remove them.

### Step 4: Full build verification

```bash
go build ./...
```

Expected: clean, 0 errors.

```bash
cd web && npm run check:fast
```

Expected: 0 errors.

### Step 5: Check existing test files still compile

```bash
go build ./...
```

If any `*_test.go` file references `browser-ready` and now fails (e.g. testing that `HandleInput` returns no error for `browser-ready`), update the test to use `browser-focus` instead. Do NOT write new test files.

```bash
grep -rn "browser-ready" internal/sessiond/*_test.go
```

If matches exist, update those specific test cases to use `browser-focus` with appropriate fields:
```go
BrowserInputMsg{Type: "browser-focus", ClientID: "test-client", RenderWidth: 1280, RenderHeight: 720}
```

### Step 6: Final verification

```bash
go build ./...
cd web && npm run check:fast
```

Both must pass with 0 errors.

### Step 7: Commit

```bash
git add -A
git commit -m "feat(browser): Phase 2 cleanup — update stale browser-ready comments

browser-focus is now the canonical reconnect/mount signal.
browser-ready kept as legacy fallback in HandleInput only.
All other browser-ready references updated to browser-focus.

🤖 Generated with Amplifier
Co-authored-by: amplifier-dev[bot] <amplifier-dev[bot]@users.noreply.github.com>"
```

---

## Verification Summary

After all 12 tasks are complete, confirm the following:

| Behaviour | How to verify |
|-----------|---------------|
| `go build ./...` passes | Run it |
| `cd web && npm run check:fast` passes | Run it |
| `BrowserManager` has `SetAuthority`, `ClearAuthority`, `IsAuthority` | `grep -n "func.*Authority" internal/sessiond/browser_manager.go` |
| `BrowserInputMsg` has `ClientID`, `RenderWidth`, `RenderHeight` | `grep -n "ClientID\|RenderWidth" internal/sessiond/protocol.go` |
| `TypeBrowserGranted` constant exists | `grep -n "TypeBrowserGranted" internal/sessiond/protocol.go` |
| `HandleInput` has `browser-focus` and `browser-blur` cases | `grep -n "browser-focus\|browser-blur" internal/sessiond/browser_input.go` |
| `ws-browser.ts` has `onBrowserGranted` field | `grep -n "onBrowserGranted" web/src/lib/ws-browser.ts` |
| `mux-browser-pane.ts` has `_sendBrowserFocus` | `grep -n "_sendBrowserFocus" web/src/components/mux-browser-pane.ts` |
| `mux-browser-pane.ts` has `_drawLetterboxed` | `grep -n "_drawLetterboxed" web/src/components/mux-browser-pane.ts` |
| `mux-browser-pane.ts` `_toViewport` returns `null` for out-of-bounds | `grep -n "return null" web/src/components/mux-browser-pane.ts` |
| No `browser-ready` sends in frontend (only legacy fallback in Go) | `grep -rn "browser-ready" web/src/` |
| `mux-dock.ts` dispatches `browser-pane-activated` | `grep -n "browser-pane-activated" web/src/components/mux-dock.ts` |

---

## Task Dependency Map

```
Task 1 (BrowserManager authority tracking)
Task 2 (BrowserPage.SetViewport)
Task 3 (BrowserInputMsg fields + TypeBrowserGranted)
    ↓
Task 4 (HandleInput browser-focus/blur cases) ← depends on 1, 2, 3
    ↓
Task 5 (ws-browser.ts onBrowserGranted)
Task 6 (browser-registry + app.ts wiring) ← depends on 5
    ↓
Task 7 (mux-browser-pane.ts: replace browser-ready, add _clientId/_deviceId)
Task 8 (panel-activated + window focus/blur listeners) ← depends on 7
Task 9 (ResizeObserver canvas sizing) ← depends on 7
Task 10 (letterbox draw) ← depends on 9
Task 11 (letterbox coordinate mapping) ← depends on 10
    ↓
Task 12 (cleanup + final verification) ← depends on all above
```

Go tasks (1–4) can be done in parallel with frontend tasks (5–12) if split across two engineers. Within each group, follow the numbered order.
