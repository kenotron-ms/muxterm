# Opt-In AI Capabilities: Claude SDK Selection and Settings Plumbing

**GitHub issue:** https://github.com/kenotron-ms/muxterm/issues/19

## Goal

Add an opt-in AI capability substrate to muxterm: a securely-stored Anthropic API key configurable from the Settings UI, a small `internal/ai` package wrapping the official Anthropic Go SDK, and a capability flag that flips from disabled to enabled when a key is saved — with no AI *feature* built in this pass.

## Background

muxterm has no AI integration today. Issue #19 asks us to settle two things before any AI feature is designed:

1. **Which SDK.** The issue links https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/go and asks us to confirm it is the right fit versus shelling out to the `claude` CLI or a provider-agnostic abstraction.
2. **The activation model.** AI must be inert unless the user supplies their own Anthropic API key, the key must live in Settings (not env-var-only, not a hidden flag), and AI-dependent UI must be hidden or clearly disabled when no key is present — no degraded or broken states.

The hard part is not the SDK. It is that **muxterm has no precedent for storing a secret in `config.toml`**, and the existing config pipeline is actively hostile to secrets:

- `GET /api/config` returns the entire `Config` struct as JSON to any authenticated caller (`internal/server/config_handler.go:13`).
- `applyConfigUpdate` writes the whole struct to `~/.config/muxterm/config.toml` and then calls `s.hub.BroadcastConfig(newCfg)`, pushing it to **every connected WebSocket client** (`internal/server/config_handler.go:42`).
- The MCP `get_config` tool proxies that same endpoint and returns the raw JSON body to an agent (`internal/mcp/tools_config.go:25`).

Anything placed in `Config` is therefore published three ways by construction. The closest existing precedent is `ServerConfig`, which is deliberately excluded from `Merge()` because it is trust-sensitive (`internal/config/config.go:28-53`) — but it is still returned by `GET /api/config`, so exclusion-from-`Merge` alone is not sufficient for a secret. The real precedent for secret material is `internal/authserver/tokenstore.go`, which keeps credentials out of the config file entirely in an owner-only `0600` file inside a `0700` directory, written atomically via tmp-file-plus-rename.

This design follows `tokenstore.go`, not `config.toml`.

## Clarifying Questions and Answers

These were raised and resolved during design. Assumptions are flagged; anything genuinely undecided is repeated under Open Questions.

**Q1. What problem does this actually solve, given no AI feature ships in this pass?**

It removes the two decisions that would otherwise be re-litigated in every future AI PR: which client library muxterm links against, and how a user's API key is stored and gated. The deliverable is a stable seam — `ai.IsAIEnabled()` on the backend and `store.aiStatus.enabled` on the frontend — that any later AI feature can gate on without re-deciding secret handling. A secondary and real benefit: it forecloses the tempting-but-wrong path of dropping `anthropic_api_key` into `Config`, which would silently broadcast the key to every browser tab and every MCP agent.

**Q2. Is the SDK in the issue link the Claude Agent SDK (CLI-wrapping) or the Anthropic API SDK?**

Verified by fetching the linked page: it resolves to `CLI, SDKs, and libraries → Client SDKs → Go SDK`, documenting `github.com/anthropics/anthropic-sdk-go` — the direct REST API client, not a `claude`-CLI wrapper. It requires Go 1.23+; muxterm is on Go 1.24.2. Latest release verified against the Go module proxy: **v1.62.0** (2026-08-06). There is no published Go Agent SDK module: `github.com/anthropics/claude-agent-sdk-go` and `claude-code-sdk-go` both 404 on GitHub and are absent from the module proxy. So the choice the issue was asking us to "confirm" is not actually a fork in the road — the linked SDK *is* the API SDK. See "SDK/Library Choice" for why that is also the right answer on the merits.

**Q3. Where does the key live, and how is it kept out of the three fan-out paths?**

