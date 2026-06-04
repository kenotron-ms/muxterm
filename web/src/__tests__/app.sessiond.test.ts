import { describe, it, expect, vi, afterEach } from 'vitest';
import { terminalRegistry } from '../lib/terminal-registry.js';
import { SessiondType } from '../types.js';
import type { PaneHandlers } from '../lib/terminal-registry.js';

// Mock WebSocket before importing app
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

function applyComposition(panes: { paneId: number; cols: number; rows: number }[]): void {
  store.applySessiond({
    type: SessiondType.Composition,
    workspaceId: 'ws-1',
    panes,
  });
}

async function fixture(): Promise<MuxApp> {
  const el = document.createElement('mux-app') as MuxApp;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxApp sessiond render path', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    // Reset sessiond store state and registry between tests.
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    terminalRegistry.prune(new Set());
    el = null as unknown as MuxApp;
  });

  it('passes the composed panes to mux-dock', async () => {
    el = await fixture();
    applyComposition([
      { paneId: 5, cols: 80, rows: 24 },
      { paneId: 6, cols: 80, rows: 24 },
    ]);
    await el.updateComplete;

    const dock = el.shadowRoot!.querySelector('mux-dock') as any;
    expect(dock).toBeTruthy();
    // Both panes should be passed to mux-dock
    const paneIds = dock.panes.map((p: { paneId: number }) => p.paneId);
    expect(paneIds).toContain(5);
    expect(paneIds).toContain(6);
  });

  it('ensures a terminal per sessiond pane and routes input to the socket', async () => {
    el = await fixture();
    const captured = new Map<number, PaneHandlers>();
    const ensureSpy = vi
      .spyOn(terminalRegistry, 'ensure')
      .mockImplementation((paneId: number, handlers: PaneHandlers) => {
        captured.set(paneId, handlers);
      });

    applyComposition([{ paneId: 7, cols: 80, rows: 24 }]);
    await el.updateComplete;

    expect(captured.has(7)).toBe(true);

    const socket = (el as any)._socket;
    const inputSpy = vi.spyOn(socket, 'sendPaneInput');
    const data = new Uint8Array([1, 2, 3]);
    captured.get(7)!.onInput(data);
    expect(inputSpy).toHaveBeenCalledWith(7, data);

    ensureSpy.mockRestore();
  });

  it('routes pane resize to the socket resize sender', async () => {
    el = await fixture();
    const captured = new Map<number, PaneHandlers>();
    const ensureSpy = vi
      .spyOn(terminalRegistry, 'ensure')
      .mockImplementation((paneId: number, handlers: PaneHandlers) => {
        captured.set(paneId, handlers);
      });

    applyComposition([{ paneId: 8, cols: 80, rows: 24 }]);
    await el.updateComplete;

    const socket = (el as any)._socket;
    const resizeSpy = vi.spyOn(socket, 'resize');
    captured.get(8)!.onResize(120, 40);
    expect(resizeSpy).toHaveBeenCalledWith(8, 120, 40);

    ensureSpy.mockRestore();
  });

  it('sets the active pane when mux-dock emits pane-select', async () => {
    el = await fixture();
    applyComposition([
      { paneId: 5, cols: 80, rows: 24 },
      { paneId: 6, cols: 80, rows: 24 },
    ]);
    await el.updateComplete;

    const setActiveSpy = vi.spyOn(store, 'setActivePane');
    const dock = el.shadowRoot!.querySelector('mux-dock')!;
    dock.dispatchEvent(
      new CustomEvent('pane-select', { bubbles: true, composed: true, detail: { paneId: 6 } }),
    );
    expect(setActiveSpy).toHaveBeenCalledWith(6);
    setActiveSpy.mockRestore();
  });

  it('does not render mux-composition when there are no panes', async () => {
    el = await fixture();
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('mux-composition')).toBeNull();
  });
});
