# muxterm Phase 1 — The Spine: Controller Pool + Multi-Session Switching

> **For execution:** run this with **`/execute-plan`** (subagent-driven-development workflow).

**Goal:** Refactor the single-controller tmux backend into a *pool of N control clients keyed by session name*, then wire multi-session switching so the user can flip the one visible region between attached tmux sessions.

**Architecture:** Today `cmd/muxterm/main.go` holds exactly ONE `tmux -CC` control connection in a `sessionManager`. We grow that into a `controllerPool` that is a **drop-in superset** of `sessionManager` (same active-session method surface, so the existing `controllerAdapter` and HTTP handlers barely change) plus new multi-session methods: lazily attach a control client per session, run one event-reader goroutine per attached session, dedup `%output` by global pane id `%N`, and route client actions to the right controller via a new `session` tag on the WS protocol. The UI still shows **one region at a time** — switching a session swaps which session's active window is mounted. No dock, no per-surface sizing (those are Phase 3).

**Tech Stack:** Go 1.x backend (`cmd/muxterm`, `internal/server`, `internal/tmux`); Lit v3 + xterm.js v6 frontend (`web/src`, Vite + Vitest); Playwright (`playwright-cli` skill) for E2E against the running `make dev` server.

---

## Critical context for the implementer (READ FIRST)

You know nothing about this codebase. Here are the facts you need:

- **tmux IDs are strings with sigils:** sessions `$N`, windows `@N`, panes `%N`. Pane ids are **server-global** — `%7` is the same pane no matter which session is attached. The xterm.js terminal registry on the frontend is keyed by the numeric part of `%N`, so output for a pane only needs to be written once.
- **WS protocol shape:**
  - Client → server is a one-key JSON object `{"<action>": <payload>}` (see `dispatchAction` in `internal/server/ws.go:361`).
  - Server → client is `{"<eventType>": <payload>}` (see `NewServerMsg` in `ws.go:220`), normalized on the client by `normalizeMessage` in `web/src/ws.ts:77`.
  - Terminal bytes flow as **binary** frames `[4-byte LE uint32 paneId][data]`, NOT JSON.
- **State sync is snapshot-based, never deltas.** The server coalesces tmux events and pushes one authoritative `full-sync`/`state` snapshot queried live from tmux; the client reconciles idempotently (`web/src/state.ts:68` `_reconcileFromTmux`). Do not add incremental window/pane handlers.
- **`startTmuxControl(sessionName)` in `main.go:257`** already returns exactly the signature our pool needs: `(*tmux.Controller, *os.File, chan tmux.Event, func(), error)`. We inject it into the pool in production and inject a **fake** in unit tests (no real tmux needed).
- **The inert pieces we are wiring:** `web/src/components/session-picker.ts` exists and emits a `session-selected` event but nothing opens it; `internal/server/session.go` defines `SessionListMessage`/`SessionInfo` DTOs (already round-trip-tested in `session_test.go`) but nothing populates/broadcasts them; `%sessions-changed` is parsed (`internal/tmux/control.go:170` → `SessionsChangedEvent`) but never plumbed; `internal/tmux/ensure.go:94` `ListSessionNames()` already lists sessions.
- **Dev server:** `make dev` (Vite watch + `air` Go hot-reload) serves on **`http://localhost:8080`** (confirmed in `cmd/muxterm/cli.go:24`). It is ALREADY RUNNING — do not start another.

### Scope boundaries (do NOT build these here)
- **IN:** controller pool, per-session control clients, WS `session` tag + routing, `attach-session` action, `%output` dedup by `%N`, session-list advertisement, session-picker wiring, status-bar session switcher.
- **OUT / DEFERRED:** the dock / multiple-visible-regions (Phase 3), per-surface cell-budget sizing, the verification harness internals incl. `terminalRegistry.snapshot()` (Phase 2), pop-out / chrome (Phase 4), config / polish (Phase 5), the driver application, Tier-2 `MUXTERM_CTL`, PWA/WCO, multi-viewer / mirror-follow-solo, float (cut), phone.
- **v1 invariant:** a single **browser** client (one viewer) per session view. The "pool" is N **tmux control clients** (backend↔tmux), **NOT** N browsers. Backend-client fan-out ≠ browser-client fan-out.

### Verification discipline (applies to the E2E task)
**NO OCR.** For any terminal-content assertion use `playwright-cli eval` to read the live xterm.js buffer (`term.buffer.active.getLine(y).translateToString(true)`). Prefer asserting **structural state** (active session name in the status bar, mounted window id/name) over pixels. The reusable `terminalRegistry.snapshot()` helper arrives in Phase 2 — Phase 1 reads the buffer ad-hoc.

### Storyboard
This phase implements the `switch session → session dropdown ([session ▾])` edge of the storyboard at `docs/plans/mockups/2026-05-30-muxterm-chrome/storyboard.svg`. That edge is the single E2E scenario (Task 14).

---

## Pre-flight (do once before Task 1)

**Step A — confirm the suite is green so you start from a known-good baseline.**
Run:
```
cd /Users/ken/workspace/ms/muxterm && go test ./... && (cd web && npm test)
```
Expected: Go `ok` for every package; Vitest all-pass. If anything is red BEFORE you change code, stop and report — do not start on a broken baseline.

**Step B — confirm the dev server answers.**
Run: `curl -sSI http://localhost:8080/ | head -1`
Expected: `HTTP/1.1 200 OK`. If not, ask the user to confirm `make dev` is running.

---

## Task 1: `controllerPool` core — attach / get / active (drop-in superset of `sessionManager`)

**Files:**
- Create: `cmd/muxterm/controller_pool.go`
- Create (test): `cmd/muxterm/controller_pool_test.go`

This is the heart of the phase. The pool keys live control connections by session name, exposes the SAME active-session methods `sessionManager` had (so the adapter is a near-no-op swap later), and adds multi-session methods. `attach` is injectable for testing.

