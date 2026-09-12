/**
 * thread-store.ts -- the versioned Mission Control conversation coordinator.
 *
 * The legacy COS store remains the renderer for one unscoped conversation.
 * When the server explicitly advertises text_threads v2, this coordinator
 * creates one CosStore per catalog UUID and only feeds it event envelopes that
 * have already been attributed and sequence-fenced by the v2 transport.
 */

import type { MuxSocket } from '../ws.js';
import {
  CosStore,
  cosStore,
  type CosApproval,
  type CosFault,
  type CosTurn,
  type ThreadedCosEvent,
} from './cos-store.js';

const PROTOCOL_VERSION = 2;
const CAPABILITY_TIMEOUT_MS = 2_500;
const TURN_RECEIPT_TIMEOUT_MS = 15_000;
const MAX_SEEN_EVENT_IDS = 512;
/** Bound early-event retention per authoritative (thread, generation) pair. */
const MAX_PRE_ACK_EVENTS_PER_THREAD = 128;
/** Unknown fresh bindings must not let a noisy socket allocate without bound. */
const MAX_PRE_ACK_THREAD_BUFFERS = 16;
const STORAGE_VERSION = 1;
const LEGACY_DRAFT_KEY = 'legacy';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ThreadMode = 'unknown' | 'negotiating' | 'legacy' | 'threaded';

export interface CatalogThread {
  readonly id: string;
  readonly kind: 'lobby' | 'workspace';
  readonly displayName: string;
  readonly machineId: string;
  readonly workspaceUuid: string;
  readonly runtimeSessionId: string;
  readonly runtimeGeneration: number;
}

export type ThreadContextTarget =
  | { readonly kind: 'lobby' }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'thread'; readonly threadId: string };

export interface ThreadContextOption {
  readonly key: string;
  readonly target: ThreadContextTarget;
  readonly threadId: string;
  readonly label: string;
  readonly detail: string;
  readonly unread: boolean;
  readonly refused: boolean;
}

interface WorkspaceContext {
  readonly workspaceId: string;
  readonly label: string;
  readonly machineId: string;
  readonly workspaceUuid: string;
  readonly daemonIncarnation: string;
  readonly boundThreadId: string;
  readonly code: string;
  readonly error: string;
}

interface ThreadState {
  thread: CatalogThread;
  draftRef: string;
  store: CosStore;
  lastSequence: number | null;
  seenEventIds: Map<string, true>;
  historyRequestId: string;
  runtimeStale: boolean;
  /** A snapshot repair is in flight; no new turn may enter during the cut. */
  syncing: boolean;
}

interface PendingSelection {
  readonly requestId: string;
  readonly target: ThreadContextTarget;
  readonly persistLastSelection: boolean;
  readonly restorePreviousSelection: boolean;
  /**
   * A fresh workspace selection cannot know its catalog UUID until the select
   * reply. If candidate buffering itself reaches the global bound, that reply
   * must be re-snapshotted before the composer can be admitted.
   */
  unknownBufferOverflow: boolean;
}

interface PendingTurn {
  readonly requestId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly draftRef: string;
  readonly text: string;
  phase: 'awaiting-receipt' | 'uncertain';
}

interface PendingHistory {
  readonly threadId: string;
  readonly generation: number;
}

interface BufferedThreadEvent {
  readonly envelope: ThreadedCosEvent;
}

interface PreAckBuffer {
  readonly threadId: string;
  readonly generation: number;
  events: BufferedThreadEvent[];
  overflow: boolean;
}

interface SnapshotPayload {
  readonly thread: CatalogThread;
  readonly history: readonly unknown[];
  /** Snapshot cut supplied by the server, including zero. */
  readonly watermark: number;
  /**
   * Immutable runtime turn ids already materialized in `history`. Late events
   * for these ids still consume sequence space but must not render again.
   */
  readonly coveredTurnIds: readonly string[];
}

interface PersistedState {
  readonly version: number;
  readonly drafts: Record<string, string>;
  readonly last_selection: string;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveSafeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** `thread_seq` snapshots may validly start at zero. */
function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function uuidValue(value: unknown): string {
  const candidate = stringValue(value);
  return UUID_RE.test(candidate) ? candidate : '';
}

function protocolFailure(frame: Record<string, unknown>, fallback: string): string {
  const detail = stringValue(frame.error);
  const code = stringValue(frame.code);
  if (detail) return detail;
  if (code) return code;
  return fallback;
}

function snapshotUnavailableMessage(frame: Record<string, unknown>, fallback: string): string {
  const code = stringValue(frame.code);
  if (code === 'thread_busy_snapshot') {
    return 'That context is still working, so its canonical history cannot be opened yet. The current context and drafts were kept.';
  }
  if (code === 'history_unavailable') {
    return 'That context is still working, so an authoritative history snapshot is unavailable until it finishes.';
  }
  return protocolFailure(frame, fallback);
}

function shortUuid(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function workspaceMachine(workspaceId: string): string {
  const slash = workspaceId.lastIndexOf('/');
  return slash > 0 ? workspaceId.slice(0, slash) : 'local';
}

function makeRequestId(): string | null {
  if (typeof crypto === 'undefined') return null;
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto.getRandomValues !== 'function') return null;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseCatalogThread(value: unknown): CatalogThread | null {
  const raw = recordValue(value);
  if (!raw) return null;
  const id = uuidValue(raw.id);
  const kind = stringValue(raw.kind);
  const displayName = stringValue(raw.display_name);
  if (!id || (kind !== 'lobby' && kind !== 'workspace') || !displayName) return null;
  const rawGeneration = raw.runtime_generation;
  const runtimeGeneration = rawGeneration === undefined ? 0 : positiveSafeInteger(rawGeneration);
  if (rawGeneration !== undefined && runtimeGeneration === 0) return null;
  return {
    id,
    kind,
    displayName,
    machineId: stringValue(raw.machine_id),
    workspaceUuid: stringValue(raw.workspace_uuid),
    runtimeSessionId: stringValue(raw.runtime_session_id),
    runtimeGeneration,
  };
}

function parseRuntimeThread(value: unknown): CatalogThread | null {
  const thread = parseCatalogThread(value);
  if (!thread || !uuidValue(thread.runtimeSessionId) || thread.runtimeGeneration === 0) return null;
  return thread;
}

function parseWorkspace(value: unknown): WorkspaceContext | null {
  const raw = recordValue(value);
  if (!raw) return null;
  const workspaceId = stringValue(raw.workspace_id);
  if (!workspaceId) return null;
  const boundThreadId = stringValue(raw.bound_thread_id);
  if (boundThreadId && !uuidValue(boundThreadId)) return null;
  return {
    workspaceId,
    label: stringValue(raw.label),
    machineId: stringValue(raw.machine_id),
    workspaceUuid: stringValue(raw.workspace_uuid),
    daemonIncarnation: stringValue(raw.daemon_incarnation),
    boundThreadId,
    code: stringValue(raw.code),
    error: stringValue(raw.error),
  };
}

function parseThreadedEvent(value: unknown): ThreadedCosEvent | null {
  const frame = recordValue(value);
  if (!frame || stringValue(frame.type) !== 'missioncontrol-event') return null;
  if (positiveSafeInteger(frame.protocol_version) !== PROTOCOL_VERSION) return null;
  const threadId = uuidValue(frame.thread_id);
  const runtimeGeneration = positiveSafeInteger(frame.runtime_generation);
  const eventId = uuidValue(frame.event_id);
  const threadSeq = nonNegativeSafeInteger(frame.thread_seq);
  const event = recordValue(frame.event);
  if (!threadId || runtimeGeneration === 0 || !eventId || threadSeq === null || !event) return null;
  return Object.freeze({
    thread_id: threadId,
    runtime_generation: runtimeGeneration,
    thread_seq: threadSeq,
    event_id: eventId,
    event: Object.freeze({ ...event }),
  });
}

function parseCoveredTurnIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || seen.has(entry)) return null;
    seen.add(entry);
    ids.push(entry);
  }
  return ids;
}

