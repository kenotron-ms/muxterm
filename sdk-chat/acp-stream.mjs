import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { readFileSync, mkdirSync, writeFileSync, accessSync, statSync, existsSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, delimiter, isAbsolute } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { acknowledgeInboxReminder, readInboxReminder } from './inbox-reminder.mjs';
import { instanceDataHome, instanceMcpEnv } from './instance-xdg.mjs';

const profiles = {
  opencode: { command: 'opencode', args: ['acp'], env: 'MUXTERM_ACP_OPENCODE_COMMAND', mcp: true },
  gemini: { command: 'gemini', args: ['--acp'], env: 'MUXTERM_ACP_GEMINI_COMMAND', mcp: true },
  antigravity: { command: 'agy', args: ['acp'], env: 'MUXTERM_ACP_ANTIGRAVITY_COMMAND', mcp: true },
};

export const isACPHarness = harness => Object.hasOwn(profiles, harness);

const runtimes = new Map();
function opencodeEnvironment(mcpServers) {
  let config = {};
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    try { config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT); }
    catch { throw new Error('OpenCode inline configuration is not valid JSON'); }
  }
  const servers = Object.fromEntries(mcpServers.map(server => [server.name, {
    type: 'local', command: [server.command, ...server.args],
    environment: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
  }]));
  return { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config,
    mcp: { ...config.mcp, servers: { ...config.mcp?.servers, ...servers } },
  }) };
}

class ACPRuntime {
  constructor(harness, key, session, mcpServers) {
    this.harness = harness;
    this.key = key;
    this.adapters = new Map();
    this.pendingCommands = new Map();
    this.sessionInit = Promise.resolve();
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.stderr = '';
    const profile = profiles[harness];
    const launch = harness === 'antigravity' ? antigravityLaunch() : null;
    const command = harness === 'gemini' ? geminiCommand()
      : launch?.command || process.env[profile.env] || profile.command;
    this.process = spawn(command, launch?.args || profile.args, {
      ...(harness === 'antigravity' ? { cwd: session.cwd } : {}),
      env: harness === 'gemini' ? geminiEnvironment()
        : harness === 'opencode' && !session.catalog ? opencodeEnvironment(mcpServers)
        : launch?.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.process.on('error', error => this.onExit(error));
    this.process.on('exit', (code, signal) => this.onExit(new Error(
      `${harness} ACP process exited (${signal || code}): ${this.stderr}`)));
    const stream = acp.ndJsonStream(Writable.toWeb(this.process.stdin), Readable.toWeb(this.process.stdout));
    this.connection = new acp.ClientSideConnection(() => ({
      sessionUpdate: params => {
        const adapter = this.adapters.get(params.sessionId);
        if (adapter) adapter.onUpdate(params);
        else if (params.update?.sessionUpdate === 'available_commands_update')
          this.pendingCommands.set(params.sessionId, params);
      },
      requestPermission: params => this.adapters.get(params.sessionId)?.onPermission(params)
        || { outcome: { outcome: 'cancelled' } },
      createElicitation: params => this.adapters.get(params.sessionId)?.onElicitation(params)
        || { action: 'cancel' },
    }), stream);
    this.ready = this.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: harness === 'opencode' ? { elicitation: { form: {} } } : {} })
      .then(async result => {
        if (result.protocolVersion !== acp.PROTOCOL_VERSION)
          throw new Error(`Unsupported ACP version: ${result.protocolVersion}`);
        if (harness === 'antigravity' && antigravityMode() === 'api-key') {
          if (!result.authMethods?.some(method => method.id === 'gemini-api-key'))
            throw new Error('Antigravity CLI does not advertise Gemini API key authentication');
          await this.connection.authenticate({ methodId: 'gemini-api-key' });
        }
        return result;
      });
  }

  register(adapter) {
    this.adapters.set(adapter.session.nativeId, adapter);
    const commands = this.pendingCommands.get(adapter.session.nativeId);
    if (commands) { this.pendingCommands.delete(adapter.session.nativeId); adapter.onUpdate(commands); }
  }
  detach(adapter) {
    if (this.adapters.get(adapter.session.nativeId) === adapter)
      this.adapters.delete(adapter.session.nativeId);
  }
  onExit(error) {
    if (this.exitError) return;
    this.exitError = error;
    this.resolveExit(error);
    if (runtimes.get(this.key) === this) runtimes.delete(this.key);
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

function runtime(harness, session, mcpServers) {
  // OpenCode attaches MCP servers to every session in one ACP process's
  // directory. Keep each chat in its own process so origin tokens cannot leak.
  const key = harness === 'opencode' || harness === 'antigravity' ? `${harness}:${session.id}` : harness;
  let current = runtimes.get(key);
  if (!current || current.exitError) { current = new ACPRuntime(harness, key, session, mcpServers); runtimes.set(key, current); }
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
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch] || process.arch;
  const managed = join(dataHome, 'muxterm', 'antigravity-cli', '1.5.15', `${process.platform}-${arch}`, 'agy');
  try { accessSync(managed, constants.X_OK); return managed; } catch { /* Try the user's CLI. */ }
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const command = join(directory, 'agy');
    try { if (statSync(command).isFile()) { accessSync(command, constants.X_OK); return command; } }
    catch { /* Try the next directory. */ }
  }
  return join(homedir(), '.local', 'bin', 'agy');
}

