# Sidebar Resize-Drag: Split.js Replacement Implementation Plan

> **For execution:** Use `/build-like-ken` mode.

**Goal:** Replace muxterm's hand-rolled sidebar resize-drag (`web/src/components/mux-sidebar.ts`) with Split.js, preserving exact external behavior (220/160/360px default/min/max, `mux-sidebar-width` localStorage key/semantics).

**Architecture:** A Split.js instance lives in `app.ts` (not `mux-sidebar.ts`), tied to four Lit lifecycle hooks (`connectedCallback`, `disconnectedCallback`, `willUpdate`, `updated`) that already exist in `app.ts` today. `mux-sidebar.ts` becomes a pure content component with no resize logic. A new `lib/sidebar-width.ts` module holds the relocated persistence constants/functions. A `ResizeObserver` on `.content-area` keeps the sidebar pixel-fixed across window resizes, compensating for Split's percentage-based rendering.

**Tech Stack:** TypeScript, Lit 3 web components, Split.js v1.6.5 (new dependency), Vite, npm.

**Verification approach:** Static analysis (`npm run check:fast`, `go build ./...`) first, then real end-to-end verification via `playwright-cli` against the isolated `make dev-local` instance (127.0.0.1:8313) — 9 distinct scenarios per `docs/designs/2026-08-01-sidebar-resize-splitjs-design.md`'s Testing/Verification Strategy section. No unit tests (banned by this repo's `AGENTS.md`).

---

## Before you start

This plan assumes you are working in the `fix/sidebar-resize-lib` git worktree at the repo root. All paths below are relative to that root unless stated otherwise (e.g. `web/...`).

Read the design document once before starting, to have the full rationale in mind: `docs/designs/2026-08-01-sidebar-resize-splitjs-design.md`. This plan implements it exactly — it does not redesign anything.

**Codebase reality you need to know before touching `app.ts`:** `app.ts` already has `connectedCallback()`, `disconnectedCallback()`, `willUpdate()`, and `updated()` overrides with real, substantial existing logic (WebSocket wiring, terminal sync, modal autofocus, etc). Task 3 below **splices** new code into these existing methods — it does NOT add new `override` declarations (that would be a duplicate-method compile error). The existing `willUpdate`/`updated` signatures are typed `Map<PropertyKey, unknown>` (not `PropertyValues` — there is no such import in this file, and you must not add one). Match this exactly.

---

### Task 1: Add `split.js` dependency

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json`

**Implementation**

From the `web/` directory, run:

```bash
cd web && npm install split.js
```

This adds `split.js` to `dependencies` in `package.json` and updates `package-lock.json`. Do not hand-edit either file — let `npm install` do it.

**Static Analysis**

```bash
cd web && npm run check:fast
```
Expected: no errors (this task doesn't touch any `.ts` source, so this just confirms the install didn't break anything pre-existing).

**Verification**

```bash
cd web && npm ls split.js
```
Expected output: a line showing `split.js@<version>` resolved under `muxterm-web@0.0.1`, with no `UNMET DEPENDENCY` or `invalid` warnings, e.g.:
```
muxterm-web@0.0.1 /path/to/web
└── split.js@1.6.5
```

```bash
grep '"split.js"' web/package.json
```
Expected: one line showing `split.js` under `dependencies`.

**Commit**

```bash
git add web/package.json web/package-lock.json
git commit -m "chore(web): add split.js dependency

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: Create `web/src/lib/sidebar-width.ts`

**Files:**
- Create: `web/src/lib/sidebar-width.ts`

**Implementation**

This relocates the four width constants and the validation/clamp/try-catch logic currently inline in `mux-sidebar.ts`'s `connectedCallback()` (restore path) and `_onResizeStart()` (persist path) into two standalone, pure functions. No behavior change — same parseInt/NaN-check/range-check/fallback-to-default logic, same try/catch-and-no-op-on-error semantics.

Create `web/src/lib/sidebar-width.ts` with exactly this content:

