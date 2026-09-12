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
export type AppVoiceFrameCallback = (frame: Record<string, unknown>) => void;

/**
 * What the connection is actually doing right now, for a UI that has to tell
 * the truth about it.
 *
 * The distinction that matters is `retrying` versus `waiting`: an overlay that
 * says "reconnecting" while the client is asleep in a timer is lying, and it
 * is the lie that made a returning user stare at a spinner for fifteen
 * seconds. `waiting` carries the instant the next attempt is actually due, so
 * the UI can show a countdown it can keep.
 */
export type ReconnectState =
  | { phase: 'connected' }
  /** A WebSocket handshake is in flight this instant. */
  | { phase: 'retrying' }
  /** Asleep in the backoff timer. `nextAttemptAt` is epoch-ms. */
  | { phase: 'waiting'; nextAttemptAt: number; attempts: number }
  /** The browser itself says there is no network. */
  | { phase: 'offline' };

// --- the reconnect ladder ---------------------------------------------------
//
// The common failure is a SERVICE RESTART that returns in a few seconds, not a
// network outage lasting minutes, and the old ladder (1, 2, 4, 8, 16, 30, 30s)
// was tuned for the wrong one: a restart burned four rungs while the server was
// down and then parked the client in a 16- or 30-second sleep that nothing woke.
// Measured on this branch: a 16s outage cost 15.7s of *extra* waiting after the
// server was already answering, because the fourth attempt missed the server
// coming up by 325ms.
//
// The shape, on continuous failure:
//
//   attempt      1     2     3     4     5     6     7     8     9    10 ...
//   delay (s)  0.3   0.3   0.3   0.5   1.0   2.0   4.0   5.0   5.0   5.0
//   elapsed(s) 0.3   0.6   0.9   1.4   2.4   4.4   8.4  13.4  18.4  23.4
//
//   ...and after 60s of unbroken failure the cap rises from 5s to 30s.
//
// Each end protects against something different:
//
//   The fast burst (3 x 300ms) is for the restart. A refused TCP connect to an
//   origin with nothing listening is close to free -- there is no server there
//   to load -- so the only cost of trying early and often is a few syscalls,
//   and the payoff is that a plain `systemctl restart` is picked up before the
//   user finishes noticing.
//
//   The 5s cap covers the slow restart: a rebuild, a container start, a proxy
//   still 502ing while the origin comes up. Worst-case lag inside the first
//   minute is now one cap plus jitter (~5.2s) instead of 30s.
//
//   The 30s tail is for the outage that is not ending: a closed lid, a dead
//   VPN, a server that crashed and stayed down. Hammering there buys nothing
//   and costs battery, and if the origin IS reachable but struggling it is the
//   thundering herd the backoff exists to prevent. Being slow in the tail is
//   safe precisely because of the wake signals below -- the moment a human
//   looks at the tab, the ladder is forfeit and an attempt fires immediately.
//   A long cap only ever delays someone who is not watching.
//
// Net cost of the new shape over a one-hour outage: about a dozen extra connect
// attempts, all inside the first 60 seconds, in exchange for a 6x cut in
// worst-case reconnect lag.
const FAST_ATTEMPTS = 3;
const FAST_DELAY_MS = 300;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;
const LONG_OUTAGE_AFTER_MS = 60_000;
const LONG_OUTAGE_CAP_MS = 30_000;
const JITTER_MAX_MS = 250;

/**
 * Floor on the gap between two attempt STARTS.
 *
 * Storm guard. A single real tab switch delivers visibilitychange and focus
 * back to back, a waking laptop can add online on top, and the user may hit
 * "Retry now" in the middle of all three. Without a floor those collapse into
 * a burst of simultaneous handshakes -- which is its own bug, and against a
 * server that is only half up it is the worst possible moment to send one.
 */
