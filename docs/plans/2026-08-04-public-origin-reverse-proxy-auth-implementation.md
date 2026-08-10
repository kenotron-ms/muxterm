# Phase 3: `public_origin` / `behind_reverse_proxy` Wiring — Implementation Plan

> **For execution:** Use `/build-like-ken` mode.

**Goal:** Make muxterm's OAuth redirect URI and loopback-bypass decision derive from an explicit, operator-configured public origin when running behind a reverse proxy, so a remote browser completes login against the real external hostname instead of being redirected to an unreachable `127.0.0.1:<port>` URL.

**Architecture:** Two new opt-in config fields (`public_origin`, `behind_reverse_proxy`) are added to `internal/config`'s existing TOML struct, with serve-mode CLI flag overrides. `cmd/muxterm/main.go` gains a single `publicBaseURL(addr, serverConfig)` derivation seam that every public-facing absolute URL muxterm constructs must flow through; today that is the `muxterm-web` redirect URI, and it is the designated source for the RFC 8414 / RFC 9728 metadata documents when Phase 2 adds them. `internal/server/authmiddleware.go`'s `IsLocalhost()` bypass is gated off entirely when `behind_reverse_proxy` is true, which is the load-bearing security control — a reverse proxy's own hop is indistinguishable from a genuinely local caller, so the bypass would otherwise silently admit remote traffic. Startup fails closed when `behind_reverse_proxy` is set without a usable `public_origin`.

**Tech Stack:** Go 1.24.4, module `github.com/kenotron-ms/muxterm`; `github.com/BurntSushi/toml` for config; `github.com/go-oauth2/oauth2/v4` for the OAuth server; Incus-backed Digital Twin Universe + Caddy for end-to-end verification.

**Verification approach:** Every task is gated by `go build ./...`, `go vet ./...`, and `gofmt -l` scoped to the touched packages. Feature-level proof is a single Digital Twin Universe environment running a real Caddy reverse proxy in front of a real muxterm binary, exercised over real HTTP, covering the approved design's Testing Strategy checks (a)–(f). No unit tests are written; the existing checked-in test suite is run only as a regression gate.

## Global Constraints

Copied verbatim from the approved (amended) design `docs/plans/2026-08-04-public-origin-reverse-proxy-auth-design.md` and this repo's `AGENTS.md`. Every task's requirements implicitly include this section.

