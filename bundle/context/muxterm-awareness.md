# Muxterm

muxterm is a browser-based terminal multiplexer. When this bundle is loaded, you have access
to `mcp_muxterm_*` tools that control a running muxterm instance — create panes, run shell
commands, manage workspaces, and automate browser panes.

**Prerequisite:** muxterm must be running before these tools will work.
Start it with `muxterm` (local mode) or `muxterm serve` (remote access).

## Available Tool Groups

| Group | Tools |
|-------|-------|
| Workspaces | `mcp_muxterm_create_workspace`, `list_workspaces`, `switch_workspace`, `close_workspace` |
| Panes | `mcp_muxterm_create_pane`, `list_panes`, `get_layout`, `rename_pane`, `close_pane` |
| Terminal | `mcp_muxterm_run_command`, `send_input`, `get_screen` |
| Browser | `mcp_muxterm_browser_snapshot`, `browser_goto`, `browser_click`, `browser_fill`, and more |

## When to Delegate to muxterm-expert

For complex muxterm workflows — multi-pane setups, running and observing commands, browser
automation across panes — delegate to `muxterm:muxterm-expert`. It carries detailed tool
documentation and workflow patterns.
