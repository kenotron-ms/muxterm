# Shared work records

The Issues view and the `create_work_item`, `list_work_items`, `get_work_item`,
and `update_work_item` MCP tools use one durable Work record. Creating or updating
work does not start an agent, send a chat message, or control a Chat Goal.

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
separately, and the detail view can reassign the owner or reviewer.

Assignment changes require `expected_revision` from `get_work_item` (or
`expectedRevision` over HTTP). The server rejects a stale revision with 409,
so concurrent claims do not silently replace one another. A chat may assign
work it created or currently owns; an unassigned item may be claimed by a chat
for itself. Browser and same-user external tools retain their existing control
scope. Each change has a `client_ref`; retrying the same change returns its
record instead of appending it twice.

## Work state

The record holds its brief, optional `acceptanceCriteria`, current progress,
outcome, reviewer, and `blockedReason`. Its status is `open`, `active`,
`blocked`, `review`, `done`, or `cancelled`. A blocked item requires a reason;
leaving blocked clears the reason. `review` means the work is ready for its
reviewer. Updates carry evidence references in the activity history.

Work updates are written to the Work record. A typed `work.*` event is also
written to the owner's chat event stream, where an explicit `work` topic
subscription may observe it. These events do not become ordinary messages in
the chat transcript. An unassigned item's record remains discoverable in the
Issues list without selecting an arbitrary chat as its notification target.
