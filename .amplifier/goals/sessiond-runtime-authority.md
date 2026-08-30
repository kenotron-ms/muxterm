# Goal: implement daemon-owned crash recovery authority

## Outcome
Produce a committed, pushed `gb/crash-recovery/sessiond-runtime-authority` implementation that makes production sessiond durably reconstruct workspace and pane structure, restore shells and bounded inert history, securely capture exact supported-tool sessions, and execute at most one automatic recovery attempt per generation.

Complete when **either** every A1-A9 item reaches a terminal state, **or** the remainder is conclusively impossible with a named blocker for each. Record `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`; negative terminals are residuals and no load-bearing residual may be called COMPLETE.

## A1 — Exact ownership and frozen seams
Own only these existing production files:
- `cmd/muxterm/sessiond_main.go`
- `internal/sessiond/server.go`
- `internal/sessiond/registry.go`
- `internal/sessiond/workspace.go`
- `internal/sessiond/pane.go`
- `internal/sessiond/close.go`
- `internal/sessiond/activity.go`
- `internal/sessiond/shell_integration.go`
- `internal/sessiond/vt.go`
- `internal/sessiond/layout.go`
- `internal/sessiond/spawn.go`
- `internal/sessiond/peercred_linux.go`
- `internal/sessiond/peercred_other.go`

May add only:
- `internal/sessiond/peercred_darwin.go`
- `internal/sessiond/recovery_runtime.go`
- `internal/sessiond/recovery_runtime_mutation.go`
- `internal/sessiond/recovery_runtime_reconstruct.go`
- `internal/sessiond/recovery_runtime_launch.go`
- `internal/sessiond/recovery_runtime_history.go`
- `internal/sessiond/recovery_runtime_leases.go`
- `internal/sessiond/recovery_runtime_replacement.go`
- `internal/sessiond/recovery_socket.go`
- `internal/sessiond/recovery_process_linux.go`
- `internal/sessiond/recovery_process_darwin.go`
- `internal/sessiond/recovery_process_other.go`
- `internal/sessiond/recovery_strategy_unavailable.go`
- `internal/sessiond/recovery_paths.go`
- `internal/sessiond/recovery_layout_codec.go`

May synchronize fixtures/expectations, never add test cases/files, only in existing `cmd/muxterm/sessiond_main_test.go` and existing `internal/sessiond/{server_test.go,server_integration_test.go,server_relay_test.go,registry_test.go,workspace_test.go,pane_test.go,pane_osc133_test.go,vt_test.go,layout_test.go,spawn_test.go,broadcast_test.go}`.

All merged recovery contract/store/strategy/client/protocol files, `internal/server/**`, `internal/service/**`, frontend, docs, dependencies, and AGENTS.md are read-only. A required cross-boundary edit is a named R3 residual.

## A2 — Leadership and private cold start
Keep `NewServer(socketPath)` as transient compatibility. Add a production recovery constructor used by `runSessiond` that resolves an owner-only durable root from `$XDG_STATE_HOME/muxterm/recovery` or `~/.local/state/muxterm/recovery`, opens the recovery store, acquires its exclusive writer lock, loads and validates durable state, constructs all structure and shell processes privately, and only then removes stale owned sockets, binds the main socket plus sibling `recovery.sock`, and accepts clients. The store lock is the single leadership lock. A competing daemon cannot unlink either live socket, mutate state, or accept requests. Unsafe/corrupt existing state fails startup rather than inventing an empty workspace. Socket directories are `0700`, sockets `0600`, and shutdown closes listeners/store cleanly.

## A3 — Durable-before-visible mutation authority
One runtime serializer owns store generation and every authoritative mutation from browser, CLI, MCP, process exit, auto-reap, and close tickets. For workspace create/rename/delete/default recreation; terminal/browser pane create/rename/resize/delete; layout; active pane; validated CWD; capture; claim; attempt; and outcome, require:
`validate/stage -> store Commit/fsync -> deterministic registry apply -> authoritative broadcast -> success reply`.
A commit failure leaves memory, PTYs, broadcasts, and ACK unchanged. A post-commit memory-apply failure terminates sessiond so cold recovery uses durable truth. Start unpublished shells before a pane-create commit; close them if commit fails. Refactor close assessment to plan first, commit deletion, detach, then close PTYs outside locks. Preserve workspace-qualified pane identity and existing authoritative close semantics.

## A4 — Exact reconstruction and layout/CWD
Rebuild registry directly from the validated snapshot, preserving exact workspace IDs, workspace-local pane IDs, names, titles, surface kind, dimensions, validated CWD, closed-layout representation, active pane, captures, claims, attempts, outcomes, and safe history. Advance allocators beyond live restored identities and use fresh volatile generations. Duplicate/dangling state fails closed. Terminal panes always start as fresh default shells; browser panes become inert placeholders with no persisted URL. Unknown/custom commands are never replayed. If saved CWD is missing/unsafe, start a shell in safe home, report `working-directory-invalid`, and never resume a tool there. Implement a strict bounded codec between supported Dockview layout JSON and the closed durable layout; invalid layout is rejected before ACK and cannot persist arbitrary metadata.

Extend authenticated shell lifecycle evidence with a bounded private CWD marker tied to the current root generation. Strip it before VT/browser delivery, validate and durably commit CWD before publishing the associated prompt. OSC 7, title, terminal text, and input timing are never CWD authority.

