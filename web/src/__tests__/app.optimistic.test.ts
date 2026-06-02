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

describe('MuxApp optimistic workspace create', () => {
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

  it('shows provisional workspace instantly and sends create with a clientRef', async () => {
    el = await fixture();
    const socket = (el as unknown as { _socket: { createWorkspace: unknown } })._socket;
    const sendSpy = vi.spyOn(socket as { createWorkspace: (...a: unknown[]) => void }, 'createWorkspace');

    (el as unknown as { _createWorkspaceOptimistic: () => void })._createWorkspaceOptimistic();

    // Provisional row overlaid instantly.
    expect(store.workspaces.length).toBe(1);

    // Create sent with a non-empty clientRef as the second argument.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const ref = sendSpy.mock.calls[0][1] as string;
    expect(typeof ref).toBe('string');
    expect(ref.length).toBeGreaterThan(0);

    // Authoritative list echoes that exact clientRef → settles to the real row.
    store.applySessiond({
      type: SessiondType.WorkspaceList,
      workspaces: [{ workspaceId: 'w7', paneCount: 0, clientRef: ref }],
    });

    expect(store.workspaces.length).toBe(1);
    expect(store.workspaces[0].workspaceId).toBe('w7');
  });

  it('does NOT settle when echo carries a different clientRef', async () => {
    el = await fixture();
    const socket = (el as unknown as { _socket: { createWorkspace: unknown } })._socket;
    const sendSpy = vi.spyOn(socket as { createWorkspace: (...a: unknown[]) => void }, 'createWorkspace');

    (el as unknown as { _createWorkspaceOptimistic: () => void })._createWorkspaceOptimistic();
    expect(store.workspaces.length).toBe(1);
    const ref = sendSpy.mock.calls[0][1] as string;

    // Another tab's create echoes with a DIFFERENT clientRef.
    store.applySessiond({
      type: SessiondType.WorkspaceList,
      workspaces: [{ workspaceId: 'w9', paneCount: 0, clientRef: 'someone-elses-ref' }],
    });

    // Our provisional row is still pending (its ref was not echoed), so it
    // overlays on top of the other tab's authoritative row: two rows, unsettled.
    expect(ref).not.toBe('someone-elses-ref');
    expect(store.workspaces.length).toBe(2);
  });
});
