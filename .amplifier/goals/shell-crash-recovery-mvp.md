# Goal: ship one working shell crash-recovery vertical slice

## Outcome
In one autonomous implementation lane, make a real Chromium session prove that after the exact `sessiond` process is killed with SIGKILL, muxterm reconstructs the same single workspace and terminal pane with its saved one-pane layout and bounded literal pre-crash history, then accepts a new command in a fresh shell.

Complete when **either** M1-M6 all reach `PASS`, **or** each unfinished item is conclusively `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN` with exact evidence. `COMPLETE` is permitted only when the real-browser crash/restart flow passes. A compile check, subsystem proof, or partial foundation is never completion.

## Working rule — one lane, one loop
Work only in the branch/worktree supplied by the launcher, descended from integration commit `1b78eaf41829582ec374a610b5c8bfd073aee4bf`. Stay in this `/goal` until the vertical flow passes or a genuine external blocker is demonstrated. Do not create another goal, branch, worktree, lane, plan, proof-only task, recipe, or implementation sub-agent. Do not split the work horizontally. If verification fails, fix this same vertical slice and rerun it from fresh isolated runtime/state roots.

## M1 — Minimal production scope
Use the already-merged recovery store, reconstruction model, pane-root foundation, WebSocket relay, browser negotiation, history state, and inert history renderer directly. Primary production scope is:
- modify `cmd/muxterm/sessiond_main.go`;
- modify `internal/sessiond/server.go`;
- add `internal/sessiond/recovery_mvp.go`;
- update `AGENTS.md` with the durable-before-visible and literal-history authority invariant.

Only if exact ID/allocation reconstruction cannot be implemented from the package-local MVP file may `internal/sessiond/registry.go` or `internal/sessiond/workspace.go` change. No other production path may change. Add no test file or test case. Existing tests remain untouched unless a compile-only signature synchronization is unavoidable; never weaken an assertion.

## M2 — Recover before listening
Production `sessiond` resolves `RecoveryStateRoot`, opens `OpenFileRecoveryStore`, loads it, and validates it through `planRecoveryRegistry` before binding the ordinary socket. Keep `NewServer` memory-only for existing fixtures and add a recovery-enabled production constructor. A genuinely empty valid store durably creates exactly one default workspace. A valid nonempty store reconstructs exact workspace ID/name, pane ID/title/surface/dimensions, allocator high-water marks, and semantic one-pane layout without creating a duplicate default workspace. Terminal panes start as fresh default shells in the existing safe default directory; old PID/PTY/process recovery and CWD fidelity are out of scope. Unsafe, locked, corrupt, or unreconstructable nonempty state fails startup without silently replacing it.

## M3 — Durable mutations before visibility
For the MVP paths only, serialize recovery state in one server-owned coordinator. Persist workspace creation, default terminal-pane creation, pane rename, pane resize, and wide-layout save through `RecoveryStore.Commit` before publishing the corresponding registry mutation, success reply, or broadcast. Construct a pane privately with delivery stopped, commit its qualified durable model, insert it, then start delivery. On a commit/decode/start failure, leave prior live/durable state authoritative and return a redacted error. Close the store on graceful shutdown; SIGKILL must remain recoverable through the store's existing journal behavior.

## M4 — Durable bounded history and attach order
For current terminal-pane output, accumulate only complete LF-terminated lines with a strict bounded partial-line buffer. Call existing `FlushHistory` before broadcasting a completed line that may become browser-visible; use its existing sanitization so recovered text is inert literal data, never VT input. Do not persist raw PTY bytes or feed recovered bytes into `VTBuffer`/xterm. Handle the existing protocol hello with `NegotiateProtocolHello`. On attach/reconnect enqueue authoritative composition first, then bounded CID-zero recovered-history events for panes in that workspace, then fresh-shell replay/live bytes. Preserve workspace-qualified identity and skip empty history. A history persistence error is redacted and cannot be reported as durable success.

## M5 — Real product verification
First run the static floor:
```bash
make build
go build ./...
cd web && npm run check:fast
```
All must exit 0; `check:fast` must have zero errors. Existing full-suite failures may be recorded only by exact comparison to the known branch baseline; do not write tests to mask them.

Then use `playwright-cli` against a real muxterm serve process, real auto-spawned `sessiond`, and real shell. Do not touch the user's existing `make dev-local`. Create unique private `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, port, browser session, and logs under `/tmp`; verify no stale daemon from another checkout is used.

In one fresh run:
1. Open muxterm in Chromium and reach exactly one workspace with one default terminal pane.
2. Record workspace ID, pane ID, title, surface, dimensions, and normalized one-pane Dockview topology.
3. Type `printf 'MUXTERM_MVP_BEFORE_CRASH\n'` and observe it in live xterm.
4. Wait until the layout/history durability boundary is confirmed through the running product, not by editing store files.
5. Identify the exact auto-spawned `sessiond` executable/PID for this worktree and send SIGKILL only to that PID; require it disappears.
6. Keep the same state root, trigger normal browser reconnect/reload, and require a different `sessiond` PID.
7. Require exactly one workspace and one pane with the same recorded IDs/title/surface/dimensions and equivalent one-pane layout; no duplicate default workspace.
8. Require `<mux-recovered-history>` outside `<mux-dock>`/xterm to contain `MUXTERM_MVP_BEFORE_CRASH`, while the fresh xterm does not receive that old text as terminal input.
9. Type `printf 'MUXTERM_MVP_AFTER_RECOVERY\n'` in the reconstructed pane and observe it in the fresh live xterm.
10. Close only the isolated browser/serve/sessiond resources created by this verification.

Retain a compact `/tmp` evidence record containing exact commands, old/new daemon PIDs, before/after normalized browser state, screenshots or snapshots, console/network errors, and exit statuses. Evidence is support for this live run, not a separate proof project.

Report each observed browser/process checkpoint and its exact evidence inline in the /goal transcript as it is produced.

## M6 — Bank the working slice
After the same source revision passes M5, run `git diff --check`, verify only allowed paths changed, update `AGENTS.md`, commit with the required Amplifier footer, push the exact lane branch, and verify clean local/remote parity. Write ignored root `DONE.json` as the final filesystem action with lane, current session ID, verdict, branch/head/pushed, M1-M6 states, exact live verification evidence, residuals, and `pending_human`.

If M5 cannot pass, do not claim or commit a completed MVP. Bank a source checkpoint only when it is coherent and label the marker `PARTIAL` or `BLOCKED` with the exact failed browser assertion. Do not start follow-on work.

## Scope-outs
No Amplifier/Claude/Codex/OpenCode resumption. No recovery strategy orchestration, lifecycle hooks, recovery socket, claims/retries/selection, service-manager installation, host reboot, DTU, multi-client guarantees, multi-pane guarantees, close/delete durability, CWD restoration, history-v2 migration hardening, broad security campaign, new tests, proof-only artifacts, or follow-on lanes. These are considered only after this exact shell MVP works end to end.

## KNOWN — speed aid, not completion evidence
The integration branch already contains the durable store, strict reconstruction planner, generation-local pane roots, recovery relay/transport, and inert recovered-history UI. Current live startup still creates a fresh registry/default workspace and has no caller for `OpenFileRecoveryStore` or `planRecoveryRegistry`; this goal closes that live seam. The project bans new unit tests and requires real browser plus real `sessiond` verification. Preserve all unrelated user-owned untracked files.
