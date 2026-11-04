import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { antigravityEnvironment } from './acp-stream.mjs';
import { nativeConnectors, simpleTitle } from './native-common.mjs';

const script = fileURLToPath(new URL('./antigravity-sdk-host.py', import.meta.url));
const packageVersion = 'google-antigravity==0.1.23';

export class AntigravitySDKStream {
  constructor(session, emit) {
    this.session = session;
    this.emit = emit;
    this.pending = new Map();
    this.nextRequest = 0;
    this.closed = false;
    this.ready = session.catalog ? Promise.resolve() : this.initialize();
  }

  async initialize() {
    const s = this.session;
    const env = antigravityEnvironment('api-key');
    this.secret = env.GEMINI_API_KEY;
    delete env.ANTIGRAVITY_HARNESS_PATH; // The SDK bundles its own runtime.
    env.PYTHONUNBUFFERED = '1';
    env.UV_NO_PROGRESS = '1';
    this.process = spawn('uv', ['run', '--no-project', '--no-managed-python', '--with', packageVersion,
      'python3', script], { cwd: s.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', line => this.onLine(line));
    this.stderr = '';
    this.process.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-2000); });
    this.process.once('error', error => this.fail(error));
    this.process.once('exit', (code, signal) => this.fail(new Error(
      `Antigravity SDK exited (${signal || code}): ${this.stderr}`)));
    const result = await this.request('start', { sessionId: s.id, cwd: s.cwd,
      sourceFolders: s.sourceFolders, nativeId: s.nativeId,
      servers: nativeConnectors(s) }, 90000);
    s.nativeId = result.nativeId;
    this.emit(s.id, 'session.started', { nativeId: s.nativeId, capabilities: {
      approvals: false, transcript_read: false, interrupt: true, live_input: false,
      attributed_service_input: false, native_steering: false } });
  }

  safeError(error) {
    const key = this.secret;
    return key ? String(error).replaceAll(key, '[redacted]') : String(error);
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.reply) {
      const pending = this.pending.get(message.reply);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.reply);
      if (message.error) pending.reject(new Error(this.safeError(message.error)));
      else pending.resolve(message.value);
      return;
    }
    if (!message.event) return;
    const event = message.event;
    if (event === 'turn.started') this.session.busy = true;
    if (['turn.completed', 'turn.cancelled', 'error', 'session.uncertain'].includes(event))
      this.session.busy = false;
    this.emit(this.session.id, event, message.payload || {});
  }

  fail(error) {
    if (this.closed || this.exited) return;
    this.exited = true;
    const message = this.safeError(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    if (this.session.busy) {
      this.session.busy = false;
      this.emit(this.session.id, 'session.uncertain', { message });
    }
  }

  request(op, fields = {}, timeoutMs = 30000) {
    if (this.exited) return Promise.reject(new Error('Antigravity SDK runtime unavailable'));
    const requestId = String(++this.nextRequest);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Antigravity SDK ${op} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.process.stdin.write(JSON.stringify({ requestId, op, ...fields }) + '\n');
    });
  }

  options() { return { model: 'sdk-default', effort: '', models: [{ id: 'sdk-default',
    label: 'Antigravity default', efforts: [], defaultEffort: '' }] }; }
  select(cmd) {
    if ((cmd.model && cmd.model !== 'sdk-default') || cmd.effort)
      throw new Error('Antigravity SDK uses its configured model');
    return this.options();
  }
  title(cmd) { return simpleTitle(cmd); }

  async send(input) {
    await this.ready;
    if (input.kind !== 'user' && input.kind !== 'steer') throw new Error('Unsupported Antigravity SDK input');
    return this.request(input.kind === 'steer' ? 'steer' : 'send', {
      inputId: input.id, content: input.content, displayContent: input.displayContent,
      source: input.source, attachments: input.attachments || [] }, 45000);
  }

  async interrupt() {
    await this.ready;
    return this.request('interrupt');
  }

  async close() {
    this.closed = true;
    await this.ready.catch(() => {});
    if (this.process && !this.exited) {
      await this.request('close', {}, 10000).catch(() => {});
      this.process.kill();
    }
    this.exited = true;
  }
}
