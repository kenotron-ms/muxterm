import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('mux-status-bar')
export class MuxStatusBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      justify-content: space-between;
      background: #16161e;
      border-top: 1px solid #292e42;
      height: 24px;
      padding: 0 12px;
      font-size: 12px;
      color: #565f89;
      flex-shrink: 0;
      user-select: none;
    }

    .left,
    .right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .session {
      color: #7aa2f7;
      font-weight: 600;
      cursor: pointer;
    }

    .separator {
      color: #292e42;
    }

    .connected {
      color: #9ece6a;
    }

    .disconnected {
      color: #f7768e;
    }

    .reconnecting {
      color: #e0af68;
    }

    .goal {
      color: #bb9af7;
      font-weight: 600;
    }
  `;

  @property({ type: String })
  sessionName = '';

  @property({ type: Number })
  windowCount = 0;

  @property({ type: Number })
  paneCount = 0;

  @property({ type: String })
  activeWindowName = '';

  @property({ type: String })
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

  @property({ type: Boolean })
  driverActive = false;

  private _onSessionClick = (): void => {
    this.dispatchEvent(
      new CustomEvent('open-session-picker', { bubbles: true, composed: true }),
    );
  };

  private _statusText(): string {
    switch (this.connectionStatus) {
      case 'connected':
        return 'connected';
      case 'disconnected':
        return 'disconnected';
      case 'reconnecting':
        return 'reconnecting';
    }
  }

  render() {
    const sessionDisplay = this.sessionName
      ? `[${this.sessionName}]`
      : 'no session';

    const windowLabel = this.windowCount === 1 ? 'window' : 'windows';
    const paneLabel = this.paneCount === 1 ? 'pane' : 'panes';

    return html`
      <div class="left">
        <span
            class="session"
            role="button"
            tabindex="0"
            title="Switch session"
            @click=${this._onSessionClick}
          >${sessionDisplay} ▾</span>
        <span class="separator">|</span>
        <span>${this.windowCount} ${windowLabel}</span>
        <span class="separator">|</span>
        <span>${this.activeWindowName} ${this.paneCount} ${paneLabel}</span>
      </div>
      <div class="right">
        ${this.driverActive ? html`<span class="goal">◉ goal</span>` : ''}
        <span class="${this.connectionStatus}">${this._statusText()}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-status-bar': MuxStatusBar;
  }
}