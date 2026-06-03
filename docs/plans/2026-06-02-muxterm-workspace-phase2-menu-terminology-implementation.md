# Workspace Terminology — Phase 2: App Menu + Terminology Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Make the top-right `⋯` menu app-level only (Settings / Keyboard Shortcuts / Reconnect / About), remove the workspace-creation `new-session` action from it, rename the leftover `session`-era names in the live app shell to `workspace`, and add a terminology guard test that proves the rendered live chrome contains zero "session" / "window" / "region" text.

**Architecture:** This is a focused rename + chrome-trim round. The `⋯` launcher menu (`launcher-menu.ts`) stops owning workspace creation (that moved to the Phase-1 status-bar switcher) and becomes purely app-level. `app.ts` stops mapping the old `new-session` action to "open the workspace picker" and renames its `empty-session` CSS class to `empty-workspace`. A new regression test mounts the live chrome components and asserts the forbidden words never appear in rendered text.

**Tech Stack:** Lit + TypeScript web UI (`web/src/`), vitest test runner (jsdom), `lucide` icon set. Daemon protocol is untouched.

---

## CRITICAL CONTEXT — read before starting

**This is Phase 2 of a 3-phase effort. Stay strictly inside Phase 2.**

- **Phase 1 (assumed already merged before you start):** added the bottom-left status-bar workspace switcher chip, renamed the status bar's `open-session-picker` event → `open-workspace-picker` (and `app.ts`'s handler to match), re-anchored the reused `mux-workspace-picker`, and trimmed the status bar (removed the window count + the redundant `[session]` segment). **DO NOT re-do any of this.** In particular, **do not edit `web/src/components/status-bar.ts`** and **do not touch the `<mux-status-bar …>` render block or the `_onOpenWorkspacePicker` handler in `app.ts`** — those belong to Phase 1.
- **Phase 3 (later, NOT here):** deletes the dead tmux-era component cluster (`components/region*.ts`, `components/workspace.ts`, `components/tab-bar.ts`, `components/layout.ts`, `lib/workspace.ts`, `lib/popout.ts`, `lib/cell-budget.ts`, etc.) and surgically removes the tmux message paths from `types.ts` / `state.ts` / `ws.ts`. **DO NOT edit or delete any of those files in Phase 2.**

**Files that are DEAD (Phase 3 owns them — never touch in Phase 2):**
`components/region.ts`, `components/region-tabstrip.ts`, `components/region-divider.ts`, `components/region-menu.ts`, `components/resize-handle.ts`, `components/layout.ts`, `components/tab-bar.ts`, `components/workspace.ts`, `components/settings-surface.ts`, `lib/workspace.ts`, `lib/popout.ts`, `lib/cell-budget.ts`, `lib/resize-coalescer.ts`, `lib/layout-parser.ts`, plus all of their `__tests__/*.test.ts`.

> **Why `settings-surface.ts` is on the DEAD list:** it is reachable ONLY through `components/region.ts` (its sole importer), which is in the Phase-3 deletion cluster and is **not** reachable from `app.ts`. It is therefore not live this round. Its single stale string (`"…connects to a tmux session over WebSocket…"`) is intentionally left alone — Phase 3 removes the file (or its dead importer) entirely. **Do not edit `settings-surface.ts`.**

**Files that are LIVE and IN SCOPE for Phase 2:**
- `web/src/components/launcher-menu.ts` (+ `web/src/__tests__/launcher-menu.test.ts`)
- `web/src/app.ts` (+ `web/src/__tests__/app.test.ts`)
- `web/src/components/title-bar.ts` (verify-only — expected to need no change)
- New file: `web/src/__tests__/terminology-guard.test.ts`

---

## Commands you will use (run from the repo root)

| Purpose | Command |
| --- | --- |
| Run ONE test file | `cd web && npx vitest run src/__tests__/<file>.test.ts` |
| Run the full web suite | `cd web && npm test` |
| Type-check | `cd web && npx tsc --noEmit` |
| Production build | `cd web && npx vite build` |

> The web tests live under `web/src/__tests__/`. Source under `web/src/`. Always `cd web` first.

---

## Orientation (do this once, ~2 min, before Task 1)

Read these files so you understand the current shape (they are short):

