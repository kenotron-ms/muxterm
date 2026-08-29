import {
  SessiondRecoveryMaxCapabilities,
  SessiondRecoveryMaxCapabilityBytes,
  SessiondRecoveryMaxSelectionCandidates,
  SessiondRecoveryType,
  SessiondType,
  type SessiondActivePanePersistenceRequest,
  type SessiondActivePanePersistenceResult,
  type SessiondBrowserRecoveryEvent,
  type SessiondBrowserRecoveryRequest,
  type SessiondPaneRecoveryInfo,
  type SessiondPaneRecoveryTransition,
  type SessiondProtocolHello,
  type SessiondProtocolHelloResult,
  type SessiondRecoveryCapability,
  type SessiondRecoveryDetailCode,
  type SessiondRecoveryPaneRef,
  type SessiondRecoverySelectionCandidate,
  type SessiondRecoveryStrategyLabel,
  type SessiondRecoverySelectRequest,
  type SessiondRecoverySelectResult,
  type SessiondRecoveryRetryRequest,
  type SessiondRecoveryRetryResult,
  type SessiondRecoveryReplacementOutcome,
} from './types';

/**
 * The browser recovery contract is intentionally a small, independently
 * validated vocabulary. Nothing outside this module turns untrusted recovery
 * JSON into typed recovery state or an outbound recovery intent.
 */
export const RECOVERY_SCHEMA_VERSION = 1;

export const RECOVERY_CAPABILITIES = Object.freeze([
  'pane-recovery-projection',
  'recovery-retry',
  'recovery-select',
  'active-pane-persistence',
] as const satisfies readonly SessiondRecoveryCapability[]);

const MAX_RECOVERY_TEXT_BYTES = 32_768;
const MAX_WORKSPACE_ID_BYTES = 128;
const MAX_CANDIDATE_HANDLE_BYTES = 64;
const CANDIDATE_HANDLE_DECODED_BYTES = 32;
const MAX_ORDINARY_NESTING = 64;

const STRATEGY_LABELS = new Set<SessiondRecoveryStrategyLabel>([
  'Amplifier',
  'Claude Code',
  'OpenCode',
  'Codex',
]);

const DETAIL_CODES = new Set<SessiondRecoveryDetailCode>([
  'none',
  'capture-missing',
  'capture-invalid',
  'capture-stale',
  'capture-conflicting',
  'capture-ambiguous',
  'working-directory-invalid',
  'strategy-unsupported',
  'schema-incompatible',
  'lifecycle-unavailable',
  'lifecycle-expired',
  'lifecycle-malformed',
  'lifecycle-zero',
  'lifecycle-unknown',
  'lifecycle-replayed',
  'lifecycle-stale',
  'lifecycle-cross-pane',
  'lifecycle-cross-strategy',
  'lifecycle-conflicting',
  'launch-rejected',
  'launch-failed',
  'observed-identity-mismatch',
  'readiness-timeout',
  'replacement-deferred',
  'replacement-failed',
  'replacement-plan-invalid',
  'active-pane-invalid',
  'candidate-invalid',
]);

const KNOWN_CAPABILITIES = new Set<SessiondRecoveryCapability>(RECOVERY_CAPABILITIES);

const RECOVERY_SENSITIVE_TYPE_PREFIXES = [
  'recovery',
  'pane-recovery',
  'protocol-hello',
  'set-active-pane',
  'lifecycle',
  'replacement',
] as const;

/**
 * These fields either contain a browser-safe recovery envelope or are values
 * that belong exclusively to one. They are removed from ordinary envelopes
 * unless a composition/pane projection has been independently reconstructed.
 */
const RECOVERY_RELATED_FIELDS = new Set<string>([
  'recovery',
  'recoveryTransition',
  'recoveryRetry',
  'recoveryRetryResult',
  'recoverySelect',
  'recoverySelectResult',
  'protocolHello',
  'protocolHelloResult',
  'replacementOutcome',
  'activePanePersistence',
  'activePanePersistenceResult',
  'candidateHandle',
  'strategyLabel',
  'detailCode',
  'historyBoundary',
  'canRetry',
  'canSelect',
  'selectionCandidates',
]);

