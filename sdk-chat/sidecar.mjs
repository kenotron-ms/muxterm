// Versioned NDJSON over a Unix socket. Go owns IDs, receipts, and the event log.
import net from 'node:net';
import { unlink } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexStream, stopCodexRuntime } from './codex-stream.mjs';
import { CopilotStream, stopCopilotClient } from './copilot-stream.mjs';
import { agentCommand } from './agent-command.mjs';
import { ACPStream, isACPHarness, stopACPRuntimes } from './acp-stream.mjs';
import { PiStream } from './pi-stream.mjs';
import { OpenCodeStream } from './opencode-stream.mjs';
import { DeepSeekStream } from './deepseek-stream.mjs';
import { antigravityLoginStatus, startAntigravityLogin, cancelAntigravityLogin, finishAntigravityLogin } from './antigravity-login.mjs';
import { query, getSessionInfo, renameSession } from '@anthropic-ai/claude-agent-sdk';

const socketPath = process.argv[2];
if (!socketPath) throw new Error('Unix socket path required');
try { await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const sessions = new Map();
const clients = new Set();
let shuttingDown = false;
const claudeModels = new Map();
const claudeModelLoads = new Map();
const originFiles = new Set();
const originDir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'muxterm', 'sdk-chat', 'origin');
// A previous serve may have stopped abruptly. Its in-memory capabilities are
// gone, so its files cannot authenticate a new MCP process and can be pruned.
try {
  for (const name of readdirSync(originDir))
    if (/^[0-9a-f]{32}(?:-[0-9a-f]{32})?\.token$/.test(name)) unlinkSync(join(originDir, name));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
function forgetOriginFile(path) {
  if (!path) return;
  originFiles.delete(path);
  try { unlinkSync(path); } catch { /* The serve process invalidates capabilities on exit. */ }
}
process.on('exit', () => { for (const path of originFiles) forgetOriginFile(path); });
const muxtermMcpEnv = Object.fromEntries(['XDG_RUNTIME_DIR', 'XDG_DATA_HOME']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
function originFile(sessionId, token) {
  if (!/^[0-9a-f]{32}$/.test(sessionId) || !/^[0-9a-f]{64}$/.test(token || ''))
    throw new Error('Invalid chat identity or capability');
  mkdirSync(originDir, { recursive: true, mode: 0o700 });
  const path = join(originDir, `${sessionId}-${randomUUID().replaceAll('-', '')}.token`);
  writeFileSync(path, token, { mode: 0o600, flag: 'wx' });
  originFiles.add(path);
  return path;
}
const githubMcpEnv = Object.fromEntries(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
const githubMarker = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'muxterm', 'sdk-chat', 'connections', 'github-enabled');
const remoteConnectionFile = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'muxterm', 'sdk-chat', 'connections', 'remote.json');
const microsoftRoot = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'muxterm', 'sdk-chat', 'connections', 'microsoft-graph');
const microsoftMcpEnv = Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
const emit = (sessionId, type, data = {}) => broadcast({ v: 1, event: { sessionId, type, ...data } });
const codexStream = s => new CodexStream(s, emit, () => {
  if (sessions.get(s.id) === s) { sessions.delete(s.id); forgetOriginFile(s.originFile); }
});
function broadcast(message) {
  const line = JSON.stringify(message) + '\n';
  for (const client of clients) if (!client.destroyed) client.write(line);
}
const capabilities = harness => harness === 'copilot'
  ? { approvals: false, transcript_read: false, interrupt: true, live_input: false, attributed_service_input: false, native_steering: true }
  : isACPHarness(harness)
  ? { approvals: false, transcript_read: false, interrupt: true, live_input: false, attributed_service_input: false, native_steering: false }
  : harness === 'pi' || harness === 'opencode' || harness === 'deepseek'
  ? { approvals: false, transcript_read: false, interrupt: true, live_input: false,
      attributed_service_input: false, native_steering: harness === 'pi' }
  : harness === 'claude'
  ? { approvals: false, transcript_read: true, interrupt: true, live_input: true, attributed_service_input: true, native_steering: false }
  : { approvals: false, transcript_read: false, interrupt: true, live_input: false, attributed_service_input: false, native_steering: true };
