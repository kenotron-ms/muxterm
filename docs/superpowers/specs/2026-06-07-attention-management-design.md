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
| `web/src/components/mux-dock.ts` | Render pane tab dots |
| `web/src/components/mux-dock-bar.ts` | **New** — replaces `mux-status-bar` |
| `web/src/components/mux-status-bar.ts` | **Deleted** |

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
onBell: (paneId) => store.markBell(paneId, currentWorkspaceId)
```

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

**Layout:** flex row, 44px height, no boxes around workspace labels (touch-friendly without visual clutter). Each workspace is a `<button>` with no border/background, `padding: 0 16px`, `min-height: 44px`. Active workspace: `font-weight: 600`. Bell workspace: `●` prefix in amber. Connection dot: `margin-left: auto` at far right. `+` button for new workspace, same behaviour as today.

**On tap:** emit `workspace-switch` event + call `store.ackWorkspace(wsId)`.

## Design Tokens

This feature introduces four new CSS custom properties and uses three existing ones.
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

### Unit tests (vitest — pure logic)

- `MuxStore.markBell(paneId, wsId)` → `paneBellActive` and `workspaceBellActive` both return `true`.
- `ackPane(paneId)` after `markBell` → `paneBellActive` returns `false`, `workspaceBellActive` still `true`.
- `ackWorkspace(wsId)` after `markBell` → `workspaceBellActive` returns `false`, `paneBellActive` still `true`.
- New `markBell` after an ack → both become active again (timestamp ordering).

### E2E tests (Playwright)

- **Pane tab dot:** fire bell in a background pane; verify the tab text includes `●`; focus the pane; verify the `●` is gone.
- **Dock dot:** fire bell in a background workspace; verify the dock label includes `●`; switch to that workspace; verify the `●` is gone.
- **Touch target:** verify dock bar height ≥ 44px.

## Open Questions

None — all design decisions were resolved during the design session.

## Out of Scope / Future

- **PWA desktop notifications** — deferred to a future session.
- **Hover preview on pane tabs** — explicitly removed from this scope.
- **OSC sequence support** beyond `\a` — not planned.
- **Bell sound** — config may be wired but implementation is deferred.
