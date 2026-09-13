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
import type { VoiceAvailabilityReason } from './voice-settings.js';

export type VoiceSessionState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'error';

export interface VoiceSessionSnapshot {
  readonly state: VoiceSessionState;
  readonly level: number;
  readonly heard: string;
  readonly spoken: string;
  readonly error: string;
  /** The provider session is retained, but local input/output is paused. */
  readonly paused: boolean;
  /** True only while every live input track is disabled. */
  readonly muted: boolean;
  /** A live browser input track can be muted without ending the session. */
  readonly canMute: boolean;
  /** The running server explicitly exposed app-voice capability. */
  readonly available: boolean;
  /** Fixed server availability reason, retained while an active bridge drains. */
  readonly availabilityReason: VoiceAvailabilityReason;
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
let paused = false;
let pendingPause = false;
let pausedMuted = false;
let sessionId = '';
let lease: AppVoiceLease | null = null;
let generation = 0;
let releasing: Promise<void> | null = null;
interface InputSenderBinding {
  readonly sender: RTCRtpSender;
  readonly track: MediaStreamTrack;
}
let inputSenders: InputSenderBinding[] = [];
let pauseResumeFence = 0;
let pauseResumeSerial: Promise<void> = Promise.resolve();
let candidateAvailable = false;
let availabilityReason: VoiceAvailabilityReason = 'config_unavailable';
const listeners = new Set<Listener>();

function appIsSupported(): boolean {
  return (
    typeof RTCPeerConnection === 'function' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

function appSnapshot(): VoiceSessionSnapshot {
  return Object.freeze({
    state,
    level,
    heard,
    spoken,
    error,
    paused,
    muted,
    canMute: liveInputTracks().length > 0,
    available: candidateAvailable,
    availabilityReason,
    supported: appIsSupported(),
  });
}

function appSubscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function appIsActive(): boolean {
  return state !== 'idle' && state !== 'error';
}

/** Runtime server capability; false by default so audio remains opt-in. */
function appIsCandidateAvailable(): boolean {
  return candidateAvailable;
}

function appSetAvailability(available: boolean, reason: VoiceAvailabilityReason): void {
  if (candidateAvailable === available && availabilityReason === reason) return;
  candidateAvailable = available;
  availabilityReason = reason;
  publish();
}

function unavailableMessage(reason: VoiceAvailabilityReason): string {
  switch (reason) {
    case 'voice_disabled':
      return 'Voice mode is disabled in this server configuration.';
    case 'voice_config_invalid':
      return 'Voice mode configuration is invalid. Fix voice settings and restart the server.';
    case 'voice_provider_unavailable':
      return 'Voice provider is unavailable on this running server.';
    case 'config_unavailable':
      return 'Voice settings are unavailable from this server.';
    default:
      return 'Voice mode is unavailable on this running server.';
  }
}

function publish(next?: VoiceSessionState): void {
  if (next) {
    // Provider events can arrive after a pause request. A paused snapshot is a
    // hard presentation fence: only an explicit resume or a terminal error may
    // move it out of the paused state.
    if (!paused || next === 'paused' || next === 'error') state = next;
  }
  if (paused && state !== 'error') state = 'paused';
  const value = appSnapshot();
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

type StartPhase = 'claim' | 'session_setup' | 'microphone' | 'connection';

function startErrorMessage(cause: unknown, phase: StartPhase): string {
  const name =
    typeof cause === 'object' && cause !== null && 'name' in cause && typeof cause.name === 'string'
      ? cause.name
      : '';
  if (phase === 'microphone') {
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Microphone permission was denied. Allow microphone access, then Start voice mode.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone is available. Connect one, then Start voice mode.';
    }
    return 'Microphone setup failed. Check microphone access, then Start voice mode.';
  }
  if (phase === 'claim') return 'Could not claim app voice control. Try again.';
  const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : '';
  return phase === 'session_setup'
    ? `Voice session setup failed.${detail}`
    : `Voice connection failed.${detail}`;
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
  return inputActive && state === 'listening' && !paused && !pendingPause && !muted && liveInputTracks().length > 0;
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
  if (appIsActive()) fail('Microphone disconnected. Start voice mode to reconnect.', true, trackGeneration);
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
    if (paused) void nextContext.suspend().catch(() => {});
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
  audio.autoplay = !paused;
  audio.muted = paused;
  if (!paused) audio.play().catch(() => {});
  sink = audio;
}

function onRealtimeEvent(raw: unknown): void {
  if (paused || pendingPause) return;
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
      if (appIsActive() && peer && dataChannel && canPublishListening(peer, dataChannel)) publish('listening');
      break;
    case 'error': {
      // Provider messages may echo credentials or arbitrary request data.
      // Keep the visible mobile error bounded to fixed, actionable copy.
      const detail = event.error as { code?: unknown } | undefined;
      const message = detail?.code === 'rate_limit_exceeded'
        ? 'Voice provider is temporarily busy. Try again shortly.'
        : detail?.code === 'session_expired'
          ? 'The voice session expired. Start voice mode again.'
          : 'The voice provider reported a session error. Start voice mode again.';
      fail(message);
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
    !paused &&
    !pendingPause &&
    connection === peer &&
    channel === dataChannel &&
    channel.readyState === 'open' &&
    connection.currentRemoteDescription !== null &&
    liveInputTracks().length > 0
  );
}

type RealtimeControlType = 'response.cancel' | 'output_audio_buffer.clear';

function sendRealtimeControl(type: RealtimeControlType): void {
  if (dataChannel?.readyState !== 'open') return;
  try {
    dataChannel.send(JSON.stringify({ type }));
  } catch {
    // The peer may be closing. Local pause still fences playback and input.
  }
}

function cancelProviderOutput(): void {
  sendRealtimeControl('response.cancel');
  sendRealtimeControl('output_audio_buffer.clear');
}

async function detachInputSenders(): Promise<void> {
  const bindings = inputSenders.slice();
  await Promise.all(
    bindings.map(async ({ sender }) => {
      await sender.replaceTrack(null);
    }),
  );
}

async function restoreInputSenders(): Promise<void> {
  const bindings = inputSenders.slice();
  if (bindings.some(({ track }) => track.readyState !== 'live')) {
    throw new Error('The microphone ended while voice mode was paused.');
  }
  await Promise.all(
    bindings.map(async ({ sender, track }) => {
      await sender.replaceTrack(track);
    }),
  );
}

async function appStart(): Promise<void> {
  if (appIsActive() || releasing) return;
  if (!candidateAvailable) {
    error = unavailableMessage(availabilityReason);
    publish('error');
    return;
  }
  if (!appIsSupported()) {
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
  paused = false;
  pendingPause = false;
  pausedMuted = false;
  pauseResumeFence++;
  inputActive = false;
  stopInputLevelMeter(false);
  publish('connecting');
  let phase: StartPhase = 'claim';
  try {
    const claimedLease = await appVoiceOperations.claim(false);
    if (generation !== current) {
      appVoiceOperations.releaseLease(claimedLease);
      return;
    }
    lease = claimedLease;
    phase = 'session_setup';
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

    phase = 'microphone';
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
    if (paused) {
      for (const track of liveInputTracks()) track.enabled = false;
      inputActive = false;
      stopInputLevelMeter(false);
      syncMuted();
      void meterContext?.suspend().catch(() => {});
    }
    syncMuted();
    phase = 'connection';
    const connection = new RTCPeerConnection();
    peer = connection;
    inputSenders = [];
    for (const track of microphone.getTracks()) {
      inputSenders.push({ sender: connection.addTrack(track, microphone), track });
    }
    if (paused) {
      await detachInputSenders();
      if (generation !== current) return;
      pendingPause = false;
    }
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
      if (paused || pendingPause) cancelProviderOutput();
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
    if (generation === current) fail(startErrorMessage(cause, phase));
  }
}

/**
 * This is the local drain boundary used for Stop, owner lease loss, and
 * takeover. It releases browser tracks/sink/peer before any drain ACK; this
 * truthfully proves local resource release, not acoustic playback proof.
 */
async function releaseBrowserMedia(): Promise<void> {
  inputActive = false;
  pendingPause = false;
  paused = false;
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
  inputSenders = [];
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
  pendingPause = false;
  paused = false;
  pauseResumeFence++;
  if (releasing) return releasing;
  const previousLease = lease;
  const previousSession = sessionId;
  lease = null;
  sessionId = '';
  generation++;
  if (!previousLease) appVoiceOperations.cancelClaim();
  // Install the release barrier before notifying lease listeners. A local
  // release notifies synchronously; without this ordering its listener would
  // recursively start a second browser-media cleanup.
  const browserRelease = releaseBrowserMedia();
  releasing = browserRelease
    .then(async () => {
      if (!sendEnd || !previousLease) return;
      const ended = previousSession !== '' && (await endProviderSession(previousLease, previousSession));
      if (ended) appVoiceOperations.endLease(previousLease.lease_epoch);
    })
    .finally(() => {
      releasing = null;
      void voiceCaptureArbiter.release('app_conversation');
    });
  // Stop withdraws the old owner epoch before awaiting browser/media cleanup.
  // `previousLease` remains an immutable correlation for the bounded provider
  // end request below; no cleanup path reads the mutable current lease.
  if (previousLease) appVoiceOperations.releaseLease(previousLease);
  return releasing;
}

function appStop(): void {
  error = '';
  void beginRelease(true);
  publish('idle');
}

function resumeErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return `Voice mode could not resume safely: ${cause.message}`;
  return 'Voice mode could not resume safely. Start voice mode again.';
}

async function appPause(): Promise<void> {
  if (!appIsActive() || paused) return;
  const currentGeneration = generation;
  const currentFence = ++pauseResumeFence;
  pendingPause = true;
  pausedMuted = muted;
  paused = true;
  state = 'paused';
  inputActive = false;
  stopInputLevelMeter(false);
  for (const track of liveInputTracks()) track.enabled = false;
  syncMuted();
  if (sink) {
    sink.pause();
    sink.muted = true;
  }
  const suspendingMeter = meterContext?.suspend() ?? Promise.resolve();
  cancelProviderOutput();
  publish('paused');

  try {
    await Promise.all([suspendingMeter, detachInputSenders()]);
    if (generation !== currentGeneration || !paused || pauseResumeFence !== currentFence) return;
    // A connection which has not acquired its tracks yet keeps this intent in
    // `pendingPause`; appStart applies it at the first safe media boundary.
    if (peer) pendingPause = false;
  } catch (cause) {
    if (generation !== currentGeneration || !paused || pauseResumeFence !== currentFence) return;
    paused = false;
    pendingPause = false;
    error = resumeErrorMessage(cause);
    publish('error');
    await beginRelease(true);
  }
}

async function appResume(): Promise<void> {
  if (!paused) return;
  const currentGeneration = generation;
  const currentFence = ++pauseResumeFence;
  const tracks = liveInputTracks();
  if (microphone && tracks.length === 0) {
    paused = false;
    pendingPause = false;
    error = 'The microphone ended while voice mode was paused. Start voice mode again.';
    publish('error');
    await beginRelease(true);
    return;
  }

  const playback = sink
    ? (() => {
        sink!.muted = false;
        return sink!.play();
      })()
    : Promise.resolve();
  const resumingMeter = meterContext?.resume() ?? Promise.resolve();
  try {
    await Promise.all([restoreInputSenders(), playback, resumingMeter]);
    if (generation !== currentGeneration || !paused || pauseResumeFence !== currentFence) return;
    for (const track of tracks) track.enabled = !pausedMuted;
    paused = false;
    pendingPause = false;
    inputActive = false;
    syncMuted();
    if (peer && dataChannel && canPublishListening(peer, dataChannel)) {
      publish('listening');
    } else {
      publish('connecting');
    }
  } catch (cause) {
    if (generation !== currentGeneration || !paused || pauseResumeFence !== currentFence) return;
    for (const track of tracks) track.enabled = false;
    if (sink) {
      sink.pause();
      sink.muted = true;
    }
    void meterContext?.suspend().catch(() => {});
    try {
      await detachInputSenders();
    } catch {
      // The terminal stop below still closes the peer and ends every track.
    }
    paused = false;
    pendingPause = false;
    error = resumeErrorMessage(cause);
    publish('error');
    await beginRelease(true);
  }
}

function serializePauseResume(operation: () => Promise<void>): Promise<void> {
  const next = pauseResumeSerial.then(operation, operation);
  pauseResumeSerial = next.catch(() => {});
  return next;
}

/**
 * Toggle only the actual browser input tracks. The peer connection, provider
 * session, data channel and output sink remain in place while muted.
 */
function appSetMuted(next: boolean): void {
  if (paused) return;
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
function appDismissError(): void {
  if (state !== 'error') return;
  error = '';
  publish('idle');
}

function fail(message: string, sendEnd = true, expectedGeneration = generation): void {
  if (generation !== expectedGeneration) return;
  paused = false;
  pendingPause = false;
  pauseResumeFence++;
  error = message;
  publish('error');
  void beginRelease(sendEnd);
}

appVoiceOperations.onLeaseChange((next, reason) => {
  lease = next;
  if (next === null && appIsActive()) {
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

/**
 * Runtime facts from the authenticated settings endpoint. Presentation props
 * are never accepted here: only this server status may enable a transport.
 */
export interface VoiceAvailability {
  readonly available: boolean;
  readonly availabilityReason: VoiceAvailabilityReason;
}

const facadeListeners = new Set<Listener>();

function transportIsReleasing(): boolean {
  return releasing !== null;
}

function facadeSnapshot(): VoiceSessionSnapshot {
  return appSnapshot();
}

function publishFacade(): void {
  const value = facadeSnapshot();
  for (const listener of facadeListeners) listener(value);
}

// Each transport has exactly one bridge into the public singleton. Components
// subscribe only to this app-v1 transport, so navigation cannot mount a
// second session or choose a legacy backend.
appSubscribe(publishFacade);

export function isSupported(): boolean {
  return appIsSupported();
}

/** Compatibility for existing fixture callers; this never enables legacy. */
export function isCandidateAvailable(): boolean {
  return appIsCandidateAvailable();
}

/** Compatibility for older callers that knew only the app-v1 capability. */
export function setCandidateAvailable(available: boolean): void {
  appSetAvailability(available, available ? 'ready' : 'voice_provider_unavailable');
  publishFacade();
}

/**
 * Availability controls future starts only. An active transport remains owned
 * by its original backend until explicit Stop or its authoritative end event;
 * a settings refresh is not a session-revocation message.
 */
export function setAvailability(availability: VoiceAvailability): void {
  // This governs only future Starts. Existing leases stay alive until their
  // authoritative end, explicit Stop, owner loss, or takeover drain.
  appSetAvailability(availability.available, availability.availabilityReason);
  publishFacade();
}

export function isActive(): boolean {
  return appIsActive();
}

export function isPaused(): boolean {
  return paused;
}

export function snapshot(): VoiceSessionSnapshot {
  return facadeSnapshot();
}

export function subscribe(listener: Listener): () => void {
  facadeListeners.add(listener);
  return () => facadeListeners.delete(listener);
}

export async function start(): Promise<void> {
  if (isActive()) return;
  // Do not re-enter while this transport is still draining a late permission
  // or media cleanup.
  if (transportIsReleasing()) return;
  if (!candidateAvailable) {
    // The unavailable control is disabled in product UI, but preserve an
    // explicit, truthful error for programmatic callers without touching media.
    await appStart();
    return;
  }
  await appStart();
  publishFacade();
}

export function stop(): void {
  appStop();
  publishFacade();
}

export function pause(): Promise<void> {
  return serializePauseResume(appPause);
}

export function resume(): Promise<void> {
  return serializePauseResume(appResume);
}

export async function togglePaused(): Promise<void> {
  if (paused) {
    await resume();
    return;
  }
  if (appIsActive()) await pause();
}

export async function toggle(): Promise<void> {
  if (isActive()) {
    stop();
    return;
  }
  await start();
}

export function setMuted(next: boolean): void {
  appSetMuted(next);
}

export function dismissError(): void {
  appDismissError();
  publishFacade();
}

/** Legacy COS events are not app-v1 authority and cannot end this lease. */
export function endedByServer(_endedSessionId: string): void {
  // App voice lease-end frames are handled by appVoiceOperations above.
}

export const voiceSessionController = {
  isSupported,
  isCandidateAvailable,
  setCandidateAvailable,
  setAvailability,
  isActive,
  isPaused,
  snapshot,
  subscribe,
  start,
  stop,
  pause,
  resume,
  togglePaused,
  setMuted,
  dismissError,
  toggle,
  endedByServer,
};