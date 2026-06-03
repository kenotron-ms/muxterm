# muxterm Protocol Fix – Phase 1: Go sessiond Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Fix three broadcast scope bugs in the Go sessiond daemon so every live connection receives workspace mutation events, eliminating the 5-second timeout and missing-event failures.

**Architecture:** Add a `conns map[*conn]bool` field to `Server` tracking ALL live connections (not just workspace subscribers), then rewrite `broadcastAll` to iterate it. Replace the workspace-scoped `broadcast` + `reply(TypeOK)` calls in rename, close, and pane-exit handlers with `broadcastAll(workspace-list)`, giving every client a full reconciliation snapshot on any workspace mutation.

**Tech Stack:** Go · `internal/sessiond` package · Unix socket framing protocol · standard library only

---

## Background: What's Broken and Why

Three handlers share a root cause — `broadcastAll` iterates `s.subs` (workspace subscriber sets) instead of all live connections:

| Handler | Current (broken) | Symptom |
|---|---|---|
| `broadcastAll` | iterates `s.subs` | unattached conns receive nothing |
| `TypeRenameWorkspace` | `reply(TypeOK)` + `broadcast(wsId, workspace-renamed)` | cross-workspace clients miss the update |
| `TypeCloseWorkspace` | `reply(TypeOK)` + `broadcast(wsId, workspace-closed)` | actor never sees the event; 5s timeout |
| `handlePaneExit` auto-close | `broadcast(wsId, workspace-closed)` | observer on different workspace misses it |

The fix: every workspace mutation ends with `broadcastAll(workspace-list)` to ALL connections, so any client can reconcile.

---

## Key Files

| File | Role |
|---|---|
| `internal/sessiond/server.go` | Server struct, handlers, broadcastAll — **all production changes go here** |
| `internal/sessiond/broadcast_test.go` | Existing broadcast tests — **all new tests go here** |
| `internal/sessiond/server_integration_test.go` | Lifecycle integration test — **update one existing test in Task 3** |
| `internal/sessiond/server_test.go` | Helpers: `startTestServer`, `dialMust`, `readControlUntil`, `writeControlMust` |
| `internal/sessiond/server_integration_test.go` | Helpers: `tClient`, `newTClient` — `tClient.ctrl` is the `chan *Message` we read in tests |

---

## Codebase Patterns to Mirror

Tests in `internal/sessiond/` use two styles — match them exactly:

**Style A** (`server_test.go`, `broadcast_test.go`) — raw connections:
```go
conn := dialMust(t, socketPath)
writeControlMust(t, conn, &Message{...})
msg := readControlUntil(t, conn, TypeWorkspaceList)
```

**Style B** (`server_integration_test.go`) — `tClient` with buffered channels:
```go
c := newTClient(t, socketPath)
c.send(&Message{...})
msg := c.waitCtrl(TypeWorkspaceList) // skips non-matching types, 5s deadline
```

For multi-message loops (Tasks 2–4), access `tClient.ctrl chan *Message` directly with `time.After`:
```go
deadline := time.After(5 * time.Second)
for {
    select {
    case msg, ok := <-c.ctrl:
        if !ok { t.Fatal("connection closed") }
        // check msg, continue if not yet the one we want
    case <-deadline:
        t.Fatal("timeout: ...")
    }
}
```

---

## Task 1: Add `conns map[*conn]bool` + Fix `broadcastAll`

**Files:**
- Modify: `internal/sessiond/server.go`
- Test: `internal/sessiond/broadcast_test.go`

### Step 1: Write the failing test

Add to the bottom of `broadcast_test.go`. The file currently only imports `"testing"` — leave that for now; this test uses only helpers already in the package.

