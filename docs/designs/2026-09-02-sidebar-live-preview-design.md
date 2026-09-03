# Sidebar Live Preview Cards

## Outcome

Each workspace in the sidebar becomes a small live screen: a bottom-left crop of that
workspace's most active pane, rendered in a 4x6-pixel bitmap font, updating as the buffer
changes. Workspace name, active pane title, and pane count survive as overlays on the card
rather than as separate rows.

The card reads as a thumbnail of a terminal, not a list item.

## Scope and Non-goals

In scope: the wide-breakpoint sidebar (`mux-sidebar.ts`), one new sessiond message pair, a
bundled bitmap font, a `[sidebar]` config section.

Not in scope: the narrow-breakpoint `mux-pane-picker`, per-pane previews inside the dock tab
strip, scrollback in previews, and any change to how panes are attached or rendered.

## The font decision

You asked me to evaluate Tiny5, "minigent", and "Pixel 5". Two of the three do not survive
contact with the requirement, and the reason matters, so here it is up front.

The hard requirement is **monospace**. A terminal preview is a character grid; a proportional
font destroys column alignment and turns a TUI into noise.

| Candidate | Verdict |
|---|---|
| **Tiny5** | **Disqualified — it is not monospace.** Measured from `google/fonts/ofl/tiny5/Tiny5-Regular.ttf`: five distinct ASCII advance widths (256/384/512/640/768 units). `post.isFixedPitch: False`. Its own repo calls it "variable-width." Also zero box-drawing coverage. It is a display font for headings. |
| **"minigent"** | Almost certainly **monogram** (datagoblin, CC0). Genuinely monospace and genuinely good — but its 6px advance yields only ~34 columns in our card. |
| **"Pixel 5"** | Does not exist as a font. Every search result is the phone. |
| **m3x6 / m5x7** | Proportional ("average width +3"), and licensed only as informal "free with attribution" — not safely redistributable in an MIT repo. |

Measured in real Chrome, in the actual 220px card:

| Font | Cell | Cells in card | License |
|---|---|---|---|
| **Spleen 5x8** | 5x8 | **41 x 13** | **BSD-2-Clause** |
| Tom Thumb | 4x6 | 51 x 18 | MIT |
| Miniwi | 4x8 | 51 x 13 | GPL-3.0, **no font exception** |
| unscii-8 | 8x8 | 25 x 13 | Public domain |

**Decision: Spleen 5x8, BSD-2-Clause.** Chosen by side-by-side eye test against real Amplifier
CLI output, not by spec sheet. Tom Thumb buys 10 more columns; Spleen's glyphs are enough more
legible that the trade is worth it, and BSD-2 is the cleanest license in the field.

Tom Thumb 4x6 (MIT) remains the documented fallback if density ever matters more than
legibility. The pipeline is size-agnostic — swapping fonts is a one-line change plus a rebuild.

Miniwi has the best coverage/density combination in the field and is disqualified purely on
licensing: plain GPL-3.0 with **no font exception**, which has a genuinely contested
derivative-work story for a font served into a web page. Not a risk worth taking in an MIT repo.

### Two things the font needs that no candidate ships

Both are handled by `tools/font/build.sh`, and both are **font-independent** — they apply to
whichever font wins.

**1. Spleen ships no WOFF2 at 5x8.** Every other size (6x12, 8x16, 12x24, 16x32, 32x64) has web
fonts; 5x8 is BDF/PCF/PSF/OTB/FON only. And off-the-shelf BDF converters mangle metrics — the
popular Tom Thumb TTF on GitHub is *not monospace* despite its filename, with all ink below the
baseline. `bdf2web.py` sets `unitsPerEm = cellHeight * 64` so `font-size: 8px` yields an exactly
integer 5px advance.

**2. Spleen has 11 box-drawing glyphs and ZERO block elements.** This was invisible until the
preview was pointed at real Amplifier output, which is full of emoji — the `▒▒` placeholder for
wide cells would have rendered as tofu. `addblocks.py` generates the full `U+2580..2593` range
from the cell dimensions read out of the BDF.

At 5x8 the eighth-block ladder lands on **exactly one row per eighth**, so htop meters,
progress bars and sparklines render at full precision:

```
 ▁     ▂     ▃     ▄     ▅     ▆     ▇     █
 ..... ..... ..... ..... ..... ..... ..... #####
 ..... ..... ..... ..... ..... ..... ##### #####
 ..... ..... ..... ..... ..... ##### ##### #####
 ..... ..... ..... ..... ##### ##### ##### #####
 ..... ..... ..... ##### ##### ##### ##### #####
 ..... ..... ##### ##### ##### ##### ##### #####
 ..... ##### ##### ##### ##### ##### ##### #####
 ##### ##### ##### ##### ##### ##### ##### #####
```

Only the **light** box set needs glyphs. Heavy, double, dashed and rounded variants are folded
to their light equivalent by the sanitizer — a table in code beats 100 glyphs in a font.

Output: `web/public/fonts/Spleen5x8.woff2`, **4,748 bytes**, committed so a normal `make build`
needs neither Python nor network.

### Keeping it crisp

Measured by counting distinct colors in a monochrome tile (a perfect bitmap render is 2):

- `font-size: 8px` → **2 colors**. Pixel-perfect, no CSS hacks.
- `font-size: 8.5px` → **58 colors**. Nearly every ink pixel antialiased.

So the geometry must be exact, and the things that break it are fractional font-size, **browser
zoom**, fractional ancestor offsets, and `will-change: transform`.

`image-rendering: pixelated` does nothing to text. `-webkit-font-smoothing: none` is macOS-only.
There is no cross-platform CSS switch for this — which drives D1.

## Decisions

### D1. Render to `<canvas>` at an *integer* device scale

Three reasons for canvas:

- **Zoom degrades gracefully instead of catastrophically** — with the caveat below, which is
  the whole substance of this decision.
- **Cheap at frequency.** These tiles redraw several times a second. Rebuilding ~50 colored
  `<span>` runs x 18 rows through Lit at 6 Hz is far more expensive than `fillText`.
- **Trivial coloring.** Per-run `ctx.fillStyle` versus a span forest.

**The caveat, measured rather than assumed.** Canvas is *not* automatically zoom-proof. The
obvious implementation — `ctx.setTransform(dpr, ...)` and draw in CSS pixels — is exactly as
bad as DOM text at fractional zoom, because it turns the 5x8 cell into a fractional device-pixel cell
and antialiases every glyph edge:

| Device scale | Naive `setTransform(dpr)` | Integer scale + `image-rendering: pixelated` |
|---|---|---|
| 1.0 | 3 colors | **3 colors** |
| 2.0 | 3 colors | **3 colors** |
| 1.1 (110% zoom) | **71 colors** | **3 colors** |
| 1.25 (125% zoom) | **61 colors** | **3 colors** |

(Distinct RGB values in a monochrome tile. A perfect bitmap render is 2. The third value
occurs in **4 pixels out of 22,032** — 0.018%. Effectively pixel-perfect.)

So the rule is: **render at `k = max(1, floor(devicePixelRatio))`, size the canvas
`cols*5*k` by `rows*8*k` device pixels, and set `image-rendering: pixelated`.** At fractional
zoom the browser then resamples the finished bitmap with nearest-neighbour — chunky pixels,
some 1px and some 2px wide, but *sharp*. That is a completely different failure mode from
antialiased grey mush, and it is the reason to use canvas at all.

Must `await document.fonts.ready` before the first draw, or frame one silently renders in
fallback monospace at 8px.

### D1b. Lift dim colors to a contrast floor

Real Amplifier output exposed this and the synthetic content never would have: at 8px with
1px strokes, dim colors simply are not there. A terminal at 14px puts roughly 3x the ink into
a glyph; the preview does not have that ink to spend.

Measured against `--mux-bg` in tokyo-night:

```
dim / chrome-text-dim   2.76:1  ->  4.67:1   #565f89 -> #7b84ac
ansi-8  brightBlack     1.91:1  ->  4.52:1   #414868 -> #7a82a4
ansi-0  black           1.05:1  ->  4.53:1   #15161e -> #7d829f
ansi-4  blue            6.79:1      unchanged
ansi-2  green           9.35:1      unchanged
ansi-1  red             6.46:1      unchanged
```

Amplifier leans hard on dim grey for thinking text, token counts, and tool metadata — half the
screen was vanishing. **Every color is lifted toward the palette foreground until it clears
4.5:1 against the terminal background.** Luminance moves, hue does not, and colors that already
clear the floor are untouched.

This is a *preview-only* transform. The terminal itself must keep true palette colors; the tile
is a different rendering medium with a different ink budget, and it is allowed to compensate.

