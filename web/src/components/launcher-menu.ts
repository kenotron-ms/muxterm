import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { icon } from '../lib/icons.js';
import { Info, Keyboard, Plus, RefreshCw, Settings } from 'lucide';

export type LauncherAction =
  | 'settings'
  | 'shortcuts'
  | 'reconnect'
  | 'about'
  | 'new-workspace';

@customElement('mux-launcher-menu')
export class MuxLauncherMenu extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      padding: 4px;
      min-width: 180px;
    }

    .divider {
      height: 1px;
      background: var(--chrome-border);
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
      color: var(--chrome-text-bright);
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      box-sizing: border-box;
    }

    button:hover {
      background: var(--chrome-hover);
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

  /**
   * Gated by the caller: <mux-title-bar> (narrow mode) sets this to `true` so
   * mobile users have a reachable "New workspace" action. <mux-sidebar>
   * (wide mode) leaves it at the default `false` — it already has its own
   * always-visible "+ New workspace" button, so surfacing it here too would
   * be a duplicate leaking into desktop.
   */
  @property({ type: Boolean })
  showCreateWorkspace = false;

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
      ${this.showCreateWorkspace
        ? html`
            <button
              data-action="new-workspace"
              @click="${() => this._dispatch('new-workspace')}"
            >
              ${icon(Plus, { size: 14 })} New workspace
            </button>
            <div class="divider"></div>
          `
        : ''}
      <button data-action="settings" @click="${() => this._dispatch('settings')}">
        ${icon(Settings, { size: 14 })} Settings
      </button>
      <button data-action="shortcuts" @click="${() => this._dispatch('shortcuts')}">
        ${icon(Keyboard, { size: 14 })} Keyboard Shortcuts
      </button>
      <button data-action="reconnect" @click="${() => this._dispatch('reconnect')}">
        ${icon(RefreshCw, { size: 14 })} Reconnect
      </button>
      <div class="divider"></div>
      <button data-action="about" @click="${() => this._dispatch('about')}">
        ${icon(Info, { size: 14 })} About
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-launcher-menu': MuxLauncherMenu;
  }
}
