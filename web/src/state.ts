import type { ServerMessage, TmuxState, SessionInfo } from './types';

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

  get state(): TmuxState {
    return this._state;
  }

  get sessionList(): SessionInfo[] {
    return this._sessionList;
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