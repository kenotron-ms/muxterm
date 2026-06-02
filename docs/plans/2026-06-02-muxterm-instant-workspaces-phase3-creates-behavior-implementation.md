# Phase 3 — Correlation-id Creates + One-Terminal Behavior Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Make workspace/pane creation feel instant by routing `createWorkspace` and `createPane` through the Phase-2 optimistic seam (settle by a client-minted correlation id echoed by the daemon), and guarantee every workspace always has exactly one terminal (auto-spawn on create / on switch-to-empty, restore on switch).

**Architecture:** A client mints a provisional **`clientRef`** string on each create and includes it in the outgoing sessiond message. The Go `sessiond` daemon **echoes that `clientRef`** back on the authoritative messages the browser already folds into base state (`workspace-list` for workspace-create; the `pane-added` event for pane-create). The browser shows the workspace/pane optimistically immediately and settles the pending mutation the instant an authoritative entity carrying its `clientRef` exists in base. One-terminal behavior is unified into a single rule: **whenever a `composition` arrives with zero panes, auto-spawn one pane** (covers new / legacy-empty / just-emptied workspaces uniformly).

**Tech Stack:** Lit + TypeScript client (`web/src/`, vitest + @open-wc/testing), Go `sessiond` daemon (`internal/sessiond/`, `go test`).

---

## ⚠️ Read this before you start — assumptions about prior phases

This is **Phase 3 of 3**. It builds on work that lands first. **Before writing any code, open these files and confirm the actual shapes**, then adapt the snippets below if names differ:

1. **Phase 1 (DONE):** the daemon already **broadcasts the updated workspace-list to clients on workspace-create** (this fixed the "new workspace doesn't appear until reload" bug), and `state.ts` base is honestly immutable (no in-place mutation; getters return copies). Phase-3's only requirement from this is: **whatever authoritative workspace-list the daemon ships after a create, it is built from `Registry.List()`** — so if `List()` carries `clientRef`, the broadcast carries it too. You do **not** need to find or change Phase-1's broadcast plumbing.

2. **Phase 2 (DONE):** `MuxStore` (`web/src/state.ts`) exposes a generalized optimistic seam. **This plan assumes the following contract — verify it against the landed code and adjust call sites if the real signature differs:**

   ```ts
   // A pending optimistic mutation.
   export interface Mutation {
     id: string; // unique key for this in-flight mutation
     // Fold the optimistic overlay onto a mutable draft of base state.
     optimistic: (draft: { workspaces: SessiondWorkspaceInfo[]; panes: SessiondPaneInfo[] }) => void;
     // Predicate against AUTHORITATIVE base (NOT the folded view). True => drop this mutation.
     settled: (base: { workspaces: SessiondWorkspaceInfo[]; panes: SessiondPaneInfo[] }) => boolean;
     onTimeout?: () => void; // mandatory protocol-failure backstop, not the happy path
   }

   // Registers a pending mutation, folds it immediately, fires _notify().
   store.mutate(m: Mutation): void;

   // After every applySessiond, settled(base) is re-evaluated; settled mutations are dropped.
   // store.workspaces / store.panes / store.composition are ALL the FOLDED getters
   // (base + every pending optimistic overlay). Readers never see split-brain.
   ```

   If Phase 2 named things differently (e.g. `addPending`, or `optimistic` takes/returns a patch object instead of mutating a draft), **keep this plan's behavior identical and only rename to match**. Do not rebuild the seam.

3. **Wire field name decision (LOCKED for this phase):** the correlation id is named **`clientRef`** on the wire (Go JSON tag `clientRef,omitempty`; TS field `clientRef?: string`). It is distinct from the existing request/reply `cid` (`CID`), which correlates a single request to its single reply and is useless for settling against an unsolicited broadcast snapshot.

4. **Pane-create echo decision (LOCKED for this phase):** the pane-create `clientRef` echo rides on the **`pane-added`** event (Go `TypePaneAdded`), NOT on `composition`. Rationale grounded in `internal/sessiond/server.go:createPane`: after spawning, the daemon broadcasts `pane-added` to all subscribers; that is the authoritative event `state.ts` folds into `_panes` for already-attached clients. `composition` is only sent on attach. We stamp `clientRef` directly onto the broadcast `pane-added` message (transient — no need to persist it on the pane).

5. **Workspace-create echo:** the `clientRef` must survive into the authoritative `workspace-list` snapshot, which is rebuilt from `Registry.List()` each time. Therefore we **store `clientRef` on the registry `Workspace`** and include it in `List()`. (Harmless: the tag is just a correlation marker; it persists but is only ever read once, at settle time.)

**TDD discipline:** every task writes the failing test first, runs it to confirm the failure, writes the minimal implementation, runs it to confirm pass, then commits. Do not batch.

**Commit footer (every commit):**
```
🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
```

**Commands you will use:**
- Single Go package test: `go test ./internal/sessiond/ -run <TestName> -v`
- Full Go suite: `go test ./...`
- Single web test file: `cd web && npx vitest run src/__tests__/<file>.test.ts`
- Full web suite: `cd web && npm test`
- Web types: `cd web && npx tsc --noEmit`
- Web build: `cd web && npx vite build`

---

## Part A — Daemon: echo `clientRef` on creates (Go)

### Task A1: Add `ClientRef` to the wire `Message` envelope

**Files:**
- Modify: `internal/sessiond/protocol.go` (the `Message` struct, ~line 127-141)
- Test: `internal/sessiond/protocol_clientref_test.go` (create)

**Step 1: Write the failing test**

