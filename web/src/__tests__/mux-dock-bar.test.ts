import { describe, it, expect, vi, afterEach } from 'vitest';
import '../components/mux-dock-bar.js';
import type { MuxDockBar } from '../components/mux-dock-bar.js';
import { store } from '../state.js';
import type { SessiondWorkspaceInfo } from '../types.js';

function makeWorkspaces(): SessiondWorkspaceInfo[] {
  return [
    { workspaceId: 'ws-1', name: 'main', paneCount: 3 },
    { workspaceId: 'ws-2', paneCount: 1 },
    { workspaceId: 'ws-3', name: 'logs', paneCount: 2 },
  ];
}

async function fixture(
  workspaces: SessiondWorkspaceInfo[] = [],
  activeWorkspaceId = '',
): Promise<MuxDockBar> {
  // Component is fully store-driven: mock store getters so render sees test data.
  vi.spyOn(store, 'workspaces', 'get').mockReturnValue(workspaces);
  vi.spyOn(store, 'attached', 'get').mockReturnValue(activeWorkspaceId || null);
  const el = document.createElement('mux-dock-bar') as MuxDockBar;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxDockBar', () => {
  let el: MuxDockBar;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    vi.restoreAllMocks();
  });

  it('registers as mux-dock-bar custom element', () => {
    const ctor = customElements.get('mux-dock-bar');
    expect(ctor).toBeDefined();
  });

  it('renders one .ws-btn per workspace', async () => {
    el = await fixture(makeWorkspaces());
    const btns = el.shadowRoot!.querySelectorAll('.ws-btn');
    expect(btns.length).toBe(3);
  });

  it('marks the active workspace with class active', async () => {
    el = await fixture(makeWorkspaces(), 'ws-2');
    const activeBtns = el.shadowRoot!.querySelectorAll('.ws-btn.active');
    expect(activeBtns.length).toBe(1);
  });

  it('shows bell dot only on non-active workspaces with active bell', async () => {
    // ws-2 has bell (not active), ws-1 has bell (is active — should NOT show bell)
    vi.spyOn(store, 'workspaceBellActive').mockImplementation(
      (id) => id === 'ws-2' || id === 'ws-1',
    );
    el = await fixture(makeWorkspaces(), 'ws-1');
    const bellDots = el.shadowRoot!.querySelectorAll('.bell-dot');
    // ws-1 is active → no bell; ws-2 has bell and is not active → bell shown; ws-3 no bell
    expect(bellDots.length).toBe(1);
  });

  it('no bell dots when no bells are active', async () => {
    vi.spyOn(store, 'workspaceBellActive').mockReturnValue(false);
    el = await fixture(makeWorkspaces(), 'ws-1');
    const bellDots = el.shadowRoot!.querySelectorAll('.bell-dot');
    expect(bellDots.length).toBe(0);
  });

  it('calls store.ackWorkspace before dispatching workspace-switch on click', async () => {
    const order: string[] = [];
    vi.spyOn(store, 'ackWorkspace').mockImplementation((id) => {
      order.push(`ack:${id}`);
    });
    el = await fixture(makeWorkspaces(), 'ws-1');
    el.addEventListener('workspace-switch', () => order.push('event'));

    const btn = el.shadowRoot!.querySelectorAll('.ws-btn')[1] as HTMLButtonElement;
    btn.click();

    expect(order[0]).toBe('ack:ws-2');
    expect(order[1]).toBe('event');
  });

  it('dispatches workspace-switch with correct workspaceId on click', async () => {
    vi.spyOn(store, 'ackWorkspace').mockImplementation(() => {});
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('workspace-switch', handler as EventListener);

    const btn = el.shadowRoot!.querySelectorAll('.ws-btn')[0] as HTMLButtonElement;
    btn.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ workspaceId: string }>;
    expect(event.detail.workspaceId).toBe('ws-1');
  });

  it('dispatches workspace-create when new workspace button is clicked', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('workspace-create', handler as EventListener);

    const btn = el.shadowRoot!.querySelector('.new-ws-btn') as HTMLButtonElement;
    btn.click();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('renders a .new-ws-btn after workspace buttons', async () => {
    el = await fixture(makeWorkspaces());
    const newBtn = el.shadowRoot!.querySelector('.new-ws-btn');
    expect(newBtn).toBeTruthy();
  });

  it('renders a .conn-dot with the connectionStatus class', async () => {
    el = await fixture(makeWorkspaces());
    el.connectionStatus = 'connected';
    await el.updateComplete;
    const dot = el.shadowRoot!.querySelector('.conn-dot');
    expect(dot).toBeTruthy();
    expect(dot!.classList.contains('connected')).toBe(true);
  });

  it('conn-dot reflects disconnected status', async () => {
    el = await fixture(makeWorkspaces());
    el.connectionStatus = 'disconnected';
    await el.updateComplete;
    const dot = el.shadowRoot!.querySelector('.conn-dot');
    expect(dot!.classList.contains('disconnected')).toBe(true);
  });

  it('conn-dot reflects reconnecting status', async () => {
    el = await fixture(makeWorkspaces());
    el.connectionStatus = 'reconnecting';
    await el.updateComplete;
    const dot = el.shadowRoot!.querySelector('.conn-dot');
    expect(dot!.classList.contains('reconnecting')).toBe(true);
  });

  it('increments _version when store notifies (triggers re-render)', async () => {
    let captured: (() => void) | null = null;
    vi.spyOn(store, 'subscribe').mockImplementation((cb) => {
      captured = cb;
      return () => {};
    });

    el = await fixture(makeWorkspaces());
    const inner = el as unknown as { _version: number };
    const before = inner._version;

    // Simulate a store notification
    captured!();

    expect(inner._version).toBe(before + 1);
  });

  it('unsubscribes from store on disconnectedCallback', async () => {
    const unsub = vi.fn();
    vi.spyOn(store, 'subscribe').mockReturnValue(unsub);

    el = await fixture(makeWorkspaces());
    el.parentNode!.removeChild(el);
    // el is now disconnected
    expect(unsub).toHaveBeenCalledTimes(1);
    // prevent afterEach from double-removing
    el = null as unknown as MuxDockBar;
  });

  it('defaults connectionStatus to disconnected', async () => {
    el = await fixture([]);
    expect(el.connectionStatus).toBe('disconnected');
  });
});

describe('MuxDockBar — workspaceLabel integration', () => {
  let el: MuxDockBar;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    vi.restoreAllMocks();
  });

  it('uses workspace name when available', async () => {
    vi.spyOn(store, 'workspaces', 'get').mockReturnValue([{ workspaceId: 'ws-9', name: 'alpha', paneCount: 0 }]);
    el = document.createElement('mux-dock-bar') as MuxDockBar;
    document.body.appendChild(el);
    await el.updateComplete;
    const btn = el.shadowRoot!.querySelector('.ws-btn');
    expect(btn!.textContent?.trim()).toBe('alpha');
  });

  it('falls back to id-derived label for unnamed workspaces', async () => {
    vi.spyOn(store, 'workspaces', 'get').mockReturnValue([{ workspaceId: 'ws-3', paneCount: 0 }]);
    el = document.createElement('mux-dock-bar') as MuxDockBar;
    document.body.appendChild(el);
    await el.updateComplete;
    const btn = el.shadowRoot!.querySelector('.ws-btn');
    expect(btn!.textContent?.trim()).toBe('workspace 3');
  });
});
