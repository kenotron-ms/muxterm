# Browser Session Architecture — Phase 1: sessiond Ownership

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Move Chromium and BrowserManager from the HTTP server process into the sessiond daemon so browser sessions survive HTTP server restarts.

**Architecture:** Two separate OS processes: `sessiond` (owns PTY sessions + BrowserManager) and the HTTP server (pure relay). A new `FrameBrowserData (0x03)` frame kind carries JPEG frames from the daemon to all connected HTTP server clients over the existing Unix socket. The HTTP server's `/ws/browser` WebSocket handler dials its own daemon connection and relays frames bidirectionally — mirroring the pattern that already exists for PTY output.

**Tech Stack:** Go, Unix domain socket binary protocol, Chrome DevTools Protocol (CDP), nhooyr.io/websocket.

---

## Context: What You Are Working With

### Two OS Processes

**`muxterm sessiond`** — the daemon. Owns PTY sessions, workspaces, Chromium. Listens on a Unix socket at `$XDG_RUNTIME_DIR/muxterm/sessiond.sock`.

**`muxterm serve/local`** — the HTTP server. Serves WebSocket, relays data. Has no persistent state; reconnects to sessiond after restart.

### Existing Binary Protocol (Frozen)

Each frame: `[4-byte BIG-ENDIAN uint32 total_length][1-byte kind][payload]`

- `FrameControl (0x01)` — payload is JSON-encoded `sessiond.Message`
- `FramePaneData (0x02)` — payload is `[4-byte LE uint32 paneID][raw PTY bytes]`
- **`FrameBrowserData (0x03)` ← NEW** — payload is `[4-byte LE uint32 paneID][raw JPEG bytes]`

### Key Files

| File | Role |
|---|---|
| `internal/sessiond/protocol.go` | Frame kinds, Message struct, wire helpers |
| `internal/sessiond/subscriber.go` | Per-connection write queue (bounded, async) |
| `internal/sessiond/server.go` | Daemon: accepts connections, dispatches messages |
| `internal/sessiond/client.go` | HTTP server's connection to the daemon; `Handlers` struct |
| `internal/sessiond/browser_manager.go` | BrowserManager: Chromium lifecycle, OpenPage, ClosePage |
| `internal/sessiond/browser_cdp.go` | CDPConn, BrowserPage, SetViewport, captureScreenshot |
| `internal/sessiond/browser_screencast.go` | startScreencast, runEventLoop |
| `internal/sessiond/browser_input.go` | BrowserPage.HandleInput, maybeSendCursor |
| `internal/server/daemon.go` | DaemonConn interface (server package) |
| `internal/server/ws.go` | Hub, Client, main WebSocket handler |
| `internal/server/ws_browser.go` | /ws/browser WebSocket handler |
| `cmd/muxterm/main.go` | Entry point: runLocal, runServe, runSessiond |

### Verification Command (Run After EVERY Task)

```bash
go build ./...
```

Must produce zero output (zero errors). The frontend check (`cd web && npm run check:fast`) runs only on the final task.

### Commit Footer

Every commit must include this exact co-author footer:

```
Co-Authored-By: Amplifier <amplifier@sourcegraph.com>
```

---

## Task 1: Add `FrameBrowserData` and New Protocol Constants

**Files:**
- Modify: `internal/sessiond/protocol.go`

**Goal:** Extend the wire protocol with the new frame kind, message type constants, and new Message fields needed for browser relay. Purely additive — no existing code changes.

**Step 1: Read the file first**

Read `internal/sessiond/protocol.go` completely before editing. Note:
- The existing frame kind constants block (lines 14–17)
- The existing `TypeBrowser*` constants (lines 62–68)
- The `Message` struct layout (lines 156–202)
- The `writeFrame` helper (lines 89–102) — your new `WriteBrowserData` function reuses this

**Step 2: Add `FrameBrowserData` frame kind**

In the `const` block that defines `FrameControl` and `FramePaneData`, add the new frame kind immediately after `FramePaneData`:

```go
const (
    FrameControl  byte = 0x01 // payload is JSON of the Message envelope
    FramePaneData byte = 0x02 // payload is [4-byte LITTLE-ENDIAN paneId][raw bytes]
    FrameBrowserData byte = 0x03 // payload is [4-byte LITTLE-ENDIAN paneId][raw JPEG bytes]
)
```

**Step 3: Add new browser message type constants**

In the browser CDP pane constants section (after the existing `TypeBrowserError` line), add:

```go
TypeBrowserFocus   = "browser-focus"   // client → sessiond: focus claim + viewport size
TypeBrowserBlur    = "browser-blur"    // client → sessiond: focus release
TypeBrowserGranted = "browser-granted" // sessiond → client: input authority notification
```

Note: `TypeBrowserInput` already exists — do not add it again.

**Step 4: Add new Message fields**

In the `Message` struct, after the existing `TunnelPort int` field, add a new section:

```go
// Browser relay fields (browser-focus, browser-blur, browser-input, browser-granted).
ClientID     string          `json:"clientId,omitempty"`     // stable per /ws/browser connection
DeviceID     string          `json:"deviceId,omitempty"`     // localStorage UUID, stable per physical machine
RenderWidth  int             `json:"renderWidth,omitempty"`  // canvas CSS width in px at focus time
RenderHeight int             `json:"renderHeight,omitempty"` // canvas CSS height in px at focus time
InputEvent   json.RawMessage `json:"inputEvent,omitempty"`   // raw BrowserInputMsg JSON for browser-input
RawPayload   json.RawMessage `json:"rawPayload,omitempty"`   // original JSON bytes for relay passthrough
```

`RawPayload` is used by the relay: when the daemon broadcasts a JSON browser event (browser-url, browser-cursor, etc.), it stores the original JSON bytes here so the HTTP server can forward them as-is to WebSocket clients without re-encoding.

**Step 5: Add `WriteBrowserData` helper**

After the existing `WritePaneData` function, add:

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

**Step 6: Verify**

```bash
go build ./...
```

Expected: zero output.

**Step 7: Commit**

