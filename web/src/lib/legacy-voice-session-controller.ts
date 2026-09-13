/**
 * The recovered v0.32 Chief-of-Staff WebRTC transport.
 *
 * This remains a module singleton: it owns the legacy /api/cos/voice protocol,
 * its sideband narration bridge, and every browser media object.  Selection
 * between this transport and app v1 belongs to voice-session-controller.ts.
 */

import { apiPath } from './base-path.js';
import { cosStore, shortToolName } from './cos-store.js';
import { voiceCaptureArbiter } from './voice-capture-arbiter.js';

export type VoiceSessionState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface VoiceSessionSnapshot {
  readonly state: VoiceSessionState;
  readonly level: number;
  readonly heard: string;
  readonly spoken: string;
  readonly error: string;
  readonly muted: boolean;
  readonly canMute: boolean;
}

interface TokenResponse {
  readonly session_id: string;
}

type Listener = (snapshot: VoiceSessionSnapshot) => void;

let state: VoiceSessionState = 'idle';
let level = 0;
let heard = '';
let spoken = '';
let error = '';
let muted = false;
let pc: RTCPeerConnection | null = null;
let dc: RTCDataChannel | null = null;
let mic: MediaStream | null = null;
let sink: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let levelRaf: number | null = null;
let sessionId = '';
let unsubCos: (() => void) | null = null;
let generation = 0;
let microphoneRequestPending = false;
let captureClaimed = false;
let responseActive = false;
let pendingSay: Array<{ text: string; instructions: string }> = [];
let narratedTools = new Set<string>();
let lastNarration = 0;
const spokenApprovals = new Set<string>();
const listeners = new Set<Listener>();

const NARRATION_GAP_MS = 9000;
const NARRATION_AFTER_MS = 6000;

