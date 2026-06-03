# MuxTerm Protocol Fix — Phase 2: Client Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Fix four client-side bugs/gaps identified in the COE review: multiple-create guard, phantom terminal cursor, broken retry path for workspace create, and dead event handlers in `applySessiond`.
**Architecture:** All changes are contained within `web/src/**`. State mutations happen in `state.ts` and `app.ts`; UI surface updates happen in `components/workspace-picker.ts`. No new files are needed.
**Tech Stack:** Lit + TypeScript, Vitest + JSDOM, oxlint, `@typescript/native-preview`

---

## Background

Four bugs were identified:

1. **Multiple creates:** Clicking "New workspace…" rapidly mints a new `clientRef` and fires a WS message per click. No pending guard exists.
2. **Two cursors (phantom terminal):** The provisional pane (negative `paneId`) and the real pane briefly coexist in `store.panes`. Both get `terminalRegistry.ensure()` called, producing two live cursors.
3. **Broken retry for create-workspace:** The `_createWorkspaceOptimistic` socket send is inline after `store.mutate()`, not in `spec.commit`. `store.retry(id)` calls `record.commit?.()`, which is `undefined`, so retry silently does nothing.
4. **Dead event handlers:** `WorkspaceRenamed` and `WorkspaceClosed` cases in `applySessiond` are now redundant — the Go server broadcasts `workspace-list` for rename/close after Phase 1. The handlers still mutate store state incorrectly.

---

## Codebase Orientation

Key files and locations:

| File | Purpose |
|---|---|
| `web/src/state.ts` | `MuxStore` class — `mutate()`, `retry()`, `applySessiond()`, `_pending: Map<string, PendingRecord>` |
| `web/src/app.ts` | `MuxApp` LitElement — `_syncTerminals()` (line 274), `_createWorkspaceOptimistic()` (line 374) |
| `web/src/components/workspace-picker.ts` | `MuxWorkspacePicker` — `button.ws-new` (line 295) |
| `web/src/types.ts` | `SessiondType` const object with all wire vocabulary |
| `web/src/__tests__/workspace-picker.test.ts` | Existing picker tests — `fixture()` helper at line 14 |
| `web/src/__tests__/app.optimistic.test.ts` | Existing optimistic tests — pattern for spying on `_socket` |
| `web/src/__tests__/state.workspace.test.ts` | Existing workspace state tests — helper fns at top |

Key internal facts:
- `store.mutate(spec)` at `state.ts:252` calls `spec.commit?.()` immediately after inserting the record. Rename and close both pass `commit: () => this._socket?....` into the spec. Create currently does not.
- `store.retry(id)` at `state.ts:274` calls `record.commit?.()`. If `commit` is undefined (the current bug), retry is a silent no-op.
- `_nextTempPaneId` in `app.ts` starts at `-1` and decrements (`_nextTempPaneId--`). All provisional pane IDs are therefore strictly negative.
- `terminalRegistry.getTerminal(paneId)` returns `null` if `ensure()` has never been called for that ID.
- `store._pending` is a `Map<string, PendingRecord>`. Each record has `kind?: string` and `errored: boolean`. The `hasPendingKind` getter (new) should return `true` only for non-errored records with a matching `kind`.

---

## Fast-check commands

Run after every step that modifies TypeScript:
```
# Per-task (fast — ~2 s)
cd web && npm run test:file src/__tests__/<file>.test.ts && npm run check:fast

# Final gate only
cd web && npm test && npm run check:fast
```

---

## Task 1: Add `store.hasPendingKind()` and wire the create-pending guard

**Files:**
- Modify: `web/src/state.ts`
- Modify: `web/src/components/workspace-picker.ts`
- Modify: `web/src/app.ts`
- Test (state): `web/src/__tests__/state.workspace.test.ts`
- Test (picker): `web/src/__tests__/workspace-picker.test.ts`

---

### Step 1: Write the failing state tests

Open `web/src/__tests__/state.workspace.test.ts`. Add a new `describe` block **at the bottom of the file**, after all existing blocks:

```typescript
describe('MuxStore.hasPendingKind', () => {
  it('returns true when a non-errored mutation with matching kind is pending', () => {
    const store = new MuxStore();
    store.mutate({
      kind: 'create',
      optimistic: () => {},
      settled: () => false,
    });
    expect(store.hasPendingKind('create')).toBe(true);
  });

  it('returns false when no mutation of that kind is pending', () => {
    const store = new MuxStore();
    store.mutate({
      kind: 'rename',
      optimistic: () => {},
      settled: () => false,
    });
    expect(store.hasPendingKind('create')).toBe(false);
  });

  it('returns false when the only matching mutation is errored', () => {
    vi.useFakeTimers();
    try {
      const store = new MuxStore();
      store.mutate({
        kind: 'create',
        timeoutMs: 100,
        optimistic: () => {},
        settled: () => false,
      });
      vi.advanceTimersByTime(101);
      // The mutation has timed-out and is now marked errored.
      expect(store.hasPendingKind('create')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns false when store has no pending mutations', () => {
    const store = new MuxStore();
    expect(store.hasPendingKind('create')).toBe(false);
  });
});
```

Note: `vi` is already imported at the top of the file.

### Step 2: Run to confirm the state tests fail

```
cd web && npm run test:file src/__tests__/state.workspace.test.ts
```

Expected: FAIL — `store.hasPendingKind is not a function`

---

### Step 3: Add `hasPendingKind` to `MuxStore`

Open `web/src/state.ts`. Add the following method **directly after the `erroredMutations` getter** (after line 112):

```typescript
  /** Returns true if any non-errored pending mutation has kind === `kind`. */
  hasPendingKind(kind: string): boolean {
    for (const record of this._pending.values()) {
      if (!record.errored && record.kind === kind) return true;
    }
    return false;
  }
```

### Step 4: Run to confirm state tests pass

```
cd web && npm run test:file src/__tests__/state.workspace.test.ts
```

Expected: PASS

---

### Step 5: Write the failing picker tests

Open `web/src/__tests__/workspace-picker.test.ts`. Add two tests inside the **existing `describe('MuxWorkspacePicker', ...)`** block, after the existing `'dispatches workspace-create when the new-workspace button is clicked'` test:

```typescript
  it('disables the new-workspace button when createPending is true', async () => {
    el = document.createElement('mux-workspace-picker') as MuxWorkspacePicker;
    el.workspaces = makeWorkspaces();
    el.createPending = true;
    document.body.appendChild(el);
    await el.updateComplete;

    const btn = el.shadowRoot!.querySelector('button.ws-new') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('does NOT disable the new-workspace button when createPending is false', async () => {
    el = document.createElement('mux-workspace-picker') as MuxWorkspacePicker;
    el.workspaces = makeWorkspaces();
    el.createPending = false;
    document.body.appendChild(el);
    await el.updateComplete;

    const btn = el.shadowRoot!.querySelector('button.ws-new') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
```

### Step 6: Run to confirm the picker tests fail

```
cd web && npm run test:file src/__tests__/workspace-picker.test.ts
```

Expected: FAIL — `el.createPending` is not a known property; button is never disabled

---

### Step 7: Add `createPending` property to `MuxWorkspacePicker`

Open `web/src/components/workspace-picker.ts`. After the existing `erroredMutations` property declaration (line 193), add:

```typescript
  @property({ type: Boolean })
  createPending = false;
```

Then, update the `ws-new` button (currently at line 295) to use the property:

**Old:**
```typescript
          <button class="ws-new" @click="${this._onCreate}">
```

**New:**
```typescript
          <button class="ws-new" ?disabled="${this.createPending}" @click="${this._onCreate}">
```

Also add a disabled style rule to prevent the hover cursor on disabled state. In `static styles`, find the `.ws-new:hover` rule and add after it:

```css
    .ws-new:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      border-color: #45475a;
      background: transparent;
    }
```

### Step 8: Run to confirm the picker tests pass

```
cd web && npm run test:file src/__tests__/workspace-picker.test.ts
```

Expected: PASS

---

### Step 9: Wire `createPending` in `app.ts`

Open `web/src/app.ts`. Find the `mux-workspace-picker` template (inside the `${this._showWorkspacePicker ? html`...` }` block, around line 337). Add the `.createPending` binding:

**Old (partial):**
```typescript
        ? html`<mux-workspace-picker
            .workspaces="${store.workspaces}"
            .currentWorkspaceId="${store.attached ?? ''}"
            .erroredMutations="${store.erroredMutations}"
```

**New:**
```typescript
        ? html`<mux-workspace-picker
            .workspaces="${store.workspaces}"
            .currentWorkspaceId="${store.attached ?? ''}"
            .erroredMutations="${store.erroredMutations}"
            .createPending="${store.hasPendingKind('create')}"
```

