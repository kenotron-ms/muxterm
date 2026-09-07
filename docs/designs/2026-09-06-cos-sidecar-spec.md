# CoS sidecar — implementation contract

**Status:** spec, being built
**Date:** 2026-09-06
**Supersedes:** the Option-A recommendation in `2026-09-06-muxterm-intelligence-design.md` §4

---

## 0. Why this replaces Option A

Both options were measured on this machine, same bundle, same provider.

| | **A** — `amplifier run --resume` per turn | **C** — in-process session |
|---|---|---|
| Boot | every turn | **1.96 s once** |
| Simple turn | 7 s | **1.19 s** |
| Turn with an MCP tool call | 11 s | **2.82 s** |
| Token streaming | none (`isatty` gated) | **13 `llm:stream_block_delta` events** |
| Tool activity | post-hoc in `json-trace` | **live `tool:pre` / `tool:post`** |
| Host approval handler | impossible | **accepted** |
| Concurrency | **silent turn loss** (proven) | one process owns the session |
| stdout parsing | skip 4 preamble lines | none |

**~6× faster on a plain turn, ~4× with a tool call, plus real streaming.**

### The correction that made it work

The design doc's Option C proposed embedding `amplifier_agent_lib` from
microsoft/amplifier-agent. That was the wrong library. The right one is **the
installed CLI's own stack** — `amplifier_app_cli` + `amplifier_foundation` +
`amplifier_core` — which is already on this machine and avoids every objection
raised against amplifier-agent:

- no sealed bundle (`bundle/loader.py` `override_path=None`) — **any** bundle loads
- no POC-labelled code paths
- no dependency on a repo whose HTTP face is out of its own frozen contract
- the CoS session is an **ordinary amplifier session** in the normal session store,
  so `amplifier resume muxterm-cos` works in a terminal, `hooks-muxterm-session`
  observes it, and crash-restore already understands it

### The verified recipe

```python
settings          = AppSettings()
cfg, prepared     = await resolve_bundle_config(bundle_name, settings, None)
cfg               = expand_env_vars(cfg)          # else hook-context-intelligence fails validation
sc                = SessionConfig(config=cfg, search_paths=get_bundle_search_paths(),
                                  verbose=False, session_id=SID,
                                  bundle_name=bundle_name, prepared_bundle=prepared)
session           = await _create_bundle_session(sc, SID, MyApproval(), MyDisplay(), console)
```

`_create_bundle_session` already calls `register_mention_handling` and
`register_session_spawning` internally (`session_runner.py:471-475`) — calling them
again is harmless but redundant.

Three steps are load-bearing and were each discovered by failure:

1. **`expand_env_vars(cfg)`** — without it, `hook-context-intelligence` dies on
   `Unknown level: '${AMPLIFIER_CONTEXT_INTELLIGENCE_LOG_LEVEL:INFO}'`.
2. **`resolve_bundle_config`** (not `create_session_from_bundle`) — supplies
   settings providers *and* composes app bundles. Without it: "No providers
   available" and **0 muxterm tools**. With it: **32 tools, 18 of them muxterm MCP.**
3. **`_create_bundle_session`** (not `create_initialized_session`) —
   `create_initialized_session` hardcodes `CLIApprovalSystem()`/`CLIDisplaySystem()`
   at `session_runner.py:190-191` and `SessionConfig` has no slot for them. The
   lower-level function takes both as parameters.

---

## 1. Architecture

```
browser  ──WS──►  muxterm server (Go)
                        │
                        ▼
                  internal/cos  supervisor
                        │  spawn + supervise + single-consumer queue
                        │  NDJSON over stdin/stdout
                        ▼
                  internal/cos/sidecar/main.py   (amplifier venv python)
                        ├── ONE AmplifierSession, alive across turns
                        ├── Display  ─┐
                        ├── Approval ─┼─► NDJSON events on real stdout
                        └── hooks    ─┘
                        │
                        └── tool-mcp ──► `muxterm mcp` ──► sessiond
```

The sidecar reaches muxterm through the **existing** MCP server. No new Go tool
plumbing is required for v1; the L1 fleet tools land in `muxterm mcp` later and
appear automatically.

---

## 2. Wire protocol — NDJSON over stdio

One JSON object per line. **stdout carries protocol and nothing else.**

### 2.1 stdout discipline (mandatory)

The amplifier stack prints to stdout (token-usage footers were observed during
the spike). The sidecar must claim the real stdout before importing anything:

```python
import os, sys
_real = os.dup(1)          # keep the true stdout
os.dup2(2, 1)              # everything that prints to stdout now goes to stderr
PROTO = os.fdopen(_real, "w", buffering=1)
```

