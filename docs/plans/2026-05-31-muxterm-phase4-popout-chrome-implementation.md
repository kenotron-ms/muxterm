# muxterm Phase 4 — Pop-out OS Window + Full Chrome — Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Add the `window.open` pop-out presentation and build the validated VS Code-style chrome (in-page title bar + global ⋯ launcher, per-region tab strips with session picker, region ⋯ menu, ⊡ maximize) plus the two non-terminal surfaces (browser iframe, settings panel) and the status-bar goal segment — on top of Phase 3's dock.

**Architecture:** Lit v3 web components, each new piece is a standalone custom element that takes props in and emits `CustomEvent`s out (`bubbles: true, composed: true`), wired together in `app.ts` and the Phase-3 `region.ts`. Pop-out is a small lifecycle library (`popout.ts`) over `window.open`; the popped window **owns its own control client** (v1 simplification — see Task 3). Terminal vs non-terminal rendering is a routing branch keyed on a new `SurfaceKind` type.

**Tech Stack:** TypeScript, Lit v3, xterm.js v6, Vite, Vitest (happy-dom), Go backend (already serving on `localhost:8080`), `playwright-cli` for E2E against the running `make dev` server.

---

## Before you start — orientation (read this once)

**Visual source of truth — match these exactly:**
- Design doc *UX & Chrome* section: `docs/plans/2026-05-30-muxterm-panes-multisession-driver-design.md` (lines ~410–569). Read it fully.
- Mockups (Tokyo Night, VS Code-style flat tabs): `docs/plans/mockups/2026-05-30-muxterm-chrome/{1-current,2-dock,3-driver,4-sessions,5-more,6-launcher}.png`. Editable HTML/CSS sources in `.../src/`.
- Storyboard state-flow: `docs/plans/mockups/2026-05-30-muxterm-chrome/storyboard.svg`.

**Design constants you will reuse everywhere (Tokyo Night):**
- Accent (normal): `#7aa2f7` (blue). Driver region accent: `#bb9af7` (magenta).
- Chrome surfaces: `#16161e` (bars), `#1a1b26` (body), borders `#292e42`, dim text `#565f89`, bright text `#c0caf5`.
- Style language: **flat seamless tabs** (no cards), **active tab has a thin top-accent line + body-matching background** (reads "connected" to the body), **flat borderless icon-buttons with hover background**.

**Codebase conventions (follow them or the build/tests fail):**
- Components live in `web/src/components/*.ts`, libs in `web/src/lib/*.ts`, tests in `web/src/__tests__/*.test.ts`.
- Lit imports: `import { LitElement, html, css, nothing } from 'lit';` and `import { customElement, property, state } from 'lit/decorators.js';`
- **All relative imports use the `.js` extension** (e.g. `import './foo.js'`), even for `.ts` files.
- Every component ends with a `declare global { interface HTMLElementTagNameMap { 'mux-x': MuxX } }` block.
- Events bubble + compose: `new CustomEvent('name', { bubbles: true, composed: true, detail })`.
- Tests use happy-dom; pattern is `document.createElement(...)`, set props, `document.body.appendChild(el)`, `await el.updateComplete`, then assert against `el.shadowRoot!.querySelector(...)`.
- Run web unit tests from `web/`: `npm test` (this is `vitest run`).

**Dependency on Phase 3:** This phase modifies `web/src/components/region.ts` and `web/src/components/workspace.ts`, which are **created by the Phase 3 plan**. Phase 3 must be merged before Tasks 12–14. Tasks 2–11 create brand-new standalone files and do **not** depend on Phase 3 — do them first. Each integration task tells you to `read_file` the Phase-3 file first and adapt the named integration points.

**Per-task git discipline:** every task ends with a commit. Never batch commits.

---

## Task 1: Preflight — confirm environment and green baseline

**Files:** none (verification only)

**Step 1: Confirm the dev server is up (port from `cmd/muxterm/cli.go`, expected `:8080`)**
Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/`
Expected: `200`
(If not 200, ask the user to confirm `make dev` is running before continuing.)

**Step 2: Confirm `playwright-cli` is available (needed in Task 15)**
Run: `playwright-cli --version || npx --no-install playwright-cli --version`
Expected: a version string prints (no "command not found"). If global is missing but `npx` works, prefix all Task-15 commands with `npx`.

**Step 3: Confirm the web unit test baseline is green**
Run: `cd web && npm test`
Expected: all existing suites pass (e.g. `Test Files  N passed`, `Tests  M passed`). If anything is red here, STOP and report — do not build on a red baseline.

**Step 4: Confirm Phase-3 deliverables (region/workspace) — record presence for later**
Run: `ls web/src/components/region.ts web/src/components/workspace.ts 2>&1`
Expected: both paths exist (Phase 3 merged). If they are missing, do Tasks 2–11 now and pause before Tasks 12–14 until Phase 3 lands.

**Step 5: Commit (marker commit so the phase has a clean starting point)**
Run: `git commit --allow-empty -m "chore: begin phase 4 (pop-out + chrome)"`

---

## Task 2: Add VS Code tab + chrome design tokens to the theme

**Files:**
- Modify: `web/src/lib/theme.ts`
- Test: `web/src/__tests__/theme.test.ts` (create)

**Step 1: Write the failing test**
Create `web/src/__tests__/theme.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { THEME, CHROME } from '../lib/theme.js';

