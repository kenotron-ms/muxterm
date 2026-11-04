import { createOpencode } from '@opencode-ai/sdk';
import { nativeConnectors, inputText, nativeImageBlocks, acceptInput, simpleTitle } from './native-common.mjs';

function unwrap(result) {
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.data;
}

function errorMessage(error) {
  return typeof error === 'string' ? error : error?.message || error?.data?.message || JSON.stringify(error);
}

export class OpenCodeStream {
  constructor(session, emit) {
    this.session = session;
    this.emit = emit;
    this.parts = new Map();
    this.tools = new Map();
    this.messageRoles = new Map();
    this.pendingParts = new Map();
    this.ready = this.initialize();
  }

  async initialize() {
    const s = this.session;
    const mcp = Object.fromEntries(nativeConnectors(s).map(item => [item.name, {
      type: 'local', command: [item.command, ...item.args],
      environment: Object.fromEntries(item.env.map(value => [value.name, value.value])) }]));
    // OpenCode applies MCP configuration to a server, so each muxterm chat owns
    // its own server and only receives its own origin capability.
    const { server, client } = await createOpencode({ port: 0, timeout: 15000, config: { mcp } });
    this.server = server;
    this.client = client;
    this.eventsAbort = new AbortController();
    const stream = await client.event.subscribe({ query: { directory: s.cwd }, signal: this.eventsAbort.signal });
    this.events = (async () => {
      try { for await (const event of stream.stream) this.onEvent(event); }
      catch (error) { if (!this.eventsAbort.signal.aborted) this.fail(error); }
    })();
    if (s.nativeId) unwrap(await client.session.get({ path: { id: s.nativeId }, query: { directory: s.cwd } }));
    else s.nativeId = unwrap(await client.session.create({ query: { directory: s.cwd } })).id;
    this.emit(s.id, 'session.started', { nativeId: s.nativeId, capabilities: {
      approvals: false, transcript_read: false, interrupt: true, live_input: false,
      attributed_service_input: false, native_steering: false } });
  }

  async options() {
    const data = unwrap(await this.client.provider.list({ query: { directory: this.session.cwd } }));
    const config = unwrap(await this.client.config.get({ query: { directory: this.session.cwd } }));
    const models = data.all.filter(provider => data.connected.includes(provider.id))
      .flatMap(provider => Object.values(provider.models).filter(model =>
        (!model.modalities || (model.modalities.input?.includes('text') && model.modalities.output?.includes('text'))) &&
        model.status !== 'deprecated').map(model => ({
        id: `${provider.id}/${model.id}`, label: `${provider.name}: ${model.name}`,
        efforts: [], defaultEffort: '' })));
    if (!models.length) throw new Error('OpenCode has no connected text model');
    const available = id => models.some(item => item.id === id);
    const model = this.session.model || (available(config.model) ? config.model : '') ||
      (available('opencode/big-pickle') ? 'opencode/big-pickle' : models[0]?.id || '');
    return { model, effort: '', models };
  }

  async select(cmd) {
    if (this.session.busy) throw new Error('Finish the current OpenCode turn before changing settings');
    const options = await this.options();
    if (cmd.model && !options.models.some(item => item.id === cmd.model)) throw new Error('Unsupported OpenCode model');
    if (cmd.effort) throw new Error('OpenCode SDK does not expose a stable effort selector');
    this.session.model = cmd.model || options.model;
    return { ...options, model: this.session.model };
  }

  title(cmd) {
    if (cmd.mode !== 'read' && cmd.name) void this.client.session.update({ path: { id: this.session.nativeId },
      query: { directory: this.session.cwd }, body: { title: cmd.name } }).catch(() => {});
    return simpleTitle(cmd);
  }

  async send(input) {
    await this.ready;
    if (input.kind === 'steer') return this.steer(input);
    if (input.kind !== 'user' || this.session.busy) throw new Error('OpenCode turn unavailable');
    const s = this.session;
    await this.prompt(input);
    s.busy = true;
    this.inputIds = [input.id];
    this.cancelled = false;
    this.emit(s.id, 'turn.started');
    acceptInput(s, this.emit, input);
    return { status: 'accepted', inputId: input.id };
  }

