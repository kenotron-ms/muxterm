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

/**
 * Installs fixed app-level keyboard shortcuts that override browser defaults.
 * These are not user-configurable — they make muxterm feel like a native app.
 *
 *   Cmd/Ctrl+W  — close the active pane  (prevents browser "close tab")
 *   Cmd/Ctrl+T  — open a new pane        (prevents browser "new tab")
 *
 * Returns a cleanup function.
 */
export function installAppShortcuts(actions: Pick<UIActions, 'closePane' | 'newPane'>): () => void {
  const handler = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      actions.closePane?.();
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      actions.newPane?.();
    }
  };
  // Capture phase: intercept before the browser acts on these chords.
  window.addEventListener('keydown', handler, { capture: true });
  return () => window.removeEventListener('keydown', handler, { capture: true });
}
