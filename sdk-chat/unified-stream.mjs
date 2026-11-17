// Connected Amplifier Unified client. Unified owns execution and its native history;
// this adapter only projects its version-1 HTTP/SSE session into muxterm events.
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const capabilities = { approvals: false, transcript_read: false, interrupt: true,
  live_input: true, attributed_service_input: false, native_steering: true };

function nativeSessionId(muxtermId) {
  const bytes = createHash('sha256').update('muxterm-amplifier-unified-v1:').update(muxtermId).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // deterministic UUIDv8
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function connection() {
  const configured = process.env.MUXTERM_UNIFIED_URL;
  const tokenFile = process.env.MUXTERM_UNIFIED_TOKEN_FILE;
  if (!configured || !tokenFile)
    throw new Error('Amplifier Unified needs MUXTERM_UNIFIED_URL and MUXTERM_UNIFIED_TOKEN_FILE');
  const url = new URL(configured);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(['http:', 'https:'].includes(url.protocol))) throw new Error('Invalid Unified base URL');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Unified HTTP is allowed only on loopback; use HTTPS for a remote host');
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw new Error('Unified control token file is empty');
  return { base: url.origin, token };
}

export class UnifiedStream {
  constructor(session, emit) {
    this.session = session;
    this.emit = emit;
    this.closed = false;
    this.clientId = `muxterm-${session.id}`;
    this.nativeId = session.nativeId || nativeSessionId(session.id);
    this.currentInputId = '';
    this.emittedInputs = new Set();
    this.emittedText = new Map();
    this.stopRequested = false;
    this.controller = null;
    this.connection = connection();
    this.ready = this.initialize();
  }

