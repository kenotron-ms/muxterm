# Mobile Touch Actions Design

## Goal

Fix two related mobile-web usability issues reported by the human after using muxterm on a phone: (1) the narrow-mode tab bar / title bar is too thin for reliable touch targets, and (2) there is no reachable "new terminal" (new pane) or "new workspace" action on mobile at all.

## Background

muxterm renders one of two layout modes based on viewport width (`web/src/lib/breakpoint.ts`, `currentLayoutMode()` reading `window.innerWidth`): `wide` (>=768px — dockview with splits, layout persisted) or `narrow` (<768px — tab-view only, no persistence). In narrow mode, `web/src/app.ts` renders `<mux-title-bar>` instead of `<mux-sidebar>`. That title bar was sized for a compact desktop-adjacent chrome, not for touch: its controls fall well under the ~44px touch-target guideline, and it has no path to create a new pane or a new workspace at all — those actions exist only in wide mode (dockview's own "+" button, `mux-sidebar.ts`'s "+ New workspace" button). A phone user is left able to switch between existing panes/workspaces via `<mux-pane-picker>`, but with no way to create new ones and small mis-tap-prone controls for what little is there.

## Current State (verified against live source)

- `web/src/lib/breakpoint.ts`: single binary layout mode, `wide` (>=768px, dockview+splits, layout persisted) vs `narrow` (<768px, tab-view only, no persistence). `currentLayoutMode()` reads `window.innerWidth`.
- `web/src/app.ts`: `_layoutMode` state recomputed on resize. At render (`isWide = this._layoutMode === 'wide'`): `<mux-title-bar>` renders only when `!isWide`; `<mux-sidebar>` renders only when `isWide`; `<mux-dock .narrow="${!isWide}">` always renders (with panes).
- `web/src/components/title-bar.ts` (`<mux-title-bar>`, the mobile/narrow top bar): `:host` height `32px`, padding `0 8px`. Contains `.brand`, `<mux-pane-picker>`, and a `.right` div with `.launcher-btn` (28x24) that toggles `<mux-launcher-menu>` shown in a `.menu-anchor` positioned `top: 28px` (hardcoded, tracks the old height). Already dispatches `launcher-action` (re-dispatched from the menu) and `workspace-switch` custom events (bubbles+composed).
- `web/src/components/mux-pane-picker.ts` (`<mux-pane-picker>`, lives inside title-bar): `.breadcrumb` button has `min-height: 32px` — the workspace›pane switcher, also part of the "too-thin bar" complaint. Its dropdown `.ws-item`/`.pane-item` rows have `padding: 6px 8px` (deliberately out of scope for this fix — see design decision below).
- `web/src/components/launcher-menu.ts` (`<mux-launcher-menu>`): `LauncherAction` type is a closed union `'settings' | 'shortcuts' | 'reconnect' | 'about'`. Renders exactly 4 hardcoded buttons dispatching `launcher-action` events with `{action}` detail.
- `web/src/app.ts` `_onLauncherAction` (~line 1100): switch over `action`, handles `settings|shortcuts|about` (opens `_overlayPanel`) and `reconnect` (`window.location.reload()`). This is the extension point for new menu-driven actions.
- `web/src/components/mux-sidebar.ts` (`<mux-sidebar>`, wide-mode only): `.new-ws-btn` (~line 460) → `_onNewWs()` → dispatches `workspace-create` event → `app.ts`'s `_onOpenCreateModal` (~line 864, sets `_showCreateModal = true`) → renders `.ws-create-backdrop`/`.ws-create-dialog` modal (~lines 127-214) with `.ws-create-input`, submit via `_submitCreate` (~874-882, reads DOM value directly for mobile IME reliability), Enter/Escape handling, `_creatingWorkspace` guard flag with disabled-state CSS already present. This modal is already mobile-safe (`width: min(420px, calc(100vw - 40px))`) and needs no changes — only a new way to reach it on mobile.
- `web/src/app.ts` `_createPaneOptimistic` (~line 897): mints a `clientRef`, decrements `_nextTempPaneId` for a provisional negative-id pane, pushes optimistically, settles on server ack matching `clientRef`. This is already the handler used by the empty-state "+ New pane" button (`app.ts:716`, only visible when `panes.length === 0`) — safe to call repeatedly (each tap = new clientRef, no shared in-flight guard needed, matching existing dockview "+" behavior on desktop of creating multiple panes on repeated taps).
- `web/src/components/mux-dock.ts` (`<mux-dock>`, dockview wrapper): lines ~566-571 have `@media (max-width: 768px) { mux-dock .dv-tabs-and-actions-container { display: none !important; } }` — hides dockview's entire header (tabs + "+"/split/browser buttons) below 768px, even though the "+" button is still constructed in JS (`createLeftHeaderActionComponent`, ~591-599, uses an `ADD_ICON`). This is untouched by this design — narrow mode continues to rely on `mux-pane-picker` for tab switching, not dockview's own tab strip.
- `web/src/lib/theme.ts:288`: `--mux-dock-height: '44px'` — an existing, currently unused CSS custom property, comment says "dock bar row height / touch target." This design wires it up for the first time.
- `web/src/components/mux-undo-toast.ts:52-56`: `.undo { min-height: 44px; min-width: 44%; ... }` with explicit comment "44px minimum touch target height" — the one existing precedent in the codebase for correct touch-target sizing; used as the style reference (not code reused directly).
- Existing z-index tiers in `app.ts`: undo-toast-stack 900, reconnect overlay 1000, title-bar menu-anchor 1500, pane-picker dropdown 2000, ws-create/overlay backdrops 3000. This design introduces no new z-index tier — no floating overlay is added.

