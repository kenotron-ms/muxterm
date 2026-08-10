# Voice Input Implementation Plan

> **For execution:** Use `/build-like-ken` mode.

**Goal:** Add a dedicated `<mux-mic-button>` to muxterm's mobile title bar that dictates text into the focused terminal pane via the Web Speech API, per `docs/designs/2026-07-31-voice-input-design.md`.

**Architecture:** A singleton controller (`web/src/lib/voice-input-controller.ts`) owns all `SpeechRecognition` state — feature detection, the session-token/generation-counter scheme, and the `idle → listening → (idle|error)` state machine — mirroring `terminal-registry.ts`/`pane-focus-coordinator.ts`'s existing singleton-module convention. A thin Lit component (`web/src/components/mic-button.ts`) renders UI and delegates to it. `title-bar.ts` mounts the button; `app.ts` owns pane/workspace-switch invalidation and transcript delivery (`sendPaneInput` + focus restoration).

**Tech Stack:** TypeScript, Lit 3, Web Speech API (`SpeechRecognition`/`webkitSpeechRecognition` — not in TypeScript's bundled DOM lib, so this plan declares the exact minimal surface needed locally).

**Verification approach:** Real execution only, per this repo's `AGENTS.md` (unit tests are banned). Every task is verified against `make dev-local` (`http://127.0.0.1:8313`, **never** 127.0.0.1:8311/production) via `playwright-cli`, using a fresh workspace/pane per run. Two tasks (1 and 2) build a module with no reachable seam yet — their verification is honestly deferred to the exact later task that wires them in, rather than fabricating a check. A final section lists what still requires a human with a real phone.

---

## Before You Start

**Critical environment fact, confirmed by reading `web/vite.config.ts`:** `make dev-local` runs `vite build --watch` with no `--mode development` flag, so it builds in **production mode** — `import.meta.env.DEV` is `false`. This means the `import.meta.env.DEV`-gated test accessors already in `app.ts` (`window.__muxStore`, `window.__muxRegistry`, `window.__muxFirstPaneId`, etc., at `app.ts:1172-1211`) are **compiled out and unavailable** against dev-local. The **only** always-available test seam is the ungated `window.__muxterm` object installed unconditionally by `terminal-registry.ts:1051-1056` (`if (typeof window !== 'undefined')`, no DEV check). This is exactly why the design specifies extending that same object — it is confirmed to be the one seam that actually works in this environment. Every verification step below uses only `window.__muxterm.*`.

Read these files once before starting — the tasks below reference their exact current contents:

- `web/src/lib/terminal-registry.ts` — the singleton-module convention to mirror (plain exported object with closure state), and the **exact** `window.__muxterm` spread pattern at lines 1051-1056, and `focus(paneId)` at line 850, and `snapshot(paneId)` at line 1044 (returns `StructuredSnapshot` with a `rowText: string[]` field — this is how you'll prove text landed in a terminal without DOM scraping).
- `web/src/lib/pane-focus-coordinator.ts` — the other singleton-module style reference (class-based this time, but same "owns real DOM/API state, thin consumer" shape).
- `web/src/state.ts` (`MuxStore`) — `store.attached` (current workspaceId, `string | null`), `store.activePaneId` (`number`), `store.panes` (`SessiondPaneInfo[]`).
- `web/src/types.ts` — `isTerminalSurface(kind)`, `SurfaceKind`, `SessiondPaneInfo.surfaceKind` (optional).
- `web/src/lib/theme.ts` — `--chrome-*` tokens (`applyChromeTokens`); no dedicated "recording" token exists, so listening state reuses `--chrome-danger` (confirmed precedent: `app.ts`'s `.ws-create-confirm` already does `background: var(--chrome-accent); color: var(--chrome-body);` — the same "accent background + chrome-body text/icon" pattern this plan reuses with `--chrome-danger`).
- `web/src/lib/icons.ts` — the `icon(iconNode, { size })` helper.
- `web/src/ws.ts` — `sendPaneInput(paneId, data)` at line 66.
- `web/src/components/title-bar.ts` — current 191-line file, to be modified.
- `web/src/app.ts` — current 1212-line file; `_onActivePane` (line 844), `_onWorkspaceSelected` (line 992), `render()` (line 685).
- `web/src/components/mux-undo-toast.ts` — styling/positioning/44px-touch-target **precedent only** (this plan does NOT reuse its component or its undo/countdown logic — the mic button's toast is a small inline block in `mic-button.ts` itself).

None of this code gets unit tests. `AGENTS.md` bans them outright.

---

### Fresh-workspace helper (used by every browser-verification task below)

Because `AGENTS.md`'s "Verification hygiene" section requires a brand-new workspace/pane for every run, and the mobile (narrow) pane-picker UI has no "create workspace" control (only the wide-layout sidebar does — confirmed by reading `mux-sidebar.ts` line 335/461 vs `mux-pane-picker.ts`), every verification run starts wide, creates a workspace, then narrows:

```bash
playwright-cli open http://127.0.0.1:8313
playwright-cli resize 1024 800
playwright-cli snapshot
# Click "+ New workspace" in the sidebar (ref will differ per snapshot — read it from the snapshot output)
playwright-cli click <ref-for-"+ New workspace">
playwright-cli fill <ref-for-workspace-name-input> "voice-test-<taskname>"
playwright-cli press Enter
playwright-cli resize 390 844
playwright-cli snapshot
```

Confirm from the snapshot that `mux-title-bar` is now present (it only renders when narrow) and that exactly one pane exists (the one-terminal-per-workspace auto-spawn). Do this once per task's verification, with a unique workspace name suffix, never reusing a prior run's workspace.

---

### Task 1: Controller core — state machine, session tokens, start/stop/invalidate

**Files:**
- Create: `web/src/lib/voice-input-controller.ts`

**Implementation**

```typescript
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
```

Do not add the `window.__muxterm` block yet — that is Task 2, appended to the end of this same file.

**Static Analysis**
```
cd web && npm run check:fast
```
Expected: no errors (this runs `typecheck:fast` + `lint:fast`, the exact pre-commit gate this repo's `AGENTS.md` requires).

**Verification**

This module is not imported anywhere yet — `<mux-mic-button>` (which will import it) doesn't exist until Task 3, and even Task 3's component isn't mounted into the live app until Task 4. Nothing in this file is reachable from a running browser yet, so there is no real-execution proof possible for this task in isolation — fabricating one would violate this plan's evidence standard. Static analysis above is the only honest check available right now. Real behavioral proof of everything added in this task begins at Task 5 (full click → listening → transcript pipeline) and is completed by Task 6 (session-token/staleness invalidation) and Task 7 (unsupported-browser / error paths) — both of which exercise every function this task adds.

**Commit**
```bash
git add web/src/lib/voice-input-controller.ts
git commit -m "feat(voice-input): controller core — state machine + session tokens

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: DEV verification accessor — `window.__muxterm.voiceInput`

**Files:**
- Modify: `web/src/lib/voice-input-controller.ts` (append to the end)

**Implementation**

Append this block at the very end of the file created in Task 1:

```typescript

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
```

**Static Analysis**
```
cd web && npm run check:fast
```
Expected: no errors.

**Verification**

Same situation as Task 1: nothing imports this module yet, so `window.__muxterm.voiceInput` does not exist in a running browser until Task 3 wires `mic-button.ts` in (which transitively pulls this module into the bundle) and Task 4 mounts that component into the live title bar. There is nothing to run yet — fabricating a browser check here would not prove anything real. This accessor's actual behavior (start/invalidate/inject/state, and the token-gate correctness they all depend on) is proven end-to-end in Task 5 (transcript delivery), Task 6 (invalidation/staleness — this accessor is literally what Task 6 is built on), and Task 7 (error injection).

**Commit**
```bash
git add web/src/lib/voice-input-controller.ts
git commit -m "feat(voice-input): add window.__muxterm.voiceInput DEV accessor

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: `<mux-mic-button>` component

**Files:**
- Create: `web/src/components/mic-button.ts`

**Implementation**

```typescript
/**
 * <mux-mic-button> — dedicated dictation button for the mobile title bar.
 *
 * Thin Lit component: all SpeechRecognition state lives in
 * voice-input-controller.ts (a singleton, imported here, never instantiated
 * per-component). This component only renders UI, subscribes to the
 * controller's pub/sub API, and forwards its own DOM events.
 *
 * See docs/designs/2026-07-31-voice-input-design.md's "Visual & UX Spec" and
 * "Architecture" sections for the full rationale behind each state below.
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { icon } from '../lib/icons.js';
import { Mic, MicOff } from 'lucide';
import { isTerminalSurface } from '../types.js';
import { voiceInputController, type VoiceState } from '../lib/voice-input-controller.js';

@customElement('mux-mic-button')
export class MuxMicButton extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
    }

    .mic-btn {
      width: var(--mux-dock-height, 44px);
      height: var(--mux-dock-height, 44px);
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--chrome-text-bright);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-family: inherit;
    }

    .mic-btn:hover:not(:disabled) {
      background: var(--chrome-hover);
    }

    .mic-btn.listening {
      background: var(--chrome-danger);
      color: var(--chrome-body);
      animation: mic-pulse 1.5s ease-in-out infinite;
    }

    .mic-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    @keyframes mic-pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--chrome-danger) 55%, transparent);
      }
      50% {
        box-shadow: 0 0 0 6px color-mix(in srgb, var(--chrome-danger) 0%, transparent);
      }
    }

    .toast {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 950;
      min-width: 240px;
      max-width: 92vw;
      box-sizing: border-box;
      min-height: 44px;
      padding: 10px 14px;
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-radius: 8px;
      color: var(--chrome-text-bright);
      font-size: 13px;
      text-align: center;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }

    button .lucide-icon {
      pointer-events: none;
    }
  `;

  @state() private _version = 0;
  @state() private _voiceState: VoiceState = voiceInputController.getState();
  @state() private _toastMessage: string | null = null;

  private _unsubscribeStore: (() => void) | null = null;
  private _unsubscribeState: (() => void) | null = null;
  private _unsubscribeTranscript: (() => void) | null = null;
  private _unsubscribeError: (() => void) | null = null;
  private _toastTimer: ReturnType<typeof setTimeout> | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this._unsubscribeStore = store.subscribe(() => {
      this._version++;
    });
    this._unsubscribeState = voiceInputController.onStateChange((s) => {
      this._voiceState = s;
    });
    this._unsubscribeTranscript = voiceInputController.onTranscript((payload) => {
      this.dispatchEvent(
        new CustomEvent('voice-transcript', {
          bubbles: true,
          composed: true,
          detail: payload,
        }),
      );
    });
    this._unsubscribeError = voiceInputController.onError((message) => {
      this._showToast(message);
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribeStore?.();
    this._unsubscribeStore = null;
    this._unsubscribeState?.();
    this._unsubscribeState = null;
    this._unsubscribeTranscript?.();
    this._unsubscribeTranscript = null;
    this._unsubscribeError?.();
    this._unsubscribeError = null;
    if (this._toastTimer !== undefined) clearTimeout(this._toastTimer);
    // The title bar (and this component with it) unmounts entirely on the
    // narrow-to-wide breakpoint transition. Without this, the singleton
    // controller could keep an orphaned recognition session running with no
    // visible UI control over it.
    voiceInputController.invalidateIfActive();
  }

  private _showToast(message: string): void {
    if (this._toastTimer !== undefined) clearTimeout(this._toastTimer);
    this._toastMessage = message;
    this._toastTimer = setTimeout(() => {
      this._toastMessage = null;
      this._toastTimer = undefined;
    }, 3000);
  }

  private _onClick = (): void => {
    if (this._voiceState === 'listening') {
      voiceInputController.stop();
    } else {
      voiceInputController.start();
    }
  };

  override render() {
    // Reactive dependency on store changes (pane focus/kind can change on
    // every tab switch).
    void this._version;

    if (!voiceInputController.isSupported()) return html``;

    const activePane = store.panes.find((p) => p.paneId === store.activePaneId);
    const kind = activePane?.surfaceKind ?? 'terminal';
    const hasValidTarget = !!activePane && isTerminalSurface(kind);
    const listening = this._voiceState === 'listening';

    const label = !hasValidTarget
      ? 'Voice input requires a terminal pane'
      : listening
        ? 'Stop voice input'
        : 'Start voice input';

    return html`
      <button
        class="mic-btn ${listening ? 'listening' : ''}"
        title="${label}"
        aria-label="${label}"
        ?disabled="${!hasValidTarget}"
        @click="${this._onClick}"
      >${icon(listening ? MicOff : Mic, { size: 18 })}</button>
      ${this._toastMessage ? html`<div class="toast" role="alert">${this._toastMessage}</div>` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-mic-button': MuxMicButton;
  }
}
```

**Static Analysis**
```
cd web && npm run check:fast
```
Expected: no errors.

**Verification**

`<mux-mic-button>` is defined (and its Lit `@customElement` decorator registers it in the browser's custom-element registry the moment this module is imported) but nothing imports `mic-button.ts` yet and no `<mux-mic-button>` element exists anywhere in the app's rendered templates. There is no live instance for `playwright-cli` to observe. Task 4 (mounting it into `title-bar.ts`) is the first point this component becomes reachable, and its verification step below covers rendering, sizing, idle state, and disabled state for the code added in this task.

**Commit**
```bash
git add web/src/components/mic-button.ts
git commit -m "feat(voice-input): add <mux-mic-button> component

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: Mount `<mux-mic-button>` in the title bar

**Files:**
- Modify: `web/src/components/title-bar.ts`

**Implementation**

Add the side-effect import next to the other child-component imports (currently lines 4-5):

```typescript
import './launcher-menu.js';
import './mux-pane-picker.js';
import './mic-button.js';
```

Add a `gap` to `.right` so the new mic button and the kebab button don't visually collide (currently lines 51-55):

```typescript
    .right {
      display: flex;
      align-items: center;
      gap: 4px;
      position: relative;
    }
```

Mount `<mux-mic-button>` as the first child of `.right`, before the launcher button, so DOM order matches the design's `[brand] [pane-picker] [mic] [kebab]` layout (`<mux-pane-picker>` is a flex sibling of `.right`, not inside it, so placing the mic button first inside `.right` puts it immediately after the pane-picker in the overall row). Currently lines 169-182:

```typescript
      <mux-pane-picker @workspace-switch="${this._onWorkspaceSwitch}"></mux-pane-picker>
      <div class="right">
        <mux-mic-button></mux-mic-button>
        <button
          class="launcher-btn"
          title="Open menu"
          @click="${this._toggleMenu}"
        >${icon(Ellipsis, { size: 16 })}</button>
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu
                @launcher-action="${this._onLauncherAction}"
              ></mux-launcher-menu>
            </div>`
          : ''}
      </div>
```

**Static Analysis**
```
cd web && npm run check:fast
```
Expected: no errors.

**Verification**

Follow the "Fresh-workspace helper" above (workspace name e.g. `voice-test-task4`) to get to a narrow-layout view with `mux-title-bar` present and one terminal pane.

Step A — disabled state, exploiting the real (not simulated) pre-connection gap. `store.activePaneId` defaults to `0` and `store.panes` is empty until the first `Composition` reply round-trips over the WebSocket, so the mic button is genuinely disabled for a brief real window right after navigation, before any pane exists to target:

```bash
playwright-cli open http://127.0.0.1:8313
playwright-cli resize 1024 800
playwright-cli snapshot
playwright-cli click <ref for "+ New workspace">
playwright-cli fill <ref for name input> "voice-test-task4"
playwright-cli press Enter
playwright-cli resize 390 844
playwright-cli --raw eval "(() => {
  const btn = document.querySelector('mux-app').shadowRoot
    .querySelector('mux-title-bar').shadowRoot
    .querySelector('mux-mic-button').shadowRoot
    .querySelector('.mic-btn');
  return btn ? { disabled: btn.disabled, label: btn.getAttribute('aria-label') } : null;
})()"
```
Expected (if captured quickly enough after the resize, before the composition round-trip settles): `{"disabled":true,"label":"Voice input requires a terminal pane"}`. If the composition already settled by the time this runs (round-trips on localhost are fast), you will instead see Step B's result — that is fine; it means the enabled path below is what to confirm and the disabled path is confirmed structurally by code inspection (`hasValidTarget = !!activePane && ...`) plus Task 6/7's use of the accessor, which never depend on this transient window.

Step B — enabled/idle state, sizing, and DOM position (wait for composition to settle):
```bash
playwright-cli run-code "async page => {
  await page.waitForTimeout(1500);
  return await page.evaluate(() => {
    const right = document.querySelector('mux-app').shadowRoot
      .querySelector('mux-title-bar').shadowRoot
      .querySelector('.right');
    const mic = right.querySelector('mux-mic-button');
    const btn = mic.shadowRoot.querySelector('.mic-btn');
    const rect = btn.getBoundingClientRect();
    return {
      firstChildIsMic: right.children[0] === mic,
      secondChildIsLauncher: right.children[1].classList.contains('launcher-btn'),
      disabled: btn.disabled,
      label: btn.getAttribute('aria-label'),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
}"
```
Expected: `firstChildIsMic: true`, `secondChildIsLauncher: true`, `disabled: false`, `label: "Start voice input"`, `width: 44`, `height: 44`.

**Commit**
```bash
git add web/src/components/title-bar.ts
git commit -m "feat(voice-input): mount mic button in mobile title bar

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: `app.ts` wiring — invalidation calls + transcript delivery + focus restoration

**Files:**
- Modify: `web/src/app.ts`

**Implementation**

Add the import next to the other `lib/` imports (currently line 11-12):

```typescript
import { applyThemeTokens, applyChromeTokens, resolvePalette } from './lib/theme.js';
import { injectTerminalFont } from './lib/fonts.js';
import { voiceInputController } from './lib/voice-input-controller.js';
```

Bind the new `voice-transcript` listener on `<mux-title-bar>`, alongside the existing `@pane-select`/`@workspace-switch` bindings (currently lines 692-696):

```typescript
      ${!isWide ? html`<mux-title-bar
        @launcher-action="${this._onLauncherAction}"
        @pane-select="${this._onActivePane}"
        @workspace-switch="${this._onWorkspaceSelected}"
        @voice-transcript="${this._onVoiceTranscript}"
      ></mux-title-bar>` : ''}
```

Add the invalidation call at the very start of `_onActivePane` (currently lines 844-851) — called unconditionally on every pane selection; `invalidateIfActive`'s own target-comparison logic already makes this a no-op when there's no in-flight session or the target already matches:

```typescript
  /** Client-local active-pane selection (sessiond has no select-pane message). */
  private _onActivePane = (e: CustomEvent<{ paneId: number }>): void => {
    // Auto-stop-and-invalidate: voice input should always target "the pane
    // I'm looking at right now" — see docs/designs/2026-07-31-voice-input-design.md.
    voiceInputController.invalidateIfActive({ workspaceId: store.attached ?? '', paneId: e.detail.paneId });
    // ackPane is the component's responsibility (mux-pane-picker._selectPane or
    // mux-dock onDidActivePanelChange). Do not ack here \u2014 the component already did.
    store.setActivePane(e.detail.paneId);
    // This pane just became the visible tab in this client's layout, so it
    // should claim PTY-sizing authority (active-view-wins).
    this._paneFocusCoordinator?.claimPane(e.detail.paneId);
  };
```

Add the unconditional invalidation call to `_onWorkspaceSelected`, right after its existing early-return guard so a same-workspace reselect (a no-op switch) doesn't needlessly invalidate anything (currently lines 992-1007):

```typescript
  private _onWorkspaceSelected = (e: CustomEvent<{ workspaceId: string }>): void => {
    if (e.detail.workspaceId === store.attached) return;
    // Workspace switches are asynchronous (new pane list/active pane arrive
    // only after a round-trip), so there is no new-workspace pane identity to
    // compare against yet \u2014 invalidate unconditionally. See
    // docs/designs/2026-07-31-voice-input-design.md.
    voiceInputController.invalidateIfActive();
    // _pendingCloses: grace period only \u2014 closePane was never sent, PTY survives on server.
    for (const handle of this._pendingCloses.values()) clearTimeout(handle);
    this._pendingCloses.clear();
    this._pendingClosesMeta.clear();
    // _closingPanes: closePane was already sent, PTY is dying. Call allowReconcile so the
    // reconciler doesn't recreate phantom terminals for panes whose close is in-flight.
    this._dock?.allowReconcile([...this._closingPanes]);
    this._closingPanes.clear();
    this.requestUpdate();
    // Do NOT call disposeAll() \u2014 workspace-scoped composite keys in
    // terminalRegistry isolate paneIds across workspaces, so old terminals
    // stay alive with their scrollback until explicitly pruned or disposed.
    this._socket?.attachWithBreakpoint(e.detail.workspaceId, currentLayoutMode());
  };
```

Add the new `_onVoiceTranscript` handler. Place it directly after `_onActivePane` for locality:

```typescript
  /**
   * Deliver a dictated transcript to the terminal it was captured for.
   * Defense-in-depth only \u2014 by the time this fires, the primary invalidation
   * (pane/workspace-switch calling invalidateIfActive above) should already
   * have stopped any session whose target no longer matches. See
   * docs/designs/2026-07-31-voice-input-design.md's Data Flow section.
   */
  private _onVoiceTranscript = (e: CustomEvent<{ text: string; workspaceId: string; paneId: number }>): void => {
    const { text, workspaceId, paneId } = e.detail;
    if (workspaceId !== (store.attached ?? '') || paneId !== store.activePaneId) return;
    this._socket?.sendPaneInput(paneId, new TextEncoder().encode(text));
    // Tapping the mic button (a toolbar UI element) can take DOM focus away
    // from xterm's hidden textarea. Without this, the user's next physical
    // keystroke (Enter) might not reach the PTY at all.
    terminalRegistry.focus(paneId);
  };
```

**Static Analysis**
```
cd web && npm run check:fast
```
Expected: no errors.

**Verification**

This is the first task where the FULL pipeline (button click → controller → CustomEvent → app.ts → `sendPaneInput` → real PTY → real shell echo → back into the terminal → focus restored) is reachable end-to-end. Follow the fresh-workspace helper (`voice-test-task5`), then:

```bash
playwright-cli open http://127.0.0.1:8313
playwright-cli resize 1024 800
playwright-cli snapshot
playwright-cli click <ref for "+ New workspace">
playwright-cli fill <ref for name input> "voice-test-task5"
playwright-cli press Enter
playwright-cli resize 390 844
playwright-cli run-code "async page => { await page.waitForTimeout(1500); }"
playwright-cli snapshot
```

From the snapshot, get the mic button's ref (it's the button with `aria-label="Start voice input"` inside `mux-mic-button`'s shadow tree — snapshot output flattens shadow DOM refs, so it should appear directly) and click it:

```bash
playwright-cli click <ref for mic button>
```

Confirm the listening visual state:
```bash
playwright-cli --raw eval "(() => {
  const btn = document.querySelector('mux-app').shadowRoot
    .querySelector('mux-title-bar').shadowRoot
    .querySelector('mux-mic-button').shadowRoot
    .querySelector('.mic-btn');
  return { classList: btn.className, label: btn.getAttribute('aria-label') };
})()"
```
Expected: `{"classList":"mic-btn listening","label":"Stop voice input"}`.

Deliver a synthetic transcript through the REAL session this click created (read its token via the accessor, since a real click — unlike `accessor.start()` — never returns a token any other way), then confirm the text lands in the real terminal and focus is restored to it, all as a single synchronous JS call so the synthetic result is guaranteed to win any race against whatever the real (unauthorized/offline) SpeechRecognition object does in the background:

```bash
playwright-cli --raw eval "(() => {
  const paneId = window.__muxStore ? undefined : (function(){
    // __muxStore is DEV-gated and unavailable in this production-mode build;
    // read the active pane id from the DOM instead via the pane-picker.
    return null;
  })();
  const st = window.__muxterm.voiceInput.state();
  const token = st.token;
  window.__muxterm.voiceInput.inject('result', token, 'echo hello from voice test');
  return { tokenUsed: token, targetBeforeInject: st.target };
})()"
```

Wait briefly for the injected text to travel `sendPaneInput → real PTY → real shell → pane-output → terminalRegistry.write()`, then confirm it actually appears in the terminal and the button returned to idle:

```bash
playwright-cli run-code "async page => {
  await page.waitForTimeout(800);
  return await page.evaluate(() => {
    const st = window.__muxterm.voiceInput.state();
    const activePaneId = /* the paneId from the target read just before injection */ st.target ? st.target.paneId : null;
    return { controllerState: st.state };
  });
}"
```

Since `st.target` is already `null` by this point (the session finished), read the pane's content by its id captured from the PRIOR eval call's `targetBeforeInject.paneId` — substitute that literal number here:

```bash
playwright-cli --raw eval "JSON.stringify(window.__muxterm.snapshot(<paneId-from-targetBeforeInject>).rowText)"
```
Expected: one of the returned row strings contains `echo hello from voice test` (the exact substring may include a shell prompt prefix and/or the echoed command output on the next line — either is acceptable proof the text reached the real PTY).

Confirm the button is back to idle and DOM focus is restored to the terminal (not left on the mic button):
```bash
playwright-cli --raw eval "(() => {
  function deepActiveElement(root) {
    let el = root.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }
  const el = deepActiveElement(document);
  const btn = document.querySelector('mux-app').shadowRoot
    .querySelector('mux-title-bar').shadowRoot
    .querySelector('mux-mic-button').shadowRoot
    .querySelector('.mic-btn');
  return {
    activeElementClass: el ? el.className : null,
    activeElementTag: el ? el.tagName : null,
    micButtonClass: btn.className,
  };
})()"
```
Expected: `activeElementClass` includes `xterm-helper-textarea`, `activeElementTag: "TEXTAREA"`, `micButtonClass: "mic-btn"` (no `listening`).

**Commit**
```bash
git add web/src/app.ts
git commit -m "feat(voice-input): wire invalidation + transcript delivery + focus restore

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5b: Cover WorkspaceController's internal attach paths

**Gap this closes:** `WorkspaceController` (`web/src/lib/workspace-controller.ts`) has 4 internal call sites for `this.socket.attachWithBreakpoint(...)` — `bootstrap()` and three recovery paths inside `onMessage()` (`WorkspaceList` recovery, no-survivor recovery, and `WorkspaceCreated`) — none of which route through `app.ts`'s `_onWorkspaceSelected` handler that Task 5 wired up. The design document's Architecture section names `WorkspaceController.attachWithBreakpoint()` itself as a call path requiring the same unconditional invalidation, so these 4 sites need their own direct calls.

**Files:**
- Modify: `web/src/lib/workspace-controller.ts`

**Implementation**

Add the import next to the existing `terminal-registry.js` import (currently lines 15-16), same relative-import style (same directory):

```typescript
import { currentLayoutMode } from './breakpoint.js';
import { terminalRegistry } from './terminal-registry.js';
import { voiceInputController } from './voice-input-controller.js';
```

Site 1 — `bootstrap()` (currently lines 51-60), invalidate immediately before the `attachWithBreakpoint` call:

```typescript
  bootstrap(): void {
    const stored = localStorage.getItem(LAST_WS_KEY);
    if (stored !== null) {
      this._attachInFlight = true;
      voiceInputController.invalidateIfActive();
      this.socket.attachWithBreakpoint(stored, currentLayoutMode());
      return;
    }
    this._recoveringFrom = '';
    this.socket.listWorkspaces();
  }
```

Site 2 & 3 — inside the `WorkspaceList` case (currently lines 99-126), both the recovering-from branch and the no-survivor-recovery branch each get their own invalidation call immediately before their `attachWithBreakpoint`:

```typescript
      case SessiondType.WorkspaceList: {
        if (this._recoveringFrom !== null) {
          const target = chooseRecoveryTarget(
            msg.workspaces ?? [],
            this._recoveringFrom,
            this._mru.order(),
          );
          this._recoveringFrom = null;
          if (target.action === 'attach') {
            voiceInputController.invalidateIfActive();
            this.socket.attachWithBreakpoint(target.workspaceId, currentLayoutMode());
          } else {
            this.socket.createWorkspace();
          }
        } else if (!this._attachInFlight && this.store.attached === null && (msg.workspaces ?? []).length > 0) {
          // The active workspace was deleted (e.g. user closed it). Pick the best
          // surviving workspace from MRU and attach automatically.
          // Guard: skip if bootstrap() already sent a direct attach (_attachInFlight).
          // The server pushes a workspace-list on every new connection (via attachClient)
          // which arrives while the bootstrap attach is still in flight. Without the
          // guard, this branch fires a second attach → second composition → resets
          // _activePaneId = panes[0], overriding the layout-restored active pane.
          const target = chooseRecoveryTarget(msg.workspaces ?? [], '', this._mru.order());
          if (target.action === 'attach') {
            voiceInputController.invalidateIfActive();
            this.socket.attachWithBreakpoint(target.workspaceId, currentLayoutMode());
          }
        }
        break;
      }
```

Site 4 — the `WorkspaceCreated` case (currently lines 129-132):

```typescript
      // no-survivor recovery path: attach the freshly-created workspace.
      case SessiondType.WorkspaceCreated: {
        voiceInputController.invalidateIfActive();
        this.socket.attachWithBreakpoint(msg.workspaceId ?? '', currentLayoutMode());
        break;
      }
```

**Implementation notes:**
- All 4 calls use `invalidateIfActive()` with no argument (unconditional invalidation), the same form Task 5 used for the workspace-switch case in `app.ts`'s `_onWorkspaceSelected` — none of these paths have a comparable new-pane identity available synchronously to pass as a `target`.
- `bootstrap()` fires once at connect, before any user interaction is possible, so its invalidation call is a no-op in practice (there is nothing yet to invalidate). It is included anyway for completeness and consistency with the general rule, rather than special-casing it out.
- The three `onMessage()` recovery paths are the ones with real-world relevance: they can fire because a workspace was closed server-side, or because of a reconnect-driven recovery flow — either of which could plausibly happen while a user is mid-dictation after a connection hiccup.

**Static Analysis**
```
cd web && npm run check:fast
```
Expected: no errors.

**Verification**

These 4 sites are rare, server-driven recovery paths (a workspace being closed server-side, or a reconnect racing a mid-flight attach) that are not practical to trigger deterministically through a scripted browser session — fabricating a `playwright-cli` scenario that reliably forces sessiond into one of these exact recovery branches would not be a genuine behavioral proof, it would be theater. Per the VDD principle of picking the cheapest verification that actually proves the claim: each call here is a one-line defensive invocation of an already-idempotent, already-token-gated function (`invalidateIfActive()`) whose correctness is already proven end-to-end by Task 6's pane-switch/workspace-switch/unmount tests. What's left to verify for this task specifically is placement, not behavior — so a code-reading confirmation is proportionate:

```bash
grep -n "attachWithBreakpoint\|invalidateIfActive" web/src/lib/workspace-controller.ts
```
Expected: each of the 4 `this.socket.attachWithBreakpoint(...)` lines is immediately preceded by a `voiceInputController.invalidateIfActive();` line, with no other statements between them.

**Commit**
```bash
git add web/src/lib/workspace-controller.ts
git commit -m "feat(voice-input): invalidate before WorkspaceController's internal attach paths

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 6: Verify pane-switch / workspace-switch / unmount invalidation (no new code)

**Files:** none — verification only, using the accessor built in Tasks 1-2 and the wiring from Task 5.

**Implementation:** N/A.

**Static Analysis:** N/A (no code changes).

**Verification**

Follow the fresh-workspace helper (`voice-test-task6a` for the pane-switch sub-test below).

**6a. Pane-switch invalidation.** Create a second pane in the fresh workspace (`Cmd+Ctrl+T` shortcut, or the dock's own new-tab affordance — confirm via snapshot which is present), then:

```bash
playwright-cli run-code "async page => { await page.waitForTimeout(1500); }"
playwright-cli --raw eval "window.__muxterm.voiceInput.start()"
```
Capture the returned token (call it `T1`) and note the workspace/pane the pipeline is targeting via `window.__muxterm.voiceInput.state()` beforehand.

Switch to the second pane via the mobile pane-picker breadcrumb (open its dropdown, click the other pane entry):
```bash
playwright-cli snapshot
playwright-cli click <ref for pane-picker breadcrumb>
playwright-cli click <ref for the OTHER pane entry in the dropdown>
```

Confirm invalidation happened (state returned to idle, target cleared):
```bash
playwright-cli --raw eval "JSON.stringify(window.__muxterm.voiceInput.state())"
```
Expected: `{"state":"idle","target":null,"token":null}`.

Inject a stale `result` tagged with `T1` and confirm it is a no-op — nothing lands in the now-active (second) pane. First read the second pane's current `rowText` as a baseline, inject, then re-read and diff:

```bash
playwright-cli --raw eval "JSON.stringify(window.__muxterm.snapshot(<secondPaneId>).rowText)"
playwright-cli --raw eval "window.__muxterm.voiceInput.inject('result', <T1>, 'STALE-PANE-SWITCH-TEXT')"
playwright-cli --raw eval "JSON.stringify(window.__muxterm.snapshot(<secondPaneId>).rowText)"
```
Expected: the two `rowText` reads are identical — `STALE-PANE-SWITCH-TEXT` appears nowhere.

**6b. Workspace-switch invalidation.** Requires a second workspace. Widen, create one more workspace (`voice-test-task6b-second`), narrow back:
```bash
playwright-cli resize 1024 800
playwright-cli snapshot
playwright-cli click <ref for "+ New workspace">
playwright-cli fill <ref for name input> "voice-test-task6b-second"
playwright-cli press Enter
playwright-cli resize 390 844
playwright-cli run-code "async page => { await page.waitForTimeout(1500); }"
```
This attaches the SECOND workspace. Start a session there, capture token `T2`:
```bash
playwright-cli --raw eval "window.__muxterm.voiceInput.start()"
```
Switch back to the FIRST workspace via the pane-picker's workspace list:
```bash
playwright-cli snapshot
playwright-cli click <ref for pane-picker breadcrumb>
playwright-cli click <ref for the first ("voice-test-task6b") workspace entry>
playwright-cli run-code "async page => { await page.waitForTimeout(800); }"
playwright-cli --raw eval "JSON.stringify(window.__muxterm.voiceInput.state())"
```
Expected: `{"state":"idle","target":null,"token":null}`.

Inject a stale result tagged `T2` and confirm no text lands anywhere in the now-active first workspace's pane (same before/after `snapshot().rowText` diff technique as 6a).

**6c. Title-bar unmount invalidation.** In the fresh workspace from 6a (or a new one — `voice-test-task6c`), narrow layout, start a session (capture token `T3`):
```bash
playwright-cli --raw eval "window.__muxterm.voiceInput.start()"
```
Trigger the narrow-to-wide breakpoint transition (which unmounts `<mux-title-bar>` and, with it, `<mux-mic-button>`'s `disconnectedCallback`):
```bash
playwright-cli resize 1024 800
playwright-cli run-code "async page => { await page.waitForTimeout(500); }"
playwright-cli --raw eval "JSON.stringify(window.__muxterm.voiceInput.state())"
```
Expected: `{"state":"idle","target":null,"token":null}` — confirming `disconnectedCallback`'s `invalidateIfActive()` ran even though there is no more title bar/mic button visible to inspect directly.

Inject a stale result tagged `T3` and confirm the accessor call itself is a no-op (state remains idle, no crash, no change) — since there's no narrow-layout pane visible to check terminal content against in wide mode, this step's proof is simply that `inject` does not throw and `state()` is unchanged:
```bash
playwright-cli --raw eval "window.__muxterm.voiceInput.inject('result', <T3>, 'STALE-UNMOUNT-TEXT'); JSON.stringify(window.__muxterm.voiceInput.state())"
```
Expected: same idle/null/null result, no error.

**Commit:** none — no files changed in this task.

---

### Task 7: Verify unsupported-browser and permission-denied paths (no new code)

**Files:** none — verification only.

**Implementation:** N/A.

**Static Analysis:** N/A.

**Verification**

**7a. Unsupported browser.** `isSupported()` runs once at module load, so the stub must exist BEFORE this module's top-level code executes — use `page.addInitScript`, applied before `page.goto`, in a single `run-code` call (fresh workspace not required for this read-only structural check, but use one anyway for consistency — `voice-test-task7a`):

```bash
playwright-cli run-code "async page => {
  await page.addInitScript(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });
  await page.goto('http://127.0.0.1:8313');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  return await page.evaluate(() => {
    const micShadow = document.querySelector('mux-app').shadowRoot
      .querySelector('mux-title-bar').shadowRoot
      .querySelector('mux-mic-button').shadowRoot;
    return { micButtonPresent: !!micShadow.querySelector('.mic-btn') };
  });
}"
```
Expected: `{"micButtonPresent":false}` — the button renders nothing at all (not disabled — fully absent), confirming Task 3's `if (!voiceInputController.isSupported()) return html\`\`;` and Task 1's module-load-time-only feature detection.

