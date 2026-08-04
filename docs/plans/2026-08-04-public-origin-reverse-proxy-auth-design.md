# Phase 3: `public_origin` / `behind_reverse_proxy` Wiring

**Date:** 2026-08-04

## Goal

Implement Phase 3 of `docs/plans/2026-08-02-self-sufficient-auth-design.md` exactly as already specified in that doc's "TLS termination" (section 5) and "Client model" sections: make muxterm's OAuth redirect URI, protected-resource/AS metadata, and loopback-bypass gating derive from an explicit, operator-configured public origin when running behind a reverse proxy — instead of from muxterm's own bind address. This closes the concrete bug where a remote browser is redirected to an unreachable `127.0.0.1:<port>` URL after login.

This document makes **no new design decisions**. Every choice here (opt-in flags, no header-trust, exact-match redirect URI, bind-address invariant, fail-closed validation) was already decided in the 2026-08-02 doc. This is the implementation design that fills the gap those decisions left open.

## Background / Current State

The 2026-08-02 doc specified the full self-sufficient PAM-based OAuth system (Phase 1: loopback-only) and explicitly deferred one piece to a later phase:

> "In Caddy-fronted HTTPS mode... muxterm's loopback bypass MUST be explicitly disabled via an opt-in config flag (e.g. `behind_reverse_proxy: true`)... the operator MUST also set `public_origin`... `public_origin` is therefore a required, explicitly-configured value in this mode."

That deferral is now marked in code as literal TODO-style comments in three places, never implemented:

- `cmd/muxterm/main.go` — `webRedirectURIFor(addr string)` (lines ~189–200): derives the redirect URI once at process startup from `cfg.Addr`, normalizing `0.0.0.0`/unparseable host to `127.0.0.1`. Comment: *"Phase 3 will derive this from public_origin when behind_reverse_proxy is set."*
- `internal/authserver/authserver.go` — `Config.WebRedirectURI` doc comment references the same deferred Phase 3 behavior.
- `internal/authserver/clientstore.go` — `NewClientStore` doc comment references the same deferral. Its actual redirect-URI validation is already correct for this design: a plain string equality check against whatever `WebRedirectURI` value it's given — **no code change needed there**, only what value it's given needs to change.

**The bug this fixes:** a user connecting to `muxterm.ampbox.io` from an Android phone, after submitting the login password, was redirected to `http://127.0.0.1:<port>/auth/callback` — unreachable from the phone, since `webRedirectURIFor` derived the URI from muxterm's own listen address (`0.0.0.0:9090` in serve mode → normalized to `127.0.0.1:9090`), with no way to know the external hostname the browser actually used, and no per-request derivation existing at all.

Also unresolved today: nothing forwards or reads `X-Forwarded-Host`/`X-Forwarded-Proto`, and per the parent doc, nothing should — nothing here changes that; this design derives the public origin from explicit config, never from headers.

## Chosen Approach

All six points below are the parent doc's already-made decisions, applied to specific files.

### 1. New config fields: `public_origin`, `behind_reverse_proxy`

Added to `internal/config`, following its existing XDG-conventions pattern (same struct/loading mechanism as other config fields):

- `public_origin string` — e.g. `"https://muxterm.ampbox.io"`. The canonical public HTTPS origin at which muxterm is reachable through the reverse proxy. Empty by default.
- `behind_reverse_proxy bool` — opt-in, default `false`.

Both are **explicit and opt-in**. Per the parent doc, these are never derived from request headers (`X-Forwarded-Host`, `X-Forwarded-Proto`, or anything else) — headers are spoofable and the parent doc already rejected trusting them for any trust-relevant value. `public_origin` is required (non-empty) whenever `behind_reverse_proxy` is `true`; see Error Handling.

### 2. `webRedirectURIFor` becomes reverse-proxy-aware

In `cmd/muxterm/main.go`, `webRedirectURIFor` (or its caller) gains an additional input: whether `behind_reverse_proxy` is set, and if so, `public_origin`.

