# HANDOFF — muxterm Dashboard

Goal: `.amplifier/goals/muxterm-dashboard-live-in-browser.md`
Branch: `feat/chief-of-staff`. Built 2026-09-06.

## Result: 18/18 PASS, 0 BLOCKED

Verified by me directly in Chrome against `make dev-local` on 127.0.0.1:8313,
binary `/home/ken/workspace/muxterm-chief-of-staff/bin/muxterm-dev`, brand-new
workspaces and panes. Production (8311/9090) untouched throughout — same PIDs
785735/785736 before and after, snapshot file still carrying production's own
workspaces.

| # | Item | Evidence |
|---|---|---|
| 1 | `go build ./...` | exit 0. `go vet ./...` exit 0. |
| 2 | `npm run check:fast` | `Found 8 warnings and 0 errors` — the 8 pre-existing ones, unchanged. |
| 3 | Shared 52px topbar, no pip, no counts | `topbarH: 52`, `topbarText: "Dashboard cards tiles"`, `digits: []`, `emoji: []` |
| 4 | Two columns, separator below topbar, clamped | `cols: "485.75px 5px 565.25px"`, `rows: "52px 668px"`, `separator: true`; clamp held at 190px chat width |
| 5 | **Card heights fixed while dragging** | `[74]` at all 8 samples while chat width went 485→776→575→275→190→823 and columns went 2→1→2→3→3→1 |
| 6 | Home composer removed | `composerBoxes: 1` on the whole surface; `<mux-home>` no longer imported by `app.ts` |
| 7 | One-box composer, lucide, no emoji, no animation | `composerBoxes:1`, `controlsInsideBox:2`, `sendIsCircle:"50%"`, `emojiFound:[]`, `animatedElements:[]` (swept every element + `::before`) |
| 8 | Listening state | `cls:"cbtn rec"`, `label:"Stop dictating"`, `shapes:"rect"` (lucide Square), `bg:rgb(207,34,46)`, `anim:"none"` |
| 9 | No rule above composer, 22px fade | `composerBorderTop:"0px"`, `fadeHeight:"22px"`, `linear-gradient(to top, …, rgba(0,0,0,0))` |
| 10 | ⋯ menu + real clear | 3 items, no counts, danger styling. Clear-all pruned the transcript on disk (`removed 7/7 messages`, backup written) and survived reload. |
| 11 | Mobile title bar | `text:"Dashboard"`, buttons `[drawer-btn, fleet-btn, launcher-btn]`, `hasMic:false`, `digits:[]` |
| 12 | Sheet closed by default, Popover API | `popoverAttr:"auto"`, `atLoad.open:false`, opens from `fleet-btn` |
| 13 | Detents | tap → `full` (800px); tap → `half` (473px); drag → continuous (639px mid-drag); release high → `full`; `✕` → closed |
| 14 | Portrait cards only | `thumbs: 0`, no segmented control in the sheet; heights fixed |
| 15 | `spawn_lane` MCP tool | tool count 17→18, `required:[workspace,harness,prompt]`, `harness` enum |
| 16 | `muxterm spawn-lane` CLI | `spawned amplifier lane in pane 1 of new workspace w2 ("verify-a")` |
| 17 | Launches the real harness | pane showed `Amplifier Interactive Session / Session ID: 01304f2a-…`, not a shell. `--goal` argv verified: `["amplifier" "run" "/goal the suite is green" "--mode" "chat"]` — the original prompt correctly dropped. |
| 18 | Browser verification | all of 3–14 above, in Chrome, my own tool calls. |

## Two bugs found and fixed outside the checklist

**1. `make dev-local` was not data-isolated.** It overrode `XDG_RUNTIME_DIR` but
not `XDG_DATA_HOME`, and `snapshotDir()` (`internal/sessiond/snapshot.go:126`)
resolves the crash-restore snapshot from `XDG_DATA_HOME` with a
`$HOME/.local/share` fallback. So **every dev-local sessiond restored
production's workspaces at boot and overwrote production's
`restore-snapshot.json` periodically and on shutdown.** The Makefile's own
comment claimed production was "never read/written under any circumstance" —
it was false. Fixed; both vars are now overridden together and the comment
says why.

**2. `make dev-local` could not spawn a sessiond from inside muxterm.**
`EnsureDaemon` refuses when `INVOCATION_ID` is set (`spawn.go:157`), which any
shell inherited from the production systemd unit carries — including an agent
session running in a muxterm pane. Result was a serve with no sessiond and
every browser connection failing to attach. The target now unsets it.

**3. `hooks-muxterm-session` leaked background LLM output.** `label.py` and
`classify.py` both omitted `metadata={"stream": False}`, so their background
calls took the streaming branch and emitted `llm:stream_block_*` onto the
session hook bus — indistinguishable from foreground assistant text. This
pollutes the CLI's streaming overlay today; in the Dashboard it would have
rendered `{"label": "…"}` as if the assistant said it. Fixed in both files.

## Known gaps — deliberately not built

- **Replayed turns carry no cost.** The transcript does not record per-turn
  cost. `ms` is real (derived from turn timestamps) but measures a smaller span
  than the live number: 1.4s replayed vs 3.1s live for the same turn.
