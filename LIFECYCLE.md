# muxterm Component Lifecycle — Believed Sequence

This is my best understanding of what SHOULD happen on a browser refresh.
Logging in `mux-log.ts` instruments every key transition so we can compare
actual vs. believed. Look for `[mux:*]` in the browser console.

---

## Actors

```
Browser        ws.ts         app.ts        state.ts      registry       mux-dock      WorkspaceCtrl
   WS          MuxSocket     MuxApp        MuxStore      termReg        MuxDock       WorkspaceCtrl
```

---

## Phase 1 — WS Connect → Composition

```
Browser ──WS open──────────────────────────────────────────────────────────────────────────────────►
                  ws.onopen()
                  ───────────► onReconnect()
                                ─────────────────────────────────────────────────────────────────►
                                                                                    bootstrap()
                                                                                    localStorage.lastWsId?
                                                                                    YES → attachWithBreakpoint(wsId, 'wide', offsets=[])
                  ◄── send "attach" JSON ──────────────────────────────────────────────────────────

[Server receives attach, sends composition JSON + queues replay bytes]

Browser ──WS text ("composition") ─────────────────────────────────────────────────────────────────►
         ws.onmessage
                  ─────────────► onSessiondMessage(msg)
                                  ──────────────────────► store.applySessiond(composition)
                                                          _attached = wsId
                                                          _panes = msg.panes
                                 !! BUG SITE !!─────────► _activePaneId = panes[0].paneId  ← ALWAYS first pane
                                                          _layout = msg.layout
                                                          _settlePending()
                                                          _notify() ─────► _version++

                                  setWorkspace(wsId) ──────────────────────────────────────────────►
                                  for each pane:
                                    ensure(paneId, handlers) ─────────────────────────────────────►
                                                              creates Terminal
                                                              entry.ready = false
                                                              entry.opened = false
                                                              entry.pendingData = []
                                    setSeqAnchor(paneId, pane.seq) ──────────────────────────────►
                                                              entry.seqBase = pane.seq
                                                              entry.seqBytes = 0

                                  IF msg.panes is empty → _createPaneOptimistic()

                                  controller.onMessage(composition) ───────────────────────────────►
                                                                    mru.touch(wsId)
                                                                    localStorage.lastWsId = wsId
```

---

## Phase 2 — Lit Re-render → Terminal Attach

```
[Microtask queue drains — Lit's batching fires BEFORE next WS macrotask]

Lit update (microtask):
  willUpdate()
  ──────────────────────────────────────────────────────────► _syncTerminals()
                                                              setWorkspace(attached)
                                                              ensure(paneId) ── idempotent
                                                              prune(liveIds)

  render() → <mux-dock panes=... activePaneId=panes[0] layout=savedJSON workspaceKey=wsId>

  mux-dock.updated(workspaceKey changed):
    Case 1 — workspaceKey changed:
      _settingActive = true
      _removingPanels = true

      for each old panel: dv.removePanel() [if any]
      _panels.clear()

      seed _customTitles from pane titles

      IF !narrow AND layout:
        _restoringLayout = true
        dv.fromJSON(parsedLayout)
          ──► TerminalRenderer.init() called for each panel
                getTerminal(paneId) === null → _pendingMount = true
          ──► TerminalRenderer.layout() called for active panel
                element.isConnected? MAYBE NO (detached subtree during fromJSON)
                  → returns, no attach yet
          ──► [dockview appends subtree to DOM]
          ──► TerminalRenderer.layout() called again (post-append, isConnected=TRUE)
                getTerminal(paneId) !== null && isConnected → attach!
                terminalRegistry.attach(paneId, element, isActive)
                  term.open(hostEl)           ← entry.opened = true
                  container.appendChild(hostEl)
                  ResizeObserver.observe(hostEl)
                  rAF kick → _settleAndDrain(paneId) [DEFERRED]
                  if focus: term.focus()
        _restoringLayout = false

        rebuild _panels from dv.panels
        prune dead panels (panes that died while away)
        add alive panes not in saved layout

      activePaneId = _activePaneIdFromSavedLayout()  ← reads activeGroup+activeView from JSON
      IF activePaneId found:
        panel.api.setActive()          ← inside _settingActive=true
        dispatch pane-select(correctId) → store.setActivePane(correctId)
                                           _activePaneId = correctId
                                           _notify() → _version++ → schedules 2nd Lit render
        schedule double-rAF:
          rAF1 → rAF2 → panel.api.setActive() + terminalRegistry.focus(correctId)

      _settingActive = false
      _removingPanels = false

[2nd Lit render: activePaneId = correctId → Case 3 in mux-dock → setActive(correctPane)]
```

---

## Phase 3 — Replay Arrives (CRITICAL RACE WINDOW)

