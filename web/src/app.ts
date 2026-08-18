import { LitElement, html, css } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { customElement, state } from 'lit/decorators.js';
import { store } from './state.js';
import { icon } from './lib/icons.js';
import { MonitorX } from 'lucide';
import { MuxSocket, buildWsUrl } from './ws.js';
import { terminalRegistry, configureTerminals } from './lib/terminal-registry.js';
import { parseResolvedConfig, patchConfig, configToGoJSON, type ResolvedConfig } from './lib/config.js';
import { makeKeyHandler, installAppShortcuts, type UIActions } from './lib/keybindings.js';
import { applyThemeTokens, applyChromeTokens, resolvePalette } from './lib/theme.js';
import { applyDocumentTitle, applyTitlebarColor, restoreTitlebarColor } from './lib/instance-identity.js';
import { injectTerminalFont } from './lib/fonts.js';
import { voiceInputController } from './lib/voice-input-controller.js';
import { fetchAIStatus, parseAIStatus, type AIStatus } from './lib/ai.js';

// Inject @font-face for the server-bundled Nerd Font as early as possible so
// the CSS rules are in place before WebFontsAddon.loadFonts() is called.
injectTerminalFont();

// Side-effect imports — register child custom elements
import './components/title-bar.js';
import './components/mux-dock.js';
import './components/settings-surface.js';
import './components/monitoring-surface.js';
import type { MuxDock } from './components/mux-dock.js';
import type { LauncherAction } from './components/launcher-menu.js';
import './components/mux-undo-toast.js';
import './components/workspace-picker.js';
import './components/reconnect-overlay.js';
import './components/mux-sidebar.js';
import type { MuxSidebar } from './components/mux-sidebar.js';


import { WorkspaceController } from './lib/workspace-controller.js';
import { PaneFocusCoordinator } from './lib/pane-focus-coordinator.js';
import { mintClientRef } from './lib/client-ref.js';
import { SessiondType, type LayoutCommand } from './types.js';
import { currentLayoutMode } from './lib/breakpoint.js';
import { muxLog, muxLogReset } from './lib/mux-log.js';
import Split from 'split.js';
import type { Instance as SplitInstance } from 'split.js';
import {
  restoreSidebarWidth,
  persistSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from './lib/sidebar-width.js';

/** Split.js gutter size (px), used both as the `gutterSize` option passed to
 *  `Split(...)` in `_initSplit()` below and as the half-gutter compensation
 *  in `widthPxToSplitPercent()` — defined once so the two can never drift
 *  out of sync if the gutter size is ever changed. */
const SIDEBAR_GUTTER_SIZE = 4;
/** Small positive bias (px) that makes Split's percentage renderer round to
 *  the requested whole pixel instead of occasionally landing 1/64px short. */
const SIDEBAR_SUBPIXEL_ROUNDING_BIAS = 0.001;

/** Converts a target sidebar pixel width into the percentage Split.js needs,
 *  compensating for its default renderer's half-gutter subtraction so the
 *  actual rendered width equals `targetPx`. Split's default
 *  `calc(size% - gutSize px)` renderer always subtracts a half-gutter share
 *  (`gutterSize / 2`) from whatever percentage-derived width it computes;
 *  without this compensation an unadjusted percentage renders
 *  `targetPx - gutterSize / 2`, not `targetPx` (e.g. a 220px target
 *  rendering as 218px). Used by both `_initSplit()`'s initial `sizes`
 *  computation and the `ResizeObserver` callback's `setSizes()`
 *  recalculation. `onDragEnd` first reads the actual rendered
 *  `getBoundingClientRect().width`, then uses this conversion once to snap it
 *  back to a whole pixel. The small positive bias keeps CSS subpixel
 *  quantization from resolving an otherwise exact target 1/64px short. */
function widthPxToSplitPercent(targetPx: number, containerWidth: number, gutterSize: number): number {
  return ((targetPx + gutterSize / 2 + SIDEBAR_SUBPIXEL_ROUNDING_BIAS) / containerWidth) * 100;
}

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
  nextSession: () => {}, // wired to cycleTabInGroup in connectedCallback
  focusDriver: () => {},
};

/** Disposer for the currently-installed keydown handler. Re-set after each
 *  config frame so new key bindings take effect immediately. */
let disposeKeys: (() => void) | undefined;

/** Disposer for fixed app-level shortcuts (Cmd+W, Cmd+T). Installed once per
 *  app connection and not re-set on config changes — these are not configurable. */
