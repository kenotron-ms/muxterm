/**
 * The web-side half of the wrapper bridge (design reference, not wired in).
 *
 * This file is a DESIGN ARTIFACT. It lives under docs/design/ and is not part
 * of the web app's build. It type-checks against web/tsconfig.json's settings
 * (ES2021, DOM, strict) so that the interface in docs/design/webview-wrapper.md
 * is a real interface rather than a sketch. Wiring it in is a separate change,
 * owned by whoever builds the wrapper.
 *
 * Three properties are mandatory and are what this file exists to demonstrate:
 *
 *   1. ABSENT BY DEFAULT. In a normal browser tab `available` is false and every
 *      method is a resolving no-op. The web app's behaviour must be identical
 *      with this module loaded and with it deleted.
 *   2. CAPABILITY-GATED, NOT VERSION-GATED. Callers ask `has('voice.fgs')`, never
 *      compare version numbers. An older wrapper simply announces less.
 *   3. TIMEOUTS, NOT HANGS. A command that wants a reply gets one or gives up.
 *      The user's tap is never blocked on a native reply that is not coming.
 *
 * Transport is deliberately abstracted behind _send/_receive so that Android
 * (WebViewCompat.addWebMessageListener), Tauri (emit/listen) and Electron
 * (contextBridge) differ in two functions and nothing else.
 */

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------

/** Envelope version. Additive changes only; a breaking change bumps this. */
export const ENVELOPE_VERSION = 1;

/** Commands the page sends to native. Closed set — see W4.3. */
export type OutboundType =
  | 'voice.start'
  | 'voice.stop'
  | 'voice.state'
  | 'keepAwake'
  | 'openOsSettings'
  | 'log';

/** Events native sends to the page. Closed set — see W4.3. */
export type InboundType =
  | 'ready'
  | 'voice.serviceStarted'
  | 'voice.stopRequested'
  | 'mic.silenced'
  | 'mic.resumed'
  | 'wake'
  | 'attachment';

export interface Envelope<T extends string = string> {
  v: number;
  type: T;
  /** Correlation id, present only on a command that wants a reply. */
  id?: string;
  payload: Record<string, unknown>;
}

/**
 * Mirrors VoiceSessionState in web/src/lib/voice-session-controller.ts.
 *
 * Deliberately the same vocabulary rather than a parallel one: the bridge
 * forwards the session's own state and nothing else. Not `level`, not `heard`,
 * not `spoken` — the orb's meter and the transcript never cross.
 */
export type VoiceState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface ReadyPayload {
  platform: 'android' | 'macos' | 'windows' | 'linux';
  appVersion: string;
  capabilities: string[];
}

export interface ServiceStartedPayload {
  ok: boolean;
  reason?: string;
}

/** What the page can subscribe to. */
export type BridgeEvent =
  | { type: 'ready'; payload: ReadyPayload }
  | { type: 'voice.stopRequested' }
  | { type: 'mic.silenced' }
  | { type: 'mic.resumed' }
  | { type: 'wake' }
  | { type: 'attachment'; kind: string; mime: string; url: string };

type Listener = (e: BridgeEvent) => void;

// ---------------------------------------------------------------------------
// the injected object, as the host provides it
// ---------------------------------------------------------------------------

/**
 * Android's WebMessageListener injects an object with exactly this shape:
 * a postMessage(string) and an assignable onmessage. Tauri and Electron are
 * adapted to the same two members at install time, so nothing below is
 * platform-specific.
 */
interface HostChannel {
  postMessage(data: string): void;
  onmessage: ((ev: { data: string }) => void) | null;
}

