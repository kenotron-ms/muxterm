import { describe, it, expect, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/settings-surface.js';
import type { MuxSettingsSurface } from '../components/settings-surface.js';

async function fixture(serverAddr?: string): Promise<MuxSettingsSurface> {
  const el = document.createElement('mux-settings-surface') as MuxSettingsSurface;
  if (serverAddr !== undefined) el.serverAddr = serverAddr;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxSettingsSurface', () => {
  let el: MuxSettingsSurface;

  afterEach(() => {
    if (el?.parentNode) el.parentNode.removeChild(el);
  });

  it('registers as mux-settings-surface custom element', () => {
    const ctor = customElements.get('mux-settings-surface');
    expect(ctor).toBeDefined();
  });

  it('renders .panel with no .xterm', async () => {
    el = await fixture();
    const panel = el.shadowRoot!.querySelector('.panel');
    expect(panel).toBeTruthy();
    // MUST NOT contain .xterm — this is a non-terminal surface
    const xterm = el.shadowRoot!.querySelector('.xterm');
    expect(xterm).toBeNull();
  });

  it('shows serverAddr and "Tokyo Night" in panel text', async () => {
    el = await fixture('localhost:7681');
    const panel = el.shadowRoot!.querySelector('.panel');
    expect(panel).toBeTruthy();
    const text = panel!.textContent ?? '';
    expect(text).toContain('Tokyo Night');
    expect(text).toContain('localhost:7681');
  });
});
