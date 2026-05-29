# muxterm

A web-native tmux client. Tabs, panes, and splits in your browser, powered by tmux control mode.

## What is this?

muxterm gives you a browser-based terminal that's backed by tmux. Click tabs to switch windows. See panes as real split views. Drag to resize. All powered by tmux underneath — your sessions persist, your config works, your plugins apply.

Built for people who want the power of tmux without the learning curve. If you've used Claude Code or similar AI tools and want remote terminal access, muxterm makes that simple.

## How it works

```
Browser (Lit + ghostty-web)
    ↕ WebSocket
Go server (muxterm)
    ↕ tmux control mode (-CC)
tmux server
    ↕ PTY
your shells
```

muxterm connects to tmux via control mode — the same protocol iTerm2 uses for its tmux integration. Each tmux window is a clickable tab. Each pane is a separate terminal canvas rendered by ghostty-web (libghostty compiled to WASM). One WebSocket, real-time state sync.

## Quick start

```bash
# Build
make build

# Run locally (opens browser, connects to local tmux)
./bin/muxterm

# Run as a service
./bin/muxterm serve --addr 0.0.0.0:8080

# Install as a system service (survives reboots)
./bin/muxterm install

# Push to a remote server
./bin/muxterm deploy user@myserver.com
```

## Requirements

- **tmux** 3.2+ (control mode support)
- **Go** 1.22+ (to build)
- **Node.js** 18+ (to build frontend)

## Features

- **Tabs** — tmux windows as clickable browser tabs
- **Split panes** — each pane is its own terminal canvas, laid out with CSS flex
- **Resize** — drag pane borders to resize (sends `resize-pane` to tmux)
- **ghostty-web** — terminal rendering via libghostty WASM (battle-tested parser from Ghostty)
- **Real-time** — tmux control mode events stream directly to the browser, no polling
- **Session persistence** — tmux sessions survive disconnects, reboots, and server restarts
- **Service install** — `muxterm install` sets up systemd (Linux) or launchd (macOS)
- **Push deploy** — `muxterm deploy user@host` copies the binary and installs remotely
- **Single binary** — Go binary with embedded frontend, no runtime deps besides tmux
- **Auth** — HMAC token-based auth with localhost bypass

## Architecture

| Component | Role |
|-----------|------|
| `cmd/muxterm/` | CLI — serve, install, uninstall, deploy |
| `internal/tmux/` | tmux control mode parser, state model, layout parser |
| `internal/server/` | HTTP + WebSocket server, auth, pane I/O routing |
| `internal/service/` | Cross-platform service install (systemd/launchd) |
| `internal/deploy/` | Push-to-remote via SSH |
| `web/src/` | Lit web components + ghostty-web terminal rendering |

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
```

## Design

See [docs/design.md](docs/design.md) for the full architecture and design decisions.

## License

MIT
