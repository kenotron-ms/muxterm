# Multi-Client Resize / Focus-Authority — Phase 1 (Server-Side Go) Implementation Plan

> **For execution:** Use `/build-like-ken` mode.

**Goal:** Give each pane's PTY a single, well-defined authoritative client for sizing, gated by a new `pane-focus` signal and keystroke reclaim, with MCP/agent connections explicitly excluded — and opportunistically shadow-track DECSC/DECRC so reconnect replay re-establishes the saved-cursor register. This plan covers **only** the Go daemon (`internal/sessiond`, `internal/mcp`, `internal/server`). No browser/TypeScript changes are in scope here.

**Architecture:** Each `Pane` gains an `authorityConn *conn` + `authorityAt time.Time` pair guarded by its existing `p.mu`. A new wire field `ClientKind` (`"interactive"` | `"agent"`) rides the existing `attach` message so the daemon can tell human browser connections apart from MCP/automation connections. Two new message types (`pane-focus` client→server, `pane-resized` server→client broadcast) implement explicit focus-driven authority claims; the existing `resize` message is gated by authority instead of applied unconditionally; keystrokes from interactive (non-agent) connections silently reclaim authority without resizing. A small additive DECSC/DECRC shadow tracker in `VTBuffer` fixes a narrower, unrelated reconnect-cursor bug in the same buffer that already serializes replay.

**Tech Stack:** Go (existing `internal/sessiond`, `internal/mcp`, `internal/server` packages), `github.com/charmbracelet/x/vt`, `github.com/charmbracelet/x/ansi`.

**Verification approach:** Static-analysis only (`go build ./...`, plus `go vet ./...` as a zero-cost bonus check). Per this project's testing policy (see `AGENTS.md`), no new unit tests may be added; any existing test whose call signature breaks (e.g. `Client.Attach`'s new third parameter, `serializeGrid`'s new parameter) must be fixed in place, not deleted, not left broken. No behavioral/browser verification is possible in Phase 1 alone since there is no client wired up yet to send `pane-focus` or receive `pane-resized` — that happens in Phase 2.

---

## Before You Start

Read these files once, in full, before touching anything — the tasks below reference exact existing line ranges and it will save you time to have the mental map:

- `internal/sessiond/protocol.go` — the `Message` struct and all `Type*`/`Code*` constants.
- `internal/sessiond/server.go` — `Server`, `conn`, `conn.handle()`, `conn.attach()`, `unsubscribeLocked()`.
- `internal/sessiond/pane.go` — `Pane` struct and its locking pattern (`p.mu`).
- `internal/sessiond/registry.go` — `Registry.PaneIDs()`, `Registry.Pane()`.
- `internal/sessiond/client.go` — `Client`, `Handlers`, `Attach()`, `Resize()`, `dispatchEvent()`.
- `internal/mcp/client.go` — `Client.AttachWorkspace()`.
- `internal/server/ws.go` and `internal/server/daemon.go` — the browser-facing relay and the `DaemonConn` interface.
- `internal/sessiond/vt.go` and `internal/sessiond/tracked.go` — `VTBuffer`, `serializeGrid()`, and the existing `modeTracker`/`onCSI` ANSI-parser-callback pattern (in `tracked.go`) that Task 11 mirrors.

None of this code has unit tests you should write. Existing `*_test.go` files exercise this code today; some of them **will** fail to compile once you change `Client.Attach`'s signature and `serializeGrid`'s signature. Task 8 and Task 11 each call out exactly which test files need a one-line fix at their call sites. Do not delete test files. Do not add new ones.

---

### Task 1: Protocol additions — `ClientKind` field and two new message type constants

**Files:**
- Modify: `internal/sessiond/protocol.go`

**Implementation**

Add `ClientKind` to the `Message` struct. Insert it right after the `Breakpoint` field (both are attach-related):

```go
// In the Message struct, after this existing line:
//     Breakpoint  string          `json:"breakpoint,omitempty"`  // responsive layout key (opaque to daemon)
// add:
	ClientKind  string          `json:"clientKind,omitempty"`  // "interactive" (browser/human) | "agent" (MCP/automation)
```

Add the two new message type constants. `pane-focus` is a request (client→daemon); `pane-resized` is an event (daemon→all subscribers). Add them to the existing const blocks in the same style as the surrounding entries:

```go
// In the "Requests (client -> daemon)" const block, after:
//     TypeResize          = "resize"
// add:
	TypePaneFocus       = "pane-focus"
```

```go
// In the "Events (daemon -> all subscribers, cid=0)" const block, after:
//     TypeShellPrompt         = "shell-prompt"          // OSC 133 prompt/command lifecycle
// add:
	TypePaneResized         = "pane-resized"         // broadcast: canonical PTY size changed
```

No new struct fields are needed for `pane-focus`/`pane-resized` payloads — both reuse the existing `PaneID`, `Cols`, `Rows` fields already on `Message` (the same three fields `TypeResize` already uses).

**Static Analysis**
```
go build ./internal/sessiond/...
```
Expected: no errors.

**Verification**
```
go doc ./internal/sessiond Message | grep -i clientkind
```
Expected output includes a line mentioning `ClientKind`.

**Commit**
```bash
git add internal/sessiond/protocol.go
git commit -m "feat(sessiond): add ClientKind field and pane-focus/pane-resized message types"
```

---

### Task 2: `conn.kind` field + populate from attach

**Files:**
- Modify: `internal/sessiond/server.go`

**Implementation**

Add the `kind` field to the `conn` struct (currently at line 233-238):

```go
// conn is one control connection. attached holds the workspace this connection
// is attached to (""" when not attached); it is touched only by this conn's own
// read goroutine, so it needs no lock.
type conn struct {
	srv      *Server
	nc       net.Conn
	sub      *subscriber
	attached string
	kind     string // "interactive" (browser/human) | "agent" (MCP); set once in attach()
}
```

Update `conn.attach()` (currently lines 398-406) to read and store `msg.ClientKind`, defaulting to `"interactive"` when empty (backward-compat safety net — not an expected runtime path once Tasks 9 and 10 update both real callers):

```go
// attach attaches this connection to the requested workspace, replying with the
// composition snapshot (or an error for an unknown workspace).
func (c *conn) attach(msg Message) {
	if !c.srv.reg.Has(msg.WorkspaceID) {
		c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace")
		return
	}
	c.kind = msg.ClientKind
	if c.kind == "" {
		// Backward-compat safety net: both real call sites (mcp/client.go,
		// server/ws.go) are updated in this same change to always send an
		// explicit ClientKind, so this default is not an expected runtime path.
		c.kind = "interactive"
	}
	c.srv.attachConn(c, msg.WorkspaceID, msg.CID, msg.Breakpoint)
}
```

**Static Analysis**
```
go build ./internal/sessiond/...
```
Expected: no errors.

**Verification**
```
go build ./internal/sessiond/... && echo OK
```
Expected: `OK` (no way to behaviorally verify `conn.kind` without a live client yet — that comes in later tasks/Phase 2).

**Commit**
```bash
git add internal/sessiond/server.go
git commit -m "feat(sessiond): add conn.kind, populate from attach ClientKind"
```

