# muxterm — Formal Architecture Design Document

**Status:** Authoritative specification. No code should be written or modified without reference to this document.  
**Scope:** All stateful components, every event crossing a boundary, all FSMs, all identified race conditions.  
**Audience:** Implementors. This document assumes familiarity with the codebase but is complete enough that a new engineer could re-implement from it.

---

## 1. System Components & Ownership

Each row defines a component's **authoritative state**, the events it **produces**, and the events it **consumes**. Implementation details (class names, file paths) are noted only to anchor the contract to the current code.

| Component | Authoritative State | Events Produced | Events Consumed |
|---|---|---|---|
| **Server / Registry** (`server.go`, `registry.go`) | Workspace set (IDs, names, pane counts, layouts); per-workspace pane set (IDs, PTY handles, dimensions, titles) | `composition`, `pane-added`, `pane-closed`, `workspace-created`, `workspace-list`, `workspace-closed`, `pane-renamed`, `ok`, `error` | `attach`, `create-pane`, `resize`, `create-workspace`, `list-workspaces`, `rename-workspace`, `close-workspace`, `rename-pane`, `save-layout`, binary pane-input frames |
| **Pane / PTY** (`pane.go`) | PTY process (alive/dead); terminal dimensions (cols, rows); title | Binary pane-output data (via `onData` callback); pane-exit signal (via `onExit` callback) | Binary input (Write); resize command (Resize); close (Close) |
| **PaneBuffer** (`buffer.go` — `RawBuffer` / `VTBuffer`) | Retained scrollback bytes (ring or cell grid); total bytes-ever-written (`seq`) | None | `Write(p)`, `Resize(cols, rows)` |
| **Subscriber** (`subscriber.go`) | Bounded outbound queue (cap 256); closed/open state | None (drains queue to socket) | `enqueueControl(msg)`, `enqueuePaneData(paneID, data)` |
| **MuxSocket** (`ws.ts`) | Active WebSocket; reconnect attempt counter; intentional-close flag | `onDisconnect`, `onReconnect`, `onSessiondMessage(msg)`, `onPaneOutput(paneId, data)`, `onControlMessage(msg)` | `connect()`, `disconnect()`, all outbound senders (`attach`, `createPane`, `resize`, etc.) |
| **MuxStore** (`state.ts`) | Authoritative wire state: `_workspaces[]`, `_attached`, `_panes[]`, `_activePaneId`, `_layout`; pending optimistic mutation map; config | Store-change notification (subscriber callbacks) | `applySessiond(msg)`, `mutate(spec)`, `setActivePane(id)`, `setConfig(cfg)` |
| **WorkspaceController** (`workspace-controller.ts`) | MRU workspace order; `_recoveringFrom` (null / '' / staleId); `_attachInFlight` flag | Socket commands: `attachWithBreakpoint`, `createWorkspace`, `listWorkspaces`, `resize` | `bootstrap()`, `onMessage(msg)` (all server events), `reportResize(paneId, cols, rows)` |
| **TerminalRegistry** (`terminal-registry.ts`) | Per-pane `PaneEntry` map keyed `"wsId:paneId"`; pre-ensure buffer; `_currentWorkspaceId` | `onData` callbacks (keystroke forwarding); `onResize` callbacks | `ensure`, `attach`, `detach`, `write`, `setSeqAnchor`, `getOffsets`, `prune`, `setWorkspace`, `_settleAndDrain`, `fitIfVisible` |
| **MuxDock / TerminalRenderer** (`mux-dock.ts`) | Dockview panel map; `_locallyClosedPanes` set; `_nextPlacement`; per-renderer `_attached` flag | `pane-select`, `pane-close`, `pane-create`, `pane-rename`, `layout-save` (DOM custom events) | Lit property changes (`panes`, `activePaneId`, `workspaceKey`, `layout`); dockview lifecycle callbacks (`init`, `layout`, `dispose`, `onDidRemovePanel`, `onDidActivePanelChange`) |
| **MuxApp** (`app.ts`) | Connection status; overlay visibility flags; create-workspace modal state | `_createPaneOptimistic` (internal); all socket sends; all store mutations | Socket callbacks; store subscriber; DOM events from child components |

---

## 2. Event Taxonomy

### 2.1 Server → Browser (JSON control frames)

| Event | Source Component | Destination | Payload | Ordering Guarantee |
|---|---|---|---|---|
| `composition` | Server (`attachConn`) | Attached conn only | `workspaceId`, `panes[]` (with `seq` anchors), `layout`, `cid` | **FIRST** in subscriber queue after attach; always precedes replay and live data for same attach |
| `pane-added` | Server (`createPane`) | All workspace subscribers (broadcast) | `paneId`, `cols`, `rows`, `clientRef`, `workspaceId` | Arrives after `pane-created` to the actor; ordering relative to live PTY data for that pane is NOT guaranteed |
| `pane-closed` | Server (`handlePaneExit`) | All workspace subscribers (broadcast) | `paneId`, `workspaceId` | Arrives after all prior PTY output for that pane has been enqueued (PTY read loop exits before `onExit` fires) |
| `workspace-created` | Server | Actor conn + `broadcastAll` | `workspaceId`, `name`, `clientRef`, `cid` | No cross-event ordering guarantee relative to `workspace-list` |
| `workspace-list` | Server | Requester or `broadcastAll` | `workspaces[]` | Reflects state at time of send; may arrive while an attach is in-flight |
| `workspace-closed` | Server | `broadcastAll` (⚠ NOT `broadcast` to workspace subs — missing in current code) | `workspaceId` | Sent after workspace removed from registry |
| `pane-renamed` | Server | All workspace subscribers | `paneId`, `name` | No special ordering guarantee |
| `pane-created` | Server | Actor conn only | `paneId`, `cid` | Sent before `pane-added` broadcast |
| `ok` | Server | Actor conn only | `cid` | Ack of rename/layout-save/close |
| `error` | Server | Actor conn only | `code`, `error`, `workspaceId`, `cid` | Ack failure |

> **⚠ Protocol gap:** `workspace-closed` is sent via `broadcastAll` but the `WorkspaceController.onMessage` handler listens for `TypeWorkspaceClosed`. The current server code does NOT emit `TypeWorkspaceClosed` — it emits only `TypeWorkspaceList` on `closeWorkspace`. The `WorkspaceClosed` branch in the controller is dead code.

### 2.2 Server → Browser (Binary pane-data frames)

| Frame | Source | Destination | Payload | Ordering Guarantee |
|---|---|---|---|---|
| Replay frame | Server (`attachConn`, `enqueuePaneData`) | Attached conn | `[4-byte LE paneId][VT bytes]` | **Enqueued after composition** in subscriber queue; strictly before any live data for same pane on same attach |
| Live frame | Server (`broadcastPaneData`) | All workspace subscribers | `[4-byte LE paneId][VT bytes]` | Strictly after conn is marked live (`set[c] = true` in `attachConn`) |

> **Ordering invariant (server-side):** Under `s.mu`, `attachConn` enqueues composition, then replay frames, then marks the conn live. Subsequent `broadcastPaneData` calls acquire `s.mu` and find the conn already in the subscriber set. Therefore: `composition → replay → live` is total-ordered within a single subscriber queue.  
> **This ordering guarantee does NOT survive network delivery.** It is preserved only within the bounded channel (`chan outFrame, cap=256`). If the subscriber's queue overflows, the conn is disconnected — not degraded.

### 2.3 Browser → Server (JSON control frames)

| Message | Trigger | Payload |
|---|---|---|
| `attach` | `bootstrap()`, `_onWorkspaceSelected`, recovery | `workspaceId`, `breakpoint`, `offsets[]` |
| `create-pane` | `_createPaneOptimistic` | `clientRef`, optional `cmd` |
| `resize` | ResizeObserver → `reportResize` | `paneId`, `cols`, `rows` |
| `create-workspace` | `_submitCreate`, recovery (no survivors) | `name`, optional `clientRef` |
| `list-workspaces` | `bootstrap()` (no localStorage), recovery | — |
| `rename-workspace` | `_onWorkspaceRename` | `workspaceId`, `name` |
| `close-workspace` | `_onWorkspaceClose` | `workspaceId` |
| `rename-pane` | `_onPaneRename` | `paneId`, `name` |
| `save-layout` | `_onLayoutSave` (debounced 400ms) | `workspaceId`, `breakpoint`, `layout` (JSON blob) |
| **`close-pane`** | **⚠ MISSING — does not exist in protocol** | **Would be: `paneId`** |

### 2.4 Browser → Server (Binary pane-input frames)

| Frame | Trigger | Payload |
|---|---|---|
| Pane input | `term.onData` (gated on `entry.ready`) | `[4-byte LE paneId][UTF-8 bytes or binary mouse]` |

### 2.5 Internal Browser Events (Lit property changes, custom DOM events)

