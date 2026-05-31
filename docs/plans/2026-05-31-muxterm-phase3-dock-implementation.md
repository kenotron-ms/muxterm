# muxterm Phase 3 — Layer-2 Dock Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Give muxterm a Layer-2 workspace "brain" so it can mount **multiple tmux windows (surfaces) at once**, each sized independently via a cell-budget handoff, with smooth two-clock resize, heavy region dividers, and maximize/restore.

**Architecture:** Two nested layout authorities with a hard boundary. **Layer 1 = tmux** owns the splits *inside* a window (the existing `<mux-layout>`, untouched). **Layer 2 = muxterm** owns *where* windows are shown: it arranges N **surfaces** (one tmux window rendered as an opaque block) into **regions** separated by heavy dividers. The only value crossing the boundary is **one `cols×rows` cell budget per surface**. Each visible surface gets its **own `tmux -CC` control client** so tmux can size each window to the client viewing it. Resize runs on **two decoupled clocks**: a 60fps PIXEL clock (CSS/xterm only, no backend) and a debounced ~40ms CELL clock that emits `refresh-client -C WxH` only when a cell boundary is actually crossed.

**Tech Stack:** Frontend — TypeScript, Lit 3, xterm.js v6, Vite, Vitest (happy-dom). Backend — Go, tmux control mode (`tmux -CC`). E2E — `playwright-cli` against the running `make dev` server on **`localhost:8080`**, using the Phase-2 verification harness (xterm.js `StructuredSnapshot`, **no OCR**).

---

## Phase 1 & 2 Actuals (grounding for implementers)

These are the actual seams delivered by Phases 1 and 2. Use these exact names — do not use the plan's hypothetical names when they conflict.

### Go Backend — `TmuxEngine` interface (internal/server/ws.go:20–45)

15 methods, ALL session-agnostic (no session-ID parameter on any method):

```go
State() *tmux.TmuxState
LiveState() (*tmux.TmuxState, error)
SendKeys(paneID, keys string) error
SelectWindow(windowID string) error
SelectPane(paneID string) error
SplitWindow(targetPaneID string, horizontal bool) error
ResizePane(paneID string, cols, rows int) error
NewWindow(sessionID string) error
KillPane(paneID string) error
CloseWindow(windowID string) error
RenameWindow(windowID, name string) error
NewSession(name string) error
CapturePaneContent(paneID string) ([]byte, error)
AttachSession(name string) error  // Phase 1 addition
SessionList() []SessionInfo       // Phase 1 addition
```

**Phase 3 must add per-surface routing.** Recommended approach: add a factory method to `TmuxEngine`:
```go
// Add to TmuxEngine interface:
EngineForSession(name string) TmuxEngine
```
This returns a session-scoped sub-engine without breaking any existing callers. The concrete `controllerAdapter` at `cmd/muxterm/main.go:423` wraps `*controllerPool` and is the only implementation — extend it here.

### Go Backend — controllerPool (cmd/muxterm/controller_pool.go)

Package-private concrete type. Public seam for Phase 3:
- `pool.get(name string) *controllerSession` — returns the session's controller wrapper or nil
- `controllerSession.ctrl *tmux.Controller` — the actual control client for `select-window` + `refresh-client`
- `pool.claimPane(name, paneID string) bool` — first-attached-wins pane ownership

Phase 3's `SurfaceRouter` should use `pool.get(sessionName).ctrl` to get a per-session controller to run `select-window` and `refresh-client -C WxH` for that surface.

### Frontend — terminal-registry.ts (web/src/lib/terminal-registry.ts)

- Map keyed by `number` (not string): `Map<number, PaneEntry>`
- `PaneEntry` has: `{ term: Terminal, fitAddon: FitAddon, hostEl: HTMLElement, handlers, lastCols, lastRows, opened, pendingData, resizeObserver, resizeTimer }`
- Phase 2 added `snapshot(paneId: number): StructuredSnapshot` method
- Phase 2 added `window.__muxterm.snapshot(paneId)` for playwright-cli eval

### Phase 2 Verification Harness (use in E2E tasks)

- `window.__muxterm.snapshot(paneId: number)` → `StructuredSnapshot` (via `playwright-cli eval`)
- `web/e2e/helpers/fidelity.ts` exports: `compareContent(paneId, sessionName)` + `compareLayout(paneId, element)`
- Content fidelity: tmux `capture-pane -p -t %N` text == xterm.js snapshot text, per-row trailing-blank-exact
- Layout fidelity: xterm `viewportY` + cols×rows == playwright-cli `scrollTop` + `clientWidth`

### Types (web/src/types.ts)

- `ClientMessage` does NOT have a `session` tag yet (Phase 4 adds it for chrome routing)
- Phase 1 added: `{ type: 'attach-session'; name: string }` to `ClientMessage`
- Phase 1 added: `{ type: 'session-list'; data: { sessions: SessionInfo[] } }` to `ServerMessage`
- `SessionInfo = { name: string; windows: number }`
- Binary frames carry only 4-byte LE pane ID (no session identifier) — `%N` pane IDs are tmux-server-global, so pane-level routing works without a session tag

---

## Dependencies & Assumptions (READ FIRST)

This phase **builds on Phase 1 and Phase 2**. Before starting, confirm these exist (they are produced by the other phase plans):

1. **Phase 1 — controller pool.** A backend `controllerPool` that can lazily attach a `tmux -CC` control client. Phase 3 *extends* it from **per-session** to **per-visible-surface**. We isolate the new logic behind a small `SurfaceRouter` type so this plan is testable even if Phase 1's internals differ slightly — you wire `SurfaceRouter` to the pool in Task 9.
2. **Phase 2 — verification harness.** A global test hook `window.__muxterm.snapshot(paneId)` returning a `StructuredSnapshot` (grid of `{char,fg,bg,attrs}` + cursor + scrollback depth), plus two reusable assertion helpers. If the helper names differ, adapt the E2E tasks accordingly. The two fidelity assertions used in Tasks 12–14 are:
   - **CONTENT fidelity:** `tmux capture-pane -p -t %N` (right-trimmed) == `window.__muxterm.snapshot(N)` rows (right-trimmed).
   - **LAYOUT fidelity:** xterm `viewportY` + `cols/rows` == `playwright-cli`-measured `scrollTop` + `clientWidth`/`clientHeight`-derived geometry.

**Working directory:** `/Users/ken/workspace/ms/muxterm`. **Dev server:** assume `make dev` is already running and serving `http://localhost:8080` (the user keeps it running). Do **not** start a second one.

**Commands you will use repeatedly:**
- Frontend unit tests: `cd web && npm test` (runs `vitest run`). Single file: `cd web && npx vitest run src/lib/cell-budget.test.ts`.
- Frontend typecheck/build: `cd web && npm run build` (runs `tsc --noEmit && vite build`).
- Go tests: `go test ./...`. Single package: `go test ./internal/server/`.

**Scope (do NOT exceed):** dock/workspace manager, surfaces, cell-budget, two-clock resize, region dividers, maximize, per-surface control clients. **Out of scope (later phases):** pop-out OS window + full chrome styling (Phase 4 — Phase 3 uses *minimal/unstyled* region headers), config/polish (Phase 5), browser/settings surfaces, driver app, Tier-2, PWA. **Cut entirely:** in-page float. Keep the S1–S5 seams clean: single-surface mode is first-class, measurement is per-surface `ResizeObserver` (never `window.innerHeight`), all resize funnels through `setSurfacePixelBox`, and resize is async fire-and-forget.

---

## Task Overview (15 tasks)

| # | Component | Layer | Verify |
|---|-----------|-------|--------|
| 1 | `cell-budget.ts` px→cells pure math | FE lib | Vitest |
| 2 | `cell-budget.ts` `CellBudgetManager` + ResizeObserver | FE lib | Vitest |
| 3 | `resize-coalescer.ts` outbound debounce/latest-wins/no-op | FE lib | Vitest |
| 4 | `workspace.ts` model — invariant, mode, maximize | FE lib | Vitest |
| 5 | `region-divider.ts` heavy handle component | FE comp | Vitest |
| 6 | `region.ts` wraps `<mux-layout>` for one surface | FE comp | Vitest |
| 7 | `workspace.ts` `<mux-workspace>` dock manager | FE comp | Vitest |
| 8 | Wire `<mux-workspace>` into `app.ts` | FE | build |
| 9 | Backend `SurfaceRouter` — per-surface client + refresh routing | Go | `go test` |
| 10 | Backend `%output` dedup by global `%N` | Go | `go test` |
| 11 | Outbound resize wiring: ResizeObserver→budget→coalescer→ws | FE | Vitest+build |
| 12 | E2E dock mount of 2 surfaces (content+layout fidelity) | E2E | playwright-cli |
| 13 | E2E divider-drag resize propagation | E2E | playwright-cli |
| 14 | E2E maximize/restore | E2E | playwright-cli |
| 15 | Full suite green + final commit | all | all |

---

### Task 1: Cell-budget pure math (`px → cols×rows`)

The atom of the whole sizing model: convert a pixel box + measured cell size into a `cols×rows` budget. Pure, no DOM — fully unit-testable.

**Files:**
- Create: `web/src/lib/cell-budget.ts`
- Test: `web/src/lib/cell-budget.test.ts`

**Step 1: Write the failing test**

Create `web/src/lib/cell-budget.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pxBoxToCells, cellsEqual, MIN_COLS, MIN_ROWS } from './cell-budget.js';

describe('pxBoxToCells', () => {
  it('floors pixels to whole cells', () => {
    // 800px / 8px = 100 cols; 600px / 16px = 37.5 -> 37 rows
    expect(pxBoxToCells({ width: 800, height: 600 }, { cellWidth: 8, cellHeight: 16 })).toEqual({
      cols: 100,
      rows: 37,
    });
  });

  it('clamps to MIN_COLS / MIN_ROWS on a tiny box', () => {
    expect(pxBoxToCells({ width: 1, height: 1 }, { cellWidth: 8, cellHeight: 16 })).toEqual({
      cols: MIN_COLS,
      rows: MIN_ROWS,
    });
  });

  it('returns the minimum budget when cell metrics are not yet measured (0)', () => {
    expect(pxBoxToCells({ width: 800, height: 600 }, { cellWidth: 0, cellHeight: 0 })).toEqual({
      cols: MIN_COLS,
      rows: MIN_ROWS,
    });
  });

  it('cellsEqual compares both dimensions', () => {
    expect(cellsEqual({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    expect(cellsEqual({ cols: 80, rows: 24 }, { cols: 81, rows: 24 })).toBe(false);
    expect(cellsEqual({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/cell-budget.test.ts`