```go
// TestBroadcastAllReachesUnattachedConnections proves that broadcastAll delivers
// to connections that have never called attach. Previously broadcastAll iterated
// s.subs (workspace subscriber sets) and missed unattached conns entirely.
func TestBroadcastAllReachesUnattachedConnections(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// Client A: attach to the cold-start default workspace.
	a := dialMust(t, socketPath)
	writeControlMust(t, a, &Message{Type: TypeListWorkspaces, CID: 1})
	list := readControlUntil(t, a, TypeWorkspaceList)
	defaultID := list.Workspaces[0].WorkspaceID
	writeControlMust(t, a, &Message{Type: TypeAttach, WorkspaceID: defaultID, CID: 2})
	readControlUntil(t, a, TypeComposition)

	// Client B: connected but NEVER attached — must still receive broadcastAll.
	b := dialMust(t, socketPath)

	// Creator: creates a workspace, which triggers broadcastAll(workspace-list).
	creator := dialMust(t, socketPath)
	writeControlMust(t, creator, &Message{Type: TypeCreateWorkspace, Name: "trigger", CID: 3})
	readControlUntil(t, creator, TypeWorkspaceCreated)

	// A (attached) must receive workspace-list with 2 workspaces.
	gotA := readControlUntil(t, a, TypeWorkspaceList)
	if len(gotA.Workspaces) != 2 {
		t.Fatalf("A: workspace count = %d, want 2 (default + trigger)", len(gotA.Workspaces))
	}

	// B (unattached) must ALSO receive workspace-list. Previously it timed out here.
	gotB := readControlUntil(t, b, TypeWorkspaceList)
	if len(gotB.Workspaces) != 2 {
		t.Fatalf("B: workspace count = %d, want 2 (default + trigger)", len(gotB.Workspaces))
	}
}
```

### Step 2: Run the test to confirm it fails (RED)

```
cd /home/ken/workspace/muxterm
go test ./internal/sessiond/... -run TestBroadcastAllReachesUnattachedConnections -v -count=1
```

Expected: **FAIL** — test times out in `readControlUntil` for B because the unattached conn never receives the workspace-list.

### Step 3: Implement the fix in `server.go`

**3a. Add `conns` field to `Server` struct** (after the existing `subs` field, ~line 22):

```go
// Before
type Server struct {
	reg    *Registry
	socket string

	mu   sync.Mutex
	subs map[string]map[*conn]bool // workspaceId -> set of attached connections
}

// After
type Server struct {
	reg    *Registry
	socket string

	mu    sync.Mutex
	subs  map[string]map[*conn]bool // workspaceId -> set of attached connections
	conns map[*conn]bool             // ALL live connections, regardless of attach state
}
```

**3b. Initialize `conns` in `NewServer`** (~line 34):

```go
// Before
return &Server{
    reg:    NewRegistry(),
    socket: socketPath,
    subs:   make(map[string]map[*conn]bool),
}, nil

// After
return &Server{
    reg:    NewRegistry(),
    socket: socketPath,
    subs:   make(map[string]map[*conn]bool),
    conns:  make(map[*conn]bool),
}, nil
```

**3c. Register each new conn in `ListenAndServe`** (~line 86, after `c := newConn(s, nc)`):

```go
// Before
c := newConn(s, nc)
go c.serve()

// After
c := newConn(s, nc)
s.mu.Lock()
s.conns[c] = true
s.mu.Unlock()
go c.serve()
```

**3d. Deregister on `cleanup()`** (~line 249):

```go
// Before
func (c *conn) cleanup() {
	c.srv.unsubscribe(c)
	c.sub.Close()
}

// After
func (c *conn) cleanup() {
	c.srv.unsubscribe(c)
	c.srv.mu.Lock()
	delete(c.srv.conns, c)
	c.srv.mu.Unlock()
	c.sub.Close()
}
```

**3e. Rewrite `broadcastAll` to iterate `s.conns`** (~line 164):

```go
// Before
func (s *Server) broadcastAll(msg *Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := make(map[*conn]bool)
	for _, set := range s.subs {
		for c := range set {
			if seen[c] {
				continue
			}
			seen[c] = true
			c.sub.enqueueControl(msg)
		}
	}
}

// After
func (s *Server) broadcastAll(msg *Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.conns {
		c.sub.enqueueControl(msg)
	}
}
```

### Step 4: Run the test to confirm it passes (GREEN)

```
go test ./internal/sessiond/... -run TestBroadcastAllReachesUnattachedConnections -v -count=1
```

Expected: **PASS**

### Step 5: Run the full package test suite

```
go test ./internal/sessiond/... -count=1
```

Expected: all existing tests still **PASS**.

### Step 6: Commit

