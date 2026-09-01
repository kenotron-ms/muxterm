// ── Self-update client ──────────────────────────────────────────────────────
//
// Thin wrapper over the two self-update endpoints. Deliberately separate from
// lib/config.ts: update state is server-owned and read-only, so it must never
// enter the config PATCH pipeline that is broadcast to every tab.
//
// The server marshals `reason` and `error` with omitempty, so both may arrive
// as MISSING KEYS rather than empty strings — every read goes through
// parseUpdateStatus(), which normalizes anything unexpected.

export type UpdateMethod = 'binary' | 'homebrew' | 'unsupported';

export interface UpdateStatus {
  /** Version of the running binary. Always present. */
  currentVersion: string;
  /** Newest release tag, leading "v" stripped. Empty when unknown. */
  latestVersion: string;
  updateAvailable: boolean;
  /** True only when updateAvailable && !devBuild && method === 'binary'. */
  canUpdate: boolean;
  devBuild: boolean;
  method: UpdateMethod;
  /** Why an update is not actionable (dev build, Homebrew, unsupported). */
  reason?: string;
  /** Non-empty when the release check itself failed (e.g. no network). */
  error?: string;
}

export const DEFAULT_UPDATE_STATUS: UpdateStatus = {
  currentVersion: '',
  latestVersion: '',
  updateAvailable: false,
  canUpdate: false,
  devBuild: false,
  method: 'unsupported',
  reason: '',
  error: '',
};

/** Narrow untrusted JSON into an UpdateStatus, defaulting anything unexpected. */
export function parseUpdateStatus(raw: unknown): UpdateStatus {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_UPDATE_STATUS;
  }
  const r = raw as Record<string, unknown>;
  const method = r['method'];
  return {
    currentVersion: typeof r['currentVersion'] === 'string' ? r['currentVersion'] : '',
    latestVersion: typeof r['latestVersion'] === 'string' ? r['latestVersion'] : '',
    updateAvailable: r['updateAvailable'] === true,
    canUpdate: r['canUpdate'] === true,
    devBuild: r['devBuild'] === true,
    method: method === 'binary' || method === 'homebrew' ? method : 'unsupported',
    reason: typeof r['reason'] === 'string' ? r['reason'] : '',
    error: typeof r['error'] === 'string' ? r['error'] : '',
  };
}

/**
 * Thrown when /api/update/status answers 404: an HTTP server IS up (a restart
 * in flight refuses the connection instead), but it has no update endpoint.
 * That means the restart landed on a build predating this feature — i.e. the
 * update SUCCEEDED. Observed for real updating 0.11.1 -> 0.12.1, where the
 * poll would otherwise time out and report failure after a working update.
 */
export class UpdateEndpointMissingError extends Error {
  constructor() {
    super('update endpoint not present on the restarted server');
    this.name = 'UpdateEndpointMissingError';
  }
}

/**
 * GET /api/update/status — always 200 on a healthy server.
 *
 * Throws on any non-200 or transport failure rather than returning a default:
 * callers poll this across a server restart and must be able to tell "the
 * server is down" apart from "the server says version X".
 */
export async function fetchUpdateStatus(): Promise<UpdateStatus> {
  const res = await fetch('/api/update/status');
  if (res.status === 404) throw new UpdateEndpointMissingError();
  if (!res.ok) throw new Error(`fetchUpdateStatus: HTTP ${res.status}`);
  return parseUpdateStatus(await res.json());
}

/**
 * POST /api/update/apply — replaces the binary; the server restarts ~500ms later.
 *
 * Rejects with the server's own `error` string when it supplies one (409 not
 * actionable, 500 download/checksum/replace failure), so the UI can show it.
 */
export async function applyUpdate(): Promise<{ version: string }> {
  const res = await fetch('/api/update/apply', { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = typeof body['error'] === 'string' && body['error'] !== ''
      ? body['error']
      : `applyUpdate: HTTP ${res.status}`;
    throw new Error(err);
  }
  return { version: typeof body['version'] === 'string' ? body['version'] : '' };
}
