import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';

export type LauncherAction =
  | 'new-session'
  | 'new-browser'
  | 'open-driver'
  | 'settings'
  | 'shortcuts'
  | 'reconnect'
  | 'about';

@customElement('mux-launcher-menu')
export class MuxLauncherMenu extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: ${unsafeCSS(CHROME.bar)};
      border: 1px solid ${unsafeCSS(CHROME.border)};
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      padding: 4px;
      min-width: 180px;
    }

    .divider {
      height: 1px;
      background: ${unsafeCSS(CHROME.border)};
      margin: 4px 0;
    }

    button {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 10px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: ${unsafeCSS(CHROME.textBright)};
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      box-sizing: border-box;
    }

    button:hover {
      background: ${unsafeCSS(CHROME.hover)};
    }

    button.driver {
      color: ${unsafeCSS(CHROME.driverAccent)};
    }

    .close-region:hover {
      color: ${unsafeCSS(CHROME.danger)};
    }
  `;

  private _dispatch(action: LauncherAction): void {
    this.dispatchEvent(
      new CustomEvent('launcher-action', {
        bubbles: true,
        composed: true,
        detail: { action },
      }),
    );
  }

  render() {
    return html`
      <button data-action="new-session" @click=${() => this._dispatch('new-session')}>
        ➕ New session
      </button>
      <button data-action="new-browser" @click=${() => this._dispatch('new-browser')}>
        🌐 New browser
      </button>
      <button data-action="open-driver" class="driver" @click=${() => this._dispatch('open-driver')}>
        ◉ Open driver
      </button>
      <div class="divider"></div>
      <button data-action="settings" @click=${() => this._dispatch('settings')}>
        ⚙ Settings
      </button>
      <button data-action="shortcuts" @click=${() => this._dispatch('shortcuts')}>
        ⌨ Keyboard Shortcuts
      </button>
      <button data-action="reconnect" @click=${() => this._dispatch('reconnect')}>
        ⟳ Reconnect
      </button>
      <div class="divider"></div>
      <button data-action="about" @click=${() => this._dispatch('about')}>
        ℹ About
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-launcher-menu': MuxLauncherMenu;
  }
}
