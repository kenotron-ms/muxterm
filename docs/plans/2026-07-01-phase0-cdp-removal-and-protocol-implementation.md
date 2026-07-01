# Phase 0 — CDP Removal & Client-Driven Browser Protocol Implementation Plan

> **For execution:** Use `/build-like-ken` mode.

**Goal:** Delete the server-side CDP/Chromium browser from muxterm, flip the pane
marker `surfaceKind: "browser-cdp"` → `"browser"`, add the new client-driven
`browser-command` / `browser-result` protocol messages (server relays; the
client owns the engine), make the web client render a non-interactive
placeholder for `browser` panes, and extract the frozen client contract into
`docs/muxterm-client-protocol.md` — the spec both native apps (Phase 1 & Phase 2)
build against.

**Architecture:** muxterm has three Go layers and one web layer that touch the
browser pane. (1) `internal/sessiond` is the daemon: it owns panes and speaks a
framed control protocol over a Unix socket. Today it also owns Chromium via
`BrowserManager` and streams JPEG screencast frames. (2) `internal/server` is
the HTTP/WebSocket serve layer: `/ws` (in `ws.go`) relays the frozen
`sessiond.Message` vocabulary between a browser and a per-connection daemon
`Client`; `/ws/browser` (in `ws_browser.go`) streams the JPEG screencast. (3)
`internal/mcp` exposes agent tools that also create browser panes. (4) `web/src`
renders panes with xterm.js + dockview, plus a canvas JPEG browser pane. This
phase removes the entire Chromium/CDP/JPEG path from all four layers and
replaces it with a small relay: the daemon holds only a pane **handle** and
broadcasts `browser-command` to workspace subscribers; a client executes it and
returns `browser-result`. No engine lives on the server.

**Tech Stack:** Go 1.x (`internal/sessiond`, `internal/server`, `internal/mcp`,
`cmd/muxterm`), TypeScript + Lit + dockview + xterm.js (`web/src`), built with
`go build` and `npm --prefix web run build`.

**Verification approach (this repo, real execution — NOT mock-only):**
- Go: `go build ./...` (clean) and `go test ./...` (pass, minus deleted tests).
- Live protocol: run `./bin/muxterm serve --no-auth`, drive `/ws` with a real
  Node WebSocket client (Node ≥ 21 has a built-in `WebSocket`), and confirm the
  bootstrap (config → workspace-list) plus the new `create-browser-pane` →
  `pane-added(surfaceKind:"browser")` and `browser-command` → `browser-result`
  round-trips over the real server.
- Web: `npm --prefix web run build` (success) + `npm --prefix web run check:fast`
  (0 errors), then load the UI in a real browser and confirm a `browser` pane
  renders the placeholder without breaking the dock.

**This phase unblocks Phase 1 (Swift app) and Phase 2 (Android app):** both build
against the `docs/muxterm-client-protocol.md` produced in Stage F, and both rely
on the `browser-command` / `browser-result` contract added here.

---

## ⚠️ Inventory note (read before starting)

A fresh codebase survey found **three touch-points the original demolition
inventory omitted**. They are load-bearing — skipping them breaks `go build`:

1. `internal/server/ws.go:229–242` — the `/ws` serve relay intercepts
   `create-browser-pane` / `close-browser-pane` and calls
   `daemon.CreateBrowserCDPPane`. The `/ws` round-trip verification goes through
   this file.
2. `internal/mcp/tools_layout.go:52` — the MCP `create_pane kind=browser` tool
   also calls `CreateBrowserCDPPane`.
3. Serve tests `internal/server/ws_relay_test.go` and
   `internal/server/wiring_test.go` assert the old CDP routing and the
   `/ws/browser` route.

**Consequence / key decision:** because both the serve layer *and* MCP need to
create browser panes, we **rename** `CreateBrowserCDPPane` → `CreateBrowserPane`
(keep it in the `DaemonConn` interface and on `sessiond.Client`) and gut its
Chromium internals, rather than deleting it. Only the input/focus/blur/screencast
methods — used solely by the deleted `/ws/browser` path — are removed.

## Why Stages A–D land in ONE commit

Deleting `browser_manager.go` immediately breaks `server.go` (it references
`BrowserManager`); removing `WriteBrowserData` breaks `subscriber.go`; renaming
`CreateBrowserCDPPane` breaks `ws.go` and `tools_layout.go`. There is **no**
intermediate ordering that keeps `go build` green. Therefore Stages A, B, C(Go),
and D are performed as a sequence of edits with a **single** build/test/round-trip
verification and **one** commit at the end. Do **not** run `go build` until every
task through Task D6 is done — intermediate states will not compile. Stages E and
F are independent green commits.

---

# STAGE A — Delete server-side CDP files (sessiond)

### Task A1: Delete the sessiond CDP implementation and its tests

**Files (delete entirely):**
```
internal/sessiond/browser_cdp.go
internal/sessiond/browser_manager.go
internal/sessiond/browser_screencast.go
internal/sessiond/browser_input.go
internal/sessiond/browser_chromium_test.go
internal/sessiond/browser_input_test.go
internal/sessiond/browser_manager_test.go
internal/sessiond/browser_manager_methods_test.go
internal/sessiond/browser_authority_test.go
internal/sessiond/browser_authorityid_test.go
internal/sessiond/browser_screencast_test.go
internal/sessiond/server_browser_cdp_test.go
internal/sessiond/server_browser_test.go
internal/sessiond/client_browser_test.go
internal/sessiond/protocol_browser_test.go
internal/sessiond/protocol_browser_focus_test.go
```
> Note: `browser_chromium.go` does **not** exist — Chromium management lives in
> `browser_cdp.go` (already listed). `newBrowserCDPPane` lives in
> `browser_manager.go:345` and is deleted with that file; Task B4 removes its
> only caller.

**Implementation**
```bash
cd /home/ken/workspace/muxterm
rm internal/sessiond/browser_cdp.go \
   internal/sessiond/browser_manager.go \
   internal/sessiond/browser_screencast.go \
   internal/sessiond/browser_input.go \
   internal/sessiond/browser_chromium_test.go \
   internal/sessiond/browser_input_test.go \
   internal/sessiond/browser_manager_test.go \
   internal/sessiond/browser_manager_methods_test.go \
   internal/sessiond/browser_authority_test.go \
   internal/sessiond/browser_authorityid_test.go \
   internal/sessiond/browser_screencast_test.go \
   internal/sessiond/server_browser_cdp_test.go \
   internal/sessiond/server_browser_test.go \
   internal/sessiond/client_browser_test.go \
   internal/sessiond/protocol_browser_test.go \
   internal/sessiond/protocol_browser_focus_test.go
```

**Verification** (deletion only — build runs after Stage D)
```bash
ls internal/sessiond/browser_*.go 2>&1
```
Expected: `No such file or directory` (every `browser_*.go` in sessiond is gone).

**Commit:** none yet — continue to Stage B (single commit after Task D6).

---

# STAGE B — Remove CDP symbols from shared sessiond files

### Task B1: `internal/sessiond/protocol.go` — remove the frame kind, dead message types, and dead structs

**Files:**
- Modify: `internal/sessiond/protocol.go`

**Implementation**

(1) Remove the `FrameBrowserData` frame kind. Replace the const block at lines 14–18:
```go
const (
	FrameControl     byte = 0x01 // payload is JSON of the Message envelope
	FramePaneData    byte = 0x02 // payload is [4-byte LITTLE-ENDIAN paneId][raw bytes]
	FrameBrowserData byte = 0x03 // payload is [4-byte LITTLE-ENDIAN paneId][raw JPEG bytes]
)
```
with:
```go
const (
	FrameControl  byte = 0x01 // payload is JSON of the Message envelope
	FramePaneData byte = 0x02 // payload is [4-byte LITTLE-ENDIAN paneId][raw bytes]
)
```

