# macOS Native Window & Layout Architecture Design

## Goal

Correct the muxterm-apple (Swift) window/layout architecture to match the already-approved UX design: one persistent main window with a sidebar + tiled tab-group content area, plus a `⌘N` multi-window capability — using real AppKit primitives plus one carefully-chosen dependency (Bonsplit) rather than hand-rolling a docking system.

## Background

The Phase 1 Swift implementation (muxterm-apple, M3 milestone, tracked in `docs/plans/2026-07-01-phase1-swift-app-implementation.md`) diverged from the already-approved design: it built a standalone `DashboardView` `NSWindow` plus a separate `WorkspaceWindow` `NSWindow` per opened workspace, with no persistent sidebar inside the workspace window. This is legal Swift but wrong — closing a workspace window loses the path back to the dashboard, and it duplicates the "grouped connections/workspaces" concept as two independently-implemented views that inevitably drift apart from each other. That drift is exactly what happened.

The correct design already exists in two places and was not previously translated into a technical architecture:

1. `docs/designs/wireframes/native-apps-wireframes.html` and `docs/designs/2026-07-01-native-companion-apps-ux-design.md` (Section 1) — both show ONE persistent desktop window: sidebar (grouped Local/remote list) + main tiled area showing the selected workspace.
2. `docs/muxterm-app-design/Native Companion Apps.dc.html` — a full hi-fi design system export containing 24 user stories (US-1 through US-24), 9 failure points (F1-F9), and pixel-level storyboards (D0-D5 desktop, P1-P8 phone, T1-T2 tablet, DF1-DF6/PF1-PF2 failure states). This is the authoritative visual source; specific node IDs (D2, D3, D4, D5, US-19, US-24, F1-F9) are referenced directly below rather than re-described.

This document corrects the implementation to match that already-approved UX design, and adds the technical layer that was missing before: the AppKit constraint/layout system, a chosen third-party library for the tiled content area, and a motion specification for the window/layout-level transitions.

This design **does not** touch the app-level failure states (SSH, browser channel, replay settle barrier) — those are already fully specified in the hi-fi doc's F1–F9/DF1–DF6 screens and in `docs/designs/2026-06-30-native-companion-apps-design.md`. It also does not re-scope terminal rendering, the browser pane protocol, or the SSH/SOCKS connection model — all unchanged from the existing native-apps design.

## Approach

Single persistent `NSWindow` (singleton — hidden via `orderOut:` on close, never destroyed; `applicationShouldHandleReopen` restores it) rooted in `NSSplitViewController`, with a sidebar built in SwiftUI (hosted via `NSHostingController`) and a tiled content area built on the **Bonsplit** library (github.com/almonk/bonsplit, MIT license, 438★, macOS 14+/Swift 5.9+ — matches the existing deployment target) rather than a hand-rolled recursive `NSSplitView`-of-panes tree. Secondary windows via `⌘N` are second live client-attaches to the SAME workspace (not a "detach workspace" operation), each with their own independent Bonsplit layout and NO sidebar.

| Approach | Summary | Decision |
|----------|---------|----------|
| Persistent `NSSplitViewController` (sidebar + Bonsplit content) | One singleton window, AppKit-level constraint control, Bonsplit for tab-group tiling | **Chosen** |
| SwiftUI `NavigationSplitView` for outer chrome | Data-driven list→detail navigation container | Rejected — built for list/detail navigation, not the constraint-level control (min/max clamping, holding priority) needed alongside a custom AppKit tiling engine |
| Hand-rolled recursive `NSSplitView`-of-single-panes | Original plan before discovering the hi-fi doc's D2 screen | Rejected — the approved design (US-24, D2) requires each split leaf to be a TAB GROUP (mixed terminal/browser tabs), not a single dumb pane — matches the web client's dockview model, rendered natively |
| `swift-dockkit` (github.com/Polyjuice/swift-dockkit) | Alternative docking library | Rejected — 1 star, 0 forks, far too unproven |
| "Move Workspace to New Window" (detach/ownership-transfer) | Originally proposed before the hi-fi doc was found | Rejected in favor of the actual approved US-19/D4 model: a second window is a second concurrent client-attach to the same workspace, reconciled by the daemon's existing multi-client-attach support |
| A Bonsplit-equivalent for Android | Investigated as a parity question | Rejected — not needed. Android's phone UX is single-pane + swipe (`HorizontalPager` + `PaneStrip` + switcher sheet), already built in M3 with vanilla Compose. Tablet (deferred scope) is a fixed max-2-pane split — plain Compose `Row`, no library at all |