### Step 10: Run fast check

```
cd web && npm run test:file src/__tests__/workspace-picker.test.ts && npm run check:fast
```

Expected: PASS + no lint/type errors

### Step 11: Commit

```
git add web/src/state.ts \
        web/src/components/workspace-picker.ts \
        web/src/app.ts \
        web/src/__tests__/state.workspace.test.ts \
        web/src/__tests__/workspace-picker.test.ts \
&& git commit -m "fix(web): disable new-workspace button while a create mutation is pending

- Add MuxStore.hasPendingKind(kind) — iterates non-errored pending records
- Add MuxWorkspacePicker.createPending boolean property
- Wire ?disabled on button.ws-new when createPending is true
- Pass store.hasPendingKind('create') from app to picker

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 2: Suppress terminal creation for provisional negative pane IDs

**Files:**
- Modify: `web/src/app.ts`
- Test: `web/src/__tests__/app.optimistic.test.ts`

---

### Step 1: Write the failing test

Open `web/src/__tests__/app.optimistic.test.ts`. Add a new `describe` block **at the bottom of the file**:

```typescript
describe('MuxApp _syncTerminals negative-pane guard', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    (store as unknown as { _pending: Map<string, unknown> })._pending.clear();
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    terminalRegistry.prune(new Set());
    el = null as unknown as MuxApp;
  });

  it('does not create a terminal for a provisional negative pane ID', async () => {
    el = await fixture();
    // Attach an empty workspace so the folded view has panes.
    store.applySessiond({ type: SessiondType.Composition, workspaceId: 'w1', panes: [] });

    const tempId = -777;
    // Push an optimistic pane with a strictly-negative temp ID (mirrors _createPaneOptimistic).
    store.mutate({
      kind: 'create-pane',
      optimistic: (draft) => draft.panes.push({ paneId: tempId, cols: 0, rows: 0 }),
      settled: () => false,
    });

    // Trigger willUpdate → _syncTerminals.
    el.requestUpdate();
    await el.updateComplete;

    // No terminal must be created for the negative pane.
    expect(terminalRegistry.getTerminal(tempId)).toBeNull();
  });

  it('still creates a terminal for a positive (real) pane ID', async () => {
    el = await fixture();
    store.applySessiond({
      type: SessiondType.Composition,
      workspaceId: 'w1',
      panes: [{ paneId: 42, cols: 80, rows: 24 }],
    });

    el.requestUpdate();
    await el.updateComplete;

    expect(terminalRegistry.getTerminal(42)).not.toBeNull();
  });
});
```

Note: `MutationDraft` must be importable for the inline `draft` type. Looking at existing tests, `store.mutate` already accepts an `optimistic` callback typed via inference — no explicit import is needed.

Also confirm that `store` (the singleton) and `terminalRegistry` are already imported at the top of `app.optimistic.test.ts` — both are imported at lines 3–4 of the file.

### Step 2: Run to confirm the test fails

```
cd web && npm run test:file src/__tests__/app.optimistic.test.ts
```

Expected: FAIL — `terminalRegistry.getTerminal(-777)` is NOT null (the guard doesn't exist yet)

---

### Step 3: Add the negative-pane guard in `_syncTerminals`

Open `web/src/app.ts`. Find `_syncTerminals()` (line 274). Update it as follows:

**Old:**
```typescript
  private _syncTerminals(): void {
    const liveIds = new Set<number>();
    for (const pane of store.panes) {
      const paneId = pane.paneId;
      terminalRegistry.ensure(paneId, {
        onInput: (data) => this._socket?.sendPaneInput(paneId, data),
        // Active-view-wins: only rendered/visible panes own a live
        // ResizeObserver, so tabbed-away panes never report a resize.
        onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
      });
      liveIds.add(paneId);
    }
    terminalRegistry.prune(liveIds);
  }
```

**New:**
```typescript
  private _syncTerminals(): void {
    const liveIds = new Set<number>();
    for (const pane of store.panes) {
      const paneId = pane.paneId;
      // Skip provisional overlay panes: _nextTempPaneId starts at -1 and
      // decrements, so any negative id is a transient optimistic placeholder.
      // Mounting a terminal on a provisional pane produces a phantom cursor
      // that flickers once the real positive-id pane settles.
      if (paneId < 0) continue;
      terminalRegistry.ensure(paneId, {
        onInput: (data) => this._socket?.sendPaneInput(paneId, data),
        // Active-view-wins: only rendered/visible panes own a live
        // ResizeObserver, so tabbed-away panes never report a resize.
        onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
      });
      liveIds.add(paneId);
    }
    terminalRegistry.prune(liveIds);
  }