(2) In the message-type const block, **keep** `TypeCreateBrowserPane` and
`TypeCloseBrowserPane` but **relocate + rewrite** them, and **add** the two new
types. Replace the old CDP block at lines 62–73:
```go
	// Browser CDP pane messages (/ws/browser WebSocket).
	TypeCreateBrowserPane       = "create-browser-pane"
	TypeCloseBrowserPane        = "close-browser-pane"
	TypeBrowserInput            = "browser-input"
	TypeBrowserURL              = "browser-url"
	TypeBrowserDownloadProgress = "browser-download-progress"
	TypeBrowserError            = "browser-error"
	TypeBrowserFocus   = "browser-focus"   // client → sessiond: focus claim + viewport size
	TypeBrowserBlur    = "browser-blur"    // client → sessiond: focus release
	TypeBrowserGranted = "browser-granted" // sessiond → client: input authority notification
	TypeBrowserCursor  = "browser-cursor"  // sessiond → client: cursor shape update

```
with:
```go
	// Client-driven browser pane messages (ride /ws; no server-side engine).
	// The daemon holds only a pane handle and RELAYS commands to the client that
	// owns the pane. See docs/muxterm-client-protocol.md.
	TypeCreateBrowserPane = "create-browser-pane" // client → daemon: allocate a browser pane handle
	TypeCloseBrowserPane  = "close-browser-pane"  // client → daemon: close a browser pane
	TypeBrowserCommand    = "browser-command"     // relayed to workspace subs: {paneId, cid, action, params}
	TypeBrowserResult     = "browser-result"      // relayed to workspace subs: {paneId, cid, result | error}

```

(3) Remove `WriteBrowserData`. Delete lines 122–131 entirely:
```go
// WriteBrowserData writes a FrameBrowserData frame whose payload is
// [4-byte LITTLE-ENDIAN paneId][raw JPEG bytes]. Same framing as WritePaneData
// but uses FrameBrowserData (0x03) so the HTTP server can distinguish JPEG frames
// from PTY output frames.
func WriteBrowserData(w io.Writer, paneID uint32, data []byte) error {
	payload := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(payload[0:4], paneID)
	copy(payload[4:], data)
	return writeFrame(w, FrameBrowserData, payload)
}
```
(Leave the blank line so `DecodePaneData` and `WriteBrowserData`'s neighbours
stay separated by one blank line.)

(4) In the `Message` struct, remove the browser **relay** field block. Delete
lines 207–214:
```go
	// Browser relay fields (browser-focus, browser-blur, browser-input, browser-granted).
	ClientID         string          `json:"clientId,omitempty"`         // stable per /ws/browser connection
	DeviceID         string          `json:"deviceId,omitempty"`         // localStorage UUID, stable per physical machine
	RenderWidth      int             `json:"renderWidth,omitempty"`      // canvas CSS width in px at focus time
	RenderHeight     int             `json:"renderHeight,omitempty"`     // canvas CSS height in px at focus time
	DevicePixelRatio float64         `json:"devicePixelRatio,omitempty"` // client window.devicePixelRatio; 0 means 1.0
	InputEvent       json.RawMessage `json:"inputEvent,omitempty"`       // raw BrowserInputMsg JSON for browser-input
	RawPayload       json.RawMessage `json:"rawPayload,omitempty"`       // original JSON bytes for relay passthrough
```
> **KEEP** `Message.SurfaceKind` (line 184) and the `Action` / `Selector` /
> `Result` / `Params` fields already present — the new `browser-command` reuses
> `Action` (verb), `Selector`, and `Result`. See Task D2 for the one added field.

(5) Remove the four dead browser structs. Delete lines 217–275 (`BrowserInputMsg`,
`BrowserURLMsg`, `BrowserProgressMsg`, `BrowserErrorMsg`, `BrowserGrantedMsg`) in
their entirety — the whole run from `// BrowserInputMsg is the event payload...`
through the closing `}` of `BrowserGrantedMsg`.

(6) Update the `PaneInfo.SurfaceKind` comment at line 294:
```go
	SurfaceKind string `json:"surfaceKind,omitempty"` // "terminal" | "browser-cdp"; absent = "terminal"
```
→
```go
	SurfaceKind string `json:"surfaceKind,omitempty"` // "terminal" | "browser"; absent = "terminal"
```

> The `binary` import is still used by `writeFrame`/`WritePaneData`/`ReadFrame`;
> `json` by `WriteControl`. Do not remove imports.

**Verification:** none yet (build after Stage D).

---

### Task B2: `internal/sessiond/subscriber.go` — drop the browser-data frame path

**Files:**
- Modify: `internal/sessiond/subscriber.go`

**Implementation**

(1) Update the `outFrame` doc + comments (lines 14–21). Replace:
```go
// outFrame is one queued write to a single client: a control message, a pane-data
// frame, or a browser-data frame, distinguished by kind.
type outFrame struct {
	kind   byte     // FrameControl, FramePaneData, or FrameBrowserData
	msg    *Message // set when kind == FrameControl
	paneID uint32   // set when kind == FramePaneData or FrameBrowserData
	data   []byte   // set when kind == FramePaneData or FrameBrowserData
}
```
with:
```go
// outFrame is one queued write to a single client: a control message or a
// pane-data frame, distinguished by kind.
type outFrame struct {
	kind   byte     // FrameControl or FramePaneData
	msg    *Message // set when kind == FrameControl
	paneID uint32   // set when kind == FramePaneData
	data   []byte   // set when kind == FramePaneData
}
```

(2) Remove the `FrameBrowserData` case in `writeLoop` (lines 62–63):
```go
			case FrameBrowserData:
				err = WriteBrowserData(s.w, f.paneID, f.data)
```
(Delete those two lines; keep `FramePaneData` and the `default` control case.)

(3) Remove `enqueueBrowserData` entirely (lines 90–97):
```go
// enqueueBrowserData queues a browser-data frame (FrameBrowserData) for this
// client. The data is COPIED into a fresh slice so the caller may reuse its
// buffer. It never blocks.
func (s *subscriber) enqueueBrowserData(paneID uint32, data []byte) {
	cp := make([]byte, len(data))
	copy(cp, data)
	s.enqueue(outFrame{kind: FrameBrowserData, paneID: paneID, data: cp})
}
```

**Verification:** none yet.

---

### Task B3: `internal/sessiond/client.go` — remove screencast handlers, methods, and dispatch

**Files:**
- Modify: `internal/sessiond/client.go`

**Implementation**

(1) In the `Handlers` struct, remove `OnBrowserFrame` and `OnBrowserMsg`
(lines 87–95):
```go
	// OnBrowserFrame receives raw JPEG frames from the daemon's BrowserManager.
	// paneID is the workspace-local pane id; data is the raw JPEG bytes.
	// The handler must not block for long — offload slow work to another goroutine.
	OnBrowserFrame func(paneID uint32, data []byte)
	// OnBrowserMsg fires when the daemon broadcasts a browser JSON event:
	// TypeBrowserURL, TypeBrowserDownloadProgress, TypeBrowserError, or
	// TypeBrowserGranted. msg.RawPayload (if non-nil) carries the original JSON
	// bytes for relay passthrough; msg.Type identifies the event kind.
	OnBrowserMsg func(msg *Message)
```
and **add**, in the same spot, the two new relay handlers (Task D3 wires the
senders):
```go
	// OnBrowserCommand fires when the daemon broadcasts a browser-command to the
	// workspace (CID carried for correlation). The client owning/focused on the
	// pane executes it against its live webview. msg carries PaneID, CID,
	// Action, Selector, and Params.
	OnBrowserCommand func(msg *Message)
	// OnBrowserResult fires when the daemon broadcasts a browser-result back to
	// the workspace (echoing the command CID). msg carries PaneID, CID, Result
	// (or Error).
	OnBrowserResult func(msg *Message)
```

(2) In `Run()`, remove the `FrameBrowserData` case (lines 161–163):
```go
		case FrameBrowserData:
			paneID, data := DecodePaneData(payload) // same [4-byte LE paneId][body] format
			c.dispatchBrowserFrame(paneID, data)
```