| Event | Source | Destination | Payload | Notes |
|---|---|---|---|---|
| `pane-select` | `mux-dock` (`onDidActivePanelChange`, Case 1 restore) | `mux-app` | `{ paneId }` | Fires on user tab click AND on programmatic setActive during restore; `_settingActive` guard suppresses during programmatic sets |
| `pane-close` | `mux-dock` (`onDidRemovePanel`) | `mux-app` | `{ paneId }` | Only fires when `_removingPanels=false` (user-initiated); suppressed during programmatic removals |
| `pane-create` | `mux-dock` (`_requestPane`) | `mux-app` | — | Fires when `+` or split button clicked; placement intent stored before dispatch |
| `pane-rename` | `mux-dock` (`_onTabDblClick` finish) | `mux-app` | `{ paneId, name }` | |
| `layout-save` | `mux-dock` (`_scheduleLayoutSave`, debounced 400ms) | `mux-app` | `{ layout }` | Suppressed during `_restoringLayout`; suppressed in narrow mode |
| `open-launcher` | `mux-app` keybinding | `mux-app` | — | |
| Store notify | `MuxStore._notify()` | `mux-app` subscriber | — | Bumps `_version` → Lit re-render |

### 2.6 Async Triggers

| Trigger | Source | Destination | Timing | Notes |
|---|---|---|---|---|
| `ResizeObserver` | Browser (hostEl size change) | `terminal-registry` → `_settleAndDrain` or `fitIfVisible` | Fires on DOM connection/disconnection and genuine resize; 50ms debounce + rAF | Also fires when hostEl is removed from DOM (zero-size change) — generates spurious debounce timers |
| `requestAnimationFrame` kick | `attach()` | `terminal-registry._settleAndDrain` | One frame after `attach()` call | Defensive kick in case ResizeObserver's initial callback is delayed |
| `requestAnimationFrame` — settle drain | ResizeObserver callback | `terminal-registry._settleAndDrain` | 50ms after RO fires, then one rAF | |
| `requestAnimationFrame` — layout restore | `mux-dock` Case 1 | `mux-dock` (double-rAF active pane re-assert) | Two frames after Case 1 runs | Re-asserts active panel after focus-storm from terminal attaches |
| `xterm.js write callback` | `term.write(chunk, cb)` | `terminal-registry._settleAndDrain.onWriteDone` | One xterm.js rAF after write queued | Controls when `ready=true` is set; xterm processes writes in its own animation frame loop |
| `setTimeout` — mutation timeout | `MuxStore.mutate` | `MuxStore._onMutationTimeout` | 5000ms (default) after `mutate()` call | Marks mutation errored if not settled; triggers user-visible error banner |
| `setTimeout` — layout save debounce | `mux-dock._scheduleLayoutSave` | `mux-dock` | 400ms after last layout change | |
| `setTimeout` — resize debounce | `terminal-registry.attach` ResizeObserver | `terminal-registry._settleAndDrain` | 50ms after last RO callback | |
| `setTimeout` — reconnect backoff | `MuxSocket._scheduleReconnect` | `MuxSocket._open` | `min(1000 * 2^n, 30000) + rand(0, 500)` ms | |
| `document.fonts.ready` | Font Loading API | `terminal-registry._settleAndDrain` | One rAF after fonts loaded | Retry path only; `_settleAndDrain` reschedules itself |

---

## 3. FSM — Connection State

This FSM covers `MuxSocket`. The `_connectionStatus` field in `MuxApp` is polled via `requestAnimationFrame` and is a lagging reflection of this FSM, not the FSM itself.

```
STATE: INITIAL
  [Entry condition: MuxSocket constructed, connect() not yet called]
  on connect()        → _open(), _intentionalClose=false, _reconnectAttempts=0  → CONNECTING
  on disconnect()     → no-op                                                    → INITIAL

STATE: CONNECTING
  [Entry: WebSocket constructor called, waiting for open/close/error]
  on ws.onopen        → _reconnectAttempts=0, fire onReconnect()                → CONNECTED
  on ws.onclose (code=1000 OR _intentionalClose=true) → no-op                  → INTENTIONALLY_CLOSED
  on ws.onclose (other) → fire onDisconnect(), _scheduleReconnect()             → RECONNECTING
  on ws.onerror       → no-op (onclose always follows onerror)                  → (stays until onclose)
  on disconnect()     → _intentionalClose=true, clearTimeout, ws.close()        → INTENTIONALLY_CLOSED

STATE: CONNECTED
  [Entry: ws.onopen fired, onReconnect() called → bootstrap() → attach sent]
  on message (binary) → fire onPaneOutput(paneId, data)                         → CONNECTED
  on message (JSON, type present) → fire onSessiondMessage(msg)                 → CONNECTED
  on message (JSON, no type) → fire onControlMessage(msg)                       → CONNECTED
  on ws.onclose (code=1000 OR _intentionalClose=true) → no-op                  → INTENTIONALLY_CLOSED
  on ws.onclose (other) → fire onDisconnect(), _scheduleReconnect()             → RECONNECTING
  on disconnect()     → _intentionalClose=true, clearTimeout, ws.close(), ws=null → INTENTIONALLY_CLOSED

STATE: RECONNECTING
  [Entry: unintentional close detected; backoff timer running]
  on backoff timer fires → _open() called                                        → CONNECTING
  on disconnect()     → _intentionalClose=true, clearTimeout(backoff)            → INTENTIONALLY_CLOSED

STATE: INTENTIONALLY_CLOSED
  [Terminal state for this socket instance. Create a new MuxSocket to reconnect.]
  No outbound events.
  No recovery path within this instance.
```

**Missing terminal state:** There is no FAILED state. Reconnect attempts are infinite with no maximum retry count. This is intentional per the current design — the overlay remains visible until connection succeeds. If the server is permanently gone, the browser is stuck in RECONNECTING forever.

**Invariant violation:** `onReconnect` is called on every `ws.onopen`, including reconnects. The first call fires `bootstrap()`. Subsequent calls also fire `bootstrap()`. This is correct: each reconnect requires re-attaching because the server is stateless about which workspace each connection had. However, if a reconnect fires while a prior `bootstrap()` attach is still in-flight... the `_attachInFlight` guard in `WorkspaceController` prevents the second composition from triggering a redundant attach. See FSM §5 for detail.

---

## 4. FSM — Pane Lifecycle (Browser Client)

This is the most critical FSM. A pane instance in the browser progresses through distinct states; each state defines which events are valid, which must be deferred, and which must be dropped. The client currently has NO explicit state machine — behavior is scattered across closures and boolean flags. This FSM defines what the correct behavior should be.

The key flags that approximate state in the current code:
- `PaneEntry.opened` (bool): `term.open()` has been called
- `PaneEntry.ready` (bool): xterm has processed all replay; input can be forwarded
- `MuxStore._panes[]`: presence in wire state
- `MuxStore._pending[]`: pending optimistic create-pane mutations
- `MuxDock._locallyClosedPanes`: panes closed by user in current workspace session

### Pane States

