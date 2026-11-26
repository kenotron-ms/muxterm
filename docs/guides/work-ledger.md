# Shared Work and native goals

A Work item is a durable promise in a project's queue. A Chat Goal is the
stop condition that lets one worker session pursue that promise. A filed Work
item contains its checked goal condition and a short execution plan. Filing
queues it when project controls and dependencies allow; the scheduler installs
the condition as the selected worker's native Chat Goal. A human can explicitly
ask for a draft before filing.

## Start in a chat

Tell a chat what outcome you want. For example:

> Add project search. Capture this as a Work item, draft a clear stopping
> condition for its worker, and let me review it before anything starts.

For a filed request, the chat calls `create_work_item` with the brief,
acceptance criteria, goal condition, next action, and a compact `plan` with
`plan_protocol`. Each step starts `pending` and has a stable lowercase ID.
The plan describes the major steps and when to report progress; the goal
condition remains the completion contract. The server checks the condition
before filing. If you explicitly ask to review a draft first, the chat uses
`draft=true`; draft revisions stay in Work history until you approve and file
the exact condition.

For a broader request, the chat first describes the smallest integrated outcome.
It uses `create_work_graph` when parts can deliver separately verifiable
capabilities or reusable handoffs. Each node includes its own scope, goal,
evidence, and blocked exit. The final node verifies the integrated outcome
and tracks release. A prerequisite link means the downstream node needs a
specific upstream result. Independent nodes can start as project capacity
allows.

Graph filing validates and saves all nodes together. If a goal check fails,
the chat revises the affected goal and rechecks the graph before submitting.
If delivery is uncertain, replay the same submission with the same
`client_ref` to retrieve the existing items. Work details link to the other
outcomes and show the completion state of each prerequisite.

A goal draft is reachable in two places:

- The creating chat's **View work** action opens the Work detail review sheet.
- The project's Work tab opens that same sheet from the item row.

The sheet shows the brief and acceptance criteria, an attached design preview
for UI Work, the exact goal rendered as safe Markdown with a raw view, the
current revision's goal check, and then the decision. Earlier drafts are
collapsed in history. **Approve only** records your
approval and leaves the item in Draft. **Approve & start** approves that exact
condition and marks the item Ready in one action. If you approved earlier,
**Start work** marks it Ready later. Ask the chat to revise the condition if it
has the wrong outcome or stopping point. A changed draft or substantive Work
brief revokes an unstarted approval. Stale review clicks return 409 and require
a refresh. Agent tools cannot approve the condition or release a human hold.

Filed Work must pass the goal check for its exact current revision. For an
explicit draft, the browser enables approval after that check passes. The check reports actionable findings for missing
outcomes or boundaries, blocked and external-refusal exits, and known goalify
failure patterns. It checks direct conflicts between stated limits and required
actions. The human still judges the condition's meaning. Existing Work records
remain reviewable under their original approval rule.

For new UI Work, set `ui_work=true` on `create_work_item` or use a UI label such
as `ui`, `ux`, or `frontend`. Attach `design_preview` with a `version`, an
openable `artifactUrl`, and `desktopImageUrl` and `phoneImageUrl` for affected
surfaces. Set `affectsDesktop` and `affectsPhone` to name the affected surfaces;
without either flag, both images are required. Missing previews keep approval
unavailable. Non-UI Work has no preview requirement.

The Work tab also has project-level play/pause and a parallelism slider.
Paused projects retain Ready items in the queue. Dependencies must be `done`
before an item is eligible. Older Ready items without an approved goal need a
goal draft and approval before the scheduler can send them to a worker.

## What happens when Work is Ready

Muxterm's scheduler creates a new worker chat by default. It reuses a chat only
when that chat completed a direct prerequisite Work item, is ready and goal-free
in the same project, owns no unfinished Work, and its configuration remains
available. A recent chat, similar title, or participant link alone does not
establish useful context. Archived and human-paused chats are excluded. The
scheduler never uses the creating chat as the worker. It reserves a dispatch on
the Work item and creates a new chat without an opening turn if needed. It then
installs the filed or approved condition as that chat's native goal. Only after native acknowledgement and
observation of the exact applied revision does it send the Work ID and
execution instructions. The worker reads the record,
claims it with `update_work_item`, pursues the native goal, and records
step changes, progress, evidence, blockers, and outcome on Work. The goal ledger records the
same condition, its Work filing or approval provenance, native receipt,
and goal progress.

