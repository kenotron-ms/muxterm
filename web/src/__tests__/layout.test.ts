import { describe, it, expect } from 'vitest';
import { viewportClassFor, arrange } from '../lib/layout.js';
import type { Composition } from '../lib/layout.js';

describe('viewportClassFor', () => {
  it('classifies wide viewports', () => {
    expect(viewportClassFor(1280)).toBe('wide');
    expect(viewportClassFor(1024)).toBe('wide');
  });

  it('classifies medium viewports', () => {
    expect(viewportClassFor(900)).toBe('medium');
    expect(viewportClassFor(640)).toBe('medium');
  });

  it('classifies narrow viewports', () => {
    expect(viewportClassFor(480)).toBe('narrow');
    expect(viewportClassFor(0)).toBe('narrow');
  });

  it('is monotonic with no gaps at the breakpoints', () => {
    expect(viewportClassFor(639)).toBe('narrow');
    expect(viewportClassFor(640)).toBe('medium');
    expect(viewportClassFor(1023)).toBe('medium');
    expect(viewportClassFor(1024)).toBe('wide');
  });
});

describe('arrange', () => {
  const comp = (paneIds: number[], activePaneId: number): Composition => ({
    paneIds,
    activePaneId,
  });

  it('wide tiles all panes with order preserved', () => {
    const result = arrange(comp([3, 1, 2], 1), 'wide');
    expect(result.mode).toBe('tiling');
    expect(result.order).toEqual([3, 1, 2]);
    expect(result.visible).toEqual([3, 1, 2]);
    expect(result.active).toBe(1);
  });

  it('narrow tabs to only the active pane visible', () => {
    const result = arrange(comp([3, 1, 2], 1), 'narrow');
    expect(result.mode).toBe('tabbed');
    expect(result.order).toEqual([3, 1, 2]);
    expect(result.visible).toEqual([1]);
    expect(result.active).toBe(1);
  });

  it('medium shows at most 2 visible including the active pane', () => {
    const result = arrange(comp([3, 1, 2], 2), 'medium');
    expect(result.mode).toBe('tiling');
    expect(result.order).toEqual([3, 1, 2]);
    expect(result.visible.length).toBe(2);
    expect(result.visible).toContain(2);
    // visible re-sorted into stable peer (order) sequence: order=[3,1,2]
    expect(result.visible).toEqual([3, 2]);
    expect(result.active).toBe(2);
  });

  it('single pane is always visible across all classes', () => {
    for (const vc of ['wide', 'medium', 'narrow'] as const) {
      const result = arrange(comp([7], 7), vc);
      expect(result.order).toEqual([7]);
      expect(result.visible).toEqual([7]);
      expect(result.active).toBe(7);
    }
  });

  it('falls back to the first pane when activePaneId is absent', () => {
    const result = arrange(comp([3, 1, 2], 99), 'wide');
    expect(result.active).toBe(3);
    expect(result.visible).toContain(3);
  });

  it('returns an empty arrangement with null active for empty composition', () => {
    const wide = arrange(comp([], 0), 'wide');
    expect(wide.order).toEqual([]);
    expect(wide.visible).toEqual([]);
    expect(wide.active).toBeNull();
    expect(wide.mode).toBe('tiling');

    const narrow = arrange(comp([], 0), 'narrow');
    expect(narrow.order).toEqual([]);
    expect(narrow.visible).toEqual([]);
    expect(narrow.active).toBeNull();
    expect(narrow.mode).toBe('tabbed');
  });
});
