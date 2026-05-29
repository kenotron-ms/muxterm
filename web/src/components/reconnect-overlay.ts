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
  `;

  @property({ type: String })
  message = 'Reconnecting...';

  @property({ type: String })
  detail = '';

  render() {
    return html`
      <div class="overlay">
        <div class="container">
          <div class="spinner"></div>
          <div class="message">${this.message}</div>
          ${this.detail
            ? html`<div class="detail">${this.detail}</div>`
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