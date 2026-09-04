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
keeps its last declared state until its process exits, at which point the daemon
reclaims the file.

### Cleaning up

You do not have to. The daemon deletes any snapshot whose `pid` is dead or has
been recycled. Delete the file yourself only if you want a row to disappear
*while its process keeps running*.

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
| `waitingFor` | enum | Why it is blocked. Only meaningful with `state: "blocked"`. |
| `doing` | string | One short line of current activity. |
| `doneMeans` | string | This session's own definition of finished. |
| `knows` | string[] | Distinct paths this session has read. |
| `pr` | int | Pull-request number. Non-zero promotes the row to "Ready for review". |

`waitingFor` is one of: `permission prompt`, `input needed`, `sandbox request`,
`worker request`, `dialog open`.

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

## Related

- `internal/sessiond/sessionstate.go` — the wire contract (Go)
- `web/src/lib/session-state.ts` — its browser mirror
- `internal/sessiond/sessionwriter.go` — the reference writer
- `internal/sessiond/sessionstore.go` — the reader and the pane join
