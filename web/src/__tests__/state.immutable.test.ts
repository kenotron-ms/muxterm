import { describe, it, expect } from 'vitest';
import { MuxStore } from '../state';
import { SessiondType } from '../types';

// Build a MuxStore seeded with a known workspace list + composition so each
// test starts from the same authoritative base state.
function seeded(): MuxStore {
  const store = new MuxStore();
  store.applySessiond({
    type: SessiondType.WorkspaceList,
    workspaces: [
      { workspaceId: 'w1', name: 'one', paneCount: 1 },
      { workspaceId: 'w2', paneCount: 2 },
    ],
  });
  store.applySessiond({
    type: SessiondType.Composition,
    workspaceId: 'w1',
    panes: [{ paneId: 1, cols: 80, rows: 24, title: 'shell' }],
  });
  return store;
}

describe('MuxStore base immutability', () => {
  it('pushing to store.workspaces does not change length', () => {
    const store = seeded();
    store.workspaces.push({ workspaceId: 'wX', paneCount: 9 });
    expect(store.workspaces.length).toBe(2);
  });

  it('mutating store.workspaces[0].name is isolated', () => {
    const store = seeded();
    store.workspaces[0].name = 'HACKED';
    expect(store.workspaces[0].name).toBe('one');
  });

  it('pushing to store.panes does not change length', () => {
    const store = seeded();
    store.panes.push({ paneId: 99, cols: 1, rows: 1, title: 'x' });
    expect(store.panes.length).toBe(1);
  });

  it('mutating store.panes[0].title is isolated', () => {
    const store = seeded();
    store.panes[0].title = 'HACKED';
    expect(store.panes[0].title).toBe('shell');
  });

  it('applies WorkspaceList immutably without mutating prior snapshots', () => {
    const store = seeded();
    const before = store.workspaces;
    store.applySessiond({
      type: SessiondType.WorkspaceList,
      workspaces: [
        { workspaceId: 'w1', name: 'renamed', paneCount: 1 },
        { workspaceId: 'w2', paneCount: 2 },
      ],
    });
    const after = store.workspaces;
    expect(after).not.toBe(before);
    expect(after.find((w) => w.workspaceId === 'w1')?.name).toBe('renamed');
    expect(before.find((w) => w.workspaceId === 'w1')?.name).toBe('one');
  });
});
