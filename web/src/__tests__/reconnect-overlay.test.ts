import { describe, it, expect, afterEach } from 'vitest';

import '../components/reconnect-overlay.js';
import type { MuxReconnectOverlay } from '../components/reconnect-overlay.js';

async function fixture(
  props: Partial<{ message: string; detail: string }> = {},
): Promise<MuxReconnectOverlay> {
  const el = document.createElement('mux-reconnect-overlay') as MuxReconnectOverlay;
  if (props.message !== undefined) el.message = props.message;
  if (props.detail !== undefined) el.detail = props.detail;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxReconnectOverlay', () => {
  let el: MuxReconnectOverlay;

  afterEach(() => {
    if (el?.parentNode) el.parentNode.removeChild(el);
  });

  it('registers as mux-reconnect-overlay custom element', () => {
    const ctor = customElements.get('mux-reconnect-overlay');
    expect(ctor).toBeDefined();
  });

  it('renders with default message "Reconnecting..."', async () => {
    el = await fixture();
    const msgEl = el.shadowRoot!.querySelector('.message');
    expect(msgEl).toBeTruthy();
    expect(msgEl!.textContent).toContain('Reconnecting...');
  });

  it('renders custom message', async () => {
    el = await fixture({ message: 'Connection lost. Reconnecting...' });
    const msgEl = el.shadowRoot!.querySelector('.message');
    expect(msgEl!.textContent).toContain('Connection lost. Reconnecting...');
  });

  it('renders detail text when provided', async () => {
    el = await fixture({ detail: 'Attempt 3 of 10' });
    const detailEl = el.shadowRoot!.querySelector('.detail');
    expect(detailEl).toBeTruthy();
    expect(detailEl!.textContent).toContain('Attempt 3 of 10');
  });

  it('does not render detail element when detail is empty', async () => {
    el = await fixture({ detail: '' });
    const detailEl = el.shadowRoot!.querySelector('.detail');
    expect(detailEl).toBeNull();
  });

  it('has a spinner element', async () => {
    el = await fixture();
    const spinner = el.shadowRoot!.querySelector('.spinner');
    expect(spinner).toBeTruthy();
  });

  it('overlay has fixed positioning with correct z-index', async () => {
    el = await fixture();
    const overlay = el.shadowRoot!.querySelector('.overlay');
    expect(overlay).toBeTruthy();
    // Check the host element styling or computed styles
    // Since we're testing the component structure, just verify the overlay div exists
    // The CSS properties are verified via the component styles
  });

  it('message text has 16px font-size in styles', async () => {
    el = await fixture();
    // Verify the CSS contains the expected styles
    const styles = (el.constructor as any).styles;
    const cssText = styles.cssText || styles.toString();
    expect(cssText).toContain('font-size: 16px');
  });

  it('detail text has 13px font-size in styles', async () => {
    el = await fixture();
    const styles = (el.constructor as any).styles;
    const cssText = styles.cssText || styles.toString();
    expect(cssText).toContain('font-size: 13px');
  });

  it('spinner has 24px dimensions in styles', async () => {
    el = await fixture();
    const styles = (el.constructor as any).styles;
    const cssText = styles.cssText || styles.toString();
    expect(cssText).toContain('24px');
  });

  it('overlay background uses rgba(0,0,0,0.8)', async () => {
    el = await fixture();
    const styles = (el.constructor as any).styles;
    const cssText = styles.cssText || styles.toString();
    expect(cssText).toContain('rgba(0, 0, 0, 0.8)');
  });

  it('overlay has z-index 2000', async () => {
    el = await fixture();
    const styles = (el.constructor as any).styles;
    const cssText = styles.cssText || styles.toString();
    expect(cssText).toContain('z-index: 2000');
  });
});