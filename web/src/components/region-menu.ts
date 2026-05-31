import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';
import { icon } from '../lib/icons.js';
import { ExternalLink, PanelLeft, PanelTop, Pencil, X } from 'lucide';

export type RegionAction =
  | 'split-right'
  | 'split-down'
  | 'pop-out'
  | 'rename'
  | 'close-region';

@customElement('mux-region-menu')
export class MuxRegionMenu extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: ${unsafeCSS(CHROME.bar)};
      border: 1px solid ${unsafeCSS(CHROME.border)};
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      padding: 4px;
      min-width: 180px;
    }

    .divider {
      height: 1px;
      background: ${unsafeCSS(CHROME.border)};
      margin: 4px 0;
    }

    button {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 10px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: ${unsafeCSS(CHROME.textBright)};
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      box-sizing: border-box;
    }

    button:hover {
      background: ${unsafeCSS(CHROME.hover)};
    }

    button.danger:hover {
      color: ${unsafeCSS(CHROME.danger)};
    }

    button:disabled,
    button.disabled {
      opacity: 0.4;
      cursor: not-allowed;
      color: var(--textDim, #565f89);
    }

    button:disabled:hover,
    button.disabled:hover {
      background: transparent;
      color: var(--textDim, #565f89);
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }

    button .lucide-icon {
      pointer-events: none;
    }
  `;

  @property({ type: Boolean })
  isOnlyRegion = false;

  private _dispatch(action: RegionAction): void {
    this.dispatchEvent(
      new CustomEvent('region-action', {
        bubbles: true,
        composed: true,
        detail: { action },
      }),
    );
  }

  render() {
    return html`
      <button data-action="split-right" @click="${() => this._dispatch('split-right')}">
        ${icon(PanelLeft, { size: 14 })} Split right
      </button>
      <button data-action="split-down" @click="${() => this._dispatch('split-down')}">
        ${icon(PanelTop, { size: 14 })} Split down
      </button>
      <div class="divider"></div>
      <button data-action="pop-out" @click="${() => this._dispatch('pop-out')}">
        ${icon(ExternalLink, { size: 14 })} Pop out to window
      </button>
      <button data-action="rename" @click="${() => this._dispatch('rename')}">
        ${icon(Pencil, { size: 14 })} Rename window
      </button>
      <div class="divider"></div>
      <button
        data-action="close-region"
        class="danger${this.isOnlyRegion ? ' disabled' : ''}"
        ?disabled="${this.isOnlyRegion}"
        @click="${() => this._dispatch('close-region')}"
      >
        ${icon(X, { size: 14 })} Close region
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-region-menu': MuxRegionMenu;
  }
}
