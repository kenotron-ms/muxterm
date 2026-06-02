# Session Persistence — Phase 4: Browser Multiplexer (Frontend) Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

> **Protocol ownership (read first):** The wire-protocol types and message vocabulary are **owned by Phase 0** (`docs/plans/2026-06-02-session-persistence-phase0-wire-contract-implementation.md`), which already added the mirrored TypeScript contract to `web/src/types.ts` — `SessiondMessage`, `SessiondType`, `SessiondErrorCode`, `SessiondWorkspaceInfo`, `SessiondPaneInfo`, and the binary-frame helpers `encodePaneFrame`/`decodePaneFrame`. **This phase CONSUMES those symbols. It does NOT redefine any protocol type, message-`type` literal, error code, or frame layout.** If you find yourself typing `'attach'` or `'composition'` as a raw string, or re-declaring a `Message`/`WorkspaceInfo`/`PaneInfo` shape, stop — import it from `./types` instead.

**Goal:** Make the browser the multiplexer — a responsive layout engine, per-`(workspaceId, viewport)` arrangement persistence, a workspace picker, and multi-client event handling — all in `web/src/` (TypeScript/Lit), speaking the **frozen v1 wire vocabulary** the daemon emits and `serve` relays 1:1.

**Architecture:** Layout is two layers (design §"Two-layer layout model"). The daemon owns **composition** (which panes belong to a workspace); the browser owns **arrangement** (how those panes are laid out). The arrangement is a *pure responsive function* of `(composition, viewport class)` — `wide`=tiling, `medium`=fewer splits, `narrow`=tabbed — never a stored picture. Arrangement *preferences* persist in `localStorage` keyed by the **stable** `workspaceId` (so renames never lose layout). Multi-client semantics fall out of the model: composition is shared (broadcast `pane-added`/`pane-closed`), arrangement is per-client, and PTY size is contested via active-view-wins.

**Tech Stack:** TypeScript, Lit 3, xterm.js 6 (`@xterm/xterm` + `@xterm/addon-fit`), vitest. Tests live in `web/src/__tests__/*.test.ts`. Run a single file with `cd web && npx vitest run src/__tests__/<file>.test.ts`; run the whole suite with `cd web && npm test`.

---

## Source of truth & boundaries

- **Design doc (authoritative, never contradict):** `docs/plans/2026-06-01-session-persistence-design.md`. Key sections: **"Wire Protocol (frozen v1 contract)"**, "Identity model", "Two-layer layout model", "Responsive arrangement", "Workspace lifecycle", "Multiple browsers attached to one workspace", "Connection & delivery model".
- **This is Phase 4 of 5.** It is the **frontend** phase. **NO Go changes.** It consumes the frozen `SessiondMessage` JSON control vocabulary (relayed by Phase 3's `serve`) and the binary WebSocket pane framing `[4-byte LE paneId][bytes]` (now centralised in Phase 0's `encodePaneFrame`/`decodePaneFrame`).
- **OUT of scope:** all Go/daemon/`serve` work (Phases 0–3); buffer fidelity (Phase 5). Do **NOT** change the wire framing, the protocol types, or auth. Keep xterm.js as the renderer.

### The frozen browser ⇄ serve contract this phase consumes

After the wire freeze, the browser speaks the **same flat `Message` envelope** as the daemon. `serve` is a stateless translator: control crosses the WebSocket as a **JSON text frame** carrying the exact `SessiondMessage` shape (`{ type, ...fields }`, NOT a single-key `{ "<event>": payload }` envelope); pane output (down) and keyboard input (up) cross as **binary frames** `[4-byte LE paneId][bytes]`.

**Client → server (requests; flat `SessiondMessage`, sent as JSON text):**

| `type` (use `SessiondType.*`) | Fields | Meaning |
| --- | --- | --- |
| `list-workspaces` | — | request the workspace list |
| `create-workspace` | `name?` | daemon allocates + replies `workspace-created {workspaceId}` |
| `rename-workspace` | `workspaceId, name` | set/clear optional display label (empty `name` clears) |
| `close-workspace` | `workspaceId` | kill all panes + remove workspace |
| `attach` | `workspaceId` | bind this connection to a workspace (replaces any prior attach) |
| `create-pane` | `cmd?` (argv `string[]`) | fork a PTY in the **attached** workspace (connection-scoped, no `workspaceId`) |
| `resize` | `paneId, cols, rows` | resize a pane's PTY (connection-scoped; rendered-frame measurement) |

**Keyboard input is NOT a control message** — it is a **binary** `[4-byte LE paneId][bytes]` frame (`encodePaneFrame`), connection-scoped to the attached workspace.

**Server → client (replies + events; flat `SessiondMessage`, received as JSON text):**

| `type` | Fields | Meaning |
| --- | --- | --- |
| `composition` | `workspaceId, panes: PaneInfo[]` | reply to `attach`; per-pane replay binary frames follow, then live |
| `workspace-list` | `workspaces: WorkspaceInfo[]` | reply to `list-workspaces` |
| `workspace-created` | `workspaceId` | reply to `create-workspace` (drives the no-survivor recovery path) |
| `pane-added` | `paneId, cols, rows, title` | composition grew — idempotent, dedup by `paneId` |
| `pane-closed` | `paneId` | composition shrank |
| `workspace-closed` | `workspaceId` | workspace reaped/closed; emitted AFTER the final `pane-closed` → clients **ignore trailing** `pane-closed` |
| `workspace-renamed` | `workspaceId, name` | label changed (`name` omitted/empty ⇒ unnamed) |
| `error` | `code, error, workspaceId?` | typed error; `code:"unknown-workspace"` triggers client recovery |

> **ID types (from the frozen `PaneInfo`/`WorkspaceInfo`/`Message`):** `workspaceId` is a **string** (opaque, daemon-allocated). `paneId` is a **number** (workspace-local, fits the 4-byte LE frame). `name`/`title` are optional — treat missing/`""` as "unnamed". There is **no** `cid` on the browser side (the relay handles correlation server-side); the browser sends flat requests and reacts to replies/events by `type`.

### Codebase facts already verified

- `web/src/types.ts` — Phase-0 mirror types live here: `SessiondMessage`, `SessiondType`, `SessiondErrorCode`, `SessiondWorkspaceInfo`, `SessiondPaneInfo`, `encodePaneFrame(paneId, data)`, `decodePaneFrame(buf)`. Also still holds the legacy tmux `ServerMessage`/`ClientMessage` unions (untouched by this phase).
- `web/src/state.ts` — `MuxStore` (subscribe/`_notify`, tmux `applyMessage(msg)`), module singleton `store`. Phase 4 ADDS a parallel `applySessiond(msg: SessiondMessage)` path + composition state; it does not disturb the tmux path.
- `web/src/ws.ts` — `MuxSocket` (binary framing, reconnect/backoff, `sendPaneInput`, `sendControl`, `onPaneOutput`, `onControlMessage`, `onReconnect`). Phase 4 ADDS flat-`SessiondMessage` senders + an `onSessiondMessage` receive hook, and routes binary frames through `decodePaneFrame`.
- `web/src/lib/terminal-registry.ts` — module singleton `terminalRegistry`; one xterm.js per **number** paneId; `ensure(paneId, {onInput,onResize})`, `attach`, `detach`, `write`, `prune(liveIds)`, `getTerminal`, `resetAll`. The `onResize(cols, rows)` callback fires the **measured rendered grid** dimensions (via `FitAddon`), idempotently gated by `lastCols`/`lastRows`.
- `web/src/components/session-picker.ts` — `mux-session-picker` Lit element. Phase 4 repurposes this into `workspace-picker.ts`.
- Tests: `web/src/__tests__/*.test.ts`. Style: `vitest` (`describe/it/expect/vi`), Lit elements created via `document.createElement(...)` + `await el.updateComplete`. xterm.js is mocked via `web/src/__tests__/setup.ts`.

### Conventions every task must follow

- **TDD:** write the failing test first, watch it fail, write minimal code, watch it pass, commit. One action per step.
- **Consume, don't redefine:** import every protocol symbol from `./types`. Never write a raw message-`type` string — use `SessiondType.*`; never write a raw error code — use `SessiondErrorCode.*`.
- **TypeScript imports:** use `.js` extensions on relative imports (matches the existing codebase, e.g. `import { x } from './lib/config.js'`). Type-only imports from `./types` may omit the extension (matches the existing `import type { ... } from './types'`).
- **Commit message footer (every commit):**
  ```
  🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

  Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
  ```
- **No** `git push`, no merge, no PR.

---

## Task 1: Viewport-class breakpoints (pure)

**Files:**
- Create: `web/src/lib/layout.ts`
- Test: `web/src/__tests__/layout.test.ts`

**Step 1: Write the failing test**

Create `web/src/__tests__/layout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { viewportClassFor, type ViewportClass } from '../lib/layout.js';

describe('viewportClassFor', () => {
  it('classifies wide desktop widths as "wide"', () => {
    expect(viewportClassFor(1280)).toBe<ViewportClass>('wide');
    expect(viewportClassFor(1024)).toBe<ViewportClass>('wide'); // lower bound of wide
  });

  it('classifies tablet/laptop widths as "medium"', () => {
    expect(viewportClassFor(900)).toBe<ViewportClass>('medium');
    expect(viewportClassFor(640)).toBe<ViewportClass>('medium'); // lower bound of medium
  });

  it('classifies phone/portrait widths as "narrow"', () => {
    expect(viewportClassFor(480)).toBe<ViewportClass>('narrow');
    expect(viewportClassFor(0)).toBe<ViewportClass>('narrow');
  });

  it('is monotonic across the breakpoints (no gaps)', () => {
    expect(viewportClassFor(639)).toBe('narrow');
    expect(viewportClassFor(640)).toBe('medium');
    expect(viewportClassFor(1023)).toBe('medium');
    expect(viewportClassFor(1024)).toBe('wide');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/layout.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/layout.js"` (module does not exist yet).

**Step 3: Write minimal implementation**

Create `web/src/lib/layout.ts`:

```ts
/**
 * layout — pure responsive arrangement engine (design §"Responsive arrangement").
 *
 * The arrangement is a pure function of (composition, viewport class). Nothing
 * here touches the DOM, localStorage, or the network. Breakpoints borrow from
 * responsive web design:
 *   wide   (desktop/ultrawide):  tiling  — all peers visible
 *   medium (tablet/laptop):      tiling  — fewer simultaneous splits
 *   narrow (phone/portrait):     tabbed  — one peer visible
 */

export type ViewportClass = 'wide' | 'medium' | 'narrow';

/** Breakpoint lower bounds, in CSS pixels. */
export const BREAKPOINTS = {
  /** >= WIDE_MIN → wide */
  WIDE_MIN: 1024,
  /** >= MEDIUM_MIN and < WIDE_MIN → medium; below → narrow */
  MEDIUM_MIN: 640,
} as const;

/** Map a viewport width (CSS px) to its responsive class. */
export function viewportClassFor(widthPx: number): ViewportClass {
  if (widthPx >= BREAKPOINTS.WIDE_MIN) return 'wide';
  if (widthPx >= BREAKPOINTS.MEDIUM_MIN) return 'medium';
  return 'narrow';
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/layout.test.ts`
Expected: PASS (4 passing).

