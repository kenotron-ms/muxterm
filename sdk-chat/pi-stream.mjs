import { createAgentSession, createMcpExtension, createCodemodeExtension,
  createToolSearchExtension, DefaultResourceLoader, getAgentDir, SessionManager,
  SettingsManager } from '@earendil-works/pi-coding-agent';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nativeConnectors, inputText, nativeImageBlocks, acceptInput, simpleTitle } from './native-common.mjs';
import { instanceDataHome } from './instance-xdg.mjs';

export class PiStream {
  constructor(session, emit) {
    this.session = session;
    this.emit = emit;
    this.ready = this.initialize();
  }

  async initialize() {
    const s = this.session;
    const agentDir = getAgentDir();
    const sessionDir = join(instanceDataHome(), 'muxterm', 'sdk-chat', 'pi', s.id);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const settingsManager = SettingsManager.create(s.cwd, agentDir);
    const servers = nativeConnectors(s).map(item => ({ name: item.name, scope: 'extension', source: 'muxterm',
      config: { command: item.command, args: item.args, env: Object.fromEntries(item.env.map(v => [v.name, v.value])), exposure: 'deferred' } }));
    const loader = new DefaultResourceLoader({ cwd: s.cwd, agentDir, settingsManager,
      extensionFactories: [createCodemodeExtension(), createToolSearchExtension(),
        createMcpExtension({ loadConfig: () => ({ servers, errors: [], autoEnableCodemode: false }) })] });
    await loader.reload();
    const manager = s.nativeId ? SessionManager.open(s.nativeId, sessionDir, s.cwd)
      : SessionManager.create(s.cwd, sessionDir);
    const result = await createAgentSession({ cwd: s.cwd, resourceLoader: loader,
      sessionManager: manager, settingsManager });
    this.native = result.session;
    if (s.model) {
      const [provider, ...parts] = s.model.split('/');
      const model = this.native.modelRuntime.getModel(provider, parts.join('/'));
      if (!model) throw new Error(`Pi model unavailable: ${s.model}`);
      await this.native.setModel(model);
    }
    if (s.effort) this.native.setThinkingLevel(s.effort);
    await this.native.bindExtensions({});
    this.unsubscribe = this.native.subscribe(event => this.onEvent(event));
    s.nativeId = this.native.sessionFile;
    this.emit(s.id, 'session.started', { nativeId: s.nativeId, capabilities: {
      approvals: false, transcript_read: false, interrupt: true, live_input: false,
      attributed_service_input: false, native_steering: true } });
  }

  options() {
    const model = this.native.model;
    const selected = model ? `${model.provider}/${model.id}` : '';
    const models = this.native.modelRuntime.getAvailableSnapshot().slice(0, 200).map(item => ({
      id: `${item.provider}/${item.id}`, label: item.name || item.id,
      efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }));
    if (selected && !models.some(item => item.id === selected)) models.unshift({ id: selected,
      label: model.name || model.id, efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' });
    return { model: this.session.model || selected, effort: this.session.effort || this.native.thinkingLevel || '',
      models };
  }

  async select(cmd) {
    if (this.session.busy) throw new Error('Finish the current Pi turn before changing settings');
    if (cmd.model && cmd.model !== this.options().model) {
      const [provider, ...parts] = cmd.model.split('/');
      const model = this.native.modelRuntime.getModel(provider, parts.join('/'));
      if (!model) throw new Error('Unsupported Pi model');
      await this.native.setModel(model);
    }
    if (cmd.effort) this.native.setThinkingLevel(cmd.effort);
    this.session.model = cmd.model || this.options().model;
    this.session.effort = cmd.effort || this.options().effort;
    return this.options();
  }

  title(cmd) {
    if (cmd.mode === 'read') return { name: this.native.sessionManager.getSessionName() || '', source: 'native' };
    if (cmd.name) this.native.setSessionName(cmd.name);
    return simpleTitle(cmd);
  }

  async send(input) {
    await this.ready;
    if (input.kind === 'steer') {
      if (!this.session.busy) throw new Error('No active Pi turn to steer');
      this.native.steer(inputText(input));
      acceptInput(this.session, this.emit, input);
      this.inputIds.push(input.id);
      return { status: 'accepted', inputId: input.id };
    }
    if (input.kind !== 'user' || this.session.busy) throw new Error('Pi turn unavailable');
    const images = (await nativeImageBlocks(input)).map(({ type, data, mimeType }) => ({ type, data, mimeType }));
    this.session.busy = true;
    this.inputIds = [input.id];
    this.cancelled = false;
    this.failure = '';
    this.emit(this.session.id, 'turn.started');
    let accepted = false;
    let confirmAdmission, rejectAdmission;
    const admission = new Promise((resolve, reject) => { confirmAdmission = resolve; rejectAdmission = reject; });
    void this.native.prompt(inputText(input), { images, preflightResult: () => {
      accepted = true;
      acceptInput(this.session, this.emit, input);
      confirmAdmission();
    } }).then(() => {
      if (!accepted) rejectAdmission(new Error('Pi ended without accepting the input'));
      if (!this.session.busy) return;
      this.session.busy = false;
      this.emit(this.session.id, this.cancelled ? 'turn.cancelled' : this.failure ? 'error' : 'turn.completed',
        { inputIds: this.inputIds, ...(this.failure ? { message: this.failure } : {}) });
    }).catch(error => {
      if (!accepted) rejectAdmission(error);
      this.session.busy = false;
      this.emit(this.session.id, accepted ? 'session.uncertain' : 'error',
        { inputIds: accepted ? this.inputIds : [], message: String(error) });
    });
    await admission;
    return { status: 'accepted', inputId: input.id };
  }

  onEvent(event) {
    const id = this.session.id;
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta')
      this.emit(id, 'assistant.delta', { text: event.assistantMessageEvent.delta });
    if (event.type === 'message_end' && event.message?.role === 'assistant' &&
      event.message.stopReason === 'error') this.failure = event.message.errorMessage || 'Pi model request failed';
    if (event.type === 'tool_execution_start')
      this.emit(id, 'tool.started', { toolId: event.toolCallId, name: event.toolName, raw: event.args });
    if (event.type === 'tool_execution_end')
      this.emit(id, 'tool.completed', { toolId: event.toolCallId, name: event.toolName,
        raw: event.result, failed: event.isError });
  }

  async interrupt() {
    this.cancelled = true;
    await this.native.abort();
    return { status: 'accepted' };
  }

  async close() {
    await this.ready.catch(() => {});
    this.unsubscribe?.();
    this.native?.dispose();
  }
}
