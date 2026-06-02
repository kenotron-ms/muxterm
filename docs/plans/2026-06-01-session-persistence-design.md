# muxterm Session Persistence & Multiplexing Re-Architecture Design

## Goal

Re-architect how muxterm keeps terminal sessions alive: move from *"tmux is the
multiplexer, driven via control mode (`-CC`), and the web renders tmux's layout"*
to *"the browser **is** the multiplexer, and a small, dumb Go daemon keeps PTYs +
scrollback alive."*

**North-star success criterion:** the end-to-end, user-perceived
session-create feel must be as fast as possible. The current control-mode
`new-window` handshake latency is the specific pain this design eliminates.

## Background

Source research notes: [`docs/research/session-persistence.md`](../research/session-persistence.md)

### Current state (confirmed by codebase survey)

- muxterm is **pure Go + TypeScript/Lit**. There is no Python, no FastAPI, and no
  AGENTS.md — so the research doc's "Go vs Python discrepancy" open question is
  moot and dropped.
- Today muxterm runs `tmux -CC attach-session` over a PTY (`creack/pty`).
  Server-side tmux drives panes/windows/splits (`split-window`, `new-window`,
  `kill-pane`, `refresh-client -C`), with `history-limit 10000` and per-pane
  scrollback replay via `capture-pane -e -S -10000`.
- The client already runs **one xterm.js per pane** (`web/src/lib/terminal-registry.ts`),
  and there is existing binary WebSocket framing: `[4-byte LE paneID][data]`.

### Why this pivot is the only honest path

The key realization that justifies the whole effort: **you cannot drop control
mode while keeping tmux as the multiplexer.** The `-CC` protocol exists precisely
to drive tmux's multiplexing. Therefore "kill the latency" and "make the browser
the multiplexer" are not two decisions — they are the same decision.

Prior art validates the two-process backbone: `zellij web` also runs a long-lived
session server that owns PTYs/state plus a separate web server that bridges
browser WebSockets to it. The difference is that Zellij multiplexes **server-side**
and ships rendered frames, which would require us to *build* a server-side
compositor + VT render engine. muxterm already renders client-side (one xterm.js
per pane), so the browser-as-multiplexer model is strictly **less** work for us.

## Approach

**Approach A — a custom Go persistence daemon with a hand-rolled "Level 1"
scrollback buffer.**

Rejected alternatives:

- **tmux-plain stripped to a keepalive** — keeps a tmux dependency the user is
  scarred by.
- **abduco/dtach as a keepalive kernel** — adds a C dependency and introduces a
  restart-window history gap.
- **Zellij-style server-side multiplexing** — requires building a server-side
  compositor + full VT render engine; more work, not less.

`charmbracelet/x/vt` is explicitly held **in reserve** as a swappable "Level 2"
buffer implementation, to be adopted only if Level-1 fidelity ever proves
insufficient. It is **not** adopted now (it is experimental / pre-1.0).

## Dependencies / build-vs-leverage

The external dependency footprint is deliberately tiny \u2014 `creack/pty` +
`charmbracelet/x` \u2014 everything else is stdlib or hand-rolled.

| Building block | Choice | Verdict |
| --- | --- | --- |
| PTY allocation/resize/lifecycle | `github.com/creack/pty` | **Leverage** \u2014 the Go standard; `Setsize`, process lifecycle |
| ANSI/VT escape-sequence parsing | `github.com/charmbracelet/x/ansi` | **Leverage** \u2014 feeds bytes \u2192 emits parsed CSI/SGR/DEC-private-mode/OSC sequences |
| Headless VT emulator (Level 2 reserve) | `github.com/charmbracelet/x/vt` | **Reserve** \u2014 swaps in behind `PaneBuffer` if Level 1 fidelity is insufficient |
| Daemonize / detach / reparent | `golang.org/x/sys/unix` (`Setsid` via `SysProcAttr`) | **Hand-roll on stdlib** |
| systemd integration (optional) | `github.com/coreos/go-systemd` | **Consider** \u2014 socket activation / `sd_notify`, only if systemd-first |
| Unix-socket framing | stdlib (`encoding/json` or `gob` + 4-byte length prefix) | **Hand-roll** \u2014 trivial |
| Scrollback ring buffer | hand-rolled slice + head/tail (~40 lines) | **Hand-roll** |
| Web-terminal prior art | `gotty` (aging, 2015) | **Learn from**, don't reuse |

