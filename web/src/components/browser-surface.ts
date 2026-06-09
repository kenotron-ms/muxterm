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
      border-bottom: 1px solid #292e42;
      flex-shrink: 0;
    }

    .nav-btn {
      background: none;
      border: none;
      color: #a9b1d6;
      cursor: pointer;
      font-size: 16px;
      padding: 2px 6px;
      border-radius: 3px;
      line-height: 1;
      flex-shrink: 0;
    }
    .nav-btn:hover {
      background: #292e42;
    }

    .address {
      flex: 1;
      background: #1a1b26;
      color: #a9b1d6;
      border: 1px solid #292e42;
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
        <button class="nav-btn" @click="${() => (this.shadowRoot!.querySelector('iframe') as HTMLIFrameElement)?.contentWindow?.history.back()}" title="Back">‹</button>
        <button class="nav-btn" @click="${() => (this.shadowRoot!.querySelector('iframe') as HTMLIFrameElement)?.contentWindow?.history.forward()}" title="Forward">›</button>
        <button class="nav-btn" @click="${() => (this.shadowRoot!.querySelector('iframe') as HTMLIFrameElement)?.contentWindow?.location.reload()}" title="Refresh">↺</button>
        <input
          class="address"
          type="text"
          .value="${this.url}"
          @change="${this._onAddressChange}"
        />
      </div>
      <iframe
        src="${this.url}"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      ></iframe>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-browser-surface': MuxBrowserSurface;
  }
}
