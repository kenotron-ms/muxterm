import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import './region-divider.js';

import type { MuxRegionDivider } from './region-divider.js';

function createElement(): MuxRegionDivider {
  return document.createElement('mux-region-divider') as MuxRegionDivider;
}

async function fixture(
  direction: 'horizontal' | 'vertical' = 'horizontal',
): Promise<MuxRegionDivider> {
  const el = createElement();
  el.direction = direction;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxRegionDivider', () => {
  let el: MuxRegionDivider;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  it('renders a grab handle (.handle in shadowRoot)', async () => {
    el = await fixture();
    const handle = el.shadowRoot!.querySelector('.handle');
    expect(handle).toBeTruthy();
    expect(handle!.tagName.toLowerCase()).toBe('div');
  });

  it('reflects direction to an attribute (for cursor CSS)', async () => {
    el = await fixture('vertical');
    expect(el.getAttribute('direction')).toBe('vertical');
  });

  it('emits region-resize-drag with a pixel delta on pointer drag', async () => {
    el = await fixture('horizontal');
    const handle = el.shadowRoot!.querySelector('.handle')! as HTMLElement;

    // Stub setPointerCapture since happy-dom may not implement it
    handle.setPointerCapture = vi.fn();

    const handler = vi.fn();
    el.addEventListener('region-resize-drag', handler);

    // Simulate pointerdown at (100, 200)
    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 100,
        clientY: 200,
        pointerId: 1,
      }),
    );

    // Simulate pointermove to (130, 210) — delta should be (30, 10)
    handle.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 130,
        clientY: 210,
        pointerId: 1,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
    expect(event.detail.deltaX).toBe(30);
    expect(event.detail.deltaY).toBe(10);
  });
});