**The key decision \u2014 ModeTracker is policy on top of a proven parser, not a
from-scratch parser.** Our highest-risk component was "hand-roll a byte-level
escape parser to track sticky state." `charmbracelet/x/ansi` is a standalone ANSI
parser state machine (**not** a grid emulator): feed it the PTY byte stream, it
emits parsed CSI / SGR / DEC private modes (incl. `?1049h/l`) / **OSC 0-2 window
title**. So we hand-roll only the *policy* \u2014 the two-tier buffer, the sticky-state
snapshot, the synthetic preamble \u2014 on top of it. OSC title extraction (for
`pane.title`) comes for free from the same parser. This shrinks the "Level 1
hand-roll" to the part that is genuinely ours.

**Honest dependency caveat (given the project's aversion to fragile deps):**
`charmbracelet/x` is versioned `v0.0.0` (experimental, breaking changes possible).
It is reputable (Charm) and production-used, and \u2014 critically \u2014 it sits **behind
the `PaneBuffer` interface**, so its blast radius is contained. Escape hatches if
it ever becomes a problem: `github.com/Azure/go-ansiterm` (stable, callback-based,
less ergonomic) or a hand-rolled parser. This is an acceptable, contained risk;
the alternative (hand-rolling the byte-level parser now) trades a small dependency
risk for a larger correctness risk in the hardest code.

## Architecture

### Lifetime model

Two-process runtime connected by a Unix socket:

- **`muxterm serve`** — HTTP + WebSocket, stateless, restarts often.
- **`muxterm sessiond`** — long-lived daemon owning all PTYs + buffers.

```
        ┌──────────────────────────────────────────────────────────┐
        │ browser (THE multiplexer)                                  │
        │  ├─ owns layout / arrangement                              │
        │  └─ one xterm.js per pane                                  │
        └───────────────▲───────────────────────────────────────────┘
                        │  WebSocket: existing binary framing
                        │  [4-byte LE paneID][data]
        ┌───────────────▼───────────────────────────────────────────┐
        │ muxterm serve   (stateless, restarts often)                │
        │  └─ thin relay/translator, holds NO terminal state         │
        └───────────────▲───────────────────────────────────────────┘
                        │  Unix socket: length-prefixed frames
                        │  $XDG_RUNTIME_DIR/muxterm/sessiond.sock
        ┌───────────────▼───────────────────────────────────────────┐
        │ muxterm sessiond  (long-lived, owns PTYs + buffers)        │
        │  ├─ Registry: panes + workspaces                           │
        │  ├─ Pane = 1 PTY + RingBuffer + ModeTracker + subscribers  │
        │  └─ SocketServer                                           │
        └────────────────────────────────────────────────────────────┘
```

Key properties:

- The **browser is THE multiplexer** and owns layout. tmux, control mode, and all
  server-side `split-window` / `new-window` / `refresh-client` logic are **deleted**.
- One PTY = one rectangle. Create = fork a PTY (sub-millisecond, zero handshake).
  This meets the create-latency north star **by construction**.
- The daemon replaces tmux's persistence role. The separate-service model
  sidesteps the fiddly per-session daemonization/reparenting. Net process count is
  unchanged versus today (the tmux server is swapped for `sessiond`).
- `serve ↔ browser` keeps the **existing** binary WebSocket framing.

### One binary, two roles: lifecycle & restart survival

A single binary exposes two roles/subcommands: `muxterm sessiond` and
`muxterm serve`. The daemon listens on `$XDG_RUNTIME_DIR/muxterm/sessiond.sock`.

```
muxterm serve            # web role (ephemeral)
  └─ on start: is the daemon socket live?
       ├─ yes → connect
       └─ no  → spawn `muxterm sessiond`, detach, then connect

muxterm sessiond         # daemon role (long-lived, owns PTYs + buffers)
  └─ listens on $XDG_RUNTIME_DIR/muxterm/sessiond.sock
```

**Auto-spawn (the abduco trick):** when `serve` finds a dead socket, it launches
`sessiond` via `setsid` + a double-fork so the daemon reparents to init/PID 1,
with stdio redirected to a logfile. The web process can then exit/restart freely;
the daemon is no longer in its process tree. This covers dev, manual, and SSH runs.

**Honest caveat — systemd:** under systemd, `setsid` is **not** enough. systemd
kills a unit's entire cgroup on `systemctl --user restart` (default
`KillMode=control-group`), so a daemon spawned inside the web unit's cgroup gets
killed with it — exactly the failure persistence is meant to prevent. Therefore:

- **Under systemd (the install path):** the daemon must be its **own unit**
  (`muxterm-sessiond.service`). The web unit declares `Wants=` / `After=` it.
  Separate unit = separate cgroup = survives web restart. `muxterm install` wires
  **both** units.
- **Everywhere else (dev, manual, SSH):** the auto-spawn/detach path is the
  fallback.

So "one binary" holds, "auto-spawn" holds for the manual case, but **restart
survival under systemd specifically requires the daemon to be its own unit** —
auto-spawn alone would silently fail there.

## Components

The daemon (`sessiond`) stays deliberately dumb.

```
sessiond
├── Registry          # the single source of truth
│   └── workspaces: map[workspaceId] → Workspace
├── Workspace = { id, name?  (nullable), panes: map[localPaneId] → Pane }
├── Pane = { localId, title (from OSC 0/2), pty+process,
│            RingBuffer+ModeTracker, subscribers }
└── SocketServer      # Unix socket, framed protocol (see "Data Flow")
```

- **Registry** is the single source of truth, and it is keyed only by workspace:
  `workspaces: map[workspaceId]→Workspace`. There is **no** global pane map; panes
  live inside their workspace.
- **Workspace** owns its panes in a workspace-local map `panes:
  map[localPaneId]→Pane`. See "Identity model" and "Workspace lifecycle" below.
- **Pane** owns exactly one PTY + child process, a `RingBuffer` + `ModeTracker`, a
  captured `title` (from OSC 0/2), and a set of attached subscribers. Create = fork
  a PTY (sub-ms). Close = kill the process + drop the buffer. There is **no**
  split/layout logic in the daemon.
- **SocketServer** serves the Unix socket with a framed protocol.

### Identity model

- **Workspace identity = a stable, opaque, daemon-allocated `id`** (short
  monotonic/random). This `id` is the key **everywhere**: the registry, attach, and
  the client's arrangement `localStorage`.
- **Workspace `name` = an OPTIONAL display label** — nullable, and **not** a key.
  - **Default: unnamed.** A freshly created workspace gets an `id` and **no** name.
    A name is never auto-assigned at random.
  - When unnamed, the tab's displayed label is **derived from the terminal title
    sequence** (OSC 0/2 — `ESC]0;…BEL` / `ESC]2;…`) emitted by the active pane's
    program (e.g. shell cwd, `vim main.go`).
  - The user may set an **explicit** name, which overrides the derived title.
  - **No uniqueness rule** on names — `id`s disambiguate; two unnamed or
    same-titled workspaces are perfectly fine.
- **Pane id is unique only WITHIN its workspace** (`localId`, e.g. monotonic per
  workspace). A pane is addressed as `(workspaceId, localPaneId)`. Because a browser
  connection is attached to exactly **one** workspace at a time, the existing
  `[4-byte LE paneID]` wire framing carries the workspace-local id unambiguously —
  **no protocol change**.
- **ModeTracker also captures the pane title** from OSC 0/2 as part of its sticky
  state; the daemon exposes `pane.title`. The client composes each tab's label as
  `workspace.name ?? activePane.title`.

### Two-layer layout model

Layout is two layers with different owners.

**Layer 1 — Composition (device-independent, daemon-side).**
*Which panes belong to a workspace.*

```
Workspace = { id, name?  (nullable), panes: map[localPaneId] → Pane }
```

This is the entire persistence unit — the honest replacement for a "tmux session."
It is the set of live terminals that appears identically on every device, and it
has nothing to do with pixels.

**Layer 2 — Arrangement (device-specific, client-side).**
*How those panes are spatially laid out* — splits, ratios, tabs, orientation.
The daemon does **not** store layout blobs (this was explicitly dropped).
Arrangement lives in the browser, keyed by **(workspaceId, viewport profile)**, in
`localStorage` for now. *Bonus of keying on the stable workspace `id`:* a workspace
**rename does not lose its saved layout** — the arrangement key is the immutable
`id`, never the mutable display name.

