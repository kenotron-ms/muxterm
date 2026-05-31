import { describe, it, expect } from 'vitest';
import { compareContent, compareLayout } from '../../e2e/helpers/fidelity';
import type { MeasuredLayout } from '../../e2e/helpers/fidelity';
import type { StructuredSnapshot } from '../lib/snapshot';

// Minimal fixture builder — only rowText and shape metadata matter for compareContent
function makeSnap(rowText: string[], cols = 8): StructuredSnapshot {
  return {
    rows: rowText.length,
    cols,
    cells: rowText.map(() => []),
    rowText,
    cursor: { x: 0, y: 0 },
    viewportY: 0,
    baseY: 0,
  };
}

describe('compareContent', () => {
  it('passes when capture-pane text equals snapshot text per row (trailing blanks normalized)', () => {
    // tmux right-trims; snapshot keeps trailing blanks → both normalised to 'hello' / 'world'
    const snap = makeSnap(['hello   ', 'world   '], 8);
    const result = compareContent('hello\nworld', snap);
    expect(result.ok).toBe(true);
    expect(result.diffs).toEqual([]);
  });

  it('fails and reports first divergent row', () => {
    const snap = makeSnap(['hello   ', 'world   ']);
    const result = compareContent('hello\nWRONG', snap);
    expect(result.ok).toBe(false);
    expect(result.diffs[0].row).toBe(1);
    expect(result.diffs[0].expected).toBe('WRONG');
    expect(result.diffs[0].actual).toBe('world');
  });

  it('fails when row counts differ', () => {
    const snap = makeSnap(['a', 'b']);
    const result = compareContent('a\nb\nc', snap);
    expect(result.ok).toBe(false);
    expect(result.diffs.some(d => d.reason === 'row-count')).toBe(true);
  });
});

// Fixture builder for layout tests — only viewportY, cols, rows matter for compareLayout
function makeLayoutSnap(viewportY: number, cols: number, rows: number): StructuredSnapshot {
  return {
    rows,
    cols,
    cells: Array.from({ length: rows }, () => []),
    rowText: Array.from({ length: rows }, () => ''),
    cursor: { x: 0, y: 0 },
    viewportY,
    baseY: 0,
  };
}

describe('compareLayout', () => {
  // measured: scrollTop=200, rowHeight=20 → 10 rows scrolled
  //           clientWidth=800, cellWidth=10 → 80 cols
  const measured: MeasuredLayout = {
    scrollTop: 200,
    rowHeight: 20,
    clientWidth: 800,
    cellWidth: 10,
    rows: 24,
  };

  it('passes when logical viewportY and dims match measured', () => {
    const snap = makeLayoutSnap(10, 80, 24);
    const result = compareLayout(snap, measured);
    expect(result.ok).toBe(true);
    expect(result.diffs).toEqual([]);
  });

  it('fails on scroll drift', () => {
    const snap = makeLayoutSnap(7, 80, 24);
    const result = compareLayout(snap, measured);
    expect(result.ok).toBe(false);
    expect(result.diffs.some(d => d.field === 'scroll')).toBe(true);
  });

  it('fails on width miscalc', () => {
    const snap = makeLayoutSnap(10, 70, 24);
    const result = compareLayout(snap, measured);
    expect(result.ok).toBe(false);
    expect(result.diffs.some(d => d.field === 'cols')).toBe(true);
  });
});
