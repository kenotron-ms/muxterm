/**
 * applet-controls.ts -- the shared vocabulary for an applet's OWN controls.
 *
 * THE OWNERSHIP LINE THIS FILE EXISTS TO KEEP (applet-registry.ts states it as
 * the contract; this is the tooling that makes obeying it cheap):
 *
 *   the HOST owns the tab strip -- WHICH applet you are looking at.
 *   an APPLET owns everything below it -- WHAT that applet is showing you.
 *
 * A filter is the second kind. It answers a question about one applet's
 * contents, so it is rendered by that applet, into that applet's shadow root,
 * from that applet's own styles. The host has no style, no slot and no manifest
 * field for it, which is exactly why a new applet with three filters is a
 * zero-line change to the host.
 *
 * SO WHY A SHARED BLOCK AT ALL. Because the thing the old rail got right is
 * worth keeping: three applets should not invent three looks for "toggle this
 * on". This module is how they avoid it, and it is an OFFER rather than a
 * gate -- it lives in lib/, not in the host, so an applet that needs a control
 * this vocabulary has no style for simply writes its own CSS and the host never
 * hears about it. That is the whole difference from the rail, which could only
 * paint what the host already had a class for.
 *
 * It is the same shape as appletStateStyles/appletEmpty in mux-applets.ts, for
 * the same reason: shadow encapsulation means shared CSS has to be adopted per
 * shadow root, and one exported block is cheaper than three copies that drift.
 *
 * NO CARDS. The selected state is carried by ink, weight and a 2px accent
 * underline -- the same signal <mux-applets>'s own `.tab.on::after` uses, so a
 * filter reads as subordinate to the tab above it. It is deliberately NOT a
 * rounded chip with a bolded edge: that pattern is generic chrome that says
 * nothing the word in accent ink does not already say.
 *
 * Tokens are never declared here. --ink-*, --chrome-*, --edge and the --s/--t
 * scales inherit into every applet's shadow root from <mux-cos>'s :host
 * (theme.ts:349).
 */

import { css, html, nothing, type CSSResult, type TemplateResult } from 'lit';

/**
 * The control row and the one control kind in it. Include in an applet's
 * `static styles` to get the house look for its own filters.
 */
export const appletControlStyles: CSSResult = css`
  /* One line of controls, directly above the thing they filter. It WRAPS:
     at a narrow divider position the row becomes two lines rather than
     clipping a control off the right-hand edge. */
  .controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-4);
    min-width: 0;
    padding: 0 var(--s-1) var(--s-5);
  }

  /* A borderless text button. Quiet when off, and never a slab. */
  .ctl {
    font: inherit;
    font-family: var(--mono);
    font-size: 10.5px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0.02em;
    color: var(--ink-3);
    background: transparent;
    border: 0;
    padding: 4px 2px 5px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    flex: none;
  }
  .ctl:hover:not(:disabled) {
    color: var(--ink-1);
  }
  /* Selected: ink, weight, and an accent underline. Three signals, none of
     them colour alone, all of them legible in either palette. */
  .ctl.on {
    color: var(--ink-1);
    font-weight: 700;
    box-shadow: inset 0 -2px 0 var(--chrome-accent);
  }
  /* A control that cannot do anything right now stays VISIBLE and says why --
     see .ctl-why. A control that vanished would look like a feature that was
     never there. */
  .ctl:disabled {
    cursor: default;
    color: var(--ink-3);
    opacity: 0.5;
  }
  .ctl:focus-visible {
    outline: 2px solid var(--chrome-accent);
    outline-offset: 2px;
  }

  /* The plain reason a control is off, next to the control. */
  .ctl-why {
    font-family: var(--mono);
    font-size: var(--t-meta);
    line-height: 1;
    color: var(--ink-3);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* A hairline between the controls and whatever they filter, so the row
     reads as chrome belonging to the list below it rather than as a first
     row of that list. */
  .controls-rule {
    height: 1px;
    background: var(--edge);
    margin: 0 0 var(--s-4);
  }
`;

export interface AppletToggleOptions {
  /** What the control says. A TemplateResult when it needs an icon. */
  label: string | TemplateResult;
  /** Selected state. Rendered as ink + weight + underline, and aria-pressed. */
  on: boolean;
  /** Hover/AT text. Say what the control DOES, not what it is called. */
  title?: string;
  /** Off, with `why` explaining it in words next to the control. */
  disabled?: boolean;
  onToggle: () => void;
}

/**
 * One control, in the house style. The boilerplate that is identical every
 * time -- the class flip, `aria-pressed`, the disabled attribute -- and
 * nothing else, so an applet that wants something different just writes the
 * button itself.
 */
export function appletToggle(o: AppletToggleOptions): TemplateResult {
  return html`<button
    type="button"
    class="${o.on ? 'ctl on' : 'ctl'}"
    aria-pressed="${o.on ? 'true' : 'false'}"
    title="${o.title ?? nothing}"
    ?disabled="${o.disabled === true}"
    @click="${o.onToggle}"
  >${o.label}</button>`;
}