- **Live-lane protection over-keeps.** A session-state file on disk counts as a
  live lane without re-checking `/proc`; an unparseable file still contributes
  its filename; matching is a substring scan. Over-keeping is the safe
  direction and was chosen deliberately.
- **Pruning is by turn, never by message** — dropping a lone tool result would
  orphan its `tool_call`. Output is run through `diagnose_transcript` /
  `repair_transcript` before writing.
- **`cos-approval` is wired but never observed end-to-end.** No turn in testing
  produced an `approval_request`. The structurally identical `cos-cancel` path
  is proven.
- **Dead code in `app.ts`:** `_pendingDispatch` / `_dropPendingDispatch` /
  `_spawnPane` lost their only producer when the home composer was removed.
  Left in place with a comment — they encode an attach-identity safety property
  worth not re-deriving. Someone should decide.
- **`claude` is not installed on this box.** The claude path is verified at the
  argv level and the error level; no real Claude Code session was launched.
- **The sidecar ignores SIGTERM while idle** (parked on `queue.get()`).
  `Supervisor.Close()` escalates to SIGKILL so production is fine; a manual
  `kill` looks like a hang. Pre-existing, not fixed.
- Out of scope by the goal: Claude Code hooks, drift detection, periodic wake,
  state-transition tracking, `lane_transcript`.

## Teardown

`make dev-local` stopped, verify workspaces removed, `/tmp/muxterm-dev-local`
deleted, Chrome closed. Production 8311/9090 running and untouched.


## Pre-merge review — six defects found and fixed

The branch was reviewed adversarially before merge. Six real defects surfaced,
all now fixed with A/B evidence against a binary built from the pre-fix commit.

| | Defect | Fix |
|---|---|---|
| **B1** | `muxterm cos` built its own Supervisor and spawned a **second sidecar on the same Amplifier session** — the measured turn-erasure bug, reachable from the CLI. The queue serializes per-Supervisor; two processes are invisible to each other. It also clobbered and then deleted the server's `cos.json`, so `--status` reported the live sidecar as gone. | CLI reads the state file and refuses when a live sidecar owns the session, naming the PID. `writeState`/`removeState` are no-ops for a non-owner. |
| **B2** | dev-local isolation was incomplete. `AMPLIFIER_HOME` does **not** help: `amplifier_app_cli/session_store.py` hardcodes `Path.home()/".amplifier"` and reads no env var. Dev and production could resume the same session whenever their cwd slugs matched. | `MUXTERM_COS_SESSION_ID=muxterm-cos-dev` — the only lever that works. Session id and cwd are now resolved explicitly and logged at startup. |
| **B3** | A clear could report `removed: N` while the **live context still held the messages** — the next turn's save wrote them all back. `reloaded:false` was consumed by nobody. | The sidecar refuses up front when `set_messages` is unavailable (`clear_unsupported`), and reports `clear_partial` if the disk prune succeeded but memory did not. Surfaced through Go to the browser as a fault, not a success. |
| **H1** | Sidecar orphaned on any non-`ctx.Done()` server exit — panic, listener error, SIGKILL. | `PR_SET_PDEATHSIG` on Linux (no-op elsewhere) + `defer s.hub.CloseCos()`. |
| **H2** | Idle sidecar ignored SIGTERM (parked on `queue.get()`), costing the full systemd `TimeoutStopSec`. | Wake sentinel. Measured: **20s+ then SIGKILL → 0.30s, exit 0.** |
| **H3** | A spawn that failed after workspace creation left an orphan workspace **and** left the MCP session re-attached elsewhere. | The workspace is deleted and the attachment restored on any post-creation failure. |

Also added: workspace-name length/control-character validation, and a guard
rejecting prompts that begin with `/` (the harness would read them as slash
commands rather than as work).

**Corrections to the review itself:** M2's described symptom does not
reproduce — `backup()` returns `None` for a missing file rather than raising.
The ordering was changed anyway so correctness does not depend on that detail,
but it was not a real defect.

### Still open after the fixes

- **Two `muxterm serve` processes on one session id are still unguarded.**
  Deliberate: making the server refuse would turn a rare collision into a dead
  chat panel. The fix, if wanted, is the same `ReadState` check in
  `cosRelay.get()` plus a decision about who wins.
- **`PR_SET_PDEATHSIG` fires when the forking thread exits, not only the
  process.** If the Go runtime retires that M, the sidecar dies early; the
  supervisor treats it as an ordinary death and restarts. Failure mode is a
  restart, not a lost session. On darwin there is no equivalent — a SIGKILLed
  muxterm still orphans.
- **`--status` now describes only the state-file owner.** A legitimate second
  sidecar (own `--session-id`) publishes nothing. Per-session status files
  would be the alternative.
- **`TestWaitForPromptResolves` is time-dependent** (3s deadline) and flaked
  once under load. Pre-existing on the base commit; it will flake in CI.
- **`internal/service.TestServiceConfig_Defaults` fails** — pre-existing,
  reproduced identically on a clean `35dccca` worktree. It reads the host's
  real config.
