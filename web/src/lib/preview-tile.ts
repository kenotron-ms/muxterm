/**
 * preview-tile.ts — the data model, sanitizer and crop rule behind the sidebar's
 * live workspace previews.
 *
 * Pure data. No DOM, no canvas, no colour maths — see preview-canvas.ts for the
 * renderer.
 *
 * Two independent producers feed a tile: the local xterm.js buffer (attached
 * workspace, full colour) and the sessiond push (detached workspaces,
 * monochrome). Both must land on *identical* geometry or the cards visibly
 * disagree, so the crop rule lives here exactly once and both go through it.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A fixed-geometry miniature of a terminal screen. */
export interface PreviewTile {
  cols: number;
  rows: number;
  /** Exactly `rows` entries, each exactly `cols` characters. */
  lines: string[];
  /** fg[y][x] = ANSI index 0..15, or -1 for default foreground. Absent = monochrome. */
  fg?: Int8Array[];
  /** bg[y][x] = ANSI index 0..15, or -1 for default background. Absent = no cell fills. */
  bg?: Int8Array[];
}

/** One source cell, as produced by either data source. */
export interface SourceCell {
  chars: string;   // may be '' (blank) or a multi-codepoint grapheme
  width: number;   // 0, 1, or 2 — AUTHORITATIVE, never guess it
  fg: number;      // ANSI 0..15, or -1 default
  bg: number;      // ANSI 0..15, or -1 default
}

/** Whatever a tile is cropped out of: an xterm buffer, a VT emulator, a fake. */
export interface TileSource {
  height: number;                        // total rows available
  cursorRow: number;                     // 0-based
  /** Row y, columns 0..cols-1. Implementations return at most `cols` cells. */
  rowCells(y: number, cols: number): SourceCell[];
  /** Cheap blank test used to find the content floor. */
  isRowBlank(y: number): boolean;
}

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

/**
 * Code points the preview font can actually draw.
 *
 * Spleen 5x8 ships ASCII, Latin-1 and eleven *light* box-drawing glyphs;
 * tools/font/addblocks.py adds U+2580..2593. Everything else is tofu, so the
 * sanitizer's whole job is to never emit anything outside this set.
 */
const LIGHT_BOX = new Set<number>(
  [...'─│┌┐└┘├┤┬┴┼'].map((c) => c.codePointAt(0) as number),
);

function isRenderable(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true;   // ASCII
  if (cp >= 0xa0 && cp <= 0xff) return true;   // Latin-1
  if (cp >= 0x2580 && cp <= 0x2593) return true; // block elements
  if (cp === 0x2022 || cp === 0x2026) return true; // • …
  return LIGHT_BOX.has(cp);
}

/**
 * Heavy / double / dashed / rounded box variants folded to their light
 * equivalent, plus a handful of common symbols folded to an ASCII stand-in.
 *
 * A table in code beats ~100 extra glyphs in the font. Every target here is in
 * the renderable set above — a fold to an unrenderable character would be a bug
 * that shows up as tofu.
 */
const FOLD = new Map<string, string>();
const fold = (from: string, to: string) => { for (const c of from) FOLD.set(c, to); };
fold('━┄┅┈┉╌╍═╾╼', '─');
fold('┃┆┇┊┋╎╏║╽╿', '│');
fold('┍┎┏╒╓╔╭', '┌');
fold('┑┒┓╕╖╗╮', '┐');
fold('┕┖┗╘╙╚╰', '└');
fold('┙┚┛╛╜╝╯', '┘');
fold('┝┞┟┠┡┢┣╞╟╠', '├');
fold('┥┦┧┨┩┪┫╡╢╣', '┤');
fold('┭┮┯┰┱┲┳╤╥╦', '┬');
fold('┵┶┷┸┹┺┻╧╨╩', '┴');
fold('┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╪╫╬', '┼');
// Geometric shapes fold to a shaded block: ▪ (U+25AA) is NOT in the font.
fold('■□▪▫◼◻●○◆◇', '▒');
fold('→⇒▶►', '>');
fold('←⇐◀◄', '<');
fold('↑⇑▲', '^');
fold('↓⇓▼', 'v');
fold('✓✔√', '+');
fold('✗✘×⨯', 'x');
fold('∙⋅', '•');
fold('–—―', '-');
fold('\u2018\u2019\u201a\u201b', "'");
fold('\u201C\u201D\u201e\u201f', '"');
// Diagonals and stubs: Go carries these, so the two paths must agree.
fold('╱', '/');
fold('╲', '\\');
fold('╳', 'X');
fold('╴╶╸╺', '─');
fold('╵╷╹╻', '│');

/** Wide-cell placeholder: unrenderable at 5x8, but "dense content here" is
 *  more honest than a blank. */
const WIDE = '▒▒';

/** Kept-a-character-was-here marker. U+00B7 is Latin-1, so the font has it. */
const GHOST = '·';

/**
 * Reduce one source cell to exactly `width` renderable characters
 * (1 for width-1, 2 for width-2, '' for width-0).
 *
 * The exact-length contract is load-bearing: cropToTile builds fixed-width
 * strings by concatenation, so a sanitizer that returned the "wrong" number of
 * characters would shear every row to its right.
 */