```bash
git add internal/sessiond/protocol.go
git commit -m "feat(protocol): add FrameBrowserData (0x03), TypeBrowserFocus/Blur/Granted, relay Message fields

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 2: Extend Subscriber to Handle `FrameBrowserData`

**Files:**
- Modify: `internal/sessiond/subscriber.go`

**Goal:** The subscriber write queue currently handles two frame kinds (control and pane data). Extend it to handle a third kind (browser JPEG data). The change is isolated to this file.

**Step 1: Read the file first**

Read `internal/sessiond/subscriber.go` completely. Note:
- `outFrame` struct with `isData bool` (line 16–21) — you will replace `isData bool` with `kind byte`
- `writeLoop` switch on `f.isData` (lines 58–63) — update to switch on `f.kind`
- `enqueueControl` (line 75) and `enqueuePaneData` (line 81) — update to use `kind`

**Step 2: Replace `isData bool` with `kind byte` in `outFrame`**

Replace the `outFrame` struct:

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

**Step 3: Update `writeLoop` to switch on `kind`**

Replace the `if f.isData` check in `writeLoop` with:

```go
var err error
switch f.kind {
case FramePaneData:
    err = WritePaneData(s.w, f.paneID, f.data)
case FrameBrowserData:
    err = WriteBrowserData(s.w, f.paneID, f.data)
default: // FrameControl
    err = WriteControl(s.w, f.msg)
}
```

**Step 4: Update `enqueueControl` and `enqueuePaneData` to use `kind`**

Replace:
```go
func (s *subscriber) enqueueControl(msg *Message) {
    s.enqueue(outFrame{msg: msg})
}
```
With:
```go
func (s *subscriber) enqueueControl(msg *Message) {
    s.enqueue(outFrame{kind: FrameControl, msg: msg})
}
```

Replace:
```go
func (s *subscriber) enqueuePaneData(paneID uint32, data []byte) {
    cp := make([]byte, len(data))
    copy(cp, data)
    s.enqueue(outFrame{isData: true, paneID: paneID, data: cp})
}
```
With:
```go
func (s *subscriber) enqueuePaneData(paneID uint32, data []byte) {
    cp := make([]byte, len(data))
    copy(cp, data)
    s.enqueue(outFrame{kind: FramePaneData, paneID: paneID, data: cp})
}
```

**Step 5: Add `enqueueBrowserData`**

After `enqueuePaneData`, add:

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

**Step 6: Verify**

```bash
go build ./...
```

Expected: zero output.

**Step 7: Commit**

```bash
git add internal/sessiond/subscriber.go
git commit -m "feat(sessiond): extend subscriber outFrame to support FrameBrowserData (0x03)

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 3: Add BrowserManager and Broadcast Helpers to sessiond.Server

**Files:**
- Modify: `internal/sessiond/server.go`

**Goal:** The sessiond Server becomes the owner of BrowserManager. Add fields for it plus a `browserPanes` map (paneID → workspaceID). Add two broadcast helpers that fan JPEG frames and JSON events out to all live daemon connections.

**Step 1: Read the file first**

Read `internal/sessiond/server.go` completely. Note:
- `Server` struct (lines 17–24) — you add two fields
- `NewServer` function (lines 28–38) — you initialize the new fields and create BrowserManager
- `broadcastPaneData` (lines 201–207) — your new helpers follow this same pattern but iterate `s.conns` instead of `s.subs[wsID]` (browser frames go to all connections; terminal relay connections have no `OnBrowserFrame` handler and silently drop them)

**Step 2: Add fields to `Server` struct**

Add after the `conns map[*conn]bool` field:

```go
// browserManager owns Chromium and CDPConn. Created in NewServer; never nil.
browserManager *BrowserManager
// browserPanes maps workspace-local paneID → workspaceID for all live browser-cdp
// panes. Protected by mu. Needed so broadcastBrowserData can scope to the right
// workspace subscribers.
browserPanes map[int]string
```

**Step 3: Initialize in `NewServer`**

Replace the existing `return &Server{...}` block in `NewServer` with:

```go
s := &Server{
    reg:          NewRegistry(),
    socket:       socketPath,
    subs:         make(map[string]map[*conn]bool),
    conns:        make(map[*conn]bool),
    browserPanes: make(map[int]string),
}
s.browserManager = NewBrowserManager(
    func(paneID int, jpeg []byte) {
        s.broadcastBrowserData(paneID, jpeg)
    },
    func(msg any) {
        s.broadcastBrowserControlAny(msg)
    },
)
return s, nil
```

**Step 4: Add `broadcastBrowserData`**

After the existing `broadcastPaneData` method, add:

```go
// broadcastBrowserData enqueues a FrameBrowserData frame to every live
// connection. It sends to s.conns (not workspace-scoped subs) because browser
// relay connections (/ws/browser) are not workspace-attached; their OnBrowserFrame
// handler forwards the frame to the WebSocket client. Terminal relay connections
// have OnBrowserFrame == nil and silently drop it. Enqueue never blocks, so
// holding s.mu is safe.
func (s *Server) broadcastBrowserData(paneID int, jpeg []byte) {
    s.mu.Lock()
    defer s.mu.Unlock()
    for c := range s.conns {
        c.sub.enqueueBrowserData(uint32(paneID), jpeg)
    }
}
```

**Step 5: Add `broadcastBrowserControlAny`**

After `broadcastBrowserData`, add:

```go
// broadcastBrowserControlAny marshals msg (a BrowserURLMsg, BrowserProgressMsg,
// BrowserErrorMsg, or map[string]any for browser-granted/browser-cursor) to its
// original JSON bytes, stores those bytes in Message.RawPayload so the HTTP
// server relay can forward them as-is to WebSocket clients, and enqueues the
// result as a FrameControl frame to every live connection.
func (s *Server) broadcastBrowserControlAny(msg any) {
    raw, err := json.Marshal(msg)
    if err != nil {
        log.Printf("sessiond: broadcastBrowserControlAny marshal: %v", err)
        return
    }
    // Extract type and paneId from the raw JSON so we can populate Message fields.
    var envelope struct {
        Type   string `json:"type"`
        PaneID int    `json:"paneId"`
    }
    _ = json.Unmarshal(raw, &envelope)

    m := &Message{
        Type:       envelope.Type,
        PaneID:     envelope.PaneID,
        RawPayload: json.RawMessage(raw),
    }

    s.mu.Lock()
    defer s.mu.Unlock()
    for c := range s.conns {
        c.sub.enqueueControl(m)
    }
}
```