## Architecture

```
Main NSWindow (singleton, never destroyed — hidden via orderOut:, restored via
applicationShouldHandleReopen)
└── NSSplitViewController (root)
    ├── NSSplitViewItem: Sidebar (holding priority 260, resists window growth)
    │     NSHostingController<ConnectionGroupedListView(density: .sidebar)>
    │     Width 220 default / 160 min / 360 max, autosaveName persists divider
    │     position across launches (matches existing web sidebar numbers from
    │     2026-06-12-sidebar-and-tunnels-design.md)
    └── NSSplitViewItem: Content (holding priority 200, absorbs growth)
          WorkspaceViewController (pure AppKit)
          └── BonsplitController/BonsplitView — recursive splits of TAB GROUPS
                Each leaf = tab strip (terminal + browser tabs freely mixed,
                per US-24 and hi-fi screen D2). NOT one-pane-per-leaf.

Secondary NSWindow(s) — via ⌘N, zero or more, non-singleton, close normally
└── WorkspaceViewController only (same workspaceId as main window's current
      selection, but its OWN ProtocolClient / second live client-attach)
      NO sidebar — content-only, own independent Bonsplit tree/layout
      Matches hi-fi screen D4 / US-19 exactly: "A second window is a second
      client attach to the same workspace — put terminals on one monitor, the
      browser pane on another. Each window keeps its own layout (per-
      breakpoint); the daemon reconciles, active-view-wins on resize."
```

**Selection → content swap.** Clicking a sidebar row updates `AppState.activeWorkspaceId`; `WorkspaceViewController` observes and rebuilds its Bonsplit tree from that workspace's stored layout blob (`treeSnapshot`-shaped JSON round-tripped through the protocol's `layout` field, keyed by breakpoint). Instant cut, no crossfade (see Motion Design below) — retained-but-hidden `TerminalView`/`BrowserPane` instances for the previous workspace stay warm via Bonsplit's `.keepAllAlive` content lifecycle, so switching back doesn't re-settle.

**Deleted from current code:** `DashboardView`'s standalone `NSWindow`, the old `WorkspaceWindow` per-workspace-window class, the hand-rolled `TilingContainerView` (superseded by Bonsplit).

## Components

**Terminology: muxterm pane vs. Bonsplit pane.** The word "pane" is overloaded between the two systems referenced throughout this document — this mapping is load-bearing for correct event-handler implementation, not a naming nitpick:
- muxterm protocol "pane" (a `paneId`, `create-pane`, `pane-closed`, `PaneState` — an individual terminal or browser session) = a Bonsplit **Tab**.
- Bonsplit "pane" (`splitPane`, `closePane`, `shouldClosePane` — a split-leaf/tab-group container) = this design's "split leaf" / "tab group" — never a 1:1 match with a muxterm pane; one Bonsplit pane holds a tab strip of many muxterm panes.
- Therefore: the server's `pane-closed` broadcast (a single muxterm session closing) must always be handled via `controller.closeTab(tabId)`, never `closePane()`/`shouldClosePane` — those Bonsplit APIs operate on the tab-group container and would destroy every tab in the group, an unrelated and much more destructive operation.

