import { apiPath } from './base-path.js';

export type SDKVoiceState = 'idle' | 'connecting' | 'listening' | 'speaking';

/** One browser audio connection to GPT-Live, bound to one SDK chat. */
export class SDKVoiceSession {
  private chatId: string;
  private onState: (state: SDKVoiceState) => void;
  private peer: RTCPeerConnection | null = null;
  private mic: MediaStream | null = null;
  private sink: HTMLAudioElement | null = null;
  private providerId = '';
  private generation = 0;
  private quietTimer: number | undefined;
  private readyAudio: AudioContext | null = null;
  private readySoundPlayed = false;
  state: SDKVoiceState = 'idle';

  constructor(chatId: string, onState: (state: SDKVoiceState) => void) {
    this.chatId = chatId;
    this.onState = onState;
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
      const peer = new RTCPeerConnection();
      this.peer = peer;
      for (const track of mic.getTracks()) peer.addTrack(track, mic);
      peer.ontrack = event => {
        if (generation !== this.generation) return;
        const sink = new Audio();
        sink.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        sink.autoplay = true;
        void sink.play().catch(() => {});
        this.sink = sink;
      };
      peer.onconnectionstatechange = () => {
        if (generation !== this.generation) return;
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.stop();
      };
      const channel = peer.createDataChannel('oai-events');
      channel.onclose = () => { if (generation === this.generation) this.stop(); };
      channel.onmessage = event => {
        if (generation !== this.generation || typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data) as { type?: string };
          if (message.type === 'session.started') {
            this.setState('listening');
            this.playReadySound();
          } else if (message.type === 'session.input_transcript.delta') {
            window.clearTimeout(this.quietTimer);
            this.setState('listening');
          } else if (message.type === 'session.output_transcript.delta') {
            this.setState('speaking');
            window.clearTimeout(this.quietTimer);
            this.quietTimer = window.setTimeout(() => this.setState('listening'), 900);
          } else if (message.type === 'session.closed') {
            this.stop();
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
    this.setState('idle');
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