You will need to add `"log"` to the import block if it is not already there.

**Step 6: Verify**

```bash
go build ./...
```

Expected: zero output.

**Step 7: Commit**

```bash
git add internal/sessiond/server.go
git commit -m "feat(sessiond): add BrowserManager ownership + broadcastBrowserData/Control to Server

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 4: Launch Chromium When a Browser Pane Is Created

**Files:**
- Modify: `internal/sessiond/server.go`

**Goal:** Update `createBrowserCDPPane` so the daemon — not the HTTP server — calls `BrowserManager.OpenPage(paneID)` immediately after registering the placeholder pane. Also track the paneID → workspaceID mapping in `browserPanes` for use by `broadcastBrowserData`.

**Step 1: Read `createBrowserCDPPane` in server.go**

Find the `createBrowserCDPPane` method (around line 477). It currently:
1. Allocates a local pane ID
2. Calls `newBrowserCDPPane(localID)` to create a stub pane
3. Registers the pane in the registry
4. Sends `TypePaneCreated` reply and `TypePaneAdded` broadcast

The comment says "The HTTP server layer is responsible for starting the actual Chromium page". After this task, that comment is wrong — remove it.

**Step 2: Update `createBrowserCDPPane`**

After `c.srv.reg.PutPane(wsID, p)` and before `c.reply(...)`, add:

```go
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
```

Also remove (or replace) the stale comment "The HTTP server layer is responsible for starting the actual Chromium page via BrowserManager.OpenPage(paneID) after receiving the pane-added broadcast."

**Step 3: Verify**

```bash
go build ./...
```

Expected: zero output. Note: `main.go` still creates its own BrowserManager (that will be removed in Task 12). Having two BrowserManagers is a temporary state that compiles correctly; the system is not usable mid-refactor.

**Step 4: Commit**

```bash
git add internal/sessiond/server.go
git commit -m "feat(sessiond): launch Chromium in daemon on TypeCreateBrowserPane

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 5: Close Chromium When a Browser Pane Is Closed

**Files:**
- Modify: `internal/sessiond/server.go`

**Goal:** When `TypeCloseBrowserPane` is received by the daemon, close the Chromium page and clean up the `browserPanes` entry. The HTTP server's close handler still calls `c.daemon.ClosePane()` which sends this message to the daemon.

**Step 1: Find the `TypeCloseBrowserPane` handler**

In `server.go`, find:
```go
case TypeCloseBrowserPane:
    c.closePane(msg) // reuse existing closePane: removes pane + broadcasts pane-closed
```

**Step 2: Replace with an extended handler**

Replace those two lines with:

```go
case TypeCloseBrowserPane:
    // Close the Chromium page before removing the pane from the registry.
    c.srv.browserManager.ClosePage(msg.PaneID)
    // Clean up the pane → workspace tracking entry.
    c.srv.mu.Lock()
    delete(c.srv.browserPanes, msg.PaneID)
    c.srv.mu.Unlock()
    // Reuse closePane: removes pane from registry, broadcasts pane-closed.
    c.closePane(msg)
```

**Step 3: Verify**

```bash
go build ./...
```

Expected: zero output.

**Step 4: Commit**

```bash
git add internal/sessiond/server.go
git commit -m "feat(sessiond): close Chromium in daemon on TypeCloseBrowserPane

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 6: Add Focus/Blur/Input Handlers and Authority Tracking

**Files:**
- Modify: `internal/sessiond/browser_manager.go`
- Modify: `internal/sessiond/server.go`

**Goal:** Add last-focus-wins input authority tracking to BrowserManager. Add `SetViewport` to BrowserPage (extracted from OpenPage). Add handlers for `TypeBrowserFocus`, `TypeBrowserBlur`, `TypeBrowserInput` in the daemon's conn dispatch.

**Step 1: Read `browser_manager.go` and `browser_cdp.go` first**

- Read `browser_manager.go` completely — note the `mu sync.Mutex` and `pages map[int]*BrowserPage`
- Grep for `Emulation.setDeviceMetricsOverride` in `browser_manager.go` — the viewport setup currently happens inside `OpenPage`. You will extract it into `BrowserPage.SetViewport`.
- Read the `captureScreenshot` function signature in `browser_screencast.go`: `func (bp *BrowserPage) captureScreenshot(ctx context.Context) ([]byte, error)`

**Step 2: Add authority fields to `BrowserManager`**

In `browser_manager.go`, add an `authority map[int]string` field to `BrowserManager`:

```go
type BrowserManager struct {
    mu            sync.Mutex
    chromiumCmd   *exec.Cmd
    cdp           *CDPConn
    pages         map[int]*BrowserPage
    maxPages      int
    broadcast     func(paneID int, data []byte)
    broadcastJSON func(msg any)
    authority     map[int]string // paneID → clientID of current input authority
}
```

Initialize `authority` in `NewBrowserManager`:

```go
return &BrowserManager{
    pages:         make(map[int]*BrowserPage),
    authority:     make(map[int]string),
    maxPages:      1,
    broadcast:     broadcast,
    broadcastJSON: broadcastJSON,
}
```

**Step 3: Add authority methods to `BrowserManager`**

After `GetPage`, add:

```go
// SetAuthority records clientID as the current input authority for paneID.
// Last-focus-wins: the most recent browser-focus event always wins.
func (bm *BrowserManager) SetAuthority(paneID int, clientID string) {
    bm.mu.Lock()
    defer bm.mu.Unlock()
    bm.authority[paneID] = clientID
}

// ClearAuthority clears the input authority for paneID if the current authority
// matches clientID. Calling with the wrong clientID is a no-op (another client
// has already claimed authority).
func (bm *BrowserManager) ClearAuthority(paneID int, clientID string) {
    bm.mu.Lock()
    defer bm.mu.Unlock()
    if bm.authority[paneID] == clientID {
        delete(bm.authority, paneID)
    }
}

