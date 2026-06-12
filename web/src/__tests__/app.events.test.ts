import { describe, it, expect, vi, afterEach } from 'vitest';
import { terminalRegistry } from '../lib/terminal-registry.js';
import { SessiondType } from '../types.js';

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
    queueMicrotask(() => {
      if (this.onopen) this.onopen();
    });
  }

  send = vi.fn();
  close = vi.fn();
}

// @ts-expect-error mock WebSocket globally
globalThis.WebSocket = MockWebSocket;

// Need side-effect import so the custom element is registered (just type import
// does not execute the module). Keep the type import for editor support.
import '../app.js';
import type { MuxApp } from '../app.js';
import { store } from '../state.js';

async function fixture(): Promise<MuxApp> {
  store.applySessiond({
    type: SessiondType.Composition,
    workspaceId: 'ws-1',
    panes: [{ paneId: 5, cols: 80, rows: 24 }],
  });
  const el = document.createElement('mux-app') as MuxApp;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('browser-pane-open and pane-navigate event handlers', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    terminalRegistry.prune(new Set());
  });

  // ── _onBrowserPaneOpen handler (browserUrl API) ──────────────────────────

  it('_onBrowserPaneOpen calls createBrowserPane(0, url) for a localhost URL', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const spy = vi.spyOn(socket, 'createBrowserPane').mockImplementation(() => {});

    (el as any)._onBrowserPaneOpen(
      new CustomEvent('browser-pane-open', { detail: { browserUrl: 'http://localhost:3000' } }),
    );

    expect(spy).toHaveBeenCalledWith(0, 'http://localhost:3000');
    spy.mockRestore();
  });

  it('_onBrowserPaneOpen calls createBrowserPane(0, url) for a localhost URL with path', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const spy = vi.spyOn(socket, 'createBrowserPane').mockImplementation(() => {});

    (el as any)._onBrowserPaneOpen(
      new CustomEvent('browser-pane-open', { detail: { browserUrl: 'http://localhost:5173/app' } }),
    );

    expect(spy).toHaveBeenCalledWith(0, 'http://localhost:5173/app');
    spy.mockRestore();
  });

  it('_onBrowserPaneOpen calls createBrowserPane(0, url) for an external URL', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const spy = vi.spyOn(socket, 'createBrowserPane').mockImplementation(() => {});

    (el as any)._onBrowserPaneOpen(
      new CustomEvent('browser-pane-open', { detail: { browserUrl: 'https://google.com' } }),
    );

    expect(spy).toHaveBeenCalledWith(0, 'https://google.com');
    spy.mockRestore();
  });

  it('_onBrowserPaneOpen calls createBrowserPane(0, url) for http://127.0.0.1', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const spy = vi.spyOn(socket, 'createBrowserPane').mockImplementation(() => {});

    (el as any)._onBrowserPaneOpen(
      new CustomEvent('browser-pane-open', { detail: { browserUrl: 'http://127.0.0.1:5000' } }),
    );

    expect(spy).toHaveBeenCalledWith(0, 'http://127.0.0.1:5000');
    spy.mockRestore();
  });

  // ── _onPaneNavigate handler ───────────────────────────────────────────────

  it('_onPaneNavigate calls updatePanePath(paneId, browserPath)', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const spy = vi.spyOn(socket, 'updatePanePath').mockImplementation(() => {});

    (el as any)._onPaneNavigate(
      new CustomEvent('pane-navigate', { detail: { paneId: 42, browserPath: '/foo/bar' } }),
    );

    expect(spy).toHaveBeenCalledWith(42, '/foo/bar');
    spy.mockRestore();
  });

  // ── Event listener registration in connectedCallback ─────────────────────

  it('dispatching browser-pane-open with browserUrl on the element triggers createBrowserPane', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const spy = vi.spyOn(socket, 'createBrowserPane').mockImplementation(() => {});

    el.dispatchEvent(
      new CustomEvent('browser-pane-open', { detail: { browserUrl: 'http://localhost:8080' } }),
    );

    expect(spy).toHaveBeenCalledWith(0, 'http://localhost:8080');
    spy.mockRestore();
  });

  it('dispatching pane-navigate on the element triggers updatePanePath', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const spy = vi.spyOn(socket, 'updatePanePath').mockImplementation(() => {});

    el.dispatchEvent(
      new CustomEvent('pane-navigate', { detail: { paneId: 7, browserPath: '/app' } }),
    );

    expect(spy).toHaveBeenCalledWith(7, '/app');
    spy.mockRestore();
  });

  // ── Event listener cleanup in disconnectedCallback ────────────────────────

  it('disconnectedCallback removes browser-pane-open listener', async () => {
    el = await fixture();
    const browserHandler = (el as any)._onBrowserPaneOpen;

    const removeEventListenerSpy = vi.spyOn(el, 'removeEventListener');

    el.parentNode!.removeChild(el);

    const calls = removeEventListenerSpy.mock.calls;
    const removed = calls.some(
      ([type, handler]) => type === 'browser-pane-open' && handler === browserHandler,
    );
    expect(removed).toBe(true);

    removeEventListenerSpy.mockRestore();
    el = null as any;
  });

  it('disconnectedCallback removes pane-navigate listener', async () => {
    el = await fixture();
    const navigateHandler = (el as any)._onPaneNavigate;

    const removeEventListenerSpy = vi.spyOn(el, 'removeEventListener');

    el.parentNode!.removeChild(el);

    const calls = removeEventListenerSpy.mock.calls;
    const removed = calls.some(
      ([type, handler]) => type === 'pane-navigate' && handler === navigateHandler,
    );
    expect(removed).toBe(true);

    removeEventListenerSpy.mockRestore();
    el = null as any;
  });
});
