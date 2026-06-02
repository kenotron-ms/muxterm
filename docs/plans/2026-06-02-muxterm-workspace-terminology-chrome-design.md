# muxterm Workspace Terminology + Chrome Cleanup Design

## Goal

Make the live web UI speak one consistent word — **"workspace"** — and make switching/creating workspaces discoverable, while deleting the dead tmux-era code. No layout/docking changes this round.

- **Stack:** Lit + TypeScript web UI (`web/src/`) backed by a Go `sessiond` daemon.
- **Branch:** `feat/sessiond-persistence`.

## Chosen Approach

The user selected **Option A — the tight round**: a focused terminology + chrome cleanup with no docking work.

Scope of this round:
1. Terminology → **workspace** everywhere in the UI.
2. Move workspace switch/create into a **bottom-left status-bar control**.
3. Make the top-right **`⋯` menu app-level** (Settings, Keyboard Shortcuts, Reconnect, About).
4. **Delete the dead tmux-era code.**

### Vocabulary (this round)

- **Workspace** = top-level container (the tmux-session equivalent).
- **Pane** = a single running terminal. *Current meaning kept this round; the daemon protocol is unchanged.*
- **"window" / "session" / "region"** = eliminated from the UI entirely.

**Accepted future churn:** when the dockview docking project lands, "pane" will shift to mean a *container* and terminals become *tabs*. We knowingly defer that rename rather than doing it twice.

### Explicitly deferred (separate future project)

dockview-core adoption, docked panes, a tab-bar for tabs-within-panes, drag-and-drop, manual splits/rearrangement, the pane=container / tab=terminal model, and an escape-code-writable statusline (we **reserve space**, not build it).

### Library research (recorded as future-work context)

**dockview-core** is the chosen library for the future docking project:
- Framework-agnostic vanilla TS, zero deps, ~52 KB, MIT, actively maintained.
- Built-in layout serialization; works with Lit + xterm.js.
- **Runner-up:** Lumino. **golden-layout:** maintenance-only. **rc-dock / FlexLayout:** React-only, ruled out.

## Architecture & Components

Three UI surfaces change; the daemon protocol is untouched.

### Component 1 — Workspace switcher (a chip inside the status bar)

The workspace switcher is **not** a new custom element. It is a clickable **workspace chip** rendered inside `status-bar.ts` (left side), showing the current workspace as `‹label› ⌄` via the existing `labelForWorkspace()` helper.

- **Naming:** show the explicit name if set, else fall back to the workspace id (e.g. `w2`) via `labelForWorkspace()` — **never** a random auto-name.
- **One event, a rename only:** on click the chip emits a single event, `open-workspace-picker` — this is the **rename of the existing `open-session-picker` event** the status bar already dispatches. `app.ts` listens for `open-workspace-picker`, toggles its existing `_showWorkspacePicker` state, and renders the **existing `mux-workspace-picker`** — re-anchored to a **bottom-left upward dropdown** instead of a centered overlay.
- **No new wiring:** the `mux-workspace-picker` keeps emitting its existing `workspace-selected` / `workspace-create` / `workspace-rename` / `workspace-close` events, still wired to `app.ts` unchanged. The only change beyond the chip is the event **rename** — preserving the "app.ts already wired / no new wiring" claim.
- **Presentation:** re-anchor/restyle the existing picker from a centered full-screen overlay to a bottom-left upward dropdown.
- **Behavior:** click chip → picker opens upward; pick → switch + close; "New workspace" → create + switch; click-away / `Esc` → close; a single workspace still shows it + "New workspace".
- **Errors:** reuse the existing `unknown-workspace` / error-event handling — **no new error paths.**

### Component 2 — Status bar redesign (`status-bar.ts` + the `<mux-status-bar>` render in `app.ts`)

- **LEFT** = the workspace switcher (the meaningful element).
- **REMOVE** the count (currently `windowCount = store.workspaces.length`, mislabeled "windows") and the redundant `[session] · editor · %1` segment.
- **Keep the right side sparse:** theme · size · reconnect + connection state.
- The escape-code-writable statusline is **RESERVED** (space kept) but **NOT built** this round.

### Component 3 — App "⋯" menu (`title-bar.ts` + `launcher-menu.ts`)

- Becomes **app-level only:** Settings, Keyboard Shortcuts, Reconnect, About.
- **REMOVE** "New session" (creation now lives in the bottom-left switcher) and any "New browser" / "Open driver" tmux/driver-era items.
- **Renames:** user-facing event `new-session` → `new-workspace`; handler `open-session-picker` → `open-workspace-picker`; CSS `empty-session` → workspace equivalent; etc.

## Data Flow

1. **Switch:** user clicks the status-bar workspace chip → chip emits `open-workspace-picker` → `app.ts` toggles `_showWorkspacePicker` and renders the existing `mux-workspace-picker` upward → user picks a workspace → picker emits `workspace-selected` → `app.ts` (already wired) sends to the socket → store updates → chip label re-renders via `labelForWorkspace()`.
2. **Create:** "New workspace…" → emits `workspace-create` → `app.ts` → socket → new workspace created and switched to.
3. **Rename / Close:** emit `workspace-rename` / `workspace-close` through the same existing `app.ts` → socket path.
4. **App menu:** `⋯` items emit app-level actions only (Settings/Shortcuts/Reconnect/About); the renamed `new-workspace` event is no longer emitted here — creation is owned by the switcher.

