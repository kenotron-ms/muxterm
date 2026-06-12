import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * mux-browser-surface — NON-terminal pixel-box surface.
 *
 * Renders a URL bar (.bar > .address) + an <iframe> that loads the given url.
 * This surface uses normal responsive DOM — no xterm.js, no terminal cols×rows grid.
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
    .nav-btn:disabled {
      opacity: 0.3;
      cursor: default;
    }
    .nav-btn:disabled:hover {
      background: none;
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

  // Client-side history stack for back/forward navigation.
  // Tracks URLs committed via the address bar. In-frame link clicks are
  // cross-origin and cannot be observed, so they are not tracked here.
  private _historyPrev: string[] = [];
  private _historyNext: string[] = [];

  @state() private _canGoBack = false;
  @state() private _canGoForward = false;

  private _onAddressChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const newUrl = input.value;
    if (newUrl !== this.url) {
      this._historyPrev.push(this.url);
      this._historyNext = [];
      this._canGoBack = this._historyPrev.length > 0;
      this._canGoForward = false;
    }
    this.url = newUrl;
    this.dispatchEvent(
      new CustomEvent('url-change', {
        bubbles: true,
        composed: true,
        detail: { url: newUrl },
      }),
    );
  }

  private _goBack(): void {
    if (this._historyPrev.length === 0) return;
    this._historyNext.unshift(this.url);
    this.url = this._historyPrev.pop()!;
    this._canGoBack = this._historyPrev.length > 0;
    this._canGoForward = this._historyNext.length > 0;
  }

  private _goForward(): void {
    if (this._historyNext.length === 0) return;
    this._historyPrev.push(this.url);
    this.url = this._historyNext.shift()!;
    this._canGoBack = this._historyPrev.length > 0;
    this._canGoForward = this._historyNext.length > 0;
  }

  private _reload(): void {
    // Setting src on the element we own is a same-document attribute write —
    // no cross-origin window access required. Using this.url (not iframe.src)
    // avoids the no-self-assign lint rule and is the canonical source of truth.
    const iframe = this.shadowRoot!.querySelector('iframe') as HTMLIFrameElement | null;
    if (iframe) iframe.src = this.url;
  }

  /**
   * Browser-action relay: forward a command to the iframe shim via postMessage
   * and await the shim's response (cid-matched reply) with a 10-second timeout.
   *
   * Called by MuxDock.sendBrowserAction when the server emits a browser-action
   * event targeting this pane.
   */
  receiveBrowserAction(paneId: number, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const iframe = this.shadowRoot!.querySelector('iframe') as HTMLIFrameElement | null;
    const win = iframe?.contentWindow;
    if (!win) {
      return Promise.reject(new Error('bridge-not-ready'));
    }
    const cid = `ba-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('browser-action-timeout'));
      }, 10_000);

      const onMessage = (ev: MessageEvent): void => {
        const data = ev.data as Record<string, unknown> | null;
        if (data != null && data['cid'] === cid) {
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          resolve(data);
        }
      };

      window.addEventListener('message', onMessage);
      win.postMessage({ ...msg, cid, paneId }, '*');
    });
  }

  render() {
    // sandbox intentionally omits allow-same-origin. See security note above.
    //
    // Back/forward use a client-side URL history stack rather than
    // contentWindow.history (which throws cross-origin without allow-same-origin).
    // They track address-bar navigations; in-frame link clicks are not tracked
    // since we cannot observe cross-origin navigations.
    return html`
      <div class="bar">
        <button
          class="nav-btn"
          @click="${this._goBack}"
          .disabled="${!this._canGoBack}"
          title="Back"
        >&#x2039;</button>
        <button
          class="nav-btn"
          @click="${this._goForward}"
          .disabled="${!this._canGoForward}"
          title="Forward"
        >&#x203A;</button>
        <button class="nav-btn" @click="${this._reload}" title="Refresh">&#x21BA;</button>
        <input
          class="address"
          type="text"
          .value="${this.url}"
          @change="${this._onAddressChange}"
        />
      </div>
      <iframe
        src="${this.url}"
        sandbox="allow-scripts allow-forms allow-popups"
      ></iframe>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-browser-surface': MuxBrowserSurface;
  }
}
