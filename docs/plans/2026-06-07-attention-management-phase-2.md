# Attention Management — Phase 2: Desktop UI

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Show bell dots on Dockview pane tabs and replace the old status bar with a new dock bar that shows workspace slots with per-slot bell indicators.
**Architecture:** `mux-dock.ts` gets `_refreshBellTitles()` that rebuilds tab content DOM directly; CSS vars control dot color. New `mux-dock-bar.ts` subscribes to the store independently and reads `store.workspaceBellActive()` in its render. `app.ts` swaps the old status bar for the dock bar.
**Tech Stack:** TypeScript, Lit, Dockview (existing), CSS custom properties. No new dependencies.

**Prerequisites:** Phase 1 must be complete. The `MuxStore` bell methods and `onBell` handler in `app.ts` must already exist.

---

## Task 1: Add bell dots and CSS overrides to `mux-dock.ts`

**Files:**
- Modify: `web/src/components/mux-dock.ts`

### Step 1: Add the `store` import

Open `web/src/components/mux-dock.ts`. The current imports end around line 10. Add the store import after the existing imports:

```ts
import { store } from '../state.js';
```

### Step 2: Add the `_refreshBellTitles()` method

Add this private method to the `MuxDock` class, before `connectedCallback()`:

```ts
/**
 * Rebuild every visible pane tab's content to show or hide the bell-dot
 * prefix (● ) based on current store bell state.
 *
 * Reaches into the Dockview-rendered DOM via panel.view.tab.element —
 * an internal field not in the public IDockviewPanel type, hence the cast.
 * The alternative (panel.api.setTitle) overwrites the title string stored
 * in Dockview's state, which then fights with our custom-title tracking.
 */
private _refreshBellTitles(): void {
  for (const [paneId, panel] of this._panels) {
    const rawTitle =
      this._customTitles.get(paneId) ??
      this.panes.find((p) => p.paneId === paneId)?.title ??
      `Pane ${paneId}`;
    const bellActive = store.paneBellActive(paneId);
    // Access the tab's .dv-default-tab-content element.
    // panel.view is an internal IDockviewPanelModel; .tab.element is the
    // HTMLElement rendered as the tab header by Dockview's default renderer.
    const tabContent = (
      panel as unknown as { view?: { tab?: { element?: HTMLElement } } }
    ).view?.tab?.element?.querySelector<HTMLElement>(
      '.dv-default-tab-content',
    ) ?? null;
    if (!tabContent) continue;
    // Rebuild inner content: optional bell span + raw title text node.
    tabContent.textContent = '';
    if (bellActive) {
      const dot = document.createElement('span');
      dot.className = 'mux-bell-prefix';
      dot.textContent = '● ';
      tabContent.appendChild(dot);
    }
    tabContent.appendChild(document.createTextNode(rawTitle));
  }
}
```

### Step 3: Add CSS rules to the injected style block

