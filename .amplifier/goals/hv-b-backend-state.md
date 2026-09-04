# Lane B — Backend session state (hook → daemon → wire)

## Outcome

muxterm learns, for every Amplifier session running in one of its panes, what
that session is actually doing — **declared by the session itself, not inferred
from the terminal.** The daemon holds that state and pushes it to browsers
across every workspace, following the `workspace-preview` precedent.

This is the data the home view renders. Without it the frontend has fixtures and
nothing else.

**Why declaration and not inference:** the daemon's existing activity classifier
(`internal/sessiond/activity.go`) asks `TIOCGPGRP` which process group owns the
terminal. When an agent is thinking it owns the terminal; when it sits waiting
for a human it *also* owns the terminal. Identical signal, opposite meanings. The
distinction is the entire product, and it cannot be recovered from PTY state.
Amplifier's kernel already publishes it — this lane carries it across.

## ⛔ HARD SAFETY CONSTRAINT — read before running anything

A human is **using a live muxterm right now** to talk to the orchestrator. It
runs as `muxterm serve --addr 127.0.0.1:9090` on the **default** sessiond socket,
fronted by Caddy at https://muxterm.ampbox.io. There is also a `python3 -m
http.server 8477` serving design mockups.

- **NEVER** run `pkill muxterm`, `pkill sessiond`, `killall`, or any broad kill.
- **NEVER** touch anything on port 9090, port 8477, or the default socket.
- **DO NOT run `make dev-local`.** It binds a single fixed port (8313) and one
  shared runtime dir; sibling lanes run concurrently and would collide. The
  orchestrator owns dev-local and verifies there. If you truly cannot finish
  without it, that is a `BLOCKED-needs-dev-local` residual — record and stop.
- Only ever stop a process **your own lane started**, by a PID you recorded.

## Working agreement

- Working directory: `/home/ken/workspace/muxterm-hv-worktrees/hv-b-backend-state`
- Branch: `goal/hv-b-backend-state`
- Base SHA: pinned by the launcher. Work ONLY here. Do not touch the main
  checkout at `/home/ken/workspace/muxterm` or any sibling worktree.
- **Never merge to main.** Push your branch; the orchestrator merges.
- **Commit early, push always.**

## Files you own

- `internal/sessiond/**` — including `sessionstate.go`, which is pre-committed
- `internal/server/**` — `server.go`, `protocol.go`, `subscriber.go`, `ws.go`
- `modules/hooks-muxterm-session/**`

**You do NOT own:** `cmd/muxterm/**` (Lane A), `web/**` (Lane C),
`internal/config/**` (Lane C owns config for the keybinding). If you need a
change there, record it in `residuals[]` and continue. **Do not add a CLI
subcommand** — `cmd/muxterm/cli.go` is Lane A's and a dispatch-case collision is
exactly the kind of merge conflict this batch exists to avoid.

## The contract is already pinned

`internal/sessiond/sessionstate.go` is committed to your base. It defines
`SessionState`, the `working·blocked·done·failed·stopped` enum, the `waitingFor`
reasons, and `plain|goal` mode. Its mirror is `web/src/lib/session-state.ts`,
which Lane C is building against **right now**.

**Treat the field names and JSON tags as frozen.** If you must change one,
that is a `residuals[]` entry naming the exact field and why — do not silently
diverge, or the two halves will not meet.

## ⚠ The rule that decides whether this feature is worth anything

**Idle means opposite things depending on mode.**

- A `plain` session ending its turn and waiting for the user is **normal**. It
  must NEVER be reported as `blocked`. Its resting state is `stopped`.
- A `goal` session going quiet means the loop **broke**. That IS `blocked`.

Mode is known at kickoff. If plain-idle sessions surface as needing input, every
idle session looks like an emergency, the user learns to ignore the indicator,
and the whole home view becomes worthless. Get this right before anything else.

## Build in this order — each step is independently valuable

### 1. Hook writes state snapshots (`modules/hooks-muxterm-session/`)

Extend the existing hook. It already mounts and fires on `SESSION_START`, where
it calls `setproctitle` for crash recovery — **keep that behaviour intact.**

Subscribe to the kernel events and maintain a per-session snapshot:

| Event | Effect on state |
|---|---|
| `SESSION_START` | create record; capture `session_id`, cwd (the project), mode |
| `PROMPT_SUBMIT` | first one sets `name`; all set `state=working` |
| `TOOL_PRE` / `TOOL_POST` | refresh `doing` |
| `ARTIFACT_READ` | append `data.path` to `knows` (distinct, cap the list) |
| `APPROVAL_REQUIRED` | `state=blocked`, `waitingFor="permission prompt"` |
| `USER_NOTIFICATION` | `state=blocked`, `waitingFor="input needed"` |
| `PROMPT_COMPLETE` | plain → `stopped`; goal → stays `working` |
| `TOOL_ERROR`, `PROVIDER_ERROR` | keep working, note it in `doing` |
| `SESSION_END`, `ORCHESTRATOR_COMPLETE` | `state=done` |
| `SESSION_FORK` | note nested activity |

Import names come from `amplifier_core.events`. **Verified real event strings**
(they use colons, not underscores): `session:start`, `session:fork`,
`prompt:submit`, `tool:pre`, `tool:post`, `artifact:read`, `artifact:write`,
`execution:start`. `artifact:read` carries `data.path` and `data.bytes`;
`prompt:submit` carries `data.prompt`.

⚠ **`context:include` never appears in real logs. Do not build on it.**

**Transport: write a file. Do not speak the binary protocol from Python.**
Atomic-write one JSON snapshot per session to a spool directory, e.g.
`${XDG_RUNTIME_DIR:-/tmp}/muxterm/session-state/<session_id>.json` (write to
`.tmp` then `os.replace`). Snapshots are idempotent, so a missed write is
self-healing on the next event. The hook must **never block or crash the
session** — wrap everything in try/except and degrade silently, exactly as the
existing `setproctitle` path does.

Pane and workspace association: the hook knows its own pid. sessiond knows which
pane owns which pid. Let the daemon do that join rather than teaching the hook
about muxterm internals.

### 2. Daemon reads snapshots into a store (`internal/sessiond/`)

A store keyed by pane id, populated by reading the spool directory on a modest
interval (the existing preview loop ticks at 250ms — this needs nothing like
that; 1s is generous). Join snapshot → pane by walking pane root pids.

Prune records whose pane is gone. `Registry.snapshotView()` (registry.go:288)
already enumerates every workspace and pane — use it.

### 3. Push to browsers (`internal/server/`)

Add an **additive** protocol message and an opt-in subscribe, modelled directly
on `workspace-preview` / `preview-subscribe`:

- `preview-subscribe` handling: `server.go:466-473`, `setPreviewOn` at `796-807`
- cross-workspace fan-out over **all** connections: `publishPreview`,
  `server.go:940-944` — this is the precedent that makes cross-workspace push
  legitimate despite one-workspace-per-attachment
- droppable enqueue: `subscriber.go:89-95` — the comment there explicitly blesses
  "any future advisory push". Session state is advisory. **Drop on a full queue;
  never disconnect a client over it.**
- relay to the browser through `internal/server/ws.go` alongside
  `OnWorkspacePreview` (`ws.go:628-641`, opt-in at `389-402`)

Emit only on change, and include a `*-result` ack for old-daemon detection, the
same way preview-subscribe does.

## Verification

⛔ **AGENTS.md bans unit tests. Do not add `*_test.go`.** Not for the state
machine, not for the parser. If an existing test breaks, fix the test.

Without dev-local you can still prove a great deal:

1. `go build ./...` clean — the baseline, passes today.
2. **Exercise the hook for real.** You may run `amplifier` yourself in this
   worktree — that is your own process, entirely safe. Run a trivial session,
   then `cat` the snapshot file it produced. Paste real JSON into DONE.json.
   This is the single most valuable evidence you can produce.
3. Read back your own protocol code against `preview-subscribe` line by line and
   confirm the shape matches.
4. Write, but do not run, the exact dev-local recipe the orchestrator should use
   to see state reach a browser.

## Time bound

Enforced by the launcher. Exceeding it is a terminal `BUDGET` state — not a
reason to rush, skip a commit, or declare success. Commit what is real.

## Resources

If you run `amplifier` to exercise the hook, that is your own foreground process
and needs no teardown beyond exiting. Any spool directories you create under
`$XDG_RUNTIME_DIR` must be listed in `resources[]` with their disposition.
**Never** start a background server. A lane that exits with resources running
has not finished.

## Definition of done

Complete when **either** every item reaches a terminal state, **or** it is
conclusively demonstrated the remainder cannot, naming the blocker for each.
Items ending FAIL or BLOCKED are residuals, not failures of the goal.

Terminal states: `PASS` / `FAIL-<named>` / `BLOCKED-<named>` / `PENDING-HUMAN`.

1. Hook subscribes to the events above and writes atomic per-session snapshots
2. Existing `setproctitle` crash-recovery behaviour preserved
3. Hook never blocks or crashes a session on any failure path
4. **plain-idle reports `stopped`, never `blocked`** — the load-bearing rule
5. Daemon store reads snapshots and joins them to panes
6. Additive `session-state` push + opt-in subscribe, following preview-subscribe
7. Droppable enqueue; never disconnects a client
8. Relayed to the browser through `ws.go`
9. Field names still match the pinned `sessionstate.go` contract (or divergence
   recorded as a residual)
10. `go build ./...` clean
11. Real snapshot JSON from a real `amplifier` run captured in DONE.json
12. Committed AND pushed to `origin goal/hv-b-backend-state`

**Partial credit is real here.** Items 1–4 alone are a shippable increment. If
time runs short, land the hook properly rather than leaving all three layers
half-built.

## Final act

Write `DONE.json` in the worktree root — gitignored, do not commit. Fields:
`lane, session_id, verdict, branch, head, pushed, items[], residuals[],
pending_human[], resources[], notes, suite`.

`verdict` is exactly one of `COMPLETE`, `BLOCKED`, `PARTIAL`. `session_id` must
be your own.
