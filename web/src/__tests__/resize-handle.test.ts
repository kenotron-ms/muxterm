import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/resize-handle.js';

import type { MuxResizeHandle } from '../components/resize-handle.js';

function createElement(): MuxResizeHandle {
  return document.createElement('mux-resize-handle') as MuxResizeHandle;
}

async function fixture(
  direction: 'horizontal' | 'vertical' = 'horizontal',
): Promise<MuxResizeHandle> {
  const el = createElement();
  el.direction = direction;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxResizeHandle', () => {
  let el: MuxResizeHandle;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  describe('registration', () => {
    it('registers as mux-resize-handle custom element', () => {
      const Ctor = customElements.get('mux-resize-handle');
      expect(Ctor).toBeDefined();
    });

    it('creates an instance via document.createElement', () => {
      el = createElement();
      expect(el).toBeInstanceOf(HTMLElement);
      expect(el.tagName.toLowerCase()).toBe('mux-resize-handle');
    });
  });

  describe('default properties', () => {
    it('has direction defaulting to horizontal', () => {
      el = createElement();
      expect(el.direction).toBe('horizontal');
    });

    it('reflects direction attribute', async () => {
      el = await fixture('vertical');
      expect(el.getAttribute('direction')).toBe('vertical');
    });
  });

  describe('rendering', () => {
    it('renders a .handle div', async () => {
      el = await fixture();
      const handle = el.shadowRoot!.querySelector('.handle');
      expect(handle).toBeTruthy();
      expect(handle!.tagName.toLowerCase()).toBe('div');
    });

    it('does not have dragging class initially', async () => {
      el = await fixture();
      const handle = el.shadowRoot!.querySelector('.handle')!;
      expect(handle.classList.contains('dragging')).toBe(false);
    });
  });

  describe('drag interaction', () => {
    it('fires resize-drag events during pointer drag', async () => {
      el = await fixture('horizontal');
      const handle = el.shadowRoot!.querySelector('.handle')! as HTMLElement;

      const handler = vi.fn();
      el.addEventListener('resize-drag', handler);

      // Simulate pointerdown
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 100,
          clientY: 200,
          pointerId: 1,
        }),
      );

      // Simulate pointermove
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

    it('adds dragging class during drag', async () => {
      el = await fixture();
      const handle = el.shadowRoot!.querySelector('.handle')! as HTMLElement;

      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 50,
          clientY: 50,
          pointerId: 1,
        }),
      );

      await el.updateComplete;
      expect(handle.classList.contains('dragging')).toBe(true);
    });

    it('removes dragging class on pointerup', async () => {
      el = await fixture();
      const handle = el.shadowRoot!.querySelector('.handle')! as HTMLElement;

      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 50,
          clientY: 50,
          pointerId: 1,
        }),
      );
      await el.updateComplete;

      handle.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          pointerId: 1,
        }),
      );
      await el.updateComplete;

      expect(handle.classList.contains('dragging')).toBe(false);
    });

    it('stops firing resize-drag after pointerup', async () => {
      el = await fixture();
      const handle = el.shadowRoot!.querySelector('.handle')! as HTMLElement;

      const handler = vi.fn();
      el.addEventListener('resize-drag', handler);

      // Start drag
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 50,
          clientY: 50,
          pointerId: 1,
        }),
      );

      // End drag
      handle.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          pointerId: 1,
        }),
      );

      // Move after release — should not fire
      handle.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: 200,
          clientY: 200,
          pointerId: 1,
        }),
      );

      expect(handler).toHaveBeenCalledTimes(0);
    });
  });
});