---

### Task 3: Pane authority state + methods

**Files:**
- Modify: `internal/sessiond/pane.go`

**Implementation**

Add imports: `pane.go` already imports `"time"` (used for `startTime time.Time`), so no import change needed.

Add fields to the `Pane` struct (currently lines 20-42), guarded by the existing `p.mu`:

```go
type Pane struct {
	LocalID int
	Title   string // settable; OSC 0/2 title capture is a later phase

	// SurfaceKind is "browser" for browser panes; empty string means "terminal".
	// Set once at construction; immutable thereafter.
	SurfaceKind string

	mu   sync.Mutex // guards cols/rows/authorityConn/authorityAt
	cols int
	rows int

	// authorityConn is the conn currently authoritative for sizing this pane's
	// PTY (see ClaimAuthority/TouchAuthority/IsAuthoritative/ClearAuthorityIfOwner
	// below). nil means unclaimed — the first conn to claim wins.
	authorityConn *conn
	authorityAt   time.Time

	cmd       *exec.Cmd
	ptmx      *os.File
	buf       PaneBuffer
	startTime time.Time

	onData      func(localID int, data []byte)
	onExit      func(localID int, exitCode int, runtimeMilliseconds int64)
	onPromptPtr atomic.Pointer[func(int, *Message)] // written once (createPane), read by readLoop

	closeOnce sync.Once
}
```

Add the four authority methods after `Resize` (currently ends at line 263) and before `Replay`:

```go
// ClaimAuthority makes c the authoritative conn for this pane's PTY sizing if
// authority is unclaimed (nil), stale (now is after the current authority's
// timestamp), or c is already the authoritative conn. Ties go to the incoming
// caller (>=). Returns true if this call changed which conn is authoritative
// (including the nil -> c case), which tells the caller whether other conns
// need a pane-resized broadcast.
func (p *Pane) ClaimAuthority(c *conn, now time.Time) (promoted bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.authorityConn == nil || !now.Before(p.authorityAt) || c == p.authorityConn {
		changed := p.authorityConn != c
		p.authorityConn = c
		p.authorityAt = now
		return changed
	}
	return false
}

// TouchAuthority applies the same most-recent-wins claim logic as
// ClaimAuthority, for callers (keystroke-triggered reclaim) that have no
// cols/rows to apply and so don't act on the promoted return value the same
// way a resize/pane-focus caller would.
func (p *Pane) TouchAuthority(c *conn, now time.Time) {
	p.ClaimAuthority(c, now)
}

// IsAuthoritative reports whether c is the current authoritative conn for this
// pane's PTY sizing.
func (p *Pane) IsAuthoritative(c *conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.authorityConn == c
}

// ClearAuthorityIfOwner clears the authoritative conn if it is currently c.
// Called on disconnect so a dead conn never blocks a future legitimate claim.
func (p *Pane) ClearAuthorityIfOwner(c *conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.authorityConn == c {
		p.authorityConn = nil
	}
}
```

**Static Analysis**
```
go build ./internal/sessiond/...
```
Expected: no errors.

