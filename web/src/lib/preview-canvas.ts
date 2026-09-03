/**
 * preview-canvas.ts — draws a PreviewTile into a <canvas> with the bitmap
 * preview font.
 *
 * The rendering contract in tools/font/README.md is measured, not stylistic:
 * a 5x8 bitmap font is only crisp at an integer font-size AND an integer device
 * scale. Get either wrong and every glyph edge antialiases (71 distinct colours
 * versus 3 in a monochrome tile), which at this size is illegible mush.
 */

import { PREVIEW_CELL, PREVIEW_FONT_FAMILY } from './fonts.js';
import { parseHexRgb } from './ansi-approx.js';
import type { Rgb } from './ansi-approx.js';
import type { PreviewTile } from './preview-tile.js';

export interface RenderOptions {
  /** 16 ANSI colours as CSS hex, index 0..15. */
  palette: string[];
  /** Default foreground / terminal background. */
  fg: string;
  bg: string;
  /** Monochrome: ignore tile.fg/bg entirely and draw everything in `fg`. */
  mono?: boolean;
  /** Minimum contrast ratio against `bg`; 0 disables. Default 4.5. */
  contrastFloor?: number;
  /** CSS-pixel scale. Default 1. */
  scale?: number;
}

const DEFAULT_CONTRAST_FLOOR = 4.5;

/** Font spec — integer px, always. A fractional size destroys the bitmap. */
const FONT_SPEC = `${PREVIEW_CELL.h}px ${PREVIEW_FONT_FAMILY}`;

// ---------------------------------------------------------------------------
// Contrast floor (design decision D1b)
// ---------------------------------------------------------------------------

function srgbToLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. */
function relativeLuminance(c: Rgb): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

