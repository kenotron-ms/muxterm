/**
 * Browser dictation for terminal input and chat composers.
 *
 * A composer capture is explicitly owned by an immutable channel/capture/
 * generation triple. Leaving that channel invalidates the triple before the
 * selection can change, so delayed Web Speech partials/finals cannot land in
 * either the old or the newly selected composer.
 */

import { store } from '../state.js';

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
  readonly isFinal?: boolean;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly results: SpeechRecognitionResultListLike;
  readonly resultIndex?: number;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function resolveCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const browser = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null;
}

const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
const ctor: SpeechRecognitionCtor | null = isAndroid ? null : resolveCtor();

export type VoiceState = 'idle' | 'listening' | 'error';

export interface TerminalVoiceTarget {
  readonly kind: 'terminal';
  readonly workspaceId: string;
  readonly paneId: number;
}

export interface ComposerVoiceTarget {
  readonly kind: 'composer';
  readonly channelId: string;
}

export type VoiceTarget = TerminalVoiceTarget | ComposerVoiceTarget;

export interface ComposerDictationCapture {
  readonly channelId: string;
  readonly captureId: string;
  readonly sttEventGeneration: number;
}

export type VoiceTranscriptPayload =
  | Readonly<{
      readonly target: 'terminal';
      readonly kind: 'partial' | 'final';
      readonly text: string;
      readonly workspaceId: string;
      readonly paneId: number;
      readonly channelId: '';
      readonly captureId: string;
      readonly sttEventGeneration: number;
    }>
  | Readonly<{
      readonly target: 'composer';
      readonly kind: 'partial' | 'final';
      readonly text: string;
      readonly workspaceId: '';
      readonly paneId: 0;
      readonly channelId: string;
      readonly captureId: string;
      readonly sttEventGeneration: number;
    }>;

interface CaptureIdentity {
  readonly captureId: string;
  readonly sttEventGeneration: number;
}

interface Session {
  readonly token: number;
  readonly target: VoiceTarget;
  readonly capture: CaptureIdentity;
  recognition: SpeechRecognitionLike;
  recognitionEnded: boolean;
  committedText: string;
  segmentText: string;
  restartTimer?: ReturnType<typeof setTimeout>;
}

type StateListener = (state: VoiceState) => void;
type TranscriptListener = (payload: VoiceTranscriptPayload) => void;
type ErrorListener = (message: string) => void;

let tokenCounter = 0;
let sttEventGeneration = 0;
let current: Session | null = null;
let state: VoiceState = 'idle';
/** Invalidated/final sessions retain ownership until their browser end event. */
const releasing = new Map<number, Session>();

const stateListeners = new Set<StateListener>();
const transcriptListeners = new Set<TranscriptListener>();
const errorListeners = new Set<ErrorListener>();

function setState(next: VoiceState): void {
  if (state === next) return;
  state = next;
  for (const listener of stateListeners) listener(next);
}

function emitError(message: string): void {
  setState('error');
  for (const listener of errorListeners) listener(message);
  setState('idle');
}

function messageForError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access denied';
    case 'no-speech':
      return 'No speech detected';
    case 'audio-capture':
      return 'Microphone unavailable';
    case 'network':
      return 'Network error';
    default:
      return 'Voice input error';
  }
}

function releaseCapture(session: Session): void {
  releasing.delete(session.token);
}

/**
 * A terminal final or fatal error fences transcript delivery until the
 * browser's end event confirms the capture ended.
 */
function finishSession(token: number, waitForEnd = true): void {
  if (token !== tokenCounter || !current) return;
  const session = current;
  if (session.restartTimer !== undefined) clearTimeout(session.restartTimer);
  current = null;
  if (waitForEnd) releasing.set(session.token, session);
  else releaseCapture(session);
  setState('idle');
}