/**
 * Owner-local names are rejected only inside a dedicated recovery envelope or
 * an explicitly located recovery payload. Ordinary protocols are free to use
 * names such as "launch" without being mistaken for recovery authority.
 */
const PRIVILEGED_RECOVERY_FIELDS = new Set<string>([
  'privilegedRecovery',
  'lifecycleLeaseDelivery',
  'lifecycleCapture',
  'lifecycleOutcome',
  'replacementPlan',
  'replacementResult',
  'replacementCommit',
  'binding',
  'sessionId',
  'workingDirectory',
  'cwd',
  'executable',
  'argv',
  'environmentDelta',
  'generation',
  'rootProcessGeneration',
  'captureEpoch',
  'candidateGeneration',
  'strategyId',
  'fence',
  'capability',
  'planId',
  'expiresAt',
  'issuedAt',
  'callback',
  'evidence',
  'launch',
  'rawError',
  'integrationId',
  'namespace',
  'ownership',
  'userConfigPreservation',
]);

type UnknownRecord = Record<string, unknown>;

export type RecoveryWireEvent = SessiondBrowserRecoveryEvent & {
  readonly cid?: number;
};

export type RecoveryInboundClassification =
  | { readonly kind: 'recovery'; readonly event: RecoveryWireEvent }
  | { readonly kind: 'ordinary'; readonly message: Record<string, unknown> }
  | { readonly kind: 'reject' };

type RecoveryRequestWithCID =
  | {
      type: typeof SessiondRecoveryType.RecoveryRetry;
      cid: number;
      recoveryRetry: SessiondRecoveryRetryRequest;
    }
  | {
      type: typeof SessiondRecoveryType.RecoverySelect;
      cid: number;
      recoverySelect: SessiondRecoverySelectRequest;
    }
  | {
      type: typeof SessiondRecoveryType.SetActivePane;
      cid: number;
      activePanePersistence: SessiondActivePanePersistenceRequest;
    };