describe('theme tokens', () => {
  it('keeps the Tokyo Night terminal palette intact', () => {
    expect(THEME.background).toBe('#1a1b26');
    expect(THEME.blue).toBe('#7aa2f7');
    expect(THEME.magenta).toBe('#bb9af7');
  });

  it('exposes VS Code chrome tokens for tabs/bars', () => {
    expect(CHROME.bar).toBe('#16161e');
    expect(CHROME.body).toBe('#1a1b26');
    expect(CHROME.border).toBe('#292e42');
    expect(CHROME.textDim).toBe('#565f89');
    expect(CHROME.textBright).toBe('#c0caf5');
    expect(CHROME.accent).toBe('#7aa2f7');
    expect(CHROME.driverAccent).toBe('#bb9af7');
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- theme`
Expected: FAIL — `CHROME` is `undefined` / has no export.

**Step 3: Implement — append the `CHROME` token set to `theme.ts`**
Append to the end of `web/src/lib/theme.ts` (keep the existing `THEME` export untouched):
```ts

// VS Code-style chrome tokens (bars, tabs, buttons). Separate from THEME (which
// is the xterm.js terminal palette) so chrome and terminal can't drift apart.
// Driver region uses the magenta accent as a visual cue only.
export const CHROME = {
  bar: '#16161e',        // title bar / tab strip / status bar background
  body: '#1a1b26',       // surface body — active tab merges into this
  border: '#292e42',     // hairline separators
  textDim: '#565f89',    // inactive tab / muted labels
  textBright: '#c0caf5', // active tab / focused text
  accent: '#7aa2f7',     // normal active-tab top line + focus accent
  driverAccent: '#bb9af7', // driver region accent (magenta)
  hover: '#1f2335',      // flat icon-button hover background
  danger: '#f7768e',     // close-× hover
};
```

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- theme`
Expected: PASS (2 tests).

**Step 5: Commit**
Run: `git add web/src/lib/theme.ts web/src/__tests__/theme.test.ts && git commit -m "feat(web): add VS Code chrome design tokens"`

---

## Task 3: Pop-out lifecycle library (`popout.ts`)

**Files:**
- Create: `web/src/lib/popout.ts`
- Test: `web/src/__tests__/popout.test.ts` (create)

> **v1 ownership decision (design open-question resolved for v1):** the popped window **owns its own control client** — it loads the same app URL with `?popout=<regionId>` and opens its own WebSocket to the same Go backend. The main document only tracks the handle and fires `onClose` so the region can be **remounted** in-page. Pop-out **moves** the surface (one-window-one-surface invariant); it never duplicates it. The "proxy IO back to the main document" alternative is noted as deferred.

**Step 1: Write the failing test**
Create `web/src/__tests__/popout.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PopoutManager } from '../lib/popout.js';

// A fake window handle whose `closed` flag the test controls.
function fakeWindow() {
  return { closed: false, close: vi.fn(function (this: { closed: boolean }) { this.closed = true; }) };
}

describe('PopoutManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens a popout and reports it as popped-out', () => {
    const win = fakeWindow();
    const open = vi.fn(() => win as unknown as Window);
    const mgr = new PopoutManager({ open, pollIntervalMs: 100, origin: 'http://x' });

    mgr.popOut({ regionId: 'r1', onClose: () => {} });

    expect(open).toHaveBeenCalledOnce();
    const url = open.mock.calls[0][0];
    expect(url).toContain('popout=r1');
    expect(mgr.isPoppedOut('r1')).toBe(true);
  });

  it('fires onClose and clears state when the popped window is closed', () => {
    const win = fakeWindow();
    const onClose = vi.fn();
    const mgr = new PopoutManager({ open: () => win as unknown as Window, pollIntervalMs: 100, origin: 'http://x' });

    mgr.popOut({ regionId: 'r1', onClose });
    win.closed = true;            // user closed the OS window
    vi.advanceTimersByTime(100);  // next poll observes it

    expect(onClose).toHaveBeenCalledOnce();
    expect(mgr.isPoppedOut('r1')).toBe(false);
  });

  it('is idempotent — popping an already-popped region does not open twice', () => {
    const open = vi.fn(() => fakeWindow() as unknown as Window);
    const mgr = new PopoutManager({ open, pollIntervalMs: 100, origin: 'http://x' });
    mgr.popOut({ regionId: 'r1', onClose: () => {} });
    mgr.popOut({ regionId: 'r1', onClose: () => {} });
    expect(open).toHaveBeenCalledOnce();
  });

  it('throws "popout-blocked" when the browser blocks the popup', () => {
    const mgr = new PopoutManager({ open: () => null, pollIntervalMs: 100, origin: 'http://x' });
    expect(() => mgr.popOut({ regionId: 'r1', onClose: () => {} })).toThrow('popout-blocked');
  });

  it('close() shuts the window and fires onClose via the poll', () => {
    const win = fakeWindow();
    const onClose = vi.fn();
    const mgr = new PopoutManager({ open: () => win as unknown as Window, pollIntervalMs: 100, origin: 'http://x' });
    mgr.popOut({ regionId: 'r1', onClose });
    mgr.close('r1');
    vi.advanceTimersByTime(100);
    expect(win.close).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- popout`
Expected: FAIL — cannot resolve `../lib/popout.js`.

**Step 3: Implement `web/src/lib/popout.ts`**
```ts
// Pop-out lifecycle: move a region into a second OS browser window via window.open.
//
// v1 ownership model: the popped window OWNS ITS OWN control client. It loads the
// same app URL with ?popout=<regionId> and opens its own WebSocket to the same Go
// backend. The main document tracks the handle and, when the popped window closes,
// fires onClose so the region can be remounted in-page. Pop-out MOVES the surface
// (one-window-one-surface invariant) — it never duplicates it.

export interface PopoutOptions {
  regionId: string;
  /** URL the popped window loads. Defaults to current origin + ?popout=<regionId>. */
  url?: string;
  /** window.open feature string. */
  features?: string;
  /** Fired exactly once when the popped window is closed (by user or close()). */
  onClose: () => void;
}

export interface PopoutHandle {
  regionId: string;
  close(): void;
  readonly open: boolean;
}

type WindowOpener = (url: string, target: string, features: string) => Window | null;

export interface PopoutManagerOptions {
  open?: WindowOpener;
  pollIntervalMs?: number;
  origin?: string;
}

interface Entry {
  win: Window;
  timer: ReturnType<typeof setInterval>;
  closed: boolean;
}

export class PopoutManager {
  private _open: WindowOpener;
  private _pollMs: number;
  private _origin: string;
  private _handles = new Map<string, Entry>();

  constructor(opts: PopoutManagerOptions = {}) {
    this._open = opts.open ?? ((u, t, f) => globalThis.open(u, t, f));
    this._pollMs = opts.pollIntervalMs ?? 400;
    this._origin = opts.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  }

  isPoppedOut(regionId: string): boolean {
    const e = this._handles.get(regionId);
    return !!e && !e.closed;
  }

  popOut(options: PopoutOptions): PopoutHandle {
    if (this.isPoppedOut(options.regionId)) return this._handleFor(options.regionId)!;

    const url =
      options.url ?? `${this._origin}/?popout=${encodeURIComponent(options.regionId)}`;
    const features = options.features ?? 'popup,width=900,height=640';
    const win = this._open(url, `muxterm-popout-${options.regionId}`, features);

    // Popup blocked: do NOT silently lose the region — let the caller recover
    // (e.g. keep it docked and show a hint).
    if (!win) throw new Error('popout-blocked');

    const entry: Entry = { win, timer: 0 as unknown as Entry['timer'], closed: false };
    entry.timer = setInterval(() => {
      if (win.closed) this._finish(options.regionId, options.onClose);
    }, this._pollMs);
    this._handles.set(options.regionId, entry);
    return this._handleFor(options.regionId)!;
  }

  close(regionId: string): void {
    const e = this._handles.get(regionId);
    if (!e) return;
    try {
      e.win.close();
    } catch {
      /* cross-origin or already gone — the poll will still finalize */
    }
  }

  dispose(): void {
    for (const e of this._handles.values()) clearInterval(e.timer);
    this._handles.clear();
  }

  private _finish(regionId: string, onClose: () => void): void {
    const e = this._handles.get(regionId);
    if (!e || e.closed) return;
    e.closed = true;
    clearInterval(e.timer);
    this._handles.delete(regionId);
    onClose();
  }

  private _handleFor(regionId: string): PopoutHandle | null {
    if (!this._handles.has(regionId)) return null;
    const self = this;
    return {
      regionId,
      close: () => self.close(regionId),
      get open() {
        return self.isPoppedOut(regionId);
      },
    };
  }
}

// App-wide singleton (mirrors terminalRegistry). Tests construct their own.
export const popoutManager = new PopoutManager();
```

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- popout`
Expected: PASS (5 tests).

**Step 5: Commit**
Run: `git add web/src/lib/popout.ts web/src/__tests__/popout.test.ts && git commit -m "feat(web): pop-out window.open lifecycle manager"`

---

## Task 4: Global launcher menu (`launcher-menu.ts`)

The dropdown opened by the title-bar `⋯`: New session · New browser · Open driver · Settings · Keyboard Shortcuts · Reconnect · About. Each item dispatches `launcher-action` with `{ action }`. **Surface-kind note (do NOT lose this):** `open-driver` → a TERMINAL surface; `new-browser` and `settings` → NON-TERMINAL surfaces; `new-session` → terminal as usual. The routing that honors this lives in `app.ts` (Task 12).

**Files:**
- Create: `web/src/components/launcher-menu.ts`
- Test: `web/src/__tests__/launcher-menu.test.ts` (create)

**Step 1: Write the failing test**
Create `web/src/__tests__/launcher-menu.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import '../components/launcher-menu.js';
import type { MuxLauncherMenu } from '../components/launcher-menu.js';

async function fixture(): Promise<MuxLauncherMenu> {
  const el = document.createElement('mux-launcher-menu') as MuxLauncherMenu;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxLauncherMenu', () => {
  let el: MuxLauncherMenu;
  afterEach(() => el?.remove());

  it('registers the custom element', () => {
    expect(customElements.get('mux-launcher-menu')).toBeDefined();
  });

  it('renders all seven launcher items in order', async () => {
    el = await fixture();
    const items = [...el.shadowRoot!.querySelectorAll('.item')].map((i) => i.getAttribute('data-action'));
    expect(items).toEqual([
      'new-session', 'new-browser', 'open-driver', 'settings',
      'shortcuts', 'reconnect', 'about',
    ]);
  });

  it('dispatches launcher-action with the clicked action', async () => {
    el = await fixture();
    let got = '';
    el.addEventListener('launcher-action', (e) => { got = (e as CustomEvent).detail.action; });
    (el.shadowRoot!.querySelector('[data-action="open-driver"]') as HTMLButtonElement).click();
    expect(got).toBe('open-driver');
  });

  it('marks open-driver with the driver (magenta) accent class', async () => {
    el = await fixture();
    const driver = el.shadowRoot!.querySelector('[data-action="open-driver"]');
    expect(driver!.classList.contains('driver')).toBe(true);
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- launcher-menu`
Expected: FAIL — cannot resolve `../components/launcher-menu.js`.

**Step 3: Implement `web/src/components/launcher-menu.ts`**
```ts
import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';

export type LauncherAction =
  | 'new-session'
  | 'new-browser'
  | 'open-driver'
  | 'settings'
  | 'shortcuts'
  | 'reconnect'
  | 'about';

interface Item {
  action: LauncherAction;
  label: string;
  icon: string;
  driver?: boolean; // magenta accent cue (driver is special)
  group?: boolean;  // divider before this item
}

const ITEMS: Item[] = [
  { action: 'new-session', label: 'New session', icon: '\u2795' },
  { action: 'new-browser', label: 'New browser', icon: '\u{1F310}' },
  { action: 'open-driver', label: 'Open driver', icon: '\u25C9', driver: true },
  { action: 'settings', label: 'Settings', icon: '\u2699', group: true },
  { action: 'shortcuts', label: 'Keyboard Shortcuts', icon: '\u2328' },
  { action: 'reconnect', label: 'Reconnect', icon: '\u27F3' },
  { action: 'about', label: 'About', icon: '\u2139', group: true },
];

@customElement('mux-launcher-menu')
export class MuxLauncherMenu extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-width: 220px;
      background: ${CHROME.bar};
      border: 1px solid ${CHROME.border};
      border-radius: 8px;
      padding: 6px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
      user-select: none;
    }
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 7px 10px;
      font-size: 13px;
      color: ${CHROME.textDim};
      background: transparent;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      text-align: left;
    }
    .item:hover {
      color: ${CHROME.textBright};
      background: ${CHROME.hover};
    }
    .item.driver:hover {
      color: ${CHROME.driverAccent};
    }
    .icon {
      width: 18px;
      text-align: center;
      opacity: 0.9;
    }
    .divider {
      height: 1px;
      margin: 6px 4px;
      background: ${CHROME.border};
    }
  `;

  private _emit(action: LauncherAction): void {
    this.dispatchEvent(
      new CustomEvent('launcher-action', { bubbles: true, composed: true, detail: { action } }),
    );
  }

  render() {
    return html`${ITEMS.map(
      (it) => html`
        ${it.group ? html`<div class="divider"></div>` : ''}
        <button
          class="item ${it.driver ? 'driver' : ''}"
          data-action=${it.action}
          @click=${() => this._emit(it.action)}
        >
          <span class="icon">${it.icon}</span><span>${it.label}</span>
        </button>
      `,
    )}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-launcher-menu': MuxLauncherMenu;
  }
}
```

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- launcher-menu`
Expected: PASS (4 tests).

**Step 5: Commit**
Run: `git add web/src/components/launcher-menu.ts web/src/__tests__/launcher-menu.test.ts && git commit -m "feat(web): global launcher menu (mux-launcher-menu)"`

---

## Task 5: Region "⋯ more" menu (`region-menu.ts`)

The per-region overflow menu (mockup `5-more.png`): Split right · Split down · Pop out to window · Rename window · Close region. **No "Float" — it was cut.** Each item dispatches `region-action` with `{ action }`.

**Files:**
- Create: `web/src/components/region-menu.ts`
- Test: `web/src/__tests__/region-menu.test.ts` (create)

**Step 1: Write the failing test**
Create `web/src/__tests__/region-menu.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import '../components/region-menu.js';
import type { MuxRegionMenu } from '../components/region-menu.js';

async function fixture(): Promise<MuxRegionMenu> {
  const el = document.createElement('mux-region-menu') as MuxRegionMenu;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxRegionMenu', () => {
  let el: MuxRegionMenu;
  afterEach(() => el?.remove());

  it('registers the custom element', () => {
    expect(customElements.get('mux-region-menu')).toBeDefined();
  });

  it('renders exactly the five region actions and NO float', async () => {
    el = await fixture();
    const items = [...el.shadowRoot!.querySelectorAll('.item')].map((i) => i.getAttribute('data-action'));
    expect(items).toEqual(['split-right', 'split-down', 'pop-out', 'rename', 'close-region']);
    expect(items).not.toContain('float');
  });

  it('dispatches region-action with the clicked action', async () => {
    el = await fixture();
    let got = '';
    el.addEventListener('region-action', (e) => { got = (e as CustomEvent).detail.action; });
    (el.shadowRoot!.querySelector('[data-action="pop-out"]') as HTMLButtonElement).click();
    expect(got).toBe('pop-out');
  });

  it('styles close-region with the danger class', async () => {
    el = await fixture();
    expect(el.shadowRoot!.querySelector('[data-action="close-region"]')!.classList.contains('danger')).toBe(true);
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- region-menu`
Expected: FAIL — cannot resolve `../components/region-menu.js`.

**Step 3: Implement `web/src/components/region-menu.ts`**
```ts
import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';

export type RegionAction =
  | 'split-right'
  | 'split-down'
  | 'pop-out'
  | 'rename'
  | 'close-region';

interface Item {
  action: RegionAction;
  label: string;
  icon: string;
  danger?: boolean;
  group?: boolean;
}

// NOTE: "Float" was deliberately cut from the design — do not add it back.
const ITEMS: Item[] = [
  { action: 'split-right', label: 'Split right', icon: '\u229F' },
  { action: 'split-down', label: 'Split down', icon: '\u229F' },
  { action: 'pop-out', label: 'Pop out to window', icon: '\u29C9', group: true },
  { action: 'rename', label: 'Rename window', icon: '\u270E' },
  { action: 'close-region', label: 'Close region', icon: '\u2715', danger: true, group: true },
];

@customElement('mux-region-menu')
export class MuxRegionMenu extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-width: 200px;
      background: ${CHROME.bar};
      border: 1px solid ${CHROME.border};
      border-radius: 8px;
      padding: 6px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
      user-select: none;
    }
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 7px 10px;
      font-size: 13px;
      color: ${CHROME.textDim};
      background: transparent;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      text-align: left;
    }
    .item:hover {
      color: ${CHROME.textBright};
      background: ${CHROME.hover};
    }
    .item.danger:hover {
      color: ${CHROME.danger};
    }
    .icon {
      width: 18px;
      text-align: center;
      opacity: 0.9;
    }
    .divider {
      height: 1px;
      margin: 6px 4px;
      background: ${CHROME.border};
    }
  `;

  private _emit(action: RegionAction): void {
    this.dispatchEvent(
      new CustomEvent('region-action', { bubbles: true, composed: true, detail: { action } }),
    );
  }

  render() {
    return html`${ITEMS.map(
      (it) => html`
        ${it.group ? html`<div class="divider"></div>` : ''}
        <button
          class="item ${it.danger ? 'danger' : ''}"
          data-action=${it.action}
          @click=${() => this._emit(it.action)}
        >
          <span class="icon">${it.icon}</span><span>${it.label}</span>
        </button>
      `,
    )}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-region-menu': MuxRegionMenu;
  }
}
```

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- region-menu`
Expected: PASS (4 tests).

**Step 5: Commit**
Run: `git add web/src/components/region-menu.ts web/src/__tests__/region-menu.test.ts && git commit -m "feat(web): region more-menu (mux-region-menu), no float"`

---

## Task 6: In-page title bar with global ⋯ launcher (`title-bar.ts`)

The v1 baseline title row (mockups `1-current.png` / `6-launcher.png`): branding on the left, `⋯` global launcher on the right that toggles `<mux-launcher-menu>`. **Structure it so PWA/Window-Controls-Overlay could later move it into `env(titlebar-area-*)` — but DO NOT build WCO now.** Re-dispatches the child's `launcher-action` and closes the menu after a selection.

**Files:**
- Create: `web/src/components/title-bar.ts`
- Test: `web/src/__tests__/title-bar.test.ts` (create)

**Step 1: Write the failing test**
Create `web/src/__tests__/title-bar.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import '../components/title-bar.js';
import type { MuxTitleBar } from '../components/title-bar.js';

async function fixture(): Promise<MuxTitleBar> {
  const el = document.createElement('mux-title-bar') as MuxTitleBar;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxTitleBar', () => {
  let el: MuxTitleBar;
  afterEach(() => el?.remove());

  it('registers the custom element', () => {
    expect(customElements.get('mux-title-bar')).toBeDefined();
  });

  it('shows branding and the ⋯ launcher button, menu closed by default', async () => {
    el = await fixture();
    expect(el.shadowRoot!.querySelector('.brand')!.textContent).toContain('muxterm');
    expect(el.shadowRoot!.querySelector('.launcher-btn')).toBeTruthy();
    expect(el.shadowRoot!.querySelector('mux-launcher-menu')).toBeNull();
  });

  it('toggles the launcher menu open when ⋯ is clicked', async () => {
    el = await fixture();
    (el.shadowRoot!.querySelector('.launcher-btn') as HTMLButtonElement).click();
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('mux-launcher-menu')).toBeTruthy();
  });

  it('re-emits launcher-action and closes the menu after a selection', async () => {
    el = await fixture();
    let got = '';
    el.addEventListener('launcher-action', (e) => { got = (e as CustomEvent).detail.action; });
    (el.shadowRoot!.querySelector('.launcher-btn') as HTMLButtonElement).click();
    await el.updateComplete;
    el.shadowRoot!.querySelector('mux-launcher-menu')!
      .dispatchEvent(new CustomEvent('launcher-action', { bubbles: true, composed: true, detail: { action: 'settings' } }));
    await el.updateComplete;
    expect(got).toBe('settings');
    expect(el.shadowRoot!.querySelector('mux-launcher-menu')).toBeNull();
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- title-bar`
Expected: FAIL — cannot resolve `../components/title-bar.js`.

**Step 3: Implement `web/src/components/title-bar.ts`**
```ts
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';
import './launcher-menu.js';
import type { LauncherAction } from './launcher-menu.js';

// v1 baseline: an in-page title row. Branding lives here (not just in the browser
// tab title, which is undiscoverable). DEFERRED: PWA + Window Controls Overlay would
// repaint this same content into env(titlebar-area-*); structure is kept simple so
// that move is additive later. Do NOT build WCO now.
@customElement('mux-title-bar')
export class MuxTitleBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 32px;
      padding: 0 10px;
      background: ${CHROME.bar};
      border-bottom: 1px solid ${CHROME.border};
      flex-shrink: 0;
      user-select: none;
      /* titlebar-area-* would apply here under display-mode: window-controls-overlay */
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.4px;
      color: ${CHROME.textBright};
    }
    .brand .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: ${CHROME.accent};
    }
    .right {
      position: relative;
    }
    .launcher-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 24px;
      font-size: 16px;
      line-height: 1;
      color: ${CHROME.textDim};
      background: transparent;
      border: none;
      border-radius: 6px;
      cursor: pointer;
    }
    .launcher-btn:hover {
      color: ${CHROME.textBright};
      background: ${CHROME.hover};
    }
    .menu-anchor {
      position: absolute;
      top: 28px;
      right: 0;
      z-index: 1500;
    }
  `;

  @state()
  private _menuOpen = false;

  private _toggleMenu(): void {
    this._menuOpen = !this._menuOpen;
  }

  private _onAction(e: CustomEvent<{ action: LauncherAction }>): void {
    this._menuOpen = false;
    // Re-dispatch upward (the child event already bubbles; we re-emit so app.ts
    // can listen on <mux-title-bar> regardless of menu mount timing).
    this.dispatchEvent(
      new CustomEvent('launcher-action', {
        bubbles: true,
        composed: true,
        detail: { action: e.detail.action },
      }),
    );
  }

  render() {
    return html`
      <div class="brand"><span class="dot"></span>muxterm</div>
      <div class="right">
        <button class="launcher-btn" title="Launcher" @click=${this._toggleMenu}>\u22EF</button>
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu @launcher-action=${this._onAction}></mux-launcher-menu>
            </div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-title-bar': MuxTitleBar;
  }
}
```

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- title-bar`
Expected: PASS (4 tests).

**Step 5: Commit**
Run: `git add web/src/components/title-bar.ts web/src/__tests__/title-bar.test.ts && git commit -m "feat(web): in-page title bar + global launcher (mux-title-bar)"`

---

## Task 7: Per-region tab strip (`region-tabstrip.ts`)

The VS Code-style per-region header (mockup `2-dock.png`): `[session ▾]` chip + window tabs (file icon + label + close `×`, **dirty-dot replaces × when the window is running**) + right controls `⊡ maximize` and `⋯ more`. Active tab = thin top accent line + body-matching background. Driver region uses the magenta accent. Pure presentational — emits events; the host (`region.ts`) owns state.

**Files:**
- Create: `web/src/components/region-tabstrip.ts`
- Test: `web/src/__tests__/region-tabstrip.test.ts` (create)

**Step 1: Write the failing test**
Create `web/src/__tests__/region-tabstrip.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import '../components/region-tabstrip.js';
import type { MuxRegionTabstrip } from '../components/region-tabstrip.js';
import type { Window } from '../types.js';

const WINDOWS: Window[] = [
  { id: 1, name: 'editor', panes: [{ id: 5, width: 80, height: 24, active: true }], layout: '' },
  { id: 2, name: 'logs', panes: [{ id: 6, width: 80, height: 24, active: true }], layout: '' },
];

async function fixture(props: Partial<MuxRegionTabstrip> = {}): Promise<MuxRegionTabstrip> {
  const el = document.createElement('mux-region-tabstrip') as MuxRegionTabstrip;
  el.sessionName = props.sessionName ?? 'work';
  el.windows = props.windows ?? WINDOWS;
  el.activeWindowId = props.activeWindowId ?? 1;
  if (props.isDriver !== undefined) el.isDriver = props.isDriver;
  if (props.runningWindowIds) el.runningWindowIds = props.runningWindowIds;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxRegionTabstrip', () => {
  let el: MuxRegionTabstrip;
  afterEach(() => el?.remove());

  it('registers the custom element', () => {
    expect(customElements.get('mux-region-tabstrip')).toBeDefined();
  });

  it('renders the session chip and one tab per window', async () => {
    el = await fixture();
    expect(el.shadowRoot!.querySelector('.session-chip')!.textContent).toContain('work');
    expect(el.shadowRoot!.querySelectorAll('.tab').length).toBe(2);
  });

  it('marks the active window tab', async () => {
    el = await fixture({ activeWindowId: 2 });
    const active = el.shadowRoot!.querySelector('.tab.active');
    expect(active!.getAttribute('data-window-id')).toBe('2');
  });

  it('opens the session picker when the chip is clicked', async () => {
    el = await fixture();
    let fired = false;
    el.addEventListener('open-session-picker', () => { fired = true; });
    (el.shadowRoot!.querySelector('.session-chip') as HTMLButtonElement).click();
    expect(fired).toBe(true);
  });

  it('emits tab-select on tab click and region-maximize on ⊡', async () => {
    el = await fixture();
    let selected = -1; let maximized = false;
    el.addEventListener('tab-select', (e) => { selected = (e as CustomEvent).detail.windowId; });
    el.addEventListener('region-maximize', () => { maximized = true; });
    (el.shadowRoot!.querySelector('[data-window-id="2"]') as HTMLButtonElement).click();
    (el.shadowRoot!.querySelector('.maximize-btn') as HTMLButtonElement).click();
    expect(selected).toBe(2);
    expect(maximized).toBe(true);
  });

  it('emits region-menu-open on ⋯', async () => {
    el = await fixture();
    let fired = false;
    el.addEventListener('region-menu-open', () => { fired = true; });
    (el.shadowRoot!.querySelector('.more-btn') as HTMLButtonElement).click();
    expect(fired).toBe(true);
  });

  it('shows a dirty-dot instead of × for running windows', async () => {
    el = await fixture({ runningWindowIds: [1] });
    const tab1 = el.shadowRoot!.querySelector('[data-window-id="1"]')!;
    expect(tab1.querySelector('.dirty-dot')).toBeTruthy();
    expect(tab1.querySelector('.tab-close')).toBeNull();
  });

  it('applies the driver accent class when isDriver is set', async () => {
    el = await fixture({ isDriver: true });
    expect(el.shadowRoot!.querySelector('.strip')!.classList.contains('driver')).toBe(true);
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- region-tabstrip`
Expected: FAIL — cannot resolve `../components/region-tabstrip.js`.

**Step 3: Implement `web/src/components/region-tabstrip.ts`**
```ts
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';
import type { Window } from '../types.js';

@customElement('mux-region-tabstrip')
export class MuxRegionTabstrip extends LitElement {
  static styles = css`
    .strip {
      display: flex;
      align-items: stretch;
      height: 34px;
      background: ${CHROME.bar};
      border-bottom: 1px solid ${CHROME.border};
      padding: 0 4px;
      gap: 2px;
      user-select: none;
    }
    .session-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 10px;
      margin-right: 4px;
      font-size: 12px;
      font-weight: 600;
      color: ${CHROME.accent};
      background: transparent;
      border: none;
      border-right: 1px solid ${CHROME.border};
      cursor: pointer;
    }
    .session-chip:hover {
      color: ${CHROME.textBright};
    }
    .strip.driver .session-chip {
      color: ${CHROME.driverAccent};
    }
    .tabs {
      display: flex;
      align-items: stretch;
      gap: 0;
      overflow-x: auto;
    }
    /* Flat seamless VS Code tab: active = top accent line + body background. */
    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px;
      font-size: 13px;
      color: ${CHROME.textDim};
      background: transparent;
      border: none;
      border-top: 2px solid transparent;
      cursor: pointer;
    }
    .tab:hover {
      color: ${CHROME.textBright};
    }
    .tab.active {
      color: ${CHROME.textBright};
      background: ${CHROME.body};
      border-top: 2px solid ${CHROME.accent};
    }
    .strip.driver .tab.active {
      border-top-color: ${CHROME.driverAccent};
    }
    .file-icon {
      opacity: 0.8;
    }
    .tab-close,
    .dirty-dot {
      width: 14px;
      text-align: center;
      font-size: 13px;
      line-height: 1;
    }
    .dirty-dot {
      color: ${CHROME.accent};
    }
    .tab-close {
      visibility: hidden;
      cursor: pointer;
    }
    .tab:hover .tab-close {
      visibility: visible;
    }
    .tab-close:hover {
      color: ${CHROME.danger};
    }
    .tab-add {
      width: 28px;
      font-size: 16px;
      color: ${CHROME.textDim};
      background: transparent;
      border: none;
      cursor: pointer;
    }
    .tab-add:hover {
      color: ${CHROME.textBright};
    }
    .spacer {
      flex: 1;
    }
    .controls {
      display: flex;
      align-items: center;
    }
    .icon-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 26px;
      font-size: 15px;
      color: ${CHROME.textDim};
      background: transparent;
      border: none;
      border-radius: 6px;
      cursor: pointer;
    }
    .icon-btn:hover {
      color: ${CHROME.textBright};
      background: ${CHROME.hover};
    }
  `;

  @property({ type: String }) sessionName = '';
  @property({ attribute: false }) windows: Window[] = [];
  @property({ type: Number }) activeWindowId = 0;
  @property({ type: Boolean }) isDriver = false;
  /** Window ids currently "running/modified" — show a dirty-dot instead of ×. */
  @property({ attribute: false }) runningWindowIds: number[] = [];

  private _emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  private _isRunning(id: number): boolean {
    return this.runningWindowIds.includes(id);
  }

  render() {
    return html`
      <div class="strip ${this.isDriver ? 'driver' : ''}">
        <button class="session-chip" @click=${() => this._emit('open-session-picker')}>
          ${this.sessionName || 'session'} <span>\u25BE</span>
        </button>
        <div class="tabs">
          ${this.windows.map((w) => {
            const active = w.id === this.activeWindowId;
            return html`
              <button
                class="tab ${active ? 'active' : ''}"
                data-window-id=${w.id}
                @click=${() => this._emit('tab-select', { windowId: w.id })}
              >
                <span class="file-icon">\u25A0</span>
                <span class="label">${w.name}</span>
                ${this._isRunning(w.id)
                  ? html`<span class="dirty-dot">\u25CF</span>`
                  : html`<span
                      class="tab-close"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        this._emit('tab-close', { windowId: w.id });
                      }}
                      >\u00D7</span
                    >`}
              </button>
            `;
          })}
          <button class="tab-add" title="New window" @click=${() => this._emit('tab-new')}>+</button>
        </div>
        <div class="spacer"></div>
        <div class="controls">
          <button class="icon-btn maximize-btn" title="Maximize region"
            @click=${() => this._emit('region-maximize')}>\u22A1</button>
          <button class="icon-btn more-btn" title="More"
            @click=${() => this._emit('region-menu-open')}>\u22EF</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-region-tabstrip': MuxRegionTabstrip;
  }
}
```

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- region-tabstrip`
Expected: PASS (8 tests).

