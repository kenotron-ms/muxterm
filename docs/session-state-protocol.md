# Session-state protocol

**How any program tells muxterm what it is doing, so it shows up in the home
view.**

muxterm's home view is a fleet view for coding-agent CLIs. Amplifier sessions,
Claude Code sessions, and a nightly shell script can appear in it side by side,
because none of them talk to muxterm directly: each one writes a small JSON file
into a spool directory, and the daemon reads that directory.

This document is the contract for writing those files. It is a **public
integration contract**, not an implementation detail — if you follow it, your
tool appears in the fleet.

If you only want to report from a shell script, skip to
[The easy way](#the-easy-way-muxterm-session-report). You do not need any of
the rest.

---

## Why a file

muxterm's daemon already classifies pane activity by asking the kernel which
process group owns the terminal. That signal cannot answer the only question
the home view cares about: **an agent that is thinking owns the terminal, and an
agent sitting at a permission prompt waiting for a human also owns the
terminal.** Identical PTY state, opposite meanings.

The distinction is not recoverable by inspection, so sessions *declare* it
instead. A file was chosen over the daemon's binary control protocol because it
means a producer needs no frame codec, no socket, no reconnect logic, and no
running daemon. Writing about twenty lines of JSON in any language is the entire
integration.

---

## The easy way: `muxterm session report`

One command. No library, no language binding, no daemon connection.

```bash
muxterm session report --session-id nightly-smoke --harness ci-runner \
    --mode autonomous --state working --name 'nightly smoke' \
    --doing 'stage 3 of 6' --done-means 'all six stages green'
```

```
reported nightly-smoke (working, autonomous) pid 624507 -> /run/user/1000/muxterm/session-state/nightly-smoke.json
```

Call it again whenever something changes. Each call replaces the whole
document, so there is no state to keep and nothing to clean up.

Run `muxterm session report --help` for the full flag list. Enum values are
validated and a bad one is a loud non-zero exit — a producer that silently
writes garbage is worse than one that errors, because the garbage is skipped by
the reader with no explanation.

---

## Where snapshots go

One file per session, named `<sessionId>.json`, in a spool directory resolved in
this order:

| # | Source | Path |
|---|--------|------|
| 1 | `$MUXTERM_SESSION_STATE_DIR` | used verbatim |
| 2 | `$XDG_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/muxterm/session-state` |
| 3 | fallback | `<tmpdir>/muxterm-<uid>/session-state` |

Deriving the default from `XDG_RUNTIME_DIR` is what makes development isolation
automatic. `make dev-local` overrides that variable, sessiond inherits it, panes
inherit it from sessiond, and a producer running inside a pane computes the very
same directory. A dev daemon can never read production's spool, and neither side
has to be told which world it is in.

Create the directory if it does not exist (mode `0700`). Snapshot files should
be `0600`. Nothing breaks if the daemon is not running — the snapshot simply
waits.

---

## Writing a snapshot

**Write to a temp file, then rename.** The reader polls this directory about
once a second, and `rename(2)` is atomic within a filesystem, so a reader either
sees the whole previous document or the whole next one — never half of one.

```
<spool>/.<sessionId>.tmp     write here
<spool>/<sessionId>.json     rename to here
```

The temp file **must** be a sibling (same filesystem, or the rename is not
atomic) and **must** be dot-prefixed and not end in `.json`, so the reader skips
it while it exists.

```python
tmp = spool / f".{session_id}.tmp"
tmp.write_text(json.dumps(payload))
os.chmod(tmp, 0o600)
os.replace(tmp, spool / f"{session_id}.json")   # atomic
```

### Cadence, and why a missed write is fine

**Write as often or as rarely as you like.** A snapshot is an *idempotent
whole-state document*, not a delta. That single property is what makes this
protocol forgiving:

- A write that is lost, raced, or skipped is repaired by the next one.
- Two writers racing produce one of the two documents, never a mixture.
- The daemon never holds a wrong delta forever, because there are no deltas.
- You never have to "catch up" after an outage. Just write the current truth.

There is no heartbeat requirement and no timeout. A session that stops writing
keeps its last declared state for as long as that state still describes
something (see below).

### What happens when your process exits

This is the one rule worth knowing, because it decides whether your session's
outcome is ever seen.

**If your last written state was `done`, `failed`, or `stopped`, the row
survives your process.** That is the point of the view: it answers "how did it
end?", and a row that vanishes the instant your process exits cannot. So write
your ending *before* you exit, and then just exit — do not delete the file.

The ending is reclaimed when it stops being useful, not on a timer you have to
think about:

- the moment that **pane runs another session** — the new one supersedes it, so
  a pane shows at most one ending, never a pile
- the moment that **pane is closed** — closing a terminal is the user saying
  they are done with it, endings included
- after 24 hours, by the producer-side sweep, on a machine where nobody ever
  opens the home view and neither of the above ever happens

**If your last written state was `working` or `blocked`, the row is reclaimed
as soon as your process is gone.** A session killed mid-flight never got to say
how it went, and leaving it up would assert that it is still thinking, or still
waiting on a human, when it is neither.

A snapshot whose `pid` has been recycled by an unrelated process is always
reclaimed, whatever it says (see `pidStart`).

None of this depends on anyone watching. The row is placed from the `sid` you
recorded in the file, not from your `/proc` entry, so a session that starts and
finishes with no browser open still has its ending waiting when one opens.

### `sid` — how a finished session is still found

`sid` is your POSIX session id, and it is what makes the two rules above
possible. sessiond gives every pane its own pty and makes the pane's root shell
the leader of a new session, so **every process started in that terminal
carries that shell's pid as its session id** — which is the exact key the
daemon's pane map is built on. One integer, one lookup, no walk.

Write it, and write it *while you are alive*:

```sh
sid=$(awk '{ n = index($0, ")"); split(substr($0, n + 2), f, " "); print f[4] }' /proc/self/stat)
```

Omit it and the daemon falls back to walking your process ancestry, which works
while you are running and is impossible afterwards — so your ending would be
reclaimed unseen. `muxterm session report` fills this in for you.

### Cleaning up

You do not have to. Delete the file yourself only if you want a row to
disappear *while its process keeps running*.

---

## The document

```json
{
  "v": 1,
  "pid": 630913,
  "pidStart": 288874457,
  "sessionId": "nightly-smoke",
  "harness": "ci-runner",
  "project": "/home/ken/workspace/muxterm",
  "name": "nightly smoke",
  "label": "smoke matrix",
  "mode": "autonomous",
  "state": "working",
  "waitingFor": "",
  "doing": "stage 3 of 6 — reconnect matrix",
  "doneMeans": "all six stages green",
  "knows": ["/home/ken/workspace/muxterm/AGENTS.md"],
  "pr": 0,
  "updatedAt": 1788535722
}
```

### Required

| Field | Type | Meaning |
|-------|------|---------|
| `v` | int | Schema version. Write `1`. See [Versioning](#versioning). |
| `pid` | int | The process this session belongs to. See [Which pid](#which-pid). |
| `sessionId` | string | Stable id, unique among live sessions. Becomes the filename. |
| `name` | string | Short title for the row. Use the session id if you have nothing better; a blank row is unreadable. |
| `mode` | enum | `autonomous` \| `interactive`. **[Read this](#mode-the-one-that-matters).** |
| `state` | enum | `working` \| `blocked` \| `done` \| `failed` \| `stopped`. |
| `updatedAt` | int | Unix seconds of this observation. |

`sessionId` must be 1–128 characters of `[A-Za-z0-9._-]` and must not start with
`.`. This is enforced, not advisory: the id is concatenated into a path, so a
separator in it would write outside the spool. A leading dot is rejected because
the reader skips dotfiles — such a file would be written successfully and then
silently never read, which is the most confusing possible outcome.

### Optional

| Field | Type | Meaning |
|-------|------|---------|
| `pidStart` | int | Process start time (see below). Strongly recommended on Linux. |
| `harness` | string | Which agent CLI this is. Open set; see [Harness](#harness). |
| `project` | string | Absolute working directory. |
| `label` | string | 1–3 words naming the work, for a pane tab. Not a shorter `name`; see below. |
| `waitingFor` | enum | Why it is blocked. Only meaningful with `state: "blocked"`. |
| `doing` | string | One short line of current activity. |
| `doneMeans` | string | This session's own definition of finished. |
| `knows` | string[] | Distinct paths this session has read. |
| `pr` | int | Pull-request number. Shown on the row; does not change its group. |

`waitingFor` is one of: `permission prompt`, `input needed`, `sandbox request`,
`worker request`, `dialog open`.

`label` is what a pane tab can show whole — about three words and 24
characters, e.g. `auth redirect`. Two rules make it useful: name the *subject*
of the work rather than the request for it, and **derive it once and then stop
changing it**. A label that moves is a session you cannot find twice, which is
worse than one that was never labelled at all. Omit the field entirely if you
have nothing to say; an absent `label` means "keep whatever muxterm already
worked out from the pane's command line", while a label that appears and then
churns actively costs the user something.

### Never write these

`paneId` and `workspaceId` are **the daemon's**, filled in during the pane join.
Anything you put there is discarded. You cannot know them — that is the point of
the division of labour described below.

### Size

A snapshot must be under 64 KiB. Keep `doing` to about 120 characters,
`doneMeans` to about 400, and `knows` to about 50 entries of 256 characters. The
reader silently skips an oversized file; `muxterm session report` refuses to
write one.

---

## Which pid

**This is the field that decides whether your row appears at all.**

You report a pid; the daemon walks *up* the process tree from it until it
reaches a pane's root shell, and that is how a row learns which terminal it
belongs to. The division of labour is deliberate: a producer knows its own
process and nothing about muxterm, and the daemon knows which pane owns which
process. Teaching every producer about panes would duplicate knowledge the
daemon already has, in every language anybody ever writes a producer in.

Consequences:

- **The pid must be alive** when the daemon looks. A short-lived reporter that
  exits immediately must report a *longer-lived ancestor* — its parent script or
  shell — not itself. This is why `muxterm session report` defaults `--pid` to
  its caller.
- **Any live ancestor inside the pane works.** The walk goes upward, so a
  script, its subshell, and its parent shell all resolve to the same pane.
- **A process outside every muxterm pane cannot be placed.** The snapshot is
  written successfully and then not shown. This is correct: a row with no pane
  is a row the home view cannot act on, and inventing a location for it would be
  worse than omitting it.

### `pidStart`

A pid alone is not an identity — it is recycled. A snapshot that outlives its
session could be matched to a reassigned pid belonging to somebody's editor, and
published as a live row glued to an unrelated terminal, indistinguishable from a
real one for as long as the recycling process lives.

`(pid, pidStart)` *is* an identity. On Linux, `pidStart` is field 22 of
`/proc/<pid>/stat` — index 19 of the fields after `comm`. Split on the **last**
`)`, because `comm` is parenthesized and may itself contain parens.

Omit it (or write `0`) if you cannot determine it. The daemon treats that as
unverifiable rather than mismatched and degrades to pid-only matching.

---

## `mode`: the one that matters

If you get one field right, make it this one. It answers a single question:

> **Does this session going quiet mean it BROKE, or that it is RESTING?**

| Value | Quiet means | Alarm? |
|-------|-------------|--------|
| `autonomous` | The loop broke. | **Yes. This is the alarm.** |
| `interactive` | It is waiting for a human, which is its contract. | **Never.** |

Getting this backwards makes every idle session look like an emergency. Users
learn to ignore the indicator, and then the home view is worthless — including
for the real failures it was built to catch.

If you genuinely cannot tell, write `interactive`. A missed alarm costs one
unnoticed stall; a false alarm costs the user's trust in every future alarm.
That is the direction both shipped producers default in.

*(This field used to be spelled `goal|plain`, after Amplifier's `/goal` command.
It was renamed because that spelling only names the distinction correctly if you
already know what `/goal` is, while the distinction itself is universal: Claude
Code has background and foreground sessions, a job CLI has batch and attended
runs.)*

---

## `harness`

Which agent CLI is running this session. muxterm recognizes `amplifier`,
`claude`, `codex`, and `opencode` — these are the same names it uses to identify
agent CLIs everywhere else, so use them if one fits.

**The field is open.** Declare any string you like. A value muxterm does not
recognize renders with a neutral badge; it is **never** a reason to drop the
row. A fleet view that hides part of the fleet because it has not heard of the
runner would be lying about the fleet.

Omitting `harness` is fine too — the row renders without a badge rather than
with an empty one.

---

## Versioning

Every snapshot carries `v`. Write `1`.

A reader **skips a snapshot whose `v` is higher than it understands**, logs one
line saying so, and **leaves the file alone** — a newer daemon may be about to
read it, and destroying another component's data over a version skew would be
the worst available response. A missing `v` is treated as `1`, the
field-identical pre-versioning shape, so upgrading the daemon ahead of its
producers cannot blank the view.

Bump `v` only for a **breaking** change to the shape. Adding a new optional
field is not breaking — old readers ignore it, which is what "optional" means.
That is the whole reason the version exists: it lets a reader decline loudly
instead of mis-displaying a document it does not understand.

---

## A complete worked example

A nightly build script, in plain `bash` and `python3` — no muxterm code, no
`muxterm` binary, nothing but a file write. This is the whole integration.

```bash
#!/usr/bin/env bash
# nightly.sh -- runs six build stages and reports each one to muxterm.
set -euo pipefail

SPOOL="${MUXTERM_SESSION_STATE_DIR:-${XDG_RUNTIME_DIR:-/tmp}/muxterm/session-state}"
SESSION_ID="nightly-build"
SELF_PID=$$          # this script's own pid: alive for the whole run,
                     # and a descendant of the pane it was started in.

report() {   # report <state> <doing>
  mkdir -p "$SPOOL" && chmod 700 "$SPOOL"
  STATE="$1" DOING="$2" SPOOL="$SPOOL" SESSION_ID="$SESSION_ID" \
  SELF_PID="$SELF_PID" python3 - <<'PY'
import json, os, pathlib

spool = pathlib.Path(os.environ["SPOOL"])
sid   = os.environ["SESSION_ID"]
pid   = int(os.environ["SELF_PID"])

def pid_start(pid):
    """Field 22 of /proc/<pid>/stat: turns a recyclable pid into an identity."""
    try:
        stat = pathlib.Path(f"/proc/{pid}/stat").read_text()
        return int(stat[stat.rindex(")") + 1:].split()[19])
    except Exception:
        return 0     # unavailable is fine; the daemon degrades to pid-only

payload = {
    "v":         1,
    "pid":       pid,
    "pidStart":  pid_start(pid),
    "sessionId": sid,
    "harness":   "nightly-build",      # any string; unknown gets a neutral badge
    "project":   os.getcwd(),
    "name":      "nightly build",
    "mode":      "autonomous",         # unattended: going quiet IS the alarm
    "state":     os.environ["STATE"],
    "doing":     os.environ["DOING"],
    "doneMeans": "all six stages green",
    "updatedAt": int(__import__("time").time()),
}

# Atomic: write a dot-prefixed sibling, then rename over the real name.
tmp = spool / f".{sid}.tmp"
tmp.write_text(json.dumps(payload))
os.chmod(tmp, 0o600)
os.replace(tmp, spool / f"{sid}.json")
PY
}

trap 'report failed "stage ${STAGE:-?} failed"' ERR

for STAGE in 1 2 3 4 5 6; do
  report working "stage $STAGE of 6"
  ./run-stage "$STAGE"
done

report done "all six stages green"
```

Run it in a muxterm pane and it appears in the home view as an `autonomous`
session badged `nightly-build`, updating as it goes, and turning red if a stage
fails. Nothing had to be registered, no daemon had to be running when it
started, and if the machine loses a write the next stage repairs it.

The same thing with the built-in verb, if `muxterm` is on your `PATH`:

```bash
muxterm session report --session-id nightly-build --harness nightly-build \
    --mode autonomous --state working --doing "stage $STAGE of 6" \
    --done-means 'all six stages green'
```

---

## Shipped producers

| Producer | Kind | Where |
|----------|------|-------|
| Amplifier | in-process hook | `modules/hooks-muxterm-session` |
| any tool | one-shot CLI | `muxterm session report` |
| Claude Code | opt-in poller | `internal/sessiond/claude_adapter.go` |

The Claude Code adapter is off unless `MUXTERM_CLAUDE_ADAPTER=1` is set in
sessiond's environment. It polls `claude agents --json` every five seconds while
a browser is subscribed, and degrades silently — a missing `claude`, a non-zero
exit, or unparseable output costs one log line and nothing else.

An environment variable rather than a config key, because the config file is the
*browser's* config, live-editable from the UI, and "may this daemon execute a
subprocess" is not a preference a web page should be able to flip.

## Amplifier lane commissioning

Publisher `hooks-muxterm-session/0.7.0` reuses the existing v1 snapshot; it is
not another card producer. It requires core 1.6.1's supported **module-level
async `on_session_ready(coordinator)` callback**, invoked after successful
mounts and before the first prompt. This is not a `session:ready` event.
Module mount is idempotent per coordinator and returns hook-unregistration
cleanup. Only root sessions stamp titles and publish cards by default;
child coordinators establish ancestry and fold activity into the root.

The current bundle already mounts this module through
`behaviors/muxterm.yaml`. MCP tool availability alone does not install it.
Do not modify personal or cached bundles to force registration. Use an
explicitly composed bundle or the existing supported project-local module
source override, then start a **new** process. Already-running lanes keep
their imported code and registrations: they are **not hot-patched**.
`publish_state: false` remains an intentional opt-out; title recovery is
independent. Optional model-based labels/classification retain their existing
configuration; neither is called during readiness.

### Supported transitions

| Source | Declaration |
|---|---|
| `on_session_ready` callback | `stopped`, `lifecycle: initialized`; awaiting first prompt, not working/blocked from process existence |
| `session:start` / `session:resume` | First execute is working; idempotent start/resume handlers |
| `execution:start` | Subsequent actual turn starts, even when CLI does not emit `prompt:submit` |
| `tool:pre` / `tool:post` / `tool:error`, `provider:error` | Bounded activity, recoverable errors are not terminal failures |
| Successful root `todo` POST | `result.output.todos` supplies committed counts/current task; explicit `[]` clears; attempted/failed/malformed changes do not replace progress |
| `approval:required` / `approval:granted` / `approval:denied` | Real optional approval-hook waits; unrelated child/tool activity does not clear an outstanding approval |
| `orchestrator:complete` / `prompt:complete` | Interactive turn ended; not proof the process exited |
| `orchestrator:goal_progress` | Live goal metadata/verdict, not “headless implies autonomous” |
| `cancel:requested` / `cancel:completed` | Cancelling is interim; completed cancellation is stopped/cancelled |
| `session:end.status` | completed → done unless a terminal goal verdict is already declared; failed → failed, cancelled → stopped; absent/unknown status → stopped/unknown |

Optional sources/fields vary by orchestrator and modules. Missing events cannot
prove a lifecycle transition. The optional wire `lifecycle` field distinguishes
initialized/running/resumed/turn-complete/completed/failed/cancelled/unknown.
The collector may emit `lost` when a proven pane generation outlives a producer
without a terminal report. It clears stale waiting/todo rather than resurrecting
working state. A previous autonomous terminal verdict can accompany a freshly
initialized interactive handover; it does not mean the loop resumed.

### Three different readiness facts

Use the repo-owned helper inside a muxterm pane on the target machine:

```sh
# Explicit launch: leave out the prompt to avoid a model turn for registration.
python3 tools/commission-amplifier.py --bundle /path/to/composed-bundle.yaml

# Supported saved-root resume, still no model turn until a prompt is submitted.
python3 tools/commission-amplifier.py --bundle /path/to/composed-bundle.yaml \
  --resume SESSION_ID

# Pure observation of a newly launched root (also works for the goal run PID).
python3 tools/commission-amplifier.py --observe-pid PID --timeout 15
```

The launch form runs the ordinary Amplifier CLI, including its normal first-run
setup/update behavior; it is not a side-effect-free preflight. Use observer mode
when launches are owned elsewhere. Existing UI/MCP/CLI/trigger launchers still
use their effective bundle; their pane/harness acknowledgement is **only process
started**, not proof of a loaded hook or collector receipt.

The helper distinguishes `process/started`, `publisher/initialized`, and
`collector/observed`. It never sends dummy prompts, writes snapshots, installs
hooks, polls providers, or kills the agent on a reporting failure. It checks for
at most 15 seconds by default (maximum 60), activating the ordinary read-only
`muxterm fleet --json` subscription. Collector absence/failure, disabled publisher,
missing/incompatible publisher, unsafe/unwritable spool, rejected identity and
missing receipt remain structured non-success results. Launch mode leaves the
agent running regardless; observer mode exits 2 unless observed.

Publisher diagnostics live under `<spool>/.reporting/<sessionId>.json`.
Registration diagnostics are also available as coordinator capability
`hooks-muxterm-session/0.7.0/diagnostic`. These contain bounded codes and identities,
not prompt bodies, raw tool payloads, provider error text or transcripts.
Unwritable diagnostics degrade to bounded code-only warnings, never agent failure.

### Collector receipt contract (local, private, v1)

The new publisher adds on-disk `publisher` and `sidStart`; these are not sent to
the browser. Its receipt is `<spool>/.receipts/<sessionId>.json`, atomically
written 0600. An `observed` receipt follows actual collection and final pane
retention; a `rejected` receipt records validation/placement rejection. The receipt
contains v, sessionId, pid, pidStart, publisher, status, code, snapshotSha256,
collectorPid, collectorStart, observedAt, and (only if observed) workspaceId/paneId.
The SHA-256 names the exact snapshot bytes ingested. The helper checks that digest,
both live process generations, and binding; an old collector's receipt cannot
commission a new daemon. Reattach uses the existing authoritative whole-fleet
subscription; no producer activity is needed.

For this negotiated publisher, Linux `(pid,pidStart)` and `(sid,sidStart)` must
be verifiable. Live placement checks actual SID **and ancestry**; dead placement
requires the same still-live SID generation. Unknown identity/platform support
is rejected, never assigned by a pane number or guessed parent. Schema or publisher
versions not supported by this collector are rejected with fixed codes. Legacy
v1 producers do not gain receipts or claim commissioned status; private same-user,
regular, bounded file requirements apply to all reads. No auth or adapter opt-in
is changed. The `MUXTERM_SESSION_STATE_DIR` override remains supported.

**Current residuals:** real browser commissioning must be run before rollout.
The existing three-group browser still places initialized/stopped rows in its
completed group even though their `doing` line says initialized; a lifecycle-aware
group label requires coordinated UI work. The pane-completion callback carries only
a root PID, so after that root has been reaped its start identity cannot be proved:
new-publisher completion lookup rejects it rather than risking a wrong historical
binding. A future identity-aware callback change is separate from this publisher.

### Recovery boundary

Amplifier's proc-title identity and start/resume title fallback remain intact.
`snapshot.go` can construct `amplifier resume <ID>`; its current `events.jsonl`
existence check is not proof of complete resumable context. Restoring a pane is
not process survival, and an interactive resume is not a goal-loop restart.
Claude's reporting adapter does not provide symmetric identity-bound recovery.
No Claude recovery change or production restart is part of this integration.

## Related implementation

- `internal/sessiond/sessionstate.go` — the wire contract (Go)
- `web/src/lib/session-state.ts` — its browser mirror
- `internal/sessiond/sessionwriter.go` — the reference writer
- `internal/sessiond/sessionstore.go` — the reader and the pane join