Inside `connectedCallback()`, find the existing style injection block that starts with:
```ts
style.textContent = `
  mux-dock {
    display: block;
```

Near the END of that style string (before the closing backtick), add three new rule blocks:

```css

        /* ── Bell indicator dot ─────────────────────────────────────── */
        mux-dock .mux-bell-prefix {
          color: var(--mux-bell, #e0af68);
          font-style: normal;
        }

        /* ── Dockview tab sizing tokens (desktop only) ──────────────── */
        mux-dock .dv-tab {
          flex: 1 1 var(--mux-tab-max-width, 180px);
          min-width: var(--mux-tab-min-width, 80px);
          max-width: var(--mux-tab-max-width, 180px);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* ── Mobile: hide Dockview tab strip; mux-pane-picker replaces it */
        @media (max-width: 768px) {
          mux-dock .dv-tabs-and-actions-container {
            display: none !important;
          }
        }
```

> **Note:** Be careful to place these rules INSIDE the existing template literal string. The string ends with a `\`` — add the new CSS before that final backtick.

### Step 4: Call `_refreshBellTitles()` from `updated()`

Find the `updated()` method. It currently handles three cases. Case 1 has a `return;` at the end. You must call `_refreshBellTitles()` in two places:

1. **Inside Case 1**, immediately before `return;`:

Find:
```ts
      } finally {
        this._settingActive = false;
        this._removingPanels = false;
      }
      return;
    }
```

Replace with:
```ts
      } finally {
        this._settingActive = false;
        this._removingPanels = false;
      }
      this._refreshBellTitles();
      return;
    }
```

2. **At the very end of `updated()`**, after the Case 2 and Case 3 blocks (the method's closing `}`):

Find the last few lines of `updated()`:
```ts
    // Case 3: activePaneId changed → set active panel
    if (changed.has('activePaneId')) {
      ...
    }
  }
```

After the Case 3 `if` block closes (and before the method's own `}`), add:
```ts
    this._refreshBellTitles();
```

The end of `updated()` should look like:
```ts
    // Case 3: activePaneId changed → set active panel
    if (changed.has('activePaneId')) {
      muxLog('dock case3', `activePaneId changed to ${this.activePaneId}`,
        { panels: [...this._panels.keys()], prevActivePaneId: changed.get('activePaneId') });
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

    this._refreshBellTitles();
  }
```

### Step 5: Fix the rename `finish()` callback to preserve bell prefix

The `_onTabDblClick` handler currently sets `tabContent.textContent = next` inside `finish()`. This wipes out our `<span class="mux-bell-prefix">`. Fix it.

Find this in `_onTabDblClick`:

```ts
    const currentTitle = tabContent.textContent ?? '';
```

Replace with (strip bell prefix when reading current title):
```ts
    const currentTitle = (tabContent.textContent ?? '').replace(/^● /, '');
```

Find this in `finish()`:
```ts
      tabContent.style.display = '';
      tabContent.textContent = next;
```

Replace with (rebuild with bell prefix):
```ts
      tabContent.style.display = '';
      // Rebuild with bell prefix so a rename doesn't permanently drop the dot.
      tabContent.textContent = '';
      if (store.paneBellActive(paneId)) {
        const dot = document.createElement('span');
        dot.className = 'mux-bell-prefix';
        dot.textContent = '● ';
        tabContent.appendChild(dot);
      }
      tabContent.appendChild(document.createTextNode(next));
```

### Step 6: Run check:fast

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npm run check:fast
```

Expected: 0 errors, 0 warnings.

### Step 7: Commit

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git add web/src/components/mux-dock.ts
git commit -m "feat: add bell dot prefix to pane tabs and CSS tab sizing + mobile hide"
```

---

## Task 2: Create `mux-dock-bar.ts`

**Files:**
- Create: `web/src/components/mux-dock-bar.ts`

### Step 1: Create the file

Create `web/src/components/mux-dock-bar.ts` with this exact content:

```ts
import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { CHROME } from '../lib/theme.js';
import { workspaceLabel } from './workspace-picker.js';
import type { SessiondWorkspaceInfo } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// MuxDockBar
//
// Replaces mux-status-bar. Renders workspace slots as flat touch-friendly
// buttons — no boxes, padding-only targets — with:
//   • Bold text for the active workspace
//   • ● prefix (amber) on non-active workspaces with an uncleared bell
//   • + button to create a new workspace (emits workspace-create)
//   • ● connection indicator at far right (ok/error color)
//
// Bell state is read directly from the store in render(). The component
// subscribes to store.subscribe() so bell changes trigger re-renders even
// when no external property changes.
// ─────────────────────────────────────────────────────────────────────────────

@customElement('mux-dock-bar')
export class MuxDockBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: row;
      align-items: center;
      background: ${unsafeCSS(CHROME.bar)};
      border-top: 1px solid ${unsafeCSS(CHROME.border)};
      height: var(--mux-dock-height, 44px);
      /* On iOS with a home indicator, add safe-area inset. */
      padding-bottom: env(safe-area-inset-bottom, 0px);
      font-size: var(--mux-dock-font-size, 0.85rem);
      color: var(--mux-fg);
      flex-shrink: 0;
      user-select: none;
      overflow-x: auto;
    }

    /* ── Workspace slot buttons ─────────────────────────────────────── */
    .ws-btn {
      display: inline-flex;
      align-items: center;
      padding: var(--mux-dock-item-padding, 0 16px);
      min-height: var(--mux-dock-height, 44px);
      border: none;
      background: transparent;
      color: var(--mux-fg);
      font: inherit;
      font-size: var(--mux-dock-font-size, 0.85rem);
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .ws-btn.active {
      font-weight: var(--mux-dock-active-weight, 600);
      color: var(--mux-accent, #7aa2f7);
    }

    .ws-btn:hover:not(.active) {
      color: var(--mux-fg);
      opacity: 0.85;
    }

    /* ── Bell dot inside workspace labels ────────────────────────────── */
    .bell-dot {
      color: var(--mux-bell, var(--mux-warn, #e0af68));
      margin-right: 4px;
      font-style: normal;
    }

    /* ── New workspace (+) button ─────────────────────────────────────── */
    .new-ws-btn {
      display: inline-flex;
      align-items: center;
      padding: 0 12px;
      min-height: var(--mux-dock-height, 44px);
      border: none;
      background: transparent;
      color: var(--mux-fg);
      font: inherit;
      font-size: 1.1em;
      cursor: pointer;
      flex-shrink: 0;
    }

    .new-ws-btn:hover {
      color: var(--mux-accent, #7aa2f7);
    }

    /* ── Connection indicator (far right) ─────────────────────────────── */
    .conn-dot {
      margin-left: auto;
      padding: 0 12px;
      min-height: var(--mux-dock-height, 44px);
      display: flex;
      align-items: center;
      flex-shrink: 0;
      font-size: 0.7em;
    }

    .conn-dot.connected    { color: var(--mux-ok,    #9ece6a); }
    .conn-dot.disconnected { color: var(--mux-error, #f7768e); }
    .conn-dot.reconnecting { color: var(--mux-error, #f7768e); }
  `;

  // ── Props from mux-app ──────────────────────────────────────────────────
  @property({ attribute: false }) workspaces: SessiondWorkspaceInfo[] = [];
  @property({ attribute: false }) activeWorkspaceId = '';
  @property({ attribute: false }) connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

  // ── Internal store subscription ─────────────────────────────────────────
  @state() private _version = 0;
  private _unsubscribe: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Subscribe to store so bell state changes trigger re-renders even when
    // no external property (workspaces, activeWorkspaceId) changes.
    this._unsubscribe = store.subscribe(() => {
      this._version++;
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  // ── Event handlers ───────────────────────────────────────────────────────

  private _onWsClick(wsId: string): void {
    // Ack the workspace bell BEFORE emitting workspace-switch so the dock
    // dot clears atomically with the switch. mux-app.ts does NOT separately
    // call ackWorkspace — this is the single call site.
    store.ackWorkspace(wsId);
    this.dispatchEvent(
      new CustomEvent('workspace-switch', {
        detail: { workspaceId: wsId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onNewWsClick(): void {
    this.dispatchEvent(
      new CustomEvent('workspace-create', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  override render() {
    return html`
      ${this.workspaces.map((ws) => {
        const wsId = ws.workspaceId;
        const isActive = wsId === this.activeWorkspaceId;
        // Bell dot: only shown on NON-active workspaces with an uncleared bell.
        // Bells on the active workspace are acknowledged via pane tab dots above.
        const showBell = !isActive && store.workspaceBellActive(wsId);
        const label = workspaceLabel(ws);
        return html`
          <button
            class="ws-btn ${isActive ? 'active' : ''}"
            title="Switch to ${label}"
            @click=${() => this._onWsClick(wsId)}
          >
            ${showBell ? html`<span class="bell-dot">●</span>` : ''}${label}
          </button>
        `;
      })}
      <button class="new-ws-btn" title="New workspace" @click=${this._onNewWsClick}>+</button>
      <div class="conn-dot ${this.connectionStatus}">●</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-dock-bar': MuxDockBar;
  }
}
```

### Step 2: Run check:fast

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npm run check:fast
```

Expected: 0 errors, 0 warnings.

### Step 3: Commit

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git add web/src/components/mux-dock-bar.ts
git commit -m "feat: add mux-dock-bar component with workspace slots and bell indicators"
```

---

## Task 3: Swap `mux-status-bar` for `mux-dock-bar` in `app.ts`, delete `status-bar.ts`

**Files:**
- Modify: `web/src/app.ts`
- Delete: `web/src/components/status-bar.ts`

### Step 1: Remove the old import, add the new one in `app.ts`

Open `web/src/app.ts`. Find the import block at the top:
```ts
// Side-effect imports — register child custom elements
import './components/title-bar.js';
import './components/status-bar.js';
import './components/mux-dock.js';
import './components/workspace-picker.js';
import './components/reconnect-overlay.js';
```

Replace with:
```ts
// Side-effect imports — register child custom elements
import './components/title-bar.js';
import './components/mux-dock-bar.js';
import './components/mux-dock.js';
import './components/workspace-picker.js';
import './components/reconnect-overlay.js';
```

### Step 2: Replace `<mux-status-bar>` with `<mux-dock-bar>` in `render()`

Find the `<mux-status-bar>` element in the `render()` template:
```ts
      <mux-status-bar
        .workspaces="${store.workspaces}"
        .currentWorkspaceId="${store.attached ?? ''}"
        connectionStatus="${this._connectionStatus}"
        @open-workspace-picker="${this._onOpenWorkspacePicker}"
      ></mux-status-bar>
```

Replace it with:
```ts
      <mux-dock-bar
        .workspaces="${store.workspaces}"
        .activeWorkspaceId="${store.attached ?? ''}"
        connectionStatus="${this._connectionStatus}"
        @workspace-switch="${this._onWorkspaceSelected}"
        @workspace-create="${this._onOpenCreateModal}"
      ></mux-dock-bar>
```

> **Why `_onWorkspaceSelected` is reused:** It already has the right signature — `(e: CustomEvent<{ workspaceId: string }>) => void` — and handles the socket attach call correctly. The only difference from the picker is that `this._showWorkspacePicker = false` becomes a harmless no-op when the picker is already closed.

> **Why `_onOpenCreateModal` is reused:** `mux-dock-bar`'s `+` button emits `workspace-create` (same event name as `mux-workspace-picker`), and `_onOpenCreateModal` already handles that event correctly.

### Step 3: Delete `web/src/components/status-bar.ts`

```bash
rm /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web/src/components/status-bar.ts
```

> **Note:** The filename is `status-bar.ts` (not `mux-status-bar.ts`). The element was named `mux-status-bar` but the file was `status-bar.ts`.

### Step 4: Run check:fast

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npm run check:fast
```

Expected: 0 errors, 0 warnings. TypeScript should confirm that `mux-status-bar` is no longer referenced anywhere.

### Step 5: Commit

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git add web/src/app.ts
git rm web/src/components/status-bar.ts
git commit -m "feat: replace mux-status-bar with mux-dock-bar in app.ts"
```

---

## Task 4: Verify `DESIGN.md` already has the tab tokens

**Files:**
- Verify (no code change): `DESIGN.md`

### Step 1: Check that both tab tokens are in the proposed tokens table

Open `DESIGN.md` and confirm the "Proposed tokens" table already contains both of these rows:

```
| `--mux-tab-max-width` | Maximum/default pane tab width on desktop | `180px` |
| `--mux-tab-min-width` | Minimum pane tab width before label truncates | `80px` |
```

If they are already there (they should be): no edit needed. If either is missing, add it to the table.

### Step 2: Run build to confirm Phase 2 compiles cleanly

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npm run build
```

Expected: build succeeds with no TypeScript errors.

### Step 3: Commit (only if DESIGN.md was changed)

If you had to add anything to DESIGN.md:
```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git add DESIGN.md
git commit -m "docs: confirm tab sizing tokens in DESIGN.md proposed tokens table"
```

If DESIGN.md was already correct, no commit needed.

---

## Phase 2 complete

Desktop UI is wired. At this point:
- Pane tabs show `●` in amber when a bell fires in the background
- The dock bar at the bottom shows workspace slots with `●` on workspaces with uncleared bells
- The old status bar is gone
- Mobile: Dockview tab strip is hidden at ≤768px (pane picker UI comes in Phase 3)
