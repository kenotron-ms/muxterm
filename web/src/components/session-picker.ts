import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export interface SessionInfo {
  name: string;
  windows: number;
}

@customElement('mux-session-picker')
export class MuxSessionPicker extends LitElement {
  static styles = css`
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    }

    .picker {
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 8px;
      padding: 24px;
      min-width: 320px;
      max-width: 480px;
    }

    h2 {
      margin: 0 0 16px 0;
      color: #cdd6f4;
      font-size: 18px;
      font-weight: 600;
    }

    .session-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .session-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: #181825;
      border: 1px solid #45475a;
      border-radius: 6px;
      cursor: pointer;
      color: #cdd6f4;
      font-size: 14px;
      font-family: inherit;
      transition: border-color 0.15s;
    }

    .session-item:hover {
      border-color: #89b4fa;
    }

    .session-name {
      font-weight: 600;
    }

    .session-meta {
      color: #6c7086;
      font-size: 12px;
    }
  `;

  @property({ attribute: false })
  sessions: SessionInfo[] = [];

  private _onSessionClick(name: string): void {
    this.dispatchEvent(
      new CustomEvent('session-selected', {
        bubbles: true,
        composed: true,
        detail: { name },
      }),
    );
  }

  render() {
    return html`
      <div class="overlay">
        <div class="picker">
          <h2>Select a tmux session</h2>
          <div class="session-list">
            ${this.sessions.map(
              (s) => html`
                <button
                  class="session-item"
                  @click=${() => this._onSessionClick(s.name)}
                >
                  <span class="session-name">${s.name}</span>
                  <span class="session-meta"
                    >${s.windows} ${s.windows === 1 ? 'window' : 'windows'}</span
                  >
                </button>
              `,
            )}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-session-picker': MuxSessionPicker;
  }
}