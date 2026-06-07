# Touch-Safe Pane Close with Undo — Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Make touch/pen-initiated pane closes recoverable for 10 seconds via an Undo toast, while leaving the mouse close path instant and unchanged.

**Architecture:** Three pieces collaborate. `mux-dock` detects the pointer type that triggered a close and tags the existing `pane-close` event with `{ touch, title }`, plus gains a `reopenPane()` method. `mux-app` owns the deferred-kill lifecycle (a `_pendingCloses` timer map), branches on `touch` in `_onClosePane`, and renders one `<mux-undo-toast>` per pending close. `mux-undo-toast` is a new Lit element that shows a countdown + Undo button and self-destructs on expiry.

**Tech Stack:** TypeScript, Lit 3, dockview-core, xterm.js. Verification via `playwright-cli` `.mjs` E2E scripts and the `/muxterm-verify` skill.

---

## READ THIS FIRST — Orientation for the implementer

You know nothing about this codebase. That is fine. Here is everything you need.

### The three files you will touch (and what they are)

- `web/src/components/mux-dock.ts` — a Lit element (`<mux-dock>`) that wraps **dockview** (a tiling/tab panel library). Each "pane" (a terminal) is a dockview *panel*. When a user clicks a tab's X button, dockview fires `onDidRemovePanel`, and this file dispatches a `pane-close` CustomEvent up to `mux-app`. **Important:** this element uses **light DOM** (`createRenderRoot()` returns `this`), not a shadow root — required for dockview drag-and-drop.
- `web/src/app.ts` — the top-level Lit element (`<mux-app>`). It uses a **shadow root** (normal Lit). It listens for `pane-close` and currently kills the pane immediately. It owns the WebSocket (`this._socket`) and the terminal registry.
- `web/src/components/mux-undo-toast.ts` — **does not exist yet.** You will create it.

### Two facts that will save you an hour

1. **There is NO `_reconcile()` method in `mux-dock.ts`.** The design doc mentions it conceptually, but the actual reconciler logic lives inline inside `updated()` under "Case 2" and only runs when the `panes` property *changes*. Because `reopenPane()` does not change `panes`, you cannot just "trigger a reconcile" — you must **re-add the dockview panel directly**. The exact code is given in Task 2, Step 5. Do not go looking for `_reconcile()`; it isn't there.

2. **The E2E harness is NOT `@playwright/test`.** This repo has no `playwright.config.ts`, no `.spec.ts` runner, and `@playwright/test` is not installed. Existing E2E tests (`web/e2e/*.mjs`) are plain Node scripts that shell out to a globally-installed `playwright-cli` tool with two commands: `open <url>` and `eval <js>`. They assert by `eval`-ing JavaScript in the page and parsing the JSON result. **There is no `page.clock` and no `hasTouch` browser context available.** This plan therefore tests touch behavior by dispatching **synthetic `PointerEvent`s** in `eval` (the close handler only reads `event.pointerType`, so a synthetic touch event is sufficient) and tests the 10s expiry with a **DEV-only test seam** (`window.__muxForceExpire`) instead of waiting 10 real seconds. This matches the existing repo convention. See Task 1.

### Commands you will run (memorize these)

- Fast type + lint check: `cd web && npm run check:fast`  (runs tsgo + oxlint)
- Full build (commit gate): `cd web && npm run build`
- Start the dev server for manual/E2E testing: see Task 5.

### Commit style

Conventional commits: `feat:`, `test:`, `fix:`, `chore:`. Commit after every task.

---

## A note on test ordering (read before Task 1)

Pure red-green-refactor is awkward here because the E2E script needs a **running muxterm server** and a **real browser session** via `playwright-cli`. We still write the test first (Task 1) and confirm it fails, but "confirm it fails" means: run it against the current build and observe it reports failures because the feature isn't implemented yet. The test references DEV-only hooks (`window.__muxPendingCloses`, `window.__muxForceExpire`) that you will add in Task 4 — until then the test fails at those calls, which is the expected RED state.

---

## Task 1: Write the E2E test script (RED)

**Files:**
- Create: `web/e2e/touch-close-undo.mjs`

This is a Node script driven by `playwright-cli`, modeled on the existing `web/e2e/dock-tab-stress.mjs` and `web/e2e/content-fidelity.mjs`. It assumes a muxterm dev server is already running (default `http://localhost:9090`) — Task 5 explains how to start it.

