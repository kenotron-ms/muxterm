import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/region-menu.js';
import type { MuxRegionMenu, RegionAction } from '../components/region-menu.js';

async function fixture(): Promise<MuxRegionMenu> {
  const el = document.createElement('mux-region-menu') as MuxRegionMenu;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxRegionMenu', () => {
  let el: MuxRegionMenu;

  afterEach(() => {
    if (el?.parentNode) el.parentNode.removeChild(el);
  });

  it('registers as mux-region-menu custom element', () => {
    const ctor = customElements.get('mux-region-menu');
    expect(ctor).toBeDefined();
  });

  it('renders exactly 5 actions in order and does NOT contain float', async () => {
    el = await fixture();
    const buttons = el.shadowRoot!.querySelectorAll('button[data-action]');
    const actions = Array.from(buttons).map((b) => b.getAttribute('data-action'));
    expect(actions).toHaveLength(5);
    expect(actions).toEqual([
      'split-right',
      'split-down',
      'pop-out',
      'rename',
      'close-region',
    ]);
    expect(actions).not.toContain('float');
  });

  it('dispatches region-action event with the clicked action in detail', async () => {
    el = await fixture();
    const handler = vi.fn();
    el.addEventListener('region-action', handler as EventListener);

    const btn = el.shadowRoot!.querySelector(
      'button[data-action="split-right"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ action: RegionAction }>;
    expect(event.detail.action).toBe('split-right');
  });

  it('styles close-region button with danger class', async () => {
    el = await fixture();
    const closeBtn = el.shadowRoot!.querySelector('button[data-action="close-region"]');
    expect(closeBtn).toBeTruthy();
    expect(closeBtn!.classList.contains('danger')).toBe(true);
  });
});
