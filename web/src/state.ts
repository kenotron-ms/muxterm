import type { ServerMessage, Session, TmuxState, Window } from './types';

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
  private _listeners: Set<() => void> = new Set();

  get state(): TmuxState {
    return this._state;
  }

  subscribe(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  applyMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'state':
        this._state = msg.data;
        break;

      case 'window-add': {
        const session = this._findActiveSession();
        if (session) {
          session.windows.push(msg.data);
        }
        break;
      }

      case 'window-renamed': {
        const win = this._findWindow(msg.data.id);
        if (win) {
          win.name = msg.data.name;
        }
        break;
      }

      case 'window-close': {
        const session = this._findActiveSession();
        if (session) {
          session.windows = session.windows.filter((w) => w.id !== msg.data.id);
        }
        break;
      }

      case 'layout-change': {
        const win = this._findWindow(msg.data.windowId);
        if (win) {
          win.layout = msg.data.layout;
        }
        break;
      }

      case 'session-changed':
        this._state.activeSession = msg.data.name;
        break;

      case 'session-window-changed':
        this._state.activeWindow = msg.data.windowId;
        break;

      case 'pane-mode':
        break;

      case 'detached':
        break;

      case 'error':
        console.warn(msg.data.message);
        return; // don't notify
    }
    this._notify();
  }

  private _findActiveSession(): Session | undefined {
    return this._state.sessions.find((s) => s.name === this._state.activeSession);
  }

  private _findWindow(id: number): Window | undefined {
    for (const session of this._state.sessions) {
      const win = session.windows.find((w) => w.id === id);
      if (win) return win;
    }
    return undefined;
  }

  private _notify(): void {
    for (const cb of this._listeners) {
      cb();
    }
  }
}

export const store = new MuxStore();