All protocol writes go to `PROTO`. Every log line goes to stderr.

### 2.2 Go → sidecar

```json
{"op":"turn","turn_id":"t-1","prompt":"..."}
{"op":"approval","request_id":"a-1","approved":true,"reason":""}
{"op":"cancel","turn_id":"t-1"}
{"op":"clear","req_id":"r-1","older_than_days":7}
{"op":"history","req_id":"r-2","limit":50}
{"op":"shutdown"}
{"op":"ping"}
```

`clear` and `history` are the only REQUEST/RESPONSE ops: each carries a
`req_id` that the sidecar echoes on its answer, so the Go side can hand that
answer to the one caller waiting for it instead of broadcasting it. Turns do
not use this - a turn is a long-lived thing with its own event stream.

`older_than_days` of 0 (or absent) on `clear` means EVERYTHING.

### 2.3 sidecar → Go

```json
{"ev":"ready","session_id":"muxterm-cos","bundle":"...","tools":32,"boot_ms":1960,"resumed":true}
{"ev":"turn_start","turn_id":"t-1"}
{"ev":"delta","turn_id":"t-1","text":"Hel"}
{"ev":"thinking","turn_id":"t-1","text":"..."}
{"ev":"tool_start","turn_id":"t-1","call_id":"c1","name":"mcp_muxterm_list_workspaces","args":{}}
{"ev":"tool_end","turn_id":"t-1","call_id":"c1","ok":true,"summary":"3 workspaces","ms":3}
{"ev":"approval_request","request_id":"a-1","turn_id":"t-1","tool":"mcp_muxterm_close_workspace","detail":"...","timeout":300}
{"ev":"turn_end","turn_id":"t-1","response":"...","cost_usd":0.0386,"ms":2820,"error":null}
{"ev":"cancelled","turn_id":"t-1","response":"<partial text so far>","ms":44148}
{"ev":"error","turn_id":"t-1","code":"busy","message":"...","fatal":false}
{"ev":"pong"}
{"ev":"cleared","req_id":"r-1","removed":64,"kept":15,"removed_turns":19,"kept_turns":5,"protected":[{"lane":"...","prompt":"..."}]}
{"ev":"history","req_id":"r-2","session_id":"muxterm-cos","turns":[{"id":"h-0","prompt":"...","ts":"...","ms":1325,"blocks":[{"kind":"text","text":"..."}]}]}
```

A `history` turn's `blocks` are `text` | `thinking` | `tool`, where a `tool`
block carries `call_id`, `name`, a one-line `args`, `ok`, `summary` and `ms`.
It is a SUMMARY, deliberately: raw tool results and llm payloads are never
replayed, because `events.jsonl` for a two-turn session is already 464KB with
a 93KB maximum line.

### 2.4 Laws

1. **One turn at a time.** A `turn` received while one is active is refused with
   `{"ev":"error","code":"busy"}`. The sidecar never queues — **Go queues.** This is
   the structural fix for the proven silent-turn-loss defect.

2. **Every `turn_start` gets exactly one terminal event.** Terminal is exactly:
   `turn_end` | `cancelled` | `error` with `"fatal":true` | `error` with
   `"code":"busy"`. Silence is never terminal.
   - `busy` is terminal *for that turn id* despite `fatal:false` — a refused turn
     will never run, so treating it as advisory hangs the caller forever.
   - A turn that **fails** (LLM error, tool crash) emits a non-fatal advisory
     `error` (`code":"turn_failed"`) **followed by** `turn_end` carrying an
     `error` field. Non-fatal errors other than `busy` are never terminal.
   - `turn_start` is emitted **synchronously at accept time**, before any await,
     so it always precedes its own terminal event.

3. **`approval_request` blocks the turn** until a matching `approval` arrives.
   `approved` **MUST be present** on the `approval` op — a denial is
   `"approved":false`, which a Go struct with `omitempty` would silently drop,
   leaving the sidecar to guess on the one op where guessing wrong runs the
   command the user just refused. Timeout resolves to **denied**, never approved.

4. **`delta` is advisory** — a consumer may drop deltas and still reconstruct the
   full reply from `turn_end.response`. Verified: concatenated deltas equal
   `turn_end.response` byte for byte.

5. **Unknown `op` / `ev` / fields are ignored, never fatal.** Additive evolution
   only. A malformed line answers `{"code":"bad_json","fatal":false}`; an unknown
   op answers `{"code":"unknown_op","fatal":false}`.

6. **`cost_usd` is a JSON number or a numeric string.** Decode permissively
   (Go: `json.Number`).

