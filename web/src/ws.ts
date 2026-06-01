import type { ClientMessage, ServerMessage, TmuxState, Window, Pane, Session } from './types';
import type { MuxStore } from './state';

export type PaneOutputCallback = (paneId: number, data: Uint8Array) => void;
export type ControlMessageCallback = (msg: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// Server-side JSON shapes (Go struct field names, string tmux IDs)
// ---------------------------------------------------------------------------

interface ServerPane {
  id: string;       // "%76"
  width: number;
  height: number;
  active: boolean;
}

interface ServerWindow {
  id: string;       // "@69"
  name: string;
  layout: string;
  active: boolean;
  panes: ServerPane[];
}

interface ServerSession {
  id: string;       // "$69"
  name: string;
  windows: ServerWindow[];
}

interface ServerTmuxState {
  sessions: ServerSession[];
  activeSessionId: string;   // "$69"
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a tmux prefixed ID string to a plain number.
 * "@69" → 69, "%76" → 76, "$3" → 3.
 */
function parseTmuxId(id: string): number {
  if (!id || id.length < 2) return 0;
  const n = parseInt(id.slice(1), 10);
  return Number.isNaN(n) ? 0 : n;
}

function normalizePane(p: ServerPane): Pane {
  return { id: parseTmuxId(p.id), width: p.width, height: p.height, active: p.active };
}

function normalizeWindow(w: ServerWindow): Window {
  return {
    id: parseTmuxId(w.id),
    name: w.name,
    layout: w.layout,
    panes: (w.panes ?? []).map(normalizePane),
  };
}

function normalizeSession(s: ServerSession): Session {
  return { name: s.name, windows: (s.windows ?? []).map(normalizeWindow) };
}

/**
 * Convert the server's key-value message envelope  {"msgType": payload}
 * into the frontend's tagged-union format  { type, data }.
 *
 * The server encodes messages as { [eventType]: payload } where payload is
 * the raw Go-struct JSON (PascalCase fields, string tmux IDs).  The frontend
 * store.applyMessage() expects { type: string; data: ... } with camelCase
 * numeric IDs.  This function bridges the gap.
 */
export function normalizeMessage(raw: Record<string, unknown>): ServerMessage | null {
  const keys = Object.keys(raw);
  if (keys.length === 0) return null;
  const type = keys[0];
  const payload = raw[type];

  switch (type) {
    // "full-sync" arrives on initial connect / reconnect — full replace + terminal reset.
    // "state"     arrives on periodic 5-second push   — structural reconciliation only.
    case 'full-sync':
    case 'state': {
      const s = payload as ServerTmuxState;
      if (!s || !Array.isArray(s.sessions)) return null;

      const activeSessionObj = s.sessions.find((sess) => sess.id === s.activeSessionId);
      const activeSessionName = activeSessionObj?.name ?? '';
      const activeWindowObj = activeSessionObj?.windows?.find((w) => w.active);
      const activeWindow = activeWindowObj ? parseTmuxId(activeWindowObj.id) : 0;
      const activePaneObj =
        activeWindowObj?.panes?.find((p) => p.active) ?? activeWindowObj?.panes?.[0];
      const activePane = activePaneObj ? parseTmuxId(activePaneObj.id) : 0;

      const data: TmuxState = {
        sessions: s.sessions.map(normalizeSession),
        activeSession: activeSessionName,
        activeWindow,
        activePane,
      };
      // Preserve the original type so state.ts can distinguish full-sync from periodic state.
      return { type: type as 'full-sync' | 'state', data };
    }

    case 'session-changed': {
      // Go: SessionChangedEvent { SessionID, Name }
      const e = payload as { Name?: string };
      return { type: 'session-changed', data: { name: e?.Name ?? '' } };
    }

    case 'window-add': {
      // Go: WindowAddEvent { WindowID }
      const e = payload as { WindowID?: string };
      return {
        type: 'window-add',
        data: { id: parseTmuxId(e?.WindowID ?? ''), name: '', panes: [], layout: '' },
      };
    }

    case 'window-renamed': {
      // Go: WindowRenamedEvent { WindowID, Name }
      const e = payload as { WindowID?: string; Name?: string };
      return {
        type: 'window-renamed',
        data: { id: parseTmuxId(e?.WindowID ?? ''), name: e?.Name ?? '' },
      };
    }

    case 'window-close': {
      // Go: WindowCloseEvent { WindowID }
      const e = payload as { WindowID?: string };
      return { type: 'window-close', data: { id: parseTmuxId(e?.WindowID ?? '') } };
    }

    case 'layout-change': {
      // Go: LayoutChangeEvent { WindowID, Layout, VisibleLayout, Flags }
      const e = payload as { WindowID?: string; Layout?: string };
      return {
        type: 'layout-change',
        data: { windowId: parseTmuxId(e?.WindowID ?? ''), layout: e?.Layout ?? '' },
      };
    }

    case 'session-window-changed': {
      // Go: SessionWindowChangedEvent { SessionID, WindowID }
      const e = payload as { WindowID?: string };
      return {
        type: 'session-window-changed',
        data: { windowId: parseTmuxId(e?.WindowID ?? '') },
      };
    }

    case 'pane-mode': {
      // Go: PaneModeChangedEvent { PaneID }
      const e = payload as { PaneID?: string };
      return {
        type: 'pane-mode',
        data: { paneId: parseTmuxId(e?.PaneID ?? ''), mode: '' },
      };
    }

    case 'session-list': {
      const e = payload as { sessions?: { name: string; windows: number }[] };
      return { type: 'session-list', data: { sessions: e?.sessions ?? [] } };
    }

    case 'detached': {
      const e = payload as { reason?: string } | null | undefined;
      return { type: 'detached', data: { reason: (e as { reason?: string })?.reason ?? 'disconnected' } };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Client → Server encoding
// ---------------------------------------------------------------------------

/**
 * Convert from the frontend's {type, ...fields} ClientMessage format into the
 * server's {actionKey: payload} format that dispatchAction expects.
 *
 * Window IDs are prefixed "@", pane IDs are prefixed "%" to match the tmux
 * ID format that the Go server passes directly to tmux commands.
 */
export function encodeClientMessage(msg: ClientMessage): Record<string, unknown> {
  switch (msg.type) {
    case 'select-window':
      return { 'select-window': `@${msg.windowId}` };
    case 'select-pane':
      return { 'select-pane': `%${msg.paneId}` };
    case 'split':
      return { split: { direction: msg.direction, pane: `%${msg.paneId}` } };
    case 'resize-pane':
      return { 'resize-pane': { id: `%${msg.paneId}`, dir: msg.dir, amount: msg.amount } };
    case 'new-window':
      return { 'new-window': '' };
    case 'close-pane':
      return { 'close-pane': `%${msg.paneId}` };
    case 'close-window':
      return { 'close-window': `@${msg.windowId}` };
    case 'rename-window':
      return { 'rename-window': { id: `@${msg.windowId}`, name: msg.name } };
    case 'create-session':
      return { 'create-session': { name: msg.name } };
    case 'attach-session':
      return { 'attach-session': msg.name };
    case 'resize-surface':
      return { 'resize-surface': { surfaceId: msg.surfaceId, cols: msg.cols, rows: msg.rows } };
    case 'request-sync':
      return { 'request-sync': {} };
    default:
      // Fallthrough: pass as-is (forward compatibility)
      return msg as unknown as Record<string, unknown>;
  }
}

const BACKOFF_BASE = 1000;
const BACKOFF_CAP = 30000;
const JITTER_MAX = 500;

export class MuxSocket {
  private _store: MuxStore;
  private _url: string;
  private _ws: WebSocket | null = null;
  private _paneOutputCb: PaneOutputCallback | null = null;
  private _controlMessageCb: ControlMessageCallback | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _reconnectAttempts = 0;
  private _intentionalClose = false;

  onDisconnect: (() => void) | null = null;
  onReconnect: (() => void) | null = null;

  constructor(store: MuxStore, url: string) {
    this._store = store;
    this._url = url;
  }

  onPaneOutput(cb: PaneOutputCallback): void {
    this._paneOutputCb = cb;
  }

  onControlMessage(cb: ControlMessageCallback): void {
    this._controlMessageCb = cb;
  }

  connect(): void {
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._open();
  }

  disconnect(): void {
    this._intentionalClose = true;
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  sendPaneInput(paneId: number, data: Uint8Array): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      const buf = new ArrayBuffer(4 + data.length);
      const view = new DataView(buf);
      view.setUint32(0, paneId, true); // little-endian
      new Uint8Array(buf, 4).set(data);
      this._ws.send(buf);
    }
  }

  sendControl(msg: ClientMessage): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(encodeClientMessage(msg)));
    }
  }

  destroy(): void {
    this._intentionalClose = true;
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    if (this._ws) {
      this._ws.close(1000);
      this._ws = null;
    }
  }

  get connected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  private _scheduleReconnect(): void {
    const delay = Math.min(BACKOFF_BASE * 2 ** this._reconnectAttempts, BACKOFF_CAP);
    const jitter = Math.random() * JITTER_MAX;
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => this._open(), delay + jitter);
  }

  private _open(): void {
    const ws = new WebSocket(this._url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      this._reconnectAttempts = 0;
      this.onReconnect?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        if (ev.data.byteLength >= 4) {
          const view = new DataView(ev.data);
          const paneId = view.getUint32(0, true); // little-endian
          const data = new Uint8Array(ev.data, 4);
          this._paneOutputCb?.(paneId, data);
        }
        return;
      }
      // Text frame — JSON control message
      if (typeof ev.data === 'string') {
        const raw = JSON.parse(ev.data) as Record<string, unknown>;
        // Pass the raw message to control handlers (e.g. for detached/session-picker)
        this._controlMessageCb?.(raw);
        // Normalize from server key-value format to frontend typed message format
        const msg = normalizeMessage(raw);
        if (msg) {
          this._store.applyMessage(msg);
        }
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      if (ev.code === 1000 || this._intentionalClose) {
        return;
      }
      this.onDisconnect?.();
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // no-op — onclose fires after onerror
    };
  }
}

export function buildWsUrl(path = '/ws'): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}