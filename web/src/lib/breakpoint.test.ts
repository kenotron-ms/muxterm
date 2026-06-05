import { describe, it, expect } from 'vitest';
import { layoutModeForWidth } from './breakpoint';

describe('layoutModeForWidth', () => {
  it('treats sub-768 widths as narrow (phone)', () => {
    expect(layoutModeForWidth(0)).toBe('narrow');
    expect(layoutModeForWidth(767)).toBe('narrow');
  });

  it('treats 768 and above as wide (tablet + PC)', () => {
    expect(layoutModeForWidth(768)).toBe('wide');
    expect(layoutModeForWidth(1024)).toBe('wide');
    expect(layoutModeForWidth(1920)).toBe('wide');
  });
});