### D2. Two data sources, and the asymmetry is the visual hierarchy

The attached workspace's terminals already live in the browser. `terminalRegistry` holds a live
xterm.js `Terminal` per pane with full per-cell foreground, background, bold, and inverse.

The other workspaces have **no data in the browser at all** — a connection is attached to
exactly one workspace (`server.go:196-207`), and the client knows only `{workspaceId, name,
paneCount}` for the rest.

So:

| | Source | Cadence | Color |
|---|---|---|---|
| **Attached workspace** | local xterm buffer | ~6 Hz | **full color** |
| **Other workspaces** | sessiond push | <=2 Hz, change-gated | **monochrome** |

This is not a compromise on the detached cards — it *is* the hierarchy. The workspace you are
in is live and vivid; the others are ghosted. The eye is drawn to the right place, and the
highest-fidelity path costs zero protocol work.

It also means the protocol addition is small and low-frequency, which is what makes D5 safe.

### D3. Crop, do not scale

You said "bottom left portion," and that is right for a reason worth stating: at 4x6px there is
no meaningful way to downsample a 200x50 terminal. A crop preserves real, readable cells.

The crop is anchored to **content, not to the grid**:

1. `bottom = max(lastNonBlankRow, cursorRow)` — never the literal bottom row of the emulator.
2. `top = bottom - rows + 1`, clamped at 0. If there is less content than the tile is tall,
   blank rows go at the **top** so content sits on the floor, exactly like a fresh shell.
3. Columns `0 .. cols-1`, right-padded with spaces if the pane is narrower.

Step 1 is what keeps the card alive. A 50-row pane with 8 rows of output would otherwise render
as 18 rows of nothing.

Note: this must walk `Emulator.CellAt` over `Bounds()`. The existing `VTBuffer.ScreenText()`
trims trailing blank rows (`vt.go:347-351`) and would silently destroy vertical alignment.

Open question for the eye test: in **alt-screen** (vim, htop, less), bottom-anchoring shows the
status line and function-key bar — arguably the most identifying part of those apps, but it
discards the header. Worth looking at before deciding whether alt-screen should top-anchor.

### D4. One canonical tile, cropped again on the client

Each client can have a different sidebar width, so each wants different tile geometry. Rather
than negotiate per-client geometry, sessiond emits **one canonical 80x24 tile** and each client
crops it to its own `cols x rows` — taking the leftmost columns and the bottom rows.

A crop of a bottom-left crop is still a bottom-left crop, so this is exact, not approximate.
80 columns is a safe superset (the 360px max sidebar yields 69 at a 5px advance).

Wire size: rows are **trailing-space trimmed** and the client re-pads. A typical terminal row
carries under 40 columns of ink in 80, so a tile lands around 600-900 bytes instead of 1920.
No codec needed.

### D5. Preview frames are opt-in and droppable

Two hazards in the existing broadcast machinery, both of which would turn a cosmetic feature
into a session-killer:

**`broadcastAll` hits every connection**, including `ClientKindCLI` and `ClientKindAgent`. A
one-shot CLI invocation should never receive preview tiles.

**A full subscriber queue disconnects the client.** `subscriber.go:92-105` closes the connection
when the 256-deep queue is full. A backgrounded tab plus a periodic broadcast is exactly the
shape that fills a queue.

So:

- **Opt-in.** A new `preview-subscribe` request sets a per-conn flag. The broadcast iterates
  `s.conns` and skips anyone who has not asked. `preview = "off"` becomes genuinely free, not
  just visually suppressed, and old clients are safe by construction.
- **Droppable.** A sibling enqueue that drops rather than disconnects:

```go
// enqueuePreview queues a cosmetic preview frame. Unlike enqueueControl, a full
// queue DROPS the frame instead of disconnecting the client: previews are
// advisory and must never be able to kill a session.
func (s *subscriber) enqueuePreview(msg *Message) {
	select {
	case s.queue <- outFrame{kind: FrameControl, msg: msg}:
	case <-s.done:
	default: // drop
	}
}
```

Six lines that make the feature structurally incapable of causing a regression.

### D6. Preview the pane that is moving, not the pane that was focused

sessiond does not know which pane is "active" in a workspace. There is no server-side focused
pane, and `SaveLayout` stores an opaque blob (`registry.go:200-215`). The daemon *can* parse
`dockLeaf.ActiveView` (`layout.go:19-23`) but that is debounced, breakpoint-keyed, and absent
for never-laid-out workspaces.