```

### Step 4: Run to confirm the tests pass

```
cd web && npm run test:file src/__tests__/app.optimistic.test.ts
```

Expected: PASS

### Step 5: Run fast check

```
cd web && npm run test:file src/__tests__/app.optimistic.test.ts && npm run check:fast
```

Expected: PASS + no lint/type errors

### Step 6: Commit

```
git add web/src/app.ts \
        web/src/__tests__/app.optimistic.test.ts \
&& git commit -m "fix(web): skip terminal ensure for provisional negative pane IDs to prevent phantom cursor

Provisional optimistic panes use strictly-negative tempIds (_nextTempPaneId
starts at -1, decrements). Calling terminalRegistry.ensure() for them mounted
a phantom terminal that flickered for one render tick before the real pane
settled. Guard added: if (paneId < 0) continue.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 3: Move create-workspace socket send into `spec.commit`

**Files:**
- Modify: `web/src/app.ts`
- Test: `web/src/__tests__/app.optimistic.test.ts`

---

### Step 1: Write the failing retry test

Open `web/src/__tests__/app.optimistic.test.ts`. Inside the existing `describe('MuxApp optimistic workspace create', ...)` block, add a new test **after** the existing two tests:

```typescript
  it('re-sends createWorkspace on retry (commit must be wired into spec)', async () => {
    vi.useFakeTimers();
    try {
      el = await fixture();
      const socket = (el as unknown as { _socket: { createWorkspace: unknown } })._socket;
      const sendSpy = vi.spyOn(
        socket as { createWorkspace: (...a: unknown[]) => void },
        'createWorkspace',
      );

      (el as unknown as { _createWorkspaceOptimistic: () => void })._createWorkspaceOptimistic();

      // First send should happen immediately on create.
      expect(sendSpy).toHaveBeenCalledTimes(1);

      // Advance past the default 5 s timeout to mark the mutation errored.
      vi.advanceTimersByTime(5001);
      expect(store.erroredMutations).toHaveLength(1);

      // Retry must re-fire the socket send via spec.commit.
      const { id } = store.erroredMutations[0];
      store.retry(id);

      expect(sendSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
```

Note: `vi` is already imported at line 1 of `app.optimistic.test.ts`.

### Step 2: Run to confirm the test fails

```
cd web && npm run test:file src/__tests__/app.optimistic.test.ts
```

Expected: FAIL — `expect(sendSpy).toHaveBeenCalledTimes(2)` fails; `createWorkspace` is called only once because `store.retry` invokes `record.commit?.()` which is `undefined`.

---

### Step 3: Move the socket send into `spec.commit`

Open `web/src/app.ts`. Find `_createWorkspaceOptimistic` (line 374). Make the following change:

**Old:**
```typescript
  private _createWorkspaceOptimistic = (): void => {
    const ref = mintClientRef();
    store.mutate({
      workspaceId: ref,
      kind: 'create',
      optimistic: (draft) =>
        draft.workspaces.push({ workspaceId: ref, paneCount: 0, clientRef: ref }),
      settled: (base) => base.workspaces.some((w) => w.clientRef === ref),
      onTimeout: () => {
        /* no-op; Phase-2 marks errored row, must never silently vanish */
      },
    });
    this._socket?.createWorkspace(undefined, ref);
  };
```

**New:**
```typescript
  private _createWorkspaceOptimistic = (): void => {
    const ref = mintClientRef();
    store.mutate({
      workspaceId: ref,
      kind: 'create',
      optimistic: (draft) =>
        draft.workspaces.push({ workspaceId: ref, paneCount: 0, clientRef: ref }),
      settled: (base) => base.workspaces.some((w) => w.clientRef === ref),
      // commit is called by store.mutate() on creation AND by store.retry() on
      // retry. Keeping the send here (not inline after mutate) is what allows
      // retry to re-send. Mirrors the rename and close mutations.
      commit: () => this._socket?.createWorkspace(undefined, ref),
      onTimeout: () => {
        /* no-op; Phase-2 marks errored row, must never silently vanish */
      },
    });
  };
```

**Why this still works on first call:** `store.mutate()` at `state.ts:252` calls `spec.commit?.()` immediately after inserting the pending record. Moving the send into `commit` does not defer it — it fires at exactly the same point in the call stack.