**Step 5: Commit**
Run: `git add web/src/components/region-tabstrip.ts web/src/__tests__/region-tabstrip.test.ts && git commit -m "feat(web): per-region VS Code tab strip (mux-region-tabstrip)"`

---

## Task 8: Inline per-region session picker dropdown (`session-picker.ts`)

Mockup `4-sessions.png`: the `[session ▾]` chip opens a small **anchored dropdown** (switch session / + new session) — the primary navigator. The existing full-screen overlay mode (Phase 1) must keep working, so add an **opt-in `inline` mode** rather than replacing it.

**Files:**
- Modify: `web/src/components/session-picker.ts`
- Test: `web/src/__tests__/session-picker.test.ts` (modify — append cases)

**Step 1: Write the failing test (append to the existing file)**
First read the existing test file: `read_file web/src/__tests__/session-picker.test.ts`. Then append this block before the final closing of the file (after the last existing `describe`/test, at top level):
```ts
import { describe, it, expect, afterEach } from 'vitest';
import '../components/session-picker.js';
import type { MuxSessionPicker } from '../components/session-picker.js';

describe('MuxSessionPicker inline mode', () => {
  let el: MuxSessionPicker;
  afterEach(() => el?.remove());

  async function inlineFixture(): Promise<MuxSessionPicker> {
    const e = document.createElement('mux-session-picker') as MuxSessionPicker;
    e.inline = true;
    e.currentSession = 'work';
    e.sessions = [
      { name: 'work', windows: 2 },
      { name: 'logs', windows: 1 },
    ];
    document.body.appendChild(e);
    await e.updateComplete;
    return e;
  }

  it('renders an anchored dropdown (no full-screen overlay) in inline mode', async () => {
    el = await inlineFixture();
    expect(el.shadowRoot!.querySelector('.overlay')).toBeNull();
    expect(el.shadowRoot!.querySelector('.dropdown')).toBeTruthy();
  });

  it('marks the current session', async () => {
    el = await inlineFixture();
    const current = el.shadowRoot!.querySelector('.session-item.current');
    expect(current!.textContent).toContain('work');
  });

  it('dispatches session-selected on click', async () => {
    el = await inlineFixture();
    let got = '';
    el.addEventListener('session-selected', (e) => { got = (e as CustomEvent).detail.name; });
    (el.shadowRoot!.querySelectorAll('.session-item')[1] as HTMLButtonElement).click();
    expect(got).toBe('logs');
  });

  it('dispatches new-session from the + row', async () => {
    el = await inlineFixture();
    let fired = false;
    el.addEventListener('new-session', () => { fired = true; });
    (el.shadowRoot!.querySelector('.new-session') as HTMLButtonElement).click();
    expect(fired).toBe(true);
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- session-picker`
Expected: FAIL — `inline`/`currentSession` not properties; `.dropdown` / `.new-session` not found.

