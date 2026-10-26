import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';

const profiles = {
  pi: { command: 'pi-acp', args: [], env: 'MUXTERM_ACP_PI_COMMAND' },
  opencode: { command: 'opencode', args: ['acp'], env: 'MUXTERM_ACP_OPENCODE_COMMAND', mcp: true },
  deepseek: { command: 'dsh', args: ['--profile', 'acp'], env: 'MUXTERM_ACP_DEEPSEEK_COMMAND', mcp: true },
  gemini: { command: 'gemini', args: ['--acp'], env: 'MUXTERM_ACP_GEMINI_COMMAND', mcp: true },
};

export const isACPHarness = harness => Object.hasOwn(profiles, harness);

function geminiEnvironment() {
  const env = { ...process.env };
  const dataHome = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  let mode = 'google';
  try { mode = readFileSync(join(dataHome, 'muxterm', 'gemini-auth-mode'), 'utf8').trim(); } catch { /* Google sign-in is the default. */ }
  if (mode !== 'api-key') {
    // A key intended for another CLI session must not override Google sign-in.
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    return env;
  }
  let key = env.GEMINI_API_KEY?.trim();
  if (!key) {
    for (const name of ['keys.env', 'key.env']) {
      try {
        const data = readFileSync(join(homedir(), '.amplifier', name), 'utf8').slice(0, 65536);
        const line = data.split('\n').find(line => /^\s*(?:export\s+)?GEMINI_API_KEY\s*=/.test(line));
        if (line) { key = line.replace(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2'); break; }
      } catch { /* Try the next standard key file. */ }
    }
  }
  if (!key) throw new Error('GEMINI_API_KEY is not configured');
  const root = join(dataHome, 'muxterm', 'gemini-api-key');
  mkdirSync(join(root, '.gemini'), { recursive: true, mode: 0o700 });
  const settings = join(root, '.gemini', 'settings.json');
  try { readFileSync(settings); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { writeFileSync(settings, '{"security":{"auth":{"selectedType":"gemini-api-key"}}}\n', { flag: 'wx', mode: 0o600 }); }
    catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
  }
  env.GEMINI_CLI_HOME = root;
  env.GEMINI_API_KEY = key;
  delete env.GOOGLE_API_KEY;
  return env;
}

export class ACPStream {
  constructor(session, emit, onProcessExit) {
    this.session = session;
    this.emit = emit;
    this.onProcessExit = onProcessExit;
    this.tools = new Map();
    this.busy = false;
    this.preparingPrompt = false;
    this.closed = false;
    this.loading = false;
    this.configOptions = [];
    this.modes = null;
    this.steeringExtension = false;
    this.steerPending = false;
    this.interruptForSteer = false;
    this.stopDuringSteer = false;
    this.turnInputIds = [];
    this.continuedInputIds = [];
    const profile = profiles[session.harness];
    if (!profile) throw new Error(`Unknown ACP harness: ${session.harness}`);
    const command = process.env[profile.env] || profile.command;
    this.profile = profile;
    this.process = spawn(command, profile.args, { cwd: session.cwd, env: session.harness === 'gemini' ? geminiEnvironment() : process.env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    this.steeringExtension = result._meta?.steering?.supported === true;
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
        // Gemini CLI advertises the legacy load capability and uses its raw
        // session/load RPC here; revisit this when its ACP shape changes.
        else if (this.agentCapabilities.loadSession) session = await this.withExit(this.session.harness === 'gemini'
          ? this.connection.request('session/load', { ...params, sessionId: this.session.nativeId })
          : this.connection.loadSession({ ...params, sessionId: this.session.nativeId }));
        else throw new Error(`${this.session.harness} does not advertise ACP session recovery`);
      } finally { this.loading = false; }
    } else {
      session = await this.withExit(this.connection.newSession(params));
      if (!session?.sessionId) throw new Error(`${this.session.harness} did not return an ACP session ID`);
      this.session.nativeId = session.sessionId;
    }
    this.configOptions = session.configOptions || [];
    this.modes = session.modes || null;
    // Gemini CLI still publishes its model selector in the older ACP `models`
    // response field. Remove this shim when Gemini publishes configOptions.
    this.legacyModels = this.session.harness === 'gemini' ? session.models || null : null;
    this.startupInfo = session._meta?.piAcp?.startupInfo || '';
    this.startupBuffer = '';
    // A resumed ACP process starts with the agent's own defaults. Restore the
    // selections saved with this muxterm conversation before accepting input.
    await this.applySelection(this.session.model, this.session.effort);
    this.emit(this.session.id, 'session.started', { nativeId: this.session.nativeId, capabilities: this.capabilities() });
  }

  capabilities() {
    return { approvals: false, transcript_read: false, interrupt: true, live_input: false,
      attributed_service_input: false, native_steering: this.steeringExtension };
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

  async promptBlocks(input) {
    const prompt = [{ type: 'text', text: input.content || 'Please inspect the attached files.' }];
    for (const attachment of input.attachments || []) {
      // The upload store sniffs image bytes; filenames do not establish MIME type.
      const imageType = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.contentType)
        ? attachment.contentType : '';
      if (attachment.kind === 'image' && this.agentCapabilities.promptCapabilities?.image && imageType) {
        const { readFile } = await import('node:fs/promises');
        const data = await readFile(attachment.path);
        prompt.push({ type: 'image', data: data.toString('base64'), mimeType: imageType });
      } else prompt.push({ type: 'text', text: `\nAttached file: ${attachment.name} (${attachment.path})` });
    }
    return prompt;
  }

  emitAccepted(input) {
    this.emit(this.session.id, 'input.accepted', { inputId: input.id, kind: input.kind, source: input.source,
      text: input.displayContent || input.content,
      attachments: (input.attachments || []).map(({ id, name, kind }) => ({ id, name, kind })) });
  }

  async send(input) {
    await this.ready;
    if (input.kind !== 'user' && input.kind !== 'steer')
      throw new Error(`${this.session.harness} ACP does not support ${input.kind} input`);
    if (input.kind === 'steer') {
      if (!this.busy) throw new Error('No active ACP turn to steer');
      if (this.steerPending) throw new Error('A steer is already being delivered');
      this.steerPending = true;
      this.stopDuringSteer = false;
      try {
        const prompt = await this.promptBlocks(input);
        if (this.steeringExtension) {
          const result = await this.withExit(this.connection.request('_session/steering', {
            sessionId: this.session.nativeId, prompt, _meta: { steering: { idleBehavior: 'promptRequired' } },
          }));
          if (result.outcome === 'injected') {
            if (this.stopDuringSteer) throw new Error('Turn stopped before the steer was delivered');
            this.turnInputIds.push(input.id);
            this.emitAccepted(input);
            this.emit(this.session.id, 'turn.continued');
            return { status: 'accepted', inputId: input.id };
          }
          if (result.outcome !== 'promptRequired') throw new Error(`Unsupported ACP steering outcome: ${result.outcome}`);
          this.interruptForSteer = true;
          await this.turnPromise;
          this.interruptForSteer = false;
        } else {
          // ACP v1 has no standard mid-turn injection. Stop the active prompt,
          // keep its partial output, and immediately continue with the steer.
          this.interruptForSteer = true;
          this.session.cancelRequested = true;
          await this.connection.cancel({ sessionId: this.session.nativeId });
          await this.turnPromise;
          // The next prompt is a normal turn; clear this before it can resolve.
          this.interruptForSteer = false;
        }
        if (this.stopDuringSteer) throw new Error('Turn stopped before the steer was delivered');
        if (this.exitError || this.closed) throw new Error('ACP session ended before the steer was delivered');
        return await this.startPrompt(input, prompt);
      } finally {
        this.steerPending = false;
        this.interruptForSteer = false;
        // Keep a concurrent user stop pending until its active turn settles.
        if (!this.stopDuringSteer || !this.busy) this.session.cancelRequested = false;
        this.stopDuringSteer = false;
      }
    }
    if (this.busy || this.preparingPrompt || this.steerPending)
      throw new Error('Finish the current ACP turn before sending another message');
    this.preparingPrompt = true;
    try {
      return await this.startPrompt(input, await this.promptBlocks(input));
    } finally {
      this.preparingPrompt = false;
    }
  }

  async startPrompt(input, prompt) {
    this.busy = true;
    this.session.busy = true;
    this.session.cancelRequested = false;
    this.turnActivity = false;
    this.turnInputIds = [...this.continuedInputIds, input.id];
    this.continuedInputIds = [];
    let accepted = false;
    let resolveEvidence, rejectEvidence;
    const evidence = new Promise((resolve, reject) => { resolveEvidence = resolve; rejectEvidence = reject; });
    this.confirmAccepted = () => {
      if (accepted) return;
      accepted = true;
      this.emitAccepted(input);
      resolveEvidence();
    };
    this.turnPromise = this.withExit(this.connection.prompt({ sessionId: this.session.nativeId, prompt })).then(result => {
      this.confirmAccepted();
      if (this.interruptForSteer && !this.stopDuringSteer) {
        this.continuedInputIds = this.turnInputIds;
        this.emit(this.session.id, 'turn.continued');
      } else if (result.stopReason === 'cancelled') this.emit(this.session.id, 'turn.cancelled', { inputIds: this.turnInputIds, message: result.stopReason });
      else if (result.stopReason === 'end_turn' && !this.turnActivity)
        this.emit(this.session.id, 'error', { inputIds: this.turnInputIds, message: `${this.session.harness} ended the ACP turn without an answer or tool activity. Check its provider credentials and agent logs.` });
      else if (result.stopReason === 'end_turn') this.emit(this.session.id, 'turn.completed', { inputIds: this.turnInputIds, message: result.stopReason });
      else this.emit(this.session.id, 'error', { inputIds: this.turnInputIds, message: `ACP turn stopped: ${result.stopReason}` });
    }).catch(error => {
      if (!accepted) rejectEvidence(error);
      else if (this.interruptForSteer && this.stopDuringSteer && !this.exitError && !this.closed)
        this.emit(this.session.id, 'turn.cancelled', { inputIds: this.turnInputIds, message: 'cancelled' });
      else if (this.interruptForSteer && !this.exitError && !this.closed) {
        this.continuedInputIds = this.turnInputIds;
        this.emit(this.session.id, 'turn.continued');
      }
      else if (!this.exitError && !this.closed) this.emit(this.session.id, 'error', { message: String(error) });
    }).finally(() => {
      this.busy = false;
      this.session.busy = false;
      this.session.cancelRequested = false;
      this.confirmAccepted = null;
    });
    await evidence;
    return { status: 'accepted', inputId: input.id };
  }

  async interrupt() {
    if (!this.busy) throw new Error('No active turn to stop');
    if (this.steerPending) this.stopDuringSteer = true;
    this.session.cancelRequested = true;
    await this.connection.cancel({ sessionId: this.session.nativeId });
    return { status: 'accepted' };
  }

  options() {
    const model = this.configOptions.find(item => item.type === 'select' && item.category === 'model');
    const effort = this.configOptions.find(item => item.type === 'select' && item.category === 'thought_level');
    const entries = model?.options?.flatMap(item => item.options || [item]) || [];
    const effortEntries = effort?.options?.flatMap(item => item.options || [item]) || [];
    if (!model && this.legacyModels) return { provider: 'configured', model: this.legacyModels.currentModelId || '', effort: '',
      models: (this.legacyModels.availableModels || []).map(item => ({ id: item.modelId, label: item.name || item.modelId,
        efforts: [], defaultEffort: '' })) };
    return { provider: 'configured', model: model?.currentValue || '', effort: effort?.currentValue || '',
      models: entries.map(item => ({ id: item.value, label: item.name,
        efforts: effortEntries.map(value => value.value), defaultEffort: effort?.currentValue || '' })) };
  }

  async applySelection(model, effort) {
    if (this.busy) throw new Error('Finish the current turn before changing settings');
    if (model && this.legacyModels && !this.configOptions.some(item => item.type === 'select' && item.category === 'model')) {
      if (!(this.legacyModels.availableModels || []).some(item => item.modelId === model)) throw new Error('Unsupported Gemini model');
      if (model !== this.legacyModels.currentModelId) {
        await this.withExit(this.connection.request('session/set_model', { sessionId: this.session.nativeId, modelId: model }));
        this.legacyModels.currentModelId = model;
      }
      model = '';
    }
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
