import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../components/mux-undo-toast.js';
import type { MuxUndoToast } from '../components/mux-undo-toast.js';

describe('MuxUndoToast', () => {
  let el: MuxUndoToast;

  beforeEach(async () => {
    el = document.createElement('mux-undo-toast') as MuxUndoToast;
    el.paneId = 42;
    el.paneTitle = 'bash';
    el.duration = 3000;
    document.body.appendChild(el);
    await el.updateComplete;
  });

  afterEach(() => {
    el.remove();
  });

  it('initialises _remaining to ceil(duration / 1000)', () => {
    // duration=3000 → remaining=3
    expect((el as unknown as { _remaining: number })._remaining).toBe(3);
  });

  it('_armed flips to true after a rAF', async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await el.updateComplete;
    expect((el as unknown as { _armed: boolean })._armed).toBe(true);
  });

  it('disconnectedCallback clears the interval', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const intervalId = (el as unknown as { _interval: ReturnType<typeof setInterval> | undefined })._interval;
    el.remove();
    expect(clearSpy).toHaveBeenCalledWith(intervalId);
    clearSpy.mockRestore();
  });

  it('disconnectedCallback cancels the pending rAF handle', () => {
    const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const rafHandle = (el as unknown as { _rafHandle: number | undefined })._rafHandle;
    el.remove();
    expect(cancelSpy).toHaveBeenCalledWith(rafHandle);
    cancelSpy.mockRestore();
  });

  it('Undo button dispatches pane-close-resolved with correct paneId', async () => {
    const events: CustomEvent<{ paneId: number }>[] = [];
    document.addEventListener('pane-close-resolved', (e) => events.push(e as CustomEvent<{ paneId: number }>), { once: true });
    const btn = el.shadowRoot!.querySelector('.undo') as HTMLButtonElement;
    btn.click();
    expect(events).toHaveLength(1);
    expect(events[0].detail.paneId).toBe(42);
  });
});