**Step 5: Commit**

```
cd web && git add src/lib/layout.ts src/__tests__/layout.test.ts && git commit -m "$(cat <<'EOF'
feat(web): add responsive viewport-class breakpoints

Pure viewportClassFor(width) → wide|medium|narrow, the first half of the
browser-multiplexer responsive layout engine (Phase 4).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 2: Arrangement engine (pure)

**Files:**
- Modify: `web/src/lib/layout.ts`
- Test: `web/src/__tests__/layout.test.ts` (append)

The arrangement model treats panes as **peers** (design: "these panes are peers; render them however the current viewport class dictates"). The engine produces an `Arrangement` from a `Composition` + `ViewportClass`. `wide` shows all peers tiled; `medium` tiles at most 2 (the active one plus its nearest peer); `narrow` shows exactly 1 (the active). Order is preserved; the active pane is always visible.

> **Note on `Composition`:** this pure layer works in terms of **plain pane ids** (`paneIds: number[]`), the device-independent projection of the frozen `PaneInfo[]` composition. The store (Task 6) keeps the full `SessiondPaneInfo[]` and projects it into this shape, so `layout.ts` stays pure and free of wire types.

**Step 1: Write the failing test** — append to `web/src/__tests__/layout.test.ts`:

```ts
import { arrange, type Composition, type Arrangement } from '../lib/layout.js';

describe('arrange', () => {
  const comp = (paneIds: number[], active: number): Composition => ({ paneIds, activePaneId: active });

  it('wide: tiling, all peers visible, order preserved', () => {
    const a: Arrangement = arrange(comp([1, 2, 3], 2), 'wide');
    expect(a.mode).toBe('tiling');
    expect(a.order).toEqual([1, 2, 3]);
    expect(a.visible).toEqual([1, 2, 3]);
    expect(a.active).toBe(2);
  });

  it('narrow: tabbed, only the active pane visible', () => {
    const a = arrange(comp([1, 2, 3], 2), 'narrow');
    expect(a.mode).toBe('tabbed');
    expect(a.order).toEqual([1, 2, 3]);
    expect(a.visible).toEqual([2]);
    expect(a.active).toBe(2);
  });

  it('medium: tiling but at most 2 visible, including the active pane', () => {
    const a = arrange(comp([1, 2, 3, 4], 3), 'medium');
    expect(a.mode).toBe('tiling');
    expect(a.order).toEqual([1, 2, 3, 4]);
    expect(a.visible.length).toBe(2);
    expect(a.visible).toContain(3); // active is always visible
  });

  it('single pane: always one tiled, visible pane regardless of class', () => {
    for (const vc of ['wide', 'medium', 'narrow'] as const) {
      const a = arrange(comp([7], 7), vc);
      expect(a.visible).toEqual([7]);
      expect(a.active).toBe(7);
    }
  });

  it('falls back to the first pane as active when activePaneId is absent', () => {
    const a = arrange(comp([5, 6], 999), 'wide');
    expect(a.active).toBe(5);
    expect(a.visible).toContain(5);
  });

  it('empty composition yields an empty arrangement', () => {
    const a = arrange(comp([], 0), 'wide');
    expect(a.order).toEqual([]);
    expect(a.visible).toEqual([]);
    expect(a.active).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/layout.test.ts`
Expected: FAIL — `arrange` / `Composition` / `Arrangement` are not exported.

**Step 3: Write minimal implementation** — append to `web/src/lib/layout.ts`:

```ts
/** Layer 1 — device-independent composition (which panes belong to the workspace). */
export interface Composition {
  /** Ordered peer pane ids (workspace-local). */
  paneIds: number[];
  /** The pane the user last focused; may be stale/absent. */
  activePaneId: number;
}

export type ArrangementMode = 'tiling' | 'tabbed';

/** Layer 2 — device-specific arrangement, derived per viewport class. */
export interface Arrangement {
  mode: ArrangementMode;
  /** All peers, in stable order (drives the tab strip in tabbed mode). */
  order: number[];
  /** Pane ids actually rendered for this viewport class. */
  visible: number[];
  /** The focused pane, or null when the composition is empty. */
  active: number | null;
}

/** Max simultaneously-visible peers per viewport class. */
const MAX_VISIBLE: Record<ViewportClass, number> = {
  wide: Infinity,
  medium: 2,
  narrow: 1,
};

/**
 * Pure: derive an Arrangement from a Composition + viewport class.
 * Always keeps the active pane visible; fills remaining visible slots from the
 * peer order starting at the active pane and wrapping forward.
 */
export function arrange(composition: Composition, viewportClass: ViewportClass): Arrangement {
  const order = [...composition.paneIds];
  if (order.length === 0) {
    return { mode: viewportClass === 'narrow' ? 'tabbed' : 'tiling', order: [], visible: [], active: null };
  }

  const active = order.includes(composition.activePaneId) ? composition.activePaneId : order[0];
  const mode: ArrangementMode = viewportClass === 'narrow' ? 'tabbed' : 'tiling';

  const cap = Math.min(MAX_VISIBLE[viewportClass], order.length);
  const startIdx = order.indexOf(active);
  const visible: number[] = [];
  for (let i = 0; i < cap; i++) {
    visible.push(order[(startIdx + i) % order.length]);
  }
  // Re-sort visible into the stable peer order for deterministic rendering.
  visible.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return { mode, order, visible, active };
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/layout.test.ts`
Expected: PASS (all `viewportClassFor` + `arrange` tests green).

**Step 5: Commit**

```
cd web && git add src/lib/layout.ts src/__tests__/layout.test.ts && git commit -m "$(cat <<'EOF'
feat(web): add pure arrange() responsive layout engine

arrange(composition, viewportClass) → Arrangement. Panes are peers; wide
tiles all, medium tiles ≤2, narrow tabs to 1. Active pane always visible,
order preserved. Pure + unit-tested (Phase 4).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 3: Arrangement store (localStorage, keyed by stable workspaceId)

**Files:**
- Create: `web/src/lib/arrangement-store.ts`
- Test: `web/src/__tests__/arrangement-store.test.ts`

Persists per-`(workspaceId, viewportProfile)` arrangement preferences in `localStorage`. The key uses the **stable** `workspaceId` so a rename never loses layout (design §"Two-layer layout model"). When nothing is saved, it auto-generates a responsive default via `arrange()`.

**Step 1: Write the failing test**

Create `web/src/__tests__/arrangement-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ArrangementStore } from '../lib/arrangement-store.js';
import type { Composition } from '../lib/layout.js';

const comp = (paneIds: number[], active: number): Composition => ({ paneIds, activePaneId: active });

describe('ArrangementStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('auto-generates a responsive default when nothing is saved', () => {
    const store = new ArrangementStore();
    const a = store.load('ws-1', 'wide', comp([1, 2], 1));
    expect(a.mode).toBe('tiling');
    expect(a.visible).toEqual([1, 2]);
  });

  it('round-trips a saved arrangement for a (workspaceId, profile) key', () => {
    const store = new ArrangementStore();
    store.save('ws-1', 'wide', { order: [2, 1], activePaneId: 2 });
    const a = store.load('ws-1', 'wide', comp([1, 2], 1));
    // saved order wins over composition order; saved active wins
    expect(a.order).toEqual([2, 1]);
    expect(a.active).toBe(2);
  });

  it('keys are independent per viewport profile', () => {
    const store = new ArrangementStore();
    store.save('ws-1', 'wide', { order: [1, 2], activePaneId: 1 });
    const narrow = store.load('ws-1', 'narrow', comp([1, 2], 1));
    expect(narrow.mode).toBe('tabbed'); // narrow had nothing saved → responsive default
  });

  it('keys on the stable workspaceId — a rename does not lose layout', () => {
    const store = new ArrangementStore();
    store.save('ws-stable-id', 'wide', { order: [3, 1, 2], activePaneId: 3 });
    // workspace renamed: same id, different display name — load still hits.
    const a = store.load('ws-stable-id', 'wide', comp([1, 2, 3], 1));
    expect(a.order).toEqual([3, 1, 2]);
  });

  it('drops saved pane ids that are no longer in the composition', () => {
    const store = new ArrangementStore();
    store.save('ws-1', 'wide', { order: [1, 2, 99], activePaneId: 99 });
    const a = store.load('ws-1', 'wide', comp([1, 2], 1));
    expect(a.order).toEqual([1, 2]); // 99 pruned
    expect(a.active).toBe(1); // stale active fell back to composition active
  });

  it('appends newly-composed pane ids not present in the saved order', () => {
    const store = new ArrangementStore();
    store.save('ws-1', 'wide', { order: [2], activePaneId: 2 });
    const a = store.load('ws-1', 'wide', comp([1, 2, 3], 2));
    expect(a.order).toEqual([2, 1, 3]); // saved order first, then new peers appended
  });

  it('survives malformed localStorage entries by falling back to default', () => {
    localStorage.setItem('muxterm.arrangement.ws-1.wide', '{not json');
    const store = new ArrangementStore();
    const a = store.load('ws-1', 'wide', comp([1], 1));
    expect(a.visible).toEqual([1]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/arrangement-store.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/arrangement-store.js"`.

**Step 3: Write minimal implementation**

Create `web/src/lib/arrangement-store.ts`:

```ts
/**
 * arrangement-store — Layer-2 persistence (design §"Two-layer layout model").
 *
 * Saves per-(workspaceId, viewportProfile) arrangement PREFERENCES in
 * localStorage. The key uses the STABLE, opaque workspaceId, so a workspace
 * rename never loses its saved layout. When nothing is saved, load() falls
 * back to a responsive default via arrange().
 */

import { arrange, type Arrangement, type Composition, type ViewportClass } from './layout.js';

/** The persisted slice — only what the user can't recompute from composition. */
export interface SavedArrangement {
  /** User's preferred peer order for this (workspace, profile). */
  order: number[];
  /** Last focused pane id for this (workspace, profile). */
  activePaneId: number;
}

const KEY_PREFIX = 'muxterm.arrangement';

function storageKey(workspaceId: string, profile: ViewportClass): string {
  return `${KEY_PREFIX}.${workspaceId}.${profile}`;
}

export class ArrangementStore {
  /** Persist the user's preferred order + active pane for this profile. */
  save(workspaceId: string, profile: ViewportClass, saved: SavedArrangement): void {
    try {
      localStorage.setItem(storageKey(workspaceId, profile), JSON.stringify(saved));
    } catch {
      // Quota / private-mode failures are non-fatal — arrangement is a convenience.
    }
  }

  /**
   * Load the arrangement for (workspaceId, profile) reconciled against the live
   * composition. Returns a responsive default when nothing valid is saved.
   */
  load(workspaceId: string, profile: ViewportClass, composition: Composition): Arrangement {
    const saved = this._read(workspaceId, profile);
    if (!saved) {
      return arrange(composition, profile);
    }

    const live = new Set(composition.paneIds);
    // 1. Keep saved order entries that still exist, in saved order.
    const order = saved.order.filter((id) => live.has(id));
    // 2. Append newly-composed panes not present in the saved order.
    for (const id of composition.paneIds) {
      if (!order.includes(id)) order.push(id);
    }
    // 3. Resolve active: saved active if still present, else composition's.
    const activePaneId = order.includes(saved.activePaneId)
      ? saved.activePaneId
      : composition.activePaneId;

    return arrange({ paneIds: order, activePaneId }, profile);
  }

  private _read(workspaceId: string, profile: ViewportClass): SavedArrangement | null {
    try {
      const raw = localStorage.getItem(storageKey(workspaceId, profile));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SavedArrangement;
      if (!parsed || !Array.isArray(parsed.order)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/arrangement-store.test.ts`
Expected: PASS (7 passing).

**Step 5: Commit**

```
cd web && git add src/lib/arrangement-store.ts src/__tests__/arrangement-store.test.ts && git commit -m "$(cat <<'EOF'
feat(web): add ArrangementStore keyed by stable (workspaceId, profile)

localStorage persistence for Layer-2 arrangement prefs. Reconciles saved
order against live composition (prune dead, append new), falls back to a
responsive default. Stable-id key ⇒ rename never loses layout (Phase 4).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 4: Frozen-vocabulary senders on `MuxSocket` (control + input)

**Files:**
- Modify: `web/src/ws.ts` (`MuxSocket` class)
- Test: `web/src/__tests__/ws.sessiond.test.ts` (create)

The browser now sends the **flat `SessiondMessage`** envelope as a JSON text frame — no single-key wrapping. This task adds typed senders that emit those frozen messages, plus a binary input sender built on Phase 0's `encodePaneFrame`. Active-view-wins is satisfied **by construction**: only rendered/visible panes have a live `ResizeObserver` (Task 9 + Task 12), so tabbed-away panes never call `resize`.

**Step 1: Write the failing test**

Create `web/src/__tests__/ws.sessiond.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MuxStore } from '../state.js';
import { MuxSocket } from '../ws.js';
import { decodePaneFrame } from '../types';

const OPEN = 1;
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = OPEN;
  OPEN = OPEN;
  url: string;
  readyState = OPEN;
  binaryType = '';
  sent: unknown[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(d: unknown): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
  }
}

let orig: typeof globalThis.WebSocket;
beforeEach(() => {
  orig = globalThis.WebSocket;
  MockWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
});
afterEach(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = orig;
});

function connected(): { sock: MuxSocket; ws: MockWebSocket } {
  const sock = new MuxSocket(new MuxStore(), 'ws://x/ws');
  sock.connect();
  const ws = MockWebSocket.instances[0];
  ws.onopen?.(new Event('open'));
  return { sock, ws };
}

describe('MuxSocket — frozen SessiondMessage senders', () => {
  it('attach() sends a flat attach message with workspaceId', () => {
    const { sock, ws } = connected();
    sock.attach('ws-2');
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'attach', workspaceId: 'ws-2' });
  });

  it('listWorkspaces() sends a flat list-workspaces message', () => {
    const { sock, ws } = connected();
    sock.listWorkspaces();
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'list-workspaces' });
  });

  it('createWorkspace() omits name when not given, includes it when given', () => {
    const { sock, ws } = connected();
    sock.createWorkspace();
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'create-workspace' });
    sock.createWorkspace('api');
    expect(JSON.parse(ws.sent[1] as string)).toEqual({ type: 'create-workspace', name: 'api' });
  });

  it('renameWorkspace() / closeWorkspace() carry the workspaceId', () => {
    const { sock, ws } = connected();
    sock.renameWorkspace('ws-1', 'db');
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'rename-workspace', workspaceId: 'ws-1', name: 'db' });
    sock.closeWorkspace('ws-1');
    expect(JSON.parse(ws.sent[1] as string)).toEqual({ type: 'close-workspace', workspaceId: 'ws-1' });
  });

  it('createPane() is connection-scoped: no workspaceId; cmd is argv when present', () => {
    const { sock, ws } = connected();
    sock.createPane();
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'create-pane' });
    sock.createPane(['bash', '-l']);
    expect(JSON.parse(ws.sent[1] as string)).toEqual({ type: 'create-pane', cmd: ['bash', '-l'] });
  });

  it('resize() sends the measured rendered grid as a flat resize message', () => {
    const { sock, ws } = connected();
    sock.resize(7, 100, 40);
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'resize', paneId: 7, cols: 100, rows: 40 });
  });

  it('sendPaneInput() sends keyboard input as a binary [LE paneId][bytes] frame', () => {
    const { sock, ws } = connected();
    sock.sendPaneInput(3, new Uint8Array([0x6c, 0x73, 0x0d])); // "ls\r"
    const frame = ws.sent[0] as ArrayBuffer;
    expect(frame).toBeInstanceOf(ArrayBuffer);
    const { paneId, data } = decodePaneFrame(frame);
    expect(paneId).toBe(3);
    expect(Array.from(data)).toEqual([0x6c, 0x73, 0x0d]);
  });

  it('does not throw when the socket is not open', () => {
    const sock = new MuxSocket(new MuxStore(), 'ws://x/ws'); // never connected
    expect(() => sock.resize(1, 80, 24)).not.toThrow();
    expect(() => sock.sendPaneInput(1, new Uint8Array([1]))).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/ws.sessiond.test.ts`
Expected: FAIL — `sock.attach` / `sock.resize` / `sock.createPane` / etc. are not functions.

**Step 3: Write minimal implementation**

In `web/src/ws.ts`, extend the imports at the top of the file (add the Phase-0 symbols — keep the existing tmux type import line intact):

```ts
import { SessiondType, encodePaneFrame, type SessiondMessage } from './types';
```

Add a private text-send helper + the typed senders to the `MuxSocket` class (after the existing `sendControl` method, ~line 286). All control senders emit the **flat** `SessiondMessage`; the private helper guards on `readyState === OPEN`:

```ts
  /** Send a flat SessiondMessage (frozen control envelope) as a JSON text frame. */
  sendSessiond(msg: SessiondMessage): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  /** Bind this connection to a workspace by its stable id (replaces any prior attach). */
  attach(workspaceId: string): void {
    this.sendSessiond({ type: SessiondType.Attach, workspaceId });
  }

  /** Request the current workspace list (drives the picker + recovery). */
  listWorkspaces(): void {
    this.sendSessiond({ type: SessiondType.ListWorkspaces });
  }

  /** Ask the daemon to allocate a fresh workspace (id returned via workspace-created). */
  createWorkspace(name?: string): void {
    const msg: SessiondMessage = { type: SessiondType.CreateWorkspace };
    if (name) msg.name = name;
    this.sendSessiond(msg);
  }

  /** Set/clear a workspace's optional display label (empty name clears it). */
  renameWorkspace(workspaceId: string, name: string): void {
    this.sendSessiond({ type: SessiondType.RenameWorkspace, workspaceId, name });
  }

  /** Close a workspace and kill all its panes. */
  closeWorkspace(workspaceId: string): void {
    this.sendSessiond({ type: SessiondType.CloseWorkspace, workspaceId });
  }

  /**
   * Fork a new pane in the ATTACHED workspace. Connection-scoped: no workspaceId.
   * cmd is an optional argv (string[]); empty/omitted ⇒ daemon default $SHELL.
   */
  createPane(cmd?: string[]): void {
    const msg: SessiondMessage = { type: SessiondType.CreatePane };
    if (cmd && cmd.length > 0) msg.cmd = cmd;
    this.sendSessiond(msg);
  }

  /**
   * Resize a pane's PTY to the measured rendered grid (active-view-wins).
   * Connection-scoped. Called from terminalRegistry's onResize, which already
   * reports the actual xterm.js cols/rows and is idempotently gated, so only
   * real changes reach here.
   */
  resize(paneId: number, cols: number, rows: number): void {
    this.sendSessiond({ type: SessiondType.Resize, paneId, cols, rows });
  }
```

Then **refactor** the existing `sendPaneInput` to build its binary frame via the shared Phase-0 helper (replace the hand-rolled DataView body):

```ts
  sendPaneInput(paneId: number, data: Uint8Array): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(encodePaneFrame(paneId, data));
    }
  }
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/ws.sessiond.test.ts`
Expected: PASS (8 passing).

**Step 5: Commit**

```
cd web && git add src/ws.ts src/__tests__/ws.sessiond.test.ts && git commit -m "$(cat <<'EOF'
feat(web): send frozen SessiondMessage control + binary input on MuxSocket

