# The chief of staff is a level above, not a view beside

**Status:** design
**Date:** 2026-09-06
**Corrects:** the "peer overlay" model in `2026-09-06-cos-sidecar-spec.md` §3.4,
and the "third segment" idea that followed it. Both were wrong in the same way.

---

## 1. The correction

Cards and tiles answer *what is the fleet doing.* Two renderings, one question,
one altitude. I twice proposed adding the chief of staff as a third rendering —
first a peer overlay, then a segment on the same control. Both framed it as
**another way to look at the same thing.**

It isn't. The CoS is the thing that **creates** what cards render, and then
**watches** it. Different altitude, different verb:

```
        ┌─────────────────────────────────────────────┐
  CoS   │  dispatch · route · monitor · notice drift  │   changes the fleet
        └─────────────────────────────────────────────┘
                          │ creates              ▲ reads
                          ▼                      │
        ┌─────────────────────────────────────────────┐
 home   │  cards · tiles — Needs input/Working/Done   │   looks at the fleet
        └─────────────────────────────────────────────┘
                          │ open
                          ▼
        ┌─────────────────────────────────────────────┐
 dock   │  panes — the actual sessions                │   the work itself
        └─────────────────────────────────────────────┘
```

Home does not become obsolete when the CoS exists, and the CoS is not a faster
way to read home. **You go to home to look. You go to the CoS to change.**

### The UX consequence

They must never look like alternatives. So the CoS surface carries a **live
fleet rail** — the same card components, reading the same store — and you watch
cards *materialize* as the conversation dispatches work:

```
┌─ chief of staff ───────────────────┬─ fleet ──────────────┐
│                                    │                       │
│ you  auth is breaking on refresh   │  Needs input      0   │
│      tokens, and the docs went     │  ─────────────────    │
│      stale after the rename        │  Working          2   │
│                                    │                       │
│ cos  Two problems, two lanes,      │  ┌─────────────────┐ │
│      different workspaces:         │  │ ▸ auth-refresh  │ │ ← appears ~1s
│                                    │  │   amplifier     │ │   after spawn
│      → backend / auth-refresh      │  │   goal: refresh │ │
│        amplifier · /goal           │  │   tokens rotate │ │
│        "refresh tokens rotate      │  │   ● working     │ │
│         without re-login"          │  └─────────────────┘ │
│                                    │                       │
│      → docs / rename-pass          │  ┌─────────────────┐ │
│        claude · interactive        │  │ ▸ rename-pass   │ │ ← and this one
│                                    │  │   claude        │ │
│      Both running. I'll watch      │  │   ● working     │ │
│      them and tell you if either   │  └─────────────────┘ │
│      drifts.                       │                       │
├────────────────────────────────────┴───────────────────────┤
│ > describe a problem…                               [send] │
└─────────────────────────────────────────────────────────────┘
```

**The rail costs nothing to build.** CoS spawns a pane → `hooks-muxterm-session`
publishes session-state → sessiond's 1 Hz `collect()` picks it up → the existing
`session-state` wire → `home-sessions.ts` (already "the ONE seam") → card
renders. The materialize-as-you-talk effect is a *consequence* of the pipeline
that already ships, not a feature to write.

---

## 2. Delegate, never act

**The CoS's tool surface is workspace/pane/session lifecycle and reading. Nothing
else.** No bash. No file writes. No git. Not gated behind approval — *absent*.

This is a bundle-composition decision, and it is the strongest safety property in
the design: **a tool it does not have cannot be misused.** It also sidesteps a
trap found while building: `hooks-mode` runs `handle_tool_pre` at priority −20,
ahead of `hooks-approval` at −10, and overwrites `require_approval_tools` on
every `tool:pre` — so approval-gating a specific tool is not reliably enforceable
from a bundle. Removing the tool is.