  async request(method, path, body, signal) {
    const response = await fetch(this.connection.base + path, {
      method, signal: signal || AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${this.connection.token}`,
        'X-Amplifier-Client': this.clientId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let result;
    try { result = await response.json(); } catch { throw new Error(`Unified returned HTTP ${response.status} without JSON`); }
    if (!response.ok || result?.accepted === false)
      throw new Error(result?.error || result?.message || `Unified returned HTTP ${response.status}`);
    return result;
  }

  async initialize() {
    if (this.session.catalog) return;
    const attached = await this.request('POST', '/api/clients/attach', {
      clientId: this.clientId, kind: 'native', protocolVersion: 1, includeState: false,
    });
    if (attached.protocolVersion !== 1 || !attached.hostInstanceId)
      throw new Error('Unified host does not support connected-client protocol version 1');
    if (this.closed) return;
    if (!this.session.nativeId) {
      // Both identifiers are stable across an uncertain creation response.
      // The session can be found again without issuing a second creation.
      await this.request('POST', '/api/actions', { id: `muxterm-create-${this.session.id}`,
        action: 'session.create', args: { id: this.nativeId, workspace: this.session.cwd,
          ...(this.session.bundle ? { bundle: this.session.bundle } : {}), select: false } });
    }
    const first = await this.request('GET', `/api/sessions/${encodeURIComponent(this.nativeId)}`);
    if (this.closed) return;
    if (first.protocolVersion !== 1)
      throw new Error('Unified session protocol changed; update the Unified adapter');
    if (first.session?.id !== this.nativeId) throw new Error('Unified returned a different session');
    this.session.nativeId = this.nativeId;
    this.emit(this.session.id, 'session.started', { id: `unified:session:${this.nativeId}`,
      nativeId: this.nativeId, capabilities });
    this.applySnapshot(first);
    this.followPromise = this.follow();
  }

  options() {
    return { model: '', effort: '', models: [], defaultModel: '' };
  }

  select(cmd) {
    if (cmd.model || cmd.effort || (cmd.mode && cmd.mode !== 'agent'))
      throw new Error('Configure the Unified session in Unified; Muxterm has no linked model control yet');
    return this.options();
  }

  async title(cmd) {
    await this.ready;
    if (cmd.mode === 'suggest') return { name: this.lastRow?.title || '' };
    if (cmd.mode === 'manual' || cmd.mode === 'generated') {
      const result = await this.request('POST', `/api/sessions/${encodeURIComponent(this.nativeId)}/commands`, {
        id: randomUUID(), action: 'session.rename', args: { title: cmd.name },
      });
      if (result.session) this.applySnapshot(result);
      return { name: cmd.name, source: cmd.mode };
    }
    return { name: this.lastRow?.title || '', source: 'native' };
  }

  async send(input) {
    await this.ready;
    if (input.attachments?.length) throw new Error('Unified attachments are not yet supported in Muxterm');
    const result = await this.request('POST', `/api/sessions/${encodeURIComponent(this.nativeId)}/commands`, {
      id: input.id, action: 'conversation.send', args: { text: input.content },
    });
    if (!result.accepted) throw new Error('Unified did not confirm message acceptance');
    this.currentInputId = input.id;
    this.session.busy = true;
    this.emittedInputs.add(input.id);
    this.emit(this.session.id, 'input.accepted', { id: `unified:input:${input.id}`,
      inputId: input.id, kind: input.kind, source: input.source, text: input.displayContent || input.content });
    if (result.session) this.applySnapshot(result);
    return { status: 'accepted', inputId: input.id };
  }

  async interrupt() {
    await this.ready;
    const result = await this.request('POST', `/api/sessions/${encodeURIComponent(this.nativeId)}/commands`, {
      id: `muxterm-stop-${this.session.id}-${this.currentInputId || randomUUID()}`,
      action: 'conversation.stop', args: {},
    });
    this.stopRequested = true;
    if (result.session) this.applySnapshot(result);
    return { status: 'accepted' };
  }

  applySnapshot(frame) {
    if (frame.protocolVersion !== 1) {
      this.emit(this.session.id, 'error', { id: `unified:protocol-error:${this.nativeId}`,
        message: 'Unified session protocol changed; update the Unified adapter' });
      this.controller?.abort();
      return;
    }
    const row = frame.session;
    if (!row || row.id !== this.nativeId || this.closed) return;
    this.lastRow = row;
    for (const message of row.messages || []) {
      if (message.role === 'user') {
        const inputId = message.inputId || message.id;
        if (inputId && !this.emittedInputs.has(inputId)) {
          this.emittedInputs.add(inputId);
          this.currentInputId = inputId;
          this.emit(this.session.id, 'input.accepted', { id: `unified:input:${inputId}`,
            inputId, kind: 'user', source: 'unified', text: message.text || '' });
        }
      } else if (message.role === 'assistant' && message.text) {
        this.emitAssistant(message.streamId || message.id, message.text);
      }
    }
    if (row.streaming && row.streamingId) this.emitAssistant(row.streamingId, row.streaming);
    const working = ['working', 'starting', 'running', 'stopping'].includes(row.status);
    if (row.status === 'error') {
      this.session.busy = false;
      this.stopRequested = false;
      this.emit(this.session.id, 'error', { id: `unified:error:${this.currentInputId || this.nativeId}`,
        message: row.error || row.activity?.label || 'Unified reported a failed turn' });
      return;
    }
    if (working && !this.session.busy) {
      this.session.busy = true;
      this.emit(this.session.id, 'turn.started', { id: `unified:turn:${this.currentInputId}:started`,
        inputIds: this.currentInputId ? [this.currentInputId] : [] });
    } else if (!working && this.session.busy) {
      this.session.busy = false;
      const stopped = this.stopRequested || row.status === 'stopped';
      this.emit(this.session.id, stopped ? 'turn.cancelled' : 'turn.completed', {
        id: `unified:turn:${this.currentInputId}:${stopped ? 'cancelled' : 'completed'}`,
        inputIds: this.currentInputId ? [this.currentInputId] : [] });
      this.stopRequested = false;
    }
  }

  emitAssistant(identity, text) {
    if (!identity || !text) return;
    if (this.emittedText.get(identity) === text) return;
    this.emittedText.set(identity, text);
    // Full snapshots may repeat after reconnect. Go appends only the suffix it
    // has not journaled, keyed by this stable item ID.
    this.emit(this.session.id, 'assistant.delta', { itemId: `unified:${identity}`,
      text, cumulative: true });
  }

  async follow() {
    let delay = 250;
    while (!this.closed) {
      const controller = new AbortController();
      this.controller = controller;
      try {
        const response = await fetch(this.connection.base +
          `/api/sessions/${encodeURIComponent(this.nativeId)}/events`, {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${this.connection.token}`,
            'X-Amplifier-Client': this.clientId },
        });
        if (!response.ok) throw new Error(`Unified stream returned HTTP ${response.status}`);
        if (!response.body) throw new Error('Unified stream has no body');
        delay = 250;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const packet = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = packet.split('\n');
            if (!lines.some(line => line === 'event: snapshot')) continue;
            const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const snapshot = JSON.parse(data);
            if (snapshot.deleted) return;
            this.applySnapshot(snapshot);
          }
        }
      } catch (error) {
        if (this.closed || controller.signal.aborted) return;
        if (/HTTP 40[013]/.test(String(error))) {
          this.emit(this.session.id, 'error', { message: String(error) });
          return;
        }
      } finally { if (this.controller === controller) this.controller = null; }
      if (this.closed) return;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(5000, delay * 2);
    }
  }

  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.ready.catch(() => {});
    await this.followPromise?.catch(() => {});
    // Closing a Muxterm view never stops Unified execution.
  }
}
