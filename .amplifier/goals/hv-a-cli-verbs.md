# Lane A — CLI verbs (`pane send`, `workspace` family)

## Outcome

`muxterm` gains the CLI verbs that the home view's action buttons and dispatch
prompt will call. Today the CLI can read and reshape panes but **cannot type**,
and cannot create or close a workspace. Issue #47 documents this gap. After this
lane, a shell script can drive a muxterm pane end to end.

Concretely, these all work against a running daemon:

```
muxterm pane send <pane-id> [--text STR] [--keys Enter,C-c] [--workspace ID] [--json]
muxterm pane rename <pane-id> <name> [--workspace ID] [--json]
muxterm workspace list [--json]
muxterm workspace create <name> [--json]
muxterm workspace close <workspace-id> [--json]
```

## ⛔ HARD SAFETY CONSTRAINT — read before running anything

A human is **using a live muxterm right now** to talk to the orchestrator. It
runs as `muxterm serve --addr 127.0.0.1:9090` on the **default** sessiond socket,
fronted by Caddy at https://muxterm.ampbox.io. There is also a `python3 -m
http.server 8477` serving design mockups.

- **NEVER** run `pkill muxterm`, `pkill sessiond`, `killall`, or any broad kill.
- **NEVER** touch anything on port 9090, port 8477, or the default socket.
- **DO NOT run `make dev-local`.** It binds a single fixed port (8313) and a
  single shared runtime dir; sibling lanes are running concurrently and would
  collide with each other. The orchestrator owns dev-local and will verify your
  work there. If you believe you cannot finish without it, that is a
  `BLOCKED-needs-dev-local` residual — record it and stop.
- Only ever stop a process **your own lane started**, by the specific PID you
  recorded.

You can get a very long way with `go build ./...` and reading the code. Do that.

## Working agreement

- Working directory: `/home/ken/workspace/muxterm-hv-worktrees/hv-a-cli-verbs`
- Branch: `goal/hv-a-cli-verbs`
- Base SHA: pinned by the launcher. Work ONLY in this worktree. Do not touch the
  main checkout at `/home/ken/workspace/muxterm` or any sibling worktree.
- **Never merge to main.** The orchestrator merges. Push your branch.
- **Commit early, push always.** Push every commit as you make it. A crash then
  costs minutes instead of hours.

## Files you own

- `cmd/muxterm/pane_cmd.go`
- `cmd/muxterm/workspace_cmd.go` (new)
- `cmd/muxterm/cli.go`
- `cmd/muxterm/cli_daemon.go`
- `cmd/muxterm/session_cmd.go` (only if `workspace list` should share its
  rendering — your call)

**Residual protocol.** Files outside that list belong to sibling lanes. Lane B
owns `internal/`, `modules/`. Lane C owns `web/`. If you need a change there,
**do not make it** — write it into `residuals[]` in your DONE.json describing
exactly what is needed and why, and continue. Crossing into another lane's files
is a defect, not a courtesy.

## What already exists (do not rebuild)

`internal/sessiond.Client` already has every primitive you need. This lane is
CLI surface only — **no protocol changes, no daemon changes.**

| You need | Already exists |
|---|---|
| send bytes to a pane | `Client.Input(paneID uint32, data []byte) error` (client.go:492) |
| create a workspace | `Client.CreateWorkspace(name string) (string, error)` (client.go:290) |
| close a workspace | `Client.CloseWorkspace(workspaceID string) error` (client.go:307) |
| rename a pane | `Client.RenamePane(paneID int, name string) error` (client.go:447) |
| list workspaces | `Client.ListWorkspaces() ([]WorkspaceInfo, error)` (client.go:280) |

`cmd/muxterm/cli_daemon.go` already has `dialDaemon()`, `attachForPane()`,
`attachDefaultWorkspace()`, `hasPane()`. Reuse them — every pane-scoped daemon
request is gated on the connection being attached to that pane's workspace.

Follow the shape of the existing subcommand trees exactly: `runPane` dispatch,
`flag.NewFlagSet`, `reorderFlagsFirst`, a `--json` struct per command, help text
in the same voice. `muxterm pane close` is your closest template.

## Key translation for `--keys`

MCP already implements this. Read `internal/mcp/tools_terminal.go` `sendInput`
and **match its key names and byte sequences exactly** — the point of this lane
is that CLI and MCP behave identically. At minimum: `Enter Tab Escape Backspace
Up Down Left Right C-c C-d C-z`.

Semantics to preserve from MCP: `--text` is sent as **literal bytes, unchanged**,
safe for any payload including a string that happens to look like a key name.
If both `--text` and `--keys` are given, text is sent first, then keys. At least
one is required.

## `muxterm workspace` vs the existing `muxterm session`

`muxterm session list` already lists workspaces. Adding `muxterm workspace list`
creates two names for one thing. **Decide deliberately and write the decision
into your DONE.json `notes`.** Acceptable outcomes: alias them, have `session`
print a deprecation line, or keep both silently. Do not leave it unconsidered —
this ambiguity is called out in issue #47.

## Verification

⛔ **AGENTS.md bans unit tests. Do not add `*_test.go`.** Not for "pure logic",
not for the key table. If an existing test breaks because of your change, fix
the test to match the new behaviour.

Required, and all of these are things you CAN do without dev-local:

1. `go build ./...` — must be clean. This is the baseline; it passes today.
2. `./bin/muxterm pane --help`, `workspace --help`, `pane send --help` — build
   the binary and actually run them. Paste the real output into DONE.json.
3. Confirm `--json` output shape for each new command by reading your own struct
   definitions against the existing ones.

If you finish early and want stronger evidence, describe in DONE.json the exact
commands the orchestrator should run against dev-local to prove `pane send`
works end to end — e.g. create a pane, send `echo hello` + Enter, then
`read-screen` it back. **Write the recipe; do not run it.**

## Time bound

Wall-clock bound is enforced by the launcher. Exceeding it is a terminal
`BUDGET` state — it is **not** a reason to rush the work, skip a commit, or
declare success. Commit and push what is real, then write DONE.json.

## Resources

This lane provisions **no** non-git resources: no containers, no servers, no
background processes. If that changes, name each one in DONE.json `resources[]`
with how it was torn down. A lane that exits with resources running has not
finished.

## Definition of done

Complete when **either** every item below reaches a terminal state, **or** it is
conclusively demonstrated the remainder cannot, naming the blocker for each.
Items ending FAIL or BLOCKED are residuals, not failures of the goal.

Terminal states: `PASS` / `FAIL-<named>` / `BLOCKED-<named>` / `PENDING-HUMAN`.

1. `muxterm pane send` implemented, with `--text`, `--keys`, `--workspace`, `--json`
2. `muxterm pane rename` implemented
3. `muxterm workspace list|create|close` implemented
4. Key names and byte sequences match `internal/mcp/tools_terminal.go`
5. Top-level `printUsage` in cli.go updated to mention the new verbs
6. `go build ./...` clean
7. Real `--help` output captured in DONE.json
8. The `session` vs `workspace` naming decision recorded in DONE.json `notes`
9. All work committed AND pushed to `origin goal/hv-a-cli-verbs`

## Final act

Write `DONE.json` in the worktree root. It is already gitignored — do not commit
it. Fields:

```json
{
  "lane": "hv-a-cli-verbs",
  "session_id": "<your own amplifier session id>",
  "verdict": "COMPLETE | BLOCKED | PARTIAL",
  "branch": "goal/hv-a-cli-verbs",
  "head": "<sha>",
  "pushed": true,
  "items": [{"id": 1, "state": "PASS", "note": "..."}],
  "residuals": [],
  "pending_human": [],
  "resources": [],
  "notes": "session-vs-workspace decision; verification recipe for the orchestrator",
  "suite": "go build ./... clean"
}
```

`verdict` must be exactly one of `COMPLETE`, `BLOCKED`, `PARTIAL`. `session_id`
must be your own — without it an exited session cannot be told apart from a
killed one.
