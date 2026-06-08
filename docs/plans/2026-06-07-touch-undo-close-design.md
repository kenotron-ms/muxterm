# Touch-Safe Pane Close with Undo Design

## Goal

Prevent accidental terminal panel closures on touch devices without adding any friction to mouse/keyboard input.

## Background

The dockview tab's native X button is easy to accidentally tap on touch devices (phone/tablet). A single tap instantly kills the PTY, destroys xterm.js scrollback, and is irreversible. Mouse users rarely have this problem — the concern is exclusively touch/stylus input.

We need a way to make touch-initiated closes recoverable while leaving the fast, frictionless mouse path completely unchanged.

## Approach

**Touch-only deferred kill with a 10-second undo toast.**

- **Mouse close**: unchanged — instant, permanent, zero friction.
- **Touch/pen close**: the panel disappears visually from dockview immediately, but the PTY kill is deferred 10 seconds.
- A toast appears with a countdown and an Undo button during the grace period.
- **Undo**: cancels the timer and re-adds the panel to dockview via the reconciler — the PTY is still running and scrollback is intact.
- If the grace period expires without undo: the kill executes exactly as it does today.

The key insight is that the pointer type that initiated the close is known by the time the close event fires, so we can branch on it without polling or new APIs.

## Architecture

Three pieces collaborate:

1. **`mux-dock`** detects the pointer type that initiated a close and tags the existing `pane-close` event with a `touch` boolean. It also gains a `reopenPane()` method to bring a panel back during undo.
2. **`mux-app`** owns the deferred-kill lifecycle: a `_pendingCloses` map of timers, the deferred-vs-instant branch in `_onClosePane`, the actual kill in `_executeClose`, and the undo handler. It renders one `<mux-undo-toast>` per pending close.
3. **`mux-undo-toast`** is a new Lit component rendering the countdown UI and Undo button, self-cleaning on expiry or undo.

During the grace period the server has no knowledge of the close — the PTY runs, the xterm instance lives, and `store.panes` still includes the pane. This is what makes undo a simple reconcile rather than a re-spawn.

## Components

### Component 1: Pointer Type Detection (`mux-dock`)

A single `pointerdown` listener on the host element (capture phase) stores `_lastPointerType: string`. The browser event sequence for a tab close is:

1. `pointerdown` fires → sets `_lastPointerType = event.pointerType` (`'touch' | 'mouse' | 'pen'`)
2. `pointerup` fires
3. `click` fires → dockview processes it → fires `onDidRemovePanel`

By the time `onDidRemovePanel` fires, `_lastPointerType` is already set correctly for that interaction.

`pen` is treated the same as `touch` — same accidental-close risk on tablets with a stylus.

The existing `pane-close` CustomEvent detail gains a `touch: boolean` field (`true` for `'touch' | 'pen'`, `false` for `'mouse'`) and a `title: string` field. The title is captured from the dockview `panel` object inside the `onDidRemovePanel` handler (before `_panels.delete()` is called), using `panel.title ?? \`Pane ${paneId}\`` as the value. This is the same text shown in the dockview tab, typically the shell or process name. Mouse closes (`touch: false`) take the existing instant-kill path in `mux-app._onClosePane` unchanged.

The updated event detail is `{ paneId, touch: boolean, title: string }`.

No new APIs, no polling. One listener, two fields on an existing event.

### Component 2: Deferred Kill — 10-Second Grace Period (`mux-app`)

`mux-app` gains `_pendingCloses: Map<number, ReturnType<typeof setTimeout>>`.

When `_onClosePane` receives `touch: true`:

- Start a 10s timer: `setTimeout(() => this._executeClose(paneId), 10_000)`
- Store the handle: `_pendingCloses.set(paneId, handle)`
- Show the undo toast
- Return early — no socket message sent, no prune

When the timer fires, `_executeClose(paneId)`:

- `this._socket?.closePane(paneId)` (same as current code)
- `terminalRegistry.prune(remaining)` (same as current code)
- `_pendingCloses.delete(paneId)`

During the 10 seconds: the server has no knowledge of the close. The PTY is running, the xterm instance is alive, and `store.panes` still includes the pane.

### Component 3: Undo Execution

When the user taps Undo, `mux-app`:

1. `clearTimeout(_pendingCloses.get(paneId))`
2. `_pendingCloses.delete(paneId)`
3. Calls `this._dock.reopenPane(paneId)` — a new method on `mux-dock`

`mux-dock.reopenPane(paneId)`:

1. `_locallyClosedPanes.delete(paneId)` — re-enables the reconciler for this pane
2. `_reconcile()` — the reconciler sees the pane in `store.panes` but not in `_panels`, and re-adds it to dockview

Why this works: during the grace period the server never received `close-pane`, so `store.panes` still has the entry and the PTY is still running. `terminalRegistry` still has the xterm instance (prune was never called). Removing from `_locallyClosedPanes` and calling `_reconcile()` is sufficient — the panel comes back with full scrollback and an active PTY.

