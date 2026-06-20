/**
 * mux-browser-pane — Chrome-like browser viewport for CDP screen-capture panes.
 *
 * Receives JPEG frames from the server via browserRegistry callbacks,
 * renders them to a <canvas> element, and relays mouse/keyboard events
 * back to the server via wsBrowser.send().
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { browserRegistry } from '../lib/browser-registry.js';
import { wsBrowser } from '../lib/ws-browser.js';
import { SessiondType } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedUrl {
  host: string;
  path: string;
  isHttps: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement('mux-browser-pane')
export class MuxBrowserPane extends LitElement {
  // -------------------------------------------------------------------------
  // CSS
  // -------------------------------------------------------------------------

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: var(--chrome-body);
      overflow: hidden;
      position: relative;
    }

    /* ---- Toolbar ---- */

    .browser-toolbar {
      display: flex;
      flex-direction: row;
      align-items: center;
      height: 40px;
      flex-shrink: 0;
      background: var(--chrome-bar);
      border-bottom: 1px solid var(--chrome-border);
      padding: 0 6px;
      gap: 4px;
      user-select: none;
    }

    /* ---- Nav buttons ---- */

    .nav-btn {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: none;
      background: transparent;
      color: var(--chrome-text);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      padding: 0;
      transition: background 0.1s;
    }

    .nav-btn:hover {
      background: var(--chrome-btn-hover, rgba(255, 255, 255, 0.1));
    }

    .nav-btn:active {
      background: var(--chrome-btn-active, rgba(255, 255, 255, 0.2));
    }

    /* ---- Omnibox ---- */

    .omnibox {
      flex: 1;
      display: flex;
      align-items: center;
      height: 28px;
      border-radius: 20px;
      background: var(--chrome-omnibox-bg, var(--chrome-body));
      border: 1px solid var(--chrome-border);
      padding: 0 8px;
      cursor: text;
      overflow: hidden;
      gap: 4px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .omnibox.editing {
      border-color: var(--mux-accent, #7aa2f7);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--mux-accent, #7aa2f7) 30%, transparent);
    }

    /* ---- Lock icon ---- */

    .lock-icon {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      font-size: 11px;
    }

    .lock-icon.https {
      color: var(--mux-ok, #9ece6a);
    }

    .lock-icon.http {
      color: var(--chrome-text-dim);
    }

    /* ---- URL display spans ---- */

    .url-host {
      font-size: 12px;
      color: var(--chrome-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex-shrink: 1;
      min-width: 0;
    }

    .url-path {
      font-size: 12px;
      color: var(--chrome-text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex-shrink: 2;
      min-width: 0;
    }

    /* ---- Reload button (inside omnibox) ---- */

    .reload-btn {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: none;
      background: transparent;
      color: var(--chrome-text-dim);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      padding: 0;
      margin-left: auto;
      transition: background 0.1s;
    }

    .reload-btn:hover {
      background: var(--chrome-btn-hover, rgba(255, 255, 255, 0.1));
      color: var(--chrome-text);
    }

    /* ---- URL input (editing mode) ---- */

    .url-input {
      flex: 1;
      border: none;
      background: transparent;
      outline: none;
      color: var(--chrome-text);
      font-size: 12px;
      font-family: inherit;
      min-width: 0;
    }

    .url-input::placeholder {
      color: var(--chrome-text-dim);
    }

    /* ---- FPS badge ---- */

    .fps-badge {
      font-size: 11px;
      font-family: monospace;
      color: var(--mux-ok, #9ece6a);
      flex-shrink: 0;
      padding: 0 4px;
    }

    /* ---- Live dot ---- */

    .live-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--mux-ok, #9ece6a);
      flex-shrink: 0;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.4;
      }
    }

    /* ---- Canvas wrap ---- */

    .canvas-wrap {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    canvas {
      display: block;
      width: 100%;
      height: 100%;
      /* object-fit intentionally omitted: canvas is not a replaced element;
         the property has no effect but can confuse browser layout in Lit shadow DOM. */
      outline: none;
    }

    /* ---- Status bar ---- */

    .status-bar {
      position: absolute;
      bottom: 4px;
      left: 4px;
      max-width: 60%;
      background: var(--chrome-bar);
      color: var(--chrome-text-dim);
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 3px;
      opacity: 0;
      transition: opacity 0.15s;
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-bar.visible {
      opacity: 1;
    }

    /* ---- Download overlay ---- */

    .download-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--chrome-body) 85%, transparent);
      gap: 12px;
    }

    .download-label {
      font-size: 13px;
      color: var(--chrome-text);
    }

    .download-bar {
      width: 260px;
      height: 6px;
      border-radius: 3px;
      background: var(--chrome-border);
      overflow: hidden;
    }

    .download-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--mux-accent, #7aa2f7);
      transition: width 0.3s ease;
    }

    /* ---- Error banner ---- */

    .error-banner {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      background: var(--mux-error-bg, color-mix(in srgb, var(--mux-error, #f7768e) 20%, transparent));
      color: var(--mux-error, #f7768e);
      font-size: 12px;
      padding: 6px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .error-dismiss {
      background: transparent;
      border: none;
      color: var(--mux-error, #f7768e);
      cursor: pointer;
      font-size: 14px;
      padding: 0 4px;
      flex-shrink: 0;
    }
  `;

  // -------------------------------------------------------------------------
  // Properties and state
  // -------------------------------------------------------------------------

  @property({ type: Number, attribute: 'pane-id' })
  paneId: number = 0;

  @state() private _url = '';
  @state() private _fps = 0;
  @state() private _editingUrl = false;
  @state() private _urlInput = '';
  @state() private _statusText = '';
  @state() private _downloading = false;
  @state() private _downloadPercent = 0;
  @state() private _errorText = '';

  @query('#viewport')
  private _canvas!: HTMLCanvasElement;

  // -------------------------------------------------------------------------
  // Private fields
  // -------------------------------------------------------------------------

  private _ctx: CanvasRenderingContext2D | null = null;
  private _pendingFrame: Uint8Array | null = null;
  private _renderScheduled = false;
  private _fpsFrameCount = 0;
  private _fpsTimer: ReturnType<typeof setInterval> | undefined;
  // _resizeObserver intentionally removed — clients do not control the
  // Chromium viewport. See comment in firstUpdated() for rationale.

  // Stable per-WebSocket-connection ID. Generated once per component instance.
  private readonly _clientId: string = Math.random().toString(36).slice(2);

  // Stable per-device ID persisted in localStorage.
  private readonly _deviceId: string = MuxBrowserPane._getOrCreateDeviceId();

  private static _getOrCreateDeviceId(): string {
    const key = 'muxterm-device-id';
    let id = localStorage.getItem(key);
    if (!id) {
      id = Math.random().toString(36).slice(2);
      localStorage.setItem(key, id);
    }
    return id;
  }

  private _sendBrowserFocus(): void {
    if (!this._canvas) return;
    const rect = this._canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w > 0 && h > 0) {
      wsBrowser.send({
        type: SessiondType.BrowserInput,
        paneId: this.paneId,
        event: {
          type: 'browser-focus',
          clientId: this._clientId,
          deviceId: this._deviceId,
          renderWidth: w,
          renderHeight: h,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    browserRegistry.ensure(this.paneId);
    browserRegistry.setCallbacks(this.paneId, {
      onFrame: this._onFrame,
      onUrl: this._onUrl,
      onError: this._onError,
      onDownload: this._onDownload,
      onStatus: this._onStatus,
      onCursor: this._onCursor,
      onGranted: null,
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    browserRegistry.setCallbacks(this.paneId, {
      onFrame: null,
      onUrl: null,
      onError: null,
      onDownload: null,
      onStatus: null,
      onCursor: null,
      onGranted: null,
    });
    if (this._fpsTimer !== undefined) {
      clearInterval(this._fpsTimer);
      this._fpsTimer = undefined;
    }
    // No resize observer to disconnect.
    // Release input authority on unmount.
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'browser-blur', clientId: this._clientId, deviceId: this._deviceId },
    });
    this._ctx = null;
    this._pendingFrame = null;
  }

  protected override firstUpdated(): void {
    // Get 2D rendering context
    this._ctx = this._canvas.getContext('2d');

    // Claim input authority and report canvas render size.
    this._sendBrowserFocus();

    // FPS counter: update every 1 second
    this._fpsTimer = setInterval(() => {
      this._fps = this._fpsFrameCount;
      this._fpsFrameCount = 0;
    }, 1000);

    // Mouse event listeners
    this._canvas.addEventListener('mousemove', this._onMouseMove);
    this._canvas.addEventListener('mousedown', this._onMouseDown);
    this._canvas.addEventListener('mouseup', this._onMouseUp);
    this._canvas.addEventListener('mouseleave', this._onMouseLeave);
    this._canvas.addEventListener('wheel', this._onWheel, { passive: false });

    // Keyboard event listeners
    this._canvas.addEventListener('keydown', this._onKeyDown);
    this._canvas.addEventListener('keyup', this._onKeyUp);
  }

  // -------------------------------------------------------------------------
  // Registry callbacks (arrow functions for correct `this`)
  // -------------------------------------------------------------------------

  private readonly _onFrame = (jpegBytes: Uint8Array): void => {
    // Latest-frame-wins: drop previous pending frame
    this._pendingFrame = jpegBytes;
    if (!this._renderScheduled) {
      this._renderScheduled = true;
      requestAnimationFrame(() => this._flushFrame());
    }
  };

  private _flushFrame(): void {
    this._renderScheduled = false;
    const pending = this._pendingFrame;
    if (!pending || !this._ctx) return;
    this._pendingFrame = null;

    // .slice() produces Uint8Array<ArrayBuffer> (not SharedArrayBuffer), satisfying BlobPart
    const blob = new Blob([pending.slice()], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      if (!this._ctx) return;
      // Adjust canvas backing-store size to match natural image size
      if (
        this._canvas.width !== img.naturalWidth ||
        this._canvas.height !== img.naturalHeight
      ) {
        this._canvas.width = img.naturalWidth;
        this._canvas.height = img.naturalHeight;
      }
      this._ctx.drawImage(img, 0, 0);
      this._fpsFrameCount++;
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
    };

    img.src = url;
  }

  private readonly _onUrl = (url: string): void => {
    this._url = url;
    this._editingUrl = false;
    this._urlInput = url;
  };

  private readonly _onError = (error: string): void => {
    this._errorText = error;
    this._downloading = false;
  };

  private readonly _onDownload = (percent: number): void => {
    this._downloading = percent < 100;
    this._downloadPercent = percent;
  };

  private readonly _onStatus = (statusText: string): void => {
    this._statusText = statusText;
  };

  private readonly _onCursor = (cursor: string): void => {
    if (this._canvas) this._canvas.style.cursor = cursor;
  };

  // -------------------------------------------------------------------------
  // Coordinate mapping
  // -------------------------------------------------------------------------

  private _toViewport(e: MouseEvent): { x: number; y: number } {
    const rect = this._canvas.getBoundingClientRect();
    const scaleX = this._canvas.width / rect.width;
    const scaleY = this._canvas.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  }

  // -------------------------------------------------------------------------
  // Mouse relay
  // -------------------------------------------------------------------------

  private readonly _onMouseMove = (e: MouseEvent): void => {
    const { x, y } = this._toViewport(e);
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'mousemove', x, y },
    });
  };

  private readonly _onMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    this._canvas.focus();
    const { x, y } = this._toViewport(e);
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'mousedown', button: (['left', 'middle', 'right'][e.button] ?? 'left'), x, y },
    });
  };

  private readonly _onMouseUp = (e: MouseEvent): void => {
    const { x, y } = this._toViewport(e);
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'mouseup', button: (['left', 'middle', 'right'][e.button] ?? 'left'), x, y },
    });
  };

  private readonly _onMouseLeave = (): void => {
    this._statusText = '';
  };

  private readonly _onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { x, y } = this._toViewport(e);
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'wheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY },
    });
  };

  // -------------------------------------------------------------------------
  // Keyboard relay
  // -------------------------------------------------------------------------

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    if (this._editingUrl) return;
    const isModifier =
      e.key === 'Control' ||
      e.key === 'Alt' ||
      e.key === 'Shift' ||
      e.key === 'Meta';
    if (!isModifier) e.preventDefault();
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'keydown', key: e.key },
    });
    // NO type event — keydown/keyup carry text input via CDP key text field
  };

  private readonly _onKeyUp = (e: KeyboardEvent): void => {
    if (this._editingUrl) return;
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'keyup', key: e.key },
    });
  };

  // -------------------------------------------------------------------------
  // URL bar logic
  // -------------------------------------------------------------------------

  private _parseUrl(url: string): ParsedUrl {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname,
        path: parsed.pathname + parsed.search + parsed.hash,
        isHttps: parsed.protocol === 'https:',
      };
    } catch {
      return { host: url, path: '', isHttps: false };
    }
  }

  private _goBack(): void {
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'navigate', url: 'history:back' },
    });
  }

  private _goForward(): void {
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'navigate', url: 'history:forward' },
    });
  }

  private _reload(): void {
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'navigate', url: 'history:reload' },
    });
  }

  private _startEditUrl(): void {
    this._urlInput = this._url;
    this._editingUrl = true;
    requestAnimationFrame(() => {
      const input =
        this.shadowRoot?.querySelector<HTMLInputElement>('.url-input');
      input?.focus();
      input?.select();
    });
  }

  private _cancelEditUrl(): void {
    this._editingUrl = false;
    this._urlInput = this._url;
  }

  private _onUrlInput(e: Event): void {
    this._urlInput = (e.target as HTMLInputElement).value;
  }

  private _onUrlKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this._navigate(this._urlInput);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this._cancelEditUrl();
    }
  }

  private _navigate(url: string): void {
    this._editingUrl = false;
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'navigate', url: target },
    });
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  protected override render() {
    const parsed = this._parseUrl(this._url);
    const hasStatus = this._statusText.length > 0;
    const hasError = this._errorText.length > 0;

    return html`
      <div class="browser-toolbar">
        <!-- Back -->
        <button
          class="nav-btn"
          title="Back"
          @click=${() => this._goBack()}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>

        <!-- Forward -->
        <button
          class="nav-btn"
          title="Forward"
          @click=${() => this._goForward()}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>

        <!-- Omnibox -->
        <div
          class=${`omnibox${this._editingUrl ? ' editing' : ''}`}
          @click=${() => { if (!this._editingUrl) this._startEditUrl(); }}
        >
          ${this._editingUrl
            ? html`
                <input
                  class="url-input"
                  type="text"
                  .value=${this._urlInput}
                  placeholder="Enter URL or search"
                  @input=${this._onUrlInput}
                  @keydown=${this._onUrlKeyDown}
                  @blur=${() => this._cancelEditUrl()}
                />
              `
            : html`
                <!-- Lock icon -->
                <span class=${`lock-icon${parsed.isHttps ? ' https' : ' http'}`}>
                  ${parsed.isHttps
                    ? html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`
                    : html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>`}
                </span>
                <span class="url-host">${parsed.host}</span>
                <span class="url-path">${parsed.path}</span>
                <!-- Reload inside pill -->
                <button
                  class="reload-btn"
                  title="Reload"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this._reload();
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                </button>
              `}
        </div>

        <!-- FPS badge -->
        <span class="fps-badge">${this._fps}fps</span>

        <!-- Live dot -->
        <span class="live-dot"></span>
      </div>

      <!-- Canvas area -->
      <div class="canvas-wrap">
        <canvas
          id="viewport"
          tabindex="0"
        ></canvas>

        <!-- Status bar -->
        <div class=${`status-bar${hasStatus ? ' visible' : ''}`}>
          ${this._statusText}
        </div>

        <!-- Download overlay -->
        ${this._downloading
          ? html`
              <div class="download-overlay">
                <div class="download-label">
                  Preparing browser… ${this._downloadPercent}%
                </div>
                <div class="download-bar">
                  <div
                    class="download-fill"
                    style="width: ${this._downloadPercent}%"
                  ></div>
                </div>
              </div>
            `
          : ''}

        <!-- Error banner -->
        ${hasError
          ? html`
              <div class="error-banner">
                <span>${this._errorText}</span>
                <button
                  class="error-dismiss"
                  title="Dismiss"
                  @click=${() => { this._errorText = ''; }}
                >✕</button>
              </div>
            `
          : ''}
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// Global element type augmentation
// ---------------------------------------------------------------------------

declare global {
  interface HTMLElementTagNameMap {
    'mux-browser-pane': MuxBrowserPane;
  }
}
