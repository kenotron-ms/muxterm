.PHONY: build test clean web

# Path to the web source (relative to this Makefile)
WEB_SRC := ../web

# Build the frontend and copy dist into the Go embed directory, then build Go binary.
build: web
	go build -o bin/muxterm ./cmd/muxterm

# Build the frontend only: install npm deps, run tsc + vite build, copy output.
web:
	cd $(WEB_SRC) && npm install && npm run build
	rm -rf web/dist
	cp -r $(WEB_SRC)/dist web/dist

test:
	go test -v ./...

# Run frontend tests separately.
test-web:
	cd $(WEB_SRC) && npm test

clean:
	rm -rf bin/ web/dist