```typescript
// ---------------------------------------------------------------------------
// Sidebar width persistence — relocated from mux-sidebar.ts so app.ts's
// Split.js wiring can share it. Same validation/clamp/try-catch logic as the
// original mux-sidebar.ts connectedCallback (restore) and _onResizeStart
// (persist) blocks — just made into standalone, independently-callable pure
// functions. See docs/designs/2026-08-01-sidebar-resize-splitjs-design.md.
// ---------------------------------------------------------------------------

export const SIDEBAR_WIDTH_KEY = 'mux-sidebar-width';
export const SIDEBAR_DEFAULT_WIDTH = 220;
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 360;

/**
 * Reads the persisted sidebar width from localStorage, validating and
 * clamping it to [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]. Falls back to
 * SIDEBAR_DEFAULT_WIDTH on a missing key, an unparseable value, an
 * out-of-range value, or any localStorage access error (private browsing,
 * quota, disabled storage).
 */
export function restoreSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored !== null) {
      const parsed = parseInt(stored, 10);
      if (!Number.isNaN(parsed) && parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH) {
        return parsed;
      }
    }
  } catch {
    // Ignore localStorage errors — fall through to default.
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

/**
 * Persists the sidebar width to localStorage. Silently no-ops on any
 * localStorage access error (private browsing, quota, disabled storage) —
 * losing a persistence write is not a user-visible failure.
 */
export function persistSidebarWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(px));
  } catch {
    // Ignore localStorage errors.
  }
}
```

**Static Analysis**

```bash
cd web && npm run check:fast
```
Expected: no errors.

**Verification**

This is pure, trivial logic with no independent runtime harness — `AGENTS.md` bans unit tests, including "just for the pure logic." Real behavioral verification happens end-to-end in Task 3, once this module is wired into the live UI via `app.ts` and exercised by `playwright-cli`. As a lightweight static sanity check only (not a substitute for Task 3's real verification), confirm the module has no syntax errors and exports the expected names:

```bash
cd web && node -e "
const ts = require('child_process').execSync('npx esbuild src/lib/sidebar-width.ts --bundle --format=esm --outfile=/tmp/sidebar-width-check.mjs', { cwd: process.cwd() });
console.log('bundled ok');
"
node -e "
import('/tmp/sidebar-width-check.mjs').then(m => {
  console.log('restoreSidebarWidth' in m, 'persistSidebarWidth' in m, m.SIDEBAR_DEFAULT_WIDTH === 220, m.SIDEBAR_MIN_WIDTH === 160, m.SIDEBAR_MAX_WIDTH === 360);
});
"
```
Expected: `bundled ok` printed, then `true true true true true`. (This just confirms the file is syntactically valid and exports what Task 3 will import — `localStorage` itself only exists in a real browser, which is why the actual behavior is proven end-to-end in Task 3, not here.)

**Commit**

```bash
git add web/src/lib/sidebar-width.ts
git commit -m "feat(web): add sidebar-width helper module

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: Core swap — wire Split.js into `app.ts`, strip the old mechanism from `mux-sidebar.ts`

This is the one meaty task in this plan. `app.ts` and `mux-sidebar.ts` are only valid as a matched pair after this change — an intermediate state with one file changed and not the other is genuinely broken (e.g. `mux-sidebar.ts` would still export the constants `app.ts` no longer imports from it, or `app.ts` would reference a gutter that doesn't visually exist yet). **Do all edits below, then run static analysis, then run all 9 real-browser verification scenarios, then make exactly one commit.**

**Files:**
- Modify: `web/src/app.ts`
- Modify: `web/src/components/mux-sidebar.ts`

#### 3a. `app.ts` — add imports and module-level helpers

**Old** (in the import block, the last two `lib/*` imports before the `_nextTempPaneId` comment):
```typescript
import { currentLayoutMode } from './lib/breakpoint.js';
import { muxLog, muxLogReset } from './lib/mux-log.js';

// Optimistic panes use a strictly-negative temp paneId so they never collide
```

**New:**
```typescript
import { currentLayoutMode } from './lib/breakpoint.js';
import { muxLog, muxLogReset } from './lib/mux-log.js';
import Split from 'split.js';
import type { Instance as SplitInstance } from 'split.js';
import {
  restoreSidebarWidth,
  persistSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from './lib/sidebar-width.js';

/** Split.js gutter size (px), used both as the `gutterSize` option passed to
 *  `Split(...)` in `_initSplit()` below and as the half-gutter compensation
 *  in `widthPxToSplitPercent()` — defined once so the two can never drift
 *  out of sync if the gutter size is ever changed. */
const SIDEBAR_GUTTER_SIZE = 4;

/** Converts a target sidebar pixel width into the percentage Split.js needs,
 *  compensating for its default renderer's half-gutter subtraction so the
 *  actual rendered width equals `targetPx`. Split's default
 *  `calc(size% - gutSize px)` renderer always subtracts a half-gutter share
 *  (`gutterSize / 2`) from whatever percentage-derived width it computes;
 *  without this compensation an unadjusted percentage renders
 *  `targetPx - gutterSize / 2`, not `targetPx` (e.g. a 220px target
 *  rendering as 218px). Used by both `_initSplit()`'s initial `sizes`
 *  computation and the `ResizeObserver` callback's `setSizes()`
 *  recalculation — NOT by `onDragEnd`, which reads the actual rendered
 *  `getBoundingClientRect().width` directly and needs no conversion. */
function widthPxToSplitPercent(targetPx: number, containerWidth: number, gutterSize: number): number {
  return ((targetPx + gutterSize / 2) / containerWidth) * 100;
}

// Optimistic panes use a strictly-negative temp paneId so they never collide
```

Verified: `import Split from 'split.js'; import type { Instance as SplitInstance } from 'split.js';` typechecks cleanly with this project's actual `npm run typecheck:fast` (confirmed directly, not assumed — `split.js`'s `index.d.ts` uses `export = Split` with a merged namespace, and this project's `tsconfig.json` moduleResolution `bundler` + `@typescript/native-preview` accepts the default-import form without needing `esModuleInterop` added).

#### 3b. `app.ts` — add `.sidebar-gutter` CSS

**Old** (end of the `static styles = css\`...\`` block):
```css
    .main-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }
  `;
