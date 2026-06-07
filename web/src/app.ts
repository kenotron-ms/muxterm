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

// Side-effect imports — register child custom elements
import './components/title-bar.js';
import './components/status-bar.js';
import './components/mux-dock.js';
import './components/workspace-picker.js';
import './components/reconnect-overlay.js';

import { WorkspaceController } from './lib/workspace-controller.js';
import { mintClientRef } from './lib/client-ref.js';
import { SessiondType } from './types.js';
import { currentLayoutMode } from './lib/breakpoint.js';
import { muxLog, muxLogReset } from './lib/mux-log.js';

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
      /* dvh (dynamic viewport height) collapses with the browser chrome on
         mobile so the status bar is never pushed below the fold. Falls back
         to svh (smallest stable viewport) then 100vh for older browsers. */
      height: 100vh;    /* fallback for browsers without dvh support */
      height: 100dvh;   /* dynamic viewport — shrinks with mobile browser chrome */
      background: #1a1b26;
      color: #a9b1d6;
      overflow: hidden;
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

    /* ── Centered workspace-create modal ── */
    .ws-create-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 3000;
    }

    .ws-create-dialog {
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 12px;
      padding: 28px 28px 24px;
      width: min(420px, calc(100vw - 40px));
      display: flex;
      flex-direction: column;
      gap: 20px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);
    }

    .ws-create-dialog h3 {
      margin: 0;
      color: #cdd6f4;
      font-size: 17px;
      font-weight: 600;
    }

    .ws-create-input {
      width: 100%;
      background: #313244;
      border: 1px solid #45475a;
      border-radius: 6px;
      color: #cdd6f4;
      font: inherit;
      font-size: 15px;
      padding: 11px 14px;
      outline: none;
      box-sizing: border-box;
      transition: border-color 0.12s, box-shadow 0.12s;
    }

    .ws-create-input:focus {
      border-color: #89b4fa;
      box-shadow: 0 0 0 2px rgba(137, 180, 250, 0.25);
    }

    .ws-create-input:disabled { opacity: 0.5; }

    .ws-create-row {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }

    .ws-create-confirm {
      padding: 10px 22px;
      background: #89b4fa;
      color: #1e1e2e;
      border: none;
      border-radius: 7px;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      min-width: 96px;
      transition: opacity 0.12s;
    }

    .ws-create-confirm:disabled { opacity: 0.45; cursor: not-allowed; }
    .ws-create-confirm:not(:disabled):hover { opacity: 0.85; }

    .ws-create-cancel {
      padding: 10px 18px;
      background: transparent;
      color: #6c7086;
      border: 1px solid #45475a;
      border-radius: 7px;
      font: inherit;
      font-size: 14px;
      cursor: pointer;
      transition: background-color 0.12s, color 0.12s;
    }

    .ws-create-cancel:disabled { opacity: 0.45; cursor: not-allowed; }
    .ws-create-cancel:not(:disabled):hover { background: #2a2b3c; color: #cdd6f4; }

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
  _connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

  @state()
  _showWorkspacePicker = false;

  @state()
  _showReconnectOverlay = false;

  @state()
  _reconnectMessage = 'Reconnecting...';

  @state()
  private _creatingWorkspace = false;

  @state()
  private _showCreateModal = false;

  @state()
  private _createModalName = '';

  private _socket: MuxSocket | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _controller: WorkspaceController | null = null;

  /** Close the workspace picker on Escape. */
  private _onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this._showWorkspacePicker) {
      this._showWorkspacePicker = false;
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
    // Escape closes the workspace picker.
    document.addEventListener('keydown', this._onDocKeyDown);
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
      // Replay setup: must run synchronously here, BEFORE binary replay frames
      // are processed. Lit's willUpdate/_syncTerminals fires on the next render
      // cycle, which is AFTER the replay frames arrive as macrotasks.
      //
      // Flow per attach:
      //   1. ensure() → creates/reuses entry
      //   2. setExpectedReplayBytes(pane.totalSeq) → how many bytes to wait for
      //   3. replay frames arrive → write() accumulates into pendingData
      //   4. _settleAndDrain waits until replayBytes >= expected, then drains
      if (msg.type === SessiondType.Composition) {
        muxLog('app composition', `workspaceId=${msg.workspaceId}`, {
          panes: (msg.panes ?? []).map(p => ({ paneId: p.paneId, totalSeq: p.totalSeq ?? 0 })),
          hasLayout: !!msg.layout,
          storeActivePaneId: store.activePaneId,
        });
        terminalRegistry.setWorkspace(msg.workspaceId ?? '');
        for (const pane of (msg.panes ?? [])) {
          const paneId = pane.paneId;
          if (paneId < 0) continue;
          // On reconnect an entry already exists with ready=true from the prior
          // session. Reset it before replay frames arrive so the barrier gate
          // works correctly (RC-6).
          if (terminalRegistry.isOpened(paneId)) {
            terminalRegistry.resetForReattach(paneId);
          }
          terminalRegistry.ensure(paneId, {
            onInput: (data) => this._socket?.sendPaneInput(paneId, data),
            onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
          });
          terminalRegistry.setExpectedReplayBytes(paneId, pane.totalSeq ?? 0);
        }
      }
      // One-terminal-per-workspace: when a composition is applied and the folded
      // store has zero panes, auto-spawn exactly one. Guarding on the FOLDED
      // getter means an already-overlaid optimistic pane suppresses a double-spawn.
      if (msg.type === SessiondType.Composition && store.panes.length === 0) {
        this._createPaneOptimistic();
      }
      // Server confirmed the workspace — clear loading state and close modal.
      if (msg.type === SessiondType.WorkspaceCreated && this._creatingWorkspace) {
        this._creatingWorkspace = false;
        this._showCreateModal = false;
        this._createModalName = '';
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
      this._creatingWorkspace = false;
    };
    this._socket.onReconnect = () => {
      this._showReconnectOverlay = false;
      muxLogReset();
      muxLog('app reconnect', 'WS connected, bootstrapping');
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

  override updated(changed: Map<PropertyKey, unknown>): void {
    super.updated(changed);
    // Auto-focus the name input when the create modal opens.
    if (changed.has('_showCreateModal') && this._showCreateModal) {
      requestAnimationFrame(() => {
        this.shadowRoot?.querySelector<HTMLInputElement>('.ws-create-input')?.focus();
      });
    }
  }

  private _syncTerminals(): void {
    // Establish the workspace context so composite registry keys are correct.
    // This must be called before ensure() so pane terminals land in the right
    // workspace slot and don't collide with same-id panes in other workspaces.
    terminalRegistry.setWorkspace(store.attached ?? '');
    const liveIds = new Set<number>();
    for (const pane of store.panes) {
      const paneId = pane.paneId;
      // Skip provisional overlay panes: _nextTempPaneId starts at -1 and
      // decrements, so any negative id is a transient optimistic placeholder.
      // Mounting a terminal on a provisional pane produces a phantom cursor
      // that flickers once the real positive-id pane settles.
      if (paneId < 0) continue;
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

  render() {
    // Exclude provisional overlay panes (negative IDs) from layout decisions.
    // They have no terminal and should not render as blank tiles.
    const panes = store.panes.filter((p) => p.paneId >= 0);

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
            <mux-dock
              .panes="${panes}"
              .activePaneId="${store.activePaneId}"
              .workspaceKey="${store.attached ?? ''}"
              .layout="${store.layout}"
              .narrow="${currentLayoutMode() === 'narrow'}"
              @pane-select="${this._onActivePane}"
              @pane-close="${this._onClosePane}"
              @pane-create="${this._createPaneOptimistic}"
              @pane-rename="${this._onPaneRename}"
              @layout-save="${this._onLayoutSave}"
            ></mux-dock>
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

      ${this._showCreateModal ? html`
        <div class="ws-create-backdrop" @click="${this._cancelCreate}">
          <div class="ws-create-dialog" @click="${(e: Event) => e.stopPropagation()}">
            <h3>New workspace</h3>
            <input
              class="ws-create-input"
              type="text"
              placeholder="Workspace name"
              ?disabled="${this._creatingWorkspace}"
              @keydown="${this._onCreateModalKeyDown}"
            />
            <div class="ws-create-row">
              <button
                class="ws-create-cancel"
                ?disabled="${this._creatingWorkspace}"
                @click="${this._cancelCreate}"
              >Cancel</button>
              <button
                class="ws-create-confirm"
                ?disabled="${this._creatingWorkspace}"
                @click="${this._submitCreate}"
              >${this._creatingWorkspace ? 'Creating…' : 'Create'}</button>
            </div>
          </div>
        </div>
      ` : ''}
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
            .createPending="${this._creatingWorkspace}"
            @workspace-selected="${this._onWorkspaceSelected}"
            @workspace-create="${this._onOpenCreateModal}"
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
   * Create a workspace: disables the button immediately via a local flag, sends
   * the create request to the daemon, and auto-switches when the confirmed
   * WorkspaceCreated reply arrives with the matching clientRef. No provisional
   * row is inserted — the flag is the only local state change.
   */
  private _onOpenCreateModal = (): void => {
    this._showWorkspacePicker = false;
    this._showCreateModal = true;
    this._createModalName = '';
  };

  private _onCreateModalKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter')  { e.preventDefault(); this._submitCreate(); }
    if (e.key === 'Escape') { e.preventDefault(); this._cancelCreate(); }
  };

  private _submitCreate = (): void => {
    // Read directly from the DOM — more reliable than state on mobile where
    // IME/autocorrect can delay @input events, leaving _createModalName stale.
    const input = this.shadowRoot?.querySelector<HTMLInputElement>('.ws-create-input');
    const name = (input?.value ?? this._createModalName).trim();
    if (!name || this._creatingWorkspace) return;
    this._creatingWorkspace = true;
    this._socket?.createWorkspace(name);
  };

  private _cancelCreate = (): void => {
    if (this._creatingWorkspace) return;
    this._showCreateModal = false;
    this._createModalName = '';
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
   * the store, which triggers _syncTerminals() to call setWorkspace() with the
   * new ID — isolating pane terminals via composite keys so scrollback from
   * the previous workspace survives for when we switch back.
   */
  private _onWorkspaceSelected = (e: CustomEvent<{ workspaceId: string }>): void => {
    this._showWorkspacePicker = false;
    if (e.detail.workspaceId === store.attached) return;
    // Do NOT call disposeAll() — workspace-scoped composite keys in
    // terminalRegistry isolate paneIds across workspaces, so old terminals
    // stay alive with their scrollback until explicitly pruned or disposed.
    this._socket?.attachWithBreakpoint(e.detail.workspaceId, currentLayoutMode());
  };

  /**
   * Handle a pane-close event dispatched by mux-dock when the user clicks
   * the dockview tab close (X) button. Prune the terminal from the registry
   * so the xterm instance is cleaned up, while the server-side PTY continues
   * until the workspace is closed or the connection drops.
   */
  private _onClosePane = (e: CustomEvent<{ paneId: number }>): void => {
    const closedPaneId = e.detail.paneId;
    // Tell the server to kill the PTY. The server will broadcast pane-closed,
    // which removes the pane from store._panes. Pruning the terminal now
    // (before pane-closed) is correct: the user already removed the panel from
    // the dock, and the generation counter in the registry will cancel any
    // in-flight write callbacks.
    this._socket?.closePane(closedPaneId);
    const remaining = new Set(
      store.panes
        .filter((p) => p.paneId >= 0 && p.paneId !== closedPaneId)
        .map((p) => p.paneId),
    );
    terminalRegistry.prune(remaining);
  };

  private _onPaneRename = (e: CustomEvent<{ paneId: number; name: string }>): void => {
    this._socket?.renamePane(e.detail.paneId, e.detail.name);
  };

  private _onLayoutSave = (e: CustomEvent<{ layout: string }>): void => {
    const ws = store.attached;
    if (!ws) return;
    // Narrow (phone) has no persisted layout — it's a tab view only.
    if (currentLayoutMode() !== 'wide') return;
    this._socket?.saveLayout(ws, 'wide', e.detail.layout);
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
