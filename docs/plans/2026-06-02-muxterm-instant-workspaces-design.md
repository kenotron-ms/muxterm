# muxterm Instant Workspaces Design

**Branch:** `feat/sessiond-persistence`
**Stack:** Lit + TypeScript frontend (`web/src/`) over a websocket to a Go `sessiond` daemon
**Date:** 2026-06-02

## Goal

Make workspace and pane mutations feel instant by introducing a generalized
optimistic-mutation seam on the store, while fixing the surrounding rough edges:

- Every workspace always has at least one terminal — never an empty "No panes" screen.
- Workspace labels are consistent and stable: lowercase `workspace N` derived from id.
- The workspace dropdown is a tight menu that updates the instant a workspace is created.

The multi-tab / multi-pane-per-workspace experience (via dockview) is explicitly
**deferred to its own design + plan cycle** — it is not part of this round.

## Chosen Approach

A focused round with **no tab bar**. The user explicitly chose to invest in a
*generalized* optimistic seam now rather than ship a one-off dropdown fix:

> "I'm sure everything will want to feel instant; pay the tax early."

This is a sanctioned product requirement ("instant feel is near-universal"), not
premature optimization. The discipline we keep in exchange: the mechanism itself
stays as small as a *correct* optimistic system can be — one `pending` set plus a
fold in the getters, leaning entirely on the idempotent reconcile the store already has.
No library, no cache, no query framework.

---

## Section 1 — Workspace Identity & Label

**Rule:** a workspace has an *optional* explicit name. By default it is **unnamed** —
we never auto-assign a name.

`workspaceLabel(ws)` (`web/src/components/workspace-picker.ts:11`) becomes:

- explicit name if set, else
- `workspace N` — **lowercase** — where **N is derived from the workspace id**
  (`w1` → "workspace 1", `w3` → "workspace 3").

Because N is id-derived, the label **never renumbers** when another workspace closes.

The status-bar chip (`status-bar.ts:101`) already imports the same helper, so chip and
dropdown stay in lockstep. This kills today's `w1` → `Workspace w1` flip.

---

## Section 2 — One Terminal Per Workspace, Restore on Switch

**Rule:** a workspace *always* has at least one terminal.

- **On create** (including the very first workspace at startup): auto-spawn exactly one
  terminal into the new workspace, then switch to it. The user lands in a live shell —
  never the "No panes" empty state.
- **On switch:** always restore that workspace's terminal (existing per-workspace
  active-pane restore via `arrangement-store`). If a workspace has **zero panes**
  (legacy-empty, or the user just closed its last pane), auto-spawn one. One rule covers
  new / legacy / just-emptied uniformly.
- The new pane must be created in the **active workspace's** context. Today's
  `createPane()` is connection-scoped, so wire "create a pane" to fire right after the
  workspace becomes active.
- The hidden `split` keyboard shortcut stays.

**Accepted consequence:** closing a workspace's last terminal respawns a fresh shell.
To remove a workspace, the user closes the **workspace** from the dropdown.

---

## Section 3 — Generalized Optimistic-Mutation Seam

This is the core architectural piece. It was reviewed by a "Crusty Old Engineer" (COE)
consult; that rationale is preserved below because it explains *why* the shape is what
it is.

### Today's state model

`MuxStore` (`web/src/state.ts`) holds **authoritative** state built by
`applySessiond(msg)`, which folds in server-**pushed** websocket echoes and reconciles
them idempotently ("actor + broadcast echoes converge to one truth"). Reactivity is
`subscribe` / `_notify`. Mutations (`createWorkspace` / `renameWorkspace` /
`closeWorkspace` / `createPane`) are fire-and-forget socket sends.

This is **push + idempotent reconcile**, *not* a React-Query pull/cache model — which is
why a query framework is the wrong tool here.

### The model: render = authoritative base + pending overlay

Add to `MuxStore`:

- A `pending` set.
- `mutate({ id, optimistic(draft), settled(base): boolean, onTimeout?() })`.

`mutate` adds the mutation to `pending`, fires `_notify()` (instant UI), and the caller
sends the socket message. The reactive getters fold each pending `optimistic()` over the
base, **recomputed every notify**. The authoritative base is **never mutated** by optimism.

- **Resolve:** after each `applySessiond`, drop any pending mutation whose `settled(base)`
  is now true (the server has caught up). The overlay vanishes with zero flicker, base
  shows through.

### Why overlay-fold, not "write into base + let reconcile converge"

**Server-assigned ids.** `createWorkspace` / `createPane` get their id *from the daemon*.
If you optimistically write a fake-id row into base and rely on idempotent reconcile, the
authoritative echo arrives with a *different* (real) id, and the dedup guard
(`some(p => p.paneId === id)`) **fails to match → you get a duplicate, not convergence**.
The fold handles the temp-id → real-id handoff cleanly. This is the *minimum that works*,
not over-engineering — and it's disqualifying for "just write into base" exactly where
instant matters most (creates).

### Settle by identity, never by population/count