- When `behind_reverse_proxy` is `true`: the `muxterm-web` redirect URI becomes exactly `<public_origin>/auth/callback` — a fully exact match, no variable component, computed once at startup from static config (not per-request, since `public_origin` is itself a fixed configured value, not derived from any individual request's Host header).
- When `behind_reverse_proxy` is `false` (default): behavior is **unchanged** — the existing loopback derivation from `cfg.Addr` (normalizing `0.0.0.0`/unparseable host to `127.0.0.1`) continues exactly as today. This preserves full backward compatibility for local/direct-mode users who never set the new flags.

`internal/authserver/clientstore.go`'s `validateRedirectURI` needs **no code change** — it already performs a plain string equality check against whatever `WebRedirectURI` value it's handed. Only the value fed into it (via `Config.WebRedirectURI` at construction) changes based on the new flags.

The same `public_origin`-derivation applies wherever else the parent doc calls for a public-facing URL to be derived from it when `behind_reverse_proxy` is true: the RFC 8414 `.well-known/oauth-authorization-server` metadata (`internal/authserver`) and the RFC 9728 `.well-known/oauth-protected-resource` metadata / canonical `/mcp` resource URI (`internal/server`'s `POST /mcp` route). These derivations follow the identical pattern already established for the web redirect URI — no separate decision required.

### 3. Loopback bypass disabled when `behind_reverse_proxy` is true

In `internal/server/authmiddleware.go`, the existing `IsLocalhost()` bypass is gated by the new flag:

- `behind_reverse_proxy == false` (default): bypass behaves exactly as it does today — unchanged.
- `behind_reverse_proxy == true`: the bypass is **disabled entirely**, unconditionally. All traffic — including Caddy's own loopback hop to muxterm — must authenticate through the real OAuth flow (session cookie or bearer token). This is a static, config-gated switch — not auto-detected, not based on any forwarded header. Per the parent doc's rationale: Caddy's loopback connection to muxterm is indistinguishable from a genuinely local caller at the `RemoteAddr` level, so leaving the bypass on when fronted by a reverse proxy would silently grant unauthenticated access to what may be genuinely remote traffic — defeating the entire point of Phase 3.

### 4. Bind-address invariant extended to `serve` mode

The parent doc's invariant (section 5): **muxterm's own HTTP listener binds `127.0.0.1`-only in both direct mode and Caddy-fronted mode.** Direct/local-dev mode already satisfies this. `serve` mode (the systemd-managed path) currently does not — several places default to `0.0.0.0`:

- `internal/service/service.go` — `Addr: "0.0.0.0:8311"` default.
- `internal/deploy/ssh.go` — `systemdUnit(secret, "0.0.0.0:8080")` and related default construction.
- `cmd/muxterm/main.go` / CLI arg parsing — default `--addr` value used when installing/serving.

This design changes those defaults so `serve` mode also binds `127.0.0.1` by default, consistent with Caddy now being the intended public-facing front door in both modes. This is a **deliberate default/behavior change**, not a new decision this doc is free to reconsider — the parent doc already states the invariant as non-negotiable; this closes the one place it wasn't yet applied.

**Compatibility consideration:** existing systemd units, deploy scripts, or `install.sh` invocations that currently rely on the `0.0.0.0` default to bind a genuinely public address (i.e., without Caddy in front) will stop being externally reachable once this ships, until the operator either (a) puts Caddy in front with `behind_reverse_proxy`/`public_origin` set (the supported path), or (b) explicitly passes an `--addr` overriding the new default back to `0.0.0.0` (unsupported/discouraged, since it reopens the exact loopback-bypass-vs-remote-traffic gap this design closes if `behind_reverse_proxy` isn't also set correctly). This must be called out in release notes for whatever version ships this change.

### 5. Fail-closed validation

At startup, if `behind_reverse_proxy` is `true` and `public_origin` is empty/unset, muxterm **must refuse to start** with a clear error — not silently fall back to loopback-derived URLs. This matches the parent doc's "Login backend unavailable" fail-closed pattern: an ambiguous or misconfigured security posture must deny, never silently downgrade. See Error Handling for the exact behavior.

### 6. Explicitly out of scope

- The actual production Caddy configuration fronting `muxterm.ampbox.io` (`/mnt/services/muxterm-dev.caddy`, outside this repo) is **not** touched by this design/PR. Enabling the fix in production is a separate ops action — see Deployment Note.
- The checked-in dev Caddyfile at the repo root (used by `make dev`) is **not** changed. It intentionally keeps today's loopback-bypass-friendly behavior for local development convenience and does not need `behind_reverse_proxy` enabled.

## Architecture / Components

| File | Change |
|---|---|
| `internal/config` | Add `PublicOrigin string` and `BehindReverseProxy bool` fields to the config struct, following existing XDG-conventions loading pattern (flag/env/config-file precedence consistent with other fields). Add fail-closed validation (see Error Handling). |
| `cmd/muxterm/main.go` | `webRedirectURIFor` (or its call sites) takes the new config into account: when `behind_reverse_proxy` is true, return `<public_origin>/auth/callback`; otherwise, unchanged loopback-derivation logic. Same pattern applied to AS/resource-server metadata URL construction where those are built in this file. Default `--addr` flag value updated per point 4. |
| `internal/authserver/authserver.go` | `Config.WebRedirectURI` doc comment updated to describe Phase 3 as implemented (no longer a TODO). No behavioral change here beyond what's fed into it by `main.go`. RFC 8414 metadata endpoint construction uses `public_origin` when `behind_reverse_proxy` is true. |
| `internal/authserver/clientstore.go` | Doc comment update only (Phase 3 now implemented). `validateRedirectURI`'s exact-match logic is unchanged — it already does the right thing given the right input. |
| `internal/server/authmiddleware.go` | `IsLocalhost()` bypass gated by `behind_reverse_proxy`: skipped entirely (never applied) when the flag is true. |
| `internal/server` (`POST /mcp` route / RFC 9728 metadata) | Canonical `/mcp` resource URI and `.well-known/oauth-protected-resource` document derive from `public_origin` when `behind_reverse_proxy` is true, matching the same derivation pattern as the web redirect URI. |
| `internal/service/service.go` | Default `Addr` changed from `"0.0.0.0:8311"` to `"127.0.0.1:8311"`. |
| `internal/deploy/ssh.go` | Default address used in `systemdUnit(...)` construction and related deploy defaults changed from `0.0.0.0:8080` to `127.0.0.1:8080`. |
| `cmd/muxterm/cli_test.go`, `internal/service/service_test.go`, `internal/deploy/ssh_test.go` | Existing tests asserting the `0.0.0.0` default will need their expected values updated to match the new `127.0.0.1` default — noted here since these are pre-existing checked-in tests (per this repo's AGENTS.md, no *new* unit tests are added, but existing ones that assert the old default must be corrected to reflect the new one, not left asserting stale behavior). |

## Data Flow

**Browser login, Caddy-fronted mode (`behind_reverse_proxy: true`, `public_origin: "https://muxterm.ampbox.io"`):**

1. Browser on a remote device (e.g. Android phone) requests `https://muxterm.ampbox.io/...`. Caddy terminates TLS and reverse-proxies to muxterm's `127.0.0.1`-bound listener.
2. muxterm's auth middleware sees `behind_reverse_proxy: true` — the `IsLocalhost()` bypass is not applied, regardless of the fact that the connection arrived from Caddy's own loopback hop. The request is treated as unauthenticated and redirected to `/authorize?client_id=muxterm-web&response_type=code&code_challenge=...&redirect_uri=https://muxterm.ampbox.io/auth/callback`.
3. `authserver` renders the password form (unchanged from Phase 1).
4. On success, `go-oauth2/oauth2` issues a single-use authorization code and redirects to `redirect_uri` — now correctly `https://muxterm.ampbox.io/auth/callback`, i.e. back through Caddy to the phone's browser, not to a loopback address.
5. `internal/server` exchanges `code` + PKCE verifier at `/token` (server-side, same process), receives an access token, sets it as an HttpOnly/Secure cookie.
6. Subsequent requests, including the `/ws` upgrade, present the cookie through Caddy; middleware validates it against the token store — unchanged from Phase 1, since `behind_reverse_proxy` only affects the loopback-bypass decision and redirect-URI derivation, not token validation itself.

**Direct/local-dev mode (`behind_reverse_proxy: false`, default) — unchanged:** loopback bypass and `127.0.0.1`-derived redirect URI behave exactly as in Phase 1.

## Error Handling

- **`behind_reverse_proxy: true` with empty/unset `public_origin`:** hard startup error. muxterm refuses to start (non-zero exit, clear error message identifying the missing `public_origin` field and the flag that requires it). This is a fail-closed configuration validation, run once at process startup before the HTTP listener binds — consistent with the parent doc's "Login backend unavailable" pattern of denying rather than silently falling back to a less-secure derivation (e.g. silently reusing the loopback URL, which would reproduce the exact bug this design fixes).
- **`behind_reverse_proxy: false` (default), any value of `public_origin`:** `public_origin` is ignored entirely in this mode (not an error) — it's simply inapplicable, matching the parent doc's statement that `public_origin` is "not needed and not applicable" in direct/local-dev mode.
- **Loopback bypass disabling:** no new error path — the bypass is simply not consulted when `behind_reverse_proxy` is true; requests that would have been bypassed now proceed through the standard unauthenticated-request handling (redirect to `/authorize` for browser routes, `401` for API/bearer routes), identical to how any other unauthenticated non-local request is already handled today.
- **Existing Phase 1 error-handling behavior** (wrong password, expired/reused auth code, invalid/expired token, redirect-URI mismatch, login-backend-unavailable fail-closed) is entirely unchanged by this design — no modifications to those paths.

## Deployment Note

**In scope (this repo/PR):** adds the capability (`public_origin`, `behind_reverse_proxy` config fields; redirect-URI/metadata derivation; loopback-bypass gating; `127.0.0.1` default bind in `serve` mode). Does not itself fix the live `muxterm.ampbox.io` bug — that requires an operator action outside this repo.

**To actually fix the live bug once this ships, the operator must:**

1. Update muxterm's config (flag, env var, or config file per `internal/config`'s existing precedence) to set:
   - `behind_reverse_proxy: true`
   - `public_origin: "https://muxterm.ampbox.io"` (or whatever the real external origin is)
2. Confirm the production Caddy config at `/mnt/services/muxterm-dev.caddy` reverse-proxies to muxterm's `127.0.0.1`-bound port and terminates TLS for `muxterm.ampbox.io` — this file lives outside this repo and is **not modified by this PR**. If it isn't already configured this way, that's a separate ops change.
3. Restart the muxterm service so the new config and the new default `127.0.0.1` bind take effect.

**Out of scope for this PR:** any actual edit to the production Caddy config file, and any edit to the repo-root dev Caddyfile used by `make dev` (which intentionally keeps its current loopback-friendly behavior for local development and does not set `behind_reverse_proxy`).

## Testing Strategy

Per this repo's `AGENTS.md` (no unit tests for behavior; real end-to-end verification only, via `playwright-cli` / muxterm's own MCP server against a real running instance):

- **Environment:** delegate to `digital-twin-universe:dtu-profile-builder` to stand up a muxterm instance with a fronting reverse proxy mimicking the real Caddy topology (a Caddy instance in the DTU reverse-proxying to muxterm's `127.0.0.1`-bound listener), configured with `behind_reverse_proxy: true` and `public_origin` pointing at the DTU's externally-reachable address (e.g. its Caddy-fronted hostname/port).
- **(a) Redirect URI correctness:** drive a real browser (`playwright-cli`, or muxterm's MCP server if more direct) through the login flow hitting the DTU's external-looking origin. Inspect the `redirect_uri` parameter on the outgoing `/authorize` request and the final browser redirect after password submission — both must reflect `public_origin`, never `127.0.0.1`.
- **(b) Login actually completes:** confirm the flow lands on a working authenticated session (protected page loads, cookie set, subsequent `/ws` upgrade succeeds) — not just a URL-shape check.
- **(c) Loopback bypass correctly disabled:** confirm a request reaching muxterm directly via Caddy's own loopback hop is **not** auto-authenticated via `IsLocalhost()` when `behind_reverse_proxy` is true — it must still require the real OAuth flow (i.e., an unauthenticated request through that path gets redirected to `/authorize` or receives `401`, not silently treated as trusted).
- **(d) Direct/local mode regression check:** with `behind_reverse_proxy: false` (default) in the same or a separate DTU instance, confirm the loopback bypass and existing loopback-derived redirect URI behave exactly as before — no regression to Phase 1 behavior.
- **(e) Fail-closed startup validation:** attempt to start muxterm with `behind_reverse_proxy: true` and `public_origin` unset/empty; confirm the process refuses to start with a clear error, rather than starting up with a silently-wrong (loopback) redirect URI.
- **(f) `serve`-mode default bind:** confirm a freshly installed/started `serve`-mode instance (no explicit `--addr`) binds `127.0.0.1`, not `0.0.0.0` — e.g. via `ss`/`netstat` inside the DTU, or by confirming an external connection attempt to the DTU's non-loopback address on that port fails to connect at the OS level.

## Open Questions / Out of Scope

- **Production Caddy config change** (`/mnt/services/muxterm-dev.caddy`) is a separate ops/deployment action, not part of this design or PR — see Deployment Note.
- **Dev Caddyfile** at the repo root is intentionally untouched — it keeps its current loopback-bypass-friendly convenience behavior for `make dev` and does not need `behind_reverse_proxy` enabled.
- **Existing `0.0.0.0`-default-asserting tests** (`cmd/muxterm/cli_test.go`, `internal/service/service_test.go`, `internal/deploy/ssh_test.go`) need their expected default values corrected to `127.0.0.1` as part of implementing point 4 — flagged here so the implementer doesn't miss updating pre-existing checked-in tests when changing the default they assert.
- **Migration/compatibility messaging:** whatever release ships this change should call out the `serve`-mode default bind-address change in release notes, since it's a behavior change for anyone currently relying on the `0.0.0.0` default without a fronting proxy (see Compatibility consideration under point 4).
