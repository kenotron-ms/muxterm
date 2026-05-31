import { describe, it, expect, afterEach, vi } from 'vitest';

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

  it('emits a resize-surface event (id, cols, rows) when a surface is measured via measureSurfaceForTest', async () => {
    vi.useFakeTimers();
    try {
      const ws = new Workspace();
      const region = ws.openRegion({ sessionName: 'main', windowId: 1 });
      const surfaceId = region.surface.id;

      const state = makeTmuxState([
        { name: 'main', windows: [{ id: 1, name: 'vim', layout: '', panes: [] }] },
      ]);

      el = await fixture(ws, state);

      const events: CustomEvent<{ surfaceId: string; cols: number; rows: number }>[] = [];
      el.addEventListener('resize-surface', (e) => {
        events.push(e as CustomEvent<{ surfaceId: string; cols: number; rows: number }>);
      });

      // Drive the cell-budget entry point directly (bypasses DOM/ResizeObserver)
      (el as unknown as { measureSurfaceForTest: (id: string, box: { width: number; height: number }, metrics: { cellWidth: number; cellHeight: number }) => void }).measureSurfaceForTest(
        surfaceId,
        { width: 800, height: 400 },
        { cellWidth: 8, cellHeight: 16 },
      );

      // Advance timers past the 40 ms coalescer debounce
      vi.advanceTimersByTime(50);

      expect(events).toHaveLength(1);
      expect(events[0].detail.surfaceId).toBe(surfaceId);
      expect(events[0].detail.cols).toBe(100); // floor(800 / 8)
      expect(events[0].detail.rows).toBe(25);  // floor(400 / 16)
    } finally {
      vi.useRealTimers();
    }
  });

  it('region-resize-drag from divider updates left/right region flex weights proportionally', async () => {
    const ws = new Workspace();
    ws.openRegion({ sessionName: 'main', windowId: 1 });
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

    const initialLeft = ws.regions[0].weight;
    const initialRight = ws.regions[1].weight;
    expect(initialLeft).toBe(1);
    expect(initialRight).toBe(1);

    // Dispatch region-resize-drag from the divider (negative deltaX = drag left = shrink left region)
    const divider = el.shadowRoot!.querySelector('mux-region-divider')!;
    divider.dispatchEvent(
      new CustomEvent('region-resize-drag', {
        bubbles: true,
        composed: true,
        detail: { deltaX: -100, deltaY: 0 },
      }),
    );

    await el.updateComplete;

    // Left region should have smaller weight (dragged left = shrinks left region)
    expect(ws.regions[0].weight).toBeLessThan(ws.regions[1].weight);
  });

  it('does not re-emit when the pixel change stays within the same cell boundary', async () => {
    vi.useFakeTimers();
    try {
      const ws = new Workspace();
      const region = ws.openRegion({ sessionName: 'main', windowId: 1 });
      const surfaceId = region.surface.id;

      const state = makeTmuxState([
        { name: 'main', windows: [{ id: 1, name: 'vim', layout: '', panes: [] }] },
      ]);

      el = await fixture(ws, state);

      const events: CustomEvent[] = [];
      el.addEventListener('resize-surface', (e) => events.push(e as CustomEvent));

      type MeasureFn = { measureSurfaceForTest: (id: string, box: { width: number; height: number }, metrics: { cellWidth: number; cellHeight: number }) => void };

      // First measurement: 800×400 → 100 cols × 25 rows
      (el as unknown as MeasureFn).measureSurfaceForTest(
        surfaceId,
        { width: 800, height: 400 },
        { cellWidth: 8, cellHeight: 16 },
      );
      vi.advanceTimersByTime(50);
      expect(events).toHaveLength(1);

      // Sub-cell pixel change: 804×402 → still 100 cols × 25 rows (no boundary crossed)
      (el as unknown as MeasureFn).measureSurfaceForTest(
        surfaceId,
        { width: 804, height: 402 },
        { cellWidth: 8, cellHeight: 16 },
      );
      vi.advanceTimersByTime(50);

      // Must NOT emit a second event — same cell budget
      expect(events).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
