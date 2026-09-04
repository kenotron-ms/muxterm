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

    /* Home is on screen: a quiet ring, so the card reads as "you are here". */
    .start.here {
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--mux-warn) 35%, transparent);
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

    .start.zero.here {
      box-shadow: 0 0 0 1px var(--chrome-border);
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

    .kb {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 8.5px;
      letter-spacing: 0;
      text-transform: none;
      color: var(--chrome-text-dim);
      border: 1px solid var(--chrome-border);
      border-radius: 3px;
      padding: 1px 5px;
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

    // At zero the count itself is the wrong headline — there is no number worth
    // 26px. The card says the calm thing instead.
    const body = zero
      ? html`<div class="num">All clear</div>
          <div class="lbl">${this.active ? 'home' : 'click for home'}</div>`
      : html`<div class="num">${this.count}</div>
          <div class="lbl">
            ${this.spread > 0
              ? `across ${this.spread} workspace${this.spread === 1 ? '' : 's'}`
              : 'click to go home'}
          </div>`;

    return html`
      <button
        type="button"
        class="${cls}"
        aria-label="${zero
          ? 'Nothing needs input. Go to home view.'
          : `${this.count} sessions need input. Go to home view.`}"
        aria-pressed="${this.active ? 'true' : 'false'}"
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
