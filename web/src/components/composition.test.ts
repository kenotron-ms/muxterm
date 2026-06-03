import { describe, it, expect, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import './composition.js';

import type { MuxComposition } from './composition.js';
import type { Arrangement } from '../lib/layout.js';

async function fixture(arrangement: Arrangement): Promise<MuxComposition> {
  const el = document.createElement('mux-composition') as MuxComposition;
  el.arrangement = arrangement;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxComposition', () => {
  let el: MuxComposition;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });

  it('registers as a custom element', () => {
    expect(customElements.get('mux-composition')).toBeDefined();
  });

  it('tiling mode renders one mux-pane per visible pane', async () => {
    el = await fixture({ mode: 'tiling', order: [5, 6], visible: [5, 6], active: 5 });
    const panes = el.shadowRoot!.querySelectorAll('mux-pane');
    expect(panes.length).toBe(2);
    const ids = Array.from(panes).map((p) => Number(p.getAttribute('pane-id')));
    expect(ids).toEqual([5, 6]);
  });

  it('marks the active pane as active', async () => {
    el = await fixture({ mode: 'tiling', order: [5, 6], visible: [5, 6], active: 6 });
    const active = el.shadowRoot!.querySelector('mux-pane[pane-id="6"]');
    expect(active!.hasAttribute('active')).toBe(true);
    const inactive = el.shadowRoot!.querySelector('mux-pane[pane-id="5"]');
    expect(inactive!.hasAttribute('active')).toBe(false);
  });

  it('tabbed mode renders only the visible pane plus a tab per pane in order', async () => {
    el = await fixture({ mode: 'tabbed', order: [5, 6, 7], visible: [6], active: 6 });
    const panes = el.shadowRoot!.querySelectorAll('mux-pane');
    expect(panes.length).toBe(1);
    expect(panes[0].getAttribute('pane-id')).toBe('6');
    const tabs = el.shadowRoot!.querySelectorAll('.tab');
    expect(tabs.length).toBe(3);
  });

  it('clicking a tab emits pane-select with the paneId', async () => {
    el = await fixture({ mode: 'tabbed', order: [5, 6], visible: [5], active: 5 });
    let selected = -1;
    el.addEventListener('pane-select', (e) => {
      selected = (e as CustomEvent<{ paneId: number }>).detail.paneId;
    });
    const tabs = el.shadowRoot!.querySelectorAll<HTMLElement>('.tab');
    tabs[1].click();
    expect(selected).toBe(6);
  });

  it('renders nothing when there are no visible panes', async () => {
    el = await fixture({ mode: 'tiling', order: [], visible: [], active: null });
    expect(el.shadowRoot!.querySelector('mux-pane')).toBeNull();
  });
});