const REJECTED: RecoveryInboundClassification = { kind: 'reject' };

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
  }
  return true;
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is UnknownRecord {
  if (!isPlainObject(value)) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length) return false;
  for (const key of actual) {
    if (typeof key !== 'string' || !expected.includes(key)) return false;
  }
  return expected.every((key) => hasOwn(value, key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPaneID(value: unknown): value is number {
  return isPositiveSafeInteger(value) && value <= 0xffff_ffff;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBoundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    utf8ByteLength(value) <= maximum &&
    !/[\p{Cc}]/u.test(value)
  );
}

function parseWorkspaceID(value: unknown): string | null {
  if (!isBoundedText(value, MAX_WORKSPACE_ID_BYTES)) return null;
  if (value.includes('/') || value.includes('\\') || value.includes(':') || value.includes('..')) {
    return null;
  }
  return value;
}

function parsePaneRef(value: unknown): SessiondRecoveryPaneRef | null {
  if (!hasExactKeys(value, ['workspaceId', 'paneId'])) return null;
  const workspaceId = parseWorkspaceID(value.workspaceId);
  if (workspaceId === null || !isPaneID(value.paneId)) return null;
  return { workspaceId, paneId: value.paneId };
}

function parseStrategyLabel(value: unknown): SessiondRecoveryStrategyLabel | null {
  if (typeof value !== 'string' || !STRATEGY_LABELS.has(value as SessiondRecoveryStrategyLabel)) {
    return null;
  }
  return value as SessiondRecoveryStrategyLabel;
}

function parseDetailCode(value: unknown): SessiondRecoveryDetailCode | null {
  if (typeof value !== 'string' || !DETAIL_CODES.has(value as SessiondRecoveryDetailCode)) return null;
  return value as SessiondRecoveryDetailCode;
}

function encodeRawURLBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function parseCandidateHandle(value: unknown): string | null {
  if (!isBoundedText(value, MAX_CANDIDATE_HANDLE_BYTES)) return null;
  if (
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('=') ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return null;
  }

  try {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const decodedBinary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
    if (decodedBinary.length !== CANDIDATE_HANDLE_DECODED_BYTES) return null;
    const decoded = Uint8Array.from(decodedBinary, (char) => char.charCodeAt(0));
    if (!decoded.some((byte) => byte !== 0)) return null;
    return encodeRawURLBase64(decoded) === value ? value : null;
  } catch {
    return null;
  }
}

function parseCandidate(value: unknown): SessiondRecoverySelectionCandidate | null {
  if (!hasExactKeys(value, ['candidateHandle', 'strategyLabel'])) return null;
  const candidateHandle = parseCandidateHandle(value.candidateHandle);
  const strategyLabel = parseStrategyLabel(value.strategyLabel);
  if (candidateHandle === null || strategyLabel === null) return null;
  return { candidateHandle, strategyLabel };
}

function parseCandidates(value: unknown): readonly SessiondRecoverySelectionCandidate[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > SessiondRecoveryMaxSelectionCandidates
  ) {
    return null;
  }

  const candidates: SessiondRecoverySelectionCandidate[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const candidate = parseCandidate(item);
    if (candidate === null || seen.has(candidate.candidateHandle)) return null;
    seen.add(candidate.candidateHandle);
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * Reconstruct one recovery projection from an exact, browser-safe object.
 * This function never returns a field from the input object by reference.
 */
export function validateRecoveryProjection(value: unknown): SessiondPaneRecoveryInfo | null {
  if (!isPlainObject(value) || typeof value.status !== 'string') return null;

  const detailCode = parseDetailCode(value.detailCode);
  const historyBoundary = value.historyBoundary;
  const canRetry = value.canRetry;
  const canSelect = value.canSelect;
  if (
    detailCode === null ||
    typeof historyBoundary !== 'boolean' ||
    typeof canRetry !== 'boolean' ||
    typeof canSelect !== 'boolean'
  ) {
    return null;
  }

  switch (value.status) {
    case 'restoring':
    case 'recovered': {
      if (
        !hasExactKeys(value, [
          'status',
          'strategyLabel',
          'detailCode',
          'historyBoundary',
          'canRetry',
          'canSelect',
        ])
      ) {
        return null;
      }
      const strategyLabel = parseStrategyLabel(value.strategyLabel);
      if (strategyLabel === null || detailCode !== 'none' || canRetry || canSelect) return null;
      return {
        status: value.status,
        strategyLabel,
        detailCode: 'none',
        historyBoundary,
        canRetry: false,
        canSelect: false,
      };
    }

    case 'shell-restored':
      if (
        !hasExactKeys(value, ['status', 'detailCode', 'historyBoundary', 'canRetry', 'canSelect']) ||
        detailCode !== 'none' ||
        canRetry ||
        canSelect
      ) {
        return null;
      }
      return {
        status: 'shell-restored',
        detailCode: 'none',
        historyBoundary,
        canRetry: false,
        canSelect: false,
      };

    case 'selection-needed': {
      if (
        !hasExactKeys(value, [
          'status',
          'detailCode',
          'historyBoundary',
          'canRetry',
          'canSelect',
          'selectionCandidates',
        ]) ||
        detailCode === 'none' ||
        canRetry ||
        !canSelect
      ) {
        return null;
      }
      const selectionCandidates = parseCandidates(value.selectionCandidates);
      if (selectionCandidates === null) return null;
      return {
        status: 'selection-needed',
        detailCode,
        historyBoundary,
        canRetry: false,
        canSelect: true,
        selectionCandidates,
      };
    }

    case 'provisional':
    case 'strategy-failed': {
      if (
        !hasExactKeys(value, [
          'status',
          'strategyLabel',
          'detailCode',
          'historyBoundary',
          'canRetry',
          'canSelect',
        ]) ||
        detailCode === 'none'
      ) {
        return null;
      }
      const strategyLabel = parseStrategyLabel(value.strategyLabel);
      if (strategyLabel === null) return null;
      const isFailure = value.status === 'strategy-failed';
      if (canRetry !== isFailure || canSelect) return null;
      return isFailure
        ? {
            status: 'strategy-failed',
            strategyLabel,
            detailCode,
            historyBoundary,
            canRetry: true,
            canSelect: false,
          }
        : {
            status: 'provisional',
            strategyLabel,
            detailCode,
            historyBoundary,
            canRetry: false,
            canSelect: false,
          };
    }

    default:
      return null;
  }
}

function parseCapabilities(value: unknown): readonly SessiondRecoveryCapability[] | null {
  if (!hasExactKeys(value, ['values']) || !Array.isArray(value.values)) return null;
  if (value.values.length > SessiondRecoveryMaxCapabilities) return null;

  const capabilities: SessiondRecoveryCapability[] = [];
  const seen = new Set<SessiondRecoveryCapability>();
  for (const capability of value.values) {
    if (
      !isBoundedText(capability, SessiondRecoveryMaxCapabilityBytes) ||
      !KNOWN_CAPABILITIES.has(capability as SessiondRecoveryCapability)
    ) {
      return null;
    }
    const typedCapability = capability as SessiondRecoveryCapability;
    if (seen.has(typedCapability)) return null;
    seen.add(typedCapability);
    capabilities.push(typedCapability);
  }
  return capabilities;
}

function parseProtocolHelloResult(value: unknown): SessiondProtocolHelloResult | null {
  if (
    !hasExactKeys(value, ['recoverySchemaVersion', 'capabilities', 'compatible', 'detailCode']) ||
    value.recoverySchemaVersion !== RECOVERY_SCHEMA_VERSION ||
    typeof value.compatible !== 'boolean'
  ) {
    return null;
  }
  const capabilities = parseCapabilities(value.capabilities);
  const detailCode = parseDetailCode(value.detailCode);
  if (capabilities === null || detailCode === null) return null;
  if (
    (value.compatible && detailCode !== 'none') ||
    (!value.compatible && detailCode !== 'schema-incompatible')
  ) {
    return null;
  }
  return value.compatible
    ? {
        recoverySchemaVersion: RECOVERY_SCHEMA_VERSION,
        capabilities: { values: capabilities },
        compatible: true,
        detailCode: 'none',
      }
    : {
        recoverySchemaVersion: RECOVERY_SCHEMA_VERSION,
        capabilities: { values: capabilities },
        compatible: false,
        detailCode: 'schema-incompatible',
      };
}

function parseTransition(value: unknown): SessiondPaneRecoveryTransition | null {
  if (!hasExactKeys(value, ['pane', 'recovery'])) return null;
  const pane = parsePaneRef(value.pane);
  const recovery = validateRecoveryProjection(value.recovery);
  return pane === null || recovery === null ? null : { pane, recovery };
}

function parseRetryResult(value: unknown): SessiondRecoveryRetryResult | null {
  if (!hasExactKeys(value, ['pane', 'recovery'])) return null;
  const pane = parsePaneRef(value.pane);
  const recovery = validateRecoveryProjection(value.recovery);
  return pane === null || recovery === null ? null : { pane, recovery };
}

function parseSelectResult(value: unknown): SessiondRecoverySelectResult | null {
  if (!hasExactKeys(value, ['pane', 'recovery'])) return null;
  const pane = parsePaneRef(value.pane);
  const recovery = validateRecoveryProjection(value.recovery);
  return pane === null || recovery === null ? null : { pane, recovery };
}

function parseReplacementOutcome(value: unknown): SessiondRecoveryReplacementOutcome | null {
  if (!hasExactKeys(value, ['state', 'detailCode'])) return null;
  const detailCode = parseDetailCode(value.detailCode);
  if (detailCode === null || typeof value.state !== 'string') return null;
  switch (value.state) {
    case 'committed':
      return detailCode === 'none' ? { state: 'committed', detailCode: 'none' } : null;
    case 'deferred':
      return detailCode === 'replacement-deferred'
        ? { state: 'deferred', detailCode: 'replacement-deferred' }
        : null;
    case 'failed':
      return detailCode === 'replacement-failed' || detailCode === 'replacement-plan-invalid'
        ? { state: 'failed', detailCode }
        : null;
    default:
      return null;
  }
}

function parseActivePaneResult(value: unknown): SessiondActivePanePersistenceResult | null {
  if (!hasExactKeys(value, ['pane', 'detailCode'])) return null;
  const pane = parsePaneRef(value.pane);
  if (
    pane === null ||
    (value.detailCode !== 'none' && value.detailCode !== 'active-pane-invalid')
  ) {
    return null;
  }
  return { pane, detailCode: value.detailCode };
}

function parseRecoveryEvent(value: UnknownRecord): RecoveryWireEvent | null {
  if (typeof value.type !== 'string') return null;

  const parseEnvelope = <T>(
    payloadKey: string,
    parsePayload: (payload: unknown) => T | null,
  ): { readonly cid?: number; readonly payload: T } | null => {
    const hasCID = hasOwn(value, 'cid');
    if (!hasExactKeys(value, hasCID ? ['type', 'cid', payloadKey] : ['type', payloadKey])) {
      return null;
    }
    const payload = parsePayload(value[payloadKey]);
    if (payload === null) return null;
    if (!hasCID) return { payload };
    const cid = value.cid;
    return isPositiveSafeInteger(cid) ? { cid, payload } : null;
  };

  switch (value.type) {
    case SessiondRecoveryType.ProtocolHelloResult: {
      const envelope = parseEnvelope('protocolHelloResult', parseProtocolHelloResult);
      if (envelope === null) return null;
      return envelope.cid === undefined
        ? { type: SessiondRecoveryType.ProtocolHelloResult, protocolHelloResult: envelope.payload }
        : {
            type: SessiondRecoveryType.ProtocolHelloResult,
            cid: envelope.cid,
            protocolHelloResult: envelope.payload,
          };
    }

    case SessiondRecoveryType.PaneRecoveryChanged: {
      const envelope = parseEnvelope('recoveryTransition', parseTransition);
      if (envelope === null) return null;
      return envelope.cid === undefined
        ? { type: SessiondRecoveryType.PaneRecoveryChanged, recoveryTransition: envelope.payload }
        : {
            type: SessiondRecoveryType.PaneRecoveryChanged,
            cid: envelope.cid,
            recoveryTransition: envelope.payload,
          };
    }

    case SessiondRecoveryType.RecoveryRetryResult: {
      const envelope = parseEnvelope('recoveryRetryResult', parseRetryResult);
      if (envelope === null) return null;
      return envelope.cid === undefined
        ? { type: SessiondRecoveryType.RecoveryRetryResult, recoveryRetryResult: envelope.payload }
        : {
            type: SessiondRecoveryType.RecoveryRetryResult,
            cid: envelope.cid,
            recoveryRetryResult: envelope.payload,
          };
    }

    case SessiondRecoveryType.RecoverySelectResult: {
      const envelope = parseEnvelope('recoverySelectResult', parseSelectResult);
      if (envelope === null) return null;
      return envelope.cid === undefined
        ? { type: SessiondRecoveryType.RecoverySelectResult, recoverySelectResult: envelope.payload }
        : {
            type: SessiondRecoveryType.RecoverySelectResult,
            cid: envelope.cid,
            recoverySelectResult: envelope.payload,
          };
    }

    case SessiondRecoveryType.ReplacementOutcome: {
      const envelope = parseEnvelope('replacementOutcome', parseReplacementOutcome);
      if (envelope === null) return null;
      return envelope.cid === undefined
        ? { type: SessiondRecoveryType.ReplacementOutcome, replacementOutcome: envelope.payload }
        : {
            type: SessiondRecoveryType.ReplacementOutcome,
            cid: envelope.cid,
            replacementOutcome: envelope.payload,
          };
    }

    case SessiondRecoveryType.SetActivePaneResult: {
      const envelope = parseEnvelope('activePanePersistenceResult', parseActivePaneResult);
      if (envelope === null) return null;
      return envelope.cid === undefined
        ? {
            type: SessiondRecoveryType.SetActivePaneResult,
            activePanePersistenceResult: envelope.payload,
          }
        : {
            type: SessiondRecoveryType.SetActivePaneResult,
            cid: envelope.cid,
            activePanePersistenceResult: envelope.payload,
          };
    }

    default:
      return null;
  }
}

function isRecoverySensitiveType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    RECOVERY_SENSITIVE_TYPE_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

function containsNamedField(
  value: unknown,
  names: ReadonlySet<string>,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): boolean {
  if (depth > MAX_ORDINARY_NESTING || typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((entry) => containsNamedField(entry, names, depth + 1, seen));
  }
  if (!isPlainObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key) || containsNamedField(child, names, depth + 1, seen)) return true;
  }
  return false;
}

