# Shared work records

The Issues view and the `create_work_item`, `list_work_items`, `get_work_item`,
and `update_work_item` MCP tools use one durable Work record. Creating or updating
work does not start an agent, send a chat message, or control a Chat Goal.

## Start with a request in chat

Tell a chat the outcome you want, even if your first completion condition is
rough. The chat should assess whether that condition actually demonstrates the
outcome, suggest a better one when needed, and ask about choices that depend on
your judgment. It then creates the Work item and maintains the acceptance
criteria, next action, and owner. You do not need to supply a chat ID or keep
the next action current yourself.

At kickoff, the coordinating chat can do the work itself, choose a suitable
existing chat, or create a new one in the relevant project. It records the
chosen owner and starts the worker's turn. The current API exposes these as
separate calls; it does not yet provide an atomic scheduler or automatically
wake a chat merely because a Work item was assigned.

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

## Work state

The record holds its brief, optional `acceptanceCriteria`, current progress,
`nextAction`, outcome, reviewer, and `blockedReason`. `nextAction` names the next
concrete step and can be changed or cleared with `next_action` in
`update_work_item`. Its status is `open`, `active`,
`blocked`, `review`, `done`, or `cancelled`. A blocked item requires a reason;
leaving blocked clears the reason. `review` means the work is ready for its
reviewer. Updates carry evidence references in the activity history.

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

## Agent mechanics: assign, claim, and start work

An active chat can find unassigned work with `list_work_items`, read one with
`get_work_item`, then claim it by calling `update_work_item` with its own
`owner_session_id` and the returned `expected_revision`. It can proceed in the
same turn. If another claimant got there first, the server returns 409; read
the record again before deciding what to do.

For an idle chat, create or assign the item to its chat ID, then call
`send_chat_message` once with the Work ID and next action. Assignment is a
durable ownership change; that explicit message starts the chat turn. A chat
that claims work while already running needs no extra kickoff message. Neither
path starts a Chat Goal.
