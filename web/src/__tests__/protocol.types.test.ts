import { describe, it, expect } from 'vitest';
import {
  SessiondType,
  SessiondErrorCode,
  type SessiondMessage,
  type SessiondWorkspaceInfo,
  type SessiondPaneInfo,
} from '../types';

describe('sessiond protocol types', () => {
  it('SessiondType mirrors the frozen Go message-type map', () => {
    expect(SessiondType).toEqual({
      CreateWorkspace: 'create-workspace',
      ListWorkspaces: 'list-workspaces',
      RenameWorkspace: 'rename-workspace',
      CloseWorkspace: 'close-workspace',
      Attach: 'attach',
      CreatePane: 'create-pane',
      Resize: 'resize',
      WorkspaceCreated: 'workspace-created',
      WorkspaceList: 'workspace-list',
      Composition: 'composition',
      PaneCreated: 'pane-created',
      Ok: 'ok',
      PaneAdded: 'pane-added',
      PaneClosed: 'pane-closed',
      WorkspaceClosed: 'workspace-closed',
      WorkspaceRenamed: 'workspace-renamed',
      Error: 'error',
    });
  });

  it('SessiondErrorCode mirrors the frozen Go error-code map', () => {
    expect(SessiondErrorCode).toEqual({
      UnknownWorkspace: 'unknown-workspace',
      PaneSpawnFailed: 'pane-spawn-failed',
    });
  });

  it('SessiondMessage JSON-round-trips to exact Go-tag keys', () => {
    const msg: SessiondMessage = {
      type: SessiondType.CreatePane,
      cid: 7,
      workspaceId: 'ws-1',
      paneId: 3,
      cols: 80,
      rows: 24,
    };
    const keys = Object.keys(JSON.parse(JSON.stringify(msg))).sort();
    expect(keys).toEqual(['cid', 'cols', 'paneId', 'rows', 'type', 'workspaceId']);
  });

  it('SessiondWorkspaceInfo and SessiondPaneInfo carry Go-tag keys', () => {
    const ws: SessiondWorkspaceInfo = { workspaceId: 'ws-1', name: 'main', paneCount: 2 };
    expect(Object.keys(ws).sort()).toEqual(['name', 'paneCount', 'workspaceId']);

    const pane: SessiondPaneInfo = { paneId: 1, cols: 80, rows: 24, title: 'bash' };
    expect(Object.keys(pane).sort()).toEqual(['cols', 'paneId', 'rows', 'title']);
  });
});