Create `internal/sessiond/protocol_clientref_test.go`:

```go
package sessiond

import (
	"encoding/json"
	"testing"
)

// ClientRef is the client-minted correlation id for optimistic creates. It must
// round-trip through the JSON envelope under the frozen tag "clientRef" and be
// omitted when empty so existing golden frames are unchanged.
func TestMessageClientRefRoundTrips(t *testing.T) {
	in := &Message{Type: TypeCreateWorkspace, ClientRef: "tmp-abc123"}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got := string(raw); got != `{"type":"create-workspace","clientRef":"tmp-abc123"}` {
		t.Fatalf("marshal = %s, want clientRef tag present", got)
	}

	var out Message
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.ClientRef != "tmp-abc123" {
		t.Fatalf("ClientRef = %q, want tmp-abc123", out.ClientRef)
	}
}

func TestMessageClientRefOmittedWhenEmpty(t *testing.T) {
	raw, err := json.Marshal(&Message{Type: TypeOK})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got := string(raw); got != `{"type":"ok"}` {
		t.Fatalf("marshal = %s, want no clientRef key when empty", got)
	}
}
```

**Step 2: Run the test to verify it fails**

Run: `go test ./internal/sessiond/ -run TestMessageClientRef -v`
Expected: FAIL — `out.ClientRef undefined (type Message has no field or method ClientRef)` (compile error).

**Step 3: Write the minimal implementation**

In `internal/sessiond/protocol.go`, add the field to `Message`. Place it immediately after the `CID` field so request/reply correlation fields sit together:

```go
	CID         uint64          `json:"cid,omitempty"`         // request/reply correlation, 0 = unsolicited event
	ClientRef   string          `json:"clientRef,omitempty"`   // client-minted optimistic-create correlation id
```

**Step 4: Run the test to verify it passes**

Run: `go test ./internal/sessiond/ -run TestMessageClientRef -v`
Expected: PASS (both tests).

**Step 5: Commit**

```
git add internal/sessiond/protocol.go internal/sessiond/protocol_clientref_test.go
git commit -m "feat(sessiond): add clientRef correlation field to Message envelope

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task A2: Store `clientRef` on the registry `Workspace` and surface it in `List()`

**Files:**
- Modify: `internal/sessiond/registry.go` (`Workspace` struct ~line 11; `addWorkspaceLocked` ~line 37; `AddWorkspace` ~line 50; `List` ~line 74)
- Test: `internal/sessiond/registry_clientref_test.go` (create)

**Step 1: Write the failing test**

Create `internal/sessiond/registry_clientref_test.go`:

```go
package sessiond

import "testing"

// AddWorkspace records the client's correlation ref so the authoritative
// workspace-list snapshot can carry it back for optimistic settle.
func TestAddWorkspaceCarriesClientRefIntoList(t *testing.T) {
	r := NewRegistry()
	id := r.AddWorkspace("dev", "tmp-xyz")

	for _, w := range r.List() {
		if w.WorkspaceID == id {
			if w.ClientRef != "tmp-xyz" {
				t.Fatalf("List entry ClientRef = %q, want tmp-xyz", w.ClientRef)
			}
			return
		}
	}
	t.Fatalf("workspace %q not found in List()", id)
}

// An empty clientRef (cold-start default, recovery respawns) leaves the field
// blank — it is never required.
func TestAddWorkspaceEmptyClientRef(t *testing.T) {
	r := NewRegistry()
	id := r.AddWorkspace("", "")
	for _, w := range r.List() {
		if w.WorkspaceID == id && w.ClientRef != "" {
			t.Fatalf("ClientRef = %q, want empty", w.ClientRef)
		}
	}
}
```

**Step 2: Run the test to verify it fails**

Run: `go test ./internal/sessiond/ -run TestAddWorkspace -v`
Expected: FAIL — `too many arguments in call to r.AddWorkspace` and `w.ClientRef undefined` (compile errors).

**Step 3: Write the minimal implementation**

In `internal/sessiond/registry.go`:

(a) Add the field to `Workspace`:
```go
type Workspace struct {
	ID         string        // daemon-allocated, e.g. "w1"
	Name       string        // optional label; "" means unnamed
	ClientRef  string        // client-minted optimistic-create correlation id; "" when none
	Panes      map[int]*Pane // keyed by workspace-local pane id
	nextPaneID int
}
```

(b) Add the field to `WorkspaceInfo` in `internal/sessiond/protocol.go` (~line 144):
```go
type WorkspaceInfo struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name,omitempty"`
	ClientRef   string `json:"clientRef,omitempty"`
	PaneCount   int    `json:"paneCount"`
}
```

(c) Thread `clientRef` through `addWorkspaceLocked` and `AddWorkspace`:
```go
func (r *Registry) addWorkspaceLocked(name, clientRef string) string {
	r.nextWSID++
	id := fmt.Sprintf("w%d", r.nextWSID)
	r.workspaces[id] = &Workspace{
		ID:        id,
		Name:      name,
		ClientRef: clientRef,
		Panes:     make(map[int]*Pane),
	}
	return id
}

// AddWorkspace creates a new workspace with the given name and client
// correlation ref and returns its daemon-allocated id.
func (r *Registry) AddWorkspace(name, clientRef string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.addWorkspaceLocked(name, clientRef)
}
```

(d) Include `ClientRef` in the `List()` output (~line 79):
```go
		out = append(out, WorkspaceInfo{
			WorkspaceID: ws.ID,
			Name:        ws.Name,
			ClientRef:   ws.ClientRef,
			PaneCount:   len(ws.Panes),
		})