```
git add internal/sessiond/server.go internal/sessiond/broadcast_test.go
git commit -m "fix(sessiond): broaden broadcastAll to reach all connections not just workspace subscribers

Add conns map[*conn]bool to Server tracking every live connection. Register on
accept, deregister in cleanup. Rewrite broadcastAll to iterate s.conns instead
of s.subs so unattached connections (connected but not yet attached to any
workspace) receive workspace-list broadcasts.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 2: `rename-workspace` → `broadcastAll(workspace-list)`

**Files:**
- Modify: `internal/sessiond/server.go`
- Test: `internal/sessiond/broadcast_test.go`

### Step 1: Write the failing test

Add `import "time"` to the import block in `broadcast_test.go`. Then append the new test:

```go
// TestRenameWorkspaceBroadcastsListToCrossWorkspaceClient proves that
// rename-workspace now sends workspace-list to ALL connections, including those
// attached to a different workspace. Previously it sent TypeOK to the actor +
// workspace-renamed only to subscribers of the renamed workspace, so a client
// on a different workspace saw nothing.
func TestRenameWorkspaceBroadcastsListToCrossWorkspaceClient(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// A creates ws1 and attaches to it.
	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "ws1"})
	ws1 := a.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	a.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: ws1})
	a.waitCtrl(TypeComposition)

	// B creates ws2 and attaches to it (different workspace from A).
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeCreateWorkspace, CID: 3, Name: "ws2"})
	ws2 := b.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	b.send(&Message{Type: TypeAttach, CID: 4, WorkspaceID: ws2})
	b.waitCtrl(TypeComposition)

	// A renames ws1. With old code: TypeOK to A + workspace-renamed to ws1
	// subscribers only — B (on ws2) gets nothing.
	// After fix: broadcastAll(workspace-list) reaches B with the updated name.
	a.send(&Message{Type: TypeRenameWorkspace, CID: 5, WorkspaceID: ws1, Name: "ws1-renamed"})

	// B must receive a workspace-list that includes ws1 with the new name.
	// Earlier workspace-list messages (from create broadcasts) won't have ws1 renamed;
	// keep reading until we find one that does.
	deadline := time.After(5 * time.Second)
	for {
		select {
		case msg, ok := <-b.ctrl:
			if !ok {
				t.Fatal("B: connection closed")
			}
			if msg.Type != TypeWorkspaceList {
				continue
			}
			for _, ws := range msg.Workspaces {
				if ws.WorkspaceID == ws1 && ws.Name == "ws1-renamed" {
					return // success: B received the updated workspace name
				}
			}
		case <-deadline:
			t.Fatal("timeout: B never received workspace-list with ws1 renamed to 'ws1-renamed'")
		}
	}
}
```

> **Note on `b.ctrl`:** `tClient.ctrl` is a `chan *Message` field defined in `server_integration_test.go`. Since all test files share `package sessiond`, it is accessible here.

### Step 2: Run the test to confirm it fails (RED)

```
go test ./internal/sessiond/... -run TestRenameWorkspaceBroadcastsListToCrossWorkspaceClient -v -count=1
```

Expected: **FAIL** — times out. B never receives a workspace-list with `ws1-renamed` because the current code sends workspace-scoped `workspace-renamed` (which misses B on ws2) and TypeOK (which B also doesn't receive).

### Step 3: Implement the fix in `server.go`

In `handle()`, replace the `TypeRenameWorkspace` case (~line 263):

```go
// Before
case TypeRenameWorkspace:
    if c.srv.reg.RenameWorkspace(msg.WorkspaceID, msg.Name) {
        c.reply(&Message{Type: TypeOK, CID: msg.CID, WorkspaceID: msg.WorkspaceID})
        c.srv.broadcast(msg.WorkspaceID, &Message{Type: TypeWorkspaceRenamed, WorkspaceID: msg.WorkspaceID, Name: msg.Name})
    } else {
        c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace")
    }

// After
case TypeRenameWorkspace:
    if c.srv.reg.RenameWorkspace(msg.WorkspaceID, msg.Name) {
        c.srv.broadcastAll(&Message{Type: TypeWorkspaceList, Workspaces: c.srv.reg.List()})
    } else {
        c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace")
    }
