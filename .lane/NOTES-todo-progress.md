# Lane: dashboard todo progress

## T1 VERDICT: ANSWERED -- the data is reachable, via the existing hook pipeline.

### Where the todo state lives
`amplifier_module_tool_todo` (cache: amplifier-module-tool-todo-*) stores the list in
`coordinator.todo_state` -- a plain in-memory Python list on the coordinator. The tool
itself writes NOTHING to disk. So the naive answer to "is it persisted under
~/.amplifier/projects/*/sessions/?" is **no, not by the todo tool**.

### But it IS exposed to hooks -- and that is the load-bearing fact
Every `todo` call fires `TOOL_PRE` / `TOOL_POST` with:
  data["tool_name"]  == "todo"
  data["tool_input"] == {"action": "create"|"update"|"list", "todos": [ {content,
                          activeForm, status}, ... ]}

That is exactly how the terminal panel the user saw is drawn: `hooks-todo-display`
(foundation module) reads `data["tool_input"]["todos"]` in its own TOOL_PRE handler and
renders it. It is NOT screen-scraped -- it is the structured payload.

`modules/hooks-muxterm-session` ALREADY subscribes to both TOOL_PRE and TOOL_POST -- that
is where `doing` is re-templated on every tool call (state.py:842 on_tool_pre). **The todo
payload is already flowing through the exact handler we need and is currently discarded.**

### Durability
- `coordinator.todo_state` does NOT survive session end (in-memory).
- The spool snapshot written by state.py:flush() DOES: it is an atomic write-then-rename
  JSON file per session, and it deliberately outlives the session (see on_session_end +
  sweep_stale). So once the counts are published they persist exactly like `state`,
  `doing`, `label` and `pr` already do, with no new durability machinery.

### Consequence
The feature is SMALL. Path: capture todos in the existing on_tool_pre -> add a field to
SessionRecord -> emit in to_payload() -> add the JSON tag to sessiond.SessionState -> render
on the card. No second reporting channel, no scraping, no change to amplifier's todo tool.

## Remaining
- T2 carry on the pipeline (counts + current item)
- T3 card: fraction + current item, no height growth
- T4 honest fallback to `doing` when a session has no todos
- T5 tiles
