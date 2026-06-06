# muxterm Architecture — Connection Lifecycle & Data Flow

## Sequence Diagram — Ideal Dependency Order

```
 Browser          ws.ts         serve/ws.go       sessiond          registry.ts      mux-dock        xterm.js
    │                │                │                │                  │               │               │
    │══ WS open ════►│                │                │                  │               │               │
    │                │══ Dial() ═════►│                │                  │               │               │
    │◄═ config JSON ═══════════════════                │                  │               │               │
    │                │                │                │                  │               │               │
    │   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐ │
    │   │  PHASE 1: ATTACH  (one attach only — _attachInFlight guards against spurious 2nd)            │ │
    │   └──────────────────────────────────────────────────────────────────────────────────────────────┘ │
    │═══ attach(wsId, bp, offsets) ══►│                │                  │               │               │
    │                │                │══ Attach() ════►                  │               │               │
    │                │                │  ┌───────────────────────────┐    │               │               │
    │                │                │  │  under s.mu — ATOMIC:     │    │               │               │
    │                │                │  │  1. build composition      │    │               │               │
    │                │                │  │  2. enqueue composition    │    │               │               │
    │                │                │  │  3. enqueue replay frames  │    │               │               │
    │                │                │  │  4. mark conn live         │    │               │               │
    │                │                │  └───────────────────────────┘    │               │               │
    │                │                │                │                  │               │               │
    │   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐ │
    │   │  PHASE 2: COMPOSITION ARRIVES                                                                │ │
    │   └──────────────────────────────────────────────────────────────────────────────────────────────┘ │
    │◄══ composition JSON ═══════════════════════════════════════════════                │               │
    │   [synchronously, before any binary frames]:                        │               │               │
    │═══════════════════════════════════════════════════════════════════► setWorkspace()  │               │
    │═══════════════════════════════════════════════════════════════════► ensure(p1)      │               │
    │                                                                     ready=false     │               │
    │                                                                     opened=false    │               │
    │═══════════════════════════════════════════════════════════════════► setSeqAnchor()  │               │
    │═══════════════════════════════════════════════════════════════════► ensure(p2)...   │               │
    │                │                │                │                  │               │               │
    │   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐ │
    │   │  PHASE 3: REPLAY ARRIVES  (MUST fill pendingData BEFORE settle fires)                        │ │
    │   └──────────────────────────────────────────────────────────────────────────────────────────────┘ │
    │◄══ binary frame [p1 replay] ══════════════════════════════════════                │               │
    │═══════════════════════════════════════════════════════════════════► write(p1,data) │               │
    │                                                                     ready=false    │               │
    │                                                                     →pendingData   │               │
    │◄══ binary frame [p2 replay] ...                                     [repeat ×N]   │               │
    │                │                │                │                  │               │               │
    │   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐ │
    │   │  PHASE 4: LIT RENDER + DOCK LAYOUT  (Lit microtask — may run before OR after Phase 3)        │ │
    │   └──────────────────────────────────────────────────────────────────────────────────────────────┘ │
    │  [Lit microtask]                                │                  │               │               │
    │  willUpdate() → _syncTerminals() → ensure() (idempotent)           │               │               │
    │  render() → <mux-dock panes activePaneId layout workspaceKey>      │               │               │
    │                                                                     │ updated()     │               │
    │                                                                     │ Case1: ws changed             │
    │                                                                     │ fromJSON(layout)              │
    │                                                                     │   init(p1) hasTerminal=true   │
    │                                                                     │   layout(p1) connected=F skip │
    │                                                                     │   init(p2)...                 │
    │                                                                     │   [dockview appends to DOM]   │
    │                                                                     │   layout(p1) connected=T ✓    │
    │                                                                     │══ attach(p1,el,focus=true) ══►│
    │                                                                     │   term.open(hostEl)           │
    │                                                                     │   ResizeObserver.observe()    │
    │                                                                     │   rAF → _settleAndDrain       │
    │                                                                     │ ⚠ layout(p2) connected=?      │
    │                                                                     │   MUST attach ALL panels      │
    │                │                │                │                  │               │               │
    │   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐ │
    │   │  PHASE 5: SETTLE & DRAIN  (dependency: pendingData must be non-empty from Phase 3)           │ │
    │   └──────────────────────────────────────────────────────────────────────────────────────────────┘ │
    │                                                                     │ rAF fires     │               │
    │                                                                     │ _settleAndDrain(p1)           │
    │                                                                     │ opened? ✓     │               │
    │                                                                     │ visible? ✓    │               │
    │                                                                     │ size ok? ✓    │               │
    │                                                                     │ fonts? ✓      │               │
    │                                                                     │ pending > 0 ← KEY DEPENDENCY  │
    │                                                                     │ [if 0: race — ready=true      │
    │                                                                     │  before replay in pendingData]│
    │                                                                     │═══════════════►term.write(cb) │
    │                                                                     │               │ [xterm rAF]   │
    │                                                                     │               │ processes     │
    │                                                                     │               │ onWriteDone() │
    │                                                                     │ ready=true ◄══════════════════│
    │                │                │                │                  │               │               │
    │   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐ │
    │   │  PHASE 6: LIVE  (ready=true — onData forwarded, writes go direct)                            │ │
    │   └──────────────────────────────────────────────────────────────────────────────────────────────┘ │
    │◄══ binary frame [live p1] ════════════════════════════════════════                │               │
    │═══════════════════════════════════════════════════════════════════► write(p1,data) │               │
    │                                                                     ready=true     │               │
    │                                                                     ════════════════════════════════►term.write
    │   USER TYPES:                                                       │               │               │
    │                                                                     │ onData() ═════►sendPaneInput  │
    │══ binary pane frame ═══════════════════════════════════════════════►│               │               │
```

