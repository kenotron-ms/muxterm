# muxterm Instant Workspaces — Phase 1: Foundations Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Lay the safe, independent foundations for instant workspaces: make the store's authoritative base honestly immutable, give workspaces a stable lowercase `workspace N` label, tighten the dropdown CSS, and make the Go daemon broadcast the workspace list when a workspace is created (fixing the "new workspace doesn't appear until reload" bug).

**Architecture:** A Lit + TypeScript single-page client (`web/src/`) holds state in a single observable store, `MuxStore` (`web/src/state.ts`), which folds server-pushed websocket echoes from a Go `sessiond` daemon. Phase 1 touches the store getters/reducers, one Lit component (`workspace-picker.ts`), their colocated vitest tests, and the Go daemon's create-workspace handler. No optimistic seam yet — that is Phase 2.

**Tech Stack:** Lit 3 + TypeScript + vitest (`@open-wc/testing`-style DOM fixtures) on the client; Go (`internal/sessiond/`) for the daemon, tested with the standard `testing` package over a Unix socket.

**Scope guard — this is Phase 1 of 3. Do ONLY what is listed here:**
- ✅ (a) Make the store's authoritative base honestly immutable (fix in-place `WorkspaceRenamed`; stop getters leaking internal refs).
- ✅ (b) `workspace N` lowercase, id-derived label (+ update existing tests that assert the old `Workspace w…` form).
- ✅ (c) Dropdown CSS polish (tight list, check column, fit-to-content width).
- ✅ (d) Daemon broadcasts the workspace list on create.
- ❌ NOT the optimistic-mutation seam / `pending` set / `mutate()` / rename+close wiring / failure UX (Phase 2).
- ❌ NOT correlation-id creates / one-terminal-per-workspace (Phase 3).

**Reference:** Design doc `docs/plans/2026-06-02-muxterm-instant-workspaces-design.md` (read Sections 1, 4, and the "Prerequisites" block of Section 3).

---

## Conventions (read once before starting)

**Commands (run from the indicated directory):**
- Single web test file: `cd web && npx vitest run src/__tests__/<file>.test.ts`
- Single web test by name: `cd web && npx vitest run src/__tests__/<file>.test.ts -t "<test name>"`
- Full web test suite: `cd web && npm test`
- Web type-check: `cd web && npx tsc --noEmit`
- Web production build: `cd web && npx vite build`
- Go tests (repo root): `go test ./...`
- Single Go package: `go test ./internal/sessiond/`

**Every commit message** uses a conventional-commit subject and ends with this exact footer (blank line, then the two lines):

```
🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
```

**Do NOT** push, open a PR, or merge. Commit locally only.

---

## Task 1 — Make `MuxStore` getters non-leaking (immutable base, part 1)

**Files:**
- Test (create): `web/src/__tests__/state.immutable.test.ts`
- Modify: `web/src/state.ts` (getters at lines 31-41)

### Step 1: Write the failing test

Create `web/src/__tests__/state.immutable.test.ts` with exactly this content:

```ts
import { describe, it, expect } from 'vitest';
import { MuxStore } from '../state';
import { SessiondType } from '../types';

function seeded(): MuxStore {
  const store = new MuxStore();
  store.applySessiond({
    type: SessiondType.WorkspaceList,
    workspaces: [
      { workspaceId: 'w1', name: 'one', paneCount: 1 },
      { workspaceId: 'w2', paneCount: 2 },
    ],
  });
  store.applySessiond({
    type: SessiondType.Composition,
    workspaceId: 'w1',
    panes: [{ paneId: 1, cols: 80, rows: 24, title: 'shell' }],
  });
  return store;
}

describe('MuxStore base immutability', () => {
  it('does not leak the internal workspaces array (push is isolated)', () => {
    const store = seeded();
    store.workspaces.push({ workspaceId: 'w3', paneCount: 0 });
    expect(store.workspaces.length).toBe(2);
  });

  it('does not leak internal workspace objects (mutation is isolated)', () => {
    const store = seeded();
    store.workspaces[0].name = 'HACKED';
    expect(store.workspaces[0].name).toBe('one');
  });

  it('does not leak the internal panes array (push is isolated)', () => {
    const store = seeded();
    store.panes.push({ paneId: 99, cols: 1, rows: 1 });
    expect(store.panes.length).toBe(1);
  });

  it('does not leak internal pane objects (mutation is isolated)', () => {
    const store = seeded();
    store.panes[0].title = 'HACKED';
    expect(store.panes[0].title).toBe('shell');
  });
});
```