**Step 1: Read the two existing E2E scripts to copy their `playwright-cli` plumbing.**

Run:
```
sed -n '85,160p' web/e2e/dock-tab-stress.mjs
```
Note the `pcli(...)` / `pevalJson(...)` helper pattern (how they call `playwright-cli`, pass `--raw eval`, and unwrap the possibly-double-encoded JSON result). You will reuse that exact pattern.

**Step 2: Write the test script.**

Create `web/e2e/touch-close-undo.mjs` with this content:

```js
#!/usr/bin/env node
/**
 * touch-close-undo.mjs — E2E for touch-safe pane close with undo.
 *
 * Verifies three scenarios against a running muxterm server:
 *   1. Touch close -> toast/pending-close appears -> Undo -> pane present + xterm buffer intact.
 *   2. Touch close -> force-expire (DEV seam) -> pane absent from server state.
 *   3. Mouse close -> no pending close -> pane closes immediately.
 *
 * Usage:  node web/e2e/touch-close-undo.mjs [--url http://localhost:9090]
 *
 * Exit codes: 0 = all passed, 1 = an assertion failed, 2 = setup error.
 *
 * Prereqs: playwright-cli installed globally; muxterm dev server running at --url.
 */

import { execFileSync } from 'node:child_process';

// ── arg parsing ──────────────────────────────────────────────────────────
let url = 'http://localhost:9090';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && i + 1 < argv.length) url = argv[++i];
  else if (argv[i].startsWith('--url=')) url = argv[i].slice('--url='.length);
}

// ── playwright-cli helpers (mirrors dock-tab-stress.mjs) ─────────────────
function pcli(...args) {
  return execFileSync('playwright-cli', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** eval JS in the page and JSON.parse the (possibly double-encoded) result. */
function pevalJson(js) {
  const raw = execFileSync('playwright-cli', ['--raw', 'eval', js], { encoding: 'utf8' });
  const start = raw.indexOf('{');
  const arrStart = raw.indexOf('[');
  // pick whichever bracket appears first as the JSON root
  let s = start;
  if (arrStart !== -1 && (start === -1 || arrStart < start)) s = arrStart;
  const openCh = raw[s];
  const closeCh = openCh === '{' ? '}' : ']';
  const e = raw.lastIndexOf(closeCh);
  if (s === -1 || e === -1) throw new Error(`No JSON in eval output:\n${raw}`);
  let slice = raw.slice(s, e + 1);
  try { return JSON.parse(slice); }
  catch {
    // double-encoded: parse the surrounding quoted string first
    const q = raw.indexOf('"');
    const q2 = raw.lastIndexOf('"');
    return JSON.parse(JSON.parse(raw.slice(q, q2 + 1)));
  }
}

function sleep(ms) { execFileSync('sleep', [String(ms / 1000)]); }

// ── shared page-side helpers, injected as a string into every eval ───────
// NOTE: kept as a string so we can prepend it to each eval snippet.
const HELPERS = `
  function _dock() {
    return document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
  }
  function _tabFor(paneId) {
    const dock = _dock();
    // dockview panel ids are the stringified paneId; the tab content holds the title,
    // but the close action lives in .dv-default-tab-action inside the same .dv-tab.
    const panels = [...dock.querySelectorAll('.dv-tab')];
    // Map tab -> paneId via the active panel API is unreliable here, so match by
    // the dockview group's panel order is fragile; instead we use the dev hook.
    return panels;
  }
  // Dispatch a synthetic pointerdown of a given type on the dock host so the
  // capture-phase listener records _lastPointerType, then click the close X.
  function _closePane(paneId, pointerType) {
    const dock = _dock();
    dock.dispatchEvent(new PointerEvent('pointerdown', { pointerType, bubbles: true }));
    // Find the close action for this pane's tab. We resolve the tab by asking the
    // dev hook for the close button element.
    const btn = window.__muxCloseButtonFor(paneId);
    if (!btn) throw new Error('close button not found for pane ' + paneId);
    btn.click();
  }
