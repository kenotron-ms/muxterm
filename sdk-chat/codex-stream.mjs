import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';

const codexCLI = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
function toolDetails(item) {
  if (item.type === 'commandExecution') return {
    name: 'Command', input: { command: item.command, cwd: item.cwd },
    output: { exitCode: item.exitCode, status: item.status, output: item.aggregatedOutput },
  };
  if (item.type === 'mcpToolCall') return {
    name: item.server ? `${item.server}: ${item.tool}` : item.tool || 'MCP tool',
    input: item.arguments, output: { result: item.result, error: item.error, status: item.status },
  };
  return { name: item.type, input: item, output: item };
}

// The Codex SDK's runStreamed() uses `codex exec --experimental-json`, which
// reports completed agent messages but no text deltas. The app-server protocol
// exposes item/agentMessage/delta while preserving the same native thread ID.
export class CodexStream {
  constructor(session, emit) {
    this.session = session;
    this.emit = emit;
    this.pending = new Map();
    this.nextId = 0;
    this.textByItem = new Map();
    this.reasoningByItem = new Map();
    this.phaseByItem = new Map();
    this.inputIds = [];
    this.cancelRequested = false;
    this.childThreads = new Map();
    const muxterm = process.env.MUXTERM_CHAT_MCP_BIN;
    const mcpConfig = muxterm ? ['-c', `mcp_servers.muxterm.command=${JSON.stringify(muxterm)}`,
      '-c', 'mcp_servers.muxterm.args=["mcp"]'] : [];
    for (const key of ['XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'MUXTERM_COS_SESSION_ID']) {
      if (process.env[key]) mcpConfig.push('-c', `mcp_servers.muxterm.env.${key}=${JSON.stringify(process.env[key])}`);
    }
    this.process = spawn(process.execPath, [codexCLI, 'app-server', '--stdio', '-c', 'model_reasoning_summary="detailed"', ...mcpConfig], {
      cwd: session.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.process.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4000); });
    readline.createInterface({ input: this.process.stdout }).on('line', line => this.onLine(line));
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code, signal) => this.fail(new Error(
      `Codex app-server exited (${signal || code}): ${this.stderr}`)));
    this.ready = this.initialize();
  }

  request(method, params) {
    if (this.process.exitCode !== null || this.process.stdin.destroyed)
      return Promise.reject(new Error('Codex app-server is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'muxterm', title: 'muxterm SDK chat', version: '1' }, capabilities: { experimentalApi: true } });
    this.process.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const options = { cwd: this.session.cwd, additionalDirectories: this.session.sourceFolders, approvalPolicy: 'never', sandbox: this.sandboxName() };
    const result = await this.request(this.session.nativeId ? 'thread/resume' : 'thread/start',
      this.session.nativeId ? { threadId: this.session.nativeId, ...options } : options);
    this.session.nativeId = result.thread.id;
    this.session.model ||= result.thread.model || '';
    this.session.effort ||= result.thread.reasoningEffort || '';
    this.emit(this.session.id, 'session.started', { nativeId: result.thread.id,
      capabilities: { approvals: false, transcript_read: false, interrupt: true,
        live_input: false, attributed_service_input: false, native_steering: true } });
  }

  async options() {
    await this.ready;
    const models = [];
    let cursor = null;
    do {
      const page = await this.request('model/list', { cursor, includeHidden: false, limit: 100 });
      for (const model of page.data || []) if (!model.hidden) models.push({
        id: model.model || model.id, label: model.displayName || model.model || model.id,
        efforts: (model.supportedReasoningEfforts || []).map(option => option.reasoningEffort),
        defaultEffort: model.defaultReasoningEffort || '',
      });
      cursor = page.nextCursor;
    } while (cursor);
    return { model: this.session.model || '', effort: this.session.effort || '', models };
  }

  sandboxName() {
    return this.session.permission === 'read-only' ? 'read-only'
      : this.session.permission === 'workspace-write' ? 'workspace-write' : 'danger-full-access';
  }

  sandboxPolicy() {
    return this.session.permission === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : this.session.permission === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [this.session.cwd, ...this.session.sourceFolders], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : { type: 'dangerFullAccess' };
  }

  async run(input) {
    await this.ready;
    this.session.busy = true;
    this.inputId = input.id;
    this.inputIds = [input.id];
    this.cancelRequested = false;
    this.textByItem.clear();
    this.reasoningByItem.clear();
    this.phaseByItem.clear();
    try {
      const attachments = input.attachments || [];
      const manifest = attachments.map(a => `- ${JSON.stringify(a.name)} (${a.kind}): ${JSON.stringify(a.path)}`).join('\n');
      const prompt = attachments.length
        ? `${input.content || 'Please inspect the attached files.'}\n\nAttached files on the local filesystem (absolute paths):\n${manifest}\nRead the files at these paths before answering. Inspect each image's contents.`
        : input.content;
      const turnInput = [{ type: 'text', text: prompt, text_elements: [] }];
      for (const item of attachments) if (item.kind === 'image') turnInput.push({ type: 'localImage', path: item.path });
      const model = input.model || this.session.model;
      const result = await this.request('turn/start', { threadId: this.session.nativeId,
        summary: 'detailed',
        approvalPolicy: 'never', sandboxPolicy: this.sandboxPolicy(),
        ...(model ? { collaborationMode: { mode: this.session.mode === 'plan' ? 'plan' : 'default', settings: { model, reasoning_effort: input.effort || this.session.effort || null, developer_instructions: null } } } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        input: turnInput });
      this.turnId = result.turn.id;
    } catch (error) {
      this.session.busy = false;
      throw error;
    }
  }

  async steer(input) {
    await this.ready;
    if (!this.turnId || !this.session.busy) throw new Error('No active Codex turn to steer');
    // turn/steer waits for the current model request to finish. Stop that
    // request and continue on the same thread while retaining streamed text.
    const turnId = this.turnId;
    const ended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.steeringResolve = null; reject(new Error('Codex turn did not stop for steering')); }, 15000);
      this.steeringResolve = () => { clearTimeout(timer); resolve(); };
    });
    try {
      await this.request('turn/interrupt', { threadId: this.session.nativeId, turnId });
      await ended;
      await this.run(input);
      this.emit(this.session.id, 'input.accepted', { inputId: input.id, kind: 'steer', source: input.source, text: input.content });
    } catch (error) {
      this.steeringResolve?.();
      this.steeringResolve = null;
      throw error;
    }
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    const { method, params: p } = message;
    if (!p) return;
    const childId = this.childThreads.has(p.threadId) ? p.threadId : null;
    if (childId) {
      if (method === 'item/agentMessage/delta' && p.delta)
        this.emit(this.session.id, 'delegate.message', { childSessionId: childId, text: p.delta });
      else if (method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.text)
        this.emit(this.session.id, 'delegate.message', { childSessionId: childId, text: p.item.text, complete: true });
      else if (method === 'item/started' && p.item?.type === 'subAgentActivity' && p.item.agentThreadId) {
        if (p.item.kind === 'started') {
          this.childThreads.set(p.item.agentThreadId, p.item.agentPath || 'Agent');
          this.emit(this.session.id, 'delegate.spawned', { childSessionId: p.item.agentThreadId,
            parentSessionId: childId, agent: p.item.agentPath || 'Agent', toolId: p.item.id });
        } else if (p.item.kind === 'completed') this.emit(this.session.id, 'delegate.completed', {
          childSessionId: p.item.agentThreadId, parentSessionId: childId,
          agent: p.item.agentPath || this.childThreads.get(p.item.agentThreadId) || 'Agent', toolId: p.item.id });
      } else if ((method === 'item/started' || method === 'item/completed') && p.item?.id && !['agentMessage', 'reasoning'].includes(p.item.type)) {
        this.emit(this.session.id, 'delegate.step', { childSessionId: childId, toolId: p.item.id,
          name: p.item.type || 'Work', kind: method === 'item/started' ? 'started' : 'completed', raw: p.item });
      }
      return;
    }
    if (p.threadId !== this.session.nativeId) return;
    if (method === 'item/started' && p.item?.type === 'subAgentActivity' && p.item.kind === 'started' && p.item.agentThreadId) {
      this.childThreads.set(p.item.agentThreadId, p.item.agentPath || 'Agent');
      this.emit(this.session.id, 'delegate.spawned', { childSessionId: p.item.agentThreadId,
        parentSessionId: this.session.id, agent: p.item.agentPath || 'Agent', toolId: p.item.id });
    } else if (method === 'item/started' && p.item?.type === 'subAgentActivity' && p.item.kind === 'completed' && p.item.agentThreadId) {
      this.emit(this.session.id, 'delegate.completed', { childSessionId: p.item.agentThreadId,
        parentSessionId: this.session.id, agent: p.item.agentPath || this.childThreads.get(p.item.agentThreadId) || 'Agent', toolId: p.item.id });
    }
    if (method === 'item/started' && p.item?.type === 'agentMessage') {
      this.phaseByItem.set(p.item.id, p.item.phase);
    } else if (method === 'item/agentMessage/delta') {
      this.textByItem.set(p.itemId, (this.textByItem.get(p.itemId) || '') + p.delta);
      if (p.delta) this.emit(this.session.id, this.phaseByItem.get(p.itemId) === 'commentary' ? 'thinking.delta' : 'assistant.delta', { text: p.delta });
    } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const delta = p.delta || '';
      this.reasoningByItem.set(p.itemId, (this.reasoningByItem.get(p.itemId) || '') + delta);
      if (delta) this.emit(this.session.id, 'thinking.delta', { text: delta });
    } else if (method === 'item/completed' && p.item?.type === 'reasoning') {
      const full = (p.item.summary || []).map(part => typeof part === 'string' ? part : part.text || '').join('')
        || (p.item.content || []).map(part => typeof part === 'string' ? part : part.text || '').join('')
        || p.item.text || '';
      const sent = this.reasoningByItem.get(p.item.id) || '';
      const rest = full.startsWith(sent) ? full.slice(sent.length) : (sent ? '' : full);
      if (rest) this.emit(this.session.id, 'thinking.delta', { text: rest });
    } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
      // Keep compatibility with an older app-server that only sends a final item.
      const sent = this.textByItem.get(p.item.id) || '';
      const full = p.item.text || '';
      const rest = full.startsWith(sent) ? full.slice(sent.length) : full;
      if (rest) this.emit(this.session.id, p.item.phase === 'commentary' ? 'thinking.delta' : 'assistant.delta', { text: rest });
    } else if (method === 'item/started' && p.item?.type !== 'agentMessage' && p.item?.type !== 'reasoning' && p.item?.type !== 'userMessage') {
      const tool = toolDetails(p.item);
      this.emit(this.session.id, 'tool.started', { name: tool.name, toolId: p.item.id, raw: tool.input });
    } else if (method === 'item/completed' && p.item?.type !== 'agentMessage' && p.item?.type !== 'reasoning' && p.item?.type !== 'userMessage') {
      const tool = toolDetails(p.item);
      this.emit(this.session.id, 'tool.completed', { name: tool.name, toolId: p.item.id,
        raw: tool.output, failed: p.item.status === 'failed' || !!p.item.error });
    } else if (method === 'turn/completed') {
      this.turnId = null;
      if (this.steeringResolve) {
        const resolve = this.steeringResolve;
        this.steeringResolve = null;
        resolve();
        return;
      }
      this.session.busy = false;
      this.emit(this.session.id, this.cancelRequested || p.turn.status === 'interrupted' ? 'turn.cancelled'
        : p.turn.status === 'completed' ? 'turn.completed' : 'error',
        { inputIds: this.inputIds, message: p.turn.error?.message || p.turn.status });
    }
  }

  async interrupt() {
    if (this.turnId) {
      await this.request('turn/interrupt', { threadId: this.session.nativeId, turnId: this.turnId });
      this.cancelRequested = true;
    }
  }

  async title(mode, name, previousName) {
    await this.ready;
    const current = await this.request('thread/read', { threadId: this.session.nativeId, includeTurns: false });
    const existing = current.thread?.name || '';
    if (mode === 'read') return { name: existing, source: existing ? 'manual' : '' };
    if (mode === 'generated' && existing && existing !== previousName)
      return { name: existing, source: 'manual' };
    await this.request('thread/name/set', { threadId: this.session.nativeId, name });
    return { name, source: mode === 'manual' ? 'manual' : 'generated' };
  }

  close() { this.process.kill('SIGTERM'); }

  fail(error) {
    this.steeringResolve?.();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.session.busy) {
      this.session.busy = false;
      this.emit(this.session.id, 'error', { message: String(error) });
    }
  }
}
