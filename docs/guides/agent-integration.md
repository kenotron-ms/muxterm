# Agent integration and lane approvals

`muxterm mcp` exposes a [Model Context Protocol](https://modelcontextprotocol.io) server that lets any MCP-compatible AI agent drive workspaces, panes, and terminals. The server speaks JSON-RPC 2.0 over stdio and requires a running `muxterm` or `muxterm serve` instance to connect to.

The tool surface includes workspace management, pane layout (with ASCII diagram for spatial awareness), terminal control (OSC 133 shell completion), agent delegation and fleet status, read-only file access across the machine boundary, port tunnels, publishing a file to a public URL, and server configuration.

`publish_file` is the one that reaches the public internet: it serves ONE local file at an unguessable URL that anyone holding the link can read with no muxterm account. The content is **live** -- re-read from disk on every request -- so edits are visible immediately to everyone holding the link, and the link cannot be un-sent. Every publication expires (24h by default, 7 days maximum) and can be revoked, which stops future reads but recalls nothing already read. See [`internal/server/publish.go`](../../internal/server/publish.go).

## Native browser control in the macOS app

The Mac app exposes its own browser tabs to the local `browser_action` MCP tool. `inspect` returns a compact list of visible elements with refs; use `click` or `type` with those refs. `screenshot` is available when visual inspection is needed. The control socket is local to the Mac and accessible only to the same user. Browser content and signed-in sessions are sensitive; stop agent actions before opening secrets.

## Agent session reporting

Agent sessions are the fleet's primary records; a workspace and pane are optional
terminal attachments. Start supported harnesses through `muxterm claude`,
`muxterm codex`, or `muxterm amplifier`. Each wrapper installs invocation-scoped
native hooks that report through the same durable ingress. Raw vendor commands
are outside guaranteed fleet coverage. Muxterm does not poll `claude agents` or
edit global Claude, Codex, or Amplifier settings.

## MCP client setup

### Amplifier

Add to `.amplifier/mcp.json` (project) or `~/.amplifier/mcp.json` (global):

```json
{
  "mcpServers": {
    "muxterm": {
      "command": "muxterm",
      "args": ["mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add muxterm -- muxterm mcp
```

Or add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "muxterm": {
      "command": "muxterm",
      "args": ["mcp"]
    }
  }
}
```

### OpenCode

Add to `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "muxterm": {
      "type": "local",
      "command": ["muxterm", "mcp"]
    }
  }
}
```

## Lane approvals

Codex and Claude lanes default to prompting. To opt in to unattended execution,
set `[lanes] approval = "never"` in your muxterm `config.toml`. This disables
approval prompts and Codex sandboxing. `spawn_lane` accepts an optional
`approval: "prompt" | "never"` override; the CLI uses `--approval`.

See [lane approval policy](../decisions/2026-09-19-lane-approval.md) for the
config path, launch flags, verified versions, and fail-loud compatibility checks.

This launch policy is separate from managed `session send` turns. Approval
brokerage for managed turns and cross-surface terminal takeover remain disabled;
`session send --help` reports that boundary explicitly.