No new socket messages or daemon changes; this is a re-wiring of triggers and presentation over existing events.

## Status-bar Redesign

(See Component 2.) Net effect: the status bar's left side carries the single meaningful control (the workspace switcher), the misleading "windows" count and the `[session] · editor · %1` segment are gone, and the right side stays sparse (theme · size · reconnect + connection state) with reserved-but-unbuilt space for a future writable statusline.

## App Menu

(See Component 3.) The `⋯` menu is reduced to app-level concerns only. Workspace creation moves out of the menu and into the switcher, and the `session`-era event/handler/CSS names are renamed to their `workspace` equivalents.

## Dead-code Deletion

User granted **full authority to "make it clean"** — aggressive removal is authorized.

### Confirmed orphaned

- `components/tab-bar.ts` — zero non-test importers.
- `components/workspace.ts` — zero non-test importers.
- `lib/workspace.ts` — **transitively dead** — its only importer is the orphaned `components/workspace.ts` (line 4).

These root a tmux-era cluster imported only by itself. **Candidate cluster to remove with them:**

- `components/region.ts`, `region-tabstrip.ts`, `region-divider.ts`, `region-menu.ts`, `resize-handle.ts`, the old `components/layout.ts`
- libs: `cell-budget.ts`, `resize-coalescer.ts`, `popout.ts`, `layout-parser.ts`
- plus each file's `.test.ts`

### Surgical (in-file) removals of stale tmux paths in LIVE files

- `types.ts` — tmux `ServerMessage` / `ClientMessage` unions (`session-list`, `window-add`, `new-window`, etc.).
- `state.ts` — the `applyMessage` / `normalizeMessage` tmux path.
- `ws.ts` — tmux `normalizeMessage` remnants.

### Method (important — not guesswork)

1. Compute the set **transitively unreachable from `app.ts`**.
2. Delete exactly that set.
3. **Gate:** `tsc --noEmit` clean + `vite build` clean + full `npm test` green.

The **exact final file list** is produced and verified by reachability analysis *during implementation*; this doc records the **method + candidate cluster**, not a hand-picked delete list.

> **Reachability caveat:** `launcher-menu.ts`, `region-menu.ts`, and `cell-budget.ts` currently show importers and must be reachability-checked before deletion. **`launcher-menu.ts` is LIVE** — it gets edited (Component 3), not deleted. **`lib/snapshot.ts` is LIVE and must NOT be deleted** — it is imported (value import `serializeSnapshot`) by `lib/terminal-registry.ts`, which is imported by `app.ts`, so it is transitively reachable from `app.ts`.

## Testing Strategy (TDD)

Strict **RED → GREEN → REFACTOR** per component. Tests are written failing first.

### Status-bar workspace switcher tests (RED first)

The switcher is markup/logic in `status-bar.ts` — **not** a separate custom element. Its tests:

- Renders the current workspace label from the store via `labelForWorkspace()`.
- Unnamed workspace → **id fallback** (e.g. `w2`), never a random name.
- Emits `open-workspace-picker` on click.

The four `workspace-selected` / `workspace-create` / `workspace-rename` / `workspace-close` events remain the **existing responsibility and tests of `mux-workspace-picker`** — they are **not** attributed to the status-bar switcher.

### Status bar

Asserts it renders the workspace switcher, shows **no count**, and its output contains **no "window"** text.

### App "⋯" menu

Asserts only app-level items are present, and it **no longer** emits `workspace-create` / "new session".

### Terminology guard

A test asserting that rendered live components contain **zero** "session/window/region" user-facing strings (a cheap regression net for the rename).

### Dead-code deletion gate (safety net)

After removing the orphan cluster + stale message paths (and their `.test.ts` files), the hard gate is:

- `tsc --noEmit` clean
- `vite build` clean
- full `npm test` green
- **Go suite untouched and green**

Nothing reachable from `app.ts` may break. Existing **334 web tests** stay green (minus deleted dead tests).

## Mockup Reference

An updated, approved static HTML storyboard lives at `docs/plans/mockups/2026-05-30-muxterm-chrome/` — 5 pages:

| Page | Shows |
| --- | --- |
| `1-base` | Chrome at rest; workspace switcher bottom-left (`● work ⌄`). |
| `2-workspaces` | Switcher dropdown open: ✓ work, agents, ＋ New workspace… |
| `3-app-menu` | App-level `⋯`: Settings / Keyboard Shortcuts / Reconnect / About. |
| `4-tabs` | Terminal tab bar; `+` hugs the last tab on desktop. |
| `5-responsive` | Narrow/phone reflow; `+` pushed to the right edge. |

The old `1-current` / `2-dock` / `3-driver` / `4-sessions` / `5-more` / `6-launcher` pages were deleted.

## Open Questions / Future Work

1. **dockview-powered docking/splits/tabs project** (separate design). Start with a **spike** proving Lit + xterm + responsive reconciliation: dockview is *manual* layout while the current `arrange()` engine is *auto-responsive* — reconcile via per-breakpoint serialized layouts.
2. **Escape-code-writable statusline mechanism** — which OSC/sequence, per-pane vs workspace scope, and sanitization.

Both are explicitly **out of scope** for this round.
