import type {
  ServerMessage,
  TmuxState,
  SessionInfo,
  SessiondMessage,
  SessiondWorkspaceInfo,
  SessiondPaneInfo,
} from './types';
import { SessiondType } from './types';
import type { Composition } from './lib/layout.js';
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from './lib/config.js';

export function createInitialState(): TmuxState {
  return {
    sessions: [],
    activeSession: '',
    activeWindow: 0,
    activePane: 0,
  };
}

export class MuxStore {
  private _state: TmuxState = createInitialState();
  private _sessionList: SessionInfo[] = [];
  private _listeners: Set<() => void> = new Set();
  private _config: ResolvedConfig = DEFAULT_RESOLVED_CONFIG;

  // --- Phase-4 sessiond multiplexer path ------------------------------------
  // Frozen wire state for the sessiond control protocol, kept parallel to and
  // independent of the legacy tmux applyMessage path above. A pure Composition
  // is projected from _panes for the layout engine.
  private _workspaces: SessiondWorkspaceInfo[] = [];
  private _attached: string | null = null;
  private _panes: SessiondPaneInfo[] = [];
  private _activePaneId = 0;

  get state(): TmuxState {
    return this._state;
  }

  get sessionList(): SessionInfo[] {
    return this._sessionList;
  }

  get config(): ResolvedConfig {
    return this._config;
  }

  setConfig(cfg: ResolvedConfig): void {
    this._config = cfg;
    this._notify();
  }

  get workspaces(): SessiondWorkspaceInfo[] {
    return this._workspaces;
  }

  get attached(): string | null {
    return this._attached;
  }

  get panes(): SessiondPaneInfo[] {
    return this._panes;
  }

  // Pure device-independent projection of the frozen PaneInfo[] for the layout
  // engine. Keeps lib/layout.ts free of wire types.
  get composition(): Composition {
    return {
      paneIds: this._panes.map((p) => p.paneId),
      activePaneId: this._activePaneId,
    };
  }

  setActivePane(paneId: number): void {
    if (this._activePaneId === paneId) return;
    this._activePaneId = paneId;
    this._notify();
  }

  // Phase-4 multiplexer path: apply a sessiond control-protocol message. This is
  // deliberately separate from the legacy tmux applyMessage path. Workspace and
  // composition state are reconciled idempotently so actor + broadcast echoes of
  // the same event converge to one truth.
  applySessiond(msg: SessiondMessage): void {
    switch (msg.type) {
      case SessiondType.WorkspaceList:
        this._workspaces = msg.workspaces ?? [];
        break;

      // composition reply: binds us to a workspace and replaces panes wholesale.
      case SessiondType.Composition: {
        this._attached = msg.workspaceId ?? null;
        this._panes = [...(msg.panes ?? [])];
        this._activePaneId = this._panes[0]?.paneId ?? 0;
        break;
      }

      case SessiondType.PaneAdded: {
        if (this._attached === null) break;
        const paneId = msg.paneId ?? 0;
        // Idempotent: actor and broadcast both deliver this event.
        if (this._panes.some((p) => p.paneId === paneId)) break;
        this._panes.push({
          paneId,
          cols: msg.cols ?? 0,
          rows: msg.rows ?? 0,
          title: msg.title,
        });
        break;
      }

      case SessiondType.PaneClosed: {
        // Ignore trailing pane-closed after we've detached (workspace-closed).
        if (this._attached === null) break;
        const paneId = msg.paneId ?? 0;
        this._panes = this._panes.filter((p) => p.paneId !== paneId);
        if (this._activePaneId === paneId) {
          this._activePaneId = this._panes[0]?.paneId ?? 0;
        }
        break;
      }

      case SessiondType.WorkspaceClosed: {
        const workspaceId = msg.workspaceId ?? null;
        this._workspaces = this._workspaces.filter(
          (w) => w.workspaceId !== workspaceId,
        );
        if (this._attached === workspaceId) {
          this._attached = null;
          this._panes = [];
          this._activePaneId = 0;
        }
        break;
      }

      case SessiondType.WorkspaceRenamed: {
        const ws = this._workspaces.find((w) => w.workspaceId === msg.workspaceId);
        if (ws) {
          ws.name = msg.name ? msg.name : undefined;
        }
        break;
      }

      default:
        return; // unhandled type: no state change, no notify
    }
    this._notify();
  }