```

(e) **Fix the now-broken internal callers** (these have NO clientRef — pass `""`):
- `internal/sessiond/workspace.go:15` → `id := r.addWorkspaceLocked("", "")`
- `internal/sessiond/workspace.go:94` → `id := r.addWorkspaceLocked("", "")`

(f) **Fix the existing tests that call the old 1-arg signature.** Run a grep and update each `AddWorkspace("...")` call in test files to add a `""` second arg:
```
grep -rn 'AddWorkspace(' internal/sessiond/registry_test.go internal/sessiond/workspace_test.go
```
Update every match `r.AddWorkspace("x")` → `r.AddWorkspace("x", "")`.

**Step 4: Run the test to verify it passes**

Run: `go test ./internal/sessiond/ -run 'TestAddWorkspace|TestEnsureDefault' -v`
Then the whole package compiles + passes: `go test ./internal/sessiond/`
Expected: PASS.

**Step 5: Commit**

```
git add internal/sessiond/registry.go internal/sessiond/protocol.go internal/sessiond/workspace.go internal/sessiond/registry_clientref_test.go internal/sessiond/registry_test.go internal/sessiond/workspace_test.go
git commit -m "feat(sessiond): store clientRef on workspace and surface it in List()

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task A3: `create-workspace` handler threads `clientRef` into the workspace and reply

**Files:**
- Modify: `internal/sessiond/server.go` (`handle` → `TypeCreateWorkspace` case, ~line 239-241)
- Test: `internal/sessiond/server_clientref_test.go` (create)

**Step 1: Write the failing test**

Create `internal/sessiond/server_clientref_test.go`:

```go
package sessiond

import "testing"

// A create-workspace carrying a clientRef must produce a workspace whose
// authoritative list entry echoes that ref, so the browser can settle its
// optimistic row against base.
func TestCreateWorkspaceEchoesClientRefInList(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	c := newTClient(t, socketPath)
	c.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "dev", ClientRef: "tmp-ws-1"})
	created := c.waitCtrl(TypeWorkspaceCreated)
	if created.ClientRef != "tmp-ws-1" {
		t.Fatalf("workspace-created ClientRef = %q, want tmp-ws-1", created.ClientRef)
	}

	// The authoritative list snapshot must carry the ref on the new entry.
	var found bool
	for _, w := range srv.Registry().List() {
		if w.WorkspaceID == created.WorkspaceID {
			found = true
			if w.ClientRef != "tmp-ws-1" {
				t.Fatalf("List entry ClientRef = %q, want tmp-ws-1", w.ClientRef)
			}
		}
	}
	if !found {
		t.Fatalf("created workspace %q absent from List()", created.WorkspaceID)
	}
}
```

**Step 2: Run the test to verify it fails**

Run: `go test ./internal/sessiond/ -run TestCreateWorkspaceEchoesClientRef -v`
Expected: FAIL — `created.ClientRef = "", want tmp-ws-1` (handler does not yet pass/echo the ref).

**Step 3: Write the minimal implementation**

In `internal/sessiond/server.go`, update the `TypeCreateWorkspace` case (~line 239):

```go
	case TypeCreateWorkspace:
		id := c.srv.reg.AddWorkspace(msg.Name, msg.ClientRef)
		c.reply(&Message{Type: TypeWorkspaceCreated, CID: msg.CID, WorkspaceID: id, Name: msg.Name, ClientRef: msg.ClientRef})
```

> Note: Phase 1's broadcast-of-workspace-list-on-create (if present in this case body) keeps working unchanged — because `List()` now carries `clientRef`, that broadcast automatically echoes it. Do not modify Phase 1's broadcast call.

**Step 4: Run the test to verify it passes**

Run: `go test ./internal/sessiond/ -run TestCreateWorkspaceEchoesClientRef -v`
Expected: PASS.

**Step 5: Commit**

```
git add internal/sessiond/server.go internal/sessiond/server_clientref_test.go
git commit -m "feat(sessiond): echo clientRef on create-workspace into workspace + reply

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task A4: `create-pane` handler stamps `clientRef` onto the `pane-added` broadcast

**Files:**
- Modify: `internal/sessiond/server.go` (`createPane`, ~line 280-307)
- Test: `internal/sessiond/server_clientref_test.go` (append)

**Step 1: Write the failing test**

Append to `internal/sessiond/server_clientref_test.go`:

```go
// A create-pane carrying a clientRef must echo that ref on the authoritative
// pane-added broadcast, which is what already-attached browsers fold into base.
func TestCreatePaneEchoesClientRefOnPaneAdded(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	c := newTClient(t, socketPath)
	c.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "ws"})
	ws := c.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	c.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: ws})
	c.waitCtrl(TypeComposition)

	c.send(&Message{Type: TypeCreatePane, CID: 3, ClientRef: "tmp-pane-1"})
	added := c.waitCtrl(TypePaneAdded)
	if added.ClientRef != "tmp-pane-1" {
		t.Fatalf("pane-added ClientRef = %q, want tmp-pane-1", added.ClientRef)
	}
	if added.PaneID == 0 {
		t.Fatal("pane-added PaneID is 0, want a real server-assigned id")
	}
}
```

**Step 2: Run the test to verify it fails**

Run: `go test ./internal/sessiond/ -run TestCreatePaneEchoesClientRef -v`
Expected: FAIL — `pane-added ClientRef = "", want tmp-pane-1`.

**Step 3: Write the minimal implementation**

In `internal/sessiond/server.go`, in `createPane`, add `ClientRef` to the broadcast `pane-added` message (the last line of the function, ~line 306). Leave the `pane-created` reply unchanged:

```go
	c.srv.reg.PutPane(wsID, p)
	c.reply(&Message{Type: TypePaneCreated, CID: msg.CID, PaneID: localID})
	c.srv.broadcast(wsID, &Message{Type: TypePaneAdded, WorkspaceID: wsID, PaneID: localID, Cols: cols, Rows: rows, ClientRef: msg.ClientRef})