**Verification**
```
go build ./internal/sessiond/... && echo OK
```
Expected: `OK`. (Behavioral verification of the claim/tie logic happens implicitly once Tasks 4-7 wire these methods into `server.go` and the whole daemon builds — there is no isolated way to exercise `Pane` methods without a live conn per this project's no-unit-tests policy.)

**Commit**
```bash
git add internal/sessiond/pane.go
git commit -m "feat(sessiond): add Pane authority state and Claim/Touch/IsAuthoritative/Clear methods"
```

---

### Task 4: Gate `TypeResize` by authority

**Files:**
- Modify: `internal/sessiond/server.go`

**Implementation**

Add `"time"` to the import block (currently `context`, `encoding/json`, `errors`, `net`, `os`, `path/filepath`, `sync`):

```go
import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)
```

Replace the `TypeResize` case in `conn.handle()` (currently lines 307-313):

```go
	case TypeResize:
		if c.attached == "" {
			return
		}
		if p, ok := c.srv.reg.Pane(c.attached, msg.PaneID); ok {
			// ClaimAuthority already promotes on nil authority, so a resize
			// from any conn on a never-focused pane bootstraps that conn as
			// authoritative — the solo-client/initial-creation degenerate
			// case from the design's Error Handling section.
			promoted := p.ClaimAuthority(c, time.Now())
			if p.IsAuthoritative(c) {
				before := p.Info()
				_ = p.Resize(msg.Cols, msg.Rows)
				after := p.Info()
				if promoted || before.Cols != after.Cols || before.Rows != after.Rows {
					c.broadcastPaneResizedExcept(after.Cols, after.Rows, msg.PaneID)
				}
			}
			// Non-authoritative resizes are silently skipped: no error, no
			// disconnect, no pty.Setsize call — matches the design's "Non-
			// authoritative resizes... never call pty.Setsize".
		}
```

Add the small broadcast helper on `conn` (place it near the other `conn` helper methods, e.g. right after `replyError` at the end of the file, before `sizeOrDefault`):

```go
// broadcastPaneResizedExcept sends a TypePaneResized event carrying the new
// canonical cols/rows for paneID to every OTHER conn attached to c's
// workspace (excluding c itself, which already knows its own new size).
func (c *conn) broadcastPaneResizedExcept(cols, rows, paneID int) {
	c.srv.mu.Lock()
	defer c.srv.mu.Unlock()
	for other := range c.srv.subs[c.attached] {
		if other == c {
			continue
		}
		other.sub.enqueueControl(&Message{Type: TypePaneResized, PaneID: paneID, Cols: cols, Rows: rows})
	}
}
```

**Static Analysis**
```
go build ./internal/sessiond/...
```
Expected: no errors.

**Verification**
```
go build ./internal/sessiond/... && echo OK
```
Expected: `OK`.

**Commit**
```bash
git add internal/sessiond/server.go
git commit -m "feat(sessiond): gate TypeResize application by pane authority, broadcast pane-resized"
```

---

### Task 5: `TypePaneFocus` handling

**Files:**
- Modify: `internal/sessiond/server.go`

**Implementation**

Add a new case to `conn.handle()`'s switch, right after the `TypeResize` case you just edited in Task 4:

```go
	case TypePaneFocus:
		// Agents (MCP/automation) never claim focus authority; silently
		// ignore rather than erroring the connection, since a well-behaved
		// agent should never send this but a defensive no-op is safer.
		if c.attached == "" || c.kind != "interactive" {
			return
		}
		if p, ok := c.srv.reg.Pane(c.attached, msg.PaneID); ok {
			// Unlike TypeResize, pane-focus is inherently an authority-
			// claiming action, so apply the resize unconditionally after
			// claiming rather than gating on IsAuthoritative first.
			p.ClaimAuthority(c, time.Now())
			_ = p.Resize(msg.Cols, msg.Rows)
			info := p.Info()
			c.broadcastPaneResizedExcept(info.Cols, info.Rows, msg.PaneID)
		}
```

**Static Analysis**
```
go build ./internal/sessiond/...
```
Expected: no errors.

**Verification**
```
go build ./internal/sessiond/... && echo OK
```
Expected: `OK`.

**Commit**
```bash
git add internal/sessiond/server.go
git commit -m "feat(sessiond): handle pane-focus, claim authority + resize + broadcast"
```

---

### Task 6: Keystroke-triggered authority reclaim

**Files:**
- Modify: `internal/sessiond/server.go`

**Implementation**

Modify the `FramePaneData` case in `conn.serve()` (currently lines 261-268):

```go
		case FramePaneData:
			paneID, data := DecodePaneData(payload)
			if c.attached == "" {
				continue
			}
			if p, ok := c.srv.reg.Pane(c.attached, int(paneID)); ok {
				_, _ = p.Write(data)
				// Only interactive (human) connections' keystrokes reclaim
				// authority — agent (MCP) input must never do so, per the
				// design's MCP-exclusion requirement. No resize, no
				// broadcast: this only updates the authority pointer so a
				// SUBSEQUENT resize/pane-focus from this conn is honored.
				if c.kind == "interactive" {
					p.TouchAuthority(c, time.Now())
				}
			}
```

**Static Analysis**
```
go build ./internal/sessiond/...
```
Expected: no errors.

**Verification**
```
go build ./internal/sessiond/... && echo OK
```
Expected: `OK`.

**Commit**
```bash
git add internal/sessiond/server.go
git commit -m "feat(sessiond): keystroke input from interactive conns reclaims pane authority"
```

---

### Task 7: Clear authority on disconnect

**Files:**
- Modify: `internal/sessiond/server.go`

**Implementation**

Modify `unsubscribeLocked` (currently lines 106-116) to also clear this conn's authority from every pane in the workspace(s) it was subscribed to, using `s.reg.PaneIDs` and `s.reg.Pane` (verified against `internal/sessiond/registry.go`):

```go
// unsubscribeLocked is unsubscribe's body for callers already holding s.mu.
func (s *Server) unsubscribeLocked(c *conn) {
	for wsID, set := range s.subs {
		if set[c] {
			delete(set, c)
			if len(set) == 0 {
				delete(s.subs, wsID)
			}
			// Clear this conn's authority from every pane in the workspace it
			// was subscribed to, so a dead conn never blocks a future
			// legitimate claim (design's "Authoritative client disconnects"
			// error-handling case).
			for _, paneID := range s.reg.PaneIDs(wsID) {
				if p, ok := s.reg.Pane(wsID, paneID); ok {
					p.ClearAuthorityIfOwner(c)
				}
			}
		}
	}
	c.attached = ""
}
```

Note: `s.reg.PaneIDs`/`s.reg.Pane` take `s.mu` only indirectly — they lock `Registry.mu` (a *different* mutex from `Server.mu`), so calling them here while holding `s.mu` (via `unsubscribeLocked`'s caller contract) does not self-deadlock. `Pane.ClearAuthorityIfOwner` takes `p.mu`, also a distinct lock. No lock-ordering cycle is introduced.

**Static Analysis**
```
go build ./internal/sessiond/...
```
Expected: no errors.

**Verification**
```
go build ./internal/sessiond/... && echo OK
```
Expected: `OK`.

**Commit**
```bash
git add internal/sessiond/server.go
git commit -m "feat(sessiond): clear pane authority for a conn's panes on disconnect"
```

---

### Task 8: `sessiond.Client` wire-up — `Attach` third param, `PaneFocus`, `OnPaneResized`

**Files:**
- Modify: `internal/sessiond/client.go`
- Modify (fix broken call sites, no new tests): `internal/sessiond/client_test.go`, `internal/sessiond/mcp_methods_test.go`

**Implementation**

**8a. `Attach` gains a third parameter.** Replace (currently lines 290-307):

```go
// Attach binds this connection to the workspace identified by workspaceID and
// returns its single composition reply. breakpoint is the active CSS breakpoint
// token (e.g. "desktop"); pass "" when unknown. clientKind identifies this
// connection as "interactive" (real browser/human) or "agent" (MCP/automation);
// it is threaded onto the wire as Message.ClientKind so the daemon can exclude
// agent input from pane focus-authority. Always replays the full retained
// buffer — no delta tracking. Empty Panes is valid (an empty workspace), not
// silence. After this reply, per-pane replay bytes arrive as pane-data frames
// (routed to Handlers), followed by live output. An unknown or stale workspace
// id surfaces as a *DaemonError with Code == CodeUnknownWorkspace.
func (c *Client) Attach(workspaceID, breakpoint, clientKind string) (Composition, error) {
	reply, err := c.request(&Message{
		Type:        TypeAttach,
		WorkspaceID: workspaceID,
		Breakpoint:  breakpoint,
		ClientKind:  clientKind,
	})
	if err != nil {
		return Composition{}, err
	}
	return Composition{WorkspaceID: reply.WorkspaceID, Panes: reply.Panes, Layout: reply.Layout}, nil
}
```

**8b. Add `PaneFocus`.** Insert right after the existing `Resize` method (currently ends at line 406):

```go
// PaneFocus tells the daemon that this connection's pane identified by the
// workspace-local paneID has become the visible+OS-focused view, carrying the
// client's current measured size so the daemon can claim focus authority and
// resize the PTY in the same round-trip. It is a connection-scoped control
// message carrying no workspaceId and is fire-and-forget: the daemon sends no
// reply. Only meaningful for interactive (non-agent) connections — the daemon
// silently ignores it from an agent-kind conn.
func (c *Client) PaneFocus(paneID uint32, cols, rows int) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WriteControl(c.conn, &Message{Type: TypePaneFocus, PaneID: int(paneID), Cols: cols, Rows: rows})
}
```

**8c. Add `OnPaneResized` to `Handlers`.** Insert into the `Handlers` struct after the existing `OnShellPrompt` field (currently lines 80-84), following the same doc-comment style:

```go
	// OnPaneResized fires when the daemon broadcasts a TypePaneResized event:
	// the canonical PTY size for paneID changed because some other conn
	// became (or already was) authoritative. Non-authoritative clients use
	// this to resize their local terminal view to match without re-emitting
	// their own resize message.
	OnPaneResized func(paneID uint32, cols, rows int)
```

**8d. Dispatch `TypePaneResized`.** In `dispatchEvent` (currently lines 485-554), add a case mirroring the existing `TypePaneClosed`/`TypePaneRenamed` pattern. Insert it near the other pane-lifecycle cases (e.g. right after the `TypePaneRenamed` case):

```go
	case TypePaneResized:
		if h.OnPaneResized != nil {
			h.OnPaneResized(uint32(msg.PaneID), msg.Cols, msg.Rows)
		}
```

**8e. Update every existing caller of `Client.Attach(...)` in the repo.** Grep confirmed these production and test call sites (docs/plans/*.md matches are historical planning documents, not compiled code — do not touch them):

| File | Line | Change |
|---|---|---|
| `internal/mcp/client.go` | 104 | `c.conn.Attach(workspaceID, "wide")` → `c.conn.Attach(workspaceID, "wide", "agent")` — done in **Task 9**, not here. |
| `internal/mcp/tools_layout.go` | 115 | `lt.c.conn.Attach(ws, "wide")` → `lt.c.conn.Attach(ws, "wide", "agent")` |
| `internal/mcp/run.go` | 101 | `c.conn.Attach(ws, "wide")` → `c.conn.Attach(ws, "wide", "agent")` |
| `internal/server/ws.go` | 176 | `c.daemon.Attach(msg.WorkspaceID, msg.Breakpoint)` → done in **Task 10** (also needs the `DaemonConn` interface updated — see Task 10). |
| `internal/sessiond/mcp_methods_test.go` | 90 | `c.Attach("ws1", "")` → `c.Attach("ws1", "", "interactive")` |
| `internal/sessiond/mcp_methods_test.go` | 150 | `c.Attach(wsID, "")` → `c.Attach(wsID, "", "interactive")` |
| `internal/sessiond/client_test.go` | 218 | `c.Attach("w1", "")` → `c.Attach("w1", "", "interactive")` |
| `internal/sessiond/client_test.go` | 261 | `c.Attach("empty", "")` → `c.Attach("empty", "", "interactive")` |
| `internal/sessiond/client_test.go` | 345 | `c.Attach("nope", "")` → `c.Attach("nope", "", "interactive")` |

Apply the `internal/sessiond/mcp_methods_test.go` and `internal/sessiond/client_test.go` edits now (they're same-package test fixes, not new coverage — just matching the new required signature). Leave `internal/mcp/tools_layout.go`, `internal/mcp/run.go`, and `internal/mcp/client.go` for Task 9, and `internal/server/ws.go` for Task 10, since those also need their surrounding `DaemonConn`/`ClientKind` wiring done together.

Use `edit_file` with `old_string`/`new_string` for each of the five test-file call sites above (each is textually unique within its file per the line numbers given).

**Static Analysis**
```
go build ./internal/sessiond/...
```
Expected: **fails** at this point — `internal/mcp/*.go` and `internal/server/ws.go` still call the old 2-arg `Attach`. This is expected; Tasks 9 and 10 fix the remaining call sites. Confirm the *only* remaining errors are the known `Attach` arity mismatches in `internal/mcp` and `internal/server`, e.g.:
```
go build ./... 2>&1 | grep -v "not enough arguments in call"
```
Expected: no output other than the `internal/mcp`/`internal/server` arity errors (which Tasks 9/10 resolve) — i.e. `internal/sessiond/...` itself builds clean.
```
go build ./internal/sessiond/... && go vet ./internal/sessiond/...
```
Expected: no errors (this confirms the sessiond package itself, including its own fixed tests, compiles).

**Commit**
```bash
git add internal/sessiond/client.go internal/sessiond/client_test.go internal/sessiond/mcp_methods_test.go
git commit -m "feat(sessiond): Attach gains clientKind param, add PaneFocus + OnPaneResized"
```

---

### Task 9: MCP client identifies as agent

**Files:**
- Modify: `internal/mcp/client.go`
- Modify (fix broken call sites): `internal/mcp/tools_layout.go`, `internal/mcp/run.go`

**Implementation**

In `internal/mcp/client.go`, update `Client.AttachWorkspace` (currently line 103-106):

```go
func (c *Client) AttachWorkspace(workspaceID string) error {
	if _, err := c.conn.Attach(workspaceID, "wide", "agent"); err != nil {
		return err
	}
```

In `internal/mcp/tools_layout.go` (line 115), change:
```go
comp, err := lt.c.conn.Attach(ws, "wide")
```
to:
```go
comp, err := lt.c.conn.Attach(ws, "wide", "agent")
```

In `internal/mcp/run.go` (line 101), change:
```go
comp, attachErr := c.conn.Attach(ws, "wide")
```
to:
```go
comp, attachErr := c.conn.Attach(ws, "wide", "agent")
```

Read both files' surrounding context with `read_file` before editing to confirm the exact surrounding whitespace/indentation for `edit_file`'s `old_string` match.

**Static Analysis**
```
go build ./internal/mcp/...
```
Expected: no errors.

**Verification**
```
go build ./internal/mcp/... && echo OK
```
Expected: `OK`.

**Commit**
```bash
git add internal/mcp/client.go internal/mcp/tools_layout.go internal/mcp/run.go
git commit -m "feat(mcp): identify all MCP daemon connections as clientKind=agent"
```

---

### Task 10: Browser-facing server identifies as interactive + relays pane-focus/pane-resized

**Files:**
- Modify: `internal/server/daemon.go`
- Modify: `internal/server/ws.go`
- Modify (fix broken call sites): `internal/server/daemon_test.go`, `internal/server/attach_ordering_test.go`, `internal/server/relay_test.go`

**Implementation**

**10a. Update the `DaemonConn` interface** (`internal/server/daemon.go`) — `Attach` gains the third parameter and a new `PaneFocus` method is required (mirroring `Resize`):

```go
type DaemonConn interface {
	ListWorkspaces() ([]sessiond.WorkspaceInfo, error)
	CreateWorkspace(name string) (string, error)
	RenameWorkspace(workspaceID, name string) error
	CloseWorkspace(workspaceID string) error
	Attach(workspaceID, breakpoint, clientKind string) (sessiond.Composition, error)
	RenamePane(paneID int, name string) error
	SaveLayout(workspaceID, breakpoint, layout string) error
	CreatePane(cmd []string, placement string, referencePaneID int) (int, error)
	// CreateBrowserPane allocates a client-rendered browser pane handle (surfaceKind
	// "browser") in the attached workspace and returns its workspace-local id. No
	// server-side engine is created.
	CreateBrowserPane(placement string, referencePaneID int) (int, error)
	ClosePane(paneID int) error
	Input(paneID uint32, data []byte) error
	Resize(paneID, cols, rows int) error
	// PaneFocus tells the daemon this pane became the visible+OS-focused view
	// in this browser client, carrying its current measured size.
	PaneFocus(paneID uint32, cols, rows int) error
	BrowserActionResult(msg sessiond.Message) error
	// BrowserCommand relays a browser-command to the daemon (broadcast to workspace
	// subscribers). payload is the pre-marshalled command JSON.
	BrowserCommand(paneID int, cid uint64, payload json.RawMessage) error
	// BrowserResult relays a browser-result back to the daemon (broadcast to
	// workspace subscribers, echoing the command cid).
	BrowserResult(paneID int, cid uint64, payload json.RawMessage) error
	// BrowserURL relays a browser-url notification to the daemon (broadcast to
	// workspace subscribers): a client-rendered browser pane committed a
	// navigation to url.
	BrowserURL(paneID int, url string) error
	// BrowserLoad relays a browser-load notification to the daemon (broadcast
	// to workspace subscribers): a client-rendered browser pane finished
	// loading url.
	BrowserLoad(paneID int, url string) error
	SetHandlers(h sessiond.Handlers)
	Run() error
	Close() error
}
```

**10b. Update the attach call site** in `internal/server/ws.go`'s `handleTextInput`, `TypeAttach` case (currently line 176):

```go
			comp, err := c.daemon.Attach(msg.WorkspaceID, msg.Breakpoint, "interactive")
```

**10c. Add a `TypePaneFocus` relay case** to `handleTextInput`'s switch, right after the existing `TypeResize` case (currently lines 248-252), matching that case's fire-and-forget pattern exactly:

```go
	case sessiond.TypePaneFocus:
		// Fire-and-forget: the daemon sends no reply.
		if err := c.daemon.PaneFocus(uint32(msg.PaneID), msg.Cols, msg.Rows); err != nil {
			log.Printf("handleTextInput: pane-focus error: %v", err)
		}
```

**10d. Wire `OnPaneResized`** into `attachClient`'s `sessiond.Handlers{...}` literal (currently lines 464-541), forwarding to the browser exactly as the other daemon-event handlers already do (e.g. mirror `OnPaneRenamed`, currently lines 505-507):

```go
		OnPaneResized: func(paneID uint32, cols, rows int) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneResized, PaneID: int(paneID), Cols: cols, Rows: rows})
		},
```

Insert it in the same struct literal, e.g. right after the existing `OnPaneRenamed` entry.

**10e. Fix broken test call sites.** The `DaemonConn` interface change breaks three test files whose fakes implement `Attach(workspaceID, breakpoint string)`. Fix each in place (do not delete, do not add new test coverage):

- `internal/server/daemon_test.go` line 36 — `fakeDaemonConn.Attach`:
  ```go
  func (f *fakeDaemonConn) Attach(workspaceID, breakpoint, clientKind string) (sessiond.Composition, error) {
  	f.attached = workspaceID
  	return sessiond.Composition{
  		WorkspaceID: workspaceID,
  		Panes:       []sessiond.PaneInfo{{PaneID: 1, Cols: 80, Rows: 24}},
  	}, nil
  }
  ```
  Also add a `PaneFocus` method to `fakeDaemonConn` (the interface now requires it) right after its existing `Resize` method (line 63-66):
  ```go
  func (f *fakeDaemonConn) PaneFocus(paneID uint32, cols, rows int) error {
  	f.resizes = append(f.resizes, [3]int{int(paneID), cols, rows})
  	return nil
  }
  ```
  (Reusing the existing `resizes` recorder field is deliberate — it already exists on the struct and no test currently asserts on it needing to distinguish pane-focus from resize; this keeps the fake minimal per YAGNI. If a Phase 2 test later needs to distinguish them, that's a Phase 2 concern, not this one.)

- `internal/server/attach_ordering_test.go` line 59 — `racyDaemonConn.Attach`:
  ```go
  func (f *racyDaemonConn) Attach(workspaceID, breakpoint, clientKind string) (sessiond.Composition, error) {
  	comp, err := f.fakeDaemonConn.Attach(workspaceID, breakpoint, clientKind)
  	go f.handlers.OnPaneOutput(1, []byte("replay"))
  	time.Sleep(20 * time.Millisecond)
  	return comp, err
  }
  ```

- `internal/server/relay_test.go` line 172 — `errDaemonConn.Attach`:
  ```go
  func (e *errDaemonConn) Attach(workspaceID, breakpoint, clientKind string) (sessiond.Composition, error) {
  	return sessiond.Composition{}, &sessiond.DaemonError{
  		Code:        sessiond.CodeUnknownWorkspace,
  		Err:         "no such workspace",
  		WorkspaceID: "gone",
  	}
  }
  ```

No other test files define their own `Attach` override (`hub_dial_test.go`, `wiring_test.go`, `ws_lifecycle_test.go`, `ws_relay_test.go` all embed `*fakeDaemonConn` and inherit the fixed method), so they need no direct edit — but re-run the full build in the verification step to confirm.

**Static Analysis**
```
go build ./...
```
Expected: no errors, whole repo builds clean now that every `Attach` call site and the `DaemonConn` interface are consistent.
```
go vet ./...
```
Expected: no errors.

**Verification**
```
go build ./... && go vet ./... && echo ALL GREEN
```
Expected: `ALL GREEN`.

**Commit**
```bash
git add internal/server/daemon.go internal/server/ws.go internal/server/daemon_test.go internal/server/attach_ordering_test.go internal/server/relay_test.go
git commit -m "feat(server): browser attach identifies as interactive, relay pane-focus/pane-resized"
```

---

### Task 11: DECSC/DECRC shadow tracker in `VTBuffer`

**Files:**
- Modify: `internal/sessiond/vt.go`

**Implementation**

Add the `github.com/charmbracelet/x/ansi` import (already a go.mod dependency, used elsewhere in this package via `tracked.go`):

```go
import (
	"fmt"
	"strings"
	"sync"

	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)
```

Add fields to `VTBuffer` (currently lines 26-35), guarded by the existing `b.mu`:

```go
type VTBuffer struct {
	// mu serialises all accesses to emu.  Using our own RWMutex (rather than
	// relying solely on SafeEmulator's internal lock) ensures that Replay's
	// multi-step read — IsAltScreen, Scrollback, Render, CursorPosition — is
	// atomic: no Write can slip in between those calls and leave us with a
	// partially-updated snapshot.
	mu    sync.RWMutex
	emu   *vt.SafeEmulator
	total uint64 // total bytes ever written

	// savedCursor shadow-tracks charmbracelet/x/vt's private DECSC/SCOSC
	// saved-cursor register, since x/vt exposes no public accessor for it.
	// It exists solely to inform replay (serializeGrid) — the live emulator
	// handles its own internal DECRC/SCORC restore correctly regardless of
	// this tracker.
	savedCursor      struct{ row, col int }
	savedCursorValid bool
}
```

Add a package-level scratch parser + handler, used only for detecting save-cursor sequences. Place this near the top of the file, after the `VTBuffer` struct and before `NewVTBuffer`:

```go
// scanSavedCursor reports whether p contains a DECSC (ESC 7) or SCOSC (CSI s)
// save-cursor sequence. DECRC (ESC 8) and SCORC (CSI u) are intentionally not
// tracked here — x/vt's own internal restore is correct for the live session;
// this shadow tracker exists solely to inform replay's synthetic preamble
// (see serializeGrid), not to implement save/restore semantics itself.
func scanSavedCursor(p []byte) (found bool) {
	parser := ansi.NewParser()
	parser.SetHandler(ansi.Handler{
		HandleEsc: func(cmd ansi.Cmd) {
			if cmd.Final() == '7' { // DECSC
				found = true
			}
		},
		HandleCsi: func(cmd ansi.Cmd, params ansi.Params) {
			// SCOSC: CSI s, no private prefix, no parameters.
			if cmd.Final() == 's' && cmd.Prefix() == 0 {
				found = true
			}
		},
	})
	parser.Parse(p)
	return found
}
```

Modify `Write` (currently lines 62-72) to scan for save-cursor sequences and record the position, reading it directly from `b.emu.Emulator` (avoiding nested locking, matching the existing comment already in this method):

```go
// Write forwards p directly to the underlying emulator under the write lock,
// which interprets the byte stream and updates the live grid.
func (b *VTBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.total += uint64(len(p))
	// Access the underlying Emulator directly: b.mu already excludes
	// concurrent reads, so the SafeEmulator's own per-method lock is not
	// needed here and calling the raw method avoids nested locking.
	n, err := b.emu.Emulator.Write(p)
	if scanSavedCursor(p) {
		// Read position directly from the underlying Emulator (not via the
		// locking CursorPos() method) — we already hold b.mu, and Write has
		// just applied p, so this reflects state as of the end of this
		// chunk. A save sequence followed by further cursor movement within
		// the SAME chunk is a rare edge case this shadow tracker does not
		// attempt to resolve exactly; per the design, an imperfect or
		// uncaught case is a no-regression, opportunistic-only gap.
		pos := b.emu.Emulator.CursorPosition()
		b.savedCursor.row, b.savedCursor.col = pos.Y, pos.X
		b.savedCursorValid = true
	}
	return n, err
}
```

Modify `Replay` (currently lines 87-93) to pass the saved-cursor info through to `serializeGrid`:

```go
// Replay serializes the current emulator grid into a byte stream that, when fed
// to a fresh emulator, reproduces the visible screen and scrollback history.
func (b *VTBuffer) Replay() []byte {
	b.mu.RLock()
	defer b.mu.RUnlock()
	var saved *struct{ row, col int }
	if b.savedCursorValid {
		saved = &b.savedCursor
	}
	// Pass the underlying *vt.Emulator: we hold b.mu.RLock(), so all state is
	// stable for the duration of the call.
	return serializeGrid(b.emu.Emulator, saved)
}
```

Modify `serializeGrid`'s signature and both branches (currently lines 155-193):

```go
// serializeGrid emits a self-contained byte stream that reconstructs the
// emulator's scrollback history and visible screen.
//
// Alt-screen path: switches into the alt screen, clears, renders, restores
// cursor.  Scrollback is not applicable in alt-screen mode.
//
// Primary-screen path:
//  1. Clear + home.
//  2. Scrollback lines (oldest→newest), each rendered with ANSI styling via
//     uv.Line.Render() and terminated with CRLF.  A reconnecting client feeds
//     these to its own terminal emulator; they scroll into the emulator's
//     scrollback as new visible content arrives.
//  3. Visible grid: emu.Render() with bare LF promoted to CRLF so the fresh
//     emulator doesn't stair-step each row.
//  4. If savedCursor is non-nil, re-establish the client's fresh saved-cursor
//     register (DECSC) at that position so a subsequent DECRC restores
//     correctly — this is the shadow-tracker's whole purpose (x/vt's own
//     saved-cursor register is private and cannot otherwise be replayed).
//  5. Cursor restored to its live position via an absolute CUP sequence.
//
// NOTE: uv.Line.Render() emits fully ANSI-styled output.  If a scrollback line
// carries no SGR attributes (typical for plain-text shells) the output is the
// same as the plain-text form.  Styled scrollback (coloured prompts, vim
// status lines that scrolled away) is preserved with full colour fidelity.
func serializeGrid(emu *vt.Emulator, savedCursor *struct{ row, col int }) []byte {
	var out []byte

	if emu.IsAltScreen() {
		// Reconnecting into alt-screen mode: switch the fresh terminal into
		// alt screen first, then paint the current grid.
		out = append(out, esc+"[?1049h"...)
		out = append(out, esc+"[2J"...)
		out = append(out, esc+"[H"...)
		out = append(out, strings.ReplaceAll(emu.Render(), "\n", "\r\n")...)
		if savedCursor != nil {
			out = append(out, fmt.Sprintf(esc+"[%d;%dH", savedCursor.row+1, savedCursor.col+1)...)
			out = append(out, esc+"7"...)
		}
		pos := emu.CursorPosition()
		out = append(out, fmt.Sprintf(esc+"[%d;%dH", pos.Y+1, pos.X+1)...)
		return out
	}

	// Primary screen: clear, emit scrollback, then the visible grid.
	out = append(out, esc+"[2J"...)
	out = append(out, esc+"[H"...)

	// Emit scrollback lines so reconnecting clients see prior output.
	// uv.Line.Render() produces the ANSI-styled form of each scrollback line.
	// Lines have had trailing blank cells trimmed by the emulator already
	// (Scrollback.Push trims trailing empty cells before storing).
	sb := emu.Scrollback()
	for _, line := range sb.Lines() {
		out = append(out, line.Render()...)
		out = append(out, "\r\n"...)
	}

	// Visible grid: Render() emits the styled screen (ANSI SGR + content),
	// unlike String() which is plain text. Rows are separated by bare LF;
	// promote each to CR+LF so a fresh emulator doesn't stair-step.
	out = append(out, strings.ReplaceAll(emu.Render(), "\n", "\r\n")...)

	if savedCursor != nil {
		out = append(out, fmt.Sprintf(esc+"[%d;%dH", savedCursor.row+1, savedCursor.col+1)...)
		out = append(out, esc+"7"...)
	}

	// Restore the cursor to its live position. uv.Position (image.Point) X/Y
	// are 0-based; terminal CUP rows/cols are 1-based.
	pos := emu.CursorPosition()
	out = append(out, fmt.Sprintf(esc+"[%d;%dH", pos.Y+1, pos.X+1)...)
	return out
}
```

**Static Analysis**
```
go build ./internal/sessiond/...
```
Expected: no errors. (No existing test calls `serializeGrid` directly per the earlier grep of this package's tests — confirm with the command below before moving on.)
```
grep -rn "serializeGrid(" internal/sessiond/*_test.go
```
Expected: no output (no test call sites to fix). If this DOES print a match, read that test file and update its call to pass the new second parameter (`nil` if the test doesn't care about saved-cursor behavior) before proceeding — do not delete the test.

**Verification**
```
go build ./internal/sessiond/... && go vet ./internal/sessiond/... && echo OK
```
Expected: `OK`.

**Commit**
```bash
git add internal/sessiond/vt.go
git commit -m "feat(sessiond): shadow-track DECSC/SCOSC saved-cursor register for replay"
```

---

### Task 12: Main-screen preservation shadow tracker in `VTBuffer`

**Files:**
- Modify: `internal/sessiond/vt.go`

**Implementation**

This extends the exact same shadow-scanning infrastructure Task 11 just added to `VTBuffer.Write()` — same ansi-parser-based scan, same file, same method. Do not add a second parser pass; fold the new detection into the scan Task 11 already wrote.

**12a. Add a `mainScreenSnapshot` field to `VTBuffer`.** Extend the struct Task 11 left in place:

```go
type VTBuffer struct {
	// mu serialises all accesses to emu.  Using our own RWMutex (rather than
	// relying solely on SafeEmulator's internal lock) ensures that Replay's
	// multi-step read — IsAltScreen, Scrollback, Render, CursorPosition — is
	// atomic: no Write can slip in between those calls and leave us with a
	// partially-updated snapshot.
	mu    sync.RWMutex
	emu   *vt.SafeEmulator
	total uint64 // total bytes ever written

	// savedCursor shadow-tracks charmbracelet/x/vt's private DECSC/SCOSC
	// saved-cursor register, since x/vt exposes no public accessor for it.
	// It exists solely to inform replay (serializeGrid) — the live emulator
	// handles its own internal DECRC/SCORC restore correctly regardless of
	// this tracker.
	savedCursor      struct{ row, col int }
	savedCursorValid bool

	// mainScreenSnapshot holds the rendered main-screen (scrollback + visible
	// grid, same form serializeGrid's primary-screen branch already emits)
	// captured at the moment this pane's byte stream was observed entering
	// alt-screen mode. x/vt's public Emulator API exposes no accessor for the
	// inactive/saved screen once alt-screen is active, so this must be
	// captured proactively, in Write, before the switch is applied. Nil until
	// the first alt-screen entry is observed; serializeGrid falls back to
	// today's behavior (no pre-emission) when nil.
	mainScreenSnapshot []byte
}
```

**12b. Extend the scan Task 11 added to also detect alt-screen entry.** Task 11 added `scanSavedCursor(p []byte) (found bool)`. Replace it with a single function that reports both conditions from one parse pass, mirroring the private-mode-1049/1047/47 detection `tracked.go`'s `onCSI` already implements (read that switch statement again — this mirrors it exactly, just recording a bool instead of a tracker field):

```go
// scanWriteEvents reports two independent conditions found in p during a
// single ansi-parser pass:
//
//   - savedCursor: p contains a DECSC (ESC 7) or SCOSC (CSI s) save-cursor
//     sequence. DECRC (ESC 8) and SCORC (CSI u) are intentionally not
//     tracked here — x/vt's own internal restore is correct for the live
//     session; this exists solely to inform replay's synthetic preamble
//     (see serializeGrid), not to implement save/restore semantics itself.
//
//   - enteredAltScreen: p contains a DECSET private-mode set (CSI ?h) for
//     mode 1049, 1047, or 47 — the sequences that enter alternate-screen
//     mode. Matches the same mode set tracked.go's onCSI already treats as
//     alt-screen entry/exit.
func scanWriteEvents(p []byte) (savedCursor, enteredAltScreen bool) {
	parser := ansi.NewParser()
	parser.SetHandler(ansi.Handler{
		HandleEsc: func(cmd ansi.Cmd) {
			if cmd.Final() == '7' { // DECSC
				savedCursor = true
			}
		},
		HandleCsi: func(cmd ansi.Cmd, params ansi.Params) {
			switch cmd.Final() {
			case 's':
				// SCOSC: CSI s, no private prefix, no parameters.
				if cmd.Prefix() == 0 {
					savedCursor = true
				}
			case 'h':
				if cmd.Prefix() != '?' {
					return
				}
				mode, _, _ := params.Param(0, 0)
				switch mode {
				case 1049, 1047, 47:
					enteredAltScreen = true
				}
			}
		},
	})
	parser.Parse(p)
	return savedCursor, enteredAltScreen
}
```

**12c. Add a snapshot-capture helper.** Place this right after `scanWriteEvents`:

```go
// captureMainScreenSnapshot renders the current main screen — scrollback
// lines followed by the visible grid, in exactly the form serializeGrid's
// primary-screen branch already emits them — and stores it as
// mainScreenSnapshot. Callers must hold b.mu and must call this BEFORE
// b.emu.Emulator.Write has processed the alt-screen-entering sequence for the
// current chunk, so Scrollback()/Render() here still reflect main-screen
// state, not the about-to-be-entered alt screen.
func (b *VTBuffer) captureMainScreenSnapshot() {
	var out []byte
	sb := b.emu.Emulator.Scrollback()
	for _, line := range sb.Lines() {
		out = append(out, line.Render()...)
		out = append(out, "\r\n"...)
	}
	out = append(out, strings.ReplaceAll(b.emu.Emulator.Render(), "\n", "\r\n")...)
	b.mainScreenSnapshot = out
}
```

**12d. Modify `Write`** (as Task 11 left it) so the combined scan runs, and the alt-screen check happens, BEFORE `b.emu.Emulator.Write(p)` — this is the critical ordering requirement that lets the check observe the emulator's pre-switch state:

```go
// Write forwards p directly to the underlying emulator under the write lock,
// which interprets the byte stream and updates the live grid.
func (b *VTBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.total += uint64(len(p))
	savedCursor, enteredAltScreen := scanWriteEvents(p)
	// Critical ordering: this check and the resulting snapshot capture MUST
	// happen before b.emu.Emulator.Write below. Emulator.IsAltScreen() here
	// still reflects the PRE-switch state for this chunk, since Write for
	// this chunk hasn't run yet. If the emulator is already in alt-screen
	// (a redundant/nested enter sequence, e.g. nested TUI calls), this is
	// false and we correctly skip re-capturing.
	if enteredAltScreen && !b.emu.Emulator.IsAltScreen() {
		b.captureMainScreenSnapshot()
	}
	// Access the underlying Emulator directly: b.mu already excludes
	// concurrent reads, so the SafeEmulator's own per-method lock is not
	// needed here and calling the raw method avoids nested locking.
	n, err := b.emu.Emulator.Write(p)
	if savedCursor {
		// Read position directly from the underlying Emulator (not via the
		// locking CursorPos() method) — we already hold b.mu, and Write has
		// just applied p, so this reflects state as of the end of this
		// chunk. A save sequence followed by further cursor movement within
		// the SAME chunk is a rare edge case this shadow tracker does not
		// attempt to resolve exactly; per the design, an imperfect or
		// uncaught case is a no-regression, opportunistic-only gap.
		pos := b.emu.Emulator.CursorPosition()
		b.savedCursor.row, b.savedCursor.col = pos.Y, pos.X
		b.savedCursorValid = true
	}
	return n, err
}
```

**12e. Modify `Replay`** to also pass `b.mainScreenSnapshot` through to `serializeGrid`:

```go
// Replay serializes the current emulator grid into a byte stream that, when fed
// to a fresh emulator, reproduces the visible screen and scrollback history.
func (b *VTBuffer) Replay() []byte {
	b.mu.RLock()
	defer b.mu.RUnlock()
	var saved *struct{ row, col int }
	if b.savedCursorValid {
		saved = &b.savedCursor
	}
	// Pass the underlying *vt.Emulator: we hold b.mu.RLock(), so all state is
	// stable for the duration of the call.
	return serializeGrid(b.emu.Emulator, saved, b.mainScreenSnapshot)
}
```

**12f. Modify `serializeGrid`'s signature and alt-screen branch.** Add a third parameter, `mainScreenSnapshot []byte`, alongside the `savedCursor` parameter Task 11 already added, and pre-emit the snapshot (clear + scrollback + saved main-screen render — mirroring the existing primary-screen emission steps in this same function's non-alt branch) before the `?1049h` switch:

```go
// serializeGrid emits a self-contained byte stream that reconstructs the
// emulator's scrollback history and visible screen.
//
// Alt-screen path: if a main-screen snapshot was captured before this pane
// entered alt-screen mode, first emits that snapshot (clear + scrollback +
// saved main-screen render) while the fresh client is still in its default
// main-screen mode, then switches into the alt screen, clears, renders, and
// restores cursor. Falls back to today's behavior (no pre-emission) when no
// snapshot exists — e.g. the pane was created directly into alt-screen mode,
// or the buffer's lifetime never saw an entry event. Scrollback is not
// applicable to the alt-screen content itself.
//
// Primary-screen path:
//  1. Clear + home.
//  2. Scrollback lines (oldest→newest), each rendered with ANSI styling via
//     uv.Line.Render() and terminated with CRLF.  A reconnecting client feeds
//     these to its own terminal emulator; they scroll into the emulator's
//     scrollback as new visible content arrives.
//  3. Visible grid: emu.Render() with bare LF promoted to CRLF so the fresh
//     emulator doesn't stair-step each row.
//  4. If savedCursor is non-nil, re-establish the client's fresh saved-cursor
//     register (DECSC) at that position so a subsequent DECRC restores
//     correctly — this is the shadow-tracker's whole purpose (x/vt's own
//     saved-cursor register is private and cannot otherwise be replayed).
//  5. Cursor restored to its live position via an absolute CUP sequence.
//
// NOTE: uv.Line.Render() emits fully ANSI-styled output.  If a scrollback line
// carries no SGR attributes (typical for plain-text shells) the output is the
// same as the plain-text form.  Styled scrollback (coloured prompts, vim
// status lines that scrolled away) is preserved with full colour fidelity.
func serializeGrid(emu *vt.Emulator, savedCursor *struct{ row, col int }, mainScreenSnapshot []byte) []byte {
	var out []byte

	if emu.IsAltScreen() {
		// If we captured the main screen before this pane entered alt-screen
		// mode, emit it first — while the fresh client is still in its
		// default main-screen mode — so a later live exit from alt-screen
		// (ordinary ?1049l output, unrelated to reconnect) restores the
		// client's own local main-screen buffer to real content instead of a
		// blank/stale one.
		if len(mainScreenSnapshot) > 0 {
			out = append(out, esc+"[2J"...)
			out = append(out, esc+"[H"...)
			out = append(out, mainScreenSnapshot...)
		}
		// Reconnecting into alt-screen mode: switch the fresh terminal into
		// alt screen first, then paint the current grid.
		out = append(out, esc+"[?1049h"...)
		out = append(out, esc+"[2J"...)
		out = append(out, esc+"[H"...)
		out = append(out, strings.ReplaceAll(emu.Render(), "\n", "\r\n")...)
		if savedCursor != nil {
			out = append(out, fmt.Sprintf(esc+"[%d;%dH", savedCursor.row+1, savedCursor.col+1)...)
			out = append(out, esc+"7"...)
		}
		pos := emu.CursorPosition()
		out = append(out, fmt.Sprintf(esc+"[%d;%dH", pos.Y+1, pos.X+1)...)
		return out
	}

	// Primary screen: clear, emit scrollback, then the visible grid.
	out = append(out, esc+"[2J"...)
	out = append(out, esc+"[H"...)

	// Emit scrollback lines so reconnecting clients see prior output.
	// uv.Line.Render() produces the ANSI-styled form of each scrollback line.
	// Lines have had trailing blank cells trimmed by the emulator already
	// (Scrollback.Push trims trailing empty cells before storing).
	sb := emu.Scrollback()
	for _, line := range sb.Lines() {
		out = append(out, line.Render()...)
		out = append(out, "\r\n"...)
	}

	// Visible grid: Render() emits the styled screen (ANSI SGR + content),
	// unlike String() which is plain text. Rows are separated by bare LF;
	// promote each to CR+LF so a fresh emulator doesn't stair-step.
	out = append(out, strings.ReplaceAll(emu.Render(), "\n", "\r\n")...)

	if savedCursor != nil {
		out = append(out, fmt.Sprintf(esc+"[%d;%dH", savedCursor.row+1, savedCursor.col+1)...)
		out = append(out, esc+"7"...)
	}

	// Restore the cursor to its live position. uv.Position (image.Point) X/Y
	// are 0-based; terminal CUP rows/cols are 1-based.
	pos := emu.CursorPosition()
	out = append(out, fmt.Sprintf(esc+"[%d;%dH", pos.Y+1, pos.X+1)...)
	return out
}
```

**Static Analysis**
```
go build ./internal/sessiond/...
```
Expected: no errors.
```
grep -rn "serializeGrid(\|scanSavedCursor(" internal/sessiond/*_test.go
```
Expected: no output (no test call sites reference either the old `scanSavedCursor` name or `serializeGrid` directly). If this DOES print a match, read that test file and update its call to the new three-argument `serializeGrid` signature (or the renamed `scanWriteEvents`) before proceeding — do not delete the test.

**Verification**
```
go build ./internal/sessiond/... && go vet ./internal/sessiond/... && echo OK
```
Expected: `OK`. No further behavioral verification is possible for this task in isolation — no client surface exists yet to exercise a real alt-screen-entry-then-reconnect scenario (that requires a live browser client, which Phase 2 wires up). Real-execution verification of this specific fix (scenario 6, "Alt-screen main-screen preservation", in the design's Verification Strategy) happens in Phase 2's verification tasks. Updating Phase 2's plan to add that scenario is a separate piece of work, not part of this task.

**Commit**
```bash
git add internal/sessiond/vt.go
git commit -m "feat(sessiond): shadow-track main screen before alt-screen entry, preserve on replay"
```

---

### Task 13: Full Phase 1 build check — commit, then hand off to Phase 2

**Files:** none (verification-only task).

**Implementation:** none — this task only verifies and commits.

**Static Analysis**
```bash
cd /Users/ken/workspace/muxterm/.worktrees/fix-multi-client-resize-restore
go build ./...
```
Expected: `(no output)`, exit code 0 — the whole repo (sessiond, mcp, server, cmd/muxterm) compiles clean.

```bash
go vet ./...
```
Expected: `(no output)`, exit code 0. (The repo's `Makefile` defines no separate `lint`/`vet` target beyond `go build` inside `build:` and `go test -v ./...` inside `test:` — `go vet` is run here directly as a zero-cost standard Go check, not because the Makefile requires it.)

```bash
git status --porcelain
```
Expected: clean (nothing to commit) if you committed after each task as instructed; if anything is uncommitted, commit it now.

**Verification**

There is no behavioral verification possible for Phase 1 in isolation — no client (browser or otherwise) yet sends `pane-focus` or has an `OnPaneResized` handler wired to observable UI, since that is Phase 2's job. The full command sequence above (`go build ./...` then `go vet ./...`, both exit 0) is the complete verification bar for this phase, consistent with this project's testing policy of no unit tests and no fabricated verification.

**Commit**
```bash
git add -A
git commit -m "chore: Phase 1 server-side resize/focus-authority complete, build verified" --allow-empty
```

**Then continue to Phase 2:** `docs/plans/2026-07-31-multi-client-resize-focus-authority-phase2-implementation.md`

Phase 2 covers the client-side TypeScript work (sending `pane-focus` on visibility/OS-focus/dockview-active-panel-change and on reconnect, handling `pane-resized` broadcasts, the letterbox/scroll rendering, and the reentrancy guard) plus end-to-end real-browser verification via `make dev-local` and `playwright-cli`/the muxterm-verify skill, per this project's testing policy. Phase 1 alone is not user-visible — do not report this phase as fixing the reported bug to the user; it only lays the server-side groundwork Phase 2 depends on.
