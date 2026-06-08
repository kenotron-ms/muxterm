# Attention Management — Phase 1: Bell State Infrastructure

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Wire the bell signal from xterm.js through MuxStore so every component can know which panes and workspaces have unacknowledged bells.
**Architecture:** Pure-logic bell state lives in `MuxStore` using timestamp pairs. `terminal-registry.ts` forwards xterm.js `onBell()` callbacks to the handler registered via `PaneHandlers`. `mux-app.ts` provides the handler and acknowledges panes on focus.
**Tech Stack:** TypeScript, Lit, Vitest (bell state only), no new dependencies.

---

## Prerequisite: understand existing patterns

Before starting any task, scan these files once to orient yourself:

- `web/src/state.ts` — `MuxStore` class, `subscribe()` pattern, `_notify()` convention
- `web/src/lib/terminal-registry.ts` — `PaneHandlers` interface (lines 81–86), `ensure()` method, how handlers are registered
- `web/src/app.ts` — `_syncTerminals()` method (~line 416), `_onActivePane` handler (~line 536)

---

## Task 1: Add CSS design tokens to `theme.ts`

**Files:**
- Modify: `web/src/lib/theme.ts`

### Step 1: Add 5 new tokens to `paletteToCSSVars()`

Open `web/src/lib/theme.ts`. The function `paletteToCSSVars()` currently returns a `Record<string, string>` mapping CSS variable names to values derived from the palette. Add five new entries to the returned object:

```ts
export function paletteToCSSVars(p: Palette): Record<string, string> {
  return {
    '--mux-bg': p.background,
    '--mux-fg': p.foreground,
    '--mux-accent': p.blue,
    '--mux-border': p.brightBlack,
    '--mux-selection': p.selectionBackground,
    '--mux-warn': p.yellow,
    '--mux-error': p.red,
    '--mux-ok': p.green,
    // ── New tokens for attention management + dock redesign ──────────────
    '--mux-bell':               'var(--mux-warn)',  // bell indicator dot color
    '--mux-dock-height':        '44px',             // dock bar row height / touch target
    '--mux-dock-item-padding':  '0 16px',           // horizontal padding on each dock slot
    '--mux-dock-font-size':     '0.85rem',          // workspace label font size
    '--mux-dock-active-weight': '600',              // active workspace label font weight
  };
}
```

### Step 2: Run check:fast

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npm run check:fast
```

Expected: 0 errors, 0 warnings.

### Step 3: Commit

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git add web/src/lib/theme.ts
git commit -m "feat: add attention management CSS design tokens to theme.ts"
```

---

## Task 2: Add bell state to `MuxStore` and write vitest tests

**Files:**
- Modify: `web/src/state.ts`
- Create: `web/src/__tests__/bell-state.test.ts`

### Step 1: Add `BellRecord` interface + private fields to `state.ts`

Open `web/src/state.ts`. Find the line `export class MuxStore {`. Add the `BellRecord` interface immediately **before** the class declaration:

```ts
// Bell state — timestamp pair per entity.
// A bell is "active" when lastFiredAt > ackedAt.
interface BellRecord {
  lastFiredAt: number; // ms timestamp when bell last fired
  ackedAt:     number; // ms timestamp when user last acknowledged (0 = never)
}
```

Inside the `MuxStore` class, after the existing private field declarations (after the line `private _mutationSeq = 0;`), add:

```ts
// ── Bell state ─────────────────────────────────────────────────────────
private _bellPanes:      Map<number, BellRecord> = new Map();
private _bellWorkspaces: Map<string,  BellRecord> = new Map();
```

### Step 2: Add the 5 public bell methods to `MuxStore`

Add these methods to `MuxStore`, anywhere after the existing public methods (e.g., after `setActivePane()`):

```ts
// ── Bell state public API ──────────────────────────────────────────────

/**
 * Record a bell for a pane and its workspace.
 * Called by the app when xterm.js fires onBell() for a pane.
 */
markBell(paneId: number, wsId: string): void {
  const now = Date.now();
  const paneRecord = this._bellPanes.get(paneId) ?? { lastFiredAt: 0, ackedAt: 0 };
  this._bellPanes.set(paneId, { ...paneRecord, lastFiredAt: now });
  const wsRecord = this._bellWorkspaces.get(wsId) ?? { lastFiredAt: 0, ackedAt: 0 };
  this._bellWorkspaces.set(wsId, { ...wsRecord, lastFiredAt: now });
  this._notify();
}

/**
 * Acknowledge the bell for a specific pane (called when the user focuses it).
 * Clears the pane tab dot only — workspace dot is independent.
 */
ackPane(paneId: number): void {
  const record = this._bellPanes.get(paneId);
  if (!record) return;
  this._bellPanes.set(paneId, { ...record, ackedAt: Date.now() });
  this._notify();
}

/**
 * Acknowledge the bell for a workspace (called when the user switches to it).
 * Clears the dock dot only — pane tab dots are independent.
 */
ackWorkspace(wsId: string): void {
  const record = this._bellWorkspaces.get(wsId);
  if (!record) return;
  this._bellWorkspaces.set(wsId, { ...record, ackedAt: Date.now() });
  this._notify();
}

/**
 * Returns true if the pane has an unacknowledged bell
 * (lastFiredAt > ackedAt, meaning a new bell fired after the last ack).
 */
paneBellActive(paneId: number): boolean {
  const r = this._bellPanes.get(paneId);
  if (!r) return false;
  return r.lastFiredAt > r.ackedAt;
}

/**
 * Returns true if the workspace has an unacknowledged bell.
 */
workspaceBellActive(wsId: string): boolean {
  const r = this._bellWorkspaces.get(wsId);
  if (!r) return false;
  return r.lastFiredAt > r.ackedAt;
}
```