function transcriptPayload(
  session: Session,
  kind: 'partial' | 'final',
  text: string,
): VoiceTranscriptPayload {
  if (session.target.kind === 'terminal') {
    return Object.freeze({
      target: 'terminal',
      kind,
      text,
      workspaceId: session.target.workspaceId,
      paneId: session.target.paneId,
      channelId: '',
      captureId: session.capture.captureId,
      sttEventGeneration: session.capture.sttEventGeneration,
    });
  }
  return Object.freeze({
    target: 'composer',
    kind,
    text,
    workspaceId: '',
    paneId: 0,
    channelId: session.target.channelId,
    captureId: session.capture.captureId,
    sttEventGeneration: session.capture.sttEventGeneration,
  });
}

function handleResult(token: number, kind: 'partial' | 'final', text: string): void {
  if (token !== tokenCounter || !current) return;
  const session = current;
  for (const listener of transcriptListeners) listener(transcriptPayload(session, kind, text));
  if (kind === 'final') finishSession(token);
}

function joinTranscript(first: string, second: string): string {
  return [first.trim(), second.trim()].filter(Boolean).join(' ');
}

function handleComposerResult(session: Session, event: SpeechRecognitionEventLike): void {
  if (session.token !== tokenCounter || current !== session) return;
  const parts: string[] = [];
  let interim = false;
  for (let index = 0; index < event.results.length; index++) {
    const result = event.results[index];
    if (!result?.length) continue;
    parts.push(result[0]?.transcript ?? '');
    if (result.isFinal === false) interim = true;
  }
  session.segmentText = parts.map(part => part.trim()).filter(Boolean).join(' ');
  for (const listener of transcriptListeners) {
    listener(transcriptPayload(session, interim ? 'partial' : 'final', joinTranscript(session.committedText, session.segmentText)));
  }
}

function handleError(token: number, message: string): void {
  if (token !== tokenCounter || !current) return;
  emitError(message);
  finishSession(token);
}

function handleEnd(token: number, recognition: SpeechRecognitionLike, hadTerminalEvent: boolean): void {
  const waiting = releasing.get(token);
  if (waiting?.recognition === recognition) {
    releaseCapture(waiting);
    return;
  }
  const session = current;
  if (hadTerminalEvent || token !== tokenCounter || !session || session.recognition !== recognition || session.recognitionEnded) return;
  session.recognitionEnded = true;
  if (session.target.kind === 'composer') {
    // Some browsers end even a continuous recognition after silence. Keep the
    // same capture identity and draft, then resume only after hardware release.
    session.committedText = joinTranscript(session.committedText, session.segmentText);
    session.segmentText = '';
    session.restartTimer = setTimeout(() => {
      session.restartTimer = undefined;
      if (current !== session || token !== tokenCounter) return;
      session.recognition = new ctor!();
      armRecognition(session);
    }, 300);
    return;
  }
  // This event itself is the browser's hardware-release acknowledgement.
  finishSession(token, false);
}

function armRecognition(session: Session): void {
  const { token, recognition, target } = session;
  session.recognitionEnded = false;
  recognition.continuous = target.kind === 'composer';
  recognition.interimResults = true;
  let terminalFired = false;
  recognition.onresult = (event) => {
    if (session.recognitionEnded || current?.recognition !== recognition) return;
    if (target.kind === 'composer') {
      handleComposerResult(session, event);
      return;
    }
    const from = event.resultIndex ?? 0;
    for (let index = from; index < event.results.length; index++) {
      const result = event.results[index];
      if (!result || result.length === 0) continue;
      const kind = result.isFinal === false ? 'partial' : 'final';
      if (kind === 'final') terminalFired = true;
      handleResult(token, kind, result[0]?.transcript ?? '');
      if (kind === 'final') break;
    }
  };
  recognition.onerror = (event) => {
    if (session.recognitionEnded || current?.recognition !== recognition) return;
    if (target.kind === 'composer' && event.error === 'no-speech') return;
    terminalFired = true;
    handleError(token, messageForError(event.error));
  };
  recognition.onend = () => handleEnd(token, recognition, terminalFired);
  try {
    recognition.start();
  } catch {
    handleError(token, 'Microphone unavailable');
    // start() failed before capture began, so no end event will release it.
    releaseCapture(session);
  }
}

