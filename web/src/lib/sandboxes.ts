// Direct Azure Sandbox lifecycle client. This module deliberately models only
// the safe server view: opaque muxterm handles and lifecycle state. Provider
// identities, endpoints, labels, signers, scopes, and credentials have no
// representation in browser code.
import { apiPath } from './base-path.js';

export type SandboxAvailability = 'unconfigured' | 'disabled' | 'kill-switch' | 'ready';
export type SandboxOperationState = 'pending' | 'accepted' | 'succeeded' | 'failed' | 'ambiguous';
export type SandboxReconcileState = 'clean' | 'reconcile-needed' | 'quarantined';
export type SandboxAction = 'stop' | 'resume' | 'destroy' | 'reconcile' | 'attach';

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

export const EMPTY_SANDBOXES: SandboxCollection = {
  availability: { state: 'unconfigured', detail: 'Azure Sandboxes are not configured on this muxterm.' },
  sandboxes: [],
};

function stringField(record: Record<string, unknown>, name: string): string {
  return typeof record[name] === 'string' ? record[name] : '';
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
  return error instanceof SandboxRequestError && error.code === 'sandbox_auth_required';
}

export async function fetchSandboxes(): Promise<SandboxCollection> {
  const response = await fetch(apiPath('/api/sandboxes'), { cache: 'no-store' });
  if (!response.ok) throw await requestError(response);
  return parseCollection(await response.json());
}

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