export function sanitizeChar(chars: string, width: number): string {
  if (!(width >= 1)) return '';        // width 0 (wide-char continuation), or junk
  const w = width >= 2 ? 2 : 1;

  if (chars === '' || chars.trim() === '') return w === 2 ? '  ' : ' ';

  // Width 2 short-circuits ahead of the renderable/fold checks: nothing in the
  // renderable set is double-width, so those rules can never legitimately fill
  // two columns, and honouring them here would break the length contract.
  if (w === 2) return WIDE;

  // Take the first code point only. A multi-codepoint grapheme (combining
  // marks, ZWJ emoji) still occupies one column, and the tail is never
  // renderable anyway.
  const cp = chars.codePointAt(0);
  if (cp === undefined) return ' ';
  const first = String.fromCodePoint(cp);

  // Folds are applied BEFORE the keep set, matching Go's sanitizeCell. Order
  // is observable: U+00D7 is Latin-1 and therefore "renderable", but a
  // multiplication sign in terminal output is almost always a failure mark, so
  // it must fold to 'x'. Checking renderable first silently made every
  // Latin-1 fold dead code -- and made the attached workspace disagree with
  // every other one, since only this path was reordered.
  const folded = FOLD.get(first);
  if (folded !== undefined) return folded;

  if (isRenderable(cp)) return first;

  return GHOST;
}

// ---------------------------------------------------------------------------
// Crop
// ---------------------------------------------------------------------------

function toCount(n: number): number {
  const v = Math.floor(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function blankAnsiRow(cols: number): Int8Array {
  const row = new Int8Array(cols);
  row.fill(-1);
  return row;
}

/** ANSI indices only; anything else (256-colour, truecolour, junk) is default. */
function toAnsiIndex(n: number): number {
  return Number.isInteger(n) && n >= 0 && n <= 15 ? n : -1;
}

/**
 * Crop a bottom-left window of `cols` x `rows` out of `src`.
 *
 * The anchor is *content*, not the grid: `bottom` is the lower of the last
 * non-blank row and the cursor row, never the literal bottom row of the
 * emulator. Without that, a 50-row pane holding 8 rows of output renders as an
 * empty tile. When there is less content than the tile is tall the blank rows
 * go at the TOP, so content sits on the floor exactly like a shell that has
 * only just started.
 */
export function cropToTile(src: TileSource, cols: number, rows: number): PreviewTile {
  const c = toCount(cols);
  const r = toCount(rows);
  const height = toCount(src.height);
  const cursorRow = Number.isFinite(src.cursorRow) ? Math.floor(src.cursorRow) : 0;

  let lastInk = 0;
  for (let y = height - 1; y >= 0; y--) {
    if (!src.isRowBlank(y)) { lastInk = y; break; }
  }

  // height 0 yields bottom = -1, which the read loop below skips entirely and
  // the tile comes out all-blank. That is the right answer for a dead source.
  const bottom = Math.min(height - 1, Math.max(lastInk, cursorRow));
  const top = Math.max(0, bottom - r + 1);
  const have = Math.max(0, bottom - top + 1);

  const lines: string[] = [];
  const fg: Int8Array[] = [];
  const bg: Int8Array[] = [];

  const blankLine = ' '.repeat(c);
  for (let i = have; i < r; i++) {
    lines.push(blankLine);
    fg.push(blankAnsiRow(c));
    bg.push(blankAnsiRow(c));
  }

  for (let y = top; y <= bottom && lines.length < r; y++) {
    const cells = src.rowCells(y, c);
    const fgRow = blankAnsiRow(c);
    const bgRow = blankAnsiRow(c);
    let text = '';
    let x = 0;

    for (const cell of cells) {
      if (x >= c) break;
      const glyph = sanitizeChar(cell.chars, cell.width);
      if (glyph === '') continue;          // width-0: continuation slot of a wide char
      const take = Math.min(glyph.length, c - x);
      text += glyph.slice(0, take);
      const cellFg = toAnsiIndex(cell.fg);
      const cellBg = toAnsiIndex(cell.bg);
      for (let i = 0; i < take; i++) {
        fgRow[x + i] = cellFg;
        bgRow[x + i] = cellBg;
      }
      x += take;
    }

    lines.push(text + ' '.repeat(c - x));
    fg.push(fgRow);
    bg.push(bgRow);
  }

  return { cols: c, rows: r, lines, fg, bg };
}

/**
 * Adapter for the sessiond push, which sends monochrome, trailing-trimmed rows
 * of one canonical 80x24 tile.
 *
 * Bottom-anchors identically to cropToTile (a crop of a bottom-left crop is
 * still a bottom-left crop, so this is exact rather than approximate). The
 * server sanitizes too — this re-sanitizes anyway, because the wire is not
 * trusted to have done it.
 */
export function tileFromLines(lines: string[], cols: number, rows: number): PreviewTile {
  const c = toCount(cols);
  const r = toCount(rows);

  const src = Array.isArray(lines) ? lines : [];
  const start = Math.max(0, src.length - r);
  const taken = src.slice(start, start + r);

  const out: string[] = [];
  const blankLine = ' '.repeat(c);
  for (let i = taken.length; i < r; i++) out.push(blankLine);

  for (const raw of taken) {
    let text = '';
    // Iterate code points, not UTF-16 units, or a stray surrogate pair on the
    // wire would be split in half and the row would come out the wrong length.
    for (const ch of typeof raw === 'string' ? raw : '') {
      if (text.length >= c) break;
      text += sanitizeChar(ch, 1);
    }
    out.push(text.length > c ? text.slice(0, c) : text + ' '.repeat(c - text.length));
  }

  return { cols: c, rows: r, lines: out };
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/** FNV-1a over the tile text. Used to skip redundant redraws. */
export function tileHash(tile: PreviewTile): number {
  const s = tile.lines.join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
