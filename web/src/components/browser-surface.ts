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
    // sandbox intentionally omits allow-same-origin.
    //
    // allow-scripts + allow-same-origin defeats the sandbox entirely: a script
    // in the frame can reach parent.document (same origin via proxy), remove the
    // sandbox attribute, and reload — escaping all restrictions and gaining full
    // access to muxterm's DOM, auth tokens, and WebSocket.
    //
    // Without allow-same-origin the frame gets an opaque origin: no DOM escape,
    // no sandbox removal. The trade-offs:
    //   - localStorage / cookies in the frame are blocked (opaque origin has no
    //     storage). Most embedded dev servers don't need this.
    //   - contentWindow.history is cross-origin and throws, so back/forward
    //     buttons are removed. Reload works via iframe.src assignment instead.
    return html`
      <div class="bar">
        <button class="nav-btn" @click="${this._reload}" title="Refresh">↺</button>
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
