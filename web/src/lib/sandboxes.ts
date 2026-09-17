// Direct Azure Sandbox lifecycle client. This module deliberately models only
// the safe server view: opaque muxterm handles and lifecycle state. Provider
// identities, endpoints, labels, signers, scopes, and credentials have no
// representation in browser code.
import { apiPath } from './base-path.js';

export type SandboxAvailability = 'unconfigured' | 'disabled' | 'kill-switch' | 'ready';
export type SandboxOperationState = 'pending' | 'accepted' | 'succeeded' | 'failed' | 'ambiguous';
export type SandboxReconcileState = 'clean' | 'reconcile-needed' | 'quarantined';
export type SandboxAction = 'stop' | 'resume' | 'destroy' | 'reconcile' | 'attach';
export type SandboxPresentationState = 'unconfigured' | 'disabled' | 'kill-switch' | 'lifecycle-only';
export type SandboxPresentationObservedState =
  | 'accepted'
  | 'creating'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'suspended'
  | 'idle'
  | 'destroying'
  | 'destroyed'
  | 'unknown';

export interface SandboxView {
  handle: string;
  profile: string;
  generation: number;
  request_id: string;
  operation: string;
  operation_state: SandboxOperationState;
  expected_generation: number;
  desired_state: string;
  observed_state: string;
  reconcile_state: SandboxReconcileState;
  attach: string;
}

export interface SandboxCollection {
  availability: { state: SandboxAvailability; detail: string };
  sandboxes: SandboxView[];
}

export interface SandboxPresentationRecord {
  handle: string;
  profile: string;
  observed_state: SandboxPresentationObservedState;
  generation: number;
}

export interface SandboxPresentation {
  configuration_state: SandboxPresentationState;
  attach_availability: 'unavailable';
  reason_code: string;
  reason: string;
  profiles: string[];
  records: SandboxPresentationRecord[];
}

export const EMPTY_SANDBOXES: SandboxCollection = {
  availability: { state: 'unconfigured', detail: 'Azure Sandboxes are not configured on this muxterm.' },
  sandboxes: [],
};

function stringField(record: Record<string, unknown>, name: string): string {
  return typeof record[name] === 'string' ? record[name] : '';
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(record).every((key) => expected.has(key)) &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function presentationObservedState(value: unknown): SandboxPresentationObservedState | null {
  switch (value) {
    case 'accepted':
    case 'creating':
    case 'running':
    case 'stopping':
    case 'stopped':
    case 'suspended':
    case 'idle':
    case 'destroying':
    case 'destroyed':
    case 'unknown':
      return value;
    default:
      return null;
  }
}

function view(raw: unknown): SandboxView | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const operationState = stringField(r, 'operation_state');
  const reconcileState = stringField(r, 'reconcile_state');
  if (!stringField(r, 'handle') ||
      !['pending', 'accepted', 'succeeded', 'failed', 'ambiguous'].includes(operationState) ||
      !['clean', 'reconcile-needed', 'quarantined'].includes(reconcileState)) return null;
  return {
    handle: stringField(r, 'handle'),
    profile: stringField(r, 'profile'),
    generation: typeof r['generation'] === 'number' ? r['generation'] : 0,
    request_id: stringField(r, 'request_id'),
    operation: stringField(r, 'operation'),
    operation_state: operationState as SandboxOperationState,
    expected_generation: typeof r['expected_generation'] === 'number' ? r['expected_generation'] : 0,
    desired_state: stringField(r, 'desired_state'),
    observed_state: stringField(r, 'observed_state'),
    reconcile_state: reconcileState as SandboxReconcileState,
    attach: stringField(r, 'attach'),
  };
}

function parseCollection(raw: unknown): SandboxCollection {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_SANDBOXES;
  const r = raw as Record<string, unknown>;
  const availability = r['availability'];
  if (availability === null || typeof availability !== 'object' || Array.isArray(availability)) return EMPTY_SANDBOXES;
  const a = availability as Record<string, unknown>;
  const state = stringField(a, 'state');
  if (!['unconfigured', 'disabled', 'kill-switch', 'ready'].includes(state)) return EMPTY_SANDBOXES;
  return {
    availability: { state: state as SandboxAvailability, detail: stringField(a, 'detail') },
    sandboxes: Array.isArray(r['sandboxes']) ? r['sandboxes'].map(view).filter((v): v is SandboxView => v !== null) : [],
  };
}

function parsePresentationRecord(raw: unknown): SandboxPresentationRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Sandbox presentation record was not an object.');
  }
  const r = raw as Record<string, unknown>;
  if (!exactKeys(r, ['handle', 'profile', 'observed_state', 'generation'])) {
    throw new Error('Sandbox presentation record contained an unsupported field.');
  }
  const generation = finiteInteger(r['generation']);
  const handle = stringField(r, 'handle');
  const profile = stringField(r, 'profile');
  const observedState = presentationObservedState(r['observed_state']);
  if (!handle || !profile || observedState === null || generation === null) {
    throw new Error('Sandbox presentation record was incomplete.');
  }
  return { handle, profile, observed_state: observedState, generation };
}

