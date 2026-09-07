# Goal: the muxterm Dashboard works in a real browser

DONE when every item in CHECKLIST below is resolved to **PASS** or
**BLOCKED(<named cause>)**, and the results are written to `HANDOFF.md` in the
worktree root with the terminal evidence for each.

The goal is satisfied by either outcome. A BLOCKED item is a legitimate
terminal state: record the item, the specific cause, and what was tried, then
continue to the next item. A blocker on one item never blocks the goal.

Worktree: `/home/ken/workspace/muxterm-chief-of-staff`, branch `feat/chief-of-staff`.
The approved design is the HTML mockup at `/tmp/cos-mock/index.html`. Open it and
match it. It is the specification; where this file and the mockup disagree about
visual detail, the mockup wins.

## CHECKLIST

Each item resolves independently to PASS or BLOCKED(cause).

**Gates** — re-check before each commit.
1. `go build ./...` exits 0.
2. `cd web && npm run check:fast` reports 0 errors. Exactly 8 pre-existing
   warnings in `terminal-registry.ts` are expected; leave them.

**Desktop surface**
3. One shared topbar, 52px, spanning both columns: `Dashboard` on the left,
   then `cards | tiles`, then a `⋯` button. No status pip. No counts anywhere
   in the UI.
4. Left column is the conversation; right column is the existing home
   cards/tiles view. A draggable divider sits between them, below the topbar,
   clamped so neither column collapses (~18%–78%).
5. **Card heights stay fixed while the divider is dragged.** Only column count
   and scroll extent change. This is a required behavior, not a preference.
6. The composer that previously lived in the home view is removed. The
   conversation's composer is the only input on the surface.
7. The composer is one rounded box containing a multiline auto-growing text
   area with controls inside its bottom-right: a ghost lucide `Mic` and a
   filled circular lucide `ArrowUp` send. No emoji glyphs. No animation of any
   kind — no pulsing, throbbing, breathing, or orb.
8. Listening state changes only the composer: `Mic` becomes a filled red
   square Stop, and the transcript fills the text area.
9. No border rule above the composer. A ~22px gradient fade from transparent
   to the background sits there instead.
10. The `⋯` menu offers: clear messages older than 7 days, older than 30 days,
    and clear all messages. No counts in the menu. Each opens a confirm that
    states running lanes are unaffected and that a message about a still-alive
    lane will not be dropped.

**Mobile portrait**
11. Title bar reads `Dashboard`. No brand text, no pane breadcrumb, no mic in
    the title bar. Right cluster is a lucide `LayoutGrid` button carrying a
    needs **dot** (not a number), then `⋯`.
12. The fleet is a bottom sheet, closed by default, opened by the `LayoutGrid`
    button. It uses the native Popover API idiom already used by
    `web/src/components/mux-pane-picker.ts` — top layer, light dismiss,
    Escape, one-at-a-time, list scrolling inside a bounded height.
13. The sheet has detents: dragging the handle resizes it continuously;
    releasing snaps to closed / half (~56%) / full (100% − 44px); tapping the
    handle toggles half ⇄ full; a `✕` dismisses; tapping the scrim dismisses;
    dragging below ~22% dismisses.
14. Mobile portrait shows cards only — no cards/tiles toggle, no terminal
    thumbnails. Card heights stay fixed while the sheet is resized.

**Delegation**
15. A `spawn_lane` MCP tool exists taking `workspace` (by name, resolved or
    created), `harness` (`amplifier` | `claude`), `prompt`, optional `goal`,
    optional `placement`, and returning the workspace id, pane id, and whether
    the workspace was created. Argv mirrors `web/src/lib/harness.ts:41`:
    amplifier → `["amplifier","run",<prompt>,"--mode","chat"]`;
    claude → `["claude",<prompt>]`; when `goal` is set the amplifier prompt
    becomes `"/goal " + goal`. `goal` with `harness:"claude"` returns a clear
    error rather than being ignored.
    **CORRECTION (2026-09-07): this item as written specified a bug.** Keeping
    `--mode chat` on the goal argv makes `/goal` literal prompt text — the
    command is honoured only on amplifier's headless path — so the lane came
    back `mode=interactive` with an empty `doneMeans`. A goal lane is
    `["amplifier","run","/goal "+goal]`, with no `--mode chat`; the flag stays
    on the interactive lane only. See `HarnessArgv` in
    `internal/mcp/tools_lane.go` and the correction section in `HANDOFF.md`.
