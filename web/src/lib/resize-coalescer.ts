import { cellsEqual, type CellBudget } from './cell-budget.js';

/** Callback type for emitting a coalesced resize to the PTY channel. */
export type ResizeSink = (surfaceId: string, budget: CellBudget) => void;

/**
 * Outbound resize coalescer — CELL clock: debounce ~40ms, latest-wins, no-op
 * when no cell boundary was crossed.
 *
 * Protects the PTY channel from a 60fps drag flood by:
 * 1. Debouncing rapid pushes (latest-wins within each window).
 * 2. Suppressing emits when the cell budget hasn't changed since last send.
 */
export class ResizeCoalescer {
  private pending: Map<string, CellBudget> = new Map();
  private lastSent: Map<string, CellBudget> = new Map();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private sink: ResizeSink,
    private delayMs = 40,
  ) {}

  /**
   * Push a new budget for a surface.
   *
   * If the budget equals the last sent value (no cell boundary crossed), drop
   * the event and remove any stale pending entry.  Otherwise record as the
   * latest pending value and schedule a flush.
   */
  push(surfaceId: string, budget: CellBudget): void {
    const last = this.lastSent.get(surfaceId);
    if (last !== undefined && cellsEqual(last, budget)) {
      // No cell boundary crossed — drop and clean up any stale pending
      this.pending.delete(surfaceId);
      return;
    }
    // Latest-wins: overwrite any earlier pending value
    this.pending.set(surfaceId, budget);
    this.schedule();
  }

  /** Schedule a flush if no timer is already running. */
  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /**
   * Flush all pending budgets that still differ from lastSent, emit them,
   * update lastSent, and clear pending.
   */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;

    for (const [surfaceId, budget] of this.pending) {
      const last = this.lastSent.get(surfaceId);
      if (last === undefined || !cellsEqual(last, budget)) {
        this.sink(surfaceId, budget);
        this.lastSent.set(surfaceId, budget);
      }
    }
    this.pending.clear();
  }

  /** Remove a surface from tracking (call on unmount). */
  forget(surfaceId: string): void {
    this.pending.delete(surfaceId);
    this.lastSent.delete(surfaceId);
  }

  /** Cancel the pending timer and clear all state. */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.lastSent.clear();
  }
}
