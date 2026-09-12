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
  /** True only while every live input track is disabled. */
  readonly muted: boolean;
  /** A live browser input track can be muted without ending the session. */
  readonly canMute: boolean;
  /** The running server explicitly exposed app-voice capability. */
  readonly available: boolean;
  /** This browser can create the required WebRTC/media objects. */
  readonly supported: boolean;
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
let meterContext: AudioContext | null = null;
let meterSource: MediaStreamAudioSourceNode | null = null;
let meterAnalyser: AnalyserNode | null = null;
let levelTimer: ReturnType<typeof setInterval> | null = null;
let inputActive = false;
let muted = false;
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
  return Object.freeze({
    state,
    level,
    heard,
    spoken,
    error,
    muted,
    canMute: liveInputTracks().length > 0,
    available: candidateAvailable,
    supported: isSupported(),
  });
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

function liveInputTracks(): MediaStreamTrack[] {
  return microphone?.getAudioTracks().filter((track) => track.readyState === 'live') ?? [];
}

function tracksAreMuted(): boolean {
  const tracks = liveInputTracks();
  return tracks.length > 0 && tracks.every((track) => !track.enabled);
}

function syncMuted(): boolean {
  const next = tracksAreMuted();
  if (muted === next) return false;
  muted = next;
  return true;
}

function shouldMeasureInput(): boolean {
  return inputActive && state === 'listening' && !muted && liveInputTracks().length > 0;
}

function stopInputLevelMeter(publishChange = true): void {
  if (levelTimer !== null) clearInterval(levelTimer);
  levelTimer = null;
  if (level === 0) return;
  level = 0;
  if (publishChange) publish();
}

function onInputTrackEnded(stream: MediaStream, trackGeneration: number): void {
  // A stopped generation must never release or overwrite a newer capture.
  if (generation !== trackGeneration || microphone !== stream) return;
  if (liveInputTracks().length > 0) {
    syncMuted();
    publish();
    return;
  }
  inputActive = false;
  stopInputLevelMeter(false);
  syncMuted();
  if (isActive()) fail('Microphone disconnected. Start voice mode to reconnect.', true, trackGeneration);
}

function attachInputMeter(stream: MediaStream, trackGeneration: number): void {
  stopInputLevelMeter(false);
  meterSource?.disconnect();
  meterSource = null;
  meterAnalyser?.disconnect();
  meterAnalyser = null;
  void meterContext?.close().catch(() => {});
  meterContext = null;
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => onInputTrackEnded(stream, trackGeneration));
  }
  try {
    const nextContext = new AudioContext();
    const nextSource = nextContext.createMediaStreamSource(stream);
    const nextAnalyser = nextContext.createAnalyser();
    nextAnalyser.fftSize = 512;
    nextAnalyser.smoothingTimeConstant = 0.6;
    nextSource.connect(nextAnalyser);
    meterContext = nextContext;
    meterSource = nextSource;
    meterAnalyser = nextAnalyser;
    void nextContext.resume().catch(() => {});
  } catch {
    meterAnalyser = null;
  }
}

function detachInputMeter(): void {
  stopInputLevelMeter(false);
  meterSource?.disconnect();
  meterSource = null;
  meterAnalyser?.disconnect();
  meterAnalyser = null;
}

function startInputLevelMeter(): void {
  if (levelTimer !== null || !meterAnalyser || !shouldMeasureInput()) return;
  const values = new Uint8Array(meterAnalyser.frequencyBinCount);
  const sample = (): void => {
    if (!meterAnalyser || !shouldMeasureInput()) {
      stopInputLevelMeter();
      return;
    }
    meterAnalyser.getByteTimeDomainData(values);
    let sum = 0;
    for (const value of values) {
      const sampleValue = (value - 128) / 128;
      sum += sampleValue * sampleValue;
    }
    const next = Math.min(1, Math.sqrt(sum / Math.max(1, values.length)) * 3.2);
    if (Math.abs(next - level) > 0.01) {
      level = next;
      publish();
    }
  };
  levelTimer = setInterval(sample, 100);
  sample();
}

