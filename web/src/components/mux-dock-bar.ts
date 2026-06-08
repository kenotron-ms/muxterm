import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { CHROME } from '../lib/theme.js';
import { workspaceLabel } from './workspace-picker.js';
import type { SessiondWorkspaceInfo } from '../types.js';

// ────────────────────────────────────────────────────────────────────────────
// MuxDockBar
//
// Replaces mux-status-bar. Renders workspace slots as flat touch-friendly
// buttons — no boxes, padding-only targets — with:
//   • Bold text for the active workspace
//   • ● prefix (amber) on non-active workspaces with an uncleared bell
//   • + button to create a new workspace (emits workspace-create)
//   • ● connection indicator at far right (ok/error color)
//
// Bell state is read directly from the store in render(). The component
// subscribes to store.subscribe() so bell changes trigger re-renders even
// when no external property changes.
// ────────────────────────────────────────────────────────────────────────────

@customElement('mux-dock-bar')
export class MuxDockBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: row;
      align-items: center;
      background: ${unsafeCSS(CHROME.bar)};
      border-top: 1px solid ${unsafeCSS(CHROME.border)};
      height: var(--mux-dock-height, 44px);
      /* On iOS with a home indicator, add safe-area inset. */
      padding-bottom: env(safe-area-inset-bottom, 0px);
      font-size: var(--mux-dock-font-size, 0.85rem);
      color: var(--mux-fg);
      flex-shrink: 0;
      user-select: none;
      overflow-x: auto;
    }

    /* ── Workspace slot buttons ─────────────────────────────────────────── */
    .ws-btn {
      display: inline-flex;
      align-items: center;
      padding: var(--mux-dock-item-padding, 0 16px);
      min-height: var(--mux-dock-height, 44px);
      border: none;
      background: transparent;
      color: var(--mux-fg);
      font: inherit;
      font-size: var(--mux-dock-font-size, 0.85rem);
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .ws-btn.active {
      font-weight: var(--mux-dock-active-weight, 600);
      color: var(--mux-accent, #7aa2f7);
    }

    .ws-btn:hover:not(.active) {
      color: var(--mux-fg);
      opacity: 0.85;
    }

    /* ── Bell dot inside workspace labels ─────────────────────────────────── */
    .bell-dot {
      color: var(--mux-bell, var(--mux-warn, #e0af68));
      margin-right: 4px;
      font-style: normal;
    }

    /* ── New workspace (+) button ─────────────────────────────────────────── */
    .new-ws-btn {
      display: inline-flex;
      align-items: center;
      padding: 0 12px;
      min-height: var(--mux-dock-height, 44px);
      border: none;
      background: transparent;
      color: var(--mux-fg);
      font: inherit;
      font-size: 1.1em;
      cursor: pointer;
      flex-shrink: 0;
    }

    .new-ws-btn:hover {
      color: var(--mux-accent, #7aa2f7);
    }

    /* ── Connection indicator (far right) ─────────────────────────────────── */
    .conn-dot {
      margin-left: auto;
      padding: 0 12px;
      min-height: var(--mux-dock-height, 44px);
      display: flex;
      align-items: center;
      flex-shrink: 0;
      font-size: 0.7em;
    }

    .conn-dot.connected    { color: var(--mux-ok,    #9ece6a); }
    .conn-dot.disconnected { color: var(--mux-error, #f7768e); }
    .conn-dot.reconnecting { color: var(--mux-error, #f7768e); }
  `;

  // ── Props from mux-app ──────────────────────────────────────────────────────
  @property({ attribute: false }) workspaces: SessiondWorkspaceInfo[] = [];
  @property({ attribute: false }) activeWorkspaceId = '';
  @property({ attribute: false }) connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

  // ── Internal store subscription ─────────────────────────────────────────────
  @state() private _version = 0;
  private _unsubscribe: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Subscribe to store so bell state changes trigger re-renders even when
    // no external property (workspaces, activeWorkspaceId) changes.
    this._unsubscribe = store.subscribe(() => {
      this._version++;
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  // ── Event handlers ──────────────────────────────────────────────────────────

  private _onWsClick(wsId: string): void {
    // Ack the workspace bell BEFORE emitting workspace-switch so the dock
    // dot clears atomically with the switch. mux-app.ts does NOT separately
    // call ackWorkspace — this is the single call site.
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

  // ── Render ──────────────────────────────────────────────────────────────────

  override render() {
    return html`
      ${this.workspaces.map((ws) => {
        const wsId = ws.workspaceId;
        const isActive = wsId === this.activeWorkspaceId;
        // Bell dot: only shown on NON-active workspaces with an uncleared bell.
        // Bells on the active workspace are acknowledged via pane tab dots above.
        const showBell = !isActive && store.workspaceBellActive(wsId);
        const label = workspaceLabel(ws);
        return html`
          <button
            class="ws-btn ${isActive ? 'active' : ''}"
            title="Switch to ${label}"
            @click=${() => this._onWsClick(wsId)}
          >
            ${showBell ? html`<span class="bell-dot">●</span>` : ''}${label}
          </button>
        `;
      })}
      <button class="new-ws-btn" title="New workspace" @click=${this._onNewWsClick}>+</button>
      <div class="conn-dot ${this.connectionStatus}">●</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-dock-bar': MuxDockBar;
  }
}
