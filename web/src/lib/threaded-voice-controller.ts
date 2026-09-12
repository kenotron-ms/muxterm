/**
 * Threaded Mission Control voice is a deliberately separate, default-off
 * browser transport. It never touches the legacy global voice controller or
 * CosStore: one attachment owns one immutable text-root runtime address.
 *
 * The browser does not create provider responses. The server owns sideband
 * lifetime, provider response creation, tool correlation, and drain proof.
 * This file owns only a scoped WebRTC peer, a local-only prefix utterance, and
 * browser microphone/sink cleanup boundaries.
 */

import { apiPath } from './base-path.js';
import type { ExplicitThreadSelection, ThreadVoiceTarget } from './thread-store.js';

const VOICE_PROTOCOL_VERSION = 3;
const CONTROL_HEADER = 'X-MissionControl-Voice-Control';
const PROTOCOL_HEADER = 'X-MissionControl-Voice-Protocol';
const MAX_PREFIX_CHARS = 320;
const MAX_SDP_CHARS = 256 * 1024;
const MAX_CAPTURE_ID_CHARS = 256;
const MAX_REMEMBERED_PREFIXES = 64;
const HEARTBEAT_INTERVAL_MS = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ThreadedVoiceState =
  | 'unavailable'
  | 'idle'
  | 'attaching'
  | 'awaiting-route-prefix'
  | 'route-pending'
  | 'paused'
  | 'capturing'
  | 'awaiting-answer-prefix'
  | 'draining'
  | 'error';

/**
 * This remains named Capability for the existing composer seam. The dynamic
 * fields describe only browser-local experimental attachment state; no secret,
 * provider session ID, lease ID, nonce, or capture ID ever leaves this module.
 */
export interface ThreadedVoiceCapability {
  readonly candidateConfigured: boolean;
  /** Server-reported global voice state, intentionally not an enable switch. */
  readonly voiceEnabled: boolean;
  readonly experimentalReady: boolean;
  readonly state: ThreadedVoiceState;
  readonly status: string;
  readonly refusal: string;
  readonly canStart: boolean;
  readonly canCapture: boolean;
  readonly canEndCapture: boolean;
  readonly canStop: boolean;
  readonly prefixPending: boolean;
  readonly level: number;
}

interface CandidateCapabilities {
  readonly candidateConfigured: boolean;
  readonly voiceEnabled: boolean;
  readonly protocolReady: boolean;
  readonly refusal: string;
}

interface VoiceLease {
  readonly target: ThreadVoiceTarget;
  readonly leaseEpoch: number;
  readonly focusEpoch: number;
  readonly captureEpoch: number;
  readonly attachmentEpoch: number;
  readonly state: string;
}

interface Capture {
  readonly id: string;
  readonly epoch: number;
  stream: MediaStream | null;
  ending: Promise<void> | null;
}

interface Attachment {
  readonly epoch: number;
  readonly target: ThreadVoiceTarget;
  readonly controlToken: string;
  readonly leaseEpoch: number;
  focusEpoch: number;
  attachmentEpoch: number;
  readonly sessionId: string;
  peer: RTCPeerConnection | null;
  sender: RTCRtpSender | null;
  remoteStream: MediaStream | null;
  sink: HTMLAudioElement | null;
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  levelRaf: number | null;
  eventCursor: number;
  pollAbort: AbortController | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatInFlight: boolean;
  committed: boolean;
  routeAnnounced: boolean;
  capture: Capture | null;
  draining: boolean;
  drainNonce: string;
  drainAcknowledged: boolean;
  /** One browser drain acknowledgement request at a time for drainNonce. */
  drainAcknowledging: Promise<void> | null;
  routeAfterDrain: ThreadVoiceTarget | null;
  muting: Promise<void> | null;
  /** Invalidates a pending getUserMedia/replaceTrack continuation on every mute. */
  captureOperation: number;
  captureStarting: boolean;
}

interface PrefixRecord {
  readonly attachment: Attachment;
  readonly nonce: string;
  readonly kind: 'route' | 'answer';
  readonly cursor: number;
  readonly captureId: string;
  utterance: SpeechSynthesisUtterance | null;
  completed: boolean;
  acknowledged: boolean;
  cancelled: boolean;
}

interface VoiceEvent {
  readonly cursor: number;
  readonly type: 'prefix_request' | 'prefix_timeout' | 'drain_request' | 'drain_complete' | 'attachment_failed';
  readonly nonce: string;
  readonly kind: '' | 'route' | 'answer';
  readonly attachmentEpoch: number;
  readonly focusEpoch: number;
  readonly captureId: string;
  readonly message: string;
}

class VoiceRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Listener = (snapshot: ThreadedVoiceCapability) => void;

const unavailableCandidate: CandidateCapabilities = Object.freeze({
  candidateConfigured: false,
  voiceEnabled: false,
  protocolReady: false,
  refusal: 'Threaded voice not available yet',
});

let candidate = unavailableCandidate;
let state: ThreadedVoiceState = 'unavailable';
let status = 'Threaded voice not available yet';
let attachment: Attachment | null = null;
let startingEpoch = 0;
let startAbort: AbortController | null = null;
let nextEpoch = 0;
let level = 0;
let pendingSelectionRoute = false;
let drainedControlToken = '';
let activePrefix: PrefixRecord | null = null;
let readonlyPrefixRecords = new Map<string, PrefixRecord>();
let speechVoiceListenerInstalled = false;

const listeners = new Set<Listener>();

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bounded(value: unknown, maximum: number): string {
  const text = stringValue(value).trim();
  return text.length > 0 && text.length <= maximum ? text : '';
}

function errorText(body: Record<string, unknown>, fallback: string): string {
  const detail = bounded(body.error, 360);
  const code = bounded(body.code, 96);
  return detail || code || fallback;
}

function isTarget(value: ThreadVoiceTarget | null): value is ThreadVoiceTarget {
  return (
    value !== null &&
    UUID_RE.test(value.threadId) &&
    UUID_RE.test(value.runtimeSessionId) &&
    UUID_RE.test(value.runtimeIncarnation) &&
    Number.isSafeInteger(value.runtimeGeneration) &&
    value.runtimeGeneration > 0
  );
}

function sameTarget(left: ThreadVoiceTarget, right: ThreadVoiceTarget): boolean {
  return (
    left.threadId === right.threadId &&
    left.runtimeSessionId === right.runtimeSessionId &&
    left.runtimeGeneration === right.runtimeGeneration &&
    left.runtimeIncarnation === right.runtimeIncarnation
  );
}