function isStrictlySortedStringList(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index++) {
    if (values[index - 1] >= values[index]) return false;
  }
  return true;
}

function isStrictlySortedPresentationRecords(records: readonly SandboxPresentationRecord[]): boolean {
  for (let index = 1; index < records.length; index++) {
    const previous = records[index - 1];
    const current = records[index];
    if (previous.handle > current.handle ||
        (previous.handle === current.handle && previous.profile >= current.profile)) return false;
  }
  return true;
}

function parsePresentation(raw: unknown): SandboxPresentation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Sandbox presentation was not an object.');
  }
  const r = raw as Record<string, unknown>;
  if (!exactKeys(r, [
    'configuration_state',
    'attach_availability',
    'reason_code',
    'reason',
    'profiles',
    'records',
  ])) {
    throw new Error('Sandbox presentation contained an unsupported field.');
  }
  const state = stringField(r, 'configuration_state');
  const attach = stringField(r, 'attach_availability');
  const reasonCode = stringField(r, 'reason_code');
  const reason = stringField(r, 'reason');
  if (!['unconfigured', 'disabled', 'kill-switch', 'lifecycle-only'].includes(state) ||
      attach !== 'unavailable' || !reasonCode || !reason ||
      !Array.isArray(r['profiles']) || !Array.isArray(r['records'])) {
    throw new Error('Sandbox presentation was incomplete.');
  }
  const profiles = r['profiles'].map((profile) => {
    if (typeof profile !== 'string' || profile === '') {
      throw new Error('Sandbox presentation profile list was invalid.');
    }
    return profile;
  });
  if (!isStrictlySortedStringList(profiles)) {
    throw new Error('Sandbox presentation profile list was not uniquely sorted.');
  }
  const records = r['records'].map(parsePresentationRecord);
  if (!isStrictlySortedPresentationRecords(records)) {
    throw new Error('Sandbox presentation records were not sorted.');
  }
  return {
    configuration_state: state as SandboxPresentationState,
    attach_availability: 'unavailable',
    reason_code: reasonCode,
    reason,
    profiles,
    records,
  };
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePresentation(
  left: SandboxPresentation | null,
  right: SandboxPresentation,
): boolean {
  return left !== null &&
    left.configuration_state === right.configuration_state &&
    left.attach_availability === right.attach_availability &&
    left.reason_code === right.reason_code &&
    left.reason === right.reason &&
    sameStringList(left.profiles, right.profiles) &&
    left.records.length === right.records.length &&
    left.records.every((record, index) => {
      const next = right.records[index];
      return record.handle === next.handle &&
        record.profile === next.profile &&
        record.observed_state === next.observed_state &&
        record.generation === next.generation;
    });
}

function sameSandboxError(left: unknown | null, right: unknown): boolean {
  if (left === null) return false;
  if (left instanceof SandboxRequestError && right instanceof SandboxRequestError) {
    return left.status === right.status && left.code === right.code && left.message === right.message;
  }
  const leftMessage = left instanceof Error ? left.message : String(left);
  const rightMessage = right instanceof Error ? right.message : String(right);
  return leftMessage === rightMessage;
}

export class SandboxRequestError extends Error {
  // hasResponse distinguishes an HTTP rejection, whose durable outcome the
  // server could report, from fetch/network failure where retrying the exact
  // request ID remains the only safe option.
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly hasResponse = true,
  ) {
    super(message);
  }
}

async function requestError(response: Response): Promise<SandboxRequestError> {
  const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
  const code = stringField(raw, 'error');
  const message = stringField(raw, 'error_description') || code || `Sandbox request failed (HTTP ${response.status}).`;
  return new SandboxRequestError(message, code, response.status);
}

export function sandboxAuthRequired(error: unknown): boolean {
  return error instanceof SandboxRequestError &&
    error.status === 401 &&
    error.code === 'sandbox_auth_required';
}

export function sandboxUnavailable(error: unknown): boolean {
  return error instanceof SandboxRequestError &&
    error.status === 503 &&
    error.code === 'sandbox_auth_disabled';
}

export function sandboxPresentationUnavailable(error: unknown): boolean {
  return error instanceof SandboxRequestError &&
    error.status === 503 &&
    error.code === 'sandbox_presentation_unavailable';
}

export async function fetchSandboxes(): Promise<SandboxCollection> {
  const response = await fetch(apiPath('/api/sandboxes'), { cache: 'no-store' });
  if (!response.ok) throw await requestError(response);
  return parseCollection(await response.json());
}

export async function fetchSandboxPresentation(): Promise<SandboxPresentation> {
  const response = await fetch(apiPath('/api/sandboxes/presentation'), { cache: 'no-store' });
  if (!response.ok) throw await requestError(response);
  return parsePresentation(await response.json());
}