```

**New:**
```css
    .main-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }

    /* Split.js gutter — styled to visually match the removed
       mux-sidebar.ts .resize-handle (4px, transparent, col-resize cursor,
       hover highlight). Unlike the old absolutely-positioned overlay, this
       is a real flex-row sibling occupying its own layout width. */
    .sidebar-gutter {
      width: 4px;
      cursor: col-resize;
      background: transparent;
      transition: background 0.15s;
    }

    .sidebar-gutter:hover {
      background: var(--chrome-accent);
      opacity: 0.4;
    }
  `;
```

#### 3c. `app.ts` — add private fields

**Old** (immediately after `_disposePaneFocusListeners`, before the `_onOpenLauncherAttr` comment):
```typescript
  private _disposePaneFocusListeners: (() => void) | null = null;

  /** Bound handler: sets data-launcher-open on the host (light DOM) so E2E
   *  selectors like document.querySelector('[data-launcher-open]') work. */
```

**New:**
```typescript
  private _disposePaneFocusListeners: (() => void) | null = null;

  /** Split.js instance managing the sidebar/main-pane resize boundary,
   *  owned here (not mux-sidebar.ts) since Split.js needs both sibling DOM
   *  elements at once — see
   *  docs/designs/2026-08-01-sidebar-resize-splitjs-design.md. */
  private _split: SplitInstance | null = null;
  /** Observes .content-area so the sidebar can be kept pixel-fixed across
   *  window resizes despite Split's percentage-based rendering. */
  private _resizeObserver: ResizeObserver | null = null;
  /** The fixed pixel width the sidebar should render at; updated only in
   *  onDragEnd, otherwise held constant across container resizes. */
  private _sidebarWidthPx = SIDEBAR_DEFAULT_WIDTH;
  /** True while a Split.js drag gesture is in progress; consulted by the
   *  ResizeObserver callback (skip recompute mid-drag) and by
   *  _destroySplit() (force a synthetic mouseup before teardown). */
  private _dragging = false;

  /** Bound handler: sets data-launcher-open on the host (light DOM) so E2E
   *  selectors like document.querySelector('[data-launcher-open]') work. */
```

#### 3d. `app.ts` — add `_initSplit()` / `_destroySplit()` methods

