/**
 * Discriminates the four surface kinds.
 *
 * terminal / driver — cell-grid surfaces (cols×rows budget, xterm.js).
 * browser / settings — NON-terminal (pixel box, normal responsive DOM, NO terminal cell grid).
 */
export type SurfaceKind = 'terminal' | 'driver' | 'browser' | 'settings';

/** Returns true for cell-grid surfaces that use the xterm.js terminal grid. */
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
  ClosePane: 'close-pane',
  Resize: 'resize',
  RenamePane: 'rename-pane',
  SaveLayout: 'save-layout',
  PaneUpdate: 'pane-update',
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
  PaneRenamed: 'pane-renamed',
  // Error
  Error: 'error',
  // Browser-action relay (server → client → iframe → client → server)
  BrowserAction: 'browser-action',
  BrowserActionResult: 'browser-action-result',
  // Layout / snapshot relay
  LayoutCommand: 'layout-command',
  ScreenSnapshot: 'screen-snapshot',
  GetLayout: 'get-layout',
  // Tunnel management (client -> server and server -> client)
  CreateTunnel: 'create-tunnel',
  CloseTunnel: 'close-tunnel',
  ListTunnels: 'list-tunnels',
  TunnelCreated: 'tunnel-created',
  TunnelClosed: 'tunnel-closed',
  TunnelList: 'tunnel-list',
} as const;

export type SessiondMessageType = (typeof SessiondType)[keyof typeof SessiondType];

/** Describes a single active tunnel (port-forward). */
export interface TunnelInfo {
  id: string;
  port: number;
}

/** Frozen sessiond error-code vocabulary (mirrors Go's ErrCode constants). */
export const SessiondErrorCode = {
  UnknownWorkspace: 'unknown-workspace',
  PaneSpawnFailed: 'pane-spawn-failed',
} as const;

export type SessiondErrorCodeValue = (typeof SessiondErrorCode)[keyof typeof SessiondErrorCode];

export interface SessiondWorkspaceInfo {
  workspaceId: string;
  name?: string;
  clientRef?: string;
  paneCount: number;
}

export interface SessiondPaneInfo {
  paneId: number;
  cols: number;
  rows: number;
  title?: string;
  clientRef?: string;
  /** Absolute byte sequence of the first replayed byte for this pane.
   *  Omitted (undefined) when 0. Set by the server on each composition reply
   *  so the client can anchor its delta-replay offset tracking. */
  seq?: number;
  /** Total bytes ever written to this pane's buffer.
   *  expectedReplayBytes = totalSeq - seq. Used by the client settle barrier
   *  (RC-1) to defer ready=true until all replay data has arrived. */
  totalSeq?: number;
  // Browser-only fields (present when surfaceKind === 'browser')
  surfaceKind?: SurfaceKind;
  browserPort?: number;
  browserPath?: string;
  proxyHeaders?: Record<string, string>;
}

export interface SessiondMessage {
  type: SessiondMessageType;
  // cid is Go's uint64; JS numbers safely represent integers up to 2^53 and
  // cid is a small monotonic counter, so number is correct here (not bigint).
  cid?: number;
  clientRef?: string;
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
  breakpoint?: string;
  layout?: string;
  // Present when type === 'create-pane' or 'pane-added' for browser panes
  surfaceKind?: SurfaceKind;
  browserPort?: number;
  browserPath?: string;
  proxyHeaders?: Record<string, string>;
  /** Per-pane absolute byte offsets sent by the client on (re)attach so the
   *  server can replay only the delta since the client's last known position. */
  offsets?: { paneId: number; seq: number }[];
  /** Tunnel identifier (present on tunnel-created, tunnel-closed messages). */
  tunnelId?: string;
  /** Tunnel port number (present on create-tunnel request and tunnel-created reply). */
  tunnelPort?: number;
  /** List of active tunnels (present on tunnel-list reply). */
  tunnels?: TunnelInfo[];
  /** Layout placement for pane-added events from MCP/external create-pane requests.
   *  Values: tab | split-right | split-left | split-above | split-below */
  placement?: string;
  /** Reference pane id for split placement (0 = active pane). */
  referencePaneId?: number;
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

// ---------------------------------------------------------------------------
// Layout commands (server → client)
//
// Describes a dockview operation requested by a server-side agent.
// ---------------------------------------------------------------------------

/** A layout command sent by the server to manipulate the dockview UI. */
export interface LayoutCommand {
  command: 'create-pane' | 'rename-pane' | 'close-pane' | 'switch-workspace';
  paneId?: number;
  name?: string;
  kind?: 'terminal' | 'browser';
  placement?: 'tab' | 'split-right' | 'split-left' | 'split-above' | 'split-below';
  referencePaneId?: number;
  url?: string;
  workspaceId?: string;
}