function containsPrivilegedRecoveryField(value: UnknownRecord): boolean {
  if (isRecoverySensitiveType(value.type)) {
    return containsNamedField(value, PRIVILEGED_RECOVERY_FIELDS);
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      RECOVERY_RELATED_FIELDS.has(key) &&
      containsNamedField(child, PRIVILEGED_RECOVERY_FIELDS)
    ) {
      return true;
    }
  }

  if (value.type !== SessiondType.Composition || !Array.isArray(value.panes)) return false;
  return value.panes.some(
    (pane) =>
      isPlainObject(pane) &&
      hasOwn(pane, 'recovery') &&
      containsNamedField(pane.recovery, PRIVILEGED_RECOVERY_FIELDS),
  );
}

const INVALID_ORDINARY_VALUE = Symbol('invalid-ordinary-value');

function stripRecoveryFields(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown | typeof INVALID_ORDINARY_VALUE {
  if (depth > MAX_ORDINARY_NESTING) return INVALID_ORDINARY_VALUE;
  if (Array.isArray(value)) {
    if (seen.has(value)) return INVALID_ORDINARY_VALUE;
    seen.add(value);
    const sanitized: unknown[] = [];
    for (const item of value) {
      const next = stripRecoveryFields(item, depth + 1, seen);
      if (next === INVALID_ORDINARY_VALUE) return INVALID_ORDINARY_VALUE;
      sanitized.push(next);
    }
    return sanitized;
  }
  if (!isPlainObject(value)) {
    return typeof value === 'object' && value !== null ? INVALID_ORDINARY_VALUE : value;
  }
  if (seen.has(value)) return INVALID_ORDINARY_VALUE;
  seen.add(value);

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (RECOVERY_RELATED_FIELDS.has(key)) continue;
    const next = stripRecoveryFields(child, depth + 1, seen);
    if (next === INVALID_ORDINARY_VALUE) return INVALID_ORDINARY_VALUE;
    sanitized[key] = next;
  }
  return sanitized;
}