```
[WS binary frames arrive — these are macrotasks, run AFTER the microtask Lit update]

For each replay frame:
  ws.onmessage (binary)
            ──────────────► onPaneOutput(paneId, data)
                             ──────────────────────────────────► _routePaneOutput(paneId, data)
                                                                 write(paneId, data)
                                                                   seqBytes += data.length
                                                                   IF entry.ready:
                                                                     term.write(data)  ← DIRECT, onData NOT suppressed!
                                                                   ELSE:
                                                                     pendingData.push(data) ← SAFE
```

---

## Phase 4 — Terminal Settles → Replay Drains

```
[rAF fires — from attach()'s kick or ResizeObserver's debounce+rAF]

_settleAndDrain(paneId):
  opened? YES
  ready? NO → continue
  isVisible? check
  offsetWidth/Height plausible (>= 120x60)?
    NO → return (wait for ResizeObserver)
    YES → fitAddon.fit()

  pending = entry.pendingData.splice(0)

  IF pending.length === 0:
!! RACE !! → entry.ready = TRUE immediately ← if replay hasn't arrived yet,
                                               ready=true BEFORE replay data,
                                               then replay flows through write() directly
                                               with onData unsuppressed → GARBLE
    return

  IF pending.length > 0:  ← ONLY if replay arrived before this rAF
    remaining = pending.length
    onWriteDone = () => {
      if (--remaining !== 0) return
      entry.ready = TRUE        ← set AFTER all chunks processed
      drain any new pendingData
    }
    for each chunk: term.write(chunk, onWriteDone)

    [xterm.js processes chunks in ITS OWN next rAF]
    During processing: encounters readline capability queries in replay
    xterm fires onData("ESC[2;2R", "ESC P 1$r2 q ESC\", etc.)
    onData gate: entry.ready = false → SUPPRESSED ✓
    onWriteDone fires after last chunk → entry.ready = true
```

---

## The Two Known Bugs

### Bug 1: Garble (Race in _settleAndDrain)

**Trigger**: Terminal settles (plausible size, fonts ready) BEFORE replay data arrives.

**Race window**:
```
T+0ms:  composition arrives → ensure() → attach() → rAF kick scheduled
T+1ms:  rAF fires → _settleAndDrain → pending.length=0 → ready=TRUE
T+2ms:  replay frame arrives → write() → ready=true → term.write(data) directly
T+rAF:  xterm processes replay → onData fires → NOT suppressed → to PTY → GARBLE
```

**Why the ready-gate fix doesn't help**: The fix gates onData on `entry.ready`, but
if `ready=true` before replay arrives, the gate is open when it matters most.

**Suspected trigger conditions**: A saved layout (fromJSON path) gives dockview
correct panel sizes immediately. The rAF kick fires and finds a plausible-sized
container → drains empty pending → ready=true. Replay arrives after.

### Bug 2: Active Pane Not Restored

**Trigger**: `store.applySessiond(composition)` always sets `_activePaneId = panes[0].paneId`.

**Sequence**:
```
1. Composition → store._activePaneId = panes[0]  (WRONG if panes[1] was active)
2. Lit render → mux-dock receives activePaneId=panes[0]
3. mux-dock.Case1 → fromJSON restores layout → _activePaneIdFromSavedLayout() → correctId
4. dispatch pane-select(correctId) → store.setActivePane(correctId) → _activePaneId=correctId
5. 2nd Lit render → mux-dock receives activePaneId=correctId
6. BUT: double-rAF re-assert races with terminal attach focus storm
```

**Potential failure**: If `_activePaneIdFromSavedLayout()` fails to parse the layout
JSON (e.g., dockview's `activeGroup` field not present or grid structure mismatch),
it returns `undefined`, and the dock falls through to `dv.activePanel?.id`, which
is whatever dockview picked — likely the first panel.

---

## What the Logs Will Tell Us

Search browser console for `[mux:*]` entries:

| Log tag | What it shows |
|---------|---------------|
| `[mux:registry ensure]` | When Terminal created, entry state |
| `[mux:registry anchor]` | seqBase/seqBytes at anchor time |
| `[mux:registry attach]` | When term.open() called, focus flag |
| `[mux:registry settle]` | pending.length at settle time — KEY for race |
| `[mux:registry write]` | Each write: direct vs pending |
| `[mux:registry onData]` | Each onData: suppressed or forwarded |
| `[mux:registry ready]` | When entry.ready transitions to true |
| `[mux:dock case1]` | workspaceKey changed handler |
| `[mux:dock restore]` | fromJSON result + activePaneId extracted |
| `[mux:dock case3]` | activePaneId changed handler |
| `[mux:app composition]` | msg.panes[].seq values, paneIds |
| `[mux:state active]` | activePaneId at each set |
| `[mux:renderer layout]` | TerminalRenderer.layout() isConnected state |