```
STATE: NONEXISTENT
  [No PaneEntry in registry; not in store._panes; no optimistic mutation]
  VALID:
    on create-pane-optimistic(tempId, clientRef) →
        push temp PaneInfo(paneId=tempId<0, clientRef) to store (optimistic overlay)
        send create-pane(clientRef) to server
        → OPTIMISTIC
    on composition-arrives (paneId in composition) →
        ensure(paneId), setSeqAnchor(paneId, seq)
        → REGISTRY_PENDING
    on pane-added(paneId, clientRef=null) →
        store.applySessiond → pane in store
        (if clientRef known: settles optimistic mutation)
        ensure(paneId, handlers)
        → REGISTRY_PENDING
  INVALID:
    on binary data for this paneId → buffered in pre-ensure buffer (see INV-4)
    on close-pane(paneId) → programming error: cannot close nonexistent pane
    on pane-closed(paneId) → ignore (idempotent)

STATE: OPTIMISTIC
  [Temp paneId < 0 in store overlay; PaneEntry NOT created (temp IDs skipped);
   create-pane request in-flight; mutation timer running (5s timeout)]
  VALID:
    on pane-added(realPaneId, clientRef=matchingRef) →
        store settles mutation (removes optimistic overlay, temp pane disappears)
        store.applySessiond(PaneAdded) → real pane in _panes
        ensure(realPaneId, handlers)
        setSeqAnchor(realPaneId, 0)  ← no seq in pane-added; anchor=0 → full replay risk
        mux-dock Case 2 fires → panel added to dockview
        → REGISTRY_PENDING
    on composition(contains realPaneId, clientRef=matchingRef) →
        mutation settles via settled() predicate
        ensure(realPaneId, handlers); setSeqAnchor(realPaneId, seq)
        → REGISTRY_PENDING
    on close-pane-click (user closes temp tab) →
        ⚠ CURRENTLY IMPOSSIBLE: temp panes (paneId < 0) are filtered from dock render
        IF it became possible: cancel mutation, send nothing (no real pane yet)
        → NONEXISTENT
    on mutation-timeout →
        mutation marked errored; overlay stays visible as error state
        user must dismiss or retry
        → (stays OPTIMISTIC with errored flag; user action required)
    on binary data for tempId → DROPPED (no entry; pre-ensure buffer keyed by tempId which is < 0)
    on pane-closed(tempId) → DROPPED (server never knows temp IDs)
  DEFERRED:
    on resize → do not send; no real paneId yet
  INVALID:
    on second create-pane-optimistic for same mutation → programming error

STATE: REGISTRY_PENDING
  [PaneEntry exists; opened=false; ready=false; pendingData accumulating;
   hostEl created but NOT in DOM; pane in store._panes]
  VALID:
    on binary data(paneId) →
        write(paneId, data) → data goes to pendingData (ready=false, not opened)
        seqBytes incremented
        → stays REGISTRY_PENDING
    on mux-dock Case 2 fires (pane in store.panes, panel not in dock) →
        dockview.addPanel(paneId) → TerminalRenderer created
        TerminalRenderer.init() → hasTerminal=true → pendingMount=false
        → DOM_ATTACHED (after layout() fires)
    on pane-closed(paneId) →
        store removes pane
        mux-dock Case 2 removes panel (no-op, panel not yet added) OR
        if panel was added: dockview.removePanel → dispose → detach → prune
        → CLOSED (terminal disposed, prune removes from registry)
    on close-pane-click →
        ⚠ CURRENTLY BROKEN: no close-pane message sent; PTY keeps running
        CORRECT BEHAVIOR: cancel pending mutation if any, send close-pane(paneId),
        → CLOSING (await pane-closed from server)
    on resize → DROPPED (terminal not open, no meaningful size)
    on workspace-switch →
        setWorkspace(newWsId) → _currentWorkspaceId changes
        prune(newWsLiveIds) → WS1 panes NOT pruned (preserved for scrollback)
        TerminalRenderer.dispose() called but looks up wrong key → no-op (BUG)
        → orphaned: entry remains in registry under old key; ResizeObserver never disconnected
  INVALID:
    on input(paneId) → programming error: input gated on ready, so impossible
    on second composition with same paneId → idempotent setSeqAnchor reset is valid

STATE: DOM_ATTACHED
  [TerminalRenderer.layout() fired with isConnected=true AND hasTerminal=true;
   term.open(hostEl) called; opened=true; ready=false;
   ResizeObserver installed; rAF settle kick queued]
  VALID:
    on binary data(paneId) →
        write() → pendingData.push() (ready=false, even though opened=true)
        seqBytes incremented
        → stays DOM_ATTACHED
    on ResizeObserver fires / rAF fires →
        _settleAndDrain(paneId) called
        IF opened AND visible AND plausibleSize AND fonts ready:
          → SETTLING
        ELSE: retry on next RO/rAF
    on pane-closed(paneId) →
        prune removes entry; ResizeObserver disconnected; term disposed
        dockview removes panel
        → CLOSED
    on close-pane-click →
        ⚠ CURRENTLY BROKEN: prune() called but no server message
        CORRECT: send close-pane(paneId) → wait for pane-closed → CLOSING
    on resize (ResizeObserver from DOM change) →
        _settleAndDrain checks size plausibility before fitting
        Degenerate sizes (<120px x <60px) → DROP (dockview settle transient)
    on detach(paneId) (workspace switch or tab switch) →
        ResizeObserver disconnected; hostEl removed from DOM parent
        ⚠ BUG: detach() looks up wrong key if workspace already switched
        → REGISTRY_PENDING (opened=true persists; pendingData preserved)
    on workspace-switch → see REGISTRY_PENDING workspace-switch entry (same issue)
  DEFERRED:
    on input → gated on ready=false; suppressed in onData handler
  INVALID:
    on second term.open() → programming error; opened is checked

STATE: SETTLING
  [_settleAndDrain called with pendingData.length > 0; spliced and handed to xterm;
   remaining write-callbacks counter > 0; ready=false]
  VALID:
    on binary data(paneId) →
        write() → pendingData.push() (ready=false; IMPORTANT: these arrive AFTER splice)
        seqBytes incremented
        → stays SETTLING (post-drain queue will be flushed in onWriteDone)
    on xterm write-callback fires (onWriteDone, remaining→0) →
        ready = true
        drain any data that arrived during settle (live bytes queued in pendingData)
        → READY
    on pane-closed(paneId) →
        ⚠ CURRENTLY BROKEN: prune() disposes term; in-flight write callbacks still
          reference `entry` via closure — they fire after dispose, set ready=true on dead entry
        CORRECT: cancel write callbacks (generation counter); dispose cleanly → CLOSED
    on close-pane-click →
        ⚠ CRITICAL BUG: prune() disposes terminal while writes in-flight
        Write callbacks fire → onWriteDone → ready=true on disposed terminal
        post-drain loop runs on disposed terminal
        CORRECT: mark entry CANCELLED (generation++); callbacks check generation → CLOSING
    on resize (RO fires) →
        ⚠ BUG: RO fires; debounce fires; rAF fires; _settleAndDrain called AGAIN
        _settleAndDrain checks entry.ready → false; calls pending.splice(0) → empty (already spliced)
        pending.length === 0 → ready=true immediately! (BUG B)
        This is a SECOND _settleAndDrain call racing the first's write callbacks.
        In single-threaded JS this CAN happen: RO fires during the 50ms settle window.
        CORRECT: guard _settleAndDrain with a "draining" boolean flag
    on workspace-switch →
        setWorkspace(newWsId) → subsequent _settleAndDrain uses wrong key
        ResizeObserver disconnected (detach called with wrong key → no-op → NOT disconnected)
        → orphaned settling (callbacks still fire but lookup wrong key after switch)
  DEFERRED:
    on input → still gated on ready=false
  INVALID:
    on second _settleAndDrain (concurrent) → currently possible; guarded only by ready check
      which does not cover the window between splice and callback completion

STATE: READY
  [ready=true; all writes direct; input forwarded; ResizeObserver active for fit-only]
  VALID:
    on binary data(paneId) →
        write() → term.write(data) direct
        seqBytes incremented
        → stays READY
    on input(paneId) →
        onData → entry.handlers.onInput → sendPaneInput → PTY
        → stays READY
    on ResizeObserver fires →
        fitIfVisible(paneId)
        if real size change: term.onResize → reportResize → socket.resize → server
        → stays READY
    on detach (tab switch / workspace switch) →
        ResizeObserver disconnected
        hostEl removed from DOM
        ⚠ BUG: if workspace switched, _key() wrong → detach no-op → RO not disconnected
        → (opened=true, ready=true, pendingData=[], RO possibly zombied)
    on re-attach (tab switch back) →
        container.appendChild(hostEl) → re-parents
        new ResizeObserver installed
        rAF → fitIfVisible (ready=true so no settle)
        → READY
    on pane-closed(paneId) →
        store removes pane → mux-dock Case 2 removes panel → dispose → detach
        prune() → term.dispose() → CLOSED
    on close-pane-click →
        ⚠ CURRENTLY BROKEN: prune() called; no server message
        CORRECT: send close-pane(paneId) → CLOSING
    on second composition for same pane (workspace re-attach) →
        setSeqAnchor(paneId, newSeq) resets offset tracking
        ready is NOT reset → subsequent replay writes go direct (BUG if replay expected)
        CORRECT: reset ready=false, pendingData=[], reseed settle sequence
  INVALID:
    on term.open() → programming error; opened already true

STATE: CLOSING
  [close-pane sent to server; awaiting pane-closed broadcast]
  [⚠ THIS STATE DOES NOT EXIST IN CURRENT CODE — must be added]
  VALID:
    on pane-closed(paneId) →
        prune(); term.dispose()
        mux-dock panel already removed (user-initiated close removed it)
        → CLOSED
    on binary data(paneId) → DROPPED (terminal already removed from dock)
    on pane-added(paneId) → DROPPED (server is closing this pane; ignore race)
    on input → DROPPED (terminal removed from dock)
    on resize → DROPPED
  TIMEOUT:
    If pane-closed not received within N ms → assume server-side close; CLOSED

STATE: CLOSED
  [Terminal disposed; no registry entry; not in store._panes (or about to be removed)]
  No valid events. Pane is done. New pane creation starts at NONEXISTENT.
```

### Concurrent Scenario Matrix (Pane FSM)

| Scenario | Current State | Concurrent Event | Current Behavior | Required Behavior |
|---|---|---|---|---|
| close arrives while OPTIMISTIC | OPTIMISTIC | pane-close click | Impossible (negative IDs hidden from dock) | Mutation cancel + NONEXISTENT |
| close arrives while SETTLING | SETTLING | pane-close click | prune() disposes term; write callbacks fire on dead entry; ready=true on ghost | CANCELLED state; write callbacks check generation; clean dispose |
| pane-added after user closed | CLOSED | pane-added(paneId) | `_locallyClosedPanes.has(paneId)` guards re-add. BUT `_syncTerminals()` still calls `ensure(paneId)` re-creating registry entry | Drop entirely; no re-ensure; proper server-side close prevents this |
| second composition while SETTLING | SETTLING | composition (re-attach) | setSeqAnchor resets offset; ready still false; ongoing drain unaffected | Generation counter: increment → ongoing callbacks check generation → drop if stale |
| resize arrives before REGISTRY_PENDING→DOM_ATTACHED | REGISTRY_PENDING | ResizeObserver | Not installed yet; no-op | No-op is correct |
| workspace switch while SETTLING | SETTLING | workspace-switch | _currentWorkspaceId changes; subsequent key lookups miss entry; RO not disconnected | TerminalRenderer must store its workspaceId at creation; pass to detach() |
| workspace switch while DOM_ATTACHED | DOM_ATTACHED | workspace-switch | Same key-mismatch bug; RO not disconnected; settle rAF fires → wrong key → no-op | Same fix |
| resize arrives before term opened | DOM_ATTACHED→SETTLING | RO fires with degenerate size | `_fitIfPlausible` returns false; settle deferred → correct | Correct |
| second _settleAndDrain while SETTLING | SETTLING | RO fires (50ms debounce + rAF) | Splice returns empty; `pending.length===0` → ready=true immediately; write callbacks from first call fire later on dead ready state | `draining` boolean flag; skip if already draining |

