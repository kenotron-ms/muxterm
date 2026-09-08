// ── Pull requests client ─────────────────────────────────────────────────────
//
// Every open pull request across the worktrees Mission Control is showing, for
// its Pull Requests applet. The server half is internal/server/prs_api.go,
// which shells out to the host's already-authenticated `gh` -- the browser
// never holds a token and this module never sees one.
//
// THIS ENDPOINT ALWAYS ANSWERS 200, and that is the whole shape of the client:
//
//   - `available:false` with a human sentence in `error` is gh missing or gh
//     not logged in. It is a DEGRADED STATE TO SHOW, not an error to swallow --
//     rendering it as "no pull requests" would be confidently wrong, and the
//     one sentence the user needs ("run: gh auth login") is right there.
//   - a root that is not a GitHub checkout becomes a `repos[]` row carrying its
//     own error and costs nobody else their listing.
//   - `repos` and `prs` are never null.
//
// So a throw from fetchPRs means the TRANSPORT failed (offline, server down,
// auth middleware refused), never that GitHub did. The applet renders the two
// cases differently on purpose.

import { apiPath } from './base-path.js';

/**
 * The check rollup collapsed to one word by the server (worst news wins).
 * '' means no checks are configured, which is not the same claim as 'passing'.
 */
export type PRChecks = '' | 'pending' | 'passing' | 'failing';

const PR_CHECKS: readonly string[] = ['pending', 'passing', 'failing'];

/** One pull request. */
export interface PullRequest {
  /** "owner/name#number" -- unique across repos, which the number alone is not.
   * This is the key the applet's dismissal set is written in. */
  key: string;
  repo: string;
  number: number;
  title: string;
  /** GitHub's own word, e.g. "OPEN". The route lists open PRs only. */
  state: string;
  isDraft: boolean;
  checks: PRChecks;
  /** "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | ''. Open set: a
   * value GitHub adds later must render, not disappear. */
  reviewDecision: string;
  headRefName: string;
  author: string;
  url: string;
  /** ISO 8601, e.g. "2026-09-07T18:56:45Z". */
  updatedAt: string;
}

/**
 * What one requested root resolved to. One row per ROOT, not per repo: two
 * worktrees of the same repository are two rows, which is what lets the applet
 * say which of the user's directories failed.
 */
export interface PRRepo {
  root: string;
  /** '' when resolution failed. */
  repo: string;
  /** '' when it succeeded. */
  error: string;
}

/** GET /api/prs. */
export interface PRListing {
  /** false when gh is missing or unauthenticated; `error` says which. */
  available: boolean;
  /** One human sentence when `available` is false; '' otherwise. */
  error: string;
  /** One row per requested root, in request order. Never null. */
  repos: PRRepo[];
  /** Newest first (number descending). Never null. */
  prs: PullRequest[];
}

function parsePRChecks(raw: unknown): PRChecks {
  return typeof raw === 'string' && PR_CHECKS.includes(raw) ? (raw as PRChecks) : '';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Narrow one untrusted PR row, defaulting anything unexpected. */
export function parsePullRequest(raw: unknown): PullRequest {
  const r =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    key: str(r['key']),
    repo: str(r['repo']),
    number:
      typeof r['number'] === 'number' && Number.isFinite(r['number']) ? r['number'] : 0,
    title: str(r['title']),
    state: str(r['state']),
    isDraft: r['isDraft'] === true,
    checks: parsePRChecks(r['checks']),
    reviewDecision: str(r['reviewDecision']),
    headRefName: str(r['headRefName']),
    author: str(r['author']),
    url: str(r['url']),
    updatedAt: str(r['updatedAt']),
  };
}

/** Narrow one untrusted repos[] row. */
export function parsePRRepo(raw: unknown): PRRepo {
  const r =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return { root: str(r['root']), repo: str(r['repo']), error: str(r['error']) };
}

/**
 * Narrow untrusted JSON into a PRListing.
 *
 * A PR row with no `key` is dropped: the key is what dismissal is written in,
 * so a row without one could be dismissed and come straight back.
 */
export function parsePRListing(raw: unknown): PRListing {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { available: false, error: '', repos: [], prs: [] };
  }
  const r = raw as Record<string, unknown>;
  return {
    available: r['available'] === true,
    error: str(r['error']),
    repos: Array.isArray(r['repos']) ? (r['repos'] as unknown[]).map(parsePRRepo) : [],
    prs: Array.isArray(r['prs'])
      ? (r['prs'] as unknown[]).map(parsePullRequest).filter((p) => p.key !== '')
      : [],
  };
}

/**
 * GET /api/prs?root=<abs>&root=<abs>...
 *
 * One `root` parameter per worktree, repeated -- URLSearchParams.append, never
 * a joined string, because a path may legally contain any separator anyone
 * would pick. The server caps the fan-out at 12 roots and silently drops the
 * rest, so callers cap their own list rather than letting the tail vanish.
 *
 * Zero roots is a legal request: it still reports whether gh works, which is
 * how a browser with no projects open can show "run gh auth login" before the
 * user picks anything.
 *
 * Throws only when the transport failed -- see the header. gh's own failures
 * arrive as a 200 body.
 */
export async function fetchPRs(
  roots: readonly string[],
  signal?: AbortSignal,
): Promise<PRListing> {
  const params = new URLSearchParams();
  for (const root of roots) params.append('root', root);
  const qs = params.toString();
  const url = qs ? `${apiPath('/api/prs')}?${qs}` : apiPath('/api/prs');
  const res = await fetch(url, signal ? { signal } : undefined);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err =
      typeof body['error'] === 'string' && body['error'] !== ''
        ? body['error']
        : `fetchPRs: HTTP ${res.status}`;
    throw new Error(err);
  }
  return parsePRListing(body);
}
