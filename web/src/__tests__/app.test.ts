import { describe, it, expect, vi, afterEach } from 'vitest';
import { terminalRegistry } from '../lib/terminal-registry.js';
import { parseResolvedConfig } from '../lib/config.js';
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

/** Apply a sessiond composition (the live render source) to the store. */
function applyComposition(
  panes: { paneId: number; cols: number; rows: number; title?: string }[] = [
    { paneId: 5, cols: 80, rows: 24 },
    { paneId: 6, cols: 80, rows: 24 },
  ],
  workspaceId = 'ws-1',
): void {
  store.applySessiond({ type: SessiondType.Composition, workspaceId, panes });
}

async function fixture(withPanes = true): Promise<MuxApp> {
  if (withPanes) applyComposition();
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
    // Reset sessiond store state.
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    // Clean up registry terminals created by _syncTerminals()
    terminalRegistry.prune(new Set());
  });

  it('registers as mux-app custom element', () => {
    const ctor = customElements.get('mux-app');
    expect(ctor).toBeDefined();
  });

  it('renders mux-composition (the live sessiond render surface); no mux-workspace', async () => {
    el = await fixture();
    const composition = el.shadowRoot!.querySelector('mux-composition');
    expect(composition).toBeTruthy();
    // The legacy tmux mux-workspace path is dead — it must NOT render.
    expect(el.shadowRoot!.querySelector('mux-workspace')).toBeNull();
  });

  it('renders a mux-pane host per composition pane', async () => {
    el = await fixture();
    const composition = el.shadowRoot!.querySelector('mux-composition')!;
    await (composition as any).updateComplete;
    const panes = composition.shadowRoot!.querySelectorAll('mux-pane');
    expect(panes.length).toBe(2);
  });

  it('passes the attached workspace id to the status bar', async () => {
    el = await fixture();
    const statusBar = el.shadowRoot!.querySelector('mux-status-bar') as any;
    expect(statusBar).toBeTruthy();
    expect(statusBar.currentWorkspaceId).toBe('ws-1');
  });

  it('renders overlay div', async () => {
    el = await fixture();
    const overlay = el.shadowRoot!.querySelector('.overlay');
    expect(overlay).toBeTruthy();
    expect(overlay!.textContent).toContain('Connecting to muxterm');
  });

  it('overlay is hidden when connected', async () => {
    el = await fixture();
    (el as any)._connectionStatus = 'connected';
    await el.updateComplete;
    const overlay = el.shadowRoot!.querySelector('.overlay');
    expect(overlay!.classList.contains('hidden')).toBe(true);
  });

  it('overlay is visible when disconnected', async () => {
    el = await fixture();
    (el as any)._connectionStatus = 'disconnected';
    await el.updateComplete;
    const overlay = el.shadowRoot!.querySelector('.overlay');
    expect(overlay!.classList.contains('hidden')).toBe(false);
  });

  it('_routePaneOutput calls terminalRegistry.write with paneId and data', async () => {
    el = await fixture();

    const writeSpy = vi.spyOn(terminalRegistry, 'write');
    const testData = new Uint8Array([65, 66, 67]);
    (el as any)._routePaneOutput(5, testData);

    expect(writeSpy).toHaveBeenCalledWith(5, testData);
  });

  it('renders empty state gracefully when no panes', async () => {
    el = await fixture(false);
    // Title bar and status bar always present; no composition.
    const titleBar = el.shadowRoot!.querySelector('mux-title-bar');
    expect(titleBar).toBeTruthy();
    const statusBar = el.shadowRoot!.querySelector('mux-status-bar');
    expect(statusBar).toBeTruthy();
    expect(el.shadowRoot!.querySelector('mux-composition')).toBeNull();
    expect(el.shadowRoot!.querySelector('.empty-session')).toBeTruthy();
  });

  it('passes the workspace list to the status bar', async () => {
    el = await fixture();
    const statusBar = el.shadowRoot!.querySelector('mux-status-bar') as any;
    expect(statusBar).toBeTruthy();
    expect(Array.isArray(statusBar.workspaces)).toBe(true);
  });

  it('disconnects socket on disconnectedCallback', async () => {
    el = await fixture();
    const socket = (el as any)._socket;
    const disconnectSpy = vi.spyOn(socket, 'disconnect');

    el.parentNode!.removeChild(el);

    expect(disconnectSpy).toHaveBeenCalled();
    // Reset el so afterEach doesn't try to remove it again
    el = null as any;
  });

  describe('Workspace Picker', () => {
    it('does not render workspace picker by default', async () => {
      el = await fixture();
      const picker = el.shadowRoot!.querySelector('mux-workspace-picker');
      expect(picker).toBeNull();
    });

    it('renders workspace picker when _showWorkspacePicker is true', async () => {
      el = await fixture();
      (el as any)._showWorkspacePicker = true;
      await el.updateComplete;
      const picker = el.shadowRoot!.querySelector('mux-workspace-picker');
      expect(picker).toBeTruthy();
    });

    it('_onWorkspaceSelected disposes terminals and attaches the chosen workspace', async () => {
      el = await fixture();
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

    it('open-workspace-picker from mux-status-bar opens the workspace picker', async () => {
      el = await fixture();
      expect((el as any)._showWorkspacePicker).toBe(false);
      const statusBar = el.shadowRoot!.querySelector('mux-status-bar')!;
      statusBar.dispatchEvent(
        new CustomEvent('open-workspace-picker', { bubbles: true, composed: true }),
      );
      await el.updateComplete;
      expect((el as any)._showWorkspacePicker).toBe(true);
    });
  });

  describe('Title Bar + Launcher', () => {
    it('renders title bar above the composition', async () => {
      el = await fixture();
      const titleBar = el.shadowRoot!.querySelector('mux-title-bar');
      expect(titleBar).toBeTruthy();
      const composition = el.shadowRoot!.querySelector('mux-composition');
      expect(composition).toBeTruthy();
      // title bar must come before composition in DOM order
      const position = titleBar!.compareDocumentPosition(composition!);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('sets _showWorkspacePicker true when launcher fires new-session', async () => {
      el = await fixture();
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
  });

  describe('Config envelope', () => {
    it('consumes the {type:config,...} envelope: sets store config', async () => {
      el = await fixture();
      const socket = (el as any)._socket;
      socket._controlMessageCb?.({
        type: 'config',
        config: { font: { size: 17 } },
      });
      await el.updateComplete;
      expect(store.config.font.size).toBe(17);
    });
  });

  describe('Reconnect Overlay', () => {
    it('does not render reconnect overlay by default', async () => {
      el = await fixture();
      const overlay = el.shadowRoot!.querySelector('mux-reconnect-overlay');
      expect(overlay).toBeNull();
    });

    it('renders reconnect overlay when showReconnectOverlay is true', async () => {
      el = await fixture();
      (el as any)._showReconnectOverlay = true;
      (el as any)._reconnectMessage = 'Connection lost. Reconnecting...';
      await el.updateComplete;
      const overlay = el.shadowRoot!.querySelector('mux-reconnect-overlay');
      expect(overlay).toBeTruthy();
      expect(overlay!.getAttribute('message')).toBe('Connection lost. Reconnecting...');
    });

    it('shows overlay when onDisconnect fires', async () => {
      el = await fixture();
      const socket = (el as any)._socket;

      socket.onDisconnect?.();
      await el.updateComplete;

      expect((el as any)._showReconnectOverlay).toBe(true);
      const overlay = el.shadowRoot!.querySelector('mux-reconnect-overlay');
      expect(overlay).toBeTruthy();
    });

    it('hides overlay when onReconnect fires', async () => {
      el = await fixture();
      const socket = (el as any)._socket;

      socket.onDisconnect?.();
      await el.updateComplete;
      expect((el as any)._showReconnectOverlay).toBe(true);

      socket.onReconnect?.();
      await el.updateComplete;

      expect((el as any)._showReconnectOverlay).toBe(false);
      const overlay = el.shadowRoot!.querySelector('mux-reconnect-overlay');
      expect(overlay).toBeNull();
    });

    it('shows overlay with reason on detached control message', async () => {
      el = await fixture();
      const socket = (el as any)._socket;

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
