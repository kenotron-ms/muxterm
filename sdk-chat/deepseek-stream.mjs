import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { nativeConnectors, inputText, nativeImageBlocks, acceptInput, simpleTitle } from './native-common.mjs';
import { instanceDataHome } from './instance-xdg.mjs';

const patchDir = join(instanceDataHome(), 'muxterm', 'sdk-chat', 'deepseek-patches');

export class DeepSeekStream {
  constructor(session, emit) {
    this.session = session;
    this.emit = emit;
    this.turnSerial = 0;
    this.ready = this.initialize();
  }

  async initialize() {
    const s = this.session;
    const servers = nativeConnectors(s);
    mkdirSync(patchDir, { recursive: true, mode: 0o700 });
    this.patch = join(patchDir, `${s.id}.json`);
    const insert = servers.map(item => ({ id: `muxterm-mcp-${item.name}`,
      name: '@deepseek-ai/dsh-mcp-client', config: {
        serverName: item.name, transport: 'stdio', command: item.command, args: item.args,
        env: Object.fromEntries(item.env.map(value => [value.name, value.value])) } }));
    writeFileSync(this.patch, JSON.stringify(insert.length ? [{ insert }] : []), { mode: 0o600 });
    this.harness = new DeepSeekHarness({ profile: 'sdk', cwd: s.cwd, processCwd: s.cwd,
      patches: [this.patch], model: s.model || 'deepseek-v4-flash',
      ...(s.effort ? { reasoningEffort: s.effort } : {}) });
    await this.harness.start();
    this.native = this.harness.session(s.nativeId || undefined);
    s.nativeId = this.native.id;
    this.emit(s.id, 'session.started', { nativeId: s.nativeId, capabilities: {
      approvals: false, transcript_read: false, interrupt: true, live_input: false,
      attributed_service_input: false, native_steering: false } });
  }

  options() {
    const model = this.session.model || 'deepseek-v4-flash';
    return { model, effort: this.session.effort || '', models: [{ id: model, label: model,
      efforts: ['low', 'medium', 'high', 'max'], defaultEffort: '' }] };
  }

  async select(cmd) {
    if (this.session.busy) throw new Error('Finish the current DeepSeek turn before changing settings');
    if (cmd.model && cmd.model !== this.options().model) throw new Error('DeepSeek SDK fixes the model for a runtime; start a new chat for another route');
    if (cmd.effort && !this.options().models[0].efforts.includes(cmd.effort)) throw new Error('Unsupported DeepSeek effort');
    if ((cmd.effort || '') !== (this.session.effort || '')) {
      await this.harness.close();
      this.session.effort = cmd.effort || '';
      this.ready = this.initialize();
      await this.ready;
    }
    return this.options();
  }

  title(cmd) { return simpleTitle(cmd); }

  async send(input) {
    await this.ready;
    if (input.kind === 'steer') return this.steer(input);
    if (this.runtimeClosed) { this.ready = this.initialize(); await this.ready; this.runtimeClosed = false; }
    if (input.kind !== 'user' || this.session.busy) throw new Error('DeepSeek turn unavailable');
    const images = await nativeImageBlocks(input);
    const s = this.session;
    s.busy = true;
    this.inputIds = [];
    this.cancelled = false;
    this.emit(s.id, 'turn.started');
    return this.runInput(input, false, images);
  }

  async steer(input) {
    const s = this.session;
    if (!s.busy || this.steering) throw new Error('No DeepSeek turn available to steer');
    this.steering = true;
    ++this.turnSerial; // Invalidate notifications from the generation being stopped.
    this.acknowledge = null;
    try {
      await this.harness.close();
      this.runtimeClosed = true;
      this.ready = this.initialize();
      await this.ready;
      this.runtimeClosed = false;
      return await this.runInput(input, true, await nativeImageBlocks(input));
    } catch (error) {
      if (s.busy) {
        s.busy = false;
        this.emit(s.id, 'session.uncertain', { inputIds: this.inputIds, message: String(error) });
      }
      throw error;
    } finally { this.steering = false; }
  }

