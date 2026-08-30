import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MuxStore } from '../state';
import { MuxSocket, buildWsUrl } from '../ws';
import type { PaneOutputCallback } from '../ws';

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

  close(): void {
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
   
  (globalThis as any).WebSocket = MockWebSocket;
});

afterEach(() => {
   
  (globalThis as any).WebSocket = origWebSocket;
});

/* ---- Tests ---- */

describe('MuxSocket', () => {
  it('connects to correct URL and sets binaryType=arraybuffer', () => {
    const store = new MuxStore();
    const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
    mux.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe('ws://localhost:8080/ws');
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('routes binary frames to pane output callback', () => {
    const store = new MuxStore();
    const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
    const cb: PaneOutputCallback = vi.fn();
    mux.onPaneOutput(cb);
    mux.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    // Build a binary frame: 4-byte LE uint32 paneId (42) + payload [65, 66, 67]
    const paneId = 42;
    const payload = new Uint8Array([65, 66, 67]); // "ABC"
    const buf = new ArrayBuffer(4 + payload.length);
    const view = new DataView(buf);
    view.setUint32(0, paneId, true); // little-endian
    new Uint8Array(buf, 4).set(payload);

    ws.simulateMessage(buf);

    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(42, expect.any(Uint8Array));
    // Verify the data bytes
    const receivedData = (cb as ReturnType<typeof vi.fn>).mock.calls[0][1] as Uint8Array;
    expect(Array.from(receivedData)).toEqual([65, 66, 67]);
  });

  it('sends binary frames with pane ID prefix for pane input', () => {
    const store = new MuxStore();
    const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
    mux.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const inputData = new Uint8Array([104, 105]); // "hi"
    mux.sendPaneInput(7, inputData);

    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[0] as string)).toEqual({
      type: 'protocol-hello',
      cid: 1,
      protocolHello: {
        recoverySchemaVersion: 1,
        capabilities: {
          values: [
            'pane-recovery-projection',
            'recovery-retry',
            'recovery-select',
            'active-pane-persistence',
            'recovered-history-literal',
          ],
        },
      },
    });
    const sentBuf = ws.sent[1] as ArrayBuffer;
    expect(sentBuf).toBeInstanceOf(ArrayBuffer);
    expect(sentBuf.byteLength).toBe(6); // 4 + 2

    const view = new DataView(sentBuf);
    expect(view.getUint32(0, true)).toBe(7); // pane ID, little-endian
    const sentPayload = new Uint8Array(sentBuf, 4);
    expect(Array.from(sentPayload)).toEqual([104, 105]);
  });

  describe('onDisconnect / onReconnect callbacks', () => {
    it('calls onDisconnect when connection closes with non-1000 code', () => {
      vi.useFakeTimers();
      const store = new MuxStore();
      const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
      const disconnectCb = vi.fn();
      mux.onDisconnect = disconnectCb;
      mux.connect();

      const ws = MockWebSocket.instances[0];
      ws.simulateOpen();
      ws.simulateClose(1006, 'abnormal');

      expect(disconnectCb).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it('does not call onDisconnect for normal close (code 1000)', () => {
      const store = new MuxStore();
      const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
      const disconnectCb = vi.fn();
      mux.onDisconnect = disconnectCb;
      mux.connect();

      const ws = MockWebSocket.instances[0];
      ws.simulateOpen();
      ws.simulateClose(1000, 'normal');

      expect(disconnectCb).not.toHaveBeenCalled();
    });

    it('calls onReconnect when reconnecting WebSocket opens', () => {
      vi.useFakeTimers();
      const store = new MuxStore();
      const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
      const reconnectCb = vi.fn();
      mux.onReconnect = reconnectCb;
      mux.connect();

      const ws0 = MockWebSocket.instances[0];
      ws0.simulateOpen();
      // onReconnect should not fire on first connect
      // (or it should fire – spec says onopen resets attempts and calls onReconnect)
      reconnectCb.mockClear();

      // Simulate abnormal close
      ws0.simulateClose(1006);

      // Advance past the reconnect delay
      vi.advanceTimersByTime(2000);

      // A new WebSocket should have been created
      expect(MockWebSocket.instances).toHaveLength(2);
      const ws1 = MockWebSocket.instances[1];
      ws1.simulateOpen();

      expect(reconnectCb).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it('resets reconnectAttempts on successful reconnect', () => {
      vi.useFakeTimers();
      const store = new MuxStore();
      const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
      mux.connect();

      const ws0 = MockWebSocket.instances[0];
      ws0.simulateOpen();

      // Simulate abnormal close
      ws0.simulateClose(1006);

      // Advance past the reconnect delay
      vi.advanceTimersByTime(2000);
      const ws1 = MockWebSocket.instances[1];
      ws1.simulateOpen();

      // After reconnect and open, the socket should be connected
      expect(mux.connected).toBe(true);
      vi.useRealTimers();
    });

    it('does not schedule reconnect for code 1000', () => {
      vi.useFakeTimers();
      const store = new MuxStore();
      const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
      mux.connect();

      const ws0 = MockWebSocket.instances[0];
      ws0.simulateOpen();
      ws0.simulateClose(1000, 'normal');

      vi.advanceTimersByTime(5000);

      // No new WebSocket should have been created
      expect(MockWebSocket.instances).toHaveLength(1);
      vi.useRealTimers();
    });

    it('schedules reconnect with exponential backoff', () => {
      vi.useFakeTimers();
      const store = new MuxStore();
      const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
      mux.connect();

      const ws0 = MockWebSocket.instances[0];
      ws0.simulateOpen();

      // Close abnormally - first reconnect should be after ~1000ms base
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

  describe('destroy()', () => {
    it('closes WebSocket with code 1000', () => {
      const store = new MuxStore();
      const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
      mux.connect();

      const ws = MockWebSocket.instances[0];
      ws.simulateOpen();

      const closeSpy = vi.spyOn(ws, 'close');
      mux.destroy();

      expect(closeSpy).toHaveBeenCalledWith(1000);
    });

    it('clears reconnect timer', () => {
      vi.useFakeTimers();
      const store = new MuxStore();
      const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
      mux.connect();

      const ws0 = MockWebSocket.instances[0];
      ws0.simulateOpen();
      ws0.simulateClose(1006);

      // A reconnect timer should be scheduled
      mux.destroy();

      // Advance time - no new WebSocket should be created
      vi.advanceTimersByTime(10000);
      expect(MockWebSocket.instances).toHaveLength(1);
      vi.useRealTimers();
    });
  });
});

describe('buildWsUrl', () => {
  it('converts http to ws protocol', () => {
    // buildWsUrl uses window.location, so we test the logic
    const url = buildWsUrl('/ws');
    // In happy-dom test environment, location.protocol is 'http:'
    // and location.host is 'localhost:3000' or similar
    expect(url).toMatch(/^wss?:\/\//);
    expect(url).toContain('/ws');
  });
});