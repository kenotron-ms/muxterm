# Goal: freeze final recovery runtime contracts

## Outcome
Produce a committed, pushed additive contract slice on `gb/crash-recovery/runtime-contracts` that lets the sessiond runtime, dedicated owner-local lifecycle socket, browser relay, and literal-history frontend build independently without sharing files.

Complete when **either** C1-C7 all reach `PASS`, **or** any impossible item reaches `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN` with an exact reason. No runtime recovery claim belongs to this lane.

## C1 — Exact ownership
Own only:
- `internal/sessiond/recovery_integrations.go`
- `internal/sessiond/protocol.go`
- `internal/sessiond/client.go`
- `internal/server/daemon.go`
- existing `internal/server/daemon_test.go` for compile-only fake synchronization
- `web/src/types.ts`
- `web/src/recovery-wire.ts`

No other source/test file. Add no test case/file. Preserve backward-compatible legacy control traffic.

## C2 — Owner-local bootstrap and explicit bind
Add bounded validated contracts for:
- lifecycle event exactly `session-start`;
- sources `startup`, `resume`, `fork`, `clear`, `compact`;
- `RecoveryLifecycleBootstrapRequest {schemaVersion,strategyId,event,source}` containing no pane/PID/UID/generation/epoch/integration/timestamp/capability/session/CWD;
- discriminated bootstrap result: accepted requires detail none and exactly one existing lease delivery; rejected has no lease and one compatible redacted detail;
- explicit bind request containing exactly workspace-qualified pane, fixed strategy, bounded exact session ID, and validated CWD on owner-local transport;
- discriminated bind result with no sensitive echo.

Define `RecoverySocketAuthority` whose methods take a kernel-derived peer PID out-of-band and bootstrap, capture, and bind requests. The runtime derives pane/fence/generation/epoch/timestamps and commits captures; JSON never asserts them.

## C3 — Directional dedicated-socket protocol
Extend `OwnerLocalRecoveryMessage` and constants for bootstrap/result and explicit-bind/result while preserving exactly-one-payload validation. Add `DecodeRecoverySocketRequest(payload)` that first uses the strict owner-local decoder, requires nonzero CID, and accepts only bootstrap, lifecycle-capture, and explicit-bind request types. It rejects all result/replacement/generic/browser types. Update writer validation. No browser or generic `Message` may carry owner-local fields.

## C4 — Literal recovered history
Add capability `recovered-history-literal`, server event type `recovered-history`, and bounded `RecoveredHistoryLiteral {pane,text,truncated}`:
- workspace-qualified pane;
- valid UTF-8 text 1..4096 bytes;
- at most 256 LF-delimited lines;
- LF is the only control permitted; reject every other Cc/Cf, CR, tab, ESC, DEL, C1, OSC/CSI/DCS content;
- event CID must be zero.

Add browser-safe `Message`/TypeScript mirror fields and strict parser. Add `DecodeBrowserRecoveryRequest` allowing only protocol-hello, recovery-retry, recovery-select, and set-active-pane with nonzero CID; browsers cannot forge history/events/results. Keep privileged-name rejection path-aware so ordinary `config.driver.launch` remains valid.

## C5 — Client and relay interfaces
Add validated finite-timeout methods to `sessiond.Client`:
- `ProtocolHello(ProtocolHelloRequest) (ProtocolHelloResult,error)`
- `RecoveryRetry(RecoveryRetryRequest) (RecoveryRetryResult,error)`
- `RecoverySelect(RecoverySelectRequest) (RecoverySelectResult,error)`
- `SetActivePane(ActivePanePersistenceRequest) (ActivePanePersistenceResult,error)`

Each validates before send, correlates exact reply type/CID, requires nonnil valid payload, and returns no partial authority. Add handlers for pane-recovery-changed, recovered-history, and replacement-outcome, dropping malformed events. Mirror four methods on `internal/server.DaemonConn`; compile-synchronize its existing fake only.

## C6 — Browser minimization
TypeScript exposes only redacted status/labels/detail, qualified pane, opaque candidate handles, and literal sanitized history. It has no session ID/CWD/executable/argv/env/capability/fence/generation/integration/lease/bind owner-local types. Advertise literal-history support. Strictly reject owner-local top-level fields and authority-bearing fields only inside recovery envelopes; never recursively reject common names in unrelated config.

## C7 — Verification and bank
Use a removable direct contract probe retained under `/tmp/crash-recovery-runtime-contracts/` to prove accepted/rejected union exclusivity, socket request direction, browser request direction, history bounds/control rejection, ordinary config compatibility, Client request correlation/timeouts, and malformed event dropping. Add no committed test. Run gofmt, diff-check, `go build ./...`, Linux sessiond build, web check:fast, unchanged existing protocol type test, full known-baseline comparisons. Commit only seven owned files with footer, push exact branch, clean parity, write session-bound ignored DONE last.

Time bound: 70 minutes / 50 turns.

## Scope-outs
No store mutation, process/PTY launch, recovery listener, peer inspection, config installer, browser relay behavior, history rendering, service, origin policy, leadership lock, docs, dependencies, new tests, merge, or dev-local interaction. No run handle or new durable-restore source: runtime directly replaces PTY root with structured exec and privately rebinds the existing capture while retaining its evidence source.

## KNOWN
Base descends from integration `d8d40c94305a9cf67e10673c9e0ea8be269ddd1e`; exact lane seed is supplied by the orchestrator. Existing web baseline is 19 failures/153 passes; Go baseline is four named unrelated failures; check:fast is 8 warnings/0 errors.