function newCaptureId(): string | null {
  if (typeof crypto === 'undefined') return null;
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto.getRandomValues !== 'function') return null;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function startFor(target: VoiceTarget): ComposerDictationCapture | null {
  if (!ctor || current || releasing.size > 0) return null;
  const captureId = newCaptureId();
  if (!captureId) {
    emitError('A secure dictation capture ID could not be created');
    return null;
  }

  const token = ++tokenCounter;
  const capture: CaptureIdentity = Object.freeze({
    captureId,
    sttEventGeneration: ++sttEventGeneration,
  });
  const session: Session = { token, target, capture, recognition: new ctor(), recognitionEnded: false, committedText: '', segmentText: '' };
  current = session;
  setState('listening');
  armRecognition(session);

  return target.kind === 'composer'
    ? Object.freeze({
        channelId: target.channelId,
        captureId: capture.captureId,
        sttEventGeneration: capture.sttEventGeneration,
      })
    : null;
}

/** Existing terminal dictation entry point. */
function start(): void {
  startFor({
    kind: 'terminal',
    workspaceId: store.attached ?? '',
    paneId: store.activePaneId,
  });
}

/** Explicit composer dictation entry point; it never selects or submits. */
function startComposer(channelId: string): ComposerDictationCapture | null {
  if (!channelId || channelId.length > 128) return null;
  return startFor(Object.freeze({ kind: 'composer', channelId }));
}

function stop(): void {
  const session = current;
  if (!session) return;
  // A manual stop is also a transcript fence: do not accept an event emitted
  // between stop() and the browser's asynchronous end notification.
  invalidate(session);
}

function invalidate(session: Session): void {
  // Fence before invoking a browser API: abort may synchronously deliver its
  // final/end callbacks in an implementation or a recognition API fixture.
  sttEventGeneration++;
  tokenCounter++;
  if (session.restartTimer !== undefined) clearTimeout(session.restartTimer);
  if (!session.recognitionEnded) releasing.set(session.token, session);
  current = null;
  if (!session.recognitionEnded) {
    try {
      session.recognition.abort();
    } catch {
      // No end acknowledgement: retain arbitration rather than guessing that
      // another capture may start. Transcript authority is already invalid.
    }
  }
  setState('idle');
}

/**
 * Existing terminal navigation seam. A composer has separate channel
 * ownership, so pane/applet navigation cannot cancel it.
 */
function invalidateIfActive(target?: VoiceTarget): void {
  const session = current;
  if (!session) return;
  if (session.target.kind === 'composer') {
    if (target?.kind === 'composer' && target.channelId !== session.target.channelId) invalidate(session);
    return;
  }
  if (
    target?.kind === 'terminal' &&
    target.workspaceId === session.target.workspaceId &&
    target.paneId === session.target.paneId
  ) {
    return;
  }
  invalidate(session);
}

/**
 * Call synchronously before a chat composer channel is left.
 * Already accepted draft text and submitted turns live outside this controller.
 */
function invalidateComposerChannel(channelId: string): void {
  const session = current;
  if (!session || session.target.kind !== 'composer' || session.target.channelId !== channelId) return;
  invalidate(session);
}

export const voiceInputController = {
  isSupported(): boolean {
    return ctor !== null;
  },
  start,
  startComposer,
  stop,
  invalidateIfActive,
  invalidateComposerChannel,
  activeComposerCapture(): ComposerDictationCapture | null {
    const session = current;
    if (!session || session.target.kind !== 'composer') return null;
    return Object.freeze({
      channelId: session.target.channelId,
      captureId: session.capture.captureId,
      sttEventGeneration: session.capture.sttEventGeneration,
    });
  },
  getState(): VoiceState {
    return state;
  },
  onStateChange(listener: StateListener): () => void {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  },
  onTranscript(listener: TranscriptListener): () => void {
    transcriptListeners.add(listener);
    return () => transcriptListeners.delete(listener);
  },
  onError(listener: ErrorListener): () => void {
    errorListeners.add(listener);
    return () => errorListeners.delete(listener);
  },
};
