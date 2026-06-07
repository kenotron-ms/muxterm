# Attention Management Design

## Goal

Add bell-triggered visual attention indicators — dots on pane tabs and workspace dock slots — so users know when a background pane or workspace needs their attention.

## Background

When running multiple panes across multiple workspaces, programs frequently signal completion or failure via the terminal bell (`\a`). Today muxterm has no visual representation of those signals: if you're looking at a different pane or workspace when a build finishes or a test fails, you miss it entirely. This feature makes those signals visible without being intrusive — dots appear on the relevant tab and dock slot, and disappear when you acknowledge them by switching to that pane or workspace.

The design uses `\a` (bell character) exclusively as the trigger. Programs explicitly opt in to signalling by writing `\a`, which means every dot is intentional. There is no dot for arbitrary output.

## Approach

Replace `mux-status-bar` with a new `mux-dock-bar` component that renders workspace slots with bell indicators, and extend `mux-dock` to show bell dots on pane tabs. Bell state is managed centrally in `MuxStore` using a timestamp-based model that correctly handles the case where a new bell fires after an acknowledgement.

The dock bar redesign (Option B: new component, swap in) was chosen over patching the existing status bar. It keeps the diff clean, avoids entangling dock bar layout changes with bell state changes, and leaves a clean deletion of the old component.

## Architecture

```
\a in PTY
  → term.onBell()
  → PaneHandlers.onBell(paneId)
  → MuxStore.markBell(paneId, wsId)
  → reactive re-render
  → ● on pane tab (mux-dock) + ● on dock slot (mux-dock-bar)
```

Bell state lives in `MuxStore`. `terminal-registry.ts` wires the xterm.js callback. `mux-app.ts` provides the `onBell` handler and calls the ack methods on pane focus and workspace switch. `mux-dock` and `mux-dock-bar` consume the state reactively.

### File inventory

| File | Change |
|------|--------|
| `web/src/lib/terminal-registry.ts` | Wire `onBell` callback in `PaneHandlers` |
| `web/src/lib/state.ts` | Add bell state to `MuxStore` |
| `web/src/app.ts` | Provide `onBell`, call `ackPane`/`ackWorkspace` |
| `web/src/components/mux-dock.ts` | Render pane tab dots; add `.dv-tab` CSS overrides (min/max width); add `@media` rule hiding Dockview tabs at ≤768px |
| `web/src/components/mux-dock-bar.ts` | **New** — replaces `mux-status-bar` |
| `web/src/components/mux-status-bar.ts` | **Deleted** |
| `web/src/components/mux-title-bar.ts` | Add `mux-pane-picker` on mobile; breadcrumb hidden on desktop via CSS |
| `web/src/components/mux-pane-picker.ts` | **New** — mobile pane switcher component |

## Components

### MuxStore bell state (`web/src/lib/state.ts`)

Bell state uses a timestamp pair per entity. `lastFiredAt` records when the bell last fired; `ackedAt` records when the user last acknowledged. A bell is active when `lastFiredAt > ackedAt`.

```ts
interface BellRecord {
  lastFiredAt: number;  // ms timestamp when bell last fired
  ackedAt:     number;  // ms timestamp when user last acknowledged (0 = never)
}

_bellPanes:      Map<number, BellRecord>   // keyed by paneId
_bellWorkspaces: Map<string, BellRecord>   // keyed by workspaceId
```

Public API:

```ts
paneBellActive(paneId: number): boolean
workspaceBellActive(wsId: string): boolean

markBell(paneId: number, wsId: string): void    // sets lastFiredAt = Date.now() on both records
ackPane(paneId: number): void                    // sets ackedAt = Date.now() on pane record
ackWorkspace(wsId: string): void                 // sets ackedAt = Date.now() on workspace record
```

The two ack operations are independent: switching workspaces clears the dock dot only (`ackWorkspace`); focusing a pane clears the pane tab dot only (`ackPane`). A new bell firing after an ack always produces a fresh signal because `lastFiredAt` will exceed the old `ackedAt`.

### terminal-registry.ts (`web/src/lib/terminal-registry.ts`)

Add `onBell?: (paneId: number) => void` to the existing `PaneHandlers` interface. Wire it after `new Terminal(...)` in `ensure()`:

```ts
term.onBell(() => {
  entry.handlers.onBell?.(paneId);
});
```

Optional chaining (`?.`) means no existing caller breaks.

### mux-app.ts (`web/src/app.ts`)

In `_syncTerminals()` where terminal handlers are provided, add:

```ts
onBell: (paneId) => store.markBell(paneId, store.currentWorkspaceId)
```

> `currentWorkspaceId` must be read from the store **inside the callback at bell-fire time**, not captured as a closure variable at handler-registration time. Capturing it outside the callback means bells fired after a workspace switch are attributed to the wrong workspace.

Ack wiring:
- On pane focus event → `store.ackPane(paneId)`
- On workspace switch → `store.ackWorkspace(wsId)`

### mux-dock.ts (`web/src/components/mux-dock.ts`)

