# Phase 3 — serve Relay (off tmux, onto sessiond) Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Repoint `muxterm serve`/`local` from the tmux `-CC` control connection onto a `sessiond` Unix-socket client built on the **frozen v1 wire contract**, delete every tmux control-mode code path, and make `serve` a thin stateless translator between the browser WebSocket and the daemon socket — speaking **one** vocabulary on both hops.

**Architecture:** `serve` becomes a stateless relay. For each browser WebSocket it opens **one** client connection to the long-lived `sessiond` daemon (Phase 1), ensuring the daemon is up via the Phase 2 `SocketPath()`+`EnsureDaemon()` helpers. The browser speaks the **same** `sessiond.Message` types the daemon does (no invented `attach-workspace`/`attached` vocabulary): control flows up as JSON text frames, pane output/input flow as binary frames `[4-byte LE paneId][bytes]`. The daemon owns all terminal state; `serve` holds none, so its restart is a non-event.

**Tech Stack:** Go 1.24, module `github.com/user/muxterm`. Deps already present: `github.com/coder/websocket`, `github.com/creack/pty`. Tests use the stdlib `testing` package only (NO testify), `t.Fatalf`/`t.Errorf`. Build/test: `make test` → `go test ./...`.

**Source of truth (do NOT deviate):** `docs/plans/2026-06-01-session-persistence-design.md` → section **"## Wire Protocol (frozen v1 contract)"** (commit `39e8a70`). Phase 0 (`docs/plans/2026-06-02-session-persistence-phase0-wire-contract-implementation.md`) implements those symbols **exactly**; Phase 1 (`…phase1-sessiond-core-implementation.md`) implements the daemon behavior. This phase **imports** those symbols byte-for-byte and never re-declares or renames them.

---

## How to work this plan

- Do the tasks **in order**. Each task is one TDD micro-cycle: write a failing test, run it (see it fail), write the minimal code, run it (see it pass), commit.
- Run **one** focused test at a time with the exact command given. Run the full suite (`go test ./...`) only where a task says so.
- After **every** task, commit. Every commit body MUST end with this footer (copy it verbatim):

  ```
  🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

  Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
  ```

- Do **not** `git push`, open a PR, or merge. Stop at commits.
- Stay strictly inside Phase 3 scope (see "Out of scope" below).

### The frozen symbols this phase imports (memorize these)

The contract is **frozen** — there is no "assumed symbol" reconciliation and no `contract-notes.md` escape hatch. Use these exact identifiers from package `sessiond`:

| Symbol | Signature / shape |
| --- | --- |
| `FrameControl`, `FramePaneData` | `byte` consts `0x01` / `0x02` |
| `ReadFrame(r io.Reader)` | `(kind byte, payload []byte, err error)` — **3 returns** |
| `WriteControl(w io.Writer, msg *Message)` | `error` — **typed pointer**, not `map[string]any` |
| `WritePaneData(w io.Writer, paneID uint32, data []byte)` | `error` |
| `DecodePaneData(payload []byte)` | `(paneID uint32, data []byte)` — **2 returns, no error** |
| `Message` | `{Type, CID uint64, WorkspaceID, Name, PaneID int, Cols, Rows, Cmd []string, Title, Workspaces []WorkspaceInfo, Panes []PaneInfo, Code, Error}` |
| `WorkspaceInfo` | `{WorkspaceID string, Name string, PaneCount int}` |
| `PaneInfo` | `{PaneID int, Cols int, Rows int, Title string}` |
| Request types | `TypeCreateWorkspace`, `TypeListWorkspaces`, `TypeRenameWorkspace`, `TypeCloseWorkspace`, `TypeAttach`, `TypeCreatePane`, `TypeResize` |
| Reply types | `TypeWorkspaceCreated`, `TypeWorkspaceList`, `TypeComposition`, `TypePaneCreated`, `TypeOK` |
| Event types | `TypePaneAdded`, `TypePaneClosed`, `TypeWorkspaceClosed`, `TypeWorkspaceRenamed` |
| Error | `TypeError`, codes `CodeUnknownWorkspace`, `CodePaneSpawnFailed` |

> **Do NOT use** `WriteData`, `KindControl`/`KindData`, a 4-return `ReadFrame(kind,paneID,payload,err)`, a `message`/`detail` error field, `WorkspaceInfo.ID`, or `cols/rows` on `resize`/`input` carrying a `workspaceId`. Those were the drift this re-baseline kills.

### Contract facts that fix the old deadlock / mismatches

1. **`cid` correlation EXISTS in Phase 1.** The daemon echoes the request's `cid` on its reply; events carry `cid=0`. The client's request/reply matching is valid **as-is** against the frozen daemon. **No Phase 1 edits are needed from Phase 3.**
2. **`attach` no longer deadlocks.** `attach{workspaceId}` gets exactly **one** `composition{cid,workspaceId,panes}` reply (empty `panes` is valid, not silence), **then** per-pane replay data frames, **then** live output. Pre-existing panes come from `composition.panes`; subsequent panes arrive via `pane-added` events.
3. **`create-pane` and `resize` are connection-scoped** to the connection's attached workspace and carry **no** `workspaceId`. `create-pane{cmd?}` uses `cmd []string` (empty ⇒ default `$SHELL`).
4. **Keyboard `input` is NOT a control message.** It is a binary `FramePaneData` frame `[paneId][bytes]`, connection-scoped.
5. **`serve` speaks the SAME vocabulary to the browser.** It relays daemon control messages to the browser as JSON text frames preserving `type` and all fields (including error `code` and `composition`/`workspace-created`/`unknown-workspace`), and bridges pane output/input as binary frames `[4-byte LE paneId][bytes]`. There is no separate browser vocabulary.

### Out of scope (do NOT touch in this phase)