```

### Step 4: Run the test to confirm it passes (GREEN)

```
go test ./internal/sessiond/... -run TestRenameWorkspaceBroadcastsListToCrossWorkspaceClient -v -count=1
```

Expected: **PASS**

### Step 5: Run the full package test suite

```
go test ./internal/sessiond/... -count=1
```

Expected: all tests **PASS**.

> **Known follow-up (out of scope):** `client.go`'s `RenameWorkspace()` calls `request()` which blocks on a CID-matched reply. Since TypeOK is no longer sent, calling `client.go`'s `RenameWorkspace` against the updated server will block. The relay layer (`internal/server/ws.go`) will need a separate fix. Tests in `internal/server/` use `fakeDaemonConn` (a mock implementing `DaemonConn`), so `go test ./...` continues to pass. The client-side fix is Phase 2.

### Step 6: Commit

```
git add internal/sessiond/server.go internal/sessiond/broadcast_test.go
git commit -m "fix(sessiond): broadcast workspace-list on rename so all clients reconcile

Remove TypeOK reply and workspace-scoped workspace-renamed broadcast from the
rename-workspace handler. Replace with broadcastAll(workspace-list) so every
live connection — including those attached to a different workspace — receives
the updated snapshot and can reconcile without a reconnect.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 3: `close-workspace` → `broadcastAll(workspace-list)`

**Files:**
- Modify: `internal/sessiond/server.go`
- Modify: `internal/sessiond/server_integration_test.go` (update one existing test)
- Test: `internal/sessiond/broadcast_test.go`

### Step 1: Write the failing test

Append to `broadcast_test.go`:

```go
// TestCloseWorkspaceBroadcastsListToActor proves that close-workspace sends
// workspace-list to the closing connection itself. The old code sent TypeOK +
// broadcast(wsID, workspace-closed); because the workspace was scoped the actor
// had already logically detached and the event arrived to an empty subscriber
// set, causing the 5-second timeout bug on the client side.
func TestCloseWorkspaceBroadcastsListToActor(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// A creates ws1 and attaches to it.
	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "closeable"})
	wsID := a.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	a.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	// A closes the workspace it is attached to.
	a.send(&Message{Type: TypeCloseWorkspace, CID: 3, WorkspaceID: wsID})

	// A must receive workspace-list WITHOUT wsID.
	// Earlier workspace-list messages (from the create broadcast) contain wsID —
	// skip them and keep reading until one arrives that excludes it.
	// OLD behaviour: A got TypeOK + TypeWorkspaceClosed — no workspace-list ever.
	deadline := time.After(5 * time.Second)
	for {
		select {
		case msg, ok := <-a.ctrl:
			if !ok {
				t.Fatal("A: connection closed before workspace-list arrived")
			}
			if msg.Type != TypeWorkspaceList {
				continue
			}
			absent := true
			for _, ws := range msg.Workspaces {
				if ws.WorkspaceID == wsID {
					absent = false
					break
				}
			}
			if absent {
				return // success: workspace-list received without the closed workspace
			}
			// workspace-list still contains wsID (from an earlier create broadcast); keep reading
		case <-deadline:
			t.Fatal("timeout: A never received workspace-list without the closed workspace")
		}
	}
}
```

### Step 2: Run the test to confirm it fails (RED)

```
go test ./internal/sessiond/... -run TestCloseWorkspaceBroadcastsListToActor -v -count=1
```

Expected: **FAIL** — times out. A receives TypeOK and TypeWorkspaceClosed, but no TypeWorkspaceList without wsID.

### Step 3: Update `TestIntegrationFullPaneLifecycle` in `server_integration_test.go`

This existing test expects `TypeOK` + `TypeWorkspaceClosed` from close-workspace. After the fix these are gone; the test must be updated to match the new behaviour **before** it starts failing.

Find this block (~line 183):

```go
	// close-workspace => ok reply + workspace-closed broadcast, both matching id.
	c.send(&Message{Type: TypeCloseWorkspace, CID: 5, WorkspaceID: wsID})
	ok := c.waitCtrl(TypeOK)
	if ok.WorkspaceID != wsID {
		t.Fatalf("ok WorkspaceID = %q, want %q", ok.WorkspaceID, wsID)
	}
	closed := c.waitCtrl(TypeWorkspaceClosed)
	if closed.WorkspaceID != wsID {
		t.Fatalf("workspace-closed WorkspaceID = %q, want %q", closed.WorkspaceID, wsID)
	}
```

Replace it with:

```go
	// close-workspace => workspace-list broadcast excluding the closed workspace.
	c.send(&Message{Type: TypeCloseWorkspace, CID: 5, WorkspaceID: wsID})
	list := c.waitCtrl(TypeWorkspaceList)
	for _, ws := range list.Workspaces {
		if ws.WorkspaceID == wsID {
			t.Fatalf("closed workspace %q still present in workspace-list", wsID)
		}
	}
```

