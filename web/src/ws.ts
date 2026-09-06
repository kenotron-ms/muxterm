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
} from './types';
import type { MuxStore } from './state';
import { wsUrl } from './lib/base-path.js';
import { hostSelector } from './lib/host-ref.js';
import { HOST_STATE, remotesStore } from './lib/remotes-store.js';

export type PaneOutputCallback = (paneId: number, data: Uint8Array) => void;
export type ControlMessageCallback = (msg: Record<string, unknown>) => void;

const BACKOFF_BASE = 1000;
const BACKOFF_CAP = 30000;
const JITTER_MAX = 500;
const CLOSE_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CLOSE_CID = Number.MAX_SAFE_INTEGER;
const INVALID_CLOSE_TICKET_FAILURE = 'invalid-close-ticket';
const CLOSE_RISK_REASONS = new Set<CloseRiskReason>([
  'command-active',
  'foreground-process',
  'custom-command',
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
  private _nextCloseCid = 1;
  private _pendingCloseRequests = new Map<number, PendingCloseRequest>();

  onDisconnect: (() => void) | null = null;
  onReconnect: (() => void) | null = null;
  onSessiondMessage: ((msg: SessiondMessage) => void) | null = null;
  /**
   * Fires when the daemon broadcasts pane-resized: the canonical PTY size for
   * paneId changed because some other client became (or already was)
   * authoritative for it. A direct callback property, like onDisconnect/
   * onReconnect above — not the window CustomEvent relay pattern used below
   * for layout-command, since the only consumer
   * (terminalRegistry) is a plain module app.ts already imports directly; no
   * need for a window-event round-trip.
   */
  onPaneResized: ((paneId: number, cols: number, rows: number) => void) | null = null;
  /**
   * Fires when the daemon pushes a sidebar preview tile for a workspace this
   * connection is NOT attached to (the tile names its own workspace). Same
   * direct-callback shape as onPaneResized above: the only consumer
   * (previewStore) is a plain module app.ts already imports.
   *
   * Optional by construction — an old daemon never sends these, and a client
   * that never calls previewSubscribe(true) never receives them.
   */
  onWorkspacePreview?: (msg: SessiondMessage) => void;
  /**
   * Fires when the daemon pushes the home view's session set — every Amplifier
   * (or other harness) session it can see, across every workspace, not just the
   * attached one. Same direct-callback shape as onWorkspacePreview above.
   *
   * ⚠ The frame carries `sessions` with `omitempty` on the Go side, because
   * Message is one flat envelope shared by every message type. That means the
   * most important transition — N sessions to zero — arrives as a bare
   * `{"type":"session-state"}` with no field at all. Treat the ARRIVAL of the
   * message as the signal and a missing field as the empty set, or the
   * needs-input badge sticks forever at its last non-zero value.
   */
  onSessionState?: (msg: SessiondMessage) => void;
  /**
   * Fires for every serve-local chief-of-staff frame: cos-subscribe-result and
   * cos-event. Same direct-callback shape as onSessionState above.
   *
   * These are SERVE-LOCAL, not sessiond messages -- the CoS conversation is
   * owned by the muxterm server, not by any daemon -- so they are routed here
   * and deliberately NOT forwarded to onSessiondMessage, which would hand the
   * frozen wire-state store a message type it has no projection for.
   */
  onCosFrame?: (frame: Record<string, unknown>) => void;
  /**
   * Fires on a host-state frame: one remote host's connection state changed
   * (or the server is describing the registry to a freshly attached tab).
   *
   * Typed as a raw record rather than SessiondMessage on purpose — host-state
   * is RELAY-ONLY. It is not a sessiond message type, it never travels on a
   * daemon socket, and it exists precisely so that adding remotes costs
   * `internal/sessiond/protocol.go` nothing.
   *
   * A browser with no remotes configured never receives one, which is the
   * mechanism behind the zero-remote gate.
   */
  onHostState?: (msg: Record<string, unknown>) => void;

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

  /**
   * Send one pane-input frame, unless the host behind the attached workspace
   * is not currently connected.
   *
   * The drop is the whole point: input aimed at a host whose link is down is
   * DISCARDED, never queued. Replaying a buffer of keystrokes into a shell
   * that has moved on — a different directory, a different prompt, a
   * half-typed command — is how you `rm -rf` the wrong thing. A read-only
   * window is the honest state, and it lasts exactly as long as the outage.
   *
   * Local panes are untouched: remotesStore.stateOf() returns null for a bare
   * (local) workspace id, and with no remotes configured every id is bare, so
   * this reduces to today's send.
   *
   * It lives here rather than at each keyboard handler because this is the one
   * choke point all three input paths already pass through.
   */
  sendPaneInput(paneId: number, data: Uint8Array): void {
    const attached = this._store.attached;
    if (attached !== null) {
      const hostState = remotesStore.stateOf(attached);
      if (hostState !== null && hostState !== 'connected') return;
    }
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(encodePaneFrame(paneId, data));
    }
  }

  // --- sessiond v1 control senders -----------------------------------------
  // All senders emit the FLAT SessiondMessage envelope (no single-key
  // wrapping) and consume the frozen SessiondType vocabulary, never raw
  // strings.

  /**
   * Send one flat sessiond control message if the socket is open.
   *
   * Returns whether it actually went out. A closed socket drops the frame
   * silently, which is fine for fire-and-forget senders but NOT for a caller
   * that arms state expecting a reply -- it would wait forever on an answer to
   * a question that was never asked.
   */
  private sendSessiond(msg: SessiondMessage): boolean {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /**
   * The workspace of the most recent attach this connection actually sent,
   * or null if it has never sent one.
   *
   * This is INTENT, and it is deliberately distinct from `store.attached`,
   * which is confirmation -- the store is only written when a composition
   * comes back. Between the two lies every in-flight attach, including the
   * autonomous ones WorkspaceController fires on recovery and on
   * workspace-created, which no user action announces.
   *
   * Recorded here, at the one choke point every attach must pass through,
   * rather than at each call site: a caller that needs to know "is the
   * connection still going where I think it is" then cannot be defeated by a
   * new attach path someone adds later and forgets to notify.
   */
  get lastAttachTarget(): string | null {
    return this._lastAttachTarget;
  }

  private _lastAttachTarget: string | null = null;

  /** Attach this connection to a workspace. */
  attach(workspaceId: string): void {
    if (this.sendSessiond({ type: SessiondType.Attach, workspaceId })) {
      this._lastAttachTarget = workspaceId;
    }
  }

  /** Attach, telling the daemon our responsive breakpoint so it returns the
   *  matching saved layout in the composition reply. */
  attachWithBreakpoint(workspaceId: string, breakpoint: string): void {
    if (this.sendSessiond({ type: SessiondType.Attach, workspaceId, breakpoint })) {
      this._lastAttachTarget = workspaceId;
    }
  }

  renamePane(paneId: number, name: string): void {
    this.sendSessiond({ type: SessiondType.RenamePane, paneId, name });
  }

  saveLayout(workspaceId: string, breakpoint: string, layout: string): void {
    this.sendSessiond({ type: SessiondType.SaveLayout, workspaceId, breakpoint, layout });
  }

  /**
   * Turn sidebar preview tiles on or off for THIS connection.
   *
   * Opt-in by design: with it off the daemon renders nothing and puts zero
   * bytes on the wire, so `preview = "off"` is genuinely free rather than just
   * visually suppressed. Must be re-sent after a reconnect — the flag lives on
   * the daemon connection, which a daemon restart replaces.
   */
  previewSubscribe(enabled: boolean): void {
    this.sendSessiond({ type: SessiondType.PreviewSubscribe, ok: enabled });
  }

  /**
   * Turn home-view session state on or off for THIS connection.
   *
   * Opt-in for the same reason preview is: with it off the daemon never reads
   * the spool directory and never walks /proc, so the cost is genuinely zero
   * rather than merely hidden. Must be re-sent after a reconnect — the flag
   * lives on the daemon connection, which a daemon restart replaces.
   */
  /**
   * The home view's desired session-state subscription, remembered so the
   * socket can re-assert it itself.
   *
   * It has to live here rather than at the call site, because the call site
   * cannot know when the socket is writable: the app opts in during startup,
   * synchronously after constructing this socket, which is BEFORE the
   * WebSocket has opened -- and sendSessiond silently drops anything sent
   * before OPEN. That dropped frame is not a small bug. With no subscription
   * the daemon never reads the spool, no session-state frame is ever pushed,
   * and the home view sits on \"All clear\" forever while real sessions are
   * running. Storing the intent and replaying it on open closes that hole and
   * the reconnect one with a single mechanism.
   */
  private _sessionStateWanted = false;

  sessionStateSubscribe(enabled: boolean): void {
    this._sessionStateWanted = enabled;
    this.sendSessiond({ type: SessiondType.SessionStateSubscribe, ok: enabled });
  }

  // --- chief-of-staff senders ----------------------------------------------
  // Serve-local frames. They never reach sessiond, so they bypass
  // sendSessiond's frozen SessiondMessage type and go out as plain objects.

  /**
   * Remembered like _sessionStateWanted, and for the same reason: the overlay
   * can be opened before a reconnect completes, and a subscription lives on
   * the connection that carried it. Without the replay a reconnect would leave
   * the chat rendering a conversation it is no longer being told about.
   */
  private _cosWanted = false;

  private _sendCos(frame: Record<string, unknown>): boolean {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  /**
   * Opt this connection in to (or out of) the shared chief-of-staff stream.
   *
   * The FIRST `true` is also what starts the sidecar: the server spawns it
   * lazily, so muxterm pays nothing for a feature nobody opened.
   */
  cosSubscribe(on: boolean): void {
    this._cosWanted = on;
    this._sendCos({ type: 'cos-subscribe', on });
  }

  /** Submit one turn. Returns whether it actually went out (see sendSessiond). */
  cosTurn(prompt: string, clientRef?: string): boolean {
    return this._sendCos({ type: 'cos-turn', prompt, client_ref: clientRef ?? '' });
  }

  /**
   * Answer an approval_request.
   *
   * `approved` is always written, never omitted: a denial is `false`, and the
   * server treats a missing field as a denial precisely because guessing wrong
   * here runs the command the user just refused.
   */
  cosApproval(requestId: string, approved: boolean, reason = ''): void {
    this._sendCos({ type: 'cos-approval', request_id: requestId, approved, reason });
  }

  /** Ask the sidecar to abandon a turn. It ends when its terminal event lands. */
  cosCancel(turnId: string): void {
    this._sendCos({ type: 'cos-cancel', turn_id: turnId });
  }

  /**
   * Prune the shared transcript. `olderThanDays` of 0 means EVERYTHING.
   *
   * Returns whether the request actually went out, so a caller waiting on a
   * confirm dialog can resolve it rather than spin: the server answers with
   * cos-clear-result and then a fresh cos-history, but neither arrives if the
   * socket was down when this was called.
   */
  cosClear(olderThanDays: number): boolean {
    return this._sendCos({ type: 'cos-clear', older_than_days: olderThanDays });
  }

  /** Request the list of workspaces. */
  listWorkspaces(): void {
    this.sendSessiond({ type: SessiondType.ListWorkspaces });
  }

  /**
   * Create a new workspace; name and clientRef are each included only when
   * truthy. Returns whether the request actually went out; see sendSessiond.
   *
   * clientRef is what makes the reply attributable: the relay echoes it on
   * workspace-created, so a caller holding state for its own request can tell
   * that reply from one caused by another tab or another surface in this one.
   *
   * host names which machine to create it on, as a HostRef.ID ("ssh:boxb").
   * It travels as the HOST SELECTOR — a namespaced id with an empty local part
   * ("ssh:boxb/") in workspaceId — which is the one message type where that
   * form is legal, and which the relay strips before forwarding. Absent or
   * empty means the local daemon and the message on the wire is byte-identical
   * to today's: no workspaceId field at all.
   */
  createWorkspace(name?: string, clientRef?: string, host?: string): boolean {
    const msg: SessiondMessage = { type: SessiondType.CreateWorkspace };
    if (name) msg.name = name;
    if (clientRef) msg.clientRef = clientRef;
    if (host) msg.workspaceId = hostSelector(host);
    return this.sendSessiond(msg);
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

  private _scheduleReconnect(): void {
    const delay = Math.min(BACKOFF_BASE * 2 ** this._reconnectAttempts, BACKOFF_CAP);
    const jitter = Math.random() * JITTER_MAX;
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => this._open(), delay + jitter);
  }

  private _allocateCloseCid(): number {
    const start = this._nextCloseCid;
    do {
      const cid = this._nextCloseCid;
      this._nextCloseCid = cid >= MAX_CLOSE_CID ? 1 : cid + 1;
      if (!this._pendingCloseRequests.has(cid)) return cid;
    } while (this._nextCloseCid !== start);
    throw new Error('No close request correlation IDs are available.');
  }

  private _sendCloseRequest(
    target: CloseTarget,
    kind: PendingCloseRequest['kind'],
    buildMessage: (cid: number) => CloseIntentRequest | CloseConfirmRequest,
  ): Promise<CloseOutcome> {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Cannot request close while disconnected.'));
    }

    let cid: number;
    try {
      cid = this._allocateCloseCid();
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

  private _open(): void {
    const ws = new WebSocket(this._url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      this._reconnectAttempts = 0;
      // Re-assert the home view's opt-in. On a FIRST connection this is the
      // only send that ever reaches the daemon: the app subscribes before the
      // socket is open, and that frame is dropped.
      if (this._sessionStateWanted) {
        this.sendSessiond({ type: SessiondType.SessionStateSubscribe, ok: true });
      }
      // Same first-connection race as session state: the overlay may have
      // subscribed before this socket was open, and that frame was dropped.
      if (this._cosWanted) {
        this._sendCos({ type: 'cos-subscribe', on: true });
      }
      this.onReconnect?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
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
        const raw = JSON.parse(ev.data) as Record<string, unknown>;
        this._resolveCloseOutcome(raw);
        // Pass the raw message to control handlers (e.g. for detached/session-picker).
        // Non-typed envelopes (e.g. serve config) still flow through here.
        this._controlMessageCb?.(raw);
        // Flat sessiond messages carry a top-level "type" string; route them to
        // the sessiond hook. (Legacy single-key envelopes have no "type" field,
        // so the two paths never collide.)
        if (typeof raw.type === 'string') {
          // Serve-local chief-of-staff frames are answered by the server, not
          // the daemon. Routed off BEFORE onSessiondMessage so the frozen
          // wire-state store never sees a type it has no projection for.
          if (raw.type.startsWith('cos-')) {
            this.onCosFrame?.(raw);
            return;
          }
          this.onSessiondMessage?.(raw as unknown as SessiondMessage);
          // Relay-only types: dispatch as window CustomEvents so app.ts and
          // mux-dock can handle them without coupling to the socket directly.
          if (raw.type === SessiondType.LayoutCommand) {
            window.dispatchEvent(new CustomEvent('layout-command', { detail: raw }));
          } else if (raw.type === SessiondType.PaneResized) {
            this.onPaneResized?.(raw.paneId as number, raw.cols as number, raw.rows as number);
          } else if (raw.type === SessiondType.WorkspacePreview) {
            this.onWorkspacePreview?.(raw as unknown as SessiondMessage);
          } else if (raw.type === SessiondType.SessionState) {
            this.onSessionState?.(raw as unknown as SessiondMessage);
          } else if (raw.type === HOST_STATE) {
            // Relay-only, and inert for the frozen store: state.ts's
            // applySessiond already ends in `default: return`, so this frame
            // passing through onSessiondMessage above changes nothing there.
            this.onHostState?.(raw);
          }
        }
      }
    };

    ws.onclose = () => {
      // Intent does not survive the connection that carried it. Leaving the
      // last attach target set would let a reader during the reconnect window
      // believe the connection is still headed somewhere it can no longer go.
      this._lastAttachTarget = null;
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
  // wsUrl() prefixes the path with BASE_PATH, so the socket follows the app
  // when it is served under a path prefix (e.g. /t/<id>/ws) instead of always
  // dialing the origin root. At the root this is byte-identical to the old
  // `${proto}//${location.host}${path}`.
  return wsUrl(path);
}
