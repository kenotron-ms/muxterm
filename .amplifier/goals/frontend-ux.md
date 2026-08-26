# Goal Batch Lane: frontend-ux

## Identity

- Batch: `activity-aware-close`
- Lane: `frontend-ux`
- Repository: `/Users/ken/workspace/muxterm`
- Worktree: `/Users/ken/workspace/muxterm/.worktrees/gb-activity-aware-close-frontend-ux`
- Branch: `gb/activity-aware-close/frontend-ux`
- Base code SHA: `92959465fe3de790cb8b1515cca4e5b8dc6028ce`
- Target merge branch: `feat/sessiond-cli-scrollback`
- Wall-clock budget: 45 minutes; reaching it is terminal `BUDGET`, not permission to skip evidence.
- Goal-turn budget: 40 turns.

Work only in the stated worktree and branch. Do not touch the main checkout or sibling worktrees. The launch manifest pins the exact metadata-child base commit; the base code SHA above is its behaviorally identical parent. Treat inherited design, goal files, and ignore rule as orchestration metadata, not lane output.

## Outcome

The browser routes every named pane and workspace close surface through a correlated pre-removal intent, keeps targets live until daemon authority arrives, shows one accessible Cancel-default confirmation for busy or unknown activity, removes the five-second Undo close model, and passes the frontend static gates.

## Exit condition

Complete when **either** every item F1-F6 reaches a terminal state, **or** it is conclusively demonstrated that the remainder cannot, naming the blocker for each. Each item must end as `PASS`, `FAIL-named`, `BLOCKED-named`, or `PENDING-HUMAN`; `FAIL` and `BLOCKED` items are residuals, not failure of the overall goal.

Do not stop to ask the user questions. Resolve engineering choices from the design and repository evidence. If a genuinely human-owned decision prevents one item, mark only that item `PENDING-HUMAN`, continue the others, and record it in `DONE.json`.

## Fixed wire contract

The backend lane is implementing this contract independently. Preserve these literals and semantics exactly:

- Request `close-intent`: correlated `cid`, `targetKind` (`pane` or `workspace`), `workspaceId`, and `paneId` for pane targets.
- Request `close-confirm`: correlated `cid` and opaque `ticket` only.
- Reply `close-outcome`: correlated `cid`, `closeStatus` (`closed`, `confirmation-required`, or `failed`), target identity, and when applicable `ticket`, `busyCount`, `unknownCount`, bounded `risks`, `omittedRiskCount`, `failureCode`, and user-safe `error`.
- Each risk contains `paneId`, `title`, `classification` (`busy` or `unknown`), and one stable reason: `command-active`, `foreground-process`, `custom-command`, `browser-pane`, `unsupported-shell`, `unsupported-platform`, `missing-lifecycle`, `stale-lifecycle`, `process-inspection-failed`, `pty-inspection-failed`, or `conflicting-evidence`.
- An absent target returns `closeStatus: closed`.
- Ticket invalidation reassesses and returns either a new `confirmation-required` outcome or `closed`; it never destroys a changed target.
- Pane closure broadcasts include both workspace and pane identity. Workspace closure broadcasts `workspace-closed` and then an authoritative workspace list.
- Reply and broadcast ordering is unspecified. Replies report request outcome; broadcasts remain structural authority.
- Preserve legacy close constants in browser protocol typing for compatibility, but browser user controls no longer send direct destructive closes.

## Items

### F1 — Correlated browser transport

Implement typed close target, outcome, risk, reason, and status structures. Add nonzero browser CID allocation and pending request correlation. Resolve only a known `close-outcome` CID, reject pending operations on timeout/disconnect, and tolerate reply/broadcast arrival in either order. `close-confirm` sends only CID and opaque ticket. Do not remove frozen legacy constants from shared protocol vocabulary.

Terminal state evidence:
- `PASS`: the fixed contract is represented exactly and pending operations have bounded cleanup.
- `FAIL-named` or `BLOCKED-named`: name the incompatible live interface or ownership-crossing edit required.
- `PENDING-HUMAN`: only for a truly user-owned policy decision not settled by the design.

### F2 — Unified pre-removal close entry points

Route these closed, named surfaces through one app-level close-intent coordinator without local removal: Dockview tab close, middle-click, Cmd/Ctrl+W, workspace sidebar close, the existing workspace-picker event path if remounted, and mobile pane/workspace actions. Replace Dockview's default remove-first tab close with a custom intent-emitting tab renderer. Keep cards, panels, terminals, and layouts live while requests or confirmation are pending.

A repeated in-flight target is coalesced. A repeated warned target focuses its existing modal. A different target attempted while a modal is open does not stack a second dialog.

Each named surface must receive its own terminal state and named residual if it cannot be completed within owned files.

### F3 — Accessible shared confirmation