function frozenTarget(target: ThreadVoiceTarget): ThreadVoiceTarget {
  return Object.freeze({
    threadId: target.threadId,
    runtimeSessionId: target.runtimeSessionId,
    runtimeGeneration: target.runtimeGeneration,
    runtimeIncarnation: target.runtimeIncarnation,
    label: target.label.slice(0, 160),
  });
}

function hasWebRTC(): boolean {
  return typeof RTCPeerConnection === 'function' && typeof MediaStream === 'function';
}

function hasMediaCapture(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

function speechApi(): SpeechSynthesis | null {
  return typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
}

function localSpeechVoice(): SpeechSynthesisVoice | null {
  const synth = speechApi();
  if (!synth || typeof SpeechSynthesisUtterance !== 'function') return null;
  return synth.getVoices().find((voice) => voice.localService === true) ?? null;
}

function hasUserGesture(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userActivation = (navigator as Navigator & {
    userActivation?: { isActive: boolean; hasBeenActive: boolean };
  }).userActivation;
  // A browser lacking UserActivation still invokes this method only from an
  // explicit UI handler. A browser that exposes it must confirm a real gesture.
  return userActivation === undefined || userActivation.isActive || userActivation.hasBeenActive;
}

function browserReady(): boolean {
  return hasWebRTC() && hasMediaCapture() && localSpeechVoice() !== null;
}

function candidateReady(): boolean {
  return candidate.candidateConfigured && candidate.protocolReady;
}

function canStart(): boolean {
  return (
    candidateReady() &&
    browserReady() &&
    (state === 'idle' || state === 'error') &&
    attachment === null &&
    startingEpoch === 0
  );
}

function canCapture(): boolean {
  const current = attachment;
  return (
    state === 'paused' &&
    current !== null &&
    current.committed &&
    current.routeAnnounced &&
    !current.draining &&
    current.capture === null &&
    !current.captureStarting &&
    activePrefix === null
  );
}

function canStop(): boolean {
  return attachment !== null && !attachment.draining;
}

function canEndCapture(): boolean {
  return attachment !== null && attachment.capture !== null && !attachment.draining && state === 'capturing';
}

function publicSnapshot(): ThreadedVoiceCapability {
  return Object.freeze({
    candidateConfigured: candidate.candidateConfigured,
    voiceEnabled: candidate.voiceEnabled,
    experimentalReady: candidateReady() && browserReady(),
    state,
    status,
    refusal: candidate.refusal,
    canStart: canStart(),
    canCapture: canCapture(),
    canEndCapture: canEndCapture(),
    canStop: canStop(),
    prefixPending: activePrefix !== null,
    level,
  });
}

function publish(): void {
  const snapshot = publicSnapshot();
  for (const listener of listeners) listener(snapshot);
}

function setState(next: ThreadedVoiceState, detail: string): void {
  state = next;
  status = detail;
  publish();
}

function currentAttachment(value: Attachment): boolean {
  return attachment === value && attachment.epoch === value.epoch;
}

function controlHeaders(controlToken = ''): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [PROTOCOL_HEADER]: String(VOICE_PROTOCOL_VERSION),
  };
  if (controlToken !== '') headers[CONTROL_HEADER] = controlToken;
  return headers;
}

/**
 * Every voice POST carries v3 in its JSON body. The current backend source
 * accepts the field permissively; the header/query make version intent
 * explicit until its strict v3 guard is aligned.
 */
async function postVoice(
  route: string,
  payload: Record<string, unknown>,
  controlToken = '',
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(apiPath(route), {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: controlHeaders(controlToken),
    body: JSON.stringify({ protocol_version: VOICE_PROTOCOL_VERSION, ...payload }),
    signal,
  });
  const body = recordValue(await response.json().catch(() => null)) ?? {};
  if (!response.ok || body.ok !== true) {
    throw new VoiceRequestError(
      bounded(body.code, 96) || `HTTP ${response.status}`,
      errorText(body, `The experimental voice server refused ${route}.`),
    );
  }
  return body;
}

function correlationPayload(target: ThreadVoiceTarget): Record<string, unknown> {
  return {
    thread_id: target.threadId,
    runtime_session_id: target.runtimeSessionId,
    runtime_generation: target.runtimeGeneration,
    runtime_incarnation: target.runtimeIncarnation,
  };
}

function attachmentPayload(current: Attachment): Record<string, unknown> {
  return {
    ...correlationPayload(current.target),
    lease_epoch: current.leaseEpoch,
    focus_epoch: current.focusEpoch,
    attachment_epoch: current.attachmentEpoch,
  };
}

function parseLease(value: unknown, target: ThreadVoiceTarget): VoiceLease | null {
  const lease = recordValue(value);
  const correlation = lease ? recordValue(lease.correlation) : null;
  if (!lease || !correlation) return null;
  const observed: ThreadVoiceTarget = {
    threadId: stringValue(correlation.thread_id),
    runtimeSessionId: stringValue(correlation.runtime_session_id),
    runtimeGeneration: positiveInteger(correlation.runtime_generation) ?? 0,
    runtimeIncarnation: stringValue(correlation.runtime_incarnation),
    label: target.label,
  };
  const leaseEpoch = positiveInteger(lease.lease_epoch);
  const focusEpoch = nonNegativeInteger(lease.focus_epoch);
  const captureEpoch = nonNegativeInteger(lease.capture_epoch);
  const attachmentEpoch = nonNegativeInteger(lease.attachment_epoch);
  const leaseState = bounded(lease.state, 32);
  if (
    !isTarget(observed) ||
    !sameTarget(observed, target) ||
    leaseEpoch === null ||
    focusEpoch === null ||
    captureEpoch === null ||
    attachmentEpoch === null ||
    leaseState === ''
  ) {
    return null;
  }
  return {
    target,
    leaseEpoch,
    focusEpoch,
    captureEpoch,
    attachmentEpoch,
    state: leaseState,
  };
}

function parseVoiceEvent(value: unknown): VoiceEvent | null {
  const raw = recordValue(value);
  if (!raw) return null;
  const cursor = positiveInteger(raw.cursor);
  const attachmentEpoch = positiveInteger(raw.attachment_epoch);
  const focusEpoch = nonNegativeInteger(raw.focus_epoch);
  const type = stringValue(raw.type);
  const nonce = stringValue(raw.nonce);
  const kind = stringValue(raw.kind);
  const captureId = stringValue(raw.capture_id);
  const message = stringValue(raw.message);
  if (
    cursor === null ||
    attachmentEpoch === null ||
    focusEpoch === null ||
    (type !== 'prefix_request' &&
      type !== 'prefix_timeout' &&
      type !== 'drain_request' &&
      type !== 'drain_complete') ||
    (kind !== '' && kind !== 'route' && kind !== 'answer') ||
    captureId.length > MAX_CAPTURE_ID_CHARS ||
    message.length > MAX_PREFIX_CHARS
  ) {
    return null;
  }
  if (
    (type === 'prefix_request' && (!UUID_RE.test(nonce) || (kind !== 'route' && kind !== 'answer') || message === '')) ||
    ((type === 'prefix_timeout' || type === 'drain_request' || type === 'drain_complete') &&
      !UUID_RE.test(nonce))
  ) {
    return null;
  }
  return {
    cursor,
    type,
    nonce,
    kind: kind as '' | 'route' | 'answer',
    attachmentEpoch,
    focusEpoch,
    captureId,
    message,
  };
}

