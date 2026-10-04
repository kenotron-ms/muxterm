// Versioned NDJSON over a Unix socket. Go owns IDs, receipts, and the event log.
import net from 'node:net';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodexStream } from './codex-stream.mjs';
import { query, getSessionInfo, renameSession } from '@anthropic-ai/claude-agent-sdk';

const socketPath = process.argv[2];
if (!socketPath) throw new Error('Unix socket path required');
try { await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const sessions = new Map();
const clients = new Set();
const muxtermMcpEnv = Object.fromEntries(['XDG_RUNTIME_DIR', 'XDG_DATA_HOME']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
const githubMcpEnv = Object.fromEntries(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
const githubMarker = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'muxterm', 'sdk-chat', 'connections', 'github-enabled');
const remoteConnectionFile = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'muxterm', 'sdk-chat', 'connections', 'remote.json');
const emit = (sessionId, type, data = {}) => broadcast({ v: 1, event: { sessionId, type, ...data } });
function broadcast(message) {
  const line = JSON.stringify(message) + '\n';
  for (const client of clients) if (!client.destroyed) client.write(line);
}
const capabilities = harness => harness === 'claude'
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
  const titleQuery = query({ prompt, options: { cwd, tools: [], maxTurns: 1, persistSession: false } });
  let answer = '';
  for await (const msg of titleQuery) {
    if (msg.type === 'assistant') answer = (msg.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
  }
  return answer.trim();
}
function queue(s, input) {
  s.inputs.push(inputMessage(input));
  s.wake?.(); s.wake = null;
}
async function* claudeInputs(s) {
  while (!s.closed) {
    if (!s.inputs.length) await new Promise(resolve => { s.wake = resolve; });
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
  let thinkingStreamed = false;
  const q = query({ prompt: claudeInputs(s), options: { cwd: s.cwd, additionalDirectories: s.sourceFolders, resume: s.nativeId || undefined,
    mcpServers: { muxterm: { command: process.env.MUXTERM_CHAT_MCP_BIN, args: ['mcp'], env: muxtermMcpEnv },
      ...(existsSync(githubMarker) ? { github: { command: process.env.MUXTERM_CHAT_MCP_BIN, args: ['connection-mcp', 'github'], env: githubMcpEnv } } : {}),
      ...(existsSync(remoteConnectionFile) ? { remote: { command: process.env.MUXTERM_CHAT_MCP_BIN, args: ['connection-mcp', 'remote'], env: muxtermMcpEnv } } : {}) },
    includePartialMessages: true, permissionMode: s.permission === 'read-only' ? 'plan' : 'bypassPermissions', allowDangerouslySkipPermissions: true,
    thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high', maxTurns: 20 } });
  s.query = q;
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        s.nativeId = msg.session_id;
        emit(s.id, 'session.started', { nativeId: s.nativeId, capabilities: capabilities('claude') });
      } else if (msg.type === 'stream_event') {
        const event = msg.event;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta')
          emit(s.id, msg.parent_tool_use_id ? 'delegate.message' : 'assistant.delta',
            { text: event.delta.text, ...(msg.parent_tool_use_id ? { childSessionId: msg.parent_tool_use_id } : {}) });
        else if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
          thinkingStreamed = true;
          emit(s.id, 'thinking.delta', { text: event.delta.thinking });
        }
        else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use')
          { toolNames.set(event.content_block.id, event.content_block.name);
            if (event.content_block.name === 'Agent' || event.content_block.name === 'Task') {
              agentTools.add(event.content_block.id);
              emit(s.id, 'delegate.spawned', { childSessionId: event.content_block.id,
                parentSessionId: s.id, agent: event.content_block.name, toolId: event.content_block.id });
            }
            emit(s.id, 'tool.started', { toolId: event.content_block.id, name: event.content_block.name, raw: event.content_block.input }); }
      } else if (msg.type === 'assistant') {
        if (!thinkingStreamed) for (const block of msg.message?.content || []) if (block.type === 'thinking' && block.thinking)
          emit(s.id, 'thinking.delta', { text: block.thinking });
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
        thinkingStreamed = false;
        // The SDK's result echoes the UUIDs of user inputs the native turn
        // consumed. A local input queue is not proof that a turn was accepted.
        const accepted = msg.user_message_uuids || (msg.user_message_uuid ? [msg.user_message_uuid] : []);
        const steeringAbort = s.steering && !s.cancelRequested && msg.subtype !== 'success';
        for (const id of accepted) s.inFlightInputs.delete(id);
        if (s.cancelRequested || (msg.subtype !== 'success' && !steeringAbort)) s.inFlightInputs.clear();
        s.busy = s.inFlightInputs.size > 0;
        emit(s.id, steeringAbort ? 'turn.continued'
          : s.cancelRequested || msg.subtype === 'interrupted' ? 'turn.cancelled'
          : msg.subtype === 'success' ? (s.busy ? 'turn.continued' : 'turn.completed') : 'error',
          { inputIds: accepted, message: msg.subtype });
        s.cancelRequested = false;
        s.steering = false;
      }
    }
  } catch (error) { s.busy = false; emit(s.id, 'error', { message: String(error) }); }
  finally {
    for (const pending of s.pendingInputs.values()) pending.reject(new Error('Claude stream ended before input acceptance was confirmed'));
    s.pendingInputs.clear();
  }
}
async function command(cmd) {
  const { op, sessionId, harness, cwd, nativeId, input } = cmd;
  if (op === 'capabilities') return { capabilities: capabilities(harness) };
  if (op === 'start' || op === 'resume') {
    if (harness === 'amplifier') throw new Error('Amplifier unavailable in this build');
    if (harness !== 'codex' && harness !== 'claude') throw new Error(`Unsupported harness: ${harness}`);
    if (sessions.has(sessionId)) return { sessionId, capabilities: capabilities(harness) };
    if (cmd.approval !== 'never') throw new Error('Invalid chat approval policy');
    const s = { id: sessionId, harness, cwd, sourceFolders: cmd.sourceFolders || [], nativeId, approval: cmd.approval, inputs: [], pendingInputs: new Map(), inFlightInputs: new Set(), busy: false, closed: false, cancelRequested: false, steering: false, model: cmd.model || '', effort: cmd.effort || '', permission: cmd.permission || 'full-permission', mode: cmd.mode || 'agent' };
    sessions.set(sessionId, s);
    if (harness === 'claude') void runClaude(s);
    if (op === 'start') emit(sessionId, 'session.started', { capabilities: capabilities(harness), pendingNativeId: true });
    return { sessionId, capabilities: capabilities(harness) };
  }
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Session is not resident; resume it first');
  if (op === 'options') {
    if (s.harness === 'codex') {
      s.codex ||= new CodexStream(s, emit);
      return await s.codex.options();
    }
    const models = (await s.query.supportedModels()).map(model => ({
      id: model.value, label: model.displayName, efforts: model.supportedEffortLevels || [],
      defaultEffort: '',
    }));
    return { model: s.model || models[0]?.id || '', effort: s.effort, models };
  }
  if (op === 'select') {
    if (s.busy) throw new Error('Finish the current turn before changing settings');
    const options = await command({ op: 'options', sessionId });
    const model = cmd.model || options.model;
    const selected = options.models.find(item => item.id === model);
    if (model && !selected) throw new Error('Unsupported model');
    const effort = cmd.effort || '';
    if (effort && !selected?.efforts.includes(effort)) throw new Error('Unsupported effort for this model');
    if (s.harness === 'claude') {
      if (model !== s.model) await s.query.setModel(model || undefined);
      if (effort !== s.effort) await s.query.applyFlagSettings({ effortLevel: effort || null });
      if (cmd.permission && cmd.permission !== s.permission) await s.query.setPermissionMode(cmd.permission === 'read-only' ? 'plan' : 'bypassPermissions');
    }
    s.model = model; s.effort = effort;
    s.permission = cmd.permission || s.permission; s.mode = cmd.mode || s.mode;
    return { ...options, model, effort };
  }
  if (op === 'title') {
    if (s.harness === 'codex') {
      s.codex ||= new CodexStream(s, emit);
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
    if (s.harness === 'claude') {
      if (input.model && input.model !== s.model) { await s.query.setModel(input.model); s.model = input.model; }
      if (input.effort !== s.effort) { await s.query.applyFlagSettings({ effortLevel: input.effort || null }); s.effort = input.effort || ''; }
    }

    if (s.harness === 'codex') {
      // Codex has not accepted a turn until app-server answers turn/start.
      // Returning before that answer used to turn a failed native submission
      // into a false successful receipt in muxterm's durable control ledger.
      if (input.kind !== 'steer') s.busy = true;
      try {
        s.codex ||= new CodexStream(s, emit);
        if (input.kind === 'steer') await s.codex.steer(input);
        else await s.codex.run(input);
      } catch (error) {
        s.busy = false;
        if (input.kind === 'steer') emit(sessionId, 'error', { message: String(error) });
        throw error;
      }
    } else {
      s.busy = true;
      s.inFlightInputs.add(input.id);
      try {
        if (input.kind === 'steer') {
          // Streaming text has no request boundary at which Claude can fold a
          // queued correction. Abort that generation, then continue with the
          // correction while keeping its already-streamed transcript visible.
          s.steering = true;
          await s.query.interrupt();
          if (s.cancelRequested) throw new Error('Steer was cancelled');
        }
        await new Promise((resolve, reject) => {
          s.pendingInputs.set(input.id, { input, resolve, reject });
          queue(s, input);
        });
      } catch (error) { s.inFlightInputs.delete(input.id); s.steering = false; throw error; }
    }
    if (s.harness === 'codex' && input.kind !== 'steer') emit(sessionId, 'input.accepted', { inputId: input.id, kind: input.kind, source: input.source, text: input.displayContent || input.content,
      attachments: (input.attachments || []).map(({ id, name, kind }) => ({ id, name, kind })) });

    return { status: 'accepted', inputId: input.id };
  }
  if (op === 'interrupt') {
    if (!s.busy) throw new Error('No active turn to stop');
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
    s.closed = true; s.wake?.(); s.codex?.close(); s.query?.close?.(); sessions.delete(sessionId);
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
  for (const s of sessions.values()) { s.closed = true; s.wake?.(); s.codex?.close(); try { await s.query?.close?.(); } catch {} }
  server.close();
  try { await unlink(socketPath); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
