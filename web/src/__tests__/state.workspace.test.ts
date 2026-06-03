import { describe, it, expect, vi } from 'vitest';
import { MuxStore } from '../state';
import { SessiondType } from '../types';
import type { SessiondMessage } from '../types';

// Helpers to build frozen-vocabulary sessiond messages tersely.
const workspaceList = (
  workspaces: { workspaceId: string; name?: string; paneCount: number }[],
): SessiondMessage => ({ type: SessiondType.WorkspaceList, workspaces });

const composition = (
  workspaceId: string,
  panes: { paneId: number; cols: number; rows: number; title?: string }[],
): SessiondMessage => ({ type: SessiondType.Composition, workspaceId, panes });

const paneAdded = (
  paneId: number,
  cols: number,
  rows: number,
  title?: string,
): SessiondMessage => ({ type: SessiondType.PaneAdded, paneId, cols, rows, title });

const paneClosed = (paneId: number): SessiondMessage => ({
  type: SessiondType.PaneClosed,
  paneId,
});

const workspaceClosed = (workspaceId: string): SessiondMessage => ({
  type: SessiondType.WorkspaceClosed,
  workspaceId,
});

const workspaceRenamed = (workspaceId: string, name?: string): SessiondMessage => ({
  type: SessiondType.WorkspaceRenamed,
  workspaceId,
  name,
});