  subscribe(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  applyMessage(msg: ServerMessage): void {
    switch (msg.type) {
      // full-sync: on-connect / reconnect — full replace.
      // Terminal instances will be reset by app.ts before new content arrives.
      case 'full-sync':
        this._state = msg.data;
        break;

      // state: authoritative structure snapshot. The server pushes this on EVERY
      // structural change (window add/close/rename, layout change, session/active
      // change) — coalesced — and also every 5s as a safety net. We reconcile
      // idempotently against it, so the browser always converges to tmux truth.
      //
      // This is the ONLY path that mutates structure. There are deliberately no
      // incremental window-add/window-close/layout-change handlers: applying
      // partial deltas in order, without duplication, is the exact fragility
      // that caused blank tabs, duplicate tabs, and lost windows. Full snapshots
      // make that whole bug class impossible.
      case 'state':
        if (this._state.sessions.length === 0) {
          this._state = msg.data; // nothing to preserve yet
        } else {
          this._reconcileFromTmux(msg.data);
        }
        break;

      case 'session-list':
        this._sessionList = msg.data.sessions;
        break;

      case 'window-add': {
        const session = this._state.sessions.find(
          (s) => s.name === this._state.activeSession,
        );
        if (session) {
          session.windows.push(msg.data);
        }
        break;
      }

      case 'window-renamed': {
        for (const s of this._state.sessions) {
          const win = s.windows.find((w) => w.id === msg.data.id);
          if (win) {
            win.name = msg.data.name;
            break;
          }
        }
        break;
      }

      case 'window-close': {
        for (const s of this._state.sessions) {
          const idx = s.windows.findIndex((w) => w.id === msg.data.id);
          if (idx !== -1) {
            s.windows.splice(idx, 1);
            break;
          }
        }
        break;
      }

      case 'layout-change': {
        for (const s of this._state.sessions) {
          const win = s.windows.find((w) => w.id === msg.data.windowId);
          if (win) {
            win.layout = msg.data.layout;
            break;
          }
        }
        break;
      }

      case 'session-window-changed':
        this._state.activeWindow = msg.data.windowId;
        break;

      case 'detached':
        break;

      case 'error':
        console.warn(msg.data.message);
        return; // don't notify
    }
    this._notify();
  }

  // Reconcile browser state against a fresh tmux state snapshot without destroying
  // existing wterm terminal instances. Since tmux is the source of truth:
  //   — remove windows that no longer exist in tmux (fixes stale tabs)
  //   — add windows that appeared since last sync
  //   — update metadata (name, layout, panes) on existing windows
  private _reconcileFromTmux(incoming: TmuxState): void {
    this._state.activeSession = incoming.activeSession;
    this._state.activeWindow = incoming.activeWindow;
    this._state.activePane = incoming.activePane;

    const incomingNames = new Set(incoming.sessions.map((s) => s.name));
    this._state.sessions = this._state.sessions.filter((s) => incomingNames.has(s.name));

    for (const inc of incoming.sessions) {
      const existing = this._state.sessions.find((s) => s.name === inc.name);
      if (!existing) {
        this._state.sessions.push(inc);
        continue;
      }
      const incomingIds = new Set(inc.windows.map((w) => w.id));
      existing.windows = existing.windows.filter((w) => incomingIds.has(w.id));
      for (const incWin of inc.windows) {
        const existingWin = existing.windows.find((w) => w.id === incWin.id);
        if (!existingWin) {
          existing.windows.push(incWin);
        } else {
          existingWin.name = incWin.name;
          existingWin.layout = incWin.layout;
          existingWin.panes = incWin.panes;
        }
      }
    }
  }

  private _notify(): void {
    for (const cb of this._listeners) {
      cb();
    }
  }
}

export const store = new MuxStore();