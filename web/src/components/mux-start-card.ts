/**
 * mux-start-card.ts — the sidebar's Start card.
 *
 * Sits above the workspace cards. Shows the "Needs input" count and is the way
 * back to the home view from anywhere.
 *
 * The zero state is designed, not defaulted. Zero is the state the user is
 * trying to reach, so it is the calmest thing on screen: grey, small, no ring,
 * no pulse, nothing warm. Anything that draws the eye at zero teaches the user
 * to stop looking at the card entirely, which costs the whole feature.
 *
 * Presentational only — it is handed a count and reports clicks. It is shared
 * verbatim by the app sidebar and the standalone fixture demo, which is the
 * point: the thing the user previews is the thing that ships.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** The needs-input mark. Shared so the card and the badges never diverge. */
export const NEEDS_GLYPH = '✽';

@customElement('mux-start-card')
export class MuxStartCard extends LitElement {
  /** Sessions waiting on a human. MUST be needsInputCount() over the same set
   *  the workspace badges are derived from — see mux-sidebar. */
  @property({ type: Number }) count = 0;

  /** How many workspaces contribute to `count`. Only shown when > 0. */
  @property({ type: Number }) spread = 0;

  /** True when the home view is the thing currently on screen. */
  @property({ type: Boolean }) active = false;

  /** Key chord shown in the corner, e.g. "ctrl+`". Empty hides the chip. */
  @property({ type: String }) hint = '';

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

    .num {
      font-size: 26px;
      font-weight: 680;
      letter-spacing: -0.03em;
      line-height: 1.15;
      margin-top: 2px;
      color: var(--mux-warn);
    }

    .start.zero .num {
      font-size: 15px;
      font-weight: 500;
      color: var(--chrome-text-dim);
      line-height: 1.4;
      margin-top: 1px;
    }

    .lbl {
      font-size: 11px;
      color: var(--chrome-text-dim);
      margin-top: -1px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  private _onClick(): void {
    this.dispatchEvent(new CustomEvent('start-click', { bubbles: true, composed: true }));
  }

  override render() {
    const zero = this.count === 0;
    const cls = `start ${zero ? 'zero' : ''} ${this.active ? 'here' : ''}`;

    // The second line says WHERE the card takes you -- so while home is the
    // thing on screen it must not still read "click to go home". It says
    // "home", and keeps the spread when there is one to report.
    const spread =
      this.spread > 0
        ? `across ${this.spread} workspace${this.spread === 1 ? '' : 's'}`
        : '';
    const busyLbl = this.active
      ? spread === ''
        ? 'home'
        : `home · ${spread}`
      : spread === ''
        ? 'click to go home'
        : spread;

    // At zero the count itself is the wrong headline — there is no number worth
    // 26px. The card says the calm thing instead.
    const body = zero
      ? html`<div class="num">All clear</div>
          <div class="lbl">${this.active ? 'home' : 'click for home'}</div>`
      : html`<div class="num">${this.count}</div>
          <div class="lbl">${busyLbl}</div>`;

    // Selection has to reach a screen reader too, or the fix is only for
    // people who can see the ring. aria-current="page" is the cue for "this
    // is the view you are on"; it replaces aria-pressed, which described the
    // card as a toggle rather than as where you are.
    const need = zero
      ? 'Nothing needs input.'
      : `${this.count} sessions need input.`;

    return html`
      <button
        type="button"
        class="${cls}"
        aria-label="${this.active
          ? `${need} Home view, current view.`
          : `${need} Go to home view.`}"
        aria-current="${this.active ? 'page' : 'false'}"
        @click="${this._onClick}"
      >
        <div class="head">
          <span>${NEEDS_GLYPH} needs input</span>
          ${this.hint ? html`<span class="kb">${this.hint}</span>` : ''}
        </div>
        ${body}
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-start-card': MuxStartCard;
  }
}
