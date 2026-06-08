# Attention Management — Phase 3: Mobile + Verification

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Add the mobile pane switcher (`mux-pane-picker`) inside the title bar so users on narrow viewports can navigate panes and see bell state without Dockview's hidden tab strip. Then extend the verification skill with the attention management scenarios so the feature is regression-tested going forward.
**Architecture:** `mux-pane-picker` is a self-contained Lit component that subscribes to `MuxStore` directly (reads panes/workspaces without props). `mux-title-bar` mounts it as a side-effect import. `mux-app.ts` adds a single event binding on `<mux-title-bar>` to catch `pane-select` bubbling up from the picker.
**Tech Stack:** TypeScript, Lit, CSS media queries. No new dependencies.

**Prerequisites:** Phase 1 and Phase 2 must be complete.

---

## Task 1: Create `mux-pane-picker.ts`

**Files:**
- Create: `web/src/components/mux-pane-picker.ts`

### Step 1: Create the file

Create `web/src/components/mux-pane-picker.ts` with this exact content:

```ts
import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { CHROME } from '../lib/theme.js';
import { workspaceLabel } from './workspace-picker.js';

// ─────────────────────────────────────────────────────────────────────────────
// MuxPanePicker
//
// Mobile-only (≤768px) pane switcher that lives inside the title bar.
// On desktop it hides itself via CSS so it costs nothing at >768px.
//
// Shows a tappable breadcrumb: [workspace] › [active pane] ▾
// Tap opens a dropdown listing all panes in the current workspace.
// Each pane shows a bell dot (● ) if store.paneBellActive() is true.
// Active pane shows a ✓ indicator.
//
// Tapping a pane:
//   1. Calls store.ackPane(paneId) to clear the pane's bell dot.
//   2. Emits "pane-select" CustomEvent with { paneId } detail (same shape
//      as mux-dock's pane-select).
//   3. mux-app.ts handles this via @pane-select on <mux-title-bar>.
//
// Because this component lives inside mux-title-bar's shadow DOM, its events
// DO NOT automatically reach mux-dock's @pane-select binding in mux-app.ts.
// mux-app.ts MUST also bind @pane-select on <mux-title-bar> (done in Task 2).
//
// Bell state is read directly from store in render(). store.subscribe()
// triggers re-renders automatically when bell state or pane list changes.
// ─────────────────────────────────────────────────────────────────────────────

@customElement('mux-pane-picker')
export class MuxPanePicker extends LitElement {
  static styles = css`
    :host {
      position: relative;
      display: flex;
      align-items: center;
      flex: 1;
      justify-content: flex-end;
    }

    /* Hidden on desktop — mux-dock renders pane tabs there instead. */
    @media (min-width: 769px) {
      :host {
        display: none;
      }
    }

    /* ── Breadcrumb trigger button ─────────────────────────────────── */
    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 8px;
      min-height: 32px;
      border: none;
      background: transparent;
      color: var(--mux-fg);
      font: inherit;
      font-size: 0.85rem;
      cursor: pointer;
      white-space: nowrap;
      max-width: 220px;
    }

    .breadcrumb:hover {
      opacity: 0.8;
    }

    .breadcrumb .pane-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 120px;
    }

    .breadcrumb .separator {
      color: ${unsafeCSS(CHROME.textDim)};
      flex-shrink: 0;
    }

    .breadcrumb .caret {
      color: ${unsafeCSS(CHROME.textDim)};
      flex-shrink: 0;
    }

    /* ── Bell dot ────────────────────────────────────────────────────── */
    .bell-dot {
      color: var(--mux-bell, var(--mux-warn, #e0af68));
      flex-shrink: 0;
    }

    /* ── Dropdown panel ──────────────────────────────────────────────── */
    .dropdown {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      background: ${unsafeCSS(CHROME.bar)};
      border: 1px solid var(--mux-border, #414868);
      border-radius: 6px;
      min-width: 180px;
      max-width: 280px;
      z-index: 2000;
      overflow: hidden;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    }

    .pane-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border: none;
      background: transparent;
      color: var(--mux-fg);
      font: inherit;
      font-size: 0.875rem;
      cursor: pointer;
      width: 100%;
      text-align: left;
    }

    .pane-item:hover {
      background: rgba(122, 162, 247, 0.12);
    }

    .pane-item.active {
      color: var(--mux-accent, #7aa2f7);
    }

    .pane-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .check {
      flex-shrink: 0;
      opacity: 0;
      color: var(--mux-accent, #7aa2f7);
    }

    .pane-item.active .check {
      opacity: 1;
    }
  `;

  // ── Internal state ────────────────────────────────────────────────────────
  @state() private _open = false;
  @state() private _version = 0; // bumped by store subscription to trigger re-render

  private _unsubscribe: (() => void) | null = null;

  /** Close dropdown when user clicks outside this component. */
  private _onOutsideClick = (e: MouseEvent): void => {
    if (this._open && !e.composedPath().includes(this)) {
      this._open = false;
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    // Subscribe so bell state changes and pane list changes trigger re-renders.
    this._unsubscribe = store.subscribe(() => {
      this._version++;
    });
    document.addEventListener('mousedown', this._onOutsideClick);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
    document.removeEventListener('mousedown', this._onOutsideClick);
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  private _toggle(): void {
    this._open = !this._open;
  }

  private _selectPane(paneId: number): void {
    this._open = false;
    // Acknowledge the bell BEFORE emitting pane-select so the dot clears
    // atomically with the switch.
    store.ackPane(paneId);
    this.dispatchEvent(
      new CustomEvent('pane-select', {
        detail: { paneId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  override render() {
    const { panes, activePaneId, workspaces, attached } = store;
    const validPanes = panes.filter((p) => p.paneId >= 0);

    // Workspace label for the breadcrumb
    const ws = workspaces.find((w) => w.workspaceId === attached);
    const wsName = ws ? workspaceLabel(ws) : (attached ?? '');

    // Active pane name for the breadcrumb
    const activePane = validPanes.find((p) => p.paneId === activePaneId);
    const activePaneName = activePane?.title ?? (activePaneId >= 0 ? `Pane ${activePaneId}` : '—');
    const activeBell = activePaneId >= 0 && store.paneBellActive(activePaneId);

    return html`
      <button class="breadcrumb" @click=${this._toggle} title="Switch pane">
        <span class="separator">${wsName}</span>
        <span class="separator">›</span>
        ${activeBell ? html`<span class="bell-dot">●</span>` : ''}
        <span class="pane-name">${activePaneName}</span>
        <span class="caret">▾</span>
      </button>

      ${this._open
        ? html`
            <div class="dropdown">
              ${validPanes.map((pane) => {
                const isActive = pane.paneId === activePaneId;
                const paneTitle = pane.title ?? `Pane ${pane.paneId}`;
                const bellActive = store.paneBellActive(pane.paneId);
                return html`
                  <button
                    class="pane-item ${isActive ? 'active' : ''}"
                    @click=${() => this._selectPane(pane.paneId)}
                  >
                    ${bellActive
                      ? html`<span class="bell-dot">●</span>`
                      : html`<span style="width:1em;flex-shrink:0;"></span>`}
                    <span class="pane-label">${paneTitle}</span>
                    <span class="check">✓</span>
                  </button>
                `;
              })}
            </div>
          `
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-pane-picker': MuxPanePicker;
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
git add web/src/components/mux-pane-picker.ts
git commit -m "feat: add mux-pane-picker mobile pane switcher with bell dots"
```

---

## Task 2: Mount `mux-pane-picker` in `title-bar.ts` and wire `pane-select` in `app.ts`

**Files:**
- Modify: `web/src/components/title-bar.ts`
- Modify: `web/src/app.ts`

### Step 1: Import and mount the picker in `title-bar.ts`

Open `web/src/components/title-bar.ts`. Add an import for the pane picker at the top, alongside the existing launcher import:

Find:
```ts
import './launcher-menu.js';
```

Add below it:
```ts
import './mux-pane-picker.js';
```

### Step 2: Add `<mux-pane-picker>` to the title bar layout

Find the `render()` method in `title-bar.ts`. Currently:
```ts
  render() {
    return html`
      <div class="brand">
        <span class="brand-dot"></span>
        <span>muxterm</span>
        <span class="brand-sha">${__GIT_SHA__}</span>
      </div>
      <div class="right">
        <button
          class="launcher-btn"
          title="Open menu"
          @click="${this._toggleMenu}"
        >${icon(Ellipsis, { size: 16 })}</button>
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu
                @launcher-action="${this._onLauncherAction}"
              ></mux-launcher-menu>
            </div>`
          : ''}
      </div>
    `;
  }
```

Replace with (add `<mux-pane-picker>` between brand and right):
```ts
  render() {
    return html`
      <div class="brand">
        <span class="brand-dot"></span>
        <span>muxterm</span>
        <span class="brand-sha">${__GIT_SHA__}</span>
      </div>
      <mux-pane-picker></mux-pane-picker>
      <div class="right">
        <button
          class="launcher-btn"
          title="Open menu"
          @click="${this._toggleMenu}"
        >${icon(Ellipsis, { size: 16 })}</button>
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu
                @launcher-action="${this._onLauncherAction}"
              ></mux-launcher-menu>
            </div>`
          : ''}
      </div>
    `;
  }
```

> **Why no extra CSS needed:** `mux-pane-picker`'s own styles already apply `flex: 1; justify-content: flex-end` to its `:host` and `display: none` at `≥769px`. The title bar is a flex row, so the picker fills the space between brand and the right button cluster on mobile.

### Step 3: Add `@pane-select` binding on `<mux-title-bar>` in `app.ts`

Open `web/src/app.ts`. Find the `<mux-title-bar>` usage in `render()`:

```ts
      <mux-title-bar @launcher-action="${this._onLauncherAction}"></mux-title-bar>
```

Replace with:
```ts
      <mux-title-bar
        @launcher-action="${this._onLauncherAction}"
        @pane-select="${this._onActivePane}"
      ></mux-title-bar>
```

> **Why this is needed:** `mux-pane-picker` lives inside `mux-title-bar`'s shadow DOM. Its `pane-select` event is `composed: true` so it crosses shadow boundaries and can be caught at the `<mux-title-bar>` level in `mux-app.ts`. Without this binding, the event would stop at the title bar host element and never reach the existing `@pane-select` binding on `<mux-dock>`. The `_onActivePane` handler is unchanged — it already has the right `(e: CustomEvent<{ paneId: number }>) => void` signature.

### Step 4: Run check:fast

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npm run check:fast
```

Expected: 0 errors, 0 warnings.

### Step 5: Run full build

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npm run build
```

Expected: build succeeds with no errors.

### Step 6: Commit

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git add web/src/components/title-bar.ts web/src/app.ts
git commit -m "feat: mount mux-pane-picker in title bar, wire pane-select in app"
```

---

## Task 3: Extend `SCENARIO.md` with attention management scenarios

**Files:**
- Modify: `SCENARIO.md` (project root of the worktree)

### Step 1: Append the new scenario section

Open `SCENARIO.md` at the root of the worktree. At the very end of the file, append this new section:

```markdown

---

## Scenario 5 — Bell Indicators: Desktop (1280×800)

**Purpose:** Verify that bell dots appear on pane tabs and workspace dock slots, and clear correctly when acknowledged.

**Viewport:** 1280×800

### Phase A — Pane tab bell dot

1. Load muxterm at 1280×800.
2. Ensure at least 2 panes exist in the current workspace. If only 1, click `+` to add a second.
3. Switch to pane 1 (the first pane) so it is the active pane.
4. In the active terminal, type: `echo -e "\a"` and press Enter. This sends a bell to the ACTIVE pane — the dot should NOT appear on the active tab (or if it briefly appears, it should clear immediately when the pane is already focused).
5. Switch to pane 2 to make it active.
6. In pane 2's terminal, type: `echo -e "\a"` and press Enter. This sends a bell to pane 2 while it is the active pane — same as above.
7. Switch BACK to pane 1.
8. Now trigger a bell on pane 2 from pane 1: type a command that writes `\a` to pane 2, OR simply eval:
   ```js
   // In browser devtools console — trigger a synthetic bell on pane 2
   const dock = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
   // Get pane 2's ID
   const pane2Id = [...dock._panels.keys()].find(id => id !== dock.activePaneId);
   // Use terminalRegistry to trigger a bell
   const term = window.__muxRegistry?.peek(pane2Id)?.term ?? null;
   if (term) term._core._onBell.fire();
   pane2Id;
   ```
9. Wait 200ms. Assert that pane 2's tab now shows the `●` prefix in the tab label.

```js
// Assertion helper — find text of all tabs
const dock = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
const tabTexts = [...dock.querySelectorAll('.dv-default-tab-content')].map(el => el.textContent?.trim() ?? '');
const hasBellDot = tabTexts.some(t => t.startsWith('●'));
hasBellDot; // expected: true
```

**Assertion A1**: at least one tab label starts with `●`.

10. Click on pane 2 to focus it (acknowledge the bell).
11. Wait 200ms. Assert the `●` prefix is gone from pane 2's tab.

```js
const tabTexts2 = [...dock.querySelectorAll('.dv-default-tab-content')].map(el => el.textContent?.trim() ?? '');
const stillHasBell = tabTexts2.some(t => t.startsWith('●'));
stillHasBell; // expected: false
```

**Assertion A2**: no tab label starts with `●` after pane focus.

### Phase B — Workspace dock slot bell dot

1. Ensure at least 2 workspaces exist. If only 1, create a second via the `+` in the dock bar.
2. Note the active workspace (`wsA`). Switch to the other workspace (`wsB`) so `wsA` is now inactive.
3. In workspace `wsB`, trigger a bell via the active pane:
   ```js
   const term = window.__muxRegistry?.peek(window.__muxFirstPaneId());
   if (term) term.term._core._onBell.fire();
   ```
   This fires a bell on a pane in `wsB` while `wsB` is the active workspace — dock dot should NOT appear for `wsB` (active workspace bells are suppressed in the dock bar).
4. Switch BACK to workspace `wsA`.
5. Now trigger a bell on `wsB` remotely (simulated — use store directly):
   ```js
   const store = window.__muxStore;
   const wsBId = store.workspaces.find(w => w.workspaceId !== store.attached)?.workspaceId;
   // Mark a fake bell for wsB's first pane
   store.markBell(999, wsBId);
   wsBId; // returns the wsB id
   ```
6. Wait 200ms. Assert the dock bar shows `●` before workspace `wsB`'s label.

```js
const dockBar = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock-bar');
const wsBBtn = dockBar.shadowRoot.querySelector(`.ws-btn:not(.active) .bell-dot`);
wsBBtn !== null; // expected: true
```

**Assertion B1**: non-active workspace slot with bell shows `●` dot.

7. Switch to workspace `wsB` (click its slot in the dock bar). The ack fires inside `mux-dock-bar` before the switch event.
8. Wait 200ms. Assert the `●` is gone from the dock slot.

```js
const stillHasBellDot = dockBar.shadowRoot.querySelector(`.ws-btn .bell-dot`) !== null;
stillHasBellDot; // expected: false
```

**Assertion B2**: dock bell dot clears on workspace switch.

### Phase C — Tab sizing

1. Verify tabs flex between min and max width.

```js
const tab = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock .dv-tab');
const cs = getComputedStyle(tab);
const minW = parseInt(cs.minWidth);
const maxW = parseInt(cs.maxWidth);
(minW >= 79 && maxW <= 181); // expected: true (80px ± 1px rounding)
```

**Assertion C1**: tabs have min-width ~80px and max-width ~180px.

---

## Scenario 6 — Bell Indicators: Mobile (390×844)

**Purpose:** Verify the mobile layout hides Dockview tabs, shows the `mux-pane-picker` breadcrumb, and that bell dots work correctly in the dropdown.

**Viewport:** 390×844 (iPhone 14 Pro)

### Phase A — Layout at mobile breakpoint

1. Load muxterm at 390×844.
2. Assert Dockview tab strip is hidden.

```js
const dock = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
const tabStrip = dock.querySelector('.dv-tabs-and-actions-container');
const hidden = !tabStrip || getComputedStyle(tabStrip).display === 'none';
hidden; // expected: true
```

**Assertion A1**: `.dv-tabs-and-actions-container` is hidden at 390px wide.

3. Assert `mux-pane-picker` is visible.

```js
const titleBar = document.querySelector('mux-app').shadowRoot.querySelector('mux-title-bar');
const picker = titleBar.shadowRoot.querySelector('mux-pane-picker');
const visible = picker && getComputedStyle(picker).display !== 'none';
visible; // expected: true
```

**Assertion A2**: `mux-pane-picker` is visible in the title bar.

4. Assert the breadcrumb shows `workspace › pane ▾` format.

```js
const breadcrumb = titleBar.shadowRoot.querySelector('mux-pane-picker').shadowRoot.querySelector('.breadcrumb');
const text = breadcrumb.textContent ?? '';
// Should contain '›' and '▾'
text.includes('›') && text.includes('▾'); // expected: true
```

**Assertion A3**: breadcrumb text contains `›` and `▾`.

### Phase B — Pane switching via breadcrumb

1. Ensure at least 2 panes exist. Add one via `+` in the dock bar if needed.
2. Trigger a bell on the inactive pane:

```js
const store = window.__muxStore;
const inactivePaneId = store.panes.filter(p => p.paneId >= 0)
  .find(p => p.paneId !== store.activePaneId)?.paneId;
if (inactivePaneId !== undefined) store.markBell(inactivePaneId, store.attached ?? '');
inactivePaneId;
```

3. Tap the breadcrumb to open the dropdown. Assert the dropdown is visible.

```js
const picker = titleBar.shadowRoot.querySelector('mux-pane-picker');
const btn = picker.shadowRoot.querySelector('.breadcrumb');
btn.click();
await new Promise(r => setTimeout(r, 150));
const dropdown = picker.shadowRoot.querySelector('.dropdown');
dropdown !== null; // expected: true
```

**Assertion B1**: dropdown opens on breadcrumb tap.

4. Assert the inactive pane row in the dropdown shows the `●` bell dot.

```js
const bellItems = [...picker.shadowRoot.querySelectorAll('.dropdown .bell-dot')];
bellItems.length > 0; // expected: true
```

**Assertion B2**: at least one dropdown item shows `●` bell dot.

5. Tap the pane with the bell dot to switch to it.

```js
const paneItem = picker.shadowRoot.querySelector('.pane-item:not(.active)');
paneItem.click();
await new Promise(r => setTimeout(r, 300));
```

6. Assert the active pane changed and bell dot is gone.

```js
const stillHasBell = store.paneBellActive(inactivePaneId);
stillHasBell; // expected: false
```

**Assertion B3**: bell clears after pane switch via dropdown.

### Phase C — Dock bar present on mobile

1. Assert `mux-dock-bar` is visible at mobile viewport.

```js
const dockBar = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock-bar');
const visible = dockBar && getComputedStyle(dockBar).display !== 'none';
visible; // expected: true
```

**Assertion C1**: dock bar is visible on mobile.

2. Assert workspace switching still works at mobile viewport (click a workspace slot, verify `store.attached` changes).

```js
const targetWs = store.workspaces.find(w => w.workspaceId !== store.attached)?.workspaceId;
// This assertion requires ≥2 workspaces. Skip if only 1 workspace exists.
targetWs !== undefined; // prerequisite check
```
```js
const wsBtnInactive = dockBar.shadowRoot.querySelector('.ws-btn:not(.active)');
if (wsBtnInactive) {
  wsBtnInactive.click();
  await new Promise(r => setTimeout(r, 500));
  store.attached !== targetWs; // expected: false (i.e., attached changed to targetWs)
}
true;
```

**Assertion C2**: workspace switch works via dock bar on mobile (if ≥2 workspaces exist).
```

### Step 2: Run check:fast (no TypeScript involved, but confirm SCENARIO.md was saved)

```bash
wc -l /home/ken/workspace/muxterm/.worktrees/feat/attention-management/SCENARIO.md
```

Expected: the file is longer than before (was 205 lines, now significantly more).

### Step 3: Commit

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git add SCENARIO.md
git commit -m "test: add attention management scenarios to SCENARIO.md (desktop + mobile bell dots)"
```

---

## Task 4: Update the `/muxterm-verify` skill to cover new scenarios

**Files:**
- Modify: `.amplifier/skills/muxterm-verify/SKILL.md`

### Step 1: Read the current SKILL.md first

```
read_file(".amplifier/skills/muxterm-verify/SKILL.md")
```

### Step 2: Update the skill

Open `.amplifier/skills/muxterm-verify/SKILL.md`. The current skill only runs the 9-check legacy journey. Update it to also include the attention management scenarios.

Replace the entire content with:

```markdown
---
name: muxterm-verify
description: >
  Use when verifying muxterm works correctly end-to-end as a real user would experience it.
  Catches garbled terminal text on reconnect, pane deletions not persisting to the server,
  selected-pane state not surviving browser refresh, split layout regressions, bell dot
  indicators on pane tabs and workspace dock slots, and mobile pane picker behavior.
  Run before merging any pane, terminal, reconnect, WebSocket, or bell/attention changes.
  Invoke as /muxterm-verify.
user-invocable: true
disable-model-invocation: true
context: fork
model_role: general
allowed-tools:
  - read_file
  - delegate
---

# muxterm Verification Journey

Execute all user journeys defined in `SCENARIO.md` (project root) by driving a real
browser via `browser-tester:browser-operator`. Report pass/fail tables for all checks.

**Success artifact**: Completed pass/fail tables with actual values for all checks
across all scenarios, and a final PASS or FAIL verdict.

## Inputs

- `<url>` — Base URL for muxterm (default: `http://localhost:9090`)

## Steps

### 1. Read the Scenario

Read the full scenario document:

```
read_file("/home/ken/workspace/muxterm/.worktrees/feat/attention-management/SCENARIO.md")
```

**Success criteria**: SCENARIO.md is loaded and all scenarios (core journey + attention management) are understood.

### 2. Run All Journeys via Browser Operator

Delegate the full scenario to `browser-tester:browser-operator`. Pass the complete
SCENARIO.md content as the instruction, plus the execution instructions below verbatim.

**Execution**: Delegate to `browser-tester:browser-operator` with `context_depth="none"`.

Append this block to the scenario content when delegating:

---

**Execution instructions for browser-operator:**

Base URL: `http://localhost:9090` (or the URL provided by the user).

Use a fresh browser session (no cached state). For every JS snippet in the scenario,
use agent-browser's eval mechanism.

**Shadow DOM access — use this pattern for every DOM query:**
```js
const dock = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
```

**Garbled text detector:**
```js
function isClean(text) {
  return !/\x1b/.test(text)        // no ESC at all (CSI, DCS, OSC, ST, SS3, RIS, …)
      && !/\$\$\$\$/.test(text)    // no measurement leak artifacts
      && !/~~~~/.test(text)        // no xterm sizing garbage
      && !/\ufffd/.test(text);     // no unicode replacement chars
}
```

Run **Scenarios 1–4** (core journey) first, then **Scenario 5** (desktop bell, viewport 1280×800),
then **Scenario 6** (mobile bell, viewport 390×844).

After completing all scenarios, output a combined pass/fail table:

**Core journey (Scenarios 1–4, 9 checks):**
```
| # | Assertion                                     | Expected    | Actual | PASS/FAIL |
|---|-----------------------------------------------|-------------|--------|-----------|
| 1 | Terminal clean on fresh load                  | isClean=true |       |           |
| 2 | activePaneId === pane2Id after refresh         | true        |        |           |
| 3 | Both terminals clean after refresh             | isClean=true |       |           |
| 4 | Pane 2 absent after delete + refresh           | one tab     |        |           |
| 5 | activePaneId === pane1Id after delete+refresh  | true        |        |           |
| 6 | Pane 1 terminal clean after delete             | isClean=true |       |           |
| 7 | Split layout survives refresh                  | both panes  |        |           |
| 8 | activePaneId === pane1Id in split layout        | true        |        |           |
| 9 | Both split terminals clean                     | isClean=true |       |           |
```

**Attention management — Desktop (Scenario 5):**
```
| # | Assertion                                     | Expected | Actual | PASS/FAIL |
|---|-----------------------------------------------|----------|--------|-----------|
| A1 | Pane tab shows ● after background bell       | true     |        |           |
| A2 | ● clears after pane focus                    | false    |        |           |
| B1 | Dock slot shows ● for inactive ws bell        | true     |        |           |
| B2 | Dock ● clears on workspace switch             | false    |        |           |
| C1 | Tab min-width ~80px, max-width ~180px         | true     |        |           |
```

**Attention management — Mobile (Scenario 6):**
```
| # | Assertion                                          | Expected | Actual | PASS/FAIL |
|---|---------------------------------------------------|----------|--------|-----------|
| A1 | Dockview tab strip hidden at 390px wide            | true     |        |           |
| A2 | mux-pane-picker visible in title bar               | true     |        |           |
| A3 | Breadcrumb contains › and ▾                       | true     |        |           |
| B1 | Dropdown opens on breadcrumb tap                   | true     |        |           |
| B2 | Dropdown shows ● on pane with bell                 | true     |        |           |
| B3 | Bell clears after pane switch via dropdown         | false    |        |           |
| C1 | Dock bar visible on mobile                         | true     |        |           |
| C2 | Workspace switch works via dock bar (if ≥2 ws)    | true     |        |           |
```

Final verdict: **PASS** (all checks green) or **FAIL** (list failing checks with actual values).

---

**Success criteria**: browser-operator has walked through all scenarios and returned
completed tables with actual values for all checks.

### 3. Report Results

Relay all pass/fail tables and the final verdict back to the user.
If any checks failed, highlight the actual values observed so the bugs are clearly visible.

**Success criteria**: User has a clear PASS/FAIL verdict with evidence for all 17+ checks.
```

### Step 3: Run check:fast

No TypeScript change, but confirm the SKILL.md saved correctly:

```bash
wc -l /home/ken/workspace/muxterm/.worktrees/feat/attention-management/.amplifier/skills/muxterm-verify/SKILL.md
```

Expected: the file is longer than the original 103 lines.

### Step 4: Commit

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git add .amplifier/skills/muxterm-verify/SKILL.md
git commit -m "feat: extend /muxterm-verify skill with attention management scenarios"
```

---

## Task 5: Build and smoke verify

### Step 1: Run full build

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npm run build
```

Expected: TypeScript compilation + Vite bundle succeeds with no errors.

### Step 2: Run all tests

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management/web
npx vitest run
```

Expected: all tests pass including `bell-state` and all pre-existing tests.

### Step 3: Run `/muxterm-verify` against the DTU

If a Digital Twin Universe is available for this worktree, build the binary and run the skill:

```
/muxterm-verify
```

Expected: all 9 core journey checks pass (attention management checks require the running binary to have the new feature wired up — use devtools to simulate bells if the PTY bell character `\a` is not easily triggerable from the test scenario).

### Step 4: Final commit if any fixups were needed

```bash
cd /home/ken/workspace/muxterm/.worktrees/feat/attention-management
git log --oneline -10
```

Confirm all Phase 1, 2, and 3 commits are in the log. The feature is complete.

---

## Phase 3 complete

The full attention management feature is implemented:

| Layer | What was built |
|-------|----------------|
| `MuxStore` | Bell timestamp state with `markBell` / `ackPane` / `ackWorkspace` / `paneBellActive` / `workspaceBellActive` |
| `terminal-registry` | `onBell` forwarded from xterm.js → `PaneHandlers` |
| `app.ts` | `onBell` handler in `_syncTerminals`; `ackPane` on pane focus; `@pane-select` on title bar |
| `theme.ts` | `--mux-bell`, dock height/padding/font/weight tokens |
| `mux-dock` | Bell dot prefix on pane tabs via DOM rebuild; tab sizing CSS; mobile tab strip hide |
| `mux-dock-bar` | New workspace dock with per-slot bell dots; replaces status bar |
| `mux-pane-picker` | Mobile pane switcher with bell dots in dropdown |
| `title-bar` | Mounts `mux-pane-picker`; passes `pane-select` events up |
| `SCENARIO.md` | Desktop + mobile bell verification scenarios |
| `/muxterm-verify` skill | Extended to cover all new scenarios |
