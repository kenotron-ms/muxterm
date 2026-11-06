import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { readFileSync, mkdirSync, writeFileSync, accessSync, statSync, existsSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, delimiter, isAbsolute } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { acknowledgeInboxReminder, readInboxReminder } from './inbox-reminder.mjs';
import { instanceDataHome, instanceMcpEnv } from './instance-xdg.mjs';

const profiles = {
  gemini: { command: 'gemini', args: ['--acp'], env: 'MUXTERM_ACP_GEMINI_COMMAND', mcp: true },
  antigravity: { command: 'agy_acp_server.par', args: process.platform === 'linux' ? ['--uid='] : [], env: 'MUXTERM_ACP_ANTIGRAVITY_COMMAND', mcp: true },
};

export const isACPHarness = harness => Object.hasOwn(profiles, harness);

const runtimes = new Map();
class ACPRuntime {
  constructor(harness) {
    this.harness = harness;
    this.adapters = new Map();
    this.sessionInit = Promise.resolve();
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.stderr = '';
    const profile = profiles[harness];
    const launch = harness === 'antigravity' ? antigravityLaunch() : null;
    const command = harness === 'gemini' ? geminiCommand()
      : launch?.command || process.env[profile.env] || profile.command;
    this.process = spawn(command, launch?.args || profile.args, {
      env: harness === 'gemini' ? geminiEnvironment() : launch?.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.process.on('error', error => this.onExit(error));
    this.process.on('exit', (code, signal) => this.onExit(new Error(
      `${harness} ACP process exited (${signal || code}): ${this.stderr}`)));
    const stream = acp.ndJsonStream(Writable.toWeb(this.process.stdin), Readable.toWeb(this.process.stdout));
    this.connection = new acp.ClientSideConnection(() => ({
      sessionUpdate: params => this.adapters.get(params.sessionId)?.onUpdate(params),
      requestPermission: params => this.adapters.get(params.sessionId)?.onPermission(params)
        || { outcome: { outcome: 'cancelled' } },
    }), stream);
    this.ready = this.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
      .then(result => {
        if (result.protocolVersion !== acp.PROTOCOL_VERSION)
          throw new Error(`Unsupported ACP version: ${result.protocolVersion}`);
        return result;
      });
  }

  register(adapter) { this.adapters.set(adapter.session.nativeId, adapter); }
  detach(adapter) {
    if (this.adapters.get(adapter.session.nativeId) === adapter)
      this.adapters.delete(adapter.session.nativeId);
  }
  onExit(error) {
    if (this.exitError) return;
    this.exitError = error;
    this.resolveExit(error);
    if (runtimes.get(this.harness) === this) runtimes.delete(this.harness);
    for (const adapter of this.adapters.values()) adapter.onExit(error);
    this.adapters.clear();
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.onExit(new Error(`${this.harness} ACP runtime stopped`));
    this.process.stdin.end();
    if (this.process.exitCode === null) this.process.kill('SIGTERM');
  }
}

function runtime(harness) {
  let current = runtimes.get(harness);
  if (!current || current.exitError) { current = new ACPRuntime(harness); runtimes.set(harness, current); }
  return current;
}

export async function stopACPRuntimes() {
  await Promise.all([...runtimes.values()].map(item => item.stop()));
}

export function connectorServers(mcpBin, originFile) {
  if (!mcpBin) return [];
  const dataHome = instanceDataHome();
  const connectionDir = join(dataHome, 'muxterm', 'sdk-chat', 'connections');
  const envEntries = keys => keys.filter(name => process.env[name])
    .map(name => ({ name, value: process.env[name] }));
  const localEnv = Object.entries(instanceMcpEnv()).map(([name, value]) => ({ name, value }));
  const servers = [{ name: 'muxterm', command: mcpBin, args: ['mcp'],
    env: [...localEnv, ...(originFile ? [{ name: 'MUXTERM_CHAT_ORIGIN_FILE', value: originFile }] : [])] }];
  if (existsSync(join(connectionDir, 'github-enabled')))
    servers.push({ name: 'github', command: mcpBin, args: ['connection-mcp', 'github'],
      env: [...localEnv, ...envEntries(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR'])] });
  if (existsSync(join(connectionDir, 'remote.json')))
    servers.push({ name: 'remote', command: mcpBin, args: ['connection-mcp', 'remote'], env: localEnv });
  if (existsSync(join(connectionDir, 'microsoft-graph', 'personal', 'enabled')))
    servers.push({ name: 'microsoft_personal', command: mcpBin, args: ['connection-mcp', 'microsoft-personal'],
      env: [...localEnv, ...envEntries(['PATH', 'HOME'])] });
  return servers;
}

export function antigravityCommand() {
  if (process.env.MUXTERM_ACP_ANTIGRAVITY_COMMAND) return process.env.MUXTERM_ACP_ANTIGRAVITY_COMMAND;
  const dataHome = instanceDataHome();
  // Keep this version in sync with antigravityACPVersion in internal/server/antigravity_install.go.
  const managed = join(dataHome, 'muxterm', 'antigravity-acp', '1.4.3', 'agy_acp_server.par');
  try { accessSync(managed, constants.X_OK); return managed; } catch { return 'agy_acp_server.par'; }
}

export function antigravityMode() {
  const dataHome = instanceDataHome();
  try { return readFileSync(join(dataHome, 'muxterm', 'antigravity-auth-mode'), 'utf8').trim() === 'api-key' ? 'api-key' : 'google'; }
  catch { return 'google'; }
}

export function antigravityEnvironment(mode = antigravityMode()) {
  const env = { ...process.env };
  const command = antigravityCommand();
  if (!env.ANTIGRAVITY_HARNESS_PATH && isAbsolute(command))
    env.ANTIGRAVITY_HARNESS_PATH = join(dirname(command), 'localharness_external');
  if (mode === 'api-key') {
    let key = env.GEMINI_API_KEY?.trim();
    if (!key) for (const name of ['keys.env', 'key.env']) {
      try {
        const data = readFileSync(join(homedir(), '.amplifier', name), 'utf8').slice(0, 65536);
        const line = data.split('\n').find(line => /^\s*(?:export\s+)?GEMINI_API_KEY\s*=/.test(line));
        if (line) { key = line.replace(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2'); break; }
      } catch { /* Try the next standard key file. */ }
    }
    if (!key) throw new Error('GEMINI_API_KEY is not configured');
    env.GEMINI_API_KEY = key;
    delete env.GOOGLE_API_KEY;
  } else {
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
  }
  return env;
}

function cpuList(spec) {
  const values = new Set();
  for (const part of spec.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) continue;
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    if (last < first || last - first > 1024) continue;
    for (let cpu = first; cpu <= last; cpu++) values.add(cpu);
  }
  return values;
}

export function antigravityLaunch(mode = antigravityMode()) {
  const command = antigravityCommand();
  const args = process.platform === 'linux' ? ['--uid='] : [];
  const env = antigravityEnvironment(mode);
  if (process.platform !== 'linux') return { command, args, env };
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const allowed = cpuList(/^Cpus_allowed_list:\s*([^\n]+)/m.exec(status)?.[1] || '');
    const available = new Set([...readFileSync('/proc/cpuinfo', 'utf8').matchAll(/^processor\s*:\s*(\d+)/gm)]
      .map(match => Number(match[1])));
    const safe = [...allowed].filter(cpu => available.has(cpu));
    if (safe.length && safe.length < allowed.size && spawnSync('taskset', ['--version'], { timeout: 1000 }).status === 0)
      return { command: 'taskset', args: ['-c', safe.join(','), command, ...args], env };
  } catch { /* Use the ordinary agent launch when CPU metadata is unavailable. */ }
  return { command, args, env };
}

function geminiCommand() {
  if (process.env.MUXTERM_ACP_GEMINI_COMMAND) return process.env.MUXTERM_ACP_GEMINI_COMMAND;
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const command = join(directory, 'gemini');
    try { if (statSync(command).isFile()) { accessSync(command, constants.X_OK); return command; } }
    catch { /* Try the next directory. */ }
  }
  const prefix = spawnSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf8', timeout: 2000, maxBuffer: 4096 });
  const root = prefix.stdout?.trim();
  if (prefix.status === 0 && isAbsolute(root || '')) {
    const command = join(root, 'bin', 'gemini');
    try { if (statSync(command).isFile()) { accessSync(command, constants.X_OK); return command; } }
    catch { /* Let spawn report the unavailable CLI. */ }
  }
  return 'gemini';
}

function geminiEnvironment() {
  const env = { ...process.env };
  const dataHome = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  let mode = 'google';
  try { mode = readFileSync(join(dataHome, 'muxterm', 'gemini-auth-mode'), 'utf8').trim(); } catch { /* Google sign-in is the default. */ }
  if (mode !== 'api-key') {
    // The CLI may have saved API-key auth from a prior session. Force this
    // launch to use the Google choice selected in muxterm without editing its settings.
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    env.GEMINI_CLI_AUTH_OVERRIDE = 'oauth-personal';
    return env;
  }
  delete env.GEMINI_CLI_AUTH_OVERRIDE;
  let key = env.GEMINI_API_KEY?.trim();
  if (!key) {
    for (const name of ['keys.env', 'key.env']) {
      try {
        const data = readFileSync(join(homedir(), '.amplifier', name), 'utf8').slice(0, 65536);
        const line = data.split('\n').find(line => /^\s*(?:export\s+)?GEMINI_API_KEY\s*=/.test(line));
        if (line) { key = line.replace(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2'); break; }
      } catch { /* Try the next standard key file. */ }
    }
  }
  if (!key) throw new Error('GEMINI_API_KEY is not configured');
  const root = join(dataHome, 'muxterm', 'gemini-api-key');
  mkdirSync(join(root, '.gemini'), { recursive: true, mode: 0o700 });
  const settings = join(root, '.gemini', 'settings.json');
  try { readFileSync(settings); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { writeFileSync(settings, '{"security":{"auth":{"selectedType":"gemini-api-key"}}}\n', { flag: 'wx', mode: 0o600 }); }
    catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
  }
  env.GEMINI_CLI_HOME = root;
  env.GEMINI_API_KEY = key;
  delete env.GOOGLE_API_KEY;
  return env;
}

export class ACPStream {
  constructor(session, emit, onProcessExit) {
    this.session = session;
    this.emit = emit;
    this.onProcessExit = onProcessExit;
    this.tools = new Map();
    this.busy = false;
    this.preparingPrompt = false;
    this.closed = false;
    this.loading = false;
    this.configOptions = [];
    this.modes = null;
    this.steeringExtension = false;
    this.steerPending = false;
    this.interruptForSteer = false;
    this.stopDuringSteer = false;
    this.turnInputIds = [];
    this.continuedInputIds = [];
    const profile = profiles[session.harness];
    if (!profile) throw new Error(`Unknown ACP harness: ${session.harness}`);
    this.profile = profile;
    this.mcpServers = profile.mcp && !session.catalog ? connectorServers(process.env.MUXTERM_CHAT_MCP_BIN, session.originFile) : [];
    this.runtime = runtime(session.harness);
    this.exited = this.runtime.exited;
    this.connection = this.runtime.connection;
    this.ready = this.initialize();
  }

  async initialize() {
    const result = await this.withExit(this.runtime.ready);
    this.agentCapabilities = result.agentCapabilities || {};
    this.steeringExtension = result._meta?.steering?.supported === true;
    // Some agents stall when two native sessions initialize at cold start.
    const priorInit = this.runtime.sessionInit;
    let releaseInit;
    this.runtime.sessionInit = new Promise(resolve => { releaseInit = resolve; });
    await priorInit;
    try {
    let session;
    const params = { cwd: this.session.cwd, mcpServers: this.mcpServers,
      ...(this.session.sourceFolders.length && this.agentCapabilities.sessionCapabilities?.additionalDirectories
        ? { additionalDirectories: this.session.sourceFolders } : {}) };
    if (this.session.nativeId) {
      this.loading = true;
      try {
        if (this.agentCapabilities.sessionCapabilities?.resume) session = await this.withExit(this.connection.resumeSession({ ...params, sessionId: this.session.nativeId }));
        // Gemini CLI advertises the legacy load capability and uses its raw
        // session/load RPC here; revisit this when its ACP shape changes.
        else if (this.agentCapabilities.loadSession) session = await this.withExit(this.session.harness === 'gemini'
          ? this.connection.request('session/load', { ...params, sessionId: this.session.nativeId })
          : this.connection.loadSession({ ...params, sessionId: this.session.nativeId }));
        else throw new Error(`${this.session.harness} does not advertise ACP session recovery`);
      } finally { this.loading = false; }
    } else {
      session = await this.withExit(this.connection.newSession(params));
      if (!session?.sessionId) throw new Error(`${this.session.harness} did not return an ACP session ID`);
      this.session.nativeId = session.sessionId;
    }
    this.runtime.register(this);
    this.configOptions = session.configOptions || [];
    this.modes = session.modes || null;
    // Gemini CLI still publishes its model selector in the older ACP `models`
    // response field. Remove this shim when Gemini publishes configOptions.
    this.legacyModels = this.session.harness === 'gemini' ? session.models || null : null;
    this.startupInfo = session._meta?.piAcp?.startupInfo || '';
    this.startupBuffer = '';
    // A resumed ACP process starts with the agent's own defaults. Restore the
    // selections saved with this muxterm conversation before accepting input.
    await this.applySelection(this.session.model, this.session.effort);
    this.emit(this.session.id, 'session.started', { nativeId: this.session.nativeId, capabilities: this.capabilities() });
    } finally { releaseInit(); }
  }

  capabilities() {
    return { approvals: false, transcript_read: false, interrupt: true, live_input: false,
      attributed_service_input: false, native_steering: this.steeringExtension };
  }

  withExit(promise) {
    return Promise.race([promise, this.exited.then(error => { throw error; })]);
  }

  onExit(error) {
    if (this.closed || this.exitError) return;
    this.exitError = error;
    if (this.busy) this.emit(this.session.id, 'session.uncertain', { message: String(error) });
    this.onProcessExit?.();
  }

  onPermission(params) {
    // Existing SDK chats run with approval=never. Honor only the agent's own
    // one-shot allow option; never manufacture an option ID or a lasting grant.
    if (params.sessionId !== this.session.nativeId || this.closed || this.session.cancelRequested)
      return { outcome: { outcome: 'cancelled' } };
    this.confirmAccepted?.();
    const option = params.options.find(item => item.kind === 'allow_once');
    return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
  }

  onUpdate(params) {
    if (params.sessionId !== this.session.nativeId || this.closed || this.loading) return;
    const update = params.update;
    // ACP may split a native startup banner across text chunks.
    let messageText = update.content?.text;
    if (this.startupInfo && update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const candidate = this.startupBuffer + (messageText || '');
      if (this.startupInfo.startsWith(candidate)) {
        this.startupBuffer = candidate;
        if (candidate === this.startupInfo) {
          this.startupInfo = '';
          this.startupBuffer = '';
        }
        return;
      }
      messageText = candidate.startsWith(this.startupInfo) ? candidate.slice(this.startupInfo.length) : candidate;
      this.startupInfo = '';
      this.startupBuffer = '';
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && !messageText) return;
    if (this.busy && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(update.sessionUpdate))
      this.turnActivity = true;
    if (this.busy && (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'usage_update'].includes(update.sessionUpdate)
      || (update.sessionUpdate === 'session_info_update' && update._meta?.piAcp?.running === true))) this.confirmAccepted?.();
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && messageText)
      this.emit(this.session.id, 'assistant.delta', { text: messageText });
    else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const id = update.toolCallId;
      const prior = this.tools.get(id);
      const name = update.title || update.name || prior?.name || 'Tool';
      const input = update.rawInput ?? prior?.input ?? update.content ?? null;
      if (!prior) {
        this.tools.set(id, { name, input });
        this.emit(this.session.id, 'tool.started', { toolId: id, name, raw: input });
      } else if (name !== prior.name || update.rawInput !== undefined) {
        this.tools.set(id, { name, input });
        this.emit(this.session.id, 'tool.started', { toolId: id, name, raw: input });
      }
      if (update.status === 'completed' || update.status === 'failed') {
        this.emit(this.session.id, 'tool.completed', { toolId: id, name, raw: update.rawOutput ?? update.content ?? null,
          failed: update.status === 'failed' });
        this.tools.delete(id);
      }
    } else if (update.sessionUpdate === 'plan') {
      const plan = (update.entries || []).map(entry => ({ step: entry.content, status: entry.status }));
      this.emit(this.session.id, 'tool.started', { toolId: 'acp-plan', name: 'update_plan', raw: { plan } });
      this.emit(this.session.id, 'tool.completed', { toolId: 'acp-plan', name: 'update_plan', raw: { plan } });
    } else if (update.sessionUpdate === 'config_option_update') this.configOptions = update.configOptions || [];
    else if (update.sessionUpdate === 'current_mode_update' && this.modes) this.modes.currentModeId = update.currentModeId;
  }

  async start() { await this.ready; }

  async promptBlocks(input) {
    const prompt = [{ type: 'text', text: input.content || 'Please inspect the attached files.' }];
    if (input.kind === 'user') {
      try {
        const reminder = await readInboxReminder(this.session.id, this.session.originFile);
        if (reminder) {
          this.reminderCursor = reminder.cursor;
          // Some ACP agents inspect only the first text block. Keep the
          // notification with the user's request while marking it as data.
          prompt[0].text = `${reminder.text}\n\n${prompt[0].text}`;
        }
      } catch (error) { console.error(`ACP inbox reminder: ${error}`); }
    }
    for (const attachment of input.attachments || []) {
      // The upload store sniffs image bytes; filenames do not establish MIME type.
      const imageType = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.contentType)
        ? attachment.contentType : '';
      if (attachment.kind === 'image' && this.agentCapabilities.promptCapabilities?.image && imageType) {
        const { readFile } = await import('node:fs/promises');
        const data = await readFile(attachment.path);
        prompt.push({ type: 'image', data: data.toString('base64'), mimeType: imageType });
      } else prompt.push({ type: 'text', text: `\nAttached file: ${attachment.name} (${attachment.path})` });
    }
    return prompt;
  }

  emitAccepted(input) {
    this.emit(this.session.id, 'input.accepted', { inputId: input.id, kind: input.kind, source: input.source,
      text: input.displayContent || input.content,
      attachments: (input.attachments || []).map(({ id, name, kind }) => ({ id, name, kind })) });
  }

  async send(input) {
    await this.ready;
    if (input.kind !== 'user' && input.kind !== 'steer')
      throw new Error(`${this.session.harness} ACP does not support ${input.kind} input`);
    if (input.kind === 'steer') {
      if (!this.busy) throw new Error('No active ACP turn to steer');
      if (this.steerPending) throw new Error('A steer is already being delivered');
      this.steerPending = true;
      this.stopDuringSteer = false;
      try {
        const prompt = await this.promptBlocks(input);
        if (!this.busy || this.stopDuringSteer)
          throw new Error('Turn ended before the steer could be delivered');
        if (this.steeringExtension) {
          const result = await this.withExit(this.connection.request('_session/steering', {
            sessionId: this.session.nativeId, prompt, _meta: { steering: { idleBehavior: 'promptRequired' } },
          }));
          if (result.outcome === 'injected') {
            if (this.stopDuringSteer) throw new Error('Turn stopped before the steer was delivered');
            this.turnInputIds.push(input.id);
            this.emitAccepted(input);
            this.emit(this.session.id, 'turn.continued');
            return { status: 'accepted', inputId: input.id };
          }
          if (result.outcome !== 'promptRequired') throw new Error(`Unsupported ACP steering outcome: ${result.outcome}`);
          this.interruptForSteer = true;
          await this.turnPromise;
          this.interruptForSteer = false;
        } else {
          // ACP v1 has no standard mid-turn injection. Stop the active prompt,
          // keep its partial output, and immediately continue with the steer.
          this.interruptForSteer = true;
          this.session.cancelRequested = true;
          await this.connection.cancel({ sessionId: this.session.nativeId });
          await this.turnPromise;
          // The next prompt is a normal turn; clear this before it can resolve.
          this.interruptForSteer = false;
        }
        if (this.stopDuringSteer) throw new Error('Turn stopped before the steer was delivered');
        if (this.exitError || this.closed) throw new Error('ACP session ended before the steer was delivered');
        return await this.startPrompt(input, prompt);
      } finally {
        this.steerPending = false;
        this.interruptForSteer = false;
        // Keep a concurrent user stop pending until its active turn settles.
        if (!this.stopDuringSteer || !this.busy) this.session.cancelRequested = false;
        this.stopDuringSteer = false;
      }
    }
    if (this.busy || this.preparingPrompt || this.steerPending)
      throw new Error('Finish the current ACP turn before sending another message');
    this.preparingPrompt = true;
    try {
      return await this.startPrompt(input, await this.promptBlocks(input));
    } finally {
      this.preparingPrompt = false;
    }
  }

  async startPrompt(input, prompt) {
    this.busy = true;
    this.session.busy = true;
    this.session.cancelRequested = false;
    this.turnActivity = false;
    this.turnInputIds = [...this.continuedInputIds, input.id];
    this.continuedInputIds = [];
    let accepted = false;
    let resolveEvidence, rejectEvidence;
    const evidence = new Promise((resolve, reject) => { resolveEvidence = resolve; rejectEvidence = reject; });
    this.confirmAccepted = () => {
      if (accepted) return;
      accepted = true;
      this.emitAccepted(input);
      resolveEvidence();
    };
    this.turnPromise = this.withExit(this.connection.prompt({ sessionId: this.session.nativeId, prompt })).then(result => {
      this.confirmAccepted();
      if (this.interruptForSteer && !this.stopDuringSteer) {
        this.continuedInputIds = this.turnInputIds;
        this.emit(this.session.id, 'turn.continued');
      } else if (result.stopReason === 'cancelled') {
        this.reminderCursor = 0;
        this.emit(this.session.id, 'turn.cancelled', { inputIds: this.turnInputIds, message: result.stopReason });
      }
      else if (result.stopReason === 'end_turn' && !this.turnActivity) {
        this.reminderCursor = 0;
        this.emit(this.session.id, 'error', { inputIds: this.turnInputIds, message: `${this.session.harness} ended the ACP turn without an answer or tool activity. Check its provider credentials and agent logs.` });
      }
      else if (result.stopReason === 'end_turn') {
        this.emit(this.session.id, 'turn.completed', { inputIds: this.turnInputIds, message: result.stopReason });
        if (this.reminderCursor) void acknowledgeInboxReminder(this.session.id, this.reminderCursor, this.session.originFile)
          .catch(error => console.error(`ACP inbox acknowledgement: ${error}`));
        this.reminderCursor = 0;
      }
      else this.emit(this.session.id, 'error', { inputIds: this.turnInputIds, message: `ACP turn stopped: ${result.stopReason}` });
    }).catch(error => {
      if (!accepted) rejectEvidence(error);
      else if (this.interruptForSteer && this.stopDuringSteer && !this.exitError && !this.closed)
        this.emit(this.session.id, 'turn.cancelled', { inputIds: this.turnInputIds, message: 'cancelled' });
      else if (this.interruptForSteer && !this.exitError && !this.closed) {
        this.continuedInputIds = this.turnInputIds;
        this.emit(this.session.id, 'turn.continued');
      }
      else if (!this.exitError && !this.closed) {
        // Submission may have reached the agent before its reply failed.
        // A closed connection can reject before the process exit callback.
        this.busy = false;
        this.session.busy = false;
        this.emit(this.session.id, 'session.uncertain', { inputIds: this.turnInputIds, message: String(error) });
        if (String(error).includes('ACP connection closed')) void this.runtime.stop();
      }
    }).finally(() => {
      this.busy = false;
      this.session.busy = false;
      this.session.cancelRequested = false;
      this.confirmAccepted = null;
    });
    await evidence;
    return { status: 'accepted', inputId: input.id };
  }

  async interrupt() {
    if (!this.busy) throw new Error('No active turn to stop');
    if (this.steerPending) this.stopDuringSteer = true;
    this.session.cancelRequested = true;
    await this.connection.cancel({ sessionId: this.session.nativeId });
    return { status: 'accepted' };
  }

  options() {
    const model = this.configOptions.find(item => item.type === 'select' && item.category === 'model');
    const effort = this.configOptions.find(item => item.type === 'select' && item.category === 'thought_level');
    const entries = model?.options?.flatMap(item => item.options || [item]) || [];
    const effortEntries = effort?.options?.flatMap(item => item.options || [item]) || [];
    if (!model && this.legacyModels) return { provider: 'configured', model: this.legacyModels.currentModelId || '', effort: '',
      models: (this.legacyModels.availableModels || []).map(item => ({ id: item.modelId, label: item.name || item.modelId,
        efforts: [], defaultEffort: '' })) };
    return { provider: 'configured', model: model?.currentValue || '', effort: effort?.currentValue || '',
      models: entries.map(item => ({ id: item.value, label: item.name,
        efforts: effortEntries.map(value => value.value), defaultEffort: effort?.currentValue || '' })) };
  }

  async applySelection(model, effort) {
    if (this.busy) throw new Error('Finish the current turn before changing settings');
    if (model && this.legacyModels && !this.configOptions.some(item => item.type === 'select' && item.category === 'model')) {
      if (!(this.legacyModels.availableModels || []).some(item => item.modelId === model)) throw new Error('Unsupported Gemini model');
      if (model !== this.legacyModels.currentModelId) {
        await this.withExit(this.connection.request('session/set_model', { sessionId: this.session.nativeId, modelId: model }));
        this.legacyModels.currentModelId = model;
      }
      model = '';
    }
    for (const [category, value] of [['model', model], ['thought_level', effort]]) {
      const option = this.configOptions.find(item => item.type === 'select' && item.category === category);
      if (value && option && value !== option.currentValue) {
        const result = await this.withExit(this.connection.setSessionConfigOption({ sessionId: this.session.nativeId, configId: option.id, value }));
        this.configOptions = result.configOptions || [];
      } else if (value && !option) throw new Error(`ACP agent does not expose ${category} selection`);
    }
  }

  async select(cmd) {
    await this.ready;
    await this.applySelection(cmd.model, cmd.effort);
    return this.options();
  }

  title(cmd) {
    if (cmd.mode === 'read') return { name: '', source: '' };
    return { name: cmd.name || '', source: cmd.mode === 'manual' ? 'manual' : 'generated' };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => {});
    this.runtime.detach(this);
    if (!this.runtime.exitError && this.session.nativeId)
      await this.withExit(this.connection.closeSession({ sessionId: this.session.nativeId }));
  }
}