### Step 3: Write the vitest test file

Create `web/src/__tests__/bell-state.test.ts` with this exact content:

```ts
import { describe, it, expect } from 'vitest';
import { MuxStore } from '../state';

// Helper: create a store with a bell already marked on pane 1, workspace 'ws-1'.
function storeWithBell(): MuxStore {
  const store = new MuxStore();
  store.markBell(1, 'ws-1');
  return store;
}

describe('MuxStore bell state', () => {
  describe('markBell', () => {
    it('makes paneBellActive true for the given paneId', () => {
      const store = new MuxStore();
      expect(store.paneBellActive(1)).toBe(false);
      store.markBell(1, 'ws-1');
      expect(store.paneBellActive(1)).toBe(true);
    });

    it('makes workspaceBellActive true for the given wsId', () => {
      const store = new MuxStore();
      expect(store.workspaceBellActive('ws-1')).toBe(false);
      store.markBell(1, 'ws-1');
      expect(store.workspaceBellActive('ws-1')).toBe(true);
    });

    it('notifies subscribers', () => {
      const store = new MuxStore();
      let calls = 0;
      store.subscribe(() => { calls++; });
      store.markBell(1, 'ws-1');
      expect(calls).toBe(1);
    });

    it('firing a second bell after ack re-activates both indicators', () => {
      const store = storeWithBell();
      store.ackPane(1);
      store.ackWorkspace('ws-1');
      expect(store.paneBellActive(1)).toBe(false);
      expect(store.workspaceBellActive('ws-1')).toBe(false);
      // New bell — both re-activate
      store.markBell(1, 'ws-1');
      expect(store.paneBellActive(1)).toBe(true);
      expect(store.workspaceBellActive('ws-1')).toBe(true);
    });
  });

  describe('ackPane', () => {
    it('clears paneBellActive for the pane', () => {
      const store = storeWithBell();
      store.ackPane(1);
      expect(store.paneBellActive(1)).toBe(false);
    });

    it('does NOT clear workspaceBellActive', () => {
      const store = storeWithBell();
      store.ackPane(1);
      expect(store.workspaceBellActive('ws-1')).toBe(true);
    });

    it('is a safe no-op for unknown paneIds', () => {
      const store = new MuxStore();
      expect(() => store.ackPane(99)).not.toThrow();
    });

    it('notifies subscribers', () => {
      const store = storeWithBell();
      let calls = 0;
      store.subscribe(() => { calls++; });
      store.ackPane(1);
      expect(calls).toBe(1);
    });
  });

  describe('ackWorkspace', () => {
    it('clears workspaceBellActive for the workspace', () => {
      const store = storeWithBell();
      store.ackWorkspace('ws-1');
      expect(store.workspaceBellActive('ws-1')).toBe(false);
    });

    it('does NOT clear paneBellActive', () => {
      const store = storeWithBell();
      store.ackWorkspace('ws-1');
      expect(store.paneBellActive(1)).toBe(true);
    });

    it('is a safe no-op for unknown wsIds', () => {
      const store = new MuxStore();
      expect(() => store.ackWorkspace('unknown')).not.toThrow();
    });

    it('notifies subscribers', () => {
      const store = storeWithBell();
      let calls = 0;
      store.subscribe(() => { calls++; });
      store.ackWorkspace('ws-1');
      expect(calls).toBe(1);
    });
  });

  describe('independent acks', () => {
    it('ackPane and ackWorkspace clear dots independently', () => {
      const store = storeWithBell();
      store.ackPane(1);
      expect(store.paneBellActive(1)).toBe(false);
      expect(store.workspaceBellActive('ws-1')).toBe(true);

      store.ackWorkspace('ws-1');
      expect(store.workspaceBellActive('ws-1')).toBe(false);
    });
  });
});
```

### Step 4: Run tests

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npx vitest run bell-state
```

Expected: all tests pass (10 tests, 0 failures).

### Step 5: Run check:fast

```bash
npm run check:fast
```

Expected: 0 errors, 0 warnings.

### Step 6: Commit

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git add web/src/state.ts web/src/__tests__/bell-state.test.ts
git commit -m "feat: add bell state to MuxStore with timestamp-pair model"
```

---

## Task 3: Wire `onBell` in `terminal-registry.ts`