function prefixKey(current: Attachment, nonce: string): string {
  return `${current.epoch}\u0000${nonce}`;
}

function rememberPrefix(record: PrefixRecord): void {
  readonlyPrefixRecords.set(prefixKey(record.attachment, record.nonce), record);
  while (readonlyPrefixRecords.size > MAX_REMEMBERED_PREFIXES) {
    const oldest = readonlyPrefixRecords.keys().next().value;
    if (typeof oldest === 'string') readonlyPrefixRecords.delete(oldest);
    else return;
  }
}

function knownPrefix(current: Attachment, nonce: string): PrefixRecord | null {
  return readonlyPrefixRecords.get(prefixKey(current, nonce)) ?? null;
}

function installVoiceListListener(): void {
  if (speechVoiceListenerInstalled || !speechApi()) return;
  speechVoiceListenerInstalled = true;
  speechApi()?.addEventListener('voiceschanged', () => {
    if (attachment === null && startingEpoch === 0 && candidateReady() && browserReady()) {
      setState('idle', 'Experimental threaded voice is ready to attach muted.');
      return;
    }
    publish();
  });
}

async function refresh(): Promise<void> {
  installVoiceListListener();
  try {
    const response = await fetch(
      apiPath(`/api/missioncontrol/voice/capabilities?protocol_version=${VOICE_PROTOCOL_VERSION}`),
      {
        credentials: 'include',
        cache: 'no-store',
        headers: { [PROTOCOL_HEADER]: String(VOICE_PROTOCOL_VERSION) },
      },
    );
    const body = recordValue(await response.json().catch(() => null)) ?? {};
    const capabilities = recordValue(body.capabilities);
    const candidateConfigured =
      response.ok && body.ok === true && capabilities?.voice_preview_configured === true;
    const protocolReady =
      candidateConfigured &&
      capabilities?.thread_voice_default_off === true &&
      capabilities?.lease_protocol_available === true &&
      capabilities?.focus_fencing === true &&
      capabilities?.capture_fencing === true &&
      capabilities?.capture_protocol_available === true &&
      capabilities?.prefix_protocol_available === true &&
      capabilities?.drain_protocol_available === true &&
      capabilities?.provider_attachment === true &&
      capabilities?.provider_input_event_mapping === true &&
      capabilities?.provider_sink_stop_drain_ack === true;
    candidate = Object.freeze({
      candidateConfigured,
      voiceEnabled: capabilities?.voice_enabled === true,
      protocolReady,
      refusal: candidateConfigured
        ? protocolReady
          ? stringValue(body.refusal) || 'Experimental threaded voice is available only by explicit start.'
          : 'Threaded voice candidate is missing required capture, prefix, or drain safeguards.'
        : stringValue(body.refusal) || 'Threaded voice not available yet',
    });
    if (attachment === null && startingEpoch === 0) {
      if (!candidateReady()) {
        setState('unavailable', candidate.refusal);
        return;
      }
      if (!browserReady()) {
        setState(
          'unavailable',
          'Experimental threaded voice needs WebRTC, microphone capture, and a local browser speech voice.',
        );
        return;
      }
      setState('idle', 'Experimental threaded voice is ready to attach muted.');
      return;
    }
    publish();
  } catch {
    candidate = unavailableCandidate;
    if (attachment === null && startingEpoch === 0) {
      setState('unavailable', unavailableCandidate.refusal);
      return;
    }
    publish();
  }
}

async function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const finish = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 2_000);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