In a dedicated `0600` file, `~/.config/muxterm/anthropic_key`, inside the existing `0700` config directory — never in `config.toml`, never in the `Config` struct, and therefore structurally incapable of reaching `GET /api/config`, `BroadcastConfig`, or MCP `get_config`. It is managed by a parallel, deliberately one-way endpoint family (`/api/ai/*`): the key goes **in** via `PUT`, and only a derived, non-reversible *status* comes back out. No route ever returns the key. Assumption made without asking the user: `ANTHROPIC_API_KEY` in the server process environment is honored as a lower-precedence fallback, because a developer running `make dev-local` should not have to click through Settings, and the issue's "not env-var-only" constraint bars env as the *sole* mechanism, not as a fallback.

**Q4. What does "fully inert with no key configured" mean concretely?**

Three properties, each independently checkable: (a) `ai.IsAIEnabled()` returns `false` and `ai.Client()` returns `ErrDisabled` without constructing an SDK client or opening a socket; (b) `GET /api/ai/status` reports `{"enabled": false, "source": "none"}`; (c) the frontend renders the AI settings tab in an explicit "AI features are off — add a key to enable" state rather than a half-working control. Since no AI feature exists yet, (c) is the whole of the UI surface in this pass — but the flag it publishes is the one future features gate on.

**Q5. How is this verified, and what would falsify it?**

Live HTTP against a real running `./bin/muxterm` plus a real browser via `playwright-cli` — per this repo's AGENTS.md, no unit tests. The check that could actually fail: `curl -s localhost:PORT/api/config | grep -F "$KEY"` must return nothing, and `grep -F "$KEY" server.log` must return nothing, after a key has been saved and the status endpoint reports `enabled: true`. That single pair of greps is what distinguishes this design from the naive `config.toml` implementation — the naive one fails both. Full sequence in "Verification Approach".

## SDK/Library Choice

**Decision: `github.com/anthropics/anthropic-sdk-go` v1.62.0.**

Alternatives considered:

| Option | Verdict | Reason |
|---|---|---|
| `github.com/anthropics/anthropic-sdk-go` | **Chosen** | Pure Go, no runtime prerequisites, official, actively released. Auth is exactly `option.WithAPIKey(key)` — a direct match for the issue's "user supplies their own API key" model. |
| Claude Agent SDK for Go | Not available | No such published Go module. The issue's link resolves to the API SDK above. |
| Shell out to the `claude` CLI | Rejected | Imposes a Node.js runtime and a separately-installed `claude` binary on every muxterm host. muxterm ships as one self-contained binary with the frontend embedded (`web/embed.go`) and installs as a system service (`internal/service`, `internal/deploy`); a hidden Node dependency would break single-binary install. Its auth model also centers on subscription OAuth rather than a user-supplied API key. |
| Provider-agnostic abstraction layer | Rejected (for now) | YAGNI. Issue #19 says Anthropic. An abstraction with exactly one implementation and zero known second consumers is speculative. `internal/ai` is small enough to grow an interface later if a second provider is ever actually requested. |

Consequences accepted: this is a direct-to-Anthropic HTTP client. It gets no agent-loop, tool-use orchestration, or session management for free — those live in the SDK's `Messages` primitives and would be muxterm's job to build. That is the correct trade for a codebase whose distribution model is a single static binary.

Notable SDK behaviors relevant to us: automatic retry (2 attempts, exponential backoff) on connection errors, 408/409/429, and 5xx; typed `*anthropic.Error` carrying `StatusCode` and `RequestID`; and `apierr.DumpRequest(true)` which serializes the full outbound HTTP request **including the `x-api-key` header**. That method must never be called in muxterm — see Error Handling.

## Approach

Two parallel pipelines, deliberately not merged:

```
config.toml pipeline  (existing, unchanged)     ai key pipeline  (new)
──────────────────────────────────────────      ─────────────────────────────
Config struct                                    (nothing in Config)
  → GET  /api/config    (full struct out)        → GET    /api/ai/status  (status only, never the key)
  → PATCH /api/config   (merge + persist)        → PUT    /api/ai/key     (key in, status out)
  → BroadcastConfig     (to all WS clients)      → DELETE /api/ai/key     (clear, status out)
  → MCP get_config                               → POST   /api/ai/ping    (proves the SDK links and works)
  → config.toml (0644-ish)                       → ~/.config/muxterm/anthropic_key (0600)
                                                 → BroadcastAIStatus (status only, to all WS clients)
```

The key is write-only across the API boundary. Every read path returns a `Status`, never the secret.

## Architecture