When rendering a tab title, prefix with `●` (amber) if `store.paneBellActive(paneId)` returns true. The dot appears only on the tab for the specific pane that fired the bell.

### mux-dock-bar.ts (`web/src/components/mux-dock-bar.ts`) — new

Lit component. Receives reactive inputs from `MuxStore.subscribe()`:

- `workspaces: WorkspaceInfo[]`
- `activeWorkspaceId: string`
- `bellWorkspaces` derived from `MuxStore`
- `connected: boolean`

**Layout:** flex row, 44px height, no boxes around workspace labels (touch-friendly without visual clutter). Each workspace is a `<button>` with no border/background, `padding: 0 16px`, `min-height: 44px`. Active workspace: `font-weight: 600`. Bell workspace: `●` prefix in amber — only when `workspaceBellActive(wsId)` is true AND the workspace is not the currently active workspace. Bells on the active workspace are suppressed in the dock bar (they are visible via pane tab dots above). Connection dot: `margin-left: auto` at far right. `+` button for new workspace, same behaviour as today.

**On tap:** emit `workspace-switch` event + call `store.ackWorkspace(wsId)`.

## Responsive Layout Strategy

A single CSS media query (`max-width: 768px`) switches the UI between two modes:

**Desktop (>768px):**
- Dockview renders tabs, split panes, and drag-and-drop as today
- Pane tabs auto-size between `--mux-tab-min-width` and `--mux-tab-max-width`
- Dockview's built-in horizontal scroll handles overflow when tabs exceed container width
- `mux-pane-picker` breadcrumb hidden (via CSS `display: none`)

**Mobile (≤768px):**
- Dockview tab strip hidden via CSS (`display: none` on `.dv-tabs-and-actions-container`)
- Dockview remains mounted — terminal buffers and PTY state preserved, no re-init cost
- Active pane fills 100% of the available area
- `mux-pane-picker` breadcrumb visible in the title bar

The breakpoint is CSS-only. No JS viewport detection, no store state for layout mode.

## Desktop Tab Sizing

Two new CSS tokens control pane tab width, applied as overrides to Dockview's `.dv-tab` inside `mux-dock.ts`'s static styles:

| Token | Value | Rationale |
|---|---|---|
| `--mux-tab-max-width` | `180px` | Comfortable default — fits most pane names |
| `--mux-tab-min-width` | `80px` | Fits ~5 chars + `●` + `×`; label truncates before them |