Expected: FAIL — `Failed to resolve import "./cell-budget.js"` / "pxBoxToCells is not a function".

**Step 3: Write minimal implementation**

Create `web/src/lib/cell-budget.ts`:

```ts
/**
 * cell-budget — the single value that crosses the Layer-2 / Layer-1 boundary.
 *
 * Layer 2 (muxterm) owns PIXELS. Layer 1 (tmux) owns CELLS. The ONLY thing that
 * crosses the boundary per surface is its cell budget: cols x rows. This module
 * converts a measured pixel box + cell metrics into that budget.
 */

/** A measured pixel box for one surface (NOT window.innerHeight — per-surface). */
export interface PixelBox {
  width: number;
  height: number;
}

/** Measured size of one terminal character cell, in CSS pixels. */
export interface CellMetrics {
  cellWidth: number;
  cellHeight: number;
}

/** The one value crossing the layer boundary. */
export interface CellBudget {
  cols: number;
  rows: number;
}

// tmux refuses absurd sizes; never emit below these.
export const MIN_COLS = 2;
export const MIN_ROWS = 1;

/** Convert a pixel box to a whole-cell budget (floor, clamped to minimums). */
export function pxBoxToCells(box: PixelBox, metrics: CellMetrics): CellBudget {
  if (metrics.cellWidth <= 0 || metrics.cellHeight <= 0) {
    return { cols: MIN_COLS, rows: MIN_ROWS };
  }
  const cols = Math.max(MIN_COLS, Math.floor(box.width / metrics.cellWidth));
  const rows = Math.max(MIN_ROWS, Math.floor(box.height / metrics.cellHeight));
  return { cols, rows };
}

/** True when two budgets are identical (used to no-op resizes). */
export function cellsEqual(a: CellBudget, b: CellBudget): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/cell-budget.test.ts`
Expected: PASS — 4 passing.

**Step 5: Commit**

`git add web/src/lib/cell-budget.ts web/src/lib/cell-budget.test.ts && git commit -m "feat(phase3): cell-budget px->cells pure math"`

---

### Task 2: `CellBudgetManager` + per-surface ResizeObserver (`setSurfacePixelBox`)

Seam **S3**: ONE input-agnostic entry point, `setSurfacePixelBox(surfaceId, box)`, fed by a **per-surface `ResizeObserver`** (NOT `window.innerHeight`). It converts to cells and forwards to a sink (the coalescer, wired later).

**Files:**
- Modify: `web/src/lib/cell-budget.ts`
- Modify: `web/src/lib/cell-budget.test.ts`

**Step 1: Write the failing test**

Append to `web/src/lib/cell-budget.test.ts`:

```ts
import { CellBudgetManager } from './cell-budget.js';

describe('CellBudgetManager', () => {
  it('setSurfacePixelBox emits a converted budget to the sink', () => {
    const emitted: Array<{ id: string; budget: { cols: number; rows: number } }> = [];
    const mgr = new CellBudgetManager((id, budget) => emitted.push({ id, budget }));
    mgr.setSurfaceMetrics('s1', { cellWidth: 8, cellHeight: 16 });
    mgr.setSurfacePixelBox('s1', { width: 800, height: 320 });
    expect(emitted).toEqual([{ id: 's1', budget: { cols: 100, rows: 20 } }]);
  });

  it('emits even when only pixels (not cells) changed — coalescer owns no-op', () => {
    const emitted: Array<{ cols: number; rows: number }> = [];
    const mgr = new CellBudgetManager((_id, b) => emitted.push(b));
    mgr.setSurfaceMetrics('s1', { cellWidth: 8, cellHeight: 16 });
    mgr.setSurfacePixelBox('s1', { width: 800, height: 320 }); // 100x20
    mgr.setSurfacePixelBox('s1', { width: 803, height: 323 }); // still 100x20
    expect(emitted.length).toBe(2);
  });

  it('uses minimum budget before metrics are set', () => {
    const emitted: Array<{ cols: number; rows: number }> = [];
    const mgr = new CellBudgetManager((_id, b) => emitted.push(b));
    mgr.setSurfacePixelBox('s1', { width: 800, height: 320 });
    expect(emitted[0]).toEqual({ cols: 2, rows: 1 });
  });

  it('observe() attaches a ResizeObserver and unobserve() detaches it', () => {
    const observed: unknown[] = [];
    const disconnected: unknown[] = [];
    // Minimal fake ResizeObserver so happy-dom does not need the real one.
    class FakeRO {
      constructor(public cb: () => void) {}
      observe(el: unknown) { observed.push(el); }
      disconnect() { disconnected.push(true); }
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeRO;
    const mgr = new CellBudgetManager(() => {});
    const el = { clientWidth: 800, clientHeight: 320 } as unknown as HTMLElement;
    mgr.observe('s1', el, { cellWidth: 8, cellHeight: 16 });
    expect(observed.length).toBe(1);
    mgr.unobserve('s1');
    expect(disconnected.length).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/cell-budget.test.ts`
Expected: FAIL — "CellBudgetManager is not a constructor".

**Step 3: Write minimal implementation**

Append to `web/src/lib/cell-budget.ts`:

```ts
/** Sink invoked with the latest cell budget for a surface. */
export type BudgetSink = (surfaceId: string, budget: CellBudget) => void;

/**
 * CellBudgetManager — the input-agnostic resize entry point (seam S3).
 *
 * Every resize trigger (mouse-drag, media-query, OS-window-resize, future touch)
 * funnels through setSurfacePixelBox(). Measurement uses a per-surface
 * ResizeObserver on the surface's own element — never global window.innerHeight.
 * Conversion to cells happens here; the DECISION to suppress no-op resizes lives
 * downstream in the coalescer, so this manager always forwards.
 */
export class CellBudgetManager {
  private metrics = new Map<string, CellMetrics>();
  private observers = new Map<string, ResizeObserver>();

  constructor(private sink: BudgetSink) {}

  /** Record (or update) the measured cell size for a surface. */
  setSurfaceMetrics(surfaceId: string, metrics: CellMetrics): void {
    this.metrics.set(surfaceId, metrics);
  }

  /** THE single input-agnostic resize entry point. Converts px -> cells, forwards. */
  setSurfacePixelBox(surfaceId: string, box: PixelBox): void {
    const metrics = this.metrics.get(surfaceId) ?? { cellWidth: 0, cellHeight: 0 };
    this.sink(surfaceId, pxBoxToCells(box, metrics));
  }

  /** Observe a surface's element; feed clientWidth/Height through the entry point. */
  observe(surfaceId: string, el: HTMLElement, metrics: CellMetrics): void {
    this.setSurfaceMetrics(surfaceId, metrics);
    this.unobserve(surfaceId);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      this.setSurfacePixelBox(surfaceId, {
        width: el.clientWidth,
        height: el.clientHeight,
      });
    });
    ro.observe(el);
    this.observers.set(surfaceId, ro);
  }

  /** Stop observing a surface (on unmount / maximize-hide). */
  unobserve(surfaceId: string): void {
    this.observers.get(surfaceId)?.disconnect();
    this.observers.delete(surfaceId);
  }

  /** Tear down all observers. */
  dispose(): void {
    for (const ro of this.observers.values()) ro.disconnect();
    this.observers.clear();
    this.metrics.clear();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/cell-budget.test.ts`
Expected: PASS — 8 passing.

**Step 5: Commit**

`git add web/src/lib/cell-budget.ts web/src/lib/cell-budget.test.ts && git commit -m "feat(phase3): CellBudgetManager + per-surface ResizeObserver (S3 entry point)"`

---

### Task 3: Outbound resize coalescer (CELL clock)

The CELL clock: debounce ~40ms, **latest-wins**, and **no-op when no cell boundary was crossed**. Mirrors the existing inbound 40ms coalescer onto the OUTBOUND path. This is what protects the PTY channel from a 60fps drag flood.

**Files:**
- Create: `web/src/lib/resize-coalescer.ts`
- Test: `web/src/lib/resize-coalescer.test.ts`

**Step 1: Write the failing test**

Create `web/src/lib/resize-coalescer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResizeCoalescer } from './resize-coalescer.js';

describe('ResizeCoalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces a burst to one emit (latest-wins)', () => {
    const sent: Array<{ id: string; cols: number; rows: number }> = [];
    const c = new ResizeCoalescer((id, b) => sent.push({ id, ...b }), 40);
    c.push('s1', { cols: 80, rows: 24 });
    c.push('s1', { cols: 90, rows: 24 });
    c.push('s1', { cols: 100, rows: 30 });
    expect(sent.length).toBe(0); // nothing yet — still debouncing
    vi.advanceTimersByTime(40);
    expect(sent).toEqual([{ id: 's1', cols: 100, rows: 30 }]); // only the latest
  });

  it('no-ops when the budget did not cross a cell boundary (== lastSent)', () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const c = new ResizeCoalescer((_id, b) => sent.push(b), 40);
    c.push('s1', { cols: 80, rows: 24 });
    vi.advanceTimersByTime(40);
    expect(sent.length).toBe(1);
    c.push('s1', { cols: 80, rows: 24 }); // same cells — must NOT emit
    vi.advanceTimersByTime(40);
    expect(sent.length).toBe(1);
  });

  it('emits again once cells actually change', () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const c = new ResizeCoalescer((_id, b) => sent.push(b), 40);
    c.push('s1', { cols: 80, rows: 24 });
    vi.advanceTimersByTime(40);
    c.push('s1', { cols: 81, rows: 24 });
    vi.advanceTimersByTime(40);
    expect(sent).toEqual([{ cols: 80, rows: 24 }, { cols: 81, rows: 24 }]);
  });

  it('keeps per-surface budgets independent', () => {
    const sent: Array<{ id: string; cols: number; rows: number }> = [];
    const c = new ResizeCoalescer((id, b) => sent.push({ id, ...b }), 40);
    c.push('s1', { cols: 80, rows: 24 });
    c.push('s2', { cols: 120, rows: 40 });
    vi.advanceTimersByTime(40);
    expect(sent).toContainEqual({ id: 's1', cols: 80, rows: 24 });
    expect(sent).toContainEqual({ id: 's2', cols: 120, rows: 40 });
    expect(sent.length).toBe(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/resize-coalescer.test.ts`