export interface SandboxPresentationSnapshot {
  data: SandboxPresentation | null;
  loading: boolean;
  error: unknown | null;
}

type PresentationListener = (snapshot: SandboxPresentationSnapshot) => void;

class SandboxPresentationStore {
  private _snapshot: SandboxPresentationSnapshot = {
    data: null,
    loading: false,
    error: null,
  };
  private _listeners = new Set<PresentationListener>();
  private _pollingConsumers = 0;
  private _timer: number | null = null;
  private _inFlight: Promise<void> | null = null;
  private _refreshQueued = false;
  private _onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') {
      this._stopPolling();
      return;
    }
    this._syncPolling();
    if (this._pollingConsumers > 0 && this._shouldPoll()) void this.refresh();
  };

  get snapshot(): SandboxPresentationSnapshot {
    return this._snapshot;
  }

  subscribe(listener: PresentationListener): () => void {
    this._listeners.add(listener);
    listener(this._snapshot);
    if (this._listeners.size === 1) {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
    return () => {
      this._listeners.delete(listener);
      if (this._listeners.size === 0) {
        this._refreshQueued = false;
        this._stopPolling();
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
      }
    };
  }

  startPolling(): () => void {
    this._pollingConsumers++;
    this._syncPolling();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this._pollingConsumers--;
      this._syncPolling();
    };
  }

  refresh(): Promise<void> {
    if (this._inFlight) {
      this._refreshQueued ||= this._listeners.size > 0;
      return this._inFlight;
    }
    const request = this._refreshUntilCurrent();
    this._inFlight = request;
    request.then(
      () => { if (this._inFlight === request) this._inFlight = null; },
      () => { if (this._inFlight === request) this._inFlight = null; },
    );
    return request;
  }

  private async _refreshUntilCurrent(): Promise<void> {
    do {
      this._refreshQueued = false;
      await this._refreshOnce();
    } while (this._refreshQueued && this._listeners.size > 0);
  }

  private async _refreshOnce(): Promise<void> {
    if (this._snapshot.data === null && !this._snapshot.loading) {
      this._snapshot = { ...this._snapshot, loading: true, error: null };
      this._notify();
    }
    try {
      const data = await fetchSandboxPresentation();
      if (!samePresentation(this._snapshot.data, data) ||
          this._snapshot.loading || this._snapshot.error !== null) {
        this._snapshot = { data, loading: false, error: null };
        this._notify();
      }
    } catch (error) {
      // A failed refresh must never leave owner-only profile names or records
      // visible from a prior successful response. Clear protected presentation
      // data even when the same error repeats; notify whenever that clear or
      // the settled error state changes.
      const notify = this._snapshot.data !== null || this._snapshot.loading ||
        !sameSandboxError(this._snapshot.error, error);
      this._snapshot = { data: null, loading: false, error };
      if (notify) this._notify();
    }
    this._syncPolling();
  }

  private _shouldPoll(): boolean {
    const state = this._snapshot.data?.configuration_state;
    return !sandboxAuthRequired(this._snapshot.error) &&
      !sandboxUnavailable(this._snapshot.error) &&
      !sandboxPresentationUnavailable(this._snapshot.error) &&
      state !== 'unconfigured' && state !== 'disabled';
  }

  private _syncPolling(): void {
    if (this._listeners.size === 0 || this._pollingConsumers === 0 || !this._shouldPoll()) {
      this._stopPolling();
      return;
    }
    this._startPolling();
  }

  private _startPolling(): void {
    if (this._timer !== null || this._listeners.size === 0 || this._pollingConsumers === 0 ||
        document.visibilityState !== 'visible' || !this._shouldPoll()) return;
    this._timer = window.setInterval(() => {
      if (!this._inFlight) void this.refresh();
    }, 30_000);
  }

  private _stopPolling(): void {
    if (this._timer === null) return;
    window.clearInterval(this._timer);
    this._timer = null;
  }

  private _notify(): void {
    for (const listener of this._listeners) listener(this._snapshot);
  }
}

export const sandboxPresentationStore = new SandboxPresentationStore();

export async function createSandbox(profile: string, requestID: string): Promise<SandboxView> {
  return mutate('/api/sandboxes', requestID, { profile });
}

export async function sandboxAction(action: SandboxAction, item: SandboxView, requestID: string): Promise<SandboxView> {
  const body: Record<string, unknown> = { generation: item.generation };
  if (action === 'destroy') body['confirm_handle'] = item.handle;
  return mutate(`/api/sandboxes/${encodeURIComponent(item.handle)}/${action}`, requestID, body);
}

async function mutate(path: string, requestID: string, body: Record<string, unknown>): Promise<SandboxView> {
  const response = await fetch(apiPath(path), {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestID },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await requestError(response);
  const raw = await response.json() as Record<string, unknown>;
  const item = view(raw['sandbox']);
  if (!item) throw new Error('Sandbox response was incomplete.');
  return item;
}