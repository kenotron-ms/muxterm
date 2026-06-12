import { SessiondType, encodePaneFrame, decodePaneFrame, type SessiondMessage } from './types';
import type { MuxStore } from './state';

export type PaneOutputCallback = (paneId: number, data: Uint8Array) => void;
export type ControlMessageCallback = (msg: Record<string, unknown>) => void;

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
  onSessiondMessage: ((msg: SessiondMessage) => void) | null = null;

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
      this._ws.send(encodePaneFrame(paneId, data));
    }
  }

  // --- sessiond v1 control senders -----------------------------------------
  // All senders emit the FLAT SessiondMessage envelope (no single-key
  // wrapping) and consume the frozen SessiondType vocabulary, never raw
  // strings.

  /** Send one flat sessiond control message if the socket is open. */
  private sendSessiond(msg: SessiondMessage): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  /** Attach this connection to a workspace. */
  attach(workspaceId: string): void {
    this.sendSessiond({ type: SessiondType.Attach, workspaceId });
  }

  /** Attach, telling the daemon our responsive breakpoint so it returns the
   *  matching saved layout in the composition reply. */
  attachWithBreakpoint(workspaceId: string, breakpoint: string): void {
    this.sendSessiond({ type: SessiondType.Attach, workspaceId, breakpoint });
  }

  renamePane(paneId: number, name: string): void {
    this.sendSessiond({ type: SessiondType.RenamePane, paneId, name });
  }

  saveLayout(workspaceId: string, breakpoint: string, layout: string): void {
    this.sendSessiond({ type: SessiondType.SaveLayout, workspaceId, breakpoint, layout });
  }

  /** Send a browser-action-result envelope back to the server. */
  sendBrowserActionResult(detail: Record<string, unknown>): void {
    this.sendSessiond({ type: SessiondType.BrowserActionResult, ...detail } as unknown as SessiondMessage);
  }

  /** Request the list of workspaces. */
  listWorkspaces(): void {
    this.sendSessiond({ type: SessiondType.ListWorkspaces });
  }

  /**
   * Create a new workspace; name and clientRef are each included only when
   * truthy.
   */
  createWorkspace(name?: string, clientRef?: string): void {
    const msg: SessiondMessage = { type: SessiondType.CreateWorkspace };
    if (name) msg.name = name;
    if (clientRef) msg.clientRef = clientRef;
    this.sendSessiond(msg);
  }

  /** Rename an existing workspace. */
  renameWorkspace(workspaceId: string, name: string): void {
    this.sendSessiond({ type: SessiondType.RenameWorkspace, workspaceId, name });
  }

  /** Close a workspace. */
  closeWorkspace(workspaceId: string): void {
    this.sendSessiond({ type: SessiondType.CloseWorkspace, workspaceId });
  }

  /**
   * Create a connection-scoped pane (NO workspaceId). cmd is included only
   * when it carries at least one argument. clientRef is included only when
   * truthy.
   */
  createPane(cmd?: string[], clientRef?: string): void {
    const msg: SessiondMessage = { type: SessiondType.CreatePane };
    if (cmd && cmd.length > 0) msg.cmd = cmd;
    if (clientRef) msg.clientRef = clientRef;
    this.sendSessiond(msg);
  }

  /** Create a browser-surface pane. path defaults to '/' when falsy. */
  createBrowserPane(port: number, path: string = '/', clientRef?: string): void {
    const msg: SessiondMessage = {
      type: SessiondType.CreatePane,
      surfaceKind: 'browser',
      browserPort: port,
      browserPath: path || '/',
    };
    if (clientRef) msg.clientRef = clientRef;
    this.sendSessiond(msg);
  }

  /** Update the browser path for an existing browser pane. */
  updatePanePath(paneId: number, browserPath: string): void {
    this.sendSessiond({ type: SessiondType.PaneUpdate, paneId, browserPath });
  }

  /** Kill the pane's PTY on the server side. The server broadcasts pane-closed
   *  to all subscribers; the client prunes the terminal on receipt. */
  closePane(paneId: number): void {
    this.sendSessiond({ type: SessiondType.ClosePane, paneId });
  }

  /**
   * Report a pane's measured rendered grid (active-view-wins by construction:
   * only visible panes own a live ResizeObserver, so tabbed-away panes never
   * call resize).
   */
  resize(paneId: number, cols: number, rows: number): void {
    this.sendSessiond({ type: SessiondType.Resize, paneId, cols, rows });
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
      // Binary pane-data frame: [4-byte LE paneId][raw bytes].
      if (ev.data instanceof ArrayBuffer) {
        if (ev.data.byteLength >= 4) {
          const { paneId, data } = decodePaneFrame(ev.data);
          this._paneOutputCb?.(paneId, data);
        }
        return;
      }
      // Text frame — JSON control message
      if (typeof ev.data === 'string') {
        const raw = JSON.parse(ev.data) as Record<string, unknown>;
        // Pass the raw message to control handlers (e.g. for detached/session-picker).
        // Non-typed envelopes (e.g. serve config) still flow through here.
        this._controlMessageCb?.(raw);
        // Flat sessiond messages carry a top-level "type" string; route them to
        // the sessiond hook. (Legacy single-key envelopes have no "type" field,
        // so the two paths never collide.)
        if (typeof raw.type === 'string') {
          this.onSessiondMessage?.(raw as unknown as SessiondMessage);
          // Relay-only types: dispatch as window CustomEvents so app.ts and
          // mux-dock can handle them without coupling to the socket directly.
          if (raw.type === SessiondType.BrowserAction) {
            window.dispatchEvent(new CustomEvent('browser-action', { detail: raw }));
          } else if (raw.type === SessiondType.LayoutCommand) {
            window.dispatchEvent(new CustomEvent('layout-command', { detail: raw }));
          }
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