(3) Rename `CreateBrowserCDPPane` → `CreateBrowserPane` and drop the Chromium
comment (lines 353–366):
```go
// CreateBrowserCDPPane creates a browser-cdp surface pane in the attached workspace
// and returns the server-assigned workspace-local pane ID. The daemon starts the
// Chromium page immediately after registering the pane — no HTTP server involvement.
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
→
```go
// CreateBrowserPane creates a client-rendered browser surface pane in the
// attached workspace and returns the server-assigned workspace-local pane ID.
// The daemon allocates only a pane handle (surfaceKind "browser"); the browser
// engine lives entirely on the client.
func (c *Client) CreateBrowserPane(placement string, referencePaneID int) (int, error) {
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

(4) Remove `BrowserFocus`, `BrowserBlur`, and `BrowserInput` entirely
(lines 418–461) — the three methods and their doc comments. Delete the whole run
from `// BrowserFocus sends a browser-focus event...` through the closing `}` of
`BrowserInput`.

(5) **Add** the two new fire-and-forget senders where the removed methods were:
```go
// BrowserCommand relays a browser-command to the daemon, which broadcasts it to
// all subscribers of the attached workspace. payload is the pre-marshalled
// command JSON ({action, params, ...}) stored in Result for passthrough.
// Fire-and-forget: the daemon sends no direct reply; the executing client
// returns a browser-result event.
func (c *Client) BrowserCommand(paneID int, cid uint64, payload json.RawMessage) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WriteControl(c.conn, &Message{Type: TypeBrowserCommand, PaneID: paneID, CID: cid, Params: payload})
}

// BrowserResult relays a browser-result back to the daemon, which broadcasts it
// to all subscribers of the attached workspace (echoing the command CID).
// Fire-and-forget.
func (c *Client) BrowserResult(paneID int, cid uint64, payload json.RawMessage) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WriteControl(c.conn, &Message{Type: TypeBrowserResult, PaneID: paneID, CID: cid, Result: payload})
}
```
> `Params` is the new field added in Task D2; `Result` already exists
> (`json:"result,omitempty"`). Both carry raw JSON.

(6) Remove `dispatchBrowserFrame` entirely (lines 474–483):
```go
// dispatchBrowserFrame routes a decoded FrameBrowserData frame to OnBrowserFrame
// if set. It runs on the read-loop goroutine, so the handler must not block for long.
func (c *Client) dispatchBrowserFrame(paneID uint32, data []byte) {
	c.hmu.Lock()
	fn := c.handlers.OnBrowserFrame
	c.hmu.Unlock()
	if fn != nil {
		fn(paneID, data)
	}
}
```

(7) In `dispatchEvent`, replace the dead browser-event case (lines 541–544):
```go
	case TypeBrowserURL, TypeBrowserDownloadProgress, TypeBrowserError, TypeBrowserGranted, TypeBrowserCursor:
		if h.OnBrowserMsg != nil {
			h.OnBrowserMsg(msg)
		}
```
with:
```go
	case TypeBrowserCommand:
		if h.OnBrowserCommand != nil {
			h.OnBrowserCommand(msg)
		}
	case TypeBrowserResult:
		if h.OnBrowserResult != nil {
			h.OnBrowserResult(msg)
		}
```
> The `TypeBrowserAction` / `TypeBrowserActionResult` cases above it are the MCP
> snapshot/click relay — **leave them untouched** (out of scope for CDP removal).

**Verification:** none yet.

---

### Task B4: `internal/sessiond/server.go` — remove BrowserManager, screencast broadcast, and CDP switch cases

**Files:**
- Modify: `internal/sessiond/server.go`

**Implementation**

(1) Remove the `browserManager` / `browserPanes` struct fields (lines 27–32):
```go
	// browserManager owns Chromium and CDPConn. Created in NewServer; never nil.
	browserManager *BrowserManager
	// browserPanes maps workspace-local paneID → workspaceID for all live browser-cdp
	// panes. Protected by mu. Needed so broadcastBrowserData can scope to the right
	// workspace subscribers.
	browserPanes map[int]string
```
(Delete those six lines; the struct closes right after `conns`.)

(2) In `NewServer`, remove the `browserPanes` init and the `browserManager`
wiring (lines 46 and 48–55). The result should read:
```go
	s := &Server{
		reg:    NewRegistry(),
		socket: socketPath,
		subs:   make(map[string]map[*conn]bool),
		conns:  make(map[*conn]bool),
	}
	return s, nil
```
(Delete `browserPanes: make(map[int]string),` and the entire
`s.browserManager = NewBrowserManager(... )` call.)

(3) Remove `broadcastBrowserData` and `broadcastBrowserControlAny` entirely
(lines 228–271) — both functions and their doc comments. The `log`, `json`,
`context`, and `time` imports become suspect; see step (6).

(4) In `handle()`, replace the whole CDP case run (lines 405–501):
```go
	case TypeCreateBrowserPane:
		c.createBrowserCDPPane(msg)
	case TypeCloseBrowserPane:
		// Close the Chromium page before removing the pane from the registry.
		c.srv.browserManager.ClosePage(msg.PaneID)
		// Clean up the pane → workspace tracking entry.
		c.srv.mu.Lock()
		delete(c.srv.browserPanes, msg.PaneID)
		c.srv.mu.Unlock()
		// Reuse closePane: removes pane from registry, broadcasts pane-closed.
		c.closePane(msg)
	case TypeBrowserFocus:
		... (all the way through) ...
		ctx := context.Background()
		if err := bp.HandleInput(ctx, inputMsg); err != nil {
			log.Printf("sessiond: HandleInput pane %d: %v", msg.PaneID, err)
		}
```
with:
```go
	case TypeCreateBrowserPane:
		c.createBrowserPane(msg)
	case TypeCloseBrowserPane:
		// No server-side engine: just remove the pane handle and broadcast
		// pane-closed. Reuse closePane (idempotent for unknown ids).
		c.closePane(msg)
	case TypeBrowserCommand, TypeBrowserResult:
		// Relay to every subscriber of the attached workspace. The command flows
		// to the client owning the pane; the result flows back to subscribers
		// (e.g. the MCP agent). cid is preserved for correlation.
		if c.attached == "" {
			return
		}
		relay := msg
		c.srv.broadcast(c.attached, &relay)
```
> `TypeScreenSnapshot` (the next case, currently at line 502) is unaffected —
> keep it.

(5) Rename `createBrowserCDPPane` → `createBrowserPane` and strip Chromium
(lines 626–669). Replace the whole function:
```go
// createBrowserCDPPane creates a placeholder browser-cdp pane in the attached
// workspace. It replies with TypePaneCreated and broadcasts TypePaneAdded with
// SurfaceKind "browser-cdp". The daemon starts the actual Chromium page
// immediately after registering the pane.
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

	// Track pane → workspace mapping for browser frame broadcast.
	c.srv.mu.Lock()
	c.srv.browserPanes[localID] = wsID
	c.srv.mu.Unlock()

	// Start the Chromium page in the daemon. Run in a goroutine so a slow
	// Chromium startup (or download) does not block the create-pane reply.
	// Errors are surfaced via browser-error JSON broadcast to clients.
	go func() {
		if _, err := c.srv.browserManager.OpenPage(localID); err != nil {
			log.Printf("sessiond: browserManager.OpenPage pane %d: %v", localID, err)
		}
	}()

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
→
```go
// createBrowserPane allocates a client-rendered browser pane handle in the
// attached workspace. It replies with TypePaneCreated and broadcasts
// TypePaneAdded with SurfaceKind "browser". There is NO server-side engine — the
// webview lives on the client; the daemon only routes browser-command /
// browser-result for this pane id.
func (c *conn) createBrowserPane(msg Message) {
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
	// A browser pane carries no PTY. NewBrowserPane installs a nil buffer so the
	// registry tracks the handle without spawning a process.
	c.srv.reg.PutPane(wsID, NewBrowserPane(localID))

	c.reply(&Message{Type: TypePaneCreated, CID: msg.CID, PaneID: localID})
	c.srv.broadcast(wsID, &Message{
		Type:            TypePaneAdded,
		WorkspaceID:     wsID,
		PaneID:          localID,
		SurfaceKind:     "browser",
		Title:           "Browser",
		ClientRef:       msg.ClientRef,
		Placement:       msg.Placement,
		ReferencePaneID: msg.ReferencePaneID,
	})
}
```
> `newBrowserCDPPane` was defined in the deleted `browser_manager.go`. Task B5
> adds a tiny replacement `NewBrowserPane` in `pane.go` so a browser handle is a
> real (bufferless) registry entry with no Chromium dependency.

(6) Fix imports. After removing `broadcastBrowserData` / `broadcastBrowserControlAny`
and the CDP switch cases, `context`, `log`, `json`, and `time` may be unused.
Run `goimports`/let the build tell you, then trim `internal/sessiond/server.go`'s
import block to only what remains used (`errors`, `net`, `os`, `path/filepath`,
`sync`). Confirm during the Stage-D build.

**Verification:** none yet.

---

### Task B5: `internal/sessiond/pane.go` — add a bufferless browser-pane constructor

**Files:**
- Modify: `internal/sessiond/pane.go`

**Context:** `createBrowserPane` needs to put a pane handle into the registry
without a PTY. The deleted `newBrowserCDPPane` did this; provide a minimal,
engine-free replacement. First inspect the `Pane` struct so the constructor
matches its real fields.

**Implementation**
```bash
cd /home/ken/workspace/muxterm
# Inspect the Pane struct + how newBrowserCDPPane used to build one:
grep -n "type Pane struct" -A 25 internal/sessiond/pane.go
git show HEAD:internal/sessiond/browser_manager.go | sed -n '340,370p'
```
Then add, at the end of `internal/sessiond/pane.go`, a constructor mirroring the
old `newBrowserCDPPane` body but named exported-internal and free of any
`BrowserManager`/CDP references. It must produce a `*Pane` whose `Info()` returns
`SurfaceKind: "browser"`, a nil VT buffer, and a no-op `Close()` / `Replay()`.
Example shape (adapt field names to the real struct revealed above):
```go
// NewBrowserPane returns a client-rendered browser pane handle: a registry entry
// with the given workspace-local id, surfaceKind "browser", and no PTY. It holds
// no OS resources — the browser engine lives entirely on the client. Replay()
// yields no bytes and Close() is a no-op.
func NewBrowserPane(localID int) *Pane {
	return &Pane{
		id:          localID,
		surfaceKind: "browser",
		// buf stays nil: browser panes have no VT grid (ScreenSnapshot already
		// tolerates a nil/non-VT buffer — see server.go handle TypeScreenSnapshot).
	}
}
```
> **Verify against reality:** the field names above (`id`, `surfaceKind`, `buf`)
> must match the actual `Pane` struct printed by the `grep` command. If the old
> `newBrowserCDPPane` set other fields (e.g. a title or a closed channel), copy
> exactly those, minus anything importing CDP. If `Pane` has unexported fields
> only set via `NewPane`, prefer replicating the smallest subset the registry +
> `Info()` + `Replay()` + `Close()` actually read for a browser pane.

**Verification:** none yet.

---

# STAGE C — Remove serve-layer CDP + rename in MCP

### Task C1: Delete `/ws/browser` (screencast WebSocket) and its test

**Files (delete):**
- `internal/server/ws_browser.go`
- `internal/server/ws_browser_test.go`

**Implementation**
```bash
cd /home/ken/workspace/muxterm
rm internal/server/ws_browser.go internal/server/ws_browser_test.go
```

**Verification:** none yet.

---

### Task C2: `internal/server/server.go` — remove the `/ws/browser` route + handler

**Files:**
- Modify: `internal/server/server.go`

**Implementation**

(1) Remove the route registration (line 87):
```go
	s.mux.HandleFunc("GET /ws/browser", s.handleWSBrowser)
```

(2) Remove the `handleWSBrowser` method (lines 166–168):
```go
func (s *Server) handleWSBrowser(w http.ResponseWriter, r *http.Request) {
	s.handleWSBrowserImpl(w, r)
}
```

**Verification:** none yet.

---

### Task C3: `internal/server/daemon.go` — update the DaemonConn interface

**Files:**
- Modify: `internal/server/daemon.go`

**Implementation**

Replace the browser section of the interface (lines 22–37):
```go
	CreatePane(cmd []string, placement string, referencePaneID int) (int, error)
	// CreateBrowserCDPPane creates a browser-cdp surface pane in the attached workspace.
	// Returns the server-assigned workspace-local pane ID. HTTP server layer starts
	// actual Chromium page separately via BrowserManager.OpenPage(paneID).
	CreateBrowserCDPPane(placement string, referencePaneID int) (int, error)
	ClosePane(paneID int) error
	Input(paneID uint32, data []byte) error
	Resize(paneID, cols, rows int) error
	BrowserActionResult(msg sessiond.Message) error
	// BrowserInput forwards a raw browser-input event JSON payload to the daemon.
	BrowserInput(paneID int, clientID string, event json.RawMessage) error
	// BrowserFocus sends a browser-focus event, claiming input authority and
	// updating the Chromium viewport to renderWidth × renderHeight at devicePixelRatio.
	BrowserFocus(paneID int, clientID, deviceID string, renderWidth, renderHeight int, devicePixelRatio float64) error
	// BrowserBlur sends a browser-blur event, releasing input authority.
	BrowserBlur(paneID int, clientID, deviceID string) error
```
with:
```go
	CreatePane(cmd []string, placement string, referencePaneID int) (int, error)
	// CreateBrowserPane allocates a client-rendered browser pane handle (surfaceKind
	// "browser") in the attached workspace and returns its workspace-local id. No
	// server-side engine is created.
	CreateBrowserPane(placement string, referencePaneID int) (int, error)
	ClosePane(paneID int) error
	Input(paneID uint32, data []byte) error
	Resize(paneID, cols, rows int) error
	BrowserActionResult(msg sessiond.Message) error
	// BrowserCommand relays a browser-command to the daemon (broadcast to workspace
	// subscribers). payload is the pre-marshalled command JSON.
	BrowserCommand(paneID int, cid uint64, payload json.RawMessage) error
	// BrowserResult relays a browser-result back to the daemon (broadcast to
	// workspace subscribers, echoing the command cid).
	BrowserResult(paneID int, cid uint64, payload json.RawMessage) error
```
> `json` (`encoding/json`) is still imported and used by the two new signatures —
> keep the import.

**Verification:** none yet.

---

### Task C4: `internal/server/ws.go` — reroute create/close + add command/result relay

**Files:**
- Modify: `internal/server/ws.go`

**Implementation**

(1) In `handleTextInput`, replace the CDP cases (lines 229–242):
```go
	case sessiond.TypeCreateBrowserPane:
		paneID, err := c.daemon.CreateBrowserCDPPane(msg.Placement, msg.ReferencePaneID)
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneCreated, CID: msg.CID, PaneID: paneID, ClientRef: msg.ClientRef})

	case sessiond.TypeCloseBrowserPane:
		if err := c.daemon.ClosePane(msg.PaneID); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})
