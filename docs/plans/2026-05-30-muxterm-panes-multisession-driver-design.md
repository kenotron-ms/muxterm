# muxterm: Panes/Dock + Multi-Session + Agentic Driver Design

## Goal

Add three feature dimensions to muxterm on one shared architectural foundation:

1. **Panes** — a muxterm-owned dock layer plus popped-out windows.
2. **Multi-session** — switching between attached tmux sessions.
3. **Agentic driver** — a standalone "driver" TUI that can drive all sessions/windows/panes.

Plus two ride-along workstreams: a minimal config system and a UI polish pass. All five sit on **one spine refactor**: `sessionManager{1}` → `controllerPool{N}`.

---

## Background

muxterm today is "iTerm2 for the web":

```
muxterm = browser frontend + Go binary + tmux control mode

  Browser  (Lit web components + xterm.js v6)
      |  single WebSocket  (binary = pane I/O, text = JSON control)
  Go single binary  [cmd/muxterm/main.go]
      |  tmux -CC attach-session  (control mode, via PTY)
  tmux server
```

Key facts that shape this design:

- **Layout is 100% tmux-driven today.** `<mux-layout>` parses the tmux layout string into CSS flex splits. There is no UI-owned dock/float system. Panes == tmux panes.
- **The terminal registry is the enabling asset.** `terminal-registry.ts` owns one xterm.js instance per pane as a DOM-position-agnostic singleton; `attach(paneId, container)` works with *any* container. **Re-parenting** (docking / pop-out) is therefore a "where do I mount it" problem, not a "how do I keep the terminal alive" problem.
- **Multi-session is partially modeled, not wired.** `TmuxState.Sessions[]`, the reconciler, and `<mux-session-picker>` exist — but `sessionManager` holds exactly ONE tmux controller, and there is no session routing in the WS protocol. `%sessions-changed` is parsed but not plumbed to advertise the session list.
- **No config/settings system exists.** Theme, fonts, and tmux options are hardcoded (`theme.ts`, `terminal-registry.ts:18`, `applyMuxtermConfig()` at `main.go:238`).
- **A "driver" is architecturally cheap-ish:** tmux pane IDs (`%N`) are server-global, so `send-keys -t %N` already crosses sessions on a single control connection.
- **`TmuxEngine`** (in `internal/server/ws.go`) is the routing seam the refactor pivots on.

---

## Chosen Approach

**Approach A — spine-first, thin vertical slices.**

Build the controller-pool refactor first (invisible; a pool of 1 renders exactly like today), then ship in dependency order, each step independently shippable:

```
 0. Controller pool refactor      (invisible; pool of 1 == today)
 1. Multi-session switch          (cheapest pool consumer — proves the spine)
 2. Layer-2 workspace + surfaces  (the dock; tmux window = a surface)
 3. Pop-out presentation          (no in-page float; CSS-scale primitive; window.open second OS window)
 4. Driver console surface        (the agentic TUI in a dedicated tmux session)
 5. UI polish + config            (woven through; polish sequenced last)
```

### Why this sequence

- **Retires the scariest risk first, cheaply.** The dangerous assumption is *N control clients + per-surface sizing*. Multi-session (step 1) exercises every dangerous path — N clients, per-session attach/detach, the WS `session` tag, output dedup across clients — while the UI still shows **one surface at a time**. If the pool is wrong, you find out here, with a feature that is independently valuable.
- **Always shippable.** Every step is demoable on its own.
- **Avoids YAGNI waste.** Polishing the single-surface UI *before* restructuring it into a dock would throw away work; polish is sequenced last (step 5).

> **Critical note:** the verification tooling (see *Testing / Verification Strategy*) is **build-early infrastructure**, landing with or just before step 2. It is the lifeline for the pane-hookup work — you do not re-parent panes without it in hand.

---

## Architecture

### Foundation: two-layer layout authority

Two layout authorities, nested, with a hard boundary. They communicate through **exactly one value per surface: its cell budget `cols×rows`.**

```
╔══════════════════════════════════════════════════════════════╗
║  muxterm WORKSPACE          (Layer 2 — muxterm owns WHERE)    ║
║                                                              ║
║  ┌─ dock slot ──────────────┐  ┌─ dock slot ──────────────┐  ║
║  │ surface = tmux window @1 │  │ surface = DRIVER CONSOLE │  ║
║  │ ┌────────┬────────┐      │  │  (non-terminal panel)    │  ║
║  │ │  %1    │  %2    │      │  │                          │  ║
║  │ └────────┴────────┘      │  └──────────────────────────┘  ║
║  │   ↑ Layer 1: tmux owns   │  ┌─ dock slot ──────────────┐  ║
║  │     the splits in here   │  │ surface = tmux window @4 │  ║
║  └──────────────────────────┘  │   %7                     │  ║
║                                 └──────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════╝
                                          + pop-out OS window (window.open)
                                             ┌──────────────────┐
                                             │ ▢ muxterm win @2 │
                                             │   %3 | %4        │
                                             └──────────────────┘
```

