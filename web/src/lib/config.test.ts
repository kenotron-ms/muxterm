import { describe, it, expect } from 'vitest';
import { DEFAULT_RESOLVED_CONFIG, parseResolvedConfig } from './config';

describe('parseResolvedConfig – degenerate inputs', () => {
  it('returns DEFAULT_RESOLVED_CONFIG for null', () => {
    expect(parseResolvedConfig(null)).toEqual(DEFAULT_RESOLVED_CONFIG);
  });

  it('returns DEFAULT_RESOLVED_CONFIG for empty object', () => {
    expect(parseResolvedConfig({})).toEqual(DEFAULT_RESOLVED_CONFIG);
  });

  it('returns DEFAULT_RESOLVED_CONFIG for a string', () => {
    expect(parseResolvedConfig('nope')).toEqual(DEFAULT_RESOLVED_CONFIG);
  });
});

describe('parseResolvedConfig – full snake_case payload', () => {
  it('maps all snake_case keys to camelCase', () => {
    const raw = {
      theme: { palette: 'gruvbox' },
      font: { family: 'Iosevka', size: 16 },
      terminal: {
        cursor_style: 'bar',
        cursor_blink: false,
        scrollback: 50000,
        bell: 'off',
      },
      keys: {
        open_launcher: 'ctrl+k',
        next_session: 'ctrl+shift+n',
        split: 'ctrl+shift+s',
        maximize_region: 'ctrl+shift+x',
        pop_out: 'ctrl+shift+w',
        focus_driver: 'ctrl+shift+d',
      },
      workspace: {
        default_presentation: 'single',
        rails: ['sessions', 'bookmarks'],
      },
      driver: {
        autostart: true,
        shared_window_policy: 'attach',
        launch: 'custom-agent',
      },
    };

    const result = parseResolvedConfig(raw);

    expect(result.theme.palette).toBe('gruvbox');
    expect(result.font.family).toBe('Iosevka');
    expect(result.font.size).toBe(16);
    expect(result.terminal.cursorStyle).toBe('bar');
    expect(result.terminal.cursorBlink).toBe(false);
    expect(result.terminal.scrollback).toBe(50000);
    expect(result.terminal.bell).toBe('off');
    expect(result.keys.openLauncher).toBe('ctrl+k');
    expect(result.keys.nextSession).toBe('ctrl+shift+n');
    expect(result.keys.split).toBe('ctrl+shift+s');
    expect(result.keys.maximizeRegion).toBe('ctrl+shift+x');
    expect(result.keys.popOut).toBe('ctrl+shift+w');
    expect(result.keys.focusDriver).toBe('ctrl+shift+d');
    expect(result.workspace.defaultPresentation).toBe('single');
    expect(result.workspace.rails).toEqual(['sessions', 'bookmarks']);
    expect(result.driver.autostart).toBe(true);
    expect(result.driver.sharedWindowPolicy).toBe('attach');
    expect(result.driver.launch).toBe('custom-agent');
  });
});

describe('parseResolvedConfig – partial payload uses defaults', () => {
  it('keeps font.size and keys.nextSession at defaults for partial input', () => {
    const raw = { theme: { palette: 'gruvbox' } };
    const result = parseResolvedConfig(raw);

    expect(result.theme.palette).toBe('gruvbox');
    expect(result.font.size).toBe(DEFAULT_RESOLVED_CONFIG.font.size);
    expect(result.keys.nextSession).toBe(DEFAULT_RESOLVED_CONFIG.keys.nextSession);
  });
});
