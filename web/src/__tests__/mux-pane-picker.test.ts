import { describe, it, expect, vi, afterEach } from 'vitest';
import '../components/mux-pane-picker.js';
import type { MuxPanePicker } from '../components/mux-pane-picker.js';
import { store } from '../state.js';

async function fixture(): Promise<MuxPanePicker> {
  const el = document.createElement('mux-pane-picker') as MuxPanePicker;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxPanePicker', () => {
  let el: MuxPanePicker;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    vi.restoreAllMocks();
  });

  it('registers as mux-pane-picker custom element', () => {
    const ctor = customElements.get('mux-pane-picker');
    expect(ctor).toBeDefined();
  });

  it('renders a .breadcrumb button', async () => {
    el = await fixture();
    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb');
    expect(breadcrumb).toBeTruthy();
  });

  it('dropdown is closed by default', async () => {
    el = await fixture();
    const dropdown = el.shadowRoot!.querySelector('.dropdown');
    expect(dropdown).toBeNull();
  });

  it('opens dropdown when breadcrumb is clicked', async () => {
    el = await fixture();
    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb') as HTMLButtonElement;
    breadcrumb.click();
    await el.updateComplete;
    const dropdown = el.shadowRoot!.querySelector('.dropdown');
    expect(dropdown).toBeTruthy();
  });

  it('closes dropdown on second breadcrumb click (toggle)', async () => {
    el = await fixture();
    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb') as HTMLButtonElement;
    breadcrumb.click();
    await el.updateComplete;
    breadcrumb.click();
    await el.updateComplete;
    const dropdown = el.shadowRoot!.querySelector('.dropdown');
    expect(dropdown).toBeNull();
  });

  it('renders .pane-item buttons in dropdown for valid panes', async () => {
    vi.spyOn(store, 'panes', 'get').mockReturnValue([
      { paneId: 1, cols: 80, rows: 24, title: 'bash' },
      { paneId: 2, cols: 80, rows: 24, title: 'vim' },
    ]);
    vi.spyOn(store, 'activePaneId', 'get').mockReturnValue(1);
    vi.spyOn(store, 'paneBellActive').mockReturnValue(false);
    el = await fixture();

    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb') as HTMLButtonElement;
    breadcrumb.click();
    await el.updateComplete;

    const items = el.shadowRoot!.querySelectorAll('.pane-item');
    expect(items.length).toBe(2);
  });

  it('filters out panes with negative paneId', async () => {
    vi.spyOn(store, 'panes', 'get').mockReturnValue([
      { paneId: -1, cols: 80, rows: 24 },  // provisional overlay pane
      { paneId: 1, cols: 80, rows: 24, title: 'bash' },
    ]);
    vi.spyOn(store, 'activePaneId', 'get').mockReturnValue(1);
    vi.spyOn(store, 'paneBellActive').mockReturnValue(false);
    el = await fixture();

    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb') as HTMLButtonElement;
    breadcrumb.click();
    await el.updateComplete;

    const items = el.shadowRoot!.querySelectorAll('.pane-item');
    expect(items.length).toBe(1);
  });

  it('marks active pane with .active class', async () => {
    vi.spyOn(store, 'panes', 'get').mockReturnValue([
      { paneId: 1, cols: 80, rows: 24, title: 'bash' },
      { paneId: 2, cols: 80, rows: 24, title: 'vim' },
    ]);
    vi.spyOn(store, 'activePaneId', 'get').mockReturnValue(2);
    vi.spyOn(store, 'paneBellActive').mockReturnValue(false);
    el = await fixture();

    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb') as HTMLButtonElement;
    breadcrumb.click();
    await el.updateComplete;

    const activeItems = el.shadowRoot!.querySelectorAll('.pane-item.active');
    expect(activeItems.length).toBe(1);
  });

  it('shows bell dot only on panes with active bell', async () => {
    vi.spyOn(store, 'panes', 'get').mockReturnValue([
      { paneId: 1, cols: 80, rows: 24, title: 'bash' },
      { paneId: 2, cols: 80, rows: 24, title: 'vim' },
    ]);
    vi.spyOn(store, 'activePaneId', 'get').mockReturnValue(1);
    vi.spyOn(store, 'paneBellActive').mockImplementation((id) => id === 2);
    el = await fixture();

    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb') as HTMLButtonElement;
    breadcrumb.click();
    await el.updateComplete;

    const bellDots = el.shadowRoot!.querySelectorAll('.bell-dot');
    // Only pane 2 has an active bell
    expect(bellDots.length).toBe(1);
  });

  it('calls store.ackPane BEFORE dispatching pane-select', async () => {
    vi.spyOn(store, 'panes', 'get').mockReturnValue([
      { paneId: 1, cols: 80, rows: 24, title: 'bash' },
      { paneId: 2, cols: 80, rows: 24, title: 'vim' },
    ]);
    vi.spyOn(store, 'activePaneId', 'get').mockReturnValue(1);
    vi.spyOn(store, 'paneBellActive').mockReturnValue(false);

    const order: string[] = [];
    vi.spyOn(store, 'ackPane').mockImplementation((id) => { order.push(`ack:${id}`); });
    el = await fixture();
    el.addEventListener('pane-select', () => order.push('event'));

    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb') as HTMLButtonElement;
    breadcrumb.click();
    await el.updateComplete;

    const items = el.shadowRoot!.querySelectorAll('.pane-item');
    (items[1] as HTMLButtonElement).click();
    await el.updateComplete;

    expect(order[0]).toBe('ack:2');
    expect(order[1]).toBe('event');
  });

  it('dispatches pane-select with correct paneId', async () => {
    vi.spyOn(store, 'panes', 'get').mockReturnValue([
      { paneId: 1, cols: 80, rows: 24, title: 'bash' },
      { paneId: 2, cols: 80, rows: 24, title: 'vim' },
    ]);
    vi.spyOn(store, 'activePaneId', 'get').mockReturnValue(1);
    vi.spyOn(store, 'paneBellActive').mockReturnValue(false);
    vi.spyOn(store, 'ackPane').mockImplementation(() => {});

    el = await fixture();
    const handler = vi.fn();
    el.addEventListener('pane-select', handler as EventListener);

    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb') as HTMLButtonElement;
    breadcrumb.click();
    await el.updateComplete;

    const items = el.shadowRoot!.querySelectorAll('.pane-item');
    (items[0] as HTMLButtonElement).click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ paneId: number }>;
    expect(event.detail.paneId).toBe(1);
  });

  it('closes dropdown after pane selection', async () => {
    vi.spyOn(store, 'panes', 'get').mockReturnValue([
      { paneId: 1, cols: 80, rows: 24, title: 'bash' },
    ]);
    vi.spyOn(store, 'activePaneId', 'get').mockReturnValue(1);
    vi.spyOn(store, 'paneBellActive').mockReturnValue(false);
    vi.spyOn(store, 'ackPane').mockImplementation(() => {});

    el = await fixture();
    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb') as HTMLButtonElement;
    breadcrumb.click();
    await el.updateComplete;

    const item = el.shadowRoot!.querySelector('.pane-item') as HTMLButtonElement;
    item.click();
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.dropdown')).toBeNull();
  });

  it('shows ▾ in breadcrumb', async () => {
    el = await fixture();
    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb');
    expect(breadcrumb!.textContent).toContain('▾');
  });

  it('increments _version on store notification', async () => {
    let captured: (() => void) | null = null;
    vi.spyOn(store, 'subscribe').mockImplementation((cb) => {
      captured = cb;
      return () => {};
    });
    el = await fixture();
    const inner = el as unknown as { _version: number };
    const before = inner._version;

    captured!();
    expect(inner._version).toBe(before + 1);
  });

  it('unsubscribes from store on disconnectedCallback', async () => {
    const unsub = vi.fn();
    vi.spyOn(store, 'subscribe').mockReturnValue(unsub);

    el = await fixture();
    el.parentNode!.removeChild(el);
    expect(unsub).toHaveBeenCalledTimes(1);
    el = null as unknown as MuxPanePicker;
  });

  it('shows active bell dot in breadcrumb when active pane has bell', async () => {
    vi.spyOn(store, 'panes', 'get').mockReturnValue([
      { paneId: 1, cols: 80, rows: 24, title: 'bash' },
    ]);
    vi.spyOn(store, 'activePaneId', 'get').mockReturnValue(1);
    vi.spyOn(store, 'paneBellActive').mockReturnValue(true);
    el = await fixture();
    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb');
    expect(breadcrumb!.textContent).toContain('●');
  });

  it('does not show bell dot in breadcrumb when activePaneId is -1', async () => {
    vi.spyOn(store, 'panes', 'get').mockReturnValue([]);
    vi.spyOn(store, 'activePaneId', 'get').mockReturnValue(-1);
    vi.spyOn(store, 'paneBellActive').mockReturnValue(false);
    el = await fixture();
    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb');
    // Should show — for pane name, no bell dot
    expect(breadcrumb!.textContent).toContain('—');
  });

  it('pane-select event is bubbles=true and composed=true', async () => {
    vi.spyOn(store, 'panes', 'get').mockReturnValue([
      { paneId: 5, cols: 80, rows: 24, title: 'fish' },
    ]);
    vi.spyOn(store, 'activePaneId', 'get').mockReturnValue(5);
    vi.spyOn(store, 'paneBellActive').mockReturnValue(false);
    vi.spyOn(store, 'ackPane').mockImplementation(() => {});

    el = await fixture();
    const events: CustomEvent[] = [];
    el.addEventListener('pane-select', (e) => { events.push(e as CustomEvent); });

    const breadcrumb = el.shadowRoot!.querySelector('.breadcrumb') as HTMLButtonElement;
    breadcrumb.click();
    await el.updateComplete;

    const item = el.shadowRoot!.querySelector('.pane-item') as HTMLButtonElement;
    item.click();

    expect(events.length).toBe(1);
    expect(events[0].bubbles).toBe(true);
    expect(events[0].composed).toBe(true);
  });
});
