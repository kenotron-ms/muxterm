# muxterm

A browser workspace for persistent terminals and agent work, backed by a Go session daemon.

See [the vision](VISION.md) for the product direction and [the documentation map](docs/README.md) for current guides and historical records.

## Install

### macOS — Homebrew
```bash
brew install kenotron-ms/tap/muxterm
```

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/kenotron-ms/muxterm/main/install.sh | bash
```

Or review first:
```bash
curl -fsSL https://raw.githubusercontent.com/kenotron-ms/muxterm/main/install.sh -o install.sh
less install.sh
bash install.sh
```

**No sudo required.** The binary installs to `~/.local/bin` and PATH is configured automatically.

Terminal and workspace features work without an AI provider. AI setup is optional:

| Conversation | First-time setup |
| --- | --- |
| Amplifier chats | [Install Amplifier](https://github.com/microsoft/amplifier-app-cli#installation), run `amplifier init` to choose a provider and model, then restart muxterm. If you choose Ollama, start its server and pull a model first. |
| Codex chats | Install Node.js and npm, install Codex, then run `codex login` in a terminal. |
| Claude Code chats | Install Node.js and npm, install Claude Code, then run `claude` in a terminal to sign in. |

The Anthropic key in muxterm's Settings → AI is separate from those logins.

**To run as a background service** (persists across reboots):
```bash
muxterm install
# Optionally, to keep running even when logged out:
sudo loginctl enable-linger $USER
```

**To upgrade:**
```bash
curl -fsSL https://raw.githubusercontent.com/kenotron-ms/muxterm/main/install.sh | bash
muxterm install  # restarts the service with the new binary
```

The in-app release check shares a cache across muxterm processes under the
same user (`~/.cache/muxterm/github-release.json` on Linux). Automatic checks
use a 24-hour cache when anonymous and a 15-minute cache when the enabled
GitHub connection supplies a token. An explicit check is available in About.
Expired entries are revalidated with GitHub's ETag, and requests pause until
the reported reset when the API rate limit is exhausted. `GITHUB_TOKEN` (or
`GH_TOKEN`) in the server environment also uses an authenticated GitHub budget;
tokens are never written to the cache. GitHub only guarantees that an unchanged
`304` response is free of primary-rate-limit cost when authenticated; an
unauthenticated `304` can still spend the shared IP budget. Development builds,
`--no-auth` servers, `make dev` and `make dev-local` instances, and CI jobs skip
release checks. Set `MUXTERM_DISABLE_UPDATE_CHECK=1` for other short-lived instances.

### Windows — Scoop (coming soon)

Pre-built binaries for each platform are attached to every [GitHub Release](https://github.com/kenotron-ms/muxterm/releases).

## What is this?

muxterm is a terminal multiplexer where the UI lives in a browser. Open splits, create workspaces, resize panes — all standard multiplexer behavior, except it's HTML and xterm.js instead of ncurses, and it runs as a web app you install once and connect to from anywhere.

The session daemon is a standalone Go process that owns your PTYs directly. It survives HTTP server restarts. When you reconnect, it replays a clean screen state — not a raw byte stream — so full-screen apps like vim and htop come back correctly at whatever size your window happens to be.

```
Browser (Lit + xterm.js + dockview)
    ↕ WebSocket (binary-framed protocol)
Go server (HTTP + WS relay)
    ↕ Unix socket
sessiond (PTY daemon)
    ↕ PTY
your shells
```

## Quick start

```bash
# Build
make build

# Run locally (opens browser, connects to local sessiond)
./bin/muxterm

# Run as a service (remote access, with token auth)
./bin/muxterm serve --addr 0.0.0.0:8080

# Install as a system service (survives reboots)
./bin/muxterm install

