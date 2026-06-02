import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock WebSocket BEFORE importing the app (mux-app opens a socket on connect).
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

// Register the live chrome custom elements (import AFTER the WebSocket mock).
import '../app.js';
import '../components/title-bar.js';
import '../components/launcher-menu.js';
import type { MuxApp } from '../app.js';
import type { MuxLauncherMenu } from '../components/launcher-menu.js';

const FORBIDDEN = ['session', 'window', 'region'];

/**
 * Walk the DOM collecting visible text, descending into nested shadow roots
 * and all child nodes, returning concatenated lowercased text.
 */
function deepText(root: Node): string {
  let text = '';

  if (root.nodeType === Node.TEXT_NODE) {
    text += root.textContent ?? '';
  }

  const el = root as Element;
  if (el.shadowRoot) {
    text += deepText(el.shadowRoot);
  }

  root.childNodes.forEach((child) => {
    text += deepText(child);
  });

  return text.toLowerCase();
}

function assertNoForbiddenWords(text: string, where: string): void {
  for (const word of FORBIDDEN) {
    const idx = text.indexOf(word);
    const snippet = idx >= 0 ? text.slice(Math.max(0, idx - 50), idx + 150) : '';
    expect(
      text.includes(word),
      `Forbidden word "${word}" found in ${where}. Snippet: ...${snippet.slice(0, 200)}...`,
    ).toBe(false);
  }
}

describe('terminology guard — live chrome speaks only "workspace"', () => {
  let app: MuxApp | null = null;
  let menu: MuxLauncherMenu | null = null;

  afterEach(() => {
    if (app && app.parentNode) app.parentNode.removeChild(app);
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    app = null;
    menu = null;
  });

  it('the app shell (title bar, status bar, empty workspace state) contains no session/window/region text', async () => {
    app = document.createElement('mux-app') as MuxApp;
    document.body.appendChild(app);
    await app.updateComplete;
    // Let nested children (title-bar, status-bar, empty-workspace) render.
    await Promise.resolve();
    await app.updateComplete;

    const text = deepText(app);
    assertNoForbiddenWords(text, 'mux-app empty-state shell');
  });

  it('the ⋯ app menu contains no session/window/region text', async () => {
    menu = document.createElement('mux-launcher-menu') as MuxLauncherMenu;
    document.body.appendChild(menu);
    await menu.updateComplete;

    const text = deepText(menu);
    assertNoForbiddenWords(text, 'mux-launcher-menu');
  });
});