16. `muxterm spawn-lane` provides CLI parity with the tool.
17. `spawn_lane` launches the named harness in the created pane — verified by
    reading the pane's screen and seeing the harness running, not a bare shell.

**Browser verification**
18. Each of items 3–14 is confirmed in a real browser at
    `http://127.0.0.1:8313` using `playwright-cli` (`open` → `snapshot` →
    `click` → `close`), against a brand-new workspace and brand-new panes.
    Paste the observed evidence for each into `HANDOFF.md`.

## RULES

- **No unit tests.** Do not create `*_test.go` or `*.test.ts`. Verification is
  the browser and the CLI.
- **Production muxterm is off limits.** Ports 8311 and 9090 serve the live
  instance. Send no mutating request to them. Never `pkill`/`kill` muxterm or
  sessiond by name, never `make install`, never `systemctl`. Use
  `make dev-local` (127.0.0.1:8313, isolated `XDG_RUNTIME_DIR`), which is safe
  to start and stop. Before trusting any dev-local result, run
  `ps aux | grep sessiond` and confirm the binary path is this worktree's.
- The uncommitted `internal/server/cos.go`, `web/src/components/mux-cos.ts`,
  and `web/src/lib/cos-store.ts` were built to a superseded peer-overlay
  design. Rework them to the approved design; reuse what fits.
- `home-sessions.ts` is the single seam for session state. Read it. Do not add
  a parallel data path for the fleet.
- The Dashboard must never close a workspace it did not create.
  `broadcastWorkspaceClosed` (`internal/sessiond/server.go:783-789`) fans out
  to every connection and moves the human's browser.
- Commit to `feat/chief-of-staff` when gates pass. Do not open a PR.

## SCOPE-OUTS

- No further mockups. The design is settled.
- No unit tests of any kind.
- Claude Code hook integration is out of scope.
- Drift detection, periodic CoS wake, and state-transition tracking are out of
  scope.
- The amplifier chat tee and `lane_transcript` are out of scope.
- No production deployment, no soak time, no real-world usage period.
- Desktop landscape and mobile portrait are the two required layouts. Tablet,
  mobile landscape, and print are not.
- Pixel-exact reproduction of the mockup is not required. Structure,
  interaction, and the absence of the removed elements are what count.

## KNOWN — established facts, to avoid re-deriving them

These are a speed aid only. They do not substitute for the checklist.

- Committed and working at `78244ed`: `sidecar/cos/main.py` (NDJSON over
  stdio, one long-lived AmplifierSession) -- since moved to
  `internal/cos/sidecar/main.py` so `go:embed` can reach it -- plus
  `internal/cos/` (supervisor, single-consumer queue, event broker, state
  file), `cmd/muxterm/cos_cmd.go`.
  Measured: boot 1.96s, plain turn 1.19s, MCP-tool turn 2.82s, 31–32 tools
  mounted of which 18 are `mcp_muxterm_*`.
- The MCP `create_pane` cannot launch a command:
  `internal/mcp/tools_layout.go:44` hardcodes `CreatePane(nil, ...)`. The
  sessiond wire does carry `Cmd []string` and the browser uses it
  (`internal/server/ws.go:364`); only the MCP schema at
  `internal/mcp/run.go:275-293` omits it. This is why item 15 exists.
- An MCP client attaches to one workspace at a time
  (`internal/mcp/client.go:99-113`), so `spawn_lane` must switch workspace
  before creating a pane, and cross-workspace work serializes.
- Design rationale lives in `docs/designs/2026-09-06-cos-delegation-model.md`,
  `-cos-sidecar-spec.md`, and `-muxterm-intelligence-design.md`.
- Theme tokens: `--chrome-*` set in `web/src/lib/theme.ts`; `--ink-1/2/3`,
  `--surface`, `--edge`, `--need/work/ok/fail` derived in `mux-home.ts:459-475`.
- `web/dist` may need `cd web && npx vite build` before `go build ./...`
  succeeds in a fresh worktree.

## TEARDOWN

Before finishing, stop any `make dev-local` instance and any helper process
started during the run, and confirm with `ps aux` that none remain. Leave the
production instance on 8311/9090 untouched and running. Record the teardown
result in `HANDOFF.md`.