```
with:
```go
	case sessiond.TypeCreateBrowserPane:
		paneID, err := c.daemon.CreateBrowserPane(msg.Placement, msg.ReferencePaneID)
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneCreated, CID: msg.CID, PaneID: paneID, ClientRef: msg.ClientRef})

	case sessiond.TypeCloseBrowserPane:
		if err := c.daemon.ClosePane(msg.PaneID); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypeBrowserCommand:
		// Client (or agent, once MCP is wired) relays a command; daemon broadcasts
		// it to the workspace so the pane's owner executes it. Fire-and-forget.
		if err := c.daemon.BrowserCommand(msg.PaneID, msg.CID, msg.Params); err != nil {
			log.Printf("handleTextInput: BrowserCommand error: %v", err)
		}

	case sessiond.TypeBrowserResult:
		// Executing client returns the result; daemon broadcasts it back to the
		// workspace (echoing cid) so the waiting requester receives it.
		if err := c.daemon.BrowserResult(msg.PaneID, msg.CID, msg.Result); err != nil {
			log.Printf("handleTextInput: BrowserResult error: %v", err)
		}
```

(2) In `attachClient`, extend the `dc.SetHandlers(sessiond.Handlers{...})` block
(installed at line 387) so daemon-broadcast browser-command / browser-result
events reach the browser. Add these two handlers alongside `OnPaneRenamed`
(after line 419, inside the same struct literal):
```go
		OnBrowserCommand: func(msg *sessiond.Message) {
			c.sendMessage(&sessiond.Message{
				Type:     sessiond.TypeBrowserCommand,
				PaneID:   msg.PaneID,
				CID:      msg.CID,
				Action:   msg.Action,
				Selector: msg.Selector,
				Params:   msg.Params,
			})
		},
		OnBrowserResult: func(msg *sessiond.Message) {
			c.sendMessage(&sessiond.Message{
				Type:   sessiond.TypeBrowserResult,
				PaneID: msg.PaneID,
				CID:    msg.CID,
				Result: msg.Result,
				Error:  msg.Error,
			})
		},