function sanitizePaneProjection(
  value: unknown,
  allowRecovery: boolean,
): unknown | typeof INVALID_ORDINARY_VALUE {
  if (!isPlainObject(value)) return stripRecoveryFields(value);
  const parsedRecovery = allowRecovery && isPaneID(value.paneId) && hasOwn(value, 'recovery')
    ? validateRecoveryProjection(value.recovery)
    : null;
  const ordinary: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (RECOVERY_RELATED_FIELDS.has(key)) continue;
    const sanitized = stripRecoveryFields(child);
    if (sanitized === INVALID_ORDINARY_VALUE) return INVALID_ORDINARY_VALUE;
    ordinary[key] = sanitized;
  }
  if (parsedRecovery !== null) ordinary.recovery = parsedRecovery;
  return ordinary;
}

function sanitizeOrdinaryMessage(value: UnknownRecord): Record<string, unknown> | null {
  const messageType = value.type;
  const isComposition = messageType === SessiondType.Composition;
  const isPaneProjection =
    messageType === SessiondType.PaneAdded || messageType === SessiondType.PaneCreated;
  const hasSafeWorkspaceID = parseWorkspaceID(value.workspaceId) !== null;

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (RECOVERY_RELATED_FIELDS.has(key)) continue;
    if (isComposition && key === 'panes' && Array.isArray(child)) {
      const panes: unknown[] = [];
      for (const pane of child) {
        const sanitizedPane = sanitizePaneProjection(pane, hasSafeWorkspaceID);
        if (sanitizedPane === INVALID_ORDINARY_VALUE) return null;
        panes.push(sanitizedPane);
      }
      sanitized.panes = panes;
      continue;
    }
    const next = stripRecoveryFields(child);
    if (next === INVALID_ORDINARY_VALUE) return null;
    sanitized[key] = next;
  }

  if (isPaneProjection) {
    const recovery =
      hasSafeWorkspaceID && isPaneID(value.paneId) && hasOwn(value, 'recovery')
        ? validateRecoveryProjection(value.recovery)
        : null;
    if (recovery !== null) sanitized.recovery = recovery;
  }

  return sanitized;
}

