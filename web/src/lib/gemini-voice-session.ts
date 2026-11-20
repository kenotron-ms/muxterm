import { apiPath } from './base-path.js';
import type { SDKVoiceState } from './sdk-voice-session.js';

type GeminiFrame = {
  setupComplete?: object;
  serverContent?: {
    interrupted?: boolean;
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
  };
  toolCall?: { functionCalls?: { id?: string; name?: string }[] };
};

/** Gemini Live owns its WebSocket, PCM stream, playback queue, and tool events. */
export class GeminiVoiceSession {
  state: SDKVoiceState = 'idle';
  private generation = 0;
  private socket: WebSocket | null = null;
  private mic: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private capture: ScriptProcessorNode | null = null;
  private silent: GainNode | null = null;
  private playback = new Set<AudioBufferSourceNode>();
  private playAt = 0;
  private sessionId = '';
  private toolPending = false;
  private meterAt = 0;
  private inputText = '';
  private outputText = '';
  private eventTail: Promise<void> = Promise.resolve();

  get providerSessionId(): string { return this.sessionId; }

  constructor(private readonly chatId: string,
    private readonly onState: (state: SDKVoiceState) => void,
    private readonly onLevels: (levels: readonly number[]) => void) {}

  private setState(state: SDKVoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.WebSocket) {
      throw new Error('Voice requires a secure browser with microphone support.');
    }
    const generation = ++this.generation;
    this.setState('connecting');
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (generation !== this.generation) {
        mic.getTracks().forEach(track => track.stop());
        return;
      }
      this.mic = mic;
      this.audio = new AudioContext();
      await this.audio.resume();
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.chatId)}/voice/gemini/start`), { method: 'POST' });
      if (!response.ok) throw new Error('Gemini Live could not start. Check Voice settings and try again.');
      const session = await response.json() as { token: string; sessionId: string; model: string; instructions: string };
      if (generation !== this.generation) return;
      this.sessionId = session.sessionId;
      const url = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=' + encodeURIComponent(session.token);
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => {
        if (generation !== this.generation) return;
        socket.send(JSON.stringify({ setup: {
          model: `models/${session.model}`,
          generationConfig: { responseModalities: ['AUDIO'] },
          inputAudioTranscription: {}, outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: session.instructions }] },
          tools: [{ functionDeclarations: [{ name: 'get_chat_transcript',
            description: 'Read recent completed turns of this task chat when the user asks for context, progress, or what the task agent said.',
            parameters: { type: 'OBJECT', properties: {} } }] }],
        } }));
      };
      socket.onmessage = async event => {
        if (generation !== this.generation) return;
        // Gemini sends JSON in binary WebSocket frames in Chromium. The
        // browser exposes those frames as Blob unless binaryType is changed.
        const data = typeof event.data === 'string' ? event.data : event.data instanceof Blob ? await event.data.text() : '';
        if (generation !== this.generation || !data) return;
        try { void this.handleFrame(JSON.parse(data) as GeminiFrame, generation).catch(() => {}); } catch { /* malformed provider frame */ }
      };
      socket.onclose = () => {
        if (generation !== this.generation) return;
        this.record('voice.session.error');
        this.stop();
      };
      socket.onerror = () => { if (generation === this.generation) { this.record('voice.session.error'); this.stop(); } };
    } catch (error) {
      if (generation === this.generation) this.stop();
      throw error;
    }
  }

  private async handleFrame(frame: GeminiFrame, generation: number): Promise<void> {
    if (frame.setupComplete) {
      this.startCapture();
      this.setState('listening');
    }
    const content = frame.serverContent;
    if (content?.interrupted) {
      this.clearPlayback();
      this.flushOutput();
      this.setState('listening');
    }
    if (content?.inputTranscription?.text) {
      const text = content.inputTranscription.text;
      this.inputText += text;
      this.record('voice.input.delta', text);
      if (this.state === 'speaking') { this.clearPlayback(); this.setState('listening'); }
    }
    if (content?.outputTranscription?.text) {
      const text = content.outputTranscription.text;
      this.outputText += text;
      this.record('voice.output.delta', text);
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/pcm')) {
        this.queueAudio(part.inlineData.data);
      }
    }
    if (content?.turnComplete) {
      this.flushInput();
      this.flushOutput();
      if (this.playback.size === 0) this.setState('listening');
    }
    const calls = frame.toolCall?.functionCalls;
    if (calls?.length) {
      this.toolPending = true;
      const responses: { id: string; name: string; response: unknown }[] = [];
      for (const call of calls) {
        if (!call.id || !call.name) continue;
        let result: unknown = { error: 'Tool unavailable' };
        if (call.name === 'get_chat_transcript') {
          try {
            const res = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.chatId)}/voice/gemini/tool`), {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: this.sessionId, name: call.name }),
            });
            result = res.ok ? await res.json() : { error: 'Chat transcript unavailable' };
          } catch { result = { error: 'Chat transcript unavailable' }; }
        }
        responses.push({ id: call.id, name: call.name, response: result });
      }
      if (generation === this.generation && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
        this.toolPending = false;
      }
    }
  }

  private startCapture(): void {
    const audio = this.audio, mic = this.mic;
    if (!audio || !mic || this.capture) return;
    this.source = audio.createMediaStreamSource(mic);
    // TODO: use AudioWorkletNode when its cross-browser capture path is verified.
    this.capture = audio.createScriptProcessor(2048, 1, 1);
    this.silent = audio.createGain();
    this.silent.gain.value = 0;
    this.source.connect(this.capture);
    this.capture.connect(this.silent).connect(audio.destination);
    this.capture.onaudioprocess = event => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN || this.toolPending || socket.bufferedAmount > 256 * 1024) return;
      const input = event.inputBuffer.getChannelData(0);
      const ratio = event.inputBuffer.sampleRate / 16000;
      const samples = Math.floor(input.length / ratio);
      const bytes = new Uint8Array(samples * 2);
      let energy = 0;
      for (let i = 0; i < samples; i++) {
        const value = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
        const pcm = value < 0 ? value * 32768 : value * 32767;
        const integer = Math.round(pcm);
        bytes[i * 2] = integer & 255;
        bytes[i * 2 + 1] = (integer >> 8) & 255;
        energy += value * value;
      }
      const now = performance.now();
      if (now - this.meterAt > 33) {
        this.meterAt = now;
        const level = Math.min(1, Math.sqrt(energy / Math.max(samples, 1)) * 5);
        this.onLevels([level * .65, level, level * .8, level * .55]);
      }
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      socket.send(JSON.stringify({ realtimeInput: { audio: { data: btoa(binary), mimeType: 'audio/pcm;rate=16000' } } }));
    };
  }

  private queueAudio(encoded: string): void {
    const audio = this.audio;
    if (!audio) return;
    const raw = atob(encoded);
    const samples = raw.length >> 1;
    if (samples === 0) return;
    const buffer = audio.createBuffer(1, samples, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) {
      const integer = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
      channel[i] = (integer > 32767 ? integer - 65536 : integer) / 32768;
    }
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    source.onended = () => {
      this.playback.delete(source);
      if (this.playback.size === 0 && this.state === 'speaking') this.setState('listening');
    };
    this.playback.add(source);
    this.playAt = Math.max(this.playAt, audio.currentTime + .015);
    source.start(this.playAt);
    this.playAt += buffer.duration;
    this.setState('speaking');
  }

  private clearPlayback(): void {
    for (const source of this.playback) { try { source.stop(); } catch { /* already ended */ } }
    this.playback.clear();
    this.playAt = this.audio?.currentTime ?? 0;
  }

  private record(type: string, text = ''): void {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.eventTail = this.eventTail.then(() => fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.chatId)}/voice/gemini/event`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, type, text }), keepalive: true,
    }).then(() => {}).catch(() => {}));
  }
  private flushInput(): void { if (this.inputText) { this.record('voice.input.done'); this.inputText = ''; } }
  private flushOutput(): void { if (this.outputText) { this.record('voice.output.done'); this.outputText = ''; } }

  stop(): void {
    ++this.generation;
    this.flushInput(); this.flushOutput();
    this.clearPlayback();
    this.capture?.disconnect(); this.source?.disconnect(); this.silent?.disconnect();
    this.capture = null; this.source = null; this.silent = null;
    this.mic?.getTracks().forEach(track => track.stop());
    this.mic = null;
    this.socket?.close(); this.socket = null;
    if (this.audio) void this.audio.close().catch(() => {});
    this.audio = null;
    const sessionId = this.sessionId;
    this.sessionId = '';
    if (sessionId) {
      void this.eventTail.then(() => fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.chatId)}/voice/gemini/end`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }), keepalive: true,
      })).catch(() => {});
    }
    this.onLevels([0, 0, 0, 0]);
    this.setState('idle');
  }
}