### Step 4: Run to confirm the test passes

```
cd web && npm run test:file src/__tests__/app.optimistic.test.ts
```

Expected: PASS (all three workspace create tests pass, including the new retry test)

### Step 5: Run fast check

```
cd web && npm run test:file src/__tests__/app.optimistic.test.ts && npm run check:fast
```

Expected: PASS + no lint/type errors

### Step 6: Commit

```
git add web/src/app.ts \
        web/src/__tests__/app.optimistic.test.ts \
&& git commit -m "fix(web): wire create-workspace socket send via spec.commit so retry works

The send was inline after store.mutate(), invisible to store.retry() which
only calls record.commit?.(). Moved into commit: () => ..., matching the
rename and close mutation pattern. store.mutate() calls spec.commit?()
immediately so first-call behaviour is unchanged.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 4: Remove `WorkspaceRenamed` and `WorkspaceClosed` from `applySessiond`

**Files:**
- Modify: `web/src/state.ts`
- Modify: `web/src/__tests__/state.workspace.test.ts`

> **CAUTION before starting:** Search for all references to `SessiondType.WorkspaceClosed` and `SessiondType.WorkspaceRenamed` outside of `state.ts` and `state.workspace.test.ts`. Run:
> ```
> cd web && grep -r "WorkspaceClosed\|WorkspaceRenamed" src/ --include="*.ts" -l
> ```
> If either constant appears in `ws.ts`, any component, or any test file other than the two listed above, keep the constant in `types.ts` but still remove the `applySessiond` handler. Only remove a constant from `types.ts` if it is confirmed unreferenced everywhere except the handler being deleted.

---

### Step 1: Write the failing no-op tests

Open `web/src/__tests__/state.workspace.test.ts`. Add a new `describe` block **at the bottom of the file**, after the `hasPendingKind` block from Task 1:

```typescript
describe('workspace-renamed and workspace-closed are no-ops after Phase 1', () => {
  it('workspace-renamed has no effect on the store (handler removed)', () => {
    const store = new MuxStore();
    store.applySessiond(
      workspaceList([{ workspaceId: 'ws-1', name: 'before', paneCount: 0 }]),
    );
    // After the Phase 1 Go change, workspace-list is authoritative.
    // The workspace-renamed handler must be gone; this must be a no-op.
    store.applySessiond(workspaceRenamed('ws-1', 'after'));
    expect(store.workspaces[0].name).toBe('before');
  });

  it('workspace-closed has no effect on workspaces (workspace-list is authoritative)', () => {
    const store = new MuxStore();
    store.applySessiond(
      workspaceList([{ workspaceId: 'ws-1', name: 'dev', paneCount: 1 }]),
    );
    // After the Phase 1 Go change, workspace-list drives removals.
    // The workspace-closed handler must be gone; this must be a no-op.
    store.applySessiond(workspaceClosed('ws-1'));
    expect(store.workspaces).toHaveLength(1);
  });
});
```

Note: `workspaceRenamed` and `workspaceClosed` helper functions are already declared near the top of the file (lines 28–37).

### Step 2: Run to confirm the new tests fail

```
cd web && npm run test:file src/__tests__/state.workspace.test.ts
```

Expected: FAIL — the handlers currently exist and mutate state, so:
- `workspace-renamed` test fails: `store.workspaces[0].name` is `'after'` not `'before'`
- `workspace-closed` test fails: `store.workspaces` is `[]` not length 1

---

### Step 3: Remove the dead handlers from `applySessiond`

Open `web/src/state.ts`. Find and delete the entire `WorkspaceClosed` case block (lines 163–174):

```typescript
      case SessiondType.WorkspaceClosed: {
        const workspaceId = msg.workspaceId ?? null;
        this._workspaces = this._workspaces.filter(
          (w) => w.workspaceId !== workspaceId,
        );
        if (this._attached === workspaceId) {
          this._attached = null;
          this._panes = [];
          this._activePaneId = 0;
        }
        break;
      }
