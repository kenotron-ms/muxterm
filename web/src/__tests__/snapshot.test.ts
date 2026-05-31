import { describe, it, expect } from 'vitest';
import {
  serializeSnapshot,
  type SnapshotSource,
  type IBufferLineLike,
  type IBufferCellLike,
} from '../lib/snapshot';

// ---------------------------------------------------------------------------
// Hand-built fixture: 3 cols × 2 rows
// row 0: 'Bi ' — col 0 = styled 'B' (fg=4, bg=0, bold, underline), col 1 = 'i', col 2 = ' '
// row 1: all blank
// ---------------------------------------------------------------------------

function makeCell(
  char: string,
  width: number,
  fg: number,
  bg: number,
  bold: number,
  inverse: number,
  underline: number,
): IBufferCellLike {
  return {
    getChars: () => char,
    getWidth: () => width,
    getFgColor: () => fg,
    getBgColor: () => bg,
    isBold: () => bold,
    isInverse: () => inverse,
    isUnderline: () => underline,
  };
}

function makeLine(
  cells: Array<IBufferCellLike | undefined>,
  rowText: string,
): IBufferLineLike {
  return {
    getCell: (x: number) => cells[x],
    translateToString: (_trimRight?: boolean) => rowText,
  };
}

const styledB = makeCell('B', 1, 4, 0, 1, 0, 1);
const normalI = makeCell('i', 1, -1, -1, 0, 0, 0);
const blankCell = makeCell(' ', 1, -1, -1, 0, 0, 0);

const row0 = makeLine([styledB, normalI, blankCell], 'Bi ');
const row1 = makeLine([undefined, undefined, undefined], '   ');

const fixture: SnapshotSource = {
  cols: 3,
  rows: 2,
  buffer: {
    active: {
      viewportY: 0,
      baseY: 0,
      cursorX: 1,
      cursorY: 0,
      getLine: (y: number) => {
        if (y === 0) return row0;
        if (y === 1) return row1;
        return undefined;
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serializeSnapshot', () => {
  it('captures rows, cols, cursor, viewportY, and baseY', () => {
    const snap = serializeSnapshot(fixture);
    expect(snap.rows).toBe(2);
    expect(snap.cols).toBe(3);
    expect(snap.cursor).toEqual({ x: 1, y: 0 });
    expect(snap.viewportY).toBe(0);
    expect(snap.baseY).toBe(0);
  });

  it('preserves trailing blanks per row (rowText width = cols, not right-trimmed)', () => {
    const snap = serializeSnapshot(fixture);
    expect(snap.rowText[0]).toBe('Bi ');
    expect(snap.rowText[1]).toBe('   ');
    expect(snap.rowText[0].length).toBe(3);
    expect(snap.rowText[1].length).toBe(3);
  });

  it('serializes styled cell with all attributes', () => {
    const snap = serializeSnapshot(fixture);
    const cell = snap.cells[0][0];
    expect(cell.char).toBe('B');
    expect(cell.width).toBe(1);
    expect(cell.fg).toBe(4);
    expect(cell.bg).toBe(0);
    expect(cell.bold).toBe(true);
    expect(cell.inverse).toBe(false);
    expect(cell.underline).toBe(true);
  });

  it('produces a rows × cols cell grid (cells.length=2, cells[0].length=3)', () => {
    const snap = serializeSnapshot(fixture);
    expect(snap.cells.length).toBe(2);
    expect(snap.cells[0].length).toBe(3);
  });
});
