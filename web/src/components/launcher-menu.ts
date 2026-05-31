import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';
import { icon } from '../lib/icons.js';
import { Plus, RefreshCw, Settings } from 'lucide';

export type LauncherAction =
  | 'new-session'
  | 'settings'
  | 'reconnect';

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

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }

    button .lucide-icon {
      pointer-events: none;
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
      <button data-action="new-session" @click="${() => this._dispatch('new-session')}">
        ${icon(Plus, { size: 14 })} New session
      </button>
      <div class="divider"></div>
      <button data-action="settings" @click="${() => this._dispatch('settings')}">
        ${icon(Settings, { size: 14 })} Settings
      </button>
      <button data-action="reconnect" @click="${() => this._dispatch('reconnect')}">
        ${icon(RefreshCw, { size: 14 })} Reconnect
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-launcher-menu': MuxLauncherMenu;
  }
}