function attachSink(stream: MediaStream): void {
  sink?.pause();
  const audio = new Audio();
  audio.srcObject = stream;
  audio.autoplay = true;
  audio.play().catch(() => {});
  sink = audio;
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
      if (!peer || !dataChannel || !canPublishListening(peer, dataChannel)) return;
      spoken = '';
      inputActive = !muted;
      publish('listening');
      startInputLevelMeter();
      break;
    case 'input_audio_buffer.speech_stopped':
      inputActive = false;
      stopInputLevelMeter();
      break;
    case 'conversation.item.input_audio_transcription.completed':
      heard = String(event.transcript ?? '').trim();
      publish();
      break;
    case 'response.created':
      spoken = '';
      inputActive = false;
      stopInputLevelMeter(false);
      publish('thinking');
      break;
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      spoken += String(event.delta ?? '');
      inputActive = false;
      stopInputLevelMeter(false);
      publish('speaking');
      break;
    case 'response.done':
    case 'response.cancelled':
      inputActive = false;
      stopInputLevelMeter(false);
      if (isActive() && peer && dataChannel && canPublishListening(peer, dataChannel)) publish('listening');
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

function canPublishListening(connection: RTCPeerConnection, channel: RTCDataChannel): boolean {
  return (
    connection === peer &&
    channel === dataChannel &&
    channel.readyState === 'open' &&
    connection.currentRemoteDescription !== null &&
    liveInputTracks().length > 0
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
  muted = false;
  inputActive = false;
  stopInputLevelMeter(false);
  publish('connecting');
  try {
    const claimedLease = await appVoiceOperations.claim(false);
    if (generation !== current) {
      appVoiceOperations.releaseLease(claimedLease);
      return;
    }
    lease = claimedLease;
    const tokenResponse = await fetch(apiPath('/api/app/voice/token'), {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: headers(claimedLease.control_token),
      body: JSON.stringify({ protocol_version: APP_VOICE_PROTOCOL_VERSION, lease_epoch: claimedLease.lease_epoch }),
    });
    if (!tokenResponse.ok) throw new Error(await errorText(tokenResponse, 'Could not mint the app voice session'));
    const token = (await tokenResponse.json()) as TokenResponse;
    if (!token.session_id) throw new Error('The app voice provider returned no session.');
    if (generation !== current) {
      appVoiceOperations.releaseLease(claimedLease);
      return;
    }
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
    attachInputMeter(acquiredMicrophone, current);
    syncMuted();
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
    let remoteDescriptionAccepted = false;
    dataChannel.onmessage = (event) => {
      if (generation === current) onRealtimeEvent(event.data);
    };
    dataChannel.onopen = () => {
      if (generation !== current) return;
      configureSession();
      if (remoteDescriptionAccepted && canPublishListening(connection, dataChannel!)) {
        publish('listening');
      }
    };
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIce(connection);
    if (generation !== current) {
      appVoiceOperations.releaseLease(claimedLease);
      return;
    }
    const response = await fetch(apiPath('/api/app/voice/sdp'), {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/sdp',
        'X-App-Voice-Protocol': String(APP_VOICE_PROTOCOL_VERSION),
        'X-App-Voice-Control': claimedLease.control_token,
        'X-App-Voice-Lease-Epoch': String(claimedLease.lease_epoch),
        'X-App-Voice-Session': sessionId,
      },
      body: connection.localDescription?.sdp ?? offer.sdp ?? '',
    });
    if (generation !== current) {
      appVoiceOperations.releaseLease(claimedLease);
      return;
    }
    if (!response.ok) throw new Error(await errorText(response, 'The app voice provider refused the connection'));
    if (response.headers.get('X-App-Voice-Session') !== sessionId) {
      throw new Error('The app voice provider returned a different session.');
    }
    await connection.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    remoteDescriptionAccepted = true;
    if (generation === current && dataChannel && canPublishListening(connection, dataChannel)) {
      publish('listening');
    }
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
  inputActive = false;
  detachInputMeter();
  const closingMeterContext = meterContext;
  meterContext = null;
  if (sink) {
    sink.pause();
    sink.srcObject = null;
    sink = null;
  }
  microphone?.getTracks().forEach((track) => track.stop());
  microphone = null;
  muted = false;
  try {
    dataChannel?.close();
  } catch {}
  dataChannel = null;
  try {
    peer?.close();
  } catch {}
  peer = null;
  level = 0;
  // Sources are disconnected and tracks stopped above; do not let a browser
  // AudioContext close hang the explicit-stop release deadline.
  void closingMeterContext?.close().catch(() => {});
}

async function endProviderSession(previousLease: AppVoiceLease, previousSession: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(apiPath('/api/app/voice/end'), {
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
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    // The exact owner-epoch WebSocket release below is the bounded fallback.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function beginRelease(sendEnd: boolean): Promise<void> {
  if (releasing) return releasing;
  const previousLease = lease;
  const previousSession = sessionId;
  lease = null;
  sessionId = '';
  generation++;
  if (!previousLease) appVoiceOperations.cancelClaim();
  releasing = releaseBrowserMedia()
    .then(async () => {
      if (!sendEnd || !previousLease) return;
      const ended = previousSession !== '' && (await endProviderSession(previousLease, previousSession));
      if (ended) appVoiceOperations.endLease(previousLease.lease_epoch);
      else appVoiceOperations.releaseLease(previousLease);
    })
    .finally(() => {
      releasing = null;
      void voiceCaptureArbiter.release('app_conversation');
    });
  return releasing;
}

export function stop(): void {
  void beginRelease(true);
  publish('idle');
}

/**
 * Toggle only the actual browser input tracks. The peer connection, provider
 * session, data channel and output sink remain in place while muted.
 */
export function setMuted(next: boolean): void {
  const tracks = liveInputTracks();
  if (tracks.length === 0) return;
  for (const track of tracks) track.enabled = !next;
  inputActive = false;
  const levelChanged = level !== 0;
  stopInputLevelMeter(false);
  const mutedChanged = syncMuted();
  if (levelChanged || mutedChanged) publish();
}

/** An idle error is presentational and may be dismissed without starting media. */
export function dismissError(): void {
  if (state !== 'error') return;
  error = '';
  publish('idle');
}

function fail(message: string, sendEnd = true, expectedGeneration = generation): void {
  if (generation !== expectedGeneration) return;
  error = message;
  publish('error');
  void beginRelease(sendEnd);
}

/** Legacy server notices do not control an app v1 lease. */
export function endedByServer(_sessionId: string): void {}

appVoiceOperations.onLeaseChange((next, reason) => {
  lease = next;
  if (next === null && isActive()) {
    fail(
      reason === 'takeover' ? 'App voice was released for an explicit takeover.' : 'The app voice lease ended.',
      false,
    );
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
  setMuted,
  dismissError,
  toggle,
  endedByServer,
};