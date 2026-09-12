/**
 * Owner-side coordinator for the bounded app-voice operation protocol.
 *
 * This module deliberately contains no view or terminal implementation. It
 * validates the v1 WebSocket frames, keeps the owner observation monotonic,
 * and delegates only the finite, already-authorized UI actions supplied by
 * app.ts. There is no generic command, selector, path, or fallback route.
 */

import type { MuxSocket } from '../ws.js';

export const APP_VOICE_PROTOCOL_VERSION = 1;
const OPERATION_TTL_MS = 10_000;
const MAX_PENDING_OPERATIONS = 8;
const MAX_TEXT_BYTES = 131_072;
const MAX_DRAFT_INSPECT_BYTES = 8_192;
const MAX_DETAIL_CHARS = 512;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AppVoiceSurface = 'mission_control' | 'dock';
export type AppVoiceAppletId = 'dashboard' | 'files' | 'prs' | 'artifact';

export interface AppVoiceComposerTarget {
  readonly kind: 'composer';
  readonly channel_id: string;
  readonly thread_id: string;
  readonly runtime_generation: number;
  readonly draft_ref: string;
}

export interface AppVoiceThreadTurnTarget {
  readonly kind: 'thread_turn';
  readonly channel_id: string;
  readonly thread_id: string;
  readonly machine_id: string;
  readonly runtime_session_id: string;
  readonly runtime_generation: number;
  readonly runtime_incarnation: string;
  readonly draft_ref: string;
}

export type AppVoiceNavigateTarget =
  | Readonly<{ readonly kind: 'workspace'; readonly workspace_id: string }>
  | Readonly<{ readonly kind: 'thread'; readonly thread_id: string; readonly runtime_generation: number }>
  | Readonly<{ readonly kind: 'pane'; readonly workspace_id: string; readonly pane_id: number }>
  | Readonly<{ readonly kind: 'applet'; readonly applet_id: AppVoiceAppletId; readonly target?: string }>
  | Readonly<{
      readonly kind: 'detail';
      readonly thread_id: string;
      readonly runtime_generation: number;
      readonly detail_id: string;
    }>;

export type AppVoiceTarget = AppVoiceNavigateTarget | AppVoiceComposerTarget | AppVoiceThreadTurnTarget;

export interface AppVoiceObservation {
  readonly surface: AppVoiceSurface;
  readonly workspace_id: string;
  readonly pane_id: number;
  readonly applet_id: AppVoiceAppletId | '';
  readonly detail: string;
  readonly composer: Readonly<{
    readonly channel_id: string;
    readonly thread_id: string;
    readonly runtime_session_id: string;
    readonly runtime_generation: number;
    readonly runtime_incarnation: string;
    readonly draft_ref: string;
  }>;
}

export interface AppVoiceLease {
  readonly lease_epoch: number;
  readonly control_token: string;
}

export interface AppVoiceOperation {
  readonly operation_id: string;
  readonly lease_epoch: number;
  readonly expected_revision: number;
  readonly action: 'navigate' | 'composer_draft' | 'submit_thread_turn';
  readonly target: AppVoiceTarget;
  readonly text?: string;
  readonly draft_mode?: 'inspect' | 'set';
}

