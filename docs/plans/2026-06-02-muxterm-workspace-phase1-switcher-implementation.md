# muxterm Workspace — Phase 1: Status-bar Switcher Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Put a clickable workspace-switcher chip in the bottom-left status bar, re-anchor the existing `mux-workspace-picker` as an upward dropdown, and trim the status bar (drop the misleading window count and the redundant `[session] · editor · %1` segment).

**Architecture:** The switcher is **not** a new custom element — it is markup/logic inside the existing `mux-status-bar` Lit component. The chip shows the current workspace label (via the existing `workspaceLabel()` helper, with an id fallback) and emits a single bubbling `open-workspace-picker` event. `app.ts` listens for that event, toggles its existing `_showWorkspacePicker` state, and renders the existing `mux-workspace-picker` unchanged — only the picker's CSS changes from a centered full-screen overlay to a bottom-left, upward-opening dropdown. No new socket messages, no new picker events.

**Tech Stack:** Lit + TypeScript web UI (`web/src/`), built with Vite, tested with vitest (jsdom). Backed by a Go `sessiond` daemon (untouched this phase).

---

## Phase Context (read before starting)

This is **Phase 1 of 3**. Stay strictly inside Phase 1.

- **Phase 1 (THIS PLAN):** status-bar workspace switcher chip + re-anchor the reused `mux-workspace-picker` as an upward dropdown + trim the status bar.
- **Phase 2 (NOT here):** app `⋯` menu → app-level, `session`→`workspace` terminology renames, terminology guard test.
- **Phase 3 (NOT here):** dead-code deletion of the orphaned tmux cluster.

Do **not** rename unrelated `session` strings, do **not** touch the `⋯` / launcher menu, and do **not** delete any files in this phase.

## Conventions verified in this codebase (do not deviate)