- `web/src/components/launcher-menu.ts` — the `⋯` dropdown. Today it exports `type LauncherAction = 'new-session' | 'settings' | 'reconnect'` and renders **New session / Settings / Reconnect**.
- `web/src/components/title-bar.ts` — renders the `⋯` button and `<mux-launcher-menu>`, and re-dispatches `launcher-action` upward via `_onLauncherAction`. It forwards `e.detail` **generically** (no hard-coded action names), so it needs no change — you will confirm this in Task 3.
- `web/src/app.ts` — `_onLauncherAction` (around line 387) has a `switch` with a single `case 'new-session':` that opens the workspace picker. The empty-state markup uses the CSS class `empty-session` (CSS block ~lines 83-137, markup ~line 293).
- `web/src/__tests__/launcher-menu.test.ts` and `web/src/__tests__/app.test.ts` — the tests you will update.

Do not change anything yet.

---

## Task 1: Launcher menu becomes app-level only; app stops treating it as workspace-creation

> This task is intentionally atomic: removing `'new-session'` from the `LauncherAction` union makes `app.ts`'s `case 'new-session':` a type error, so the menu rename and the `app.ts` handler edit **must land in the same commit** to keep `tsc` green. Each step below is still a single action.

**Files:**
- Modify: `web/src/components/launcher-menu.ts`
- Modify: `web/src/__tests__/launcher-menu.test.ts`
- Modify: `web/src/app.ts` (only the `_onLauncherAction` method, ~lines 387-398)
- Modify: `web/src/__tests__/app.test.ts` (the "launcher fires new-session" test, ~lines 224-237)

---

**Step 1: Rewrite the launcher-menu test to expect app-level items**

Replace the entire contents of `web/src/__tests__/launcher-menu.test.ts` with:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/launcher-menu.js';
import type { MuxLauncherMenu, LauncherAction } from '../components/launcher-menu.js';

async function fixture(): Promise<MuxLauncherMenu> {
  const el = document.createElement('mux-launcher-menu') as MuxLauncherMenu;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxLauncherMenu', () => {
  let el: MuxLauncherMenu;

  afterEach(() => {
    if (el?.parentNode) el.parentNode.removeChild(el);
  });

  it('registers as mux-launcher-menu custom element', () => {
    const ctor = customElements.get('mux-launcher-menu');
    expect(ctor).toBeDefined();
  });

  it('renders exactly the 4 app-level items in order (settings, shortcuts, reconnect, about)', async () => {
    el = await fixture();
    const buttons = el.shadowRoot!.querySelectorAll('button[data-action]');
    const actions = Array.from(buttons).map((b) => b.getAttribute('data-action'));
    expect(actions).toEqual(['settings', 'shortcuts', 'reconnect', 'about']);
  });

  it('no longer renders the workspace-creation item (new-session)', async () => {
    el = await fixture();
    expect(el.shadowRoot!.querySelector('button[data-action="new-session"]')).toBeNull();
  });

  it('dispatches launcher-action with the clicked app-level action in detail', async () => {
    el = await fixture();
    const handler = vi.fn();
    el.addEventListener('launcher-action', handler as EventListener);

    const btn = el.shadowRoot!.querySelector(
      'button[data-action="settings"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ action: LauncherAction }>;
    expect(event.detail.action).toBe('settings');
  });

  it('does not render removed stub items (new-browser, open-driver)', async () => {
    el = await fixture();
    expect(el.shadowRoot!.querySelector('button[data-action="new-browser"]')).toBeNull();
    expect(el.shadowRoot!.querySelector('button[data-action="open-driver"]')).toBeNull();
  });
});
```

---

**Step 2: Run the launcher-menu test to verify it FAILS**

Run: `cd web && npx vitest run src/__tests__/launcher-menu.test.ts`
Expected: FAIL — the "renders exactly the 4 app-level items" test fails because the current menu still renders `['new-session', 'settings', 'reconnect']` (no `shortcuts`/`about`).

---

**Step 3: Rewrite `launcher-menu.ts` to render the 4 app-level items**

Replace the entire contents of `web/src/components/launcher-menu.ts` with:

```ts
import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';
import { icon } from '../lib/icons.js';
import { Info, Keyboard, RefreshCw, Settings } from 'lucide';

