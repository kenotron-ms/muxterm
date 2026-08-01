# Sidebar Resize-Drag: Split.js Replacement Design

## Goal

Replace muxterm's hand-rolled sidebar resize-drag implementation (`web/src/components/mux-sidebar.ts`) with Split.js, a battle-tested open-source library, instead of continuing to patch the custom implementation bug-by-bug. This is a "swap internal implementation, preserve external behavior" change — same default/min/max width values (220/160/360px), same localStorage key/semantics (`mux-sidebar-width`), no new features.

## Background / Current Bugs (verified against current source)

`web/src/components/mux-sidebar.ts` lines ~470-495 (`_onResizeStart`) and ~13-16 (constants):

- `SIDEBAR_WIDTH_KEY = 'mux-sidebar-width'`, `SIDEBAR_DEFAULT_WIDTH = 220`, `SIDEBAR_MIN_WIDTH = 160`, `SIDEBAR_MAX_WIDTH = 360` (all px)
- A 4px `.resize-handle` div at the sidebar's right edge, `@pointerdown` attaches `pointermove`/`pointerup` on `document`, clamps width, writes `this.style.width` directly, calls `localStorage.setItem` on every pointermove tick
- Confirmed bugs: no `setPointerCapture`, no `user-select:none` toggle, no cursor lock on `document.body`, no rAF throttling, no `pointercancel` handling
- Constants are exported but used nowhere else in the codebase (grep-confirmed) — full freedom on internal representation
- No existing `--sidebar-width` CSS custom property; nothing else depends on the width value
- `app.ts` (lines ~690-710): `<mux-sidebar>` and `<div class="main-pane">` are plain flex siblings inside `.content-area` (flex-row), gated by `isWide` from `lib/breakpoint.ts` (768px threshold, confirmed structurally — narrow mode never renders `<mux-sidebar>` at all)
- `mux-dock.ts` already wires `dockview-core`'s `DockviewComponent` for the terminal-pane area via a custom `IContentRenderer` adapter class — this is the established pattern in-repo for handing DOM ownership to an imperative library within a Lit app

## Approaches Considered