- **No new design decisions.** "This document makes **no new design decisions**. Every choice here (opt-in flags, no header-trust, exact-match redirect URI, bind-address invariant, fail-closed validation) was already decided in the 2026-08-02 doc." Implementation may not add scope beyond the approved design.
- **Both new fields are explicit and opt-in.** "`public_origin string` — e.g. `"https://muxterm.ampbox.io"`. The canonical public HTTPS origin at which muxterm is reachable through the reverse proxy. Empty by default." and "`behind_reverse_proxy bool` — opt-in, default `false`."
- **Never trust headers.** "Per the parent doc, these are never derived from request headers (`X-Forwarded-Host`, `X-Forwarded-Proto`, or anything else) — headers are spoofable and the parent doc already rejected trusting them for any trust-relevant value."
- **Redirect URI when behind a proxy is exact and static.** "When `behind_reverse_proxy` is `true`: the `muxterm-web` redirect URI becomes exactly `<public_origin>/auth/callback` — a fully exact match, no variable component, computed once at startup from static config (not per-request...)."
- **Default mode is byte-for-byte unchanged.** "When `behind_reverse_proxy` is `false` (default): behavior is **unchanged** — the existing loopback derivation from `cfg.Addr` (normalizing `0.0.0.0`/unparseable host to `127.0.0.1`) continues exactly as today."
- **`validateRedirectURI` gets no code change.** "`internal/authserver/clientstore.go`'s `validateRedirectURI` needs **no code change** — it already performs a plain string equality check against whatever `WebRedirectURI` value it's handed. Only the value fed into it (via `Config.WebRedirectURI` at construction) changes based on the new flags."
- **Loopback bypass is disabled unconditionally when behind a proxy.** "`behind_reverse_proxy == true`: the bypass is **disabled entirely**, unconditionally. All traffic — including Caddy's own loopback hop to muxterm — must authenticate through the real OAuth flow (session cookie or bearer token). This is a static, config-gated switch — not auto-detected, not based on any forwarded header."
- **TOPOLOGY-AWARE BIND-ADDRESS CORRECTION (post-incident amendment; overrides the design's own Architecture table rows for `internal/service/service.go` and `internal/deploy/ssh.go`).** "**This design does NOT change `serve` mode's default bind address.** It remains `0.0.0.0` as it is today, in `internal/service/service.go` and `internal/deploy/ssh.go` — those files are **out of scope** for this design (reverting the prior draft's plan to narrow them to `127.0.0.1`). The security property this design actually needs — no unauthenticated access to non-loopback traffic — is fully provided by point 3's `behind_reverse_proxy`-gated bypass removal, independent of bind address." No task in this plan may modify `internal/service/service.go` or `internal/deploy/ssh.go`, and no task may modify `cmd/muxterm/cli_test.go`, `internal/service/service_test.go`, or `internal/deploy/ssh_test.go` (their `0.0.0.0` assertions remain correct because the default is unchanged).
- **Fail-closed startup validation.** "At startup, if `behind_reverse_proxy` is `true` and `public_origin` is empty/unset, muxterm **must refuse to start** with a clear error — not silently fall back to loopback-derived URLs."
- **`public_origin` in direct mode is ignored, not an error.** "**`behind_reverse_proxy: false` (default), any value of `public_origin`:** `public_origin` is ignored entirely in this mode (not an error)."
- **Out of scope, do not touch:** the production Caddy config at `/mnt/services/muxterm.caddy` (outside this repo) and the repo-root dev `Caddyfile` used by `make dev` — "The checked-in dev Caddyfile at the repo root (used by `make dev`) is **not** changed."
- **NO UNIT TESTS (repo `AGENTS.md`).** "Unit tests are banned in this project. Do not write them. Do not ask if you should write them. Do not write them 'just for the pure logic'." No new `*_test.go` file may be created, and no new test function may be added to an existing `*_test.go` file. Existing test files are run only as a regression gate: "There are existing `*_test.go` ... files in the repo. Do not delete them (too disruptive), but do not add new ones."
- **Verification is real end-to-end only.** Per `AGENTS.md`: "Every feature or fix must be verified by actually running muxterm and observing the behavior in a real browser." Per the design's Testing Strategy: "delegate to `digital-twin-universe:dtu-profile-builder` to stand up a muxterm instance with a fronting reverse proxy mimicking the real Caddy topology."
- **Static gate before every commit:** `go build ./...` must compile clean, `go vet ./...` must be clean, and `gofmt -l` must be empty **for the packages this plan touches** (`./cmd ./internal/config ./internal/server ./internal/authserver`). A repo-wide `gofmt -l .` is NOT clean at baseline — `internal/sessiond` has six pre-existing unformatted files (`layout_test.go`, `registry.go`, `server.go`, `server_integration_test.go`, `stress_test.go`, `vt_test.go`). Do not reformat them; that is unrelated churn.
- **Verification fixture hygiene (repo `AGENTS.md`):** "Create a brand-new workspace (and therefore a brand-new pane) for every verification run" and "Check for stale sessiond processes from a different worktree before trusting a result."

**Baseline evidence captured before planning (2026-08-04, commit `a956c17`, working tree clean):**

```
$ go build ./... && echo BUILD_OK
BUILD_OK
$ go vet ./...            # no output, exit 0
$ gofmt -l ./cmd ./internal/config ./internal/server ./internal/authserver   # no output
$ go test ./cmd/... ./internal/config/... ./internal/server/... ./internal/authserver/...
ok   github.com/kenotron-ms/muxterm/cmd/muxterm            6.676s
ok   github.com/kenotron-ms/muxterm/internal/config        0.002s
ok   github.com/kenotron-ms/muxterm/internal/server        0.049s
?    github.com/kenotron-ms/muxterm/internal/authserver    [no test files]
?    github.com/kenotron-ms/muxterm/internal/authserver/loginbackend  [no test files]
```

---

## Phase 1: Configuration surface

### Task 1: Add `ServerConfig` fields and fail-closed validation to `internal/config`

**Description:** Add the `public_origin` and `behind_reverse_proxy` fields to muxterm's existing TOML config struct as a new `[server]` section, with a `Validate()` method implementing the design's fail-closed rule and a `BaseURL()` accessor that normalizes the origin for path concatenation.

**Goal:** `config.Config` carries a `Server ServerConfig` section loaded by the existing `config.Load` path, `ServerConfig.Validate()` returns a non-nil error exactly when `BehindReverseProxy` is true and `PublicOrigin` is missing or not a usable http/https origin, and `ServerConfig.BaseURL()` returns `PublicOrigin` with trailing slashes stripped.

**Specification:**
- Add `type ServerConfig struct` with `PublicOrigin string` (toml `public_origin`, json `public_origin`) and `BehindReverseProxy bool` (toml `behind_reverse_proxy`, json `behind_reverse_proxy`).
- Add `Server ServerConfig \`toml:"server" json:"server"\`` as a field on `Config`.
- Add `Server: ServerConfig{}` to `Defaults()` so the defaults are explicit and match the design's "Empty by default" / "default `false`".
- `Validate()` returns `nil` immediately when `BehindReverseProxy` is false — `PublicOrigin` is ignored in that mode, never an error.
- `Validate()` returns a non-nil error when `BehindReverseProxy` is true and `PublicOrigin` is empty, unparseable, has a scheme other than `http`/`https`, or has an empty host. Every message names the offending field and how to fix it.
- `BaseURL()` returns `strings.TrimRight(s.PublicOrigin, "/")`.
- Do NOT extend `Merge()`. `Merge` is the PATCH `/api/config` path used by the browser UI; a deployment-topology/security setting must not be mutable from a web request.

**Acceptance Criteria:**
- `go build ./...` compiles clean, `go vet ./...` clean, `gofmt -l ./internal/config` empty.
- A config file containing `[server]` / `public_origin = "https://x.example/"` / `behind_reverse_proxy = true` round-trips through `config.Load` into the struct, and `Validate()` on it returns `nil` while `BaseURL()` returns `"https://x.example"` — demonstrated by the direct-execution command below.
- `Validate()` on `ServerConfig{BehindReverseProxy: true}` returns a non-nil error mentioning `public_origin`.
- The existing `internal/config` test package still passes.

**Files:**
- Modify: `internal/config/config.go` (imports block lines 4–13; `Config` struct lines 16–23; new type after line 23; new methods after the new type; `Defaults()` return literal lines 137–172)

**Interfaces:**
- Consumes: nothing from earlier tasks (first task).
- Produces:
  - `config.ServerConfig` struct with exported fields `PublicOrigin string` and `BehindReverseProxy bool`.
  - `func (s ServerConfig) Validate() error` — nil when configuration is usable; non-nil (startup-fatal) otherwise.
  - `func (s ServerConfig) BaseURL() string` — `PublicOrigin` with trailing `/` trimmed; meaningful only when `BehindReverseProxy` is true.
  - `config.Config` gains field `Server ServerConfig` (TOML key `server`, JSON key `server`).

**Model Roles:**
- implementation_model_role: `coding`
- review_model_role: `critique`
- escalated_model_role: `reasoning`

**Implementation**

Replace the import block at `internal/config/config.go:4-13` with:

```go
import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)
```

Replace the `Config` struct at `internal/config/config.go:15-23` with:

```go
// Config is the top-level configuration for muxterm.
type Config struct {
	Theme     ThemeConfig     `toml:"theme"      json:"theme"`
	Font      FontConfig      `toml:"font"       json:"font"`
	Terminal  TerminalConfig  `toml:"terminal"   json:"terminal"`
	Keys      KeysConfig      `toml:"keys"       json:"keys"`
	Workspace WorkspaceConfig `toml:"workspace"  json:"workspace"`
	Driver    DriverConfig    `toml:"driver"     json:"driver"`
	Server    ServerConfig    `toml:"server"     json:"server"`
}

// ServerConfig holds deployment-topology settings that decide how muxterm
// derives its own public-facing URLs and whether the loopback auth bypass
// applies. Both fields are explicit and opt-in, and are NEVER derived from
// request headers (X-Forwarded-Host, X-Forwarded-Proto, or anything else):
// headers are spoofable, and the design rejects trusting them for any
// trust-relevant value.
//
// These fields are deliberately absent from Merge(), which backs the
// browser-facing PATCH /api/config route — a deployment-topology and
// security setting must not be mutable from a web request.
type ServerConfig struct {
	// PublicOrigin is the canonical public origin at which muxterm is
	// reachable through its fronting reverse proxy, e.g.
	// "https://muxterm.ampbox.io". Scheme and host (with optional port)
	// only — no path, no trailing slash. Empty by default. Ignored
	// entirely when BehindReverseProxy is false.
	PublicOrigin string `toml:"public_origin"        json:"public_origin"`
	// BehindReverseProxy opts muxterm into reverse-proxy mode: every
	// public-facing URL muxterm builds derives from PublicOrigin, and the
	// IsLocalhost() auth bypass is disabled entirely. Opt-in, default
	// false. The bypass must go, because the proxy's own hop to muxterm is
	// indistinguishable from a genuinely local caller at the RemoteAddr
	// level — honoring it would silently grant unauthenticated access to
	// genuinely remote traffic.
	BehindReverseProxy bool `toml:"behind_reverse_proxy" json:"behind_reverse_proxy"`
}

// Validate enforces the design's fail-closed startup rule:
// behind_reverse_proxy without a usable public_origin is a hard
// configuration error, never a silent fall back to a loopback-derived URL
// — that fallback would reproduce the exact "browser redirected to
// 127.0.0.1" bug this configuration exists to fix. Callers MUST refuse to
// start the HTTP listener on a non-nil error.
//
// When BehindReverseProxy is false, PublicOrigin is inapplicable and is
// ignored entirely — not an error.
func (s ServerConfig) Validate() error {
	if !s.BehindReverseProxy {
		return nil
	}
	if s.PublicOrigin == "" {
		return errors.New(`config: behind_reverse_proxy is set but public_origin is empty; set public_origin (e.g. "https://muxterm.example.com") or unset behind_reverse_proxy`)
	}
	u, err := url.Parse(s.PublicOrigin)
	if err != nil {
		return fmt.Errorf("config: public_origin %q is not a valid URL: %w", s.PublicOrigin, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("config: public_origin %q must use the http or https scheme", s.PublicOrigin)
	}
	if u.Host == "" {
		return fmt.Errorf("config: public_origin %q must include a host", s.PublicOrigin)
	}
	return nil
}

// BaseURL returns PublicOrigin ready to have an absolute path appended
// (trailing slashes trimmed, so "https://x/" + "/auth/callback" cannot
// produce a double slash that would break the exact-match redirect-URI
// comparison). Only meaningful when BehindReverseProxy is true.
func (s ServerConfig) BaseURL() string {
	return strings.TrimRight(s.PublicOrigin, "/")
}
```

Add `Server` to the `Defaults()` return literal — replace `internal/config/config.go:167-171` (the `Driver:` entry and the closing brace of the composite literal) with:

```go
		Driver: DriverConfig{
			Autostart:          false,
			SharedWindowPolicy: "follow",
			Launch:             "muxterm-agent",
		},
		// Direct/local-dev topology by default: no reverse proxy, no
		// public origin. Stated explicitly rather than left implicit so
		// the shipped default posture is readable here.
		Server: ServerConfig{
			PublicOrigin:       "",
			BehindReverseProxy: false,
		},
	}
```

**Static Analysis** (always run first — fast and free)

```bash
cd /home/ken/workspace/muxterm
gofmt -l ./internal/config
go build ./...
go vet ./...
```

Expected: no output from any of the three commands (exit 0 each).

**Verification** (Level 2 — run the real `config.Load` + validation path through a throwaway program)

> **The throwaway program MUST live inside the module.** `internal/config` is an
> internal package: Go's internal-package visibility rule rejects an import of it
> from a program compiled outside the module (`use of internal package
> github.com/kenotron-ms/muxterm/internal/config not allowed`). A `/tmp/*.go`
> file run via `go run` is therefore not a usable verification method here. Put
> the program at `internal/config/verifycmd/main.go`, run it with `go run
> ./internal/config/verifycmd`, then **delete the whole `verifycmd` directory
> before committing** and prove it is gone with `git status --porcelain`.

```bash
cd /home/ken/workspace/muxterm
mkdir -p /tmp/muxterm-cfg-check && cat > /tmp/muxterm-cfg-check/config.toml <<'EOF'
[server]
public_origin = "https://x.example/"
behind_reverse_proxy = true
EOF
mkdir -p internal/config/verifycmd && cat > internal/config/verifycmd/main.go <<'EOF'
package main

import (
	"fmt"

	"github.com/kenotron-ms/muxterm/internal/config"
)

func main() {
	c, _ := config.Load("/tmp/muxterm-cfg-check/config.toml")
	fmt.Printf("loaded=%q behind=%v baseurl=%q validate=%v\n",
		c.Server.PublicOrigin, c.Server.BehindReverseProxy, c.Server.BaseURL(), c.Server.Validate())
	fmt.Printf("missing-origin validate=%v\n", config.ServerConfig{BehindReverseProxy: true}.Validate())
	fmt.Printf("direct-mode-ignores-origin validate=%v\n", config.ServerConfig{PublicOrigin: "not-a-url"}.Validate())
}
EOF
go run ./internal/config/verifycmd
```

Expected output (exactly):

```
loaded="https://x.example/" behind=true baseurl="https://x.example" validate=<nil>
missing-origin validate=config: behind_reverse_proxy is set but public_origin is empty; set public_origin (e.g. "https://muxterm.example.com") or unset behind_reverse_proxy
direct-mode-ignores-origin validate=<nil>
```

Then confirm no regression in the existing checked-in tests:

```bash
cd /home/ken/workspace/muxterm && go test ./internal/config/...
```

Expected: `ok  	github.com/kenotron-ms/muxterm/internal/config	<duration>`

Clean up the throwaway program — it must not be committed — and **prove** it is
gone before committing:

```bash
cd /home/ken/workspace/muxterm
rm -rf internal/config/verifycmd /tmp/muxterm-cfg-check
git status --porcelain internal/config/
```

Expected (exactly one line — the intended edit, and no untracked `verifycmd`):

```
 M internal/config/config.go
```

**Commit**

This commit also lands this plan document itself, so that Task 7's
changed-file assertion (which expects the plan doc in the diff) holds and no
untracked file is left behind.

```bash
cd /home/ken/workspace/muxterm
git add internal/config/config.go docs/plans/2026-08-04-public-origin-reverse-proxy-auth-implementation.md
git commit -m "$(cat <<'EOF'
feat(config): add public_origin and behind_reverse_proxy with fail-closed validation

Adds the [server] config section from the Phase 3 design: an explicit,
opt-in public origin and reverse-proxy flag, plus Validate() enforcing
the fail-closed rule (behind_reverse_proxy without a usable
public_origin must refuse startup, never fall back to loopback).

Deliberately not added to Merge(): PATCH /api/config is browser-facing,
and a deployment-topology/security setting must not be web-mutable.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 2: Add `--public-origin` and `--behind-reverse-proxy` flags to `muxterm serve`

**Description:** Expose the two new settings as serve-mode CLI flags so the systemd unit / operator can set them without editing the TOML file, following `cmd/muxterm/cli.go`'s existing `flag.NewFlagSet` pattern exactly.

**Goal:** `ParseArgs([]string{"serve", "--public-origin", "https://x", "--behind-reverse-proxy"})` returns a `Config` with `PublicOrigin == "https://x"` and `BehindReverseProxy == true`; `ParseArgs([]string{"serve"})` returns both at their zero values.

**Specification:**
- Add `PublicOrigin string` and `BehindReverseProxy bool` fields to the CLI `Config` struct in `cmd/muxterm/cli.go`.
- Register both flags in `parseServe` only. `local` mode (bare `muxterm`) parses no flags at all and is loopback-only **by definition**: per Task 4 it does not read or honor the `[server]` section from the config file either, so these settings never reach it from any source.
- Flag defaults must be `""` and `false` so an unset flag means "defer to the config file".
- Do not touch the `--addr` default in `parseServe` or `parseInstall`. Both are already `127.0.0.1:8311` and the amended design changes no bind-address default.
- Do not modify `cmd/muxterm/cli_test.go`.

**Acceptance Criteria:**
- `go build ./...` clean, `go vet ./...` clean, `gofmt -l ./cmd` empty.
- `./bin/muxterm serve --help` lists both new flags with their descriptions.
- `go test ./cmd/...` still passes unchanged.

**Files:**
- Modify: `cmd/muxterm/cli.go:11-20` (CLI `Config` struct) and `cmd/muxterm/cli.go:117-140` (`parseServe`)

**Interfaces:**
- Consumes: `config.ServerConfig` semantics from Task 1 (field meanings only; no import — the CLI `Config` stays a flat flag-holder, matching the existing file's style).
- Produces:
  - CLI `Config` gains `PublicOrigin string` and `BehindReverseProxy bool`.
  - `parseServe` populates both from `--public-origin` / `--behind-reverse-proxy`; zero values mean "unset, defer to config file". Task 4 consumes exactly these two fields.

**Model Roles:**
- implementation_model_role: `coding`
- review_model_role: `critique`
- escalated_model_role: `reasoning`

**Implementation**

Replace the `Config` struct at `cmd/muxterm/cli.go:10-20` with:

```go
// Config holds the parsed CLI configuration.
type Config struct {
	Mode      string // local, serve, sessiond, deploy, install, uninstall, doctor, version, mcp, amplifier-install, help
	Addr      string // listen address
	Secret    string // auth token for serve mode
	NoAuth    bool   // skip WebSocket auth check (dev only — never use in production)
	Target    string // SSH target for deploy mode
	Force     bool   // install: overwrite existing service installation
	Transport string // mcp mode: transport type ("stdio"); SSE arrives in Phase 5
	MCPPort   int    // mcp mode: SSE port (Phase 5, parsed but rejected for now)

	// PublicOrigin is the serve-mode --public-origin override for the
	// config file's [server].public_origin. Empty means "unset — use the
	// config file value."
	PublicOrigin string
	// BehindReverseProxy is the serve-mode --behind-reverse-proxy override
	// for the config file's [server].behind_reverse_proxy. false means
	// "unset — use the config file value"; the flag can only turn the
	// setting on, never off (same one-way bool limitation config.Merge
	// documents).
	BehindReverseProxy bool
}
```

Replace `parseServe` at `cmd/muxterm/cli.go:117-140` with:

```go
func parseServe(args []string) (Config, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	addr := fs.String("addr", "127.0.0.1:8311", "listen address")
	secret := fs.String("secret", "", "auth secret (auto-generated if empty)")
	noAuth := fs.Bool("no-auth", false, "skip WebSocket auth check (dev only — never use in production)")
	publicOrigin := fs.String("public-origin", "", "canonical public origin when behind a reverse proxy (e.g. https://muxterm.example.com); required with --behind-reverse-proxy")
	behindProxy := fs.Bool("behind-reverse-proxy", false, "run behind a reverse proxy: derive public URLs from --public-origin and disable the loopback auth bypass")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm serve [flags]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Start muxterm server for remote/shared access with optional authentication.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Flags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	return Config{
		Mode:               "serve",
		Addr:               *addr,
		Secret:             *secret,
		NoAuth:             *noAuth,
		PublicOrigin:       *publicOrigin,
		BehindReverseProxy: *behindProxy,
	}, nil
}
```

**Static Analysis**

```bash
cd /home/ken/workspace/muxterm
gofmt -l ./cmd
go build ./...
go vet ./...
```

Expected: no output from any command (exit 0 each).

**Verification** (Level 2 — run the real binary's flag parser)

```bash
cd /home/ken/workspace/muxterm && go run ./cmd/muxterm serve --help 2>&1 | grep -A1 -e '-behind-reverse-proxy' -e '-public-origin'
```

Expected output contains both flags:

```
  -behind-reverse-proxy
    	run behind a reverse proxy: derive public URLs from --public-origin and disable the loopback auth bypass
  -public-origin string
    	canonical public origin when behind a reverse proxy (e.g. https://muxterm.example.com); required with --behind-reverse-proxy
```

```bash
cd /home/ken/workspace/muxterm && go test ./cmd/...
```

Expected: `ok  	github.com/kenotron-ms/muxterm/cmd/muxterm	<duration>`

**Commit**

```bash
cd /home/ken/workspace/muxterm
git add cmd/muxterm/cli.go
git commit -m "$(cat <<'EOF'
feat(cli): add serve --public-origin and --behind-reverse-proxy flags

Serve-mode overrides for the new [server] config section, so an operator
can enable reverse-proxy mode from the systemd unit without editing the
TOML file. Unset flags defer to the config file.

No --addr default changes: the amended Phase 3 design leaves serve mode's
bind address exactly as it is.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Phase 2: Auth-path gating

### Task 3: Gate the `IsLocalhost()` bypass on `behind_reverse_proxy`

**Description:** Thread a `BehindReverseProxy` flag through `server.Config` into `AuthMiddleware`, and skip the loopback bypass entirely when it is set. This is the load-bearing security control of the whole design — it is what makes a wide bind address safe.

**Goal:** With `behind_reverse_proxy` true, a request arriving from `127.0.0.1` with no session cookie and no bearer token is denied (redirect to `/auth/login` for HTML, `401` otherwise) instead of being waved through. With it false, behavior is byte-for-byte identical to today.

**Specification:**
- Add `behindReverseProxy bool` to the `AuthMiddleware` struct.
- Change `NewAuthMiddleware` to `NewAuthMiddleware(authSrv *authserver.AuthServer, noAuth, behindReverseProxy bool) *AuthMiddleware`.
- In `Wrap`, split today's combined `if m.noAuth || IsLocalhost(r)` condition: `noAuth` still short-circuits everything (unchanged dev-only escape hatch), while the `IsLocalhost(r)` bypass is additionally guarded by `!m.behindReverseProxy`.
- Add `BehindReverseProxy bool` to `server.Config` and pass `cfg.BehindReverseProxy` at the single `NewAuthMiddleware` call site in `server.New`.
- No new error path: a denied request takes the existing `m.deny` path unchanged.
- Do not modify any `*_test.go` file. `server.New(Config{...})` calls in existing tests keep compiling because the new field is additive and defaults to `false`; `NewAuthMiddleware` has exactly one call site (`internal/server/server.go:91`) and is not referenced by any test.

**Acceptance Criteria:**
- `go build ./...` clean, `go vet ./...` clean, `gofmt -l ./internal/server` empty.
- Against a live `httptest` server built from the real `server.New` handler with `BehindReverseProxy: true`, an unauthenticated loopback request to `GET /api/config` returns `401`; with `BehindReverseProxy: false` the same request returns `200`.
- `go test ./internal/server/...` still passes with no test file edits.

**Files:**
- Modify: `internal/server/authmiddleware.go:16-42` (doc comment, struct, constructor, `Wrap` bypass branch)
- Modify: `internal/server/server.go:28-45` (`Config` struct) and `internal/server/server.go:91` (`NewAuthMiddleware` call)

**Interfaces:**
- Consumes: nothing from Tasks 1–2 (this package does not import `internal/config`'s new type; the caller passes a plain bool).
- Produces:
  - `server.Config` gains field `BehindReverseProxy bool` — set by `cmd/muxterm/main.go` in Task 4 from `config.ServerConfig.BehindReverseProxy`.
  - `func NewAuthMiddleware(authSrv *authserver.AuthServer, noAuth, behindReverseProxy bool) *AuthMiddleware` (signature change: third parameter added).

**Model Roles:**
- implementation_model_role: `coding`
- review_model_role: `critique`
- escalated_model_role: `reasoning`

**Implementation**

Replace `internal/server/authmiddleware.go:16-42` with:

```go
// AuthMiddleware gates access to protected routes. The loopback bypass
// applies only in direct/local-dev mode; when muxterm runs behind a reverse
// proxy the bypass is disabled entirely (see behindReverseProxy below).
// Otherwise a valid session cookie (browser) or Authorization: Bearer token
// (all other callers) is required, validated against the AuthServer's token
// store.
type AuthMiddleware struct {
	authSrv *authserver.AuthServer // nil => login backend unavailable; fail closed for non-loopback callers
	noAuth  bool
	// behindReverseProxy disables the IsLocalhost() bypass unconditionally.
	// A fronting proxy's own hop to muxterm is indistinguishable from a
	// genuinely local caller at the RemoteAddr level — and in the real
	// production topology it is not even loopback — so honoring the bypass
	// here would silently grant unauthenticated access to genuinely remote
	// traffic, defeating the entire point of running behind the proxy. This
	// is a static, config-gated switch: never auto-detected, never derived
	// from a forwarded header.
	behindReverseProxy bool
}

// NewAuthMiddleware returns a middleware wired to authSrv, which may be
// nil if the platform login backend is unavailable at startup (see
// cmd/muxterm's newAuthServer) — in that case every non-loopback request
// is denied (fail closed), per the design doc's Error Handling section.
// noAuth mirrors the existing --no-auth dev-only flag: when set, ALL
// checks (including loopback and the fail-closed case) are skipped.
// behindReverseProxy disables the loopback bypass entirely.
func NewAuthMiddleware(authSrv *authserver.AuthServer, noAuth, behindReverseProxy bool) *AuthMiddleware {
	return &AuthMiddleware{authSrv: authSrv, noAuth: noAuth, behindReverseProxy: behindReverseProxy}
}

// Wrap returns next wrapped with the auth check.
func (m *AuthMiddleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.noAuth {
			next.ServeHTTP(w, r)
			return
		}
		// Loopback bypass — direct/local-dev mode only. Behind a reverse
		// proxy every request must complete the real OAuth flow regardless
		// of which interface it arrived on.
		if !m.behindReverseProxy && IsLocalhost(r) {
			next.ServeHTTP(w, r)
			return
		}
```

Replace the `AuthServer`/`WebRedirectURI` block of `server.Config` at `internal/server/server.go:36-45` with:

```go
	// AuthServer is nil when the platform login backend is unavailable at
	// startup (see cmd/muxterm's newAuthServer) — in that case every
	// non-loopback request is denied (fail closed), and /authorize,
	// /token, /auth/login, /auth/callback are not mounted at all.
	AuthServer *authserver.AuthServer
	// WebRedirectURI is the exact-match redirect URI for the muxterm-web
	// OAuth client. In direct/local-dev mode it is loopback-derived (e.g.
	// "http://127.0.0.1:8311/auth/callback"); behind a reverse proxy it is
	// "<public_origin>/auth/callback". Built by cmd/muxterm's
	// webRedirectURIFor, which is the single derivation seam.
	WebRedirectURI string
	// BehindReverseProxy mirrors config.ServerConfig.BehindReverseProxy.
	// When true the IsLocalhost() auth bypass is disabled entirely — see
	// internal/server/authmiddleware.go.
	BehindReverseProxy bool
}
```

Replace `internal/server/server.go:91` with:

```go
	authMW := NewAuthMiddleware(cfg.AuthServer, cfg.NoAuth, cfg.BehindReverseProxy)
```

**Static Analysis**

```bash
cd /home/ken/workspace/muxterm
gofmt -l ./internal/server
go build ./...
go vet ./...
```

Expected: no output from any command (exit 0 each).

**Verification** (Level 3 — live HTTP against the real `server.New` handler, both modes)

> **The throwaway program MUST live inside the module.** `internal/server` is an
> internal package: Go's internal-package visibility rule rejects an import of it
> from a program compiled outside the module (`use of internal package
> github.com/kenotron-ms/muxterm/internal/server not allowed`). A `/tmp/*.go`
> file run via `go run` is therefore not a usable verification method here. Put
> the program at `internal/server/verifycmd/main.go`, run it with `go run
> ./internal/server/verifycmd`, then **delete the whole `verifycmd` directory
> before committing** and prove it is gone with `git status --porcelain`.

```bash
cd /home/ken/workspace/muxterm
mkdir -p internal/server/verifycmd && cat > internal/server/verifycmd/main.go <<'EOF'
package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"

	"github.com/kenotron-ms/muxterm/internal/server"
)

func probe(behind bool) int {
	ts := httptest.NewServer(server.New(server.Config{BehindReverseProxy: behind}).Handler())
	defer ts.Close()
	// httptest binds 127.0.0.1, so this request arrives over genuine loopback.
	resp, err := http.Get(ts.URL + "/api/config")
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func main() {
	fmt.Printf("behind_reverse_proxy=true  loopback GET /api/config -> %d\n", probe(true))
	fmt.Printf("behind_reverse_proxy=false loopback GET /api/config -> %d\n", probe(false))
}
EOF
go run ./internal/server/verifycmd
```

Expected output (exactly):

```
behind_reverse_proxy=true  loopback GET /api/config -> 401
behind_reverse_proxy=false loopback GET /api/config -> 200
```

The `401` line is the falsifiable proof: if the bypass were still consulted, a genuine `127.0.0.1` peer would return `200`.

```bash
cd /home/ken/workspace/muxterm && go test ./internal/server/...
```

Expected: `ok  	github.com/kenotron-ms/muxterm/internal/server	<duration>`

Clean up the throwaway program — it must not be committed — and **prove** it is
gone before committing:

```bash
cd /home/ken/workspace/muxterm
rm -rf internal/server/verifycmd
git status --porcelain internal/server/
```

Expected (exactly these two lines — the intended edits, and no untracked `verifycmd`):

```
 M internal/server/authmiddleware.go
 M internal/server/server.go
```

**Commit**

```bash
cd /home/ken/workspace/muxterm
git add internal/server/authmiddleware.go internal/server/server.go
git commit -m "$(cat <<'EOF'
feat(server): disable the loopback auth bypass when behind_reverse_proxy

A fronting proxy's hop to muxterm is indistinguishable from a genuinely
local caller at the RemoteAddr level, so honoring IsLocalhost() in that
topology silently grants unauthenticated access to remote traffic. Gate
the bypass off entirely when the operator opts into reverse-proxy mode.

This is the load-bearing control of the Phase 3 design: it is what makes
the security property independent of the bind address, per the
post-incident topology correction.

Direct/local-dev mode (the default) is unchanged.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Phase 3: Origin derivation and fail-closed startup

### Task 4: Make origin derivation reverse-proxy-aware and validate at startup in `cmd/muxterm/main.go`

**Description:** Introduce the single `publicBaseURL` derivation seam, make `webRedirectURIFor` and `newAuthServer` take the resolved `config.ServerConfig`, resolve CLI-over-file precedence, and refuse to start when validation fails — all before the HTTP listener binds.

**Goal:** With `behind_reverse_proxy` true and `public_origin: "https://muxterm.ampbox.io"`, both the `muxterm-web` client's registered redirect URI and the `redirect_uri` query parameter on `/authorize` are exactly `https://muxterm.ampbox.io/auth/callback`. With the flag false, the redirect URI is the unchanged loopback derivation. With the flag true and `public_origin` empty, the process exits non-zero with a clear error and never binds. Bare `muxterm` (local mode) is unconditionally loopback-only and ignores the `[server]` section entirely, so a `config.toml` with `behind_reverse_proxy = true` changes nothing about it.

**Specification:**
- Add `resolveServerConfig(cli Config, file config.ServerConfig) config.ServerConfig` implementing flag-beats-file precedence: a non-empty `cli.PublicOrigin` overrides the file value; a true `cli.BehindReverseProxy` turns the setting on. A false flag cannot turn a file `true` off (documented one-way limitation, consistent with `config.Merge`'s documented bool limitation).
- Add `publicBaseURL(addr string, sc config.ServerConfig) string`: returns `sc.BaseURL()` when `sc.BehindReverseProxy`, else the pre-existing loopback derivation (`net.SplitHostPort`, normalizing `""`/`"0.0.0.0"`/parse failure to `127.0.0.1`), returning scheme+host+port with no path. This is the one seam every public-facing absolute URL must flow through.
- Change `webRedirectURIFor` to `webRedirectURIFor(addr string, sc config.ServerConfig) string` returning `publicBaseURL(addr, sc) + "/auth/callback"`. Its direct-mode output must remain byte-for-byte identical to today's.
- Change `newAuthServer` to `newAuthServer(addr string, sc config.ServerConfig) (*authserver.AuthServer, error)`.
- **In `runServe` only:** load the config file first, call `resolveServerConfig`, call `srvCfg.Validate()` and `return err` on failure (this propagates to `main`'s `fmt.Fprintf(os.Stderr, "error: %v\n", err); os.Exit(1)` — a non-zero exit with a clear message, before `srv.ListenAndServe`), then pass `srvCfg` to `newAuthServer` and `webRedirectURIFor`, and set `BehindReverseProxy: srvCfg.BehindReverseProxy` on `server.Config`.
- **`runLocal` MUST NOT read or honor the `[server]` section at all.** Bare `muxterm` is loopback-only **by definition** (Task 2's stated intent), and that must hold unconditionally — including on a machine whose `config.toml` sets `behind_reverse_proxy = true`, which is exactly the production host. If `runLocal` resolved and honored the file's `[server]` values, a bare local invocation on that host would disable the loopback bypass and redirect the local browser at the public origin, breaking local interactive use on the one machine where it matters most. Therefore `runLocal` must:
  - keep loading `config.Load(config.DefaultPath())` for `InitialConfig` exactly as today (the rest of the config — theme, font, keys — is still needed), but **never** read `resolved.Server`;
  - **not** call `resolveServerConfig` and **not** call `Validate()` — a `behind_reverse_proxy = true` in the file is simply inapplicable to local mode, not an error that can block startup;
  - pass an explicit zero `config.ServerConfig{}` to `newAuthServer` and `webRedirectURIFor`, which makes their output byte-for-byte identical to today's loopback derivation;
  - leave `server.Config.BehindReverseProxy` unset (zero `false`), so the `IsLocalhost()` bypass keeps working exactly as it does today.
- Only `serve` mode honors the new config fields. This is the single place the new topology semantics apply.
- Do not change `cfg.Addr` handling, `sessiond.WriteServerURL(cfg.Addr)`, or the `browserHost` computation in `runLocal` — the local browser is opened over loopback regardless of topology.
- Do not modify any `*_test.go` file. Verified: no test references `webRedirectURIFor` or `newAuthServer` (`grep -rn "webRedirectURIFor\|newAuthServer" cmd/muxterm/*_test.go` returns nothing).

**Acceptance Criteria:**
- `go build ./...` clean, `go vet ./...` clean, `gofmt -l ./cmd` empty.
- A real `muxterm serve --behind-reverse-proxy` with no `--public-origin` exits non-zero, prints an error naming `public_origin`, and leaves nothing listening.
- A real `muxterm serve --behind-reverse-proxy --public-origin https://example.test` responds to `GET /auth/login` with a `302` whose `Location` carries `redirect_uri=https%3A%2F%2Fexample.test%2Fauth%2Fcallback`.
- A real `muxterm serve` with no new flags responds to `GET /auth/login` with a `302` whose `Location` carries the loopback `redirect_uri`.
- **Local mode is unaffected by the config file's `[server]` section (C4 guard) — proven by source inspection (Level 1), NOT by a real run.** `sed -n '/^func runLocal/,/^}/p' cmd/muxterm/main.go | grep -E 'resolveServerConfig|\.Validate\(\)|resolved\.Server'` produces **no output** (grep exits `1`), establishing that `runLocal`'s function body never references the new config surface and therefore cannot honor `[server]` by any path.
- **Why no real local-mode run is performed** (both reasons are hard blockers, see verification step (iv)): (1) local mode's `ParseArgs` accepts **no flags at all** — any flag falls through to the default case and errors `unknown command` — so `muxterm --addr 127.0.0.1:<port>` is not an executable invocation, and Task 2's own specification states "local mode parses no flags at all"; and (2) a flagless bare `muxterm` binds the fixed default `127.0.0.1:8311` and triggers `openBrowser`, `sessiond.WriteServerURL`, and `EnsureDaemon`, which on **this host** collides with a live production muxterm service that was recovered from an incident during this session — making a real invocation unsafe to attempt as automated verification. The runtime-behavior side of this guard is covered instead by Task 8's DTU checks (c)–(e), which run in an isolated container.
- `go test ./cmd/...` still passes with no test file edits.

**Files:**
- Modify: `cmd/muxterm/main.go:189-200` (replace `webRedirectURIFor`)
- Modify: `cmd/muxterm/main.go:210-224` (`newAuthServer` signature and body)
- Modify: `cmd/muxterm/main.go:229-244` (`runLocal` prologue and `server.Config` literal — pins local mode to an explicit zero `config.ServerConfig{}`; it must NOT read `resolved.Server`, call `resolveServerConfig`, or call `Validate()`)
- Modify: `cmd/muxterm/main.go:269-285` (`runServe` prologue and `server.Config` literal)

**Interfaces:**
- Consumes:
  - `config.ServerConfig{PublicOrigin string; BehindReverseProxy bool}`, `func (config.ServerConfig) Validate() error`, `func (config.ServerConfig) BaseURL() string`, and `config.Config.Server` — all from Task 1.
  - CLI `Config.PublicOrigin string` and `Config.BehindReverseProxy bool` — from Task 2.
  - `server.Config.BehindReverseProxy bool` — from Task 3.
- Produces:
  - `func resolveServerConfig(cli Config, file config.ServerConfig) config.ServerConfig`
  - `func publicBaseURL(addr string, sc config.ServerConfig) string` — the single origin-derivation seam; Task 6 documents it as the required source for the RFC 8414 / RFC 9728 metadata URLs.
  - `func webRedirectURIFor(addr string, sc config.ServerConfig) string` (signature change: second parameter added).
  - `func newAuthServer(addr string, sc config.ServerConfig) (*authserver.AuthServer, error)` (signature change: second parameter added).

**Model Roles:**
- implementation_model_role: `coding`
- review_model_role: `critique`
- escalated_model_role: `reasoning`

**Implementation**

Replace `cmd/muxterm/main.go:189-200` (the whole `webRedirectURIFor` block including its doc comment) with:

```go
// resolveServerConfig merges the serve-mode CLI overrides on top of the
// config file's [server] section, following this repo's existing
// precedence (flag beats file, file beats the zero default). Consistent
// with config.Merge's documented bool limitation, --behind-reverse-proxy
// cannot be used to turn a config-file `behind_reverse_proxy = true` back
// off; remove the file value instead.
//
// SERVE MODE ONLY. runLocal deliberately does NOT call this: bare
// `muxterm` is loopback-only by definition and must stay that way even on
// a host whose config.toml sets behind_reverse_proxy = true (which is
// exactly the production host). Honoring the file there would disable the
// loopback bypass and point the local browser at the public origin,
// breaking local interactive use on the one machine where it matters most.
func resolveServerConfig(cli Config, file config.ServerConfig) config.ServerConfig {
	out := file
	if cli.PublicOrigin != "" {
		out.PublicOrigin = cli.PublicOrigin
	}
	if cli.BehindReverseProxy {
		out.BehindReverseProxy = true
	}
	return out
}

// publicBaseURL returns the origin muxterm must use whenever it constructs
// one of its own public-facing absolute URLs. Today that is the muxterm-web
// OAuth redirect URI; when Phase 2 (MCP-over-HTTP) adds the RFC 8414
// authorization-server metadata and the RFC 9728 protected-resource
// metadata / canonical /mcp resource URI, those MUST derive from this same
// function so the values cannot drift apart.
//
// Behind a reverse proxy the origin is the operator-configured
// public_origin: a fixed value resolved once at startup, never derived
// per-request from a Host or X-Forwarded-* header — headers are spoofable
// and the design rejects trusting them for any trust-relevant value.
//
// Otherwise it is the pre-existing loopback derivation from addr (the
// server's listen address), where a "0.0.0.0" or unparseable host is
// normalized to 127.0.0.1 because the browser reaches muxterm over
// loopback in that topology.
func publicBaseURL(addr string, sc config.ServerConfig) string {
	if sc.BehindReverseProxy {
		return sc.BaseURL()
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil || host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// webRedirectURIFor returns the exact-match redirect URI for the
// muxterm-web OAuth client. authserver's validateRedirectURI compares this
// value byte-for-byte against the incoming redirect_uri, so it must be
// exactly the URL the browser will actually be sent back to.
func webRedirectURIFor(addr string, sc config.ServerConfig) string {
	return publicBaseURL(addr, sc) + "/auth/callback"
}
```

Replace `cmd/muxterm/main.go:210-224` (`newAuthServer`) with:

```go
func newAuthServer(addr string, sc config.ServerConfig) (*authserver.AuthServer, error) {
	backend, err := loginbackend.New()
	if err != nil {
		return nil, err
	}

	tokenDir := filepath.Join(filepath.Dir(config.DefaultPath()), "auth")

	return authserver.New(authserver.Config{
		WebRedirectURI: webRedirectURIFor(addr, sc),
		LoginBackend:   backend,
		TokenStoreDir:  tokenDir,
		RateLimiter:    authserver.NewRateLimiter(5, 15*time.Minute),
	})
}
```

Replace the prologue of `runLocal` (`cmd/muxterm/main.go:229-244`, from `func runLocal` through the closing `})` of the `server.New` literal) with:

```go
func runLocal(cfg Config) error {
	resolved, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults

	// Local mode is loopback-only BY DEFINITION and deliberately ignores
	// the [server] section entirely: it does not read resolved.Server, does
	// not call resolveServerConfig, and does not call Validate(). Bare
	// `muxterm` on a host whose config.toml sets behind_reverse_proxy =
	// true — i.e. the production host — must still behave exactly as it
	// does today: loopback bypass on, loopback-derived redirect URI, no
	// startup error. Honoring the file here would send the *local* browser
	// to the public origin and turn the bypass off, breaking local
	// interactive use on the one machine where it matters most. Only
	// `serve` mode honors the new fields.
	//
	// The explicit zero config.ServerConfig{} below is what pins that:
	// BehindReverseProxy is false, so webRedirectURIFor falls through to
	// the pre-existing loopback derivation, byte-for-byte unchanged.
	localServerCfg := config.ServerConfig{}

	authSrv, err := newAuthServer(cfg.Addr, localServerCfg)
	if err != nil {
		log.Printf("muxterm: login backend unavailable (%v) — non-loopback access will be denied; local access is unaffected", err)
	}

	srv := server.New(server.Config{
		Addr:          cfg.Addr,
		StaticFS:      mustSubFS(webstatic.Dist, "dist"),
		ConfigPath:    config.DefaultPath(),
		InitialConfig: resolved,
		AuthServer:    authSrv,
		// No BehindReverseProxy field is set: local mode leaves it at its
		// zero false, keeping the IsLocalhost() bypass exactly as today.
		WebRedirectURI: webRedirectURIFor(cfg.Addr, localServerCfg),
	})
```

Replace the prologue of `runServe` (`cmd/muxterm/main.go:269-285`, from `func runServe` through the closing `})` of the `server.New` literal) with:

```go
func runServe(cfg Config) error {
	resolved, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults

	// Serve mode is the ONLY mode that honors the [server] section. Fail
	// closed BEFORE the listener binds: an ambiguous or misconfigured
	// security posture must deny, never silently downgrade to a
	// loopback-derived URL (which is the exact bug Phase 3 fixes).
	srvCfg := resolveServerConfig(cfg, resolved.Server)
	if err := srvCfg.Validate(); err != nil {
		return err
	}

	authSrv, err := newAuthServer(cfg.Addr, srvCfg)
	if err != nil {
		log.Printf("muxterm: login backend unavailable (%v) — non-loopback access will be denied; local access is unaffected", err)
	}

	srv := server.New(server.Config{
		Addr:               cfg.Addr,
		StaticFS:           mustSubFS(webstatic.Dist, "dist"),
		NoAuth:             cfg.NoAuth,
		ConfigPath:         config.DefaultPath(),
		InitialConfig:      resolved,
		AuthServer:         authSrv,
		WebRedirectURI:     webRedirectURIFor(cfg.Addr, srvCfg),
		BehindReverseProxy: srvCfg.BehindReverseProxy,
	})
```

**Static Analysis**

```bash
cd /home/ken/workspace/muxterm
gofmt -l ./cmd
go build ./...
go vet ./...
```

Expected: no output from any command (exit 0 each).

**Verification** (Level 3 — live HTTP against the real binary, all three modes)

Build once (`make build` also rebuilds the embedded web assets):

```bash
cd /home/ken/workspace/muxterm && make build && ls -l ./bin/muxterm
```

Expected: `./bin/muxterm` exists with a fresh mtime.

**(i) Fail-closed startup — the process must refuse to start:**

```bash
cd /home/ken/workspace/muxterm
./bin/muxterm serve --addr 127.0.0.1:18311 --behind-reverse-proxy; echo "EXIT=$?"
```

Expected (stderr line then exit code):

```
error: config: behind_reverse_proxy is set but public_origin is empty; set public_origin (e.g. "https://muxterm.example.com") or unset behind_reverse_proxy
EXIT=1
```

Confirm nothing bound:

```bash
ss -ltn | grep ':18311' || echo "NOT_LISTENING"
```

Expected: `NOT_LISTENING`

**(ii) Reverse-proxy mode — redirect URI must be the public origin:**

```bash
cd /home/ken/workspace/muxterm
./bin/muxterm serve --addr 127.0.0.1:18311 --behind-reverse-proxy --public-origin https://example.test >/tmp/muxterm-rp.log 2>&1 &
sleep 2
curl -s -o /dev/null -D - "http://127.0.0.1:18311/auth/login" | grep -i '^location:'
kill %1
```

Expected: a `302` `Location` header whose query contains

```
redirect_uri=https%3A%2F%2Fexample.test%2Fauth%2Fcallback
```

and does NOT contain `127.0.0.1`.

**(iii) Direct mode regression — redirect URI unchanged:**

```bash
cd /home/ken/workspace/muxterm
./bin/muxterm serve --addr 127.0.0.1:18311 >/tmp/muxterm-direct.log 2>&1 &
sleep 2
curl -s -o /dev/null -D - -H 'Accept: text/html' "http://127.0.0.1:18311/auth/login" | grep -i '^location:'
kill %1
```

Expected: `Location` query contains

```
redirect_uri=http%3A%2F%2F127.0.0.1%3A18311%2Fauth%2Fcallback
```

**(iv) Local mode is unaffected by a `behind_reverse_proxy = true` config file** — this is the C4 guard: the production host's own `config.toml` must not break bare `muxterm`.

**This step is Level-1 source inspection only. Do NOT run `muxterm` in local mode to prove it.** Two independent reasons, both hard blockers:

1. **A real local-mode invocation is not expressible.** Local mode's argument parsing accepts **no flags at all** — `ParseArgs` routes any leading `-`/`--` token to its default case and errors with `unknown command`. Task 2's specification states this directly: "`local` mode (bare `muxterm`) parses no flags at all." So there is no `muxterm --addr 127.0.0.1:18312` invocation to run; an earlier draft of this step used exactly that command and it would have failed at argument parsing, never reaching the behavior it claimed to test.
2. **A bare `muxterm` would collide with production on this host.** Without an `--addr` flag (which local mode cannot accept), bare `muxterm` binds the fixed default `127.0.0.1:8311` and fires its startup side effects — `openBrowser`, `sessiond.WriteServerURL`, `EnsureDaemon`. On **this specific machine** that port and daemon state belong to a live production muxterm service that was recovered from an incident during this same session. Launching a second instance against it as part of automated verification is actively unsafe and is not authorized.

The C4 guard is therefore proven by asserting that `runLocal`'s function body never references the new config surface at all — if it cannot name `resolveServerConfig`, `.Validate()`, or `resolved.Server`, it cannot honor the `[server]` section by any path:

```bash
cd /home/ken/workspace/muxterm
sed -n '/^func runLocal/,/^}/p' cmd/muxterm/main.go | grep -E 'resolveServerConfig|\.Validate\(\)|resolved\.Server'
```

Expected: **no output**, and `grep` exits `1` (no match found). For an explicit positive signal in the evidence log, run the same command guarded:

```bash
cd /home/ken/workspace/muxterm
sed -n '/^func runLocal/,/^}/p' cmd/muxterm/main.go | grep -E 'resolveServerConfig|\.Validate\(\)|resolved\.Server' || echo "LOCAL_IGNORES_SERVER_SECTION"
```

Expected: `LOCAL_IGNORES_SERVER_SECTION`

**Any** matching line is a **hard failure**: it means `runLocal` reaches the `[server]` section, which is exactly the breakage C4 exists to prevent. Note that the runtime consequences of that breakage — a fail-closed startup abort, or a public-origin redirect from a local invocation — remain covered at the behavioral level by Task 8's DTU checks (c)–(e), which exercise `serve` mode in an isolated container where neither of the two blockers above applies.

**(v) Existing tests still green:**

```bash
cd /home/ken/workspace/muxterm && go test ./cmd/...
```

Expected: `ok  	github.com/kenotron-ms/muxterm/cmd/muxterm	<duration>`

**Commit**

```bash
cd /home/ken/workspace/muxterm
git add cmd/muxterm/main.go
git commit -m "$(cat <<'EOF'
feat(muxterm): derive the OAuth redirect URI from public_origin behind a proxy

Adds publicBaseURL() as the single seam every public-facing absolute URL
muxterm builds must flow through, resolves flag-over-file precedence for
the new [server] settings, and fails closed before the listener binds when
behind_reverse_proxy is set without a usable public_origin.

Fixes the concrete bug: a remote browser was redirected to an unreachable
http://127.0.0.1:<port>/auth/callback after login, because the redirect URI
was derived from muxterm's own listen address.

Direct/local-dev mode output is byte-for-byte unchanged.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Phase 4: Documentation of the now-implemented contract

### Task 5: Retire the "Phase 3 will..." TODO doc comments in `internal/authserver`

**Description:** Update the two doc comments that describe Phase 3 as deferred future work so they describe the shipped behavior, and record explicitly that `validateRedirectURI` intentionally needed no code change.

**Goal:** Neither `internal/authserver/authserver.go` nor `internal/authserver/clientstore.go` claims Phase 3 is unimplemented, and both name where the value now comes from.

**Specification:**
- Doc-comment-only change. No behavioral code, no signature change, in either file.
- `authserver.go`: rewrite the `Config.WebRedirectURI` doc comment (lines 36–39) to describe both modes and name `cmd/muxterm`'s `webRedirectURIFor` as the producer.
- `clientstore.go`: rewrite the `NewClientStore` doc comment (lines 34–39) the same way, and state that the exact-match check is the correct validation in both topologies precisely because it compares against whatever value it is handed.
- `validateRedirectURI` (lines 67–99) must not be touched — per the design, "it already performs a plain string equality check against whatever `WebRedirectURI` value it's handed."

**Acceptance Criteria:**
- `go build ./...` clean, `go vet ./...` clean, `gofmt -l ./internal/authserver` empty.
- `git diff --stat` for this commit shows only the two files, and `git diff` shows only comment lines changed (every changed line begins with `//` after the leading `+`/`-`).
- `grep -rn "Phase 3 will" internal/` returns nothing.

**Files:**
- Modify: `internal/authserver/authserver.go:36-39` (comment only)
- Modify: `internal/authserver/clientstore.go:34-39` (comment only)

**Interfaces:**
- Consumes: `webRedirectURIFor(addr string, sc config.ServerConfig) string` from Task 4 — referenced by name in prose only; no import is added.
- Produces: no code interface. `authserver.Config.WebRedirectURI` and `NewClientStore(webRedirectURI string)` keep their exact existing signatures and behavior.

**Model Roles:**
- implementation_model_role: `coding`
- review_model_role: `critique`
- escalated_model_role: `reasoning`

**Implementation**

Replace `internal/authserver/authserver.go:36-39` with:

```go
	// WebRedirectURI is the exact-match redirect URI for the muxterm-web
	// client. In direct/local-dev mode it is loopback-derived (e.g.
	// "http://127.0.0.1:8311/auth/callback"); when the operator sets
	// behind_reverse_proxy it is "<public_origin>/auth/callback". Both are
	// produced by cmd/muxterm's webRedirectURIFor, which is the single
	// derivation seam — this package never derives it, and never inspects
	// a request header to guess it.
```

Replace `internal/authserver/clientstore.go:34-39` with:

```go
// NewClientStore returns the fixed ClientStore containing muxterm-web and
// muxterm-mcp. There is no dynamic client registration (see design doc
// "Alternatives Considered"). webRedirectURI is the exact-match redirect
// URI for the web client, supplied by cmd/muxterm's webRedirectURIFor: the
// loopback callback URL in direct/local-dev mode, or
// "<public_origin>/auth/callback" when the operator sets
// behind_reverse_proxy. validateRedirectURI's plain string-equality check
// below is the correct validation in BOTH topologies precisely because it
// compares against whatever value it is handed — the topology changes the
// value, never the comparison.
```

**Static Analysis**

```bash
cd /home/ken/workspace/muxterm
gofmt -l ./internal/authserver
go build ./...
go vet ./...
```

Expected: no output from any command (exit 0 each).

**Verification** (Level 1+2 — prove the change is comment-only and the stale claim is gone)

```bash
cd /home/ken/workspace/muxterm
git diff --stat -- internal/authserver/
git diff -U0 -- internal/authserver/ | grep -E '^[+-]' | grep -v '^[+-][+-]' | grep -vE '^[+-]\s*//' || echo "COMMENT_ONLY_CHANGE"
grep -rn "Phase 3 will" internal/ || echo "NO_STALE_PHASE3_TODOS"
```

Expected:

```
 internal/authserver/authserver.go  | <n> +--
 internal/authserver/clientstore.go | <n> +--
 2 files changed, ...
COMMENT_ONLY_CHANGE
NO_STALE_PHASE3_TODOS
```

**Commit**

```bash
cd /home/ken/workspace/muxterm
git add internal/authserver/authserver.go internal/authserver/clientstore.go
git commit -m "$(cat <<'EOF'
docs(authserver): Phase 3 redirect-URI derivation is implemented, not deferred

Comment-only. Both doc comments claimed Phase 3 "will" derive the redirect
URI from public_origin; it now does. Names cmd/muxterm's webRedirectURIFor
as the single derivation seam and records why validateRedirectURI needed
no code change: it compares against whatever value it is handed, so the
topology changes the value, never the comparison.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 6: Record the RFC 8414 / RFC 9728 derivation requirement at the route table

**Description:** The design names the RFC 8414 `.well-known/oauth-authorization-server` metadata and the RFC 9728 `.well-known/oauth-protected-resource` metadata / canonical `/mcp` resource URI as additional consumers of the same derivation. **Neither endpoint, nor a `POST /mcp` route, exists in this codebase** — they are Phase 2 (MCP-over-HTTP) surface that has not been built. This task records that verified finding and pins the derivation requirement at the route table, so whoever adds those endpoints cannot re-derive the origin from a request header.

**Goal:** `internal/server/server.go`'s public-route block carries an explicit, discoverable note that any future `.well-known/oauth-protected-resource` document, `POST /mcp` route, and `.well-known/oauth-authorization-server` document must build their URLs from `Config.WebRedirectURI`'s origin (i.e. `cmd/muxterm`'s `publicBaseURL`), never from `r.Host` or `X-Forwarded-*`.

**Specification:**
- Comment-only change to `internal/server/server.go`. Add no route, no handler, no metadata document.
- **Do not create these endpoints.** Creating an RFC 8414 or RFC 9728 endpoint is Phase 2 scope and is not authorized by the approved design; the design only states that *when* such URLs are built, they follow the same derivation. Adding them here would be unapproved scope.
- The note goes immediately above the `// Public, unauthenticated routes.` block at `internal/server/server.go:96`.

**Acceptance Criteria:**
- `go build ./...` clean, `go vet ./...` clean, `gofmt -l ./internal/server` empty.
- The grep in the Verification section below matches only the new comment, **correctly excluding 3 known pre-existing occurrences** of the string `well-known` in `internal/mcp/tools_config.go`, `internal/mcp/tools_tunnel.go`, and `internal/sessiond/spawn.go` — those are an unrelated "well-known file" phrase describing the serve-URL discovery file, not an OAuth metadata endpoint. (An unfiltered `grep -rn "well-known\|..." --include=*.go .` therefore does NOT match only the new comment; the filtered command is the one that must be run.) This confirms no OAuth metadata endpoint was created and none pre-existed.
- `git diff` for this commit shows only comment lines added.

**Files:**
- Modify: `internal/server/server.go:96` (insert comment block immediately above `// Public, unauthenticated routes.`)

**Interfaces:**
- Consumes: `server.Config.WebRedirectURI` (existing) and `publicBaseURL` from Task 4 — referenced by name in prose only.
- Produces: no code interface. Documentation contract only: future RFC 8414 / RFC 9728 / `POST /mcp` work must source its origin from `publicBaseURL`.

**Model Roles:**
- implementation_model_role: `coding`
- review_model_role: `critique`
- escalated_model_role: `reasoning`

**Implementation**

Insert immediately above `internal/server/server.go:96` (the `// Public, unauthenticated routes.` line):

```go
	// NOTE for the Phase 2 (MCP-over-HTTP) surface: muxterm does not yet
	// serve an RFC 8414 .well-known/oauth-authorization-server document, an
	// RFC 9728 .well-known/oauth-protected-resource document, or a POST
	// /mcp route — none of them exist anywhere in this codebase today.
	// When they are added, every absolute URL inside them (issuer,
	// authorization_endpoint, token_endpoint, resource, and the canonical
	// /mcp resource URI) MUST be built from the same origin that produced
	// cfg.WebRedirectURI — cmd/muxterm's publicBaseURL, which resolves to
	// the operator-configured public_origin behind a reverse proxy and to
	// the loopback derivation otherwise. They MUST NOT be derived from
	// r.Host, X-Forwarded-Host, X-Forwarded-Proto, or any other request
	// header: headers are spoofable, and the design rejects trusting them
	// for any trust-relevant value. Deriving them anywhere else is how
	// these documents silently drift from the registered redirect URI.

```

**Static Analysis**

```bash
cd /home/ken/workspace/muxterm
gofmt -l ./internal/server
go build ./...
go vet ./...
```

Expected: no output from any command (exit 0 each).

**Verification** (Level 1 — prove the endpoints still do not exist and the note is the only match)

```bash
cd /home/ken/workspace/muxterm
grep -rn "well-known\|oauth-protected-resource\|oauth-authorization-server\|POST /mcp" --include=*.go . | grep -v "internal/mcp/tools_config.go\|internal/mcp/tools_tunnel.go\|internal/sessiond/spawn.go"
```

Expected: only lines from the new comment block in `internal/server/server.go` (the three excluded files contain a pre-existing, unrelated "well-known file" phrase referring to the serve-URL discovery file, not an OAuth metadata endpoint). No `s.mux.Handle`/`HandleFunc` line appears in the output — proof that no endpoint was created.

```bash
cd /home/ken/workspace/muxterm
git diff -U0 -- internal/server/server.go | grep -E '^[+-]' | grep -v '^[+-][+-]' | grep -vE '^[+-]\s*(//)?\s*$' | grep -vE '^[+-]\s*//' || echo "COMMENT_ONLY_CHANGE"
go test ./internal/server/...
```

Expected:

```
COMMENT_ONLY_CHANGE
ok  	github.com/kenotron-ms/muxterm/internal/server	<duration>
```

**Commit**

```bash
cd /home/ken/workspace/muxterm
git add internal/server/server.go
git commit -m "$(cat <<'EOF'
docs(server): pin RFC 8414/9728 URL derivation to publicBaseURL

Comment-only. Neither metadata document nor a POST /mcp route exists yet
(verified by grep) — they are Phase 2 surface. This records that when they
are added, every absolute URL in them must come from the same origin that
produced Config.WebRedirectURI, never from r.Host or X-Forwarded-*, so the
metadata cannot drift from the registered redirect URI.

No endpoint is created here: that would be unapproved Phase 2 scope.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Phase 5: Whole-feature verification

### Task 7: Full static gate and existing-test regression sweep

**Description:** Run the complete static-analysis gate and the entire checked-in test suite against the finished change set, and confirm the amended design's out-of-scope files are genuinely untouched.

**Goal:** The full repository builds and vets clean, `gofmt` is clean for every touched package, every pre-existing test still passes, and the diff contains no changes to `internal/service/service.go`, `internal/deploy/ssh.go`, the repo-root `Caddyfile`, or any `*_test.go` file.

**Specification:**
- Run `go build ./...`, `go vet ./...`, and `gofmt -l` on the touched packages.
- Run the full `go test ./...`. Compare against the captured baseline; any newly failing package is a regression to fix in this task, not to accept.
- Assert with `git diff --name-only` against the pre-change commit that no forbidden file appears.
- Write no new test file and add no new test function. If a pre-existing test fails, fix the production code or the stale assertion — but note that no assertion in `cmd/muxterm/cli_test.go`, `internal/service/service_test.go`, or `internal/deploy/ssh_test.go` should need changing, because this plan changes no default those tests assert.

**Acceptance Criteria:**
- `go build ./...` exits 0 with no output.
- `go vet ./...` exits 0 with no output.
- `gofmt -l ./cmd ./internal/config ./internal/server ./internal/authserver` prints nothing.
- `go test ./...` reports no `FAIL` line.
- The forbidden-file assertion prints `SCOPE_OK`.
- No commit is produced by this task unless a regression fix was required.

**Files:**
- Modify: none expected (verification-only task; modify production code only if a regression is found).

**Interfaces:**
- Consumes: the complete change set from Tasks 1–6.
- Produces: recorded static-analysis and regression evidence for Task 8's DTU run to build on. No code interface.

**Model Roles:**
- implementation_model_role: `coding`
- review_model_role: `critique`
- escalated_model_role: `reasoning`

**Implementation**

No production code changes are expected. Run the gate:

```bash
cd /home/ken/workspace/muxterm
go build ./... && echo BUILD_OK
go vet ./... && echo VET_OK
gofmt -l ./cmd ./internal/config ./internal/server ./internal/authserver && echo "GOFMT_CLEAN (no files listed above)"
```

Scope assertion — the amended design's out-of-scope files must be untouched (`a956c17` is the commit immediately before Task 1):

```bash
cd /home/ken/workspace/muxterm
git diff --name-only a956c17..HEAD > /tmp/muxterm-changed.txt
cat /tmp/muxterm-changed.txt
if grep -qE 'internal/service/service\.go|internal/deploy/ssh\.go|^Caddyfile$|_test\.go$' /tmp/muxterm-changed.txt; then
  echo "SCOPE_VIOLATION"; else echo "SCOPE_OK"; fi
```

Full regression sweep:

```bash
cd /home/ken/workspace/muxterm
go test ./... 2>&1 | tee /tmp/muxterm-test.log | grep -E '^(ok|FAIL|---)' | head -40
grep -c '^FAIL' /tmp/muxterm-test.log || echo "NO_FAILURES"
```

**Static Analysis**

Covered by the commands above (`go build ./...`, `go vet ./...`, `gofmt -l` on the touched packages).

Expected:

```
BUILD_OK
VET_OK
GOFMT_CLEAN (no files listed above)
```

**Verification** (Level 2 — run the real suite and the real scope assertion)

Expected from the scope assertion — exactly these eight files (seven source files plus this plan document, which Task 1's commit lands) and nothing else:

```
cmd/muxterm/cli.go
cmd/muxterm/main.go
docs/plans/2026-08-04-public-origin-reverse-proxy-auth-implementation.md
internal/authserver/authserver.go
internal/authserver/clientstore.go
internal/config/config.go
internal/server/authmiddleware.go
internal/server/server.go
SCOPE_OK
```

Expected from the regression sweep: an `ok` line for every package with test files (including `cmd/muxterm`, `internal/config`, `internal/server`), no `FAIL` line, and:

```
NO_FAILURES
```

**Commit**

No commit unless a regression fix was required. If one was:

```bash
cd /home/ken/workspace/muxterm
git add -A
git commit -m "$(cat <<'EOF'
fix: repair regression surfaced by the Phase 3 static/test gate

<describe the specific regression and the fix>

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 8: Digital Twin Universe end-to-end verification, checks (a)–(f)

**Description:** Stand up an isolated DTU environment running a real Caddy reverse proxy in front of a real muxterm binary — mimicking the production `muxterm.ampbox.io` topology — and execute the approved design's Testing Strategy checks (a)–(f) over real HTTP, with check (f) corrected per the post-incident amendment to a pure source-scope assertion that this plan left the bind-address files untouched.

**Goal:** Recorded, falsifiable evidence for all six checks: the redirect URI carries `public_origin` and never `127.0.0.1`; login completes to an authenticated session; the loopback bypass is genuinely off behind the proxy; direct mode is unregressed; a misconfigured startup refuses to bind; and this plan's diff modified neither `internal/service/service.go` nor `internal/deploy/ssh.go`.

**Specification:**
- **Delegate to the `digital-twin-universe:dtu-profile-builder` agent** to explore the repo, generate the profile, and launch the environment — this is the established pattern for this repo and is what the design's Testing Strategy prescribes.
- Save the generated profile at `.amplifier/digital-twin-universe/profiles/muxterm-reverse-proxy.yaml`. Do not commit it (workspace-specific and ephemeral).
- The environment must contain: Go 1.24+, Caddy, `playwright-cli` **plus its headless browser** (check (b) runs the browser from inside the container — see below), the muxterm source tree pushed from the host **after a local `make build`** (the `//go:embed dist/*` directive in `web/embed.go` requires a populated `web/dist/`; `make build` must run on the host before the DTU image is packaged), and a built `muxterm` binary.
- **The browser check runs inside the container, not on the host.** The DTU setup adds the public-origin test hostname (`muxterm.dtu.test`) to the **container's** `/etc/hosts` only; the host cannot resolve it, and substituting an IP or `localhost` would break the exact-match `public_origin` comparison that check (b) exists to prove. `playwright-cli` must therefore be installed in the DTU profile — include that requirement in the delegation brief to `digital-twin-universe:dtu-profile-builder`.
- Caddy inside the DTU must reverse-proxy an external-looking origin to muxterm, and muxterm must be started with `--behind-reverse-proxy --public-origin <that origin>`.
- Every check must produce output read from the real environment. No check may be marked satisfied from reasoning alone.
- Check (f) is the **corrected, narrowed** check: a **source-scope assertion only**. It asserts that this plan's diff modified neither `internal/service/service.go` nor `internal/deploy/ssh.go` (`git diff a956c17..HEAD -- internal/service/service.go internal/deploy/ssh.go` is empty), and that both files still contain their `0.0.0.0` literals. That is the entire check.
  - **Do NOT assert anything about a fresh install's `ExecStart` or an `ss` listener showing `0.0.0.0`.** That assertion is unsatisfiable and was wrong: `muxterm install` with no explicit `--addr` produces `ExecStart ... --addr 127.0.0.1:8311`, because `cmd/muxterm/cli.go`'s `parseInstall` defaults `--addr` to `127.0.0.1:8311`. `service.DefaultConfig()`'s `0.0.0.0:8311` has exactly one caller — an existing test — and is never reached by the install CLI path. The installed default of `127.0.0.1:8311` is correct and unchanged by this plan.
  - **Do not touch `cli.go`'s defaults** to make any bind-address observation come out differently. Installed bind defaults are orthogonal to this plan, which implements `behind_reverse_proxy` at the config and middleware layer; per the amended design, the security property comes from the config-gated bypass removal, not from the bind address.
  - An observation that either file *was* modified is a **failure** — it means the reverted draft's bind narrowing crept back in, which would re-break `muxterm.ampbox.io`, whose Caddy lives in a different network namespace and reaches this host only via the bridge IP `10.66.204.209`.
- Per repo `AGENTS.md` verification hygiene: use a freshly launched DTU for the run; do not reuse an environment that has been poked through many iterations. Before trusting any local-host observation, confirm no stale `sessiond` from another worktree is interfering (`ps aux | grep sessiond`).
- Destroy only the DTU id returned by this run's `launch`. Never iterate `list` and destroy everything.

**Acceptance Criteria:**
- (a) The `Location` header of `GET /auth/login` through the proxy contains `redirect_uri=<url-encoded public_origin>%2Fauth%2Fcallback` and contains no `127.0.0.1`; the post-password redirect targets the same public origin.
- (b) After submitting the correct password, all three of the following hold, using **only** what the browser can demonstrate directly — **the raw `muxterm_session` cookie value is never read or extracted**, because `internal/server/authclient.go` sets `HttpOnly: true` (so page JavaScript cannot read it) and this plan establishes no `playwright-cli` cookie/storage-state export mechanism:
  1. **Redirect-URI fix proven:** the browser's current URL (`playwright-cli eval "location.href"`) starts with `https://muxterm.dtu.test:8443/` and contains no `127.0.0.1`.
  2. **Session actually established:** `playwright-cli snapshot` shows the authenticated muxterm terminal UI, not the login form.
  3. **Cookie valid and accepted server-side:** a `fetch` issued **from inside the authenticated page's own context** (`playwright-cli eval`) to a same-origin protected API route returns `200`. Same-origin plus `credentials: 'same-origin'` makes the browser attach the HttpOnly cookie automatically, so the check proves the cookie is valid without anything ever reading its value.
  The unauthenticated `curl` negative control from Step 5 (a cookie-less request to the same protected route returns `401`) is retained unchanged, so the `200` above is attributable to the session and not to an open route.
- (c) With `behind_reverse_proxy` true, an unauthenticated request issued from inside the DTU over genuine loopback (`curl http://127.0.0.1:8311/api/config`) returns `401` (or a `302` to `/auth/login` for an HTML `Accept` header) — never `200`.
- (d) With the same binary restarted with no new flags, that same loopback request returns `200` and the redirect URI is loopback-derived.
- (e) `muxterm serve --behind-reverse-proxy` with no `--public-origin` exits non-zero with an error naming `public_origin`, and nothing is listening on the port.
- (f) **Source-scope only:** `git diff a956c17..HEAD -- internal/service/service.go internal/deploy/ssh.go` produces empty output (neither file was modified by this plan), and both files still contain their `0.0.0.0` literals (`internal/service/service.go:111` `Addr: "0.0.0.0:8311"`, `internal/deploy/ssh.go:63` `systemdUnit(secret, "0.0.0.0:8080")`). **No assertion is made about a fresh install's `ExecStart` or an `ss` listener** — `muxterm install` with no explicit `--addr` correctly yields `127.0.0.1:8311` from `parseInstall`'s default, which this plan does not change and which is orthogonal to whether `behind_reverse_proxy` is honored at the config/middleware layer.
- A written evidence block records, for every check, the exact command run and the exact observed output.

**Files:**
- Create: `.amplifier/digital-twin-universe/profiles/muxterm-reverse-proxy.yaml` (generated by the delegated agent; not committed)
- Modify: none in the repository.

**Interfaces:**
- Consumes: the complete, statically-gated change set from Tasks 1–7; specifically the `--public-origin` / `--behind-reverse-proxy` serve flags (Task 2), the `behind_reverse_proxy`-gated bypass (Task 3), and the `publicBaseURL`-derived redirect URI plus fail-closed startup (Task 4).
- Produces: the recorded evidence block for checks (a)–(f). This is the artifact that authorizes any completion claim for the feature. No code interface.

**Model Roles:**
- implementation_model_role: `coding`
- review_model_role: `critique`
- escalated_model_role: `reasoning`

**Implementation**

**Step 0 — host pre-flight (embedded assets and DTU prerequisites):**

```bash
cd /home/ken/workspace/muxterm
make build && ls web/dist/index.html   # //go:embed dist/* needs a populated web/dist
which amplifier-digital-twin && which incus && incus version
ps aux | grep -c '[s]essiond'          # note any stale daemons before trusting host-side results
```

Expected: `web/dist/index.html` exists, `amplifier-digital-twin` and `incus` both resolve, `incus version` prints a version.

`make build` must complete **before** the DTU image is packaged in Step 1 — the pushed source tree carries `web/dist/` with it, and `//go:embed dist/*` fails to build inside the container without it. There is no host-side `playwright-cli` check here on purpose: per Step 5 the browser runs **inside** the container, so `playwright-cli` availability is a DTU-image requirement, checked with `amplifier-digital-twin exec $DTU -- which playwright-cli` after launch.

**Step 1 — delegate profile creation and launch** to the `digital-twin-universe:dtu-profile-builder` agent with this brief:

> Build and launch a DTU profile named `muxterm-reverse-proxy` for `/home/ken/workspace/muxterm`, saved at `.amplifier/digital-twin-universe/profiles/muxterm-reverse-proxy.yaml`. The environment must reproduce the production `muxterm.ampbox.io` topology: a Caddy instance reverse-proxying an external-looking origin to a muxterm process on the same host. Requirements:
> - Base: Ubuntu 24.04 with `golang-go` (1.24+) and `caddy` installed.
> - **`playwright-cli` and its headless browser must be installed in the image**, because check (b) drives the browser from *inside* the container (the host cannot resolve `muxterm.dtu.test`, and an IP substitute would break the exact-match `public_origin` comparison). `amplifier-digital-twin exec <instance> -- which playwright-cli` must succeed after launch; if it does not, the profile is incomplete and must be fixed before the run proceeds.
> - Push the host worktree at `/home/ken/workspace/muxterm` (including the already-built `web/dist/`) to `/root/muxterm`, then build with `go build -o /root/bin/muxterm ./cmd/muxterm`.
> - Caddy config: a site block for `muxterm.dtu.test:8443` (or an equivalent externally-addressable name/port for the DTU) with `reverse_proxy 127.0.0.1:8311` and `tls internal`; add `muxterm.dtu.test` to `/etc/hosts` pointing at the container's own address so in-container curl exercises the real proxy path.
> - Do NOT start muxterm from the profile's setup commands — the verification steps below start and restart it with different flags.
> - Expose the Caddy port so the host can reach it, and return the DTU id plus the external URL.
> - A local test account with a known password must exist for the PAM login backend (`useradd`/`chpasswd`), and its credentials must be reported back so check (b) can complete the real login.

Record the returned DTU id as `$DTU`.

**Step 2 — check (e), fail-closed startup (run first; it must not leave anything bound):**

```bash
amplifier-digital-twin exec $DTU -- bash -c '/root/bin/muxterm serve --addr 127.0.0.1:8311 --behind-reverse-proxy; echo EXIT=$?'
amplifier-digital-twin exec $DTU -- bash -c 'ss -ltn | grep ":8311" || echo NOT_LISTENING'
```

Expected:

```
error: config: behind_reverse_proxy is set but public_origin is empty; set public_origin (e.g. "https://muxterm.example.com") or unset behind_reverse_proxy
EXIT=1
NOT_LISTENING
```

**Step 3 — start muxterm in reverse-proxy mode:**

```bash
amplifier-digital-twin exec $DTU -- bash -c 'nohup /root/bin/muxterm serve --addr 127.0.0.1:8311 --behind-reverse-proxy --public-origin https://muxterm.dtu.test:8443 >/var/log/muxterm-rp.log 2>&1 & sleep 2; ss -ltn | grep ":8311"'
```

Expected: a listener line showing `127.0.0.1:8311`.

**Step 4 — check (a), redirect URI correctness through the real proxy:**

```bash
amplifier-digital-twin exec $DTU -- bash -c 'curl -sk -o /dev/null -D - -H "Accept: text/html" https://muxterm.dtu.test:8443/api/config | grep -i "^location:"'
amplifier-digital-twin exec $DTU -- bash -c 'curl -sk -o /dev/null -D - -H "Accept: text/html" https://muxterm.dtu.test:8443/auth/login | grep -i "^location:"'
```

Expected: the `/auth/login` `Location` contains

```
redirect_uri=https%3A%2F%2Fmuxterm.dtu.test%3A8443%2Fauth%2Fcallback
```

and contains no `127.0.0.1`. Assert the negative explicitly:

```bash
amplifier-digital-twin exec $DTU -- bash -c 'curl -sk -o /dev/null -D - -H "Accept: text/html" https://muxterm.dtu.test:8443/auth/login | grep -i "^location:" | grep -q "127.0.0.1" && echo BUG_LOOPBACK_REDIRECT || echo NO_LOOPBACK_IN_REDIRECT'
```

Expected: `NO_LOOPBACK_IN_REDIRECT`

**Step 5 — check (b), login actually completes to a working session.** Drive the real browser flow with `playwright-cli` (per repo `AGENTS.md`, browser behavior is verified in a real browser).

> **`playwright-cli` MUST run FROM INSIDE the DTU container, not from the host.**
> The DTU setup adds `muxterm.dtu.test` to the **container's** `/etc/hosts` only —
> the host machine has no such entry and cannot resolve the name, so a host-side
> `playwright-cli open https://muxterm.dtu.test:8443/` fails at DNS resolution.
> Substituting the host-reachable IP or `localhost` is **not** an acceptable
> workaround either: `public_origin` is an **exact-match** value, so the browser
> must arrive at exactly `https://muxterm.dtu.test:8443` for the redirect-URI
> comparison this check exists to prove. Running the browser inside the container
> is the only invocation where both hostname resolution and the exact-match
> origin hold.
>
> Two prerequisites follow, and both must be confirmed before this step:
> 1. **`playwright-cli` must be available inside the DTU image.** Include it in
>    the Step 1 delegation brief to `digital-twin-universe:dtu-profile-builder`
>    so it is installed in the profile (along with the headless browser it
>    needs). Confirm with
>    `amplifier-digital-twin exec $DTU -- which playwright-cli` before relying on
>    this step.
> 2. **`make build` must have run on the host before the DTU image is packaged**
>    (Step 0), so `web/dist/` is populated — `//go:embed dist/*` in
>    `web/embed.go` fails to build otherwise, and there would be no UI for the
>    browser to log into.

Confirm the prerequisite, then drive the flow through the container:

```bash
amplifier-digital-twin exec $DTU -- which playwright-cli
amplifier-digital-twin exec $DTU -- playwright-cli open https://muxterm.dtu.test:8443/
amplifier-digital-twin exec $DTU -- playwright-cli snapshot                 # expect the muxterm login form
amplifier-digital-twin exec $DTU -- playwright-cli fill <password-field-ref> '<test account password>'
amplifier-digital-twin exec $DTU -- playwright-cli click <submit-button-ref>
amplifier-digital-twin exec $DTU -- playwright-cli snapshot                 # expect the muxterm app, not the login form
```

If `playwright-cli` is not present in the image, STOP and fix the profile (re-delegate to `digital-twin-universe:dtu-profile-builder`) — do not fall back to a host-side invocation, and do not mark check (b) satisfied from the `curl` evidence alone.

Then assert the three observable facts that make up check (b). All three come from
the browser itself; **none requires reading the `muxterm_session` cookie value.**

> **Why the cookie value is never extracted.** `internal/server/authclient.go` sets
> `HttpOnly: true` on the session cookie, so page JavaScript cannot read it
> (`document.cookie` will not contain it), and this plan establishes no
> `playwright-cli` mechanism for exporting cookies or storage state. Any step that
> asks for "the cookie value from the browser" is unexecutable. Instead, let the
> browser use the cookie on its own behalf: a `fetch` issued **in the page's own
> context** against a **same-origin** URL has the HttpOnly cookie attached
> automatically by the browser, which proves the cookie is present and accepted
> server-side without anything ever reading it.

**(b1) Redirect-URI fix — the browser landed on the public origin, not loopback:**

```bash
amplifier-digital-twin exec $DTU -- playwright-cli eval "location.href"
```

Expected: a URL beginning `https://muxterm.dtu.test:8443/`. Any `127.0.0.1` in this
value is a **hard failure** — it is the original bug.

**(b2) Session established — the app rendered, not the login form:**

```bash
amplifier-digital-twin exec $DTU -- playwright-cli snapshot
```

Expected: the muxterm terminal UI. A password field or login form here means the
login did not complete.

**(b3) Cookie valid and accepted server-side — proven from inside the page:**

```bash
amplifier-digital-twin exec $DTU -- playwright-cli eval "fetch('/api/config', {credentials: 'same-origin'}).then(r => 'authenticated_api_config=' + r.status)"
```

Expected: `authenticated_api_config=200`. The relative URL keeps the request
same-origin with the authenticated page, so the browser attaches the HttpOnly
session cookie itself. A `401` here means the session cookie was not established or
is not being accepted.

**(b4) Negative control (unchanged) — the same route without a cookie is closed:**

```bash
amplifier-digital-twin exec $DTU -- bash -c 'grep -c "auth/callback" /var/log/muxterm-rp.log; curl -sk -o /dev/null -w "%{http_code}\n" https://muxterm.dtu.test:8443/api/config'
```

Expected: the cookie-less `curl` prints `401`. This is what makes (b3)'s `200`
attributable to the session rather than to an open route; a `200` here would
invalidate (b3) as evidence.

**Step 6 — check (c), loopback bypass genuinely disabled:**

```bash
amplifier-digital-twin exec $DTU -- bash -c 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8311/api/config'
amplifier-digital-twin exec $DTU -- bash -c 'curl -s -o /dev/null -D - -H "Accept: text/html" http://127.0.0.1:8311/ | head -1'
```

Expected: `401` from the first command, and `HTTP/1.1 302 Found` from the second. A `200` from the first command is the failure signal — it would mean `IsLocalhost()` is still being honored behind the proxy.

**Step 7 — check (d), direct/local mode regression:**

```bash
amplifier-digital-twin exec $DTU -- bash -c 'pkill -f "muxterm serve"; sleep 1; nohup /root/bin/muxterm serve --addr 127.0.0.1:8311 >/var/log/muxterm-direct.log 2>&1 & sleep 2; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8311/api/config'
amplifier-digital-twin exec $DTU -- bash -c 'curl -s -o /dev/null -D - -H "Accept: text/html" http://127.0.0.1:8311/auth/login | grep -i "^location:"'
```

Expected: `200` from the first command (loopback bypass restored in default mode), and a `Location` containing

```
redirect_uri=http%3A%2F%2F127.0.0.1%3A8311%2Fauth%2Fcallback
```

**Step 8 — check (f) [CORRECTED AND NARROWED], the bind-address files must be untouched by this plan.**

This is a **source-scope assertion only**, run on the host (no DTU needed). It asserts nothing about a running install's bind address — see the note below for why the earlier form of this check was unsatisfiable.

```bash
cd /home/ken/workspace/muxterm
git diff a956c17..HEAD -- internal/service/service.go internal/deploy/ssh.go > /tmp/muxterm-bindfiles.diff
wc -c < /tmp/muxterm-bindfiles.diff
[ ! -s /tmp/muxterm-bindfiles.diff ] && echo BIND_FILES_UNTOUCHED || echo BIND_FILES_MODIFIED
grep -n "0\.0\.0\.0" internal/service/service.go internal/deploy/ssh.go
```

Expected:

```
0
BIND_FILES_UNTOUCHED
internal/service/service.go:111:		Addr: "0.0.0.0:8311",
internal/deploy/ssh.go:63:	unit := systemdUnit(secret, "0.0.0.0:8080")
```

`BIND_FILES_MODIFIED` is a **hard failure** of this task — it means the reverted bind narrowing was reintroduced, which the live incident proved breaks `muxterm.ampbox.io` (its Caddy is in a different netns and dials the bridge IP `10.66.204.209`, never loopback).

> **Why there is no `ExecStart` / `ss` assertion here.** An earlier draft of this
> check asserted that `muxterm install` with no explicit `--addr` yields
> `ExecStart ... --addr 0.0.0.0:8311` and an `ss` listener on `0.0.0.0:8311`.
> **That is unsatisfiable and was wrong.** `cmd/muxterm/cli.go`'s `parseInstall`
> defaults `--addr` to `127.0.0.1:8311`, so a flagless install genuinely produces
> `--addr 127.0.0.1:8311`. `service.DefaultConfig()`'s `0.0.0.0:8311` has exactly
> one caller — an existing test — and is never reached by the install CLI path.
> The installed `127.0.0.1:8311` default is correct, is unchanged by this plan,
> and is **orthogonal** to what this plan implements: whether
> `behind_reverse_proxy` is honored at the config and middleware layer. **Do not
> "fix" `cli.go`'s defaults to make a bind observation come out differently** —
> that would be unapproved scope and would reintroduce the incident.

**Step 9 — record evidence and tear down only this run's environment:**

Write the evidence block (exact command + exact observed output for each of (a)–(f)) into the task's completion report, then:

```bash
amplifier-digital-twin exec $DTU -- playwright-cli close   # in-container browser, per Step 5
amplifier-digital-twin destroy $DTU
```

**Static Analysis** (re-run before the DTU pass so the environment builds the gated code)

```bash
cd /home/ken/workspace/muxterm
go build ./... && echo BUILD_OK
go vet ./... && echo VET_OK
gofmt -l ./cmd ./internal/config ./internal/server ./internal/authserver && echo "GOFMT_CLEAN (no files listed above)"
```

Expected:

```
BUILD_OK
VET_OK
GOFMT_CLEAN (no files listed above)
```

**Verification**

The steps above are the verification. Checks (a)–(e) must produce their expected output from the real DTU environment; check (f) is the host-side source-scope assertion in Step 8. If any check cannot be executed (e.g. Incus unavailable on the host, or `playwright-cli` missing from the DTU image), STOP and report the gap explicitly — do not mark the feature verified on partial evidence, do not run the browser check from the host as a substitute, and do not substitute reasoning for observed output.

**Commit**

Verification-only; no repository files change. Record the evidence in the completion report. If the DTU profile is to be kept for future runs (only on explicit request):

```bash
cd /home/ken/workspace/muxterm
git add .amplifier/digital-twin-universe/profiles/muxterm-reverse-proxy.yaml
git commit -m "$(cat <<'EOF'
chore(dtu): add the muxterm reverse-proxy verification profile

Reproduces the production muxterm.ampbox.io topology (Caddy fronting
muxterm) for the Phase 3 behind_reverse_proxy end-to-end checks.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Deviations from the design document, and why

Recorded so a reviewer can see these are deliberate, not oversights:

1. **The design's Architecture table rows for `internal/service/service.go` and `internal/deploy/ssh.go`** ("Default `Addr` changed from `0.0.0.0:8311` to `127.0.0.1:8311`" and the `0.0.0.0:8080` → `127.0.0.1:8080` row), **its `cmd/muxterm/cli_test.go` / `internal/service/service_test.go` / `internal/deploy/ssh_test.go` row, its Deployment Note step 3, and its Testing Strategy check (f)** are **superseded by the design's own Section 4 amendment**, which is the later, post-incident, authoritative text: "This design does NOT change `serve` mode's default bind address... those files are **out of scope**." This plan follows Section 4. Check (f) is inverted **and narrowed** accordingly: it is now a pure source-scope assertion that this plan's diff touched neither file, plus a grep confirming their `0.0.0.0` literals survive. It deliberately makes **no** claim about an installed unit's `ExecStart` or a live `ss` listener — `parseInstall` defaults `--addr` to `127.0.0.1:8311`, so a flagless install genuinely produces `127.0.0.1:8311`, and `service.DefaultConfig()`'s `0.0.0.0:8311` is reached only by an existing test, never by the install CLI path. That installed default is correct, unchanged, and orthogonal to this plan, which implements `behind_reverse_proxy` at the config and middleware layer.
2. **The design's `cmd/muxterm/main.go` row says "Default `--addr` flag value updated per point 4."** No change is made: `parseServe` and `parseInstall` already default to `127.0.0.1:8311` (`cmd/muxterm/cli.go:120` and `cli.go:168`), and point 4 as amended changes no default anyway.
3. **No RFC 8414 or RFC 9728 endpoint is created.** Verified by grep that neither document nor a `POST /mcp` route exists anywhere in the codebase — they are Phase 2 (MCP-over-HTTP) surface. The design only requires that such URLs, *when built*, use the same derivation; building them now would be unapproved scope. Task 6 pins that requirement in the code where it will be seen.
4. **No env-var precedence layer is added.** The design's Deployment Note mentions "flag, env var, or config file per `internal/config`'s existing precedence," but `internal/config` has no env-var mechanism today (`config.Load` reads TOML only; `DefaultPath` reads `XDG_CONFIG_HOME`/`HOME` for the file location). Adding one would be inventing a new config mechanism, which the task brief forbids. Flag-over-file precedence is implemented; the systemd unit's `ExecStart` flags are the operator's path.
5. **The new fields are excluded from `config.Merge`.** `Merge` backs the browser-facing `PATCH /api/config` route; letting a web request flip `behind_reverse_proxy` would make a security control remotely mutable. The design does not ask for it to be mergeable.