7. **`clear` refuses rather than races.** A clear while a turn is in flight is
   answered `{"code":"clear_failed"}`: the running turn will save the whole
   transcript again at turn end, so a prune underneath it would be undone, and
   rewriting the file while the owner appends to it is a data race. A clear
   also NEVER drops a message that references a lane that is still alive -- the
   roster is `$XDG_RUNTIME_DIR/muxterm/session-state/*.json`, read fresh on
   every clear, with the sidecar's own session id excluded (it is itself a
   lane in that directory, and protecting it would protect everything). Every
   ambiguity resolves toward KEEPING: an unparseable state file still
   contributes its filename, an undated turn survives a days-based cut, and a
   uuid-shaped lane id also matches on its first 8 characters.

8. **Restart semantics.** If the sidecar dies mid-turn, the in-flight turn fails
   with a synthesized `{"code":"sidecar_exit","fatal":true}` — its effect on the
   session is *unknown* and must be reported as such, never retried. Queued but
   undispatched turns survive and dispatch to the replacement.

---

## 3. Components

### 3.1 `internal/cos/sidecar/main.py` — Python

- Args: `--session-id` (required), `--bundle`, `--cwd`, `--log-level`,
  `--approval-timeout` (seconds, default 300).
- Ops: `turn`, `cancel`, `approval`, `ping`, `shutdown`, `clear`, `history`.
  `clear` and `history` both work in TURNS, not raw messages: a turn is the
  human's prompt plus the reply and tool work that followed it, including the
  ephemeral system-reminder block injected ahead of the prompt. Pruning or
  replaying half a turn would leave an assistant `tool_call` with no result,
  which is the exact broken transcript `repair_transcript` exists to clean up.
- Boot: claim stdout (§2.1) → build session (§0 recipe) → resume transcript if
  present → emit `ready`.
- Hooks for streaming: `llm:stream_block_delta` → `delta` **and** `thinking`,
  discriminated by the payload's `block_type` (`foundation/docs/provider-streaming-contract.md`
  is explicit: there is ONE delta event carrying both). `tool:pre` → `tool_start`;
  `tool:post` → `tool_end`. `content_block:end` is a **fallback only**, suppressed
  the moment a stream delta is seen, so the non-streaming provider path still
  reports thinking without double-reporting it on the streaming path.
  Hook handlers must return `HookResult(action="continue")`.
- **Gate deltas to the foreground call.** `provider:request` opens the gate, the
  first delta's `request_id` is latched, `llm:response` closes it. Background hook
  LLM calls never emit `provider:request`, so they are structurally excluded —
  see the `label.py`/`classify.py` bug in §5.
- `Approval.request()` → emit `approval_request`, await an `asyncio.Future` resolved
  by the stdin reader.
- Transcript is saved by the normal session store — the CoS session must remain
  resumable by `amplifier resume`.
- Exit non-zero on fatal init failure with a final `{"ev":"error","fatal":true}`.

### 3.2 `internal/cos/` — Go

