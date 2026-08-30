# Goal: build a pure recovery reconstruction model

## Outcome
Produce a committed, pushed `gb/crash-recovery/recovery-reconstruction-model` implementation that strictly converts validated durable recovery state and closed Dockview layouts into a deterministic, metadata-only reconstruction plan without starting processes, PTYs, sockets, strategies, or mutable registry state.

Complete when **either** A1-A6 are all terminal, **or** each remainder is conclusively `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN` with exact reason. A load-bearing residual forbids COMPLETE.

## A1 — Exact ownership
May add only `internal/sessiond/recovery_layout_codec.go` and `internal/sessiond/recovery_runtime_reconstruct.go`. All existing source, tests, contracts, store, registry/workspace/pane runtime, server, frontend, service, docs, and dependencies are read-only. Add no test file/case.

## A2 — Pure closed reconstruction plan
Define private immutable-style plan values for store generation, workspaces, workspace-qualified panes, surface/title/dimensions/CWD metadata, active pane, canonical layouts, captures, claims, attempts, outcomes, and bounded history. `planRecoveryRegistry(RecoveryLoadResult)` revalidates every reference and returns either one complete deterministic plan or error with no partial result. It must never call `NewPane`, `NewRegistry`, `exec`, PTY, filesystem launch validation, strategy methods, store mutation, socket, goroutine, broadcast, or shell fallback. Generation-zero empty state yields an empty plan; it never invents a default workspace.

Reject duplicate workspace IDs, duplicate qualified pane refs, zero/invalid IDs or dimensions/surfaces, dangling/cross-workspace active panes/layouts, capture/claim/attempt/outcome references, malformed/over-bound history, stale automatic-attempt authority, and any state-to-command interpretation. Preserve exact qualified identities; never key by bare pane ID. Browser records contain no URL; terminal records contain no argv/environment/command.

## A3 — Strict Dockview codec
Implement bounded strict UTF-8 one-value duplicate/unknown-key rejecting conversion between the supported Dockview JSON grammar and frozen `RecoveryLayout`. Closed grammar contains only grid/root/orientation/optional width+height, leaf/branch nodes, id/views/activeView, panels id/title/contentComponent, positive integer sizes, and terminal/browser surface. Reject arbitrary component state, URLs, floating/popout metadata, malformed IDs, missing/extra panels, duplicate views/groups, wrong surface, invalid active refs, excessive depth/count/bytes, fractional/zero child sizes, overflow, geometry gaps/overlap.

Use deterministic largest-remainder ratio apportionment to `RecoveryStoreLayoutRatioScale`, source-index tie breaking, alternating orientations, canonical positive-decimal IDs, and deterministic rectangular geometry. Reverse encoding emits only the closed grammar and regenerates title/surface from pane metadata. Canonicalize single-leaf orientation to HORIZONTAL and record that frozen-model limitation only.

## A4 — Falsifiable no-execution proof
Create a removable non-test probe under `/tmp/crash-recovery-r3/recovery-reconstruction-model/` with minimal source, exact commands/stdout/stderr/status/hashes, source-to-claim map, and validator. Prove two workspaces both containing pane 1 stay distinct; metadata/recovery records and nested unequal splits round-trip deterministically; allocatable maxima are derived without collision; browser plan has no URL and terminal plan no process/argv. Prove malformed/dangling/duplicate/cross-workspace/unknown-field/surface/depth/ratio/geometry cases return no plan and execute zero child-process sentinel calls. Include negative controls that would fail if keyed by bare pane ID, unknown fields were retained, or any exec/PTY constructor became reachable.

## A5 — Verification
Run gofmt, `git diff --check`, `make build`, `go build ./...`, Linux sessiond build, focused removable probe, existing affected package tests unchanged, web `check:fast`, and exact known Go/web baseline comparison. The separately documented `TestStress_ConcurrentSessions` flake is not a stable baseline; if observed, record/retry with fresh fixture and compare to base rather than relabeling it.

## A6 — Bank
Commit only the two allowed files with required Amplifier footer, push explicit branch, verify clean local/remote parity, then write ignored root DONE.json last with lane/session/verdict/head/pushed/A1-A6/evidence/residuals/pending_human/suite. Time 65 minutes / 42 turns. Never merge.

## Scope-outs
No registry activation, allocator mutation, pane/shell creation, leadership, durable mutation, CWD trust, history emission, recovery launch, browser/service/helper changes, new tests, DTU, PR, merge, or dev-local.

## KNOWN
Base is supplied by the orchestrator from integration head `caa2d9c7fff3036f57a46c2e42175ca95f4a6151`. Production activation remains a dependent linear runtime lane.