async function start(target: ThreadVoiceTarget | null): Promise<void> {
  if (!isTarget(target)) {
    setState('error', 'Select a live text context before starting experimental threaded voice.');
    return;
  }
  if (!candidateReady()) {
    setState('unavailable', candidate.refusal);
    return;
  }
  if (!browserReady()) {
    setState(
      'unavailable',
      'Experimental threaded voice needs WebRTC, microphone capture, and a local browser speech voice.',
    );
    return;
  }
  if (!hasUserGesture()) {
    setState('error', 'Experimental threaded voice must start from a browser user gesture.');
    return;
  }
  if (attachment !== null || startingEpoch !== 0 || state === 'draining') return;

  const started = ++nextEpoch;
  const stableTarget = frozenTarget(target);
  const oldControlToken = drainedControlToken;
  startingEpoch = started;
  startAbort = new AbortController();
  setState('attaching', 'Experimental threaded voice is attaching muted…');

  let current: Attachment | null = null;
  try {
    const leaseResponse = await postVoice(
      '/api/missioncontrol/voice/lease',
      { ...correlationPayload(stableTarget), takeover: oldControlToken !== '' },
      oldControlToken,
      startAbort.signal,
    );
    if (startingEpoch !== started) return;
    const lease = parseLease(leaseResponse.lease, stableTarget);
    const controlToken = bounded(leaseResponse.control_token, 4096);
    if (!lease || lease.state !== 'active' || controlToken === '') {
      throw new VoiceRequestError(
        'invalid_lease',
        'The experimental voice server did not issue an exact scoped attachment lease.',
      );
    }

    const tokenResponse = await postVoice(
      '/api/missioncontrol/voice/attachment/token',
      {
        ...correlationPayload(stableTarget),
        lease_epoch: lease.leaseEpoch,
        focus_epoch: lease.focusEpoch,
      },
      controlToken,
      startAbort.signal,
    );
    if (startingEpoch !== started) return;
    const sessionId = bounded(tokenResponse.session_id, 256);
    const attachmentEpoch = positiveInteger(tokenResponse.attachment_epoch);
    if (
      sessionId === '' ||
      attachmentEpoch === null ||
      tokenResponse.microphone_admission !== false
    ) {
      throw new VoiceRequestError(
        'invalid_attachment_candidate',
        'The experimental voice server did not return a muted scoped attachment candidate.',
      );
    }
    current = {
      epoch: started,
      target: stableTarget,
      controlToken,
      leaseEpoch: lease.leaseEpoch,
      focusEpoch: lease.focusEpoch,
      attachmentEpoch,
      sessionId,
      peer: null,
      sender: null,
      remoteStream: null,
      sink: null,
      audioContext: null,
      analyser: null,
      levelRaf: null,
      eventCursor: 0,
      pollAbort: null,
      heartbeatTimer: null,
      heartbeatInFlight: false,
      committed: false,
      routeAnnounced: false,
      capture: null,
      draining: false,
      drainNonce: '',
      drainAcknowledged: false,
      drainAcknowledging: null,
      routeAfterDrain: null,
      muting: null,
      captureOperation: 0,
      captureStarting: false,
    };
    attachment = current;
    startingEpoch = 0;
    drainedControlToken = '';

    const attached = current;
    const peer = new RTCPeerConnection();
    attached.peer = peer;
    attached.sender = peer.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    peer.ontrack = (event) => {
      if (!currentAttachment(attached)) return;
      attached.remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      if (attached.routeAnnounced && activePrefix?.attachment !== attached && !attached.draining) {
        void attachSink(attached, attached.remoteStream).catch(() => {
          if (currentAttachment(attached)) {
            void localFailure(attached, 'The browser could not attach scoped provider audio. Voice remains muted.');
          }
        });
      }
    };
    peer.onconnectionstatechange = () => {
      if (!currentAttachment(attached)) return;
      if (!attached.draining && (peer.connectionState === 'failed' || peer.connectionState === 'closed')) {
        void localFailure(attached, 'The scoped experimental voice peer disconnected. Microphone capture was stopped.');
      }
    };

    const offer = await peer.createOffer();
    if (!currentAttachment(attached)) return;
    await peer.setLocalDescription(offer);
    await waitForIce(peer);
    if (!currentAttachment(attached)) return;
    const sdp = peer.localDescription?.sdp ?? offer.sdp ?? '';
    if (sdp.trim() === '' || sdp.length > MAX_SDP_CHARS) {
      throw new VoiceRequestError('invalid_sdp', 'The browser could not create a bounded scoped voice offer.');
    }
    const sdpResponse = await postVoice(
      '/api/missioncontrol/voice/attachment/sdp',
      {
        ...attachmentPayload(attached),
        session_id: attached.sessionId,
        sdp,
      },
      attached.controlToken,
      startAbort.signal,
    );
    if (!currentAttachment(attached)) return;
    const answer = bounded(sdpResponse.sdp, MAX_SDP_CHARS);
    const confirmedEpoch = positiveInteger(sdpResponse.attachment_epoch);
    if (
      answer === '' ||
      confirmedEpoch === null ||
      confirmedEpoch !== attached.attachmentEpoch ||
      sdpResponse.microphone_admission !== false
    ) {
      throw new VoiceRequestError(
        'invalid_attachment',
        'The experimental voice server did not confirm this muted attachment.',
      );
    }
    await peer.setRemoteDescription({ type: 'answer', sdp: answer });
    if (!currentAttachment(attached)) return;
    attached.committed = true;
    startAbort = null;
    setState('awaiting-route-prefix', 'Experimental voice is muted while the context announcement is spoken.');
    startHeartbeat(attached);
    startEventPoll(attached);
  } catch (error) {
    if (startingEpoch !== started && current === null) return;
    if (startingEpoch === started) startingEpoch = 0;
    startAbort = null;
    if (current && currentAttachment(current)) {
      await localFailure(current, requestFailureMessage(error, 'Experimental threaded voice attachment failed.'));
    } else if (startingEpoch === 0) {
      setState('error', requestFailureMessage(error, 'Experimental threaded voice attachment failed.'));
    }
  }
}

function requestFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof VoiceRequestError) return error.message;
  if (error instanceof Error && error.message) return error.message.slice(0, 360);
  return fallback;
}

async function beginCapture(): Promise<void> {
  const current = attachment;
  if (!current || !canCapture() || !currentAttachment(current)) return;
  const operation = ++current.captureOperation;
  current.captureStarting = true;
  setState('paused', 'Experimental voice is reserving capture for this exact context…');
  let reservationMayExist = false;
  try {
    const response = await postVoice(
      '/api/missioncontrol/voice/capture/begin',
      attachmentPayload(current),
      current.controlToken,
    );
    if (!currentAttachment(current) || current.draining || operation !== current.captureOperation) {
      if (currentAttachment(current) && !current.draining) {
        current.captureStarting = false;
        await beginDrain(
          current,
          null,
          'A capture reservation changed before browser media could attach. Voice is draining and remains muted.',
        );
      }
      return;
    }
    const captureId = bounded(response.capture_id, MAX_CAPTURE_ID_CHARS);
    const captureEpoch = positiveInteger(response.capture_epoch);
    const attachmentEpoch = positiveInteger(response.attachment_epoch);
    if (
      captureId === '' ||
      captureEpoch === null ||
      attachmentEpoch !== current.attachmentEpoch ||
      response.media_enabled !== false ||
      response.media_admission !== true
    ) {
      reservationMayExist = true;
      throw new VoiceRequestError(
        'invalid_capture_admission',
        'The experimental voice server did not reserve this exact muted capture.',
      );
    }
    reservationMayExist = true;
    const capture: Capture = { id: captureId, epoch: captureEpoch, stream: null, ending: null };
    current.capture = capture;
    // This is deliberately after server media_admission:true. A capability
    // response or a prior route event alone can never acquire a microphone.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!currentAttachment(current) || current.capture !== capture || current.draining || operation !== current.captureOperation) {
      stream.getTracks().forEach((track) => track.stop());
      if (currentAttachment(current) && !current.draining) {
        current.captureStarting = false;
        await beginDrain(
          current,
          null,
          'A reserved capture changed before browser media could attach. Voice is draining and remains muted.',
        );
      }
      return;
    }
    const track = stream.getAudioTracks()[0];
    if (!track || !current.sender) {
      stream.getTracks().forEach((item) => item.stop());
      throw new VoiceRequestError('media_track_missing', 'The browser did not provide an audio track for this reserved capture.');
    }
    await current.sender.replaceTrack(track);
    if (!currentAttachment(current) || current.capture !== capture || current.draining || operation !== current.captureOperation) {
      await current.sender.replaceTrack(null);
      stream.getTracks().forEach((item) => item.stop());
      if (currentAttachment(current) && !current.draining) {
        current.captureStarting = false;
        await beginDrain(
          current,
          null,
          'A reserved capture changed before browser media could attach. Voice is draining and remains muted.',
        );
      }
      return;
    }
    capture.stream = stream;
    current.captureStarting = false;
    setState('capturing', 'Experimental voice is listening only to the announced context. Stop speaking when finished.');
  } catch (error) {
    if (currentAttachment(current)) {
      current.captureStarting = false;
      if (current.capture !== null || reservationMayExist) {
        await failReservedCapture(current, requestFailureMessage(error, 'Microphone setup failed for the reserved capture.'));
      } else {
        setState(
          'paused',
          requestFailureMessage(
            error,
            'The server did not reserve microphone capture. Voice remains paused for this context.',
          ),
        );
      }
    }
  }
}