### Step 4: Implement the fix in `server.go`

Replace `closeWorkspace()` (~line 331):

```go
// Before
func (c *conn) closeWorkspace(msg Message) {
	panes, _, ok := c.srv.reg.CloseWorkspace(msg.WorkspaceID)
	if !ok {
		c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace")
		return
	}
	c.reply(&Message{Type: TypeOK, CID: msg.CID, WorkspaceID: msg.WorkspaceID})
	for _, p := range panes {
		p.Close()
	}
	c.srv.broadcast(msg.WorkspaceID, &Message{Type: TypeWorkspaceClosed, WorkspaceID: msg.WorkspaceID})
}

// After
func (c *conn) closeWorkspace(msg Message) {
	panes, _, ok := c.srv.reg.CloseWorkspace(msg.WorkspaceID)
	if !ok {
		c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace")
		return
	}
	for _, p := range panes {
		p.Close()
	}
	c.srv.broadcastAll(&Message{Type: TypeWorkspaceList, Workspaces: c.srv.reg.List()})
}
```

> **Why `p.Close()` before `broadcastAll`:** panes are killed first so the workspace-list snapshot (from `reg.List()`) has accurate pane counts.

### Step 5: Run the new test to confirm it passes (GREEN)

```
go test ./internal/sessiond/... -run TestCloseWorkspaceBroadcastsListToActor -v -count=1
```

Expected: **PASS**

### Step 6: Run the full package test suite

```
go test ./internal/sessiond/... -count=1
```

Expected: all tests including the updated `TestIntegrationFullPaneLifecycle` **PASS**.

### Step 7: Commit

```
git add internal/sessiond/server.go internal/sessiond/broadcast_test.go internal/sessiond/server_integration_test.go
git commit -m "fix(sessiond): broadcast workspace-list on close so all clients reconcile

Remove TypeOK reply and workspace-scoped workspace-closed broadcast from
closeWorkspace(). Replace with broadcastAll(workspace-list) so every live
connection — including the actor — receives the post-close snapshot. Update
TestIntegrationFullPaneLifecycle to expect workspace-list instead of the
removed TypeOK + TypeWorkspaceClosed pair.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 4: `handlePaneExit` Auto-Close → `broadcastAll(workspace-list)`

**Files:**
- Modify: `internal/sessiond/server.go`
- Test: `internal/sessiond/broadcast_test.go`

### Step 1: Write the failing test

Append to `broadcast_test.go`:

```go
// TestPaneExitAutoCloseBroadcastsListToAllConnections proves that when a pane
// exits and its workspace is auto-reaped (last pane left), broadcastAll sends
// the updated workspace-list to every live connection. Previously handlePaneExit
// called broadcast(wsID, workspace-closed) which only reached subscribers of
// wsID — a connection on a different workspace (or unattached) saw nothing.
func TestPaneExitAutoCloseBroadcastsListToAllConnections(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// B connects first (unattached) so it is guaranteed to be in s.conns
	// before the short-lived pane exits and triggers the auto-close.
	b := newTClient(t, socketPath)

	// A creates ws1, attaches, and spawns a pane that exits immediately.
	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "short-lived"})
	ws1 := a.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	a.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: ws1})
	a.waitCtrl(TypeComposition)
	a.send(&Message{Type: TypeCreatePane, CID: 3, Cmd: []string{"true"}})
	a.waitCtrl(TypePaneCreated)
	a.waitCtrl(TypePaneAdded)

	// B must eventually receive a workspace-list that does NOT contain ws1.
	// B may first receive a workspace-list from the create-workspace broadcast
	// (which still contains ws1); keep reading until one arrives without it.
	deadline := time.After(5 * time.Second)
	for {
		select {
		case msg, ok := <-b.ctrl:
			if !ok {
				t.Fatal("B: connection closed before auto-close workspace-list arrived")
			}
			if msg.Type != TypeWorkspaceList {
				continue
			}
			absent := true
			for _, ws := range msg.Workspaces {
				if ws.WorkspaceID == ws1 {
					absent = false
					break
				}
			}
			if absent {
				return // success: auto-close propagated to every live connection
			}
			// workspace-list still has ws1 (earlier create broadcast); keep reading
		case <-deadline:
			t.Fatal("timeout: B never received workspace-list without auto-closed ws1")
		}
	}
}
```

### Step 2: Run the test to confirm it fails (RED)

```
go test ./internal/sessiond/... -run TestPaneExitAutoCloseBroadcastsListToAllConnections -v -count=1
```

Expected: **FAIL** — times out. B (unattached to ws1) receives a workspace-list from the create broadcast (which still has ws1), but never receives the post-auto-close workspace-list because `handlePaneExit` uses the workspace-scoped `broadcast`.

### Step 3: Implement the fix in `server.go`

In `handlePaneExit()`, replace the inner `broadcast` call (~line 199):

```go
// Before
if remaining == 0 {
    if removed, _ := s.reg.ReapIfEmpty(wsID); removed {
        s.broadcast(wsID, &Message{Type: TypeWorkspaceClosed, WorkspaceID: wsID})
    }
}