**Approach A — dockview-core's `SplitviewComponent`/`createSplitview`** (reuse already-installed dependency): Real, verified option (confirmed via dockview.dev/docs/api/splitview — has `minimumSize`/`maximumSize`, `addPanel`, `layout(w,h)`). Rejected because: integrating it requires restructuring `app.ts`'s render tree to hand DOM ownership to an imperative panel-adapter class (same ceremony as `mux-dock.ts`'s `TerminalRenderer`), and its exact behavior against the pinned `dockview-core@^6.6.1` version couldn't be verified without installing and spiking first — more ceremony and more unverified risk than this narrow fix justifies.

**Approach B — Split.js (`split.js` npm package, chosen)**: Verified via actual source inspection (fetched `nathancahill/split` master source directly, not just reputation) against every specific bug in scope:

- ✅ `user-select:none` set on both pane elements at drag-start, restored at drag-end (confirmed in `startDragging`/`stopDragging`)
- ✅ Cursor lock set on gutter + parent + `document.body` at drag-start, all three reset at drag-end (confirmed)
- ✅ `touchcancel`/`touchend` handling as the touch-equivalent safety net (Split.js uses mouse+touch events, not Pointer Events, so no literal `pointercancel` — this is the correct analog)
- ✅ `minSize`/`maxSize` options clamp in real pixel values during drag (confirmed by reading the `drag()` function's clamp math, not just assumed from percentage-based `sizes`)
- ⚠️ No internal rAF throttling — writes styles synchronously per native `mousemove`, same cadence as current code. Assessed as a non-issue for this workload (simple 2-pane flex-basis writes; browsers coalesce style writes to paint frames regardless; this is standard behavior across virtually all popular split-pane libraries, not a regression)
- Package facts (from npm's package.json, fetched directly): `split.js` v1.6.5, "2kb unopinionated utility for resizeable split views", MIT license, ships ESM (`dist/split.es.js`) + CJS, includes TypeScript types (`index.d.ts`)
- New dependency, but minimal integration cost: operates directly on existing DOM element references, no render-tree restructuring, no panel-adapter class needed — roughly 50-80 lines of wiring total

**Approach C — split-grid / interact.js**: Considered per brief, correctly deprioritized (split-grid is CSS-Grid-based, doesn't fit the existing flexbox layout; interact.js is a general-purpose drag/gesture toolkit with more setup overhead than a single 2-pane split needs).

## Decided Behavior: localStorage Write Frequency

User explicitly chose write-once-on-drag-end (not throttled continuous writes during drag): "there's no real scenario where losing an in-progress drag's intermediate value matters." Split.js's `onDragEnd(sizes)` callback fires exactly once per completed drag gesture, matching this decision natively.

## Architecture & Ownership Boundary

Split.js instance lives in `app.ts`, NOT `mux-sidebar.ts` — Split.js needs both sibling DOM elements (`<mux-sidebar>`, `.main-pane`) at once to pair them; only `app.ts`'s render root has both. `mux-sidebar.ts` becomes a pure content component: no `.resize-handle` div, no `_onResizeStart`, no width-restore logic in `connectedCallback` — sizing is imposed on it from outside, same as `.main-pane` already is.

**Lifecycle, tied to the existing `isWide` breakpoint boundary** (same place `<mux-sidebar>` already mounts/unmounts), split across two Lit lifecycle hooks so destroy and init each run on the correct side of Lit's render:

- wide → narrow: handled in `willUpdate(changedProps)`, which fires BEFORE Lit applies the DOM change. If `_layoutMode` is changing to `'narrow'` and `this._split` exists, call `_destroySplit()` here — this guarantees the gutter div and inline styles are cleaned up by our own code before Lit's render removes `<mux-sidebar>` from the DOM. (This replaces an earlier, incorrect plan to destroy from `updated()`, which fires after render and left the destroy-before-remove guarantee unenforced.)
- narrow → wide: handled in `updated(changedProps)`, which fires AFTER Lit applies the DOM change. If `_layoutMode` is now `'wide'` and `this._split` is null, call `_initSplit()` here, since the sidebar/main-pane elements only exist in the DOM once this hook runs.
- Reconnect-while-already-wide (new): the `updated()` path above only fires when `_layoutMode` *changes* to `'wide'`. If `<mux-app>` itself is disconnected and reconnected while `_layoutMode` was already `'wide'` throughout (no change ever detected), `disconnectedCallback()` has nulled `_split` but nothing re-triggers `_initSplit()`. `connectedCallback()` therefore also calls `_initSplit()`, guarded by `if (this._layoutMode === 'wide' && !this._split)`, so reconnection re-initializes correctly regardless of whether a layout-mode change accompanies it.
- A single `_split: ReturnType<typeof Split> | null` instance field on `app.ts` holds the current instance, alongside `_dragging: boolean` (set true/false by `onDragStart`/`onDragEnd`) and `_sidebarWidthPx: number` (the fixed-pixel width used by the `ResizeObserver` recalculation described below, updated only in `onDragEnd`).
- Defensively, `app.ts`'s `disconnectedCallback()` should also call `_destroySplit()`, in case the app element itself is removed from the DOM while a Split instance is active (e.g., mid-drag) — cleanup should not rely solely on the `willUpdate` breakpoint-transition path.
- **Drag-in-progress-safe teardown (new)**: `Split.destroy()` is not a drag-cancellation API — it does not remove the global `mousemove`/`mouseup`/`touchmove`/`touchend` listeners Split's `startDragging` attaches to `window` during an active drag, nor does it reset the `user-select`/`pointer-events` inline styles or `document.body.style.cursor` that `startDragging` set (those are separate from the width styles `destroy()` does reset). If `_destroySplit()` is called mid-drag (e.g. a breakpoint transition fires while the user is actively dragging), this would leak global listeners pointing at soon-to-be-detached elements and leave the cursor/selection state stuck. `_destroySplit()` therefore checks `this._dragging` (tracked via the `onDragStart`/`onDragEnd` callbacks) and, if a drag is active, force-dispatches a synthetic `window` `mouseup` event first — this runs Split's own `stopDragging` cleanup (cursor/user-select/pointer-events restore + its global listener removal) before `destroy()` is called.

**Constants relocate** from `mux-sidebar.ts` to a new shared module `web/src/lib/sidebar-width.ts`: `SIDEBAR_WIDTH_KEY`, `SIDEBAR_DEFAULT_WIDTH`, `SIDEBAR_MIN_WIDTH`, `SIDEBAR_MAX_WIDTH`, plus two pure helper functions `restoreSidebarWidth(): number` and `persistSidebarWidth(px: number): void` (same validation/clamp/try-catch logic as today's `connectedCallback` block, just relocated and made independently testable/callable). `mux-sidebar.ts`'s CSS keeps `min-width`/`max-width` as a defensive floor/ceiling backstop but drops the hardcoded `width: 220px` default — initial size now comes from Split's `sizes` init option.

**Default percentage sizing, not a custom `elementStyle` (revised)**: The prior revision's custom `pxElementStyle` — seeding raw pixel `sizes` and bypassing Split's default `calc(size% - gutSize px)` renderer — was itself buggy, verified by tracing Split's actual source math. Split's internal drag-clamp math adds a half-gutter offset (2px, for `gutterSize=4`/center-align) into the clamped `offset` value at the min/max boundary, on the assumption that the rendering function will subtract it back out (exactly what the default `calc()` formula does); the custom function ignored `gutSize` and rendered `size` directly, making the true rendered minimum 162px, not 160px. Separately, Split's `destroy()` calls `elementStyle(dimension, pair.a.size, pair[aGutterSize])` with only three arguments — no index — so the custom function's `if (i === 0)` branch silently failed (`undefined !== 0`), meaning `destroy()` never reset the sidebar's inline width, leaving stale styles after teardown.

`_initSplit()` therefore does not pass an `elementStyle` option to `Split(...)` at all, letting it use its default percentage-based `calc()` renderer for both panes (index 0 and 1) — Split's own proven, tested, internally-consistent math. This remains correct and sufficient for accurate `minSize`/`maxSize` pixel clamping: Split's clamp math always compares real pixel offsets from `getBoundingClientRect`, regardless of whether `sizes`/rendering uses percentages — the 2px discrepancy in the prior revision existed only because the custom override broke the library's own internal cancellation, not because percentage-based sizing is imprecise.

**Consequence handled — sidebar must stay pixel-fixed across container resize**: using default percentage sizing makes the sidebar proportionally responsive to `.content-area` width changes (Split.js has no internal `ResizeObserver` of its own — sizes are only recalculated at the start of an explicit drag, but percentages still scale visually whenever the flex container's own width changes). This is not today's behavior, where the sidebar stays a hard fixed pixel width until the next drag. To reproduce that exactly, `app.ts` adds its own `ResizeObserver` on `.content-area` that recomputes the sidebar's fixed pixel width as a percentage and calls `this._split.setSizes([pct, 100 - pct])` whenever the container resizes (skipped while a drag is active, via `this._dragging`). The percentage is derived from `this._sidebarWidthPx`, a stored field updated only in `onDragEnd` and initialized from `restoreSidebarWidth()`. This achieves the fixed-pixel-width guarantee using Split's own supported public `setSizes()` API, rather than fighting its internal unit conventions with a custom renderer.

**Acknowledged trade-off — gutter is a real layout sibling**: Split.js's gutter model inserts a real DOM element between the two panes, occupying its own ~4px of flex-row space, unlike today's absolutely-positioned overlay `.resize-handle` (which consumed zero extra layout width, living inside the sidebar's own box). Adopting Split.js therefore makes `.main-pane`'s available width ~4px narrower than before. This is an inherent, minor, acknowledged, non-blocking consequence of the chosen library's mechanism — not a defect requiring a workaround — in the same honest-callout spirit as the "no rAF throttling" note under Approach B above.

**Resolved risk — Lit-diffing vs. Split.js's externally-inserted gutter div**: Split.js inserts its own `.gutter` div directly via `parent.insertBefore()`, outside Lit's template tracking. Because `app.ts`'s `isWide` conditional is the ONLY expression-level change point for `.content-area`'s children, and Split.js is destroyed/recreated exactly at that same boundary, there's no window where the externally-inserted gutter div coexists with a Lit re-render that could touch `.content-area`'s top-level child list. This resolves the risk by construction (architectural boundary alignment), not by runtime luck — but per user's explicit instruction, it MUST still be empirically verified with a dedicated stress test (see Testing Strategy) rather than accepted on reasoning alone.

## Components

**`app.ts` (modified):**

```typescript
import Split from 'split.js';
import type { Instance as SplitInstance } from 'split.js';
import {
  restoreSidebarWidth,
  persistSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from './lib/sidebar-width.js';

private _split: SplitInstance | null = null;
private _resizeObserver: ResizeObserver | null = null;
private _sidebarWidthPx = SIDEBAR_DEFAULT_WIDTH;
private _dragging = false;

private _initSplit(): void {
  const sidebarEl = this.renderRoot.querySelector<HTMLElement>('mux-sidebar');
  const mainPaneEl = this.renderRoot.querySelector<HTMLElement>('.main-pane');
  const contentAreaEl = this.renderRoot.querySelector<HTMLElement>('.content-area');
  if (!sidebarEl || !mainPaneEl || !contentAreaEl || this._split) return;

  this._sidebarWidthPx = restoreSidebarWidth();
  const pct = (this._sidebarWidthPx / contentAreaEl.clientWidth) * 100;

  this._split = Split([sidebarEl, mainPaneEl], {
    // Percentage sizes, Split's own default calc() renderer -- no custom
    // elementStyle (see Architecture section for why the prior custom
    // pixel-based renderer was removed).
    sizes: [pct, 100 - pct],
    minSize: [SIDEBAR_MIN_WIDTH, 0],       // main-pane keeps today's "no enforced minimum"
    maxSize: [SIDEBAR_MAX_WIDTH, Infinity],
    gutterSize: 4,                          // matches existing .resize-handle width
    gutter: () => {
      const g = document.createElement('div');
      g.className = 'sidebar-gutter'; // styled in app.ts CSS to visually match old .resize-handle (hover highlight, col-resize cursor)
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

  // Keep the sidebar's literal pixel width fixed across container resizes --
  // Split's percentage sizing is otherwise proportionally responsive to
  // `.content-area`'s width, which today's implementation is not. Matches
  // today's exact fixed-until-next-drag behavior. Skipped mid-drag so it
  // doesn't fight the user's in-progress gesture.
  this._resizeObserver = new ResizeObserver(() => {
    if (!this._split || this._dragging) return;
    const newPct = (this._sidebarWidthPx / contentAreaEl.clientWidth) * 100;
    this._split.setSizes([newPct, 100 - newPct]);
  });
  this._resizeObserver.observe(contentAreaEl);
}

private _destroySplit(): void {
  if (this._dragging) {
    // Split.destroy() is not a drag-cancellation API -- it does not remove
    // the global mousemove/mouseup/touchmove/touchend listeners startDragging
    // attached to `window`, nor reset the user-select/pointer-events inline
    // styles or document.body.style.cursor it set (those are separate from
    // the width styles destroy() does reset). Force Split's own stopDragging
    // cleanup to run first by dispatching a synthetic mouseup.
    window.dispatchEvent(new MouseEvent('mouseup'));
  }
  this._resizeObserver?.disconnect();
  this._resizeObserver = null;
  this._split?.destroy();
  this._split = null;
}

override connectedCallback(): void {
  super.connectedCallback();
  // Reconnect-while-already-wide: if <mux-app> is disconnected and
  // reconnected while _layoutMode was already 'wide' throughout, no
  // _layoutMode change fires to trigger the updated() path below, but
  // disconnectedCallback() has already nulled _split. Re-init here covers
  // that gap.
  if (this._layoutMode === 'wide' && !this._split) {
    this._initSplit();
  }
}

override willUpdate(changedProps: PropertyValues): void {
  super.willUpdate(changedProps);
  if (changedProps.has('_layoutMode') && this._layoutMode === 'narrow' && this._split) {
    this._destroySplit();
  }
}

override updated(changedProps: PropertyValues): void {
  super.updated(changedProps);
  if (changedProps.has('_layoutMode') && this._layoutMode === 'wide' && !this._split) {
    this._initSplit();
  }
}

override disconnectedCallback(): void {
  super.disconnectedCallback();
  this._destroySplit();
}
```

Wired via three Lit lifecycle hooks: `_layoutMode` changing to `'narrow'` → `_destroySplit()` in `willUpdate` (before Lit removes `<mux-sidebar>`); `_layoutMode` changing to `'wide'` → `_initSplit()` in `updated` (after Lit has placed the sidebar/main-pane elements in the DOM); `connectedCallback()` → `_initSplit()` guarded by `_layoutMode === 'wide' && !this._split`, covering reconnection while already wide (no layout-mode change to key off). `disconnectedCallback()` also calls `_destroySplit()` defensively, which itself forces a synthetic `mouseup` first if `_dragging` is true (see Architecture section).

**`web/src/lib/sidebar-width.ts` (new):** `SIDEBAR_WIDTH_KEY`, `SIDEBAR_DEFAULT_WIDTH`, `SIDEBAR_MIN_WIDTH`, `SIDEBAR_MAX_WIDTH` constants; `restoreSidebarWidth(): number` (reads/validates/clamps localStorage, try/catch, falls back to default on any failure — identical logic to today's `connectedCallback` block); `persistSidebarWidth(px: number): void` (try/catch `localStorage.setItem`, silent no-op on failure).

**`mux-sidebar.ts` (modified):** Remove `_onResizeStart`, `.resize-handle` template markup and CSS, width-restore block in `connectedCallback`, and the four width constant exports (moved to `lib/sidebar-width.ts`). Keep `min-width`/`max-width` CSS rules as defensive backstop; remove hardcoded `width: 220px`.

**`web/package.json` (modified):** Add `split.js` as a real npm dependency (`npm install split.js`, updating `package.json` and `package-lock.json` properly — not a vendored copy).

## Data Flow

**Init/restore** (page load, narrow→wide transition, or reconnect-while-already-wide): `restoreSidebarWidth()` reads localStorage, validates range `[160,360]`, falls back to `220` on missing/invalid/error — identical validation to today. `_initSplit()` stores this value in `this._sidebarWidthPx`, converts it to a percentage of `contentAreaEl.clientWidth`, and passes `[pct, 100 - pct]` as Split's `sizes` init option — Split's default percentage/`calc()` renderer applies initial styles synchronously on construction, no flash of default-then-jump. See Architecture section for why the custom pixel `elementStyle` from the prior revision was removed in favor of this default.

**Drag**: `mousedown`/`touchstart` on gutter → Split's `startDragging` sets user-select:none + pointer-events:none on both panes, cursor lock on gutter/parent/`document.body`, snapshots sizes, and fires `onDragStart` → our handler sets `this._dragging = true` (consulted by both the teardown path and the `ResizeObserver` callback below). Every native `mousemove`: Split's `drag()` computes new percentage split, clamps against `minSize`/`maxSize` (pixel-based, via real `getBoundingClientRect` offsets regardless of percentage rendering), writes inline styles on both panes — no localStorage touched (matches write-once-on-drag-end decision). `mouseup`/`touchend`/`touchcancel`: Split's `stopDragging` resets user-select/cursor/pointer-events, fires `onDragEnd(sizes)` → our handler sets `this._dragging = false`, reads actual `getBoundingClientRect().width` into `this._sidebarWidthPx`, calls `persistSidebarWidth(this._sidebarWidthPx)` — single write.

**Container resize (new — `ResizeObserver` recalculation)**: whenever `.content-area`'s own width changes (e.g. the browser window is resized, or a sibling layout change alters the flex container), the `ResizeObserver` installed on it in `_initSplit()` fires. If a drag is currently active (`this._dragging`), the callback no-ops, deferring to the drag's own math. Otherwise it recomputes `pct = (this._sidebarWidthPx / contentAreaEl.clientWidth) * 100` and calls `this._split.setSizes([pct, 100 - pct])`. This is what keeps the sidebar's literal pixel width fixed across window resizes despite Split's default percentage rendering being otherwise proportionally responsive — see Architecture section.

**Breakpoint transition**: `breakpoint.ts`'s existing `layoutModeForWidth` fires, `app.ts`'s `_layoutMode` state updates, triggering both `willUpdate()` and `updated()` on the same update cycle. Wide→narrow: `_destroySplit()` runs in `willUpdate()`, before Lit removes `<mux-sidebar>` — if `this._dragging` is true at this point, it first force-dispatches a synthetic `window` `mouseup` to run Split's own `stopDragging` cleanup (global listeners, cursor, user-select), then disconnects the `ResizeObserver` and calls `Split.destroy()` — explicit cleanup of gutter div + inline styles. Narrow→wide: `_initSplit()` runs in `updated()`, after Lit has placed the sidebar/main-pane elements back in the DOM, and re-reads localStorage to reconstruct fresh — no stale state carried across. Destroy happens pre-render (`willUpdate`) and init happens post-render (`updated`), matching the corrected lifecycle hooks described in Architecture & Ownership Boundary above.

**Reconnect while already wide (new)**: if `<mux-app>` disconnects and reconnects without `_layoutMode` ever changing (it was `'wide'` throughout), `disconnectedCallback()` has already nulled `_split` via `_destroySplit()`, but no `willUpdate`/`updated` cycle fires to re-trigger init. `connectedCallback()` closes this gap by calling `_initSplit()` directly, guarded by `_layoutMode === 'wide' && !this._split`.

**No other consumers**: confirmed via grep that nothing outside `mux-sidebar.ts` reads these constants/width today — this data flow is fully self-contained within `app.ts` + `lib/sidebar-width.ts`.

## Error Handling & Edge Cases

- localStorage unavailable/throws (private browsing, quota, disabled storage): `restoreSidebarWidth()` try/catch falls back to default; `persistSidebarWidth()` try/catch silently no-ops. Identical to today's behavior, no new failure mode.
- Corrupt/out-of-range stored value: same validation as today (parseInt, NaN check, range check) — falls back to default rather than passing a bad value to Split's `sizes` option.
- `_initSplit()` called before elements are in the DOM: guarded by null-checking both `querySelector` results — silent no-op, retried naturally on next `updated()` call since `_split` stays null.
- Double-init guard: `_initSplit()` early-returns if `this._split` is already set, preventing duplicate gutter divs from multiple `updated()` firings while wide.
- Window resize while dragging (browser window itself resized mid-drag): explicitly OUT OF SCOPE — existing edge case in Split.js itself, not a regression, not part of the original bug list.
- Main-pane's dockview content during drag: dockview-core's own `ResizeObserver` (in `mux-dock.ts`) reacts to `.main-pane`'s size changes independently, same as it does today on window resize — no new coupling introduced.
- Breakpoint transition or `<mux-app>` disconnection during an active drag (new): if `_destroySplit()` fires mid-drag, Split's own drag-cleanup (global `mousemove`/`mouseup`/`touchmove`/`touchend` listeners, cursor lock, `user-select`/`pointer-events` inline styles) would otherwise never run, since `Split.destroy()` doesn't perform it. Handled by `_destroySplit()` force-dispatching a synthetic `window` `mouseup` event when `this._dragging` is true, before disconnecting the `ResizeObserver` and calling `destroy()` — see Architecture & Ownership Boundary and Components.
- `<mux-app>` disconnect/reconnect while remaining wide throughout (new): `disconnectedCallback()` nulls `_split`, but if `_layoutMode` never changes (stays `'wide'` across the disconnect/reconnect), neither `willUpdate` nor `updated` fires to re-trigger `_initSplit()`. Handled by also calling `_initSplit()` from `connectedCallback()`, guarded by `_layoutMode === 'wide' && !this._split` — see Architecture & Ownership Boundary and Components.

## Testing / Verification Strategy

Per `AGENTS.md` — NO unit tests (banned in this repo). All verification via `playwright-cli` against the isolated `make dev-local` instance (127.0.0.1:8313). NEVER touch/kill/restart production (127.0.0.1:8311) or its sessiond. Fresh workspace/pane per verification run; fresh `make dev-local` restart before the clean pass; check for stale sessiond processes from other worktrees (`ps aux | grep sessiond`, confirm binary path matches this worktree) before trusting results.

**Core scenarios** (desktop/wide viewport, ≥768px):

1. Drag the gutter across a real multi-step drag gesture (not a single click) — confirm smooth, continuous resize tracking the pointer.
2. Drag past the min bound (160px) and max bound (360px) — confirm exact clamping, no overshoot.
3. Resize, reload the page — confirm width persists (localStorage round-trip).
4. During drag, attempt to select text elsewhere on the page (e.g. in a terminal pane) — confirm nothing gets selected.
5. Confirm cursor shows `col-resize` for the entire drag gesture even when the pointer strays slightly off the 4px gutter mid-drag.
6. Resize to narrow viewport (<768px) — confirm sidebar AND gutter are both gone, nothing leaks into narrow layout. Resize back to wide — confirm sidebar reappears with last-persisted width and remains draggable.

**Lit-diffing stress test (mandatory, not optional)**: While at wide viewport with the sidebar mounted and Split.js active, trigger rapid store updates that cause `app.ts` to re-render repeatedly (e.g., create/close several panes or workspaces in quick succession via the UI). Immediately after, confirm: (a) the gutter div is still present exactly once — not duplicated, not missing; (b) a fresh drag still works correctly (resizes, clamps, persists). This directly tests the resolved-by-construction risk identified during design — must be empirically observed, not assumed from the architectural reasoning alone.

**Drag-cancelled-by-teardown (new, mandatory)**: Start a drag on the gutter (mouse down, move partway) and, before releasing the mouse button, trigger a wide→narrow breakpoint transition (resize the browser below 768px) mid-drag. Confirm: (a) the cursor and text-selection state are correctly restored afterward — not stuck in `col-resize`/no-select; (b) no stale/leaked global listeners cause errors or unexpected behavior on subsequent clicks/moves elsewhere on the page; (c) resizing back to wide re-initializes cleanly (fresh gutter, draggable, correct width). This directly tests the forced-`mouseup`-before-`destroy()` fix for drag-in-progress-safe teardown.

**Fixed-pixel-width-under-window-resize (new, mandatory)**: At wide viewport, drag the sidebar to a non-default width (verify it persists), then resize the browser window itself (wider and narrower). Confirm the sidebar's pixel width visually stays fixed — it does not proportionally shrink/grow with the window — verified via computed geometry (e.g. reading the sidebar element's `getBoundingClientRect().width` before and after the window resize, not just a visual screenshot comparison). This directly tests the new `ResizeObserver`/`setSizes` fix that compensates for Split's default percentage-based rendering.

Each scenario requires a distinct playwright-cli pass with an explicit snapshot/observation step (not click-and-hope), with exact commands and observed results reported as evidence.

## Open Questions

None — all design decisions were resolved and explicitly approved during the design conversation, including library choice, architecture/ownership boundary, persistence write-frequency, error handling scope, and the verification plan.