export type LauncherAction =
  | 'settings'
  | 'shortcuts'
  | 'reconnect'
  | 'about';

@customElement('mux-launcher-menu')
export class MuxLauncherMenu extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: ${unsafeCSS(CHROME.bar)};
      border: 1px solid ${unsafeCSS(CHROME.border)};
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      padding: 4px;
      min-width: 180px;
    }

    .divider {
      height: 1px;
      background: ${unsafeCSS(CHROME.border)};
      margin: 4px 0;
    }

    button {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 10px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: ${unsafeCSS(CHROME.textBright)};
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      box-sizing: border-box;
    }

    button:hover {
      background: ${unsafeCSS(CHROME.hover)};
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }

    button .lucide-icon {
      pointer-events: none;
    }
  `;

  private _dispatch(action: LauncherAction): void {
    this.dispatchEvent(
      new CustomEvent('launcher-action', {
        bubbles: true,
        composed: true,
        detail: { action },
      }),
    );
  }

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
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-launcher-menu': MuxLauncherMenu;
  }
}
```

> Note: the old `button.driver` style rule was removed because no item uses it anymore. The icon imports changed from `{ Plus, RefreshCw, Settings }` to `{ Info, Keyboard, RefreshCw, Settings }` — all four are valid `lucide` exports (verified).

---

**Step 4: Fix `app.ts`'s `_onLauncherAction` so it no longer references the removed `new-session` action**

In `web/src/app.ts`, find this method (around lines 387-398):

```ts
  private _onLauncherAction = (e: CustomEvent<{ action: LauncherAction }>): void => {
    const { action } = e.detail;
    switch (action) {
      case 'new-session':
        // In the workspace model, "new session" opens the workspace picker
        // where the user can create or switch workspaces.
        this._showWorkspacePicker = true;
        break;
      default:
        break;
    }
  };
```

Replace it with:

```ts
  private _onLauncherAction = (): void => {
    // The ⋯ menu is app-level only (Settings / Keyboard Shortcuts / Reconnect /
    // About). These items are presentational this round; functional wiring lands
    // in a later round. Workspace creation now lives in the bottom-left status-bar
    // switcher, NOT this menu — so launcher actions must never open the picker.
  };
```

> Leave the `@launcher-action="${this._onLauncherAction}"` binding in `render()` exactly as-is — only the method body/signature changes.

---

**Step 5: Update the stale `new-session` test in `app.test.ts`**

In `web/src/__tests__/app.test.ts`, find this test (around lines 224-237):

```ts
    it('sets _showWorkspacePicker true when launcher fires new-session', async () => {
      el = await fixture();
      expect((el as any)._showWorkspacePicker).toBe(false);
      const titleBar = el.shadowRoot!.querySelector('mux-title-bar')!;
      titleBar.dispatchEvent(
        new CustomEvent('launcher-action', {
          bubbles: true,
          composed: true,
          detail: { action: 'new-session' },
        }),
      );
      await el.updateComplete;
      expect((el as any)._showWorkspacePicker).toBe(true);
    });
```

Replace it with:

```ts
    it('app-level launcher actions do NOT open the workspace picker (creation lives in the switcher)', async () => {
      el = await fixture();
      expect((el as any)._showWorkspacePicker).toBe(false);
      const titleBar = el.shadowRoot!.querySelector('mux-title-bar')!;
      titleBar.dispatchEvent(
        new CustomEvent('launcher-action', {
          bubbles: true,
          composed: true,
          detail: { action: 'settings' },
        }),
      );
      await el.updateComplete;
      expect((el as any)._showWorkspacePicker).toBe(false);
    });
```

---

**Step 6: Run the two affected test files to verify they PASS**

Run: `cd web && npx vitest run src/__tests__/launcher-menu.test.ts src/__tests__/app.test.ts`
Expected: PASS — all tests in both files green.

---

**Step 7: Type-check to confirm the union change is clean everywhere**

Run: `cd web && npx tsc --noEmit`
Expected: no output (exit 0). This confirms nothing else still references the removed `'new-session'` `LauncherAction` member.

