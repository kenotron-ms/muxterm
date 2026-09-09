// ── Artifact client ─────────────────────────────────────────────────────────
//
// One local file, read for the viewer. The server half is
// internal/server/artifact_api.go and its contract is the comment at the top of
// that file; this module is the browser's half of it.
//
// THE ONE THING TO KNOW ABOUT THIS WIRE SHAPE: `kind` is not this module's
// opinion and must never become one. It is computed server-side by
// publicationKindFor() -- the same function that decides how a PUBLISHED file
// is served -- so a viewer that switches on it is showing what a recipient of
// the public link would see. A second classification in the frontend ("well,
// .html could render if we sandboxed it") is precisely the divergence the
// viewer exists to prevent, and it would put the softer rule on the side of the
// wire that holds the user's session.
//
// Every read goes through a narrowing function with a default per field, for
// files-api.ts's reason: `await res.json()` is `any`, and one bare cast puts an
// undefined where the applet expects a string forever after.

import { apiPath } from './base-path.js';

/**
 * How the file is presented. Mirrors publicationKind in
 * internal/server/publish.go.
 *
 *   markdown  rendered as a document, by the SAME renderer the public page
 *             uses (lib/markdown-stream + lib/markdown-view)
 *   text      shown as characters, monospace, not parsed as anything
 *   image     drawn
 *   download  never rendered in this origin -- HTML, SVG, PDF, archives,
 *             binaries and every unrecognised type. See A4 in the viewer.
 */
export type ArtifactKind = 'markdown' | 'text' | 'image' | 'download';

const KINDS: readonly string[] = ['markdown', 'text', 'image', 'download'];

/** GET /api/artifact. */
export interface Artifact {
  path: string;
  name: string;
  size: number;
  /** unix seconds */
  modified: number;
  kind: ArtifactKind;
  contentType: string;
  /** Populated for markdown and text only; '' for everything else. */
  text: string;
  /** Past the size bound. The metadata is real; the bytes were never read. */
  tooLarge: boolean;
  /** The bound itself, so the viewer states the server's number, not a copy. */
  maxBytes: number;
  /** Classified as text but not decodable as UTF-8. */
  binary: boolean;
}

function str(raw: Record<string, unknown>, k: string): string {
  const v = raw[k];
  return typeof v === 'string' ? v : '';
}

function num(raw: Record<string, unknown>, k: string): number {
  const v = raw[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function bool(raw: Record<string, unknown>, k: string): boolean {
  return raw[k] === true;
}

export function parseArtifact(raw: unknown): Artifact {
  const o = (raw ?? {}) as Record<string, unknown>;
  const kind = str(o, 'kind');
  return {
    path: str(o, 'path'),
    name: str(o, 'name'),
    size: num(o, 'size'),
    modified: num(o, 'modified'),
    // An unknown kind falls to `download`, which is the kind that renders
    // NOTHING. A parser that guessed the other way would turn a server this
    // browser does not understand into an inline-render decision.
    kind: (KINDS.includes(kind) ? kind : 'download') as ArtifactKind,
    contentType: str(o, 'contentType'),
    text: str(o, 'text'),
    tooLarge: bool(o, 'tooLarge'),
    maxBytes: num(o, 'maxBytes'),
    binary: bool(o, 'binary'),
  };
}

/**
 * GET /api/artifact?path=<absolute path>.
 *
 * `signal` is how the applet honours the inactive rule: an applet that goes
 * inactive mid-flight aborts, and an aborted fetch rejects with an AbortError
 * the caller is expected to ignore rather than render.
 *
 * Throws the server's own `error` sentence on any non-2xx, so the applet shows
 * "/gone does not exist" rather than "HTTP 404".
 */
export async function fetchArtifact(path: string, signal?: AbortSignal): Promise<Artifact> {
  const url = `${apiPath('/api/artifact')}?${new URLSearchParams({ path }).toString()}`;
  const res = await fetch(url, signal ? { signal } : undefined);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err =
      typeof body['error'] === 'string' && body['error'] !== ''
        ? body['error']
        : `fetchArtifact: HTTP ${res.status}`;
    throw new Error(err);
  }
  return parseArtifact(body);
}

/** The bytes of one file: an <img> source, or a download target. */
export function artifactRawURL(path: string): string {
  return `${apiPath('/api/artifact/raw')}?${new URLSearchParams({ path }).toString()}`;
}

/**
 * The published-document stylesheet, fetched once per page.
 *
 * It comes from the SERVER (publicDocCSS, the exact bytes inlined into every
 * /p/{id} page) rather than living here, which is what makes the viewer and
 * the published page agree on the PAGE and not merely on the elements. A copy
 * of those rules in this repo would agree the day it was written and drift on
 * the first change to either side.
 *
 * Cached in a module-level promise: every artifact rendered in this tab wants
 * the same bytes, and the applet must not re-fetch a stylesheet per document.
 */
let docCSSPromise: Promise<string> | null = null;

export function fetchDocCSS(): Promise<string> {
  docCSSPromise ??= fetch(apiPath('/api/artifact/doc.css')).then((res) => {
    if (!res.ok) throw new Error(`fetchDocCSS: HTTP ${res.status}`);
    return res.text();
  });
  return docCSSPromise;
}
