// ── Realtime voice credentials ───────────────────────────────────────────────
//
// Separate from lib/config.ts on purpose, exactly as lib/ai.ts is: VoiceStatus
// is NOT part of ResolvedConfig, so it cannot be swept into configToGoJSON()
// and PATCHed through the config pipeline that broadcasts to every tab and
// every MCP agent.
//
// THE KEY IS WRITE-ONLY ACROSS THE WIRE. It is sent by saveVoiceSettings and
// is never returned by any endpoint here. Nothing in this module holds it,
// caches it, or renders it. `keyConfigured` is a boolean and it is the entire
// truth the server tells about a stored secret -- no mask, no length, no last
// four characters. If you find yourself wanting a hint field, that is the
// requirement saying no.

import { apiPath } from './base-path.js';

/**
 * Which SHAPE the form is in. These are not interchangeable: Entra holds no
 * secret at all, so it must not render a key field, and OpenAI has exactly one
 * endpoint so it must not render an endpoint field.
 */
export type VoiceMode = 'openai_key' | 'azure_key' | 'azure_entra';

/** Where an api_key-mode credential is read from. Never what it is. */
export type VoiceKeySource = 'stored' | 'env' | 'none' | '';

export interface VoiceStatus {
  enabled: boolean;
  /** True only when this running server registered the app-voice candidate. */
  appVoiceCandidateAvailable: boolean;
  mode: VoiceMode;
  endpoint: string;
  model: string;
  authMode: string;
  entraScope: string;
  keySource: VoiceKeySource;
  /** Environment variable NAME when a hand-edited config sources the key. */
  keyEnvVar: string;
  /** Whether a credential is set. The only thing said about the secret. */
  keyConfigured: boolean;
  allowedScopes: string[];
  configPath: string;
  keyPath: string;
  /** Voice routes are wired at startup; a saved change lands on next start. */
  restartRequired: boolean;
}

export const DEFAULT_VOICE_STATUS: VoiceStatus = {
  enabled: false,
  appVoiceCandidateAvailable: false,
  mode: 'azure_entra',
  endpoint: '',
  model: '',
  authMode: '',
  entraScope: '',
  keySource: '',
  keyEnvVar: '',
  keyConfigured: false,
  allowedScopes: [],
  configPath: '',
  keyPath: '',
  restartRequired: false,
};

function str(r: Record<string, unknown>, k: string): string {
  return typeof r[k] === 'string' ? (r[k] as string) : '';
}

/** Narrow untrusted JSON into a VoiceStatus, defaulting anything unexpected. */
export function parseVoiceStatus(raw: unknown): VoiceStatus {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_VOICE_STATUS;
  }
  const r = raw as Record<string, unknown>;
  const mode = r['mode'];
  const source = r['keySource'];
  return {
    enabled: r['enabled'] === true,
    appVoiceCandidateAvailable: r['appVoiceCandidateAvailable'] === true,
    mode: mode === 'openai_key' || mode === 'azure_key' || mode === 'azure_entra'
      ? mode
      : 'azure_entra',
    endpoint: str(r, 'endpoint'),
    model: str(r, 'model'),
    authMode: str(r, 'authMode'),
    entraScope: str(r, 'entraScope'),
    keySource: source === 'stored' || source === 'env' || source === 'none' ? source : '',
    keyEnvVar: str(r, 'keyEnvVar'),
    keyConfigured: r['keyConfigured'] === true,
    allowedScopes: Array.isArray(r['allowedScopes'])
      ? (r['allowedScopes'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    configPath: str(r, 'configPath'),
    keyPath: str(r, 'keyPath'),
    restartRequired: r['restartRequired'] === true,
  };
}

/** The server's own words when it refuses. Shown verbatim: it names the field. */
async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const msg = body['error'];
    if (typeof msg === 'string' && msg !== '') return msg;
  } catch {
    /* fall through */
  }
  return fallback;
}

/** GET /api/voice/settings — configuration plus whether a key is set. */
export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  const res = await fetch(apiPath('/api/voice/settings'));
  if (!res.ok) return DEFAULT_VOICE_STATUS;
  return parseVoiceStatus(await res.json());
}

export interface VoiceSettingsInput {
  enabled: boolean;
  mode: VoiceMode;
  endpoint: string;
  model: string;
  entraScope: string;
  /** Omit or leave empty to keep whatever key is already stored. */
  apiKey?: string;
}

/**
 * PUT /api/voice/settings — an explicit save, on a button press.
 *
 * Note the absence of lib/config.ts's patchConfig() debounce, for the reason
 * lib/ai.ts gives: a secret is never keystroke-debounced onto the wire.
 *
 * Throws with the SERVER's message on refusal. That message names the missing
 * field ("enabled but auth_mode is empty…"), which is the whole point of
 * validating at save time instead of at startup.
 */
export async function saveVoiceSettings(input: VoiceSettingsInput): Promise<VoiceStatus> {
  const res = await fetch(apiPath('/api/voice/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorText(res, `Save failed (HTTP ${res.status}).`));
  return parseVoiceStatus(await res.json());
}

/** DELETE /api/voice/key — idempotent; also turns voice off if it was the only source. */
export async function clearVoiceKey(): Promise<VoiceStatus> {
  const res = await fetch(apiPath('/api/voice/key'), { method: 'DELETE' });
  if (!res.ok) throw new Error(await errorText(res, `Could not remove the key (HTTP ${res.status}).`));
  return parseVoiceStatus(await res.json());
}

/**
 * POST /api/voice/check — really authenticates against the saved settings.
 *
 * Never starts a realtime session, so it costs nothing. `detail` is prose from
 * the server and is safe to render: internal/voice never puts a credential in
 * an error string.
 */
export async function checkVoice(): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(apiPath('/api/voice/check'), { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const detail = typeof body['detail'] === 'string'
    ? body['detail']
    : typeof body['error'] === 'string'
      ? (body['error'] as string)
      : `The check could not run (HTTP ${res.status}).`;
  return { ok: res.ok && body['ok'] === true, detail };
}
