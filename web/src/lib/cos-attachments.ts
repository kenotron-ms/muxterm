// cos-attachments.ts — the browser half of Mission Control composer attachments.
//
// Three jobs, and nothing else:
//   1. stage a chosen/dropped/pasted file through POST /api/cos/attachments
//   2. hold the composer's staged list, with a status per row
//   3. parse the server's reference block back out of a delivered prompt
//
// (3) is what makes history work. The server composes ONE string — the
// person's text plus a sentinel-delimited block naming each file — and that
// string is what the queue carries, what the sidecar executes, and what the
// transcript keeps. Rendering chips therefore means parsing the same block
// back out, on every path: the live receipt, the queue replay, and a history
// replay from a conversation that was written weeks ago. One serialization,
// one parser, and a reloaded tab shows exactly what the Operator received.
//
// Attachment bytes are never fetched back from the server. A preview is a
// local object URL over the File the person just chose, so there is no
// read-back route to authorize and nothing to leak. A chip restored from
// history has no preview, which is honest: those bytes are not in this tab.

import { apiPath } from './base-path';

/** Server-declared attachment policy, delivered on cos-subscribe-result. */
export interface CosAttachmentPolicy {
  readonly enabled: boolean;
  readonly reason: string;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly textMaxBytes: number;
  readonly accept: readonly string[];
}

export const COS_ATTACHMENTS_OFF: CosAttachmentPolicy = {
  enabled: false,
  reason: '',
  maxFiles: 0,
  maxFileBytes: 0,
  textMaxBytes: 0,
  accept: [],
};

/** One attachment as it is named in a delivered prompt's reference block. */
export interface CosAttachmentRef {
  readonly name: string;
  readonly mediaType: string;
  /** Already human-formatted by the server, e.g. "184 KB". */
  readonly size: string;
  readonly path: string;
  /**
   * Local object URL, when THIS tab is the one that uploaded the file and
   * still holds it. Always '' for an attachment parsed out of a replay: those
   * bytes live on the server's disk and are deliberately not fetchable.
   */
  readonly previewUrl: string;
}

export type CosDraftAttachmentStatus = 'uploading' | 'ready' | 'failed';

/** One row in the composer's staged list. */
export interface CosDraftAttachment {
  /** Stable across the row's life; the server id is absent until ready. */
  readonly localId: string;
  id: string;
  readonly name: string;
  readonly size: number;
  kind: string;
  mediaType: string;
  status: CosDraftAttachmentStatus;
  message: string;
  progress: number;
  /** Local object URL for an image preview, or '' — never a server URL. */
  previewUrl: string;
  abort: AbortController | null;
}

export interface CosAttachmentUploadResult {
  readonly status: string;
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly size: number;
  readonly message: string;
}

function str(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  return typeof value === 'string' ? value : '';
}

function num(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function parseCosAttachmentPolicy(raw: unknown): CosAttachmentPolicy {
  if (!raw || typeof raw !== 'object') return COS_ATTACHMENTS_OFF;
  const row = raw as Record<string, unknown>;
  const accept = Array.isArray(row.accept)
    ? row.accept.filter((e): e is string => typeof e === 'string')
    : [];
  return {
    enabled: row.enabled === true,
    reason: str(row, 'reason'),
    maxFiles: num(row, 'max_files'),
    maxFileBytes: num(row, 'max_file_bytes'),
    textMaxBytes: num(row, 'text_max_bytes'),
    accept,
  };
}

function parseUploadResult(raw: unknown): CosAttachmentUploadResult {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    status: str(row, 'status'),
    id: str(row, 'id'),
    name: str(row, 'name'),
    kind: str(row, 'kind'),
    mediaType: str(row, 'media_type'),
    size: num(row, 'size'),
    message: str(row, 'message'),
  };
}

/**
 * Stage one file. XMLHttpRequest for the same reason the Files applet uses it:
 * fetch has no upload progress, and a person who dropped an 8 MB screenshot
 * needs to see that something is happening.
 */
