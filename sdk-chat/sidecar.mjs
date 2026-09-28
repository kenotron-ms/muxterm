// Versioned NDJSON over a Unix socket. Go owns IDs, receipts, and the event log.
import net from 'node:net';
import { unlink } from 'node:fs/promises';
import { Codex } from '@openai/codex-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

const socketPath = process.argv[2];
if (!socketPath) throw new Error('Unix socket path required');
try { await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const sessions = new Map();
const clients = new Set();
const emit = (sessionId, type, data = {}) => broadcast({ v: 1, event: { sessionId, type, ...data } });
function broadcast(message) {
  const line = JSON.stringify(message) + '\n';
  for (const client of clients) if (!client.destroyed) client.write(line);
}
const capabilities = harness => harness === 'claude'
  ? { approvals: false, transcript_read: true, interrupt: true, live_input: true, attributed_service_input: true, native_steering: false }
  : { approvals: false, transcript_read: false, interrupt: true, live_input: false, attributed_service_input: false, native_steering: false };
function inputMessage(input) {
  return { type: 'user', message: { role: 'user', content: input.content }, parent_tool_use_id: null,
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
  const q = query({ prompt: claudeInputs(s), options: { cwd: s.cwd, resume: s.nativeId || undefined,
    includePartialMessages: true, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    maxTurns: 20 } });
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
        else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use')
          emit(s.id, 'tool.started', { toolId: event.content_block.id, name: event.content_block.name, raw: event.content_block });
      } else if (msg.type === 'assistant') {
        for (const block of msg.message?.content || []) if (block.type === 'tool_use')
          emit(s.id, 'tool.completed', { toolId: block.id, name: block.name, raw: block });
      } else if (msg.type === 'result') {
        s.busy = false;
        emit(s.id, msg.subtype === 'success' ? 'turn.completed' : 'error', { inputIds: msg.user_message_uuids, message: msg.subtype });
      }
    }
  } catch (error) { s.busy = false; emit(s.id, 'error', { message: String(error) }); }
}
async function runCodex(s, input) {
  s.busy = true;
  const abort = new AbortController(); s.abort = abort;
  try {
    if (!s.thread) {
      const sdk = new Codex();
      s.thread = s.nativeId ? sdk.resumeThread(s.nativeId, { workingDirectory: s.cwd,
        skipGitRepoCheck: true, approvalPolicy: 'never', sandboxMode: 'danger-full-access' })
        : sdk.startThread({ workingDirectory: s.cwd, skipGitRepoCheck: true,
          approvalPolicy: 'never', sandboxMode: 'danger-full-access' });
    }
    const { events } = await s.thread.runStreamed(input.content, { signal: abort.signal });
    for await (const event of events) {
      if (event.type === 'thread.started') {
        s.nativeId = event.thread_id;
        emit(s.id, 'session.started', { nativeId: s.nativeId, capabilities: capabilities('codex') });
      } else if (event.type === 'item.updated' && event.item?.type === 'agent_message') {
        const old = s.partial || '';
        const next = event.item.text || '';
        if (next.startsWith(old)) emit(s.id, 'assistant.delta', { text: next.slice(old.length) });
        s.partial = next;
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        const old = s.partial || '';
        const next = event.item.text || '';
        emit(s.id, 'assistant.delta', { text: next.startsWith(old) ? next.slice(old.length) : next });
        s.partial = '';
      } else if (event.type === 'item.started' && event.item?.type !== 'agent_message') {
        emit(s.id, 'tool.started', { name: event.item.type, toolId: event.item.id, raw: event.item });
      } else if (event.type === 'item.completed' && event.item?.type !== 'agent_message') {
        emit(s.id, 'tool.completed', { name: event.item.type, toolId: event.item.id, raw: event.item });
      } else if (event.type === 'turn.completed') emit(s.id, 'turn.completed', { inputIds: [input.id] });
      else if (event.type === 'turn.failed') emit(s.id, 'error', { message: event.error?.message || 'Codex turn failed' });
    }
  } catch (error) { emit(s.id, 'error', { message: String(error) }); }
  finally { s.busy = false; s.abort = null; }
}
async function command(cmd) {
  const { op, sessionId, harness, cwd, nativeId, input } = cmd;
  if (op === 'capabilities') return { capabilities: capabilities(harness) };
  if (op === 'start' || op === 'resume') {
    if (harness === 'amplifier') throw new Error('Amplifier unavailable in this build');
    if (harness !== 'codex' && harness !== 'claude') throw new Error(`Unsupported harness: ${harness}`);
    if (sessions.has(sessionId)) return { sessionId, capabilities: capabilities(harness) };
    const s = { id: sessionId, harness, cwd, nativeId, inputs: [], busy: false, closed: false };
    sessions.set(sessionId, s);
    if (harness === 'claude') void runClaude(s);
    if (op === 'start') emit(sessionId, 'session.started', { capabilities: capabilities(harness), pendingNativeId: true });
    return { sessionId, capabilities: capabilities(harness) };
  }
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Session is not resident; resume it first');
  if (op === 'send') {
    if (!input?.id || !input?.content || !['user', 'service'].includes(input.kind)) throw new Error('Invalid input');
    if (input.kind === 'service' && !capabilities(s.harness).attributed_service_input)
      throw new Error('unsupported: attributed service input');
    if (s.busy && !capabilities(s.harness).live_input) throw new Error('unsupported: live input');
    emit(sessionId, 'input.accepted', { inputId: input.id, kind: input.kind, source: input.source, text: input.content });
    if (s.harness === 'codex') void runCodex(s, input);
    else { s.busy = true; queue(s, input); }
    return { status: 'accepted', inputId: input.id };
  }
  if (op === 'interrupt') {
    if (s.harness === 'codex') s.abort?.abort(); else await s.query?.interrupt();
    return { status: 'accepted' };
  }
  if (op === 'close') {
    s.closed = true; s.wake?.(); s.abort?.abort(); s.query?.close?.(); sessions.delete(sessionId);
    return { status: 'closed' };
  }
  throw new Error(`Unknown operation: ${op}`);
}
const server = net.createServer(client => {
  clients.add(client); let buffer = '';
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
  for (const s of sessions.values()) { s.closed = true; s.wake?.(); s.abort?.abort(); try { await s.query?.close?.(); } catch {} }
  server.close();
  try { await unlink(socketPath); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
