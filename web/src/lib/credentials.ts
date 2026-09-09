// ── Model-provider credentials for lanes ────────────────────────────────────
//
// A lane is an `amplifier` or `claude` process. It needs a provider API key,
// and on a machine that has none -- or has a stale one -- it dies at its first
// turn with the reason visible only in that pane's scrollback. This module is
// the browser half of finding that out before it happens.
//
// WRITE-ONLY. saveCredential sends a key; nothing here ever receives one back.
// The report says whether a credential is set, where it came from, and what
// the provider said when it was last presented. There is no reveal, no mask,
// no last-four, and no length -- the server does not return them, and this
// module has no field to put them in.

import { apiPath } from './base-path.js';

/** Where a credential came from. Not a judgement about whether it works. */
export type CredentialOrigin = 'muxterm' | 'environment' | 'amplifier' | 'none';

/**
 * What the provider said, last time anything asked it.
 *
 * `rejected` and `unreachable` are deliberately separate: one means replace
 * the key, the other means check the network or the endpoint, and telling
 * someone with a good key and a dropped connection to "check the key" is how
 * an hour goes to the wrong problem.
 */
export type VerdictState =
  | 'unknown'
  | 'ok'
  | 'rejected'
  | 'unreachable'
  | 'failed'
  | 'absent';

export interface Verdict {
  state: VerdictState;
  httpStatus?: number;
  origin?: CredentialOrigin;
  checkedAt?: string;
}

export interface ProviderState {
  provider: string;
  label: string;
  keyEnv: string;
  present: boolean;
  origin: CredentialOrigin;
  inMuxterm: boolean;
  inEnvironment: boolean;
  inAmplifierFile: boolean;
  baseURL: string;
  baseURLOrigin: CredentialOrigin;
  storePath: string;
  verdict: Verdict;
}

export interface CredentialsReport {
  providers: ProviderState[];
  blocked: boolean;
  blockedReason: string;
  amplifierKeysPath: string;
  amplifierKeysFound: boolean;
  storeDir: string;
  remoteGap: string;
}

export const EMPTY_CREDENTIALS_REPORT: CredentialsReport = {
  providers: [],
  blocked: false,
  blockedReason: '',
  amplifierKeysPath: '',
  amplifierKeysFound: false,
  storeDir: '',
  remoteGap: '',
};

const ORIGINS: readonly CredentialOrigin[] = ['muxterm', 'environment', 'amplifier', 'none'];
const STATES: readonly VerdictState[] = [
  'unknown',
  'ok',
  'rejected',
  'unreachable',
  'failed',
  'absent',
];

function str(r: Record<string, unknown>, k: string): string {
  return typeof r[k] === 'string' ? (r[k] as string) : '';
}

function parseOrigin(v: unknown): CredentialOrigin {
  return ORIGINS.includes(v as CredentialOrigin) ? (v as CredentialOrigin) : 'none';
}

function parseVerdict(raw: unknown): Verdict {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'unknown' };
  const r = raw as Record<string, unknown>;
  const state = STATES.includes(r['state'] as VerdictState)
    ? (r['state'] as VerdictState)
    : 'unknown';
  const out: Verdict = { state };
  if (typeof r['httpStatus'] === 'number') out.httpStatus = r['httpStatus'];
  if (typeof r['origin'] === 'string') out.origin = parseOrigin(r['origin']);
  if (typeof r['checkedAt'] === 'string') out.checkedAt = r['checkedAt'];
  return out;
}

function parseProviderState(raw: unknown): ProviderState | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const provider = str(r, 'provider');
  if (!provider) return null;
  return {
    provider,
    label: str(r, 'label') || provider,
    keyEnv: str(r, 'keyEnv'),
    present: r['present'] === true,
    origin: parseOrigin(r['origin']),
    inMuxterm: r['inMuxterm'] === true,
    inEnvironment: r['inEnvironment'] === true,
    inAmplifierFile: r['inAmplifierFile'] === true,
    baseURL: str(r, 'baseURL'),
    baseURLOrigin: parseOrigin(r['baseURLOrigin']),
    storePath: str(r, 'storePath'),
    verdict: parseVerdict(r['verdict']),
  };
}

/** Narrow untrusted JSON into a CredentialsReport, defaulting anything odd. */
export function parseCredentialsReport(raw: unknown): CredentialsReport {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return EMPTY_CREDENTIALS_REPORT;
  }
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r['providers']) ? r['providers'] : [];
  return {
    providers: list
      .map(parseProviderState)
      .filter((p): p is ProviderState => p !== null),
    blocked: r['blocked'] === true,
    blockedReason: str(r, 'blockedReason'),
    amplifierKeysPath: str(r, 'amplifierKeysPath'),
    amplifierKeysFound: r['amplifierKeysFound'] === true,
    storeDir: str(r, 'storeDir'),
    remoteGap: str(r, 'remoteGap'),
  };
}

