import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const profiles = {
  pi: { command: 'pi-acp', args: [], env: 'MUXTERM_ACP_PI_COMMAND' },
  opencode: { command: 'opencode', args: ['acp'], env: 'MUXTERM_ACP_OPENCODE_COMMAND', mcp: true },
  deepseek: { command: 'dsh', args: ['--profile', 'acp'], env: 'MUXTERM_ACP_DEEPSEEK_COMMAND', mcp: true },
};

export const isACPHarness = harness => Object.hasOwn(profiles, harness);

export class ACPStream {
  constructor(session, emit, onProcessExit) {
    this.session = session;
    this.emit = emit;
    this.onProcessExit = onProcessExit;
    this.tools = new Map();
    this.busy = false;
    this.closed = false;
    this.loading = false;
    this.configOptions = [];
    this.modes = null;
    const profile = profiles[session.harness];
    if (!profile) throw new Error(`Unknown ACP harness: ${session.harness}`);
    const command = process.env[profile.env] || profile.command;
    this.profile = profile;
    this.process = spawn(command, profile.args, { cwd: session.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.stderr = '';
    this.process.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.process.on('error', error => this.onExit(error));
    this.process.on('exit', (code, signal) => this.onExit(new Error(`${session.harness} ACP process exited (${signal || code}): ${this.stderr}`)));
    const stream = acp.ndJsonStream(Writable.toWeb(this.process.stdin), Readable.toWeb(this.process.stdout));
    this.connection = new acp.ClientSideConnection(() => ({
      sessionUpdate: params => this.onUpdate(params),
      requestPermission: params => this.onPermission(params),
    }), stream);
    this.ready = this.initialize();
  }

  async initialize() {
    const result = await this.withExit(this.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }));
    if (result.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`Unsupported ACP version: ${result.protocolVersion}`);
    this.agentCapabilities = result.agentCapabilities || {};
    let session;
    const mcpBin = process.env.MUXTERM_CHAT_MCP_BIN;
    const mcpServers = this.profile.mcp && mcpBin ? [{ name: 'muxterm', command: mcpBin, args: ['mcp'],
      env: [...['XDG_RUNTIME_DIR', 'XDG_DATA_HOME'].filter(key => process.env[key]).map(name => ({ name, value: process.env[name] })),
        ...(this.session.originFile ? [{ name: 'MUXTERM_CHAT_ORIGIN_FILE', value: this.session.originFile }] : [])] }] : [];
    const params = { cwd: this.session.cwd, mcpServers,
      ...(this.session.sourceFolders.length && this.agentCapabilities.sessionCapabilities?.additionalDirectories
        ? { additionalDirectories: this.session.sourceFolders } : {}) };
    if (this.session.nativeId) {
      this.loading = true;
      try {
        if (this.agentCapabilities.sessionCapabilities?.resume) session = await this.withExit(this.connection.resumeSession({ ...params, sessionId: this.session.nativeId }));
        else if (this.agentCapabilities.loadSession) session = await this.withExit(this.connection.loadSession({ ...params, sessionId: this.session.nativeId }));
        else throw new Error(`${this.session.harness} does not advertise ACP session recovery`);
      } finally { this.loading = false; }
    } else {
      session = await this.withExit(this.connection.newSession(params));
      if (!session?.sessionId) throw new Error(`${this.session.harness} did not return an ACP session ID`);
      this.session.nativeId = session.sessionId;
    }
    this.configOptions = session.configOptions || [];
    this.modes = session.modes || null;
    this.startupInfo = session._meta?.piAcp?.startupInfo || '';
    this.startupBuffer = '';
    // A resumed ACP process starts with the agent's own defaults. Restore the
    // selections saved with this muxterm conversation before accepting input.
    await this.applySelection(this.session.model, this.session.effort);
    this.emit(this.session.id, 'session.started', { nativeId: this.session.nativeId, capabilities: this.capabilities() });
  }

  capabilities() {
    return { approvals: false, transcript_read: false, interrupt: true, live_input: false,
      attributed_service_input: false, native_steering: false };
  }

  withExit(promise) {
    return Promise.race([promise, this.exited.then(error => { throw error; })]);
  }