function parseSnapshot(frame: Record<string, unknown>): SnapshotPayload | null {
  const thread = parseRuntimeThread(frame.thread);
  const watermark = nonNegativeSafeInteger(frame.thread_seq);
  const coveredTurnIds = parseCoveredTurnIds(frame.covered_turn_ids);
  if (!thread || watermark === null || !Array.isArray(frame.history) || coveredTurnIds === null) {
    return null;
  }

  const rawReplay = frame.replay_events;
  // This preview deliberately has no proof for safely merging an active
  // snapshot tail. The server refuses active roots instead; accepting even a
  // syntactically valid tail here would recreate the ambiguous replay path.
  if (rawReplay !== undefined && (!Array.isArray(rawReplay) || rawReplay.length !== 0)) return null;
  return {
    thread,
    history: frame.history,
    watermark,
    coveredTurnIds,
  };
}

function snapshotFailureMessage(frame: Record<string, unknown>, fallback: string): string {
  if (nonNegativeSafeInteger(frame.thread_seq) === null) {
    return `The server did not provide the required numeric thread_seq watermark. ${fallback}`;
  }
  if (parseCoveredTurnIds(frame.covered_turn_ids) === null) {
    return `The server did not provide well-formed required covered_turn_ids. ${fallback}`;
  }
  const rawReplay = frame.replay_events;
  if (rawReplay !== undefined && (!Array.isArray(rawReplay) || rawReplay.length !== 0)) {
    return `This text preview does not support non-empty replay_events. ${fallback}`;
  }
  return fallback;
}

function preAckKey(threadId: string, generation: number): string {
  return `${threadId}\u0000${generation}`;
}

/**
 * Scoped sessionStorage is already per-tab/browser-session. Including the
 * origin in the key makes the server boundary explicit when a browser has more
 * than one muxterm origin open.
 */
function storageKey(): string {
  const scope = typeof location === 'undefined' ? 'unknown-origin' : location.origin;
  return `muxterm:missioncontrol:threads:v2:${scope}`;
}

class ThreadStore {
  private _socket: MuxSocket | null = null;
  private _listeners = new Set<() => void>();
  private _notifyPending = false;
  private _wanted = false;
  private _mode: ThreadMode = 'unknown';
  private _threads: CatalogThread[] = [];
  private _workspaces: WorkspaceContext[] = [];
  private _states = new Map<string, ThreadState>();
  private _emptyStore = new CosStore();
  private _selected: ThreadState | null = null;
  private _pendingSelection: PendingSelection | null = null;
  private _pendingTurn: PendingTurn | null = null;
  private _pendingHistories = new Map<string, PendingHistory>();
  /**
   * Live v2 events can arrive between subscription and the select/history
   * snapshot reply. Retain them by immutable source identity, never by visible
   * selection, until that snapshot gives us its sequence cut.
   */
  private _preAckBuffers = new Map<string, PreAckBuffer>();
  private _capabilityRequestId = '';
  private _capabilityTimer: ReturnType<typeof setTimeout> | undefined;
  private _turnReceiptTimer: ReturnType<typeof setTimeout> | undefined;
  private _listRequestId = '';
  private _connectionReady = false;
  private _problem: CosFault | null = null;
  private _drafts = new Map<string, string>();
  private _lastExplicitThreadId = '';
  private _storageLoaded = false;
  private _storageUnavailable = false;
  private _legacyUnsubscribe: (() => void) | null = null;

  get mode(): ThreadMode {
    return this._mode;
  }

  get threaded(): boolean {
    return this._mode === 'threaded';
  }

  get negotiating(): boolean {
    return this._wanted && (this._mode === 'unknown' || this._mode === 'negotiating');
  }

  get selectionPending(): boolean {
    return this._pendingSelection !== null || (this.threaded && !this._connectionReady);
  }

  get canSelect(): boolean {
    return (
      this.threaded &&
      this._socket?.connected === true &&
      this._pendingSelection === null &&
      this._pendingTurn === null
    );
  }

  get inputEnabled(): boolean {
    if (this._mode === 'legacy') return true;
    return (
      this.threaded &&
      this._connectionReady &&
      this._selected !== null &&
      !this._selected.runtimeStale &&
      !this._selected.syncing &&
      this._pendingTurn === null
    );
  }

  get draft(): string {
    return this._drafts.get(this._draftKey()) ?? '';
  }

  get turns(): readonly CosTurn[] {
    return this._activeStore().turns;
  }

  get approvals(): readonly CosApproval[] {
    return this._activeStore().approvals;
  }