There is also no last-output timestamp anywhere in Go — sessiond's "activity" is a close-safety
classifier (idle/busy/unknown), not an output tracker.

Rather than plumb focus down, add the one field that is genuinely missing and pick the
**most recently written pane**, tie-breaking to the lowest pane id. `readLoop` (`pane.go:336`)
is already the single place per-pane output is observed; it sets `lastWrite` and a `previewDirty`
bit in the same hook.

This is the better answer, not just the cheaper one. For a workspace you are *not* looking at,
"where is the action" beats "what was focused when I left." The card's corner chip names the
pane, so a card switching panes mid-build reads as informative rather than confusing.

The attached card still follows *your* focus, since the client knows it. State the rule plainly:
**attached mirrors your view; detached shows what is moving.**

### D7. Free rider — the workspace bell finally gets a producer

`store.ringWorkspace()` has existed with **zero production callers**. The reason is structural:
the browser never receives output for workspaces it is not attached to, so it could never know.

The preview push *is* that signal. Three lines: on receiving a tile for a workspace that is not
the attached one, `store.ringWorkspace(id)`. `ackWorkspace` is already called on switch
(`mux-sidebar.ts:463`). The card's dot turns `--mux-bell`.

Scoped tightly and explicitly optional, but it comes almost for free and closes a real gap.

## The card

```
┌────────────────────────────────────────┐  1px border: accent when active
│▒▒▒▒▒▒▒▒▒ scrim gradient ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│ ●  dotfiles                          × │  overlay header, 24px
│                                        │
│  $ npm run build                       │
│  vite v6.0.1 building for production   │  ← canvas, --mux-bg background
│  ✓ 412 modules transformed             │
│  dist/index.html            1.24 kB    │
│  $ █                                   │
│                            ┌──────────┐│
│                            │ zsh   +3 ││  corner chip
└────────────────────────────┴──────────┴┘
```

**The card background is `--mux-bg`, not `--chrome-bar`.** This is the single detail that makes
it read as a little screen instead of a list row.

**Overlay placement is not arbitrary.** Two alignments fall out of the bottom-left crop:

- The scrim sits over the **top** of the tile, which after bottom-anchoring holds the *oldest*
  content. The overlay covers the least valuable pixels.
- The chip sits **bottom-right**. We crop the left portion, so the right edge of the bottom row
  is past the end of a typical prompt line — statistically the emptiest region in the tile.

Concrete treatment, all through existing theme tokens:

| Element | Treatment |
|---|---|
| Card | `border-radius: 6px`, `overflow: hidden`, `border: 1px solid transparent`, `margin: 3px 6px`, background `--mux-bg` |
| Scrim | `::before`, 24px, `linear-gradient(to bottom, var(--chrome-bar), color-mix(in srgb, var(--chrome-bar) 55%, transparent) 60%, transparent)`, `pointer-events: none` |
| Name | 12px/600, `--chrome-text-bright`, `text-shadow: 0 1px 2px rgba(0,0,0,.65)` — the shadow does more work than the scrim for legibility over arbitrary content |
| Dot | existing `●`; `--chrome-accent` active, `--chrome-text-dim` idle, `--mux-bell` when D7 fires |
| Close `×` | unchanged behavior: opacity 0 → 1 on hover/focus-visible, 44px target at `pointer: coarse` |
| Chip | `bottom: 4px; right: 4px`, 10px, `--chrome-text-dim`, `color-mix(in srgb, var(--chrome-bar) 80%, transparent)` + `backdrop-filter: blur(2px)`, radius 3px. `+N` in `--chrome-accent` when active |
| Active | `border-color: var(--chrome-accent)` + `box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--chrome-accent) 40%, transparent)` |
| Idle | `filter: saturate(0.25) opacity(0.55)` on the canvas only — reinforces D2 and solves the `--mux-bg`/`--chrome-bar` proximity in dark palettes |
| Rename | unchanged — the existing inline input renders in the header slot |

Non-terminal panes (`surfaceKind: browser`, which has `buf == nil`) get a centered 24px lucide
icon in `--chrome-text-dim` on `--mux-bg`. Honest, and better looking than a blank tile.
Pre-first-tile state: `--mux-bg` with a faint centered `···`, at full reserved height so nothing
shifts.

### Sizing

