# Session Persistence Research

Status: exploratory design notes. Captures a design discussion to be continued in another session.

Service context: **muxterm is a Go service.** (Note: repo `AGENTS.md` currently describes a
Python/FastAPI backend — that appears stale or mid-migration. Reconcile before implementing. See
"Open questions".)

## Decision so far (firm)

- **tmux is for persistence ONLY.** It exists to keep PTYs/processes alive across client
  disconnects and (ideally) server restarts. Nothing else.
- **Drop server-side splits/windows entirely.** No tmux panes, no tmux windows-as-tabs, no
  copy-mode, no status bar, no tmux keybindings exposed to the user.
- **One session = one atomic rectangle.** All composition (splits, tabs, layout, navigation,
  search, copy) happens **client-side in the web app**. This is the "Zellij-class UX, but in the
  browser" thesis. The web is a better substrate for layout/touch/animation than terminal escape
  sequences.
- **Accept reflow.** When multiple clients attach to the same session at different sizes, size to
  the most-recent client rather than the smallest. (tmux: `window-size latest` / `aggressive-resize`.)
- **Server-side scrollback is mandatory.** Configurable, **default 10000 lines**, always kept.
  History must be available to a *fresh* client attaching to an existing session (e.g. a new
  device), not just the connection that produced the output.

## The core need, precisely

A daemon that:
1. Owns a PTY and keeps the child process alive across client disconnects.
2. Keeps a configurable scrollback buffer (default 10000 lines) **server-side**.
3. Lets clients attach/detach and, on attach, **replays history** then streams live output.
4. **Outlives muxterm itself** — muxterm is restarted frequently (`systemctl --user restart`), so
   sessions AND their history must survive a muxterm restart. => the PTY+buffer owner must be a
   separate process with a stable attach handle (Unix socket), NOT inside the muxterm web process.

## The stated pain point

tmux **control mode** (`-CC`): the `new-window` -> control-mode "ready" handshake is laggy.
Important nuance: **this latency comes from control mode, not from tmux-as-persistence.** You can
use tmux for persistence without control mode at all.

## Options evaluated

### Option 1 — tmux, plain attach, NO control mode (lowest effort, meets all hard reqs)
Keep tmux purely as the persistence + scrollback engine, but stop using `-CC`.
- `tmux new-session -d -s <name>`  (instant create, no control-mode handshake)
- attach via plain `tmux attach -t <name>` through the web terminal bridge
- `set -g history-limit 10000`  (satisfies the scrollback requirement for free — tmux already runs
  a correct headless VT emulator with scrollback)
- `set -g window-size latest` (+ `aggressive-resize`) to accept reflow
- never create panes/windows; session list via `tmux list-sessions` polling (already done)
- Why control mode was there originally: probably dashboard/window event notifications. Under the
  new "one session = one rectangle" model you need almost nothing from the control protocol, so it
  is likely droppable entirely.
- **Pros:** smallest change, reversible, keeps tmux's battle-tested scrollback + reflow, survives
  muxterm AND machine-up restarts. Directly removes the control-mode latency.
- **Cons:** still a tmux dependency.
- **Verdict:** best first experiment — likely solves the actual pain with least risk.

### Option 2 — abduco / dtach (lightest persistence)
Tiny "detach/attach only" daemons. `abduco` was literally built as the persistence half of dvtm
(persistence separated from multiplexing — philosophically exactly our thesis). `dtach` is ~1k LOC.
- No control-mode handshake; create = fork (ms); attach = open socket + screen redraw.
- **BUT they only replay the current screen, not deep scrollback.** => fails the 10000-line
  server-side history requirement *on their own*.
- **Verdict:** ruled out as a *standalone complete* solution by the scrollback requirement — but
  NOT ruled out as a building block. See Option 2.5, which uses abduco as the keepalive kernel
  under a muxterm-owned history layer. This is a legitimate middle ground.

### Option 2.5 — abduco as keepalive kernel + muxterm-owned history (the middle ground)
Split the job: abduco does the survive-everything half; muxterm owns scrollback.
- **abduco** owns the PTY and keeps the process alive across client disconnect AND muxterm
  restarts (separate process, own socket, decoupled lifetime). This is the fiddly,
  security-sensitive part — PTY master ownership, FD-passing over a unix socket, daemonization /
  reparenting — already solved in a tiny, battle-tested C program.
- **muxterm** stays attached as a persistent reader, logs each session's output stream to disk
  (trimmed to a ~10000-line budget), and replays it on attach.
- **Key unlock:** xterm.js IS already a VT emulator. muxterm can store the **raw output log** and
  replay raw bytes to a fresh xterm.js, which reconstructs screen + scrollback client-side. =>
  potentially **no server-side VT emulator needed** (the scary part of Option 3 disappears). This
  is how asciinema/gotty-style replay works.