## A5 — Inert arrival-driven history
Extend VTBuffer with a monotonic drain of newly finalized scrolled-off plain lines and direct safe recovered-history projection; never persist or replay raw PTY/grid bytes. Coalesce flushes after observed output at 64 lines, 64 KiB, or a trailing 250 ms, plus structural/lifecycle/replacement/shutdown boundaries—no polling. Store I/O runs off the PTY reader and outside VT/registry locks. On attach order `composition -> bounded recovered-history events -> live shell/tool replay -> mark live`. Split events to 4096 bytes/256 lines, carry truncation/boundary truth, and never feed recovered text to VT parsing, pane input, activity classification, or shell integration.

## A6 — Secure dedicated lifecycle authority
`recovery.sock` accepts only `DecodeRecoverySocketRequest`. Linux uses kernel `SO_PEERCRED` UID+PID; Darwin uses kernel peer UID+PID; unsupported platforms do not enable privileged recovery. Never fall back to directory permissions. For bootstrap, derive exactly one current workspace-qualified pane from bounded process ancestry, foreground process group/session, peer start identity, current root generation, requested fixed strategy, and verified product ancestor. Issue bounded cryptographically random leases tied to connection/pane/generation/strategy/integration/epoch; cap live/tombstone maps and rates. Capture consumes a known lease before validating evidence, then uses the fixed adapter and durably commits exact capture before returning accepted. Replay, expiry, disconnect, wrong UID/PID/CWD/strategy/pane/generation, sibling/background process, ambiguous ancestry, or map pressure fails closed without changing prior authority. Explicit bind is same-UID owner-local, derives all fence/epoch/time authority daemon-side, validates the exact adapter/CWD/session, and never echoes secrets.

## A7 — Shell-first structured recovery state machine
Construct a fixed four-strategy roster from explicit clean absolute executable resolution; an unavailable CLI becomes a fixed unavailable strategy without blocking structural restore. For a valid durable capture: shell-first restore; privately rebind the capture to the current root generation while preserving its evidence source; durably commit claim and attempt before launch; replace the pane root PTY directly with the adapter's structured executable/argv/CWD and allowlisted environment—never shell text or simulated terminal input; advance root generation; ignore stale generation exits. Revalidate executable ownership/type/path/CWD immediately before exec. On spawn or exact-identity validation failure, replace with a fresh shell and persist pane-local failure.

Automatic attempt cardinality is one per recovery generation. A crash after claim/attempt commit, exec, or before outcome never automatically launches again. Explicit retry creates separately authorized state. `recovered` requires exact session ID and CWD evidence: lifecycle callback for Claude/Codex, user-backed managed evidence for OpenCode (otherwise provisional), and strict expected-UUID store correlation for Amplifier. When recovered tool exits and authenticated shell returns, clear stale capture/state durably. One pane failure never blocks others.

## A8 — Browser and replacement authority
Implement sessiond handlers for protocol hello, retry, opaque candidate selection, and workspace-qualified active-pane persistence using frozen request/result contracts. Browser input never supplies session ID, CWD, executable, strategy ID, fence, generation, capture, candidate list, or result/event. Composition and transitions contain only validated redacted projections.

Implement owner-local replacement plan/commit on the dedicated socket. Daemon derives a complete current census and short-lived plan; any mutation invalidates it. Ready only when every pane is exact-session recoverable or explicitly accepted shell-only under that exact plan. Deferred/error leaves the incumbent daemon/socket/PTYs alive. Commit durably flushes structure/history/outcome before releasing leadership; no browser-authored census or plan authority.

## A9 — Real falsifiable verification and bank
Use removable non-test executables and real isolated daemon processes under unique runtime/state roots, never the user's port 8313 or dev-local. Retain exact source/commands/stdout/stderr/status/hashes under `/tmp/crash-recovery-r2/sessiond-runtime-authority/`. Prove at minimum:
1. two daemon candidates: exactly one owns store/sockets; loser cannot unlink or serve;
2. acknowledged mutations across the closed list survive immediate SIGKILL exactly once; induced store failure emits no ACK/broadcast/memory mutation;
3. multiple workspaces sharing pane ID 1 reconstruct exact structure, CWD/layout/active pane/history and no browser URL/custom command;
4. hostile history is literal/inert and bounded;
5. wrong UID where feasible, unrelated/sibling/background/stale/replayed/expired/mismatched lifecycle attempts all reject with no durable change;
6. valid fake fixed strategies execute exact structured argv/CWD once; crashes at claim/launch/validation boundaries never duplicate automatically;
7. ineligible replacement defers without changing incumbent PID/socket/PTY; eligible plan consumes once;
8. production start, graceful stop, crash restart, and corrupt-store refusal.

Run gofmt, `make build`, Go and Linux builds, web check:fast, diff-check, focused existing suites, and full baseline comparison. No new tests. Commit only owned files with Amplifier footer, push explicit branch, verify clean parity, then write session-bound ignored DONE.json last with item states/evidence. Time bound 120 minutes / 80 turns.

## Scope-outs
No helper/config installer, browser relay/origin/UI, service unit/installer, DTU edits, docs, dependencies, new tests, PR, merge, or dev-local interaction. Real four-vendor conversations and merged browser/service behavior remain mandatory R3/DTU residuals.

## KNOWN
Base is the R2 seed descending from corrected integration `5562e6bf6ac04eb602bfa4356a4348e3b583e16f`. Frozen contracts include replacement-plan/commit in the dedicated owner-local request decoder. Current Go baseline has four known failures; web baseline is 35 failed/137 passed until lane C fixes 16 stale hello expectations.
