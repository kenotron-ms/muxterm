import { describe, it, expect, afterEach } from 'vitest';

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

  send = () => {};
  close = () => {};
}

// @ts-expect-error mock WebSocket globally
globalThis.WebSocket = MockWebSocket;

// Import app AFTER WebSocket mock is set up
import './app.js';
import type { MuxApp } from './app.js';
import type { TmuxState } from './types.js';

describe('MuxApp workspace integration', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  it('renders mux-workspace after seedWorkspaceForTest', async () => {
    const state: TmuxState = {
      sessions: [
        {
          name: 'work',
          windows: [
            {
              id: 1,
              name: 'bash',
              panes: [{ id: 1, width: 80, height: 24, active: true }],
              layout: '80x24,0,0,1',
            },
          ],
        },
      ],
      activeSession: 'work',
      activeWindow: 1,
      activePane: 1,
    };

    el = document.createElement('mux-app') as MuxApp;
    document.body.appendChild(el);
    await el.updateComplete;

    (el as any).seedWorkspaceForTest('work', 1);
    (el as any).injectStateForTest(state);
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('mux-workspace')).not.toBeNull();
  });
});
