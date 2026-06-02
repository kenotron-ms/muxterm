import { describe, it, expect } from 'vitest';
import { MuxStore } from '../state';
import { SessiondType } from '../types';
import type { SessiondMessage } from '../types';

const workspaceList = (
  workspaces: { workspaceId: string; name?: string; paneCount: number }[],
): SessiondMessage => ({ type: SessiondType.WorkspaceList, workspaces });

describe('MuxStore optimistic-mutation seam', () => {
  it('applies an optimistic rename over the base in store.workspaces', () => {
    const store = new MuxStore();
    store.applySessiond(
      workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]),
    );

    store.mutate({
      optimistic: (draft) => {
        const ws = draft.workspaces.find((w) => w.workspaceId === 'ws-1');
        if (ws) ws.name = 'new';
      },
      settled: (base) =>
        base.workspaces.find((w) => w.workspaceId === 'ws-1')?.name === 'new',
    });

    expect(store.workspaces.find((w) => w.workspaceId === 'ws-1')?.name).toBe(
      'new',
    );
  });

  it('never mutates the authoritative base when folding optimism', () => {
    const store = new MuxStore();
    store.applySessiond(
      workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]),
    );

    const id = store.mutate({
      optimistic: (draft) => {
        const ws = draft.workspaces.find((w) => w.workspaceId === 'ws-1');
        if (ws) ws.name = 'new';
      },
      settled: (base) =>
        base.workspaces.find((w) => w.workspaceId === 'ws-1')?.name === 'new',
    });

    expect(store.workspaces[0].name).toBe('new');

    store.dismiss(id);

    expect(store.workspaces[0].name).toBe('old');
  });

  it('mutate fires the commit callback once and returns a mutation id', () => {
    const store = new MuxStore();
    store.applySessiond(
      workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]),
    );

    let commits = 0;
    const id = store.mutate({
      optimistic: () => {},
      settled: () => false,
      commit: () => {
        commits += 1;
      },
    });

    expect(typeof id).toBe('string');
    expect(commits).toBe(1);
  });
});
