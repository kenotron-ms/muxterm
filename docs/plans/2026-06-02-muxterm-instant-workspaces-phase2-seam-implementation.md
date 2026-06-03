# Instant Workspaces — Phase 2: Optimistic Seam + rename/close Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Add a generalized optimistic-mutation seam to `MuxStore` (a `pending` set + a fold in the getters), route `renameWorkspace`/`closeWorkspace` through it so they feel instant, and surface a **loud** errored-row failure UX (retry/dismiss) — never a silent vanish.

**Architecture:** Render = authoritative base + pending optimistic overlay. `MuxStore` keeps an authoritative base (built by `applySessiond`, untouched by optimism). A `pending` map of mutations is folded over a *copy* of that base on every getter read. After each `applySessiond`, any pending mutation whose `settled(base)` predicate is true is dropped (overlay vanishes, base shows through). A ~5s timeout marks a mutation **errored** (not removed) so the UI can show a retry/dismiss affordance.

**Tech Stack:** Lit 3 + TypeScript (`web/src/`), Vitest 3 + happy-dom for tests, websocket transport in `web/src/ws.ts`, singleton store in `web/src/state.ts`.

**Scope discipline (read before starting):**
- This is **Phase 2 of 3**. Do **ONLY** what is in this plan.
- Phase 1 (DONE — do not redo): immutable base, `workspace N` label, dropdown CSS polish, daemon broadcast-list-on-create.
- Phase 3 (NOT here — do not touch): correlation-id **creates** (`createWorkspace`/`createPane`) and one-terminal-per-workspace behavior. Wire **only** rename and close through the seam.
- Do **NOT** build a reusable `MutationController` framework. Keep it a `pending` map + a fold. That's the whole mechanism.
- The optimistic seam mechanism is generic, but only rename/close are routed through it in this phase.

**Reference:** Design doc `docs/plans/2026-06-02-muxterm-instant-workspaces-design.md` — Section 3 is the heart of this phase. Read it first.

**Working directory for all commands:** the repo root is `/home/ken/workspace/muxterm`. All test/build commands run from `web/` (shown as `cd web && …`).

---

## Key facts verified in the codebase (so the code below is accurate)

- `web/src/state.ts` — `MuxStore` class. Private fields: `_workspaces: SessiondWorkspaceInfo[]`, `_panes: SessiondPaneInfo[]`, `_activePaneId: number`, `_attached`. Getters today **return raw private refs**: `get workspaces()` returns `this._workspaces`, `get panes()` returns `this._panes`, and `get composition()` reads `this._panes` directly (around line 45). `applySessiond(msg)` mutates base then calls `this._notify()` at the end (the `default` case `return`s early with no notify). Singleton exported as `store`.
- `web/src/types.ts` — `SessiondWorkspaceInfo { workspaceId: string; name?: string; paneCount: number }`, `SessiondPaneInfo { paneId: number; cols: number; rows: number; title?: string }`. `SessiondType` is a frozen const map.
- `web/src/ws.ts` — `MuxSocket` has `renameWorkspace(workspaceId, name)` and `closeWorkspace(workspaceId)` flat senders. **Leave these as the transport** — the seam's `commit` callback calls them. No change needed in `ws.ts`.
- `web/src/app.ts` — renders `<mux-workspace-picker>` (around lines 322-336) with inline arrow handlers for `@workspace-rename` and `@workspace-close` that call `this._socket?.renameWorkspace(...)` / `this._socket?.closeWorkspace(...)`. Uses the singleton `store`. Re-renders on `store.subscribe(...)` notify (line ~197).
- `web/src/components/workspace-picker.ts` — `MuxWorkspacePicker` renders a `.ws-item` row per workspace with `.ws-name`, `.ws-meta`, and two `.row-action` buttons (`.ws-rename`, `.ws-close`). Emits bubbling+composed `CustomEvent`s: `workspace-rename`, `workspace-close`, etc. `workspaceLabel(ws)` helper already exists.
- Tests live in `web/src/__tests__/*.test.ts` (vitest + happy-dom). Store tests construct `new MuxStore()` directly (see `state.workspace.test.ts`). App tests mock `WebSocket` globally and use the singleton `store` (see `app.sessiond.test.ts`). Component tests create the element via `document.createElement` and `await el.updateComplete` (see `workspace-picker.test.ts`).

---

## Commands you will use

- Run ONE test file: `cd web && npx vitest run src/__tests__/<file>.test.ts`
- Run ONE test by name: `cd web && npx vitest run src/__tests__/<file>.test.ts -t "<test name substring>"`
- Full test suite: `cd web && npm test`
- Type check: `cd web && npx tsc --noEmit`
- Production build: `cd web && npx vite build`

---

## Task list

- Task 1 — Seam scaffolding: types, `_pending`, `mutate()`, folded `workspaces` getter
- Task 2 — Fold the `panes` getter
- Task 3 — Route the `composition` getter through the fold (no split-brain)
- Task 4 — Settle pending mutations after `applySessiond`
- Task 5 — Timeout marks a mutation errored (not removed); expose `erroredMutations`
- Task 6 — `retry()` and `dismiss()` controls
- Task 7 — Wire `renameWorkspace` through the seam in `app.ts`
- Task 8 — Wire `closeWorkspace` through the seam in `app.ts`
- Task 9 — Errored-row rendering + retry/dismiss events in the picker
- Task 10 — Wire the picker's errored props + retry/dismiss handlers in `app.ts`
- Task 11 — Final gate: `tsc --noEmit` + `vite build` + full `npm test`

---

### Task 1: Seam scaffolding — types, `_pending`, `mutate()`, folded `workspaces` getter

**Files:**
- Modify: `web/src/state.ts`
- Create: `web/src/__tests__/state.seam.test.ts`

**Step 1: Write the failing test**

Create `web/src/__tests__/state.seam.test.ts` with this content:

