import { describe, it, expect } from 'vitest';
import { THEME, PALETTES, resolvePalette } from './theme';

describe('resolvePalette', () => {
  it('returns THEME reference for tokyo-night', () => {
    expect(resolvePalette('tokyo-night')).toBe(THEME);
  });

  it('PALETTES gruvbox is defined and resolvePalette returns it', () => {
    expect(PALETTES['gruvbox']).toBeDefined();
    expect(resolvePalette('gruvbox')).toBe(PALETTES['gruvbox']);
  });

  it('falls back to THEME for unknown palette name', () => {
    expect(resolvePalette('does-not-exist')).toBe(THEME);
  });
});