---

## 5. FSM — Bootstrap Sequence (WorkspaceController)

```
STATE: IDLE
  [Entry: WorkspaceController constructed; bootstrap() not yet called]
  on bootstrap() with localStorage hit →
      _attachInFlight = true
      socket.attachWithBreakpoint(storedId, breakpoint, registry.getOffsets())
      → DIRECT_ATTACH
  on bootstrap() without localStorage →
      _recoveringFrom = ''
      socket.listWorkspaces()
      → LISTING

STATE: DIRECT_ATTACH
  [attach sent for stored workspace; _attachInFlight=true; awaiting composition]
  on composition(workspaceId) →
      _attachInFlight = false
      _mru.touch(workspaceId)
      localStorage.setItem(LAST_WS_KEY, workspaceId)
      → ATTACHED
  on error(UnknownWorkspace, workspaceId=storedId) →
      localStorage.removeItem(LAST_WS_KEY)
      _recoveringFrom = storedId
      socket.listWorkspaces()
      → RECOVERING
  on workspace-list arrives WHILE in DIRECT_ATTACH →
      ⚠ SERVER PUSHES workspace-list ON EVERY CONNECTION (attachClient behavior)
      Guard: `_attachInFlight=true` → skip second-attach branch
      → stays DIRECT_ATTACH (list is ignored; composition is awaited)
  on workspace-created → attach(newId) [see ⚠ below]
  on workspace-closed → recover if our workspace closed

STATE: LISTING
  [listWorkspaces sent; _recoveringFrom=''; awaiting workspace-list]
  on workspace-list(workspaces=[]) →
      target.action === 'create'
      socket.createWorkspace()
      → CREATING_DEFAULT
  on workspace-list(workspaces=[...]) →
      target = chooseRecoveryTarget(workspaces, '', mru.order())
      _recoveringFrom = null
      socket.attachWithBreakpoint(target.workspaceId, ...)
      → DIRECT_ATTACH (reuses state semantics)

STATE: RECOVERING
  [Recovery initiated: prior workspace invalid or closed; listWorkspaces sent]
  on workspace-list(workspaces=[]) →
      socket.createWorkspace()
      → CREATING_DEFAULT
  on workspace-list(workspaces=[...]) →
      target = chooseRecoveryTarget(workspaces, _recoveringFrom, mru.order())
      _recoveringFrom = null
      socket.attachWithBreakpoint(target.workspaceId, ...)
      → DIRECT_ATTACH

STATE: CREATING_DEFAULT
  [No workspaces found; createWorkspace() sent; awaiting workspace-created]
  on workspace-created(workspaceId) →
      socket.attachWithBreakpoint(workspaceId, ...)
      → DIRECT_ATTACH
  ⚠ BUG: workspace-created fires for ALL workspace creations (user-initiated too).
    The controller unconditionally attaches on every workspace-created message.
    If a user creates a workspace while in ATTACHED state, they are forced to switch.
    This is currently "acceptable" UX but violates the principle of least surprise.

STATE: ATTACHED
  [Composition received; workspace active; steady state]
  on workspace-closed(id=attached) OR error(UnknownWorkspace, id=attached) →
      _recoveringFrom = id
      socket.listWorkspaces()
      → RECOVERING
  on workspace-created →
      ⚠ ALWAYS attaches — see CREATING_DEFAULT note
      socket.attachWithBreakpoint(newId, ...)
      → DIRECT_ATTACH (overrides current attachment without user intent)
  on workspace-list (server-pushed, !_attachInFlight, store.attached !== null) →
      → ignored (guard: attached is not null)
  on bootstrap() (reconnect) →
      Re-enters from IDLE; _attachInFlight=true
      → DIRECT_ATTACH

STATE (implicit): FATAL
  [Not modeled. Exists when server is unreachable; WS in RECONNECTING.
   WorkspaceController is in whatever state it was when the disconnect happened.
   On reconnect, bootstrap() is called again from IDLE semantics.]
```

**Bootstrap path summary:**

| Condition | Path |
|---|---|
| Fresh load, workspaces exist | bootstrap() → LISTING → workspace-list → DIRECT_ATTACH → composition → ATTACHED |
| Fresh load, no workspaces | bootstrap() → LISTING → workspace-list(empty) → CREATING_DEFAULT → workspace-created → DIRECT_ATTACH → composition → ATTACHED |
| Known workspace (localStorage) | bootstrap() → DIRECT_ATTACH → composition → ATTACHED |
| Known workspace deleted | bootstrap() → DIRECT_ATTACH → error(UnknownWorkspace) → RECOVERING → workspace-list → DIRECT_ATTACH → composition → ATTACHED |
| Workspace-list arrives during DIRECT_ATTACH | workspace-list ignored (_attachInFlight guard) → DIRECT_ATTACH stays |
| Server pushes workspace-list on new connection | Same guard; correctly suppressed while attach in flight |

---

## 6. Sequence Diagrams — Concurrent Scenarios

### Scenario A: Normal Refresh With Saved Layout

