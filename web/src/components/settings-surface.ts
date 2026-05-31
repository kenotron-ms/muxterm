import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';

/**
 * mux-settings-surface — NON-terminal settings panel.
 *
 * Displays read-only configuration information for muxterm v1.
 * Static/read-only for v1 — config editing is Phase 5.
 *
 * This surface uses normal responsive DOM — no xterm.js, no tmux cols×rows grid.
 */
@customElement('mux-settings-surface')
export class MuxSettingsSurface extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
      height: 100%;
      overflow-y: auto;
      background: ${unsafeCSS(CHROME.body)};
      color: ${unsafeCSS(CHROME.textBright)};
      font-family: inherit;
    }

    .panel {
      max-width: 560px;
      width: 100%;
      margin: 0 auto;
      padding: 24px 16px;
      box-sizing: border-box;
    }

    h2 {
      margin: 0 0 24px 0;
      font-size: 18px;
      font-weight: 600;
      color: ${unsafeCSS(CHROME.textBright)};
    }

    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid ${unsafeCSS(CHROME.border)};
      font-size: 14px;
    }

    .row .label {
      color: ${unsafeCSS(CHROME.textDim)};
    }

    .row .value {
      color: ${unsafeCSS(CHROME.textBright)};
    }

    .about {
      margin-top: 32px;
      font-size: 13px;
      color: ${unsafeCSS(CHROME.textDim)};
      line-height: 1.6;
    }
  `;

  @property({ type: String })
  serverAddr = '';

  render() {
    return html`
      <div class="panel">
        <h2>Settings</h2>
        <div class="row">
          <span class="label">Theme</span>
          <span class="value">Tokyo Night</span>
        </div>
        <div class="row">
          <span class="label">Server</span>
          <span class="value">${this.serverAddr}</span>
        </div>
        <div class="row">
          <span class="label">Accent</span>
          <span class="value">#7aa2f7</span>
        </div>
        <p class="about">
          muxterm is a browser-based terminal multiplexer frontend. It connects
          to a tmux session over WebSocket and renders panes using xterm.js.
        </p>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-settings-surface': MuxSettingsSurface;
  }
}
