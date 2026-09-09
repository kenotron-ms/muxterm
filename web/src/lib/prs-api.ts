// ── Collected pull requests client ────────────────────────────────────────
//
// The pull requests muxterm's own sessions opened, kept after those sessions
// are gone. The server half is internal/server/prs_api.go and
// internal/server/prs_store.go.
//
// THIS IS A COLLECTOR, NOT A SEARCH. It used to be: this module used to send
// `?root=<abs>` worktree paths for the server to resolve to repositories and
// `gh pr list`. That model asked the wrong question -- a fleet of lanes works
// in many worktrees on many branches and some of them touch other repositories
// entirely, so no directory's repository is the answer -- and it produced
// `fatal: not a git repository` where a list should have been, because every
// session reports the same non-repository project path. Roots are gone. There
// is nothing to send.
//
// THE ENDPOINT ALWAYS ANSWERS 200 WITH THE LIST IT HAS, and that shapes this
// module:
//
//   - `statusAvailable:false` with a sentence in `statusError` means the
//     STATUS fetch is degraded (no gh, logged out). It does NOT mean an empty
//     list: every row still arrives with its number, title, lane and link, and
//     the applet must still render them. The old applet's whole-surface error
//     is the bug being fixed; reproducing it with a different message would be
//     the same defect.
//   - a per-row `statusError` is one row's trouble and costs nobody else
//     theirs.
//   - `prs` is never null.
//
// So a throw from fetchPRs means the TRANSPORT failed (offline, server down,
// auth middleware refused), never that GitHub did.

import { apiPath } from './base-path.js';

/** GitHub's own state word, uppercase. '' means no status fetch has ever
 * succeeded for this row -- which is NOT a claim that it is closed. */
export type PRState = '' | 'OPEN' | 'MERGED' | 'CLOSED';

const PR_STATES: readonly string[] = ['OPEN', 'MERGED', 'CLOSED'];

/** One collected pull request. Everything here is stored server-side at
 * collection time, so a row is fully meaningful after its lane is gone. */
export interface CollectedPR {
  /** "owner/name#number", or "#number" when the repository is unknown. This is
   * the key dismissal is written in. */
  key: string;
  /** '' when muxterm never learned which repository it belongs to. */
  repo: string;
  number: number;
  /** '' until a status fetch has filled it in. */
  title: string;
  /** '' when the lane declared a number but printed no link. */
  url: string;
  state: PRState;
  isDraft: boolean;
  /** Why the last status fetch failed. May be set ALONGSIDE a state, which is
   * the "showing what we last knew" case. */
  statusError: string;
  /** The workspace or lane that opened it, by name. '' when unknown. */
  lane: string;
  workspaceId: string;
  /** Unix seconds. */
  collectedAt: number;
  dismissed: boolean;
}

/** GET /api/prs. */
export interface PRListing {
  /** false when gh is missing or logged out. Describes the STATUS fetch only,
   * never the list. */
  statusAvailable: boolean;
  /** One human sentence when statusAvailable is false; '' otherwise. */
  statusError: string;
  /** Newest collected first. Never null. Includes dismissed rows, flagged. */
  prs: CollectedPR[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parsePRState(raw: unknown): PRState {
  const s = str(raw).toUpperCase();
  return PR_STATES.includes(s) ? (s as PRState) : '';
}

/** Narrow one untrusted row, defaulting anything unexpected. */
export function parseCollectedPR(raw: unknown): CollectedPR {
  const r =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    key: str(r['key']),
    repo: str(r['repo']),
    number: num(r['number']),
    title: str(r['title']),
    url: str(r['url']),
    state: parsePRState(r['state']),
    isDraft: r['isDraft'] === true,
    statusError: str(r['statusError']),
    lane: str(r['lane']),
    workspaceId: str(r['workspaceId']),
    collectedAt: num(r['collectedAt']),
    dismissed: r['dismissed'] === true,
  };
}

/**
 * Narrow untrusted JSON into a PRListing.
 *
 * A row with no `key` is dropped: the key is what dismissal is written in, so a
 * row without one could be dismissed and come straight back.
 */
export function parsePRListing(raw: unknown): PRListing {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { statusAvailable: false, statusError: '', prs: [] };
  }
  const r = raw as Record<string, unknown>;
  return {
    statusAvailable: r['statusAvailable'] === true,
    statusError: str(r['statusError']),
    prs: Array.isArray(r['prs'])
      ? (r['prs'] as unknown[]).map(parseCollectedPR).filter((p) => p.key !== '')
      : [],
  };
}

/**
 * GET /api/prs -- the whole collected list.
 *
 * No parameters. The server owns what has been collected; the browser does not
 * get to narrow it, because a browser-supplied scope is exactly the thing that
 * used to make this list wrong.
 *
 * Throws only when the transport failed -- see the header.
 */
export async function fetchPRs(signal?: AbortSignal): Promise<PRListing> {
  const res = await fetch(apiPath('/api/prs'), signal ? { signal } : undefined);
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

/**
 * POST /api/prs/dismiss -- stop showing one here.
 *
 * IT TOUCHES NOTHING ON GITHUB. The pull request is not closed, not merged, not
 * commented on; the server holds no write credential and shells out to nothing.
 * Dismissal is server-side and durable, which is the point: it survives a
 * reload, a restart, and re-collection of the same pull request tomorrow.
 */
export async function dismissPR(key: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(apiPath('/api/prs/dismiss'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err =
      typeof body['error'] === 'string' && body['error'] !== ''
        ? body['error']
        : `dismissPR: HTTP ${res.status}`;
    throw new Error(err);
  }
}