attach/listWorkspaces/createWorkspace/rename/close/createPane/resize emit the
flat Phase-0 Message envelope; sendPaneInput uses the shared encodePaneFrame.
create-pane/resize are connection-scoped (no workspaceId) per the frozen
contract. Active-view-wins by construction (Phase 4).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 5: Receive routing on `MuxSocket` (`onSessiondMessage` + binary via `decodePaneFrame`)

**Files:**
- Modify: `web/src/ws.ts` (`MuxSocket` class, `_open` handler)
- Test: `web/src/__tests__/ws.sessiond.test.ts` (append)

Incoming text frames are now flat `SessiondMessage` objects (anything with a string `type`). Route them to a new `onSessiondMessage` hook so the store + controller can react by `type`. Binary frames decode through Phase 0's `decodePaneFrame`. The legacy tmux `normalizeMessage`/`applyMessage` path is left intact (a flat `{type:...}` message simply normalizes to `null`, so the two paths never collide).

**Step 1: Write the failing test** — append to `web/src/__tests__/ws.sessiond.test.ts`:

```ts
import { encodePaneFrame } from '../types';
import type { SessiondMessage } from '../types';

describe('MuxSocket — frozen SessiondMessage receive routing', () => {
  it('routes a flat text control frame to onSessiondMessage', () => {
    const { sock, ws } = connected();
    const seen: SessiondMessage[] = [];
    sock.onSessiondMessage = (m) => seen.push(m);
    ws.onmessage?.({
      data: JSON.stringify({ type: 'composition', workspaceId: 'w1', panes: [{ paneId: 1, cols: 80, rows: 24 }] }),
    } as MessageEvent);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('composition');
    expect(seen[0].workspaceId).toBe('w1');
    expect(seen[0].panes).toEqual([{ paneId: 1, cols: 80, rows: 24 }]);
  });

  it('decodes a binary pane frame and forwards it to onPaneOutput', () => {
    const { sock, ws } = connected();
    let got: { paneId: number; data: Uint8Array } | null = null;
    sock.onPaneOutput((paneId, data) => { got = { paneId, data }; });
    ws.onmessage?.({ data: encodePaneFrame(5, new Uint8Array([0x68, 0x69])) } as MessageEvent);
    expect(got).not.toBeNull();
    expect(got!.paneId).toBe(5);
    expect(Array.from(got!.data)).toEqual([0x68, 0x69]);
  });

  it('ignores a text frame with no type (e.g. the serve config envelope)', () => {
    const { sock, ws } = connected();
    const seen: SessiondMessage[] = [];
    sock.onSessiondMessage = (m) => seen.push(m);
    ws.onmessage?.({ data: JSON.stringify({ config: { theme: 'dark' } }) } as MessageEvent);
    expect(seen).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/ws.sessiond.test.ts`
