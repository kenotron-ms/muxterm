import { describe, it, expect, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/browser-surface.js';
import type { MuxBrowserSurface } from '../components/browser-surface.js';

async function fixture(url?: string): Promise<MuxBrowserSurface> {
  const el = document.createElement('mux-browser-surface') as MuxBrowserSurface;
  if (url !== undefined) el.url = url;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxBrowserSurface', () => {
  let el: MuxBrowserSurface;

  afterEach(() => {
    if (el?.parentNode) el.parentNode.removeChild(el);
  });

  it('registers as mux-browser-surface custom element', () => {
    const ctor = customElements.get('mux-browser-surface');
    expect(ctor).toBeDefined();
  });

  it('renders iframe pointed at url and has no .xterm', async () => {
    el = await fixture('https://example.com');
    const iframe = el.shadowRoot!.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe!.getAttribute('src')).toBe('https://example.com');
    // MUST NOT contain .xterm — this is a non-terminal surface
    const xterm = el.shadowRoot!.querySelector('.xterm');
    expect(xterm).toBeNull();
  });

  it('navigates via address bar and dispatches url-change', async () => {
    el = await fixture('about:blank');

    const received: CustomEvent[] = [];
    el.addEventListener('url-change', (e) => received.push(e as CustomEvent));

    const input = el.shadowRoot!.querySelector('.address') as HTMLInputElement;
    expect(input).toBeTruthy();

    // Simulate user typing a new URL and committing via change event
    input.value = 'https://new-url.com';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(received).toHaveLength(1);
    expect(received[0].bubbles).toBe(true);
    expect(received[0].composed).toBe(true);
    expect(received[0].detail).toEqual({ url: 'https://new-url.com' });
  });

  it('renders three .nav-btn buttons (back, forward, refresh)', async () => {
    el = await fixture('about:blank');
    const navBtns = el.shadowRoot!.querySelectorAll('.nav-btn');
    expect(navBtns.length).toBe(3);
  });

  it('iframe sandbox includes allow-popups', async () => {
    el = await fixture('about:blank');
    const iframe = el.shadowRoot!.querySelector('iframe');
    expect(iframe!.getAttribute('sandbox')).toContain('allow-popups');
  });

  it('CSS does not reference undefined CSS variables for bg/fg/border/accent', async () => {
    el = await fixture('about:blank');
    // Collect all stylesheet text from the component's adopted styles
    const styles = (el.constructor as typeof MuxBrowserSurface).styles;
    const cssText = Array.isArray(styles)
      ? styles.map((s) => s.toString()).join('\n')
      : String(styles);
    expect(cssText).not.toContain('var(--mux-bg)');
    expect(cssText).not.toContain('var(--mux-fg)');
    expect(cssText).not.toContain('var(--mux-border)');
    expect(cssText).not.toContain('var(--mux-accent)');
  });
});