/**
 * `replaceTrack(null)` detaches the negotiated sender's input source without
 * creating an unnegotiated m-line. Removing that sender would require a new
 * SDP exchange, which this exact attachment protocol intentionally does not
 * permit; no browser audio can remain on it after this resolves.
 */
async function stopCaptureMedia(current: Attachment): Promise<void> {
  const capture = current.capture;
  if (!capture) return;
  capture.stream?.getTracks().forEach((track) => {
    track.enabled = false;
    track.stop();
  });
  capture.stream = null;
  if (current.sender) await current.sender.replaceTrack(null);
}

async function endCapture(): Promise<void> {
  const current = attachment;
  const capture = current?.capture;
  if (!current || !capture || !currentAttachment(current) || current.draining) return;
  if (capture.ending) return;
  current.captureOperation++;
  setState('awaiting-answer-prefix', 'Experimental voice stopped microphone capture and is awaiting the scoped reply boundary.');
  capture.ending = (async () => {
    try {
      await stopCaptureMedia(current);
      if (!currentAttachment(current) || current.capture !== capture || current.draining) return;
      await postVoice(
        '/api/missioncontrol/voice/capture/end',
        {
          ...attachmentPayload(current),
          capture_id: capture.id,
          capture_epoch: capture.epoch,
        },
        current.controlToken,
      );
    } catch (error) {
      if (currentAttachment(current)) {
        await localFailure(current, requestFailureMessage(error, 'The reserved microphone capture could not be ended safely.'));
      }
    } finally {
      if (current.capture === capture) capture.ending = null;
    }
  })();
  await capture.ending;
}

async function failReservedCapture(current: Attachment, reason: string): Promise<void> {
  try {
    await stopCaptureMedia(current);
  } catch {
    // Track stop already happened; the server drain below is still required.
  }
  await beginDrain(current, null, `${reason} The reserved capture was fenced and microphone audio remains off.`);
}

function startEventPoll(current: Attachment): void {
  if (!currentAttachment(current) || current.pollAbort) return;
  current.pollAbort = new AbortController();
  void pollEvents(current, current.pollAbort.signal);
}

async function pollEvents(current: Attachment, signal: AbortSignal): Promise<void> {
  while (currentAttachment(current) && !signal.aborted) {
    try {
      const response = await postVoice(
        '/api/missioncontrol/voice/events',
        { ...attachmentPayload(current), cursor: current.eventCursor },
        current.controlToken,
        signal,
      );
      if (!currentAttachment(current) || signal.aborted) return;
      const rawEvents = response.events;
      const responseCursor = nonNegativeInteger(response.cursor);
      if (!Array.isArray(rawEvents) || responseCursor === null || responseCursor < current.eventCursor) {
        throw new VoiceRequestError('invalid_event_stream', 'The scoped voice event stream returned an invalid cursor.');
      }
      let previousCursor = current.eventCursor;
      for (const rawEvent of rawEvents) {
        const event = parseVoiceEvent(rawEvent);
        if (
          !event ||
          event.cursor <= previousCursor ||
          event.cursor > responseCursor ||
          event.attachmentEpoch !== current.attachmentEpoch ||
          event.focusEpoch !== current.focusEpoch
        ) {
          throw new VoiceRequestError('invalid_event_stream', 'The scoped voice event stream returned an invalid attachment event.');
        }
        previousCursor = event.cursor;
        current.eventCursor = event.cursor;
        await handleVoiceEvent(current, event);
        if (!currentAttachment(current) || signal.aborted) return;
      }
      current.eventCursor = responseCursor;
    } catch (error) {
      if (signal.aborted || !currentAttachment(current)) return;
      await localFailure(
        current,
        requestFailureMessage(
          error,
          'The scoped voice event channel was lost. Microphone capture was stopped; no automatic reattach was attempted.',
        ),
      );
      return;
    }
  }
}

async function heartbeat(current: Attachment): Promise<void> {
  const response = await postVoice(
    '/api/missioncontrol/voice/heartbeat',
    { ...attachmentPayload(current), capture_epoch: current.capture?.epoch ?? 0 },
    current.controlToken,
  );
  if (!currentAttachment(current)) return;
  const lease = parseLease(response.lease, current.target);
  if (
    !lease ||
    lease.leaseEpoch !== current.leaseEpoch ||
    lease.focusEpoch !== current.focusEpoch ||
    lease.attachmentEpoch !== current.attachmentEpoch
  ) {
    throw new VoiceRequestError('invalid_heartbeat', 'The scoped voice lease changed unexpectedly and was muted.');
  }
}

function clearHeartbeat(current: Attachment): void {
  if (current.heartbeatTimer !== null) clearInterval(current.heartbeatTimer);
  current.heartbeatTimer = null;
  current.heartbeatInFlight = false;
}

function startHeartbeat(current: Attachment): void {
  if (!currentAttachment(current) || current.heartbeatTimer !== null) return;
  const tick = async (): Promise<void> => {
    if (
      !currentAttachment(current) ||
      current.draining ||
      current.heartbeatInFlight
    ) {
      return;
    }
    current.heartbeatInFlight = true;
    try {
      await heartbeat(current);
    } catch (error) {
      if (currentAttachment(current) && !current.draining) {
        await localFailure(
          current,
          requestFailureMessage(
            error,
            'The scoped voice lease heartbeat was lost. Microphone capture was stopped; no automatic reattach was attempted.',
          ),
        );
      }
    } finally {
      current.heartbeatInFlight = false;
    }
  };
  current.heartbeatTimer = setInterval(() => {
    void tick();
  }, HEARTBEAT_INTERVAL_MS);
  void tick();
}

async function handleVoiceEvent(current: Attachment, event: VoiceEvent): Promise<void> {
  if (!currentAttachment(current) || current.draining && event.type !== 'drain_request' && event.type !== 'drain_complete') {
    return;
  }
  switch (event.type) {
    case 'prefix_request':
      await handlePrefixRequest(current, event);
      return;
    case 'prefix_timeout':
      if (activePrefix?.attachment === current && activePrefix.nonce === event.nonce) {
        activePrefix.cancelled = true;
        await localFailure(current, 'The scoped spoken prefix timed out. Voice remains muted and no provider response was requested.');
      }
      return;
    case 'drain_request':
      await handleDrainRequest(current, event);
      return;
    case 'drain_complete':
      await handleDrainComplete(current, event);
      return;
    case 'attachment_failed':
      await localFailure(current, event.message || 'The scoped provider attachment failed. Voice has been muted.');
      return;
  }
}