### Step 2: Run the test to verify it fails

Run: `cd web && npx vitest run src/__tests__/state.immutable.test.ts`

Expected: FAIL. The getters currently return the private arrays by reference, so the `push`/mutation leaks into store state (e.g. `length` becomes `3`, name becomes `'HACKED'`).

### Step 3: Write the minimal implementation

In `web/src/state.ts`, replace the `workspaces` getter (lines 31-33) and the `panes` getter (lines 39-41) so they return fresh shallow copies instead of the internal arrays.

Replace:

```ts
  get workspaces(): SessiondWorkspaceInfo[] {
    return this._workspaces;
  }
```

with:

```ts
  get workspaces(): SessiondWorkspaceInfo[] {
    // Return a fresh array of shallow-copied objects so callers can never
    // mutate the authoritative base. This invariant is what later phases'
    // optimistic overlay relies on.
    return this._workspaces.map((w) => ({ ...w }));
  }
```

Replace:

```ts
  get panes(): SessiondPaneInfo[] {
    return this._panes;
  }
```

with:

```ts
  get panes(): SessiondPaneInfo[] {
    // Fresh array of shallow copies — base is never handed out by reference.
    return this._panes.map((p) => ({ ...p }));
  }
```

### Step 4: Run the test to verify it passes

Run: `cd web && npx vitest run src/__tests__/state.immutable.test.ts`

Expected: PASS (4 passing).

### Step 5: Commit

```
cd .. && git add web/src/state.ts web/src/__tests__/state.immutable.test.ts && git commit -m "$(cat <<'EOF'
refactor(web): stop MuxStore getters leaking the authoritative base

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 2 — Apply `WorkspaceRenamed` immutably (immutable base, part 2)

**Files:**
- Test (modify): `web/src/__tests__/state.immutable.test.ts`
- Modify: `web/src/state.ts` (`WorkspaceRenamed` case, lines 113-119)

### Step 1: Write the failing test

In `web/src/__tests__/state.immutable.test.ts`, add this test **inside** the existing `describe('MuxStore base immutability', ...)` block, just before its closing `});`:

```ts
  it('applies WorkspaceRenamed immutably without mutating prior snapshots', () => {
    const store = seeded();
    const before = store.workspaces;
    store.applySessiond({
      type: SessiondType.WorkspaceRenamed,
      workspaceId: 'w1',
      name: 'renamed',
    });
    const after = store.workspaces;
    expect(after).not.toBe(before);
    expect(after.find((w) => w.workspaceId === 'w1')?.name).toBe('renamed');
    // The snapshot taken BEFORE the rename must be untouched.
    expect(before.find((w) => w.workspaceId === 'w1')?.name).toBe('one');
  });
```

### Step 2: Run the test to verify it fails

Run: `cd web && npx vitest run src/__tests__/state.immutable.test.ts -t "applies WorkspaceRenamed immutably"`

Expected: FAIL. The current `WorkspaceRenamed` case mutates the workspace object **in place** (`ws.name = …`), so the pre-rename `before` snapshot's object is mutated too — `before.find(...).name` becomes `'renamed'` instead of `'one'`.

(Note: this passes only after BOTH the getter copy from Task 1 and the immutable reducer below are in place.)

### Step 3: Write the minimal implementation

In `web/src/state.ts`, replace the `WorkspaceRenamed` case (lines 113-119):

```ts
      case SessiondType.WorkspaceRenamed: {
        const ws = this._workspaces.find((w) => w.workspaceId === msg.workspaceId);
        if (ws) {
          ws.name = msg.name ? msg.name : undefined;
        }
        break;
      }
```

with:

```ts
      case SessiondType.WorkspaceRenamed: {
        // Immutable rebuild: never mutate an existing workspace object in
        // place, so previously-handed-out snapshots stay frozen.
        this._workspaces = this._workspaces.map((w) =>
          w.workspaceId === msg.workspaceId
            ? { ...w, name: msg.name ? msg.name : undefined }
            : w,
        );
        break;
      }
