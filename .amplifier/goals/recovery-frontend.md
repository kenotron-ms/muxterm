# Goal: implement daemon-authoritative recovery UX

## Outcome
Produce a committed, pushed browser implementation on `gb/crash-recovery/recovery-frontend` that strictly decodes and renders frozen recovery projections, emits only safe retry/selection/active-pane intents, and keeps all authority in sessiond.

Complete when **either** all F1-F5 items are terminal, **or** remaining items are conclusively blocked with named reasons. States are `PASS`, `FAIL-named`, `BLOCKED-named`, `PENDING-HUMAN`.

## F1 — Exclusive ownership
Own only:
- new `web/src/recovery-wire.ts`
- new `web/src/components/recovery-status.ts`
- `web/src/ws.ts`
- `web/src/state.ts`
- `web/src/app.ts`

The frozen `web/src/types.ts` and all Go files are read-only. Do not edit dock/picker/terminal-registry/workspace-controller/tests/e2e.

## F2 — Strict transport and state
Add one hello after every socket open with nonzero schema and exactly browser-safe supported capabilities. Recovery controls stay disabled on missing/incompatible negotiation without breaking ordinary terminal use. Add retry, candidate-handle selection, and workspace-qualified active-pane persistence using the existing CID allocator. Methods return false while disconnected/unsupported; no optimistic state.

Strictly parse only frozen browser-safe recovery messages: reject unknown/privileged fields, invalid status/detail combinations, unsafe pane identities, malformed handles, and over-four candidates. Never retain handles beyond current selection-needed state. Composition adopts recovery projection; transitions/results update only exact attached workspace-qualified panes; removal/detach clears transient state; active-pane result applies only on success and existing same-workspace pane. Never key by bare pane ID across workspaces.

## F3 — Accessible minimal UX
Render only active pane status: restoring, recovered, shell-restored, selection-needed, provisional, strategy-failed, plus durable-history boundary. Use fixed labels/messages, `aria-live=polite`, native keyboard-focusable buttons and visible focus. Retry emits pane ref. Selection returns only daemon candidate handle. No session ID, CWD, executable, argv, generation, capability, raw error, or opaque hidden authority in DOM/log/storage. Terminal remains usable.

## F4 — Real browser evidence
Launch this worktree on a unique free port with isolated runtime/state, never port 8313 and never the user's dev-local daemon. Use real Chromium/playwright-cli and a temporary noncommitted harness or safe message injection seam to exercise every status, retry/select/active-pane intent, workspace ID collision, stale candidate replacement/removal, disconnected/incompatible behavior, keyboard/a11y state, and absence of privileged sentinel values. Retain exact harness source, screenshots, trace, commands/output under `/tmp/crash-recovery-wave1/recovery-frontend/`; remove temp artifacts before commit. Relay-backed behavior is a named Wave 2 residual.

## F5 — Verify and bank
Run `cd web && npm run check:fast`, `npm run build`, `node --check` on temporary harness, `go build ./...`, diff-check, and known web/Go baseline comparisons without fixing them. Add no tests. Commit/footer, push explicit branch, never merge, valid ignored `DONE.json` last. Time bound: 70 minutes / 55 turns.

## Scope-outs
No daemon/runtime/relay implementation, Go/protocol/type edits, terminal history, strategies, service, DTU, docs, dependencies, new tests, or general UI redesign.

## KNOWN
Sessiond is sole authority. Browser gets fixed labels/redacted details/opaque candidate handles only. Pane IDs are workspace-local. Existing user dev-local runs on 8313 and is read-only/off-limits.
