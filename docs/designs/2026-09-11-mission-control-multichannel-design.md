# Mission Control: multi-channel conversation design

**Status:** design proposal; documentation only
**Baseline:** `origin/main` / `aa6b581bd8d8ba5537d794c33beed00e5755d2b8` (2026-09-11)

## Summary

Mission Control is one UI and one voice bridge client over several explicitly
addressable conversation threads:

- **Lobby** — fleet-wide status and short summaries only. It is not a second
  full transcript. Follow-ups that need detail must retrieve a scoped summary
  with an explicit workspace/thread target, or ask the user to switch to the
  relevant workspace thread.
- **One workspace thread per workspace** — the durable conversation history for
  that workspace. A thread is keyed by a stable workspace identity, not by the
  currently focused pane. The UI and bridge may attach to another thread, but
  never silently do so.

The user sees one Mission Control surface and uses one bridge client. The bridge
can attach to different threads; separate Mission Control instances per
workspace are explicitly out of scope.

This design does not implement routing, migrate transcripts, or change runtime
behavior. It records a staged implementation plan for a later, separately
approved implementation PR.

## Why this follows the current system

The current server owns one shared conversation per muxterm install:
`internal/server/cos.go:5-30` describes the server-owned session and broadcasts
turns to every subscribed browser connection. `internal/cos/supervisor.go:42-90`
uses the fixed `muxterm-cos` session ID and pins the sidecar working directory,
so the project slug selects one transcript. `Supervisor.Submit` queues turns
through the single-consumer queue (`internal/cos/supervisor.go:468-469`,
`internal/cos/queue.go:98-111`).

Voice is deliberately not a second brain today: `internal/server/voice.go:43-51`
bridges realtime speech to the same relay, queue, transcript, and approvals as
text; `internal/voice/bridge.go:5-19` keeps that interface narrow. The new model
therefore needs a thread-aware routing layer above the existing single-session
supervisor, while preserving one bridge and one Mission Control UI.

The existing Mission Control shell already has one conversation column and a
fleet applet host (`web/src/components/mux-cos.ts:1-38,1691-1718`). Its current
history replay is per connection but sourced from the one shared conversation
(`internal/server/cos.go:461-507`). The applet design also establishes that the
surface is surface-scoped by default and that cross-applet navigation is a user
gesture, not a data-change side effect (`docs/design/mission-control.md`, D1 and
D3.4). Multi-channel routing extends that explicitness to conversation scope.

## Thread model and invariants

A thread record should contain, at minimum:

```text
thread_id       stable opaque ID (lobby or workspace identity)
kind            lobby | workspace
workspace_id    required for workspace threads; absent for lobby
label           display-only workspace label
summary         bounded lobby summary, never the full workspace transcript
active          lifecycle state; inactive threads remain addressable
updated_at      ordering/replay cursor
```

Normative invariants:

1. Every outbound turn has an explicit `thread_id` and a source of truth for
   the selected focus. Missing or stale targets fail visibly; they do not fall
   back to lobby or to the last-used workspace.
2. A workspace thread may read its own history and the explicitly requested
   fleet summary. It must not silently merge another workspace's transcript.
3. Lobby output is summary-only. A request for detail either retrieves a bounded,
   workspace-scoped summary by explicit target or requires an explicit switch.
4. Focus switching is a user-visible state transition. The UI shows
   `Focused: Lobby` or `Focused: <workspace label>` prominently; the bridge
   states the destination and answer context in spoken/visible acknowledgements.
5. One bridge client and one Mission Control surface may have only one active
   focus at a time. Background events may notify, but cannot steal focus or
   act on another workspace without an explicit target and confirmation.
6. Workspace identity must remain stable across rename and pane focus changes.
   A pane is context for a workspace, not a conversation-thread identity.
7. Clear, replay, approval, cancellation, and audit records are thread-scoped.
   A clear in one workspace thread never clears lobby or another workspace.

### Routing and context announcement

The routing decision is made before submission, persisted with the turn, and
returned in the acknowledgement. The minimum user-facing acknowledgement is:

> Focused on **workspace X**. I will answer in the **workspace X thread**.

For lobby:

> Focused on **Lobby**. I will give a fleet summary; detailed follow-ups belong
to a selected workspace thread.

The voice bridge speaks the same routing and context statement before (or with)
the answer. It must not rely on the model remembering to announce a switch.
The transcript records `thread_id`, focus reason (`user-switch`, `explicit-target`,
or `notification`), and whether the user confirmed a cross-thread action.

## Attention while another lane needs attention

**Recommendation, not a settled user decision:** queue by default. If another
thread has an approval, blocked lane, or completed result while the user is
focused elsewhere, place it in an attention queue with workspace/thread label,
age, and a short summary. Do not auto-switch.

**Recommendation, opt-in:** offer an interrupt action that may take effect only
at a safe audio boundary (between spoken phrases/turns, never by cutting a word
or an approval prompt). The user explicitly opts into this mode. A queued item
remains available if interruption is declined.