```

### Step 4: Run the tests to verify they pass

Run: `cd web && npx vitest run src/__tests__/state.immutable.test.ts`

Expected: PASS (5 passing).

Then confirm no rename regression elsewhere:

Run: `cd web && npx vitest run src/__tests__/state.workspace.test.ts`

Expected: PASS (all green — the existing `store.workspaces[0].name` assertions still hold).

### Step 5: Commit

```
cd .. && git add web/src/state.ts web/src/__tests__/state.immutable.test.ts && git commit -m "$(cat <<'EOF'
fix(web): apply WorkspaceRenamed immutably instead of in-place mutation

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 3 — `workspaceLabel()` returns lowercase, id-derived `workspace N`

**Files:**
- Test (modify): `web/src/__tests__/workspace-picker.test.ts` (the `workspaceLabel helper` describe block, lines 164-170)
- Modify: `web/src/components/workspace-picker.ts` (function at lines 11-13)

### Step 1: Write the failing test

In `web/src/__tests__/workspace-picker.test.ts`, replace the entire `workspaceLabel helper` describe block (lines 164-170):

```ts
describe('workspaceLabel helper', () => {
  it('returns the name when present, else a stable id fallback', () => {
    expect(workspaceLabel({ workspaceId: 'ws-9', name: 'alpha', paneCount: 0 })).toBe('alpha');
    expect(workspaceLabel({ workspaceId: 'ws-9', name: '', paneCount: 0 })).toBe('Workspace ws-9');
    expect(workspaceLabel({ workspaceId: 'ws-9', paneCount: 0 })).toBe('Workspace ws-9');
  });
});
```

with:

```ts
describe('workspaceLabel helper', () => {
  it('returns the explicit name when present', () => {
    expect(workspaceLabel({ workspaceId: 'ws-9', name: 'alpha', paneCount: 0 })).toBe('alpha');
  });

  it('falls back to a lowercase, id-derived "workspace N" label', () => {
    expect(workspaceLabel({ workspaceId: 'w3', name: undefined, paneCount: 0 })).toBe('workspace 3');
    expect(workspaceLabel({ workspaceId: 'ws-9', name: '', paneCount: 0 })).toBe('workspace 9');
    expect(workspaceLabel({ workspaceId: 'w12', paneCount: 0 })).toBe('workspace 12');
  });

  it('uses the raw id when it contains no digits', () => {
    expect(workspaceLabel({ workspaceId: 'main', paneCount: 0 })).toBe('workspace main');
  });
});
```

### Step 2: Run the test to verify it fails

Run: `cd web && npx vitest run src/__tests__/workspace-picker.test.ts -t "workspaceLabel"`

Expected: FAIL. The current helper returns `Workspace ${ws.workspaceId}` (capitalized, raw id), so `workspace 3` / `workspace 9` assertions fail.

### Step 3: Write the minimal implementation

In `web/src/components/workspace-picker.ts`, replace the `workspaceLabel` function (lines 7-13):

```ts
/**
 * Human-readable label for a workspace: prefer the explicit name, otherwise
 * fall back to a stable id-based label.
 */
export function workspaceLabel(ws: SessiondWorkspaceInfo): string {
  return ws.name && ws.name.length > 0 ? ws.name : `Workspace ${ws.workspaceId}`;
}
```

with:

```ts
/**
 * Human-readable label for a workspace: prefer the explicit name, otherwise
 * fall back to a stable, lowercase, id-derived "workspace N" label. N is the
 * numeric part of the workspace id (w3 -> "workspace 3", ws-9 -> "workspace 9"),
 * so the label never renumbers when another workspace closes. Ids with no digit
 * fall back to the raw id.
 */
export function workspaceLabel(ws: SessiondWorkspaceInfo): string {
  if (ws.name && ws.name.length > 0) return ws.name;
  const n = ws.workspaceId.replace(/\D/g, '');
  return `workspace ${n || ws.workspaceId}`;
}
```

### Step 4: Run the test to verify it passes

Run: `cd web && npx vitest run src/__tests__/workspace-picker.test.ts -t "workspaceLabel"`

Expected: PASS (3 passing in that describe block).

### Step 5: Commit