Expected: FAIL — `onSessiondMessage` is not a settable field / not invoked; the binary path still uses the inline DataView (this test will pass for binary only once decode routing is confirmed — write the code to make all three pass).

**Step 3: Write minimal implementation**

In `web/src/ws.ts`, extend the import added in Task 4 to also pull `decodePaneFrame`:

```ts
import { SessiondType, encodePaneFrame, decodePaneFrame, type SessiondMessage } from './types';
```

Add the public hook field to the `MuxSocket` class (near `onDisconnect`/`onReconnect`, ~line 239):

```ts
  /** Invoked for every inbound flat SessiondMessage (frozen control vocabulary). */
  onSessiondMessage: ((msg: SessiondMessage) => void) | null = null;
```

In `_open`, update the `ws.onmessage` handler. Replace the inline binary DataView decode with `decodePaneFrame`, and add the flat-message route to the text branch:

```ts
    ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        if (ev.data.byteLength >= 4) {
          const { paneId, data } = decodePaneFrame(ev.data);
          this._paneOutputCb?.(paneId, data);
        }
        return;
      }
      // Text frame — JSON control message.
      if (typeof ev.data === 'string') {
        const raw = JSON.parse(ev.data) as Record<string, unknown>;
        // Legacy/non-typed envelopes (e.g. the serve `config` message) still flow here.
        this._controlMessageCb?.(raw);
        // Frozen flat SessiondMessage: anything carrying a string `type`.
        if (typeof raw.type === 'string') {
          this.onSessiondMessage?.(raw as unknown as SessiondMessage);
        }
        // Legacy tmux key-value envelope (returns null for flat {type:...} frames).
        const msg = normalizeMessage(raw);
        if (msg) {
          this._store.applyMessage(msg);
        }
      }
    };
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/ws.sessiond.test.ts`
Expected: PASS (all Task 4 + Task 5 cases green).

**Step 5: Commit**

```
cd web && git add src/ws.ts src/__tests__/ws.sessiond.test.ts && git commit -m "$(cat <<'EOF'
feat(web): route inbound frozen SessiondMessage + binary frames on MuxSocket

Adds onSessiondMessage hook for flat {type,...} text frames; decodes binary
pane frames via the shared decodePaneFrame. Legacy tmux normalize path left
intact (flat messages normalize to null) (Phase 4).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 6: Composition state + idempotent event handling in `MuxStore`

**Files:**
- Modify: `web/src/state.ts`
- Test: `web/src/__tests__/state.workspace.test.ts` (create)

Adds workspace/composition state to `MuxStore` via a **new** `applySessiond(msg: SessiondMessage)` method (separate from the legacy tmux `applyMessage`). It holds the frozen `SessiondPaneInfo[]` and projects a pure `Composition` (`{paneIds, activePaneId}`) for the layout engine. Handles `workspace-list`, `composition` (the `attach` reply), `pane-added` (idempotent, dedup by `paneId`), `pane-closed`, `workspace-closed` (clears attachment so trailing `pane-closed` is ignored), and `workspace-renamed`. (Recovery decisions live in the controller, Task 11.)

**Step 1: Write the failing test**

Create `web/src/__tests__/state.workspace.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { MuxStore } from '../state.js';

