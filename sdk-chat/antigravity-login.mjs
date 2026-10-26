import { spawn } from 'node:child_process';
import readline from 'node:readline';
import http from 'node:http';
import { antigravityLaunch, antigravityMode } from './acp-stream.mjs';

let login = null;
const authLink = /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s\x00-\x20\x1b<>]+/;

function publicStatus() {
  if (!login) return { state: 'idle' };
  return { state: login.state, ...(login.url ? { url: login.url } : {}),
    ...(login.message ? { message: login.message } : {}) };
}

function stop(current) {
  if (!current) return;
  current.stopped = true;
  current.process?.kill();
  for (const pending of current.pending.values()) pending.reject(new Error('Antigravity sign-in stopped'));
  current.pending.clear();
}

function request(current, method, params) {
  const id = ++current.nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      current.pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, method === 'authenticate' ? 5 * 60_000 : 30_000);
    current.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    current.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
      if (error) { current.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  });
}

async function run(current) {
  try {
    const { command, args, env } = antigravityLaunch(current.mode);
    env.BROWSER = '/bin/false'; // The browser belongs to the muxterm user, not the server process.
    current.process = spawn(command, args,
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
    current.process.on('error', error => {
      for (const pending of current.pending.values()) pending.reject(error);
      current.pending.clear();
    });
    current.process.on('exit', (code, signal) => {
      const error = new Error(`Antigravity ACP exited (${signal || code})`);
      for (const pending of current.pending.values()) pending.reject(error);
      current.pending.clear();
      if (login === current && !current.stopped && current.state !== 'complete') {
        current.state = 'error'; current.url = ''; current.message = error.message;
      }
    });
    readline.createInterface({ input: current.process.stdout }).on('line', line => {
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      const pending = current.pending.get(frame.id);
      if (!pending) return;
      current.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message || 'Antigravity authentication failed'));
      else pending.resolve(frame.result);
    });
    let stderr = '';
    current.process.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8192);
      if (current.mode !== 'google' || current.url || login !== current) return;
      const match = authLink.exec(stderr);
      if (!match) return;
      try {
        const url = new URL(match[0]);
        const redirect = new URL(url.searchParams.get('redirect_uri'));
        if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port) return;
        current.url = url.href;
        current.redirect = redirect;
        current.oauthState = url.searchParams.get('state');
        current.state = 'awaiting_code';
      } catch { /* Ignore unrelated agent diagnostics. */ }
    });
    const init = await request(current, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (init?.protocolVersion !== 1 || !init.authMethods?.some(method => method.id === (current.mode === 'google' ? 'oauth-personal' : 'gemini-api-key')))
      throw new Error('Antigravity ACP did not advertise the selected sign-in method');
    await request(current, 'authenticate', { methodId: current.mode === 'google' ? 'oauth-personal' : 'gemini-api-key' });
    if (login === current && !current.stopped) {
      current.state = 'complete'; current.message = ''; current.url = '';
    }
  } catch (error) {
    if (login === current && !current.stopped) {
      current.state = 'error'; current.url = '';
      current.message = error instanceof Error ? error.message : String(error);
    }
  } finally { current.process?.kill(); }
}

export function antigravityLoginStatus() { return publicStatus(); }

export function startAntigravityLogin() {
  if (login && ['starting', 'awaiting_code', 'verifying'].includes(login.state)) return publicStatus();
  stop(login);
  login = { state: 'starting', mode: antigravityMode(), url: '', message: '', redirect: null,
    oauthState: '', pending: new Map(), nextId: 0, process: null, stopped: false };
  void run(login);
  return publicStatus();
}

export function cancelAntigravityLogin() {
  stop(login);
  login = null;
  return publicStatus();
}

export async function finishAntigravityLogin(callbackURL) {
  const current = login;
  if (!current || current.state !== 'awaiting_code' || !current.redirect || !current.oauthState || !current.process || current.process.exitCode !== null)
    throw new Error('Antigravity is not waiting for a Google callback');
  if (typeof callbackURL !== 'string' || callbackURL.length > 8192) throw new Error('Invalid Google callback URL');
  let submitted;
  try { submitted = new URL(callbackURL.trim()); } catch { throw new Error('Paste the complete callback URL from your browser address bar'); }
  if (submitted.origin !== current.redirect.origin || submitted.pathname !== current.redirect.pathname ||
      submitted.username || submitted.password || submitted.searchParams.getAll('state').length !== 1 ||
      submitted.searchParams.getAll('code').length !== 1 ||
      submitted.searchParams.get('state') !== current.oauthState || !submitted.searchParams.get('code'))
    throw new Error('This callback does not match the active Antigravity sign-in');
  current.state = 'verifying';
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(submitted, { timeout: 10000 }, response => {
        response.resume(); response.on('end', resolve);
      });
      req.on('timeout', () => req.destroy(new Error('Google callback timed out')));
      req.on('error', reject);
    });
  } catch (error) {
    if (login === current && current.state === 'verifying') current.state = 'awaiting_code';
    throw error;
  }
  return publicStatus();
}
