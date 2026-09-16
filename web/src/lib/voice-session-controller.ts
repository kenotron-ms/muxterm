/**
 * voice-session-controller — a live, two-way spoken conversation with the
 * Operator.
 *
 * A SIBLING of voice-input-controller.ts, not a replacement for it, and the
 * distinction is the product decision: dictation is free, one utterance, and
 * fills the composer for a human to check; a live session is metered per
 * minute and acts. Two different jobs, two different controls. Nothing in
 * this file touches the mic button or the dictation path.
 *
 * Same module-level-singleton convention as its sibling (and as
 * terminal-registry.ts, pane-focus-coordinator.ts): this file owns all
 * session state, components only render and subscribe.
 *
 * ── The shape ──────────────────────────────────────────────────────────────
 *
 *   browser ──WebRTC audio──▶ realtime endpoint ◀──sideband WS── muxterm
 *
 * WebRTC, not WebSocket, and that is a real decision rather than a default.
 * Over WebRTC the server tracks how much audio has actually been played and
 * truncates the unplayed remainder itself when the user interrupts. Barge-in
 * — the hardest part of a spoken conversation — therefore costs zero lines
 * of client code. The WebSocket transport would put that work here:
 * watching for speech_started, stopping playback, counting milliseconds
 * played, and sending a truncate.
 *
 * The browser is a PURE AUDIO TRANSPORT. It never sees a tool call and could
 * not execute one if it did: muxterm's tools run shell commands, and tool
 * authority in a tab is not something this codebase hands out. Function
 * calls are delivered to muxterm's own process over a sideband connection to
 * the same realtime session, and executed there. What this file sends over
 * the data channel is narration — text for the model to speak — which is
 * exactly the authority a page should have over its own microphone.
 *
 * ── The Chromium trap ──────────────────────────────────────────────────────
 *
 * A remote WebRTC track feeds an AnalyserNode NOTHING BUT ZEROS in Chromium
 * unless the stream is also attached to a media element (crbug 40094084).
 * Chromium will not start its WebRTCAudioRenderer for an inbound track until
 * something consumes it as media, and Web Audio does not count. There is no
 * error; the level meter simply sits at zero forever. `_attachSink` below is
 * that workaround and must not be "cleaned up".
 */

import { apiPath } from './base-path.js';

export type VoiceSessionState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface VoiceSessionSnapshot {
  state: VoiceSessionState;
  /** Live output level, 0..1. Drives the orb. */
  level: number;
  /** What the user was last heard to say. */
  heard: string;
  /** What the assistant is saying, streaming. */
  spoken: string;
  error: string;
}

interface TokenResponse {
  session_id: string;
  value: string;
  expires_at: number;
  model: string;
  auth_mode: string;
}

type Listener = (s: VoiceSessionSnapshot) => void;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let _state: VoiceSessionState = 'idle';
let _level = 0;
let _heard = '';
let _spoken = '';
let _error = '';

let _pc: RTCPeerConnection | null = null;
let _dc: RTCDataChannel | null = null;
let _mic: MediaStream | null = null;
let _sink: HTMLAudioElement | null = null;
let _ctx: AudioContext | null = null;
let _analyser: AnalyserNode | null = null;
let _levelRaf: number | null = null;
let _sessionId = '';

/**
 * Generation counter. Every start() increments it; every async continuation
 * is gated on still holding the current value. Same scheme as
 * voice-input-controller's session token, for the same reason: a stop()
 * during an in-flight SDP exchange must make everything that exchange
 * eventually resolves into a guaranteed no-op.
 */
let _gen = 0;

