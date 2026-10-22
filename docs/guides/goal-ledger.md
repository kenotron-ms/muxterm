# Goals and the shared ledger

The composer has a single-line goal banner. Its icon controls open the human
editor, request pause/resume or native clear, and open the shared ledger utility.
Ordinary messages do not revise the stop condition. Standalone chats need no
operator. Full conditions are available in the editor and banner tooltip.

## Native capability boundaries

| Adapter | Goal controls | Boundary |
| --- | --- | --- |
| Codex app-server | Experimental native get/set, pause/resume, clear and notifications | Initial set may start native execution. An edit never requests active status; edits after complete/clear/uncertainty are paused for explicit resume. Native execution, evaluation, and continuation remain Codex-owned. |
| Amplifier loop-live | Coordinator goal mutation and native progress observations | Conditions and revisions are installed in the native loop. Its continuation guard prevents further automatic turns while suspended. A human-directed initial start/resume submits one input; native evaluation/continuation owns subsequent work. |
| Claude Agent SDK | Built-in `/goal` command dispatch and `active_goal` observations | Discover the native command first. A structured `local_command_run` acknowledges dispatch, not achievement or applied condition; native observations establish application. Suspend clears the native goal while retaining the muxterm condition. Reactivation is a new native goal with reset counters, not an exact native pause/resume. A null observation cannot distinguish achieved from cleared. |

These are adapter boundaries, not claims that upstream harnesses lack features.
Claude native command availability does not establish model authentication. A
command may be acknowledged while subsequent execution fails; that is not an
achieved goal. No free-text response, regex, or keyword authorizes execution or
proves completion. Native structured events, hook decisions, and receipts carry
the protocol state.
A completed turn never proves a goal achieved. Native statuses and event details
are retained verbatim, including blocked, usage/budget limits, and clear.
Native clear is not rollback or proof that the current turn was interrupted.
Clear retains human revisions; explicit resume can recreate the saved condition
as a new native goal. Completed goals likewise require explicit resume.
The composer goal banner disappears when the native goal is cleared; its
revision and control history remain in the shared ledger.

## Storage and receipts

Muxterm owns `sdk-chat/goals.sqlite` beneath its data directory.
The SQLite driver is pure Go, including the CGO-disabled Darwin release builds;
the ledger file format is unchanged.
SQLite stores one versioned JSON document per chat; relational fields are identity and a transactional
compare-and-swap version only. Documents contain human condition revisions,
ownership/operator association, requested/applied revisions, human pause holds,
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
Passive settings/title loads and queued operator reports cannot restart an
uncertain goal. Legacy native conditions without a human ledger revision require
explicit adoption in the human editor, not inferred provenance.

## Authority

Authenticated browser requests own condition edits and topology. Local bypass and
development no-auth provenance are labeled explicitly rather than recorded as a
named authenticated human. Native chat capabilities propagate through Codex,
Claude, and Amplifier, including Amplifier replacement sessions.

Agents use `get_chat_goal` (`session_id=self` is supported), `control_chat_goal`,
and `report_goal_evidence`. Mutations use the ledger's `controlVersion` as
`expected_version`. Evidence is scoped to the caller’s own goal; proposals may
also target its directly owned lanes. Both are inert records, not instructions
or notifications to peers. Only the owner or direct
operator can control execution, and neither can release a human pause.

New MCP tools require an authority audit: `scopedChatTool` currently excludes
known alternative write/topology tools and registers other tools by default.
Keep that exclusion list and the server authority boundary aligned.

## Proposals and changeable policy

Proposing and authorizing are separate typed operations. An agent proposal is an
inert receipt. In the shared ledger, a human may approve and start it, or approve
its exact condition and authorize the direct operator to start that revision.
The authorization is a JSON policy record scoped to operator identity and human
revision, consumed on one admitted start, and explicitly revocable. Relinking or
revising a condition does not transfer that authority. Operators cannot grant
themselves authority or release a human pause. Ordinary messages are not grants.
Human approval with “Approve and start” explicitly releases that human hold;
granting operator permission alone does not. Agents may resume their own pause
of an already authorized revision, but restarting a finished goal requires a
fresh human start or operator authorization.
The current policy is a revisable product choice, not a prompt-text classifier.
Harness adapters implement mechanisms; policy records decide who may invoke them.

Claude's native ProposeGoal tool is intercepted at its native PreToolUse hook and
recorded as an inert proposal instead of allowing its direct-setting option to
bypass muxterm consent. The agent chooses what to propose; a human chooses what
may execute. The native goal evaluator, not muxterm, judges its condition.

Agent sends require a server-issued sender capability and a direct
operator-to-lane or lane-to-operator edge. Peers, unrelated chats, missing or
mismatched identities, relinking, ordinary-send/page-write bypasses, native
session sends, terminal input, and app-mediated browser control are denied.
Unrelated read and administration tools retain their existing behavior. Human
browser controls remain available. Agent creation/relinking of chats is not
supported by this increment; humans establish the topology.

This is an application authority boundary, **not OS isolation**. A harness with
an unrestricted shell under the same OS user can read capability files, forge
HTTP headers, invoke other local binaries, or automate a browser outside muxterm.
No same-user filesystem or shell sandbox is claimed.
