# Browser CDP Pane Design

## Goal

Replace the old iframe/port-proxy browser pane (removed in the v0.5.0 revert) with a CDP screen-capture approach: muxterm manages a Chromium process, streams JPEG frames via WebSocket to a canvas renderer in the browser client, and relays mouse/keyboard/touch input back to Chromium. v1 supports one browser window. The architecture is designed for N windows in the future with zero structural changes.

## Background

The previous browser pane embedded external URLs in an `<iframe>` behind a Go reverse proxy. This was fundamentally broken for the open web — `X-Frame-Options`, CSP headers, cookie scoping, and `<base href>` injection are all unsolvable in the general case from inside a proxy shim. The v0.5.0 revert removed that surface entirely.

The replacement uses Chrome DevTools Protocol (CDP) screen capture. Chromium runs as a managed subprocess; muxterm streams its output as JPEG frames over WebSocket and forwards input events back via CDP. The web platform works natively inside Chromium — `X-Frame-Options`, CSP, cookies, authentication, and all browser APIs behave exactly as they would in a standalone browser, because Chromium *is* the standalone browser.

A complete working proof-of-concept exists at `spike/browser-cdp-stream/` on the `explore/browser-tab` branch. Key facts proven by the spike:
- `Page.startScreencast` (JPEG quality 75, `everyNthFrame: 1`) delivers real-time frames
- `Page.screencastFrameAck` must be called for every frame or Chromium stops sending
- Canvas rendering via `new Image()` + `ctx.drawImage()` handles frames smoothly
- Coordinate mapping: `canvas.getBoundingClientRect()` + scale factors gives correct viewport coords
- Keyboard: `keydown` + separate `type` message for printable chars
- Navigation: `history:back`, `history:forward`, `history:reload` sentinel URLs work as navigate commands
- URL tracking: `framenavigated` event on the main frame

## Approach

**Go-native with `go-rod`** — port the proven Node.js spike to Go using `github.com/go-rod/rod`. One binary, no Node.js dependency on the server. Rod's launcher handles Chromium download and management. Mirrors Puppeteer's API in Go.

## Architecture

Three layers: Chromium, sessiond, and the browser client.

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser Client (TypeScript / Lit)                               │
│  <mux-browser-pane>  ←→  /ws/browser (binary + JSON frames)     │
└───────────────────────────────┬──────────────────────────────────┘
                                │ WebSocket
┌───────────────────────────────▼──────────────────────────────────┐
│  muxterm HTTP Server                                             │
│  /ws/browser handler — routes frames in, input out              │
└───────────────────────────────┬──────────────────────────────────┘
                                │ Unix socket
┌───────────────────────────────▼──────────────────────────────────┐
│  sessiond                                                        │
│  BrowserManager ──── BrowserPage ──── *rod.Page                 │
└───────────────────────────────┬──────────────────────────────────┘
                                │ CDP (WebSocket)
