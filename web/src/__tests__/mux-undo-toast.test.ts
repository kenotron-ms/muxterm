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

  it('initialises _remaining to round(duration / 1000)', () => {
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

  it('row has role="alert" aria-live="assertive" aria-atomic="true"', async () => {
    const row = el.shadowRoot!.querySelector('.row');
    expect(row!.getAttribute('role')).toBe('alert');
    expect(row!.getAttribute('aria-live')).toBe('assertive');
    expect(row!.getAttribute('aria-atomic')).toBe('true');
  });

  it('Undo button dispatches pane-close-resolved with correct paneId', async () => {
    const events: CustomEvent<{ paneId: number }>[] = [];
    document.addEventListener('pane-close-resolved', (e) => events.push(e as CustomEvent<{ paneId: number }>), { once: true });
    const btn = el.shadowRoot!.querySelector('.undo') as HTMLButtonElement;
    btn.click();
    expect(events).toHaveLength(1);
    expect(events[0].detail.paneId).toBe(42);
  });

  it('bar CSS transition uses exact duration/1000 (not Math.round) so non-round durations are accurate', async () => {
    // Create a toast with a non-round duration (2500ms) so Math.round gives 3 but
    // exact division gives 2.5 — the bar transition must use the exact value.
    const toast = document.createElement('mux-undo-toast') as MuxUndoToast;
    toast.paneId = 99;
    toast.paneTitle = 'zsh';
    toast.duration = 2500;
    document.body.appendChild(toast);
    await toast.updateComplete;

    // Arm the transition (mirrors the rAF callback in connectedCallback)
    (toast as unknown as { _armed: boolean })._armed = true;
    await toast.updateComplete;

    const bar = toast.shadowRoot!.querySelector('.bar') as HTMLElement;
    const style = bar.getAttribute('style') ?? '';
    // Must use 2.5s, NOT 3s (which Math.round(2500/1000) would give)
    expect(style).toContain('2.5s');
    expect(style).not.toContain('3s');

    toast.remove();
  });
});
