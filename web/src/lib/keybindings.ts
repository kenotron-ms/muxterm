import type { ResolvedConfig } from './config';

export type Keys = ResolvedConfig['keys'];

export interface UIActions {
  nextSession?: () => void;
  split?: () => void;
  maximizeRegion?: () => void;
  popOut?: () => void;
  openLauncher?: () => void;
  focusDriver?: () => void;
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