```
Browser            WS/app.ts          WorkspaceCtrl       TerminalRegistry    MuxDock           xterm.js
  |                    |                    |                    |                |                 |
  | page load          |                    |                    |                |                 |
  |─── connectedCallback ──────────────────►|                    |                |                 |
  |                    |                    |                    |                |                 |
  | MuxSocket.connect()|                    |                    |                |                 |
  |─── WS open ────────►                    |                    |                |                 |
  |◄── onopen ─────────|                    |                    |                |                 |
  |                    |── onReconnect() ───►                    |                |                 |
  |                    |                    |── bootstrap() ─────►                |                 |
  |                    |                    |   localStorage hit                  |                 |
  |                    |                    |   _attachInFlight=true              |                 |
  |                    |◄─ attachWithBreakpoint(wsId, 'wide', offsets=[]) ────────|                 |
  |                    |── WS send {attach} ►                    |                |                 |
  |                    |                    |                    |                |                 |
  |     [server-side: under s.mu, atomically]                    |                |                 |
  |     [1. build paneInfos with seq anchors]                    |                |                 |
  |     [2. enqueue composition]                                 |                |                 |
  |     [3. enqueue replay frames for each pane]                 |                |                 |
  |     [4. mark conn live]                                      |                |                 |
  |                    |                    |                    |                |                 |
  |◄── JSON: composition({wsId, panes:[{p1,seq=N},{p2,seq=M}], layout}) ─────────|                 |
  |                    |                    |                    |                |                 |
  |  onSessiondMessage fires SYNCHRONOUSLY:                      |                |                 |
  |  store.applySessiond(Composition)       |                    |                |                 |
  |    _attached=wsId, _panes=[p1,p2]       |                    |                |                 |
  |    _activePaneId = panes[0].paneId ◄─── BUG: clobbers saved layout active pane               |
  |    _notify() → Lit schedules render microtask                |                |                 |
  |  controller.onMessage(Composition)      |                    |                |                 |
  |    _attachInFlight=false, MRU updated   |                    |                |                 |
  |  [Composition handler in app.ts]        |                    |                |                 |
  |────────────────────────────────── setWorkspace(wsId) ────────►                |                 |
  |────────────────────────────────── ensure(p1, handlers) ──────►                |                 |
  |                                         |    PaneEntry created, opened=false  |                 |
  |────────────────────────────────── setSeqAnchor(p1, N) ───────►                |                 |
  |                                         |    seqBase=N, seqBytes=0            |                 |
  |────────────────────────────────── ensure(p2, handlers) ──────►                |                 |
  |────────────────────────────────── setSeqAnchor(p2, M) ───────►                |                 |
  |                    |                    |                    |                |                 |
  |  ⚠ ORDERING NOT GUARANTEED FROM THIS POINT:                  |                |                 |
  |  The following two sequences can interleave at the task level:|                |                 |
  |  (A) Replay frames arrive (same WS message pump, sequential) |                |                 |
  |  (B) Lit microtask fires (scheduled by _notify())            |                |                 |
  |  In practice (A) runs first because WS message pump is sync  |                |                 |
  |  and the Lit microtask yields. But this is NOT guaranteed.   |                |                 |
  |                    |                    |                    |                |                 |
  |◄─ binary: [p1 replay bytes, ~N total] ──────────────────────►                |                 |
  |─── onPaneOutput(p1, data) → write(p1, data) ─────────────────►                |                 |
  |                                         |    ready=false → pendingData.push() |                 |
  |                                         |    seqBytes += len(data)            |                 |
  |◄─ binary: [p2 replay bytes, ~M total] (may be multiple frames)               |                 |
  |─── onPaneOutput(p2, data) → write(p2, data) ─────────────────►                |                 |
  |                                         |    pendingData.push()               |                 |
  |                    |                    |                    |                |                 |
  |  [Lit microtask fires]                  |                    |                |                 |
  |  willUpdate() → _syncTerminals():       |                    |                |                 |
  |    setWorkspace(wsId) [idempotent]      |                    |                |                 |
  |    ensure(p1, handlers) [idempotent — updates handlers only] |                |                 |
  |    ensure(p2, handlers) [idempotent]    |                    |                |                 |
  |    prune({p1,p2}) [nothing to prune]    |                    |                |                 |
  |  render() → <mux-dock workspaceKey=wsId panes=[p1,p2]       |                |                 |
  |    activePaneId=p1 layout=savedLayout>  |                    |                |                 |
  |                    |                    |                    | updated() Case 1:               |
  |                    |                    |                    | workspaceKey changed            |
  |                    |                    |                    | _removingPanels=true            |
  |                    |                    |                    | fromJSON(savedLayout)           |
  |                    |                    |                    |  init(p1): hasTerminal=true     |
  |                    |                    |                    |  layout(p1): isConnected=false → skip
  |                    |                    |                    |  init(p2): hasTerminal=true     |
  |                    |                    |                    |  layout(p2): isConnected=false → skip
  |                    |                    |                    |  [dockview appends panels to DOM]|
  |                    |                    |                    |  layout(p1): isConnected=true ✓ |
  |                    |                    |                    |   attach(p1, el, focus=savedActive==p1)
  |                    |                    |                    |    term.open(hostEl) → opened=true
  |                    |                    |                    |    ResizeObserver.observe()     |
  |                    |                    |                    |    rAF → _settleAndDrain(p1)   |
  |                    |                    |                    |  layout(p2): isConnected=?      |
  |                    |                    |                    |  ⚠ BUG C: only active panel     |
  |                    |                    |                    |    gets 2nd layout() call after |
  |                    |                    |                    |    DOM append; inactive panels   |
  |                    |                    |                    |    stay opened=false forever    |
  |                    |                    |                    | _activePaneIdFromSavedLayout()  |
  |                    |                    |                    | setActive(savedActivePaneId)    |
  |                    |                    |                    | dispatch pane-select(savedId)   |
  |                    |                    |                    | double-rAF → setActive+focus   |
  |                    |                    |                    |                |                 |
  |  [rAF fires]       |                    |                    |                |                 |
  |  _settleAndDrain(p1):                   |                    |                |                 |
  |    opened=true ✓, visible ✓, plausibleSize ✓, fonts ✓       |                |                 |
  |    pending = splice(pendingData)        |                    |                |                 |
  |    IF pending.length > 0: (normal path) |                    |                |                 |
  |      for each chunk: term.write(chunk, onWriteDone)          |                |─── write(chunk) ►|
  |    IF pending.length === 0: ◄── BUG B: immediate ready=true  |                |                 |
  |      replay in-transit → goes direct → CPR/DA1 forwarded     |                |                 |
  |                    |                    |                    |                |  [xterm rAF]    |
  |                    |                    |                    |                |  processWrites()|
  |                    |                    |                    |                |  onWriteDone()  |
  |                    |                    |                    | remaining→0 → ready=true        |
  |                    |                    |                    | drain live-queue (empty)        |
  |◄─── live PTY data ─────────────────────►─── write(p1,data) ──► ready=true → term.write() ───►|
```

**Points where ordering is NOT guaranteed:**
1. Between replay frame arrival and Lit microtask — can interleave
2. Between multiple pane replay frames — ordered within the subscriber queue but the WS framing means each binary message is processed synchronously, maintaining order
3. Between the rAF settle kick and replay frame arrival — **this is BUG B's window**
4. `layout()` calls on inactive panels (BUG C) — dockview does not guarantee calling `layout()` on all panels after DOM attachment

---

### Scenario B: Close Pane During Settle

User clicks the "×" tab button while P1 is in SETTLING state (replay in pendingData, xterm write callbacks in-flight).

```
Browser (user)     MuxDock             TerminalRegistry         xterm.js
  |                    |                    |                        |
  |                    |   [P1 in SETTLING] |                        |
  |                    |   pending=splice'd |                        |
  |                    |   remaining=N      |                        |
  |                    |   ready=false      |                        |
  |                    |                    |─── term.write(chunk1, onWriteDone) ──►|
  |                    |                    |─── term.write(chunk2, onWriteDone) ──►|
  |                    |                    |─── term.write(chunkN, onWriteDone) ──►|
  |                    |                    |                        |  [xterm rAF queued]
  |── click "×" ──────►|                    |                        |
  |                    | onDidRemovePanel   |                        |
  |                    | _locallyClosedPanes.add(p1)                 |
  |                    | dispatch pane-close(p1)                     |
  |                    |                    |                        |
  |  app._onClosePane(p1):                  |                        |
  |  remaining = store.panes.filter(id≠p1)  |                        |
  |  terminalRegistry.prune(remaining) ──────►                       |
  |                    |    entry = _map.get(key)                    |
  |                    |    entry.resizeObserver?.disconnect()       |
  |                    |    clearTimeout(entry.resizeTimer)          |
  |                    |    entry.term.dispose() ◄── WHILE WRITES IN-FLIGHT
  |                    |    _map.delete(key)                         |
  |                    |                    |                        |
  |                    |                    |  [xterm rAF fires]     |
  |                    |                    |  processWrites()        |
  |                    |                    |  [write callbacks fire] |
  |                    |                    |  onWriteDone() ←───────|
  |                    |                    |  remaining-- (from CLOSED entry's closure)
  |                    |                    |  IF remaining === 0:    |
  |                    |                    |    entry.ready = true   | ← ghost state
  |                    |                    |    drain live-queue:    |
  |                    |                    |    entry.term.write()   | ← write to disposed term
  |                    |                    |                        |
  |  NO close-pane sent to server           |                        |
  |  PTY continues running on server        |                        |
  |  Store still has P1 (no pane-closed)   |                        |
  |  _syncTerminals() calls ensure(p1) again ← RE-CREATES ENTRY!   |
  |                    |                    |                        |
  |  On next page load:                     |                        |
  |  composition includes P1               |                        |
  |  P1 panel re-appears ← USER EXPECTED IT GONE                   |
```

**What SHOULD happen:**
```
  |── click "×" ──────►|                    |                        |
  |                    | _locallyClosedPanes.add(p1)                 |
  |                    | dispatch pane-close(p1)                     |
  |  app._onClosePane(p1):                  |                        |
  |  socket.closePane(p1) ──── WS send {close-pane, paneId: p1} ──► server
  |  pane lifecycle: → CLOSING (no prune yet; await server ack)     |
  |                    |  increment generation counter for p1        |
  |                    |  [ongoing write callbacks check generation → DROP if stale]
  |                    |                    |                        |
  |◄─ JSON: pane-closed(p1) ───────────────────────────────────────|
  |  store removes p1  |                    |                        |
  |  mux-dock Case 2 removes panel (already gone, no-op)            |
  |  prune(remaining) → clean dispose of terminal                   |
  |                    |                    |                        |
  |  On next page load: composition does NOT include P1 ✓           |
```

---

### Scenario C: New Pane Create → Immediate Close

User clicks "+" then immediately clicks "×" before `pane-added` broadcast arrives.

```
Browser (user)     app.ts              MuxDock             Server
  |                    |                    |                    |
  |── click "+" ──────►|                    |                    |
  |                    |_createPaneOptimistic():                 |
  |                    | tempId = -1        |                    |
  |                    | store.mutate({paneId:-1, clientRef:ref})|
  |                    | socket.createPane(ref) ─────────────────► server
  |                    |                    |                    | [PTY spawns]
  |                    | store._notify() → Lit schedules render  |
  |  [Lit render]      |                    |                    |
  |  panes = store.panes.filter(id≥0) = [] |                    |
  |  ⚠ Temp pane (-1) filtered from render: "empty workspace" view shown
  |  OR if real panes exist: dock shows real panes only          |
  |                    |                    |                    |
  |  [user sees no new tab yet — nothing to click "×" on]       |
  |                    |                    |                    |
  |◄─ JSON: pane-added(realId=5, clientRef=ref) ────────────────|
  |  store.applySessiond(PaneAdded) → mutation settles           |
  |  store._panes includes realId=5                              |
  |  [Lit render] → mux-dock.updated Case 2 → panel(5) added    |
  |  TerminalRenderer.init(5), layout(5) → attach               |
  |  P5 now in DOM_ATTACHED state                               |
  |                    |                    |                    |
  |── user clicks "×" on P5 tab ──────────►|                    |
  |                    | pane-close(5) dispatched                |
  |                    |_onClosePane(5):    |                    |
  |                    | prune(remaining)   |                    | ← NO close-pane sent
  |                    |                    |                    | PTY running on server
  |                    |                    |                    |
  |  store._panes still has P5             |                    |
  |  _syncTerminals() → ensure(5) RE-CREATES entry              |
  |  P5 entry exists but panel suppressed by _locallyClosedPanes |
  |  P5 terminal invisible; receives PTY output; memory leak     |
  |                    |                    |                    |
  |  On refresh: composition includes P5   |                    |
  |  P5 panel re-appears ← WRONG          |                    |
```