- **Daemon internals** (Registry, Workspace, Pane, RawBuffer, the daemon's own socket server) — Phase 1, merged before this phase runs.
- **The `sessiond` subcommand, auto-spawn/`setsid`, systemd units** — Phase 2, merged. This phase only *calls* `sessiond.SocketPath()`/`sessiond.DefaultLogPath()`/`sessiond.EnsureDaemon()`.
- **Browser-side multiplexer, responsive layout, workspace picker UI** — Phase 4. `serve` keeps serving the existing embedded frontend bytes; this phase establishes the server side of the new wire vocabulary but does NOT rewrite the frontend.
- **Buffer fidelity (TrackedBuffer/VTBuffer)** — Phase 5.
- **Auth/transport** — token auth and the WS upgrade stay exactly as they are.

---

## Pre-flight (Task 0): confirm the frozen contract is present and the tree is green

Phase 0/1 (`internal/sessiond`) and Phase 2 (lifecycle helpers) are merged before this phase. This task **confirms** the exact symbols exist. There is no reconciliation step — if a symbol is missing the dependency phase is not merged; stop and report.

**Step 1: Confirm the frozen protocol + lifecycle symbols exist.**

Run:
```
go doc ./internal/sessiond | grep -E 'func (ReadFrame|WriteControl|WritePaneData|DecodePaneData|NewServer|SocketPath|DefaultLogPath|EnsureDaemon|Dial)\b' ; \
go doc ./internal/sessiond | grep -E 'FrameControl|FramePaneData|Type(Attach|Composition|PaneCreated|WorkspaceList)|Code(Unknown|PaneSpawn)'
```
Expected: `ReadFrame`, `WriteControl`, `WritePaneData`, `DecodePaneData`, `SocketPath`, `DefaultLogPath`, `EnsureDaemon`, and the `Frame*`/`Type*`/`Code*` constants are all listed. (`Dial` does not exist yet — this phase adds it in Task 1.)

**Step 2: Confirm the exact framing signatures match the frozen contract.**

Run:
```
go doc ./internal/sessiond ReadFrame ; go doc ./internal/sessiond WriteControl ; go doc ./internal/sessiond DecodePaneData
```
Expected:
- `func ReadFrame(r io.Reader) (kind byte, payload []byte, err error)`
- `func WriteControl(w io.Writer, msg *Message) error`
- `func DecodePaneData(payload []byte) (paneID uint32, data []byte)`

If any signature differs, **stop** — the frozen contract is not merged. Do not work around it.

**Step 3: Establish a baseline — the suite is green before you start.**

Run:
```
go build ./... && go test ./...
```
Expected: all packages build and tests pass (the tmux-based code is still intact at this point).

No commit in Task 0 (verification only).

---

## Part A — the sessiond client (`internal/sessiond/client.go`)

The client is `serve`'s typed connection to the daemon. It lives in `package sessiond` (so it uses the frozen symbols **unqualified**) and is built and tested **in isolation** against an in-process fake daemon socket that speaks the same framed wire protocol — no browser, no real PTYs.

### Task 1: Client scaffold + Dial against a fake daemon socket

**Files:**
- Create: `internal/sessiond/client.go`
- Create: `internal/sessiond/client_test.go`

**Step 1: Write the failing test.**

Create `internal/sessiond/client_test.go`:

```go
package sessiond

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeDaemon is an in-process Unix-socket server used to drive client tests.
// It accepts exactly one connection and hands it to a per-test handler.
type fakeDaemon struct {
	ln       net.Listener
	sockPath string
}

func newFakeDaemon(t *testing.T, handle func(conn net.Conn)) *fakeDaemon {
	t.Helper()
	dir := t.TempDir()
	sock := filepath.Join(dir, "sessiond.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	fd := &fakeDaemon{ln: ln, sockPath: sock}
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		handle(conn)
	}()
	t.Cleanup(func() {
		ln.Close()
		os.Remove(sock)
	})
	return fd
}

func TestDialConnects(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		time.Sleep(200 * time.Millisecond)
		conn.Close()
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()

	if c == nil {
		t.Fatal("Dial returned nil client")
	}
}
```

**Step 2: Run it to verify it fails.**

Run: `go test ./internal/sessiond/ -run TestDialConnects -v`
Expected: FAIL — compile error `undefined: Dial` (and `(*Client).Close`).

**Step 3: Write the minimal implementation.**

Create `internal/sessiond/client.go`:

```go
package sessiond

import (
	"net"
	"sync"
	"sync/atomic"
)

// Client is serve's connection to the sessiond daemon. One Client wraps exactly
// one Unix-socket connection; serve creates one Client per browser WebSocket, so
// the daemon's per-connection subscription maps 1:1 to a browser. The Client is
// connection-scoped: after Attach, create-pane/resize/input target the attached
// workspace and carry no workspaceId (frozen wire contract).
type Client struct {
	conn net.Conn

	writeMu sync.Mutex // serializes frame writes on conn

	nextCID atomic.Uint64
	pendMu  sync.Mutex
	pend    map[uint64]*pending

	hmu      sync.Mutex
	handlers Handlers

	closeOnce sync.Once
}

// pending is a request awaiting its correlated reply.
type pending struct {
	ch chan *Message // receives the decoded reply Message
}

// Dial opens a connection to the daemon listening on socketPath.
func Dial(socketPath string) (*Client, error) {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, err
	}
	return &Client{conn: conn, pend: make(map[uint64]*pending)}, nil
}

// Close shuts the connection. Closing drops this subscriber on the daemon side;
// the daemon keeps the workspace and its PTYs alive (detach is a non-event).
func (c *Client) Close() error {
	var err error
	c.closeOnce.Do(func() {
		err = c.conn.Close()
	})
	return err
}
```

**Step 4: Run it to verify it passes.**

Run: `go test ./internal/sessiond/ -run TestDialConnects -v`
Expected: PASS.

**Step 5: Commit.**

```
git add internal/sessiond/client.go internal/sessiond/client_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): add serve-side Client scaffold with Dial/Close

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 2: Read loop + cid request/reply correlation (ListWorkspaces)

This adds the heart of the client: a single background read loop that reads frames with the frozen `ReadFrame` (3 returns), routes replies by `cid` to waiting requesters, and dispatches unsolicited frames (events, pane data) to handlers (wired in Task 7). `ListWorkspaces` is the first request/reply built on it.

**Files:**
- Modify: `internal/sessiond/client.go`
- Modify: `internal/sessiond/client_test.go`

**Step 1: Write the failing test.**

Append to `internal/sessiond/client_test.go` (add `"encoding/json"` to its imports):

```go
func TestListWorkspaces(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		// Read the request frame, echo back a workspace-list reply with same cid.
		kind, payload, err := ReadFrame(conn)
		if err != nil || kind != FrameControl {
			t.Errorf("server read: kind=%d err=%v", kind, err)
			return
		}
		var req Message
		mustUnmarshal(t, payload, &req)
		if req.Type != TypeListWorkspaces {
			t.Errorf("type = %q, want %q", req.Type, TypeListWorkspaces)
		}
		reply := &Message{
			Type: TypeWorkspaceList,
			CID:  req.CID, // echo the cid
			Workspaces: []WorkspaceInfo{
				{WorkspaceID: "w1", Name: "dev", PaneCount: 2},
				{WorkspaceID: "w2", Name: "", PaneCount: 0},
			},
		}
		if err := WriteControl(conn, reply); err != nil {
			t.Errorf("server write: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go c.Run()

	got, err := c.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].WorkspaceID != "w1" || got[0].Name != "dev" || got[0].PaneCount != 2 {
		t.Errorf("got[0] = %+v", got[0])
	}
	if got[1].WorkspaceID != "w2" || got[1].Name != "" {
		t.Errorf("got[1] = %+v", got[1])
	}
}

func mustUnmarshal(t *testing.T, data []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, data)
	}
}
```

**Step 2: Run it to verify it fails.**

Run: `go test ./internal/sessiond/ -run TestListWorkspaces -v`
Expected: FAIL — `undefined: (*Client).Run`, `(*Client).ListWorkspaces`.

**Step 3: Write the minimal implementation.**

Add to `internal/sessiond/client.go` (add imports `"encoding/json"`, `"fmt"`):

```go
// Run reads frames until the connection closes. It MUST be started in its own
// goroutine before issuing requests. Returns the terminating read error.
func (c *Client) Run() error {
	for {
		kind, payload, err := ReadFrame(c.conn)
		if err != nil {
			c.failAllPending(err)
			return err
		}
		switch kind {
		case FramePaneData:
			paneID, data := DecodePaneData(payload)
			c.dispatchPaneData(paneID, data) // Task 7
		case FrameControl:
			c.dispatchControl(payload)
		}
	}
}

// dispatchControl routes a control frame: replies (cid != 0) go to the waiting
// requester; everything else (cid == 0) is an unsolicited event (Task 7).
func (c *Client) dispatchControl(payload []byte) {
	var msg Message
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}
	if msg.CID != 0 {
		c.pendMu.Lock()
		p := c.pend[msg.CID]
		delete(c.pend, msg.CID)
		c.pendMu.Unlock()
		if p != nil {
			p.ch <- &msg
		}
		return
	}
	c.dispatchEvent(&msg) // Task 7
}

func (c *Client) failAllPending(err error) {
	c.pendMu.Lock()
	defer c.pendMu.Unlock()
	for cid, p := range c.pend {
		close(p.ch)
		delete(c.pend, cid)
	}
}

// request sends a control message with a fresh non-zero cid and blocks for its
// correlated reply. A daemon `error` reply becomes a *DaemonError.
func (c *Client) request(msg *Message) (*Message, error) {
	cid := c.nextCID.Add(1) // starts at 1; 0 is reserved for events
	msg.CID = cid
	p := &pending{ch: make(chan *Message, 1)}
	c.pendMu.Lock()
	c.pend[cid] = p
	c.pendMu.Unlock()

	c.writeMu.Lock()
	err := WriteControl(c.conn, msg)
	c.writeMu.Unlock()
	if err != nil {
		c.pendMu.Lock()
		delete(c.pend, cid)
		c.pendMu.Unlock()
		return nil, err
	}

	reply, ok := <-p.ch
	if !ok {
		return nil, fmt.Errorf("sessiond: connection closed before reply")
	}
	if reply.Type == TypeError {
		return nil, &DaemonError{Code: reply.Code, Err: reply.Error, WorkspaceID: reply.WorkspaceID}
	}
	return reply, nil
}

// DaemonError carries the daemon's stable error code (e.g. CodeUnknownWorkspace)
// so serve can relay it to the browser with the code preserved.
type DaemonError struct {
	Code        string
	Err         string
	WorkspaceID string
}

func (e *DaemonError) Error() string { return e.Code + ": " + e.Err }

// ListWorkspaces asks the daemon for all live workspaces.
func (c *Client) ListWorkspaces() ([]WorkspaceInfo, error) {
	reply, err := c.request(&Message{Type: TypeListWorkspaces})
	if err != nil {
		return nil, err
	}
	return reply.Workspaces, nil
}
```

Also add the Task-7 stubs so the package compiles (fully implemented in Task 7):

```go
// Handlers receive unsolicited frames. Wired fully in Task 7.
type Handlers struct{}

func (c *Client) dispatchPaneData(paneID uint32, data []byte) {}
func (c *Client) dispatchEvent(msg *Message)                  {}
```

**Step 4: Run it to verify it passes.**

Run: `go test ./internal/sessiond/ -run TestListWorkspaces -v`
Expected: PASS.

**Step 5: Commit.**

```
git add internal/sessiond/client.go internal/sessiond/client_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): add client read loop, cid correlation, ListWorkspaces

Uses the frozen ReadFrame (3-return) and typed WriteControl(*Message).
Replies are matched by the daemon-echoed cid; events (cid=0) dispatch
to handlers.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 3: Workspace control — CreateWorkspace, RenameWorkspace, CloseWorkspace

Three more request/reply calls on the same `request` primitive. `create-workspace` replies `workspace-created{workspaceId}`; `rename-workspace`/`close-workspace` reply `ok`.

**Files:**
- Modify: `internal/sessiond/client.go`
- Modify: `internal/sessiond/client_test.go`

**Step 1: Write the failing test.**

Append to `internal/sessiond/client_test.go`:

```go
func TestCreateRenameCloseWorkspace(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		for {
			kind, payload, err := ReadFrame(conn)
			if err != nil {
				return
			}
			if kind != FrameControl {
				continue
			}
			var req Message
			if json.Unmarshal(payload, &req) != nil {
				continue
			}
			switch req.Type {
			case TypeCreateWorkspace:
				if req.Name != "ops" {
					t.Errorf("create name = %q, want ops", req.Name)
				}
				_ = WriteControl(conn, &Message{Type: TypeWorkspaceCreated, CID: req.CID, WorkspaceID: "w9"})
			case TypeRenameWorkspace:
				if req.WorkspaceID != "w9" || req.Name != "prod" {
					t.Errorf("rename req = %+v", req)
				}
				_ = WriteControl(conn, &Message{Type: TypeOK, CID: req.CID, WorkspaceID: req.WorkspaceID})
			case TypeCloseWorkspace:
				if req.WorkspaceID != "w9" {
					t.Errorf("close req = %+v", req)
				}
				_ = WriteControl(conn, &Message{Type: TypeOK, CID: req.CID})
			}
		}
	})

	c, _ := Dial(fd.sockPath)
	defer c.Close()
	go c.Run()

	id, err := c.CreateWorkspace("ops")
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if id != "w9" {
		t.Fatalf("id = %q, want w9", id)
	}
	if err := c.RenameWorkspace("w9", "prod"); err != nil {
		t.Fatalf("RenameWorkspace: %v", err)
	}
	if err := c.CloseWorkspace("w9"); err != nil {
		t.Fatalf("CloseWorkspace: %v", err)
	}
}
```

**Step 2: Run it to verify it fails.**

Run: `go test ./internal/sessiond/ -run TestCreateRenameCloseWorkspace -v`
Expected: FAIL — undefined methods.

