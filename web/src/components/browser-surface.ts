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

    .nav-btn.fwd-active {
      color: #7aa2f7;
      background: rgba(122, 162, 247, 0.12);
    }

    .fwd-bar {
      flex: 1;
      display: flex;
      align-items: center;
      background: #1a1b26;
      border: 1px solid #7aa2f7;
      border-radius: 4px;
      padding: 0 4px;
      font-size: 13px;
      font-family: inherit;
      min-width: 0;
      gap: 0;
    }

    .fwd-label {
      color: #7aa2f7;
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.05em;
      flex-shrink: 0;
      padding: 0 4px 0 2px;
      user-select: none;
    }

    .fwd-host {
      color: #565f89;
      flex-shrink: 0;
      user-select: none;
    }

    .fwd-port {
      background: none;
      border: none;
      color: #c0caf5;
      width: 4ch;
      font: inherit;
      font-size: 13px;
      outline: none;
      padding: 0;
      -moz-appearance: textfield;
      appearance: textfield;
    }
    .fwd-port::-webkit-inner-spin-button,
    .fwd-port::-webkit-outer-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    .fwd-sep {
      color: #565f89;
      flex-shrink: 0;
      user-select: none;
    }

    .fwd-path {
      background: none;
      border: none;
      color: #c0caf5;
      flex: 1;
      font: inherit;
      font-size: 13px;
      outline: none;
      padding: 0 2px;
      min-width: 0;
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

  /**
   * Localhost port for /p/ proxy routing. Set by BrowserRenderer when the
   * pane was created for a specific local port. 0 = auto-detect from URL.
   */
  @property({ type: Number })
  port = 0;

  // Client-side history stack for back/forward navigation.
  // Tracks URLs committed via the address bar. In-frame link clicks are
  // cross-origin and cannot be observed, so they are not tracked here.
  private _historyPrev: string[] = [];
  private _historyNext: string[] = [];

  @state() private _canGoBack = false;
  @state() private _canGoForward = false;
  @state() private _fwdMode = false;
  @state() private _fwdPort = '5173';
  @state() private _fwdPath = '/';

  private _normalizeUrl(raw: string): string {
    const s = raw.trim();
    if (!s || s === 'about:blank') return 'about:blank';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^\d+$/.test(s)) return `http://localhost:${s}`;
    if (/^(localhost|127\.0\.0\.1)(:\d+)?/.test(s)) return `http://${s}`;
    return `https://${s}`;
  }

  private _onAddressChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const newUrl = this._normalizeUrl(input.value);
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

  /**
   * Compute the iframe src from the display URL.
   *
   * this.url holds what the user sees and types (e.g. "https://google.com").
   * The iframe always loads through the muxterm proxy so X-Frame-Options is
   * stripped. Never point the iframe directly at an external origin.
   *
   *   localhost / 127.0.0.1  →  /p/{port}{path}    (this.port when set by
   *                                                   BrowserRenderer; URL's
   *                                                   own port otherwise)
   *   any other host          →  /x/{host}{path}    (external proxy)
   *   about:blank / empty     →  about:blank
   */
  private _iframeSrc(): string {
    const u = this.url;
    if (!u || u === 'about:blank') return 'about:blank';
    try {
      const parsed = new URL(u);
      if (this.port > 0) {
        // BrowserRenderer-managed local proxy pane
        return `/p/${this.port}${parsed.pathname}${parsed.search}`;
      }
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        // User typed a localhost URL — derive port from the URL itself
        const localPort = parsed.port ? parseInt(parsed.port, 10) : 80;
        return `/p/${localPort}${parsed.pathname}${parsed.search}`;
      }
      // External URL — strip X-Frame-Options via /x/ proxy (no JS injected)
      return `/x/${parsed.host}${parsed.pathname}${parsed.search}`;
    } catch {
      return u; // fallback for special schemes (blob:, data:, etc.)
    }
  }

  private _reload(): void {
    const iframe = this.shadowRoot!.querySelector('iframe') as HTMLIFrameElement | null;
    if (iframe) iframe.src = this._iframeSrc();
  }

  private _toggleFwdMode(): void {
    this._fwdMode = !this._fwdMode;
    if (this._fwdMode && this.url && this.url !== 'about:blank') {
      try {
        const u = new URL(this.url);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
          this._fwdPort = u.port || '80';
          this._fwdPath = u.pathname || '/';
        }
      } catch { /* keep defaults */ }
    }
  }

  private _applyFwd(): void {
    const port = parseInt(this._fwdPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) return;
    const path = this._fwdPath.startsWith('/') ? this._fwdPath : `/${this._fwdPath}`;
    const newUrl = `http://localhost:${port}${path}`;
    if (newUrl !== this.url) {
      this._historyPrev.push(this.url);
      this._historyNext = [];
      this._canGoBack = true;
      this._canGoForward = false;
    }
    this.url = newUrl;
    this.dispatchEvent(new CustomEvent('url-change', {
      bubbles: true, composed: true, detail: { url: newUrl },
    }));
  }

  private _onFwdPortChange(e: Event): void {
    this._fwdPort = (e.target as HTMLInputElement).value;
    this._applyFwd();
  }

  private _onFwdPathChange(e: Event): void {
    const raw = (e.target as HTMLInputElement).value;
    this._fwdPath = raw.startsWith('/') ? raw : `/${raw}`;
    this._applyFwd();
  }

  private _onFwdKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); this._applyFwd(); }
  }

  private _onAddressKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const input = e.target as HTMLInputElement;
      const newUrl = this._normalizeUrl(input.value);
      if (newUrl !== this.url) {
        this._historyPrev.push(this.url);
        this._historyNext = [];
        this._canGoBack = true;
        this._canGoForward = false;
      }
      this.url = newUrl;
      this.dispatchEvent(new CustomEvent('url-change', {
        bubbles: true, composed: true, detail: { url: newUrl },
      }));
    }
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
    // sandbox omits allow-same-origin intentionally (see security comment above).
    // Back/forward: client-side history stack, no contentWindow access needed.
    // External URLs route through /x/ proxy (X-Frame-Options stripped, no JS injected).

    const addressValue = this.url === 'about:blank' ? '' : this.url;

    // Port-forward mode icon: two opposing horizontal arrows
    const fwdIcon = html`<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M2 5.5h9M9 3.5l2 2-2 2M14 10.5H5M7 8.5l-2 2 2 2"
        stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    return html`
      <div class="bar">
        <button class="nav-btn" @click="${this._goBack}"
          .disabled="${!this._canGoBack}" title="Back">&#x2039;</button>
        <button class="nav-btn" @click="${this._goForward}"
          .disabled="${!this._canGoForward}" title="Forward">&#x203A;</button>
        <button class="nav-btn" @click="${this._reload}" title="Refresh">&#x21BA;</button>

        ${this._fwdMode ? html`
          <div class="fwd-bar">
            <span class="fwd-label">fwd</span>
            <span class="fwd-host">localhost:</span>
            <input class="fwd-port" type="number" min="1" max="65535"
              .value="${this._fwdPort}"
              @change="${this._onFwdPortChange}"
              @keydown="${this._onFwdKeydown}" />
            <span class="fwd-sep">/</span>
            <input class="fwd-path" type="text"
              .value="${this._fwdPath.replace(/^\//, '')}"
              @change="${this._onFwdPathChange}"
              @keydown="${this._onFwdKeydown}"
              placeholder="path" />
          </div>
        ` : html`
          <input class="address" type="text"
            .value="${addressValue}"
            @change="${this._onAddressChange}"
            @keydown="${this._onAddressKeydown}"
            placeholder="https://" />
        `}

        <button class="nav-btn ${this._fwdMode ? 'fwd-active' : ''}"
          @click="${this._toggleFwdMode}"
          title="${this._fwdMode ? 'Exit forward mode' : 'Forward mode: embed a local port'}">
          ${fwdIcon}
        </button>
      </div>
      <iframe src="${this._iframeSrc()}" sandbox="allow-scripts allow-forms allow-popups"></iframe>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-browser-surface': MuxBrowserSurface;
  }
}