```
                     browser
                        │
   settings-surface.ts ─┤ PUT /api/ai/key {"apiKey":"sk-ant-..."}
   (AI tab, password    │ GET /api/ai/status
    input, write-only)  │
                        ▼
              internal/server (protect() middleware)
                   ai_handler.go
                        │
                        ▼
                   internal/ai
        ┌───────────────┼────────────────┐
   KeyStore        Capability         Client
   (0600 file,     (Status/           (lazy anthropic.NewClient,
    atomic write)   IsAIEnabled)       rebuilt on key change)
        │                                   │
        ▼                                   ▼
 ~/.config/muxterm/anthropic_key   api.anthropic.com (x-api-key)
                        │
                        └──► hub.BroadcastAIStatus ──► all WS clients
```

`internal/ai` depends on nothing in `internal/server`. `internal/server` depends on `internal/ai`. `internal/config` is untouched.

## Components

### `internal/ai/keystore.go`

File-backed secret store, modeled directly on `internal/authserver/tokenstore.go`.

- Path: `$XDG_CONFIG_HOME/muxterm/anthropic_key`, defaulting to `~/.config/muxterm/anthropic_key` — the same directory that already holds `config.toml`, so the deployment story does not change.
- `Load() (string, error)` — reads and trims; missing file returns `("", nil)`, not an error (absent key is the normal default state, mirroring `config.Load`'s missing-file behavior).
- `Save(key string) error` — writes to `anthropic_key.tmp` with `0600`, `os.Chmod(tmp, 0o600)` to defeat a permissive umask, then `os.Rename` for atomicity. Parent dir created `0700`.
- `Clear() error` — removes the file; missing file is not an error (idempotent `DELETE`).
- On load, if the file's mode is not `0600`, log a warning naming the path (never the contents) and continue — a permission warning must not brick the server.

### `internal/ai/capability.go`

The capability gate. This is the seam future AI features consume.

```go
type Source string // "settings" | "env" | "none"

type Status struct {
    Enabled bool   `json:"enabled"`
    Source  Source `json:"source"`
    KeyHint string `json:"keyHint"` // "…a1b2" — last 4 chars only, "" when disabled
}

func (m *Manager) Status() Status
func (m *Manager) IsAIEnabled() bool   // Status().Enabled
```

Resolution precedence: stored key file → `ANTHROPIC_API_KEY` environment variable → none. The env fallback exists so `make dev-local` works without clicking through Settings; the Settings-stored key always wins so a user can override an inherited environment.

`KeyHint` is the last 4 characters, never the prefix (a prefix plus a known format is meaningfully more useful to an attacker than a suffix, and 4 trailing characters are enough for a human to answer "is this the key I think it is?"). If the resolved key is shorter than 8 characters, `KeyHint` is `""` — we do not emit a hint that is a large fraction of a short secret.

### `internal/ai/client.go`

```go
var ErrDisabled = errors.New("ai: disabled (no API key configured)")

func (m *Manager) Client() (anthropic.Client, error) // ErrDisabled when no key
func (m *Manager) Ping(ctx context.Context) (PingResult, error)
```

The client is constructed lazily and cached, guarded by a `sync.RWMutex` alongside a generation counter bumped by `Save`/`Clear`, so a key change invalidates the cached client rather than leaving a stale one authenticated with a removed key. When no key resolves, `Client()` returns `ErrDisabled` **without** constructing a client or touching the network — this is what makes "fully inert" a structural property rather than a UI convention.

`Ping` issues a minimal `Messages.New` (`MaxTokens: 1`, a one-word user message, Haiku-class model) with a short context timeout. It exists so this pass proves the SDK actually links, authenticates, and returns — rather than merely compiling against an import that is never exercised.

### `internal/server/ai_handler.go`

Four routes, all registered behind `protect()` exactly like the config routes:

| Route | Behavior | Codes |
|---|---|---|
| `GET /api/ai/status` | Returns `Status` JSON. | 200 |
| `PUT /api/ai/key` | Body `{"apiKey":"..."}`. Trims; rejects empty or `len < 16`. Saves `0600`, broadcasts, returns new `Status`. | 200, 400 |
| `DELETE /api/ai/key` | Clears the stored key, broadcasts, returns new `Status`. Idempotent. | 200 |
| `POST /api/ai/ping` | Calls `ai.Ping`. | 200, 503 (disabled), 502 (provider error) |

Validation is deliberately shallow — non-empty and a plausible minimum length. muxterm does not hardcode Anthropic's key format; a prefix check would become a compatibility bug the day the format changes, and the authoritative validity check is `POST /api/ai/ping`.

`hub.BroadcastAIStatus(Status)` mirrors the existing `BroadcastConfig`, sending a new `ai_status` WebSocket message so a key saved in one browser tab flips the capability in all others. It broadcasts the `Status` struct only — the same type the HTTP endpoint returns, which contains no secret by construction.

### `web/src/lib/ai.ts`

Deliberately separate from `lib/config.ts`; `AIStatus` is **not** a member of `ResolvedConfig`, so it cannot leak into `configToGoJSON()` and get PATCHed into the config pipeline.

```ts
export type AIStatus = { enabled: boolean; source: 'settings' | 'env' | 'none'; keyHint: string };
export async function fetchAIStatus(): Promise<AIStatus>
export async function saveAIKey(key: string): Promise<AIStatus>
export async function clearAIKey(): Promise<AIStatus>
export async function pingAI(): Promise<{ ok: boolean; error?: string }>
```

Note the absence of the `patchConfig()` debounce pattern: a secret is submitted explicitly on button press, never keystroke-debounced onto the wire.

### `web/src/components/settings-surface.ts` — AI tab

A new sidebar tab following the existing tab layout, containing:

- A status line: *"AI features are off — add an Anthropic API key to enable."* or *"AI enabled — key ending …a1b2 (from settings)."*
- `<input type="password">` for the key, rendered **empty on every load**. The stored key is never sent to the browser, so the field is genuinely write-only rather than password-masked-but-present.
- **Save** (disabled until the field is non-empty), **Remove** (shown only when a key is stored), and **Test connection** (calls `pingAI`, shows a one-line result).
- A short note that the key is stored locally at `~/.config/muxterm/anthropic_key` with owner-only permissions and is sent only to Anthropic.

`MuxStore.setAIStatus()` in `web/src/state.ts` holds the flag; the `ai_status` WS message updates it. `store.aiStatus.enabled` is the single frontend gate for all future AI UI.

## Data Flow

**Saving a key.** Settings input → `saveAIKey()` → `PUT /api/ai/key` (behind `protect()`) → `ai.Manager.Save` → atomic `0600` write → generation bump invalidates cached client → `hub.BroadcastAIStatus` → all tabs update `store.aiStatus` → response body carries the new `Status` back to the initiating tab.

**Reading capability.** Any consumer calls `ai.IsAIEnabled()` (backend) or reads `store.aiStatus.enabled` (frontend). Neither path can reach the secret.

**Using the key.** Only `ai.Client()` and `ai.Ping` touch it, and it leaves the process exclusively as the `x-api-key` header the SDK sets on requests to `api.anthropic.com`.

## Error Handling

- **No key configured.** `Client()`/`Ping` return `ErrDisabled`; the ping route maps this to `503` with `{"error":"ai_disabled"}`. Not a `500` — the server is healthy, the capability is simply off.
- **Provider rejects the key** (401/403). Mapped to `502` with `{"error":"provider_error","status":401,"requestId":"req_..."}`. The `RequestID` is returned because it is what Anthropic support asks for and it carries no secret.
- **`DumpRequest` is banned.** `*anthropic.Error` exposes `DumpRequest(true)`, which serializes the outbound request **including `x-api-key`**. `internal/ai` must never call it, and must never log `err` in a form that could transitively include it. A `redact(s string) string` helper replaces any occurrence of the resolved key with `[REDACTED]` and is applied to every error string that crosses the package boundary — defense in depth, so a future contributor logging an error cannot accidentally leak the key.
- **Key file unreadable / bad permissions.** Log a warning naming the path only, treat as no-key, stay up. Consistent with `config.Load`'s "a typo can never take the app down" rule.
- **Disk write failure on save.** Returns `500` and does **not** broadcast — the user must not see "enabled" for a key that did not persist. This diverges intentionally from `applyConfigUpdate`, which logs write failures and proceeds optimistically; that is right for a theme, wrong for a credential.

## Verification Approach

VDD level: **live HTTP against a real running server plus real browser observation.** No unit tests (repo AGENTS.md bans them). No mocks — a mocked config store cannot fail the leak greps, which are the checks that carry this design.

Static floor (required before commit): `go build ./...` clean, `cd web && npm run check:fast` at 0 errors.

Behavioral sequence, against a fresh `XDG_CONFIG_HOME` on a fresh `./bin/muxterm` (per AGENTS.md fixture hygiene — fresh state, not a reused one):

1. `curl -s $BASE/api/ai/status` → `{"enabled":false,"source":"none","keyHint":""}`.
2. `curl -X PUT $BASE/api/ai/key -d '{"apiKey":"sk-ant-test-VERIFY-0123456789"}'` → `200`, `{"enabled":true,"source":"settings","keyHint":"…6789"}`.
3. `stat -f %Lp ~/.config/muxterm/anthropic_key` → `600`.
4. **Leak check A:** `curl -s $BASE/api/config | grep -F 'VERIFY-0123456789'` → **no match** (exit 1). This is the check the naive `config.toml` implementation fails.
5. **Leak check B:** `grep -F 'VERIFY-0123456789' server.log` → **no match**. Also `grep -rF 'VERIFY' ~/.config/muxterm/config.toml` → no match.
6. Restart the server → `GET /api/ai/status` still `enabled:true` (persistence across restart).
7. `curl -X POST $BASE/api/ai/ping` with the fake key → `502` with `{"error":"provider_error","status":401}` and **no key substring in the body**. With a real key (manual, not automated — it costs a token): `200 {"ok":true}`. This is what proves the SDK links and authenticates rather than merely compiling.
8. `curl -X DELETE $BASE/api/ai/key` → `{"enabled":false,...}`; key file gone; `POST /api/ai/ping` → `503 ai_disabled`.
9. **Browser** (`playwright-cli`, fresh session): open Settings → AI tab → observe the disabled-state copy → type a key → Save → status text flips to enabled with the hint → reload the page → hint persists and the input renders **empty**. `playwright-cli` page content grep for the key substring → no match, confirming the key never reaches the DOM.
10. **Multi-client:** two browser tabs open; saving in tab A flips tab B's status without a reload (proves `BroadcastAIStatus`).

Steps 4, 5, 7, and the step-9 DOM grep are the falsifiable core: each names a specific production break (key in the config broadcast, key in logs, key echoed in an error body, key in the DOM) that the check would catch.

## Open Questions

Assumptions made rather than blocking the user, per the issue's scope guidance — each is a reversible decision, flagged here so it is reviewed rather than absorbed silently:

1. **Env-var fallback.** `ANTHROPIC_API_KEY` is honored at lower precedence than the stored key, reported as `source: "env"`. The issue says the setting must not be env-var-*only*; it does not forbid env as a fallback, and the dev-loop ergonomics are worth it. If reviewers disagree, deleting the fallback is a one-line change in `capability.go`.
2. **Key file location.** `~/.config/muxterm/anthropic_key` (alongside `config.toml`) rather than an OS keychain. A keychain integration is materially more code, platform-specific, and breaks headless server installs, which is muxterm's primary deployment. `0600` matching `authserver`'s token store is the existing bar in this repo.
3. **No MCP tool for the key.** MCP tools intentionally get no read or write access to the AI key. An agent that can read a config can read a key it should not have. Revisit only if a concrete need appears.
4. **`POST /api/ai/ping` is permanent, not scaffolding.** It stays as a user-facing "Test connection" affordance rather than being deleted once a real AI feature lands. Cheap and independently useful.
5. **Model for `Ping`.** A Haiku-class model, exact identifier pinned at implementation time against SDK v1.62.0's model constants rather than guessed here.
6. **Key rotation / multiple keys.** Out of scope. One key, replace-in-place.
7. **`Merge()` bool limitation is not inherited.** Because the key never enters `Config`, the documented "partial updates cannot clear a bool back to false" limitation in `config.Merge` does not apply — `DELETE /api/ai/key` genuinely clears state. Worth stating explicitly since it is a real advantage of the separate pipeline.
