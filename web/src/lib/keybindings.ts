import type { ResolvedConfig } from './config';

export type Keys = ResolvedConfig['keys'];

export interface UIActions {
  nextSession?: () => void;
  split?: () => void;
  maximizeRegion?: () => void;
  popOut?: () => void;
  openLauncher?: () => void;
  focusDriver?: () => void;
  closePane?: () => void;
  newPane?: () => void;
}

/** Normalizes a KeyboardEvent to a canonical chord string: ctrl+alt+shift+meta+key. */
function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

/** Returns true if the event matches the given chord string. */
export function matchChord(chord: string, e: KeyboardEvent): boolean {
  return chordOf(e) === chord.toLowerCase();
}

/** Builds a keyboard event handler from a Keys config and a set of UIActions. */
export function makeKeyHandler(
  keys: Keys,
  actions: UIActions,
): (e: KeyboardEvent) => void {
  const table: [string, (() => void) | undefined][] = [
    [keys.nextSession, actions.nextSession],
    [keys.split, actions.split],
    [keys.maximizeRegion, actions.maximizeRegion],
    [keys.popOut, actions.popOut],
    [keys.openLauncher, actions.openLauncher],
    [keys.focusDriver, actions.focusDriver],
  ];

  return (e: KeyboardEvent) => {
    for (const [chord, action] of table) {
      if (action && matchChord(chord, e)) {
        e.preventDefault();
        action();
        return;
      }
    }
  };
}

/** Returns true when muxterm is running as an installed PWA in standalone mode. */
function isPwa(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * Installs fixed app-level keyboard shortcuts that override browser defaults.
 * These are not user-configurable — they make muxterm feel like a native app.
 *
 *   Cmd/Ctrl+W      — close the active pane   (interceptable in all modes)
 *   Cmd+Ctrl+T      — open a new pane          (interceptable in all modes —
 *                      both modifiers together is not a Chrome-reserved chord)
 *   Cmd/Ctrl+T      — open a new pane          (PWA standalone mode only —
 *                      browsers handle Cmd+T at the process level in tab mode
 *                      so preventDefault() has no effect there)
 *
 * Returns a cleanup function.
 */
export function installAppShortcuts(actions: Pick<UIActions, 'closePane' | 'newPane'>): () => void {
  const handler = (e: KeyboardEvent): void => {
    if (e.key === 'w' || e.key === 'W') {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        actions.closePane?.();
      }
      return;
    }

    if (e.key === 't' || e.key === 'T') {
      // Cmd+Ctrl+T — new pane, works in all modes. Not a browser-reserved chord.
      if (e.metaKey && e.ctrlKey) {
        e.preventDefault();
        actions.newPane?.();
        return;
      }
      // Cmd/Ctrl+T alone — only in PWA standalone mode. In regular browser
      // tabs Chrome handles Cmd+T at the browser-process level before the
      // renderer fires a keydown event, so preventDefault() has no effect.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && isPwa()) {
        e.preventDefault();
        actions.newPane?.();
      }
    }
  };

  // Capture phase: intercept before the browser acts on these chords.
  window.addEventListener('keydown', handler, { capture: true });
  return () => window.removeEventListener('keydown', handler, { capture: true });
}
