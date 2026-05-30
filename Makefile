.PHONY: build dev test clean web

# Path to the web source (relative to this Makefile)
WEB_SRC := ./web

# Build the frontend and copy dist into the Go embed directory, then build Go binary.
build: web
	go build -o bin/muxterm ./cmd/muxterm

# Dev mode: run Vite in watch mode (background) + air for Go hot-reload (foreground).
# Vite rebuilds web/dist on frontend changes; air detects web/dist changes and
# rebuilds + restarts the Go server automatically.
# Requires: air (go install github.com/air-verse/air@latest)
dev:
	@cd $(WEB_SRC) && npx vite build --watch & \
	VITE_PID=$$!; \
	air; \
	kill "$$VITE_PID" 2>/dev/null || true

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