> If `tsc` reports an error in a file under the Phase-3 DEAD list (e.g. `region-tabstrip.ts`), STOP — that means a dead file is referencing `LauncherAction`. It is not; those files emit the string `'new-session'` as a raw event name, not as the typed `LauncherAction`, so they will NOT error. If you somehow see such an error, do not "fix" the dead file — re-read the CRITICAL CONTEXT section and confirm you only edited the in-scope files.

---

**Step 8: Commit**

```
cd web && git add src/components/launcher-menu.ts src/__tests__/launcher-menu.test.ts src/app.ts src/__tests__/app.test.ts
git commit -m "$(cat <<'EOF'
feat(web): make the ⋯ menu app-level only (Settings/Shortcuts/Reconnect/About)

Remove the workspace-creation 'new-session' action from the launcher menu —
creation now lives in the Phase-1 status-bar switcher — and decouple app.ts's
launcher handler so menu actions never open the workspace picker.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 2: Rename the `empty-session` CSS class to `empty-workspace`

The empty-state's visible copy already says "workspace" / "No panes" / "New pane"; only the CSS class name and one test selector still say `session`.

**Files:**
- Modify: `web/src/app.ts` (CSS block + empty-state markup)
- Modify: `web/src/__tests__/app.test.ts` (the empty-state selector, ~line 142)

---

**Step 1: Update the empty-state test to expect the new class**

In `web/src/__tests__/app.test.ts`, find (around line 142):

```ts
    expect(el.shadowRoot!.querySelector('.empty-session')).toBeTruthy();
```

Replace it with:

```ts
    expect(el.shadowRoot!.querySelector('.empty-workspace')).toBeTruthy();
