/**
 * Discriminates the four surface kinds.
 *
 * terminal / driver — cell-grid surfaces (cols×rows budget, xterm.js).
 * browser / settings — NON-terminal. `browser` panes are client-rendered by the
 *   native apps; the web client shows a non-interactive placeholder for them.
 */
export type SurfaceKind = 'terminal' | 'driver' | 'browser' | 'settings';

/** Returns true for cell-grid surfaces that use the xterm.js terminal grid. */
export function isTerminalSurface(kind: SurfaceKind): boolean {
  return kind === 'terminal' || kind === 'driver';
}

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
  | 'browser-pane'
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
// Browser-safe crash-recovery projection
//
// This vocabulary intentionally excludes opaque external session identities,
// working directories, executable/argv/environment data, callback
// capabilities, generation claims, lifecycle captures, replacement plans,
// internal strategy IDs, and direct strategy-selection authority. Those remain
// daemon-local.
// ---------------------------------------------------------------------------

export type SessiondRecoveryStrategyLabel =
  | 'Amplifier'
  | 'Claude Code'
  | 'OpenCode'
  | 'Codex';

export type SessiondRecoveryStatus =
  | 'restoring'
  | 'recovered'
  | 'shell-restored'
  | 'selection-needed'
  | 'provisional'
  | 'strategy-failed';

/** Stable redacted categories only; never surface paths, IDs, or tool errors. */
export type SessiondRecoveryDetailCode =
  | 'none'
  | 'capture-missing'
  | 'capture-invalid'
  | 'capture-stale'
  | 'capture-conflicting'
  | 'capture-ambiguous'
  | 'working-directory-invalid'
  | 'strategy-unsupported'
  | 'schema-incompatible'
  | 'lifecycle-unavailable'
  | 'lifecycle-expired'
  | 'lifecycle-malformed'
  | 'lifecycle-zero'
  | 'lifecycle-unknown'
  | 'lifecycle-replayed'
  | 'lifecycle-stale'
  | 'lifecycle-cross-pane'
  | 'lifecycle-cross-strategy'
  | 'lifecycle-conflicting'
  | 'launch-rejected'
  | 'launch-failed'
  | 'observed-identity-mismatch'
  | 'readiness-timeout'
  | 'replacement-deferred'
  | 'replacement-failed'
  | 'replacement-plan-invalid'
  | 'active-pane-invalid'
  | 'candidate-invalid';

export interface SessiondRecoveryPaneRef {
  workspaceId: string;
  paneId: number;
}

/** Inert, sanitized recovered terminal history for one workspace-qualified pane. */
export interface SessiondRecoveredHistoryLiteral {
  pane: SessiondRecoveryPaneRef;
  text: string;
  truncated: boolean;
}

/** Bounds for the literal-history display contract. */
export const SessiondRecoveredHistoryMaxBytes = 4096;
export const SessiondRecoveredHistoryMaxLines = 256;

/**
 * Opaque daemon-issued candidate handle. It is bound by sessiond to the
 * workspace-qualified pane, current recovery fence, fixed strategy, and
 * candidate generation, expiry, single-use state, and an exact external
 * session identity that remains daemon-local. It is not an external session ID.
 */
export interface SessiondRecoverySelectionCandidate {
  candidateHandle: string;
  strategyLabel: SessiondRecoveryStrategyLabel;
}

/** Mirrors the daemon's bounded browser candidate projection. */
export const SessiondRecoveryMaxSelectionCandidates = 4;

interface SessiondPaneRecoveryBase {
  detailCode: SessiondRecoveryDetailCode;
  historyBoundary: boolean;
}

/**
 * Complete browser-safe recovery information for one pane. Recovery strategy
 * identity is deliberately a human-safe label only; internal strategy IDs,
 * session IDs, paths, launch data, capabilities, and fences are absent.
 */
export type SessiondPaneRecoveryInfo =
  | (SessiondPaneRecoveryBase & {
      status: 'restoring' | 'recovered';
      strategyLabel: SessiondRecoveryStrategyLabel;
      detailCode: 'none';
      canRetry: false;
      canSelect: false;
      selectionCandidates?: never;
    })
  | (SessiondPaneRecoveryBase & {
      status: 'shell-restored';
      strategyLabel?: never;
      detailCode: 'none';
      canRetry: false;
      canSelect: false;
      selectionCandidates?: never;
    })
  | (SessiondPaneRecoveryBase & {
      status: 'selection-needed';
      strategyLabel?: never;
      detailCode: Exclude<SessiondRecoveryDetailCode, 'none'>;
      canRetry: false;
      canSelect: true;
      /** At least one and at most SessiondRecoveryMaxSelectionCandidates. */
      selectionCandidates: readonly SessiondRecoverySelectionCandidate[];
    })
  | (SessiondPaneRecoveryBase & {
      status: 'provisional';
      strategyLabel: SessiondRecoveryStrategyLabel;
      detailCode: Exclude<SessiondRecoveryDetailCode, 'none'>;
      canRetry: false;
      canSelect: false;
      selectionCandidates?: never;
    })
  | (SessiondPaneRecoveryBase & {
      status: 'strategy-failed';
      strategyLabel: SessiondRecoveryStrategyLabel;
      detailCode: Exclude<SessiondRecoveryDetailCode, 'none'>;
      canRetry: true;
      canSelect: false;
      selectionCandidates?: never;
    });