**Old** (end of `_syncTerminals()`, right before `render()`):
```typescript
    for (const id of toDelete) this._closingPanes.delete(id);
  }

  render() {
```

**New:**
```typescript
    for (const id of toDelete) this._closingPanes.delete(id);
  }

  private _initSplit(): void {
    const sidebarEl = this.renderRoot.querySelector<HTMLElement>('mux-sidebar');
    const mainPaneEl = this.renderRoot.querySelector<HTMLElement>('.main-pane');
    const contentAreaEl = this.renderRoot.querySelector<HTMLElement>('.content-area');
    if (!sidebarEl || !mainPaneEl || !contentAreaEl || this._split) return;

    this._sidebarWidthPx = restoreSidebarWidth();
    const pct = widthPxToSplitPercent(this._sidebarWidthPx, contentAreaEl.clientWidth, SIDEBAR_GUTTER_SIZE);

    this._split = Split([sidebarEl, mainPaneEl], {
      // Percentage sizes, Split's own default calc() renderer — no custom
      // elementStyle (see design doc's Architecture section for why the
      // prior custom pixel-based renderer was removed).
      sizes: [pct, 100 - pct],
      minSize: [SIDEBAR_MIN_WIDTH, 0],       // main-pane keeps today's "no enforced minimum"
      maxSize: [SIDEBAR_MAX_WIDTH, Infinity],
      gutterSize: SIDEBAR_GUTTER_SIZE,        // matches removed .resize-handle width
      gutter: () => {
        const g = document.createElement('div');
        g.className = 'sidebar-gutter'; // styled above to match old .resize-handle
        return g;
      },
      onDragStart: () => {
        this._dragging = true;
      },
      onDragEnd: () => {
        this._dragging = false;
        this._sidebarWidthPx = sidebarEl.getBoundingClientRect().width;
        persistSidebarWidth(this._sidebarWidthPx);
      },
    });

    // Keep the sidebar's literal pixel width fixed across container resizes
    // — Split's percentage sizing is otherwise proportionally responsive to
    // .content-area's width, which today's implementation is not. Matches
    // today's exact fixed-until-next-drag behavior. Skipped mid-drag so it
    // doesn't fight the user's in-progress gesture.
    this._resizeObserver = new ResizeObserver(() => {
      if (!this._split || this._dragging) return;
      const newPct = widthPxToSplitPercent(this._sidebarWidthPx, contentAreaEl.clientWidth, SIDEBAR_GUTTER_SIZE);
      this._split.setSizes([newPct, 100 - newPct]);
    });
    this._resizeObserver.observe(contentAreaEl);
  }

  private _destroySplit(): void {
    if (this._dragging) {
      // Split.destroy() is not a drag-cancellation API — it does not remove
      // the global mousemove/mouseup/touchmove/touchend listeners
      // startDragging attached to `window`, nor reset the
      // user-select/pointer-events inline styles or document.body.style.cursor
      // it set (those are separate from the width styles destroy() does
      // reset). Force Split's own stopDragging cleanup to run first by
      // dispatching a synthetic mouseup.
      window.dispatchEvent(new MouseEvent('mouseup'));
    }
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._split?.destroy();
    this._split = null;
  }

  render() {
```

Verified: this exact combination (renderRoot.querySelector, Split.js Options object, ResizeObserver, class-field types) typechecks cleanly against this project's real `npm run typecheck:fast` — confirmed with a standalone reproduction before writing this plan, not assumed.

#### 3e. `app.ts` — splice into `connectedCallback()`

**Old** (end of the existing method body):
```typescript
    this._socket.connect();
    this._connectionStatus = 'reconnecting';
    this._pollConnectionStatus();
  }

  disconnectedCallback(): void {
```

**New:**
```typescript
    this._socket.connect();
    this._connectionStatus = 'reconnecting';
    this._pollConnectionStatus();

    // Reconnect-while-already-wide: if <mux-app> disconnects and reconnects
    // while _layoutMode was already 'wide' throughout, no _layoutMode change
    // fires to trigger the updated() init path below, but
    // disconnectedCallback() has already nulled _split. Re-init here covers
    // that gap.
    if (this._layoutMode === 'wide' && !this._split) {
      this._initSplit();
    }
  }

  disconnectedCallback(): void {
```

