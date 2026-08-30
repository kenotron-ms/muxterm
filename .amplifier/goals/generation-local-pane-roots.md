# Goal: make pane process roots generation-local

## Outcome
Produce a committed, pushed `gb/crash-recovery/generation-local-pane-roots` implementation where structured root replacement is rollback-safe and no retired process can publish output, prompt, CWD observation, buffer mutation, cleanup, or exit against the current pane generation.

Complete when **either** A1-A7 all reach PASS, **or** each remainder is conclusively FAIL-named/BLOCKED-named/PENDING-HUMAN. No stale-root or CWD-authority residual may be COMPLETE.

## A1 — Exact ownership
Own only existing `internal/sessiond/pane.go`, `activity.go`, `shell_integration.go`, `server.go`, `registry.go`; may add `internal/sessiond/recovery_pane_root.go`. Existing `pane_test.go`, `pane_osc133_test.go`, `server_integration_test.go`, `registry_test.go` may receive fixture/signature synchronization only; add no test case/file. All store/contracts/reconstruction/protocol/client/peer-process/relay/frontend/service/helper/docs/dependencies are read-only.

## A2 — Immutable generation-local root
Move root-specific command, PTY, start time, lifecycle parser/token/evidence, cleanup and CWD filter into one captured `paneRoot` whose identity/OS handles never change. Keep pane-local ID/title/surface/dimensions/sizing/buffer/callbacks/final-close state. Preserve existing `NewPane` signature/behavior through a wrapper. Add validated deep-copied `PaneLaunchOptions` (exact argv, clean absolute CWD, nil=inherited or nonnil complete environment), callbacks, root identity, `NewPaneWithOptions`, `ReplaceRoot(expectedGeneration,options)`, `CurrentRootIdentity`, and `ForegroundProcessIdentity`. Reject NUL/malformed/duplicate env, invalid CWD/argv, zero/wrapped generation; never log sensitive values or invoke shell text.

## A3 — Linearized replacement and I/O
Use one documented lock order to serialize replace/final close/size handoff and linearize current-root checks with every externally visible effect. Readers capture their own root pointer and never consult mutable pane command/PTY. Candidate starts privately, receives latest dimensions, and starts no read loop before atomic publication; failure kills candidate and preserves incumbent. After publication no failure rolls authority back. Retire old root, then terminate/cleanup it. Write/resize/close target only the current root. A retired root can perform root-local wait/cleanup only.

Carry root generation through exit callback/server handling; registry/server remove a pane only if the exiting root is still current. Before output/buffer/prompt/CWD/exit callback, recheck exact root pointer+generation under the delivery boundary. Concurrent replacement/close is deterministic and stale expected generation starts no child.

## A4 — Authenticated token-only CWD refresh
Each supported default bash/zsh root gets a high-entropy root-local token. Prompt hook emits only a bounded private `OSC 777;muxterm-cwd;<token> BEL` refresh marker—never a path, PWD, session ID, or authority. A streaming root-local filter handles arbitrary read splits, strips complete matching markers before lifecycle parser, prompt scanner, buffer, history, activity, browser, or terminal query handling, and passes unrelated/wrong-token OSC unchanged. Malformed authenticated marker is stripped and marks root evidence conflicting.

A valid marker triggers bounded kernel process reinspection of that exact current root using already-merged platform primitives. Callback receives immutable root identity plus freshly kernel-observed canonical CWD; token possession alone is not trust. Custom commands/unsupported shells remain unknown. Duplicate unchanged observation is no-op. Concurrent replacement or failed inspection emits nothing. The later runtime still must descriptor-validate before persistence/launch.

## A5 — Compatibility and security
Existing bash/zsh/custom command input/resize/replay/exit behavior remains. Browser panes have no root. Root-generation wrap fails. Per-root cleanup cannot remove current root integration assets. No private marker/token/CWD enters replay, logs, errors, title, browser protocol, history, or activity. No store mutation, strategy/session ID, recovery launch, leadership, or reconstruction activation is introduced.

## A6 — Falsifiable real-PTY proof
Under `/tmp/crash-recovery-r4/generation-local-pane-roots/`, retain minimal source, real PTY child fixtures, commands/stdout/stderr/status/hashes/map/validator. Prove exact argv/CWD/environment without shell interpretation; candidate spawn/resize failure preserves old PID/generation/input/output; successful swap once; delayed old-root output/prompt/marker/exit yields zero visible effect or pane removal; new root effects once; concurrent write/resize/replace/close race-clean; foreground identity tracks current generation; marker split at every byte boundary stripped with one kernel-derived callback; wrong/replayed/malformed/oversized marker cannot establish CWD/idle; visible surrounding bytes unchanged; token/frame absent from replay. Include mutants removing current-root output check, generation-qualified exit, and marker strip; each must fail.

## A7 — Verify and bank
Run gofmt/diff-check/make build/Go+Linux builds/check:fast/focused existing tests/real-race probe/exact known baselines. Commit only owned paths with footer, push exact branch, clean parity, write session-bound ignored DONE last with A1-A7/evidence. Time 90m/60 turns. Never merge.

## Scope-outs
No store leadership/durable mutation, reconstruction activation, history persistence, lifecycle socket/leases, strategies/claims/outcomes, browser/service/helper changes, new tests, DTU, PR, merge, or dev-local.

## KNOWN
Base is the orchestrator seed from `42cb14edf6419389ca739896f6ab0f02a4d3519a`. The private marker is only a trigger for kernel CWD inspection, not a path-bearing protocol.
