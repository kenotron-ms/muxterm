# Sessions report through hooks; terminals are optional attachments

**Status:** research and design only; revision of PR #176, not implementation.
**Date:** 2026-09-22. **Source baseline:** v0.42.0, `7681ab4`.
**Extends:** [Session-state protocol](../session-state-protocol.md).

**Short summary:** All harnesses report through one hook-report contract. A native
session ID creates a durable fleet session even without a muxterm pane. Replace
Claude polling entirely with Claude hooks; generalize Amplifier's existing event
semantics; use Claude as the rich-hook reference; accept both Codex notify and richer Codex hooks through the same ingress.
Muxterm-owned launchers inject and verify hooks for both interactive commands and
Operator lanes; raw vendor CLI launches are outside guaranteed fleet coverage.
Make missing launch instrumentation and rejected delivery visible. Keep real terminals,
durable transcripts, and the single existing Operator conversation.

## 1. The failure that determines the architecture

**VERIFIED: owner-supplied end-to-end lane result, not rerun in this revision.**
The lane configured `notify = ["muxterm","session","codex-notify"]`, started
Codex outside muxterm, and completed a real turn. The hook fired, but the session
was excluded because it had no muxterm pane. This disproves the premise that
installing hooks alone fixes discovery. Successful delivery is not successful
fleet admission under the current data model.

**VERIFIED: read `internal/sessiond/sessionstore.go`, `(*sessionStore).collect`.**
For a live snapshot, it calls `placeSnapshot(snap, owners)` and executes `continue`
when placement fails: the report remains on disk but has no fleet row. For an
exited process with a terminal state, failed placement deletes the snapshot.
The second phase groups by `paneRef` (`byPane`) and retains live rows or only the
newest ending per pane. Thus persistence and visibility both depend on a pane.
`placeSnapshot`, `resolvePaneForPID`, and `stampPane` are attachment helpers that
currently act as admission gates. They must cease being session existence gates.

**VERIFIED: read `cmd/muxterm/codex_notify_cmd.go`, `runCodexNotify`, and
`internal/sessiond/codex_notify.go`, `CodexRowFor`.** The CLI translates the native
thread ID and writes a snapshot through `WriteSessionSnapshot`; its own help says
an outside-pane report is written and not shown. The exclusion is in the collector,
not evidence that Codex failed to call its hook. The protocol's statement that
omitting such a session is correct must be replaced in the implementation PR.

**Hard decision:** sessions are primary once a valid hook report arrives. No pane,
workspace, live PID, pre-registration, managed run, or browser subscription is
required to admit that report. Guaranteed reporting begins at muxterm-owned launch
boundaries: `muxterm claude`, `muxterm codex`, `muxterm amplifier`, and Operator
lane launch. Those paths inject hooks for that invocation and verify delivery.
Direct `claude`, `codex`, or `amplifier` launches do not have guaranteed fleet
coverage and do not require muxterm to modify global harness configuration. The
Claude five-second poller is removed, not retained for raw vendor launches. Hooks
are the sole harness reporting mechanism. Different native hooks require
translators, not different state paths.

## 2. Evidence and installed capability boundary

“VERIFIED” means the cited command, source, or document was read, not that a new
runtime integration was executed. Runtime integration gates are marked ASSUMED
and consolidated at the end. Everything specified as a contract below is a design
requirement, not a claim that it already shipped.

Research artifacts are outside git under `/home/ken/artifacts/`. No paid model turn was run.
No live harness settings, Amplifier source, production services, or ports changed.
The existing PR and its complete document were read before revising it.

### Correction of the false premise and granularity verdict

**VERIFIED: read `internal/sessiond/claude_adapter.go`, lines 18–23.** The
historical rationale says:

> Why a poller and not a hook: Amplifier has an in-process module system, so
> its producer can be an event handler that declares state as it changes.
> Claude Code has no equivalent extension point, but it does have a documented
> scripting output -- `claude agents --json`, "Print active sessions
> (interactive and background) as a JSON array and exit (for scripting; does
> not require a TTY)". Polling that is the whole integration.

**That rationale is false.** This design replaces it with the following rationale
(the Go file and its runtime logic are unchanged in this documentation PR):

> Claude Code exposes native lifecycle, prompt, permission, tool and stop hooks,
> distributed through settings or plugins. Muxterm loads its Claude plugin on each
> muxterm-owned invocation and reports these events through the common session
> ingress. The legacy polling adapter is removed in the Claude migration; raw
> `claude` invocations outside the muxterm launcher are no longer discovered.