```ts
import { describe, it, expect } from 'vitest';
import { MuxStore } from '../state';
import { SessiondType } from '../types';
import type { SessiondMessage } from '../types';

const workspaceList = (
  workspaces: { workspaceId: string; name?: string; paneCount: number }[],
): SessiondMessage => ({ type: SessiondType.WorkspaceList, workspaces });

describe('MuxStore optimistic seam — mutate + folded workspaces getter', () => {
  it('applies an optimistic rename over the base in store.workspaces', () => {
    const store = new MuxStore();
    store.applySessiond(workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]));

    store.mutate({
      workspaceId: 'ws-1',
      kind: 'rename',
      optimistic: (draft) => {
        const ws = draft.workspaces.find((w) => w.workspaceId === 'ws-1');
        if (ws) ws.name = 'new';
      },
      settled: (base) =>
        base.workspaces.find((w) => w.workspaceId === 'ws-1')?.name === 'new',
    });

    expect(store.workspaces.find((w) => w.workspaceId === 'ws-1')?.name).toBe('new');
  });

  it('never mutates the authoritative base when folding optimism', () => {
    const store = new MuxStore();
    store.applySessiond(workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]));

    const id = store.mutate({
      workspaceId: 'ws-1',
      kind: 'rename',
      optimistic: (draft) => {
        const ws = draft.workspaces.find((w) => w.workspaceId === 'ws-1');
        if (ws) ws.name = 'new';
      },
      settled: () => false,
    });

    // Read the folded view (applies optimism), then drop the overlay.
    expect(store.workspaces[0].name).toBe('new');
    store.dismiss(id);
    // Base must be untouched: dropping the overlay returns the original name.
    expect(store.workspaces[0].name).toBe('old');
  });

  it('mutate fires the commit callback once and returns a mutation id', () => {
    const store = new MuxStore();
    store.applySessiond(workspaceList([{ workspaceId: 'ws-1', paneCount: 0 }]));
    let commits = 0;

    const id = store.mutate({
      optimistic: () => {},
      settled: () => false,
      commit: () => {
        commits += 1;
      },
    });

    expect(typeof id).toBe('string');
    expect(commits).toBe(1);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts`
Expected: FAIL — `store.mutate is not a function` (and `store.dismiss is not a function`).

**Step 3: Write the minimal implementation**

In `web/src/state.ts`, add the seam types **above** the `export class MuxStore` line (after the imports). Insert this block:

```ts
// --- Optimistic-mutation seam --------------------------------------------
// render = authoritative base + pending optimistic overlay. The base
// (_workspaces / _panes) is NEVER mutated by optimism; each getter folds the
// pending overlay over a COPY of the base, recomputed on every read.

/** Mutable working copy the optimistic patch edits. */
export interface MutationDraft {
  workspaces: SessiondWorkspaceInfo[];
  panes: SessiondPaneInfo[];
}

/** Read-only authoritative snapshot the settle predicate inspects. */
export interface MutationBase {
  readonly workspaces: readonly SessiondWorkspaceInfo[];
  readonly panes: readonly SessiondPaneInfo[];
}

/** Caller-supplied mutation description. */
export interface MutationSpec {
  /** Patch applied over a copy of the base while pending (and not errored). */
  optimistic: (draft: MutationDraft) => void;
  /** True once the authoritative base reflects this mutation. */
  settled: (base: MutationBase) => boolean;
  /** Fires the socket send. Called on mutate() and again on retry(). */
  commit?: () => void;
  /** Called when the timeout fires without a settle. */
  onTimeout?: () => void;
  /** Workspace this mutation targets — lets the UI correlate errored rows. */
  workspaceId?: string;
  /** Mutation kind tag for the UI (e.g. 'rename', 'close'). */
  kind?: string;
  /** Override the default timeout backstop (ms). */
  timeoutMs?: number;
}

/** A mutation surfaced to the UI as errored (timed out without settling). */
export interface ErroredMutation {
  id: string;
  workspaceId?: string;
  kind?: string;
}

interface PendingRecord extends MutationSpec {
  id: string;
  errored: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_MUTATION_TIMEOUT_MS = 5000;
```

Then, inside the class, add the pending state next to the other private fields (right after `private _activePaneId = 0;`):

```ts
  // Optimistic overlay: pending mutations folded over the base in the getters.
  private _pending: Map<string, PendingRecord> = new Map();
  private _mutationSeq = 0;
```

Add the fold helper and the `mutate`/`dismiss` methods. Put them just **above** the `subscribe` method:

```ts
  // Build a fresh draft = copy(base) with each non-errored pending optimistic
  // patch folded on top. Copies ensure optimism never touches the base.
  private _foldedView(): MutationDraft {
    const draft: MutationDraft = {
      workspaces: this._workspaces.map((w) => ({ ...w })),
      panes: this._panes.map((p) => ({ ...p })),
    };
    for (const record of this._pending.values()) {
      if (record.errored) continue; // errored: snap to truth, surfaced separately
      record.optimistic(draft);
    }
    return draft;
  }

  /**
   * Register an optimistic mutation. Adds it to the pending overlay, fires the
   * commit (socket send), starts the timeout backstop, and notifies. Returns
   * the mutation id (used by retry/dismiss).
   */
  mutate(spec: MutationSpec): string {
    const id = `m${++this._mutationSeq}`;
    const record: PendingRecord = { ...spec, id, errored: false, timer: undefined };
    record.timer = setTimeout(
      () => this._onMutationTimeout(id),
      spec.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS,
    );
    this._pending.set(id, record);
    spec.commit?.();
    this._notify();
    return id;
  }

  /** Drop a pending mutation's overlay entirely (used by dismiss + settle). */
  dismiss(id: string): void {
    const record = this._pending.get(id);
    if (!record) return;
    if (record.timer !== undefined) clearTimeout(record.timer);
    this._pending.delete(id);
    this._notify();
  }

  private _onMutationTimeout(id: string): void {
    const record = this._pending.get(id);
    if (!record || record.errored) return;
    record.errored = true;
    record.timer = undefined;
    record.onTimeout?.();
    this._notify();
  }
```

Finally, change the `workspaces` getter to read the folded view. Replace:

```ts
  get workspaces(): SessiondWorkspaceInfo[] {
    return this._workspaces;
  }
```

with:

```ts
  get workspaces(): SessiondWorkspaceInfo[] {
    return this._foldedView().workspaces;
  }
```

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts`
Expected: PASS (3 passing).

**Step 5: Confirm no regressions in existing store tests**

Run: `cd web && npx vitest run src/__tests__/state.workspace.test.ts src/__tests__/state.test.ts`
Expected: PASS (all existing store tests green).

**Step 6: Commit**

```
cd web && git add src/state.ts src/__tests__/state.seam.test.ts && git commit -m "feat(web): add optimistic-mutation seam scaffolding to MuxStore

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: Fold the `panes` getter

