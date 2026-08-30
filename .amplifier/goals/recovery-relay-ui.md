# Goal: connect and contain browser recovery

## Outcome
Produce a committed, pushed `gb/crash-recovery/recovery-relay-ui` implementation that safely relays daemon recovery requests/events, enforces WebSocket and tunnel-origin containment, and renders bounded recovered history as inert accessible text without granting browser authority.

Complete when **either** every C1-C7 item is terminal, **or** the remainder is conclusively impossible with a named blocker per item. Use `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`; no critical browser-boundary residual may be called COMPLETE.

## C1 — Exact ownership
Own only existing backend files:
- `internal/server/ws.go`
- `internal/server/server.go`
- existing `internal/server/{server_test.go,ws_config_test.go,ws_lifecycle_test.go,ws_relay_test.go,auth_test.go,relay_test.go,wiring_test.go,attach_ordering_test.go,e2e_test.go}` for fixture/expectation synchronization only

Own only existing frontend files:
- `web/src/ws.ts`
- `web/src/state.ts`
- `web/src/app.ts`
- `web/src/components/mux-dock.ts`
- `web/src/components/recovery-status.ts`
- `web/e2e/crash-recovery.mjs`
- existing `web/src/__tests__/{ws.test.ts,ws.sessiond.test.ts,state.test.ts,state.workspace.test.ts,state.immutable.test.ts,state.seam.test.ts,terminal-registry.test.ts,terminal-registry.workspace.test.ts}` for fixture/expectation synchronization only

May add only `web/src/components/recovered-history.ts` and `web/src/lib/recovered-history-store.ts` if needed. Frozen `internal/server/daemon.go`, sessiond/contracts/client, `web/src/types.ts`, `web/src/recovery-wire.ts`, terminal-registry production code, service, config, docs, dependencies, and other paths are read-only. Add no test file/case.

## C2 — Cross-site and tunneled-page containment
Remove `InsecureSkipVerify`. Before opening sessiond, require one valid browser Origin and exact same trusted muxterm origin: no null/absent/multiple/malformed origin, userinfo/path/query/fragment, or request-derived forwarded-header trust. Enforce under no-auth too. Direct mode matches scheme/TLS and request host; configured public/reverse-proxy mode uses canonical server configuration only.

Same-origin tunnel content under `/t/{id}` must not gain muxterm origin authority. Apply a response-level sandbox/isolated-origin policy without `allow-same-origin`, move it to an unprivileged origin, or disable tunnel pages while recovery is enabled; do not merely rely on Origin. Preserve the intended browser-pane experience as far as the chosen safe policy permits. A hostile external page and a hostile tunneled page must both fail to open `/ws` or invoke terminal/recovery APIs.

## C3 — Strict relay and independent CIDs
Classify bounded browser text before generic decode. Any recovery type/field uses `DecodeBrowserRecoveryRequest`; owner-local names/fields, result/event types, malformed/wrong/pre-hello requests cause no daemon call. Route only protocol hello, retry, opaque selection, and qualified active-pane requests through frozen `DaemonConn`. Preserve browser CID while sessiond.Client uses an independent daemon CID; validate results and send only browser-safe reply with original CID. Wire CID-zero pane-recovery, recovered-history, and replacement-outcome events after validation. Malformed/timeouts return redacted failure without closing healthy ordinary terminal traffic.

On each socket open allocate a positive CID, send hello as first application frame with all five capabilities, remember it, and accept only the matching hello result. Legacy server silence leaves ordinary muxterm usable while recovery controls remain disabled.

## C4 — Workspace-qualified state and literal history
Maintain bounded current-composition recovered-history by `workspaceId:paneId`. Clear prior data on reconnect/composition, pane/workspace close, detach, or missing pane. Ignore cross-workspace collisions and stale events. Recovery status remains daemon-authoritative with no optimistic structural removal or strategy choice.

Render active-pane history separately from xterm through Lit interpolation/text nodes in an accessible `<pre>` with clear truncation/recovery boundary. Never use `innerHTML`, `unsafeHTML`, xterm/terminalRegistry writes, VT parsing, contenteditable, terminal input, clipboard APIs, or script-capable URLs. Browser memory is bounded; discard oldest complete lines and mark truncation. OSC/CSI/DCS/HTML-looking strings display literally and cannot change title, DOM, clipboard, terminal, or outbound input.

## C5 — Clear known test residual without weakening
Update only existing hello fixtures/expectations in `ws.sessiond.test.ts` and `ws.test.ts` for positive nonzero CID and exactly five capabilities including `recovered-history-literal`. Clear exactly the 16 stale failures. Synchronize other owned existing fixtures only where production behavior intentionally changes; never delete/weaken unrelated assertions. Expected standalone web suite is exactly the established 19 failures/153 passes; any other delta is a blocker, not a renamed baseline.

## C6 — Real browser evidence
Use a unique isolated server/state/runtime and real Chromium/playwright-cli, never port 8313/dev-local. Retain exact driver/source/screenshots/trace/network/console/output/hashes under `/tmp/crash-recovery-r2/recovery-relay-ui/`. Prove same-origin success; foreign/missing/null/multiple Origin 403 before daemon attach; tunneled hostile content cannot open `/ws`; hello first/nonzero/five capabilities; legacy no-result degradation; owner-local/pre-hello/result-event injection causes zero daemon calls; ordinary config containing `driver.launch` still works; exact CID replies; two browsers converge; cross-workspace pane-1 isolation; literal hostile text inertness; closure/reconnect clears state; keyboard/a11y and terminal usability.

Extend only existing `web/e2e/crash-recovery.mjs` so relay/browser scenarios are real and tool/runtime scenarios remain explicit fail-loud until merged R3. Do not claim daemon crash recovery in this lane.

## C7 — Verify and bank
Run format/static checks, `make build`, Go/Linux builds, full web suite with exact 19/153 expected baseline, exact Go baseline comparison, diff-check, and retained real-browser validator. No new tests. Commit only owned files with footer, push exact branch, clean parity, then matching ignored DONE.json last with C1-C7/evidence. Time bound 80 minutes / 55 turns.

## Scope-outs
No sessiond/store/strategy/helper/service implementation, frozen contract edits, general UI redesign, dependencies, docs, DTU launch, merge, PR, or dev-local interaction. Real A-generated events and service-driven crash/reconnect remain R3/DTU residuals.

## KNOWN
Pre-lane web baseline is 35 failed/137 passed; exactly 16 are stale hello expectations owned here, yielding the prior 19 failed/153 passed baseline after synchronization. Go has four known unrelated failures. Browser never owns recovery decisions.