┌───────────────────────────────▼──────────────────────────────────┐
│  Chromium (managed subprocess)                                   │
│  Page.startScreencast → JPEG frames                              │
│  Input.dispatchMouseEvent / dispatchKeyEvent                     │
└──────────────────────────────────────────────────────────────────┘
```

## Components

### Chromium Layer

- One managed Chromium process per muxterm server (v1: single instance)
- Launched by `go-rod`'s launcher on first browser pane open — lazy, not at sessiond startup
- Kept alive across pane open/close cycles (hot standby), killed on sessiond exit
- Data directory (platform-conventional):
  - Linux: `~/.local/share/muxterm/chromium/`
  - macOS: `~/Library/Application Support/muxterm/chromium/`

**Version pinning:** muxterm ships a hard-coded tested Chromium revision number. This revision is bumped and validated with each muxterm release. No auto-fetching of "latest" Chromium — prevents random breakage. When the pinned revision changes, `ChromiumManager.Ensure()` detects the mismatch and re-downloads automatically (~150 MB, one-time per revision).

**Download flow:** `ChromiumManager.Ensure()` is called when a browser pane is first opened:
1. Check if the pinned revision is already present in the data directory
2. If not, download via `launcher.NewBrowser()` from Google's Chrome for Testing API
3. Stream download progress to the client as `{type: "browser-download-progress", percent: N}` JSON on `/ws/browser`
4. Once downloaded, launch Chromium and return the `*rod.Browser`

### sessiond Layer (Go)

**`BrowserManager`** is a new struct owned by sessiond alongside the pane registry:

```go
type BrowserManager struct {
    browser  *rod.Browser
    pages    map[int]*BrowserPage
    maxPages int  // 1 in v1, remove for multi-window
}
```

v1 enforces `maxPages: 1` — returns an error if a second browser pane is requested.

`BrowserManager` is NOT a `Pane` internally (no VTBuffer, no PTY). It appears in the `composition` message as `surfaceKind: "browser-cdp"` so dockview renders it correctly, distinct from the removed old `"browser"` kind.

**`BrowserPage`** manages one Chromium page:

```go
type BrowserPage struct {
    paneID    int
    page      *rod.Page
    stopCh    chan struct{}
    broadcast func(paneID int, jpegBytes []byte)
}
```

**Screencast goroutine:** subscribes to `Page.screencastFrame` via rod's CDP event API. Each frame is base64-decoded to raw JPEG bytes, then `broadcast(paneID, jpegBytes)` sends it via the `/ws/browser` channel. `Page.screencastFrameAck` is called immediately after each frame — without this Chromium stops sending.

**Screencast settings:** JPEG format, quality 75, maxWidth 1280, maxHeight 720, `everyNthFrame: 1`. Quality and max dimensions are configurable via muxterm's existing config system.

**Input dispatch:** `BrowserPage.HandleInput(msg BrowserInputMsg)` routes by event type:

| Event | Rod call |
|---|---|
| `mousemove {x,y}` | `page.Mouse.Move(x, y)` |
| `mousedown {button}` | `page.Mouse.Down(button)` |
| `mouseup {button}` | `page.Mouse.Up(button)` |
| `wheel {deltaX,deltaY}` | `page.Mouse.Scroll(x, y, deltaX, deltaY)` |
| `keydown {key}` | `page.Keyboard.Down(key)` |
| `keyup {key}` | `page.Keyboard.Up(key)` |
| `type {text}` | `page.Keyboard.Type(text)` |
| `navigate {url}` | `page.Navigate(url)` (auto-prefixes `https://` if no scheme) |
| `navigate "history:back"` | `page.GoBack()` |
| `navigate "history:forward"` | `page.GoForward()` |
| `navigate "history:reload"` | `page.Reload()` |
| `resize {width,height}` | `page.SetViewport(width, height)` |

**URL tracking:** `page.EachEvent` subscribes to `events.PageFrameNavigated`. On each main-frame navigation, broadcasts `{type: "browser-url", paneId: N, url: "..."}` JSON on `/ws/browser`.

### Client Layer (TypeScript / Lit)

New `<mux-browser-pane>` Lit element, registered in dockview for `surfaceKind: "browser-cdp"` panes. Opens a dedicated `/ws/browser` WebSocket separate from the existing `/ws` terminal connection.

## Wire Protocol

### Critical design decision: separate WebSocket connections

Browser JPEG frames must NOT share the `/ws` terminal pipe. WebSocket over TCP is an ordered stream — a burst of large JPEG frames would delay terminal keystrokes and PTY output. Two independent connections solve this completely.

### `/ws` (existing — additive changes only)

All terminal PTY data, pane lifecycle, and workspace control remain exactly as before.

New message types added to the existing vocabulary:
- `create-browser-pane` (client → server): requests a browser pane be opened
- `close-browser-pane` (client → server): closes the browser pane
- Composition message: browser panes appear with `surfaceKind: "browser-cdp"`

### `/ws/browser` (new)

**Server → client:**

| Frame | Format |
|---|---|
| JPEG frame | Binary: `[4-byte LE paneId][raw JPEG bytes]` |
| `browser-url` | JSON: `{type: "browser-url", paneId: N, url: "https://..."}` |
| `browser-download-progress` | JSON: `{type: "browser-download-progress", paneId: N, percent: 42}` |
| `browser-error` | JSON: `{type: "browser-error", paneId: N, error: "..."}` |

**Client → server:**

All input is JSON: `{type: "browser-input", paneId: N, event: {type: "...", ...fields}}`.

Event types: `mousemove {x,y}`, `mousedown {button}`, `mouseup {button}`, `wheel {deltaX,deltaY}`, `keydown {key}`, `keyup {key}`, `type {text}`, `navigate {url}`, `resize {width,height}`.

**Backpressure:** The Go broadcast goroutine uses non-blocking send with drop semantics — frames dropped silently if the client buffer is full. The client drops frames it can't render in time (latest-frame-wins pattern from the spike).

## Data Flow

### JPEG Frame Path (server → client)

```
Chromium screencastFrame event
  → BrowserPage goroutine: base64-decode → raw JPEG bytes
  → broadcast(paneID, jpegBytes)
  → /ws/browser handler: prepend 4-byte paneId → binary WebSocket frame
  → client: parse paneId, decode JPEG → new Image() → ctx.drawImage()
```

### Input Path (client → server)