**Bonsplit integration** — `BonsplitController`/`BonsplitView` is the concrete implementation of the tab-group+split content area:
- `createTab()` / `splitPane(orientation:)` / `closeTab()` map directly onto terminal/browser tab operations and `⌘\` split.
- `contentViewLifecycle: .keepAllAlive` — exactly matches the "don't dispose the terminal when its tab isn't frontmost" requirement; built into the library, not hand-rolled.
- `controller.layoutSnapshot()` / `.treeSnapshot()` — directly solves layout persistence (round-tripping through the `layout` field); serializable geometry provided by the library.
- `shouldNotifyDuringDrag` defaults to **false** — Bonsplit already coalesces pane-divider-drag geometry notifications to end-of-drag by default, solving the resize-feedback-loop risk (the same bug class as `docs/designs/layout-resize-design.md` Bug 2 — pane-drag pixels leaking into the wrong resize call, causing oscillation) for the pane-divider case without custom debounce code.
- `shouldCloseTab` / `didSplitPane` / `didChangeGeometry` delegate hooks are the integration points our code owns (see Data Flow and Error Handling below).

**BrowserPane chrome** — unchanged from the already-approved UX doc (Section 4): nav row (‹ › ⟳) + URL field + `⚡ port` dropdown (confirmed by hi-fi screen D3 to list live ports with labels, e.g. `:5173 vite`) + authority banner. One addition from D3: the banner should name *which* agent and *what it's doing* (`claude-opus-4-5 · clicking "Compare runs"`), not just a generic `◉ agent driving` — extend the banner's data model to carry an optional agent-name/action-description field.

**Shared resize guard** — one debounced, `outstandingResizes`-gated utility (from the `layout-resize-design.md` Bug 2 pattern) reused at TWO remaining call sites (Bonsplit already handles the third — pane-divider drag — via its own default coalescing): sidebar-divider drag, and window-viewport resize (window resize itself, or the content area's frame changing because the sidebar moved).

**`ConnectionGroupedListView(density:)`** — ONE shared SwiftUI component (not two independently-implemented views) parameterized by density (`.sidebar` = compact rows for the main window's sidebar; `.dashboard` = card grid, reserved for a future tablet dashboard surface). Backed by one shared view model (grouping order, connect-lazily-on-expand behavior, last-known-workspaces caching — per the UX doc's Section 1). This is the direct fix for the root cause of the original bug: Dashboard and Sidebar were two independent implementations of the same grouping logic that inevitably drifted apart.

**Tablet (out of current scope, noted for future):** max-2-pane fixed split per hi-fi screen T2 — plain SwiftUI `HStack`, no library needed at all (not Bonsplit-equivalent, not JetBrains' SplitPane). Deferred per the existing Phase 2 plan's "Deferred to later" table ("Tablet two-pane split + desktop-class layout... a later layout pass").

**Android:** investigated and confirmed no Bonsplit-equivalent is needed for the current phone scope. Android's approved UX model is single-pane + swipe (`HorizontalPager` + `PaneStrip` + switcher bottom sheet), already built in Phase 2 M3 with vanilla Jetpack Compose. No action item here.

## Data Flow

**Workspace switching (sidebar click).** `AppState.activeWorkspaceId` updates → `WorkspaceViewController` observes and rebuilds its Bonsplit tree from that workspace's stored layout blob → instant cut, no crossfade (workspaces are semantically discrete — different SSH host, different process tree; crossfading would visually imply a continuity that doesn't exist). Previous workspace's panes stay warm via `.keepAllAlive`.

**Splitting (`⌘\`).** `controller.splitPane(orientation:)` creates an empty pane → `didSplitPane` delegate fires → create a terminal tab locally → **only now** send `create-pane` to the server. The Bonsplit tab is a local UI placeholder until the server's `pane-added` broadcast arrives with a real `paneId` and the `TerminalView` attaches to a live `PaneState`.

**Resize.** `didChangeGeometry` fires (already coalesced to end-of-drag by Bonsplit's `shouldNotifyDuringDrag: false` default) → convert pixel frame to `floor(width/cellWidth)` × `floor(height/cellHeight)` (never round — never let cell count exceed available pixels) → send one `resize` message per affected pane.

**Multi-window (`⌘N`).** A second `WorkspaceViewController` + its own `ProtocolClient` opens a second `/ws` connection, sends its own `attach` for the SAME `workspaceId`. The daemon already treats this as ordinary multi-client attach (documented in `2026-06-30-native-companion-apps-design.md`: "each client sizes independently; the daemon reconciles multi-client attaches... active-view-wins") — no new server-side protocol work required. Each window's Bonsplit tree/layout is independent and never synced between windows; only the underlying pane data (PTY output, browser state) is shared.

## Error Handling

The app-level failures (SSH, browser channel, settle barrier) are already fully specified in the hi-fi doc's F1–F9 / DF1–DF6 failure-state screens — no redesign needed there; reference them directly. What follows is specific to the window/tab-group/multi-window layer.

**Stale layout blob on restore.** A saved `treeSnapshot` may reference a `paneId` the server no longer has (pane closed elsewhere since last save). On restore, drop unresolvable leaves silently and let Bonsplit's `autoCloseEmptyPanes` config collapse the resulting empty pane — never show a broken/dangling tab, never error the whole workspace open over one stale reference. This covers a dangling reference *within* an otherwise-valid Bonsplit `treeSnapshot`; schema migration (a persisted blob that isn't Bonsplit-shaped at all) is a separate case, covered next.

**Pre-migration layout blob (schema migration).** Workspaces already opened under the shipped M3 `TilingContainerView` have a persisted `layout` blob in that hand-rolled JSON schema, not a Bonsplit `treeSnapshot` — it will not parse as one at all. On restore, if the persisted `layout` blob doesn't parse as a valid Bonsplit tree schema, discard it entirely and fall back to a default single-pane layout (one tab group containing the workspace's panes in server-reported order), rather than attempting a best-effort parse of an incompatible schema. This is a one-time migration cost, not an ongoing concern — once a workspace is opened once under the new architecture, its persisted layout is always Bonsplit-schema going forward.

**Pane closed by another client while open here.** Server broadcasts `pane-closed` → find the tab by `paneId` across ALL open windows (main + any `⌘N` secondaries) → call `controller.closeTab()` on each. This is the one place a single server event must fan out to multiple independent Bonsplit controllers — implement as a small registry mapping `paneId → [BonsplitController]` across live windows.

**Focus authority with multiple windows.** Terminal keystroke focus is per-window (each window's own last-clicked tab (muxterm pane) — unchanged "last-clicked = focus" rule from the UX doc, just now scoped to the `WorkspaceViewController` instance rather than globally). Browser-pane agent/human authority stays global per-pane (unchanged) — if a browser pane happens to be visible in two windows simultaneously, both show the identical authority banner state, since there is exactly one `WKWebView` instance, not one per window.

**Bonsplit veto hooks.** Use `shouldCloseTab` to detect "is this the last tab in the last pane of this workspace" — if so, prompt before closing (mirroring the sidebar's existing workspace-close-with-undo pattern from `2026-06-12-sidebar-and-tunnels-design.md`) rather than silently leaving a truly empty workspace.

## Motion Design

Grounding principle: motion communicates state, it never decorates.

1. **Sidebar workspace switch → main area transition.** Instant cut (0ms), not a crossfade/dissolve. Workspaces are semantically discrete (different SSH host, different process tree) — crossfading would visually imply a false continuity. In AppKit: swap the view subtree inside a `CATransaction` with `setDisableActions(true)` to suppress any implicit layer-backed fade. The sidebar's own selection-highlight indicator can move (120-150ms ease-out) — that's pure wayfinding, separate from content.

2. **Splitting a pane (`⌘\`).** ~180ms ease-out (`cubic-bezier(0.4,0,0.2,1)`), but only after the authoritative layout arrives (don't animate an optimistic 50/50 guess then correct it — causes a double-motion stutter). New pane content fades opacity 0→1 over the same 180ms (not a scale/spring bounce — this is a quiet, expected, user-caused action).

3. **Agent-created pane (MCP action, not user-initiated).** Deliberately more noticeable than a user split — this is the one place "decoration" is actually communication. If the affected workspace is currently visible: entrance with opacity 0→1 AND scale 0.94→1.0, 350-400ms, `cubic-bezier(0.16,1,0.3,1)` (confident "expo-out," no bounce/overshoot — overshoot reads as playful, wrong register for "an autonomous process altered your workspace without you"). Plus a one-shot accent-colored border pulse (2 pulses, ~600ms) and a persistent agent-glyph marker on the pane's tab (so a user who looks over after the animation still gets the "agent created this" signal). If the affected workspace is NOT currently visible: a small pulsing accent dot on the sidebar's workspace row (2-3 pulses over ~1.2s, then settles to steady) — never steal focus or force-switch the sidebar selection.

4. **Connection status dot (`○` disconnected → `◉` connected).** Three distinct treatments, never a plain glyph swap. Disconnected→Connecting: opacity breathing loop 0.4↔1.0, 1000-1200ms per cycle, ease-in-out (calm, not urgent). Connecting→Connected: scale pulse 1.0→1.25→1.0 + color crossfade, 300-350ms, `cubic-bezier(0.34,1.56,0.64,1)` (spring appropriate here — a confirmed positive state change). Connected→Disconnected (unexpected drop): flat fade to grey, 150-200ms ease-out, no bounce (asymmetric on purpose — bad news shouldn't get the same physicality as a success state).

5. **Sidebar/window resize at min/max clamps.** Rubber-band resistance during live drag (borrow macOS's own `NSScrollView` elastic-overflow metaphor — max ~15-20px overtravel, diminishing-returns curve) + tight spring settle on release (`response: 0.28, dampingFraction: 0.86` — minimal overshoot, reads as "snapped to limit" not "bounced off a wall"). Programmatic/keyboard resize: hard instant clamp, no spring at all (the physical-resistance metaphor only applies to continuous direct manipulation). Window resize itself (not the sidebar divider): leave entirely to AppKit's native handling, no custom physics.

Respect `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion` — collapse durations near-zero except where animation is the sole carrier of state information (connecting-dot breathing, agent-pane entrance), for which provide a static fallback (a text label, a static border) rather than silently losing the signal.

## Verification Approach

Follows the project's existing "verify with reality" policy (no mocked SSH, no mocked protocol) with two complementary verification styles for this specific layer:

1. **Structural verification via `agent-desktop`** (cheap, no screenshots — accessibility-tree based) for: window count/titles never duplicating the singleton main window, confirming a secondary `⌘N` window genuinely has no sidebar, confirming tab count/contents in a Bonsplit pane (one split leaf's tab group) after a split. This approach already caught a real pane-count staleness bug earlier in this project using the same technique — prefer it over screenshots wherever the state is accessibility-tree-visible.

2. **Live protocol round-trips for multi-window reconciliation** — two real `ProtocolClient` connections attached to the SAME `workspaceId` against a real running `muxterm serve`, confirming both receive `pane-added`/`pane-closed` broadcasts and the daemon's existing active-view-wins multi-client-attach behavior works as documented (testing our consumption of that behavior, not re-deriving the protocol).

Bonsplit's own mechanics are explicitly out of scope for our test suite — drag-reorder, split animations, and 120fps rendering are the library's responsibility with its own upstream tests. Our testing surface is only the integration points: `didSplitPane`/`shouldCloseTab` delegate wiring, `layoutSnapshot()` → `layout` field → restore round-trip, `didChangeGeometry` → debounced `resize` message send.

Narrow screenshots only where structurally invisible — actual rendered terminal/browser pixel content, since custom-drawn `NSView`s (the terminal cell-grid renderer) and `WKWebView` content have no accessibility representation at all. Always a targeted crop of one window/pane region, never a full-desktop capture (a real mistake made earlier in this project's verification work, corrected once discovered).

## Open Questions

- Exact visual treatment of the agent-name/action-description field added to the browser authority banner (D3's "claude-opus-4-5 · clicking 'Compare runs'" detail) — needs a small follow-up pass with `design-intelligence:component-designer` when implementation begins, not blocking this design.
- Whether Bonsplit's `keepAllAlive` content lifecycle has a practical upper bound on retained terminal/browser instances before memory pressure becomes a concern in long-running sessions with many workspaces — flag as an implementation-time measurement, not a design blocker.

## Relationship to Existing Plans

This design corrects Phase 1 M3 of `docs/plans/2026-07-01-phase1-swift-app-implementation.md` (which already shipped, was verified, and passed code review under the previous incorrect window architecture). Implementation work should be scoped as a follow-up milestone against the already-built muxterm-apple codebase, not a fresh Phase 1 restart.
