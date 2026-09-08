// ── Files client ─────────────────────────────────────────────────────────────
//
// One directory listing, annotated with git status, for Mission Control's Files
// applet. The server half is internal/server/files_api.go and its contract is
// the comment at the top of that file; this module is the browser's half of it.
//
// TWO PROPERTIES OF THE WIRE SHAPE DRIVE EVERYTHING BELOW:
//
//   1. `entries` is never null, and `gitAvailable:false` is a DEGRADED LISTING,
//      not an error. A directory outside any worktree still returns every file
//      it holds, with one sentence in `gitError` saying why the annotations are
//      missing. Losing the git half must never cost the caller its listing, so
//      nothing here throws on it.
//
//   2. A 4xx/5xx carries `{"error": "<sentence>"}` written by a human for a
//      human -- "/nope does not exist", "\"web/src\" is not an absolute path".
//      fetchFiles rethrows that sentence verbatim (update.ts:95-105's idiom) so
//      the applet can show the server's own words instead of "HTTP 404".
//
// Every read goes through a hand-written narrowing function with a default per
// field. `await res.json()` is `any`, and one bare cast would put an undefined
// where the applet expects a string for the rest of the app's life.

import { apiPath } from './base-path.js';

/**
 * What git says about one entry. '' is the ABSENCE of a status, not a status:
 * an unchanged file, or any file at all when git could not be consulted.
 *
 * Mirrors the fileStatus* constants in internal/server/files_api.go. A
 * directory reports 'modified' when anything under it changed, whatever that
 * change was -- see statusFor() there for why the roll-up cannot be more
 * specific than that without lying.
 */
export type FileStatus =
  | ''
  | 'modified'
  | 'added'
  | 'deleted'
  | 'untracked'
  | 'renamed'
  | 'conflicted';

const FILE_STATUSES: readonly string[] = [
  'modified',
  'added',
  'deleted',
  'untracked',
  'renamed',
  'conflicted',
];

/** One row of a listing. `size`/`modified` come from Lstat, so a symlink
 * reports its own size and `dir:false` even when it points at a directory. */
export interface FileEntry {
  name: string;
  dir: boolean;
  /** Bytes. */
  size: number;
  /** Unix seconds. */
  modified: number;
  status: FileStatus;
}

/** GET /api/files. */
export interface FilesListing {
  /** The cleaned absolute directory that was listed. */
  path: string;
  /** The directory above `path`, or '' at the filesystem root. */
  parent: string;
  /** '' when `path` is not inside a worktree. */
  repoRoot: string;
  /** '' when detached, unborn, or not a worktree. */
  branch: string;
  /** false when git is missing, this is no worktree, or status failed. */
  gitAvailable: boolean;
  /** One human sentence when `gitAvailable` is false; '' otherwise. */
  gitError: string;
  /** Directories first, then files, each case-insensitive. Never null. */
  entries: FileEntry[];
}

function parseFileStatus(raw: unknown): FileStatus {
  return typeof raw === 'string' && FILE_STATUSES.includes(raw) ? (raw as FileStatus) : '';
}

/** Narrow one untrusted row, defaulting anything unexpected. */
export function parseFileEntry(raw: unknown): FileEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { name: '', dir: false, size: 0, modified: 0, status: '' };
  }
  const r = raw as Record<string, unknown>;
  return {
    name: typeof r['name'] === 'string' ? r['name'] : '',
    dir: r['dir'] === true,
    size: typeof r['size'] === 'number' && Number.isFinite(r['size']) ? r['size'] : 0,
    modified:
      typeof r['modified'] === 'number' && Number.isFinite(r['modified']) ? r['modified'] : 0,
    status: parseFileStatus(r['status']),
  };
}

/**
 * Narrow untrusted JSON into a FilesListing.
 *
 * A row with no `name` is dropped rather than rendered: it can only come from a
 * response that is not this endpoint's, and a blank row in a file list is worse
 * than a short list.
 */
export function parseFilesListing(raw: unknown): FilesListing {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      path: '',
      parent: '',
      repoRoot: '',
      branch: '',
      gitAvailable: false,
      gitError: '',
      entries: [],
    };
  }
  const r = raw as Record<string, unknown>;
  const entries = Array.isArray(r['entries'])
    ? (r['entries'] as unknown[]).map(parseFileEntry).filter((e) => e.name !== '')
    : [];
  return {
    path: typeof r['path'] === 'string' ? r['path'] : '',
    parent: typeof r['parent'] === 'string' ? r['parent'] : '',
    repoRoot: typeof r['repoRoot'] === 'string' ? r['repoRoot'] : '',
    branch: typeof r['branch'] === 'string' ? r['branch'] : '',
    gitAvailable: r['gitAvailable'] === true,
    gitError: typeof r['gitError'] === 'string' ? r['gitError'] : '',
    entries,
  };
}

/**
 * GET /api/files[?path=<absolute path>].
 *
 * `path` omitted means "wherever this server process is" -- the only sensible
 * opening directory for a browser that has not chosen one yet, and the ONLY way
 * to learn the server's cwd. Passing a relative path is a caller bug and the
 * server says so in words.
 *
 * `signal` is how the applet honours the inactive rule: an applet that goes
 * inactive mid-flight aborts, and an aborted fetch rejects with an AbortError
 * the caller is expected to ignore rather than render.
 *
 * Throws the server's own `error` sentence on any non-2xx, so the applet can
 * show "/gone does not exist" instead of "HTTP 404".
 */
export async function fetchFiles(path?: string, signal?: AbortSignal): Promise<FilesListing> {
  const url =
    path === undefined
      ? apiPath('/api/files')
      : `${apiPath('/api/files')}?${new URLSearchParams({ path }).toString()}`;
  const res = await fetch(url, signal ? { signal } : undefined);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err =
      typeof body['error'] === 'string' && body['error'] !== ''
        ? body['error']
        : `fetchFiles: HTTP ${res.status}`;
    throw new Error(err);
  }
  return parseFilesListing(body);
}
