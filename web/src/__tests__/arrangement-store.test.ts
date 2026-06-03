import { describe, it, expect, beforeEach } from 'vitest';
import { ArrangementStore, storageKey } from '../lib/arrangement-store.js';
import type { SavedArrangement } from '../lib/arrangement-store.js';
import { arrange } from '../lib/layout.js';
import type { Composition } from '../lib/layout.js';

const comp = (paneIds: number[], activePaneId: number): Composition => ({
  paneIds,
  activePaneId,
});

describe('ArrangementStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('auto-generates the responsive default when nothing is saved', () => {
    const store = new ArrangementStore();
    const composition = comp([3, 1, 2], 1);

    const result = store.load('ws-abc', 'wide', composition);

    expect(result).toEqual(arrange(composition, 'wide'));
  });

  it('round-trips a saved arrangement so saved order/active win', () => {
    const store = new ArrangementStore();
    const composition = comp([1, 2, 3], 1);
    const saved: SavedArrangement = { order: [3, 1, 2], activePaneId: 2 };

    store.save('ws-abc', 'wide', saved);
    const result = store.load('ws-abc', 'wide', composition);

    expect(result).toEqual(arrange({ paneIds: [3, 1, 2], activePaneId: 2 }, 'wide'));
    expect(result.order).toEqual([3, 1, 2]);
    expect(result.active).toBe(2);
  });

  it('keeps keys independent per viewport profile', () => {
    const store = new ArrangementStore();
    const composition = comp([1, 2, 3], 1);

    store.save('ws-abc', 'wide', { order: [3, 2, 1], activePaneId: 3 });

    // medium has nothing saved => responsive default
    const medium = store.load('ws-abc', 'medium', composition);
    expect(medium).toEqual(arrange(composition, 'medium'));

    // wide still uses its own saved order
    const wide = store.load('ws-abc', 'wide', composition);
    expect(wide.order).toEqual([3, 2, 1]);
  });

  it('keys by the stable workspaceId so a rename never loses layout', () => {
    const store = new ArrangementStore();
    const composition = comp([1, 2, 3], 1);
    const saved: SavedArrangement = { order: [2, 3, 1], activePaneId: 3 };

    // Save under the opaque, stable workspace id.
    const stableId = 'ws-opaque-7f3a';
    store.save(stableId, 'wide', saved);

    // The persisted key is derived purely from the stable id (not a name),
    // so renaming the workspace's display name cannot change it.
    expect(localStorage.getItem(storageKey(stableId, 'wide'))).not.toBeNull();

    const result = store.load(stableId, 'wide', composition);
    expect(result.order).toEqual([2, 3, 1]);
    expect(result.active).toBe(3);
  });

  it('drops saved pane ids no longer in the composition and falls back stale active', () => {
    const store = new ArrangementStore();
    // 99 was saved but is gone from the live composition; saved active 99 is stale.
    store.save('ws-abc', 'wide', { order: [99, 1, 2], activePaneId: 99 });

    const composition = comp([1, 2], 2);
    const result = store.load('ws-abc', 'wide', composition);

    expect(result.order).toEqual([1, 2]);
    expect(result.order).not.toContain(99);
    // stale active 99 absent => fall back to composition.activePaneId (2)
    expect(result.active).toBe(2);
  });

  it('appends newly-composed pane ids after the saved order', () => {
    const store = new ArrangementStore();
    store.save('ws-abc', 'wide', { order: [3, 1], activePaneId: 1 });

    // Pane 2 and 4 are newly composed and not in saved order.
    const composition = comp([1, 2, 3, 4], 1);
    const result = store.load('ws-abc', 'wide', composition);

    // saved order first (3, 1), then new ones appended in composition order (2, 4)
    expect(result.order).toEqual([3, 1, 2, 4]);
    expect(result.active).toBe(1);
  });

  it('survives malformed localStorage by falling back to the default', () => {
    const store = new ArrangementStore();
    const composition = comp([1, 2, 3], 1);

    localStorage.setItem(storageKey('ws-abc', 'wide'), '{not valid json');

    const result = store.load('ws-abc', 'wide', composition);
    expect(result).toEqual(arrange(composition, 'wide'));
  });
});