// IsAuthority reports whether clientID holds input authority for paneID.
func (bm *BrowserManager) IsAuthority(paneID int, clientID string) bool {
    bm.mu.Lock()
    defer bm.mu.Unlock()
    return bm.authority[paneID] == clientID
}
```

**Step 4: Add `SetViewport` to `BrowserPage`**

Read `browser_manager.go` lines that call `Emulation.setDeviceMetricsOverride` in `OpenPage`. Extract that CDP call into a new method on `BrowserPage` in `browser_manager.go` (add after `ClosePage`):

```go
// SetViewport updates the Chromium viewport for this page to width × height.
// Called on TypeBrowserFocus to resize Chromium to the focused client's canvas.
func (bp *BrowserPage) SetViewport(ctx context.Context, width, height int) error {
    _, err := bp.cdp.Call(ctx, bp.sessionID, "Emulation.setDeviceMetricsOverride", map[string]any{
        "width":             width,
        "height":            height,
        "deviceScaleFactor": 1,
        "mobile":            false,
    })
    return err
}
```

You will need `"context"` in the import if it is not already there (it is already imported by `OpenPage`).

**Step 5: Add TypeBrowserFocus, TypeBrowserBlur, TypeBrowserInput handlers in server.go**

In `conn.handle(msg Message)` (in `server.go`), add three new cases after `TypeCloseBrowserPane`:

```go
case TypeBrowserFocus:
    bp, ok := c.srv.browserManager.GetPage(msg.PaneID)
    if !ok {
        return
    }
    // Last-focus-wins: this client immediately becomes the input authority.
    c.srv.browserManager.SetAuthority(msg.PaneID, msg.ClientID)
    // Resize Chromium to the focused client's canvas dimensions.
    if msg.RenderWidth > 0 && msg.RenderHeight > 0 {
        ctx := context.Background()
        if err := bp.SetViewport(ctx, msg.RenderWidth, msg.RenderHeight); err != nil {
            log.Printf("sessiond: SetViewport pane %d: %v", msg.PaneID, err)
        }
    }
    // Capture an immediate screenshot so the client gets a frame right away,
    // even if screencasting is paused. Run in a goroutine so a slow CDP call
    // does not block the read loop.
    paneID := msg.PaneID
    go func() {
        ctx := context.Background()
        bp, ok := c.srv.browserManager.GetPage(paneID)
        if !ok {
            return
        }
        if shot, err := bp.captureScreenshot(ctx); err == nil && len(shot) > 0 {
            c.srv.broadcastBrowserData(paneID, shot)
        }
    }()
    // Broadcast browser-granted so all clients know who holds input authority.
    c.srv.broadcastBrowserControlAny(map[string]any{
        "type":     TypeBrowserGranted,
        "paneId":   msg.PaneID,
        "clientId": msg.ClientID,
    })

case TypeBrowserBlur:
    c.srv.browserManager.ClearAuthority(msg.PaneID, msg.ClientID)

case TypeBrowserInput:
    bp, ok := c.srv.browserManager.GetPage(msg.PaneID)
    if !ok {
        return
    }
    // Silently drop input from non-authority clients (last-focus-wins).
    if !c.srv.browserManager.IsAuthority(msg.PaneID, msg.ClientID) {
        return
    }
    var inputMsg BrowserInputMsg
    if err := json.Unmarshal(msg.InputEvent, &inputMsg); err != nil {
        log.Printf("sessiond: TypeBrowserInput unmarshal: %v", err)
        return
    }
    ctx := context.Background()
    if err := bp.HandleInput(ctx, inputMsg); err != nil {
        log.Printf("sessiond: HandleInput pane %d: %v", msg.PaneID, err)
    }
```

You will need `"context"` in the server.go import block (check if it is already imported; it was not in the original file — add it).

**Step 6: Verify**

```bash
go build ./...
```

Expected: zero output.

**Step 7: Commit**

```bash
git add internal/sessiond/browser_manager.go internal/sessiond/server.go
git commit -m "feat(sessiond): add focus/blur/input handlers and last-focus-wins authority tracking

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 7: Add Browser Methods to `sessiond.Client` and Update `Run()`

**Files:**
- Modify: `internal/sessiond/client.go`

**Goal:** The HTTP server's `sessiond.Client` connection needs to (a) send `browser-focus`, `browser-blur`, `browser-input` commands to the daemon, and (b) receive `FrameBrowserData` frames and browser JSON events dispatched from the daemon.

**Step 1: Read the file first**

Read `internal/sessiond/client.go` completely. Note:
- `Handlers` struct (lines 43–87) — you add two new callback fields
- `Run()` (lines 141–156) — you add a new case for `FrameBrowserData`
- `dispatchEvent` (lines 421–474) — you add new cases for browser JSON types
- `Resize` method (lines 378–382) — your new browser methods follow the same fire-and-forget pattern using `WriteControl`
- `Input` method (lines 369–373) — shows the `writeMu` guard pattern for non-blocking sends

**Step 2: Add new callback fields to `Handlers`**

After `OnBrowserActionResult`, add:

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

**Step 3: Update `Run()` to dispatch `FrameBrowserData`**

In `Run()`, the switch on `kind` currently has `FramePaneData` and `FrameControl`. Add a third case:

```go
case FrameBrowserData:
    paneID, data := DecodePaneData(payload) // same [4-byte LE paneId][body] format
    c.dispatchBrowserFrame(paneID, data)
```

**Step 4: Add `dispatchBrowserFrame`**

After `dispatchPaneData`, add:

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

**Step 5: Update `dispatchEvent` to route browser JSON types**

In `dispatchEvent`, after the last `case TypeShellPrompt:` block, add:

```go
case TypeBrowserURL, TypeBrowserDownloadProgress, TypeBrowserError, TypeBrowserGranted:
    if h.OnBrowserMsg != nil {
        h.OnBrowserMsg(msg)
    }
```

**Step 6: Add `BrowserFocus`, `BrowserBlur`, `BrowserInput` methods**

After `BrowserActionResult`, add:

```go
// BrowserFocus sends a browser-focus event to the daemon, claiming input
// authority for paneID and updating the Chromium viewport to renderWidth ×
// renderHeight. It is fire-and-forget: the daemon sends no direct reply (it
// will broadcast browser-granted to all subscribers).
func (c *Client) BrowserFocus(paneID int, clientID, deviceID string, renderWidth, renderHeight int) error {
    c.writeMu.Lock()
    defer c.writeMu.Unlock()
    return WriteControl(c.conn, &Message{
        Type:         TypeBrowserFocus,
        PaneID:       paneID,
        ClientID:     clientID,
        DeviceID:     deviceID,
        RenderWidth:  renderWidth,
        RenderHeight: renderHeight,
    })
}

// BrowserBlur sends a browser-blur event to the daemon, releasing input
// authority for paneID if clientID currently holds it. Fire-and-forget.
func (c *Client) BrowserBlur(paneID int, clientID, deviceID string) error {
    c.writeMu.Lock()
    defer c.writeMu.Unlock()
    return WriteControl(c.conn, &Message{
        Type:     TypeBrowserBlur,
        PaneID:   paneID,
        ClientID: clientID,
        DeviceID: deviceID,
    })
}

// BrowserInput forwards a raw browser-input event JSON payload to the daemon.
// The daemon routes it to BrowserPage.HandleInput only if clientID holds
// input authority. Fire-and-forget.
func (c *Client) BrowserInput(paneID int, clientID string, event json.RawMessage) error {
    c.writeMu.Lock()
    defer c.writeMu.Unlock()
    return WriteControl(c.conn, &Message{
        Type:       TypeBrowserInput,
        PaneID:     paneID,
        ClientID:   clientID,
        InputEvent: event,
    })
}
```

**Step 7: Verify**

```bash
go build ./...
```

Expected: zero output.

**Step 8: Commit**

```bash
git add internal/sessiond/client.go
git commit -m "feat(sessiond/client): add BrowserFocus/Blur/Input methods, OnBrowserFrame/Msg handlers, FrameBrowserData dispatch

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 8: Extend `DaemonConn` Interface and Fix `fakeDaemonConn`

**Files:**
- Modify: `internal/server/daemon.go`
- Modify: `internal/server/daemon_test.go`

**Goal:** The `DaemonConn` interface (the seam the HTTP server uses to talk to the daemon) must expose the new browser methods. The `fakeDaemonConn` test double must implement them or the package will not compile.

**Step 1: Read both files first**

Read `internal/server/daemon.go` completely — note the interface methods list.

Read `internal/server/daemon_test.go` completely — note all the `fakeDaemonConn` methods. The `TestDaemonConnInterfaceSatisfied` test will force a compile error as soon as the interface has methods that `fakeDaemonConn` doesn't implement.

**Step 2: Add new methods to `DaemonConn` interface**

In `daemon.go`, add these three methods to the `DaemonConn` interface (after `BrowserActionResult`):

```go
// BrowserInput forwards a raw browser-input event JSON payload to the daemon.
BrowserInput(paneID int, clientID string, event json.RawMessage) error
// BrowserFocus sends a browser-focus event, claiming input authority and
// updating the Chromium viewport to renderWidth × renderHeight.
BrowserFocus(paneID int, clientID, deviceID string, renderWidth, renderHeight int) error
// BrowserBlur sends a browser-blur event, releasing input authority.
BrowserBlur(paneID int, clientID, deviceID string) error
```

You will need `"encoding/json"` in the import block (it may not be there yet — check).

**Step 3: Add no-op implementations to `fakeDaemonConn` in daemon_test.go**

After the existing `func (f *fakeDaemonConn) BrowserActionResult(...)` line, add:

```go
func (f *fakeDaemonConn) BrowserInput(paneID int, clientID string, event json.RawMessage) error {
    return nil
}

func (f *fakeDaemonConn) BrowserFocus(paneID int, clientID, deviceID string, renderWidth, renderHeight int) error {
    return nil
}

func (f *fakeDaemonConn) BrowserBlur(paneID int, clientID, deviceID string) error {
    return nil
}
```

You will need `"encoding/json"` in daemon_test.go's import block.

**Step 4: Verify**

```bash
go build ./...
```

Expected: zero output. The compile-time assertion `var _ DaemonConn = (*fakeDaemonConn)(nil)` in `daemon_test.go` will confirm the interface is fully satisfied.

**Step 5: Commit**

```bash
git add internal/server/daemon.go internal/server/daemon_test.go
git commit -m "feat(server): extend DaemonConn interface with BrowserInput/Focus/Blur; fix fakeDaemonConn

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 9: Rewrite `ws_browser.go` as a Daemon Socket Relay

**Files:**
- Modify: `internal/server/ws_browser.go`

**Goal:** Replace the current `BrowserManager`-direct handler with a pure relay. Each `/ws/browser` WebSocket connection dials its own daemon connection, registers `OnBrowserFrame` and `OnBrowserMsg` handlers to forward frames to the WebSocket, and reads WebSocket messages to forward to the daemon as `BrowserInput/Focus/Blur`.

**Step 1: Read the current file completely**

Read `internal/server/ws_browser.go`. Note:
- `browserWSConn` struct with `writeBinary`/`writeText` helpers — you keep these (they are still useful)
- `BroadcastBrowserFrame` and `BroadcastBrowserJSON` on Hub — these are still in `ws_browser.go` for now; you will remove them in Task 10 along with the Hub fields they use
- The auth + upgrade pattern in `handleWSBrowserImpl` — keep auth identical; replace everything after the upgrade

**Step 2: Add a connection counter for stable clientIDs**

Add a package-level atomic counter at the top of the file (after the import block):

```go
import (
    "sync/atomic"
    // ... existing imports ...
)

// browserConnCounter generates stable per-connection client IDs. IDs are
// monotonically increasing and unique within one process lifetime.
var browserConnCounter atomic.Uint64
```

**Step 3: Rewrite `handleWSBrowserImpl`**

Replace the entire body of `handleWSBrowserImpl` (after the auth block) with:

