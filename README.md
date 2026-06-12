# muxterm

A web-first terminal multiplexer. Persistent sessions, split panes, and a browser UI — backed by a custom Go session daemon.

## Install

### macOS — Homebrew
```bash
brew install user/tap/muxterm
```

### macOS / Linux — curl
```bash
curl -fsSL https://github.com/user/muxterm/releases/latest/download/muxterm_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz | tar -xz -C /usr/local/bin muxterm
```

### Windows — Scoop (coming soon)

Pre-built binaries for each platform are attached to every [GitHub Release](https://github.com/user/muxterm/releases).

> **Note:** Replace `user` in the install commands with the real GitHub username once the repo is published.

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
- **Browser pane** — embed a running local web app (e.g. a dev server on port 3000) as a mux pane, proxied through the server
- **PWA** — installable as a standalone desktop or mobile app; service worker for offline support
- **Palette-derived chrome** — UI colors are derived from the active terminal palette automatically
- **Session persistence** — the sessiond daemon detaches from the HTTP server; your shells survive server restarts, deploys, and reboots
- **Single binary** — Go binary with embedded frontend; no external runtime besides a shell
- **Auth** — HMAC token-based auth with localhost bypass
- **Service install** — `muxterm install` sets up systemd (Linux) or launchd (macOS)
- **Push deploy** — `muxterm deploy user@host` copies the binary and installs remotely
- **Agent integration (MCP)** — connect any MCP-compatible AI agent to drive workspaces, terminals, and browser panes

## Agent integration (MCP)

`muxterm mcp` exposes a [Model Context Protocol](https://modelcontextprotocol.io) server that lets any MCP-compatible AI agent drive workspaces, terminals, and browser panes. The server speaks JSON-RPC 2.0 over stdio and requires a running `muxterm` or `muxterm serve` instance to connect to.

**25 tools** across 6 categories: workspace management, pane layout (with ASCII diagram for spatial awareness), terminal control (OSC 133 shell completion), browser navigation, browser interaction, and browser observation.

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

## Architecture

| Component | Role |
|-----------|------|
| `cmd/muxterm/` | CLI — serve, install, uninstall, deploy, sessiond, doctor |
| `internal/sessiond/` | PTY daemon — workspace/pane registry, VT emulation, reconnect replay |
| `internal/server/` | HTTP + WebSocket relay, auth, browser-pane proxy |
| `internal/service/` | Cross-platform service install (systemd/launchd) |
| `internal/deploy/` | Push-to-remote via SSH |
| `web/src/` | Lit web components, xterm.js terminal rendering, dockview split layout |

### Session daemon

`sessiond` is a separate Unix socket daemon that manages PTYs independently of the HTTP server. Each pane is a real PTY running `$SHELL`. The daemon auto-starts when the first browser client connects, and keeps running when the server restarts.

For reconnect, `sessiond` runs a headless VT emulator (`charmbracelet/x/vt`) per pane with 2000-line scrollback. On attach, it serializes the live cell grid and sends it as a clean replay — so reconnecting to a vim session doesn't produce garbage at the wrong terminal size.

### Protocol

One WebSocket per browser tab, backed by one Unix socket connection to `sessiond`. Frames are binary-prefixed: `[4-byte length][1-byte kind][payload]`. Pane I/O is raw bytes with a 4-byte pane ID prefix. Control messages are JSON. The protocol is frozen — sessiond and the HTTP relay can be updated independently as long as the frame format is stable.

## Requirements

- **Go** 1.22+
- **Node.js** 18+

## Development

```bash
# Build everything (frontend + Go binary)
make build

# Run Go tests
make test

# Build frontend only
cd web && npm install && npm run build

# Run frontend tests
cd web && npm test

# Fast frontend checks (lint + types, no build)
cd web && npm run check:fast
```

## Design

See [docs/design.md](docs/design.md) for architecture details and decision rationale.

## License

MIT