Count-based settle ("the list got longer", "a name appeared") **lies under concurrency** —
two fast creates, or a second browser tab, defeat it. Split the settle strategy by who
owns the id:

- `renameWorkspace` → client knows the id → settle by **exact id predicate**
  (`find(id).name === newName`). Correlation ids here would be wasted ceremony.
- `closeWorkspace` → client knows the id → settle by **exact id predicate** (`!exists(id)`).
- `createWorkspace` / `createPane` → **server owns the id** → use a **correlation id**:
  the client mints a provisional id, sends it in the create message, and the daemon
  **echoes it back** on the resulting `WorkspaceList` / `PaneAdded`. Settle becomes exact:
  "an authoritative entity carrying my correlation id exists."

The correlation id is the **only** place that needs a protocol change. Rename/close do not.

### Failure UX — design the failure first

"Optimistic UI is a consistency decision in a latency costume." The interesting question
is not "make it fast," it's "what happens when the optimism was wrong."

- **Timeout is a mandatory backstop for protocol failure, NOT the happy path.** If you
  rely on the timeout in the normal flow, your `settled()` predicate is wrong.
- **On timeout/error: NEVER silently roll back.** Keep the row, mark it **errored**, and
  offer **retry / dismiss**. A row that silently vanishes 5s later is the worst possible
  outcome — the UI must snap to truth *loudly*, not quietly lie.

### Invariants & scope discipline

- **Route every reader through the folded getter** — including the `composition` getter at
  `state.ts:45`, which reads `_panes` directly. Otherwise you get split-brain rendering.
  Grep-audit all readers of `_panes` / `_workspaces`.
- **Optimistic shape must be byte-identical in layout to the settled shape** — same fields,
  same row height — so there is zero reflow when base shows through.
- **Scope:** route all four mutations through this one path. Do **not** promote it to a
  reusable `MutationController` framework until a 5th/6th mutation reveals what the
  abstraction actually needs.

### Prerequisites (do FIRST, as separate changes)

Base must be *honestly immutable* before optimism layers on top of it:

- **(a) Fix the in-place mutation at `state.ts:116`.** `WorkspaceRenamed` mutates a
  workspace object in place, and getters hand out arrays by reference. The "optimism never
  touches base" invariant is one we'd be *introducing*, not preserving — make updates
  immutable and stop leaking mutable refs first, or the invariant is a lie.
- **(b) Daemon: broadcast an updated workspace-list on workspace create.** This is *also*
  the current "new workspace doesn't appear in the dropdown until reload" bug. Fix it
  independently first so it is not entangled with the optimism change.

---

## Section 4 — Dropdown Visual Polish

CSS only. Builds on the already-shipped row un-nesting (`238545f`). Behavior unchanged.

- **Tight list, not cards:** drop the per-row rounded-rect border / large radius and shrink
  vertical padding/gap, so the dropdown reads as a compact menu rather than a stack of boxes.
- **One line per row:** a **check column** (✓ only on the current workspace, blank otherwise
  so labels align) + the **label** on the left; **rename ✎** and **remove ✕** pinned right,
  emphasized on row hover.
- **Fit-to-content width:** grow to the longest label, with a sensible **min-width** (never
  cramped) and a **max-width** (ellipsis past it) so a long rename can't blow out the layout.
- Keep the selected/hover tint on the active row.

---

## Suggested Phasing

Three phases, each independently shippable.

### Phase 1 — Foundations (safe, independent)
- Prerequisite (a): immutable base / fix `state.ts:116` in-place rename + stop leaking refs.
- Section 1: `workspace N` lowercase, id-derived label.
- Section 4: dropdown CSS polish.
- Prerequisite (b): daemon broadcasts workspace-list on create (fixes the dropdown-on-reload bug).

### Phase 2 — Optimistic seam + client-id mutations
- `MuxStore`: `pending` set + folded getters; route **all** readers (incl. `composition`)
  through the fold.
- `mutate({ id, optimistic, settled, onTimeout })`; settle-after-`applySessiond`; timeout backstop.
- Wire `renameWorkspace` + `closeWorkspace` (settle by exact id).
- Failure UX: errored row + retry/dismiss.

### Phase 3 — Correlation-id creates + one-terminal behavior
- Daemon: echo the client correlation id on create (`WorkspaceList` / `PaneAdded`).
- Wire `createWorkspace` + `createPane` through the seam (settle by correlation id).
- Section 2: one terminal per workspace — auto-create on create, restore/auto-spawn on switch.

---

## Future Work (explicitly deferred)

- **Tabbed / multi-pane-per-workspace experience via `dockview-core`** — the next separate
  design + plan cycle. Flagged by the user as explicitly *next*, not part of this round.
- **Promote the optimistic seam to a reusable `MutationController`** only after a 5th/6th
  mutation appears and reveals what the abstraction needs.

---

## Open Questions

- Exact daemon wire field name for the correlation id.
- Whether `createPane`'s correlation echo rides on `PaneAdded` or `Composition`.
- Precise errored-row affordance: inline retry icon vs toast.
