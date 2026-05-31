/**
 * snapshot.ts — pure serializer for the xterm terminal viewport.
 *
 * Works against a minimal structural interface (`SnapshotSource`) rather than
 * the full xterm `Terminal` class, making it unit-testable with hand-built
 * fake buffers without needing a real DOM or the xterm canvas renderer.
 */

// ---------------------------------------------------------------------------
// Cell & snapshot types
// ---------------------------------------------------------------------------

export interface Cell {
  char: string;
  width: number;
  fg: number;
  bg: number;
  bold: boolean;
  inverse: boolean;
  underline: boolean;
}

export interface StructuredSnapshot {
  rows: number;
  cols: number;
  cells: Cell[][];
  rowText: string[];
  cursor: { x: number; y: number };
  viewportY: number;
  baseY: number;
}

// ---------------------------------------------------------------------------
// Minimal structural interfaces (NOT the full xterm Terminal)
// ---------------------------------------------------------------------------

export interface IBufferCellLike {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  /** Returns a non-zero number when bold. */
  isBold(): number;
  /** Returns a non-zero number when inverse. */
  isInverse(): number;
  /** Returns a non-zero number when underline. */
  isUnderline(): number;
}

export interface IBufferLineLike {
  getCell(x: number, cell?: IBufferCellLike): IBufferCellLike | undefined;
  translateToString(trimRight?: boolean): string;
}

export interface IBufferLike {
  readonly viewportY: number;
  readonly baseY: number;
  readonly cursorX: number;
  readonly cursorY: number;
  getLine(y: number): IBufferLineLike | undefined;
}

export interface SnapshotSource {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: IBufferLike;
  };
}

// ---------------------------------------------------------------------------
// Default cell for missing/undefined cells
// ---------------------------------------------------------------------------

const MISSING_CELL: Cell = {
  char: '',
  width: 0,
  fg: -1,
  bg: -1,
  bold: false,
  inverse: false,
  underline: false,
};

// ---------------------------------------------------------------------------
// Pure serializer
// ---------------------------------------------------------------------------

/**
 * Serialize the visible viewport of `term` into a `StructuredSnapshot`.
 *
 * Captures rows `buffer.active.viewportY` through `viewportY + rows - 1`.
 * `rowText` is produced with `translateToString(false)` so trailing blanks
 * ('to the blank') are preserved.  Missing lines fall back to
 * `' '.repeat(cols)`; missing cells fall back to `MISSING_CELL`.
 */
export function serializeSnapshot(term: SnapshotSource): StructuredSnapshot {
  const { cols, rows } = term;
  const buf = term.buffer.active;
  const { viewportY, baseY, cursorX, cursorY } = buf;

  const cells: Cell[][] = [];
  const rowText: string[] = [];

  for (let rowIdx = 0; rowIdx < rows; rowIdx++) {
    const lineY = viewportY + rowIdx;
    const line = buf.getLine(lineY);

    if (!line) {
      // Missing line — use blank fallbacks
      cells.push(Array.from({ length: cols }, () => ({ ...MISSING_CELL })));
      rowText.push(' '.repeat(cols));
      continue;
    }

    // false = do NOT trim right, so trailing blanks are preserved
    rowText.push(line.translateToString(false));

    const rowCells: Cell[] = [];
    for (let col = 0; col < cols; col++) {
      const cell = line.getCell(col);
      if (!cell) {
        rowCells.push({ ...MISSING_CELL });
      } else {
        rowCells.push({
          char: cell.getChars(),
          width: cell.getWidth(),
          fg: cell.getFgColor(),
          bg: cell.getBgColor(),
          bold: cell.isBold() !== 0,
          inverse: cell.isInverse() !== 0,
          underline: cell.isUnderline() !== 0,
        });
      }
    }
    cells.push(rowCells);
  }

  return {
    rows,
    cols,
    cells,
    rowText,
    cursor: { x: cursorX, y: cursorY },
    viewportY,
    baseY,
  };
}
