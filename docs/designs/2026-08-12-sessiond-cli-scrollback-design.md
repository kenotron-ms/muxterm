# Local CLI over the sessiond socket protocol, with scrollback pagination

Covers GitHub issues **#23** (local CLI over the sessiond socket protocol) and
**#22** (paginated scrollback buffer access via cursor), delivered together as a
single scope.

## Goal

Add a local CLI (`muxterm read-screen`, `muxterm session`, `muxterm pane`,
`muxterm layout`) that talks directly to sessiond's Unix-socket wire protocol,
so shell scripts, cron jobs, and other automation can control muxterm and read
terminal state without speaking MCP — and add real server-side scrollback
retention to sessiond so "retrieve the scroll buffer" is literally true rather
than "dump the current screen."

## Background

sessiond already has a complete framed-JSON control protocol over a Unix socket
(`internal/sessiond/protocol.go`): workspace/pane lifecycle, resize, focus,
layout, and `screen-snapshot`. Today that protocol has exactly one client
wrapper — `internal/mcp/client.go`, which wraps `sessiond.Client`
(`internal/sessiond/client.go`) and dials the socket directly via
`sessiond.Dial(socketPath)`. There is no supported path for a shell script or
cron job to read a pane; the only options are to speak MCP or hand-roll a
socket client. That is issue #23.

Two facts from the codebase survey shape this design:

1. **`cmd/muxterm/cli.go` already has the right scaffolding.** It dispatches
   subcommands (`serve`, `sessiond`, `deploy`, `version`, `install`,
   `uninstall`, `doctor`, `mcp`, `amplifier`) with a `flag.NewFlagSet` per
   subcommand, and `runDoctor()` is a working precedent for a one-shot CLI
   command that dials sessiond and fails fast when the daemon isn't running.
   A `session`/`pane`/`read-screen`/`layout` command tree extends this pattern
   with no new architecture.

2. **sessiond has no server-side scrollback for production VT-backed panes.**
   `VTBuffer` (`internal/sessiond/vt.go`) tracks only the live grid;
   `ScreenText()` renders the current viewport and nothing else.
   `VTBuffer.ReplayFrom` ignores its `since` argument. Real scrollback today
   lives only client-side, in the browser's xterm.js buffer (10,000 lines).
   `RawBuffer` is the only thing in the daemon with genuine absolute-sequence
   pagination — `ReplayFrom(since uint64) (data []byte, start uint64)`, with
   clamping to the oldest retained byte after trimming.

So a CLI built on today's protocol alone would ship a command that can only
ever print the current screen. Retrieving scrollback requires sessiond to
actually retain it. That is issue #22, and it is why both issues are in scope
here.

## Approaches Considered

**Approach A — bounded scrollback ring in `VTBuffer` + generalized cursor
pagination, CLI as a thin protocol mirror (chosen).** Add a capped ring of
finalized rendered lines alongside the live grid, generalize `RawBuffer`'s
already-proven absolute-sequence cursor model from raw bytes to rendered lines,
add one additive request/reply message pair, and build the CLI as thin
one-shot wrappers over the existing `sessiond.Client` methods. Reuses two
mechanisms already working in the codebase instead of inventing new ones, and
leaves the live-viewport rendering path — the part with documented, sensitive
invariants — untouched.

**Approach B — raw-byte scrollback, reusing `RawBuffer` directly for VT panes
(rejected).** Retain the raw PTY byte stream for VT-backed panes and serve
byte-range pages from it. Rejected: it puts a second consumer on the raw byte
path for panes whose authoritative representation is the VT grid, forcing
either client-side re-emulation of ANSI to produce readable lines or shipping
raw escape sequences to shell scripts. It also has a materially larger blast
radius against the VT rendering invariants documented in `AGENTS.md` (terminal
query ownership, CSI 6n / OSC 11;? handling) — precisely the area where a
subtle mistake reappears as garbled user-visible terminal output.

