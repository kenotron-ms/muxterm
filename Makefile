.PHONY: build dev install-stable test clean web

# Path to the web source (relative to this Makefile)
WEB_SRC := ./web

# Stable production binary location (used by systemd, never overwritten by dev builds).
STABLE_BIN := $(HOME)/.local/bin/muxterm

# Tool locations — fall back to GOPATH/bin when they're not on PATH.
AIR   := $(shell command -v air   2>/dev/null || echo $(HOME)/go/bin/air)
CADDY := $(shell command -v caddy 2>/dev/null || echo $(HOME)/go/bin/caddy)

# Build the frontend and copy dist into the Go embed directory, then build Go binary.
build: web
	go build -o bin/muxterm ./cmd/muxterm

# Dev mode: Vite watch (frontend) + in-instance Caddy + air (Go hot-reload).
#   - Vite rebuilds web/dist on frontend changes
#   - air detects web/dist + Go changes and rebuilds/restarts muxterm DEV on
#     127.0.0.1:9091 (loopback — serve args set in .air.toml)
#   - in-instance Caddy listens on the instance IP :8091 and proxies to the app,
#     so muxterm sees a loopback peer (auth-bypass) and the host Caddy can reach it
#   - Production (systemd) runs separately on :9090 from ~/.local/bin/muxterm — undisturbed.
# Exposed by the HOST Caddy at https://muxterm-dev.ampbox.io (see /mnt/services/muxterm-dev.caddy)
# Ctrl-C stops all three. Requires: air + caddy.
dev:
	@mkdir -p tmp
	@cd $(WEB_SRC) && npx vite build --watch >/dev/null & VITE_PID=$$!; \
	$(CADDY) run --config ./Caddyfile > tmp/caddy.out 2>&1 & CADDY_PID=$$!; \
	trap 'kill $$VITE_PID $$CADDY_PID 2>/dev/null || true' EXIT INT TERM; \
	echo "dev stack: muxterm -> 127.0.0.1:9091 | instance Caddy -> 10.66.204.209:8091 | host -> https://muxterm-dev.ampbox.io"; \
	$(AIR)

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
