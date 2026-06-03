import { describe, it, expect, vi } from 'vitest';
import { MuxStore } from '../state';
import { SessiondType } from '../types';
import type { SessiondMessage } from '../types';

const workspaceList = (
  workspaces: { workspaceId: string; name?: string; paneCount: number }[],
): SessiondMessage => ({ type: SessiondType.WorkspaceList, workspaces });

const composition = (
  workspaceId: string,
  panes: { paneId: number; cols: number; rows: number; title?: string }[],
): SessiondMessage => ({
  type: SessiondType.Composition,
  workspaceId,
  panes,
});

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

describe('folded panes getter', () => {
  it('applies an optimistic pane add over the base in store.panes', () => {
    const store = new MuxStore();
    store.applySessiond(
      composition('ws-1', [{ paneId: 5, cols: 80, rows: 24 }]),
    );

    store.mutate({
      kind: 'create-pane',
      optimistic: (draft) => {
        draft.panes.push({ paneId: 999, cols: 80, rows: 24 });
      },
      settled: (base) => base.panes.some((p) => p.paneId === 999),
    });

    expect(store.panes.map((p) => p.paneId)).toEqual([5, 999]);
  });
});

describe('composition reads the folded view', () => {
  it('shows an optimistic pane through store.composition.paneIds (no split-brain)', () => {
    const store = new MuxStore();
    store.applySessiond(
      composition('ws-1', [{ paneId: 5, cols: 80, rows: 24 }]),
    );

    store.mutate({
      kind: 'create-pane',
      optimistic: (draft) => {
        draft.panes.push({ paneId: 999, cols: 80, rows: 24 });
      },
      settled: (base) => base.panes.some((p) => p.paneId === 999),
    });

    expect(store.composition.paneIds).toEqual([5, 999]);
  });
});

describe('settle after applySessiond', () => {
  it('drops a pending mutation once its settled(base) predicate is true', () => {
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

    // Overlay shows 'new' before the authoritative echo lands.
    expect(store.workspaces[0].name).toBe('new');

    // Authoritative echo lands via workspace-list snapshot: settled(base) becomes true, overlay vanishes.
    store.applySessiond(workspaceList([{ workspaceId: 'ws-1', name: 'new', paneCount: 0 }]));
    expect(store.workspaces[0].name).toBe('new');
    expect(store.erroredMutations).toEqual([]);

    // Overlay is truly gone: a later base change shows through unobstructed.
    store.applySessiond(workspaceList([{ workspaceId: 'ws-1', name: 'newer', paneCount: 0 }]));
    expect(store.workspaces[0].name).toBe('newer');
  });
});

describe('timeout marks errored, snaps to truth', () => {
  it('on timeout without settle, reverts overlay and marks the mutation errored', () => {
    vi.useFakeTimers();
    try {
      const store = new MuxStore();
      store.applySessiond(
        workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]),
      );

      const id = store.mutate({
        workspaceId: 'ws-1',
        kind: 'rename',
        timeoutMs: 5000,
        optimistic: (draft) => {
          const ws = draft.workspaces.find((w) => w.workspaceId === 'ws-1');
          if (ws) ws.name = 'new';
        },
        settled: () => false,
      });

      // Optimistic overlay shows while pending.
      expect(store.workspaces[0].name).toBe('new');

      // Timeout fires without a settle: overlay reverts to truth.
      vi.advanceTimersByTime(5000);
      expect(store.workspaces[0].name).toBe('old');

      // The mutation is kept but marked errored for retry/dismiss.
      expect(store.erroredMutations).toEqual([
        { id, workspaceId: 'ws-1', kind: 'rename' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('retry and dismiss', () => {
  it('retry clears errored, re-applies the overlay, and re-fires commit', () => {
    vi.useFakeTimers();
    try {
      const store = new MuxStore();
      store.applySessiond(
        workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]),
      );

      let commits = 0;
      const id = store.mutate({
        workspaceId: 'ws-1',
        kind: 'rename',
        timeoutMs: 5000,
        optimistic: (draft) => {
          const ws = draft.workspaces.find((w) => w.workspaceId === 'ws-1');
          if (ws) ws.name = 'new';
        },
        settled: () => false,
        commit: () => {
          commits += 1;
        },
      });

      // Timeout fires without a settle: overlay reverts, mutation errored.
      vi.advanceTimersByTime(5000);
      expect(store.erroredMutations.length).toBe(1);
      expect(store.workspaces[0].name).toBe('old');

      // Retry: clears errored, re-fires commit, re-applies overlay.
      store.retry(id);
      expect(commits).toBe(2);
      expect(store.erroredMutations).toEqual([]);
      expect(store.workspaces[0].name).toBe('new');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismiss removes an errored mutation entirely', () => {
    vi.useFakeTimers();
    try {
      const store = new MuxStore();
      store.applySessiond(
        workspaceList([{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }]),
      );

      const id = store.mutate({
        workspaceId: 'ws-1',
        kind: 'rename',
        timeoutMs: 5000,
        optimistic: (draft) => {
          const ws = draft.workspaces.find((w) => w.workspaceId === 'ws-1');
          if (ws) ws.name = 'new';
        },
        settled: () => false,
      });

      vi.advanceTimersByTime(5000);
      expect(store.erroredMutations.length).toBe(1);

      store.dismiss(id);
      expect(store.erroredMutations).toEqual([]);
      expect(store.workspaces[0].name).toBe('old');
    } finally {
      vi.useRealTimers();
    }
  });
});
