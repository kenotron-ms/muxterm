import { describe, it, expect } from 'vitest';
import { THEME, CHROME } from '../lib/theme';

describe('Tokyo Night terminal palette', () => {
  it('exports the expected THEME color values', () => {
    expect(THEME.background).toBe('#1a1b26');
    expect(THEME.blue).toBe('#7aa2f7');
    expect(THEME.magenta).toBe('#bb9af7');
    expect(THEME.foreground).toBe('#a9b1d6');
    expect(THEME.red).toBe('#f7768e');
  });
});

describe('VS Code chrome design tokens', () => {
  it('exports CHROME with all token values matching exactly', () => {
    expect(CHROME.bar).toBe('#16161e');
    expect(CHROME.body).toBe('#1a1b26');
    expect(CHROME.border).toBe('#292e42');
    expect(CHROME.textDim).toBe('#565f89');
    expect(CHROME.textBright).toBe('#c0caf5');
    expect(CHROME.accent).toBe('#7aa2f7');
    expect(CHROME.driverAccent).toBe('#bb9af7');
    expect(CHROME.hover).toBe('#1f2335');
    expect(CHROME.danger).toBe('#f7768e');
  });
});
