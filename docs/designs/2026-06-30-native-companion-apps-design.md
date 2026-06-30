# Native Companion Apps for muxterm (Swift + Android) + Browser Pane Re-architecture

## Goal

Build a pair of native companion client apps — Swift for Apple platforms (macOS/iOS) and native Kotlin/Android — that connect to muxterm's existing sessiond/WebSocket contract, replace the server-side CDP/Chromium browser pane with a client-rendered-but-server-drivable native webview, and use embedded SSH to make remote dev boxes feel local.

## Background

muxterm already exposes a frozen client contract over WebSocket:

- `/ws` for terminal control — a JSON `Message` protocol (list/create/attach workspaces; create/close/resize panes) plus binary PTY frames framed as `[4-byte LE paneId][VT bytes]`.
- `/ws/browser` (today) for CDP browser JPEG screencast.

The server streams **raw VT byte streams** (not a parsed cell grid); the web client uses xterm.js to parse and render them. Authentication today: localhost callers need no token; remote callers need a 30-second HMAC token obtainable **only** from a localhost `/api/token` endpoint.

This design **removes** the server-side CDP browser shipped in v0.6.0 and replaces it with the native-webview model described below. The native apps are thin clients that speak the existing protocol; the only server-side work in the entire project is the CDP removal.

## Approach

We considered three approaches and chose **Approach 1: "One pipe, native shells over a shared protocol spec."** Native apps are thin clients speaking the existing protocol, defined by a written `muxterm-client-protocol.md` spec — **not** a shared binary or UniFFI core. Each app implements the contract natively.

| Approach | Summary | Decision |
|----------|---------|----------|
| 1. Native shells over a written protocol spec | Each app implements `muxterm-client-protocol.md` natively; no shared client binary | **Chosen** |
| 2. gomobile / UniFFI shared core | One shared client core compiled to both platforms | Rejected — over-engineered for only 2 platforms |
| 3. Per-port public ngrok/devtunnel tunnels | Expose each port via a public tunnel | Rejected by user — not unified |

**One surgical exception to "no shared binary":** the terminal-emulation core **is** shared, via **libghostty-vt** — a single shared core for only the hard, platform-agnostic VT engine. Everything else is implemented natively per platform.

## Architecture

### Section 1 — Topology & Connection Model

- **Two targets, one code path.** Everything resolves to `localhost:PORT` on the client device, so the app never knows local vs remote.
- **Local target** (e.g. macOS app ↔ local sessiond): connect directly to `localhost:<muxport>`, no SSH.
- **Remote target:** the app opens an **embedded SSH session** and sets up forwards. Local vs remote is 100% a **client** concern — the server learns nothing and changes nothing. By the time a connection reaches muxterm it is **always** a loopback WebSocket.
- **Reachability is the one thing muxterm does NOT own.** NAT'd boxes need something to make the SSH port reachable (a public box, corp VPN, or Tailscale). muxterm **detects** unreachability and points the user to that fix; it does not build NAT traversal.

**Ownership:**

| Client owns | Server owns (unchanged) |
|-------------|--------------------------|
| Pick local/remote | Serve `/ws` |
| Open SSH + forwards | Panes, PTY |
| Resolve to `localhost:PORT` | Treat localhost as trusted |

**The auth dividend.** A single `-L` forward of muxterm's control port to a device loopback port means muxterm sees a loopback client → the existing "localhost = no token" rule applies → **SSH keys become the auth.** We design **no** new token or pairing scheme. The legacy 30-second HMAC token stays for the legacy web case; native never uses it.

**A "Connection" is the unit.** A saved list of `{name, target (local | remote: host + SSH creds/agent), remembered forwards}`. Tapping a connection establishes SSH (if remote), brings up forwards, opens `/ws`, and attaches.

### Section 1 (revised) — Two channels over ONE embedded SSH session