const _listeners = new Set<Listener>();

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export function isSupported(): boolean {
  return (
    typeof RTCPeerConnection === 'function' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export function snapshot(): VoiceSessionSnapshot {
  return { state: _state, level: _level, heard: _heard, spoken: _spoken, error: _error };
}

export function subscribe(cb: Listener): () => void {
  _listeners.add(cb);
  return () => {
    _listeners.delete(cb);
  };
}

export function isActive(): boolean {
  return _state !== 'idle' && _state !== 'error';
}

/** Start or stop, whichever the current state calls for. */
export async function toggle(): Promise<void> {
  if (isActive()) {
    stop();
    return;
  }
  await start();
}

export async function start(): Promise<void> {
  if (isActive()) return;
  const gen = ++_gen;
  _error = '';
  _heard = '';
  _spoken = '';
  _setState('connecting');

  try {
    // 1. A short-lived secret, minted server-side. The credential that
    //    minted it never comes anywhere near this file.
    const tokenRes = await fetch(apiPath('/api/cos/voice/token'), { method: 'POST' });
    if (!tokenRes.ok) throw new Error(await _errorText(tokenRes, 'could not start a voice session'));
    const token = (await tokenRes.json()) as TokenResponse;
    if (gen !== _gen) return;
    _sessionId = token.session_id;

    // 2. The microphone. Fails loudly and early if permission is refused,
    //    which is better than a session that connects and hears nothing.
    _mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (gen !== _gen) {
      _mic.getTracks().forEach((t) => t.stop());
      return;
    }

    // 3. The peer connection.
    const pc = new RTCPeerConnection();
    _pc = pc;
    // addTrack creates a SENDRECV transceiver on its own, so the offer
    // already asks to receive. An extra addTransceiver('audio') here adds a
    // SECOND m-line that carries nothing — harmless to the conversation,
    // but it splits getStats across two outbound-rtp reports and makes the
    // empty one look like a session that never sent any audio.
    for (const track of _mic.getTracks()) pc.addTrack(track, _mic);

    pc.ontrack = (ev) => {
      if (gen !== _gen) return;
      _attachSink(ev.streams[0] ?? new MediaStream([ev.track]));
    };
    pc.onconnectionstatechange = () => {
      if (gen !== _gen) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        _fail('the voice connection dropped');
      }
    };

    const dc = pc.createDataChannel('oai-events');
    _dc = dc;
    dc.onmessage = (ev) => {
      if (gen !== _gen) return;
      _onRealtimeEvent(ev.data);
    };
    dc.onopen = () => {
      if (gen !== _gen) return;
      _configureSession();
      _setState('listening');
    };

    // 4. Offer → muxterm → vendor → answer.
    //
    //    Proxied through muxterm rather than posted straight to the vendor.
    //    The response's Location header names the CALL ID, and the sideband
    //    keyed to that id executes shell tools — so it must be an id muxterm
    //    watched the vendor mint, not one this page handed it.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await _iceSettled(pc);
    if (gen !== _gen) return;

    const sdpRes = await fetch(apiPath('/api/cos/voice/sdp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', 'X-Voice-Session': _sessionId },
      body: pc.localDescription?.sdp ?? offer.sdp ?? '',
    });
    if (!sdpRes.ok) throw new Error(await _errorText(sdpRes, 'the voice service refused the connection'));
    const answer = await sdpRes.text();
    if (gen !== _gen) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });

  } catch (err) {
    if (gen !== _gen) return;
    _fail(err instanceof Error ? err.message : String(err));
  }
}

export function stop(): void {
  _gen++;
  _teardown();
  _setState('idle');
}

/**
 * The server tore this session down and is telling us so.
 *
 * That is the spoken exit: the user asked the model to hang up, the model
 * confirmed it with them, said goodbye, and muxterm ended the session in its
 * own process. None of that reaches the microphone light, the peer connection
 * or the idle state — those all live here — so the page follows.
 *
 * The session id is cleared BEFORE tearing down, so this path does not post
 * /api/cos/voice/end back at a server that has already ended it.
 *
 * A broadcast naming a different session is ignored: only one voice session
 * runs at a time, but a late frame for a previous one must not close the one
 * that replaced it.
 */
export function endedByServer(sessionId: string): void {
  if (!_sessionId) return;
  if (sessionId && sessionId !== _sessionId) return;
  _sessionId = '';
  stop();
}

// ---------------------------------------------------------------------------
// realtime events
// ---------------------------------------------------------------------------

function _configureSession(): void {
  // Transcription is asked for explicitly: it is off by default, and both
  // transcripts are what make a spoken turn readable in the log afterwards.
  //
  // turn_detection is left at the server's own server_vad default, which
  // already carries interrupt_response: true — barge-in needs no
  // configuration on this stack.
  _send({
    type: 'session.update',
    session: {
      type: 'realtime',
      audio: {
        input: {
          transcription: { model: 'whisper-1' },
        },
      },
    },
  });
}