/** WCAG contrast ratio, (Llight + .05) / (Ldark + .05). */
function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Round half to even.
 *
 * Not cosmetic: the reference lift values recorded in the design doc
 * (#414868 -> #7a82a4, #15161e -> #7d829f) land exactly on .5 in one channel.
 * Math.round's round-half-up shifts both by one level.
 */
function roundHalfToEven(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function toHex(c: Rgb): string {
  const part = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return `#${part(c.r)}${part(c.g)}${part(c.b)}`;
}

const LIFT_MEMO = new Map<string, string>();
const LIFT_MEMO_LIMIT = 512;

function computeLift(colour: string, bg: string, fg: string, floor: number): string {
  const ink = parseHexRgb(colour);
  const back = parseHexRgb(bg);
  // Non-hex (a CSS var, a named colour) — no basis to reason about it.
  if (!ink || !back) return colour;
  if (contrastRatio(ink, back) >= floor) return colour;

  const target = parseHexRgb(fg);
  if (!target) return colour;

  // Blend toward the palette foreground in 5% steps. Luminance moves, hue does
  // not, and the first step that clears the floor wins — so a nearly-legible
  // colour barely shifts while a black-on-black one travels most of the way.
  for (let t = 0.05; t <= 1.0000001; t += 0.05) {
    const mixed: Rgb = {
      r: roundHalfToEven(ink.r + (target.r - ink.r) * t),
      g: roundHalfToEven(ink.g + (target.g - ink.g) * t),
      b: roundHalfToEven(ink.b + (target.b - ink.b) * t),
    };
    if (contrastRatio(mixed, back) >= floor) return toHex(mixed);
  }
  return fg;
}

/**
 * Lift `colour` until it clears `floor` against `bg`.
 *
 * At 8px with 1px strokes dim colours simply are not there — a terminal at 14px
 * puts roughly 3x the ink into a glyph and the preview has no such budget. This
 * is a preview-only transform; the terminal itself keeps true palette colours.
 *
 * Memoized because it otherwise runs per cell at several Hz.
 */
function liftColour(colour: string, bg: string, fg: string, floor: number): string {
  if (!(floor > 0)) return colour;
  const key = `${colour}|${bg}|${fg}|${floor}`;
  const hit = LIFT_MEMO.get(key);
  if (hit !== undefined) return hit;
  const lifted = computeLift(colour, bg, fg, floor);
  if (LIFT_MEMO.size >= LIFT_MEMO_LIMIT) LIFT_MEMO.clear();
  LIFT_MEMO.set(key, lifted);
  return lifted;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Draw `tile` into `canvas`, sizing the canvas to the tile's geometry. */
export function renderTile(canvas: HTMLCanvasElement, tile: PreviewTile, opts: RenderOptions): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cellW = PREVIEW_CELL.w;
  const cellH = PREVIEW_CELL.h;
  const cols = tile.cols;
  const rows = tile.rows;
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 1;

  // INTEGER device scale, never the raw devicePixelRatio. Scaling the context
  // by a fractional dpr (110% browser zoom, fractional-DPI displays) turns the
  // 5x8 cell into a fractional device-pixel cell and antialiases every glyph
  // edge. At an integer scale the browser instead resamples the finished bitmap
  // nearest-neighbour: chunky at odd zoom levels, but sharp. This is the single
  // most important line in the file.
  const k = Math.max(1, Math.floor((window.devicePixelRatio || 1) * scale));

  const deviceW = cols * cellW * k;
  const deviceH = rows * cellH * k;
  if (canvas.width !== deviceW) canvas.width = deviceW;
  if (canvas.height !== deviceH) canvas.height = deviceH;
  canvas.style.width = `${cols * cellW * scale}px`;
  canvas.style.height = `${rows * cellH * scale}px`;
  // Other half of the integer-scale bargain: nearest-neighbour resampling of
  // the finished bitmap when CSS size and device size disagree.
  canvas.style.imageRendering = 'pixelated';

  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.textBaseline = 'top';
  ctx.font = FONT_SPEC;

  const width = cols * cellW;
  const height = rows * cellH;
  ctx.fillStyle = opts.bg;
  ctx.fillRect(0, 0, width, height);

  const mono = opts.mono === true;
  const floor = opts.contrastFloor === undefined ? DEFAULT_CONTRAST_FLOOR : opts.contrastFloor;

  // Cell fills use raw palette colours: the contrast floor exists to keep ink
  // visible, and lifting a background would wash the cell out instead.
  const cellBg = tile.bg;
  if (!mono && cellBg) {
    for (let y = 0; y < rows; y++) {
      const row = cellBg[y];
      if (!row) continue;
      let x = 0;
      while (x < cols && x < row.length) {
        const idx = row[x];
        if (idx < 0) { x++; continue; }
        let end = x + 1;
        while (end < cols && end < row.length && row[end] === idx) end++;
        ctx.fillStyle = opts.palette[idx] ?? opts.bg;
        ctx.fillRect(x * cellW, y * cellH, (end - x) * cellW, cellH);
        x = end;
      }
    }
  }

  // Resolve the 17 possible ink colours once per frame rather than per run.
  const defaultInk = liftColour(opts.fg, opts.bg, opts.fg, floor);
  const ink: string[] = Array.from({ length: 16 }, (_, i) =>
    liftColour(opts.palette[i] ?? opts.fg, opts.bg, opts.fg, floor),
  );
  const inkFor = (idx: number): string =>
    idx >= 0 && idx < 16 ? ink[idx] : defaultInk;

  for (let y = 0; y < rows; y++) {
    const line = tile.lines[y];
    if (!line) continue;
    const fgRow = mono ? undefined : tile.fg?.[y];
    const py = y * cellH;
    const limit = Math.min(cols, line.length);
    let x = 0;
    while (x < limit) {
      if (line.charCodeAt(x) === 32) { x++; continue; }
      const idx = fgRow && x < fgRow.length ? fgRow[x] : -1;
      // Batch the run of same-coloured columns into one fillText. Safe because
      // the font's advance is exactly cellW for every glyph it carries, which
      // tools/font/build.sh asserts.
      let end = x + 1;
      while (end < limit && (fgRow && end < fgRow.length ? fgRow[end] : -1) === idx) end++;
      const run = line.slice(x, end).trimEnd();
      if (run !== '') {
        ctx.fillStyle = mono ? defaultInk : inkFor(idx);
        ctx.fillText(run, x * cellW, py);
      }
      x = end;
    }
  }
}

/**
 * Resolve when the preview font is usable; false means it is not.
 *
 * Callers must fall back to a text card on false — a 5x8 grid drawn in fallback
 * monospace at 8px is unreadable garbage, so this has to be detectable.
 *
 * Note this only reports honestly when the @font-face rule has been injected
 * (fonts.ts injectTerminalFonts): FontFaceSet.check() returns true for a family
 * no rule matches at all.
 */
export async function fontReady(): Promise<boolean> {
  const probe = 'M';
  try {
    const fonts = document.fonts;
    if (!fonts) return false;
    await fonts.load(FONT_SPEC, probe);
    await fonts.ready;
    return fonts.check(FONT_SPEC, probe);
  } catch {
    return false;
  }
}