describe('MuxStore — workspace composition (frozen vocabulary)', () => {
  it('starts with no workspaces and no attachment', () => {
    const store = new MuxStore();
    expect(store.workspaces).toEqual([]);
    expect(store.attached).toBeNull();
    expect(store.composition.paneIds).toEqual([]);
  });

  it('stores the workspace list from workspace-list', () => {
    const store = new MuxStore();
    store.applySessiond({
      type: 'workspace-list',
      workspaces: [
        { workspaceId: 'ws-1', name: 'api', paneCount: 2 },
        { workspaceId: 'ws-2', paneCount: 0 },
      ],
    });
    expect(store.workspaces.map((w) => w.workspaceId)).toEqual(['ws-1', 'ws-2']);
  });

  it('sets attachment + composition from the composition reply', () => {
    const store = new MuxStore();
    store.applySessiond({
      type: 'composition',
      workspaceId: 'ws-1',
      panes: [
        { paneId: 1, cols: 80, rows: 24 },
        { paneId: 2, cols: 80, rows: 24, title: 'vim' },
      ],
    });
    expect(store.attached).toBe('ws-1');
    expect(store.composition.paneIds).toEqual([1, 2]);
    expect(store.composition.activePaneId).toBe(1);
    expect(store.panes[1].title).toBe('vim');
  });

  it('pane-added appends a new pane (carrying its size + title)', () => {
    const store = new MuxStore();
    store.applySessiond({ type: 'composition', workspaceId: 'ws-1', panes: [{ paneId: 1, cols: 80, rows: 24 }] });
    store.applySessiond({ type: 'pane-added', paneId: 2, cols: 100, rows: 40, title: 'top' });
    expect(store.composition.paneIds).toEqual([1, 2]);
    expect(store.panes[1]).toEqual({ paneId: 2, cols: 100, rows: 40, title: 'top' });
  });

  it('pane-added is idempotent — dedup by paneId (actor + broadcast)', () => {
    const store = new MuxStore();
    store.applySessiond({ type: 'composition', workspaceId: 'ws-1', panes: [{ paneId: 1, cols: 80, rows: 24 }] });
    store.applySessiond({ type: 'pane-added', paneId: 2, cols: 80, rows: 24 });
    store.applySessiond({ type: 'pane-added', paneId: 2, cols: 80, rows: 24 }); // duplicate broadcast
    expect(store.composition.paneIds).toEqual([1, 2]);
  });

  it('pane-closed removes the pane id', () => {
    const store = new MuxStore();
    store.applySessiond({
      type: 'composition',
      workspaceId: 'ws-1',
      panes: [{ paneId: 1, cols: 80, rows: 24 }, { paneId: 2, cols: 80, rows: 24 }, { paneId: 3, cols: 80, rows: 24 }],
    });
    store.applySessiond({ type: 'pane-closed', paneId: 2 });
    expect(store.composition.paneIds).toEqual([1, 3]);
  });

  it('pane-closed of the active pane re-points active to a survivor', () => {
    const store = new MuxStore();
    store.applySessiond({ type: 'composition', workspaceId: 'ws-1', panes: [{ paneId: 1, cols: 80, rows: 24 }, { paneId: 2, cols: 80, rows: 24 }] });
    store.setActivePane(2);
    store.applySessiond({ type: 'pane-closed', paneId: 2 });
    expect(store.composition.activePaneId).toBe(1);
  });

  it('workspace-closed clears attachment so a trailing pane-closed is ignored', () => {
    const store = new MuxStore();
    store.applySessiond({ type: 'composition', workspaceId: 'ws-1', panes: [{ paneId: 1, cols: 80, rows: 24 }] });
    store.applySessiond({ type: 'workspace-closed', workspaceId: 'ws-1' });
    expect(store.attached).toBeNull();
    expect(store.composition.paneIds).toEqual([]);
    // Trailing pane-closed after workspace-closed is a no-op.
    store.applySessiond({ type: 'pane-closed', paneId: 1 });
    expect(store.composition.paneIds).toEqual([]);
  });

  it('workspace-renamed updates the matching summary label', () => {
    const store = new MuxStore();
    store.applySessiond({ type: 'workspace-list', workspaces: [{ workspaceId: 'ws-1', paneCount: 1 }] });
    store.applySessiond({ type: 'workspace-renamed', workspaceId: 'ws-1', name: 'db' });
    expect(store.workspaces.find((w) => w.workspaceId === 'ws-1')?.name).toBe('db');
  });

  it('workspace-renamed with omitted name clears the label', () => {
    const store = new MuxStore();
    store.applySessiond({ type: 'workspace-list', workspaces: [{ workspaceId: 'ws-1', name: 'db', paneCount: 1 }] });
    store.applySessiond({ type: 'workspace-renamed', workspaceId: 'ws-1' }); // omitempty ⇒ no name
    expect(store.workspaces.find((w) => w.workspaceId === 'ws-1')?.name).toBeUndefined();
  });

  it('notifies subscribers on composition changes', () => {
    const store = new MuxStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.applySessiond({ type: 'composition', workspaceId: 'ws-1', panes: [{ paneId: 1, cols: 80, rows: 24 }] });
    store.applySessiond({ type: 'pane-added', paneId: 2, cols: 80, rows: 24 });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/state.workspace.test.ts`
Expected: FAIL — `store.workspaces` / `store.attached` / `store.composition` / `store.panes` / `store.setActivePane` / `store.applySessiond` don't exist.

**Step 3: Write minimal implementation**

In `web/src/state.ts`, extend the imports (line 1):

```ts
import type { ServerMessage, TmuxState, SessionInfo, SessiondMessage, SessiondWorkspaceInfo, SessiondPaneInfo } from './types';
import { SessiondType } from './types';
import type { Composition } from './lib/layout.js';
```

Add fields to the `MuxStore` class (after the existing private fields, ~line 17):

```ts
  private _workspaces: SessiondWorkspaceInfo[] = [];
  private _attached: string | null = null;
  private _panes: SessiondPaneInfo[] = [];
  private _activePaneId = 0;
```

Add accessors + a focus setter (after the existing getters, ~line 29):

```ts
  get workspaces(): SessiondWorkspaceInfo[] {
    return this._workspaces;
  }

  /** The currently-attached workspace id, or null when detached. */
  get attached(): string | null {
    return this._attached;
  }

  /** The full frozen pane composition (paneId/cols/rows/title) of the attached workspace. */
  get panes(): SessiondPaneInfo[] {
    return this._panes;
  }

  /** Device-independent projection consumed by the pure layout engine. */
  get composition(): Composition {
    return { paneIds: this._panes.map((p) => p.paneId), activePaneId: this._activePaneId };
  }

  /** Record the locally-focused pane (drives active-pane-wins arrangement). */
  setActivePane(paneId: number): void {
    if (this._activePaneId === paneId) return;
    this._activePaneId = paneId;
    this._notify();
  }
```

Add the new handler method (e.g. just after `applyMessage`, before `_reconcileFromTmux`):

```ts
  /**
   * Apply a frozen SessiondMessage event to composition/workspace state. This is
   * the Phase-4 multiplexer path, parallel to the legacy tmux applyMessage.
   * Requests, the create reply, and errors are handled by the controller, not here.
   */
  applySessiond(msg: SessiondMessage): void {
    switch (msg.type) {
      case SessiondType.WorkspaceList:
        this._workspaces = msg.workspaces ?? [];
        break;

      case SessiondType.Composition:
        // Reply to attach: bind + replace composition.
        this._attached = msg.workspaceId ?? null;
        this._panes = [...(msg.panes ?? [])];
        this._activePaneId = this._panes[0]?.paneId ?? 0;
        break;

      case SessiondType.PaneAdded: {
        // Idempotent: the actor also receives the broadcast after its create-pane,
        // so dedup by paneId. Ignore if we are not attached (post-close trailing).
        if (this._attached === null) break;
        const id = msg.paneId ?? 0;
        if (!this._panes.some((p) => p.paneId === id)) {
          this._panes = [
            ...this._panes,
            { paneId: id, cols: msg.cols ?? 0, rows: msg.rows ?? 0, title: msg.title },
          ];
        }
        break;
      }

      case SessiondType.PaneClosed: {
        // Ignore a trailing pane-closed that arrives after workspace-closed.
        if (this._attached === null) break;
        const id = msg.paneId ?? 0;
        this._panes = this._panes.filter((p) => p.paneId !== id);
        if (this._activePaneId === id) {
          this._activePaneId = this._panes[0]?.paneId ?? 0; // re-point active to a survivor
        }
        break;
      }

      case SessiondType.WorkspaceClosed: {
        const id = msg.workspaceId ?? '';
        this._workspaces = this._workspaces.filter((w) => w.workspaceId !== id);
        // If WE were attached, clear attachment so trailing pane-closed is ignored.
        if (this._attached === id) {
          this._attached = null;
          this._panes = [];
          this._activePaneId = 0;
        }
        break;
      }

      case SessiondType.WorkspaceRenamed: {
        const ws = this._workspaces.find((w) => w.workspaceId === msg.workspaceId);
        if (ws) ws.name = msg.name ? msg.name : undefined;
        break;
      }

      default:
        // workspace-created / error / ok / pane-created / requests: not store state.
        return; // no notify
    }
    this._notify();
  }
```

> Title handling: `SessiondPaneInfo.title` is optional. A `pane-added` without a `title` field stores `title: undefined`, which matches the frozen `omitempty` semantics — do not coerce it to `''`.

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/state.workspace.test.ts`
Expected: PASS (11 passing).

**Step 5: Commit**

```
cd web && git add src/state.ts src/__tests__/state.workspace.test.ts && git commit -m "$(cat <<'EOF'
feat(web): track frozen workspace composition state in MuxStore

Adds applySessiond() handling workspace-list, composition (attach reply),
pane-added (idempotent dedup by paneId), pane-closed (re-points active),
workspace-closed (clears attachment ⇒ trailing pane-closed ignored), and
workspace-renamed. Projects a pure Composition for layout (Phase 4).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 7: Workspace-closed / unknown-workspace recovery target (pure)

**Files:**
- Create: `web/src/lib/workspace-recovery.ts`
- Test: `web/src/__tests__/workspace-recovery.test.ts`

A pure helper that decides, on `workspace-closed` or an `unknown-workspace` error, which surviving workspace to attach to (design §"Workspace lifecycle": "detach and attach to the most-recently-active surviving workspace; if none survive, create a fresh default"). Operates on the frozen `SessiondWorkspaceInfo` (keyed by `workspaceId`).

**Step 1: Write the failing test**

Create `web/src/__tests__/workspace-recovery.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { chooseRecoveryTarget } from '../lib/workspace-recovery.js';
import type { SessiondWorkspaceInfo } from '../types';

const ws = (workspaceId: string): SessiondWorkspaceInfo => ({ workspaceId, paneCount: 1 });

describe('chooseRecoveryTarget', () => {
  it('prefers the most-recently-active surviving workspace', () => {
    const survivors = [ws('a'), ws('b'), ws('c')];
    const result = chooseRecoveryTarget(survivors, 'closed-id', ['c', 'a', 'b']);
    expect(result).toEqual({ action: 'attach', workspaceId: 'c' });
  });

  it('skips the closed workspace even if it tops the MRU list', () => {
    const survivors = [ws('a'), ws('b')];
    const result = chooseRecoveryTarget(survivors, 'closed-id', ['closed-id', 'b', 'a']);
    expect(result).toEqual({ action: 'attach', workspaceId: 'b' });
  });

  it('falls back to the first survivor when MRU has no live match', () => {
    const survivors = [ws('x'), ws('y')];
    const result = chooseRecoveryTarget(survivors, 'closed-id', []);
    expect(result).toEqual({ action: 'attach', workspaceId: 'x' });
  });

  it('requests a fresh workspace when none survive', () => {
    const result = chooseRecoveryTarget([], 'closed-id', ['closed-id']);
    expect(result).toEqual({ action: 'create' });
  });

  it('never returns the closed workspace as the attach target', () => {
    const survivors = [ws('closed-id'), ws('z')]; // stale list still containing the closed id
    const result = chooseRecoveryTarget(survivors, 'closed-id', ['closed-id', 'z']);
    expect(result).toEqual({ action: 'attach', workspaceId: 'z' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/workspace-recovery.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/workspace-recovery.js"`.

**Step 3: Write minimal implementation**

Create `web/src/lib/workspace-recovery.ts`:

```ts
/**
 * workspace-recovery — pure policy for recovering from a dead/stale workspace
 * (design §"Workspace lifecycle" + §"Multiple browsers attached to one
 * workspace"). On workspace-closed or an unknown-workspace error, a co-attached
 * client detaches and attaches to the most-recently-active SURVIVING workspace;
 * if none survive, it requests a fresh daemon-allocated default.
 */

import type { SessiondWorkspaceInfo } from '../types';

export type RecoveryTarget =
  | { action: 'attach'; workspaceId: string }
  | { action: 'create' };

/**
 * @param survivors  workspaces still alive per the latest workspace-list
 * @param closedId   the workspace that just closed (must never be chosen)
 * @param mruOrder   workspace ids most-recently-active first (client-local)
 */
export function chooseRecoveryTarget(
  survivors: SessiondWorkspaceInfo[],
  closedId: string,
  mruOrder: string[],
): RecoveryTarget {
  const liveIds = new Set(survivors.map((w) => w.workspaceId));
  liveIds.delete(closedId);

  // 1. Most-recently-active surviving workspace.
  for (const id of mruOrder) {
    if (liveIds.has(id)) return { action: 'attach', workspaceId: id };
  }

  // 2. Any survivor (first in the list), excluding the closed one.
  for (const w of survivors) {
    if (w.workspaceId !== closedId) return { action: 'attach', workspaceId: w.workspaceId };
  }

  // 3. None survive — ask the daemon to allocate a fresh default.
  return { action: 'create' };
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/workspace-recovery.test.ts`
Expected: PASS (5 passing).

**Step 5: Commit**

```
cd web && git add src/lib/workspace-recovery.ts src/__tests__/workspace-recovery.test.ts && git commit -m "$(cat <<'EOF'
feat(web): add workspace-closed/unknown-workspace recovery policy

Pure chooseRecoveryTarget(survivors, closedId, mru) → attach MRU survivor or
create a fresh default, keyed on the frozen SessiondWorkspaceInfo.workspaceId
(Phase 4).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 8: Workspace picker component

**Files:**
- Create: `web/src/components/workspace-picker.ts` (repurposed from `session-picker.ts`)
- Test: `web/src/__tests__/workspace-picker.test.ts` (create)

A Lit element driven by `SessiondWorkspaceInfo[]`. Supports switch/create/rename/close. Each row's label is `workspace.name ?? "Workspace " + workspaceId` (design: `workspace.name ?? activePane.title`; the list reply carries no title, so the picker uses the id as the fallback display). Emits `workspace-selected`, `workspace-create`, `workspace-rename`, `workspace-close`, `close-picker` — each row event detail carries `{ workspaceId }` to match the frozen field name.

> We **create** the new component rather than editing `session-picker.ts` in place, so the existing `session-picker.test.ts` keeps passing until the app shell is repointed in Task 12. `session-picker.ts` is deleted in Task 12.

**Step 1: Write the failing test**

Create `web/src/__tests__/workspace-picker.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import '../components/workspace-picker.js';
import type { MuxWorkspacePicker } from '../components/workspace-picker.js';
import type { SessiondWorkspaceInfo } from '../types';

function makeWorkspaces(): SessiondWorkspaceInfo[] {
  return [
    { workspaceId: 'ws-1', name: 'api', paneCount: 3 },
    { workspaceId: 'ws-2', paneCount: 1 }, // unnamed
    { workspaceId: 'ws-3', name: 'db', paneCount: 2 },
  ];
}

async function fixture(
  workspaces: SessiondWorkspaceInfo[] = [],
  current = '',
): Promise<MuxWorkspacePicker> {
  const el = document.createElement('mux-workspace-picker') as MuxWorkspacePicker;
  el.workspaces = workspaces;
  el.currentWorkspaceId = current;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxWorkspacePicker', () => {
  let el: MuxWorkspacePicker;
  afterEach(() => el?.parentNode?.removeChild(el));

  it('registers as mux-workspace-picker', () => {
    expect(customElements.get('mux-workspace-picker')).toBeDefined();
  });

  it('renders one row per workspace', async () => {
    el = await fixture(makeWorkspaces());
    expect(el.shadowRoot!.querySelectorAll('button.ws-item').length).toBe(3);
  });

  it('labels named workspaces by name and unnamed by a stable id fallback', async () => {
    el = await fixture(makeWorkspaces());
    const labels = Array.from(el.shadowRoot!.querySelectorAll('.ws-name')).map((n) => n.textContent);
    expect(labels[0]).toBe('api');
    expect(labels[1]).toBe('Workspace ws-2'); // unnamed fallback
    expect(labels[2]).toBe('db');
  });

  it('shows pane-count meta with pluralization', async () => {
    el = await fixture(makeWorkspaces());
    const metas = Array.from(el.shadowRoot!.querySelectorAll('.ws-meta')).map((n) => n.textContent);
    expect(metas).toEqual(['3 panes', '1 pane', '2 panes']);
  });

  it('marks the current workspace with .sel', async () => {
    el = await fixture(makeWorkspaces(), 'ws-3');
    const sel = el.shadowRoot!.querySelector('button.ws-item.sel .ws-name');
    expect(sel?.textContent).toBe('db');
  });

  it('dispatches workspace-selected with the workspaceId on click', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('workspace-selected', handler as EventListener);
    (el.shadowRoot!.querySelectorAll('button.ws-item')[1] as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ workspaceId: 'ws-2' });
  });

  it('dispatches workspace-create when the new-workspace button is clicked', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('workspace-create', handler as EventListener);
    (el.shadowRoot!.querySelector('button.ws-new') as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('dispatches workspace-rename with workspaceId + name from the row action', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('workspace-rename', handler as EventListener);
    vi.spyOn(window, 'prompt').mockReturnValue('renamed');
    (el.shadowRoot!.querySelectorAll('button.ws-rename')[0] as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ workspaceId: 'ws-1', name: 'renamed' });
    vi.restoreAllMocks();
  });

  it('dispatches workspace-close with workspaceId from the row action', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('workspace-close', handler as EventListener);
    (el.shadowRoot!.querySelectorAll('button.ws-close')[2] as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ workspaceId: 'ws-3' });
  });

  it('clicking the dim overlay closes the picker', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('close-picker', handler as EventListener);
    (el.shadowRoot!.querySelector('.overlay') as HTMLElement).click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('defaults workspaces to an empty array', async () => {
    const picker = document.createElement('mux-workspace-picker') as MuxWorkspacePicker;
    document.body.appendChild(picker);
    await picker.updateComplete;
    el = picker;
    expect(picker.workspaces).toEqual([]);
    expect(picker.shadowRoot!.querySelectorAll('button.ws-item').length).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/workspace-picker.test.ts`
Expected: FAIL — `Failed to resolve import "../components/workspace-picker.js"`.

**Step 3: Write minimal implementation**

Create `web/src/components/workspace-picker.ts`:

```ts
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { Check, Plus, Pencil, X } from 'lucide';
import { icon } from '../lib/icons.js';
import type { SessiondWorkspaceInfo } from '../types';

/** The tab/picker label for a workspace: explicit name, else a stable id fallback. */
export function workspaceLabel(ws: SessiondWorkspaceInfo): string {
  return ws.name && ws.name.length > 0 ? ws.name : `Workspace ${ws.workspaceId}`;
}

@customElement('mux-workspace-picker')
export class MuxWorkspacePicker extends LitElement {
  static styles = css`
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    }
    .picker {
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 8px;
      padding: 24px;
      min-width: 360px;
      max-width: 520px;
    }
    h2 {
      margin: 0 0 16px 0;
      color: #cdd6f4;
      font-size: 18px;
      font-weight: 600;
    }
    .ws-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ws-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      background: #181825;
      border: 1px solid #45475a;
      border-radius: 6px;
      cursor: pointer;
      color: #cdd6f4;
      font: inherit;
      font-size: 14px;
      transition: border-color 0.15s;
    }
    .ws-item:hover {
      border-color: #89b4fa;
    }
    .ws-item.sel {
      border-color: #89b4fa;
    }
    .ck {
      width: 14px;
      flex-shrink: 0;
      color: #9ece6a;
      display: flex;
      align-items: center;
    }
    .ws-name {
      font-weight: 600;
      flex: 1;
      text-align: left;
    }
    .ws-meta {
      color: #6c7086;
      font-size: 12px;
    }
    .row-action {
      border: none;
      background: transparent;
      color: #6c7086;
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
    }
    .row-action:hover {
      color: #cdd6f4;
      background: #313244;
    }
    .ws-new {
      margin-top: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 10px 16px;
      border: 1px dashed #45475a;
      border-radius: 6px;
      background: transparent;
      color: #a6adc8;
      cursor: pointer;
      font: inherit;
      font-size: 14px;
    }
    .ws-new:hover {
      border-color: #89b4fa;
      color: #cdd6f4;
    }
  `;

  @property({ attribute: false })
  workspaces: SessiondWorkspaceInfo[] = [];

  @property({ type: String })
  currentWorkspaceId = '';

  private _emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  private _onSelect(workspaceId: string): void {
    this._emit('workspace-selected', { workspaceId });
  }

  private _onCreate(): void {
    this._emit('workspace-create');
  }

  private _onRename(e: Event, workspaceId: string): void {
    e.stopPropagation();
    const name = window.prompt('Workspace name (blank to clear):')?.trim() ?? '';
    this._emit('workspace-rename', { workspaceId, name });
  }

  private _onClose(e: Event, workspaceId: string): void {
    e.stopPropagation();
    this._emit('workspace-close', { workspaceId });
  }

  private _onOverlayClick(): void {
    this._emit('close-picker');
  }

  render() {
    return html`
      <div class="overlay" @click="${this._onOverlayClick}">
        <div class="picker" @click="${(e: Event) => e.stopPropagation()}">
          <h2>Workspaces</h2>
          <div class="ws-list">
            ${this.workspaces.map(
              (w) => html`
                <button
                  class="ws-item ${w.workspaceId === this.currentWorkspaceId ? 'sel' : ''}"
                  @click="${() => this._onSelect(w.workspaceId)}"
                >
                  <span class="ck">
                    ${w.workspaceId === this.currentWorkspaceId ? icon(Check, { size: 12 }) : ''}
                  </span>
                  <span class="ws-name">${workspaceLabel(w)}</span>
                  <span class="ws-meta">${w.paneCount} ${w.paneCount === 1 ? 'pane' : 'panes'}</span>
                  <button class="row-action ws-rename" @click="${(e: Event) => this._onRename(e, w.workspaceId)}">
                    ${icon(Pencil, { size: 13 })}
                  </button>
                  <button class="row-action ws-close" @click="${(e: Event) => this._onClose(e, w.workspaceId)}">
                    ${icon(X, { size: 13 })}
                  </button>
                </button>
              `,
            )}
          </div>
          <button class="ws-new" @click="${this._onCreate}">
            ${icon(Plus, { size: 14 })}
            <span>New workspace</span>
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-workspace-picker': MuxWorkspacePicker;
  }
}
```

> Verify `Pencil` and `X` are exported by the installed `lucide` version before relying on them: `cd web && node -e "const l=require('lucide'); console.log(!!l.Pencil, !!l.X)"`. If either is missing, substitute any present glyph (e.g. `Edit`, `Trash`) and adjust the import — the test only checks the button classes, not the glyph.

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/workspace-picker.test.ts`
Expected: PASS (12 passing).

**Step 5: Commit**

```
cd web && git add src/components/workspace-picker.ts src/__tests__/workspace-picker.test.ts && git commit -m "$(cat <<'EOF'
feat(web): add mux-workspace-picker component

Driven by frozen SessiondWorkspaceInfo[]; switch/create/rename/close. Labels
as name ?? "Workspace <workspaceId>". Row events carry {workspaceId} to match
the wire field. Repurposes the old session-picker (Phase 4).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 9: Workspace switch prunes the terminal registry

**Files:**
- Modify: `web/src/lib/terminal-registry.ts`
- Test: `web/src/__tests__/terminal-registry.workspace.test.ts` (create)

Panes are keyed by `paneId` (workspace-local `localPaneId`) **within the attached workspace**. Since exactly one workspace is attached at a time and `paneId`s are reused across workspaces, switching workspaces must dispose the previous workspace's terminals so ids don't collide. The registry already has `prune(liveIds)`; add a thin, intention-revealing `disposeAll()` for the detach-on-switch path.

**Step 1: Write the failing test**

Create `web/src/__tests__/terminal-registry.workspace.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { terminalRegistry } from '../lib/terminal-registry.js';

const noopHandlers = { onInput: () => {}, onResize: () => {} };

describe('terminalRegistry — workspace switch keying', () => {
  beforeEach(() => {
    terminalRegistry.disposeAll();
  });

  it('disposeAll() removes every terminal so localPaneIds can be reused', () => {
    terminalRegistry.ensure(1, noopHandlers);
    terminalRegistry.ensure(2, noopHandlers);
    expect(terminalRegistry.getTerminal(1)).not.toBeNull();

    terminalRegistry.disposeAll();

    expect(terminalRegistry.getTerminal(1)).toBeNull();
    expect(terminalRegistry.getTerminal(2)).toBeNull();
  });

  it('after switch+disposeAll, re-ensuring paneId 1 yields a fresh terminal', () => {
    terminalRegistry.ensure(1, noopHandlers);
    const first = terminalRegistry.getTerminal(1);
    terminalRegistry.disposeAll(); // simulate workspace switch
    terminalRegistry.ensure(1, noopHandlers); // new workspace reuses localPaneId 1
    const second = terminalRegistry.getTerminal(1);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first); // distinct instance — no cross-workspace bleed
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/terminal-registry.workspace.test.ts`
Expected: FAIL — `terminalRegistry.disposeAll is not a function`.

**Step 3: Write minimal implementation**

In `web/src/lib/terminal-registry.ts`, add a `disposeAll` method to the `terminalRegistry` object (e.g. just after `prune`, ~line 299). Match the field names the registry actually uses for each entry — verify against the existing `prune`/`detach` implementation and adjust the cleanup lines if the internal entry shape differs:

```ts
  /**
   * Dispose ALL terminals — used when switching the attached workspace.
   * localPaneIds are unique only within a workspace, so on switch we must
   * drop the previous workspace's terminals to prevent id collisions.
   */
  disposeAll(): void {
    for (const [paneId, entry] of _map.entries()) {
      entry.resizeObserver?.disconnect();
      if (entry.resizeTimer !== undefined) clearTimeout(entry.resizeTimer);
      entry.term.dispose();
      _map.delete(paneId);
    }
    _preEnsureBuffer.clear();
  },
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/terminal-registry.workspace.test.ts`
Expected: PASS (2 passing).

**Step 5: Commit**

```
cd web && git add src/lib/terminal-registry.ts src/__tests__/terminal-registry.workspace.test.ts && git commit -m "$(cat <<'EOF'
feat(web): add terminalRegistry.disposeAll for workspace switch

localPaneIds are workspace-local; switching workspaces must dispose the prior
workspace's terminals so reused ids don't collide (Phase 4).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 10: Workspace MRU tracker

**Files:**
- Create: `web/src/lib/workspace-mru.ts`
- Test: `web/src/__tests__/workspace-mru.test.ts`

`chooseRecoveryTarget` (Task 7) needs a most-recently-active ordering of workspace ids. This tiny pure tracker records attach order so the controller (Task 11) can feed it into recovery.

**Step 1: Write the failing test**

Create `web/src/__tests__/workspace-mru.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WorkspaceMru } from '../lib/workspace-mru.js';

describe('WorkspaceMru', () => {
  it('lists most-recently-touched first', () => {
    const mru = new WorkspaceMru();
    mru.touch('a');
    mru.touch('b');
    mru.touch('c');
    expect(mru.order()).toEqual(['c', 'b', 'a']);
  });

  it('re-touching moves an id to the front without duplicating', () => {
    const mru = new WorkspaceMru();
    mru.touch('a');
    mru.touch('b');
    mru.touch('a');
    expect(mru.order()).toEqual(['a', 'b']);
  });

  it('forget() removes a closed workspace from the order', () => {
    const mru = new WorkspaceMru();
    mru.touch('a');
    mru.touch('b');
    mru.forget('a');
    expect(mru.order()).toEqual(['b']);
  });

  it('starts empty', () => {
    expect(new WorkspaceMru().order()).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/workspace-mru.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/workspace-mru.js"`.

**Step 3: Write minimal implementation**

Create `web/src/lib/workspace-mru.ts`:

```ts
/**
 * workspace-mru — client-local most-recently-active ordering of workspace ids.
 * Feeds chooseRecoveryTarget so workspace-closed recovery attaches to the most
 * recently used surviving workspace (design §"Workspace lifecycle").
 */
export class WorkspaceMru {
  private _order: string[] = [];

  /** Mark a workspace as most-recently-active (call on attach/switch). */
  touch(id: string): void {
    this._order = [id, ...this._order.filter((x) => x !== id)];
  }

  /** Drop a workspace (call on workspace-closed). */
  forget(id: string): void {
    this._order = this._order.filter((x) => x !== id);
  }

  /** Most-recently-active first. */
  order(): string[] {
    return [...this._order];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/workspace-mru.test.ts`
Expected: PASS (4 passing).

**Step 5: Commit**

```
cd web && git add src/lib/workspace-mru.ts src/__tests__/workspace-mru.test.ts && git commit -m "$(cat <<'EOF'
feat(web): add WorkspaceMru tracker for recovery ordering

Client-local most-recently-active workspace order, fed into
chooseRecoveryTarget on workspace-closed recovery (Phase 4).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 11: WorkspaceController — bootstrap, MRU, recovery via frozen messages

**Files:**
- Create: `web/src/lib/workspace-controller.ts`
- Test: `web/src/__tests__/workspace-controller.test.ts` (create)

The thin coordination seam that turns frozen `SessiondMessage` events + UI intents into socket actions and arrangement decisions (design §"Connection & delivery model" + §"Workspace lifecycle"). It keys recovery off the **exact frozen messages**: the attach reply is `composition`, the no-survivor path is the `workspace-created` reply, and a stale id is an `error` with `code:"unknown-workspace"` — all imported from `./types`, never hardcoded.

**Step 1: Write the failing test**

Create `web/src/__tests__/workspace-controller.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MuxStore } from '../state.js';
import { WorkspaceController } from '../lib/workspace-controller.js';

interface FakeSocket {
  attach: ReturnType<typeof vi.fn>;
  createWorkspace: ReturnType<typeof vi.fn>;
  listWorkspaces: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
}

function fakeSocket(): FakeSocket {
  return {
    attach: vi.fn(),
    createWorkspace: vi.fn(),
    listWorkspaces: vi.fn(),
    resize: vi.fn(),
  };
}

describe('WorkspaceController', () => {
  let store: MuxStore;
  let socket: FakeSocket;
  let ctl: WorkspaceController;

  beforeEach(() => {
    localStorage.clear();
    store = new MuxStore();
    socket = fakeSocket();
    ctl = new WorkspaceController(store, socket as never);
  });

  it('bootstrap with no stored id lists then attaches the first workspace', () => {
    ctl.bootstrap();
    expect(socket.listWorkspaces).toHaveBeenCalledTimes(1);
    // server replies with the list:
    const msg = { type: 'workspace-list', workspaces: [{ workspaceId: 'ws-1', paneCount: 1 }] } as const;
    store.applySessiond(msg);
    ctl.onMessage(msg);
    expect(socket.attach).toHaveBeenCalledWith('ws-1');
  });

  it('bootstrap with a stored id attaches it directly', () => {
    localStorage.setItem('muxterm.lastWorkspaceId', 'ws-saved');
    ctl.bootstrap();
    expect(socket.attach).toHaveBeenCalledWith('ws-saved');
  });

  it('records MRU + persists last workspace on the composition reply', () => {
    const msg = { type: 'composition', workspaceId: 'ws-1', panes: [{ paneId: 1, cols: 80, rows: 24 }] } as const;
    store.applySessiond(msg);
    ctl.onMessage(msg);
    expect(localStorage.getItem('muxterm.lastWorkspaceId')).toBe('ws-1');
  });

  it('on workspace-closed of the attached workspace, recovers to an MRU survivor', () => {
    ctl.onMessage({ type: 'composition', workspaceId: 'ws-1', panes: [{ paneId: 1, cols: 80, rows: 24 }] });
    ctl.onMessage({ type: 'composition', workspaceId: 'ws-2', panes: [{ paneId: 1, cols: 80, rows: 24 }] });
    store.applySessiond({ type: 'composition', workspaceId: 'ws-2', panes: [{ paneId: 1, cols: 80, rows: 24 }] });
    // ws-2 closes; list says ws-1 survives
    store.applySessiond({ type: 'workspace-closed', workspaceId: 'ws-2' });
    ctl.onMessage({ type: 'workspace-closed', workspaceId: 'ws-2' });
    const list = { type: 'workspace-list', workspaces: [{ workspaceId: 'ws-1', paneCount: 1 }] } as const;
    store.applySessiond(list);
    ctl.onMessage(list);
    expect(socket.attach).toHaveBeenLastCalledWith('ws-1');
  });

  it('on workspace-closed with no survivors, requests a fresh workspace', () => {
    ctl.onMessage({ type: 'composition', workspaceId: 'ws-1', panes: [{ paneId: 1, cols: 80, rows: 24 }] });
    store.applySessiond({ type: 'composition', workspaceId: 'ws-1', panes: [{ paneId: 1, cols: 80, rows: 24 }] });
    store.applySessiond({ type: 'workspace-closed', workspaceId: 'ws-1' });
    ctl.onMessage({ type: 'workspace-closed', workspaceId: 'ws-1' });
    const list = { type: 'workspace-list', workspaces: [] } as const;
    store.applySessiond(list);
    ctl.onMessage(list);
    expect(socket.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it('attaches the freshly-created workspace on the workspace-created reply', () => {
    ctl.onMessage({ type: 'workspace-created', workspaceId: 'ws-new' });
    expect(socket.attach).toHaveBeenCalledWith('ws-new');
  });

  it('on an unknown-workspace error, clears the stale stored id and recovers via list', () => {
    localStorage.setItem('muxterm.lastWorkspaceId', 'ws-stale');
    ctl.onMessage({ type: 'error', code: 'unknown-workspace', error: 'no such workspace', workspaceId: 'ws-stale' });
    expect(localStorage.getItem('muxterm.lastWorkspaceId')).toBeNull();
    expect(socket.listWorkspaces).toHaveBeenCalled();
  });

  it('ignores non-recovery errors (e.g. pane-spawn-failed)', () => {
    ctl.onMessage({ type: 'error', code: 'pane-spawn-failed', error: 'boom' });
    expect(socket.listWorkspaces).not.toHaveBeenCalled();
    expect(socket.attach).not.toHaveBeenCalled();
  });

  it('computes the arrangement for the current viewport width', () => {
    const msg = { type: 'composition', workspaceId: 'ws-1', panes: [{ paneId: 1, cols: 80, rows: 24 }, { paneId: 2, cols: 80, rows: 24 }] } as const;
    store.applySessiond(msg);
    ctl.onMessage(msg);
    const wide = ctl.currentArrangement(1280);
    expect(wide.mode).toBe('tiling');
    expect(wide.visible).toEqual([1, 2]);
    const narrow = ctl.currentArrangement(400);
    expect(narrow.mode).toBe('tabbed');
    expect(narrow.visible.length).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/workspace-controller.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/workspace-controller.js"`.

**Step 3: Write minimal implementation**

Create `web/src/lib/workspace-controller.ts`:

```ts
/**
 * workspace-controller — the thin coordination seam that turns frozen
 * SessiondMessage events + UI intents into socket actions and arrangement
 * decisions. Extracted from app.ts so the multi-client lifecycle is
 * unit-testable (design §"Connection & delivery model" + §"Workspace lifecycle").
 *
 * It keys off the FROZEN message vocabulary (Phase 0): the attach reply is
 * `composition`; an unknown/stale id is an `error` with code `unknown-workspace`;
 * the no-survivor recovery path attaches the `workspace-created` reply.
 */

import type { MuxStore } from '../state.js';
import { SessiondType, SessiondErrorCode, type SessiondMessage } from '../types';
import { arrange, viewportClassFor, type Arrangement } from './layout.js';
import { ArrangementStore } from './arrangement-store.js';
import { WorkspaceMru } from './workspace-mru.js';
import { chooseRecoveryTarget } from './workspace-recovery.js';

const LAST_WS_KEY = 'muxterm.lastWorkspaceId';

/** The subset of MuxSocket this controller drives (keeps it test-mockable). */
export interface WorkspaceSocket {
  attach(workspaceId: string): void;
  createWorkspace(name?: string): void;
  listWorkspaces(): void;
  resize(paneId: number, cols: number, rows: number): void;
}

export class WorkspaceController {
  private _store: MuxStore;
  private _socket: WorkspaceSocket;
  private _mru = new WorkspaceMru();
  private _arrangements = new ArrangementStore();
  /** Set while a workspace-closed/unknown-workspace recovery awaits the list reply. */
  private _recoveringFrom: string | null = null;

  constructor(store: MuxStore, socket: WorkspaceSocket) {
    this._store = store;
    this._socket = socket;
  }

  /** First-connect bootstrap: attach the stored id, else list + attach default. */
  bootstrap(): void {
    const stored = localStorage.getItem(LAST_WS_KEY);
    if (stored) {
      this._socket.attach(stored);
    } else {
      this._socket.listWorkspaces();
      this._recoveringFrom = ''; // attach first listed workspace when the list arrives
    }
  }

  /** Feed every inbound SessiondMessage here (in addition to store.applySessiond). */
  onMessage(msg: SessiondMessage): void {
    switch (msg.type) {
      case SessiondType.Composition: {
        const id = msg.workspaceId ?? '';
        this._mru.touch(id);
        localStorage.setItem(LAST_WS_KEY, id);
        break;
      }

      case SessiondType.WorkspaceClosed: {
        const id = msg.workspaceId ?? '';
        this._mru.forget(id);
        // Only recover if WE were on the closed workspace (or are detached).
        if (this._store.attached === id || this._store.attached === null) {
          this._recoveringFrom = id;
          this._socket.listWorkspaces();
        }
        break;
      }

      case SessiondType.Error:
        // Typed recovery: a stale/unknown workspace id. Drop it and re-list.
        if (msg.code === SessiondErrorCode.UnknownWorkspace) {
          const stale = msg.workspaceId ?? '';
          if (localStorage.getItem(LAST_WS_KEY) === stale) {
            localStorage.removeItem(LAST_WS_KEY);
          }
          this._recoveringFrom = stale;
          this._socket.listWorkspaces();
        }
        break;

      case SessiondType.WorkspaceList:
        if (this._recoveringFrom !== null) {
          const target = chooseRecoveryTarget(
            msg.workspaces ?? [],
            this._recoveringFrom,
            this._mru.order(),
          );
          this._recoveringFrom = null;
          if (target.action === 'attach') this._socket.attach(target.workspaceId);
          else this._socket.createWorkspace();
        }
        break;

      case SessiondType.WorkspaceCreated:
        // Daemon allocated a fresh id (reply to create-workspace) — attach to it.
        this._socket.attach(msg.workspaceId ?? '');
        break;
    }
  }

  /** Forward a measured xterm.js grid to the PTY (active-view-wins). */
  reportResize(paneId: number, cols: number, rows: number): void {
    this._socket.resize(paneId, cols, rows);
  }

  /** The arrangement to render for the current attached composition + viewport. */
  currentArrangement(viewportWidthPx: number): Arrangement {
    const profile = viewportClassFor(viewportWidthPx);
    const wsId = this._store.attached;
    if (!wsId) return arrange(this._store.composition, profile);
    return this._arrangements.load(wsId, profile, this._store.composition);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/workspace-controller.test.ts`
Expected: PASS (9 passing).

**Step 5: Commit**

```
cd web && git add src/lib/workspace-controller.ts src/__tests__/workspace-controller.test.ts && git commit -m "$(cat <<'EOF'
feat(web): add WorkspaceController keyed off frozen wire messages

Bootstrap (stored-id attach / list+attach default), MRU + last-workspace
persistence on composition, recovery on workspace-closed and error
{code:unknown-workspace}, attach on workspace-created, arrangement selection.
All keyed off SessiondType/SessiondErrorCode — no hardcoded strings (Phase 4).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 12: Integrate picker + layout + recovery into the app shell

**Files:**
- Modify: `web/src/app.ts`
- Modify: `web/src/ws.ts` (already has `onSessiondMessage` from Task 5)
- Delete: `web/src/components/session-picker.ts`
- Delete: `web/src/__tests__/session-picker.test.ts`

Wires the pieces together: on connect, `listWorkspaces()` then `attach(stored/default)` via `WorkspaceController.bootstrap()`; render the composition through `arrange()` for the measured viewport class; route `terminalRegistry.onResize → controller.reportResize → socket.resize`; route `terminalRegistry.onInput → socket.sendPaneInput`; mount `mux-workspace-picker` and handle its events; on `workspace-closed` / `error{unknown-workspace}`, run recovery; on workspace switch, `disposeAll()` + `attach()`.

> The **coordination logic** is already unit-tested in `workspace-controller.test.ts`. This task only wires the tested seams into the shell, so it relies on `npm test` + `npm run build` (tsc) to catch wiring/type errors rather than adding a new shell unit test. Keep the `app.ts` edits surgical and additive.

**Step 1: Wire `onSessiondMessage` into the app**

In `web/src/app.ts`, make these surgical edits:

1. Replace the picker import and add the controller import (near the existing component imports, ~line 20):
   ```ts
   // delete: import './components/session-picker.js';
   import './components/workspace-picker.js';
   import { WorkspaceController } from './lib/workspace-controller.js';
   ```

2. Construct the controller where the socket + store are created, and feed every inbound frozen message to **both** the store and the controller. Assign the new hook added to `MuxSocket` in Task 5:
   ```ts
   this._controller = new WorkspaceController(store, this._socket);
   this._socket.onSessiondMessage = (msg) => {
     store.applySessiond(msg);
     this._controller.onMessage(msg);
   };
   ```
   Call `this._controller.bootstrap()` from the socket's `onReconnect`/open path (where the old code requested the initial sync).

3. Route input + resize when creating terminals — wherever the app calls `terminalRegistry.ensure(paneId, handlers)`:
   ```ts
   terminalRegistry.ensure(paneId, {
     onInput: (bytes) => this._socket?.sendPaneInput(paneId, bytes),
     onResize: (cols, rows) => this._controller.reportResize(paneId, cols, rows),
   });
   ```
   (Only panes that are actually rendered/visible per the current `arrange()` get a live terminal + `ResizeObserver`, so active-view-wins holds by construction.)

4. Render the workspace picker in place of the session picker:
   ```ts
   ${this._showWorkspacePicker
     ? html`<mux-workspace-picker
         .workspaces="${store.workspaces}"
         .currentWorkspaceId="${store.attached ?? ''}"
         @workspace-selected="${this._onWorkspaceSelected}"
         @workspace-create="${() => this._socket?.createWorkspace()}"
         @workspace-rename="${(e: CustomEvent<{ workspaceId: string; name: string }>) => this._socket?.renameWorkspace(e.detail.workspaceId, e.detail.name)}"
         @workspace-close="${(e: CustomEvent<{ workspaceId: string }>) => this._socket?.closeWorkspace(e.detail.workspaceId)}"
         @close-picker="${() => { this._showWorkspacePicker = false; }}"
       ></mux-workspace-picker>`
     : ''}
   ```
   with `_onWorkspaceSelected` performing the switch (note the daemon's `composition` reply re-populates the store; we just need to dispose the old terminals and request the attach):
   ```ts
   private _onWorkspaceSelected = (e: CustomEvent<{ workspaceId: string }>): void => {
     this._showWorkspacePicker = false;
     if (e.detail.workspaceId === store.attached) return;
     terminalRegistry.disposeAll();   // drop the previous workspace's terminals
     this._socket?.attach(e.detail.workspaceId);
   };
   ```

5. Add a `create-pane` intent wherever the app previously created a tmux window/pane (the "new pane" button/shortcut), now connection-scoped:
   ```ts
   this._socket?.createPane();   // argv omitted ⇒ daemon default $SHELL
   ```

**Step 2: Delete the obsolete session picker + its test**

```
cd web && git rm src/components/session-picker.ts src/__tests__/session-picker.test.ts
```

Then fix any remaining references:
```
cd web && grep -rn "session-picker\|MuxSessionPicker\|_showSessionPicker\|_onSessionSelected\|_onOpenSessionPicker" src
```
Rename `_showSessionPicker → _showWorkspacePicker` and repoint the open handler to set `_showWorkspacePicker = true`. The status bar's `@open-session-picker` event may keep its name or be renamed to `@open-workspace-picker`; if renamed, update `web/src/components/status-bar.ts` and its test accordingly (keep it minimal — wiring the handler to `_showWorkspacePicker = true` is what matters).

**Step 3: Run the full suite + type-check**

Run: `cd web && npm test`
Expected: PASS — all test files green, including the eight new Phase-4 files (`layout`, `arrangement-store`, `ws.sessiond`, `state.workspace`, `workspace-recovery`, `workspace-picker`, `terminal-registry.workspace`, `workspace-mru`, `workspace-controller`). The deleted `session-picker.test.ts` is gone.

Run: `cd web && npm run build`
Expected: `tsc --noEmit` reports no type errors, vite build succeeds.

**Step 4: Commit**

```
cd web && git add -A && git commit -m "$(cat <<'EOF'
feat(web): wire browser multiplexer into the app shell

Constructs WorkspaceController; feeds onSessiondMessage to store.applySessiond
+ controller.onMessage; bootstraps attach on connect; routes terminalRegistry
input→sendPaneInput and resize→controller.reportResize; replaces the session
picker with the workspace picker; disposes terminals on switch. Speaks only
the frozen Phase-0 vocabulary. Completes Phase 4 (browser-as-multiplexer).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Final verification

Run the full frontend suite and build one more time to confirm Phase 4 is green end-to-end:

```
cd web && npm test && npm run build
```

Expected:
- `vitest run` — all files pass, including the new Phase-4 test files:
  `layout.test.ts`, `arrangement-store.test.ts`, `ws.sessiond.test.ts`, `state.workspace.test.ts`, `workspace-recovery.test.ts`, `workspace-picker.test.ts`, `terminal-registry.workspace.test.ts`, `workspace-mru.test.ts`, `workspace-controller.test.ts`.
- `npm run build` — `tsc --noEmit` clean, vite build succeeds.

### What Phase 4 delivered (traceable to the design)

| Design requirement | Where |
| --- | --- |
| Browser speaks the **frozen flat `Message` vocabulary** (no single-key envelope); types owned by Phase 0 | `ws.ts` senders + `onSessiondMessage` (Tasks 4–5), importing `SessiondType`/`SessiondMessage`/`encodePaneFrame`/`decodePaneFrame` |
| Responsive arrangement = pure fn of (composition, viewport class) | `lib/layout.ts` (Tasks 1–2) |
| Splits degrade to tabs on narrow; medium = fewer splits | `arrange()` `MAX_VISIBLE` (Task 2) |
| Arrangement persisted per (workspaceId, viewport); stable-id key survives rename | `lib/arrangement-store.ts` (Task 3) |
| `attach{workspaceId}` → `composition{workspaceId, panes:PaneInfo[]}`; build arrangement from `composition.panes` | `ws.ts` `attach` (Task 4) + `state.ts` `applySessiond` (Task 6) |
| Composition state; `pane-added{paneId,cols,rows,title}` idempotent dedup by paneId; `pane-closed{paneId}` | `state.ts` `applySessiond` (Task 6) |
| `workspace-closed{workspaceId}` → recover (MRU survivor / `create-workspace`); ignore trailing `pane-closed` | `state.ts` clears attachment (Task 6) + `workspace-recovery.ts` + `workspace-mru.ts` + `workspace-controller.ts` (Tasks 7, 10, 11) |
| Typed `error{code:"unknown-workspace"}` recovery + `workspace-created{workspaceId}` no-survivor path | `workspace-controller.ts` keyed off `SessiondErrorCode`/`SessiondType` (Task 11) |
| `workspace-renamed{workspaceId,name}` updates label; `name ?? fallback` | `state.ts` + `workspace-picker.ts` (Tasks 6, 8) |
| `workspace-list{workspaces:WorkspaceInfo[]}` → picker + recovery | `state.ts` (Task 6) + `workspace-picker.ts` (Task 8) + controller (Task 11) |
| Workspace picker (switch/create/rename/close, one attached at a time) | `components/workspace-picker.ts` (Task 8) |
| Keyboard `input` as binary `encodePaneFrame(paneId, bytes)`; `resize{paneId,cols,rows}` from rendered frame; active-view-wins | `ws.ts` `sendPaneInput`/`resize` (Task 4) + registry `onResize` wiring (Task 12) |
| `create-pane{cmd?}` connection-scoped (argv, no workspaceId) | `ws.ts` `createPane` (Task 4) + app shell (Task 12) |
| Panes keyed by localPaneId within attached workspace; switch disposes prior | `terminal-registry.disposeAll` (Task 9) |
| Binary pane framing `[4-byte LE paneId][bytes]` shared with Go/Phase 0 | `decodePaneFrame`/`encodePaneFrame` from `types.ts` (Tasks 4–5) |

### Out of scope (do NOT implement here)

- Any Go / `sessiond` / `serve` changes (Phases 0–3).
- Redefining or extending the wire-protocol types (owned by Phase 0).
- Buffer fidelity / `TrackedBuffer` / `VTBuffer` (Phase 5).
- Wire-framing or auth changes.
- Daemon-side arrangement memory / cross-device layout portability (explicitly deferred in the design).
- The deferred `workspace-created` **broadcast** for live cross-client picker updates (design Open Questions); this phase only consumes the `workspace-created` **reply** to its own `create-workspace`.
