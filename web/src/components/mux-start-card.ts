/**
 * mux-start-card.ts -- the sidebar's Dashboard card.
 *
 * Sits above the workspace cards. It is the door to the Dashboard from
 * anywhere, and it says one thing beyond its own name: whether anything is
 * waiting on you.
 *
 * IT SHOWS NO COUNT. It used to show a 26px number, and the number is gone on
 * purpose: the Dashboard shows no counts anywhere -- not sessions, not groups,
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

  /** True when the Dashboard is the thing currently on screen. */
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
  `;

  private _onClick(): void {
    this.dispatchEvent(new CustomEvent('start-click', { bubbles: true, composed: true }));
  }

  override render() {
    const zero = this.count === 0;
    const cls = `start ${zero ? 'zero' : ''} ${this.active ? 'here' : ''}`;

    // The second line says WHERE the card takes you -- so while the Dashboard
    // is the thing on screen it must not still read "click to go there". The
    // spread is a shape, not a tally: "across 2 workspaces" tells you the
    // attention is scattered, which is a different fact from how many rows
    // there are, and it is the one the sidebar can act on.
    const spread =
      this.spread > 1
        ? `across ${this.spread} workspaces`
        : '';
    const lbl = this.active
      ? spread || 'you are here'
      : zero
        ? 'nothing is waiting'
        : spread || 'something wants you';

    // The card's whole body: its name, the one dot, and the line saying where
    // it takes you.
    const body = html`<div class="name">
        Dashboard
        ${zero ? '' : html`<span class="dot"></span>`}
      </div>
      <div class="lbl">${lbl}</div>`;

    // THE ZERO-REMOTE GATE, expressed in Lit rather than as an early return.
    //
    // `body` is passed through UNTOUCHED when there is no split, into the same
    // single binding it has always occupied. Appending a second `${...}` to the
    // template instead would add a ChildPart marker comment to the card on
    // every machine, including the ones with no remotes at all -- so the split
    // is composed INSIDE the existing binding's value, where it costs a browser
    // with one machine exactly nothing.
    //
    // A row shows a dot when that machine wants you, `?` when we cannot see it,
    // and nothing at all when it is clear. No numbers: this card is the door to
    // the Dashboard, and the Dashboard counts nothing.
    const shown =
      this.split.length === 0
        ? body
        : html`${body}
            <div class="split">
              ${this.split.map(
                (row) => html`<div class="splitrow ${row.count === null ? 'unknown' : ''}">
                  <span class="nm" title="${row.name}">${row.name}</span>
                  ${row.count === null
                    ? html`<span class="mk" title="not connected">?</span>`
                    : row.count > 0
                      ? html`<span class="dot"></span>`
                      : ''}
                </div>`,
              )}
            </div>`;

    // Selection has to reach a screen reader too, or the fix is only for
    // people who can see the ring. aria-current="page" is the cue for "this
    // is the view you are on"; it replaces aria-pressed, which described the
    // card as a toggle rather than as where you are. The dot is decorative
    // here -- the label below carries the same fact in words.
    const need = zero ? 'Nothing needs input.' : 'Sessions need input.';

    // An aria-label REPLACES the element's contents for a screen reader, and
    // this card is one button — so a split that exists only in the DOM is a
    // split nobody using one can hear, including the `?` that is the whole
    // point of it. Appended to the label, and empty when there is no split, so
    // the label a machine with no remotes exposes is the string it exposes now.
    // It says the same three states the dots say, in words, and no numbers.
    const fleet =
      this.split.length === 0
        ? ''
        : ` ${this.split
            .map((r) =>
              r.count === null
                ? `${r.name}: unknown, not connected.`
                : r.count > 0
                  ? `${r.name}: needs input.`
                  : `${r.name}: nothing waiting.`,
            )
            .join(' ')}`;

    return html`
      <button
        type="button"
        class="${cls}"
        aria-label="${(this.active
          ? `${need} Dashboard, current view.`
          : `${need} Go to the Dashboard.`) + fleet}"
        aria-current="${this.active ? 'page' : 'false'}"
        @click="${this._onClick}"
      >
        <div class="head">
          <span>dashboard</span>
          ${this.hint ? html`<span class="kb">${this.hint}</span>` : ''}
        </div>
        ${shown}
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-start-card': MuxStartCard;
  }
}