  get busy(): boolean {
    return this._activeStore().busy;
  }

  get hasMessages(): boolean {
    return this._activeStore().hasMessages;
  }

  get fault(): CosFault | null {
    return this._problem ?? this._activeStore().fault;
  }

  get contextLabel(): string {
    if (!this._selected) return this.threaded ? 'selecting…' : '';
    const matching = this.contexts.find((option) => option.threadId === this._selected?.thread.id);
    if (matching) return matching.label;
    const thread = this._selected.thread;
    if (thread.kind === 'lobby') return 'Lobby';
    const suffix = shortUuid(thread.workspaceUuid || thread.id);
    return `${thread.displayName} · ${suffix}`;
  }

  get contextStatus(): string {
    if (this._mode === 'unknown' || this._mode === 'negotiating') {
      return 'Checking text-thread capability…';
    }
    if (this.threaded && this._listRequestId) return 'Loading real contexts…';
    if (this._pendingSelection && this._problem?.code === 'pre_ack_buffer_overflow') {
      return this._problem.message;
    }
    if (this._pendingSelection) return 'Switching context…';
    if (this._selected?.runtimeStale) return 'Context runtime changed; select it again.';
    if (this._selected?.syncing) {
      return this._selected.store.fault?.message ?? 'Reconciling authoritative thread history.';
    }
    if (this._problem && this.threaded) return this._problem.message;
    return '';
  }

  get composerNotice(): string {
    if (this._mode === 'unknown' || this._mode === 'negotiating') {
      return 'Checking whether text threads are available…';
    }
    if (!this.threaded) return '';
    if (this._pendingSelection || !this._connectionReady) {
      return this._problem?.message ?? 'Context switch pending. Sending is disabled.';
    }
    if (!this._selected) return 'Choose a context before sending.';
    if (this._selected.runtimeStale) {
      return 'This context runtime changed. Select Talk here again before sending.';
    }
    if (this._selected.syncing) {
      return (
        this._selected.store.fault?.message ??
        'Reconciling authoritative thread history. Sending is disabled.'
      );
    }
    if (this._pendingTurn?.phase === 'awaiting-receipt') return 'Waiting for the server receipt…';
    if (this._pendingTurn?.phase === 'uncertain') {
      return 'Delivery could not be confirmed. Your draft was kept and will not be resent automatically.';
    }
    return this._problem?.message ?? '';
  }

  get storageNotice(): string {
    return this._storageUnavailable ? 'Drafts cannot be persisted in this browser session.' : '';
  }

  get hasUncertainTurn(): boolean {
    return this._pendingTurn?.phase === 'uncertain';
  }

  get hasUnread(): boolean {
    return this._unreadThreadIds.size > 0;
  }

  get selectedThreadId(): string {
    return this._selected?.thread.id ?? '';
  }

  get contexts(): readonly ThreadContextOption[] {
    if (!this.threaded) return [];
    const options: ThreadContextOption[] = [];
    const knownWorkspaceThreads = new Set<string>();
    const lobby = this._threads.find((thread) => thread.kind === 'lobby');
    if (lobby) {
      options.push({
        key: `lobby:${lobby.id}`,
        target: { kind: 'lobby' },
        threadId: lobby.id,
        label: 'Lobby',
        detail: 'Shared fleet orientation',
        unread: this._unread(lobby.id),
        refused: false,
      });
    }
    for (const workspace of this._workspaces) {
      if (workspace.boundThreadId) knownWorkspaceThreads.add(workspace.boundThreadId);
      const workspaceName = workspace.label || workspace.workspaceId.split('/').pop() || workspace.workspaceId;
      const suffix = shortUuid(workspace.workspaceUuid || workspace.boundThreadId);
      const detail = `${workspaceMachine(workspace.workspaceId)} / ${workspaceName}${suffix ? ` · ${suffix}` : ''}`;
      options.push({
        key: `workspace:${workspace.workspaceId}`,
        target: { kind: 'workspace', workspaceId: workspace.workspaceId },
        threadId: workspace.boundThreadId,
        label: detail,
        detail: workspace.error || workspace.code,
        unread: this._unread(workspace.boundThreadId),
        refused: workspace.error !== '' || workspace.code !== '',
      });
    }
    for (const thread of this._threads) {
      if (thread.kind !== 'workspace' || knownWorkspaceThreads.has(thread.id)) continue;
      const machine = thread.machineId ? shortUuid(thread.machineId) : 'machine';
      const suffix = shortUuid(thread.workspaceUuid || thread.id);
      options.push({
        key: `thread:${thread.id}`,
        target: { kind: 'thread', threadId: thread.id },
        threadId: thread.id,
        label: `${machine} / ${thread.displayName} · ${suffix}`,
        detail: 'Reconnect to this catalog context',
        unread: this._unread(thread.id),
        refused: false,
      });
    }
    return options;
  }

  attach(socket: MuxSocket): void {
    this._socket = socket;
    this._loadPersistedState();
    cosStore.attach(socket);
    this._legacyUnsubscribe?.();
    this._legacyUnsubscribe = cosStore.subscribe(() => this._notify());
    socket.onMissionControlFrame = (frame) => this._handleFrame(frame);
    socket.setLegacyCosFramesEnabled(true);
    if (this._wanted && socket.connected) this._beginNegotiation();
  }

  open(): void {
    this._wanted = true;
    if (!this._socket?.connected) {
      this._notify();
      return;
    }
    if (this._mode === 'legacy' || (this.threaded && this._connectionReady)) return;
    this._beginNegotiation();
  }

  markDisconnected(): void {
    this._clearCapabilityTimer();
    this._capabilityRequestId = '';
    this._listRequestId = '';
    this._pendingSelection = null;
    this._pendingHistories.clear();
    if (this._mode === 'legacy') {
      cosStore.markDisconnected();
      return;
    }
    this._connectionReady = false;
    if (this._pendingTurn?.phase === 'awaiting-receipt') {
      this._pendingTurn.phase = 'uncertain';
      this._clearTurnReceiptTimer();
    }
    for (const state of this._states.values()) {
      state.historyRequestId = '';
      state.store.markDisconnected();
    }
    this._notify();
  }

  markReconnected(): void {
    if (!this._wanted) return;
    this._beginNegotiation();
  }

