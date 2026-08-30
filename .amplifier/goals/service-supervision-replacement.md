# Goal: make daemon supervision and upgrades recovery-safe

## Outcome
Produce a committed, pushed `gb/crash-recovery/service-supervision-replacement` implementation that supervises sessiond independently on Linux and macOS and never kills or replaces live unrecoverable panes without a daemon-committed replacement decision.

Complete when **either** every D1-D6 item is terminal, **or** the remainder is conclusively impossible with a named blocker per item. Use `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`; no unsafe replacement residual may be called COMPLETE.

## D1 — Exact ownership
Own only:
- `internal/service/commander.go`
- `internal/service/service.go`
- `internal/service/install.go`
- `internal/service/uninstall.go`
- existing `internal/service/{service_test.go,install_test.go,uninstall_test.go}` for fixture/expectation synchronization only
- `install.sh`

May add only `internal/service/replacement.go`, `internal/service/replacement_client.go`, `internal/service/supervision.go`, and `internal/service/upgrade.go`. All cmd/muxterm files, sessiond/runtime/contracts, internal/server, frontend, docs, dependencies, and other tests are read-only. Add no test file/case. Invoke the future recovery CLI as an external structured command; if absent/unavailable, defer safely rather than importing sibling code.

## D2 — Independent supervision
Linux sessiond unit uses explicit restart-on-crash semantics suitable for controlled replacement, bounded restart delay, owner runtime/state paths, and starts before web. Install writes/syncs definitions, daemon-reloads, enables/starts sessiond, waits for real protocol readiness, then starts web. Explicit stop remains stoppable.

macOS installs a separate `com.muxterm.sessiond` launchd agent with `RunAtLoad`, `KeepAlive`, structured ProgramArguments, owner-only logs/state, while retaining the separate web agent. Install loads/waits for sessiond before web. Uninstall unloads web first then sessiond and removes only owned plists. Do not touch the user's currently running dev-local process.

## D3 — No blind force stop
Remove install/upgrade behavior that directly stops, kills, unloads, unlinks, or restarts sessiond before a committed recovery decision. `--force` updates binaries/definitions but requests `muxterm recovery replacement plan --json`; exit 10 deferred, 11 unavailable/legacy, timeout, malformed, or operational failure leaves incumbent PID/socket/PTYs untouched and reports truthfully. Never silently swallow restart errors or claim success from socket closure.

## D4 — Controlled replacement invocation
For a ready daemon plan, pass only its opaque plan ID to `muxterm recovery replacement commit --plan <id> --json`, then ask the supervisor to replace/restart and require a newly responsive protocol-compatible daemon before success. Never build a pane census, judge recoverability, fabricate/parse session identities, auto-accept shell-only, or signal after defer. Interruptions after plan, after commit, and during supervisor restart cannot yield two writers, delete a live socket, or report false success. Legacy daemon remains authoritative until natural stop or explicit supported replacement.

Update `install.sh` to parse stable version output, install binary atomically, update definitions, restart web as appropriate, invoke replacement policy, and report committed/deferred/legacy-deferred/failed distinctly. Never reduce this to `systemctl --user restart muxterm`.

## D5 — Falsifiable service evidence
Use temporary service roots and removable fake commanders/processes only; do not install/uninstall real user services. Retain exact sources/commands/outputs/status/hashes under `/tmp/crash-recovery-r2/service-supervision-replacement/`. Prove Linux units parse and supervise one restart; macOS plists parse with distinct labels/order; install/uninstall symmetry; no direct sessiond stop/unload on force/upgrade; external CLI absent/deferred/legacy/error preserves exact fake incumbent PID/socket/PTY sentinel; ready+commit triggers one restart and waits for distinct compatible identity; timeouts/interruption never double-start or false-success; install.sh shell syntax and all outcome messages.

## D6 — Verify and bank
Run gofmt, shell syntax checks, `make build`, Go/Linux builds, web check:fast, diff-check, focused existing service tests, and exact Go/web baseline comparisons. Existing tests may be synchronized, not weakened; add none. Commit only owned files with footer, push exact branch, clean parity, then write matching ignored DONE.json last with D1-D6/evidence/residuals. Time bound 75 minutes / 50 turns.

## Scope-outs
No central CLI dispatch/helper implementation, sessiond authority/socket/launch, browser relay/UI/origin, real service mutation, DTU, docs, dependencies, new tests, merge, PR, or dev-local interaction. Real A/B interoperability, host reboot/login, and legacy binary upgrade remain R3/DTU residuals.

## KNOWN
Service policy treats recovery CLI exit 0 as committed/current, 10 as deferred, 11 as unavailable/legacy, and 1 as operational failure. Every uncertain result preserves the incumbent daemon. The recovery store lock is the sole sessiond leadership authority.
