/**
 * voice-session-controller — a live, two-way spoken conversation with the
 * chief of staff.
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
import { cosStore, shortToolName } from './cos-store.js';

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
let _unsubCos: (() => void) | null = null;

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
// narration bookkeeping
// ---------------------------------------------------------------------------

/**
 * Tools already announced, by turn. A turn that runs the same tool eight
 * times should not be narrated eight times — that is worse than silence.
 */
let _narratedTools = new Set<string>();
/** Approvals already spoken, so a re-render never re-announces one. */
const _spokenApprovals = new Set<string>();
/** When narration last spoke, so progress does not become chatter. */
let _lastNarration = 0;

/**
 * Whether the model is mid-response, and anything waiting for it to finish.
 *
 * This gate is not politeness, it is protection. Asking for a response while
 * one is running is answered with conversation_already_has_active_response
 * -- and on this platform that error CLOSES the server's tool sideband,
 * taking every tool and every pending answer with it, silently, for the rest
 * of the conversation.
 *
 * The browser is the right place to enforce it because the browser has
 * perfect information: every response.created and response.done arrives on
 * its data channel. The server, watching the same session as an observer,
 * learns the same facts a beat later.
 */
let _responseActive = false;
let _pendingSay: Array<{ text: string; instructions: string }> = [];

/** Minimum gap between two spoken progress notes. */
const NARRATION_GAP_MS = 9000;
/** How long a turn must have been running before progress is worth saying. */
const NARRATION_AFTER_MS = 6000;

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

    _subscribeToChiefOfStaff();
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
      _responseActive = true;
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
      _releaseResponse();
      if (_state === 'speaking' || _state === 'thinking') _setState('listening');
      break;

    case 'error': {
      const e = ev.error as { message?: string } | undefined;
      _fail(e?.message ?? 'the voice service reported an error');
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

/**
 * Say something that answers no user utterance.
 *
 * The text goes in as a conversation item and a response is requested with
 * instructions. If the user is mid-sentence the model waits for the turn
 * boundary rather than talking over them, which is the behaviour you want.
 */
function _say(text: string, instructions: string): void {
  if (
    !_send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })
  ) {
    return;
  }
  if (_responseActive) {
    // Held, not dropped, and coalesced to the most recent: three progress
    // notes queued behind one long answer would be delivered as a
    // monologue nobody asked for.
    _pendingSay = [{ text, instructions }];
    return;
  }
  _responseActive = true;
  _send({ type: 'response.create', response: { instructions } });
}

/** Called when a response ends: release the gate and flush one held ask. */
function _releaseResponse(): void {
  _responseActive = false;
  const next = _pendingSay.pop();
  _pendingSay = [];
  if (next) {
    _responseActive = true;
    _send({ type: 'response.create', response: { instructions: next.instructions } });
  }
}

// ---------------------------------------------------------------------------
// narration — C6
// ---------------------------------------------------------------------------

/**
 * Speak progress from the event stream that is already arriving.
 *
 * This is wiring, not invention. muxterm's sidecar already emits a
 * structured, real-time account of what it is doing — turn_start, thinking,
 * tool_start, tool_end, approval_request, turn_end — and that stream already
 * reaches this browser and is already switched on by cos-store. Most
 * projects building voice over an agent have to build this from nothing.
 *
 * The failure mode being prevented is specific: a chief-of-staff turn can
 * run for minutes, and in a spoken conversation thirty seconds of silence is
 * indistinguishable from a crash.
 *
 * The failure mode being AVOIDED in the other direction is chatter. Two
 * gates: nothing is said for the first few seconds of a turn (most turns
 * finish inside that), and no two progress notes come closer together than
 * NARRATION_GAP_MS. A tool already announced this turn is never announced
 * again.
 */
function _subscribeToChiefOfStaff(): void {
  _unsubCos?.();
  let turnStartedAt = 0;

  _unsubCos = cosStore.onEvent((ev) => {
    if (!isActive()) return;
    const kind = String(ev.ev ?? '');

    switch (kind) {
      case 'turn_start':
        turnStartedAt = Date.now();
        _narratedTools = new Set<string>();
        break;

      case 'tool_start': {
        const name = shortToolName(String(ev.name ?? ''));
        if (!name || _narratedTools.has(name)) break;
        if (Date.now() - turnStartedAt < NARRATION_AFTER_MS) break;
        if (Date.now() - _lastNarration < NARRATION_GAP_MS) break;
        _narratedTools.add(name);
        _lastNarration = Date.now();
        _log.push({ at: Date.now(), dir: 'event', text: `narrate:tool_start:${name}` });
        _say(
          `[progress] Still working. Currently running: ${name}.`,
          'Tell the user in ONE short sentence what you are doing right now. Do not repeat yourself and do not add detail.',
        );
        break;
      }

      case 'approval_request': {
        // C7's browser half: bring the request into the conversation so it
        // can be spoken. The DECISION is not made here and cannot be — the
        // gate is server-side, in the sideband, where the answer has to
        // survive a two-step confirmation before anything is transmitted.
        const id = String(ev.request_id ?? '');
        if (!id || _spokenApprovals.has(id)) break;
        _spokenApprovals.add(id);
        _lastNarration = Date.now();
        const tool = String(ev.tool ?? 'something');
        const detail = String(ev.detail ?? '').slice(0, 400);
        _log.push({ at: Date.now(), dir: 'event', text: `narrate:approval_request:${tool}` });
        _say(
          `[approval needed] request_id=${id} tool=${tool} detail=${detail}`,
          'The chief of staff needs permission. Say plainly what it wants to do and ask the user to approve or deny. ' +
            'Then follow the approval rules exactly: read their decision back, wait for confirmation, and only then call answer_approval with confirm true. If it is unclear, deny.',
        );
        break;
      }

      case 'turn_end':
        turnStartedAt = 0;
        break;
    }
  });
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
  _unsubCos?.();
  _unsubCos = null;

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
  _spokenApprovals.clear();
  _narratedTools = new Set<string>();
  _responseActive = false;
  _pendingSay = [];

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
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* not JSON */
  }
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
      /**
       * Feed one sidecar event through the REAL path — cos-store's own
       * frame handler, the same one the WebSocket calls — so the narration
       * and approval wiring is exercised exactly as it is in production.
       * There is no shortcut into the narrator; an event injected here
       * takes every gate a real one does.
       */
      feedCosEvent: (ev: Record<string, unknown>): void => {
        cosStore.handleFrame({ type: 'cos-event', event: ev });
      },
    },
  };
}
