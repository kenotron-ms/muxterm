# muxterm Workspace — Phase 3: Dead-code Purge Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Delete the orphaned tmux-era component/lib cluster and surgically remove the stale tmux message paths, leaving the live workspace UI and the Go daemon untouched and fully green.

**Architecture:** This is **Phase 3 of 3** (Phases 1 & 2 — switcher, app-menu, terminology renames — are DONE). It is a *removal-only* phase. There are no new features and therefore no new feature-tests: the "test" for each batch is the **GREEN GATE** (`tsc --noEmit` + `vite build` + `npm test` + `go test ./...`) plus a grep proving no surviving file imports a deleted symbol. The deletion set is determined by **reachability from `app.ts`**, verified with search tools — never by trusting a hand-written list.

**Tech Stack:** Lit + TypeScript web UI (`web/src/`), Vitest test runner, built with Vite + `tsc --noEmit`. Backed by a Go `sessiond` daemon (`go test ./...` from repo root). Branch: `feat/sessiond-persistence`.

---

## Orientation for the implementer (read this first)

You know nothing about this codebase. Here is everything you need:

- **All commands run from the repo root** `/home/ken/workspace/muxterm` unless a step says `cd web`.
- **The web app lives in** `web/src/`. The entry point is `web/src/app.ts`. Everything the live UI uses is reachable by following `import` statements out of `app.ts`. Anything NOT reachable from `app.ts` is dead.
- **Tests live in two places** (this matters — when you delete a `.ts` you MUST delete its test in the *same batch*, or `tsc` will fail on the orphaned test):
  - co-located: e.g. `web/src/components/region.test.ts`, `web/src/lib/workspace.test.ts`
  - centralized: `web/src/__tests__/` (e.g. `web/src/__tests__/tab-bar.test.ts`)
- **Why delete the test in the same batch:** `npm run build` runs `tsc --noEmit` over ALL files in `src/`, including `.test.ts` files. If `region.ts` is gone but `region.test.ts` remains, `tsc` errors on the missing import. Always remove a file and its test together.
- **The GREEN GATE** (run exactly this after every batch):
  ```
  cd web && npx tsc --noEmit && npx vite build && npm test
  ```
  then, from the repo root:
  ```
  go test ./...
  ```
  `npm test` is `vitest run` (see `web/package.json`). Expected healthy output: `tsc` prints nothing and exits 0; `vite build` ends with `✓ built in …`; `vitest` ends with `Test Files  N passed`; `go test` prints `ok` lines and no `FAIL`.
- **If a gate fails because a surviving LIVE file still references a symbol you removed: STOP. Revert that batch with `git checkout -- .` (or `git restore .`). Do NOT force, do NOT patch the live file to make it compile.** Removal must never change live behavior.
- **Do NOT `git push`, open a PR, or merge.** Commit locally only.
- **Commit message footer** — every commit message in this plan ends with this footer (blank line, then):
  ```

  🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

  Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
  ```

### The verified-dead cluster (already confirmed during planning — Task 1 re-proves it)

Component files + their tests:

| Source file | Test file(s) to delete with it |
| --- | --- |
| `web/src/components/tab-bar.ts` | `web/src/__tests__/tab-bar.test.ts` |
| `web/src/components/workspace.ts` | `web/src/components/workspace.test.ts`, `web/src/__tests__/workspace-popout.test.ts` |
| `web/src/components/region.ts` | `web/src/components/region.test.ts`, `web/src/__tests__/region.test.ts` |
| `web/src/components/region-tabstrip.ts` | `web/src/__tests__/region-tabstrip.test.ts` |
| `web/src/components/region-divider.ts` | `web/src/components/region-divider.test.ts` |
| `web/src/components/region-menu.ts` | `web/src/__tests__/region-menu.test.ts` |
| `web/src/components/resize-handle.ts` | `web/src/__tests__/resize-handle.test.ts` |
| `web/src/components/layout.ts` | `web/src/__tests__/layout-component.test.ts` |

Lib files + their tests:

| Source file | Test file(s) to delete with it |
| --- | --- |
| `web/src/lib/workspace.ts` | `web/src/lib/workspace.test.ts` |
| `web/src/lib/cell-budget.ts` | `web/src/lib/cell-budget.test.ts` |
| `web/src/lib/resize-coalescer.ts` | `web/src/lib/resize-coalescer.test.ts` |
| `web/src/lib/popout.ts` | `web/src/__tests__/popout.test.ts` |
| `web/src/lib/layout-parser.ts` | `web/src/__tests__/layout-parser.test.ts` |

### MUST NOT DELETE (these LOOK related but are LIVE — leave them alone)

- `web/src/lib/snapshot.ts` — LIVE. `serializeSnapshot` is imported by `web/src/lib/terminal-registry.ts`, which `app.ts` imports.
- `web/src/lib/layout.ts` — LIVE (NOT the same as the dead `components/layout.ts`). Imported by `app.ts` (`./lib/layout.js`), `state.ts`, `composition.ts`, `workspace-controller.ts`, `arrangement-store.ts`.
- `web/src/components/launcher-menu.ts` — LIVE (edited in Phase 2).
- `web/src/lib/workspace-controller.ts`, `web/src/lib/workspace-mru.ts`, `web/src/lib/workspace-recovery.ts`, `web/src/lib/arrangement-store.ts` — all LIVE.
- The `web/src/__tests__/layout.test.ts` and `web/src/__tests__/arrangement-store.test.ts` files — they import the LIVE `lib/layout.ts`. Keep them.

### Important reality about the surgical removal (Task 6)

The legacy tmux `ServerMessage` / `ClientMessage` types and their `normalizeMessage` / `applyMessage` / `encodeClientMessage` functions are **still wired into live code today**: `ws.ts`'s `onmessage` calls `normalizeMessage(...)` then `store.applyMessage(...)`. That means by the strict "reachable from `app.ts`" rule, they are **technically LIVE**, not orphaned. Removing them cleanly is a *coordinated* change across `ws.ts`, `state.ts`, `types.ts`, and several test files — not a simple delete. Task 6 handles this carefully, verify-first, behind the gate, with a hard revert valve. The file-deletion wins in Tasks 2–5 stand on their own even if Task 6 has to be deferred.

---

## Task 1: Re-prove the dead cluster is unreachable from `app.ts`

This task writes no code and deletes nothing. It produces the **verified delete list** by proving zero LIVE (non-test) files import each candidate.

**Files:** none modified.

**Step 1: Confirm what `app.ts` imports (the live roots)**

Run:
```
cd web && grep -nE "^import|from '" src/app.ts
```
Expected: imports of `state`, `lib/icons`, `ws`, `lib/terminal-registry`, `lib/config`, `lib/keybindings`, `lib/theme`, `lib/layout`, `lib/workspace-controller`, and side-effect element imports `title-bar`, `status-bar`, `pane`, `composition`, `workspace-picker`, `reconnect-overlay`, plus a type import from `launcher-menu`. Confirm **none** of these is a candidate-for-deletion file. (Note: it imports `./lib/layout.js`, the LIVE lib — NOT `components/layout.ts`.)

**Step 2: Prove each candidate has zero LIVE importers**

Run this exact loop from the `web/` directory:
```
cd web && for f in components/tab-bar components/workspace lib/workspace \
  components/region components/region-tabstrip components/region-divider \
  components/region-menu components/resize-handle components/layout \
  lib/cell-budget lib/resize-coalescer lib/popout lib/layout-parser; do
  base=$(basename "$f");
  echo "== $f ==";
  grep -rEn "from ['\"].*/${base}(\.js)?['\"]|import ['\"].*/${base}(\.js)?['\"]" src --include=*.ts \
    | grep -v "\.test\." | grep -v "/${base}\.ts:";
done
```
Expected output: every importer printed under each `== … ==` header is **itself a member of the candidate cluster** (e.g. `components/workspace.ts` imports `region`, `region-divider`, `cell-budget`, etc.; `components/region.ts` imports `region-tabstrip` and `layout`; `region-tabstrip.ts` imports `region-menu`; `components/layout.ts` imports `resize-handle` and `layout-parser`; `resize-coalescer.ts` imports `cell-budget`). The ONLY header that lists files OUTSIDE the cluster is `components/layout` — and those outside hits all reference `./lib/layout.js` / `../lib/layout.js` (the **LIVE** lib, a different file), never `components/layout.ts`. **No live, non-cluster file imports any candidate.**

