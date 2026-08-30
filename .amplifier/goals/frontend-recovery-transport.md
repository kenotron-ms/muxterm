# Goal: enforce correlated browser recovery transport

## Outcome
Produce a committed, pushed `gb/crash-recovery/frontend-recovery-transport` implementation where every browser recovery request has one reserved positive connection-scoped CID, only its exact matching result can affect state, and daemon broadcasts require semantic CID zero.

Complete when **either** C1-C7 are all terminal, **or** each remainder is conclusively `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`. A browser trust-boundary residual forbids COMPLETE.

## C1 — Exact ownership
Own only `web/src/ws.ts`, `web/src/recovery-wire.ts`, and existing `web/src/__tests__/ws.test.ts`, `ws.sessiond.test.ts`, `protocol.types.test.ts` for expectation/fixture synchronization. Add no test file/case. All Go, types.ts, state/app/components, terminal registry, docs, dependencies, and other tests are read-only.

## C2 — One bounded CID namespace
Use one connection-scoped allocator/reservation system for close and recovery operations; positive safe integers, wrap-safe, no collision, max 32 pending recovery requests, 10-second recovery timeout. Track expected kind for hello/retry/select/active-pane before send; remove on send error/timeout/result/disconnect/destroy. Late results from a previous connection cannot affect current state.

## C3 — Hello and legacy behavior
On every open reset negotiation/pending state, reserve a positive CID, and send protocol hello as first application frame with exactly five current capabilities including `recovered-history-literal`. Register pending before send and enable recovery only after a valid compatible matching hello result. Wrong/zero/duplicate/stale/cross-kind result does nothing. Hello timeout/incompatibility leaves recovery disabled but ordinary attach/list/binary terminal traffic fully usable; no reconnect loop solely for missing legacy hello.

## C4 — Strict direction and event admission
Update the raw strict recovery parser as necessary without changing browser-visible schema. Correlated result types require a positive CID; pane-recovery-changed, recovered-history, replacement-outcome require semantic zero (explicit 0 or Go-omitted zero) and reject positive/negative/unsafe CID. In ws.ts, require matching pending CID and exact request/result kind; unsolicited, duplicate, prehello, wrong-capability, wrong-kind, malformed, duplicate-key, owner-local, or browser-supplied event/result traffic is dropped before `onRecoveryEvent`. Accept valid CID-zero events only after compatible hello and corresponding negotiated capability. Preserve path-aware privilege rejection and ordinary `config.driver.launch` processing.

## C5 — Clear exactly the assigned fixture residual
Synchronize only existing expectations/fixtures for positive hello CID and exactly five capabilities. Clear the 16 stale hello failures. Do not weaken the two existing normal-close failures or unrelated tests. Standalone full web result must be exactly 19 failed / 153 passed; another delta is a named blocker.

## C6 — Falsifiable protocol/browser proof
Use a temporary WebSocket harness plus real Chromium on a unique port under `/tmp/crash-recovery-r3/frontend-recovery-transport/`; retain source, network/console/output/screenshots where relevant, statuses/hashes/map/validator. Prove hello first/positive/five; ordinary traffic while unanswered; matching result enables exact capabilities once; wrong/zero/duplicate/stale/cross-kind results do nothing; positive-CID/prehello broadcasts drop; CID-zero negotiated events fire once; close/recovery allocations never collide; timeout/reconnect invalidate old CIDs; malformed/owner-local fields yield no callback/request; ordinary config remains. Include negative controls for untracked hello, loose result matching, and positive-CID event acceptance.

## C7 — Verify and bank
Run format/static, `make build`, web check:fast, exact 19/153 suite, Go/Linux builds and known baseline comparison, diff-check, real-browser/protocol validator. Commit only owned files with footer, push exact branch, clean parity, write session-bound ignored DONE last with C1-C7/evidence. Time 65 minutes / 42 turns. Never merge.

## Scope-outs
No state/history UI, Go relay/runtime, terminal registry, service/helper/vendor changes, new tests, docs/dependencies, DTU, PR, merge, or dev-local. Runtime-produced recovery events and crash acceptance remain dependent.

## KNOWN
Base web baseline is 35 failed/137 passed: exactly 16 stale hello expectations are owned here; the remaining 19 are established unrelated failures.
