import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store, MuxStore } from './state.js';
import { icon } from './lib/icons.js';
import { MonitorX } from 'lucide';
import { MuxSocket, buildWsUrl } from './ws.js';
import type { TmuxState, Window, SessionInfo, SplitDirection } from './types.js';
import type { MuxLayout } from './components/layout.js';
import { terminalRegistry, configureTerminals } from './lib/terminal-registry.js';
import { parseResolvedConfig } from './lib/config.js';
import { makeKeyHandler, type UIActions } from './lib/keybindings.js';
import { applyThemeTokens, resolvePalette } from './lib/theme.js';

// Side-effect imports — register child custom elements
import './components/title-bar.js';
import './components/layout.js';
import './components/status-bar.js';
import './components/pane.js';
import './components/resize-handle.js';
import './components/session-picker.js';
import './components/reconnect-overlay.js';
import './components/workspace.js';
import type { LauncherAction } from './components/launcher-menu.js';
import { Workspace } from './lib/workspace.js';

// ---------------------------------------------------------------------------
// Module-level keybinding wiring
// ---------------------------------------------------------------------------

/** Actions map passed to installKeybindings — populated with real handlers as
 *  each phase lands. Stubs use () => {} to keep wiring unconditional. */
const uiActions: UIActions = {
  openLauncher: () => window.dispatchEvent(new CustomEvent('open-launcher')),
  split: () => {}, // TODO(phaseX): wire when available
  maximizeRegion: () => {}, // TODO(phaseX): wire when available
  popOut: () => {}, // TODO(phaseX): wire when available
  nextSession: () => {}, // TODO(phaseX): wire when available
  focusDriver: () => {}, // TODO(phaseX): wire when available
};

/** Disposer for the currently-installed keydown handler. Re-set after each
 *  config frame so new key bindings take effect immediately. */
let disposeKeys: (() => void) | undefined;

/**
 * Installs a global keydown handler wired to the given UIActions.
 * Returns a cleanup function that removes the handler.
 */
