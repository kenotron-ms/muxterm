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

## VERDICTS

| # | Verdict | What proves it |
|---|---|---|
| T1 | **PASS** | Above. Structured `tool_input`, no scraping. |
| T2 | **PASS** | Hook writes `todo` to the spool; two real amplifier sessions, one with a list and one without, produced exactly the two shapes below. |
| T3 | **PASS** | Fraction + current task on the card's existing third line. Card height 74px before and after, measured. |
| T4 | **PASS** | The card of a session that keeps no list shows `doing` alone -- no fraction element and no bar element in the DOM at all. |
| T5 | **PASS** | Fraction appended to the tile's existing status line; no row spent. |
| Go side | **PASS** | `TodoProgress` on `SessionState`, hashed in the store, omitted-when-absent in `fleet`. |

## How it was verified

`make dev-local` on :8313 with its own `XDG_RUNTIME_DIR` and `XDG_DATA_HOME`
(`/tmp/muxterm-dev-local`), production on 9090/8311 untouched. Two REAL
amplifier sessions in two panes of that instance, loading this worktree's
hook through a project-local module source override.

Spool, written by the hook itself:

```json
"doing": "Updating the task list",
"todo": {"done": 4, "total": 5, "current": "Opening the pull request"}
```
```json
"doing": "git log"          // second session: no todo key at all
```

`muxterm fleet --json` carried `todo` on the first row and omitted the key
entirely on the second.

In the browser, live, with no reload: 0/5 -> 2/5 -> 4/5 as the session revised
its own list; bar fill 0% -> 40% -> 80%; card height 74px throughout, and 158px
throughout in tiles. Height confirmed independently by screenshotting each of
two adjacent cards as an element and comparing PNG dimensions: 366x75 both.

### One bug this caught
The bar was first anchored to `.meta`. `.card` is border-box `height: 74px`, so
its inner box is 72px while `.meta` declares 74px -- the bar landed entirely in
the 2px `.meta` overflows by, and `overflow: hidden` clipped every pixel. It
was in the DOM, correctly sized and correctly filled, and invisible. Only
looking at the pixels found it. Fixed by anchoring to `.card`.
