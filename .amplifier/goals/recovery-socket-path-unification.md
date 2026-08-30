# Goal: unify recovery socket path derivation

## Outcome
Produce a committed, pushed `gb/crash-recovery/recovery-socket-path-unification` correction that restores the merged build by making the owner-local client consume the single canonical explicit recovery-socket path function.

Complete when **either** U1-U4 all reach `PASS`, **or** an item is conclusively `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN` with the exact reason. No load-bearing residual may be called COMPLETE.

## U1 — Exact one-file scope
Own only `internal/sessiond/recovery_socket_client.go`. Do not modify the canonical `RecoverySocketPath(sessionSocket string) (string,error)` in `recovery_paths.go`, tests, contracts, runtime, service, relay, frontend, docs, dependencies, goals, or other worktrees. Add no test file/case.

## U2 — One canonical API
Delete the duplicate zero-argument `RecoverySocketPath`. Keep `DialRecoverySocket()` zero-configuration, but have it call `SocketPath()` and then the canonical `RecoverySocketPath(sessionSocket)`. Preserve redacted path-resolution errors, dedicated sibling `recovery.sock` only, finite client bounds, and no fallback to the main `sessiond.sock`. Retain imports only when used.

## U3 — Falsifiable verification
Create a removable non-test real Unix-socket probe under `/tmp/crash-recovery-r2/recovery-socket-path-unification/` with exact source, commands, stdout/stderr/status, hashes, source-to-claim map, and validator. It must prove:
- a listener only at sibling `recovery.sock` is reached by `DialRecoverySocket()`;
- a listener only at `sessiond.sock` is never reached and the client returns unavailable;
- overlong/default-invalid socket paths reject before dialing;
- the merged package contains exactly one `RecoverySocketPath` definition and the client calls it with the resolved main path.

Run gofmt, `git diff --check`, `make build`, `go build ./...`, Linux/Darwin/FreeBSD sessiond builds, web `check:fast`, focused direct probe, and exact established Go/web baseline comparisons.

## U4 — Bank and terminate
Commit only `internal/sessiond/recovery_socket_client.go` with required Amplifier footer, push explicit `HEAD:refs/heads/gb/crash-recovery/recovery-socket-path-unification`, verify clean local/remote parity, then write ignored root `DONE.json` as literal final filesystem action containing lane, this session ID, verdict, branch/head/pushed, U1-U4, residuals, pending_human, suite, and evidence path. Time bound: 25 minutes / 18 turns. Never merge.

## Scope-outs
No recovery runtime/listener implementation, CLI routing, vendor integrations, browser UI, service behavior, test additions, DTU, PR, merge, or dev-local interaction.

## KNOWN
The base is the integration seed descended from `40bac11b6dadf452167976e877565372eb3fc0fb`. The current deterministic build failure is a duplicate package-level `RecoverySocketPath` plus a wrong-arity client call. The identity-foundation implementation is the canonical explicit-path owner.