function validPrefixForAttachment(current: Attachment, event: VoiceEvent): boolean {
  if (event.kind === 'route') {
    return current.capture === null && event.captureId === '' && !current.routeAnnounced;
  }
  const capture = current.capture;
  return (
    event.kind === 'answer' &&
    capture !== null &&
    capture.id === event.captureId &&
    state === 'awaiting-answer-prefix'
  );
}

async function handlePrefixRequest(current: Attachment, event: VoiceEvent): Promise<void> {
  const known = knownPrefix(current, event.nonce);
  if (known) {
    if (known.completed && !known.acknowledged && !known.cancelled) await acknowledgePrefix(known);
    return;
  }
  if (
    !current.committed ||
    current.draining ||
    !validPrefixForAttachment(current, event) ||
    !hasUserGesture() ||
    localSpeechVoice() === null
  ) {
    await localFailure(
      current,
      'The scoped prefix could not be spoken by a local browser voice. Voice remains muted and no prefix acknowledgement was sent.',
    );
    return;
  }
  const record: PrefixRecord = {
    attachment: current,
    nonce: event.nonce,
    kind: event.kind as 'route' | 'answer',
    cursor: event.cursor,
    captureId: event.captureId,
    utterance: null,
    completed: false,
    acknowledged: false,
    cancelled: false,
  };
  rememberPrefix(record);
  activePrefix = record;
  setState(
    event.kind === 'route' ? 'awaiting-route-prefix' : 'awaiting-answer-prefix',
    event.kind === 'route'
      ? 'Experimental voice is announcing the selected context locally…'
      : 'Experimental voice is preparing the scoped answer locally…',
  );
  try {
    // An answer prefix is sent only after the server says its prior provider
    // response/audio is quiescent. We still detach our real sink before speech.
    await detachSink(current);
    await speakLocalPrefix(record, event.message);
    if (!currentAttachment(current) || activePrefix !== record || record.cancelled || current.draining) return;
    record.completed = true;
    // Restore before ACK: the server may begin provider output immediately
    // after it accepts the nonce, so a post-ACK restore could discard it.
    await restoreSink(current);
    if (!currentAttachment(current) || activePrefix !== record || record.cancelled || current.draining) return;
    await acknowledgePrefix(record);
  } catch (error) {
    if (currentAttachment(current) && activePrefix === record && !record.cancelled) {
      await localFailure(current, requestFailureMessage(error, 'The scoped local prefix could not be completed. Voice remains muted.'));
    }
  }
}

async function speakLocalPrefix(record: PrefixRecord, text: string): Promise<void> {
  const synth = speechApi();
  const voice = localSpeechVoice();
  if (!synth || !voice || !hasUserGesture()) {
    throw new VoiceRequestError('local_speech_unavailable', 'A local browser speech voice and user gesture are required for this prefix.');
  }
  if (synth.speaking || synth.pending) {
    throw new VoiceRequestError('local_speech_busy', 'Local browser speech output is busy, so the scoped prefix was not acknowledged.');
  }
  await new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    record.utterance = utterance;
    utterance.voice = voice;
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.onend = () => {
      if (record.cancelled || activePrefix !== record || !currentAttachment(record.attachment)) {
        reject(new VoiceRequestError('prefix_cancelled', 'The scoped prefix was cancelled before it completed.'));
        return;
      }
      resolve();
    };
    utterance.onerror = () => {
      reject(new VoiceRequestError('prefix_speech_failed', 'The local browser voice could not complete the scoped prefix.'));
    };
    try {
      synth.speak(utterance);
    } catch {
      reject(new VoiceRequestError('prefix_speech_failed', 'The local browser voice could not start the scoped prefix.'));
    }
  });
}

async function acknowledgePrefix(record: PrefixRecord): Promise<void> {
  const current = record.attachment;
  if (
    !record.completed ||
    record.cancelled ||
    record.acknowledged ||
    activePrefix !== record ||
    !currentAttachment(current) ||
    current.draining
  ) {
    return;
  }
  const response = await postVoice(
    '/api/missioncontrol/voice/prefix/ack',
    { ...attachmentPayload(current), prefix_nonce: record.nonce },
    current.controlToken,
  );
  if (!currentAttachment(current) || activePrefix !== record || record.cancelled) return;
  if (record.kind === 'route') {
    if (response.media_admission !== true) {
      throw new VoiceRequestError('route_admission_missing', 'The server did not admit media after the spoken route prefix.');
    }
    current.routeAnnounced = true;
  }
  record.acknowledged = true;
  activePrefix = null;
  if (record.kind === 'answer' && current.capture?.id === record.captureId) {
    current.capture = null;
  }
  setState(
    'paused',
    record.kind === 'route'
      ? 'Experimental threaded voice is paused. Press the microphone to speak in this context.'
      : 'Experimental threaded voice is paused while the scoped provider reply continues.',
  );
}

function cancelOwnedPrefix(current: Attachment): void {
  const record = activePrefix;
  if (!record || record.attachment !== current) return;
  record.cancelled = true;
  activePrefix = null;
  // SpeechSynthesis exposes only global cancel(). It is called only while this
  // controller owns the active utterance; this controller never cancels an
  // arbitrary page utterance when it has no owned prefix.
  try {
    speechApi()?.cancel();
  } catch {
    /* browser already ended it */
  }
}

async function attachSink(
  current: Attachment,
  stream: MediaStream,
  restoreDuringPrefix = false,
): Promise<void> {
  if (
    !currentAttachment(current) ||
    current.draining ||
    (!current.routeAnnounced && !restoreDuringPrefix) ||
    (activePrefix?.attachment === current && !restoreDuringPrefix)
  ) {
    return;
  }
  await detachSink(current);
  if (
    !currentAttachment(current) ||
    current.draining ||
    (activePrefix?.attachment === current && !restoreDuringPrefix)
  ) {
    return;
  }
  const sink = new Audio();
  sink.srcObject = stream;
  sink.autoplay = true;
  sink.setAttribute('playsinline', '');
  try {
    await sink.play();
  } catch {
    sink.pause();
    sink.srcObject = null;
    throw new VoiceRequestError('output_sink_failed', 'The browser could not attach the scoped provider audio output.');
  }
  if (!currentAttachment(current) || current.draining || activePrefix?.attachment === current) {
    sink.pause();
    sink.srcObject = null;
    return;
  }
  current.sink = sink;
  try {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    current.audioContext = context;
    current.analyser = analyser;
    await context.resume();
    startLevelLoop(current);
  } catch {
    // Playback remains real through the media element; only the decorative
    // level value is unavailable.
    current.analyser = null;
  }
}