```
> `Params` is the new `Message` field from Task D2. `Action`, `Selector`,
> `Result`, `Error` already exist.

**Verification:** none yet.

---

### Task C5: `internal/server/daemon_test.go` — update the fake to the new interface

**Files:**
- Modify: `internal/server/daemon_test.go`

**Implementation**

Replace the fake's `CreateBrowserCDPPane` (lines 54–56) with `CreateBrowserPane`:
```go
func (f *fakeDaemonConn) CreateBrowserCDPPane(placement string, referencePaneID int) (int, error) {
	return f.createdID, nil
}
```
→
```go
func (f *fakeDaemonConn) CreateBrowserPane(placement string, referencePaneID int) (int, error) {
	return f.createdID, nil
}
```
Then replace the three CDP methods (`BrowserInput`, `BrowserFocus`,
`BrowserBlur`, lines 70–80) with the two new relay methods:
```go
func (f *fakeDaemonConn) BrowserInput(paneID int, clientID string, event json.RawMessage) error {
	return nil
}

func (f *fakeDaemonConn) BrowserFocus(paneID int, clientID, deviceID string, renderWidth, renderHeight int, devicePixelRatio float64) error {
	return nil
}

func (f *fakeDaemonConn) BrowserBlur(paneID int, clientID, deviceID string) error {
	return nil
}
```
→
```go
func (f *fakeDaemonConn) BrowserCommand(paneID int, cid uint64, payload json.RawMessage) error {
	return nil
}

func (f *fakeDaemonConn) BrowserResult(paneID int, cid uint64, payload json.RawMessage) error {
	return nil
}
```
> Keep `BrowserActionResult` — it is unchanged. `encoding/json` stays imported
> (used by `BrowserCommand`/`BrowserResult` signatures).

**Verification:** none yet.

---

### Task C6: `internal/server/ws_relay_test.go` — rename the tracking fake + assertions

**Files:**
- Modify: `internal/server/ws_relay_test.go`

**Context:** this file has a `trackingDaemonConn` that records
`createBrowserCDPPaneCalled` and two tests asserting `TypeCreateBrowserPane`
routes to `CreateBrowserCDPPane`. The behavior still holds under the new name.

**Implementation**
```bash
cd /home/ken/workspace/muxterm
# See exactly what needs renaming:
grep -n "CreateBrowserCDPPane\|createBrowserCDPPaneCalled\|BrowserInput\|BrowserFocus\|BrowserBlur" internal/server/ws_relay_test.go
```
Then:
- Rename the field `createBrowserCDPPaneCalled` → `createBrowserPaneCalled`
  (`replace_all` in this file).
- Rename the method `func (f *trackingDaemonConn) CreateBrowserCDPPane(...)` →
  `CreateBrowserPane(...)` (body unchanged).
- If `trackingDaemonConn` implements `BrowserInput` / `BrowserFocus` /
  `BrowserBlur`, replace them with `BrowserCommand(paneID int, cid uint64,
  payload json.RawMessage) error { return nil }` and `BrowserResult(paneID int,
  cid uint64, payload json.RawMessage) error { return nil }` so it still
  satisfies `DaemonConn`.
- Update the two test names/asserts (`...CallsCreateBrowserCDPPane`,
  `createBrowserCDPPaneCalled`) to the new identifiers. The test intent —
  "`create-browser-pane` routes to the create method, not `CreatePane`" — is
  unchanged.

> Per project policy (AGENTS.md): fix broken tests to match new behavior; do not
> add new ones.

**Verification:** none yet.

---

### Task C7: `internal/server/wiring_test.go` — update create/close tests, delete the route test

**Files:**
- Modify: `internal/server/wiring_test.go`

**Implementation**
```bash
cd /home/ken/workspace/muxterm
grep -n "CreateBrowserCDPPane\|/ws/browser\|WSBrowserRoute\|BrowserInput\|BrowserFocus\|BrowserBlur\|TypeCreateBrowserPane\|TypeCloseBrowserPane" internal/server/wiring_test.go
```
- Update the comment + any fake method: `daemon.CreateBrowserCDPPane` →
  `CreateBrowserPane`. The `TestHandleTextInput_TypeCreateBrowserPane` and
  `TestHandleTextInput_TypeCloseBrowserPane` tests keep their intent (routing to
  create/close) — only the referenced method name changes.
- **Delete** `TestWSBrowserRouteRegistered` (lines ~106–118): the `/ws/browser`
  route no longer exists, so a test asserting it is registered is now testing a
  removed feature. Remove the whole `func TestWSBrowserRouteRegistered(...)`.
- If this file declares its own fake `DaemonConn`, apply the same
  `BrowserInput/Focus/Blur` → `BrowserCommand/BrowserResult` swap as Task C5.

**Verification:** none yet.

---

### Task C8: `internal/mcp/tools_layout.go` — rename the browser-pane call

**Files:**
- Modify: `internal/mcp/tools_layout.go:52`

**Implementation**

Replace line 52:
```go
		id, err := lt.c.conn.CreateBrowserCDPPane(placement, referencePaneID)
```
with:
```go
		id, err := lt.c.conn.CreateBrowserPane(placement, referencePaneID)
```
> `lt.c.conn` is a `*sessiond.Client` (see `internal/mcp/client.go:16`), so this
> resolves to the method renamed in Task B3. The MCP browser tool tests
> (`tools_browser_*_test.go`) use the browser-**action** relay, which is
> untouched — no changes needed there.

---

# STAGE D — Wire the new protocol field + verify the whole Go change

### Task D1: (covered) new protocol constants

Already added in Task B1 step (2): `TypeBrowserCommand`, `TypeBrowserResult`.
No separate edit — this task exists so the checklist is explicit.

### Task D2: `internal/sessiond/protocol.go` — add the `Params` field with a documented schema

**Files:**
- Modify: `internal/sessiond/protocol.go`

**Implementation**

In the `Message` struct, immediately after the existing MCP relay fields (after
`ASCII` at line 200, before the `Snapshot`/`Result`/`OK` block at 202–205), add:
```go
	// Params carries the browser-command parameters as raw JSON for passthrough
	// relay (TypeBrowserCommand). Schema (see docs/muxterm-client-protocol.md):
	//   { "action": "navigate|click|scroll|evaluate|back|forward|reload",
	//     "selector"?: string,        // CSS selector — element targeting
	//     "x"?: number, "y"?: number, // CSS px — coordinate targeting
	//     "url"?: string,             // for navigate
	//     "script"?: string,          // for evaluate
	//     "timeoutMs"?: number }      // evaluate timeout; default 30000, bounded
	// An action carries EXACTLY ONE of {selector} or {x,y}. evaluate is governed
	// by a bounded timeout (default 30s) so an injected script cannot hang the pane.
	Params json.RawMessage `json:"params,omitempty"`
