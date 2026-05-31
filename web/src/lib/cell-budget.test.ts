import { describe, it, expect } from 'vitest';
import {
  pxBoxToCells,
  cellsEqual,
  MIN_COLS,
  MIN_ROWS,
} from './cell-budget';

describe('pxBoxToCells', () => {
  it('floors pixels to whole cells', () => {
    const budget = pxBoxToCells(
      { width: 800, height: 600 },
      { cellWidth: 8, cellHeight: 16 },
    );
    // 800 / 8 = 100 cols; 600 / 16 = 37.5 -> floor -> 37 rows
    expect(budget.cols).toBe(100);
    expect(budget.rows).toBe(37);
  });

  it('clamps to MIN_COLS / MIN_ROWS on a tiny box', () => {
    const budget = pxBoxToCells(
      { width: 1, height: 1 },
      { cellWidth: 8, cellHeight: 16 },
    );
    // 1/8 = 0.125 -> floor -> 0, but clamped to MIN_COLS/MIN_ROWS
    expect(budget.cols).toBe(MIN_COLS);
    expect(budget.rows).toBe(MIN_ROWS);
  });

  it('returns minimum budget when cell metrics are not yet measured (0)', () => {
    const budget = pxBoxToCells(
      { width: 800, height: 600 },
      { cellWidth: 0, cellHeight: 0 },
    );
    expect(budget.cols).toBe(MIN_COLS);
    expect(budget.rows).toBe(MIN_ROWS);
  });
});

describe('cellsEqual', () => {
  it('compares both dimensions', () => {
    expect(cellsEqual({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    expect(cellsEqual({ cols: 80, rows: 24 }, { cols: 81, rows: 24 })).toBe(false);
    expect(cellsEqual({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(false);
  });
});
