/**
 * mux-start-card.ts -- the sidebar's Mission Control card.
 *
 * Sits above the workspace cards. It is the door to Mission Control from
 * anywhere, and it says one thing beyond its own name: whether anything is
 * waiting on you.
 *
 * IT SHOWS NO COUNT. It used to show a 26px number, and the number is gone on
 * purpose: Mission Control shows no counts anywhere -- not sessions, not groups,
 * not messages -- and the sidebar is not allowed to be the one place a number
 * survived. What replaced it is a dot, present or absent.
 *
 * The zero state is designed, not defaulted, and that survives the change:
 * zero is the state the user is trying to reach, so it is the calmest thing on
 * screen -- no dot, no ring, no warm border, nothing animated. Anything that
 * draws the eye at zero teaches the user to stop looking at the card entirely,
 * which costs the whole feature.
 *
 * `count`, `spread` and `split` are still PROPERTIES carrying numbers rather
 * than booleans, because they are the numbers the caller already has and
 * reducing them here keeps every caller (the app sidebar, the drawer, and the
 * two standalone demos) handing over the same thing it always did. Nothing
 * renders them.
 *
 * The per-machine split survives the no-count rule, because it never carried a
 * count worth keeping: what it is for is saying WHICH machine wants you, and
 * distinguishing "nothing waiting there" from "I cannot currently see". A dot,
 * a `?`, or nothing -- the same three states the card itself has.
 *
 * Presentational only -- it is handed a count and reports clicks. It is shared
 * verbatim by the app sidebar and the standalone fixture demo, which is the
 * point: the thing the user previews is the thing that ships.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** The needs-input mark. Shared so the card and the badges never diverge. */
export const NEEDS_GLYPH = '✽';

/**
 * One machine's contribution to the fleet-wide attention.
 *
 * `count: null` is the load-bearing case: it means "this host is not currently
 * connected", and it renders `?`. It does NOT mean zero, and the type refuses
 * to let a caller conflate them. Any other value is reduced to present/absent
 * on the way to the screen -- the number itself is never rendered, here or
 * anywhere else on this card.
 */
export interface StartSplitRow {
  /** Display label for the machine. The local one is named too, here only:
   *  the split is a comparison, and an unlabelled row is not comparable. */
  name: string;
  /** Sessions waiting on a human there, or null if we cannot currently see. */
  count: number | null;
}

@customElement('mux-start-card')
export class MuxStartCard extends LitElement {
  /** Sessions waiting on a human. MUST be needsInputCount() over the same set
   *  the workspace badges are derived from — see mux-sidebar. */
  @property({ type: Number }) count = 0;

  /** How many workspaces contribute to `count`. Only shown when > 0. */
  @property({ type: Number }) spread = 0;

  /** True when Mission Control is the thing currently on screen. */
  @property({ type: Boolean }) active = false;

  /** Key chord shown in the corner, e.g. "ctrl+`". Empty hides the chip. */
  @property({ type: String }) hint = '';

  /**
   * Per-machine split of `count` (ux D5). EMPTY BY DEFAULT, and an empty split
   * renders nothing at all -- which is what makes a browser with no remotes see
   * exactly today's card, down to the last marker comment (see render()).
   *
   * `count` above stays the total over the whole union, not the sum of the rows
   * below: a host that just connected contributes to the headline immediately,
   * and a host that just dropped keeps contributing whatever it last reported.
   * The split is where the uncertainty is spoken, not the number.
   */
  @property({ attribute: false }) split: StartSplitRow[] = [];

