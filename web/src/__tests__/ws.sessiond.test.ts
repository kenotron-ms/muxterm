import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MuxStore } from '../state';
import { MuxSocket } from '../ws';
import { SessiondType, encodePaneFrame, decodePaneFrame, type SessiondMessage } from '../types';

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

  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.(new Event('open'));
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

/** Helper: build an open MuxSocket + its MockWebSocket. */
function openSocket(): { mux: MuxSocket; ws: MockWebSocket } {
  const store = new MuxStore();
  const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
  mux.connect();
  const ws = MockWebSocket.instances[0];
  ws.simulateOpen();
  return { mux, ws };
}

/** Helper: parse the last JSON text frame sent. */
function lastJson(ws: MockWebSocket): Record<string, unknown> {
  return JSON.parse(ws.sent[ws.sent.length - 1] as string) as Record<string, unknown>;
}

/* ---- Tests ---- */

describe('MuxSocket sessiond senders', () => {
  it('attach() emits flat {type:"attach", workspaceId}', () => {
    const { mux, ws } = openSocket();
    mux.attach('ws-1');

    expect(ws.sent).toHaveLength(1);
    expect(lastJson(ws)).toEqual({ type: SessiondType.Attach, workspaceId: 'ws-1' });
  });

  it('listWorkspaces() emits flat {type:"list-workspaces"}', () => {
    const { mux, ws } = openSocket();
    mux.listWorkspaces();

    expect(ws.sent).toHaveLength(1);
    expect(lastJson(ws)).toEqual({ type: SessiondType.ListWorkspaces });
  });

  it('createWorkspace() omits name; createWorkspace(name) includes it', () => {
    const { mux, ws } = openSocket();

    mux.createWorkspace();
    expect(lastJson(ws)).toEqual({ type: SessiondType.CreateWorkspace });

    mux.createWorkspace('alpha');
    expect(lastJson(ws)).toEqual({ type: SessiondType.CreateWorkspace, name: 'alpha' });

    // Empty string is falsy -> name omitted.
    mux.createWorkspace('');
    expect(lastJson(ws)).toEqual({ type: SessiondType.CreateWorkspace });
  });

  it('createWorkspace(name, clientRef) includes clientRef when provided', () => {
    const { mux, ws } = openSocket();
    mux.createWorkspace('dev', 'tmp-ws-1');

    const sent = lastJson(ws);
    expect(sent.type).toBe('create-workspace');
    expect(sent.name).toBe('dev');
    expect(sent.clientRef).toBe('tmp-ws-1');
  });

  it('createWorkspace() omits clientRef when not provided', () => {
    const { mux, ws } = openSocket();
    mux.createWorkspace();

    const sent = lastJson(ws);
    expect('clientRef' in sent).toBe(false);
  });

  it('createPane(undefined, clientRef) includes clientRef when provided', () => {
    const { mux, ws } = openSocket();
    mux.createPane(undefined, 'tmp-pane-1');

    const sent = lastJson(ws);
    expect(sent.clientRef).toBe('tmp-pane-1');
  });

  it('renameWorkspace() emits {type,workspaceId,name}', () => {
    const { mux, ws } = openSocket();
    mux.renameWorkspace('ws-9', 'renamed');

    expect(lastJson(ws)).toEqual({
      type: SessiondType.RenameWorkspace,
      workspaceId: 'ws-9',
      name: 'renamed',
    });
  });

  it('closeWorkspace() emits {type,workspaceId}', () => {
    const { mux, ws } = openSocket();
    mux.closeWorkspace('ws-3');

    expect(lastJson(ws)).toEqual({ type: SessiondType.CloseWorkspace, workspaceId: 'ws-3' });
  });

  it('createPane() carries no workspaceId; includes cmd only when non-empty', () => {
    const { mux, ws } = openSocket();

    mux.createPane();
    const noCmd = lastJson(ws);
    expect(noCmd).toEqual({ type: SessiondType.CreatePane });
    expect('workspaceId' in noCmd).toBe(false);

    mux.createPane([]);
    expect(lastJson(ws)).toEqual({ type: SessiondType.CreatePane });

    mux.createPane(['bash', '-l']);
    const withCmd = lastJson(ws);
    expect(withCmd).toEqual({ type: SessiondType.CreatePane, cmd: ['bash', '-l'] });
    expect('workspaceId' in withCmd).toBe(false);
  });

  it('resize() carries paneId/cols/rows', () => {
    const { mux, ws } = openSocket();
    mux.resize(5, 120, 40);

    expect(lastJson(ws)).toEqual({
      type: SessiondType.Resize,
      paneId: 5,
      cols: 120,
      rows: 40,
    });
  });

  it('sendPaneInput() emits a binary frame that round-trips via decodePaneFrame', () => {
    const { mux, ws } = openSocket();
    const input = new Uint8Array([104, 105]); // "hi"
    mux.sendPaneInput(7, input);

    expect(ws.sent).toHaveLength(1);
    const buf = ws.sent[0] as ArrayBuffer;
    expect(buf).toBeInstanceOf(ArrayBuffer);

    const { paneId, data } = decodePaneFrame(buf);
    expect(paneId).toBe(7);
    expect(Array.from(data)).toEqual([104, 105]);
  });

  it('senders do not throw when the socket is not open', () => {
    const store = new MuxStore();
    const mux = new MuxSocket(store, 'ws://localhost:8080/ws');
    // never connected -> no underlying WebSocket

    expect(() => {
      mux.attach('ws-1');
      mux.listWorkspaces();
      mux.createWorkspace('x');
      mux.renameWorkspace('ws-1', 'y');
      mux.closeWorkspace('ws-1');
      mux.createPane(['bash']);
      mux.resize(1, 80, 24);
      mux.sendPaneInput(1, new Uint8Array([1, 2, 3]));
    }).not.toThrow();
  });
});

describe('MuxSocket sessiond receive routing', () => {
  it('routes a flat text control frame to onSessiondMessage', () => {
    const { mux, ws } = openSocket();

    const received: SessiondMessage[] = [];
    mux.onSessiondMessage = (msg) => received.push(msg);

    const frame: SessiondMessage = {
      type: SessiondType.Composition,
      workspaceId: 'ws-1',
      panes: [{ paneId: 3, cols: 80, rows: 24 }],
    };
    ws.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe(SessiondType.Composition);
    expect(received[0].workspaceId).toBe('ws-1');
    expect(received[0].panes).toEqual([{ paneId: 3, cols: 80, rows: 24 }]);
  });

  it('decodes a binary pane frame and forwards to onPaneOutput', () => {
    const { mux, ws } = openSocket();

    const received: { paneId: number; data: Uint8Array }[] = [];
    mux.onPaneOutput((paneId, data) => received.push({ paneId, data }));

    const buf = encodePaneFrame(9, new Uint8Array([72, 105])); // "Hi"
    ws.onmessage?.({ data: buf } as MessageEvent);

    expect(received).toHaveLength(1);
    expect(received[0].paneId).toBe(9);
    expect(Array.from(received[0].data)).toEqual([72, 105]);
  });

  it('ignores a text frame with no type (serve config envelope)', () => {
    const { mux, ws } = openSocket();

    const received: SessiondMessage[] = [];
    mux.onSessiondMessage = (msg) => received.push(msg);

    // A serve config envelope has no top-level "type" field.
    ws.onmessage?.({ data: JSON.stringify({ config: { theme: 'dark' } }) } as MessageEvent);

    expect(received).toHaveLength(0);
  });
});
