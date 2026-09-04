# Lane C — The home view (Start card, tiles/cards, dock tab state)

## Outcome

muxterm gains a **home view**: the surface a human lands on to see which
Amplifier sessions want them, before picking a workspace to work in.

Two deliverables, and the second one is what the user will actually look at
first thing in the morning:

1. **In-app**: sidebar Start card + home view wired into `<mux-app>`, behind the
   real component tree.
2. **A standalone static demo** that renders the home view from fixtures with
   **no daemon and no WebSocket** — buildable by vite, servable as plain files.
   This is the preview the user clicks. It must work opened cold.

## The design is locked — build what the mockup shows

`.scratch/cos-pitch/v9/index.html` is the **authority** on layout, spacing,
colour, copy, and the two view modes. Read it before writing any code.
`v8/index.html` shows the sidebar Start card and workspace badges in more
detail. Match them; do not redesign. Where the mockup and this document
disagree, the mockup wins on visuals and this document wins on behaviour.

Reuse muxterm's existing theme tokens (`--mux-*`) rather than hard-coding the
mockup's hex values — the mockup was written standalone and does not know about
the palette system. Verify against the `tokyo-night` palette the user runs.

## ⛔ HARD SAFETY CONSTRAINT — read before running anything

A human is **using a live muxterm right now** to talk to the orchestrator, at
`muxterm serve --addr 127.0.0.1:9090` on the default sessiond socket, behind
Caddy at https://muxterm.ampbox.io. A `python3 -m http.server 8477` serves
design mockups.

- **NEVER** `pkill muxterm`, `pkill sessiond`, `killall`, or any broad kill.
- **NEVER** touch port 9090, port 8477, or the default socket.
- **DO NOT run `make dev-local`** — single fixed port, shared runtime dir,
  sibling lanes running concurrently. The orchestrator owns it.
- `npx vite build` is fine — it writes files and exits. **Do not** start
  `vite --watch`, a dev server, or any other background process.
- Only ever stop a process **your own lane started**, by a PID you recorded.

## Working agreement

- Working directory: `/home/ken/workspace/muxterm-hv-worktrees/hv-c-frontend-home`
- Branch: `goal/hv-c-frontend-home`
- Base SHA pinned by the launcher. Work ONLY here. Do not touch the main
  checkout or a sibling worktree.
- **Never merge to main.** Push your branch; the orchestrator merges.
- **Commit early, push always.**

## Files you own

- `web/**` — all of it, including the pre-committed `web/src/lib/session-state.ts`
- `internal/config/config.go` and `web/src/lib/config.ts` — **only** for the
  keybinding and any sidebar rail entry

**You do NOT own:** `cmd/muxterm/**` (Lane A), `internal/sessiond/**` and
`internal/server/**` and `modules/**` (Lane B). Need something there? Record it
in `residuals[]` and continue.

## Build against fixtures — the backend does not exist yet

`web/src/lib/session-state.ts` is committed to your base and already gives you
everything: the `SessionState` interface, `SessionRunState`, `WaitingFor`,
`SessionMode`, `HOME_GROUPS`, `groupFor()`, `needsInput()`, `needsInputCount()`,
`needsInputByWorkspace()`, `shortProject()`, and `FIXTURE_SESSIONS`.

Lane B is building the daemon-side producer **right now**, to that same
contract. Treat the interface as frozen. Render from a data source you can swap:
fixtures today, a live subscription later. Keep the seam obvious and note it in
DONE.json so wiring is a small job rather than a rewrite.

## What to build

### Sidebar Start card

Top of `mux-sidebar`, above the workspace cards. Shows the **Needs input**
count. Clicking it returns to home from anywhere. Grey and calm at zero —
nothing pulses, nothing is orange when there is nothing to do. Design the zero
state deliberately; it is the state the user wants to reach.

### Sidebar workspace badges

Each existing workspace card gains a needs-input badge. **The Start card count
must be exactly the sum of the badges** — derive both from
`needsInputByWorkspace()` so they cannot disagree. Show a plain pane count, not
a zero badge, when a workspace wants nothing.

### Home view

Takes the **whole right side** when no workspace is selected. **No title bar** —
content starts at the top edge; the sidebar already says where you are.

Sections in this order, using these exact words: **Needs input**, **Working**,
**Ready for review**, **Completed**. They come from Claude Code's agent view and
users already know them. `groupFor()` implements the placement, including the
deliberate non-1:1 mapping (an open PR wins; Completed merges done/failed/
stopped).

### Tiles / Cards toggle

Segmented control at the **top right of the first section heading's line** — see
the mockup. Applies to the whole view. **Persists** across reloads
(localStorage is fine; say which you chose).

