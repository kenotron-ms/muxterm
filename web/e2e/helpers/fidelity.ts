/**
 * fidelity.ts — pure content-fidelity helper.
 *
 * PURE function — no playwright or tmux imports.
 * Importable by both Vitest unit tests and the playwright-cli-driven E2E script.
 *
 * Compares tmux `capture-pane` text against an xterm StructuredSnapshot per row.
 * Right-trims both sides before comparing to tolerate the known difference:
 *   tmux right-trims trailing spaces; xterm snapshot preserves them.
 */

import type { StructuredSnapshot } from '../../src/lib/snapshot.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ContentDiff {
  row: number;
  expected: string;
  actual: string;
  reason: 'mismatch' | 'row-count';
}

export interface ContentResult {
  ok: boolean;
  diffs: ContentDiff[];
}

// ---------------------------------------------------------------------------
// compareContent
// ---------------------------------------------------------------------------

/**
 * Compare a tmux `capture-pane` string against an xterm `StructuredSnapshot`.
 *
 * @param capturePane - Raw text from `tmux capture-pane -p`, may have trailing newline.
 * @param snapshot    - StructuredSnapshot from the xterm viewport.
 * @returns ContentResult with ok=true when all rows match, otherwise diffs.
 */
export function compareContent(
  capturePane: string,
  snapshot: StructuredSnapshot,
): ContentResult {
  const diffs: ContentDiff[] = [];

  // Split capturePane by newline (strip trailing \n first)
  const captureRows = capturePane.replace(/\n$/, '').split('\n');
  const snapRows = snapshot.rowText;

  // Report row-count mismatch when the two sides have different row counts
  if (captureRows.length !== snapRows.length) {
    diffs.push({
      row: -1,
      expected: `${captureRows.length} rows`,
      actual: `${snapRows.length} rows`,
      reason: 'row-count',
    });
  }

  // Compare min(captureRows.length, snapRows.length) rows
  const minRows = Math.min(captureRows.length, snapRows.length);
  for (let i = 0; i < minRows; i++) {
    // Right-trim both sides — tolerates the tmux vs xterm trailing-space difference
    const captureTrimmed = captureRows[i].replace(/\s+$/, '');
    const snapTrimmed = snapRows[i].replace(/\s+$/, '');

    if (captureTrimmed !== snapTrimmed) {
      diffs.push({
        row: i,
        expected: captureTrimmed,
        actual: snapTrimmed,
        reason: 'mismatch',
      });
    }
  }

  return { ok: diffs.length === 0, diffs };
}

// ---------------------------------------------------------------------------
// Layout types
// ---------------------------------------------------------------------------

export interface MeasuredLayout {
  /** CSS px — element.scrollTop */
  scrollTop: number;
  /** px per row */
  rowHeight: number;
  /** CSS px — element.clientWidth */
  clientWidth: number;
  /** px per cell */
  cellWidth: number;
  /** expected visible row count */
  rows: number;
}

export interface LayoutDiff {
  field: 'scroll' | 'cols' | 'rows';
  expected: number;
  actual: number;
}

export interface LayoutResult {
  ok: boolean;
  diffs: LayoutDiff[];
}

// ---------------------------------------------------------------------------
// compareLayout
// ---------------------------------------------------------------------------

/**
 * Compare Playwright-CLI-measured DOM layout against a StructuredSnapshot's logical dimensions.
 *
 * Tolerates ±1 cell sub-pixel rounding with near().
 */
export function compareLayout(
  snapshot: StructuredSnapshot,
  measured: MeasuredLayout,
): LayoutResult {
  const diffs: LayoutDiff[] = [];

  // ±1 cell tolerance absorbs sub-pixel rounding
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;

  // Convert pixels to cell units
  const measuredRowsScrolled = Math.round(measured.scrollTop / measured.rowHeight);
  const measuredCols = Math.round(measured.clientWidth / measured.cellWidth);

  if (!near(measuredRowsScrolled, snapshot.viewportY)) {
    diffs.push({ field: 'scroll', expected: measuredRowsScrolled, actual: snapshot.viewportY });
  }

  if (!near(measuredCols, snapshot.cols)) {
    diffs.push({ field: 'cols', expected: measuredCols, actual: snapshot.cols });
  }

  if (!near(measured.rows, snapshot.rows)) {
    diffs.push({ field: 'rows', expected: measured.rows, actual: snapshot.rows });
  }

  return { ok: diffs.length === 0, diffs };
}