**Step 3: Implement — add inline mode to `session-picker.ts`**
Read the current file first. Then make these changes:

(a) Add two properties after the existing `sessions` property:
```ts
  /** Inline mode renders a small anchored dropdown instead of a modal overlay. */
  @property({ type: Boolean })
  inline = false;

  @property({ type: String })
  currentSession = '';
```

(b) Add a `new-session` emitter alongside `_onSessionClick`:
```ts
  private _onNewSession(): void {
    this.dispatchEvent(new CustomEvent('new-session', { bubbles: true, composed: true }));
  }
```

(c) Add dropdown styles to the `static styles` css block (append inside it):
```ts
    .dropdown {
      min-width: 220px;
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 8px;
      padding: 6px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
    }
    .session-item.current {
      border-color: #89b4fa;
    }
    .new-session {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      margin-top: 6px;
      padding: 10px 16px;
      background: transparent;
      border: 1px dashed #45475a;
      border-radius: 6px;
      color: #89b4fa;
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
    }
    .new-session:hover {
      background: #181825;
    }
```

(d) Replace the `render()` method so it branches on `inline`:
```ts
  render() {
    const list = html`
      <div class="session-list">
        ${this.sessions.map(
          (s) => html`
            <button
              class="session-item ${s.name === this.currentSession ? 'current' : ''}"
              @click=${() => this._onSessionClick(s.name)}
            >
              <span class="session-name">${s.name}</span>
              <span class="session-meta">${s.windows} ${s.windows === 1 ? 'window' : 'windows'}</span>
            </button>
          `,
        )}
      </div>
    `;

    if (this.inline) {
      return html`
        <div class="dropdown">
          ${list}
          <button class="new-session" @click=${() => this._onNewSession()}>
            <span>+</span> New session
          </button>
        </div>
      `;
    }

    return html`
      <div class="overlay">
        <div class="picker">
          <h2>Select a tmux session</h2>
          ${list}
        </div>
      </div>
    `;
  }
```

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- session-picker`
Expected: PASS — existing overlay tests still green + 4 new inline tests pass.

**Step 5: Commit**
Run: `git add web/src/components/session-picker.ts web/src/__tests__/session-picker.test.ts && git commit -m "feat(web): inline per-region session picker dropdown"`

---

## Task 9: Browser non-terminal surface (`browser-surface.ts`) + `SurfaceKind` type

A non-terminal surface: a pixel-box `<iframe>` rendering normal responsive DOM — **NO tmux cell-grid** (contrast with terminal/driver surfaces). Also introduce the shared `SurfaceKind` type used by routing in Task 13.

**Files:**
- Modify: `web/src/types.ts` (add `SurfaceKind`)
- Create: `web/src/components/browser-surface.ts`
- Test: `web/src/__tests__/browser-surface.test.ts` (create)

**Step 1: Write the failing test**
Create `web/src/__tests__/browser-surface.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import '../components/browser-surface.js';
import type { MuxBrowserSurface } from '../components/browser-surface.js';

