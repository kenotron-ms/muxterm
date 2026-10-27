import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { agentCommand } from './agent-command.mjs';
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
  constructor(session, emit, catalogOnly = false) {
    this.session = session;
    this.emit = emit;
    this.pending = new Map();
    this.userInputRequests = new Map();
    this.nextId = 0;
    this.textByItem = new Map();
    this.phaseByItem = new Map();
    this.inputIds = [];
    this.cancelRequested = false;
    this.childThreads = new Map();
    this.goalSequence = 0;
    this.catalogOnly = catalogOnly;
    const muxterm = process.env.MUXTERM_CHAT_MCP_BIN;
    const mcpConfig = muxterm ? ['-c', `mcp_servers.muxterm.command=${JSON.stringify(muxterm)}`,
      '-c', 'mcp_servers.muxterm.args=["mcp"]'] : [];
    if (muxterm && session.originFile) mcpConfig.push('-c', `mcp_servers.muxterm.env.MUXTERM_CHAT_ORIGIN_FILE=${JSON.stringify(session.originFile)}`);
    const githubMarker = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'muxterm', 'sdk-chat', 'connections', 'github-enabled');
    const githubEnabled = !!muxterm && existsSync(githubMarker);
    if (githubEnabled) mcpConfig.push('-c', `mcp_servers.github.command=${JSON.stringify(muxterm)}`,
      '-c', 'mcp_servers.github.args=["connection-mcp","github"]');
    const remoteConnectionFile = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'muxterm', 'sdk-chat', 'connections', 'remote.json');
    const remoteConfigured = !!muxterm && existsSync(remoteConnectionFile);
    if (remoteConfigured) mcpConfig.push('-c', `mcp_servers.remote.command=${JSON.stringify(muxterm)}`,
      '-c', 'mcp_servers.remote.args=["connection-mcp","remote"]');
    const microsoftRoot = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'muxterm', 'sdk-chat', 'connections', 'microsoft-graph');
    const microsoftPersonal = !!muxterm && existsSync(join(microsoftRoot, 'personal', 'enabled'));
    if (microsoftPersonal) mcpConfig.push('-c', `mcp_servers.microsoft_personal.command=${JSON.stringify(muxterm)}`,
      '-c', 'mcp_servers.microsoft_personal.args=["connection-mcp","microsoft-personal"]');
    for (const key of ['XDG_RUNTIME_DIR', 'XDG_DATA_HOME']) {
      if (process.env[key]) {
        const value = JSON.stringify(process.env[key]);
        mcpConfig.push('-c', `mcp_servers.muxterm.env.${key}=${value}`);
        if (githubEnabled) mcpConfig.push('-c', `mcp_servers.github.env.${key}=${value}`);
        if (remoteConfigured) mcpConfig.push('-c', `mcp_servers.remote.env.${key}=${value}`);
        if (microsoftPersonal) mcpConfig.push('-c', `mcp_servers.microsoft_personal.env.${key}=${value}`);
      }
    }
    for (const key of ['PATH', 'HOME']) if (process.env[key]) {
      const value = JSON.stringify(process.env[key]);
      if (microsoftPersonal) mcpConfig.push('-c', `mcp_servers.microsoft_personal.env.${key}=${value}`);
    }
    if (githubEnabled) for (const key of ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR']) {
      if (process.env[key]) mcpConfig.push('-c', `mcp_servers.github.env.${key}=${JSON.stringify(process.env[key])}`);
    }
    this.process = spawn(agentCommand('codex', 'MUXTERM_CODEX_COMMAND'), ['app-server', '--stdio', '-c', 'model_reasoning_summary="none"', '-c', 'tools.update_plan.enabled=true', ...mcpConfig], {
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

  answerUserInput(questionId, answers) {
    const pending = this.userInputRequests.get(questionId);
    if (!pending) throw new Error('This question is no longer waiting for an answer');
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Invalid question answers');
    const response = {};
    for (const question of pending.questions) {
      const answer = answers[question.id];
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 4096) throw new Error('Answer each question before sending');
      if (question.options?.length && !question.isOther && !question.options.some(option => option.label === answer))
        throw new Error('Choose one of the offered answers');
      response[question.id] = { answers: [answer.trim()] };
    }
    this.userInputRequests.delete(questionId);
    this.process.stdin.write(JSON.stringify({ id: pending.rpcId, result: { answers: response } }) + '\n');
    this.emit(this.session.id, 'question.answered', { itemId: questionId });
    return { status: 'accepted' };
  }

  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'muxterm', title: 'muxterm SDK chat', version: '1' }, capabilities: { experimentalApi: true } });
    this.process.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    if (this.catalogOnly) return;
    const options = { cwd: this.session.cwd, additionalDirectories: this.session.sourceFolders, approvalPolicy: 'never', sandbox: this.sandboxName() };
    const result = await this.request(this.session.nativeId ? 'thread/resume' : 'thread/start',
      this.session.nativeId ? { threadId: this.session.nativeId, ...options } : options);
    this.session.nativeId = result.thread.id;
    this.session.model ||= result.thread.model || '';
    this.session.effort ||= result.thread.reasoningEffort || '';
    this.emit(this.session.id, 'session.started', { nativeId: result.thread.id,
      capabilities: { approvals: false, transcript_read: false, interrupt: true,
        live_input: false, attributed_service_input: false, native_steering: true } });
    try {
      const sequence = this.goalSequence;
      const current = await this.request('thread/goal/get', { threadId: result.thread.id });
      if (sequence === this.goalSequence) this.emit(this.session.id, 'goal.snapshot', { ...this.goalSnapshot(current.goal), raw: current });
    } catch (error) {
      this.emit(this.session.id, 'goal.capability', { message: `Native goal snapshot unavailable: ${error.message}` });
    }
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
    let configuredModel = '';
    const unlistedEfforts = ['low', 'medium', 'high', 'xhigh'];
    try {
      const settings = await this.request('config/read', { includeLayers: false });
      configuredModel = settings.config?.model || '';
    } catch { /* Older Codex builds may not expose config/read. */ }
    if (configuredModel && !models.some(model => model.id === configuredModel))
      models.unshift({ id: configuredModel, label: configuredModel, efforts: unlistedEfforts, defaultEffort: '' });
    if (this.session.model && !models.some(model => model.id === this.session.model))
      models.unshift({ id: this.session.model, label: this.session.model, efforts: unlistedEfforts, defaultEffort: '' });
    return { model: this.session.model || '', effort: this.session.effort || '', defaultModel: configuredModel, models };
  }

  goalSnapshot(goal) {
    return { goal: goal?.objective || '', goalState: goal?.status || 'cleared' };
  }

  async goal(action, objective, paused = false) {
    await this.ready;
    let result;
    if (action === 'clear') {
      const cleared = await this.request('thread/goal/clear', { threadId: this.session.nativeId });
      result = { ...cleared, goal: null };
    } else {
      result = await this.request('thread/goal/set', { threadId: this.session.nativeId,
        ...(action === 'set' || action === 'resume' ? { objective } : {}),
        ...(action === 'pause' || (action === 'set' && paused) ? { status: 'paused' }
          : action === 'resume' ? { status: 'active' } : {}) });
      if (!result.goal?.objective || !result.goal?.status) throw new Error('Native goal acknowledgement has no goal snapshot; inspect before retrying');
    }
    return { ...this.goalSnapshot(result.goal), native: result };
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
        summary: 'none',
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
      this.emit(this.session.id, 'input.accepted', { inputId: input.id, kind: 'steer', source: input.source, text: input.displayContent || input.content });
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
      if (message.method) {
        if (message.method === 'item/tool/requestUserInput' && message.params?.threadId === this.session.nativeId) {
          const questions = message.params.questions;
          if (!Array.isArray(questions) || !questions.length || questions.length > 3 ||
              questions.some(question => typeof question.id !== 'string' || typeof question.question !== 'string')) {
            this.process.stdin.write(JSON.stringify({ id: message.id, error: { code: -32602, message: 'Invalid questions' } }) + '\n');
            return;
          }
          const questionId = randomUUID();
          this.userInputRequests.set(questionId, { rpcId: message.id, questions, turnId: message.params.turnId });
          this.emit(this.session.id, 'question.requested', { itemId: questionId,
            raw: { questions, isBlocking: message.params.isBlocking !== false } });
        } else this.process.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported request' } }) + '\n');
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    const { method, params: p } = message;
    if (!p) return;
    if (method === 'serverRequest/resolved' && p.threadId === this.session.nativeId) {
      for (const [questionId, request] of this.userInputRequests) {
        if (request.rpcId !== p.requestId) continue;
        this.userInputRequests.delete(questionId);
        this.emit(this.session.id, 'question.resolved', { itemId: questionId });
        break;
      }
      return;
    }
    const childId = this.childThreads.has(p.threadId) ? p.threadId : null;
    if (childId) {
      if (method === 'item/agentMessage/delta' && p.delta)
        this.emit(this.session.id, 'delegate.message', { childSessionId: childId, text: p.delta });
      else if (method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.text)
        this.emit(this.session.id, 'delegate.message', { childSessionId: childId, text: p.item.text, complete: true });
      // Codex reports this item's lifecycle through kind on item/started.
      else if (method === 'item/started' && p.item?.type === 'subAgentActivity' && p.item.agentThreadId) {
        if (p.item.kind === 'started') {
          this.childThreads.set(p.item.agentThreadId, p.item.agentPath || 'Agent');
          this.emit(this.session.id, 'delegate.spawned', { childSessionId: p.item.agentThreadId,
            parentSessionId: childId, agent: p.item.agentPath || 'Agent', toolId: p.item.id });
        } else if (p.item.kind === 'completed') this.emit(this.session.id, 'delegate.completed', {
          childSessionId: p.item.agentThreadId, parentSessionId: childId,
          agent: p.item.agentPath || this.childThreads.get(p.item.agentThreadId) || 'Agent', toolId: p.item.id });
      } else if ((method === 'item/started' || method === 'item/completed') && p.item?.id && !['agentMessage', 'reasoning', 'subAgentActivity'].includes(p.item.type)) {
        this.emit(this.session.id, 'delegate.step', { childSessionId: childId, toolId: p.item.id,
          name: p.item.type || 'Work', kind: method === 'item/started' ? 'started' : 'completed', raw: p.item });
      }
      return;
    }
    if (p.threadId !== this.session.nativeId) return;
    if (method === 'turn/plan/updated' && Array.isArray(p.plan)) {
      const plan = p.plan.map(item => ({ step: item.step, status: item.status === 'inProgress' ? 'in_progress' : item.status }));
      const toolId = `codex-plan:${p.turnId}`;
      this.emit(this.session.id, 'tool.started', { toolId, name: 'update_plan', raw: { plan, explanation: p.explanation } });
      this.emit(this.session.id, 'tool.completed', { toolId, name: 'update_plan', raw: { plan, explanation: p.explanation } });
      return;
    }
    if (method === 'thread/goal/updated') {
      this.goalSequence++;
      const snapshot = this.goalSnapshot(p.goal);
      this.emit(this.session.id, 'goal.progress', { ...snapshot, raw: p });
      return;
    }
    if (method === 'thread/goal/cleared') {
      this.goalSequence++;
      this.emit(this.session.id, 'goal.progress', { goal: '', goalState: 'cleared', raw: p });
      return;
    }
    if (method === 'turn/started') {
      this.turnId = p.turn.id;
      this.session.busy = true;
      this.textByItem.clear();
      this.phaseByItem.clear();
      this.emit(this.session.id, 'turn.started', { generationId: p.turn.id });
    }
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
      if (p.delta) this.emit(this.session.id, this.phaseByItem.get(p.itemId) === 'commentary' ? 'commentary.delta' : 'assistant.delta', { text: p.delta, itemId: p.itemId });
    } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
      // Keep compatibility with an older app-server that only sends a final item.
      const sent = this.textByItem.get(p.item.id) || '';
      const full = p.item.text || '';
      const rest = full.startsWith(sent) ? full.slice(sent.length) : full;
      const commentary = (p.item.phase || this.phaseByItem.get(p.item.id)) === 'commentary';
      if (rest || commentary) this.emit(this.session.id, commentary ? 'commentary.delta' : 'assistant.delta', { text: rest, itemId: p.item.id, complete: true });
      if (Array.isArray(p.item.questions) && p.item.questions.length) {
        this.emit(this.session.id, 'question.suggested', { itemId: p.item.id,
          raw: { questions: p.item.questions.map((question, index) => ({ id: String(index), header: '',
            question: question.title, isOther: true, isSecret: false,
            options: (question.options || []).map(label => ({ label, description: '' })) })) } });
      }
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
        { inputIds: this.inputIds, generationId: p.turn.id, message: p.turn.error?.message || p.turn.status });
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

  close() { this.userInputRequests.clear(); this.process.kill('SIGTERM'); }

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
