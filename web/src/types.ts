export interface Pane {
  id: number;
  width: number;
  height: number;
  active: boolean;
}

export interface Window {
  id: number;
  name: string;
  panes: Pane[];
  layout: string;
}

export interface Session {
  name: string;
  windows: Window[];
}

export interface TmuxState {
  sessions: Session[];
  activeSession: string;
  activeWindow: number;
  activePane: number;
}

export type SplitDirection = 'horizontal' | 'vertical';

export interface LayoutLeaf {
  type: 'leaf';
  paneId: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface LayoutSplit {
  type: 'split';
  direction: SplitDirection;
  width: number;
  height: number;
  x: number;
  y: number;
  children: LayoutNode[];
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

export type ServerMessage =
  | { type: 'full-sync'; data: TmuxState }   // on-connect: full replace + terminal reset
  | { type: 'state'; data: TmuxState }        // periodic: structural reconciliation only
  | { type: 'window-add'; data: Window }
  | { type: 'window-renamed'; data: { id: number; name: string } }
  | { type: 'window-close'; data: { id: number } }
  | { type: 'layout-change'; data: { windowId: number; layout: string } }
  | { type: 'session-changed'; data: { name: string } }
  | { type: 'session-window-changed'; data: { windowId: number } }
  | { type: 'pane-mode'; data: { paneId: number; mode: string } }
  | { type: 'session-list'; data: { sessions: SessionInfo[] } }
  | { type: 'detached'; data: { reason: string } }
  | { type: 'error'; data: { message: string } };

export interface SessionInfo {
  name: string;
  windows: number;
}

export type ClientMessage =
  | { type: 'select-window'; windowId: number }
  | { type: 'select-pane'; paneId: number }
  | { type: 'split'; direction: SplitDirection; paneId: number }
  | { type: 'resize-pane'; paneId: number; dir: string; amount: number }
  | { type: 'resize-surface'; surfaceId: string; cols: number; rows: number }
  | { type: 'new-window' }
  | { type: 'close-pane'; paneId: number }
  | { type: 'close-window'; windowId: number }
  | { type: 'rename-window'; windowId: number; name: string }
  | { type: 'create-session'; name: string }
  | { type: 'attach-session'; name: string }
  | { type: 'request-sync' }
  | { type: 'open-settings' };

export interface MuxStoreEvents {
  change: TmuxState;
  'pane-output': { paneId: number; data: Uint8Array };
  disconnected: { reason: string };
  reconnecting: { attempt: number };
  connected: void;
}

/**
 * Discriminates the four surface kinds.
 *
 * terminal / driver — cell-grid surfaces (cols×rows budget, xterm.js).
 * browser / settings — NON-terminal (pixel box, normal responsive DOM, NO tmux grid).
 */
export type SurfaceKind = 'terminal' | 'driver' | 'browser' | 'settings';

/** Returns true for cell-grid surfaces that use the xterm.js / tmux grid. */
export function isTerminalSurface(kind: SurfaceKind): boolean {
  return kind === 'terminal' || kind === 'driver';
}

// ---------------------------------------------------------------------------
// sessiond v1 control protocol
//
// Mirrors the frozen Go Message/WorkspaceInfo/PaneInfo shapes and the
// type/error-code literals. Field names match the Go JSON tags byte-for-byte
// so the browser speaks the exact same vocabulary as sessiond.
// ---------------------------------------------------------------------------

/** Frozen sessiond message-type vocabulary (mirrors Go's MsgType constants). */
export const SessiondType = {
  // Requests (client -> server)
  CreateWorkspace: 'create-workspace',
  ListWorkspaces: 'list-workspaces',
  RenameWorkspace: 'rename-workspace',
  CloseWorkspace: 'close-workspace',
  Attach: 'attach',
  CreatePane: 'create-pane',
  Resize: 'resize',
  // Replies (server -> requesting client)
  WorkspaceCreated: 'workspace-created',
  WorkspaceList: 'workspace-list',
  Composition: 'composition',
  PaneCreated: 'pane-created',
  Ok: 'ok',
  // Events (server -> all clients)
  PaneAdded: 'pane-added',
  PaneClosed: 'pane-closed',
  WorkspaceClosed: 'workspace-closed',
  WorkspaceRenamed: 'workspace-renamed',
  // Error
  Error: 'error',
} as const;

export type SessiondMessageType = (typeof SessiondType)[keyof typeof SessiondType];

/** Frozen sessiond error-code vocabulary (mirrors Go's ErrCode constants). */
export const SessiondErrorCode = {
  UnknownWorkspace: 'unknown-workspace',
  PaneSpawnFailed: 'pane-spawn-failed',
} as const;

export type SessiondErrorCodeValue = (typeof SessiondErrorCode)[keyof typeof SessiondErrorCode];

export interface SessiondWorkspaceInfo {
  workspaceId: string;
  name?: string;
  paneCount: number;
}

export interface SessiondPaneInfo {
  paneId: number;
  cols: number;
  rows: number;
  title?: string;
}

export interface SessiondMessage {
  type: SessiondMessageType;
  // cid is Go's uint64; JS numbers safely represent integers up to 2^53 and
  // cid is a small monotonic counter, so number is correct here (not bigint).
  cid?: number;
  workspaceId?: string;
  name?: string;
  paneId?: number;
  cols?: number;
  rows?: number;
  cmd?: string[];
  title?: string;
  workspaces?: SessiondWorkspaceInfo[];
  panes?: SessiondPaneInfo[];
  code?: SessiondErrorCodeValue;
  error?: string;
}

// ---------------------------------------------------------------------------
// Binary pane-data frame helpers
//
// WebSocket frame layout: [4-byte LITTLE-ENDIAN paneId][raw bytes]. Mirrors the
// Go WritePaneData/DecodePaneData payload so ws.ts and later phases bridge
// frames without rewriting them.
// ---------------------------------------------------------------------------

/** Encodes a pane-data frame: [4-byte little-endian paneId][raw bytes]. */
export function encodePaneFrame(paneId: number, data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(4 + data.length);
  const view = new DataView(buf);
  view.setUint32(0, paneId, true);
  new Uint8Array(buf, 4).set(data);
  return buf;
}

/** Decodes a pane-data frame; returned data aliases the input buffer (no copy). */
export function decodePaneFrame(buf: ArrayBuffer): { paneId: number; data: Uint8Array } {
  const view = new DataView(buf);
  const paneId = view.getUint32(0, true);
  const data = new Uint8Array(buf, 4);
  return { paneId, data };
}