export function isSupported(): boolean {
  return (
    typeof RTCPeerConnection === 'function' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

function inputTracks(): MediaStreamTrack[] {
  return mic?.getAudioTracks().filter((track) => track.readyState === 'live') ?? [];
}

function syncMuted(): void {
  const tracks = inputTracks();
  muted = tracks.length > 0 && tracks.every((track) => !track.enabled);
}

export function snapshot(): VoiceSessionSnapshot {
  return Object.freeze({
    state,
    level,
    heard,
    spoken,
    error,
    muted,
    canMute: inputTracks().length > 0,
  });
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isActive(): boolean {
  return state !== 'idle' && state !== 'error';
}

/** True until the legacy browser capture has completed its cleanup. */
export function isCaptureClaimed(): boolean {
  return captureClaimed;
}

function notify(next?: VoiceSessionState): void {
  if (next) state = next;
  const value = snapshot();
  for (const listener of listeners) listener(value);
}

export async function toggle(): Promise<void> {
  if (isActive()) {
    stop();
    return;
  }
  await start();
}

/**
 * Explicit user intent only. The arbiter claim is intentionally before every
 * async provider operation so dictation cannot begin while a token/permission
 * request is in flight.
 */
export async function start(): Promise<void> {
  if (isActive() || captureClaimed) return;
  if (!isSupported()) {
    error = 'This browser cannot start a WebRTC voice session.';
    notify('error');
    return;
  }
  const acquired = voiceCaptureArbiter.acquire('app_conversation');
  if (!acquired.ok) {
    error = acquired.owner === 'composer_dictation'
      ? 'Finish dictation before starting a spoken conversation.'
      : 'Another microphone capture is still releasing.';
    notify('error');
    return;
  }
  captureClaimed = true;
  const current = ++generation;
  error = '';
  heard = '';
  spoken = '';
  muted = false;
  notify('connecting');

  try {
    const tokenRes = await fetch(apiPath('/api/cos/voice/token'), { method: 'POST' });
    if (!tokenRes.ok) throw new Error(await errorText(tokenRes, 'could not start a voice session'));
    const token = (await tokenRes.json()) as TokenResponse;
    if (!token.session_id) throw new Error('The voice service returned no session.');
    if (current !== generation) return;
    sessionId = token.session_id;

    microphoneRequestPending = true;
    const acquiredMic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    microphoneRequestPending = false;
    if (current !== generation) {
      acquiredMic.getTracks().forEach((track) => track.stop());
      releaseCapture();
      return;
    }
    mic = acquiredMic;
    syncMuted();
    const connection = new RTCPeerConnection();
    pc = connection;
    for (const track of acquiredMic.getTracks()) connection.addTrack(track, acquiredMic);
    connection.ontrack = (event) => {
      if (current === generation) attachSink(event.streams[0] ?? new MediaStream([event.track]));
    };
    connection.onconnectionstatechange = () => {
      if (current === generation && (connection.connectionState === 'failed' || connection.connectionState === 'closed')) {
        fail('the voice connection dropped');
      }
    };

    const channel = connection.createDataChannel('oai-events');
    dc = channel;
    channel.onmessage = (event) => {
      if (current === generation) onRealtimeEvent(event.data);
    };
    channel.onopen = () => {
      if (current !== generation) return;
      configureSession();
      notify('listening');
    };

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await iceSettled(connection);
    if (current !== generation) return;
    const sdpRes = await fetch(apiPath('/api/cos/voice/sdp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', 'X-Voice-Session': sessionId },
      body: connection.localDescription?.sdp ?? offer.sdp ?? '',
    });
    if (!sdpRes.ok) throw new Error(await errorText(sdpRes, 'the voice service refused the connection'));
    const answer = await sdpRes.text();
    if (current !== generation) return;
    await connection.setRemoteDescription({ type: 'answer', sdp: answer });
    subscribeToChiefOfStaff();
  } catch (cause) {
    microphoneRequestPending = false;
    if (current === generation) fail(cause instanceof Error ? cause.message : String(cause));
    else releaseCapture();
  }
}

export function stop(): void {
  generation++;
  teardown();
  notify('idle');
}

export function endedByServer(endedSessionId: string): void {
  if (!sessionId || (endedSessionId && endedSessionId !== sessionId)) return;
  sessionId = '';
  stop();
}

/** Toggle only live legacy input tracks; output and the provider stay live. */
export function setMuted(next: boolean): void {
  const tracks = inputTracks();
  if (tracks.length === 0) return;
  for (const track of tracks) track.enabled = !next;
  syncMuted();
  notify();
}

export function dismissError(): void {
  if (state !== 'error') return;
  error = '';
  notify('idle');
}

function configureSession(): void {
  send({
    type: 'session.update',
    session: { type: 'realtime', audio: { input: { transcription: { model: 'whisper-1' } } } },
  });
}

function onRealtimeEvent(raw: unknown): void {
  if (typeof raw !== 'string') return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (String(event.type ?? '')) {
    case 'input_audio_buffer.speech_started':
      spoken = '';
      notify('listening');
      break;
    case 'conversation.item.input_audio_transcription.completed':
      heard = String(event.transcript ?? '').trim();
      notify();
      break;
    case 'response.created':
      responseActive = true;
      spoken = '';
      notify('thinking');
      break;
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      spoken += String(event.delta ?? '');
      notify('speaking');
      break;
    case 'response.done':
    case 'response.cancelled':
      releaseResponse();
      if (isActive()) notify('listening');
      break;
    case 'error': {
      const detail = event.error as { message?: unknown } | undefined;
      fail(typeof detail?.message === 'string' ? detail.message : 'the voice service reported an error');
      break;
    }
  }
}

function send(message: unknown): boolean {
  if (!dc || dc.readyState !== 'open') return false;
  dc.send(JSON.stringify(message));
  return true;
}

// This is the original legacy COS tool-progress bridge. It sends only
// narration over the browser data channel; tool execution remains sidebanded
// in the server's established legacy provider session.
function say(text: string, instructions: string): void {
  if (!send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })) return;
  if (responseActive) {
    pendingSay = [{ text, instructions }];
    return;
  }
  responseActive = true;
  send({ type: 'response.create', response: { instructions } });
}

function releaseResponse(): void {
  responseActive = false;
  const next = pendingSay.pop();
  pendingSay = [];
  if (next) {
    responseActive = true;
    send({ type: 'response.create', response: { instructions: next.instructions } });
  }
}

