# Goal Batch Lane: backend-authority

## Identity

- Batch: `activity-aware-close`
- Lane: `backend-authority`
- Repository: `/Users/ken/workspace/muxterm`
- Worktree: `/Users/ken/workspace/muxterm/.worktrees/gb-activity-aware-close-backend-authority`
- Branch: `gb/activity-aware-close/backend-authority`
- Base code SHA: `92959465fe3de790cb8b1515cca4e5b8dc6028ce`
- Target merge branch: `feat/sessiond-cli-scrollback`
- Wall-clock budget: 50 minutes; reaching it is terminal `BUDGET`, not permission to skip evidence.
- Goal-turn budget: 45 turns.

Work only in the stated worktree and branch. Do not touch the main checkout or sibling worktrees. The launch manifest pins the exact metadata-child base commit; the base code SHA above is its behaviorally identical parent. Treat the inherited design, goal files, and ignore rule as orchestration metadata, not lane output.

## Outcome

The session daemon authoritatively classifies pane activity and provides race-safe pane and workspace close transactions that immediately close proven-idle targets, require an opaque confirmation ticket for busy or unknown targets, preserve legacy force-close consumers, and compile cleanly on the supported code paths.

## Exit condition

Complete when **either** every item B1-B6 reaches a terminal state, **or** it is conclusively demonstrated that the remainder cannot, naming the blocker for each. Each item must end as `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`; `FAIL` and `BLOCKED` items are residuals, not failure of the overall goal.

Do not stop to ask the user questions. Resolve engineering choices from the design and repository evidence. If a genuinely human-owned decision prevents one item, mark only that item `PENDING-HUMAN`, continue the others, and record it in `DONE.json`.

## Fixed wire contract

The frontend lane is implementing this contract independently. Preserve these literals and semantics exactly:

- Request `close-intent`: correlated `cid`, `targetKind` (`pane` or `workspace`), `workspaceId`, and `paneId` for pane targets.
- Request `close-confirm`: correlated `cid` and opaque `ticket` only.
- Reply `close-outcome`: correlated `cid`, `closeStatus` (`closed`, `confirmation-required`, or `failed`), target identity, and when applicable `ticket`, `busyCount`, `unknownCount`, bounded `risks`, `omittedRiskCount`, `failureCode`, and user-safe `error`.
- Each risk contains `paneId`, `title`, `classification` (`busy` or `unknown`), and one stable reason: `command-active`, `foreground-process`, `custom-command`, `browser-pane`, `unsupported-shell`, `unsupported-platform`, `missing-lifecycle`, `stale-lifecycle`, `process-inspection-failed`, `pty-inspection-failed`, or `conflicting-evidence`.
- An absent target returns `closeStatus: closed`.
- Ticket invalidation reassesses and returns either a new `confirmation-required` outcome or `closed`; it never destroys a changed target.
- Pane closure broadcasts include both workspace and pane identity. Workspace closure broadcasts `workspace-closed` and then an authoritative workspace list.
- Reply and broadcast ordering is unspecified. Replies report request outcome; broadcasts remain structural authority.
- Preserve existing `close-pane`, `close-workspace`, and browser-pane force-close semantics for CLI and MCP consumers.

## Items

### B1 — Activity evidence and classification

Implement a streaming shell-lifecycle state that survives split PTY reads, retains prompt-active and command-active state for the current root-process generation, and preserves the existing shell-prompt event. Supported default interactive bash and zsh panes must receive trusted lifecycle markers without modifying user dotfiles or silently discarding normal startup behavior. Implement foreground PTY ownership for macOS and Linux with an explicit unsupported-platform fallback.

Classify in this order: a different foreground process group is busy/foreground-process; root shell foreground plus command-active is busy/command-active; root shell foreground plus valid prompt-active evidence is idle; missing, stale, custom-command, browser, unsupported, failed, or contradictory evidence is unknown. A background job after a valid returned prompt remains idle by contract.

Terminal state evidence:
- `PASS`: the bounded classifier and lifecycle integration exist, are race-safe, and compile on supported paths.
- `FAIL-named` or `BLOCKED-named`: identify the exact unsupported shell/OS/toolchain condition and preserve unknown rather than failing open.
- `PENDING-HUMAN`: only for a truly user-owned policy decision not settled by the design.

### B2 — Atomic close transactions and tickets

Implement one daemon-owned close transaction for pane and workspace intents. The idle path assesses and removes an unchanged target in the same serialized transaction. Busy or unknown returns one confirmation-required snapshot without mutation. Workspace assessment uses one membership snapshot and one modal-worth of risk data.