Close this browser and open a fresh one (without the stub) for 7b, since the stub is init-script-scoped to that page/context.

**7b. Permission-denied toast.** Follow the fresh-workspace helper (`voice-test-task7b`), narrow layout, wait for connection to settle:
```bash
playwright-cli run-code "async page => { await page.waitForTimeout(1500); }"
playwright-cli --raw eval "window.__muxterm.voiceInput.start()"
```
Capture the returned token, then inject a `not-allowed` error with it:
```bash
playwright-cli --raw eval "window.__muxterm.voiceInput.inject('error', <token>, 'not-allowed')"
```
Confirm the toast text and that the button returned to idle (ready for another tap immediately — never a permanent lockout):
```bash
playwright-cli --raw eval "(() => {
  const shadow = document.querySelector('mux-app').shadowRoot
    .querySelector('mux-title-bar').shadowRoot
    .querySelector('mux-mic-button').shadowRoot;
  const toast = shadow.querySelector('.toast');
  const btn = shadow.querySelector('.mic-btn');
  return {
    toastText: toast ? toast.textContent.trim() : null,
    buttonClass: btn.className,
    label: btn.getAttribute('aria-label'),
  };
})()"
```
Expected: `toastText: "Microphone access denied"`, `buttonClass: "mic-btn"` (no `listening`), `label: "Start voice input"`.

Optionally repeat with `'no-speech'` and `'network'` codes to confirm `"No speech detected"` / `"Network error"` — same mechanism, different `_messageForError` branch.

**Commit:** none — no files changed in this task.

---

## What still requires a real human with a real phone

Per the design's Verification Approach section, this is explicitly **out of scope for automated verification in this environment** — stated here rather than silently omitted. Before considering this feature fully done, a human should manually spot-check on an actual mobile device:

- Tap the mic button, speak a real sentence, confirm it's transcribed correctly and lands in the terminal.
- Confirm auto-stop-on-silence feels natural (not too eager, not too slow).
- Confirm the listening indicator (icon/color/pulse) is clearly visible in typical mobile lighting/handling conditions.
- iOS Safari specifically: confirm no jarring behavior from the documented "silent end with no result/error" quirk, and that dictation works at all (Safari's Web Speech API support/reliability has historically been less consistent than Chrome's).
- Confirm the on-screen keyboard doesn't fight with or obscure the mic button when both are visible.