CSS:
```css
.dv-tab {
  flex: 1 1 var(--mux-tab-max-width);
  min-width: var(--mux-tab-min-width);
  max-width: var(--mux-tab-max-width);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

At `80px`, a tab `● build` becomes `● bui…×` — the bell dot and close button remain visible since truncation hits the label text first. When tabs overflow the strip even at min-width, Dockview's built-in horizontal scroll (`.dv-scrollbar-horizontal`, confirmed in dockview-core CSS) handles it. No custom overflow dropdown needed.

At ≤768px, Dockview tabs are hidden entirely — tab sizing only applies on desktop.

## Mobile Pane Switcher — mux-pane-picker

New Lit component `mux-pane-picker.ts` renders inside `mux-title-bar`. Visible only on mobile (≤768px via CSS).

**Title bar layout on mobile:**
```
muxterm          dev  ›  build  ▾
```

- Left: existing branding
- Right: `[workspace] › [pane name] ▾` — tappable breadcrumb
- `●` prefix on the active pane name only if that pane has an uncleared bell (edge case — bells normally auto-ack on pane switch)
- `▾` indicates the element is tappable

**Dropdown** (opens anchored below the title bar on tap):
- Lists all panes in the current workspace
- Each entry shows `●` prefix if `store.paneBellActive(paneId)` is true
- Active pane shows `✓` indicator
- Tapping a pane entry: closes dropdown, emits a `pane-select` custom DOM event (same event shape as `mux-dock`'s existing `pane-select`), calls `store.ackPane(paneId)`
- `mux-app.ts` handles the `pane-select` event from `mux-pane-picker` the same way it handles it from `mux-dock`: calls `store.setActivePane(paneId)` and activates the corresponding Dockview panel via `this._dv.api.getPanel(panelId).api.setActive()`. No new event handler needed — the same listener already bubbles from both sources.

**Reactive inputs** (from `MuxStore.subscribe()`):
- `panes: SessiondPaneInfo[]`
- `activePaneId: number`
- `bellPanes` derived from `MuxStore`
- `activeWorkspaceName: string`

**No new tokens** — uses existing `--mux-fg`, `--mux-accent`, `--mux-bell`, `--mux-bg`, `--mux-border`.

## Design Tokens

This feature introduces five new CSS custom properties and uses three existing ones.
The canonical definitions and values live in [DESIGN.md](../../../../DESIGN.md).

### New tokens (to be added to `web/src/lib/theme.ts`)

| Token | Usage in this feature | Proposed value |
|---|---|---|
| `--mux-bell` | Color of the `●` indicator on tabs and dock slots | `var(--mux-warn)` |
| `--mux-dock-height` | Height of the dock bar row — sets the touch target | `44px` |
| `--mux-dock-item-padding` | Horizontal padding on each workspace slot | `0 16px` |
| `--mux-dock-font-size` | Workspace label font size | `0.85rem` |
| `--mux-dock-active-weight` | Font weight for the active workspace label | `600` |

### Existing tokens consumed

| Token | Used for |
|---|---|
| `--mux-fg` | Inactive workspace label color |
| `--mux-accent` | Active workspace label color (alternative to bold weight) |
| `--mux-ok` / `--mux-error` | Connection indicator dot (carried over from status bar) |

### Bell indicator character

`●` (U+25CF BLACK CIRCLE) — prepended to the label with a 4px gap.
Chosen over an SVG icon: zero-dependency, renders in both system-ui and monospace fonts,
semantically neutral. See DESIGN.md Alternatives Considered.

## UI Sketch

```
┌──────────────────────────────────────────────────────┐
│  muxterm                                             │
├──────────────────────────────────────────────────────┤
│  agent ×  │  ● build ×  │  ● tests ×               │  ← pane tabs with dots
├──────────────────────────────────────────────────────┤
│  >                                                   │
│  _                                                   │
├──────────────────────────────────────────────────────┤
│                                                      │
│    dev        ● ci        ● infra        +       ●  │  ← dock bar (no boxes)
│                                                      │
└──────────────────────────────────────────────────────┘
```

`●` = bell active (amber). Active workspace label is bold. Connection indicator sits at the far right.

## Data Flow

1. A program writes `\a` to its PTY output.
2. xterm.js fires `term.onBell()`.
3. `terminal-registry.ts` calls `entry.handlers.onBell?.(paneId)`.
4. `mux-app.ts` handler calls `store.markBell(paneId, currentWorkspaceId)`.
5. `MuxStore` sets `lastFiredAt = Date.now()` on both the pane record and the workspace record, then notifies subscribers.
6. `mux-dock` re-renders: the affected pane tab gains a `●` prefix.
7. `mux-dock-bar` re-renders: if the workspace is not active, its label gains a `●` prefix.
8. User switches to the workspace → `ackWorkspace(wsId)` fires → dock dot clears.
9. User focuses the pane → `ackPane(paneId)` fires → pane tab dot clears.

## Error Handling

- `onBell` is optional on `PaneHandlers`; if not provided, the callback silently no-ops via optional chaining.
- `MuxStore` methods initialise missing map entries on first access so callers never need to pre-register panes or workspaces.
- Ack calls on unknown IDs are safe no-ops (nothing to clear).

## Testing Strategy

### Primary verification: DTU + Playwright (browser automation)

This is the authoritative verification for all UI changes in this feature. Unit tests do not cover visual layout, CSS breakpoints, or the bell-dot rendering pipeline adequately. Per AGENTS.md, Lit components are not unit-tested with vitest.

**Verification flow:**
1. Build muxterm binary + web assets
2. Launch in a DTU (Digital Twin Universe) — isolated container, no localhost dependency
3. Run Playwright against the DTU with two viewport profiles:

**Desktop viewport (1280×800):**
- Bell dot on pane tab: write `\a` to a background pane → verify `●` prefix on that tab
- Bell dot on dock slot: write `\a` in a background workspace → verify `●` on dock slot → switch to workspace → verify dot clears
- Tab sizing: verify tabs flex between `--mux-tab-min-width` and `--mux-tab-max-width` values
- Dockview scroll: open enough panes to overflow the tab strip → verify horizontal scroll

**Mobile viewport (390×844, triggers ≤768px breakpoint):**
- Verify Dockview tab strip is hidden
- Verify single pane fills 100% of the area
- Verify `workspace › pane ▾` breadcrumb appears in the title bar
- Tap breadcrumb → verify dropdown shows all panes with correct bell state
- Tap a pane with `●` → verify pane switches and bell dot clears
- Verify dock bar is present and workspace switching works

**Extend `/muxterm-verify` skill** with the above as named scenarios so they run automatically on every future pane/WebSocket/reconnect change.

### Unit tests (vitest — pure logic only)

Only the `MuxStore` bell state methods qualify as pure logic:
- `markBell(paneId, wsId)` → `paneBellActive` and `workspaceBellActive` both true
- `ackPane(paneId)` after `markBell` → `paneBellActive` false, `workspaceBellActive` still true
- `ackWorkspace(wsId)` after `markBell` → `workspaceBellActive` false, `paneBellActive` still true
- New `markBell` after ack → both active again (timestamp ordering)

No Lit component tests. No DOM fixture tests. Playwright is the proof.

## Open Questions

None — all design decisions were resolved during the design session.

## Out of Scope / Future

- **PWA desktop notifications** — deferred to a future session.
- **Hover preview on pane tabs** — explicitly removed from this scope.
- **OSC sequence support** beyond `\a` — not planned.
- **Bell sound** — config may be wired but implementation is deferred.
