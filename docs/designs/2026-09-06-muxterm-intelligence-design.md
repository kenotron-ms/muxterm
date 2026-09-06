# muxterm intelligence — the chief of staff

**Status:** proposal
**Date:** 2026-09-06
**Worktree:** `muxterm-chief-of-staff` / `feat/chief-of-staff`

---

## 1. The problem

> "Now that I have the home page the way it is, I like it except now I'm back to
> managing sessions through clicking through to the individual ones."

The home view solved *seeing*. It did not solve *acting*. The cos-pitch sequence
(`.scratch/cos-pitch/`, v1→v9) converged on a triage surface, and that surface
shipped. But a triage surface's output is still a decision *you* have to execute,
one pane at a time, by clicking into it.

The gap is not more display. The gap is a **second consumer of the world model** —
one with hands.

Ken's own recorded objection, from cos-pitch v4, still applies and should be
answered rather than dodged:

> "If the supervised number stays 5–10, a dashboard built to triage forty rows is
> solving a problem nobody actually has."

The answer: this is not sized for N=40. At N=5–10 the felt cost is not *finding*
the session that needs you — home already does that — it is the **context switch
per session**: attach, read the screen, remember what this lane was for, type,
detach. A chief of staff is worth building when the per-session switch cost
dominates, which happens at N≈5, not N≈40.

---

## 2. What already exists (the actual insight)

**Most of this feature is already built.** Three assets, each landed for a
different reason, compose into an intelligence layer almost without new
invention.

### Asset 1 — a declared world model, not screen scraping

`hooks-muxterm-session` → `$XDG_RUNTIME_DIR/muxterm/session-state/<id>.json` →
sessiond 1 Hz poll → change-gated `session-state` WS push → browser.

Per session, already carried on the wire:

```
state      working | blocked | done | failed | stopped
mode       interactive | autonomous
waitingFor "permission prompt" | "input needed"        (when blocked)
doing      "[anchors:git-ops] Reading foo.json"
doneMeans  the stop condition
knows      artifact:read trail — the file paths this lane has seen
label      LLM-derived 1–3 word name
sessionId, pid, sid, project, pr
```

Joined to `(workspaceId, paneId)` by sessiond, fanned out **across every
workspace** (`protocol.go:124-137`). Spec at `docs/session-state-protocol.md`.

This is exactly the thing an agent needs and cannot easily get: *declared* truth
from inside the harness. The user asked for "read the transcripts directly even
without looking at the screen pane captures" — this is better than transcripts.
It is the harness telling you what it is doing.

### Asset 2 — hands that already work

`internal/mcp/` is implemented and live: `create_pane`, `send_input`,
`run_command` (OSC 133 completion, not regex), `get_screen`, `list_panes`,
`get_layout`, workspace create/list/switch, `rename_pane`, `close_pane`,
tunnels, config. Plus `pane://<id>` resources with
`notifications/resources/updated`.

And `behaviors/muxterm.yaml` in this repo **already wires `tool-mcp` to
`muxterm mcp`**. An amplifier session launched with the muxterm bundle already
has muxterm's hands today.

### Asset 3 — a persistent agent with no new runtime

Verified against the installed CLI (`amplifier 2026.09.06-395fa68`, core 1.6.1):

```bash
amplifier run --resume <session-id> --mode single --output-format json-trace "<message>"
```

appends a message to a named session, runs one turn, prints structured output,
exits. Session ids can be pinned. `/goal` works headlessly. `events.jsonl` is
appended in real time and is `tail -f`-safe.

That is a long-lived, addressable, resumable agent — with bundles, skills, MCP,
delegation, and sub-agents — reachable from Go by `exec.Command`.

### The one new idea

**The home composer becomes the front door to a persistent agent.**

Today: type a prompt → spawn a pane → fire and forget.
Tomorrow: type a prompt → it goes to the chief of staff → who decides whether to
spawn a lane, answer from fleet state, unblock something, or ask you a question.

