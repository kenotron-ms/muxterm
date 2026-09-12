/**
 * App-global conversational provider transport.
 *
 * The authenticated owner lease is independent of Mission Control selection:
 * no composer, thread, pane, workspace, applet, or Lobby navigation is read
 * here or can stop/remint this connection. Microphone access occurs only from
 * explicit `start()` user intent.
 */

import { apiPath } from './base-path.js';
import {
  appVoiceOperations,
  APP_VOICE_PROTOCOL_VERSION,
  type AppVoiceLease,
} from './app-voice-operations.js';
import { voiceCaptureArbiter } from './voice-capture-arbiter.js';

export type VoiceSessionState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface VoiceSessionSnapshot {
  readonly state: VoiceSessionState;
  readonly level: number;
  readonly heard: string;
  readonly spoken: string;
  readonly error: string;
}

interface TokenResponse {
  readonly session_id: string;
  readonly expires_at: number;
  readonly model: string;
}

type Listener = (snapshot: VoiceSessionSnapshot) => void;

let state: VoiceSessionState = 'idle';
let level = 0;
let heard = '';
let spoken = '';
let error = '';
let peer: RTCPeerConnection | null = null;
let dataChannel: RTCDataChannel | null = null;
let microphone: MediaStream | null = null;
let sink: HTMLAudioElement | null = null;
let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let levelRaf: number | null = null;
let sessionId = '';
let lease: AppVoiceLease | null = null;
let generation = 0;
let releasing: Promise<void> | null = null;
let candidateAvailable = false;
const listeners = new Set<Listener>();

export function isSupported(): boolean {
  return (
    typeof RTCPeerConnection === 'function' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

export function snapshot(): VoiceSessionSnapshot {
  return Object.freeze({ state, level, heard, spoken, error });
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isActive(): boolean {
  return state !== 'idle' && state !== 'error';
}

/** Runtime server capability; false by default so audio remains opt-in. */
export function isCandidateAvailable(): boolean {
  return candidateAvailable;
}

export function setCandidateAvailable(available: boolean): void {
  if (candidateAvailable === available) return;
  candidateAvailable = available;
  publish();
}

function publish(next?: VoiceSessionState): void {
  if (next) state = next;
  const value = snapshot();
  for (const listener of listeners) listener(value);
}

function headers(control: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-App-Voice-Protocol': String(APP_VOICE_PROTOCOL_VERSION),
    'X-App-Voice-Control': control,
  };
}

async function errorText(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // A provider SDP response is not JSON.
  }
  return `${fallback} (HTTP ${response.status})`;
}

async function waitForIce(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      connection.removeEventListener('icegatheringstatechange', changed);
      clearTimeout(timer);
      resolve();
    };
    const changed = (): void => {
      if (connection.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, 2_000);
    connection.addEventListener('icegatheringstatechange', changed);
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
    void context?.close();
    context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    startLevelLoop();
  } catch {
    analyser = null;
  }
}

function startLevelLoop(): void {
  if (levelRaf !== null) return;
  const values = new Uint8Array(analyser?.frequencyBinCount ?? 0);
  const loop = (): void => {
    if (!analyser || !isActive()) {
      levelRaf = null;
      return;
    }
    analyser.getByteTimeDomainData(values);
    let sum = 0;
    for (const value of values) {
      const sample = (value - 128) / 128;
      sum += sample * sample;
    }
    const next = Math.min(1, Math.sqrt(sum / Math.max(1, values.length)) * 3.2);
    if (Math.abs(next - level) > 0.01) {
      level = next;
      publish();
    }
    levelRaf = requestAnimationFrame(loop);
  };
  levelRaf = requestAnimationFrame(loop);
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
      publish('listening');
      break;
    case 'conversation.item.input_audio_transcription.completed':
      heard = String(event.transcript ?? '').trim();
      publish();
      break;
    case 'response.created':
      spoken = '';
      publish('thinking');
      break;
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      spoken += String(event.delta ?? '');
      publish('speaking');
      break;
    case 'response.done':
    case 'response.cancelled':
      if (isActive()) publish('listening');
      break;
    case 'error': {
      const detail = event.error as { message?: unknown } | undefined;
      fail(typeof detail?.message === 'string' ? detail.message : 'The voice provider reported an error.');
      break;
    }
  }
}

function configureSession(): void {
  if (dataChannel?.readyState !== 'open') return;
  dataChannel.send(
    JSON.stringify({
      type: 'session.update',
      session: { type: 'realtime', audio: { input: { transcription: { model: 'whisper-1' } } } },
    }),
  );
}

export async function toggle(): Promise<void> {
  if (isActive()) {
    stop();
    return;
  }
  await start();
}

