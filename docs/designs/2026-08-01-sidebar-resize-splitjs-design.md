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

**Lifecycle, tied to the existing `isWide` breakpoint boundary** (same place `<mux-sidebar>` already mounts/unmounts):

- narrow → wide: after Lit's render places both elements in the DOM (`await this.updateComplete`), call `Split([sidebarEl, mainPaneEl], {...})` in `updated()`.
- wide → narrow: call `splitInstance.destroy()` BEFORE Lit's next render removes `<mux-sidebar>` — explicit cleanup of the gutter div and inline styles, not reliance on garbage collection.
- A single `_split: ReturnType<typeof Split> | null` instance field on `app.ts` holds the current instance.

**Constants relocate** from `mux-sidebar.ts` to a new shared module `web/src/lib/sidebar-width.ts`: `SIDEBAR_WIDTH_KEY`, `SIDEBAR_DEFAULT_WIDTH`, `SIDEBAR_MIN_WIDTH`, `SIDEBAR_MAX_WIDTH`, plus two pure helper functions `restoreSidebarWidth(): number` and `persistSidebarWidth(px: number): void` (same validation/clamp/try-catch logic as today's `connectedCallback` block, just relocated and made independently testable/callable). `mux-sidebar.ts`'s CSS keeps `min-width`/`max-width` as a defensive floor/ceiling backstop but drops the hardcoded `width: 220px` default — initial size now comes from Split's `sizes` init option.

**Resolved risk — Lit-diffing vs. Split.js's externally-inserted gutter div**: Split.js inserts its own `.gutter` div directly via `parent.insertBefore()`, outside Lit's template tracking. Because `app.ts`'s `isWide` conditional is the ONLY expression-level change point for `.content-area`'s children, and Split.js is destroyed/recreated exactly at that same boundary, there's no window where the externally-inserted gutter div coexists with a Lit re-render that could touch `.content-area`'s top-level child list. This resolves the risk by construction (architectural boundary alignment), not by runtime luck — but per user's explicit instruction, it MUST still be empirically verified with a dedicated stress test (see Testing Strategy) rather than accepted on reasoning alone.

## Components

**`app.ts` (modified):**

```typescript
import Split from 'split.js';
import type { Instance as SplitInstance } from 'split.js';
import { restoreSidebarWidth, persistSidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from './lib/sidebar-width.js';

private _split: SplitInstance | null = null;

private _initSplit(): void {
  const sidebarEl = this.renderRoot.querySelector('mux-sidebar');
  const mainPaneEl = this.renderRoot.querySelector('.main-pane');
  if (!sidebarEl || !mainPaneEl || this._split) return; // guards: elements present, no double-init

  const initialWidth = restoreSidebarWidth();
  const contentAreaWidth = /* .content-area clientWidth */;
  const sidebarPercent = (initialWidth / contentAreaWidth) * 100;

  this._split = Split([sidebarEl, mainPaneEl], {
    sizes: [sidebarPercent, 100 - sidebarPercent],
    minSize: [SIDEBAR_MIN_WIDTH, 0],       // main-pane keeps today's "no enforced minimum"
    maxSize: [SIDEBAR_MAX_WIDTH, Infinity],
    gutterSize: 4,                          // matches existing .resize-handle width
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
```

Called from `updated(changedProps)`: `_layoutMode` changing to `'wide'` → `_initSplit()` after `updateComplete`; changing to `'narrow'` → `_destroySplit()`.

**`web/src/lib/sidebar-width.ts` (new):** `SIDEBAR_WIDTH_KEY`, `SIDEBAR_DEFAULT_WIDTH`, `SIDEBAR_MIN_WIDTH`, `SIDEBAR_MAX_WIDTH` constants; `restoreSidebarWidth(): number` (reads/validates/clamps localStorage, try/catch, falls back to default on any failure — identical logic to today's `connectedCallback` block); `persistSidebarWidth(px: number): void` (try/catch `localStorage.setItem`, silent no-op on failure).

**`mux-sidebar.ts` (modified):** Remove `_onResizeStart`, `.resize-handle` template markup and CSS, width-restore block in `connectedCallback`, and the four width constant exports (moved to `lib/sidebar-width.ts`). Keep `min-width`/`max-width` CSS rules as defensive backstop; remove hardcoded `width: 220px`.

**`web/package.json` (modified):** Add `split.js` as a real npm dependency (`npm install split.js`, updating `package.json` and `package-lock.json` properly — not a vendored copy).

## Data Flow

**Init/restore** (page load or narrow→wide transition): `restoreSidebarWidth()` reads localStorage, validates range `[160,360]`, falls back to `220` on missing/invalid/error — identical validation to today. `_initSplit()` converts to a percentage pair based on `.content-area`'s current `clientWidth`, passed as Split's `sizes` init option. Split applies initial styles synchronously on construction — no flash of default-then-jump.

**Drag**: `mousedown`/`touchstart` on gutter → Split's `startDragging` sets user-select:none + pointer-events:none on both panes, cursor lock on gutter/parent/`document.body`, snapshots sizes. Every native `mousemove`: Split's `drag()` computes new percentage split, clamps against `minSize`/`maxSize` (pixel-based), writes inline styles on both panes — no localStorage touched (matches write-once-on-drag-end decision). `mouseup`/`touchend`/`touchcancel`: Split's `stopDragging` resets user-select/cursor/pointer-events, fires `onDragEnd(sizes)` → our handler reads actual `getBoundingClientRect().width`, calls `persistSidebarWidth(px)` — single write.

**Breakpoint transition**: `breakpoint.ts`'s existing `layoutModeForWidth` fires, `app.ts`'s `_layoutMode` state updates, triggers `updated()`. Wide→narrow: `_destroySplit()` runs before Lit removes `<mux-sidebar>` — explicit cleanup of gutter div + inline styles. Narrow→wide: after `updateComplete`, `_initSplit()` re-reads localStorage and reconstructs fresh — no stale state carried across.

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