async function detachSink(current: Attachment): Promise<void> {
  if (current.levelRaf !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(current.levelRaf);
  }
  current.levelRaf = null;
  current.analyser = null;
  level = 0;
  if (current.sink) {
    current.sink.pause();
    current.sink.srcObject = null;
    current.sink = null;
  }
  const context = current.audioContext;
  current.audioContext = null;
  if (context && context.state !== 'closed') {
    try {
      await context.close();
    } catch {
      /* a closed/replaced graph is already detached */
    }
  }
  publish();
}

function startLevelLoop(current: Attachment): void {
  if (!currentAttachment(current) || !current.analyser || current.levelRaf !== null) return;
  const samples = new Uint8Array(current.analyser.frequencyBinCount);
  const tick = () => {
    if (!currentAttachment(current) || !current.analyser || current.draining) {
      current.levelRaf = null;
      return;
    }
    current.analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const amplitude = (sample - 128) / 128;
      sum += amplitude * amplitude;
    }
    const next = Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 3.2);
    if (Math.abs(next - level) > 0.01) {
      level = next;
      publish();
    }
    current.levelRaf = requestAnimationFrame(tick);
  };
  current.levelRaf = requestAnimationFrame(tick);
}

async function restoreSink(current: Attachment): Promise<void> {
  if (!current.remoteStream) return;
  await attachSink(current, current.remoteStream, true);
}

async function muteLocally(current: Attachment): Promise<void> {
  current.captureOperation++;
  current.captureStarting = false;
  cancelOwnedPrefix(current);
  try {
    await stopCaptureMedia(current);
  } catch {
    // Browser tracks were stopped before replaceTrack; server drain will fence.
  }
  await detachSink(current);
}

/** Browser teardown only; server-side drain remains authoritative. */
function closePeerLocally(current: Attachment): void {
  try {
    current.peer?.close();
  } catch {
    /* already closed */
  }
  current.peer = null;
  current.sender = null;
  current.remoteStream = null;
}

async function beginDrain(
  current: Attachment,
  routeAfterDrain: ThreadVoiceTarget | null,
  detail: string,
): Promise<void> {
  if (!currentAttachment(current)) return;
  if (current.draining) {
    if (routeAfterDrain) current.routeAfterDrain = routeAfterDrain;
    return;
  }
  current.draining = true;
  current.routeAfterDrain = routeAfterDrain;
  clearHeartbeat(current);
  setState('draining', detail);
  await muteLocally(current);
  if (!currentAttachment(current)) return;
  try {
    await postVoice(
      '/api/missioncontrol/voice/stop',
      attachmentPayload(current),
      current.controlToken,
    );
    if (!currentAttachment(current)) return;
    startEventPoll(current);
  } catch (error) {
    if (currentAttachment(current)) {
      // The browser peer is no longer useful after a failed stop request, but
      // this is not a server drain acknowledgement. Keep the attachment and
      // its control token so the visible Stop action can retry this exact
      // request; do not mint a replacement or record a drained token.
      closePeerLocally(current);
      current.draining = false;
      setState(
        'error',
        `${requestFailureMessage(
          error,
          'The experimental voice attachment could not enter a safe drain.',
        )} It remains muted; use Stop to retry the server drain. No replacement was attempted.`,
      );
    }
  }
}

/**
 * Acknowledge exactly the outstanding server-issued drain nonce only after the
 * current local release routine has stopped every capture track it observed.
 * This is browser-local evidence, not a claim that the server/provider drain
 * completed; only drain_complete may finish the attachment.
 */
async function acknowledgePendingDrain(current: Attachment): Promise<void> {
  if (
    !currentAttachment(current) ||
    !current.draining ||
    current.drainNonce === '' ||
    current.drainAcknowledged
  ) {
    return;
  }
  if (current.drainAcknowledging) {
    await current.drainAcknowledging;
    return;
  }
  const nonce = current.drainNonce;
  const tracks = current.capture?.stream?.getTracks() ?? [];
  const acknowledgement = (async () => {
    await muteLocally(current);
    if (
      !currentAttachment(current) ||
      !current.draining ||
      current.drainNonce !== nonce ||
      current.drainAcknowledged
    ) {
      return;
    }
    if (
      (current.capture !== null && current.capture.stream !== null) ||
      tracks.some((track) => track.readyState !== 'ended') ||
      current.sink !== null ||
      current.audioContext !== null
    ) {
      setState(
        'error',
        'Browser media release could not be verified. Voice remains muted; use Stop to retry this exact drain acknowledgement.',
      );
      return;
    }
    try {
      await postVoice(
        '/api/missioncontrol/voice/drain/ack',
        { ...attachmentPayload(current), drain_nonce: nonce },
        current.controlToken,
      );
      if (!currentAttachment(current) || current.drainNonce !== nonce) return;
      current.drainAcknowledged = true;
      setState('draining', 'Browser audio is detached; waiting for the server’s provider drain completion.');
    } catch (error) {
      if (currentAttachment(current) && current.draining && current.drainNonce === nonce) {
        setState(
          'error',
          `${requestFailureMessage(
            error,
            'The browser drain acknowledgement was refused.',
          )} Voice remains muted; use Stop to retry this exact acknowledgement. No replacement was attempted.`,
        );
      }
    }
  })();
  current.drainAcknowledging = acknowledgement;
  try {
    await acknowledgement;
  } finally {
    if (current.drainAcknowledging === acknowledgement) current.drainAcknowledging = null;
  }
}

async function handleDrainRequest(current: Attachment, event: VoiceEvent): Promise<void> {
  if (!current.draining) {
    await localFailure(current, 'The server requested a voice drain outside an owned local stop. Voice remains muted.');
    return;
  }
  if (current.drainNonce !== '' && current.drainNonce !== event.nonce) {
    await localFailure(current, 'The server sent a conflicting voice drain nonce. Voice remains muted.');
    return;
  }
  if (current.drainAcknowledged && current.drainNonce === event.nonce) return;
  current.drainNonce = event.nonce;
  setState('draining', 'Experimental voice is waiting for provider and browser drain confirmation…');
  await acknowledgePendingDrain(current);
}

