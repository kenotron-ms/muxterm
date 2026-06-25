# Browser Session Architecture Design

**sessiond Ownership, Focus-Driven Viewport, Multi-Viewer**

## Goal

Redesign the browser CDP pane so that sessiond — not the HTTP server — owns all browser state, giving browser sessions the same persistence guarantees as terminal sessions.

## Background

The existing browser CDP pane (v0.5.3) has a fundamental architectural mistake: the HTTP server process owns the Chromium process, `CDPConn`, and `BrowserManager`. This means browser sessions die whenever the HTTP server restarts, and the entire feature breaks the core muxterm contract:

> "Connect from any machine client to the same URL and get the same session back."

This document redesigns the browser session to match muxterm's existing session model — sessiond owns everything persistent.

### Motivating Use Case

A developer has muxterm open with a coding agent in one terminal pane and `localhost:3000` preview in a browser pane. The preview renders **from the server box** — no tunnels, no ngrok, no Tailscale — because Chromium runs on the same machine as the dev server. This is what Codespaces port forwarding tries to solve with workarounds; muxterm solves it natively.

Additionally, MCP tools can control this browser for headed integration testing — an agent navigates, clicks, fills forms, and takes screenshots. The browser pane is headless-but-observable.

## Design Goals

1. Browser sessions survive HTTP server restarts, redeploys, and client machine switches
2. Cross-client session continuity: navigate `localhost:3000` on a laptop, close it, open on desktop — same page, still running
3. Focus-driven viewport: the focused client's canvas size drives Chromium's render resolution
4. Correct letterbox rendering with accurate coordinate mapping for non-focused viewers
5. Last-focus-wins input authority (single-user tool, no conflict UI)
6. Panel activate reconnect: activating a hidden browser pane tab always resumes correctly

## Architecture

### The Fundamental Shift: sessiond Owns Everything

**Current (wrong):**

```
sessiond ── pane IDs only ──▶ HTTP server ── BrowserManager ── CDPConn ── Chromium
```

**New (correct):**

```
sessiond ── BrowserManager ── CDPConn ── Chromium
    │
    └── daemon socket ── HTTP server ── /ws/browser clients (relay only)
```

| Component | Owner | Lifetime |
|---|---|---|
| **Chromium** | sessiond (child process) | sessiond lifetime — same as PTY processes |
| **CDPConn** | sessiond | sessiond lifetime — managed alongside PTY sessions |
| **BrowserManager** | sessiond | sessiond lifetime — HTTP server holds no reference |
| **HTTP server** | — | Pure relay: forwards JPEG frames and input events, zero browser state |

When the HTTP server restarts, Chromium keeps running. When a client switches machines, they connect to the same HTTP server, which is already connected to the still-running Chromium inside sessiond.

## Components

### sessiond — BrowserManager

- Launches Chromium as a child process when the first browser pane is created
- Owns `CDPConn` and the CDP event loop
- Manages screencast lifecycle (start, pause, resume)
- Handles input authority tracking (last-focus-wins)
- Writes JPEG frames and JSON control messages to the daemon socket
- Reads input and focus events from the daemon socket

### HTTP Server — WebSocket Relay (`ws_browser.go`)

- Opens a daemon socket connection on WebSocket accept
- Subscribes to browser messages for the relevant pane
- Forwards binary frames (`browser-frame`) and JSON events from sessiond to all connected `/ws/browser` clients
- Forwards input events (`browser-input`) and focus signals (`browser-focus`, `browser-blur`) from clients to sessiond
- Holds no `CDPConn`, no Chromium reference, no viewport state
- Assigns a stable `clientId` per WebSocket connection at accept time

### Client — `mux-browser-pane` Component

- Renders frames onto a `<canvas>` element using letterbox math
- Fires `browser-focus` on: first mount (`firstUpdated`), dockview panel activation, and OS window focus
- Fires `browser-blur` on: panel becoming hidden, OS window blur, and component unmount
- Uses a `ResizeObserver` to measure canvas CSS size for rendering math and for `renderWidth`/`renderHeight` in focus events
- Maps mouse coordinates through the letterbox transform before sending input events

## Daemon Protocol Extensions

The existing daemon socket (Unix socket carrying PTY data and control messages) gains new message types. JPEG frames use length-prefixed binary framing — identical to PTY output. Control messages are JSON.

### sessiond → HTTP server (relayed to `/ws/browser` clients)

| Message | Format | Purpose |
|---|---|---|
| `browser-frame` | Binary: `[4-byte paneId][JPEG bytes]` | Screencast frame stream |
| `browser-url` | JSON: `{type, paneId, url}` | Address bar update on navigation |
| `browser-cursor` | JSON: `{type, paneId, cursor}` | CSS cursor style for hover feedback |
| `browser-progress` | JSON: `{type, paneId, percent}` | Chromium page load progress |
| `browser-error` | JSON: `{type, paneId, error}` | Error state surfacing |
| `browser-granted` | JSON: `{type, paneId, clientId}` | Input authority notification |