Expected: FAIL — `Failed to resolve import "./resize-coalescer.js"`.

**Step 3: Write minimal implementation**

Create `web/src/lib/resize-coalescer.ts`:

```ts
/**
 * resize-coalescer — the CELL clock on the OUTBOUND resize path.
 *
 * A divider drag / OS-window resize fires the PIXEL clock at ~60fps. We must NOT
 * round-trip every frame to tmux. This coalescer:
 *   - debounces a burst into one emit (default 40ms),
 *   - keeps only the LATEST budget per surface (latest-wins),
 *   - NO-OPS when the new budget did not cross a cell boundary (== lastSent).
 *
 * Mirror of the existing inbound stateSync 40ms coalescer, applied outbound.
 */

import type { CellBudget } from './cell-budget.js';
import { cellsEqual } from './cell-budget.js';

export type ResizeSink = (surfaceId: string, budget: CellBudget) => void;

export class ResizeCoalescer {
  private pending = new Map<string, CellBudget>();
  private lastSent = new Map<string, CellBudget>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private sink: ResizeSink, private delayMs = 40) {}

  /** Offer a new budget for a surface. Coalesced + cell-quantized. */
  push(surfaceId: string, budget: CellBudget): void {
    const last = this.lastSent.get(surfaceId);
    if (last && cellsEqual(last, budget)) {
      // No cell boundary crossed since last emit — drop, and discard any stale pending.
      this.pending.delete(surfaceId);
      return;
    }
    this.pending.set(surfaceId, budget); // latest-wins
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** Emit all pending budgets that still differ from lastSent. */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const [surfaceId, budget] of this.pending) {
      const last = this.lastSent.get(surfaceId);
      if (last && cellsEqual(last, budget)) continue;
      this.lastSent.set(surfaceId, budget);
      this.sink(surfaceId, budget);
    }
    this.pending.clear();
  }

  /** Forget a surface entirely (on unmount). */
  forget(surfaceId: string): void {
    this.pending.delete(surfaceId);
    this.lastSent.delete(surfaceId);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.lastSent.clear();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/resize-coalescer.test.ts`
Expected: PASS — 4 passing.

**Step 5: Commit**

`git add web/src/lib/resize-coalescer.ts web/src/lib/resize-coalescer.test.ts && git commit -m "feat(phase3): outbound resize coalescer (CELL clock: debounce/latest-wins/no-op)"`

---

### Task 4: Workspace model (invariant + mode + maximize)

The Layer-2 brain as pure data: surfaces, regions, presentation mode (`docked|single`), the **one-window-one-surface invariant**, and maximize/restore (single-surface mode, seam S1).

**Files:**
- Create: `web/src/lib/workspace.ts`
- Test: `web/src/lib/workspace.test.ts`

**Step 1: Write the failing test**

Create `web/src/lib/workspace.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Workspace } from './workspace.js';

describe('Workspace', () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = new Workspace();
  });

  it('starts empty in single mode', () => {
    expect(ws.regions.length).toBe(0);
    expect(ws.mode).toBe('single');
  });

  it('openRegion mounts a surface and returns a region', () => {
    const r = ws.openRegion({ sessionName: 'work', windowId: 1 });
    expect(ws.regions.length).toBe(1);
    expect(r.surface.sessionName).toBe('work');
    expect(r.surface.windowId).toBe(1);
    expect(r.surface.id).toMatch(/^surf-/);
  });

  it('mode is docked once a second region opens', () => {
    ws.openRegion({ sessionName: 'work', windowId: 1 });
    expect(ws.mode).toBe('single');
    ws.openRegion({ sessionName: 'logs', windowId: 2 });
    expect(ws.mode).toBe('docked');
  });

  it('enforces one-window-one-surface invariant', () => {
    ws.openRegion({ sessionName: 'work', windowId: 1 });
    expect(() => ws.openRegion({ sessionName: 'work', windowId: 1 })).toThrow(
      /one-window-one-surface/,
    );
  });

  it('allows the same windowId in DIFFERENT sessions', () => {
    ws.openRegion({ sessionName: 'work', windowId: 1 });
    expect(() => ws.openRegion({ sessionName: 'logs', windowId: 1 })).not.toThrow();
    expect(ws.regions.length).toBe(2);
  });

  it('closeRegion removes it and frees the window', () => {
    const r = ws.openRegion({ sessionName: 'work', windowId: 1 });
    ws.closeRegion(r.id);
    expect(ws.regions.length).toBe(0);
    expect(() => ws.openRegion({ sessionName: 'work', windowId: 1 })).not.toThrow();
  });

  it('maximize forces single mode and exposes one visible region', () => {
    ws.openRegion({ sessionName: 'work', windowId: 1 });
    const r2 = ws.openRegion({ sessionName: 'logs', windowId: 2 });
    expect(ws.mode).toBe('docked');
    ws.maximize(r2.id);
    expect(ws.mode).toBe('single');
    expect(ws.visibleRegions.map((r) => r.id)).toEqual([r2.id]);
  });

  it('restore returns to docked when >1 region exists', () => {
    ws.openRegion({ sessionName: 'work', windowId: 1 });
    const r2 = ws.openRegion({ sessionName: 'logs', windowId: 2 });
    ws.maximize(r2.id);
    ws.restore();
    expect(ws.mode).toBe('docked');
    expect(ws.visibleRegions.length).toBe(2);
  });

  it('maximize on a non-existent region throws', () => {
    expect(() => ws.maximize('nope')).toThrow(/no such region/);
  });

  it('closing the maximized region clears the maximize flag', () => {
    const r1 = ws.openRegion({ sessionName: 'work', windowId: 1 });
    ws.openRegion({ sessionName: 'logs', windowId: 2 });
    ws.maximize(r1.id);
    ws.closeRegion(r1.id);
    expect(ws.maximizedRegionId).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/workspace.test.ts`
Expected: FAIL — `Failed to resolve import "./workspace.js"`.

**Step 3: Write minimal implementation**

Create `web/src/lib/workspace.ts`:

```ts
/**
 * workspace — the Layer-2 model (muxterm owns WHERE).
 *
 * A SURFACE is one tmux window rendered as an opaque block (Layer 1 renders its
 * internals). A REGION is a dock slot holding exactly one surface. Presentation
 * mode is `single` (one region OR a maximized region — seam S1) or `docked`
 * (N regions side by side). The one-window-one-surface invariant forbids the
 * same tmux window appearing in two surfaces (irreducible size conflict).
 */

export type PresentationMode = 'docked' | 'single';

/** Identifies which tmux window a surface shows. */
export interface SurfaceRef {
  sessionName: string;
  windowId: number;
}

export interface Surface extends SurfaceRef {
  /** Stable Layer-2 surface id, e.g. "surf-3". Used to route the cell budget. */
  id: string;
}

export interface Region {
  /** Stable region id, e.g. "region-3". */
  id: string;
  surface: Surface;
  /** Flex weight for docked layout (divider drags mutate this). */
  weight: number;
}

let _seq = 0;
function nextId(prefix: string): string {
  _seq += 1;
  return `${prefix}-${_seq}`;
}

export class Workspace {
  regions: Region[] = [];
  maximizedRegionId: string | null = null;

  /** single when 0/1 region OR a region is maximized; docked otherwise. */
  get mode(): PresentationMode {
    if (this.maximizedRegionId !== null) return 'single';
    return this.regions.length > 1 ? 'docked' : 'single';
  }

  /** The regions actually painted right now (one when maximized). */
  get visibleRegions(): Region[] {
    if (this.maximizedRegionId !== null) {
      const r = this.regions.find((x) => x.id === this.maximizedRegionId);
      return r ? [r] : this.regions;
    }
    return this.regions;
  }

  private assertWindowFree(ref: SurfaceRef): void {
    for (const region of this.regions) {
      if (
        region.surface.sessionName === ref.sessionName &&
        region.surface.windowId === ref.windowId
      ) {
        throw new Error(
          `window ${ref.sessionName}:${ref.windowId} is already mounted ` +
            `(one-window-one-surface invariant)`,
        );
      }
    }
  }

  /** Mount a tmux window as a new region beside the others. */
  openRegion(ref: SurfaceRef): Region {
    this.assertWindowFree(ref);
    const region: Region = {
      id: nextId('region'),
      surface: { id: nextId('surf'), sessionName: ref.sessionName, windowId: ref.windowId },
      weight: 1,
    };
    this.regions.push(region);
    return region;
  }

  closeRegion(regionId: string): void {
    this.regions = this.regions.filter((r) => r.id !== regionId);
    if (this.maximizedRegionId === regionId) this.maximizedRegionId = null;
  }

  /** Focus one region (single-surface mode, seam S1). */
  maximize(regionId: string): void {
    if (!this.regions.some((r) => r.id === regionId)) {
      throw new Error(`no such region ${regionId}`);
    }
    this.maximizedRegionId = regionId;
  }

  restore(): void {
    this.maximizedRegionId = null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/workspace.test.ts`
Expected: PASS — 10 passing.

**Step 5: Commit**

`git add web/src/lib/workspace.ts web/src/lib/workspace.test.ts && git commit -m "feat(phase3): workspace model (one-window-one-surface invariant, mode, maximize)"`

