import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResizeCoalescer, type ResizeSink } from './resize-coalescer';
import type { CellBudget } from './cell-budget';

describe('ResizeCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces a burst to one emit (latest-wins)', () => {
    const calls: Array<[string, CellBudget]> = [];
    const sink: ResizeSink = (id, budget) => calls.push([id, budget]);
    const coalescer = new ResizeCoalescer(sink, 40);

    coalescer.push('s1', { cols: 80, rows: 24 });
    coalescer.push('s1', { cols: 90, rows: 30 });
    coalescer.push('s1', { cols: 100, rows: 40 });

    // Nothing emitted yet — timer hasn't fired
    expect(calls).toHaveLength(0);

    vi.advanceTimersByTime(40);

    // Only the latest budget was emitted
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['s1', { cols: 100, rows: 40 }]);
  });

  it('no-ops when the budget did not cross a cell boundary (== lastSent)', () => {
    const calls: Array<[string, CellBudget]> = [];
    const sink: ResizeSink = (id, budget) => calls.push([id, budget]);
    const coalescer = new ResizeCoalescer(sink, 40);

    // First push — fires after timer
    coalescer.push('s1', { cols: 80, rows: 24 });
    vi.advanceTimersByTime(40);
    expect(calls).toHaveLength(1);

    // Second push with the SAME budget — should be dropped (no-op)
    coalescer.push('s1', { cols: 80, rows: 24 });
    vi.advanceTimersByTime(40);

    // Still only 1 total emit
    expect(calls).toHaveLength(1);
  });

  it('emits again once cells actually change', () => {
    const calls: Array<[string, CellBudget]> = [];
    const sink: ResizeSink = (id, budget) => calls.push([id, budget]);
    const coalescer = new ResizeCoalescer(sink, 40);

    // First emit
    coalescer.push('s1', { cols: 80, rows: 24 });
    vi.advanceTimersByTime(40);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ cols: 80, rows: 24 });

    // Same budget — no-op
    coalescer.push('s1', { cols: 80, rows: 24 });
    vi.advanceTimersByTime(40);
    expect(calls).toHaveLength(1);

    // Different budget — should emit again
    coalescer.push('s1', { cols: 120, rows: 48 });
    vi.advanceTimersByTime(40);
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual({ cols: 120, rows: 48 });
  });

  it('keeps per-surface budgets independent', () => {
    const calls: Array<[string, CellBudget]> = [];
    const sink: ResizeSink = (id, budget) => calls.push([id, budget]);
    const coalescer = new ResizeCoalescer(sink, 40);

    coalescer.push('s1', { cols: 80, rows: 24 });
    coalescer.push('s2', { cols: 40, rows: 10 });

    expect(calls).toHaveLength(0);

    vi.advanceTimersByTime(40);

    expect(calls).toHaveLength(2);
    const s1Call = calls.find(([id]) => id === 's1');
    const s2Call = calls.find(([id]) => id === 's2');
    expect(s1Call).toEqual(['s1', { cols: 80, rows: 24 }]);
    expect(s2Call).toEqual(['s2', { cols: 40, rows: 10 }]);
  });
});