Tickets must be random, opaque, bounded, expiring, single-use, and server-held. Bind target kind, stable identity, target generation, assessment snapshot, and workspace membership generation. Confirmation may close only the warned snapshot. Identity or membership change invalidates the ticket and reassesses. Bound abandoned-ticket memory. Avoid registry/pane lock inversion.

Terminal state evidence follows the same four-state vocabulary and names any residual race or blocker precisely.

### B3 — Protocol, client, and browser relay

Add the fixed contract to the additive session protocol, daemon client, server dispatch, and browser relay. Preserve independent browser and daemon CID domains by mapping outcomes to the original browser CID. Produce authoritative pane/workspace broadcasts after registry mutation and before clients infer structure. Keep reply/broadcast ordering safe in either order.

Terminal state evidence must name the concrete protocol surfaces completed or blocked.

### B4 — Compatibility and invariants

Preserve explicit CLI/MCP force-close behavior, process-exit duplicate-event guards, shell-prompt consumers, scrollback behavior, and unrelated session protocol constants. Update existing fake interfaces only when compilation requires it; add no test files and no new unit-test cases. Update `AGENTS.md` with the new architectural invariant: sessiond owns activity classification and destructive close authorization; browser controls emit intents and wait for authoritative broadcasts.

Terminal state evidence must distinguish preserved compatibility from any named residual.

### B5 — Verification

Run and record fresh evidence after the final code change:

- Format all changed Go files.
- `git diff --check` exits zero.
- `go build ./...` exits zero.
- Darwin ARM64 and Linux AMD64 builds are attempted where the local toolchain permits them; a concrete environmental failure becomes a named residual, never a fabricated pass.
- No new unit tests are added.
- Review the final diff against the ownership boundary and remove debugging artifacts.

A check is `PASS` only when the exact command and observed result are recorded. Evidence predating the final change does not count.

### B6 — Commit, push, and terminal marker

Commit cohesive work early and at completion. Push the explicit lane branch to `origin`; never merge or modify the target branch. Crossing another lane's files is a defect: record the needed edit as a residual and stop at the ownership boundary.

As the final act, write `DONE.json` at the worktree root. It must be ignored by git and contain:

- `lane`: `backend-authority`
- `session_id`: this lane's own Amplifier session ID
- `verdict`: exactly `COMPLETE`, `BLOCKED`, or `PARTIAL`
- `branch`, final `head`, and boolean `pushed`
- `items`: B1-B6 with terminal state and evidence note
- `residuals`: named unresolved work
- `pending_human`: named human-owned decisions, if any
- `suite`: exact final verification summary

Do not commit `DONE.json`.

## File ownership

Exclusive existing files:

- `internal/sessiond/protocol.go`
- `internal/sessiond/pane.go`
- `internal/sessiond/registry.go`
- `internal/sessiond/workspace.go`
- `internal/sessiond/server.go`
- `internal/sessiond/client.go`
- `internal/server/daemon.go`
- `internal/server/ws.go`
- `AGENTS.md`

Exclusive new files:

- `internal/sessiond/activity.go`
- `internal/sessiond/close.go`
- `internal/sessiond/foreground_pgrp_supported.go`
- `internal/sessiond/foreground_pgrp_unsupported.go`
- `internal/sessiond/shell_integration.go` only if lifecycle installation requires it

Conditional ownership only when required by the implementation:

- `go.mod`
- `go.sum`
- `internal/server/daemon_test.go` for existing fake-interface compilation only

Do not modify `web/**`, `cmd/**`, `internal/mcp/**`, the design document, goal files, manifests, or user untracked files. Do not add unit tests.

## Scope-outs

- No exact claim about cmux internals or parity.
- No process-tree enumeration and no warning for background jobs after a valid prompt returns.
- No browser modal or frontend coordination work.
- No PR creation, target-branch merge, production soak, or unrelated refactoring.
- No weakening unknown into idle to make a check pass.

## Known facts

This section is a speed aid, not acceptance evidence.

- Baseline `go build ./...` exited zero at code SHA `92959465fe3de790cb8b1515cca4e5b8dc6028ce`.
- The daemon already owns root process, PID, PTY master, registry serialization, correlated internal requests, and broadcasts.
- Existing OSC handling recognizes only a chunk-local completion marker and does not install or retain a full lifecycle.
- Browser panes have no PTY process; custom commands are not trusted root shells.
- New unit tests are prohibited by repository policy.
