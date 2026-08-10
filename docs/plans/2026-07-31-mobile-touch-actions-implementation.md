# Mobile Touch Actions Implementation Plan

> **For execution:** Use `/build-like-ken` mode.

**Goal:** Fix mobile touch-target sizing and add reachable new-pane/new-workspace actions on the narrow-mode (mobile) title bar.

**Architecture:** Three existing Lit components (`mux-title-bar`, `mux-pane-picker`, `mux-launcher-menu`) get incremental additions wired through existing event/handler plumbing in `app.ts` — no new state machines, no new components, no backend changes. A new `showCreateWorkspace` boolean prop on the shared `<mux-launcher-menu>` component (used by both narrow-mode's title bar AND wide-mode's sidebar) keeps wide-mode's kebab menu byte-for-byte unchanged while narrow-mode gets a new "New workspace" entry.

**Tech Stack:** Lit 3 (`LitElement`, `html`/`css` tagged templates, decorators), TypeScript, Vite, dockview-core (untouched by this change), lucide icons, `air` + `vite --watch` dev-local loop.

**Verification approach:** Real-execution only via `playwright-cli` against an isolated `make dev-local` instance at `http://127.0.0.1:8313`. Mobile viewport 390x844 for Tasks 1–3, desktop viewport 1280x800 for Task 4 (deliberately not "≥768px" — there's a documented pre-existing 768px boundary quirk in `mux-dock.ts`, so 1280x800 is used to avoid confounding results with it). Brand-new workspace/pane created for every verification run per this repo's `AGENTS.md` hygiene rules. **No unit tests** — this repo's `AGENTS.md` explicitly bans them; nothing here is testable in isolation from a real browser + real `sessiond` process.

---

## Context You Need Before Starting

Read `docs/designs/2026-07-31-mobile-touch-actions-design.md` in full — it is the source of truth for every decision below (why new-pane is a persistent button but new-workspace is one tap deeper in the kebab, why `showCreateWorkspace` defaults to `false`, what's explicitly out of scope). This plan implements that design; if anything here seems to contradict it, the design document wins and you should stop and ask.

**Explicitly OUT of scope — do not touch these, even if it looks convenient:**
- `mux-pane-picker.ts`'s dropdown `.ws-item`/`.pane-item` padding (`6px 8px`) — stays as-is.
- The pre-existing 768px CSS/JS boundary quirk in `mux-dock.ts` (`@media (max-width: 768px)` vs `breakpoint.ts`'s `width >= 768` being wide) — pre-existing, unrelated, not fixed here.
- Dockview's own hidden header at narrow widths (`mux-dock.ts` lines ~566–571) — stays hidden, untouched.
- Anything in the backend, socket protocol, or dockview version. This is a pure frontend change.

**Hard requirement, not optional:** `<mux-launcher-menu>` is shared by `<mux-title-bar>` (narrow) and `<mux-sidebar>` (wide). The new "New workspace" menu item MUST be gated behind a new `showCreateWorkspace` prop defaulting to `false`. Get this wrong (e.g. render it unconditionally) and you silently break wide mode — Task 3's verification step explicitly checks for this.

## Dev Environment (read before Task 1)

From the repo root, `make dev-local` starts an isolated instance at `http://127.0.0.1:8313`. `vite build --watch` auto-rebuilds `web/dist` on any `web/src` edit; `air` auto-restarts the `bin/muxterm-dev` binary when Vite's `build.stamp` changes. **You do not need to manually build** — save your file, wait ~1–2 seconds, then navigate/refresh in the browser.

This is fully isolated from production (`127.0.0.1:8311`, the native companion app). **Never touch, kill, or restart anything referencing port 8311 or its sessiond, under any circumstance.**

Verification hygiene (from this repo's `AGENTS.md` — follow exactly):
- Create a **brand-new workspace** (and therefore a brand-new pane) for every verification run. Never reuse a workspace/pane across tasks or across repeated attempts at the same task.
- Do a **fresh `make dev-local` restart** before starting a verification pass — not mid-stream while the watch loop is active.
- Never edit source files while a verification run is in progress — finish the check, then edit.
- Check for stale `sessiond` processes from another worktree (`ps aux | grep sessiond`) before trusting a result, since `make dev-local` uses a fixed socket path shared across worktrees.

Starting fresh before Task 1:

```bash
cd /Users/ken/workspace/muxterm/.worktrees/mobile-touch-actions
ps aux | grep sessiond   # confirm no stale daemon from another worktree
make dev-local
```

Expected: server comes up listening on `127.0.0.1:8313` with no errors in the terminal output.

---

## Task 1: Touch-target height fixes (Issue 1)

**Files:**
- Modify: `web/src/components/title-bar.ts`
- Modify: `web/src/components/mux-pane-picker.ts`

### 1a. `title-bar.ts` — host height

Find this block (currently lines 12–24):

```
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--chrome-bar);
      border-bottom: 1px solid var(--chrome-border);
      height: 32px;
      padding: 0 8px;
      flex-shrink: 0;
      user-select: none;
      position: relative;
      /* Structure ready for env(titlebar-area-*) WCO — apply here when needed */
    }
```

Replace `height: 32px;` with:

```
      height: var(--mux-dock-height, 44px);
```

`--mux-dock-height` is an existing, currently-unused CSS custom property already defined in `web/src/lib/theme.ts:288` (comment: "dock bar row height / touch target") — this task wires it up for the first time. The `44px` fallback means nothing breaks if the token is ever removed.

### 1b. `title-bar.ts` — launcher button size

Find this block (currently lines 57–70):

```
    .launcher-btn {
      width: 28px;
      height: 24px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--chrome-text-bright);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-family: inherit;
    }
```

Replace `width: 28px;` and `height: 24px;` with:

```
      width: 44px;
      height: 44px;
```

(Task 2 will revisit this selector to add a second button — don't worry about that yet, just get the sizing right here first.)

### 1c. `title-bar.ts` — menu anchor position

Find this block (currently lines 76–81):

```
    .menu-anchor {
      position: absolute;
      top: 28px;
      right: 0;
      z-index: 1500;
    }
```

Replace `top: 28px;` with:

```
      top: 100%;
```

This makes the anchor self-correcting to the bottom of the host regardless of height, removing a second hardcoded magic number that would otherwise need to track the new 44px height.

### 1d. `mux-pane-picker.ts` — breadcrumb min-height

Find this block (currently lines 23–38):

```
    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 32px;
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      font-size: 0.85rem;
      cursor: pointer;
      padding: 0 8px;
      max-width: 220px;
      white-space: nowrap;
      overflow: hidden;
    }
```

Replace `min-height: 32px;` with:

```
      min-height: 44px;
```

Do **not** touch `.ws-item` or `.pane-item` padding in this same file — those are explicitly out of scope (see "Context You Need Before Starting" above).

**Static Analysis** (always run first — fast and free)

```bash
cd /Users/ken/workspace/muxterm/.worktrees/mobile-touch-actions/web
npm run check:fast
```

Expected: `0 errors` from both `typecheck:fast` (tsgo) and `lint:fast` (oxlint).

**Verification**

1. Fresh restart + brand-new workspace:
   ```bash
   # from repo root, in a separate terminal (or background it)
   make dev-local
   ```
   Wait for it to report listening, then in the browser create a brand-new workspace (do not reuse an old one).

2. Real browser check via `playwright-cli`, mobile viewport:
   ```bash
   playwright-cli open http://127.0.0.1:8313
   playwright-cli resize 390 844
   playwright-cli snapshot --boxes
   ```
   In the snapshot output, locate `mux-title-bar`'s bounding box (or query it directly if not in the snapshot tree — shadow DOM elements may need `eval`):
   ```bash
   playwright-cli eval "document.querySelector('mux-app')?.shadowRoot?.querySelector('mux-title-bar')?.getBoundingClientRect().height ?? document.querySelector('mux-title-bar')?.getBoundingClientRect().height"
   ```
   Expected: `44` (or very close to it, allowing for border-box rounding).

3. Confirm the kebab button and breadcrumb are also ≥44px:
   ```bash
   playwright-cli eval "document.querySelector('mux-title-bar')?.shadowRoot?.querySelector('.launcher-btn')?.getBoundingClientRect().height"
   ```
   Expected: `44`.

4. Visual confirmation: take a screenshot and confirm the bar reads noticeably thicker than the old 32px bar.
   ```bash
   playwright-cli screenshot --filename=task1-title-bar.png
   ```
   Expected: visibly thicker top bar compared to your memory/notes of the pre-change state (or compare against `git stash` if you want a true before/after — optional, not required).

5. Close the browser session:
   ```bash
   playwright-cli close
   ```

**Commit**

```bash
git add web/src/components/title-bar.ts web/src/components/mux-pane-picker.ts
git commit -m "feat: enlarge mobile title bar to 44px touch target"
```

---

## Task 2: New-pane button in title bar (Issue 2a)

**Files:**
- Modify: `web/src/components/title-bar.ts`
- Modify: `web/src/app.ts`

### 2a. `title-bar.ts` — import `Plus`

Find:

```ts
import { icon } from '../lib/icons.js';
import { Ellipsis } from 'lucide';
```

Replace with:

```ts
import { icon } from '../lib/icons.js';
import { Ellipsis, Plus } from 'lucide';
```

### 2b. `title-bar.ts` — share button styles between the two buttons, add spacing

Find the block you edited in Task 1b (now reading `width: 44px; height: 44px;`):

```
    .launcher-btn {
      width: 44px;
      height: 44px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--chrome-text-bright);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-family: inherit;
    }

    .launcher-btn:hover {
      background: var(--chrome-hover);
    }
```

Replace the whole block with:

```
    .launcher-btn,
    .pane-btn {
      width: 44px;
      height: 44px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--chrome-text-bright);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-family: inherit;
    }

    .launcher-btn:hover,
    .pane-btn:hover {
      background: var(--chrome-hover);
    }
```

Also find the `.right` rule:

```
    .right {
      display: flex;
      align-items: center;
      position: relative;
    }
```

Replace with (adding a small gap so two adjacent 44px touch targets don't sit edge-to-edge):

```
    .right {
      display: flex;
      align-items: center;
      gap: 4px;
      position: relative;
    }
```

### 2c. `title-bar.ts` — add the dispatch method

Find the existing `_onWorkspaceSwitch` method:

```ts
  private _onWorkspaceSwitch(e: Event): void {
    e.stopPropagation();
    const customEvent = e as CustomEvent;
    this.dispatchEvent(
      new CustomEvent('workspace-switch', {
        bubbles: true,
        composed: true,
        detail: customEvent.detail,
      }),
    );
  }
```

Add a new method directly after it:

```ts

  private _requestNewPane(): void {
    this.dispatchEvent(
      new CustomEvent('pane-create-request', {
        bubbles: true,
        composed: true,
      }),
    );
  }
```

This is a deliberately new, distinctly-named event — not `launcher-action`. `launcher-action` semantically means "an item was picked from the overflow menu"; this button is a persistent, always-visible primary control outside that menu.

### 2d. `title-bar.ts` — add the button to the template

Find the `render()` method's `.right` div (as it stands after Task 1, unchanged by Task 1):

```html
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
```

Replace with:

```html
      <div class="right">
        <button
          class="pane-btn"
          title="New pane"
          aria-label="New pane"
          @click="${this._requestNewPane}"
        >${icon(Plus, { size: 20 })}</button>
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
```

(Note: the `.showCreateWorkspace` binding on `<mux-launcher-menu>` is added in Task 3, not here — don't add it yet.)

### 2e. `app.ts` — listen for `pane-create-request`

Find the `<mux-title-bar>` instantiation in `render()` (around line 692):

```html
      ${!isWide ? html`<mux-title-bar
        @launcher-action="${this._onLauncherAction}"
        @pane-select="${this._onActivePane}"
        @workspace-switch="${this._onWorkspaceSelected}"
      ></mux-title-bar>` : ''}
```

Replace with:

```html
      ${!isWide ? html`<mux-title-bar
        @launcher-action="${this._onLauncherAction}"
        @pane-select="${this._onActivePane}"
        @workspace-switch="${this._onWorkspaceSelected}"
        @pane-create-request="${this._createPaneOptimistic}"
      ></mux-title-bar>` : ''}
```

This reuses `_createPaneOptimistic` — the exact same handler the existing empty-state "+ New pane" button already calls (`app.ts:716`, `this._onCreatePane`). Zero new pane-creation logic. It always creates in `store.attached` (the current workspace), matching the existing empty-state button and desktop dockview "+" convention.

**Static Analysis**

```bash
cd /Users/ken/workspace/muxterm/.worktrees/mobile-touch-actions/web
npm run check:fast
```

Expected: `0 errors`.

**Verification**

1. Fresh `make dev-local` restart if not already running from Task 1's session; brand-new workspace (create a new one, don't reuse Task 1's).

2. Open at mobile viewport and locate the new button:
   ```bash
   playwright-cli open http://127.0.0.1:8313
   playwright-cli resize 390 844
   playwright-cli snapshot
   ```
   Confirm a second icon-only button ("New pane") is visible to the left of the kebab ("Open menu") button in the title bar.

3. Tap it for real:
   ```bash
   playwright-cli click "getByTitle('New pane')"
   ```
   (Or use the `e<N>` ref from the snapshot if `getByTitle` doesn't resolve uniquely.)

4. Confirm a new pane tab appeared and became active — check the breadcrumb in `mux-pane-picker` updated:
   ```bash
   playwright-cli snapshot
   ```
   Expected: the breadcrumb text now shows a new/incremented pane name (e.g. "Pane 2") and the pane count visible via the dropdown (tap the breadcrumb to open it) shows one more pane than before.

5. Confirm the new pane is a real working terminal, not a placeholder — type a character and see it echo:
   ```bash
   playwright-cli click e<breadcrumb-ref-or-terminal-ref>
   playwright-cli type "echo hello"
   playwright-cli press Enter
   playwright-cli snapshot
   ```
   Expected: `hello` appears in the terminal output — proving a real PTY is attached, not just a UI tab.

6. Close the session:
   ```bash
   playwright-cli close
   ```

**Commit**

```bash
git add web/src/components/title-bar.ts web/src/app.ts
git commit -m "feat: add persistent new-pane button to mobile title bar"
```

---

## Task 3: New-workspace menu entry in kebab (Issue 2b)

**Files:**
- Modify: `web/src/components/launcher-menu.ts`
- Modify: `web/src/components/title-bar.ts`
- Modify: `web/src/app.ts`

### 3a. `launcher-menu.ts` — imports

Find:

```ts
import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { icon } from '../lib/icons.js';
import { Info, Keyboard, RefreshCw, Settings } from 'lucide';

export type LauncherAction = 'settings' | 'shortcuts' | 'reconnect' | 'about';
```

Replace with:

```ts
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { icon } from '../lib/icons.js';
import { Info, Keyboard, Plus, RefreshCw, Settings } from 'lucide';

export type LauncherAction =
  | 'settings'
  | 'shortcuts'
  | 'reconnect'
  | 'about'
  | 'new-workspace';
```

### 3b. `launcher-menu.ts` — add the `showCreateWorkspace` property

Find:

```ts
  private _dispatch(action: LauncherAction): void {
```

Insert directly above it (still inside the class body):

```ts
  /**
   * Gated by the caller: <mux-title-bar> (narrow mode) sets this to `true` so
   * mobile users have a reachable "New workspace" action. <mux-sidebar>
   * (wide mode) leaves it at the default `false` — it already has its own
   * always-visible "+ New workspace" button, so surfacing it here too would
   * be a duplicate leaking into desktop.
   */
  @property({ type: Boolean })
  showCreateWorkspace = false;

  private _dispatch(action: LauncherAction): void {
```

### 3c. `launcher-menu.ts` — render the new item

Find the existing `render()` method:

```ts
  render() {
    return html`
      <button data-action="settings" @click="${() => this._dispatch('settings')}">
        ${icon(Settings, { size: 14 })} Settings
      </button>
      <button data-action="shortcuts" @click="${() => this._dispatch('shortcuts')}">
        ${icon(Keyboard, { size: 14 })} Keyboard Shortcuts
      </button>
      <button data-action="reconnect" @click="${() => this._dispatch('reconnect')}">
        ${icon(RefreshCw, { size: 14 })} Reconnect
      </button>
      <div class="divider"></div>
      <button data-action="about" @click="${() => this._dispatch('about')}">
        ${icon(Info, { size: 14 })} About
      </button>
    `;
  }
```

Replace with:

```ts
  render() {
    return html`
      ${this.showCreateWorkspace
        ? html`
            <button
              data-action="new-workspace"
              @click="${() => this._dispatch('new-workspace')}"
            >
              ${icon(Plus, { size: 14 })} New workspace
            </button>
            <div class="divider"></div>
          `
        : ''}
      <button data-action="settings" @click="${() => this._dispatch('settings')}">
        ${icon(Settings, { size: 14 })} Settings
      </button>
      <button data-action="shortcuts" @click="${() => this._dispatch('shortcuts')}">
        ${icon(Keyboard, { size: 14 })} Keyboard Shortcuts
      </button>
      <button data-action="reconnect" @click="${() => this._dispatch('reconnect')}">
        ${icon(RefreshCw, { size: 14 })} Reconnect
      </button>
      <div class="divider"></div>
      <button data-action="about" @click="${() => this._dispatch('about')}">
        ${icon(Info, { size: 14 })} About
      </button>
    `;
  }
```

Placement: "New workspace" at the top, followed by a divider — mirroring `mux-sidebar.ts`'s convention of visually separating content-creation actions from utility actions. Icon: `Plus`, same as the title-bar new-pane button, so "+" consistently means "create" across the UI.

### 3d. `title-bar.ts` — pass `showCreateWorkspace={true}`

Find (as it stands after Task 2):

```html
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu
                @launcher-action="${this._onLauncherAction}"
              ></mux-launcher-menu>
            </div>`
          : ''}
```

Replace with:

```html
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu
                .showCreateWorkspace="${true}"
                @launcher-action="${this._onLauncherAction}"
              ></mux-launcher-menu>
            </div>`
          : ''}
```

**Do not touch `mux-sidebar.ts`'s instantiation of `<mux-launcher-menu>`** — it passes nothing, so `showCreateWorkspace` defaults to `false` and its kebab menu renders exactly the original 4 items. This is the mechanism that keeps wide mode unaffected.

### 3e. `app.ts` — handle the new action

Find the existing switch in `_onLauncherAction` (around line 1100):

```ts
  private _onLauncherAction = (e: Event): void => {
    const action = (e as CustomEvent<{ action: LauncherAction }>).detail?.action;
    switch (action) {
      case 'settings':
      case 'shortcuts':
      case 'about':
        this._overlayPanel = action;
        break;
      case 'reconnect':
        window.location.reload();
        break;
    }
  };
```

Replace with:

```ts
  private _onLauncherAction = (e: Event): void => {
    const action = (e as CustomEvent<{ action: LauncherAction }>).detail?.action;
    switch (action) {
      case 'settings':
      case 'shortcuts':
      case 'about':
        this._overlayPanel = action;
        break;
      case 'reconnect':
        window.location.reload();
        break;
      case 'new-workspace':
        this._onOpenCreateModal();
        break;
    }
  };
```

This reuses the existing create-modal entirely unchanged (`_onOpenCreateModal` → `_showCreateModal = true` → the modal at `app.ts` lines ~755–780, submit via `_submitCreate`, guarded by `_creatingWorkspace`). No new modal logic, no new state.

**Static Analysis**

```bash
cd /Users/ken/workspace/muxterm/.worktrees/mobile-touch-actions/web
npm run check:fast
```

Expected: `0 errors`.

**Verification**

1. Fresh `make dev-local` restart; brand-new workspace.

2. Mobile viewport, real tap sequence:
   ```bash
   playwright-cli open http://127.0.0.1:8313
   playwright-cli resize 390 844
   playwright-cli snapshot
   playwright-cli click "getByTitle('Open menu')"
   playwright-cli snapshot
   ```
   Expected: kebab menu opens and shows "New workspace" at the top, followed by a divider, then Settings / Keyboard Shortcuts / Reconnect / divider / About.

3. Tap "New workspace":
   ```bash
   playwright-cli click "getByText('New workspace')"
   playwright-cli snapshot
   ```
   Expected: the create-workspace modal opens (`.ws-create-dialog` with an input and Cancel/Create buttons).

4. Type a name and submit:
   ```bash
   playwright-cli fill "getByPlaceholder('Workspace name')" "mobile-verify-ws"
   playwright-cli click "getByText('Create')"
   playwright-cli snapshot
   ```
   Expected: modal closes, the new workspace ("mobile-verify-ws") appears in `mux-pane-picker`'s workspace list, and the app auto-switches to it (breadcrumb shows the new workspace name).

5. **Wide-mode regression check — same task, don't skip this:**
   ```bash
   playwright-cli resize 1280 800
   playwright-cli snapshot
   ```
   Confirm `<mux-sidebar>` is now rendering (not `<mux-title-bar>`). Open the sidebar's kebab menu:
   ```bash
   playwright-cli click "getByTitle('Open menu')"
   playwright-cli snapshot
   ```
   Expected: **exactly the original 4 items** — Settings, Keyboard Shortcuts, Reconnect, About — with **no "New workspace" item** and no leading divider. If "New workspace" appears here, the `showCreateWorkspace` gating is broken — stop and fix before proceeding.

6. Close the session:
   ```bash
   playwright-cli close
   ```

**Commit**

```bash
git add web/src/components/launcher-menu.ts web/src/components/title-bar.ts web/src/app.ts
git commit -m "feat: add new-workspace action to mobile kebab menu"
```

---

## Task 4: Desktop/wide-mode regression pass (verification-only, no code changes)

This task makes no source changes. Its purpose is to produce a committed, real-execution proof that nothing in Tasks 1–3 leaked into or altered the wide/desktop experience — the design's explicit "wide/desktop mode: zero changes" requirement.

**Files:**
- Create: `docs/verification/2026-07-31-mobile-touch-actions-verification.md`

**Static Analysis:** None — no code changed in this task.

**Verification**

1. Fresh `make dev-local` restart; brand-new workspace.

2. Desktop viewport, well clear of the 768px boundary quirk:
   ```bash
   playwright-cli open http://127.0.0.1:8313
   playwright-cli resize 1280 800
   playwright-cli snapshot
   ```
   Confirm `<mux-sidebar>` renders (not `<mux-title-bar>`).

3. Dockview tab-strip height unchanged. Measure it:
   ```bash
   playwright-cli eval "document.querySelector('mux-dock')?.shadowRoot?.querySelector('.dv-tabs-and-actions-container')?.getBoundingClientRect().height"
   ```
   Expected: matches dockview-core's default tab-strip height (whatever it measured as before this feature branch — if you have a `main`-branch instance to compare against, do so; otherwise confirm it is NOT `44px`/`var(--mux-dock-height)` and NOT visually altered, since this design touched zero dockview/mux-dock code).

4. Sidebar's own "+ New workspace" button still works:
   ```bash
   playwright-cli click "getByText('+ New workspace')"
   playwright-cli fill "getByPlaceholder('Workspace name')" "desktop-regression-ws"
   playwright-cli click "getByText('Create')"
   playwright-cli snapshot
   ```
   Expected: new workspace created and switched to, same as before this feature branch existed.

5. Dockview's own "+" (new pane) button still works:
   ```bash
   playwright-cli snapshot
   playwright-cli click <ref-of-dockview-plus-button>
   playwright-cli snapshot
   ```
   Expected: a new pane tab appears in the dockview tab strip.

6. Sidebar kebab menu shows exactly 4 items, no "New workspace" (re-confirm — same check as Task 3 step 5, now as part of the dedicated regression pass):
   ```bash
   playwright-cli click "getByTitle('Open menu')"
   playwright-cli snapshot
   ```
   Expected: Settings, Keyboard Shortcuts, Reconnect, About only.

7. Close the session:
   ```bash
   playwright-cli close
   ```

Write the actual observed results (not fabricated placeholders — real values from the run above) into the verification report:

```markdown
# Mobile Touch Actions — Verification Report

Date: <fill in actual date>
Branch: feat/mobile-touch-actions
Dev instance: http://127.0.0.1:8313 (make dev-local, isolated from production 8311)

## Mobile viewport (390x844)

| # | Check | Expected | Actual | Result |
|---|-------|----------|--------|--------|
| 1 | mux-title-bar height | 44px | <fill in> | <PASS/FAIL> |
| 2 | .launcher-btn height | 44px | <fill in> | <PASS/FAIL> |
| 3 | New-pane button creates real working pane (echo test) | terminal echoes typed text | <fill in> | <PASS/FAIL> |
| 4 | Kebab shows "New workspace" at top + divider | present | <fill in> | <PASS/FAIL> |
| 5 | New-workspace flow: tap -> modal -> submit -> switch | workspace created & switched | <fill in> | <PASS/FAIL> |

## Desktop viewport (1280x800) — regression

| # | Check | Expected | Actual | Result |
|---|-------|----------|--------|--------|
| 6 | mux-sidebar renders, not mux-title-bar | sidebar visible | <fill in> | <PASS/FAIL> |
| 7 | Dockview tab-strip height unchanged | unaffected by --mux-dock-height | <fill in> | <PASS/FAIL> |
| 8 | Sidebar "+ New workspace" still works | workspace created | <fill in> | <PASS/FAIL> |
| 9 | Dockview's own "+" still works | new pane created | <fill in> | <PASS/FAIL> |
| 10 | Sidebar kebab shows exactly 4 items, no "New workspace" | Settings/Shortcuts/Reconnect/About only | <fill in> | <PASS/FAIL> |

## Verdict

<PASS — all 10 checks green | FAIL — list failing checks with actual values>
```

If any check fails, stop here — do not commit a report claiming pass for a check that failed. Fix the underlying issue in the relevant task's files first (Tasks 1–3), re-verify, then complete this report.

**Commit**

```bash
git add docs/verification/2026-07-31-mobile-touch-actions-verification.md
git commit -m "test: verify wide-mode regression for mobile touch actions"
```

---

## Done

After Task 4's commit, all four tasks are complete: mobile title bar has 44px touch targets, a persistent new-pane button, a new-workspace kebab entry gated correctly behind `showCreateWorkspace`, and a committed real-execution proof that desktop/wide mode is unaffected.

Do not `git push` or open a PR as part of this plan — that happens in a later phase (see `finishing-a-development-branch`).
