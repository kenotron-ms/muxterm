import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * mux-browser-surface — NON-terminal pixel-box surface.
 *
 * Renders a URL bar (.bar > .address) + an <iframe> that loads the given url.
 * This surface uses normal responsive DOM — no xterm.js, no tmux cols×rows grid.
 *
 * Dispatches `url-change` (bubbles, composed) when the address bar commits a
 * new URL via the `change` event.
 */
@customElement('mux-browser-surface')
export class MuxBrowserSurface extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    .bar {
      display: flex;
      flex-direction: row;
      align-items: center;
      padding: 4px 8px;
      gap: 6px;
      background: #1a1b26;
      border-bottom: 1px solid #32344a;
      flex-shrink: 0;
    }

    .address {
      flex: 1;
      background: #24283b;
      color: #c0caf5;
      border: 1px solid #32344a;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
    }

    .address:focus {
      border-color: #7aa2f7;
    }

    iframe {
      flex: 1;
      border: none;
      width: 100%;
      min-height: 0;
    }
  `;

  @property({ type: String })
  url = 'about:blank';

  private _onAddressChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const newUrl = input.value;
    this.url = newUrl;
    this.dispatchEvent(
      new CustomEvent('url-change', {
        bubbles: true,
        composed: true,
        detail: { url: newUrl },
      }),
    );
  }

  render() {
    return html`
      <div class="bar">
        <input
          class="address"
          type="text"
          .value=${this.url}
          @change=${this._onAddressChange}
        />
      </div>
      <iframe
        src=${this.url}
        sandbox="allow-scripts allow-same-origin allow-forms"
      ></iframe>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-browser-surface': MuxBrowserSurface;
  }
}