**Step 3: Write the minimal implementation.**

Add to `internal/sessiond/client.go`:

```go
// CreateWorkspace asks the daemon to allocate a new workspace (optional name);
// returns its daemon-assigned id.
func (c *Client) CreateWorkspace(name string) (string, error) {
	reply, err := c.request(&Message{Type: TypeCreateWorkspace, Name: name})
	if err != nil {
		return "", err
	}
	return reply.WorkspaceID, nil
}

// RenameWorkspace sets (or clears, with name=="") a workspace's display label.
func (c *Client) RenameWorkspace(workspaceID, name string) error {
	_, err := c.request(&Message{Type: TypeRenameWorkspace, WorkspaceID: workspaceID, Name: name})
	return err
}

// CloseWorkspace kills all panes in the workspace and removes it.
func (c *Client) CloseWorkspace(workspaceID string) error {
	_, err := c.request(&Message{Type: TypeCloseWorkspace, WorkspaceID: workspaceID})
	return err
}
```

**Step 4: Run it to verify it passes.**

Run: `go test ./internal/sessiond/ -run TestCreateRenameCloseWorkspace -v`
Expected: PASS.

**Step 5: Commit.**

```
git add internal/sessiond/client.go internal/sessiond/client_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): add CreateWorkspace/RenameWorkspace/CloseWorkspace

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 4: Attach — returns the workspace composition (single reply, no deadlock)

`Attach` binds this connection to a workspace and returns its composition (the set of live panes + their sizes) from the **single** `composition` reply. Per-pane replay bytes arrive afterward as ordinary pane-data frames (handled in Task 7), exactly like live output — so `Attach` itself only returns composition (empty `panes` is valid, **not** silence). Attaching to an unknown id returns a `*DaemonError{Code: CodeUnknownWorkspace}`.

**Files:**
- Modify: `internal/sessiond/client.go`
- Modify: `internal/sessiond/client_test.go`

**Step 1: Write the failing test.**

Append to `internal/sessiond/client_test.go` (add `"errors"` to its imports):

```go
func TestAttachReturnsComposition(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		kind, payload, _ := ReadFrame(conn)
		if kind != FrameControl {
			return
		}
		var req Message
		mustUnmarshal(t, payload, &req)
		if req.Type != TypeAttach {
			t.Errorf("type = %q, want %q", req.Type, TypeAttach)
		}
		_ = WriteControl(conn, &Message{
			Type: TypeComposition, CID: req.CID, WorkspaceID: req.WorkspaceID,
			Panes: []PaneInfo{
				{PaneID: 1, Cols: 80, Rows: 24, Title: "shell"},
				{PaneID: 2, Cols: 80, Rows: 24},
			},
		})
		time.Sleep(50 * time.Millisecond)
	})

	c, _ := Dial(fd.sockPath)
	defer c.Close()
	go c.Run()

	comp, err := c.Attach("w1")
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if comp.WorkspaceID != "w1" || len(comp.Panes) != 2 {
		t.Fatalf("comp = %+v", comp)
	}
	if comp.Panes[0].PaneID != 1 || comp.Panes[0].Cols != 80 || comp.Panes[0].Title != "shell" {
		t.Errorf("pane0 = %+v", comp.Panes[0])
	}
}

func TestAttachEmptyCompositionIsValid(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		kind, payload, _ := ReadFrame(conn)
		if kind != FrameControl {
			return
		}
		var req Message
		mustUnmarshal(t, payload, &req)
		// Empty panes is a valid composition, not silence.
		_ = WriteControl(conn, &Message{Type: TypeComposition, CID: req.CID, WorkspaceID: req.WorkspaceID})
		time.Sleep(50 * time.Millisecond)
	})

	c, _ := Dial(fd.sockPath)
	defer c.Close()
	go c.Run()

	comp, err := c.Attach("empty")
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if comp.WorkspaceID != "empty" || len(comp.Panes) != 0 {
		t.Fatalf("comp = %+v, want empty composition", comp)
	}
}

func TestAttachUnknownWorkspace(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		kind, payload, _ := ReadFrame(conn)
		if kind != FrameControl {
			return
		}
		var req Message
		mustUnmarshal(t, payload, &req)
		_ = WriteControl(conn, &Message{
			Type: TypeError, CID: req.CID,
			Code: CodeUnknownWorkspace, Error: "no such workspace", WorkspaceID: req.WorkspaceID,
		})
		time.Sleep(50 * time.Millisecond)
	})

	c, _ := Dial(fd.sockPath)
	defer c.Close()
	go c.Run()

	_, err := c.Attach("missing")
	var de *DaemonError
	if !errors.As(err, &de) || de.Code != CodeUnknownWorkspace {
		t.Fatalf("err = %v, want unknown-workspace DaemonError", err)
	}
}
```

**Step 2: Run it to verify it fails.**

Run: `go test ./internal/sessiond/ -run 'TestAttach' -v`
Expected: FAIL — undefined `Attach`, `Composition`.

**Step 3: Write the minimal implementation.**

Add to `internal/sessiond/client.go`:

```go
// Composition is the device-independent set of panes in a workspace, returned
// by Attach. Panes use the frozen PaneInfo shape.
type Composition struct {
	WorkspaceID string
	Panes       []PaneInfo
}

// Attach binds this connection to a workspace and returns its composition from
// the single `composition` reply. Per-pane replay bytes arrive afterward as
// pane-data frames (see Handlers), THEN live output. An unknown/stale id
// returns a *DaemonError{Code: CodeUnknownWorkspace}.
func (c *Client) Attach(workspaceID string) (Composition, error) {
	reply, err := c.request(&Message{Type: TypeAttach, WorkspaceID: workspaceID})
	if err != nil {
		return Composition{}, err
	}
	return Composition{WorkspaceID: reply.WorkspaceID, Panes: reply.Panes}, nil
}
```

**Step 4: Run it to verify it passes.**

Run: `go test ./internal/sessiond/ -run 'TestAttach' -v`
Expected: PASS (all three).

**Step 5: Commit.**

```
git add internal/sessiond/client.go internal/sessiond/client_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): add Attach returning the single composition reply

Resolves the old deadlock: attach gets exactly one composition reply
(empty panes is valid), with replay frames arriving afterward. Unknown
workspace surfaces as *DaemonError{Code: unknown-workspace}.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 5: CreatePane — connection-scoped, cmd []string, returns the assigned paneId

`CreatePane` forks a PTY in the **currently attached** workspace and returns the daemon-assigned `paneId` from the `pane-created` reply. It is connection-scoped: it carries **no** `workspaceId`. `cmd` is `[]string` (empty ⇒ default `$SHELL`). Per the design, the browser spawns its xterm.js on the `pane-added` broadcast (Task 7/9), not on this ACK.

**Files:**
- Modify: `internal/sessiond/client.go`
- Modify: `internal/sessiond/client_test.go`

**Step 1: Write the failing test.**

Append to `internal/sessiond/client_test.go`:

```go
func TestCreatePaneReturnsID(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		kind, payload, _ := ReadFrame(conn)
		if kind != FrameControl {
			return
		}
		var req Message
		mustUnmarshal(t, payload, &req)
		if req.Type != TypeCreatePane {
			t.Errorf("type = %q, want %q", req.Type, TypeCreatePane)
		}
		if req.WorkspaceID != "" {
			t.Errorf("create-pane carried workspaceId %q; must be connection-scoped", req.WorkspaceID)
		}
		if len(req.Cmd) != 1 || req.Cmd[0] != "bash" {
			t.Errorf("cmd = %v, want [bash]", req.Cmd)
		}
		_ = WriteControl(conn, &Message{Type: TypePaneCreated, CID: req.CID, PaneID: 7})
		time.Sleep(50 * time.Millisecond)
	})

	c, _ := Dial(fd.sockPath)
	defer c.Close()
	go c.Run()

	id, err := c.CreatePane([]string{"bash"})
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}
	if id != 7 {
		t.Fatalf("paneId = %d, want 7", id)
	}
}
```

**Step 2: Run it to verify it fails.**

Run: `go test ./internal/sessiond/ -run TestCreatePaneReturnsID -v`
Expected: FAIL — undefined `CreatePane`.

**Step 3: Write the minimal implementation.**

Add to `internal/sessiond/client.go`:

```go
// CreatePane forks a PTY in the connection's currently-attached workspace and
// returns the daemon-assigned workspace-local paneId. Connection-scoped: it
// carries no workspaceId. cmd is argv; empty means the daemon's default $SHELL.
// The browser spawns its xterm.js on the resulting pane-added broadcast, NOT on
// this ACK (see Handlers).
func (c *Client) CreatePane(cmd []string) (int, error) {
	reply, err := c.request(&Message{Type: TypeCreatePane, Cmd: cmd})
	if err != nil {
		return 0, err
	}
	return reply.PaneID, nil
}
```

**Step 4: Run it to verify it passes.**

Run: `go test ./internal/sessiond/ -run TestCreatePaneReturnsID -v`
Expected: PASS.

**Step 5: Commit.**