```

**Verification:** none yet — build in Task D6.

---

### Task D3: (covered) client handlers + senders

Already added in Task B3: `Handlers.OnBrowserCommand` / `OnBrowserResult`,
`Client.BrowserCommand` / `BrowserResult`, and the `dispatchEvent` cases. This
task marker keeps the checklist explicit.

---

### Task D4: (covered) daemon relay switch cases

Already added in Task B4 step (4): `create-browser-pane` → `createBrowserPane`,
`close-browser-pane` → `closePane`, `browser-command`/`browser-result` → relay
broadcast.

---

### Task D5: (covered) serve relay + MCP rename

Already done in Tasks C4 and C8.

---

### Task D6: Build, test, and live `/ws` round-trip verification

**Static Analysis / Build**
```bash
cd /home/ken/workspace/muxterm
go build ./...
```
Expected: no output, exit 0. If the compiler flags unused imports in
`internal/sessiond/server.go` (e.g. `context`, `log`, `json`, `time`), remove
exactly those from its import block and rebuild until clean.

**Tests**
```bash
go test ./...
```
Expected: all packages `ok` (or `no test files`). The deleted browser tests are
gone; the updated `internal/server` fakes compile against the new interface.
Watch specifically for `internal/server` and `internal/sessiond` — both must pass.
> If `internal/server/relay_test.go:TestBrowserInputAndResizeReachDaemon` fails
> to compile, it referenced a removed method — update it to the pane-input /
> resize path only (it drives `EncodeBinaryFrame`, which is retained).

**Live protocol round-trip** — build the binary, run the server, drive `/ws`:
```bash
make build            # builds web + go into ./bin/muxterm
./bin/muxterm serve --no-auth --addr 127.0.0.1:8399 &
MUX_PID=$!
sleep 1
```
Create the throwaway driver (Node ≥ 21 has a built-in `WebSocket`; this node is
v24):
```bash
cat > /tmp/mux_ws_check.mjs <<'EOF'
const ws = new WebSocket('ws://127.0.0.1:8399/ws');
const seen = [];
let paneId = null;
ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') return; // ignore binary PTY frames
  const m = JSON.parse(ev.data);
  seen.push(m.type);
  if (m.type === 'workspace-list' && m.workspaces?.length) {
    ws.send(JSON.stringify({ type: 'attach', cid: 1, workspaceId: m.workspaces[0].workspaceId, breakpoint: 'wide' }));
  }
  if (m.type === 'composition') {
    ws.send(JSON.stringify({ type: 'create-browser-pane', cid: 2 }));
  }
  if (m.type === 'pane-added' && m.surfaceKind === 'browser') {
    paneId = m.paneId;
    console.log('PANE_ADDED_BROWSER paneId=' + paneId);
    ws.send(JSON.stringify({ type: 'browser-command', cid: 3, paneId,
      params: { action: 'navigate', url: 'http://localhost:5173' } }));
  }
  if (m.type === 'browser-command' && m.paneId === paneId) {
    console.log('BROWSER_COMMAND_RELAYED cid=' + m.cid);
    // Echo a result back; the daemon should broadcast it to subscribers (us).
    ws.send(JSON.stringify({ type: 'browser-result', cid: m.cid, paneId,
      result: { ok: true } }));
  }
  if (m.type === 'browser-result' && m.paneId === paneId) {
    console.log('BROWSER_RESULT_RELAYED cid=' + m.cid);
    console.log('OK_ALL');
    ws.close();
  }
};
ws.onopen = () => setTimeout(() => {
  // If nothing arrived, ask for the workspace list explicitly.
  if (!seen.includes('workspace-list')) ws.send(JSON.stringify({ type: 'list-workspaces', cid: 9 }));
}, 200);
ws.onerror = (e) => { console.error('WS_ERROR', e.message); process.exit(1); };
setTimeout(() => { console.error('TIMEOUT seen=' + seen.join(',')); process.exit(1); }, 5000);
EOF
node /tmp/mux_ws_check.mjs
kill $MUX_PID
```
Expected output (order may interleave with server logs):
```
PANE_ADDED_BROWSER paneId=<n>
BROWSER_COMMAND_RELAYED cid=3
BROWSER_RESULT_RELAYED cid=3
OK_ALL
```
This proves, against the **real** server: the bootstrap runs, `create-browser-pane`
allocates a `surfaceKind:"browser"` pane with **no** Chromium, and both
`browser-command` and `browser-result` relay through the daemon with the cid
preserved.

**Commit** (single commit for Stages A–D)
```bash
cd /home/ken/workspace/muxterm
git add internal/sessiond internal/server internal/mcp
git commit -m "feat: remove server-side CDP browser; add client-driven browser-command/result relay