export function uploadCosAttachment(
  file: File,
  signal: AbortSignal,
  onProgress: (loaded: number, total: number) => void,
): Promise<CosAttachmentUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiPath('/api/cos/attachments'));
    xhr.responseType = 'json';
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Muxterm-Cos-Attachment', '1');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onerror = () =>
      reject(new Error('That file could not reach muxterm. Nothing was saved.'));
    xhr.onabort = () => reject(new DOMException('Attachment cancelled.', 'AbortError'));
    xhr.onload = () => {
      const raw =
        xhr.response ??
        (() => {
          try {
            return JSON.parse(xhr.responseText) as unknown;
          } catch {
            return {};
          }
        })();
      const result = parseUploadResult(raw);
      if (xhr.status >= 200 && xhr.status < 300 && result.status === 'ready' && result.id) {
        resolve(result);
        return;
      }
      reject(new Error(result.message || 'That file could not be attached. Nothing was saved.'));
    };
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

/**
 * Take one staged attachment back off the server.
 *
 * Best effort by design: the caller has already removed the row, and the
 * staged TTL is the backstop if this never lands. It is fire-and-forget so a
 * slow or failed discard cannot make removing a chip feel broken.
 */
export function discardCosAttachment(id: string): void {
  if (!id) return;
  void fetch(apiPath(`/api/cos/attachments/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-Muxterm-Cos-Attachment': '1' },
  }).catch(() => {
    // The staged TTL sweeps it either way.
  });
}

// --- the reference block ---------------------------------------------------

// Must match internal/server/cos_attachments.go exactly. This pair is a wire
// contract between the server that writes the block and every browser that
// renders a turn containing one.
const BLOCK_OPEN = '[muxterm-attachments]';
const BLOCK_CLOSE = '[/muxterm-attachments]';

// "- name (media/type, 184 KB) -> /abs/path". Greedy on the name is wrong
// (a name may contain parentheses), so anchor on the LAST " -> " and the last
// parenthesised group instead.
const LINE = /^- (.+) \(([^(),]+), ([^(),]+)\) -> (.+)$/;

export interface CosPromptSplit {
  /** What the person actually typed. */
  readonly text: string;
  readonly attachments: readonly CosAttachmentRef[];
}

/**
 * Split a delivered prompt into the person's text and the attachments the
 * server named.
 *
 * Deliberately strict and trailing-only: the block must be the LAST thing in
 * the prompt, its sentinels must each stand alone on their own line, and every
 * line between them must parse. Anything else is left untouched as ordinary
 * text, because a half-recognized block rendered as chips would be a worse lie
 * than showing the raw line.
 */
export function splitAttachmentBlock(prompt: string): CosPromptSplit {
  if (!prompt.endsWith(BLOCK_CLOSE)) return { text: prompt, attachments: [] };
  const body = prompt.slice(0, prompt.length - BLOCK_CLOSE.length);
  // The close sentinel owns its own line.
  if (body.length > 0 && !body.endsWith('\n')) return { text: prompt, attachments: [] };

  const openAt = body.lastIndexOf(BLOCK_OPEN + '\n');
  if (openAt < 0) return { text: prompt, attachments: [] };
  // ...and so does the open sentinel.
  if (openAt > 0 && body[openAt - 1] !== '\n') return { text: prompt, attachments: [] };

  const lines = body.slice(openAt + BLOCK_OPEN.length + 1, body.length - 1).split('\n');
  const attachments: CosAttachmentRef[] = [];
  for (const line of lines) {
    if (line === '') continue;
    const m = LINE.exec(line);
    if (!m) return { text: prompt, attachments: [] };
    attachments.push({ name: m[1], mediaType: m[2], size: m[3], path: m[4], previewUrl: '' });
  }
  if (attachments.length === 0) return { text: prompt, attachments: [] };
  return { text: body.slice(0, openAt).replace(/\n+$/, ''), attachments };
}

/** Is this media type one the browser can draw inline? */
export function isImageMedia(mediaType: string): boolean {
  return mediaType.startsWith('image/');
}

export function humanBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} KB`;
  return `${n} B`;
}

/**
 * Does this file's NAME look attachable under the server's policy? A local
 * pre-check only: the server re-derives the type from the name and then proves
 * it against the file's leading bytes, and that is the decision that counts.
 * This exists so a person who drags a folder of twelve videos sees twelve
 * immediate refusals instead of twelve round trips.
 */
export function acceptableName(name: string, policy: CosAttachmentPolicy): boolean {
  const lower = name.toLowerCase();
  return policy.accept.some((ext) => lower.endsWith(ext));
}
