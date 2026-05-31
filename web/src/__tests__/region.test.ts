import { describe, it, expect, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/region.js';
import type { MuxRegion } from '../components/region.js';
import type { MuxRegionTabstrip } from '../components/region-tabstrip.js';
import type { Window } from '../types.js';

function makeWindow(id: number, name: string): Window {
  return { id, name, panes: [], layout: '' };
}

async function fixture(opts: {
  surfaceKind?: string;
  sessionName?: string;
  windows?: Window[];
  activeWindowId?: number;
  browserUrl?: string;
  serverAddr?: string;
  layoutString?: string;
  activePaneId?: number;
} = {}): Promise<MuxRegion> {
  const el = document.createElement('mux-region') as MuxRegion;
  if (opts.surfaceKind !== undefined) (el as unknown as Record<string, unknown>)['surfaceKind'] = opts.surfaceKind;
  if (opts.sessionName !== undefined) el.sessionName = opts.sessionName;
  if (opts.windows !== undefined) (el as unknown as Record<string, unknown>)['windows'] = opts.windows;
  if (opts.activeWindowId !== undefined) (el as unknown as Record<string, unknown>)['activeWindowId'] = opts.activeWindowId;
  if (opts.browserUrl !== undefined) (el as unknown as Record<string, unknown>)['browserUrl'] = opts.browserUrl;
  if (opts.serverAddr !== undefined) (el as unknown as Record<string, unknown>)['serverAddr'] = opts.serverAddr;
  if (opts.layoutString !== undefined) el.layoutString = opts.layoutString;
  if (opts.activePaneId !== undefined) el.activePaneId = opts.activePaneId;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxRegion', () => {
  let el: MuxRegion;

  afterEach(() => {
    if (el?.parentNode) el.parentNode.removeChild(el);
  });

  it('always renders mux-region-tabstrip as the region header', async () => {
    el = await fixture({ sessionName: 'main' });
    const strip = el.shadowRoot!.querySelector('mux-region-tabstrip');
    expect(strip).toBeTruthy();
  });

  it('routes browser surfaceKind to mux-browser-surface (no mux-layout)', async () => {
    el = await fixture({ surfaceKind: 'browser', browserUrl: 'https://example.com' });
    const browser = el.shadowRoot!.querySelector('mux-browser-surface');
    expect(browser).toBeTruthy();
    const layout = el.shadowRoot!.querySelector('mux-layout');
    expect(layout).toBeNull();
  });

  it('routes settings surfaceKind to mux-settings-surface', async () => {
    el = await fixture({ surfaceKind: 'settings' });
    const settings = el.shadowRoot!.querySelector('mux-settings-surface');
    expect(settings).toBeTruthy();
  });

  it('routes terminal to mux-layout; driver routes to mux-layout and passes isDriver=true to tabstrip', async () => {
    // Terminal surfaceKind → mux-layout present
    el = await fixture({ surfaceKind: 'terminal', layoutString: '' });
    expect(el.shadowRoot!.querySelector('mux-layout')).toBeTruthy();
    el.parentNode?.removeChild(el);

    // Driver surfaceKind → mux-layout present + strip has isDriver=true
    el = await fixture({ surfaceKind: 'driver', windows: [makeWindow(1, 'bash')], activeWindowId: 1 });
    expect(el.shadowRoot!.querySelector('mux-layout')).toBeTruthy();
    const strip = el.shadowRoot!.querySelector('mux-region-tabstrip') as MuxRegionTabstrip;
    expect(strip).toBeTruthy();
    expect(strip.isDriver).toBe(true);
  });
});