**Root cause:** No `close-pane` protocol message. `_locallyClosedPanes` is a client-local suppression, not a server-side termination.

---

### Scenario D: Workspace Switch Mid-Settle

User switches workspace while P1 from WS1 is in SETTLING state.

```
TerminalRegistry (key=WS1:P1)    app.ts          MuxDock         Server
  |     [ready=false, opened=true]    |               |               |
  |     [write callbacks in-flight]   |               |               |
  |                                   |               |               |
  |  [ResizeObserver fires for WS1:P1 hostEl]         |               |
  |  50ms debounce timer set          |               |               |
  |                                   |               |               |
  |  user switches to WS2             |               |               |
  |── user selects WS2 ────────────────────────────────► _onWorkspaceSelected
  |  socket.attachWithBreakpoint(WS2) ────────────────────────────── ► server
  |                                   |               |               |
  |◄─ JSON: composition(WS2, panes=[P3,P4]) ────────────────────────|
  |  onSessiondMessage:               |               |               |
  |   terminalRegistry.setWorkspace(WS2) ◄───── _currentWorkspaceId=WS2
  |   ensure(P3, handlers); setSeqAnchor(P3, seq)     |               |
  |   ensure(P4, handlers); setSeqAnchor(P4, seq)     |               |
  |   store.applySessiond(Composition) → store._attached=WS2         |
  |   _notify() → Lit schedules render |               |               |
  |                                   |               |               |
  |  [50ms debounce timer for WS1:P1 fires]           |               |
  |  rAF → _settleAndDrain(P1_id)     |               |               |
  |   _key(P1_id) = "WS2:P1_id" ◄─── WRONG WORKSPACE KEY
  |   entry = _map.get("WS2:P1_id") → undefined (or wrong pane!)
  |   no-op                           |               |               |
  |   WS1:P1 stays ready=false FOREVER|               |               |
  |                                   |               |               |
  |  [Lit microtask: render]          |               |               |
  |  _syncTerminals():                |               |               |
  |   setWorkspace(WS2) [idempotent]  |               |               |
  |   ensure(P3), ensure(P4)          |               |               |
  |   prune({P3,P4}) — prefix="WS2:" |               |               |
  |   WS1:P1 NOT pruned (different prefix) ← correct: preserve scrollback
  |  mux-dock.updated() Case 1:       |               |               |
  |   _removingPanels=true            |               |               |
  |   dv.removePanel(WS1:P1_panel) → |               |               |
  |     TerminalRenderer.dispose()    |               |               |
  |     terminalRegistry.detach(P1_id)|               |               |
  |      _key(P1_id) = "WS2:P1_id" ◄── WRONG KEY
  |      entry = undefined → no-op    |               |               |
  |      WS1:P1 hostEl still in old DOM node (removed by dockview)    |
  |      WS1:P1 ResizeObserver NOT disconnected ← RESOURCE LEAK      |
  |   fromJSON(WS2_layout) ...        |               |               |
  |                                   |               |               |
  |  [write callbacks for WS1:P1 fire eventually]     |               |
  |  onWriteDone(): remaining--       |               |               |
  |  IF remaining===0: entry.ready=true [on WS1:P1 entry, now isolated]
  |  drain live-queue: empty          |               |               |
  |                                   |               |               |
  |  If user switches BACK to WS1:    |               |               |
  |  setWorkspace(WS1)                |               |               |
  |  mux-dock Case 1 → fromJSON(WS1_layout)           |               |
  |  TerminalRenderer.layout(P1) → attach(P1, el)     |               |
  |   _key(P1) = "WS1:P1" ← CORRECT NOW               |               |
  |   entry found: opened=true, ready=true (was set by orphaned callback)
  |   new RO installed; rAF → fitIfVisible (ready=true) → OK         |
  |  BUT: pendingData for WS1:P1 was splice'd; not re-drained        |
  |  AND: seqBytes for WS1:P1 may be wrong (WS2 bytes mixed in?)     |
```

---

### Scenario E: Reconnect While Panes Exist

WS drops mid-session. Some panes have live data since last anchor. How delta replay interacts with settle.

```
TerminalRegistry (key=WS1:P1)    app.ts             MuxSocket
  | [ready=true, seqBase=N, seqBytes=K] |               |
  | [P1 showing live output]             |               |
  |                                      |               |
  |  ◄── WS connection drops ────────────────────────────|
  |  onDisconnect() fires               |               |
  |  showReconnectOverlay=true          |               |
  |  _scheduleReconnect()               |               |
  |                                      |               |
  |  [P1 entry: ready=true, seqBase=N, seqBytes=K]       |
  |  [_currentWorkspaceId = WS1]        |               |
  |                                      |               |
  |  [backoff timer fires → _open()]    |               |
  |  WS reconnects                      |               |
  |  onopen → onReconnect() → controller.bootstrap()    |
  |                                      |               |
  |  bootstrap():                        |               |
  |   localStorage has WS1              |               |
  |   offsets = registry.getOffsets()   |               |
  |     → [{paneId:P1, seq:N+K}]        |               |
  |   attachWithBreakpoint(WS1, 'wide', [{P1, N+K}])    |
  |                                      |               |
  |  [server: ReplayFrom(N+K) for P1]   |               |
  |  [if RawBuffer: returns bytes from ring ≥ N+K]       |
  |  [if VTBuffer: IGNORES since; returns full Replay(), start=0]
  |  ⚠ VTBuffer always sends full replay regardless of offsets
  |                                      |               |
  |◄─ composition({WS1, panes:[{P1, seq=anchor}]}) ──────|
  |   onSessiondMessage:                |               |
  |   setWorkspace(WS1) [idempotent]    |               |
  |   ensure(P1, handlers) [idempotent — updates handlers, entry exists]
  |   setSeqAnchor(P1, anchor):         |               |
  |     entry.seqBase = anchor          |               |
  |     entry.seqBytes = 0 ← RESETS byte count
  |     ⚠ BUG: if anchor=0 (VTBuffer), ALL prior seqBytes discarded
  |     ⚠ BUG: ready is still true! No reset on reconnect.
  |                                      |               |
  |◄─ binary: [P1 delta replay bytes]   |               |
  |  write(P1, data):                   |               |
  |   entry.ready = true → term.write(data) DIRECT      |
  |   ⚠ BUG: replay goes direct because ready was not reset
  |   CPR/DA1/DECRQSS in replay → onData → sendPaneInput → PTY echo loop!
  |                                      |               |
  |  CORRECT BEHAVIOR:                  |               |
  |  On ensure() for existing entry:    |               |
  |   if entry already open/ready: reset ready=false    |
  |   pendingData = []                  |               |
  |   Re-run settle sequence            |               |
  |  Then replay goes into pendingData; settle drains properly
```

**Note on VTBuffer and delta replay:** The `PaneBuffer.ReplayFrom(since)` contract explicitly states that VTBuffer "may ignore since and always return (Replay(), 0)". This means delta replay is silently degraded to full replay for VTBuffer. The client-side offset tracking is correct but the server always sends everything. This is safe but wasteful. RawBuffer correctly implements delta replay.

---

## 7. Identified Race Conditions