Everything else in this document is plumbing to make that sentence true.

---

## 3. Architecture

Five layers. Layers 1 and 2 are useful **on their own**, before any chat UI
exists. That is deliberate — each stage ships value alone.

```
  ┌──────────────────────────────────────────────────────────────┐
  │  L4  Chat surface        overlay peer to <mux-home>           │
  │      renders CoS turns, sends messages, falls back to screen  │
  └──────────────────────────────────────────────────────────────┘
                              ▲ WS  │ message
  ┌───────────────────────────┴─────▼────────────────────────────┐
  │  L3  The chief of staff   pinned amplifier session            │
  │      exec: amplifier run --resume cos --mode single …         │
  │      serialized by sessiond; woken by L5                      │
  └──────────────────────────────────────────────────────────────┘
        │ MCP (stdio)                          ▲ wake events
  ┌─────▼──────────────────────────────┐  ┌────┴─────────────────┐
  │  L1  Fleet tools                    │  │  L5  Waking rules    │
  │      fleet_status / session_read /  │  │  transition → turn   │
  │      session_send / lane_spawn      │  └──────────────────────┘
  └─────────────────────────────────────┘             ▲
  ┌──────────────────────────────────────────────────────────────┐
  │  L2  Chat tee     hooks-muxterm-session → chat.jsonl          │
  ├──────────────────────────────────────────────────────────────┤
  │  L0  World model  session-state spool → sessiond → browser    │  EXISTS
  └──────────────────────────────────────────────────────────────┘
```

### L1 — Fleet tools (new, small, immediately useful)

New MCP tools in `internal/mcp/`, backed by sessiond, **workspace-independent**:

| Tool | Returns |
|---|---|
| `fleet_status` | the full `session-state` snapshot as structured JSON — every session, every workspace, with `state/mode/waitingFor/doing/doneMeans/knows/pr` |
| `session_read` | safe extraction from any amplifier session's transcript: last N turns, tool errors, final response, `knows` set. Never dumps 100k-token lines. |
| `session_since` | what changed in session X since timestamp T |
| `session_send` | deliver a message to a lane (wraps `send_input` with pane resolution by session id) |
| `lane_spawn` | create pane + launch `amplifier run <prompt> --mode chat` in a named workspace — the argv `web/src/lib/harness.ts:41` already builds |

**This solves the cross-workspace problem.** The existing MCP `Client` attaches
to one workspace at a time (`mcp/client.go:99-113`); these tools bypass
attachment entirely and address sessions by id, which sessiond already indexes
globally.

Mirror them as CLI verbs (`muxterm fleet`, `muxterm session read`) so they are
scriptable and testable without an agent. This also closes issue #47's shape
(`muxterm pane send`), which the cos-pitch mocks were gated on.

**Ships alone as:** "any agent, anywhere, can now see and drive my whole fleet."

### L2 — The chat tee (new, small)

Extend `hooks-muxterm-session` to append a compact, purpose-built stream next to
the state file:

```
$XDG_RUNTIME_DIR/muxterm/session-chat/<session-id>.jsonl
{"ts":…,"role":"assistant","text":"…"}
{"ts":…,"role":"tool","name":"bash","status":"ok","summary":"…"}
{"ts":…,"role":"user","text":"…"}
```

Sourced from `content_block:end` (whole text blocks) and `tool:pre`/`tool:post`.

Why not read `events.jsonl` directly? Because it is 18 MB+ per session with
individual lines carrying `llm:request.raw` and `tool:post.result` payloads.
Tailing it safely means filtering enormous lines in Go on every read. The hook
already runs in-process, already writes atomically, and can emit the 200-byte
version for free.

**Ships alone as:** "peek at what any lane just said, without attaching."

### L3 — The chief of staff (new, mostly configuration)

A **singleton, pinned amplifier session** driven per-turn by the Go server:

```go
cmd := exec.Command("amplifier", "run",
    "--resume", cosSessionID,
    "--mode", "single",
    "--output-format", "json-trace",
    message)
cmd.Dir   = cosHome                 // stable → stable project slug
cmd.Stdin = nil                     // never block reading stdin
cmd.Env   = append(env, "AMPLIFIER_MCP_CONFIG="+generatedMCPPath)
```

- **Bundle:** a `muxterm-cos` behavior — the existing `muxterm.yaml` MCP wiring
  plus the L1 fleet tools, a CoS system prompt, and the `monitor`, `goal-batch`,
  `ten-lane-highway` skills. Amplifier already has the "drive many parallel lanes"
  pattern as skills; what it lacks is a persistent home, a web address, and
  muxterm-native hands. muxterm supplies exactly those three.
- **Home:** `$XDG_DATA_HOME/muxterm/cos/` as cwd — a dedicated project slug, so
  CoS turns do not pollute any repo's session list.
- **Identity:** capture the uuid from the first run's JSON and persist it in
  muxterm state. (Pinning a human-readable id by pre-creating the session
  directory also works — verified — but is undocumented. See §6.)
- **Authority:** its muxterm MCP connection dials as `ClientKind = "agent"` —
  cannot claim resize or focus (`sessiond/server.go:21`, `:415`, `:453`).
  Destructive pane/workspace closure goes through `close-intent`/`close-confirm`,
  never `close-pane` (AGENTS.md:92-104).

**Principle — the chief of staff does not write code.**

It dispatches, observes, unblocks, summarizes, and reports. Editing happens in
the lanes it spawns, in real repos, under whatever approval regime those lanes
already have. This is not a stylistic preference: the installed CLI has **no
plug point for a host-supplied approval handler** (§6), so the only sound safety
model for the CoS itself is a small, non-destructive tool surface plus
`amplifier denied-dirs` scoping on its home.

### L4 — The chat surface (new)

An overlay peer to `<mux-home>` in `app.ts:1329-1408`, reached from the Start
card. **Not** a new pane kind:

- A new dockview pane kind touches five places including the frozen pane
  protocol (`PaneInfo` has no `kind` field at all; `tools_layout.go:42` is a
  documented single-arm guard).
- The previous attempt at a second pane kind — browser/CDP panes — was reverted;
  `tools_browser_*_test.go` are compilation stubs.
- cos-pitch v7 already established the principle Ken landed on: **overlays,
  never swaps — the dock never unmounts.**

Rendering: tail L2's `chat.jsonl` for the CoS session. Sending: POST a message,
which enters the L3 queue.

**Fallback, and it is honest, not a workaround:** when a lane is `blocked` with
`waitingFor: "permission prompt"`, that prompt exists only as TUI pixels. The
chat surface shows the raw screen for that pane inline and offers keys. "Read
the transcript, but fall back to the screen" is the right answer, and Ken already
said so: *"but that is okay too."*

### L5 — Waking (new, small)

**The chief of staff is woken, not running.** The world model is free and
continuous at 1 Hz; the *agent* costs a turn every time it thinks. So it must be
event-triggered.

sessiond already computes state transitions. Add a rule set: on a configured
transition — any session → `blocked`, → `failed`, a `/goal` lane reporting
`goal_final: true` — enqueue a compact system turn into the CoS queue:

```
[wake] session 3f2a "auth-refactor" → blocked (permission prompt) in ws "backend"
```

The CoS decides whether to act, escalate to you, or stay quiet. This is the
difference between a chief of staff and a chatbot.

Cost profile falls out naturally: zero idle burn. One `amplifier run` per wake or
per message.

---

## 4. The runtime decision

**Revised 2026-09-06 after reading current upstream.** An earlier draft of this
section assessed amplifier-agent from a local fork (kenotron-ms, last commit
2026-06-30, v0.9.0). Upstream microsoft/amplifier-agent is **93 commits and eight
minor versions ahead** (v0.17.0, HEAD fa33a20, 2026-09-02). The code-level
findings survived the correction unchanged. The strategic picture did not.