  async prompt(input) {
    const s = this.session;
    const model = input.model || s.model || (await this.options()).model;
    const [providerID, ...modelParts] = model.split('/');
    const images = await nativeImageBlocks(input);
    const body = { parts: [{ type: 'text', text: inputText(input) }, ...images.map(item => ({
      type: 'file', mime: item.mimeType, filename: item.name,
      url: `data:${item.mimeType};base64,${item.data}` }))],
      ...(model ? { model: { providerID, modelID: modelParts.join('/') } } : {}) };
    unwrap(await this.client.session.promptAsync({ path: { id: s.nativeId }, query: { directory: s.cwd }, body }));
  }

  async steer(input) {
    const s = this.session;
    if (!s.busy || this.continuing) throw new Error('No OpenCode turn available to steer');
    this.continuing = true;
    let timeout;
    const idle = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('OpenCode did not stop the prior generation')), 10000);
      this.waitForIdle = () => { clearTimeout(timeout); resolve(); };
    });
    idle.catch(() => {});
    try {
      unwrap(await this.client.session.abort({ path: { id: s.nativeId }, query: { directory: s.cwd } }));
      await idle;
      await this.prompt(input);
      this.inputIds.push(input.id);
      acceptInput(s, this.emit, input);
      this.emit(s.id, 'turn.continued', { inputIds: this.inputIds });
      this.continuing = false;
      return { status: 'accepted', inputId: input.id };
    } catch (error) {
      this.continuing = false;
      s.busy = false;
      this.emit(s.id, 'session.uncertain', { inputIds: this.inputIds, message: String(error) });
      throw error;
    } finally { clearTimeout(timeout); this.waitForIdle = null; }
  }

  onEvent(event) {
    const p = event.properties || {};
    const s = this.session;
    if (p.sessionID !== s.nativeId && p.part?.sessionID !== s.nativeId && p.info?.sessionID !== s.nativeId &&
      !(event.type === 'session.error' && !p.sessionID)) return;
    if (event.type === 'message.updated') {
      this.messageRoles.set(p.info.id, p.info.role);
      for (const [id, part] of this.pendingParts) if (part.messageID === p.info.id) {
        this.pendingParts.delete(id);
        if (p.info.role === 'assistant') this.onPart(part);
      }
    } else if (event.type === 'message.part.updated') {
      const role = this.messageRoles.get(p.part.messageID);
      if (role === 'assistant') this.onPart(p.part);
      else if (!role) this.pendingParts.set(p.part.id, p.part);
    } else if (event.type === 'session.idle' && s.busy) {
      if (this.continuing) this.waitForIdle?.();
      else this.finish();
    } else if (event.type === 'session.error' && s.busy && !this.continuing)
      this.fail(p.error || 'OpenCode session error', true);
  }

  onPart(part) {
    const s = this.session;
    if (part.type === 'text' && s.busy) {
      const old = this.parts.get(part.id) || '';
      const next = part.text || '';
      const delta = next.startsWith(old) ? next.slice(old.length) : '';
      if (delta) this.emit(s.id, 'assistant.delta', { text: delta });
      this.parts.set(part.id, next);
    } else if (part.type === 'tool') {
      const old = this.tools.get(part.callID);
      if (!old) this.emit(s.id, 'tool.started', { toolId: part.callID, name: part.tool, raw: part.state?.input });
      if (part.state?.status === 'completed' || part.state?.status === 'error')
        if (old !== part.state.status) this.emit(s.id, 'tool.completed', { toolId: part.callID,
          name: part.tool, raw: part.state.output || part.state.error, failed: part.state.status === 'error' });
      this.tools.set(part.callID, part.state?.status);
    }
  }

  finish() {
    this.session.busy = false;
    this.emit(this.session.id, this.cancelled ? 'turn.cancelled' : 'turn.completed', { inputIds: this.inputIds });
  }

  fail(error, known = false) {
    if (!this.session.busy) return;
    this.session.busy = false;
    this.emit(this.session.id, known ? 'error' : 'session.uncertain',
      { inputIds: this.inputIds, message: errorMessage(error) });
  }

  async interrupt() {
    this.cancelled = true;
    unwrap(await this.client.session.abort({ path: { id: this.session.nativeId }, query: { directory: this.session.cwd } }));
    return { status: 'accepted' };
  }

  async close() {
    await this.ready.catch(() => {});
    this.eventsAbort?.abort();
    this.server?.close();
    await this.events?.catch(() => {});
  }
}