let disposeAppShortcuts: (() => void) | undefined;

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
      background: var(--chrome-body);
      color: var(--mux-fg);
      overflow: hidden;
    }

    .overlay {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      background: color-mix(in srgb, var(--chrome-body) 85%, transparent);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000; /* above undo toasts (z-index: 900) */
      color: var(--mux-warn);
      font-size: 16px;
    }

    .overlay.hidden {
      display: none;
    }

    .undo-toast-stack {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column-reverse;
      gap: 8px;
      z-index: 900; /* below reconnect overlay */
      pointer-events: none;
    }
    .undo-toast-stack > * {
      pointer-events: auto;
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
      background: var(--chrome-body);
      border: 1px solid var(--chrome-border);
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
      color: var(--chrome-text-bright);
      font-size: 17px;
      font-weight: 600;
    }

    .ws-create-input {
      width: 100%;
      background: var(--chrome-hover);
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      color: var(--chrome-text-bright);
      font: inherit;
      font-size: 15px;
      padding: 11px 14px;
      outline: none;
      box-sizing: border-box;
      transition: border-color 0.12s, box-shadow 0.12s;
    }

    .ws-create-input:focus {
      border-color: var(--chrome-accent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--chrome-accent) 25%, transparent);
    }

    .ws-create-input:disabled { opacity: 0.5; }

    .ws-create-row {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }

    .ws-create-confirm {
      padding: 10px 22px;
      background: var(--chrome-accent);
      color: var(--chrome-body);
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
      color: var(--chrome-text-dim);
      border: 1px solid var(--chrome-border);
      border-radius: 7px;
      font: inherit;
      font-size: 14px;
      cursor: pointer;
      transition: background-color 0.12s, color 0.12s;
    }

    .ws-create-cancel:disabled { opacity: 0.45; cursor: not-allowed; }
    .ws-create-cancel:not(:disabled):hover { background: var(--chrome-hover); color: var(--chrome-text-bright); }

    /* ── Overlay panel (settings / shortcuts / about) ── */
    .overlay-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 3000;
    }

    .overlay-dialog {
      background: var(--chrome-body);
      border: 1px solid var(--chrome-border);
      border-radius: 10px;
      width: min(600px, calc(100vw - 32px));
      height: min(80vh, 640px);
      display: flex;
      flex-direction: column;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.7);
      overflow: hidden;
    }

    .overlay-body {
      flex: 1;
      overflow: hidden;
      min-height: 0;
    }

    /* shortcuts / about panels rendered inline */
    .info-panel {
      padding: 24px 24px 32px;
    }

    .info-panel h2 {
      margin: 0 0 20px;
      font-size: 17px;
      font-weight: 600;
      color: var(--chrome-text-bright);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .info-panel .close-btn {
      background: transparent;
      border: none;
      color: var(--chrome-text-dim);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 0 4px;
      border-radius: 4px;
    }

    .info-panel .close-btn:hover { color: var(--chrome-text-bright); background: var(--chrome-hover); }

    .shortcut-grid {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0;
    }

    .shortcut-grid .sc-label {
      padding: 8px 0;
      border-bottom: 1px solid var(--chrome-border);
      font-size: 13px;
      color: var(--chrome-text-dim);
    }

    .shortcut-grid .sc-key {
      padding: 8px 0;
      border-bottom: 1px solid var(--chrome-border);
      font-size: 12px;
      color: var(--chrome-text-bright);
      font-family: 'JetBrainsMonoNerdFont', 'SF Mono', monospace;
      text-align: right;
    }

    .about-body {
      font-size: 13px;
      color: var(--chrome-text-dim);
      line-height: 1.7;
    }

    .about-body strong { color: var(--chrome-text-bright); }

    .about-sha {
      margin-top: 16px;
      font-family: 'JetBrainsMonoNerdFont', 'SF Mono', monospace;
      font-size: 11px;
      color: var(--chrome-text-dim);
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
      background: var(--chrome-body);
      color: var(--chrome-text-dim);
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
      color: var(--mux-fg);
      font-weight: 600;
    }

    .empty-workspace .subtext {
      font-size: 13px;
      color: var(--chrome-text-dim);
    }

    .empty-workspace button {
      margin-top: 8px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 18px;
      font-size: 13px;
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
      border: 1px solid var(--chrome-text-dim);
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
    }

    .empty-workspace button:hover {
      background: var(--chrome-hover);
      border-color: var(--chrome-accent);
    }

    .content-area {
      flex: 1;
      display: flex;
      flex-direction: row;
      overflow: hidden;
      min-height: 0;
    }

    .main-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }

    /* Split.js gutter — styled to visually match the removed
       mux-sidebar.ts .resize-handle (4px, transparent, col-resize cursor,
       hover highlight). Unlike the old absolutely-positioned overlay, this
       is a real flex-row sibling occupying its own layout width. */
    .sidebar-gutter {
      width: 4px;
      cursor: col-resize;
      background: transparent;
      transition: background 0.15s;
    }

    .sidebar-gutter:hover {
      background: var(--chrome-accent);
      opacity: 0.4;
    }
  `;

  /** Bumped whenever the store notifies; drives Lit re-render off wire state. */
  @state()
  _version = 0;

  @state()
  _connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

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

  @state()
  private _overlayPanel: 'settings' | 'shortcuts' | 'about' | 'monitoring' | null = null;

  @state()
  private _layoutMode: 'wide' | 'narrow' = currentLayoutMode();

  /** Active grace-period timers, keyed by paneId. Presence => a deferred close
   *  is pending and a toast is shown. */
  private _pendingCloses = new Map<number, ReturnType<typeof setTimeout>>();
  /** Per-pending metadata for rendering each toast (the tab title at close). */
  private _pendingClosesMeta = new Map<number, { title: string }>();

  /** Pending workspace grace-period closes, keyed by negative virtual ID. */
  private _pendingWorkspaceCloses = new Map<number, { timer: ReturnType<typeof setTimeout>; wsId: string; name: string }>();
  /** Monotonically-decreasing counter for workspace virtual IDs (never collides with pane IDs). */
  private _wsVirtualId = -1000;
  /** Pane IDs for which closePane has been sent but the server hasn't removed
   *  the pane from store.panes yet. _syncTerminals skips ensure() for these so
   *  the terminal isn't phantom-recreated between the close send and the ACK. */
  private _closingPanes = new Set<number>();

  private _socket: MuxSocket | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _controller: WorkspaceController | null = null;
  private _paneFocusCoordinator: PaneFocusCoordinator | null = null;
  private _disposePaneFocusListeners: (() => void) | null = null;

  /** Split.js instance managing the sidebar/main-pane resize boundary,
   *  owned here (not mux-sidebar.ts) since Split.js needs both sibling DOM
   *  elements at once — see
   *  docs/designs/2026-08-01-sidebar-resize-splitjs-design.md. */
  private _split: SplitInstance | null = null;
  /** Observes .content-area so the sidebar can be kept pixel-fixed across
   *  window resizes despite Split's percentage-based rendering. */
  private _resizeObserver: ResizeObserver | null = null;
  /** The fixed pixel width the sidebar should render at; updated only in
   *  onDragEnd, otherwise held constant across container resizes. */
  private _sidebarWidthPx = SIDEBAR_DEFAULT_WIDTH;
  /** True while a Split.js drag gesture is in progress; consulted by the
   *  ResizeObserver callback (skip recompute mid-drag) and by
   *  _destroySplit() (force a synthetic mouseup before teardown). */
  private _dragging = false;

  /** Bound handler: sets data-launcher-open on the host (light DOM) so E2E
   *  selectors like document.querySelector('[data-launcher-open]') work. */
  private _onOpenLauncherAttr = (): void => {
    this.setAttribute('data-launcher-open', '');
  };

  /** Handles window resize; updates _layoutMode when crossing the 768px threshold. */
  private _onViewportResize = (): void => {
    const mode = currentLayoutMode();
    if (mode !== this._layoutMode) this._layoutMode = mode;
  };

  connectedCallback(): void {
    super.connectedCallback();

    // Opt-in AI capability: resolve the flag once on load. Fetched over HTTP
    // rather than carried on the config frame, because the key that backs it
    // deliberately never enters the config pipeline.
    void fetchAIStatus().then((s) => store.setAIStatus(s));

    // Track launcher-open state on the host element for E2E assertions.
    window.addEventListener('open-launcher', this._onOpenLauncherAttr);
    // Layout-command relay: window CustomEvent from ws.ts → mux-dock routing.
    window.addEventListener('layout-command', this._onLayoutCommand);
    // Update layout mode when the viewport crosses the 768px breakpoint.
    window.addEventListener('resize', this._onViewportResize);
    this._layoutMode = currentLayoutMode();
    // Apply default theme tokens immediately so --mux-* and --chrome-* vars exist before any frame.
    applyThemeTokens(resolvePalette(store.config.theme.palette));
    applyChromeTokens(store.config.theme.palette);
    // Reflect which machine this instance is running on — document title
    // (PWA window title / browser tab / Alt-Tab preview) and, if the user
    // picked one in Settings, a distinguishing title-bar accent color.
    // Per-browser (localStorage), not server config — see instance-identity.ts.
    applyDocumentTitle();
    applyTitlebarColor(restoreTitlebarColor());
    // Install keybindings with defaults immediately — mirrors applyThemeTokens.
    disposeKeys = installKeybindings(uiActions);
    // Install fixed app-level shortcuts (Cmd+W close, Cmd+T new pane). These
    // override the browser's native tab-close / new-tab actions so muxterm
    // feels like a native app. Installed once — not re-set on config changes.
    disposeAppShortcuts?.();
    disposeAppShortcuts = installAppShortcuts({
      // Remove the active panel from dockview, which triggers onDidRemovePanel
      // → pane-close event → _startDeferredClose (deferred kill + undo toast).
      // This mirrors exactly what clicking the tab X button does.
      closePane: () => this._dock?.closeActivePanel(),
      newPane: () => this._createPaneOptimistic(),
      // Cycle tabs within the active pane's group only (not across split panes).
      nextTab: () => this._dock?.cycleTabInGroup('next'),
      prevTab: () => this._dock?.cycleTabInGroup('prev'),
    });

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
    this._paneFocusCoordinator = new PaneFocusCoordinator(this._socket);
    // Non-authoritative clients: apply the daemon's canonical size directly,
    // without re-fitting to this client's own container (letterbox/scroll —
    // see terminal-registry.ts's applyServerResize).
    this._socket.onPaneResized = (paneId, cols, rows) => {
      terminalRegistry.applyServerResize(paneId, cols, rows);
    };
    // visibilitychange + window 'focus': this browser tab/window regaining
    // OS focus re-claims every currently-visible pane. Mirrors the existing
    // window.addEventListener('resize', ...) registration/cleanup pattern
    // just below.
    this._disposePaneFocusListeners = this._paneFocusCoordinator.installWindowListeners();
    this._socket.onSessiondMessage = (msg) => {
      // For pane-added events carrying an explicit placement token (e.g. from
      // an MCP create_pane call), pre-wire the dock's placement intent BEFORE
      // applySessiond() triggers the Lit reactive update that runs the
      // reconciler. The dock reads _nextPlacement inside updated(), which runs
      // synchronously during the next microtask render — setting it here (still
      // synchronous) is safe because microtasks haven't run yet.
      if (msg.type === SessiondType.PaneAdded && msg.placement) {
        this._dock?.preparePlacementForPaneAdded(msg.placement, msg.referencePaneId);
      }
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
          // Browser panes are client-rendered (native apps). The web client
          // renders a placeholder (see mux-dock PlaceholderRenderer) and does no
          // terminal setup for them.
          if (pane.surfaceKind === 'browser') { continue; }
          // On reconnect an entry already exists with ready=true from the prior
          // session. Reset it before replay frames arrive so the barrier gate
          // works correctly (RC-6).
          if (terminalRegistry.isOpened(paneId)) {
            terminalRegistry.resetForReattach(paneId);
          }
          terminalRegistry.ensure(paneId, {
            onInput: (data) => this._socket?.sendPaneInput(paneId, data),
            onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
            onSettled: () => this._paneFocusCoordinator?.claimPane(paneId),
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
      // Cancel grace-period timers: can't guarantee closePane delivery
      // while disconnected; don't prune terminals that may survive reconnect.
      // Capture ids BEFORE clearing the maps/set
      const pendingIds = [...this._pendingCloses.keys()];
      const closingIds = [...this._closingPanes];
      for (const handle of this._pendingCloses.values()) clearTimeout(handle);
      this._pendingCloses.clear();
      this._pendingClosesMeta.clear();
      this._closingPanes.clear();
      // Re-enable reconciler for panes whose grace period was aborted or whose
      // close was in-flight — their PTY is still alive on the server.
      this._dock?.allowReconcile([...closingIds, ...pendingIds]);
      this.requestUpdate();
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

    // Reconnect-while-already-wide: if <mux-app> disconnects and reconnects
    // while _layoutMode was already 'wide' throughout, no _layoutMode change
    // fires to trigger the updated() init path below, but
    // disconnectedCallback() has already nulled _split. Re-init here covers
    // that gap.
    if (this._layoutMode === 'wide' && !this._split) {
      this._initSplit();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('open-launcher', this._onOpenLauncherAttr);
    window.removeEventListener('layout-command', this._onLayoutCommand);
    window.removeEventListener('resize', this._onViewportResize);
    this._disposePaneFocusListeners?.();
    this._disposePaneFocusListeners = null;
    this._paneFocusCoordinator = null;
    disposeAppShortcuts?.();
    disposeAppShortcuts = undefined;
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._socket) {
      this._socket.disconnect();
      this._socket = null;
    }
    // Clear any pending deferred-close timers (guards against test-suite timer bleed)
    for (const handle of this._pendingCloses.values()) clearTimeout(handle);
    this._pendingCloses.clear();
    this._pendingClosesMeta.clear();
    this._closingPanes.clear();
    for (const entry of this._pendingWorkspaceCloses.values()) clearTimeout(entry.timer);
    this._pendingWorkspaceCloses.clear();
    this._destroySplit();
  }

  /**
   * Before each render, synchronise the terminal registry with the current
   * composition. This ensure()s a persistent Terminal for EVERY pane in the
   * attached workspace so background (tabbed-away) panes stay fed and keep
   * their scrollback. Panes no longer in the composition are prune()'d.
   */
  override willUpdate(changedProperties: Map<PropertyKey, unknown>): void {
    super.willUpdate(changedProperties);
    this._syncTerminals();
    // Wide→narrow: destroy Split.js BEFORE Lit removes <mux-sidebar> from the
    // DOM (willUpdate fires pre-render) — see
    // docs/designs/2026-08-01-sidebar-resize-splitjs-design.md Architecture.
    if (changedProperties.has('_layoutMode') && this._layoutMode === 'narrow' && this._split) {
      this._destroySplit();
    }
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    super.updated(changed);
    // Auto-focus the name input when the create modal opens.
    if (changed.has('_showCreateModal') && this._showCreateModal) {
      requestAnimationFrame(() => {
        this.shadowRoot?.querySelector<HTMLInputElement>('.ws-create-input')?.focus();
      });
    }
    // Narrow→wide: init Split.js AFTER Lit has placed the sidebar/main-pane
    // elements back in the DOM (updated fires post-render) — see
    // docs/designs/2026-08-01-sidebar-resize-splitjs-design.md Architecture.
    if (changed.has('_layoutMode') && this._layoutMode === 'wide' && !this._split) {
      this._initSplit();
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
      // Skip panes where closePane has been sent but the server hasn't removed
      // them from store.panes yet — recreating the terminal here would produce
      // a phantom entry that conflicts with the in-flight close.
      if (this._closingPanes.has(paneId)) continue;
      // Browser panes: opaque placeholder slots. Keep them in the live set so
      // the dock doesn't prune the panel, but do no terminal/registry work.
      if (pane.surfaceKind === 'browser') { liveIds.add(paneId); continue; }
      terminalRegistry.ensure(paneId, {
        onInput: (data) => this._socket?.sendPaneInput(paneId, data),
        // Active-view-wins: only rendered/visible panes own a live
        // ResizeObserver, so tabbed-away panes never report a resize.
        onResize: (cols, rows) => this._controller?.reportResize(paneId, cols, rows),
        onSettled: () => this._paneFocusCoordinator?.claimPane(paneId),
      });
      liveIds.add(paneId);
    }
    terminalRegistry.prune(liveIds);
    // Clean up _closingPanes entries the server has now removed from store.panes.
    const toDelete = new Set<number>();
    for (const id of this._closingPanes) {
      if (!store.panes.some((p) => p.paneId === id)) toDelete.add(id);
    }
    for (const id of toDelete) this._closingPanes.delete(id);
  }

  private _initSplit(): void {
    const sidebarEl = this.renderRoot.querySelector<HTMLElement>('mux-sidebar');
    const mainPaneEl = this.renderRoot.querySelector<HTMLElement>('.main-pane');
    const contentAreaEl = this.renderRoot.querySelector<HTMLElement>('.content-area');
    if (!sidebarEl || !mainPaneEl || !contentAreaEl || this._split) return;

    this._sidebarWidthPx = restoreSidebarWidth();
    const pct = widthPxToSplitPercent(this._sidebarWidthPx, contentAreaEl.clientWidth, SIDEBAR_GUTTER_SIZE);

    this._split = Split([sidebarEl, mainPaneEl], {
      // Percentage sizes, Split's own default calc() renderer — no custom
      // elementStyle (see design doc's Architecture section for why the
      // prior custom pixel-based renderer was removed).
      sizes: [pct, 100 - pct],
      minSize: [SIDEBAR_MIN_WIDTH, 0],       // main-pane keeps today's "no enforced minimum"
      maxSize: [SIDEBAR_MAX_WIDTH, Infinity],
      // Split defaults to a 30px snap zone around min/max. The removed
      // hand-rolled handler clamped only at the exact boundaries, so disable
      // snapping to retain smooth, pointer-tracking behavior until then.
      snapOffset: 0,
      gutterSize: SIDEBAR_GUTTER_SIZE,        // matches removed .resize-handle width
      gutter: () => {
        const g = document.createElement('div');
        g.className = 'sidebar-gutter'; // styled above to match old .resize-handle
        return g;
      },
      onDragStart: () => {
        this._dragging = true;
      },
      onDragEnd: () => {
        this._dragging = false;
        // Split's default percentage renderer may land 1/64px below an
        // integer pixel during a drag. Preserve the legacy integer-pixel
        // persistence contract, then apply the compensated percentage once
        // more so the rendered value matches the persisted integer exactly.
        this._sidebarWidthPx = Math.round(sidebarEl.getBoundingClientRect().width);
        const settledPct = widthPxToSplitPercent(
          this._sidebarWidthPx,
          contentAreaEl.clientWidth,
          SIDEBAR_GUTTER_SIZE,
        );
        this._split?.setSizes([settledPct, 100 - settledPct]);
        persistSidebarWidth(this._sidebarWidthPx);
      },
    });

    // Keep the sidebar's literal pixel width fixed across container resizes
    // — Split's percentage sizing is otherwise proportionally responsive to
    // .content-area's width, which today's implementation is not. Matches
    // today's exact fixed-until-next-drag behavior. Skipped mid-drag so it
    // doesn't fight the user's in-progress gesture.
    this._resizeObserver = new ResizeObserver(() => {
      if (!this._split || this._dragging) return;
      const newPct = widthPxToSplitPercent(this._sidebarWidthPx, contentAreaEl.clientWidth, SIDEBAR_GUTTER_SIZE);
      this._split.setSizes([newPct, 100 - newPct]);
    });
    this._resizeObserver.observe(contentAreaEl);
  }

  private _destroySplit(): void {
    if (this._dragging) {
      // Split.destroy() is not a drag-cancellation API — it does not remove
      // the global mousemove/mouseup/touchmove/touchend listeners
      // startDragging attached to `window`, nor reset the
      // user-select/pointer-events inline styles or document.body.style.cursor
      // it set (those are separate from the width styles destroy() does
      // reset). Force Split's own stopDragging cleanup to run first by
      // dispatching a synthetic mouseup.
      window.dispatchEvent(new MouseEvent('mouseup'));
    }
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._split?.destroy();
    this._split = null;
  }

  render() {
    // Exclude provisional overlay panes (negative IDs) from layout decisions.
    // They have no terminal and should not render as blank tiles.
    const panes = store.panes.filter((p) => p.paneId >= 0);
    const isWide = this._layoutMode === 'wide';

    return html`
      ${!isWide ? html`<mux-title-bar
        @launcher-action="${this._onLauncherAction}"
        @pane-select="${this._onActivePane}"
        @workspace-switch="${this._onWorkspaceSelected}"
        @pane-create-request="${this._createPaneOptimistic}"
        @voice-transcript="${this._onVoiceTranscript}"
      ></mux-title-bar>` : ''}
      <div class="content-area">
        ${isWide ? html`
          <mux-sidebar
            @workspace-switch="${this._onWorkspaceSelected}"
            @workspace-create="${this._onOpenCreateModal}"
            @workspace-rename="${this._onWorkspaceRename}"
            @workspace-close="${this._onSidebarWorkspaceClose}"
            @launcher-action="${this._onLauncherAction}"
          ></mux-sidebar>
        ` : ''}
        <div class="main-pane">
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
                  .narrow="${!isWide}"
                  @pane-select="${this._onActivePane}"
                  @pane-close="${this._onClosePane}"
                  @pane-create="${this._createPaneOptimistic}"
                  @pane-rename="${this._onPaneRename}"
                  @workspace-switch="${this._onWorkspaceSelected}"
                  @layout-save="${this._onLayoutSave}"
                ></mux-dock>
              `}
        </div>

      </div>

      <div class="undo-toast-stack" @pane-close-resolved="${this._onUndoPaneClose}">
        ${repeat(
          [...this._pendingClosesMeta.entries()],
          ([paneId]) => paneId,
          ([paneId, meta]) => html`
            <mux-undo-toast
              .paneId="${paneId}"
              .paneTitle="${meta.title}"
              .duration="${5000}"
            ></mux-undo-toast>
          `,
        )}
      </div>
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
      ${this._overlayPanel ? html`
        <div class="overlay-backdrop" @click="${this._closeOverlayPanel}">
          <div class="overlay-dialog" @click="${(e: Event) => e.stopPropagation()}">
            <div class="overlay-body">
              ${this._overlayPanel === 'settings' ? html`
                <mux-settings-surface
                  .config="${store.config}"
                  .aiStatus="${store.aiStatus}"
                  serverAddr="${window.location.host}"
                  @close="${this._closeOverlayPanel}"
                  @config-change="${this._onConfigChange}"
                  @ai-status-change="${this._onAIStatusChange}"
                ></mux-settings-surface>
              ` : this._overlayPanel === 'monitoring' ? html`
                <mux-monitoring-surface
                  @close="${this._closeOverlayPanel}"
                ></mux-monitoring-surface>
              ` : this._overlayPanel === 'shortcuts' ? html`
                <div class="info-panel">
                  <h2>Keyboard Shortcuts
                    <button class="close-btn" @click="${this._closeOverlayPanel}">×</button>
                  </h2>
                  <div class="shortcut-grid">
                    <span class="sc-label">New pane (any mode)</span>
                    <span class="sc-key">Cmd+Ctrl+T</span>
                    <span class="sc-label">Close pane</span>
                    <span class="sc-key">Cmd+W / Ctrl+W</span>
                    <span class="sc-label">Cycle tabs (forward)</span>
                    <span class="sc-key">Ctrl+Tab</span>
                    <span class="sc-label">Cycle tabs (backward)</span>
                    <span class="sc-key">Ctrl+Shift+Tab</span>
                    <span class="sc-label">Next session</span>
                    <span class="sc-key">${store.config.keys.nextSession}</span>
                    <span class="sc-label">Split pane</span>
                    <span class="sc-key">${store.config.keys.split}</span>
                    <span class="sc-label">Open launcher</span>
                    <span class="sc-key">${store.config.keys.openLauncher}</span>
                    <span class="sc-label">Focus driver</span>
                    <span class="sc-key">${store.config.keys.focusDriver}</span>
                  </div>
                </div>
              ` : html`
                <div class="info-panel">
                  <h2>About muxterm
                    <button class="close-btn" @click="${this._closeOverlayPanel}">×</button>
                  </h2>
                  <div class="about-body">
                    <p><strong>muxterm</strong> is a browser-based terminal multiplexer. It
                    connects to a <code>sessiond</code> daemon over WebSocket and renders
                    panes using xterm.js inside a dockview layout.</p>
                    <p>Config file: <strong>~/.config/muxterm/config.toml</strong></p>
                  </div>
                  <div class="about-sha">build ${__GIT_SHA__}</div>
                </div>
              `}
            </div>
          </div>
        </div>
      ` : ''}
      ${this._showReconnectOverlay
        ? html`<mux-reconnect-overlay
            message="${this._reconnectMessage}"
          ></mux-reconnect-overlay>`
        : ''}
      <!-- Phase 3: mux-workspace-picker (rename, close, retry/dismiss) will be re-introduced here -->
    `;
  }

  /** Client-local active-pane selection (sessiond has no select-pane message). */
  private _onActivePane = (e: CustomEvent<{ paneId: number }>): void => {
    // Auto-stop-and-invalidate: voice input should always target "the pane
    // I'm looking at right now" — see docs/designs/2026-07-31-voice-input-design.md.
    voiceInputController.invalidateIfActive({ workspaceId: store.attached ?? '', paneId: e.detail.paneId });
    // ackPane is the component's responsibility (mux-pane-picker._selectPane or
    // mux-dock onDidActivePanelChange). Do not ack here — the component already did.
    store.setActivePane(e.detail.paneId);
    // This pane just became the visible tab in this client's layout, so it
    // should claim PTY-sizing authority (active-view-wins).
    this._paneFocusCoordinator?.claimPane(e.detail.paneId);
  };

  /**
   * Deliver a dictated transcript to the terminal it was captured for.
   * Defense-in-depth only — by the time this fires, the primary invalidation
   * (pane/workspace-switch calling invalidateIfActive above) should already
   * have stopped any session whose target no longer matches. See
   * docs/designs/2026-07-31-voice-input-design.md's Data Flow section.
   */
  private _onVoiceTranscript = (e: CustomEvent<{ text: string; workspaceId: string; paneId: number }>): void => {
    const { text, workspaceId, paneId } = e.detail;
    if (workspaceId !== (store.attached ?? '') || paneId !== store.activePaneId) return;
    this._socket?.sendPaneInput(paneId, new TextEncoder().encode(text));
    // Tapping the mic button (a toolbar UI element) can take DOM focus away
    // from xterm's hidden textarea. Without this, the user's next physical
    // keystroke (Enter) might not reach the PTY at all.
    terminalRegistry.focus(paneId);
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

  /** Forward a layout-command from the server (via window CustomEvent) to the dock. */
  private _onLayoutCommand = (e: Event): void => {
    const msg = (e as CustomEvent<LayoutCommand>).detail;
    this._dock?.handleLayoutCommand(msg);
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
      applyChromeTokens(cfg.theme.palette);
      configureTerminals(cfg); // future Terminals pick up font/cursor/scrollback/palette
      disposeKeys?.();
      disposeKeys = installKeybindings(uiActions);
    }
    // {"aiStatus":...} envelope (no "type" field, by design -- see sendAIStatus
    // in ws.go): a key was saved or cleared in this or another tab. Carries the
    // derived status only -- never the key.
    if ('aiStatus' in msg) {
      store.setAIStatus(parseAIStatus(msg['aiStatus']));
    }
  };

  // Phase 3: _onOpenWorkspacePicker will be re-introduced here for workspace management UI.

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
   * Handle workspace-close from the sidebar: starts a 10-second grace period
   * (mirroring pane-close undo) keyed by a negative virtual ID so the undo
   * toast machinery can handle it uniformly.
   */
  private _onSidebarWorkspaceClose = (e: CustomEvent<{ workspaceId: string; name: string }>): void => {
    const { workspaceId: wsId, name } = e.detail;
    // Guard duplicate: if this workspace already has a pending close, skip.
    for (const entry of this._pendingWorkspaceCloses.values()) {
      if (entry.wsId === wsId) return;
    }
    const vid = this._wsVirtualId--;
    const timer = setTimeout(() => this._executeWorkspaceClose(vid), 5_000);
    this._pendingWorkspaceCloses.set(vid, { timer, wsId, name });
    this._pendingClosesMeta.set(vid, { title: name });
    this.requestUpdate();
  };

  /** Actually close the workspace after the grace period expires. */
  private _executeWorkspaceClose(vid: number): void {
    const entry = this._pendingWorkspaceCloses.get(vid);
    if (!entry) return;
    this._pendingWorkspaceCloses.delete(vid);
    this._pendingClosesMeta.delete(vid);
    this._socket?.closeWorkspace(entry.wsId);
    this.requestUpdate();
  }

  /**
   * Switch the attached workspace. The daemon's composition reply re-populates
   * the store, which triggers _syncTerminals() to call setWorkspace() with the
   * new ID — isolating pane terminals via composite keys so scrollback from
   * the previous workspace survives for when we switch back.
   */
  private _onWorkspaceSelected = (e: CustomEvent<{ workspaceId: string }>): void => {
    if (e.detail.workspaceId === store.attached) return;
    // Workspace switches are asynchronous (new pane list/active pane arrive
    // only after a round-trip), so there is no new-workspace pane identity to
    // compare against yet — invalidate unconditionally. See
    // docs/designs/2026-07-31-voice-input-design.md.
    voiceInputController.invalidateIfActive();
    // _pendingCloses: grace period only — closePane was never sent, PTY survives on server.
    for (const handle of this._pendingCloses.values()) clearTimeout(handle);
    this._pendingCloses.clear();
    this._pendingClosesMeta.clear();
    // _closingPanes: closePane was already sent, PTY is dying. Call allowReconcile so the
    // reconciler doesn't recreate phantom terminals for panes whose close is in-flight.
    this._dock?.allowReconcile([...this._closingPanes]);
    this._closingPanes.clear();
    this.requestUpdate();
    // Do NOT call disposeAll() — workspace-scoped composite keys in
    // terminalRegistry isolate paneIds across workspaces, so old terminals
    // stay alive with their scrollback until explicitly pruned or disposed.
    this._socket?.attachWithBreakpoint(e.detail.workspaceId, currentLayoutMode());
  };

  /** The live <mux-dock> element in our shadow root, or null when absent. */
  private get _dock(): MuxDock | null {
    return (this.renderRoot as ShadowRoot).querySelector('mux-dock');
  }

  /** The live <mux-sidebar> element in our shadow root, or null when absent. */
  private get _sidebar(): MuxSidebar | null {
    return (this.renderRoot as ShadowRoot).querySelector('mux-sidebar');
  }

  /**
   * Handle a pane-close event from mux-dock. All closes (mouse, touch, pen)
   * are deferred for 10s with an undo toast so accidental closes are
   * recoverable regardless of input device (see _startDeferredClose).
   * Note: e.detail.touch is available for future per-input-type behaviour.
   */
  private _onClosePane = (e: CustomEvent<{ paneId: number; touch: boolean; title: string }>): void => {
    this._startDeferredClose(e.detail.paneId, e.detail.title);
  };

  /** Begin a 5-second grace period before committing a pane close. */
  private _startDeferredClose(paneId: number, title: string): void {
    // Guard: if a timer already exists for this pane, clear it before replacing.
    const existing = this._pendingCloses.get(paneId);
    if (existing !== undefined) clearTimeout(existing);
    const handle = setTimeout(() => this._executeClose(paneId), 5_000);
    this._pendingCloses.set(paneId, handle);
    this._pendingClosesMeta.set(paneId, { title });
    this.requestUpdate();
  }

  /** Perform the actual kill: tell the server, prune the terminal, and clear bookkeeping. */
  private _executeClose(paneId: number): void {
    // Guard: if no pending close exists for this pane, it was already cancelled
    // (e.g. via undo) — do nothing. This makes the method truly idempotent.
    if (!this._pendingCloses.has(paneId)) return;
    // Cancel the pending handle whether called by the timer itself or directly
    // (e.g. __muxForceExpire DEV seam). clearTimeout on an already-fired handle
    // is a no-op, so the normal timer-driven path is unaffected.
    const handle = this._pendingCloses.get(paneId);
    if (handle !== undefined) clearTimeout(handle);

    this._socket?.closePane(paneId);
    const remaining = new Set(
      store.panes
        .filter((p) => p.paneId >= 0 && p.paneId !== paneId)
        .map((p) => p.paneId),
    );
    terminalRegistry.prune(remaining);
    this._pendingCloses.delete(paneId);
    this._pendingClosesMeta.delete(paneId);
    this._closingPanes.add(paneId); // prevent _syncTerminals from recreating the terminal
    this.requestUpdate();
  }

  /** Undo a pending close: cancel the timer, clear bookkeeping, reopen the pane or workspace. */
  private _onUndoPaneClose = (e: CustomEvent<{ paneId: number }>): void => {
    const { paneId } = e.detail;
    // Check if this is a workspace close undo first (negative virtual IDs).
    if (this._pendingWorkspaceCloses.has(paneId)) {
      const entry = this._pendingWorkspaceCloses.get(paneId)!;
      clearTimeout(entry.timer);
      this._pendingWorkspaceCloses.delete(paneId);
      this._pendingClosesMeta.delete(paneId);
      this._sidebar?.restoreWorkspace(entry.wsId);
      this.requestUpdate();
      return;
    }
    // If the grace period already expired and _executeClose committed the close,
    // undo is no longer possible — the close was sent to the server.
    if (this._closingPanes.has(paneId)) return;
    const handle = this._pendingCloses.get(paneId);
    if (handle !== undefined) clearTimeout(handle);
    this._pendingCloses.delete(paneId);
    this._pendingClosesMeta.delete(paneId);
    this._dock?.reopenPane(paneId);
    this.requestUpdate();
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

  private _onLauncherAction = (e: Event): void => {
    const action = (e as CustomEvent<{ action: LauncherAction }>).detail?.action;
    switch (action) {
      case 'settings':
      case 'shortcuts':
      case 'about':
      case 'monitoring':
        this._overlayPanel = action;
        break;
      case 'reconnect':
        window.location.reload();
        break;
      case 'new-workspace':
        this._onOpenCreateModal();
        break;
    }
  };

  private _closeOverlayPanel = (): void => {
    this._overlayPanel = null;
  };

  /**
   * Apply a config change from the settings surface: update the store, then
   * re-apply all three subsystems that read from config.
   *   • theme tokens  — immediate (CSS vars)
   *   • terminal config — affects new panes only (no hot-reload in v1)
   *   • keybindings  — immediate (reinstalls the global keydown handler)
   */
  private _onConfigChange = (e: Event): void => {
    const cfg = (e as CustomEvent<{ config: ResolvedConfig }>).detail?.config;
    if (!cfg) return;
    store.setConfig(cfg);
    applyThemeTokens(resolvePalette(cfg.theme.palette));
    applyChromeTokens(cfg.theme.palette);
    configureTerminals(cfg);
    disposeKeys?.();
    disposeKeys = installKeybindings(uiActions);
    // Persist the change: debounced PATCH /api/config → server merges,
    // writes to disk, and broadcasts to all connected clients.
    patchConfig(configToGoJSON(cfg));
  };

  /** Mirrors _onConfigChange's style: settings surface emits the new AI
   *  status after a save/clear round-trip; push it straight into the store
   *  (no debounced persistence here — the settings surface already made the
   *  HTTP call that changed server-side state). */
  private _onAIStatusChange = (e: Event): void => {
    const { status } = (e as CustomEvent<{ status: AIStatus }>).detail;
    store.setAIStatus(status);
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

  // Touch-close-undo E2E seams -------------------------------------------
  const _app = (): MuxApp | null => document.querySelector('mux-app');

  (window as unknown as Record<string, unknown>)['__muxPendingCloses'] = (): number[] => {
    const app = _app() as unknown as { _pendingCloses?: Map<number, unknown> } | null;
    return app?._pendingCloses ? [...app._pendingCloses.keys()] : [];
  };

  (window as unknown as Record<string, unknown>)['__muxUndoClose'] = (paneId: number): void => {
    const app = _app() as unknown as { _onUndoPaneClose?: (e: CustomEvent<{ paneId: number }>) => void } | null;
    app?._onUndoPaneClose?.(new CustomEvent('pane-close-resolved', { detail: { paneId } }) as CustomEvent<{ paneId: number }>);
  };

  (window as unknown as Record<string, unknown>)['__muxForceExpire'] = (paneId: number): void => {
    const app = _app() as unknown as { _executeClose?: (id: number) => void } | null;
    app?._executeClose?.(paneId);
  };

  (window as unknown as Record<string, unknown>)['__muxCloseButtonFor'] = (paneId: number): Element | null => {
    const dock = _app()?.shadowRoot?.querySelector('mux-dock');
    if (!dock) return null;
    const tabs = [...dock.querySelectorAll('.dv-tab')];
    const dockAny = dock as unknown as { _panels?: Map<number, unknown> };
    const ids = dockAny._panels ? [...dockAny._panels.keys()] : [];
    const idx = ids.indexOf(paneId);
    if (idx < 0) return null;
    const tab = tabs[idx];
    return tab?.querySelector('.dv-default-tab-action') ?? null;
  };
}