export function antigravityMode() {
  const dataHome = instanceDataHome();
  try { return readFileSync(join(dataHome, 'muxterm', 'antigravity-auth-mode'), 'utf8').trim() === 'api-key' ? 'api-key' : 'google'; }
  catch { return 'google'; }
}

export function antigravityEnvironment(mode = antigravityMode()) {
  const env = { ...process.env };
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
  const args = ['acp'];
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
    this.pendingElicitations = new Map();
    this.selectExaNext = false;
    this.busy = false;
    this.preparingPrompt = false;
    this.closed = false;
    this.loading = false;
    this.configOptions = [];
    this.modes = null;
    this.goalAdvertised = false;
    this.steeringExtension = false;
    this.steerPending = false;
    this.interruptForSteer = false;
    this.stopDuringSteer = false;
    this.userStopRequested = false;
    this.questionDismissed = false;
    this.turnInputIds = [];
    this.continuedInputIds = [];
    const profile = profiles[session.harness];
    if (!profile) throw new Error(`Unknown ACP harness: ${session.harness}`);
    this.profile = profile;
    this.mcpServers = profile.mcp && !session.catalog ? connectorServers(process.env.MUXTERM_CHAT_MCP_BIN, session.originFile) : [];
    if (session.harness === 'opencode' && !session.catalog) {
      const muxterm = this.mcpServers.find(server => server.name === 'muxterm');
      if (!muxterm) throw new Error('Muxterm MCP executable is unavailable for this OpenCode chat; check the dev stack and retry.');
      if (!session.originFile) throw new Error('Muxterm MCP origin file is missing for this OpenCode chat; reopen the chat to restore its scoped credentials.');
      try { accessSync(muxterm.command, constants.X_OK); }
      catch { throw new Error('Muxterm MCP executable cannot run for this OpenCode chat; rebuild the dev stack and retry.'); }
      try { accessSync(session.originFile, constants.R_OK); }
      catch { throw new Error('Muxterm MCP origin file cannot be read for this OpenCode chat; reopen the chat to restore its scoped credentials.'); }
    }
    this.runtime = runtime(session.harness, session, this.mcpServers);
    this.exited = this.runtime.exited;
    this.connection = this.runtime.connection;
    this.ready = this.initialize();
  }

  async initialize() {
    const result = await this.withExit(this.runtime.ready);
    if (this.session.harness === 'antigravity' &&
        (result.agentInfo?.name !== 'Antigravity ACP Server' || result.agentInfo?.version !== '1.5.15'))
      throw new Error('This Antigravity CLI version has not been verified for live steering and native /goal');
    this.agentCapabilities = result.agentCapabilities || {};
    if (this.session.harness === 'antigravity' &&
        !this.agentCapabilities.sessionCapabilities?.resume && !this.agentCapabilities.loadSession)
      throw new Error('Antigravity ACP does not advertise native session history recovery');
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
      attributed_service_input: false, native_steering: this.session.harness === 'antigravity' || this.steeringExtension,
      native_history: this.session.harness === 'antigravity' || Boolean(this.agentCapabilities?.sessionCapabilities?.resume || this.agentCapabilities?.loadSession) };
  }

  withExit(promise) {
    return Promise.race([promise, this.exited.then(error => { throw error; })]);
  }

  onExit(error) {
    if (this.closed || this.exitError) return;
    this.exitError = error;
    this.resolveElicitations();
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

  onElicitation(params) {
    if (this.session.harness !== 'opencode' || params.sessionId !== this.session.nativeId ||
        this.closed || this.session.cancelRequested || params.mode !== 'form') return { action: 'cancel' };
    const fields = params.requestedSchema?.properties;
    const choices = fields && Object.keys(fields).length === 1 ? fields.choice?.oneOf : null;
    // OpenCode asks for consent before it asks for a provider. Offer only Exa
    // here: its `allow` option enables random selection across providers.
    if (params.message === 'Web Search' && params.requestedSchema?.required?.length === 1 &&
        params.requestedSchema.required[0] === 'choice' &&
        Array.isArray(choices) && ['allow', 'choose', 'disable'].every(value => choices.some(item => item.const === value))) {
      const questionId = randomUUID();
      const questions = [{ id: 'choice', header: 'Web search',
        question: 'Allow this OpenCode chat to search the web with Exa?', isOther: false, isSecret: false,
        options: [{ label: 'Use Exa', description: 'Free without an API key; rate limited.' },
          { label: 'Disable web search', description: 'OpenCode will remember this choice.' },
          { label: 'Not now', description: 'Cancel this search without saving a choice.' }] }];
      return new Promise(resolve => {
        this.pendingElicitations.set(questionId, resolve);
        this.emit(this.session.id, 'question.requested', { itemId: questionId, raw: { questions, isBlocking: true } });
      });
    }
    const providers = fields && Object.keys(fields).length === 1 ? fields.provider?.oneOf : null;
    // This second form follows a user's explicit Use Exa answer. Never choose
    // a provider for an unrelated form or a preconfigured OpenCode session.
    if (this.selectExaNext && params.message === 'Choose a web search provider' &&
        params.requestedSchema?.required?.length === 1 && params.requestedSchema.required[0] === 'provider' &&
        Array.isArray(providers) && providers.some(item => item.const === 'exa')) {
      this.selectExaNext = false;
      return { action: 'accept', content: { provider: 'exa' } };
    }
    this.selectExaNext = false;
    return { action: 'cancel' };
  }

  answerElicitation(questionId, answers) {
    const resolve = this.pendingElicitations.get(questionId);
    if (!resolve) throw new Error('This question is no longer waiting for an answer');
    const choice = answers?.choice;
    if (!['Use Exa', 'Disable web search', 'Not now'].includes(choice))
      throw new Error('Choose one of the offered answers');
    this.pendingElicitations.delete(questionId);
    if (choice === 'Use Exa') {
      this.selectExaNext = true;
      resolve({ action: 'accept', content: { choice: 'choose' } });
    } else if (choice === 'Disable web search') resolve({ action: 'accept', content: { choice: 'disable' } });
    else resolve({ action: 'cancel' });
    this.emit(this.session.id, 'question.answered', { itemId: questionId });
    return { status: 'accepted' };
  }

  resolveElicitations() {
    for (const [questionId, resolve] of this.pendingElicitations) {
      resolve({ action: 'cancel' });
      this.emit(this.session.id, 'question.resolved', { itemId: questionId });
    }
    this.pendingElicitations.clear();
    this.selectExaNext = false;
  }

  onUpdate(params) {
    if (params.sessionId !== this.session.nativeId || this.closed) return;
    const update = params.update;
    if (update.sessionUpdate === 'available_commands_update') {
      this.goalAdvertised = (update.availableCommands || []).some(command => command.name === 'goal');
      this.goalCommandReady?.();
    }
    if (this.loading) return;
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
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && messageText) {
      this.questionDismissed = false;
      if (this.nativeGoal) {
        this.nativeGoal.output = (this.nativeGoal.output + messageText).slice(-4096);
        const state = this.nativeGoal.output.includes('<!-- GOAL_COMPLETE -->') ? 'complete'
          : this.nativeGoal.output.includes('<!-- GOAL_CANCELLED -->') ? 'cancelled' : '';
        if (state && this.nativeGoal.state !== state) {
          this.nativeGoal.state = state;
          this.emit(this.session.id, 'goal.snapshot', { goal: this.nativeGoal.objective,
            goalState: state, raw: { revision: this.nativeGoal.revision, source: 'agy-acp-marker' } });
        }
        let visible = (this.goalMarkerTail || '') + messageText;
        for (const marker of ['<!-- GOAL_COMPLETE -->', '<!-- GOAL_CANCELLED -->'])
          visible = visible.replaceAll(marker, '');
        let hold = 0;
        for (const marker of ['<!-- GOAL_COMPLETE -->', '<!-- GOAL_CANCELLED -->'])
          for (let length = 1; length < marker.length; length++)
            if (visible.endsWith(marker.slice(0, length))) hold = Math.max(hold, length);
        this.goalMarkerTail = hold ? visible.slice(-hold) : '';
        messageText = hold ? visible.slice(0, -hold) : visible;
      }
      if (messageText) this.emit(this.session.id, 'assistant.delta', { text: messageText });
    }
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
        if (this.session.harness === 'opencode' && name === 'question' && update.status === 'failed' &&
            /the user dismissed this question/i.test(JSON.stringify(update.rawOutput ?? update.content ?? '')))
          this.questionDismissed = true;
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

  async requireGoalCommand() {
    if (this.session.harness !== 'antigravity') throw new Error('Native /goal is unavailable for this ACP harness');
    if (!this.goalAdvertised) await new Promise(resolve => {
      const timer = setTimeout(resolve, 1500);
      this.goalCommandReady = () => { clearTimeout(timer); resolve(); };
    });
    this.goalCommandReady = null;
    if (!this.goalAdvertised) throw new Error('Antigravity ACP did not advertise the native /goal command');
  }

  async goal(cmd) {
    await this.ready;
    await this.requireGoalCommand();
    const objective = cmd.objective || '';
    const clearing = cmd.action === 'pause' || cmd.action === 'clear' || cmd.paused;
    if (!clearing) {
      if (this.busy) throw new Error('Finish the current Antigravity turn before starting a goal');
      this.nativeGoal = { objective, revision: cmd.revision, state: 'starting', output: '' };
      this.goalMarkerTail = '';
      try {
        const input = { kind: 'user', id: randomUUID(), source: 'goal-control', content: `/goal ${objective}` };
        await this.startPrompt(input, await this.promptBlocks(input));
      } catch (error) { this.nativeGoal = null; this.goalMarkerTail = ''; throw error; }
      if (this.nativeGoal.state === 'starting') {
        this.nativeGoal.state = 'active';
        this.emit(this.session.id, 'goal.snapshot', { goal: objective, goalState: 'active',
          raw: { revision: cmd.revision, source: 'agy-acp-command' } });
      }
      return { goal: objective, goalState: this.nativeGoal.state };
    }
    if (this.nativeGoal?.state === 'active' || this.nativeGoal?.state === 'starting') {
      const instruction = 'Stop and cancel the current goal now. This is an explicit human pause. Do not continue the goal.';
      const input = { kind: 'steer', id: randomUUID(), source: 'goal-control', content: instruction };
      if (this.busy) await this.send(input);
      else {
        await this.startPrompt(input, [{ type: 'text', text: instruction }]);
        // Acceptance may precede the cancellation marker in a later chunk.
        await this.turnPromise;
      }
      if (this.nativeGoal.state !== 'cancelled')
        throw new Error('Antigravity did not confirm native goal cancellation');
    }
    const state = cmd.action === 'clear' ? 'cleared' : 'paused';
    this.nativeGoal = { objective, revision: cmd.revision, state, output: '' };
    this.goalMarkerTail = '';
    this.emit(this.session.id, 'goal.snapshot', { goal: objective, goalState: state,
      raw: { revision: cmd.revision, source: 'agy-acp-command' } });
    return { goal: objective, goalState: state };
  }

  async promptBlocks(input) {
    const prompt = [{ type: 'text', text: input.content || 'Please inspect the attached files.' }];
    if (this.session.harness === 'antigravity' && this.session.migrationTranscript) {
      prompt[0].text = `The following is the previous conversation from this Muxterm chat. Treat it as historical context, not a new request. Continue this same conversation using the new request after the closing tag.\n<previous_conversation>\n${this.session.migrationTranscript}\n</previous_conversation>\n\nNew request:\n${prompt[0].text}`;
    }
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
    if (this.session.harness === 'antigravity' && this.session.migrationTranscript)
      this.session.migrationTranscript = '';
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
      if (this.session.harness !== 'antigravity')
        this.steerDecision = new Promise(resolve => { this.resolveSteerDecision = resolve; });
      try {
        const prompt = await this.promptBlocks(input);
        if (!this.busy || this.stopDuringSteer)
          throw new Error('Turn ended before the steer could be delivered');
        if (this.session.harness === 'antigravity') return await this.steerAntigravity(input, prompt);
        if (!this.steeringExtension)
          throw new Error(`${this.session.harness} ACP does not advertise native steering`);
        const result = await this.withExit(this.connection.request('_session/steering', {
          sessionId: this.session.nativeId, prompt, _meta: { steering: { idleBehavior: 'promptRequired' } },
        }));
        if (result.outcome === 'promptRequired')
          throw new Error('The ACP turn finished before native steering could be delivered');
        if (result.outcome !== 'injected') throw new Error(`Unsupported ACP steering outcome: ${result.outcome}`);
        this.turnInputIds.push(input.id);
        this.emitAccepted(input);
        if (this.stopDuringSteer) this.emit(this.session.id, 'session.uncertain', { inputIds: [input.id],
          message: 'Stop raced with an injected ACP steer; inspect native history before retrying.' });
        else this.emit(this.session.id, 'turn.continued');
        return { status: 'accepted', inputId: input.id };
      } finally {
        this.resolveSteerDecision?.();
        this.resolveSteerDecision = null;
        this.steerDecision = null;
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

  async steerAntigravity(input, prompt) {
    // agy acp 1.5.15 accepts a concurrent session/prompt as a correction to
    // the running turn. Keep Muxterm's turn open until the steering RPC settles.
    this.antigravitySteering = true;
    this.antigravityStopEmitted = false;
    const inputIds = [...this.turnInputIds, input.id];
    try {
      const result = await this.withExit(this.connection.prompt({ sessionId: this.session.nativeId, prompt }));
      if (this.stopDuringSteer || result.stopReason === 'cancelled')
        throw new Error('Antigravity steering was cancelled');
      if (result.stopReason !== 'end_turn')
        throw new Error(`Antigravity steering stopped: ${result.stopReason}`);
      // Either ACP prompt may settle first. Keep the original turn under the
      // steering guard until its own completion handler has run.
      await this.turnPromise;
      this.emitAccepted(input);
      this.emit(this.session.id, 'turn.completed', { inputIds, message: result.stopReason });
      return { status: 'accepted', inputId: input.id };
    } catch (error) {
      if (this.stopDuringSteer) this.emitAntigravityStop();
      this.emit(this.session.id, 'session.uncertain', { inputIds, message: String(error) });
      throw error;
    } finally {
      this.antigravitySteering = false;
      this.busy = false;
      this.session.busy = false;
    }
  }

  emitAntigravityStop() {
    if (this.antigravityStopEmitted) return;
    this.antigravityStopEmitted = true;
    this.emit(this.session.id, 'turn.cancelled', { inputIds: this.turnInputIds, message: 'cancelled' });
  }

  async startPrompt(input, prompt) {
    this.busy = true;
    this.session.busy = true;
    this.session.cancelRequested = false;
    this.userStopRequested = false;
    this.questionDismissed = false;
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
    this.turnPromise = this.withExit(this.connection.prompt({ sessionId: this.session.nativeId, prompt })).then(async result => {
      this.confirmAccepted();
      // The native prompt can finish while _session/steering is resolving.
      // Wait for its injected/promptRequired answer before committing the
      // completion event and its input IDs.
      if (this.steerDecision) await this.steerDecision;
      if (this.antigravitySteering) {
        if (this.stopDuringSteer || result.stopReason === 'cancelled') this.emitAntigravityStop();
        else this.emit(this.session.id, 'turn.continued');
      } else if (this.interruptForSteer && !this.stopDuringSteer) {
        this.continuedInputIds = this.turnInputIds;
        this.emit(this.session.id, 'turn.continued');
      } else if (result.stopReason === 'cancelled') {
        this.reminderCursor = 0;
        this.emit(this.session.id, 'turn.cancelled', { inputIds: this.turnInputIds,
          message: result.stopReason, cancelReason: this.userStopRequested ? 'user' : this.questionDismissed ? 'question_dismissed' : 'agent' });
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
        this.emit(this.session.id, 'turn.cancelled', { inputIds: this.turnInputIds,
          message: 'cancelled', cancelReason: this.userStopRequested ? 'user' : this.questionDismissed ? 'question_dismissed' : 'agent' });
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
      if (!this.antigravitySteering) {
        this.busy = false;
        this.session.busy = false;
      }
      this.session.cancelRequested = false;
      this.userStopRequested = false;
      this.confirmAccepted = null;
    });
    await evidence;
    return { status: 'accepted', inputId: input.id };
  }

  async interrupt() {
    if (!this.busy) throw new Error('No active turn to stop');
    if (this.steerPending) this.stopDuringSteer = true;
    this.session.cancelRequested = true;
    this.userStopRequested = true;
    this.resolveElicitations();
    try { await this.connection.cancel({ sessionId: this.session.nativeId }); }
    catch (error) { this.userStopRequested = false; throw error; }
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
    this.resolveElicitations();
    await this.ready.catch(() => {});
    this.runtime.detach(this);
    if (this.session.harness === 'opencode') {
      // This process belongs to one chat. Closing stdin detaches the saved
      // session; a later resume starts a new ACP process for the same ID.
      await this.runtime.stop();
      return;
    }
    if (!this.runtime.exitError && this.session.nativeId)
      await this.withExit(this.connection.closeSession({ sessionId: this.session.nativeId }));
  }
}