/**
 * Classify one parsed text frame. Recovery-sensitive frames must obey the
 * browser recovery text limit; ordinary messages retain their existing
 * additive behavior after recovery fields are stripped or reconstructed.
 */
export function classifyRecoveryInbound(
  value: unknown,
  textByteLength: number,
): RecoveryInboundClassification {
  if (!isPlainObject(value)) return REJECTED;

  // Reject owner-local names before stripping an explicitly located recovery
  // payload, while leaving unrelated ordinary protocol fields untouched.
  if (containsPrivilegedRecoveryField(value)) return REJECTED;

  const recoverySensitive =
    isRecoverySensitiveType(value.type) ||
    containsNamedField(value, RECOVERY_RELATED_FIELDS);
  if (
    recoverySensitive &&
    (!Number.isSafeInteger(textByteLength) ||
      textByteLength < 1 ||
      textByteLength > MAX_RECOVERY_TEXT_BYTES)
  ) {
    return REJECTED;
  }

  if (isRecoverySensitiveType(value.type)) {
    const event = parseRecoveryEvent(value);
    return event === null ? REJECTED : { kind: 'recovery', event };
  }

  const message = sanitizeOrdinaryMessage(value);
  return message === null ? REJECTED : { kind: 'ordinary', message };
}

export function buildProtocolHello(): SessiondBrowserRecoveryRequest {
  const protocolHello: SessiondProtocolHello = {
    recoverySchemaVersion: RECOVERY_SCHEMA_VERSION,
    capabilities: { values: [...RECOVERY_CAPABILITIES] },
  };
  return {
    type: SessiondRecoveryType.ProtocolHello,
    protocolHello,
  };
}

