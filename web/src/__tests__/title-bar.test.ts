import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/title-bar.js';
import type { MuxTitleBar } from '../components/title-bar.js';

async function fixture(): Promise<MuxTitleBar> {
  const el = document.createElement('mux-title-bar') as MuxTitleBar;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxTitleBar', () => {
  let el: MuxTitleBar;

  afterEach(() => {
    if (el?.parentNode) el.parentNode.removeChild(el);
  });

  it('registers as mux-title-bar custom element', () => {
    const ctor = customElements.get('mux-title-bar');
    expect(ctor).toBeDefined();
  });

  it('shows branding and launcher button with menu closed by default', async () => {
    el = await fixture();
    // Brand section present
    const brand = el.shadowRoot!.querySelector('.brand');
    expect(brand).toBeTruthy();
    expect(brand!.textContent).toContain('muxterm');

    // Launcher button present
    const launcherBtn = el.shadowRoot!.querySelector('.launcher-btn');
    expect(launcherBtn).toBeTruthy();
    expect(launcherBtn!.textContent).toContain('⋯');

    // Menu not rendered by default
    const menu = el.shadowRoot!.querySelector('mux-launcher-menu');
    expect(menu).toBeNull();
  });

  it('toggles menu open when launcher button is clicked', async () => {
    el = await fixture();
    const launcherBtn = el.shadowRoot!.querySelector('.launcher-btn') as HTMLButtonElement;
    expect(launcherBtn).toBeTruthy();

    // Menu not present before click
    expect(el.shadowRoot!.querySelector('mux-launcher-menu')).toBeNull();

    // Click to open
    launcherBtn.click();
    await el.updateComplete;

    const menu = el.shadowRoot!.querySelector('mux-launcher-menu');
    expect(menu).toBeTruthy();

    // Click again to close
    launcherBtn.click();
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('mux-launcher-menu')).toBeNull();
  });

  it('re-emits launcher-action and closes menu after selection', async () => {
    el = await fixture();
    const launcherBtn = el.shadowRoot!.querySelector('.launcher-btn') as HTMLButtonElement;
    launcherBtn.click();
    await el.updateComplete;

    // Menu should be open
    const menu = el.shadowRoot!.querySelector('mux-launcher-menu');
    expect(menu).toBeTruthy();

    // Listen for re-dispatched event on the host element
    const handler = vi.fn();
    el.addEventListener('launcher-action', handler as EventListener);

    // Fire launcher-action from the menu (simulating composed event)
    menu!.dispatchEvent(
      new CustomEvent('launcher-action', {
        bubbles: true,
        composed: true,
        detail: { action: 'settings' },
      }),
    );

    await el.updateComplete;

    // Menu should now be closed
    expect(el.shadowRoot!.querySelector('mux-launcher-menu')).toBeNull();

    // Event re-dispatched from the title bar
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ action: string }>;
    expect(event.detail.action).toBe('settings');
  });
});