**Approach C — CLI-side-only accumulation, no sessiond changes (rejected).**
Have the CLI attach, collect streamed pane data, and assemble its own history.
Rejected: it cannot retrieve history that predates the CLI invocation, which is
the entire point of the ask ("read the scroll buffer of a pane that has already
been running"). A one-shot cron invocation would see nothing. It also
contradicts this work's stated exit condition, which requires sessiond changes.

## Architecture

### Protocol: one additive message pair

`internal/sessiond/protocol.go` is a **frozen, additive-only** contract — the
existing `Message` envelope and every existing `Type*` constant keep their
current meaning and wire shape. This design adds exactly two new type
constants and no changes to existing ones:

| Constant                   | Value                      | Direction        |
|----------------------------|----------------------------|------------------|
| `TypeScrollbackPage`       | `"scrollback-page"`        | client → daemon  |
| `TypeScrollbackPageResult` | `"scrollback-page-result"` | daemon → client  |

**Request fields** (carried on the existing `Message` envelope, all
`omitempty`):

- `PaneID` — the pane to read.
- `Cursor *uint64` — absolute line-sequence number to page from. Omitted/nil
  means "start just before the current live viewport," i.e. the most recent
  page of history.
- `Limit int` — maximum lines to return. Default ~500 when omitted; hard-capped
  at ~5000 server-side so a single control frame can't balloon unbounded.

**Reply fields:**

- `PaneID` — echoed.
- `Lines []string` — ANSI-stripped rendered lines for this page, oldest-first
  within the page.
- `NextCursor *uint64` — cursor to pass on the next call to page further back.
  `nil` means no more history is retained in that direction.
- `StartLine uint64` — absolute sequence number of the first returned line, so
  a caller can tell where in the pane's lifetime this page sits (and detect
  clamping when its requested cursor fell off the retained window).

A distinct message pair is deliberately chosen over adding `Cursor`/`Limit` to
`screen-snapshot`. "Current screen" and "a page of history" have different
result shapes and different failure modes; overloading one message means every
existing consumer (MCP, browser) inherits new optional semantics on a message
they already depend on. A separate pair keeps `screen-snapshot`'s wire
behavior byte-for-byte identical to today.

### Storage: a bounded ring in `VTBuffer`

`VTBuffer` gains a bounded in-memory ring of finalized rendered lines,
~10,000 lines, matching the client-side xterm.js retention already in place so
CLI-visible history and browser-visible history agree.

The critical constraint on when lines are appended: **a line is appended to the
ring only when the VT engine scrolls it off the top of the live grid** — not on
every write, not on every keystroke. A line that is still on-screen is still
owned by the live grid and is served by `ScreenText()`; it enters the ring
exactly once, at the moment it leaves the viewport and becomes immutable. This
avoids double-counting lines across the viewport/history boundary and avoids
retaining mid-edit intermediate states of a line that is still being rewritten
(progress bars, TUI redraws).

