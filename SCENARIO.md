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

**4.4** Click pane 1 (the original/left panel) to give it focus.  
Assert: `dock.activePaneId === pane1Id`  
> This step is required before refresh — it sets up the active-pane-persistence assertion.
> The split creates a new pane which becomes active; click back to pane1 to test that pane1 survives as the active selection.

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

---

## Scenario 5 — Bell Indicators: Desktop (1280×800)

### Setup helpers

```js
// Shadow-pierce to dock and store
const dock    = () => document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
const dockBar = () => document.querySelector('mux-app').shadowRoot.querySelector('mux-dock-bar');
const store   = () => document.querySelector('mux-app').shadowRoot.querySelector('mux-dock').__store;
```

---

### Phase A — Pane tab bell dot

**A.1** Open two panes in the same group so one is in the background.

**A.2** In devtools console, fire a bell on the background pane:
```js
const term = dock().getPane(backgroundPaneId)._term;
term._core._onBell.fire();
```

**A.3** Read tab labels via the dockview DOM:
```js
const tabs = dock().querySelectorAll('.dv-default-tab-content');
```

**A.4** **(Assertion A1)** The tab label for the background pane must start with `●`:
```js
const bgTab = [...tabs].find(t => t.dataset.paneId == backgroundPaneId);
bgTab.textContent.trimStart().startsWith('●')  // must be true
```

**A.5** Note the current active pane ID:
```js
const before = dock().activePaneId;
```

**A.6** Click the background pane tab to give it focus.

**A.7** Wait one animation frame / 100 ms.

**A.8** Re-read the tab labels:
```js
const tabs2 = dock().querySelectorAll('.dv-default-tab-content');
```

**A.9** **(Assertion A2)** The `●` prefix must now be gone:
```js
const bgTab2 = [...tabs2].find(t => t.dataset.paneId == backgroundPaneId);
!bgTab2.textContent.trimStart().startsWith('●')  // must be true
```

**A.10** Assert the pane is now active:
```js
dock().activePaneId === backgroundPaneId  // must be true
```

**A.11** Assert no other tab has a spurious `●`:
```js
[...tabs2].every(t => !t.textContent.trimStart().startsWith('●'))  // must be true
```

---

### Phase B — Workspace dock slot bell dot

**B.1** Note current workspace IDs and the currently-active workspace:
```js
const wsAId = store().attached;      // wsA is the workspace currently displayed
const wsBId = store().workspaces.find(w => w.workspaceId !== wsAId)?.workspaceId;
```

**B.2** Switch to wsA so that wsB is in the background (if not already).

**B.3** Simulate a bell on a pane inside wsB:
```js
store().ringWorkspace(wsBId);
```

**B.4** **(Assertion B1)** The inactive workspace button must show a bell dot:
```js
const bar = dockBar();
bar.shadowRoot.querySelector('.ws-btn:not(.active) .bell-dot') !== null  // must be true
```

**B.5** Click the wsB workspace button to switch to it.

**B.6** Wait for the workspace to become active (status bar updates).

**B.7** **(Assertion B2)** After switching, no bell dot must remain on any workspace button:
```js
bar.shadowRoot.querySelector('.ws-btn .bell-dot') === null  // must be true
```

**B.8** Assert `store().workspaceBellActive(wsBId)` returns `false`.

---

### Phase C — Tab sizing

**C.1** **(Assertion C1)** Read the computed style of a tab element and assert the min/max-width constraints:
```js
const tab = dock().querySelector('.dv-default-tab');
const cs  = getComputedStyle(tab);
parseInt(cs.minWidth) >= 79 && parseInt(cs.maxWidth) <= 181  // must be true
```

---

### Pass/Fail Checklist — Scenario 5

| # | Phase | Assertion | Result |
|---|-------|-----------|--------|
| A1 | A.4 | Tab label starts with `●` when background pane has bell | |
| A2 | A.9 | `●` prefix removed after pane focused | |
| B1 | B.4 | Inactive workspace button shows `.bell-dot` | |
| B2 | B.7 | `.bell-dot` absent after switching to that workspace | |
| C1 | C.1 | Tab `minWidth ≥ 79px` and `maxWidth ≤ 181px` | |

All 5 checks must pass for Scenario 5 to be clean.

---

## Scenario 6 — Bell Indicators: Mobile (390×844 — iPhone 14 Pro)

> Set the browser viewport to **390 × 844** (iPhone 14 Pro) before starting this scenario.
> Use responsive-design mode in DevTools or launch the browser with `--window-size=390,844`.

