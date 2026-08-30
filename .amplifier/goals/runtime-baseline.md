# Goal: make the sessiond test fixture wait for readiness

## Outcome
Produce a committed, pushed test-fixture correction on `gb/crash-recovery/runtime-baseline` so existing sessiond cold-start and relay tests cannot observe the socket before the default workspace is ready.

Complete when **either** B1-B4 reach `PASS`, **or** an item is conclusively `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN` with the exact reason.

## B1 — Exact scope
Own only existing `internal/sessiond/server_test.go`. Add no tests and change no production source. Preserve fresh `t.TempDir` fixtures and the existing five-second startup deadline.

## B2 — Protocol readiness
Replace socket-file existence as the final readiness condition in `startTestServer`. Once connectable, open a short-lived real Unix-socket client, send `TypeListWorkspaces` with a fixed nonzero CID, read framed control messages until the matching `TypeWorkspaceList`, require at least one workspace, then close the probe before returning. Retry only transient not-ready failures within the existing deadline. Return a readiness-specific fatal diagnostic on timeout. Do not move `EnsureDefault` or weaken assertions.

## B3 — Falsifiable verification
Run and retain exact outputs/statuses:
- `TMPDIR=/tmp GOMAXPROCS=1 go test -race -count=1000 -cpu=1 -run '^(TestServerColdStartCreatesDefault|TestLayoutCommandBroadcast)$' ./internal/sessiond`
- focused existing `internal/sessiond` tests;
- `make build`;
- `git diff --check`;
- `TMPDIR=/tmp go test -count=1 ./...` and compare with the established four unrelated baseline failures.

No new unit-test file. If 1000 repetitions exceed the lane budget after substantial clean evidence, report the exact completed count and blocker rather than claiming it ran.

## B4 — Bank
Commit only `internal/sessiond/server_test.go` with required Amplifier footer, push `HEAD:refs/heads/gb/crash-recovery/runtime-baseline`, verify clean parity, then write ignored root `DONE.json` as final action with lane/session/verdict/head/pushed/items/residuals/pending_human/suite.

Time bound: 35 minutes / 24 turns.

## Scope-outs
No production behavior, recovery runtime, store, protocol, relay, frontend, service, docs, dependencies, new tests, merge, or dev-local interaction.

## KNOWN
The same scheduler-sensitive panic reproduces on pre-Wave1 baseline and current integration. The server creates the socket before `EnsureDefault`, while the real accept loop begins only afterward; the fixture's readiness proxy is wrong.