  async runInput(input, continued, images) {
    const s = this.session;
    const serial = ++this.turnSerial;
    this.seenText = '';
    this.failure = '';
    let acknowledge, rejectAdmission;
    const admission = new Promise((resolve, reject) => { acknowledge = resolve; rejectAdmission = reject; });
    this.acknowledge = () => {
      if (!this.acknowledge) return;
      this.acknowledge = null;
      this.inputIds.push(input.id);
      acceptInput(s, this.emit, input);
      if (continued) this.emit(s.id, 'turn.continued', { inputIds: this.inputIds });
      acknowledge();
    };
    const timeout = setTimeout(() => rejectAdmission(new Error('DeepSeek did not confirm input admission')), 20000);
    const prompt = images.length ? [{ type: 'text', text: inputText(input) },
      ...images.map(({ type, data, mimeType }) => ({ type, data, mimeType }))] : inputText(input);
    const run = this.native.run(prompt, { onNotification: note => {
      if (serial === this.turnSerial) this.onNotification(note);
    } });
    void run
      .then(result => {
        if (serial !== this.turnSerial || !s.busy) return;
        if (this.acknowledge) {
          this.acknowledge = null;
          const error = new Error('DeepSeek ended without an input receipt');
          rejectAdmission(error);
          s.busy = false;
          this.emit(s.id, 'error', { inputIds: this.inputIds, message: error.message });
          return;
        }
        const rest = result.finalResponse.startsWith(this.seenText)
          ? result.finalResponse.slice(this.seenText.length) : '';
        if (rest) this.emit(s.id, 'assistant.delta', { text: rest });
        s.busy = false;
        this.emit(s.id, this.cancelled ? 'turn.cancelled' : this.failure ? 'error' : 'turn.completed',
          { inputIds: this.inputIds, ...(this.failure ? { message: this.failure } : {}) });
      }).catch(error => {
        if (serial !== this.turnSerial) return;
        const beforeAdmission = !!this.acknowledge;
        this.acknowledge = null;
        if (beforeAdmission) rejectAdmission(error);
        if (!s.busy) return;
        s.busy = false;
        this.emit(s.id, beforeAdmission ? 'error' : 'session.uncertain',
          { inputIds: this.inputIds, message: String(error) });
      });
    try { await admission; }
    catch (error) {
      if (serial === this.turnSerial && s.busy) {
        s.busy = false;
        await this.harness.close();
        this.runtimeClosed = true;
        this.emit(s.id, 'error', { inputIds: this.inputIds, message: String(error) });
      }
      throw error;
    } finally { clearTimeout(timeout); }
    return { status: 'accepted', inputId: input.id };
  }

  onNotification(note) {
    if (note.method !== 'session.event' || note.params.sessionId !== this.session.nativeId) return;
    const event = note.params.event;
    if (event?.type === 'agent/inbox/spliced' && event.data?.inserted?.length) this.acknowledge?.();
    if (event?.type === 'turn/end' && event.data?.reason?.kind === 'error')
      this.failure = event.data.reason.error?.message || 'DeepSeek model request failed';
    if (event?.type === 'assistant/message') {
      const text = (event.data?.message?.content || []).filter(block => block.type === 'text')
        .map(block => block.text).join('');
      if (text) { this.seenText = text; this.emit(this.session.id, 'assistant.delta', { text }); }
    } else if (event?.type === 'tool/call') {
      this.emit(this.session.id, 'tool.started', { toolId: event.data?.callId,
        name: event.data?.name || 'Tool', raw: event.data?.arguments });
    } else if (event?.type === 'tool/result') {
      this.emit(this.session.id, 'tool.completed', { toolId: event.data?.message?.toolCallId,
        name: event.data?.message?.toolName || 'Tool', raw: event.data?.message?.content,
        failed: !!event.data?.message?.isError });
    }
  }

  async interrupt() {
    // The SDK has no cancel request. Closing this chat-owned runtime is its
    // documented cancellation boundary; a later resume starts a fresh one.
    this.cancelled = true;
    ++this.turnSerial;
    await this.harness.close();
    this.runtimeClosed = true;
    this.session.busy = false;
    this.emit(this.session.id, 'turn.cancelled', { inputIds: this.inputIds });
    return { status: 'accepted' };
  }

  async close() {
    await this.ready.catch(() => {});
    await this.harness?.close();
    if (this.patch) try { unlinkSync(this.patch); } catch { /* The origin file is already invalidated. */ }
  }
}