function _onRealtimeEvent(raw: unknown): void {
  if (typeof raw !== 'string') return;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = String(ev.type ?? '');

  switch (type) {
    // The user started talking. Over WebRTC the server has already
    // truncated its own unplayed audio, so this is a UI signal only.
    case 'input_audio_buffer.speech_started':
      _spoken = '';
      _setState('listening');
      break;

    case 'conversation.item.input_audio_transcription.completed':
      _heard = String(ev.transcript ?? '').trim();
      _log.push({ at: Date.now(), dir: 'heard', text: _heard });
      _notify();
      break;

    case 'response.created':
      // Reset HERE, not only on speech_started. A response the server
      // creates on its own -- narration, an injected answer, a tool result
      // being spoken -- has no preceding user utterance, so a buffer only
      // cleared on speech_started concatenates two separate answers into
      // one run-on line.
      _spoken = '';
      _setState('thinking');
      break;

    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      _spoken += String(ev.delta ?? '');
      if (_state !== 'speaking') _setState('speaking');
      else _notify();
      break;

    case 'response.output_audio.done':
    case 'response.audio.done':
      break;

    case 'response.done':
    case 'response.cancelled':
      if (_spoken.trim()) _log.push({ at: Date.now(), dir: 'spoke', text: _spoken.trim() });
      if (_state === 'speaking' || _state === 'thinking') _setState('listening');
      break;

    case 'error': {
      // A response-admission conflict belongs to the server sideband's
      // response FIFO. It is recoverable, and must never turn a healthy
      // microphone/WebRTC session into a user-visible Voice Mode failure.
      if (_isActiveResponseConflict(ev.error)) return;
      _fail(_safeRealtimeError(ev.error));
      break;
    }
  }
}

/** Send a client event over the data channel, if it is open. */
function _send(msg: unknown): boolean {
  if (!_dc || _dc.readyState !== 'open') return false;
  _dc.send(JSON.stringify(msg));
  return true;
}

function _isActiveResponseConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const detail = error as { code?: unknown; message?: unknown };
  return (
    detail.code === 'conversation_already_has_active_response' ||
    (typeof detail.message === 'string' && detail.message.includes('conversation_already_has_active_response'))
  );
}

function _safeRealtimeError(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  if (code === 'rate_limit_exceeded') return 'The voice provider is temporarily busy. Try again shortly.';
  if (code === 'session_expired') return 'The voice session expired. Start Voice Mode again.';
  return 'Voice Mode encountered a connection error. Start Voice Mode again.';
}

// ---------------------------------------------------------------------------
// audio plumbing
// ---------------------------------------------------------------------------

/**
 * Attach the inbound stream to BOTH a media element and the analyser.
 *
 * The media element is not optional and is not for playback convenience: in
 * Chromium an inbound WebRTC track produces silence in Web Audio unless
 * something consumes it as media first (crbug 40094084). Without these four
 * lines the level meter reads zero forever, with no error anywhere.
 *
 * The element is NOT muted — it is how the assistant is actually heard.
 */
function _attachSink(stream: MediaStream): void {
  _sink?.pause();
  const el = new Audio();
  el.srcObject = stream;
  el.autoplay = true;
  el.play().catch(() => {
    /* autoplay policy; the user gesture that started the session covers it */
  });
  _sink = el;

  try {
    _ctx?.close().catch(() => {});
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    src.connect(analyser);
    _ctx = ctx;
    _analyser = analyser;
    _startLevelLoop();
  } catch {
    // No analyser means no level meter. The conversation still works, so
    // this is not a session-ending failure.
    _analyser = null;
  }
}

function _startLevelLoop(): void {
  if (_levelRaf !== null) return;
  const buf = new Uint8Array(_analyser?.frequencyBinCount ?? 0);
  const loop = () => {
    if (!_analyser || !isActive()) {
      _levelRaf = null;
      return;
    }
    _analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, buf.length));
    // A conversational RMS sits well under 0.3; scale so ordinary speech
    // uses most of the range rather than a twentieth of it.
    const next = Math.min(1, rms * 3.2);
    if (Math.abs(next - _level) > 0.01) {
      _level = next;
      _notify();
    }
    _levelRaf = requestAnimationFrame(loop);
  };
  _levelRaf = requestAnimationFrame(loop);
}

/**
 * Wait for ICE gathering, but not forever.
 *
 * A full gather can stall on a network with no route to a STUN server, and
 * the candidates already collected are usually enough. Two seconds is the
 * budget; the connection then proceeds with what it has.
 */
function _iceSettled(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, 2000);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