---

## Data Flow — Split/Merge with Bug Points

```
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │  SERVER SIDE                                                                               │
  │                                                                                            │
  │  PTY process                                                                               │
  │      │  raw bytes (output, capability responses, etc.)                                     │
  │      ▼                                                                                     │
  │  ┌────────────────────────────────────────────────────────────────┐                       │
  │  │  PaneBuffer                                                      │  ← BUG A             │
  │  │                                                                  │                       │
  │  │  createPane() passes NewRawBuffer(0) — NOT NewVTBuffer()         │                       │
  │  │  RawBuffer = flat byte ring, stores ALL raw PTY bytes            │                       │
  │  │  including readline capability query responses                   │                       │
  │  │  those bytes get baked in and replayed every reconnect           │                       │
  │  │                                                                  │                       │
  │  │  VTBuffer = cell grid snapshot, immune to stale sequences        │                       │
  │  │  (code path exists but never reached in production)             │                       │
  │  └────────────────────────────────────────────────────────────────┘                       │
  │          │ [on attach]              │ [live PTY]                                           │
  │          │ ReplayFrom(offset)       │ broadcastPaneData()                                  │
  │          │ (RawBuffer ignores offset│ (after conn marked live in subs)                     │
  │          │  always full replay)     │                                                      │
  │          ▼                          ▼                                                      │
  │  ┌──────────────────────────────────────────────────────────────┐                         │
  │  │  subscriber queue (chan outFrame, depth=256)                   │                         │
  │  │  ORDER GUARANTEED: composition → replay → live                │                         │
  │  └──────────────────────────────────────────────────────────────┘                         │
  │          │ WS frames                                                                       │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
             │ (network)
             ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │  BROWSER SIDE                                                                              │
  │                                                                                            │
  │  ws.onmessage                                                                              │
  │      │ text (JSON)                   │ binary (pane data)                                  │
  │      │                               │                                                     │
  │      │ composition                   ▼                                                     │
  │      │ ┌─────────────────────┐   write(paneId, data)                                      │
  │      │ │ synchronously:       │       │                                                     │
  │      │ │ applySessiond()      │       │                                                     │
  │      │ │ setWorkspace(wsId)   │       ▼                                                     │
  │      │ │ ensure(p) × N        │   ┌──────────────────────────────────────────────────┐    │
  │      │ │ setSeqAnchor × N     │   │  entry.ready ?                                    │    │
  │      │ └─────────────────────┘   │                                                    │    │
  │      │                           │  NO  ──► pendingData.push(data)                   │    │
  │      │ Lit render (microtask)    │                                                    │    │
  │      │ ┌─────────────────────┐   │  YES ──► term.write(data)                         │    │
  │      │ │ mux-dock.updated()   │   │           onData fires ← BUG B if ready too early │    │
  │      │ │ Case 1: fromJSON()   │   └──────────────────────────────────────────────────┘    │
  │      │ │ renderer.layout() ×N │             │                                              │
  │      │ │ ⚠ only active panel  │       pendingData                                         │
  │      │ │   gets 2nd layout()  │             │                                              │
  │      │ │   after DOM append   │             │                                              │
  │      │ │ ← BUG C              │   ┌─────────▼────────────────────────────────────────┐    │
  │      │ └─────────────────────┘   │  _settleAndDrain(paneId)                           │    │
  │      │                           │                                                    │    │
  │      │                           │  AWAIT ALL of these before firing:                 │    │
  │      │                           │    ✓ entry.opened   (term.open called)             │    │
  │      │                           │    ✓ isVisible      (hostEl in live DOM)           │    │
  │      │                           │    ✓ plausibleSize  (≥120×60px)                   │    │
  │      │                           │    ✓ fonts.ready                                   │    │
  │      │                           │    ✗ pendingData > 0 ← MISSING DEPENDENCY          │    │
  │      │                           │                                                    │    │
  │      │                           │  BUG B: layout settles before replay arrives:      │    │
  │      │                           │    pending=0 → ready=true immediately              │    │
  │      │                           │    replay arrives → write() direct                 │    │
  │      │                           │    onData unsuppressed → forwarded to PTY          │    │
  │      │                           │    echoed back → baked into RawBuffer → loop       │    │
  │      │                           │                                                    │    │
  │      │                           │  BUG C: non-active panels after fromJSON:          │    │
  │      │                           │    layout(isConnected=F) → skip                    │    │
  │      │                           │    no 2nd layout() call after DOM append           │    │
  │      │                           │    opened=false forever → pendingData fills        │    │
  │      │                           │    terminal never shows                            │    │
  │      │                           └─────────────────┬──────────────────────────────────┘    │
  │      │                                             │ drain: term.write(chunk,cb) × N       │
  │      │                                             ▼                                       │
  │      │                                         xterm.js                                    │
  │      │                                      (processes in rAF)                             │
  │      │                                      onWriteDone() → ready=true                     │
  │      │                                                                                     │
  │      │  ┌──────────────────────────────────────────────────────────────────────────────┐   │
  │      │  │  PANE DELETE — BUG D                                                          │   │
  │      │  │                                                                               │   │
  │      │  │  Current:  dv.removePanel() → UI gone → prune(registry)                      │   │
  │      │  │            NO server message → PTY keeps running                              │   │
  │      │  │            Next attach: composition includes pane → reappears                 │   │
  │      │  │                                                                               │   │
  │      │  │  Also:     in-flight pane-added arrives after close                           │   │
  │      │  │            → Case 2 re-adds panel before _locallyClosedPanes set             │   │
  │      │  │                                                                               │   │
  │      │  │  Ideal:                                                                       │   │
  │      │  │    1. cancel any pending create-pane mutation for this pane                   │   │
  │      │  │    2. send close-pane(paneId) → server kills PTY                             │   │
  │      │  │    3. server broadcasts pane-closed → state removes pane                     │   │
  │      │  │    4. prune registry                                                          │   │
  │      │  │    cancellation: generation counter per pane                                  │   │
  │      │  │    pane-added with stale generation → silently dropped                       │   │
  │      │  └──────────────────────────────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Bug Summary

```
  BUG A — Garbled bytes baked into replay
  ┌──────────────────────────────────────────────────────────────────┐
  │ Root:  createPane() passes NewRawBuffer(0)                        │
  │        RawBuffer stores raw PTY bytes incl. capability responses  │
  │        VTBuffer (grid snapshot) exists but is never used in prod  │
  │ Fix:   Pass NewVTBuffer(cols, rows) in createPane()               │
  │ File:  internal/sessiond/server.go:363                            │
  └──────────────────────────────────────────────────────────────────┘

  BUG B — ready=true before replay fills pendingData
  ┌──────────────────────────────────────────────────────────────────┐
  │ Root:  _settleAndDrain fires while pendingData=[]                 │
  │        layout can settle (correct size) before WS replay frames   │
  │        arrive — then ready=true, replay arrives direct            │
  │ Fix:   Track expected replay bytes from composition (pane.seq)    │
  │        Don't settle until seqBytes >= expected, OR add            │
  │        server-side replay-done sentinel frame                     │
  │ File:  web/src/lib/terminal-registry.ts                           │
  └──────────────────────────────────────────────────────────────────┘

  BUG C — Non-active panels never attach after fromJSON
  ┌──────────────────────────────────────────────────────────────────┐
  │ Root:  dockview only calls layout() on active panel after DOM     │
  │        append — hidden tabs stuck with opened=false forever       │
  │        pendingData grows but _settleAndDrain never fires          │
  │ Fix:   Post-fromJSON rAF pass: iterate all panels, call           │
  │        registry.attach() for any connected but not yet opened     │
  │ File:  web/src/components/mux-dock.ts                             │
  └──────────────────────────────────────────────────────────────────┘

  BUG D — Deletes not server-side + no cancellation
  ┌──────────────────────────────────────────────────────────────────┐
  │ Root:  No close-pane protocol message exists                      │
  │        PTY keeps running; pane reappears on next attach           │
  │        In-flight pane-added can race the close                    │
  │ Fix:   Add TypeClosePane to protocol                              │
  │        Server: kill PTY, remove from registry, broadcast closed   │
  │        Client: cancel in-flight mutation before sending close     │
  │ Files: internal/sessiond/protocol.go + server.go + ws.go +       │
  │        web/src/ws.ts + web/src/app.ts                             │
  └──────────────────────────────────────────────────────────────────┘
```