On attach, the client pulls the composition from the daemon, then either restores
a saved arrangement for the current device profile **or** auto-generates a
responsive default.

*Future upgrade (not now): daemon-side profile-keyed arrangements for
cross-browser portability on the same device.*

### Responsive arrangement

Arrangement is a **responsive function of (composition, viewport class)** — not a
stored picture. Borrowing breakpoints from responsive web design, the same logical
composition renders through layout modes selected by the viewport:

```
wide   (desktop/ultrawide):  tiling  — multiple panes visible, splittable
medium (tablet/laptop):      fewer simultaneous splits
narrow (phone/portrait):     tabbed  — one pane visible, swipe/switch
```

A side-by-side split on desktop **degrades to tabs** on a phone — not stored as
"two columns," but as "these panes are peers; render them however the current
viewport class dictates."

**Consequence reaching the daemon — PTY size follows the rendered frame.** A pane
that is 100 cols in a desktop split becomes ~40 cols full-width on a phone. The
client measures each pane's actual rendered cell grid and sends
`Resize(paneID, cols, rows)`; the daemon resizes the PTY and the program reflows.
All breakpoint logic stays client-side — the daemon only ever hears "this pane is
now W×H." The daemon stays dumb.

**Multi-client sizing policy.** A PTY has exactly one size, but multiple clients
(e.g. a phone tab-visible at 40 cols and a desktop split at 100 cols) can attach
to the same pane simultaneously. Policy: **the most-recently-active view drives
the PTY size; other views reflow to fit** (matching the research doc's
`window-size latest`). A pane tabbed-away keeps its last size until re-focused.

