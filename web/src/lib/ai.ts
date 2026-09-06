// ── Opt-in AI capability ─────────────────────────────────────────────────
//
// Deliberately separate from lib/config.ts: AIStatus is NOT a member of
// ResolvedConfig, so it cannot leak into configToGoJSON() and get PATCHed into
// the config pipeline (which is broadcast to every tab and every MCP agent).
//
// The API key is write-only across the wire: it is sent by saveAIKey and never
// returned by any endpoint, so nothing in this module ever holds or caches it.

import { apiPath } from './base-path.js';

export type AISource = 'settings' | 'env' | 'none';

export interface AIStatus {
  enabled: boolean;
  source: AISource;
  /** Last 4 characters of the stored key, e.g. "…a1b2". Empty when disabled. */
  keyHint: string;
}

export const DEFAULT_AI_STATUS: AIStatus = {
  enabled: false,
  source: 'none',
  keyHint: '',
};

/** Narrow untrusted JSON into an AIStatus, defaulting anything unexpected. */
export function parseAIStatus(raw: unknown): AIStatus {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_AI_STATUS;
  }
  const r = raw as Record<string, unknown>;
  const source = r['source'];
  return {
    enabled: r['enabled'] === true,
    source: source === 'settings' || source === 'env' ? source : 'none',
    keyHint: typeof r['keyHint'] === 'string' ? r['keyHint'] : '',
  };
}

/** GET /api/ai/status — the capability flag. Never returns the key. */
export async function fetchAIStatus(): Promise<AIStatus> {
  const res = await fetch(apiPath('/api/ai/status'));
  if (!res.ok) return DEFAULT_AI_STATUS;
  return parseAIStatus(await res.json());
}

/**
 * PUT /api/ai/key — submits the key explicitly, on a button press.
 *
 * Note the absence of lib/config.ts's patchConfig() debounce: a secret is
 * never keystroke-debounced onto the wire.
 */
export async function saveAIKey(key: string): Promise<AIStatus> {
  const res = await fetch(apiPath('/api/ai/key'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  });
  if (!res.ok) throw new Error(`saveAIKey: HTTP ${res.status}`);
  return parseAIStatus(await res.json());
}

/** DELETE /api/ai/key — idempotent. */
export async function clearAIKey(): Promise<AIStatus> {
  const res = await fetch(apiPath('/api/ai/key'), { method: 'DELETE' });
  if (!res.ok) throw new Error(`clearAIKey: HTTP ${res.status}`);
  return parseAIStatus(await res.json());
}

/** POST /api/ai/ping — the authoritative key-validity check. */
export async function pingAI(): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(apiPath('/api/ai/ping'), { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && body['ok'] === true) return { ok: true };
  const err = typeof body['error'] === 'string' ? body['error'] : `http_${res.status}`;
  return { ok: false, error: err };
}