```

**Step 4: Run the test to verify it passes**

Run: `go test ./internal/sessiond/ -run TestCreatePaneEchoesClientRef -v`
Expected: PASS.

**Step 5: Commit**

```
git add internal/sessiond/server.go internal/sessiond/server_clientref_test.go
git commit -m "feat(sessiond): stamp clientRef onto pane-added broadcast on create-pane

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task A5: Go full-suite gate

**Step 1: Run the whole Go suite**

Run: `go test ./...`
Expected: PASS (all packages green). If `internal/sessiond/golden_test.go` or `bakeoff_test.go` fail on changed JSON, inspect — `clientRef,omitempty` and `ClientRef,omitempty` mean empty fields serialize identically to before, so golden frames should be unchanged. If a golden frame legitimately changed because a test now sets a clientRef, update the golden expectation and note it in the commit.

**Step 2: Commit (only if golden updates were required)**

```
git add -A
git commit -m "test(sessiond): update golden frames for clientRef field

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

If no changes were needed, skip this commit.

---

## Part B — Client: types + senders carry `clientRef`

### Task B1: Add `clientRef` to the TS protocol types

**Files:**
- Modify: `web/src/types.ts` (`SessiondMessage` ~line 70; `SessiondWorkspaceInfo` ~line 57; `SessiondPaneInfo` ~line 63)
- Test: `web/src/__tests__/protocol.types.test.ts` (append)

**Step 1: Write the failing test**

Append to `web/src/__tests__/protocol.types.test.ts` (inside the existing top-level `describe`, or add a new `describe` block — match the file's existing structure):

```ts
import { describe, it, expect } from 'vitest';
import type { SessiondMessage, SessiondWorkspaceInfo, SessiondPaneInfo } from '../types';

describe('clientRef correlation field', () => {
  it('allows clientRef on a create message', () => {
    const msg: SessiondMessage = { type: 'create-workspace', clientRef: 'tmp-1' };
    expect(msg.clientRef).toBe('tmp-1');
  });

  it('allows clientRef on a workspace info', () => {
    const ws: SessiondWorkspaceInfo = { workspaceId: 'w1', paneCount: 0, clientRef: 'tmp-1' };
    expect(ws.clientRef).toBe('tmp-1');
  });

  it('allows clientRef on a pane info', () => {
    const p: SessiondPaneInfo = { paneId: 1, cols: 80, rows: 24, clientRef: 'tmp-1' };
    expect(p.clientRef).toBe('tmp-1');
  });
});
```

> If `protocol.types.test.ts` already imports these symbols at the top, do not duplicate the import line — just add the `describe` block.

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/protocol.types.test.ts`
Expected: FAIL — type error / `clientRef does not exist` (vitest reports the TS compile failure).

**Step 3: Write the minimal implementation**

In `web/src/types.ts`:

Add to `SessiondWorkspaceInfo`:
```ts
export interface SessiondWorkspaceInfo {
  workspaceId: string;
  name?: string;
  clientRef?: string;
  paneCount: number;
}
```

Add to `SessiondPaneInfo`:
```ts
export interface SessiondPaneInfo {
  paneId: number;
  cols: number;
  rows: number;
  title?: string;
  clientRef?: string;
}
```

Add to `SessiondMessage` (place it right after `cid?`):
```ts
  cid?: number;
  clientRef?: string;
```

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/protocol.types.test.ts`
Expected: PASS.

**Step 5: Commit**

```
git add web/src/types.ts web/src/__tests__/protocol.types.test.ts
git commit -m "feat(web): add clientRef to sessiond protocol types

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task B2: `mintClientRef()` helper

**Files:**
- Create: `web/src/lib/client-ref.ts`
- Test: `web/src/__tests__/client-ref.test.ts` (create)

**Step 1: Write the failing test**

Create `web/src/__tests__/client-ref.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mintClientRef } from '../lib/client-ref.js';

describe('mintClientRef', () => {
  it('returns a non-empty string with the tmp- prefix', () => {
    const ref = mintClientRef();
    expect(typeof ref).toBe('string');
    expect(ref.startsWith('tmp-')).toBe(true);
    expect(ref.length).toBeGreaterThan(4);
  });

  it('returns a fresh unique value each call', () => {
    const refs = new Set(Array.from({ length: 100 }, () => mintClientRef()));
    expect(refs.size).toBe(100);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/client-ref.test.ts`
Expected: FAIL — cannot resolve `../lib/client-ref.js`.

**Step 3: Write the minimal implementation**

Create `web/src/lib/client-ref.ts`:

```ts
// Mints client-side correlation ids for optimistic creates. The daemon echoes
// the ref back on the authoritative message (workspace-list / pane-added) so a
// pending mutation can settle by exact identity rather than fragile counting.
//
// Uniqueness only needs to hold within a single browser session, so a monotonic
// counter combined with a random suffix is sufficient and dependency-free.

let _counter = 0;

/** Returns a fresh, session-unique correlation id, e.g. "tmp-3-k7f2a9". */
export function mintClientRef(): string {
  _counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `tmp-${_counter}-${rand}`;
}
```

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/client-ref.test.ts`
Expected: PASS.

**Step 5: Commit**

```
git add web/src/lib/client-ref.ts web/src/__tests__/client-ref.test.ts
git commit -m "feat(web): add mintClientRef helper for optimistic-create correlation

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task B3: `createWorkspace` / `createPane` senders accept and send `clientRef`