```
git add internal/sessiond/client.go internal/sessiond/client_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): add connection-scoped CreatePane(cmd) returning paneId

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 6: Input (binary pane frame) + Resize (control, connection-scoped)

`Input` carries keystrokes as a binary `FramePaneData` frame (matching live output framing). `Resize` is a control message scoped to the attached workspace — `paneId, cols, rows` only, **no** `workspaceId`, and **no** reply.

**Files:**
- Modify: `internal/sessiond/client.go`
- Modify: `internal/sessiond/client_test.go`

**Step 1: Write the failing test.**

Append to `internal/sessiond/client_test.go`:

```go
func TestInputAndResize(t *testing.T) {
	type inFrame struct {
		pane uint32
		data string
	}
	gotInput := make(chan inFrame, 1)
	gotResize := make(chan Message, 1)

	fd := newFakeDaemon(t, func(conn net.Conn) {
		for {
			kind, payload, err := ReadFrame(conn)
			if err != nil {
				return
			}
			switch kind {
			case FramePaneData:
				paneID, data := DecodePaneData(payload)
				gotInput <- inFrame{paneID, string(data)}
			case FrameControl:
				var req Message
				_ = json.Unmarshal(payload, &req)
				if req.Type == TypeResize {
					gotResize <- req
				}
			}
		}
	})

	c, _ := Dial(fd.sockPath)
	defer c.Close()
	go c.Run()

	if err := c.Input(3, []byte("ls\r")); err != nil {
		t.Fatalf("Input: %v", err)
	}
	if err := c.Resize(3, 120, 30); err != nil {
		t.Fatalf("Resize: %v", err)
	}

	select {
	case in := <-gotInput:
		if in.pane != 3 || in.data != "ls\r" {
			t.Errorf("input = %+v", in)
		}
	case <-time.After(time.Second):
		t.Fatal("no input frame received")
	}
	select {
	case rz := <-gotResize:
		if rz.PaneID != 3 || rz.Cols != 120 || rz.Rows != 30 {
			t.Errorf("resize = %+v", rz)
		}
		if rz.WorkspaceID != "" {
			t.Errorf("resize carried workspaceId %q; must be connection-scoped", rz.WorkspaceID)
		}
	case <-time.After(time.Second):
		t.Fatal("no resize frame received")
	}
}
```

**Step 2: Run it to verify it fails.**

Run: `go test ./internal/sessiond/ -run TestInputAndResize -v`
Expected: FAIL — undefined `Input`, `Resize`.

**Step 3: Write the minimal implementation.**

Add to `internal/sessiond/client.go`:

```go
// Input forwards keystrokes to a pane's PTY as a binary FramePaneData frame.
// Connection-scoped to the attached workspace; paneID is workspace-local.
func (c *Client) Input(paneID uint32, data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WritePaneData(c.conn, paneID, data)
}

// Resize tells the daemon a pane's rendered grid is now cols x rows. Control
// frame, connection-scoped (no workspaceId), fire-and-forget (no reply).
func (c *Client) Resize(paneID, cols, rows int) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WriteControl(c.conn, &Message{Type: TypeResize, PaneID: paneID, Cols: cols, Rows: rows})
}
```

**Step 4: Run it to verify it passes.**

Run: `go test ./internal/sessiond/ -run TestInputAndResize -v`
Expected: PASS.

**Step 5: Commit.**

```
git add internal/sessiond/client.go internal/sessiond/client_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): add Input (binary pane frame) and connection-scoped Resize

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 7: Handlers — dispatch pane output + lifecycle events

Wire the unsolicited frames (`dispatchPaneData`/`dispatchEvent` stubbed in Task 2) to caller-supplied `Handlers`. The hub sets handlers that relay daemon frames to the browser. Events use the frozen types; pane-added carries the full `PaneInfo`.

**Files:**
- Modify: `internal/sessiond/client.go`
- Modify: `internal/sessiond/client_test.go`

**Step 1: Write the failing test.**

Append to `internal/sessiond/client_test.go` (add `"strconv"` and `"sync"` to its imports):

```go
func TestHandlersReceiveOutputAndEvents(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		_ = WritePaneData(conn, 5, []byte("hello"))
		_ = WriteControl(conn, &Message{Type: TypePaneAdded, PaneID: 6, Cols: 80, Rows: 24, Title: "vim"})
		_ = WriteControl(conn, &Message{Type: TypePaneClosed, PaneID: 5})
		_ = WriteControl(conn, &Message{Type: TypeWorkspaceRenamed, WorkspaceID: "w1", Name: "ops"})
		_ = WriteControl(conn, &Message{Type: TypeWorkspaceClosed, WorkspaceID: "w1"})
		time.Sleep(100 * time.Millisecond)
	})

	c, _ := Dial(fd.sockPath)
	defer c.Close()

	var mu sync.Mutex
	var log []string
	c.SetHandlers(Handlers{
		OnPaneOutput:       func(p uint32, d []byte) { mu.Lock(); log = append(log, "out:"+itoa(int(p))+":"+string(d)); mu.Unlock() },
		OnPaneAdded:        func(p PaneInfo) { mu.Lock(); log = append(log, "added:"+itoa(p.PaneID)+":"+p.Title); mu.Unlock() },
		OnPaneClosed:       func(p int) { mu.Lock(); log = append(log, "closed:"+itoa(p)); mu.Unlock() },
		OnWorkspaceRenamed: func(id, name string) { mu.Lock(); log = append(log, "renamed:"+id+":"+name); mu.Unlock() },
		OnWorkspaceClosed:  func(id string) { mu.Lock(); log = append(log, "wsclosed:"+id); mu.Unlock() },
	})
	go c.Run()

	want := []string{"out:5:hello", "added:6:vim", "closed:5", "renamed:w1:ops", "wsclosed:w1"}
	deadline := time.After(2 * time.Second)
	for {
		mu.Lock()
		n := len(log)
		mu.Unlock()
		if n >= len(want) {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("only got %d events: %v", n, log)
		case <-time.After(10 * time.Millisecond):
		}
	}
	mu.Lock()
	defer mu.Unlock()
	for i := range want {
		if log[i] != want[i] {
			t.Errorf("log[%d] = %q, want %q", i, log[i], want[i])
		}
	}
}

func itoa(n int) string { return strconv.Itoa(n) }
```

**Step 2: Run it to verify it fails.**

Run: `go test ./internal/sessiond/ -run TestHandlersReceiveOutputAndEvents -v`
Expected: FAIL — `Handlers` has no fields / `SetHandlers` undefined.

**Step 3: Write the minimal implementation.**

Replace the Task-2 stub `Handlers`/`dispatchPaneData`/`dispatchEvent` in `internal/sessiond/client.go` with:

```go
// Handlers receive unsolicited frames from the daemon. All callbacks run on the
// client's single read-loop goroutine, so they must not block for long.
type Handlers struct {
	OnPaneOutput       func(paneID uint32, data []byte)
	OnPaneAdded        func(pane PaneInfo)
	OnPaneClosed       func(paneID int)
	OnWorkspaceClosed  func(workspaceID string)
	OnWorkspaceRenamed func(workspaceID, name string)
}

// SetHandlers installs handlers. Call before Run.
func (c *Client) SetHandlers(h Handlers) {
	c.hmu.Lock()
	c.handlers = h
	c.hmu.Unlock()
}

func (c *Client) dispatchPaneData(paneID uint32, data []byte) {
	c.hmu.Lock()
	h := c.handlers.OnPaneOutput
	c.hmu.Unlock()
	if h != nil {
		h(paneID, data)
	}
}

func (c *Client) dispatchEvent(msg *Message) {
	c.hmu.Lock()
	h := c.handlers
	c.hmu.Unlock()
	switch msg.Type {
	case TypePaneAdded:
		if h.OnPaneAdded != nil {
			h.OnPaneAdded(PaneInfo{PaneID: msg.PaneID, Cols: msg.Cols, Rows: msg.Rows, Title: msg.Title})
		}
	case TypePaneClosed:
		if h.OnPaneClosed != nil {
			h.OnPaneClosed(msg.PaneID)
		}
	case TypeWorkspaceClosed:
		if h.OnWorkspaceClosed != nil {
			h.OnWorkspaceClosed(msg.WorkspaceID)
		}
	case TypeWorkspaceRenamed:
		if h.OnWorkspaceRenamed != nil {
			h.OnWorkspaceRenamed(msg.WorkspaceID, msg.Name)
		}
	}
}
```

**Step 4: Run it to verify it passes.**

Run: `go test ./internal/sessiond/ -run TestHandlersReceiveOutputAndEvents -v`
Then run the whole package: `go test ./internal/sessiond/ -race -v`
Expected: PASS (all client + Phase 0/1 tests green under `-race`).

**Step 5: Quality gate + commit.**

Run: `gofmt -l internal/sessiond/ && go vet ./internal/sessiond/`
Expected: no output from `gofmt -l`, no vet errors.

```
git add internal/sessiond/client.go internal/sessiond/client_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): dispatch pane output + lifecycle events to Handlers

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

The sessiond client is complete. Part B repoints the web server onto it.

---

## Part B — repoint the web server (`internal/server`)

Part B replaces the `TmuxEngine`-based hub with a per-browser `sessiond.Client`. The browser↔serve binary framing (`EncodeBinaryFrame`/`DecodeBinaryFrame`, `[4-byte LE paneID][data]`) is preserved. The JSON control vocabulary changes from tmux-shaped single-key objects (`full-sync`, `select-window`, …) to the **frozen `sessiond.Message`** vocabulary — the **same** types the daemon uses. `serve` does NOT invent a browser dialect.

### Browser↔serve wire vocabulary (Phase 3 = the frozen vocabulary)

- **Control, both directions:** a JSON-marshalled `sessiond.Message` in a WebSocket **text** frame. The browser sends `{"type":"attach","cid":N,"workspaceId":"w1"}`, `{"type":"list-workspaces","cid":N}`, `{"type":"create-workspace","cid":N,"name":"…"}`, `{"type":"rename-workspace",…}`, `{"type":"close-workspace",…}`, `{"type":"create-pane","cid":N,"cmd":[…]}`, `{"type":"resize","paneId":P,"cols":C,"rows":R}`. The browser sets `cid`; serve **echoes** that cid on the reply it sends back.
- **Replies/events, down:** serve sends frozen `sessiond.Message`s preserving `type` and all fields — `composition`, `workspace-list`, `workspace-created`, `pane-created`, `ok`, `pane-added`, `pane-closed`, `workspace-closed`, `workspace-renamed`, and `error{code,error,workspaceId?}`.
- **Pane output (down) and key input (up):** binary frames `[4-byte LE paneId][bytes]` — unchanged.
- **`config`:** serve-local (not a sessiond message). Sent once on connect as `{"type":"config","config":<cfg>}`.

> The cid lives in **two independent domains**: browser↔serve (browser owns it, serve echoes it) and serve↔daemon (the `Client` owns it internally). They never cross. `serve` holds no terminal state — only transient in-flight requests inside the `Client` — so it remains a stateless translator per the design.

---

### Task 8: Introduce the exported `DaemonConn` seam

Replace the hub's single `TmuxEngine` with a per-browser daemon connection behind a small **exported** interface (so `cmd/muxterm` can name it) that tests can fake. `*sessiond.Client` satisfies it.

**Files:**
- Create: `internal/server/daemon.go`
- Create: `internal/server/daemon_test.go`

**Step 1: Write the failing test.**

Create `internal/server/daemon_test.go`:

```go
package server

