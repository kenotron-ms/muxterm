# Lane D — Make session state harness-agnostic

## Outcome

muxterm's home view stops being an Amplifier feature and becomes a **fleet view
for any coding-agent CLI**. Claude Code sessions appear beside Amplifier ones,
correctly classified, and any other job-runner can join with one command.

The three lanes that came before built the pipeline. Everything below the
producer is already harness-neutral — the spool, the pane join, the store, the
protocol, the view. **This lane's job is to stop the Amplifier-shaped
assumptions from leaking through, and to add two more producers.**

## ⛔ HARD SAFETY CONSTRAINT — read before running anything

A human is **using a live muxterm right now**: `muxterm serve --addr
127.0.0.1:9090` (PID 243169) on the **default** sessiond socket, behind Caddy at
https://muxterm.ampbox.io. Also running: `python3 -m http.server 8477` (mockups),
`python3 -m http.server 8478` (the home-view demo, tunnel `pejz5`), a
`muxterm-dev serve :8313`, and the user's sessiond PID 383383.

- **NEVER** `pkill`, `killall`, or any broad process kill. Kill only by a PID
  **your own lane recorded**.
- **NEVER** touch ports 9090, 8477, 8478, 8313, or the default sessiond socket.
- **DO NOT run `make dev-local`** — fixed port, shared runtime dir.
- If you start an isolated daemon to test, override **all three** XDG vars
  (`XDG_RUNTIME_DIR`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`) under `/tmp/hvd-*`.
  Lane A learned the hard way that `snapshotDir()` reads `XDG_DATA_HOME` and an
  unisolated daemon will clobber the user's live `restore-snapshot.json` every
  30s. **Verify isolation from `/proc/<pid>/environ`, not from your own export.**

## Working agreement

- Working directory: `/home/ken/workspace/muxterm-hv-worktrees/hv-d-harness`
- Branch: `goal/hv-d-harness-agnostic`
- Base: the `hv-integration` branch — lanes A, B and C already merged, `go build
  ./...` clean, `npm run check:fast` 8 warnings / 0 errors. **That is your
  baseline; do not regress it.**
- **Never merge to main.** Push your branch.
- **Commit early, push always.**

## What is already harness-neutral (do not rewrite these)

Read them first so you do not solve a solved problem:

- `internal/sessiond/sessionstore.go` — reads a spool directory of JSON files.
  It has no idea what wrote them.
- `internal/sessiond/procparent_linux.go` — joins a snapshot to a pane by
  walking `/proc` ancestry. Works for any process tree.
- The three protocol messages and the browser store — they carry a list of
  records, nothing more.
- **`internal/sessiond/agent_catalog.go` already knows four harnesses**:
  `amplifier`, `claude`, `codex`, `opencode`, matched by argv basename with
  Node-shim handling. Its own comment anticipates exactly this moment: *"a
  future user-extensible list could be added later without an API change."*
  **Reuse those name strings as the harness identifiers.** Do not invent a
  second vocabulary.

## What leaks Amplifier and must be fixed

### 1. `SessionState` has no `harness` field

Add one. Values are the `agent_catalog.go` names; unknown producers may send any
string and the UI must degrade to a neutral badge rather than dropping the row.
Update **both** halves of the contract in the same commit —
`internal/sessiond/sessionstate.go` and `web/src/lib/session-state.ts` — plus
`FIXTURE_SESSIONS` so the demo shows a mixed fleet.

### 2. `mode: goal | plain` is Amplifier vocabulary

Rename to **`autonomous | interactive`**. The semantic is unchanged and it is
the single most important rule in the system:

> **Does going quiet mean "broke" or "resting"?**
> `autonomous` — quiet means the loop broke. **That is the alarm.**
> `interactive` — quiet means it is waiting for a human, which is its contract.
> **Never an alarm.**

`goal|plain` only names that correctly if you already know what `/goal` is.
Claude Code has background and foreground sessions; a job CLI has batch runs. The
distinction is universal, the Amplifier spelling is not.

This is a contract rename touching Go, TypeScript, the hook, and the demo
fixtures. Do it in **one commit** so nothing is ever half-renamed.

### 3. The snapshot file is an undocumented implementation detail

It is now a **public integration contract** — third parties will write it. Give
it a version field and document it properly:

- Add `v` (schema version, start at 1) to every snapshot the hook writes, and
  have the store ignore, with a logged reason, anything whose `v` it does not
  understand. Forward compatibility is the entire point of shipping a version.
- Write `docs/session-state-protocol.md`: the exact JSON shape, every field,
  which are required, the enums, the atomic-write requirement (`.tmp` +
  `os.replace`), the spool location and `MUXTERM_SESSION_STATE_DIR` override,
  the idempotency guarantee, and a **complete worked example** for a
  non-Amplifier producer.
- State plainly that a producer may write snapshots at any cadence and that a
  missed write is self-healing.

## What to add

### 4. `muxterm session report` — the universal producer

The escape hatch that makes "any job CLI" true. One command, no library, no
language binding:

```
muxterm session report --session-id <id> --state working \
    [--harness NAME] [--mode autonomous|interactive] \
    [--waiting-for REASON] [--doing TEXT] [--done-means TEXT] \
    [--name TEXT] [--knows PATH]... [--pr N] [--project DIR] [--json]
```

It writes one snapshot to the spool and exits. That is all. A shell script, a
Makefile, a CI job, or a Rust binary can now appear in the home view.

Live in a **new file** `cmd/muxterm/session_report_cmd.go`. `session_cmd.go`
already exists (it has `list`/`attach`) — extend its dispatch, and add the verb
to `printUsage` in `cli.go`.

Validate the enums and **fail loudly on a bad value**; a producer that silently
writes garbage is worse than one that errors.

### 5. A Claude Code adapter

**Verified on this host** — `claude` is installed, version 2.1.233:

```
claude agents --json          # "Print active sessions (interactive and
                              #  background) as a JSON array and exit
                              #  (for scripting; does not require a TTY)"
claude agents --json --all    # also include completed background sessions
claude agents --cwd <path>    # filter by directory
```

Right now it returns `[]` because nothing is running — **so discover the real
field names yourself rather than trusting any list in this document.** Start a
throwaway background Claude session in your worktree, run the command, and read
the actual keys. Paste the real JSON into DONE.json.

Reported shape (**unverified, treat as a hint only**): `{cwd, kind, startedAt,
id, state, pid, status, waitingFor, sessionId, name}` with
`state ∈ working|blocked|done|failed|stopped`.

If that holds, **the mapping is close to a field rename** — muxterm adopted
Claude Code's enum deliberately, which is why. Do not build a translation layer
for a problem that turns out not to exist.

Ship it as a **poller**, since Claude Code has no equivalent of Amplifier's
in-process hook. Where it lives is your call — argue for it in DONE.json. A
sensible option is a small Go loop inside the daemon behind a config flag,
reusing the same spool so the store stays ignorant of producers. **Whatever you
choose, the daemon must not shell out to `claude` unless the operator opted in**,
and a missing or failing `claude` binary must degrade silently, never break the
daemon.

### 6. Show the harness in the UI

A small badge per row — enough to tell an Amplifier session from a Claude Code
one at a glance. Follow `.scratch/cos-pitch/v9/index.html` for weight and
restraint: this is metadata, not a headline. Unknown harness gets a neutral
badge. Include a mixed fleet in the demo fixtures so it is visible without a
backend.

## Also fix while you are here

Lane B flagged this as **must-read-before-merge** and it is a real latent bug:

> `TypeSessionState` carries `Sessions []SessionState` with `omitempty`, kept
> deliberately because `Message` is one flat envelope shared by every message
> type. The consequence is that the most important transition — **N sessions to
> zero** — arrives as a bare `{"type":"session-state"}` with no field at all.

The browser **must** treat message *arrival* as the signal and a missing field
as the empty set. If it does not, the Start card badge sticks forever at its
last non-zero value. Check `web/src/lib/home-sessions.ts`, fix it if wrong, and
say either way in DONE.json.

## Verification

⛔ **AGENTS.md bans unit tests. Do not add `*_test.go` or `*.test.ts`.** If an
existing test breaks, fix it to match. `playwright-cli` is not installed.

1. `go build ./...` clean and `npm run check:fast` **0 errors** — the baseline is
   8 warnings / 0 errors, do not regress it.
2. **Exercise `muxterm session report` for real.** Build the binary, write a
   snapshot with it, `cat` the file. Paste real output into DONE.json.
3. **Exercise the Claude adapter against a real `claude agents --json`** with at
   least one session alive. Real JSON in, mapped snapshot out, both pasted.
4. `npx vite build --config vite.demo.config.ts` succeeds and the demo shows a
   mixed-harness fleet.
5. Confirm nothing in `internal/sessiond/sessionstore.go`, the protocol, or
   `home-sessions.ts` names a specific harness. Grep and paste the result.

## Time bound

Enforced by the launcher. Exceeding it is a terminal `BUDGET` state — commit
what is real, do not rush or overclaim.

## Resources

Any throwaway Claude session, isolated daemon, spool directory or scratch file
goes in `resources[]` with its disposition. **No background servers.** A lane
that exits with resources running has not finished.

## Definition of done

Complete when **either** every item reaches a terminal state, **or** it is
conclusively demonstrated the remainder cannot, naming the blocker for each.
Items ending FAIL or BLOCKED are residuals, not failures of the goal.

Terminal states: `PASS` / `FAIL-<named>` / `BLOCKED-<named>` / `PENDING-HUMAN`.

1. `harness` field on both halves of the contract; unknown values degrade
2. `mode` renamed to `autonomous|interactive` everywhere, in one commit
3. Snapshot schema versioned with `v`; unknown versions ignored with a reason
4. `docs/session-state-protocol.md` written, with a non-Amplifier worked example
5. `muxterm session report` implemented, enums validated, fails loudly
6. Claude Code adapter, opt-in, degrading silently when `claude` is absent
7. Real `claude agents --json` output captured and mapped
8. Harness badge in the UI; mixed fleet in the demo fixtures
9. The `omitempty` empty-set handling checked and correct
10. No harness named in the store, the protocol, or the browser session store
11. `go build ./...` clean; `check:fast` 0 errors; demo builds
12. Committed AND pushed to `origin goal/hv-d-harness-agnostic`

**Priority if time runs short:** 1, 2, 3, 4, 5, 9 first — the contract and the
universal producer are what make every future harness cheap. The Claude adapter
(6, 7) proves it works but can follow.

## Final act

Write `DONE.json` in the worktree root — gitignored, do not commit. Fields:
`lane, session_id, verdict, branch, head, pushed, items[], residuals[],
pending_human[], resources[], notes, suite`.

`verdict` is exactly one of `COMPLETE`, `BLOCKED`, `PARTIAL`. `session_id` must
be your own.
