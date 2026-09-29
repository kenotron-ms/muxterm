// Versioned NDJSON over a Unix socket. Go owns IDs, receipts, and the event log.
import net from 'node:net';
import { unlink } from 'node:fs/promises';
import { CodexStream } from './codex-stream.mjs';
import { query } from '@anthropic-ai/claude-agent-sdk';

const socketPath = process.argv[2];
if (!socketPath) throw new Error('Unix socket path required');
try { await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const sessions = new Map();
const clients = new Set();
const muxtermMcpEnv = Object.fromEntries(['XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'MUXTERM_COS_SESSION_ID']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
const emit = (sessionId, type, data = {}) => broadcast({ v: 1, event: { sessionId, type, ...data } });
function broadcast(message) {
  const line = JSON.stringify(message) + '\n';
  for (const client of clients) if (!client.destroyed) client.write(line);
}
const capabilities = harness => harness === 'claude'
  ? { approvals: false, transcript_read: true, interrupt: true, live_input: true, attributed_service_input: true, native_steering: false }
  : { approvals: false, transcript_read: false, interrupt: true, live_input: false, attributed_service_input: false, native_steering: false };
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
function queue(s, input) {
  s.inputs.push(inputMessage(input));
  s.wake?.(); s.wake = null;
}
async function* claudeInputs(s) {
  while (!s.closed) {
    if (!s.inputs.length) await new Promise(resolve => { s.wake = resolve; });
    while (s.inputs.length) yield s.inputs.shift();
  }
}
async function runClaude(s) {
  const toolNames = new Map();
  let thinkingStreamed = false;
  const q = query({ prompt: claudeInputs(s), options: { cwd: s.cwd, resume: s.nativeId || undefined,
    mcpServers: { muxterm: { command: process.env.MUXTERM_CHAT_MCP_BIN, args: ['mcp'], env: muxtermMcpEnv } },
    includePartialMessages: true, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
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
          emit(s.id, 'assistant.delta', { text: event.delta.text });
        else if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
          thinkingStreamed = true;
          emit(s.id, 'thinking.delta', { text: event.delta.thinking });
        }
        else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use')
          { toolNames.set(event.content_block.id, event.content_block.name);
            emit(s.id, 'tool.started', { toolId: event.content_block.id, name: event.content_block.name, raw: event.content_block.input }); }
      } else if (msg.type === 'assistant') {
        if (!thinkingStreamed) for (const block of msg.message?.content || []) if (block.type === 'thinking' && block.thinking)
          emit(s.id, 'thinking.delta', { text: block.thinking });
        for (const block of msg.message?.content || []) if (block.type === 'tool_use')
          emit(s.id, 'tool.started', { toolId: block.id, name: block.name, raw: block.input });
      } else if (msg.type === 'user') {
        for (const block of msg.message?.content || []) if (block.type === 'tool_result')
          emit(s.id, 'tool.completed', { toolId: block.tool_use_id,
            name: toolNames.get(block.tool_use_id) || 'Tool', raw: block.content, failed: !!block.is_error });
      } else if (msg.type === 'result') {
        thinkingStreamed = false;
        // The SDK's result echoes the UUIDs of user inputs the native turn
        // consumed. A local input queue is not proof that a turn was accepted.
        const accepted = msg.user_message_uuids || (msg.user_message_uuid ? [msg.user_message_uuid] : []);
        for (const id of accepted) {
          const pending = s.pendingInputs.get(id);
          if (!pending) continue;
          s.pendingInputs.delete(id);
          emit(s.id, 'input.accepted', { inputId: id, kind: pending.input.kind,
            source: pending.input.source, text: pending.input.content });
          pending.resolve();
        }
        s.busy = false;
        emit(s.id, msg.subtype === 'success' ? 'turn.completed' : 'error', { inputIds: msg.user_message_uuids, message: msg.subtype });
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
    const s = { id: sessionId, harness, cwd, nativeId, inputs: [], pendingInputs: new Map(), busy: false, closed: false };
    sessions.set(sessionId, s);
    if (harness === 'claude') void runClaude(s);
    if (op === 'start') emit(sessionId, 'session.started', { capabilities: capabilities(harness), pendingNativeId: true });
    return { sessionId, capabilities: capabilities(harness) };
  }
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Session is not resident; resume it first');
  if (op === 'send') {
    if (!input?.id || (!input?.content && !input?.attachments?.length) || !['user', 'service'].includes(input.kind)) throw new Error('Invalid input');
    if (input.kind === 'service' && !capabilities(s.harness).attributed_service_input)
      throw new Error('unsupported: attributed service input');
    if (s.busy && !capabilities(s.harness).live_input) throw new Error('unsupported: live input');
    if (s.harness === 'codex') {
      // Codex has not accepted a turn until app-server answers turn/start.
      // Returning before that answer used to turn a failed native submission
      // into a false successful receipt in muxterm's durable control ledger.
      s.busy = true;
      try {
        s.codex ||= new CodexStream(s, emit);
        await s.codex.run(input);
      } catch (error) {
        s.busy = false;
        throw error;
      }
    } else {
      s.busy = true;
      await new Promise((resolve, reject) => {
        s.pendingInputs.set(input.id, { input, resolve, reject });
        queue(s, input);
      });
    }
    if (s.harness === 'codex') emit(sessionId, 'input.accepted', { inputId: input.id, kind: input.kind, source: input.source, text: input.content });
    return { status: 'accepted', inputId: input.id };
  }
  if (op === 'interrupt') {
    if (s.harness === 'codex') await s.codex?.interrupt(); else await s.query?.interrupt();
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
