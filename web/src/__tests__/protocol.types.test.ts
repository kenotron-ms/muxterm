import { describe, it, expect } from 'vitest';
import {
  SessiondType,
  SessiondErrorCode,
  encodePaneFrame,
  decodePaneFrame,
  type SessiondMessage,
  type SessiondWorkspaceInfo,
  type SessiondPaneInfo,
  type SurfaceKind,
} from '../types';

describe('sessiond protocol types', () => {
  it('SessiondType mirrors the frozen Go message-type map', () => {
    expect(SessiondType).toEqual({
      CreateWorkspace: 'create-workspace',
      ListWorkspaces: 'list-workspaces',
      RenameWorkspace: 'rename-workspace',
      CloseWorkspace: 'close-workspace',
      CloseIntent: 'close-intent',
      CloseConfirm: 'close-confirm',
      Attach: 'attach',
      CreatePane: 'create-pane',
      ClosePane: 'close-pane',
      Resize: 'resize',
      PaneFocus: 'pane-focus',
      RenamePane: 'rename-pane',
      SaveLayout: 'save-layout',
      PaneUpdate: 'pane-update',
      WorkspaceCreated: 'workspace-created',
      WorkspaceList: 'workspace-list',
      Composition: 'composition',
      PaneCreated: 'pane-created',
      CloseOutcome: 'close-outcome',
      Ok: 'ok',
      PaneAdded: 'pane-added',
      PaneClosed: 'pane-closed',
      WorkspaceClosed: 'workspace-closed',
      WorkspaceRenamed: 'workspace-renamed',
      PaneRenamed: 'pane-renamed',
      PaneResized: 'pane-resized',
      Error: 'error',
      // Browser-action relay
      BrowserAction: 'browser-action',
      BrowserActionResult: 'browser-action-result',
      // Browser CDP pane management
      CreateBrowserPane: 'create-browser-pane',
      CloseBrowserPane: 'close-browser-pane',
      BrowserCommand: 'browser-command',
      BrowserResult: 'browser-result',
      // Layout / snapshot relay
      LayoutCommand: 'layout-command',
      ScreenSnapshot: 'screen-snapshot',
      GetLayout: 'get-layout',
      // Sidebar live preview
      PreviewSubscribe: 'preview-subscribe',
      WorkspacePreview: 'workspace-preview',
    });
  });

  it('SessiondType.PaneUpdate is pane-update', () => {
    expect(SessiondType.PaneUpdate).toBe('pane-update');
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

describe('sessiond binary pane frame', () => {
  it('round-trips a binary-safe payload', () => {
    const data = new Uint8Array([0x68, 0x69, 0x0a, 0x00, 0xff, 0x21]);
    const got = decodePaneFrame(encodePaneFrame(1234, data));
    expect(got.paneId).toBe(1234);
    expect(Array.from(got.data)).toEqual(Array.from(data));
  });

  it('encodes paneId little-endian with no body', () => {
    const buf = encodePaneFrame(1, new Uint8Array());
    expect(Array.from(new Uint8Array(buf))).toEqual([0x01, 0x00, 0x00, 0x00]);
  });

  it('round-trips an empty payload', () => {
    const got = decodePaneFrame(encodePaneFrame(9, new Uint8Array()));
    expect(got.paneId).toBe(9);
    expect(got.data.length).toBe(0);
  });
});

describe('clientRef correlation field', () => {
  it('allows clientRef on a create message', () => {
    const msg: SessiondMessage = { type: 'create-workspace', clientRef: 'tmp-1' };
    expect(msg.clientRef).toBe('tmp-1');
  });

  it('allows clientRef on a workspace info', () => {
    const ws: SessiondWorkspaceInfo = { workspaceId: 'w1', paneCount: 0, clientRef: 'tmp-1' };
    expect(ws.clientRef).toBe('tmp-1');
  });

  it('allows clientRef on a pane info', () => {
    const pane: SessiondPaneInfo = { paneId: 1, cols: 80, rows: 24, clientRef: 'tmp-1' };
    expect(pane.clientRef).toBe('tmp-1');
  });
});

describe('browser pane fields', () => {
  it('SessiondPaneInfo accepts browser surfaceKind', () => {
    const kind: SurfaceKind = 'browser';
    const pane: SessiondPaneInfo = {
      paneId: 2,
      cols: 0,
      rows: 0,
      surfaceKind: kind,
    };
    expect(pane.surfaceKind).toBe('browser');
  });

  it('SessiondPaneInfo surfaceKind is optional', () => {
    const pane: SessiondPaneInfo = { paneId: 1, cols: 80, rows: 24 };
    expect(pane.surfaceKind).toBeUndefined();
  });

  it('SessiondMessage accepts browser surfaceKind', () => {
    const msg: SessiondMessage = {
      type: SessiondType.CreatePane,
      paneId: 2,
      surfaceKind: 'browser',
    };
    expect(msg.surfaceKind).toBe('browser');
  });

  it('SessiondMessage surfaceKind is optional', () => {
    const msg: SessiondMessage = { type: SessiondType.CreatePane, paneId: 1 };
    expect(msg.surfaceKind).toBeUndefined();
  });
});
