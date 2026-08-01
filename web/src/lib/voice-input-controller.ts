/**
 * voice-input-controller — singleton controller for the Web Speech API-backed
 * dictation button (<mux-mic-button> in the mobile title bar).
 *
 * Mirrors the module-level-singleton convention used by terminal-registry.ts
 * and pane-focus-coordinator.ts: this file owns all SpeechRecognition state
 * (feature detection, the session-token/generation-counter scheme, and the
 * idle/listening/error state machine); <mux-mic-button> only renders UI and
 * subscribes to this module's pub/sub API.
 *
 * See docs/designs/2026-07-31-voice-input-design.md ("Architecture" section)
 * for the full session-token rationale. Summary: every start() increments a
 * monotonic counter and captures the result as that session's token, stored
 * together with the exact { workspaceId, paneId } target being dictated into.
 * Every recognition event (real, or DEV-accessor-injected — see the bottom of
 * this file) is gated on "does my token still equal the current counter?" — a
 * mismatch means the session was invalidated (pane switch, workspace switch,
 * or component unmount) and the event is a guaranteed no-op even if it
 * arrives late. A second guard (`!_current`) additionally makes a SECOND
 * terminal event for an already-finished session a no-op even when the token
 * still matches (e.g. a real browser 'end' event arriving after this module's
 * own synthetic-result injection already finished that same session) — this
 * is what makes DEV-accessor-driven tests deterministic regardless of
 * whatever the real underlying SpeechRecognition object does in the
 * background.
 */

import { store } from '../state.js';