```
User mouse/keyboard event on <canvas>
  → coordinate mapping: getBoundingClientRect() + scale factors
  → JSON message on /ws/browser
  → BrowserPage.HandleInput()
  → rod CDP call → Chromium
```

### Browser Pane Open

```
User clicks globe button in dock bar
  → create-browser-pane on /ws
  → sessiond: ChromiumManager.Ensure() [download if needed]
  → BrowserManager.CreatePage(paneID) → new *rod.Page
  → page.StartScreencast(...)
  → screencast goroutine begins
  → composition message updated with surfaceKind: "browser-cdp"
  → <mux-browser-pane> mounts, opens /ws/browser
```

## Frontend Component

### `<mux-browser-pane>` structure

```
<mux-browser-pane>
  <div class="browser-toolbar">   ← nav buttons + omnibox + FPS badge
  <canvas id="viewport">          ← JPEG frames rendered here
  <div class="status-bar">        ← hovered link URL, like real browsers
```

### Browser toolbar

**Navigation buttons:** Circular ghost buttons (no border, no rectangle fill). SVG chevron icons only. Disabled at 30% opacity when back/forward is unavailable. Hover shows subtle white fill. No text labels.

**Omnibox:** Pill-shaped container (`border-radius: 20px`). Left: lock icon (green `var(--mux-ok)` for HTTPS, grey for HTTP) then hostname in `--chrome-text-bright`, path in `--chrome-text-dim`. Right: circular reload icon inside the pill — becomes a spinner during navigation. Focus state expands to show full URL for editing. No "Go" button — Enter key navigates.

**Right cluster:** FPS badge with subtle green-tinted background; live dot with glow animation using `var(--mux-ok)`.

**Status bar:** Appears at the bottom of the canvas on link hover (position: absolute). Fades when not needed.

### Theme awareness — zero hardcoded colors

The component uses only existing muxterm CSS custom properties:

| Element | CSS variable |
|---|---|
| Toolbar background | `var(--chrome-bar)` |
| Omnibox background | `var(--chrome-body)` |
| Borders | `var(--chrome-border)` |
| Primary text | `var(--chrome-text-bright)` |
| Dim text (URL path) | `var(--chrome-text-dim)` |
| Hover fill | `var(--chrome-hover)` |
| Focused omnibox ring | `var(--chrome-accent)` |
| FPS badge + live dot | `var(--mux-ok)` |
| HTTPS lock | `var(--mux-ok)` |
| Errors | `var(--mux-error)` |

These are already set globally by `applyChromeTokens()` and `applyMuxVars()` when the theme changes. The browser toolbar updates automatically with the rest of muxterm's UI across all themes (Tokyo Night, Catppuccin Mocha, Gruvbox, Dracula, Nord, One Light, Solarized Light, GitHub Light).

### Canvas rendering (from spike)

- Binary frame: parse `[paneId][JPEG bytes]` → `new Image()` → `ctx.drawImage()`
- Coordinate mapping: `canvas.getBoundingClientRect()` → `scaleX = canvas.width / rect.width`, same for Y
- Frame drop: `pendingFrame` / `scheduleRender` pattern — latest frame wins, stale frames discarded
- Canvas resizes when frame dimensions change (detected from `img.naturalWidth/Height`)

### Globe button in dock bar

Restored in `mux-dock-bar` right action area:
- First click → sends `create-browser-pane` on `/ws`
- Second click when pane exists → focuses/activates the existing pane
- Green tint (`--mux-ok`) while a browser pane is live

### `/ws/browser` lifecycle

- Opened when `<mux-browser-pane>` mounts
- Closed when it unmounts
- Reconnects automatically (2s backoff) matching the existing `/ws` reconnect pattern
- Only ever one connection per muxterm client (v1: single browser pane)

## MCP Browser Tools

13 tools in three groups, routing directly through `BrowserManager` → rod APIs. No relay chain, no correlation ID workaround (the old `CID=0` problem is gone — rod calls are direct synchronous Go calls).

The MCP package receives a `BrowserManager` reference at startup. Each tool calls `bm.GetPage(paneID)` to get the live `*rod.Page`. CSS selectors work natively throughout — no `ref` vs `selector` duality from the old shim approach.

**Navigation (4):**

```
browser_navigate(url)   → page.Navigate(url)  [auto-prefixes https:// if no scheme]
browser_back()          → page.GoBack()
browser_forward()       → page.GoForward()
browser_reload()        → page.Reload()
```

**Interaction (6):**

```
browser_click(selector)         → page.Element(selector).Click()
browser_fill(selector, value)   → page.Element(selector).Input(value)
browser_type(text)              → page.Keyboard.Type(text)
browser_press(key)              → page.Keyboard.Press(key)
browser_hover(selector)         → page.Element(selector).Hover()
browser_select(selector, value) → page.Element(selector).Select([]string{value})
```

