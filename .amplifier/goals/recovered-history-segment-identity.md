# Goal: give recovered history authoritative segment identity

## Outcome
Produce a committed, pushed `gb/crash-recovery/recovered-history-segment-identity` migration and browser contract where non-consecutive replay is idempotent by immutable store-issued segment identity, while distinct segments with identical text remain distinct.

Complete when **either** B1-B8 all reach PASS, **or** each remainder is conclusively FAIL-named/BLOCKED-named/PENDING-HUMAN. No identity, migration, or browser-forgery residual may be COMPLETE.

## B1 — Exact ownership
Own only `internal/sessiond/recovery_store.go`, `recovery_history_store.go`, `recovery_store_file.go`, `recovery_runtime_reconstruct.go`, `protocol.go`, `internal/server/ws.go`, `web/src/types.ts`, `web/src/recovery-wire.ts`, `web/src/ws.ts`, `web/src/lib/recovered-history-store.ts`, and existing `web/src/__tests__/ws.test.ts`, `ws.sessiond.test.ts`, `protocol.types.test.ts` for mechanical expectation synchronization. Add no test case/file. Pane/runtime/server.go/client/state/rendering/service/helper/docs/dependencies are read-only.

## B2 — Durable identity
Add `RecoveryHistorySegmentID {Generation RecoveryStoreGeneration, Sequence uint64}` with strict canonical decimal-string JSON for both nonzero uint64 fields. Add ID to `RecoveryHistorySegment`. File store alone assigns ID: generation is current validated snapshot generation at flush; sequence is the trusted global history filename/frame sequence. Caller cannot choose it. Require unique increasing sequence, nondecreasing generation, ID/filename match, one ID→one qualified pane, no wrap. Reopen derives next sequence from retained max; restart at one only when no prior segment can replay and browser stream state is reset/fresh or generation advanced. Empty flush remains a zero no-op never encoded/projected.

## B3 — Crash-safe v1→v2 migration
Keep outer store schema; add strict versioned history payload v2 containing identity. Under exclusive writer lock during open, decode each validated filename/frame as exact v1 or v2. For v1 derive sequence from filename/frame and generation from current nonzero validated snapshot; require pane exists. Rewrite each independently via implementation-owned pending file, fsync, atomic rename over exact filename, directory fsync. Crash before/after rename leaves valid v1 or v2 and migration resumes; mixed valid sets supported. Unknown/mixed fields, malformed legacy, zero generation, duplicate/cross-pane IDs, future version, mismatch or overflow fail open without dropping history.

## B4 — Browser v2 fragmentation
Add browser capability `recovered-history-segment-v2`; stop advertising/intersecting legacy literal capability while retaining source constants only as needed. New↔old peers negotiate no history, ordinary recovery/terminal features remain. Enrich literal with `segmentId`, zero-based `part`, `final`, qualified pane, text, truncated. Canonical strings parse with BigInt and uint64 bound; each part obeys 4 KiB/256 lines, contiguous part count <512, part zero begins, exactly one final, truncated only part zero, all parts same pane/ID. Add `ProjectRecoveredHistorySegment` that validates, joins/splits at UTF-8 rune/line boundaries, emits contiguous exact reassembly, fails over bound. Runtime caller remains future.

## B5 — Reconstruction and browser idempotency
Preserve full ID in reconstruction plan sorted by generation/sequence; no text/index-derived identity. Browser store replaces text heuristic with bounded per-pane pending assembly/high-water and global ID→pane binding. Render only after final contiguous segment; exact repeated pending/committed parts no-op; conflict/skipped/out-of-order/cross-pane/stale ID reject without visible mutation. Different IDs with identical text append separately. Sequence gaps across panes allowed; lower/equal pane high-water stale. Trimming never lowers high-water. Clear pending/high-water/global bindings on transport teardown/detach/new authoritative composition/recovery stream as appropriate, not simple tab switch. Seen-state exhaustion fails closed without evicting replay protection.

## B6 — Firewall and bounds
Recovered history remains daemon-event only with semantic zero CID and negotiated v2 capability. Browser request forging reaches no daemon/event/state. Segment identity is not secret or authority and never enables retry/select/CWD/launch. No IDs/text in logs. Conflicting duplicates remain invisible. Preserve literal sanitization and current app rendering.

## B7 — Falsifiable migration/browser proof
Under `/tmp/crash-recovery-r4/recovered-history-segment-identity/`, retain minimal sources, exact commands/results/hashes/map/validator. Go probe: flush-close-reopen IDs; monotonicity across commits; v1 migration and crash at pending/write/fsync/rename/dirsync; mixed resume; duplicate/mismatch/future/zero/overflow rejection; max projection bounds/exact reassembly. Browser/real Chromium: nonconsecutive same ID once; duplicate parts once; same ID different text/pane reject; missing/out-of-order invisible; gaps across panes accepted; lower ID stale; two IDs same text twice; clearing permits authoritative replay; trimming cannot re-enable old ID; max uint64 strings distinct; forged browser event rejected. Negative controls removing ID check, using JS number, content-hash dedup, or legacy capability must fail.

## B8 — Verify and bank
Run gofmt/diff-check/make build/Go+Linux builds/check:fast/full web exact current 19/153 baseline/focused probes/exact Go baseline. Commit only owned files with footer, push exact branch, clean parity, session-bound ignored DONE last with B1-B8/evidence. Time 105m/70 turns. Never merge.

## Scope-outs
No VT extraction/flush scheduling/runtime event emission, pane roots, durable structural mutation, helper/vendor/service changes, rendering redesign, new tests, DTU, PR, merge, or dev-local.

## KNOWN
Current identity-less history UI is bounded and inert but cannot distinguish non-consecutive replay from legitimate repeated output. This lane resolves only identity/migration/assembly; runtime emission remains later.
