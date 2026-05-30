import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Import the component — this triggers custom element registration
import '../components/pane.js';

// Import the registry so we can prime it and clean it up between tests
import { terminalRegistry } from '../lib/terminal-registry.js';

import type { MuxPane } from '../components/pane.js';

function createElement(paneId = 0): MuxPane {
  const el = document.createElement('mux-pane') as MuxPane;
  if (paneId !== 0) el.setAttribute('pane-id', String(paneId));
  return el;
}

async function fixture(paneId = 0): Promise<MuxPane> {
  const el = createElement(paneId);
  document.body.appendChild(el);
  await el.updateComplete;
  // Wait for the connectedCallback updateComplete.then(...) to fire
  await new Promise((r) => setTimeout(r, 50));
  return el;
}

describe('MuxPane', () => {
  let el: MuxPane;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
    // Clean up registry state between tests
    terminalRegistry.prune(new Set());
  });

  // ──────────────────────────────────────────────────────────
  // Registration
  // ──────────────────────────────────────────────────────────
  describe('registration', () => {
    it('registers as mux-pane custom element', () => {
      const Ctor = customElements.get('mux-pane');
      expect(Ctor).toBeDefined();
    });

    it('creates an instance via document.createElement', () => {
      el = createElement();
      expect(el).toBeInstanceOf(HTMLElement);
      expect(el.tagName.toLowerCase()).toBe('mux-pane');
    });
  });

  // ──────────────────────────────────────────────────────────
  // Default properties
  // ──────────────────────────────────────────────────────────
  describe('default properties', () => {
    it('has paneId defaulting to 0', () => {
      el = createElement();
      expect(el.paneId).toBe(0);
    });

    it('has active defaulting to false', () => {
      el = createElement();
      expect(el.active).toBe(false);
    });

    it('reflects pane-id attribute to paneId property', async () => {
      el = createElement();
      el.setAttribute('pane-id', '42');
      document.body.appendChild(el);
      await el.updateComplete;
      expect(el.paneId).toBe(42);
    });

    it('reflects active attribute', async () => {
      el = createElement();
      el.active = true;
      document.body.appendChild(el);
      await el.updateComplete;
      expect(el.hasAttribute('active')).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Rendering
  // ──────────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders a #container div', async () => {
      el = await fixture();
      const container = el.shadowRoot!.querySelector('#container');
      expect(container).toBeTruthy();
      expect(container!.tagName.toLowerCase()).toBe('div');
    });
  });

  // ──────────────────────────────────────────────────────────
  // Terminal attachment (registry-based)
  // ──────────────────────────────────────────────────────────
  describe('terminal attachment', () => {
    it('attaches registry hostEl into #container after ensure + connect', async () => {
      // Prime the registry BEFORE connecting the element
      terminalRegistry.ensure(99, { onInput: vi.fn(), onResize: vi.fn() });

      el = createElement(99);
      document.body.appendChild(el);
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50)); // let updateComplete.then fire

      const container = el.shadowRoot!.querySelector('#container')!;
      // The mock Terminal.open() appends a canvas to hostEl; hostEl is in container
      expect(container.firstChild).toBeTruthy();
    });

    it('does NOT dispose terminal on disconnect — registry still holds it', async () => {
      terminalRegistry.ensure(88, { onInput: vi.fn(), onResize: vi.fn() });

      el = createElement(88);
      document.body.appendChild(el);
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));

      // Spy on the mock terminal's dispose method
      const term = terminalRegistry.getTerminal(88);
      expect(term).toBeTruthy();
      const disposeSpy = vi.spyOn(term!, 'dispose');

      // Disconnect
      el.parentNode!.removeChild(el);

      // dispose must NOT have been called
      expect(disposeSpy).not.toHaveBeenCalled();
      // The registry still has the entry
      expect(terminalRegistry.getTerminal(88)).toBeTruthy();
    });
  });

  // ──────────────────────────────────────────────────────────
  // Events
  // ──────────────────────────────────────────────────────────
  describe('events', () => {
    it('dispatches pane-focus with paneId on container mousedown', async () => {
      el = await fixture(5);

      const handler = vi.fn();
      el.addEventListener('pane-focus', handler);

      const container = el.shadowRoot!.querySelector('#container')!;
      container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0] as CustomEvent;
      expect(event.bubbles).toBe(true);
      expect(event.composed).toBe(true);
      expect(event.detail.paneId).toBe(5);
    });
  });
});