export type SessiondRecoveryCapability =
  | 'pane-recovery-projection'
  | 'recovery-retry'
  | 'recovery-select'
  | 'active-pane-persistence'
  | 'recovered-history-literal';

/** Maximum length of SessiondRecoveryCapabilities.values. */
export const SessiondRecoveryMaxCapabilities = 8;
/** Maximum UTF-8 byte length of one syntactically valid capability offer. */
export const SessiondRecoveryMaxCapabilityBytes = 64;

/**
 * A hello offer can name a bounded future capability. Sessiond validates its
 * syntax and returns only the recognized intersection in a hello result.
 */
export type SessiondRecoveryCapabilityOffer = string;

export interface SessiondRecoveryCapabilityOffers {
  values: readonly SessiondRecoveryCapabilityOffer[];
}

/** Server-produced capability intersections contain recognized names only. */
export interface SessiondRecoveryCapabilities {
  /** Length is authoritative and must not exceed SessiondRecoveryMaxCapabilities. */
  values: readonly SessiondRecoveryCapability[];
}

export interface SessiondProtocolHello {
  recoverySchemaVersion: number;
  capabilities: SessiondRecoveryCapabilityOffers;
}

type SessiondProtocolHelloResultBase = {
  recoverySchemaVersion: number;
  capabilities: SessiondRecoveryCapabilities;
};

export type SessiondProtocolHelloResult =
  | (SessiondProtocolHelloResultBase & {
      compatible: true;
      detailCode: 'none';
    })
  | (SessiondProtocolHelloResultBase & {
      compatible: false;
      detailCode: 'schema-incompatible';
    });

export interface SessiondPaneRecoveryTransition {
  pane: SessiondRecoveryPaneRef;
  recovery: SessiondPaneRecoveryInfo;
}

/** A browser may retry only by naming a workspace-qualified pane. */
export interface SessiondRecoveryRetryRequest {
  pane: SessiondRecoveryPaneRef;
}

export interface SessiondRecoveryRetryResult {
  pane: SessiondRecoveryPaneRef;
  recovery: SessiondPaneRecoveryInfo;
}

/**
 * Browser selection returns only an opaque daemon-issued candidate handle.
 * Browser code has no recovery type containing external session IDs, CWDs,
 * executables, argv, capabilities, launch data, or transcripts.
 */
export interface SessiondRecoverySelectRequest {
  candidateHandle: string;
}

export interface SessiondRecoverySelectResult {
  pane: SessiondRecoveryPaneRef;
  recovery: SessiondPaneRecoveryInfo;
}

/** Redacted controlled-replacement result; plan handles remain daemon-local. */
export type SessiondRecoveryReplacementOutcome =
  | {
      state: 'committed';
      detailCode: 'none';
    }
  | {
      state: 'deferred';
      detailCode: 'replacement-deferred';
    }
  | {
      state: 'failed';
      detailCode: 'replacement-failed' | 'replacement-plan-invalid';
    };

/** Active-pane persistence always names the workspace-qualified pane. */
export interface SessiondActivePanePersistenceRequest {
  pane: SessiondRecoveryPaneRef;
}

export interface SessiondActivePanePersistenceResult {
  pane: SessiondRecoveryPaneRef;
  detailCode: 'none' | 'active-pane-invalid';
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
  // Browser-action relay (server → client → iframe → client → server)
  BrowserAction: 'browser-action',
  BrowserActionResult: 'browser-action-result',
  // Client-driven browser panes (native apps own the engine; web shows placeholder)
  CreateBrowserPane: 'create-browser-pane',
  CloseBrowserPane: 'close-browser-pane',
  BrowserCommand: 'browser-command',
  BrowserResult: 'browser-result',
  // Layout / snapshot relay
  LayoutCommand: 'layout-command',
  ScreenSnapshot: 'screen-snapshot',
  GetLayout: 'get-layout',
} as const;

/**
 * Additive browser-safe recovery message types. Keep this separate from
 * SessiondType because existing protocol mirrors assert its exact frozen map.
 */
export const SessiondRecoveryType = {
  ProtocolHello: 'protocol-hello',
  ProtocolHelloResult: 'protocol-hello-result',
  PaneRecoveryChanged: 'pane-recovery-changed',
  RecoveryRetry: 'recovery-retry',
  RecoveryRetryResult: 'recovery-retry-result',
  RecoverySelect: 'recovery-select',
  RecoverySelectResult: 'recovery-select-result',
  ReplacementOutcome: 'replacement-outcome',
  RecoveredHistory: 'recovered-history',
  SetActivePane: 'set-active-pane',
  SetActivePaneResult: 'set-active-pane-result',
} as const;

