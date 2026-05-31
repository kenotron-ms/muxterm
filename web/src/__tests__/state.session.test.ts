import { describe, it, expect, vi } from 'vitest';
import { MuxStore } from '../state';

describe('MuxStore sessionList', () => {
  it('starts with empty sessionList', () => {
    const store = new MuxStore();
    expect(store.sessionList).toEqual([]);
  });

  it('updates sessionList when session-list message is applied', () => {
    const store = new MuxStore();
    store.applyMessage({
      type: 'session-list',
      data: { sessions: [{ name: 'dev', windows: 2 }, { name: 'ops', windows: 1 }] },
    });
    expect(store.sessionList.map((s) => s.name)).toEqual(['dev', 'ops']);
  });

  it('notifies subscribers when session-list message is applied', () => {
    const store = new MuxStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyMessage({
      type: 'session-list',
      data: { sessions: [{ name: 'dev', windows: 2 }] },
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
