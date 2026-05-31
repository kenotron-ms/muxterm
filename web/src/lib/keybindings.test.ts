import { describe, it, expect, vi } from 'vitest';
import { matchChord, makeKeyHandler } from './keybindings';
import { DEFAULT_RESOLVED_CONFIG } from './config';

/** Minimal KeyboardEvent factory with vi.fn() for preventDefault. */
function evt(opts: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}): KeyboardEvent {
  return {
    key: opts.key,
    ctrlKey: opts.ctrlKey ?? false,
    altKey: opts.altKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    metaKey: opts.metaKey ?? false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe('matchChord', () => {
  it('returns true for ctrl+shift+p with matching event', () => {
    expect(matchChord('ctrl+shift+p', evt({ key: 'P', ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('returns false when shift modifier is missing', () => {
    expect(matchChord('ctrl+shift+p', evt({ key: 'P', ctrlKey: true }))).toBe(false);
  });

  it('returns true for ctrl+shift+\\ with backslash key', () => {
    expect(matchChord('ctrl+shift+\\', evt({ key: '\\', ctrlKey: true, shiftKey: true }))).toBe(true);
  });
});

describe('makeKeyHandler', () => {
  it('calls action and preventDefault when chord matches', () => {
    const openLauncher = vi.fn();
    const handler = makeKeyHandler(DEFAULT_RESOLVED_CONFIG.keys, { openLauncher });
    const e = evt({ key: 'P', ctrlKey: true, shiftKey: true });

    handler(e);

    expect(openLauncher).toHaveBeenCalledTimes(1);
    expect((e.preventDefault as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('does not call preventDefault when no action is registered', () => {
    const handler = makeKeyHandler(DEFAULT_RESOLVED_CONFIG.keys, {});
    const e = evt({ key: 'P', ctrlKey: true, shiftKey: true });

    handler(e);

    expect((e.preventDefault as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
