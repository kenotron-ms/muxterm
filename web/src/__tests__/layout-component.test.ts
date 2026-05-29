import { describe, it, expect, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/layout.js';

import type { MuxLayout } from '../components/layout.js';

function createElement(): MuxLayout {
  return document.createElement('mux-layout') as MuxLayout;
}

async function fixture(layoutString: string, activePaneId = -1): Promise<MuxLayout> {
  const el = createElement();
  el.layoutString = layoutString;
  el.activePaneId = activePaneId;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxLayout', () => {
  let el: MuxLayout;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  it('renders a single pane leaf layout', async () => {
    // Single pane: "bb62,159x48,0,0,1" → leaf with paneId=1
    el = await fixture('bb62,159x48,0,0,1', 1);

    const panes = el.shadowRoot!.querySelectorAll('mux-pane');
    expect(panes).toHaveLength(1);
    expect(panes[0].getAttribute('pane-id')).toBe('1');
  });

  it('renders a horizontal split with 2 panes and resize handle', async () => {
    // Horizontal split: "{79x48,0,0,1,79x48,80,0,2}"
    el = await fixture('bb62,159x48,0,0{79x48,0,0,1,79x48,80,0,2}');

    const panes = el.shadowRoot!.querySelectorAll('mux-pane');
    expect(panes).toHaveLength(2);

    const splitH = el.shadowRoot!.querySelector('.split-h');
    expect(splitH).toBeTruthy();

    // Should have a resize handle between the two children
    const handles = el.shadowRoot!.querySelectorAll('mux-resize-handle');
    expect(handles).toHaveLength(1);
  });

  it('renders nested splits with 3 panes', async () => {
    // Horizontal split with right side being a vertical split
    // {79x48,0,0,1, 79x48,80,0[79x24,80,0,2, 79x23,80,25,3]}
    el = await fixture(
      'd0e0,159x48,0,0{79x48,0,0,1,79x48,80,0[79x24,80,0,2,79x23,80,25,3]}',
    );

    const panes = el.shadowRoot!.querySelectorAll('mux-pane');
    expect(panes).toHaveLength(3);

    const splitH = el.shadowRoot!.querySelector('.split-h');
    expect(splitH).toBeTruthy();

    const splitV = el.shadowRoot!.querySelector('.split-v');
    expect(splitV).toBeTruthy();
  });

  it('shows empty placeholder when layout string is empty', async () => {
    el = await fixture('');

    const empty = el.shadowRoot!.querySelector('.empty');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('No panes');

    const panes = el.shadowRoot!.querySelectorAll('mux-pane');
    expect(panes).toHaveLength(0);
  });
});