  static styles = css`
    :host {
      display: block;
      margin: 6px;
    }

    .start {
      border: 1px solid var(--mux-warn);
      border-radius: 8px;
      background: color-mix(in srgb, var(--mux-warn) 10%, var(--chrome-bar));
      padding: 9px 10px 8px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      text-align: left;
      width: 100%;
      display: block;
      font: inherit;
      color: inherit;
    }

    .start:hover {
      border-color: var(--mux-warn);
      background: color-mix(in srgb, var(--mux-warn) 16%, var(--chrome-bar));
    }

    /* Home is on screen: "you are here".
       This is LOCATION, not alarm, so it is drawn in --chrome-accent -- the
       same token .ws-card.active uses for the workspace you are in -- and
       OUTSIDE the border, which keeps meaning what it meant (grey = calm,
       warn = needs input). The ring used to be tinted from the card's own
       border/warn colour, and in the zero state that resolved to exactly
       --chrome-border, i.e. the colour already on the card's edge: measured
       rgb(41,46,66) ring on a rgb(31,35,53) fill, ~1.1:1. The selected state
       rendered as nothing at all, while the workspace card below kept the
       bright accent -- so the sidebar said you were in the workspace while
       home was on screen. mux-sidebar demotes that card via
       :host([home-active]) so exactly one thing claims "you are here". */
    .start.here {
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--chrome-accent) 55%, transparent);
    }

    /* ── The zero state. Nothing here is warm, bright, or animated. ── */
    .start.zero {
      border-color: var(--chrome-border);
      background: var(--chrome-bar);
    }

    .start.zero:hover {
      background: var(--chrome-hover);
      border-color: var(--chrome-border);
    }

    /* At zero the card's own border is --chrome-border, which barely separates
       it from the panel, so the ring would float off an invisible edge. The
       accent picks the edge up.

       The second selector is not redundant. Alone, .start.zero.here is (0,3,0)
       and ties .start.zero:hover above, so it wins on source order only --
       hovering the card you are already on could silently take the accent
       back. .start.zero.here:hover is (0,4,0) and settles it on specificity
       instead, where a reorder cannot reach it. */
    .start.zero.here,
    .start.zero.here:hover {
      border-color: var(--chrome-accent);
    }

    .head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 9px;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--mux-warn);
    }

    .start.zero .head {
      color: var(--chrome-text-dim);
    }

    /* The keycap hint is how the shortcut gets learned, so it has to be
       readable. At 8.5px a backtick is a two-pixel tick and the chip reads as
       an empty box -- caught in a screenshot review, not by any check. */
    .kb {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10.5px;
      line-height: 1.3;
      letter-spacing: 0;
      text-transform: none;
      color: var(--chrome-text-dim);
      border: 1px solid var(--chrome-border);
      border-radius: 3px;
      padding: 0 5px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* The card's own name. It replaced a 26px count, and it is deliberately
       the size of a label rather than a headline: this is a door, and a door
       does not need to shout to be found. */
    .name {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 14px;
      font-weight: 600;
      line-height: 1.3;
      margin-top: 2px;
      color: var(--chrome-text-bright);
    }

    /* The one signal left. Present or absent, never a number, never a zero.
       --mux-warn is the same token the group heading, the workspace badge and
       the nav bar's dot use, so the four cannot say different things. */
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--mux-warn);
      flex-shrink: 0;
    }

    .lbl {
      font-size: 11px;
      color: var(--chrome-text-dim);
      margin-top: 1px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── The fleet split (ux D5) ─────────────────────────────────────────
       Present only when there is more than one machine to report on, so a
       single-machine user never sees a row that says the number twice. */
    .split {
      margin-top: 4px;
      padding-top: 5px;
      border-top: 1px solid color-mix(in srgb, var(--mux-warn) 22%, transparent);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .start.zero .split {
      border-top-color: var(--chrome-border);
    }
    .splitrow {
      display: flex;
      align-items: center;
      gap: 5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 9.5px;
      color: var(--chrome-text-dim);
    }
    .splitrow .nm {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* The per-machine signal, and it obeys the same rule as the card above:
       present or absent, never a number. Smaller than the card's own dot
       because it is subordinate to it -- the card says "someone wants you",
       the row says "it is that one". */
    .splitrow .dot {
      width: 5px;
      height: 5px;
    }
    /* A machine we cannot see. Its "?" is deliberately the DIM colour, not the
       warn colour: an unknown is not an alarm, and colouring it like a signal
       would make a disconnected host look like work waiting. It is the only
       glyph left in the split, and it is not a count. */
    .splitrow .mk {
      font-weight: 600;
      color: var(--chrome-text-dim);
      flex-shrink: 0;
    }

    /* The approved sidebar treatment is one quiet navigation row. The legacy
       count/split properties remain accepted below for shared-demo API
       compatibility, but none of their visual card treatment belongs here. */
    :host {
      margin: 4px 6px 6px;
    }

    .start {
      position: relative;
      display: flex;
      align-items: center;
      box-sizing: border-box;
      width: 100%;
      min-height: 36px;
      padding: 0 9px;
      border: 1px solid transparent;
      border-radius: 5px;
      background: transparent;
      color: var(--chrome-text-bright);
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }

    .start:hover {
      border-color: transparent;
      background: var(--chrome-hover);
    }

    .start.here,
    .start.here:hover {
      border-color: var(--chrome-accent);
      background: var(--chrome-hover);
      box-shadow: none;
    }

    .shortcut-tip {
      position: absolute;
      z-index: 1;
      left: 8px;
      bottom: calc(100% + 5px);
      box-sizing: border-box;
      padding: 3px 6px;
      border: 1px solid var(--chrome-border);
      border-radius: 3px;
      background: var(--chrome-body);
      color: var(--chrome-text-bright);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      line-height: 1.3;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.12s, visibility 0.12s;
    }

    .start:hover .shortcut-tip,
    .start:focus-visible .shortcut-tip {
      opacity: 1;
      visibility: visible;
    }

    .start:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    @media (pointer: coarse) {
      .start {
        min-height: 44px;
      }
    }
  `;

  private _onClick(): void {
    this.dispatchEvent(new CustomEvent('start-click', { bubbles: true, composed: true }));
  }

  override render() {
    const displayShortcut = this.hint
      .replace(/^ctrl/i, 'Ctrl')
      .replace(/^control/i, 'Ctrl');
    const ariaShortcut = this.hint
      .replace(/^ctrl/i, 'Control')
      .replace(/^cmd/i, 'Meta');
    const description = displayShortcut ? `Shortcut: ${displayShortcut}.` : '';
    return html`
      <button
        type="button"
        class="start ${this.active ? 'here' : ''}"
        aria-label="${this.active ? 'Mission Control, current view.' : 'Go to Mission Control.'}"
        aria-current="${this.active ? 'page' : 'false'}"
        aria-keyshortcuts="${ariaShortcut}"
        aria-describedby="${description ? 'mission-control-shortcut' : ''}"
        title="${displayShortcut ? `Mission Control — ${displayShortcut}` : 'Mission Control'}"
        @click="${this._onClick}"
      >
        <span>Mission Control</span>
        ${displayShortcut
          ? html`<span class="shortcut-tip" role="tooltip" aria-hidden="true">${displayShortcut}</span>
              <span id="mission-control-shortcut" class="sr-only">${description}</span>`
          : ''}
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-start-card': MuxStartCard;
  }
}