`;

// ── test driver ──────────────────────────────────────────────────────────
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  PASS:', name); }
  else { failures++; console.log('  FAIL:', name, extra ? JSON.stringify(extra) : ''); }
}

try {
  pcli('open', url);
  sleep(1500); // allow first composition + auto-spawned pane to settle

  // Ensure we have at least TWO panes so closing one leaves the app non-empty.
  pcli('eval', `${HELPERS}; window.__muxStore && document.querySelector('mux-app')` +
    `.shadowRoot.querySelector('mux-dock') && (function(){` +
    `  const app = document.querySelector('mux-app');` +
    `  app.dispatchEvent(new CustomEvent('noop'));` +
    `})()`);
  // Create a second pane via the app's optimistic create (split keybinding path).
  pcli('eval', `(function(){ const a = document.querySelector('mux-app'); ` +
    `a.shadowRoot.querySelector('mux-dock').dispatchEvent(` +
    `new CustomEvent('pane-create', { bubbles: true, composed: true })); })()`);
  sleep(1500);

  const ids = pevalJson(`JSON.stringify(window.__muxStore.panes.filter(p=>p.paneId>=0).map(p=>p.paneId))`);
  if (!Array.isArray(ids) || ids.length < 2) {
    console.error('SETUP ERROR: expected >=2 panes, got', ids);
    process.exit(2);
  }
  const target = ids[ids.length - 1]; // close the last one

  // ── Scenario 1: touch close -> pending appears -> undo -> intact ──────
  console.log('Scenario 1: touch close + undo');
  const before = pevalJson(
    `JSON.stringify({ content: document.querySelector('mux-app').shadowRoot` +
    `.querySelector('mux-dock').getTerminalContent(${target}) })`);
  pcli('eval', `${HELPERS}; _closePane(${target}, 'touch')`);
  sleep(300);
  const pending1 = pevalJson(`JSON.stringify(window.__muxPendingCloses())`);
  check('pending close registered for target', pending1.includes(target), { pending1 });
  // tap Undo
  pcli('eval', `window.__muxUndoClose(${target})`);
  sleep(500);
  const afterPanes = pevalJson(`JSON.stringify(window.__muxStore.panes.filter(p=>p.paneId>=0).map(p=>p.paneId))`);
  check('pane present again after undo', afterPanes.includes(target), { afterPanes });
  const after = pevalJson(
    `JSON.stringify({ content: document.querySelector('mux-app').shadowRoot` +
    `.querySelector('mux-dock').getTerminalContent(${target}) })`);
  check('xterm buffer intact after undo', after.content === before.content,
    { before: before.content.slice(0, 40), after: after.content.slice(0, 40) });

  // ── Scenario 2: touch close -> force-expire -> pane gone ─────────────
  console.log('Scenario 2: touch close + expiry');
  pcli('eval', `${HELPERS}; _closePane(${target}, 'touch')`);
  sleep(300);
  const pending2 = pevalJson(`JSON.stringify(window.__muxPendingCloses())`);
  check('pending close registered before expiry', pending2.includes(target), { pending2 });
  pcli('eval', `window.__muxForceExpire(${target})`);
  sleep(800);
  const goneServer = pevalJson(`JSON.stringify(window.__muxStore.panes.map(p=>p.paneId))`);
  check('pane absent from server state after expiry', !goneServer.includes(target), { goneServer });

  // ── Scenario 3: mouse close -> instant, no pending ──────────────────
  console.log('Scenario 3: mouse close (instant)');
  const remaining = pevalJson(`JSON.stringify(window.__muxStore.panes.filter(p=>p.paneId>=0).map(p=>p.paneId))`);
  const mouseTarget = remaining[remaining.length - 1];
  pcli('eval', `${HELPERS}; _closePane(${mouseTarget}, 'mouse')`);
  sleep(300);
  const pending3 = pevalJson(`JSON.stringify(window.__muxPendingCloses())`);
  check('no pending close for mouse close', !pending3.includes(mouseTarget), { pending3 });

  console.log('');
  if (failures > 0) { console.error(`${failures} check(s) FAILED`); process.exit(1); }
  console.log('ALL CHECKS PASSED');
  process.exit(0);
} catch (err) {
  console.error('SETUP ERROR:', err.message);
  process.exit(2);
} finally {
  try { execFileSync('playwright-cli', ['close'], { stdio: 'ignore' }); } catch { /* ignore */ }
}
```

> The script references several DEV-only hooks that do not exist yet: `window.__muxPendingCloses`, `window.__muxUndoClose`, `window.__muxForceExpire`, and `window.__muxCloseButtonFor`. You will add all of them in Task 4. Until then, the script fails — that is the intended RED state.

**Step 3: Run the test to confirm it fails (RED).**