// ---------------------------------------------------------------------------
// Minimal Web Speech API surface. TypeScript's bundled DOM lib does not
// declare SpeechRecognition (still non-standard/experimental), so the exact
// shape this module depends on is declared locally.
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly results: SpeechRecognitionResultListLike;
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
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((ev: Event) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function _resolveCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Captured ONCE at module load — isSupported() never re-checks. A stub
// applied after this module has already executed has no effect. This is
// deliberate (see the design's Verification Approach section) and is what
// Task 7's unsupported-browser test relies on.
const _ctor: SpeechRecognitionCtor | null = _resolveCtor();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VoiceState = 'idle' | 'listening' | 'error';

export interface VoiceTarget {
  workspaceId: string;
  paneId: number;
}

export interface VoiceTranscriptPayload extends VoiceTarget {
  text: string;
}

type StateListener = (state: VoiceState) => void;
type TranscriptListener = (payload: VoiceTranscriptPayload) => void;
type ErrorListener = (message: string) => void;

interface Session {
  token: number;
  target: VoiceTarget;
  recognition: SpeechRecognitionLike;
}

// ---------------------------------------------------------------------------
// Module-level state — one session at a time, singleton across the app.
// ---------------------------------------------------------------------------

let _tokenCounter = 0;
let _current: Session | null = null;
let _state: VoiceState = 'idle';

const _stateListeners = new Set<StateListener>();
const _transcriptListeners = new Set<TranscriptListener>();
const _errorListeners = new Set<ErrorListener>();

function _setState(next: VoiceState): void {
  if (_state === next) return;
  _state = next;
  for (const cb of _stateListeners) cb(next);
}

/** Human-readable message for a SpeechRecognition error code. */
function _messageForError(code: string): string {
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

/**
 * Ends the session for `token` and returns the controller to idle — but ONLY
 * if `token` is still the current session. A stale token here means a newer
 * start() or an invalidateIfActive() already advanced the counter, and that
 * newer transition already owns idle/listening — this call is a no-op.
 */
function _finishSession(token: number): void {
  if (token !== _tokenCounter) return;
  _current = null;
  _setState('idle');
}

/**
 * Routes a finalized transcript through the token gate. Called by the real
 * recognition.onresult handler AND by the DEV accessor's inject('result').
 */
function _handleResult(token: number, text: string): void {
  if (token !== _tokenCounter || !_current) return;
  const { workspaceId, paneId } = _current.target;
  for (const cb of _transcriptListeners) cb({ text, workspaceId, paneId });
  _finishSession(token);
}

/**
 * Routes a SpeechRecognition error through the token gate. Called by the real
 * recognition.onerror handler AND by the DEV accessor's inject('error') —
 * both paths pass a raw error CODE (e.g. 'not-allowed'), mapped to a message
 * by _messageForError so both paths exercise identical logic.
 */
function _handleError(token: number, message: string): void {
  if (token !== _tokenCounter || !_current) return;
  _setState('error');
  for (const cb of _errorListeners) cb(message);
  _finishSession(token);
}

/**
 * Routes a plain `end` event through the token gate. `hadTerminalEvent` is
 * true when this session's onresult/onerror already fired (in which case
 * this is a redundant tail event and must be a strict no-op — do not even
 * re-check the token/`_current`, since a NEWER session may already be active
 * by the time this fires and this must never touch it). `hadTerminalEvent`
 * is false only for the rare iOS Safari quiet-end quirk — the ONLY case that
 * reaches the body of this function.
 */
function _handleEnd(token: number, hadTerminalEvent: boolean): void {
  if (hadTerminalEvent) return;
  if (token !== _tokenCounter || !_current) return;
  _finishSession(token);
}

/**
 * Start a new dictation session against the currently-focused workspace+pane
 * (read directly from the store — the same wire-state truth app.ts renders
 * from, not duplicated). No-ops if unsupported or a session is already active.
 */
function start(): void {
  if (!_ctor || _current) return;
  const workspaceId = store.attached ?? '';
  const paneId = store.activePaneId;
  const token = ++_tokenCounter;
  const recognition = new _ctor();
  recognition.continuous = false;
  recognition.interimResults = false;
  let _terminalFired = false;
  recognition.onresult = (ev) => {
    _terminalFired = true;
    const transcript = ev.results[0][0].transcript;
    _handleResult(token, transcript);
  };
  recognition.onerror = (ev) => {
    _terminalFired = true;
    _handleError(token, _messageForError(ev.error));
  };
  recognition.onend = () => {
    _handleEnd(token, _terminalFired);
  };
  _current = { token, target: { workspaceId, paneId }, recognition };
  _setState('listening');
  try {
    recognition.start();
  } catch {
    _handleError(token, 'Microphone unavailable');
  }
}

/** Manual stop — converges on the same result/error/end path as auto-stop
 *  (continuous:false means the browser's own silence-detection auto-stop
 *  fires the identical events). */
function stop(): void {
  if (!_current) return;
  try {
    _current.recognition.stop();
  } catch {
    // Already stopping/stopped — ignore.
  }
}

/**
 * Invalidate the in-flight session, if any.
 *
 * - With a `target`: only invalidates if the in-flight session's stored
 *   target does NOT match it (in-workspace pane switch — the new pane's
 *   identity is synchronously known).
 * - With no `target` at all: invalidates unconditionally (workspace switch,
 *   attachWithBreakpoint bootstrap/recovery, or component unmount — none of
 *   these have a comparable new-pane identity available yet).
 *
 * Either way, invalidation stops the underlying recognition immediately AND
 * bumps the token counter synchronously before returning, so any event the
 * old session still fires afterward is a guaranteed no-op.
 */
function invalidateIfActive(target?: VoiceTarget): void {
  if (!_current) return;
  if (target) {
    const t = _current.target;
    if (t.workspaceId === target.workspaceId && t.paneId === target.paneId) return;
  }
  try {
    _current.recognition.abort();
  } catch {
    // Already stopped — ignore.
  }
  _tokenCounter++;
  _current = null;
  _setState('idle');
}

export const voiceInputController = {
  isSupported(): boolean {
    return _ctor !== null;
  },
  start,
  stop,
  invalidateIfActive,
  getState(): VoiceState {
    return _state;
  },
  onStateChange(cb: StateListener): () => void {
    _stateListeners.add(cb);
    return () => _stateListeners.delete(cb);
  },
  onTranscript(cb: TranscriptListener): () => void {
    _transcriptListeners.add(cb);
    return () => _transcriptListeners.delete(cb);
  },
  onError(cb: ErrorListener): () => void {
    _errorListeners.add(cb);
    return () => _errorListeners.delete(cb);
  },
};

// ---------------------------------------------------------------------------
// DEV verification accessor — extends the SAME window.__muxterm object
// terminal-registry.ts already installs (see terminal-registry.ts:1051-1056),
// using the IDENTICAL spread pattern so neither module clobbers the other's
// keys regardless of module evaluation order. Deliberately NOT gated behind
// import.meta.env.DEV: this repo's `make dev-local` builds with plain
// `vite build --watch` (no --mode development), so import.meta.env.DEV is
// false there and a DEV-gated block would never run against it. This mirrors
// terminal-registry.ts's own accessor, which is likewise ungated.
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  (window as unknown as { __muxterm?: Record<string, unknown> }).__muxterm = {
    ...(window as unknown as { __muxterm?: Record<string, unknown> }).__muxterm,
    voiceInput: {
      /** Starts a session (same code path as a real button click) and
       *  returns its session token, so a test can capture it for later
       *  staleness checks. Returns -1 if unsupported or already active. */
      start: (): number => {
        start();
        return _current?.token ?? -1;
      },
      /** Unconditionally invalidates the in-flight session, exactly as a
       *  workspace-switch/unmount would (no target argument). */
      invalidate: (): void => {
        invalidateIfActive();
      },
      /**
       * Injects a synthetic terminal event tagged with an EXPLICIT `token`
       * (which may be stale/previously-captured), routed through the exact
       * same token-gated handlers real recognition events use.
       *   - kind 'result': `payload` is the raw transcript text.
       *   - kind 'error':  `payload` is the raw SpeechRecognition error CODE
       *     (e.g. 'not-allowed', 'no-speech') — mapped via the same
       *     _messageForError() real errors use, not a pre-formatted message.
       *   - kind 'end': `payload` is ignored (plain quiet-end case).
       */
      inject: (kind: 'result' | 'error' | 'end', token: number, payload?: string): void => {
        if (kind === 'result') _handleResult(token, payload ?? '');
        else if (kind === 'error') _handleError(token, _messageForError(payload ?? ''));
        else _handleEnd(token, false);
      },
      /** Current state, the in-flight session's target identity (or null),
       *  and its token (or null) — the token is what makes it possible to
       *  test a REAL button-click-initiated session (not just accessor
       *  .start()-initiated ones), since a real click never returns a token
       *  any other way. */
      state: (): { state: VoiceState; target: VoiceTarget | null; token: number | null } => ({
        state: _state,
        target: _current?.target ?? null,
        token: _current?.token ?? null,
      }),
    },
  };
}