**Files:**
- Modify: `web/src/lib/terminal-registry.ts`

### Step 1: Add `onBell?` to `PaneHandlers`

Open `web/src/lib/terminal-registry.ts`. Find the `PaneHandlers` interface (around line 81):

```ts
export interface PaneHandlers {
  /** Called when the user types / pastes / SGR mouse events arrive. */
  onInput: (data: Uint8Array) => void;
  /** Called (idempotently) when the terminal cols/rows change. */
  onResize: (cols: number, rows: number) => void;
}
```

Replace it with:

```ts
export interface PaneHandlers {
  /** Called when the user types / pastes / SGR mouse events arrive. */
  onInput: (data: Uint8Array) => void;
  /** Called (idempotently) when the terminal cols/rows change. */
  onResize: (cols: number, rows: number) => void;
  /** Called when the terminal fires a bell (\\a). Optional — no-ops if absent. */
  onBell?: (paneId: number) => void;
}
```

### Step 2: Wire `term.onBell()` in `ensure()`

Inside `ensure()`, find the block that registers terminal event handlers. Currently, after the touch scroll block and before `_map.set(key, entry)`, there are handlers for `onData`, `onBinary`, and `onResize`. Add the bell subscription immediately after the `onResize` block and before the touch-scroll block (or after it — order doesn't matter):

Find this exact line in `ensure()`:
```ts
    // Touch scroll — xterm.js v6 regressed native touch-scroll support
```

Just before that comment, insert:

```ts
    // Forward bell (\\a) to the registered handler via optional chaining —
    // safe to call even when onBell is not provided.
    term.onBell(() => {
      entry.handlers.onBell?.(paneId);
    });

```

The full context (for orientation) looks like this after the edit:

```ts
    // Resize: idempotent — only fires handler when dimensions actually change.
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (cols === entry.lastCols && rows === entry.lastRows) return;
      entry.lastCols = cols;
      entry.lastRows = rows;
      entry.handlers.onResize(cols, rows);
    });

    // Forward bell (\a) to the registered handler via optional chaining —
    // safe to call even when onBell is not provided.
    term.onBell(() => {
      entry.handlers.onBell?.(paneId);
    });

    // Touch scroll — xterm.js v6 regressed...
```

### Step 3: Run check:fast

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npm run check:fast
```

Expected: 0 errors, 0 warnings.

### Step 4: Commit

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git add web/src/lib/terminal-registry.ts
git commit -m "feat: wire onBell callback in terminal-registry PaneHandlers"
```

---

## Task 4: Provide `onBell` handler and `ackPane` in `app.ts`

**Files:**
- Modify: `web/src/app.ts`

### Step 1: Add `onBell` to the handlers in `_syncTerminals()`

Open `web/src/app.ts`. Find `_syncTerminals()` (~line 416). It calls `terminalRegistry.ensure(paneId, { ... })` with `onInput` and `onResize`. Add `onBell` to that object:

Find this block:
```ts
      terminalRegistry.ensure(paneId, {
        onInput: (data) => this._socket?.sendPaneInput(paneId, data),
        // Active-view-wins: only rendered/visible panes own a live
        // ResizeObserver, so tabbed-away panes never report a resize.
        onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
      });
```

Replace it with:
```ts
      terminalRegistry.ensure(paneId, {
        onInput: (data) => this._socket?.sendPaneInput(paneId, data),
        // Active-view-wins: only rendered/visible panes own a live
        // ResizeObserver, so tabbed-away panes never report a resize.
        onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
        // Read store.attached inside the callback at bell-fire time — NOT at
        // registration time — so workspace switches after registration still
        // attribute bells to the correct workspace.
        onBell: (bellPaneId) => store.markBell(bellPaneId, store.attached ?? ''),
      });
```

> **Important:** The parameter is named `bellPaneId` (not `paneId`) to avoid shadowing the outer `paneId` variable from the `for` loop. This matters because the callback closes over the outer scope.

### Step 2: Add `store.ackPane()` to `_onActivePane`

Find the `_onActivePane` handler (~line 536):

```ts
  /** Client-local active-pane selection (sessiond has no select-pane message). */
  private _onActivePane = (e: CustomEvent<{ paneId: number }>): void => {
    store.setActivePane(e.detail.paneId);
  };
```

Replace it with:

```ts
  /** Client-local active-pane selection (sessiond has no select-pane message). */
  private _onActivePane = (e: CustomEvent<{ paneId: number }>): void => {
    store.setActivePane(e.detail.paneId);
    store.ackPane(e.detail.paneId);
  };
```

### Step 3: Run check:fast

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npm run check:fast
```

Expected: 0 errors, 0 warnings.

### Step 4: Commit

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git add web/src/app.ts
git commit -m "feat: provide onBell callback in _syncTerminals, ackPane on focus"
```

---

## Phase 1 complete

Bell state infrastructure is fully wired. To verify the full chain works, you can run all tests:

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npx vitest run
```

Expected: all tests pass (bell-state + all existing tests).