- **Layer 1 (tmux owns):** the intra-window split tree (the `%layout` string). This is exactly `<mux-layout>` today — **untouched**.
- **Layer 2 (muxterm owns):** a dock/workspace manager whose leaves are **surfaces**. A surface is either:
  - one tmux window's pane-tree treated as an **opaque block** (rendered by Layer 1), or
  - a **non-terminal panel** (browser · settings).

  The dock arranges surfaces into regions, tabs, and popped-out OS windows.

> **Surface sizing classification.** Two kinds of surface, by sizing:
> - **Terminal surfaces** — a tmux window's pane-tree, **cell-budget driven** (`cols×rows`).
>   This includes the **driver console**: it runs in a real `$driver` tmux session and
>   renders to a grid exactly like vim. Its *content* happens to be an agent TUI, but its
>   *sizing* is a normal terminal grid. (Its magenta accent + tinted background are a
>   **visual cue only** — they do NOT change its sizing classification.)
> - **Non-terminal surfaces** — **browser (iframe)** and **settings**. These get a
>   **pixel box** and render as normal responsive DOM — there is **no tmux grid** behind
>   them. The cell-budget contract does NOT apply.

**The contract:** tmux splits *panes within a window*; muxterm arranges *windows-as-surfaces + non-terminal panels within a workspace*. Neither crosses the line. muxterm never re-splits a tmux window; tmux never knows where its window is shown.

**Why this is low-risk — it generalizes shipped code:**
- `terminal-registry` is already position-agnostic. Re-parenting a pane into a dock slot or a popped-out document is a DOM move; the terminal stays alive and fed.
- `<mux-layout>` already renders a window's split tree. Today only the active window is mounted; the dock mounts several at once.

### Foundation: N control clients + the cell-budget handoff

The sharp edge is **per-surface sizing**. tmux sizes a *window* to the *client* viewing it (`refresh-client -C WxH`); one control connection == one client == one size.

**Solution:** one `tmux -CC` control client **per visible surface**. Each does `select-window` to its window, with `aggressive-resize on`, so tmux sizes each window to the client viewing it. Duplicate `%output` is deduped by global pane-id (`%N` — the registry is already keyed that way).

```
  Layer 2 (muxterm) owns PIXELS.   Layer 1 (tmux) owns CELLS-within-a-budget.
  The ONLY thing crossing the boundary is one number pair per surface:

        Layer 2 ──►  "surface S gets cols×rows"  ──►  Layer 1
                 ◄──  "%layout-change for S"      ◄──
```

**Convergence — one refactor, three features:** "N control clients instead of 1" is the *same* refactor that docking (per-surface sizing), multi-session (show different sessions), and the driver all require.

### Foundation: responsiveness — two decoupled clocks

A naive two-layer resize janks because both layers run on one clock: every mouse-move pixel triggers a tmux round-trip, flooding the PTY channel. Fix = **two clocks**:

```
 user drags divider / resizes OS window
        │  (fires at ~60 fps)
        ▼
 ┌─────────────────────────────────────────────┐
 │ PIXEL clock: 60fps, SMOOTH                    │  ← visual only, no backend hit
 │   CSS reflows · xterm.js letterboxes/scales   │
 └───────────────┬───────────────────────────────┘
                 │  coalesce (rAF / ~40ms) + cell-quantize
                 │  send ONLY if cols×rows actually changed
                 ▼
 ┌─────────────────────────────────────────────┐
 │ CELL clock: refresh-client -C WxH on THAT     │  ← backend, DEBOUNCED, latest-wins
 │ surface's own tmux -CC control client         │
 └───────────────┬───────────────────────────────┘
                 ▼
        tmux recomputes that window's panes → %layout-change
                 ▼
 ┌─────────────────────────────────────────────┐
 │ Layer 1: re-render split tree, xterm.js re-fit│  ← CRISP, on settle
 │ programs in panes get SIGWINCH                │
 └───────────────────────────────────────────────┘
```

- **PIXEL clock:** 60fps, smooth, CSS/xterm visual scaling, **never** touches the backend.
- **CELL clock:** fires on drag-settle *or* on crossing a cell boundary; debounced ~40ms; coalesced to the **latest** size only; no-op if the pixel change does not cross a cell boundary. (Mirror the existing inbound `stateSyncCoalescer` 40ms onto the **outbound** resize path.)

During a fast drag the grid may be ~1 frame stale (letterboxed) and snaps crisp on settle.

### Foundation: grid-size vs viewport-fit (the scale primitive)

Sizing the grid and fitting it to a screen are **two different operations in two different domains:**

```
  GRID SIZE   → CELLS  → Layer 1 (tmux) → ONE authority per window
  VIEWPORT FIT → PIXELS → Layer 2 (per-viewer, client-side)
                                            CSS scale / letterbox / scroll
```

