import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MuxStore } from '../state.js';
import { SessiondType, SessiondErrorCode, type SessiondMessage } from '../types';
import { WorkspaceController, type WorkspaceSocket } from '../lib/workspace-controller.js';

const LAST_WS_KEY = 'muxterm.lastWorkspaceId';

function makeSocket(): WorkspaceSocket & {
  attachWithBreakpoint: ReturnType<typeof vi.fn>;
  createWorkspace: ReturnType<typeof vi.fn>;
  listWorkspaces: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
} {
  return {
    attachWithBreakpoint: vi.fn(),
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
    expect(socket.attachWithBreakpoint).not.toHaveBeenCalled();

    feed(workspaceList(['ws-1', 'ws-2']));
    expect(socket.attachWithBreakpoint).toHaveBeenCalledWith('ws-1', expect.any(String), expect.any(Array));
  });

  it('bootstrap with a stored id attaches it directly', () => {
    localStorage.setItem(LAST_WS_KEY, 'ws-stored');
    controller.bootstrap();
    expect(socket.attachWithBreakpoint).toHaveBeenCalledWith('ws-stored', expect.any(String), expect.any(Array));
    expect(socket.listWorkspaces).not.toHaveBeenCalled();
  });

  it('records MRU + persists last workspace on composition reply', () => {
    feed(composition('ws-1'));
    expect(localStorage.getItem(LAST_WS_KEY)).toBe('ws-1');
    expect(socket.attachWithBreakpoint).not.toHaveBeenCalled();
  });

  it('on workspace-closed of the attached workspace recovers to the MRU survivor', () => {
    feed(composition('ws-1'));
    feed(composition('ws-2'));
    expect(store.attached).toBe('ws-2');

    feed(workspaceClosed('ws-2'));
    expect(socket.listWorkspaces).toHaveBeenCalledTimes(1);

    feed(workspaceList(['ws-1']));
    expect(socket.attachWithBreakpoint).toHaveBeenCalledWith('ws-1', expect.any(String), expect.any(Array));
  });

  it('on workspace-closed with no survivors requests a fresh workspace', () => {
    feed(composition('ws-1'));
    feed(workspaceClosed('ws-1'));
    expect(socket.listWorkspaces).toHaveBeenCalledTimes(1);

    feed(workspaceList([]));
    expect(socket.createWorkspace).toHaveBeenCalledTimes(1);
    expect(socket.attachWithBreakpoint).not.toHaveBeenCalled();
  });

  it('attaches a freshly-created workspace on workspace-created reply', () => {
    feed({ type: SessiondType.WorkspaceCreated, workspaceId: 'ws-new' });
    expect(socket.attachWithBreakpoint).toHaveBeenCalledWith('ws-new', expect.any(String), expect.any(Array));
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
    expect(socket.attachWithBreakpoint).toHaveBeenCalledWith('ws-other', expect.any(String), expect.any(Array));
  });

  it('ignores non-recovery errors (e.g. pane-spawn-failed)', () => {
    feed({ type: SessiondType.Error, code: SessiondErrorCode.PaneSpawnFailed });
    expect(socket.listWorkspaces).not.toHaveBeenCalled();
    expect(socket.attachWithBreakpoint).not.toHaveBeenCalled();
    expect(socket.createWorkspace).not.toHaveBeenCalled();
  });

});