- `supervisor.go` — locate interpreter and script, spawn, supervise, restart with
  backoff.
  **Interpreter discovery order:** `$MUXTERM_COS_PYTHON` → shebang of the resolved
  `amplifier` binary (verified: `/home/ken/.local/bin/amplifier` is a symlink whose
  target's shebang is the venv python) → `python3`.
  **Sidecar discovery order:** explicit override (`--sidecar` / `Config.Script`) →
  `$MUXTERM_COS_SIDECAR` → a walk up from the binary, then from the working
  directory, for `internal/cos/sidecar/main.py` → the embedded copy, extracted.
  An override that does not exist is a hard error, never a fall-through. The
  source tree beats the embedded copy on purpose, so `make dev-local` runs live
  edits to the Python without a Go rebuild.
- `embed.go` — `go:embed sidecar/main.py`, extracted on demand to
  `$XDG_CACHE_HOME/muxterm/sidecar/<sha256[:16]>/main.py` (HOME fallback
  `~/.cache`). **This is the distribution mechanism, not an optimization.** A
  muxterm release is one binary: the homebrew tap installs `bin.install
  "muxterm"`, the curl installer drops a single file, and v0.19.0's tarball held
  exactly `LICENSE`, `README.md`, `muxterm`. A sidecar that only lives beside the
  binary does not exist on any installed machine, and v0.19.0 duly failed on
  first Dashboard use for everyone outside a source checkout. The path is
  content-addressed so an upgrade can never be handed the old script, and the
  write is temp-file-plus-rename so two servers booting at once cannot produce a
  torn file.
- `queue.go` — strictly single-consumer per session. This is where the concurrency
  law is enforced.
- `events.go` — parse NDJSON, fan out to subscribers (CLI verb and/or WS).
- Never let a sidecar crash take down sessiond. Restart, and surface the gap.
- `state.go` — status file at `$XDG_RUNTIME_DIR/muxterm/cos.json` (atomic write,
  same pattern as `server.url`), so `--status` and the web overlay can observe a
  sidecar they did not spawn. XDG-scoped, so dev-local never reports on production.

### 3.3 `muxterm cos` — CLI verb

`muxterm cos "<message>"` sends one turn and streams the reply to the terminal.
This makes Stage 3 provable **without a browser**, which is the honest test of
whether a chief of staff is useful at all.

### 3.4 Web chat — overlay, not a pane kind

Peer to `<mux-home>` in `app.ts` (~1329-1408), reached from the Start card.
**The dock is never unmounted** — cos-pitch v7's rule, and dockview persistence
depends on it. A new dockview pane kind would touch five places including the
frozen pane protocol; the browser/CDP pane attempt was already reverted once.

---

## 4. Safety rules — non-negotiable

Carried from AGENTS.md and the spike findings:

1. **Never `close_workspace` the CoS did not create.** `broadcastWorkspaceClosed`
   (`sessiond/server.go:783-789`) enqueues to **every live connection** and
   `workspace-controller.ts:76-90` yanks the human's browser to a survivor. Closing
   an agent's last pane auto-reaps and does the same. This is the only MCP call
   that reaches the user's view.
2. **The `active` flag from `list_workspaces` is MCP-client-local**
   (`tools_workspace.go:32`) — it reflects the *agent's* attachment, not what the
   human is looking at. Never treat it as "the user's current workspace."
3. **Serialize cross-workspace work.** One workspace at a time per MCP process
   (`attachConn` unsubscribes before resubscribing, `server.go:255`). Drain output
   before `switch_workspace`; each switch replays full scrollback.
4. **The CoS does not write code.** It dispatches, observes, unblocks, summarizes.
   Editing happens in the lanes it spawns. Enforced by bundle composition plus
   `denied-dirs` on its home.

   ⚠️ **Rule 1 cannot be enforced via `require_approval_tools`.** `hooks-mode`
   runs `handle_tool_pre` at priority **−20**, ahead of `hooks-approval` at **−10**,
   and *overwrites* `session_state["require_approval_tools"]` on every single
   `tool:pre` — clearing it outright when no mode is active. A one-shot seed at boot
   is silently erased. Additionally `anchors` configures `hooks-approval` with
   `policy_driven_only: true`, which disables every built-in rule including
   "bash always needs approval". Three viable seams remain: (a) an active mode whose
   `confirm_tools` lists the tool, (b) a `tool:pre` hook at priority between −20 and
   −10, or (c) removing the tool at bundle-composition time. **(c) is the strongest**
   for `close_workspace` — a tool the CoS does not have cannot be misused. The
   sidecar currently implements (b) behind `MUXTERM_COS_REQUIRE_APPROVAL`.
5. **Dev work on `make dev-local` (:8313) only.** Ports 8311/9090 are production —
   no mutating requests, no browsers pointed there. Never `pkill` muxterm/sessiond.
6. **No unit tests.** Verification is a real browser via `/muxterm-verify` and
   `playwright-cli`. Static gates before commit: `cd web && npm run check:fast`
   (0 errors) and `go build ./...`.

---

## 5. Bug found in shipped muxterm code (fixed here)

Both background LLM calls in `hooks-muxterm-session` omitted
`metadata={"stream": False}`, so each took the **streaming** branch and emitted
`llm:stream_block_start/delta/end` onto the session's hook bus. Those events are
indistinguishable from foreground assistant output to any consumer reading the
stream.

| File | Call | Symptom |
|---|---|---|
| `label.py:256` | pane-label generation | chat surface renders `{"label": "codeword recall"}` as if the assistant said it |
| `classify.py:369` | end-of-turn classification | same leak, larger payload |

Observed raw, before the fix:

```
delta  t-1 '{'
delta  t-1 '"label": "codeword recall"}'
delta  t-1 'ok'
turn_end t-1 response='ok'
```

This pollutes the CLI's streaming overlay **today**, transiently — it is not a
chief-of-staff-only defect. `hooks-session-naming` and `loop-streaming` both set
the flag and their comments describe exactly this failure mode; muxterm's two
calls were written without it. The provider tests with an identity check
(`is False`), not truthiness.

Fixed in both files. Note the sidecar also defends structurally by gating deltas
to the foreground call (§3.1), so the two fixes are independent — either alone
prevents the leak in the chat surface, but only the module fix cleans up the CLI.