**Step 1: Write the failing test.**
Create `cmd/muxterm/controller_pool_test.go`:
```go
package main

import (
	"io"
	"strings"
	"testing"

	"github.com/user/muxterm/internal/tmux"
)

// fakeAttach builds a real (but un-Run) tmux.Controller over in-memory streams,
// so pool logic can be tested without a live tmux server. It records every
// session name it was asked to attach.
func fakeAttach(t *testing.T, attached *[]string) attachFunc {
	t.Helper()
	return func(sessionName string) (*tmux.Controller, *os.File, chan tmux.Event, func(), error) {
		*attached = append(*attached, sessionName)
		events := make(chan tmux.Event, 1)
		ctrl := tmux.NewController(tmux.ControllerConfig{
			Reader: strings.NewReader(""),
			Writer: io.Discard,
			Events: events,
		})
		cleanup := func() {}
		return ctrl, nil, events, cleanup, nil
	}
}

func TestControllerPool_EnsureAttachesOncePerSession(t *testing.T) {
	var attached []string
	pool := newControllerPool(fakeAttach(t, &attached))

	tests := []struct {
		name        string
		session     string
		wantAttachN int // total attach calls AFTER this ensure
	}{
		{"first attach dev", "dev", 1},
		{"re-ensure dev is cached", "dev", 1},
		{"attach ops", "ops", 2},
		{"re-ensure ops is cached", "ops", 2},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := pool.ensure(tc.session); err != nil {
				t.Fatalf("ensure(%q): %v", tc.session, err)
			}
			if len(attached) != tc.wantAttachN {
				t.Fatalf("attach calls = %d, want %d (%v)", len(attached), tc.wantAttachN, attached)
			}
			if pool.get(tc.session) == nil {
				t.Fatalf("get(%q) = nil after ensure", tc.session)
			}
		})
	}
}

func TestControllerPool_ActiveRouting(t *testing.T) {
	var attached []string
	pool := newControllerPool(fakeAttach(t, &attached))
	if _, err := pool.ensure("dev"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.ensure("ops"); err != nil {
		t.Fatal(err)
	}

	// No active set yet -> activeController is nil, activeName empty.
	if pool.activeController() != nil {
		t.Fatal("activeController should be nil before setActive")
	}

	pool.setActive("ops")
	if got := pool.activeName(); got != "ops" {
		t.Fatalf("activeName = %q, want ops", got)
	}
	if pool.activeController() == nil {
		t.Fatal("activeController nil after setActive(ops)")
	}

	// names() returns every attached session (order-independent).
	got := map[string]bool{}
	for _, n := range pool.names() {
		got[n] = true
	}
	if !got["dev"] || !got["ops"] {
		t.Fatalf("names() = %v, want dev+ops", pool.names())
	}
}

func TestControllerPool_RememberSize(t *testing.T) {
	pool := newControllerPool(fakeAttach(t, &[]string{}))
	pool.rememberSize(120, 40)
	if c, r := pool.size(); c != 120 || r != 40 {
		t.Fatalf("size() = %d,%d want 120,40", c, r)
	}
	// Non-positive dims are ignored (matches sessionManager behavior).
	pool.rememberSize(0, 0)
	if c, r := pool.size(); c != 120 || r != 40 {
		t.Fatalf("size() after bad input = %d,%d want 120,40", c, r)
	}
}
```
Note: the test references `os.File` in the `attachFunc` signature, so add `"os"` to the test imports when you create the file (the failing compile will remind you).

**Step 2: Run the test to verify it fails.**
Run: `cd /Users/ken/workspace/ms/muxterm && go test ./cmd/muxterm/ -run TestControllerPool -v`
Expected: FAIL — `undefined: newControllerPool`, `undefined: attachFunc`.

**Step 3: Write the minimal implementation.**
Create `cmd/muxterm/controller_pool.go`:
```go
package main

import (
	"os"
	"sync"

	"github.com/user/muxterm/internal/tmux"
)

// attachFunc attaches a tmux -CC control client to the named session and
// returns the controller, its PTY, the event channel, and a cleanup func.
// startTmuxControl satisfies this signature in production; tests inject a fake.
type attachFunc func(sessionName string) (*tmux.Controller, *os.File, chan tmux.Event, func(), error)

// controllerSession bundles one live control connection.
type controllerSession struct {
	name    string
	ctrl    *tmux.Controller
	ptmx    *os.File
	events  chan tmux.Event
	cleanup func()
}

// controllerPool owns N tmux control connections, one per attached session.
// It is a superset of the old sessionManager: the active-session methods
// (controller/pty/size/rememberSize/requestRecreate) preserve today's
// single-session behavior, so the HTTP layer is unchanged for a pool of 1.
type controllerPool struct {
	mu       sync.RWMutex
	attach   attachFunc
	sessions map[string]*controllerSession
	active   string // name of the session currently shown (v1: single viewer)

	// pane ownership: %N -> session name, first-attached-wins. Used to dedup
	// %output when more than one control client observes the same pane.
	owner map[string]string

	// Last terminal size the browser reported; a freshly attached session is
	// sized to match immediately (browsers only emit resize when THEIR size
	// changes, which a server-side attach does not trigger).
	lastCols int
	lastRows int

	// recreate asks the supervisor to (re)attach when there is no session.
	recreate chan struct{}
	// switchReq asks the supervisor to attach + activate a named session.
	switchReq chan string
}

func newControllerPool(attach attachFunc) *controllerPool {
	return &controllerPool{
		attach:    attach,
		sessions:  make(map[string]*controllerSession),
		owner:     make(map[string]string),
		recreate:  make(chan struct{}, 1),
		switchReq: make(chan string, 1),
	}
}

// ensure attaches a control client for name if not already attached, and
// returns the live session. It does NOT start the event reader (the caller
// owns that, so unit tests can ensure() without spinning goroutines).
func (p *controllerPool) ensure(name string) (*controllerSession, error) {
	p.mu.Lock()
	if cs, ok := p.sessions[name]; ok {
		p.mu.Unlock()
		return cs, nil
	}
	p.mu.Unlock()

	ctrl, ptmx, events, cleanup, err := p.attach(name)
	if err != nil {
		return nil, err
	}
	cs := &controllerSession{name: name, ctrl: ctrl, ptmx: ptmx, events: events, cleanup: cleanup}

	p.mu.Lock()
	// Double-check: another goroutine may have attached while we were unlocked.
	if existing, ok := p.sessions[name]; ok {
		p.mu.Unlock()
		cleanup()
		return existing, nil
	}
	p.sessions[name] = cs
	p.mu.Unlock()
	return cs, nil
}

// get returns the live session for name, or nil if not attached.
func (p *controllerPool) get(name string) *controllerSession {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.sessions[name]
}

// remove detaches and cleans up the named session and releases its pane claims.
func (p *controllerPool) remove(name string) {
	p.mu.Lock()
	cs := p.sessions[name]
	delete(p.sessions, name)
	for pane, owner := range p.owner {
		if owner == name {
			delete(p.owner, pane)
		}
	}
	if p.active == name {
		p.active = ""
	}
	p.mu.Unlock()
	if cs != nil && cs.cleanup != nil {
		cs.cleanup()
	}
}

// names returns the names of all attached sessions.
func (p *controllerPool) names() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]string, 0, len(p.sessions))
	for n := range p.sessions {
		out = append(out, n)
	}
	return out
}

func (p *controllerPool) setActive(name string) {
	p.mu.Lock()
	p.active = name
	p.mu.Unlock()
}

func (p *controllerPool) activeName() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.active
}

// --- active-session compatibility surface (mirrors old sessionManager) ---

func (p *controllerPool) controller() *tmux.Controller {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if cs := p.sessions[p.active]; cs != nil {
		return cs.ctrl
	}
	return nil
}
func (p *controllerPool) activeController() *tmux.Controller { return p.controller() }

func (p *controllerPool) pty() *os.File {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if cs := p.sessions[p.active]; cs != nil {
		return cs.ptmx
	}
	return nil
}

func (p *controllerPool) rememberSize(cols, rows int) {
	if cols <= 0 || rows <= 0 {
		return
	}
	p.mu.Lock()
	p.lastCols, p.lastRows = cols, rows
	p.mu.Unlock()
}

func (p *controllerPool) size() (cols, rows int) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.lastCols, p.lastRows
}

func (p *controllerPool) requestRecreate() {
	select {
	case p.recreate <- struct{}{}:
	default:
	}
}

// requestSwitch asks the supervisor to attach + activate name. Non-blocking.
func (p *controllerPool) requestSwitch(name string) {
	select {
	case p.switchReq <- name:
	default:
	}
}
```