export interface AppVoiceOperationHandlers {
  readonly getObservation: () => AppVoiceObservation;
  readonly navigate: (
    target: AppVoiceNavigateTarget,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<{ readonly selected_target: AppVoiceNavigateTarget }>;
  readonly composerDraft: (
    target: AppVoiceComposerTarget,
    mode: 'inspect' | 'set',
    text: string | undefined,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<
    | Readonly<{ readonly target: AppVoiceComposerTarget; readonly text: string; readonly truncated: boolean }>
    | Readonly<{ readonly target: AppVoiceComposerTarget }>
  >;
  readonly submitThreadTurn: (
    target: AppVoiceThreadTurnTarget,
    text: string,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<Readonly<{ readonly thread_id: string; readonly runtime_generation: number; readonly turn_id: string }>>;
  readonly cancelSubmitConfirmation?: (operationId: string) => void;
  readonly cancelNavigation?: (operationId: string) => void;
}

export class AppVoiceOperationRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface PendingOperation {
  readonly operation: AppVoiceOperation;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly controller: AbortController;
}

type LeaseListener = (lease: AppVoiceLease | null, reason: string) => void;
type DrainListener = (leaseEpoch: number, nonce: string) => void | Promise<void>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function boundedString(value: unknown, maximum: number): string {
  return typeof value === 'string' && value.length <= maximum ? value : '';
}

function boundedText(value: unknown, minimum = 0): string | null {
  if (typeof value !== 'string') return null;
  if (new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES || value.length < minimum) return null;
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validChannel(value: unknown): string {
  const channel = boundedString(value, 128);
  if (channel === 'legacy-cos' || channel === 'none') return channel;
  return channel.startsWith('thread:') && UUID_RE.test(channel.slice('thread:'.length)) ? channel : '';
}

function parseNavigateTarget(value: unknown): AppVoiceNavigateTarget | null {
  const target = recordValue(value);
  if (!target || typeof target.kind !== 'string') return null;
  switch (target.kind) {
    case 'workspace': {
      const workspaceId = boundedString(target.workspace_id, 256);
      return exactKeys(target, ['kind', 'workspace_id']) && workspaceId
        ? Object.freeze({ kind: 'workspace', workspace_id: workspaceId })
        : null;
    }
    case 'thread': {
      const threadId = boundedString(target.thread_id, 36);
      const generation = positiveInteger(target.runtime_generation);
      return exactKeys(target, ['kind', 'thread_id', 'runtime_generation']) && UUID_RE.test(threadId) && generation
        ? Object.freeze({ kind: 'thread', thread_id: threadId, runtime_generation: generation })
        : null;
    }
    case 'pane': {
      const workspaceId = boundedString(target.workspace_id, 256);
      const paneId = positiveInteger(target.pane_id);
      return exactKeys(target, ['kind', 'workspace_id', 'pane_id']) && workspaceId && paneId
        ? Object.freeze({ kind: 'pane', workspace_id: workspaceId, pane_id: paneId })
        : null;
    }
    case 'applet': {
      const appletId = boundedString(target.applet_id, 16);
      const applet =
        appletId === 'dashboard' || appletId === 'files' || appletId === 'prs' || appletId === 'artifact'
          ? appletId
          : null;
      // Applet-internal target strings include paths and applet-owned state.
      // There is no app-wide authoritative inventory for them, so app voice
      // may select only one of the finite registered applet roots.
      if (!applet || !exactKeys(target, ['kind', 'applet_id'])) {
        return null;
      }
      return Object.freeze({ kind: 'applet' as const, applet_id: applet });
    }
    case 'detail': {
      const threadId = boundedString(target.thread_id, 36);
      const generation = positiveInteger(target.runtime_generation);
      const detailId = boundedString(target.detail_id, MAX_DETAIL_CHARS);
      return (
        exactKeys(target, ['kind', 'thread_id', 'runtime_generation', 'detail_id']) &&
        UUID_RE.test(threadId) &&
        generation &&
        detailId === threadId
      )
        ? Object.freeze({
            kind: 'detail',
            thread_id: threadId,
            runtime_generation: generation,
            detail_id: detailId,
          })
        : null;
    }
    default:
      return null;
  }
}

function parseComposerTarget(value: unknown): AppVoiceComposerTarget | null {
  const target = recordValue(value);
  if (!target || !exactKeys(target, ['kind', 'channel_id', 'thread_id', 'runtime_generation', 'draft_ref'])) {
    return null;
  }
  const channel = validChannel(target.channel_id);
  const threadId = boundedString(target.thread_id, 36);
  const generation =
    typeof target.runtime_generation === 'number' && Number.isSafeInteger(target.runtime_generation)
      ? target.runtime_generation
      : -1;
  const draftRef = boundedString(target.draft_ref, 36);
  if (
    target.kind !== 'composer' ||
    !channel ||
    generation < 0 ||
    (threadId !== '' && !UUID_RE.test(threadId)) ||
    (draftRef !== '' && !UUID_RE.test(draftRef))
  ) {
    return null;
  }
  return Object.freeze({
    kind: 'composer',
    channel_id: channel,
    thread_id: threadId,
    runtime_generation: generation,
    draft_ref: draftRef,
  });
}

function parseThreadTurnTarget(value: unknown): AppVoiceThreadTurnTarget | null {
  const target = recordValue(value);
  if (
    !target ||
    !exactKeys(target, [
      'kind',
      'channel_id',
      'thread_id',
      'machine_id',
      'runtime_session_id',
      'runtime_generation',
      'runtime_incarnation',
      'draft_ref',
    ])
  ) {
    return null;
  }
  const channel = validChannel(target.channel_id);
  const threadId = boundedString(target.thread_id, 36);
  const machineId = boundedString(target.machine_id, 36);
  const sessionId = boundedString(target.runtime_session_id, 36);
  const generation = positiveInteger(target.runtime_generation);
  const incarnation = boundedString(target.runtime_incarnation, 36);
  const draftRef = boundedString(target.draft_ref, 36);
  if (
    target.kind !== 'thread_turn' ||
    !channel ||
    channel !== `thread:${threadId}` ||
    !UUID_RE.test(threadId) ||
    !UUID_RE.test(machineId) ||
    !UUID_RE.test(sessionId) ||
    !generation ||
    !UUID_RE.test(incarnation) ||
    !UUID_RE.test(draftRef)
  ) {
    return null;
  }
  return Object.freeze({
    kind: 'thread_turn',
    channel_id: channel,
    thread_id: threadId,
    machine_id: machineId,
    runtime_session_id: sessionId,
    runtime_generation: generation,
    runtime_incarnation: incarnation,
    draft_ref: draftRef,
  });
}

function parseOperation(value: unknown): AppVoiceOperation | null {
  const raw = recordValue(value);
  if (!raw || raw.type !== 'app-voice-operation' || raw.protocol_version !== APP_VOICE_PROTOCOL_VERSION) {
    return null;
  }
  // The current server serializer emits its optional string fields with empty
  // values. Normalize only those documented absent values before applying the
  // strict per-action frame shape; arbitrary extra fields still refuse.
  const frame = { ...raw };
  if (frame.text === '') delete frame.text;
  if (frame.draft_mode === '') delete frame.draft_mode;
  const operationId = boundedString(frame.operation_id, 36);
  const leaseEpoch = positiveInteger(frame.lease_epoch);
  const expectedRevision = positiveInteger(frame.expected_revision);
  const action = frame.action;
  if (!UUID_RE.test(operationId) || !leaseEpoch || !expectedRevision) return null;

  if (action === 'navigate') {
    if (!exactKeys(frame, ['type', 'protocol_version', 'operation_id', 'lease_epoch', 'expected_revision', 'action', 'target'])) {
      return null;
    }
    const target = parseNavigateTarget(frame.target);
    return target
      ? Object.freeze({
          operation_id: operationId,
          lease_epoch: leaseEpoch,
          expected_revision: expectedRevision,
          action,
          target,
        })
      : null;
  }

  if (action === 'composer_draft') {
    const mode = frame.draft_mode;
    const target = parseComposerTarget(frame.target);
    if (!target || (mode !== 'inspect' && mode !== 'set')) return null;
    if (mode === 'inspect') {
      if (
        !exactKeys(frame, [
          'type',
          'protocol_version',
          'operation_id',
          'lease_epoch',
          'expected_revision',
          'action',
          'target',
          'draft_mode',
        ])
      ) {
        return null;
      }
      return Object.freeze({
        operation_id: operationId,
        lease_epoch: leaseEpoch,
        expected_revision: expectedRevision,
        action,
        target,
        draft_mode: mode,
      });
    }
    const text = boundedText(frame.text);
    if (
      text === null ||
      !exactKeys(frame, [
        'type',
        'protocol_version',
        'operation_id',
        'lease_epoch',
        'expected_revision',
        'action',
        'target',
        'draft_mode',
        'text',
      ])
    ) {
      return null;
    }
    return Object.freeze({
      operation_id: operationId,
      lease_epoch: leaseEpoch,
      expected_revision: expectedRevision,
      action,
      target,
      draft_mode: mode,
      text,
    });
  }

  if (action === 'submit_thread_turn') {
    const target = parseThreadTurnTarget(frame.target);
    const text = boundedText(frame.text, 1);
    if (
      !target ||
      text === null ||
      !exactKeys(frame, [
        'type',
        'protocol_version',
        'operation_id',
        'lease_epoch',
        'expected_revision',
        'action',
        'target',
        'text',
      ])
    ) {
      return null;
    }
    return Object.freeze({
      operation_id: operationId,
      lease_epoch: leaseEpoch,
      expected_revision: expectedRevision,
      action,
      target,
      text,
    });
  }
  return null;
}

function sameNavigateTarget(left: AppVoiceNavigateTarget, right: AppVoiceNavigateTarget): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'workspace':
      return right.kind === 'workspace' && left.workspace_id === right.workspace_id;
    case 'thread':
      return (
        right.kind === 'thread' &&
        left.thread_id === right.thread_id &&
        left.runtime_generation === right.runtime_generation
      );
    case 'pane':
      return right.kind === 'pane' && left.workspace_id === right.workspace_id && left.pane_id === right.pane_id;
    case 'applet':
      return right.kind === 'applet' && left.applet_id === right.applet_id && left.target === right.target;
    case 'detail':
      return (
        right.kind === 'detail' &&
        left.thread_id === right.thread_id &&
        left.runtime_generation === right.runtime_generation &&
        left.detail_id === right.detail_id
      );
  }
}

class AppVoiceOperations {
  private _socket: MuxSocket | null = null;
  private _unsubSocket: (() => void) | null = null;
  private _handlers: AppVoiceOperationHandlers | null = null;
  private _lease: AppVoiceLease | null = null;
  private _claim:
    | {
        readonly takeover: boolean;
        cancelled: boolean;
        readonly resolve: (lease: AppVoiceLease) => void;
        readonly reject: (error: Error) => void;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private _releasingEpoch = 0;
  private _releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private _revision = 0;
  private _observation: AppVoiceObservation | null = null;
  private _pending = new Map<string, PendingOperation>();
  private _leaseListeners = new Set<LeaseListener>();
  private _drainListeners = new Set<DrainListener>();

  attach(socket: MuxSocket, handlers: AppVoiceOperationHandlers): void {
    if (this._socket === socket && this._handlers === handlers) return;
    this.detach('owner_disconnected');
    this._socket = socket;
    this._handlers = handlers;
    this._unsubSocket = socket.onAppVoiceFrame((frame) => this._handleFrame(frame));
  }

  detach(reason = 'owner_disconnected'): void {
    this._unsubSocket?.();
    this._unsubSocket = null;
    this._socket = null;
    this._handlers = null;
    this._rejectClaim(new AppVoiceOperationRefusal('owner_disconnected', 'The app voice owner connection was lost.'));
    this._finishAll('focus_changed', 'The app voice operation was cancelled because the view changed.');
    this._clearLease(reason);
    this._revision = 0;
  }

  async claim(takeover = false): Promise<AppVoiceLease> {
    if (this._releasingEpoch !== 0) {
      throw new AppVoiceOperationRefusal('release_pending', 'The previous app voice session is still releasing.');
    }
    if (this._lease) return this._lease;
    if (this._claim) {
      if (this._claim.cancelled) {
        throw new AppVoiceOperationRefusal('claim_cancelled', 'The app voice claim was cancelled.');
      }
      if (this._claim.takeover === takeover) {
        return new Promise<AppVoiceLease>((resolve, reject) => {
          const current = this._claim;
          if (!current) {
            reject(new AppVoiceOperationRefusal('claim_cancelled', 'The app voice claim was cancelled.'));
            return;
          }
          const previousResolve = current.resolve;
          const previousReject = current.reject;
          (this._claim as {
            resolve: (lease: AppVoiceLease) => void;
            reject: (error: Error) => void;
          }).resolve = (lease) => {
            previousResolve(lease);
            resolve(lease);
          };
          (this._claim as { reject: (error: Error) => void }).reject = (error) => {
            previousReject(error);
            reject(error);
          };
        });
      }
      throw new AppVoiceOperationRefusal('claim_pending', 'Another app voice claim is already pending.');
    }
    if (!this._socket?.connected) {
      throw new AppVoiceOperationRefusal('owner_disconnected', 'App voice is unavailable while this browser reconnects.');
    }
    return new Promise<AppVoiceLease>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._rejectClaim(new AppVoiceOperationRefusal('claim_timeout', 'The app voice lease was not confirmed.'));
      }, OPERATION_TTL_MS);
      this._claim = { takeover, cancelled: false, resolve, reject, timer };
      if (
        !this._socket?.appVoice({
          type: 'app-voice-claim',
          protocol_version: APP_VOICE_PROTOCOL_VERSION,
          takeover,
        })
      ) {
        this._rejectClaim(new AppVoiceOperationRefusal('owner_disconnected', 'The app voice claim could not be sent.'));
      }
    });
  }

  /** A user-originated view action fences every outstanding provider request before it applies. */
  userNavigation(): void {
    this._finishAll('focus_changed', 'The requested voice action no longer matches the current view.');
  }

  /**
   * Publish bounded active UI identity. Before a lease exists it is cached only;
   * the first owner observation starts at revision one after a successful claim.
   */
  observe(observation: AppVoiceObservation, force = false): number {
    const normalized = normalizeObservation(observation);
    if (!normalized) return this._revision;
    const changed = !sameObservation(this._observation, normalized);
    this._observation = normalized;
    if (!this._lease || (!changed && !force)) return this._revision;
    this._revision++;
    this._socket?.appVoice({
      type: 'app-voice-observation',
      protocol_version: APP_VOICE_PROTOCOL_VERSION,
      lease_epoch: this._lease.lease_epoch,
      revision: this._revision,
      active: normalized,
    });
    return this._revision;
  }

  get revision(): number {
    return this._revision;
  }

  get lease(): AppVoiceLease | null {
    return this._lease;
  }

  isOperationActive(operationId: string): boolean {
    return this._pending.has(operationId);
  }

  endLease(leaseEpoch: number, reason = 'explicit_end'): void {
    if (!this._lease || this._lease.lease_epoch !== leaseEpoch) return;
    this._finishAll('owner_disconnected', 'The app voice lease ended before this operation completed.');
    this._clearLease(reason);
  }

  /**
   * Hold a pending claim's intent until its result arrives. The result path
   * then releases the exact returned epoch rather than allowing a stopped
   * start to leave an unbound owner lease behind.
   */
  cancelClaim(): void {
    if (this._claim) this._claim.cancelled = true;
  }

  /**
   * Release only the exact current owner epoch over the owner-bound socket.
   * This deliberately works before a provider session is minted, where the
   * HTTP end endpoint has no session identifier to authorize.
   */
  releaseLease(lease: AppVoiceLease): boolean {
    if (!this._lease || this._lease.lease_epoch !== lease.lease_epoch) {
      return this._releasingEpoch === lease.lease_epoch;
    }
    if (this._releasingEpoch === lease.lease_epoch) return true;

    // Releasing is an explicit local authority boundary. Do not wait for a
    // best-effort WebSocket notice before cancelling provider-originated work:
    // socket loss can lose that notice, but it cannot retain browser authority.
    this._finishAll('owner_disconnected', 'The app voice lease was explicitly released.');
    this._lease = null;
    for (const listener of this._leaseListeners) listener(null, 'explicit_end');
    this._rememberReleasingEpoch(lease.lease_epoch);
    this._socket?.appVoice({
      type: 'app-voice-release',
      protocol_version: APP_VOICE_PROTOCOL_VERSION,
      lease_epoch: lease.lease_epoch,
    });
    return true;
  }

  acknowledgeDrain(leaseEpoch: number, drainNonce: string): boolean {
    if (!this._lease || this._lease.lease_epoch !== leaseEpoch || !drainNonce) return false;
    return (
      this._socket?.appVoice({
        type: 'app-voice-drain-ack',
        protocol_version: APP_VOICE_PROTOCOL_VERSION,
        lease_epoch: leaseEpoch,
        drain_nonce: drainNonce,
      }) === true
    );
  }

  onLeaseChange(listener: LeaseListener): () => void {
    this._leaseListeners.add(listener);
    return () => this._leaseListeners.delete(listener);
  }

  onDrainRequest(listener: DrainListener): () => void {
    this._drainListeners.add(listener);
    return () => this._drainListeners.delete(listener);
  }

  private _handleFrame(frame: Record<string, unknown>): void {
    const type = frame.type;
    if (type === 'app-voice-claim-result') {
      this._handleClaimResult(frame);
      return;
    }
    if (type === 'app-voice-operation') {
      const operation = parseOperation(frame);
      if (operation) this._acceptOperation(operation);
      return;
    }
    if (type === 'app-voice-drain-request') {
      this._handleDrainRequest(frame);
      return;
    }
    if (type === 'app-voice-lease-ended') this._handleLeaseEnded(frame);
  }

  private _handleClaimResult(frame: Record<string, unknown>): void {
    const claim = this._claim;
    if (!claim || frame.protocol_version !== APP_VOICE_PROTOCOL_VERSION || typeof frame.ok !== 'boolean') return;
    if (frame.ok !== true) {
      this._rejectClaim(
        new AppVoiceOperationRefusal(
          boundedString(frame.code, 96) || 'claim_refused',
          boundedString(frame.error, 360) || 'The app voice lease was refused.',
        ),
      );
      return;
    }
    const epoch = positiveInteger(frame.lease_epoch);
    const controlToken = boundedString(frame.control_token, 512);
    if (epoch === 0 || controlToken === '' || frame.state !== 'claimed') {
      this._rejectClaim(
        new AppVoiceOperationRefusal('invalid_claim', 'The app voice server returned an invalid lease claim.'),
      );
      return;
    }
    const lease = Object.freeze({ lease_epoch: epoch, control_token: controlToken });
    clearTimeout(claim.timer);
    this._claim = null;
    this._lease = lease;
    this._revision = 0;
    this.observe(this._handlers?.getObservation() ?? this._observation ?? emptyObservation(), true);
    for (const listener of this._leaseListeners) listener(lease, 'claimed');
    claim.resolve(lease);
    if (claim.cancelled) this.releaseLease(lease);
  }

  private _handleDrainRequest(frame: Record<string, unknown>): void {
    const epoch = positiveInteger(frame.lease_epoch);
    const nonce = boundedString(frame.drain_nonce, 512);
    if (
      !this._lease ||
      frame.protocol_version !== APP_VOICE_PROTOCOL_VERSION ||
      frame.reason !== 'explicit_takeover' ||
      epoch !== this._lease.lease_epoch ||
      nonce === ''
    ) {
      return;
    }
    for (const listener of this._drainListeners) void listener(epoch, nonce);
  }

  private _handleLeaseEnded(frame: Record<string, unknown>): void {
    const epoch = positiveInteger(frame.lease_epoch);
    const reason = boundedString(frame.reason, 64);
    if (
      frame.protocol_version !== APP_VOICE_PROTOCOL_VERSION ||
      !['explicit_end', 'logout', 'revoked', 'owner_disconnected', 'takeover', 'provider_ended'].includes(reason)
    ) {
      return;
    }
    // A release has already revoked local authority. Its terminal receipt only
    // clears release correlation; an old receipt must never tear down a newer
    // owner epoch that the server subsequently granted on this same socket.
    if (!this._lease) {
      if (epoch === this._releasingEpoch) this._clearReleasingEpoch(epoch);
      return;
    }
    if (epoch !== this._lease.lease_epoch) return;
    this._finishAll('owner_disconnected', 'The app voice lease ended before this operation completed.');
    this._clearLease(reason);
  }

  private _acceptOperation(operation: AppVoiceOperation): void {
    if (operation.lease_epoch === this._releasingEpoch) {
      // This can arrive after local Stop when the release notice or its
      // terminal receipt was lost. Local authority is already gone.
      return;
    }
    if (!this._lease || operation.lease_epoch !== this._lease.lease_epoch) return;
    if (this._pending.has(operation.operation_id)) return;
    if (operation.expected_revision !== this._revision) {
      this._sendRefusal(
        operation,
        'stale_observation',
        'The requested voice action no longer matches the current view.',
      );
      return;
    }
    if (this._pending.size >= MAX_PENDING_OPERATIONS) {
      this._sendRefusal(operation, 'operation_capacity', 'Too many app voice actions are already pending.');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      this._finishRefusal(
        operation.operation_id,
        'confirmation_timeout',
        'The requested voice action was not completed before its confirmation window expired.',
      );
    }, OPERATION_TTL_MS);
    this._pending.set(operation.operation_id, { operation, timer, controller });
    void this._runOperation(operation);
  }

  private async _runOperation(operation: AppVoiceOperation): Promise<void> {
    const handlers = this._handlers;
    const signal = this._pending.get(operation.operation_id)?.controller.signal;
    if (!handlers || !signal || signal.aborted) {
      this._finishRefusal(operation.operation_id, 'app_unavailable', 'The owning app view is not available.');
      return;
    }
    try {
      if (operation.action === 'navigate') {
        const selected = await handlers.navigate(operation.target as AppVoiceNavigateTarget, operation.operation_id, signal);
        if (signal.aborted || !this._pending.has(operation.operation_id)) return;
        if (!sameNavigateTarget(operation.target as AppVoiceNavigateTarget, selected.selected_target)) {
          throw new AppVoiceOperationRefusal('target_mismatch', 'The app selected a different target.');
        }
        const active = this._acknowledgeNavigationObservation(handlers.getObservation());
        this._finishOk(operation.operation_id, {
          selected_target: selected.selected_target,
          active: active.observation,
          observation_revision: active.revision,
        });
        return;
      }

      if (operation.action === 'composer_draft') {
        const mode = operation.draft_mode;
        if (!mode) throw new AppVoiceOperationRefusal('invalid_operation', 'The draft operation did not name a mode.');
        const result = await handlers.composerDraft(
          operation.target as AppVoiceComposerTarget,
          mode,
          operation.text,
          operation.operation_id,
          signal,
        );
        if (signal.aborted || !this._pending.has(operation.operation_id)) return;
        const inspected = 'text' in result;
        const text = inspected ? clipUtf8(result.text, MAX_DRAFT_INSPECT_BYTES) : undefined;
        const payload =
          text === undefined
            ? {
                target: result.target,
                channel_id: result.target.channel_id,
                observation_revision: this._revision,
              }
            : {
                target: result.target,
                channel_id: result.target.channel_id,
                text: text.text,
                truncated: (inspected ? result.truncated : false) || text.truncated,
                observation_revision: this._revision,
              };
        this._finishOk(operation.operation_id, payload);
        return;
      }

      const result = await handlers.submitThreadTurn(
        operation.target as AppVoiceThreadTurnTarget,
        operation.text ?? '',
        operation.operation_id,
        signal,
      );
      if (signal.aborted || !this._pending.has(operation.operation_id)) return;
      this._finishOk(operation.operation_id, {
        ...result,
        observation_revision: this._revision,
      });
    } catch (error) {
      const refusal =
        error instanceof AppVoiceOperationRefusal
          ? error
          : new AppVoiceOperationRefusal(
              'operation_refused',
              error instanceof Error ? error.message : 'The requested app voice action could not be completed.',
            );
      this._finishRefusal(operation.operation_id, refusal.code, refusal.message);
    }
  }

  private _finishAll(code: string, error: string): void {
    const ids = Array.from(this._pending.keys());
    for (const id of ids) this._finishRefusal(id, code, error);
  }

  private _finishOk(operationId: string, result: Record<string, unknown>): void {
    const pending = this._takePending(operationId);
    if (!pending || !this._lease || pending.operation.lease_epoch !== this._lease.lease_epoch) return;
    this._socket?.appVoice({
      type: 'app-voice-operation-ack',
      protocol_version: APP_VOICE_PROTOCOL_VERSION,
      operation_id: pending.operation.operation_id,
      lease_epoch: pending.operation.lease_epoch,
      expected_revision: pending.operation.expected_revision,
      status: 'ok',
      observation_revision: this._revision,
      result,
    });
  }

  private _finishRefusal(operationId: string, code: string, error: string): void {
    const pending = this._takePending(operationId, true);
    if (!pending) return;
    this._handlers?.cancelSubmitConfirmation?.(operationId);
    this._handlers?.cancelNavigation?.(operationId);
    this._sendRefusal(pending.operation, code, error);
  }

  private _sendRefusal(operation: AppVoiceOperation, code: string, error: string): void {
    if (!this._lease || this._lease.lease_epoch !== operation.lease_epoch) return;
    this._socket?.appVoice({
      type: 'app-voice-operation-ack',
      protocol_version: APP_VOICE_PROTOCOL_VERSION,
      operation_id: operation.operation_id,
      lease_epoch: operation.lease_epoch,
      expected_revision: operation.expected_revision,
      status: 'refused',
      observation_revision: this._revision,
      code,
      error: error.slice(0, 360),
    });
  }

  private _takePending(operationId: string, abort = false): PendingOperation | null {
    const pending = this._pending.get(operationId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this._pending.delete(operationId);
    if (abort) pending.controller.abort();
    return pending;
  }

  /**
   * A successful provider-originated navigation is committed by its ACK, not
   * by a competing generic observation frame. The server atomically adopts
   * this exact active record with the returned revision.
   */
  private _acknowledgeNavigationObservation(
    observation: AppVoiceObservation,
  ): Readonly<{ readonly observation: AppVoiceObservation; readonly revision: number }> {
    const normalized = normalizeObservation(observation);
    if (!normalized || !this._lease) {
      throw new AppVoiceOperationRefusal('invalid_observation', 'The app did not confirm a valid active view.');
    }
    this._observation = normalized;
    this._revision++;
    return Object.freeze({ observation: normalized, revision: this._revision });
  }

  private _rejectClaim(error: Error): void {
    const claim = this._claim;
    if (!claim) return;
    clearTimeout(claim.timer);
    this._claim = null;
    claim.reject(error);
  }

  private _clearLease(reason: string): void {
    if (!this._lease) return;
    this._clearReleasingEpoch(this._lease.lease_epoch);
    this._lease = null;
    for (const listener of this._leaseListeners) listener(null, reason);
  }

  /**
   * Keep only the released epoch long enough to correlate its terminal notice.
   * The deadline is intentionally not permission to reuse the epoch: a later
   * claim is still ordered through server authority on this owner socket.
   */
  private _rememberReleasingEpoch(epoch: number): void {
    this._clearReleasingEpoch();
    this._releasingEpoch = epoch;
    this._releaseTimer = setTimeout(() => {
      if (this._releasingEpoch === epoch) this._clearReleasingEpoch(epoch);
    }, OPERATION_TTL_MS);
  }

  private _clearReleasingEpoch(expectedEpoch = 0): void {
    if (expectedEpoch !== 0 && this._releasingEpoch !== expectedEpoch) return;
    if (this._releaseTimer !== null) clearTimeout(this._releaseTimer);
    this._releaseTimer = null;
    this._releasingEpoch = 0;
  }
}

