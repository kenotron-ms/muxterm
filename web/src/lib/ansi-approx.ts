/**
 * ansi-approx.ts — fold arbitrary terminal colours down to the 16 the sidebar
 * preview speaks.
 *
 * A PreviewTile carries one ANSI index per cell (see preview-tile.ts). xterm.js
 * and sessiond both hand out 256-colour and truecolour cells, so something has
 * to approximate. At a 5x8 cell nobody can tell #5f87af from ANSI 4 anyway —
 * what matters is that the approximation is stable and cheap, because it runs
 * per cell at several Hz.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored). Returns null for
 * anything else — callers treat null as "cannot reason about this colour".
 *
 * Lives here rather than in preview-canvas.ts so there is one hex parser:
 * the renderer's contrast floor needs exactly the same maths.
 */
export function parseHexRgb(hex: string): Rgb | null {
  if (typeof hex !== 'string') return null;
  const s = hex.trim().replace(/^#/, '');
  if (s.length === 3) {
    if (!/^[0-9a-fA-F]{3}$/.test(s)) return null;
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    return { r, g, b };
  }
  if (s.length === 6 || s.length === 8) {
    if (!/^[0-9a-fA-F]{6,8}$/.test(s)) return null;
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// xterm 256-colour cube
// ---------------------------------------------------------------------------

/** The six non-linear levels of the xterm 6x6x6 colour cube. */
const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

/**
 * RGB for an xterm 256-colour index.
 *
 * Indices 0..15 are deliberately NOT handled here: those *are* the palette, and
 * the caller already has the real colours for them. They return black so a
 * mistaken call is visibly wrong rather than subtly plausible.
 */
export function ansiFromXterm256(idx: number): Rgb {
  if (idx >= 16 && idx <= 231) {
    const n = idx - 16;
    return {
      r: CUBE_LEVELS[Math.floor(n / 36) % 6],
      g: CUBE_LEVELS[Math.floor(n / 6) % 6],
      b: CUBE_LEVELS[n % 6],
    };
  }
  if (idx >= 232 && idx <= 255) {
    const v = 8 + 10 * (idx - 232);
    return { r: v, g: v, b: v };
  }
  return { r: 0, g: 0, b: 0 };
}

// ---------------------------------------------------------------------------
// Nearest-of-16
// ---------------------------------------------------------------------------

/**
 * Memo of packed-RGB -> palette index.
 *
 * Keys carry a generation counter in the high bits so an entry can never
 * outlive the palette it was computed against, and the map is bounded: a
 * truecolour TUI can otherwise mint an unbounded number of distinct keys.
 */
const MEMO = new Map<number, number>();
const MEMO_LIMIT = 4096;

let generation = 0;
let generationSignature = '';
let generationRgb: Array<Rgb | null> = [];

function ensureGeneration(palette: string[]): void {
  const signature = palette.slice(0, 16).join('|');
  if (signature === generationSignature && generationRgb.length > 0) return;
  generationSignature = signature;
  generation = (generation + 1) & 0x3f;
  generationRgb = palette.slice(0, 16).map((c) => parseHexRgb(c));
  MEMO.clear();
}

function clamp255(v: number): number {
  const n = Math.round(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * Index of the palette entry closest to (r, g, b) by squared RGB distance.
 *
 * Squared distance in plain sRGB, not a perceptual space: at 5x8 with 1px
 * strokes the difference is invisible, and this is on a per-cell hot path.
 */
export function nearestAnsi(r: number, g: number, b: number, palette: string[]): number {
  ensureGeneration(palette);

  const rr = clamp255(r);
  const gg = clamp255(g);
  const bb = clamp255(b);
  const key = generation * 0x1000000 + ((rr << 16) | (gg << 8) | bb);

  const hit = MEMO.get(key);
  if (hit !== undefined) return hit;

  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < generationRgb.length; i++) {
    const p = generationRgb[i];
    if (!p) continue;
    const dr = rr - p.r;
    const dg = gg - p.g;
    const db = bb - p.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }

  if (MEMO.size >= MEMO_LIMIT) MEMO.clear();
  MEMO.set(key, best);
  return best;
}