export function buildRecoveryRetry(
  paneValue: unknown,
  cidValue: unknown,
): Extract<RecoveryRequestWithCID, { type: typeof SessiondRecoveryType.RecoveryRetry }> | null {
  const pane = parsePaneRef(paneValue);
  if (pane === null || !isPositiveSafeInteger(cidValue)) return null;
  return {
    type: SessiondRecoveryType.RecoveryRetry,
    cid: cidValue,
    recoveryRetry: { pane: { ...pane } },
  };
}

export function buildRecoverySelect(
  candidateHandleValue: unknown,
  cidValue: unknown,
): Extract<RecoveryRequestWithCID, { type: typeof SessiondRecoveryType.RecoverySelect }> | null {
  const candidateHandle = parseCandidateHandle(candidateHandleValue);
  if (candidateHandle === null || !isPositiveSafeInteger(cidValue)) return null;
  return {
    type: SessiondRecoveryType.RecoverySelect,
    cid: cidValue,
    recoverySelect: { candidateHandle },
  };
}

export function buildActivePanePersistence(
  paneValue: unknown,
  cidValue: unknown,
): Extract<RecoveryRequestWithCID, { type: typeof SessiondRecoveryType.SetActivePane }> | null {
  const pane = parsePaneRef(paneValue);
  if (pane === null || !isPositiveSafeInteger(cidValue)) return null;
  return {
    type: SessiondRecoveryType.SetActivePane,
    cid: cidValue,
    activePanePersistence: { pane: { ...pane } },
  };
}