function _teardown(): void {
  if (_levelRaf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(_levelRaf);
  _levelRaf = null;
  _analyser = null;
  _ctx?.close().catch(() => {});
  _ctx = null;

  if (_sink) {
    _sink.pause();
    _sink.srcObject = null;
    _sink = null;
  }
  // The microphone light is the user's only evidence that a session ended.
  // Stopping these tracks is what turns it off.
  _mic?.getTracks().forEach((t) => t.stop());
  _mic = null;

  try {
    _dc?.close();
  } catch {
    /* already gone */
  }
  _dc = null;
  try {
    _pc?.close();
  } catch {
    /* already gone */
  }
  _pc = null;

  _level = 0;

  // Best-effort: tell muxterm to drop the sideband. keepalive so it still
  // goes out if this fires during a page unload.
  if (_sessionId) {
    const id = _sessionId;
    _sessionId = '';
    fetch(apiPath('/api/cos/voice/end'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: id }),
      keepalive: true,
    }).catch(() => {
      /* the server also tears sessions down on shutdown */
    });
  }
}

function _fail(message: string): void {
  _error = message;
  _teardown();
  _setState('error');
}

function _setState(s: VoiceSessionState): void {
  _state = s;
  _notify();
}

function _notify(): void {
  const snap = snapshot();
  for (const cb of _listeners) {
    try {
      cb(snap);
    } catch {
      /* a bad listener is not this module's problem */
    }
  }
}

async function _errorText(res: Response, fallback: string): Promise<string> {
  // Provider/server error bodies can include reflected credentials, response
  // identifiers, or diagnostics. The caller gets only stable recovery copy.
  return `${fallback} (HTTP ${res.status})`;
}

export const voiceSessionController = {
  isSupported,
  isActive,
  snapshot,
  subscribe,
  start,
  stop,
  toggle,
  endedByServer,
};

// ---------------------------------------------------------------------------
// DEV verification accessor — extends the SAME window.__muxterm object
// terminal-registry.ts and voice-input-controller.ts already install, using
// the IDENTICAL spread pattern so no module clobbers another's keys
// regardless of evaluation order. Deliberately NOT gated behind
// import.meta.env.DEV, for the reason voice-input-controller's accessor
// gives: this repo builds with plain `vite build`, where that flag is false.
//
// It exists because this feature's proof CANNOT be a person speaking into a
// microphone. The automated end-to-end run drives a real browser with a real
// WAV file in place of a mic and needs to read back what was actually heard
// and said. Everything here is READ-ONLY except start/stop, which are the
// same code paths the button uses; there is no way to fake a transcript
// through it, so a passing run is a real conversation or it is nothing.
// ---------------------------------------------------------------------------

/** Every transcript event, in order, for the automated end-to-end run. */
const _log: Array<{ at: number; dir: 'heard' | 'spoke' | 'event'; text: string }> = [];

if (typeof window !== 'undefined') {
  (window as unknown as { __muxterm?: Record<string, unknown> }).__muxterm = {
    ...(window as unknown as { __muxterm?: Record<string, unknown> }).__muxterm,
    voiceSession: {
      /** Start, by the same path the button takes. */
      start: (): Promise<void> => start(),
      stop: (): void => stop(),
      /** Live snapshot: state, level, both transcripts, any error. */
      snapshot: (): VoiceSessionSnapshot => snapshot(),
      /** Ordered transcript log, oldest first. */
      log: () => _log.slice(),
      /**
       * Live inbound-audio statistics, straight from the peer connection.
       *
       * This is what proves audio came BACK, as opposed to a handshake that
       * merely succeeded: bytes and packets on the inbound RTP stream, and
       * the concealment/played sample counters the browser only maintains
       * for audio it actually rendered.
       */
      stats: async (): Promise<Record<string, number>> => {
        const out: Record<string, number> = {};
        if (!_pc) return out;
        // SUMMED across reports, not assigned. A peer connection can carry
        // more than one audio m-line, and assigning lets whichever report
        // arrives last speak for all of them — an empty one then reads as
        // "no audio was ever sent".
        const add = (k: string, v: unknown) => {
          out[k] = (out[k] ?? 0) + Number(v ?? 0);
        };
        const report = await _pc.getStats();
        report.forEach((s: Record<string, unknown>) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            add('inboundBytes', s.bytesReceived);
            add('inboundPackets', s.packetsReceived);
            add('playedSamples', s.totalSamplesReceived);
            out.audioLevel = Math.max(out.audioLevel ?? 0, Number(s.audioLevel ?? 0));
          }
          if (s.type === 'outbound-rtp' && s.kind === 'audio') {
            add('outboundBytes', s.bytesSent);
            add('outboundPackets', s.packetsSent);
          }
        });
        return out;
      },
      connectionState: (): string => _pc?.connectionState ?? 'none',
    },
  };
}