```go
conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
    InsecureSkipVerify: true,
})
if err != nil {
    return
}
conn.SetReadLimit(1 << 20) // 1 MB

// Assign a stable client ID for this WebSocket connection. The daemon uses
// this to track input authority (last-focus-wins) across browser-focus events.
clientID := fmt.Sprintf("ws-%d", browserConnCounter.Add(1))

// Dial a dedicated daemon connection for this browser WebSocket.
dc, err := s.hub.Dial()
if err != nil {
    log.Printf("handleWSBrowserImpl: dial daemon: %v", err)
    conn.CloseNow()
    return
}
defer dc.Close()

ctx, cancel := context.WithCancel(context.Background())
defer cancel()

// writeMu serializes writes to conn from the daemon-frame goroutine and the
// read loop goroutine. Production path: only the daemon goroutine writes;
// the read loop only reads. This mu protects the unlikely case of concurrent
// writes during shutdown.
var writeMu sync.Mutex

writeBinary := func(data []byte) {
    writeMu.Lock()
    defer writeMu.Unlock()
    wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
    defer wcancel()
    if err := conn.Write(wctx, websocket.MessageBinary, data); err != nil {
        log.Printf("handleWSBrowserImpl: writeBinary: %v", err)
    }
}
writeText := func(data []byte) {
    writeMu.Lock()
    defer writeMu.Unlock()
    wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
    defer wcancel()
    if err := conn.Write(wctx, websocket.MessageText, data); err != nil {
        log.Printf("handleWSBrowserImpl: writeText: %v", err)
    }
}

// Install relay handlers: JPEG frames → binary WebSocket frames;
// browser JSON events → text WebSocket frames.
dc.SetHandlers(sessiond.Handlers{
    OnBrowserFrame: func(paneID uint32, jpeg []byte) {
        writeBinary(EncodeBinaryFrame(paneID, jpeg))
    },
    OnBrowserMsg: func(msg *sessiond.Message) {
        // Prefer the original JSON (RawPayload) to preserve field names
        // like "cursor" and "url" that don't have Message struct fields.
        if len(msg.RawPayload) > 0 {
            writeText(msg.RawPayload)
            return
        }
        data, err := json.Marshal(msg)
        if err != nil {
            log.Printf("handleWSBrowserImpl: marshal OnBrowserMsg: %v", err)
            return
        }
        writeText(data)
    },
})

// Start daemon read loop in background. When it exits (daemon closed or
// context cancelled), cancel our context so the WebSocket read loop below
// also exits.
go func() {
    if err := dc.Run(); err != nil && !errors.Is(err, net.ErrClosed) {
        log.Printf("handleWSBrowserImpl: daemon run: %v", err)
    }
    cancel()
}()

defer conn.CloseNow()

// Read loop: forward WebSocket input events to the daemon.
for {
    _, data, err := conn.Read(ctx)
    if err != nil {
        return
    }

    var env struct {
        Type         string          `json:"type"`
        PaneID       int             `json:"paneId"`
        Event        json.RawMessage `json:"event"`
        DeviceID     string          `json:"deviceId"`
        RenderWidth  int             `json:"renderWidth"`
        RenderHeight int             `json:"renderHeight"`
    }
    if err := json.Unmarshal(data, &env); err != nil {
        continue
    }

    switch env.Type {
    case sessiond.TypeBrowserFocus:
        if err := dc.BrowserFocus(env.PaneID, clientID, env.DeviceID, env.RenderWidth, env.RenderHeight); err != nil {
            log.Printf("handleWSBrowserImpl: BrowserFocus: %v", err)
        }
    case sessiond.TypeBrowserBlur:
        if err := dc.BrowserBlur(env.PaneID, clientID, env.DeviceID); err != nil {
            log.Printf("handleWSBrowserImpl: BrowserBlur: %v", err)
        }
    case sessiond.TypeBrowserInput:
        if len(env.Event) == 0 {
            continue
        }
        if err := dc.BrowserInput(env.PaneID, clientID, env.Event); err != nil {
            log.Printf("handleWSBrowserImpl: BrowserInput: %v", err)
        }
    }
}
```

**Step 4: Check required imports**

Make sure the import block includes: `"context"`, `"encoding/json"`, `"errors"`, `"fmt"`, `"log"`, `"net"`, `"net/http"`, `"sync"`, `"sync/atomic"`, `"time"`, `"github.com/coder/websocket"`, `"github.com/kenotron-ms/muxterm/internal/sessiond"`.

Remove any imports that are no longer used in this file (e.g., if you removed the old code that used them). Use `go build ./...` to catch unused imports.

**Step 5: Verify**

```bash
go build ./...
```

Expected: zero output. The old `BroadcastBrowserFrame`, `BroadcastBrowserJSON`, `hub.browserClients` code still exists in this file or ws.go — that is fine; it will be removed in Task 10.

**Step 6: Commit**