async function handleDrainComplete(current: Attachment, event: VoiceEvent): Promise<void> {
  if (
    !current.draining ||
    !current.drainAcknowledged ||
    current.drainNonce === '' ||
    current.drainNonce !== event.nonce
  ) {
    await localFailure(current, 'The server reported an uncorrelated voice drain completion. Voice remains muted.');
    return;
  }
  const route = current.routeAfterDrain;
  current.pollAbort?.abort();
  current.pollAbort = null;
  clearHeartbeat(current);
  await muteLocally(current);
  closePeerLocally(current);
  if (!currentAttachment(current)) return;
  attachment = null;
  drainedControlToken = current.controlToken;
  activePrefix = null;
  level = 0;
  setState('idle', route ? 'Experimental voice drained; attaching the explicitly selected context muted…' : 'Experimental voice is stopped.');
  if (route) await start(route);
}

async function localFailure(current: Attachment, detail: string): Promise<void> {
  if (!currentAttachment(current)) return;
  current.pollAbort?.abort();
  current.pollAbort = null;
  clearHeartbeat(current);
  await muteLocally(current);
  closePeerLocally(current);
  if (!currentAttachment(current)) return;
  // This releases browser-local ownership only. Without a server drain ACK we
  // deliberately retain no drainedControlToken and never auto-attach again.
  attachment = null;
  activePrefix = null;
  level = 0;
  setState('error', detail);
}

/** Explicit bridge stop. It never cancels text-thread work. */
async function stop(): Promise<void> {
  pendingSelectionRoute = false;
  const current = attachment;
  if (!current) return;
  if (!current.committed) {
    await muteLocally(current);
    setState(
      'error',
      'The scoped attachment candidate was not committed. It remains muted; wait for the server candidate to expire before trying again.',
    );
    return;
  }
  if (current.draining) {
    // A /stop that succeeded is awaiting its server drain event. Once that
    // event carries a nonce, Stop retries only that exact acknowledgement;
    // it never mixes a fresh /stop with a pending server drain.
    await acknowledgePendingDrain(current);
    return;
  }
  await beginDrain(
    current,
    null,
    'Experimental voice is stopping. Text-thread work remains running while provider and browser audio drain.',
  );
}

/**
 * Called immediately after an explicit Context/Talk-here request is accepted
 * for transport. It mutes A before B’s text header can commit; it does not
 * inspect terminal focus or route from catalog refreshes.
 */
function prepareRouteForExplicitSelection(): void {
  const current = attachment;
  if (!current) {
    if (startingEpoch !== 0) {
      pendingSelectionRoute = true;
      startAbort?.abort();
      startAbort = null;
      startingEpoch = 0;
      setState(
        'route-pending',
        'Experimental voice attachment was cancelled while the explicit context selection is confirmed.',
      );
    }
    return;
  }
  if (current.draining) {
    pendingSelectionRoute = current !== null;
    return;
  }
  pendingSelectionRoute = true;
  setState('route-pending', 'Experimental voice is paused while the explicit context selection is confirmed.');
  // Fence a getUserMedia/replaceTrack continuation that was already in flight
  // before the user chose a different text context.
  current.captureOperation++;
  cancelOwnedPrefix(current);
  current.muting ??= (async () => {
    await stopCaptureMedia(current).catch(() => {});
    await detachSink(current);
    const capture = current.capture;
    if (!capture || !currentAttachment(current) || current.draining) return;
    try {
      await postVoice(
        '/api/missioncontrol/voice/capture/end',
        {
          ...attachmentPayload(current),
          capture_id: capture.id,
          capture_epoch: capture.epoch,
        },
        current.controlToken,
      );
    } catch {
      // The subsequent exact old-correlation drain fences an unresolved
      // reservation. Never re-enable A’s microphone after this point.
    }
  })().finally(() => {
    if (currentAttachment(current)) current.muting = null;
  });
}

/**
 * Receives only the narrow explicit-selection seam from thread-store. An
 * automatic reconnect/catalog selection cannot reach this method.
 */
async function onExplicitSelectionSettled(selection: ExplicitThreadSelection): Promise<void> {
  const current = attachment;
  if (!pendingSelectionRoute) return;
  pendingSelectionRoute = false;
  if (!current) {
    if (!selection.selected) {
      setState('idle', 'The explicit context selection was not confirmed. Experimental voice remains stopped.');
      return;
    }
    await start(selection.selected);
    return;
  }
  if (!selection.selected) {
    if (current.draining) {
      setState('draining', 'Voice drain remains in progress; the unconfirmed context was not attached.');
      return;
    }
    setState(
      'paused',
      'The explicit context selection was not confirmed. Voice remains muted; explicitly retry or stop this attachment.',
    );
    return;
  }
  const target = frozenTarget(selection.selected);
  if (!currentAttachment(current)) return;
  if (current.draining) {
    current.routeAfterDrain = target;
    return;
  }
  await current.muting;
  if (!currentAttachment(current)) return;
  if (sameTarget(current.target, target)) {
    setState('paused', 'Experimental threaded voice remains paused for this context.');
    return;
  }
  await beginDrain(
    current,
    target,
    'Experimental voice is draining the prior context before attaching the explicitly selected context.',
  );
}

/** WebSocket/text transport loss immediately mutes, but never claims/restarts. */
async function markTextDisconnected(): Promise<void> {
  const current = attachment;
  pendingSelectionRoute = false;
  if (!current) {
    if (startingEpoch !== 0) {
      startAbort?.abort();
      startAbort = null;
      startingEpoch = 0;
      setState(
        'error',
        'Text connection lost. Experimental voice attachment was cancelled before microphone capture.',
      );
    }
    return;
  }
  current.pollAbort?.abort();
  current.pollAbort = null;
  clearHeartbeat(current);
  await muteLocally(current);
  closePeerLocally(current);
  if (!currentAttachment(current)) return;
  // Text loss is not confirmation that the server drained its lease. Drop the
  // local peer without a takeover token and require an explicit later action.
  attachment = null;
  activePrefix = null;
  level = 0;
  setState(
    'error',
    'Text connection lost. Experimental voice is muted; no lease, capture, or context was automatically resumed.',
  );
}

/** Informational only: a reconnect never reclaims a lease or opens a microphone. */
function markTextReconnected(): void {
  if (attachment && state === 'error') {
    setState(
      'error',
      'Text reconnected, but experimental voice remains muted. Stop or explicitly attach again after a clean drain.',
    );
  }
}

export const threadedVoiceController = {
  snapshot: publicSnapshot,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  refresh,
  start,
  stop,
  beginCapture,
  endCapture,
  prepareRouteForExplicitSelection,
  onExplicitSelectionSettled,
  markTextDisconnected,
  markTextReconnected,
};