The shared grid lives in tmux. **How each viewer presents that grid in its own pixel box is a purely local, client-side CSS decision** — no backend, no conflict. One CSS-scale lever solves smooth resize drags, phone down-scaling, and the multi-viewer case below.

### Foundation: multi-viewer / shared-window policy

> **DESIGNED-FOR, NOT BUILT IN v1.** Concurrent multi-client support and the
> MIRROR/FOLLOW/SOLO policy are **not implemented in steps 0–5**. This section
> exists to keep the door open: the device-agnostic seams — **S2** (client pool
> per visible surface) and the **grid-vs-fit CSS-scale primitive** — preserve the
> ability to add it as a future increment without rework. v1 assumes a single
> viewer per session view (see *Clarification: backend control clients vs browser
> clients*). Treat everything below as forward-looking design, not v1 build work.

Two **separate** viewers on the same session at different sizes (desktop + phone, or two people pairing) is the genuine tmux multi-client problem.

**The physics you can't beat:**

```
   ONE tmux window  =  ONE character grid  =  ONE size.
   vim/htop renders to a SINGLE cols×rows buffer.
   You cannot hand two differently-sized clients a native-fit of the
   SAME running program. There is only one grid to go around.
```

tmux's `window-size` option (`smallest` / `largest` / `latest`) plus `aggressive-resize` chooses the grid authority; each viewer then **fits** that shared grid to its own pixel box via client-side CSS scale. The resolution policy is a **knob** (mechanism, not policy):

```
  MIRROR (smallest + scale) — pairing/presentation; everyone sees identical content.
  FOLLOW (latest)           — grid follows the active device; idle one scales.
                              (Default for one-user-many-devices.)
  SOLO (checkout)           — window live in one viewer; others get read-only mirror.
```

### Foundation: device-agnostic seams (leave the door open for phones)

> **Not building phone support now.** A phone is just the extreme end of the responsive axis: tiny cell budget, one visible surface, others become a switcher. Hold five seams clean now (each costs ~nothing) so phones drop in later for free.

```
 S1  Layer 2 supports a "single-surface / stacked" layout as a FIRST-CLASS mode
     (= phone, = desktop fullscreen) — not a desktop afterthought.

 S2  Control clients pooled per VISIBLE surface, with "how many stay warm" a
     POLICY KNOB (desktop: keep N warm; phone: keep 1 active, suspend rest).

 S3  ALL resize triggers funnel through ONE input-agnostic entry point
     setSurfacePixelBox(surface, box) — mouse-drag / media-query / touch /
     orientation / OS-window-resize. Measure via a per-surface ResizeObserver,
     NOT global window.innerHeight.

 S4  "Presentation mode" is an OPEN strategy set over a presentation-agnostic
     surface model: docked · popped-out · fullscreen-single.
     Phones only ever use fullscreen-single.

 S5  Resize is ALWAYS async fire-and-forget + reconcile, never a synchronous
     handshake (protects high-latency cellular).
```

---

## Components & Responsibilities

### Controller pool (step 0 — the spine)

```
  REFACTOR:  sessionManager{ one ctrl }  ──►  controllerPool{ session → ctrl }
             - lazily attach a `tmux -CC` client per session, on first view
             - detach/suspend when no surface shows it (policy knob from S2)
```

The pool of 1 renders the current single surface **identically** — this step ships invisibly.

> **Clarification: backend control clients vs browser clients.** The spine
> refactor is about **N tmux control clients on the BACKEND↔tmux side** — one
> `tmux -CC` per visible surface — **not** about N concurrent BROWSER↔server
> WebSocket clients. v1 assumes a **single browser client (one viewer) per
> session view**: step 1 multi-session is *one user switching which surface is
> shown* over the existing single WebSocket, and step 2's dock is *one browser*
> driving several backend control clients at once. Concurrent **multiple browser
> viewers on one session** is the deferred multi-viewer feature (see *Foundation:
> multi-viewer* and *Rollout: Deferred*). Backend-client fan-out ≠ browser-client
> fan-out.

### Multi-session (step 1 — proves the pool)

```
  PROTOCOL:  ClientMessage gains a `session` tag.
             dispatchAction() routes to the right controller in the pool.
             %output deduped by GLOBAL pane id (%N) — registry already keyed so.

  UX:        - wire the existing inert <mux-session-picker> modal
             - add a session switcher in the status bar
             - switch = mount that session's active window as the current surface
```

**Why step 1, not the dock:** it is the cheapest possible pool consumer. It exercises everything dangerous — N clients, per-session attach/detach, the WS `session` tag, output dedup — while the UI still shows **one surface at a time** (no dock, no float, no sizing-across-surfaces). If the pool is wrong, you find out here, cheaply, with an independently valuable feature.

**Existing seams:** the `TmuxEngine` interface is the routing boundary; `%sessions-changed` is already parsed (just not yet plumbed to advertise the session list).