Start the dev server first (see Task 5, Step 1), then run:
```
node web/e2e/touch-close-undo.mjs --url http://localhost:9090
```
Expected: exits non-zero. Most likely a `SETUP ERROR` referencing `window.__muxPendingCloses is not a function` (the seams don't exist yet) — that is correct RED behavior.

If the dev server is not running and you cannot start it in this environment, that is acceptable for the RED step — record that the script is written and will be executed in Task 5. Proceed to commit.

**Step 4: Commit.**
```
git add web/e2e/touch-close-undo.mjs && git commit -m "test: add touch-close-undo E2E script (RED)"
```

---

## Task 2: Augment `mux-dock` with pointer detection, event fields, and `reopenPane()`

**Files:**
- Modify: `web/src/components/mux-dock.ts`

**Step 1: Add the `_lastPointerType` field.**

Find the private field block (around line 161, near `private _dv: DockviewComponent | null = null;`). Add this field directly after the `_locallyClosedPanes` declaration (around line 171):

```ts
  /** Pointer type that initiated the most recent interaction ('mouse' | 'touch' | 'pen').
   *  Read in onDidRemovePanel to decide whether a close should be deferred. */
  private _lastPointerType: string = 'mouse';
```

**Step 2: Add a capture-phase `pointerdown` listener in `connectedCallback`.**

In `connectedCallback()`, find the line `this.classList.add('dockview-theme-abyss');` (around line 427). Insert this immediately *before* it:

```ts
    // Record the pointer type that starts each interaction. The capture phase
    // guarantees we see it before dockview processes the click and fires
    // onDidRemovePanel, so the close branch knows whether it was a touch/pen.
    this.addEventListener(
      'pointerdown',
      (e: PointerEvent) => { this._lastPointerType = e.pointerType || 'mouse'; },
      { capture: true },
    );
```

**Step 3: Capture the title and `touch` flag, and add them to the `pane-close` event.**

Find the `onDidRemovePanel` handler (around lines 458-473). Replace the inner `if (this._panels.has(paneId)) { ... }` block so it captures the title and emits the richer detail. The full updated handler should read:

```ts
    this._dv.onDidRemovePanel((panel) => {
      if (this._removingPanels) return;
      const paneId = parseInt(panel.id, 10);
      if (this._panels.has(paneId)) {
        // Capture the tab title BEFORE deleting the panel record — the toast
        // labels itself "<title> closed". Falls back to "Pane N".
        const title = panel.title ?? `Pane ${paneId}`;
        const touch = this._lastPointerType === 'touch' || this._lastPointerType === 'pen';
        this._panels.delete(paneId);
        this._locallyClosedPanes.add(paneId);
        this.dispatchEvent(
          new CustomEvent('pane-close', {
            detail: { paneId, touch, title },
            bubbles: true,
            composed: true,
          }),
        );
      }
      requestAnimationFrame(() => {
        if (this._dv) {
          this._dv.layout(this.offsetWidth, this.offsetHeight, true);
        }
      });
    });
```

**Step 4: Verify types.**

Run: `cd web && npm run check:fast`
Expected: PASS (no errors).

**Step 5: Add the `reopenPane()` method.**

> **Why this is hand-written and not a call to `_reconcile()`:** there is no `_reconcile()` method. The reconciler is inline in `updated()` Case 2 and only fires when `panes` changes. `reopenPane()` does not change `panes`, so it must re-add the dockview panel itself, mirroring the add logic from Case 2 (lines ~685-707) but without placement handling (re-added panels land at dockview's default position — a documented, accepted limitation).

Add this method to the `MuxDock` class, directly after the `getTerminalContent` method (around line 742, before the closing `}` of the class):

```ts
  /**
   * Undo a local close: re-enable the reconciler for this pane and re-add its
   * dockview panel immediately. The server never heard about the close during
   * the grace period, so store.panes still has the entry, the PTY is alive, and
   * terminalRegistry still holds the xterm instance — the panel comes back with
   * full scrollback. Position is NOT preserved (re-adds at the default slot).
   */
  reopenPane(paneId: number): void {
    this._locallyClosedPanes.delete(paneId);
    if (!this._dv) return;
    if (this._panels.has(paneId)) return; // already on screen, nothing to do
    const pane = this.panes.find((p) => p.paneId === paneId);
    if (!pane) return; // pane no longer exists (e.g. process exited during grace)
    const panel = this._dv.addPanel({
      id: String(paneId),
      component: 'terminal',
      title: this._customTitles.get(paneId) ?? pane.title ?? `Pane ${paneId}`,
    });
    this._panels.set(paneId, panel);
    panel.api.setActive();
  }
```

**Step 6: Verify types again.**

Run: `cd web && npm run check:fast`
Expected: PASS.

**Step 7: Commit.**
```
git add web/src/components/mux-dock.ts && git commit -m "feat: tag pane-close with pointer type + title, add reopenPane"
```

---

## Task 3: Create the `<mux-undo-toast>` Lit component

**Files:**
- Create: `web/src/components/mux-undo-toast.ts`

This is a self-contained Lit element with its own shadow root (standard Lit — unlike `mux-dock`, it does NOT override `createRenderRoot`). It shows `"<title> closed [Undo] Ns"` with a shrinking progress bar, ticks a 1-second `setInterval` to update the number and self-destruct at zero, and dispatches `pane-close-resolved` when Undo is tapped.

**Step 1: Write the component.**

Create `web/src/components/mux-undo-toast.ts` with:

```ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * <mux-undo-toast> — a single countdown toast for a deferred pane close.
 *
 * Lifecycle:
 *   - On connect: start a 1s interval that decrements the visible seconds and
 *     removes the element when it reaches zero (expiry). Expiry dispatches NO
 *     event — mux-app's _executeClose drives the actual kill; the toast simply
 *     disconnects when re-rendered without its entry. (The self-remove here is a
 *     belt-and-suspenders fallback in case the parent has not yet re-rendered.)
 *   - On Undo click: dispatch `pane-close-resolved` (bubbles + composed) so
 *     mux-app cancels the timer and reopens the pane, then remove self.
 *
 * The progress bar animates purely via a CSS width transition (no JS per frame):
 * it starts at 100% and transitions to 0% over `duration`, kicked off in a rAF
 * after connect so the transition has a starting frame to animate from.
 */
@customElement('mux-undo-toast')
export class MuxUndoToast extends LitElement {
  static styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      min-width: 320px;
      max-width: 92vw;
      background: #24283b;
      border: 1px solid #414868;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      color: #c0caf5;
      font-size: 13px;
      overflow: hidden;
      user-select: none;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
    }

    .label {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .undo {
      /* 44px minimum touch target — easy to hit under time pressure. */
      min-height: 44px;
      min-width: 44%;
      padding: 0 18px;
      background: #7aa2f7;
      color: #1a1b26;
      border: none;
      border-radius: 6px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.12s;
    }
    .undo:hover { opacity: 0.85; }

    .seconds {
      min-width: 28px;
      text-align: right;
      color: #a9b1d6;
      font-variant-numeric: tabular-nums;
    }

    .track {
      height: 4px;
      background: #1a1b26;
    }
    .bar {
      height: 100%;
      width: 100%;
      background: #7aa2f7;
    }
  `;

  /** The pane this toast can restore. */
  @property({ type: Number }) paneId = -1;
  /** The dockview tab title at close time, e.g. "vim" or "Pane 3". */
  @property({ type: String }) title = '';
  /** Grace period in milliseconds. */
  @property({ type: Number }) duration = 10000;

  /** Remaining whole seconds shown in the numeric readout. */
  @state() private _remaining = 0;
  /** True once the rAF has fired so the CSS bar transition is armed. */
  @state() private _armed = false;

  private _interval: ReturnType<typeof setInterval> | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this._remaining = Math.ceil(this.duration / 1000);
    this._interval = setInterval(() => {
      this._remaining -= 1;
      if (this._remaining <= 0) {
        // Expiry fallback — parent re-render normally removes us first.
        this.remove();
      }
    }, 1000);
    // Arm the bar transition on the next frame so it animates from 100% to 0%.
    requestAnimationFrame(() => { this._armed = true; });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._interval !== undefined) {
      clearInterval(this._interval);
      this._interval = undefined;
    }
  }

  private _onUndo(): void {
    this.dispatchEvent(
      new CustomEvent('pane-close-resolved', {
        detail: { paneId: this.paneId },
        bubbles: true,
        composed: true,
      }),
    );
    this.remove();
  }

  override render() {
    const secs = Math.round(this.duration / 1000);
    // When armed, drive width to 0 over `duration`; before that, full width.
    const barStyle = this._armed
      ? `width:0%;transition:width ${secs}s linear;`
      : `width:100%;`;
    return html`
      <div class="row">
        <span class="label">${this.title} closed</span>
        <button class="undo" @click=${this._onUndo}>Undo</button>
        <span class="seconds">${this._remaining}s</span>
      </div>
      <div class="track"><div class="bar" style=${barStyle}></div></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-undo-toast': MuxUndoToast;
  }
}
```

**Step 2: Verify types and lint.**

Run: `cd web && npm run check:fast`
Expected: PASS.

**Step 3: Commit.**
```
git add web/src/components/mux-undo-toast.ts && git commit -m "feat: add mux-undo-toast countdown component"
```

---

## Task 4: Wire the deferred-close lifecycle into `mux-app`

**Files:**
- Modify: `web/src/app.ts`

**Step 1: Register the new component via a side-effect import.**

In `web/src/app.ts`, find the block of side-effect imports (around lines 13-17). Add this line after the `mux-dock` import:

```ts
import './components/mux-undo-toast.js';
```

**Step 2: Add the two state maps.**

Find the private field block (around line 266, near `private _socket: MuxSocket | null = null;`). Add directly above it:

```ts
  /** Active grace-period timers, keyed by paneId. Presence => a deferred close
   *  is pending and a toast is shown. */
  private _pendingCloses = new Map<number, ReturnType<typeof setTimeout>>();
  /** Per-pending metadata for rendering each toast (the tab title at close). */
  private _pendingClosesMeta = new Map<number, { title: string }>();
```

**Step 3: Add a getter for the `mux-dock` element.**

Add this private getter inside the `MuxApp` class (place it just above `_onClosePane`, around line 680):

```ts
  /** The live <mux-dock> element in our shadow root, or null when the
   *  workspace is empty (the dock is not rendered in the empty state). */
  private get _dock(): import('./components/mux-dock.js').MuxDock | null {
    return this.renderRoot.querySelector('mux-dock');
  }
```

> Add the matching named import at the top if tsgo complains about the inline `import(...)` type — but the inline form above avoids a runtime import. If lint prefers a top import, change the existing `import './components/mux-dock.js';` to also import the type:
> ```ts
> import './components/mux-dock.js';
> import type { MuxDock } from './components/mux-dock.js';
> ```
> and then use `private get _dock(): MuxDock | null`. Pick whichever the `check:fast` run accepts.

**Step 4: Branch `_onClosePane` on the `touch` flag.**

Replace the entire existing `_onClosePane` method (around lines 680-694) with:

```ts
  /**
   * Handle a pane-close event from mux-dock. Mouse closes keep the original
   * instant, permanent behavior. Touch/pen closes are deferred for 10s with an
   * undo toast (see _startDeferredClose).
   */
  private _onClosePane = (e: CustomEvent<{ paneId: number; touch: boolean; title: string }>): void => {
    if (e.detail.touch) {
      this._startDeferredClose(e.detail.paneId, e.detail.title);
      return;
    }
    this._executeClose(e.detail.paneId);
  };

  /** Begin a 10-second grace period for a touch/pen close: arm a timer, record
   *  metadata for the toast, and re-render to show the toast. No server message
   *  is sent yet — the PTY and xterm instance stay alive. */
  private _startDeferredClose(paneId: number, title: string): void {
    const handle = setTimeout(() => this._executeClose(paneId), 10_000);
    this._pendingCloses.set(paneId, handle);
    this._pendingClosesMeta.set(paneId, { title });
    this.requestUpdate();
  }

  /** Perform the actual kill: tell the server, prune the terminal, and clear any
   *  pending-close bookkeeping. Safe to call for both the instant (mouse) path
   *  and the expiry path. */
  private _executeClose(paneId: number): void {
    this._socket?.closePane(paneId);
    const remaining = new Set(
      store.panes
        .filter((p) => p.paneId >= 0 && p.paneId !== paneId)
        .map((p) => p.paneId),
    );
    terminalRegistry.prune(remaining);
    this._pendingCloses.delete(paneId);
    this._pendingClosesMeta.delete(paneId);
    this.requestUpdate();
  }

  /** Undo a pending close: cancel the timer, clear bookkeeping, and reopen the
   *  pane in the dock (PTY + scrollback intact). Dispatched by the toast. */
  private _onUndoPaneClose = (e: CustomEvent<{ paneId: number }>): void => {
    const { paneId } = e.detail;
    const handle = this._pendingCloses.get(paneId);
    if (handle !== undefined) clearTimeout(handle);
    this._pendingCloses.delete(paneId);
    this._pendingClosesMeta.delete(paneId);
    this._dock?.reopenPane(paneId);
    this.requestUpdate();
  };
```

**Step 5: Cancel pending timers on workspace change.**

Find `_onWorkspaceSelected` (around line 665). Add the cleanup right after the early-return guard, so switching workspaces leaves the previous workspace's panes alive on the server:

```ts
  private _onWorkspaceSelected = (e: CustomEvent<{ workspaceId: string }>): void => {
    this._showWorkspacePicker = false;
    if (e.detail.workspaceId === store.attached) return;
    // Cancel any in-flight grace timers: their panes survive on the server,
    // which is the correct outcome for an accidental close mid-switch.
    for (const handle of this._pendingCloses.values()) clearTimeout(handle);
    this._pendingCloses.clear();
    this._pendingClosesMeta.clear();
    this._socket?.attachWithBreakpoint(e.detail.workspaceId, currentLayoutMode());
  };
```

**Step 6: Render the toast stack.**

In `render()`, find the `<mux-status-bar ...></mux-status-bar>` block (around lines 472-477). Insert the toast stack **immediately before** the `<mux-status-bar` line:

```ts
      <div class="undo-toast-stack" @pane-close-resolved=${this._onUndoPaneClose}>
        ${[...this._pendingClosesMeta.entries()].map(
          ([paneId, meta]) => html`
            <mux-undo-toast
              .paneId=${paneId}
              .title=${meta.title}
              .duration=${10000}
            ></mux-undo-toast>
          `,
        )}
      </div>
```

**Step 7: Add the toast-stack CSS.**

In the `static styles = css\`...\`` block, add this rule (place it after the `.overlay.hidden` rule, around line 93). The status bar is `24px` tall (confirmed in `status-bar.ts`), so the stack sits just above it. `column-reverse` puts the newest toast visually on top of the stack while keeping the newest entry last in the DOM:

```css
    .undo-toast-stack {
      position: fixed;
      bottom: 32px; /* 24px status bar + 8px gap */
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column-reverse;
      gap: 8px;
      z-index: 1000;
      pointer-events: none; /* let the gaps pass clicks through */
    }
    .undo-toast-stack > * {
      pointer-events: auto; /* but the toasts themselves are interactive */
    }
```

**Step 8: Add the DEV-only test seams.**

These power the E2E script from Task 1. Find the `if (import.meta.env.DEV) { ... }` block at the very bottom of the file (around lines 747-757). Add these accessors inside it, after the existing `__muxRegistry` assignment:

```ts
  // Touch-close-undo E2E seams ---------------------------------------------
  const _app = (): MuxApp | null => document.querySelector('mux-app');

  (window as unknown as Record<string, unknown>)['__muxPendingCloses'] = (): number[] => {
    const app = _app() as unknown as { _pendingCloses?: Map<number, unknown> } | null;
    return app?._pendingCloses ? [...app._pendingCloses.keys()] : [];
  };

  (window as unknown as Record<string, unknown>)['__muxUndoClose'] = (paneId: number): void => {
    _app()?.dispatchEvent(
      new CustomEvent('pane-close-resolved', { detail: { paneId }, bubbles: true, composed: true }),
    );
  };

  (window as unknown as Record<string, unknown>)['__muxForceExpire'] = (paneId: number): void => {
    const app = _app() as unknown as { _executeClose?: (id: number) => void } | null;
    app?._executeClose?.(paneId);
  };

  (window as unknown as Record<string, unknown>)['__muxCloseButtonFor'] = (paneId: number): Element | null => {
    const dock = _app()?.shadowRoot?.querySelector('mux-dock');
    if (!dock) return null;
    // dockview gives each tab a draggable element; the close action is
    // .dv-default-tab-action. We find the tab whose panel id matches paneId by
    // walking the dockview component's panels.
    const tabs = [...dock.querySelectorAll('.dv-tab')];
    for (const tab of tabs) {
      const content = tab.querySelector('.dv-default-tab-content');
      // The panel id is not on the DOM directly; match by the dock's internal map.
      // Simplest robust route: the tab's title text equals the panel title, and
      // the dev seam falls back to index order. Use the dock's panel lookup:
      void content;
    }
    // Fallback: dockview renders tabs in panel order; map by the dock's panel ids.
    const dockAny = dock as unknown as { _panels?: Map<number, { title?: string }> };
    const ids = dockAny._panels ? [...dockAny._panels.keys()] : [];
    const idx = ids.indexOf(paneId);
    if (idx < 0) return null;
    const tab = tabs[idx];
    return tab?.querySelector('.dv-default-tab-action') ?? null;
  };
```

> The `__muxUndoClose` seam dispatches the same `pane-close-resolved` event the real toast button dispatches, so it exercises the production undo path (the `@pane-close-resolved` listener on the toast stack) — not a bypass. `__muxForceExpire` calls `_executeClose` directly, simulating the timer firing without a 10s wait. `__muxCloseButtonFor` locates the real dockview close X so the test drives the genuine close flow.

**Step 9: Verify types and lint.**

Run: `cd web && npm run check:fast`
Expected: PASS. If tsgo flags the private-field access in the seams (`_pendingCloses`, `_executeClose`, `_panels`), that is expected — the casts to `unknown` then a shape type avoid it; adjust the cast shape until it passes. Do NOT loosen the production code's `private` modifiers.

**Step 10: Full build (commit gate).**

Run: `cd web && npm run build`
Expected: build succeeds with no type errors.

**Step 11: Commit.**
```
git add web/src/app.ts && git commit -m "feat: deferred touch-close with undo toast lifecycle in mux-app"
```

---

## Task 5: Run the E2E script and verify (GREEN)

**Files:** none (verification only)

**Step 1: Start the muxterm dev server.**

The E2E script needs a running server with the DEV build (so `import.meta.env.DEV` seams exist). In one terminal:
```
cd web && npm run dev
```
Note the URL it prints (Vite typically serves on `http://localhost:5173`, but muxterm scripts default to `9090`/`8080`). Use the actual printed URL with `--url` below. The backend daemon must also be running so panes can spawn — start it the same way you normally run muxterm locally (check `README.md`/`Makefile`: `make dev` runs the full stack).

> If you cannot determine how to bring up the full stack, run `make dev` from the repo root and watch the output for the served URL.

**Step 2: Run the E2E script (GREEN).**

```
node web/e2e/touch-close-undo.mjs --url http://localhost:<actual-port>
```
Expected output ends with:
```
ALL CHECKS PASSED
```
and the process exits 0.

**Step 3: If any check fails, debug.**

- `close button not found for pane N` → the `__muxCloseButtonFor` tab-index mapping is off. Inspect with: `playwright-cli eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-dock').querySelectorAll('.dv-tab').length"`. Adjust the mapping in the seam (Task 4, Step 8) to match how dockview orders tabs vs. `_panels` keys.
- `xterm buffer intact` fails → confirm `reopenPane` does not destroy/recreate the terminal; it must only re-add the dockview panel (Task 2, Step 5). The terminal lives in `terminalRegistry`, untouched.
- `pane absent after expiry` fails → confirm `_executeClose` actually calls `this._socket?.closePane(paneId)` and that the server broadcast removes it from `store.panes` (allow the `sleep(800)` to cover the round-trip; increase if flaky).
- Do not paper over a real failure by weakening the assertion. Fix the code.

**Step 4: Run the blessed full-journey verification.**

Run the project's end-to-end smoke check to confirm nothing regressed in the normal pane/close/refresh flows:
```
/muxterm-verify
```
Expected: the 9-check table returns a final **PASS** verdict. (This catches garbled-terminal and persistence regressions that the targeted script does not.)

**Step 5: Report results.**

Summarize: the three scenario checks (pass/fail) and the `/muxterm-verify` verdict. If everything is green, the feature is complete. No commit needed for this task (verification only); if you made fixes in Steps 3, commit them with a `fix:` message before finishing.

---

## Done criteria

- [ ] `mux-dock` tags `pane-close` with `{ touch, title }` and exposes `reopenPane()`.
- [ ] `<mux-undo-toast>` exists, counts down, animates its bar, and dispatches `pane-close-resolved`.
- [ ] `mux-app` defers touch closes 10s, renders stacked toasts, undoes via `reopenPane`, executes on expiry, and cancels timers on workspace switch.
- [ ] Mouse closes remain instant and permanent (unchanged behavior).
- [ ] `npm run check:fast` and `npm run build` both pass.
- [ ] `web/e2e/touch-close-undo.mjs` prints `ALL CHECKS PASSED`.
- [ ] `/muxterm-verify` returns PASS.
- [ ] Each task committed with a conventional-commit message.
```