This is **purely additive state**. `ScreenText()`, cursor tracking,
`serializeGrid()`, and the rest of the live-viewport rendering path are
untouched. The terminal-query-ownership invariants documented in `AGENTS.md`
(sessiond's `VTBuffer` is authoritative for `CSI 6n` and `OSC 11;?`) are
unaffected — this change adds an observer of scroll-off events, not a new
participant in the parse/reply path.

Each appended line carries an implicit absolute sequence number: a monotonic
counter of lines-ever-scrolled-off for that pane, which never resets and never
reuses a value even after the ring evicts the line it named.

### Cursor semantics

Directly mirrors `RawBuffer.ReplayFrom(since uint64) (data, start)`, generalized
from raw bytes to rendered lines:

- The caller supplies an absolute sequence number; the server returns the slice
  it can honor plus the absolute start of what it actually returned.
- A cursor older than the oldest retained line **clamps** to the oldest retained
  line rather than erroring — same behavior `RawBuffer` already has after
  trimming, and the returned `StartLine` tells the caller clamping happened.
- A cursor at or beyond the end of available history returns an empty page, not
  an error.

Nothing new is invented here; the one proven pagination model in the daemon is
reused with a different element type.

## Components

### `internal/sessiond`

- `protocol.go` — two new type constants; new optional fields on the `Message`
  envelope (`Cursor`, `Limit`, `Lines`, `NextCursor`, `StartLine`). Additive
  only.
- `vt.go` — `VTBuffer` gains the bounded line ring, the scroll-off append hook,
  the monotonic line-sequence counter, and a `ScrollbackPage(cursor *uint64,
  limit int) (lines []string, start uint64, next *uint64)` accessor guarded by
  the buffer's existing mutex.
- `server.go` — a handler for `TypeScrollbackPage` that resolves the pane,
  calls `ScrollbackPage`, and replies with `TypeScrollbackPageResult`; plus the
  new `"cli"` connection kind described below.
- `client.go` — a `ScrollbackPage(...)` method on `sessiond.Client`, mirroring
  the existing `ScreenSnapshot`/`GetLayout` request-reply methods, so the CLI
  (and any future consumer) uses the same typed client the MCP layer already
  uses.

### `cmd/muxterm`

New subcommands, each following the existing `flag.NewFlagSet`-per-subcommand
pattern in `cli.go`:

```
muxterm read-screen <pane-id> [--scrollback] [--cursor N] [--limit N] [--json]
muxterm session list
muxterm session attach <workspace-id>
muxterm pane create [--workspace ID] [--cmd ...]
muxterm pane close <pane-id>
muxterm pane resize <pane-id> --cols N --rows N
muxterm layout get [--workspace ID]
```

Each subcommand is one-shot: parse flags → resolve `sessiond.SocketPath()` →
dial via `sessiond.Dial()` (mirroring `runDoctor`'s fail-fast-if-not-running
check) → send exactly one request → print → exit. No long-lived state, no
persistent connection between invocations — matching the cron/script usage that
motivated issue #23.

Output is human-readable text by default, with `--json` for scriptability.

**`read-screen` without `--scrollback` is the existing `ScreenSnapshot` call,
unchanged.** Zero behavior change to what MCP and the browser rely on today;
`--scrollback` is what routes to the new `TypeScrollbackPage` message.

### The `"cli"` connection kind

`server.go` today distinguishes `"interactive"` (browser/human) from `"agent"`
(MCP/automation) via `Message.ClientKind`, and that distinction is load-bearing
for focus authority — the multi-client resize/focus-authority design
deliberately excludes programmatic clients from claiming PTY-size authority.

A one-shot CLI dial is a third thing, and gets a third kind, `"cli"`:

- **Excluded from focus-authority contention** — a script reading a pane must
  never steal PTY-size authority from the human looking at it. (The existing
  code paths already gate on `c.kind == "interactive"`, so `"cli"` inherits the
  correct exclusion by construction, but naming it explicitly keeps the intent
  legible rather than accidental.)
- **Excluded from `Attach`'s replay-on-connect behavior** — a one-shot
  `read-screen` should not trigger a flood of pane-data frames just to answer a
  single query.

## Data Flow

**One-shot invocation lifecycle**

```
parse args
  -> resolve sessiond.SocketPath()
  -> stat socket (fail fast with a clear message if absent)
  -> sessiond.Dial()
  -> send one request with a correlation ID, ClientKind="cli"
  -> await the matching reply, with a timeout (~5s)
  -> print (text or --json)
  -> close, exit 0
```

**Scrollback paging**

1. First call, no `--cursor`: returns the most recent page of history — the
   lines immediately preceding the current viewport — plus `NextCursor`
   pointing further back.
2. Caller passes `--cursor <NextCursor>` from the previous response to retrieve
   the next page further back.
3. Repeat until `NextCursor` is nil, meaning either the oldest retained line was
   reached or the ~10,000-line cap has evicted anything older.

Pages do not overlap: each page's `StartLine` plus its line count is the
boundary of the next page.

## Error Handling

- **Existing frozen error codes are reused, not extended.**
  `unknown-workspace`, `pane-spawn-failed`, and `pane-not-found` come back over
  the existing `TypeError` message and are surfaced by the CLI as a clear
  stderr message plus a non-zero exit code. No new error taxonomy.
- **Daemon not running.** The CLI stats the socket path before dialing and
  prints a clear, actionable message (`muxterm daemon not running — start it
  with "muxterm serve"`) instead of surfacing a raw connection-refused error or
  hanging on a dial. Same shape as `runDoctor`'s existing check.
- **Cursor past retained history.** Not an error. The reply carries
  `Lines: []` and `NextCursor: nil`. Running off the end of history is the
  normal termination condition for paging, not a failure — a paging loop
  terminates on `NextCursor == nil` and never has to distinguish "done" from
  "broke."
- **Cursor older than the retained window.** Clamps to the oldest retained line
  (not an error); `StartLine` in the reply reveals the clamp.
- **Pane exists but is not VT-backed** (e.g. a browser pane). Same handling as
  today's `screen-snapshot`: a well-formed near-empty result, not a hard error.
- **Reply timeout.** The one-shot request has a bounded wait (~5s); on expiry
  the CLI exits non-zero with a timeout message rather than blocking a cron job
  indefinitely.

## Verification Approach

Per this repo's `AGENTS.md`, **no unit tests.** Verification is real,
end-to-end, against a running binary. Static checks (`go build ./...`) are the
floor, not the evidence.

The verification vehicle is a **DTU (digital twin universe) environment**: build
a muxterm DTU profile via the generic `dtu-profile-builder` agent — muxterm is a
standalone Go application, not an Amplifier-ecosystem component, so the
Amplifier-specific tester profile does not apply — then launch an isolated
environment running the built binary plus sessiond, and execute the CLI inside
it against a real daemon and a real PTY.

Verification steps, each with recorded command and observed output:

1. **Fixture setup.** Create a brand-new workspace and pane in the DTU
   environment (fresh fixture per run, per `AGENTS.md` verification hygiene),
   and write content that scrolls well past the viewport — e.g. `seq 1 500`.
2. **No-regression on current-viewport read.** `muxterm read-screen <pane-id>`
   returns the current viewport, matching what `screen-snapshot` returns today.
   *Break it would catch:* any accidental coupling of the new ring into the
   live-grid rendering path.
3. **Scrollback actually returns history.** `muxterm read-screen <pane-id>
   --scrollback` returns real historical lines that are **no longer on screen**
   (e.g. lines from the low end of `seq 1 500`), together with a non-nil
   `NextCursor`. *Break it would catch:* the ring never being populated, or
   being populated with viewport content instead of scrolled-off content.
4. **Paging is continuous and non-overlapping.** Repeatedly calling with
   `--cursor <NextCursor>` walks further back, with each page's `StartLine`
   contiguous with the previous page and no duplicated lines, terminating with
   `NextCursor: nil`. *Break it would catch:* off-by-one cursor math, page
   overlap, or a paging loop that never terminates.
5. **Daemon-not-running path.** Stop sessiond, run the CLI, confirm the clear
   daemon-not-running message and non-zero exit — not a hang, not a raw
   connection-refused stack. *Break it would catch:* a cron job that blocks
   forever when the daemon is down.
6. **No MCP regression.** Exercise the existing MCP `screen-snapshot` path
   against the same build and confirm unchanged behavior. *Break it would
   catch:* the additive protocol change disturbing the one existing consumer.

Browser-side behavior is unchanged by this design (no web/ changes), so the
`/muxterm-verify` browser pass is not the primary gate here; the DTU run
against the real daemon is. If any browser-visible terminal behavior does shift
during implementation, that is a signal the change stopped being additive and
must be re-examined against the `AGENTS.md` terminal-query invariants.

## Open Questions

None blocking. Scope (issues #23 + #22 combined), approach (A), protocol shape,
storage model, cursor semantics, error handling, and the verification strategy
were all specified during design.

## Process Note

This design was validated through extensive assistant-side technical analysis —
protocol exploration of `internal/sessiond/protocol.go`, and a codebase survey
of `internal/sessiond`, `internal/mcp`, and `cmd/muxterm` — rather than through
iterative human back-and-forth section-by-section approval. The interactive
channel in the session that produced it was not returning substantive responses
to specific design questions, so the normal design-approval gate could not be
satisfied as designed.

This is flagged openly rather than left implicit: the technical claims here are
grounded in the actual source (each one traceable to a named file), but the
human judgment calls — particularly the ~10,000-line retention cap, the ~500 /
~5000 limit defaults, and the decision to combine #22 into #23's scope rather
than ship the CLI first and scrollback later — carry assistant judgment where a
human decision would normally sit. Those three are the places to push back
first if this design turns out to be wrong.
