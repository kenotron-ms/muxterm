import { describe, it, expect } from 'vitest';
import { THEME, PALETTES, resolvePalette, paletteToCSSVars } from './theme';

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

describe('paletteToCSSVars', () => {
  it('emits --mux-* CSS variables for a palette', () => {
    const vars = paletteToCSSVars(resolvePalette('tokyo-night'));
    expect(vars['--mux-bg']).toBe('#1a1b26');
    expect(vars['--mux-fg']).toBe('#a9b1d6');
    expect(vars['--mux-accent']).toBe('#7aa2f7');
  });

  it('emits attention management and dock design tokens', () => {
    const vars = paletteToCSSVars(resolvePalette('tokyo-night'));
    expect(vars['--mux-bell']).toBe('var(--mux-warn)');
    expect(vars['--mux-dock-height']).toBe('44px');
    expect(vars['--mux-dock-item-padding']).toBe('0 16px');
    expect(vars['--mux-dock-font-size']).toBe('0.85rem');
    expect(vars['--mux-dock-active-weight']).toBe('600');
  });

  // D3. The title bar and the sidebar header must not be able to drift apart,
  // which means exactly one token may decide their height. If this name ever
  // stops being emitted, both surfaces silently fall back to their own local
  // defaults and the drift is back -- so the token's EXISTENCE is the thing
  // worth asserting, not just its current value.
  it('emits one shared top-chrome height token', () => {
    const vars = paletteToCSSVars(resolvePalette('tokyo-night'));
    expect(vars['--mux-titlebar-height']).toBe('var(--mux-dock-height, 44px)');
  });
});