| # | Name | Trigger Conditions | Frequency | Current Behavior | Correct Behavior | Required Mechanism |
|---|---|---|---|---|---|---|
| RC-1 | **Settle-Before-Replay** (BUG B) | Layout reaches plausible size before WS replay binary frames arrive. Possible on fast machines/networks when dockview settles in <1 WS message-pump cycle | Sometimes (reproducible under good network conditions) | `_settleAndDrain` sees pendingData=[], sets ready=true immediately. Subsequent replay goes direct → xterm processes capability queries → onData fires → sendPaneInput → PTY echo → baked into RawBuffer → replayed every reconnect | Block settle until `seqBytes >= expectedReplayBytes` (known from composition `seq` anchor). Only set ready=true after ALL expected bytes have been written to xterm AND write callbacks have fired. | Track `expectedBytes = pane.seq` (anchor = total bytes server has); hold `ready=false` until `seqBytes >= expectedBytes`. |
| RC-2 | **Second _settleAndDrain During Drain** | ResizeObserver fires (50ms debounce) while write callbacks from first settle are still in-flight. First call splice'd pendingData; second call sees empty pending | Sometimes (if RO fires during settle window, ~100-500ms) | Second `_settleAndDrain` call: pendingData empty → ready=true immediately. First call's write callbacks fire later with ready already true; onWriteDone decrements counter on entry that's "done". Live data arrives with ready=true → direct write while xterm still processing replay from first call. | Exactly one drain sequence per pane lifecycle. Second call must be no-op if drain in progress. | `draining: boolean` flag in PaneEntry; `_settleAndDrain` checks `entry.draining` at entry; set true before splice, false in onWriteDone(remaining===0). |
| RC-3 | **Close During Settle** (BUG D variant) | User clicks "×" on a tab while pane is in SETTLING state; write callbacks still in-flight | Sometimes | `prune()` disposes `entry.term`; write callbacks fire on closed terminal; `entry.ready=true` set on deleted entry; `entry.term.write()` called on disposed terminal. No server close sent. | Increment generation counter before dispose; write callbacks check `entry.generation === myGeneration`; if mismatch → drop. Independently: send `close-pane(paneId)` to server. | Generation counter per PaneEntry; close-pane protocol message. |
| RC-4 | **No close-pane Protocol Message** (BUG D core) | User closes any pane | Always | PTY keeps running on server. Next `composition` reply includes the pane. Panel re-appears on next attach. The `_locallyClosedPanes` Set suppresses re-add in dock but `_syncTerminals()` still calls `ensure()` re-creating the terminal entry. Invisible terminal accumulates output. | `close-pane(paneId)` sent to server. Server kills PTY, removes from registry, broadcasts `pane-closed`. Client transitions to CLOSING state. `pane-closed` triggers clean prune. | Add `TypeClosePane` to protocol; implement server handler; add `socket.closePane(id)` sender. |
| RC-5 | **Workspace Switch Stales _currentWorkspaceId** | User switches workspace while panes from old workspace are in any non-NONEXISTENT state | Always on workspace switch | `_currentWorkspaceId` updated in composition handler (synchronously). Subsequent `detach(paneId)` calls from TerminalRenderer.dispose() use the new workspace ID → wrong key → no-op → old ResizeObservers never disconnected. Settle rAFs for old panes look up wrong key → no-op → old pane never properly settled. Resource leak. | TerminalRenderer must store its workspace ID at construction time and pass it to `detach(paneId, workspaceId)`. `detach` must use the explicit workspace ID, not `_currentWorkspaceId`. | Add `workspaceId` parameter to `detach()`; TerminalRenderer stores `_workspaceId = registry._currentWorkspaceId` at init time. |
| RC-6 | **Reconnect Does Not Reset ready Flag** | WS drops and reconnects; existing panes have `ready=true` from prior session | Always on reconnect | Composition arrives → `setSeqAnchor()` resets seqBase/seqBytes. But `ready` remains `true`. Replay frames arrive → `write()` calls `term.write()` direct. xterm processes CPR/DA1/DECRQSS → `onData` fires → `sendPaneInput` → PTY echo → baked into buffer. | On reconnect, reset each pane entry: `ready=false`, `pendingData=[]`, `draining=false`. Re-run the full settle sequence. The `ensure()` call in the composition handler should detect an existing-but-reopening entry and reset it. | Guard in `ensure()`: if entry already exists AND `_reconnecting`, reset to pre-settle state. Or: expose a `resetForReattach(paneId)` function called from composition handler. |
| RC-7 | **pane-added Arrives After Locally Closed** | User closes pane optimistically; in-flight `pane-added` broadcast arrives before `_locallyClosedPanes` is updated | Rare (pane-added is received nearly synchronously with close) | `_locallyClosedPanes.add(paneId)` happens in `onDidRemovePanel` which fires synchronously during user action. `pane-added` is a WS message, processed in a later task. So `_locallyClosedPanes` is always set before `pane-added` arrives. This race is unlikely in practice. | Correctly suppressed by `_locallyClosedPanes` check in Case 2 | No mechanism needed IF close-pane is added (server will close the pane before re-adding it). |
| RC-8 | **WorkspaceCreated Always Triggers Attach** | User creates a new workspace; `workspace-created` arrives; WorkspaceController unconditionally attaches | Always on workspace create | `controller.onMessage(WorkspaceCreated) → attachWithBreakpoint(newId)` fires regardless of user intent (workspace creation via `_submitCreate` AND recovery path via `CREATING_DEFAULT` both flow through here). User creating workspace always switches to it. | Bootstrap/recovery path: attach on create. User-initiated creation: do not auto-attach; let user switch manually (or add explicit flag to distinguish the intent). | Add `_pendingCreateAttach: boolean` flag set only in `CREATING_DEFAULT` path; `WorkspaceCreated` handler checks flag before attaching. |
| RC-9 | **RawBuffer Bakes Capability Responses** (BUG A) | Any `create-pane` call; xterm processes capability queries (CPR, DA1, DECRQSS) from replay; `onData` fires and sends responses to PTY before `ready` gate was added | Historically always; partially mitigated by `ready` gate on `onData`, but replay-direct writes (RC-1) re-open the window | Stale escape sequences accumulate in RawBuffer on every reconnect. Each reconnect replays them. Garbled terminal output compounds. | Use VTBuffer (cell-grid snapshot) for production panes. VTBuffer replays clean screen state regardless of capability responses. RawBuffer should be test-only. | Change `NewRawBuffer(0)` to `NewVTBuffer(cols, rows)` in `server.go:createPane()` (line ~363). VTBuffer exists; just not wired. |
| RC-10 | **activePaneId Reset by Composition** | Every `composition` reply; `store.applySessiond` sets `_activePaneId = panes[0]` | Always | Layout restore in `mux-dock` Case 1 partially recovers via `_activePaneIdFromSavedLayout()` and `pane-select` dispatch. But between Composition arrival and Lit render completion, `activePaneId` is wrong. The double-rAF hack re-asserts focus but is fragile against timing. | Composition should not reset `activePaneId`; the layout restore should set it. `activePaneId` should only be touched by explicit `setActivePane()` calls. | Remove `this._activePaneId = newActivePaneId` from `applySessiond(Composition)`. Let mux-dock Case 1 call `store.setActivePane(restoredId)`. |
| RC-11 | **Non-Active Panels Never Open After fromJSON** (BUG C) | `fromJSON()` layout restore with multiple panes; only the active panel's `TerminalRenderer.layout()` is called with `isConnected=true` after DOM append | Always when restoring multi-pane layouts | Non-active panels stuck in `opened=false`. `pendingData` grows unbounded. Terminal never displays. | After `fromJSON()`, iterate all panels and call `terminalRegistry.attach()` for any with `opened=false` and connected container element. | Post-`fromJSON` rAF pass in `mux-dock` Case 1 that explicitly attaches all panels. |
| RC-12 | **VTBuffer Ignores delta replay offsets** | Any reconnect with VTBuffer panes; client sends non-zero offsets | Always with VTBuffer | Server calls `p.ReplayFrom(N+K)` → VTBuffer ignores `since`, returns full replay, `start=0`. Client's `setSeqAnchor(anchor=0)` resets seqBytes to 0. On next reconnect, client again sends `seq=0` → same full replay. Delta replay is silently non-functional for VTBuffer panes. | VTBuffer must implement `ReplayFrom` to return `(Replay(), Seq())` when `since >= Seq()` (client is up to date) and `(Replay(), 0)` otherwise. Client-side: when `anchor=0`, disable delta tracking and use full-replay path. | VTBuffer `ReplayFrom` contract clarification; or add a protocol flag `"full-replay": true` in composition when delta is not supported. |

---

## 8. Design Invariants

These invariants MUST hold regardless of event ordering. Violations are bugs. Assertions or guards should be added to enforce them.

- **INV-1:** A pane's `ready` flag MUST NOT be set to `true` until:  
  (a) `term.open()` has been called (`opened=true`),  
  (b) `expectedReplayBytes` (derived from the composition `seq` anchor) have been received into `seqBytes`,  
  (c) all of those bytes have been passed to `term.write(chunk, cb)`, AND  
  (d) all write callbacks have fired.  
  Violation: RC-1, RC-2, RC-6.

- **INV-2:** The server MUST deliver messages for a given connection in this order per attach:  
  `composition → [replay frames...] → [live frames...]`  
  This order is guaranteed by the subscriber queue (atomic under `s.mu`). It MUST NOT be broken by any future async pane-creation or buffer change.

- **INV-3:** `setSeqAnchor(paneId, anchor)` MUST be called synchronously in the same JS task as the `composition` message handler, BEFORE any binary replay frames can be processed.  
  Currently satisfied by the composition handler calling `ensure()` then `setSeqAnchor()` synchronously. Any async gap here would break offset tracking.

- **INV-4:** A `PaneEntry` MUST exist in the registry before the first binary data frame for that pane arrives.  
  The server's queue ordering (INV-2) guarantees this: composition is delivered first, and the composition handler calls `ensure()` synchronously. The pre-ensure buffer handles the pathological case where binary data arrives before ensure (currently handled but logically should never occur with INV-2 intact).

- **INV-5:** When a user closes a pane, the server MUST be notified via `close-pane(paneId)`, and the pane MUST be removed from the server's registry before the next `composition` reply.  
  Currently VIOLATED. No `close-pane` message exists.

- **INV-6:** A pane's `paneId` MUST be unique within a workspace for the lifetime of that pane. The server currently guarantees this (workspace-local incrementing IDs). If a pane is closed and a new one created, the new pane MUST get a different paneId. (Current server behavior: IDs increment monotonically, so this holds, but it is not explicitly asserted.)

