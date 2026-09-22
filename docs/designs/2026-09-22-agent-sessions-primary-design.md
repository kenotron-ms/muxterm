# Sessions are the work; terminals are a way into it

**Status:** design — no feature implementation in this PR

**Date:** 2026-09-22

**Base:** `7681ab4` (`origin/main`)

**Extends:** [Session-state protocol](../session-state-protocol.md)

**Summary:** Put durable agent sessions at the center of Mission Control. Drive
Codex and Claude chat with structured CLI subprocesses from Go, retain terminal
CLIs and hooks, and route every surface through the existing fleet contract.

---

## 1. The decision

Use **Go-managed structured CLI processes**, without adding a Node or Python SDK
service for Codex or Claude. For Codex chat, use `codex app-server` over private
stdio JSON-RPC; for Claude chat, start with one `claude -p` streaming process per
turn and resume by explicit native session ID. Keep interactive CLI launches in
real PTYs. Keep the existing Amplifier Operator sidecar and native SessionStore;
this decision does not replace the Operator engine or its conversation.

The decisive distinction is between a vendor's executable and a second runtime
wrapping that executable. Go still has to supervise children, parse events,
persist history, and manage interruptions. An SDK wrapper adds packaging,
versioning and another failure boundary without removing those obligations.

**VERIFIED:** `codex exec --help` on `codex-cli 0.155.1` says `--json` prints events
as JSONL; `claude --help` on `2.1.280` advertises streaming JSON output, input and
partial messages. Both can stream from ordinary child processes. The official
[Codex non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude programmatic guide](https://code.claude.com/docs/en/headless) document
those modes. Structured final-answer schemas alone are not progress streams.

Why not simply use `codex exec --json` for every chat? It supplies progress for
batch turns, but the chat needs a documented bidirectional approval and interrupt
channel. **VERIFIED:** the [app-server reference](https://learn.chatgpt.com/docs/app-server)
documents private stdio, initialization, thread resume, turn interruption,
item events, plan updates and approval requests. The installed binary generated
schemas for `ThreadResumeParams`, `TurnInterruptParams`,
`TurnPlanUpdatedNotification` and `CommandExecutionRequestApprovalParams`.
Its help labels app-server experimental: pin a verified executable/schema pair,
feature-detect, and retain the terminal path on incompatible upgrades.

This is one integration strategy with harness-specific transports, not a claim
that all vendors implement the same protocol. SDKs remain a fallback decision
only if an actual missing capability defeats these public CLI interfaces.

## 2. What was read, and what exists

**VERIFIED:** the full session-state protocol was read before this design. The
house-style references were `2026-09-06-cos-delegation-model.md` and
`2026-09-18-cos-composer-attachments-v1.md`. Older design statements are historical;
the released source and current contract take precedence.

**VERIFIED, source inspection at the base above:**

| Existing seam | What it actually does |
|---|---|
| `cmd/muxterm/codex_notify_cmd.go`, `internal/sessiond/codex_notify.go`, `lane_argv.go` | Injects an external notify command into launched Codex lanes; translates only `agent-turn-complete` into an interactive, stopped row. It cannot report turn start, a mid-turn permission wait, or failed turns. The lane override replaces the user's notify value. |
| `internal/sessiond/claude_adapter.go` | Polls `claude agents --json` every five seconds only while subscribed; enabled unless `MUXTERM_CLAUDE_ADAPTER` opts out. Missing binary, timeout, nonzero exit or malformed JSON logs once. Failed queries retain old snapshots. Records without a usable PID cannot be placed. |
| `modules/hooks-muxterm-session/.../__init__.py`, `state.py` | Amplifier hooks report prompt, tool, artifact-read, approval, goal and end events. Root todo calls supply counts; child work is summarized on its parent. |
| `classify.py`, `label.py` in that module | Optional model calls classify a closing answer and derive a stable initial label. These are fallible interpretation, not lifecycle authority; utility calls disable streaming. |
| `internal/sessiond/sessionstate.go`, `sessionwriter.go`, `sessionstore.go` | One whole-state snapshot contract, atomic files, PID/start-time and SID attribution, daemon-owned pane/provenance join. Unplaced processes are omitted. Endings survive only under the documented pane/supersession rules. |
| `internal/mcp/fleet.go`, `transcript.go`, `tools_fleet.go` | Fleet JSON uses snake_case; daemon/browser rows use camelCase. Transcript readers bound native harness tails; `session_send` is tied to present terminal behavior. |
| `internal/cos/sidecar/main.py`, `internal/server/lifecycle_notices.go`, `internal/sessiond/lifecycle_watch.go` | One native Operator conversation, existing queue/approval infrastructure, durable lifecycle markers and a separate delivery ledger. Existing notice dedupe includes session and kind. |

The comments claiming Claude has no hook extension point are stale.
**VERIFIED:** [Claude's hook reference](https://code.claude.com/docs/en/hooks)
documents command hooks for prompts, tools, permission requests and session ends.
The poller is muxterm's current choice, not Claude's capability ceiling.

## 3. Capability ledger

Here, **VERIFIED** means the named documentation, installed help, generated
schema or source was read. It does not mean a paid model turn or end-to-end
muxterm integration was executed. **ASSUMED** marks the narrower runtime
behaviors still requiring real integration verification. Design requirements
below are decisions to implement, not claims of existing capability.

| Surface | Evidence and usable boundary |
|---|---|
| Codex SDK | **VERIFIED:** the owner's [exact SDK URL](https://learn.chatgpt.com/docs/codex-sdk) documents a server-side TypeScript library requiring Node 18+, thread continuation/resume, and a Python library controlling local app-server. Neither is an in-process Go dependency. A custom SDK bridge needs another runtime. |
| Codex batch CLI | **VERIFIED:** installed `exec --help` and `exec resume --help`, plus the non-interactive guide: JSONL thread/turn/item/error events and ID-based resume. No claim that `exec` is a full chat approval transport. |
| Codex chat CLI | **VERIFIED:** installed `app-server --help`, generated schemas, and app-server reference: stdio protocol, turn/item lifecycle, assistant deltas, command/file events, plan changes and request/response approvals. Use those declared events, not PTY scraping. |
| Codex terminal hooks | **VERIFIED:** current [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) adds `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `Interrupt` and `SessionEnd`. Local function tools include `update_plan`; hosted tools are not universally covered. Hooks receive session identity and possibly a transcript path. Config layers/plugins can supply hooks. **ASSUMED A1:** the installed build delivers the required events with muxterm-owned hook configuration and correct process attribution; help alone does not establish this. Keep legacy notify until verified. |
| Claude CLI | **VERIFIED:** installed help and programmatic guide: `-p --output-format stream-json --verbose --include-partial-messages`, explicit `--resume`, and persistence unless disabled. Initial metadata and final results identify the session. `--input-format stream-json` also exists; V1 does not depend on its undocumented control envelopes. |
| Claude hooks | **VERIFIED:** hook reference: stdin JSON includes native session ID and transcript path; prompt/tool/permission/stop events provide progress. Successful Read tool results can provide file-read evidence. Task events exist, but a complete todo list cannot be inferred from task completion alone. Hook delivery under our launch configuration is **ASSUMED A1**. |
| Claude Agent SDK | **VERIFIED:** [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) exposes Python/TypeScript and runs the Claude Code binary; it explicitly directs other languages toward a CLI subprocess. Its API-key setup is separate from proof that this service can reuse an existing CLI login. No SDK is required for the selected chat path. |
| Amplifier CLI hooks | **VERIFIED:** muxterm's Python module registrations and `state.py` supply tool pre/post, artifact-read, approval and root todo progress. Keep that richer integration. `amplifier --help` lists run/resume; do not confuse this executable with `amplifier-agent`. |
| amplifier-agent library/CLI | **VERIFIED:** [integration guide](https://github.com/microsoft/amplifier-agent/blob/main/docs/INTEGRATION.md) describes `amplifier_agent_lib`, one turn per engine invocation, session continuity by explicit scope/ID, stdout JSON result plus stderr NDJSON progress, and protocol-version checking. `command -v amplifier-agent` found no installed binary. **ASSUMED A5:** it can replace any existing Amplifier integration without changing bundles/hooks/storage semantics; this design explicitly does not rely on that assumption or perform that migration. |

**Granularity limits:** Codex notify remains turn-complete only. Codex structured
chat has tool/item/plan granularity, but shell commands are not an authoritative
list of every file read. Claude streaming has message/token and tool-block
granularity; hooks supply declared lifecycle details. Amplifier already has
explicit artifact reads and todos. Never promise exhaustive filesystem auditing,
a percentage without a declared list, or a completion verdict from a successful
process exit. Reasoning text is not required for any fleet field.

## 4. Session identity and one fleet

A session is a durable conversation with a harness, project, history and current
execution attachment. A process run, browser connection, terminal pane, and
project layout are attachments to it. None is its identity.

Create a durable daemon-owned registry before launching work. Record a muxterm
session ID, native harness ID once known, project, execution generation,
launch provenance, permission profile, transcript location and current control
owner. Preserve existing `codex-<id>`, `claude-<id>` and Amplifier identifiers for
adopted sessions. New sessions get a stable muxterm ID before the first turn;
map `(machine, harness, native_id)` to that ID after initialization. A retry,
resume or terminal handoff must resolve the same mapping, not mint a second row.
Never derive identity from a title, project path, workspace name or `--last`.

### Extend the public contract in place

Keep v1 file producers, field semantics, atomic rename, size bounds, no-heartbeat
rule, and the existing PID/SID pane join unchanged. They continue to work even
without a daemon. Do not ask old hooks to write daemon-owned fields.

Add a **v2 managed snapshot variant** to `docs/session-state-protocol.md` in the
implementation PR: same session fields, with a required daemon-registered run
ID and generation for attribution outside a pane. This is breaking placement
semantics, so it gets a version bump rather than pretending an optional field
makes old collectors understand it. Existing readers already skip newer versions
without deleting them. Only the daemon's registered adapter can publish that
variant; arbitrary file producers do not gain authority to invent ownership.
Validate child PID/start-time while a run is alive. Between runs and after exit,
the durable session record supplies the projection; do not publish a fake child
PID or keep a dummy terminal alive to satisfy the old join.

Both variants feed **the existing SessionState collector, session-state broadcast,
home-sessions store and fleet MCP projection**. There is no second session list.
Use optional attachment/capability/reporting-health metadata on that same row.
One projector owns each managed row; hook and stream events enter that projector
with source/generation IDs. They must not race by independently replacing the
same whole-state file. Unmanaged v1 producers retain their current behavior.

`pane_id=0` and `workspace_id=""` explicitly mean no current terminal/layout
attachment for a chat session. They are never actionable pane identifiers.
This changes consumer assumptions: update Go, TypeScript, MCP resolution and
browser navigation together, negotiate the new session capability, and do not
enable chat creation for older clients. Clicking any row resolves session ID
first, then opens its available Chat or Terminal surface. Older pane-addressed
APIs keep their behavior; terminal actions on a pane-less row return a clear
error or invoke the explicit Open terminal action, never select another pane.

### Exact fleet mapping

These are the existing MCP spellings; retain the camelCase mirror on daemon and
browser wires. Every path uses the same meanings and empty-value rules.

| Fleet field | Population for chat and terminals |
|---|---|
| `session_id` | Stable registry identity; native-ID aliases reconcile hooks, stream and resume. Existing adopted IDs remain valid. |
| `pane_id` | Daemon's current real PTY attachment; `0` for none. Changes on terminal handoff, not on browser refresh. |
| `workspace_id` | Daemon's actual layout container for the attachment; empty when unattached. No synthetic workspace masquerading as a session. |
| `harness` | Actual `codex`, `claude`, `amplifier`, or the existing open-set value. |
| `project` | Explicit absolute launch cwd, updated only by an authoritative cwd declaration. |
| `name` | User title or first prompt; stable across turns and resumes. |
| `label` | Stable short subject; preserve the existing label on absent updates. |
| `mode` | `interactive` for attended chat/CLI, including Operator dispatch of an ordinary turn. `autonomous` only for an actual supervised goal loop. Headless does not mean autonomous. |
| `state` | Turn/prompt start → `working`; unresolved declared human request → `blocked`; ordinary turn completion → `stopped`; terminal run failure → `failed`; explicit goal satisfaction → `done`. Individual recoverable tool errors only update activity. |
| `waiting_for` | Existing exact enum, e.g. `permission prompt` or `input needed`, only while blocked. Clear on resolution. Ordinary prompt rest is stopped, not blocked. |
| `doing` | Bounded summary of current tool/item/hook activity, then final turn summary. Keep source fidelity; no token-by-token fleet writes. |
| `done_means` | Declared current goal condition, absent/empty for ordinary interactive work; clear on human takeover of goal work. |
| `goal_id` | Daemon-stamped launch-condition digest, preserved across attachment changes. Never inferred from current prose. |
| `origin` | Daemon launch provenance: `browser`, `agent`, `cli`, `trigger:<id>`, or genuinely unknown empty value. |
| `knows` | Deduplicated confirmed file-read paths only. Amplifier artifact-read, successful Claude Read, or explicit Codex read-tool evidence; omit unobservable reads rather than parse arbitrary shell text as fact. |
| `todo` | Codex plan updates; complete recognized Claude task/todo payloads; Amplifier root todo. Count completed/total and current item. Omit if no known list; never `0/0`. Partial task events do not fabricate a total. |
| `pr` | Confirmed linked PR number from an explicit report or verified artifact linkage; otherwise existing zero/empty semantics. Tool completion alone does not identify a PR. |
| `updated_at` | Unix seconds of the last accepted semantic observation, not a browser heartbeat or repaint. |

Keep the existing `machine` field too. `lane_transcript(session_id)` resolves
through the registry: native bounded reader for terminal history, durable muxterm
journal for chat, and a segmented view after handoff. It reports truncation and
missing segments explicitly. `session_send` resolves the same ID and control
owner; it queues chat input or uses the existing terminal input mechanism.

Managed histories survive process exit and terminal closure until explicitly
archived/deleted. The fleet can hide archived sessions, but history search still
finds them. For legacy unmanaged rows, preserve today's terminal retention and
24-hour spool cleanup; adoption imports identity and references without rewriting
native history. Closing a terminal view is not deleting a managed conversation.

## 5. Chat storage is part of admission, not a UI cache

Store managed session data under `$XDG_DATA_HOME/muxterm/agent-sessions/`, with
the normal user data-directory fallback, private directories/files (0700/0600).
Use daemon-owned append-only event journals plus atomically replaced indexes and
metadata; retain a single writer and an ownership lock. Runtime spool snapshots
are disposable projections, never the transcript database.

Persist normalized user messages, assistant blocks/deltas, tool requests/results,
approvals, errors, run boundaries, native IDs and handoff boundaries. Use ordered
sequence numbers, run/turn IDs, provider item IDs and client submission references.
Large tool output goes to bounded referenced blobs; record clipping and retain
the visible conversation. Do not log credentials or indiscriminately retain raw
provider reasoning. Persist the same blocks the browser renders.

The durability sequence is a requirement:

1. Persist and fsync the user's submission and queue entry before acknowledging
   it. Reusing a `client_ref` returns the same admission. A double click or
   reconnect must not execute a second turn.
2. Persist a dispatch intent, then call the harness. Record native acceptance
   and identifiers. Dispatch without a confirmed result is **uncertain**, not
   permission to retry a possibly side-effecting turn.
3. Append stream events before broadcasting them; batch deltas briefly (target
   100 ms) and fsync each batch before exposing it as committed chat text.
   Persist approvals, final answers and run outcomes immediately.
4. Refresh loads a durable snapshot and a sequence cursor, then replays later
   events with dedupe. The browser may show local drafts, but never owns the
   only copy of acknowledged chat. Queue and approval cards replay too.
5. Recover a truncated final journal record after a crash; validate earlier
   records, rebuild indexes, and expose corruption without clearing history.
   On disk-full, stop accepting turns and stop advancing visible committed
   output; surface a storage error and preserve the readable prefix.

The server process may restart while sessiond and its child keep working; the
browser reconnects to persisted history. A sessiond crash can lose an active
transport: reconcile native history against the last durable cursor, mark an
unresolved run interrupted/uncertain, and require an explicit continuation.
Do not automatically replay user prompts or tool calls. Native-to-muxterm tail
reconciliation after a crash is **ASSUMED A3**, not an exactly-once vendor guarantee.

Harness persistence and muxterm persistence serve different purposes. Harness
files retain execution context for resume; muxterm owns refresh-surviving chat,
admission and control records. Deleting or losing native history must not erase
readable chat. Conversely, a readable chat does not prove the harness can resume.
A missing native session is an explicit error with an option to start a clearly
linked new session, never a silently empty replacement.

The Operator's existing native SessionStore, exact storage scope, root lock,
durable FIFO and history remain authoritative for Mission Control. Do not migrate,
merge or repoint that conversation into the new worker-session journals.

## 6. Human takeover has an explicit boundary

For a terminal session, preserve today's real PTY: Open terminal focuses it and
a human can type. Manual control suspends further Operator sends. sessiond remains
authoritative for terminal activity and destructive closure.

For a chat session, distinguish three actions:

- **Answer in chat:** reply to the live approval/question card, or send a follow-up
  at a turn boundary. Codex uses the documented request IDs. Claude V1 uses a
  launch-scoped `PermissionRequest` hook backed by muxterm's approval broker;
  ordinary questions can be answered in the next resumed turn. Do not implement
  a guessed Claude stdin control protocol. **ASSUMED A2:** holding the hook while
  the broker waits and returning the documented decision preserves the original
  request on the installed build. Bound the wait and deny on expiry. If this
  verification fails, route permission intervention to terminal and keep the
  chat permission feature disabled until a verified transport exists.
- **Stop:** stop accepting new sends for this generation. Codex requests
  `turn/interrupt` and waits for acknowledgment/outcome. Claude V1 interrupts only
  its owned child process group, waits, and escalates only against that still-
  verified child if necessary. Never signal a shared vendor daemon. An interrupted
  tool may already have changed files; preserve its outcome as unknown if unreported.
- **Take over in terminal:** reserve exclusive human control; interrupt and drain
  the run, flush history, and prove the old executor and its owned work have
  stopped before starting another writer. Start `codex resume <native-id>` or
  `claude --resume <native-id>` in a real muxterm PTY at the recorded cwd and
  permission profile. Attach that pane to the SAME session row. Show the handoff
  boundary in chat and make its composer read-only while the terminal owns control.

**VERIFIED:** installed Codex and Claude help advertises resume by ID.
**ASSUMED A3:** cross-surface resume after interruption preserves all completed
context and releases ownership cleanly for these builds. Verify both directions
with an interrupted tool and a two-turn conversation before enabling takeover.
If the process cannot be proven stopped, leave takeover blocked with its actual
status. If native resume fails, retain the transcript and open a project shell
for repair; a new agent conversation requires a labeled new-session action.
That is a usable human escape hatch, not a claim of seamless context transfer.

To return to chat, the person releases control, the terminal harness exits,
muxterm imports the new bounded native transcript segment and resumes by the same
ID. Do not inject Ctrl-C into a person's actively used terminal as an implicit
side effect of selecting Chat. If a fork is requested, make it a new session with
an explicit parent reference. Concurrent browsers share one control state; stale
approval replies and sends with an old generation are rejected.

The terminal is not the stdout pipe of a headless process. There is no hidden TUI
to grab mid-token; the handoff is interrupt, persist, and resume with one writer.

## 7. Hooks, progress and poller migration

Keep Amplifier's shipped module and v1 snapshots. Preserve declared tool/read/todo
and approval signals, and keep the optional label/classifier separate from facts.
No Amplifier source change or amplifier-agent replacement is needed here.

For Claude PTYs, add a muxterm command hook using launch-scoped `--settings` (or
a muxterm-owned plugin loaded for that invocation). **VERIFIED:** installed help
advertises both launch options. Report SessionStart, UserPromptSubmit, tool
pre/post/failure, PermissionRequest, Stop and SessionEnd to the existing snapshot
contract. Observer hooks return promptly without modifying policy; the optional
chat approval hook is separate. Confirm successful hook loading visibly.
Arbitrary manually launched CLIs keep poller discovery until explicitly integrated.

For Codex PTYs, retain `codex-notify` as the compatibility floor; implement the
richer documented hooks only behind a verified capability probe. Preserve existing
user hooks and notify behavior rather than replacing configuration wholesale.
Muxterm-owned configuration must compose with user config; no global rewrite.
The concurrent Codex-hooks branch is not evidence of released behavior; reconcile
with it before implementation instead of landing a competing hook installer.

The Claude poller is **replaced as state authority for integrated sessions**, not
abruptly removed for everybody. Migration order:

1. Add visible adapter health: last successful observation, error category,
   capability level and stale status. Missing binary and invalid JSON must be
   visible even when no row was ever created. Preserve existing opt-out semantics.
2. Add hooks for new PTY launches; let a confirmed hook registration claim its
   native ID. Stop poller writes/deletions for claimed IDs. Merely missing a hook
   event is not authority to overwrite a richer row with old polling data.
3. Structured chat is always owned by its adapter. Disable polling for it. Keep
   coarse discovery for uninstrumented existing PTYs, explicitly marked degraded.
4. Remove browser-subscription gating from managed progress and result recording.
   Hooks already run without a browser; managed child supervisors must too.
   Remove the poller entirely only after unmanaged discovery has a verified
   replacement or an explicit compatibility removal decision.

Telemetry failure is not task failure. Keep the last declared state and mark its
reporting health stale; do not invent `working`, `blocked` or `done`. Unknown
protocol events are retained as bounded diagnostics and trigger a visible
capability warning. Malformed required envelopes stop the adapter with a readable
error, not a phantom successful result. Retry recoverable transport connections,
never uncertain work submissions automatically.

## 8. Operator as the usual entry point

Mission Control opens to the single Operator conversation with its existing fleet
rail. “Fix the refresh bug with Codex” admits a durable session, shows its row
immediately, and links to its Chat/Terminal detail. Launch is explicit about
harness, project and control surface; it does not require selecting a workspace
or creating a terminal tab first. Direct New session and New terminal remain
available for people who already know what they need.

Reuse the existing `spawn_lane`, `fleet_status`, `lane_transcript` and
`session_send` seams, extending spawn with a surface choice and stable session ID.
Do not add a second Operator, conversation selector or project-to-chat router.
The Operator manages and monitors; the worker session executes the work.

Persist results/attention through the existing lifecycle marker and Operator
notice infrastructure. Extend dedupe to `(session, run/turn, event kind)` so the
second completed turn is not swallowed by the old session/kind key. Give every
result a causal link back to its launch and durable transcript cursor. Retry
notice delivery independently of task execution. Seed migration baselines so
historic completions do not replay as new work.

Progress is visible continuously in the fleet/detail without forcing an LLM turn
for each tool event. Coalesce activity updates (target no more than one row update
per second). Feed a bounded progress milestone to the Operator notice FIFO after
a declared todo milestone or a sustained interval (initial target 30 seconds,
only if activity changed), and send final/blocked notices promptly. Do not put
synthetic notices ahead of already queued human input or narrate token streams.
These are implementation targets, not measurements. Extend the existing notice
envelope with structured progress facts; do not feed arbitrary full transcripts
into automatic notices. An explicit `lane_transcript` request remains available.

UI nouns become **Sessions**, **Projects**, **Chat**, **Terminal**, **Files** and
**Changes**. Workspaces remain internal layout/project containers and tabs remain
an optional terminal arrangement. Rename the entry points; do not delete PTYs,
splits, layout restoration or existing API IDs. Closing a view detaches it;
Stop session and Archive session are distinct actions. A plain shell remains a
first-class terminal even when no agent session is attached to it.

## 9. Credentials and process ownership

This is a single-human-owned local application. Run children as that same OS user
with an explicit executable, cwd and inherited credential environment. Let the
CLI use its own existing login/config machinery; do not copy tokens into muxterm's
journal, browser, settings UI or a new credential database. Keep the existing
browser authentication/origin controls. No tenant identities, account brokerage,
per-tenant token vaults or hosted-service architecture are needed.

**VERIFIED:** Codex help describes its normal config location; Claude and Codex
expose their own authentication commands. **ASSUMED A4:** the production service's
user, HOME, PATH and credential helpers give the child the same authenticated
access as an interactive shell. Verify with one real turn per harness in dev-local;
help output cannot prove login works. An auth failure is a visible blocked/input
condition or startup failure, with instructions to authenticate using the CLI.
Do not silently switch to an API key or a differently billed account.

The decision to use an SDK does not universally imply separate credentials, but
neither SDK documentation nor a same-user process guarantees login compatibility.
The selected path delegates authentication to the actual CLI. No global Codex,
Claude or muxterm configuration edit is part of this design PR.

sessiond owns worker process lifetimes so closing a browser or restarting the web
server does not stop a task. Each managed session has a bounded active executor;
Codex gets a private app-server child, Claude one child per turn. Neither attaches
to or kills the owner's shared vendor daemon. Child concurrency, stream buffers
and output sizes are bounded. Launch failures retain the admitted session and
error transcript. Existing lane permission profiles remain explicit; chat must
not enable permission bypass just to make a stream run unattended.

## 10. PR plan

This document is PR 0. Implementation starts with **PR 1**, because today's silent
Claude reporting failure already misleads the owner and its visibility is needed
throughout migration. **PR 1 is the smallest PR with real user-visible value:** a
fleet reporting-health indicator and diagnostic details, without new executors.

Each PR below has a narrow review boundary and can ship with later capabilities
disabled. No PR adds unit tests. Feature verification uses real browser + real
sessiond + actual harness processes through `make dev-local` on 8313, with fresh
fixtures; service lifecycle scenarios use a DTU. Never exercise production 9090,
8311, the broker at 8088, or global user config. Store research and verification
artifacts outside git; put concise results and relevant evidence in each PR body.

| Order | Independently reviewable scope | Verification and release gate |
|---|---|---|
| **1 — Make reporting failure visible** | Expose Claude adapter health/capability and last success in the existing fleet UI. Preserve opt-out and keep session state distinct from stale telemetry. | In dev-local, use an isolated executable path to exercise missing binary, nonzero exit and malformed output, then restore a real Claude CLI. Browser shows failure and recovery, including when there are zero Claude rows. Existing Amplifier/Codex rows stay intact. |
| **2 — Terminal hooks into one authority** | Claude launch-scoped hooks; Codex richer hooks after capability proof, coordinated with existing hook work. Preserve v1, notify fallback and unmanaged poller discovery; prevent competing writers. | Real Claude/Codex PTYs: prompt start, tool, permission prompt, denial, completion, CLI exit, browser absent/reconnect. Confirm unchanged user config/hook behavior, one row per native ID and no stale poller overwrite. Resolve A1. |
| **3 — Durable session identity and history** | Registry, alias map, event journal, admission/dedupe and recovery; v2 managed placement and pane-less row semantics across existing collector, MCP and UI. Native transcript references for existing sessions. Chat creation still disabled. | Real browser/sessiond adoption and history views: refresh, reconnect, title change, terminal close, data reload, duplicate sends, PID reuse/stale generation rejection. In isolated recovery verification, truncate only a fresh fixture journal and simulate unavailable storage. Existing v1 scripts still render identically. |
| **4 — Codex chat vertical slice** | Go app-server adapter, durable chat renderer/composer, approval cards, stop and explicit resume; all exact fleet fields and native ID binding. | Two real turns, a command, plan update, approval allow/deny and failure; close browser mid-turn, refresh, reconnect to final answer with no missing/duplicate message. Kill only the isolated child, verify uncertain-turn behavior. Establish A4 for Codex and do not enable unverified takeover. |
| **5 — Claude chat vertical slice** | Go print/stream adapter and per-turn resume using the shared journal/UI; launch-scoped approval bridge and visible stream errors. | Two real resumed turns, partial output, Read/tool success/failure, approval expiry/deny/allow, browser refresh during output, absent native transcript and child interruption. Resolve A2/A4; if broker semantics fail, release only the clearly labeled terminal intervention path, not a false chat approval button. |
| **6 — Human takeover and return** | Exclusive control generation, interrupt/drain, real PTY resume, transcript boundary/import, return-to-chat and project-shell repair fallback for both harnesses. | For each harness, interrupt during a real tool and approval wait; take over, type a follow-up, release back to chat. Confirm one row/ID, one executor, preserved completed context, rejected stale browser sends and durable refresh history. Exercise native-resume failure. Resolve A3 before enabling seamless handoff controls. |
| **7 — Operator entry and durable reporting** | Extend existing spawn/send/read tools and lifecycle markers; durable per-turn notice causality and bounded progress milestones; Sessions/Projects navigation and terminal capabilities. | Start both chat and PTY sessions from Operator; observe progress and blocked/final result with browser absent then refreshed. Two turns of one session each report once. Restart only isolated web server, verify FIFO and notice retry. Existing Mission Control history/scope and terminal keyboard workflows survive. |
| **8 — Compatibility cleanup** | Make hooks primary for integrated PTYs, retain visibly degraded unmanaged discovery, document supported CLI versions and rollback. Remove obsolete UI workspace/tab entry language. | Mixed Amplifier, Claude, Codex and script fleet in one browser/MCP response; old v1 producer, CLI downgrade, disabled bridge, failed resume and archive/reopen. No disappearance or duplicated sessions. |

PRs 4–5 are usable worker-chat slices. PR 6 is the release gate for cross-surface
handoff, and PR 7 makes sessions the normal product entry. Do not hide the
persistence foundation in a cosmetic navigation PR or claim the whole initiative
finished after a launcher demo. No Amplifier engine replacement is in this plan.

Rollback disables new chat admission and selects terminal launch without deleting
journals, aliases or native transcripts. Existing chat remains readable. Older
binaries skip v2 runtime snapshots; they must not open a newer durable store for
writing. Record a store schema version and refuse destructive downgrade. Data
format conversion, if ever necessary, is an explicit separate migration.

## 11. Verification record and remaining assumptions

**VERIFIED:** research inspected the full contract, named source paths, installed
CLI help, official documentation and generated Codex protocol schemas. No model
turn, new runtime feature or browser integration was executed for this design.
The PR contains documentation only; it makes no claim of implemented chat or
working takeover. Logs and schema dumps are research artifacts, not repository
files. Static-check results belong in the PR description.

All runtime assumptions relied on or considered above, consolidated:

| ID | ASSUMED capability | Confirmation / safe limit |
|---|---|---|
| **A1** | Rich Codex hooks and launch-scoped Claude hooks load, report the required events and attribute them correctly on the installed builds. | PR 2 real PTY/browser observations with unchanged global config. Keep notify/poller fallback plus visible degraded health until confirmed. |
| **A2** | Claude's command permission hook can hold a print-mode request for muxterm's broker and return a decision without losing its identity or turn. | PR 5 real allow/deny/expiry and reconnect. If false, terminal intervention remains available; no guessed stdin control protocol or automatic permission bypass. |
| **A3** | CLI chat→terminal→chat resume, ownership release and native tail reconciliation preserve completed context after interruptions. | PR 6 real tool-interruption and bidirectional handoff, plus isolated crash/recovery. Preserve history and offer a project shell when continuation cannot be established. |
| **A4** | Same-user service children can use the owner's current CLI authentication and credential helpers. | A real dev-local turn per harness under the service-equivalent environment. Fail visibly; never switch credentials/accounts silently. |
| **A5 — not relied on** | amplifier-agent is a drop-in replacement for muxterm's existing Amplifier CLI hooks, bundles and Operator SessionStore. | Requires a separate installed-engine compatibility study. Preserve the existing integration; this design makes no such migration. |

No additional SDK capability is presumed. No implementation, release, merge,
hosted tenancy, mobile-specific work or new infrastructure provisioning is part
of this document.
