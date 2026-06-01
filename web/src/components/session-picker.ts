import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { Check, Plus } from 'lucide';
import { icon } from '../lib/icons.js';
import type { SessionInfo } from '../types.js';

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

    .dropdown {
      min-width: 208px;
      background: #16161e;
      border: 1px solid #2a2e3f;
      border-radius: 9px;
      padding: 5px;
      box-shadow: 0 18px 46px rgba(0, 0, 0, 0.6);
      font-size: 13px;
    }

    .mi {
      display: flex;
      align-items: center;
      gap: 9px;
      width: 100%;
      padding: 8px 10px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #c0caf5;
      cursor: pointer;
      text-align: left;
      font-size: 13px;
    }

    .mi:hover {
      background: #1f2335;
    }

    .mi.sel {
      background: #283457;
    }

    .mi.dim {
      color: #565f89;
    }

    .mi.dim:hover {
      background: #1f2335;
      color: #c0caf5;
    }

    .ck {
      width: 14px;
      flex-shrink: 0;
      color: #9ece6a;
      display: flex;
      align-items: center;
    }

    .sname {
      flex: 1;
    }

    .kbd {
      margin-left: auto;
      color: #565f89;
      font-size: 11px;
      flex-shrink: 0;
    }

    .sep {
      height: 1px;
      background: #2a2e3f;
      margin: 5px 6px;
    }
  `;

  @property({ attribute: false })
  sessions: SessionInfo[] = [];

  @property({ type: Boolean })
  inline = false;

  @property({ type: String })
  currentSession = '';

  private _onSessionClick(name: string): void {
    this.dispatchEvent(
      new CustomEvent('session-selected', {
        bubbles: true,
        composed: true,
        detail: { name },
      }),
    );
  }

  private _onNewSession(): void {
    this.dispatchEvent(
      new CustomEvent('new-session', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Fix 5: clicking the dim overlay (outside the picker card) closes the picker. */
  private _onOverlayClick(): void {
    this.dispatchEvent(new CustomEvent('close-picker', { bubbles: true, composed: true }));
  }

  render() {
    if (this.inline) {
      return html`
        <div class="dropdown">
          ${this.sessions.map(
            (s, i) => html`
              <button
                class="mi ${s.name === this.currentSession ? 'sel' : ''}"
                @click="${() => this._onSessionClick(s.name)}"
              >
                <span class="ck">
                  ${s.name === this.currentSession ? icon(Check, { size: 12 }) : ''}
                </span>
                <span class="sname">${s.name}</span>
                ${i < 2 ? html`<span class="kbd">⌃⇧${i + 1}</span>` : ''}
              </button>
            `,
          )}
          <div class="sep"></div>
          <button class="mi dim" @click="${this._onNewSession}">
            <span class="ck"></span>
            ${icon(Plus, { size: 12 })}
            <span>New session…</span>
          </button>
        </div>
      `;
    }

    return html`
      <div class="overlay" @click="${this._onOverlayClick}">
        <div class="picker" @click="${(e: Event) => e.stopPropagation()}">
          <h2>Select a tmux session</h2>
          <div class="session-list">
            ${this.sessions.map(
              (s) => html`
                <button
                  class="session-item"
                  @click="${() => this._onSessionClick(s.name)}"
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
