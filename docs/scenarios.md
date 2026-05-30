# End-User Testing Scenarios

What to check, expected behavior, and what's actually observed.

> This document is driven by live playwright-cli DOM inspection.
> "Observed" entries reflect actual browser state, not guesses.

---

## Observation baseline (initial load)

Session connected: `9`, two windows both named `ken`.

DOM snapshot (accessibility tree):
```
muxterm  [tab: ken ×] [tab: ken ×]  [+]
<terminal area>
[9] | 2 windows | ken 1 pane | connected
```

**Working:**
- Header with app name, tabs, + button
- Status bar showing session name, window count, active pane name, connection state
- Terminal element renders (wterm creates `.term-row` DOM nodes — inspectable)

---

## Scenario 1 — Initial terminal content on load

**Action:** Open the browser after `./bin/muxterm` starts.

**Expected:** Terminal shows what was on screen in tmux before connecting
— shell prompt, last command output, cursor at correct position.

**Observed (actual DOM):**

Content IS present (42 `.term-row` elements). However there is a staircase
artifact — each line starts at the column where the previous line ended:

```
row 0:  meetings
row 1:          Movies
row 2:                Music
row 3:                     nanobanana-images
```

**Root cause:** `tmux capture-pane -p` outputs bare `\n` (line feed).
Terminals treat `\n` as cursor-down only — no carriage return to col 0.
The cursor drifts right with each line.

**Fix needed:** Replace `\n` with `\r\n` in `CapturePaneContent` output.

**Actual pane content (from `tmux capture-pane -p`):**
```
meetings
Movies
Music
nanobanana-images
...
ken@Kens-MacBook-Pro ~ % dfsdfrr
```

---

## Scenario 2 — Keyboard input

**Action:** Click the terminal area, type `ls`, press Enter.

**Expected:** Characters appear in the terminal, command executes, output appears.

**To verify:**
- Single characters echo immediately
- Enter sends the command
- Arrow keys work (history, cursor movement)
- Backspace deletes
- Ctrl+C interrupts

**Current status:** Input path is wired (`onData` → binary WebSocket frame →
`SendKeysLiteral` hex-encoded). Untested live.

---

## Scenario 3 — Window tab switching

**Action:** Click the second "ken" tab.

**Expected:**
- Tab highlight moves to second tab
- Terminal area changes to show window 2's content
- Window 2's pane content loads

**Known gap:** Tab switch sends `select-window` to tmux which updates the active
window. But window 2's pane content is NOT re-fetched — only `sendStateSync`
(on initial connect) runs `CapturePaneContent` per pane. Switching tabs after
connect shows an empty terminal for the newly visible window until it receives
live `%output` events.

**To verify:**
- Click second tab → does content change?
- Type something in window 2 → does it appear?

---

## Scenario 4 — Split panes

**Action:** Open muxterm against a tmux session that already has a split
(e.g. `tmux split-window -h`).

**Expected:**
- Both panes visible side by side
- Each pane shows its own content
- Click a pane → keyboard input goes to that pane

**Known gaps:**
- Layout parser (`parseLayout` in TS) produces a flex tree — visual output
  of dividers and sizing unverified
- Each pane gets its own wterm instance; content capture fires for all panes
  on connect via `ForEachPane`

---

## Scenario 5 — Creating a new window

**Action:** Click the `+` button in the tab bar.

**Expected:**
- New tab appears
- tmux creates a new window
- Terminal shows fresh shell prompt

**To verify:** Does the `+` button fire a `new-window` action? Is there a
`window-add` event received? Does the tab appear?

---

## Scenario 6 — Running vim / htop (alternate screen)

**Action:** Type `vim somefile` in a pane.

**Expected:** vim UI fills the terminal; keyboard input works; Escape/`:q` exits.

**Known gaps:**
- `capture-pane` without `-a` captures the normal screen buffer, not the
  alternate screen. If vim is already open when you connect, the initial
  capture shows the normal screen (i.e. what was there before vim launched),
  not the vim UI.
- Arrow keys, Escape should pass through via `SendKeysLiteral` hex encoding.

---

## Scenario 7 — Scrollback

**Action:** Run `ls -la ~/` (long output), then scroll up with mouse wheel.

**Expected:** Scrolling reveals content above the current viewport.

**Observed:** wterm creates `term-scrollback-row` elements (visible in DOM).
`has-scrollback` class is present on the container. Scrolling should work
but is unverified.

**Note:** `scrollback: 0` was set in ghostty-web. wterm default allows
scrollback. Behavior may have changed with the migration.

---

## Scenario 8 — Reconnect after server restart

**Action:** Kill and restart `./bin/muxterm`, return to browser.

**Expected:**
- Disconnect overlay appears briefly
- Reconnects automatically (exponential backoff in `ws.ts`)
- Terminal content reappears (new `sendStateSync` fires)

**To verify:** Is the overlay visible? Does reconnect succeed? Is content
restored?

---

## Scenario 9 — Resize browser window

**Action:** Drag browser window to a different size.

**Expected:**
- Terminal reflows to fill available space
- `onResize` callback fires → `pane-resize` event → `ResizePane` sent to tmux
- tmux updates its internal pane dimensions

**Known gap:** wterm `autoResize: true` observes the container with
`ResizeObserver`. Since the container is inside a shadow DOM, whether
`ResizeObserver` fires correctly is unverified.

---

## Scenario 10 — Colors and formatting

**Action:** Run `ls --color`, `git log --oneline`, or `grep --color`.

**Expected:** ANSI colors render in the terminal.

**Observed:** The current staircase bug (Scenario 1) makes this hard to
evaluate. Once `\r\n` fix is in, check that colors appear correctly.

**Known:** wterm supports 16-color, 256-color, and 24-bit true color.
The default theme is VS Code Dark+ (hardcoded CSS variables in `terminal.css`).

---

## What I can read via playwright

Because wterm uses DOM rendering, `playwright-cli eval` can directly read:
- `.term-row` text content (what's displayed on each line)
- Row count
- Whether content is in scrollback vs viewport
- CSS classes on the terminal container (focused, has-scrollback, cursor-blink)

This makes scenario verification possible without screenshots.