async function fixture(url = 'https://example.com'): Promise<MuxBrowserSurface> {
  const el = document.createElement('mux-browser-surface') as MuxBrowserSurface;
  el.url = url;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxBrowserSurface', () => {
  let el: MuxBrowserSurface;
  afterEach(() => el?.remove());

  it('registers the custom element', () => {
    expect(customElements.get('mux-browser-surface')).toBeDefined();
  });

  it('renders an iframe pointed at the url (non-terminal, no grid)', async () => {
    el = await fixture('https://playwright.dev');
    const frame = el.shadowRoot!.querySelector('iframe');
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute('src')).toBe('https://playwright.dev');
    // It must NOT carry a terminal grid container.
    expect(el.shadowRoot!.querySelector('.xterm')).toBeNull();
  });

  it('navigates via the address bar (dispatches url-change)', async () => {
    el = await fixture('https://a.test');
    let got = '';
    el.addEventListener('url-change', (e) => { got = (e as CustomEvent).detail.url; });
    const input = el.shadowRoot!.querySelector('.address') as HTMLInputElement;
    input.value = 'https://b.test';
    input.dispatchEvent(new Event('change'));
    expect(got).toBe('https://b.test');
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- browser-surface`
Expected: FAIL — cannot resolve `../components/browser-surface.js`.

**Step 3a: Add `SurfaceKind` to `web/src/types.ts`**
Append after the `Session` interface (or anywhere top-level):
```ts
// A region renders exactly one surface. Terminal + driver are cell-grid surfaces
// (cols×rows budget, xterm.js). Browser + settings are NON-terminal: pixel box,
// normal responsive DOM, NO tmux grid.
export type SurfaceKind = 'terminal' | 'driver' | 'browser' | 'settings';

export function isTerminalSurface(kind: SurfaceKind): boolean {
  return kind === 'terminal' || kind === 'driver';
}
```

**Step 3b: Implement `web/src/components/browser-surface.ts`**
```ts
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';

// NON-TERMINAL surface: a pixel-box iframe. No cell-grid, no xterm.js. Just DOM.
@customElement('mux-browser-surface')
export class MuxBrowserSurface extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: ${CHROME.body};
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 30px;
      padding: 0 8px;
      background: ${CHROME.bar};
      border-bottom: 1px solid ${CHROME.border};
    }
    .address {
      flex: 1;
      height: 22px;
      padding: 0 8px;
      font-size: 12px;
      color: ${CHROME.textBright};
      background: ${CHROME.body};
      border: 1px solid ${CHROME.border};
      border-radius: 5px;
      font-family: inherit;
    }
    iframe {
      flex: 1;
      width: 100%;
      border: none;
      background: #fff;
    }
  `;

  @property({ type: String }) url = 'about:blank';

  private _onChange(e: Event): void {
    const url = (e.target as HTMLInputElement).value;
    this.url = url;
    this.dispatchEvent(new CustomEvent('url-change', { bubbles: true, composed: true, detail: { url } }));
  }

  render() {
    return html`
      <div class="bar">
        <input class="address" .value=${this.url} @change=${this._onChange} aria-label="address" />
      </div>
      <iframe src=${this.url} sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-browser-surface': MuxBrowserSurface;
  }
}
```

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- browser-surface`
Expected: PASS (3 tests).

**Step 5: Commit**
Run: `git add web/src/types.ts web/src/components/browser-surface.ts web/src/__tests__/browser-surface.test.ts && git commit -m "feat(web): browser non-terminal surface + SurfaceKind type"`

---

## Task 10: Settings non-terminal surface (`settings-surface.ts`)

The settings panel surface (responsive DOM, no grid): theme readout, server address, and an About blurb. Keep it static/read-only for v1 (config editing is Phase 5).

**Files:**
- Create: `web/src/components/settings-surface.ts`
- Test: `web/src/__tests__/settings-surface.test.ts` (create)