Deletes sessiond Chromium/CDP ownership (BrowserManager, screencast, /ws/browser)
and the JPEG FrameBrowserData path. Renames CreateBrowserCDPPane -> CreateBrowserPane
(now a bufferless client-rendered handle, surfaceKind \"browser\"). Adds the
browser-command / browser-result relay messages the native apps drive.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

# STAGE E — Web: flip surfaceKind + render a placeholder

### Task E1: Delete the web CDP browser modules and their tests

**Files (delete):**
- `web/src/components/mux-browser-pane.ts`
- `web/src/lib/browser-registry.ts`
- `web/src/lib/ws-browser.ts`
- `web/src/lib/browser-registry.test.ts`
- `web/src/lib/ws-browser.test.ts`

**Implementation**
```bash
cd /home/ken/workspace/muxterm
rm web/src/components/mux-browser-pane.ts \
   web/src/lib/browser-registry.ts \
   web/src/lib/ws-browser.ts \
   web/src/lib/browser-registry.test.ts \
   web/src/lib/ws-browser.test.ts
```
> The originally-listed `web/src/components/__tests__/mux-browser-pane.test.ts`
> does **not** exist — do not try to delete it.

**Verification:** none yet (build after Task E4).

---

### Task E2: `web/src/types.ts` — flip the surface kind + trim CDP message types

**Files:**
- Modify: `web/src/types.ts`

**Implementation**

(1) Flip `SurfaceKind` and its doc (lines 1–11):
```ts
/**
 * Discriminates the four surface kinds.
 *
 * terminal / driver — cell-grid surfaces (cols×rows budget, xterm.js).
 * browser-cdp / settings — NON-terminal (pixel box, normal responsive DOM, NO terminal cell grid).
 */
export type SurfaceKind = 'terminal' | 'driver' | 'browser-cdp' | 'settings';
```
→
```ts
/**
 * Discriminates the four surface kinds.
 *
 * terminal / driver — cell-grid surfaces (cols×rows budget, xterm.js).
 * browser / settings — NON-terminal. `browser` panes are client-rendered by the
 *   native apps; the web client shows a non-interactive placeholder for them.
 */
export type SurfaceKind = 'terminal' | 'driver' | 'browser' | 'settings';
```

(2) In the `SessiondType` map, replace the CDP block (lines 53–59):
```ts
  // Browser CDP pane management
  CreateBrowserPane: 'create-browser-pane',
  CloseBrowserPane: 'close-browser-pane',
  BrowserInput: 'browser-input',
  BrowserURL: 'browser-url',
  BrowserDownloadProgress: 'browser-download-progress',
  BrowserError: 'browser-error',
```
with:
```ts
  // Client-driven browser panes (native apps own the engine; web shows placeholder)
  CreateBrowserPane: 'create-browser-pane',
  CloseBrowserPane: 'close-browser-pane',
  BrowserCommand: 'browser-command',
  BrowserResult: 'browser-result',
```

(3) Fix the `LayoutCommand.kind` union (line 167):
```ts
  kind?: 'terminal' | 'browser-cdp';
```
→
```ts
  kind?: 'terminal' | 'browser';
```

**Verification:** none yet.

---

### Task E3: `web/src/app.ts` — drop CDP wiring, keep browser panes as opaque slots

**Files:**
- Modify: `web/src/app.ts`

**Implementation**

(1) Remove the two dead imports (lines 13–14):
```ts
import { browserRegistry } from './lib/browser-registry.js';
import { wsBrowser } from './lib/ws-browser.js';
```

(2) Remove the CDP handler wiring. Delete `_onCreateBrowserPane` and
`_onBrowserPaneFocus` (lines 443–450):
```ts
  private _onCreateBrowserPane = (): void => { this._socket?.createBrowserPane(); };
  private _onBrowserPaneFocus = (e: Event): void => {
    const paneId = (e as CustomEvent<{ paneId: number }>).detail?.paneId;
    if (paneId !== undefined) {
      store.setActivePane(paneId);
      this._dock?.activatePane(paneId);
    }
  };
```

(3) In the composition loop, change the `browser-cdp` branch (line 524). It
currently routes browser panes into `browserRegistry`; now browser panes are
opaque render-only slots, so just skip terminal setup for them:
```ts
          if (pane.surfaceKind === 'browser-cdp') { browserRegistry.ensure(paneId); continue; }
```
→
```ts
          // Browser panes are client-rendered (native apps). The web client
          // renders a placeholder (see mux-dock PlaceholderRenderer) and does no
          // terminal setup for them.
          if (pane.surfaceKind === 'browser') { continue; }
```

(4) Remove the `wsBrowser` wiring block (lines 587–596):
```ts
    wsBrowser.onFrame = (paneId, jpegBytes) => browserRegistry.write(paneId, jpegBytes);
    wsBrowser.onBrowserUrl = (paneId, url) => browserRegistry.dispatchUrl(paneId, url);
    wsBrowser.onBrowserError = (paneId, error) => browserRegistry.dispatchError(paneId, error);
    wsBrowser.onDownloadProgress = (paneId, percent) => browserRegistry.dispatchDownload(paneId, percent);
    wsBrowser.onBrowserStatus = (paneId, text) => browserRegistry.dispatchStatus(paneId, text);
    wsBrowser.onBrowserCursor = (paneId, cursor) => browserRegistry.dispatchCursor(paneId, cursor);
    wsBrowser.onBrowserGranted = (paneId, clientId) => browserRegistry.dispatchGranted(paneId, clientId);
    wsBrowser.connect();
    window.addEventListener('create-browser-pane', this._onCreateBrowserPane);
    window.addEventListener('browser-pane-focus', this._onBrowserPaneFocus);
```
(Delete all ten lines.)

(5) Remove the teardown wiring (lines 606–608):
```ts
    wsBrowser.disconnect();
    window.removeEventListener('create-browser-pane', this._onCreateBrowserPane);
    window.removeEventListener('browser-pane-focus', this._onBrowserPaneFocus);
```
(Delete all three lines.)

(6) In the `_syncTerminals` reconcile loop, change the second browser branch
(line 666) so browser panes stay "alive" (kept in the layout) but do no terminal
work, and drop the `browserRegistry.prune` call (line 676):
```ts
      if (pane.surfaceKind === 'browser-cdp') { browserRegistry.ensure(paneId); liveIds.add(paneId); continue; }
```
→
```ts
      // Browser panes: opaque placeholder slots. Keep them in the live set so
      // the dock doesn't prune the panel, but do no terminal/registry work.
      if (pane.surfaceKind === 'browser') { liveIds.add(paneId); continue; }
```
and delete line 676:
```ts
    browserRegistry.prune(liveIds);
```

**Verification:** none yet.

---

### Task E4: `web/src/components/mux-dock.ts` — swap BrowserRenderer for a PlaceholderRenderer

**Files:**
- Modify: `web/src/components/mux-dock.ts`

**Implementation**

(1) Remove the `mux-browser-pane` side-effect import (lines 11–12):
```ts
// Side-effect import: registers <mux-browser-pane> custom element
import './mux-browser-pane.js';
```

(2) Replace the `BrowserRenderer` class (lines 102–135) with a
`PlaceholderRenderer` that renders a non-interactive message and tolerates
browser panes without touching the surrounding layout:
```ts
// ─────────────────────────────────────────────────────────────────────────────
// PlaceholderRenderer
// Renders a non-interactive placeholder for client-rendered `browser` panes.
// The web client cannot host a cross-origin webview, so browser panes created by
// the native apps appear here as an opaque, render-only slot. It never errors and
// never disturbs the surrounding dockview layout.
// ─────────────────────────────────────────────────────────────────────────────

class PlaceholderRenderer implements IContentRenderer {
  readonly element: HTMLElement;

  constructor(_id: string) {
    const el = document.createElement('div');
    el.style.cssText =
      'width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
      'text-align:center;padding:24px;box-sizing:border-box;' +
      'color:var(--chrome-text-dim);background:var(--chrome-body);user-select:none;font-size:13px;';
    el.innerHTML =
      '<div><div style="font-size:15px;color:var(--mux-fg);font-weight:600;margin-bottom:8px;">' +
      'Browser pane</div><div>Browser panes are available in the native apps.</div></div>';
    this.element = el;
  }

  init(): void {}
  layout(): void {}
  focus(): void {}
  dispose(): void {}
}
```

(3) Update `_onBrowserButtonClick` (lines 303–310). The web client no longer
creates browser panes (there is nothing to render but a placeholder), so make
the header button a no-op that focuses an existing browser pane if one is present
and otherwise does nothing. Replace:
```ts
  private _onBrowserButtonClick(): void {
    const existing = store.panes.find((p) => p.surfaceKind === 'browser-cdp');
    if (existing) {
      this.activatePane(existing.paneId);
    } else {
      window.dispatchEvent(new CustomEvent('create-browser-pane'));
    }
  }
```
with:
```ts
  private _onBrowserButtonClick(): void {
    // Web can only display a placeholder for browser panes (native apps own the
    // engine). Focus an existing browser pane if present; otherwise do nothing.
    const existing = store.panes.find((p) => p.surfaceKind === 'browser');
    if (existing) this.activatePane(existing.paneId);
  }
```

(4) Flip the renderer registration (line 598):
```ts
        if (opts.name === 'browser-cdp') return new BrowserRenderer(opts.id);
```
→
```ts
        if (opts.name === 'browser') return new PlaceholderRenderer(opts.id);
```

(5) Flip the active-panel branch (line 659). Browser panes no longer resume a
Chromium screencast; treat them like any non-terminal pane:
```ts
      if (paneInfo?.surfaceKind === 'browser-cdp') {
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent('browser-pane-activated', { detail: { paneId } }));
        });
      } else {
```
→
```ts
      if (paneInfo?.surfaceKind === 'browser') {
        // Placeholder pane: nothing to focus, no screencast to resume.
      } else {
```
> The `component: pane.surfaceKind ?? 'terminal'` lines (845, 869, 955, 1084)
> need **no** change — a `browser` pane now yields component name `'browser'`,
> which `createComponent` maps to `PlaceholderRenderer` via step (4).

**Static Analysis**
```bash
cd /home/ken/workspace/muxterm
npm --prefix web run check:fast
```
Expected: `0 errors` from tsgo + oxlint. Fix any dangling references the checker
finds (e.g. a leftover `BROWSER_ICON` import used only by the removed button —
if `check:fast` flags it as unused, remove it).

**Verification** (build + real browser)
```bash
npm --prefix web run build
```
Expected: `tsc --noEmit` passes and `vite build` writes `web/dist` with no errors.

Then load the UI and confirm a `browser` pane renders the placeholder without
breaking the dock. Use the live server from Stage D plus `playwright-cli`:
```bash
make build
./bin/muxterm serve --no-auth --addr 127.0.0.1:8399 &
MUX_PID=$!
sleep 1
# Create a browser pane over /ws so the web dock has one to render:
node /tmp/mux_ws_check.mjs   # from Stage D; leaves a browser pane in the default workspace
playwright-cli open http://127.0.0.1:8399
playwright-cli snapshot      # confirm the placeholder text is visible and the terminal pane still renders
playwright-cli close
kill $MUX_PID
```
Expected: the snapshot shows the terminal pane AND a pane containing
"Browser panes are available in the native apps." The dock layout is intact (no
console error, no blank/broken region).

**Commit**
```bash
git add web/src
git commit -m "feat(web): render placeholder for client-rendered browser panes; remove CDP canvas

Deletes the JPEG canvas browser pane (mux-browser-pane), BrowserSocket, and
browser-registry. Flips surfaceKind browser-cdp -> browser and renders a
non-interactive placeholder for browser panes so the web dock tolerates panes it
cannot host, without breaking the layout.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

# STAGE F — Extract the frozen client protocol spec

### Task F1: Write `docs/muxterm-client-protocol.md`

**Files:**
- Create: `docs/muxterm-client-protocol.md`

**Context:** this is the reference deliverable both native apps build against.
Source the exact shapes from the post-Phase-0 code: `internal/sessiond/protocol.go`
(frame layout `writeFrame`/`ReadFrame` lines 84–159, the `Message` struct,
`WriteControl`/`WritePaneData`/`DecodePaneData`, `PaneInfo`/`WorkspaceInfo`) and
the bootstrap ordering in `attachConn` (`server.go` lines 136–196, the composition
→ replay → live settle barrier via `TotalSeq`).

**Implementation** — write the following document:
```markdown
# muxterm Client Protocol (v1)

> Frozen contract. Native clients (Swift, Android) and the web client all speak
> exactly this. Field names are the Go JSON tags, byte-for-byte. Additive changes
> only; never repurpose a field or a message type.

## 1. Transport & framing

The client connects to `GET /ws` (a loopback WebSocket after any SSH forward).
Two WebSocket message kinds are used:

- **Text frames** carry one JSON `Message` envelope (§3).
- **Binary frames** carry PTY bytes: `[4-byte LITTLE-ENDIAN uint32 paneId][raw VT bytes]`.

> The daemon's internal Unix-socket framing (`[4-byte BIG-ENDIAN length][1-byte
> kind][payload]`, kinds `0x01` control / `0x02` pane-data) is an implementation
> detail of the serve↔daemon hop. Over `/ws`, control = WebSocket **text**,
> pane-data = WebSocket **binary** with the little-endian paneId prefix above.
> Encode/decode helpers mirror Go `WritePaneData` / `DecodePaneData`.

## 2. Bootstrap sequence

On connect the client observes, in order:

1. `config` — a serve-local envelope `{"type":"config","config":{…}}` (theme,
   terminal options, keybindings). Not a daemon message.
2. `workspace-list` — `{type, workspaces:[WorkspaceInfo]}`.
3. Client sends `attach` `{type:"attach", cid, workspaceId, breakpoint}`.
4. `composition` — `{type, cid, workspaceId, panes:[PaneInfo], layout}`. Sent
   FIRST, always (nil panes for an empty workspace).
5. Per-pane **replay** binary frames arrive BEFORE any live output.
6. Live output (binary frames) and events (text) follow.

### Settle barrier (required)

Each `PaneInfo.totalSeq` is the exact byte count of that pane's replay stream.
The client feeds replay bytes into a fresh emulator instance, counting bytes, and
MUST gate both user input and rendering until `receivedBytes >= totalSeq`, with a
hard 3-second timeout escape that drains partial replay so a byte-count mismatch
cannot lock the pane. On reconnect, reset only the settle state
(`ready=false`, counters=0, generation++), re-send `attach`, and drain fresh
replay into the existing scrollback (do not dispose the emulator).

## 3. The Message envelope

One struct; the `type` field discriminates. All fields `omitempty`.

| field | json | notes |
|-------|------|-------|
| Type | `type` | message type (§4) |
| CID | `cid` | request/reply + browser-command correlation; 0 = unsolicited event |
| ClientRef | `clientRef` | optimistic-create correlation id |
| WorkspaceID | `workspaceId` | |
| Name | `name` | |
| PaneID | `paneId` | workspace-local |
| Cols / Rows | `cols` / `rows` | |
| Cmd | `cmd` | argv; empty = default $SHELL |
| Title | `title` | |
| Breakpoint | `breakpoint` | responsive layout key (opaque to daemon) |
| Layout | `layout` | opaque layout JSON blob (per-breakpoint) |
| Workspaces | `workspaces` | []WorkspaceInfo |
| Panes | `panes` | []PaneInfo |
| Code / Error | `code` / `error` | error envelope |
| SurfaceKind | `surfaceKind` | `"terminal"` \| `"browser"`; absent = terminal |
| Placement | `placement` | tab \| split-{right,left,above,below} |
| ReferencePaneID | `referencePaneId` | split reference; 0 = active pane |
| Action | `action` | browser-command verb |
| Selector | `selector` | CSS selector (element targeting) |
| Result | `result` | raw JSON result (browser-result, eval) |
| Params | `params` | raw JSON browser-command params (§5) |
| ASCII / Text / Snapshot | `ascii` / `text` / `snapshot` | MCP results |

`WorkspaceInfo`: `{workspaceId, name?, clientRef?, paneCount}`.
`PaneInfo`: `{paneId, surfaceKind?, cols?, rows?, title?, totalSeq?, placement?, referencePaneId?}`.

## 4. Message types

**Requests (client → daemon):** create-workspace, list-workspaces,
rename-workspace, close-workspace, attach, create-pane, close-pane, resize,
rename-pane, save-layout, screen-snapshot, get-layout, create-browser-pane,
close-browser-pane.

**Replies (daemon → requester, echo cid):** workspace-created, workspace-list,
composition, pane-created, ok, screen-snapshot-result, layout-result.

**Events (daemon → subscribers, cid = 0 unless noted):** pane-added, pane-closed,
workspace-closed, workspace-renamed, pane-renamed, shell-prompt,
browser-command (carries cid), browser-result (echoes cid).

**Errors:** `error` with `code` ∈ {unknown-workspace, pane-spawn-failed,
pane-not-found}.

## 5. Browser control (client-rendered, server-drivable)

The daemon holds only a pane **handle**; the browser engine lives on the client.

- `create-browser-pane` `{type, cid, placement?, referencePaneId?}` →
  `pane-created` `{cid, paneId}` reply, plus a `pane-added`
  `{paneId, surfaceKind:"browser", title:"Browser", …}` broadcast.
- `browser-command` `{type, paneId, cid, params}` — relayed to all workspace
  subscribers. The client owning/focused on the pane executes it.
  `params` (raw JSON):
  ```json
  {
    "action": "navigate | click | scroll | evaluate | back | forward | reload",
    "selector": "css-selector",   // element targeting  (EXACTLY ONE of selector / x,y)
    "x": 0, "y": 0,               // coordinate targeting (CSS px)
    "url": "http://localhost:5173",
    "script": "return document.title",
    "timeoutMs": 30000             // evaluate timeout; default 30000, bounded
  }
  ```
  Every manipulation compiles to a native nav call or an injected-JS `evaluate`.
  An action carries EXACTLY ONE of `{selector}` or `{x,y}`.
- `browser-result` `{type, paneId, cid, result | error}` — the executing client
  returns this; the daemon broadcasts it back to workspace subscribers (echoing
  the command cid).

**Constraints:** a browser pane is drivable only while a client is attached and
focused on it (last-focus-wins authority). There is no server-side headless
fallback; a command to an unowned pane yields a typed `browser-result` error.
The `evaluate` action is bounded by `timeoutMs` (default 30 s) so an injected
script cannot hang the pane.

## 6. Binary helpers (parity with Go)

- Encode pane input: `[4-byte LE paneId][bytes]` → WebSocket binary.
- Decode pane output: first 4 bytes LE = paneId, remainder = raw VT bytes; feed
  to that pane's emulator. A payload shorter than 4 bytes is malformed.
```