```bash
git add internal/server/ws_browser.go
git commit -m "feat(server): rewrite /ws/browser handler as daemon socket relay

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 10: Remove Hub Browser Fields and Fix Broken Tests

**Files:**
- Modify: `internal/server/ws.go`
- Modify: `internal/server/ws_browser.go` (remove `BroadcastBrowserFrame`, `BroadcastBrowserJSON`)
- Modify: `internal/server/wiring_test.go`
- Modify: `internal/server/ws_browser_test.go`

**Goal:** Strip all browser state out of Hub. The `browserManager`, `browserClients`, `browserMu`, and `lastBrowserFrames` fields are dead after Task 9. Remove them plus the methods that depend on them. Fix test files that reference the removed APIs.

**Step 1: Read all four files first**

Read them completely. Understand what every symbol you will delete is currently used by, so you don't leave dangling references.

**Step 2: Edit `ws.go` — remove Hub browser fields**

In the `Hub` struct definition, remove these four fields:

```go
browserManager   *sessiond.BrowserManager
browserClients   map[*browserWSConn]bool
browserMu        sync.RWMutex
lastBrowserFrames map[int][]byte
```

**Step 3: Edit `ws.go` — update `NewHub`**

In `NewHub`, remove:

```go
browserClients:    make(map[*browserWSConn]bool),
lastBrowserFrames: make(map[int][]byte),
```

**Step 4: Edit `ws.go` — remove browser-manager methods**

Remove these three methods entirely:
- `SetBrowserManager(bm *sessiond.BrowserManager)` — no longer needed; Hub holds no reference
- `BroadcastBrowserFrame(paneID int, data []byte)` — removed from ws.go (it lives in ws_browser.go; you are about to remove it there too)
- `BroadcastBrowserJSON(msg any)` — same

**Step 5: Edit `ws.go` — update `TypeCreateBrowserPane` handler**

In `handleTextInput`, find the `TypeCreateBrowserPane` case. Remove the block that calls `hub.browserManager.OpenPage`:

```go
// REMOVE THIS BLOCK:
if c.hub.browserManager != nil {
    if _, berr := c.hub.browserManager.OpenPage(paneID); berr != nil {
        log.Printf("handleTextInput: browserManager.OpenPage pane %d: %v", paneID, berr)
    }
}
```

The daemon now handles Chromium launch (Task 4). The case should just call `daemon.CreateBrowserCDPPane` and send `TypePaneCreated`.

**Step 6: Edit `ws.go` — update `TypeCloseBrowserPane` handler**

In the `TypeCloseBrowserPane` case, remove all references to `hub.browserManager` and `hub.lastBrowserFrames`:

```go
// REMOVE:
if c.hub.browserManager != nil {
    c.hub.browserManager.ClosePage(msg.PaneID)
}
c.hub.browserMu.Lock()
delete(c.hub.lastBrowserFrames, msg.PaneID)
c.hub.browserMu.Unlock()
```

Keep only the `c.daemon.ClosePane(msg.PaneID)` call and the `sendMessage(TypeOK)` reply.

**Step 7: Edit `ws_browser.go` — remove `BroadcastBrowserFrame` and `BroadcastBrowserJSON`**

Remove the two methods defined on `*Hub` in `ws_browser.go`:
- `func (h *Hub) BroadcastBrowserFrame(paneID int, data []byte)` (and its body)
- `func (h *Hub) BroadcastBrowserJSON(msg any)` (and its body)

These no longer exist; `main.go` still references them but will be fixed in Task 12. Check `go build ./...` to see if any other files reference them.

Note: if removing them causes the file to have no top-level declarations (just the `browserWSConn` type and `handleWSBrowserImpl`), that is fine.

**Step 8: Edit `wiring_test.go` — remove tests that reference deleted APIs**

Remove these three test functions entirely (the APIs they test no longer exist):
- `TestNewHub_BrowserClientsInitialized` — tests `hub.browserClients` (deleted field)
- `TestSetBrowserManager` — tests `hub.SetBrowserManager` (deleted method)
- `TestConfigBrowserManagerField` — tests `Config.BrowserManager` (deleted field, removed in Task 11)

Also check `TestHandleTextInput_TypeCreateBrowserPane` and `TestHandleTextInput_TypeCloseBrowserPane` — these should still compile and pass because they don't reference deleted fields. Read them and confirm before leaving them untouched.

**Step 9: Edit `ws_browser_test.go` — remove tests that reference deleted APIs**

The current test file tests `BroadcastBrowserFrame` and `hub.lastBrowserFrames`, which are both gone. Remove all four test functions:
- `TestBroadcastBrowserFrameCachesLastFrame`
- `TestBroadcastBrowserFrameUpdatesCache`
- `TestBroadcastBrowserFrameTracksMultiplePanes`
- `TestCloseBrowserPaneClearsFrameCache`

These tests test browser-side frame caching that has moved into the sessiond daemon. After removal, `ws_browser_test.go` will import `sessiond` only for the type reference in `TestCloseBrowserPaneClearsFrameCache` — check if any imports become unused and remove them.

If `ws_browser_test.go` ends up completely empty after removing all four tests, leave only the package declaration line: `package server`.

**Step 10: Verify**

```bash
go build ./...
```

Expected: zero output. Also run the build one more time to be sure:
```bash
go build ./...
```

**Step 11: Commit**

```bash
git add internal/server/ws.go internal/server/ws_browser.go \
        internal/server/wiring_test.go internal/server/ws_browser_test.go
git commit -m "refactor(server): remove Hub browser fields (browserManager/Clients/Frames) — relay is now daemon-driven

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 11: Remove `BrowserManager` from `server.Config`

**Files:**
- Modify: `internal/server/server.go`

**Goal:** The HTTP server's `Config` struct had a `BrowserManager` field (used to inject BrowserManager into Hub at startup). The Hub no longer holds a BrowserManager, so this field is dead.

**Step 1: Read `internal/server/server.go` first**

Read the file completely. Find:
- The `Config` struct definition — locate `BrowserManager *sessiond.BrowserManager` (around line 36)
- The `New(cfg Config)` function — find the block that calls `hub.SetBrowserManager(cfg.BrowserManager)` (around lines 91–93)

**Step 2: Remove the `BrowserManager` field from `Config`**

Delete this field from the `Config` struct:

```go
BrowserManager *sessiond.BrowserManager // optional; nil disables /ws/browser CDP features
```

**Step 3: Remove the `SetBrowserManager` call in `New`**

Find and remove:

```go
if cfg.BrowserManager != nil {
    hub.SetBrowserManager(cfg.BrowserManager)
}
```

**Step 4: Verify**

```bash
go build ./...
```

Expected: zero output. If any other file (e.g., a test) references `Config.BrowserManager`, fix those references now. Check with:

```bash
grep -r "BrowserManager" --include="*.go" .
```

After this task, `BrowserManager` should only appear in:
- `internal/sessiond/browser_manager.go` (the type definition)
- `internal/sessiond/server.go` (the daemon owns it)
- `cmd/muxterm/main.go` (still creates one — will be removed in Task 12)

**Step 5: Commit**