`cols = clamp(floor(cardInnerWidth / 5), 24, 80)`, re-derived from a debounced `ResizeObserver`.
Dragging the sidebar wider reveals **more columns**, not more rows — which is the correct
semantics for "a window onto the bottom-left."

Rows come from config:

```toml
[sidebar]
preview = "full"    # "full" | "compact" | "off"
```

| Mode | Rows | Preview px | Card px | Header |
|---|---|---|---|---|
| `full` | 13 | 104 | ~112 | overlaid on scrim |
| `compact` | 6 | 48 | ~56 | **stacked above** — a 24px scrim over a 48px tile is half the card |
| `off` | — | — | ~45 | today's exact layout, and no frames on the wire |

At `full` roughly 6 cards fit a 900px viewport before scrolling.

## Components and Boundaries

**Font pipeline** (`tools/font/`, run only when the font changes)
- `build.sh` — fetch → `filter.py` (enforce monospace) → `addblocks.py` (add `U+2580..2593`)
  → `bdf2web.py` (`upem = cellH * 64`) → verify → `web/public/fonts/Spleen5x8.woff2`
- Verification asserts the invariants that actually matter: single advance width,
  `isFixedPitch`, an exactly-1.000em line box, an integer advance at `font-size: 8px`, and no
  gaps in ASCII / Latin-1 / light-box / block ranges
- `PREVIEW_FONT_FAMILY` + `PREVIEW_CELL` exported from `lib/fonts.ts`; `@font-face` with
  `font-display: block`. Deliberately **not** in `FONT_FAMILIES` — it is not a terminal font

**`web/src/lib/preview-crop.ts`** — the single crop implementation (D3), consumed by both
sources so active and idle cards are geometrically identical.

**`web/src/lib/preview-canvas.ts`** — cell-grid → canvas renderer. Takes cell dimensions as
parameters so the Spleen fallback is a one-line change.

**`terminal-registry.previewRegion(paneId, cols, rows)`** — a *narrow* addition. The existing
`serializeSnapshot` walks the entire viewport (~10k cells); at 6 Hz that is not free. This walks
only the ~18 rows needed.

**`theme.ts`** — extend `paletteToCSSVars` to emit all 16 ANSI colors as `--mux-ansi-0..15`.
Today only 8 of 21 palette entries are exposed, which is not enough to color a terminal tile.
Generally useful beyond this feature.

**sessiond**
- `VTBuffer.Size() (cols, rows int)` — trivial wrapper over `emu.Width()/Height()`; no accessor
  exists today
- `VTBuffer.PreviewTile(cols, rows)` — `CellAt` over `Bounds()`, bottom-anchored, sanitized
- `Pane.lastWrite` + `previewDirty`, set in `readLoop` (D6)
- preview ticker: 250ms, examines only dirty workspaces, FNV-1a hashes the tile, emits only on
  change and at most every 500ms per workspace. An idle machine sends zero bytes.
- `subscriber.enqueuePreview` (D5)

**Protocol** — one additive request/event pair on the existing flat `Message` struct:

```
preview-subscribe   { enabled: bool }              browser -> daemon
workspace-preview   { workspaceId, paneId, title,
                      cols, rows, lines: []string } daemon -> browser
```

Do **not** reuse `pane-update`: it is declared in `types.ts:72` with no Go counterpart and is
referenced by `protocol.types.test.ts`. Dead vocabulary, and a landmine.

The five edit points for a new daemon→browser event are `protocol.go` const → `client.go`
`Handlers` field → `client.go` `dispatchEvent` case → `ws.go` relay closure → `types.ts`/`ws.ts`.
Omitting the `dispatchEvent` case is the silent-drop failure mode.

## Sanitization

Done server-side so the client stays dumb and the wire stays small:

- Heavy / double / dashed / rounded box variants → their **light** equivalent\n- Anything else outside ASCII + Latin-1 + the light box + block set → space
- `Cell.Width == 2` (CJK, emoji) → **two `▒`**. Unrenderable at 5x8, but "dense content here"
  is more honest than a blank
- Rows emitted as exactly `cols` chars, then trailing-trimmed for transport

## Failure Handling