```

> ⚠️ **Attachment-clearing note:** Removing this case means the client no longer clears `_attached` when the currently-attached workspace is closed via `workspace-closed`. After Phase 1, the server sends `workspace-list` (which replaces `_workspaces` wholesale) instead of `workspace-closed` for close events. The WorkspaceController is responsible for detecting an orphaned attachment. If the full test suite reveals regressions in attachment-clearing behaviour, a follow-up fix in the `WorkspaceList` handler (checking whether `_attached` is still present in the new list) should be planned separately.

Also delete the entire `WorkspaceRenamed` case block (currently lines 192–199, renumber after the previous deletion):

```typescript
      case SessiondType.WorkspaceRenamed: {
        this._workspaces = this._workspaces.map((w) =>
          w.workspaceId === msg.workspaceId
            ? { ...w, name: msg.name ? msg.name : undefined }
            : w,
        );
        break;
      }
```

The `default: return;` case at the end of `applySessiond` remains in place — unhandled types fall through to it and become no-ops.

### Step 4: Run to confirm the new no-op tests pass

```
cd web && npm run test:file src/__tests__/state.workspace.test.ts
```

Expected: The two new tests PASS. Several existing tests may now FAIL — proceed to Step 5.

---

### Step 5: Remove the obsolete old tests

The following tests in `state.workspace.test.ts` verify behaviour that has been intentionally removed. Delete them:

**Delete** (currently around lines 119–133):
```typescript
  it('clears attachment on workspace-closed and ignores a trailing pane-closed', () => {
    ...
  });
```

**Delete** (currently around lines 135–142):
```typescript
  it('updates the workspace label on workspace-renamed', () => {
    ...
  });
```

**Delete** (currently around lines 144–151):
```typescript
  it('clears the workspace label when workspace-renamed omits the name', () => {
    ...
  });
```

After deleting these three tests, run the test file again:

```
cd web && npm run test:file src/__tests__/state.workspace.test.ts
```

Expected: PASS — all remaining tests pass, all three deleted tests are gone.

---

### Step 6: Check whether the type constants can be removed

Run the search from the caution note at the top of this task:

```
cd web && grep -r "WorkspaceClosed\|WorkspaceRenamed" src/ --include="*.ts"
```

- If only `types.ts` and `state.workspace.test.ts` reference them (the helpers `workspaceClosed` / `workspaceRenamed` are test-only), the constants in `types.ts` are safe to remove.
- If any other file still references them (e.g., `ws.ts` routes on these types, or a component checks them), keep the constants in `types.ts` and leave a `// TODO: remove when server no longer sends these` comment.

**If safe to remove:** Delete the `WorkspaceClosed` and `WorkspaceRenamed` entries from the `SessiondType` const in `web/src/types.ts`:

```typescript
  // Events (server -> all clients)
  PaneAdded: 'pane-added',
  PaneClosed: 'pane-closed',
  WorkspaceClosed: 'workspace-closed',   // <-- delete this line
  WorkspaceRenamed: 'workspace-renamed', // <-- delete this line
```

Then remove or update the helper functions in `state.workspace.test.ts` that reference those types (`workspaceClosed` and `workspaceRenamed` at lines 28–37), since they will cause type errors. If removing them breaks remaining tests (the new no-op tests still reference them), replace the constant references with the raw string literals:

```typescript
const workspaceClosed = (workspaceId: string): SessiondMessage => ({
  type: 'workspace-closed' as SessiondMessageType,
  workspaceId,
});

const workspaceRenamed = (workspaceId: string, name?: string): SessiondMessage => ({
  type: 'workspace-renamed' as SessiondMessageType,
  workspaceId,
  name,
});
```

### Step 7: Run fast check

```
cd web && npm run test:file src/__tests__/state.workspace.test.ts && npm run check:fast
```

Expected: PASS + no lint/type errors

---

### Step 8: Run the full test gate

```
cd web && npm test && npm run check:fast
```

Expected: ALL GREEN. Investigate and fix any remaining failures before committing.

### Step 9: Commit

```
git add web/src/state.ts \
        web/src/types.ts \
        web/src/__tests__/state.workspace.test.ts \
&& git commit -m "fix(web): remove workspace-renamed and workspace-closed from applySessiond; workspace-list is authoritative

After Phase 1 Go changes the server broadcasts workspace-list for rename
and close events instead of targeted workspace-renamed / workspace-closed
messages. The two applySessiond handlers are now dead code that incorrectly
mutate store state from stale messages.

Removed:
- WorkspaceClosed case (workspaces filter + attachment clear)
- WorkspaceRenamed case (workspace map/rename)
- Three obsolete tests that verified the removed behaviour

Added:
- Two new no-op tests that confirm the messages are ignored

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Final verification

```
cd web && npm test && npm run check:fast
```

All tests green, no type errors, no lint warnings. Done.