export async function start(): Promise<void> {
  if (isActive() || releasing) return;
  if (!candidateAvailable) {
    error = 'App voice is not enabled for this running server.';
    publish('error');
    return;
  }
  if (!isSupported()) {
    error = 'This browser cannot start a WebRTC voice session.';
    publish('error');
    return;
  }
  const acquired = voiceCaptureArbiter.acquire('app_conversation');
  if (!acquired.ok) {
    error =
      acquired.owner === 'composer_dictation'
        ? 'Finish dictation before starting a spoken conversation.'
        : 'Another microphone capture is still releasing.';
    publish('error');
    return;
  }
  const current = ++generation;
  error = '';
  heard = '';
  spoken = '';
  publish('connecting');
  try {
    lease = await appVoiceOperations.claim(false);
    if (generation !== current) return;
    const tokenResponse = await fetch(apiPath('/api/app/voice/token'), {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: headers(lease.control_token),
      body: JSON.stringify({ protocol_version: APP_VOICE_PROTOCOL_VERSION, lease_epoch: lease.lease_epoch }),
    });
    if (!tokenResponse.ok) throw new Error(await errorText(tokenResponse, 'Could not mint the app voice session'));
    const token = (await tokenResponse.json()) as TokenResponse;
    if (!token.session_id || generation !== current) return;
    sessionId = token.session_id;

    const acquiredMicrophone = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (generation !== current) {
      // Do not call the global release path here: a stopped, late permission
      // request can resolve after a newer session owns those globals.
      acquiredMicrophone.getTracks().forEach((track) => track.stop());
      return;
    }
    microphone = acquiredMicrophone;
    const connection = new RTCPeerConnection();
    peer = connection;
    for (const track of microphone.getTracks()) connection.addTrack(track, microphone);
    connection.ontrack = (event) => {
      if (generation === current) attachSink(event.streams[0] ?? new MediaStream([event.track]));
    };
    connection.onconnectionstatechange = () => {
      if (
        generation === current &&
        (connection.connectionState === 'failed' || connection.connectionState === 'closed')
      ) {
        fail('The app voice connection dropped.');
      }
    };
    dataChannel = connection.createDataChannel('oai-events');
    dataChannel.onmessage = (event) => {
      if (generation === current) onRealtimeEvent(event.data);
    };
    dataChannel.onopen = () => {
      if (generation !== current) return;
      configureSession();
      publish('listening');
    };
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIce(connection);
    if (generation !== current || !lease) return;
    const response = await fetch(apiPath('/api/app/voice/sdp'), {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/sdp',
        'X-App-Voice-Protocol': String(APP_VOICE_PROTOCOL_VERSION),
        'X-App-Voice-Control': lease.control_token,
        'X-App-Voice-Lease-Epoch': String(lease.lease_epoch),
        'X-App-Voice-Session': sessionId,
      },
      body: connection.localDescription?.sdp ?? offer.sdp ?? '',
    });
    if (!response.ok) throw new Error(await errorText(response, 'The app voice provider refused the connection'));
    if (response.headers.get('X-App-Voice-Session') !== sessionId) {
      throw new Error('The app voice provider returned a different session.');
    }
    await connection.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  } catch (cause) {
    if (generation === current) fail(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * This is the local drain boundary used for Stop, owner lease loss, and
 * takeover. It releases browser tracks/sink/peer before any drain ACK; this
 * truthfully proves local resource release, not acoustic playback proof.
 */
async function releaseBrowserMedia(): Promise<void> {
  if (levelRaf !== null) cancelAnimationFrame(levelRaf);
  levelRaf = null;
  analyser = null;
  if (context) await context.close().catch(() => {});
  context = null;
  if (sink) {
    sink.pause();
    sink.srcObject = null;
    sink = null;
  }
  microphone?.getTracks().forEach((track) => track.stop());
  microphone = null;
  try {
    dataChannel?.close();
  } catch {}
  dataChannel = null;
  try {
    peer?.close();
  } catch {}
  peer = null;
  level = 0;
}

function beginRelease(sendEnd: boolean): Promise<void> {
  if (releasing) return releasing;
  const previousLease = lease;
  const previousSession = sessionId;
  sessionId = '';
  generation++;
  releasing = releaseBrowserMedia()
    .then(async () => {
      if (sendEnd && previousLease && previousSession) {
        await fetch(apiPath('/api/app/voice/end'), {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: headers(previousLease.control_token),
          body: JSON.stringify({
            protocol_version: APP_VOICE_PROTOCOL_VERSION,
            lease_epoch: previousLease.lease_epoch,
            session_id: previousSession,
          }),
          keepalive: true,
        }).catch(() => {});
      }
    })
    .finally(() => {
      releasing = null;
      void voiceCaptureArbiter.release('app_conversation');
    });
  return releasing;
}

export function stop(): void {
  void beginRelease(true).finally(() => publish('idle'));
}

function fail(message: string): void {
  error = message;
  void beginRelease(true).finally(() => publish('error'));
}

/** Legacy server notices do not control an app v1 lease. */
export function endedByServer(_sessionId: string): void {}

appVoiceOperations.onLeaseChange((next, reason) => {
  lease = next;
  if (next === null && isActive()) {
    error = reason === 'takeover' ? 'App voice was released for an explicit takeover.' : 'The app voice lease ended.';
    void beginRelease(false).finally(() => publish('error'));
  }
});

appVoiceOperations.onDrainRequest(async (epoch, nonce) => {
  if (!lease || lease.lease_epoch !== epoch) return;
  await beginRelease(false);
  appVoiceOperations.acknowledgeDrain(epoch, nonce);
  publish('idle');
});

export const voiceSessionController = {
  isSupported,
  isCandidateAvailable,
  setCandidateAvailable,
  isActive,
  snapshot,
  subscribe,
  start,
  stop,
  toggle,
  endedByServer,
};