- **Test location:** component/unit tests live in **`web/src/__tests__/`** (e.g. `web/src/__tests__/status-bar.test.ts`, `web/src/__tests__/app.test.ts`). The status-bar test **already exists** at `web/src/__tests__/status-bar.test.ts` — you will **rewrite it in place**, not create a new file under `components/`.
- **Test framework:** vitest with the jsdom DOM. Components are exercised by `document.createElement('mux-...')`, setting properties, appending to `document.body`, and awaiting `el.updateComplete`. (See `web/src/components/region.test.ts` for the pattern.)
- **Imports** use explicit `.js` extensions (e.g. `import { workspaceLabel } from './workspace-picker.js'`). TypeScript is `strict: true`.
- **The label helper** is named `workspaceLabel(ws)` and is exported from `web/src/components/workspace-picker.ts` (the design's prose name "labelForWorkspace()" refers to this same helper). It returns the explicit name, else `Workspace <id>`.
- **The workspace info type** is `SessiondWorkspaceInfo` from `web/src/types.ts`: `{ workspaceId: string; name?: string; paneCount: number }`.

## Commands (used throughout)

- Run one test file: `cd web && npx vitest run src/__tests__/status-bar.test.ts`
- Run one test file: `cd web && npx vitest run src/__tests__/app.test.ts`
- Full web suite: `cd web && npm test`
- Type check: `cd web && npx tsc --noEmit`
- Production build: `cd web && npx vite build`

## Commit footer (append to EVERY commit message body)

```
🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
```

**Do NOT git push, merge, or open a PR.** Commit locally only. **Do NOT commit this plan document.**

---

## Task 1: Redesign `mux-status-bar` — workspace switcher chip + trim count

This redesigns the small (~130 line) `status-bar.ts` component as one cohesive unit: add the switcher chip and remove the count/segment. Because the existing tests are tightly coupled to the old props, we rewrite the test file and the component together.

**Files:**
- Modify: `web/src/components/status-bar.ts`
- Test: `web/src/__tests__/status-bar.test.ts` (exists — rewrite in place)

**Step 1: Write the failing tests**

Replace the **entire** contents of `web/src/__tests__/status-bar.test.ts` with:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/status-bar.js';

import type { MuxStatusBar } from '../components/status-bar.js';
import type { SessiondWorkspaceInfo } from '../types.js';

async function fixture(
  props: Partial<{
    workspaces: SessiondWorkspaceInfo[];
    currentWorkspaceId: string;
    connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
    driverActive: boolean;
  }> = {},
): Promise<MuxStatusBar> {
  const el = document.createElement('mux-status-bar') as MuxStatusBar;
  if (props.workspaces !== undefined) el.workspaces = props.workspaces;
  if (props.currentWorkspaceId !== undefined) el.currentWorkspaceId = props.currentWorkspaceId;
  if (props.connectionStatus !== undefined) el.connectionStatus = props.connectionStatus;
  if (props.driverActive !== undefined) el.driverActive = props.driverActive;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxStatusBar', () => {
  let el: MuxStatusBar;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });

  it('registers as mux-status-bar custom element', () => {
    expect(customElements.get('mux-status-bar')).toBeDefined();
  });

  it('renders the workspace switcher with the current workspace name', async () => {
    el = await fixture({
      workspaces: [{ workspaceId: 'w1', name: 'work', paneCount: 1 }],
      currentWorkspaceId: 'w1',
    });
    const chip = el.shadowRoot!.querySelector('.workspace-switcher');
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain('work');
  });

  it('falls back to the workspace id when the workspace is unnamed', async () => {
    el = await fixture({
      workspaces: [{ workspaceId: 'w2', paneCount: 1 }],
      currentWorkspaceId: 'w2',
    });
    const chip = el.shadowRoot!.querySelector('.workspace-switcher');
    expect(chip!.textContent).toContain('w2');
  });

  it('emits open-workspace-picker (bubbles, composed) when the switcher is clicked', async () => {
    el = await fixture({
      workspaces: [{ workspaceId: 'w1', name: 'work', paneCount: 1 }],
      currentWorkspaceId: 'w1',
    });
    const handler = vi.fn();
    el.addEventListener('open-workspace-picker', handler);

    const chip = el.shadowRoot!.querySelector('.workspace-switcher') as HTMLButtonElement;
    chip.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
  });

  it('shows no window / session / pane count text', async () => {
    el = await fixture({
      workspaces: [
        { workspaceId: 'w1', name: 'work', paneCount: 1 },
        { workspaceId: 'w2', name: 'agents', paneCount: 3 },
      ],
      currentWorkspaceId: 'w1',
    });
    const text = el.shadowRoot!.textContent ?? '';
    expect(text).not.toContain('window');
    expect(text).not.toContain('session');
    expect(text).not.toContain('panes');
  });

  it('shows "connected" status with correct class', async () => {
    el = await fixture({ connectionStatus: 'connected' });
    const status = el.shadowRoot!.querySelector('.right .connected');
    expect(status).toBeTruthy();
    expect(status!.textContent!.toLowerCase()).toContain('connected');
  });

  it('shows "disconnected" status with correct class', async () => {
    el = await fixture({ connectionStatus: 'disconnected' });
    expect(el.shadowRoot!.querySelector('.right .disconnected')).toBeTruthy();
  });

  it('shows "reconnecting" status with correct class', async () => {
    el = await fixture({ connectionStatus: 'reconnecting' });
    expect(el.shadowRoot!.querySelector('.right .reconnecting')).toBeTruthy();
  });

  it('defaults connectionStatus to disconnected', async () => {
    el = await fixture();
    expect(el.shadowRoot!.querySelector('.right .disconnected')).toBeTruthy();
  });

  it('has left and right sections', async () => {
    el = await fixture({ connectionStatus: 'connected' });
    expect(el.shadowRoot!.querySelector('.left')).toBeTruthy();
    expect(el.shadowRoot!.querySelector('.right')).toBeTruthy();
  });
});

describe('MuxStatusBar goal segment', () => {
  let el: MuxStatusBar;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });

  it('hides .goal when driverActive is false', async () => {
    el = await fixture({ driverActive: false });
    expect(el.shadowRoot!.querySelector('.goal')).toBeNull();
  });

  it('shows the goal span when driverActive is true', async () => {
    el = await fixture({ driverActive: true });
    const goal = el.shadowRoot!.querySelector('.goal');
    expect(goal).toBeTruthy();
    expect(goal!.textContent).toContain('goal');
  });
});
```

**Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/__tests__/status-bar.test.ts`

Expected: **FAIL.** The new tests reference props that don't exist yet (`workspaces`, `currentWorkspaceId`) and a `.workspace-switcher` element the component doesn't render yet; the "no window / session / pane count text" test fails because the old render still prints `windows` / `[session]` / `panes`.

**Step 3: Rewrite the component implementation**

Replace the **entire** contents of `web/src/components/status-bar.ts` with:

```ts
import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ChevronUp, Target } from 'lucide';
import { CHROME } from '../lib/theme.js';
import { icon } from '../lib/icons.js';
import { workspaceLabel } from './workspace-picker.js';
import type { SessiondWorkspaceInfo } from '../types.js';

@customElement('mux-status-bar')
export class MuxStatusBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      justify-content: space-between;
      background: ${unsafeCSS(CHROME.bar)};
      border-top: 1px solid ${unsafeCSS(CHROME.border)};
      height: 24px;
      padding: 0 12px;
      font-size: 12px;
      color: ${unsafeCSS(CHROME.textDim)};
      flex-shrink: 0;
      user-select: none;
    }

    .left,
    .right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    /* Workspace switcher: the single meaningful control on the left. */
    .workspace-switcher {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--mux-accent);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }

    .workspace-switcher:hover {
      color: #cdd6f4;
    }

    .connected {
      color: var(--mux-ok);
    }

    .disconnected {
      color: var(--mux-error);
    }

    .reconnecting {
      color: var(--mux-warn);
    }

    .goal {
      display: flex;
      align-items: center;
      gap: 4px;
      color: ${unsafeCSS(CHROME.driverAccent)};
      font-weight: 600;
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }
  `;

  @property({ attribute: false })
  workspaces: SessiondWorkspaceInfo[] = [];

  @property({ type: String })
  currentWorkspaceId = '';

  @property({ type: String })
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

  @property({ type: Boolean })
  driverActive = false;

  private _statusText(): string {
    switch (this.connectionStatus) {
      case 'connected':
        return 'connected';
      case 'disconnected':
        return 'disconnected';
      case 'reconnecting':
        return 'reconnecting';
    }
  }

  /**
   * Label for the current workspace: prefer the explicit name (via the shared
   * workspaceLabel helper), otherwise fall back to the workspace id — never a
   * random auto-name.
   */
  private _currentLabel(): string {
    const ws = this.workspaces.find((w) => w.workspaceId === this.currentWorkspaceId);
    if (ws) return workspaceLabel(ws);
    return this.currentWorkspaceId || 'no workspace';
  }

  private _onSwitcherClick(): void {
    this.dispatchEvent(
      new CustomEvent('open-workspace-picker', { bubbles: true, composed: true }),
    );
  }

  render() {
    return html`
      <div class="left">
        <button
          class="workspace-switcher"
          title="Switch workspace"
          @click="${this._onSwitcherClick}"
        >
          <span class="ws-label">${this._currentLabel()}</span>
          ${icon(ChevronUp, { size: 12 })}
        </button>
      </div>
      <div class="right">
        ${this.driverActive
          ? html`<span class="goal">${icon(Target, { size: 12 })} goal</span>`
          : ''}
        <span class="${this.connectionStatus}">${this._statusText()}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-status-bar': MuxStatusBar;
  }
}
```

**Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/__tests__/status-bar.test.ts`

Expected: **PASS** — all `MuxStatusBar` and `MuxStatusBar goal segment` tests green.

**Step 5: Commit**

```
cd web && git add src/components/status-bar.ts src/__tests__/status-bar.test.ts && git commit -m "feat(web): add workspace switcher chip to status bar, drop window count

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 2: Rewire `app.ts` to feed and listen to the new status bar

The `<mux-status-bar>` render still passes the removed props (`sessionName`, `windowCount`, `paneCount`, `activeWindowName`) and listens for the old `@open-session-picker` event. Swap to the new props/event and make the handler toggle the picker. Update the `app.test.ts` assertions that depend on the old props/event.

**Files:**
- Modify: `web/src/app.ts` (status-bar render ≈ lines 309–316; `activeTitle` ≈ line 287; handler `_onOpenSessionPicker` ≈ lines 371–373)
- Test: `web/src/__tests__/app.test.ts` (3 existing tests reference the old shape — update them)

> Verify the exact current line numbers with your editor before editing; they may have shifted.

**Step 1: Update the failing tests first**

In `web/src/__tests__/app.test.ts`, make these three edits.

(a) Replace the test that reads the `sessionname` attribute:

```ts
  it('renders mux-status-bar with the attached workspace id', async () => {
    el = await fixture();
    const statusBar = el.shadowRoot!.querySelector('mux-status-bar');
    expect(statusBar).toBeTruthy();
    expect(statusBar!.getAttribute('sessionname')).toBe('ws-1');
  });
```

with:

```ts
  it('passes the attached workspace id to the status bar', async () => {
    el = await fixture();
    const statusBar = el.shadowRoot!.querySelector('mux-status-bar') as any;
    expect(statusBar).toBeTruthy();
    expect(statusBar.currentWorkspaceId).toBe('ws-1');
  });
```

(b) Replace the test that reads `statusBar.paneCount`:

```ts
  it('passes paneCount and workspace count to status bar', async () => {
    el = await fixture();
    const statusBar = el.shadowRoot!.querySelector('mux-status-bar') as any;
    expect(statusBar).toBeTruthy();
    // paneCount should be 2 (two panes in the composition)
    expect(statusBar.paneCount).toBe(2);
  });
```

with:

```ts
  it('passes the workspace list to the status bar', async () => {
    el = await fixture();
    const statusBar = el.shadowRoot!.querySelector('mux-status-bar') as any;
    expect(statusBar).toBeTruthy();
    expect(Array.isArray(statusBar.workspaces)).toBe(true);
  });
```

(c) Replace the `open-session-picker` event test:

```ts
    it('open-session-picker from mux-status-bar opens the workspace picker', async () => {
      el = await fixture();
      expect((el as any)._showWorkspacePicker).toBe(false);
      const statusBar = el.shadowRoot!.querySelector('mux-status-bar')!;
      statusBar.dispatchEvent(
        new CustomEvent('open-session-picker', { bubbles: true, composed: true }),
      );
      await el.updateComplete;
      expect((el as any)._showWorkspacePicker).toBe(true);
    });
```

with:

```ts
    it('open-workspace-picker from mux-status-bar opens the workspace picker', async () => {
      el = await fixture();
      expect((el as any)._showWorkspacePicker).toBe(false);
      const statusBar = el.shadowRoot!.querySelector('mux-status-bar')!;
      statusBar.dispatchEvent(
        new CustomEvent('open-workspace-picker', { bubbles: true, composed: true }),
      );
      await el.updateComplete;
      expect((el as any)._showWorkspacePicker).toBe(true);
    });
```

**Step 2: Run the app tests to verify they fail**

Run: `cd web && npx vitest run src/__tests__/app.test.ts`

Expected: **FAIL.** The updated tests fail because `app.ts` still passes `sessionName`/`paneCount` and listens for `@open-session-picker` (so `currentWorkspaceId` is undefined, `workspaces` is not passed, and the renamed event is unhandled).

**Step 3: Update `app.ts` — status-bar render block**

Replace the `<mux-status-bar>` block:

```ts
      <mux-status-bar
        sessionName="${store.attached ?? ''}"
        .windowCount="${store.workspaces.length}"
        .paneCount="${panes.length}"
        activeWindowName="${activeTitle}"
        connectionStatus="${this._connectionStatus}"
        @open-session-picker="${this._onOpenSessionPicker}"
      ></mux-status-bar>
```

with:

```ts
      <mux-status-bar
        .workspaces="${store.workspaces}"
        .currentWorkspaceId="${store.attached ?? ''}"
        connectionStatus="${this._connectionStatus}"
        @open-workspace-picker="${this._onOpenWorkspacePicker}"
      ></mux-status-bar>
```

**Step 4: Update `app.ts` — remove the now-unused `activeTitle` local**

In `render()`, delete the line:

```ts
    const activeTitle = panes.find((p) => p.paneId === arrangement.active)?.title ?? '';
```

(It was only consumed by the old `activeWindowName` prop. `strict` + lint will complain about the unused local if you leave it.)

**Step 5: Update `app.ts` — rename the handler and make it toggle**

Replace:

```ts
  private _onOpenSessionPicker = (): void => {
    this._showWorkspacePicker = true;
  };
```

with:

```ts
  private _onOpenWorkspacePicker = (): void => {
    this._showWorkspacePicker = !this._showWorkspacePicker;
  };
```

**Step 6: Run the app tests to verify they pass**

Run: `cd web && npx vitest run src/__tests__/app.test.ts`

Expected: **PASS** — including the three updated tests and the existing "Workspace Picker" describe block.

**Step 7: Type-check (this task is integration glue)**

Run: `cd web && npx tsc --noEmit`

Expected: **no errors.** If `tsc` reports an unused `activeTitle`, you missed Step 4. If it reports unknown property `_onOpenSessionPicker`, you missed a reference rename — grep `cd web && grep -rn "_onOpenSessionPicker\|open-session-picker" src/` and confirm zero remaining hits.

**Step 8: Commit**

```
cd web && git add src/app.ts src/__tests__/app.test.ts && git commit -m "feat(web): wire status bar to workspace switcher event and props

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 3: Re-anchor the workspace picker as a bottom-left upward dropdown

The picker's behavior and events are unchanged — only its presentation moves from a centered, dimmed full-screen overlay to a bottom-left dropdown that grows upward (anchored just above the status bar). This is a CSS-only change in `workspace-picker.ts`; `app.ts` already renders the picker and is untouched here.

**Files:**
- Modify: `web/src/components/workspace-picker.ts` (the `.overlay` and `.picker` rules in `static styles`)

**Step 1: Edit the `.overlay` rule**

Replace:

```ts
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    }
```

with:

```ts
    .overlay {
      /* Full-screen hit area for click-away, but visually transparent: the
         picker is now a bottom-left dropdown, not a centered modal. */
      position: fixed;
      inset: 0;
      background: transparent;
      display: flex;
      align-items: flex-end; /* anchor to the bottom */
      justify-content: flex-start; /* anchor to the left */
      padding: 0 0 32px 12px; /* sit just above the status bar, hug the left */
      z-index: 2000;
    }
