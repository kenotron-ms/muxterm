# muxterm Self-Sufficient PAM/Native-OS Authentication Design

**Date:** 2026-08-02

## Goal

muxterm becomes self-sufficient in gating access to the machine — authenticating and authorizing on its own, without depending on an external identity provider. It runs its own minimal OAuth 2.0 Authorization Server, with the OS account's own credentials (PAM on Linux, OpenDirectory's `ODRecord.verifyPassword(_:)` on macOS, `LogonUser` on Windows) as the exactly-one way to prove identity. Three surfaces — the web UI, MCP-over-HTTP, and future native companion apps — consume this Authorization Server as OAuth clients.

## Background / Current State

muxterm currently has no real authorization model of its own:

- It has been "crutching it" with Caddy + oauth2-proxy in front of the app — an external, unversioned host configuration that muxterm itself has no knowledge of or control over.
- For non-loopback callers not behind that proxy, `internal/server/auth.go` implements a legacy 30-second HMAC query-token scheme (`GenerateSecret`, `GenerateToken`, `ValidateToken`) — a home-grown, short-TTL signed-timestamp token, not a real auth protocol.
- `sessiond` (`internal/sessiond/*`) trusts only its Unix-socket peer via a same-UID check (`SO_PEERCRED` on Linux, socket permissions elsewhere). It has never had, and does not need, any broader notion of identity.
- A genuinely local TCP peer bypasses authentication entirely today, via `IsLocalhost()` in `internal/server/auth.go`.
- MCP (`internal/mcp/server.go`) is currently stdio-only, JSON-RPC 2.0 over stdio — there is no HTTP transport for it yet.
- A prior design (`docs/designs/2026-06-30-native-companion-apps-design.md`) proposed native Swift/Kotlin companion apps that reach muxterm remotely via an SSH tunnel + SOCKS proxy, implicitly relying on SSH keys as an "auth dividend" standing in for muxterm's own authentication.

This design replaces the external-proxy dependency and the HMAC scheme with a real, versioned, self-hosted authorization server, and defines how all three client surfaces authenticate against it.

## Chosen Approach

### Alternatives Considered

1. **Hand-rolled minimal Authorization Server** (initially proposed) — **REJECTED**. OAuth protocol correctness (PKCE verifier/challenge validation, authorization-code expiry and single-use enforcement, replay protection) is exactly the kind of subtle security-critical logic that should not be hand-rolled from scratch. Getting any one of these details wrong silently reopens the gate this whole design exists to close.

2. **Full framework (`ory/fosite`)** — **REJECTED as overkill**. `fosite` is built for multi-tenant OIDC providers: dynamic client registration, consent screens, session managers, and multi-account token lifecycles. muxterm has exactly one authorized principal and exactly two hardcoded clients — most of `fosite`'s surface area would sit permanently unused, adding maintenance and conceptual overhead with no corresponding benefit.

3. **`github.com/go-oauth2/oauth2` (v4)** — **CHOSEN**. A composable Go OAuth2 *server library* (not a framework), implementing RFC 6749 authorization-code grant + PKCE correctness as pluggable interfaces (`ClientStore`, `TokenStore` / `AuthorizeCodeStore`). muxterm supplies:
   - Two hardcoded `ClientStore` entries (`muxterm-web`, `muxterm-mcp`) — no dynamic client registration.
   - A small local file-backed token store matching `internal/config`'s existing XDG conventions, implementing the library's `TokenStore` interface.
   - Its own `/authorize` HTTP handler that renders the login form and calls the platform-specific login backend.

   The library owns PKCE verifier/challenge validation, authorization-code single-use/expiry enforcement, and token issuance correctness. muxterm owns only the resource-owner verification step (PAM/native) and storage wiring — the minimum surface area needed for protocol correctness without adopting unneeded framework weight.