- **Cards** — the ask written out, with inline action buttons. Buttons may be
  non-functional in this lane (they need Lane A's `muxterm pane send`); render
  them and wire them to a clearly-marked stub. Record it as a residual.
- **Tiles** — a grid of terminal-preview thumbnails with a small status header
  and footer. Needs-input tiles keep their two action buttons; working tiles get
  none.

For tiles, **reuse the existing preview machinery** rather than inventing one:
`web/src/lib/preview-tile.ts` (`cropToTile`, `tileFromLines`, `sanitizeChar`,
`tileHash` — all pure, no DOM) and `preview-canvas.ts` (`renderTile`). ⚠ The
server currently emits **one tile per workspace**, not per pane, so live
per-pane tiles are not available yet — that is Lane B/orchestrator work. For
this lane, render tiles from fixture text. Note it as a residual.

### Dock pane tab state

Extend the existing bell-dot machinery to show per-session state on pane tabs:
`mux-dock.ts:380-397` (`_refreshBellTitles`), `726-736`, CSS at `617-620`
(`--mux-bell`). This is why the home view needs no list for the workspace you
are already looking at.

### `ctrl+`` toggles home

Backtick is bound to **nothing** today — verified in `config.go` and
`web/src`. muxterm's convention is `ctrl+shift+<key>` and `] \ m o p a` are
taken; the config lives in `KeysConfig` (config.go:262) and `config.ts:128`.

⚠ **Do not use `ctrl+s` — that is XOFF and freezes terminals.**

Backtick is a printable character, so muxterm must intercept `ctrl+`` before
xterm.js sees it, **while a bare backtick still types a backtick in a shell.**
Test that specific case and say so in DONE.json — it is cheap to verify and
embarrassing to miss.

Also add in-view keys since the home view is not a terminal: `j`/`k` to move,
`Space` to peek, `Enter` to open that pane, `Esc` to dismiss.

### ⚠ Do NOT unmount `<mux-dock>`

Hide it. Unmounting risks dockview's layout persistence and silently downgrades
the attached workspace's live-colour preview to the monochrome server tile,
because `terminalRegistry.previewRegion` requires `entry.opened`
(`terminal-registry.ts:1266`). The seam is the `.main-pane` branch at
`app.ts:959-985`. A view inside `.main-pane` is free; replacing `.content-area`
would need `_destroySplit` sequencing — avoid that.

### The standalone demo

A vite entry that mounts the home view with `FIXTURE_SESSIONS` and **no
backend** — no WebSocket, no daemon, no `mux-app`. Output plain static files
under `web/dist/` (or a sibling) that work when opened from a static server.

Build it with `npx vite build` and **confirm the built output actually renders**
by checking the emitted HTML/JS exists and references your component. Put the
exact build command and output path in DONE.json — the orchestrator will serve
it over a tunnel for the user to click.

Include **both** view modes and a visible way to switch, plus the zero state.

## Verification

⛔ **AGENTS.md bans unit tests. Do not add `*.test.ts`.** Not for `groupFor`,
not for the counter. If an existing test breaks, fix it to match.

`playwright-cli` is **not installed on this host**, so browser automation is
unavailable to you. Do this instead:

1. `cd web && npm run check:fast` — **0 errors required.** Baseline today is
   8 warnings / 0 errors; do not add errors.
2. `go build ./...` clean (you touch `config.go`).
3. `npx vite build` succeeds; the demo output exists on disk.
4. Describe in DONE.json exactly what the orchestrator should look at, and what
   correct looks like, so a human can confirm it in one pass.

## Time bound

Enforced by the launcher. Exceeding it is a terminal `BUDGET` state — not a
reason to rush or skip a commit.

## Resources

`npx vite build` exits on its own and needs no teardown. **Do not** start a
watch, a dev server, or any background process. Anything you do start goes in
`resources[]` with its disposition. A lane that exits with resources running has
not finished.

## Definition of done

Complete when **either** every item reaches a terminal state, **or** it is
conclusively demonstrated the remainder cannot, naming the blocker for each.
Items ending FAIL or BLOCKED are residuals, not failures of the goal.

Terminal states: `PASS` / `FAIL-<named>` / `BLOCKED-<named>` / `PENDING-HUMAN`.

1. Sidebar Start card with Needs input count; calm zero state
2. Workspace badges; **Start count == sum of badges**, both from the same helper
3. Home view fills the right side with **no title bar**
4. Four sections, exact Claude Code names, correct order
5. Tiles/Cards segmented toggle, top right of the first heading, persisted
6. Cards mode: written-out ask + action buttons (stubs acceptable, noted)
7. Tiles mode: thumbnail grid reusing `preview-tile.ts` / `preview-canvas.ts`
8. Dock pane tabs show per-session state
9. `ctrl+`` toggles home; **bare backtick still types a backtick**
10. `<mux-dock>` hidden, never unmounted
11. **Standalone fixture demo builds and renders with no backend**
12. `npm run check:fast` 0 errors; `go build ./...` clean; `vite build` succeeds
13. Committed AND pushed to `origin goal/hv-c-frontend-home`

**Priority if time runs short:** items 11, 1, 2, 3, 4, 5 first — the demo and
the Start card are what the user sees. Items 8, 9, 10 can be residuals.

## Final act

Write `DONE.json` in the worktree root — gitignored, do not commit. Fields:
`lane, session_id, verdict, branch, head, pushed, items[], residuals[],
pending_human[], resources[], notes, suite`.

Put the **demo build command and output path** in `notes` — the orchestrator
needs it to serve the preview.

`verdict` is exactly one of `COMPLETE`, `BLOCKED`, `PARTIAL`. `session_id` must
be your own.
