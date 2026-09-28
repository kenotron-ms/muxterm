import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';

const codexCLI = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');

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
    this.process = spawn(process.execPath, [codexCLI, 'app-server', '--stdio'], {
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
    await this.request('initialize', { clientInfo: { name: 'muxterm', title: 'muxterm SDK chat', version: '1' }, capabilities: null });
    this.process.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const options = { cwd: this.session.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' };
    const result = await this.request(this.session.nativeId ? 'thread/resume' : 'thread/start',
      this.session.nativeId ? { threadId: this.session.nativeId, ...options } : options);
    this.session.nativeId = result.thread.id;
    this.emit(this.session.id, 'session.started', { nativeId: result.thread.id,
      capabilities: { approvals: false, transcript_read: false, interrupt: true,
        live_input: false, attributed_service_input: false, native_steering: false } });
  }

  async run(input) {
    await this.ready;
    this.session.busy = true;
    this.inputId = input.id;
    this.textByItem.clear();
    try {
      const items = [{ type: 'text', text: input.content, text_elements: [] }];
      for (const attachment of input.attachments || []) {
        if (attachment.kind === 'image') items.push({ type: 'localImage', path: attachment.path });
      }
      const result = await this.request('turn/start', { threadId: this.session.nativeId,
        input: items });
      this.turnId = result.turn.id;
    } catch (error) {
      this.session.busy = false;
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
    if (!p || p.threadId !== this.session.nativeId) return;
    if (method === 'item/agentMessage/delta') {
      this.textByItem.set(p.itemId, (this.textByItem.get(p.itemId) || '') + p.delta);
      if (p.delta) this.emit(this.session.id, 'assistant.delta', { text: p.delta });
    } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
      // Keep compatibility with an older app-server that only sends a final item.
      const sent = this.textByItem.get(p.item.id) || '';
      const full = p.item.text || '';
      const rest = full.startsWith(sent) ? full.slice(sent.length) : full;
      if (rest) this.emit(this.session.id, 'assistant.delta', { text: rest });
    } else if (method === 'item/started' && p.item?.type !== 'agentMessage' && p.item?.type !== 'reasoning' && p.item?.type !== 'userMessage') {
      this.emit(this.session.id, 'tool.started', { name: p.item.type, toolId: p.item.id, raw: p.item });
    } else if (method === 'item/completed' && p.item?.type !== 'agentMessage' && p.item?.type !== 'reasoning' && p.item?.type !== 'userMessage') {
      this.emit(this.session.id, 'tool.completed', { name: p.item.type, toolId: p.item.id, raw: p.item });
    } else if (method === 'turn/completed') {
      this.session.busy = false;
      this.turnId = null;
      this.emit(this.session.id, p.turn.status === 'completed' ? 'turn.completed' : 'error',
        { inputIds: [this.inputId], message: p.turn.error?.message || p.turn.status });
    }
  }

  async interrupt() {
    if (this.turnId) await this.request('turn/interrupt', { threadId: this.session.nativeId, turnId: this.turnId });
  }

  close() { this.process.kill('SIGTERM'); }

  fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.session.busy) {
      this.session.busy = false;
      this.emit(this.session.id, 'error', { message: String(error) });
    }
  }
}