**Step 3: Confirm the keep-list is genuinely live (sanity check)**

Run:
```
cd web && grep -rn "snapshot" src/lib/terminal-registry.ts && grep -rn "lib/layout.js" src/app.ts
```
Expected: `terminal-registry.ts` imports `serializeSnapshot` from `./snapshot.js` (so `lib/snapshot.ts` stays), and `app.ts` imports from `./lib/layout.js` (so `lib/layout.ts` stays).

**Step 4: Record the verified delete list**

The greps above confirm the two tables in the Orientation section are exactly correct and complete. No edits to the list are needed. Proceed to deletion.

**Step 5: No commit** — this task produced only verification output.

---

## Task 2: Establish the baseline green gate (before any deletion)

You must know the gate is green *before* you start, so any later failure is unambiguously yours.

**Files:** none.

**Step 1: Run the web gate**

Run:
```
cd web && npx tsc --noEmit && npx vite build && npm test
```
Expected: `tsc` exits 0 with no output; `vite build` ends `✓ built in …`; `vitest` ends `Test Files  N passed` / `Tests  M passed` with **no failures**. Record the numbers N and M.

**Step 2: Run the Go gate**

Run from the repo root:
```
go test ./...
```
Expected: only `ok …` and/or `no test files` lines, **no `FAIL`**.

**Step 3: No commit** — baseline only. If either gate is already red, STOP and report; do not start deleting on top of a red baseline.

---

## Task 3: Delete the verified-dead component cluster (+ their tests)

Delete all eight component source files and their test files in **one batch** so their intra-cluster imports vanish together.

**Files:**
- Delete: `web/src/components/tab-bar.ts`, `web/src/components/workspace.ts`, `web/src/components/region.ts`, `web/src/components/region-tabstrip.ts`, `web/src/components/region-divider.ts`, `web/src/components/region-menu.ts`, `web/src/components/resize-handle.ts`, `web/src/components/layout.ts`
- Delete (tests): `web/src/__tests__/tab-bar.test.ts`, `web/src/components/workspace.test.ts`, `web/src/__tests__/workspace-popout.test.ts`, `web/src/components/region.test.ts`, `web/src/__tests__/region.test.ts`, `web/src/__tests__/region-tabstrip.test.ts`, `web/src/components/region-divider.test.ts`, `web/src/__tests__/region-menu.test.ts`, `web/src/__tests__/resize-handle.test.ts`, `web/src/__tests__/layout-component.test.ts`

**Step 1: `git rm` the component sources and their tests**

Run (from repo root, one command):
```
git rm \
  web/src/components/tab-bar.ts \
  web/src/components/workspace.ts \
  web/src/components/region.ts \
  web/src/components/region-tabstrip.ts \
  web/src/components/region-divider.ts \
  web/src/components/region-menu.ts \
  web/src/components/resize-handle.ts \
  web/src/components/layout.ts \
  web/src/__tests__/tab-bar.test.ts \
  web/src/components/workspace.test.ts \
  web/src/__tests__/workspace-popout.test.ts \
  web/src/components/region.test.ts \
  web/src/__tests__/region.test.ts \
  web/src/__tests__/region-tabstrip.test.ts \
  web/src/components/region-divider.test.ts \
  web/src/__tests__/region-menu.test.ts \
  web/src/__tests__/resize-handle.test.ts \
  web/src/__tests__/layout-component.test.ts
```
Expected: 18 `rm '…'` lines, no errors.

**Step 2: Prove nothing surviving imports a deleted component**

Run:
```
cd web && grep -rnE "tab-bar|/workspace\.js|/region(\.js|-tabstrip|-divider|-menu)|resize-handle|components/layout" src --include=*.ts | grep -v "lib/layout"
```
Expected: **no output** (empty). Any hit means a surviving file still references a deleted file — if so, STOP and inspect; if it is a LIVE file, run `git restore --staged . && git checkout -- .` to revert the whole batch.