```

---

**Step 2: Run the app test to verify it FAILS**

Run: `cd web && npx vitest run src/__tests__/app.test.ts`
Expected: FAIL — the "renders empty state gracefully when no panes" test fails because the markup still uses `class="empty-session"`, so `.empty-workspace` is not found.

---

**Step 3: Rename the class in `app.ts` (CSS rules + markup)**

In `web/src/app.ts`, rename every occurrence of the CSS class `empty-session` to `empty-workspace`. There are 7 occurrences — 6 in the `static styles` block and 1 in the `render()` markup:

- `.empty-session {` → `.empty-workspace {`
- `.empty-session .glyph {` → `.empty-workspace .glyph {`
- `.empty-session .headline {` → `.empty-workspace .headline {`
- `.empty-session .subtext {` → `.empty-workspace .subtext {`
- `.empty-session button {` → `.empty-workspace button {`
- `.empty-session button:hover {` → `.empty-workspace button:hover {`
- `<div class="empty-session">` → `<div class="empty-workspace">`

> The simplest safe way: do a whole-file find/replace of the exact substring `empty-session` → `empty-workspace` in `web/src/app.ts`. That string appears nowhere else in the file, so a replace-all is safe. Leave the existing comment "Empty workspace state …" unchanged (it is already correct).

---

**Step 4: Run the app test to verify it PASSES**

Run: `cd web && npx vitest run src/__tests__/app.test.ts`
Expected: PASS.

---

**Step 5: Commit**

```
cd web && git add src/app.ts src/__tests__/app.test.ts
git commit -m "$(cat <<'EOF'
refactor(web): rename empty-session CSS class to empty-workspace

Terminology cleanup: the empty-state already reads "workspace"; align the
CSS class name and its test selector with the workspace vocabulary.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 3: Verify the remaining live shell has no other stale terminology

This task is a **verification + enumeration** task. It confirms there is nothing else to rename in the live (reachable-from-`app.ts`) code, and that `title-bar.ts` needs no change. No production code is edited; nothing to commit unless the grep surfaces a genuine live straggler (see the decision rule).

---

**Step 1: Confirm `title-bar.ts` needs no change**

Open `web/src/components/title-bar.ts` and confirm `_onLauncherAction` (around line 125) re-dispatches `customEvent.detail` **generically** — it does not name `'new-session'` or any specific action. Therefore it works unchanged with the new app-level action set.

Run this to prove there are no hard-coded action strings in the file:
Run: `cd web && grep -nE "new-session|new-browser|open-driver" src/components/title-bar.ts || echo "CLEAN: no stale action names in title-bar.ts"`
Expected: `CLEAN: no stale action names in title-bar.ts`

---

**Step 2: Enumerate stale terminology across the LIVE source (excluding tests and the Phase-3 dead cluster)**

Run:
```
cd web && grep -rniE "session|window|region" src --include=*.ts \
  | grep -vE "/__tests__/" \
  | grep -vE "src/(types|state|ws)\.ts" \
  | grep -vE "src/components/(region|region-tabstrip|region-divider|region-menu|resize-handle|layout|tab-bar|workspace|settings-surface)\.ts" \
  | grep -vE "src/lib/(workspace|popout|cell-budget|resize-coalescer|layout-parser)\.ts"
```

Read the output and classify each hit. The expected surviving hits are all **non-user-facing** and must be LEFT ALONE:

| Hit | Why it stays |
| --- | --- |
| `app.ts` — `window.addEventListener`, `window.innerWidth`, `_onWindowResize`, `window.dispatchEvent`, dev-only `window.__mux*` accessors | the JavaScript global `window`, not UI text |
| `components/status-bar.ts` — anything | Phase 1 owns the status bar; do NOT touch it here |
| `components/workspace-picker.ts` — `window.prompt('Rename workspace:')` | `window` is the global; the rendered string is "Rename workspace" (clean) |
| `lib/keybindings.ts`, `lib/config.ts` — `nextSession`, `maximizeRegion`, `sharedWindowPolicy`, `rails: ['sessions']` | internal config keys / action identifiers; never rendered as UI text |
| `lib/theme.ts`, `lib/terminal-registry.ts` — code comments | comments, not rendered text |

**Decision rule:** If — and only if — the grep reveals a **user-facing rendered string** (template text inside an `html\`…\`` literal that a user would read) containing the standalone words "session", "window", or "region" in a **live, in-scope** file, rename it to the workspace vocabulary in a follow-up micro-task (test → impl → commit). Based on the current tree, **no such straggler is expected** — the only live user-facing offenders were the launcher menu (Task 1) and the status bar (Phase 1). Record your finding in the task notes.

> Do NOT rename `settings-surface.ts` (DEAD — Phase 3), and do NOT rename internal identifiers like `nextSession`/`maximizeRegion` — those are out of scope for this terminology round and changing them risks breaking config parsing and keybindings.

---

**Step 3: Record the result (no commit)**

State explicitly in your task summary: "Live-shell terminology enumeration complete — no additional live user-facing `session`/`window`/`region` strings beyond launcher-menu (fixed) and status-bar (Phase 1). `title-bar.ts` unchanged." There is nothing to commit for this task.

---

## Task 4: Add the terminology guard test (regression net)

Add a test that mounts the live chrome and asserts the rendered text contains zero "session" / "window" / "region". This is a cheap regression net so the rename can't silently creep back.

**Files:**
- Create: `web/src/__tests__/terminology-guard.test.ts`

---

**Step 1: Write the guard test**

Create `web/src/__tests__/terminology-guard.test.ts` with:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock WebSocket BEFORE importing the app (mux-app opens a socket on connect).
// Mirrors the setup used in app.test.ts.
// ---------------------------------------------------------------------------
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.OPEN;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      if (this.onopen) this.onopen();
    });
  }

  send = vi.fn();
  close = vi.fn();
}

// @ts-expect-error mock WebSocket globally
globalThis.WebSocket = MockWebSocket;

// Register the live chrome elements.
import '../app.js';
import '../components/title-bar.js';
import '../components/launcher-menu.js';
import type { MuxApp } from '../app.js';
import type { MuxLauncherMenu } from '../components/launcher-menu.js';

const FORBIDDEN = ['session', 'window', 'region'];

/**
 * Collect ALL rendered text from a node, descending into nested shadow roots.
 * Returns the concatenated, lowercased visible text.
 */
function deepText(root: Node): string {
  let out = '';
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += ' ' + (node.textContent ?? '');
    }
    const el = node as Element;
    if (el.shadowRoot) visit(el.shadowRoot);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return out.toLowerCase();
}

function assertNoForbiddenWords(text: string, where: string): void {
  for (const word of FORBIDDEN) {
    expect(
      text.includes(word),
      `Rendered text of ${where} must not contain "${word}", but it did: …${text.trim().slice(0, 200)}…`,
    ).toBe(false);
  }
}

describe('terminology guard — live chrome speaks only "workspace"', () => {
  let app: MuxApp | null = null;
  let menu: MuxLauncherMenu | null = null;

  afterEach(() => {
    if (app?.parentNode) app.parentNode.removeChild(app);
    if (menu?.parentNode) menu.parentNode.removeChild(menu);
    app = null;
    menu = null;
  });

  it('the app shell (title bar, status bar, empty workspace state) contains no session/window/region text', async () => {
    // Empty-state render: no panes attached.
    app = document.createElement('mux-app') as MuxApp;
    document.body.appendChild(app);
    await app.updateComplete;
    // Let nested children (title bar, status bar) render.
    await Promise.resolve();
    await app.updateComplete;

    const text = deepText(app);
    assertNoForbiddenWords(text, 'mux-app empty-state shell');
  });

  it('the ⋯ app menu contains no session/window/region text', async () => {
    menu = document.createElement('mux-launcher-menu') as MuxLauncherMenu;
    document.body.appendChild(menu);
    await menu.updateComplete;

    const text = deepText(menu);
    assertNoForbiddenWords(text, 'mux-launcher-menu');
  });
});
```

> Why this works: `deepText` walks into every nested `shadowRoot`, so mounting `<mux-app>` in its empty state transitively captures the rendered text of `<mux-title-bar>`, `<mux-status-bar>`, and the empty-workspace markup. The launcher menu only renders when opened, so it is mounted standalone. The guard checks **rendered text** (not class names), so the `empty-workspace` class rename is irrelevant to it — the net targets words a user would actually read.

---

**Step 2: Run the guard to verify it PASSES**

Run: `cd web && npx vitest run src/__tests__/terminology-guard.test.ts`
Expected: PASS — both assertions green, because Task 1 removed "New session" from the menu and Phase 1 trimmed the status bar's "no session"/"windows" text.

> **If it FAILS:** the failure message prints the offending word and a text snippet. Trace it to the live component that rendered it:
> - If the offender is in the **launcher menu** → re-check Task 1 (you missed an item).
> - If the offender is in the **status bar** ("no session", "N windows") → that is Phase-1 territory; STOP and confirm Phase 1 actually merged before this phase. Do **not** edit `status-bar.ts` in Phase 2.
> - If the offender is the empty-state copy → it should already read "workspace"/"No panes"/"New pane"; fix the specific string only.
> Do not weaken the guard (e.g. by whitelisting a word) to make it pass.

---

**Step 3: Commit**

```
cd web && git add src/__tests__/terminology-guard.test.ts
git commit -m "$(cat <<'EOF'
test(web): add terminology guard — live chrome contains no session/window/region

Mounts the live shell (title bar, status bar, empty workspace state) and the ⋯
app menu and asserts rendered text uses only the workspace vocabulary. Cheap
regression net for the terminology rename.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Final Gate (run after all tasks; do NOT skip)

Run these three commands from the repo root and confirm each is clean before declaring Phase 2 done:

1. **Type-check:** `cd web && npx tsc --noEmit`
   Expected: no output, exit 0.

2. **Production build:** `cd web && npx vite build`
   Expected: build completes with no errors.

3. **Full web suite:** `cd web && npm test`
   Expected: all tests green. The previously-existing web tests remain green; the only behavioral test changes are the ones you edited in `launcher-menu.test.ts` and `app.test.ts`, plus the new `terminology-guard.test.ts`.

> Do NOT run `git push`, open a PR, or merge. Stop after the final gate is green and report the results.

---

## Out of scope for Phase 2 (do NOT do these here)

- Editing `status-bar.ts` or the `<mux-status-bar>` render / `_onOpenWorkspacePicker` handler in `app.ts` (Phase 1).
- Wiring functional behavior for Settings / Keyboard Shortcuts / Reconnect / About (presentational this round).
- Editing `settings-surface.ts` or any DEAD tmux-cluster file (Phase 3).
- Surgical removal of tmux message types/paths in `types.ts` / `state.ts` / `ws.ts` (Phase 3).
- Renaming internal config/keybinding identifiers (`nextSession`, `maximizeRegion`, `sharedWindowPolicy`, `rails: ['sessions']`).
- `git push` / PR / merge.
