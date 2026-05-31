import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/workspace.js';

import type { MuxWorkspace } from '../components/workspace.js';
import { Workspace } from '../lib/workspace.js';
import { PopoutManager } from '../lib/popout.js';
import type { TmuxState } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmuxState(
  sessions: Array<{
    name: string;
    windows: Array<{ id: number; name: string; layout: string }>;
  }>,
): TmuxState {
  return {
    sessions: sessions.map((s) => ({
      name: s.name,
      windows: s.windows.map((w) => ({
        id: w.id,
        name: w.name,
        layout: w.layout,
        panes: [],
      })),
    })),
    activeSession: sessions[0]?.name ?? '',
    activeWindow: sessions[0]?.windows[0]?.id ?? 0,
    activePane: 0,
  };
}

async function fixture(
  ws: Workspace,
  state: TmuxState,
  pm: PopoutManager,
): Promise<MuxWorkspace> {
  const el = document.createElement('mux-workspace') as MuxWorkspace;
  el.workspace = ws;
  el.tmuxState = state;
  // Inject the test popout manager (contract-test hook)
  (el as unknown as { _popoutManager: PopoutManager })._popoutManager = pm;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

/** Find the mux-region with a given regionId in the workspace shadow DOM. */
function findRegionEl(el: MuxWorkspace, regionId: string): Element | undefined {
  const regionEls = el.shadowRoot!.querySelectorAll('mux-region');
  return Array.from(regionEls).find(
    (r) => (r as unknown as { regionId: string }).regionId === regionId,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MuxWorkspace pop-out orchestration', () => {
  let el: MuxWorkspace;
  let mockWin: { closed: boolean; close: ReturnType<typeof vi.fn> };
  let openFn: ReturnType<typeof vi.fn>;
  let pm: PopoutManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWin = { closed: false, close: vi.fn() };
    openFn = vi.fn().mockReturnValue(mockWin);
    pm = new PopoutManager({
      open: openFn,
      pollIntervalMs: 400,
      origin: 'http://localhost',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (el?.parentNode) el.parentNode.removeChild(el);
    pm.dispose();
  });

  // -------------------------------------------------------------------------
  // Helper: trigger region-menu-open → region-action(pop-out) sequence
  // -------------------------------------------------------------------------

  async function triggerPopOut(workspaceEl: MuxWorkspace, regionId: string): Promise<void> {
    // Step 1: Fire region-menu-open on the mux-region element so workspace
    // records which region's menu is open.
    const regionEl = findRegionEl(workspaceEl, regionId);
    expect(regionEl).toBeTruthy();
    regionEl!.dispatchEvent(
      new CustomEvent('region-menu-open', { bubbles: true, composed: true }),
    );
    await workspaceEl.updateComplete;

    // Step 2: The workspace should now render a mux-region-menu.
    const menu = workspaceEl.shadowRoot!.querySelector('mux-region-menu');
    expect(menu).toBeTruthy();

    // Step 3: Dispatch the pop-out action from the menu.
    menu!.dispatchEvent(
      new CustomEvent('region-action', {
        bubbles: true,
        composed: true,
        detail: { action: 'pop-out' },
      }),
    );
    await workspaceEl.updateComplete;
  }

  // -------------------------------------------------------------------------
  // Test 1: region is removed from the in-page layout when popped out
  // -------------------------------------------------------------------------

  it('removes region from layout when popped out', async () => {
    const ws = new Workspace();
    const r1 = ws.openRegion({ sessionName: 'main', windowId: 1 });
    ws.openRegion({ sessionName: 'main', windowId: 2 });

    const state = makeTmuxState([
      {
        name: 'main',
        windows: [
          { id: 1, name: 'vim', layout: '' },
          { id: 2, name: 'htop', layout: '' },
        ],
      },
    ]);

    el = await fixture(ws, state, pm);

    // Initially 2 regions rendered
    expect(el.shadowRoot!.querySelectorAll('mux-region')).toHaveLength(2);

    await triggerPopOut(el, r1.id);

    // After pop-out: only 1 region in-page
    expect(el.shadowRoot!.querySelectorAll('mux-region')).toHaveLength(1);
    // The remaining region is r2 (not r1)
    expect(findRegionEl(el, r1.id)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 2: region is remounted when the popped window closes
  // -------------------------------------------------------------------------

  it('remounts region when popout window closes', async () => {
    const ws = new Workspace();
    const r1 = ws.openRegion({ sessionName: 'main', windowId: 1 });
    ws.openRegion({ sessionName: 'main', windowId: 2 });

    const state = makeTmuxState([
      {
        name: 'main',
        windows: [
          { id: 1, name: 'vim', layout: '' },
          { id: 2, name: 'htop', layout: '' },
        ],
      },
    ]);

    el = await fixture(ws, state, pm);

    await triggerPopOut(el, r1.id);

    // After pop-out: 1 region in-page
    expect(el.shadowRoot!.querySelectorAll('mux-region')).toHaveLength(1);

    // Simulate the popout window closing
    mockWin.closed = true;
    vi.advanceTimersByTime(400); // poll interval
    await el.updateComplete;

    // After close: region is remounted → 2 regions again
    expect(el.shadowRoot!.querySelectorAll('mux-region')).toHaveLength(2);
    expect(findRegionEl(el, r1.id)).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Test 3: region stays docked when popup is blocked (never loses region)
  // -------------------------------------------------------------------------

  it('keeps region docked (never loses it) when popup is blocked', async () => {
    const blockedOpenFn = vi.fn().mockReturnValue(null); // window.open returns null = blocked
    const blockedPm = new PopoutManager({
      open: blockedOpenFn,
      pollIntervalMs: 400,
      origin: 'http://localhost',
    });

    const ws = new Workspace();
    const r1 = ws.openRegion({ sessionName: 'main', windowId: 1 });
    ws.openRegion({ sessionName: 'main', windowId: 2 });

    const state = makeTmuxState([
      {
        name: 'main',
        windows: [
          { id: 1, name: 'vim', layout: '' },
          { id: 2, name: 'htop', layout: '' },
        ],
      },
    ]);

    // Inject the blocked manager
    const blockedEl = document.createElement('mux-workspace') as MuxWorkspace;
    blockedEl.workspace = ws;
    blockedEl.tmuxState = state;
    (blockedEl as unknown as { _popoutManager: PopoutManager })._popoutManager = blockedPm;
    document.body.appendChild(blockedEl);
    await blockedEl.updateComplete;

    // Initially 2 regions
    expect(blockedEl.shadowRoot!.querySelectorAll('mux-region')).toHaveLength(2);

    // Trigger pop-out (will be blocked)
    const regionEl = findRegionEl(blockedEl, r1.id);
    expect(regionEl).toBeTruthy();
    regionEl!.dispatchEvent(
      new CustomEvent('region-menu-open', { bubbles: true, composed: true }),
    );
    await blockedEl.updateComplete;

    const menu = blockedEl.shadowRoot!.querySelector('mux-region-menu');
    expect(menu).toBeTruthy();

    // Spy on console.warn to verify it was called
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    menu!.dispatchEvent(
      new CustomEvent('region-action', {
        bubbles: true,
        composed: true,
        detail: { action: 'pop-out' },
      }),
    );
    await blockedEl.updateComplete;

    // Region count must NOT decrease — region is never lost
    expect(blockedEl.shadowRoot!.querySelectorAll('mux-region')).toHaveLength(2);
    // Warning should have been emitted
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    blockedEl.parentNode!.removeChild(blockedEl);
    blockedPm.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 4: menu disappears after an action is taken
  // -------------------------------------------------------------------------

  it('hides region-menu after action is taken', async () => {
    const ws = new Workspace();
    const r1 = ws.openRegion({ sessionName: 'main', windowId: 1 });
    ws.openRegion({ sessionName: 'main', windowId: 2 });

    const state = makeTmuxState([
      {
        name: 'main',
        windows: [
          { id: 1, name: 'vim', layout: '' },
          { id: 2, name: 'htop', layout: '' },
        ],
      },
    ]);

    el = await fixture(ws, state, pm);

    await triggerPopOut(el, r1.id);

    // After the action, menu should be dismissed
    const menu = el.shadowRoot!.querySelector('mux-region-menu');
    expect(menu).toBeNull();
  });
});
