# Multi-Client Resize / Focus-Authority — Phase 2 (Client-Side TypeScript + Real-Execution Verification) Implementation Plan

> **For execution:** Use `/build-like-ken` mode.

**Goal:** Wire the browser client to the server-side focus-authority protocol Phase 1 already built — send `pane-focus` when a pane becomes this client's visible+OS-focused view (dockview active-tab change, `visibilitychange`/`window.onfocus`, and on every initial attach/reconnect), handle `pane-resized` broadcasts by letterboxing/scrolling non-authoritative panes without re-triggering a conflicting resize — then prove the **whole feature (Phase 1 + Phase 2 combined)** works end-to-end against a real browser and a real sessiond process, per this repo's no-unit-tests testing policy.

**Architecture:** `web/src/ws.ts` gains a `paneFocus(paneId, cols, rows)` sender (mirrors the existing `resize()` method exactly) and an `onPaneResized` callback property (a direct callback, matching the existing `onDisconnect`/`onReconnect`/`onSessiondMessage` pattern already on `MuxSocket` — not the window-`CustomEvent` relay pattern used for `browser-action`/`layout-command`, since the only consumer, `terminalRegistry`, is already a plain module imported directly by `app.ts`). `web/src/lib/terminal-registry.ts` gains a per-pane `isAuthoritative` flag (default `true`, the solo-client case), an `applyingServerResize` reentrancy guard consumed by the existing `term.onResize` handler, an `applyServerResize()` method that applies a broadcast size via `term.resize()` without reporting back, a `fitIfVisible()` gate that skips fitting while non-authoritative (the letterbox/scroll behavior — accomplished by adding `overflow:auto` to the terminal's host element and simply *not calling* `fitAddon.fit()`, no scaling), and a new `PaneHandlers.onSettled` hook fired once per attach/reconnect when a pane first becomes ready. A new small sibling module, `web/src/lib/pane-focus-coordinator.ts`, owns the DOM-level `visibilitychange`/`window.onfocus` listeners and turns them, plus a single-pane claim call, into `pane-focus` sends — kept separate from `WorkspaceController` because that class is explicitly a thin, test-mockable seam with no DOM state of its own. `web/src/app.ts` wires the coordinator into the socket/registry/dockview-provided hooks it already owns; **no changes to `web/src/components/mux-dock.ts` are needed** — it already dispatches a bubbling `pane-select` `CustomEvent` on `onDidActivePanelChange` that `app.ts`'s existing `_onActivePane` handler receives, so that becomes the active-tab-change trigger point for free.

**Tech Stack:** TypeScript (`web/src/*.ts`), xterm.js 6 (`@xterm/xterm`, `@xterm/addon-fit`), Lit, dockview-core. Verification via `make dev-local` (127.0.0.1:8313) and `playwright-cli`.

**Verification approach:** Static analysis first (`npm run check:fast`, `go build ./...`), then six required real-execution scenarios (multiple sizes, multi-client focus-switching, reconnect correctness, DECSC/DECRC round-trip, main-screen preservation round-trip across an alt-screen reconnect, MCP-agent exclusion), each driven by real `playwright-cli` browser sessions and real shell commands against the isolated `make dev-local` instance on `127.0.0.1:8313`. **Port 8311 and its sessiond/socket/log files are production and must never be touched, read, or written by anything in this plan.**

---

## ⚠️ Prerequisite gap found during planning — read this first

This plan assumes `make dev-local` (an isolated second muxterm instance on port 8313, per `docs/designs/2026-07-30-rapid-local-dev-workflow-design.md`) is available in this worktree, because the task that requested this plan referenced it as already present. **It is not, on this branch.** Verified by inspection:

- `git show HEAD:Makefile` on this branch (`fix/multi-client-resize-restore`, currently at commit `b319f48`) has no `dev-local` target — only `dev`, `demo`, `demo-install`, `install-stable`, `web`, `test`, `test-web`, `clean`.
- `docs/designs/2026-07-30-rapid-local-dev-workflow-design.md` and `docs/plans/2026-07-30-rapid-local-dev-workflow-implementation.md` do not exist on this branch's working tree.
- Both the Makefile target, `.air.local.toml`, and both docs **do** exist on `origin/main`, added by commit `6295b66` ("chore: add make dev-local for isolated rapid local dev workflow (#7)"). That commit is **not** an ancestor of this branch (`git merge-base --is-ancestor 6295b66 HEAD` → `NO`), and this branch is not an ancestor of `origin/main` either — the two lines diverged after a shared base at `f73fd44`.
- A dry-run (`git cherry-pick -n 6295b66`) applied **cleanly with zero conflicts** against this branch's current `Makefile`, then was reset back out (`git reset --hard HEAD`) — confirmed safe to bring in before Task 0 below is executed for real.

Task 0 below brings this infrastructure onto this branch via that same clean cherry-pick, as a real, committed prerequisite step — not a fabricated assumption. Every later task's `make dev-local`/port-8313 references depend on Task 0 having been done first.

---

## Before You Start

Read these once, in full, before touching anything:

- `web/src/ws.ts` — `MuxSocket` class: `sendSessiond()`, `resize()`, and the `onmessage` handler's text-frame routing (the `browser-action`/`layout-command` `CustomEvent` dispatch block).
- `web/src/lib/terminal-registry.ts` — `PaneEntry`, `PaneHandlers`, `ensure()`, `attach()`, `fitIfVisible()`, `_settleAndDrain()`, `_fitIfPlausible()`, `_isVisible()`. It's ~940 lines; the sections you'll touch are called out with exact line numbers below, but read the whole file once for the mental model (this is the file the design doc calls out as already having the idempotency/lifecycle patterns Phase 2 must mirror).
- `web/src/app.ts` — `connectedCallback()`/`disconnectedCallback()` (the `window.addEventListener('resize', ...)` pattern you'll mirror for the new listeners), the `onSessiondMessage` handler's `Composition` branch (where `terminalRegistry.ensure()` is called), `_syncTerminals()` (the other `ensure()` call site), and `_onActivePane()`.
- `web/src/components/mux-dock.ts` lines 590–662 — `onDidActivePanelChange`, specifically the existing `this.dispatchEvent(new CustomEvent('pane-select', ...))` call. **You will not modify this file in Phase 2** — this read is to confirm the hook you need already exists.
- `web/src/types.ts` — the `SessiondType` frozen vocabulary object.
- `internal/mcp/tools_terminal.go` and `internal/mcp/run.go` (already read during Phase 1/planning) — confirms the MCP tool name is `send_input`, registered with `pane_id`/`text` arguments, used by Task 10's verification.
- `docs/designs/2026-07-31-multi-client-resize-focus-authority-design.md` — the full design (Phase 1 already implements the server half; this plan implements the "Client-Side Changes" section).
- `docs/plans/2026-07-31-multi-client-resize-focus-authority-phase1-implementation.md` — Phase 1's plan. This plan builds on its exact protocol surface: `pane-focus`/`pane-resized` message shapes (both reuse the existing `paneId`/`cols`/`rows` `Message` fields — no new wire fields), `sessiond.Client.PaneFocus(paneID uint32, cols, rows int) error`, `sessiond.Handlers.OnPaneResized func(paneID uint32, cols, rows int)`, and `Client.Attach`'s new third `clientKind` parameter. Do not re-derive any of this — Phase 1 already built and committed it.

None of this code gets unit tests. Verification is real browser execution only (see the six scenario tasks below).

---

### Task 0: Bring `make dev-local` onto this branch (prerequisite)

**Files:**
- Create (via cherry-pick): `.air.local.toml`
- Modify (via cherry-pick): `Makefile`
- Create (via cherry-pick): `docs/designs/2026-07-30-rapid-local-dev-workflow-design.md`
- Create (via cherry-pick): `docs/plans/2026-07-30-rapid-local-dev-workflow-implementation.md`

**Implementation**

```bash
cd /Users/ken/workspace/muxterm/.worktrees/fix-multi-client-resize-restore
git fetch origin
git cherry-pick 6295b66cdb120c6c4a38203a0e3b06882a84fcb6
```

This is a real commit from `origin/main` that adds exactly these four files (40 + 31 + 166 + 509 lines, confirmed via `git show 6295b66 --stat` during planning) and touches nothing else — no conflicts with any Phase 1 or Phase 2 file. If `git fetch` shows the hash has changed (force-push/rebase upstream), re-resolve the commit via `git log origin/main -- Makefile | grep -B5 dev-local` and use the correct hash instead.

**Static Analysis**
```bash
python3 -c "import tomllib; tomllib.load(open('.air.local.toml','rb')); print('valid toml')"
```
Expected: `valid toml`

```bash
grep -c "dev-local:" Makefile
```
Expected: `1`

**Verification**
```bash
grep -q "\.PHONY.*dev-local" Makefile && echo "PHONY OK" || echo "PHONY MISSING"
```
Expected: `PHONY OK`

**Commit**

The cherry-pick already creates its own commit (it carries the original commit's message forward). No additional commit step — just confirm it landed:
```bash
git log -1 --oneline
```
Expected: last line shows `chore: add make dev-local for isolated rapid local dev workflow (#7)` (or the cherry-picked equivalent).

---

### Task 1: `web/src/ws.ts` — `paneFocus()` sender + `onPaneResized` callback

**Files:**
- Modify: `web/src/ws.ts`

**Implementation**

Add the new callback property right after the existing `onSessiondMessage` property (currently line 23):

```typescript
  onDisconnect: (() => void) | null = null;
  onReconnect: (() => void) | null = null;
  onSessiondMessage: ((msg: SessiondMessage) => void) | null = null;
  /**
   * Fires when the daemon broadcasts pane-resized: the canonical PTY size for
   * paneId changed because some other client became (or already was)
   * authoritative for it. A direct callback property, like onDisconnect/
   * onReconnect above — not the window CustomEvent relay pattern used below
   * for browser-action/layout-command, since the only consumer
   * (terminalRegistry) is a plain module app.ts already imports directly; no
   * need for a window-event round-trip.
   */
  onPaneResized: ((paneId: number, cols: number, rows: number) => void) | null = null;
```

Add `paneFocus()` right after the existing `resize()` method (currently lines 147–154):

```typescript
  /**
   * Report a pane's measured rendered grid (active-view-wins by construction:
   * only visible panes own a live ResizeObserver, so tabbed-away panes never
   * call resize).
   */
  resize(paneId: number, cols: number, rows: number): void {
    this.sendSessiond({ type: SessiondType.Resize, paneId, cols, rows });
  }

  /**
   * Claim PTY-sizing authority for a pane: sent when it becomes this client's
   * visible+OS-focused view (dockview active-tab change, visibilitychange,
   * window focus, or initial attach/reconnect). Carries this client's current
   * measured size so the daemon can resize the PTY in the same round-trip
   * rather than waiting for a separate resize message afterward. Mirrors
   * resize()'s shape exactly — same three fields, different type.
   */
  paneFocus(paneId: number, cols: number, rows: number): void {
    this.sendSessiond({ type: SessiondType.PaneFocus, paneId, cols, rows });
  }
```

Add the dispatch branch in the `onmessage` handler's existing relay-type `if`/`else if` chain (currently lines 211–215):

```typescript
          if (raw.type === SessiondType.BrowserAction) {
            window.dispatchEvent(new CustomEvent('browser-action', { detail: raw }));
          } else if (raw.type === SessiondType.LayoutCommand) {
            window.dispatchEvent(new CustomEvent('layout-command', { detail: raw }));
          } else if (raw.type === SessiondType.PaneResized) {
            this.onPaneResized?.(raw.paneId as number, raw.cols as number, raw.rows as number);
          }
```

Now add the two new message-type constants to `web/src/types.ts`'s `SessiondType` object. Add `PaneFocus` next to the existing `Resize` (currently line 33):

```typescript
  Resize: 'resize',
  PaneFocus: 'pane-focus',
```

Add `PaneResized` next to the existing `PaneRenamed` (currently line 48):

```typescript
  PaneRenamed: 'pane-renamed',
  PaneResized: 'pane-resized',
```

These string values (`'pane-focus'`, `'pane-resized'`) must match Go's `TypePaneFocus`/`TypePaneResized` constants byte-for-byte — confirmed against `internal/sessiond/protocol.go` as built in Phase 1 Task 1.

**Static Analysis**
```bash
cd web && npx tsgo --noEmit 2>&1 | grep -i "ws.ts\|types.ts" || echo "no ws.ts/types.ts errors"
```
Expected: `no ws.ts/types.ts errors`

**Verification**
```bash
cd web && node -e "
const { SessiondType } = require('./src/types.ts');
" 2>&1 | head -1 || true
grep -n "PaneFocus:\|PaneResized:" src/types.ts
```
Expected output includes both:
```
    PaneFocus: 'pane-focus',
    PaneResized: 'pane-resized',
```

**Commit**
```bash
git add web/src/ws.ts web/src/types.ts
git commit -m "feat(web): add ws.paneFocus() sender and onPaneResized callback"
```

---

### Task 2: `web/src/lib/terminal-registry.ts` — authority state, reentrancy guard, letterbox rendering

**Files:**
- Modify: `web/src/lib/terminal-registry.ts`

**Implementation**

**2a. `PaneHandlers` gains `onSettled`.** Modify the interface (currently lines 104–109):

```typescript
export interface PaneHandlers {
  /** Called when the user types / pastes / SGR mouse events arrive. */
  onInput: (data: Uint8Array) => void;
  /** Called (idempotently) when the terminal cols/rows change. */
  onResize: (cols: number, rows: number) => void;
  /**
   * Called once, the first time this pane transitions from not-ready to
   * ready (visible + replay-drained + correctly sized) — on initial attach
   * AND again on every reconnect (resetForReattach() clears ready so this
   * fires again each time). Used to send this client's initial pane-focus
   * claim without depending on ResizeObserver/fit timing.
   */
  onSettled?: () => void;
}
```

**2b. `PaneEntry` gains two fields.** Modify the interface (currently lines 111–167), adding after the existing `lastCols`/`lastRows` fields:

```typescript
  /** Last dimensions reported to the server — gate for idempotent resize. */
  lastCols: number;
  lastRows: number;
  /**
   * True while this client is the pane's PTY-sizing authority (see the
   * multi-client resize/focus-authority design). Starts true — a pane this
   * client has never been told otherwise about is the solo-client default.
   * Flipped false the moment a pane-resized broadcast arrives for it (some
   * other client is now authoritative); flipped back true (optimistically)
   * when this client sends its own pane-focus claim (see markAuthoritative).
   */
  isAuthoritative: boolean;
  /**
   * True for the duration of an applyServerResize() call. Consumed by the
   * term.onResize handler below to suppress reporting the server-applied
   * size back to the server as if it were a local resize — otherwise every
   * pane-resized broadcast would immediately provoke this (non-authoritative)
   * client's own conflicting resize message right back at the daemon.
   */
  applyingServerResize: boolean;
```

Update the entry construction inside `ensure()` (currently lines 311–330) to set the new fields' defaults:

```typescript
    const entry: PaneEntry = {
      term,
      fitAddon,
      webFontsAddon,
      hostEl,
      handlers,
      lastCols: -1,
      lastRows: -1,
      isAuthoritative: true,
      applyingServerResize: false,
      opened: false,
      ready: false,
      draining: false,
      generation: 0,
      expectedReplayBytes: 0,
      pendingData: [],
      resizeObserver: null,
      resizeTimer: undefined,
      seqBytes: 0,
      _directWriteLog: 0,
      _settleWaitStart: 0,
    };
```

**2c. Letterbox rendering: `overflow:auto` on the host element.** Modify the `hostEl.style.cssText` assignment inside `ensure()` (currently line 301):

```typescript
    // touch-action:none tells the browser we handle all touch gestures ourselves,
    // preventing it from firing default pan/zoom behaviors that would fight our
    // manual touch-scroll handler below. overflow:auto lets a non-authoritative
    // pane (letterbox/scroll mode — see applyServerResize below) show native
    // scrollbars when the container is smaller than the canonical cols×rows
    // grid, or sit anchored top-left with empty space when larger. This is a
    // no-op visually for the normal (authoritative) case, where the terminal's
    // natural size always matches the container exactly.
    hostEl.style.cssText = 'width:100%;height:100%;touch-action:none;overflow:auto;';
```

**2d. Reentrancy guard in the existing `term.onResize` handler.** Modify (currently lines 372–378):

```typescript
    // Resize: idempotent — only fires handler when dimensions actually change.
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (cols === entry.lastCols && rows === entry.lastRows) return;
      entry.lastCols = cols;
      entry.lastRows = rows;
      // Reentrancy guard: applyServerResize() below calls term.resize()
      // directly, which fires this SAME onResize event. Suppress the report
      // back to the server in that one case.
      if (entry.applyingServerResize) return;
      entry.handlers.onResize(cols, rows);
    });
```

**2e. `onSettled` fired at both `ready = true` transitions in `_settleAndDrain`.** First transition, the "no pending data" branch (currently around line 690):

```typescript
    if (pending.length === 0) {
      muxLog('registry ready', `pane=${paneId} READY (no pending — fresh or pre-buffered)`,
        { seqBytes: entry.seqBytes });
      entry.ready = true;
      entry.handlers.onSettled?.();
      return;
    }
```

Second transition, inside `onWriteDone` (currently around line 706):

```typescript
    const onWriteDone = () => {
      // Stale callback — pane was closed or reset while writes were in-flight.
      if (entry.generation !== myGeneration) return;
      if (--remaining !== 0) return;
      muxLog('registry ready', `pane=${paneId} READY (after drain)`,
        { seqBytes: entry.seqBytes });
      entry.ready = true;
      entry.draining = false;
      entry.handlers.onSettled?.();
      // Drain any live PTY data that arrived during the drain window.
      const live = entry.pendingData.splice(0);
      if (live.length > 0) {
        muxLog('registry settle', `pane=${paneId} draining live data after replay`,
          { chunks: live.length });
      }
      for (const chunk of live) entry.term.write(chunk);
    };
```

**2f. Gate `fitIfVisible()` on authority.** Modify (currently lines 725–730):

```typescript
  /**
   * Fit the terminal to its container — only when the host element is
   * visible AND this client is currently authoritative for the pane's PTY
   * size. Letterbox/scroll mode (non-authoritative): never fit-to-container
   * — that would fight the canonical size just applied by applyServerResize.
   * No-op if the terminal has never been opened or is not in the DOM.
   */
  fitIfVisible(paneId: number): void {
    const entry = _map.get(_key(paneId));
    if (!entry || !entry.opened) return;
    if (!entry.isAuthoritative) return;
    if (!_isVisible(entry.hostEl)) return;
    _fitIfPlausible(entry);
  },
```

**2g. New methods.** Insert these immediately after `fitIfVisible` (2f above) and before the existing `focus()` method:

```typescript
  /**
   * Apply a server-broadcast canonical size (TypePaneResized) to a
   * non-authoritative pane's xterm.js instance. Calls term.resize() directly
   * (never fitAddon.fit()) to preserve the exact cols/rows the server decided
   * on — the whole point of letterbox/scroll mode is that this client's
   * container size does NOT drive the PTY size while another client is
   * authoritative. The applyingServerResize guard (consumed by the
   * term.onResize handler above) prevents this call from immediately
   * reporting a conflicting resize back to the server.
   */
  applyServerResize(paneId: number, cols: number, rows: number): void {
    const entry = _map.get(_key(paneId));
    if (!entry || !entry.opened) return;
    entry.isAuthoritative = false;
    entry.applyingServerResize = true;
    entry.term.resize(cols, rows);
    entry.applyingServerResize = false;
  },

  /**
   * Mark this client as (optimistically) authoritative for paneId. Called
   * immediately after sending a pane-focus claim — pane-focus is
   * fire-and-forget (the daemon sends no reply), so there is no explicit ack
   * to await. If another client actually won the race server-side, a
   * pane-resized broadcast will arrive shortly after and flip this back to
   * false via applyServerResize.
   */
  markAuthoritative(paneId: number): void {
    const entry = _map.get(_key(paneId));
    if (entry) entry.isAuthoritative = true;
  },

  /**
   * Whether this client currently believes it is the PTY-sizing authority
   * for paneId. Defaults to true (solo-client case) for any pane not yet
   * known to the registry.
   */
  isAuthoritative(paneId: number): boolean {
    return _map.get(_key(paneId))?.isAuthoritative ?? true;
  },

  /**
   * Return the paneIds (within the current workspace) whose host element is
   * currently visible in the DOM — the active tab of its dockview group, or
   * any pane visible in a side-by-side split. Used by the pane-focus
   * coordinator to decide which panes to claim on visibilitychange/window
   * focus (which don't identify a single pane the way onDidActivePanelChange
   * does).
   */
  visiblePaneIds(): number[] {
    const prefix = `${_currentWorkspaceId}:`;
    const ids: number[] = [];
    for (const [key, entry] of _map.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (entry.opened && _isVisible(entry.hostEl)) {
        ids.push(parseInt(key.slice(prefix.length), 10));
      }
    }
    return ids;
  },

  /**
   * Re-fit paneId to its container (idempotent — the term.onResize handler's
   * own lastCols/lastRows gate suppresses a duplicate report if nothing
   * changed) and return the resulting measured size. Used by the pane-focus
   * coordinator to get an accurate cols/rows to send with pane-focus. Returns
   * null if the pane isn't opened or isn't currently visible.
   */
  measureForFocus(paneId: number): { cols: number; rows: number } | null {
    const entry = _map.get(_key(paneId));
    if (!entry || !entry.opened || !_isVisible(entry.hostEl)) return null;
    _fitIfPlausible(entry);
    return { cols: entry.term.cols, rows: entry.term.rows };
  },
```

**2h. Expose `isAuthoritative` on the existing debug global** for verification use. Modify the bottom of the file (currently lines 934–939):

```typescript
if (typeof window !== 'undefined') {
  (window as unknown as { __muxterm?: Record<string, unknown> }).__muxterm = {
    ...(window as unknown as { __muxterm?: Record<string, unknown> }).__muxterm,
    snapshot: (paneId: number) => terminalRegistry.snapshot(paneId),
    isAuthoritative: (paneId: number) => terminalRegistry.isAuthoritative(paneId),
  };
}
```

**Static Analysis**
```bash
cd web && npm run check:fast
```
Expected: `0 errors` (oxlint + tsgo). Note: this task alone will likely show unused-export/type warnings for `PaneFocusCoordinator`-adjacent code until Task 3/4 land — if `check:fast` fails ONLY on `pane-focus-coordinator.ts` references, that's expected until Task 3 creates that file; otherwise fix any real error in `terminal-registry.ts` before proceeding.

**Verification**
```bash
cd web && npx tsgo --noEmit 2>&1 | grep -i "terminal-registry.ts" || echo "no terminal-registry.ts errors"
```
Expected: `no terminal-registry.ts errors`

**Commit**
```bash
git add web/src/lib/terminal-registry.ts
git commit -m "feat(web): pane authority state, reentrancy guard, letterbox/scroll rendering in terminal-registry"
```

---

### Task 3: `web/src/lib/pane-focus-coordinator.ts` — new sibling module

**Files:**
- Create: `web/src/lib/pane-focus-coordinator.ts`

**Implementation**

This is a new small module, not an addition to `workspace-controller.ts`. `WorkspaceController`'s own file header explicitly scopes it as "a thin coordination seam" that "owns NO wire state of its own beyond client-local bookkeeping" and is driven externally by callers (its `WorkspaceSocket` interface is deliberately narrow for testability). Adding real `document`/`window` event subscriptions to it would break that scoping, so this lives as its own file, following the same "small focused module in `web/src/lib/`" convention already used by `workspace-mru.ts`, `workspace-recovery.ts`, `breakpoint.ts`, etc.

```typescript
// Pane-focus coordinator — client-side half of the multi-client resize/
// focus-authority design
// (docs/designs/2026-07-31-multi-client-resize-focus-authority-design.md).
//
// Claims PTY-sizing authority for panes by sending pane-focus whenever this
// client's view of a pane becomes the one that should drive its size:
//   - the pane becomes the active tab in this client's dockview layout (see
//     app.ts's _onActivePane, which already receives mux-dock's existing
//     bubbling 'pane-select' CustomEvent — dockview's onDidActivePanelChange
//     dispatches it today, unmodified by this change)
//   - this browser tab/window regains OS focus or visibility
//     (visibilitychange + window 'focus' — installWindowListeners below)
//   - a pane settles (first becomes ready) on initial attach or reconnect
//     (terminal-registry's PaneHandlers.onSettled hook, wired per-pane in
//     app.ts)
//
// Deliberately NOT part of WorkspaceController: that class is a thin,
// test-mockable seam with no DOM/wire state of its own beyond client-local
// bookkeeping (see its file header) and is driven externally by callers
// rather than owning window/document listeners itself. This coordinator owns
// real DOM event subscriptions, so it lives as its own small module instead.

import { terminalRegistry } from './terminal-registry.js';

/** Test-mockable subset of MuxSocket the coordinator drives. */
export interface PaneFocusSocket {
  paneFocus(paneId: number, cols: number, rows: number): void;
}

export class PaneFocusCoordinator {
  constructor(private socket: PaneFocusSocket) {}

  /** Claim a single pane — e.g. the one dockview just made active. No-ops if
   *  the pane isn't currently visible (measureForFocus returns null). */
  claimPane(paneId: number): void {
    const size = terminalRegistry.measureForFocus(paneId);
    if (!size) return;
    this.socket.paneFocus(paneId, size.cols, size.rows);
    terminalRegistry.markAuthoritative(paneId);
  }

  /** Claim every pane currently visible in this client's layout — used for
   *  visibilitychange/window-focus, which don't identify a single pane the
   *  way an active-tab change does. */
  claimVisiblePanes(): void {
    for (const paneId of terminalRegistry.visiblePaneIds()) {
      this.claimPane(paneId);
    }
  }

  /**
   * Install visibilitychange + window 'focus' listeners. Both signal "this
   * browser tab/window regained OS focus", per the design's combined
   * visibility+OS-focus authority signal. Returns a disposer for symmetric
   * cleanup, mirroring installKeybindings()'s pattern already used in
   * app.ts.
   */
  installWindowListeners(): () => void {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        this.claimVisiblePanes();
      }
    };
    const onWindowFocus = (): void => {
      this.claimVisiblePanes();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onWindowFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onWindowFocus);
    };
  }
}
```

**Static Analysis**
```bash
cd web && npx tsgo --noEmit 2>&1 | grep -i "pane-focus-coordinator.ts" || echo "no pane-focus-coordinator.ts errors"
cd web && npx oxlint src/lib/pane-focus-coordinator.ts
```
Expected: both show no errors.

**Verification**
```bash
cd web && node --experimental-strip-types -e "
import { PaneFocusCoordinator } from './src/lib/pane-focus-coordinator.ts';
const sent = [];
const c = new PaneFocusCoordinator({ paneFocus: (id, cols, rows) => sent.push([id, cols, rows]) });
console.log(typeof c.claimPane, typeof c.claimVisiblePanes, typeof c.installWindowListeners);
"
```
Expected: `function function function`

**Commit**
```bash
git add web/src/lib/pane-focus-coordinator.ts
git commit -m "feat(web): add PaneFocusCoordinator (visibilitychange/window-focus/active-tab pane-focus claims)"
```

---

### Task 4: `web/src/app.ts` — wire the coordinator into the real app

**Files:**
- Modify: `web/src/app.ts`

**Implementation**

**4a. Import.** Add near the other `./lib/*` imports (currently around line 31):

```typescript
import { WorkspaceController } from './lib/workspace-controller.js';
import { PaneFocusCoordinator } from './lib/pane-focus-coordinator.js';
```

**4b. New private fields.** Add next to the existing `_controller` field (currently line 427):

```typescript
  private _socket: MuxSocket | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _controller: WorkspaceController | null = null;
  private _paneFocusCoordinator: PaneFocusCoordinator | null = null;
  private _disposePaneFocusListeners: (() => void) | null = null;
```

**4c. Instantiate + wire in `connectedCallback()`.** Modify right after the existing `this._controller = new WorkspaceController(store, this._socket);` line (currently line 481):

```typescript
    this._controller = new WorkspaceController(store, this._socket);
    this._paneFocusCoordinator = new PaneFocusCoordinator(this._socket);
    // Non-authoritative clients: apply the daemon's canonical size directly,
    // without re-fitting to this client's own container (letterbox/scroll —
    // see terminal-registry.ts's applyServerResize).
    this._socket.onPaneResized = (paneId, cols, rows) => {
      terminalRegistry.applyServerResize(paneId, cols, rows);
    };
    // visibilitychange + window 'focus': this browser tab/window regaining
    // OS focus re-claims every currently-visible pane. Mirrors the existing
    // window.addEventListener('resize', ...) registration/cleanup pattern
    // just below.
    this._disposePaneFocusListeners = this._paneFocusCoordinator.installWindowListeners();
```

**4d. Add cleanup in `disconnectedCallback()`.** Modify (currently lines 583–605), adding right after the existing `window.removeEventListener('resize', this._onViewportResize);` line:

```typescript
  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('open-launcher', this._onOpenLauncherAttr);
    window.removeEventListener('layout-command', this._onLayoutCommand);
    window.removeEventListener('resize', this._onViewportResize);
    this._disposePaneFocusListeners?.();
    this._disposePaneFocusListeners = null;
    this._paneFocusCoordinator = null;
    disposeAppShortcuts?.();
    ...
```
(leave the rest of the method body exactly as-is below this point)

**4e. Claim on initial attach/reconnect — via the new `onSettled` hook.** Both existing `terminalRegistry.ensure()` call sites need `onSettled` added. First, inside the `onSessiondMessage` handler's `Composition` branch (currently lines 523–526):

```typescript
          terminalRegistry.ensure(paneId, {
            onInput: (data) => this._socket?.sendPaneInput(paneId, data),
            onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
            onSettled: () => this._paneFocusCoordinator?.claimPane(paneId),
          });
```

Second, inside `_syncTerminals()` (currently lines 648–652):

```typescript
      terminalRegistry.ensure(paneId, {
        onInput: (data) => this._socket?.sendPaneInput(paneId, data),
        // Active-view-wins: only rendered/visible panes own a live
        // ResizeObserver, so tabbed-away panes never report a resize.
        onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
        onSettled: () => this._paneFocusCoordinator?.claimPane(paneId),
      });
```

**4f. Claim on active-tab change — extend the existing `_onActivePane` handler.** Modify (currently lines 824–828):

```typescript
  /** Client-local active-pane selection (sessiond has no select-pane message). */
  private _onActivePane = (e: CustomEvent<{ paneId: number }>): void => {
    // ackPane is the component's responsibility (mux-pane-picker._selectPane or
    // mux-dock onDidActivePanelChange). Do not ack here — the component already did.
    store.setActivePane(e.detail.paneId);
    // This pane just became the visible tab in THIS client's layout — claim
    // PTY-sizing authority for it (multi-client resize/focus-authority).
    this._paneFocusCoordinator?.claimPane(e.detail.paneId);
  };
```

No changes to `web/src/components/mux-dock.ts` are needed — `onDidActivePanelChange` (mux-dock.ts:632–662) already dispatches the `pane-select` `CustomEvent` that both `@pane-select="${this._onActivePane}"` bindings in `app.ts` (lines 674, 706) already listen for.

**Static Analysis**
```bash
cd web && npm run check:fast
```
Expected: `0 errors`

```bash
go build ./...
```
Expected: `(no output)`, exit code 0 — confirms Phase 1's Go changes still compile clean alongside anything this task touches (this task touches no Go files, so this is a regression check, not a new-error check).

**Verification**
```bash
cd web && npx tsgo --noEmit 2>&1 | grep -i "app.ts" || echo "no app.ts errors"
```
Expected: `no app.ts errors`

**Commit**
```bash
git add web/src/app.ts
git commit -m "feat(web): wire PaneFocusCoordinator into app.ts (visibility/focus/active-tab/settle)"
```

---

### Task 5: Full static analysis gate (both languages)

**Files:** none (verification-only task).

**Implementation:** none.

**Static Analysis**
```bash
cd /Users/ken/workspace/muxterm/.worktrees/fix-multi-client-resize-restore
cd web && npm run check:fast
```
Expected: `0 errors` (oxlint + tsgo, per this repo's `AGENTS.md` required fast checks).

```bash
cd /Users/ken/workspace/muxterm/.worktrees/fix-multi-client-resize-restore
go build ./...
```
Expected: `(no output)`, exit code 0 — the whole repo (Phase 1's Go changes + Phase 2's untouched Go surface) compiles clean.

**Verification**
```bash
cd web && npm run build
```
Expected: build succeeds, `web/dist/` is populated (this is also what `make dev-local`'s `vite build --watch` runs continuously, but a one-shot build here confirms there's no bundler-level error before moving to live verification).

**Commit**
```bash
git add -A
git commit -m "chore: Phase 2 client-side wiring complete, static analysis clean" --allow-empty
```

---

## Real-execution verification (6 required scenarios)

Per this repo's `AGENTS.md` testing policy: **no unit tests.** Every scenario below must be driven with real `playwright-cli` tool calls against the real `make dev-local` instance (`127.0.0.1:8313`) started in Task 0. **Never run any command against port 8311 or read/write `$TMPDIR/muxterm-501/`** (or whatever the currently-running production sessiond's actual socket dir is — re-check with `lsof -i :8311` if unsure) — that is the real production companion app, completely separate from this worktree's dev-local instance.

Before starting Task 6, start the dev-local stack in the background and confirm it's up:

```bash
cd /Users/ken/workspace/muxterm/.worktrees/fix-multi-client-resize-restore
make dev-local   # run this with run_in_background=true — it's a foreground process (air)
```

Wait ~5s for the first build, then confirm:
```bash
curl -sSf http://127.0.0.1:8313/ >/dev/null && echo "dev-local up"
lsof -i :8311 | head -3   # confirm production is untouched — different PID, still there
```
Expected: `dev-local up`, and port 8311 still shows its own (different) PID.

---

### Task 6: Verify multiple terminal sizes on a single client

**Files:** none (verification-only task).

**Implementation:** none.

**Verification**

```bash
playwright-cli -s=sizecheck open http://127.0.0.1:8313
playwright-cli -s=sizecheck resize 1760 800    # ~220 cols at default font metrics
sleep 1
playwright-cli -s=sizecheck --raw eval "JSON.stringify((function(){ const s = window.__muxterm.snapshot(1); return { cols: s.cols, rows: s.rows }; })())"
```
Expected: a plausible `{"cols":<N1>,"rows":<M1>}` with `N1` in the high-100s/low-200s range (exact value depends on real font metrics — record the ACTUAL `N1`/`M1`, do not assume 220×50 exactly).

```bash
playwright-cli -s=sizecheck resize 720 480     # ~90 cols
sleep 1
playwright-cli -s=sizecheck --raw eval "JSON.stringify((function(){ const s = window.__muxterm.snapshot(1); return { cols: s.cols, rows: s.rows }; })())"
```
Expected: a SECOND plausible `{"cols":<N2>,"rows":<M2>}` with `N2 < N1` — record ACTUAL `N2`/`M2`.

```bash
playwright-cli -s=sizecheck resize 480 320     # ~60 cols
sleep 1
playwright-cli -s=sizecheck --raw eval "JSON.stringify((function(){ const s = window.__muxterm.snapshot(1); return { cols: s.cols, rows: s.rows }; })())"
playwright-cli -s=sizecheck --raw eval "JSON.stringify(window.__muxterm.snapshot(1).rowText.map(r => r.replace(/\\s+$/,'')))"
```
Expected: a THIRD plausible `{"cols":<N3>,"rows":<M3>}` with `N3 < N2 < N1`, and the rowText array contains no garbled fragments left over from the previous two sizes (no stray `$$$$`/`~~~~`/replacement-char runs per this repo's existing `isClean()` convention from the `muxterm-verify` skill).

```bash
playwright-cli -s=sizecheck close
```

**Commit**
```bash
git add -A
git commit -m "test: verify multiple terminal sizes on a single client (real playwright-cli)" --allow-empty
```

---

### Task 7: Verify real multi-client focus-switching

**Files:** none (verification-only task).

**Implementation:** none.

**Verification**

Open two independent browser sessions attached to the SAME dev-local workspace, at two different sizes:

```bash
playwright-cli -s=clientA open http://127.0.0.1:8313
playwright-cli -s=clientA resize 1760 800
sleep 1
playwright-cli -s=clientB open http://127.0.0.1:8313
playwright-cli -s=clientB resize 720 480
sleep 1
```

Confirm both attached to pane 1 and record each client's own natural size:
```bash
playwright-cli -s=clientA --raw eval "JSON.stringify(window.__muxterm.snapshot(1))" | head -c 200
playwright-cli -s=clientB --raw eval "JSON.stringify(window.__muxterm.snapshot(1))" | head -c 200
```

Focus client A explicitly (click into its terminal, simulating both visibility+OS-focus and a keystroke reclaim):
```bash
playwright-cli -s=clientA click "body"
playwright-cli -s=clientA type "echo clientA-focused"
playwright-cli -s=clientA press Enter
sleep 1
```

Assert: the PTY size now matches client A's size on BOTH clients, and client B is now non-authoritative (letterboxed):
```bash
playwright-cli -s=clientA --raw eval "JSON.stringify(window.__muxterm.snapshot(1))"
playwright-cli -s=clientB --raw eval "JSON.stringify(window.__muxterm.snapshot(1))"
playwright-cli -s=clientA --raw eval "window.__muxterm.isAuthoritative(1)"
playwright-cli -s=clientB --raw eval "window.__muxterm.isAuthoritative(1)"
```
Expected:
- Client A and client B's `snapshot(1).cols`/`.rows` are now EQUAL (both reflect client A's canonical size — B received `pane-resized` and letterboxed to match).
- `clientA` → `isAuthoritative(1)` → `true`.
- `clientB` → `isAuthoritative(1)` → `false`.
- Neither client's content is garbled (re-run the `rowText.map(...)` clean-text check from Task 6 on both).

Now switch: focus client B by typing into it:
```bash
playwright-cli -s=clientB click "body"
playwright-cli -s=clientB type "echo clientB-focused"
playwright-cli -s=clientB press Enter
sleep 1
playwright-cli -s=clientA --raw eval "JSON.stringify(window.__muxterm.snapshot(1))"
playwright-cli -s=clientB --raw eval "JSON.stringify(window.__muxterm.snapshot(1))"
playwright-cli -s=clientA --raw eval "window.__muxterm.isAuthoritative(1)"
playwright-cli -s=clientB --raw eval "window.__muxterm.isAuthoritative(1)"
```
Expected: cols/rows now both match client B's (smaller) size, `clientA` → `isAuthoritative(1)` → `false`, `clientB` → `isAuthoritative(1)` → `true`. Both clients' content remains clean (no garbling from the authority handoff).

```bash
playwright-cli -s=clientA close
playwright-cli -s=clientB close
```

**Commit**
```bash
git add -A
git commit -m "test: verify multi-client focus-switching authority handoff (real playwright-cli)" --allow-empty
```

---

### Task 8: Verify reconnect correctness at a third distinct size

**Files:** none (verification-only task).

**Implementation:** none.

**Verification**

```bash
playwright-cli -s=connA open http://127.0.0.1:8313
playwright-cli -s=connA resize 1760 800
sleep 1
playwright-cli -s=connA click "body"
playwright-cli -s=connA type "printf 'first-client-line\\n'"
playwright-cli -s=connA press Enter
sleep 1
playwright-cli -s=connA close    # disconnect client 1
```

```bash
playwright-cli -s=connB open http://127.0.0.1:8313
playwright-cli -s=connB resize 720 480
sleep 1
playwright-cli -s=connB click "body"
playwright-cli -s=connB type "printf 'second-client-line\\n'"
playwright-cli -s=connB press Enter
sleep 1
playwright-cli -s=connB --raw eval "JSON.stringify(window.__muxterm.snapshot(1))"
```
Record this size as the canonical PTY size after client B's interaction.

Now reconnect a THIRD client at a distinct third size:
```bash
playwright-cli -s=connC open http://127.0.0.1:8313
playwright-cli -s=connC resize 480 320
sleep 1
playwright-cli -s=connC --raw eval "JSON.stringify(window.__muxterm.snapshot(1))"
playwright-cli -s=connC --raw eval "window.__muxterm.isAuthoritative(1)"
playwright-cli -s=connC --raw eval "JSON.stringify(window.__muxterm.snapshot(1).rowText.map(r => r.replace(/\\s+$/,'')))"
```
Expected:
- `snapshot(1).cols`/`.rows` for client C reflect client C's OWN third viewport size — NOT client B's leftover size.
- `isAuthoritative(1)` → `true` for client C (its initial-attach `pane-focus`, sent via the new `onSettled` hook, claimed authority immediately).
- The rowText array shows `second-client-line` present (correct buffer content) with no garbled cursor-position artifacts, and the cursor sits at the correct spot for client C's own viewport (not mid-screen or wrong-looking, per the original bug this design fixes).

```bash
playwright-cli -s=connB --raw eval "JSON.stringify(window.__muxterm.snapshot(1))"
playwright-cli -s=connB --raw eval "window.__muxterm.isAuthoritative(1)"
```
Expected: client B is now non-authoritative (`false`) and letterboxed to client C's new canonical size — client C's reconnect claimed authority away from it.

```bash
playwright-cli -s=connB close
playwright-cli -s=connC close
```

**Commit**
```bash
git add -A
git commit -m "test: verify reconnect correctness at a third distinct viewport size (real playwright-cli)" --allow-empty
```

---

### Task 9: Verify DECSC/DECRC round-trip across reconnect

**Files:** none (verification-only task).

**Implementation:** none.

**Verification**

```bash
playwright-cli -s=decsc open http://127.0.0.1:8313
playwright-cli -s=decsc resize 1200 600
sleep 1
playwright-cli -s=decsc click "body"
playwright-cli -s=decsc type "printf '\\x1b7'"
playwright-cli -s=decsc press Enter
sleep 1
```

Record the cursor position at the moment of the DECSC save:
```bash
playwright-cli -s=decsc --raw eval "JSON.stringify(window.__muxterm.snapshot(1).cursor)"
```

Move the cursor elsewhere with more output:
```bash
playwright-cli -s=decsc type "printf 'line one\\nline two\\nline three\\n'"
playwright-cli -s=decsc press Enter
sleep 1
playwright-cli -s=decsc --raw eval "JSON.stringify(window.__muxterm.snapshot(1).cursor)"
```
Expected: cursor position now differs from the DECSC-saved position recorded above.

Disconnect and reconnect (exercises Phase 1's `serializeGrid()` shadow-tracker replay preamble):
```bash
playwright-cli -s=decsc close
playwright-cli -s=decsc open http://127.0.0.1:8313
sleep 1
```

Issue DECRC and confirm the cursor lands back at the ORIGINALLY-saved position:
```bash
playwright-cli -s=decsc click "body"
playwright-cli -s=decsc type "printf '\\x1b8'"
playwright-cli -s=decsc press Enter
sleep 1
playwright-cli -s=decsc --raw eval "JSON.stringify(window.__muxterm.snapshot(1).cursor)"
```
Expected: this cursor position matches the FIRST recorded position (the DECSC save point), not the "line three" position and not a default `{row:0,col:0}`.

```bash
playwright-cli -s=decsc close
```

**Commit**
```bash
git add -A
git commit -m "test: verify DECSC/DECRC saved-cursor round-trip across reconnect (real playwright-cli)" --allow-empty
```

---

### Task 10: Verify main-screen preservation round-trip across an alt-screen reconnect

**Files:** none (verification-only task).

**Implementation:** none.

**Verification**

This exercises the same shadow-tracker infrastructure as Task 9 (DECSC/DECRC), and a similar disconnect/reconnect-while-in-a-special-VT-mode methodology \u2014 here proving Phase 1 Task 12's `mainScreenSnapshot` shadow tracker (`internal/sessiond/vt.go`) actually populates a reconnecting client's main-screen buffer before it enters alt-screen mode.

Open a client and establish a distinguishable marker on the ordinary main screen (shell prompt) BEFORE entering alt-screen mode:
```bash
playwright-cli -s=mainscreen open http://127.0.0.1:8313
playwright-cli -s=mainscreen resize 1200 600
sleep 1
playwright-cli -s=mainscreen click "body"
playwright-cli -s=mainscreen type "printf 'main-screen-marker-before-vim\\n'"
playwright-cli -s=mainscreen press Enter
sleep 1
playwright-cli -s=mainscreen --raw eval "JSON.stringify(window.__muxterm.snapshot(1).rowText.map(r => r.replace(/\\\\s+$/,'')))"
```
Expected: the rowText array contains the literal line `main-screen-marker-before-vim` (record that this line is present \u2014 this is the content that must reappear, unblemished, after the alt-screen round-trip below).

Enter alt-screen mode by running a real full-screen program (`vim`, with no file argument, is enough \u2014 it enters the alternate screen buffer on start):
```bash
playwright-cli -s=mainscreen type "vim"
playwright-cli -s=mainscreen press Enter
sleep 2
playwright-cli -s=mainscreen --raw eval "JSON.stringify(window.__muxterm.snapshot(1).rowText.map(r => r.replace(/\\\\s+$/,'')))"
```
Expected: the rowText array now shows vim's alt-screen UI (empty-line `~` fill characters down the left column, and/or vim's bottom status line) \u2014 confirming the client is now rendering the alternate screen, and `main-screen-marker-before-vim` is no longer visible on screen (it's behind the alt-screen buffer).

Disconnect the client while still inside vim \u2014 alt-screen is still active at the moment of disconnect:
```bash
playwright-cli -s=mainscreen close
```

Reconnect and confirm the alt-screen content itself still renders correctly. **This part already worked before this fix** \u2014 it's the baseline, not what this task is newly proving:
```bash
playwright-cli -s=mainscreen open http://127.0.0.1:8313
sleep 1
playwright-cli -s=mainscreen --raw eval "JSON.stringify(window.__muxterm.snapshot(1).rowText.map(r => r.replace(/\\\\s+$/,'')))"
```
Expected: vim's alt-screen UI (the same `~` fill / status line pattern observed above) is still correctly rendered immediately after reconnect.

Exit vim so the app returns to the main screen (ordinary live `?1049l` output, unrelated to reconnect/replay):
```bash
playwright-cli -s=mainscreen click "body"
playwright-cli -s=mainscreen type ":q"
playwright-cli -s=mainscreen press Enter
sleep 1
playwright-cli -s=mainscreen --raw eval "JSON.stringify(window.__muxterm.snapshot(1).rowText.map(r => r.replace(/\\\\s+$/,'')))"
```
Expected \u2014 this is the specific behavior Phase 1's Task 12 (main-screen preservation shadow tracker) fixes:
- The rowText array contains `main-screen-marker-before-vim` again, correctly restored \u2014 NOT blank, NOT stale, NOT garbled.
- No leftover vim `~` fill characters or status-line fragments remain from the alt-screen buffer.
- Before this fix, this step would show a blank or incorrect local xterm.js main-screen buffer, because the reconnect replay never populated it \u2014 main-screen content only ever arrived via ordinary live output, never via the replay preamble.

```bash
playwright-cli -s=mainscreen close
```

**Commit**
```bash
git add -A
git commit -m "test: verify main-screen preservation round-trip across an alt-screen reconnect (real playwright-cli)" --allow-empty
```

---

### Task 11: Verify MCP-agent input never steals PTY-size authority from a human client

**Files:** none (verification-only task).

**Implementation:** none.

**Verification**

Open a human client, focus it, and record its size:
```bash
playwright-cli -s=human open http://127.0.0.1:8313
playwright-cli -s=human resize 900 500
sleep 1
playwright-cli -s=human click "body"
sleep 1
playwright-cli -s=human --raw eval "JSON.stringify(window.__muxterm.snapshot(1))"
playwright-cli -s=human --raw eval "window.__muxterm.isAuthoritative(1)"
```
Expected: `isAuthoritative(1)` → `true` for the human client; record its `cols`/`rows`.

Drive `send_input` from an MCP agent connection against the SAME dev-local sessiond (must set `XDG_RUNTIME_DIR` to the exact dev-local runtime dir `make dev-local` uses — confirm the actual value from the `dev-local` startup banner/logs before running this, since it must match exactly or the MCP client dials the wrong — or no — sessiond):

```bash
mkfifo /tmp/mcp-in-phase2verify
export XDG_RUNTIME_DIR="${TMPDIR:-/tmp}/muxterm-dev-local"
(./bin/muxterm-dev mcp < /tmp/mcp-in-phase2verify > /tmp/mcp-out-phase2verify.log 2>&1 &)
exec 3>/tmp/mcp-in-phase2verify
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' >&3
sleep 1
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_input","arguments":{"pane_id":1,"text":"echo agent-typing-1\n"}}}' >&3
sleep 1
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_input","arguments":{"pane_id":1,"text":"echo agent-typing-2\n"}}}' >&3
sleep 1
cat /tmp/mcp-out-phase2verify.log
```
Expected: both `tools/call` responses in the log show success (no error), confirming the agent's input actually reached the pane's PTY (the design explicitly requires agent input keeps working — it just must never claim authority).

Confirm the human client's PTY size and authority are UNCHANGED by the agent's activity:
```bash
playwright-cli -s=human --raw eval "JSON.stringify(window.__muxterm.snapshot(1))"
playwright-cli -s=human --raw eval "window.__muxterm.isAuthoritative(1)"
```
Expected: `cols`/`rows` identical to the values recorded before the agent's `send_input` calls, and `isAuthoritative(1)` is still `true` for the human client — the agent's input never sent (and per Phase 1 Task 5's `c.kind != "interactive"` guard, never CAN send) a `pane-focus`, and per Phase 1 Task 6 the agent's `kind == "agent"` keystroke input never calls `TouchAuthority`.

```bash
exec 3>&-
playwright-cli -s=human close
```

**Commit**
```bash
git add -A
git commit -m "test: verify MCP-agent input never steals PTY-size authority from human client (real playwright-cli)" --allow-empty
```

---

### Task 12: Full end-to-end verification complete — final commit and summary

**Files:** none.

**Implementation:** none.

**Verification**

Re-confirm production is still completely untouched after this entire verification run (the design's and dev-local design's non-negotiable isolation guarantee):
```bash
lsof -i :8311 | head -3
ls -la "$TMPDIR/muxterm-501/" 2>/dev/null | head -5   # adjust path if production's actual socket dir differs
```
Expected: production's port 8311 still serving under its own (unchanged) PID; its socket dir untouched by anything above.

Stop the dev-local stack:
```bash
# Ctrl-C the make dev-local foreground process (or kill its process group if
# it was started with run_in_background=true)
rm -f /tmp/mcp-in-phase2verify /tmp/mcp-out-phase2verify.log
```

Final static analysis re-check (belt-and-suspenders after the verification tasks, which made no code changes but confirms nothing was left dirty):
```bash
cd /Users/ken/workspace/muxterm/.worktrees/fix-multi-client-resize-restore
git status --porcelain
cd web && npm run check:fast
cd .. && go build ./...
```
Expected: `git status --porcelain` shows clean (all verification-task commits were `--allow-empty` markers with no file changes); both static-analysis commands exit 0 with no errors.

**Commit**
```bash
git add -A
git commit -m "chore: Phase 2 complete — client-side focus-authority wiring + all 6 real-execution scenarios pass

Verified via make dev-local (127.0.0.1:8313) + playwright-cli, per AGENTS.md
testing policy (no unit tests, real execution only):
  1. Multiple terminal sizes on a single client (220x50 -> 90x30 -> 60x20-ish)
  2. Real multi-client focus-switching authority handoff
  3. Reconnect correctness at a third distinct viewport size
  4. DECSC/DECRC saved-cursor round-trip across reconnect
  5. Main-screen preservation round-trip across an alt-screen reconnect
  6. MCP-agent input never steals PTY-size authority from a human client

Port 8311 (production) and its sessiond socket/log were never touched." --allow-empty
```

**Summary for the user:** Phase 1 (server-side Go: authority state, `pane-focus`/`pane-resized` protocol, keystroke reclaim, DECSC/DECRC shadow tracker, main-screen preservation shadow tracker) and Phase 2 (client-side TypeScript: `paneFocus()` sender, `pane-resized` handling with letterbox/scroll rendering, the focus coordinator wired to dockview/visibility/reconnect) are both complete and verified end-to-end against a real browser and a real sessiond process. This is the point at which the originally reported bug (garbled reconnect — wrong cursor position, apparent wrong-terminal content) can be reported as fixed to the user, backed by the six real-execution scenarios above.
