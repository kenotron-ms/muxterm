.PHONY: build dev demo demo-install install-stable test clean web

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

# Dev mode: demo backend + demo frontend + Vite watch (muxterm UI) + Caddy + air (Go hot-reload).
#   - demo/backend  node server.mjs on :9002  (log: tmp/demo-backend.out)
#   - demo/frontend Vite build+preview on :5173  (log: tmp/demo-frontend.out)
#   - Vite rebuilds web/dist on muxterm frontend changes
#   - air detects web/dist + Go changes and rebuilds/restarts muxterm DEV on
#     127.0.0.1:9091 (loopback — serve args set in .air.toml)
#   - in-instance Caddy listens on the instance IP :8091 and proxies to the app,
#     so muxterm sees a loopback peer (auth-bypass) and the host Caddy can reach it
#   - Production (systemd) runs separately on :9090 from ~/.local/bin/muxterm — undisturbed.
# First run: `make demo-install` to install demo npm deps.
# Exposed by the HOST Caddy at https://muxterm-dev.ampbox.io (see /mnt/services/muxterm-dev.caddy)
# Ctrl-C stops all processes. Requires: air + caddy.
dev:
	@mkdir -p tmp
	@(cd demo/backend  && exec node server.mjs)                                                 > tmp/demo-backend.out  2>&1 & DEMO_BACKEND_PID=$$!; \
	(cd demo/frontend && ./node_modules/.bin/vite build --minify false && exec ./node_modules/.bin/vite preview) > tmp/demo-frontend.out 2>&1 & DEMO_FRONTEND_PID=$$!; \
	cd $(WEB_SRC) && npx vite build --watch >/dev/null & VITE_PID=$$!; \
	$(CADDY) run --config ./Caddyfile > tmp/caddy.out 2>&1 & CADDY_PID=$$!; \
	trap 'kill $$DEMO_BACKEND_PID $$DEMO_FRONTEND_PID $$VITE_PID $$CADDY_PID 2>/dev/null || true' EXIT INT TERM; \
	echo "dev stack:"; \
	echo "  muxterm       http://127.0.0.1:9091  (air hot-reload)"; \
	echo "  demo backend  http://localhost:9002   (log: tmp/demo-backend.out)"; \
	echo "  demo frontend http://localhost:5173   (log: tmp/demo-frontend.out)"; \
	$(AIR)

# Install demo npm dependencies (run once, or after package.json changes).
demo-install:
	cd demo/backend  && npm install
	cd demo/frontend && npm install

# Start demo services only — assumes muxterm is already running at :9091.
# Ctrl-C stops both. Requires: demo-install run at least once.
demo:
	@mkdir -p tmp
	@(cd demo/backend  && exec node server.mjs)                                                 > tmp/demo-backend.out  2>&1 & DEMO_BACKEND_PID=$$!; \
	(cd demo/frontend && ./node_modules/.bin/vite build --minify false && exec ./node_modules/.bin/vite preview) > tmp/demo-frontend.out 2>&1 & DEMO_FRONTEND_PID=$$!; \
	trap 'kill $$DEMO_BACKEND_PID $$DEMO_FRONTEND_PID 2>/dev/null || true' EXIT INT TERM; \
	echo "demo backend  http://localhost:9002   (log: tmp/demo-backend.out)"; \
	echo "demo frontend http://localhost:5173   (log: tmp/demo-frontend.out)"; \
	wait

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
