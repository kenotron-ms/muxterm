import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { workspaceLabel } from './workspace-picker.js';

// TODO(deferred): mux-dock-bar is built and tested but not yet mounted in app.ts.
// Integration (replacing mux-status-bar) is deferred to a follow-up task.
// When ready, import MuxDockBar in app.ts and replace <mux-status-bar> with
// <mux-dock-bar> in the app render template.
@customElement('mux-dock-bar')
export class MuxDockBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: row;
      background: var(--chrome-bar);
      border-top: 1px solid var(--chrome-border);
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

    .action-btn {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.12s;
    }

    .action-btn:hover {
      background: color-mix(in srgb, currentColor 15%, transparent);
    }

    .action-btn.browser-live {
      color: var(--mux-ok, #9ece6a);
    }

    .action-btn svg {
      width: 16px;
      height: 16px;
      pointer-events: none;
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

  // TODO: wire connectionStatus from app WebSocket state when mux-dock-bar is mounted in app.ts
  @state() connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

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

  private _onGlobeClick(): void {
    const existing = store.panes.find((p) => p.surfaceKind === 'browser-cdp');
    if (existing) {
      window.dispatchEvent(
        new CustomEvent('browser-pane-focus', {
          detail: { paneId: existing.paneId },
        }),
      );
    } else {
      window.dispatchEvent(new CustomEvent('create-browser-pane'));
    }
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
    void this._version; // suppress unused-variable lint; triggers re-render on store change
    const activeWorkspaceId = store.attached ?? '';
    return html`
      ${store.workspaces.map((ws) => {
        const isActive = ws.workspaceId === activeWorkspaceId;
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
      <button
        class="action-btn ${store.panes.some((p) => p.surfaceKind === 'browser-cdp') ? 'browser-live' : ''}"
        title="Open browser"
        @click="${this._onGlobeClick}"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg">
          <circle cx="8" cy="8" r="6.5"/>
          <path d="M1.5 8h13"/>
          <path d="M8 1.5a9 9 0 0 1 2.5 6.5 9 9 0 0 1-2.5 6.5M8 1.5a9 9 0 0 0-2.5 6.5 9 9 0 0 0 2.5 6.5"/>
        </svg>
      </button>
      <div class="conn-dot ${this.connectionStatus}">●</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-dock-bar': MuxDockBar;
  }
}