Scope confirmed with the user: pure frontend change only. Zero backend, socket-protocol, or dockview-version changes. All new UI wires into existing working APIs: `createWorkspace()`/create-modal flow, `_createPaneOptimistic()`, and the `launcher-action` event system.

## Alternatives Considered

1. **Chosen: persistent "+" new-pane button in the title bar + "New workspace" added to the kebab (launcher) menu.** New-pane is the frequent action and deserves one-tap, always-visible prominence; new-workspace is a rarer, more deliberate action on desktop too (a sidebar button, not a keystroke away), so one-tap-deeper via the kebab is appropriate. No new floating overlay, no new visual idiom, no new z-index tier — just extends 3 existing components plus one new custom event.
2. **Rejected: bottom-right floating action button (FAB) for new-pane.** The standard mobile idiom (thumb-reachable at the bottom of a tall phone screen, vs. the title bar at the top being harder to reach one-handed) is legitimate and discoverable, but rejected because it introduces a new visual idiom not used anywhere else in muxterm's chrome (everything today is flat top bars/menus) and adds new fixed-position/z-index coordination complexity for a benefit (thumb reach) that's secondary to the core problem (the action simply not existing at all).
3. **Rejected: both new-pane and new-workspace live only in the kebab menu, no title-bar changes beyond height.** Smallest possible diff, but under-serves the reported complaint by burying the single most common action (new pane) two taps deep instead of one, and doesn't meaningfully address discoverability.

## Chosen Design

### Issue 1: Touch-target height fix

- `title-bar.ts`: `:host` height `32px` → `var(--mux-dock-height, 44px)`. `.launcher-btn` `28x24` → `44x44`. `.menu-anchor { top: 28px }` → `top: 100%` (self-correcting anchor to bottom of host, removing a second hardcoded magic number that would otherwise need to track the new height). Padding and decorative elements (`.brand`, `.brand-dot`, `.brand-sha`) unchanged — only interactive/structural elements get the touch-target bump.
- `mux-pane-picker.ts`: `.breadcrumb { min-height: 32px }` → `44px`. Its dropdown `.ws-item`/`.pane-item` padding (`6px 8px`) is deliberately left unchanged — explicit scope boundary: these are secondary targets inside an already-open dropdown (lower mis-tap cost), and the reported complaint is about the primary bar, not nested menus.
- Rationale for `var(--mux-dock-height, 44px)` over a hardcoded `44px`: fulfills wiring up the existing unused token, gives future theme/config work one lever, and the fallback means nothing breaks if the token is ever removed.
- Wide/desktop mode: zero changes. Dockview's own tab strip height (from dockview-core's `--dv-tabs-and-actions-container-height` default) is completely untouched — satisfies "wide/desktop unaffected" by construction.

### Issue 2a: New-pane button (title bar)

- `title-bar.ts`: new icon-button added to the existing `.right` div, positioned before the kebab button. Icon: `Plus` from lucide (via the shared `icon()` helper), matching the icon language `mux-dock.ts` already uses for its own desktop "+" button (`ADD_ICON`). Sized `44x44` to match the kebab button — both are now equally prominent primary controls.
- On click: dispatches a new custom event `pane-create-request` (bubbles + composed) — deliberately not reusing `launcher-action`. `launcher-action` semantically means "an item was picked from the overflow menu"; this button is a persistent, always-visible primary control outside that menu. Reusing the same event name for two different UI affordances would confuse the next reader of `_onLauncherAction`'s switch statement. A distinctly-named event keeps menu actions and primary actions visually separable in `app.ts`.
- `app.ts`: new listener `@pane-create-request="${this._createPaneOptimistic}"` on `<mux-title-bar>` — reuses the exact existing handler the empty-state button already calls. Zero new pane-creation logic. Always creates in `store.attached` (current workspace) — matches the existing empty-state button and desktop dockview "+" convention exactly, no new targeting logic needed.

