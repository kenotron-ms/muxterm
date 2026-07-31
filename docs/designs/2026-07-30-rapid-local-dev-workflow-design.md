# Rapid Local Dev Workflow Design

## Goal

A single command, `make dev-local`, that stands up a fully isolated second muxterm instance on this Mac -- its own binary, its own port, its own sessiond socket/log/runtime directory -- so Go and web changes can be iterated on with fast rebuild-and-restart, with zero possibility of touching the production serve/sessiond pair (PIDs 58493/58494, port 8311, default `$TMPDIR/muxterm-501/` socket dir).

## Background

This repo checkout is a worktree (`chore/rapid-dev-workflow`) separate from the clone that produces the currently-running "production" muxterm instance on this Mac -- a native macOS companion app build at `/Users/ken/workspace/ms/muxterm/bin/muxterm`, running as `serve --no-auth --addr 127.0.0.1:8311` (PID 58493) with its `sessiond` (PID 58494). Because no `XDG_RUNTIME_DIR` is set system-wide, that production sessiond's socket, log, and `server.url` live at the default path `$TMPDIR/muxterm-501/`.

The existing `make dev` target (and its `.air.toml` / `Caddyfile`) exists to expose a dev build through Caddy on a remote VM (ampbox.io) and is unsuitable for same-machine iteration -- it adds a reverse-proxy hop that contributes nothing when working locally, and reusing it directly risks colliding with the always-on production instance if isolation isn't airtight.

This design introduces a second, independent workflow purpose-built for iterating on this Mac, engineered so that under no combination of normal operation, crash, or Ctrl-C can it read, write, signal, or otherwise interfere with the production instance.

## Non-Goals

- No Caddy, no demo/backend, no demo/frontend -- those exist solely for the ampbox.io remote-VM exposure story (the existing `make dev` target, `.air.toml`, and `Caddyfile`) and add nothing to a same-machine loop.
- No changes whatsoever to the existing `dev`, `demo`, `install-stable` Makefile targets, `.air.toml`, or `Caddyfile` -- they remain exactly as they are for the remote-VM use case.
- No changes to production's running processes, socket, log, or port -- never started, stopped, restarted, or signaled by anything here.
- No Vite HMR/dev-server proxy model (considered and explicitly deferred) -- prod-parity single-origin serving only (`vite build --watch` + air rebuild/restart, matching the existing proven pattern, at the cost of a ~1-2s full restart per frontend change instead of instant HMR). Revisit only if frontend iteration speed becomes a real bottleneck later.

## Architecture / Process Topology & Isolation Guarantees

Two fully independent process pairs run side by side on this Mac, with no shared state:

| | Production (untouched) | Dev-local (new) |
|---|---|---|
| serve binary | `/Users/ken/workspace/ms/muxterm/bin/muxterm` | `<worktree>/bin/muxterm-dev` |
| serve addr | `127.0.0.1:8311` (`--no-auth`) | `127.0.0.1:8313` (`--no-auth`) |
| sessiond socket dir | `$TMPDIR/muxterm-501/` (default, no `XDG_RUNTIME_DIR`) | `${TMPDIR:-/tmp}/muxterm-dev-local/muxterm/` (`XDG_RUNTIME_DIR` set) |
| PIDs | 58493 (serve), 58494 (sessiond) -- pre-existing, never signaled | New PIDs spawned fresh each `make dev-local` run, owned by air |
| Lifecycle owner | Whatever started it originally (outside this session's control) | air, foreground in your terminal; Ctrl-C stops it |

Isolation is enforced by three independent, non-overlapping axes simultaneously:

1. **Different binary path** -- `bin/muxterm-dev` is a separate compiled artifact from production's binary in a completely different repo checkout. No file overlap even if paths were guessed.
2. **Different port** -- 8313 vs production's 8311, and also distinct from 8312 (which belongs exclusively to the remote-VM `.air.toml`/`make dev` config). Even if socket-dir isolation somehow failed, two serve processes can't bind the same port -- loud bind-error, not silent interference.
3. **Different sessiond socket dir** -- `XDG_RUNTIME_DIR` redirects the dev instance's `sessiond.sock`, `sessiond.log`, and `server.url` into `${TMPDIR:-/tmp}/muxterm-dev-local/` -- a directory that production's `socketDir()` (no env var set) will never resolve to.

**Correction (post-Task-3-verification):** the original implementation pointed `XDG_RUNTIME_DIR` at a worktree-local path, `<worktree>/tmp/muxterm-dev-runtime/`. On this machine that path, once joined with `muxterm/sessiond.sock`, exceeded macOS's 104-byte `sockaddr_un` limit, so sessiond failed to bind (`bind: invalid argument`) in a retry loop and no terminal pane could ever connect -- the isolation axis was structurally sound but the path was unusable in practice. The fix moves the runtime dir to `${TMPDIR:-/tmp}/muxterm-dev-local/` -- short, fixed, and independent of the worktree checkout path length, while remaining clearly distinct from production's default `$TMPDIR/muxterm-<uid>/` socket dir (no collision possible). All references to `tmp/muxterm-dev-runtime/` below reflect the original (buggy) design and have been updated to the corrected path.

Because `EnsureDaemon()` in `internal/sessiond/spawn.go` auto-spawns sessiond the first time serve dials its socket and finds nothing there, we never manually start/manage a second sessiond process -- setting `XDG_RUNTIME_DIR` before running `muxterm-dev serve` is sufficient for the whole isolated pair to come up together. air restarting the binary on rebuild reuses the same already-running sessiond (fast iteration -- only serve restarts, not the PTY-holding daemon).

## Components

### `make dev-local` Makefile target

Following the exact inline-bash-with-trap convention already used by the existing `dev`/`demo` targets:

```makefile
dev-local:
	@mkdir -p tmp
	@export XDG_RUNTIME_DIR="$${TMPDIR:-/tmp}"; \
	XDG_RUNTIME_DIR="$${XDG_RUNTIME_DIR%/}/muxterm-dev-local"; \
	export XDG_RUNTIME_DIR; \
	mkdir -p "$$XDG_RUNTIME_DIR"; \
	cd $(WEB_SRC) && npx vite build --watch > ../tmp/dev-local-vite.out 2>&1 & VITE_PID=$$!; \
	trap 'kill $$VITE_PID 2>/dev/null || true' EXIT INT TERM; \
	echo "dev-local stack:"; \
	echo "  muxterm-dev   http://127.0.0.1:8313  (air hot-reload)"; \
	echo "  vite watch    logging to tmp/dev-local-vite.out"; \
	echo "  runtime dir   $$XDG_RUNTIME_DIR  (isolated sessiond socket/log)"; \
	echo "  production    127.0.0.1:8311 -- untouched"; \
	$(AIR) -c .air.local.toml
```

Key points:

- `XDG_RUNTIME_DIR` is exported into the shell launching both `vite build --watch` and air, inherited by the `muxterm-dev` serve process air spawns -- the single lever redirecting sessiond's socket/log/`server.url`.
- air runs in the foreground (the "main" process to watch/Ctrl-C). `vite build --watch` runs backgrounded with output to a log file (matches existing `dev`/`demo` pattern exactly).
- The trap only ever kills `$VITE_PID` -- a PID captured by this shell instance. It cannot reach production's PIDs (58493/58494) under any circumstance; no shared PID namespace, no PID file lookup, no "kill anything matching muxterm" pattern anywhere.
- air owns the lifecycle of the `bin/muxterm-dev` binary it launches (rebuild kills-and-restarts only that child process it spawned) -- same mechanism the existing `dev` target already relies on safely.
- First run auto-creates `${TMPDIR:-/tmp}/muxterm-dev-local/`, an OS-temp-based directory outside the repo entirely -- no gitignore entry needed for it. `bin/` is already gitignored.
- Reuses `$(AIR)` (existing tool-location fallback variable) but does NOT reference `$(CADDY)` at all.
- Must NOT modify the existing `dev`, `demo`, `demo-install`, `install-stable`, `build`, `web`, `test`, `test-web`, `clean` targets in any way.
- The `.PHONY` line at the top of the Makefile must be updated to include `dev-local` alongside the existing targets.

### `.air.local.toml` (new file, forked from `.air.toml`)

```toml
# air config for muxterm LOCAL dev mode (this Mac only).
# Fully decoupled from .air.toml (ampbox.io remote-VM dev config) -- edits to
# one MUST NOT be assumed to apply to the other.
#
# Isolation: XDG_RUNTIME_DIR must be set (by `make dev-local`) before invoking
# air, so the sessiond this spawns uses ${TMPDIR:-/tmp}/muxterm-dev-local/
# instead of the default $TMPDIR/muxterm-<uid>/ where the native companion
# app's production sessiond lives. Never run this without that env var set.
#
# Port 8313 -- distinct from both production (8311) and the remote-VM dev
# config's 8312.

root = "."
tmp_dir = "tmp"

[build]
  bin = "./bin/muxterm-dev"
  args_bin = ["serve", "--addr", "127.0.0.1:8313", "--no-auth"]
  cmd = "go build -o ./bin/muxterm-dev ./cmd/muxterm"
  delay = 200
  stop_on_error = false

  include_dir = ["cmd", "internal", "web/dist"]
  include_ext = ["go", "stamp"]
  exclude_dir = ["tmp", "vendor", "testdata", "web/src", "web/node_modules"]
  exclude_regex = ["_test\\.go$"]

[color]
  build = "yellow"
  runner = "green"
  watcher = "cyan"
  main = "magenta"
  app = ""

[log]
  time = false

[screen]
  clear_on_rebuild = false
  keep_scroll = true
```

Notably unchanged from `.air.toml`: the `include_dir`/`include_ext`/`exclude_*` watch rules, the "stamp" trigger convention (Vite's `build.stamp` plugin in `web/vite.config.ts` already fires one rebuild per full Vite output flush, no changes needed there), `delay`, and colors. Only `bin`, `args_bin`, and `cmd` differ.

`.air.local.toml` should be git-tracked (committed to the repo), the same as the existing `.air.toml` -- not gitignored -- since it's a reusable dev config, not a runtime artifact.

## Data Flow

Typical iteration cycle:

1. Developer runs `make dev-local`.
2. Makefile creates `${TMPDIR:-/tmp}/muxterm-dev-local/`, exports `XDG_RUNTIME_DIR`, backgrounds `vite build --watch` (writes to `web/dist/`, touches `build.stamp` on full flush), starts `air -c .air.local.toml` in foreground.
3. air's first build: `go build -o ./bin/muxterm-dev ./cmd/muxterm`, then runs `./bin/muxterm-dev serve --addr 127.0.0.1:8313 --no-auth` with `XDG_RUNTIME_DIR` inherited from the shell.
4. On serve startup, `EnsureDaemon()` dials `${TMPDIR:-/tmp}/muxterm-dev-local/muxterm/sessiond.sock`, finds nothing, spawns a detached sessiond logging to `${TMPDIR:-/tmp}/muxterm-dev-local/muxterm/sessiond.log`, waits until it's reachable.
5. Developer edits Go code -> air detects `.go` change -> rebuilds `bin/muxterm-dev` -> kills/restarts just that child process -> reconnects to the SAME already-running dev sessiond (fast; PTYs in the dev sessiond survive the serve restart).
6. Developer edits `web/src` -> Vite watch rebuilds `web/dist`, writes `build.stamp` -> air detects the `.stamp` change (via `include_ext`) -> rebuilds/restarts `bin/muxterm-dev` (which re-embeds `web/dist` via `go:embed`) -> browser reload shows the change.
7. Developer hits Ctrl-C on the foreground air process -> trap kills the backgrounded Vite watcher -> air's own signal handling tears down the `bin/muxterm-dev` child it was supervising. The dev sessiond (spawned detached via `Setsid`, per `spawn.go`'s `SpawnCommand`) may persist after Ctrl-C -- this is expected/harmless, and can be cleaned up by deleting `${TMPDIR:-/tmp}/muxterm-dev-local/` if ever desired.

Throughout this entire cycle, production's PIDs 58493/58494, its port 8311, and `$TMPDIR/muxterm-501/` are never referenced, dialed, signaled, or read/written by any of the above.

## Error Handling & Edge Cases

- **Port 8313 already in use** (e.g. a previous `air -c .air.local.toml` didn't shut down cleanly): serve fails to bind, exits with a clear Go error; air logs it and retries on next file change. No fallback port, no silent reuse of 8311 or 8312.
- **Stale dev sessiond from a previous session:** handled generically by the existing, unmodified `EnsureDaemon()` (dials the socket, removes stale socket file if dead, spawns fresh) -- operates only within `${TMPDIR:-/tmp}/muxterm-dev-local/`, never near production's socket dir.
- **Missing air:** `$(AIR)` Makefile variable already falls back to `$(HOME)/go/bin/air` (confirmed installed on this machine). No `$(CADDY)` dependency in `dev-local` at all, so a missing/broken Caddy install (irrelevant here) can never block it.
- **Vite watch crashes/exits early:** air keeps running independently (it only reacts to `web/dist`'s `build.stamp` file, doesn't supervise the Vite process); stale frontend assets would be noticeable, check `tmp/dev-local-vite.out` for the Vite error, re-run `make dev-local`.
- **Ctrl-C mid-rebuild:** trap fires on `EXIT|INT|TERM`, killing the backgrounded Vite watcher; air (foreground) receives the signal directly from the terminal and performs its own shutdown of the `bin/muxterm-dev` child it's currently supervising. No orphaned Go process should remain.
- **Concurrent `make dev` (remote-VM flow) + `make dev-local` (this Mac flow) running simultaneously:** conflict-free -- 8311 (prod) / 8312 (remote-VM dev via `make dev`) / 8313 (this Mac's `dev-local`) never overlap, each uses its own `.air*.toml` and isolated runtime dir.

## Verification / Testing Strategy

Per `AGENTS.md`'s muxterm-verify convention -- no unit tests, real observed behavior only:

Steps 1 and 6 (the production pre-flight and the isolation re-check) are manual, human-observed checks -- there is no automated guard rail enforcing production isolation in the code itself; isolation is structural (separate binary/port/socket-dir), not runtime-enforced by a safety check.

1. **Pre-flight sanity check** -- confirm production is currently healthy before touching anything: `lsof -i :8311` shows PID 58493, `ls $TMPDIR/muxterm-501/` shows the existing socket/log untouched, and (if reachable) production's own UI still responds.
2. **Build** -- `make dev-local` (first run compiles `bin/muxterm-dev` via air, builds `web/dist` via Vite).
3. **Observe startup** -- confirm the printed banner shows `127.0.0.1:8313`, confirm `${TMPDIR:-/tmp}/muxterm-dev-local/muxterm/sessiond.sock` gets created (not `$TMPDIR/muxterm-501/*`), confirm a new PID appears for `bin/muxterm-dev` distinct from 58493/58494.
4. **Real browser check** -- `playwright-cli open http://127.0.0.1:8313`, snapshot, open a terminal pane, type something, see it echo -- proving the dev instance is a fully working, independent muxterm, not just "a process that started."
5. **Hot-reload check** -- make a trivial Go change (e.g. a log line) and a trivial web change (e.g. a label), confirm air rebuilds/restarts `bin/muxterm-dev` and Vite's watch rebuilds `web/dist`, and the browser reflects both after reload.
6. **Isolation re-check (the critical one)** -- while the dev instance is running, re-verify production is still untouched: same PIDs 58493/58494 still alive, `$TMPDIR/muxterm-501/sessiond.log` unchanged/still growing normally on its own, port 8311 still serving, and (if there's any real terminal session open in the production UI) that session is still alive and responsive throughout.
7. **Teardown check** -- Ctrl-C the `make dev-local` foreground process, confirm the Vite watcher and air-owned `bin/muxterm-dev` both exit, confirm the dev sessiond is left running detached (expected, matches existing `SpawnCommand`/`Setsid` semantics), noting a stray dev-only sessiond may persist in `${TMPDIR:-/tmp}/muxterm-dev-local/` after Ctrl-C -- harmless, cleaned up by deleting that directory if ever desired.

## Open Questions

None -- all sections were validated and approved by the user, including one correction (port changed from an initial 8312 draft to 8313 to avoid overlap with the pre-existing remote-VM `.air.toml`/`make dev` config, which owns 8312).
