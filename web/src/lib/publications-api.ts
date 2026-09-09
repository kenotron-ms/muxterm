// ── Publications client ─────────────────────────────────────────────────────
//
// The browser's half of internal/server/publish_api.go: publish ONE local file
// to an anonymous public URL, list what is exposed right now, revoke.
//
// WHAT THE CALLER MUST UNDERSTAND, because the UI has to say it out loud:
// a publication is LIVE. Nothing is copied at publish time; the file is
// re-read from disk on every request, so a holder of the link sees edits
// immediately. Revoking stops FUTURE reads and recalls nothing.
//
// Every read goes through a hand-written narrowing function with a default per
// field, exactly as files-api.ts does and for the same reason: `await
// res.json()` is `any`, and one bare cast puts an undefined where the applet
// expects a string for the rest of the app's life.

import { apiPath } from './base-path.js';

/**
 * Why a publication is or is not serving right now, re-checked against disk by
 * the server on every list. Mirrors the status codes in
 * internal/server/publish.go.
 *
 * `identity_mismatch` is the interesting one: the file at the pinned path is no
 * longer the file that was published (replaced, or saved by an editor that
 * writes a new file and renames it into place), so the link refuses to serve
 * rather than serving whatever is there now.
 */
export type PublicationStatus =
  | 'ok'
  | 'expired'
  | 'source_missing'
  | 'identity_mismatch'
  | 'too_large'
  | 'source_unreadable'
  | 'error';

const STATUSES: readonly string[] = [
  'ok',
  'expired',
  'source_missing',
  'identity_mismatch',
  'too_large',
  'source_unreadable',
  'error',
];

/** How the server renders the file. */
export type PublicationKind = 'markdown' | 'text' | 'image' | 'download';

export interface Publication {
  id: string;
  /** Absolute when an operator configured a public origin, else "/p/{id}". */
  url: string;
  /** The PINNED path -- fully symlink-resolved. */
  path: string;
  /** Only present when it differs from `path`. */
  requestedPath: string;
  publishedAt: string;
  expiresAt: string;
  expired: boolean;
  secondsLeft: number;
  kind: PublicationKind;
  contentType: string;
  sizeAtPublish: number;
  /** Current size on disk, or -1 when the file could not be read at all. */
  size: number;
  identityOk: boolean;
  status: PublicationStatus;
  statusDetail: string;
}

function parseKind(raw: unknown): PublicationKind {
  return raw === 'markdown' || raw === 'text' || raw === 'image' || raw === 'download'
    ? raw
    : 'download';
}

function num(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function str(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

/** Narrow one untrusted row. A row with no id is not a publication. */
export function parsePublication(raw: unknown): Publication | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r['id']);
  if (id === '') return null;
  return {
    id,
    url: str(r['url']),
    path: str(r['path']),
    requestedPath: str(r['requested_path']),
    publishedAt: str(r['published_at']),
    expiresAt: str(r['expires_at']),
    expired: r['expired'] === true,
    secondsLeft: num(r['seconds_left'], 0),
    kind: parseKind(r['kind']),
    contentType: str(r['content_type']),
    sizeAtPublish: num(r['size_at_publish'], 0),
    size: num(r['size'], -1),
    identityOk: r['identity_ok'] === true,
    status: STATUSES.includes(str(r['status']))
      ? (str(r['status']) as PublicationStatus)
      : 'error',
    statusDetail: str(r['status_detail']),
  };
}

/** Rethrow the server's own sentence, as files-api.ts does. */
async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  const trimmed = text.trim();
  if (trimmed === '') return `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed['error'] === 'string' && parsed['error'] !== '') return parsed['error'];
  } catch {
    /* the publish routes answer text/plain, which is the common case here */
  }
  return trimmed;
}

/** GET /api/publications -- every publication, each re-checked against disk. */
export async function fetchPublications(signal?: AbortSignal): Promise<Publication[]> {
  const res = await fetch(apiPath('/api/publications'), signal ? { signal } : undefined);
  if (!res.ok) throw new Error(await readError(res));
  const body: unknown = await res.json().catch(() => []);
  if (!Array.isArray(body)) return [];
  return body.map(parsePublication).filter((p): p is Publication => p !== null);
}

/**
 * POST /api/publications -- publish one file.
 *
 * `ttlSeconds` omitted means the server's default (24h). The server refuses
 * anything above its maximum rather than clamping silently, so a caller that
 * asks for a month is TOLD it got a week's refusal instead of quietly telling
 * a recipient the wrong thing.
 */
export async function publishFile(path: string, ttlSeconds?: number): Promise<Publication> {
  const res = await fetch(apiPath('/api/publications'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ttlSeconds === undefined ? { path } : { path, ttl_seconds: ttlSeconds }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const parsed = parsePublication(await res.json().catch(() => null));
  if (!parsed) throw new Error('the server accepted the publish but answered something unreadable');
  return parsed;
}

/** DELETE /api/publications/{id} -- takes effect on the very next request. */
export async function revokePublication(id: string): Promise<void> {
  const res = await fetch(`${apiPath('/api/publications')}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await readError(res));
}

/**
 * The link to hand to a recipient.
 *
 * The server returns a RELATIVE "/p/{id}" unless an operator configured a
 * public origin, because the only origin it can derive on its own is its listen
 * address, which is loopback in every deployment that has a remote reader --
 * see tunnelURL in internal/server/server.go. The browser, however, knows the
 * origin it is actually talking to, so it is the right place to resolve it.
 */
export function absoluteURL(p: Publication): string {
  if (p.url === '') return '';
  try {
    return new URL(p.url, location.href).toString();
  } catch {
    return p.url;
  }
}

/** "23h", "45m", "30s" -- how long a link keeps working. */
export function formatTimeLeft(seconds: number): string {
  if (seconds <= 0) return 'expired';
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

/** The word shown on a row for a publication that is not serving. */
export function statusWord(p: Publication): string {
  switch (p.status) {
    case 'ok':
      return 'public';
    case 'expired':
      return 'expired';
    case 'source_missing':
      return 'gone';
    case 'identity_mismatch':
      return 'broken';
    case 'too_large':
      return 'too big';
    case 'source_unreadable':
      return 'unreadable';
    default:
      return 'broken';
  }
}
