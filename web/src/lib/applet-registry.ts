/**
 * applet-registry.ts -- the applet contract, and the list of built-ins.
 *
 * Mission Control's right-hand region is a HOST (<mux-applets>) with a tab
 * strip. Each tab is an APPLET: a Lit custom element plus the manifest below.
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

import type { TemplateResult } from 'lit';
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
  /**
   * Optional controls for the rail -- the right-hand end of the tab strip.
   *
   * The HOST paints the rail; the applet only fills it, using the host's
   * vocabulary (.seg, .toggle). This is a plain function returning lit-html
   * that the host renders into the HOST's shadow root with the HOST's styles
   * in scope, so three applets cannot make the strip look like three products.
   *
   * The cost, named: an applet cannot put a control in the rail that the host
   * has no style for. Adding a control kind is a host change. For three
   * built-ins that is correct.
   *
   * Receives the live applet element so the rail can read its state and call
   * back into it. Fire `applet-rail-changed` to have the host re-read it.
   *
   * No destructive action may appear here (D3.9): the rail is shared chrome,
   * and a control that destroys something belongs next to the thing it
   * destroys.
   */
  rail?: (el: AppletElement) => TemplateResult;
  /** Built-in ordering; ties broken by registration order. */
  order?: number;
}

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
