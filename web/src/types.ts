// ---------------------------------------------------------------------------
// Activity-aware close contract
// ---------------------------------------------------------------------------

export type CloseTargetKind = 'pane' | 'workspace';

/** A workspace target cannot accidentally carry a pane identity. */
export type CloseTarget =
  | { targetKind: 'pane'; workspaceId: string; paneId: number }
  | { targetKind: 'workspace'; workspaceId: string };

export type CloseStatus = 'closed' | 'confirmation-required' | 'failed';
export type CloseRiskClassification = 'busy' | 'unknown';
export type CloseRiskReason =
  | 'command-active'
  | 'foreground-process'
  | 'custom-command'
  | 'unsupported-shell'
  | 'unsupported-platform'
  | 'missing-lifecycle'
  | 'stale-lifecycle'
  | 'process-inspection-failed'
  | 'pty-inspection-failed'
  | 'conflicting-evidence';

export interface CloseRisk {
  paneId: number;
  title: string;
  classification: CloseRiskClassification;
  reason: CloseRiskReason;
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
  // Replies (server -> requesting client)
  WorkspaceCreated: 'workspace-created',
  WorkspaceList: 'workspace-list',
  Composition: 'composition',
  PaneCreated: 'pane-created',
  CloseOutcome: 'close-outcome',
  Ok: 'ok',
  // Events (server -> all clients)
  PaneAdded: 'pane-added',
  PaneClosed: 'pane-closed',
  WorkspaceClosed: 'workspace-closed',
  WorkspaceRenamed: 'workspace-renamed',
  PaneRenamed: 'pane-renamed',
  PaneResized: 'pane-resized',
  // Error
  Error: 'error',
  // Layout / snapshot relay
  LayoutCommand: 'layout-command',
  ScreenSnapshot: 'screen-snapshot',
  GetLayout: 'get-layout',
  // Sidebar live preview (ADDITIVE, post-v1) — mirrors Go's
  // TypePreviewSubscribe / TypeWorkspacePreview. Deliberately NOT PaneUpdate
  // above: that entry has no Go counterpart and is dead vocabulary.
  PreviewSubscribe: 'preview-subscribe',
  WorkspacePreview: 'workspace-preview',
} as const;

export type SessiondMessageType = (typeof SessiondType)[keyof typeof SessiondType];

export type CloseIntentRequest = {
  type: typeof SessiondType.CloseIntent;
  cid: number;
} & CloseTarget;

export interface CloseConfirmRequest {
  type: typeof SessiondType.CloseConfirm;
  cid: number;
  ticket: string;
}

interface CloseOutcomeBase {
  type: typeof SessiondType.CloseOutcome;
  cid: number;
}

export type CloseClosedOutcome = CloseOutcomeBase &
  CloseTarget & {
    closeStatus: 'closed';
  };

export type CloseConfirmationRequiredOutcome = CloseOutcomeBase &
  CloseTarget & {
    closeStatus: 'confirmation-required';
    ticket: string;
    busyCount: number;
    unknownCount: number;
    risks: CloseRisk[];
    omittedRiskCount: number;
  };

export type CloseFailedOutcome = CloseOutcomeBase &
  CloseTarget & {
    closeStatus: 'failed';
    failureCode?: string;
    error?: string;
  };

export type CloseOutcome =
  | CloseClosedOutcome
  | CloseConfirmationRequiredOutcome
  | CloseFailedOutcome;

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

/** Pane execution status classification. */
export type PaneStatus = 'needs-input' | 'running' | 'completed';

/** Extended pane metadata tracked by the client. */
export interface PaneMetadata {
  tracked: boolean;    // true if this pane was created/manipulated by MCP service (agent-driven)
  status: PaneStatus;  // execution status: needs-input | running | completed
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
  targetKind?: CloseTargetKind;
  closeStatus?: CloseStatus;
  ticket?: string;
  busyCount?: number;
  unknownCount?: number;
  risks?: CloseRisk[];
  omittedRiskCount?: number;
  failureCode?: string;
  breakpoint?: string;
  layout?: string;
  /** Per-pane absolute byte offsets sent by the client on (re)attach so the
   *  server can replay only the delta since the client's last known position. */
  offsets?: { paneId: number; seq: number }[];
  /** Layout placement for pane-added events from MCP/external create-pane requests.
   *  Values: tab | split-right | split-left | split-above | split-below */
  placement?: string;
  /** Reference pane id for split placement (0 = active pane). */
  referencePaneId?: number;
  /** Boolean payload of preview-subscribe (enable/disable) and the ack flag on
   *  preview-subscribe-result. Mirrors Go's `ok` json tag. */
  ok?: boolean;
  /** Tile payload of workspace-preview: at most `rows` entries of at most
   *  `cols` characters, trailing-space trimmed on the wire. */
  lines?: string[];
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
  kind?: 'terminal';
  placement?: 'tab' | 'split-right' | 'split-left' | 'split-above' | 'split-below';
  referencePaneId?: number;
  workspaceId?: string;
}
