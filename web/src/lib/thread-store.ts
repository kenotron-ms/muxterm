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
  type ThreadedSnapshotState,
} from './cos-store.js';
import { requestViewerDocument } from './artifact-open.js';

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
const NO_THREAD_CONTROLS: ThreadCapabilities = Object.freeze({
  approval: false,
  cancel: false,
  reset: false,
  archive: false,
  detailReadOnly: false,
});

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
  /** Stable v2 event identity -> its immutable thread-local sequence. */
  seenEventIds: Map<string, number>;
  historyRequestId: string;
  runtimeStale: boolean;
  /** A snapshot repair is in flight; no new turn may enter during the cut. */
  syncing: boolean;
  /** One automatic repair per generation prevents a persistent gap loop. */
  repairAttempted: boolean;
  /** An archive has invalidated this local selection until an explicit bind/select. */
  archived: boolean;
  /** Per-root durable tool tracking returned only by an authoritative snapshot. */
  rootState: ThreadRootState | null;
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

type ThreadControlKind = 'cancel' | 'approval' | 'reset' | 'archive';

interface ThreadCapabilities {
  readonly approval: boolean;
  readonly cancel: boolean;
  readonly reset: boolean;
  readonly archive: boolean;
  /** Explicitly gates cross-context read-only detail requests. */
  readonly detailReadOnly: boolean;
}

interface PendingControl {
  readonly requestId: string;
  readonly kind: ThreadControlKind;
  readonly threadId: string;
  readonly generation: number;
  readonly turnId: string;
  readonly approvalId: string;
  readonly approved: boolean;
}

export interface ThreadControlTarget {
  readonly threadId: string;
  readonly generation: number;
  readonly label: string;
  readonly kind: 'lobby' | 'workspace';
}

interface AttentionRecord {
  readonly id: string;
  readonly threadId: string;
  readonly runtimeGeneration: number;
  readonly turnId: string;
  readonly kind: 'terminal' | 'error' | 'approval' | 'pending';
  readonly observedAt: string;
  readonly observedAtMs: number;
  readonly acknowledgedAt: string;
}

/** A durable attention item annotated only with local display/read state. */
export interface ThreadAttention {
  readonly id: string;
  readonly threadId: string;
  readonly runtimeGeneration: number;
  readonly turnId: string;
  readonly label: string;
  readonly reason: string;
  /** This is an observation timestamp, never a claim that the work is fresh. */
  readonly observedAt: string;
  readonly canViewDetail: boolean;
  readonly detailUnavailable: string;
  readonly detailPending: boolean;
  readonly acknowledging: boolean;
}

interface SummaryRecord {
  readonly id: string;
  readonly threadId: string;
  readonly runtimeSessionId: string;
  readonly runtimeGeneration: number;
  readonly turnId: string;
  readonly observedAt: string;
  readonly observedAtMs: number;
  readonly text: string;
}

interface MigrationPreview {
  readonly path: string;
  readonly exists: boolean;
  readonly checksum: string;
  readonly catalogSchema: number | null;
  readonly threadCount: number;
  readonly runtimeRefCount: number;
  readonly legacySessionId: string;
  readonly legacyWorkingDir: string;
  readonly disposition: string;
}