```
cd .. && git add web/src/components/workspace-picker.ts web/src/__tests__/workspace-picker.test.ts && git commit -m "$(cat <<'EOF'
feat(web): derive a stable lowercase "workspace N" label from the id

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 4 — Update remaining tests that assert the old `Workspace …` label

**Context:** Changing the fallback label breaks two component tests that asserted the old capitalized form. Fix them to the new lowercase, id-derived form.

**Files:**
- Modify: `web/src/__tests__/workspace-picker.test.ts` (lines 64-70 and 80-85)
- Modify: `web/src/__tests__/status-bar.test.ts` (the unnamed-fallback test, ~lines 51-58)

### Step 1: Find every stale assertion

Run: `cd web && grep -rn "Workspace ws\|Workspace w\|toContain('w2')\|toContain(\"w2\")" src/__tests__/`

Expected output (your audit list): matches in `workspace-picker.test.ts` (lines ~69, ~84) and `status-bar.test.ts` (the unnamed-fallback test). If grep surfaces any **other** file, update it the same way in this task.

### Step 2: Update `workspace-picker.test.ts`

In `web/src/__tests__/workspace-picker.test.ts`, the fixture uses workspace ids `ws-1`, `ws-2`, `ws-3` (see `makeWorkspaces`, lines 6-12). The unnamed one is `ws-2` → new label `workspace 2`.

Replace (in the `labels unnamed workspaces by stable id fallback` test, ~line 69):

```ts
    expect(names[1]).toBe('Workspace ws-2');
```

with:

```ts
    expect(names[1]).toBe('workspace 2');
```

Replace (in the `marks the current workspace with .sel` test, ~line 84):

```ts
    expect(sel[0].querySelector('.ws-name')?.textContent).toBe('Workspace ws-2');
```

with:

```ts
    expect(sel[0].querySelector('.ws-name')?.textContent).toBe('workspace 2');
```

### Step 3: Update `status-bar.test.ts`

In `web/src/__tests__/status-bar.test.ts`, the unnamed-fallback test uses `workspaceId: 'w2'` → new label `workspace 2`. Replace:

```ts
    expect(chip!.textContent).toContain('w2');
```

with:

```ts
    expect(chip!.textContent).toContain('workspace 2');
```

### Step 4: Run both files to verify they pass

Run: `cd web && npx vitest run src/__tests__/workspace-picker.test.ts src/__tests__/status-bar.test.ts`

Expected: PASS (both files fully green).

### Step 5: Verify the full suite is green (catches any missed file)

Run: `cd web && npm test`

Expected: PASS (entire suite green). If any test still asserts an old `Workspace …` label, update it to the new lowercase form and re-run before committing.

### Step 6: Commit

```
cd .. && git add web/src/__tests__/workspace-picker.test.ts web/src/__tests__/status-bar.test.ts && git commit -m "$(cat <<'EOF'
test(web): assert the new lowercase "workspace N" label form

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 5 — Add a per-row check column (`.ws-check`) to the dropdown

**Context:** Today the check uses a `.ck` span that is empty (collapses) when a row is not current, so labels don't align. We rename it to `.ws-check`, always render the column (reserving space), and put the `✓` only on the current row. This is the structural half of the CSS polish; Task 6 does the pure-CSS tightening.

**Files:**
- Test (modify): `web/src/__tests__/workspace-picker.test.ts` (add a test inside the `MuxWorkspacePicker` describe block)
- Modify: `web/src/components/workspace-picker.ts` (render at line 203; style `.ck` at lines 91-97)

### Step 1: Write the failing test

In `web/src/__tests__/workspace-picker.test.ts`, add this test inside the `describe('MuxWorkspacePicker', ...)` block (e.g. right after the `renders one .ws-item row per workspace` test, ~line 45):

```ts
  it('renders a .ws-check column for every row, reserving space when not current', async () => {
    el = await fixture(makeWorkspaces(), 'ws-2');
    const checks = el.shadowRoot!.querySelectorAll('.ws-check');
    expect(checks.length).toBe(3);
    // Only the current workspace (ws-2, index 1) shows a check glyph; the
    // others render an empty-but-present column so labels stay aligned.
    expect(checks[0].querySelector('svg')).toBeNull();
    expect(checks[1].querySelector('svg')).not.toBeNull();
  });
```

### Step 2: Run the test to verify it fails

Run: `cd web && npx vitest run src/__tests__/workspace-picker.test.ts -t "renders a .ws-check column"`

Expected: FAIL. There is no `.ws-check` element today (the class is `.ck`), so `querySelectorAll('.ws-check').length` is `0`.

### Step 3: Write the minimal implementation

