# Sidebar + Tunnels Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Replace the bottom workspace dock bar on wide screens with a resizable left sidebar (Workspaces + Tunnels tabs), and replace the broken browser pane surface with a proper port-forwarding tunnel system.

**Architecture:** Left sidebar (`mux-sidebar.ts`) renders conditionally on `≥768px` viewports; the existing `mux-dock-bar` stays for `<768px`. Tunnels are managed by a new in-memory `TunnelRegistry` in the HTTP server layer, exposed via six new WebSocket message types and a `/t/{id}/` reverse-proxy route.

**Tech Stack:** Go 1.24 (backend), TypeScript + Lit 3 (frontend), no Radix UI — custom Lit tabs only.

---

## READ THIS FIRST

- **No unit tests.** AGENTS.md bans them. Verification is `make build` + `playwright-cli` in a real browser. Do NOT create any `*.test.ts` or `*_test.go` files.
- **Build gate** (run before every commit, must pass with 0 errors):
  ```bash
  go build ./... && cd web && npm run check:fast
  ```
- **Full build:** `make build` (compiles Go binary + frontend bundle)
- **Run:** `./bin/muxterm serve --addr 127.0.0.1:9090`
- **Check:** `cd web && npm run check:fast` — oxlint + tsgo, 0 errors required
- **Store reactivity pattern** used in all Lit components:
  ```typescript
  @state() private _version = 0;
  private _unsub: (() => void) | null = null;
  override connectedCallback() {
    super.connectedCallback();
    this._unsub = store.subscribe(() => { this._version++; });
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
  }
  override render() {
    void this._version; // triggers re-render on store change
    // ...
  }
  ```
- **`mux-undo-toast` API** (read `web/src/components/mux-undo-toast.ts` carefully):
  - Properties: `.paneId` (Number), `.paneTitle` (String), `.duration` (Number, default 10000)
  - Emits: `pane-close-resolved` with `detail: { paneId: number }` (bubbles + composed)
  - Shows label as `"{paneTitle} closed"`, countdown seconds, Undo button
- **`mux-dock-bar` is already imported and mounted in `app.ts`** (line 15 import, lines 547-553 render). The TODO comment in its source file is stale. Task 5 makes it conditional.
- **`_onWorkspaceRename` already exists in `app.ts`** using `store.mutate`. Sidebar just emits `workspace-rename` with the right detail shape.
- **`workspaceLabel(ws)` utility** lives in `web/src/components/workspace-picker.ts`.

---

## Task 1: Delete browser pane + remove proxy routes

**What:** Remove the browser surface component, its test file, browser-pane event handlers from app.ts, browser-related socket methods from ws.ts, and the `/p/`, `/x/`, `/p/sw.js`, `/sw.js` routes from server.go. Keep `internal/proxy/proxy.go` intact — it has tests and the functions are inert once the routes are removed.

**Files:**
- Delete: `web/src/components/browser-surface.ts`
- Delete: `web/src/__tests__/browser-surface.test.ts` (tests a deleted component; remove it)
- Modify: `web/src/app.ts`
- Modify: `web/src/ws.ts`
- Modify: `internal/server/server.go`

### Step 1: Delete browser surface files

```bash
rm web/src/components/browser-surface.ts
rm web/src/__tests__/browser-surface.test.ts
```

### Step 2: Modify `web/src/app.ts`

Remove the browser-surface import (line 21):
```typescript
// DELETE this line:
import './components/browser-surface.js';
```

In `connectedCallback()`, remove these four listener registrations:
```typescript
// DELETE these four lines:
this.addEventListener('browser-pane-open', this._onBrowserPaneOpen);
this.addEventListener('pane-navigate', this._onPaneNavigate);
window.addEventListener('browser-action', this._onBrowserAction);
this.addEventListener('browser-action-result', this._onBrowserActionResult);
```

In `disconnectedCallback()`, remove their corresponding removals:
```typescript
// DELETE these four lines:
this.removeEventListener('browser-pane-open', this._onBrowserPaneOpen);
this.removeEventListener('pane-navigate', this._onPaneNavigate);
window.removeEventListener('browser-action', this._onBrowserAction);
this.removeEventListener('browser-action-result', this._onBrowserActionResult);
```

Delete the four handler methods entirely (`_onBrowserPaneOpen`, `_onPaneNavigate`, `_onBrowserAction`, `_onBrowserActionResult`):
```typescript
// DELETE these entire methods:
private _onBrowserPaneOpen = (e: Event): void => { ... };
private _onPaneNavigate = (e: Event): void => { ... };
private _onBrowserAction = (e: Event): void => { ... };
private _onBrowserActionResult = (e: Event): void => { ... };
```

