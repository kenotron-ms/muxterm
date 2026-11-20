# Installation, updates, and local development

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

## Build and run from source

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

## Requirements

- **Go** 1.24.2+ (the module selects toolchain 1.24.4)
- **Node.js** 22+ (required by current chat sidecar dependencies)

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

Before running tests or browser verification on a machine with muxterm installed, read [AGENTS.md](../../AGENTS.md). Some service tests operate on real user services. Do not use production ports `8311` or `9090` for verification.
