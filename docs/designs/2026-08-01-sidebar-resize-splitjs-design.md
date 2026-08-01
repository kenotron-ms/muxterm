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
- A single `_split: ReturnType<typeof Split> | null` instance field on `app.ts` holds the current instance.
- Defensively, `app.ts`'s `disconnectedCallback()` should also call `_destroySplit()`, in case the app element itself is removed from the DOM while a Split instance is active (e.g., mid-drag) — cleanup should not rely solely on the `willUpdate` breakpoint-transition path.

**Constants relocate** from `mux-sidebar.ts` to a new shared module `web/src/lib/sidebar-width.ts`: `SIDEBAR_WIDTH_KEY`, `SIDEBAR_DEFAULT_WIDTH`, `SIDEBAR_MIN_WIDTH`, `SIDEBAR_MAX_WIDTH`, plus two pure helper functions `restoreSidebarWidth(): number` and `persistSidebarWidth(px: number): void` (same validation/clamp/try-catch logic as today's `connectedCallback` block, just relocated and made independently testable/callable). `mux-sidebar.ts`'s CSS keeps `min-width`/`max-width` as a defensive floor/ceiling backstop but drops the hardcoded `width: 220px` default — initial size now comes from Split's `sizes` init option.

**Pixel-fixed sizing, not percentage-based `sizes`**: `_initSplit()` seeds Split's `sizes` option with raw pixel values (not a percentage pair) summing to `.content-area`'s actual pixel width, and supplies a custom `elementStyle` function that writes a literal `px` width to the sidebar element — bypassing Split's default `calc(size% - gutterSize/2px)` percentage/calc styling entirely — while returning `{}` for the main-pane element, leaving its existing `.main-pane { flex: 1 }` CSS rule fully in control. This exactly reproduces today's relationship: sidebar has an explicit width, main-pane fills whatever remains. Split's internal `adjust()`/`drag()` math computes ratios from real `getBoundingClientRect()` pixel offsets, so it is unit-agnostic as long as `sizes` is seeded consistently — seeding in raw pixels keeps the entire drag/clamp/resize model in real-pixel space throughout. This is also what makes the sidebar correctly stay fixed across window resizes (Split.js has no internal `ResizeObserver` — sizes are only recalculated at the start of an explicit drag), avoiding a real behavior change from today's fixed-until-next-drag semantics that a percentage-based `sizes` approach would otherwise introduce silently (percentage seeding also triggers Split's default `calc()` element styling, which renders/persists a width 2px off from the true value on every cycle).

**Resolved risk — Lit-diffing vs. Split.js's externally-inserted gutter div**: Split.js inserts its own `.gutter` div directly via `parent.insertBefore()`, outside Lit's template tracking. Because `app.ts`'s `isWide` conditional is the ONLY expression-level change point for `.content-area`'s children, and Split.js is destroyed/recreated exactly at that same boundary, there's no window where the externally-inserted gutter div coexists with a Lit re-render that could touch `.content-area`'s top-level child list. This resolves the risk by construction (architectural boundary alignment), not by runtime luck — but per user's explicit instruction, it MUST still be empirically verified with a dedicated stress test (see Testing Strategy) rather than accepted on reasoning alone.

## Components

**`app.ts` (modified):**

```typescript
import Split from 'split.js';
import type { Instance as SplitInstance } from 'split.js';
import { restoreSidebarWidth, persistSidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from './lib/sidebar-width.js';

private _split: SplitInstance | null = null;

private _initSplit(): void {
  const sidebarEl = this.renderRoot.querySelector<HTMLElement>('mux-sidebar');
  const mainPaneEl = this.renderRoot.querySelector<HTMLElement>('.main-pane');
  const contentAreaEl = this.renderRoot.querySelector<HTMLElement>('.content-area');
  if (!sidebarEl || !mainPaneEl || !contentAreaEl || this._split) return;

  const initialWidth = restoreSidebarWidth();

  // Sidebar stays pixel-fixed (not responsive to container resize) -- matches
  // today's exact behavior, where width only changes on an explicit drag.
  // main-pane's own `.main-pane { flex: 1 }` CSS rule fills the remainder
  // untouched -- elementStyle returns {} for it, preserving today's relationship.
  const pxElementStyle = (dim: string, size: number, _gutSize: number, i: number) => {
    if (i === 0) {
      return { [dim]: `${size}px`, flexGrow: '0', flexShrink: '0' };
    }
    return {};
  };

  this._split = Split([sidebarEl, mainPaneEl], {
    // Raw pixel values, not percentages -- keeps Split's internal drag/adjust
    // math in real-pixel space throughout (see Architecture section).
    sizes: [initialWidth, contentAreaEl.clientWidth - initialWidth],
    minSize: [SIDEBAR_MIN_WIDTH, 0],       // main-pane keeps today's "no enforced minimum"
    maxSize: [SIDEBAR_MAX_WIDTH, Infinity],
    gutterSize: 4,                          // matches existing .resize-handle width
    elementStyle: pxElementStyle,
    gutter: () => {
      const g = document.createElement('div');
      g.className = 'sidebar-gutter'; // styled in app.ts CSS to visually match old .resize-handle (hover highlight, col-resize cursor)
      return g;
    },
    onDragEnd: () => {
      const px = sidebarEl.getBoundingClientRect().width;
      persistSidebarWidth(px);
    },
  });
}

private _destroySplit(): void {
  this._split?.destroy();
  this._split = null;
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
```

Wired via the two Lit lifecycle hooks described above: `_layoutMode` changing to `'narrow'` → `_destroySplit()` in `willUpdate` (before Lit removes `<mux-sidebar>`); `_layoutMode` changing to `'wide'` → `_initSplit()` in `updated` (after Lit has placed the sidebar/main-pane elements in the DOM). `disconnectedCallback()` also calls `_destroySplit()` defensively.

**`web/src/lib/sidebar-width.ts` (new):** `SIDEBAR_WIDTH_KEY`, `SIDEBAR_DEFAULT_WIDTH`, `SIDEBAR_MIN_WIDTH`, `SIDEBAR_MAX_WIDTH` constants; `restoreSidebarWidth(): number` (reads/validates/clamps localStorage, try/catch, falls back to default on any failure — identical logic to today's `connectedCallback` block); `persistSidebarWidth(px: number): void` (try/catch `localStorage.setItem`, silent no-op on failure).

**`mux-sidebar.ts` (modified):** Remove `_onResizeStart`, `.resize-handle` template markup and CSS, width-restore block in `connectedCallback`, and the four width constant exports (moved to `lib/sidebar-width.ts`). Keep `min-width`/`max-width` CSS rules as defensive backstop; remove hardcoded `width: 220px`.

**`web/package.json` (modified):** Add `split.js` as a real npm dependency (`npm install split.js`, updating `package.json` and `package-lock.json` properly — not a vendored copy).

## Data Flow

**Init/restore** (page load or narrow→wide transition): `restoreSidebarWidth()` reads localStorage, validates range `[160,360]`, falls back to `220` on missing/invalid/error — identical validation to today. `_initSplit()` computes the sidebar's raw pixel width and the remaining pixel width for main-pane (`contentAreaEl.clientWidth - initialWidth`), passed as Split's `sizes` init option in raw pixels (not percentages) — see Architecture section for why. Split applies initial styles synchronously on construction — no flash of default-then-jump.

**Drag**: `mousedown`/`touchstart` on gutter → Split's `startDragging` sets user-select:none + pointer-events:none on both panes, cursor lock on gutter/parent/`document.body`, snapshots sizes. Every native `mousemove`: Split's `drag()` computes new percentage split, clamps against `minSize`/`maxSize` (pixel-based), writes inline styles on both panes — no localStorage touched (matches write-once-on-drag-end decision). `mouseup`/`touchend`/`touchcancel`: Split's `stopDragging` resets user-select/cursor/pointer-events, fires `onDragEnd(sizes)` → our handler reads actual `getBoundingClientRect().width`, calls `persistSidebarWidth(px)` — single write.

**Breakpoint transition**: `breakpoint.ts`'s existing `layoutModeForWidth` fires, `app.ts`'s `_layoutMode` state updates, triggering both `willUpdate()` and `updated()` on the same update cycle. Wide→narrow: `_destroySplit()` runs in `willUpdate()`, before Lit removes `<mux-sidebar>` — explicit cleanup of gutter div + inline styles. Narrow→wide: `_initSplit()` runs in `updated()`, after Lit has placed the sidebar/main-pane elements back in the DOM, and re-reads localStorage to reconstruct fresh — no stale state carried across. Destroy happens pre-render (`willUpdate`) and init happens post-render (`updated`), matching the corrected lifecycle hooks described in Architecture & Ownership Boundary above.

**No other consumers**: confirmed via grep that nothing outside `mux-sidebar.ts` reads these constants/width today — this data flow is fully self-contained within `app.ts` + `lib/sidebar-width.ts`.

## Error Handling & Edge Cases

- localStorage unavailable/throws (private browsing, quota, disabled storage): `restoreSidebarWidth()` try/catch falls back to default; `persistSidebarWidth()` try/catch silently no-ops. Identical to today's behavior, no new failure mode.
- Corrupt/out-of-range stored value: same validation as today (parseInt, NaN check, range check) — falls back to default rather than passing a bad value to Split's `sizes` option.
- `_initSplit()` called before elements are in the DOM: guarded by null-checking both `querySelector` results — silent no-op, retried naturally on next `updated()` call since `_split` stays null.
- Double-init guard: `_initSplit()` early-returns if `this._split` is already set, preventing duplicate gutter divs from multiple `updated()` firings while wide.
- Window resize while dragging (browser window itself resized mid-drag): explicitly OUT OF SCOPE — existing edge case in Split.js itself, not a regression, not part of the original bug list.
- Main-pane's dockview content during drag: dockview-core's own `ResizeObserver` (in `mux-dock.ts`) reacts to `.main-pane`'s size changes independently, same as it does today on window resize — no new coupling introduced.

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

Each scenario requires a distinct playwright-cli pass with an explicit snapshot/observation step (not click-and-hope), with exact commands and observed results reported as evidence.

## Open Questions

None — all design decisions were resolved and explicitly approved during the design conversation, including library choice, architecture/ownership boundary, persistence write-frequency, error handling scope, and the verification plan.
