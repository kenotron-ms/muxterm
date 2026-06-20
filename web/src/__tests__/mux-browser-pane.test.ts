/**
 * mux-browser-pane smoke tests.
 *
 * These verify the component module exports correctly and the element is
 * registered. Full DOM/canvas rendering is not tested here — it requires
 * a real browser environment. The acceptance gate is `npm run check:fast`
 * (typecheck + lint), which ensures type correctness.
 */
import { describe, it, expect } from 'vitest';

describe('mux-browser-pane module', () => {
  it('exports MuxBrowserPane class', async () => {
    const mod = await import('../components/mux-browser-pane.js');
    expect(mod.MuxBrowserPane).toBeDefined();
  });

  it('registers custom element mux-browser-pane', async () => {
    await import('../components/mux-browser-pane.js');
    expect(customElements.get('mux-browser-pane')).toBeDefined();
  });
});