**Files:**
- Modify: `web/src/ws.ts` (`createWorkspace` ~line 85; `createPane` ~line 105)
- Test: `web/src/__tests__/ws.sessiond.test.ts` (append) — confirm this file is the home for sender tests; if senders are tested in `ws.test.ts` instead, add there to match convention.

**Step 1: Inspect the existing sender-test file to match its harness**

Run: `cd web && sed -n '1,60p' src/__tests__/ws.sessiond.test.ts`
Use whatever MockWebSocket / "decode the last sent JSON" helper it already defines. The snippet below assumes a helper that opens a socket and lets you read `JSON.parse(lastSentText)`. Adapt to the actual helper names in that file.

**Step 2: Write the failing test**

Append two tests (adapt the setup lines to the file's existing pattern for constructing an open `MuxSocket` over a `MockWebSocket` and reading the last text frame):

```ts
it('createWorkspace includes clientRef when provided', () => {
  const { mux, ws } = openSocket(); // <- use the file's existing setup helper
  mux.createWorkspace('dev', 'tmp-ws-1');
  const sent = JSON.parse(ws.sent.at(-1) as string);
  expect(sent.type).toBe('create-workspace');
  expect(sent.name).toBe('dev');
  expect(sent.clientRef).toBe('tmp-ws-1');
});

it('createPane includes clientRef when provided', () => {
  const { mux, ws } = openSocket();
  mux.createPane(undefined, 'tmp-pane-1');
  const sent = JSON.parse(ws.sent.at(-1) as string);
  expect(sent.type).toBe('create-pane');
  expect(sent.clientRef).toBe('tmp-pane-1');
});

it('createWorkspace omits clientRef when not provided', () => {
  const { mux, ws } = openSocket();
  mux.createWorkspace();
  const sent = JSON.parse(ws.sent.at(-1) as string);
  expect('clientRef' in sent).toBe(false);
});
```

**Step 3: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/ws.sessiond.test.ts`
Expected: FAIL — `createWorkspace` takes 1 arg / `sent.clientRef` is undefined.

**Step 4: Write the minimal implementation**

In `web/src/ws.ts`, update the two senders. Keep the existing "include only when truthy" discipline:

```ts
  /** Create a new workspace; name and clientRef are included only when truthy. */
  createWorkspace(name?: string, clientRef?: string): void {
    const msg: SessiondMessage = { type: SessiondType.CreateWorkspace };
    if (name) msg.name = name;
    if (clientRef) msg.clientRef = clientRef;
    this.sendSessiond(msg);
  }
```

```ts
  /**
   * Create a connection-scoped pane (NO workspaceId). cmd is included only when
   * it carries at least one argument; clientRef only when truthy.
   */
  createPane(cmd?: string[], clientRef?: string): void {
    const msg: SessiondMessage = { type: SessiondType.CreatePane };
    if (cmd && cmd.length > 0) msg.cmd = cmd;
    if (clientRef) msg.clientRef = clientRef;
    this.sendSessiond(msg);
  }
```

**Step 5: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/ws.sessiond.test.ts`
Expected: PASS.

**Step 6: Commit**

```
git add web/src/ws.ts web/src/__tests__/ws.sessiond.test.ts
git commit -m "feat(web): createWorkspace/createPane senders carry optional clientRef

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task B4: `applySessiond` threads `clientRef` from `pane-added` into base panes

**Files:**
- Modify: `web/src/state.ts` (`PaneAdded` case, ~line 75-87)
- Test: `web/src/__tests__/state.workspace.test.ts` (append) — or wherever store reconcile tests live; confirm first.

**Step 1: Write the failing test**

Append to `web/src/__tests__/state.workspace.test.ts`:

```ts
import { MuxStore } from '../state';
import { SessiondType } from '../types';

describe('clientRef threading through base', () => {
  it('workspace-list entries keep their clientRef', () => {
    const store = new MuxStore();
    store.applySessiond({
      type: SessiondType.WorkspaceList,
      workspaces: [{ workspaceId: 'w1', paneCount: 0, clientRef: 'tmp-ws-1' }],
    });
    expect(store.workspaces[0].clientRef).toBe('tmp-ws-1');
  });

  it('pane-added carries clientRef onto the base pane', () => {
    const store = new MuxStore();
    // attach first so PaneAdded is accepted (handler requires _attached != null)
    store.applySessiond({ type: SessiondType.Composition, workspaceId: 'w1', panes: [] });
    store.applySessiond({
      type: SessiondType.PaneAdded,
      paneId: 5,
      cols: 80,
      rows: 24,
      clientRef: 'tmp-pane-1',
    });
    const pane = store.panes.find((p) => p.paneId === 5);
    expect(pane?.clientRef).toBe('tmp-pane-1');
  });
});
```

> The first test passes already (WorkspaceList spreads the array, so `clientRef` survives once the type exists). It is a regression guard. The second test is the one that fails.

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/state.workspace.test.ts`
Expected: FAIL on the pane-added case — `pane?.clientRef` is `undefined` (the handler constructs an explicit object without `clientRef`).

**Step 3: Write the minimal implementation**

In `web/src/state.ts`, in the `SessiondType.PaneAdded` case, add `clientRef` to the pushed pane object (~line 80):

```ts
        this._panes.push({
          paneId,
          cols: msg.cols ?? 0,
          rows: msg.rows ?? 0,
          title: msg.title,
          clientRef: msg.clientRef,
        });
```

> Do NOT change the idempotent dedup guard (`some(p => p.paneId === paneId)`) — settle works off `clientRef` in base, but the daemon's real pane still has a real positive `paneId`, so dedup-by-paneId stays correct for the authoritative event.

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/state.workspace.test.ts`
Expected: PASS.

**Step 5: Commit**

```
git add web/src/state.ts web/src/__tests__/state.workspace.test.ts
git commit -m "feat(web): thread clientRef from pane-added into base pane state

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Part C — Wire creates through the optimistic seam

> These tasks call `store.mutate(...)`. **Re-read the Phase-2 seam contract in the assumptions box above and verify the real signature before writing.** If `optimistic`/`settled` shapes differ, keep the behavior identical and only adjust the call shape.

### Task C1: `createWorkspaceOptimistic()` on the app — optimistic row + settle by clientRef

**Files:**
- Modify: `web/src/app.ts` (add a private method; rewire the picker's `@workspace-create` handler ~line 327)
- Test: `web/src/__tests__/app.optimistic.test.ts` (create)

**Step 1: Write the failing test**

Create `web/src/__tests__/app.optimistic.test.ts`. Reuse the MockWebSocket pattern from `app.sessiond.test.ts` (copy its top-of-file mock + `fixture()` helper verbatim), then:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SessiondType } from '../types.js';
// ... (paste the MockWebSocket class + globalThis.WebSocket assignment from app.sessiond.test.ts)
import type { MuxApp } from '../app.js';
import '../app.js';
import { store } from '../state.js';

async function fixture(): Promise<MuxApp> {
  const el = document.createElement('mux-app') as MuxApp;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxApp optimistic workspace create', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    el = null as unknown as MuxApp;
  });

  it('shows a provisional workspace instantly and sends create with a clientRef', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const sendSpy = vi.spyOn(socket, 'createWorkspace');

    (el as any)._createWorkspaceOptimistic();

    // The provisional row is visible in the folded getter immediately.
    expect(store.workspaces.length).toBe(1);
    // The outgoing create carried a clientRef.
    const ref = sendSpy.mock.calls[0][1] as string;
    expect(typeof ref).toBe('string');
    expect(ref.length).toBeGreaterThan(0);

    // The authoritative list echoing that ref settles the mutation: still exactly
    // one row (the real one), not a duplicate.
    store.applySessiond({
      type: SessiondType.WorkspaceList,
      workspaces: [{ workspaceId: 'w7', paneCount: 0, clientRef: ref }],
    });
    expect(store.workspaces.length).toBe(1);
    expect(store.workspaces[0].workspaceId).toBe('w7');
  });

  it('does NOT settle when the echo carries a different clientRef', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const sendSpy = vi.spyOn(socket, 'createWorkspace');

    (el as any)._createWorkspaceOptimistic();
    const ref = sendSpy.mock.calls[0][1] as string;

    // A concurrent create from another tab lands with a DIFFERENT ref.
    store.applySessiond({
      type: SessiondType.WorkspaceList,
      workspaces: [{ workspaceId: 'w9', paneCount: 0, clientRef: 'someone-elses-ref' }],
    });

    // Our provisional row is still pending (overlay) PLUS the other tab's real
    // row => 2 rows. Our mutation has NOT settled.
    expect(store.workspaces.some((w) => w.clientRef === ref)).toBe(true);
    expect(store.workspaces.length).toBe(2);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts`
Expected: FAIL — `_createWorkspaceOptimistic is not a function`.

**Step 3: Write the minimal implementation**

In `web/src/app.ts`:

(a) Add the import near the top:
```ts
import { mintClientRef } from './lib/client-ref.js';
```

(b) Add the private method (place it near `_onCreatePane`):
```ts
  /**
   * Create a workspace with instant feedback: mint a correlation ref, overlay a
   * provisional row, fire the socket create, and settle the moment the
   * authoritative list echoes our ref. The provisional uses the ref as its
   * temporary workspaceId so the row has byte-identical layout to a real entry.
   */
  private _createWorkspaceOptimistic = (): void => {
    const ref = mintClientRef();
    store.mutate({
      id: ref,
      optimistic: (draft) => {
        draft.workspaces.push({ workspaceId: ref, paneCount: 0, clientRef: ref });
      },
      settled: (base) => base.workspaces.some((w) => w.clientRef === ref),
      onTimeout: () => {
        // Loud failure: Phase-2 marks the mutation errored (retry/dismiss row),
        // it must NEVER silently vanish. Nothing extra to do here.
      },
    });
    this._socket?.createWorkspace(undefined, ref);
  };
```

(c) Rewire the picker's create handler (~line 327) from the old inline send to the optimistic method:
```ts
            @workspace-create="${this._createWorkspaceOptimistic}"
```

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts`
Expected: PASS.

**Step 5: Commit**

```
git add web/src/app.ts web/src/__tests__/app.optimistic.test.ts
git commit -m "feat(web): route createWorkspace through optimistic seam (settle by clientRef)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task C2: `createPaneOptimistic()` on the app — optimistic pane + settle by clientRef

**Files:**
- Modify: `web/src/app.ts` (add a private method; rewire `_onCreatePane` ~line 346 and the split shortcut ~line 213)
- Test: `web/src/__tests__/app.optimistic.test.ts` (append)

**Step 1: Write the failing test**

Append to `web/src/__tests__/app.optimistic.test.ts`:

```ts
describe('MuxApp optimistic pane create', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    el = null as unknown as MuxApp;
  });

  it('shows a provisional pane instantly and settles on matching pane-added', async () => {
    el = await fixture();
    // Attach to a workspace so pane-added is accepted by the store.
    store.applySessiond({ type: SessiondType.Composition, workspaceId: 'w1', panes: [] });
    const socket = (el as any)._socket;
    const sendSpy = vi.spyOn(socket, 'createPane');

    (el as any)._createPaneOptimistic();

    // One provisional pane is visible immediately.
    expect(store.panes.length).toBe(1);
    const ref = sendSpy.mock.calls[0][1] as string;
    expect(typeof ref).toBe('string');

    // Authoritative pane-added echoing the ref settles it -> exactly one pane,
    // now carrying the REAL server paneId (not the temp negative id).
    store.applySessiond({
      type: SessiondType.PaneAdded,
      paneId: 1,
      cols: 80,
      rows: 24,
      clientRef: ref,
    });
    expect(store.panes.length).toBe(1);
    expect(store.panes[0].paneId).toBe(1);
  });

  it('does NOT settle on a pane-added with a different clientRef', async () => {
    el = await fixture();
    store.applySessiond({ type: SessiondType.Composition, workspaceId: 'w1', panes: [] });
    const socket = (el as any)._socket;
    const sendSpy = vi.spyOn(socket, 'createPane');

    (el as any)._createPaneOptimistic();
    const ref = sendSpy.mock.calls[0][1] as string;

    // A different pane (e.g. from a split in another tab) arrives.
    store.applySessiond({
      type: SessiondType.PaneAdded,
      paneId: 1,
      cols: 80,
      rows: 24,
      clientRef: 'other-ref',
    });

    // Our provisional pane is still pending (overlay) plus the real one => 2.
    expect(store.panes.some((p) => p.clientRef === ref)).toBe(true);
    expect(store.panes.length).toBe(2);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts`
Expected: FAIL — `_createPaneOptimistic is not a function`.

**Step 3: Write the minimal implementation**

In `web/src/app.ts`:

(a) Add a module-level temp-id counter near the top of the file (after the imports):
```ts
// Optimistic panes use a strictly-negative temp paneId so they never collide
// with the daemon's positive workspace-local ids. The real pane (positive id)
// replaces it when the matching pane-added settles the mutation.
let _nextTempPaneId = -1;
```

(b) Add the private method (near `_createWorkspaceOptimistic`):
```ts
  /**
   * Create a pane with instant feedback: mint a correlation ref, overlay a
   * provisional pane (temp negative id, byte-identical shape), fire the socket
   * create, and settle the moment a pane-added echoes our ref.
   */
  private _createPaneOptimistic = (): void => {
    const ref = mintClientRef();
    const tempId = _nextTempPaneId--;
    store.mutate({
      id: ref,
      optimistic: (draft) => {
        draft.panes.push({ paneId: tempId, cols: 0, rows: 0, clientRef: ref });
      },
      settled: (base) => base.panes.some((p) => p.clientRef === ref),
    });
    this._socket?.createPane(undefined, ref);
  };
```

(c) Rewire the empty-state button handler `_onCreatePane` (~line 346):
```ts
  private _onCreatePane = (): void => {
    this._createPaneOptimistic();
  };
```

(d) Rewire the split shortcut in `connectedCallback` (~line 213) — keep the hidden `split` shortcut, now optimistic:
```ts
    uiActions.split = () => this._createPaneOptimistic();
```

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts`
Expected: PASS.

**Step 5: Commit**

```
git add web/src/app.ts web/src/__tests__/app.optimistic.test.ts
git commit -m "feat(web): route createPane through optimistic seam (settle by clientRef)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Part D — One terminal per workspace (Section 2)

### Task D1: Auto-spawn one pane whenever a composition arrives with zero panes

**Files:**
- Modify: `web/src/app.ts` (the `onSessiondMessage` wiring ~line 207-210)
- Test: `web/src/__tests__/app.optimistic.test.ts` (append, new describe)

**Behavior rule (covers create / legacy-empty / just-emptied uniformly):** when a `composition` message is applied and the folded `store.panes` is empty, auto-spawn exactly one pane via `_createPaneOptimistic()`. Using the **folded** getter as the guard means an already-overlaid optimistic pane suppresses a double-spawn for free.

**Step 1: Write the failing test**

Append to `web/src/__tests__/app.optimistic.test.ts`:

```ts
describe('MuxApp one-terminal-per-workspace', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    el = null as unknown as MuxApp;
  });

  it('auto-spawns one pane when attaching a zero-pane workspace', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const sendSpy = vi.spyOn(socket, 'createPane');

    // Simulate the real inbound path: a composition with NO panes.
    (el as any)._socket.onSessiondMessage({
      type: SessiondType.Composition,
      workspaceId: 'w1',
      panes: [],
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(store.panes.length).toBe(1); // the optimistic pane
  });

  it('does NOT auto-spawn when attaching a populated workspace', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const sendSpy = vi.spyOn(socket, 'createPane');

    (el as any)._socket.onSessiondMessage({
      type: SessiondType.Composition,
      workspaceId: 'w1',
      panes: [{ paneId: 3, cols: 80, rows: 24 }],
    });

    expect(sendSpy).not.toHaveBeenCalled();
    expect(store.panes.map((p) => p.paneId)).toEqual([3]);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts`
Expected: FAIL — the first test sees `createPane` called 0 times (no auto-spawn wired yet).

**Step 3: Write the minimal implementation**

In `web/src/app.ts`, update the `onSessiondMessage` handler set in `connectedCallback` (~line 207) to auto-spawn after applying state:

```ts
    this._socket.onSessiondMessage = (msg) => {
      store.applySessiond(msg);
      this._controller?.onMessage(msg);
      // One-terminal rule: a workspace must always have at least one pane.
      // When a composition lands empty (new / legacy-empty / just-emptied),
      // auto-spawn exactly one. The FOLDED store.panes guard means an
      // already-overlaid optimistic pane suppresses a duplicate spawn.
      if (msg.type === SessiondType.Composition && store.panes.length === 0) {
        this._createPaneOptimistic();
      }
    };
```

Add the `SessiondType` import if not already present at the top of `app.ts`:
```ts
import { SessiondType } from './types.js';
```

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts`
Expected: PASS.

**Step 5: Commit**

```
git add web/src/app.ts web/src/__tests__/app.optimistic.test.ts
git commit -m "feat(web): auto-spawn one terminal on attach to a zero-pane workspace

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task D2: Switching to a populated workspace restores its active pane (no auto-spawn)

This behavior already exists via `arrangement-store` (restore active pane on switch) and Task D1's guard (no spawn when panes > 0). This task adds an explicit regression test so the "restore, don't respawn" contract is locked.

**Files:**
- Test: `web/src/__tests__/app.optimistic.test.ts` (append)
- Modify (only if the test reveals a gap): `web/src/app.ts`

**Step 1: Write the test**

Append:

```ts
describe('MuxApp switch restores, never double-spawns', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    el = null as unknown as MuxApp;
  });

  it('restores the active pane on switch to a populated workspace without spawning', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const sendSpy = vi.spyOn(socket, 'createPane');

    // Switch into a populated workspace.
    (el as any)._socket.onSessiondMessage({
      type: SessiondType.Composition,
      workspaceId: 'w2',
      panes: [
        { paneId: 10, cols: 80, rows: 24 },
        { paneId: 11, cols: 80, rows: 24 },
      ],
    });

    expect(sendSpy).not.toHaveBeenCalled();
    // The arrangement restores a real active pane from the composition.
    const arrangement = (el as any)._arrangement();
    expect(arrangement.visible).toContain(10);
  });
});
```

**Step 2: Run the test**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts`
Expected: PASS immediately (behavior already satisfied by D1 + arrangement-store). If it FAILS, the active-pane restore path needs attention — debug `_arrangement()` / `arrangement-store.load` before proceeding; do not weaken the test.