**Step 3: Run the web gate**

Run:
```
cd web && npx tsc --noEmit && npx vite build && npm test
```
Expected: `tsc` exits 0; `vite build` `✓ built in …`; `vitest` `Test Files` count dropped by the number of deleted test files but still **all passed**, zero failures. If `tsc` reports a missing-module error from a `.test.ts` you forgot, delete that test and re-run. If a LIVE file errors, **STOP and revert the batch** (`git checkout -- . && git restore --staged .`).

**Step 4: Run the Go gate**

Run from repo root:
```
go test ./...
```
Expected: `ok` / `no test files`, no `FAIL`. (Deleting web files cannot affect Go; this just confirms nothing weird happened.)

**Step 5: Commit**

Run:
```
git commit -m "chore(web): remove dead tmux region/workspace components

Delete the orphaned tmux-era component cluster (tab-bar, workspace,
region, region-tabstrip, region-divider, region-menu, resize-handle,
old components/layout) and their tests. Verified unreachable from
app.ts; tsc/vite/vitest and go test all green.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```
Expected: a commit is created listing 18 deletions.

---

## Task 4: Delete the verified-dead lib cluster (+ their tests)

With the component cluster gone, these libs now have zero importers at all. Delete them in one batch.

**Files:**
- Delete: `web/src/lib/workspace.ts`, `web/src/lib/cell-budget.ts`, `web/src/lib/resize-coalescer.ts`, `web/src/lib/popout.ts`, `web/src/lib/layout-parser.ts`
- Delete (tests): `web/src/lib/workspace.test.ts`, `web/src/lib/cell-budget.test.ts`, `web/src/lib/resize-coalescer.test.ts`, `web/src/__tests__/popout.test.ts`, `web/src/__tests__/layout-parser.test.ts`

**Step 1: Re-prove these libs are now unimported**

Run:
```
cd web && for base in workspace cell-budget resize-coalescer popout layout-parser; do
  echo "== lib/$base ==";
  grep -rEn "from ['\"].*/${base}(\.js)?['\"]" src --include=*.ts \
    | grep -v "\.test\." | grep -v "lib/${base}\.ts:" | grep -v "workspace-";
done
```
Expected: **no importer lines** under any header. (The `grep -v "workspace-"` guard prevents false matches on the LIVE `workspace-controller` / `workspace-mru` / `workspace-recovery`; if you see any of those, they are NOT the file being deleted — `lib/workspace.ts` is the bare `workspace` module only.) If any real importer appears, STOP and inspect before deleting.

**Step 2: `git rm` the lib sources and their tests**

Run (from repo root):
```
git rm \
  web/src/lib/workspace.ts \
  web/src/lib/cell-budget.ts \
  web/src/lib/resize-coalescer.ts \
  web/src/lib/popout.ts \
  web/src/lib/layout-parser.ts \
  web/src/lib/workspace.test.ts \
  web/src/lib/cell-budget.test.ts \
  web/src/lib/resize-coalescer.test.ts \
  web/src/__tests__/popout.test.ts \
  web/src/__tests__/layout-parser.test.ts
```
Expected: 10 `rm '…'` lines, no errors.

**Step 3: Confirm the keep-list survived**

Run:
```
ls web/src/lib/snapshot.ts web/src/lib/layout.ts web/src/lib/workspace-controller.ts web/src/lib/arrangement-store.ts
```
Expected: all four paths listed (still present). If any is missing, you deleted the wrong file — `git checkout -- .` and re-do Step 2 carefully.

**Step 4: Run the web gate**

Run:
```
cd web && npx tsc --noEmit && npx vite build && npm test
```
Expected: `tsc` exits 0; `vite build` `✓ built in …`; `vitest` all passed (Test Files count dropped again). If a LIVE file errors, **STOP and revert the batch** (`git checkout -- . && git restore --staged .`).

**Step 5: Run the Go gate**

Run from repo root:
```
go test ./...
```
Expected: `ok` / `no test files`, no `FAIL`.

**Step 6: Commit**

