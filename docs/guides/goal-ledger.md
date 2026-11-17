# Goals and the shared ledger

The composer has a single-line goal status and latest outcome summary. Selecting it opens the Goal utility
tab, which renders the current stop condition as markdown with controls to
refine, pause, resume or reset, and clear it. The `/goal` command sets, inspects,
pauses, resumes, and clears the goal. A human can keep the condition as-is or
ask the goalify skill for a refined draft in the Goal tab, then choose whether
to apply that draft in chat. Reset restarts the current approved condition after
the native goal has finished.
Ordinary messages do not revise the stop condition. Standalone chats need no
operator. The shared ledger stays behind the UI as the authority and history store.

## Native capability boundaries

| Adapter | Goal controls | Boundary |
| --- | --- | --- |
| Codex app-server | Experimental native get/set, pause/resume, clear and notifications | Initial set may start native execution. A human `/goal <condition>` retries a blocked goal with active status; other edits do not request active status. Edits after complete/clear/uncertainty are paused for explicit resume. Native execution, evaluation, and continuation remain Codex-owned. |
| Amplifier loop-live | Coordinator goal mutation and native progress observations | Conditions and revisions are installed in the native loop. Its continuation guard prevents further automatic turns while suspended. A human-directed initial start/resume submits one input; native evaluation/continuation owns subsequent work. |
| Claude Agent SDK | Built-in `/goal` command dispatch and `active_goal` observations | Discover the native command first. A structured `local_command_run` acknowledges dispatch, not achievement or applied condition; native observations establish application. Suspend clears the native goal while retaining the muxterm condition. Reactivation is a new native goal with reset counters, not an exact native pause/resume. A null observation cannot distinguish achieved from cleared. |

These are adapter boundaries, not claims that upstream harnesses lack features.
Claude native command availability does not establish model authentication. A
command may be acknowledged while subsequent execution fails; that is not an
achieved goal. No free-text response, regex, or keyword authorizes execution or
proves completion. Native structured events, hook decisions, and receipts carry
the protocol state.
A completed turn never proves a goal achieved. Native statuses and event details
are retained verbatim, including blocked, usage/budget limits, and clear. Goal
outcomes appear in the composer status instead of adding transcript status rows.
Native clear is not rollback or proof that the current turn was interrupted.
Clear retains human revisions; explicit resume can recreate the saved condition
as a new native goal. Completed goals likewise require explicit resume.
The composer goal status disappears when the native goal is cleared; its
revision and control history remain in the shared ledger.

## Storage and receipts

Muxterm owns `sdk-chat/goals.sqlite` beneath its data directory.
The SQLite driver is pure Go, including the CGO-disabled Darwin release builds;
the ledger file format is unchanged.
SQLite stores one versioned JSON document per chat; relational fields are identity and a transactional
compare-and-swap version only. Documents contain human condition revisions,
ownership, requested/applied revisions, human pause holds,
idempotent control receipts, native execution references and observations, and
agent evidence/proposals. Native chat metadata remains a display projection,
not an independent condition editor.
Ordinary chat lifecycle events do not create empty goal records: no-op updates
compare the document before and after the change, including when no row exists.

`controlVersion` guards competing admissions; the storage `version` also changes
with observations. Native progress therefore cannot invalidate an otherwise
current human edit. Reusing a `clientRef` with the same request does not redispatch;
reusing it for different content is rejected. Requests are committed before native
dispatch. An acknowledged receipt and an observed applied revision are distinct.
Applied means the native goal configuration was observed, not that every already
running tool has seen the new condition.

HTTP rejections distinguish invalid requests (400), forbidden controls (403),
missing proposals (404), stale control versions (409), pending native controls
(423), and unavailable ledger storage (503). Storage failures fail closed without
being reported as human authorization decisions.

On restart, pending receipts become uncertain and active state becomes uncertain.
Nothing is replayed. Human pause holds survive restart, including failed or
uncertain native acknowledgements. Reconcile before making another request.
Passive settings/title loads cannot restart an
uncertain goal. Legacy native conditions without a human ledger revision require
explicit adoption through the `/goal` command, not inferred provenance.

## Authority

Authenticated browser requests own condition edits and topology. Local bypass and
development no-auth provenance are labeled explicitly rather than recorded as a
named authenticated human. Native chat capabilities propagate through Codex,
Claude, and Amplifier, including Amplifier replacement sessions.

Agents use `get_chat_goal` (`session_id=self` is supported), `control_chat_goal`,
and `report_goal_evidence`. Mutations use the ledger's `controlVersion` as
`expected_version`. Evidence and proposals are scoped to the caller’s own
goal. Both are inert records, not instructions or notifications to peers.
The owner may request pause or resume of its own authorized revision; only a
human may start it or release a human pause.

New MCP tools require an authority audit: `scopedChatTool` currently excludes
known alternative write/topology tools and registers other tools by default.
Keep that exclusion list and the server authority boundary aligned.

## Proposals and changeable policy

Proposing and approving are separate typed operations. An agent proposal is an
inert receipt. A human may approve the exact condition and start it, or approve
it for a later human start. Ordinary messages do not grant execution authority.
Human approval with “Approve and start” releases a human pause. Agents may
resume their own pause of an already authorized revision, but restarting a
finished goal requires a human start.

Claude's native ProposeGoal tool is intercepted at its native PreToolUse hook and
recorded as an inert proposal instead of allowing its direct-setting option to
bypass muxterm consent. The agent chooses what to propose; a human chooses what
may execute. The native goal evaluator, not muxterm, judges its condition.

Agent sends require a server-issued sender capability. Explicit side and voice
handoffs to the main chat remain available. Goal controls require the owner
chat's capability or a human browser; only humans set conditions and start
approved revisions.

This is an application authority boundary, **not OS isolation**. A harness with
an unrestricted shell under the same OS user can read capability files, forge
HTTP headers, invoke other local binaries, or automate a browser outside muxterm.
No same-user filesystem or shell sandbox is claimed.
