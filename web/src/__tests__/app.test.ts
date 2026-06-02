import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { terminalRegistry } from '../lib/terminal-registry.js';
import { parseResolvedConfig } from '../lib/config.js';

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
import { installKeybindings } from '../app.js';
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

  it('renders mux-workspace (tab-bar removed; tabs now inside each region)', async () => {
    el = await fixture(makeState());
    // The old mux-tab-bar is gone — the workspace renders per-region tabstrips.
    const workspace = el.shadowRoot!.querySelector('mux-workspace');
    expect(workspace).toBeTruthy();
    // mux-tab-bar must NOT exist in the app shadow DOM (it was removed).
    const tabBar = el.shadowRoot!.querySelector('mux-tab-bar');
    expect(tabBar).toBeNull();
  });

  it('renders mux-workspace for the active window', async () => {
    el = await fixture(makeState());
    const workspace = el.shadowRoot!.querySelector('mux-workspace');
    expect(workspace).toBeTruthy();
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

    // Events now bubble from mux-workspace (where the handlers are bound).
    const workspace = el.shadowRoot!.querySelector('mux-workspace')!;
    expect(workspace).toBeTruthy();
    workspace.dispatchEvent(
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

    const workspace = el.shadowRoot!.querySelector('mux-workspace')!;
    expect(workspace).toBeTruthy();
    workspace.dispatchEvent(
      new CustomEvent('tab-new', {
        bubbles: true,
        composed: true,
      }),
    );

    expect(sendControlSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'new-window' }),
    );
  });

  it('translates tab-close event to sendControl close-window with windowId', async () => {
    el = await fixture(makeState());
    const socket = (el as any)._socket;
    const sendControlSpy = vi.spyOn(socket, 'sendControl');

    const workspace = el.shadowRoot!.querySelector('mux-workspace')!;
    expect(workspace).toBeTruthy();
    workspace.dispatchEvent(
      new CustomEvent('tab-close', {
        bubbles: true,
        composed: true,
        detail: { windowId: 1 },
      }),
    );

    expect(sendControlSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'close-window', windowId: 1 }),
    );
  });

  it('translates pane-focus event to sendControl select-pane', async () => {
    el = await fixture(makeState());
    const socket = (el as any)._socket;
    const sendControlSpy = vi.spyOn(socket, 'sendControl');

    const workspace = el.shadowRoot!.querySelector('mux-workspace')!;
    workspace.dispatchEvent(
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
    // Should render without errors; title bar and status bar always present.
    const titleBar = el.shadowRoot!.querySelector('mux-title-bar');
    expect(titleBar).toBeTruthy();
    const statusBar = el.shadowRoot!.querySelector('mux-status-bar');
    expect(statusBar).toBeTruthy();
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

  describe('Workspace Picker', () => {
    it('does not render workspace picker by default', async () => {
      el = await fixture(makeState());
      const picker = el.shadowRoot!.querySelector('mux-workspace-picker');
      expect(picker).toBeNull();
    });

    it('renders workspace picker when _showWorkspacePicker is true', async () => {
      el = await fixture(makeState());
      (el as any)._showWorkspacePicker = true;
      await el.updateComplete;
      const picker = el.shadowRoot!.querySelector('mux-workspace-picker');
      expect(picker).toBeTruthy();
    });

    it('updates sessions from store on session-list control message (no auto-open)', async () => {
      el = await fixture(makeState());
      const socket = (el as any)._socket;

      // Pre-populate store with a session list
      store.applyMessage({
        type: 'session-list',
        data: { sessions: [{ name: 'dev', windows: 3 }, { name: 'staging', windows: 1 }] },
      });

      // Trigger the control message callback with the session-list key
      socket._controlMessageCb?.({ 'session-list': { sessions: [] } });
      await el.updateComplete;

      // Picker should NOT be auto-shown
      const picker = el.shadowRoot!.querySelector('mux-workspace-picker');
      expect(picker).toBeNull();

      // _sessions should be updated from store.sessionList
      expect((el as any)._sessions).toEqual([
        { name: 'dev', windows: 3 },
        { name: 'staging', windows: 1 },
      ]);
    });

    it('_onWorkspaceSelected disposes terminals and attaches the chosen workspace', async () => {
      el = await fixture(makeState());
      const disposeSpy = vi.spyOn(terminalRegistry, 'disposeAll');
      const attached: string[] = [];
      (el as any)._socket = {
        attach: (id: string) => attached.push(id),
        connected: true,
        disconnect: () => {},
      };
      (el as any)._showWorkspacePicker = true;

      (el as any)._onWorkspaceSelected(
        new CustomEvent('workspace-selected', { detail: { workspaceId: 'ws-2' } }),
      );

      expect(disposeSpy).toHaveBeenCalled();
      expect(attached).toContain('ws-2');
      expect((el as any)._showWorkspacePicker).toBe(false);
    });

    it('_onSessionSelected (legacy) sends attach-session via typed sendControl and hides picker', async () => {
      el = await fixture(makeState());
      const sent: unknown[] = [];
      (el as any)._socket = {
        sendControl: (m: unknown) => sent.push(m),
        connected: true,
        disconnect: () => {},
      };
      (el as any)._showWorkspacePicker = true;

      (el as any)._onSessionSelected(
        new CustomEvent('session-selected', { detail: { name: 'ops' } }),
      );

      expect(sent).toContainEqual({ type: 'attach-session', name: 'ops' });
      expect((el as any)._showWorkspacePicker).toBe(false);
    });

    it('hides picker and sends attach-session on session-selected from mux-workspace', async () => {
      el = await fixture(makeState());
      const socket = (el as any)._socket;
      const sendControlSpy = vi.spyOn(socket, 'sendControl');

      (el as any)._showWorkspacePicker = true;
      await el.updateComplete;

      const workspace = el.shadowRoot!.querySelector('mux-workspace')!;
      workspace.dispatchEvent(
        new CustomEvent('session-selected', {
          bubbles: true,
          composed: true,
          detail: { name: 'dev' },
        }),
      );
      await el.updateComplete;

      // Picker should be hidden
      expect((el as any)._showWorkspacePicker).toBe(false);

      // Should have sent attach-session via sendControl
      expect(sendControlSpy).toHaveBeenCalledWith({ type: 'attach-session', name: 'dev' });
    });
  });

  describe('Title Bar + Launcher', () => {
    it('renders title bar above everything (before mux-workspace)', async () => {
      el = await fixture(makeState());
      const titleBar = el.shadowRoot!.querySelector('mux-title-bar');
      expect(titleBar).toBeTruthy();
      // The old mux-tab-bar is removed; check against mux-workspace instead.
      const workspace = el.shadowRoot!.querySelector('mux-workspace');
      expect(workspace).toBeTruthy();
      // title bar must come before workspace in DOM order
      const position = titleBar!.compareDocumentPosition(workspace!);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('sets _showWorkspacePicker true when launcher fires new-session', async () => {
      el = await fixture(makeState());
      expect((el as any)._showWorkspacePicker).toBe(false);
      const titleBar = el.shadowRoot!.querySelector('mux-title-bar')!;
      titleBar.dispatchEvent(
        new CustomEvent('launcher-action', {
          bubbles: true,
          composed: true,
          detail: { action: 'new-session' },
        }),
      );
      await el.updateComplete;
      expect((el as any)._showWorkspacePicker).toBe(true);
    });

    it('open-session-picker from mux-workspace opens the workspace picker', async () => {
      el = await fixture(makeState());
      expect((el as any)._showWorkspacePicker).toBe(false);
      const workspace = el.shadowRoot!.querySelector('mux-workspace')!;
      expect(workspace).toBeTruthy();
      workspace.dispatchEvent(
        new CustomEvent('open-session-picker', { bubbles: true, composed: true }),
      );
      await el.updateComplete;
      expect((el as any)._showWorkspacePicker).toBe(true);
    });

    it('_ensureActiveRegion does not open a region when one is detached (pop-out race)', async () => {
      el = await fixture(makeState());
      const ws = (el as any)._workspace;
      // The workspace starts with 1 region auto-opened by _ensureActiveRegion
      expect(ws.regions.length).toBe(1);
      const region = ws.regions[0];

      // Simulate _detachRegion: remove from regions and track as detached
      ws.regions = [];
      // After fix: detachedRegionIds exists and blocks _ensureActiveRegion from re-creating
      if (ws.detachedRegionIds) {
        ws.detachedRegionIds.add(region.id);
      }

      // Trigger willUpdate → _ensureActiveRegion
      el.requestUpdate();
      await el.updateComplete;

      // regions must still be empty — no ghost region was created
      expect(ws.regions.length).toBe(0);
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

describe('installKeybindings', () => {
  it('dispatches the open-launcher action for the configured chord', () => {
    store.setConfig(parseResolvedConfig({ keys: { open_launcher: 'ctrl+shift+p' } }));
    const openLauncher = vi.fn();
    const remove = installKeybindings({ openLauncher });
    const e = new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true });
    window.dispatchEvent(e);
    expect(openLauncher).toHaveBeenCalledOnce();
    remove();
  });
});