In `web/src/components/workspace-picker.ts`:

(a) In `render()`, replace the check span (line 203):

```ts
                    <span class="ck">${current ? icon(Check, { size: 12 }) : ''}</span>
```

with:

```ts
                    <span class="ws-check">${current ? icon(Check, { size: 12 }) : ''}</span>
```

(b) In `static styles`, replace the `.ck` rule (lines 91-97):

```ts
    .ck {
      width: 14px;
      flex-shrink: 0;
      color: #9ece6a;
      display: flex;
      align-items: center;
    }
```

with:

```ts
    .ws-check {
      width: 16px;
      flex-shrink: 0;
      color: #9ece6a;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
```

### Step 4: Run the test to verify it passes

Run: `cd web && npx vitest run src/__tests__/workspace-picker.test.ts`

Expected: PASS (whole file green, including the new check-column test).

### Step 5: Commit

```
cd .. && git add web/src/components/workspace-picker.ts web/src/__tests__/workspace-picker.test.ts && git commit -m "$(cat <<'EOF'
feat(web): give each picker row a reserved .ws-check column for alignment

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 6 — Tighten the dropdown CSS (compact list, hover actions, fit-to-content width)

**Context:** Pure CSS. Turn the card-stack into a compact menu: drop the per-row border/large radius, shrink padding/gap, emphasize the rename/remove actions only on hover, and make the picker fit-to-content with a sensible min/max width + ellipsis. Behavior and DOM structure are unchanged, so the existing picker tests stay the regression guard.

**Files:**
- Modify: `web/src/components/workspace-picker.ts` (`static styles` block)

### Step 1: Confirm the regression guard is currently green

Run: `cd web && npx vitest run src/__tests__/workspace-picker.test.ts`

Expected: PASS. (This is the safety net for a CSS-only change; there is no new unit test for pixel styling.)

### Step 2: Apply the CSS changes

In `web/src/components/workspace-picker.ts`, make the following replacements inside `static styles`.

(a) Tighten the picker container — replace the `.picker` rule (lines 29-39):

```ts
    .picker {
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 8px;
      padding: 16px;
      min-width: 280px;
      max-width: 420px;
      max-height: 70vh;
      overflow-y: auto;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }
```

with:

```ts
    .picker {
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 8px;
      padding: 8px;
      /* Fit-to-content: grow to the longest label, never cramped, never blow
         out the layout. */
      width: max-content;
      min-width: 220px;
      max-width: 360px;
      max-height: 70vh;
      overflow-y: auto;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }
```

(b) Shrink the heading — replace the `h2` rule (lines 41-46):

```ts
    h2 {
      margin: 0 0 16px 0;
      color: #cdd6f4;
      font-size: 18px;
      font-weight: 600;
    }
```

with:

```ts
    h2 {
      margin: 4px 8px 8px;
      color: #6c7086;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
```

(c) Tighten the list spacing — replace the `.ws-list` rule (lines 48-52):

```ts
    .ws-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
```

with:

```ts
    .ws-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
```

(d) De-card the rows — replace the `.ws-item`, `.ws-item:hover`, and `.ws-item.sel` rules (lines 54-75):

```ts
    .ws-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 12px 16px;
      background: #181825;
      border: 1px solid #45475a;
      border-radius: 6px;
      color: #cdd6f4;
      font-size: 14px;
      transition: border-color 0.15s;
    }

    .ws-item:hover {
      border-color: #89b4fa;
    }

    .ws-item.sel {
      border-color: #89b4fa;
      background: #283457;
    }
```

with:

```ts
    .ws-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 8px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: #cdd6f4;
      font-size: 14px;
      transition: background-color 0.12s;
    }

    .ws-item:hover {
      background: #2a2b3c;
    }

    .ws-item.sel {
      background: #283457;
    }
```

(e) Make labels truncate past max width — replace the `.ws-name` rule (lines 99-102):

```ts
    .ws-name {
      font-weight: 600;
      flex: 1;
    }
