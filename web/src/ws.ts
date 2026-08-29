import {
  SessiondType,
  encodePaneFrame,
  decodePaneFrame,
  type CloseConfirmRequest,
  type CloseIntentRequest,
  type CloseOutcome,
  type CloseRisk,
  type CloseRiskReason,
  type CloseTarget,
  type SessiondMessage,
  type SessiondRecoveryCapability,
  type SessiondRecoveryPaneRef,
} from './types';
import type { MuxStore } from './state';
import {
  buildActivePanePersistence,
  buildProtocolHello,
  buildRecoveryRetry,
  buildRecoverySelect,
  classifyRecoveryInbound,
  utf8ByteLength,
  type RecoveryWireEvent,
} from './recovery-wire';

export type PaneOutputCallback = (paneId: number, data: Uint8Array) => void;
export type ControlMessageCallback = (msg: Record<string, unknown>) => void;
export type RecoveryEventCallback = (event: RecoveryWireEvent) => void;
export type RecoveryNegotiationCallback = (
  compatible: boolean,
  capabilities: ReadonlySet<SessiondRecoveryCapability>,
) => void;

const BACKOFF_BASE = 1000;
const BACKOFF_CAP = 30000;
const JITTER_MAX = 500;
const CLOSE_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CID = Number.MAX_SAFE_INTEGER;
const INVALID_CLOSE_TICKET_FAILURE = 'invalid-close-ticket';
const CLOSE_RISK_REASONS = new Set<CloseRiskReason>([
  'command-active',
  'foreground-process',
  'custom-command',
  'browser-pane',
  'unsupported-shell',
  'unsupported-platform',
  'missing-lifecycle',
  'stale-lifecycle',
  'process-inspection-failed',
  'pty-inspection-failed',
  'conflicting-evidence',
]);

interface PendingCloseRequest {
  target: CloseTarget;
  kind: 'intent' | 'confirm';
  resolve: (outcome: CloseOutcome) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasValidCloseTarget(message: Record<string, unknown>): boolean {
  if (typeof message.workspaceId !== 'string' || message.workspaceId.length === 0) return false;
  if (message.targetKind === 'pane') return isNonNegativeSafeInteger(message.paneId);
  return message.targetKind === 'workspace' && message.paneId === undefined;
}

function isCloseRisk(value: unknown): value is CloseRisk {
  if (typeof value !== 'object' || value === null) return false;
  const risk = value as Record<string, unknown>;
  return (
    isNonNegativeSafeInteger(risk.paneId) &&
    typeof risk.title === 'string' &&
    (risk.classification === 'busy' || risk.classification === 'unknown') &&
    typeof risk.reason === 'string' &&
    CLOSE_RISK_REASONS.has(risk.reason as CloseRiskReason)
  );
}

function sameCloseTarget(left: CloseTarget, right: CloseTarget): boolean {
  return (
    left.targetKind === right.targetKind &&
    left.workspaceId === right.workspaceId &&
    (left.targetKind === 'workspace' ||
      (right.targetKind === 'pane' && left.paneId === right.paneId))
  );
}

function isCloseOutcome(value: unknown): value is CloseOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.type !== SessiondType.CloseOutcome || !isPositiveSafeInteger(message.cid)) return false;
  if (!hasValidCloseTarget(message)) return false;

  switch (message.closeStatus) {
    case 'closed':
      return true;
    case 'failed':
      return (
        (message.failureCode === undefined || typeof message.failureCode === 'string') &&
        (message.error === undefined || typeof message.error === 'string')
      );
    case 'confirmation-required':
      return (
        typeof message.ticket === 'string' &&
        message.ticket.length > 0 &&
        isNonNegativeSafeInteger(message.busyCount) &&
        isNonNegativeSafeInteger(message.unknownCount) &&
        Array.isArray(message.risks) &&
        message.risks.every(isCloseRisk) &&
        isNonNegativeSafeInteger(message.omittedRiskCount)
      );
    default:
      return false;
  }
}