declare global {
  // Injected by the wrapper only, and only on the allowed origin.
  // eslint-disable-next-line no-var
  var muxtermNative: HostChannel | undefined;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let _channel: HostChannel | null = null;
let _ready: ReadyPayload | null = null;
let _seq = 0;

const _listeners = new Set<Listener>();
const _pending = new Map<string, (payload: Record<string, unknown>) => void>();

/** How long a command that wants a reply waits before proceeding without one. */
const REPLY_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

function _send(type: OutboundType, payload: Record<string, unknown>, id?: string): void {
  if (!_channel) return;
  const env: Envelope<OutboundType> = { v: ENVELOPE_VERSION, type, payload };
  if (id) env.id = id;
  try {
    _channel.postMessage(JSON.stringify(env));
  } catch {
    // A dead channel is indistinguishable from no wrapper. Treat it as no
    // wrapper rather than propagating an error into a voice session.
    _channel = null;
    _ready = null;
  }
}

function _receive(raw: string): void {
  let env: Envelope<InboundType>;
  try {
    env = JSON.parse(raw) as Envelope<InboundType>;
  } catch {
    return;
  }
  if (typeof env !== 'object' || env === null) return;
  if (env.v !== ENVELOPE_VERSION) return; // unknown version: drop, never guess
  const payload = env.payload ?? {};

  // A reply to a command we are waiting on.
  if (env.id) {
    const resolve = _pending.get(env.id);
    if (resolve) {
      _pending.delete(env.id);
      resolve(payload);
      return;
    }
  }

  switch (env.type) {
    case 'ready':
      _ready = payload as unknown as ReadyPayload;
      _emit({ type: 'ready', payload: _ready });
      break;
    case 'voice.stopRequested':
      _emit({ type: 'voice.stopRequested' });
      break;
    case 'mic.silenced':
      _emit({ type: 'mic.silenced' });
      break;
    case 'mic.resumed':
      _emit({ type: 'mic.resumed' });
      break;
    case 'wake':
      _emit({ type: 'wake' });
      break;
    case 'attachment':
      _emit({
        type: 'attachment',
        kind: String(payload.kind ?? ''),
        mime: String(payload.mime ?? ''),
        url: String(payload.url ?? ''),
      });
      break;
    default:
      // Unknown type from a newer wrapper. Drop it; never guess.
      break;
  }
}

function _emit(e: BridgeEvent): void {
  for (const fn of _listeners) {
    try {
      fn(e);
    } catch {
      // One bad listener must not stop the others, and must never reach native.
    }
  }
}

function _command(
  type: OutboundType,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (!_channel) return Promise.resolve(null);
  const id = `c${++_seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      resolve(null); // timeout: proceed without native, never hang
    }, REPLY_TIMEOUT_MS);
    _pending.set(id, (p) => {
      clearTimeout(timer);
      resolve(p);
    });
    _send(type, payload, id);
  });
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** True only inside the wrapper, on the allowed origin. False in a browser. */
export function available(): boolean {
  return _channel !== null;
}

/** What this wrapper build announced it can do. Empty until `ready` arrives. */
export function capabilities(): readonly string[] {
  return _ready?.capabilities ?? [];
}

/** Capability check. Callers use this; they never compare versions. */
export function has(capability: string): boolean {
  return capabilities().includes(capability);
}

export function subscribe(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Ask native to start the foreground service, and report whether it did.
 *
 * MUST be awaited before the page calls getUserMedia: on Android 12+ a
 * microphone foreground service cannot be started once the app is in the
 * background, so the ordering is not cosmetic.
 *
 * Returns false when there is no wrapper, when the service failed, or when
 * native did not answer in time. In every one of those cases the caller should
 * carry on with the voice session and warn that it may not survive the screen
 * going off — never block the user's tap.
 */
export async function startVoiceService(sessionId: string): Promise<boolean> {
  if (!has('voice.fgs')) return false;
  const reply = await _command('voice.start', { sessionId });
  return reply !== null && reply.ok === true;
}

export function stopVoiceService(sessionId: string): void {
  if (!has('voice.fgs')) return;
  _send('voice.stop', { sessionId });
}

/** Forward the session's own state so the notification can say something true. */
export function reportVoiceState(state: VoiceState): void {
  if (!has('voice.fgs')) return;
  _send('voice.state', { state });
}

/** Desktop only: hold off idle system sleep for the duration of a session. */
export function keepAwake(on: boolean): void {
  if (!has('keepAwake')) return;
  _send('keepAwake', { on });
}

export function openOsSettings(which: 'notifications' | 'microphone' | 'battery'): void {
  if (!has('osSettings')) return;
  _send('openOsSettings', { which });
}

export function log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
  _send('log', { level, msg });
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * Attach to the injected channel if one exists.
 *
 * Safe to call unconditionally and repeatedly. In a browser it finds nothing,
 * leaves `available()` false, and the rest of the module stays inert.
 */
export function install(): void {
  if (_channel) return;
  const host = typeof globalThis !== 'undefined' ? globalThis.muxtermNative : undefined;
  if (!host || typeof host.postMessage !== 'function') return;
  _channel = host;
  host.onmessage = (ev: { data: string }) => _receive(String(ev.data));
}

/** Test seam: drive the module without a real host. */
export function _installForTest(host: HostChannel): void {
  _channel = host;
  host.onmessage = (ev: { data: string }) => _receive(String(ev.data));
}

/** Test seam: return to the browser-like state. */
export function _resetForTest(): void {
  _channel = null;
  _ready = null;
  _seq = 0;
  _listeners.clear();
  _pending.clear();
}