| CoS may | CoS may not |
|---|---|
| create a workspace | close a workspace *(broadcasts to every connection, yanks the human's browser)* |
| create a pane, launch a lane in it | close a pane |
| send input to a lane (unblock, answer, steer) | run bash, edit files, commit, push |
| read fleet state and transcripts | do the work itself |

Closure stays human, permanently. That matches the sessiond invariant already in
AGENTS.md — sessiond alone authorizes destructive closure — and it means the
worst a confused CoS can do is make a mess of *new* things, never destroy
existing ones.

---

## 3. The blocking gap: MCP `create_pane` cannot launch anything

**The CoS cannot delegate today.** `internal/mcp/tools_layout.go:44` hardcodes:

```go
id, err := lt.c.conn.CreatePane(nil, placement, referencePaneID, "")
                              // ^^^ argv — always nil
```

The wire carries `Cmd []string`, and the browser composer uses it
(`ws.go:364`) — but the MCP schema exposes only `kind`, `placement`,
`reference_pane` (`run.go:275-293`). So an agent can create a **shell**, and
nothing else. The one thing a delegating CoS must do, it cannot.

### `spawn_lane` — one tool, the whole delegation

Rather than just exposing `cmd` (which invites an agent to construct argv by
hand), add a purpose-built tool that makes correct delegation the only
expressible delegation:

```
spawn_lane(
  workspace: string,           # by NAME — resolved or created
  harness:   "amplifier"|"claude",
  prompt:    string,
  goal?:     string,           # if set, launches as /goal → declares intent
  placement?: "tab"|"split-right"|…
) -> { workspace_id, pane_id, harness, session_id? }
```

It encapsulates: resolve-or-create workspace → attach → `create_pane` with argv
built by the **same** `harnessArgv()` logic the browser uses → return ids. One
call, atomic, and it hides the "you must switch_workspace first" footgun (the
MCP connection is a single shared attachment, so cross-workspace delegation
serializes — `client.go:501-528`).

The harness catalog becomes CoS *knowledge*, not CoS *string-building*:

| harness | launchable | argv | good for |
|---|---|---|---|
| `amplifier` (interactive) | ✅ | `amplifier run <prompt> --mode chat` | delegation, skills, MCP |
| `amplifier` (goal) | ✅ | `amplifier run "/goal <condition>"` | goal loops — **no** `--mode chat` |
| `claude` | ✅ | `claude <prompt>` | fast interactive edits |
| `codex`, `opencode` | ❌ recognized only | — | rows render; cannot be launched |

`--mode chat` is load-bearing for the **interactive** lane: without it the run
is single-shot and the pane dies after one turn (`harness.ts`).

It is exactly wrong for a **goal** lane. `/goal` is a slash command and
amplifier honours it only on the headless path — the single
`prompt.strip().lower().startswith("/goal ")` test lives in `execute_single`
(`main.py:4288`). Under `--mode chat` an initial prompt goes straight to
`_execute_with_interrupt` (`main.py:3992-4005`) and never reaches
`CommandProcessor`, so the condition arrives as ordinary prompt text,
`session_state["goal"]` is never set, and the lane comes back
`mode=interactive` with an empty `doneMeans`. A goal lane runs many turns
headlessly and then legitimately exits — that exit is the loop finishing, not
the pane dying early.

**Measured consequence, unsolved:** muxterm keeps no tombstone for an exited
pane. `Server.handlePaneExit` (`internal/sessiond/server.go`) removes the pane
on process exit, and `ReapIfEmpty` removes the workspace when that was its last
pane, taking the session-state row with it. A finished goal lane therefore goes
`autonomous/working` → absent from `fleet_status`, with no terminal
`done`/`failed` row observable in between (polled at 3s: present at T, absent at
T+4). Section 4's promise is only half kept: the CoS can read a goal lane's
declared intent **while it runs**, and cannot read its verdict afterwards. That
is a pane/row retention gap, not an argv one.

---

## 4. Intent, and how drift becomes detectable

**`doneMeans` is only ever set for `/goal` sessions.** `state.py:588-595` reads
`coordinator.session_state["goal"]["condition"]`; `_sync_mode(fresh_turn=True)`
actively **clears** it on every `prompt:submit`. So `mode=interactive` ⇒
`doneMeans == ""`, always. There is no other intent channel on the wire — no
plan, no task list, no goal file path.

That is not a limitation. It is the design:

> **When the CoS delegates, the CoS writes the stop condition.**

`spawn_lane(..., goal: "refresh tokens rotate without re-login")` launches
`amplifier run "/goal refresh tokens rotate without re-login"` — headless, with
no `--mode chat` (see the harness table above for why that flag would silently
disarm the loop). The lane now carries its own declared intent on the
session-state wire, visible to the card, the rail, and the CoS's own monitoring
pass. **CoS-delegated work is inherently drift-checkable because the CoS
declared what done means.**

For lanes the CoS did not create, the intent proxy is `name` (first meaningful
line of the first prompt, ≤80 chars). Weaker, and the CoS should say so rather
than pretend otherwise.

### Drift signals

Comparing declared intent against observed behavior, per pass:

| signal | source |
|---|---|
| working > N min with no `doing` change | `doing` is templated on every `tool:pre`/`tool:post` — a frozen one means genuinely stuck |
| `knows` diverging from the goal's subject | `knows` = distinct `artifact:read` paths, capped at 50 |
| `blocked` unattended for > N min | `state` + `waitingFor` |
| autonomous lane went `stopped` | already the `needsInput()` rule in `session-state.ts:169-210` |
| `done` but the goal condition reads unmet | `doneMeans` + last transcript turns |

Two pieces of machinery are missing and both are small:

1. **State transitions.** sessiond computes only *current* state — it keeps one
   FNV hash and a bool (`sessionstore.go:165-176`), deliberately not the
   snapshots. Drift needs `map[sessionID]SessionState` kept beside `lastHash`.
   Row ordering in the hash is already deterministic (`:398-401`).
2. **A periodic wake.** `emitSessionState()` (`server.go:1165`) already holds the
   fully joined row set every second, outside all locks. An N-minute counter
   there enqueues one CoS turn through the existing `internal/cos` queue. Zero
   idle burn; the CoS thinks only when woken.

---

## 5. New hooks: transcripts from both harnesses

The CoS must read what its lanes are *saying*, not just their state. Two
harnesses, two mechanisms, one contract.

### 5.1 Amplifier — extend `hooks-muxterm-session`

Write a compact tee beside the existing state file:

```
$XDG_RUNTIME_DIR/muxterm/session-chat/<session-id>.jsonl
{"ts":…,"role":"assistant","text":"…"}
{"ts":…,"role":"tool","name":"bash","status":"ok","summary":"…"}
{"ts":…,"role":"user","text":"…"}
```

Sourced from `content_block:end` (whole text blocks) and `tool:pre`/`tool:post`.
~200 bytes per turn, versus an `events.jsonl` measured at **464 KB with a
93,828-byte max line for two trivial turns**. The hook is already in-process and
already writes atomically; this is nearly free there and expensive anywhere else.

⚠️ Any producer of this tee must set `metadata={"stream": False}` on background
LLM calls — see the `label.py`/`classify.py` bug already fixed on this branch.

### 5.2 Claude Code — a real hook, because it has one

Claude Code ships a hook system: `PreToolUse`, `PostToolUse`, `SessionStart`,
`SessionEnd`, `Stop`, registered in `~/.claude/settings.json` (currently
unconfigured on this machine). So muxterm can ship a Claude Code hook that
publishes **the same session-state contract and the same chat tee.**

Its PID→session mapping is *better* than amplifier's:

```
~/.claude/sessions/<PID>.json
  { pid, sessionId, cwd, procStart, status, statusUpdatedAt, kind, name, … }
~/.claude/projects/<cwd with / → ->/<session-uuid>.jsonl     ← transcript
```

No setproctitle needed — PID → sessionId → cwd is explicit, so the transcript
path is computable. Liveness is `/proc/<pid>` existing **AND** field 22 of
`/proc/<pid>/stat` equalling `procStart` (guards PID reuse; the registry files
are *not* cleaned up on exit).

Transcript discriminator is `.type`, not `.role`. Useful types: `assistant`
(with `.message.content[].type` ∈ thinking/text/tool_use), `user` (real human
turns carry `promptSource:"typed"` and `origin.kind:"human"`; everything else is
a tool result), `system` (`.subtype` ∈ turn_duration/away_summary/agents_killed).
`queue-operation` is ~34% of records and is noise for this purpose — drop it.

**This is worth building even without the CoS:** today Claude Code panes get only
an argv-derived autolabel. With the hook they become first-class rows in the home
view — real state, real names, real `Needs input` triage.

### 5.3 One read tool, harness-agnostic

```
lane_transcript(session_id, last_n=10) -> [{role, text, tool?, ts}]
```

Resolves harness from session-state, then reads whichever format applies. The
CoS never learns that two formats exist. Must never load a whole file — bounded
tail extraction only.

---

## 6. What to build, in order

| | | why first |
|---|---|---|
| **1** | `spawn_lane` MCP tool + argv passthrough | **blocking** — without it the CoS cannot delegate at all |
| **2** | Fleet rail in `mux-cos.ts` | makes the altitude visible; the data already flows |
| **3** | `lane_transcript` + amplifier chat tee | the CoS can read its lanes |
| **4** | Claude Code hook | Claude lanes become first-class fleet members |
| **5** | Transition tracking + periodic wake | drift detection turns on |

1 and 2 are the demo. 3–5 are what make it a chief of staff rather than a
launcher.
