import { apiPath } from './base-path.js';

export type SDKVoiceState = 'idle' | 'connecting' | 'listening' | 'speaking';
type VoiceMeter = { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; bins: Uint8Array<ArrayBuffer> };

/** One browser Realtime audio connection, bound to one SDK chat. */
export class SDKVoiceSession {
  private chatId: string;
  private onState: (state: SDKVoiceState) => void;
  private onLevels: (levels: readonly number[]) => void;
  private peer: RTCPeerConnection | null = null;
  private mic: MediaStream | null = null;
  private sink: HTMLAudioElement | null = null;
  private providerId = '';
  private generation = 0;
  private quietTimer: number | undefined;
  private readyAudio: AudioContext | null = null;
  private readySoundPlayed = false;
  private inputMeter: VoiceMeter | null = null;
  private outputMeter: VoiceMeter | null = null;
  private meterFrame = 0;
  private lastMeterUpdate = 0;
  state: SDKVoiceState = 'idle';

  get providerSessionId(): string { return this.providerId; }

  constructor(chatId: string, onState: (state: SDKVoiceState) => void, onLevels: (levels: readonly number[]) => void) {
    this.chatId = chatId;
    this.onState = onState;
    this.onLevels = onLevels;
  }

  private setState(state: SDKVoiceState) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      throw new Error('Voice requires a secure browser with microphone support.');
    }
    const generation = ++this.generation;
    this.readySoundPlayed = false;
    try {
      this.readyAudio = new AudioContext();
      void this.readyAudio.resume().catch(() => {});
    } catch { /* Voice still works if the browser cannot play a cue. */ }
    this.setState('connecting');
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (generation !== this.generation) { mic.getTracks().forEach(track => track.stop()); return; }
      this.mic = mic;
      this.inputMeter = this.makeMeter(mic);
      const peer = new RTCPeerConnection();
      this.peer = peer;
      for (const track of mic.getTracks()) peer.addTrack(track, mic);
      peer.ontrack = event => {
        if (generation !== this.generation) return;
        this.sink?.pause();
        const sink = new Audio();
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        sink.srcObject = stream;
        sink.autoplay = true;
        void sink.play().catch(() => {});
        this.sink = sink;
        // Chromium needs a media element consuming the remote track before
        // Web Audio can meter it. The analyser only drives the visual bars.
        this.outputMeter?.source.disconnect();
        this.outputMeter = this.makeMeter(stream);
      };
      peer.onconnectionstatechange = () => {
        if (generation !== this.generation) return;
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.stop();
      };
      const channel = peer.createDataChannel('oai-events');
      channel.onopen = () => {
        if (generation !== this.generation) return;
        this.setState('listening');
        this.playReadySound();
        this.startMeterLoop();
      };
      channel.onclose = () => { if (generation === this.generation) this.stop(); };
      channel.onmessage = event => {
        if (generation !== this.generation || typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data) as { type?: string };
          if (message.type === 'input_audio_buffer.speech_started' || message.type === 'conversation.item.input_audio_transcription.completed') {
            window.clearTimeout(this.quietTimer);
            this.setState('listening');
          } else if (message.type === 'response.output_audio_transcript.delta') {
            this.setState('speaking');
            window.clearTimeout(this.quietTimer);
            this.quietTimer = window.setTimeout(() => this.setState('listening'), 900);
          }
        } catch { /* provider sent a non-JSON control frame */ }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await this.waitForICE(peer);
      if (generation !== this.generation) return;
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.chatId)}/voice/sdp`), {
        method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: peer.localDescription?.sdp ?? offer.sdp ?? '',
      });
      if (!response.ok) throw new Error('Voice could not connect. Check Voice settings and try again.');
      const providerId = response.headers.get('X-Voice-Session') ?? '';
      const answer = await response.text();
      if (generation !== this.generation) { this.endProvider(providerId); return; }
      this.providerId = providerId;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (error) {
      if (generation === this.generation) this.stop();
      throw error;
    }
  }

  stop(): void {
    ++this.generation;
    if (this.meterFrame) cancelAnimationFrame(this.meterFrame);
    this.meterFrame = 0;
    this.lastMeterUpdate = 0;
    this.inputMeter?.source.disconnect();
    this.outputMeter?.source.disconnect();
    this.inputMeter = null;
    this.outputMeter = null;
    window.clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
    this.sink?.pause();
    if (this.sink) this.sink.srcObject = null;
    this.sink = null;
    this.mic?.getTracks().forEach(track => track.stop());
    this.mic = null;
    try { this.peer?.close(); } catch { /* already closed */ }
    this.peer = null;
    const providerId = this.providerId;
    this.providerId = '';
    this.endProvider(providerId);
    if (this.readyAudio) void this.readyAudio.close().catch(() => {});
    this.readyAudio = null;
    this.onLevels([0, 0, 0, 0]);
    this.setState('idle');
  }

  private makeMeter(stream: MediaStream): VoiceMeter | null {
    if (!this.readyAudio) return null;
    try {
      const source = this.readyAudio.createMediaStreamSource(stream);
      const analyser = this.readyAudio.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      return { source, analyser, bins: new Uint8Array(analyser.frequencyBinCount) };
    } catch { return null; } // Meter failure must not interrupt the call.
  }

  private meterLevels(meter: VoiceMeter | null): number[] {
    if (!meter || !this.readyAudio || this.readyAudio.state !== 'running') return [0, 0, 0, 0];
    meter.analyser.getByteFrequencyData(meter.bins);
    const hzPerBin = this.readyAudio.sampleRate / meter.analyser.fftSize;
    const edges = [100, 400, 900, 2000, 4000];
    return edges.slice(0, -1).map((start, index) => {
      const first = Math.max(1, Math.floor(start / hzPerBin));
      const last = Math.min(meter.bins.length, Math.ceil(edges[index + 1] / hzPerBin));
      let energy = 0;
      for (let bin = first; bin < last; bin++) energy += meter.bins[bin];
      return Math.min(1, Math.max(0, (energy / Math.max(1, last - first) - 45) / 145));
    });
  }

  private startMeterLoop(): void {
    if (this.meterFrame) return;
    const generation = this.generation;
    const sample = (at: number) => {
      if (generation !== this.generation || this.state === 'idle') { this.meterFrame = 0; return; }
      if (at - this.lastMeterUpdate >= 33) {
        this.lastMeterUpdate = at;
        const input = this.meterLevels(this.inputMeter);
        const output = this.meterLevels(this.outputMeter);
        const inputEnergy = input.reduce((sum, level) => sum + level, 0);
        const outputEnergy = output.reduce((sum, level) => sum + level, 0);
        // Follow the louder live track, including a spoken interruption while
        // the assistant's reply is still playing.
        this.onLevels(outputEnergy > inputEnergy * 1.15 ? output : input);
      }
      this.meterFrame = requestAnimationFrame(sample);
    };
    this.meterFrame = requestAnimationFrame(sample);
  }

  private playReadySound(): void {
    if (this.readySoundPlayed || !this.readyAudio || this.readyAudio.state !== 'running') return;
    this.readySoundPlayed = true;
    const context = this.readyAudio;
    const start = context.currentTime + 0.02;
    for (const [index, frequency] of [523.25, 659.25, 783.99].entries()) {
      const note = context.createOscillator();
      const volume = context.createGain();
      const at = start + index * 0.075;
      note.type = 'triangle';
      note.frequency.setValueAtTime(frequency, at);
      volume.gain.setValueAtTime(0.0001, at);
      volume.gain.exponentialRampToValueAtTime(0.065, at + 0.012);
      volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
      note.connect(volume).connect(context.destination);
      note.start(at);
      note.stop(at + 0.18);
    }
  }

  private endProvider(providerId: string): void {
    if (!providerId) return;
    void fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.chatId)}/voice/end`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: providerId }), keepalive: true,
    }).catch(() => {});
  }

  private waitForICE(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { peer.removeEventListener('icegatheringstatechange', changed); window.clearTimeout(timer); resolve(); };
      const changed = () => { if (peer.iceGatheringState === 'complete') done(); };
      const timer = window.setTimeout(done, 2000);
      peer.addEventListener('icegatheringstatechange', changed);
    });
  }
}