describe('MuxStore sessiond multiplexer path', () => {
  it('starts with empty workspace/composition state', () => {
    const store = new MuxStore();
    expect(store.workspaces).toEqual([]);
    expect(store.attached).toBeNull();
    expect(store.panes).toEqual([]);
    expect(store.composition).toEqual({ paneIds: [], activePaneId: 0 });
  });

  it('stores the workspace list', () => {
    const store = new MuxStore();
    store.applySessiond(
      workspaceList([
        { workspaceId: 'ws-1', name: 'dev', paneCount: 2 },
        { workspaceId: 'ws-2', paneCount: 0 },
      ]),
    );
    expect(store.workspaces.map((w) => w.workspaceId)).toEqual(['ws-1', 'ws-2']);
  });

  it('sets attachment and composition from a composition reply, including titles', () => {
    const store = new MuxStore();
    store.applySessiond(
      composition('ws-1', [
        { paneId: 5, cols: 80, rows: 24, title: 'shell' },
        { paneId: 7, cols: 80, rows: 24 },
      ]),
    );
    expect(store.attached).toBe('ws-1');
    expect(store.panes.map((p) => p.paneId)).toEqual([5, 7]);
    expect(store.panes[0].title).toBe('shell');
    expect(store.panes[1].title).toBeUndefined();
    expect(store.composition).toEqual({ paneIds: [5, 7], activePaneId: 5 });
  });

  it('appends a pane on pane-added with size and title', () => {
    const store = new MuxStore();
    store.applySessiond(composition('ws-1', [{ paneId: 5, cols: 80, rows: 24 }]));
    store.applySessiond(paneAdded(9, 100, 30, 'logs'));
    expect(store.panes.map((p) => p.paneId)).toEqual([5, 9]);
    const added = store.panes[1];
    expect(added.cols).toBe(100);
    expect(added.rows).toBe(30);
    expect(added.title).toBe('logs');
  });

  it('is idempotent: a duplicate pane-added does not double the pane', () => {
    const store = new MuxStore();
    store.applySessiond(composition('ws-1', [{ paneId: 5, cols: 80, rows: 24 }]));
    store.applySessiond(paneAdded(9, 100, 30));
    store.applySessiond(paneAdded(9, 100, 30)); // actor + broadcast echo
    expect(store.panes.map((p) => p.paneId)).toEqual([5, 9]);
  });

  it('removes a pane on pane-closed', () => {
    const store = new MuxStore();
    store.applySessiond(
      composition('ws-1', [
        { paneId: 5, cols: 80, rows: 24 },
        { paneId: 9, cols: 80, rows: 24 },
      ]),
    );
    store.applySessiond(paneClosed(9));
    expect(store.panes.map((p) => p.paneId)).toEqual([5]);
  });

  it('re-points the active pane when the active pane is closed', () => {
    const store = new MuxStore();
    store.applySessiond(
      composition('ws-1', [
        { paneId: 5, cols: 80, rows: 24 },
        { paneId: 9, cols: 80, rows: 24 },
      ]),
    );
    // active is 5 (first pane); closing it re-points to a survivor.
    store.applySessiond(paneClosed(5));
    expect(store.panes.map((p) => p.paneId)).toEqual([9]);
    expect(store.composition.activePaneId).toBe(9);
  });

  it('clears attachment on workspace-closed and ignores a trailing pane-closed', () => {
    const store = new MuxStore();
    store.applySessiond(
      workspaceList([{ workspaceId: 'ws-1', name: 'dev', paneCount: 1 }]),
    );
    store.applySessiond(composition('ws-1', [{ paneId: 5, cols: 80, rows: 24 }]));
    store.applySessiond(workspaceClosed('ws-1'));
    expect(store.attached).toBeNull();
    expect(store.panes).toEqual([]);
    expect(store.composition).toEqual({ paneIds: [], activePaneId: 0 });
    expect(store.workspaces).toEqual([]);
    // Trailing pane-closed for the now-detached workspace is ignored.
    store.applySessiond(paneClosed(5));
    expect(store.panes).toEqual([]);
  });

  it('updates the workspace label on workspace-renamed', () => {
    const store = new MuxStore();
    store.applySessiond(
      workspaceList([{ workspaceId: 'ws-1', name: 'dev', paneCount: 0 }]),
    );
    store.applySessiond(workspaceRenamed('ws-1', 'prod'));
    expect(store.workspaces[0].name).toBe('prod');
  });

  it('clears the workspace label when workspace-renamed omits the name', () => {
    const store = new MuxStore();
    store.applySessiond(
      workspaceList([{ workspaceId: 'ws-1', name: 'dev', paneCount: 0 }]),
    );
    store.applySessiond(workspaceRenamed('ws-1'));
    expect(store.workspaces[0].name).toBeUndefined();
  });

  it('notifies subscribers on composition changes', () => {
    const store = new MuxStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.applySessiond(composition('ws-1', [{ paneId: 5, cols: 80, rows: 24 }]));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('workspace-created handler', () => {
  it('adds a new workspace to store.workspaces with name undefined and clientRef', () => {
    const store = new MuxStore();
    store.applySessiond({
      type: SessiondType.WorkspaceCreated,
      workspaceId: 'w5',
      name: '',
      clientRef: 'ref-x',
    });
    const ws = store.workspaces.find((w) => w.workspaceId === 'w5');
    expect(ws).toBeDefined();
    expect(ws!.name).toBeUndefined();
    expect(ws!.clientRef).toBe('ref-x');
    expect(ws!.paneCount).toBe(0);
  });

  it('is idempotent: duplicate workspace-created does not add a second entry', () => {
    const store = new MuxStore();
    store.applySessiond({
      type: SessiondType.WorkspaceCreated,
      workspaceId: 'w5',
      name: '',
      clientRef: 'ref-x',
    });
    store.applySessiond({
      type: SessiondType.WorkspaceCreated,
      workspaceId: 'w5',
      name: '',
      clientRef: 'ref-x',
    });
    expect(store.workspaces.filter((w) => w.workspaceId === 'w5').length).toBe(1);
  });

  it('settles an optimistic create mutation whose predicate matches clientRef', () => {
    const store = new MuxStore();
    const ref = 'ref-x';

    store.mutate({
      optimistic: (draft) => {
        draft.workspaces.push({ workspaceId: ref, paneCount: 0, clientRef: ref });
      },
      settled: (base) => base.workspaces.some((w) => w.clientRef === ref),
      kind: 'create-workspace',
    });

    // Before the echo: one pending mutation visible
    expect(store.workspaces.some((w) => w.clientRef === ref)).toBe(true);

    // workspace-created echo arrives with the real id + clientRef
    store.applySessiond({
      type: SessiondType.WorkspaceCreated,
      workspaceId: 'w5',
      name: '',
      clientRef: ref,
    });

    // Predicate now satisfied: overlay is gone, base shows the real workspace
    expect(store.erroredMutations).toEqual([]);
    expect(store.workspaces.some((w) => w.workspaceId === 'w5' && w.clientRef === ref)).toBe(true);
  });
});

describe('clientRef threading through base', () => {
  it('workspace-list entries keep clientRef', () => {
    const store = new MuxStore();
    store.applySessiond({
      type: SessiondType.WorkspaceList,
      workspaces: [{ workspaceId: 'w1', paneCount: 0, clientRef: 'tmp-ws-1' }],
    });
    expect(store.workspaces[0].clientRef).toBe('tmp-ws-1');
  });

  it('pane-added carries clientRef onto the base pane', () => {
    const store = new MuxStore();
    // Handler requires _attached != null; attach with empty panes first.
    store.applySessiond({
      type: SessiondType.Composition,
      workspaceId: 'w1',
      panes: [],
    });
    store.applySessiond({
      type: SessiondType.PaneAdded,
      paneId: 5,
      cols: 80,
      rows: 24,
      clientRef: 'tmp-pane-1',
    });
    expect(store.panes.find((p) => p.paneId === 5)?.clientRef).toBe('tmp-pane-1');
  });
});