import (
	"testing"

	"github.com/user/muxterm/internal/sessiond"
)

// fakeDaemonConn is a test double for DaemonConn.
type fakeDaemonConn struct {
	attached  string
	inputs    []string
	resizes   [][3]int // paneID, cols, rows
	createdID int
	handlers  sessiond.Handlers
}

func (f *fakeDaemonConn) ListWorkspaces() ([]sessiond.WorkspaceInfo, error) {
	return []sessiond.WorkspaceInfo{{WorkspaceID: "w1", Name: "dev", PaneCount: 1}}, nil
}
func (f *fakeDaemonConn) CreateWorkspace(name string) (string, error)    { return "w2", nil }
func (f *fakeDaemonConn) RenameWorkspace(workspaceID, name string) error { return nil }
func (f *fakeDaemonConn) CloseWorkspace(workspaceID string) error        { return nil }
func (f *fakeDaemonConn) Attach(workspaceID string) (sessiond.Composition, error) {
	f.attached = workspaceID
	return sessiond.Composition{WorkspaceID: workspaceID, Panes: []sessiond.PaneInfo{{PaneID: 1, Cols: 80, Rows: 24}}}, nil
}
func (f *fakeDaemonConn) CreatePane(cmd []string) (int, error) { return f.createdID, nil }
func (f *fakeDaemonConn) Input(paneID uint32, data []byte) error {
	f.inputs = append(f.inputs, string(data))
	return nil
}
func (f *fakeDaemonConn) Resize(paneID, cols, rows int) error {
	f.resizes = append(f.resizes, [3]int{paneID, cols, rows})
	return nil
}
func (f *fakeDaemonConn) SetHandlers(h sessiond.Handlers) { f.handlers = h }
func (f *fakeDaemonConn) Run() error                      { return nil }
func (f *fakeDaemonConn) Close() error                    { return nil }

func TestDaemonConnInterfaceSatisfied(t *testing.T) {
	var _ DaemonConn = (*fakeDaemonConn)(nil)
	var _ DaemonConn = (*sessiond.Client)(nil)
}
```

**Step 2: Run it to verify it fails.**

Run: `go test ./internal/server/ -run TestDaemonConnInterfaceSatisfied -v`
Expected: FAIL — `undefined: DaemonConn`.

**Step 3: Write the minimal implementation.**

Create `internal/server/daemon.go`:

```go
package server

import "github.com/user/muxterm/internal/sessiond"

// DaemonConn is the seam between the web hub and one sessiond client connection.
// *sessiond.Client implements it; tests provide a fake. One DaemonConn backs
// exactly one browser WebSocket. It is exported so cmd/muxterm can build the
// dialer that returns it.
type DaemonConn interface {
	ListWorkspaces() ([]sessiond.WorkspaceInfo, error)
	CreateWorkspace(name string) (string, error)
	RenameWorkspace(workspaceID, name string) error
	CloseWorkspace(workspaceID string) error
	Attach(workspaceID string) (sessiond.Composition, error)
	CreatePane(cmd []string) (int, error)
	Input(paneID uint32, data []byte) error
	Resize(paneID, cols, rows int) error
	SetHandlers(h sessiond.Handlers)
	Run() error
	Close() error
}

// DialFunc creates a new daemon connection (one per browser). Injectable so the
// hub can be tested without a real daemon socket.
type DialFunc func() (DaemonConn, error)
```

**Step 4: Run it to verify it passes.**

Run: `go test ./internal/server/ -run TestDaemonConnInterfaceSatisfied -v`
Expected: PASS. (`*sessiond.Client` satisfies the interface from Part A.)

**Step 5: Commit.**

```
git add internal/server/daemon.go internal/server/daemon_test.go
git commit -m "$(cat <<'EOF'
feat(server): add exported DaemonConn seam over sessiond.Client

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 9: Rewrite the hub to relay the frozen vocabulary over DaemonConn

This is the core repoint. Replace the `TmuxEngine` field, `sendStateSync`/capture path, `BroadcastPaneOutput`, `HandleTmuxDisconnect`, the tmux `dispatchAction`, and the single-key `parseClientMessage`/`NewServerMsg` plumbing with the daemon relay. Each browser `Client` owns a `DaemonConn`; its handlers relay daemon frames to that browser as frozen `sessiond.Message`s and binary pane frames.

> Keep `EncodeBinaryFrame`/`DecodeBinaryFrame` (binary frame format unchanged). **Delete** the tmux `%`-string pane id helpers `PaneIDToUint32`/`Uint32ToPaneID` — pane ids are now plain `int`/`uint32`.

**Files:**
- Modify: `internal/server/ws.go` (substantial)
- Modify: `internal/server/server.go` (drop the `TmuxEngine` arg; add dialer wiring)
- Create: `internal/server/relay_test.go`

**Step 1: Write the failing test.**

Create `internal/server/relay_test.go`:

```go
package server

import (
	"encoding/json"
	"testing"

	"github.com/user/muxterm/internal/sessiond"
)

func newTestHub(dc DaemonConn) *Hub {
	return NewHub(func() (DaemonConn, error) { return dc, nil })
}

// decodeMsg parses a serve->browser text frame as a frozen sessiond.Message.
func decodeMsg(t *testing.T, b []byte) sessiond.Message {
	t.Helper()
	var m sessiond.Message
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("decode message: %v (%s)", err, b)
	}
	return m
}

func firstOfType(msgs [][]byte, typ string) (sessiond.Message, bool) {
	for _, b := range msgs {
		var m sessiond.Message
		if json.Unmarshal(b, &m) == nil && m.Type == typ {
			return m, true
		}
	}
	return sessiond.Message{}, false
}

func TestAttachRelaysCompositionAndOutput(t *testing.T) {
	fake := &fakeDaemonConn{createdID: 9}
	hub := newTestHub(fake)

	var textMsgs [][]byte
	var binMsgs [][]byte
	c := newTestClient(hub,
		func(b []byte) error { textMsgs = append(textMsgs, b); return nil },
		func(b []byte) error { binMsgs = append(binMsgs, b); return nil })

	if err := hub.attachClient(c); err != nil {
		t.Fatalf("attachClient: %v", err)
	}

	// Browser attaches to w1 using the FROZEN vocabulary (type:attach, cid echoed).
	c.handleTextInput([]byte(`{"type":"attach","cid":11,"workspaceId":"w1"}`))

	if fake.attached != "w1" {
		t.Fatalf("daemon attached to %q, want w1", fake.attached)
	}
	comp, ok := firstOfType(textMsgs, sessiond.TypeComposition)
	if !ok {
		t.Fatalf("no composition sent; got %d text msgs", len(textMsgs))
	}
	if comp.CID != 11 {
		t.Errorf("composition cid = %d, want echoed 11", comp.CID)
	}
	if comp.WorkspaceID != "w1" || len(comp.Panes) != 1 {
		t.Errorf("composition = %+v", comp)
	}

	// Daemon emits pane output -> browser binary frame.
	fake.handlers.OnPaneOutput(1, []byte("hi"))
	if len(binMsgs) == 0 {
		t.Fatal("no binary output forwarded")
	}
	paneID, payload, err := DecodeBinaryFrame(binMsgs[len(binMsgs)-1])
	if err != nil || paneID != 1 || string(payload) != "hi" {
		t.Fatalf("frame = (%d,%q,%v)", paneID, payload, err)
	}

	// Daemon emits pane-added -> browser gets a frozen pane-added message.
	fake.handlers.OnPaneAdded(sessiond.PaneInfo{PaneID: 2, Cols: 80, Rows: 24})
	added, ok := firstOfType(textMsgs, sessiond.TypePaneAdded)
	if !ok || added.PaneID != 2 {
		t.Fatalf("no pane-added forwarded (added=%+v ok=%v)", added, ok)
	}
}

func TestBrowserInputAndResizeReachDaemon(t *testing.T) {
	fake := &fakeDaemonConn{}
	hub := newTestHub(fake)
	c := newTestClient(hub, func([]byte) error { return nil }, func([]byte) error { return nil })
	if err := hub.attachClient(c); err != nil {
		t.Fatalf("attachClient: %v", err)
	}

	// Binary input frame for pane 3.
	c.handleBinaryInput(EncodeBinaryFrame(3, []byte("ls\r")))
	if len(fake.inputs) != 1 || fake.inputs[0] != "ls\r" {
		t.Fatalf("daemon inputs = %v", fake.inputs)
	}

	// Resize as a frozen control message (connection-scoped: no workspaceId).
	c.handleTextInput([]byte(`{"type":"resize","paneId":3,"cols":120,"rows":30}`))
	if len(fake.resizes) != 1 || fake.resizes[0] != [3]int{3, 120, 30} {
		t.Fatalf("daemon resizes = %v", fake.resizes)
	}
}

func TestUnknownWorkspaceErrorPreservesCode(t *testing.T) {
	fake := &errDaemonConn{}
	hub := newTestHub(fake)
	var textMsgs [][]byte
	c := newTestClient(hub, func(b []byte) error { textMsgs = append(textMsgs, b); return nil }, func([]byte) error { return nil })
	if err := hub.attachClient(c); err != nil {
		t.Fatalf("attachClient: %v", err)
	}

	c.handleTextInput([]byte(`{"type":"attach","cid":7,"workspaceId":"gone"}`))
	errMsg, ok := firstOfType(textMsgs, sessiond.TypeError)
	if !ok {
		t.Fatal("no error message forwarded to browser")
	}
	if errMsg.Code != sessiond.CodeUnknownWorkspace {
		t.Errorf("error code = %q, want %q", errMsg.Code, sessiond.CodeUnknownWorkspace)
	}
	if errMsg.CID != 7 {
		t.Errorf("error cid = %d, want echoed 7", errMsg.CID)
	}
}

// errDaemonConn returns an unknown-workspace DaemonError from Attach.
type errDaemonConn struct{ fakeDaemonConn }

func (e *errDaemonConn) Attach(string) (sessiond.Composition, error) {
	return sessiond.Composition{}, &sessiond.DaemonError{Code: sessiond.CodeUnknownWorkspace, Err: "no such workspace", WorkspaceID: "gone"}
}
```