### Setup helpers

```js
const app      = () => document.querySelector('mux-app');
const dock     = () => app().shadowRoot.querySelector('mux-dock');
const dockBar  = () => app().shadowRoot.querySelector('mux-dock-bar');
const titleBar = () => app().shadowRoot.querySelector('mux-title-bar');
const store    = () => dock().__store;
```

---

### Phase A — Layout at mobile breakpoint

**A.1** Navigate to `http://localhost:9090` at the 390 × 844 viewport.  
Wait until status bar shows **connected**.

**A.2** **(Assertion A1)** The dockview tab strip must be hidden at this viewport:
```js
const tabContainer = dock().querySelector('.dv-tabs-and-actions-container');
getComputedStyle(tabContainer).display === 'none'  // must be true
```

**A.3** **(Assertion A2)** The `mux-pane-picker` component must be visible in the title bar:
```js
const picker = titleBar().shadowRoot.querySelector('mux-pane-picker');
picker !== null && getComputedStyle(picker).display !== 'none'  // must be true
```

**A.4** **(Assertion A3)** The breadcrumb text must contain both `›` (separator) and `▾` (dropdown caret):
```js
const breadcrumb = titleBar().shadowRoot
  .querySelector('mux-pane-picker')
  .shadowRoot.querySelector('.breadcrumb');
breadcrumb.textContent.includes('›') && breadcrumb.textContent.includes('▾')  // must be true
```

---

### Phase B — Pane switching via breadcrumb

**B.1** Note the active pane ID and an inactive pane ID:
```js
const activePaneId   = dock().activePaneId;
const inactivePaneId = store().panes.find(p => p.id !== activePaneId).id;
```

**B.2** Trigger a bell on the inactive pane:
```js
store().ringPane(inactivePaneId);
```

**B.3** Click the breadcrumb button to open the pane-picker dropdown:
```js
titleBar().shadowRoot.querySelector('mux-pane-picker').shadowRoot
  .querySelector('.breadcrumb').click();
```

**B.4** **(Assertion B1)** The dropdown must now be visible:
```js
const picker = titleBar().shadowRoot.querySelector('mux-pane-picker').shadowRoot;
picker.querySelector('.dropdown') !== null  // must be true
```

**B.5** **(Assertion B2)** The dropdown must contain at least one `.bell-dot` element for the pane with the bell:
```js
picker.querySelectorAll('.dropdown .bell-dot').length > 0  // must be true
```

**B.6** Click the inactive pane item in the dropdown:
```js
picker.querySelector('.pane-item:not(.active)').click();
```

**B.7** Wait one animation frame / 100 ms.

**B.8** **(Assertion B3)** The bell on the previously-inactive pane must now be cleared:
```js
store().paneBellActive(inactivePaneId) === false  // must be true
```

---

### Phase C — Dock bar present on mobile

**C.1** **(Assertion C1)** [deferred — mux-dock-bar not yet mounted] The dock bar must remain visible at the mobile viewport:
```js
getComputedStyle(dockBar()).display !== 'none'  // must be true
```

**C.2** **(Assertion C2 — skip if only 1 workspace)** [deferred — mux-dock-bar not yet mounted] Switching workspaces via the dock bar must work:
```js
// Record current workspace
const beforeId = store().attached;

// Click a different workspace button
dockBar().shadowRoot.querySelector('.ws-btn:not(.active)').click();

// Wait for switch, then check
store().attached !== beforeId  // must be true
```

---

### Pass/Fail Checklist — Scenario 6

| # | Phase | Assertion | Result |
|---|-------|-----------|--------|
| A1 | A.2 | Tab strip hidden at 390 px viewport | |
| A2 | A.3 | `mux-pane-picker` visible in title bar | |
| A3 | A.4 | Breadcrumb contains `›` and `▾` | |
| B1 | B.4 | Dropdown opens on breadcrumb click | |
| B2 | B.5 | `.bell-dot` present in dropdown for belled pane | |
| B3 | B.8 | `paneBellActive` cleared after switching to that pane | |
| C1 | C.1 | Dock bar visible at mobile viewport [deferred — mux-dock-bar not yet mounted] | |
| C2 | C.2 | Workspace switch works from mobile dock bar (skip if 1 WS) [deferred — mux-dock-bar not yet mounted] | |

All 8 checks (7 required + C2 conditional) must pass for Scenario 6 to be clean.