export function installKeybindings(actions: UIActions): () => void {
  const handler = makeKeyHandler(store.config.keys, actions);
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}

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

    /* Empty session state — shown when the active session has no windows.
       Fills the space the terminal layout would occupy. */
    .empty-session {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      background: #1a1b26;
      color: #565f89;
      user-select: none;
    }

    .empty-session .glyph {
      line-height: 1;
      opacity: 0.5;
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }

    .empty-session .headline {
      font-size: 16px;
      color: #a9b1d6;
      font-weight: 600;
    }

    .empty-session .subtext {
      font-size: 13px;
      color: #565f89;
    }

    .empty-session button {
      margin-top: 8px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 18px;
      font-size: 13px;
      color: #c0caf5;
      background: #24283b;
      border: 1px solid #414868;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
    }

    .empty-session button:hover {
      background: #2f344d;
      border-color: #7aa2f7;
    }

    .empty-session kbd {
      font-family: inherit;
      font-size: 12px;
      padding: 1px 6px;
      border-radius: 4px;
      background: #1f2335;
      border: 1px solid #414868;
      color: #a9b1d6;
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
  private _workspace = new Workspace();

  /** Close the session picker on Escape. */
  private _onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this._showSessionPicker) {
      this._showSessionPicker = false;
    }
  };

  /** Bound handler: sets data-launcher-open on the host (light DOM) so E2E
   *  selectors like document.querySelector('[data-launcher-open]') work. */
  private _onOpenLauncherAttr = (): void => {
    this.setAttribute('data-launcher-open', '');
  };

  connectedCallback(): void {
    super.connectedCallback();

    // Track launcher-open state on the host element for E2E assertions.
    window.addEventListener('open-launcher', this._onOpenLauncherAttr);
    // Escape closes the session picker.
    document.addEventListener('keydown', this._onDocKeyDown);

    // Apply default theme tokens immediately so --mux-* vars exist before any frame.
    applyThemeTokens(resolvePalette(store.config.theme.palette));
    // Install keybindings with defaults immediately — mirrors applyThemeTokens.
    // Without this, shortcuts are dead until the first config frame arrives.
    disposeKeys = installKeybindings(uiActions);

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
    window.removeEventListener('open-launcher', this._onOpenLauncherAttr);
    document.removeEventListener('keydown', this._onDocKeyDown);
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._socket) {
      this._socket.disconnect();
      this._socket = null;
    }
  }

  /**
   * Before each render, synchronise the terminal registry with the current
   * tmux state. This ensure()s a persistent Terminal for EVERY pane across
   * ALL windows in ALL sessions (not just the active window), so background
   * windows stay fed and their scrollback is preserved on tab switch.
   * Panes that no longer exist in tmux are prune()'d (disposed).
   */
  override willUpdate(_changedProperties: Map<PropertyKey, unknown>): void {
    super.willUpdate(_changedProperties);
    this._syncTerminals();
    this._ensureActiveRegion();
  }

  private _ensureActiveRegion(): void {
    const session = this._tmuxState.activeSession;
    const windowId = this._tmuxState.activeWindow;
    if (!session || windowId === null || windowId === undefined) return;

    const alreadyMounted = this._workspace.regions.some(
      (r) => r.surface.sessionName === session && r.surface.windowId === windowId,
    );

    if (
      this._workspace.regions.length === 0 &&
      this._workspace.detachedRegionIds.size === 0 &&
      !alreadyMounted
    ) {
      this._workspace.openRegion({ sessionName: session, windowId });
    }
  }

  private _syncTerminals(): void {
    const liveIds = new Set<number>();
    for (const session of this._tmuxState.sessions) {
      for (const window of session.windows) {
        for (const pane of window.panes) {
          const paneId = pane.id;
          terminalRegistry.ensure(paneId, {
            onInput: (data) => this._socket?.sendPaneInput(paneId, data),
            onResize: (cols, rows) =>
              this._socket?.sendControl({
                type: 'resize-pane',
                paneId,
                cols,
                rows,
              }),
          });
          liveIds.add(paneId);
        }
      }
    }
    terminalRegistry.prune(liveIds);
  }

  render() {
    const activeSession = this._tmuxState.sessions.find(
      (s) => s.name === this._tmuxState.activeSession,
    );
    const windows: Window[] = activeSession?.windows ?? [];
    const activeWindow = windows.find((w) => w.id === this._tmuxState.activeWindow);
    const activePaneId = this._tmuxState.activePane;

    return html`
      <mux-title-bar @launcher-action="${this._onLauncherAction}"></mux-title-bar>
      ${this._tmuxState.sessions.length === 0
        ? html`
            <div class="empty-session">
              <div class="glyph">${icon(MonitorX, { size: 48 })}</div>
              <div class="headline">No active session</div>
              <div class="subtext">
                The tmux session ended. muxterm is still running — create a new
                session to pick up where you left off.
              </div>
              <button @click="${this._onCreateSession}">
                <span>+</span> New session
              </button>
            </div>
          `
        : windows.length === 0
        ? html`
            <div class="empty-session">
              <div class="glyph">${icon(MonitorX, { size: 48 })}</div>
              <div class="headline">No open windows</div>
              <div class="subtext">
                This session has nothing running. Create a window to get started.
              </div>
              <button @click="${this._onTabNew}">
                <span>+</span> New window
              </button>
            </div>
          `
        : html`
            <mux-workspace
              .workspace="${this._workspace}"
              .tmuxState="${this._tmuxState}"
              @pane-focus="${this._onPaneSelect}"
              @resize-surface="${this._onSurfaceResize}"
              @open-session-picker="${this._onOpenSessionPicker}"
              @tab-select="${this._onTabSelect}"
              @tab-new="${this._onTabNew}"
              @tab-close="${this._onTabClose}"
              @session-selected="${this._onSessionSelected}"
              @new-session="${this._onNewSessionCreate}"
              @split-pane="${this._onSplitPane}"
              @rename-window="${this._onRenameWindow}"
            ></mux-workspace>
          `}
      <mux-status-bar
        sessionName="${this._tmuxState.activeSession}"
        .windowCount="${windows.length}"
        .paneCount="${activeWindow?.panes.length ?? 0}"
        activeWindowName="${activeWindow?.name ?? ''}"
        connectionStatus="${this._connectionStatus}"
        @open-session-picker="${this._onOpenSessionPicker}"
      ></mux-status-bar>
      <div class="overlay ${this._connectionStatus === 'connected' ? 'hidden' : ''}">
        Connecting to muxterm...
      </div>
      ${this._showReconnectOverlay
        ? html`<mux-reconnect-overlay
            message="${this._reconnectMessage}"
          ></mux-reconnect-overlay>`
        : ''}
      ${this._showSessionPicker
        ? html`<mux-session-picker
            .sessions="${this._sessions}"
            @session-selected="${this._onSessionSelected}"
            @close-picker="${() => { this._showSessionPicker = false; }}"
          ></mux-session-picker>`
        : ''}
    `;
  }

  private _onSplitPane = (e: CustomEvent<{ direction: string; paneId: number }>): void => {
    this._socket?.sendControl({
      type: 'split',
      direction: e.detail.direction as SplitDirection,
      paneId: e.detail.paneId,
    });
  };

  private _onRenameWindow = (e: CustomEvent<{ windowId: number; name: string }>): void => {
    this._socket?.sendControl({
      type: 'rename-window',
      windowId: e.detail.windowId,
      name: e.detail.name,
    });
  };

  private _onSurfaceResize = (e: CustomEvent<{ surfaceId: string; cols: number; rows: number }>): void => {
    // Async fire-and-forget (seam S5) — never a synchronous handshake.
    this._socket?.sendControl({ type: 'resize-surface', surfaceId: e.detail.surfaceId, cols: e.detail.cols, rows: e.detail.rows });
  };

  private _onTabSelect = (e: CustomEvent<{ windowId: number }>): void => {
    this._socket?.sendControl({
      type: 'select-window',
      windowId: e.detail.windowId,
    });
  };

  private _onTabNew = (): void => {
    this._socket?.sendControl({ type: 'new-window' });
  };

  // Shown on the "no active session" page. Asks the server to (re)attach a tmux
  // session. The server's supervisor creates one and pushes fresh state.
  private _onCreateSession = (): void => {
    this._socket?.sendControl({ type: 'create-session', name: '' });
  };

  private _onTabClose = (e: CustomEvent<{ windowId: number }>): void => {
    // Close the whole window (kill-window), not a single pane. A window may
    // hold several panes; kill-pane on a window id would close only one.
    // The authoritative state push that follows removes the tab — but if this
    // was the LAST window, tmux kills the session and we'll get a detach.
    this._socket?.sendControl({
      type: 'close-window',
      windowId: e.detail.windowId,
    });
  };

  private _onPaneSelect = (e: CustomEvent<{ paneId: number }>): void => {
    this._socket?.sendControl({
      type: 'select-pane',
      paneId: e.detail.paneId,
    });
  };

  private _handleControlMessage = (msg: Record<string, unknown>): void => {
    // full-sync arrives on connect/reconnect just before binary pane-content frames.
    // Reset all existing terminals NOW so the incoming capture-pane replay writes
    // to a clean screen rather than stacking on top of stale content.
    if ('full-sync' in msg) {
      this._resetAllPaneTerminals();
    }
    if ('session-list' in msg) {
      this._sessions = store.sessionList;
    }
    if ('detached' in msg && msg.detached && typeof msg.detached === 'object') {
      const detached = msg.detached as { reason?: string };
      this._showReconnectOverlay = true;
      this._reconnectMessage = detached.reason ?? 'Disconnected';
    }
    if ('config' in msg) {
      const cfg = parseResolvedConfig(msg['config']);
      store.setConfig(cfg);
      applyThemeTokens(resolvePalette(cfg.theme.palette));
      configureTerminals(cfg); // future Terminals pick up font/cursor/scrollback/palette
      disposeKeys?.();
      disposeKeys = installKeybindings(uiActions);
    }
  };

  private _resetAllPaneTerminals(): void {
    terminalRegistry.resetAll();
  }

  private _onOpenSessionPicker = (): void => {
    this._sessions = store.sessionList;
    this._showSessionPicker = true;
  };

  private _onSessionSelected = (e: CustomEvent<{ name: string }>): void => {
    this._showSessionPicker = false;
    this._socket?.sendControl({ type: 'attach-session', name: e.detail.name });
  };

  /** Create a brand-new tmux session from the inline dropdown "New session" button. */
  private _onNewSessionCreate = (): void => {
    const name = window.prompt('Session name:')?.trim();
    if (!name) return;
    this._socket?.sendControl({ type: 'create-session', name });
    this._socket?.sendControl({ type: 'attach-session', name });
  };

  private _onLauncherAction = (e: CustomEvent<{ action: LauncherAction }>): void => {
    const { action } = e.detail;
    switch (action) {
      case 'new-session':
        this._sessions = store.sessionList;
        this._showSessionPicker = true;
        break;
      case 'settings':
        // Ask the backend to open the config file in an editor ($EDITOR / vim / nano)
        // in a new tmux window named "settings".
        this._socket?.sendControl({ type: 'open-settings' });
        break;
      case 'reconnect':
        this._socket?.sendControl({ type: 'request-sync' });
        break;
    }
  };

  private _routePaneOutput(paneId: number, data: Uint8Array): void {
    // Write directly to the registry — works for ALL panes (including
    // background windows whose mux-pane element is not in the DOM).
    terminalRegistry.write(paneId, data);
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

  /** @internal test hook — seed a region without a live socket. */
  seedWorkspaceForTest(sessionName: string, windowId: number): void {
    this._workspace = new Workspace();
    this._workspace.openRegion({ sessionName, windowId });
  }

  /** @internal test hook — inject tmux state without a live socket. */
  injectStateForTest(state: TmuxState): void {
    this._tmuxState = state;
    this.requestUpdate();
  }

  /** Open the active window of another session as a second region (dock). */
  openRegionForTest(sessionName: string, windowId: number): void {
    this._workspace.openRegion({ sessionName, windowId });
    this.requestUpdate();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-app': MuxApp;
  }
}

// ---------------------------------------------------------------------------
// Dev window accessors — exposed for E2E testing (Phase 5 config assertions)
// Guarded behind import.meta.env.DEV: never leaks store state in production.
// ---------------------------------------------------------------------------
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>)['__muxStore'] = store;

  (window as unknown as Record<string, unknown>)['__muxFirstPaneId'] =
    (): number | null => {
      for (const session of store.state.sessions) {
        for (const win of session.windows) {
          if (win.panes.length > 0) return win.panes[0].id;
        }
      }
      return null;
    };

  (window as unknown as Record<string, unknown>)['__muxRegistry'] = {
    peek: (paneId: number) => terminalRegistry.getTerminal(paneId),
  };
}