---

### Task 5: Heavy region divider component (`<mux-region-divider>`)

Layer-2's heavy `⋮`-handled divider — distinct weight from the thin tmux pane divider (`<mux-resize-handle>`). Emits a `region-resize-drag` event with the pixel delta; the PIXEL clock will consume it.

**Files:**
- Create: `web/src/components/region-divider.ts`
- Test: `web/src/components/region-divider.test.ts`

**Step 1: Write the failing test**

Create `web/src/components/region-divider.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import './region-divider.js';
import type { MuxRegionDivider } from './region-divider.js';

async function mount(): Promise<MuxRegionDivider> {
  const el = document.createElement('mux-region-divider') as MuxRegionDivider;
  el.direction = 'horizontal';
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('mux-region-divider', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a grab handle', async () => {
    const el = await mount();
    const handle = el.shadowRoot?.querySelector('.handle');
    expect(handle).not.toBeNull();
  });

  it('reflects direction to an attribute (for cursor CSS)', async () => {
    const el = await mount();
    expect(el.getAttribute('direction')).toBe('horizontal');
  });

  it('emits region-resize-drag with a pixel delta on pointer drag', async () => {
    const el = await mount();
    const events: Array<{ deltaX: number; deltaY: number }> = [];
    el.addEventListener('region-resize-drag', (e) => {
      events.push((e as CustomEvent).detail);
    });
    const handle = el.shadowRoot!.querySelector('.handle') as HTMLElement;
    handle.setPointerCapture = () => {};
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 100, clientY: 50, pointerId: 1, bubbles: true }),
    );
    handle.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 130, clientY: 50, bubbles: true }),
    );
    expect(events.at(-1)).toEqual({ deltaX: 30, deltaY: 0 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/region-divider.test.ts`
Expected: FAIL — `Failed to resolve import "./region-divider.js"`.

**Step 3: Write minimal implementation**

Create `web/src/components/region-divider.ts`:

```ts
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * mux-region-divider — the HEAVY Layer-2 divider between dock regions.
 *
 * Visually distinct from the thin tmux pane divider (mux-resize-handle): it is
 * thicker and carries a vertical grab handle (⋮), so layout reads at a glance:
 *   thin   = tmux pane boundary   (Layer 1)
 *   heavy  = muxterm region boundary, with handle (Layer 2)
 *
 * It emits `region-resize-drag` with a pixel delta. The workspace consumes that
 * on the PIXEL clock (60fps, CSS only); the backend round-trip is debounced
 * separately by the resize coalescer.
 */
@customElement('mux-region-divider')
export class MuxRegionDivider extends LitElement {
  static styles = css`
    :host {
      display: block;
      flex-shrink: 0;
    }
    :host([direction='horizontal']) {
      width: 8px;
      cursor: col-resize;
    }
    :host([direction='vertical']) {
      height: 8px;
      cursor: row-resize;
    }
    .handle {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #1f2335;
      color: #565f89;
      font-size: 10px;
      line-height: 1;
      transition: background 0.15s, color 0.15s;
      user-select: none;
    }
    .handle:hover,
    .handle.dragging {
      background: #292e42;
      color: #7aa2f7;
    }
  `;

  @property({ type: String, reflect: true })
  direction: 'horizontal' | 'vertical' = 'horizontal';

  private _dragging = false;
  private _startX = 0;
  private _startY = 0;

  private _onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    this._dragging = true;
    this._startX = e.clientX;
    this._startY = e.clientY;
    this.requestUpdate();

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);

    const onMove = (move: PointerEvent): void => {
      this.dispatchEvent(
        new CustomEvent('region-resize-drag', {
          bubbles: true,
          composed: true,
          detail: { deltaX: move.clientX - this._startX, deltaY: move.clientY - this._startY },
        }),
      );
    };
    const onUp = (): void => {
      this._dragging = false;
      this.requestUpdate();
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      this.dispatchEvent(new CustomEvent('region-resize-end', { bubbles: true, composed: true }));
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  };

  render() {
    return html`<div
      class="handle ${this._dragging ? 'dragging' : ''}"
      @pointerdown=${this._onPointerDown}
    >
      ${this.direction === 'horizontal' ? '⋮' : '⋯'}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-region-divider': MuxRegionDivider;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/region-divider.test.ts`
Expected: PASS — 3 passing.

**Step 5: Commit**

`git add web/src/components/region-divider.ts web/src/components/region-divider.test.ts && git commit -m "feat(phase3): heavy region divider component (Layer-2)"`

---

### Task 6: Region component (`<mux-region>`)

One surface = one region. It wraps `<mux-layout>` (reused unchanged) with a **minimal/unstyled** header (session + window name + a maximize button). Header styling is deliberately bare — Phase 4 owns chrome. It exposes a `bodyElement` getter so the cell-budget manager can observe the surface's pixel box.

**Files:**
- Create: `web/src/components/region.ts`
- Test: `web/src/components/region.test.ts`

**Step 1: Write the failing test**

Create `web/src/components/region.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import './region.js';
import type { MuxRegion } from './region.js';

async function mount(props: Partial<MuxRegion> = {}): Promise<MuxRegion> {
  const el = document.createElement('mux-region') as MuxRegion;
  el.regionId = props.regionId ?? 'region-1';
  el.surfaceId = props.surfaceId ?? 'surf-1';
  el.sessionName = props.sessionName ?? 'work';
  el.windowName = props.windowName ?? 'editor';
  el.layoutString = props.layoutString ?? '';
  el.activePaneId = props.activePaneId ?? -1;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('mux-region', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a minimal header showing session and window name', async () => {
    const el = await mount({ sessionName: 'work', windowName: 'editor' });
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).toContain('work');
    expect(text).toContain('editor');
  });

  it('embeds a mux-layout body for Layer 1', async () => {
    const el = await mount();
    expect(el.shadowRoot?.querySelector('mux-layout')).not.toBeNull();
  });

  it('exposes bodyElement for cell-budget measurement', async () => {
    const el = await mount();
    expect(el.bodyElement).toBeInstanceOf(HTMLElement);
  });

  it('emits region-maximize when the maximize button is clicked', async () => {
    const el = await mount({ regionId: 'region-7' });
    const events: Array<{ regionId: string }> = [];
    el.addEventListener('region-maximize', (e) => events.push((e as CustomEvent).detail));
    const btn = el.shadowRoot?.querySelector('button[data-action="maximize"]') as HTMLButtonElement;
    btn.click();
    expect(events).toEqual([{ regionId: 'region-7' }]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/region.test.ts`
Expected: FAIL — `Failed to resolve import "./region.js"`.

**Step 3: Write minimal implementation**

Create `web/src/components/region.ts`:

