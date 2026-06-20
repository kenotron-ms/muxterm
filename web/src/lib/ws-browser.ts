/**
 * BrowserSocket — dedicated WebSocket client for /ws/browser.
 *
 * A separate connection from the main /ws MuxSocket so that JPEG frame
 * bursts (screencast) never delay terminal keystrokes. WebSocket over TCP
 * is an ordered stream, so mixing large binary blobs with small control
 * messages causes head-of-line blocking.
 *
 * Wire protocol server→client:
 *   Binary: [4-byte LE paneId][raw JPEG bytes]  — screencast frame
 *   JSON:   {type: 'browser-url', paneId, url}
 *           {type: 'browser-download-progress', paneId, percent}
 *           {type: 'browser-error', paneId, error}
 *           {type: 'browser-status', paneId, text}
 *
 * Wire protocol client→server:
 *   JSON:   {type: 'browser-input', paneId, event: {...}}
 */

const BACKOFF_BASE = 1000;
const BACKOFF_CAP = 30000;
const JITTER_MAX = 500;

export class BrowserSocket {
  private _ws: WebSocket | null = null;
  private _url: string;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _reconnectAttempts = 0;
  private _intentionalClose = false;

  onFrame: ((paneId: number, jpegBytes: Uint8Array) => void) | null = null;
  onBrowserUrl: ((paneId: number, url: string) => void) | null = null;
  onDownloadProgress: ((paneId: number, percent: number) => void) | null = null;
  onBrowserError: ((paneId: number, error: string) => void) | null = null;
  onBrowserStatus: ((paneId: number, text: string) => void) | null = null;
  onBrowserCursor: ((paneId: number, cursor: string) => void) | null = null;
  onBrowserGranted: ((paneId: number, clientId: string) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onReconnect: (() => void) | null = null;

  constructor(url: string) {
    this._url = url;
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

  /** Send a JSON message to the server. No-op when not connected. */
  send(msg: object): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
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
      // Binary frame: [4-byte LE paneId][raw JPEG bytes]
      if (ev.data instanceof ArrayBuffer) {
        if (ev.data.byteLength >= 4) {
          const view = new DataView(ev.data);
          const paneId = view.getUint32(0, true); // little-endian
          const jpegBytes = new Uint8Array(ev.data, 4);
          this.onFrame?.(paneId, jpegBytes);
        }
        return;
      }
      // Text frame — JSON control message
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data) as Record<string, unknown>;
        switch (msg.type) {
          case 'browser-url':
            this.onBrowserUrl?.(msg.paneId as number, msg.url as string);
            break;
          case 'browser-download-progress':
            this.onDownloadProgress?.(msg.paneId as number, msg.percent as number);
            break;
          case 'browser-error':
            this.onBrowserError?.(msg.paneId as number, msg.error as string);
            break;
          case 'browser-status':
            this.onBrowserStatus?.(msg.paneId as number, msg.text as string);
            break;
          case 'browser-cursor':
            if (typeof msg['cursor'] === 'string') {
              this.onBrowserCursor?.(msg.paneId as number, msg['cursor'] as string);
            }
            break;
          case 'browser-granted':
            if (typeof msg['clientId'] === 'string') {
              this.onBrowserGranted?.(msg.paneId as number, msg['clientId'] as string);
            }
            break;
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

export function buildWsBrowserUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/browser`;
}

export const wsBrowser = new BrowserSocket(buildWsBrowserUrl());
