import { describe, it, expect } from 'vitest';
import {
  pxBoxToCells,
  cellsEqual,
  MIN_COLS,
  MIN_ROWS,
  CellBudgetManager,
  type BudgetSink,
  type CellBudget,
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

// ---------------------------------------------------------------------------
// CellBudgetManager tests
// ---------------------------------------------------------------------------

describe('CellBudgetManager', () => {
  it('setSurfacePixelBox emits a converted budget to the sink', () => {
    const calls: Array<[string, CellBudget]> = [];
    const sink: BudgetSink = (id, budget) => calls.push([id, budget]);
    const mgr = new CellBudgetManager(sink);

    mgr.setSurfaceMetrics('s1', { cellWidth: 8, cellHeight: 16 });
    mgr.setSurfacePixelBox('s1', { width: 800, height: 480 });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('s1');
    // 800 / 8 = 100 cols, 480 / 16 = 30 rows
    expect(calls[0][1]).toEqual({ cols: 100, rows: 30 });
  });

  it('emits on every call even when cell budget does not change (coalescer owns no-op)', () => {
    const calls: Array<[string, CellBudget]> = [];
    const sink: BudgetSink = (id, budget) => calls.push([id, budget]);
    const mgr = new CellBudgetManager(sink);

    mgr.setSurfaceMetrics('s1', { cellWidth: 8, cellHeight: 16 });
    // 800x480 => 100x30 cells
    mgr.setSurfacePixelBox('s1', { width: 800, height: 480 });
    // 801x481 => still 100x30 cells — same cell budget but different pixels
    mgr.setSurfacePixelBox('s1', { width: 801, height: 481 });

    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual({ cols: 100, rows: 30 });
    expect(calls[1][1]).toEqual({ cols: 100, rows: 30 });
  });

  it('uses minimum budget before metrics are set', () => {
    const calls: Array<[string, CellBudget]> = [];
    const sink: BudgetSink = (id, budget) => calls.push([id, budget]);
    const mgr = new CellBudgetManager(sink);

    // No metrics set — should use {cellWidth:0, cellHeight:0} → MIN budget
    mgr.setSurfacePixelBox('s1', { width: 800, height: 480 });

    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
  });

  it('observe() attaches a ResizeObserver and unobserve() detaches it', () => {
    /** Fake ResizeObserver that captures instances for test inspection. */
    class FakeRO {
      static instances: FakeRO[] = [];
      callback: ResizeObserverCallback;
      observedEls: Element[] = [];
      disconnected = false;

      constructor(cb: ResizeObserverCallback) {
        this.callback = cb;
        FakeRO.instances.push(this);
      }
      observe(el: Element) { this.observedEls.push(el); }
      unobserve(_el: Element) {}
      disconnect() { this.disconnected = true; }
    }
    FakeRO.instances = [];

    const origRO = (globalThis as unknown as Record<string, unknown>)['ResizeObserver'];
    (globalThis as unknown as Record<string, unknown>)['ResizeObserver'] = FakeRO;

    try {
      const calls: Array<[string, CellBudget]> = [];
      const sink: BudgetSink = (id, budget) => calls.push([id, budget]);
      const mgr = new CellBudgetManager(sink);

      // Fake element with measured dimensions
      const el = { clientWidth: 800, clientHeight: 480 } as unknown as HTMLElement;
      mgr.observe('s1', el, { cellWidth: 8, cellHeight: 16 });

      // Should have created one FakeRO and called observe(el) on it
      expect(FakeRO.instances).toHaveLength(1);
      const ro = FakeRO.instances[0];
      expect(ro.observedEls).toContain(el);

      // Trigger the resize callback — should forward to sink
      ro.callback([], null as unknown as ResizeObserver);
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('s1');
      expect(calls[0][1]).toEqual({ cols: 100, rows: 30 });

      // unobserve() should disconnect the observer
      mgr.unobserve('s1');
      expect(ro.disconnected).toBe(true);
    } finally {
      (globalThis as unknown as Record<string, unknown>)['ResizeObserver'] = origRO;
    }
  });
});