  setDraft(value: string): void {
    const key = this._draftKey();
    if (this._drafts.get(key) === value) return;
    if (value) this._drafts.set(key, value);
    else this._drafts.delete(key);
    this._persistState();
    this._notify();
  }

  select(target: ThreadContextTarget): boolean {
    if (!this.canSelect) return false;
    return this._requestSelection(target, true);
  }

  send(text: string): boolean {
    const prompt = text.trim();
    if (!prompt) return false;
    if (this._mode === 'legacy') {
      if (!cosStore.send(prompt)) return false;
      this.setDraft('');
      return true;
    }
    const state = this._selected;
    const socket = this._socket;
    if (!this.inputEnabled || !state || !socket) return false;
    const requestId = makeRequestId();
    if (!requestId) {
      this._setProblem('request_id_unavailable', 'A secure request ID could not be created.');
      return false;
    }
    const pending: PendingTurn = {
      requestId,
      threadId: state.thread.id,
      generation: state.thread.runtimeGeneration,
      draftRef: state.draftRef,
      text: prompt,
      phase: 'awaiting-receipt',
    };
    this._pendingTurn = pending;
    this._problem = null;
    const sent = socket.missionControl({
      type: 'missioncontrol-turn',
      protocol_version: PROTOCOL_VERSION,
      request_id: requestId,
      thread_id: pending.threadId,
      expected_runtime_generation: pending.generation,
      draft_ref: pending.draftRef,
      text: pending.text,
    });
    if (!sent) {
      pending.phase = 'uncertain';
      this._setProblem(
        'turn_transmit_unconfirmed',
        'The turn could not be transmitted. Your draft was kept and will not be sent automatically.',
      );
      return true;
    }
    this._clearTurnReceiptTimer();
    this._turnReceiptTimer = setTimeout(() => {
      this._turnReceiptTimer = undefined;
      if (this._pendingTurn !== pending || pending.phase !== 'awaiting-receipt') return;
      pending.phase = 'uncertain';
      this._setProblem(
        'turn_receipt_timeout',
        'The server did not confirm this turn. Your draft was kept and will not be resent automatically.',
      );
    }, TURN_RECEIPT_TIMEOUT_MS);
    this._notify();
    return true;
  }

  /**
   * This does not resend anything. It simply releases a retained uncertain
   * draft so a person can explicitly compose a new request after reviewing the
   * authoritative context.
   */
  releaseUncertainDraft(): void {
    if (this._pendingTurn?.phase !== 'uncertain') return;
    this._clearTurnReceiptTimer();
    this._pendingTurn = null;
    this._problem = null;
    this._notify();
  }

  clear(olderThanDays: number | 'all'): void {
    if (this._mode !== 'legacy') {
      this._refusePreviewAction('Clearing messages is unavailable in text preview.');
      return;
    }
    cosStore.clear(olderThanDays);
  }

  answer(requestId: string, approved: boolean): boolean {
    if (this._mode !== 'legacy') {
      this._refusePreviewAction('Approvals are unavailable in text preview.');
      return false;
    }
    return cosStore.answer(requestId, approved);
  }

  cancel(turnId: string): void {
    if (this._mode !== 'legacy') {
      this._refusePreviewAction('Cancelling turns is unavailable in text preview.');
      return;
    }
    cosStore.cancel(turnId);
  }