> `newTestClient` is a test constructor (added in Step 3) that builds a `*Client` whose `writeText`/`writeBinary` are redirected to capture funcs (no real WS), so the relay can be tested without a browser.

**Step 2: Run it to verify it fails.**

Run: `go test ./internal/server/ -run 'TestAttachRelays|TestBrowserInput|TestUnknownWorkspace' -v`
Expected: FAIL — `NewHub` signature mismatch, `attachClient`, `newTestClient` undefined.

**Step 3: Write the minimal implementation.**

In `internal/server/ws.go`:

1. **Delete** the `TmuxEngine` interface (lines ~19–52), `scheduleSync`/`syncTimer` machinery, `sendStateSync` (lines ~289–345), `HandleTmuxDisconnect` (~531–553), `sessionListJSON`/`BroadcastFullSync`/`BroadcastSessionList`/`BroadcastPaneOutput` (~557–615), `PaneIDToUint32`/`Uint32ToPaneID` (~365–380), `parseClientMessage` (~382–396), and the entire tmux `dispatchAction` switch (~398–503). Remove the `internal/tmux`, `strconv`, and `strings` imports if now unused.
2. **Change `Hub`** to hold `dial DialFunc` instead of `engine TmuxEngine`; keep `clients map[*Client]bool`, `mu`, `resolvedConfig`. Remove `surfaceRouter` (deleted in Task 10).
3. **Update `NewHub`** to `func NewHub(dial DialFunc) *Hub` and add `func (h *Hub) SetDialer(d DialFunc)`.
4. **Give `Client`** a `daemon DaemonConn` field plus `writeTextFn func([]byte) error` and `writeBinaryFn func([]byte) error` (defaulting to the real WS writers in `newClient`). Make `writeText`/`writeBinary` delegate to these fns.
5. **Add the relay wiring** (frozen `sessiond.Message` re-emission):

```go
// attachClient dials a daemon connection for this browser, installs handlers
// that relay daemon frames to the browser in the FROZEN vocabulary, starts the
// read loop, and sends the initial config + workspace list.
func (h *Hub) attachClient(c *Client) error {
	dc, err := h.dial()
	if err != nil {
		return err
	}
	c.daemon = dc
	dc.SetHandlers(sessiond.Handlers{
		OnPaneOutput:       func(p uint32, d []byte) { _ = c.writeBinary(EncodeBinaryFrame(p, d)) },
		OnPaneAdded:        func(p sessiond.PaneInfo) { c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneAdded, PaneID: p.PaneID, Cols: p.Cols, Rows: p.Rows, Title: p.Title}) },
		OnPaneClosed:       func(p int) { c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneClosed, PaneID: p}) },
		OnWorkspaceClosed:  func(id string) { c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceClosed, WorkspaceID: id}) },
		OnWorkspaceRenamed: func(id, name string) { c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceRenamed, WorkspaceID: id, Name: name}) },
	})
	go func() { _ = dc.Run() }()

	h.mu.RLock()
	cfg := h.resolvedConfig
	h.mu.RUnlock()
	if cfg != nil {
		c.sendConfig(cfg)
	}
	if list, lerr := dc.ListWorkspaces(); lerr == nil {
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceList, Workspaces: list})
	}
	return nil
}

// sendMessage marshals a frozen sessiond.Message and writes it as a text frame.
func (c *Client) sendMessage(m *sessiond.Message) {
	data, err := json.Marshal(m)
	if err != nil {
		return
	}
	_ = c.writeText(data)
}

// sendConfig sends the serve-local resolved config (NOT a sessiond message).
func (c *Client) sendConfig(cfg any) {
	data, err := json.Marshal(map[string]any{"type": "config", "config": cfg})
	if err != nil {
		return
	}
	_ = c.writeText(data)
}
```

6. **Rewrite `handleBinaryInput`** to forward to the daemon:

```go
func (c *Client) handleBinaryInput(data []byte) {
	paneID, payload, err := DecodeBinaryFrame(data)
	if err != nil || c.daemon == nil {
		return
	}
	if err := c.daemon.Input(paneID, payload); err != nil {
		log.Printf("handleBinaryInput: %v", err)
	}
}
```

7. **Rewrite `handleTextInput`** to parse a frozen `sessiond.Message` and dispatch by `Type`, echoing the browser's `cid` on every reply:

```go
func (c *Client) handleTextInput(data []byte) {
	var msg sessiond.Message
	if err := json.Unmarshal(data, &msg); err != nil {
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeError, Error: "invalid JSON: " + err.Error()})
		return
	}
	if c.daemon == nil {
		c.sendError(msg.CID, "", &sessiond.DaemonError{Code: "no-daemon", Err: "no daemon connection"})
		return
	}
	switch msg.Type {
	case sessiond.TypeAttach:
		comp, err := c.daemon.Attach(msg.WorkspaceID)
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeComposition, CID: msg.CID, WorkspaceID: comp.WorkspaceID, Panes: comp.Panes})
	case sessiond.TypeListWorkspaces:
		list, err := c.daemon.ListWorkspaces()
		if err != nil {
			c.sendError(msg.CID, "", err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceList, CID: msg.CID, Workspaces: list})
	case sessiond.TypeCreateWorkspace:
		id, err := c.daemon.CreateWorkspace(msg.Name)
		if err != nil {
			c.sendError(msg.CID, "", err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceCreated, CID: msg.CID, WorkspaceID: id})
	case sessiond.TypeRenameWorkspace:
		if err := c.daemon.RenameWorkspace(msg.WorkspaceID, msg.Name); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID, WorkspaceID: msg.WorkspaceID})
	case sessiond.TypeCloseWorkspace:
		if err := c.daemon.CloseWorkspace(msg.WorkspaceID); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})
	case sessiond.TypeCreatePane:
		paneID, err := c.daemon.CreatePane(msg.Cmd)
		if err != nil {
			c.sendError(msg.CID, "", err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneCreated, CID: msg.CID, PaneID: paneID})
	case sessiond.TypeResize:
		if err := c.daemon.Resize(msg.PaneID, msg.Cols, msg.Rows); err != nil {
			log.Printf("resize: %v", err)
		}
	default:
		c.sendError(msg.CID, "", &sessiond.DaemonError{Code: "unknown-action", Err: "unknown type: " + msg.Type})
	}
}

// sendError relays a daemon/serve error to the browser preserving the stable
// code so the client's typed recovery (e.g. unknown-workspace) fires.
func (c *Client) sendError(cid uint64, workspaceID string, err error) {
	out := &sessiond.Message{Type: sessiond.TypeError, CID: cid, WorkspaceID: workspaceID, Error: err.Error()}
	var de *sessiond.DaemonError
	if errors.As(err, &de) {
		out.Code = de.Code
		out.Error = de.Err
		if de.WorkspaceID != "" {
			out.WorkspaceID = de.WorkspaceID
		}
	}
	c.sendMessage(out)
}
```

8. **Update `newClient`** to set `writeTextFn`/`writeBinaryFn` to the real WS-backed closures, and `writeText`/`writeBinary` to delegate:

```go
func (c *Client) writeText(data []byte) error   { return c.writeTextFn(data) }
func (c *Client) writeBinary(data []byte) error { return c.writeBinaryFn(data) }
```

(Move the existing WS-write bodies into the default `writeTextFn`/`writeBinaryFn` closures created in `newClient`.)

9. **Update `Hub.Add`/`Hub.Remove`/`handleWSImpl`**: on add, call `attachClient(c)` (replacing `sendStateSync`); on remove, call `c.daemon.Close()` if non-nil (drops the subscriber — detach is a non-event). Remove `BroadcastEvent`/`broadcastText` if now unused, or keep `broadcastText` only if still referenced; the relay is per-client, so cross-client broadcast is gone.
10. **Add `newTestClient`** in `relay_test.go`:

```go
func newTestClient(hub *Hub, wt, wb func([]byte) error) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{hub: hub, ctx: ctx, cancel: cancel, writeTextFn: wt, writeBinaryFn: wb}
}
```

(Add `"context"` to `relay_test.go` imports.)

In `internal/server/server.go`: change `func New(cfg Config, engine ...TmuxEngine) *Server` to `func New(cfg Config) *Server` building the hub with a nil dialer (`NewHub(nil)`); the dialer is injected later via `s.hub.SetDialer(...)` (Task 11). Add the `"github.com/user/muxterm/internal/sessiond"` and `"errors"` imports to `ws.go` as needed.

**Step 4: Run it to verify it passes.**

Run: `go test ./internal/server/ -run 'TestAttachRelays|TestBrowserInput|TestUnknownWorkspace' -v`
Expected: PASS. (Other server tests are still broken — fixed in Tasks 10 & 12.)

**Step 5: Commit.**

