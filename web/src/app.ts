import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from './state.js';
import { icon } from './lib/icons.js';
import { MonitorX } from 'lucide';
import { MuxSocket, buildWsUrl } from './ws.js';
import { terminalRegistry, configureTerminals } from './lib/terminal-registry.js';
import { parseResolvedConfig } from './lib/config.js';
import { makeKeyHandler, type UIActions } from './lib/keybindings.js';
import { applyThemeTokens, resolvePalette } from './lib/theme.js';
import { arrange, viewportClassFor, type Arrangement } from './lib/layout.js';

// Side-effect imports — register child custom elements
import './components/title-bar.js';
import './components/status-bar.js';
import './components/pane.js';
import './components/composition.js';
import './components/workspace-picker.js';
import './components/reconnect-overlay.js';
import type { LauncherAction } from './components/launcher-menu.js';
import { WorkspaceController } from './lib/workspace-controller.js';
import { mintClientRef } from './lib/client-ref.js';
import { SessiondType } from './types.js';

// Optimistic panes use a strictly-negative temp paneId so they never collide
// with the daemon's positive workspace-local ids (which start at 1); the real
// positive-id pane replaces it on settle (matched by clientRef).
let _nextTempPaneId = -1;

// ---------------------------------------------------------------------------
// Module-level keybinding wiring
// ---------------------------------------------------------------------------

/** Actions map passed to installKeybindings — populated with real handlers as
 *  each phase lands. Stubs use () => {} to keep wiring unconditional. */