  onExit(error) {
    if (this.closed || this.exitError) return;
    this.exitError = error;
    this.resolveExit(error);
    if (this.busy) this.emit(this.session.id, 'session.uncertain', { message: String(error) });
    this.onProcessExit?.();
  }

  onPermission(params) {
    // Existing SDK chats run with approval=never. Honor only the agent's own
    // one-shot allow option; never manufacture an option ID or a lasting grant.
    if (params.sessionId !== this.session.nativeId || this.closed || this.session.cancelRequested)
      return { outcome: { outcome: 'cancelled' } };
    this.confirmAccepted?.();
    const option = params.options.find(item => item.kind === 'allow_once');
    return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
  }

  onUpdate(params) {
    if (params.sessionId !== this.session.nativeId || this.closed || this.loading) return;
    const update = params.update;
    // Pi sends its startup banner after session/new returns. It is not the
    // answer to the user's first prompt. ACP may split it across text chunks.
    let messageText = update.content?.text;
    if (this.startupInfo && update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const candidate = this.startupBuffer + (messageText || '');
      if (this.startupInfo.startsWith(candidate)) {
        this.startupBuffer = candidate;
        if (candidate === this.startupInfo) {
          this.startupInfo = '';
          this.startupBuffer = '';
        }
        return;
      }
      messageText = candidate.startsWith(this.startupInfo) ? candidate.slice(this.startupInfo.length) : candidate;
      this.startupInfo = '';
      this.startupBuffer = '';
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && !messageText) return;
    if (this.busy && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(update.sessionUpdate))
      this.turnActivity = true;
    if (this.busy && (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'usage_update'].includes(update.sessionUpdate)
      || (update.sessionUpdate === 'session_info_update' && update._meta?.piAcp?.running === true))) this.confirmAccepted?.();
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && messageText)
      this.emit(this.session.id, 'assistant.delta', { text: messageText });
    else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text' && update.content.text)
      this.emit(this.session.id, 'thinking.delta', { text: update.content.text });
    else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const id = update.toolCallId;
      const prior = this.tools.get(id);
      const name = update.title || update.name || prior?.name || 'Tool';
      const input = update.rawInput ?? prior?.input ?? update.content ?? null;
      if (!prior) {
        this.tools.set(id, { name, input });
        this.emit(this.session.id, 'tool.started', { toolId: id, name, raw: input });
      } else if (name !== prior.name || update.rawInput !== undefined) {
        this.tools.set(id, { name, input });
        this.emit(this.session.id, 'tool.started', { toolId: id, name, raw: input });
      }
      if (update.status === 'completed' || update.status === 'failed') {
        this.emit(this.session.id, 'tool.completed', { toolId: id, name, raw: update.rawOutput ?? update.content ?? null,
          failed: update.status === 'failed' });
        this.tools.delete(id);
      }
    } else if (update.sessionUpdate === 'plan') {
      const plan = (update.entries || []).map(entry => ({ step: entry.content, status: entry.status }));
      this.emit(this.session.id, 'tool.started', { toolId: 'acp-plan', name: 'update_plan', raw: { plan } });
      this.emit(this.session.id, 'tool.completed', { toolId: 'acp-plan', name: 'update_plan', raw: { plan } });
    } else if (update.sessionUpdate === 'config_option_update') this.configOptions = update.configOptions || [];
    else if (update.sessionUpdate === 'current_mode_update' && this.modes) this.modes.currentModeId = update.currentModeId;
  }

  async start() { await this.ready; }

  async send(input) {
    await this.ready;
    if (this.busy) throw new Error('Finish the current ACP turn before sending another message');
    if (input.kind !== 'user') throw new Error(`${this.session.harness} ACP does not support ${input.kind} input yet`);
    const prompt = [{ type: 'text', text: input.content || 'Please inspect the attached files.' }];
    for (const attachment of input.attachments || []) {
      // Local file references are usable by all three local harnesses. Images
      // use ACP image blocks only when the agent actually advertises them.
      const ext = attachment.name.split('.').at(-1)?.toLowerCase();
      if (attachment.kind === 'image' && this.agentCapabilities.promptCapabilities?.image && ['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        const { readFile } = await import('node:fs/promises');
        const data = await readFile(attachment.path);
        const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
        prompt.push({ type: 'image', data: data.toString('base64'), mimeType });
      } else prompt.push({ type: 'text', text: `\nAttached file: ${attachment.name} (${attachment.path})` });
    }
    this.busy = true;
    this.session.busy = true;
    this.session.cancelRequested = false;
    this.turnActivity = false;
    let accepted = false;
    let resolveEvidence, rejectEvidence;
    const evidence = new Promise((resolve, reject) => { resolveEvidence = resolve; rejectEvidence = reject; });
    this.confirmAccepted = () => {
      if (accepted) return;
      accepted = true;
      this.emit(this.session.id, 'input.accepted', { inputId: input.id, kind: input.kind, source: input.source,
        text: input.displayContent || input.content,
        attachments: (input.attachments || []).map(({ id, name, kind }) => ({ id, name, kind })) });
      resolveEvidence();
    };
    void this.withExit(this.connection.prompt({ sessionId: this.session.nativeId, prompt })).then(result => {
      this.confirmAccepted();
      if (result.stopReason === 'cancelled') this.emit(this.session.id, 'turn.cancelled', { inputIds: [input.id], message: result.stopReason });
      else if (result.stopReason === 'end_turn' && !this.turnActivity)
        this.emit(this.session.id, 'error', { inputIds: [input.id], message: `${this.session.harness} ended the ACP turn without an answer or tool activity. Check its provider credentials and agent logs.` });
      else if (result.stopReason === 'end_turn') this.emit(this.session.id, 'turn.completed', { inputIds: [input.id], message: result.stopReason });
      else this.emit(this.session.id, 'error', { inputIds: [input.id], message: `ACP turn stopped: ${result.stopReason}` });
    }).catch(error => {
      if (!accepted) rejectEvidence(error);
      else if (!this.exitError && !this.closed) this.emit(this.session.id, 'error', { message: String(error) });
    }).finally(() => {
      this.busy = false;
      this.session.busy = false;
      this.confirmAccepted = null;
    });
    await evidence;
    return { status: 'accepted', inputId: input.id };
  }

  async interrupt() {
    if (!this.busy) throw new Error('No active turn to stop');
    this.session.cancelRequested = true;
    await this.connection.cancel({ sessionId: this.session.nativeId });
    return { status: 'accepted' };
  }

  options() {
    const model = this.configOptions.find(item => item.type === 'select' && item.category === 'model');
    const effort = this.configOptions.find(item => item.type === 'select' && item.category === 'thought_level');
    const entries = model?.options?.flatMap(item => item.options || [item]) || [];
    const effortEntries = effort?.options?.flatMap(item => item.options || [item]) || [];
    return { provider: 'configured', model: model?.currentValue || '', effort: effort?.currentValue || '',
      models: entries.map(item => ({ id: item.value, label: item.name,
        efforts: effortEntries.map(value => value.value), defaultEffort: effort?.currentValue || '' })) };
  }

  async applySelection(model, effort) {
    if (this.busy) throw new Error('Finish the current turn before changing settings');
    for (const [category, value] of [['model', model], ['thought_level', effort]]) {
      const option = this.configOptions.find(item => item.type === 'select' && item.category === category);
      if (value && option && value !== option.currentValue) {
        const result = await this.withExit(this.connection.setSessionConfigOption({ sessionId: this.session.nativeId, configId: option.id, value }));
        this.configOptions = result.configOptions || [];
      } else if (value && !option) throw new Error(`ACP agent does not expose ${category} selection`);
    }
  }

  async select(cmd) {
    await this.ready;
    await this.applySelection(cmd.model, cmd.effort);
    return this.options();
  }

  title(cmd) {
    if (cmd.mode === 'read') return { name: '', source: '' };
    return { name: cmd.name || '', source: cmd.mode === 'manual' ? 'manual' : 'generated' };
  }

  close() {
    this.closed = true;
    if (!this.exitError) this.resolveExit(new Error('ACP session closed'));
    this.process.stdin.end();
    this.process.kill();
  }
}