### HTTP server → sessiond (relayed from `/ws/browser` clients)

| Message | Format | Purpose |
|---|---|---|
| `browser-input` | JSON: `{type, paneId, event}` | Mouse, keyboard, navigate events |
| `browser-focus` | JSON: `{type, paneId, clientId, deviceId, renderWidth, renderHeight}` | Focus claim + viewport size |
| `browser-blur` | JSON: `{type, paneId, clientId, deviceId}` | Focus release |

`deviceId` is a `localStorage` UUID — stable per physical browser session, distinguishing different machines from different tabs on the same machine.

## Data Flow

### Frame path (sessiond → client)

```
Chromium Page.screencastFrame event
  → CDPConn event loop in sessiond
  → base64 decode → raw JPEG bytes
  → daemon socket: [length][4-byte paneId][JPEG]
  → HTTP server relay: read from daemon socket
  → /ws/browser: binary frame to all connected clients
  → client: parse paneId, decode JPEG → drawImage with letterbox math
```

### Input path (client → Chromium)

```
User mouse/keyboard on canvas
  → coordinate mapping: (offsetX - dx) / s, (offsetY - dy) / s
  → /ws/browser: JSON {type: browser-input, paneId, event}
  → HTTP server relay: forward to daemon socket
  → sessiond: route to BrowserPage.HandleInput()
  → CDPConn: Input.dispatchMouseEvent / dispatchKeyEvent → Chromium
```

### Focus/resume path

```
User activates browser pane tab
  → browser-focus {clientId, deviceId, renderWidth, renderHeight}
  → /ws/browser → daemon socket → sessiond
  → sessiond: set Chromium viewport, set input authority, take screenshot
  → screenshot as browser-frame → daemon socket → /ws/browser → canvas
  → screencast resumes → subsequent frames flow normally
```

## Viewport & Focus

### Focus-Driven Viewport

When sessiond receives `browser-focus {renderWidth, renderHeight}`, it immediately calls `Emulation.setDeviceMetricsOverride(renderWidth, renderHeight)` on Chromium. Future frames arrive at that resolution. All other connected clients receive frames at the new resolution and letterbox them independently.

**Focus signal fires on:**
- Component first mount (`firstUpdated`) — with canvas render size
- Dockview panel activation (tab clicked, pane becomes visible)
- OS window `focus` event

### Letterbox Rendering

Canvas fills its container with CSS `width: 100%; height: 100%`. The canvas pixel buffer (`canvas.width`, `canvas.height`) is set to the container's CSS size via `ResizeObserver`, measured locally. Each JPEG frame is drawn maintaining aspect ratio:

```typescript
const s = Math.min(cw / fw, ch / fh);      // uniform scale to fit
const dx = (cw - fw * s) / 2;              // center horizontally (letterbox offset)
const dy = (ch - fh * s) / 2;              // center vertically (letterbox offset)
ctx.clearRect(0, 0, cw, ch);               // clear to background
ctx.drawImage(img, dx, dy, fw * s, fh * s); // draw scaled frame
```

When the focused client's render size matches Chromium's viewport exactly, `s ≈ 1` and `dx = dy = 0` — full resolution, no letterboxing, pixel-perfect.

### Mouse Coordinate Mapping

```typescript
const x_chromium = (e.offsetX - dx) / s;
const y_chromium = (e.offsetY - dy) / s;
// reject if click is in the letterbox bars (x_chromium < 0 or > fw, etc.)
// clamp to [0, fw] × [0, fh] for edge tolerance
```

This replaces the previous `getBoundingClientRect + scaleX/scaleY` approach, which had no letterbox awareness.

The `ResizeObserver` is now local-only — it measures the canvas CSS size for rendering math and for `renderWidth`/`renderHeight` in `browser-focus` events. It no longer sends standalone resize events to the server. Viewport changes only happen as part of focus events.

## Input Authority

**Single rule: last focus wins.**

This is a single-user tool. No conflict detection, no overlays, no explicit claim UI.

**On `browser-focus` received by sessiond:**
- That client immediately becomes the input authority
- Chromium's viewport updates to `renderWidth × renderHeight`
- All other connected clients keep receiving frames (letterboxed if their canvas size differs)
- Input events from non-authority clients are silently dropped

**On `browser-blur` or client disconnect:**
- sessiond clears the authority
- The next `browser-focus` from any client claims it immediately

The viewport update and input authority transfer are atomic — a single `browser-focus` event does both.

## Panel Activate Reconnect

`browser-focus` **is** the reconnect signal. These are not separate concepts.