```

with:

```ts
    .ws-name {
      font-weight: 500;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
```

(f) Reveal the row actions on hover — replace the `.row-action` and `.row-action:hover` rules (lines 109-125):

```ts
    .row-action {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      border: none;
      background: transparent;
      color: #6c7086;
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
    }

    .row-action:hover {
      background: #313244;
      color: #cdd6f4;
    }
```

with:

```ts
    .row-action {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      border: none;
      background: transparent;
      color: #6c7086;
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      opacity: 0;
      transition: opacity 0.12s, color 0.12s, background-color 0.12s;
    }

    .ws-item:hover .row-action,
    .ws-item.sel .row-action {
      opacity: 1;
    }

    .row-action:hover {
      background: #45475a;
      color: #cdd6f4;
    }
```

### Step 3: Verify structure/behavior tests still pass

Run: `cd web && npx vitest run src/__tests__/workspace-picker.test.ts`

Expected: PASS (DOM structure and events unchanged — CSS-only edit).

### Step 4: Verify the build compiles the styles

Run: `cd web && npx vite build`

Expected: build completes with no errors (exit 0).

### Step 5: Commit

```
cd .. && git add web/src/components/workspace-picker.ts && git commit -m "$(cat <<'EOF'
style(web): tighten workspace dropdown into a compact fit-to-content menu

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 7 — Daemon: add a `broadcastAll` fan-out helper

**Context:** `s.broadcast(wsID, msg)` only reaches subscribers attached to one workspace. A "workspace list changed" event is global — it must reach every attached connection. Add a `broadcastAll` helper (deduping connections that appear under multiple workspace sets). This task adds the helper + test only; Task 8 wires it into the create handler.

**Files:**
- Test (create): `internal/sessiond/broadcast_test.go`
- Modify: `internal/sessiond/server.go` (add method next to `broadcast`, ~line 151)

### Step 1: Write the failing test

Create `internal/sessiond/broadcast_test.go` with exactly this content. The test lives in the `sessiond` package, so it can call the unexported `broadcastAll` directly:

```go
package sessiond

import "testing"

// TestBroadcastAllExistsAndIsSafeWithNoSubs verifies the global fan-out helper
// exists and is a no-op (does not panic) when there are no subscribers. The
// end-to-end behavior is exercised via the public create path in Task 8.
func TestBroadcastAllExistsAndIsSafeWithNoSubs(t *testing.T) {
	srv, err := NewServer(t.TempDir() + "/sessiond.sock")
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	// No subscribers registered: must not panic.
	srv.broadcastAll(&Message{Type: TypeWorkspaceList})
}
```

### Step 2: Run the test to verify it fails

Run: `go test ./internal/sessiond/ -run TestBroadcastAllExistsAndIsSafeWithNoSubs`

Expected: FAIL — compile error: `srv.broadcastAll undefined (type *Server has no field or method broadcastAll)`.

### Step 3: Write the minimal implementation

In `internal/sessiond/server.go`, add this method immediately after the `broadcast` method (which ends at ~line 159, just before `broadcastPaneData`):

```go
// broadcastAll enqueues msg to every subscriber attached to any workspace,
// deduplicating connections. Use for global events (e.g. the workspace list
// changing) that are not scoped to a single workspace. Enqueue never blocks, so
// holding s.mu is safe.
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
```

### Step 4: Run the test to verify it passes

Run: `go test ./internal/sessiond/ -run TestBroadcastAllExistsAndIsSafeWithNoSubs`

Expected: PASS (`ok  ...sessiond`).

### Step 5: Commit

```
git add internal/sessiond/server.go internal/sessiond/broadcast_test.go && git commit -m "$(cat <<'EOF'
feat(sessiond): add broadcastAll global fan-out helper

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 8 — Daemon: broadcast the workspace list on create

**Context:** The `create-workspace` handler currently only replies to the requesting connection. Other attached clients never learn about the new workspace until they reconnect — the "doesn't appear in the dropdown until reload" bug. Broadcast the updated list to everyone after a create.

**Files:**
- Test (modify): `internal/sessiond/broadcast_test.go` (add an end-to-end test)
- Modify: `internal/sessiond/server.go` (`TypeCreateWorkspace` case in `handle`, ~lines 239-241)

### Step 1: Write the failing test

In `internal/sessiond/broadcast_test.go`, append this test at the end of the file:

```go
// TestServerBroadcastsWorkspaceListOnCreate verifies that creating a workspace
// from one connection pushes an updated workspace-list event to every other
// attached connection, with no reconnect or poll required.
func TestServerBroadcastsWorkspaceListOnCreate(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// Observer attaches to the cold-start default workspace so it is live.
	observer := dialMust(t, socketPath)
	writeControlMust(t, observer, &Message{Type: TypeListWorkspaces, CID: 1})
	list := readControlUntil(t, observer, TypeWorkspaceList)
	if len(list.Workspaces) != 1 {
		t.Fatalf("cold-start list = %d workspaces, want 1", len(list.Workspaces))
	}
	defaultID := list.Workspaces[0].WorkspaceID
	writeControlMust(t, observer, &Message{Type: TypeAttach, WorkspaceID: defaultID, CID: 2})
	readControlUntil(t, observer, TypeComposition)

	// A second connection creates a new workspace.
	creator := dialMust(t, socketPath)
	writeControlMust(t, creator, &Message{Type: TypeCreateWorkspace, Name: "made-by-creator", CID: 3})
	readControlUntil(t, creator, TypeWorkspaceCreated)

	// The observer must receive a workspace-list EVENT reflecting the new
	// workspace without reconnecting.
	evt := readControlUntil(t, observer, TypeWorkspaceList)
	if len(evt.Workspaces) != 2 {
		t.Fatalf("broadcast list = %d workspaces, want 2", len(evt.Workspaces))
	}
}
```

### Step 2: Run the test to verify it fails

Run: `go test ./internal/sessiond/ -run TestServerBroadcastsWorkspaceListOnCreate`

Expected: FAIL — the observer never receives a second `workspace-list`, so `readControlUntil` hits its 5s read deadline and calls `t.Fatalf("read frame waiting for \"workspace-list\": ...")`.

### Step 3: Write the minimal implementation

In `internal/sessiond/server.go`, in the `handle` method, replace the `TypeCreateWorkspace` case (~lines 239-241):

```go
	case TypeCreateWorkspace:
		id := c.srv.reg.AddWorkspace(msg.Name)
		c.reply(&Message{Type: TypeWorkspaceCreated, CID: msg.CID, WorkspaceID: id, Name: msg.Name})
```

with:

```go
	case TypeCreateWorkspace:
		id := c.srv.reg.AddWorkspace(msg.Name)
		c.reply(&Message{Type: TypeWorkspaceCreated, CID: msg.CID, WorkspaceID: id, Name: msg.Name})
		// Global event (cid=0): every attached client refreshes its workspace
		// list immediately, so a new workspace appears without a reload.
		c.srv.broadcastAll(&Message{Type: TypeWorkspaceList, Workspaces: c.srv.reg.List()})
```

### Step 4: Run the test to verify it passes

Run: `go test ./internal/sessiond/ -run TestServerBroadcastsWorkspaceListOnCreate`

Expected: PASS (`ok  ...sessiond`).

### Step 5: Commit

```
git add internal/sessiond/server.go internal/sessiond/broadcast_test.go && git commit -m "$(cat <<'EOF'
fix(sessiond): broadcast workspace-list on create so new workspaces appear live

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 9 — Final gate: full verification across client + daemon

**Context:** Confirm the whole Phase 1 change set is green end to end. No code changes unless something fails — if it does, fix it under the relevant task's discipline (write/adjust a test first), then re-run this gate.

### Step 1: Web type-check

Run: `cd web && npx tsc --noEmit`

Expected: no output, exit 0 (clean).

### Step 2: Web production build

Run: `cd web && npx vite build`

Expected: build succeeds, exit 0.

### Step 3: Full web test suite

Run: `cd web && npm test`

Expected: all tests PASS (green).

### Step 4: Full Go test suite

Run (from repo root): `cd .. && go test ./...`

Expected: all packages `ok` (no `FAIL`).

### Step 5: Confirm a clean tree (everything committed)

Run: `git status --porcelain`

Expected: empty output (all Phase 1 changes already committed in Tasks 1-8; nothing should remain except, if present, this plan document — do NOT commit the plan document).

---

## Done — Phase 1 complete

At this point the foundations are in place:
- The store's authoritative base is honestly immutable (getters copy; `WorkspaceRenamed` rebuilds).
- Workspaces show a stable lowercase `workspace N` label.
- The dropdown is a tight, fit-to-content menu with an aligned check column and hover-revealed actions.
- The daemon pushes the workspace list on create, so new workspaces appear without a reload.

**Next:** Phase 2 (the optimistic-mutation seam + rename/close wiring + failure UX) — a separate plan. Do not start it here.