**Files:**
- Modify: `web/src/state.ts`
- Modify: `web/src/__tests__/state.seam.test.ts`

**Step 1: Write the failing test**

Append this `describe` block to `web/src/__tests__/state.seam.test.ts` (after the existing block, before the final newline):

```ts
const composition = (
  workspaceId: string,
  panes: { paneId: number; cols: number; rows: number; title?: string }[],
): SessiondMessage => ({ type: SessiondType.Composition, workspaceId, panes });

describe('MuxStore optimistic seam — folded panes getter', () => {
  it('applies an optimistic pane add over the base in store.panes', () => {
    const store = new MuxStore();
    store.applySessiond(composition('ws-1', [{ paneId: 5, cols: 80, rows: 24 }]));

    store.mutate({
      kind: 'create-pane',
      optimistic: (draft) => {
        draft.panes.push({ paneId: 999, cols: 80, rows: 24, title: 'optimistic' });
      },
      settled: () => false,
    });

    expect(store.panes.map((p) => p.paneId)).toEqual([5, 999]);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts -t "folded panes getter"`
Expected: FAIL — `store.panes` returns `[5]`, the optimistic pane is missing.

**Step 3: Write the minimal implementation**

In `web/src/state.ts`, replace:

```ts
  get panes(): SessiondPaneInfo[] {
    return this._panes;
  }
```

with:

```ts
  get panes(): SessiondPaneInfo[] {
    return this._foldedView().panes;
  }
```

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts`
Expected: PASS (all blocks green).

**Step 5: Commit**

```
cd web && git add src/state.ts src/__tests__/state.seam.test.ts && git commit -m "feat(web): fold optimistic overlay into MuxStore.panes getter

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: Route the `composition` getter through the fold (no split-brain)

The `composition` getter reads `this._panes` directly (around line 45). It MUST read the folded view too, or an optimistic pane shows in `panes` but not in `composition` — split-brain rendering.

**Files:**
- Modify: `web/src/state.ts`
- Modify: `web/src/__tests__/state.seam.test.ts`

**Step 1: Write the failing test**

Append this `describe` block to `web/src/__tests__/state.seam.test.ts`:

```ts
describe('MuxStore optimistic seam — composition reads the folded view', () => {
  it('shows an optimistic pane through store.composition.paneIds (no split-brain)', () => {
    const store = new MuxStore();
    store.applySessiond(composition('ws-1', [{ paneId: 5, cols: 80, rows: 24 }]));

    store.mutate({
      kind: 'create-pane',
      optimistic: (draft) => {
        draft.panes.push({ paneId: 999, cols: 80, rows: 24 });
      },
      settled: () => false,
    });

    expect(store.composition.paneIds).toEqual([5, 999]);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts -t "no split-brain"`
Expected: FAIL — `composition.paneIds` returns `[5]`.

**Step 3: Write the minimal implementation**

In `web/src/state.ts`, replace the `composition` getter:

```ts
  get composition(): Composition {
    return {
      paneIds: this._panes.map((p) => p.paneId),
      activePaneId: this._activePaneId,
    };
  }
```

with:

```ts
  get composition(): Composition {
    return {
      paneIds: this._foldedView().panes.map((p) => p.paneId),
      activePaneId: this._activePaneId,
    };
  }
```

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts`
Expected: PASS.

**Step 5: Confirm the whole suite is still green (composition is widely read)**

Run: `cd web && npm test`
Expected: PASS (all test files green).

**Step 6: Commit**

```
cd web && git add src/state.ts src/__tests__/state.seam.test.ts && git commit -m "feat(web): route MuxStore.composition through the optimistic fold

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: Settle pending mutations after `applySessiond`

When the authoritative echo lands, any pending mutation whose `settled(base)` is now true must be dropped — the overlay vanishes and the (now-correct) base shows through.

**Files:**
- Modify: `web/src/state.ts`
- Modify: `web/src/__tests__/state.seam.test.ts`

**Step 1: Write the failing test**

Append this `describe` block to `web/src/__tests__/state.seam.test.ts`:

```ts
const workspaceRenamed = (workspaceId: string, name?: string): SessiondMessage => ({
  type: SessiondType.WorkspaceRenamed,
  workspaceId,
  name,
});

describe('MuxStore optimistic seam — settle after applySessiond', () => {
  it('drops a pending mutation once its settled(base) predicate is true', () => {
    const store = new MuxStore();
    store.applySessiond(workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]));

    store.mutate({
      workspaceId: 'ws-1',
      kind: 'rename',
      optimistic: (draft) => {
        const ws = draft.workspaces.find((w) => w.workspaceId === 'ws-1');
        if (ws) ws.name = 'new';
      },
      settled: (base) =>
        base.workspaces.find((w) => w.workspaceId === 'ws-1')?.name === 'new',
    });

    // Overlay is live before the echo.
    expect(store.workspaces[0].name).toBe('new');

    // Authoritative echo: base now reflects the rename -> overlay must drop.
    store.applySessiond(workspaceRenamed('ws-1', 'new'));

    expect(store.workspaces[0].name).toBe('new');
    expect(store.erroredMutations).toEqual([]); // settled, not errored
    // Folding nothing now: change base again and the overlay is truly gone.
    store.applySessiond(workspaceRenamed('ws-1', 'newer'));
    expect(store.workspaces[0].name).toBe('newer');
  });
});
```

> Note: this test references `store.erroredMutations`, which is added in Task 5. For Task 4, add a temporary empty getter (Step 3 includes it) so this compiles; Task 5 fleshes it out.

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts -t "settled\\(base\\) predicate"`
Expected: FAIL — after the echo the overlay is still applied (or `erroredMutations` is undefined).

**Step 3: Write the minimal implementation**

In `web/src/state.ts`, add a `_settlePending` helper next to `_foldedView` (above `subscribe`):

```ts
  // After the authoritative base changes, drop any pending mutation the base
  // now reflects. Errored mutations are left for the user to retry/dismiss.
  private _settlePending(): void {
    const base: MutationBase = { workspaces: this._workspaces, panes: this._panes };
    for (const record of this._pending.values()) {
      if (record.errored) continue;
      if (record.settled(base)) {
        if (record.timer !== undefined) clearTimeout(record.timer);
        this._pending.delete(record.id);
      }
    }
  }
