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
  nextTab?: () => void;
  prevTab?: () => void;
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
 * Installs the home-view toggle chord in CAPTURE phase.
 *
 * Why this is not just another entry in makeKeyHandler's table:
 *
 * The chord is `ctrl+\`` and backtick is a PRINTABLE character. makeKeyHandler
 * is installed on `window` in the BUBBLE phase, which runs after the event has
 * already reached xterm.js's textarea — by then the byte is on its way to the
 * PTY and preventDefault() is too late. Capture phase on `window` fires before
 * any element handler, and stopPropagation() there means the terminal's own
 * listener never runs at all.
 *
 * The other half of the contract: a BARE backtick must still type a backtick.
 * It carries no modifiers, so chordOf() yields "`" which cannot equal
 * "ctrl+`" — the event is not touched and reaches the terminal untouched.
 * Same for ctrl+shift+` (which is "~" on a US layout) and for alt/meta
 * variants. Only the exact chord is taken.
 *
 * Returns a cleanup function.
 */
export function installHomeToggle(chord: string, action: () => void): () => void {
  const handler = (e: KeyboardEvent): void => {
    if (!matchChord(chord, e)) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  };
  window.addEventListener('keydown', handler, { capture: true });
  return () => window.removeEventListener('keydown', handler, { capture: true });
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
 *                      browsers handle Cmd+T at the browser-process level in
 *                      tab mode so preventDefault() has no effect there)
 *
 * Returns a cleanup function.
 */
export function installAppShortcuts(
  actions: Pick<UIActions, 'closePane' | 'newPane' | 'nextTab' | 'prevTab'>,
): () => void {
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
      // Cmd/Ctrl+T alone — only in PWA standalone mode.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && isPwa()) {
        e.preventDefault();
        actions.newPane?.();
      }
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs within the active pane group only.
    // Browsers handle Ctrl+Tab at the browser-process level in tab mode, so
    // preventDefault() has no effect there. Works reliably in PWA standalone
    // mode (no browser tabs to switch). In tab mode the shortcut may still fire
    // the action on focus change into the app, but it won't prevent the browser
    // tab switch. Ctrl+Tab is not passed through terminals because it's
    // intercepted in capture phase before the terminal keydown handler fires.
    if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) {
        actions.prevTab?.();
      } else {
        actions.nextTab?.();
      }
    }
  };

  // Capture phase fires before any element handler — highest JS priority.
  window.addEventListener('keydown', handler, { capture: true });
  return () => window.removeEventListener('keydown', handler, { capture: true });
}