```

**Step 2: Edit the `.picker` rule**

Replace:

```ts
    .picker {
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 8px;
      padding: 24px;
      min-width: 320px;
      max-width: 480px;
    }
```

with:

```ts
    .picker {
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 8px;
      padding: 16px;
      min-width: 280px;
      max-width: 420px;
      max-height: 70vh;
      overflow-y: auto;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }
```

Leave **everything else** in `workspace-picker.ts` unchanged — the `workspaceLabel` export, all `@click` handlers, and all emitted events (`workspace-selected` / `workspace-create` / `workspace-rename` / `workspace-close` / `close-picker`) must stay exactly as they are.

**Step 3: Verify the picker still renders and types are clean**

Run: `cd web && npx vitest run src/__tests__/app.test.ts && npx tsc --noEmit`

Expected: **PASS / no errors.** The app's "Workspace Picker" tests (which assert `mux-workspace-picker` renders when `_showWorkspacePicker` is true and that selection disposes + attaches) remain green — behavior is unchanged, only CSS moved.

**Step 4: Commit**

```
cd web && git add src/components/workspace-picker.ts && git commit -m "feat(web): re-anchor workspace picker as bottom-left upward dropdown

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Task 4: Final gate — full suite, types, and build all green

A verification-only task: no code changes. Confirm the whole web project is healthy after Phase 1. If anything fails, fix the offending task above (do not paper over it here) and re-run.

