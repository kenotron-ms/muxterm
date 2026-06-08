import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { CHROME } from '../lib/theme.js';
import { workspaceLabel } from './workspace-picker.js';
import type { SessiondWorkspaceInfo } from '../types.js';

@customElement('mux-dock-bar')
export class MuxDockBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: row;
      background: ${unsafeCSS(CHROME.bar)};
      border-top: 1px solid ${unsafeCSS(CHROME.border)};
      height: var(--mux-dock-height, 44px);
      padding-bottom: env(safe-area-inset-bottom, 0px);
      font-size: var(--mux-dock-font-size, 0.85rem);
      overflow-x: auto;
    }

    .ws-btn {
      display: inline-flex;
      align-items: center;
      padding: var(--mux-dock-item-padding, 0 16px);
      min-height: var(--mux-dock-height, 44px);
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    .ws-btn.active {
      font-weight: var(--mux-dock-active-weight, 600);
      color: var(--mux-accent, #7aa2f7);
    }

    .ws-btn:hover:not(.active) {
      opacity: 0.85;
    }

    .bell-dot {
      color: var(--mux-bell, var(--mux-warn, #e0af68));
      margin-right: 4px;
    }

    .new-ws-btn {
      display: inline-flex;
      align-items: center;
      padding: 0 12px;
      font-size: 1.1em;
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
    }

    .conn-dot {
      margin-left: auto;
      padding: 0 12px;
      font-size: 0.7em;
      display: flex;
      align-items: center;
    }

    .conn-dot.connected { color: var(--mux-ok, #9ece6a); }
    .conn-dot.disconnected { color: var(--mux-error, #f7768e); }
    .conn-dot.reconnecting { color: var(--mux-error, #f7768e); }
  `;

  @property({ attribute: false }) workspaces: SessiondWorkspaceInfo[] = [];
  @property({ attribute: false }) activeWorkspaceId = '';
  @property({ attribute: false }) connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

  @state() private _version = 0;
  private _unsubscribe: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._unsubscribe = store.subscribe(() => {
      this._version++;
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  private _onWsClick(wsId: string): void {
    store.ackWorkspace(wsId);
    this.dispatchEvent(
      new CustomEvent('workspace-switch', {
        detail: { workspaceId: wsId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onNewWsClick(): void {
    this.dispatchEvent(
      new CustomEvent('workspace-create', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    return html`
      ${this.workspaces.map((ws) => {
        const isActive = ws.workspaceId === this.activeWorkspaceId;
        const showBell = !isActive && store.workspaceBellActive(ws.workspaceId);
        return html`
          <button
            class="ws-btn ${isActive ? 'active' : ''}"
            @click="${() => this._onWsClick(ws.workspaceId)}"
          >
            ${showBell ? html`<span class="bell-dot">●</span>` : ''}
            ${workspaceLabel(ws)}
          </button>
        `;
      })}
      <button class="new-ws-btn" @click="${this._onNewWsClick}">+</button>
      <div class="conn-dot ${this.connectionStatus}">●</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-dock-bar': MuxDockBar;
  }
}