function attachmentPrompt(input) {
  const items = input.attachments || [];
  if (!items.length) return input.content;
  const manifest = items.map(a => `- ${JSON.stringify(a.name)} (${a.kind}): ${JSON.stringify(a.path)}`).join('\n');
  return `${input.content || 'Please inspect the attached files.'}\n\nAttached files on the local filesystem (absolute paths):\n${manifest}\nRead the files at these paths before answering the question. For images, inspect the image content.`;
}
function inputMessage(input) {
  return { type: 'user', message: { role: 'user', content: attachmentPrompt(input) }, parent_tool_use_id: null,
    origin: input.kind === 'service' ? { kind: 'task-notification', subkind: input.source || 'muxterm' } : { kind: 'human' },
    uuid: input.id, ...(input.kind === 'service' ? { priority: 'now', client_composed: true } : {}) };
}
async function suggestClaudeTitle(inputs, cwd) {
  const prompt = 'Give this conversation a specific, sentence-case sidebar title of 3–5 words, at most 28 characters. Use a concrete action and object. Describe the actual task or purpose, not a greeting or the first line. Output the title only.\n\nHuman messages, oldest first:\n' +
    inputs.map(input => `- ${input}`).join('\n');
  const titleQuery = query({ prompt, options: { cwd, tools: [], maxTurns: 1, persistSession: false,
    pathToClaudeCodeExecutable: agentCommand('claude', 'MUXTERM_CLAUDE_COMMAND') } });
  let answer = '';
  for await (const msg of titleQuery) {
    if (msg.type === 'assistant') answer = (msg.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
  }
  return answer.trim();
}
async function modelsForClaude(cwd) {
  if (claudeModels.has(cwd)) return claudeModels.get(cwd);
  if (!claudeModelLoads.has(cwd)) {
    const load = (async () => {
      // A finite, empty stream asks the SDK for this folder's model catalog.
      // Its child exits naturally after the stream ends; no chat is started.
      async function* emptyInput() {}
      const q = query({ prompt: emptyInput(), options: { cwd, tools: [], maxTurns: 1, persistSession: false,
        pathToClaudeCodeExecutable: agentCommand('claude', 'MUXTERM_CLAUDE_COMMAND') } });
      try {
        const models = await q.supportedModels();
        for await (const _ of q) { /* Drain the finite SDK stream. */ }
        claudeModels.set(cwd, models);
        return models;
      } catch (error) { q.close(); throw error; }
    })().finally(() => claudeModelLoads.delete(cwd));
    claudeModelLoads.set(cwd, load);
  }
  return claudeModelLoads.get(cwd);
}
function queue(s, input) {
  s.inputs.push(inputMessage(input));
  s.wake?.(); s.wake = null;
}
async function* claudeInputs(s) {
  while (!s.closed && !s.closeInput) {
    if (!s.inputs.length) await new Promise(resolve => { s.wake = resolve; });
    if (s.closed || s.closeInput) break;
    while (s.inputs.length) {
      const input = s.inputs.shift();
      const pending = s.pendingInputs.get(input.uuid);
      if (pending) {
        s.pendingInputs.delete(input.uuid);
        emit(s.id, 'input.accepted', { inputId: input.uuid, kind: pending.input.kind,
          source: pending.input.source, text: pending.input.displayContent || pending.input.content,
          attachments: (pending.input.attachments || []).map(({ id, name, kind }) => ({ id, name, kind })) });
        pending.resolve();
      }
      yield input;
    }
  }
}
async function runClaude(s) {
  const toolNames = new Map();
  const agentTools = new Set();
  try {
    const q = query({ prompt: claudeInputs(s), options: { cwd: s.cwd, additionalDirectories: s.sourceFolders, resume: s.nativeId || undefined,
    pathToClaudeCodeExecutable: agentCommand('claude', 'MUXTERM_CLAUDE_COMMAND'),
    model: s.model || undefined,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Before your first tool call for a user request, give the user one brief, concrete progress update describing your next action. During longer work, give further updates at meaningful milestones. Keep private reasoning private.' },
    mcpServers: { muxterm: { command: process.env.MUXTERM_CHAT_MCP_BIN, args: ['mcp'], env: { ...muxtermMcpEnv, MUXTERM_CHAT_ORIGIN_FILE: s.originFile } },
      ...(existsSync(githubMarker) ? { github: { command: process.env.MUXTERM_CHAT_MCP_BIN, args: ['connection-mcp', 'github'], env: githubMcpEnv } } : {}),
      ...(existsSync(join(microsoftRoot, 'personal', 'enabled')) ? { microsoft_personal: { command: process.env.MUXTERM_CHAT_MCP_BIN, args: ['connection-mcp', 'microsoft-personal'], env: microsoftMcpEnv } } : {}),
      ...(existsSync(remoteConnectionFile) ? { remote: { command: process.env.MUXTERM_CHAT_MCP_BIN, args: ['connection-mcp', 'remote'], env: muxtermMcpEnv } } : {}) },
    includePartialMessages: true, permissionMode: s.permission === 'read-only' ? 'plan' : 'bypassPermissions', allowDangerouslySkipPermissions: true,
    hooks: { PreToolUse: [{ matcher: 'ProposeGoal', hooks: [async input => {
      if (input.tool_name !== 'ProposeGoal') return {};
      if (typeof input.tool_input?.condition === 'string') emit(s.id, 'goal.proposal', {
        inputId: input.tool_use_id || randomUUID(), message: input.tool_input.condition });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'Proposal recorded in muxterm. A human must approve it or authorize the direct operator to start it. Do not start or replace the goal yourself.' } };
    }] }] },
    thinking: { type: 'adaptive', display: 'summarized' }, effort: s.effort || 'high', maxTurns: 20 } });
    s.query = q;
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        s.nativeId = msg.session_id;
        if (!claudeModels.has(s.cwd)) {
          const models = await q.supportedModels().catch(() => null);
          if (models) claudeModels.set(s.cwd, models);
        }
        s.claudeReady?.resolve();
        emit(s.id, 'session.started', { nativeId: s.nativeId, capabilities: capabilities('claude') });
      } else if (msg.type === 'active_goal') {
        const snapshot = msg.value
          ? { goal: msg.value.condition, goalState: 'active', goalReason: msg.value.last_reason || '' }
          : { goalState: 'ended',
            goalReason: 'Native goal ended or cleared; the SDK event does not distinguish the outcome.' };
        if (msg.value) s.goalObjective = msg.value.condition;
        s.goalState = snapshot.goalState;
        emit(s.id, 'goal.progress', { ...snapshot, raw: msg });
      } else if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
        if (msg.state === 'running') { s.busy = true; emit(s.id, 'turn.started'); }
        if (msg.state === 'idle') s.busy = false;
      } else if (msg.type === 'stream_event') {
        const event = msg.event;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta')
          emit(s.id, msg.parent_tool_use_id ? 'delegate.message' : 'assistant.delta',
            { text: event.delta.text, ...(msg.parent_tool_use_id ? { childSessionId: msg.parent_tool_use_id } : {}) });
        else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use')
          { toolNames.set(event.content_block.id, event.content_block.name);
            if (event.content_block.name === 'Agent' || event.content_block.name === 'Task') {
              agentTools.add(event.content_block.id);
              emit(s.id, 'delegate.spawned', { childSessionId: event.content_block.id,
                parentSessionId: s.id, agent: event.content_block.name, toolId: event.content_block.id });
            }
            emit(s.id, 'tool.started', { toolId: event.content_block.id, name: event.content_block.name, raw: event.content_block.input }); }
      } else if (msg.type === 'assistant') {
        const control = s.goalControl;
        if (control && msg.local_command_run?.command === 'goal' && msg.local_command_run.args === control.args) {
          emit(s.id, 'goal.command', { raw: msg.local_command_run });
          if (control.args === 'clear') emit(s.id, 'goal.snapshot', {
            goalState: control.action === 'clear' ? 'cleared' : 'paused', raw: msg.local_command_run });
          control.resolve({ command: msg.local_command_run, awaitingNativeObservation: control.args !== 'clear' });
        }
        for (const block of msg.message?.content || []) if (block.type === 'tool_use') {
          if ((block.name === 'Agent' || block.name === 'Task') && !agentTools.has(block.id)) {
            agentTools.add(block.id);
            emit(s.id, 'delegate.spawned', { childSessionId: block.id,
              parentSessionId: s.id, agent: block.name, toolId: block.id });
          }
          emit(s.id, 'tool.started', { toolId: block.id, name: block.name, raw: block.input });
        }
      } else if (msg.type === 'user') {
        for (const block of msg.message?.content || []) if (block.type === 'tool_result') {
          emit(s.id, 'tool.completed', { toolId: block.tool_use_id,
            name: toolNames.get(block.tool_use_id) || 'Tool', raw: block.content, failed: !!block.is_error });
          if (agentTools.has(block.tool_use_id)) emit(s.id, 'delegate.completed', {
            childSessionId: block.tool_use_id, parentSessionId: s.id,
            agent: toolNames.get(block.tool_use_id) || 'Agent', toolId: block.tool_use_id, failed: !!block.is_error });
        }
      } else if (msg.type === 'result') {
        // The SDK's result echoes the UUIDs of user inputs the native turn
        // consumed. A local input queue is not proof that a turn was accepted.
        const accepted = msg.user_message_uuids || (msg.user_message_uuid ? [msg.user_message_uuid] : []);
        // Claude reports an acknowledged steer interrupt as either
        // `interrupted` or `error_during_execution`. Only the result for the
        // original input is a continuation; an error on the steer itself is not.
        const steeringAbort = s.steering && s.steerInterruptAck && !s.cancelRequested &&
          accepted.length > 0 && !accepted.includes(s.steerInputId) &&
          (msg.subtype === 'interrupted' ||
            (msg.subtype === 'error_during_execution' && msg.is_error && !msg.result));
        for (const id of accepted) s.inFlightInputs.delete(id);
        if (s.cancelRequested || (msg.subtype !== 'success' && !steeringAbort)) s.inFlightInputs.clear();
        s.busy = s.inFlightInputs.size > 0;
        emit(s.id, steeringAbort ? 'turn.continued'
          : s.cancelRequested || msg.subtype === 'interrupted' ? 'turn.cancelled'
          : msg.subtype === 'success' && !msg.is_error ? (s.busy ? 'turn.continued' : 'turn.completed') : 'error',
          { inputIds: accepted, message: msg.is_error ? msg.result || msg.subtype : msg.subtype });
        s.cancelRequested = false;
        s.steering = false;
        s.steerInputId = null;
        s.steerInterruptAck = false;
        if (!s.busy) {
          // Finite input lets the SDK child exit on its own after each turn.
          // A later turn starts a new query with the saved native session ID.
          s.closeInput = true;
          s.wake?.(); s.wake = null;
        }
      }
    }
  } catch (error) {
    s.claudeReady?.reject(error);
    // Input yielded to the SDK may have reached the native process even if its
    // stream dies before a result. Do not claim that its turn failed safely.
    const accepted = [...s.inFlightInputs].filter(id => !s.pendingInputs.has(id));
    s.busy = false;
    s.inFlightInputs.clear();
    s.steerInputId = null;
    s.steerInterruptAck = false;
    emit(s.id, accepted.length ? 'session.uncertain' : 'error',
      { inputIds: accepted, message: String(error) });
  }
  finally {
    s.claudeEnded = true;
    s.goalControl?.reject(new Error('Claude stream ended before native command acknowledgement'));
    s.query = null;
    s.runPromise = null;
    s.closeInput = false;
    s.claudeReady = null;
    for (const pending of s.pendingInputs.values()) pending.reject(new Error('Claude stream ended before input acceptance was confirmed'));
    s.pendingInputs.clear();
    s.inFlightInputs.clear();
  }
}
function startClaude(s) {
  if (s.runPromise) return;
  s.closeInput = false;
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  s.claudeReady = { promise, resolve, reject };
  s.runPromise = runClaude(s);
}
async function command(cmd) {
  const { op, sessionId, harness, cwd, nativeId, input } = cmd;
  if (op === 'antigravity-login-status') return antigravityLoginStatus();
  if (op === 'antigravity-login-start') return startAntigravityLogin();
  if (op === 'antigravity-login-cancel') return cancelAntigravityLogin();
  if (op === 'antigravity-login-finish') return await finishAntigravityLogin(cmd.callbackURL);
  if (op === 'capabilities') return { capabilities: capabilities(harness) };
  if (op === 'catalog' && harness === 'codex') {
    const catalog = new CodexStream({ cwd, sourceFolders: [], model: '', effort: '' }, () => {}, null, true);
    try { return await catalog.options(); }
    finally { await catalog.close(); }
  }
  if (op === 'start' || op === 'resume') {
    if (harness === 'amplifier') throw new Error('Amplifier unavailable in this build');
    if (harness !== 'codex' && harness !== 'claude' && harness !== 'copilot' &&
      !['pi', 'opencode', 'deepseek'].includes(harness) && !isACPHarness(harness)) throw new Error(`Unsupported harness: ${harness}`);
    if (sessions.has(sessionId)) return { sessionId, capabilities: capabilities(harness) };
    if (cmd.approval !== 'never') throw new Error('Invalid chat approval policy');
    const s = { id: sessionId, harness, cwd, sourceFolders: cmd.sourceFolders || [], nativeId, approval: cmd.approval,
      catalog: cmd.catalog === true, originFile: cmd.catalog === true ? '' : originFile(sessionId, cmd.originToken),
      inputs: [], pendingInputs: new Map(), inFlightInputs: new Set(), busy: false, closed: false, cancelRequested: false, steering: false, model: cmd.model || '', effort: cmd.effort || '', permission: cmd.permission || 'full-permission', mode: cmd.mode || 'agent' };
    sessions.set(sessionId, s);
    if (['pi', 'opencode', 'deepseek'].includes(harness)) {
      const Adapter = { pi: PiStream, opencode: OpenCodeStream, deepseek: DeepSeekStream }[harness];
      try { s.native = new Adapter(s, emit); await s.native.ready; }
      catch (error) {
        await s.native?.close().catch(() => {});
        sessions.delete(sessionId); forgetOriginFile(s.originFile); throw error;
      }
      return { sessionId, capabilities: capabilities(harness) };
    }
    if (harness === 'copilot') {
      try {
        s.copilot = new CopilotStream(s, emit, () => {
          if (sessions.get(sessionId) === s) { sessions.delete(sessionId); forgetOriginFile(s.originFile); }
        });
        await s.copilot.ready;
      } catch (error) {
        await s.copilot?.close(); sessions.delete(sessionId); forgetOriginFile(s.originFile);
        throw error;
      }
      return { sessionId, capabilities: capabilities(harness) };
    }
    if (isACPHarness(harness)) {
      try {
        s.acp = new ACPStream(s, emit, () => {
          // A dead ACP child must be replaced on the next resume, even when
          // it exited between turns and no uncertain delivery event was needed.
          if (sessions.get(sessionId) === s) { sessions.delete(sessionId); forgetOriginFile(s.originFile); }
        });
        await s.acp.start();
      } catch (error) {
        await s.acp?.close().catch(() => {}); sessions.delete(sessionId); forgetOriginFile(s.originFile);
        throw error;
      }
      return { sessionId, capabilities: capabilities(harness) };
    }
    if (op === 'start') emit(sessionId, 'session.started', { capabilities: capabilities(harness), pendingNativeId: true });
    return { sessionId, capabilities: capabilities(harness) };
  }
  const s = sessions.get(sessionId);
  if (op === 'close' && !s) return { status: 'closed' };
  if (!s) throw new Error('Session is not resident; resume it first');
  if (op === 'goal') {
    if (s.copilot) return await s.copilot.goal(cmd);
    if (s.harness === 'codex') {
      s.codex ||= codexStream(s);
      const snapshot = await s.codex.goal(cmd.action, cmd.objective, cmd.paused);
      return snapshot;
    }
    if (s.harness === 'claude') {
      startClaude(s);
      await s.claudeReady.promise;
      if (s.goalControl) throw new Error('A native goal command is already pending; inspect its receipt');
      const commands = await s.query.supportedCommands();
      if (!commands.some(item => item.name === 'goal' && item.builtin)) return { unsupported: true, message: 'The installed Claude runtime does not advertise the native goal command.' };
      const clearing = cmd.action === 'pause' || cmd.action === 'clear' || cmd.paused;
      const args = clearing ? 'clear' : cmd.objective;
      if (!clearing && (!args || args === 'clear')) throw new Error('The native command reserves clear; choose another goal condition');
      let control;
      const acknowledgement = new Promise((resolve, reject) => { control = { args, action: cmd.action, resolve, reject }; });
      s.goalControl = control;
      const timer = setTimeout(() => control.reject(new Error('Native goal command acknowledgement unavailable; do not blindly retry')), 35000);
      try {
        queue(s, { id: randomUUID(), kind: 'user', content: `/goal ${args}` });
        return await acknowledgement;
      } finally { clearTimeout(timer); if (s.goalControl === control) s.goalControl = null; }
    }
    throw new Error('Native goal controls unavailable for this adapter');
  }
  if (op === 'options') {
    if (s.native) return await s.native.options();
    if (s.copilot) return s.copilot.options();
    if (s.acp) return s.acp.options();
    if (s.harness === 'codex') {
      s.codex ||= codexStream(s);
      return await s.codex.options();
    }
    if (s.runPromise && !s.busy) await s.runPromise;
    const models = (await modelsForClaude(s.cwd)).map(model => ({
      id: model.value, label: model.displayName, efforts: model.supportedEffortLevels || [],
      defaultEffort: '',
    }));
    if (s.model && !models.some(model => model.id === s.model))
      models.unshift({ id: s.model, label: s.model, efforts: s.effort ? [s.effort] : [], defaultEffort: s.effort });
    return { model: s.model || models[0]?.id || '', effort: s.effort, models };
  }
  if (op === 'select') {
    if (s.native) return await s.native.select(cmd);
    if (s.copilot) return s.copilot.select(cmd);
    if (s.acp) return await s.acp.select(cmd);
    if (s.busy) throw new Error('Finish the current turn before changing settings');
    const options = await command({ op: 'options', sessionId });
    const model = cmd.model || options.model;
    const selected = options.models.find(item => item.id === model);
    if (model && !selected) throw new Error('Unsupported model');
    const effort = cmd.effort || '';
    if (effort && !selected?.efforts.includes(effort)) throw new Error('Unsupported effort for this model');
    if (s.harness === 'claude') {
      if (s.runPromise && !s.busy) await s.runPromise;
    }
    s.model = model; s.effort = effort;
    s.permission = cmd.permission || s.permission; s.mode = cmd.mode || s.mode;
    return { ...options, model, effort };
  }
  if (op === 'title') {
    if (s.native) return await s.native.title(cmd);
    if (s.copilot) return s.copilot.title(cmd);
    if (s.acp) return s.acp.title(cmd);
    if (s.harness === 'codex') {
      s.codex ||= codexStream(s);
      return s.codex.title(cmd.mode, cmd.name, cmd.previousName);
    }
    if (!s.nativeId) throw new Error('Claude native session ID unavailable');
    if (cmd.mode === 'suggest') return { name: await suggestClaudeTitle(cmd.inputs || [], s.cwd) };
    if (cmd.mode === 'manual') await renameSession(s.nativeId, cmd.name, { dir: s.cwd });
    if (cmd.mode === 'generated') {
      const existing = await getSessionInfo(s.nativeId, { dir: s.cwd });
      if (existing?.customTitle && existing.customTitle !== cmd.previousName)
        return { name: existing.customTitle, source: 'manual' };
      await renameSession(s.nativeId, cmd.name, { dir: s.cwd });
      return { name: cmd.name, source: 'generated' };
    }
    const info = await getSessionInfo(s.nativeId, { dir: s.cwd });
    return { name: info?.customTitle || info?.summary || '',
      source: info?.customTitle ? 'manual' : info?.summary && info.summary !== info.firstPrompt ? 'native' : '',
      firstPrompt: info?.firstPrompt || '' };
  }
  if (op === 'send') {
    if (!input?.id || (!input?.content && !input?.attachments?.length) || !['user', 'service', 'steer'].includes(input.kind)) throw new Error('Invalid input');
    if (input.kind === 'service' && !capabilities(s.harness).attributed_service_input)
      throw new Error('unsupported: attributed service input');
    if (input.kind === 'steer' && !s.busy) throw new Error('No active turn to steer');
    if (s.busy && input.kind !== 'steer' && !capabilities(s.harness).live_input) throw new Error('unsupported: live input');
    if (s.acp) return await s.acp.send(input);
    if (s.copilot) return await s.copilot.send(input);
    if (s.native) return await s.native.send(input);
    if (s.harness === 'claude') {
      if (s.runPromise && !s.busy) await s.runPromise;
      if (input.model && input.model !== s.model) { if (s.query) await s.query.setModel(input.model); s.model = input.model; }
      if (input.effort !== s.effort) { if (s.query) await s.query.applyFlagSettings({ effortLevel: input.effort || null }); s.effort = input.effort || ''; }
    }

    if (s.harness === 'codex') {
      // Codex has not accepted a turn until app-server answers turn/start.
      // Returning before that answer used to turn a failed native submission
      // into a false successful receipt in muxterm's durable control ledger.
      if (input.kind !== 'steer') s.busy = true;
      try {
        s.codex ||= codexStream(s);
        if (input.kind === 'steer') await s.codex.steer(input);
        else await s.codex.run(input);
      } catch (error) {
        s.busy = false;
        if (input.kind === 'steer') emit(sessionId, 'error', { message: String(error) });
        throw error;
      }
    } else {
      startClaude(s);
      s.busy = true;
      s.inFlightInputs.add(input.id);
      try {
        if (input.kind === 'steer') {
          // Streaming text has no request boundary at which Claude can fold a
          // queued correction. Abort that generation, then continue with the
          // correction while keeping its already-streamed transcript visible.
          s.steering = true;
          s.steerInputId = input.id;
          s.steerInterruptAck = false;
          await s.query.interrupt();
          s.steerInterruptAck = true;
          if (s.cancelRequested) throw new Error('Steer was cancelled');
        }
        await new Promise((resolve, reject) => {
          s.pendingInputs.set(input.id, { input, resolve, reject });
          queue(s, input);
        });
      } catch (error) {
        s.inFlightInputs.delete(input.id);
        s.steering = false;
        s.steerInputId = null;
        s.steerInterruptAck = false;
        throw error;
      }
    }
    if (s.harness === 'codex' && input.kind !== 'steer') emit(sessionId, 'input.accepted', { inputId: input.id, kind: input.kind, source: input.source, text: input.displayContent || input.content,
      attachments: (input.attachments || []).map(({ id, name, kind }) => ({ id, name, kind })) });

    return { status: 'accepted', inputId: input.id };
  }
  if (op === 'answerQuestion') {
    if (s.harness !== 'codex' || !s.codex) throw new Error('This chat has no pending Codex question');
    return s.codex.answerUserInput(cmd.questionId, cmd.answers);
  }
  if (op === 'interrupt') {
    if (!s.busy) throw new Error('No active turn to stop');
    if (s.acp) return await s.acp.interrupt();
    if (s.copilot) return await s.copilot.interrupt();
    if (s.native) return await s.native.interrupt();
    if (s.harness === 'codex') await s.codex?.interrupt();
    else {
      s.cancelRequested = true;
      s.inputs.length = 0;
      s.inFlightInputs.clear();
      for (const pending of s.pendingInputs.values()) pending.reject(new Error('Input cancelled'));
      s.pendingInputs.clear();
      await s.query?.interrupt({ cancelQueued: true });
    }
    return { status: 'accepted' };
  }
  if (op === 'close') {
    if (s.busy || s.acp?.busy) throw new Error('Finish the current turn before archiving this chat');
    sessions.delete(sessionId);
    s.closed = true; s.wake?.();
    try { await s.native?.close(); await s.acp?.close(); await s.copilot?.close(); await s.codex?.close(); await s.query?.close?.(); }
    finally { forgetOriginFile(s.originFile); }
    return { status: 'closed' };
  }
  throw new Error(`Unknown operation: ${op}`);
}
const server = net.createServer(client => {
  clients.add(client); let buffer = '';
  client.on('error', () => clients.delete(client));
  client.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const i = buffer.indexOf('\n'); if (i < 0) break;
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let cmd;
      try { cmd = JSON.parse(line); } catch { client.write(JSON.stringify({ v: 1, error: 'invalid JSON' }) + '\n'); continue; }
      if (cmd.v !== 1 || !cmd.requestId) { client.write(JSON.stringify({ v: 1, requestId: cmd.requestId, error: 'unsupported protocol' }) + '\n'); continue; }
      Promise.resolve().then(() => command(cmd)).then(result => client.write(JSON.stringify({ v: 1, requestId: cmd.requestId, result }) + '\n'))
        .catch(error => client.write(JSON.stringify({ v: 1, requestId: cmd.requestId, error: String(error.message || error) }) + '\n'));
    }
  });
  client.on('close', () => clients.delete(client));
});
server.listen(socketPath);

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  cancelAntigravityLogin();
  const closing = [...sessions.values()].map(async s => {
    s.closed = true;
    s.wake?.();
    forgetOriginFile(s.originFile);
    try { await s.native?.close(); await s.acp?.close(); await s.copilot?.close(); await s.codex?.close(); await s.query?.close?.(); }
    catch (error) { console.error(`SDK chat adapter shutdown: ${error}`); }
  });
  await Promise.allSettled(closing);
  await Promise.allSettled([
    stopACPRuntimes().catch(error => console.error(`ACP shutdown: ${error}`)),
    stopCodexRuntime().catch(error => console.error(`Codex shutdown: ${error}`)),
    stopCopilotClient().catch(error => console.error(`Copilot shutdown: ${error}`)),
  ]);
  server.close();
  try { await unlink(socketPath); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
