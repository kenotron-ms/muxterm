import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { Terminal, FitAddon, init } from 'ghostty-web';

// Module-level WASM init singleton
let ghosttyReady: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!ghosttyReady) {
    ghosttyReady = init();
  }
  return ghosttyReady;
}

@customElement('mux-pane')
export class MuxPane extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      position: relative;
      background: #1a1b26;
    }

    #container {
      width: 100%;
      height: 100%;
    }
  `;

  @property({ type: Number, attribute: 'pane-id' })
  paneId = 0;

  @property({ type: Boolean, reflect: true })
  active = false;

  private _term: Terminal | null = null;
  private _fitAddon: FitAddon | null = null;
  private _encoder = new TextEncoder();
  private _disposables: Array<{ dispose: () => void }> = [];

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    await this.updateComplete;
    await ensureInit();
    this._initTerminal();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];

    if (this._fitAddon) {
      this._fitAddon.dispose();
      this._fitAddon = null;
    }

    if (this._term) {
      this._term.dispose();
      this._term = null;
    }
  }

  writeData(data: Uint8Array | string): void {
    if (this._term) {
      this._term.write(data);
    }
  }

  focusTerminal(): void {
    if (this._term) {
      this._term.focus();
    }
  }

  private _initTerminal(): void {
    const container = this.shadowRoot?.querySelector<HTMLElement>('#container');
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: '#1a1b26',
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
      },
      scrollback: 0,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.observeResize();

    // Event wiring: onData → pane-input
    const dataDisposable = term.onData((data: string) => {
      this.dispatchEvent(
        new CustomEvent('pane-input', {
          bubbles: true,
          composed: true,
          detail: {
            paneId: this.paneId,
            data: this._encoder.encode(data),
          },
        }),
      );
    });
    if (dataDisposable) {
      this._disposables.push(dataDisposable);
    }

    // Event wiring: onResize → pane-resize
    const resizeDisposable = term.onResize((size: { cols: number; rows: number }) => {
      this.dispatchEvent(
        new CustomEvent('pane-resize', {
          bubbles: true,
          composed: true,
          detail: {
            paneId: this.paneId,
            cols: size.cols,
            rows: size.rows,
          },
        }),
      );
    });
    if (resizeDisposable) {
      this._disposables.push(resizeDisposable);
    }

    // Event wiring: container mousedown → pane-focus
    container.addEventListener('mousedown', () => {
      this.dispatchEvent(
        new CustomEvent('pane-focus', {
          bubbles: true,
          composed: true,
          detail: { paneId: this.paneId },
        }),
      );
    });

    this._term = term;
    this._fitAddon = fitAddon;
  }

  private _handleClick(): void {
    if (this._term) {
      this._term.focus();
    }
  }

  render() {
    return html`<div id="container" @click=${this._handleClick}></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-pane': MuxPane;
  }
}