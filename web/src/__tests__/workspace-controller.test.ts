import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MuxStore } from '../state.js';
import { SessiondType, SessiondErrorCode, type SessiondMessage } from '../types';
import { arrange } from '../lib/layout.js';
import { WorkspaceController, type WorkspaceSocket } from '../lib/workspace-controller.js';

const LAST_WS_KEY = 'muxterm.lastWorkspaceId';

function makeSocket(): WorkspaceSocket & {
  attach: ReturnType<typeof vi.fn>;
  createWorkspace: ReturnType<typeof vi.fn>;
  listWorkspaces: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
} {
  return {
    attach: vi.fn(),
    createWorkspace: vi.fn(),
    listWorkspaces: vi.fn(),
    resize: vi.fn(),
  };
}

const composition = (workspaceId: string, paneIds: number[] = []): SessiondMessage => ({
  type: SessiondType.Composition,
  workspaceId,
  panes: paneIds.map((paneId) => ({ paneId, cols: 80, rows: 24 })),
});

const workspaceList = (ids: string[]): SessiondMessage => ({
  type: SessiondType.WorkspaceList,
  workspaces: ids.map((workspaceId) => ({ workspaceId, paneCount: 0 })),
});

const workspaceClosed = (workspaceId: string): SessiondMessage => ({
  type: SessiondType.WorkspaceClosed,
  workspaceId,
});

describe('WorkspaceController', () => {
  let store: MuxStore;
  let socket: ReturnType<typeof makeSocket>;
  let controller: WorkspaceController;

  // Mirror real wiring: both the store and the controller observe each message.
  const feed = (msg: SessiondMessage): void => {
    store.applySessiond(msg);
    controller.onMessage(msg);
  };

  beforeEach(() => {
    localStorage.clear();
    store = new MuxStore();
    socket = makeSocket();
    controller = new WorkspaceController(store, socket);
  });

  it('bootstrap with no stored id lists then attaches the first workspace', () => {
    controller.bootstrap();
    expect(socket.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(socket.attach).not.toHaveBeenCalled();

    feed(workspaceList(['ws-1', 'ws-2']));
    expect(socket.attach).toHaveBeenCalledWith('ws-1');
  });

  it('bootstrap with a stored id attaches it directly', () => {
    localStorage.setItem(LAST_WS_KEY, 'ws-stored');
    controller.bootstrap();
    expect(socket.attach).toHaveBeenCalledWith('ws-stored');
    expect(socket.listWorkspaces).not.toHaveBeenCalled();
  });

  it('records MRU + persists last workspace on composition reply', () => {
    feed(composition('ws-1'));
    expect(localStorage.getItem(LAST_WS_KEY)).toBe('ws-1');
    expect(socket.attach).not.toHaveBeenCalled();
  });

  it('on workspace-closed of the attached workspace recovers to the MRU survivor', () => {
    feed(composition('ws-1'));
    feed(composition('ws-2'));
    expect(store.attached).toBe('ws-2');

    feed(workspaceClosed('ws-2'));
    expect(socket.listWorkspaces).toHaveBeenCalledTimes(1);

    feed(workspaceList(['ws-1']));
    expect(socket.attach).toHaveBeenCalledWith('ws-1');
  });

  it('on workspace-closed with no survivors requests a fresh workspace', () => {
    feed(composition('ws-1'));
    feed(workspaceClosed('ws-1'));
    expect(socket.listWorkspaces).toHaveBeenCalledTimes(1);

    feed(workspaceList([]));
    expect(socket.createWorkspace).toHaveBeenCalledTimes(1);
    expect(socket.attach).not.toHaveBeenCalled();
  });

  it('attaches a freshly-created workspace on workspace-created reply', () => {
    feed({ type: SessiondType.WorkspaceCreated, workspaceId: 'ws-new' });
    expect(socket.attach).toHaveBeenCalledWith('ws-new');
  });

  it('on unknown-workspace error clears the stale stored id and re-lists', () => {
    localStorage.setItem(LAST_WS_KEY, 'ws-stale');
    feed({
      type: SessiondType.Error,
      code: SessiondErrorCode.UnknownWorkspace,
      workspaceId: 'ws-stale',
    });
    expect(localStorage.getItem(LAST_WS_KEY)).toBeNull();
    expect(socket.listWorkspaces).toHaveBeenCalledTimes(1);

    feed(workspaceList(['ws-other']));
    expect(socket.attach).toHaveBeenCalledWith('ws-other');
  });

  it('ignores non-recovery errors (e.g. pane-spawn-failed)', () => {
    feed({ type: SessiondType.Error, code: SessiondErrorCode.PaneSpawnFailed });
    expect(socket.listWorkspaces).not.toHaveBeenCalled();
    expect(socket.attach).not.toHaveBeenCalled();
    expect(socket.createWorkspace).not.toHaveBeenCalled();
  });

  it('computes the arrangement for the current viewport width', () => {
    feed(composition('ws-1', [1, 2]));

    const wide = controller.currentArrangement(1200);
    expect(wide.mode).toBe('tiling');
    expect(wide.visible).toEqual([1, 2]);

    const narrow = controller.currentArrangement(500);
    expect(narrow.mode).toBe('tabbed');
    expect(narrow.visible).toHaveLength(1);

    // Sanity: matches the pure engine for the unsaved default.
    expect(wide).toEqual(arrange(store.composition, 'wide'));
  });
});