export type SessiondRecoveryMessageType =
  (typeof SessiondRecoveryType)[keyof typeof SessiondRecoveryType];

export type SessiondMessageType =
  | (typeof SessiondType)[keyof typeof SessiondType]
  | SessiondRecoveryMessageType;

/**
 * Explicit browser-safe recovery requests. Privileged lifecycle, replacement,
 * capture, lease, launch, and external-session shapes intentionally have no
 * TypeScript representation in the web package.
 */
export type SessiondBrowserRecoveryRequest =
  | {
      type: typeof SessiondRecoveryType.ProtocolHello;
      protocolHello: SessiondProtocolHello;
    }
  | {
      type: typeof SessiondRecoveryType.RecoveryRetry;
      recoveryRetry: SessiondRecoveryRetryRequest;
    }
  | {
      type: typeof SessiondRecoveryType.RecoverySelect;
      recoverySelect: SessiondRecoverySelectRequest;
    }
  | {
      type: typeof SessiondRecoveryType.SetActivePane;
      activePanePersistence: SessiondActivePanePersistenceRequest;
    };

/** Explicit browser-safe recovery replies/events; all are redacted. */
export type SessiondBrowserRecoveryEvent =
  | {
      type: typeof SessiondRecoveryType.ProtocolHelloResult;
      protocolHelloResult: SessiondProtocolHelloResult;
    }
  | {
      type: typeof SessiondRecoveryType.PaneRecoveryChanged;
      recoveryTransition: SessiondPaneRecoveryTransition;
    }
  | {
      type: typeof SessiondRecoveryType.RecoveryRetryResult;
      recoveryRetryResult: SessiondRecoveryRetryResult;
    }
  | {
      type: typeof SessiondRecoveryType.RecoverySelectResult;
      recoverySelectResult: SessiondRecoverySelectResult;
    }
  | {
      type: typeof SessiondRecoveryType.ReplacementOutcome;
      replacementOutcome: SessiondRecoveryReplacementOutcome;
    }
  | {
      /** Server event only: a literal-history event is never correlated. */
      type: typeof SessiondRecoveryType.RecoveredHistory;
      cid?: 0;
      recoveredHistory: SessiondRecoveredHistoryLiteral;
    }
  | {
      type: typeof SessiondRecoveryType.SetActivePaneResult;
      activePanePersistenceResult: SessiondActivePanePersistenceResult;
    };

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
  surfaceKind?: SurfaceKind;
  /** Daemon-authoritative, redacted recovery projection when available. */
  recovery?: SessiondPaneRecoveryInfo;
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
  // Present when type === 'create-pane' or 'pane-added' for browser-cdp panes
  surfaceKind?: SurfaceKind;
  /** Per-pane absolute byte offsets sent by the client on (re)attach so the
   *  server can replay only the delta since the client's last known position. */
  offsets?: { paneId: number; seq: number }[];
  /** Layout placement for pane-added events from MCP/external create-pane requests.
   *  Values: tab | split-right | split-left | split-above | split-below */
  placement?: string;
  /** Reference pane id for split placement (0 = active pane). */
  referencePaneId?: number;
  /** Optional browser-safe recovery projection for a pane message. */
  recovery?: SessiondPaneRecoveryInfo;
  /** Optional browser-safe live transition for a workspace-qualified pane. */
  recoveryTransition?: SessiondPaneRecoveryTransition;
  /** Browser-safe protocol negotiation envelope. */
  protocolHello?: SessiondProtocolHello;
  /** Browser-safe protocol negotiation result envelope. */
  protocolHelloResult?: SessiondProtocolHelloResult;
  /** Exact retry intent; sessiond resolves the current recovery fence. */
  recoveryRetry?: SessiondRecoveryRetryRequest;
  /** Redacted retry result. */
  recoveryRetryResult?: SessiondRecoveryRetryResult;
  /** Opaque browser selection intent; no external session identity is present. */
  recoverySelect?: SessiondRecoverySelectRequest;
  /** Redacted selection result after sessiond revalidates the candidate lease. */
  recoverySelectResult?: SessiondRecoverySelectResult;
  /** Redacted controlled-replacement status. */
  replacementOutcome?: SessiondRecoveryReplacementOutcome;
  /** Inert literal recovered history; bounded and sanitized by sessiond. */
  recoveredHistory?: SessiondRecoveredHistoryLiteral;
  /** Workspace-qualified active-pane persistence intent. */
  activePanePersistence?: SessiondActivePanePersistenceRequest;
  /** Workspace-qualified active-pane persistence result. */
  activePanePersistenceResult?: SessiondActivePanePersistenceResult;
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