### Issue 2b: New-workspace menu entry (kebab)

- `launcher-menu.ts`: extend the `LauncherAction` type to add `'new-workspace'` (only this one new value — new-pane does not go through this menu, see above). Add one new `<button data-action="new-workspace">` dispatching `this._dispatch('new-workspace')`. Placement: at the top of the menu list, followed by a `<div class="divider">` before the existing Settings/Shortcuts/Reconnect items — mirroring `mux-sidebar.ts`'s convention of visually separating "+ New workspace" (content-creation) from utility actions. Icon: `Plus` from lucide (same icon as the title-bar new-pane button, for visual consistency that "+" always means "create").
- `app.ts`: `_onLauncherAction`'s switch gains `case 'new-workspace': this._onOpenCreateModal(); break;` — reuses the existing create-modal entirely unchanged (naming, submit-on-Enter, cancel-on-Escape, DOM-read-for-mobile-IME-reliability, `_creatingWorkspace` disabled-state guard — all already correct and mobile-safe).

## Edge Cases / Error Handling

Every action this design adds is a thin new trigger onto existing, already-battle-tested handlers — a deliberate property of the chosen approach: zero new state machines.

- **Rapid double-tap on new-pane button:** already safe (existing `_createPaneOptimistic`, no shared in-flight flag; multiple taps = multiple panes, matching existing desktop dockview "+" behavior).
- **Kebab open + new-pane tap simultaneously:** no conflict — the new-pane button lives outside the kebab dropdown entirely (Section on Issue 2a), so opening the kebab doesn't block or interact with it. `title-bar.ts`'s existing outside-click handler (`_onOutsideClick`, closes menu on any click outside `this`) still applies correctly since the new button is inside the same shadow root.
- **Workspace-create modal re-submission:** already guarded by the existing `_creatingWorkspace` flag (`app.ts:880`) plus existing disabled CSS states on `.ws-create-input`/`.ws-create-confirm` — nothing new required, just a new door into an existing, correct flow.
- **Single-workspace case:** `mux-pane-picker.ts:238` already conditionally hides the "Workspaces" section header when `workspaces.length <= 1` — unrelated/unaffected; the new kebab "New workspace" entry is unconditionally available regardless of workspace count (that's the whole point of the fix).
- **No new loading/error states are needed anywhere** — every action this design adds is a thin new trigger onto existing, already-tested handlers.

## Verification Strategy

Per this project's testing policy (`AGENTS.md`), no unit tests — real execution only, using `make dev-local` (127.0.0.1:8313, isolated from production 8311/native companion app — never touched) and playwright-cli with an emulated mobile viewport (e.g. 390x844) for narrow-mode checks. Verifying only at desktop width would not exercise the narrow layout mode at all. Follows AGENTS.md's verification hygiene rules: brand-new workspace/pane every verification run, never reuse one across iterations, fresh `make dev-local` restart before the clean pass.

**Mobile viewport pass (narrow, <768px):**

1. Fresh `make dev-local` restart, brand-new workspace for this run.
2. **(a) Height:** measure `mux-title-bar`'s rendered height and the new "+" button's bounding box, confirm >=44px, visually confirm the bar reads noticeably thicker than before.
3. **(b) New pane:** real tap on the new "+" button, confirm a new pane tab appears and becomes active (`mux-pane-picker` breadcrumb updates, terminal mounts).
4. **(c) New workspace:** real tap sequence — open kebab, tap "New workspace", confirm the create modal opens, type a name, submit, confirm the new workspace appears and auto-switches.

**Desktop viewport pass (wide, >=768px) — regression check:**

5. Fresh workspace/pane again (hygiene rule applies to every run, not just mobile).
6. **(d)** Confirm `<mux-sidebar>` renders (not title-bar), dockview tab strip height is completely unchanged from before this change, sidebar "+ New workspace" still works, dockview's own "+" still works.

Each scenario must be observed working via playwright-cli (or the muxterm-verify skill) in a real browser against a real `make dev-local` process before this work is considered done — no scenario is satisfied by code inspection alone.

## Open Questions

None — all design decisions were validated section-by-section with the user, including the deliberate scope boundaries (dropdown item padding left unchanged, wide/desktop untouched, no new state machines). Scope explicitly confirmed as pure-frontend, zero backend/protocol/dockview-version changes.