The supported native goal harnesses are Codex, Claude, Copilot, and Amplifier.
For a new worker, the scheduler checks the configured default harness and the
runtime's available options. If that harness cannot run a native goal or its
model catalog is unavailable, it tries Codex, Claude, Copilot, then Amplifier
in that order. The catalog supplies the default bundle, provider, model, and
supported reasoning effort; Codex uses medium effort when the model has no
catalog default and offers medium, and Claude uses its high-effort runtime
default. A related worker's existing harness and settings are checked against
the current catalog and activated before reuse. If no compatible combination exists, dispatch returns
a clear error without reserving the item. The Work dispatch and activity
timeline state whether the worker was created or reused, the prerequisite
that justified reuse, the effective settings, and any fallback reason. Work
approval authorizes this one exact condition; it does not let the scheduler overwrite another goal or
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
The goal fields are `goalCondition`, `goalRevision`, `goalCheck`,
`goalApprovedRevision`, and `goalApprovedAt`. New records also carry
`reviewVersion`, `uiWork`, and `designPreview`.

`plan` is a list of stable step IDs, readable titles, and statuses: `pending`,
`in_progress`, `done`, `blocked`, or `skipped`. `planRevision` counts explicit
replans, and `planProtocol` describes update checkpoints. Supply
`plan_protocol` whenever `create_work_item` includes `plan`. The worker uses
one `update_work_item` call with the current `expected_revision` to change one
or more `step_updates` alongside Work status, summary, progress, and next
action. The response includes the current record and owner unread-comment
attention. Report on claim, meaningful milestones, blockers, replans, and
completion; read and acknowledge comments before review or done. Replanning
sends the full plan and `plan_reason`; changing `plan_protocol` also requires
that explicit replan. New steps start pending and can advance through
`step_updates` in the same call. Activity retains attributed before/after steps. Done or
skipped steps cannot be rewritten, and Work cannot be done while planned steps
remain pending, in progress, or blocked. Older Work without a plan still works.
Resume a blocked step through `in_progress`; `blocked` cannot return to `pending`.
The Work progress count and bar use steps that are not skipped; skipped steps
stay visible in the checklist and get their own count.

For progress reports, send `summary` as one short sentence about the change or
decision (up to 160 characters). Put diagnostics, links, and lists in `text`
as Markdown. The Work timeline shows the summary first and lets a reader open
the full formatted update. Older long reports without a summary get a short
preview; their original text remains available. When a report omits an explicit
`progress` value, its summary becomes the current one-line progress shown at
the top of the Work detail page.

`create_work_item` files checked Work by default; use `draft=true` only for an
explicit draft. `update_work_item` records later changes with `client_ref` and
`expected_revision`. For draft review, the browser's
`POST /api/sdk-work/{id}/goal/approve` accepts the exact condition, both Work
and goal revisions, a stable `clientRef`, and optional `ready:true`. Only a
human browser may call it. `POST /api/sdk-work/{id}/goal/check` records a
revision-bound check after comparing those same exact fields. `list_work_items` and `get_next_work_item` can
filter by project and labels. `get_next_work_item` is a read, not a claim;
items without a filed or approved goal, held or paused items, full projects, and items
with unfinished dependencies are skipped. `start_work_item` requests a manual
handoff when the scheduler is playing. A direct `update_work_item` claim is
accepted only if that chat already has the exact filed or approved native goal applied
and authorized; the ordinary path is the scheduler handoff.

Each Work mutation is idempotent by `client_ref`; revision fences prevent a
stale assignment or approval from silently replacing newer work. Sparse
`work.goal.proposed` and `work.attention` notices reach the relevant chat;
ordinary Work updates remain on the record and in topic subscriptions rather
than flooding the main transcript.