Implement one reusable native-dialog component for pane and workspace targets. Titles are `Close pane?` and `Close workspace?`; actions are Cancel and `Close Pane` or `Close Workspace`. Busy copy states that running work will terminate. Unknown copy states that activity cannot be determined and work may terminate. A bounded list names risky panes and high-level reasons.

Cancel receives initial focus. Escape and backdrop dismiss. Enter activates only the focused control and never implicitly chooses destruction. The destructive action is visually distinct using existing theme variables. Touch controls meet the existing coarse-pointer size convention. Duplicate intent can focus Cancel. Cancel sends no server mutation.

Terminal state evidence uses the four-state vocabulary and names any inaccessible or ownership-blocked behavior.

### F4 — Authority, failures, and races

Only daemon broadcasts may remove pane/workspace structure or prune terminals. `closed` completes the request but does not authorize optimistic removal. On timeout, disconnect, or failed outcome, leave the target live and show a dismissible recoverable alert. Clear matching pending modal/error state on pane-closed, workspace-closed, or an authoritative workspace list proving absence. Refresh the modal when ticket invalidation returns a new confirmation-required outcome.

Preserve workspace survivor selection and existing store/controller authority without editing their files. Name any required cross-boundary change as a residual rather than editing it.

### F5 — Remove Undo and synchronize existing verification artifacts

Remove deferred pane/workspace timers, local pending-close state, reopen/restore hooks, closing-pane bookkeeping, Undo rendering, and the dedicated Undo component. Delete only the now-unused dedicated component.

Update the two existing protocol/socket test files only enough to keep the changed public surface coherent; add no new unit tests or cases. Rewrite the existing touch close/Undo E2E artifact around activity-aware intent and confirmation semantics, without claiming it passed against the shared live service from this lane.

Terminal state evidence distinguishes source completion, static compatibility, and post-merge browser verification that remains orchestrator-owned.

### F6 — Verification, commit, push, and terminal marker

After the final code change:

- `git diff --check` exits zero.
- `cd web && npm run check:fast` exits zero with no new warnings beyond the baseline eight.
- No new unit tests are added.
- Review the final diff against ownership and remove debugging artifacts.

Record exact commands and observed output; evidence predating the final change does not count. Do not mutate or rely on the shared dev-local service at port 8313; post-merge Chromium verification belongs to the orchestrator.

Commit cohesive work early and at completion. Push the explicit lane branch to `origin`; never merge or modify the target branch. Crossing another lane's files is a defect: record the needed edit as a residual and stop at the ownership boundary.

As the final act, write ignored `DONE.json` at the worktree root with:

- `lane`: `frontend-ux`
- `session_id`: this lane's own Amplifier session ID
- `verdict`: exactly `COMPLETE`, `BLOCKED`, or `PARTIAL`
- `branch`, final `head`, and boolean `pushed`
- `items`: F1-F6 and named per-surface F2 states with terminal state and evidence note
- `residuals`
- `pending_human`
- `suite`: exact final verification summary

Do not commit `DONE.json`.

## File ownership

Exclusive production files:

- `web/src/app.ts`
- `web/src/ws.ts`
- `web/src/types.ts`
- `web/src/components/mux-dock.ts`
- `web/src/components/mux-sidebar.ts`
- `web/src/components/mux-pane-picker.ts`
- `web/src/components/close-confirmation-modal.ts` (new)
- `web/src/components/mux-undo-toast.ts` (delete)
- `web/e2e/touch-close-undo.mjs`

Existing compatibility files, edits only when required by changed public surfaces:

- `web/src/__tests__/protocol.types.test.ts`
- `web/src/__tests__/ws.sessiond.test.ts`

Do not modify `internal/**`, `cmd/**`, `web/src/state.ts`, `web/src/lib/workspace-controller.ts`, `web/src/lib/terminal-registry.ts`, `web/src/lib/keybindings.ts`, `web/src/lib/theme.ts`, `web/src/components/title-bar.ts`, `web/src/components/workspace-picker.ts`, package manifests, `AGENTS.md`, the design document, goal files, manifests, or user untracked files.

## Scope-outs

- No backend/sessiond changes and no direct force-close protocol changes.
- No exact cmux parity.
- No new unit tests or unit-test cases.
- No reactivation or redesign of the dormant workspace picker.
- No live-browser acceptance claim from the lane.
- No PR creation, target-branch merge, production soak, or unrelated refactoring.

## Known facts

This section is a speed aid, not acceptance evidence.

- Baseline frontend check exited zero with zero errors and eight warnings at code SHA `92959465fe3de790cb8b1515cca4e5b8dc6028ce`.
- Current pane and workspace close flows remove or dim locally, wait five seconds, then send unconditional destructive closes.
- The default Dockview tab renderer removes before emitting; a custom renderer is required for pre-removal intent.
- Authoritative pane/workspace state already flows from daemon broadcasts through the store and workspace controller.
- Browser CID correlation does not yet exist for close requests.
- New unit tests are prohibited by repository policy.