```bash
git add internal/server/server.go
git commit -m "refactor(server): remove Config.BrowserManager — HTTP server holds no browser state

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 12: Remove BrowserManager from `cmd/muxterm/main.go`

**Files:**
- Modify: `cmd/muxterm/main.go`

**Goal:** `runLocal` and `runServe` both create a `sessiond.BrowserManager` and wire it into the Hub. This code is now dead — the daemon owns BrowserManager. Remove it from both functions, and remove the `bm.Close()` cleanup goroutines.

**Step 1: Read `cmd/muxterm/main.go` completely first**

Find all occurrences of `BrowserManager` — there are exactly two: in `runLocal` (around lines 198–214) and in `runServe` (around lines 252–268).

**Step 2: Edit `runLocal` — remove BrowserManager construction**

Remove these lines from `runLocal`:

```go
bm := sessiond.NewBrowserManager(
    func(paneID int, data []byte) { srv.Hub().BroadcastBrowserFrame(paneID, data) },
    func(msg any) { srv.Hub().BroadcastBrowserJSON(msg) },
)
srv.Hub().SetBrowserManager(bm)
```

Also remove the `bm.Close()` call from the signal goroutine:

```go
// REMOVE from the goroutine:
go func() {
    <-ctx.Done()
    bm.Close()   // ← remove this line
}()
```

If that goroutine becomes empty (no other statements), remove the entire goroutine.

**Step 3: Edit `runServe` — remove BrowserManager construction**

Apply the same removal to `runServe` — same pattern, same four blocks.

**Step 4: Clean up unused imports**

After the removals, the `sessiond` package may no longer be needed in `main.go` if nothing else uses it. Check: `sessiond.SocketPath`, `sessiond.DefaultLogPath`, `sessiond.EnsureDaemon`, `sessiond.Dial`, and `sessiond.WriteServerURL` are still called from other functions, so the import stays. Verify with:

```bash
go build ./...
```

**Step 5: Verify once more**

```bash
go build ./...
```

Expected: zero output.

Run the final cross-check to ensure there are no remaining browser-manager references in the HTTP server layer:

```bash
grep -rn "BroadcastBrowserFrame\|BroadcastBrowserJSON\|SetBrowserManager\|hub.browserManager\|hub.browserClients\|hub.lastBrowserFrames" --include="*.go" .
```

Expected: zero matches.

**Step 6: Commit**

```bash
git add cmd/muxterm/main.go
git commit -m "refactor(cmd): remove BrowserManager construction from runLocal/runServe — daemon owns it now

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Task 13: Final Compile + Frontend Check

**Files:** None — verification only.

**Goal:** Confirm the entire codebase compiles cleanly including the frontend TypeScript check. This is the Phase 1 completion gate.

**Step 1: Full Go build**

```bash
go build ./...
```

Expected: zero output, zero errors.

**Step 2: Frontend check**

```bash
cd web && npm run check:fast
```

Expected: zero TypeScript errors, zero lint errors. If errors appear, they are pre-existing (this phase made no TypeScript changes) — do not fix them here.

**Step 3: Confirm architecture is correct**

Verify the key invariant: the HTTP server layer holds NO browser state.

```bash
grep -rn "BrowserManager\|browserManager\|browserClients\|lastBrowserFrames\|BroadcastBrowser" \
    internal/server/ cmd/muxterm/ --include="*.go"
```

The only acceptable matches are:
- Comments (not code)
- `internal/server/daemon.go`: the `BrowserInput/Focus/Blur` method signatures in the interface (these are input methods, not ownership)

**Step 4: Final commit**

```bash
git add -A
git commit -m "refactor: move browser session to sessiond daemon — HTTP server is now a pure relay

Phase 1 complete: Chromium process is a child of sessiond. Browser sessions
survive HTTP server restarts. /ws/browser is a stateless relay over the
daemon socket.

Co-Authored-By: Amplifier <amplifier@sourcegraph.com>"
```

---

## Reference: Architecture After Phase 1

```
sessiond process
  ├── BrowserManager (owns Chromium child process + CDPConn)
  ├── broadcastBrowserData() → FrameBrowserData frames → all daemon conns
  └── broadcastBrowserControlAny() → FrameControl frames → all daemon conns

HTTP server process
  ├── /ws (main terminal relay) — unchanged
  └── /ws/browser (browser relay, NEW)
        ├── dials its own daemon connection
        ├── OnBrowserFrame → writeBinary(EncodeBinaryFrame(paneID, jpeg))
        ├── OnBrowserMsg  → writeText(msg.RawPayload) [original JSON preserved]
        └── read loop → BrowserFocus/Blur/Input → daemon
```

## Reference: Files Changed Summary

| File | Change |
|---|---|
| `internal/sessiond/protocol.go` | +FrameBrowserData, +TypeBrowserFocus/Blur/Granted, +Message fields, +WriteBrowserData |
| `internal/sessiond/subscriber.go` | outFrame.kind replaces isData; +enqueueBrowserData |
| `internal/sessiond/server.go` | +browserManager, +browserPanes, +broadcast helpers, +TypeBrowserFocus/Blur/Input handlers |
| `internal/sessiond/browser_manager.go` | +authority map, +SetAuthority/ClearAuthority/IsAuthority, +SetViewport on BrowserPage |
| `internal/sessiond/client.go` | +OnBrowserFrame/Msg, +BrowserFocus/Blur/Input, +FrameBrowserData dispatch in Run() |
| `internal/server/daemon.go` | +BrowserInput/Focus/Blur to DaemonConn interface |
| `internal/server/daemon_test.go` | +BrowserInput/Focus/Blur no-ops to fakeDaemonConn |
| `internal/server/ws_browser.go` | Rewrite handleWSBrowserImpl as relay; remove BroadcastBrowserFrame/JSON |
| `internal/server/ws.go` | Remove Hub browser fields, SetBrowserManager, BroadcastBrowser*, OpenPage call |
| `internal/server/wiring_test.go` | Remove TestNewHub_BrowserClientsInitialized, TestSetBrowserManager, TestConfigBrowserManagerField |
| `internal/server/ws_browser_test.go` | Remove all four tests (test functionality moved to daemon) |
| `internal/server/server.go` | Remove Config.BrowserManager, SetBrowserManager call in New() |
| `cmd/muxterm/main.go` | Remove NewBrowserManager + SetBrowserManager + bm.Close() from runLocal and runServe |