Step 2 (the dock) is then a pure *generalization*: "mount one session's active window" becomes "mount N surfaces, each its own pool client," and the cell-budget/sizing machinery kicks in.

### Dock + pop-out (steps 2–3)

The dock (step 2) is the Layer-2 workspace manager: it arranges surfaces into regions, tabs, and the single-surface/stacked mode (S1/S4). Pop-out (step 3) is a presentation strategy over the same surface model:

```
  pop-out  → window.open second OS browser window, same Go backend (multi-monitor)
```

> **No in-page float.** The in-page floating-overlay concept was cut (see *UX & Chrome*); the only "detach" verb is **pop out** to a real OS window. The grid-vs-fit CSS-scale primitive stays — it's still used by resize, phone down-scaling, and the deferred multi-viewer case.

It uses the **grid-vs-fit scale primitive**: moving a surface to a popped-out window is a DOM re-parent + a re-budget of `cols×rows`; the terminal stays alive via the registry.

> **One-window-one-surface invariant (v1):** a tmux window lives in exactly one surface. Pop-out **moves** the surface, never duplicates it (see *Failure Modes*).

### Driver (step 4) — standalone agentic TUI on Amplifier

The driver is **not embedded in muxterm's Go backend.** It is a separate Amplifier-foundation TUI app (Python) running inside a **dedicated tmux session** (`$driver`), surfaced by muxterm as a normal Layer-2 surface. The "driver console surface" is just muxterm rendering this agent-TUI's tmux pane — exactly like it renders vim. It is built *on* Amplifier but is explicitly **not** amplifier-app-cli.

> **SCOPE BOUNDARY — what this plan builds vs. documents.** This plan implements
> **ONLY the muxterm-side integration**: render the `$driver` tmux session as a
> normal Layer-2 surface, plus the optional `[driver] autostart` / `launch`
> config. The standalone driver **application package** (`muxterm-agent` /
> `amplifier-app-muxterm`) is a **SEPARATE plan/repo**. Everything below about the
> embedding contract, the 7-step lifecycle, the orchestrator, the protocol seams,
> the goal/evaluator loop, and the custom tool module is recorded here as
> **context / interface contract — NOT as in-scope build work for this plan.**
>
> **Step 4 ships Tier-1 only.** The driver renders as a surface and drives via
> global tmux pane IDs (pure tmux). **Tier-2** (`MUXTERM_CTL` Layer-2 surface
> manipulation) is **out of this plan's critical path** — it is already an Open
> Question, and step 4 is shippable Tier-1-only without it.

```
        ┌─────────────────────────────────────────────────────┐
        │  DRIVER = Amplifier-foundation TUI app               │
        │  runs in a dedicated tmux session "$driver"          │
        └───────────────┬─────────────────────────────────────┘
                        │ hard dependency
                        ▼
        ┌─────────────────────────────────────────────────────┐
        │  the local TMUX SERVER  (the universal substrate)    │
        └───────────────┬─────────────────────────────────────┘
            ▲           ▲            ▲              ▲
        muxterm     iTerm2      Terminal.app   plain `tmux attach`
        (renders    (renders    (renders        (renders the
         $driver)    $driver)    $driver)         driver TUI)
```

**Embedding contract** (from `amplifier-foundation`; see `foundation:docs/APPLICATION_INTEGRATION_GUIDE.md`) — the 7-step lifecycle:

```
  load → compose → prepare(once, expensive) → create_session(cheap)
       → mount(runtime-bound tools) → hook(streaming) → execute(goal)
```

- Build on **amplifier-foundation + amplifier-core**; do **not** depend on amplifier-app-cli.
- Four protocol seams the TUI implements:
  - **ApprovalSystem** → TUI approval dialogs
  - **DisplaySystem** → output panel
  - **StreamingHook** (register on `"*"` events) → TUI widgets
  - **Spawn** capability → sub-agents
- Orchestrator: **loop-streaming**. Context: **context-persistent**, `auto_save` → the **singleton-session pattern** (the session *is* the app).
- Terminal-driving = a custom **Tool** (recommended `tool-muxterm-pane`, mounted post-creation with a live pane reference) **or** `tool-bash` + tmux; sub-agent delegation via `tool-task`.

**Driver UX** (mirrors Claude Code agent/goal mode):

```
 ┌ status line ─ "◉ goal active · 3 turns · 14m · 4.2k tok · <last eval feedback>"
 │ streaming transcript  (agent text · tool calls · results, interleaved)
 │ side: todo/plan list  (pending · in-progress · done)
 └ input prompt + approval gates  (hard / soft / budget)
```

Goal mode = `/goal <completion-condition>` → the agent loops autonomously; a small fast **evaluator model** checks the condition after each turn and feeds back until met. Amplifier's ApprovalSystem maps to the TUI's approval gates, so destructive `send-keys` is gated by the embedding, not hand-rolled.