/** GET /api/credentials — presence and last-known validity. No network cost. */
export async function fetchCredentials(): Promise<CredentialsReport> {
  const res = await fetch(apiPath('/api/credentials'));
  if (!res.ok) return EMPTY_CREDENTIALS_REPORT;
  return parseCredentialsReport(await res.json());
}

export interface SaveResult {
  ok: boolean;
  verdict: Verdict;
  report: CredentialsReport;
  /** Set when the request itself failed rather than the credential. */
  error?: string;
}

/**
 * PUT /api/credentials/{provider} — verify, then store only if not rejected.
 *
 * No keystroke debounce, deliberately: a secret goes on the wire on a button
 * press and at no other moment.
 */
export async function saveCredential(provider: string, key: string): Promise<SaveResult> {
  const res = await fetch(apiPath(`/api/credentials/${encodeURIComponent(provider)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const result: SaveResult = {
    ok: res.ok,
    verdict: parseVerdict(body['verdict']),
    report: parseCredentialsReport(body['report']),
  };
  if (!res.ok) result.error = typeof body['error'] === 'string' ? body['error'] : `http_${res.status}`;
  return result;
}

/** DELETE /api/credentials/{provider} — removes muxterm's stored copy only. */
export async function clearCredential(provider: string): Promise<CredentialsReport> {
  const res = await fetch(apiPath(`/api/credentials/${encodeURIComponent(provider)}`), {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`clearCredential: HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  return parseCredentialsReport(body['report']);
}

/** POST /api/credentials/{provider}/check — presents the EFFECTIVE credential. */
export async function checkCredential(provider: string): Promise<SaveResult> {
  const res = await fetch(
    apiPath(`/api/credentials/${encodeURIComponent(provider)}/check`),
    { method: 'POST' },
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: res.ok,
    verdict: parseVerdict(body['verdict']),
    report: parseCredentialsReport(body['report']),
  };
}

// ── Rendering vocabulary ────────────────────────────────────────────────────
//
// One place decides what a state is CALLED, so the settings row and the
// app-level notice cannot describe the same machine two different ways.

/**
 * The typographic marker for a provider row.
 *
 * A glyph in a fixed gutter, not a coloured slab: colour lands on this
 * character only, the character itself already carries the meaning, and the
 * whole thing survives a monochrome palette and a phone-width column.
 */
export function credentialMarker(p: ProviderState): { glyph: string; tone: string } {
  if (!p.present) return { glyph: '·', tone: 'off' };
  switch (p.verdict.state) {
    case 'ok':
      return { glyph: '✓', tone: 'ok' };
    case 'rejected':
      return { glyph: '✗', tone: 'err' };
    case 'unreachable':
    case 'failed':
      return { glyph: '~', tone: 'warn' };
    default:
      return { glyph: '?', tone: 'warn' };
  }
}

/** Where the credential a lane will use comes from, in a person's words. */
export function originPhrase(p: ProviderState): string {
  switch (p.origin) {
    case 'muxterm':
      return 'stored in muxterm';
    case 'environment':
      return `inherited from ${p.keyEnv} in muxterm's environment`;
    case 'amplifier':
      return "from amplifier's own keys.env";
    default:
      return 'not set anywhere muxterm can see';
  }
}

/**
 * The honest sentence for one provider: present-or-not first, then what the
 * provider said, kept apart. "Present but rejected" is never shortened to
 * "configured" -- that shortening is the whole reason the Mac looked healthy.
 */
export function credentialSentence(p: ProviderState): string {
  if (!p.present) {
    return `No ${p.label} credential on this machine. Set ${p.keyEnv} below, or lanes that need ${p.label} cannot run.`;
  }
  const where = originPhrase(p);
  switch (p.verdict.state) {
    case 'ok':
      return `${p.label} credential present (${where}) and accepted by ${p.label}.`;
    case 'rejected':
      return `${p.label} credential present (${where}) but ${p.label} REJECTED it. Lanes using ${p.label} will fail on their first turn. Replace it below.`;
    case 'unreachable':
      return `${p.label} credential present (${where}). muxterm could not reach ${p.label} to check it — this says nothing about the key.`;
    case 'failed':
      return `${p.label} credential present (${where}). The check reached ${p.baseURL} and got an unexpected answer${p.verdict.httpStatus ? ` (HTTP ${p.verdict.httpStatus})` : ''} — check the endpoint, not the key.`;
    default:
      return `${p.label} credential present (${where}), not checked yet.`;
  }
}