const uiActions: UIActions = {
  openLauncher: () => window.dispatchEvent(new CustomEvent('open-launcher')),
  split: () => {}, // wired to create-pane in connectedCallback
  maximizeRegion: () => {},
  popOut: () => {},
  nextSession: () => {},
  focusDriver: () => {},
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

    /* Empty workspace state — shown when the attached workspace has no panes.
       Fills the space the terminal composition would occupy. */
    .empty-workspace {
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

    .empty-workspace .glyph {
      line-height: 1;
      opacity: 0.5;
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }

    .empty-workspace .headline {
      font-size: 16px;
      color: #a9b1d6;
      font-weight: 600;
    }

    .empty-workspace .subtext {
      font-size: 13px;
      color: #565f89;
    }

    .empty-workspace button {
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

    .empty-workspace button:hover {
      background: #2f344d;
      border-color: #7aa2f7;
    }
  `;

  /** Bumped whenever the store notifies; drives Lit re-render off wire state. */
  @state()
  _version = 0;

  @state()
  _viewportWidth = typeof window !== 'undefined' ? window.innerWidth || 1024 : 1024;

  @state()
  _connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

  @state()
  _showWorkspacePicker = false;

  @state()
  _showReconnectOverlay = false;

  @state()
  _reconnectMessage = 'Reconnecting...';

  private _socket: MuxSocket | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _controller: WorkspaceController | null = null;

  /** Close the workspace picker on Escape. */
  private _onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this._showWorkspacePicker) {
      this._showWorkspacePicker = false;
    }
  };

  /** Track the live viewport width so the responsive arrangement reflows. */
  private _onWindowResize = (): void => {
    const w = window.innerWidth || 1024;
    if (w !== this._viewportWidth) this._viewportWidth = w;
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
    // Escape closes the workspace picker.
    document.addEventListener('keydown', this._onDocKeyDown);
    window.addEventListener('resize', this._onWindowResize);

    // Apply default theme tokens immediately so --mux-* vars exist before any frame.
    applyThemeTokens(resolvePalette(store.config.theme.palette));
    // Install keybindings with defaults immediately — mirrors applyThemeTokens.
    disposeKeys = installKeybindings(uiActions);

    // Re-render whenever wire state (composition / workspaces / config) changes.
    this._unsubscribe = store.subscribe(() => {
      this._version++;
    });

    // Create WebSocket connection
    this._socket = new MuxSocket(store, buildWsUrl('/ws'));
    // Browser-as-multiplexer coordination seam: feed every inbound frozen
    // sessiond message to BOTH the store (wire-state truth) and the controller
    // (next-action decisions: bootstrap, MRU, recovery).
    this._controller = new WorkspaceController(store, this._socket);
    this._socket.onSessiondMessage = (msg) => {
      store.applySessiond(msg);
      this._controller?.onMessage(msg);
      // One-terminal-per-workspace: when a composition is applied and the folded
      // store has zero panes, auto-spawn exactly one. Guarding on the FOLDED
      // getter means an already-overlaid optimistic pane suppresses a double-spawn.
      if (msg.type === SessiondType.Composition && store.panes.length === 0) {
        this._createPaneOptimistic();
      }
    };
    // The split shortcut creates a connection-scoped pane (create-pane);
    // now optimistic so the provisional pane overlays instantly.
    uiActions.split = () => this._createPaneOptimistic();
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
      // On (re)connect: attach the last/known workspace, or list + attach the
      // first. This is where the initial composition sync is requested.
      this._controller?.bootstrap();
    };
    this._socket.connect();
    this._connectionStatus = 'reconnecting';
    this._pollConnectionStatus();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('open-launcher', this._onOpenLauncherAttr);
    document.removeEventListener('keydown', this._onDocKeyDown);
    window.removeEventListener('resize', this._onWindowResize);
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
   * composition. This ensure()s a persistent Terminal for EVERY pane in the
   * attached workspace so background (tabbed-away) panes stay fed and keep
   * their scrollback. Panes no longer in the composition are prune()'d.
   */
  override willUpdate(_changedProperties: Map<PropertyKey, unknown>): void {
    super.willUpdate(_changedProperties);
    this._syncTerminals();
  }

  private _syncTerminals(): void {
    const liveIds = new Set<number>();
    for (const pane of store.panes) {
      const paneId = pane.paneId;
      terminalRegistry.ensure(paneId, {
        onInput: (data) => this._socket?.sendPaneInput(paneId, data),
        // Active-view-wins: only rendered/visible panes own a live
        // ResizeObserver, so tabbed-away panes never report a resize.
        onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
      });
      liveIds.add(paneId);
    }
    terminalRegistry.prune(liveIds);
  }

  /** Compute the current arrangement for the measured viewport class. */
  private _arrangement(): Arrangement {
    if (this._controller) {
      return this._controller.currentArrangement(this._viewportWidth);
    }
    return arrange(store.composition, viewportClassFor(this._viewportWidth));
  }

  render() {
    const panes = store.panes;
    const arrangement = this._arrangement();

    return html`
      <mux-title-bar @launcher-action="${this._onLauncherAction}"></mux-title-bar>
      ${panes.length === 0
        ? html`
            <div class="empty-workspace">
              <div class="glyph">${icon(MonitorX, { size: 48 })}</div>
              <div class="headline">No panes</div>
              <div class="subtext">
                This workspace has nothing running. Create a pane to get started.
              </div>
              <button @click="${this._onCreatePane}"><span>+</span> New pane</button>
            </div>
          `
        : html`
            <mux-composition
              .arrangement="${arrangement}"
              workspaceKey="${store.attached ?? ''}"
              @pane-select="${this._onActivePane}"
              @pane-focus="${this._onActivePane}"
            ></mux-composition>
          `}
      <mux-status-bar
        .workspaces="${store.workspaces}"
        .currentWorkspaceId="${store.attached ?? ''}"
        connectionStatus="${this._connectionStatus}"
        @open-workspace-picker="${this._onOpenWorkspacePicker}"
      ></mux-status-bar>
      <div class="overlay ${this._connectionStatus === 'connected' ? 'hidden' : ''}">
        Connecting to muxterm...
      </div>
      ${this._showReconnectOverlay
        ? html`<mux-reconnect-overlay
            message="${this._reconnectMessage}"
          ></mux-reconnect-overlay>`
        : ''}
      ${this._showWorkspacePicker
        ? html`<mux-workspace-picker
            .workspaces="${store.workspaces}"
            .currentWorkspaceId="${store.attached ?? ''}"
            .erroredMutations="${store.erroredMutations}"
            @workspace-selected="${this._onWorkspaceSelected}"
            @workspace-create="${this._createWorkspaceOptimistic}"
            @workspace-rename="${this._onWorkspaceRename}"
            @workspace-close="${this._onWorkspaceClose}"
            @workspace-retry="${(e: CustomEvent<{ mutationId: string }>) =>
              store.retry(e.detail.mutationId)}"
            @workspace-dismiss="${(e: CustomEvent<{ mutationId: string }>) =>
              store.dismiss(e.detail.mutationId)}"
            @close-picker="${() => {
              this._showWorkspacePicker = false;
            }}"
          ></mux-workspace-picker>`
        : ''}
    `;
  }

  /** Client-local active-pane selection (sessiond has no select-pane message). */
  private _onActivePane = (e: CustomEvent<{ paneId: number }>): void => {
    store.setActivePane(e.detail.paneId);
  };

  /** Empty-state button: create a connection-scoped pane in the workspace. */
  private _onCreatePane = (): void => {
    this._createPaneOptimistic();
  };

  /**
   * Create a workspace optimistically: a provisional row appears instantly,
   * keyed by a minted clientRef used as its temporary workspaceId so the row
   * has byte-identical layout to a real entry. The daemon echoes the ref on the
   * authoritative workspace-list, which settles the pending mutation by exact
   * identity (clientRef match) rather than fragile counting.
   */
  private _createWorkspaceOptimistic = (): void => {
    const ref = mintClientRef();
    store.mutate({
      workspaceId: ref,
      kind: 'create',
      optimistic: (draft) =>
        draft.workspaces.push({ workspaceId: ref, paneCount: 0, clientRef: ref }),
      settled: (base) => base.workspaces.some((w) => w.clientRef === ref),
      onTimeout: () => {
        /* no-op; Phase-2 marks errored row, must never silently vanish */
      },
    });
    this._socket?.createWorkspace(undefined, ref);
  };

  /**
   * Create a pane optimistically: a provisional pane appears instantly with a
   * strictly-negative temp paneId (so it never collides with the daemon's
   * positive workspace-local ids) keyed by a minted clientRef. The daemon echoes
   * the ref on the authoritative pane-added, which settles the pending mutation
   * by exact identity (clientRef match) and replaces the temp with the real id.
   */
  private _createPaneOptimistic = (): void => {
    const ref = mintClientRef();
    const tempId = _nextTempPaneId--;
    store.mutate({
      workspaceId: ref,
      kind: 'create-pane',
      optimistic: (draft) => draft.panes.push({ paneId: tempId, cols: 0, rows: 0, clientRef: ref }),
      settled: (base) => base.panes.some((p) => p.clientRef === ref),
    });
    this._socket?.createPane(undefined, ref);
  };

  private _handleControlMessage = (msg: Record<string, unknown>): void => {
    if ('detached' in msg && msg.detached && typeof msg.detached === 'object') {
      const detached = msg.detached as { reason?: string };
      this._showReconnectOverlay = true;
      this._reconnectMessage = detached.reason ?? 'Disconnected';
    }
    // {"type":"config",...} envelope (Phase 3 carry-forward): re-resolve theme,
    // terminal options, and keybindings from the daemon-provided config.
    if ('config' in msg) {
      const cfg = parseResolvedConfig(msg['config']);
      store.setConfig(cfg);
      applyThemeTokens(resolvePalette(cfg.theme.palette));
      configureTerminals(cfg); // future Terminals pick up font/cursor/scrollback/palette
      disposeKeys?.();
      disposeKeys = installKeybindings(uiActions);
    }
  };

  private _onOpenWorkspacePicker = (): void => {
    this._showWorkspacePicker = !this._showWorkspacePicker;
  };

  /**
   * Rename a workspace optimistically: the overlay shows the new name instantly,
   * the socket send is the mutation's commit, and the daemon's workspace-renamed
   * echo settles (or times out) the pending record.
   */
  private _onWorkspaceRename = (e: CustomEvent<{ workspaceId: string; name: string }>): void => {
    const { workspaceId, name } = e.detail;
    store.mutate({
      workspaceId,
      kind: 'rename',
      optimistic: (draft) => {
        const ws = draft.workspaces.find((w) => w.workspaceId === workspaceId);
        if (ws) ws.name = name ? name : undefined;
      },
      settled: (base) => {
        const ws = base.workspaces.find((w) => w.workspaceId === workspaceId);
        return (ws?.name ?? '') === name;
      },
      commit: () => this._socket?.renameWorkspace(workspaceId, name),
    });
  };

  /**
   * Close a workspace optimistically: the overlay drops the row instantly, the
   * socket send is the mutation's commit, and the daemon's workspace-list echo
   * settles (by the id no longer existing) or times out the pending record.
   */
  private _onWorkspaceClose = (e: CustomEvent<{ workspaceId: string }>): void => {
    const { workspaceId } = e.detail;
    store.mutate({
      workspaceId,
      kind: 'close',
      optimistic: (draft) => {
        draft.workspaces = draft.workspaces.filter((w) => w.workspaceId !== workspaceId);
      },
      settled: (base) => !base.workspaces.some((w) => w.workspaceId === workspaceId),
      commit: () => this._socket?.closeWorkspace(workspaceId),
    });
  };

  /**
   * Switch the attached workspace. The daemon's composition reply re-populates
   * the store, so we only dispose the previous workspace's terminals (paneIds
   * are reused across workspaces) and request the attach.
   */
  private _onWorkspaceSelected = (e: CustomEvent<{ workspaceId: string }>): void => {
    this._showWorkspacePicker = false;
    if (e.detail.workspaceId === store.attached) return;
    terminalRegistry.disposeAll();
    this._socket?.attach(e.detail.workspaceId);
  };

  private _onLauncherAction = (): void => {
    /* ⋯ menu is app-level only; presentational this round; workspace creation
       lives in the status-bar switcher, so launcher actions must never open the
       picker */
  };

  private _routePaneOutput(paneId: number, data: Uint8Array): void {
    // Write directly to the registry — works for ALL panes (including
    // background panes whose mux-pane element is not in the DOM).
    terminalRegistry.write(paneId, data);
  }

  private _pollConnectionStatus(): void {
    const poll = (): void => {
      if (!this._socket) return;
      const newStatus = this._socket.connected
        ? 'connected'
        : this._connectionStatus === 'connected'
        ? 'disconnected'
        : this._connectionStatus;
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

// ---------------------------------------------------------------------------
// Dev window accessors — exposed for E2E testing (config assertions)
// Guarded behind import.meta.env.DEV: never leaks store state in production.
// ---------------------------------------------------------------------------
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>)['__muxStore'] = store;

  (window as unknown as Record<string, unknown>)['__muxFirstPaneId'] = (): number | null => {
    return store.panes[0]?.paneId ?? null;
  };

  (window as unknown as Record<string, unknown>)['__muxRegistry'] = {
    peek: (paneId: number) => terminalRegistry.getTerminal(paneId),
  };
}