Run:
```
git commit -m "chore(web): remove dead tmux layout/popout lib cluster

Delete the now-orphaned libs (workspace, cell-budget, resize-coalescer,
popout, layout-parser) and their tests. Zero importers after the
component-cluster removal; full gate green. snapshot.ts and lib/layout.ts
deliberately retained (LIVE).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```
Expected: a commit listing 10 deletions.

---

## Task 5: Checkpoint — confirm the cluster is fully gone and the gate is green

A cheap regression net before tackling the riskier surgical removal.

**Files:** none.

**Step 1: Prove no trace of the deleted cluster remains in source**

Run:
```
cd web && grep -rnE "mux-region|mux-tab-bar|mux-resize-handle|mux-workspace\b|PopoutManager|CellBudgetManager|ResizeCoalescer|parseLayout" src --include=*.ts | grep -v "workspace-picker"
```
Expected: **no output**. (`mux-workspace-picker` is LIVE and excluded by the `grep -v`.) Any hit is a leftover reference — investigate before continuing.

**Step 2: Full gate**

Run:
```
cd web && npx tsc --noEmit && npx vite build && npm test
```
then from repo root:
```
go test ./...
```
Expected: all green. Record the new `Test Files N passed` number.

**Step 3: No commit** — checkpoint only.

---

## Task 6: Surgically remove the stale tmux message path (verify-first, revert on any live breakage)

**Read this whole task before touching anything.** Unlike Tasks 3–4, the tmux `ServerMessage` / `ClientMessage` types are **still wired into live code**: `ws.ts` `onmessage` calls `normalizeMessage()` → `store.applyMessage()`. So this is a coordinated removal across `ws.ts`, `state.ts`, `types.ts`, plus their tests — not a delete. The user granted full authority to remove the tmux path, but the **hard rule still holds: the GREEN GATE must stay green. If you cannot get it green within this batch, revert the entire batch and report — the wins from Tasks 3–4 remain committed.**

**Files (all modified or have tests removed):**
- Modify: `web/src/ws.ts` (remove `normalizeMessage`, the `Server*`/`normalize*` helpers, `encodeClientMessage`, `sendControl`, and the `onmessage` calls into them — keep the sessiond path, the binary pane frame path, and reconnect logic)
- Modify: `web/src/state.ts` (remove `applyMessage`, `_reconcileFromTmux`, `_sessionList`/`sessionList`, the legacy `TmuxState` fields if unused — keep `applySessiond`, `composition`, workspace getters, config, subscribe/notify)
- Modify: `web/src/types.ts` (remove the tmux `ServerMessage` / `ClientMessage` unions, `SessionInfo`, and the `Window`/`Session`/`Pane`/`TmuxState`/`Layout*` types **only if** nothing live still uses them — keep the entire `Sessiond*` block, `encodePaneFrame`/`decodePaneFrame`, `SurfaceKind`/`isTerminalSurface`)
- Delete (tests tied to the removed tmux path): determined in Step 2 below — likely `web/src/__tests__/state.test.ts`, `web/src/__tests__/state.session.test.ts`, `web/src/__tests__/ws.test.ts`, `web/src/__tests__/ws.session.test.ts`, `web/src/__tests__/layout.test.ts`, `web/src/__tests__/protocol.types.test.ts` — **only those that exclusively exercise the removed tmux path.** Keep `app.sessiond`, `ws.sessiond`, `state.workspace`, `terminal-registry*` tests.

**Step 1: Map every live consumer of each tmux symbol (LSP, authoritative)**

For each symbol, find references and note which references are LIVE (non-`.test.ts`) vs test-only. Use the LSP `findReferences` operation on each of these declarations in `web/src/types.ts` / `web/src/state.ts` / `web/src/ws.ts`:
`ServerMessage`, `ClientMessage`, `SessionInfo`, `TmuxState`, `Window`, `Session`, `Pane`, `LayoutNode`, `LayoutLeaf`, `LayoutSplit`, `normalizeMessage`, `encodeClientMessage`, `applyMessage`, `sessionList`.

