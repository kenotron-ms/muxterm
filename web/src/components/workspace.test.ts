import { describe, it, expect, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import './workspace.js';

import type { MuxWorkspace } from './workspace.js';
import { Workspace } from '../lib/workspace.js';
import type { TmuxState } from '../types.js';

function makeTmuxState(
  sessions: Array<{
    name: string;
    windows: Array<{
      id: number;
      name: string;
      layout: string;
      panes: Array<{ id: number; active: boolean; width: number; height: number }>;
    }>;
  }>,
): TmuxState {
  return {
    sessions: sessions.map((s) => ({
      name: s.name,
      windows: s.windows.map((w) => ({
        id: w.id,
        name: w.name,
        layout: w.layout,
        panes: w.panes,
      })),
    })),
    activeSession: sessions[0]?.name ?? '',
    activeWindow: sessions[0]?.windows[0]?.id ?? 0,
    activePane: sessions[0]?.windows[0]?.panes[0]?.id ?? 0,
  };
}

async function fixture(ws: Workspace, state: TmuxState): Promise<MuxWorkspace> {
  const el = document.createElement('mux-workspace') as MuxWorkspace;
  el.workspace = ws;
  el.tmuxState = state;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxWorkspace', () => {
  let el: MuxWorkspace;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  it('renders one region with no divider for a single surface', async () => {
    const ws = new Workspace();
    ws.openRegion({ sessionName: 'main', windowId: 1 });

    const state = makeTmuxState([
      {
        name: 'main',
        windows: [
          {
            id: 1,
            name: 'vim',
            layout: 'bb62,159x48,0,0,1',
            panes: [{ id: 1, active: true, width: 80, height: 24 }],
          },
        ],
      },
    ]);

    el = await fixture(ws, state);

    const regions = el.shadowRoot!.querySelectorAll('mux-region');
    const dividers = el.shadowRoot!.querySelectorAll('mux-region-divider');
    expect(regions).toHaveLength(1);
    expect(dividers).toHaveLength(0);
  });

  it('renders N regions with N-1 dividers when docked (2 regions => 1 divider)', async () => {
    const ws = new Workspace();
    ws.openRegion({ sessionName: 'main', windowId: 1 });
    ws.openRegion({ sessionName: 'main', windowId: 2 });

    const state = makeTmuxState([
      {
        name: 'main',
        windows: [
          {
            id: 1,
            name: 'vim',
            layout: 'bb62,159x48,0,0,1',
            panes: [{ id: 1, active: true, width: 80, height: 24 }],
          },
          {
            id: 2,
            name: 'htop',
            layout: 'bb63,159x48,0,0,2',
            panes: [{ id: 2, active: true, width: 80, height: 24 }],
          },
        ],
      },
    ]);

    el = await fixture(ws, state);

    const regions = el.shadowRoot!.querySelectorAll('mux-region');
    const dividers = el.shadowRoot!.querySelectorAll('mux-region-divider');
    expect(regions).toHaveLength(2);
    expect(dividers).toHaveLength(1);
  });

  it('maximize event collapses to a single visible region', async () => {
    const ws = new Workspace();
    const r1 = ws.openRegion({ sessionName: 'main', windowId: 1 });
    ws.openRegion({ sessionName: 'main', windowId: 2 });

    const state = makeTmuxState([
      {
        name: 'main',
        windows: [
          { id: 1, name: 'vim', layout: '', panes: [] },
          { id: 2, name: 'htop', layout: '', panes: [] },
        ],
      },
    ]);

    el = await fixture(ws, state);

    // Before maximize: 2 regions visible
    expect(el.shadowRoot!.querySelectorAll('mux-region')).toHaveLength(2);

    // Dispatch region-maximize for r1
    el.dispatchEvent(
      new CustomEvent('region-maximize', {
        bubbles: true,
        composed: true,
        detail: { regionId: r1.id },
      }),
    );

    await el.updateComplete;

    // After maximize: only 1 region visible
    expect(el.shadowRoot!.querySelectorAll('mux-region')).toHaveLength(1);
  });

  it('passes the window layout string down to its region', async () => {
    const ws = new Workspace();
    ws.openRegion({ sessionName: 'main', windowId: 1 });

    const layoutString = 'bb62,159x48,0,0,1';
    const state = makeTmuxState([
      {
        name: 'main',
        windows: [
          {
            id: 1,
            name: 'vim',
            layout: layoutString,
            panes: [{ id: 1, active: true, width: 80, height: 24 }],
          },
        ],
      },
    ]);

    el = await fixture(ws, state);

    const regionEl = el.shadowRoot!.querySelector('mux-region') as HTMLElement & {
      layoutString: string;
    };
    expect(regionEl).toBeTruthy();
    expect(regionEl.layoutString).toBe(layoutString);
  });
});