**Files:** none (verification only).

**Step 1: Type check the whole project**

Run: `cd web && npx tsc --noEmit`

Expected: **no errors.** Common miss: a leftover reference to a removed prop (`sessionName`/`windowCount`/`paneCount`/`activeWindowName`) or the old `_onOpenSessionPicker`/`open-session-picker` name. Grep to confirm none remain:

Run: `cd web && grep -rn "windowCount\|activeWindowName\|open-session-picker\|_onOpenSessionPicker" src/`

Expected: **no matches.**

**Step 2: Run the full web test suite**

Run: `cd web && npm test`

Expected: **all tests pass.** (The previously-existing status-bar tests for window/session/pane counts are intentionally gone — replaced by the switcher tests in Task 1.)

**Step 3: Production build**

Run: `cd web && npx vite build`

Expected: **build succeeds** with no type/transform errors.

**Step 4: Confirm completion (no commit needed)**

This task makes no file changes, so there is nothing to commit. Phase 1 is complete when Steps 1–3 are all green. Report the three command results (tsc clean / npm test green / vite build clean) as the completion evidence.

---

## Phase 1 Done Criteria

- Status bar renders a clickable workspace-switcher chip on the left showing the current workspace label (id fallback when unnamed); clicking it emits `open-workspace-picker`.
- The status bar no longer shows a window count, the `[session]` segment, or pane counts; the right side keeps theme/connection state (and the goal segment).
- `app.ts` feeds the status bar `.workspaces` + `.currentWorkspaceId`, listens for `open-workspace-picker`, and toggles `_showWorkspacePicker`.
- The reused `mux-workspace-picker` opens as a bottom-left upward dropdown; all its events are unchanged.
- `tsc --noEmit` clean, `vite build` clean, full `npm test` green.

## Out of Scope (do NOT do in Phase 1)

- The `⋯` / launcher menu changes and `session`→`workspace` terminology renames (Phase 2).
- The terminology-guard test (Phase 2).
- Deleting any tmux-era files or message paths (Phase 3).
- Any daemon / Go changes.