```

Add a placeholder `erroredMutations` getter (replaced in Task 5) so the test compiles. Put it right after the `composition` getter:

```ts
  get erroredMutations(): ErroredMutation[] {
    return [];
  }
```

Wire `_settlePending` into `applySessiond`: it must run after the base is updated but before the notify. In `applySessiond`, the final line is `this._notify();`. Change that final line:

```ts
    this._notify();
```

to:

```ts
    this._settlePending();
    this._notify();
```

> Do NOT add it to the `default` case — that case `return`s early and changes nothing, so there is nothing to settle.

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts`
Expected: PASS.

**Step 5: Commit**

```
cd web && git add src/state.ts src/__tests__/state.seam.test.ts && git commit -m "feat(web): settle pending optimistic mutations after applySessiond

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: Timeout marks a mutation errored (not removed); expose `erroredMutations`

The timeout is a backstop for protocol failure, NOT the happy path. On expiry **without** a settle, mark the mutation **errored** — keep it (so the UI can show retry/dismiss) but stop applying its optimistic overlay so the UI snaps to truth loudly.

**Files:**
- Modify: `web/src/state.ts`
- Modify: `web/src/__tests__/state.seam.test.ts`

**Step 1: Write the failing test**

Append this `describe` block to `web/src/__tests__/state.seam.test.ts`. It uses fake timers — note the `vi` import must be added to the top-of-file import: change the first import line to `import { describe, it, expect, vi } from 'vitest';`.

```ts
describe('MuxStore optimistic seam — timeout marks errored, snaps to truth', () => {
  it('marks a stuck mutation errored after the timeout and reverts the overlay', () => {
    vi.useFakeTimers();
    try {
      const store = new MuxStore();
      store.applySessiond(workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]));

      const id = store.mutate({
        workspaceId: 'ws-1',
        kind: 'rename',
        timeoutMs: 5000,
        optimistic: (draft) => {
          const ws = draft.workspaces.find((w) => w.workspaceId === 'ws-1');
          if (ws) ws.name = 'new';
        },
        settled: () => false, // never settles -> will time out
      });

      expect(store.workspaces[0].name).toBe('new'); // optimistic while pending

      vi.advanceTimersByTime(5000);

      // Errored: overlay reverts to truth, mutation is surfaced (not removed).
      expect(store.workspaces[0].name).toBe('old');
      expect(store.erroredMutations).toEqual([
        { id, workspaceId: 'ws-1', kind: 'rename' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts -t "snaps to truth"`
Expected: FAIL — `erroredMutations` returns `[]` (the placeholder from Task 4).

**Step 3: Write the minimal implementation**

In `web/src/state.ts`, replace the placeholder `erroredMutations` getter:

```ts
  get erroredMutations(): ErroredMutation[] {
    return [];
  }
```

with the real one:

```ts
  get erroredMutations(): ErroredMutation[] {
    const out: ErroredMutation[] = [];
    for (const record of this._pending.values()) {
      if (record.errored) {
        out.push({ id: record.id, workspaceId: record.workspaceId, kind: record.kind });
      }
    }
    return out;
  }
```

> `_onMutationTimeout` (added in Task 1) already sets `record.errored = true` and notifies, and `_foldedView` (Task 1) already skips errored records (`if (record.errored) continue;`). No other change needed.

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts`
Expected: PASS.

**Step 5: Commit**

```
cd web && git add src/state.ts src/__tests__/state.seam.test.ts && git commit -m "feat(web): expose errored mutations and snap to truth on timeout

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 6: `retry()` and `dismiss()` controls

The errored row offers **retry** (re-fire commit, restart the timeout, clear errored) and **dismiss** (drop the mutation). `dismiss()` already exists from Task 1 — this task adds `retry()` and proves both.

**Files:**
- Modify: `web/src/state.ts`
- Modify: `web/src/__tests__/state.seam.test.ts`

**Step 1: Write the failing test**

Append this `describe` block to `web/src/__tests__/state.seam.test.ts`:

```ts
describe('MuxStore optimistic seam — retry and dismiss', () => {
  it('retry clears errored, re-applies the overlay, and re-fires commit', () => {
    vi.useFakeTimers();
    try {
      const store = new MuxStore();
      store.applySessiond(workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]));
      let commits = 0;

      const id = store.mutate({
        workspaceId: 'ws-1',
        kind: 'rename',
        optimistic: (draft) => {
          const ws = draft.workspaces.find((w) => w.workspaceId === 'ws-1');
          if (ws) ws.name = 'new';
        },
        settled: () => false,
        commit: () => {
          commits += 1;
        },
      });

      vi.advanceTimersByTime(5000);
      expect(store.erroredMutations.length).toBe(1);
      expect(store.workspaces[0].name).toBe('old'); // reverted while errored

      store.retry(id);
      expect(commits).toBe(2); // commit fired again
      expect(store.erroredMutations).toEqual([]); // no longer errored
      expect(store.workspaces[0].name).toBe('new'); // overlay re-applied
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismiss removes an errored mutation entirely', () => {
    vi.useFakeTimers();
    try {
      const store = new MuxStore();
      store.applySessiond(workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]));

      const id = store.mutate({
        workspaceId: 'ws-1',
        kind: 'rename',
        optimistic: (draft) => {
          const ws = draft.workspaces.find((w) => w.workspaceId === 'ws-1');
          if (ws) ws.name = 'new';
        },
        settled: () => false,
      });

      vi.advanceTimersByTime(5000);
      expect(store.erroredMutations.length).toBe(1);

      store.dismiss(id);
      expect(store.erroredMutations).toEqual([]);
      expect(store.workspaces[0].name).toBe('old');
    } finally {
      vi.useRealTimers();
    }
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts -t "retry and dismiss"`
Expected: FAIL — `store.retry is not a function`.

**Step 3: Write the minimal implementation**

In `web/src/state.ts`, add the `retry` method right after the `dismiss` method:

```ts
  /** Re-attempt an errored mutation: clear errored, restart the timeout
   *  backstop, and re-fire commit. */
  retry(id: string): void {
    const record = this._pending.get(id);
    if (!record) return;
    record.errored = false;
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.timer = setTimeout(
      () => this._onMutationTimeout(id),
      record.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS,
    );
    record.commit?.();
    this._notify();
  }
```

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/state.seam.test.ts`
Expected: PASS (entire seam test file green).

**Step 5: Type-check the store changes so far**

Run: `cd web && npx tsc --noEmit`
Expected: no output (clean).

**Step 6: Commit**

```
cd web && git add src/state.ts src/__tests__/state.seam.test.ts && git commit -m "feat(web): add retry/dismiss controls for errored optimistic mutations

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 7: Wire `renameWorkspace` through the seam in `app.ts`

Replace the inline `@workspace-rename` arrow (which sends straight to the socket) with a handler that routes through `store.mutate(...)`, settling by **exact id** (`find(id).name === newName`). The socket send becomes the mutation's `commit`. The `ws.ts` `renameWorkspace` sender stays as the transport.

**Files:**
- Modify: `web/src/app.ts`
- Create: `web/src/__tests__/app.optimistic.test.ts`

**Step 1: Write the failing test**

Create `web/src/__tests__/app.optimistic.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock WebSocket before importing app (mirrors app.sessiond.test.ts).
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  readyState = MockWebSocket.OPEN;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => this.onopen?.());
  }
  send = vi.fn();
  close = vi.fn();
}
// @ts-expect-error mock WebSocket globally
globalThis.WebSocket = MockWebSocket;

import type { MuxApp } from '../app.js';
import '../app.js';
import { store } from '../state.js';
import { SessiondType } from '../types.js';

function seedWorkspaces(): void {
  store.applySessiond({
    type: SessiondType.WorkspaceList,
    workspaces: [{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }],
  });
}

async function openPicker(): Promise<MuxApp> {
  const el = document.createElement('mux-app') as MuxApp;
  document.body.appendChild(el);
  await el.updateComplete;
  // Force the workspace picker open so it renders.
  (el as unknown as { _showWorkspacePicker: boolean })._showWorkspacePicker = true;
  el.requestUpdate();
  await el.updateComplete;
  return el;
}

describe('MuxApp optimistic rename wiring', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    // Reset store between tests.
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    el = null as unknown as MuxApp;
  });

  it('routes workspace-rename through store.mutate and shows the new name instantly', async () => {
    seedWorkspaces();
    el = await openPicker();
    const mutateSpy = vi.spyOn(store, 'mutate');

    const picker = el.shadowRoot!.querySelector('mux-workspace-picker')!;
    picker.dispatchEvent(
      new CustomEvent('workspace-rename', {
        bubbles: true,
        composed: true,
        detail: { workspaceId: 'ws-1', name: 'renamed' },
      }),
    );

    expect(mutateSpy).toHaveBeenCalledTimes(1);
    // Optimistic overlay shows immediately.
    expect(store.workspaces.find((w) => w.workspaceId === 'ws-1')?.name).toBe('renamed');

    // Predicate correctness: settle is exact-id by name.
    const spec = mutateSpy.mock.calls[0][0];
    expect(
      spec.settled({
        workspaces: [{ workspaceId: 'ws-1', name: 'renamed', paneCount: 0 }],
        panes: [],
      }),
    ).toBe(true);
    expect(
      spec.settled({
        workspaces: [{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }],
        panes: [],
      }),
    ).toBe(false);

    mutateSpy.mockRestore();
    // Dismiss the lingering pending mutation so it does not leak into other tests.
    for (const m of store.erroredMutations) store.dismiss(m.id);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts`
Expected: FAIL — `store.workspaces[...].name` is still `'old'` (the inline handler bypasses the store) and/or `mutate` not called.

**Step 3: Write the minimal implementation**

In `web/src/app.ts`, first import the `store` is already imported. Add a private rename handler method. Find the `_onWorkspaceSelected` method (around line 377) and add this method right before it:

```ts
  /** Optimistic workspace rename: settle by exact id (name matches). */
  private _onWorkspaceRename = (
    e: CustomEvent<{ workspaceId: string; name: string }>,
  ): void => {
    const { workspaceId, name } = e.detail;
    store.mutate({
      workspaceId,
      kind: 'rename',
      optimistic: (draft) => {
        const ws = draft.workspaces.find((w) => w.workspaceId === workspaceId);
        if (ws) ws.name = name ? name : undefined;
      },
      settled: (base) => {
        const ws = base.workspaces.find((w) => w.workspaceId === workspaceId);
        return (ws?.name ?? '') === name;
      },
      commit: () => this._socket?.renameWorkspace(workspaceId, name),
    });
  };
```

Then replace the inline `@workspace-rename` handler in the picker template. Find:

```ts
            @workspace-rename="${(e: CustomEvent<{ workspaceId: string; name: string }>) =>
              this._socket?.renameWorkspace(e.detail.workspaceId, e.detail.name)}"
```

and replace it with:

```ts
            @workspace-rename="${this._onWorkspaceRename}"
```

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts`
Expected: PASS.

**Step 5: Commit**

```
cd web && git add src/app.ts src/__tests__/app.optimistic.test.ts && git commit -m "feat(web): route workspace rename through the optimistic seam

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 8: Wire `closeWorkspace` through the seam in `app.ts`

Same pattern as rename, but settle by **exact id absence** (`!exists(id)`), and the optimistic patch removes the row.

**Files:**
- Modify: `web/src/app.ts`
- Modify: `web/src/__tests__/app.optimistic.test.ts`

**Step 1: Write the failing test**

Append this `describe` block to `web/src/__tests__/app.optimistic.test.ts` (after the existing block):

```ts
describe('MuxApp optimistic close wiring', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    el = null as unknown as MuxApp;
  });

  it('routes workspace-close through store.mutate and removes the row instantly', async () => {
    store.applySessiond({
      type: SessiondType.WorkspaceList,
      workspaces: [
        { workspaceId: 'ws-1', name: 'a', paneCount: 0 },
        { workspaceId: 'ws-2', name: 'b', paneCount: 0 },
      ],
    });
    el = await openPicker();
    const mutateSpy = vi.spyOn(store, 'mutate');

    const picker = el.shadowRoot!.querySelector('mux-workspace-picker')!;
    picker.dispatchEvent(
      new CustomEvent('workspace-close', {
        bubbles: true,
        composed: true,
        detail: { workspaceId: 'ws-1' },
      }),
    );

    expect(mutateSpy).toHaveBeenCalledTimes(1);
    // Optimistic removal is instant.
    expect(store.workspaces.map((w) => w.workspaceId)).toEqual(['ws-2']);

    const spec = mutateSpy.mock.calls[0][0];
    expect(
      spec.settled({
        workspaces: [{ workspaceId: 'ws-2', name: 'b', paneCount: 0 }],
        panes: [],
      }),
    ).toBe(true);
    expect(
      spec.settled({
        workspaces: [
          { workspaceId: 'ws-1', name: 'a', paneCount: 0 },
          { workspaceId: 'ws-2', name: 'b', paneCount: 0 },
        ],
        panes: [],
      }),
    ).toBe(false);

    mutateSpy.mockRestore();
    for (const m of store.erroredMutations) store.dismiss(m.id);
  });
});
```

> The `openPicker` helper is defined at module scope in this file (from Task 7), so it is in scope here.

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts -t "removes the row instantly"`
Expected: FAIL — `store.workspaces` still contains `ws-1`.

**Step 3: Write the minimal implementation**

In `web/src/app.ts`, add a close handler method right after `_onWorkspaceRename`:

```ts
  /** Optimistic workspace close: settle by exact id absence. */
  private _onWorkspaceClose = (
    e: CustomEvent<{ workspaceId: string }>,
  ): void => {
    const { workspaceId } = e.detail;
    store.mutate({
      workspaceId,
      kind: 'close',
      optimistic: (draft) => {
        draft.workspaces = draft.workspaces.filter((w) => w.workspaceId !== workspaceId);
      },
      settled: (base) => !base.workspaces.some((w) => w.workspaceId === workspaceId),
      commit: () => this._socket?.closeWorkspace(workspaceId),
    });
  };
```

Then replace the inline `@workspace-close` handler in the picker template. Find:

```ts
            @workspace-close="${(e: CustomEvent<{ workspaceId: string }>) =>
              this._socket?.closeWorkspace(e.detail.workspaceId)}"
```

and replace it with:

```ts
            @workspace-close="${this._onWorkspaceClose}"
```

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts`
Expected: PASS (both rename and close blocks green).

**Step 5: Commit**

```
cd web && git add src/app.ts src/__tests__/app.optimistic.test.ts && git commit -m "feat(web): route workspace close through the optimistic seam

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 9: Errored-row rendering + retry/dismiss events in the picker

The picker must mark a workspace row as **errored** when an errored mutation targets it, and show **retry** + **dismiss** affordances. Clicking them emits bubbling+composed events carrying the mutation id. The row must NEVER silently disappear.

**Files:**
- Modify: `web/src/components/workspace-picker.ts`
- Modify: `web/src/__tests__/workspace-picker.test.ts`

**Step 1: Write the failing test**

Append this `describe` block to `web/src/__tests__/workspace-picker.test.ts` (after the existing `MuxWorkspacePicker` describe, before the `workspaceLabel helper` describe):

```ts
describe('MuxWorkspacePicker errored-row failure UX', () => {
  let el: MuxWorkspacePicker;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    vi.restoreAllMocks();
  });

  async function erroredFixture(): Promise<MuxWorkspacePicker> {
    const picker = document.createElement('mux-workspace-picker') as MuxWorkspacePicker;
    picker.workspaces = [
      { workspaceId: 'ws-1', name: 'main', paneCount: 1 },
      { workspaceId: 'ws-2', name: 'logs', paneCount: 1 },
    ];
    picker.erroredMutations = [{ id: 'm7', workspaceId: 'ws-1', kind: 'rename' }];
    document.body.appendChild(picker);
    await picker.updateComplete;
    return picker;
  }

  it('marks the targeted row errored and keeps it visible', async () => {
    el = await erroredFixture();
    const items = el.shadowRoot!.querySelectorAll('.ws-item');
    expect(items.length).toBe(2); // row is NOT removed
    const errored = el.shadowRoot!.querySelectorAll('.ws-item.errored');
    expect(errored.length).toBe(1);
    expect(errored[0].querySelector('.ws-name')?.textContent).toBe('main');
  });

  it('renders retry and dismiss affordances on the errored row', async () => {
    el = await erroredFixture();
    const row = el.shadowRoot!.querySelector('.ws-item.errored')!;
    expect(row.querySelector('button.ws-retry')).toBeTruthy();
    expect(row.querySelector('button.ws-dismiss')).toBeTruthy();
  });

  it('dispatches workspace-retry with the mutation id', async () => {
    el = await erroredFixture();
    const handler = vi.fn();
    el.addEventListener('workspace-retry', handler as EventListener);
    (el.shadowRoot!.querySelector('button.ws-retry') as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ mutationId: string }>;
    expect(event.detail.mutationId).toBe('m7');
  });

  it('dispatches workspace-dismiss with the mutation id', async () => {
    el = await erroredFixture();
    const handler = vi.fn();
    el.addEventListener('workspace-dismiss', handler as EventListener);
    (el.shadowRoot!.querySelector('button.ws-dismiss') as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ mutationId: string }>;
    expect(event.detail.mutationId).toBe('m7');
  });

  it('defaults erroredMutations to an empty array', async () => {
    const picker = document.createElement('mux-workspace-picker') as MuxWorkspacePicker;
    document.body.appendChild(picker);
    await picker.updateComplete;
    el = picker;
    expect(picker.erroredMutations).toEqual([]);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/workspace-picker.test.ts -t "errored-row failure UX"`
Expected: FAIL — `erroredMutations` is not a property; `.ws-item.errored` not found.

**Step 3: Write the minimal implementation**

In `web/src/components/workspace-picker.ts`:

1. Add the imports/type. At the top, extend the lucide import and add a local errored-mutation type. Change:

```ts
import { Check, Plus, Pencil, X } from 'lucide';
```

to:

```ts
import { Check, Plus, Pencil, X, RotateCcw } from 'lucide';
```

And add this exported interface right above the `@customElement('mux-workspace-picker')` line:

```ts
/** Minimal shape the picker needs to render an errored row. Mirrors the
 *  store's ErroredMutation without coupling the component to state.ts. */
export interface PickerErroredMutation {
  id: string;
  workspaceId?: string;
  kind?: string;
}
```

2. Add the property. After the existing `currentWorkspaceId` property declaration:

```ts
  @property({ type: String })
  currentWorkspaceId = '';
```

add:

```ts
  @property({ attribute: false })
  erroredMutations: PickerErroredMutation[] = [];
```

3. Add the event emitters. After the existing `_onClose` method:

```ts
  private _onRetry(e: Event, mutationId: string): void {
    e.stopPropagation();
    this._emit('workspace-retry', { mutationId });
  }

  private _onDismiss(e: Event, mutationId: string): void {
    e.stopPropagation();
    this._emit('workspace-dismiss', { mutationId });
  }
```

4. Add styles. Inside the `static styles = css` template, after the `.ws-item.sel` rule, add:

```ts
    .ws-item.errored {
      border-color: #f38ba8;
      background: #3a2230;
    }

    .ws-err-msg {
      color: #f38ba8;
      font-size: 12px;
      margin-right: 4px;
    }

    .ws-item.errored .row-action {
      color: #f38ba8;
    }
```

5. Update the row template. In `render()`, the row currently computes `const current = ...`. Replace the row's opening of the `.map` callback so it also computes the errored mutation, and conditionally renders the affordances. Replace this block:

```ts
            ${this.workspaces.map((w) => {
              const current = w.workspaceId === this.currentWorkspaceId;
              return html`
                <div class="ws-item ${current ? 'sel' : ''}">
                  <button
                    class="ws-sel"
                    @click="${() => this._onSelect(w.workspaceId)}"
                  >
                    <span class="ck">${current ? icon(Check, { size: 12 }) : ''}</span>
                    <span class="ws-name">${workspaceLabel(w)}</span>
                    <span class="ws-meta">${w.paneCount} ${w.paneCount === 1 ? 'pane' : 'panes'}</span>
                  </button>
                  <button
                    class="row-action ws-rename"
                    title="Rename"
                    @click="${(e: Event) => this._onRename(e, w.workspaceId)}"
                  >
                    ${icon(Pencil, { size: 14 })}
                  </button>
                  <button
                    class="row-action ws-close"
                    title="Close"
                    @click="${(e: Event) => this._onClose(e, w.workspaceId)}"
                  >
                    ${icon(X, { size: 14 })}
                  </button>
                </div>
              `;
            })}
```

with:

```ts
            ${this.workspaces.map((w) => {
              const current = w.workspaceId === this.currentWorkspaceId;
              const errored = this.erroredMutations.find(
                (m) => m.workspaceId === w.workspaceId,
              );
              return html`
                <div
                  class="ws-item ${current ? 'sel' : ''} ${errored ? 'errored' : ''}"
                >
                  <button
                    class="ws-sel"
                    @click="${() => this._onSelect(w.workspaceId)}"
                  >
                    <span class="ck">${current ? icon(Check, { size: 12 }) : ''}</span>
                    <span class="ws-name">${workspaceLabel(w)}</span>
                    <span class="ws-meta">${w.paneCount} ${w.paneCount === 1 ? 'pane' : 'panes'}</span>
                  </button>
                  ${errored
                    ? html`
                        <span class="ws-err-msg">failed</span>
                        <button
                          class="row-action ws-retry"
                          title="Retry"
                          @click="${(e: Event) => this._onRetry(e, errored.id)}"
                        >
                          ${icon(RotateCcw, { size: 14 })}
                        </button>
                        <button
                          class="row-action ws-dismiss"
                          title="Dismiss"
                          @click="${(e: Event) => this._onDismiss(e, errored.id)}"
                        >
                          ${icon(X, { size: 14 })}
                        </button>
                      `
                    : html`
                        <button
                          class="row-action ws-rename"
                          title="Rename"
                          @click="${(e: Event) => this._onRename(e, w.workspaceId)}"
                        >
                          ${icon(Pencil, { size: 14 })}
                        </button>
                        <button
                          class="row-action ws-close"
                          title="Close"
                          @click="${(e: Event) => this._onClose(e, w.workspaceId)}"
                        >
                          ${icon(X, { size: 14 })}
                        </button>
                      `}
                </div>
              `;
            })}
```

> Note `RotateCcw` is a standard lucide icon. If `cd web && npx tsc --noEmit` reports it is missing from the `lucide` exports, substitute `RefreshCw` (also standard) in both the import and the `icon(RotateCcw, …)` call.

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/workspace-picker.test.ts`
Expected: PASS (existing picker tests + new errored-row tests all green).

**Step 5: Commit**

```
cd web && git add src/components/workspace-picker.ts src/__tests__/workspace-picker.test.ts && git commit -m "feat(web): render errored workspace rows with retry/dismiss affordances

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 10: Wire the picker's errored props + retry/dismiss handlers in `app.ts`

Pass `store.erroredMutations` into the picker and forward its `workspace-retry`/`workspace-dismiss` events to `store.retry(...)` / `store.dismiss(...)`. Because the app re-renders on every store notify, the errored rows update live.

**Files:**
- Modify: `web/src/app.ts`
- Modify: `web/src/__tests__/app.optimistic.test.ts`

**Step 1: Write the failing test**

Append this `describe` block to `web/src/__tests__/app.optimistic.test.ts`:

```ts
describe('MuxApp errored-row wiring', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    for (const m of store.erroredMutations) store.dismiss(m.id);
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    vi.useRealTimers();
    el = null as unknown as MuxApp;
  });

  it('passes store.erroredMutations into the picker and forwards retry/dismiss', async () => {
    vi.useFakeTimers();
    store.applySessiond({
      type: SessiondType.WorkspaceList,
      workspaces: [{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }],
    });
    el = await openPicker();

    // Drive a rename that will never settle, then time it out -> errored.
    const picker = el.shadowRoot!.querySelector('mux-workspace-picker')!;
    picker.dispatchEvent(
      new CustomEvent('workspace-rename', {
        bubbles: true,
        composed: true,
        detail: { workspaceId: 'ws-1', name: 'renamed' },
      }),
    );
    vi.advanceTimersByTime(5000);
    await el.updateComplete;

    // The picker received the errored mutation as a prop.
    const errored = (picker as unknown as { erroredMutations: { workspaceId?: string }[] })
      .erroredMutations;
    expect(errored.length).toBe(1);
    expect(errored[0].workspaceId).toBe('ws-1');

    // Forwarding: retry re-fires; dismiss clears.
    const retrySpy = vi.spyOn(store, 'retry');
    const dismissSpy = vi.spyOn(store, 'dismiss');
    const mutationId = store.erroredMutations[0].id;

    picker.dispatchEvent(
      new CustomEvent('workspace-retry', {
        bubbles: true,
        composed: true,
        detail: { mutationId },
      }),
    );
    expect(retrySpy).toHaveBeenCalledWith(mutationId);

    picker.dispatchEvent(
      new CustomEvent('workspace-dismiss', {
        bubbles: true,
        composed: true,
        detail: { mutationId },
      }),
    );
    expect(dismissSpy).toHaveBeenCalledWith(mutationId);

    retrySpy.mockRestore();
    dismissSpy.mockRestore();
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts -t "forwards retry/dismiss"`
Expected: FAIL — picker `erroredMutations` is empty (prop not wired) and/or retry/dismiss not forwarded.

**Step 3: Write the minimal implementation**

In `web/src/app.ts`, update the `<mux-workspace-picker>` element in the template. Find:

```ts
        ? html`<mux-workspace-picker
            .workspaces="${store.workspaces}"
            .currentWorkspaceId="${store.attached ?? ''}"
            @workspace-selected="${this._onWorkspaceSelected}"
            @workspace-create="${() => this._socket?.createWorkspace()}"
            @workspace-rename="${this._onWorkspaceRename}"
            @workspace-close="${this._onWorkspaceClose}"
            @close-picker="${() => {
              this._showWorkspacePicker = false;
            }}"
          ></mux-workspace-picker>`
```