**VERIFIED: [Claude hook reference](https://code.claude.com/docs/en/hooks),
[Codex hook reference](https://learn.chatgpt.com/docs/hooks), installed enums/schemas
below, and Amplifier `_register_state_publisher`.** Claude has the broadest verified
native event vocabulary in this comparison and is the **reference implementation
for rich hook reporting**. All three support tool-call granularity; a strict
Claude > Amplifier > Codex resolution ranking is unsupported. Claude covers
built-in WebSearch/WebFetch and MCP tools (excluding EndConversation), whereas
Codex's documented tool hooks exclude hosted tools such as WebSearch and some
specialized paths. Amplifier's existing module provides richer explicit goal,
artifact-read and todo semantics. Codex **legacy notify** is the coarsest tier,
limited to completed turns; that is not the ceiling of installed Codex 0.155.1.
Do not replace the false Claude premise with a false Codex premise.

### Claude 2.1.280: hooks sufficient to replace polling

**VERIFIED: `claude --version`; `claude --help`; read
[hooks](https://code.claude.com/docs/en/hooks) and
[settings](https://code.claude.com/docs/en/settings).** Help exposes `--settings`,
`--setting-sources`, `--include-hook-events`, `--safe-mode`, and `--resume`.
Help explicitly warns that invalid settings can be silently ignored in print
mode. That makes a written config insufficient proof of reporting health.
The existing [delegation design](2026-09-06-cos-delegation-model.md) already names
Stop and SessionEnd in `~/.claude/settings.json`.

**VERIFIED: Python read-only extraction from
`/home/ken/.local/share/claude/versions/2.1.280`: the embedded `var qf=[...]`
hook-event enum contains the following 33 events.** This is an actual event enum,
not a guess from a CLI version or isolated binary strings:

```
PreToolUse PostToolUse PostToolUseFailure PostToolBatch Notification
UserPromptSubmit UserPromptExpansion SessionStart SessionEnd Stop StopFailure
SubagentStart SubagentStop PreCompact PostCompact PreModelSwitch PostModelSwitch
PermissionRequest PermissionDenied Setup TeammateIdle TaskCreated TaskCompleted
Elicitation ElicitationResult ConfigChange WorktreeCreate WorktreeRemove
InstructionsLoaded CwdChanged FileChanged DirectoryAdded MessageDisplay
```

**VERIFIED: fetched the settings schema linked by Claude's official settings
page, `https://json.schemastore.org/claude-code-settings.json`.** Its hook properties
contain 31 of those events; PreModelSwitch and PostModelSwitch are missing there
but present in the installed enum and official hook reference. The public schema
lags the binary; it is not a reason to deny the installed events. Embedded matcher
and output switch statements also reference the events. Runtime dispatch through
muxterm's future configuration remains **ASSUMED A1**.

**VERIFIED: fetched both
`https://docs.claude.com/en/docs/claude-code/hooks` and
`https://docs.anthropic.com/en/docs/claude-code/hooks`; both redirect to the canonical
hook reference above.** Read the full canonical reference, settings documentation
and [plugin reference](https://code.claude.com/docs/en/plugins-reference).

**VERIFIED: `claude plugin --help`; `claude plugin install --help`; read-only
Python JSON selection of `enabledPlugins` and `extraKnownMarketplaces` from
`~/.claude/settings.json`.** The CLI supplies plugin management and user/project/local
installation scopes. The owner's settings contain
`superpowers@superpowers-marketplace: false` and a marketplace sourced from GitHub
`obra/superpowers-marketplace`: marketplace support is present; this plugin is
currently disabled. Neither its presence nor its disabled state proves muxterm
hooks were configured. `claude --help` lists no standalone hooks subcommand;
[the documented interactive `/hooks` menu](https://code.claude.com/docs/en/hooks#the-hooks-menu)
is the hook inspection interface. No interactive session was started for this audit.

**VERIFIED: read-only Python extraction of the installed settings validator:**
`hooks:vK().optional()` and `vK=p(()=>kot(V(qf),C(It())))` connect settings hooks to
the 33-event enum, while plugin hooks use the same validator. The accepted shape
is `hooks: { EventName: [{ matcher?, hooks: [{ type: "command", command, timeout? }] }] }`.
The linked public schema independently documents this shape. This is schema/code
inspection, not a claim that an actual new configuration was loaded; that remains A1.

### Codex 0.155.1: notify is not the hook ceiling

**VERIFIED: `codex --version`; `codex --help`; read
[Codex hooks](https://learn.chatgpt.com/docs/hooks).** Help exposes TOML `-c`
overrides, strict config validation, and hook trust controls. Do not install a
trust-bypass flag as the integration's normal behavior.

**VERIFIED: read-only JSON decoding of embedded schemas from
`/home/ken/.codex/packages/standalone/releases/0.155.1-x86_64-unknown-linux-musl/bin/codex`.**
Twelve valid `*.command.input` schemas contain `hook_event_name` constants:

```
SessionStart SessionEnd UserPromptSubmit PreToolUse PermissionRequest PostToolUse
PreCompact PostCompact SubagentStart SubagentStop Stop Interrupt
```

These independently corroborate the documented richer hooks on the installed
build. Native `session_id`, `cwd`, nullable `transcript_path`, and turn-scoped
`turn_id` are in these schemas. Subagent events carry `agent_id`; their session ID
belongs to the parent. The capture is `codex-embedded-input-schemas.json`.

**VERIFIED: `CodexNotify` and `CodexRowFor` in `internal/sessiond/codex_notify.go`.**
Legacy `notify` supplies `agent-turn-complete`, `thread-id`, `turn-id`, `cwd`,
input messages and final assistant message. It supplies no start, mid-turn wait,
or failed-turn report. That integration remains an honest completion-only tier.
Richer hook delivery, trust, and tool coverage in real muxterm sessions remain
**ASSUMED A1**, even though their interfaces are verified. No app-server stream
or SDK is needed to establish the existence of finer-grained hooks.

### Amplifier: existing semantic translator, not a replacement engine

**VERIFIED: read `modules/hooks-muxterm-session/amplifier_module_hooks_muxterm_session/`
`__init__.py` (`mount`, `_register_state_publisher`), `state.py`
(`SessionStateTracker`), `classify.py`, and `label.py`.** Its registered vocabulary:

```
session:start session:fork prompt:submit tool:pre tool:post tool:error
provider:error artifact:read approval:required approval:granted approval:denied
user:notification orchestrator:goal_progress orchestrator:complete
prompt:complete session:end
```

The module translates those events into snapshots today. Root `todo` tool input
supplies counts; artifact reads supply known paths; child work contributes parent
activity without overwriting the parent's todo list. Goal progress supplies mode
and condition. Intermediate `orchestrator:complete` with `goal_final=false` keeps
working; root `prompt:complete` ends the turn. Optional label and closing-answer
classification are fallible interpretations, distinct from structural state.
`user:notification` is registered but the source explicitly says the current
kernel has no emitter: do not promise notifications from it.

Preserve this module's semantic enrichment; Claude is the native hook-reporting
reference, without inventing Amplifier-specific goal fields for other harnesses. A future muxterm
module update changes only its reporting sink to the common command. No Amplifier
engine replacement, SDK migration, or Amplifier source edit belongs in this PR.

## 3. One ingest contract for every muxterm-owned launch

Define one command: **`muxterm session hook-report`**, reading one bounded UTF-8
JSON envelope from stdin. Native Claude/Codex wrappers translate native JSON into
this schema; Codex's existing `codex-notify` becomes a compatibility translator
into this same path. Amplifier's Python module sends the same schema to this
command. There is no alternate native-stream-to-fleet writer.

Example normalized report (illustrative contract, not an existing CLI feature):

```json
{
  "v": 2,
  "harness": "codex",
  "native_session_id": "019-example-thread",
  "native_event": "agent-turn-complete",
  "event": "turn.completed",
  "event_id": "codex:019-example-thread:turn-7:complete",
  "turn_id": "turn-7",
  "run_id": null,
  "observed_at": "2026-09-22T12:00:00Z",
  "process": {"pid": 1234, "pid_start": "98765"},
  "parent_native_session_id": null,
  "transcript": {"path": null},
  "set": {"project": "/home/ken/work/project", "doing": "Updated the design"},
  "clear": []
}
```

Required: `v`, allowlisted harness adapter, nonempty `native_session_id`,
`native_event`, normalized `event`, stable per-delivery `event_id`, `observed_at`.
All other envelope members are optional. `set` is a partial semantic patch;
omission preserves prior values, and `clear` explicitly removes optional values.
Unknown schema versions and invalid fields are rejected with a diagnostic receipt.
Bound each envelope to 64 KiB; no full tool output or transcript in fleet patches.
Allowed events: `session.started`, `session.ended`, `turn.started`,
`turn.completed`, `turn.failed`, `turn.interrupted`, `tool.started`,
`tool.completed`, `tool.failed`, `attention.required`, `attention.resolved`,
`progress.updated`, `context.read`, and `metadata.updated`.
A normalized event does not imply every harness can produce it.

**Identity:** the command obtains a persistent local muxterm installation UUID;
it never trusts a producer-supplied machine ID. The unique registry key is
`(installation_uuid, harness, native_session_id)`. Codex sends `thread-id` from
notify or `session_id` from richer hooks; Claude sends hook `session_id`;
Amplifier sends the coordinator event's root `session_id`. None comes from a pane.
The first accepted event of ANY kind upserts a session and allocates a stable
muxterm `session_id`. Repeat reports and native resumes resolve that same unique
key. No SessionStart is necessary before a completion. Preserve existing adopted
IDs (`codex-...`, `claude-...`, Amplifier native IDs) as aliases. Native forks get
new identities and explicit parent links; cwd/title never deduplicate sessions.
Missing native identity is a visible rejected report, never a guessed pane ID.

Every muxterm-owned launch reserves a row and one-time correlation token before
native identity exists. This includes an interactive `muxterm <harness>` command,
not only Operator lanes. The launch hook binds the native ID to that reservation;
any valid report that arrives from optional user-installed hooks can still
auto-register without such a token, but raw vendor launches are not a guaranteed
discovery surface. `run_id` identifies execution, not the
conversation; the command may derive an external process incarnation from
PID/start time when available. Absent process metadata does not prevent admission.
Resume retains conversation ID and creates a new execution generation.

The command durably queues each report in a private installation-scoped inbox
under the data directory, using temp-file/atomic rename plus fsync. It returns a
receipt (`queued`, report ID) after durability, not a false claim of fleet display.
A single daemon consumer journals accepted events, projects fields, and writes an
`accepted` receipt with session ID or a `rejected` diagnostic. Watch/replay the
inbox even without a browser. A directory reconciliation timer is delivery recovery,
not polling a harness. Bound the outbox; disk-full returns nonzero and records an
error when possible. Native observer wrappers keep the harness running and emit
stderr diagnostics rather than changing its permission decision.

Dedupe by installation/session/event ID. Prefer native turn/tool/request IDs plus
event kind; where absent, the adapter durably assigns a delivery UUID before retry.
Do not hash prompt text: repeated identical prompts are different turns. The
consumer assigns journal sequence numbers. Keep native turn/request correlation;
a late completion cannot overwrite an explicitly newer active turn. With missing
causal ordering, preserve the event but mark current state uncertain instead of
ordering by wall clock alone. Concurrent external executors sharing one native ID
produce a visible conflict; muxterm does not kill them or invent separate sessions.

Only the registry supplies `session_id`, `pane_id`, `workspace_id`, `goal_id`, and
launch `origin`; reject producer patches to them. PID/start/SID are evidence for
optional attachment only. Same-user private files and owner checks are sufficient
for this single-human application; no multi-tenant identity service is introduced.

## 4. Exact data-model changes and compatibility break

**VERIFIED: read `SessionState` in `internal/sessiond/sessionstate.go`, its mirror
`web/src/lib/session-state.ts`, `internal/mcp/fleet.go`, and the collector above.**
Today `PaneID` is a required integer and session comments define a row as running
in a muxterm pane. `GoalID` and `Origin` are stamped from pane launch metadata.

Implementation changes required together:

1. Add durable `SessionRecord` keyed by session ID, unique native aliases, current
   execution generation, transcript references and reporting health. Add an
   optional `TerminalAttachment` with pane/workspace and validated process binding.
   Store launch provenance on the session, independent of that attachment.
2. **`pane_id` becomes OPTIONAL**, represented as nullable `*int` in Go and
   `number | null` on the versioned wire; `workspace_id` likewise becomes nullable.
   Emit JSON null when absent, never `0` or a synthetic workspace. Retain the
   snake_case MCP/camelCase browser spelling mirror. No consumer may treat null
   as a usable terminal address.
3. Project the durable registry by session ID. Remove `collect`'s placement gate,
   pane-based ending supersession and pane-close deletion for adopted sessions.
   `stampPane` enriches an optional attachment only. A dead process invalidates
   attachment/liveness, never conversation existence or stored history.
4. Update fleet MCP projection, sorting/hashing, home-session store, grouping,
   row keys, navigation, lifecycle-notice dedupe, transcript resolution, and
   send/close handlers. A pane-less row opens session detail; terminal-only actions
   show unavailable. External reports grant observation, not control of a terminal
   muxterm does not own. Never send to some other pane as fallback.
5. Version the wire/protocol because null breaks integer-only clients. Negotiate
   support; incompatible clients receive an upgrade message, not a silently
   filtered fleet. Update the public protocol's placement and retention rules.
   Legacy v1 files can pass through a compatibility importer into the same registry;
   they cannot remain a second pane-keyed harness fleet. Import once with explicit
   source/identity mapping. Do not delete unrelated script snapshots.

Keep PID reuse protection for attachments. Keep sessiond's terminal activity and
destructive-close authority unchanged. Closing a view or terminal detaches it;
archiving/deleting a conversation is an explicit, different action. Default fleet
filtering may hide archived rows but cannot discard their transcripts.

## 5. Native event maps and honest progress

Every event in the next Claude table is **VERIFIED: installed 2.1.280 event enum
extraction and the official hook reference read in section 2**. Mapping is the
muxterm contract, not a claim these translators already exist.

| Claude native events | Normalized event and fleet effect |
|---|---|
| SessionStart | `session.started`; bind identity, project/cwd, declared session_title; initialize mode/state only for a new execution. Compact/resume metadata must not reset an already active turn. |
| UserPromptSubmit | `turn.started`; working, clear waiting, first prompt name, bounded doing. |
| UserPromptExpansion | Metadata only; an expansion is not proof of executed work. |
| PreToolUse | `tool.started`; doing/tool activity; do not invent permission outcome. |
| PostToolUse | `tool.completed`; working; successful recognized Read adds knows; complete recognized task payload can update todo. |
| PostToolUseFailure, PostToolBatch | `tool.failed` or progress; doing/error or batch milestone; recoverable tool failure is not session failure. |
| PermissionRequest | `attention.required`; blocked/permission prompt when a request is exposed. |
| PermissionDenied | Denial activity; no inference that every denial ends a turn or remains blocked. |
| Notification | Map declared attention categories only; permission prompt can block, ordinary idle notification remains stopped. |
| Elicitation, ElicitationResult | Input-needed wait and resolution, correlated by request; resume working only on matching resolution. |
| Stop | `turn.completed`; stopped, clear waiting, bounded final summary when supplied; not proof that the owner's task is done. |
| StopFailure | `turn.failed` for API-error termination; failed and error doing. |
| SessionEnd | Execution ended; preserve explicit failed/done, otherwise stopped; retain session and transcript. |
| SubagentStart, SubagentStop, TeammateIdle | Parent progress; never mark the root complete because a child stopped. |
| TaskCreated, TaskCompleted | Declared task milestones; no total unless a complete known task set exists. |
| PreCompact, PostCompact | Compaction activity; no success verdict. |
| InstructionsLoaded | Explicit context-load evidence may add paths to knows. |
| CwdChanged | Update project from declared cwd, preserving launch project separately. |
| Setup, ConfigChange, DirectoryAdded, FileChanged | Metadata/health; added directories and file changes are not proof of reads. |
| WorktreeCreate, WorktreeRemove | Do not register observation handlers that replace native worktree behavior; no required fleet mapping. |
| PreModelSwitch, PostModelSwitch | Optional metadata; no fleet state change required. |
| MessageDisplay | Optional display activity only; no guarantee of durable complete transcript or token percentage. |

### Claude stdin payload and behavior-control reference

**VERIFIED: [common input](https://code.claude.com/docs/en/hooks#common-input-fields),
[decision control](https://code.claude.com/docs/en/hooks#decision-control), and each
linked event section below; installed enum and settings validator in section 2.**
All nine specifically requested names exist; none is refuted. The following table
also covers the other 24 verified names so the larger event list has explicit
payload and control evidence. Field lists summarize useful input, not a closed
JSON schema: tolerate extra fields and event/version-dependent optional values.

Every command receives a JSON object on **stdin** with common fields
`session_id`, `transcript_path`, `cwd`, `hook_event_name`. `prompt_id` is absent
before the first user input; `scratchpad_dir`, `permission_mode`, `effort`,
`agent_id` and `agent_type` are conditional. Transcript writes can lag the event;
use Stop's `last_assistant_message` for the final text. Permission mode is not
muxterm's interactive/autonomous `mode`. No native pane/workspace ID is promised.

Each row inherits the identity, harness, optional attachment and timestamp rules
in the 18-field table below; its event-specific fleet effects are in the preceding
map. Fields absent from those two maps remain unknown, never inferred from prose.
Control capability belongs to Claude's hook protocol, **not** to muxterm's passive
reporting bridge. Successful observer commands emit no JSON/context on stdout and
exit 0; keep delivery receipts private so Claude never interprets them as feedback.
On delivery failure, persist diagnostics and print stderr, but never propagate
exit 2 or a control response from the sink into Claude. SessionEnd defaults to a
1.5-second timeout (**VERIFIED: SessionEnd reference below**); enqueue locally within
that budget, with acceptance processed later. Do not wait for daemon/UI acceptance.

| Event (VERIFIED source) | When it fires; event-specific stdin fields | Can its response control Claude? |
|---|---|---|
| [PreToolUse](https://code.claude.com/docs/en/hooks#pretooluse) | Before execution after arguments exist; `tool_name`, `tool_input`, `tool_use_id`. | Yes: `hookSpecificOutput.permissionDecision` allow/deny/ask/defer, reason, `updatedInput`, context; deny prevents execution. |
| [PostToolUse](https://code.claude.com/docs/en/hooks#posttooluse) | Successful tool completion; same tool identifiers, `tool_response`, `duration_ms`. | Yes: block/reason is feedback, context and `updatedToolOutput` alter what Claude sees; cannot undo executed effects. |
| [Notification](https://code.claude.com/docs/en/hooks#notification) | Native notification; `message`, optional `title`, `notification_type`. | No notification blocking/modification; side effects only. |
| [UserPromptSubmit](https://code.claude.com/docs/en/hooks#userpromptsubmit) | Before processing submitted input; `prompt`. | Yes: block prompt or add context; cannot replace prompt. |
| [Stop](https://code.claude.com/docs/en/hooks#stop) | Main agent finishes responding, excluding user interruption/API error; `stop_hook_active`, `last_assistant_message`, available `background_tasks`, `session_crons`. | Yes: block/reason or additional context continues the conversation; guard against loops. |
| [SubagentStop](https://code.claude.com/docs/en/hooks#subagentstop) | Child/internal agent finishes; Stop fields plus `agent_id`, `agent_type`, `agent_transcript_path`; task/cron arrays refer to parent. | Yes: Stop-style continuation of child, not parent completion. |
| [PreCompact](https://code.claude.com/docs/en/hooks#precompact) | Before manual/automatic compaction; `trigger`, nullable `custom_instructions`. | Yes in this documented version: exit 2 or decision block cancels compaction; context-limit recovery can consequently fail. |
| [SessionStart](https://code.claude.com/docs/en/hooks#sessionstart) | Start/resume and documented clear/compact/fork sources; `source`, optional `session_title`, `model`, `agent_type` and resume/cache metrics. | Context injection, `initialUserMessage` in print mode, `sessionTitle`, `watchPaths`, `reloadSkills`; no blocking decision. |
| [SessionEnd](https://code.claude.com/docs/en/hooks#sessionend) | Session ends; `reason`. | No blocking; cleanup/observation. Not guaranteed after an abrupt process kill. |
| [PostToolUseFailure](https://code.claude.com/docs/en/hooks#posttoolusefailure) | Executed tool fails; tool identifiers, `error`, `is_interrupt`, `duration_ms`. | Feedback/context; cannot reverse failure. Pre-execution validation rejection is outside this event. |
| [PostToolBatch](https://code.claude.com/docs/en/hooks#posttoolbatch) | Entire tool batch resolves; `tool_calls` array of per-call identifiers/input/result or error. | Block/reason feedback and context before next model request. |
| [UserPromptExpansion](https://code.claude.com/docs/en/hooks#userpromptexpansion) | Typed command expands; `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt`. | Block expansion or add context. |
| [StopFailure](https://code.claude.com/docs/en/hooks#stopfailure) | API error ends turn instead of Stop; `error`, optional `error_details`, `last_assistant_message`. | No decision; output/exit ignored except terminal notification sequence. |
| [SubagentStart](https://code.claude.com/docs/en/hooks#subagentstart) | Spawn/resume child or in-process teammate message; `agent_id`, `agent_type`. | Inject child context; cannot block creation. |
| [PostCompact](https://code.claude.com/docs/en/hooks#postcompact) | After compaction; `trigger`, `compact_summary`. | No decision control. |
| [PreModelSwitch](https://code.claude.com/docs/en/hooks#premodelswitch) | Before requested switch; `from_model`, `to_model`, `requested_model`, `source`, context/cache/pricing metrics when available. | Allow/deny/ask or block; cancel/confirm switch. |
| [PostModelSwitch](https://code.claude.com/docs/en/hooks#postmodelswitch) | After requested/automatic switch; same model-transition payload family. | Context only; cannot block completed switch. |
| [PermissionRequest](https://code.claude.com/docs/en/hooks#permissionrequest) | Before permission prompt, including certain modes unable to display one; `tool_name`, `tool_input`, `permission_suggestions`. | Allow/deny through decision.behavior; allowed input/permission updates. |
| [PermissionDenied](https://code.claude.com/docs/en/hooks#permissiondenied) | Auto-mode denial only; `tool_name`, `tool_input`, `tool_use_id`, `reason`, optional `mcp_server`. | Retry hint, ignored for no-verdict denials; not all permission denials emit this event. |
| [Setup](https://code.claude.com/docs/en/hooks#setup) | Explicit init/maintenance flows, not ordinary startup; `trigger`. | No decision control. |
| [TeammateIdle](https://code.claude.com/docs/en/hooks#teammateidle) | Before teammate rests; `teammate_name`, `team_name`. | Exit 2 keeps working; continue false can stop teammate. |
| [TaskCreated](https://code.claude.com/docs/en/hooks#taskcreated) | Task created; `task_id`, `task_subject`, optional description/team/teammate metadata. | Exit 2 or block cancels task. |
| [TaskCompleted](https://code.claude.com/docs/en/hooks#taskcompleted) | Before task completion; task/team/teammate metadata. | Exit 2 rejects completion; continue false has trigger-dependent behavior. |
| [Elicitation](https://code.claude.com/docs/en/hooks#elicitation) | MCP server asks for input; `mcp_server_name`, `message`, optional `mode`, `url`, `elicitation_id`, `requested_schema`. | Accept/decline/cancel and form content. |
| [ElicitationResult](https://code.claude.com/docs/en/hooks#elicitationresult) | Before elicitation response returns to server; server, `action`, optional mode/ID/content. | Override response action/content. |
| [ConfigChange](https://code.claude.com/docs/en/hooks#configchange) | Watched settings/policy/skill file changes; `source`, `file_path`. | Can block applicable changes; managed policy cannot be blocked. |
| [WorktreeCreate](https://code.claude.com/docs/en/hooks#worktreecreate) | Isolated worktree creation; `name`. | Replaces native creation; must return worktree path. Do not install an observer here. |
| [WorktreeRemove](https://code.claude.com/docs/en/hooks#worktreeremove) | Worktree cleanup; `worktree_path`. | Performs cleanup; nonzero fails removal if directory remains; JSON discarded. Do not install here. |
| [InstructionsLoaded](https://code.claude.com/docs/en/hooks#instructionsloaded) | Instruction file loaded; `file_path`, `memory_type`, `load_reason`, conditional load metadata. | No decision, asynchronous observation. |
| [CwdChanged](https://code.claude.com/docs/en/hooks#cwdchanged) | Main conversation shell changes cwd; `old_cwd`, `new_cwd`. | No JSON decision; environment-file side effects supported. |
| [FileChanged](https://code.claude.com/docs/en/hooks#filechanged) | Registered watched file changes; `file_path`, `event`. | No decision control. |
| [DirectoryAdded](https://code.claude.com/docs/en/hooks#directoryadded) | Mid-session working-directory addition via supported command/client; `directory`, `source`. | No decision control. |
| [MessageDisplay](https://code.claude.com/docs/en/hooks#messagedisplay) | Completed line batches stream to screen; `turn_id`, `message_id`, `index`, `final`, `delta`. | `displayContent` replaces display only, not model context/transcript. |

Stop observers must never return a continuation/block response. Another user hook
can continue a turn after Stop; subsequent start/tool events resume working.
A hook receipt is an observation, not exclusive control over the harness.
Permission behavior varies by execution mode: observe actual requests, never infer
that a headless CLI supports a muxterm approval broker merely because the enum
contains PermissionRequest. Chat permission intervention is **ASSUMED A2**.

Every rich event in the Codex table is **VERIFIED: decoded installed 0.155.1 input
schemas and official hooks reference read in section 2**. Legacy notify evidence
is `CodexNotify`/`CodexRowFor` plus the owner-supplied run.

| Codex native events | Normalized event and fleet effect |
|---|---|
| agent-turn-complete (notify) | `turn.completed`; stopped, clear waiting, first input name, cwd project, final doing, native thread/turn identity. No start/wait/error coverage. |
| SessionStart, SessionEnd | Session identity/project and execution boundaries; retain session after end. |
| UserPromptSubmit | `turn.started`; working, name on first prompt, clear waiting. |
| PreToolUse, PostToolUse | Tool activity/doing; matching completion resolves that tool's wait. Recognized successful update_plan can update todo; explicit successful read-tool payloads can update knows. |
| PermissionRequest | `attention.required`; blocked/permission prompt; next correlated tool result or terminal turn event clears it. No separate generic approval-resolved hook is claimed. |
| Stop, Interrupt | Completed or interrupted turn; stopped, clear waiting, final doing when supplied. Neither means goal achieved. |
| PreCompact, PostCompact | Compaction progress only. |
| SubagentStart, SubagentStop | Parent activity using agent_id; not independent root completion. |

Rich Codex hooks cover local function tools including shell and plan tools; hosted
tools are not universal hook sources (**VERIFIED: official hook tool-coverage table**).
There is no verified generic Codex failure/notification hook in the twelve-event
set. Notify-only sessions show “completion-only reporting”; rich sessions show
prompt/tool/wait observations, not exhaustive reads or a guaranteed live token feed.
Prefer rich hooks per configured execution; do not double-count Stop and notify
for the same turn. Keep notify as a compatibility translator, never as a poller.

Every Amplifier event below is **VERIFIED: `_register_state_publisher` and the
named `SessionStateTracker` handlers in section 2**.

| Amplifier native events | Common contract and fleet effect |
|---|---|
| session:start, session:fork | Identity/project and explicit parent relationship; new fork gets new session. |
| prompt:submit | Working, prompt name, clear waiting; optional derived label tagged as interpretation. |
| tool:pre, tool:post | Tool doing; root todo input supplies declared counts/current; child activity cannot replace root todo. |
| tool:error, provider:error | Error activity; preserve recoverability, no automatic failed verdict. |
| artifact:read | `context.read`; knows paths. |
| approval:required, approval:granted, approval:denied | Blocked/permission prompt and correlated resolution; denial is not by itself session failure. |
| orchestrator:goal_progress | Declared autonomous mode, done_means, goal progress/state as explicitly reported. |
| orchestrator:complete | Intermediate goal continuation remains working; ordinary/final boundary can stop. |
| prompt:complete | Root turn completion; stopped unless explicit goal outcome overrides; optional closing-answer classification remains separately identified. |
| session:end | Retained final execution state and transcript boundary. |
| user:notification | Registered handler can map explicit waits; no existing emitter is promised. |

### All 18 fleet fields, including absent data

“Absent” means unknown/unavailable, not an empty measurement. Every accepted
semantic event updates `updated_at`; metadata-only diagnostics update reporting
health separately. The following rules apply equally to spawned and external work.

| Field | Claude hooks | Codex hooks (notify limitation explicit) | Amplifier hooks |
|---|---|---|---|
| session_id | Registry alias of native session_id | Registry alias of session_id/thread-id | Registry alias of root session_id |
| pane_id | Optional registry attachment, null outside muxterm | Same | Same |
| workspace_id | Optional attachment layout, null outside muxterm | Same | Same |
| harness | claude | codex | amplifier |
| project | Declared cwd/CwdChanged | Hook cwd; notify cwd | Declared project/cwd |
| name | Explicit title or first prompt | First prompt; notify input-messages[0] | First prompt or user title |
| label | User label or separately identified derivation; no native guarantee | Same; notify does not supply label | Existing optional first-prompt classifier or user label |
| mode | interactive unless an explicit supervising goal declaration exists | Same; notify defaults interactive | Goal loop declaration or interactive |
| state | Prompt/tool working, actual wait blocked, Stop stopped, StopFailure failed | Rich start/tool/wait/stop; notify only stopped | Existing prompt/tool/approval/goal/end semantics |
| waiting_for | Actual permission/input request only; absent otherwise | Rich permission request; unavailable from notify | Explicit approval/notification declaration |
| doing | Bounded tool/prompt/final observation | Rich activity; notify final message only | Existing tool/child/goal/final summaries |
| done_means | Absent without explicit goal declaration | Absent without explicit goal declaration; never inferred from notify | Explicit goal condition |
| goal_id | Registry launch-condition digest; absent for unknown external provenance | Same | Same; not inferred from goal prose |
| origin | Registry launch record; unknown for external launch, not guessed cli | Same | Same |
| knows | Confirmed Read/instruction-load paths; no shell-read inference | Explicit recognized read results only; absent with notify | artifact:read paths |
| todo | Complete recognized task list only; task events alone insufficient | Recognized complete update_plan only; absent with notify | Root todo counts/current |
| pr | Explicit verified linkage/user metadata; absent by default | Same; no automatic notify extraction | Same |
| updated_at | Daemon acceptance time in Unix seconds of semantic update | Same | Same |

Preserve `machine` as installation metadata. User edits to name/label take
precedence over defaults. `done` requires an explicit successful goal verdict;
stopped is ordinary interactive rest. Never synthesize task percentages, known
files, PR linkage, or success from quiet output, terminal titles, or process exit.
Missing lifecycle delivery makes observation uncertain; it does not prove failure.

## 6. Launch-time configuration, visible reporting health, and poller removal

Muxterm does not require a user-scope Claude plugin, edits to
`~/.claude/settings.json`, edits to `~/.codex/config.toml`, or a globally selected
Amplifier module. The three interactive launcher commands and Operator use one
launcher manifest containing executable path, contract version, event coverage,
ingress destination, and expected first event. They configure hooks only for the
child invocation and record the first delivery/acceptance result.

| Harness | Interactive muxterm launch and Operator lane |
|---|---|
| Claude | `muxterm claude` and Operator load the bundled muxterm plugin through documented `--plugin-dir`, route it to the selected muxterm instance, suppress duplicate owned registration, and verify the first receipt. No user-scope plugin installation is required. |
| Codex | `muxterm codex` and Operator inject rich hook definitions through supported invocation config layers with vetted trust. If only legacy notify is usable, inject the completion translator and label coverage `completion-only`. Do not overwrite persistent user notify configuration. |
| Amplifier | `muxterm amplifier` and Operator select a muxterm-owned bundle/configuration that mounts `hooks-muxterm-session`, points it at the selected instance, and verifies module registration and first receipt. Installing or selecting the module globally is unnecessary. |

The wrappers preserve ordinary harness arguments, cwd, credentials, terminal
behavior and resume IDs. They expose the underlying command for diagnosis. The
wrapper is the supported manual entry point: a person typing `muxterm claude` in
a muxterm pane gets reporting without pre-installation; a person typing raw
`claude` does not receive a fleet guarantee merely because the terminal belongs
to muxterm. Pane membership never substitutes for hook delivery.

### Claude distribution decision: ship a muxterm plugin

**VERIFIED: [plugin hooks](https://code.claude.com/docs/en/plugins-reference#hooks),
[plugin manifest](https://code.claude.com/docs/en/plugins-reference#plugin-manifest-schema),
`claude --help`, `claude plugin --help`, `claude plugin install --help`.** A plugin
ships `.claude-plugin/plugin.json`, `hooks/hooks.json` (or a manifest `hooks` path/
inline object) and a bundled command script. Use `${CLAUDE_PLUGIN_ROOT}` for the
script path; never assume the current directory is the plugin directory. Plugins
use the same event-to-matcher-to-handler structure as settings. The installed
validator also confirms this shared shape.

| Approach | Benefit | Cost / detection |
|---|---|---|
| Invocation plugin through `--plugin-dir` (**required path**) | Versioned event definitions and script ship with muxterm; works for wrapper and Operator launches without persistent harness configuration. | Every muxterm launch must inject it, resolve conflicts and verify a native receipt. Policy or safe mode can still block loading. |
| Optional user-scope plugin or settings entries | Raw vendor commands can opt into the same ingress. | Outside guaranteed coverage; persistent config ownership, upgrades and duplicate suppression add complexity. This is not required for the session design or initial PR sequence. |

Package the plugin with muxterm and pass `--plugin-dir <bundle>` from both
`muxterm claude` and Operator launches. This supplies versioned hook definitions
without a marketplace, user-scope plugin installation, or hand-edited global hook
arrays. If a user independently installed the same muxterm plugin, suppress the
duplicate for the wrapper invocation or fail with a visible configuration conflict;
do not emit every event twice. Version the bridge contract and record plugin
identity/version.

Minimum reporting registration: SessionStart, UserPromptSubmit, PreToolUse,
PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, StopFailure,
SessionEnd, SubagentStart, SubagentStop, PreCompact, PostCompact. Optional metadata
handlers follow the event map. No WorktreeCreate/WorktreeRemove handlers: these
replace native behavior. Never return approval decisions, block Stop/compaction,
rewrite tool output, or inject context from the observation plugin.

**ASSUMED A1:** invocation plugin loading, effective configuration composition,
duplicate suppression and destination routing operate across actual wrapper and
Operator launches. Confirm with real event receipts in isolated integration
verification, including safe mode, policy denial, missing executable, conflicting
user plugin and failed queue delivery. Display **reporting injection failed**,
**configured—unverified**, **reporting**, or **delivery failed/rejected** on the
reserved session row. A muxterm-owned launch without its first receipt gets a
visible launch diagnostic; no pane attachment is required. Muxterm makes no
completeness claim for raw vendor invocations.

**VERIFIED configuration capabilities:** Claude settings/help and Codex hooks/help
cited in section 2; Amplifier module `mount` reads `publish_state` and registers
handlers. Invocation configuration composition/trust across real launch modes is
**ASSUMED A1**. The required launch path writes no persistent user configuration.
It reports policy blocks and conflicting hook/notify dispatch explicitly. It never
bypasses hook trust or alters harness permissions to make reporting pass. Optional
future global installation is outside the required product contract.

The command destination is the selected installation's private inbox; wrapper and
Operator dev launches receive an explicit dev instance destination. An ambiguous destination fails visibly;
no fallback from a dev hook to production. Schema validation and a local ingress
self-check verify wiring only. Native event receipt proves execution; a synthetic
check is never labeled proof that the harness invoked a hook.

Show reporting health on every reserved wrapper/Operator session row:
`injecting`, `policy blocked`, `configured—unverified`, `reporting`,
`completion-only`, `delivery failed`, `rejected`, or `unknown`. Include launch
config source, supported events, last native receipt/accepted report, queued count,
error and remediation. A launcher reports missing initial receipt within a bounded
startup window as unverified, not success. Notify-only Codex cannot prove readiness
before its first completed turn; label that limit. With zero muxterm-owned launches,
there is no misleading machine-wide harness-health claim to display.

Validate instrumentation before each wrapper or Operator launch, then verify the
first native receipt. Detect disabled hooks/safe mode when visible, unreadable
invocation config, missing executable, trust problems and module deactivation.
Do not show a machine-wide “all sessions tracked” claim: health is scoped to each
muxterm-owned launch. The launcher can diagnose its own child; a raw vendor launch
is outside that coverage boundary and does not create a silent degraded muxterm row.

Report command failures on stderr plus durable diagnostics; fleet consumes
rejected receipts and stalled queues. Do not require heartbeats or declare a long
quiet interactive session failed. Separate last state from freshness and declared
coverage. Capture module mounting/registration failures visibly; Amplifier's
current log-and-continue path is not an adequate success signal.

**Poller migration is removal, not coexistence:**

1. Land common session identity/ingress and reporting diagnostics first.
2. Ship `muxterm claude` and Operator invocation hook setup with the native-event verification gate.
3. In that same Claude migration PR, remove `claudeAdapterLoop`, `poll`,
   `queryAgents`, the five-second ticker, subscription gating, and adapter startup
   wiring in `internal/sessiond/claude_adapter.go`. No background discovery poller
   remains for raw vendor sessions. Reuse native Claude IDs to adopt old rows;
   freeze/import existing snapshots once, then retire the poller's producer path.
4. Convert Amplifier and Codex translators to the same report contract. Preserve
   rich semantics while eliminating independent snapshot writers for those harnesses.

**VERIFIED lost capability: read `claudeAdapterLoop`, `poll`, `queryAgents`,
`claudeRowFor`.** Polling can discover supported Claude records without muxterm
hooks and repeatedly reconcile their state (subject to PID/pane placement and
subscriber gating). Removing it loses discovery of raw `claude` invocations and
recovery from hook omissions. Existing raw sessions remain outside guaranteed
coverage; relaunch through `muxterm claude` to create a reported execution. No
historical event backfill is promised. State this wrapper boundary in CLI help and
fleet empty-state copy. Do not compensate with transcript watching, periodic agents
queries, or PTY scraping. Rollback may disable a new bridge with visible degraded
health; it must not silently restore polling as a second authority.

## 7. Chat storage is part of admission, not a UI cache

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


## 8. Sessions, chat, terminals and the Operator

Sessions remain the product's primary object; terminals remain a first-class
capability, including ordinary shells with no agent. The existing Operator
conversation, SessionStore, exact storage scope, root lock, FIFO and approval
infrastructure stay authoritative. No conversation router or multi-tenant service.
No Azure sandbox feature, hosted design or mobile-specific scope.

Structured child-process streams may render chat and persist transcript content,
but **all harness fleet state enters through hook-report**. A chat stream cannot
quietly become a fourth reporting mechanism. Hooks trigger bounded native transcript
imports for externally started sessions; those imports supply history, not inferred
fleet state. Missing/unreadable/unsupported native transcripts produce an explicit
history-unavailable indicator. Future import-format compatibility is **ASSUMED A3**.
Do not promise a full transcript from notify's final message alone.

**VERIFIED: installed `codex --help` and `claude --help` expose explicit native-ID
resume.** Chat executor selection is deferred until hook coverage and persistence
are verified; no SDK claim is necessary for the unified reporting design. A managed
launch can reserve a visible session before its first report, with runtime state
unknown until a hook arrives. Launch/process-exit errors are supervisor health
facts, not fabricated harness goal verdicts.

Human takeover reserves exclusive control, interrupts only a proven owned child,
drains/persists output, then resumes the same native session in a real PTY. Never
attach to or signal a shared vendor daemon or an unowned external process.
External sessions are observable first; takeover requires explicit ownership
transfer and proof the former writer stopped. If proof fails, retain readable
history and block takeover. Return to chat requires release by the human and
native-history reconciliation. Cross-surface continuity is **ASSUMED A3**.

Extend existing spawn/send/transcript/fleet seams to resolve session ID first.
Persist notices with `(session_id, execution, turn, kind)` dedupe so successive
turns each report once. Coalesce activity for the fleet; deliver attention and
completion promptly through the existing Operator queue. No LLM turn per tool
call, fabricated progress, or browser-only history. Credentials stay in the
harness's normal same-user environment; service access is **ASSUMED A4**.

## 9. Ordered implementation PR plan

This revision is PR 0 (#176), documentation only. **PR 1 comes first and is the
smallest PR delivering real user-visible value:** `muxterm codex` injects the
completion hook and its session appears as a durable row even when that wrapper is
run outside a muxterm pane. It includes reporting health and honest completion-only
coverage. A health badge alone does not repair the owner's reproduced failure.

| Order | Scope | Real integration release gate |
|---|---|---|
| **1 — `muxterm codex` admits sessions without panes** | Add the interactive wrapper with invocation-scoped notify, minimal durable registry/aliases, common hook-report inbox/consumer, Codex notify translator, optional attachment wire/UI/MCP changes, health receipts and detail view. No chat executor or global config edit. | Run a real `muxterm codex` once in a muxterm pane and once outside any pane; each completes twice and keeps one stable row, with null pane/workspace for the latter. Close browser before completion, refresh and retain rows; native resume maps to the same ID. Reject invalid reports visibly. |
| **2 — Claude hooks replace polling** | Add `muxterm claude`; share its bundled invocation plugin and diagnostics with Operator launches; add the Claude translator and core prompt/tool/permission/Stop/SessionEnd coverage; delete poller and startup wiring in this PR; one-time legacy adoption. | Real wrapper and Operator Claude sessions, tool success/failure, wait/resolution, completion/API error where reproducible; raw `claude` is documented as outside coverage; no global settings edit and no repeated agents subprocesses. Verify A1 for Claude. |
| **3 — Preserve Amplifier richness through common ingress** | Add/extend `muxterm amplifier`; make Operator use the same invocation bundle; change the Python hook module reporting sink while preserving root/child, goal, todo, read and classification semantics. No upstream engine rewrite. | Real wrapper and Operator root/delegated work, todo, artifact read, approval resolution, goal continuation/final result; outside-pane Operator report and duplicate delivery; no global bundle requirement and zero parallel state writers. Verify A1 for Amplifier. |
| **4 — Codex richer hook coverage** | Add/extend `muxterm codex`; make Operator use the same invocation-scoped rich hooks; retain completion-only compatibility, native turn dedupe, visible coverage. | Real wrapper and Operator prompt, command, update_plan, approval, Stop/Interrupt and exit; hosted-tool gap visible; old notify and rich Stop do not duplicate completion; no persistent config overwrite and missing trust is visible. Verify A1 for Codex. |
| **5 — Durable transcript/session detail** | Shared transcript journal, bounded native imports, replay cursor, storage errors, archive/detach semantics. | Browser refresh/reconnect and isolated restart retain readable history; missing native file and disk-full expose errors; no native-state polling. Resolve import portion of A3. |
| **6 — Hook-reporting chat and takeover** | Select verified managed transports, durable admission, approval/control ownership, native-ID resume; streams only for transcript rendering. | Two turns per harness, approval allow/deny/expiry, interrupted tool, terminal takeover/return, stale-send rejection and uncertain dispatch recovery. Resolve A2–A4 before enabling their controls. |
| **7 — Operator session-first entry and cleanup** | Session-based spawn/send/read, causal notices, navigation, retire compatibility writers after adoption. | Mixed harness fleet from wrapper and Operator launches, no browser during work, two completion notices for two turns, retained Operator history and usable ordinary terminals. |

Every implementation PR uses actual harness processes and browser/sessiond
verification in fresh `make dev-local` fixtures (8313); service/config installation
scenarios belong in a DTU. Never mutate production 9090/8311 or the owner's global
config during verification. No unit tests. Store all logs, captures and generated
schemas under `/home/ken/artifacts/`, never commit them. This documentation revision
uses source/doc/schema inspection and required static checks, not a claim of new
browser behavior. Downgrades refuse newer writable stores; rollback retains
journals and aliases and visibly disables unavailable features.

## 10. Consolidated ASSUMED list

These are all remaining runtime capability assumptions. Verified event declarations
are not evidence of completed integration; the design never substitutes an
unverified SDK or symmetric event set for native evidence.

| ID | ASSUMED: reason | What confirms it / release boundary |
|---|---|---|
| A1 | Native hook delivery, invocation-scoped Claude plugin activation/observer neutrality, configuration composition/trust, native identity and correlation work through the future common bridge for each wrapper/Operator launch; no new bridge was executed in this research. | PRs 2–4 real wrapper/Operator event captures, policy/conflict cases, retries and accepted fleet receipts. Expose unverified launch health until each passes; no global-install requirement and no Claude poller fallback. |
| A2 | A selected chat execution mode exposes a usable permission/control round trip through its actual hooks; enum presence does not prove a broker can hold and answer the request. | PR 6 real allow/deny/expiry and reconnect per harness/mode. Keep that control disabled or require terminal intervention until verified; no guessed stdin protocol. |
| A3 | Native transcript import and interrupted chat/terminal resume preserve completed context and release the former writer. Native history is not a stable cross-version guarantee. | PRs 5–6 two-turn import, interruption, explicit resume, missing-history and recovery verification. Preserve readable muxterm history; block takeover when ownership is uncertain. |
| A4 | Same-user managed children can access the owner's normal CLI credentials and helpers under the service environment. Help output cannot establish authentication. | PR 6 real authenticated turn per harness with service-equivalent environment. Surface auth failure; never silently change account or billing route. |

A1 is **updated** to include invocation-scoped Claude plugin activation and observer
neutrality; A2–A4 are **retained** with their explicit confirmation gates. No
assumption was silently retired. The claim that Claude lacks hooks is **refuted**,
not retained as an assumption. No amplifier-agent replacement or SDK compatibility
assumption is retained.