There is no automatic focus stealing. No notification, model inference, or
voice event may send input, approve a tool, switch a thread, or mutate another
workspace without an explicit target and, where the action is consequential,
confirmation. This preserves the current approval semantics documented by the
sidecar protocol (`docs/designs/2026-09-06-cos-sidecar-spec.md`, §2.4).

## Lobby semantics and follow-ups

The lobby is intentionally summary-only as the provisional choice. It gives a
fleet-wide orientation without mixing raw histories or making a short summary
look like authoritative workspace context. The tradeoff is an extra step for
follow-ups: the user must select a workspace thread or explicitly request a
scoped detail retrieval.

A lobby answer that names a workspace should carry a target affordance, for
example `Open workspace thread: api-refresh`. Selecting it is a user gesture and
changes the prominent focus indicator. A spoken follow-up should accept an
explicit workspace name/ID, repeat the resolved target, and only then submit.
Ambiguous names produce a disambiguation prompt rather than a guessed route.

## Naming and migration direction

The canonical product, assistant, and voice bridge name is **Mission Control**.
**Chief of Staff** and **COS** are deprecated role/product names for user-facing
surfaces and new interfaces. Existing internal package names and compatibility
fields may remain temporarily, but new docs, prompts, comments, UI copy, labels,
thread concepts, events, and interfaces should use Mission Control terminology.

A later implementation must inventory and propagate this rename through:

- UI labels, empty states, accessibility text, voice prompts, and notifications;
- sidecar bundle context/behavior prompts and spoken acknowledgement templates;
- Go package comments, protocol/event names, route names, and public interfaces;
- session/thread records, diagnostics, labels, and documentation links.

The rename must be compatibility-aware: old persisted session IDs and wire
messages need an explicit alias/deprecation window, not a silent transcript
fork. No migration is performed by this document.

## Staged implementation PR plan

Each stage is separately reviewable. The first implementation PR should land the
thread contract and observability before changing model behavior.

1. **Contract and inventory (docs + schema proposal).** Define thread IDs,
   workspace identity, routing reasons, focus acknowledgements, summary bounds,
   queue/interrupt states, and compatibility aliases. Add a source inventory for
   every COS/Chief-of-Staff user-facing occurrence. No runtime change.
2. **Thread storage and replay.** Add a durable thread index and per-thread
   transcript/replay boundaries, retaining the existing single-thread data as a
   compatibility alias. Prove restart, clear, bounded replay, and no cross-thread
   leakage with integration/browser verification. Do not add automatic routing yet.
3. **Server routing seam.** Make text submissions, approvals, cancellation, clear,
   history, and events carry a validated thread target. Return an explicit routing
   acknowledgement and reject missing/ambiguous targets. Preserve old clients by
   translating the legacy single-thread alias to the selected compatibility
   thread during the deprecation window.
4. **Mission Control focus UI.** Add the lobby/workspace thread selector and the
   prominent `Focused:` indicator. Make target switches user gestures, preserve
   scroll/replay per thread, and show the routing/context statement in the
   transcript. Do not let attention notifications switch focus.
5. **Voice bridge attachment.** Keep one bridge client, add explicit attach/switch
   commands, and speak the resolved target/context. Add safe-boundary interrupt
   handling only behind an opt-in setting; default to queue. Test denial,
   ambiguity, disconnect, and stale-target behavior.
6. **Attention queue and summaries.** Add lobby summary aggregation with bounded,
   freshness-labeled entries and workspace-scoped detail retrieval. Add queue
   actions, explicit interrupt affordance, and audit records. No autonomous
   cross-workspace action.
7. **Terminology propagation and retirement.** Update prompts, comments, UI,
   labels, interfaces, and docs to Mission Control; measure compatibility alias
   usage; remove aliases only after the announced deprecation condition is met.

Implementation PRs must use real-browser/integration verification required by
`AGENTS.md`; this design PR itself needs no runtime or migration execution.

## Risks and open questions

- **Identity:** workspace rename, deletion, remote hosts, and reused IDs need one
  canonical identity scheme before storage is implemented.
- **Concurrency:** multiple tabs and the one voice bridge can race a focus switch;
  server-side target validation and sequence numbers must win over browser state.
- **Summary fidelity:** lobby summaries can omit crucial detail; every summary
  needs timestamp/source and a direct path to the scoped thread.
- **Audio safety:** interruption must stop at a protocol-level safe boundary, not
  merely a UI timer; approvals are never auto-approved.
- **Compatibility:** the current `muxterm-cos` session and `cos-*` wire vocabulary
  are deployed concepts. Alias and migration behavior must be designed and
  observed before removal.
- **User decision still needed:** confirm the lobby summary-only policy after a
  prototype, and separately approve or reject the queue-by-default and safe-audio
  interrupt recommendations.

## Non-goals

This proposal does not create separate Mission Control instances, implement
routing, change the sidecar, migrate existing transcripts, add a second voice
model/session, auto-switch focus, interrupt audio, or authorize cross-workspace
actions. It is one design document for one later staged implementation plan.