and add the errored props/handlers so it becomes:

```ts
        ? html`<mux-workspace-picker
            .workspaces="${store.workspaces}"
            .currentWorkspaceId="${store.attached ?? ''}"
            .erroredMutations="${store.erroredMutations}"
            @workspace-selected="${this._onWorkspaceSelected}"
            @workspace-create="${() => this._socket?.createWorkspace()}"
            @workspace-rename="${this._onWorkspaceRename}"
            @workspace-close="${this._onWorkspaceClose}"
            @workspace-retry="${(e: CustomEvent<{ mutationId: string }>) =>
              store.retry(e.detail.mutationId)}"
            @workspace-dismiss="${(e: CustomEvent<{ mutationId: string }>) =>
              store.dismiss(e.detail.mutationId)}"
            @close-picker="${() => {
              this._showWorkspacePicker = false;
            }}"
          ></mux-workspace-picker>`
```

> If `tsc` complains it cannot find `_onWorkspaceRename`/`_onWorkspaceClose` here, confirm Tasks 7-8 added them as class members (arrow-function properties). They must exist before this task.

**Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/app.optimistic.test.ts`
Expected: PASS (all three blocks green).

**Step 5: Commit**

```
cd web && git add src/app.ts src/__tests__/app.optimistic.test.ts && git commit -m "feat(web): wire errored-mutation props and retry/dismiss into the picker

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 11: Final gate — types clean, build clean, full suite green

