import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store, MuxStore } from './state.js';
import { MuxSocket, buildWsUrl } from './ws.js';
import type { TmuxState, Window } from './types.js';
import type { MuxLayout } from './components/layout.js';
import type { SessionInfo } from './components/session-picker.js';

// Side-effect imports — register child custom elements
import './components/tab-bar.js';
import './components/layout.js';
import './components/status-bar.js';
import './components/pane.js';
import './components/resize-handle.js';
import './components/session-picker.js';
import './components/reconnect-overlay.js';

@customElement('mux-app')
export class MuxApp extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100vw;
      height: 100vh;
      background: #1a1b26;
      color: #a9b1d6;
    }

    .overlay {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      background: rgba(26, 27, 38, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      color: #e0af68;
      font-size: 16px;
    }

    .overlay.hidden {
      display: none;
    }
  `;

  @state()
  _tmuxState: TmuxState = store.state;

  @state()
  _connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

  @state()
  _showSessionPicker = false;

  @state()
  _sessions: SessionInfo[] = [];

  @state()
  _showReconnectOverlay = false;

  @state()
  _reconnectMessage = 'Reconnecting...';

  private _socket: MuxSocket | null = null;
  private _unsubscribe: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();

    // Subscribe to store changes
    this._unsubscribe = store.subscribe(() => {
      this._tmuxState = { ...store.state };
    });

    // Create WebSocket connection
    this._socket = new MuxSocket(store, buildWsUrl('/ws'));
    this._socket.onPaneOutput((paneId: number, data: Uint8Array) => {
      this._routePaneOutput(paneId, data);
    });
    this._socket.onControlMessage((msg: Record<string, unknown>) => {
      this._handleControlMessage(msg);
    });
    this._socket.onDisconnect = () => {
      this._showReconnectOverlay = true;
      this._reconnectMessage = 'Connection lost. Reconnecting...';
    };
    this._socket.onReconnect = () => {
      this._showReconnectOverlay = false;
    };
    this._socket.connect();
    this._connectionStatus = 'reconnecting';
    this._pollConnectionStatus();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._socket) {
      this._socket.disconnect();
      this._socket = null;
    }
  }

  render() {
    const activeSession = this._tmuxState.sessions.find(
      (s) => s.name === this._tmuxState.activeSession,
    );
    const windows: Window[] = activeSession?.windows ?? [];
    const activeWindow = windows.find((w) => w.id === this._tmuxState.activeWindow);
    const activePaneId = this._tmuxState.activePane;

    return html`
      <mux-tab-bar
        .windows=${windows}
        active-window-id=${this._tmuxState.activeWindow}
        @tab-select=${this._onTabSelect}
        @tab-new=${this._onTabNew}
        @tab-close=${this._onTabClose}
      ></mux-tab-bar>
      <mux-layout
        layout-string=${activeWindow?.layout ?? ''}
        active-pane-id=${activePaneId}
        @pane-input=${this._onPaneInput}
        @pane-resize=${this._onPaneResize}
        @pane-focus=${this._onPaneSelect}
      ></mux-layout>
      <mux-status-bar
        sessionName=${this._tmuxState.activeSession}
        .windowCount=${windows.length}
        .paneCount=${activeWindow?.panes.length ?? 0}
        activeWindowName=${activeWindow?.name ?? ''}
        connectionStatus=${this._connectionStatus}
      ></mux-status-bar>
      <div class="overlay ${this._connectionStatus === 'connected' ? 'hidden' : ''}">
        Connecting to muxterm...
      </div>
      ${this._showReconnectOverlay
        ? html`<mux-reconnect-overlay
            message=${this._reconnectMessage}
          ></mux-reconnect-overlay>`
        : ''}
      ${this._showSessionPicker
        ? html`<mux-session-picker
            .sessions=${this._sessions}
            @session-selected=${this._onSessionSelected}
          ></mux-session-picker>`
        : ''}
    `;
  }

  private _onTabSelect = (e: CustomEvent<{ windowId: number }>): void => {
    this._socket?.sendControl({
      type: 'select-window',
      windowId: e.detail.windowId,
    });
  };

  private _onTabNew = (): void => {
    this._socket?.sendControl({ type: 'new-window' });
  };

  private _onTabClose = (e: CustomEvent<{ windowId: number }>): void => {
    this._socket?.sendControl({
      type: 'close-pane',
      paneId: e.detail.windowId,
    });
  };

  private _onPaneInput = (e: CustomEvent<{ paneId: number; data: Uint8Array }>): void => {
    this._socket?.sendPaneInput(e.detail.paneId, e.detail.data);
  };

  private _onPaneResize = (
    e: CustomEvent<{ paneId: number; cols: number; rows: number }>,
  ): void => {
    this._socket?.sendControl({
      type: 'resize-pane',
      paneId: e.detail.paneId,
      cols: e.detail.cols,
      rows: e.detail.rows,
    });
  };

  private _onPaneSelect = (e: CustomEvent<{ paneId: number }>): void => {
    this._socket?.sendControl({
      type: 'select-pane',
      paneId: e.detail.paneId,
    });
  };

  private _handleControlMessage = (msg: Record<string, unknown>): void => {
    if ('sessions' in msg && Array.isArray(msg.sessions)) {
      this._sessions = msg.sessions as SessionInfo[];
      this._showSessionPicker = true;
    }
    if ('detached' in msg && msg.detached && typeof msg.detached === 'object') {
      const detached = msg.detached as { reason?: string };
      this._showReconnectOverlay = true;
      this._reconnectMessage = detached.reason ?? 'Disconnected';
    }
  };

  private _onSessionSelected = (e: CustomEvent<{ name: string }>): void => {
    this._showSessionPicker = false;
    this._socket?.sendRaw(JSON.stringify({ 'attach-session': e.detail.name }));
  };

  private _routePaneOutput(paneId: number, data: Uint8Array): void {
    const layout = this.shadowRoot?.querySelector('mux-layout') as MuxLayout | null;
    if (layout) {
      const paneEl = layout.getPaneElement(paneId);
      if (paneEl) {
        (paneEl as any).writeData(data);
      }
    }
  }

  private _pollConnectionStatus(): void {
    const poll = (): void => {
      if (!this._socket) return;
      const newStatus = this._socket.connected ? 'connected' : this._connectionStatus === 'connected' ? 'disconnected' : this._connectionStatus;
      if (newStatus !== this._connectionStatus) {
        this._connectionStatus = this._socket.connected ? 'connected' : 'disconnected';
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-app': MuxApp;
  }
}