Also run the quick grep cross-check:
```
cd web && grep -rnE "ServerMessage|ClientMessage|\bSessionInfo\b|\bTmuxState\b|applyMessage|normalizeMessage|encodeClientMessage|\bsessionList\b" src --include=*.ts | grep -v "\.test\."
```
Expected LIVE hits at this point: `ws.ts` (declares/uses `normalizeMessage`, `encodeClientMessage`, `applyMessage` call, `ServerMessage`/`ClientMessage` imports), `state.ts` (declares `applyMessage`, imports `ServerMessage`/`TmuxState`/`SessionInfo`, uses `TmuxState` for `_state`), and `types.ts` (declarations). **Record exactly which live lines reference each symbol** — this is your removal checklist.

**Decision gate:** If a symbol is referenced ONLY by `ws.ts` `onmessage`/`sendControl`, `state.ts` `applyMessage`/`_reconcileFromTmux`, `types.ts`, and `.test.ts` files, it is part of the legacy tmux path and is safe to remove together. If a symbol is *also* referenced by `app.ts`, `terminal-registry.ts`, `composition.ts`, `pane.ts`, or any other live component, it is **NOT** purely tmux — leave that symbol in place. Note especially: `TmuxState` backs `store.state`/`createInitialState`; verify whether any live component reads `store.state` before removing `TmuxState`. If unsure, keep it (YAGNI cuts both ways — don't break live code to delete a type).

**Step 2: Identify the tests that exercise ONLY the removed path**

For each test file flagged in Step 1's grep, open it and decide: does it test the legacy tmux `applyMessage`/`normalizeMessage`/`encodeClientMessage` behavior exclusively? List those for deletion. Do **not** delete a test that also covers retained behavior (e.g. sessiond, reconnect, binary frames). Run:
```
cd web && grep -rln "applyMessage\|normalizeMessage\|encodeClientMessage\|ServerMessage\|ClientMessage" src/__tests__ --include=*.test.ts
```
and inspect each hit to classify it. Produce the exact delete-list before editing.

**Step 3: Remove the tmux call sites in `ws.ts`**

In `web/src/ws.ts` `onmessage`, remove the `normalizeMessage(raw)` call and the `this._store.applyMessage(msg)` block (the sessiond routing via `this.onSessiondMessage` and the binary pane-frame path stay). Then delete the now-unused `normalizeMessage` function, the `ServerPane`/`ServerWindow`/`ServerSession`/`ServerTmuxState` interfaces, `parseTmuxId`/`normalizePane`/`normalizeWindow`/`normalizeSession`, `encodeClientMessage`, and `sendControl` **only if Step 1 proved they are not used by any live file**. Remove the corresponding imports (`ServerMessage`, `ClientMessage`, `TmuxState`, `Window`, `Pane`, `Session`) from the top of `ws.ts`. Keep `SessiondType`, `encodePaneFrame`, `decodePaneFrame`, `SessiondMessage`, reconnect/backoff logic, and all sessiond senders.

**Step 4: Remove the tmux path in `state.ts`**

In `web/src/state.ts`, remove `applyMessage`, `_reconcileFromTmux`, `_sessionList` + the `sessionList` getter, and the `ServerMessage`/`SessionInfo` imports — **only the symbols Step 1 proved are legacy-only.** Keep `applySessiond`, `composition`, `workspaces`/`attached`/`panes` getters, `setActivePane`, `setConfig`/`config`, `subscribe`/`_notify`. If `TmuxState`/`createInitialState`/`_state`/`state` are still read by a live file (check Step 1), **keep them**; otherwise remove them too.

**Step 5: Remove the now-dead types in `types.ts`**

In `web/src/types.ts`, remove the `ServerMessage` and `ClientMessage` unions, `SessionInfo`, and any of `Window`/`Session`/`Pane`/`TmuxState`/`LayoutNode`/`LayoutLeaf`/`LayoutSplit`/`SplitDirection`/`MuxStoreEvents` that Step 1 proved have zero live references. **Keep** the entire `// sessiond v1 control protocol` block (`SessiondType`, `SessiondErrorCode`, `SessiondWorkspaceInfo`, `SessiondPaneInfo`, `SessiondMessage`, value/type exports), `encodePaneFrame`/`decodePaneFrame`, and `SurfaceKind`/`isTerminalSurface`.

**Step 6: Delete the tmux-only tests identified in Step 2**

Run `git rm` on exactly the test files you classified as legacy-tmux-only in Step 2. (Do not guess — use your Step 2 list.) Example shape (adjust to your actual list):
```
git rm web/src/__tests__/state.test.ts web/src/__tests__/state.session.test.ts \
       web/src/__tests__/ws.test.ts web/src/__tests__/ws.session.test.ts \
       web/src/__tests__/protocol.types.test.ts web/src/__tests__/layout.test.ts
```
Only include a file if Step 2 proved it is tmux-path-only.

**Step 7: Prove no tmux symbol remains referenced anywhere**

Run:
```
cd web && grep -rnE "ServerMessage|ClientMessage|\bSessionInfo\b|normalizeMessage|encodeClientMessage|applyMessage\b" src --include=*.ts
```
Expected: **no output**. Any remaining hit means either a leftover reference (fix by removing it if it's in code you're editing) or a live consumer you missed (in which case that symbol was NOT tmux-only — **STOP and revert the batch**).

**Step 8: Run the web gate**

Run:
```
cd web && npx tsc --noEmit && npx vite build && npm test
```
Expected: `tsc` exits 0; `vite build` `✓ built in …`; `vitest` all passed. **If `tsc` reports that a LIVE file still needs a symbol you removed, that symbol was not tmux-only: run `git checkout -- . && git restore --staged .` to revert the ENTIRE Task 6 batch, then report that the surgical removal must be deferred (Tasks 3–4 remain committed and green).** Do not patch live files to compile around a missing type.

**Step 9: Run the Go gate**

Run from repo root:
```
go test ./...
```
Expected: `ok` / `no test files`, no `FAIL`. The Go daemon protocol is unchanged by this round, so this must stay green.

**Step 10: Commit**

Run:
```
git commit -m "chore(web): remove legacy tmux message types and wire path

Drop the dead tmux ServerMessage/ClientMessage unions and the
normalizeMessage/applyMessage/encodeClientMessage path from ws.ts,
state.ts, and types.ts (sessiond is the only live protocol). Remove the
tmux-only tests. Full gate green; Go suite untouched and green.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```
Expected: a commit with the `ws.ts`/`state.ts`/`types.ts` edits and the deleted tmux tests.

---

## Task 7: Final full-gate verification

The hard acceptance gate for the entire phase.

**Files:** none.

**Step 1: Clean web build + type-check + tests**

Run:
```
cd web && npx tsc --noEmit && npx vite build && npm test
```
Expected: `tsc` prints nothing and exits 0 (**zero errors**); `vite build` ends `✓ built in …` (**clean**); `vitest` ends `Test Files  N passed` / `Tests  M passed` with **zero failures** (N is lower than the Phase-2 baseline by exactly the number of deleted dead-test files — no LIVE test lost).

**Step 2: Go suite**

Run from repo root:
```
go test ./...
```
Expected: only `ok …` / `no test files` lines, **no `FAIL`**. The Go suite is untouched and green.

**Step 3: Confirm the working tree is clean and all batches committed**

Run:
```
git status --short && git log --oneline -4
```
Expected: no uncommitted source changes from this phase (the design/plan docs may show as untracked — leave them), and the recent commits show the dead-code-purge commits from Tasks 3, 4, and (if it landed) 6.

**Step 4: No commit** — verification only. Phase 3 is complete when both gates are green and nothing reachable from `app.ts` broke.

---

## Done criteria (all must hold)

- The verified-dead component cluster (Task 3) and lib cluster (Task 4) are deleted, each behind a green gate and committed.
- `lib/snapshot.ts`, `lib/layout.ts`, `launcher-menu.ts`, and the `workspace-controller`/`-mru`/`-recovery`/`arrangement-store` libs are **retained** and live.
- The legacy tmux message path is removed (Task 6) **or** cleanly deferred via full revert if it could not stay green — never half-removed.
- Final gate (Task 7): `tsc --noEmit` clean, `vite build` clean, `npm test` all passed, `go test ./...` all green.
- No `git push`, PR, or merge was performed.
