import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/region-tabstrip.js';
import type { MuxRegionTabstrip } from '../components/region-tabstrip.js';
import type { Window } from '../types.js';

function makeWindow(id: number, name: string): Window {
  return { id, name, panes: [], layout: '' };
}

async function fixture(opts: {
  sessionName?: string;
  windows?: Window[];
  activeWindowId?: number;
  isDriver?: boolean;
  runningWindowIds?: number[];
} = {}): Promise<MuxRegionTabstrip> {
  const el = document.createElement('mux-region-tabstrip') as MuxRegionTabstrip;
  el.sessionName = opts.sessionName ?? 'main';
  el.windows = opts.windows ?? [];
  el.activeWindowId = opts.activeWindowId ?? 0;
  if (opts.isDriver !== undefined) el.isDriver = opts.isDriver;
  if (opts.runningWindowIds !== undefined) el.runningWindowIds = opts.runningWindowIds;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxRegionTabstrip', () => {
  let el: MuxRegionTabstrip;

  afterEach(() => {
    if (el?.parentNode) el.parentNode.removeChild(el);
  });

  it('registers as mux-region-tabstrip custom element', () => {
    const ctor = customElements.get('mux-region-tabstrip');
    expect(ctor).toBeDefined();
  });

  it('renders session chip with session name and tabs for each window', async () => {
    const windows = [makeWindow(1, 'bash'), makeWindow(2, 'vim')];
    el = await fixture({ sessionName: 'mysession', windows });

    const strip = el.shadowRoot!.querySelector('.strip');
    expect(strip).toBeTruthy();

    const chip = el.shadowRoot!.querySelector('.session-chip') as HTMLButtonElement;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('mysession');
    expect(chip.textContent).toContain('▾');

    const tabs = el.shadowRoot!.querySelectorAll('.tab');
    expect(tabs.length).toBe(2);
    expect(tabs[0].textContent).toContain('bash');
    expect(tabs[1].textContent).toContain('vim');

    // Check data-window-id attributes
    expect((tabs[0] as HTMLElement).dataset.windowId).toBe('1');
    expect((tabs[1] as HTMLElement).dataset.windowId).toBe('2');
  });

  it('marks the active window tab with active class', async () => {
    const windows = [makeWindow(1, 'bash'), makeWindow(2, 'vim')];
    el = await fixture({ windows, activeWindowId: 2 });

    const tabs = el.shadowRoot!.querySelectorAll('.tab');
    expect(tabs[0].classList.contains('active')).toBe(false);
    expect(tabs[1].classList.contains('active')).toBe(true);
  });

  it('emits open-session-picker (bubbles, composed) on session chip click', async () => {
    el = await fixture({ sessionName: 'main' });

    const handler = vi.fn();
    el.addEventListener('open-session-picker', handler as EventListener);

    const chip = el.shadowRoot!.querySelector('.session-chip') as HTMLButtonElement;
    expect(chip).toBeTruthy();
    chip.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
  });

  it('emits tab-select (bubbles, composed) with windowId on tab click, and emits region-maximize on maximize button', async () => {
    const windows = [makeWindow(10, 'bash'), makeWindow(20, 'vim')];
    el = await fixture({ windows });

    // Test tab-select
    const selectHandler = vi.fn();
    el.addEventListener('tab-select', selectHandler as EventListener);

    const tabs = el.shadowRoot!.querySelectorAll('.tab');
    (tabs[1] as HTMLElement).click();

    expect(selectHandler).toHaveBeenCalledTimes(1);
    const selectEvent = selectHandler.mock.calls[0][0] as CustomEvent;
    expect(selectEvent.bubbles).toBe(true);
    expect(selectEvent.composed).toBe(true);
    expect(selectEvent.detail.windowId).toBe(20);

    // Test region-maximize
    const maximizeHandler = vi.fn();
    el.addEventListener('region-maximize', maximizeHandler as EventListener);

    const maximizeBtn = el.shadowRoot!.querySelector('.maximize-btn') as HTMLButtonElement;
    expect(maximizeBtn).toBeTruthy();
    maximizeBtn.click();

    expect(maximizeHandler).toHaveBeenCalledTimes(1);
    const maximizeEvent = maximizeHandler.mock.calls[0][0] as CustomEvent;
    expect(maximizeEvent.bubbles).toBe(true);
    expect(maximizeEvent.composed).toBe(true);
  });

  it('shows mux-region-menu inline when more button is clicked (menu managed internally)', async () => {
    // The ⋯ button no longer emits region-menu-open — it manages the dropdown
    // popup internally via a position:fixed portal in the shadow DOM.
    el = await fixture();

    // Menu should not be visible before click.
    expect(el.shadowRoot!.querySelector('mux-region-menu')).toBeNull();

    const moreBtn = el.shadowRoot!.querySelector('.more-btn') as HTMLButtonElement;
    expect(moreBtn).toBeTruthy();
    moreBtn.click();
    await el.updateComplete;

    // After click the menu element is present in the shadow DOM.
    const menu = el.shadowRoot!.querySelector('mux-region-menu');
    expect(menu).toBeTruthy();

    // Clicking the button again should dismiss the menu.
    moreBtn.click();
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('mux-region-menu')).toBeNull();
  });

  it('shows dirty-dot (no tab-close) for running windows', async () => {
    const windows = [makeWindow(1, 'bash'), makeWindow(2, 'vim')];
    // window 1 is running
    el = await fixture({ windows, runningWindowIds: [1] });

    const tabs = el.shadowRoot!.querySelectorAll('.tab');

    // Running window (id=1): should have dirty-dot, no tab-close
    const runningTab = tabs[0] as HTMLElement;
    expect(runningTab.querySelector('.dirty-dot')).toBeTruthy();
    expect(runningTab.querySelector('.tab-close')).toBeFalsy();

    // Non-running window (id=2): should have tab-close, no dirty-dot
    const normalTab = tabs[1] as HTMLElement;
    expect(normalTab.querySelector('.tab-close')).toBeTruthy();
    expect(normalTab.querySelector('.dirty-dot')).toBeFalsy();
  });

  it('applies driver class to strip when isDriver is true', async () => {
    el = await fixture({ isDriver: true });

    const strip = el.shadowRoot!.querySelector('.strip');
    expect(strip).toBeTruthy();
    expect(strip!.classList.contains('driver')).toBe(true);
  });

  it('does not apply driver class to strip when isDriver is false', async () => {
    el = await fixture({ isDriver: false });

    const strip = el.shadowRoot!.querySelector('.strip');
    expect(strip).toBeTruthy();
    expect(strip!.classList.contains('driver')).toBe(false);
  });
});
