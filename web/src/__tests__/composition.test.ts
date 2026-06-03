import { describe, it, expect, vi, afterEach } from 'vitest';

// Import components — triggers custom element registration
import '../components/composition.js';
import '../components/pane.js';

import { terminalRegistry } from '../lib/terminal-registry.js';
import type { MuxComposition } from '../components/composition.js';
import type { Arrangement } from '../lib/layout.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function tilingArrangement(paneIds: number[]): Arrangement {
  return {
    mode: 'tiling',
    order: paneIds,
    visible: paneIds,
    active: paneIds[0] ?? null,
  };
}

async function fixture(): Promise<MuxComposition> {
  const el = document.createElement('mux-composition') as MuxComposition;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('MuxComposition', () => {
  let el: MuxComposition;

  afterEach(() => {
    if (el?.parentNode) el.parentNode.removeChild(el);
    terminalRegistry.prune(new Set());
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Registration
  // ──────────────────────────────────────────────────────────────────────────
  describe('registration', () => {
    it('registers as mux-composition custom element', () => {
      expect(customElements.get('mux-composition')).toBeDefined();
    });

    it('creates an instance via document.createElement', () => {
      el = document.createElement('mux-composition') as MuxComposition;
      expect(el).toBeInstanceOf(HTMLElement);
      expect(el.tagName.toLowerCase()).toBe('mux-composition');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Default properties
  // ──────────────────────────────────────────────────────────────────────────
  describe('default properties', () => {
    it('has an empty arrangement by default', () => {
      el = document.createElement('mux-composition') as MuxComposition;
      expect(el.arrangement).toEqual({
        mode: 'tiling',
        order: [],
        visible: [],
        active: null,
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Rendering — tiling mode
  // ──────────────────────────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders a mux-pane for each visible pane in tiling mode', async () => {
      el = await fixture();
      el.arrangement = tilingArrangement([1, 2]);
      await el.updateComplete;

      const panes = el.shadowRoot!.querySelectorAll('mux-pane');
      expect(panes.length).toBe(2);
    });

    it('renders nothing when visible list is empty', async () => {
      el = await fixture();
      el.arrangement = tilingArrangement([]);
      await el.updateComplete;

      const panes = el.shadowRoot!.querySelectorAll('mux-pane');
      expect(panes.length).toBe(0);
    });

    it('passes the correct pane-id attribute to each mux-pane', async () => {
      el = await fixture();
      el.arrangement = tilingArrangement([3, 7]);
      await el.updateComplete;

      const panes = el.shadowRoot!.querySelectorAll('mux-pane');
      const ids = Array.from(panes).map((p) => p.getAttribute('pane-id'));
      expect(ids).toEqual(['3', '7']);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Rendering — tabbed mode
  // ──────────────────────────────────────────────────────────────────────────
  describe('tabbed mode', () => {
    it('renders a tabstrip with one button per pane in order', async () => {
      el = await fixture();
      el.arrangement = {
        mode: 'tabbed',
        order: [1, 2],
        visible: [1], // only active tab is visible
        active: 1,
      };
      await el.updateComplete;

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      expect(tabs.length).toBe(2);
    });

    it('marks the active tab with class "active"', async () => {
      el = await fixture();
      el.arrangement = {
        mode: 'tabbed',
        order: [1, 2],
        visible: [2],
        active: 2,
      };
      await el.updateComplete;

      const activeTabs = el.shadowRoot!.querySelectorAll('.tab.active');
      expect(activeTabs.length).toBe(1);
    });

    it('dispatches pane-select event when a tab is clicked', async () => {
      el = await fixture();
      el.arrangement = {
        mode: 'tabbed',
        order: [4, 5],
        visible: [4],
        active: 4,
      };
      await el.updateComplete;

      const handler = vi.fn();
      el.addEventListener('pane-select', handler);

      const tabs = el.shadowRoot!.querySelectorAll('.tab');
      (tabs[1] as HTMLButtonElement).click();

      expect(handler).toHaveBeenCalledTimes(1);
      const evt = handler.mock.calls[0][0] as CustomEvent;
      expect(evt.detail.paneId).toBe(5);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Workspace-scoped pane element identity
  //
  // The core regression: pane ids are workspace-local (both workspaces can
  // have a pane with id 1). If the Lit keyed() key is just the pane id,
  // switching workspaces reuses the same <mux-pane> element → its
  // connectedCallback never re-fires → the terminal is never remounted →
  // the viewport is blank.
  //
  // Fix: key by "${workspaceKey}:${paneId}" so switching workspaces forces
  // Lit to destroy the old element and create a fresh one.
  // ──────────────────────────────────────────────────────────────────────────
  describe('workspace-scoped pane element identity', () => {
    it('recreates the mux-pane element when workspaceKey changes with the same paneId', async () => {
      // Prime registry so mux-pane lifecycle calls are no-ops, not errors.
      terminalRegistry.ensure(1, { onInput: vi.fn(), onResize: vi.fn() });

      el = await fixture();
      // Set workspace A with pane 1
      el.workspaceKey = 'wA';
      el.arrangement = tilingArrangement([1]);
      await el.updateComplete;

      const paneBefore = el.shadowRoot!.querySelector('mux-pane');
      expect(paneBefore).toBeTruthy();

      // Simulate switching to workspace B — same pane id, different workspace
      el.workspaceKey = 'wB';
      await el.updateComplete;

      const paneAfter = el.shadowRoot!.querySelector('mux-pane');
      expect(paneAfter).toBeTruthy();

      // KEY ASSERTION: the element must be a NEW instance so that
      // connectedCallback fires and remounts the terminal.
      //
      // RED (before fix):  keyed(paneId) → Lit reuses the element → same ref → FAILS
      // GREEN (after fix): keyed(`${workspaceKey}:${paneId}`) → Lit recreates → PASSES
      expect(paneAfter).not.toBe(paneBefore);
    });

    it('keeps the same mux-pane element when active pane changes within the same workspace and mode', async () => {
      // Stability check: within one workspace and same mode, changing only which
      // pane is "active" must NOT recreate the existing pane elements. If it did,
      // connectedCallback would reattach — discarding the xterm scroll position.
      terminalRegistry.ensure(1, { onInput: vi.fn(), onResize: vi.fn() });
      terminalRegistry.ensure(2, { onInput: vi.fn(), onResize: vi.fn() });

      el = await fixture();
      el.workspaceKey = 'wA';
      el.arrangement = { mode: 'tiling', order: [1, 2], visible: [1, 2], active: 1 };
      await el.updateComplete;

      const pane1Before = Array.from(el.shadowRoot!.querySelectorAll('mux-pane')).find(
        (p) => p.getAttribute('pane-id') === '1',
      );
      expect(pane1Before).toBeTruthy();

      // Change active pane — same workspace key, same mode, same visible panes
      el.arrangement = { mode: 'tiling', order: [1, 2], visible: [1, 2], active: 2 };
      await el.updateComplete;

      const pane1After = Array.from(el.shadowRoot!.querySelectorAll('mux-pane')).find(
        (p) => p.getAttribute('pane-id') === '1',
      );

      // The element for pane 1 must be the same instance — key hasn't changed.
      // RED: before fix — keyed(paneId) without workspaceKey still preserves
      //      element here (same key=1), so this test passes in both phases.
      // GREEN: after fix — keyed(`wA:1`) is still stable → same element. ✓
      expect(pane1After).toBe(pane1Before);
    });
  });
});