| Failure | Behavior |
|---|---|
| Font fails to load | `document.fonts.check('6px TomThumb')` is false → **fall back to today's hint-line card**. Never draw at 6px in fallback monospace; that is unreadable garbage. |
| Old daemon, new browser (self-update reality) | `preview-subscribe` errors or is unknown → client stays on hint-line cards, silently. Must not throw. |
| New daemon, old browser | Old client never subscribes, receives nothing. Safe by construction — this is the payoff of opt-in over `broadcastAll`. |
| Slow client | Preview frames dropped by `enqueuePreview`. Never disconnects. |
| Tile for unknown workspace | Dropped. |
| Non-VT pane | Well-formed empty tile → icon placeholder. Follows the `server.go:448-472` precedent of empty-not-error. |
| sessiond restart | Client re-subscribes on reattach; previews resume. |

## Verification

Per `AGENTS.md`: no unit tests. `make build`, run, verify in a real browser with
`playwright-cli` / `/muxterm-verify`.

0. **The eye test.** Render the Tom Thumb card at 190x110 and look at it. This is a human gate,
   before any of the rest is worth building. Tom Thumb vs Spleen is decided here.
1. Three workspaces, each card shows a readable tile.
2. `yes hello` in a **detached** workspace → its card animates within ~1s; its dot turns bell.
3. Switch workspaces → previously-detached goes live/full-color, previously-active dims to
   monochrome, bell clears.
4. Drag the sidebar wider → more columns appear, text stays crisp.
5. **Browser zoom to 110%** → tile stays crisp. This is the specific canvas payoff; verify it
   explicitly, because it is the one thing DOM text cannot do.
6. Switch to `github-light` → card background follows `--mux-bg`, scrim and text still legible.
7. Browser pane as the only pane → icon placeholder, not a blank or garbled tile.
8. `preview = "off"` → today's layout returns, and devtools confirms **no frames on the wire**.
9. Background the tab for 60s under heavy output, foreground it → session survives (this is the
   D5 backpressure test, and it is the one that would otherwise bite in production).
10. Open a TUI (htop, lazygit) → borders render, not tofu. Validates the hand-authored glyphs.

## Rollout

**Phase 0 — font. DONE.** Pipeline in `tools/font/`, `Spleen5x8.woff2` (4,748 B) committed,
`@font-face` wired. Eye test passed against real captured Amplifier output; Spleen chosen over
Tom Thumb, Miniwi and unscii-8 side by side. Two gaps found and closed in the process: the
missing block elements and the contrast floor (D1b).

**Phase 1 — client only.** Active workspace card renders from the local xterm buffer. **No
protocol change at all.** This ships visible value on its own and de-risks the font, the canvas
renderer, the crop rule, and the whole card treatment before the daemon is touched.

**Phase 2 — protocol.** `preview-subscribe` + `workspace-preview` for detached workspaces.

**Phase 3 — riders.** Workspace bell revival (D7), `[sidebar]` config, density modes.

Phase 1 standing alone is the important property here. If the visual design is wrong, we find
out before writing a line of Go.

## Assumptions and Risks

- **Legibility was settled by eye, not by model.** A vision model transcribed a 3x render of
  the Spleen card near-perfectly, but that only measures whether the information is in the
  bitmap. It was also unable to distinguish the contrast-floor A/B at all — the documented
  blind spot for sub-10px type. The native-size side-by-side is what decided this.
- **Privacy.** Previously-hidden workspace content becomes visible in the sidebar — relevant
  when screen-sharing. `preview = "off"` is the answer and should be discoverable. Password
  prompts are unaffected (the emulator never echoes them).
- **Vertical budget.** ~6 cards before scrolling. Heavy workspace users will scroll; `compact`
  is the escape hatch.
- **`color-mix` and `backdrop-filter`** are 2023-era. Fine for muxterm's floor (Lit 3, dockview,
  es2021), but `backdrop-filter` should degrade gracefully rather than be depended on.
- **Alt-screen anchoring** is an open question (D3).
- **CPU.** Six workspaces x 2 Hz canvas redraws is small, but the redraw must be gated on
  `document.visibilityState` and on the sidebar actually being mounted.

## Shared Seams

- `subscriber.enqueuePreview` establishes a **droppable-frame class** in a protocol where every
  frame is currently mandatory. Any future advisory/cosmetic push should use it.
- `Pane.lastWrite` is the first output-timestamp in sessiond. Several things have wanted it
  (activity sorting, idle detection); it is now available.
- `--mux-ansi-0..15` unblocks any UI that needs to speak in terminal colors.
- `preview-crop.ts` is the reusable "meaningful crop of a terminal grid" rule — applicable to
  the mobile pane picker and to dock tab hover previews.