*YAGNI guardrail:* breakpoint **preferences** (e.g. "phone defaults to pane C
visible") live in `localStorage` per device now; cross-device class-layout memory
is a future upgrade.

### The Level 1 buffer (per-pane)

Each `Pane` owns a `RingBuffer` + `ModeTracker`, behind a `PaneBuffer` interface
so a Level-2 `charmbracelet/x/vt`-backed implementation can be swapped in later
without touching the daemon or protocol.

```
Pane buffer
├── scrollback ring   # normal-screen output, budgeted ~10k lines (configurable)
├── altscreen frame   # single REPLACEABLE buffer, used while in alt-screen
└── ModeTracker       # sticky terminal state, updated as bytes stream through
```

- **scrollback ring** — normal-screen output, budgeted ~10k lines (configurable).
- **altscreen frame** — a single **replaceable** buffer used while the program is
  on the alternate screen.
- **Two-tier rule:** while on the alt-screen (`ESC[?1049h`), output goes to the
  replaceable altscreen frame, **not** the ring — so full-screen apps (htop/vim)
  never flood scrollback, and exiting (`ESC[?1049l`) cleanly discards the frame and
  returns to the ring. Normal output appends to the ring.
- **ModeTracker** keeps a tiny sticky-state snapshot: alt-screen on/off, current
  SGR (colors/attrs), cursor position, and a handful of DEC private modes
  (autowrap, cursor visibility). It is **built on the `charmbracelet/x/ansi`
  parser** \u2014 it consumes *parsed* sequences rather than scanning raw bytes itself,
  so the hand-rolled scope here is the sticky-state policy + synthetic preamble,
  **not** the escape-sequence parser.
- **Safe-boundary trimming:** when the ring exceeds budget it only trims **between
  complete escape sequences** — never severing e.g. `ESC[31m` mid-sequence.
- **Replay on attach** = `[synthetic preamble]` + `[retained ring bytes]` +
  live stream. The preamble is a small burst of escape sequences the ModeTracker
  emits to re-establish correct sticky state at the trim boundary, so xterm.js
  reconstructs colors/cursor/mode correctly despite trimmed history.
- **Accepted Level-1 limitation:** it does **not** reflow *old scrollback* on width
  change — acceptable for a replay-then-go-live model. This is the explicit reason
  x/vt is kept in reserve.

The three problems this buffer design solves:

1. **Alt-screen flooding/replay** — the two-tier rule keeps full-screen repaints
   out of scrollback.
2. **Mid-escape trimming corruption** — safe-boundary trimming guarantees no
   severed escape sequence.
3. **Lost cumulative sticky state at the trim boundary** — the ModeTracker
   preamble re-establishes colors/cursor/mode after history is trimmed.

## Workspace lifecycle

A workspace is the persistence unit — a "tmux session minus layout." Multiple named
workspaces are first-class in v1.

**Creation.**

- **Cold start:** if the daemon has zero workspaces, it auto-creates a single
  **unnamed** default workspace (id only, no name) so the user always lands
  somewhere — never an empty void.
- **Explicit:** `CreateWorkspace()` → the daemon allocates the `id` and returns it.
  A name is optional and defaults to unnamed.

**Selection / switching.**

- `ListWorkspaces() → [{id, name?, paneCount}]` drives a picker (repoint the
  existing session-picker component).
- A browser connection is attached to **exactly one** workspace at a time;
  switching = detach + `Attach(otherId)`.
- The daemon keeps **all** workspaces alive regardless of who is attached; different
  tabs/devices can sit in different workspaces simultaneously.

**Rename.** `RenameWorkspace(id, name)` sets or clears the optional display label.
No uniqueness check (ids are the key).

**First-connect bootstrap.** A fresh client with **no** stored workspaceId calls
`ListWorkspaces()` and attaches to the default — cold-start auto-create guarantees
at least one workspace exists, so the client never has to invent an id.

**Reaping (tmux parity).** When a workspace's **last pane exits**, the workspace is
auto-reaped. Both auto-reap and explicit `CloseWorkspace(id)` fire a
**`workspace-closed(id)`** event to **all** subscribers of that workspace.

**Event ordering on last-pane-exit:** when the final pane in a workspace exits, the
daemon fires `pane-closed` for that pane and **then** `workspace-closed` for the
workspace. A client that receives `workspace-closed` should treat the workspace as
gone and **ignore any trailing `pane-closed` for it**.

On receiving `workspace-closed`, a co-attached client **detaches and attaches to
the most-recently-active surviving workspace**; if none survive, the daemon
re-creates a fresh unnamed default and the client attaches to that, so the next
attach always lands somewhere. (This generalizes the first-connect "attach to the
default" rule.) Clients discover the survivor set via `ListWorkspaces()`. Explicit
`CloseWorkspace(id)` kills all its panes and removes it. (A "keep empty workspaces"
config knob is deferred — YAGNI.)

**Persistence boundary.** The workspace set lives in the daemon's in-memory registry
— it survives `serve` restarts, but is **lost on daemon crash** (consistent with the
rest of v1; no disk persistence).

## Multiple browsers attached to one workspace

Multi-attach semantics fall out of the two-layer model: **content is mirrored,
presentation is per-client, and exactly one resource is contested.**

| Aspect | Shared or per-client? | Behavior |
| --- | --- | --- |
| **Composition** (which panes exist) | **Shared** | Browser A creates/closes a pane → daemon **broadcasts composition-change events (`pane-added`/`pane-closed`) to ALL subscribers of the workspace** → B spawns/destroys its xterm.js and re-runs its responsive arrangement. `pane-added` is **idempotent, dedup-keyed by `localPaneId`**, so the actor (which also gets the broadcast after its `CreatePane` ack) does not double-spawn. |
| **Workspace existence** (open/closed) | **Shared** | If the workspace is reaped (last pane exits) or `CloseWorkspace`d, the daemon **broadcasts `workspace-closed(id)` to ALL subscribers**. Each co-attached client then **detaches and attaches to the most-recently-active surviving workspace** (or, if none survive, the daemon-recreated fresh unnamed default) — no client is left stranded on a dead workspace. On a last-pane-exit reap the daemon fires `pane-closed` then `workspace-closed`; a client that sees `workspace-closed` ignores any trailing `pane-closed` for that workspace. A `RenameWorkspace` broadcasts **`workspace-renamed(id, name?)`** so every client updates its tab label. |
| **Pane output** (live bytes + scrollback) | **Shared/mirrored** | Both subscribe to the same PTY streams; both get the same replay + live feed (like two tmux clients on one session). |
| **Input** (keystrokes) | **Shared** | Both can type into the same pane; keystrokes interleave at the PTY. No locking, no "driver" lock (YAGNI). |
| **PTY size** | **Contested** (one PTY, one size) | **Active-view-wins:** whichever client most recently sent `Resize(paneID, CxR)` sets it; others reflow. Tabbed-away/unrendered panes send no resizes, so they don't fight. |
| **Arrangement** (splits/tabs/ratios) | **Per-client** | A's desktop tiling and B's phone tabs are independent — same panes, different layout (the whole point of Layer 2). |
| **Focus + scrollback position** | **Per-client** | Local xterm.js state, never shared. |

**New protocol requirement:** the daemon must **broadcast composition-change events
(`pane-added` / `pane-closed`) to all workspace subscribers, not just the actor** —
otherwise a second browser would not see panes appear/disappear.

## Data Flow

Five paths exercise the system.

```
CREATE pane (event-driven for ALL clients, including the actor):
  browser → serve: "new pane in workspace W, size CxR, cmd=$SHELL"
  serve → sessiond: CreatePane(W, CxR, cmd)
       (unknown W → `unknown-workspace` error; pane can only be created in a
        workspace the client is attached to)
  sessiond: fork PTY (sub-ms) → assign localPaneId → register Pane
  sessiond → actor: ACK carrying the assigned localPaneId (NOT a spawn signal)
  sessiond → ALL subscribers: broadcast pane-added(localPaneId)
  → every client (INCLUDING the actor) spawns its xterm.js on pane-added,
    deduped by localPaneId, and places it per responsive layout

ATTACH (fresh client / reconnect / new device):
  fresh client with no stored workspaceId → ListWorkspaces() → Attach(default)
       (cold-start auto-create guarantees at least one workspace exists)
  browser → serve → sessiond: Attach(workspaceId)
  sessiond → serve → browser: composition {localPaneIds} + per-pane replay
       (replay = synthetic preamble + retained ring bytes)
  unknown/stale workspaceId (reaped, stale localStorage) → `unknown-workspace`
       error → client recovers via ListWorkspaces() and attaches to an existing
       workspace (or CreateWorkspace() for a fresh daemon-allocated id)
  browser: builds arrangement for this viewport profile, feeds replay to xterm.js,
           then subscribes to live

WORKSPACE control (multi-workspace management):
  browser → serve → sessiond: ListWorkspaces()      → [{id, name?, paneCount}]
  browser → serve → sessiond: CreateWorkspace()      → daemon allocates + returns id
  browser → serve → sessiond: RenameWorkspace(id, name)
  browser → serve → sessiond: CloseWorkspace(id)      kills all panes, removes it

COMPOSITION + WORKSPACE-LIFECYCLE broadcast (to ALL subscribers of a workspace):
  sessiond → serve → browsers: pane-added(localPaneId) / pane-closed(localPaneId)
       idempotent, dedup-keyed by localPaneId; each browser spawns/destroys its
       xterm.js and re-arranges
  sessiond → serve → browsers: workspace-closed(id)   on auto-reap or CloseWorkspace
       → client detaches, calls ListWorkspaces(), attaches to another workspace
         (daemon re-creates a fresh unnamed default if it is now empty)
  sessiond → serve → browsers: workspace-renamed(id, name?)
       → co-attached clients update their tab label (workspace.name ?? activePane.title)
  (workspace-created broadcast for live cross-client picker updates is DEFERRED;
   pickers refresh via ListWorkspaces() on open for now.)

LIVE output:
  PTY → sessiond: appends to ring/altscreen, updates ModeTracker
  sessiond → all subscribed serve conns → browsers: raw bytes [paneID][data]

INPUT:
  xterm.js onData → serve → sessiond: [paneID][utf8 bytes] → PTY write

RESIZE (responsive reflow / active-view-wins):
  browser measures pane's rendered grid → serve → sessiond: Resize(paneID, CxR)
  sessiond: pty.Setsize → program reflows
```

**Detach is a non-event:** the browser closing or `serve` restarting just drops
subscribers. The PTY and ring keep running in `sessiond`. Re-attach replays from
the ring.

**Two transport hops, two formats:**

- `serve ↔ sessiond` over the Unix socket — length-prefixed frames: a small
  control channel for create/attach/resize/composition, plus binary pane data.
- `browser ↔ serve` keeps muxterm's **existing** binary WebSocket framing
  `[4-byte LE paneID][data]`.

`serve` is a thin, stateless relay/translator between the two — which is exactly
what makes its restart a non-event. This is the **same** per-pane binary streaming
muxterm already does; only the upstream source changes, from "tmux `-CC` control
connection" to "sessiond Unix socket."

## Error Handling

| Event | Response |
| --- | --- |
| **PTY process exits (shell quits)** | Daemon emits pane-closed; the ring is kept briefly so a reconnecting client sees final output, then the pane is reaped and the workspace drops the PaneID. |
| **sessiond crashes** | Worst case: its child PTYs die with it. `Restart=on-failure` relaunches; web reconnects. **This is the one event that loses sessions** — acceptable, rare, and logged loudly. |
| **serve crashes / restarts** | Non-event. PTYs + rings live on in sessiond. New serve reconnects, re-subscribes, replays. |
| **socket dead on serve start** | Auto-spawn sessiond (see lifecycle section). |
| **web client disconnect** | Drop the subscriber only. The pane runs on. |
| **attach to unknown/stale workspace id** (reaped workspace, stale `localStorage`) | Daemon returns an **`unknown-workspace` error**. It does **not** lazily create a workspace from a client-supplied id, and does **not** return an empty composition. The client **recovers** via `ListWorkspaces()` (cold-start auto-create guarantees at least the default exists) and attaches to an existing workspace, or calls `CreateWorkspace()` for a fresh daemon-allocated id. |
| **create pane in unknown workspace id** | Same **`unknown-workspace` error**. A pane can only be created in a workspace the client is attached to. |
| **ring trim mid-stream** | Safe-boundary trimming guarantees no severed escape; the ModeTracker preamble restores state. |

**The honest weak point:** if `sessiond` itself dies, its child PTYs die — sessions
are lost. v1 explicitly does **not** mirror scrollback to disk or re-parent PTYs
across daemon restarts (the research doc's "disk-mirrored buffer" — deferred
YAGNI). The mitigation is operational: `Restart=on-failure` plus a stable daemon
that does very little, so it rarely crashes.

## Testing Strategy

- **ModeTracker / buffer — unit tests, the priority.** This is where correctness
  risk lives. Feed recorded byte streams (vim enter/exit, htop, `tput` color runs,
  cursor moves), trim at every offset, and assert that replay + preamble
  reconstructs correct screen state. Table-driven golden tests.
- **Daemon protocol — integration tests.** Real PTYs running `cat` / `echo` /
  `vttest`; assert create/attach/resize/replay over a real Unix socket.
- **Restart survival — integration test.** Spawn the daemon, create panes, kill +
  restart `serve`, and assert that reattach replays intact.
- **Web/client — keep existing tests** (`ws.session`, `state.session`); repoint
  them from the tmux mock to a sessiond mock.

## Open Questions

- **Daemon-restart durability:** is operational `Restart=on-failure` enough for v1,
  or will users demand disk-mirrored scrollback sooner than expected? (Deferred for
  now.)
- **Exact `PaneBuffer` interface shape** — the seam that lets x/vt swap in for
  Level 2.
- **Unix-socket control-frame schema specifics** (message types, encoding) — to be
  nailed down in the implementation plan. The schema must enumerate the **full**
  message + event set, not just pane-level messages: the workspace-level lifecycle
  events (`workspace-closed`, `workspace-renamed`) and the **idempotent**
  `pane-added` / `pane-closed` events, alongside the request/reply messages
  (`Attach`, `CreatePane`, `ListWorkspaces`, `CreateWorkspace`, `RenameWorkspace`,
  `CloseWorkspace`, `Resize`) and the `unknown-workspace` error. The schema must
  give `unknown-workspace` a **stable error code/shape**, since two call sites
  (`Attach`, `CreatePane`) depend on detecting and recovering from it. A
  `workspace-created` broadcast (live cross-client picker updates) is **deferred**.
- **Cross-device arrangement memory** (daemon-side profile-keyed layouts) —
  explicitly deferred; confirm it stays deferred.
- **"Keep empty workspaces" config knob** — deferred (YAGNI); v1 auto-reaps a
  workspace when its last pane exits.
