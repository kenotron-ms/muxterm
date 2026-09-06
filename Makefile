.PHONY: build dev dev-local install-stable test clean web

# Path to the web source (relative to this Makefile)
WEB_SRC := ./web

# Stable production binary location (used by systemd, never overwritten by dev builds).
STABLE_BIN := $(HOME)/.local/bin/muxterm

# Tool locations — fall back to GOPATH/bin when they're not on PATH.
AIR   := $(shell command -v air   2>/dev/null || echo $(HOME)/go/bin/air)
CADDY := $(shell command -v caddy 2>/dev/null || echo $(HOME)/go/bin/caddy)

# Version stamped into cmd/muxterm's `version` var (see .goreleaser.yaml for
# the tagged-release equivalent). git describe with --always/--dirty so a
# build from a non-tag commit (the common dev case) still identifies itself
# instead of silently falling back to main.go's "dev" default.
DEV_VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

# Build the frontend and copy dist into the Go embed directory, then build Go binary.
build: web
	go build -ldflags "-X main.version=$(DEV_VERSION)" -o bin/muxterm ./cmd/muxterm

# Dev mode: Vite watch (muxterm UI) + Caddy + air (Go hot-reload).
#   - Vite rebuilds web/dist on muxterm frontend changes
#   - air detects web/dist + Go changes and rebuilds/restarts muxterm DEV on
#     127.0.0.1:9091 (loopback — serve args set in .air.toml)
#   - in-instance Caddy listens on the instance IP :8091 and proxies to the app,
#     so muxterm sees a loopback peer (auth-bypass) and the host Caddy can reach it
#   - Production (systemd) runs separately on :9090 from ~/.local/bin/muxterm — undisturbed.
# Exposed by the HOST Caddy at https://muxterm-dev.ampbox.io (see /mnt/services/muxterm-dev.caddy)
# Ctrl-C stops all processes. Requires: air + caddy.
dev:
	@mkdir -p tmp
	@cd $(WEB_SRC) && npx vite build --watch >/dev/null & VITE_PID=$$!; \
	$(CADDY) run --config ./Caddyfile > tmp/caddy.out 2>&1 & CADDY_PID=$$!; \
	trap 'kill $$VITE_PID $$CADDY_PID 2>/dev/null || true' EXIT INT TERM; \
	echo "dev stack:"; \
	echo "  muxterm       http://127.0.0.1:9091  (air hot-reload)"; \
	echo "  caddy         http://0.0.0.0:8091     (log: tmp/caddy.out)"; \
	$(AIR)

