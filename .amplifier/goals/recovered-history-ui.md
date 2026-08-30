# Goal: render recovered history as bounded inert text

## Outcome
Produce a committed, pushed `gb/crash-recovery/recovered-history-ui` implementation that stores recovered history by workspace-qualified pane identity and displays it as bounded accessible literal DOM text entirely outside xterm and terminal input.

Complete when **either** D1-D7 are all terminal, **or** each remainder is conclusively `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`. Any xterm/HTML/input or unbounded-memory residual forbids COMPLETE.

## D1 — Exact ownership
Own only existing `web/src/state.ts`, `web/src/app.ts`, `web/src/components/recovery-status.ts`; may add `web/src/components/recovered-history.ts` and `web/src/lib/recovered-history-store.ts`. Existing state tests may be synchronized only if signatures/fixtures require it; add no test case/file. Do not modify ws.ts, recovery-wire.ts, types.ts, mux-dock.ts, terminal-registry, Go, service/helper, docs, dependencies, or other tests.

## D2 — Workspace-qualified bounded store
Implement a dedicated store keyed only by `workspaceId:paneId`, with immutable snapshots and subscriptions. Accept already-validated `SessiondRecoveredHistoryLiteral` only for the currently attached workspace and a pane present in the current composition. Recheck positive identity and aggregate bounds. Per pane: 64 KiB UTF-8 and 4096 logical lines; at most 256 panes and 4 MiB globally. Trim oldest complete lines deterministically and mark truncated; under global pressure trim least-recently-updated records before eviction. Never split Unicode scalars or retain unbounded partial lines. Do not persist/log/export history.

## D3 — Authoritative lifecycle clearing
A new composition clears that workspace's old history before establishing its pane census. Delete exact data on pane close, workspace close/list absence, detach, missing-pane reconciliation; clear all on transport loss/reconnect and app/component teardown. Ignore stale/cross-workspace events, including w2/pane1 while attached to w1/pane1. Duplicate replay cannot grow memory indefinitely or duplicate displayed content.

## D4 — Literal accessible rendering outside xterm
`<mux-recovered-history>` subscribes to the store and renders nothing without a record. Render a bounded section with short recovery boundary/status, truthful truncation notice, and selectable focusable `<pre>` using Lit interpolation/text nodes only. No innerHTML/unsafeHTML/parser/dynamic URL/CSS interpolation/iframe/contenteditable/key handler/clipboard/link. No `terminalRegistry.write`, `Terminal.write`, VT parser, pane input, activity, title, layout, or strategy-state path. Bulk history is not aria-live. Render for the active terminal pane in app adjacent to but outside `<mux-dock>`; browser panes do not show terminal history.

## D5 — Falsifiable state/browser proof
Use fresh Chromium and a temporary harness on unique port under `/tmp/crash-recovery-r3/recovered-history-ui/`; retain source/screenshots/DOM/network/console/output/status/hashes/map/validator. Prove w1/pane1 and w2/pane1 isolation through switching; composition replacement no duplication; close/detach/disconnect/reconnect clearing; per-pane/global trimming; hostile `<script>`, broken `</pre>`, OSC/CSI/DCS/C1/HTML-looking text appears literally or is rejected by existing parser; no added DOM element/request/title/clipboard/xterm write/outbound terminal frame/layout change; terminal typing/resize/focus/pane switch remain usable; keyboard can select history and return to terminal. Include negative controls that route text through innerHTML or terminal write and require validator failure.

## D6 — Baseline discipline
Because this lane does not consume transport, standalone web baseline remains exactly 35 failed/137 passed. Synchronize no unrelated known failure. After later transport merge, integrated expected is 19/153. If standalone differs, investigate rather than relabel.

## D7 — Verify and bank
Run format/static, make build, web check:fast/full exact baseline, Go/Linux builds and known comparison, diff-check, browser validator. Commit only owned files with footer, push exact branch, clean parity, write session-bound ignored DONE last with D1-D7/evidence. Time 65 minutes / 42 turns. Never merge.

## Scope-outs
No wire/CID parser, Go runtime/relay, mux-dock/terminal-registry, helper/vendor/service, new tests, docs/dependencies, DTU, PR, merge, or dev-local. Real runtime history production/order and crash/reboot acceptance remain dependent.

## KNOWN
The frozen browser type and parser already enforce per-event 4 KiB/256-line/control bounds. This lane adds aggregate state and inert presentation only.
