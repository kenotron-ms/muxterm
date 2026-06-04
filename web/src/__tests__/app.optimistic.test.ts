import { describe, it, expect, vi, afterEach } from 'vitest';
import { terminalRegistry } from '../lib/terminal-registry.js';
import { SessiondType } from '../types.js';

// Mock WebSocket before importing app (mirrors app.sessiond.test.ts).
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.OPEN;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => this.onopen?.());
  }

  send = vi.fn();
  close = vi.fn();
}

// @ts-expect-error mock WebSocket globally
globalThis.WebSocket = MockWebSocket;

import type { MuxApp } from '../app.js';
import '../app.js';
import { store } from '../state.js';

async function fixture(): Promise<MuxApp> {
  const el = document.createElement('mux-app') as MuxApp;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxApp workspace create (loading-state)', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    // Reset sessiond store state, drop any lingering pending mutations, and
    // clear the registry between tests so the shared singleton starts clean.
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    (store as unknown as { _pending: Map<string, unknown> })._pending.clear();
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    terminalRegistry.prune(new Set());
    el = null as unknown as MuxApp;
  });

  it('fires createWorkspace, sets createPending flag (no provisional row), clears on WorkspaceCreated', async () => {
    el = await fixture();
    const socket = (el as unknown as {
      _socket: {
        createWorkspace: (...a: unknown[]) => void;
        onSessiondMessage: ((msg: unknown) => void) | null;
      };
    })._socket;

    const createSpy = vi.spyOn(socket, 'createWorkspace');

    // Trigger workspace create via the modal submit path.
    // _submitCreate falls back to _createModalName when the modal input is not in the DOM.
    (el as unknown as { _createModalName: string })._createModalName = 'my-workspace';
    (el as unknown as { _submitCreate: () => void })._submitCreate();

    // Socket send should have fired with the workspace name.
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toBe('my-workspace');

    // No provisional row — only a loading flag.
    expect(store.workspaces.length).toBe(0);
    expect((el as unknown as { _creatingWorkspace: boolean })._creatingWorkspace).toBe(true);

    // Daemon echoes WorkspaceCreated.
    socket.onSessiondMessage?.({
      type: SessiondType.WorkspaceCreated,
      workspaceId: 'w-new',
    });

    // Loading flag clears.
    expect((el as unknown as { _creatingWorkspace: boolean })._creatingWorkspace).toBe(false);
  });

  it('resets _creatingWorkspace when the socket disconnects', async () => {
    el = await fixture();
    const socket = (el as unknown as {
      _socket: { onDisconnect: (() => void) | null };
    })._socket;

    // Simulate a workspace create in-flight.
    (el as unknown as { _creatingWorkspace: boolean })._creatingWorkspace = true;

    // Fire the disconnect callback (WebSocket drops while create is pending).
    socket.onDisconnect?.();

    // Must be cleared so the "New workspace" button re-enables.
    expect((el as unknown as { _creatingWorkspace: boolean })._creatingWorkspace).toBe(false);
  });

  it('does not send a second createWorkspace when called twice in quick succession', async () => {
    el = await fixture();
    const socket = (el as unknown as {
      _socket: { createWorkspace: (...a: unknown[]) => void };
    })._socket;
    const createSpy = vi.spyOn(socket, 'createWorkspace');

    // Double-click: two calls in the same synchronous tick.
    // _submitCreate uses _createModalName when the modal input is not in the DOM.
    (el as unknown as { _createModalName: string })._createModalName = 'test-ws';
    (el as unknown as { _submitCreate: () => void })._submitCreate();
    (el as unknown as { _submitCreate: () => void })._submitCreate(); // guarded by _creatingWorkspace

    // Only one socket send should have been dispatched.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

describe('MuxApp optimistic pane create', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    (store as unknown as { _pending: Map<string, unknown> })._pending.clear();
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    terminalRegistry.prune(new Set());
    el = null as unknown as MuxApp;
  });

  it('shows provisional pane instantly and settles on matching pane-added', async () => {
    el = await fixture();
    // Attach an empty workspace so PaneAdded reconciles against it.
    store.applySessiond({ type: SessiondType.Composition, workspaceId: 'w1', panes: [] });

    const socket = (el as unknown as { _socket: { createPane: unknown } })._socket;
    const sendSpy = vi.spyOn(socket as { createPane: (...a: unknown[]) => void }, 'createPane');

    (el as unknown as { _createPaneOptimistic: () => void })._createPaneOptimistic();

    // Provisional pane overlaid instantly.
    expect(store.panes.length).toBe(1);

    // Create sent with a non-empty clientRef as the second argument.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const ref = sendSpy.mock.calls[0][1] as string;
    expect(typeof ref).toBe('string');
    expect(ref.length).toBeGreaterThan(0);

    // Daemon echoes a real positive paneId carrying that exact clientRef.
    store.applySessiond({
      type: SessiondType.PaneAdded,
      paneId: 1,
      cols: 0,
      rows: 0,
      clientRef: ref,
    });

    expect(store.panes.length).toBe(1);
    expect(store.panes[0].paneId).toBe(1);
  });

  it('does NOT settle on a pane-added with a different clientRef', async () => {
    el = await fixture();
    store.applySessiond({ type: SessiondType.Composition, workspaceId: 'w1', panes: [] });

    const socket = (el as unknown as { _socket: { createPane: unknown } })._socket;
    const sendSpy = vi.spyOn(socket as { createPane: (...a: unknown[]) => void }, 'createPane');

    (el as unknown as { _createPaneOptimistic: () => void })._createPaneOptimistic();
    expect(store.panes.length).toBe(1);
    const ref = sendSpy.mock.calls[0][1] as string;

    // Another tab's create echoes with a DIFFERENT clientRef.
    store.applySessiond({
      type: SessiondType.PaneAdded,
      paneId: 1,
      cols: 0,
      rows: 0,
      clientRef: 'other-ref',
    });

    // Our provisional pane is still pending (ref not echoed) and overlays on top
    // of the other tab's authoritative pane: two panes, unsettled.
    expect(ref).not.toBe('other-ref');
    expect(store.panes.length).toBe(2);
  });
});

