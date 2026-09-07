# Muxterm

muxterm is a browser-based terminal multiplexer. When this bundle is loaded, you have access
to `mcp_muxterm_*` tools that control a running muxterm instance — create panes, run shell
commands, and manage workspaces.

**Prerequisite:** muxterm must be running before these tools will work.
Start it with `muxterm` (local mode) or `muxterm serve` (remote access).

## Available Tool Groups

| Group | Tools |
|-------|-------|
| Workspaces | `mcp_muxterm_create_workspace`, `list_workspaces`, `switch_workspace`, `close_workspace`* |
| Panes | `mcp_muxterm_create_pane`, `list_panes`, `get_layout`, `rename_pane`, `close_pane`* |
| Terminal | `mcp_muxterm_run_command`, `send_input`, `get_screen` |
| Delegation | `mcp_muxterm_spawn_lane` — launch an amplifier/claude session in a named workspace (created if absent); `goal` makes it a `/goal` loop |

\* **Not available to a session running inside a muxterm pane.** If that is you,
`close_workspace` and `close_pane` are simply absent from your tool list — check the
list, do not assume this table. Closing a workspace is the human's call (and the chief
of staff's, on the human's behalf); a session in a pane reports its result and stops,
leaving the workspace standing so the result can be read.

**Tearing down what you started never means closing your workspace or your pane.** It
means the processes, servers and containers you launched.

## When to Delegate to muxterm-expert

For complex muxterm workflows — multi-pane setups, running and observing commands,
coordinating work across panes and workspaces — delegate to `muxterm:muxterm-expert`. It
carries detailed tool documentation and workflow patterns.
