# Dockview-Core Integration Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Replace `composition.ts`, `layout.ts`, and `pane.ts` with a single `mux-dock.ts` file backed by `dockview-core`, so dockview owns all layout UX while sessiond remains source of truth for pane lifecycle.

**Architecture:** A single light-DOM Lit element (`MuxDock`) holds one `DockviewComponent` instance for its entire lifetime. An inner class `TerminalRenderer` bridges dockview's panel lifecycle to `terminalRegistry` and xterm.js. Workspace switches reset dockview's panels without recreating the instance; scrollback is preserved because `terminalRegistry` keeps terminals alive across detach/attach cycles.

**Tech Stack:** TypeScript, Lit 3, dockview-core v6.6.1, xterm.js (via existing `terminalRegistry`), Vite.

---

## Before You Start: Key Facts

- **No frontend tests.** The project's `AGENTS.md` says "Frontend (TypeScript/Lit/web): Write NO tests." Do not write any `describe()`/`it()`/`expect()` blocks. Do not run `npm test`.
- **Validation cycle:** `cd web && npm run check:fast` (oxlint + tsgo type check, ~3s). Run `npm run build` only at the Task 8 milestone.
- **`store.setActivePane(paneId)`** — note the method name; it is NOT `setActivePaneId`.
- **`store.activePaneId`** — getter exists, returns the active pane's ID.
- **`terminalRegistry` has no `isEnsured()` method.** Use `terminalRegistry.getTerminal(paneId) !== null` to check if a pane is in the registry.
- **`createRenderRoot() { return this; }` on `MuxDock` is MANDATORY.** Without light DOM, dockview CSS is invisible and drag-and-drop breaks silently.
- **`_settingActive` flag MUST use `try/finally`.** If it stays `true` permanently, all user tab-clicks become silent no-ops.

---

## Task 1: Install dockview-core

**Files:**
- Modify: `web/package.json` (npm will update this automatically)

**Step 1: Install the package**

```bash
cd /home/ken/workspace/muxterm/web && npm install dockview-core
```

**Step 2: Verify the install**

Open `web/package.json` and confirm `"dockview-core"` appears in `"dependencies"`.

**Step 3: Run fast check**

```bash
cd /home/ken/workspace/muxterm/web && npm run check:fast
```

Expected: PASS (no imports reference dockview yet, so nothing to type-check against it).

**Step 4: Commit**

```bash
cd /home/ken/workspace/muxterm && git add web/package.json web/package-lock.json && git commit -m "chore(web): install dockview-core"
```

---

## Task 2: Create `mux-dock.ts` shell

**Files:**
- Create: `web/src/components/mux-dock.ts`

**Step 1: Write the shell file**

Create `web/src/components/mux-dock.ts` with this exact content:

```typescript
import { LitElement, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type {
  IDockviewPanel,
  IContentRenderer,
  IContentRendererInitParameters,
} from 'dockview-core';
import { DockviewComponent } from 'dockview-core';
import 'dockview-core/dist/styles/dockview-core.css';
import { terminalRegistry } from '../lib/terminal-registry.js';
import type { SessiondPaneInfo } from '../types.js';

// ---------------------------------------------------------------------------
// TerminalRenderer — bridges dockview panel lifecycle to terminalRegistry
// ---------------------------------------------------------------------------

class TerminalRenderer implements IContentRenderer {
  readonly element: HTMLElement;
  private readonly _paneId: number;
  // True while we're waiting for the terminal to appear in the registry.
  private _pendingMount = false;

  constructor(id: string) {
    this._paneId = parseInt(id, 10);
    this.element = document.createElement('div');
    this.element.style.cssText = 'width:100%;height:100%;overflow:hidden;';
  }

  init(_params: IContentRendererInitParameters): void {
    if (terminalRegistry.getTerminal(this._paneId) !== null) {
      terminalRegistry.attach(this._paneId, this.element);
    } else {
      // Registry hasn't been populated yet — retry on the first layout() call.
      // In practice this path should never be reached: reconciliation calls
      // addPanel() only after PaneAdded arrives from sessiond, which means
      // terminalRegistry.ensure() has already run in app.ts willUpdate().
      this._pendingMount = true;
      console.warn(`[mux-dock] init(): pane ${this._paneId} not in registry yet, retrying on layout()`);
    }
  }

  layout(_width: number, _height: number): void {
    if (this._pendingMount) {
      if (terminalRegistry.getTerminal(this._paneId) !== null) {
        terminalRegistry.attach(this._paneId, this.element);
        this._pendingMount = false;
      } else {
        console.warn(`[mux-dock] layout() retry: pane ${this._paneId} still not in registry`);
        return;
      }
    }
    // attach() already installed a ResizeObserver with 50ms debounce;
    // calling fitIfVisible() here is the direct-resize path from dockview.
    // Both paths are idempotent via the lastCols/lastRows gate in the registry.
    terminalRegistry.fitIfVisible(this._paneId);
  }

  focus(): void {
    terminalRegistry.focus(this._paneId);
  }

  dispose(): void {
    // Removes xterm.js element from this.element. Does NOT destroy the terminal
    // — the PTY is still alive in sessiond; the terminal stays in terminalRegistry
    // with its full scrollback, ready for re-mount if the pane is shown again.
    terminalRegistry.detach(this._paneId);
  }
}

// ---------------------------------------------------------------------------
// MuxDock — the single swappable file. All dockview knowledge lives here.
// ---------------------------------------------------------------------------

@customElement('mux-dock')
export class MuxDock extends LitElement {
  /**
   * Light DOM: mandatory for dockview. Shadow DOM hides dockview's CSS and
   * breaks its internal DnD hit-testing (getGridLocation() DOM walk fails).
   * These styles inject into the document head instead of a shadow root.
   */
  override createRenderRoot() {
    return this;
  }

  static styles = css`
    /* Ensure the element fills its flex parent (mirrors :host on composition) */
    mux-dock {
      display: block;
      flex: 1;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    /* Tokyo Night overrides for dockview's CSS custom properties */
    .dv-dockview {
      --dv-background-color: #1a1b26;
      --dv-tabs-container-scrollbar-color: #1f2335;
      --dv-activegroup-visiblepanel-tab-background-color: #1e2030;
      --dv-activegroup-hiddenpanel-tab-background-color: #1a1b26;
      --dv-separator-border: 1px solid #1f2335;
      --dv-paneview-active-outline-color: #7aa2f7;
    }
  `;

  /** Current workspace's flat pane list (positive IDs only; negatives are optimistic placeholders). */
  @property({ attribute: false })
  panes: SessiondPaneInfo[] = [];

  /** The currently active pane ID (client-local, no sessiond equivalent). */
  @property({ type: Number })
  activePaneId = 0;

  /**
   * Opaque token that changes on workspace switch. When this changes,
   * updated() tears down all panels and rebuilds for the new workspace.
   */
  @property()
  workspaceKey = '';

  private _dv: DockviewComponent | null = null;
  /** paneId → dockview panel, used by the reconciler. */
  private _panels = new Map<number, IDockviewPanel>();
  /**
   * Guard flag. Set to true during all programmatic panel mutations so that
   * onDidActivePanelChange does not re-emit pane-select events and create
   * a feedback loop. ALWAYS cleared in a finally block.
   */
  private _settingActive = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.classList.add('dockview-theme-dark');

    this._dv = new DockviewComponent({
      parentElement: this,
      createComponent: (opts) => new TerminalRenderer(opts.id),
      // Remove the three-line hamburger menu and maximize button — clean
      // VS Code-style tab-only headers.
      createGroupControlComponent: () => null,
    });

    // Wire up user-initiated tab switches. The _settingActive guard suppresses
    // this handler during programmatic setActive() calls to prevent the loop:
    //   activePaneId prop changes → setActive() → onDidActivePanelChange
    //   → pane-select → app.ts updates activePaneId → another render → loop
    this._dv.onDidActivePanelChange((event) => {
      if (this._settingActive) return;
      const panel = event.panel;
      if (!panel) return;
      const paneId = parseInt(panel.id, 10);
      terminalRegistry.focus(paneId);
      this.dispatchEvent(
        new CustomEvent('pane-select', {
          bubbles: true,
          composed: true,
          detail: { paneId },
        }),
      );
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._dv?.dispose();
    this._dv = null;
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (!this._dv) return;

    // --- Workspace switch: full panel reset ---
    // workspaceKey changes when the user switches workspaces. We close all
    // existing panels and add fresh ones for the new workspace. Terminals stay
    // alive in terminalRegistry so scrollback is preserved on switch-back.
    if (changed.has('workspaceKey')) {
      this._settingActive = true;
      try {
        for (const panel of this._panels.values()) {
          panel.api.close();
        }
        this._panels.clear();
        for (const pane of this.panes.filter((p) => p.paneId >= 0)) {
          const panel = this._dv.addPanel({
            id: String(pane.paneId),
            component: 'terminal',
          });
          this._panels.set(pane.paneId, panel);
        }
        const active = this._panels.get(this.activePaneId);
        if (active) active.api.setActive();
      } finally {
        this._settingActive = false;
      }
      return; // activePaneId and panes already handled above
    }

    // --- Pane list diff: same workspace, panes added or removed ---
    if (changed.has('panes')) {
      const incoming = new Set(
        this.panes.filter((p) => p.paneId >= 0).map((p) => p.paneId),
      );
      // Remove panels whose panes are gone
      for (const [paneId, panel] of this._panels) {
        if (!incoming.has(paneId)) {
          panel.api.close();
          this._panels.delete(paneId);
        }
      }
      // Add panels for new panes
      for (const pane of this.panes.filter((p) => p.paneId >= 0)) {
        if (!this._panels.has(pane.paneId)) {
          const panel = this._dv.addPanel({
            id: String(pane.paneId),
            component: 'terminal',
          });
          this._panels.set(pane.paneId, panel);
        }
      }
    }

    // --- Active pane sync ---
    // Programmatically activate the panel when activePaneId changes from outside
    // (e.g. app.ts responds to a pane-select event from a different source).
    if (changed.has('activePaneId')) {
      const panel = this._panels.get(this.activePaneId);
      if (panel && !panel.api.isActive) {
        this._settingActive = true;
        try {
          panel.api.setActive();
        } finally {
          this._settingActive = false;
        }
      }
    }
  }

  /**
   * Read the visible terminal buffer for a pane.
   * Used by playwright browser-operator for xterm.js buffer capture verification:
   *
   *   const content = await page.evaluate((paneId) => {
   *     const dock = document.querySelector('mux-dock');
   *     return dock?.getTerminalContent(paneId) ?? '';
   *   }, paneId);
   */
  getTerminalContent(paneId: number): string {
    const terminal = terminalRegistry.getTerminal(paneId);
    if (!terminal) return '';
    const buf = terminal.buffer.active;
    const lines: string[] = [];
    for (let y = buf.viewportY; y < buf.viewportY + terminal.rows; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-dock': MuxDock;
  }
}
```

> **Note:** `getTerminalContent` is the playwright xterm.js capture bridge — it replaces the `getVisibleContent()` method that lived on `<mux-pane>`.

**Step 2: Run fast check**

```bash
cd /home/ken/workspace/muxterm/web && npm run check:fast
```

Expected: PASS with no errors. If there are type errors from dockview-core (e.g. `IContentRendererInitParameters` doesn't exist under that exact name), check the dockview-core type exports:

```bash
grep -r "IContentRenderer" /home/ken/workspace/muxterm/web/node_modules/dockview-core/dist/esm/ | head -20
```

Adjust the import names to match what dockview-core v6 actually exports.

**Step 3: Commit**

```bash
cd /home/ken/workspace/muxterm && git add web/src/components/mux-dock.ts && git commit -m "feat(web): add mux-dock.ts shell with TerminalRenderer and reconciler"
```

---

## Task 3: Update `app.ts` — swap composition imports

**Files:**
- Modify: `web/src/app.ts`

**Step 1: Remove the layout.js import (line 11)**

Find and remove this exact line:

```typescript
import { arrange, viewportClassFor, type Arrangement } from './lib/layout.js';
```

**Step 2: Remove the pane.js import (line 16)**

Find and remove this exact line:

```typescript
import './components/pane.js';
```

**Step 3: Replace the composition.js import (line 17)**

Change:

```typescript
import './components/composition.js';
```

To:

```typescript
import './components/mux-dock.js';
```

**Step 4: Run fast check**

```bash
cd /home/ken/workspace/muxterm/web && npm run check:fast
```

Expected: Errors for uses of `_arrangement`, `arrange`, `Arrangement`, `viewportClassFor`, `_viewportWidth`, `_onWindowResize`, and the `<mux-composition>` template. These are intentional — they will be fixed in the next steps.

---

## Task 4: Update `app.ts` — remove viewport tracking and arrangement

**Files:**
- Modify: `web/src/app.ts`

**Step 1: Remove the `_viewportWidth` state field**

Find and remove:

```typescript
  @state()
  _viewportWidth = typeof window !== 'undefined' ? window.innerWidth || 1024 : 1024;
```

**Step 2: Remove the `_onWindowResize` handler**

Find and remove:

```typescript
  /** Track the live viewport width so the responsive arrangement reflows. */
  private _onWindowResize = (): void => {
    const w = window.innerWidth || 1024;
    if (w !== this._viewportWidth) this._viewportWidth = w;
  };
```

**Step 3: Remove the window resize listener from `connectedCallback`**

Find and remove this line inside `connectedCallback`:

```typescript
    window.addEventListener('resize', this._onWindowResize);
```

**Step 4: Remove the window resize listener from `disconnectedCallback`**

Find and remove this line inside `disconnectedCallback`:

```typescript
    window.removeEventListener('resize', this._onWindowResize);
```

**Step 5: Remove the `_arrangement()` method**

Find and remove the entire method:

```typescript
  /** Compute the current arrangement for the measured viewport class. */
  private _arrangement(): Arrangement {
    if (this._controller) {
      return this._controller.currentArrangement(this._viewportWidth);
    }
    return arrange(store.composition, viewportClassFor(this._viewportWidth));
  }
```

**Step 6: Run fast check**

```bash
cd /home/ken/workspace/muxterm/web && npm run check:fast
```

Expected: Remaining errors should only be about `<mux-composition>` and `arrangement` variable in render(). Those are fixed in Task 5.

---

## Task 5: Update `app.ts` — replace `<mux-composition>` with `<mux-dock>`

**Files:**
- Modify: `web/src/app.ts`

**Step 1: Update the render() method**

In `render()`, find and remove this line:

```typescript
    const arrangement = this._arrangement();
```

Then find the `<mux-composition>` template block:

```typescript
        : html`
            <mux-composition
              .arrangement="${arrangement}"
              workspaceKey="${store.attached ?? ''}"
              @pane-select="${this._onActivePane}"
              @pane-focus="${this._onActivePane}"
            ></mux-composition>
          `}
```

Replace it with:

```typescript
        : html`
            <mux-dock
              .panes="${panes}"
              .activePaneId="${store.activePaneId}"
              workspaceKey="${store.attached ?? ''}"
              @pane-select="${this._onActivePane}"
            ></mux-dock>
          `}
```

Notes on what changed:
- `.arrangement` is gone — dockview owns all layout internally
- `.panes` is the same `panes` local variable already computed just above: `const panes = store.panes.filter((p) => p.paneId >= 0);`
- `.activePaneId` comes from `store.activePaneId`
- `@pane-focus` is removed — dockview fires `onDidActivePanelChange` on mouse interaction internally; `mux-dock` handles it and emits `pane-select`
- `@pane-select` stays — wired to the same `_onActivePane` handler, which calls `store.setActivePane(e.detail.paneId)`

**Step 2: Run fast check**

```bash
cd /home/ken/workspace/muxterm/web && npm run check:fast
```

Expected: PASS with no errors.

**Step 3: Commit**

```bash
cd /home/ken/workspace/muxterm && git add web/src/app.ts && git commit -m "feat(web): wire mux-dock into app.ts, remove composition/layout imports"
```

---

## Task 6: Delete old source files

**Files:**
- Delete: `web/src/lib/layout.ts`
- Delete: `web/src/components/composition.ts`
- Delete: `web/src/components/pane.ts`

**Step 1: Delete the source files**

```bash
rm /home/ken/workspace/muxterm/web/src/lib/layout.ts
rm /home/ken/workspace/muxterm/web/src/components/composition.ts
rm /home/ken/workspace/muxterm/web/src/components/pane.ts
```

**Step 2: Run fast check**

```bash
cd /home/ken/workspace/muxterm/web && npm run check:fast
```

Expected: Errors about broken imports in test files — those are cleaned up in Task 7.

---

## Task 7: Delete test files that reference deleted sources

**Files:**
- Delete: `web/src/components/composition.test.ts`
- Delete: `web/src/__tests__/composition.test.ts`
- Delete: `web/src/__tests__/layout.test.ts`
- Delete: `web/src/__tests__/pane.test.ts`

These test files import from the source files deleted in Task 6. With the sources gone, their imports produce type errors that break `check:fast`.

**Step 1: Delete the test files**

```bash
rm /home/ken/workspace/muxterm/web/src/components/composition.test.ts
rm /home/ken/workspace/muxterm/web/src/__tests__/composition.test.ts
rm /home/ken/workspace/muxterm/web/src/__tests__/layout.test.ts
rm /home/ken/workspace/muxterm/web/src/__tests__/pane.test.ts
```

**Step 2: Check for any remaining references to deleted files**

```bash
grep -r "from.*layout\|from.*composition\|from.*pane\|import.*pane\.js\|import.*composition\.js\|import.*layout\.js" \
  /home/ken/workspace/muxterm/web/src --include="*.ts" -l
```

If any files appear that weren't deleted above, open them and remove or fix the broken imports. Common suspects: `__tests__/arrangement-store.test.ts` (may import `Arrangement` or `arrange` from layout.ts).

**Step 3: Run fast check**

```bash
cd /home/ken/workspace/muxterm/web && npm run check:fast
```

Expected: PASS with no errors.

**Step 4: Commit**

```bash
cd /home/ken/workspace/muxterm && git add -A && git commit -m "feat(web): replace composition stack with dockview-core"
```

---

## Task 8: Full build gate

**Files:** None created or modified — this is a verification milestone.

**Step 1: Run the full build**

```bash
cd /home/ken/workspace/muxterm/web && npm run build
```

`npm run build` runs `tsc --noEmit && vite build`. This is stricter than `check:fast` because it uses the full TypeScript compiler (not tsgo). Fix any errors it surfaces.

**Common build issues and fixes:**

- *"Property 'isActive' does not exist on type 'IDockviewPanelApi'"* — check the actual dockview-core type for the panel active state. It may be `panel.api.isActive` or a different property. Check with: `grep -r "isActive" /home/ken/workspace/muxterm/web/node_modules/dockview-core/dist/esm/ | head -10`
- *"createGroupControlComponent" type mismatch* — dockview-core v6 may want `() => null | SomeType`. If it rejects `null`, try `() => undefined` or cast: `createGroupControlComponent: () => null as unknown as GroupviewPanelHeaderPart`
- *CSS import error* — if Vite can't find `dockview-core/dist/styles/dockview-core.css`, check the actual path: `ls /home/ken/workspace/muxterm/web/node_modules/dockview-core/dist/styles/`

Expected: build succeeds and produces output in `web/dist/`.

**Step 2: Build the Go backend (regression guard)**

```bash
cd /home/ken/workspace/muxterm && go build -o bin/muxterm ./cmd/muxterm
```

Expected: compiles cleanly. This confirms the backend wasn't accidentally broken.

**Step 3: Commit**

```bash
cd /home/ken/workspace/muxterm && git add -A && git commit -m "chore(web): build gate passes after dockview integration"
```

---

## Task 9: Browser verification via playwright + xterm.js buffer capture

**Goal:** Prove the integration actually works for a user by running commands in real terminals and reading the buffer.

**Rebuild and restart serve:**

```bash
cd /home/ken/workspace/muxterm
cd web && npm run build && cd ..
go build -o bin/muxterm ./cmd/muxterm
# restart serve (kill existing, start fresh)
```

**Use browser-operator agent with these exact verification scenarios:**

Navigate to https://muxterm.ampbox.io, hard reload.

**Scenario 1 — Terminal renders and responds:**
- Type `echo mux-dock-works` in the terminal, press Enter
- Read buffer: `dock?.getTerminalContent(activePaneId)`
- Expected: buffer contains `mux-dock-works`

**Scenario 2 — Create second pane (split):**
- Click the split/new-pane button
- Wait for new tab to appear in dockview
- Verify two tabs visible, new tab is active
- Type `echo pane2` in the new terminal, read buffer
- Expected: buffer contains `pane2` in the NEW pane, not the original

**Scenario 3 — Click between tabs (active pane sync):**
- Click the first tab
- Type `echo back-to-pane1`, read buffer from pane 1
- Expected: buffer contains `back-to-pane1` — confirms keyboard went to the right terminal, not stuck on pane 2

**Scenario 4 — Drag tab to reorder:**
- Drag tab 2 to the left of tab 1 (reorder without creating new pane)
- Expected: tabs reorder, no errors in console, terminals still work

**Scenario 5 — Workspace switch + scrollback preserved:**
- In workspace 1, type `echo ws1-marker`, read buffer to confirm
- Switch to workspace 2
- Type `echo ws2-marker`, confirm
- Switch back to workspace 1
- Read buffer: expected `ws1-marker` still visible in scrollback

**Scenario 6 — Close a pane:**
- Close one tab via the X button
- Expected: tab disappears, remaining tab active, no "error" state, no JS errors

**Firefox DnD check:**
- Run scenario 4 (drag tab) specifically in Firefox
- Document result: PASS or FAIL against dockview issue #932
- If FAIL: log it, do not block merge

**Pass criteria:**
- All echo commands produce correct output in the correct pane buffer
- No JS console errors during any scenario
- No "no workspace" or "error" state appears
- `onDidActivePanelChange` does not fire more than once per user tab click (add temporary counter if needed to verify)

**Commit:**

```bash
git add -A
git commit -m "feat(web): integrate dockview-core — tabs, splits, sash resize"
```

---

## Checklist

| Task | What it does |
|---|---|
| 1 | `npm install dockview-core` |
| 2 | Create `mux-dock.ts` — full `MuxDock` element + `TerminalRenderer` |
| 3 | `app.ts` — swap imports (remove pane/composition/layout, add mux-dock) |
| 4 | `app.ts` — remove `_viewportWidth`, `_onWindowResize`, `_arrangement()` |
| 5 | `app.ts` — replace `<mux-composition>` template with `<mux-dock>` |
| 6 | Delete `layout.ts`, `composition.ts`, `pane.ts` |
| 7 | Delete broken test files; verify no dangling imports |
| 8 | Full `npm run build` + `go build` gate |
| 9 | Browser verification via playwright + xterm.js buffer capture |
