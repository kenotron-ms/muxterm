import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PopoutManager } from '../lib/popout';

/** Minimal mock of a popup window returned by window.open. */
function makeMockWindow() {
  return {
    closed: false,
    close: vi.fn(),
  };
}

describe('PopoutManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a window and reports popped-out', () => {
    const mockWin = makeMockWindow();
    const openFn = vi.fn().mockReturnValue(mockWin);
    const manager = new PopoutManager({
      open: openFn,
      pollIntervalMs: 400,
      origin: 'http://localhost',
    });

    const handle = manager.popOut({
      regionId: 'region-1',
      url: 'http://localhost/?popout=region-1',
      onClose: vi.fn(),
    });

    expect(openFn).toHaveBeenCalledOnce();
    expect(manager.isPoppedOut('region-1')).toBe(true);
    expect(handle.regionId).toBe('region-1');
    expect(handle.open).toBe(mockWin);

    manager.dispose();
  });

  it('fires onClose exactly once and clears state when the popped window closes', () => {
    const mockWin = makeMockWindow();
    const openFn = vi.fn().mockReturnValue(mockWin);
    const onClose = vi.fn();
    const manager = new PopoutManager({
      open: openFn,
      pollIntervalMs: 400,
      origin: 'http://localhost',
    });

    manager.popOut({ regionId: 'region-1', onClose });

    expect(manager.isPoppedOut('region-1')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    // Simulate user closing the popup
    mockWin.closed = true;
    vi.advanceTimersByTime(400);

    expect(onClose).toHaveBeenCalledOnce();
    expect(manager.isPoppedOut('region-1')).toBe(false);

    // Advance further — onClose must NOT fire a second time
    vi.advanceTimersByTime(800);
    expect(onClose).toHaveBeenCalledOnce();

    manager.dispose();
  });

  it('is idempotent — calling popOut on an already-popped region does not open a second window', () => {
    const mockWin = makeMockWindow();
    const openFn = vi.fn().mockReturnValue(mockWin);
    const manager = new PopoutManager({
      open: openFn,
      pollIntervalMs: 400,
      origin: 'http://localhost',
    });

    const handle1 = manager.popOut({ regionId: 'region-1', onClose: vi.fn() });
    const handle2 = manager.popOut({ regionId: 'region-1', onClose: vi.fn() });

    // window.open called only once
    expect(openFn).toHaveBeenCalledOnce();
    expect(handle1.regionId).toBe('region-1');
    expect(handle2.regionId).toBe('region-1');
    expect(handle1.open).toBe(mockWin);
    expect(handle2.open).toBe(mockWin);

    manager.dispose();
  });

  it('throws Error("popout-blocked") when window.open returns null', () => {
    const openFn = vi.fn().mockReturnValue(null);
    const manager = new PopoutManager({
      open: openFn,
      pollIntervalMs: 400,
      origin: 'http://localhost',
    });

    expect(() =>
      manager.popOut({ regionId: 'region-1', onClose: vi.fn() }),
    ).toThrow('popout-blocked');

    // No state should have been recorded
    expect(manager.isPoppedOut('region-1')).toBe(false);

    manager.dispose();
  });

  it('close() calls win.close() and the poll fires onClose', () => {
    const mockWin = makeMockWindow();
    const openFn = vi.fn().mockReturnValue(mockWin);
    const onClose = vi.fn();
    const manager = new PopoutManager({
      open: openFn,
      pollIntervalMs: 400,
      origin: 'http://localhost',
    });

    manager.popOut({ regionId: 'region-1', onClose });

    // Programmatically close the window via the manager
    manager.close('region-1');

    // The underlying win.close() should have been invoked
    expect(mockWin.close).toHaveBeenCalledOnce();

    // onClose not yet fired — poll hasn't run
    expect(onClose).not.toHaveBeenCalled();

    // Simulate the window actually becoming closed after win.close()
    mockWin.closed = true;
    vi.advanceTimersByTime(400);

    expect(onClose).toHaveBeenCalledOnce();
    expect(manager.isPoppedOut('region-1')).toBe(false);

    manager.dispose();
  });
});