export class MuxSocket {
  private _store: MuxStore;
  private _url: string;
  private _ws: WebSocket | null = null;
  private _paneOutputCb: PaneOutputCallback | null = null;
  private _controlMessageCb: ControlMessageCallback | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _reconnectAttempts = 0;
  private _intentionalClose = false;
  private _nextCid = 1;
  private _pendingCloseRequests = new Map<number, PendingCloseRequest>();
  private _recoveryCompatible = false;
  private _recoveryCapabilities = new Set<SessiondRecoveryCapability>();
  private _helloSent = false;

  onDisconnect: (() => void) | null = null;
  onReconnect: (() => void) | null = null;
  onSessiondMessage: ((msg: SessiondMessage) => void) | null = null;
  onRecoveryEvent: RecoveryEventCallback | null = null;
  onRecoveryNegotiationChange: RecoveryNegotiationCallback | null = null;
  /**
   * Fires when the daemon broadcasts pane-resized: the canonical PTY size for
   * paneId changed because some other client became (or already was)
   * authoritative for it. A direct callback property, like onDisconnect/
   * onReconnect above — not the window CustomEvent relay pattern used below
   * for browser-action/layout-command, since the only consumer
   * (terminalRegistry) is a plain module app.ts already imports directly; no
   * need for a window-event round-trip.
   */
  onPaneResized: ((paneId: number, cols: number, rows: number) => void) | null = null;

  constructor(store: MuxStore, url: string) {
    this._store = store;
    this._url = url;
  }

  onPaneOutput(cb: PaneOutputCallback): void {
    this._paneOutputCb = cb;
  }

  onControlMessage(cb: ControlMessageCallback): void {
    this._controlMessageCb = cb;
  }

  connect(): void {
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._open();
  }