### What changed upstream: a frozen v1 contract set

`contracts/` (stamped FROZEN 2026-09-02) defines the interface amplifier-agent
intends to present. Six contracts. The vocabulary is load-bearing:

> **Binding.** The library you install and call, one per language. This is the whole of what you build against.
> **Engine.** What actually runs the agent behind the binding. You never call it, name it, or learn what it is written in.
> **Face.** A network endpoint that projects *part* of the binding's surface. A face carries less than a binding does and says so.

Object model: `Agent -> Session -> Turn -> events()`. It is, nearly line for line,
what a chief of staff needs:

- **Durable sessions by default.** *"Kill every process between turns and nothing
  is lost. A durable session resumes later, in a different process, from the
  transcript alone."*
- **One active turn per session** — a second `start_turn` fails `busy` rather than
  queueing. **That is risk 6.1 solved by contract.**
- **Caller-executed tools as a first-class executor** — *"the host executes, in its
  own process."* Real handler functions, real return values, `unknown` resolution
  passed through honestly rather than guessed.
- **Host-supplied approval handler** — *"every consequential action passes through
  it first and resolves exactly one way."* Five refusal outcomes, and *"none of
  these is ever interpreted as allow."*
- **Eleven frozen event types** with ordering laws: bracketing, pairing by
  `call_id`, delta-to-terminal reconstruction. *"Silence is never a terminal state."*

### What the contract rules out

Three exclusions land directly on the options this document was weighing:

1. **The HTTP face cannot carry host tools.** `http-face.v1.md`: *"A caller-supplied
   tool is a function in the caller's process, and this face has no process to
   reach into."* A request carrying `tools` is **refused**, not ignored. The
   yield-and-resume mechanism that exists in today's code is **out of contract**.
2. **The HTTP face cannot carry approvals, and is silent during tool time.**
   *"A client that needs live activity embeds a binding."*
3. **A caller-facing CLI is permanently Excluded** — *"in this or any future
   version"* — on a denylist with no promotion path.

The contract's own answer to muxterm's question is one sentence
(`language-binding.v1.md`): *"Need approvals, caller tools, or the full event
stream? Embed a binding."*

### And the part that matters most: the contract is a spec, not a shipped surface

Every frozen contract carries the same changelog line: *"Freeze bar at stamp time:
**the spec exists**."* The repo's own bar (`contracts/README.md:104-111`) requires
four things — spec, conformance kit, passing implementation, worked example. Only
the first is met. There is no `amplifier_agent` Python package and no
`@microsoft/amplifier-agent` npm package. `README.md` still tells the old
CLI-and-subprocess story.

Verified against **current** code, not the fork:

- `host_tool_proxy.py:17-28` — the parallel-tool defect comment is **unchanged**:
  *"asyncio.gather() cancels sibling tasks when one raises... Single tool call per
  turn is the supported case."*
- `defaults_http.py:83` — `HttpAutoApprovalSystem`, *"Auto-approve all approval
  requests. POC scope."* `app.py:140` — *"approval.mode is intentionally NOT applied."*
- The TypeScript wrapper hard-rejects host approval callbacks:
  `approval_not_supported_in_v1`, *"The Mode A wire has no mid-turn request channel."*
- `app.py:448` still declares `version="0.0.2-poc"` at repo v0.17.0.
- 44 POC markers in `src/` — **all** in `amplifier_agent_http/*` plus the host-tool
  files. **Zero** in `amplifier_agent_lib`'s core. The maturity gradient is sharp
  and honest: the library is real, the HTTP face and host tools are not.