**Observation (3):**

```
browser_snapshot()    → page.Accessibility.Snapshot()  [rich a11y tree — AI-friendly]
browser_eval(expr)    → page.Eval(expr)                [returns JS result]
browser_screenshot()  → page.Screenshot()              [base64 PNG as MCP image content block]
```

`browser_screenshot()` enables vision-capable AI agents to see the browser. This was a placeholder in the old shim design — it's trivially real via CDP.

## Error Handling

| Scenario | Handling |
|---|---|
| Chromium download fails | `browser-error` JSON on `/ws/browser`; globe button shows error state |
| Chromium crashes after launch | `browser-error` broadcast; `BrowserManager` clears its `*rod.Browser` ref; next open triggers re-launch |
| Second browser pane requested (v1) | sessiond returns error on `create-browser-pane`; client shows toast |
| Frame broadcast buffer full | Non-blocking send — frame dropped silently; client always shows latest received frame |
| Input arrives before page ready | Rod calls are synchronous; they wait for page readiness internally or return a typed error |
| `navigate` to invalid URL | Rod returns error; broadcast `browser-error` JSON |
| sessiond exits | Chromium killed via `browser.Close()`; all `BrowserPage` goroutines stop via `stopCh` |
| MCP tool called with no browser pane open | `bm.GetPage()` returns `nil`; tool returns structured error |

## Cleanup

**Remove entirely:**
- `BrowserPort`, `BrowserPath` fields from `Pane` struct and all wire protocol types
- `server_browser_test.go` (replace with new CDP-based browser tests)
- `browser-tab.mjs` E2E test (replace with new CDP-based E2E)
- `cmd/bridge-poc/` (service worker bridge — not needed)
- Old `surfaceKind: "browser"` handling in frontend

**Keep:**
- `spike/browser-cdp-stream/` as reference implementation (or archive in docs)

## Testing Strategy

**Chromium management:**
- `ChromiumManager.Ensure()` with pinned revision already present: skips download, returns immediately
- `ChromiumManager.Ensure()` with stale revision: downloads and replaces correctly
- Download progress events arrive on `/ws/browser` at non-zero intervals
- Chromium process is killed on sessiond exit (no orphan processes)

**Screencast:**
- JPEG frames arrive on `/ws/browser` within expected latency after Chromium renders
- `Page.screencastFrameAck` is called for every frame (verify no frame stalls in Chromium)
- Frame drop under backpressure: client buffer fill does not block the server goroutine

**Input relay:**
- `mousemove`/`click` events at canvas edges map to correct Chromium viewport coordinates
- `keydown` + `type` sequence for printable chars produces correct input in a `<textarea>`
- `navigate` with no scheme auto-prefixes `https://`
- `history:back` / `history:forward` / `history:reload` sentinel URLs navigate correctly

**URL tracking:**
- `browser-url` JSON is broadcast on every main-frame navigation
- Omnibox updates to reflect the current URL after navigation

**MCP tools:**
- `browser_navigate` + `browser_snapshot` round-trip: navigate to a known page, snapshot returns expected a11y nodes
- `browser_click` on a button fires the correct DOM event
- `browser_screenshot` returns a non-empty base64 PNG

**v1 limit:**
- Second `create-browser-pane` message returns an error; only one pane is created

**Cleanup verification:**
- `surfaceKind: "browser"` (old kind) is absent from all composition messages
- `/cmd/bridge-poc/` directory is gone
- No references to `BrowserPort` or `BrowserPath` in any Go or TypeScript source

## Multi-Window Future

`BrowserManager` with `map[int]*BrowserPage` already supports N windows. Each page is a `*rod.Page` on the shared `*rod.Browser` (one Chromium process, multiple tabs). Lifting from 1 to N windows requires:
- Remove the `maxPages: 1` check in `BrowserManager`
- Update the UI to allow creating multiple browser panes
- Everything else (binary framing, pane ID routing, MCP tools) already works with multiple pane IDs

## Open Questions

- **Touch events relay:** Designed (event type `touch`) but not in v1. Can be added without protocol changes — the binary framing and input message envelope already accommodate new event types.
- **Browser session persistence:** Chromium user data dir is preserved across restarts (it lives in the platform data directory), so cookies and local storage survive muxterm restarts. Full session/tab restoration is out of scope for v1.
- **Authentication:** Not needed — the Chromium process is localhost-only and runs as the same user as muxterm.
- **Multiple simultaneous browser windows:** Architecture supports it; v1 limits to 1. See Multi-Window Future above.
