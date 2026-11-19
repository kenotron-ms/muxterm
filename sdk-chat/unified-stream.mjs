// Connected Amplifier Unified client. Unified owns execution and its native history;
// this adapter only projects its version-1 HTTP/SSE session into muxterm events.
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { instanceDataHome } from './instance-xdg.mjs';

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
  let settings = { mode: 'local' };
  try {
    settings = JSON.parse(readFileSync(join(instanceDataHome(), 'muxterm', 'sdk-chat', 'unified', 'connection.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read Unified connection settings. Reconnect in AI settings.');
  }
  if (!['local', 'existing'].includes(settings.mode)) throw new Error('Invalid Unified connection mode. Reconnect in AI settings.');
  const configured = settings.mode === 'local' ? 'http://127.0.0.1:8941' : settings.url;
  const tokenFile = settings.mode === 'local'
    ? join(homedir(), '.amplifier-unified', 'config', 'auth', 'control-token')
    : join(instanceDataHome(), 'muxterm', 'sdk-chat', 'unified', 'control-token');
  let url;
  try { url = new URL(configured); }
  catch { throw new Error('Invalid Unified host address. Reconnect in AI settings.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(['http:', 'https:'].includes(url.protocol))) throw new Error('Invalid Unified host address. Reconnect in AI settings.');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Unified HTTP is allowed only on loopback; use HTTPS for a remote host');
  let token;
  try { token = readFileSync(tokenFile, 'utf8').trim(); }
  catch { throw new Error('Unified control token is unavailable. Reconnect in AI settings.'); }
  if (!token) throw new Error('Unified control token is empty. Reconnect in AI settings.');
  return { base: url.origin, token };
}

function stageError(stage, status) {
  const prefix = `Unified ${stage}`;
  let hint;
  if (status === 401 || status === 403) hint = 'Check the control token in AI settings.';
  else if (status >= 300 && status < 400) hint = 'The API redirected; check the Unified host address in AI settings.';
  else if (stage === 'message acceptance' && (!status || status >= 500))
    hint = 'Delivery may have succeeded; open this chat and check its saved input before sending again.';
  else if (stage === 'session creation' && (status === 400 || status === 422))
    hint = 'Check that the project path exists on the Unified host.';
  else if (status === 404) hint = 'Check the Unified host address and version in AI settings.';
  else if (status) hint = 'Check the Unified host and retry.';
  else hint = 'Check that Unified is running at the address in AI settings, then retry.';
  const detail = status ? ` returned HTTP ${status}` : ' could not reach the configured host';
  const error = new Error(`${prefix}${detail}. ${hint}`);
  error.status = status;
  return error;
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
    this.lastRevision = -1;
    this.stopRequested = false;
    this.controller = null;
    this.connection = connection();
    this.ready = this.initialize();
  }

  async request(method, path, body, stage, allowMissing = false) {
    let response;
    try {
      response = await fetch(this.connection.base + path, {
        method, redirect: 'manual', signal: AbortSignal.timeout(stage === 'message acceptance' ? 60000 : 15000),
        headers: { Authorization: `Bearer ${this.connection.token}`,
          'X-Amplifier-Client': this.clientId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw stageError(stage, 0); }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw stageError(stage, response.status);
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`Unified ${stage} returned an invalid response. Check the Unified host version in AI settings.`); }
    if (result?.accepted === false) throw new Error(`Unified ${stage} was declined. Check the Unified host in AI settings.`);
    return result;
  }

  async initialize() {
    if (this.session.catalog) return;
    const attached = await this.request('POST', '/api/clients/attach', {
      clientId: this.clientId, kind: 'native', protocolVersion: 1, includeState: false,
    }, 'client attach');
    if (attached.protocolVersion !== 1 || !attached.hostInstanceId)
      throw new Error('Unified host does not support connected-client protocol version 1');
    if (this.closed) return;
    let first = await this.request('GET', `/api/sessions/${encodeURIComponent(this.nativeId)}`,
      undefined, 'session read', true);
    if (!first && !this.session.nativeId) {
      // Read before create on every restart. If creation's response is lost,
      // inspect the stable native ID before deciding whether to retry.
      try {
        await this.request('POST', '/api/actions', { id: `muxterm-create-${this.session.id}`,
          action: 'session.create', args: { id: this.nativeId, workspace: this.session.cwd,
            ...(this.session.bundle ? { bundle: this.session.bundle } : {}), select: false } }, 'session creation');
      } catch (error) {
        try {
          first = await this.request('GET', `/api/sessions/${encodeURIComponent(this.nativeId)}`,
            undefined, 'session read', true);
        } catch { /* Preserve the creation-stage failure if recovery cannot be confirmed. */ }
        if (!first) throw error;
      }
    }
    first ||= await this.request('GET', `/api/sessions/${encodeURIComponent(this.nativeId)}`,
      undefined, 'session read');
    if (this.closed) return;
    if (first.protocolVersion !== 1)
      throw new Error('Unified session protocol changed; update the Unified adapter');
    if (first.session?.id !== this.nativeId) throw new Error('Unified returned a different session');
    const initialStream = await this.openEventStream();
    if (this.closed) { initialStream.controller.abort(); return; }
    this.session.nativeId = this.nativeId;
    this.emit(this.session.id, 'session.started', { id: `unified:session:${this.nativeId}`,
      nativeId: this.nativeId, capabilities });
    this.applySnapshot(first);
    this.followPromise = this.follow(initialStream);
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
      }, 'session rename');
      if (result.session) this.applySnapshot(result);
      return { name: cmd.name, source: cmd.mode };
    }
    return { name: this.lastRow?.title || '', source: 'native' };
  }

  async send(input) {
    await this.ready;
    if (input.attachments?.length) throw new Error('Unified attachments are not yet supported in Muxterm');
    this.currentInputId = input.id;
    const result = await this.request('POST', `/api/sessions/${encodeURIComponent(this.nativeId)}/commands`, {
      id: input.id, action: 'conversation.send', args: { text: input.content },
    }, 'message acceptance');
    if (!result.accepted) throw new Error('Unified did not confirm message acceptance');
    if (!this.emittedInputs.has(input.id)) {
      this.emittedInputs.add(input.id);
      this.emit(this.session.id, 'input.accepted', { id: `unified:input:${input.id}`,
        inputId: input.id, kind: input.kind, source: input.source,
        text: input.displayContent || input.content });
    }
    // SSE may have delivered the completed turn before the command reply.
    // Re-read after acknowledgement so an older snapshot cannot leave busy
    // set forever, and never turn an accepted send into uncertain delivery.
    this.session.busy = true;
    try {
      const latest = await this.request('GET', `/api/sessions/${encodeURIComponent(this.nativeId)}`,
        undefined, 'session read');
      this.applySnapshot(latest);
    } catch (error) {
      this.session.busy = false;
      this.emit(this.session.id, 'error', { id: `unified:send-read:${input.id}`,
        message: error instanceof Error ? error.message : 'Unified session read failed. Check AI settings.' });
    }
    return { status: 'accepted', inputId: input.id };
  }

  async interrupt() {
    await this.ready;
    const result = await this.request('POST', `/api/sessions/${encodeURIComponent(this.nativeId)}/commands`, {
      id: `muxterm-stop-${this.session.id}-${this.currentInputId || randomUUID()}`,
      action: 'conversation.stop', args: {},
    }, 'turn interruption');
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
    if (Number.isInteger(frame.revision)) {
      if (frame.revision < this.lastRevision) return;
      this.lastRevision = frame.revision;
    }
    this.lastRow = row;
    let replyCommitted = !this.currentInputId;
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
        if (message.inputId === this.currentInputId) replyCommitted = true;
        this.emitAssistant(message.streamId || message.id, message.text);
      } else if (message.role === 'assistant' && message.inputId === this.currentInputId) {
        replyCommitted = true;
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
    } else if (!working && this.session.busy && (replyCommitted || this.stopRequested || row.status === 'stopped')) {
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

  async openEventStream() {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(this.connection.base +
        `/api/sessions/${encodeURIComponent(this.nativeId)}/events`, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.connection.token}`,
          'X-Amplifier-Client': this.clientId },
      });
    } catch {
      if (this.controller === controller) this.controller = null;
      throw stageError('event stream', 0);
    } finally { clearTimeout(timeout); }
    if (!response.ok || !response.body) {
      if (this.controller === controller) this.controller = null;
      throw response.ok
        ? new Error('Unified event stream has no body. Check the Unified host version in AI settings.')
        : stageError('event stream', response.status);
    }
    return { response, controller };
  }

  async follow(initialStream) {
    let delay = 250;
    let stream = initialStream;
    while (!this.closed) {
      let controller = stream?.controller;
      try {
        stream ||= await this.openEventStream();
        controller = stream.controller;
        delay = 250;
        const reader = stream.response.body.getReader();
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
            let snapshot;
            try { snapshot = JSON.parse(data); }
            catch { throw new Error('Unified event stream sent an invalid snapshot. Check the Unified host version in AI settings.'); }
            if (snapshot.deleted) return;
            this.applySnapshot(snapshot);
          }
        }
      } catch (error) {
        if (this.closed || controller?.signal.aborted) return;
        this.emit(this.session.id, 'error', { id: `unified:stream:${this.nativeId}`,
          message: error instanceof Error && error.message.startsWith('Unified ')
            ? error.message : stageError('event stream', 0).message });
        if (error.status && error.status >= 400 && error.status < 500) return;
      } finally {
        if (this.controller === controller) this.controller = null;
        stream = null;
      }
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
