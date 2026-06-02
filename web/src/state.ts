import type {
  SessiondMessage,
  SessiondWorkspaceInfo,
  SessiondPaneInfo,
} from './types';
import { SessiondType } from './types';
import type { Composition } from './lib/layout.js';
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from './lib/config.js';

export class MuxStore {
  private _listeners: Set<() => void> = new Set();
  private _config: ResolvedConfig = DEFAULT_RESOLVED_CONFIG;

  // --- sessiond multiplexer path --------------------------------------------
  // Frozen wire state for the sessiond control protocol. A pure Composition is
  // projected from _panes for the layout engine.
  private _workspaces: SessiondWorkspaceInfo[] = [];
  private _attached: string | null = null;
  private _panes: SessiondPaneInfo[] = [];
  private _activePaneId = 0;

  get config(): ResolvedConfig {
    return this._config;
  }

  setConfig(cfg: ResolvedConfig): void {
    this._config = cfg;
    this._notify();
  }

  get workspaces(): SessiondWorkspaceInfo[] {
    // Return fresh shallow copies so callers cannot mutate the authoritative
    // base array or its entries in place.
    return this._workspaces.map((w) => ({ ...w }));
  }

  get attached(): string | null {
    return this._attached;
  }

  get panes(): SessiondPaneInfo[] {
    // Return fresh shallow copies so callers cannot mutate the authoritative
    // base array or its entries in place.
    return this._panes.map((p) => ({ ...p }));
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

  // Apply a sessiond control-protocol message. Workspace and composition state
  // are reconciled idempotently so actor + broadcast echoes of the same event
  // converge to one truth.
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

  private _notify(): void {
    for (const cb of this._listeners) {
      cb();
    }
  }
}

export const store = new MuxStore();