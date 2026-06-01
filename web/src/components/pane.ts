import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import xtermCss from '@xterm/xterm/css/xterm.css?raw';
import { terminalRegistry } from '../lib/terminal-registry.js';
import { THEME } from '../lib/theme.js';

/**
 * mux-pane — thin attachment shell.
 *
 * This component no longer owns a Terminal instance. It is a lightweight
 * shell that attaches the persistent terminal (held in terminalRegistry) into
 * its #container on connect, and detaches (WITHOUT disposing) on disconnect.
 *
 * Lifecycle:
 *   connectedCallback  → terminalRegistry.attach(paneId, #container)
 *   disconnectedCallback → terminalRegistry.detach(paneId)   // NOT dispose
 *   updated (active→true) → terminalRegistry.focus(paneId)
 *
 * The terminal must be ensure()'d in the registry before this element
 * connects — app.ts does this in willUpdate() via _syncTerminals().
 */

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
      #container .xterm-viewport::-webkit-scrollbar {
        width: 8px;
      }
      #container .xterm-viewport::-webkit-scrollbar-track {
        background: ${unsafeCSS(THEME.background)};
      }
      #container .xterm-viewport::-webkit-scrollbar-thumb {
        background: #414868;
        border-radius: 4px;
      }
      #container .xterm-viewport::-webkit-scrollbar-thumb:hover {
        background: #565f89;
      }
    `,
  ];

  @property({ type: Number, attribute: 'pane-id' })
  paneId = 0;

  @property({ type: Boolean, reflect: true })
  active = false;

  connectedCallback(): void {
    super.connectedCallback();
    // updateComplete resolves after the first render, so #container exists.
    this.updateComplete.then(() => {
      const container = this.shadowRoot?.querySelector<HTMLElement>('#container');
      if (container) terminalRegistry.attach(this.paneId, container);
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    // Detach the host element from DOM — does NOT dispose the terminal.
    // The registry continues to own it and feed it while the tab is hidden.
    terminalRegistry.detach(this.paneId);
  }

  protected override updated(changedProperties: Map<PropertyKey, unknown>): void {
    // When this pane becomes the active pane, focus the terminal.
    if (changedProperties.has('active') && this.active) {
      terminalRegistry.focus(this.paneId);
    }
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
    const term = terminalRegistry.getTerminal(this.paneId);
    if (!term) return '';
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
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
    const term = terminalRegistry.getTerminal(this.paneId);
    if (!term) return [];
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  render() {
    return html`
      <div
        id="container"
        @mousedown="${() => {
          terminalRegistry.focus(this.paneId);
          this.dispatchEvent(
            new CustomEvent('pane-focus', {
              bubbles: true,
              composed: true,
              detail: { paneId: this.paneId },
            }),
          );
        }}"
      ></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-pane': MuxPane;
  }
}
