import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('mux-reconnect-overlay')
export class MuxReconnectOverlay extends LitElement {
  static styles = css`
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.8);
      z-index: 2000;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 3px solid rgba(255, 255, 255, 0.2);
      border-top-color: #7aa2f7;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .message {
      font-size: 16px;
      color: #e0af68;
    }

    .detail {
      font-size: 13px;
      color: #565f89;
    }

    /*
     * The fatal variant replaces the spinner with a static mark and gives the
     * detail room to hold a multi-line diagnosis and a recovery command. A
     * spinning spinner is an animated claim that something is still being
     * attempted; when nothing is, showing one is simply untrue.
     */
    .mark {
      font-size: 28px;
      line-height: 1;
      color: #f7768e;
    }

    .message.fatal {
      color: #f7768e;
    }

    .detail.fatal {
      color: #a9b1d6;
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      text-align: left;
      max-width: min(78ch, 90vw);
      max-height: 60vh;
      overflow: auto;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid #414868;
      border-radius: 6px;
      padding: 12px 14px;
      user-select: text;
    }
  `;

  @property({ type: String })
  message = 'Reconnecting...';

  @property({ type: String })
  detail = '';

  /**
   * Fatal means "no retry is in progress and none will help". It swaps the
   * spinner for a static error mark, which is the difference between the
   * overlay reporting a state and the overlay performing one.
   */
  @property({ type: Boolean })
  fatal = false;

  render() {
    return html`
      <div class="overlay">
        <div class="container">
          ${this.fatal
            ? html`<div class="mark">⚠</div>`
            : html`<div class="spinner"></div>`}
          <div class="message ${this.fatal ? 'fatal' : ''}">${this.message}</div>
          ${this.detail
            ? html`<div class="detail ${this.fatal ? 'fatal' : ''}">${this.detail}</div>`
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-reconnect-overlay': MuxReconnectOverlay;
  }
}