import { homedir } from 'node:os';
import { join } from 'node:path';
import { CopilotClient } from '@github/copilot-sdk';
import { connectorServers } from './acp-stream.mjs';
import { acknowledgeInboxReminder, readInboxReminder } from './inbox-reminder.mjs';

const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'muxterm', 'sdk-chat');

export class CopilotStream {
  constructor(session, emit) {
    this.session = session;
    this.emit = emit;
    this.seenText = new Map();
    this.inputIds = [];
    this.client = new CopilotClient({ baseDirectory: join(dataDir, 'copilot'), workingDirectory: session.cwd });
    this.ready = this.initialize();
  }

  async initialize() {
    await this.client.start();
    const bin = process.env.MUXTERM_CHAT_MCP_BIN;
    const mcpServers = Object.fromEntries(connectorServers(bin, this.session.originFile).map(server =>
      [server.name, { type: 'stdio', command: server.command, args: server.args,
        env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }]));
    const config = { model: this.session.model || 'auto', workingDirectory: this.session.cwd,
      streaming: true, mcpServers,
      onPermissionRequest: (_request, invocation) => invocation?.managedSettingsEnabled
        ? { kind: 'user-not-available' } : { kind: 'approve-once' } };
    if (this.session.effort) config.reasoningEffort = this.session.effort;
    this.native = this.session.nativeId
      ? await this.client.resumeSession(this.session.nativeId, config)
      : await this.client.createSession({ sessionId: this.session.id, ...config });
    this.session.nativeId = this.native.sessionId;
    this.unsubscribe = this.native.on(event => void this.onEvent(event));
    this.emit(this.session.id, 'session.started', { nativeId: this.session.nativeId,
      capabilities: { approvals: false, transcript_read: false, interrupt: true, live_input: false,
        attributed_service_input: false, native_steering: true } });
  }

  async options() {
    await this.ready;
    const models = (await this.client.listModels()).map(item => ({ id: item.id, label: item.name || item.id,
      efforts: item.supportedReasoningEfforts || [], defaultEffort: item.defaultReasoningEffort || '' }));
    if (!models.some(item => item.id === 'auto')) models.unshift({ id: 'auto', label: 'Auto', efforts: [], defaultEffort: '' });
    return { provider: 'github', model: this.session.model || 'auto', effort: this.session.effort || '', models };
  }

  async select(cmd) {
    await this.ready;
    if (this.session.busy) throw new Error('Finish the current turn before changing settings');
    const options = await this.options();
    const model = cmd.model || options.model;
    const selected = options.models.find(item => item.id === model);
    if (!selected) throw new Error('Unsupported Copilot model');
    const effort = cmd.effort || '';
    if (effort && !selected.efforts.includes(effort)) throw new Error('Unsupported effort for this model');
    await this.native.setModel(model, effort ? { reasoningEffort: effort } : undefined);
    this.session.model = model;
    this.session.effort = effort;
    return { ...options, model, effort };
  }

  title(cmd) {
    if (cmd.mode === 'read') return { name: '', source: '' };
    return { name: cmd.name || '', source: cmd.mode === 'manual' ? 'manual' : 'generated' };
  }

  async send(input) {
    await this.ready;
    if (input.kind === 'steer') return this.steer(input);
    if (this.session.busy) throw new Error('Finish the current Copilot turn before sending another message');
    if (input.kind !== 'user') throw new Error(`Copilot does not support ${input.kind} input`);
    this.session.busy = true;
    this.session.cancelRequested = false;
    this.admitting = true;
    this.pendingIdle = null;
    try {
      try { this.reminder = await readInboxReminder(this.session.id, this.session.originFile); }
      catch (error) { console.error(`Copilot inbox reminder: ${error}`); this.reminder = null; }
      const prompt = [this.reminder?.text, input.content || 'Please inspect the attached files.'].filter(Boolean).join('\n\n');
      await this.native.send({ prompt, attachments: (input.attachments || []).map(item => ({ type: 'file', path: item.path })) });
      this.accept(input);
      this.admitting = false;
      if (this.pendingIdle) void this.finishTurn(this.pendingIdle);
      return { status: 'accepted', inputId: input.id };
    } catch (error) { this.session.busy = false; this.reminder = null; this.admitting = false; this.pendingIdle = null; throw error; }
  }

  accept(input) {
    this.inputIds.push(input.id);
    this.emit(this.session.id, 'input.accepted', { inputId: input.id, kind: input.kind,
      source: input.source, text: input.displayContent || input.content,
      attachments: (input.attachments || []).map(({ id, name, kind }) => ({ id, name, kind })) });
  }

  async steer(input) {
    if (!this.session.busy) throw new Error('No active Copilot turn to steer');
    if (this.admitting) throw new Error('Copilot is still accepting the previous message; retry steering shortly');
    this.admitting = true;
    try {
      // The SDK injects an immediate message before the next model request.
      // If the active turn has already ended, its runtime queues the message.
      await this.native.send({ prompt: input.content, mode: 'immediate' });
      this.accept(input);
      this.admitting = false;
      if (this.pendingIdle) void this.finishTurn(this.pendingIdle);
      return { status: 'accepted', inputId: input.id };
    } catch (error) {
      this.admitting = false;
      if (this.pendingIdle) void this.finishTurn(this.pendingIdle);
      throw error;
    }
  }

  async finishTurn(data) {
    if (!this.session.busy) return;
    const inputIds = this.inputIds;
    this.session.busy = false;
    if (this.reminder && !data.aborted) try { await acknowledgeInboxReminder(this.session.id, this.reminder.cursor, this.session.originFile); }
    catch (error) { console.error(`Copilot inbox acknowledgement: ${error}`); }
    this.reminder = null;
    this.inputIds = [];
    this.pendingIdle = null;
    this.emit(this.session.id, data.aborted || this.session.cancelRequested ? 'turn.cancelled' : 'turn.completed', { inputIds });
  }

  async onEvent(event) {
    const data = event.data || {};
    const id = this.session.id;
    if (event.type === 'assistant.message_delta') {
      this.seenText.set(data.messageId, (this.seenText.get(data.messageId) || '') + (data.deltaContent || ''));
      if (data.deltaContent) this.emit(id, 'assistant.delta', { text: data.deltaContent });
    } else if (event.type === 'assistant.message') {
      const seen = this.seenText.get(data.messageId) || '';
      const rest = (data.content || '').startsWith(seen) ? (data.content || '').slice(seen.length) : (seen ? '' : data.content || '');
      if (rest) this.emit(id, 'assistant.delta', { text: rest });
      this.seenText.delete(data.messageId);
    } else if (event.type === 'tool.execution_start') {
      this.emit(id, 'tool.started', { toolId: data.toolCallId, name: data.toolTitle || data.toolName || 'Tool', raw: data.arguments });
    } else if (event.type === 'tool.execution_complete') {
      this.emit(id, 'tool.completed', { toolId: data.toolCallId, name: data.toolName || 'Tool', raw: data.result, failed: data.success === false });
    } else if (event.type === 'session.idle' && this.session.busy) {
      if (this.admitting) this.pendingIdle = data;
      else await this.finishTurn(data);
    } else if (event.type === 'session.error') {
      this.session.busy = false;
      this.emit(id, 'error', { inputIds: this.inputIds, message: data.message || 'Copilot session error' });
      this.inputIds = [];
    }
  }

  async interrupt() { await this.ready; this.session.cancelRequested = true; await this.native.abort(); return { status: 'accepted' }; }
  async close() { this.unsubscribe?.(); await this.native?.disconnect(); await this.client.stop(); }
}