function emptyObservation(): AppVoiceObservation {
  return {
    surface: 'dock',
    workspace_id: '',
    pane_id: 0,
    applet_id: '',
    detail: '',
    composer: {
      channel_id: 'none',
      thread_id: '',
      runtime_session_id: '',
      runtime_generation: 0,
      runtime_incarnation: '',
      draft_ref: '',
    },
  };
}

function normalizeObservation(value: AppVoiceObservation): AppVoiceObservation | null {
  const composer = value.composer;
  if (
    (value.surface !== 'mission_control' && value.surface !== 'dock') ||
    typeof value.workspace_id !== 'string' ||
    value.workspace_id.length > 256 ||
    !Number.isSafeInteger(value.pane_id) ||
    value.pane_id < 0 ||
    !['', 'dashboard', 'files', 'prs', 'artifact'].includes(value.applet_id) ||
    typeof value.detail !== 'string' ||
    value.detail.length > MAX_DETAIL_CHARS ||
    !composer ||
    !validChannel(composer.channel_id) ||
    typeof composer.thread_id !== 'string' ||
    (composer.thread_id !== '' && !UUID_RE.test(composer.thread_id)) ||
    !Number.isSafeInteger(composer.runtime_generation) ||
    composer.runtime_generation < 0 ||
    typeof composer.runtime_session_id !== 'string' ||
    (composer.runtime_session_id !== '' && !UUID_RE.test(composer.runtime_session_id)) ||
    typeof composer.runtime_incarnation !== 'string' ||
    (composer.runtime_incarnation !== '' && !UUID_RE.test(composer.runtime_incarnation)) ||
    typeof composer.draft_ref !== 'string' ||
    (composer.draft_ref !== '' && !UUID_RE.test(composer.draft_ref)) ||
    (composer.channel_id.startsWith('thread:') && composer.channel_id !== `thread:${composer.thread_id}`) ||
    (value.detail !== '' && (!UUID_RE.test(value.detail) || value.detail !== composer.thread_id))
  ) {
    return null;
  }
  return Object.freeze({
    surface: value.surface,
    workspace_id: value.workspace_id,
    pane_id: value.pane_id,
    applet_id: value.applet_id,
    detail: value.detail,
    composer: Object.freeze({
      channel_id: composer.channel_id,
      thread_id: composer.thread_id,
      runtime_session_id: composer.runtime_session_id,
      runtime_generation: composer.runtime_generation,
      runtime_incarnation: composer.runtime_incarnation,
      draft_ref: composer.draft_ref,
    }),
  });
}

function sameObservation(left: AppVoiceObservation | null, right: AppVoiceObservation): boolean {
  if (!left) return false;
  return (
    left.surface === right.surface &&
    left.workspace_id === right.workspace_id &&
    left.pane_id === right.pane_id &&
    left.applet_id === right.applet_id &&
    left.detail === right.detail &&
    left.composer.channel_id === right.composer.channel_id &&
    left.composer.thread_id === right.composer.thread_id &&
    left.composer.runtime_session_id === right.composer.runtime_session_id &&
    left.composer.runtime_generation === right.composer.runtime_generation &&
    left.composer.runtime_incarnation === right.composer.runtime_incarnation &&
    left.composer.draft_ref === right.composer.draft_ref
  );
}

function clipUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= limit) return { text, truncated: false };
  const decoder = new TextDecoder();
  return { text: decoder.decode(bytes.slice(0, limit)), truncated: true };
}

export const appVoiceOperations = new AppVoiceOperations();