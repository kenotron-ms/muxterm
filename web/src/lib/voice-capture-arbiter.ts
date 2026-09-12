/**
 * The one browser-local microphone ownership gate.
 *
 * A capture is never displaced by navigation or by another mode asking to
 * start. The current owner must release its own browser hardware first; the
 * next explicit user action can then acquire it. This keeps a hidden
 * dictation/session from being silently interrupted or overlapped.
 */

export type VoiceCaptureOwner = 'none' | 'composer_dictation' | 'app_conversation';

export interface VoiceCaptureSnapshot {
  readonly owner: VoiceCaptureOwner;
}

export interface VoiceCaptureAcquireResult {
  readonly ok: boolean;
  readonly owner: VoiceCaptureOwner;
}

type Listener = (snapshot: VoiceCaptureSnapshot) => void;

let owner: VoiceCaptureOwner = 'none';
const listeners = new Set<Listener>();

function publish(): void {
  const snapshot: VoiceCaptureSnapshot = Object.freeze({ owner });
  for (const listener of listeners) listener(snapshot);
}

/**
 * Reserve the microphone for one explicit capture mode. This function never
 * stops another owner; callers surface that owner and wait for its normal
 * release path instead.
 */
function acquire(next: Exclude<VoiceCaptureOwner, 'none'>): VoiceCaptureAcquireResult {
  if (owner !== 'none' && owner !== next) return Object.freeze({ ok: false, owner });
  if (owner === 'none') {
    owner = next;
    publish();
  }
  return Object.freeze({ ok: true, owner });
}

/**
 * Release only after the caller's hardware cleanup has settled. There is no
 * timeout or forced release: a browser that has not released its recognition
 * or media tracks remains unavailable rather than allowing overlapping input.
 */
async function release(
  releasing: Exclude<VoiceCaptureOwner, 'none'>,
  hardwareReleased: Promise<unknown> | undefined = undefined,
): Promise<void> {
  try {
    await hardwareReleased;
  } catch {
    // The caller has still completed its best available browser cleanup.
  }
  if (owner !== releasing) return;
  owner = 'none';
  publish();
}

export const voiceCaptureArbiter = {
  acquire,
  release,
  snapshot(): VoiceCaptureSnapshot {
    return Object.freeze({ owner });
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};