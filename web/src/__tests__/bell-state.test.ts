import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MuxStore } from '../state';

describe('MuxStore bell state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ringPane + ringWorkspace activates both pane and workspace indicators and notifies subscribers', () => {
    const store = new MuxStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.ringPane(1);
    store.ringWorkspace('ws-a');

    expect(store.paneBellActive(1)).toBe(true);
    expect(store.workspaceBellActive('ws-a')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('re-bell after ack re-activates both indicators', () => {
    const store = new MuxStore();

    vi.setSystemTime(1000);
    store.ringPane(2);
    store.ringWorkspace('ws-b');

    vi.setSystemTime(2000);
    store.ackPane(2);
    store.ackWorkspace('ws-b');

    // After ack, both are inactive
    expect(store.paneBellActive(2)).toBe(false);
    expect(store.workspaceBellActive('ws-b')).toBe(false);

    // Re-bell re-activates both
    vi.setSystemTime(3000);
    store.ringPane(2);
    store.ringWorkspace('ws-b');
    expect(store.paneBellActive(2)).toBe(true);
    expect(store.workspaceBellActive('ws-b')).toBe(true);
  });

  it('ackPane clears pane bell but not workspace bell', () => {
    const store = new MuxStore();
    store.ringPane(3);
    store.ringWorkspace('ws-c');

    store.ackPane(3);

    expect(store.paneBellActive(3)).toBe(false);
    expect(store.workspaceBellActive('ws-c')).toBe(true);
  });

  it('ackWorkspace clears workspace bell but not pane bell', () => {
    const store = new MuxStore();
    store.ringPane(4);
    store.ringWorkspace('ws-d');

    store.ackWorkspace('ws-d');

    expect(store.paneBellActive(4)).toBe(true);
    expect(store.workspaceBellActive('ws-d')).toBe(false);
  });

  it('ackPane is a safe no-op for unknown pane ID', () => {
    const store = new MuxStore();

    // Should not throw
    expect(() => store.ackPane(999)).not.toThrow();
    expect(store.paneBellActive(999)).toBe(false);
  });

  it('ackWorkspace is a safe no-op for unknown workspace ID', () => {
    const store = new MuxStore();

    // Should not throw
    expect(() => store.ackWorkspace('nonexistent')).not.toThrow();
    expect(store.workspaceBellActive('nonexistent')).toBe(false);
  });

  it('ackPane notifies subscribers', () => {
    const store = new MuxStore();
    store.ringPane(5);
    store.ringWorkspace('ws-e');

    const listener = vi.fn();
    store.subscribe(listener);

    store.ackPane(5);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ackWorkspace notifies subscribers', () => {
    const store = new MuxStore();
    store.ringPane(6);
    store.ringWorkspace('ws-f');

    const listener = vi.fn();
    store.subscribe(listener);

    store.ackWorkspace('ws-f');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ackPane and ackWorkspace are independent — acking in either order works', () => {
    const store1 = new MuxStore();
    store1.ringPane(7);
    store1.ringWorkspace('ws-g');
    store1.ackWorkspace('ws-g');
    store1.ackPane(7);
    expect(store1.paneBellActive(7)).toBe(false);
    expect(store1.workspaceBellActive('ws-g')).toBe(false);

    const store2 = new MuxStore();
    store2.ringPane(8);
    store2.ringWorkspace('ws-h');
    store2.ackPane(8);
    store2.ackWorkspace('ws-h');
    expect(store2.paneBellActive(8)).toBe(false);
    expect(store2.workspaceBellActive('ws-h')).toBe(false);
  });

  it('pane and workspace bells are independent across different panes and workspaces', () => {
    const store = new MuxStore();

    store.ringPane(10);
    store.ringWorkspace('ws-i');
    store.ringPane(11);
    store.ringWorkspace('ws-j');

    // Ack pane 10 and ws-j
    store.ackPane(10);
    store.ackWorkspace('ws-j');

    // Pane 10 acked, pane 11 not
    expect(store.paneBellActive(10)).toBe(false);
    expect(store.paneBellActive(11)).toBe(true);

    // ws-j acked, ws-i not
    expect(store.workspaceBellActive('ws-j')).toBe(false);
    expect(store.workspaceBellActive('ws-i')).toBe(true);
  });
});