```
git add internal/server/ws.go internal/server/server.go internal/server/relay_test.go
git commit -m "$(cat <<'EOF'
feat(server): relay the frozen sessiond vocabulary over a per-browser client

Replaces the tmux control-mode engine with a per-browser sessiond client.
The browser speaks the SAME sessiond.Message types the daemon does; serve
re-emits composition/workspace-list/pane-* / error preserving type+fields
(incl. error code), echoing the browser's cid. Binary framing unchanged.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 10: Delete the tmux-specific server surface (SurfaceRouter, session picker)

`surface.go`/`ws_surface_test.go` model tmux control surfaces; `session.go`/`session_test.go` model the tmux session picker. They are dead after Task 9.

**Files:**
- Delete: `internal/server/surface.go`
- Delete: `internal/server/ws_surface_test.go`
- Delete: `internal/server/session.go`
- Delete: `internal/server/session_test.go`
- Inspect: `internal/server/ws_config_test.go` (keep & repoint, or delete)

**Step 1: Check `ws_config_test.go` first.**

Run: `sed -n '1,60p' internal/server/ws_config_test.go`
If it only exercises `SetResolvedConfig` + the `config` message (both retained), **keep it** and adjust any `NewHub(engine)`/`New(cfg, engine)` call to the new signatures (`NewHub(nil)` / `New(cfg)`). If it references removed tmux APIs, delete it.

**Step 2: Delete the dead files.**

```
git rm internal/server/surface.go internal/server/ws_surface_test.go internal/server/session.go internal/server/session_test.go
```

**Step 3: Remove dangling references.**

Run: `grep -rn "SurfaceRouter\|SessionInfo\|SessionListMessage\|surfaceRouter\|SurfaceID" internal/server`
Expected: no matches remain. Fix any stragglers (e.g. a leftover `SurfaceID` type referenced by deleted code).

**Step 4: Build the package.**

Run: `go build ./internal/server/`
Expected: builds (test files may still fail — fixed in Task 12).

**Step 5: Commit.**

```
git add -A internal/server
git commit -m "$(cat <<'EOF'
refactor(server): delete tmux-specific SurfaceRouter and session-picker code

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Part C — repoint `cmd/muxterm` and delete dead tmux code

### Task 11: Rewire `serve`/`local` to the sessiond dialer; delete tmux control wiring

Replace the `controllerPool`/`startTmuxControl`/`applyMuxtermConfig`/`CapturePaneContent`/supervisor machinery in `main.go` with a `DialFunc` that ensures the daemon is up (Phase 2 helpers) and dials a `sessiond.Client`.

**Files:**
- Modify: `cmd/muxterm/main.go` (major deletion)
- Delete: `cmd/muxterm/controller_pool.go`
- Delete: `cmd/muxterm/controller_pool_test.go`
- Modify: `cmd/muxterm/main_test.go` (drop tests for deleted functions)

**Step 1: Write the failing test.**

Add to `cmd/muxterm/main_test.go` (or a new `serve_test.go`):

```go
func TestNewSessiondDialerDials(t *testing.T) {
	// A dialer built from a socket path should produce a working DaemonConn
	// when a daemon is listening. Use a temp socket with a trivial accept loop.
	dir := t.TempDir()
	sock := filepath.Join(dir, "sessiond.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		if c, err := ln.Accept(); err == nil {
			time.Sleep(100 * time.Millisecond)
			c.Close()
		}
	}()

	dial := newSessiondDialerForSocket(sock)
	conn, err := dial()
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	conn.Close()
}
```

Add imports `net`, `path/filepath`, `time` to the test file as needed.

**Step 2: Run it to verify it fails.**

Run: `go test ./cmd/muxterm/ -run TestNewSessiondDialerDials -v`
Expected: FAIL — `undefined: newSessiondDialerForSocket`.

**Step 3: Write the minimal implementation.**

In `cmd/muxterm/main.go`:

1. **Delete**: `startTmuxControl` (line ~265), `applyMuxtermConfig` (~246), `bootstrapTmuxState`, `queryCurrentState`, `CapturePaneContent`/`controllerAdapter` and all its methods (~432–700), `supervisePool` (~744), `startSession` (~772), `newStateSyncCoalescer`/`stateSyncCoalescer` (~829), `wireEvents` (~856), and any `internal/tmux`/`creack/pty`/`bytes` imports now unused.
2. **Add** the dialer (split so the socket-path variant is unit-testable without spawning a daemon):

```go
// newSessiondDialerForSocket returns a DialFunc that dials a fresh sessiond
// client per browser on an already-known socket path (no spawn).
func newSessiondDialerForSocket(socketPath string) server.DialFunc {
	return func() (server.DaemonConn, error) {
		return sessiond.Dial(socketPath)
	}
}

// newSessiondDialer returns a DialFunc that ensures the daemon is up (Phase 2
// helpers; gated off under systemd) and then dials it. Used by serve/local.
func newSessiondDialer() server.DialFunc {
	return func() (server.DaemonConn, error) {
		sock, err := sessiond.SocketPath()
		if err != nil {
			return nil, err
		}
		logPath, err := sessiond.DefaultLogPath()
		if err != nil {
			return nil, err
		}
		if err := sessiond.EnsureDaemon(sock, logPath); err != nil {
			return nil, err
		}
		return sessiond.Dial(sock)
	}
}
```

3. **Rewrite `runServe` / `runLocal`** to build the hub from the dialer instead of a tmux engine. For `runServe` (around line 99), after constructing `srv := server.New(server.Config{...})` and `srv.Hub().SetResolvedConfig(resolved)`, add:

```go
	srv.Hub().SetDialer(newSessiondDialer())
```

Do the same in `runLocal` (line ~71). Remove the now-deleted tmux engine/controller-pool construction and the `server.New(cfg, engine)` variadic engine argument (the signature is now `server.New(cfg)`).

**Step 4: Run it to verify it passes.**

Run: `go test ./cmd/muxterm/ -run TestNewSessiondDialerDials -v`
Then build everything: `go build ./...`
Expected: the run-test passes; `go build ./...` succeeds (fix any leftover references the compiler flags).

**Step 5: Delete the controller pool + its tests, then commit.**

