/**
 * applet-registry.ts -- the applet contract, and the list of built-ins.
 *
 * Mission Control's right-hand region is a HOST (<mux-applets>) with a tab
 * strip. Each tab is an APPLET: a Lit custom element plus the manifest below.
 *
 * ┌─ THE OWNERSHIP LINE. This is the contract. ────────────────────────────┐
 * │                                                                        │
 * │   THE HOST OWNS THE TAB STRIP, and nothing else: which applet you are  │
 * │   looking at, the flag when another one wants you, and the geometry    │
 * │   of that one row.                                                     │
 * │                                                                        │
 * │   AN APPLET OWNS EVERYTHING BELOW IT: what it shows, and every         │
 * │   control that changes what it shows. Filters, toggles, sort orders,   │
 * │   view modes and pickers are the applet's, rendered by the applet,     │
 * │   into the applet's own shadow root, from the applet's own styles.     │
 * │                                                                        │
 * │   THE TEST: adding an applet with three filters must be a ZERO-line    │
 * │   change to <mux-applets>. If a change to this contract breaks that    │
 * │   test, the change is wrong.                                           │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * There is no `rail`. There was: the manifest used to carry a rail() the host
 * rendered into the HOST's shadow root, at the right-hand end of the tab strip,
 * limited to control kinds the host had a CSS class for. It looked like the
 * applet owned its controls and it did not -- three applets between them needed
 * `.seg` and `.toggle` in the host, and the fourth applet's first unfamiliar
 * control would have been a fifth class in the same place. The junk drawer was
 * structural, so the fix is structural: the host has no slot to fill.
 *
 * The cost of removing it, named: an applet's controls no longer sit on the
 * same visual line as the tabs, and three applets could in principle style
 * their filters three ways. The first is what was asked for -- a control that
 * answers "what is this applet showing me" belongs with the applet, not with
 * the row that answers "which applet am I looking at". The second is answered
 * by lib/applet-controls.ts: a shared, OPTIONAL vocabulary in lib rather than
 * enforced chrome in the host, so consistency stays cheap and divergence stays
 * possible without a host change.
 *
 * Lit, because every component on this surface already is one, and because of
 * one property theme.ts already relies on:
 *
 *   "Custom properties inherit into shadow roots, so no component needs a copy."
 *   -- web/src/lib/theme.ts:349
 *
 * An applet in its own shadow root is therefore correctly themed for free: it
 * reads --chrome-*, --ink-*, --edge and gets the palette, light or dark, with
 * no registration step and no token plumbing. That is the whole argument.
 *
 * Registration is a module-level array populated by side-effecting imports.
 * NOT a plugin loader: third-party applets are out of scope and not designed
 * for (see docs/design/mission-control.md, D1).
 */

import type { IconNode } from 'lucide';

/** Stable applet ids. Used for persistence keys and navigation targets. */
export type AppletId = 'dashboard' | 'files' | 'prs';

/**
 * The three reactive properties the host sets on every applet element.
 *
 * `active` is the only rule with teeth: an inactive applet must stop polling,
 * stop animating, and hold no open connection. The host keeps inactive applets
 * MOUNTED (so scroll position and navigation survive a tab switch) and hidden,
 * which is exactly why the applet -- not the host -- has to honour it.
 */
export interface AppletElement extends HTMLElement {
  active: boolean;
  narrow: boolean;
  /**
   * What to point at: `pr:79`, `session:8e9e...`, `path:web/src/lib/theme.ts`.
   * Set by the host when something navigated here on purpose. The applet
   * consumes it and clears it back to null.
   */
  target: string | null;
}

export interface AppletManifest {
  /** Stable. Persistence keys, deep links, navigation targets. */
  id: AppletId;
  /** Tab text. Title Case; the host does not transform it. */
  label: string;
  /** A lucide icon. The host renders it at one size so the strip stays even. */
  icon: IconNode;
  /** Custom-element tag for the applet body. */
  element: string;
  /** Built-in ordering; ties broken by registration order. */
  order?: number;
}

/*
 * THERE IS NO CONTROL FIELD HERE, AND THAT IS THE POINT.
 *
 * The four fields above are everything the host needs to draw a tab and mount
 * an element: an id to remember, a word and a glyph to put in the strip, a tag
 * to create, a place in the order. None of them describes what the applet
 * SHOWS, because the host does not decide that and must not learn to.
 *
 * An applet with filters renders them in its own render(), above its own list.
 * lib/applet-controls.ts has the house style for them if it wants it.
 */

/** Detail of the `applet-navigate` event. */
export interface AppletNavigateDetail {
  applet: AppletId;
  target?: string;
}

/**
 * Detail of the `applet-attention` event. Deliberately carries NO urgency,
 * severity or priority field: there is nothing for a caller to escalate with,
 * which is how "urgency alone never promotes a flag to a jump" is enforced --
 * by the shape of the event, not by a rule someone has to remember.
 */
export interface AppletAttentionDetail {
  applet: AppletId;
  count?: number;
}

const registry: AppletManifest[] = [];

/**
 * Register a built-in applet. Called at module scope from the applet's own
 * file; `mux-applets` imports the three built-ins for that side effect and
 * knows nothing else about them.
 */
export function registerApplet(m: AppletManifest): void {
  const at = registry.findIndex((r) => r.id === m.id);
  if (at >= 0) registry[at] = m;
  else registry.push(m);
}

/** The strip, in display order. */
export function applets(): readonly AppletManifest[] {
  return [...registry].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** One manifest, or undefined when nothing registered that id. */
export function appletById(id: string): AppletManifest | undefined {
  return registry.find((m) => m.id === id);
}