**Step 3: Commit**

```
git add web/src/__tests__/app.optimistic.test.ts
git commit -m "test(web): lock switch-restores-active-pane, no double-spawn contract

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Part E — Final gate

### Task E1: Full verification gate (all green) + final commit

**Step 1: Web type check**

Run: `cd web && npx tsc --noEmit`
Expected: no output / exit 0. Fix any type errors (most likely a missing `clientRef?` on a literal, or an out-of-date `store.mutate` call shape) before continuing.

**Step 2: Web build**

Run: `cd web && npx vite build`
Expected: build succeeds, no errors.

**Step 3: Full web test suite**

Run: `cd web && npm test`
Expected: all suites green. In particular confirm `app.sessiond.test.ts`, `ws.sessiond.test.ts`, `workspace-controller.test.ts`, and the new `app.optimistic.test.ts` / `client-ref.test.ts` / `protocol.types.test.ts` pass.

**Step 4: Full Go suite**

Run (from repo root): `go test ./...`
Expected: all packages green.

**Step 5: Final verification commit (only if any gate required a fix)**

```
git add -A
git commit -m "chore: phase 3 final verification — tsc, build, web + go suites green

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

If no fixes were needed, skip this commit — the gate is satisfied by the prior task commits.

**Do NOT push, open a PR, or merge.** Stop here and report the gate results.