```
git rm cmd/muxterm/controller_pool.go cmd/muxterm/controller_pool_test.go
# remove now-dead tests in main_test.go that referenced deleted funcs
git add -A cmd/muxterm internal/server
git commit -m "$(cat <<'EOF'
feat(cmd): wire serve/local to sessiond dialer; remove tmux control wiring

Uses Phase 2 SocketPath()+EnsureDaemon() to ensure the daemon, then dials
a per-browser sessiond.Client. Deletes startTmuxControl/applyMuxtermConfig/
CapturePaneContent/controllerAdapter/supervisor machinery.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 12: Delete the dead `internal/tmux` control-mode code; repoint remaining server tests

With `serve`, `main.go`, and the server hub off tmux, the `internal/tmux` control-mode package is dead. Remove it and repoint the remaining `internal/server` tests (the `mockEngine` and tmux-coupled assertions in `ws_test.go`) onto the sessiond fake.

**Files:**
- Delete: `internal/tmux/*` (verify each file is unreferenced first)
- Modify: `internal/server/ws_test.go` (replace `mockEngine`/tmux assertions with `fakeDaemonConn`-based tests)

**Step 1: Find any remaining references to `internal/tmux`.**

Run: `grep -rln "muxterm/internal/tmux" --include=*.go .`
Expected after Tasks 9 & 11: matches only inside `internal/tmux` itself and any not-yet-fixed test files. If `cmd/muxterm` or `internal/server` non-test files still import it, go back and remove the import.

**Step 2: Repoint `ws_test.go`.**

The old `ws_test.go` builds a `mockEngine` implementing `TmuxEngine` and exercises tmux actions (`select-window`, `split`, …) that no longer exist. Rewrite it against the new seam:
- Replace `NewHub(newMockEngine())` / `New(cfg, engine)` with `newTestHub(&fakeDaemonConn{})` (from `daemon_test.go`).
- Replace `SendKeys` assertions with `fakeDaemonConn.inputs` assertions (input now flows to `daemon.Input`).
- Delete tests for removed actions (`select-window`, `select-pane`, `split`, `resize-pane`, `new-window`, `close-pane`, `close-window`, `rename-window`, `create-session`, `attach-session`, `resize-surface`, `open-settings`, `request-sync`).
- Keep/port the frame round-trip tests (`EncodeBinaryFrame`/`DecodeBinaryFrame`) — those helpers are unchanged.

Run the server tests as you go: `go test ./internal/server/ -v`
Expected: green once `mockEngine` and tmux-action tests are gone/replaced.

**Step 3: Delete `internal/tmux`.**

Once `grep` shows no non-tmux references:
```
git rm -r internal/tmux
```

**Step 4: Full build + test.**

Run: `go build ./... && go test ./...`
Expected: everything builds and passes. If `cmd/muxterm/main_test.go` or `cli_test.go` reference removed symbols, fix or delete those specific tests.

**Step 5: Quality gate + commit.**

Run: `gofmt -l . && go vet ./...`
Expected: no `gofmt -l` output, no vet errors.

```
git add -A
git commit -m "$(cat <<'EOF'
refactor: delete dead internal/tmux control-mode code; repoint server tests

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Part D — integration, cutover, verification

### Task 13: E2E — browser WS ↔ serve ↔ a real sessiond socket round-trip

A full-stack test: stand up the real `server.Server` with a dialer pointing at a real in-process daemon listener on a temp Unix socket, connect a real WebSocket client, and assert the round-trip: attach → see `composition` → send input → receive echoed pane output.

> If Phase 1 exposes an in-process daemon constructor (`sessiond.NewServer(socketPath)` + `ListenAndServe(ctx)`), prefer it to run a real daemon. If a real daemon is heavier than this test needs, use the scripted echo listener below — it speaks the frozen framing and exercises the entire serve relay path end-to-end.

**Files:**
- Create: `internal/server/e2e_test.go`

**Step 1: Write the failing test.**

Create `internal/server/e2e_test.go`:

```go
package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/user/muxterm/internal/sessiond"
)

// startEchoDaemon runs a minimal frozen-protocol daemon: on attach it returns a
// 1-pane composition; input bytes are echoed back as pane output for that pane.
func startEchoDaemon(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	sock := filepath.Join(dir, "sessiond.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				for {
					kind, payload, err := sessiond.ReadFrame(conn)
					if err != nil {
						return
					}
					switch kind {
					case sessiond.FrameControl:
						var req sessiond.Message
						_ = json.Unmarshal(payload, &req)
						switch req.Type {
						case sessiond.TypeListWorkspaces:
							_ = sessiond.WriteControl(conn, &sessiond.Message{Type: sessiond.TypeWorkspaceList, CID: req.CID, Workspaces: []sessiond.WorkspaceInfo{{WorkspaceID: "w1", Name: "dev", PaneCount: 1}}})
						case sessiond.TypeAttach:
							_ = sessiond.WriteControl(conn, &sessiond.Message{Type: sessiond.TypeComposition, CID: req.CID, WorkspaceID: req.WorkspaceID, Panes: []sessiond.PaneInfo{{PaneID: 1, Cols: 80, Rows: 24}}})
						case sessiond.TypeResize:
							// no reply
						}
					case sessiond.FramePaneData:
						paneID, data := sessiond.DecodePaneData(payload)
						_ = sessiond.WritePaneData(conn, paneID, data) // echo
					}
				}
			}(conn)
		}
	}()
	return sock
}

func TestE2EBrowserToDaemonRoundTrip(t *testing.T) {
	sock := startEchoDaemon(t)

	srv := New(Config{Addr: "127.0.0.1:0"})
	srv.Hub().SetDialer(func() (DaemonConn, error) { return sessiond.Dial(sock) })

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Attach using the frozen vocabulary.
	mustWriteText(t, ctx, conn, `{"type":"attach","cid":1,"workspaceId":"w1"}`)
	if !waitForType(t, ctx, conn, sessiond.TypeComposition) {
		t.Fatal("never received composition")
	}

	// Send input -> expect echoed pane output as a binary frame.
	mustWriteBinary(t, ctx, conn, EncodeBinaryFrame(1, []byte("ping")))
	if !waitForBinary(t, ctx, conn, 1, "ping") {
		t.Fatal("never received echoed output")
	}
}
```

Add the small WS helpers (`mustWriteText`, `mustWriteBinary`, `waitForType`, `waitForBinary`) at the bottom of `e2e_test.go`, reading frames in a loop with `conn.Read(ctx)`: decode text frames as `sessiond.Message` and compare `.Type`; decode binary with `DecodeBinaryFrame`; each helper has a deadline via `ctx`.

**Step 2: Run it to verify it fails.**

Run: `go test ./internal/server/ -run TestE2EBrowserToDaemonRoundTrip -v`
Expected: FAIL initially if any helper/signature is off; fix until it compiles and fails for the right reason, then passes once the relay is correct.

**Step 3: Make it pass.**

No new production code should be needed if Tasks 9–11 are correct. If the test reveals a gap (e.g. the hub never sends `composition`, or input isn't forwarded), fix the minimal production code in `ws.go` and re-run.

**Step 4: Run the full suite.**

Run: `go test ./...`
Expected: all packages pass.

**Step 5: Commit.**

```
git add internal/server/e2e_test.go
git commit -m "$(cat <<'EOF'
test(server): E2E browser WS <-> serve <-> sessiond round-trip (frozen wire)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 14: tmux cutover — one-time warning + release note (clean break, no migration)

This is a clean break: muxterm v1 with sessiond does **not** migrate pre-existing tmux sessions. Make that explicit and discoverable rather than silently dropping users' tmux state. Keep it minimal — a warning and a note, not a migration engine.

**Files:**
- Modify: `cmd/muxterm/main.go` (one-time first-start warning in `runServe`/`runLocal`)
- Create: `docs/RELEASE_NOTES_sessiond_cutover.md` (release-note stub)

**Step 1: Write the failing test.**

Add to `cmd/muxterm/main_test.go`:

```go
func TestTmuxCutoverWarningText(t *testing.T) {
	got := tmuxCutoverWarning()
	for _, want := range []string{"tmux", "not", "migrat"} {
		if !strings.Contains(strings.ToLower(got), want) {
			t.Errorf("cutover warning missing %q: %q", want, got)
		}
	}
}
```

Add `"strings"` to the test imports if needed.

**Step 2: Run it to verify it fails.**

Run: `go test ./cmd/muxterm/ -run TestTmuxCutoverWarningText -v`
Expected: FAIL — `undefined: tmuxCutoverWarning`.

**Step 3: Write the minimal implementation.**

Add to `cmd/muxterm/main.go`:

```go
// tmuxCutoverWarning is the one-time notice shown on serve/local start that
// muxterm now uses its own session daemon and does NOT migrate pre-existing
// tmux sessions. This is a deliberate clean break (no migration engine in v1).
func tmuxCutoverWarning() string {
	return "muxterm now uses its own session daemon (sessiond); pre-existing tmux " +
		"sessions are NOT migrated. Run `muxterm doctor` for daemon status."
}
```

In `runServe` and `runLocal`, log it once near startup:

```go
	log.Printf("notice: %s", tmuxCutoverWarning())
```

**Step 4: Run it to verify it passes.**

Run: `go test ./cmd/muxterm/ -run TestTmuxCutoverWarningText -v`
Expected: PASS.

**Step 5: Add the release-note stub and commit.**

Create `docs/RELEASE_NOTES_sessiond_cutover.md`:

```markdown
# Session daemon cutover (sessiond)

muxterm no longer drives tmux in control mode. Terminal sessions are now owned
by muxterm's own session daemon, **sessiond**.

## What changes for you

- **Pre-existing tmux sessions are NOT migrated.** This is a deliberate clean
  break for v1; there is no migration engine. Detach/close any tmux sessions you
  were using with the old muxterm; start fresh under sessiond.
- New sessions persist across `serve` restarts (the daemon outlives `serve`).
- The one event that still loses sessions is a `sessiond` crash; `Restart=on-failure`
  relaunches it.

## Checking daemon status

Run `muxterm doctor` to see whether the daemon is running and where its socket
and log live. (Surfacing this cutover notice in `muxterm doctor` is a follow-up;
the daemon-status check itself is Phase 2.)
```

```
git add cmd/muxterm/main.go cmd/muxterm/main_test.go docs/RELEASE_NOTES_sessiond_cutover.md
git commit -m "$(cat <<'EOF'
feat(cmd): warn on tmux cutover + add sessiond release-note stub

Clean break: pre-existing tmux sessions are not migrated. One-time startup
warning plus a release note; surfacing in `muxterm doctor` is a follow-up.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 15: Final verification sweep

**Files:** none (verification only).

**Step 1: Confirm no tmux references remain in production code.**

Run:
```
grep -rln "internal/tmux\|control-mode\|capture-pane\|TmuxEngine" --include=*.go . || echo "CLEAN"
```
Expected: `CLEAN` (or matches only in docs/comments you intentionally kept). No `.go` production file imports `internal/tmux`.

**Step 2: Confirm the relay uses ONLY the frozen symbols (no drift).**

Run:
```
grep -rn "WriteData\|KindControl\|KindData" --include=*.go internal/ cmd/ || echo "NO-DRIFT-SYMBOLS"
grep -rn "attach-workspace\|\"attached\"" --include=*.go internal/server cmd/muxterm || echo "NO-INVENTED-VOCAB"
```
Expected: `NO-DRIFT-SYMBOLS` and `NO-INVENTED-VOCAB`. The relay speaks frozen `sessiond.Message` types only.

**Step 3: Full build, vet, format, test (with race).**

Run:
```
gofmt -l . ; go vet ./... ; go build ./... ; go test -race ./...
```
Expected: `gofmt -l` prints nothing, `go vet` clean, build succeeds, all tests pass under `-race`.

**Step 4: Confirm the binary framing contract is intact.**

Run: `grep -n "EncodeBinaryFrame\|DecodeBinaryFrame" internal/server/ws.go`
Expected: both present and unchanged in wire format (`[4-byte LE paneID][data]`).

**Step 5: Commit any formatting fixes (if `gofmt -l` flagged files).**

```
gofmt -w .
git add -A
git commit -m "$(cat <<'EOF'
chore(phase3): gofmt + final verification sweep for serve relay

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

If nothing changed, skip the commit.

---

## Done — Phase 3 deliverable

After Task 15:
- `internal/sessiond/client.go` is a complete serve-side daemon client built on the **frozen** symbols: `ReadFrame(kind,payload,err)`, `WriteControl(w,*Message)`, `WritePaneData`, `DecodePaneData(paneID,data)`, the `Type*`/`Code*` constants, and the `Message`/`WorkspaceInfo`/`PaneInfo` structs. It does request/reply by daemon-echoed `cid`, returns a single `composition` on attach (no deadlock), and is connection-scoped for create-pane/resize/input.
- `internal/server` relays each browser WebSocket over a per-connection `sessiond.Client`; the browser speaks the **same** `sessiond.Message` vocabulary the daemon does (no invented `attach-workspace`/`attached`); error `code` and `composition`/`workspace-created`/`unknown-workspace` are preserved; browser binary framing `[4-byte LE paneID][data]` is unchanged.
- `cmd/muxterm` `serve`/`local` ensure the daemon via `sessiond.SocketPath()`+`EnsureDaemon()` and source all terminal state from it.
- All tmux control-mode code (`internal/tmux`, `controller_pool`, `startTmuxControl`, `applyMuxtermConfig`, `CapturePaneContent`, `SurfaceRouter`, the session picker) is deleted with no dead references.
- A one-time cutover warning + release note make the clean break explicit (no tmux-session migration).
- An end-to-end test proves browser ↔ serve ↔ real-socket daemon round-trip (attach, composition, input echo).
