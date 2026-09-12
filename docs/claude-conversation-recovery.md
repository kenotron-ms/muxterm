# Claude Code conversation recovery

## Shipped behavior

Claude Code conversation recovery is **disabled unconditionally in this build**.
No environment variable, configuration, or latent feature gate can enable it.

When a sessiond snapshot identifies a pane as Claude Code—either its recorded
agent is `claude` or its captured argv is recognizably Claude—muxterm restores
the pane's historical screen as inert text, opens a fresh shell, and prints a
divider stating that it did **not** replay the original request. It does not
run captured Claude argv. This classification wins even if old snapshot fields
contradict one another, so an accidental `SessionID` cannot route the pane
through Amplifier resume logic.

An empty, missing, or no-longer-directory captured CWD follows the normal shell
fallback to `$HOME`, so a Claude pane is not discarded merely because its old
location is unavailable. If that shell also cannot start, restoration fails
explicitly in the daemon log; it never launches a new Claude conversation.

This restores a pane and visible history only. It does not claim that an
interrupted action, autonomous loop, or original process continued.

## Why exact Claude resume remains blocked

Claude Code 2.1.269 documents `claude --resume <session-id>` and its
`claude agents --json` inventory can report an interactive PID plus a native
session UUID. Muxterm's fleet adapter prefixes that UUID as `claude-<uuid>` for
its own spool ownership; that synthetic fleet ID is never a native resume ID.

The installed CLI's closed-stdin `--version`, `--help`, and `agents --help`
were inspected. The supported `SessionStart` command-hook metadata includes
`session_id`, `transcript_path`, and `source`. It supplies a persistence locator,
not a durability acknowledgment or process generation. In the isolated fixture
authentication did not complete, so that metadata was not emitted and no actual
conversation persistence location was confirmed. No transcript contents or
vendor-internal session files were searched.

References: [CLI](https://code.claude.com/docs/en/cli-reference),
[session resume/storage](https://code.claude.com/docs/en/sessions),
[agent inventory](https://code.claude.com/docs/en/agent-view),
[SessionStart hooks](https://code.claude.com/docs/en/hooks#sessionstart).

The supported inventory alone does **not** establish that a UUID has durable,
resumable conversation state, identify its persistence locator, or prove that
an old process generation is gone. The bounded native fixture stopped at
authentication, so it could not verify restoration of an original
conversation. Muxterm therefore does not query inventory during snapshot
capture and does not persist or claim a resumable Claude identity.

Before enabling any future path, it must use only the bare native UUID from a
supported PID-bound inventory record; capture the pane's foreground/root
generation before and after the bounded query; reject stale, unreadable,
ambiguous, or duplicate native IDs; and conclusively establish the source
generation's death using boot/process-start identity rather than PID absence.
The resume command must be explicit positional argv (`claude`, `--resume`,
`<native-uuid>`), never shell source or captured request text. CWD may only
corroborate a PID-bound result, never select a session.

## Fleet reporting is separate

Fleet reporting remains the independently opt-in Claude adapter controlled by
`MUXTERM_CLAUDE_ADAPTER`. It may report active Claude sessions; it neither
enables conversation recovery nor proves session durability or work
continuation. Reporting disabled and conversation recovery disabled are
separate states.

## Verification and compatibility

The safe-shell change was exercised with a real browser, muxterm server, and
sessiond inside a disposable DTU. No production instance was restarted.

| Scenario | Verdict | Limit |
|---|---|---|
| Actual pre-auth Claude process, daemon crash, fresh shell and retained screen | PASS | Not authenticated conversation recall |
| Original-action ledger remains at one after crash | PASS | Harmless synthetic Claude-named executable |
| Same names/CWDs and workspace-local pane numbers | PASS | Synthetic restore snapshots |
| Legacy/contradictory metadata, cosmetic argv, stale CWD | PASS | Safe-shell error branches only |
| Entire corrupt snapshot | PASS | Existing fail-closed behavior; no scrollback recovery from corrupt data |
| Adapter off/on, browser reconnect | PASS | Empty inventory only; no spurious cards |
| Amplifier banner/dead-session fallback; Codex/OpenCode argv | PASS | Synthetic routing, including a prompt argument literally `claude` |
| Native Claude persistence, UUID resume, recall and fresh reporting | BLOCKED | Fixture required OAuth authorization |
| Native Amplifier conversation regression | BLOCKED | Provider configuration required interactive credential entry |

`go build ./...`, `go vet ./...`, `npm run build`, and `npm run check:fast`
passed (lint reported existing warnings, zero errors). No unit tests were added.
Raw fixture scripts, ledgers, screenshots and process metadata are retained in the
implementation worktree's local `artifacts/recovery/`; they are not public assets
or general-purpose host test runners.

The snapshot format and fleet protocol are unchanged. Old Claude snapshots now
open shells rather than relaunching their captured request. Amplifier's existing
proc-title/banner resume and fallback implementation is otherwise unchanged;
its existing event-file check is not newly validated as full-context recovery.

This patch is a no-replay safety fix, **not delivery of native Claude recovery**.
Any production installation or daemon restart needs separately authorized rollout.
Enabling the reporting adapter alone cannot enable conversation recovery.