When a user activates a hidden browser pane tab (clicks it in dockview), the panel-activation event fires `browser-focus` with the client's current canvas render size. sessiond receives it, immediately takes a `Page.captureScreenshot`, and sends that as the first frame. Because Chromium has been running continuously inside sessiond, the screenshot shows exactly where the user left off — same page, same scroll position, same running JavaScript, same network requests in flight.

**dockview integration:**

```
dockview panel tab clicked
  → mux-dock dispatches 'panel-activated' { paneId }
  → mux-browser-pane listens, calls _onPanelActivated()
  → sends browser-focus { clientId, deviceId, renderWidth, renderHeight }
  → sessiond: screenshot → daemon socket → HTTP server → /ws/browser → canvas
```

`browser-ready` (the previous signal name) is retired. The single `browser-focus` event replaces it for first mount, panel activation, and OS window focus.

**`browser-blur` fires when:**
- dockview panel becomes hidden (another tab selected)
- OS window loses focus (`window.addEventListener('blur')`)
- Component unmounts

When authority is released, Chromium keeps running. Screencasting pauses to save resources; it resumes on the next `browser-focus` with an immediate screenshot to cover the gap.

## Error Handling

- **HTTP server restart:** Chromium and CDPConn remain alive in sessiond. HTTP server reconnects to the daemon socket on startup; clients reconnect to `/ws/browser` on WebSocket close — they receive the next `browser-frame` as if nothing happened.
- **Client disconnect:** sessiond clears input authority if the disconnected client held it. Screencast continues (or pauses, per the open question below).
- **Chromium crash:** sessiond detects the child process exit, emits `browser-error` to all connected clients, and can restart Chromium. CDPConn is re-established on restart.
- **Focus event during low-latency frame burst:** viewport change is applied immediately; any in-flight frames at the old resolution are rendered at whatever scale fits — no visual corruption, just a brief letterbox flash.
- **Letterbox boundary clicks:** mouse coordinates outside `[0, fw] × [0, fh]` (i.e., clicks in the black bars) are rejected before dispatch to Chromium.

## What Doesn't Change

| Item | Status |
|---|---|
| `/ws/browser` WebSocket protocol — binary frames + JSON messages | Unchanged |
| Binary frame format: `[4-byte LE paneId][JPEG bytes]` | Unchanged |
| MCP browser tools — route through BrowserManager (now in sessiond) | Same API |
| Chromium binary discovery: PATH → muxterm cache → go-rod cache → download | Unchanged |
| CDP key/mouse event dispatch: `rawKeyDown`, `Input.dispatchMouseEvent` | Unchanged |
| v1 one-browser-window limit — enforced in BrowserManager | Still enforced |

## Migration

The `BrowserManager` currently lives in `internal/sessiond/` but its data (`CDPConn`, Chromium cmd) is consumed directly by the HTTP server via `hub.browserManager`. The migration steps are:

1. **Move Chromium launch** into the sessiond daemon startup path (triggered when the first browser pane is created)
2. **Redirect BrowserManager output** — `broadcast` and `broadcastJSON` callbacks write to the daemon socket instead of performing direct WebSocket fan-out
3. **Convert `ws_browser.go`** from direct `BrowserManager` calls to daemon socket relay (subscribe + forward)
4. **Remove `hub.browserManager`** from `Hub` — the HTTP server holds no browser state after this change

## Testing Strategy

- **Unit:** `BrowserManager` input authority state machine — focus, blur, disconnect sequences
- **Unit:** Letterbox math — verify `s`, `dx`, `dy` for various canvas/frame size combinations; verify coordinate rejection at boundary
- **Integration:** HTTP server restart with active browser session — client reconnects and receives frames without Chromium restart
- **Integration:** Multi-client focus handoff — client A holds focus, client B sends `browser-focus`, verify client B becomes authority and viewport updates
- **Integration:** Panel activate reconnect — hide pane, navigate in another pane, re-activate browser pane, verify screenshot reflects current page state
- **E2E:** MCP browser tools continue to work after HTTP server restart

## Open Questions

- **Screencast when no clients:** When all clients disconnect, should sessiond pause screencasting (saves CPU/bandwidth; Chromium idles cleanly) or keep screencasting (first frame on reconnect is instant)? Lean toward **pause**: resume on first `browser-focus`, take a screenshot immediately, then restart `Page.startScreencast`.

- **Screencast ACK when paused:** If screencasting is paused and a client reconnects, the screenshot covers the gap cleanly. If screencasting runs continuously with zero clients, frames are generated and discarded — wastes CPU and memory bandwidth with no benefit.

- **`browser-granted` client ID:** The HTTP server needs a stable `clientId` per `/ws/browser` connection for focus authority tracking. Use a connection ID assigned at WebSocket accept time, sent back in the `browser-granted` message so the client can confirm it holds authority.
