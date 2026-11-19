# Shared Work and native goals

A Work item is a durable promise in a project's queue. A Chat Goal is the
stop condition that lets one worker session pursue that promise. Creating Work
records the request; it does not start implementation. A goal condition is
drafted on the Work item, reviewed by a human, and installed as the selected
worker's native Chat Goal when the item becomes ready and the project scheduler
has room.

## Start in a chat

Tell a chat what outcome you want. For example:

> Add project search. Capture this as a Work item, draft a clear stopping
> condition for its worker, and let me review it before anything starts.

The chat calls `create_work_item`, then `update_work_item` with
`goal_condition` and the current `expected_revision`. It can refine the brief,
acceptance criteria, dependencies, and proposed condition with you. It must
leave the item in `draft` until you approve the exact condition. The draft and
all later revisions stay in the Work history.

A goal draft appears in two places:

- The creating chat shows an inline review card with the exact condition.
- The project's Work tab shows the same card on the item's detail page.

Both cards call the same approval action. **Approve only** records your
approval and leaves the item in Draft. **Approve & start** approves that exact
condition and marks the item Ready in one action. If you approved earlier,
**Start work** marks it Ready later. Ask the chat to revise the condition if it
has the wrong outcome or stopping point. A changed draft or substantive Work
brief revokes an unstarted approval. Stale review clicks return 409 and require
a refresh. Agent tools cannot approve the condition or release a human hold.

The Work tab also has project-level play/pause and a parallelism slider.
Paused projects retain Ready items in the queue. Dependencies must be `done`
before an item is eligible. Older Ready items without an approved goal need a
goal draft and approval before the scheduler can send them to a worker.

## What happens when Work is Ready

Muxterm's coded scheduler chooses a goal-free, ready chat in the same project
that owns no other unfinished Work, or creates a new one. It never uses the
creating chat as the worker. It reserves a dispatch on the Work item, creates
a new chat without an opening turn if needed, and installs the approved
condition as that chat's native goal. Only after native acknowledgement and
observation of the exact applied revision does it send the Work ID and
execution instructions. The worker reads the record,
claims it with `update_work_item`, pursues the native goal, and records
progress, evidence, blockers, and outcome on Work. The goal ledger records the
same approved condition, its human Work approval provenance, native receipt,
and goal progress.

The supported native goal harnesses are Codex, Claude, Copilot, and Amplifier.
If the creating chat uses another harness and no suitable existing chat is
available, the scheduler creates a Codex worker. A reused chat with an
existing goal or human pause is ineligible. Work approval authorizes this one
exact condition; it does not let the scheduler overwrite another goal or
release a pause. The native goal ledger's `controlVersion` is fenced when
installing the condition.

A dispatch is `preparing`, `sent`, `claimed`, `uncertain`, or `failed`. A native
control or input whose acknowledgement is uncertain is never silently
replayed. Inspect the linked chat and Work history before calling
`reset_work_dispatch` with the current revision and a reason, then use
`start_work_item` with a new `client_ref` if a retry is appropriate.

## Check in and steer

Open the project's Work tab to see what is in motion, ready, waiting, blocked,
or finished. Filter by label, then open an item for its condition, dependency
links, assigned chat, and activity timeline. Follow the chat link to inspect
its full transcript and native Goal tab. The Work tab surfaces goal drafts,
reviews, blockers needing a human, and uncertain dispatches.

Tell the creating or worker chat what changed. It can update the Work brief,
next action, progress, or blocker and ask you to review a revised goal. A goal
condition cannot be changed after dispatch; steering the running native goal
requires its own human goal control. A human pause remains in force until a
human resumes it.

## Fields and tools

`createdBy` is immutable provenance; `ownerSessionId` is the current worker.
`reviewerSessionId` and `sessionIds` link other chats. Work also stores title,
brief, source, `acceptanceCriteria`, `nextAction`, project IDs, labels,
`dependsOn`, status, readiness, progress, blocker, outcome, dispatch, revision,
and attributed updates. `waitingOn` is derived from unfinished dependencies.
The goal fields are `goalCondition`, `goalRevision`,
`goalApprovedRevision`, and `goalApprovedAt`.

For progress reports, send `summary` as one short sentence about the change or
decision (up to 160 characters). Put diagnostics, links, and lists in `text`
as Markdown. The Work timeline shows the summary first and lets a reader open
the full formatted update. Older long reports without a summary get a short
preview; their original text remains available. When a report omits an explicit
`progress` value, its summary becomes the current one-line progress shown at
the top of the Work detail page.

`create_work_item` makes a draft. `update_work_item` proposes a condition and
records changes with `client_ref` and `expected_revision`. The browser's
`POST /api/sdk-work/{id}/goal/approve` accepts the exact condition, both Work
and goal revisions, a stable `clientRef`, and optional `ready:true`. Only a
human browser may call it. `list_work_items` and `get_next_work_item` can
filter by project and labels. `get_next_work_item` is a read, not a claim;
items without approved goals, held or paused items, full projects, and items
with unfinished dependencies are skipped. `start_work_item` requests a manual
handoff when the scheduler is playing. A direct `update_work_item` claim is
accepted only if that chat already has the exact approved native goal applied
and authorized; the ordinary path is the scheduler handoff.

Each Work mutation is idempotent by `client_ref`; revision fences prevent a
stale assignment or approval from silently replacing newer work. Sparse
`work.goal.proposed` and `work.attention` notices reach the relevant chat;
ordinary Work updates remain on the record and in topic subscriptions rather
than flooding the main transcript.
