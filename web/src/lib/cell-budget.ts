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

// ---------------------------------------------------------------------------
// CellBudgetManager — per-surface resize tracking (Seam S3)
// ---------------------------------------------------------------------------

/** Callback type that receives a surface's converted cell budget. */
export type BudgetSink = (surfaceId: string, budget: CellBudget) => void;

/**
 * Tracks one ResizeObserver per terminal surface.
 *
 * `setSurfacePixelBox` is the single input-agnostic entry point: it converts
 * pixel dimensions to cells and always forwards to the sink.  No dedup happens
 * here — that responsibility belongs to the downstream coalescer.
 */
export class CellBudgetManager {
  private metrics = new Map<string, CellMetrics>();
  private observers = new Map<string, ResizeObserver>();

  constructor(private sink: BudgetSink) {}

  /** Record (or update) the measured character-cell size for a surface. */
  setSurfaceMetrics(surfaceId: string, metrics: CellMetrics): void {
    this.metrics.set(surfaceId, metrics);
  }

  /**
   * THE single input-agnostic resize entry point.
   *
   * Converts a pixel box to cells using the surface's current metrics (falls
   * back to {cellWidth:0, cellHeight:0} → minimum budget when metrics are
   * unknown) and forwards every call to the sink unconditionally.
   */
  setSurfacePixelBox(surfaceId: string, box: PixelBox): void {
    const m = this.metrics.get(surfaceId) ?? { cellWidth: 0, cellHeight: 0 };
    const budget = pxBoxToCells(box, m);
    this.sink(surfaceId, budget);
  }

  /**
   * Attach a ResizeObserver to `el` for the given surface.
   *
   * Records `metrics`, tears down any previous observer for this surface, then
   * creates a new ResizeObserver that calls `setSurfacePixelBox` whenever the
   * element's size changes.  No-op when `ResizeObserver` is not available in
   * the environment.
   */
  observe(surfaceId: string, el: HTMLElement, metrics: CellMetrics): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.setSurfaceMetrics(surfaceId, metrics);
    this.unobserve(surfaceId);
    const ro = new ResizeObserver(() => {
      this.setSurfacePixelBox(surfaceId, {
        width: el.clientWidth,
        height: el.clientHeight,
      });
    });
    ro.observe(el);
    this.observers.set(surfaceId, ro);
  }

  /** Disconnect and remove the ResizeObserver for a surface. */
  unobserve(surfaceId: string): void {
    const ro = this.observers.get(surfaceId);
    if (ro) {
      ro.disconnect();
      this.observers.delete(surfaceId);
    }
  }

  /** Disconnect all observers and clear all internal state. */
  dispose(): void {
    for (const ro of this.observers.values()) {
      ro.disconnect();
    }
    this.observers.clear();
    this.metrics.clear();
  }
}
