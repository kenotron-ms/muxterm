# Dockview-Core Integration Design

This document specifies the integration of `dockview-core` v6.6.1 as the layout engine for terminal pane splits and tabs in muxterm. It covers the chosen architecture, the files being added, modified, and deleted, the reconciliation protocol between dockview and sessiond, and the known risks. This design was produced after a full dependency audit of dockview-core. Dockview was chosen because its layout algorithm is a well-tested VSCode grid port, its ResizeObserver implementation is correct, its disposable system has no leak paths in normal usage, and — crucially — its layout UX is self-contained, enabling a clean file-level isolation boundary.

---

## Goal

Integrate `dockview-core` v6.6.1 as the layout engine for terminal pane splits and tabs in muxterm. Replace the current tiling/tabbing implementation (`composition.ts`, `layout.ts`, `pane.ts`) with a single swappable file (`mux-dock.ts`). Dockview owns all layout UX. sessiond remains the source of truth for pane lifecycle.

---

## Background

The current layout stack (`layout.ts` viewport classifier + `composition.ts` tiling component + `pane.ts` Lit element) couples layout arithmetic, component lifecycle, and terminal hosting into several interdependent files. Adding split directions, tab groups, or drag-to-reorder means touching all of them. dockview-core provides all of that as a single, well-tested library, with a clean renderer interface that slots xterm.js in naturally. The integration deletes more code than it adds.

---

## Dependency Audit Summary

`dockview-core` v6.6.1 was audited before adoption:

- **Bundle size:** 66 KB gzipped (noStyle) + 9.6 KB CSS for one theme (113 KB total CSS with all 11 bundled themes — no CSS tree-shaking available)
- **Layout algorithm:** VSCode grid port — clean, well-tested
- **ResizeObserver:** Correctly implemented with integer rounding, `display:none` guard, and detached DOM guard
- **setTimeout calls:** 22 total; only 2 are genuine hacks (deferred events during `fromJSON()` deserialization — not used in our flow)
- **Global document listeners:** Temporary (sash drag only), cleaned up unconditionally
- **Disposable system:** Comprehensive; no leak paths in normal usage
- **Firefox DnD bug (#932):** Dragging non-focused tabs does not start drag on Firefox — must be tested early
- **`sashWidth = 4`:** Hardcoded in both JS and CSS — avoid spaced themes if layout serialization matters
- **Shadow DOM constraint:** The dockview container **must** be in light DOM

---

## Approach

**File-level isolation.** All dockview knowledge lives in one file (`mux-dock.ts`). Swapping the layout engine means replacing that file. No interface, no adapter layer — just convention. The file name is the contract.

---

## Architecture

```
app.ts
  │  props: panes, activePaneId, workspaceKey
  ▼
<mux-dock>  (mux-dock.ts — the single swappable file)
  │  createRenderRoot() → this  (light DOM, mandatory)
  │
  ├─ DockviewComponent  (dockview-core)
  │    │  panel lifecycle, tab UX, sash resize, DnD reorder
  │    ▼
  │   TerminalRenderer  (inner class, implements IContentRenderer)
  │        init()   → get terminal from terminalRegistry, attach xterm.js element
  │        layout() → fitAddon.fit() → reportResize() → sessiond
  │        focus()  → xterm.js terminal focus
  │        dispose()→ detach xterm.js element (terminal stays alive in registry)
  │
  └─ terminalRegistry  (module-level singleton, managed by app.ts)
```

sessiond is the source of truth. Pane lifecycle flows: sessiond `PaneAdded`/`PaneRemoved` → store → `app.ts` → props on `<mux-dock>` → reconciliation in `updated()` → `dv.addPanel()` / `panel.api.close()`.

---

## Components

### `mux-dock.ts` (added)

The single swappable file. Contains the `DockviewComponent` instance, all dockview imports, the `TerminalRenderer` inner class, and the reconciliation logic.

```ts
@customElement('mux-dock')
export class MuxDock extends LitElement {
    override createRenderRoot() { return this; }  // light DOM — non-negotiable
```

**Properties received from `app.ts`:**

| Property | Type | Description |
|---|---|---|
| `panes` | `SessiondPaneInfo[]` | Current workspace's flat pane list from the store |
| `activePaneId` | `number` | The currently active pane |
| `workspaceKey` | `string` | Opaque token that changes on workspace switch |

**Lifecycle:**

- `connectedCallback` — creates one `DockviewComponent` attached to `this`; adds `dockview-theme-dark` class
- `disconnectedCallback` — disposes the dockview instance

The dockview instance lives for the full element lifetime. Workspace switches reset its panels without recreating the instance.

```ts
this._dv = new DockviewComponent({
    parentElement: this,
    createComponent: (opts) => new TerminalRenderer(opts.id),
    createGroupControlComponent: () => null,  // no hamburger menu, no maximize button
});
```

The `createGroupControlComponent: () => null` option removes the default right-side group controls (the three-line menu and maximize button), leaving clean tab-only headers matching VS Code's aesthetic.

**Internal state:**

| Field | Type | Description |
|---|---|---|
| `_panels` | `Map<number, IDockviewPanel>` | paneId → dockview panel, used for reconciliation |
| `_settingActive` | `boolean` | Guard flag preventing the active-pane feedback loop |

---

### `TerminalRenderer` (inner class in `mux-dock.ts`)

Implements dockview's `IContentRenderer`. A plain class — not a Lit element — because dockview manages its container lifecycle.

**`element`** — a bare `div`. dockview owns it as the panel's DOM container. xterm.js renders its canvas directly into this div. No shadow root.

**`init(params)`:**
- `params.api.id` gives the pane ID string → parse to number. This is the same value passed as `opts.id` to the `TerminalRenderer` constructor — dockview preserves the panel id through the component lifecycle.
- Call `terminalRegistry.get(paneId)` to retrieve the already-ensured terminal
- Append the xterm.js `element` to `this.element`
- If the terminal is not in the registry when `init()` is called, store the pane ID and attempt mount on the next `layout()` call. If still absent on the second call, log a warning and leave unmounted. In practice this path should never be reached: the reconciler calls `this._dv.addPanel()` only after `PaneAdded` arrives from sessiond, which means `terminalRegistry.ensure()` has already run in `app.ts` `willUpdate`.

**`layout(width, height)`:**
- Called by dockview on every panel resize
- Calls `fitAddon.fit()` on the xterm.js instance
- FitAddon measures the container, calculates cols/rows, fires `onResize` → `reportResize(paneId, cols, rows)` → sessiond
- Replaces the `ResizeObserver` that `<mux-pane>` previously owned
- dockview only calls `layout()` on visible, mounted panels — `fit()` always has valid dimensions

**`focus()`:** Called by dockview's internal focus tracking when focus moves between panels programmatically. The `onDidActivePanelChange` handler in `MuxDock` independently calls `terminalRegistry.get(paneId)?.focus()` for user-initiated tab switches. Both paths may fire for the same event — the double-call is intentional belt-and-suspenders and idempotent on xterm.js.

**`dispose()`:**
- Removes the xterm.js element from `this.element`
- Does **not** destroy the terminal — the PTY is still alive in sessiond
- Terminal stays in `terminalRegistry`, ready for remounting if the pane recovers

---

### `app.ts` (modified)

- Replace `<mux-composition>` with `<mux-dock>`
- Remove the `arrange()` call from `willUpdate` — dockview handles layout internally
- Props passed to `<mux-dock>` simplify to: `panes`, `activePaneId`, `workspaceKey` — no `arrangement` object
- Continue to call `terminalRegistry.ensure(paneId, { onInput, onResize })` for each pane in `willUpdate` — terminal lifecycle ownership stays in `app.ts`. `onInput: (data: string) => void` — invoked with raw bytes from the xterm.js terminal; calls `socket.sendPaneInput(paneId, data)` to forward keystrokes to the PTY. `onResize: (cols, rows) => void` — calls `reportResize(paneId, cols, rows)` which sends a resize frame to sessiond.

---

### Files Deleted

| File | Reason |
|---|---|
| `web/src/lib/layout.ts` | Viewport classifier and `arrange()` engine — dockview owns all layout logic now |
| `web/src/components/composition.ts` | The tiling/tabbing Lit component — replaced by `<mux-dock>` |
| `web/src/components/pane.ts` | The `<mux-pane>` Lit element — its responsibilities (xterm.js attach, resize forwarding, keyboard input) move into `TerminalRenderer`; a Lit element is no longer the right primitive |

---

## Data Flow

### Pane creation (user-initiated split)

```
User clicks split button
  → socket.createPane()
  → sessiond confirms with PaneAdded
  → store updates
  → app.ts re-renders, passes updated panes prop to <mux-dock>
  → updated() runs reconciliation
  → this._dv.addPanel() called
  → TerminalRenderer.init() attaches xterm.js
```

Dockview DnD **rearranges existing panels only** — it does not create new ones. There is no built-in "create panel" gesture. `onDidAddPanel` is therefore not used to detect user-initiated splits. New panels exist only because `dv.addPanel()` was explicitly called during reconciliation.

### Pane removal

```
sessiond PaneRemoved
  → store updates
  → app.ts re-renders, passes updated panes prop
  → updated() diffs _panels map
  → panel.api.close() called
  → TerminalRenderer.dispose() removes xterm.js element from container
  → terminal stays alive in terminalRegistry
```

### Panel resize

```
User drags sash
  → dockview updates panel dimensions
  → TerminalRenderer.layout(width, height) called
  → fitAddon.fit() calculates cols/rows
  → onResize callback fires
  → reportResize(paneId, cols, rows) sent to sessiond
```

---

## Reconciliation: sessiond ↔ Dockview

Reconciliation runs in Lit's `updated()` lifecycle hook when `panes`, `activePaneId`, or `workspaceKey` changes.

### Workspace switch (`workspaceKey` changed)

1. Set `_settingActive = true` for the entire reset operation
2. For each panel in `_panels`: call `panel.api.close()` → triggers `TerminalRenderer.dispose()` → removes xterm.js element from container, leaves terminal alive in registry
3. Clear `_panels` map
4. Add panels for the new workspace's panes in the order they appear in the `panes` array prop as delivered by the store, which preserves sessiond insertion order (single default tab group)
5. Set active panel
6. Set `_settingActive = false` (in a `finally` block)

### Pane list changed (same workspace)

- Diff `_panels` map against incoming `panes` array
- Pane in `panes` but not in `_panels` → `this._dv.addPanel({ id: String(paneId), component: 'terminal' })`, add to `_panels`. New panels are added to the currently active tab group as a new tab. If no active group exists (e.g., during initial population), dockview creates one.
- Pane in `_panels` but not in `panes` → `panel.api.close()`, remove from `_panels`

### Active pane sync

`onDidActivePanelChange` fires both on user clicks and on programmatic `panel.api.setActive()` calls. Without a guard this creates a feedback loop:

```
activePaneId prop changes
  → updated() calls panel.api.setActive()
  → onDidActivePanelChange fires
  → emits pane-select
  → app.ts updates activePaneId
  → another render
  → loop
```

**Fix:** Set `_settingActive = true` before calling `panel.api.setActive()`. The `onDidActivePanelChange` handler skips dispatching `pane-select` when `_settingActive` is true.

**When `onDidActivePanelChange` fires with `_settingActive = false` (user-initiated):**
1. `terminalRegistry.get(paneId)?.focus()` — only this terminal gets keyboard focus
2. Emit `pane-select` with `{ paneId }` → `app.ts` updates `store.activePaneId`

Only one terminal is focused at a time. All others receive no keyboard focus.

---

## Workspace Switching

One `DockviewComponent` instance lives for the full `<mux-dock>` element lifetime. Workspace switches reset its panels.

**Scrollback is preserved across workspace switches.** `TerminalRenderer.dispose()` removes the xterm.js element from the dockview container but leaves the terminal in `terminalRegistry`. When switching back to a previous workspace, `TerminalRenderer.init()` retrieves the same terminal instance (with the same scrollback buffer) and mounts it in the new container.

**Layout is not preserved per workspace** (initial version). When returning to workspace A, panes are added in a single default tab group in the order they appear in the `panes` array prop as delivered by the store, which preserves sessiond insertion order. Per-workspace layout memory can be added later without changing the public interface.

The `_settingActive` flag governs the entire workspace switch operation. During reset, dockview fires `onDidActivePanelChange` events as panels are added. These are suppressed until the reset completes.

---

## CSS and Theming

**Install:**
```bash
cd web && npm install dockview-core
```

**CSS import** — in `mux-dock.ts`, not `app.ts` or `main.ts`. All dockview knowledge, including styles, lives in the swappable file:
```ts
import 'dockview-core/dist/styles/dockview-core.css';
```

Vite processes this as a module side effect and injects it into the global stylesheet. No `vite.config.ts` changes needed.

**Theme class** added in `connectedCallback`:
```ts
this.classList.add('dockview-theme-dark');
```

**Tokyo Night overrides** via Lit `static styles` (light DOM, so these inject into the document):
```ts
static styles = css`
    .dv-dockview {
        --dv-background-color: #1a1b26;
        --dv-tabs-container-scrollbar-color: #1f2335;
        --dv-activegroup-visiblepanel-tab-background-color: #1e2030;
        --dv-activegroup-hiddenpanel-tab-background-color: #1a1b26;
        --dv-separator-border: 1px solid #1f2335;
        --dv-paneview-active-outline-color: #7aa2f7;
    }
`;
```

These values match the Tokyo Night palette already used throughout muxterm's existing component styles.

The 113 KB CSS bundle includes all 11 bundled themes — no CSS tree-shaking is available from dockview-core. The cost is acceptable for a complete layout engine.

---

## Error Handling

| Scenario | Handling |
|---|---|
| Terminal not yet in registry at `init()` time (timing gap before `PaneAdded` confirms) | Store pane ID and attempt mount on the next `layout()` call. If still absent on the second call, log a warning and leave unmounted. In practice this path should never be reached: the reconciler calls `this._dv.addPanel()` only after `PaneAdded` arrives from sessiond, which means `terminalRegistry.ensure()` has already run in `app.ts` `willUpdate`. |
| `_settingActive` not cleared after exception | Always clear in a `finally` block |
| `panel.api.close()` during workspace reset fires `onDidActivePanelChange` | Suppressed by `_settingActive` guard |
| `TerminalRenderer.dispose()` called for a pane whose terminal was never attached | No-op — element removal is idempotent |

---

## Known Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Firefox DnD bug (#932): non-focused tab drag fails silently | High if Firefox users exist | Test on Firefox early before committing to this library |
| `_settingActive` feedback loop if flag not cleared on exception | High | Always clear in `finally` block — never inline |
| `getGridLocation()` DOM walk fails with unexpected wrapper elements | Medium | Keep dockview container flat — no extra Lit shadow host above `<mux-dock>` |
| `sashWidth = 4` hardcoded in JS and CSS, drifts with spaced themes | Low | Use non-spaced themes only |
| Layout not preserved per workspace | Low | Accepted for initial version; localStorage serialization is addable later |
| 10 unused CSS themes bundled, no tree-shaking | Low | Acceptable given the overall dependency value |

---

## Testing Strategy

- **Smoke test:** Open muxterm, create 3 panes, drag tabs to reorder — verify sessiond state unchanged, verify `onDidActivePanelChange` fires exactly once per user tab click (use browser DevTools → Performance → Event Log or add a temporary counter in the handler)
- **Firefox DnD:** Test tab drag on Firefox before merging; if tab drag fails on Firefox: document the failure, file it against issue #932, and assess whether the pointer-events DnD backend is sufficient for muxterm's use case before the branch merges.
- **Workspace switch:** Switch workspaces 5 times, switch back — verify scrollback buffer intact in all terminals
- **Resize:** Drag sash, verify `reportResize` fires with correct cols/rows, verify PTY output wraps at new width
- **Pane removal:** Close a pane from sessiond, verify dockview panel disappears cleanly, verify no orphan terminals
- **Active pane sync:** Click tabs rapidly — verify no `pane-select` storm in `app.ts`, verify `_settingActive` guard holds
- **Timing gap:** Open a workspace where `PaneAdded` arrives after `TerminalRenderer.init()` — verify retry path mounts terminal correctly

---

## Open Questions

None. All questions were resolved during the design session.

---

## Future Work (Out of Scope)

- **Per-workspace layout persistence** — serialize dockview state to `localStorage` keyed by `workspaceKey`; addable without changing the public interface
- **Tab rename** — show pane title or process name in the tab instead of pane ID
- **Floating panel support** — explicitly excluded; most dockview bugs live in the floating panel code path
- **Firefox DnD workaround** — if Firefox becomes a supported target, investigate `mousedown` → `dragstart` shim