  disconnect(): void {
    this._intentionalClose = true;
    this._helloSent = false;
    this._resetRecoveryNegotiation();
    this._rejectPendingCloseRequests(
      new Error('The close outcome could not be confirmed because the connection closed.'),
    );
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  sendPaneInput(paneId: number, data: Uint8Array): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN && this._helloSent) {
      this._ws.send(encodePaneFrame(paneId, data));
    }
  }

  // --- sessiond v1 control senders -----------------------------------------
  // All senders emit the FLAT SessiondMessage envelope (no single-key
  // wrapping) and consume the frozen SessiondType vocabulary, never raw
  // strings.

  /** Send one flat sessiond control message if the socket is open. */
  private sendSessiond(msg: SessiondMessage): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN && this._helloSent) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  /** Attach this connection to a workspace. */
  attach(workspaceId: string): void {
    this.sendSessiond({ type: SessiondType.Attach, workspaceId });
  }

  /** Attach, telling the daemon our responsive breakpoint so it returns the
   *  matching saved layout in the composition reply. */
  attachWithBreakpoint(workspaceId: string, breakpoint: string): void {
    this.sendSessiond({ type: SessiondType.Attach, workspaceId, breakpoint });
  }

  renamePane(paneId: number, name: string): void {
    this.sendSessiond({ type: SessiondType.RenamePane, paneId, name });
  }

  saveLayout(workspaceId: string, breakpoint: string, layout: string): void {
    this.sendSessiond({ type: SessiondType.SaveLayout, workspaceId, breakpoint, layout });
  }

  /** Request the list of workspaces. */
  listWorkspaces(): void {
    this.sendSessiond({ type: SessiondType.ListWorkspaces });
  }

  /**
   * Create a new workspace; name and clientRef are each included only when
   * truthy.
   */
  createWorkspace(name?: string, clientRef?: string): void {
    const msg: SessiondMessage = { type: SessiondType.CreateWorkspace };
    if (name) msg.name = name;
    if (clientRef) msg.clientRef = clientRef;
    this.sendSessiond(msg);
  }

  /** Rename an existing workspace. */
  renameWorkspace(workspaceId: string, name: string): void {
    this.sendSessiond({ type: SessiondType.RenameWorkspace, workspaceId, name });
  }

  /** Assess and, when safe, close a pane or workspace in one correlated request. */
  closeIntent(target: CloseTarget): Promise<CloseOutcome> {
    return this._sendCloseRequest(target, 'intent', (cid) => {
      if (target.targetKind === 'pane') {
        return {
          type: SessiondType.CloseIntent,
          cid,
          targetKind: 'pane',
          workspaceId: target.workspaceId,
          paneId: target.paneId,
        };
      }
      return {
        type: SessiondType.CloseIntent,
        cid,
        targetKind: 'workspace',
        workspaceId: target.workspaceId,
      };
    });
  }

  /** Confirm exactly the opaque assessment ticket returned by sessiond. */
  closeConfirm(ticket: string, target: CloseTarget): Promise<CloseOutcome> {
    return this._sendCloseRequest(target, 'confirm', (cid) => ({
      type: SessiondType.CloseConfirm,
      cid,
      ticket,
    }));
  }

  /** A structural broadcast supersedes any still-pending reply for this target. */
  settleCloseTarget(target: CloseTarget): void {
    for (const [cid, pending] of this._pendingCloseRequests) {
      if (sameCloseTarget(pending.target, target)) this._resolvePendingAsClosed(cid, pending);
    }
  }

  /** Workspace removal also settles pane-close requests scoped to that workspace. */
  settleCloseWorkspace(workspaceId: string): void {
    for (const [cid, pending] of this._pendingCloseRequests) {
      if (pending.target.workspaceId === workspaceId) this._resolvePendingAsClosed(cid, pending);
    }
  }

  /**
   * Create a connection-scoped pane (NO workspaceId). cmd is included only
   * when it carries at least one argument. clientRef is included only when
   * truthy.
   */
  createPane(cmd?: string[], clientRef?: string): void {
    const msg: SessiondMessage = { type: SessiondType.CreatePane };
    if (cmd && cmd.length > 0) msg.cmd = cmd;
    if (clientRef) msg.clientRef = clientRef;
    this.sendSessiond(msg);
  }

  /** Open a browser CDP pane on the server side. */
  createBrowserPane(): void {
    this.sendSessiond({ type: SessiondType.CreateBrowserPane });
  }

  /** Close the active browser CDP pane on the server side. */
  closeBrowserPane(): void {
    this.sendSessiond({ type: SessiondType.CloseBrowserPane });
  }

  /**
   * Report a pane's measured rendered grid (active-view-wins by construction:
   * only visible panes own a live ResizeObserver, so tabbed-away panes never
   * call resize).
   */
  resize(paneId: number, cols: number, rows: number): void {
    this.sendSessiond({ type: SessiondType.Resize, paneId, cols, rows });
  }

  /**
   * Claim PTY-sizing authority for a pane: sent when it becomes this client's
   * visible+OS-focused view (dockview active-tab change, visibilitychange,
   * window focus, or initial attach/reconnect). Carries this client's current
   * measured size so the daemon can resize the PTY in the same round-trip
   * rather than waiting for a separate resize message afterward. Mirrors
   * resize()'s shape exactly — same three fields, different type.
   */
  paneFocus(paneId: number, cols: number, rows: number): void {
    this.sendSessiond({ type: SessiondType.PaneFocus, paneId, cols, rows });
  }

  destroy(): void {
    this._intentionalClose = true;
    this._helloSent = false;
    this._resetRecoveryNegotiation();
    this._rejectPendingCloseRequests(
      new Error('The close outcome could not be confirmed because the connection was destroyed.'),
    );
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    if (this._ws) {
      this._ws.close(1000);
      this._ws = null;
    }
  }

  get connected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  get recoveryCompatible(): boolean {
    return this._recoveryCompatible;
  }

  supportsRecoveryCapability(capability: SessiondRecoveryCapability): boolean {
    return this._recoveryCompatible && this._recoveryCapabilities.has(capability);
  }

  retryRecovery(pane: SessiondRecoveryPaneRef): boolean {
    return this._sendRecoveryIntent('recovery-retry', (cid) => buildRecoveryRetry(pane, cid));
  }

  selectRecovery(candidateHandle: string): boolean {
    return this._sendRecoveryIntent('recovery-select', (cid) =>
      buildRecoverySelect(candidateHandle, cid),
    );
  }

  persistActivePane(pane: SessiondRecoveryPaneRef): boolean {
    return this._sendRecoveryIntent('active-pane-persistence', (cid) =>
      buildActivePanePersistence(pane, cid),
    );
  }

  private _scheduleReconnect(): void {
    const delay = Math.min(BACKOFF_BASE * 2 ** this._reconnectAttempts, BACKOFF_CAP);
    const jitter = Math.random() * JITTER_MAX;
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => this._open(), delay + jitter);
  }

  /**
   * All browser-originated correlated requests use one socket-wide sequence.
   * Pending close requests reserve their IDs until their authoritative outcome
   * arrives, so wraparound cannot accidentally resolve a close with another
   * request's CID.
   */
  private _allocateCid(): number {
    const start = this._nextCid;
    do {
      const cid = this._nextCid;
      this._nextCid = cid >= MAX_CID ? 1 : cid + 1;
      if (!this._pendingCloseRequests.has(cid)) return cid;
    } while (this._nextCid !== start);
    throw new Error('No request correlation IDs are available.');
  }

  private _sendCloseRequest(
    target: CloseTarget,
    kind: PendingCloseRequest['kind'],
    buildMessage: (cid: number) => CloseIntentRequest | CloseConfirmRequest,
  ): Promise<CloseOutcome> {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._helloSent) {
      return Promise.reject(new Error('Cannot request close while disconnected.'));
    }

    let cid: number;
    try {
      cid = this._allocateCid();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    return new Promise<CloseOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this._pendingCloseRequests.get(cid);
        if (!pending) return;
        this._pendingCloseRequests.delete(cid);
        pending.reject(new Error('The close outcome could not be confirmed before the request timed out.'));
      }, CLOSE_REQUEST_TIMEOUT_MS);

      this._pendingCloseRequests.set(cid, { target, kind, resolve, reject, timer });
      try {
        ws.send(JSON.stringify(buildMessage(cid)));
      } catch (error) {
        const pending = this._pendingCloseRequests.get(cid);
        if (!pending) return;
        clearTimeout(pending.timer);
        this._pendingCloseRequests.delete(cid);
        pending.reject(
          error instanceof Error
            ? error
            : new Error('The close request could not be sent.'),
        );
      }
    });
  }

  private _resolveCloseOutcome(raw: Record<string, unknown>): void {
    if (raw.type !== SessiondType.CloseOutcome || !isPositiveSafeInteger(raw.cid)) return;
    const pending = this._pendingCloseRequests.get(raw.cid);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pendingCloseRequests.delete(raw.cid);
    const outcome = this._normalizeCloseOutcome(raw, pending);
    if (isCloseOutcome(outcome)) {
      pending.resolve(outcome);
    } else {
      pending.reject(new Error('The close service returned an invalid outcome.'));
    }
  }

  /**
   * A relay may have evicted its own opaque-ticket lookup before sessiond
   * rejects that ticket. The browser still has the correlated pending target,
   * so restore it only for the stable invalid-ticket confirmation failure.
   */
  private _normalizeCloseOutcome(
    raw: Record<string, unknown>,
    pending: PendingCloseRequest,
  ): Record<string, unknown> {
    if (
      pending.kind === 'confirm' &&
      raw.type === SessiondType.CloseOutcome &&
      raw.closeStatus === 'failed' &&
      raw.failureCode === INVALID_CLOSE_TICKET_FAILURE &&
      !hasValidCloseTarget(raw)
    ) {
      return { ...raw, ...pending.target };
    }
    return raw;
  }

  private _resolvePendingAsClosed(cid: number, pending: PendingCloseRequest): void {
    clearTimeout(pending.timer);
    this._pendingCloseRequests.delete(cid);
    pending.resolve({
      type: SessiondType.CloseOutcome,
      cid,
      ...pending.target,
      closeStatus: 'closed',
    });
  }

  private _rejectPendingCloseRequests(error: Error): void {
    for (const pending of this._pendingCloseRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pendingCloseRequests.clear();
  }

  private _sendRecoveryIntent(
    capability: SessiondRecoveryCapability,
    build: (cid: number) => Record<string, unknown> | null,
  ): boolean {
    const ws = this._ws;
    if (
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      !this._helloSent ||
      !this._recoveryCompatible ||
      !this._recoveryCapabilities.has(capability)
    ) {
      return false;
    }

    try {
      const message = build(this._allocateCid());
      if (message === null) return false;
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private _setRecoveryNegotiation(
    compatible: boolean,
    capabilities: readonly SessiondRecoveryCapability[],
  ): void {
    const nextCapabilities = new Set(capabilities);
    const changed =
      this._recoveryCompatible !== compatible ||
      this._recoveryCapabilities.size !== nextCapabilities.size ||
      [...this._recoveryCapabilities].some((capability) => !nextCapabilities.has(capability));
    if (!changed) return;

    this._recoveryCompatible = compatible;
    this._recoveryCapabilities = nextCapabilities;
    this.onRecoveryNegotiationChange?.(compatible, new Set(nextCapabilities));
  }

  private _resetRecoveryNegotiation(): void {
    this._setRecoveryNegotiation(false, []);
  }

  private _open(): void {
    this._helloSent = false;
    this._resetRecoveryNegotiation();
    const ws = new WebSocket(this._url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      if (this._ws !== ws) return;
      this._reconnectAttempts = 0;
      try {
        ws.send(JSON.stringify(buildProtocolHello()));
        this._helloSent = true;
      } catch {
        ws.close();
        return;
      }
      this.onReconnect?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this._ws !== ws) return;
      // Binary pane-data frame: [4-byte LE paneId][raw bytes].
      if (ev.data instanceof ArrayBuffer) {
        if (ev.data.byteLength >= 4) {
          const { paneId, data } = decodePaneFrame(ev.data);
          this._paneOutputCb?.(paneId, data);
        }
        return;
      }
      // Text frame — JSON control message
      if (typeof ev.data === 'string') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;

        const classified = classifyRecoveryInbound(parsed, utf8ByteLength(ev.data));
        if (classified.kind === 'reject') return;
        if (classified.kind === 'recovery') {
          if (classified.event.type === 'protocol-hello-result') {
            this._setRecoveryNegotiation(
              classified.event.protocolHelloResult.compatible,
              classified.event.protocolHelloResult.capabilities.values,
            );
          }
          this.onRecoveryEvent?.(classified.event);
          return;
        }

        const raw = classified.message;
        this._resolveCloseOutcome(raw);
        // Pass the raw message to control handlers (e.g. for detached/session-picker).
        // Non-typed envelopes (e.g. serve config) still flow through here after
        // recovery payloads have been stripped.
        this._controlMessageCb?.(raw);
        // Flat sessiond messages carry a top-level "type" string; route them to
        // the sessiond hook. (Legacy single-key envelopes have no "type" field,
        // so the two paths never collide.)
        if (typeof raw.type === 'string') {
          this.onSessiondMessage?.(raw as unknown as SessiondMessage);
          // Relay-only types: dispatch as window CustomEvents so app.ts and
          // mux-dock can handle them without coupling to the socket directly.
          if (raw.type === SessiondType.BrowserAction) {
            window.dispatchEvent(new CustomEvent('browser-action', { detail: raw }));
          } else if (raw.type === SessiondType.LayoutCommand) {
            window.dispatchEvent(new CustomEvent('layout-command', { detail: raw }));
          } else if (raw.type === SessiondType.PaneResized) {
            this.onPaneResized?.(raw.paneId as number, raw.cols as number, raw.rows as number);
          }
        }
      }
    };

    ws.onclose = () => {
      if (this._ws !== ws) return;
      this._helloSent = false;
      this._resetRecoveryNegotiation();
      this._rejectPendingCloseRequests(
        new Error('The close outcome could not be confirmed because the connection was lost.'),
      );
      if (this._intentionalClose) {
        return;
      }
      this.onDisconnect?.();
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // no-op — onclose fires after onerror
    };
  }
}

export function buildWsUrl(path = '/ws'): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