**Step 1: Write the failing test**
Create `web/src/__tests__/settings-surface.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import '../components/settings-surface.js';
import type { MuxSettingsSurface } from '../components/settings-surface.js';

async function fixture(): Promise<MuxSettingsSurface> {
  const el = document.createElement('mux-settings-surface') as MuxSettingsSurface;
  el.serverAddr = 'localhost:8080';
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxSettingsSurface', () => {
  let el: MuxSettingsSurface;
  afterEach(() => el?.remove());

  it('registers the custom element', () => {
    expect(customElements.get('mux-settings-surface')).toBeDefined();
  });

  it('renders a settings panel with no terminal grid', async () => {
    el = await fixture();
    expect(el.shadowRoot!.querySelector('.panel')).toBeTruthy();
    expect(el.shadowRoot!.querySelector('.xterm')).toBeNull();
  });

  it('shows the server address and theme name', async () => {
    el = await fixture();
    const text = el.shadowRoot!.querySelector('.panel')!.textContent!;
    expect(text).toContain('localhost:8080');
    expect(text).toContain('Tokyo Night');
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- settings-surface`
Expected: FAIL — cannot resolve `../components/settings-surface.js`.

**Step 3: Implement `web/src/components/settings-surface.ts`**
```ts
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';

// NON-TERMINAL surface: a normal-DOM settings panel. Read-only for v1 — editable
// config lands in Phase 5. No cell-grid.
@customElement('mux-settings-surface')
export class MuxSettingsSurface extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: auto;
      background: ${CHROME.body};
      color: ${CHROME.textBright};
    }
    .panel {
      max-width: 560px;
      margin: 0 auto;
      padding: 28px 24px;
    }
    h2 {
      margin: 0 0 20px;
      font-size: 18px;
      color: ${CHROME.textBright};
    }
    .row {
      display: flex;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid ${CHROME.border};
      font-size: 13px;
    }
    .key {
      color: ${CHROME.textDim};
    }
    .val {
      color: ${CHROME.accent};
      font-weight: 600;
    }
    .about {
      margin-top: 24px;
      font-size: 12px;
      color: ${CHROME.textDim};
      line-height: 1.6;
    }
  `;

  @property({ type: String }) serverAddr = '';

  render() {
    return html`
      <div class="panel">
        <h2>Settings</h2>
        <div class="row"><span class="key">Theme</span><span class="val">Tokyo Night</span></div>
        <div class="row"><span class="key">Server</span><span class="val">${this.serverAddr}</span></div>
        <div class="row"><span class="key">Accent</span><span class="val">#7aa2f7</span></div>
        <p class="about">
          muxterm \u2014 a browser-native tmux workspace. Configurable settings (keybindings,
          theme overrides) arrive in a later release.
        </p>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-settings-surface': MuxSettingsSurface;
  }
}
```

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- settings-surface`
Expected: PASS (3 tests).

**Step 5: Commit**
Run: `git add web/src/components/settings-surface.ts web/src/__tests__/settings-surface.test.ts && git commit -m "feat(web): settings non-terminal surface (mux-settings-surface)"`

---

## Task 11: Status-bar goal segment placeholder

Add the `◉ goal` segment to the status bar (design line 478), shown only when a driver session is active. Placeholder text only — the driver application is a separate plan.

**Files:**
- Modify: `web/src/components/status-bar.ts`
- Test: `web/src/__tests__/status-bar.test.ts` (modify — append cases)

**Step 1: Write the failing test (append a new describe block to the file)**
Append at top level of `web/src/__tests__/status-bar.test.ts`:
```ts
describe('MuxStatusBar goal segment', () => {
  let gEl: import('../components/status-bar.js').MuxStatusBar;
  afterEach(() => { if (gEl?.parentNode) gEl.parentNode.removeChild(gEl); });

  async function goalFixture(driverActive: boolean) {
    const el = document.createElement('mux-status-bar') as typeof gEl;
    el.driverActive = driverActive;
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  }

  it('hides the goal segment when no driver is active', async () => {
    gEl = await goalFixture(false);
    expect(gEl.shadowRoot!.querySelector('.goal')).toBeNull();
  });

  it('shows the ◉ goal segment when a driver session is active', async () => {
    gEl = await goalFixture(true);
    const goal = gEl.shadowRoot!.querySelector('.goal');
    expect(goal).toBeTruthy();
    expect(goal!.textContent).toContain('goal');
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- status-bar`
Expected: FAIL — `driverActive` not a property; `.goal` not found.

**Step 3: Implement — add the goal segment to `status-bar.ts`**
(a) Add the property after `connectionStatus`:
```ts
  // Shown when a $driver tmux session is active. Placeholder for the driver app
  // (separate plan) — it just marks that goal-mode exists.
  @property({ type: Boolean })
  driverActive = false;
```
(b) Add a `.goal` style inside `static styles`:
```ts
    .goal {
      color: #bb9af7;
      font-weight: 600;
    }
```
(c) In `render()`, add the goal span into the `.right` div, before the connection status:
```ts
      <div class="right">
        ${this.driverActive ? html`<span class="goal">\u25C9 goal</span>` : ''}
        <span class="${this.connectionStatus}">${this._statusText()}</span>
      </div>
```

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- status-bar`
Expected: PASS — existing tests still green + 2 new goal tests pass.

**Step 5: Commit**
Run: `git add web/src/components/status-bar.ts web/src/__tests__/status-bar.test.ts && git commit -m "feat(web): status-bar goal segment placeholder"`

---

## Task 12: Wire the title bar + launcher into `app.ts`

Mount `<mux-title-bar>` at the very top of the app and handle `launcher-action`. **Honor the surface-kind note:** `open-driver` opens a TERMINAL surface (create/attach the `$driver` session — for now, send `create-session` named `driver`); `new-browser`/`settings` open NON-TERMINAL surfaces beside the focused region (delegate to the Phase-3 workspace API); `new-session` opens the session picker; `reconnect` triggers a resync; `shortcuts`/`about` are placeholders.

**Files:**
- Modify: `web/src/app.ts`
- Test: `web/src/__tests__/app.test.ts` (modify — append a case)

> **Read `web/src/app.ts` and `web/src/components/workspace.ts` first.** The exact method to "open a surface beside the focused region" is a Phase-3 workspace API. If its name differs from what's shown, adapt the call in `_onLauncherAction` accordingly — the integration point is clearly marked below.

**Step 1: Write the failing test (append to `app.test.ts`)**
Append a top-level test that asserts the title bar mounts and a launcher action routes. Add near the other `describe`s:
```ts
describe('MuxApp chrome wiring', () => {
  it('renders the title bar above everything', async () => {
    const el = document.createElement('mux-app') as import('../app.js').MuxApp;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('mux-title-bar')).toBeTruthy();
    el.remove();
  });

  it('opens the session picker when launcher new-session fires', async () => {
    const el = document.createElement('mux-app') as import('../app.js').MuxApp;
    document.body.appendChild(el);
    await el.updateComplete;
    el.shadowRoot!.querySelector('mux-title-bar')!
      .dispatchEvent(new CustomEvent('launcher-action', { bubbles: true, composed: true, detail: { action: 'new-session' } }));
    await el.updateComplete;
    // _showSessionPicker flips true → the picker (or its request) is reflected.
    expect((el as unknown as { _showSessionPicker: boolean })._showSessionPicker).toBe(true);
    el.remove();
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- app`
Expected: FAIL — no `mux-title-bar` in the shadow root; `_showSessionPicker` stays false.

**Step 3: Implement — wire `app.ts`**
(a) Add the side-effect import near the other component imports:
```ts
import './components/title-bar.js';
```
(b) Add `import type { LauncherAction } from './components/launcher-menu.js';` to the imports.
(c) In `render()`, add `<mux-title-bar>` as the FIRST child (above `<mux-tab-bar>`):
```ts
      <mux-title-bar @launcher-action=${this._onLauncherAction}></mux-title-bar>
```
(d) Add the handler method (place near the other `_on*` handlers). **The marked line is the Phase-3 integration point.**
```ts
  private _onLauncherAction = (e: CustomEvent<{ action: LauncherAction }>): void => {
    switch (e.detail.action) {
      case 'new-session':
        // Reuse the existing session-picker flow.
        this._socket?.sendRaw(JSON.stringify({ 'list-sessions': true }));
        this._showSessionPicker = true;
        break;
      case 'open-driver':
        // Driver is a TERMINAL surface: create/attach the dedicated $driver session.
        // (The driver APPLICATION is a separate plan; here we only spawn the session
        // so it renders as a normal terminal region.)
        this._socket?.sendControl({ type: 'create-session', name: 'driver' });
        break;
      case 'new-browser':
        // NON-TERMINAL surface beside the focused region.
        // PHASE-3 INTEGRATION POINT: call the workspace "open surface beside" API.
        this._openSurfaceBeside('browser');
        break;
      case 'settings':
        this._openSurfaceBeside('settings');
        break;
      case 'reconnect':
        this._socket?.sendControl({ type: 'request-sync' });
        break;
      case 'shortcuts':
      case 'about':
        // Placeholder — no-op for v1 (no modal yet).
        break;
    }
  };

  // PHASE-3 INTEGRATION POINT: replace this body with the real workspace call once
  // workspace.ts exposes "open a surface beside the focused region". Until then it
  // dispatches an app-level event the workspace listens for.
  private _openSurfaceBeside(kind: 'browser' | 'settings'): void {
    this.dispatchEvent(
      new CustomEvent('open-surface-beside', { bubbles: true, composed: true, detail: { kind } }),
    );
  }
```
> If `_showSessionPicker` is populated through a control message in your Phase-1 code, keep that path — the test only requires `_showSessionPicker` to become `true` on `new-session`. Adjust the `new-session` branch to match the existing list-sessions mechanism if the raw message differs.

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- app`
Expected: PASS — title bar present; `_showSessionPicker` true after `new-session`. Confirm the whole suite is green: `cd web && npm test`.

**Step 5: Commit**
Run: `git add web/src/app.ts web/src/__tests__/app.test.ts && git commit -m "feat(web): mount title bar + route launcher actions in app"`

---

## Task 13: Host the tab strip + route terminal vs non-terminal in `region.ts`

Make each region render `<mux-region-tabstrip>` at the top and branch its body on `SurfaceKind`: terminal/driver → the existing terminal layout (cell grid); browser → `<mux-browser-surface>`; settings → `<mux-settings-surface>`. Driver regions pass `isDriver` to the tab strip (magenta accent).

**Files:**
- Modify: `web/src/components/region.ts` (Phase-3 file)
- Test: `web/src/__tests__/region.test.ts` (Phase-3 file — append cases)

> **Read `web/src/components/region.ts` and its test first.** Phase 3 defines the region's existing props (likely a `window`/`session`/`layout` set) and how it mounts the terminal layout. The two integration points are: **(1)** render `<mux-region-tabstrip>` as the region header and forward its events upward; **(2)** add a `surfaceKind: SurfaceKind` property and branch the body. Adapt prop names to whatever Phase 3 used.

**Step 1: Write the failing test (append to `region.test.ts`)**
```ts
describe('MuxRegion surface routing', () => {
  async function regionFixture(kind: string) {
    const el = document.createElement('mux-region') as import('../components/region.js').MuxRegion;
    // Minimal props — adapt to Phase-3 region API:
    (el as unknown as { surfaceKind: string }).surfaceKind = kind;
    (el as unknown as { sessionName: string }).sessionName = 'work';
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  }

  it('always renders the region tab strip header', async () => {
    const el = await regionFixture('terminal');
    expect(el.shadowRoot!.querySelector('mux-region-tabstrip')).toBeTruthy();
    el.remove();
  });

  it('routes browser surfaces to the iframe surface (no terminal layout)', async () => {
    const el = await regionFixture('browser');
    expect(el.shadowRoot!.querySelector('mux-browser-surface')).toBeTruthy();
    expect(el.shadowRoot!.querySelector('mux-layout')).toBeNull();
    el.remove();
  });

  it('routes settings surfaces to the settings panel', async () => {
    const el = await regionFixture('settings');
    expect(el.shadowRoot!.querySelector('mux-settings-surface')).toBeTruthy();
    el.remove();
  });

  it('routes terminal/driver surfaces to the terminal layout', async () => {
    const el = await regionFixture('driver');
    expect(el.shadowRoot!.querySelector('mux-layout')).toBeTruthy();
    // Driver passes the magenta accent to the strip.
    expect((el.shadowRoot!.querySelector('mux-region-tabstrip') as { isDriver?: boolean }).isDriver).toBe(true);
    el.remove();
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- region`
Expected: FAIL — no tab strip / surface routing yet.

**Step 3: Implement — integrate into `region.ts`**
Add imports:
```ts
import './region-tabstrip.js';
import './browser-surface.js';
import './settings-surface.js';
import { isTerminalSurface, type SurfaceKind } from '../types.js';
```
Add a property:
```ts
  @property({ type: String }) surfaceKind: SurfaceKind = 'terminal';
```
In `render()`, put the tab strip first, then branch the body. Forward the strip's events (`tab-select`, `tab-close`, `tab-new`, `open-session-picker`, `region-maximize`, `region-menu-open`) up to the workspace using the region's existing event-forwarding convention (re-dispatch or handlers). The body branch:
```ts
    const body = isTerminalSurface(this.surfaceKind)
      ? html`<mux-layout
          layout-string=${this.layout ?? ''}
          active-pane-id=${this.activePaneId ?? -1}
          @pane-focus=${this._onPaneSelect}
        ></mux-layout>`
      : this.surfaceKind === 'browser'
        ? html`<mux-browser-surface .url=${this.browserUrl ?? 'about:blank'}></mux-browser-surface>`
        : html`<mux-settings-surface .serverAddr=${this.serverAddr ?? location.host}></mux-settings-surface>`;

    return html`
      <mux-region-tabstrip
        .sessionName=${this.sessionName ?? ''}
        .windows=${this.windows ?? []}
        .activeWindowId=${this.activeWindowId ?? 0}
        .isDriver=${this.surfaceKind === 'driver'}
      ></mux-region-tabstrip>
      ${body}
    `;
```
> Adapt `this.layout` / `this.activePaneId` / `this.windows` / `this.activeWindowId` / `this._onPaneSelect` to the actual Phase-3 region property and handler names. Add `browserUrl` and `serverAddr` properties if not present. Keep the region's existing terminal-mount logic intact for the terminal branch.

**Step 4: Run the test to verify it passes**
Run: `cd web && npm test -- region`
Expected: PASS (4 new tests) + Phase-3 region tests still green. Then full suite: `cd web && npm test`.

**Step 5: Commit**
Run: `git add web/src/components/region.ts web/src/__tests__/region.test.ts && git commit -m "feat(web): region hosts tab strip + routes terminal/non-terminal surfaces"`

---

## Task 14: Wire pop-out end-to-end (region ⋯ → `popout.ts` → remount)

Connect the region `⋯` menu's `pop-out` action through `popoutManager`: open a second OS window, remove the region from the in-page workspace while popped, and **remount** it when the popped window closes. Mount `<mux-region-menu>` from the region's `region-menu-open` event. The workspace owns the popped-out set.

**Files:**
- Modify: `web/src/components/workspace.ts` (Phase-3 file) — pop-out orchestration + region-menu mounting
- Test: `web/src/__tests__/workspace-popout.test.ts` (create)

> **Read `web/src/components/workspace.ts` first.** You need: how regions are stored, how one is removed/re-added, and how the region's `region-menu-open` / `region-action` events reach the workspace. The test below drives the **manager interaction** with an injected fake opener so it does not depend on real `window.open`.

**Step 1: Write the failing test**
Create `web/src/__tests__/workspace-popout.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PopoutManager } from '../lib/popout.js';

// This test pins the workspace's expected use of PopoutManager: pop-out removes the
// region from the in-page set; closing the popped window remounts it. We model the
// workspace's region set with a Set and the two callbacks it must wire.
describe('workspace pop-out orchestration contract', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('removes a region on pop-out and remounts it on close', () => {
    const win = { closed: false, close: vi.fn() };
    const mgr = new PopoutManager({ open: () => win as unknown as Window, pollIntervalMs: 50, origin: 'http://x' });

    const mounted = new Set<string>(['r1', 'r2']);

    // Simulate the workspace's pop-out handler:
    const popOut = (regionId: string) => {
      mgr.popOut({
        regionId,
        onClose: () => mounted.add(regionId), // remount on close
      });
      mounted.delete(regionId); // moved out of the in-page workspace
    };

    popOut('r1');
    expect(mounted.has('r1')).toBe(false);
    expect(mgr.isPoppedOut('r1')).toBe(true);

    win.closed = true;
    vi.advanceTimersByTime(50);

    expect(mounted.has('r1')).toBe(true);     // remounted
    expect(mgr.isPoppedOut('r1')).toBe(false);
  });
});
```

**Step 2: Run the test to verify it fails**
Run: `cd web && npm test -- workspace-popout`
Expected: FAIL initially only if `popout.js` import path is wrong — but since Task 3 created it, this test actually encodes the contract and should pass once written. To keep TDD honest, FIRST run it and confirm it PASSES against the real `PopoutManager` (it validates the contract). If it fails, fix `popout.ts`. Then proceed to implement the real workspace wiring in Step 3, which has no isolated unit (it's DOM orchestration verified in Task 15 E2E).

**Step 3: Implement the workspace wiring**
In `workspace.ts`:
(a) Import the singleton + the menu:
```ts
import { popoutManager } from '../lib/popout.js';
import './region-menu.js';
import type { RegionAction } from './region-menu.js';
```
(b) Track an open region-menu anchor (which region's `⋯` is open) and a popped-out region id set in component state.
(c) On a region's `region-menu-open` event, record the region id and render `<mux-region-menu>` anchored near it; on its `region-action`:
```ts
  private _onRegionAction(regionId: string, e: CustomEvent<{ action: RegionAction }>): void {
    this._openMenuRegionId = null; // close the menu
    switch (e.detail.action) {
      case 'split-right':  this._splitRegion(regionId, 'horizontal'); break;
      case 'split-down':   this._splitRegion(regionId, 'vertical'); break;
      case 'rename':       this._renameRegionWindow(regionId); break;
      case 'close-region': this._closeRegion(regionId); break;
      case 'pop-out':
        try {
          popoutManager.popOut({
            regionId,
            onClose: () => this._remountRegion(regionId), // remount in-page on close
          });
          this._detachRegion(regionId); // MOVE the surface out of the workspace
        } catch (err) {
          if ((err as Error).message === 'popout-blocked') {
            // Keep the region docked; optionally surface a hint. Never lose it.
            console.warn('Pop-out blocked by the browser; region stays docked.');
          } else {
            throw err;
          }
        }
        break;
    }
  }
```
> Implement `_splitRegion` / `_renameRegionWindow` / `_closeRegion` / `_detachRegion` / `_remountRegion` against the Phase-3 region model. `_detachRegion` hides/removes the region from layout (the surface now lives in the popped window which owns its own client); `_remountRegion` re-adds it. Add `popoutManager.dispose()` to the workspace's (or app's) `disconnectedCallback`.

**Step 4: Run the contract test + full suite**
Run: `cd web && npm test -- workspace-popout` (expect PASS), then `cd web && npm test` (expect whole suite green).

**Step 5: Commit**
Run: `git add web/src/components/workspace.ts web/src/__tests__/workspace-popout.test.ts && git commit -m "feat(web): wire region pop-out end-to-end with remount-on-close"`

---

## Task 15: E2E verification against the running `make dev` (storyboard edges)

Walk the storyboard edges with `playwright-cli` against the live server on `:8080`. Prefer **structural DOM assertions** (presence/classes via `eval`, reaching into shadow roots) over pixels. For any terminal content/layout assertion, use the **Phase-2 verification harness** (xterm snapshot == `capture-pane`; `viewportY`/dims == `playwright-cli`) — **NO OCR**.

**Files:** none (live verification). Capture findings in the commit message.

> Shadow DOM note: muxterm uses Lit shadow roots, so normal selectors won't pierce them. Use `eval` with explicit `shadowRoot` chains, e.g.
> `document.querySelector('mux-app').shadowRoot.querySelector('mux-title-bar')`.

**Step 1: Open the app**
Run: `playwright-cli open http://localhost:8080/`
Expected: page loads; snapshot shows the muxterm UI.

**Step 2: Assert the chrome baseline is present (title bar + launcher button + status bar)**
Run:
```
playwright-cli --raw eval "(() => { const a = document.querySelector('mux-app').shadowRoot; const tb = a.querySelector('mux-title-bar').shadowRoot; return JSON.stringify({ brand: tb.querySelector('.brand').textContent.trim(), launcher: !!tb.querySelector('.launcher-btn'), status: !!a.querySelector('mux-status-bar') }); })()"
```
Expected: `{"brand":"muxterm","launcher":true,"status":true}`

**Step 3: Open the global launcher and verify all seven items**
Run:
```
playwright-cli --raw eval "(() => { const tb = document.querySelector('mux-app').shadowRoot.querySelector('mux-title-bar'); tb.shadowRoot.querySelector('.launcher-btn').click(); return 'clicked'; })()"
playwright-cli --raw eval "(() => { const tb = document.querySelector('mux-app').shadowRoot.querySelector('mux-title-bar'); const menu = tb.shadowRoot.querySelector('mux-launcher-menu'); return JSON.stringify([...menu.shadowRoot.querySelectorAll('.item')].map(i => i.getAttribute('data-action'))); })()"
```
Expected (second command): `["new-session","new-browser","open-driver","settings","shortcuts","reconnect","about"]`

**Step 4: Open a NON-terminal surface beside (Settings) and assert it routed to the settings panel, no grid**
Run:
```
playwright-cli --raw eval "(() => { const tb = document.querySelector('mux-app').shadowRoot.querySelector('mux-title-bar'); const menu = tb.shadowRoot.querySelector('mux-launcher-menu'); menu.shadowRoot.querySelector('[data-action=\"settings\"]').click(); return 'opened'; })()"
```
Then wait ~500ms and assert a region now hosts `mux-settings-surface` and NOT `mux-layout`:
```
playwright-cli --raw eval "(() => { const a = document.querySelector('mux-app').shadowRoot; const regions = [...a.querySelectorAll('mux-region')]; return JSON.stringify(regions.map(r => ({ settings: !!r.shadowRoot.querySelector('mux-settings-surface'), grid: !!r.shadowRoot.querySelector('mux-layout') }))); })()"
```
Expected: at least one region object is `{"settings":true,"grid":false}`.

**Step 5: Verify a region tab strip exists with session chip + maximize + more**
Run:
```
playwright-cli --raw eval "(() => { const a = document.querySelector('mux-app').shadowRoot; const strip = a.querySelector('mux-region').shadowRoot.querySelector('mux-region-tabstrip').shadowRoot; return JSON.stringify({ chip: !!strip.querySelector('.session-chip'), max: !!strip.querySelector('.maximize-btn'), more: !!strip.querySelector('.more-btn') }); })()"
```
Expected: `{"chip":true,"max":true,"more":true}`

**Step 6: Open the region ⋯ menu and verify five actions, NO float**
Run (click `.more-btn`, then read the mounted `mux-region-menu`):
```
playwright-cli --raw eval "(() => { const r = document.querySelector('mux-app').shadowRoot.querySelector('mux-region'); r.shadowRoot.querySelector('mux-region-tabstrip').shadowRoot.querySelector('.more-btn').click(); return 'clicked'; })()"
playwright-cli --raw eval "(() => { const ws = document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace') || document.querySelector('mux-app').shadowRoot; const menu = ws.shadowRoot ? ws.shadowRoot.querySelector('mux-region-menu') : ws.querySelector('mux-region-menu'); return menu ? JSON.stringify([...menu.shadowRoot.querySelectorAll('.item')].map(i => i.getAttribute('data-action'))) : 'no-menu'; })()"
```
Expected: `["split-right","split-down","pop-out","rename","close-region"]` (and never `float`). If the menu is mounted elsewhere, adjust the selector to where Task 14 mounts `mux-region-menu`.

**Step 7: Pop out a region and assert a second window/tab appeared, then remount on close**
Run:
```
playwright-cli tab-list
playwright-cli --raw eval "(() => { /* trigger pop-out via the region menu action */ const a = document.querySelector('mux-app').shadowRoot; const menu = (a.querySelector('mux-workspace')?.shadowRoot || a).querySelector('mux-region-menu'); menu.shadowRoot.querySelector('[data-action=\"pop-out\"]').click(); return 'popped'; })()"
playwright-cli tab-list
```
Expected: the second `tab-list` shows one MORE tab/window than the first (the popped-out OS window). Then close it and confirm remount:
```
playwright-cli tab-close 1
playwright-cli --raw eval "(() => { const a = document.querySelector('mux-app').shadowRoot; return String([...a.querySelectorAll('mux-region')].length); })()"
```
Expected: after the popped window closes, the region count returns to its pre-pop-out value (the region remounted in-page).
> If `window.open` with `popup` features yields an OS window not surfaced by `tab-list`, fall back to asserting `popoutManager.isPoppedOut(...)` via `eval` and that `_detachRegion` removed the in-page region, then that it returns after close.

**Step 8: Switch session via the per-region picker (storyboard "switch session" edge)**
Run:
```
playwright-cli --raw eval "(() => { const strip = document.querySelector('mux-app').shadowRoot.querySelector('mux-region').shadowRoot.querySelector('mux-region-tabstrip'); strip.shadowRoot.querySelector('.session-chip').click(); return 'opened-picker'; })()"
playwright-cli snapshot
```
Expected: the inline `mux-session-picker` dropdown appears (`.dropdown`, session items, `.new-session`). Pick a session and confirm the region's window tabs update.

**Step 9: Terminal-content sanity via the Phase-2 harness (NO OCR)**
For any region whose surface is a terminal, run the Phase-2 verification harness comparison (xterm `StructuredSnapshot` vs tmux `capture-pane`, and `viewportY`/cols×rows vs `playwright-cli` measurements). Expected: snapshot text matches `capture-pane`; dimensions match. (Use the harness exactly as Phase 2 documents it — do not re-derive.)

**Step 10: Close the browser and commit the verification record**
Run: `playwright-cli close`
Run: `git commit --allow-empty -m "test(e2e): verify phase 4 chrome + pop-out across storyboard edges"`

---

## Done — exit criteria

- [ ] All web unit suites green: `cd web && npm test`.
- [ ] Title bar + global launcher render and route all seven actions; `open-driver` creates a TERMINAL surface, `new-browser`/`settings` create NON-TERMINAL surfaces beside the focused region.
- [ ] Per-region tab strip: session chip (inline picker), VS Code tabs (file icon + label + ×, dirty-dot for running), ⊡ maximize, ⋯ more; driver region shows magenta accent.
- [ ] Region ⋯ menu: Split right / Split down / Pop out / Rename / Close — **no Float**.
- [ ] Pop-out opens a second OS window (popped window owns its own client) and the region remounts on close; pop-out **moves**, never duplicates.
- [ ] Browser (iframe) + Settings (panel) non-terminal surfaces render with no tmux grid; terminal/driver surfaces keep the cell grid.
- [ ] Status bar shows `◉ goal` only when a driver session is active.
- [ ] E2E storyboard edges verified via `playwright-cli` (structural DOM) + Phase-2 harness for terminal content (NO OCR).

## Explicitly OUT of scope (do not build here)
Driver APPLICATION / agent TUI (separate plan — only the launcher item + rendering a `$driver` tmux session as a normal terminal surface are in scope) · Tier-2 `MUXTERM_CTL` · PWA / Window-Controls-Overlay (structure-only; do not build) · config file (Phase 5) · deep polish (Phase 5) · multi-viewer / mirror-follow-solo · float (CUT) · phone.
