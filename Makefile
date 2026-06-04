.PHONY: build dev test clean web

# Path to the web source (relative to this Makefile)
WEB_SRC := ./web

# Tool locations — fall back to GOPATH/bin when they're not on PATH.
AIR   := $(shell command -v air   2>/dev/null || echo $(HOME)/go/bin/air)
CADDY := $(shell command -v caddy 2>/dev/null || echo $(HOME)/go/bin/caddy)

# Build the frontend and copy dist into the Go embed directory, then build Go binary.
build: web
	go build -o bin/muxterm ./cmd/muxterm

# Dev mode: Vite watch (frontend) + in-instance Caddy + air (Go hot-reload).
#   - Vite rebuilds web/dist on frontend changes
#   - air detects web/dist + Go changes and rebuilds/restarts muxterm on
#     127.0.0.1:9090 (loopback — serve args set in .air.toml)
#   - in-instance Caddy listens on the instance IP :8090 and proxies to the app,
#     so muxterm sees a loopback peer (auth-bypass) and the host Caddy can reach it
# Exposed by the HOST Caddy at https://muxterm.ampbox.io (see /mnt/services/muxterm.caddy)
# Ctrl-C stops all three. Requires: air + caddy.
dev:
	@mkdir -p tmp
	@cd $(WEB_SRC) && npx vite build --watch >/dev/null & VITE_PID=$$!; \
	$(CADDY) run --config ./Caddyfile > tmp/caddy.out 2>&1 & CADDY_PID=$$!; \
	trap 'kill $$VITE_PID $$CADDY_PID 2>/dev/null || true' EXIT INT TERM; \
	echo "dev stack: muxterm -> 127.0.0.1:9090 | instance Caddy -> 10.66.204.209:8090 | host -> https://muxterm.ampbox.io"; \
	$(AIR)

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