// After
if remaining == 0 {
    if removed, _ := s.reg.ReapIfEmpty(wsID); removed {
        s.broadcastAll(&Message{Type: TypeWorkspaceList, Workspaces: s.reg.List()})
    }
}
```

> `TypePaneClosed` on the line above is intentionally left as a workspace-scoped `broadcast` — only subscribers of that workspace need per-pane close events. The workspace-level auto-close is what needs to reach everyone.

### Step 4: Run the new test to confirm it passes (GREEN)

```
go test ./internal/sessiond/... -run TestPaneExitAutoCloseBroadcastsListToAllConnections -v -count=1
```

Expected: **PASS**

### Step 5: Final gate — run the full repo test suite

```
cd /home/ken/workspace/muxterm
go test ./... -count=1
```

Expected: **all green**.

> If any test outside `internal/sessiond/` fails, investigate before committing. Tests in `internal/server/` use `fakeDaemonConn` (a mock) and should not be affected.

### Step 6: Commit

```
git add internal/sessiond/server.go internal/sessiond/broadcast_test.go
git commit -m "fix(sessiond): broadcast workspace-list on auto-close from pane exit

In handlePaneExit, replace broadcast(wsID, workspace-closed) with
broadcastAll(workspace-list) so every live connection receives the updated
snapshot when a workspace is auto-reaped after its last pane exits naturally.
Eliminates the scope bug where observers on different workspaces (or unattached)
missed the auto-close event entirely.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Summary of All Changes

### `internal/sessiond/server.go`

| Location | Change |
|---|---|
| `Server` struct | Add `conns map[*conn]bool` field |
| `NewServer()` | Initialize `conns: make(map[*conn]bool)` |
| `ListenAndServe()` accept loop | Add `s.conns[c] = true` under `s.mu` after `newConn` |
| `cleanup()` | Add `delete(c.srv.conns, c)` under `c.srv.mu` |
| `broadcastAll()` | Iterate `s.conns` instead of `s.subs` |
| `handle()` `TypeRenameWorkspace` case | Remove `reply(TypeOK)` + `broadcast(workspace-renamed)`; replace with `broadcastAll(workspace-list)` |
| `closeWorkspace()` | Remove `reply(TypeOK)` + `broadcast(workspace-closed)`; replace with `broadcastAll(workspace-list)` |
| `handlePaneExit()` | Change inner `broadcast(workspace-closed)` to `broadcastAll(workspace-list)` |

### `internal/sessiond/broadcast_test.go`

| Addition |
|---|
| `import "time"` |
| `TestBroadcastAllReachesUnattachedConnections` |
| `TestRenameWorkspaceBroadcastsListToCrossWorkspaceClient` |
| `TestCloseWorkspaceBroadcastsListToActor` |
| `TestPaneExitAutoCloseBroadcastsListToAllConnections` |

### `internal/sessiond/server_integration_test.go`

| Change |
|---|
| `TestIntegrationFullPaneLifecycle`: replace `waitCtrl(TypeOK)` + `waitCtrl(TypeWorkspaceClosed)` with `waitCtrl(TypeWorkspaceList)` + absence check |

### Not changed (intentionally out of scope)

- `internal/sessiond/client.go` — `RenameWorkspace()` and `CloseWorkspace()` still block on a CID-matched reply (Phase 2 plan covers this)
- `internal/server/ws.go` — relay layer; covered by Phase 2
- All TypeScript web client code
