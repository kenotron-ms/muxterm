import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import './region.js';

import type { MuxRegion } from './region.js';

async function fixture(opts: {
  regionId?: string;
  surfaceId?: string;
  sessionName?: string;
  windowName?: string;
  layoutString?: string;
  activePaneId?: number;
} = {}): Promise<MuxRegion> {
  const el = document.createElement('mux-region') as MuxRegion;
  if (opts.regionId !== undefined) el.regionId = opts.regionId;
  if (opts.surfaceId !== undefined) el.surfaceId = opts.surfaceId;
  if (opts.sessionName !== undefined) el.sessionName = opts.sessionName;
  if (opts.windowName !== undefined) el.windowName = opts.windowName;
  if (opts.layoutString !== undefined) el.layoutString = opts.layoutString;
  if (opts.activePaneId !== undefined) el.activePaneId = opts.activePaneId;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxRegion', () => {
  let el: MuxRegion;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  it('renders a minimal header showing session and window name', async () => {
    el = await fixture({ sessionName: 'my-session', windowName: 'vim' });

    const header = el.shadowRoot!.querySelector('.header');
    expect(header).toBeTruthy();

    const session = el.shadowRoot!.querySelector('.session');
    expect(session).toBeTruthy();
    expect(session!.textContent).toContain('my-session');

    const headerText = header!.textContent;
    expect(headerText).toContain('vim');
  });

  it('embeds a mux-layout body for Layer 1', async () => {
    el = await fixture({ layoutString: 'bb62,159x48,0,0,1' });

    const body = el.shadowRoot!.querySelector('.body');
    expect(body).toBeTruthy();

    const layout = el.shadowRoot!.querySelector('mux-layout');
    expect(layout).toBeTruthy();
  });

  it('exposes bodyElement for cell-budget measurement (instanceof HTMLElement)', async () => {
    el = await fixture({});

    expect(el.bodyElement).toBeTruthy();
    expect(el.bodyElement).toBeInstanceOf(HTMLElement);
  });

  it('emits region-maximize when the maximize button is clicked (with correct regionId)', async () => {
    el = await fixture({ regionId: 'surface-1' });

    const handler = vi.fn();
    el.addEventListener('region-maximize', handler);

    const button = el.shadowRoot!.querySelector('button[data-action="maximize"]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    button.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
    expect(event.detail.regionId).toBe('surface-1');
  });
});