function subscribeToChiefOfStaff(): void {
  unsubCos?.();
  let turnStartedAt = 0;
  unsubCos = cosStore.onEvent((event) => {
    if (!isActive()) return;
    switch (String(event.ev ?? '')) {
      case 'turn_start':
        turnStartedAt = Date.now();
        narratedTools = new Set<string>();
        break;
      case 'tool_start': {
        const name = shortToolName(String(event.name ?? ''));
        if (!name || narratedTools.has(name) || Date.now() - turnStartedAt < NARRATION_AFTER_MS || Date.now() - lastNarration < NARRATION_GAP_MS) break;
        narratedTools.add(name);
        lastNarration = Date.now();
        say(`[progress] Still working. Currently running: ${name}.`, 'Tell the user in ONE short sentence what you are doing right now. Do not repeat yourself and do not add detail.');
        break;
      }
      case 'approval_request': {
        const id = String(event.request_id ?? '');
        if (!id || spokenApprovals.has(id)) break;
        spokenApprovals.add(id);
        say(
          `[approval needed] request_id=${id} tool=${String(event.tool ?? 'something')} detail=${String(event.detail ?? '').slice(0, 400)}`,
          'The chief of staff needs permission. Say plainly what it wants to do and ask the user to approve or deny. ' +
            'Then follow the approval rules exactly: read their decision back, wait for confirmation, and only then call answer_approval with confirm true. If it is unclear, deny.',
        );
        break;
      }
    }
  });
}

function attachSink(stream: MediaStream): void {
  sink?.pause();
  const audio = new Audio();
  audio.srcObject = stream;
  audio.autoplay = true;
  audio.play().catch(() => {});
  sink = audio;
  try {
    void ctx?.close().catch(() => {});
    const nextContext = new AudioContext();
    const source = nextContext.createMediaStreamSource(stream);
    const nextAnalyser = nextContext.createAnalyser();
    nextAnalyser.fftSize = 512;
    nextAnalyser.smoothingTimeConstant = 0.6;
    source.connect(nextAnalyser);
    ctx = nextContext;
    analyser = nextAnalyser;
    startLevelLoop();
  } catch {
    analyser = null;
  }
}

function startLevelLoop(): void {
  if (levelRaf !== null) return;
  const samples = new Uint8Array(analyser?.frequencyBinCount ?? 0);
  const loop = (): void => {
    if (!analyser || !isActive()) {
      levelRaf = null;
      return;
    }
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const value = (sample - 128) / 128;
      sum += value * value;
    }
    const next = Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 3.2);
    if (Math.abs(next - level) > 0.01) {
      level = next;
      notify();
    }
    levelRaf = requestAnimationFrame(loop);
  };
  levelRaf = requestAnimationFrame(loop);
}

function iceSettled(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      connection.removeEventListener('icegatheringstatechange', changed);
      clearTimeout(timer);
      resolve();
    };
    const changed = (): void => {
      if (connection.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, 2000);
    connection.addEventListener('icegatheringstatechange', changed);
  });
}

function teardown(): void {
  unsubCos?.();
  unsubCos = null;
  if (levelRaf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(levelRaf);
  levelRaf = null;
  analyser = null;
  void ctx?.close().catch(() => {});
  ctx = null;
  sink?.pause();
  if (sink) sink.srcObject = null;
  sink = null;
  mic?.getTracks().forEach((track) => track.stop());
  mic = null;
  muted = false;
  try { dc?.close(); } catch {}
  dc = null;
  try { pc?.close(); } catch {}
  pc = null;
  level = 0;
  spokenApprovals.clear();
  narratedTools = new Set<string>();
  responseActive = false;
  pendingSay = [];
  if (sessionId) {
    const id = sessionId;
    sessionId = '';
    void fetch(apiPath('/api/cos/voice/end'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: id }),
      keepalive: true,
    }).catch(() => {});
  }
  if (!microphoneRequestPending) releaseCapture();
}

function releaseCapture(): void {
  if (!captureClaimed || microphoneRequestPending) return;
  captureClaimed = false;
  void voiceCaptureArbiter.release('app_conversation');
}

function fail(message: string): void {
  error = message;
  teardown();
  notify('error');
}

async function errorText(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {}
  return `${fallback} (HTTP ${response.status})`;
}

export const voiceSessionController = {
  isSupported,
  isActive,
  isCaptureClaimed,
  snapshot,
  subscribe,
  start,
  stop,
  toggle,
  setMuted,
  dismissError,
  endedByServer,
};

export const legacyVoiceSessionController = voiceSessionController;