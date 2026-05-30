import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { terminalRegistry } from '../lib/terminal-registry.js';

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
    // Simulate open after microtask
    queueMicrotask(() => {
      if (this.onopen) this.onopen();
    });
  }

  send = vi.fn();
  close = vi.fn();
}

// @ts-expect-error mock WebSocket globally
globalThis.WebSocket = MockWebSocket;

// Need to import app AFTER WebSocket mock is set up
import '../app.js';
import type { MuxApp } from '../app.js';
import { store } from '../state.js';
import type { TmuxState } from '../types.js';

function makeState(overrides: Partial<TmuxState> = {}): TmuxState {
  return {
    sessions: [
      {
        name: 'main',
        windows: [
          { id: 1, name: 'bash', panes: [{ id: 5, width: 80, height: 24, active: true }], layout: '80x24,0,0,5' },
          { id: 2, name: 'vim', panes: [{ id: 6, width: 80, height: 24, active: true }], layout: '80x24,0,0,6' },
        ],
      },
    ],
    activeSession: 'main',
    activeWindow: 1,
    activePane: 5,
    ...overrides,
  };
}

async function fixture(state?: TmuxState): Promise<MuxApp> {
  if (state) {
    // Apply state via applyMessage
    store.applyMessage({ type: 'state', data: state });
  }
  const el = document.createElement('mux-app') as MuxApp;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxApp', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
    // Reset store state
    store.applyMessage({
      type: 'state',
      data: { sessions: [], activeSession: '', activeWindow: 0, activePane: 0 },
    });
    // Clean up registry terminals created by _syncTerminals()
    terminalRegistry.prune(new Set());
  });

  it('registers as mux-app custom element', () => {
    const ctor = customElements.get('mux-app');
    expect(ctor).toBeDefined();
  });

  it('renders mux-tab-bar with windows and active window', async () => {
    el = await fixture(makeState());
    const tabBar = el.shadowRoot!.querySelector('mux-tab-bar');
    expect(tabBar).toBeTruthy();
    expect(tabBar!.getAttribute('active-window-id')).toBe('1');
  });

  it('renders mux-layout with layout string and active pane', async () => {
    el = await fixture(makeState());
    const layout = el.shadowRoot!.querySelector('mux-layout');
    expect(layout).toBeTruthy();
    expect(layout!.getAttribute('layout-string')).toBe('80x24,0,0,5');
    expect(layout!.getAttribute('active-pane-id')).toBe('5');
  });

  it('renders mux-status-bar with session info', async () => {
    el = await fixture(makeState());
    const statusBar = el.shadowRoot!.querySelector('mux-status-bar');
    expect(statusBar).toBeTruthy();
    expect(statusBar!.getAttribute('sessionname')).toBe('main');
    expect(statusBar!.getAttribute('activewindowname')).toBe('bash');
  });

  it('renders overlay div', async () => {
    el = await fixture(makeState());
    const overlay = el.shadowRoot!.querySelector('.overlay');
    expect(overlay).toBeTruthy();
    expect(overlay!.textContent).toContain('Connecting to muxterm');
  });

  it('overlay is hidden when connected', async () => {
    el = await fixture(makeState());
    // Manually set connected status
    (el as any)._connectionStatus = 'connected';
    await el.updateComplete;
    const overlay = el.shadowRoot!.querySelector('.overlay');
    expect(overlay!.classList.contains('hidden')).toBe(true);
  });

  it('overlay is visible when disconnected', async () => {
    el = await fixture(makeState());
    (el as any)._connectionStatus = 'disconnected';
    await el.updateComplete;
    const overlay = el.shadowRoot!.querySelector('.overlay');
    expect(overlay!.classList.contains('hidden')).toBe(false);
  });

  it('translates tab-select event to sendControl select-window', async () => {
    el = await fixture(makeState());
    const socket = (el as any)._socket;
    const sendControlSpy = vi.spyOn(socket, 'sendControl');

    const tabBar = el.shadowRoot!.querySelector('mux-tab-bar')!;
    tabBar.dispatchEvent(
      new CustomEvent('tab-select', {
        bubbles: true,
        composed: true,
        detail: { windowId: 2 },
      }),
    );

    expect(sendControlSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'select-window', windowId: 2 }),
    );
  });

  it('translates tab-new event to sendControl new-window', async () => {
    el = await fixture(makeState());
    const socket = (el as any)._socket;
    const sendControlSpy = vi.spyOn(socket, 'sendControl');

    const tabBar = el.shadowRoot!.querySelector('mux-tab-bar')!;
    tabBar.dispatchEvent(
      new CustomEvent('tab-new', {
        bubbles: true,
        composed: true,
      }),
    );

    expect(sendControlSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'new-window' }),
    );
  });

  it('translates tab-close event to sendControl close-pane with windowId', async () => {
    el = await fixture(makeState());
    const socket = (el as any)._socket;
    const sendControlSpy = vi.spyOn(socket, 'sendControl');

    const tabBar = el.shadowRoot!.querySelector('mux-tab-bar')!;
    tabBar.dispatchEvent(
      new CustomEvent('tab-close', {
        bubbles: true,
        composed: true,
        detail: { windowId: 1 },
      }),
    );

    expect(sendControlSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'close-pane', paneId: 1 }),
    );
  });

  it('translates pane-focus event to sendControl select-pane', async () => {
    el = await fixture(makeState());
    const socket = (el as any)._socket;
    const sendControlSpy = vi.spyOn(socket, 'sendControl');

    const layout = el.shadowRoot!.querySelector('mux-layout')!;
    layout.dispatchEvent(
      new CustomEvent('pane-focus', {
        bubbles: true,
        composed: true,
        detail: { paneId: 5 },
      }),
    );

    expect(sendControlSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'select-pane', paneId: 5 }),
    );
  });

  it('_routePaneOutput calls terminalRegistry.write with paneId and data', async () => {
    el = await fixture(makeState());

    const writeSpy = vi.spyOn(terminalRegistry, 'write');
    const testData = new Uint8Array([65, 66, 67]);
    (el as any)._routePaneOutput(5, testData);

    expect(writeSpy).toHaveBeenCalledWith(5, testData);
  });

  it('renders empty state gracefully when no sessions', async () => {
    el = await fixture();
    // Should render without errors
    const tabBar = el.shadowRoot!.querySelector('mux-tab-bar');
    expect(tabBar).toBeTruthy();
  });

  it('passes windowCount and paneCount to status bar', async () => {
    el = await fixture(makeState());
    const statusBar = el.shadowRoot!.querySelector('mux-status-bar') as any;
    expect(statusBar).toBeTruthy();
    // windowCount should be 2 (two windows in the session)
    expect(statusBar.windowCount).toBe(2);
    // paneCount should be 1 (one pane in the active window)
    expect(statusBar.paneCount).toBe(1);
  });

  it('disconnects socket on disconnectedCallback', async () => {
    el = await fixture(makeState());
    const socket = (el as any)._socket;
    const disconnectSpy = vi.spyOn(socket, 'disconnect');

    el.parentNode!.removeChild(el);

    expect(disconnectSpy).toHaveBeenCalled();
    // Reset el so afterEach doesn't try to remove it again
    el = null as any;
  });

  describe('Session Picker', () => {
    it('does not render session picker by default', async () => {
      el = await fixture(makeState());
      const picker = el.shadowRoot!.querySelector('mux-session-picker');
      expect(picker).toBeNull();
    });

    it('renders session picker when showSessionPicker is true', async () => {
      el = await fixture(makeState());
      (el as any)._showSessionPicker = true;
      (el as any)._sessions = [
        { name: 'dev', windows: 2 },
        { name: 'test', windows: 1 },
      ];
      await el.updateComplete;
      const picker = el.shadowRoot!.querySelector('mux-session-picker');
      expect(picker).toBeTruthy();
    });

    it('passes sessions to session picker', async () => {
      el = await fixture(makeState());
      const sessions = [
        { name: 'dev', windows: 2 },
        { name: 'staging', windows: 3 },
      ];
      (el as any)._showSessionPicker = true;
      (el as any)._sessions = sessions;
      await el.updateComplete;
      const picker = el.shadowRoot!.querySelector('mux-session-picker') as any;
      expect(picker).toBeTruthy();
      expect(picker.sessions).toEqual(sessions);
    });

    it('shows session picker when control message has sessions key', async () => {
      el = await fixture(makeState());
      const socket = (el as any)._socket;

      // Trigger the control message callback
      const sessionsMsg = {
        sessions: [
          { name: 'dev', windows: 3 },
          { name: 'staging', windows: 1 },
        ],
      };
      socket._controlMessageCb?.(sessionsMsg);
      await el.updateComplete;

      const picker = el.shadowRoot!.querySelector('mux-session-picker');
      expect(picker).toBeTruthy();
      expect((picker as any).sessions).toEqual(sessionsMsg.sessions);
    });

    it('hides session picker and sends attach-session on session-selected', async () => {
      el = await fixture(makeState());
      const socket = (el as any)._socket;
      const sendRawSpy = vi.spyOn(socket, 'sendRaw');

      // Show the picker first
      (el as any)._showSessionPicker = true;
      (el as any)._sessions = [{ name: 'dev', windows: 2 }];
      await el.updateComplete;

      const picker = el.shadowRoot!.querySelector('mux-session-picker')!;
      picker.dispatchEvent(
        new CustomEvent('session-selected', {
          bubbles: true,
          composed: true,
          detail: { name: 'dev' },
        }),
      );
      await el.updateComplete;

      // Picker should be hidden
      expect((el as any)._showSessionPicker).toBe(false);
      const pickerAfter = el.shadowRoot!.querySelector('mux-session-picker');
      expect(pickerAfter).toBeNull();

      // Should have sent attach-session JSON via ws
      expect(sendRawSpy).toHaveBeenCalledWith(JSON.stringify({ 'attach-session': 'dev' }));
    });
  });

  describe('Reconnect Overlay', () => {
    it('does not render reconnect overlay by default', async () => {
      el = await fixture(makeState());
      const overlay = el.shadowRoot!.querySelector('mux-reconnect-overlay');
      expect(overlay).toBeNull();
    });

    it('renders reconnect overlay when showReconnectOverlay is true', async () => {
      el = await fixture(makeState());
      (el as any)._showReconnectOverlay = true;
      (el as any)._reconnectMessage = 'Connection lost. Reconnecting...';
      await el.updateComplete;
      const overlay = el.shadowRoot!.querySelector('mux-reconnect-overlay');
      expect(overlay).toBeTruthy();
      expect(overlay!.getAttribute('message')).toBe('Connection lost. Reconnecting...');
    });

    it('shows overlay when onDisconnect fires', async () => {
      el = await fixture(makeState());
      const socket = (el as any)._socket;

      // Trigger onDisconnect
      socket.onDisconnect?.();
      await el.updateComplete;

      expect((el as any)._showReconnectOverlay).toBe(true);
      const overlay = el.shadowRoot!.querySelector('mux-reconnect-overlay');
      expect(overlay).toBeTruthy();
    });

    it('hides overlay when onReconnect fires', async () => {
      el = await fixture(makeState());
      const socket = (el as any)._socket;

      // Show overlay first
      socket.onDisconnect?.();
      await el.updateComplete;
      expect((el as any)._showReconnectOverlay).toBe(true);

      // Reconnect
      socket.onReconnect?.();
      await el.updateComplete;

      expect((el as any)._showReconnectOverlay).toBe(false);
      const overlay = el.shadowRoot!.querySelector('mux-reconnect-overlay');
      expect(overlay).toBeNull();
    });

    it('shows overlay with reason on detached control message', async () => {
      el = await fixture(makeState());
      const socket = (el as any)._socket;

      // Trigger control message with detached key
      const detachedMsg = { detached: { reason: 'Session ended by admin' } };
      socket._controlMessageCb?.(detachedMsg);
      await el.updateComplete;

      expect((el as any)._showReconnectOverlay).toBe(true);
      const overlay = el.shadowRoot!.querySelector('mux-reconnect-overlay');
      expect(overlay).toBeTruthy();
      expect(overlay!.getAttribute('message')).toBe('Session ended by admin');
    });
  });
});