**Portability (critical user requirement)** — the driver's hard substrate is the local **tmux server**, not muxterm. Two tiers, capability-detected:

```
 TIER 1 — universal  (hard dep: tmux)          WORKS IN ANY TERMINAL CLIENT
   send-keys -t %N · capture-pane -t %N · new-window · list-sessions
   → the agent's entire core driving ability. No muxterm needed.

 TIER 2 — enhanced  (soft dep: muxterm)         WORKS ONLY INSIDE MUXTERM
   pop out window @4 · open beside · arrange surfaces (Layer-2)
   → detected via an env var muxterm injects into panes it spawns
     (e.g. MUXTERM_CTL=/path/to/sock). Absent → silently skipped.
```

Launch `$driver` from iTerm2 and you get the full agentic driver over your tmux sessions — it just can't rearrange muxterm's workspace (there isn't one). Inside muxterm, the same binary lights up Tier 2 via capability detection. Graceful degradation, zero hard coupling.

**Ownership / packaging:** the driver is its own package/repo (`muxterm-agent` or `amplifier-app-muxterm`), depending on **amplifier-foundation + amplifier-core + tmux — not on muxterm**. Optional custom tool module `amplifier-module-tool-muxterm-pane` (modules depend only on amplifier-core). muxterm "ships it as a strong opinion" = recommends/bundles/offers to launch it; the two are decoupled and coordinate only through tmux; either is swappable. Precedent: amplifierd (HTTP/SSE daemon), amplifier-chat, the terminal-tester bundle.

### Config (muxterm-owned knobs only)

**Principle:** tmux internals are an implementation detail muxterm *manages* — never a user-facing knob. `mouse`, `focus-events`, `window-size`, and `aggressive-resize` are **load-bearing** (muxterm requires them for mouse forwarding, focus tracking, and the per-surface N-client sizing model); exposing them invites users to break the app. Config exposes only muxterm's **own** presentation and behavior — "replace a default I already control," never reach into tmux.

```
  ~/.config/muxterm/config.toml
    (server reads at startup → ships resolved config to client on full-sync;
     one source of truth; no hot-reload in v1, restart to apply; no per-pane overrides)

  [theme]      palette = "tokyo-night"        # overrides theme.ts
  [font]       family = "...", size = 13      # overrides terminal-registry.ts:18
  [terminal]   cursor_style = "block"         # xterm.js presentation
               cursor_blink = true
               scrollback = 10000             # xterm.js display buffer
               bell = "visual"                # visual | audible | off
  [keys]       # muxterm's OWN UI actions ONLY — never tmux keys
               next_session    = "ctrl+shift+]"
               split           = "ctrl+shift+\\"   # ⊟ split (more terminals here)
               maximize_region = "ctrl+shift+m"    # ⊡ focus one region
               pop_out         = "ctrl+shift+o"    # ⧉ separate OS window
               open_launcher   = "ctrl+shift+p"    # global ⋯ launcher
               focus_driver    = "ctrl+shift+a"
  [workspace]  default_presentation = "docked"   # docked | single
               rails = ["sessions"]              # which Layer-2 rails show
  [driver]     autostart = false                 # spawn $driver session on boot
               shared_window_policy = "follow"   # reserved — multi-viewer is post-v1 (mirror | follow | solo)
               launch = "muxterm-agent"          # the binary to run in $driver
```

**Non-goals (explicit):** no tmux-passthrough, no hot-reload in v1, no per-pane overrides. Malformed config → fall back to hardcoded defaults, log a warning, run.

**Keybinding timing:** the `[keys]` actions (`split`, `maximize_region`, `pop_out`, `open_launcher`, `focus_driver`) are **bound as their features land** (steps 2–4) with sensible hardcoded defaults — they don't wait for step 5. Step 5 only *formalizes* them into the config file (makes the defaults overridable).

### UI polish (step 5 — last)

A **consistency pass, not a redesign**, deliberately sequenced last so we don't polish components about to be restructured into the dock:

- unify styling across the new dock chrome (tab-bar, status-bar, session-picker, reconnect-overlay, dividers, pop-out controls);
- make all of it theme-driven (consumes `[theme]` config);
- tighten today's functional stubs (session-picker is inert, status-bar is minimal).

Kept generic intentionally (YAGNI) — no specific changes the user didn't ask for. (Specific polish itches are an open question.)

---

## UX & Chrome

Validated with the user via interactive mockups. Visual language is **VS Code-style
chrome** on the **Tokyo Night** palette (accent `#7aa2f7`).

**Guiding principle — chrome follows what's VISIBLE, not what EXISTS.** Solo (one
region) = minimal chrome; dock (N regions) = the global tab row dissolves and each
region carries its own slim header. Clutter scales with what you're *looking at*,
not with what the workspace contains. This reuses the **S1** single-surface seam.

