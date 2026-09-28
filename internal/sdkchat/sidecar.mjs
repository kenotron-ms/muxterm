// Event normalization follows the executed Codex and Claude adapter proof.
import net from 'node:net';
import { Codex } from '@openai/codex-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
const sessions = new Map();
const socket = net.connect(process.env.MUXTERM_SDK_SOCKET);
let pending = '';
const write = value => socket.write(JSON.stringify({ version: 1, ...value }) + '\n');
const event = (s, type, data = {}) => write({ event: { session_id: s.id, type, ...data } });
const capabilities = harness => harness === 'claude'
  ? { approvals: false, transcript_read: true, interrupt: true, live_input: true, attributed_service_input: true, native_steering: false }
  : { approvals: false, transcript_read: false, interrupt: true, live_input: false, attributed_service_input: false, native_steering: false };
const reply = (id, data = {}) => write({ id, ...data });
class CodexSession {
  constructor(id, cwd, harnessId) {
    this.id = id; this.harness = 'codex'; this.cwd = cwd; this.harnessId = harnessId;
    this.thread = harnessId ? new Codex().resumeThread(harnessId, this.options()) : new Codex().startThread(this.options());
    this.busy = false;
  }
  options() { return { workingDirectory: this.cwd, skipGitRepoCheck: true, sandboxMode: 'danger-full-access', approvalPolicy: 'never' }; }
  async send(input) {
    if (input.kind !== 'user') throw new Error('unsupported: Codex TypeScript SDK cannot accept attributed service input');
    if (this.busy) throw new Error('unsupported: Codex TypeScript SDK cannot accept live input');
    this.busy = true; this.controller = new AbortController();
    void this.run(input).finally(() => { this.busy = false; this.controller = null; });
  }
  async run(input) {
    try {
      const { events } = await this.thread.runStreamed(input.content, { signal: this.controller.signal });
      const itemText = new Map();
      for await (const e of events) {
        if (e.type === 'thread.started') { this.harnessId = e.thread_id; event(this, 'session.started', { harness_id: e.thread_id }); }
        else if (e.type === 'item.updated' || e.type === 'item.completed') {
          if (e.item.type === 'agent_message') {
            const before = itemText.get(e.item.id) || '', full = e.item.text || '';
            if (full.startsWith(before) && full.length > before.length) event(this, 'assistant.delta', { text: full.slice(before.length), input_id: input.id });
            itemText.set(e.item.id, full);
          } else if (e.type === 'item.completed') event(this, 'tool.completed', { tool: e.item.type, detail: e.item, input_id: input.id });
        } else if (e.type === 'item.started' && e.item.type !== 'agent_message') event(this, 'tool.started', { tool: e.item.type, detail: e.item, input_id: input.id });
        else if (e.type === 'turn.completed') event(this, 'turn.completed', { input_id: input.id });
        else if (e.type === 'turn.failed') throw new Error(e.error?.message || 'Codex turn failed');
      }
    } catch (error) { event(this, 'error', { message: String(error), input_id: input.id }); }
  }
  interrupt() { if (!this.busy || !this.controller) throw new Error('no active turn'); this.controller.abort(); }
  close() { this.controller?.abort(); }
}
class ClaudeSession {
  constructor(id, cwd, harnessId) {
    this.id = id; this.harness = 'claude'; this.cwd = cwd; this.harnessId = harnessId;
    this.busy = false; this.queue = []; this.wake = null; this.query = null;
  }
  async *inputs() {
    while (true) {
      if (!this.queue.length) await new Promise(resolve => this.wake = resolve);
      while (this.queue.length) {
        const input = this.queue.shift(); if (input === null) return;
        yield { type: 'user', message: { role: 'user', content: input.content }, parent_tool_use_id: null,
          origin: input.kind === 'service' ? { kind: 'task-notification', subkind: input.source } : { kind: 'human' }, uuid: input.id };
      }
    }
  }
  async send(input) {
    if (input.kind !== 'user' && input.kind !== 'service') throw new Error('unsupported input kind');
    if (input.kind === 'service' && !input.source) throw new Error('service input requires source');
    this.queue.push(input); this.wake?.(); this.wake = null;
    if (!this.busy) { this.busy = true; void this.run().finally(() => { this.busy = false; this.query = null; }); }
  }
  async run() {
    try {
      this.query = query({ prompt: this.inputs(), options: { cwd: this.cwd, resume: this.harnessId || undefined,
        includePartialMessages: true, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true } });
      const blocks = new Map();
      for await (const m of this.query) {
        if (m.type === 'system' && m.subtype === 'init') { this.harnessId = m.session_id; event(this, 'session.started', { harness_id: m.session_id }); }
        else if (m.type === 'stream_event') {
          const e = m.event;
          if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') event(this, 'assistant.delta', { text: e.delta.text });
          if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') { blocks.set(e.index, e.content_block.id); event(this, 'tool.started', { tool: e.content_block.name, tool_id: e.content_block.id }); }
          // content_block_stop only finishes Claude's tool request payload.
          // The tool finishes when the SDK yields a tool_result user block.
          if (e?.type === 'content_block_stop' && blocks.has(e.index)) blocks.delete(e.index);
        } else if (m.type === 'user') {
          for (const block of m.message?.content || []) if (block.type === 'tool_result') {
            event(this, 'tool.completed', { tool_id: block.tool_use_id, detail: block });
          }
        } else if (m.type === 'result') {
          if (m.subtype === 'success') event(this, 'turn.completed', { input_ids: m.user_message_uuids || [] });
          else event(this, 'error', { message: `Claude result: ${m.subtype}` });
        }
      }
    } catch (error) { event(this, 'error', { message: String(error) }); }
  }
  async interrupt() { if (!this.query) throw new Error('no active turn'); await this.query.interrupt(); }
  close() { this.queue.push(null); this.wake?.(); this.query?.close(); }
}
async function handle(m) {
  if (m.version !== 1) return reply(m.id, { error: 'unsupported protocol version' });
  try {
    if (m.op === 'capabilities') return reply(m.id, { capabilities: capabilities(m.harness) });
    if (m.op === 'start' || m.op === 'resume') {
      if (m.harness === 'amplifier') throw new Error('Amplifier SDK chat unavailable in this build');
      if (!['codex', 'claude'].includes(m.harness)) throw new Error('unsupported harness');
      if (sessions.has(m.session_id)) throw new Error('session already open');
      const s = m.harness === 'codex' ? new CodexSession(m.session_id, m.cwd, m.harness_id) : new ClaudeSession(m.session_id, m.cwd, m.harness_id);
      sessions.set(s.id, s); return reply(m.id, { session_id: s.id, capabilities: capabilities(s.harness) });
    }
    const s = sessions.get(m.session_id); if (!s) throw new Error('session not open');
    if (m.op === 'send') { await s.send(m.input); return reply(m.id, { accepted: true }); }
    if (m.op === 'interrupt') { await s.interrupt(m.turn_id); return reply(m.id, { accepted: true }); }
    if (m.op === 'close') { s.close(); sessions.delete(s.id); return reply(m.id, { accepted: true }); }
    throw new Error('unsupported operation');
  } catch (error) { reply(m.id, { error: String(error?.message || error) }); }
}
socket.on('data', data => { pending += data.toString(); for (;;) { const n = pending.indexOf('\n'); if (n < 0) break; const line = pending.slice(0, n); pending = pending.slice(n + 1); try { void handle(JSON.parse(line)); } catch (error) { write({ error: String(error) }); } } });
socket.on('error', error => { console.error(error); process.exitCode = 1; });
socket.on('close', () => process.exit());