**Step 4: Run the test to verify it passes.**
Run: `cd /Users/ken/workspace/ms/muxterm && go test ./cmd/muxterm/ -run TestControllerPool -v`
Expected: PASS (`TestControllerPool_EnsureAttachesOncePerSession`, `_ActiveRouting`, `_RememberSize`).

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add cmd/muxterm/controller_pool.go cmd/muxterm/controller_pool_test.go && git commit -m "feat(pool): controllerPool core with injectable attach"
```

---

## Task 2: `%output` dedup by global pane id (`%N`)

**Files:**
- Modify: `cmd/muxterm/controller_pool.go`
- Modify (test): `cmd/muxterm/controller_pool_test.go`

When two control clients observe the same pane, the registry would receive its bytes twice (duplicated content — the exact bug class b978c7a/8ed7cef fought). We assign each `%N` to exactly one owning session (first-attached-wins) and forward output only from the owner.

**Step 1: Write the failing test.** Append to `cmd/muxterm/controller_pool_test.go`:
```go
func TestControllerPool_PaneOwnershipDedup(t *testing.T) {
	pool := newControllerPool(fakeAttach(t, &[]string{}))

	// "dev" sees %1 first -> it owns it.
	if !pool.claimPane("dev", "%1") {
		t.Fatal("dev should win first claim of %1")
	}
	if !pool.ownsPane("dev", "%1") {
		t.Fatal("dev should own %1")
	}
	// "ops" later sees the same pane -> claim is refused; ops does NOT own it.
	if pool.claimPane("ops", "%1") {
		t.Fatal("ops must NOT win an already-claimed pane")
	}
	if pool.ownsPane("ops", "%1") {
		t.Fatal("ops must not own %1")
	}
	// Distinct panes are owned by whoever claims them.
	if !pool.claimPane("ops", "%2") {
		t.Fatal("ops should win unclaimed %2")
	}

	// Removing dev releases %1 so ops can re-claim it after a re-attach.
	pool.remove("dev")
	if !pool.claimPane("ops", "%1") {
		t.Fatal("after dev removed, ops should be able to claim %1")
	}
}
```

**Step 2: Run the test to verify it fails.**
Run: `cd /Users/ken/workspace/ms/muxterm && go test ./cmd/muxterm/ -run TestControllerPool_PaneOwnershipDedup -v`
Expected: FAIL — `pool.claimPane undefined`, `pool.ownsPane undefined`.

**Step 3: Write the minimal implementation.** Append to `cmd/muxterm/controller_pool.go`:
```go
// claimPane records name as the owner of paneID on a first-come basis and
// returns true iff name owns it after the call. Subsequent claims by other
// sessions return false, so their duplicate %output can be dropped.
func (p *controllerPool) claimPane(name, paneID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if owner, ok := p.owner[paneID]; ok {
		return owner == name
	}
	p.owner[paneID] = name
	return true
}

// ownsPane reports whether name is the current owner of paneID.
func (p *controllerPool) ownsPane(name, paneID string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.owner[paneID] == name
}
```

**Step 4: Run the test to verify it passes.**
Run: `cd /Users/ken/workspace/ms/muxterm && go test ./cmd/muxterm/ -run TestControllerPool -v`
Expected: PASS (all four `TestControllerPool_*`).

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add cmd/muxterm/controller_pool.go cmd/muxterm/controller_pool_test.go && git commit -m "feat(pool): dedup %output by global pane id (first-attached-wins)"
```

---

## Task 3: Swap `sessionManager` → `controllerPool` in the adapter & boot (pool of 1 == today)

**Files:**
- Modify: `cmd/muxterm/main.go` (delete `sessionManager` type+methods `~L424-496`; repoint `controllerAdapter` field; update `runLocal ~L70`, `runServe ~L106`)

This is a mechanical swap. Because the pool exposes the same active-session method surface, the adapter's method bodies are unchanged — only the field type/name changes. We replace `superviseSession` in Task 4.

**Step 1: Write the failing test FIRST by changing the call sites, then let the compiler drive you.** There is no new unit test here — the "test" is *the whole suite still compiling and passing*. Make these edits:

1. Delete the entire `sessionManager` struct and its methods (`main.go` lines `~424` through `~496`, i.e. from `type sessionManager struct {` through the end of `func (m *sessionManager) size()`), and delete `func newSessionManager()`.

2. In `controllerAdapter`, change the field:
```go
type controllerAdapter struct {
	pool *controllerPool
}
```
3. Replace every `a.mgr` with `a.pool` inside the adapter methods. (There are ~16 occurrences; do a literal find/replace of `a.mgr.` → `a.pool.` within the adapter methods. `a.pool.controller()`, `a.pool.rememberSize(...)`, `a.pool.requestRecreate()`, `a.pool.size()` all already exist on the pool.)

4. In `runLocal` and `runServe`, replace the two construction lines:
```go
	mgr := newSessionManager()
	adapter := &controllerAdapter{mgr: mgr}
```
with:
```go
	pool := newControllerPool(startTmuxControl)
	adapter := &controllerAdapter{pool: pool}
```
5. In `runLocal`/`runServe`, the supervisor call currently reads `go superviseSession(ctx, mgr, srv.Hub(), syncer)`. Change `mgr` → `pool` for now:
```go
	go superviseSession(ctx, pool, srv.Hub(), syncer)
```
6. In `superviseSession` and `attachAndRun` signatures (`main.go ~L755`, `~L786`), change the parameter type `mgr *sessionManager` → `pool *controllerPool` and rename uses of `mgr` → `pool` in those two functions. The method calls (`pool.clear()`, `pool.set(...)`, `pool.recreate`, `pool.size()`, `pool.requestRecreate()`) must all resolve — add the two tiny compatibility methods the old supervisor used that the pool does not yet have:
```go
// set/clear keep the supervisor's existing single-session control flow working
// against the pool until Task 4 replaces the supervisor. set attaches the given
// controller as the sole active session; clear removes it.
func (p *controllerPool) set(ctrl *tmux.Controller, ptmx *os.File) {
	// superviseSession already called startTmuxControl itself; register it.
	p.mu.Lock()
	name := ctrl.State().ActiveSessionName()
	p.sessions[name] = &controllerSession{name: name, ctrl: ctrl, ptmx: ptmx}
	p.active = name
	p.mu.Unlock()
}
func (p *controllerPool) clear() {
	p.mu.Lock()
	for n := range p.sessions {
		delete(p.sessions, n)
	}
	for k := range p.owner {
		delete(p.owner, k)
	}
	p.active = ""
	p.mu.Unlock()
}
```
(Put these in `controller_pool.go`. They are throwaway shims that Task 4 deletes.)