export type ActiveVoiceCall = { chatId: string; state: SDKVoiceState; startedAt: number; providerSessionId: string };

/** Browser-wide call owner. Chat views may be replaced without closing the microphone. */
class SDKVoiceCallController {
  private session: SDKVoiceSession | null = null;
  private call: ActiveVoiceCall | null = null;
  private listeners = new Set<() => void>();
  private levelListeners = new Set<(levels: readonly number[]) => void>();

  constructor() {
    window.addEventListener('pagehide', () => this.stop());
  }

  get active(): ActiveVoiceCall | null { return this.call; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => this.listeners.delete(listener);
  }

  onLevels(listener: (levels: readonly number[]) => void): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  async start(chatId: string): Promise<void> {
    if (this.call) {
      if (this.call.chatId === chatId) return;
      throw new Error('A voice call is already active in another chat. Return to that chat or stop its call first.');
    }
    const session = new SDKVoiceSession(chatId, state => {
      if (this.session !== session) return;
      if (state === 'idle') {
        this.session = null;
        this.call = null;
      } else if (this.call) {
        this.call = { ...this.call, state, providerSessionId: session.providerSessionId };
      }
      this.notify();
    }, levels => {
      if (this.session === session) for (const listener of this.levelListeners) listener(levels);
    });
    this.session = session;
    this.call = { chatId, state: 'connecting', startedAt: Date.now(), providerSessionId: '' };
    this.notify();
    try {
      await session.start();
      if (this.session === session && this.call) {
        this.call = { ...this.call, providerSessionId: session.providerSessionId };
        this.notify();
      }
    } catch (error) {
      if (this.session === session) this.stop();
      throw error;
    }
  }

  stop(): void {
    const session = this.session;
    if (!session) return;
    session.stop();
    // A failed feature check can leave SDKVoiceSession idle before it emits
    // any state change. Clear our owner in that case as well.
    if (this.session === session) {
      this.session = null;
      this.call = null;
      this.notify();
    }
  }

  stopProvider(chatId: string, providerId: string): void {
    if (this.call?.chatId === chatId && this.session?.providerSessionId === providerId) this.stop();
  }

  private notify(): void { for (const listener of this.listeners) listener(); }
}

export const sdkVoiceCall = new SDKVoiceCallController();
