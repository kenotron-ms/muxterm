import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserSocket, buildWsBrowserUrl } from './ws-browser.js';

/* ---- MockWebSocket ---- */

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

class MockWebSocket {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  CONNECTING = CONNECTING;
  OPEN = OPEN;
  CLOSING = CLOSING;
  CLOSED = CLOSED;

  url: string;
  readyState: number = CONNECTING;
  binaryType: string = '';
  sent: unknown[] = [];

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    void code;
    this.readyState = CLOSED;
  }

  /* test helpers */
  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string | ArrayBuffer): void {
    const ev = new MessageEvent('message', { data });
    this.onmessage?.(ev);
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  static instances: MockWebSocket[] = [];
}

/* ---- Install / remove global mock ---- */

let origWebSocket: typeof globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  origWebSocket = globalThis.WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = MockWebSocket;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = origWebSocket;
});

/* ---- Tests ---- */

describe('BrowserSocket', () => {
  it('connects to correct URL and sets binaryType=arraybuffer', () => {
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    browser.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe('ws://localhost:8080/ws/browser');
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('routes binary frames to onFrame callback', () => {
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    const frameCb = vi.fn();
    browser.onFrame = frameCb;
    browser.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    // Build a binary frame: [4-byte LE paneId=7][JPEG bytes]
    const paneId = 7;
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // fake JPEG header
    const buf = new ArrayBuffer(4 + jpeg.length);
    const view = new DataView(buf);
    view.setUint32(0, paneId, true); // little-endian
    new Uint8Array(buf, 4).set(jpeg);

    ws.simulateMessage(buf);

    expect(frameCb).toHaveBeenCalledOnce();
    expect(frameCb).toHaveBeenCalledWith(7, expect.any(Uint8Array));
    const receivedBytes = (frameCb as ReturnType<typeof vi.fn>).mock.calls[0][1] as Uint8Array;
    expect(Array.from(receivedBytes)).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });

  it('ignores binary frames shorter than 4 bytes', () => {
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    const frameCb = vi.fn();
    browser.onFrame = frameCb;
    browser.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(new ArrayBuffer(3));

    expect(frameCb).not.toHaveBeenCalled();
  });

  it('routes browser-url JSON message to onBrowserUrl callback', () => {
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    const urlCb = vi.fn();
    browser.onBrowserUrl = urlCb;
    browser.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'browser-url', paneId: 3, url: 'https://example.com' }));

    expect(urlCb).toHaveBeenCalledOnce();
    expect(urlCb).toHaveBeenCalledWith(3, 'https://example.com');
  });

  it('routes browser-download-progress JSON message to onDownloadProgress callback', () => {
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    const progressCb = vi.fn();
    browser.onDownloadProgress = progressCb;
    browser.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'browser-download-progress', paneId: 5, percent: 42 }));

    expect(progressCb).toHaveBeenCalledOnce();
    expect(progressCb).toHaveBeenCalledWith(5, 42);
  });

  it('routes browser-error JSON message to onBrowserError callback', () => {
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    const errorCb = vi.fn();
    browser.onBrowserError = errorCb;
    browser.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'browser-error', paneId: 2, error: 'net::ERR_NAME_NOT_RESOLVED' }));

    expect(errorCb).toHaveBeenCalledOnce();
    expect(errorCb).toHaveBeenCalledWith(2, 'net::ERR_NAME_NOT_RESOLVED');
  });

  it('routes browser-status JSON message to onBrowserStatus callback', () => {
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    const statusCb = vi.fn();
    browser.onBrowserStatus = statusCb;
    browser.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'browser-status', paneId: 4, text: 'Loading...' }));

    expect(statusCb).toHaveBeenCalledOnce();
    expect(statusCb).toHaveBeenCalledWith(4, 'Loading...');
  });

  it('send() serialises object as JSON when connected', () => {
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    browser.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    browser.send({ type: 'browser-input', paneId: 1, event: { type: 'click', x: 10, y: 20 } });

    expect(ws.sent).toHaveLength(1);
    const parsed = JSON.parse(ws.sent[0] as string) as Record<string, unknown>;
    expect(parsed.type).toBe('browser-input');
    expect(parsed.paneId).toBe(1);
  });

  it('send() is a no-op when not connected', () => {
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    browser.connect();

    // Do NOT call simulateOpen — socket is still in CONNECTING state
    browser.send({ type: 'browser-input', paneId: 1, event: {} });

    const ws = MockWebSocket.instances[0];
    expect(ws.sent).toHaveLength(0);
  });

  it('connected getter returns true when open', () => {
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    browser.connect();

    expect(browser.connected).toBe(false);
    MockWebSocket.instances[0].simulateOpen();
    expect(browser.connected).toBe(true);
  });

  it('disconnect() closes socket and sets intentionalClose', () => {
    vi.useFakeTimers();
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    browser.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    browser.disconnect();

    // After disconnect, socket is null so connected is false
    expect(browser.connected).toBe(false);

    // Simulate a close event after disconnect — should NOT reconnect
    ws.simulateClose(1006);
    vi.advanceTimersByTime(5000);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.useRealTimers();
  });

  describe('onDisconnect / onReconnect callbacks', () => {
    it('calls onDisconnect when connection closes with non-1000 code', () => {
      vi.useFakeTimers();
      const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
      const disconnectCb = vi.fn();
      browser.onDisconnect = disconnectCb;
      browser.connect();

      const ws = MockWebSocket.instances[0];
      ws.simulateOpen();
      ws.simulateClose(1006, 'abnormal');

      expect(disconnectCb).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it('does not call onDisconnect for normal close (code 1000)', () => {
      const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
      const disconnectCb = vi.fn();
      browser.onDisconnect = disconnectCb;
      browser.connect();

      const ws = MockWebSocket.instances[0];
      ws.simulateOpen();
      ws.simulateClose(1000, 'normal');

      expect(disconnectCb).not.toHaveBeenCalled();
    });

    it('calls onReconnect when reconnecting WebSocket opens', () => {
      vi.useFakeTimers();
      const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
      const reconnectCb = vi.fn();
      browser.onReconnect = reconnectCb;
      browser.connect();

      const ws0 = MockWebSocket.instances[0];
      ws0.simulateOpen();
      reconnectCb.mockClear();

      ws0.simulateClose(1006);
      vi.advanceTimersByTime(2000);

      expect(MockWebSocket.instances).toHaveLength(2);
      const ws1 = MockWebSocket.instances[1];
      ws1.simulateOpen();

      expect(reconnectCb).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it('does not schedule reconnect for code 1000', () => {
      vi.useFakeTimers();
      const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
      browser.connect();

      const ws0 = MockWebSocket.instances[0];
      ws0.simulateOpen();
      ws0.simulateClose(1000, 'normal');

      vi.advanceTimersByTime(5000);
      expect(MockWebSocket.instances).toHaveLength(1);
      vi.useRealTimers();
    });

    it('schedules reconnect with exponential backoff', () => {
      vi.useFakeTimers();
      const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
      browser.connect();

      const ws0 = MockWebSocket.instances[0];
      ws0.simulateOpen();
      ws0.simulateClose(1006);

      // Not yet reconnected at 500ms
      vi.advanceTimersByTime(500);
      expect(MockWebSocket.instances).toHaveLength(1);

      // Should reconnect by 1500ms (1000ms base + possible jitter)
      vi.advanceTimersByTime(1000);
      expect(MockWebSocket.instances).toHaveLength(2);

      vi.useRealTimers();
    });
  });

  it('onerror is a no-op (does not throw)', () => {
    const browser = new BrowserSocket('ws://localhost:8080/ws/browser');
    browser.connect();

    const ws = MockWebSocket.instances[0];
    // onerror should be a function (not null) and calling it should be safe
    expect(() => {
      ws.onerror?.(new Event('error'));
    }).not.toThrow();
  });
});

describe('buildWsBrowserUrl', () => {
  it('returns a WebSocket URL with path /ws/browser', () => {
    const url = buildWsBrowserUrl();
    expect(url).toMatch(/^wss?:\/\//);
    expect(url).toContain('/ws/browser');
  });

  it('uses wss: when location.protocol is https:', () => {
    const origDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'https:', host: 'example.com' },
      configurable: true,
    });
    const url = buildWsBrowserUrl();
    expect(url).toBe('wss://example.com/ws/browser');
    if (origDescriptor) {
      Object.defineProperty(window, 'location', origDescriptor);
    }
  });

  it('uses ws: when location.protocol is http:', () => {
    const origDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:8080' },
      configurable: true,
    });
    const url = buildWsBrowserUrl();
    expect(url).toBe('ws://localhost:8080/ws/browser');
    if (origDescriptor) {
      Object.defineProperty(window, 'location', origDescriptor);
    }
  });
});