describe('MuxApp one-terminal-per-workspace', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    (store as unknown as { _pending: Map<string, unknown> })._pending.clear();
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    terminalRegistry.prune(new Set());
    el = null as unknown as MuxApp;
  });

  it('auto-spawns one pane when attaching a zero-pane workspace', async () => {
    el = await fixture();
    const socket = (el as unknown as {
      _socket: { createPane: unknown; onSessiondMessage: (m: unknown) => void };
    })._socket;
    const sendSpy = vi.spyOn(socket as { createPane: (...a: unknown[]) => void }, 'createPane');

    // Attaching a zero-pane composition triggers the one-terminal-per-workspace rule.
    socket.onSessiondMessage({ type: SessiondType.Composition, workspaceId: 'w1', panes: [] });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(store.panes.length).toBe(1);
  });

  it('does NOT auto-spawn when attaching a populated workspace', async () => {
    el = await fixture();
    const socket = (el as unknown as {
      _socket: { createPane: unknown; onSessiondMessage: (m: unknown) => void };
    })._socket;
    const sendSpy = vi.spyOn(socket as { createPane: (...a: unknown[]) => void }, 'createPane');

    socket.onSessiondMessage({
      type: SessiondType.Composition,
      workspaceId: 'w1',
      panes: [{ paneId: 3, cols: 0, rows: 0 }],
    });

    expect(sendSpy).not.toHaveBeenCalled();
    expect(store.panes.map((p) => p.paneId)).toEqual([3]);
  });
});

describe('MuxApp _syncTerminals negative-pane guard', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    (store as unknown as { _pending: Map<string, unknown> })._pending.clear();
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    terminalRegistry.prune(new Set());
    el = null as unknown as MuxApp;
  });

  it('does not create a terminal for a provisional negative pane ID', async () => {
    el = await fixture();
    // Attach an empty workspace so the store has an active composition.
    store.applySessiond({ type: SessiondType.Composition, workspaceId: 'w1', panes: [] });

    // Push an optimistic pane with a provisional negative paneId (-777).
    store.mutate({
      optimistic: (draft) => draft.panes.push({ paneId: -777, cols: 0, rows: 0 }),
      settled: () => false,
    });

    el.requestUpdate();
    await el.updateComplete;

    // The provisional pane must NOT have a terminal created for it.
    expect(terminalRegistry.getTerminal(-777)).toBeNull();
  });

  it('still creates a terminal for a positive (real) pane ID', async () => {
    el = await fixture();
    // Apply a composition with a real positive paneId.
    store.applySessiond({
      type: SessiondType.Composition,
      workspaceId: 'w1',
      panes: [{ paneId: 42, cols: 80, rows: 24 }],
    });

    el.requestUpdate();
    await el.updateComplete;

    // A real pane MUST have a terminal created for it.
    expect(terminalRegistry.getTerminal(42)).not.toBeNull();
  });
});

describe('MuxApp switch restores, never double-spawns', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    (store as unknown as { _pending: Map<string, unknown> })._pending.clear();
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    terminalRegistry.prune(new Set());
    el = null as unknown as MuxApp;
  });

  it('restores the active pane on switch to a populated workspace without spawning', async () => {
    el = await fixture();
    const socket = (el as unknown as {
      _socket: { createPane: unknown; onSessiondMessage: (m: unknown) => void };
    })._socket;
    const sendSpy = vi.spyOn(socket as { createPane: (...a: unknown[]) => void }, 'createPane');

    // Switch to a populated workspace: its existing panes must be restored,
    // never respawned (D1 guard).
    socket.onSessiondMessage({
      type: SessiondType.Composition,
      workspaceId: 'w2',
      panes: [
        { paneId: 10, cols: 0, rows: 0 },
        { paneId: 11, cols: 0, rows: 0 },
      ],
    });

    // No double-spawn: the one-terminal-per-workspace rule does not fire for
    // a populated workspace.
    expect(sendSpy).not.toHaveBeenCalled();

    // Both panes from the server composition are in the store.
    expect(store.panes.map((p) => p.paneId)).toContain(10);
    expect(store.panes.map((p) => p.paneId)).toContain(11);
  });
});