Also explicitly considered and rejected: **GitHub OAuth** (reusing the existing oauth2-proxy GitHub app as the external IdP). This was the original starting point before PAM-based self-sufficiency was confirmed viable. Once muxterm can authenticate natively against the OS account, an external IdP adds no value — it reintroduces exactly the external dependency this design exists to remove.

## Architecture / Components

### 1. `internal/authserver`

Wraps `go-oauth2/oauth2`. Responsibilities:

- Hosts the `/authorize` and `/token` HTTP handlers.
- Configures two hardcoded OAuth clients via the library's `ClientStore` interface: `muxterm-web` (public client, PKCE, no client secret) and `muxterm-mcp` (bearer-token client, also PKCE, no dynamic registration).
- Provides a small local file-backed store (alongside `internal/config`'s existing conventions) implementing the library's `TokenStore` interface, for both authorization codes and issued access tokens.
- Tokens are **opaque and server-stored**, not JWTs — nothing outside `authserver` needs to independently verify a token's signature, so a self-verifying token format buys nothing and is not used.
- **Token/cookie lifetime:** access tokens and the browser session cookie are **long-lived (e.g. ~30 days)**. There is deliberately **no refresh-token mechanism** — this matches a single-account personal tool where token-theft blast radius is lower stakes than a multi-tenant system, and periodic re-login (via PAM/OpenDirectory/`LogonUser`) is cheap and low-friction. When a token expires, the user simply logs in again through the normal `/authorize` flow.

### 2. `internal/authserver/loginbackend`

A minimal interface:

```go
type LoginBackend interface {
    Authenticate(password string) error
}
```

Three platform implementations selected via Go build tags:

- `pam_linux.go` — PAM via cgo (e.g. `github.com/msteinert/pam`).
- `opendirectory_darwin.go` — OpenDirectory's `ODRecord.verifyPassword(_:)` via a cgo/Objective-C bridge. **Correction from an earlier draft of this design:** `LocalAuthentication.framework` (`LAContext.evaluatePolicy`) was initially proposed but is wrong for this use case — it is an interactive local UI prompt (Touch ID/password sheet) shown to whoever is physically at the Mac's console session, cannot verify an arbitrary password string submitted through a remote web form, and generally requires an active WindowServer/GUI session, making it unsuitable for a headless background daemon. It cannot implement the `Authenticate(password string) error` contract. OpenDirectory's `ODRecord.verifyPassword(_:)` is Apple's real, documented, non-interactive API for verifying a plaintext password against a local (or directory-bound) user account — the actual macOS equivalent to what PAM does on Linux (confirmed via Apple's official documentation and a working example on the Apple Developer Forums: `ODSession` → `ODNode(session:type: kODNodeTypeLocalNodes)` → `node.record(withRecordType: kODRecordTypeUsers, name:, attributes:)` → `record.verifyPassword(password)`). Note also that real PAM itself is increasingly locked down on macOS by SIP/entitlement restrictions on `/etc/pam.d/` for third-party code, reinforcing OpenDirectory as the correct choice rather than a fallback.
- `logonuser_windows.go` — `LogonUser` Win32 API via `golang.org/x/sys/windows`.

Since `sessiond` only ever runs as a single OS user and has no privilege to act as any other, there is no multi-account login to build — account identity is implicit. `/authorize` renders a minimal password-only form and calls `Authenticate()` with the submitted password.

### 3. Auth middleware in `internal/server`

Replaces the current `IsLocalhost()`-or-HMAC-token check on `/ws`, `/api/*`, `/t/*`. New logic:

- Loopback bypass **stays, unchanged** — a genuinely local TCP peer (checked via `RemoteAddr`, same mechanism as today's `IsLocalhost()`) still skips authentication entirely.
- Otherwise, require a valid session:
  - Browser callers: HttpOnly, Secure session cookie.
  - All other callers: `Authorization: Bearer <token>` header.
  - Both validated against `authserver`'s token store.
- `internal/server/auth.go`'s HMAC scheme (`GenerateSecret`, `GenerateToken`, `ValidateToken`) is **deleted**, not kept in parallel.
- **Tunnel credential stripping (new requirement):** the `/t/{id}/...` reverse proxy handler forwards incoming request headers — including `Cookie` and `Authorization` — to the tunneled target application today. Because that target is rendered under muxterm's own origin, and the browser session cookie must cover `/ws` and `/api/*`, an unmodified request to a tunneled path would carry muxterm's own session credentials to that tunneled (potentially untrusted, arbitrary local dev server) target, letting it read or replay the muxterm session. The `/t/*` proxy handler **must strip the muxterm session cookie and `Authorization` header before forwarding** the request to the tunneled target — the tunneled application never needs, and must never receive, muxterm's own auth credentials. This closes a credential-leak/session-hijack vector that predates this design but is newly relevant now that a real, valuable session credential (not just a throwaway 30-second HMAC token) sits behind that cookie.

### 4. New `POST /mcp` route in `internal/server`

- Protected by the same bearer-token middleware as above (loopback bypass applies here too, per the trust-boundary analysis below).
- Bridges HTTP request/response to the existing stdio-oriented `mcp.Server` (`internal/mcp/server.go`).
- The exact adapter mechanics — how a stdio-oriented `bufio` / `json.Encoder`-based server accepts per-request HTTP bodies — are an implementation detail deferred to plan/implementation time (see Open Questions).

### `sessiond` — untouched

`internal/sessiond/*` requires **zero changes**. It remains Unix-socket-only, gated by the existing same-UID check. No protocol or code changes.

### Trust boundary analysis: MCP-via-stdio-then-socket

The path where MCP connects directly to `sessiond` via stdio, then via the Unix socket, was analyzed as part of this design. It already sits safely within the same trust boundary as the loopback bypass: MCP-over-stdio is local-process-to-local-process, never network-exposed. This was true before this design and remains true — it needs no special handling here. (This is distinct from the new `POST /mcp` HTTP route, which *is* network-reachable and therefore *is* gated by the new middleware.)

### 5. TLS termination — Caddy retained, scoped to HTTPS only

muxterm does **not** terminate TLS itself and does **not** implement its own ACME/certificate-management stack. Caddy is reused, but strictly for TLS termination — not authentication. Auth is fully removed from Caddy's job everywhere else in this design; Caddy's only remaining role, when present at all, is HTTPS. This reuses Caddy's existing automatic-HTTPS/cert-renewal capability rather than muxterm reinventing it, consistent with ruthless simplicity — don't rebuild what a mature tool already does well.

Two deployment modes:

1. **Direct/local-dev mode (default, unchanged):** muxterm listens on plain HTTP directly, with no proxy in front. The existing loopback bypass (`RemoteAddr`-based, via `IsLocalhost()`-equivalent logic in the new middleware) applies normally to genuinely local same-box traffic.
2. **Caddy-fronted HTTPS mode:** Caddy terminates TLS and reverse-proxies to muxterm's HTTP listener. In this mode, **muxterm's loopback bypass MUST be explicitly disabled** via an opt-in config flag (e.g. `behind_reverse_proxy: true` — exact name is an implementation detail). This is **not** auto-detected and **not** based on trusting a forwarded-for header (headers are spoofable, and this design already rejected trusting them elsewhere). When this flag is set, all traffic reaching muxterm authenticates through the AS regardless of apparent origin — because Caddy's own connection to muxterm would otherwise look like loopback traffic and silently grant the bypass to what might be a genuinely remote, unauthenticated caller, defeating the entire point of this design.

This is a **security-critical configuration requirement**, not an optional nicety: deploying muxterm behind Caddy (or any reverse proxy) without setting this flag reopens the exact vulnerability class this whole design exists to close.

### SSH removed from the trust story

The native companion apps design (`docs/designs/2026-06-30-native-companion-apps-design.md`) relied on an SSH tunnel + SOCKS proxy for remote reachability, implicitly using SSH keys as an "auth dividend" that bypassed muxterm's own gate. This is **explicitly rejected**: it would let external SSH/`authorized_keys` trust silently bypass muxterm's own authentication, defeating the point of self-sufficient auth. SSH is removed from the trust story entirely. Native companion apps will instead authenticate via the same bearer-token OAuth flow as MCP-over-HTTP. **This invalidates the remote-connectivity portions of that native companion apps design** (the SSH tunnel and SOCKS proxy for the browser pane) — a replacement remote-reachability mechanism is out of scope for this design and requires separate future rework (see Open Questions).

## Data Flow

muxterm is a single Go binary — there is no separate relay or "web app backend." `internal/server` is the one component that both serves the SPA/static frontend and performs the OAuth code-for-token exchange at `/token` server-side; it is the OAuth client for its own first-party web UI, not a separate backend service.

**Browser login:**
1. Unauthenticated request to a protected page — the static SPA route itself is now subject to the auth check — is redirected by `internal/server` to `/authorize?client_id=muxterm-web&response_type=code&code_challenge=...` (PKCE, no client secret — public/first-party client). This is a change in scope worth being explicit about: `internal/server` currently mounts static file serving with no auth middleware at all; this design adds the middleware there too, alongside `/ws`, `/api/*`, `/t/*`, and the new `/mcp`.
2. `authserver` renders the password form.
3. Submitted password is passed to `loginbackend.Authenticate()`.
4. On success, `go-oauth2/oauth2` issues a single-use, short-TTL authorization code.
5. Redirect back to `internal/server`'s own callback route with `code` + `state`.
6. `internal/server` exchanges `code` + PKCE verifier at `/token` (server-side, same binary, same process), receiving an access token.
7. Access token is set as an HttpOnly, Secure cookie.
8. Subsequent requests (including the `/ws` upgrade) present the cookie; middleware validates it against the token store.

**MCP-over-HTTP:**
1. Same `/authorize` → `/token` PKCE exchange as above, but the resulting access token is held by the MCP client itself (its own config/credential storage).
2. Sent as `Authorization: Bearer <token>` on every `POST /mcp` call — no cookie involved.
3. Client id `muxterm-mcp` is pre-registered; no dynamic client registration is supported.

**Loopback:**
A genuinely local TCP peer never touches `/authorize` at all — it bypasses the entire auth flow, unchanged from today's behavior.

**Logout:**
Deletes the corresponding token row from the store. Since tokens are opaque and store-backed (not self-verifying JWTs), revocation is simply deletion — no blacklist or JWT-revocation complexity is needed.

## Error Handling

- **Wrong password:** Generic "invalid credentials" message on the login form — no account-enumeration distinction (moot with one account, but consistent practice). **Rate limiting/lockout is a hard requirement, not optional.** PAM/native auth now gates the entire machine with a real OS password, so failed remote attempts must be throttled (e.g., exponential backoff or a hard cap such as 5 attempts / 15 minutes per source). This was not a concern under the old HMAC scheme; it is now, since a real password is the thing being protected against brute force.
- **Expired/reused/invalid authorization code:** Standard OAuth error response — redirect to the client with `error=invalid_grant`. Enforced natively by `go-oauth2/oauth2`'s single-use/short-TTL code handling; muxterm does not re-implement this logic.
- **Invalid/expired access token on a protected route:** Browser callers get a 401 that triggers a redirect to `/authorize` (re-login prompt). MCP/bearer callers get a plain `401 {"error":"invalid_token"}` JSON body, with no redirect (there is no browser to redirect). Since tokens and the session cookie are long-lived (~30 days, no refresh-token mechanism — see `internal/authserver` in Architecture/Components), this expiry path is only reached roughly monthly in normal use; the user's only recourse on expiry is a normal re-login through `/authorize`, which is treated as cheap and expected, not an error condition to work around.
- **Redirect URI validation:** Strictly matched against the pre-registered URI for each of the two hardcoded clients — no wildcard matching. This prevents open-redirect attacks via a crafted `redirect_uri` parameter.
- **Login backend unavailable** (e.g., PAM cgo init failure, missing platform API): **Must fail closed** — deny all non-loopback access rather than silently falling back to "no auth required." This is the one failure mode that must never fail open, since PAM/native auth is now the sole gate for remote access.
- **Logout failure:** If the token-store deletion write fails, respond with an error rather than claiming success — never report a token as revoked when the deletion did not actually succeed.

## Testing Strategy

Per this repo's `AGENTS.md` testing policy: no unit tests are permitted, no mocked PAM. Verification means running the real thing end-to-end with a real browser and a real backend process.

- **Login flow (Linux/PAM) via Digital Twin Universe:** Delegate to `digital-twin-universe:dtu-profile-builder` to stand up an isolated Linux container with muxterm built and running, plus a dummy OS user account created specifically for this test with a known, throwaway password (never a real developer credential). Drive `playwright-cli` against that real environment's real login form — real PAM stack, real `/etc/shadow` check, zero mocking. Test both:
  - Happy path: correct password → cookie set → protected page loads.
  - Failure path: wrong password → generic error, no redirect.
  Both against the disposable dummy account.
- **Rate limiting:** Same DTU instance — script N+1 failed logins via `curl` or `playwright-cli` against the dummy account, observe that lockout/backoff engages on the (N+1)th attempt.
- **MCP-over-HTTP:** Same DTU (or local dev box) — script the `/authorize` → `/token` PKCE exchange via `curl`, then call `POST /mcp` with the resulting bearer token and a real JSON-RPC payload, observe a real response from real `sessiond`. Separately verify a missing/garbage bearer token gets a real 401.
- **Loopback bypass regression:** Confirm genuinely local requests still skip `/authorize` entirely — no behavior change to the existing trusted path.
- **macOS (OpenDirectory's `ODRecord.verifyPassword(_:)`) and Windows (`LogonUser`):** DTU is Linux-container-based and cannot cover these. Requires direct manual `playwright-cli` verification on real macOS and real Windows machines, using the developer's own real account (no throwaway-account trick is available on those platforms outside a container). This is documented here as an explicit limitation of this testing strategy, not swept under the rug.

## Open Questions

- **`POST /mcp` HTTP transport contract:** This is not merely an adapter-mechanics detail. `mcp.Server` has connection-scoped state (subscriptions, asynchronous resource notifications), so the implementation plan must explicitly choose a concrete HTTP transport contract — e.g. a defined MCP Streamable HTTP version vs. a simpler stateless request/response wrapper — including initialization/session behavior, the response/notification delivery mechanism, and server-instance lifecycle. Left unresolved, different implementers could build incompatible things, and standard MCP clients might fail to interoperate with either. This remains deferred to plan/implementation time (this design fixes only the route, its protection via bearer-token middleware, and the trust boundary), but it is a required decision point for the plan-writer, not a minor implementation detail.
- **Native companion app remote-reachability replacement:** Removing SSH as an implicit trust mechanism invalidates the remote-connectivity portions of `docs/designs/2026-06-30-native-companion-apps-design.md` (the SSH tunnel and SOCKS proxy used for the browser pane). A replacement mechanism for reaching muxterm remotely from native companion apps — now that they authenticate via bearer token against this Authorization Server instead of riding on SSH — is a separate future design, out of scope here.

## Out of Scope

- Multi-user/multi-account support — impossible given `sessiond`'s single-UID architecture, and not needed.
- Native companion app remote-reachability mechanism now that SSH is removed (see Open Questions).
- Token revocation UI/admin tooling beyond basic logout.
- Dynamic OAuth client registration — exactly two hardcoded clients (`muxterm-web`, `muxterm-mcp`) for the foreseeable future.
