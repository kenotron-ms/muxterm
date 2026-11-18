# Shared work records

The Issues view and the `create_work_item`, `list_work_items`,
`get_next_work_item`, `get_work_item`, `update_work_item`, and
`start_work_item` MCP tools use one durable Work record. Creating or updating
work does not start an agent, send a chat message, or control a Chat Goal.
The Issues view can narrow the visible list by project and label; the MCP list
and next-ready tools accept multiple project IDs (any match) and labels (all match).

## Start with a request in chat

Tell a chat the outcome you want, even if your first completion condition is
rough. The chat should assess whether that condition actually demonstrates the
outcome, suggest a better one when needed, and ask about choices that depend on
your judgment. It then creates the Work item and maintains the acceptance
criteria and next action. Muxterm selects a worker at kickoff, and the worker
claims ownership. You do not need to supply a chat ID or keep
the next action current yourself.

At kickoff, the coordinating chat calls `start_work_item` with the Work ID and
a stable `client_ref`. Muxterm chooses a ready chat in a matching project that
owns no other unfinished work, or creates one. It sends the Work ID to that
chat; the worker reads the record, claims it, and starts its next action.
The system records the selected chat and dispatch state on the Work item.
An item with unfinished prerequisites cannot be started.

## People and sessions

`createdBy` records who submitted the original item. It is immutable. Muxterm
records a chat capability as `{kind:"chat",sessionId}`, a browser as
`{kind:"human"}`, and a same-user external tool as `{kind:"external-tool"}`.
Older records are shown with their original `ownerSessionId` as the creator;
that provenance is written into the record on its first update.

`ownerSessionId` is the current assignee, not the creator. It may be empty for
unassigned work. `reviewerSessionId` is an optional chat expected to inspect the
result. Linked `sessionIds` remain participants; reassignment does not erase
the previous owner's history. The Issues list shows creator and current owner
separately; the detail view shows the record and its activity. Every chat shown
in the Issues view links to that chat. Create and update work through the MCP
tools or API. The Issues UI is read-only.

Assignment changes require `expected_revision` from `get_work_item` (or
`expectedRevision` over HTTP). The server rejects a stale revision with 409,
so concurrent claims do not silently replace one another. A chat may assign
work it created or currently owns; an unassigned item may be claimed by a chat
for itself. Browser and same-user external tools retain their existing control
scope. Each change has a `client_ref`; retrying the same change returns its
record instead of appending it twice.

`dispatch` records the chat selected by `start_work_item` and whether kickoff
is `preparing`, `sent`, `claimed`, `uncertain`, or `failed`. A sent input means
Muxterm admitted the worker's turn; `claimed` means that chat took ownership.
Repeated calls with the same `client_ref` return the same dispatch. If delivery
is uncertain, inspect the linked chat and Work record before a new attempt;
Muxterm does not blindly resend an uncertain input. A failed dispatch can be
retried with a new reference. The Issues view links the selected chat.

## Work state

The record holds its brief, optional `acceptanceCriteria`, current progress,
`nextAction`, outcome, reviewer, and `blockedReason`. `nextAction` names the next
concrete step and can be changed or cleared with `next_action` in
`update_work_item`. Its status is `open`, `active`,
`blocked`, `review`, `done`, or `cancelled`. A blocked item requires a reason;
leaving blocked clears the reason. `review` means the work is ready for its
reviewer. Updates carry evidence references in the activity history.

`labels` are normalized to lowercase and can be changed with
`update_work_item` using `expected_revision`. An empty `labels` list clears
them. `list_work_items` and `get_next_work_item` accept `project_id` (one or
several values) and `label` (one or several values) over HTTP. The matching
MCP arguments are `project_id` or `project_ids`, and `labels`. Multiple
projects mean **any** listed project; multiple labels mean **all** listed
labels. Omit either filter to search across all projects or labels.

`dependsOn` lists prerequisite Work IDs. `waitingOn` is derived from those
records and lists prerequisites that have not reached `done`; a cancelled
prerequisite remains unmet. Muxterm rejects unknown IDs and dependency cycles.
The API rejects attempts to move waiting work to `active`, `review`, or `done`.
Adding or replacing dependencies requires `expected_revision`; pass an empty
`depends_on` list to clear them. Once all prerequisites are done, `waitingOn`
becomes empty without an edit to the dependent record. The Issues view shows
the waiting count and links each prerequisite in the detail view. This is a
readiness rule, not an automatic kickoff: a worker must still be started.

Work updates are written to the Work record. A typed `work.*` event is also
written to the owner's chat event stream, where an explicit `work` topic
subscription may observe it. These events do not become ordinary messages in
the chat transcript. An unassigned item's record remains discoverable in the
Issues list without selecting an arbitrary chat as its notification target.

## Agent mechanics: find, claim, and start work

An active chat can call `get_next_work_item` with optional `project_ids` and
`labels` filters to
fetch the oldest ready item in the unassigned pile. The result is
`{"work":null}` when none is ready. Ready means `status=open`, no owner, and
every `dependsOn` item is `done`. Items waiting on prerequisites are never
returned. The tool is read-only and does not reserve the item. Claim it with
`update_work_item`, using its own `owner_session_id` and the returned
`revision` as `expected_revision`. It can proceed in the same turn. If another
claimant got there first, the server returns 409; fetch again before deciding
what to do. For a broader inspection of blocked or assigned work, use
`list_work_items` and `get_work_item`.

For a new item that needs a worker, call `start_work_item` with `work_id` and a
stable `client_ref`. Muxterm reserves one dispatch before selecting a worker;
while reserved, the item is excluded from `get_next_work_item`. The selected
chat claims with its own ID and the latest revision. A chat already running
can claim ready work from the pile and continue in the same turn. Neither path
starts a Chat Goal.
