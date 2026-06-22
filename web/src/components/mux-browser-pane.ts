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
// Module-level active-pane tracker
// ---------------------------------------------------------------------------

// Tracks which browser pane (by paneId) currently holds input authority.
// Used by the window-level keyboard listener to only capture when active.
let _activeBrowserPaneId: number | null = null;

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
  private _resizeObserver: ResizeObserver | undefined;
  private _hasFirstUpdated = false;
  // True once the first browser-focus has been sent with valid canvas dimensions.
  // Frames received before viewport is initialized are suppressed so a Mac Retina
  // client never renders an initial wrong-DPR frame from the default DPR=1 viewport.
  private _viewportInitialized = false;
  // Fallback timer: if BrowserGranted doesn't arrive within 2 s of _sendBrowserFocus,
  // force _viewportInitialized true so the canvas isn't permanently blank.
  private _viewportFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  // Letterbox transform computed during the last frame draw.
  // Used by _toViewport to map mouse coordinates into Chromium space.
  private _letterbox = { dx: 0, dy: 0, scale: 1, fw: 0, fh: 0 };
  // True while a mouse button is held down (between mousedown and mouseup).
  // Used to clamp coordinates during drag so selection can reach the viewport edge.
  private _isDragging = false;

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
    if (w <= 0 || h <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    // Set letterbox to CSS px dimensions. Chrome sends 2x JPEG frames (w×dpr wide)
    // but those won't match _letterbox.fw=w, so the guard in _drawLetterboxed
    // won't update the letterbox from 2x frames — which is correct. scale stays
    // 1.0 so _toViewport produces CSS-px coordinates that match Chrome's logical
    // viewport (also w CSS px wide). offsetX → x is a 1:1 identity.
    this._letterbox = { dx: 0, dy: 0, scale: 1, fw: w, fh: h };

    wsBrowser.send({
      type: 'browser-focus',
      paneId: this.paneId,
      deviceId: this._deviceId,
      renderWidth: w,
      renderHeight: h,
      devicePixelRatio: dpr,
    });
    // Don't set _viewportInitialized here. Wait for BrowserGranted (server
    // confirmation that stopScreencast drained old frames, new viewport applied,
    // and 2x screenshot queued). Old frames are guaranteed to arrive BEFORE
    // BrowserGranted in the FIFO subscriber queue — suppressing them here prevents
    // the pillarboxed flash. _onGranted sets the flag when BrowserGranted arrives.
    //
    // Fallback: if BrowserGranted never arrives (hidden pane at reconnect,
    // network hiccup) force the flag after 2 s so the canvas isn't permanently blank.
    if (this._viewportFallbackTimer !== null) clearTimeout(this._viewportFallbackTimer);
    this._viewportFallbackTimer = setTimeout(() => {
      this._viewportFallbackTimer = null;
      this._viewportInitialized = true;
    }, 2000);
    // Re-claim DOM focus whenever we claim input authority. Deferred with rAF
    // so that any in-progress dockview focus management (which runs synchronously
    // during a tab-click) settles before we claim the canvas. Without the defer,
    // dockview steals focus back and keyboard events never reach the canvas.
    requestAnimationFrame(() => this._canvas?.focus({ preventScroll: true }));
  }

  private readonly _onPanelActivated = (e: Event): void => {
    const detail = (e as CustomEvent<{ paneId: number }>).detail;
    if (detail?.paneId !== this.paneId) return;
    _activeBrowserPaneId = this.paneId;
    this._sendBrowserFocus();
  };

  private readonly _onWindowFocus = (): void => {
    // Re-claim authority when the OS window regains focus.
    this._sendBrowserFocus();
  };

  private readonly _onWindowBlur = (): void => {
    wsBrowser.send({
      type: 'browser-blur',
      paneId: this.paneId,
      deviceId: this._deviceId,
    });
  };

  /**
   * Returns the ResizeObserver callback used to track canvas size changes.
   * Extracted into a method so it can be reused identically in firstUpdated()
   * and connectedCallback() (the reconnect path).
   */
  private _makeResizeObserver(): ResizeObserverCallback {
    return (entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const w = Math.round(width);
      const h = Math.round(height);
      if (w <= 0 || h <= 0) return;

      // Size the canvas buffer in CSS pixels. The server sends 2x JPEG frames
      // (renderWidth × dpr pixels wide). Drawing a 2120px JPEG at scale=0.5
      // into a 1060-wide canvas buffer means the browser's Retina compositing
      // doubles it back to 2120 physical pixels — 1 JPEG px = 1 screen px = crisp.
      // Using CSS px here also keeps _toViewport simple: offsetX (CSS px) maps
      // directly to Chrome's logical viewport coordinates with scale=1.0, no dpr math.
      const bufferChanged = this._canvas.width !== w || this._canvas.height !== h;
      if (bufferChanged) {
        this._canvas.width = w;
        this._canvas.height = h;
        this._ctx = this._canvas.getContext('2d');
      }

      // Report new render size to server (focus + viewport update).
      // Call even if buffer didn't change — the server needs the size signal
      // when the pane first becomes visible after being hidden.
      this._sendBrowserFocus();
    };
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
      onGranted: this._onGranted,
    });
    window.addEventListener('browser-pane-activated', this._onPanelActivated);
    window.addEventListener('focus', this._onWindowFocus);
    window.addEventListener('blur', this._onWindowBlur);
    window.addEventListener('keydown', this._onWindowKeyDown, { capture: true });
    window.addEventListener('keyup', this._onWindowKeyUp, { capture: true });
    window.addEventListener('non-browser-pane-activated', this._onNonBrowserPaneActivated);
    // Re-send browser-focus every time the /ws/browser socket (re)connects.
    // wsBrowser.send() is a no-op when not open, so firstUpdated / ResizeObserver
    // callbacks that fire before the socket is open silently drop the message.
    // onReconnect fires exactly when the socket becomes OPEN, guaranteeing delivery.
    wsBrowser.onReconnect = () => {
      // Reset viewport flag so stale frames from the old viewport are suppressed
      // until the new browser-focus has been sent with the current canvas dimensions.
      this._viewportInitialized = false;
      this._sendBrowserFocus();
    };

    // If firstUpdated has already run (reconnect case), restart the ResizeObserver
    // and re-acquire the canvas context. Both were cleared in disconnectedCallback().
    if (this._hasFirstUpdated && this._canvas) {
      if (!this._ctx) {
        this._ctx = this._canvas.getContext('2d');
      }
      this._resizeObserver = new ResizeObserver(this._makeResizeObserver());
      this._resizeObserver.observe(this._canvas);
      this._canvas.focus({ preventScroll: true });
    }
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
    window.removeEventListener('browser-pane-activated', this._onPanelActivated);
    window.removeEventListener('focus', this._onWindowFocus);
    window.removeEventListener('blur', this._onWindowBlur);
    window.removeEventListener('keydown', this._onWindowKeyDown, { capture: true });
    window.removeEventListener('keyup', this._onWindowKeyUp, { capture: true });
    window.removeEventListener('non-browser-pane-activated', this._onNonBrowserPaneActivated);
    if (_activeBrowserPaneId === this.paneId) {
      _activeBrowserPaneId = null;
    }
    wsBrowser.onReconnect = null;
    if (this._fpsTimer !== undefined) {
      clearInterval(this._fpsTimer);
      this._fpsTimer = undefined;
    }
    this._resizeObserver?.disconnect();
    this._resizeObserver = undefined;
    // Release input authority on unmount.
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'browser-blur', clientId: this._clientId, deviceId: this._deviceId },
    });
    this._pendingFrame = null;
  }

  protected override firstUpdated(): void {
    this._hasFirstUpdated = true;

    // Get 2D rendering context
    this._ctx = this._canvas.getContext('2d');

    // Size the canvas buffer NOW from CSS layout so the first screenshot
    // renders into a correctly-sized buffer. Without this, canvas.width stays
    // at the HTML default (300) until ResizeObserver fires asynchronously,
    // causing _drawLetterboxed to render the screenshot at ~34px (invisible).
    const rect = this._canvas.getBoundingClientRect();
    const w0 = Math.round(rect.width);
    const h0 = Math.round(rect.height);
    if (w0 > 0 && h0 > 0) {
      this._canvas.width = w0;
      this._canvas.height = h0;
      this._ctx = this._canvas.getContext('2d');
    }

    this._resizeObserver = new ResizeObserver(this._makeResizeObserver());
    this._resizeObserver.observe(this._canvas);

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

    // Claim DOM focus so keyboard events reach the canvas immediately.
    // Without this, the user must click before typing works.
    this._canvas.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // Registry callbacks (arrow functions for correct `this`)
  // -------------------------------------------------------------------------

  private readonly _onFrame = (jpegBytes: Uint8Array): void => {
    // Suppress frames until the client has sent browser-focus with valid canvas
    // dimensions. This prevents rendering an initial wrong-DPR frame that the
    // server sends from its default DPR=1 viewport before the Mac Retina client's
    // devicePixelRatio=2 is applied.
    if (!this._viewportInitialized) return;
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
    if (!pending) return;
    // Re-acquire context if it was cleared (e.g. after disconnect/reconnect).
    // CanvasRenderingContext2D is not invalidated by DOM removal — re-getting it
    // returns the same live context.
    if (!this._ctx && this._canvas) {
      this._ctx = this._canvas.getContext('2d');
    }
    if (!this._ctx) return;
    this._pendingFrame = null;

    // .slice() produces Uint8Array<ArrayBuffer> (not SharedArrayBuffer), satisfying BlobPart
    const blob = new Blob([pending.slice()], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      if (!this._ctx) return;
      // Canvas buffer is sized by ResizeObserver (CSS container size).
      // Draw the frame with letterbox math — see _drawLetterboxed.
      this._drawLetterboxed(img);
      this._fpsFrameCount++;
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
    };

    img.src = url;
  }

  /**
   * Draw img centered in the canvas buffer maintaining aspect ratio.
   * Fills the canvas width or height with the frame, leaving black bars
   * on the opposite axis (pillarbox / letterbox). Stores the transform
   * in this._letterbox for use by _toViewport().
   *
   * Design doc math:
   *   s  = Math.min(cw / fw, ch / fh)   uniform scale to fit
   *   dx = (cw - fw * s) / 2             horizontal offset (pillarbox bars)
   *   dy = (ch - fh * s) / 2             vertical offset (letterbox bars)
   */
  private _drawLetterboxed(img: HTMLImageElement): void {
    if (!this._ctx) return;
    const cw = this._canvas.width;
    const ch = this._canvas.height;
    const fw = img.naturalWidth;
    const fh = img.naturalHeight;

    if (cw === 0 || ch === 0 || fw === 0 || fh === 0) return;

    const scale = Math.min(cw / fw, ch / fh);
    const dx = (cw - fw * scale) / 2;
    const dy = (ch - fh * scale) / 2;

    // Always draw the frame. Update the letterbox only when dimensions match
    // what we requested (fw === _letterbox.fw) to keep click mapping correct.
    // We still draw wrong-size frames — they may appear briefly letterboxed but
    // will be overwritten within milliseconds by the correct-size screenshot/
    // screencast frames that follow. Rejecting them entirely caused blank canvas.
    if (fw === this._letterbox.fw || this._letterbox.fw === 0) {
      this._letterbox = { dx, dy, scale, fw, fh };
    }
    this._ctx.clearRect(0, 0, cw, ch);
    this._ctx.drawImage(img, dx, dy, fw * scale, fh * scale);
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

  // BrowserGranted arrives when the server has processed browser-focus:
  // stopScreencast drained old frames, SetViewport applied, 2x screenshot queued,
  // 2x screencast starting. All old wrong-size frames are guaranteed to arrive
  // BEFORE BrowserGranted in the FIFO subscriber queue. Setting the flag here
  // means the first frame the client renders is the correct 2x screenshot.
  private readonly _onGranted = (_clientId: string): void => {
    if (this._viewportFallbackTimer !== null) {
      clearTimeout(this._viewportFallbackTimer);
      this._viewportFallbackTimer = null;
    }
    this._viewportInitialized = true;
  };

  // -------------------------------------------------------------------------
  // Coordinate mapping
  // -------------------------------------------------------------------------

  /**
   * Map a MouseEvent's offsetX/offsetY into Chromium viewport coordinates
   * using the stored letterbox transform.
   *
   * Returns null when:
   *   - The letterbox transform is not yet initialised (no frames received)
   *   - The click is in the black bars (outside the rendered frame area)
   *
   * offsetX/offsetY are relative to the canvas element itself (canvas-local
   * CSS pixels), so no clientX/clientRect math is needed.
   */
  private _toViewport(e: MouseEvent, clamp = false): { x: number; y: number } | null {
    const { dx, dy, scale, fw, fh } = this._letterbox;
    if (!fw || !fh) return null;
    let x = (e.offsetX - dx) / scale;
    let y = (e.offsetY - dy) / scale;
    if (clamp) {
      // During drag, clamp to viewport edges so selection can reach the boundary.
      x = Math.max(0, Math.min(fw, x));
      y = Math.max(0, Math.min(fh, y));
    } else {
      if (x < 0 || y < 0 || x > fw || y > fh) return null;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  /** Compute the CDP modifiers bitmask from a mouse or keyboard event. */
  private _cdpModifiers(e: MouseEvent | KeyboardEvent): number {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  // -------------------------------------------------------------------------
  // Mouse relay
  // -------------------------------------------------------------------------

  private readonly _onMouseMove = (e: MouseEvent): void => {
    const coords = this._toViewport(e, this._isDragging);
    if (!coords) return;
    // Derive the primary held button name from the buttons bitmask.
    // CDP mouseMoved needs this to handle drag-selection and other
    // press-while-move interactions.
    const button: string =
      e.buttons & 1 ? 'left' :
      e.buttons & 4 ? 'middle' :
      e.buttons & 2 ? 'right' : 'none';
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: {
        type: 'mousemove',
        x: coords.x,
        y: coords.y,
        button,
        buttons: e.buttons,
        modifiers: this._cdpModifiers(e),
      },
    });
  };

  private readonly _onMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    this._canvas.focus({ preventScroll: true });
    // Capture pointer so mousemove/mouseup fire on the canvas even if the
    // mouse leaves its bounds during drag-selection. MouseEvent does not
    // expose pointerId in the type system, but at runtime browsers assign
    // pointerId=1 for the primary mouse pointer; the cast is safe here and
    // errors are swallowed by the try/catch.
    try { this._canvas.setPointerCapture((e as PointerEvent).pointerId); } catch { /* ignore */ }
    this._isDragging = true;
    const coords = this._toViewport(e);
    if (!coords) return;
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'mousedown', button: (['left', 'middle', 'right'][e.button] ?? 'left'), x: coords.x, y: coords.y, buttons: e.buttons, modifiers: this._cdpModifiers(e) },
    });
  };

  private readonly _onMouseUp = (e: MouseEvent): void => {
    this._isDragging = false;
    try {
      if (this._canvas.hasPointerCapture((e as PointerEvent).pointerId)) {
        this._canvas.releasePointerCapture((e as PointerEvent).pointerId);
      }
    } catch { /* ignore */ }
    const coords = this._toViewport(e, true);  // clamp on release too
    if (!coords) return;
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'mouseup', button: (['left', 'middle', 'right'][e.button] ?? 'left'), x: coords.x, y: coords.y, buttons: e.buttons, modifiers: this._cdpModifiers(e) },
    });
  };

  private readonly _onMouseLeave = (): void => {
    this._statusText = '';
  };

  private readonly _onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const coords = this._toViewport(e);
    if (!coords) return;
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'wheel', x: coords.x, y: coords.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: this._cdpModifiers(e) },
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
      event: { type: 'keydown', key: e.key, modifiers: this._cdpModifiers(e) },
    });
    // NO type event — keydown/keyup carry text input via CDP key text field
  };

  private readonly _onKeyUp = (e: KeyboardEvent): void => {
    if (this._editingUrl) return;
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'keyup', key: e.key, modifiers: this._cdpModifiers(e) },
    });
  };

  /**
   * Window-level keydown capture for when the canvas doesn't hold DOM focus.
   * Canvas focus is unreliable (dockview steals it), so we capture at window
   * level and only forward when this is the active browser pane.
   */
  private readonly _onWindowKeyDown = (e: KeyboardEvent): void => {
    // Only forward when this pane holds input authority.
    if (_activeBrowserPaneId !== this.paneId) return;
    // Never intercept URL bar editing.
    if (this._editingUrl) return;
    // Skip only when the event's innermost target IS the canvas — in that
    // case the canvas keydown listener (_onKeyDown) handles it directly.
    // Do NOT skip for shadow-host-targeted events (CDP/playwright fires on
    // document.activeElement = mux-browser-pane when canvas has shadow-DOM
    // focus) or document.body events (dockview may have stolen canvas focus).
    const innermost = e.composedPath()[0] as EventTarget;
    if (innermost === (this._canvas as unknown as EventTarget)) return;

    const isModifier =
      e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta';
    if (!isModifier) e.preventDefault();
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'keydown', key: e.key, modifiers: this._cdpModifiers(e) },
    });
  };

  private readonly _onWindowKeyUp = (e: KeyboardEvent): void => {
    if (_activeBrowserPaneId !== this.paneId) return;
    if (this._editingUrl) return;
    const innermost = e.composedPath()[0] as EventTarget;
    if (innermost === (this._canvas as unknown as EventTarget)) return;
    wsBrowser.send({
      type: SessiondType.BrowserInput,
      paneId: this.paneId,
      event: { type: 'keyup', key: e.key, modifiers: this._cdpModifiers(e) },
    });
  };

  /** Called when any non-browser pane activates — clears our active status. */
  private readonly _onNonBrowserPaneActivated = (): void => {
    if (_activeBrowserPaneId === this.paneId) {
      _activeBrowserPaneId = null;
    }
  };

  // -------------------------------------------------------------------------
  // URL bar logic
  // -------------------------------------------------------------------------

  private _parseUrl(url: string): ParsedUrl {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.host,  // includes port, e.g. "localhost:3000" not just "localhost"
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
    _activeBrowserPaneId = this.paneId;
    requestAnimationFrame(() => this._canvas?.focus({ preventScroll: true }));
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