# Push to a remote server
./bin/muxterm deploy user@myserver.com
```

## Features

- **Workspaces** — named groups of panes, switch between them from a bar at the top
- **Split panes** — real DOM layout via dockview; drag to resize, arbitrary nesting
- **Clean reconnects** — server-side VT emulation replays a live cell-grid snapshot, not raw bytes; full-screen apps restore correctly at any window size
- **PWA** — installable as a standalone desktop or mobile app; service worker for offline support
- **Palette-derived chrome** — UI colors are derived from the active terminal palette automatically
- **Session persistence** — sessiond owns PTYs independently of the HTTP server, so shells survive browser disconnects and HTTP server restarts
- **Embedded frontend** — the Go binary serves the web UI; optional AI features require their respective providers and tools
- **Auth** — HMAC token-based auth with localhost bypass
- **Service install** — `muxterm install` sets up systemd (Linux) or launchd (macOS)
- **Push deploy** — `muxterm deploy user@host` copies the binary and installs remotely
- **Agent integration (MCP)** — connect any MCP-compatible AI agent to drive workspaces, panes, and terminals
- **Agent sessions** — Claude, Codex, and Amplifier report native lifecycle hooks into one durable fleet, with terminals as optional attachments
- **Mission Control** — one persistent Operator conversation alongside the terminal and agent fleet

## Agent integration (MCP)

`muxterm mcp` exposes a [Model Context Protocol](https://modelcontextprotocol.io) server that lets any MCP-compatible AI agent drive workspaces, panes, and terminals. The server speaks JSON-RPC 2.0 over stdio and requires a running `muxterm` or `muxterm serve` instance to connect to.

**25 tools** across 7 categories: workspace management, pane layout (with ASCII diagram for spatial awareness), terminal control (OSC 133 shell completion), agent delegation and fleet status, read-only file access across the machine boundary, port tunnels, publishing a file to a public URL, and server configuration.

`publish_file` is the one that reaches the public internet: it serves ONE local file at an unguessable URL that anyone holding the link can read with no muxterm account. The content is **live** -- re-read from disk on every request -- so edits are visible immediately to everyone holding the link, and the link cannot be un-sent. Every publication expires (24h by default, 7 days maximum) and can be revoked, which stops future reads but recalls nothing already read. See `internal/server/publish.go`.

### Agent session reporting

Agent sessions are the fleet's primary records; a workspace and pane are optional
terminal attachments. Start supported harnesses through `muxterm claude`,
`muxterm codex`, or `muxterm amplifier`. Each wrapper installs invocation-scoped
native hooks that report through the same durable ingress. Raw vendor commands
are outside guaranteed fleet coverage. Muxterm does not poll `claude agents` or
edit global Claude, Codex, or Amplifier settings.

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

See [lane approval policy](docs/decisions/2026-09-19-lane-approval.md) for the
config path, launch flags, verified versions, and fail-loud compatibility checks.

This launch policy is separate from managed `session send` turns. Approval
brokerage for managed turns and cross-surface terminal takeover remain disabled;
`session send --help` reports that boundary explicitly.

## Architecture

The browser renders panes with Lit, dockview, and xterm.js. The Go server handles HTTP, authentication, WebSocket relay, and Mission Control. Sessiond owns workspaces, real PTYs, screen replay, pane activity, and agent fleet records. See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and protocol details.

## Requirements

- **Go** 1.24.2+ (the module selects toolchain 1.24.4)
- **Node.js** 18+

## Development

```bash
# Build everything (frontend + Go binary)
make build

# Build frontend only
cd web && npm install && npm run build

# Fast frontend checks (lint + types, no build)
cd web && npm run check:fast

# Run the isolated development stack at http://127.0.0.1:8313
make dev-local
```

Before running tests or browser verification on a machine with muxterm installed, read [AGENTS.md](AGENTS.md). Some service tests operate on real user services. Do not use production ports `8311` or `9090` for verification.

## Design

See [DESIGN.md](DESIGN.md) for current interface principles and the [documentation map](docs/README.md) for feature designs and decisions.

## License

MIT