**Known limitation**: dockview places the re-added panel at its default position, not its original slot in the split layout. Position is not preserved by undo. Terminal content and PTY state are fully preserved.

### Component 4: Toast Component — `<mux-undo-toast>`

A new Lit custom element.

**Label**: the panel's dockview title (what the tab was showing — typically the shell/process name). Falls back to `Pane ${paneId}` if no title is set. Example labels: `"vim closed"`, `"Pane 3 closed"`.

**Visual layout**:

```
┌─────────────────────────────────────────┐
│  Pane 3 closed   [     Undo     ]  8s  │
│  ████████████████████░░░░░░░░░░░░░░░░░  │
└─────────────────────────────────────────┘
```

**Touch target**: the Undo button is a minimum of 44px height and spans roughly half the toast width — large enough to hit confidently on a phone under time pressure.

**Countdown**: a CSS `transition` on `width` drives the progress-bar animation (no JS needed for the animation). One `setInterval` per toast fires each second to update the numeric label and trigger self-destruction at zero.

**Positioning**: `position: fixed; bottom: <status-bar-height>; left: 50%; transform: translateX(-50%)` — centered above the status bar on any screen width.

**Multiple simultaneous closes**: `_pendingCloses` is a Map, so N closes → N independent toasts. Toasts stack vertically, newest on top. Each has its own timer and independent Undo button.

```
┌─────────────────────────────────────────┐  ← newer (Pane 4, 10s)
│  Pane 4 closed   [     Undo     ]  10s  │
│  ████████████████████████████████████░  │
└─────────────────────────────────────────┘
┌─────────────────────────────────────────┐  ← older (vim, 6s left)
│  vim closed      [     Undo     ]   6s  │
│  █████████████████░░░░░░░░░░░░░░░░░░░░  │
└─────────────────────────────────────────┘
[ status bar ]
```

**Self-cleanup**:

- **Undo path**: the toast dispatches `pane-close-resolved` with the paneId → `mux-app` cancels the timer, removes from `_pendingCloses`, and drops the toast from the render tree.
- **Expiry path**: `mux-app`'s `_executeClose` sends the close, removes from `_pendingCloses`, and drops the toast from the render tree by re-rendering. The toast does NOT dispatch any event on expiry — it simply disconnects.

## Data Flow

1. User taps the tab X with a touch/pen pointer.
2. `mux-dock` `pointerdown` listener records `_lastPointerType`.
3. dockview removes the panel locally and fires `onDidRemovePanel`; `mux-dock` emits `pane-close` with `touch: true`.
4. `mux-app._onClosePane` starts a 10s timer, stores it in `_pendingCloses`, and renders a `<mux-undo-toast>`. No server message is sent.
5. Branch A — **Undo**: toast's Undo button → `mux-app` clears the timer, calls `mux-dock.reopenPane(paneId)`, which removes the pane from `_locallyClosedPanes` and reconciles it back into dockview with intact scrollback and a live PTY.
6. Branch B — **Expiry**: timer fires → `_executeClose` sends `closePane` to the server, prunes the registry, and removes the entry from `_pendingCloses`. The toast self-destructs.

Mouse closes skip steps 4–6 entirely and take the existing instant path (`touch: false`).

## Error Handling

- **Process exits naturally during the grace period**: the server broadcasts `pane-closed` and the store removes the pane. When the timer later fires, `socket.closePane()` returns OK (the server is idempotent on double-close) and prune has nothing extra to destroy. No special casing needed.
- **Workspace change during the grace period**: the workspace-change handler cancels all timers in `_pendingCloses` and clears the map. Panes from the previous workspace survive on the server — the correct outcome, since the close was accidental.

## Testing Strategy

Per the project's `AGENTS.md`, UI validation uses Playwright with xterm.js buffer capture. The browser context must be created with `hasTouch: true` to simulate touch events.

Three test cases:

1. **Touch close + Undo**: simulate a touch tap on the close button → verify the toast appears → tap Undo → verify the panel is still present → check that xterm buffer content is intact.
2. **Touch close + expiry**: simulate a touch tap on the close button → wait 10s (Use `page.clock` fake timers or `page.clock.tick(10_000)` to avoid a literal 10-second test wait.) → verify the pane is absent from server state.
3. **Mouse close**: simulate a mouse click on the close button → verify no toast appears → verify the pane closes immediately.

## Files Affected

- `web/src/components/mux-dock.ts` — add `_lastPointerType`, the `pointerdown` listener, the `touch` field on the event, and the `reopenPane()` method.
- `web/src/app.ts` — add the `_pendingCloses` Map, modify `_onClosePane` for the deferred path, add `_executeClose()`, add the undo event handler, and render `<mux-undo-toast>` elements.
- `web/src/components/mux-undo-toast.ts` — new Lit component.
- `web/e2e/` — new Playwright test file for the three cases above.

## Open Questions

None outstanding. The position-not-preserved behavior on undo is a known, accepted limitation rather than an open question.