```
  SOLO (one region)                     DOCK (N regions)
  ┌──────────────────────────┐          ┌─────────────┬─────────────┐
  │ [session▾] editor shell  │          │[sess▾] edit │[sess▾] logs │  ← per-region
  │  ── one tab strip ──      │          │ shell       │             │     headers
  │                          │          ├─────────────┴─────────────┤
  │     terminal body        │          │  (no global tab row)      │
  └──────────────────────────┘          └───────────────────────────┘
   minimal chrome                         chrome distributed per region
```

### User-facing model — "surface" is INTERNAL, never shown

Users never choose "pane vs surface." They pick an **intent**:

- **Split** = "more terminals here" (same session, a tmux pane). Everyday, tmux-native.
- **Cross-boundary actions exposed by intent:** open another session, pop out, open
  driver / browser / settings.

A region can hold: a **terminal** (tmux window), the **driver console**, a **browser**
(iframe), or **settings**. Terminals are driven by the `cols×rows` cell-budget — and
**the driver console is a terminal surface** (a tmux pane in the dedicated `$driver`
session, cell-budget driven, exactly like vim); its *content* is an agent TUI, and its
magenta accent + tinted background are a **visual cue only** that does NOT change its
sizing classification. Only **browser · settings** are truly non-terminal: they **get a
pixel box and render as normal responsive DOM — no tmux grid.**

### Three "add" verbs — location + icon + result each encode the layer

Never confusable, because each verb has a distinct gesture, glyph, and outcome:

```
 ① New PANE   (tmux)     →  ⊟ split in the region "⋯" menu (or tmux prefix-%)
                            → thin tmux divider inside the window
 ② New WINDOW (tmux)     →  [+] at the end of the region's tab strip
                            → another tab
 ③ New REGION (muxterm)  →  global "⋯" launcher (opens beside) OR drag a tab out
                            → heavy ⋮-handled muxterm divider
```

Two **divider weights** make layout readable at a glance:

```
  thin  │     = tmux pane boundary   (Layer 1)
  heavy ┃⋮    = muxterm region boundary, with grab handle  (Layer 2)
```

### Final chrome vocabulary

```
 TITLE BAR:  branding (left)  ···············  ⋯ global launcher (right)

 REGION TAB STRIP  (VS Code-style, one per region):
     [session ▾]  [ ⬡ editor ×  shell  logs ]  ·········  ⊡ maximize   ⋯ more
       ^session picker      ^window tabs                    ^region controls

 INSIDE REGION:  tmux panes (⊟ split) · drag dividers to resize

 STATUS BAR:  ● session · window · pane ····· ◉ goal (driver active) · theme · N regions · ⟳
```

- **Session chip `▾`** = per-region **session picker**, the PRIMARY navigator: switch
  this region's session · `+ new session`. (Switching a region's session updates its
  window tabs.)
- **Window tabs** = VS Code-style: active tab has a thin top accent line + a background
  merging into the body ("connected"), a file-type icon + label + close `×`; a **dirty
  dot** replaces `×` for a running/modified window.
- **Region `⋯` more menu:** Split right · Split down · Pop out to window · Rename window
  · Close region.
- **Global `⋯` launcher** (title bar): New session · New browser · Open driver ·
  Settings · Keyboard Shortcuts · Reconnect · About. New content opens **beside** the
  focused region.
  - **Surface kind at creation:** **"Open driver" creates a TERMINAL surface**
    (cell-budget grid); **"New browser" and "Settings" create NON-TERMINAL surfaces**
    (pixel box). "New session" / window tabs are terminals as usual.

### Spatial verbs — final, non-overlapping set

```
 ⊟ split       → more terminals here (same window)
 open beside    → new region (via launcher, or drag a tab out)
 ⧉ pop out     → separate OS window (multi-monitor)
 ⊡ maximize    → focus one region
```

**"Open beside" clarified:** it means "show content in a NEW region beside the current
one." It is **not** a standalone menu item (that was confusing and was removed from the
session dropdown). New content opens beside via the **global launcher**; pulling an
*existing* window into its own region is the **drag-tab-out** gesture.

### Visual style

VS Code tab/button language — flat seamless tabs (no cards), active tab top-accent
connected to the body, flat borderless icon-buttons with hover background. Palette stays
**Tokyo Night** (accent `#7aa2f7`). The **driver region** uses a **magenta accent
(`#bb9af7`) + a slightly tinted background** to read as special / non-terminal.

### Storyboard (each flow entered by a distinct intent)

```
  split            → "more terminals here"          (⊟ in region ⋯)
  switch session   → session dropdown               ([session ▾])
  open beside      → → dock, two regions            (global ⋯ launcher / drag tab out)
  pop out          → → separate OS window           (⧉)
  open driver      → → driver region + /goal        (global ⋯ → Open driver)
```

### Deployment modes — adaptive title bar