#### 3f. `app.ts` — splice into `disconnectedCallback()`

**Old** (end of the existing method body):
```typescript
    for (const entry of this._pendingWorkspaceCloses.values()) clearTimeout(entry.timer);
    this._pendingWorkspaceCloses.clear();
  }
```

**New:**
```typescript
    for (const entry of this._pendingWorkspaceCloses.values()) clearTimeout(entry.timer);
    this._pendingWorkspaceCloses.clear();
    this._destroySplit();
  }
```

#### 3g. `app.ts` — splice into `willUpdate()`

**Old:**
```typescript
  override willUpdate(_changedProperties: Map<PropertyKey, unknown>): void {
    super.willUpdate(_changedProperties);
    this._syncTerminals();
  }
```

**New:** (note the param is renamed from `_changedProperties` to `changedProperties` — it was underscore-prefixed because it was unused before; it's used now, so the underscore prefix must be dropped to stay consistent with the no-unused-vars convention this file otherwise follows)
```typescript
  override willUpdate(changedProperties: Map<PropertyKey, unknown>): void {
    super.willUpdate(changedProperties);
    this._syncTerminals();
    // Wide→narrow: destroy Split.js BEFORE Lit removes <mux-sidebar> from the
    // DOM (willUpdate fires pre-render) — see
    // docs/designs/2026-08-01-sidebar-resize-splitjs-design.md Architecture.
    if (changedProperties.has('_layoutMode') && this._layoutMode === 'narrow' && this._split) {
      this._destroySplit();
    }
  }
```

#### 3h. `app.ts` — splice into `updated()`

**Old:**
```typescript
  override updated(changed: Map<PropertyKey, unknown>): void {
    super.updated(changed);
    // Auto-focus the name input when the create modal opens.
    if (changed.has('_showCreateModal') && this._showCreateModal) {
      requestAnimationFrame(() => {
        this.shadowRoot?.querySelector<HTMLInputElement>('.ws-create-input')?.focus();
      });
    }
  }
```

**New:**
```typescript
  override updated(changed: Map<PropertyKey, unknown>): void {
    super.updated(changed);
    // Auto-focus the name input when the create modal opens.
    if (changed.has('_showCreateModal') && this._showCreateModal) {
      requestAnimationFrame(() => {
        this.shadowRoot?.querySelector<HTMLInputElement>('.ws-create-input')?.focus();
      });
    }
    // Narrow→wide: init Split.js AFTER Lit has placed the sidebar/main-pane
    // elements back in the DOM (updated fires post-render) — see
    // docs/designs/2026-08-01-sidebar-resize-splitjs-design.md Architecture.
    if (changed.has('_layoutMode') && this._layoutMode === 'wide' && !this._split) {
      this._initSplit();
    }
  }
```

#### 3i. `app.ts` — no import cleanup needed

Check: does `import type { MuxSidebar } from './components/mux-sidebar.js';` (near the top of the file) become unused after this change? **No** — `_sidebar` getter (`private get _sidebar(): MuxSidebar | null`) and `_onUndoPaneClose`'s `this._sidebar?.restoreWorkspace(entry.wsId)` call both still use it; `restoreWorkspace` is not removed by this plan. Leave this import as-is. (Confirmed by reading the current file — do not remove it.)

#### 3j. `mux-sidebar.ts` — import the relocated constants for CSS

**Old** (top imports):
```typescript
import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { workspaceLabel } from './workspace-picker.js';
import './launcher-menu.js';
import { icon } from '../lib/icons.js';
import { Ellipsis } from 'lucide';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SIDEBAR_WIDTH_KEY = 'mux-sidebar-width';
export const SIDEBAR_DEFAULT_WIDTH = 220;
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 360;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
```

**New:** (constants now imported from `lib/sidebar-width.ts` instead of declared/exported here — only `SIDEBAR_MIN_WIDTH`/`SIDEBAR_MAX_WIDTH` are still needed locally, for the `:host` CSS min/max-width backstop)
```typescript
import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { workspaceLabel } from './workspace-picker.js';
import './launcher-menu.js';
import { icon } from '../lib/icons.js';
import { Ellipsis } from 'lucide';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../lib/sidebar-width.js';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
```

#### 3k. `mux-sidebar.ts` — drop hardcoded `width: 220px`, keep min/max as backstop

**Old:**
```css
    :host {
      display: flex;
      flex-direction: column;
      background: var(--chrome-bar);
      border-right: 1px solid var(--chrome-border);
      width: 220px;
      min-width: ${unsafeCSS(String(SIDEBAR_MIN_WIDTH))}px;
      max-width: ${unsafeCSS(String(SIDEBAR_MAX_WIDTH))}px;
      height: 100%;
```

**New:**
```css
    :host {
      display: flex;
      flex-direction: column;
      background: var(--chrome-bar);
      border-right: 1px solid var(--chrome-border);
      min-width: ${unsafeCSS(String(SIDEBAR_MIN_WIDTH))}px;
      max-width: ${unsafeCSS(String(SIDEBAR_MAX_WIDTH))}px;
      height: 100%;
```

#### 3l. `mux-sidebar.ts` — remove `.resize-handle` CSS

**Old** (end of the `static styles = css\`...\`` block):
```css
    .new-ws-btn:hover {
      border-color: var(--chrome-accent);
      background: var(--chrome-hover);
    }

    /* ---- drag resize handle ---- */

    .resize-handle {
      position: absolute;
      top: 0;
      right: 0;
      width: 4px;
      height: 100%;
      cursor: col-resize;
      background: transparent;
      z-index: 10;
      transition: background 0.15s;
    }

    .resize-handle:hover {
      background: var(--chrome-accent);
      opacity: 0.4;
    }
  `;
```

**New:**
```css
    .new-ws-btn:hover {
      border-color: var(--chrome-accent);
      background: var(--chrome-hover);
    }
  `;
```

#### 3m. `mux-sidebar.ts` — remove width-restore block from `connectedCallback()`

**Old:**
```typescript
  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('mousedown', this._onOutsideClick);

    // Subscribe to store changes and trigger re-render by bumping _version.
    this._unsub = store.subscribe(() => {
      this._version++;
    });

    // Restore persisted sidebar width from localStorage (clamp to [min, max]).
    try {
      const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (stored !== null) {
        const parsed = parseInt(stored, 10);
        if (!Number.isNaN(parsed) && parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH) {
          this.style.width = `${parsed}px`;
        } else {
          this.style.width = `${SIDEBAR_DEFAULT_WIDTH}px`;
        }
      } else {
        this.style.width = `${SIDEBAR_DEFAULT_WIDTH}px`;
      }
    } catch {
      this.style.width = `${SIDEBAR_DEFAULT_WIDTH}px`;
    }

  }
```

**New:**
```typescript
  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('mousedown', this._onOutsideClick);

    // Subscribe to store changes and trigger re-render by bumping _version.
    this._unsub = store.subscribe(() => {
      this._version++;
    });
  }
```

#### 3n. `mux-sidebar.ts` — remove `_onResizeStart()` method

**Old:**
```typescript
  // ---------------------------------------------------------------------------
  // Drag-to-resize
  // ---------------------------------------------------------------------------

  private _onResizeStart(e: PointerEvent): void {
    const startX = e.clientX;
    const startW = this.offsetWidth;

    const onMove = (me: PointerEvent): void => {
      const delta = me.clientX - startX;
      const newW = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, startW + delta),
      );
      this.style.width = `${newW}px`;
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(newW));
      } catch {
        // Ignore localStorage errors.
      }
    };

    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
```

**New:**
```typescript
  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
```

#### 3o. `mux-sidebar.ts` — remove `.resize-handle` markup from `render()`

**Old** (end of `render()`'s returned template):
```typescript
      <div class="tab-content">
        ${this._renderWorkspaces()}
      </div>
      <div
        class="resize-handle"
        @pointerdown="${(e: PointerEvent) => this._onResizeStart(e)}"
      ></div>
    `;
  }
```

**New:**
```typescript
      <div class="tab-content">
        ${this._renderWorkspaces()}
      </div>
    `;
  }
```

---

**Static Analysis** (run first — fast and free, must be zero errors before any browser verification)

```bash
cd web && npm run check:fast
```
Expected: `0 errors` (oxlint + tsgo). If anything fails, fix it before proceeding — do not attempt browser verification against code that doesn't typecheck/lint clean.

```bash
go build ./...
```
(from repo root) Expected: exits 0, no output. This is a frontend-only change and is unlikely to be affected, but `AGENTS.md` requires this check before every commit regardless.

**Real-Browser Verification**

Follow `AGENTS.md`'s verification hygiene exactly:
1. Check for stale `sessiond` processes from other worktrees before trusting any result: `ps aux | grep sessiond` — confirm any running binary path matches *this* worktree (`fix/sidebar-resize-lib` / `sidebar-resize-lib`), not a different one.
2. Kill any existing `make dev-local` for this worktree and restart it fresh (wiped `XDG_RUNTIME_DIR`) before the clean verification pass — do not trust results against a long-lived, heavily-poked instance.
3. Use a brand-new workspace (and therefore a brand-new pane) for the verification session below. Do not reuse a pane across the 9 scenarios.
4. Never touch, kill, or restart port 8311 (production) or its sessiond/socket/log files. Only the isolated 127.0.0.1:8313 instance from `make dev-local`.
5. Do not edit source files while `make dev-local`'s watch loop is mid-test — finish each scenario, then edit if a fix is needed, then re-verify with a fresh workspace.

**Start the isolated dev instance:**

```bash
# from repo root
pkill -f "muxterm-dev-local" 2>/dev/null; sleep 1  # clear any stale instance for THIS worktree only
make dev-local
```
Expected console output includes:
```
muxterm-dev   http://127.0.0.1:8313  (air hot-reload)
production    127.0.0.1:8311 -- untouched
```

Wait for the build to settle (watch `tmp/dev-local-vite.out` and the air output for "build succeeded" / server listening), then proceed.

**Scenario 1 — Multi-step drag resizes smoothly:**
```bash
playwright-cli open http://127.0.0.1:8313
playwright-cli snapshot
```
Create a fresh workspace via the UI (new-workspace button) so this scenario runs against a pane no prior scenario has touched. Then:
```bash
playwright-cli mousemove <gutter-x> <gutter-y>
playwright-cli mousedown
playwright-cli mousemove <gutter-x+40> <gutter-y>
playwright-cli mousemove <gutter-x+80> <gutter-y>
playwright-cli mousemove <gutter-x+120> <gutter-y>
playwright-cli mouseup
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Expected: sidebar width tracks the pointer smoothly across the intermediate `mousemove` steps (observable via repeated `eval` calls mid-drag showing intermediate widths increasing monotonically), and the final width after `mouseup` reflects the full `+120px` delta (clamped if it exceeds 360).

**Scenario 2 — Clamp at min (160px) and max (360px):**
```bash
playwright-cli mousedown
playwright-cli mousemove <gutter-x-500> <gutter-y>   # drag far past min
playwright-cli mouseup
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Expected: exactly `160`, not less.
```bash
playwright-cli mousedown
playwright-cli mousemove <gutter-x+500> <gutter-y>   # drag far past max
playwright-cli mouseup
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Expected: exactly `360`, not more.

**Scenario 3 — Persistence across reload:**
```bash
playwright-cli mousedown
playwright-cli mousemove <gutter-x+30> <gutter-y>
playwright-cli mouseup
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
playwright-cli --raw localstorage-get mux-sidebar-width
playwright-cli reload
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Expected: the width after reload exactly matches the width recorded before reload, and matches the persisted `localStorage` value.

**Scenario 4 — No text selection elsewhere during drag:**
```bash
playwright-cli mousedown
playwright-cli mousemove <gutter-x+50> <gutter-y>
playwright-cli eval "window.getSelection().toString()"
playwright-cli mouseup
```
Expected: `getSelection().toString()` returns an empty string during the drag (confirming `user-select:none` is active on both panes), even after moving the pointer across pane content.

**Scenario 5 — Cursor stays `col-resize` even when pointer strays off the gutter:**
```bash
playwright-cli mousedown
playwright-cli mousemove <gutter-x+200> <gutter-y+100>   # well off the 4px gutter
playwright-cli eval "document.body.style.cursor"
playwright-cli mouseup
playwright-cli eval "document.body.style.cursor"
```
Expected: `col-resize` while dragging (even off-gutter), and reset to `''`/default after `mouseup`.

**Scenario 6 — Narrow/wide breakpoint transition:**
```bash
playwright-cli resize 600 800
playwright-cli snapshot
```
Expected: snapshot shows no `<mux-sidebar>` and no gutter element present.
```bash
playwright-cli resize 1200 800
playwright-cli snapshot
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Expected: sidebar and gutter reappear, width matches the last-persisted value from Scenario 3/5, and a fresh drag on the gutter still resizes it (repeat a short drag to confirm).

**Scenario 7 — Lit-diffing stress test (mandatory):**
```bash
# Rapidly create and close several panes via the UI while at wide viewport
playwright-cli click <new-pane-button>
playwright-cli click <new-pane-button>
playwright-cli click <new-pane-button>
playwright-cli click <close-tab-button>
playwright-cli click <close-tab-button>
playwright-cli snapshot
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelectorAll('.sidebar-gutter').length"
```
Expected: `1` (exactly one gutter div — not duplicated, not missing).
```bash
playwright-cli mousedown
playwright-cli mousemove <gutter-x+25> <gutter-y>
playwright-cli mouseup
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Expected: drag still resizes correctly and the new width is reflected.

**Scenario 8 — Drag-cancelled-by-teardown (mandatory):**
```bash
playwright-cli mousedown
playwright-cli mousemove <gutter-x+40> <gutter-y>   # mid-drag, do NOT release yet
playwright-cli resize 600 800                        # trigger wide→narrow mid-drag
playwright-cli eval "document.body.style.cursor"
playwright-cli eval "window.getSelection().toString()"
playwright-cli snapshot
```
Expected: cursor is reset to default (not stuck at `col-resize`), selection is empty/normal, and the snapshot shows a clean narrow layout with no leaked sidebar/gutter.
```bash
playwright-cli resize 1200 800
playwright-cli snapshot
playwright-cli mousedown
playwright-cli mousemove <gutter-x+20> <gutter-y>
playwright-cli mouseup
```
Expected: resizing back to wide re-initializes cleanly — fresh gutter present, draggable, no console errors (check with `playwright-cli console`).

**Scenario 9 — Fixed-pixel-width under window resize (mandatory, exact values):**

*Default (220px):*
```bash
# Fresh workspace/pane with no persisted value (use localstorage-clear first)
playwright-cli --raw localstorage-clear
playwright-cli reload
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Expected: exactly `220` (not `218`).
```bash
playwright-cli resize 1400 800
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
playwright-cli resize 900 800
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Expected: `220` in both cases (unchanged by window resize).

*Arbitrary dragged value:*
```bash
playwright-cli mousedown
playwright-cli mousemove <gutter-x+37> <gutter-y>
playwright-cli mouseup
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Record this exact value (call it `V`), then:
```bash
playwright-cli resize 1400 800
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
playwright-cli resize 900 800
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Expected: both reads exactly equal `V`.

*Max bound (360px):*
```bash
playwright-cli mousedown
playwright-cli mousemove <gutter-x+500> <gutter-y>   # drag past max
playwright-cli mouseup
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Expected: exactly `360` (not `358`).
```bash
playwright-cli resize 1400 800
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
playwright-cli resize 900 800
playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-sidebar').getBoundingClientRect().width"
```
Expected: `360` in both cases.

**Close the browser and dev-local instance when done:**
```bash
playwright-cli close
```

Report each scenario's actual observed command output as evidence — not "looks right," the literal numeric/string values returned by each `eval`/`snapshot`/`console` call.

**Commit** (one commit for the whole matched-pair swap)

```bash
git add web/src/app.ts web/src/components/mux-sidebar.ts
git commit -m "feat(web): replace hand-rolled sidebar resize with Split.js

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Done criteria

All 3 tasks committed, `npm run check:fast` and `go build ./...` clean, and all 9 real-browser scenarios in Task 3 observed and reported with actual command output — not asserted from reasoning alone. This closes out `docs/designs/2026-08-01-sidebar-resize-splitjs-design.md` end to end.