- **Control plane** → a single `-L` forward (muxterm control port → device loopback port); `/ws` connects there; preserves the auth dividend. One known port, dead simple.
- **Browser plane** → a **SOCKS proxy over SSH** (the cmux pattern): the app runs a tiny local SOCKS5 listener that maps each connection to an SSH `direct-tcpip` channel to the **remote's** `localhost:port`. The webview is pointed at that SOCKS proxy, so `http://localhost:3000` in the browser pane hits the dev box's `localhost:3000` — **any** port, no enumeration, no path-rewriting, clean origin.
  - **Apple:** `WKWebView` via `WKWebsiteDataStore.proxyConfigurations` (iOS 17+/macOS 14+, scoped to that webview's data store).
  - **Android:** `androidx.webkit` `ProxyController` (process-global; documented limitation).
  - **Local target** skips SSH and SOCKS entirely.

### Section 2 — Native App Architecture & Shared Protocol Contract

The contract is a **written spec**, `muxterm-client-protocol.md`, covering:

- The frozen `Message` JSON types.
- `[4-byte LE paneId][payload]` binary framing.
- The bootstrap sequence `config → workspace-list → attach → composition → replay → live`.
- The new browser-control messages (Section 4).

Each app implements it natively. There is **no shared client binary**.

**Five bricks per platform:**

| Brick | Responsibility | Apple | Android |
|-------|----------------|-------|---------|
| Connection Manager | Local/remote, SSH forwarding, reconnect | SwiftNIO SSH | sshj / MINA sshd |
| Protocol Client | Encode/decode `Message` + binary frames, CID correlation | URLSessionWebSocketTask | OkHttp WebSocket |
| Terminal Pane | Render cell grid (see Section 3) | Metal / CoreGraphics | Compose Canvas |
| Browser Pane | Client-rendered webview | WKWebView | Android WebView |
| Workspace/Layout UI | Workspace + pane layout | SwiftUI / AppKit | Jetpack Compose |

- Only the **Connection Manager** varies in **behavior** across platforms; the Protocol Client is a mechanical port; panes are dumb renderers fed by the Protocol Client.
- UI consumes a platform-agnostic state model `{workspaces[], panes[], activePaneId, layout}` — the same shape as the web `MuxStore`.
- **Layout is opaque.** The server stores `layout` as opaque dockview JSON. Native apps do **not** reuse dockview — each defines its own native layout encoding and round-trips it through the `layout` field, keyed by `breakpoint`. Per-client layout is accepted (a web-created pane won't auto-place in native tiling).

**Terminal-core revision.** Use **libghostty-vt** as the shared cross-platform terminal core (replacing the earlier "SwiftTerm + a Kotlin lib" idea). It is the **VT parser / screen-state core only** — **not** the full GPU embedding API (which is macOS/iOS-only, unstable, and has no Android support). It is consumed via FFI (Swift) / JNI (Kotlin); the host renders the cell grid natively.

- **Proven on Android** by Chuchu (Kotlin + Compose + JNI + Zig).
- **Risk:** libghostty-vt's API is pre-1.0 / churning and drags a Zig toolchain into CI. **Mitigation:** pin a commit, vendor it, and wrap it behind our own stable interface.
- **Reference:** cmux (manaflow-ai/cmux, GPL-3.0, Swift/AppKit, embeds libghostty) is a close analog — **study the patterns, do not copy GPL code.**

### Section 3 — Terminal Pane: Data Flow & Rendering

The pane is a **dumb renderer** fed by the Protocol Client; it never touches the network. This is a **faithful port of the web client's terminal-registry state machine**, verified against `web/src`.

**Inbound:** binary frames `[4-byte LE paneId][VT bytes]`; the Protocol Client demultiplexes by paneId and feeds raw VT bytes to that pane's libghostty-vt instance, which parses to a cell-grid + scrollback; the platform view (Metal/CoreGraphics on Apple, Compose Canvas on Android) draws the grid. **We render; libghostty-vt parses only.**

**Replay settle barrier** (real in the web client today — port it faithfully):

- `composition` carries each pane's `totalSeq` (the exact replay byte count).
- The pane feeds replay bytes into a fresh instance and counts bytes (`seqBytes`).
- It gates **both** user input (via a `ready` flag) **and** the drain to the renderer until `seqBytes >= expectedReplayBytes`.
- Incoming bytes are queued in `pendingData` and keystrokes suppressed while not ready.
- A **hard 3-second timeout escape** (web client label `RC-1`) drains partial replay so a byte-count mismatch can't lock the pane forever.

**Outbound:**

- Keystrokes → encoded to VT input bytes, sent as `[4-byte LE paneId][bytes]`. **Key encoding is ours to own** (modifiers/arrows/function keys/IME); libghostty-vt does **not** encode input. Build a small per-platform keymap with its own test suite.
- Resize → a `resize` JSON Message (paneId, cols, rows), fire-and-forget, idempotent (skip if unchanged).

**Sizing:** cols/rows are derived from the **view** (measure cell size for the current font, divide the pane's pixel box), not the server. Each client sizes independently; the daemon reconciles multi-client attaches; hidden/detached panes stop sending resize ("active-view-wins").

**Reconnect semantics** (matches the web client's `resetForReattach`): do **not** dispose/reset the emulator. Reset **only** the settle state — `ready=false`, `seqBytes=0`, `expectedReplayBytes=0`, `generation++` (to cancel in-flight write callbacks), `pendingData=[]`. The existing scrollback buffer is preserved; re-send `attach`; fresh replay drains into the existing buffer. Backoff: `min(1000·2^n, 30000) + jitter`.

**Design principle:** the `RC-*` labels are scar tissue from real race fixes. Port the behavior rather than rediscover the races on two new platforms.

### Section 4 — Browser Pane: client-rendered, server-drivable ("playwright-cli")

This **inverts** the old CDP model.

- **Engine on the client, control from the server.** The webview (WKWebView / Android WebView) renders on-device — real engine, real DOM, real cookies/WebSockets. The server holds **no engine**; it holds a lightweight browser-pane **handle** (pane id, owning/focused client, last-known URL) and **relays commands** to the client owning the pane.
  - Old CDP: server rendered + streamed pixels.
  - New model: client renders, server sends high-level commands.

- **One executor mechanism — JS injection.** Every manipulation compiles to a native nav call or evaluated JavaScript (identical across Apple and Android — this is how playwright/agent-browser drive a page):

| Action | Mechanism |
|--------|-----------|
| navigate / back / forward / reload | native `load()` / `goBack()` / `goForward()` |
| click, mousedown/up, drag, scroll, touch | injected JS dispatching synthetic `Pointer`/`Mouse`/`TouchEvent` at coords or on an element |
| inject JS | `evaluateJavaScript` / `evaluateJavascript`, result returned |

- **Reaching the dev server (remote):** the webview routes through the SOCKS-over-SSH proxy (Section 1 revised), so `localhost:PORT` resolves to the dev box. Local target: no proxy.
- **Port discovery:** reuse muxterm's existing listening-port tracking (sidebar "listening ports" / tunnels enumeration) and surface live ports as tappable suggestions; manual URL entry is always available.

**Protocol (small, rides `/ws`):**

| Message | Direction | Payload |
|---------|-----------|---------|
| `browser-command` | server → client | `{paneId, cid, action, params}` |
| `browser-result` | client → server | `{cid, result \| error}` |
| `browser-url` / `browser-load` | client → server | events |

Correlation reuses the existing `cid`.

- **MCP surface:** these become the muxterm MCP browser tools — realizing the "Phase 5 playwright-cli" already stubbed in the MCP server. An agent calls a tool → the server relays to the focused client → the client executes against the live webview → the result flows back.
- **Pane model:** a browser pane is a first-class pane type in the layout but carries a lightweight server-side **handle** (so the server can route commands and track the owner) and is client-rendered. The client layout model distinguishes server-backed panes (terminals) from client-rendered browser panes.
- **Load-bearing constraint:** the only browser engine is the client's, so a browser pane is **drivable only while a client is attached and focused on it** (multi-client → last-focus-wins authority, reusing the existing `browser-granted` concept). There is **no** server-side headless fallback — that is the deliberate cost of killing server Chromium. Agent and human drive the **same** live browser.
- **Out of scope (YAGNI):** no DOM-snapshot/accessibility-tree automation framework beyond the JS-injection command set above; can be a later design.

### Section 5 — CDP Removal Scope & What the Web Becomes

This is the demolition half of the design. The *concepts* (pane id, focus authority) carry forward into the new model, so it's a stepping stone, not waste.

**Delete (server side):**

- sessiond's Chromium ownership: `browser_chromium.go`, `browser_cdp.go`, `BrowserManager`, and the launch/teardown on `TypeCreate` / `CloseBrowserPane`.
- The JPEG screencast path: `FrameBrowserData` (0x03), `broadcastBrowserData`, the `/ws/browser` streaming handler, and all viewport/screencast-resize machinery.

**Delete (web side):**

- `mux-browser-pane.ts` (the canvas JPEG renderer), `browser-registry`, `BrowserSocket`. The web frontend **loses the browser tab entirely** — a browser-based client can't host a cross-origin webview (iframe/CSP), and that was the whole reason CDP existed. Per user decision, web users who want a browser open their own tab.

**Keep / repurpose:**

- The **focus-authority concept** (`browser-granted`, last-focus-wins) — re-aimed from "who gets pixels" to "who executes commands."
- The **pane-type marker** — `surfaceKind` flips from `"browser-cdp"` (server-rendered) to `"browser"` (client-rendered handle).
- The new control protocol (`browser-command` / `browser-result` / `browser-url`) from Section 4 replaces the deleted screencast messages.

**MCP continuity:** the existing `create_pane kind=browser` + the stubbed "Phase 5 playwright-cli" now resolve against native clients. With no native client attached, browser MCP tools **fail loud** (Section 4's constraint), not silently.

**Net:** the server gets *smaller* (no Chromium, no CDP, no JPEG), the web gets *smaller* (no canvas browser), and the browser capability moves entirely to native clients + a thin command relay.

## Data Flow

1. The user taps a saved **Connection**. If remote, the Connection Manager establishes one embedded SSH session, brings up the `-L` control forward and the SOCKS browser channel; if local, it connects directly.
2. The Protocol Client opens `/ws` against the device loopback port and runs the bootstrap sequence: `config → workspace-list → attach → composition → replay → live`.
3. **Terminal panes:** binary frames arrive, are demultiplexed by paneId, parsed by libghostty-vt, and drawn natively; the settle barrier gates input and rendering until replay completes (or the 3s escape fires). Keystrokes and resize flow back outbound.
4. **Browser panes:** the webview renders on-device (routed through SOCKS for remote). `browser-command` messages arrive over `/ws`, the client executes them via native nav or JS injection, and `browser-result` / `browser-url` / `browser-load` flow back — correlated by `cid`. Agents reach the same path via MCP tools.

## Error Handling

**Principle: fail loud, fail scoped.** One pane's failure never takes down the connection; one connection's failure never takes down the app. Every error is typed and surfaced, never swallowed.

**Connectivity (Connection Manager):**

- **SSH dial fails / host unreachable** → typed error + reachability hint; no infinite silent retry.
- **SSH auth fails** → explicit "key rejected" naming the key/agent tried; **no** fallback to the legacy HMAC token.
- **`/ws` drops** → exponential backoff `min(1000·2^n, 30000) + jitter`, reconnect overlay, then `attach` + the settle-barrier re-drain.
- **SOCKS channel fails** → browser pane shows a load error; terminal control is unaffected (separate channel, same SSH session).

**Browser control:**

- **Command to an unattached/unfocused pane** → `browser-result` typed error `no-client-attached`; MCP tool fails loud; no queuing, no headless fallback.
- **`evaluateJavaScript` throws / times out** → error in `browser-result.error` with the JS exception; bounded timeout so an agent can't hang.
- **Authority contention** → last-focus-wins; a non-authority command is rejected with `not-authority`.

**Terminal:**

- **`totalSeq` never reached** → the 3-second `RC-1` timeout escape drains partial replay.
- **libghostty-vt panic / FFI error** → wrapped at our interface boundary; degrades that one pane (error state + offer reattach), never crashes the app.

## Verification Approach

Testing splits along the same boundary as the system: **protocol/logic gets real automated tests; native rendering gets thinner, targeted coverage.** Per the "verify with reality" principle, the high-value layers run against real processes, not mocks.

1. **Protocol conformance (highest value).** A language-agnostic conformance fixture set for `muxterm-client-protocol.md` — recorded byte sequences for the full bootstrap, binary frame encode/decode, `cid` correlation, and `browser-command`/`result` round-trips. **Both** native Protocol Clients run these fixtures.
2. **Terminal settle-barrier state machine.** Port the web client's `RC-*` scenarios as unit tests against the libghostty-vt wrapper on **each** platform — `totalSeq` exact, overshoot, the 3s timeout escape, and reattach mid-replay (generation counter cancels stale writes).
3. **Connection Manager (real execution, no mocked SSH).** CI stands up a real sessiond + a real SSH server; assert the `-L` forward yields a working `/ws` (and the loopback auth dividend), and that the SOCKS channel reaches a test HTTP server on the remote's localhost.
4. **Browser control.** Headless-webview tests per action (navigate, click via injected JS, evalJS, scroll) against a fixture page returning the expected `browser-result`; plus the negative paths (`no-client-attached`, `not-authority`, JS-throw).
5. **Manual / exploratory.** Cell-grid rendering fidelity, IME, touch scrolling, and gesture feel — checklisted per platform.

**Out of scope:** no end-to-end native UI automation harness initially (YAGNI; add if churn justifies it).

## Open Questions

- Whether a tagged/ABI-frozen libghostty-vt release exists yet (mid-2026 roadmap target, unconfirmed) — affects the pin/vendor strategy.
- The Android WebView SOCKS proxy is process-global (`ProxyController`) — acceptable now, but revisit if multiple independent browser panes need different proxies.
- Sequencing of the three deliverables (CDP removal, first native platform, second native platform) — to be decided in planning.
- Exact reachability UX for NAT'd hosts (how strongly to recommend/deep-link Tailscale).