Also in `_onLayoutCommand`: the handler calls `this._dock?.handleLayoutCommand(msg)` which references browser-action. Keep `_onLayoutCommand` as-is (the dock's `handleLayoutCommand` can stay; just the event registration cleanup above is needed).

### Step 3: Modify `web/src/ws.ts`

Delete three methods that are browser-pane-only:
```typescript
// DELETE createBrowserPane() method entirely
/** Create a browser-surface pane. path defaults to '/' when falsy. */
createBrowserPane(port: number, path: string = '/', clientRef?: string): void { ... }

// DELETE updatePanePath() method entirely
/** Update the browser path for an existing browser pane. */
updatePanePath(paneId: number, browserPath: string): void { ... }

// DELETE sendBrowserActionResult() method entirely
/** Send a browser-action-result envelope back to the server. */
sendBrowserActionResult(detail: Record<string, unknown>): void { ... }
```

### Step 4: Modify `internal/server/server.go`

Remove the four proxy-route registrations and `handleCreatePane`:

```go
// DELETE these five lines from New():
s.mux.HandleFunc("GET /sw.js", func(w http.ResponseWriter, r *http.Request) {
    proxy.ServeServiceWorker(w, r)
})
s.mux.HandleFunc("GET /p/sw.js", func(w http.ResponseWriter, r *http.Request) {
    proxy.ServeAgentServiceWorker(w, r)
})
s.mux.Handle("/p/", proxy.NewHandler("localhost", nil))
s.mux.Handle("/x/", proxy.NewExternalHandler())

// DELETE this route too (creates browser panes via REST):
s.mux.HandleFunc("POST /api/pane", s.handleCreatePane)
```

Remove the `proxy` import since it's no longer used:
```go
// DELETE from the import block:
"github.com/kenotron-ms/muxterm/internal/proxy"
```

Delete the `createPaneRequest` struct and `handleCreatePane` method at the bottom of server.go:
```go
// DELETE:
type createPaneRequest struct { ... }
func (s *Server) handleCreatePane(w http.ResponseWriter, r *http.Request) { ... }
```

Also delete the `sessiond` import if the only use was in `handleCreatePane` (check: `sessiond.TypePaneCreated` is used there). After deleting `handleCreatePane`, if `sessiond` import becomes unused, remove it.

### Step 5: Build gate

```bash
go build ./... && cd web && npm run check:fast
```

Fix any type errors. The `SessiondMessage` type still has browser-related fields (`surfaceKind`, `browserPort`, `browserPath`, `proxyHeaders`) — leave them; removing them would break the frozen protocol type.

### Step 6: Verify

```bash
make build
./bin/muxterm serve --addr 127.0.0.1:9090 &
sleep 2
# Verify app loads without console errors
playwright-cli open http://localhost:9090
playwright-cli snapshot
playwright-cli close
# Verify removed routes 404
curl -s -o /dev/null -w "%{http_code}" http://localhost:9090/p/5173/   # expect 404
curl -s -o /dev/null -w "%{http_code}" http://localhost:9090/x/google.com/  # expect 404
pkill -f 'muxterm serve'
```

Expected: app loads cleanly, `/p/` and `/x/` return 404.

### Step 7: Commit

```bash
git add -A && git commit -m "feat: remove browser pane surface and proxy routes"
```

---

## Task 2: Tunnel backend (Go)

**What:** Add tunnel type constants to the protocol file, add a `TunnelRegistry` in the HTTP server layer, handle tunnel WebSocket messages in `ws.go`, and register the `/t/{id}/` reverse-proxy route in `server.go`.

**Files:**
- Modify: `internal/sessiond/protocol.go` (add 6 type constants + `TunnelInfo` struct + 3 fields on `Message`)
- Create: `internal/server/tunnel.go` (new `TunnelRegistry`)
- Modify: `internal/server/ws.go` (handle tunnel WS messages)
- Modify: `internal/server/server.go` (add `tunnels` field, `/t/` route, `handleTunnelProxy`)

### Step 1: Modify `internal/sessiond/protocol.go`

Add tunnel type constants at the end of the existing `const` block (after `TypeError = "error"`):

```go
// Tunnel requests (client → daemon via HTTP relay)
TypeCreateTunnel = "create-tunnel"
TypeCloseTunnel  = "close-tunnel"
TypeListTunnels  = "list-tunnels"

// Tunnel replies / events
TypeTunnelCreated = "tunnel-created"
TypeTunnelClosed  = "tunnel-closed"
TypeTunnelList    = "tunnel-list"
```

Add `TunnelInfo` struct after the `PaneInfo` struct at the bottom of `protocol.go`:

```go
// TunnelInfo describes one active port-forwarding tunnel.
// Used in tunnel-list replies and tunnel-created/closed events.
type TunnelInfo struct {
    ID   string `json:"id"`
    Port int    `json:"port"`
}
```

Add three fields to the `Message` struct (after the existing `OK bool` field):

```go
// Tunnel fields (create-tunnel / tunnel-created / tunnel-closed / tunnel-list)
TunnelID   string       `json:"tunnelId,omitempty"`
TunnelPort int          `json:"tunnelPort,omitempty"`
Tunnels    []TunnelInfo `json:"tunnels,omitempty"`
```

### Step 2: Create `internal/server/tunnel.go`

```go
package server

import (
	"fmt"
	"math/rand"
	"strings"
	"sync"
)

const (
	tunnelIDChars = "abcdefghijklmnopqrstuvwxyz0123456789"
	tunnelIDLen   = 5
)

// TunnelRegistry is a thread-safe in-memory map of short ID → local port.
// Tunnels are ephemeral: they exist only while the server is running.
type TunnelRegistry struct {
	mu      sync.RWMutex
	tunnels map[string]int // id → port
}

// NewTunnelRegistry returns an empty registry.
func NewTunnelRegistry() *TunnelRegistry {
	return &TunnelRegistry{tunnels: make(map[string]int)}
}

// Create registers a new tunnel for the given local port and returns its
// randomly-generated short ID. Returns an error if a unique ID cannot be
// generated within 20 attempts (astronomically unlikely with a 36^5 space).
func (r *TunnelRegistry) Create(port int) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for range 20 {
		id := tunnelGenID()
		if _, exists := r.tunnels[id]; !exists {
			r.tunnels[id] = port
			return id, nil
		}
	}
	return "", fmt.Errorf("tunnel: could not generate unique ID after 20 attempts")
}

// Close removes the tunnel with the given ID. Returns false if not found.
func (r *TunnelRegistry) Close(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.tunnels[id]; !ok {
		return false
	}
	delete(r.tunnels, id)
	return true
}

// Port returns the local port for a tunnel ID, and false if not found.
func (r *TunnelRegistry) Port(id string) (int, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.tunnels[id]
	return p, ok
}

// List returns all current tunnels as a slice. Order is not guaranteed.
func (r *TunnelRegistry) List() []tunnelInfoServer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]tunnelInfoServer, 0, len(r.tunnels))
	for id, port := range r.tunnels {
		out = append(out, tunnelInfoServer{id: id, port: port})
	}
	return out
}

type tunnelInfoServer struct {
	id   string
	port int
}

func tunnelGenID() string {
	var b strings.Builder
	b.Grow(tunnelIDLen)
	for range tunnelIDLen {
		b.WriteByte(tunnelIDChars[rand.Intn(len(tunnelIDChars))])
	}
	return b.String()
}
```

### Step 3: Add `tunnels` to `Hub` and expose it from `Server`

In `internal/server/ws.go`, find the `Hub` struct definition and add the `tunnels` field. The Hub struct is defined in `ws.go` — look for `type Hub struct {` and add:

```go
tunnels *TunnelRegistry
```

Find the `NewHub` constructor in `ws.go` and initialize the field:

```go
// In NewHub(), add:
tunnels: NewTunnelRegistry(),
```

### Step 4: Add tunnel message handlers to `handleTextInput` in `internal/server/ws.go`

At the end of the `switch msg.Type {` block in `handleTextInput`, before the `default:` case, add:

```go
case sessiond.TypeCreateTunnel:
    id, err := c.hub.tunnels.Create(msg.TunnelPort)
    if err != nil {
        c.sendError(msg.CID, "", err)
        return
    }
    c.sendMessage(&sessiond.Message{
        Type:       sessiond.TypeTunnelCreated,
        CID:        msg.CID,
        TunnelID:   id,
        TunnelPort: msg.TunnelPort,
    })

case sessiond.TypeCloseTunnel:
    ok := c.hub.tunnels.Close(msg.TunnelID)
    if !ok {
        c.sendError(msg.CID, "", fmt.Errorf("tunnel %q not found", msg.TunnelID))
        return
    }
    c.sendMessage(&sessiond.Message{
        Type:     sessiond.TypeTunnelClosed,
        CID:      msg.CID,
        TunnelID: msg.TunnelID,
    })

case sessiond.TypeListTunnels:
    list := c.hub.tunnels.List()
    tunnels := make([]sessiond.TunnelInfo, len(list))
    for i, t := range list {
        tunnels[i] = sessiond.TunnelInfo{ID: t.id, Port: t.port}
    }
    c.sendMessage(&sessiond.Message{
        Type:    sessiond.TypeTunnelList,
        CID:     msg.CID,
        Tunnels: tunnels,
    })
```

### Step 5: Modify `internal/server/server.go`

Add `tunnels *TunnelRegistry` field to the `Server` struct:

```go
type Server struct {
    addr    string
    secret  string
    noAuth  bool
    mux     *http.ServeMux
    hub     *Hub
    tunnels *TunnelRegistry  // ← add this
}
```

In `New()`, initialize it and wire it to the Hub:

```go
s := &Server{
    addr:    cfg.Addr,
    secret:  cfg.Secret,
    noAuth:  cfg.NoAuth,
    mux:     http.NewServeMux(),
    hub:     NewHub(nil),
    tunnels: NewTunnelRegistry(),  // ← add this
}
s.hub.tunnels = s.tunnels  // ← wire shared registry to hub
```

Register the tunnel proxy route (add after the `/api/token` line):

```go
s.mux.HandleFunc("/t/", s.handleTunnelProxy)
```

Add the `handleTunnelProxy` method at the bottom of `server.go`:

```go
// handleTunnelProxy routes /t/{id}/... → localhost:{port}/...
// No authentication check here — the ID itself is a shared secret (base36, 5-char, ephemeral).
// For future hardening: validate an HMAC token in the query string.
func (s *Server) handleTunnelProxy(w http.ResponseWriter, r *http.Request) {
    // Extract tunnel ID from /t/{id}/rest
    tail := strings.TrimPrefix(r.URL.Path, "/t/")
    slashIdx := strings.IndexByte(tail, '/')
    var id string
    if slashIdx < 0 {
        id = tail
    } else {
        id = tail[:slashIdx]
    }
    if id == "" {
        http.Error(w, "missing tunnel id", http.StatusBadRequest)
        return
    }
    port, ok := s.tunnels.Port(id)
    if !ok {
        http.NotFound(w, r)
        return
    }

    // Rewrite the path: strip /t/{id} prefix before forwarding
    r2 := r.Clone(r.Context())
    if slashIdx < 0 {
        r2.URL.Path = "/"
    } else {
        r2.URL.Path = tail[slashIdx:]
    }
    if r2.URL.Path == "" {
        r2.URL.Path = "/"
    }
    r2.URL.RawPath = ""

    target, _ := url.Parse(fmt.Sprintf("http://localhost:%d", port))
    httputil.NewSingleHostReverseProxy(target).ServeHTTP(w, r2)
}
```

Add the required imports to server.go:
```go
"fmt"
"net/http/httputil"
"net/url"
"strings"
```

### Step 6: Build gate

```bash
go build ./...
```

Fix any compile errors. Pay attention to:
- `tunnelInfoServer` is unexported (lowercase) — only used within the `server` package
- The `tunnels` field on Hub must be set before any requests come in (it's set in `New()`)
- `for range 20 {` requires Go 1.22+ (this project uses Go 1.24, so it's fine)

### Step 7: Verify

```bash
make build
./bin/muxterm serve --addr 127.0.0.1:9090 &
sleep 2
# Unknown tunnel ID → 404
curl -s -o /dev/null -w "%{http_code}" http://localhost:9090/t/notfound/
# → should print 404
pkill -f 'muxterm serve'
```

Expected: `404`.

### Step 8: Commit

```bash
git add -A && git commit -m "feat: tunnel registry, /t/{id}/ proxy route, WS message types"
```

---

## Task 3: Tunnel TypeScript types + ws.ts methods + state + app wiring

**What:** Add tunnel types to `types.ts`, add `createTunnel`/`closeTunnel`/`listTunnels` methods to `ws.ts`, add tunnel state to `state.ts`, and handle incoming tunnel messages in `app.ts`.

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/ws.ts`
- Modify: `web/src/state.ts`
- Modify: `web/src/app.ts`

### Step 1: Modify `web/src/types.ts`

Add tunnel type constants to `SessiondType` (inside the `as const` object, after the existing entries):

```typescript
// Tunnel requests (client → server)
CreateTunnel: 'create-tunnel',
CloseTunnel:  'close-tunnel',
ListTunnels:  'list-tunnels',
// Tunnel replies / events
TunnelCreated: 'tunnel-created',
TunnelClosed:  'tunnel-closed',
TunnelList:    'tunnel-list',
```

Add `TunnelInfo` interface (after the `SessiondPaneInfo` interface):

```typescript
export interface TunnelInfo {
  id: string;
  port: number;
}
```

Add three optional fields to `SessiondMessage` (after the existing `offsets` field):

```typescript
tunnelId?: string;
tunnelPort?: number;
tunnels?: TunnelInfo[];
```

### Step 2: Modify `web/src/ws.ts`

Add three public tunnel methods (add after the `closePane` method):

```typescript
/** Create a tunnel forwarding the given local port. Reply: tunnel-created. */
createTunnel(port: number): void {
  this.sendSessiond({ type: SessiondType.CreateTunnel, tunnelPort: port });
}

/** Close an existing tunnel by ID. Reply: tunnel-closed. */
closeTunnel(id: string): void {
  this.sendSessiond({ type: SessiondType.CloseTunnel, tunnelId: id });
}

/** Request the current tunnel list. Reply: tunnel-list. */
listTunnels(): void {
  this.sendSessiond({ type: SessiondType.ListTunnels });
}
```

Note: `sendSessiond` is `private` — the new methods above call it correctly since they are in the same class.

### Step 3: Modify `web/src/state.ts`

Import `TunnelInfo` at the top (add to existing import from `./types`):

```typescript
import type { TunnelInfo, SessiondMessage, SessiondWorkspaceInfo, SessiondPaneInfo } from './types';
import { SessiondType } from './types';
```

Add private `_tunnels` field to `MuxStore` class (after the existing private fields):

```typescript
private _tunnels: TunnelInfo[] = [];
```

Add public getters and setters (after the existing `setActivePane` method):

```typescript
get tunnels(): readonly TunnelInfo[] {
  return this._tunnels;
}

addTunnel(t: TunnelInfo): void {
  if (this._tunnels.some(x => x.id === t.id)) return; // idempotent
  this._tunnels = [...this._tunnels, t];
  this._notify();
}

removeTunnel(id: string): void {
  this._tunnels = this._tunnels.filter(t => t.id !== id);
  this._notify();
}

setTunnels(tunnels: TunnelInfo[]): void {
  this._tunnels = [...tunnels];
  this._notify();
}
```

### Step 4: Modify `web/src/app.ts`

In the `onSessiondMessage` callback (inside `connectedCallback`), add tunnel cases to the message dispatch. The existing handler already has a `switch` on `msg.type` via `store.applySessiond(msg)`. Since `applySessiond` ignores unknown types, add explicit handling in the callback AFTER `store.applySessiond(msg)`:

```typescript
// Add after store.applySessiond(msg) and controller dispatch, before the Composition check:
if (msg.type === SessiondType.TunnelCreated && msg.tunnelId) {
  store.addTunnel({ id: msg.tunnelId, port: msg.tunnelPort ?? 0 });
}
if (msg.type === SessiondType.TunnelClosed && msg.tunnelId) {
  store.removeTunnel(msg.tunnelId);
}
if (msg.type === SessiondType.TunnelList) {
  store.setTunnels(msg.tunnels ?? []);
}
```

In `onReconnect` callback, add `listTunnels()` call to sync state after reconnect:

```typescript
this._socket.onReconnect = () => {
  this._showReconnectOverlay = false;
  muxLogReset();
  muxLog('app reconnect', 'WS connected, bootstrapping');
  this._controller?.bootstrap();
  this._socket?.listTunnels(); // ← ADD THIS LINE: sync tunnel state on (re)connect
};
```

### Step 5: Build gate

```bash
cd web && npm run check:fast
```

Expected: 0 errors. Fix any type errors.

### Step 6: Verify

```bash
make build
./bin/muxterm serve --addr 127.0.0.1:9090 &
sleep 2
playwright-cli open http://localhost:9090
playwright-cli snapshot
# Check no console errors in the snapshot output
playwright-cli close
pkill -f 'muxterm serve'
```

Expected: app loads cleanly, no console errors about unknown types.

### Step 7: Commit

```bash
git add -A && git commit -m "feat: tunnel TypeScript types, ws.ts methods, store state, app wiring"
```

---

## Task 4: `mux-sidebar.ts` shell with tabs and drag-resize

**What:** Create the sidebar component with the header, Workspaces/Tunnels tabs, a drag-to-resize handle on the right edge, and `localStorage` width persistence. No workspace or tunnel content yet — just the shell.

**Files:**
- Create: `web/src/components/mux-sidebar.ts`

### Step 1: Create `web/src/components/mux-sidebar.ts`

```typescript
import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { CHROME } from '../lib/theme.js';
import type { TunnelInfo } from '../types.js';

type SidebarTab = 'workspaces' | 'tunnels';

const SIDEBAR_WIDTH_KEY = 'mux-sidebar-width';
const SIDEBAR_DEFAULT_WIDTH = 220;
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 360;

@customElement('mux-sidebar')
export class MuxSidebar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: ${unsafeCSS(CHROME.bar)};
      border-right: 1px solid ${unsafeCSS(CHROME.border)};
      height: 100%;
      overflow: hidden;
      position: relative;
      user-select: none;
      flex-shrink: 0;
    }

    .header {
      padding: 12px 16px 8px;
      font-weight: 700;
      font-size: 0.9rem;
      color: var(--mux-accent, #7aa2f7);
      flex-shrink: 0;
      letter-spacing: 0.02em;
    }

    .tabs {
      display: flex;
      flex-direction: row;
      border-bottom: 1px solid ${unsafeCSS(CHROME.border)};
      flex-shrink: 0;
    }

    .tab-btn {
      flex: 1;
      background: transparent;
      border: none;
      color: ${unsafeCSS(CHROME.textDim)};
      font: inherit;
      font-size: 0.8rem;
      padding: 8px 4px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }

    .tab-btn.active {
      color: ${unsafeCSS(CHROME.textBright)};
      border-bottom-color: var(--mux-accent, #7aa2f7);
    }

    .tab-btn:hover:not(.active) {
      color: #a9b1d6;
    }

    .tab-content {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    /* Scrollbar styling */
    .tab-content::-webkit-scrollbar { width: 4px; }
    .tab-content::-webkit-scrollbar-track { background: transparent; }
    .tab-content::-webkit-scrollbar-thumb { background: ${unsafeCSS(CHROME.border)}; border-radius: 2px; }

    /* Drag-resize handle */
    .resize-handle {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      width: 4px;
      cursor: col-resize;
      background: transparent;
      z-index: 10;
      transition: background 0.15s;
    }
    .resize-handle:hover {
      background: var(--mux-accent, #7aa2f7);
      opacity: 0.5;
    }

    /* ── Workspace cards ──────────────────────────────────── */
    .ws-card {
      border: 1px solid ${unsafeCSS(CHROME.border)};
      border-radius: 6px;
      padding: 7px 10px;
      margin-bottom: 6px;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    .ws-card:hover { background: rgba(255,255,255,0.04); }
    .ws-card.active {
      border-color: var(--mux-accent, #7aa2f7);
      background: rgba(122,162,247,0.08);
    }
    .ws-card.pending-close { opacity: 0.4; pointer-events: none; }

    .ws-card-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85rem;
    }

    .ws-dot { font-size: 0.6rem; opacity: 0.7; }
    .ws-dot.active { color: var(--mux-accent, #7aa2f7); opacity: 1; }

    .ws-name {
      flex: 1;
      font-weight: 500;
      color: ${unsafeCSS(CHROME.textBright)};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .ws-remove {
      background: none;
      border: none;
      color: ${unsafeCSS(CHROME.textDim)};
      cursor: pointer;
      font-size: 0.65rem;
      padding: 2px 4px;
      border-radius: 3px;
      opacity: 0;
      transition: opacity 0.1s, color 0.1s;
      flex-shrink: 0;
    }
    .ws-card:hover .ws-remove { opacity: 1; }
    .ws-card.active .ws-remove { opacity: 0.5; }
    .ws-remove:hover { color: var(--mux-danger, #f7768e) !important; opacity: 1 !important; }

    .ws-hint {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 3px;
      padding-left: 16px;
      font-size: 0.75rem;
      color: ${unsafeCSS(CHROME.textDim)};
      white-space: nowrap;
      overflow: hidden;
    }
    .ws-hint-title { overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .ws-hint-extra { color: #414868; flex-shrink: 0; }

    .ws-rename-input {
      flex: 1;
      background: #24283b;
      border: 1px solid var(--mux-accent, #7aa2f7);
      border-radius: 3px;
      color: ${unsafeCSS(CHROME.textBright)};
      font: inherit;
      font-size: 0.85rem;
      padding: 0 4px;
      outline: none;
      min-width: 0;
    }

    .new-ws-btn {
      width: 100%;
      background: transparent;
      border: 1px dashed ${unsafeCSS(CHROME.border)};
      border-radius: 6px;
      color: ${unsafeCSS(CHROME.textDim)};
      font: inherit;
      font-size: 0.8rem;
      padding: 6px;
      cursor: pointer;
      margin-top: 4px;
      transition: color 0.12s, border-color 0.12s;
    }
    .new-ws-btn:hover { color: #a9b1d6; border-color: #414868; }

    /* ── Tunnel rows ─────────────────────────────────────── */
    .tunnel-row {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 4px;
      font-size: 0.8rem;
      border-radius: 4px;
    }
    .tunnel-row:hover { background: rgba(255,255,255,0.03); }
    .tunnel-dot { color: #9ece6a; font-size: 0.55rem; flex-shrink: 0; }
    .tunnel-port {
      color: #a9b1d6;
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .tunnel-id {
      color: #7aa2f7;
      font-family: monospace;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tunnel-action {
      background: none;
      border: none;
      color: ${unsafeCSS(CHROME.textDim)};
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 0.75rem;
      opacity: 0;
      transition: opacity 0.1s;
      flex-shrink: 0;
    }
    .tunnel-row:hover .tunnel-action { opacity: 1; }
    .tunnel-action:hover { color: ${unsafeCSS(CHROME.textBright)}; }

    .tunnel-add-btn {
      width: 100%;
      background: transparent;
      border: 1px dashed ${unsafeCSS(CHROME.border)};
      border-radius: 6px;
      color: ${unsafeCSS(CHROME.textDim)};
      font: inherit;
      font-size: 0.8rem;
      padding: 6px;
      cursor: pointer;
      margin-top: 4px;
      transition: color 0.12s, border-color 0.12s;
    }
    .tunnel-add-btn:hover { color: #a9b1d6; border-color: #414868; }

    .tunnel-input-row {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-top: 4px;
    }
    .tunnel-port-prefix { color: ${unsafeCSS(CHROME.textDim)}; font-size: 0.85rem; }
    .tunnel-port-input {
      background: #1a1b26;
      border: 1px solid var(--mux-accent, #7aa2f7);
      border-radius: 4px;
      color: ${unsafeCSS(CHROME.textBright)};
      font: inherit;
      font-size: 0.85rem;
      padding: 4px 6px;
      width: 80px;
      outline: none;
      -moz-appearance: textfield;
      appearance: textfield;
    }
    .tunnel-port-input::-webkit-inner-spin-button,
    .tunnel-port-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
    .tunnel-forward-btn {
      background: #3d59a1;
      border: none;
      border-radius: 4px;
      color: ${unsafeCSS(CHROME.textBright)};
      font: inherit;
      font-size: 0.8rem;
      padding: 4px 8px;
      cursor: pointer;
      transition: background 0.12s;
    }
    .tunnel-forward-btn:hover { background: var(--mux-accent, #7aa2f7); color: #1a1b26; }
  `;

  @state() private _tab: SidebarTab = 'workspaces';
  @state() private _version = 0;
  @state() private _renaming: string | null = null;
  @state() private _showPortInput = false;
  @state() private _authToken = '';

  // Workspace IDs currently in grace-period close (dimmed, not yet destroyed)
  @state() private _pendingClose = new Set<string>();

  private _unsub: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._unsub = store.subscribe(() => { this._version++; });
    // Restore width from localStorage
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored) {
      const w = parseInt(stored, 10);
      if (w >= SIDEBAR_MIN_WIDTH && w <= SIDEBAR_MAX_WIDTH) {
        (this as HTMLElement).style.width = `${w}px`;
      }
    } else {
      (this as HTMLElement).style.width = `${SIDEBAR_DEFAULT_WIDTH}px`;
    }
    // Fetch auth token (localhost only; ignore failure)
    fetch('/api/token')
      .then(r => r.ok ? r.json() : null)
      .then((data: { token?: string } | null) => { if (data?.token) this._authToken = data.token; })
      .catch(() => {});
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
  }

  override render() {
    void this._version;
    return html`
      <div class="header">muxterm</div>
      <div class="tabs">
        <button
          class="tab-btn ${this._tab === 'workspaces' ? 'active' : ''}"
          @click="${() => { this._tab = 'workspaces'; }}"
        >Workspaces</button>
        <button
          class="tab-btn ${this._tab === 'tunnels' ? 'active' : ''}"
          @click="${() => { this._tab = 'tunnels'; }}"
        >Tunnels</button>
      </div>
      <div class="tab-content">
        ${this._tab === 'workspaces' ? this._renderWorkspaces() : this._renderTunnels()}
      </div>
      <div class="resize-handle" @pointerdown="${this._onResizeStart}"></div>
    `;
  }

  // ── Workspaces ──────────────────────────────────────────────────────────

  private _renderWorkspaces() {
    const activeWsId = store.attached ?? '';
    return html`
      ${store.workspaces.map(ws => {
        const isActive = ws.workspaceId === activeWsId;
        const isPending = this._pendingClose.has(ws.workspaceId);
        // Active pane title hint (first pane title, if any)
        const activePaneTitle = isActive
          ? (store.panes.find(p => p.paneId >= 0)?.title ?? '')
          : '';
        const extraPaneCount = isActive
          ? Math.max(0, store.panes.filter(p => p.paneId >= 0).length - 1)
          : 0;

        return html`
          <div
            class="ws-card ${isActive ? 'active' : ''} ${isPending ? 'pending-close' : ''}"
            @click="${() => this._onWsClick(ws.workspaceId)}"
          >
            <div class="ws-card-header">
              <span class="ws-dot ${isActive ? 'active' : ''}">${isActive ? '●' : '○'}</span>
              ${this._renaming === ws.workspaceId
                ? html`<input
                    class="ws-rename-input"
                    .value="${ws.name ?? ws.workspaceId}"
                    @blur="${(e: Event) => this._finishRename(ws.workspaceId, (e.target as HTMLInputElement).value)}"
                    @keydown="${(e: KeyboardEvent) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                      if (e.key === 'Escape') { this._renaming = null; }
                    }}"
                    @dblclick="${(e: Event) => e.stopPropagation()}"
                  >`
                : html`<span
                    class="ws-name"
                    @dblclick="${(e: Event) => { e.stopPropagation(); this._startRename(ws.workspaceId); }}"
                  >${ws.name ?? `workspace ${ws.workspaceId.replace(/\D/g, '') || ws.workspaceId}`}</span>`
              }
              <button
                class="ws-remove"
                title="Close workspace"
                @click="${(e: Event) => { e.stopPropagation(); this._onWsRemove(ws.workspaceId, ws.name ?? ws.workspaceId); }}"
              >✕</button>
            </div>
            ${activePaneTitle ? html`
              <div class="ws-hint">
                <span class="ws-hint-title">${activePaneTitle}</span>
                ${extraPaneCount > 0 ? html`<span class="ws-hint-extra">+${extraPaneCount}</span>` : ''}
              </div>
            ` : ''}
          </div>
        `;
      })}
      <button class="new-ws-btn" @click="${this._onNewWs}">+ New workspace</button>
    `;
  }

  private _onWsClick(wsId: string): void {
    if (this._renaming) return; // don't switch while renaming
    store.ackWorkspace(wsId);
    this.dispatchEvent(new CustomEvent('workspace-switch', {
      detail: { workspaceId: wsId },
      bubbles: true,
      composed: true,
    }));
  }

  private _onNewWs(): void {
    this.dispatchEvent(new CustomEvent('workspace-create', { bubbles: true, composed: true }));
  }

  private _onWsRemove(wsId: string, name: string): void {
    this._pendingClose = new Set(this._pendingClose).add(wsId);
    this.dispatchEvent(new CustomEvent('workspace-close', {
      detail: { workspaceId: wsId, name },
      bubbles: true,
      composed: true,
    }));
  }

  /** Called by app.ts when the workspace undo grace period is cancelled (undo clicked). */
  restoreWorkspace(wsId: string): void {
    const next = new Set(this._pendingClose);
    next.delete(wsId);
    this._pendingClose = next;
  }

  private _startRename(wsId: string): void {
    this._renaming = wsId;
    requestAnimationFrame(() => {
      const input = this.shadowRoot?.querySelector<HTMLInputElement>('.ws-rename-input');
      input?.select();
    });
  }

  private _finishRename(wsId: string, newName: string): void {
    this._renaming = null;
    const trimmed = newName.trim();
    if (trimmed) {
      this.dispatchEvent(new CustomEvent('workspace-rename', {
        detail: { workspaceId: wsId, name: trimmed },
        bubbles: true,
        composed: true,
      }));
    }
  }

  // ── Tunnels ─────────────────────────────────────────────────────────────

  private _renderTunnels() {
    const tunnels = store.tunnels as TunnelInfo[];
    return html`
      ${tunnels.map(t => html`
        <div class="tunnel-row">
          <span class="tunnel-dot">●</span>
          <span class="tunnel-port">:${t.port}</span>
          <span class="tunnel-id">${t.id}</span>
          <button class="tunnel-action" title="Copy tunnel URL" @click="${() => this._copyTunnelUrl(t.id)}">⎘</button>
          <button class="tunnel-action" title="Close tunnel" @click="${() => this._closeTunnel(t.id)}">✕</button>
        </div>
      `)}
      ${this._showPortInput
        ? html`
          <div class="tunnel-input-row">
            <span class="tunnel-port-prefix">:</span>
            <input
              class="tunnel-port-input"
              type="number"
              min="1"
              max="65535"
              placeholder="port"
              @keydown="${this._onPortInputKeydown}"
            >
            <button class="tunnel-forward-btn" @click="${this._submitPortInput}">Forward</button>
          </div>
        `
        : html`
          <button class="tunnel-add-btn" @click="${() => { this._showPortInput = true; this._focusPortInput(); }}">
            + Forward a port
          </button>
        `
      }
    `;
  }

  private _focusPortInput(): void {
    requestAnimationFrame(() => {
      this.shadowRoot?.querySelector<HTMLInputElement>('.tunnel-port-input')?.focus();
    });
  }

  private _onPortInputKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); this._submitPortInput(); }
    if (e.key === 'Escape') { this._showPortInput = false; }
  }

  private _submitPortInput(): void {
    const input = this.shadowRoot?.querySelector<HTMLInputElement>('.tunnel-port-input');
    const port = parseInt(input?.value ?? '', 10);
    if (!port || port < 1 || port > 65535) return;
    this.dispatchEvent(new CustomEvent('tunnel-create', {
      detail: { port },
      bubbles: true,
      composed: true,
    }));
    this._showPortInput = false;
  }

  private _copyTunnelUrl(id: string): void {
    const token = this._authToken;
    const url = `${location.origin}/t/${id}/${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    navigator.clipboard.writeText(url).catch(() => {
      // Fallback: show in console for debugging
      console.info('[muxterm] tunnel URL:', url);
    });
  }

  private _closeTunnel(id: string): void {
    this.dispatchEvent(new CustomEvent('tunnel-close', {
      detail: { id },
      bubbles: true,
      composed: true,
    }));
  }

  // ── Drag-resize ──────────────────────────────────────────────────────────

  private _onResizeStart(e: PointerEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = this.offsetWidth;

    const onMove = (ev: PointerEvent): void => {
      const newW = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startW + (ev.clientX - startX)));
      (this as HTMLElement).style.width = `${newW}px`;
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(newW)); } catch { /* ignore */ }
    };

    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-sidebar': MuxSidebar; }
}
```

### Step 2: Build gate

```bash
cd web && npm run check:fast
```

Fix any type errors. Common issues:
- `TunnelInfo[]` type needs `as TunnelInfo[]` since `store.tunnels` returns `readonly TunnelInfo[]`
- Use `ws.name ?? ws.workspaceId` not `ws.name || ws.workspaceId` to properly handle empty names

### Step 3: Verify (component exists, no errors)

```bash
make build
```

Expected: builds without errors. The sidebar isn't mounted in the app yet (next task).

### Step 4: Commit

```bash
git add -A && git commit -m "feat: mux-sidebar component — tabs, workspace cards, tunnel rows, drag-resize"
```

---

## Task 5: App layout — sidebar + conditional dock bar

**What:** Import `mux-sidebar` in `app.ts`, wrap the main content in a flex-row `content-area`, show the sidebar on wide screens (`≥768px`) and hide it on narrow. The existing `mux-dock-bar` stays but is now rendered only on narrow screens. Wire sidebar events to existing app handlers.

**Files:**
- Modify: `web/src/app.ts`

### Step 1: Import mux-sidebar

Add the import near the other side-effect imports in `app.ts`:

```typescript
import './components/mux-sidebar.js';
import type { MuxSidebar } from './components/mux-sidebar.js';
```

### Step 2: Add `_sidebarWidth` state and resize listener

Add to the class fields:

```typescript
@state()
private _layoutMode: 'wide' | 'narrow' = currentLayoutMode();
```

In `connectedCallback()`, add a resize listener (after the store subscribe):

```typescript
window.addEventListener('resize', this._onViewportResize);
this._layoutMode = currentLayoutMode();
```

In `disconnectedCallback()`, remove it:

```typescript
window.removeEventListener('resize', this._onViewportResize);
```

Add the handler:

```typescript
private _onViewportResize = (): void => {
  const mode = currentLayoutMode();
  if (mode !== this._layoutMode) {
    this._layoutMode = mode;
  }
};
```

### Step 3: Add CSS for the app layout

In the `static styles = css\`...\`` block in `app.ts`, add these rules at the end:

```css
/* ── Wide layout: sidebar + terminal side-by-side ── */
.content-area {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
  min-height: 0;
}

.main-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}
```

### Step 4: Restructure the `render()` method

The current render looks roughly like:

```typescript
render() {
  const panes = store.panes.filter(p => p.paneId >= 0);
  return html`
    <mux-title-bar ...></mux-title-bar>
    ${panes.length === 0 ? emptyState : muxDock}
    <div class="undo-toast-stack" ...>...</div>
    <mux-dock-bar ...></mux-dock-bar>
    <div class="overlay ...">...</div>
    ...
  `;
}
```

Change it to:

```typescript
render() {
  const panes = store.panes.filter(p => p.paneId >= 0);
  const isWide = this._layoutMode === 'wide';

  return html`
    <mux-title-bar
      @launcher-action="${this._onLauncherAction}"
      @pane-select="${this._onActivePane}"
    ></mux-title-bar>

    <div class="content-area">
      ${isWide ? html`
        <mux-sidebar
          @workspace-switch="${this._onWorkspaceSelected}"
          @workspace-create="${this._onOpenCreateModal}"
          @workspace-rename="${this._onWorkspaceRename}"
          @workspace-close="${this._onSidebarWorkspaceClose}"
          @tunnel-create="${this._onTunnelCreate}"
          @tunnel-close="${this._onTunnelClose}"
        ></mux-sidebar>
      ` : ''}

      <div class="main-pane">
        ${panes.length === 0
          ? html`
            <div class="empty-workspace">
              <div class="glyph">${icon(MonitorX, { size: 48 })}</div>
              <div class="headline">No panes</div>
              <div class="subtext">This workspace has nothing running. Create a pane to get started.</div>
              <button @click="${this._onCreatePane}"><span>+</span> New pane</button>
            </div>
          `
          : html`
            <mux-dock
              .panes="${panes}"
              .activePaneId="${store.activePaneId}"
              .workspaceKey="${store.attached ?? ''}"
              .layout="${store.layout}"
              .narrow="${!isWide}"
              @pane-select="${this._onActivePane}"
              @pane-close="${this._onClosePane}"
              @pane-create="${this._createPaneOptimistic}"
              @pane-rename="${this._onPaneRename}"
              @workspace-switch="${this._onWorkspaceSelected}"
              @layout-save="${this._onLayoutSave}"
            ></mux-dock>
          `
        }

        ${!isWide ? html`
          <mux-dock-bar
            .workspaces="${store.workspaces}"
            .activeWorkspaceId="${store.attached ?? ''}"
            connectionStatus="${this._connectionStatus}"
            @workspace-switch="${this._onWorkspaceSelected}"
            @workspace-create="${this._onOpenCreateModal}"
          ></mux-dock-bar>
        ` : ''}
      </div>
    </div>

    <div class="undo-toast-stack" @pane-close-resolved="${this._onUndoPaneClose}">
      ${repeat(
        [...this._pendingClosesMeta.entries()],
        ([paneId]) => paneId,
        ([paneId, meta]) => html`
          <mux-undo-toast
            .paneId="${paneId}"
            .paneTitle="${meta.title}"
            .duration="${10000}"
          ></mux-undo-toast>
        `,
      )}
      ${repeat(
        [...this._pendingWorkspaceCloses.entries()],
        ([vid]) => vid,
        ([vid, { name }]) => html`
          <mux-undo-toast
            .paneId="${vid}"
            .paneTitle="${name}"
            .duration="${10000}"
          ></mux-undo-toast>
        `,
      )}
    </div>

    <div class="overlay ${this._connectionStatus === 'connected' ? 'hidden' : ''}">
      Connecting to muxterm...
    </div>

    ${this._showCreateModal ? html`
      <div class="ws-create-backdrop" @click="${this._cancelCreate}">
        <div class="ws-create-dialog" @click="${(e: Event) => e.stopPropagation()}">
          <h3>New workspace</h3>
          <input
            class="ws-create-input"
            type="text"
            placeholder="Workspace name"
            ?disabled="${this._creatingWorkspace}"
            @keydown="${this._onCreateModalKeyDown}"
          />
          <div class="ws-create-row">
            <button class="ws-create-cancel" ?disabled="${this._creatingWorkspace}" @click="${this._cancelCreate}">Cancel</button>
            <button class="ws-create-confirm" ?disabled="${this._creatingWorkspace}" @click="${this._submitCreate}">
              ${this._creatingWorkspace ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    ` : ''}

    ${this._showReconnectOverlay
      ? html`<mux-reconnect-overlay message="${this._reconnectMessage}"></mux-reconnect-overlay>`
      : ''}
  `;
}
```

### Step 5: Add workspace-close grace-period logic

Add these fields to the class (alongside `_pendingCloses`):

```typescript
/** Grace-period timers for workspace closes. Keyed by a negative "virtual ID". */
private _pendingWorkspaceCloses = new Map<number, { timer: ReturnType<typeof setTimeout>; wsId: string; name: string }>();
private _wsVirtualId = -1000; // generates unique negative ints for workspace close toasts
```

Add the new handlers:

```typescript
/** Sidebar workspace-close → start grace period, dim card, show undo toast. */
private _onSidebarWorkspaceClose = (e: CustomEvent<{ workspaceId: string; name: string }>): void => {
  const { workspaceId, name } = e.detail;
  // Guard: already pending
  for (const entry of this._pendingWorkspaceCloses.values()) {
    if (entry.wsId === workspaceId) return;
  }
  const vid = this._wsVirtualId--;
  const timer = setTimeout(() => this._executeWorkspaceClose(vid), 10_000);
  this._pendingWorkspaceCloses.set(vid, { timer, wsId: workspaceId, name });
  this.requestUpdate();
};

private _executeWorkspaceClose(vid: number): void {
  const entry = this._pendingWorkspaceCloses.get(vid);
  if (!entry) return;
  this._pendingWorkspaceCloses.delete(vid);
  this._socket?.closeWorkspace(entry.wsId);
  this.requestUpdate();
}
```

Update `_onUndoPaneClose` to also handle workspace undos (the undo toast emits `pane-close-resolved` for both pane and workspace toasts, distinguished by the virtual ID sign):

```typescript
private _onUndoPaneClose = (e: CustomEvent<{ paneId: number }>): void => {
  const { paneId } = e.detail;

  // Workspace close undo (negative virtual IDs)
  if (this._pendingWorkspaceCloses.has(paneId)) {
    const entry = this._pendingWorkspaceCloses.get(paneId)!;
    clearTimeout(entry.timer);
    this._pendingWorkspaceCloses.delete(paneId);
    // Tell sidebar to restore the card's opacity
    this._sidebar?.restoreWorkspace(entry.wsId);
    this.requestUpdate();
    return;
  }

  // Existing pane close undo logic (unchanged):
  if (this._closingPanes.has(paneId)) return;
  const handle = this._pendingCloses.get(paneId);
  if (handle !== undefined) clearTimeout(handle);
  this._pendingCloses.delete(paneId);
  this._pendingClosesMeta.delete(paneId);
  this._dock?.reopenPane(paneId);
  this.requestUpdate();
};
```

Add a getter for the sidebar:

```typescript
private get _sidebar(): MuxSidebar | null {
  return (this.renderRoot as ShadowRoot).querySelector('mux-sidebar');
}
```

### Step 6: Add tunnel event handlers

```typescript
private _onTunnelCreate = (e: CustomEvent<{ port: number }>): void => {
  this._socket?.createTunnel(e.detail.port);
};

private _onTunnelClose = (e: CustomEvent<{ id: string }>): void => {
  this._socket?.closeTunnel(e.detail.id);
};
```

### Step 7: Clean up the existing `_onWorkspaceClose`

The existing `_onWorkspaceClose` in app.ts uses `store.mutate` for an immediate close. That handler is no longer called from the UI (the sidebar uses the new `_onSidebarWorkspaceClose`). Delete it or leave it — it's dead code now. Safest: delete it.

```typescript
// DELETE this method (replaced by _onSidebarWorkspaceClose):
private _onWorkspaceClose = (e: CustomEvent<{ workspaceId: string }>): void => { ... };
```

### Step 8: Build gate

```bash
go build ./... && cd web && npm run check:fast
```

Common issues:
- `_onViewportResize` is an arrow function property — no binding needed
- The `repeat` directive is already imported in app.ts
- `MuxSidebar` type import is needed for the `_sidebar` getter

### Step 9: Verify

```bash
make build
./bin/muxterm serve --addr 127.0.0.1:9090 &
sleep 2
playwright-cli open http://localhost:9090
playwright-cli snapshot
# Wide viewport (default): sidebar should appear on the left with Workspaces/Tunnels tabs
# Terminal area should be on the right
playwright-cli screenshot --path /tmp/sidebar-wide.png
# Narrow viewport:
playwright-cli evaluate "window.resizeTo(390, 844)"
playwright-cli snapshot
# Narrow: sidebar hidden, dock bar visible at bottom
playwright-cli screenshot --path /tmp/sidebar-narrow.png
playwright-cli close
pkill -f 'muxterm serve'
```

Expected:
- Wide: sidebar on left, terminal on right, Workspaces/Tunnels tabs visible
- Narrow: sidebar gone, dock bar at bottom

### Step 10: Commit

```bash
git add -A && git commit -m "feat: app layout — sidebar on wide, dock bar on narrow, workspace/tunnel event wiring"
```

---

## Task 6: Sidebar drag-to-resize + localStorage persistence

**What:** The drag-resize is already implemented in the sidebar component (Task 4). This task verifies it works end-to-end and persists across page reload.

**No new code to write.** This is a verification-only task.

### Step 1: Verify

```bash
make build
./bin/muxterm serve --addr 127.0.0.1:9090 &
sleep 2
playwright-cli open http://localhost:9090
# Verify initial sidebar width (~220px)
playwright-cli snapshot
# Simulate drag-resize: set localStorage directly and reload
playwright-cli evaluate "localStorage.setItem('mux-sidebar-width', '300')"
playwright-cli evaluate "location.reload()"
playwright-cli wait 1000
playwright-cli snapshot
# Sidebar should be ~300px wide
# Verify clamping: set below min
playwright-cli evaluate "localStorage.setItem('mux-sidebar-width', '50')"
playwright-cli evaluate "location.reload()"
playwright-cli wait 1000
playwright-cli snapshot
# Sidebar should be clamped to 160px (not 50px)
playwright-cli close
pkill -f 'muxterm serve'
```

Expected:
- Width restores to 300px after reload
- Width clamps to 160px when stored value is below minimum

> **If the clamping doesn't work as expected:** Check the sidebar's `connectedCallback` — the condition should be:
> ```typescript
> if (w >= SIDEBAR_MIN_WIDTH && w <= SIDEBAR_MAX_WIDTH) {
>   (this as HTMLElement).style.width = `${w}px`;
> } else {
>   (this as HTMLElement).style.width = `${SIDEBAR_DEFAULT_WIDTH}px`;
> }
> ```

### Step 2: Commit (if any fixes were made)

```bash
git add -A && git commit -m "fix: sidebar width clamping and localStorage persistence"
```

---

## Task 7: Workspace switching + rename in sidebar

**What:** Verify workspace cards in the sidebar respond correctly to clicks (switch workspace) and double-click-to-rename. These interactions are already wired in Tasks 4 and 5.

**No new code to write.** Verify end-to-end in the browser.

### Step 1: Verify workspace switching

```bash
make build
./bin/muxterm serve --addr 127.0.0.1:9090 &
sleep 2
playwright-cli open http://localhost:9090
playwright-cli snapshot
# Create a second workspace via the "+ New workspace" button in the sidebar
playwright-cli click "button:has-text('+ New workspace')"
playwright-cli wait 500
playwright-cli snapshot
# Verify: create modal appears
# Type workspace name and confirm
playwright-cli fill ".ws-create-input" "staging"
playwright-cli click ".ws-create-confirm"
playwright-cli wait 1000
playwright-cli snapshot
# Verify: two workspace cards in sidebar, "staging" is the active one
# Click the first workspace card
playwright-cli click ".ws-card:first-child"
playwright-cli wait 500
playwright-cli snapshot
# Verify: first workspace is now active (accent border)
playwright-cli close
pkill -f 'muxterm serve'
```

### Step 2: Verify workspace rename

```bash
make build
./bin/muxterm serve --addr 127.0.0.1:9090 &
sleep 2
playwright-cli open http://localhost:9090
playwright-cli snapshot
# Double-click the workspace name to rename
playwright-cli dblclick ".ws-name"
playwright-cli wait 200
playwright-cli snapshot
# Verify: inline input appears
playwright-cli fill ".ws-rename-input" "my-dev"
playwright-cli press ".ws-rename-input" "Enter"
playwright-cli wait 500
playwright-cli snapshot
# Verify: card shows "my-dev" as the workspace name
playwright-cli close
pkill -f 'muxterm serve'
```

Expected:
- Double-click reveals an inline `<input>` with the current name pre-filled and selected
- Enter confirms; name updates immediately (optimistic mutation)
- Escape cancels; name reverts

### Step 3: Commit (if any fixes were made)

```bash
git add -A && git commit -m "fix: workspace switching and rename interactions in sidebar"
```

---

## Task 8: Workspace remove + undo toast

**What:** Verify that clicking ✕ on a workspace card starts the 10s grace period, shows the undo toast, and that both undo (restores) and expiry (destroys) work correctly.

**No new code to write.** Verify end-to-end.

### Step 1: Verify

```bash
make build
./bin/muxterm serve --addr 127.0.0.1:9090 &
sleep 2
playwright-cli open http://localhost:9090
# Create a second workspace first (need 2 to close one)
playwright-cli click "button:has-text('+ New workspace')"
playwright-cli wait 300
playwright-cli fill ".ws-create-input" "temp"
playwright-cli click ".ws-create-confirm"
playwright-cli wait 1000
playwright-cli snapshot
# Hover over the "temp" workspace card and click ✕
playwright-cli hover ".ws-card:last-child"
playwright-cli click ".ws-card:last-child .ws-remove"
playwright-cli wait 500
playwright-cli snapshot
# Verify: toast appears ("temp closed · Undo"), card dims
# Click Undo
playwright-cli click ".undo"
playwright-cli wait 500
playwright-cli snapshot
# Verify: card opacity restored, toast gone, workspace still exists
playwright-cli close
pkill -f 'muxterm serve'
```

Expected:
- ✕ click → card dims (opacity 0.4), undo toast appears at bottom center
- "Undo" click → card fully restored, toast dismissed
- After 10s without undo → workspace removed from sidebar

> **If ✕ is not visible on hover:** The CSS `.ws-card:hover .ws-remove { opacity: 1; }` should reveal it. If playwright-cli hover doesn't trigger CSS `:hover`, try `playwright-cli evaluate "document.querySelector('.ws-card:last-child .ws-remove').style.opacity = '1'"` to force it visible, then click it.

### Step 2: Commit (if any fixes were made)

```bash
git add -A && git commit -m "fix: workspace remove grace period and undo toast"
```

---

## Task 9: Tunnels tab — create, copy URL, close

**What:** Verify the full tunnel lifecycle: click Tunnels tab → click `+ Forward a port` → type a port → press Enter → row appears → click ⎘ to copy URL → click ✕ to close → row disappears.

**No new code to write.** Verify end-to-end.

### Step 1: Start a test HTTP server on a local port

The tunnel proxy will forward `/t/{id}/` to this server.

```bash
python3 -m http.server 9998 &
```

### Step 2: Start muxterm and verify

```bash
make build
./bin/muxterm serve --addr 127.0.0.1:9090 &
sleep 2
playwright-cli open http://localhost:9090
# Switch to Tunnels tab
playwright-cli click "button:has-text('Tunnels')"
playwright-cli wait 200
playwright-cli snapshot
# No tunnels yet — only "+ Forward a port" button
# Click the button
playwright-cli click "button:has-text('+ Forward a port')"
playwright-cli wait 200
playwright-cli snapshot
# Verify: inline port input appears with ": [input] [Forward]"
playwright-cli fill ".tunnel-port-input" "9998"
playwright-cli press ".tunnel-port-input" "Enter"
playwright-cli wait 500
playwright-cli snapshot
# Verify: tunnel row appears → "● :9998   xxxxx   ⎘  ✕"
# Copy URL
playwright-cli hover ".tunnel-row"
playwright-cli click ".tunnel-action:first-of-type"
playwright-cli wait 200
# Copy to clipboard works (can't easily verify in playwright-cli, check no error)
playwright-cli snapshot
# Verify the tunnel actually proxies
# Get the tunnel ID from the page state
playwright-cli evaluate "JSON.stringify(window.__muxStore?.tunnels)"
# → should show something like [{"id":"ab3x7","port":9998}]
# Close the tunnel
playwright-cli click ".tunnel-action:last-of-type"
playwright-cli wait 500
playwright-cli snapshot
# Verify: tunnel row is gone
playwright-cli close
pkill -f 'muxterm serve'
pkill -f 'python3 -m http.server'
```

### Step 3: Verify tunnel proxy routing

```bash
make build
./bin/muxterm serve --addr 127.0.0.1:9090 &
python3 -m http.server 9998 &
sleep 2
# Create a tunnel via WebSocket (simulate what the UI does)
# This needs the tunnel ID from the UI test above; alternatively create via ws manually
# Just verify the /t/ route 404s for unknown IDs:
curl -s -o /dev/null -w "%{http_code}" http://localhost:9090/t/00000/
# → 404
pkill -f 'muxterm serve'
pkill -f 'python3 -m http.server'
```

Expected:
- `/t/notfound/` → 404
- Creating a tunnel in the UI → row appears in sidebar
- The tunnel row shows `● :9998  [id]  ⎘  ✕`
- Clicking ✕ → row disappears

### Step 4: Commit (if any fixes were made)

```bash
git add -A && git commit -m "feat: tunnel create/copy/close verified end-to-end"
```

---

## Task 10: Sidebar drag-resize at boundary values

**What:** Verify min/max clamping of the drag handle.

**No new code to write.** Verify via browser manipulation.

### Step 1: Verify

```bash
make build
./bin/muxterm serve --addr 127.0.0.1:9090 &
sleep 2
playwright-cli open http://localhost:9090
playwright-cli snapshot
# Force width below minimum via localStorage
playwright-cli evaluate "localStorage.setItem('mux-sidebar-width', '100'); location.reload();"
playwright-cli wait 1500
playwright-cli snapshot
# Sidebar width should be SIDEBAR_DEFAULT_WIDTH (220), not 100, because 100 < 160 (min)
# Force width above maximum
playwright-cli evaluate "localStorage.setItem('mux-sidebar-width', '500'); location.reload();"
playwright-cli wait 1500
playwright-cli snapshot
# Sidebar width should be SIDEBAR_DEFAULT_WIDTH (220), not 500, because 500 > 360 (max)
playwright-cli close
pkill -f 'muxterm serve'
```

Expected: values outside [160, 360] fall back to default (220px).

### Step 2: Commit (if any fixes were made)

```bash
git add -A && git commit -m "fix: sidebar width boundary clamping on restore"
```

---

## Task 11: Full end-to-end integration check

**What:** Run through the complete user journey: open muxterm → sidebar visible → create workspace → switch workspace → create tunnel → verify proxy → remove workspace with undo → all interactions working together.

**No new code to write.** Full integration verification.

### Step 1: Start services

```bash
make build
python3 -m http.server 9998 &
./bin/muxterm serve --addr 127.0.0.1:9090 &
sleep 2
```

### Step 2: Full user journey

```bash
playwright-cli open http://localhost:9090
playwright-cli snapshot  # ① sidebar visible, workspace card present, terminal area on right

# Create a second workspace
playwright-cli click "button:has-text('+ New workspace')"
playwright-cli wait 300
playwright-cli fill ".ws-create-input" "prod"
playwright-cli click ".ws-create-confirm"
playwright-cli wait 1000
playwright-cli snapshot  # ② two workspace cards, "prod" is active

# Switch back to first workspace
playwright-cli click ".ws-card:first-child"
playwright-cli wait 500
playwright-cli snapshot  # ③ first workspace active (accent border)

# Create a tunnel
playwright-cli click "button:has-text('Tunnels')"
playwright-cli wait 200
playwright-cli click "button:has-text('+ Forward a port')"
playwright-cli wait 200
playwright-cli fill ".tunnel-port-input" "9998"
playwright-cli press ".tunnel-port-input" "Enter"
playwright-cli wait 500
playwright-cli snapshot  # ④ tunnel row appears with ● :9998 and short ID

# Verify tunnel proxy works
# Get the tunnel ID from the store
playwright-cli evaluate "JSON.stringify(window.__muxStore?.tunnels)"
# Note the ID, then test: curl http://localhost:9090/t/{ID}/
# (Do this manually if playwright-cli can't pass the ID through)

# Remove workspace with undo
playwright-cli click "button:has-text('Workspaces')"
playwright-cli wait 200
playwright-cli hover ".ws-card:last-child"
playwright-cli click ".ws-card:last-child .ws-remove"
playwright-cli wait 300
playwright-cli snapshot  # ⑤ undo toast visible, "prod" card dimmed
playwright-cli click ".undo"
playwright-cli wait 300
playwright-cli snapshot  # ⑥ "prod" card restored, toast gone

playwright-cli close
pkill -f 'muxterm serve'
pkill -f 'python3 -m http.server'
```

Expected at each checkpoint:
1. Sidebar visible with Workspaces/Tunnels tabs, terminal pane on right
2. Two workspace cards, "prod" highlighted
3. First workspace highlighted with accent border
4. Tunnel row: `● :9998  [5-char-id]  ⎘  ✕`
5. Undo toast at bottom center, workspace card dimmed
6. Everything restored, app fully functional

### Step 3: Final commit

```bash
git add -A && git commit -m "feat: sidebar + tunnels — full feature complete, verified end-to-end"
```

---

## Appendix: File Change Summary

| File | Action | Purpose |
|---|---|---|
| `web/src/components/browser-surface.ts` | Delete | Remove browser pane |
| `web/src/__tests__/browser-surface.test.ts` | Delete | Tests for deleted component |
| `web/src/app.ts` | Modify | Remove browser handlers; add sidebar, layout, workspace/tunnel event wiring |
| `web/src/ws.ts` | Modify | Remove browser methods; add tunnel methods |
| `web/src/types.ts` | Modify | Add tunnel type constants, TunnelInfo, tunnelId/tunnelPort/tunnels fields |
| `web/src/state.ts` | Modify | Add tunnel state (tunnels array + add/remove/set) |
| `web/src/components/mux-sidebar.ts` | Create | New sidebar component |
| `internal/sessiond/protocol.go` | Modify | Add 6 tunnel type constants, TunnelInfo struct, 3 Message fields |
| `internal/server/tunnel.go` | Create | TunnelRegistry |
| `internal/server/ws.go` | Modify | Add `tunnels` field to Hub, handle 3 tunnel WS message types |
| `internal/server/server.go` | Modify | Add `tunnels` field, `/t/` route, `handleTunnelProxy`; remove browser routes |

Files NOT changed:
- `internal/proxy/proxy.go` — kept intact (has tests); routes removed from server.go
- `web/src/components/mux-dock-bar.ts` — no changes (already mounted, just conditional now)
- `web/src/components/mux-undo-toast.ts` — no changes (reused as-is with virtual IDs)
- `internal/sessiond/server.go` — no changes (tunnels handled at HTTP server level, not Unix daemon)
