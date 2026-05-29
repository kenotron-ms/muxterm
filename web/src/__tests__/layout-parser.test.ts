import { describe, it, expect } from 'vitest';
import { parseLayout } from '../lib/layout-parser';
import type { LayoutLeaf, LayoutSplit } from '../types';

describe('parseLayout', () => {
  it('parses a single pane', () => {
    const result = parseLayout('bb62,159x48,0,0,1');
    expect(result).toEqual({
      type: 'leaf',
      paneId: 1,
      width: 159,
      height: 48,
      x: 0,
      y: 0,
    } satisfies LayoutLeaf);
  });

  it('parses a horizontal split', () => {
    const result = parseLayout('bb62,159x48,0,0{79x48,0,0,1,79x48,80,0,2}');
    expect(result.type).toBe('split');
    const split = result as LayoutSplit;
    expect(split.direction).toBe('horizontal');
    expect(split.width).toBe(159);
    expect(split.height).toBe(48);
    expect(split.x).toBe(0);
    expect(split.y).toBe(0);
    expect(split.children).toHaveLength(2);

    const left = split.children[0] as LayoutLeaf;
    expect(left).toEqual({
      type: 'leaf',
      paneId: 1,
      width: 79,
      height: 48,
      x: 0,
      y: 0,
    });

    const right = split.children[1] as LayoutLeaf;
    expect(right).toEqual({
      type: 'leaf',
      paneId: 2,
      width: 79,
      height: 48,
      x: 80,
      y: 0,
    });
  });

  it('parses a vertical split', () => {
    const result = parseLayout('bb62,159x48,0,0[159x24,0,0,1,159x23,0,25,2]');
    expect(result.type).toBe('split');
    const split = result as LayoutSplit;
    expect(split.direction).toBe('vertical');
    expect(split.children).toHaveLength(2);

    const top = split.children[0] as LayoutLeaf;
    expect(top).toEqual({ type: 'leaf', paneId: 1, width: 159, height: 24, x: 0, y: 0 });

    const bottom = split.children[1] as LayoutLeaf;
    expect(bottom).toEqual({ type: 'leaf', paneId: 2, width: 159, height: 23, x: 0, y: 25 });
  });

  it('parses nested splits', () => {
    const result = parseLayout(
      'd0e0,159x48,0,0{79x48,0,0,1,79x48,80,0[79x24,80,0,2,79x23,80,25,3]}'
    );
    expect(result.type).toBe('split');
    const root = result as LayoutSplit;
    expect(root.direction).toBe('horizontal');
    expect(root.children).toHaveLength(2);

    const left = root.children[0] as LayoutLeaf;
    expect(left).toEqual({ type: 'leaf', paneId: 1, width: 79, height: 48, x: 0, y: 0 });

    const right = root.children[1] as LayoutSplit;
    expect(right.type).toBe('split');
    expect(right.direction).toBe('vertical');
    expect(right.children).toHaveLength(2);

    const rightTop = right.children[0] as LayoutLeaf;
    expect(rightTop).toEqual({ type: 'leaf', paneId: 2, width: 79, height: 24, x: 80, y: 0 });

    const rightBottom = right.children[1] as LayoutLeaf;
    expect(rightBottom).toEqual({ type: 'leaf', paneId: 3, width: 79, height: 23, x: 80, y: 25 });
  });

  it('parses a three-way horizontal split', () => {
    const result = parseLayout('xxxx,240x48,0,0{80x48,0,0,1,80x48,81,0,2,78x48,162,0,3}');
    expect(result.type).toBe('split');
    const split = result as LayoutSplit;
    expect(split.direction).toBe('horizontal');
    expect(split.children).toHaveLength(3);

    const paneIds = split.children.map((c) => (c as LayoutLeaf).paneId);
    expect(paneIds).toEqual([1, 2, 3]);
  });

  it('throws on empty string', () => {
    expect(() => parseLayout('')).toThrow();
  });
});