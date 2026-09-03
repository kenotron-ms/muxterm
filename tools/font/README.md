# Sidebar preview font

The sidebar's live workspace previews render a terminal grid at a **5x8 pixel
cell**. That size rules out every normal monospace font, so the preview uses a
bitmap font converted to WOFF2 by `build.sh`.

**Output:** `web/public/fonts/Spleen5x8.woff2` (~4.7 KB) — committed, so a normal
`make build` needs neither Python nor network access. Re-run `build.sh` only when
the upstream font or the block-glyph set changes.

## The font

**Spleen 5x8**, by Frederic Cambus — <https://github.com/fcambus/spleen>
BSD-2-Clause, full text in `LICENSE.spleen`.

Verified from the source BDF: `SPACING "C"`, all 472 glyphs at `DWIDTH 5`,
full ASCII and Latin-1, plus the 11 light box-drawing characters that TUI
borders actually use (`─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`).

In a 220px sidebar it yields **41 columns x 13 rows** per card.

### Why not the others

| Candidate | Verdict |
|---|---|
| **Tiny5** | **Not monospace.** Five distinct ASCII advance widths (256/384/512/640/768); `post.isFixedPitch: False`; its own repo says "variable-width." Disqualified — a proportional font destroys column alignment. |
| **Tom Thumb** 4x6 | Genuinely monospace, MIT, and denser (51 cols). Legible, but Spleen won the side-by-side. Kept as the documented fallback: the pipeline is size-agnostic. |
| **Miniwi** 4x8 | Best coverage/density combination, but **GPL-3.0 with no font exception**. Not safe to ship in an MIT project. |
| **unscii-8** 8x8 | Excellent terminal font, public domain — and only 25 columns. Too wide. |
| **monogram** 6x9 | CC0 and monospace, but a 6px advance gives ~34 columns. |
| **m3x6 / m5x7** | Proportional, and licensed only as informal "free with attribution." |

## Why there is a build step

1. **Spleen ships no WOFF2 at 5x8.** Every other size (6x12, 8x16, 12x24,
   16x32, 32x64) has web fonts; 5x8 is BDF/PCF/PSF/OTB/FON only.

2. **Off-the-shelf BDF converters mangle metrics.** The popular Tom Thumb TTF on
   GitHub is not monospace despite being named `Tom Thumb Monospace.ttf`, and
   its `hhea` puts all ink below the baseline. `bdf2web.py` sets
   `unitsPerEm = cellHeight * 64`, so `font-size: 8px` produces an *exactly*
   integer 5px advance. This matters more than it sounds: measured in Chrome, an
   integer font-size renders with **2 distinct colours** (pure bitmap), while
   `8.5px` renders with **58** — nearly every ink pixel antialiased.

3. **Spleen has no block elements.** It carries 11 box-drawing glyphs but
   nothing in `U+2580..2593`. Blocks are load-bearing here — htop meters,
   progress bars, and the placeholder the preview substitutes for wide/emoji
   cells that no 5x8 bitmap font can draw. Without them those cells are tofu.
   `addblocks.py` generates the 8 needed glyphs from the cell dimensions read
   out of the BDF, so it works for any candidate font, not just this one.

## Pipeline

```
spleen-5x8.bdf              upstream, BSD-2-Clause
  -> filter.py              drop any non-modal advance width (enforce monospace)
  -> addblocks.py           add U+2580..2593 from the BDF's own cell geometry
  -> bdf2web.py             upem = cellH * 64, isFixedPitch, 1.000em line box
  -> Spleen5x8.woff2
```

`build.sh` runs all four and then asserts the invariants that actually matter:
single advance width, `isFixedPitch`, an exactly-1.000em line box, an integer
advance at `font-size: 8px`, and no gaps in ASCII / box-drawing / block ranges.

## Rendering contract

The cell geometry is only preserved if the consumer honours it:

- `font-size: 8px` and `line-height: 8px` — **integer, hard-coded px**. Anything
  that computes a fractional size (`rem` against a scaled root, `clamp()`, `%`,
  `vw`) destroys the font.
- Render to `<canvas>` at an **integer** device scale — `k = max(1, floor(dpr))`
  — with `image-rendering: pixelated`. Scaling the canvas context by a
  fractional `devicePixelRatio` (browser zoom at 110%, fractional-DPI displays)
  is exactly as bad as fractional CSS text: measured 71 distinct colours versus
  3. At an integer scale the browser resamples the finished bitmap with
  nearest-neighbour instead — chunky at odd zoom levels, but sharp.
- `await document.fonts.ready` before the first draw, or frame one silently
  renders in fallback monospace at 8px.

`image-rendering: pixelated` does nothing to text (it applies to images and
canvases). `-webkit-font-smoothing: none` is macOS-only. There is no
cross-platform CSS switch for disabling text antialiasing — which is exactly why
the geometry has to be right.