**Verification**
```bash
cd /home/ken/workspace/muxterm
test -f docs/muxterm-client-protocol.md && wc -l docs/muxterm-client-protocol.md
grep -c "browser-command\|totalSeq\|create-browser-pane\|surfaceKind" docs/muxterm-client-protocol.md
```
Expected: the file exists with a non-trivial line count, and the grep count is
≥ 4 (the key contract terms are present). Optionally render it in a Markdown
viewer to confirm the tables and fenced blocks are well-formed.

**Commit**
```bash
git add docs/muxterm-client-protocol.md
git commit -m "docs: extract frozen muxterm-client-protocol.md (native app contract)

The written client contract both native apps (Phase 1 Swift, Phase 2 Android)
build against: frame layout, the Message envelope, the config→workspace-list→
attach→composition→replay→live bootstrap with the totalSeq settle barrier, and
the new browser-command / browser-result control messages.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Final verification checklist

Run from a clean tree after all three commits:
```bash
cd /home/ken/workspace/muxterm
go build ./...                     # exit 0
go test ./...                      # all packages ok
npm --prefix web run check:fast    # 0 errors
npm --prefix web run build         # success
grep -rn "browser-cdp\|BrowserManager\|/ws/browser\|FrameBrowserData\|mux-browser-pane" \
   internal web/src --include=*.go --include=*.ts   # expect: no matches (all CDP removed)
```
Expected: the four build/check commands pass and the final grep returns **no
matches** — confirming every server-side CDP/Chromium/JPEG reference is gone and
the codebase now speaks only the client-driven browser protocol.

---

**Saved to:** `docs/plans/2026-07-01-phase0-cdp-removal-and-protocol-implementation.md`