const WAKE_MIN_INTERVAL_MS = 250;

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
  /** Owner-only app-voice frames stay off the generic control/sessiond paths. */
  private _appVoiceFrameListeners = new Set<AppVoiceFrameCallback>();
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _reconnectAttempts = 0;
  private _intentionalClose = false;
  private _nextCloseCid = 1;
  private _pendingCloseRequests = new Map<number, PendingCloseRequest>();
  /** Epoch-ms an attempt was last STARTED. Feeds the WAKE_MIN_INTERVAL floor. */
  private _lastAttemptAt = 0;
  /** Epoch-ms the pending timer is due to fire, or 0 when none is armed. */
  private _nextAttemptAt = 0;
  /**
   * Epoch-ms the current outage began, or 0 when connected.
   *
   * Deliberately NOT reset by a wake signal: how old an outage is, is a
   * property of the outage, not of whether anyone is looking at it. Resetting
   * it on focus would let a user idly alt-tabbing every half minute hold a
   * genuinely dead server in the aggressive 5s cap indefinitely.
   */
  private _outageStartedAt = 0;
  private _disposeWakeListeners: (() => void) | null = null;

  onDisconnect: (() => void) | null = null;
  onReconnect: (() => void) | null = null;
  /**
   * Fires whenever the connection's observable phase changes, so the overlay
   * can render what is actually happening rather than a fixed "reconnecting".
   */
  onConnectionState: ((state: ReconnectState) => void) | null = null;
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
   * Versioned Mission Control text-thread frames. These are serve-local like
   * COS frames, but deliberately have their own route so raw `cos-*` frames
   * can never be mistaken for an attributed thread event.
   */
  onMissionControlFrame?: (frame: Record<string, unknown>) => void;
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

  /**
   * Subscribe to owner-targeted app-voice frames on this existing authenticated
   * WebSocket. The transport intentionally does not create a second socket or
   * relay these capability-bearing frames through a window event.
   */
  onAppVoiceFrame(cb: AppVoiceFrameCallback): () => void {
    this._appVoiceFrameListeners.add(cb);
    return () => this._appVoiceFrameListeners.delete(cb);
  }

  connect(): void {
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._installWakeListeners();
    this._open();
  }

  disconnect(): void {
    this._intentionalClose = true;
    this._disposeWakeListeners?.();
    this._disposeWakeListeners = null;
    this._rejectPendingCloseRequests(
      new Error('The close outcome could not be confirmed because the connection closed.'),
    );
    this._clearTimer();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  // --- waking up ------------------------------------------------------------

  /**
   * Force an attempt now: the overlay's "Retry now" control.
   *
   * Goes through the same path as a wake signal, so it inherits both storm
   * guards -- a user mashing the button cannot outrun WAKE_MIN_INTERVAL_MS,
   * and pressing it while a handshake is already in flight does nothing.
   */
  retryNow(): void {
    this._wake();
  }

  /**
   * Listen for the user coming back.
   *
   * A pending backoff timer is a promise made to a user who was not there.
   * When they return -- the tab becomes visible, the window regains focus, or
   * the browser regains the network -- that promise is void: the ladder is
   * reset and an attempt fires immediately. Nobody should ever watch a
   * countdown they cannot see and did not cause.
   *
   * `offline` is listened for too, but only to repaint: it starts nothing.
   *
   * These live on the socket rather than in app.ts because the socket is what
   * owns the timer being cancelled, and because destroy()/disconnect() then
   * removes them by construction. PaneFocusCoordinator installs the same two
   * DOM listeners for an unrelated purpose (claiming PTY-sizing authority);
   * the duplication is deliberate -- fusing them would couple reconnect
   * liveness to terminal sizing.
   */
  private _installWakeListeners(): void {
    if (this._disposeWakeListeners) return;
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') this._wake();
    };
    const onFocus = (): void => this._wake();
    const onOnline = (): void => this._wake();
    const onOffline = (): void => this._emitState();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    this._disposeWakeListeners = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }

  /**
   * Cancel any pending backoff and attempt now.
   *
   * Storm prevention, in the order the guards apply:
   *
   *  1. Already OPEN -- nothing to do, and no state to disturb.
   *  2. Already CONNECTING -- an attempt IS in flight; this wake would only
   *     add a second racing handshake. _open() assigns this._ws synchronously,
   *     so every wake after the first in a burst lands here. This is the guard
   *     that actually absorbs visibilitychange + focus arriving together.
   *  3. Too soon since the last attempt STARTED -- re-arm the timer for the
   *     remainder instead of dialling, so a pathological event storm against
   *     an instantly-refusing port cannot exceed one attempt per 250ms.
   */
  private _wake(): void {
    if (this._intentionalClose) return;
    const state = this._ws?.readyState;
    if (state === WebSocket.OPEN) return;

    // The user is back. Whatever rung the ladder had climbed to is forfeit.
    this._reconnectAttempts = 0;
    if (state === WebSocket.CONNECTING) return;

    const since = Date.now() - this._lastAttemptAt;
    if (since < WAKE_MIN_INTERVAL_MS) {
      this._armTimer(WAKE_MIN_INTERVAL_MS - since);
      return;
    }
    this._open();
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
   * The thread capability handshake owns whether raw COS frames are allowed to
   * reach the legacy store. It is true by default to retain the old wire path
   * until a genuine v2 text capability says otherwise.
   */
  private _legacyCosFramesEnabled = true;

  private _sendCos(frame: Record<string, unknown>): boolean {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify(frame));
        return true;
      } catch {
        // A socket can close between readyState and send(). Callers that hold
        // a draft/receipt state need a truthful false rather than a phantom
        // transmission.
        return false;
      }
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
    this._sendCos({ type: 'cos-subscribe', on });
  }

  /**
   * Gate raw legacy COS frame dispatch without changing the socket's ordinary
   * terminal/sessiond routes. Threaded text preview uses this before it makes
   * a v2 request, so a stray legacy event cannot reach either a per-thread
   * renderer or the legacy voice bridge.
   */
  setLegacyCosFramesEnabled(enabled: boolean): void {
    this._legacyCosFramesEnabled = enabled;
  }

  /** Send one versioned Mission Control frame if the socket is open. */
  missionControl(frame: Record<string, unknown>): boolean {
    return this._sendCos(frame);
  }

  /** Send one app-voice v1 frame on the existing authenticated WebSocket. */
  appVoice(frame: Record<string, unknown>): boolean {
    return this._sendCos(frame);
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
   *
   * Returns whether it actually went out, and that return is not optional
   * housekeeping: a caller that assumes it did shows the user a confirmed
   * security decision the sidecar never received, and the sidecar then times
   * the request out to DENIED (2.4 law 3). The UI has to be able to tell those
   * two apart.
   */
  cosApproval(requestId: string, approved: boolean, reason = ''): boolean {
    return this._sendCos({ type: 'cos-approval', request_id: requestId, approved, reason });
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
    this._disposeWakeListeners?.();
    this._disposeWakeListeners = null;
    this._rejectPendingCloseRequests(
      new Error('The close outcome could not be confirmed because the connection was destroyed.'),
    );
    this._clearTimer();
    if (this._ws) {
      this._ws.close(1000);
      this._ws = null;
    }
  }

  get connected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  /** What the connection is doing right now. See ReconnectState. */
  get connectionState(): ReconnectState {
    const state = this._ws?.readyState;
    if (state === WebSocket.OPEN) return { phase: 'connected' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { phase: 'offline' };
    }
    if (state === WebSocket.CONNECTING) return { phase: 'retrying' };
    if (this._nextAttemptAt > 0) {
      return {
        phase: 'waiting',
        nextAttemptAt: this._nextAttemptAt,
        attempts: this._reconnectAttempts,
      };
    }
    return { phase: 'retrying' };
  }

  private _emitState(): void {
    this.onConnectionState?.(this.connectionState);
  }

  private _clearTimer(): void {
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    this._nextAttemptAt = 0;
  }

  /** Arm exactly one pending attempt, replacing any already armed. */
  private _armTimer(ms: number): void {
    this._clearTimer();
    this._nextAttemptAt = Date.now() + ms;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = undefined;
      this._nextAttemptAt = 0;
      this._open();
    }, ms);
    this._emitState();
  }

  /** The ladder. See the constants block at the top of this file. */
  private _nextDelayMs(): number {
    const attempts = this._reconnectAttempts;
    const outageAge = this._outageStartedAt === 0 ? 0 : Date.now() - this._outageStartedAt;
    const cap = outageAge >= LONG_OUTAGE_AFTER_MS ? LONG_OUTAGE_CAP_MS : BACKOFF_CAP_MS;
    const base =
      attempts < FAST_ATTEMPTS
        ? FAST_DELAY_MS
        : BACKOFF_BASE_MS * 2 ** (attempts - FAST_ATTEMPTS);
    return Math.min(base, cap);
  }

  private _scheduleReconnect(): void {
    const delay = this._nextDelayMs() + Math.random() * JITTER_MAX_MS;
    this._reconnectAttempts++;
    this._armTimer(delay);
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

  /**
   * Make a socket we are walking away from inert.
   *
   * This is what keeps the reconnect-time work firing exactly once. An
   * abandoned socket whose handlers still point at this instance will, when
   * the browser finally settles it, either fire onclose -- scheduling a SECOND
   * ladder that then races the first -- or, if it was mid-handshake and the
   * handshake succeeds, fire onopen. And every onopen runs the full
   * reconnect-time sequence: the subscription replays and onReconnect, whose
   * bootstrap() sends an attach. Two of those is two compositions, and the
   * second one resets the active pane out from under the user (the exact
   * duplicate-attach hazard WorkspaceController's _attachInFlight guard was
   * added for). A reconnect path that fires twice is worse than one that fires
   * slowly.
   */
  private _discard(ws: WebSocket | null): void {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }

  private _open(): void {
    // Exactly one attempt may be in flight, and exactly one timer armed. Both
    // are torn down here rather than at each call site, so no future caller of
    // _open() can reintroduce a second ladder by forgetting.
    this._clearTimer();
    this._discard(this._ws);
    this._lastAttemptAt = Date.now();

    const ws = new WebSocket(this._url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;
    this._emitState();

    ws.onopen = () => {
      // Belt and braces with _discard(): only the socket this instance is
      // currently flying may run the reconnect-time work below.
      if (this._ws !== ws) return;
      this._reconnectAttempts = 0;
      this._outageStartedAt = 0;
      this._clearTimer();
      // Re-assert the home view's opt-in. On a FIRST connection this is the
      // only send that ever reaches the daemon: the app subscribes before the
      // socket is open, and that frame is dropped.
      if (this._sessionStateWanted) {
        this.sendSessiond({ type: SessiondType.SessionStateSubscribe, ok: true });
      }
      // Chief-of-staff replay is intentionally NOT automatic here. The
      // conversation coordinator negotiates Mission Control capability first,
      // then either explicitly re-subscribes to unscoped legacy COS or keeps
      // that path gated for threaded text. Replaying `_cosWanted` before that
      // decision would leak a raw global event into a selected thread.
      this.onReconnect?.();
      this._emitState();
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
        // App voice has a separate owner-only protocol. In particular, the
        // server-issued control capability never reaches generic control hooks
        // or the frozen sessiond state projection.
        if (typeof raw.type === 'string' && raw.type.startsWith('app-voice-')) {
          for (const listener of this._appVoiceFrameListeners) listener(raw);
          return;
        }
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
          if (raw.type === 'missioncontrol-result' || raw.type === 'missioncontrol-event') {
            this.onMissionControlFrame?.(raw);
            return;
          }
          if (raw.type.startsWith('cos-')) {
            if (this._legacyCosFramesEnabled) this.onCosFrame?.(raw);
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
      // A socket this instance already walked away from. Its close is not our
      // outage and must not schedule a second ladder.
      if (this._ws !== ws) return;
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
      // First close of this outage starts its clock; later ones must not
      // restart it, or the ladder never reaches the long-outage cap.
      if (this._outageStartedAt === 0) this._outageStartedAt = Date.now();
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
