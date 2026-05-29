import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — this triggers custom element registration
import '../components/pane.js';

// Type alias for our component to access internal mock Terminal
import type { MuxPane } from '../components/pane.js';

// Mock Terminal interface — test helpers exposed by setup.ts mock
interface MockTerminal {
  getWrittenData(): Uint8Array[];
  simulateInput(data: string): void;
  _onResizeCbs: Array<(size: { cols: number; rows: number }) => void>;
  focus(): void;
  dispose(): void;
}

function createElement(): MuxPane {
  const el = document.createElement('mux-pane') as MuxPane;
  return el;
}

async function fixture(): Promise<MuxPane> {
  const el = createElement();
  document.body.appendChild(el);
  await el.updateComplete;
  // Wait for connectedCallback async init
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

describe('MuxPane', () => {
  let el: MuxPane;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

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

  describe('rendering', () => {
    it('renders a #container div', async () => {
      el = await fixture();
      const container = el.shadowRoot!.querySelector('#container');
      expect(container).toBeTruthy();
      expect(container!.tagName.toLowerCase()).toBe('div');
    });
  });

  describe('terminal initialization', () => {
    it('creates a terminal inside the container after connect', async () => {
      el = await fixture();
      const container = el.shadowRoot!.querySelector('#container');
      // The mock Terminal.open() appends a canvas element
      const canvas = container!.querySelector('canvas');
      expect(canvas).toBeTruthy();
    });
  });

  describe('public API', () => {
    it('writeData writes string data to the terminal', async () => {
      el = await fixture();
      el.writeData('hello');
      // Access the mock terminal to verify
      const term = (el as any)._term as MockTerminal;
      expect(term).toBeTruthy();
      const written = term.getWrittenData();
      expect(written.length).toBeGreaterThan(0);
    });

    it('writeData writes Uint8Array data to the terminal', async () => {
      el = await fixture();
      const data = new Uint8Array([104, 101, 108, 108, 111]);
      el.writeData(data);
      const term = (el as any)._term as MockTerminal;
      const written = term.getWrittenData();
      expect(written.length).toBeGreaterThan(0);
    });

    it('focusTerminal calls focus on the terminal', async () => {
      el = await fixture();
      const term = (el as any)._term as MockTerminal;
      const spy = vi.spyOn(term, 'focus');
      el.focusTerminal();
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('events', () => {
    it('dispatches pane-input with paneId and data when terminal receives input', async () => {
      el = await fixture();
      el.paneId = 7;

      const handler = vi.fn();
      el.addEventListener('pane-input', handler);

      const term = (el as any)._term as MockTerminal;
      term.simulateInput('test-data');

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0] as CustomEvent;
      expect(event.bubbles).toBe(true);
      expect(event.composed).toBe(true);
      expect(event.detail.paneId).toBe(7);
      expect(event.detail.data).toBeInstanceOf(Uint8Array);
      // Verify the data content is the encoded string
      const decoded = new TextDecoder().decode(event.detail.data);
      expect(decoded).toBe('test-data');
    });

    it('dispatches pane-resize with paneId, cols, rows when terminal resizes', async () => {
      el = await fixture();
      el.paneId = 3;

      const handler = vi.fn();
      el.addEventListener('pane-resize', handler);

      const term = (el as any)._term as MockTerminal;
      // Trigger resize callbacks
      for (const cb of term._onResizeCbs) {
        cb({ cols: 120, rows: 40 });
      }

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0] as CustomEvent;
      expect(event.bubbles).toBe(true);
      expect(event.composed).toBe(true);
      expect(event.detail.paneId).toBe(3);
      expect(event.detail.cols).toBe(120);
      expect(event.detail.rows).toBe(40);
    });

    it('dispatches pane-focus with paneId on container mousedown', async () => {
      el = await fixture();
      el.paneId = 5;

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

  describe('cleanup', () => {
    it('disposes terminal on disconnect', async () => {
      el = await fixture();
      const term = (el as any)._term as MockTerminal;
      const spy = vi.spyOn(term, 'dispose');

      el.parentNode!.removeChild(el);

      expect(spy).toHaveBeenCalled();
    });
  });
});