  subscribe(callback: () => void): () => void {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  private _activeStore(): CosStore {
    if (this._mode === 'threaded') return this._selected?.store ?? this._emptyStore;
    return cosStore;
  }

  private _draftKey(): string {
    return this._mode === 'threaded' && this._selected ? this._selected.thread.id : LEGACY_DRAFT_KEY;
  }

  private _unread(threadId: string): boolean {
    return threadId !== '' && this._unreadThreadIds.has(threadId);
  }

  private _unreadThreadIds = new Set<string>();

  private _beginNegotiation(): void {
    const socket = this._socket;
    if (!socket || !socket.connected || !this._wanted) return;
    this._clearCapabilityTimer();
    this._capabilityRequestId = '';
    this._listRequestId = '';
    this._pendingSelection = null;
    this._connectionReady = false;
    this._mode = this._mode === 'threaded' ? 'threaded' : 'negotiating';
    // Legacy raw frames and voice narration are blocked before asking the
    // server, not only after a successful v2 response.
    socket.setLegacyCosFramesEnabled(false);
    const requestId = makeRequestId();
    if (!requestId) {
      this._setProblem('request_id_unavailable', 'A secure request ID could not be created.');
      return;
    }
    this._capabilityRequestId = requestId;
    const sent = socket.missionControl({
      type: 'missioncontrol-capabilities',
      protocol_version: PROTOCOL_VERSION,
      request_id: requestId,
    });
    if (!sent) {
      this._capabilityRequestId = '';
      this._setProblem('capabilities_unavailable', 'Text-thread capability could not be checked while disconnected.');
      return;
    }
    this._capabilityTimer = setTimeout(() => {
      if (this._capabilityRequestId !== requestId) return;
      this._capabilityRequestId = '';
      // An old server cannot identify a v2 request. The only fallback is the
      // explicit, unscoped legacy subscription below.
      this._enterLegacy();
    }, CAPABILITY_TIMEOUT_MS);
    this._notify();
  }

  private _handleFrame(frame: Record<string, unknown>): void {
    const type = stringValue(frame.type);
    if (type === 'missioncontrol-result') {
      this._handleResult(frame);
      return;
    }
    if (type === 'missioncontrol-event') this._handleEvent(frame);
  }

  private _handleResult(frame: Record<string, unknown>): void {
    if (positiveSafeInteger(frame.protocol_version) !== PROTOCOL_VERSION) return;
    const op = stringValue(frame.op);
    const requestId = stringValue(frame.request_id);
    switch (op) {
      case 'capabilities':
        if (requestId === this._capabilityRequestId) this._handleCapabilities(frame);
        break;
      case 'list':
        if (requestId === this._listRequestId) this._handleList(frame);
        break;
      case 'select':
        if (requestId === this._pendingSelection?.requestId) this._handleSelection(frame);
        break;
      case 'turn':
        if (requestId === this._pendingTurn?.requestId) this._handleTurnReceipt(frame);
        break;
      case 'history':
        if (this._pendingHistories.has(requestId)) this._handleHistory(frame, requestId);
        break;
    }
  }

  private _handleCapabilities(frame: Record<string, unknown>): void {
    this._clearCapabilityTimer();
    this._capabilityRequestId = '';
    const capabilities = recordValue(frame.capabilities);
    const textOnly =
      capabilities?.text_threads === true &&
      capabilities.voice === false &&
      capabilities.approval === false &&
      capabilities.cancel === false &&
      capabilities.reset === false;
    const enabled = frame.ok === true && frame.enabled === true && textOnly;
    if (!enabled) {
      this._enterLegacy();
      return;
    }
    this._mode = 'threaded';
    this._problem = null;
    this._socket?.setLegacyCosFramesEnabled(false);
    // Explicitly terminate any earlier unscoped subscription before accepting
    // a v2 thread. A selected/threaded request never falls back through it.
    this._socket?.cosSubscribe(false);
    this._requestList();
  }

  private _enterLegacy(): void {
    this._clearCapabilityTimer();
    this._mode = 'legacy';
    this._connectionReady = true;
    this._pendingSelection = null;
    this._pendingHistories.clear();
    this._preAckBuffers.clear();
    for (const state of this._states.values()) {
      state.historyRequestId = '';
      state.syncing = false;
    }
    this._listRequestId = '';
    this._problem = null;
    this._socket?.setLegacyCosFramesEnabled(true);
    if (cosStore.status === 'idle') cosStore.open();
    else cosStore.markReconnected();
    this._notify();
  }

  private _requestList(): void {
    const socket = this._socket;
    if (!socket || !socket.connected || !this.threaded) return;
    const requestId = makeRequestId();
    if (!requestId) {
      this._setProblem('request_id_unavailable', 'A secure request ID could not be created.');
      return;
    }
    this._listRequestId = requestId;
    if (
      !socket.missionControl({
        type: 'missioncontrol-list',
        protocol_version: PROTOCOL_VERSION,
        request_id: requestId,
      })
    ) {
      this._listRequestId = '';
      this._setProblem('list_transmit_failed', 'The real context list could not be requested.');
      return;
    }
    this._notify();
  }

  private _handleList(frame: Record<string, unknown>): void {
    this._listRequestId = '';
    if (frame.ok !== true || !Array.isArray(frame.threads)) {
      this._setProblem('list_refused', protocolFailure(frame, 'The server refused the context list.'));
      return;
    }
    const threads = frame.threads.map(parseCatalogThread);
    if (threads.some((thread) => thread === null)) {
      this._setProblem('invalid_context_list', 'The server returned an invalid context list.');
      return;
    }
    const parsedThreads = threads as CatalogThread[];
    const lobby = parsedThreads.find((thread) => thread.kind === 'lobby');
    if (!lobby) {
      this._setProblem('invalid_context_list', 'The server returned no Lobby context.');
      return;
    }
    const rawWorkspaces = Array.isArray(frame.workspaces) ? frame.workspaces : [];
    const workspaces = rawWorkspaces.map(parseWorkspace);
    if (workspaces.some((workspace) => workspace === null)) {
      this._setProblem('invalid_context_list', 'The server returned an invalid workspace context.');
      return;
    }
    this._threads = parsedThreads;
    this._workspaces = workspaces as WorkspaceContext[];
    for (const thread of parsedThreads) {
      const existing = this._states.get(thread.id);
      if (existing) existing.thread = { ...existing.thread, ...thread };
    }
    const restore = this._lastExplicitThreadId;
    const target =
      restore && parsedThreads.some((thread) => thread.id === restore)
        ? ({ kind: 'thread', threadId: restore } as const)
        : ({ kind: 'lobby' } as const);
    this._requestSelection(target, false, true);
  }

  private _requestSelection(
    target: ThreadContextTarget,
    persistLastSelection: boolean,
    allowUncertainTurn = false,
  ): boolean {
    const socket = this._socket;
    if (
      !socket ||
      !socket.connected ||
      !this.threaded ||
      this._pendingSelection ||
      (this._pendingTurn !== null && !allowUncertainTurn)
    ) {
      return false;
    }
    const requestId = makeRequestId();
    if (!requestId) {
      this._setProblem('request_id_unavailable', 'A secure request ID could not be created.');
      return false;
    }
    const frame: Record<string, unknown> = {
      type: 'missioncontrol-select',
      protocol_version: PROTOCOL_VERSION,
      request_id: requestId,
    };
    if (target.kind === 'lobby') frame.kind = 'lobby';
    else if (target.kind === 'workspace') frame.workspace_id = target.workspaceId;
    else frame.thread_id = target.threadId;
    const restorePreviousSelection = this._connectionReady && this._selected !== null;
    this._pendingSelection = {
      requestId,
      target,
      persistLastSelection,
      restorePreviousSelection,
      unknownBufferOverflow: false,
    };
    this._connectionReady = false;
    this._problem = null;
    if (!socket.missionControl(frame)) {
      this._pendingSelection = null;
      this._connectionReady = restorePreviousSelection;
      this._discardUnclaimedPreAckBuffers();
      this._setProblem('select_transmit_failed', 'The context selection could not be transmitted.');
      return false;
    }
    this._notify();
    return true;
  }

  private _handleSelection(frame: Record<string, unknown>): void {
    const pending = this._pendingSelection;
    if (!pending) return;
    this._pendingSelection = null;
    if (frame.ok !== true) {
      this._connectionReady = pending.restorePreviousSelection;
      this._discardUnclaimedPreAckBuffers();
      this._setProblem('select_refused', snapshotUnavailableMessage(frame, 'The server refused this context.'));
      return;
    }
    const snapshot = parseSnapshot(frame);
    const draftRef = uuidValue(frame.draft_ref);
    if (!snapshot || !draftRef) {
      this._connectionReady = pending.restorePreviousSelection;
      this._discardUnclaimedPreAckBuffers();
      this._setProblem('invalid_selection', snapshotFailureMessage(frame, 'The context was not changed.'));
      return;
    }
    if (
      (pending.target.kind === 'lobby' && snapshot.thread.kind !== 'lobby') ||
      (pending.target.kind === 'workspace' && snapshot.thread.kind !== 'workspace') ||
      (pending.target.kind === 'thread' && snapshot.thread.id !== pending.target.threadId)
    ) {
      this._connectionReady = pending.restorePreviousSelection;
      this._discardUnclaimedPreAckBuffers();
      this._setProblem('mismatched_selection', 'The server returned a different context than the one requested.');
      return;
    }
    const state = this._stateFor(snapshot.thread);
    state.thread = snapshot.thread;
    state.draftRef = draftRef;
    state.runtimeStale = false;
    this._applySnapshot(state, snapshot, 'selection', pending.unknownBufferOverflow);
    this._selected = state;
    if (pending.target.kind === 'workspace') {
      const workspaceId = pending.target.workspaceId;
      this._workspaces = this._workspaces.map((workspace) =>
        workspace.workspaceId === workspaceId
          ? { ...workspace, boundThreadId: snapshot.thread.id, label: snapshot.thread.displayName }
          : workspace,
      );
    }
    this._unreadThreadIds.delete(snapshot.thread.id);
    this._connectionReady = true;
    this._problem = null;
    if (pending.persistLastSelection) {
      this._lastExplicitThreadId = snapshot.thread.id;
      this._persistState();
    }
    this._discardUnclaimedPreAckBuffers();
    this._notify();
  }

  private _handleTurnReceipt(frame: Record<string, unknown>): void {
    const pending = this._pendingTurn;
    if (!pending) return;
    if (frame.ok !== true || !stringValue(frame.turn_id)) {
      this._clearTurnReceiptTimer();
      pending.phase = 'uncertain';
      this._setProblem(
        'turn_receipt_unconfirmed',
        protocolFailure(frame, 'The server did not confirm this turn. Your draft was kept.'),
      );
      return;
    }
    this._clearTurnReceiptTimer();
    this._pendingTurn = null;
    const current = this._drafts.get(pending.threadId) ?? '';
    if (current.trim() === pending.text) {
      this._drafts.delete(pending.threadId);
      this._persistState();
    }
    this._problem = null;
    this._notify();
  }

  private _handleHistory(frame: Record<string, unknown>, requestId: string): void {
    const pending = this._pendingHistories.get(requestId);
    this._pendingHistories.delete(requestId);
    if (!pending) return;
    const state = this._states.get(pending.threadId);
    if (state?.historyRequestId === requestId) state.historyRequestId = '';
    if (frame.ok !== true) {
      if (state) {
        // A refused repair means the server still has active or queued work.
        // Keep this thread fenced and its draft untouched; a later explicit
        // selection is the retry, never a fall back to global COS.
        state.syncing = true;
        this._setThreadFault(
          state,
          'history_refused',
          snapshotUnavailableMessage(frame, 'The server refused an authoritative history repair.'),
        );
      } else {
        this._setProblem(
          'history_refused',
          snapshotUnavailableMessage(frame, 'The server refused an authoritative history repair.'),
        );
      }
      return;
    }
    const snapshot = parseSnapshot(frame);
    if (
      !state ||
      !snapshot ||
      snapshot.thread.id !== pending.threadId ||
      snapshot.thread.runtimeGeneration !== pending.generation
    ) {
      if (state) {
        state.syncing = true;
        this._setThreadFault(
          state,
          'invalid_history',
          snapshotFailureMessage(frame, 'The authoritative history repair was refused.'),
        );
      } else {
        this._setProblem('invalid_history', snapshotFailureMessage(frame, 'The authoritative history repair was refused.'));
      }
      return;
    }
    this._applySnapshot(state, snapshot, 'history');
    this._notify();
  }

  private _handleEvent(frame: Record<string, unknown>): void {
    const envelope = parseThreadedEvent(frame);
    if (!envelope) return;
    const state = this._states.get(envelope.thread_id);
    if (this._shouldBufferPreAck(envelope, state)) {
      const buffer = this._bufferPreAck(envelope);
      if (buffer === null) {
        if (this._pendingSelection) {
          this._pendingSelection.unknownBufferOverflow = true;
          this._setProblem(
            'pre_ack_buffer_overflow',
            'Early thread updates exceeded the safety buffer. Waiting for authoritative history.',
          );
        }
        if (state && state.thread.runtimeGeneration === envelope.runtime_generation) {
          state.syncing = true;
          this._setThreadFault(
            state,
            'pre_ack_buffer_overflow',
            'Too many early thread updates arrived. An authoritative history repair is required.',
          );
          this._requestHistory(state);
        }
      } else if (buffer.overflow) {
        if (state) {
          state.syncing = true;
          this._setThreadFault(
            state,
            'pre_ack_buffer_overflow',
            'Too many early thread updates arrived. Reconciling authoritative history.',
          );
        } else if (this._pendingSelection) {
          this._pendingSelection.unknownBufferOverflow = true;
          this._setProblem(
            'pre_ack_buffer_overflow',
            'Early thread updates exceeded the safety buffer. Waiting for authoritative history.',
          );
        }
      }
      if (state?.syncing && !state.historyRequestId && !state.runtimeStale) {
        this._requestHistory(state);
      }
      return;
    }
    // An event for a never-selected, non-pending thread has no authoritative
    // snapshot to pair it with. It is intentionally not rendered.
    if (!state) return;
    // Once a newer generation has been observed, an older event must not
    // resume updating this state's renderer. A deliberate reselect owns the
    // next authoritative generation fence.
    if (state.runtimeStale) {
      this._markUnread(envelope.thread_id);
      return;
    }
    if (state.thread.runtimeGeneration !== envelope.runtime_generation) {
      state.runtimeStale = true;
      this._markUnread(envelope.thread_id);
      this._setThreadFault(
        state,
        'stale_runtime',
        'This context runtime changed. Select Talk here again before sending.',
      );
      return;
    }
    this._applyLiveEvent(state, envelope);
  }

  /**
   * While a select/history snapshot is outstanding, no event is allowed to
   * leap over the unknown snapshot cut. A fresh workspace binding has no UUID
   * until its select reply, so unknown event identities are retained only for
   * that one pending selection and only in the bounded buffers below.
   */
  private _shouldBufferPreAck(
    envelope: ThreadedCosEvent,
    state: ThreadState | undefined,
  ): boolean {
    if (
      state &&
      state.thread.runtimeGeneration === envelope.runtime_generation &&
      (state.historyRequestId !== '' || state.syncing)
    ) {
      return true;
    }
    const pending = this._pendingSelection;
    if (!pending) return false;
    if (pending.target.kind === 'thread') return envelope.thread_id === pending.target.threadId;
    if (pending.target.kind === 'lobby') {
      return this._threads.some(
        (thread) => thread.kind === 'lobby' && thread.id === envelope.thread_id,
      );
    }
    const workspaceId = pending.target.workspaceId;
    const workspace = this._workspaces.find(
      (item) => item.workspaceId === workspaceId,
    );
    if (workspace?.boundThreadId) return workspace.boundThreadId === envelope.thread_id;
    // The server assigns a thread UUID while binding a previously-unbound
    // workspace. Until select gives us that UUID, this is the only safe way
    // not to drop its early events; they are never rendered unless the reply
    // confirms this exact (thread, generation) identity.
    return state === undefined;
  }

  /**
   * Buffer one pre-ack event. A duplicate envelope costs no capacity, while
   * conflicting event ids/sequences are retained for the snapshot flusher to
   * detect and repair rather than silently choosing one.
   */
  private _bufferPreAck(envelope: ThreadedCosEvent): PreAckBuffer | null {
    const key = preAckKey(envelope.thread_id, envelope.runtime_generation);
    let buffer = this._preAckBuffers.get(key);
    if (!buffer) {
      if (this._preAckBuffers.size >= MAX_PRE_ACK_THREAD_BUFFERS) return null;
      buffer = {
        threadId: envelope.thread_id,
        generation: envelope.runtime_generation,
        events: [],
        overflow: false,
      };
      this._preAckBuffers.set(key, buffer);
    }
    if (
      buffer.events.some(
        (item) =>
          item.envelope.event_id === envelope.event_id &&
          item.envelope.thread_seq === envelope.thread_seq,
      )
    ) {
      return buffer;
    }
    if (buffer.events.length >= MAX_PRE_ACK_EVENTS_PER_THREAD) {
      buffer.overflow = true;
      return buffer;
    }
    buffer.events.push({ envelope });
    return buffer;
  }

  private _takePreAckBuffer(threadId: string, generation: number): PreAckBuffer {
    const key = preAckKey(threadId, generation);
    const found = this._preAckBuffers.get(key);
    this._preAckBuffers.delete(key);
    return (
      found ?? {
        threadId,
        generation,
        events: [],
        overflow: false,
      }
    );
  }

  /** Preserve unconsumed live pre-ack frames across an authoritative repair. */
  private _restoreBufferedTail(state: ThreadState, buffer: PreAckBuffer): void {
    const floor = state.lastSequence ?? -1;
    for (const item of buffer.events) {
      if (item.envelope.thread_seq <= floor) continue;
      this._bufferPreAck(item.envelope);
    }
  }

  /** Drop fresh-selection candidates once their select result is settled. */
  private _discardUnclaimedPreAckBuffers(): void {
    const historyKeys = new Set<string>();
    for (const pending of this._pendingHistories.values()) {
      historyKeys.add(preAckKey(pending.threadId, pending.generation));
    }
    for (const key of this._preAckBuffers.keys()) {
      if (!historyKeys.has(key)) this._preAckBuffers.delete(key);
    }
  }

  /**
   * Apply one validated snapshot without touching global selection or drafts.
   * That lets a background thread repair itself without swapping the visible
   * conversation, and lets selection commit only after a complete cut exists.
   */
  private _applySnapshot(
    state: ThreadState,
    snapshot: SnapshotPayload,
    source: 'selection' | 'history',
    forceRepair = false,
  ): void {
    const buffer = this._takePreAckBuffer(
      snapshot.thread.id,
      snapshot.thread.runtimeGeneration,
    );
    state.thread = snapshot.thread;
    state.lastSequence = snapshot.watermark;
    state.seenEventIds.clear();
    state.runtimeStale = false;
    state.syncing = false;
    if (source === 'selection') {
      state.store.adoptThreadSnapshot(
        snapshot.thread.runtimeSessionId,
        snapshot.history,
        snapshot.coveredTurnIds,
      );
    } else {
      state.store.adoptThreadHistory(snapshot.history, snapshot.coveredTurnIds);
    }

    const tailGap = this._flushSnapshotTail(state, snapshot, buffer);
    if (!forceRepair && !buffer.overflow && !tailGap) return;

    state.syncing = true;
    const reason = forceRepair || buffer.overflow
      ? 'Early thread updates exceeded the browser buffer. Reconciling authoritative history.'
      : 'Thread updates crossed the snapshot boundary out of order. Reconciling authoritative history.';
    this._setThreadFault(state, 'snapshot_tail_repair', reason);
    this._requestHistory(state);
  }

  /**
   * Apply retained pre-ack frames in sequence order from the server watermark.
   * Entries at or before the watermark are already represented by canonical
   * history and therefore ignored; a non-contiguous or conflicting tail is
   * repaired before it can render unrelated or duplicated text.
   */
  private _flushSnapshotTail(
    state: ThreadState,
    snapshot: SnapshotPayload,
    buffer: PreAckBuffer,
  ): boolean {
    const pending = buffer.events
      .filter((item) => item.envelope.thread_seq > snapshot.watermark)
      .sort((left, right) => left.envelope.thread_seq - right.envelope.thread_seq);

    let index = 0;
    let gap = false;
    const idSequences = new Map<string, number>();
    while (index < pending.length) {
      const first = pending[index];
      if (!first) break;
      const sequence = first.envelope.thread_seq;
      const group: BufferedThreadEvent[] = [];
      while (index < pending.length && pending[index]?.envelope.thread_seq === sequence) {
        const item = pending[index];
        if (item) group.push(item);
        index++;
      }
      const ids = new Set(group.map((item) => item.envelope.event_id));
      for (const item of group) {
        const prior = idSequences.get(item.envelope.event_id);
        if (prior !== undefined && prior !== sequence) gap = true;
        idSequences.set(item.envelope.event_id, sequence);
      }
      if (gap || ids.size !== 1) {
        gap = true;
        break;
      }
      const chosen = group[0];
      if (!chosen) break;
      const expected = (state.lastSequence ?? snapshot.watermark) + 1;
      if (
        sequence !== expected ||
        state.seenEventIds.has(chosen.envelope.event_id)
      ) {
        gap = true;
        break;
      }
      this._applyEvent(state, chosen.envelope);
    }
    if (gap) this._restoreBufferedTail(state, buffer);
    return gap;
  }

  /**
   * Live events after a snapshot use the same sequence fence. A gap's first
   * frame is retained before the repair request, so the repair cannot turn a
   * detected loss into a real one.
   */
  private _applyLiveEvent(state: ThreadState, envelope: ThreadedCosEvent): void {
    const last = state.lastSequence;
    if (last === null) {
      this._bufferPreAck(envelope);
      state.syncing = true;
      this._setThreadFault(
        state,
        'missing_snapshot_fence',
        'Thread update arrived without an authoritative snapshot fence. Reconciling history.',
      );
      this._requestHistory(state);
      return;
    }
    if (
      envelope.thread_seq <= last ||
      state.seenEventIds.has(envelope.event_id)
    ) {
      // A duplicate never appends locally. The v2 protocol still asks us to
      // validate it through authoritative history, rather than assuming a
      // reconnect replay is harmless.
      state.syncing = true;
      this._setThreadFault(
        state,
        'thread_event_duplicate',
        'A duplicate thread update was received. Reconciling authoritative history.',
      );
      this._requestHistory(state);
      return;
    }
    if (envelope.thread_seq !== last + 1) {
      const buffer = this._bufferPreAck(envelope);
      state.syncing = true;
      this._setThreadFault(
        state,
        buffer?.overflow || buffer === null
          ? 'pre_ack_buffer_overflow'
          : 'thread_sequence_gap',
        buffer?.overflow || buffer === null
          ? 'Thread update buffering overflowed. Reconciling authoritative history.'
          : 'Thread updates arrived out of order. Reconciling authoritative history.',
      );
      this._requestHistory(state);
      return;
    }
    this._applyEvent(state, envelope);
  }

  private _applyEvent(state: ThreadState, envelope: ThreadedCosEvent): void {
    state.store.receiveThreadEvent(envelope);
    state.lastSequence = envelope.thread_seq;
    this._rememberEvent(state, envelope.event_id);
    this._markUnread(envelope.thread_id);
  }

  private _requestHistory(state: ThreadState): void {
    if (state.historyRequestId || !this._socket?.connected) return;
    const requestId = makeRequestId();
    if (!requestId) {
      this._setThreadFault(state, 'request_id_unavailable', 'A secure request ID could not be created.');
      return;
    }
    state.syncing = true;
    state.historyRequestId = requestId;
    this._pendingHistories.set(requestId, {
      threadId: state.thread.id,
      generation: state.thread.runtimeGeneration,
    });
    if (
      !this._socket.missionControl({
        type: 'missioncontrol-history',
        protocol_version: PROTOCOL_VERSION,
        request_id: requestId,
        thread_id: state.thread.id,
        expected_runtime_generation: state.thread.runtimeGeneration,
      })
    ) {
      this._pendingHistories.delete(requestId);
      state.historyRequestId = '';
      this._setThreadFault(
        state,
        'history_transmit_failed',
        'An authoritative history repair could not be requested.',
      );
      return;
    }
    this._notify();
  }

  private _stateFor(thread: CatalogThread): ThreadState {
    const existing = this._states.get(thread.id);
    if (existing) return existing;
    const store = new CosStore();
    const state: ThreadState = {
      thread,
      draftRef: '',
      store,
      lastSequence: null,
      seenEventIds: new Map(),
      historyRequestId: '',
      runtimeStale: false,
      syncing: false,
    };
    store.subscribe(() => this._notify());
    this._states.set(thread.id, state);
    return state;
  }

  private _rememberEvent(state: ThreadState, eventId: string): void {
    state.seenEventIds.set(eventId, true);
    if (state.seenEventIds.size <= MAX_SEEN_EVENT_IDS) return;
    const oldest = state.seenEventIds.keys().next().value;
    if (typeof oldest === 'string') state.seenEventIds.delete(oldest);
  }

  private _markUnread(threadId: string): void {
    if (this._selected?.thread.id === threadId) return;
    this._unreadThreadIds.add(threadId);
  }

  private _refusePreviewAction(message: string): void {
    this._setProblem('unsupported_in_text_preview', message);
  }

  private _setThreadFault(state: ThreadState, code: string, message: string): void {
    state.store.setThreadFault(code, message);
    this._markUnread(state.thread.id);
    this._notify();
  }

  private _setProblem(code: string, message: string): void {
    this._problem = { code, message, fatal: false };
    this._notify();
  }

  private _clearCapabilityTimer(): void {
    if (this._capabilityTimer !== undefined) clearTimeout(this._capabilityTimer);
    this._capabilityTimer = undefined;
  }

  private _clearTurnReceiptTimer(): void {
    if (this._turnReceiptTimer !== undefined) clearTimeout(this._turnReceiptTimer);
    this._turnReceiptTimer = undefined;
  }

  private _loadPersistedState(): void {
    if (this._storageLoaded) return;
    this._storageLoaded = true;
    try {
      const raw = sessionStorage.getItem(storageKey());
      if (!raw) return;
      const value = recordValue(JSON.parse(raw));
      if (!value || value.version !== STORAGE_VERSION) return;
      const drafts = recordValue(value.drafts);
      if (drafts) {
        for (const [threadId, draft] of Object.entries(drafts)) {
          if (typeof draft === 'string' && draft) this._drafts.set(threadId, draft);
        }
      }
      this._lastExplicitThreadId = uuidValue(value.last_selection);
    } catch {
      this._storageUnavailable = true;
    }
  }

  private _persistState(): void {
    if (!this._storageLoaded) return;
    const drafts: Record<string, string> = {};
    for (const [threadId, draft] of this._drafts) drafts[threadId] = draft;
    const state: PersistedState = {
      version: STORAGE_VERSION,
      drafts,
      last_selection: this._lastExplicitThreadId,
    };
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify(state));
    } catch {
      this._storageUnavailable = true;
    }
  }

  private _notify(): void {
    if (this._notifyPending) return;
    this._notifyPending = true;
    const flush = () => {
      this._notifyPending = false;
      for (const callback of this._listeners) callback();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  }
}

export const threadStore = new ThreadStore();