```ts
import { LitElement, html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import './layout.js';

/**
 * mux-region — one dock slot wrapping a single surface (one tmux window).
 *
 * The body reuses <mux-layout> unchanged (Layer 1 renders the window's split
 * tree). The header is intentionally MINIMAL/unstyled — full VS Code-style
 * chrome (tab strips, session picker, ⋯ menu) is Phase 4. For Phase 3 we only
 * need a maximize control and an identity label.
 *
 * `bodyElement` is the per-surface measurement target for the cell-budget
 * ResizeObserver (seam S3) — NOT window.innerHeight.
 */
@customElement('mux-region')
export class MuxRegion extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #1a1b26;
      min-width: 120px;
      min-height: 80px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 26px;
      padding: 0 8px;
      font-size: 12px;
      color: #a9b1d6;
      background: #16161e;
      border-bottom: 1px solid #292e42;
      flex-shrink: 0;
    }
    .session {
      color: #7aa2f7;
    }
    .spacer {
      flex: 1;
    }
    button {
      background: transparent;
      border: none;
      color: #565f89;
      cursor: pointer;
      font-size: 13px;
      padding: 2px 6px;
      border-radius: 4px;
    }
    button:hover {
      background: #292e42;
      color: #c0caf5;
    }
    .body {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
  `;

  @property({ type: String }) regionId = '';
  @property({ type: String }) surfaceId = '';
  @property({ type: String }) sessionName = '';
  @property({ type: String }) windowName = '';
  @property({ type: String }) layoutString = '';
  @property({ type: Number }) activePaneId = -1;

  @query('.body') private _body!: HTMLElement;

  /** Measurement target for the per-surface cell-budget ResizeObserver. */
  get bodyElement(): HTMLElement {
    return this._body;
  }

  private _onMaximize = (): void => {
    this.dispatchEvent(
      new CustomEvent('region-maximize', {
        bubbles: true,
        composed: true,
        detail: { regionId: this.regionId },
      }),
    );
  };

  render() {
    return html`
      <div class="header">
        <span class="session">${this.sessionName}</span>
        <span>${this.windowName}</span>
        <span class="spacer"></span>
        <button data-action="maximize" title="Maximize region" @click=${this._onMaximize}>⊡</button>
      </div>
      <div class="body">
        <mux-layout
          layout-string=${this.layoutString}
          active-pane-id=${this.activePaneId}
        ></mux-layout>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-region': MuxRegion;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/region.test.ts`
Expected: PASS — 4 passing.

**Step 5: Commit**

`git add web/src/components/region.ts web/src/components/region.test.ts && git commit -m "feat(phase3): mux-region wraps mux-layout for one surface (minimal header)"`

---

### Task 7: Workspace dock component (`<mux-workspace>`)

The dock manager: takes a `Workspace` model + the tmux state, renders `visibleRegions` separated by `<mux-region-divider>`s, and wires maximize/restore. This is the Layer-2 view.

**Files:**
- Create: `web/src/components/workspace.ts`
- Test: `web/src/components/workspace.test.ts`

**Step 1: Write the failing test**

Create `web/src/components/workspace.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import './workspace.js';
import type { MuxWorkspace } from './workspace.js';
import { Workspace } from '../lib/workspace.js';
import type { TmuxState } from '../types.js';

function stateWith(windows: Array<{ id: number; name: string }>): TmuxState {
  return {
    activeSession: 'work',
    activeWindow: windows[0]?.id ?? 0,
    activePane: -1,
    sessions: [
      {
        name: 'work',
        windows: windows.map((w) => ({ id: w.id, name: w.name, layout: '', panes: [] })),
      },
    ],
  };
}

async function mount(ws: Workspace, state: TmuxState): Promise<MuxWorkspace> {
  const el = document.createElement('mux-workspace') as MuxWorkspace;
  el.workspace = ws;
  el.tmuxState = state;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('mux-workspace', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders one region with no divider for a single surface', async () => {
    const ws = new Workspace();
    ws.openRegion({ sessionName: 'work', windowId: 1 });
    const el = await mount(ws, stateWith([{ id: 1, name: 'editor' }]));
    expect(el.shadowRoot!.querySelectorAll('mux-region').length).toBe(1);
    expect(el.shadowRoot!.querySelectorAll('mux-region-divider').length).toBe(0);
  });

  it('renders N regions with N-1 dividers when docked', async () => {
    const ws = new Workspace();
    ws.openRegion({ sessionName: 'work', windowId: 1 });
    ws.openRegion({ sessionName: 'work', windowId: 2 });
    const el = await mount(ws, stateWith([{ id: 1, name: 'editor' }, { id: 2, name: 'logs' }]));
    expect(el.shadowRoot!.querySelectorAll('mux-region').length).toBe(2);
    expect(el.shadowRoot!.querySelectorAll('mux-region-divider').length).toBe(1);
  });

  it('maximize event collapses to a single visible region', async () => {
    const ws = new Workspace();
    const r1 = ws.openRegion({ sessionName: 'work', windowId: 1 });
    ws.openRegion({ sessionName: 'work', windowId: 2 });
    const el = await mount(ws, stateWith([{ id: 1, name: 'editor' }, { id: 2, name: 'logs' }]));
    el.shadowRoot!
      .querySelector('mux-region')!
      .dispatchEvent(
        new CustomEvent('region-maximize', {
          bubbles: true,
          composed: true,
          detail: { regionId: r1.id },
        }),
      );
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll('mux-region').length).toBe(1);
  });

  it('passes the window layout string down to its region', async () => {
    const ws = new Workspace();
    ws.openRegion({ sessionName: 'work', windowId: 1 });
    const state = stateWith([{ id: 1, name: 'editor' }]);
    state.sessions[0].windows[0].layout = 'abcd,80x24,0,0,1';
    const el = await mount(ws, state);
    const region = el.shadowRoot!.querySelector('mux-region') as HTMLElement & {
      layoutString: string;
    };
    expect(region.layoutString).toBe('abcd,80x24,0,0,1');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/workspace.test.ts`
Expected: FAIL — `Failed to resolve import "./workspace.js"`.

**Step 3: Write minimal implementation**

Create `web/src/components/workspace.ts`:

```ts
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { Workspace, Region } from '../lib/workspace.js';
import type { TmuxState, Window } from '../types.js';
import './region.js';
import './region-divider.js';

/**
 * mux-workspace — the Layer-2 dock manager (the view over a Workspace model).
 *
 * Renders workspace.visibleRegions left-to-right, inserting a heavy
 * mux-region-divider between each pair. Solo (one region) => no divider, minimal
 * chrome. Dock (N regions) => N-1 heavy dividers. Maximize/restore swap which
 * regions are visible (seam S1). It looks up each surface's live window
 * (layout string, name) from tmuxState.
 *
 * Outbound resize wiring (ResizeObserver -> cell-budget -> coalescer -> ws) is
 * attached in Task 11; this task is the structural view only.
 */
@customElement('mux-workspace')
export class MuxWorkspace extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex: 1;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #1a1b26;
    }
    .region-slot {
      display: flex;
      overflow: hidden;
    }
  `;

  @property({ attribute: false }) workspace!: Workspace;
  @property({ attribute: false }) tmuxState!: TmuxState;

  private _findWindow(sessionName: string, windowId: number): Window | undefined {
    return this.tmuxState?.sessions
      .find((s) => s.name === sessionName)
      ?.windows.find((w) => w.id === windowId);
  }

  private _onMaximize = (e: CustomEvent<{ regionId: string }>): void => {
    if (this.workspace.maximizedRegionId === e.detail.regionId) {
      this.workspace.restore();
    } else {
      this.workspace.maximize(e.detail.regionId);
    }
    this.requestUpdate();
  };

  private _renderRegion(region: Region) {
    const win = this._findWindow(region.surface.sessionName, region.surface.windowId);
    return html`
      <div class="region-slot" style="flex: ${region.weight}">
        <mux-region
          .regionId=${region.id}
          .surfaceId=${region.surface.id}
          .sessionName=${region.surface.sessionName}
          .windowName=${win?.name ?? ''}
          .layoutString=${win?.layout ?? ''}
          .activePaneId=${this.tmuxState?.activePane ?? -1}
        ></mux-region>
      </div>
    `;
  }

  render() {
    if (!this.workspace) return html``;
    const regions = this.workspace.visibleRegions;
    const items: unknown[] = [];
    regions.forEach((region, i) => {
      items.push(this._renderRegion(region));
      if (i < regions.length - 1) {
        items.push(html`<mux-region-divider direction="horizontal"></mux-region-divider>`);
      }
    });
    return html`${repeat(items, (_, i) => i, (item) => item)}`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('region-maximize', this._onMaximize as EventListener);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('region-maximize', this._onMaximize as EventListener);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-workspace': MuxWorkspace;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/workspace.test.ts`
Expected: PASS — 4 passing.

**Step 5: Commit**

`git add web/src/components/workspace.ts web/src/components/workspace.test.ts && git commit -m "feat(phase3): mux-workspace dock manager (regions + heavy dividers + maximize)"`

---

### Task 8: Wire `<mux-workspace>` into `app.ts`

Replace the single `<mux-layout>` render path with `<mux-workspace>` driven by a `Workspace` model. Phase 3 seeds the workspace with **one region for the active window** (so behavior is identical today), and exposes a method to open a second region (used by E2E to enter dock mode). The terminal registry (`_syncTerminals`) is untouched — it already ensures terminals for every pane in every window.

**Files:**
- Modify: `web/src/app.ts`

**Step 1: Write the failing test**

Create `web/src/app-workspace.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import './app.js';
import type { MuxApp } from './app.js';

describe('mux-app workspace integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a mux-workspace instead of a bare mux-layout', async () => {
    const el = document.createElement('mux-app') as MuxApp;
    document.body.appendChild(el);
    await el.updateComplete;
    // Seed minimal state: one session, one window, one pane.
    el.seedWorkspaceForTest('work', 1);
    el.injectStateForTest({
      activeSession: 'work',
      activeWindow: 1,
      activePane: 1,
      sessions: [
        {
          name: 'work',
          windows: [{ id: 1, name: 'editor', layout: '', panes: [{ id: 1, width: 80, height: 24, active: true }] }],
        },
      ],
    });
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('mux-workspace')).not.toBeNull();
  });
});
```

> Note: `seedWorkspaceForTest` and `injectStateForTest` are tiny test-only hooks you add in Step 3. They exist so this integration is verifiable without a live WebSocket. Keep them minimal and clearly marked `@internal — test hook`.

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app-workspace.test.ts`
Expected: FAIL — "el.seedWorkspaceForTest is not a function" (or no `mux-workspace` found).

**Step 3: Write minimal implementation**

In `web/src/app.ts`:

1. Add imports near the other component imports (after line 17):

```ts
import './components/workspace.js';
import { Workspace } from './lib/workspace.js';
```

2. Add a workspace field next to the other `@state()` declarations (after the `_reconnectMessage` state, ~line 128):

```ts
  // Layer-2 model. Phase 3 seeds it with the active window as a single region;
  // additional regions enter dock mode. Held as a plain field (not @state) — we
  // call requestUpdate() explicitly after mutating it.
  private _workspace = new Workspace();
```

3. Seed the workspace whenever state arrives and the active window is not yet mounted. Add this private method:

```ts
  /** Ensure the active window is mounted as a region (idempotent). */
  private _ensureActiveRegion(): void {
    const session = this._tmuxState.activeSession;
    const windowId = this._tmuxState.activeWindow;
    if (!session || !windowId) return;
    const alreadyMounted = this._workspace.regions.some(
      (r) => r.surface.sessionName === session && r.surface.windowId === windowId,
    );
    const anyMounted = this._workspace.regions.length > 0;
    if (!anyMounted && !alreadyMounted) {
      this._workspace.openRegion({ sessionName: session, windowId });
    }
  }
```

Call it from `willUpdate`, right after `this._syncTerminals();`:

```ts
    this._syncTerminals();
    this._ensureActiveRegion();
```

4. Replace the terminal render branch. Change the `: html\`` block that renders `<mux-layout ...>` (lines ~251–257) to:

```ts
        : html`
            <mux-workspace
              .workspace=${this._workspace}
              .tmuxState=${this._tmuxState}
              @pane-focus=${this._onPaneSelect}
            ></mux-workspace>
          `}
```

5. Add the two test-only hooks at the end of the class (before the closing brace):

```ts
  /** @internal test hook — seed a region without a live socket. */
  seedWorkspaceForTest(sessionName: string, windowId: number): void {
    this._workspace = new Workspace();
    this._workspace.openRegion({ sessionName, windowId });
  }

  /** @internal test hook — inject tmux state without a live socket. */
  injectStateForTest(state: TmuxState): void {
    this._tmuxState = state;
    this.requestUpdate();
  }

  /** Open the active window of another session as a second region (dock). */
  openRegionForTest(sessionName: string, windowId: number): void {
    this._workspace.openRegion({ sessionName, windowId });
    this.requestUpdate();
  }
```

(The `import type { ... Window }` line already imports `TmuxState`? It imports `TmuxState, Window` at line 5 — confirm `TmuxState` is present; it is.)

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/app-workspace.test.ts && cd web && npm run build`
Expected: test PASS (1 passing) AND build/tsc clean (no type errors).

**Step 5: Commit**

`git add web/src/app.ts web/src/app-workspace.test.ts && git commit -m "feat(phase3): render mux-workspace from app.ts; seed active window as a region"`

---

### Task 9: Backend `SurfaceRouter` — per-surface client + refresh routing

Extend Phase 1's pool from per-session to **per-visible-surface**. Each visible surface gets a dedicated control client that does `select-window` to its window with `aggressive-resize on`, and `refresh-client -C WxH` is routed to **that surface's** client. We isolate this in a small, testable `SurfaceRouter`.

**Files:**
- Create: `internal/server/surface.go`
- Test: `internal/server/ws_surface_test.go`

**Step 1: Write the failing test**

Create `internal/server/ws_surface_test.go`:

```go
package server

import (
	"errors"
	"testing"
)

// fakeSurfaceClient records the calls routed to one surface's control client.
type fakeSurfaceClient struct {
	selected   string
	aggressive bool
	resizes    [][2]int
	closed     bool
	failResize bool
}

func (f *fakeSurfaceClient) SelectWindow(windowID string) error {
	f.selected = windowID
	return nil
}
func (f *fakeSurfaceClient) SetAggressiveResize() error { f.aggressive = true; return nil }
func (f *fakeSurfaceClient) RefreshClientSize(cols, rows int) error {
	if f.failResize {
		return errors.New("tmux rejected size")
	}
	f.resizes = append(f.resizes, [2]int{cols, rows})
	return nil
}
func (f *fakeSurfaceClient) Close() error { f.closed = true; return nil }

func TestSurfaceRouter_MountSelectsWindowAndEnablesAggressiveResize(t *testing.T) {
	r := NewSurfaceRouter()
	c := &fakeSurfaceClient{}
	if err := r.Mount("surf-1", "@1", c); err != nil {
		t.Fatalf("Mount: %v", err)
	}
	if c.selected != "@1" {
		t.Errorf("select-window = %q, want @1", c.selected)
	}
	if !c.aggressive {
		t.Error("aggressive-resize was not enabled on the surface client")
	}
}

func TestSurfaceRouter_ResizeRoutesToOwningClient(t *testing.T) {
	r := NewSurfaceRouter()
	a := &fakeSurfaceClient{}
	b := &fakeSurfaceClient{}
	_ = r.Mount("surf-a", "@1", a)
	_ = r.Mount("surf-b", "@2", b)

	if err := r.Resize("surf-a", 100, 30); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	if len(a.resizes) != 1 || a.resizes[0] != [2]int{100, 30} {
		t.Errorf("surf-a resizes = %v, want [[100 30]]", a.resizes)
	}
	if len(b.resizes) != 0 {
		t.Errorf("surf-b should not have been resized, got %v", b.resizes)
	}
}

func TestSurfaceRouter_ResizeUnknownSurfaceErrors(t *testing.T) {
	r := NewSurfaceRouter()
	if err := r.Resize("ghost", 80, 24); err == nil {
		t.Error("expected error resizing an unmounted surface")
	}
}

func TestSurfaceRouter_UnmountClosesClient(t *testing.T) {
	r := NewSurfaceRouter()
	c := &fakeSurfaceClient{}
	_ = r.Mount("surf-1", "@1", c)
	if err := r.Unmount("surf-1"); err != nil {
		t.Fatalf("Unmount: %v", err)
	}
	if !c.closed {
		t.Error("Unmount did not Close() the surface client")
	}
	if err := r.Resize("surf-1", 80, 24); err == nil {
		t.Error("resize after unmount should error")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./internal/server/ -run TestSurfaceRouter`
Expected: FAIL — `undefined: NewSurfaceRouter` / `undefined: SurfaceRouter`.

**Step 3: Write minimal implementation**

Create `internal/server/surface.go`:

```go
package server

import (
	"fmt"
	"sync"
)

// SurfaceID identifies one visible Layer-2 surface (one tmux window shown as an
// opaque block). It is a stable string minted by the frontend ("surf-3").
type SurfaceID string

// surfaceClient is one tmux -CC control client dedicated to a single visible
// surface. Phase 1 created one control client per session; Phase 3 extends that
// to one per visible surface so tmux can size each window to the client viewing
// it (refresh-client -C WxH). This interface is the seam the Phase 1 pool
// satisfies — wire a real pool entry to it in the Hub.
type surfaceClient interface {
	// SelectWindow points this client at its window.
	SelectWindow(windowID string) error
	// SetAggressiveResize enables `aggressive-resize on` so the window sizes to
	// the smaller of attached clients (per-surface sizing model).
	SetAggressiveResize() error
	// RefreshClientSize emits `refresh-client -C WxH` for THIS client only.
	RefreshClientSize(cols, rows int) error
	// Close detaches the control client.
	Close() error
}

// SurfaceRouter maps visible surfaces to their dedicated control clients and
// routes per-surface resizes. It also dedups %output by global pane id (%N) —
// see surface_dedup.go (Task 10).
type SurfaceRouter struct {
	mu      sync.Mutex
	clients map[SurfaceID]surfaceClient
	// owner maps a global pane id (%N as uint32) to the surface that "owns" it,
	// so the same %output arriving on two clients is emitted exactly once.
	owner map[uint32]SurfaceID
}

func NewSurfaceRouter() *SurfaceRouter {
	return &SurfaceRouter{
		clients: make(map[SurfaceID]surfaceClient),
		owner:   make(map[uint32]SurfaceID),
	}
}

// Mount registers a surface's control client, points it at its window, and
// enables aggressive-resize. Called when a surface becomes visible.
func (r *SurfaceRouter) Mount(id SurfaceID, windowID string, c surfaceClient) error {
	r.mu.Lock()
	r.clients[id] = c
	r.mu.Unlock()

	if err := c.SelectWindow(windowID); err != nil {
		return fmt.Errorf("surface %s select-window %s: %w", id, windowID, err)
	}
	if err := c.SetAggressiveResize(); err != nil {
		return fmt.Errorf("surface %s aggressive-resize: %w", id, err)
	}
	return nil
}

// Resize routes a refresh-client to the surface's OWN control client. The one
// value crossing the layer boundary: cols x rows for exactly this surface.
func (r *SurfaceRouter) Resize(id SurfaceID, cols, rows int) error {
	r.mu.Lock()
	c := r.clients[id]
	r.mu.Unlock()
	if c == nil {
		return fmt.Errorf("resize: no client for surface %s", id)
	}
	return c.RefreshClientSize(cols, rows)
}

// Unmount closes a surface's client and drops its pane ownership. Called when a
// surface is hidden (maximize) or closed. Blast radius stays one surface.
func (r *SurfaceRouter) Unmount(id SurfaceID) error {
	r.mu.Lock()
	c := r.clients[id]
	delete(r.clients, id)
	for pane, owner := range r.owner {
		if owner == id {
			delete(r.owner, pane)
		}
	}
	r.mu.Unlock()
	if c == nil {
		return nil
	}
	return c.Close()
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./internal/server/ -run TestSurfaceRouter -v`
Expected: PASS — 4 tests (`...SelectsWindow...`, `...RoutesToOwningClient`, `...UnknownSurfaceErrors`, `...UnmountClosesClient`).

**Step 5: Commit**

`git add internal/server/surface.go internal/server/ws_surface_test.go && git commit -m "feat(phase3): SurfaceRouter — per-surface control client + refresh-client routing"`

---

### Task 10: Backend `%output` dedup by global `%N`

With N control clients, the same window's `%output` can arrive on more than one client. Each pane (`%N`) belongs to exactly one window → one surface; forward its output only from the owning surface. Idempotent and lock-safe.

**Files:**
- Modify: `internal/server/surface.go`
- Modify: `internal/server/ws_surface_test.go`

**Step 1: Write the failing test**

Append to `internal/server/ws_surface_test.go`:

```go
func TestSurfaceRouter_AcceptDedupsByGlobalPaneID(t *testing.T) {
	r := NewSurfaceRouter()
	_ = r.Mount("surf-a", "@1", &fakeSurfaceClient{})
	_ = r.Mount("surf-b", "@2", &fakeSurfaceClient{})

	// First sighting of pane %5 on surf-a claims it.
	if !r.Accept(5, "surf-a") {
		t.Error("first %output for pane 5 on surf-a should be accepted")
	}
	// Same pane arriving on surf-b is a duplicate — drop it.
	if r.Accept(5, "surf-b") {
		t.Error("duplicate %output for pane 5 on surf-b should be dropped")
	}
	// Same pane on its owner is still accepted (ongoing output).
	if !r.Accept(5, "surf-a") {
		t.Error("ongoing %output for pane 5 on owner surf-a should be accepted")
	}
}

func TestSurfaceRouter_AcceptReassignsAfterUnmount(t *testing.T) {
	r := NewSurfaceRouter()
	_ = r.Mount("surf-a", "@1", &fakeSurfaceClient{})
	r.Accept(7, "surf-a")
	if err := r.Unmount("surf-a"); err != nil {
		t.Fatalf("Unmount: %v", err)
	}
	// After the owner unmounts, pane 7 is free to be claimed by a new surface.
	_ = r.Mount("surf-c", "@1", &fakeSurfaceClient{})
	if !r.Accept(7, "surf-c") {
		t.Error("pane 7 should be re-claimable after its owner unmounted")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./internal/server/ -run TestSurfaceRouter_Accept`
Expected: FAIL — `r.Accept undefined (type *SurfaceRouter has no field or method Accept)`.

**Step 3: Write minimal implementation**

Append to `internal/server/surface.go`:

```go
// Accept reports whether an %output for global pane `pane` arriving on surface
// `id`'s client should be forwarded to the browser (true) or dropped as a
// duplicate (false). The first surface to see a pane claims ownership; output
// from any other surface for that pane is a duplicate. Ownership is released in
// Unmount, so a pane can be re-claimed after its owner is hidden/closed.
func (r *SurfaceRouter) Accept(pane uint32, id SurfaceID) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	owner, ok := r.owner[pane]
	if !ok {
		r.owner[pane] = id
		return true
	}
	return owner == id
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./internal/server/ -run TestSurfaceRouter -v`
Expected: PASS — 6 tests total (4 from Task 9 + 2 new dedup tests).

**Step 5: Commit**

`git add internal/server/surface.go internal/server/ws_surface_test.go && git commit -m "feat(phase3): %output dedup by global pane id across surface clients"`

---

### Task 11: Outbound resize wiring (ResizeObserver → budget → coalescer → ws)

Connect the dots: each visible region's body is observed by the `CellBudgetManager`; its budget flows through the `ResizeCoalescer`; the coalesced budget is sent as a `resize-surface` control message. This is the full CELL clock, end to end, in the frontend.

**Files:**
- Modify: `web/src/components/workspace.ts`
- Modify: `web/src/components/workspace.test.ts`

**Step 1: Write the failing test**

Append to `web/src/components/workspace.test.ts`:

```ts
import { vi } from 'vitest';

describe('mux-workspace outbound resize wiring', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('emits a resize-surface event (id, cols, rows) when a surface is measured', async () => {
    const ws = new Workspace();
    const r = ws.openRegion({ sessionName: 'work', windowId: 1 });
    const el = await mount(ws, stateWith([{ id: 1, name: 'editor' }]));

    const sent: Array<{ surfaceId: string; cols: number; rows: number }> = [];
    el.addEventListener('resize-surface', (e) => sent.push((e as CustomEvent).detail));

    // Drive the cell-budget entry point directly (simulates the ResizeObserver).
    el.measureSurfaceForTest(r.surface.id, { width: 800, height: 320 }, { cellWidth: 8, cellHeight: 16 });
    vi.advanceTimersByTime(40); // CELL clock debounce

    expect(sent).toEqual([{ surfaceId: r.surface.id, cols: 100, rows: 20 }]);
  });

  it('does not re-emit when the pixel change stays within the same cell', async () => {
    const ws = new Workspace();
    const r = ws.openRegion({ sessionName: 'work', windowId: 1 });
    const el = await mount(ws, stateWith([{ id: 1, name: 'editor' }]));
    const sent: unknown[] = [];
    el.addEventListener('resize-surface', (e) => sent.push((e as CustomEvent).detail));

    el.measureSurfaceForTest(r.surface.id, { width: 800, height: 320 }, { cellWidth: 8, cellHeight: 16 });
    vi.advanceTimersByTime(40);
    el.measureSurfaceForTest(r.surface.id, { width: 803, height: 323 }, { cellWidth: 8, cellHeight: 16 });
    vi.advanceTimersByTime(40);

    expect(sent.length).toBe(1); // second measure crossed no cell boundary
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/workspace.test.ts`
Expected: FAIL — "el.measureSurfaceForTest is not a function".

**Step 3: Write minimal implementation**

In `web/src/components/workspace.ts`:

1. Add imports:

```ts
import { CellBudgetManager } from '../lib/cell-budget.js';
import { ResizeCoalescer } from '../lib/resize-coalescer.js';
import type { CellMetrics, PixelBox } from '../lib/cell-budget.js';
```

2. Add the two-clock plumbing as fields + lifecycle. Inside the class:

```ts
  // CELL clock: budget -> coalescer -> resize-surface event. The PIXEL clock
  // (CSS/xterm smooth scaling) is handled by xterm's own fit; here we only debounce
  // the BACKEND round-trip and emit one resize-surface per settled cell change.
  private _coalescer = new ResizeCoalescer((surfaceId, budget) => {
    this.dispatchEvent(
      new CustomEvent('resize-surface', {
        bubbles: true,
        composed: true,
        detail: { surfaceId, cols: budget.cols, rows: budget.rows },
      }),
    );
  });

  private _budget = new CellBudgetManager((surfaceId, budget) => {
    this._coalescer.push(surfaceId, budget);
  });
```

3. After each render, observe the currently visible region bodies. Add:

```ts
  protected override updated(): void {
    // Observe each visible surface's body element (per-surface ResizeObserver,
    // seam S3 — never window.innerHeight). Idempotent: observe() replaces.
    for (const region of this.workspace?.visibleRegions ?? []) {
      const regionEl = this.shadowRoot?.querySelector(
        `mux-region[surfaceId="${region.surface.id}"]`,
      ) as (HTMLElement & { bodyElement?: HTMLElement }) | null;
      // Fallback: query by order if attribute reflection is unavailable.
      const body = regionEl?.bodyElement;
      const metrics = this._cellMetricsFor(region.surface.id);
      if (body && metrics) this._budget.observe(region.surface.id, body, metrics);
    }
  }

  /**
   * Resolve the measured cell size for a surface's active pane via the terminal
   * registry. Returns null until the terminal is open. (Wired to the registry in
   * integration; for now derive from the rendered xterm cell, falling back to a
   * conservative default so the first resize still fires.)
   */
  private _cellMetricsFor(_surfaceId: string): CellMetrics | null {
    // Default monospace cell at 13px/1.2 line-height — refined once xterm reports
    // its real CSS cell dimensions. Kept simple here (YAGNI); exact metrics come
    // from the registry in app wiring.
    return { cellWidth: 8, cellHeight: 16 };
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('region-maximize', this._onMaximize as EventListener);
    this._budget.dispose();
    this._coalescer.dispose();
  }

  /** @internal test hook — drive the cell-budget entry point directly. */
  measureSurfaceForTest(surfaceId: string, box: PixelBox, metrics: CellMetrics): void {
    this._budget.setSurfaceMetrics(surfaceId, metrics);
    this._budget.setSurfacePixelBox(surfaceId, box);
  }
```

4. Remove the now-duplicate `disconnectedCallback` from Task 7 (merge the `removeEventListener` line into the one above so there is a single `disconnectedCallback`). Keep `connectedCallback` as-is.

5. In `app.ts`, forward the new event to the socket. Add a listener on `<mux-workspace>` in the render (alongside `@pane-focus`):

```ts
              @resize-surface=${this._onSurfaceResize}
```

and add the handler method:

```ts
  private _onSurfaceResize = (
    e: CustomEvent<{ surfaceId: string; cols: number; rows: number }>,
  ): void => {
    // Async fire-and-forget (seam S5) — never a synchronous handshake.
    this._socket?.sendControl({
      type: 'resize-surface',
      surfaceId: e.detail.surfaceId,
      cols: e.detail.cols,
      rows: e.detail.rows,
    });
  };
```

> Backend `resize-surface` dispatch: add a `case "resize-surface"` to `dispatchAction` in `internal/server/ws.go` that unmarshals `{surfaceId string, cols int, rows int}` and calls `h.surfaceRouter.Resize(SurfaceID(p.SurfaceID), p.Cols, p.Rows)`. Wire `surfaceRouter` onto the `Hub` (constructed in `NewHub`). This is plumbing over Task 9's tested router; keep it a thin pass-through.

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/workspace.test.ts && cd web && npm run build && go build ./...`
Expected: workspace tests PASS (6 passing); frontend build clean; `go build` clean.

**Step 5: Commit**

`git add web/src/components/workspace.ts web/src/components/workspace.test.ts web/src/app.ts internal/server/ws.go && git commit -m "feat(phase3): wire two-clock outbound resize (ResizeObserver->budget->coalescer->resize-surface)"`

---

### Task 12: E2E — dock mount of 2 surfaces (content + layout fidelity)

First re-parenting test. Mount a second region and assert BOTH surfaces show correct content (CONTENT fidelity vs `tmux capture-pane`) and correct geometry (LAYOUT fidelity vs `playwright-cli`). Uses the Phase-2 harness; **no OCR**.

**Files:**
- Create: `web/e2e/dock-mount.e2e.md` (a runnable E2E checklist/script — record exact commands + expected output)

**Step 1: Write the failing test (the E2E script + first assertion)**

Confirm the dev server is up, then open the app:

```bash
curl -sSf http://localhost:8080/ >/dev/null && echo "dev up" || echo "START make dev FIRST"
playwright-cli open --browser=chromium http://localhost:8080
playwright-cli snapshot
```
Expected at this point: the snapshot shows ONE `mux-region` (solo mode). There is no second region yet — so the assertion below will FAIL until you trigger the dock.

Write the content-fidelity assertion as a reusable shell helper file `web/e2e/dock-mount.e2e.md` and paste this block into it:

```bash
# CONTENT fidelity for a pane: tmux truth == xterm snapshot (right-trimmed, no OCR)
assert_content () {  # $1 = pane %N
  pane="$1"
  tmux capture-pane -p -t "%$pane" | sed 's/[[:space:]]*$//' > /tmp/tmux_$pane.txt
  playwright-cli --raw eval "JSON.stringify(window.__muxterm.snapshot($pane).rows.map(r => r.replace(/\\s+$/,'')))" \
    | jq -r '.[]' > /tmp/xterm_$pane.txt
  diff /tmp/tmux_$pane.txt /tmp/xterm_$pane.txt && echo "CONTENT OK pane $pane" || { echo "CONTENT MISMATCH pane $pane"; exit 1; }
}
```

**Step 2: Run to verify it fails (only one region exists)**

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region').length"
```
Expected: `1` — proving the dock has not been entered yet (assertion target absent → FAIL as intended).

**Step 3: Trigger the dock (mount a second surface) and make it pass**

Drive the app's test hook to open a second region from another window/session, then re-render:

```bash
# Open a second region (uses the openRegionForTest hook from Task 8).
playwright-cli --raw eval "(() => { const app = document.querySelector('mux-app'); app.openRegionForTest('work', 2); return app.shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region').length; })()"
```
Expected: `2`.

Confirm a heavy divider appeared:

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region-divider').length"
```
Expected: `1`.

**Step 4: Run both fidelity assertions to verify pass**

CONTENT fidelity for both surfaces' active panes (substitute the real `%N` from `tmux list-panes -a`):

```bash
source web/e2e/dock-mount.e2e.md   # loads assert_content
tmux list-panes -a -F '#{pane_id} #{window_id}'   # discover the two panes
assert_content 1   # editor window's pane
assert_content 2   # logs window's pane
```
Expected: `CONTENT OK pane 1` and `CONTENT OK pane 2`.

LAYOUT fidelity — xterm dims vs browser geometry for the second region:

```bash
playwright-cli --raw eval "(() => { const t = window.__muxterm.snapshot(2); return JSON.stringify({cols: t.cols, rows: t.rows}); })()"
# compare cols/rows against the rendered body box:
playwright-cli --raw eval "(() => { const r = document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region')[1]; const b = r.bodyElement.getBoundingClientRect(); return JSON.stringify({w: Math.round(b.width), h: Math.round(b.height)}); })()"
```
Expected: `cols ≈ floor(w / cellWidth)` and `rows ≈ floor(h / cellHeight)` (LAYOUT fidelity — the budget the surface received matches what the browser actually painted). Record the observed numbers in the `.md` as the baseline.

**Step 5: Commit**

`git add web/e2e/dock-mount.e2e.md && git commit -m "test(phase3): e2e dock mount of 2 surfaces — content + layout fidelity (no OCR)"`

---

### Task 13: E2E — divider-drag resize propagation

Drag the heavy region divider and prove the resize PROPAGATES: the smaller surface's xterm grid shrinks, a `refresh-client` reaches tmux (the window's reported size changes), and content/layout fidelity hold after settle.

**Files:**
- Create: `web/e2e/divider-resize.e2e.md`

**Step 1: Write the failing assertion (baseline capture)**

Continue in the same browser session (two regions docked from Task 12). Capture the right region's grid BEFORE the drag:

```bash
playwright-cli --raw eval "JSON.stringify({cols: window.__muxterm.snapshot(2).cols, rows: window.__muxterm.snapshot(2).rows})" > /tmp/before.json
tmux display-message -p -t '@2' '#{window_width}x#{window_height}' > /tmp/tmux_before.txt
cat /tmp/before.json /tmp/tmux_before.txt
```
Expected: a baseline like `{"cols":100,"rows":20}` and e.g. `100x20`. The post-drag assertion (Step 4) will FAIL until the drag wiring works.

**Step 2: Run to verify the divider is draggable**

Get the divider's box so you know where to drag:

```bash
playwright-cli --raw eval "(() => { const d = document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelector('mux-region-divider'); const b = d.getBoundingClientRect(); return JSON.stringify({x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2)}); })()"
```
Expected: integer `{x, y}` near the middle of the window (the divider exists and is positioned).

**Step 3: Perform the drag (PIXEL clock) and let the CELL clock settle**

Drag the divider ~150px left (shrinks the right region). Use raw mouse events at the coordinates from Step 2 (substitute `X`/`Y`):

```bash
playwright-cli mousemove X Y
playwright-cli mousedown
playwright-cli mousemove $((X-150)) Y
playwright-cli mousemove $((X-150)) Y
playwright-cli mouseup
sleep 1   # allow the 40ms CELL-clock debounce + tmux %layout-change round-trip
```

**Step 4: Assert propagation (verify pass)**

```bash
playwright-cli --raw eval "JSON.stringify({cols: window.__muxterm.snapshot(2).cols, rows: window.__muxterm.snapshot(2).rows})" > /tmp/after.json
tmux display-message -p -t '@2' '#{window_width}x#{window_height}' > /tmp/tmux_after.txt
echo "BEFORE:"; cat /tmp/before.json; echo "AFTER:"; cat /tmp/after.json
echo "TMUX before/after:"; cat /tmp/tmux_before.txt /tmp/tmux_after.txt
# PASS criteria:
#   - after.cols  <  before.cols   (right surface got narrower)
#   - tmux_after width == after.cols (tmux re-sized the window to the surface's budget)
test "$(jq .cols /tmp/after.json)" -lt "$(jq .cols /tmp/before.json)" && echo "PROPAGATION OK" || { echo "NO PROPAGATION"; exit 1; }
```
Expected: `PROPAGATION OK`, and the tmux-reported width equals the new `cols` (the CELL clock reached the surface's own control client via `refresh-client`).

Then re-run CONTENT + LAYOUT fidelity (from Task 12's helper) on pane 2 to prove no blank/scroll-drift after resize:

```bash
source web/e2e/dock-mount.e2e.md
assert_content 2
```
Expected: `CONTENT OK pane 2`.

**Step 5: Commit**

`git add web/e2e/divider-resize.e2e.md && git commit -m "test(phase3): e2e divider-drag resize propagation (two-clock, no OCR)"`

---

### Task 14: E2E — maximize / restore

Prove single-surface mode (seam S1): maximizing a region hides its sibling and the focused surface fills the workspace; restore brings the dock back. Content survives the re-parent (registry keeps terminals alive).

**Files:**
- Create: `web/e2e/maximize-restore.e2e.md`

**Step 1: Write the failing assertion (expect both regions first)**

In the same docked session:

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region').length"
```
Expected: `2`. (The maximize assertion in Step 4 expects `1`; it FAILS until you click maximize.)

**Step 2: Run to find the maximize button**

```bash
playwright-cli --raw eval "(() => { const r = document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelector('mux-region'); return r.shadowRoot.querySelector('button[data-action=\"maximize\"]') ? 'found' : 'missing'; })()"
```
Expected: `found`.

**Step 3: Click maximize (single mode)**

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelector('mux-region').shadowRoot.querySelector('button[data-action=\"maximize\"]').click()"
sleep 0.3
```

**Step 4: Assert single-surface mode (verify pass), then restore**

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region').length"
```
Expected: `1` (sibling hidden; seam S1 single mode).

Confirm content of the maximized surface survived the re-parent (CONTENT fidelity):

```bash
source web/e2e/dock-mount.e2e.md
assert_content 1
```
Expected: `CONTENT OK pane 1`.

Restore and confirm the dock returns:

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelector('mux-region').shadowRoot.querySelector('button[data-action=\"maximize\"]').click()"
sleep 0.3
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region').length"
```
Expected: `2` (restored to dock). Close the browser when done: `playwright-cli close`.

**Step 5: Commit**

`git add web/e2e/maximize-restore.e2e.md && git commit -m "test(phase3): e2e maximize/restore single-surface mode (content survives re-parent)"`

---

### Task 15: Full suite green + final commit

Run every gate together. Everything must pass before Phase 3 is done.

**Files:** none (verification only)

**Step 1: Run the Go suite**

Run: `go test ./...`
Expected: `ok` for all packages, including `internal/server` (the 6 `SurfaceRouter` tests). No failures.

**Step 2: Run the frontend unit suite**

Run: `cd web && npm test`
Expected: all suites pass — `cell-budget.test.ts` (8), `resize-coalescer.test.ts` (4), `workspace.test.ts` (10), `region-divider.test.ts` (3), `region.test.ts` (4), `components/workspace.test.ts` (6), `app-workspace.test.ts` (1). No failures.

**Step 3: Typecheck + build the frontend**

Run: `cd web && npm run build`
Expected: `tsc --noEmit` clean (zero errors) and `vite build` writes `web/dist` with no warnings about unresolved imports.

**Step 4: Build the Go binary**

Run: `go build ./...`
Expected: clean build, no errors.

**Step 5: Re-run the three E2E scripts against `make dev`**

Replay `web/e2e/dock-mount.e2e.md`, `web/e2e/divider-resize.e2e.md`, `web/e2e/maximize-restore.e2e.md` end to end (dev server on `localhost:8080`). Expected: `CONTENT OK`, `PROPAGATION OK`, region counts `1`↔`2` as documented. Then:

`git add -A && git commit -m "chore(phase3): full suite green — Layer-2 dock complete"`

---

## Definition of Done

- [ ] N surfaces mount at once; each is its own tmux `-CC` control client with `select-window` + `aggressive-resize on` (Task 9).
- [ ] Per-surface `cols×rows` budget routed via `refresh-client` to that surface's client (Tasks 9, 11).
- [ ] Two clocks: PIXEL (CSS/xterm, no backend) decoupled from CELL (debounced ~40ms, latest-wins, no-op when no cell boundary crossed) (Tasks 3, 11).
- [ ] `setSurfacePixelBox` is the single input-agnostic entry point; measurement via per-surface `ResizeObserver`, never `window.innerHeight` (Task 2).
- [ ] One-window-one-surface invariant enforced (Task 4).
- [ ] Maximize = single-surface mode (seam S1); restore returns to dock (Tasks 4, 7, 14).
- [ ] Heavy region divider distinct from thin tmux pane divider (Task 5).
- [ ] `%output` deduped by global `%N` across clients (Task 10).
- [ ] Every re-parent/resize verified with CONTENT + LAYOUT fidelity (tmux `capture-pane` == xterm snapshot; xterm dims == `playwright-cli` geometry). NO OCR (Tasks 12–14).
- [ ] All seams clean for deferred work: single-surface first-class, async fire-and-forget resize (S5), pop-out/chrome/config NOT built here.

## Notes for the Implementer

- **Reuse, don't rewrite.** `<mux-layout>`, `<mux-pane>`, and `terminalRegistry` are already position-agnostic. Docking is a "where do I mount it" problem, not a "keep the terminal alive" problem — the registry handles survival. Do not touch `terminal-registry.ts` except where Task 11 reads cell metrics.
- **The `.js` import extensions are intentional.** This project uses ESM with explicit `.js` extensions in TS imports (see existing files). Match it.
- **Phase 1 seam:** if Phase 1's pool API differs, the only adapter you need is making each pool control-client satisfy the `surfaceClient` interface in `surface.go` (`SelectWindow`, `SetAggressiveResize`, `RefreshClientSize`, `Close`). Keep `SurfaceRouter` unchanged.
- **Phase 2 seam:** if the harness exposes a different global than `window.__muxterm.snapshot(paneId)`, update the `eval` strings in the E2E `.md` files only.
- **If a task takes >5 min,** stop and split it — a divider-drag flake usually means the CELL-clock debounce hasn't settled; add `sleep`, don't change the debounce.