/** A small, provenance-bearing terminal extract for the selected Lobby only. */
export interface ThreadSummary {
  readonly id: string;
  readonly threadId: string;
  readonly label: string;
  readonly turnId: string;
  readonly observedAt: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface ThreadTodoItem {
  readonly content: string;
  readonly activeForm: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
}

export interface ThreadRootState {
  readonly todos: readonly ThreadTodoItem[];
  readonly goal: string;
  /** Always false when provided: tracking state, not an autonomous scheduler. */
  readonly autonomous: false;
}

interface PendingDetail {
  readonly requestId: string;
  readonly attentionId: string;
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

interface SnapshotFields {
  readonly history: readonly unknown[];
  /** Snapshot cut supplied by the server, including zero. */
  readonly watermark: number;
  /** Event journal entries at or before `watermark`, in full v2 envelopes. */
  readonly replayEvents: readonly ThreadedCosEvent[];
  /**
   * Immutable runtime turn ids already materialized in `history`. Late events
   * for these ids still consume sequence space but must not render again.
   */
  readonly coveredTurnIds: readonly string[];
  /**
   * Persisted completed turn IDs from the snapshot boundary which must not be
   * replay-rendered when canonical history already contains an ambiguous,
   * intentionally unbound transcript group.
   */
  readonly replaySuppressedTurnIds: readonly string[];
  readonly activeTurnId: string;
  readonly pendingTurnIds: readonly string[];
  /**
   * The server's bounded journal or client broker lost data. The snapshot is
   * still a useful canonical cut, but only one follow-up repair is automatic.
   */
  readonly gap: boolean;
  /** Optional before increment 2; no absent value is rendered as state. */
  readonly rootState: ThreadRootState | null;
}

interface SnapshotPayload extends SnapshotFields {
  readonly thread: CatalogThread;
}

/**
 * Detail uses the same wire cut shape as select/history, but it is intentionally
 * a separate parsed value: it is rendered in Viewer only and is never adopted
 * into a thread renderer, draft binding, or selection.
 */
interface DetailPayload extends SnapshotFields {
  readonly thread: CatalogThread;
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

function attentionReason(kind: AttentionRecord['kind']): string {
  switch (kind) {
    case 'pending':
      return 'A submitted turn is queued';
    case 'approval':
      return 'A scoped approval is waiting';
    case 'error':
      return 'A turn reported an error';
    case 'terminal':
      return 'A turn reached a terminal result';
  }
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
  // Go's zero-value slice serializes as null. It means the exact same empty
  // immutable set as [], and occurs for a newly opened root with no persisted
  // canonical turns yet.
  if (value === null) return [];
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

/** Optional additive v2 field: old servers omit it, which means no suppression. */
function parseReplaySuppressedTurnIds(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return [];
  return parseCoveredTurnIds(value);
}

function parseSnapshotTurn(value: unknown, expectedStatus: 'active' | 'queued'): string | null {
  const raw = recordValue(value);
  const turnId = raw ? stringValue(raw.turn_id) : '';
  return raw && raw.status === expectedStatus && turnId !== '' ? turnId : null;
}

function parseActiveTurn(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  return parseSnapshotTurn(value, 'active');
}

function parsePendingTurns(value: unknown, activeTurnId: string): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  const seen = new Set<string>(activeTurnId ? [activeTurnId] : []);
  for (const entry of value) {
    const turnId = parseSnapshotTurn(entry, 'queued');
    if (!turnId || seen.has(turnId)) return null;
    seen.add(turnId);
    ids.push(turnId);
  }
  return ids;
}

function parseTodoState(value: unknown): readonly ThreadTodoItem[] | null {
  if (!Array.isArray(value)) return null;
  const todos: ThreadTodoItem[] = [];
  for (const entry of value.slice(0, 20)) {
    const raw = recordValue(entry);
    if (!raw) continue;
    const content = stringValue(raw.content);
    const activeForm = stringValue(raw.activeForm) || stringValue(raw.active_form);
    const status = stringValue(raw.status);
    if (
      !content ||
      (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
    ) {
      continue;
    }
    todos.push({ content, activeForm, status });
  }
  return todos;
}

function parseGoalState(value: unknown): { goal: string; autonomous: false } | null {
  const raw = recordValue(value);
  if (!raw) return null;
  if (raw.autonomous !== false) return null;
  const suppliedGoal = raw.goal;
  if (suppliedGoal !== null && suppliedGoal !== undefined && typeof suppliedGoal !== 'string') {
    return null;
  }
  return { goal: stringValue(suppliedGoal), autonomous: false };
}

function parseRootState(todo: unknown, goal: unknown): ThreadRootState | null {
  const todoState = todo === undefined ? null : parseTodoState(todo);
  const goalState = goal === undefined ? null : parseGoalState(goal);
  if (todoState === null && goalState === null) return null;
  return {
    todos: todoState ?? [],
    goal: goalState?.goal ?? '',
    autonomous: false,
  };
}

function parseTimestamp(value: unknown): { text: string; ms: number } | null {
  const text = stringValue(value);
  const ms = Date.parse(text);
  return text !== '' && Number.isFinite(ms) ? { text, ms } : null;
}

function parseAttention(value: unknown): AttentionRecord | null {
  const raw = recordValue(value);
  if (!raw) return null;
  const id = uuidValue(raw.id);
  const threadId = uuidValue(raw.thread_id);
  const runtimeGeneration = positiveSafeInteger(raw.runtime_generation);
  const kind = stringValue(raw.kind);
  const observedAt = parseTimestamp(raw.observed_at);
  const acknowledged = raw.acknowledged_at;
  const acknowledgedAt =
    acknowledged === undefined || acknowledged === null ? '' : stringValue(acknowledged);
  if (
    !id ||
    !threadId ||
    runtimeGeneration === 0 ||
    (kind !== 'terminal' && kind !== 'error' && kind !== 'approval' && kind !== 'pending') ||
    !observedAt ||
    (acknowledgedAt !== '' && !parseTimestamp(acknowledgedAt))
  ) {
    return null;
  }
  return {
    id,
    threadId,
    runtimeGeneration,
    turnId: stringValue(raw.turn_id),
    kind,
    observedAt: observedAt.text,
    observedAtMs: observedAt.ms,
    acknowledgedAt,
  };
}

function parseSummary(value: unknown): SummaryRecord | null {
  const raw = recordValue(value);
  if (!raw) return null;
  const id = uuidValue(raw.id);
  const threadId = uuidValue(raw.thread_id);
  const runtimeSessionId = uuidValue(raw.runtime_session_id);
  const runtimeGeneration = positiveSafeInteger(raw.runtime_generation);
  const turnId = stringValue(raw.turn_id);
  const observedAt = parseTimestamp(raw.observed_at);
  const text = stringValue(raw.text);
  if (
    !id ||
    !threadId ||
    !runtimeSessionId ||
    runtimeGeneration === 0 ||
    !turnId ||
    raw.kind !== 'extract' ||
    !observedAt ||
    text === '' ||
    text.length > 1200
  ) {
    return null;
  }
  return {
    id,
    threadId,
    runtimeSessionId,
    runtimeGeneration,
    turnId,
    observedAt: observedAt.text,
    observedAtMs: observedAt.ms,
    text,
  };
}

function parseMigrationPreview(value: unknown): MigrationPreview | null {
  const raw = recordValue(value);
  if (!raw || typeof raw.exists !== 'boolean') return null;
  const threadCount = nonNegativeSafeInteger(raw.thread_count);
  const runtimeRefCount = nonNegativeSafeInteger(raw.runtime_ref_count);
  const catalogSchema =
    raw.catalog_schema === undefined ? null : nonNegativeSafeInteger(raw.catalog_schema);
  const path = stringValue(raw.path);
  const disposition = stringValue(raw.disposition);
  if (
    path === '' ||
    disposition === '' ||
    threadCount === null ||
    runtimeRefCount === null ||
    (raw.catalog_schema !== undefined && catalogSchema === null)
  ) {
    return null;
  }
  return {
    path,
    exists: raw.exists,
    checksum: stringValue(raw.checksum_sha256),
    catalogSchema,
    threadCount,
    runtimeRefCount,
    legacySessionId: stringValue(raw.legacy_session_id),
    legacyWorkingDir: stringValue(raw.legacy_working_dir),
    disposition,
  };
}

function prettyValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '[unrenderable response value]';
  }
}

function describeRootState(rootState: ThreadRootState | null): string[] {
  if (!rootState) return ['Tracking snapshot: not provided'];
  const lines = ['Tracking snapshot (state only; no autonomous scheduler):'];
  if (rootState.goal !== '') {
    lines.push(`Goal: ${rootState.goal}`, 'Goal mode: tracking only (autonomous: false)');
  } else {
    lines.push('Goal: none');
  }
  if (rootState.todos.length === 0) {
    lines.push('Todo: none');
  } else {
    lines.push('Todo:');
    for (const todo of rootState.todos) {
      lines.push(`- [${todo.status}] ${todo.activeForm || todo.content}`);
    }
  }
  return lines;
}

function formatDetailDocument(threadLabel: string, snapshot: DetailPayload): string {
  const replay = snapshot.replayEvents.map((event) => ({
    thread_seq: event.thread_seq,
    event_id: event.event_id,
    turn_id: stringValue(event.event.turn_id),
    ev: stringValue(event.event.ev),
  }));
  return [
    'Mission Control context detail',
    'Read-only browser view. This did not switch the conversation, submit a turn, or copy history into Lobby.',
    '',
    `Context: ${threadLabel}`,
    `Thread ID: ${snapshot.thread.id}`,
    `Runtime session: ${snapshot.thread.runtimeSessionId}`,
    `Runtime generation: ${snapshot.thread.runtimeGeneration}`,
    `Snapshot watermark: ${snapshot.watermark}`,
    `Event journal gap: ${snapshot.gap ? 'reported — missing content was not inferred' : 'not reported'}`,
    `Active turn: ${snapshot.activeTurnId || 'none'}`,
    `Queued turns: ${snapshot.pendingTurnIds.length > 0 ? snapshot.pendingTurnIds.join(', ') : 'none'}`,
    `Covered canonical turn IDs: ${snapshot.coveredTurnIds.length > 0 ? snapshot.coveredTurnIds.join(', ') : 'none'}`,
    ...describeRootState(snapshot.rootState),
    '',
    'Canonical history (bounded server snapshot):',
    prettyValue(snapshot.history),
    '',
    'Replay envelope metadata (bounded ordered journal):',
    prettyValue(replay),
  ].join('\n');
}

function formatMigrationPreview(preview: MigrationPreview): string {
  return [
    'Mission Control catalog migration / rollback preview',
    'Preview only; no history moved. No migration, rollback, reset, rename, or configuration action was executed.',
    '',
    `Catalog path: ${preview.path}`,
    `Catalog exists: ${preview.exists ? 'yes' : 'no'}`,
    `Checksum SHA-256: ${preview.checksum || 'not applicable'}`,
    `Catalog schema: ${preview.catalogSchema === null ? 'not present' : preview.catalogSchema}`,
    `Thread records: ${preview.threadCount}`,
    `Runtime references: ${preview.runtimeRefCount}`,
    `Legacy session ID: ${preview.legacySessionId || 'not available'}`,
    `Legacy working directory: ${preview.legacyWorkingDir || 'not available'}`,
    '',
    `Disposition: ${preview.disposition}`,
  ].join('\n');
}

function parseSnapshotFields(
  frame: Record<string, unknown>,
  thread: CatalogThread,
): SnapshotFields | null {
  const watermark = nonNegativeSafeInteger(frame.thread_seq);
  const coveredTurnIds = parseCoveredTurnIds(frame.covered_turn_ids);
  const replaySuppressedTurnIds = parseReplaySuppressedTurnIds(frame.replay_suppressed_turn_ids);
  const activeTurnId = parseActiveTurn(frame.active);
  const pendingTurnIds = parsePendingTurns(frame.pending, activeTurnId ?? '');
  if (
    watermark === null ||
    !Array.isArray(frame.history) ||
    coveredTurnIds === null ||
    replaySuppressedTurnIds === null ||
    activeTurnId === null ||
    pendingTurnIds === null ||
    typeof frame.gap !== 'boolean'
  ) {
    return null;
  }

  const rawReplay = frame.replay_events;
  if (!Array.isArray(rawReplay)) return null;
  const replayEvents: ThreadedCosEvent[] = [];
  for (const rawEvent of rawReplay) {
    const event = parseThreadedEvent(rawEvent);
    if (
      !event ||
      event.thread_id !== thread.id ||
      event.runtime_generation !== thread.runtimeGeneration ||
      event.thread_seq > watermark
    ) {
      return null;
    }
    replayEvents.push(event);
  }
  return {
    history: frame.history,
    watermark,
    replayEvents,
    coveredTurnIds,
    replaySuppressedTurnIds,
    activeTurnId,
    pendingTurnIds,
    gap: frame.gap,
    rootState: parseRootState(frame.todo, frame.goal),
  };
}

function parseSnapshot(frame: Record<string, unknown>): SnapshotPayload | null {
  const thread = parseRuntimeThread(frame.thread);
  if (!thread) return null;
  const fields = parseSnapshotFields(frame, thread);
  return fields ? { thread, ...fields } : null;
}

/**
 * Detail is parsed as a read-only payload rather than a selectable snapshot.
 * Keeping this function apart makes it impossible for detail handling to
 * accidentally enter the renderer/draft/selection adoption path.
 */
function parseDetailPayload(frame: Record<string, unknown>): DetailPayload | null {
  const thread = parseRuntimeThread(frame.thread);
  if (!thread) return null;
  const fields = parseSnapshotFields(frame, thread);
  return fields ? { thread, ...fields } : null;
}

function snapshotFailureMessage(frame: Record<string, unknown>, fallback: string): string {
  if (nonNegativeSafeInteger(frame.thread_seq) === null) {
    return `The server did not provide the required numeric thread_seq watermark. ${fallback}`;
  }
  if (parseCoveredTurnIds(frame.covered_turn_ids) === null) {
    return `The server did not provide well-formed required covered_turn_ids. ${fallback}`;
  }
  if (parseReplaySuppressedTurnIds(frame.replay_suppressed_turn_ids) === null) {
    return `The server provided malformed replay_suppressed_turn_ids. ${fallback}`;
  }
  const activeTurnId = parseActiveTurn(frame.active);
  if (activeTurnId === null || parsePendingTurns(frame.pending, activeTurnId ?? '') === null) {
    return `The server did not provide valid active/pending turn state. ${fallback}`;
  }
  const rawReplay = frame.replay_events;
  if (!Array.isArray(rawReplay)) {
    return `The server did not provide the required replay_events array. ${fallback}`;
  }
  if (typeof frame.gap !== 'boolean') {
    return `The server did not provide the required gap flag. ${fallback}`;
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
  /** The live catalog response for this socket epoch has been validated. */
  private _catalogReady = false;
  private _workspaces: WorkspaceContext[] = [];
  private _states = new Map<string, ThreadState>();
  private _emptyStore = new CosStore();
  private _selected: ThreadState | null = null;
  private _pendingSelection: PendingSelection | null = null;
  private _pendingTurn: PendingTurn | null = null;
  private _pendingHistories = new Map<string, PendingHistory>();
  private _pendingControls = new Map<string, PendingControl>();
  private _pendingDetails = new Map<string, PendingDetail>();
  private _pendingAttentionAcks = new Map<string, string>();
  private _capabilities: ThreadCapabilities = NO_THREAD_CONTROLS;
  /** Durable catalog metadata; it never selects or focuses a conversation. */
  private _attention: AttentionRecord[] = [];
  private _summaries: SummaryRecord[] = [];
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
  private _attentionRequestId = '';
  private _summariesRequestId = '';
  private _migrationPreviewRequestId = '';
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
    if (this._selected?.archived) {
      return this._selected.store.fault?.message ?? 'This context was archived. Select a live context.';
    }
    if (this._selected?.runtimeStale) {
      return this._selected.store.fault?.message ?? 'Context runtime changed; select it again.';
    }
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
    if (this._selected.archived || this._selected.runtimeStale) {
      return (
        this._selected.store.fault?.message ??
        'This context runtime changed. Select Talk here again before sending.'
      );
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

  /** Durable unacknowledged work, in catalog observation order. */
  get attention(): readonly ThreadAttention[] {
    return this._attention
      .filter((item) => item.acknowledgedAt === '')
      .map((item) => {
        const detailUnavailable = this._detailUnavailable(item);
        return {
          id: item.id,
          threadId: item.threadId,
          runtimeGeneration: item.runtimeGeneration,
          turnId: item.turnId,
          label: this._threadLabel(item.threadId),
          reason: attentionReason(item.kind),
          observedAt: item.observedAt,
          canViewDetail: detailUnavailable === '',
          detailUnavailable,
          detailPending: this._hasPendingDetail(item.id),
          acknowledging: this._hasPendingAttentionAck(item.id),
        };
      });
  }

  /**
   * Completed-work extracts appear only while Lobby is selected. `observedAt`
   * is provenance, not an assertion the remote work is currently fresh.
   */
  get lobbySummaries(): readonly ThreadSummary[] {
    if (this._selected?.thread.kind !== 'lobby') return [];
    return this._summaries.slice(-3).reverse().map((summary) => ({
      id: summary.id,
      threadId: summary.threadId,
      label: this._threadLabel(summary.threadId),
      turnId: summary.turnId,
      observedAt: summary.observedAt,
      text: summary.text.length > 280 ? `${summary.text.slice(0, 279)}…` : summary.text,
      truncated: summary.text.length > 280 || summary.text.length === 1200,
    }));
  }

  /** Durable todo/goal tracking only for the committed visible root. */
  get rootState(): ThreadRootState | null {
    const state = this._selected;
    if (!this.threaded || !state || state.rootState === null) return null;
    return state.rootState.todos.length > 0 || state.rootState.goal !== '' ? state.rootState : null;
  }

  get migrationPreviewPending(): boolean {
    return this._migrationPreviewRequestId !== '';
  }

  /** Capability-gated exact target captured by a reset/archive confirmation. */
  get controlTarget(): ThreadControlTarget | null {
    const state = this._selected;
    if (
      !this.threaded ||
      !this._connectionReady ||
      !state ||
      state.runtimeStale ||
      state.syncing ||
      state.archived
    ) {
      return null;
    }
    return {
      threadId: state.thread.id,
      generation: state.thread.runtimeGeneration,
      label: this.contextLabel,
      kind: state.thread.kind,
    };
  }

  get resetAvailable(): boolean {
    const target = this.controlTarget;
    return (
      this._capabilities.reset &&
      target !== null &&
      !this._hasPendingControl('reset', target.threadId, '')
    );
  }

  get archiveAvailable(): boolean {
    const target = this.controlTarget;
    return (
      this._capabilities.archive &&
      target?.kind === 'workspace' &&
      !this._hasPendingControl('archive', target.threadId, '')
    );
  }

  get archiveSupported(): boolean {
    return this._capabilities.archive;
  }

  get approvalAvailable(): boolean {
    return this._capabilities.approval && this.controlTarget !== null;
  }

  canCancel(turnId: string): boolean {
    const target = this.controlTarget;
    return (
      this._capabilities.cancel &&
      target !== null &&
      turnId !== '' &&
      !this._hasPendingControl('cancel', target.threadId, turnId)
    );
  }

  canAnswer(turnId: string, approvalId: string): boolean {
    const target = this.controlTarget;
    return (
      this._capabilities.approval &&
      target !== null &&
      turnId !== '' &&
      approvalId !== '' &&
      !this._hasPendingControl('approval', target.threadId, approvalId)
    );
  }

  isControlPending(kind: ThreadControlKind, id = ''): boolean {
    const target = this.controlTarget;
    return target !== null && this._hasPendingControl(kind, target.threadId, id);
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
    this._catalogReady = false;
    this._attentionRequestId = '';
    this._summariesRequestId = '';
    this._migrationPreviewRequestId = '';
    this._pendingSelection = null;
    this._pendingHistories.clear();
    this._pendingControls.clear();
    this._pendingDetails.clear();
    this._pendingAttentionAcks.clear();
    this._preAckBuffers.clear();
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
      state.syncing = false;
      state.repairAttempted = false;
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

  /**
   * Metadata-only acknowledgement. This never changes selection, a turn,
   * microphone state, or an approval decision.
   */
  acknowledgeAttention(attentionId: string): boolean {
    const record = this._attention.find(
      (item) => item.id === attentionId && item.acknowledgedAt === '',
    );
    if (!this.threaded || !record || this._hasPendingAttentionAck(attentionId)) return false;
    const requestId = makeRequestId();
    if (!requestId) {
      this._setProblem('request_id_unavailable', 'A secure request ID could not be created.');
      return false;
    }
    this._pendingAttentionAcks.set(requestId, attentionId);
    if (
      !this._socket?.missionControl({
        type: 'missioncontrol-attention-ack',
        protocol_version: PROTOCOL_VERSION,
        request_id: requestId,
        attention_id: attentionId,
      })
    ) {
      this._pendingAttentionAcks.delete(requestId);
      this._setProblem(
        'attention_ack_transmit_failed',
        'The attention acknowledgement could not be transmitted. The notice was kept.',
      );
      return false;
    }
    this._notify();
    return true;
  }

  /**
   * Detail is an explicit read-only request against the attention source's
   * immutable thread/generation pair. It does not select that source.
   */
  viewAttentionDetail(attentionId: string): boolean {
    const record = this._attention.find((item) => item.id === attentionId);
    if (!record || !this.threaded || this._hasPendingDetail(attentionId)) return false;
    const unavailable = this._detailUnavailable(record);
    if (unavailable !== '') {
      this._setProblem('detail_unavailable', unavailable);
      return false;
    }
    const requestId = makeRequestId();
    if (!requestId) {
      this._setProblem('request_id_unavailable', 'A secure request ID could not be created.');
      return false;
    }
    const pending: PendingDetail = {
      requestId,
      attentionId,
      threadId: record.threadId,
      generation: record.runtimeGeneration,
    };
    this._pendingDetails.set(requestId, pending);
    if (
      !this._socket?.missionControl({
        type: 'missioncontrol-detail',
        protocol_version: PROTOCOL_VERSION,
        request_id: requestId,
        thread_id: pending.threadId,
        expected_runtime_generation: pending.generation,
      })
    ) {
      this._pendingDetails.delete(requestId);
      this._setProblem(
        'detail_transmit_failed',
        'The read-only detail request could not be transmitted. The conversation was not changed.',
      );
      return false;
    }
    this._notify();
    return true;
  }

  /** Inspect migration/rollback metadata only; this endpoint has no apply verb. */
  migrationPreview(): boolean {
    if (!this.threaded || this._migrationPreviewRequestId !== '') return false;
    const requestId = makeRequestId();
    if (!requestId) {
      this._setProblem('request_id_unavailable', 'A secure request ID could not be created.');
      return false;
    }
    this._migrationPreviewRequestId = requestId;
    if (
      !this._socket?.missionControl({
        type: 'missioncontrol-migration-preview',
        protocol_version: PROTOCOL_VERSION,
        request_id: requestId,
      })
    ) {
      this._migrationPreviewRequestId = '';
      this._setProblem(
        'migration_preview_transmit_failed',
        'The metadata-only migration preview could not be transmitted. Nothing changed.',
      );
      return false;
    }
    this._notify();
    return true;
  }

  /**
   * Send an approval only against the exact turn/approval pair rendered by the
   * current selected thread. Legacy keeps its existing request-id-only wire.
   */
  answer(turnId: string, approvalId: string, approved: boolean): boolean {
    if (this._mode === 'legacy') return cosStore.answer(approvalId, approved);
    const target = this.controlTarget;
    if (!target || !this.canAnswer(turnId, approvalId)) return false;
    return this._sendThreadControl('approval', target, {
      turn_id: turnId,
      approval_id: approvalId,
      approved,
    });
  }

  /** Cancel exactly the live/queued turn whose control was pressed. */
  cancel(turnId: string): boolean {
    if (this._mode === 'legacy') {
      cosStore.cancel(turnId);
      return true;
    }
    const target = this.controlTarget;
    if (!target || !this.canCancel(turnId)) return false;
    return this._sendThreadControl('cancel', target, { turn_id: turnId });
  }

  /** Reset requires a confirmation-captured selected thread/generation. */
  reset(target: ThreadControlTarget): boolean {
    if (!this.resetAvailable || !this._sameControlTarget(target)) return false;
    return this._sendThreadControl('reset', target);
  }

  /** Archive is unavailable for Lobby even if a server accidentally advertises it. */
  archive(target: ThreadControlTarget): boolean {
    if (!this.archiveAvailable || target.kind === 'lobby' || !this._sameControlTarget(target)) {
      return false;
    }
    return this._sendThreadControl('archive', target);
  }

  private _sameControlTarget(target: ThreadControlTarget): boolean {
    const current = this.controlTarget;
    return (
      current !== null &&
      current.threadId === target.threadId &&
      current.generation === target.generation &&
      current.kind === target.kind
    );
  }

  private _hasPendingControl(kind: ThreadControlKind, threadId: string, id: string): boolean {
    for (const pending of this._pendingControls.values()) {
      if (pending.kind !== kind || pending.threadId !== threadId) continue;
      if (id === '' || pending.turnId === id || pending.approvalId === id) return true;
    }
    return false;
  }

  private _sendThreadControl(
    kind: ThreadControlKind,
    target: ThreadControlTarget,
    fields: Readonly<{ turn_id?: string; approval_id?: string; approved?: boolean }> = {},
  ): boolean {
    if (!this._sameControlTarget(target)) return false;
    const requestId = makeRequestId();
    if (!requestId) {
      this._setProblem('request_id_unavailable', 'A secure request ID could not be created.');
      return false;
    }
    const pending: PendingControl = {
      requestId,
      kind,
      threadId: target.threadId,
      generation: target.generation,
      turnId: fields.turn_id ?? '',
      approvalId: fields.approval_id ?? '',
      approved: fields.approved === true,
    };
    const frame: Record<string, unknown> = {
      type: `missioncontrol-${kind}`,
      protocol_version: PROTOCOL_VERSION,
      request_id: requestId,
      thread_id: pending.threadId,
      expected_runtime_generation: pending.generation,
    };
    if (pending.turnId) frame.turn_id = pending.turnId;
    if (pending.approvalId) frame.approval_id = pending.approvalId;
    if (kind === 'approval') frame.approved = pending.approved;
    this._pendingControls.set(requestId, pending);
    if (!this._socket?.missionControl(frame)) {
      this._pendingControls.delete(requestId);
      const state = this._states.get(pending.threadId);
      if (state) {
        this._setThreadFault(
          state,
          `${kind}_transmit_failed`,
          `The scoped ${kind} request could not be transmitted. Nothing changed.`,
        );
      } else {
        this._setProblem(`${kind}_transmit_failed`, `The scoped ${kind} request could not be transmitted.`);
      }
      return false;
    }
    this._notify();
    return true;
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

  private _threadLabel(threadId: string): string {
    const thread = this._states.get(threadId)?.thread ?? this._threads.find((item) => item.id === threadId);
    if (!thread) return `Context · ${shortUuid(threadId)}`;
    if (thread.kind === 'lobby') return 'Lobby';
    return `${thread.displayName} · ${shortUuid(thread.workspaceUuid || thread.id)}`;
  }

  /**
   * Read-only detail is allowed only after this socket has received a valid
   * live catalog record for the exact attention thread/generation. It remains
   * independent of browser selection, drafts, and thread subscriptions.
   */
  private _detailUnavailable(record: AttentionRecord): string {
    if (!this._capabilities.detailReadOnly) {
      return 'This server does not advertise read-only context detail.';
    }
    if (!this._socket?.connected) {
      return 'Detail is unavailable while this browser reconnects.';
    }
    if (!this._catalogReady) {
      return 'Detail is unavailable until this connection confirms the live context catalog.';
    }
    const known = this._threads.find((thread) => thread.id === record.threadId);
    if (
      !known ||
      known.runtimeGeneration !== record.runtimeGeneration ||
      !uuidValue(known.runtimeSessionId)
    ) {
      return 'This attention refers to a context generation that is no longer available for read-only detail.';
    }
    return '';
  }

  private _hasPendingDetail(attentionId: string): boolean {
    for (const pending of this._pendingDetails.values()) {
      if (pending.attentionId === attentionId) return true;
    }
    return false;
  }

  private _hasPendingAttentionAck(attentionId: string): boolean {
    for (const pendingId of this._pendingAttentionAcks.values()) {
      if (pendingId === attentionId) return true;
    }
    return false;
  }

  /** No polling: refresh durable catalog facts after an attention-producing event only. */
  private _refreshCatalogMetadataForEvent(envelope: ThreadedCosEvent): void {
    const event = stringValue(envelope.event.ev);
    if (
      event === 'turn_start' ||
      event === 'turn_end' ||
      event === 'cancelled' ||
      event === 'turn_cancelled' ||
      event === 'error' ||
      event === 'approval_request'
    ) {
      this._requestAttention();
    }
    if (event === 'turn_end' || event === 'cancelled' || event === 'turn_cancelled') {
      this._requestSummaries();
    }
  }

  private _unreadThreadIds = new Set<string>();

  private _beginNegotiation(): void {
    const socket = this._socket;
    if (!socket || !socket.connected || !this._wanted) return;
    this._clearCapabilityTimer();
    this._capabilityRequestId = '';
    this._listRequestId = '';
    this._catalogReady = false;
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
      case 'summaries':
        if (requestId === this._summariesRequestId) this._handleSummaries(frame);
        break;
      case 'attention':
        if (requestId === this._attentionRequestId) this._handleAttention(frame);
        break;
      case 'attention-ack':
        if (this._pendingAttentionAcks.has(requestId)) this._handleAttentionAck(frame, requestId);
        break;
      case 'detail':
        if (this._pendingDetails.has(requestId)) this._handleDetail(frame, requestId);
        break;
      case 'migration-preview':
        if (requestId === this._migrationPreviewRequestId) this._handleMigrationPreview(frame);
        break;
      case 'cancel':
      case 'approval':
      case 'reset':
      case 'archive':
        if (this._pendingControls.has(requestId)) this._handleControlResult(frame, requestId);
        break;
    }
  }

  private _handleCapabilities(frame: Record<string, unknown>): void {
    this._clearCapabilityTimer();
    this._capabilityRequestId = '';
    const capabilities = recordValue(frame.capabilities);
    if (frame.ok !== true) {
      this._setProblem(
        stringValue(frame.code) || 'capabilities_unavailable',
        stringValue(frame.error) || 'Text-thread capability was refused by the server.'
      );
      return;
    }
    const enabled =
      frame.enabled === true &&
      capabilities?.text_threads === true;
    if (!enabled) {
      this._enterLegacy();
      return;
    }
    // Voice remains deliberately unavailable in this preview even if a future
    // server advertises it. The scoped mutation controls below are separately
    // capability-gated and never use legacy COS fallbacks.
    this._capabilities = Object.freeze({
      approval: capabilities?.approval === true,
      cancel: capabilities?.cancel === true,
      reset: capabilities?.reset === true,
      archive: capabilities?.archive === true,
      detailReadOnly: capabilities?.detail_read_only === true,
    });
    this._mode = 'threaded';
    this._problem = null;
    this._socket?.setLegacyCosFramesEnabled(false);
    // Explicitly terminate any earlier unscoped subscription before accepting
    // a v2 thread. A selected/threaded request never falls back through it.
    this._socket?.cosSubscribe(false);
    this._requestList();
    // Catalog metadata is explicitly read-only: loading it cannot start a
    // root, change selection, or move the reader to another conversation.
    this._requestAttention();
    this._requestSummaries();
  }

  private _enterLegacy(): void {
    this._clearCapabilityTimer();
    this._capabilities = NO_THREAD_CONTROLS;
    this._catalogReady = false;
    this._mode = 'legacy';
    this._connectionReady = true;
    this._pendingSelection = null;
    this._pendingHistories.clear();
    this._pendingControls.clear();
    this._pendingDetails.clear();
    this._pendingAttentionAcks.clear();
    this._preAckBuffers.clear();
    for (const state of this._states.values()) {
      state.historyRequestId = '';
      state.syncing = false;
    }
    this._listRequestId = '';
    this._attentionRequestId = '';
    this._summariesRequestId = '';
    this._migrationPreviewRequestId = '';
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

  /** Fetch durable read-only attention; no root is selected or started. */
  private _requestAttention(): void {
    const socket = this._socket;
    if (!socket || !socket.connected || !this.threaded || this._attentionRequestId !== '') return;
    const requestId = makeRequestId();
    if (!requestId) {
      this._setProblem('request_id_unavailable', 'A secure request ID could not be created.');
      return;
    }
    this._attentionRequestId = requestId;
    if (
      !socket.missionControl({
        type: 'missioncontrol-attention',
        protocol_version: PROTOCOL_VERSION,
        request_id: requestId,
      })
    ) {
      this._attentionRequestId = '';
      this._setProblem('attention_transmit_failed', 'Queued attention could not be refreshed.');
      return;
    }
  }

  /** Fetch bounded catalog extracts for the Lobby-only provenance display. */
  private _requestSummaries(): void {
    const socket = this._socket;
    if (!socket || !socket.connected || !this.threaded || this._summariesRequestId !== '') return;
    const requestId = makeRequestId();
    if (!requestId) {
      this._setProblem('request_id_unavailable', 'A secure request ID could not be created.');
      return;
    }
    this._summariesRequestId = requestId;
    if (
      !socket.missionControl({
        type: 'missioncontrol-summaries',
        protocol_version: PROTOCOL_VERSION,
        request_id: requestId,
      })
    ) {
      this._summariesRequestId = '';
      this._setProblem('summaries_transmit_failed', 'Completed-work extracts could not be refreshed.');
    }
  }

  private _handleSummaries(frame: Record<string, unknown>): void {
    this._summariesRequestId = '';
    if (frame.ok !== true) {
      this._setProblem('summaries_refused', protocolFailure(frame, 'Completed-work extracts could not be read.'));
      return;
    }
    const raw = frame.summaries === undefined ? [] : frame.summaries;
    if (!Array.isArray(raw)) {
      this._setProblem('invalid_summaries', 'The server returned invalid completed-work extracts.');
      return;
    }
    const summaries: SummaryRecord[] = [];
    const ids = new Set<string>();
    for (const entry of raw) {
      const summary = parseSummary(entry);
      if (!summary || ids.has(summary.id)) {
        this._setProblem('invalid_summaries', 'The server returned invalid completed-work extracts.');
        return;
      }
      ids.add(summary.id);
      summaries.push(summary);
    }
    this._summaries = summaries.sort(
      (left, right) => left.observedAtMs - right.observedAtMs,
    );
    this._notify();
  }

  private _handleAttention(frame: Record<string, unknown>): void {
    this._attentionRequestId = '';
    if (frame.ok !== true) {
      this._setProblem('attention_refused', protocolFailure(frame, 'Queued attention could not be read.'));
      return;
    }
    const raw = frame.attention === undefined ? [] : frame.attention;
    if (!Array.isArray(raw)) {
      this._setProblem('invalid_attention', 'The server returned invalid queued attention.');
      return;
    }
    const attention: AttentionRecord[] = [];
    const ids = new Set<string>();
    for (const entry of raw) {
      const item = parseAttention(entry);
      if (!item || ids.has(item.id)) {
        this._setProblem('invalid_attention', 'The server returned invalid queued attention.');
        return;
      }
      ids.add(item.id);
      attention.push(item);
    }
    this._attention = attention.sort(
      (left, right) => left.observedAtMs - right.observedAtMs,
    );
    this._notify();
  }

  private _handleAttentionAck(frame: Record<string, unknown>, requestId: string): void {
    const attentionId = this._pendingAttentionAcks.get(requestId);
    this._pendingAttentionAcks.delete(requestId);
    if (!attentionId) return;
    if (frame.ok !== true) {
      this._setProblem(
        'attention_ack_refused',
        protocolFailure(frame, 'The attention acknowledgement was refused. The notice was kept.'),
      );
      return;
    }
    const raw = frame.attention;
    const record =
      Array.isArray(raw) && raw.length === 1 ? parseAttention(raw[0]) : null;
    if (!record || record.id !== attentionId || record.acknowledgedAt === '') {
      this._setProblem(
        'invalid_attention_ack',
        'The server did not confirm this attention acknowledgement. The notice was kept.',
      );
      return;
    }
    this._attention = this._attention.map((item) => (item.id === record.id ? record : item));
    this._notify();
  }

  private _handleDetail(frame: Record<string, unknown>, requestId: string): void {
    const pending = this._pendingDetails.get(requestId);
    this._pendingDetails.delete(requestId);
    if (!pending) return;
    if (frame.ok !== true) {
      this._setProblem(
        'detail_refused',
        protocolFailure(frame, 'The read-only context detail was refused. The conversation was not changed.'),
      );
      return;
    }
    const detail = parseDetailPayload(frame);
    if (
      !detail ||
      detail.thread.id !== pending.threadId ||
      detail.thread.runtimeGeneration !== pending.generation
    ) {
      this._setProblem(
        'invalid_detail',
        'The server returned detail for a different context. The conversation was not changed.',
      );
      return;
    }
    requestViewerDocument({
      title: `Context detail — ${this._threadLabel(pending.threadId)}`,
      subtitle: `generation ${pending.generation}; read-only`,
      text: formatDetailDocument(this._threadLabel(pending.threadId), detail),
    });
    this._notify();
  }

  private _handleMigrationPreview(frame: Record<string, unknown>): void {
    this._migrationPreviewRequestId = '';
    if (frame.ok !== true) {
      this._setProblem(
        'migration_preview_refused',
        protocolFailure(frame, 'The metadata-only migration preview was refused. Nothing changed.'),
      );
      return;
    }
    // The current backend carries this read-only payload in capabilities.
    const preview = parseMigrationPreview(frame.capabilities);
    if (!preview) {
      this._setProblem(
        'invalid_migration_preview',
        'The server returned an invalid metadata-only migration preview. Nothing changed.',
      );
      return;
    }
    requestViewerDocument({
      title: 'Catalog migration / rollback preview',
      subtitle: 'Preview only; no history moved',
      text: formatMigrationPreview(preview),
    });
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
    this._catalogReady = true;
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
    // Runtime.Submit durably records the pending attention before this receipt.
    // Refresh only metadata; this never changes the selected conversation.
    this._requestAttention();
    this._notify();
  }

  private _handleControlResult(frame: Record<string, unknown>, requestId: string): void {
    const pending = this._pendingControls.get(requestId);
    this._pendingControls.delete(requestId);
    if (!pending) return;
    const state = this._states.get(pending.threadId);
    if (!state || state.thread.runtimeGeneration !== pending.generation) {
      this._notify();
      return;
    }
    if (frame.ok !== true) {
      this._setThreadFault(
        state,
        `${pending.kind}_refused`,
        protocolFailure(frame, `The scoped ${pending.kind} request was refused. Nothing changed.`),
      );
      return;
    }

    if (pending.kind === 'approval') {
      state.store.settleThreadApproval(pending.approvalId, pending.approved);
      this._notify();
      return;
    }
    if (pending.kind === 'reset') {
      const replacement = parseRuntimeThread(frame.thread);
      if (
        !replacement ||
        replacement.id !== pending.threadId ||
        replacement.runtimeGeneration <= pending.generation
      ) {
        this._setThreadFault(
          state,
          'invalid_reset',
          'The server did not confirm a new runtime generation. The existing context was kept.',
        );
        return;
      }
      this._completeReset(state, replacement);
      return;
    }
    if (pending.kind === 'archive') {
      const archived = parseCatalogThread(frame.thread);
      if (!archived || archived.id !== pending.threadId) {
        this._setThreadFault(
          state,
          'invalid_archive',
          'The server did not confirm the archived context identity. The existing context was kept.',
        );
        return;
      }
      state.thread = { ...state.thread, ...archived };
      state.archived = true;
      state.runtimeStale = true;
      state.draftRef = '';
      state.rootState = null;
      if (this._lastExplicitThreadId === pending.threadId) {
        this._lastExplicitThreadId = '';
        this._persistState();
      }
      this._setThreadFault(
        state,
        'archived',
        'This context was archived. Select a live context before sending.',
      );
      return;
    }
    // cancel acknowledges dispatch only; the exact terminal event remains the
    // authoritative turn state and is intentionally not manufactured here.
    this._notify();
  }

  private _completeReset(state: ThreadState, replacement: CatalogThread): void {
    const oldThreadId = state.thread.id;
    const oldGeneration = state.thread.runtimeGeneration;
    state.thread = replacement;
    state.draftRef = '';
    state.runtimeStale = true;
    state.archived = false;
    state.syncing = false;
    state.repairAttempted = false;
    state.lastSequence = null;
    state.seenEventIds.clear();
    state.rootState = null;
    this._preAckBuffers.delete(preAckKey(oldThreadId, oldGeneration));
    this._drafts.delete(oldThreadId);
    if (this._lastExplicitThreadId === oldThreadId) this._lastExplicitThreadId = '';
    this._threads = this._threads.map((thread) =>
      thread.id === replacement.id ? { ...thread, ...replacement } : thread,
    );
    this._persistState();
    // Preserve the old authoritative transcript as the visible immutable
    // reference until a person explicitly selects the new generation.
    this._setThreadFault(
      state,
      'reset_complete',
      'This context was reset. Select Talk here again to open the new generation.',
    );
  }

  private _handleHistory(frame: Record<string, unknown>, requestId: string): void {
    const pending = this._pendingHistories.get(requestId);
    this._pendingHistories.delete(requestId);
    if (!pending) return;
    const state = this._states.get(pending.threadId);
    if (state?.historyRequestId === requestId) state.historyRequestId = '';
    if (frame.ok !== true) {
      if (state) {
        // The request is no longer pending. Keep history/drafts intact and
        // surface the refusal; another incoming event must not spin a repair
        // loop while this snapshot remains unavailable.
        state.syncing = false;
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
        state.syncing = false;
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
          this._startAuthoritativeRepair(
            state,
            'pre_ack_buffer_overflow',
            'Too many early thread updates arrived. An authoritative history repair is required.',
          );
        }
      } else if (buffer.overflow) {
        if (state) {
          this._startAuthoritativeRepair(
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
    state.archived = false;
    state.rootState = snapshot.rootState;
    if (source === 'selection') state.repairAttempted = false;
    const snapshotState: ThreadedSnapshotState = {
      coveredTurnIds: snapshot.coveredTurnIds,
      replaySuppressedTurnIds: snapshot.replaySuppressedTurnIds,
      activeTurnId: snapshot.activeTurnId,
      pendingTurnIds: snapshot.pendingTurnIds,
    };
    if (source === 'selection') {
      state.store.adoptThreadSnapshot(
        snapshot.thread.runtimeSessionId,
        snapshot.history,
        snapshotState,
      );
    } else {
      state.store.adoptThreadHistory(snapshot.history, snapshotState);
    }

    const replayGap = this._applySnapshotReplay(state, snapshot, buffer);
    const needsRepair = forceRepair || buffer.overflow || snapshot.gap || replayGap;
    if (!needsRepair) {
      state.repairAttempted = false;
      return;
    }
    const reason = snapshot.gap
      ? 'A bounded thread event gap was reported. Rechecking authoritative history once.'
      : forceRepair || buffer.overflow
        ? 'Early thread updates exceeded the browser buffer. Rechecking authoritative history once.'
        : 'Thread updates crossed the snapshot boundary out of order. Rechecking authoritative history once.';
    this._startAuthoritativeRepair(state, 'snapshot_gap', reason);
  }

  /**
   * Fold both sides of the ordered snapshot cut. `replay_events` are at or
   * below the inclusive barrier and may be necessary for active/queued turns
   * absent from canonical history. Buffered events above the barrier are
   * admitted only in contiguous sequence order. Covered ids suppress rendering
   * in CosStore but still enter this immutable sequence ledger.
   */
  private _applySnapshotReplay(
    state: ThreadState,
    snapshot: SnapshotPayload,
    buffer: PreAckBuffer,
  ): boolean {
    const bySequence = new Map<number, ThreadedCosEvent>();
    const sequenceById = new Map<string, number>();
    let invalid = false;
    const add = (event: ThreadedCosEvent): void => {
      const seenSequence = sequenceById.get(event.event_id);
      const existing = bySequence.get(event.thread_seq);
      if (
        (seenSequence !== undefined && seenSequence !== event.thread_seq) ||
        (existing !== undefined && existing.event_id !== event.event_id)
      ) {
        invalid = true;
        return;
      }
      sequenceById.set(event.event_id, event.thread_seq);
      if (!existing) bySequence.set(event.thread_seq, event);
    };
    for (const event of snapshot.replayEvents) add(event);
    for (const item of buffer.events) add(item.envelope);
    if (invalid) {
      this._restoreBufferedTail(state, buffer);
      return true;
    }

    const events = [...bySequence.values()].sort((left, right) => left.thread_seq - right.thread_seq);
    for (const event of events) {
      if (event.thread_seq > snapshot.watermark) break;
      this._recordSnapshotEvent(state, event);
    }

    let expected = snapshot.watermark + 1;
    for (const event of events) {
      if (event.thread_seq <= snapshot.watermark) continue;
      if (event.thread_seq !== expected || state.seenEventIds.has(event.event_id)) {
        this._restoreBufferedTail(state, buffer);
        return true;
      }
      this._applyEvent(state, event);
      expected++;
    }
    return false;
  }

  /** Record a pre-barrier event without moving the authoritative watermark. */
  private _recordSnapshotEvent(state: ThreadState, envelope: ThreadedCosEvent): void {
    const seenSequence = state.seenEventIds.get(envelope.event_id);
    if (seenSequence === envelope.thread_seq) return;
    if (seenSequence !== undefined) return;
    state.store.receiveThreadEvent(envelope);
    this._rememberEvent(state, envelope.event_id, envelope.thread_seq);
    this._markUnread(envelope.thread_id);
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
      this._startAuthoritativeRepair(
        state,
        'missing_snapshot_fence',
        'Thread update arrived without an authoritative snapshot fence. Reconciling history.',
      );
      return;
    }
    const seenSequence = state.seenEventIds.get(envelope.event_id);
    if (seenSequence !== undefined) {
      if (seenSequence !== envelope.thread_seq) {
        this._startAuthoritativeRepair(
          state,
          'thread_event_identity_conflict',
          'A thread event identity changed sequence. Reconciling authoritative history.',
        );
      }
      return;
    }
    if (envelope.thread_seq <= last) {
      // It predates the authoritative fence. Do not re-render an old delta.
      return;
    }
    if (envelope.thread_seq !== last + 1) {
      const buffer = this._bufferPreAck(envelope);
      this._startAuthoritativeRepair(
        state,
        buffer?.overflow || buffer === null
          ? 'pre_ack_buffer_overflow'
          : 'thread_sequence_gap',
        buffer?.overflow || buffer === null
          ? 'Thread update buffering overflowed. Reconciling authoritative history.'
          : 'Thread updates arrived out of order. Reconciling authoritative history.',
      );
      return;
    }
    this._applyEvent(state, envelope);
  }

  private _applyEvent(state: ThreadState, envelope: ThreadedCosEvent): void {
    state.store.receiveThreadEvent(envelope);
    state.lastSequence = envelope.thread_seq;
    this._rememberEvent(state, envelope.event_id, envelope.thread_seq);
    this._markUnread(envelope.thread_id);
    this._refreshCatalogMetadataForEvent(envelope);
  }

  /**
   * A reported journal/delivery gap gets one authoritative history attempt per
   * generation. If that cut still reports a gap, leave the visible warning in
   * place rather than recursively issuing history requests forever.
   */
  private _startAuthoritativeRepair(state: ThreadState, code: string, message: string): void {
    if (state.historyRequestId !== '') return;
    if (state.repairAttempted) {
      state.syncing = false;
      this._setThreadFault(state, code, message);
      return;
    }
    state.repairAttempted = true;
    state.syncing = true;
    this._setThreadFault(state, code, message);
    this._requestHistory(state);
  }

  private _requestHistory(state: ThreadState): void {
    if (state.historyRequestId) return;
    if (!this._socket?.connected) {
      state.syncing = false;
      this._setThreadFault(
        state,
        'history_transmit_failed',
        'An authoritative history repair could not be requested while disconnected.',
      );
      return;
    }
    const requestId = makeRequestId();
    if (!requestId) {
      state.syncing = false;
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
      state.syncing = false;
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
      repairAttempted: false,
      archived: false,
      rootState: null,
    };
    store.subscribe(() => this._notify());
    this._states.set(thread.id, state);
    return state;
  }

  private _rememberEvent(state: ThreadState, eventId: string, sequence: number): void {
    state.seenEventIds.set(eventId, sequence);
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