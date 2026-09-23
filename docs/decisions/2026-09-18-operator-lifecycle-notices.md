# Operator lifecycle notices, and the former Claude fleet adapter

> **Current status (2026-09-22):** Native Claude hooks replaced the polling
> adapter and its `MUXTERM_CLAUDE_ADAPTER` gate. The adapter discussion below
> records the decision at the time; it no longer describes current behavior.

**Base:** `origin/main` · **Status:** implemented behind an off-by-default switch, not merged, not released.

## What this is

A lane finishes at 03:00. Its fleet card flips to `done` immediately — that
already worked. But nothing is ever said in the one conversation the human
actually reads, so they come back to a sidebar chip and have to go excavate the
result from a pane that may no longer exist.

This adds **one narrated Operator turn per authoritative lane event**, and
nothing else. No progress chatter, no "still running", no batching, no priority
lane.

## Approved shape

The design this implements is the one approved in the Operator conversation
("the operator completion turn — go with your recommendations"), together with
its five product decisions:

| Decision | Approved answer | Where it lives |
| --- | --- | --- |
| Redaction of lane output fed to the model | `voiceContextRedactions` as **best-effort defence in depth**, never claimed as a boundary | `lifecycleEnvelopeFor`, `internal/server/lifecycle_notices.go` |
| Which blocked/stopped states notify | **autonomous lanes only** — an interactive session at its own prompt is resting, not an alarm | `lifecycleKindFor`, `internal/sessiond/lifecycle_watch.go` |
| Retry when the notice turn itself fails | **3 attempts**, short exponential backoff, then a plain templated notice rather than silent loss | `deliver`, `internal/server/lifecycle_notices.go` |
| Summary input scope | the **capped structured envelope only** — never a transcript tail | `lifecycleNoticeEnvelope` |
| V1 rollout scope | **local machine only** | markers are read from this host's own XDG data dir; nothing crosses a transport |

Plus the decision reconciled with the Goalify research lane: a notice is an
explicit **`Origin: lifecycle`** turn carrying a **causation id**, never a bare
human-shaped submit.

## Two objects, never the same name

- **Lifecycle marker** — the durable fact, written by sessiond.
  `CompletionRecord` (already shipped, pane exit) plus the new
  `AttentionRecord` (live transitions).
- **Operator turn** — the rendered synthetic entry, generated *from* a marker.

The five words are the whole vocabulary and each is one evidence tier:
`finished` (declared `done` — nothing else earns it), `failed`, `stopped`,
`unverified` (exited having declared nothing — crash, kill, *or a harness with
no reporting hook wired up at all*), `blocked`.

## Why a live watcher was unavoidable

A `/goal` lane does not exit when it reaches a verdict. `goallane.go` runs
`amplifier run "/goal …"` and then **execs into `amplifier resume`** in the same
pane. The pane never closes, so `handlePaneExit` never runs, so no
`CompletionRecord` is ever written — for the single most common "finished" case
this feature exists to report. Nothing in the daemon was edge-triggered before
this: `sessionstore` hashes the aggregate row set, which can say *something
differs* but never *this session just went working → done*.

`internal/sessiond/lifecycle_watch.go` is the first per-session edge detector in
the daemon. Its first sighting of any session is a **baseline, never an event**,
which is what stops a daemon restart from announcing lanes that were already
terminal when it started.

## Deliberate deviation: a server-owned delivery ledger

The approved design put an `OperatorNotified` flag on `CompletionRecord`
itself — "no separate outbox format, no dual-write race between two independent
durable writers".

In the real process topology that inverts its own goal. `muxterm serve` and
`muxterm sessiond` are **separate processes**, and this repository already
states the rule in `internal/server/prs_store.go`: *"SINGLE WRITER, AND IT IS
THIS PROCESS. sessiond owns completions.json"* — which is why the PR collector
reads that file and keeps its own `collected-prs.json`. Flipping a flag on
sessiond's record from the server would be exactly the dual-writer the design
wanted to avoid; the alternative (a new protocol verb plus a long-lived
server→daemon connection that survives daemon restarts) is materially more
surface area for the same result.

So delivery state lives in `operator-notices.json`, written only by the server,
beside the marker files. Each file keeps exactly one writer. The ledger holds no
payload — markers remain the only source of truth about what happened; the
ledger records only whether it has been said out loud.

It carries **two** idempotency axes, and the second is the one that matters in
practice:

1. the marker's own id;
2. `sessionID|kind` — because a `/goal` lane declares `done` while alive (a live
   marker) and then, much later, its pane exits and produces a completion record
   with outcome `completed`. Two marker ids, one event, one notice.

The migration hazard is unchanged and is still a named step: the first run seeds
the ledger with every announceable marker that already exists, marked
already-announced, **before any delivery is attempted**. Without it, switching
the feature on would narrate up to two hundred historical lanes into the
conversation days after the fact.

## Durable origin, not a live-only decorator

A browser that reconnects rebuilds the conversation from the persisted
transcript, not from the event stream. If origin lived only on the live event,
the same turn would render as a system notice before a refresh and as a human
message after one.

So origin travels on the dispatch op to the sidecar, which stamps
`muxterm_origin` onto the message that opened the turn, and `_summarize_turn`
carries it into `history`. Absence means `human` — everywhere, including every
turn written before this field existed. The only value that renders as a system
notice is `lifecycle`, so the failure direction of anything unrecognised is
always "a person said this": a system turn shown as human is cosmetic, a human
turn shown as system is a forged message.

`session.execute` takes a prompt string and nothing else, and amplifier is a
dependency here rather than part of this repository, so the stamp is applied by
locating the message after execution. The match is strict and a miss degrades to
*no stamp* (replays as human) rather than to *the wrong message stamped*.

## Historical: Claude fleet adapter on by default

The adapter was opt-in behind `MUXTERM_CLAUDE_ADAPTER=1`. The practical effect
was that Claude Code sessions were absent from the fleet on every machine nobody
remembered to configure, which reads as "muxterm cannot see Claude Code" rather
than "muxterm was not switched on". A fleet view that silently omits half the
agents on the machine is worse than one that shows them, because it is believed.

It is now on by default with an explicit opt-out: `MUXTERM_CLAUDE_ADAPTER=0`
(or `false`/`no`/`off`). Any other value — including a typo — means enabled,
which is the right direction for an opt-out: a misspelling must not silently
disable something an operator believes is running.

The original objection is answered by what the adapter actually does: one
documented, non-TTY, read-only scripting command (`claude agents --json`), stdin
closed, hard timeout, no untrusted input, no side effect on the Claude Code
install, and one log line forever on a machine without `claude` on PATH.

**No service unit is modified by this PR.**

## Feature gate

`MUXTERM_OPERATOR_LIFECYCLE_NOTICES` — on by default (corrected after the
initial rollout left production notices disabled). Set `0`, `false`, `no`, or
`off` to opt out. Read by both processes
through one exported helper so the two halves cannot be half-enabled by a
different spelling in one unit. An environment variable rather than a config
key keeps this system-level policy out of `config.toml`, which is the browser's
live-editable preference file: "may this system write turns into my Operator
conversation" is not a preference a web page should be able to flip.

With the switch off, sessiond's tick behaves exactly as before — including
costing nothing when no browser has subscribed. With it on, the tick runs
regardless of subscribers, because a lane finishing while nobody is watching is
precisely the case a durable notice exists for. That trade is stated in the code.

## Artifacts

Within the existing contracts, not beside them. Artifacts come from the
mechanical extractor already in `completion.go` (`completionPRURLsFrom`) and
carry `source_authority` so a scraped URL is never presented as a declared one.
An empty artifact list is **stated explicitly** in the notice: a silent omission
reads as "nothing to report", which is a different and false claim. There is no
new scraping, no transcript mining, and no second artifact-presentation
contract — a file artifact would go through `/api/artifact` verbatim.

## Validation boundary

`AGENTS.md` bans new unit tests in this repository and requires verification
against a real daemon instead. This PR adds **no `_test.go` files**. It adds
`make verify-lifecycle`, a dev target that expands the Makefile's own
`DEV_ISOLATE` macro (so no dev target sets `XDG_*` by hand, as that file
requires), starts a real sessiond, creates a real pane, runs the shipped
reference producer inside it, and reads the durable markers the daemon wrote. It
binds no production port and kills only pids it started.

Evidence: `docs/verification/2026-09-18-operator-lifecycle-notices.md`.

**Not proven here, and stated rather than implied:** a model-generated notice
rendering end to end in a browser against a live Operator sidecar. That needs
provider credentials and a live COS session; the delivery path is verified up to
and including the FIFO submit seam and the ledger, and the two pre-existing test
failures on `main` (`TestRegistryListReportsWorkspaceInfo`,
`TestTheFourExistingToolsAreUnchanged`) are unchanged by this branch.
