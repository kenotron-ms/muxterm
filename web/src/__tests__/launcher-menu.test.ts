import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/launcher-menu.js';
import type { MuxLauncherMenu, LauncherAction } from '../components/launcher-menu.js';

async function fixture(): Promise<MuxLauncherMenu> {
  const el = document.createElement('mux-launcher-menu') as MuxLauncherMenu;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxLauncherMenu', () => {
  let el: MuxLauncherMenu;

  afterEach(() => {
    if (el?.parentNode) el.parentNode.removeChild(el);
  });

  it('registers as mux-launcher-menu custom element', () => {
    const ctor = customElements.get('mux-launcher-menu');
    expect(ctor).toBeDefined();
  });

  it('renders exactly 3 items (new-session, settings, reconnect) — no stubs', async () => {
    el = await fixture();
    const buttons = el.shadowRoot!.querySelectorAll('button[data-action]');
    const actions = Array.from(buttons).map((b) => b.getAttribute('data-action'));
    expect(actions).toEqual(['new-session', 'settings', 'reconnect']);
  });

  it('dispatches launcher-action event with the clicked action in detail', async () => {
    el = await fixture();
    const handler = vi.fn();
    el.addEventListener('launcher-action', handler as EventListener);

    const btn = el.shadowRoot!.querySelector(
      'button[data-action="new-session"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ action: LauncherAction }>;
    expect(event.detail.action).toBe('new-session');
  });

  it('does not render removed stub items (new-browser, open-driver, shortcuts, about)', async () => {
    el = await fixture();
    expect(el.shadowRoot!.querySelector('button[data-action="new-browser"]')).toBeNull();
    expect(el.shadowRoot!.querySelector('button[data-action="open-driver"]')).toBeNull();
    expect(el.shadowRoot!.querySelector('button[data-action="shortcuts"]')).toBeNull();
    expect(el.shadowRoot!.querySelector('button[data-action="about"]')).toBeNull();
  });
});
