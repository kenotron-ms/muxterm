# muxterm User Journey Verification Scenario

This is the authoritative "works like a real user" check for muxterm.
Walk through it agentically using `browser-tester:browser-operator` whenever verifying
that pane operations, browser refresh, and terminal replay are all working correctly.

---

## What This Catches

| Bug class | Specific assertion |
|-----------|-------------------|
| Garbled terminal on reconnect | Content after refresh must not contain raw ANSI sequences or `$$$$~~~~` artifacts |
| Delete pane not persisting to server | Close pane → refresh → pane must NOT reappear |
| Selected pane not persisting to server | Active pane before refresh must still be active pane after refresh |
| Split layout not restored | Split survives refresh with the correct pane still active |

---

## Prerequisites

- muxterm server running at **http://localhost:9090** (adjust if different)
- Use a fresh private/incognito window to avoid stale PWA cache
- The Go sessiond process must be running (not just the frontend dev server)

---

## DOM Helper Snippets

Use these in `page.evaluate()` or agent-browser `eval` calls at any assertion point.

```js
// Shadow-pierce to the dock component
const dock = () => document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');

// Read full terminal buffer for a pane (returns newline-joined string)
dock().getTerminalContent(PANE_ID);

// Active (focused) pane ID; -1 if none
dock().activePaneId;

// Check for garbled text — returns true if content is CLEAN
function isClean(text) {
  return !/\x1b/.test(text)        // no ESC at all (CSI, DCS, OSC, ST, SS3, RIS, …)
      && !/\$\$\$\$/.test(text)    // no measurement leak artifacts
      && !/~~~~/.test(text)        // no xterm sizing garbage
      && !/\ufffd/.test(text);     // no unicode replacement chars
}
```

---

## Phase 1 — Load, New Workspace, First Pane

**1.1** Navigate to `http://localhost:9090`.  
Wait until status bar (bottom strip) shows **connected** in green.

**1.2** Click the workspace label in the status bar (bottom-left) to open the workspace picker.

**1.3** Click the **+** (plus) button in the picker to create a new workspace.  
The new workspace appears as "workspace N".

**1.4** Click the new workspace row to switch to it.  
Assert: status bar now shows the new workspace name; dockview area is empty.

**1.5** Press **Ctrl+Shift+\\** to create the first terminal pane.  
Assert: a terminal opens with a shell prompt visible; no garbled content.

**1.6** Click the terminal to give it focus. Type `echo 'hello world'` and press Enter.  
Assert: `hello world` appears in the terminal output.

**1.7** Capture pane 1 state:
```js
const dock = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
const pane1Id = dock.activePaneId;                 // record this
const c1 = dock.getTerminalContent(pane1Id);
```
Assert: `pane1Id >= 0`  
Assert: `c1` contains `hello world`  
Assert: `isClean(c1)` is true — no ANSI garbage

---

## Phase 2 — Second Pane, Refresh, Verify Persistence

**2.1** Click the **+** button in the dockview tab header (right of the tab strip) to open a second pane in the same group.  
Assert: a second tab opens and becomes active; fresh shell prompt.

**2.2** Type `echo 'pane two'` and press Enter.  
Assert: `pane two` appears.

**2.3** Capture pane 2 state:
```js
const pane2Id = dock.activePaneId;
```
Assert: `pane2Id !== pane1Id`  
Assert: pane 2 tab is visually highlighted (active tab styling)

**2.4** Refresh the browser (F5 / reload).  
Wait until status bar shows **connected** again.

**2.5** Assert selected pane survived refresh:
```js
const dock = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
dock.activePaneId  // must equal pane2Id
```
> **Bug signal:** If `activePaneId !== pane2Id`, the selected-pane-persistence bug is present.

**2.6** Assert terminal content is clean in both panes:
```js
const c1 = dock.getTerminalContent(pane1Id);   // must contain 'hello world', must be clean
const c2 = dock.getTerminalContent(pane2Id);   // must contain 'pane two', must be clean
isClean(c1) && isClean(c2)
```
> **Bug signal:** Any ANSI sequences, `$$$$`, or `~~~~` in the content = delta-replay garble bug.

---

## Phase 3 — Delete Pane, Verify Server-Side Deletion

**3.1** Click the pane 2 tab to make sure it is the active tab.

**3.2** Click the **×** (close) button on the pane 2 tab.  
Assert: tab disappears immediately (optimistic update); pane 1 becomes active.

**3.3** Verify local UI state:
```js
dock.activePaneId  // must equal pane1Id
```
Assert: only one tab visible in the tab strip.

**3.4** Refresh the browser.  
Wait until status bar shows **connected**.

**3.5** Assert pane 2 did NOT come back:
```js
const dock = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
dock.activePaneId  // must equal pane1Id
// visually: only one tab visible
```
> **Bug signal:** If pane 2 reappears (two tabs, or pane2Id becomes activePaneId), server-side delete is not working.

**3.6** Assert pane 1 content is still clean:
```js
const c1 = dock.getTerminalContent(pane1Id);
isClean(c1) && c1.includes('hello world')
```

---

## Phase 4 — Split Pane, Refresh, Verify Layout

**4.1** Click the **split** button (two side-by-side rectangles, far right of tab bar) to split pane 1 into a side-by-side layout.  
Assert: viewport splits; new pane opens on the right, is focused.

**4.2** Type `echo 'split pane'` and press Enter.  
Assert: `split pane` appears in the new split terminal.

**4.3** Capture split pane state:
```js
const splitId = dock.activePaneId;
```
Assert: `splitId !== pane1Id`

**4.4** Click pane 1 (left panel) to give it focus.  
Assert: `dock.activePaneId === pane1Id`

**4.5** Refresh the browser.  
Wait until status bar shows **connected**.

**4.6** Assert layout and selection survived:
```js
const dock = document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
dock.activePaneId  // must equal pane1Id
// visually: both panels still visible side-by-side
```
> **Bug signal:** Layout collapsed to single pane, or wrong pane is active.

**4.7** Assert both terminals are clean:
```js
const c1 = dock.getTerminalContent(pane1Id);
const cs = dock.getTerminalContent(splitId);
isClean(c1) && c1.includes('hello world')
isClean(cs) && cs.includes('split pane')
```

---

## Pass/Fail Checklist

| # | Phase | Assertion | Result |
|---|-------|-----------|--------|
| 1 | 1.7 | Terminal clean on fresh load | |
| 2 | 2.5 | `activePaneId === pane2Id` after refresh | |
| 3 | 2.6 | Both terminals clean after refresh | |
| 4 | 3.5 | Pane 2 absent after delete + refresh | |
| 5 | 3.5 | `activePaneId === pane1Id` after delete + refresh | |
| 6 | 3.6 | Pane 1 terminal still clean | |
| 7 | 4.6 | Split layout survives refresh | |
| 8 | 4.6 | `activePaneId === pane1Id` in split layout | |
| 9 | 4.7 | Both split terminals clean | |

All 9 checks must pass for a clean run.