```
 BROWSER TAB  (baseline, ships first):
     render an IN-PAGE title row (branding + ⋯). Costs one extra row, but it's
     necessary — otherwise branding only lives in the browser tab title
     (undiscoverable). This is the v1 baseline; works in every browser.

 PWA + Window Controls Overlay  (DEFERRED — progressive enhancement, NOT v1):
     same title content (branding + ⋯) painted into the OS window strip via
     env(titlebar-area-*) + @media (display-mode: window-controls-overlay);
     feature-detect with navigator.windowControlsOverlay.visible. Requires a web
     manifest + display_override:["window-controls-overlay"] + installability.
     The extra in-page row disappears in this mode. Layer it on later.
```

---

## Data & Control Flows

### Resize propagation (one surface)

See *Foundation: responsiveness*. The single contract crossing the layer boundary is `cols×rows` per surface; the PIXEL clock keeps the UI smooth while the CELL clock debounces the backend round-trip.

### Multi-session routing

```
  client action ──► ClientMessage{ session tag } ──► dispatchAction()
       │                                                  │
       │                                       route to pool[session].ctrl
       ▼                                                  ▼
  %output from each ctrl ──► dedupe by global %N ──► terminal-registry (keyed by %N)
```

### Driver reach

```
  DRIVER ENGINE (Amplifier TUI in $driver session)
        │ tmux commands (pane IDs %N are server-global)
        ▼   send-keys -t %N / capture-pane -t %N reach ANY session
  any session / window / pane
        │ (Tier 2 only, inside muxterm)
        ▼   MUXTERM_CTL socket → arrange Layer-2 surfaces
  muxterm workspace
```

---

## Failure Modes

The architecture **contains blast radius to a single surface** — the controller pool isolates each surface's control client.

```
  control client dies        → reconnect w/ backoff (existing reconnect.go);
                               ONLY that surface shows the reconnect overlay.
                               Pool isolates it — other surfaces keep running.

  session vanishes           → surface shows "session ended"; siblings untouched.
  (all windows closed /
   tmux killed)

  resize race / tmux rejects → eventual consistency: newest size out, newest
   size                        layout rendered; 5s full-snapshot self-heals.
                               (idempotent reconcile; no versioning.)

  same window → two surfaces  → PREVENTED by the one-window-one-surface invariant.

  pop-out window closed       → client detaches; content still lives in tmux;
                               re-mount the window into any surface.

  driver crashes              → it's just a surface + a tmux session. Restart the
                               $driver binary. Decoupled via tmux → drives nothing
                               while down, breaks nothing. Approval gates cap the
                               runaway-destructive-send risk.

  config malformed            → fall back to hardcoded defaults, log warning, run.
```

---

## Tradeoffs

- **One-window-one-surface invariant (v1).** A tmux window has exactly one grid at one size; allowing the same window in two differently-sized surfaces is irreducible conflict. We forbid it in v1 (pop-out *moves* the surface). This is a deliberate simplification — the genuine two-separate-viewers case is handled by the shared-window policy knob, not by duplicating a window inside one workspace.
- **No backend versioning for resize.** We rely on eventual consistency (newest-wins + 5s self-heal) instead of a size-version protocol. Simpler; accepts ~1 frame of staleness during fast drags.
- **Driver decoupled via tmux, not embedded.** Costs a process boundary and a capability-detection seam (Tier 1/2), buys portability (works from any terminal client) and swappability (someone can ship a different driver). Explicitly the right trade per the portability requirement.
- **Config exposes muxterm knobs only.** No tmux passthrough means users can't tune tmux through muxterm — but it protects the load-bearing settings the whole sizing model depends on.
- **Polish last.** Visible improvement comes later, but we avoid polishing UI we're about to restructure.

---

## Testing / Verification Strategy

> **Decision: rip out the existing OCR verification currently hooked up** (the plan phase pins the exact files to delete). Replace it **entirely** with a 3-source model. No OCR anywhere.

The verification harness is **build-early infrastructure** — it lands with or just before step 2 (the dock). It is the lifeline for hooking up panes: you do not re-parent panes (dock mount of N surfaces, divider-drag resize, pop-out) without it in hand. This makes the dangerous steps **self-verifying as you build them** — every re-parent is checked against tmux truth *and* browser reality, exactly where blank/dup/lost-content bugs hide.

### Three sources, each in its lane

```
  ┌ SOURCE OF TRUTH ───────────────────────────────────────────────┐
  │ tmux capture-pane        "what SHOULD exist"                    │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │  content fidelity assertion
  ┌ LOGICAL RENDER ──────────────▼─────────────────────────────────┐
  │ xterm.js buffer snapshot "what muxterm rendered, to the blank"  │
  │   cells {char,fg,bg,attrs} · cursorX/Y · viewportY/baseY        │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │  layout / scroll fidelity assertion
  ┌ PHYSICAL RENDER ─────────────▼─────────────────────────────────┐
  │ playwright-cli           "what the BROWSER actually shows"      │
  │   real scrollTop / visible row · clientWidth · element geometry │
  │   · responsive breakpoint state · CSS-layer facts               │
  └────────────────────────────────────────────────────────────────┘
```

