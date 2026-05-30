import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import xtermCss from '@xterm/xterm/css/xterm.css?raw';

// Tokyo Night theme — matches the rest of the UI
const THEME = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#283457',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
};

@customElement('mux-pane')
export class MuxPane extends LitElement {
  static styles = [
    unsafeCSS(xtermCss),
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: ${unsafeCSS(THEME.background)};
      }
      #container {
        width: 100%;
        height: 100%;
        background: ${unsafeCSS(THEME.background)};
      }
      /* xterm.js viewport fills the container */
      #container .xterm {
        height: 100%;
      }
      #container .xterm-viewport {
        /* xterm.js default CSS sets this to #000; override with theme color so
           the viewport background always matches the terminal theme. */
        background-color: ${unsafeCSS(THEME.background)} !important;
      }
    `,
  ];

  @property({ type: Number, attribute: 'pane-id' })
  paneId = 0;

  @property({ type: Boolean, reflect: true })
  active = false;

  private _term: Terminal | null = null;
  private _fitAddon: FitAddon | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private _encoder = new TextEncoder();
  private _pendingData: (Uint8Array | string)[] = [];
  // Last dimensions we told the server. Used to make resize idempotent —
  // we only emit a resize when the size ACTUALLY changes. This is the brake
  // that makes resize feedback loops impossible: writing content never changes
  // the container, so fit() yields the same size, so nothing is dispatched.
  private _lastCols = -1;
  private _lastRows = -1;

  connectedCallback(): void {
    super.connectedCallback();
    // updateComplete resolves after the first render, so the container exists
    this.updateComplete.then(() => this._initTerminal());
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (this._resizeTimer !== undefined) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = undefined;
    }
    this._term?.dispose();
    this._term = null;
    this._fitAddon = null;
  }

  writeData(data: Uint8Array | string): void {
    if (this._term) {
      this._term.write(data);
    } else {
      this._pendingData.push(data);
    }
  }

  focusTerminal(): void {
    this._term?.focus();
  }

  /**
   * Returns the text currently visible in the terminal viewport — no OCR needed.
   * Reads directly from xterm.js's internal buffer for exact character accuracy.
   *
   * Example (Playwright):
   *   const text = await page.evaluate(() => {
   *     const layout = document.querySelector('mux-layout');
   *     const pane = layout.shadowRoot.querySelector('mux-pane');
   *     return pane.getVisibleContent();
   *   });
   */
  getVisibleContent(): string {
    if (!this._term) return '';
    const buf = this._term.buffer.active;
    const lines: string[] = [];
    for (let y = buf.viewportY; y < buf.viewportY + this._term.rows; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  }

  /**
   * Returns every line in the buffer including scrollback history.
   * Lines are right-trimmed. Useful for asserting on past output.
   */
  getBufferLines(): string[] {
    if (!this._term) return [];
    const buf = this._term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  // Called on full-sync (reconnect) before new capture-pane content arrives.
  // ESC c = RIS (Reset to Initial State) — clears screen and scrollback.
  //
  // This ONLY clears the screen. It deliberately does NOT report size:
  // size is reported solely when the container actually changes (via the
  // ResizeObserver → fit → onResize path, gated by _emitResize). Mixing
  // size-reporting into the sync path is what created the resize storm
  // (full-sync → report → resize → re-sync → full-sync → ...).
  resetTerminal(): void {
    if (this._term) {
      this._term.write('\x1bc');
    } else {
      this._pendingData = [];
    }
  }

  // The single, idempotent path for telling the server our size. If cols/rows
  // are unchanged from the last value we sent, this is a no-op. That property
  // makes resize feedback loops impossible: content writes don't change the
  // container, so fit() yields the same size, so nothing is dispatched.
  private _emitResize(cols: number, rows: number): void {
    if (cols === this._lastCols && rows === this._lastRows) return;
    this._lastCols = cols;
    this._lastRows = rows;
    this.dispatchEvent(
      new CustomEvent('pane-resize', {
        bubbles: true,
        composed: true,
        detail: { paneId: this.paneId, cols, rows },
      }),
    );
  }

  private _initTerminal(): void {
    const container = this.shadowRoot?.querySelector<HTMLElement>('#container');
    if (!container) return;

    // Set background via inline style — CSS adoption in Shadow DOM is async and
    // can lag behind rendering. Inline style is synchronous and guaranteed to beat
    // the first paint, plugging any right/bottom edge gap before xterm.js draws.
    container.style.background = THEME.background;

    const term = new Terminal({
      theme: THEME,
      fontFamily: "'SF Mono', 'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Fira Code', 'Menlo', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,        // xterm owns display scrollback; matches tmux history-limit. tmux capture-pane reseeds on connect.
      allowTransparency: false,
      convertEol: false,       // tmux sends \r\n — don't double-convert
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);      // synchronous — no await needed
    // No explicit initial fit here. The ResizeObserver below fires its first
    // callback (asynchronously, after layout) as soon as we start observing,
    // giving FitAddon a correct clientWidth from a settled flex layout.
    // Fitting synchronously (or even in one rAF) here races against flexbox.

    // Input: forward keystrokes/paste/SGR mouse sequences to tmux.
    // xterm.js emits UTF-8 text (including SGR mouse reports) via onData.
    term.onData((data) => {
      this.dispatchEvent(
        new CustomEvent('pane-input', {
          bubbles: true,
          composed: true,
          detail: { paneId: this.paneId, data: this._encoder.encode(data) },
        }),
      );
    });

    // Forward legacy (non-UTF8, non-SGR) binary mouse reports via onBinary.
    // These are rare but needed for apps using X10/UTF-8 mouse encoding.
    term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      this.dispatchEvent(new CustomEvent('pane-input', {
        bubbles: true, composed: true,
        detail: { paneId: this.paneId, data: bytes },
      }));
    });

    // Resize: FitAddon measured cols/rows — tell tmux (idempotent).
    term.onResize(({ cols, rows }) => this._emitResize(cols, rows));

    // Re-fit when the container changes size (window resize, pane drag, etc.).
    // 50ms trailing debounce collapses a rapid burst (e.g. window drag at 60fps)
    // into a single fit(); the inner rAF guards against ResizeObserver loop errors.
    const ro = new ResizeObserver(() => {
      if (this._resizeTimer !== undefined) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        requestAnimationFrame(() => this._fitAddon?.fit());
      }, 50);
    });
    ro.observe(container);

    this._term = term;
    this._fitAddon = fitAddon;
    this._resizeObserver = ro;

    // Fit immediately (synchronous) so onResize fires and tmux gets the real
    // dimensions BEFORE any capture-pane content arrives over the WebSocket.
    // The ResizeObserver also fires, but asynchronously — without this eager
    // fit, content arrives at tmux's default 80x24 and wraps incorrectly.
    fitAddon.fit();
    term.focus();

    // Second fit after fonts settle — SF Mono / JetBrains Mono may not be
    // loaded at open() time, causing a slightly wrong char width measurement.
    document.fonts.ready.then(() => {
      requestAnimationFrame(() => {
        if (this._fitAddon) this._fitAddon.fit();
      });
    });

    // Drain data that arrived before init completed
    for (const chunk of this._pendingData) {
      term.write(chunk);
    }
    this._pendingData = [];
  }

  render() {
    return html`
      <div
        id="container"
        @mousedown=${() => {
          this._term?.focus();
          this.dispatchEvent(
            new CustomEvent('pane-focus', {
              bubbles: true,
              composed: true,
              detail: { paneId: this.paneId },
            }),
          );
        }}
      ></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-pane': MuxPane;
  }
}
