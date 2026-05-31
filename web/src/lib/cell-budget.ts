/** Measured pixel dimensions of one terminal surface (NOT window dimensions). */
export interface PixelBox {
  width: number;
  height: number;
}

/** Measured size of one terminal character cell in CSS pixels. */
export interface CellMetrics {
  cellWidth: number;
  cellHeight: number;
}

/** Whole-cell budget — the value that crosses the sizing layer boundary. */
export interface CellBudget {
  cols: number;
  rows: number;
}

/** tmux refuses absurd sizes; never emit below these. */
export const MIN_COLS = 2;
export const MIN_ROWS = 1;

/**
 * Convert a pixel box to a whole-cell budget.
 * Floors fractional cells and clamps to MIN_COLS / MIN_ROWS.
 * If metrics.cellWidth <= 0 or cellHeight <= 0, returns minimum values.
 */
export function pxBoxToCells(box: PixelBox, metrics: CellMetrics): CellBudget {
  if (metrics.cellWidth <= 0 || metrics.cellHeight <= 0) {
    return { cols: MIN_COLS, rows: MIN_ROWS };
  }
  const cols = Math.max(MIN_COLS, Math.floor(box.width / metrics.cellWidth));
  const rows = Math.max(MIN_ROWS, Math.floor(box.height / metrics.cellHeight));
  return { cols, rows };
}

/**
 * Returns true when two cell budgets are identical.
 * Used to no-op resizes when nothing has changed.
 */
export function cellsEqual(a: CellBudget, b: CellBudget): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}