- **The unit test tier was deleted** (commit 70acfa9, *"e2e-first testing; delete
  the unit suite"*). E2E requires a DTU. `grep -rln "host_tool" tests/` returns
  zero files.

### The four options, honestly

| | What it is | Verdict |
|---|---|---|
| **A. `amplifier run --resume` per turn** | Shell out to the shipped **amplifier CLI**, one turn per invocation | **Ship this for Stage 3.** Full bundles, skills, MCP, delegation, `/goal`. Costs: no streaming (tail `events.jsonl`), no approval plug point, and **you own the session lock** (§6.1). |
| **B. amplifier-agent HTTP face** | OpenAI chat-completions plus `tools[]` passthrough | **Dead end, permanently.** Not "immature" — the frozen contract says this face will *never* carry host tools, approvals, or tool-time events. |
| **C. Python sidecar embedding `amplifier_agent_lib`** | One long-lived Python process muxterm supervises: `Engine(turn_handler, protocol_points)` with *your* `DisplaySystem` and *your* `ApprovalSystem`, real tools mounted on the coordinator that RPC back into muxterm | **The strongest technical answer available today**, and `README.md:123` endorses it: *"A Python host should embed amplifier_agent_lib directly rather than spawning anything."* Real tools (no yield hack, no parallel defect), full event stream, real approvals, long-lived conversation. The Go-to-sidecar protocol is **yours**, so upstream cannot break it. |
| **D. A Go binding to the v1 contract** | The destination | Does not exist. `language-binding.v1.md` anticipates new-language bindings but says which languages get one is *"an issue-queue decision."* |

**Recommendation: A for Stage 3 — and open the D conversation upstream now.**

A is not the best runtime. C is. A is the right *first* runtime, because Stage 3
exists to test whether a chief of staff is useful at all, and A costs one
`exec.Command` against a CLI already installed and in daily use. C costs a Python
process to supervise, a wire protocol to design, and an integration-test burden
upstream has explicitly stopped carrying. Pay that after the thesis is proven.

**Evaluate C's disqualifying risk early.** `bundle/loader.py` states *"the vendored
bundle is **sealed**: production callers always pass override_path=None"*, and
`--bundle` is hidden. A sidecar chief of staff would inherit amplifier-agent's
coding-agent bundle — its system prompt, its bash and filesystem tools. You can
*add* muxterm tools to the coordinator; you cannot *subtract* an agent that can
`rm -rf` its way through the host. That contradicts the "chief of staff does not
write code" principle in L3 head-on.

> **Thirty-minute experiment:** does `load_and_prepare_bundle(override_path=...)`
> work end to end with a custom bundle.md? If yes, C is clean. If no, C means
> forking or negotiating with upstream.

**The upstream conversation.** muxterm is a Go host that wants an agent, and the
v1 contract has no Go binding. That is not a local build decision — it is a
forcing function. muxterm is a concrete, specific, non-hypothetical answer to
"which language next," and the contract set is four days old, so the question is
live. Worth raising in the amplifier-agent issue queue regardless of which
runtime Stage 3 uses.

**The seam holds either way.** L1, L2, L4, and L5 are runtime-agnostic by
construction. Design L3 behind:

    type CoSRuntime interface {
        Submit(ctx context.Context, message string) (<-chan Event, error)
    }

and A to C to D is a contained swap each time.

---

## 5. Staging

Each stage is independently shippable and independently useful.

**Stage 1 — fleet tools (L1).** MCP tools + CLI verbs. No UI. Value: any agent
you run — in a pane, on your laptop, over SSH — can see and drive the whole
fleet. Also closes issue #47's shape.
*Verify:* `muxterm fleet` returns live JSON while three panes run; an amplifier
session in one pane reports on a session in another workspace.

**Stage 2 — chat tee (L2).** Hook change + spool. Value: peek at any lane's last
exchange without attaching. Feeds home's Cards mode with real content.
*Verify:* `tail -f` the chat spool for a running lane and see turns land.

**Stage 3 — the chief of staff, terminal-first (L3 + L5).** `muxterm cos` creates
and drives the pinned session; waking rules fire. **No web chat yet** — you talk
to it via `muxterm cos "message"` and read replies in the terminal.
*Verify:* block a lane on a permission prompt; the CoS wakes, reports it, and can
unblock it on instruction.

**Stage 4 — the web chat (L4).** Overlay, composer routing, screen fallback.
*Verify:* per AGENTS.md — real browser against `make dev-local` on :8313, fresh
workspace and fresh panes, `playwright-cli` confirming the flow end to end. Not
done until playwright says so.

Stage 3 is the honest test of the whole idea. If the CoS is not useful from a
terminal, the web chat will not save it.

---

## 6. Risks and things that will bite

**1. No session locking. This is the sharpest one.**
Grepped the whole install: `filelock`/`fcntl` appear only in `lib/settings.py`
and `key_manager.py`. **Nothing** guards the session store. `SessionStore.save()`
rewrites the entire `transcript.jsonl` from an in-memory list — so two concurrent
resumes of the same id do not corrupt the file, they make **a whole turn vanish**.
Note: amplifier-agent's frozen v1 contract solves this properly — one active
turn per session, second `start_turn` fails `busy`. The shipped amplifier CLI
does not.
*Mitigation:* sessiond owns a single-consumer queue per CoS session — consistent
with the existing "sessiond is the authority" invariant. And muxterm must refuse
to open the CoS session in a pane while the queue is active, or treat that as a
handoff that drains the queue first.

**2. `--output-format json` does not emit clean JSON.**
`docs/OUTPUT_FORMATS.md` claims it does; verified false. Four preamble lines
precede the object on the `--resume` path (`✓ Resuming session:`, `  Messages: N`,
`  Using saved bundle: X`, `Bundle '…' prepared successfully`) — unconditional
`console.print()`, no flag suppresses them. Parse from the first line that is
exactly `{`.

**3. Session-id pinning is undocumented.**
Pre-creating the session directory works (verified: `"session_id":"chief-of-staff"`),
because `SessionStore.load()` returns an empty transcript when no file exists and
`find_session()` short-circuits on exact directory-name match. But it is not a
stated contract. Constraints: no `_` in the id (it is the sub-session separator),
no path separators. **Prefer capturing the generated uuid** — one indirection,
depends on nothing undocumented.

**4. No streaming stdout, and no CLI approval plug point.**
`hooks-streaming-ui` gates on `stdout.isatty()`, so a piped consumer gets no
deltas. `CLIApprovalProvider` is constructed inline at `session_runner.py:320`
with no substitution point. Both are why L2 exists and why the CoS has a small,
non-destructive tool surface. If a mode ever gates a CoS tool behind approval,
headless `Confirm.ask` raises `EOFError` and the hook **fails closed to `deny`**
— it will not hang, but it will silently refuse. Keep the CoS out of modes.

**5. `/goal` is the only slash command that works headlessly.**
`CommandProcessor` is instantiated only inside `interactive_chat`. `/mode`,
`/clear`, `/provider` sent to `--mode single` are passed to the model as literal
text. Anything mode-like must be expressed as bundle selection at launch.

**6. Cost and chattiness.**
Every wake is a turn. A noisy transition rule set turns the CoS into a money
pump. Start with the narrowest possible rule set — `→ blocked` and `→ failed`,
nothing else — and require evidence before widening. Debounce lanes that flap.

**7. Ken's v4 objection.**
At N=5–10 this may be over-built. The mitigation is the staging: Stage 1 and
Stage 2 are worth having regardless of whether the CoS itself proves out, and
Stage 3 tests the thesis before any UI is written.

**8. The abandoned thesis.**
cos-pitch v3 declared "context is the product" — Material → Brief → Lane →
Artifact, with artifact→material promotion as the compounding loop — and then
v4's Boris research redirected to copying Claude Code's triage layer and it was
never mentioned again. That is the most consequential unexplained turn in the
sequence. A chief of staff is the *natural* home for that thesis: `knows` is
already on the wire, and the CoS is the only component positioned to notice that
lane B needs what lane A learned. Worth deciding deliberately this time rather
than by omission.

---

## 7. Open questions

1. **Does the CoS get its own workspace?** A visible `chief-of-staff` workspace
   with the session running in a pane is debuggable and makes the recursion
   legible. Or it runs headless with no pane at all. Leaning visible-but-collapsed.
2. **What wakes it besides state transitions?** A schedule ("brief me at 9am")
   is tempting and is exactly the kind of unattended action muxterm has so far
   refused. Probably out of scope for v1.
3. **Multi-machine.** `sessiond-connect` over SSH means the fleet can span hosts.
   Does the CoS see remote fleets? `session-state` is per-daemon today.
4. **Does the CoS spawn lanes, or propose them?** Proposing keeps you in the
   loop; spawning is the actual ask. Suggest: spawns freely (cheap, reversible),
   never closes without confirmation (destructive, and sessiond owns that anyway).
5. **Reconcile with home.** If the CoS can answer "what needs me," is the home
   view still the primary surface or does it become the CoS's rendering of its
   own fleet view? Do not build two answers to the same question.

---

## 8. Runtime spike — Option A, executed 2026-09-06

Every check below was run against the shipped amplifier CLI 2026.09.06-395fa68
(core 1.6.1) and muxterm 0.16.0. Read-only probes ran against the production
sessiond; **nothing mutating touched ports 8311/9090.** The one mutation question
was answered by code read rather than by poking production.

**Verdict: Option A works. Build Stage 3 on it.**

### What passed

| # | Question | Result |
|---|---|---|
| E1 | Does a headless turn actually get muxterm's MCP tools? | **Yes.** `mcp_muxterm_list_workspaces` returned live fleet state in **3.49 ms**; turn total 11 s cold, $0.14. |
| E2 | Can the host pin a stable, human-readable session id? | **Yes.** Pre-created `sessions/muxterm-cos/` → `"session_id": "muxterm-cos"`. |
| E2 | Does conversation survive across process death? | **Yes.** Codeword planted in turn 1, recalled verbatim in turn 2, separate process. |
| E2 | Warm turn latency? | **7 s** warm vs 11 s cold. Acceptable for chat; see caveat below. |
| E3 | Are turn boundaries detectable in `events.jsonl`? | **Yes, cleanly.** `prompt:submit` → `tool:pre`/`tool:post` (with `tool_name`) → `execution:end` → `orchestrator:complete{goal_final:true}` → `prompt:complete` (carries final response text). Everything a chat UI needs. |
| E4 | Can the agent act in workspace B while the human views A? | **Yes.** Attachment is strictly per-connection (`server.go:319-335`, `:263`); the browser holds its own daemon connection (`ws.go:34-36`); no `workspace-switched` message type exists. |

### What failed, exactly as predicted

**The concurrency hazard is real and silent.** Two concurrent
`--resume muxterm-cos` invocations, one saying `ZEBRA-ONE`, one saying `ZEBRA-TWO`:

```
c1 -> 'ZEBRA-ONE'          both processes reported success
c2 -> 'ZEBRA-TWO'
transcript: 9 → 12 lines   only ONE turn's worth was appended
ZEBRA-ONE occurrences: 0   ← the entire turn vanished
ZEBRA-TWO occurrences: 2
```

**Both callers were told they succeeded.** One turn was erased with no error, no
warning, and no way for the caller to detect it. That is worse than a failure.
The single-consumer queue in §6.1 is **mandatory, not defensive**.

### New findings the design did not anticipate

**1. App bundles are global, not per-invocation.** `settings.yaml` `bundle.app` is
a user-global list layered onto whatever root bundle is active. That is *why* a
plain `amplifier run` already has muxterm tools — and it means a CoS launched by
muxterm inherits Ken's entire global config (resolve-platform, DTU, goal). No
isolation. The CoS should pin its root bundle explicitly and be understood to
inherit app bundles.

**2. `-B` takes registered names only.** Not a filesystem path
(`-B /path/to/worktree` → "Bundle not found"), and not an app bundle
(`-B muxterm` → not found; `muxterm-behavior` is registered, `muxterm` is not).
A behavior fragment alone fails with `ValueError: Configuration must specify
session.orchestrator` — behaviors are not standalone bundles. **The CoS bundle
must be registered via `amplifier bundle add`**, which is a muxterm install step.

**3. Inline MCP config beats the env var.** Priority is inline > `AMPLIFIER_MCP_CONFIG`
> project > user (`tool-mcp/config.py:44-52`). The muxterm behavior declares
inline `servers:`, so **`AMPLIFIER_MCP_CONFIG` cannot override it.** For the env
var to be the per-invocation knob that points the CoS at dev-local vs production,
the CoS bundle must include `tool-mcp` with **no** inline `servers` block.

**4. `anchors` does not include `tool-mcp` at all.** Setting `AMPLIFIER_MCP_CONFIG`
against a stock bundle does nothing — the module has to be mounted first.

**5. `events.jsonl` is heavy.** 464 KB and a 93,828-byte max line for **two
trivial turns**. A Go tailer needs a large `bufio.Scanner` buffer and must filter
`llm:request.raw` / `session:config.raw` / `tool:post.result`. Before building L2,
try the cheap fix: configure `hooks-logging` with `exclude_events` to drop the
raw-heavy events at the source.

**6. The preamble is exactly four lines on the resume path**, confirmed byte for
byte: `✓ Resuming session:`, `  Messages: N`, `  Using saved bundle: X`,
`Bundle '…' prepared successfully`. Parse from the first line that is exactly `{`.

**7. One workspace at a time, per MCP process.** `attachConn` unsubscribes before
resubscribing (`server.go:255`) and `mcp.Client` holds a single conn. Cross-workspace
work must be **serialized** (`switch_workspace` → act), or run N `muxterm mcp`
processes for real parallelism. Every switch replays full scrollback and wipes
output buffers (`client.go:109-110`) — drain before switching.

**8. ⚠️ `close_workspace` is the one call that reaches the human's browser.**
`broadcastWorkspaceClosed` (`server.go:783-789`) enqueues to **`s.conns` — every
live connection** — and `workspace-controller.ts:76-90` yanks the browser to a
survivor. Closing an agent's last pane auto-reaps the workspace and does the same.
**The CoS must never close a workspace it did not create**, which reinforces the
L3 rule that destructive closure goes through `close-intent`/`close-confirm`.

**9. The `active` flag in `list_workspaces` is a lie** — or rather, it is
MCP-client-local (`tools_workspace.go:32` compares against the agent's own
attachment). It is not on the wire and says nothing about what the human is
looking at. A CoS must never treat it as "the user's current workspace."

### Revised Stage 3 shape

```
sessiond
  └── CoS supervisor (new)
        ├── single-consumer queue per CoS session   ← mandatory, proven above
        ├── exec: amplifier run --resume <id> --mode single --output-format json-trace
        │         cwd = $XDG_DATA_HOME/muxterm/cos   (stable project slug)
        │         env = AMPLIFIER_MCP_CONFIG=<generated>
        │         stdin = /dev/null
        ├── stdout: skip to first line == "{", parse
        └── events.jsonl tailer → turn boundaries → UI
```

Install-time prerequisite: `amplifier bundle add muxterm-cos <uri>`, where that
bundle includes foundation + `tool-mcp` **without** inline servers.

### Still open

- **Cold-start cost at scale.** 7 s warm was measured on a 9-line transcript. A
  CoS session accumulates history forever, and every turn replays it. Measure at
  100 and 500 turns before trusting the latency number — this is the single
  likeliest reason A gets replaced by C.
- **Compaction.** What happens to a CoS session that runs for weeks? `context:compaction`
  exists; its behavior on a long-lived supervisory session is unverified.
- **`amplifier bundle add` from a local path** — needs confirming as the install
  story for a muxterm-shipped bundle.

### Spike artifacts

Scratch only, safe to delete: `/tmp/cos-spike/` and
`~/.amplifier/projects/-tmp-cos-spike/`.