- **What it buys vs Option 3 (full custom):** deletes the hardest half (keepalive daemon + FD
  passing + reparenting) and leans on proven C. You own only output-logging + replay.
- **What it costs vs Option 1 (tmux no `-CC`):** tmux already gives keepalive AND correct
  scrollback from one mature dep; abduco gives only keepalive, so you build the history layer. =>
  **this option only wins if shedding the tmux dependency is itself a goal** (lighter footprint,
  no control mode, no tmux quirks/resource model).
- **Two genuine wrinkles:**
  1. abduco doesn't buffer history while detached (retains current screen only for redraw). The
     reader must stay attached continuously; there is a small **history gap during the muxterm
     restart window**. Mitigation: always-on reader + accept the brief gap, OR wrap the session
     command to `tee` output to a log at the source so capture is attach-independent.
  2. Raw-replay correctness edges: trimming a raw byte log can cut mid-escape-sequence or drop
     earlier SGR/cursor state; alt-screen apps (vim/less) need care so reattach replays into a sane
     state. Solvable (snapshot at safe boundaries, track alt-screen state) but these are exactly the
     cases a real VT emulator (tmux) handles for free.
- **Verdict:** the best-balanced option **if and only if** getting off tmux is a goal. Beats
  full-custom Go because abduco handles the survive-everything half.

### Option 3 — custom Go persistence daemon (build the "little bit" ourselves)

### Option 3 — custom Go persistence daemon (build the "little bit" ourselves)
A small Go daemon (per-session, or one daemon multiplexing sessions) that IS "dtach + scrollback":
- PTY: `github.com/creack/pty`
- Scrollback done correctly needs a **headless VT emulator** to maintain screen + N lines of
  history across resize/alt-screen (vim/less/etc.). Candidate Go VT libs:
  - `github.com/hinshun/vt10x`
  - `github.com/charmbracelet/x/vt` (newer)
  - (A naive last-N-bytes byte buffer is simple but wrong for full-screen apps and "lines" is only
    approximate. The VT-emulator path is what "10000 lines of history" really implies.)
- Attach model: Unix socket per session (dtach-style). On attach: serialize current screen +
  scrollback, send, then stream live.
- Restart survival: daemon is detached from muxterm's lifetime (own process / systemd scope,
  reparented to init). Optionally mirror scrollback to a file so the daemon itself can restart.
- **Pros:** zero tmux dependency, full ownership, exactly the minimal surface we want, history
  semantics under our control.
- **Cons:** most effort; we take on headless-VT correctness (the part tmux already does well).
- **Verdict:** north-star / long-term play if we want to fully shed tmux. Don't start here.

## Recommendation / sequencing

1. **Prototype Option 1** (tmux without control mode, `history-limit 10000`, `window-size latest`).
   Cheap, reversible, validates that the control-mode latency was the real culprit. Likely meets
   every hard requirement today.
2. If we want to eliminate the tmux dependency entirely, **graduate to Option 3** — a small Go
   daemon (creack/pty + a headless VT emulator + scrollback + unix-socket attach, modeled on
   dtach). This is the only option that fully owns persistence + 10000-line history with no tmux.
3. **Option 2 (abduco/dtach) is out** on its own — no server-side deep scrollback.

## Key Go libraries (for Option 3)

| Concern | Library |
|---|---|
| PTY | `github.com/creack/pty` |
| Headless VT emulator + scrollback | `github.com/hinshun/vt10x` or `github.com/charmbracelet/x/vt` |
| Attach/detach model reference | `dtach` (C, ~1k LOC) — read as a design template |

## tmux knobs (for Option 1)

- `tmux new-session -d -s <name>` — detached create, no control mode
- `set -g history-limit 10000` — configurable scrollback (the requirement, for free)
- `set -g window-size latest` + `setw -g aggressive-resize on` — accept reflow, size to latest client
- plain `tmux attach -t <name>` through the terminal bridge — no `-CC`
- session enumeration via `tmux list-sessions` (polling) instead of control-mode events

## Open questions

- **Go vs Python discrepancy:** repo `AGENTS.md` says FastAPI/Python (`main.py`, `sessions.py`,
  `ttyd.py`). User states muxterm is Go. Reconcile / update `AGENTS.md`.
- Does muxterm still need ANY structured tmux events, or is `list-sessions` polling enough once
  control mode is gone?
- Scrollback fidelity bar: is byte-buffer replay "good enough" short-term, or do we require true
  VT-emulated line history from day one?
- Multi-client "who's driving": with reflow accepted, confirm `window-size latest` behavior is
  acceptable when phone + desktop are attached to the same session simultaneously.
- For Option 3: per-session daemon vs one multiplexing daemon; in-memory buffer vs disk-mirrored
  scrollback for daemon-restart survival.