- **tmux capture-pane** → the oracle: "what should exist."
- **xterm.js buffer snapshot** → logical render "down to the blanks" (replaces OCR). API present in `@xterm/xterm ^6.0.0`:

```
  term.buffer.active            → cursorX, cursorY, viewportY, baseY, length
    .getLine(y): IBufferLine
        .translateToString(false)        → full row text INCLUDING trailing blanks
        .getCell(x): IBufferCell
            .getChars() · .getWidth()
            .getFgColor() · .getBgColor()
            .isBold() · .isInverse() · .isUnderline() · ...
```

  Serialize any pane to a `StructuredSnapshot` (a `rows × cols` grid of `{char, fg, bg, attrs}` + cursor position + scrollback depth). Expose it once from the registry: `terminalRegistry.snapshot(paneId) → StructuredSnapshot`; reach it in tests via Playwright `page.evaluate()`.
- **playwright-cli** → the physical render the browser actually shows: real `scrollTop` / visible row, `clientWidth`, element geometry, responsive breakpoint state — CSS-layer facts the logical buffer cannot know.

### Two assertion chains

```
  CONTENT fidelity :  tmux capture-pane   ==  xterm.js snapshot
                      (kills the blank-tab / duplicated-content / lost-window
                       bug class — exactly what commits b978c7a, 8ed7cef fought)

  LAYOUT fidelity  :  xterm viewportY + dims  ==  playwright-cli
                      measured scroll position + rendered width
                      (catches fit miscalcs, scroll drift, responsive bugs)
```

**Boundary note:** the xterm.js snapshot is a muxterm **client-side** verification primitive (tests + diagnostics). The portable **driver** still reads screens via `capture-pane` (Tier 1, works in iTerm2) — the snapshot is **not** a driver dependency.

### Concrete tasks

```
  - remove the OCR hookup (locate + delete; plan phase pins exact files)
  - add terminalRegistry.snapshot(paneId) → StructuredSnapshot
  - expose it to Playwright via a page.evaluate() test hook
  - encode the two fidelity assertions as reusable test helpers
```

### Coverage (TDD per step, tests-first; extends existing Vitest + Playwright + Go test)

```
  Go unit      — pool attach/detach/route · %output dedup across N clients ·
                 session-vanish handling · session-tagged dispatchAction
  TS unit      — px→cells cell-budget math · outbound resize coalescer
                 (debounce · latest-wins · no-op when no cell boundary crossed) ·
                 surface lifecycle · config parse + override + malformed-fallback
  Playwright   — multi-session switch (step 1) · dock mount of N surfaces ·
                 divider-drag resize propagation · pop-out ·
                 responsive collapse
  Driver pkg   — own repo/tests; exercise the terminal-driving tool against a
                 REAL tmux server (terminal-tester bundle pattern)

  Deferred (lands with multi-viewer, NOT v1):
               — shared-window policy (mirror / follow / solo) Playwright coverage
```

Multi-session (step 1) is where the pool's dangerous paths get coverage **before** the dock builds on them.

---

## Rollout Sequence

```
 0. Controller pool refactor      invisible; pool of 1 == today
 1. Multi-session switch          cheapest pool consumer — proves the spine
    ── verification harness ──     build-early; lands with/just before step 2
 2. Layer-2 workspace + surfaces  the dock; tmux window = a surface
 3. Pop-out presentation          no in-page float; CSS-scale primitive; window.open second OS window
 4. Driver console surface        muxterm-side integration only; Tier-1 only —
                                  render $driver tmux session as a surface +
                                  [driver] autostart/launch config. (Driver app
                                  package itself = separate plan/repo.)
 5. UI polish + config            woven through; polish sequenced last
```

Each step is independently shippable. The verification harness is sequenced as enabling infrastructure for the pane work in steps 2–3.

### Deferred (seams preserved, NOT in steps 0–5)

```
  - concurrent multi-viewer on one session (multiple browser clients, one session)
  - MIRROR / FOLLOW / SOLO shared-window policy
  - PWA installability + Window Controls Overlay title bar
    (progressive enhancement; baseline is the in-page title row — see UX & Chrome)
```

The device-agnostic seams (S2 client-pool-per-visible-surface, the grid-vs-fit
CSS-scale primitive) keep the door open for these without rework; they are a
future increment, not v1.

---

## Open Questions

- **Pop-out OS window control ownership.** Does a `window.open` popped-out window own its own control client directly, or proxy size/IO back to the main document over a shared channel? (The next-trickiest bit; not yet resolved.)
- **Tier-2 control channel shape.** The concrete `MUXTERM_CTL` socket protocol for Layer-2 surface manipulation — design when step 4 lands, not before.
- **OCR removal targets.** The exact files comprising the current OCR hookup to remove (locate in the plan phase).
- **Specific UI-polish itches.** Left generic by user preference; capture named items if/when the user wants them.