# Dev-local mode: fully isolated second muxterm instance on THIS Mac only.
#   - own binary   bin/muxterm-dev (air-managed, rebuilds on Go/web changes)
#   - own port     127.0.0.1:8313  (distinct from prod 8311 and remote-VM dev 8312)
#   - own runtime  ${TMPDIR:-/tmp}/muxterm-dev-local/ (XDG_RUNTIME_DIR override) --
#     sessiond socket/log/server.url all live here instead of the default
#     $TMPDIR/muxterm-<uid>/ where production's sessiond lives.
#   - own data     ${TMPDIR:-/tmp}/muxterm-dev-local/data/ (XDG_DATA_HOME override).
#     REQUIRED, not cosmetic: snapshotDir() (internal/sessiond/snapshot.go:126)
#     resolves the crash-restore snapshot from $XDG_DATA_HOME, falling back to
#     $HOME/.local/share/muxterm. Overriding only XDG_RUNTIME_DIR leaves that
#     fallback in force, so a dev sessiond RESTORES PRODUCTION'S WORKSPACES at
#     boot and OVERWRITES production's restore-snapshot.json periodically and on
#     shutdown -- silently corrupting what production would restore after a
#     crash. Both vars must be overridden together for the isolation claim below
#     to hold.
#     With both set, production is never dialed, signaled, or read/written by
#     this target under any circumstance.
#   - INVOCATION_ID is unset. EnsureDaemon refuses to spawn a sessiond when it
#     is present (it means "systemd already supervises this"), which is correct
#     for the production unit and wrong here. Any shell inherited from the
#     production muxterm unit -- including an agent session running inside a
#     muxterm pane -- carries it, and without this unset `make dev-local` comes
#     up with a serve and no sessiond, so every browser connection fails to
#     attach.
#     A short, fixed, OS-temp-based path is used instead of a worktree-local path
#     (e.g. tmp/muxterm-dev-runtime) because a worktree-local path can push the
#     resulting sessiond.sock path over macOS's 104-byte sockaddr_un limit,
#     causing sessiond to fail to bind.
#   - No Caddy -- this is a same-machine loop only.
# Ctrl-C stops the Vite watcher and air (which tears down its bin/muxterm-dev
# child in turn). Previously the trap only killed the Vite watcher and relied
# on the terminal delivering SIGINT to air directly; in practice air (and
# therefore its supervised bin/muxterm-dev serve process) could survive that,
# leaving an orphaned server bound to :8313 for the next `make dev-local` to
# collide with. The trap now explicitly signals air's own PID too, so both
# exit deterministically regardless of how the signal reaches this script.
# The detached dev sessiond is intentionally NOT killed here -- see the
# runtime dir note above; that persistence is by design (Setsid'd terminal
# sessions must survive a `make dev-local` restart), not a bug. Clean it up
# by deleting $${TMPDIR:-/tmp}/muxterm-dev-local/ if ever desired.
# Requires: air (falls back to $(HOME)/go/bin/air if not on PATH).
dev-local:
	@mkdir -p tmp
	@unset INVOCATION_ID; \
	export XDG_RUNTIME_DIR="$${TMPDIR:-/tmp}"; \
	XDG_RUNTIME_DIR="$${XDG_RUNTIME_DIR%/}/muxterm-dev-local"; \
	export XDG_RUNTIME_DIR; \
	XDG_DATA_HOME="$$XDG_RUNTIME_DIR/data"; \
	export XDG_DATA_HOME; \
	mkdir -p "$$XDG_RUNTIME_DIR" "$$XDG_DATA_HOME"; \
	cd $(WEB_SRC) && npx vite build --watch > ../tmp/dev-local-vite.out 2>&1 & VITE_PID=$$!; \
	$(AIR) -c .air.local.toml & AIR_PID=$$!; \
	kill_tree() { \
		for child in $$(pgrep -P "$$1" 2>/dev/null); do kill_tree "$$child"; done; \
		kill -TERM "$$1" 2>/dev/null; \
	}; \
	trap 'kill_tree $$VITE_PID; kill -INT $$AIR_PID 2>/dev/null; wait $$AIR_PID 2>/dev/null; exit 0' EXIT INT TERM; \
	echo "dev-local stack:"; \
	echo "  muxterm-dev   http://127.0.0.1:8313  (air hot-reload)"; \
	echo "  vite watch    logging to tmp/dev-local-vite.out"; \
	echo "  runtime dir   $$XDG_RUNTIME_DIR  (isolated sessiond socket/log)"; \
	echo "  data dir      $$XDG_DATA_HOME  (isolated crash-restore snapshot)"; \
	echo "  production    127.0.0.1:8311 -- untouched"; \
	wait $$AIR_PID

# Build the production binary from origin/main and install to the stable path.
# This is what systemd runs — separate from ./bin/muxterm used by `make dev`.
# Usage: git pull && make install-stable
#        systemctl --user restart muxterm muxterm-sessiond
install-stable: web
	@if ! git diff --quiet || ! git diff --cached --quiet; then \
		echo "error: working tree is dirty — commit or stash changes before installing stable"; \
		exit 1; \
	fi
	@echo "Building stable binary from $$(git rev-parse --short HEAD) ($(shell git log -1 --format='%s'))..."
	go build -o $(STABLE_BIN) ./cmd/muxterm
	@echo "Installed: $(STABLE_BIN)"
	@echo "Restart services: systemctl --user restart muxterm muxterm-sessiond"

# Build the frontend only: install npm deps, run tsc + vite build, copy output.
web:
	cd $(WEB_SRC) && npm install && npm run build

test:
	go test -v ./...

# Run frontend tests separately.
test-web:
	cd $(WEB_SRC) && npm test

clean:
	rm -rf bin/ web/dist