- **INV-7:** `terminalRegistry.detach(paneId)` MUST use the workspaceId under which the terminal was created, NOT `_currentWorkspaceId` at call time.  
  Currently VIOLATED. See RC-5.

- **INV-8:** `_settleAndDrain(paneId)` MUST be idempotent and reentrant-safe. Concurrent calls (e.g., rAF kick + ResizeObserver debounce) must not both set `ready=true` or splice `pendingData` twice.  
  Currently VIOLATED when the settle window overlaps with a ResizeObserver callback. See RC-2.

- **INV-9:** The `WorkspaceController` MUST NOT send a second `attach` request while `_attachInFlight=true`.  
  Currently satisfied by the `_attachInFlight` guard for the bootstrap path. NOT enforced for user-initiated workspace switches (`_onWorkspaceSelected` sets no in-flight flag).

- **INV-10:** The client's offset `seq = seqBase + seqBytes` sent on attach MUST equal the total bytes received from the server for that pane since the last `setSeqAnchor` call.  
  Currently VIOLATED for VTBuffer panes (server always returns `start=0`, so client's seqBase is always reset to 0 by subsequent setSeqAnchor calls). Also violated during workspace switches (RC-5).

- **INV-11:** The `store._panes` array MUST NOT contain a pane that has been user-closed (i.e., for which `close-pane` was sent) until a `pane-closed` event is received from the server.  
  Currently VIOLATED: no `close-pane` is sent, so `store._panes` keeps the closed pane forever. `_syncTerminals()` keeps calling `ensure()` on it.

- **INV-12:** The `_locallyClosedPanes` set in `mux-dock` MUST be cleared ONLY on workspace change (Case 1). Within a workspace session, a locally-closed pane MUST NOT reappear in the dock even if server broadcasts `pane-added` for it.  
  Currently satisfied by the `_locallyClosedPanes` check in Case 2, but undermined by INV-11 (the terminal entry is re-created even though the panel is suppressed).

- **INV-13:** All xterm.js write callbacks from a given pane's drain sequence MUST complete before that pane's input (`onData`) is forwarded to the server.  
  Currently satisfied by the `ready` gate on `onData`. Violated only if `ready` is set too early (RC-1, RC-2, RC-6).

- **INV-14:** A composition with `panes=[]` in the attached workspace MUST trigger auto-creation of exactly one pane.  
  Currently satisfied: `if (msg.type === Composition && store.panes.length === 0) _createPaneOptimistic()`. The guard on `store.panes.length` (the folded view) means an already-pending optimistic pane suppresses a second creation. This invariant MUST be preserved when close-pane is added.

---

## 9. Recommended Architecture Changes

Listed in priority order. These are structural changes, not implementation details.

### 9.1 Add `close-pane` Protocol Message (Critical — blocks all pane-delete correctness)

The absence of this message is the single root cause of the largest cluster of bugs (RC-3, RC-4, RC-7, INV-5, INV-11, INV-12).

- Add `TypeClosePane = "close-pane"` to the protocol (frozen constant).
- Server handler: look up pane in attached workspace; call `p.Close()`; remove from registry; broadcast `pane-closed`.
- Client sender: `socket.closePane(paneId)` in `ws.ts`.
- Client caller: `app._onClosePane` sends `close-pane` BEFORE calling `prune()`.
- Client state: pane transitions to CLOSING state; `prune()` deferred until `pane-closed` arrives.

### 9.2 Add Generation Counter to PaneEntry (Critical — blocks safe concurrent close-during-settle)

A monotonically-incrementing integer per `PaneEntry` that is captured in write-callback closures. If the counter has been incremented (pane closed/reset) by the time the callback fires, the callback is silently dropped.

- Add `generation: number` field to `PaneEntry`.
- Increment on `prune()`, on `resetForReattach()`, and on explicit close.
- `onWriteDone` closure captures `myGeneration = entry.generation` at drain time; checks `entry.generation === myGeneration` before setting `ready=true`.

### 9.3 Add `draining` Flag to PaneEntry (Critical — blocks RC-2)

Prevents a second concurrent `_settleAndDrain` call from setting `ready=true` prematurely.

- Add `draining: boolean` field (default `false`).
- `_settleAndDrain`: guard at entry `if (entry.draining || entry.ready) return`.
- Set `draining = true` before splice; reset to `false` in `onWriteDone(remaining===0)`.

### 9.4 Pass Explicit Workspace ID Through detach() (Critical — blocks RC-5)

`TerminalRenderer` must store its workspace ID at construction and pass it through all registry calls that require it.

- `TerminalRenderer` constructor: capture `_workspaceId = registry.currentWorkspaceId()` (new export needed).
- `terminalRegistry.detach(paneId, workspaceId)`: use explicit `workspaceId` instead of `_currentWorkspaceId`.
- Similarly: all methods that use `_key(paneId)` and are called from TerminalRenderer must accept an explicit workspace context.

### 9.5 Reset ready Flag on Reconnect / Reattach (Critical — blocks RC-6)

When a connection drops and reconnects, all pane entries that were `ready=true` must be reset to re-run the settle sequence.

- Add `resetForReattach(paneId)` to the registry: `ready=false`, `draining=false`, `pendingData=[]`, increment generation, reset `seqBase/seqBytes`.
- Call from the composition handler in `app.ts` for each pane that already has an entry (i.e., on reconnect, not fresh load). Distinguish via `entry.opened`.

### 9.6 Change createPane to Use VTBuffer (Important — blocks RC-9 / BUG A)

One-line fix with large impact on replay correctness.

- In `server.go`, `createPane()`: change `NewRawBuffer(0)` to the `nil` buf arg (so `NewPane` uses its default `NewVTBuffer(cols, rows)`) or explicitly pass `NewVTBuffer(cols, rows)`.
- Verify VTBuffer's `ReplayFrom(since)` correctly handles the "client up to date" case (see RC-12).

### 9.7 Fix Non-Active Panel Attach After fromJSON (Important — blocks BUG C)

After `fromJSON()`, proactively attach all panels whose containers are now connected to the DOM.

- In `mux-dock` Case 1, after `fromJSON()` and the panel-map rebuild, schedule a single `requestAnimationFrame` that iterates `this._panels` and calls `terminalRegistry.attach(paneId, rendererElement)` for any panel whose element is connected but whose terminal is not yet opened.

### 9.8 Add expectedReplayBytes Guard to _settleAndDrain (Important — blocks RC-1)

Do not set `ready=true` when `pendingData` is empty if the terminal has not yet received its expected replay bytes.

- Store `expectedReplayBytes: number` in `PaneEntry` (set from composition `pane.seq` anchor via `setSeqAnchor`).
- In `_settleAndDrain`: after splice, if `pending.length === 0` AND `entry.seqBytes < entry.expectedReplayBytes`, do NOT set `ready=true`. Instead, reschedule via `requestAnimationFrame` (retry loop). Log the wait condition.
- When `seqBytes >= expectedReplayBytes` AND `pending.length === 0`: safe to set `ready=true` (empty replay is legitimate for zero-seq panes).

### 9.9 Remove activePaneId Reset from applySessiond(Composition) (Moderate — blocks RC-10)

The store should not opine on which pane is active; that is the layout engine's job.

- Remove `this._activePaneId = newActivePaneId` from `applySessiond(Composition)`.
- `mux-dock` Case 1 is responsible for calling `store.setActivePane(restoredId)` after layout restore.
- For fresh (non-restored) workspaces, `mux-dock` Case 1 sets `store.setActivePane(firstPaneId)`.

### 9.10 Scope WorkspaceCreated Auto-Attach (Minor UX — blocks RC-8)

Add a `_pendingAutoAttach: boolean` flag to `WorkspaceController` set only in the `CREATING_DEFAULT` recovery path. `onMessage(WorkspaceCreated)` attaches only if this flag is set.

- User-initiated workspace creation should not auto-switch (or at minimum this should be a configurable preference).
- Recovery-path workspace creation must always auto-attach.

---

## Appendix: Known Protocol Gaps

| Gap | Impact | Required Addition |
|---|---|---|
| No `close-pane` message | PTY leaks; pane reappears on reconnect | `TypeClosePane` + server handler + client sender |
| No `replay-done` sentinel | Client cannot distinguish "no replay data" from "replay not yet arrived" (RC-1) | Optional: `TypeReplayDone` frame after replay batch; or: use `seq` anchor as expected-bytes count |
| `workspace-closed` event not emitted | `WorkspaceController.onMessage(WorkspaceClosed)` branch is dead code | Server must emit `TypeWorkspaceClosed` (not just `TypeWorkspaceList`) on `closeWorkspace` |
| VTBuffer `ReplayFrom` ignores `since` | Delta replay silently non-functional; full replay always sent | VTBuffer must implement `ReplayFrom` correctly, or add `"delta-capable": false` to composition |
| No pane `clientRef` in `pane-added` for non-optimistic creates | Cannot correlate server-assigned ID with client-side request in all code paths | Currently OK because `clientRef` is passed through; but correlation logic only works in store's `settled()` predicate |

---

*This document was produced by static analysis of the full codebase at commit `dfb0171`. It reflects the state of the code as of that commit and should be updated whenever the protocol or component contracts change.*