**Step 2: Run the build + full Go suite to verify it FAILS first, then compiles.** Run:
```
cd /Users/ken/workspace/ms/muxterm && go build ./... && go test ./...
```
Expected on first attempt: compile errors pointing at any `a.mgr`/`mgr` you missed. Fix them until `go build ./...` succeeds.

**Step 3: (implementation = the edits above).** No additional code beyond the edits + shims.

**Step 4: Run the full suite to verify it passes.**
Run: `cd /Users/ken/workspace/ms/muxterm && go test ./...`
Expected: PASS for every package (behavior is byte-for-byte identical — a pool of 1).

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add cmd/muxterm/main.go cmd/muxterm/controller_pool.go && git commit -m "refactor: replace sessionManager with controllerPool (pool of 1 == today)"
```

---

## Task 4: N-session supervisor — per-session event readers + switch handling

**Files:**
- Modify: `cmd/muxterm/main.go` (replace `superviseSession`/`attachAndRun`; pass `sessionName` into `wireEvents`)
- Modify: `cmd/muxterm/controller_pool.go` (delete the `set`/`clear` shims from Task 3)

We replace the single-session supervisor with one that: ensures+activates the first session on boot, starts a reader goroutine per attached session via `ensure`, and reacts to `requestSwitch(name)` by attaching+activating the target. Each reader runs `wireEvents` and, on exit, removes its own session from the pool. `wireEvents` gains the owning session name so it can drop non-owned `%output`.

**Step 1: Write the failing test.** Add a focused unit test that proves a switch request attaches + activates the target. Append to `cmd/muxterm/controller_pool_test.go`:
```go
func TestControllerPool_SwitchActivatesTarget(t *testing.T) {
	var attached []string
	pool := newControllerPool(fakeAttach(t, &attached))

	// Simulate what supervisePool does on a switch request.
	const target = "ops"
	pool.requestSwitch(target)
	select {
	case name := <-pool.switchReq:
		if _, err := pool.ensure(name); err != nil {
			t.Fatalf("ensure(%q): %v", name, err)
		}
		pool.setActive(name)
	default:
		t.Fatal("switchReq should have a pending request")
	}

	if pool.activeName() != target {
		t.Fatalf("activeName = %q, want %q", pool.activeName(), target)
	}
	if pool.get(target) == nil {
		t.Fatalf("target %q not attached", target)
	}
}
```

**Step 2: Run it to verify it fails (or passes trivially).**
Run: `cd /Users/ken/workspace/ms/muxterm && go test ./cmd/muxterm/ -run TestControllerPool_SwitchActivatesTarget -v`
Expected: this passes against the Task-1 pool already (it only uses existing methods). That's fine — its purpose is to lock the switch contract. Now do the supervisor rewrite and keep it green.

**Step 3: Write the implementation.**

3a. In `main.go`, change `wireEvents` to take the owning session name and dedup via the pool. Replace its signature and the `OutputEvent` case:
```go
func wireEvents(sessionName string, pool *controllerPool, events <-chan tmux.Event, hub *server.Hub, ctrl *tmux.Controller, sync *stateSyncCoalescer) {
	for ev := range events {
		switch e := ev.(type) {
		case tmux.OutputEvent:
			// Dedup: forward this pane's bytes only from its owning session.
			if !pool.claimPane(sessionName, e.PaneID) {
				continue
			}
			data := stripDCS(e.Data)
			hub.BroadcastPaneOutput(e.PaneID, data)
		// ... leave every other case exactly as-is ...
```
Add a new case so `%sessions-changed` advertises the list (Task 7 fills in the broadcast; for now just trigger a state push):
```go
		case tmux.SessionsChangedEvent:
			sync.trigger()
```
Keep all existing structural cases untouched.

3b. Replace `superviseSession` and `attachAndRun` with a pool-aware supervisor:
```go
// supervisePool owns the tmux control lifecycle for the pool. On boot it
// attaches + activates the first session and starts its event reader. It then
// blocks, reacting to switch requests (attach+activate a named session) and
// recreate requests (re-attach when the pool went empty). The HTTP server
// stays up across session death.
func supervisePool(ctx context.Context, pool *controllerPool, hub *server.Hub, syncer *stateSyncCoalescer) {
	// Initial attach: pick the first available session.
	if name, err := tmux.EnsureRunning(); err == nil {
		startSession(ctx, pool, hub, syncer, name, true)
	} else {
		log.Printf("supervisor: ensure session: %v", err)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case name := <-pool.switchReq:
			startSession(ctx, pool, hub, syncer, name, true)
		case <-pool.recreate:
			if name, err := tmux.EnsureRunning(); err == nil {
				startSession(ctx, pool, hub, syncer, name, true)
			} else {
				log.Printf("supervisor: recreate ensure: %v", err)
			}
		}
	}
}

// startSession ensures a control client for name, optionally activates it, sizes
// it to the browser's last-known dims, starts its event reader, and pushes state.
// It is idempotent: ensuring an already-attached session just re-activates it.
func startSession(ctx context.Context, pool *controllerPool, hub *server.Hub, syncer *stateSyncCoalescer, name string, activate bool) {
	existing := pool.get(name) != nil
	cs, err := pool.ensure(name)
	if err != nil {
		log.Printf("supervisor: attach %q: %v", name, err)
		return
	}
	if activate {
		pool.setActive(name)
	}
	if !existing {
		if err := applyMuxtermConfig(cs.ctrl); err != nil {
			log.Printf("warn: tmux config: %v", err)
		}
		if cols, rows := pool.size(); cols > 0 && rows > 0 {
			_ = cs.ctrl.Commands().RefreshClientSize(cols, rows)
		}
		go func() {
			wireEvents(name, pool, cs.events, hub, cs.ctrl, syncer)
			// Reader exited: this session died. Drop it; if it was the last
			// one, tell clients there's no session.
			pool.remove(name)
			if len(pool.names()) == 0 {
				hub.BroadcastEvent("state", emptyTmuxState())
			} else {
				syncer.trigger()
			}
			log.Printf("supervisor: session %q ended", name)
		}()
	}
	syncer.trigger()
	log.Printf("supervisor: active session %q", name)
}
```

3c. In `runLocal` and `runServe`, change the supervisor call to:
```go
	go supervisePool(ctx, pool, srv.Hub(), syncer)
```
3d. Delete the `set`/`clear` shims you added in Task 3 from `controller_pool.go` (no longer referenced). Delete now-unused `attachAndRun`/`superviseSession`/`firstSession` if the compiler flags them as unused (Go will error on unused funcs only if they were the last reference; if `go vet`/build complains, remove them).

**Step 4: Run build + full suite to verify it passes.**
Run: `cd /Users/ken/workspace/ms/muxterm && go build ./... && go test ./...`
Expected: PASS for every package. (`wireEvents`' new first arg is covered by compilation; the switch contract by Task 4's unit test.)

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add cmd/muxterm/main.go cmd/muxterm/controller_pool.go && git commit -m "feat(pool): N-session supervisor with per-session readers + switch handling"
```

---

## Task 5: `TmuxEngine` gains `AttachSession` + `SessionList`

**Files:**
- Modify: `internal/server/ws.go` (extend the `TmuxEngine` interface ~L20)
- Modify: `cmd/muxterm/main.go` (implement both on `controllerAdapter`)
- Modify (test): `internal/server/ws_test.go` (add the two methods to `mockEngine`)

**Step 1: Write the failing test.** Add to `internal/server/ws_test.go` (new test fn; reuses the existing `mockEngine`):
```go
func TestEngineInterface_AttachAndList(t *testing.T) {
	m := newMockEngine()
	var eng TmuxEngine = m // compile-time assertion the iface is satisfied

	if err := eng.AttachSession("ops"); err != nil {
		t.Fatalf("AttachSession: %v", err)
	}
	list := eng.SessionList()
	if len(list) == 0 {
		t.Fatal("SessionList returned empty")
	}
}
```
Also add the two methods + a recorder to `mockEngine` (place near the other mock methods, ~L120):
```go
func (m *mockEngine) AttachSession(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{Method: "AttachSession", Args: []interface{}{name}})
	return nil
}
func (m *mockEngine) SessionList() []SessionInfo {
	return []SessionInfo{{Name: "dev", Windows: 1}}
}
```

**Step 2: Run it to verify it fails.**
Run: `cd /Users/ken/workspace/ms/muxterm && go test ./internal/server/ -run TestEngineInterface_AttachAndList -v`
Expected: FAIL — `eng.AttachSession undefined (type TmuxEngine has no field or method AttachSession)`.

**Step 3: Write the implementation.**

3a. In `internal/server/ws.go`, add to the `TmuxEngine` interface:
```go
	// AttachSession asks the backend to attach (if needed) and activate the
	// named tmux session as the current view.
	AttachSession(name string) error
	// SessionList returns every tmux session the user may switch to.
	SessionList() []SessionInfo
```
3b. In `cmd/muxterm/main.go`, implement them on `controllerAdapter`:
```go
func (a *controllerAdapter) AttachSession(name string) error {
	a.pool.requestSwitch(name)
	return nil
}

func (a *controllerAdapter) SessionList() []server.SessionInfo {
	names, _ := tmux.ListSessionNames()
	out := make([]server.SessionInfo, 0, len(names))
	for _, n := range names {
		windows := 0
		if cs := a.pool.get(n); cs != nil {
			windows = len(cs.ctrl.State().Sessions) // placeholder; refined below
		}
		out = append(out, server.SessionInfo{Name: n, Windows: windows})
	}
	return out
}
```
Window counts for non-attached sessions are cheap via tmux directly — make `SessionList` authoritative with one query:
```go
func (a *controllerAdapter) SessionList() []server.SessionInfo {
	out, err := exec.Command("tmux", "list-sessions",
		"-F", "#{session_name}\t#{session_windows}").Output()
	if err != nil {
		return nil
	}
	var infos []server.SessionInfo
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		n, _ := strconv.Atoi(parts[1])
		infos = append(infos, server.SessionInfo{Name: parts[0], Windows: n})
	}
	return infos
}
```
Use this second version (delete the placeholder). `SessionInfo` lives in package `server`, so the return type is `[]server.SessionInfo`. Update the interface in `ws.go` accordingly — since `SessionInfo` is defined in the same `server` package, the interface there returns `[]SessionInfo`.

**Step 4: Run it to verify it passes.**
Run: `cd /Users/ken/workspace/ms/muxterm && go build ./... && go test ./internal/server/ -run TestEngineInterface_AttachAndList -v`
Expected: PASS.

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add internal/server/ws.go cmd/muxterm/main.go internal/server/ws_test.go && git commit -m "feat(engine): AttachSession + SessionList on TmuxEngine"
```

---

## Task 6: `dispatchAction` routes the `attach-session` action

**Files:**
- Modify: `internal/server/ws.go` (`dispatchAction` ~L361)
- Modify (test): `internal/server/ws_test.go`

The client sends `{"attach-session": "ops"}`. Route it to `engine.AttachSession`.

**Step 1: Write the failing test.** Add to `internal/server/ws_test.go`:
```go
func TestDispatchAction_AttachSession(t *testing.T) {
	m := newMockEngine()
	hub := NewHub(m)

	if err := hub.dispatchAction("attach-session", json.RawMessage(`"ops"`)); err != nil {
		t.Fatalf("dispatchAction(attach-session): %v", err)
	}

	var found bool
	for _, c := range m.commandCalls {
		if c.Method == "AttachSession" && len(c.Args) == 1 && c.Args[0] == "ops" {
			found = true
		}
	}
	if !found {
		t.Fatalf("AttachSession(\"ops\") not recorded; calls=%v", m.commandCalls)
	}
}
```

**Step 2: Run it to verify it fails.**
Run: `cd /Users/ken/workspace/ms/muxterm && go test ./internal/server/ -run TestDispatchAction_AttachSession -v`
Expected: FAIL — `unknown action: attach-session`.

**Step 3: Write the implementation.** In `dispatchAction` (`ws.go`), add a case before `default:`:
```go
	case "attach-session":
		var name string
		if err := json.Unmarshal(payload, &name); err != nil {
			return fmt.Errorf("attach-session: %w", err)
		}
		return h.engine.AttachSession(name)
```

**Step 4: Run it to verify it passes.**
Run: `cd /Users/ken/workspace/ms/muxterm && go test ./internal/server/ -run TestDispatchAction_AttachSession -v`
Expected: PASS.

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add internal/server/ws.go internal/server/ws_test.go && git commit -m "feat(ws): route attach-session action to engine.AttachSession"
```

---

## Task 7: Advertise the session list (`session-list` message) on connect + `%sessions-changed`

**Files:**
- Modify: `internal/server/ws.go` (`sendStateSync` ~L266 — also push the list; add a `BroadcastSessionList` helper)
- Modify: `cmd/muxterm/main.go` (`wireEvents` `SessionsChangedEvent` case → broadcast list)
- Modify (test): `internal/server/ws_test.go`

The browser needs the list of switchable sessions to populate the picker. Send `{"session-list": {sessions:[...]}}` on connect and whenever `%sessions-changed` fires.

**Step 1: Write the failing test.** Add to `internal/server/ws_test.go`:
```go
func TestBuildSessionListMessage(t *testing.T) {
	m := newMockEngine()
	hub := NewHub(m)

	data, err := hub.sessionListJSON()
	if err != nil {
		t.Fatalf("sessionListJSON: %v", err)
	}
	var env map[string]SessionListMessage
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	msg, ok := env["session-list"]
	if !ok {
		t.Fatal("missing session-list key")
	}
	if len(msg.Sessions) == 0 || msg.Sessions[0].Name != "dev" {
		t.Fatalf("unexpected sessions: %v", msg.Sessions)
	}
}
```

**Step 2: Run it to verify it fails.**
Run: `cd /Users/ken/workspace/ms/muxterm && go test ./internal/server/ -run TestBuildSessionListMessage -v`
Expected: FAIL — `hub.sessionListJSON undefined`.

**Step 3: Write the implementation.**

3a. In `internal/server/ws.go`, add:
```go
// sessionListJSON marshals the current switchable-session list into the
// {"session-list": {...}} envelope the browser expects.
func (h *Hub) sessionListJSON() ([]byte, error) {
	if h.engine == nil {
		return nil, fmt.Errorf("no engine")
	}
	msg := SessionListMessage{Sessions: h.engine.SessionList()}
	return json.Marshal(map[string]interface{}{"session-list": msg})
}

// BroadcastSessionList pushes the switchable-session list to all clients.
func (h *Hub) BroadcastSessionList() {
	data, err := h.sessionListJSON()
	if err != nil {
		return
	}
	h.broadcastText(data)
}
```
3b. In `sendStateSync` (after the `full-sync` write, before/after the pane loop), also send the list to the just-connected client:
```go
	if data, err := h.sessionListJSON(); err == nil {
		_ = c.writeText(data)
	}
```
3c. In `cmd/muxterm/main.go` `wireEvents`, change the `SessionsChangedEvent` case to also push the list:
```go
		case tmux.SessionsChangedEvent:
			hub.BroadcastSessionList()
			sync.trigger()
```

**Step 4: Run it to verify it passes.**
Run: `cd /Users/ken/workspace/ms/muxterm && go build ./... && go test ./internal/server/ -run 'TestBuildSessionListMessage|TestSessionListMessage' -v`
Expected: PASS.

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add internal/server/ws.go cmd/muxterm/main.go internal/server/ws_test.go && git commit -m "feat(ws): advertise session-list on connect and on %sessions-changed"
```

---

## Task 8: Frontend protocol — `attach-session` client message + `session-list` server message

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/ws.ts` (encode `attach-session`; normalize `session-list`)
- Create (test): `web/src/__tests__/ws.session.test.ts`

**Step 1: Write the failing test.** Create `web/src/__tests__/ws.session.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { encodeClientMessage, normalizeMessage } from '../ws';

describe('multi-session protocol', () => {
  it('encodes attach-session to the server envelope', () => {
    const out = encodeClientMessage({ type: 'attach-session', name: 'ops' });
    expect(out).toEqual({ 'attach-session': 'ops' });
  });

  it('normalizes a session-list message', () => {
    const msg = normalizeMessage({
      'session-list': { sessions: [{ name: 'dev', windows: 2 }, { name: 'ops', windows: 1 }] },
    });
    expect(msg).toEqual({
      type: 'session-list',
      data: { sessions: [{ name: 'dev', windows: 2 }, { name: 'ops', windows: 1 }] },
    });
  });
});
```
Note: `encodeClientMessage` and `normalizeMessage` are currently module-private. As part of this task, add `export` to both `function encodeClientMessage` and `function normalizeMessage` in `web/src/ws.ts` so they are unit-testable (they have no side effects).

**Step 2: Run it to verify it fails.**
Run: `cd /Users/ken/workspace/ms/muxterm/web && npm test -- ws.session`
Expected: FAIL — import error / `encodeClientMessage is not a function` (not exported), and the `attach-session` type does not exist.

**Step 3: Write the implementation.**

3a. In `web/src/types.ts`, add to the `ClientMessage` union:
```ts
  | { type: 'attach-session'; name: string }
```
and add a `SessionInfo` + `session-list` to `ServerMessage`:
```ts
export interface SessionInfo {
  name: string;
  windows: number;
}
```
```ts
  | { type: 'session-list'; data: { sessions: SessionInfo[] } }
```
3b. In `web/src/ws.ts`:
- add `export` before `function encodeClientMessage` and `function normalizeMessage`.
- in `encodeClientMessage`'s switch, add:
```ts
    case 'attach-session':
      return { 'attach-session': msg.name };
```
- in `normalizeMessage`'s switch, add a case (the server sends lowercase `sessions`/`name`/`windows` from the Go `SessionListMessage`/`SessionInfo` JSON tags):
```ts
    case 'session-list': {
      const e = payload as { sessions?: { name: string; windows: number }[] };
      return { type: 'session-list', data: { sessions: e?.sessions ?? [] } };
    }
```

**Step 4: Run it to verify it passes.**
Run: `cd /Users/ken/workspace/ms/muxterm/web && npm test -- ws.session`
Expected: PASS (both cases).

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add web/src/types.ts web/src/ws.ts web/src/__tests__/ws.session.test.ts && git commit -m "feat(web): attach-session + session-list protocol wiring"
```

---

## Task 9: Frontend store tracks the switchable session list

**Files:**
- Modify: `web/src/state.ts` (handle `session-list`; expose `sessionList`)
- Create (test): `web/src/state.session.test.ts` → actually place in `web/src/__tests__/state.session.test.ts` to match the existing test directory convention.

**Step 1: Write the failing test.** Create `web/src/__tests__/state.session.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { MuxStore } from '../state';
import type { ServerMessage } from '../types';

describe('MuxStore session list', () => {
  it('starts with an empty session list', () => {
    expect(new MuxStore().sessionList).toEqual([]);
  });

  it('stores the advertised session list', () => {
    const store = new MuxStore();
    const msg: ServerMessage = {
      type: 'session-list',
      data: { sessions: [{ name: 'dev', windows: 2 }, { name: 'ops', windows: 1 }] },
    };
    store.applyMessage(msg);
    expect(store.sessionList.map((s) => s.name)).toEqual(['dev', 'ops']);
  });

  it('notifies subscribers when the session list arrives', () => {
    const store = new MuxStore();
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    store.applyMessage({ type: 'session-list', data: { sessions: [] } });
    expect(calls).toBe(1);
  });
});
```

**Step 2: Run it to verify it fails.**
Run: `cd /Users/ken/workspace/ms/muxterm/web && npm test -- state.session`
Expected: FAIL — `store.sessionList` is undefined.

**Step 3: Write the implementation.** In `web/src/state.ts`:
- add a private field + getter to `MuxStore`:
```ts
  private _sessionList: SessionInfo[] = [];

  get sessionList(): SessionInfo[] {
    return this._sessionList;
  }
```
- import the type at the top:
```ts
import type { ServerMessage, TmuxState, SessionInfo } from './types';
```
- add a case in `applyMessage`'s switch (before the final `_notify()`):
```ts
      case 'session-list':
        this._sessionList = msg.data.sessions;
        break;
```

**Step 4: Run it to verify it passes.**
Run: `cd /Users/ken/workspace/ms/muxterm/web && npm test -- state.session`
Expected: PASS (3 cases).

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add web/src/state.ts web/src/__tests__/state.session.test.ts && git commit -m "feat(web): MuxStore tracks switchable session list"
```

---

## Task 10: Status-bar session switcher chip

**Files:**
- Modify: `web/src/components/status-bar.ts` (clickable session chip → `open-session-picker` event)
- Modify (test): `web/src/__tests__/status-bar.test.ts`

The session chip already renders the active session name. Make it a button that fires an `open-session-picker` event so `app.ts` can show the picker. (This is the primary navigator per the design's UX section.)

**Step 1: Write the failing test.** Append to `web/src/__tests__/status-bar.test.ts`:
```ts
it('emits open-session-picker when the session chip is clicked', async () => {
  const el = document.createElement('mux-status-bar') as MuxStatusBar;
  el.sessionName = 'dev';
  document.body.appendChild(el);
  await el.updateComplete;

  let fired = 0;
  el.addEventListener('open-session-picker', () => { fired += 1; });

  const chip = el.shadowRoot!.querySelector('.session') as HTMLElement;
  expect(chip).toBeTruthy();
  chip.click();
  expect(fired).toBe(1);

  el.remove();
});
```
(Make sure `MuxStatusBar` is imported at the top of the test file — check the existing imports and add `import { MuxStatusBar } from '../components/status-bar';` if absent.)

**Step 2: Run it to verify it fails.**
Run: `cd /Users/ken/workspace/ms/muxterm/web && npm test -- status-bar`
Expected: FAIL — clicking does nothing / no `open-session-picker` event.

**Step 3: Write the implementation.** In `web/src/components/status-bar.ts`:
- make the `.session` span a button-like clickable element and wire a handler. Replace the `<span class="session">${sessionDisplay}</span>` in `render()` with:
```ts
        <span
          class="session"
          role="button"
          tabindex="0"
          title="Switch session"
          @click=${this._onSessionClick}
          >${sessionDisplay} ▾</span
        >
```
- add the handler method:
```ts
  private _onSessionClick = (): void => {
    this.dispatchEvent(
      new CustomEvent('open-session-picker', { bubbles: true, composed: true }),
    );
  };
```
- add `cursor: pointer;` to the `.session` CSS rule.

**Step 4: Run it to verify it passes.**
Run: `cd /Users/ken/workspace/ms/muxterm/web && npm test -- status-bar`
Expected: PASS (existing status-bar tests + the new one).

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add web/src/components/status-bar.ts web/src/__tests__/status-bar.test.ts && git commit -m "feat(web): clickable status-bar session chip emits open-session-picker"
```

---

## Task 11: Session-picker shows live window counts (already emits `session-selected`)

**Files:**
- Modify (test): `web/src/__tests__/session-picker.test.ts`

The picker component already renders `sessions` and emits `session-selected` with `{name}`. No code change is needed beyond confirming it consumes the `SessionInfo` shape (`{name, windows}`) we now feed it. Lock that contract with a test so a future refactor can't silently break it.

**Step 1: Write the failing test.** Append to `web/src/__tests__/session-picker.test.ts`:
```ts
it('renders each session name + window count and emits session-selected', async () => {
  const el = document.createElement('mux-session-picker') as MuxSessionPicker;
  el.sessions = [{ name: 'dev', windows: 2 }, { name: 'ops', windows: 1 }];
  document.body.appendChild(el);
  await el.updateComplete;

  const items = el.shadowRoot!.querySelectorAll('.session-item');
  expect(items.length).toBe(2);
  expect(el.shadowRoot!.textContent).toContain('dev');
  expect(el.shadowRoot!.textContent).toContain('2 windows');

  let picked = '';
  el.addEventListener('session-selected', (e) => {
    picked = (e as CustomEvent<{ name: string }>).detail.name;
  });
  (items[1] as HTMLElement).click();
  expect(picked).toBe('ops');

  el.remove();
});
```
(Add `import { MuxSessionPicker } from '../components/session-picker';` to the test file if not already present.)

**Step 2: Run it to verify it fails (or passes immediately).**
Run: `cd /Users/ken/workspace/ms/muxterm/web && npm test -- session-picker`
Expected: PASS immediately if the component already matches the contract. If it FAILS (e.g., a stale `windows`-label mismatch), fix the component's render to match, then re-run. Either way, finish with green.

**Step 3: Implementation (only if Step 2 failed).** Adjust `session-picker.ts` render minimally to satisfy the contract — do not redesign (polish is Phase 5).

**Step 4: Re-run to verify green.**
Run: `cd /Users/ken/workspace/ms/muxterm/web && npm test -- session-picker`
Expected: PASS.

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add web/src/__tests__/session-picker.test.ts web/src/components/session-picker.ts && git commit -m "test(web): lock session-picker SessionInfo contract"
```

---

## Task 12: Wire `app.ts` — open picker, send `attach-session`, feed live list

**Files:**
- Modify: `web/src/app.ts`
- Modify (test): `web/src/__tests__/app.test.ts`

Connect the dots: the store's `session-list` feeds the picker; the status-bar chip opens it; choosing a session sends `attach-session` (replacing the current ad-hoc `sendRaw` in `_onSessionSelected`).

**Step 1: Write the failing test.** Append to `web/src/__tests__/app.test.ts` (follow the file's existing setup for mounting `mux-app`; this snippet assumes a helper that returns the element — adapt to the file's existing pattern):
```ts
it('sends attach-session when a session is chosen', async () => {
  const el = document.createElement('mux-app') as any;
  document.body.appendChild(el);
  await el.updateComplete;

  const sent: any[] = [];
  el._socket = { sendControl: (m: any) => sent.push(m), connected: true };

  // Simulate the picker choosing "ops".
  el._onSessionSelected(new CustomEvent('session-selected', { detail: { name: 'ops' } }));

  expect(sent).toContainEqual({ type: 'attach-session', name: 'ops' });
  expect(el._showSessionPicker).toBe(false);

  el.remove();
});
```

**Step 2: Run it to verify it fails.**
Run: `cd /Users/ken/workspace/ms/muxterm/web && npm test -- app`
Expected: FAIL — `_onSessionSelected` currently calls `sendRaw(JSON.stringify({'attach-session': ...}))`, not `sendControl({type:'attach-session'})`, so the assertion on the typed message fails.

**Step 3: Write the implementation.** In `web/src/app.ts`:

3a. Replace `_onSessionSelected`:
```ts
  private _onSessionSelected = (e: CustomEvent<{ name: string }>): void => {
    this._showSessionPicker = false;
    this._socket?.sendControl({ type: 'attach-session', name: e.detail.name });
  };
```
3b. Open the picker from the status-bar event. Add a handler and bind it on `<mux-status-bar>`:
```ts
  private _onOpenSessionPicker = (): void => {
    this._sessions = store.sessionList;
    this._showSessionPicker = true;
  };
```
In `render()`, add the listener to the status bar element:
```ts
      <mux-status-bar
        sessionName=${this._tmuxState.activeSession}
        .windowCount=${windows.length}
        .paneCount=${activeWindow?.panes.length ?? 0}
        activeWindowName=${activeWindow?.name ?? ''}
        connectionStatus=${this._connectionStatus}
        @open-session-picker=${this._onOpenSessionPicker}
      ></mux-status-bar>
```
3c. Keep the picker populated from the store. In `_handleControlMessage`, the old code keyed off a raw `sessions` field and force-opened the picker; the list now flows through the store. Update that block so it only refreshes the cached list without auto-opening:
```ts
    if ('session-list' in msg) {
      this._sessions = store.sessionList;
    }
```
(Remove the old `if ('sessions' in msg ...) { ... this._showSessionPicker = true; }` block — the picker is now opened explicitly by the status-bar chip.)

**Step 4: Run it to verify it passes.**
Run: `cd /Users/ken/workspace/ms/muxterm/web && npm test -- app`
Expected: PASS. Then run the whole web suite to ensure nothing regressed: `cd /Users/ken/workspace/ms/muxterm/web && npm test`.

**Step 5: Commit.**
```
cd /Users/ken/workspace/ms/muxterm && git add web/src/app.ts web/src/__tests__/app.test.ts && git commit -m "feat(web): wire session picker (open from status bar, send attach-session)"
```

---

## Task 13: Full regression gate (Go + web) before E2E

**Files:** none (verification only).

**Step 1:** Run the complete unit suites.
```
cd /Users/ken/workspace/ms/muxterm && go test ./... && (cd web && npm test)
```
Expected: every Go package `ok`; Vitest all-pass.

**Step 2:** Run the project's lint/format/type gate if present.
Run: `cd /Users/ken/workspace/ms/muxterm && (make check 2>/dev/null || (cd web && npm run build))`
Expected: builds clean. If `make check` doesn't exist, the web `tsc`/Vite build must succeed with no type errors.

**Step 3 (no code):** If anything is red, fix forward in the relevant task's file, re-run, and only then proceed. Do NOT proceed to E2E with a red suite.

**Step 4:** Commit any formatting-only fixups.
```
cd /Users/ken/workspace/ms/muxterm && git add -A && git commit -m "chore: phase-1 regression gate green" || echo "nothing to commit"
```

---

## Task 14: E2E — multi-session switch (Playwright via `playwright-cli`, against running `make dev`)

**Files:** none committed (this is an interactive verification against `http://localhost:8080`). If the repo has an E2E spec dir (`.playwright-cli/`), optionally save the steps as a spec there at the end.

This proves the spine end-to-end: a second tmux session appears, the user switches to it via the wired picker, and the mounted window changes. **Use `playwright-cli` (the loaded skill). NO OCR — read structural state and the xterm buffer.**

**Step 1: Create a recognizable second tmux session (backend control client #2).**
Run:
```
tmux new-session -d -s e2e_phase1 'printf "PHASE1_MARKER_SESSION\n"; exec bash'
tmux rename-window -t e2e_phase1 e2ewin
tmux list-sessions -F '#{session_name} #{session_windows}'
```
Expected: output includes `e2e_phase1 1` (plus the default `muxterm`/`dev` session). This is your switch target.

**Step 2: Open the app and capture the BASELINE active session.**
Using `playwright-cli`:
- `navigate` to `http://localhost:8080`
- wait for the status bar to render, then `eval` the active session chip text:
```js
() => document.querySelector('mux-app').shadowRoot
        .querySelector('mux-status-bar').shadowRoot
        .querySelector('.session').textContent.trim()
```
Record this as `before` (e.g. `[dev] ▾`). Expected: a non-empty `[<name>] ▾`, NOT `e2e_phase1`.

**Step 3: Open the session picker and assert it lists the new session.**
- `click` the `.session` chip (path from Step 2) — or dispatch the click via `eval`.
- `eval` the picker's session names:
```js
() => Array.from(
  document.querySelector('mux-app').shadowRoot
    .querySelector('mux-session-picker').shadowRoot
    .querySelectorAll('.session-name')
).map(n => n.textContent.trim())
```
Expected: the array CONTAINS `e2e_phase1`. (This proves Task 7's `session-list` advertisement reached the browser.)

**Step 4: Switch to the new session and assert the active session + mounted window changed.**
- `click` the `e2e_phase1` `.session-item` (match by text).
- Poll (re-`eval`, up to ~3s) the status-bar session chip until it equals `[e2e_phase1] ▾`:
```js
() => document.querySelector('mux-app').shadowRoot
        .querySelector('mux-status-bar').shadowRoot
        .querySelector('.session').textContent.trim()
```
Expected: `after` === `[e2e_phase1] ▾` and `after !== before`. (This proves Task 6/4/3 routing: `attach-session` → `requestSwitch` → supervisor attach+activate → state push.)
- Assert the mounted window changed by reading the tab bar's window name(s):
```js
() => Array.from(
  document.querySelector('mux-app').shadowRoot
    .querySelector('mux-tab-bar').shadowRoot
    .querySelectorAll('.tab, [role="tab"]')
).map(t => t.textContent.trim()).join('|')
```
Expected: contains `e2ewin` (the window we named in Step 1).

**Step 5: Content fidelity spot-check via the xterm buffer (NO OCR).**
Confirm the new session's terminal is alive and fed. `eval` the active pane's xterm buffer text. The terminal registry is keyed by pane id; the simplest robust read is to scan all rows of the visible terminal in the DOM:
```js
() => {
  const term = document.querySelector('mux-app').shadowRoot
    .querySelector('mux-layout');
  // Find the xterm screen text via the registry-rendered DOM.
  const rows = document.querySelectorAll('.xterm-rows > div');
  return Array.from(rows).map(r => r.textContent).join('\n');
}
```
Expected: includes `PHASE1_MARKER_SESSION` (the banner we printed in Step 1), confirming the switched-to session's pane output rendered — not a blank or duplicated screen.

> If the `.xterm-rows` selector differs in this build, fall back to asserting the structural signals from Steps 3–4 (active session name + `e2ewin` tab), which are sufficient to prove the switch. Buffer read is the bonus content check; do not block on selector spelunking — record what you observed.

**Step 6: Tear down the test session and record the result.**
Run: `tmux kill-session -t e2e_phase1`
Then write a one-paragraph PASS/FAIL note (what `before`/`after` were, whether `e2ewin`/marker appeared). If the repo keeps E2E specs under `.playwright-cli/`, optionally save these steps as `multi-session-switch.spec` there and commit:
```
cd /Users/ken/workspace/ms/muxterm && git add -A && git commit -m "test(e2e): multi-session switch scenario" || echo "nothing to commit"
```

---

## Done — Phase 1 exit criteria

- `go test ./...` and `cd web && npm test` are green.
- The backend runs **N tmux control clients** (one per attached session), dedups `%output` by `%N`, advertises a `session-list`, and routes `attach-session` to attach+activate a target session.
- The user can click the status-bar session chip, see every tmux session in the picker, choose one, and watch the single visible region swap to that session's active window — verified live against `make dev` with `playwright-cli` (no OCR).
- No dock, no per-surface sizing, no pop-out/chrome/config/driver — those are Phases 2–5.

**Hand-off to Phase 2:** the pool is proven by its cheapest consumer. Phase 2 rips out OCR and adds `terminalRegistry.snapshot()` + the 3-source fidelity assertions; Phase 3 generalizes "mount one session's active window" into "mount N surfaces" (the dock), at which point the cell-budget/sizing machinery from the design's *Foundation* sections comes online.