---

## Appendix — Decisions & rationale (for the implementer)

- **Why `clientRef` and not reuse `cid`?** `cid` correlates one request to its one reply (a unicast). Optimistic settle must match against an **unsolicited broadcast snapshot** (`workspace-list`) or a fan-out **event** (`pane-added`) that other tabs also receive. `cid` is meaningless there; `clientRef` is a content tag the daemon stamps onto the authoritative entity, so any reader can settle by exact identity.
- **Why settle by identity, never by count?** Two fast creates or a second browser tab make "the list got longer" lie. `clientRef` makes settle exact under concurrency. The tests in C1/C2 explicitly prove a non-matching echo does NOT settle.
- **Why the `pane-added` echo (not `composition`)?** `createPane` results in a `pane-added` broadcast; that is the message already-attached browsers fold into `_panes`. `composition` only fires on attach. Grounded in `internal/sessiond/server.go:createPane`.
- **Why store `clientRef` on the registry `Workspace` but stamp it transiently on `pane-added`?** `workspace-list` is a full snapshot rebuilt from `Registry.List()`, so the ref must live on the workspace to survive into the snapshot. `pane-added` is a one-shot event, so the handler can stamp it directly from the request with no persistence.
- **Why temp NEGATIVE pane ids?** Daemon pane ids are positive workspace-local ints starting at 1. A strictly-negative optimistic id can never collide, and the real positive-id pane cleanly replaces it on settle (the Phase-2 fold drops the overlay; `_syncTerminals` prunes the temp terminal and ensures the real one — nothing is lost because a brand-new pane has no scrollback yet).
- **Failure UX is Phase-2's job.** `onTimeout` here is a no-op hook; the loud errored-row + retry/dismiss affordance was built in Phase 2. Do not add silent rollback.