No new code. This task proves the whole phase is consistent.

**Step 1: Type-check the whole web app**

Run: `cd web && npx tsc --noEmit`
Expected: no output (exit 0). If `RotateCcw` errors, apply the `RefreshCw` substitution noted in Task 9 Step 3, re-run, and amend the Task 9 commit (`git commit --amend --no-edit`).

**Step 2: Production build**

Run: `cd web && npx vite build`
Expected: build completes with no errors (a `dist/` is produced; warnings about chunk size are acceptable).

**Step 3: Full test suite**

Run: `cd web && npm test`
Expected: ALL test files PASS, including:
- `src/__tests__/state.seam.test.ts` (new)
- `src/__tests__/app.optimistic.test.ts` (new)
- `src/__tests__/workspace-picker.test.ts` (extended)
- `src/__tests__/state.workspace.test.ts`, `src/__tests__/app.sessiond.test.ts`, and all pre-existing files (unchanged green).

**Step 4: Lint (optional but preferred)**

Run: `cd web && npm run lint`
Expected: no errors. Fix any reported issues, re-run, and amend the relevant commit.

**Step 5: Final verification commit (only if Steps 1-4 required fixups)**

If any fixes were needed above, stage and commit them:

```
cd web && git add -A && git commit -m "chore(web): finalize Phase 2 optimistic seam — types, build, tests green

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

If no fixups were needed, there is nothing to commit — the phase is complete.

---

## Done criteria (Phase 2)

- `MuxStore` has a `pending` map + `mutate()` + `dismiss()` + `retry()`, and `workspaces`/`panes`/`composition` getters all fold the pending overlay over a copy of the base. The base is never mutated by optimism.
- After each `applySessiond`, settled pending mutations are dropped; a ~5s timeout marks a stuck mutation **errored** (kept, not removed), exposed via `store.erroredMutations`, and its overlay reverts to truth.
- `renameWorkspace` and `closeWorkspace` route through `store.mutate(...)` with exact-id settle predicates; the optimistic name/removal shows instantly; the existing `WorkspaceRenamed`/`WorkspaceClosed` echoes settle them.
- The workspace picker renders an errored row (never a silent vanish) with **retry** and **dismiss**, wired to `store.retry`/`store.dismiss`.
- `tsc --noEmit` clean, `vite build` clean, full `npm test` green.

## Explicitly OUT of scope (do not do here)

- Correlation-id **creates** (`createWorkspace`/`createPane`) — Phase 3.
- One-terminal-per-workspace behavior — Phase 3.
- Promoting the seam to a reusable `MutationController` — deferred until a 5th/6th mutation appears.
- Any Go daemon changes.
- Dropdown CSS polish / `workspace N` label — Phase 1 (already done).
