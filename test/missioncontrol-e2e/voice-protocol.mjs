#!/usr/bin/env node
/*
 * BACKEND_PROTOCOL_ONLY Mission Control voice candidate driver.
 * It talks to a prepared real server, sessiond, text provider, and TLS
 * provider-edge fixture. It deliberately has no browser audio/WebRTC proof.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

const usage = `Usage:
  node test/missioncontrol-e2e/voice-protocol.mjs \\
    --base-url <URL> --fixture-url <https://loopback> --fixture-ca <PEM> \\
    --muxterm-bin <path> --provider-records <private JSON> --output <private directory> \\
    --source-sha <tested source SHA or archive hash> --accept-disposable-fixtures

BACKEND_PROTOCOL_ONLY. Prerequisites: an isolated, already-running muxterm
server/sessiond/text-provider configured with missioncontrol.voice_preview and
the TLS realtimefixture. This driver never starts/stops product processes,
creates only harmless fixture workspaces, and makes protocol nonce ACKs only:
it does not prove acoustic delivery, browser SpeechSynthesis, or WebRTC media.`;

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const name = key.slice(2);
    if (name === 'accept-disposable-fixtures') { out[name] = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    out[name] = value;
  }
  return out;
}

const opt = args(process.argv.slice(2));
if (opt.help) { console.log(usage); process.exit(0); }
for (const name of ['base-url', 'fixture-url', 'fixture-ca', 'muxterm-bin', 'provider-records', 'output', 'source-sha']) {
  if (!opt[name]) throw new Error(`--${name} is required\n${usage}`);
}
if (!opt['accept-disposable-fixtures']) throw new Error(`--accept-disposable-fixtures is required\n${usage}`);
if (!/^[0-9a-f]{40,128}$/i.test(opt['source-sha'])) throw new Error('--source-sha must be supplied as a tested hexadecimal source SHA/archive hash');
if (!fs.existsSync(opt['fixture-ca']) || !fs.existsSync(opt['muxterm-bin']) || !fs.existsSync(opt['provider-records'])) throw new Error('fixture CA, muxterm binary, and provider records must already exist');
if (typeof tls.setDefaultCACertificates !== 'function' || typeof tls.getCACertificates !== 'function') {
  throw new Error('Node 22.19+ TLS CA APIs are required; refusing any insecure certificate bypass');
}
tls.setDefaultCACertificates([...tls.getCACertificates('default'), fs.readFileSync(opt['fixture-ca'], 'utf8')]);

const base = new URL(opt['base-url']);
const fixture = new URL(opt['fixture-url']);
if (fixture.protocol !== 'https:' || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(fixture.hostname)) {
  throw new Error('--fixture-url must be HTTPS on loopback');
}
const output = path.resolve(opt.output);
const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const relativeOutput = path.relative(repository, output);
if (relativeOutput === '' || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..')) {
  throw new Error('--output must be a user-supplied private directory outside the repository');
}
const run = {
  format: 'missioncontrol-voice-backend-protocol-v1',
  mode: 'BACKEND_PROTOCOL_ONLY',
  status: 'FAIL',
  source_sha: opt['source-sha'].toLowerCase(),
  limitations: ['No browser SpeechSynthesis/physical sink proof.', 'No WebRTC/audio negotiation proof.', 'Not H10 or H11.'],
  checks: {},
  errors: [],
};
const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
const check = (name, condition, reason, evidence = {}) => {
  run.checks[name] = { status: condition ? 'PASS' : 'FAIL', reason, ...evidence };
  if (!condition) throw new Error(`${name}: ${reason}`);
};
const blocked = (name, reason) => { run.checks[name] = { status: 'BLOCKED', reason }; };
const sleep = (n) => new Promise((r) => setTimeout(r, n));
async function eventually(fn, label, timeout = 60_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

class CookieJar {
  constructor() { this.values = new Map(); }
  absorb(headers) {
    const set = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
    for (const item of set) {
      const [pair] = item.split(';', 1);
      const index = pair.indexOf('=');
      if (index > 0) this.values.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  header() { return [...this.values].map(([k, v]) => `${k}=${v}`).join('; '); }
}
const jar = new CookieJar();
function endpoint(root, relative) { return new URL(relative.replace(/^\//, ''), `${root.href.replace(/\/?$/, '/')}`); }
async function request(url, init = {}) {
  const headers = new Headers(init.headers ?? {});
  const cookie = jar.header();
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(url, { ...init, headers });
  jar.absorb(response.headers);
  return response;
}
async function json(url, init = {}) {
  const response = await request(url, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
function voicePayload(target, more = {}) {
  return { protocol_version: 3, thread_id: target.id, runtime_session_id: target.runtime_session_id, runtime_generation: target.runtime_generation, runtime_incarnation: target.runtime_incarnation, ...more };
}
async function voice(route, target, more = {}, token = '') {
  const headers = { 'Content-Type': 'application/json', Origin: base.origin, 'X-MissionControl-Voice-Protocol': '3', 'Sec-Fetch-Site': 'same-origin' };
  if (token) headers['X-MissionControl-Voice-Control'] = token;
  return json(endpoint(base, route), { method: 'POST', headers, body: JSON.stringify(voicePayload(target, more)) });
}
async function fixtureControl(operation, callId, event) {
  const { response, body } = await json(endpoint(fixture, '/__fixture/control'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, call_id: callId, ...(event ? { event } : {}) }),
  });
  if (!response.ok) throw new Error(`fixture ${operation} refused (${response.status})`);
  return body;
}
const commands = async (callId) => (await fixtureControl('inspect', callId)).commands ?? [];
const command = async (callId, type) => eventually(async () => (await commands(callId)).find((item) => item.type === type), `provider command ${type}`);
const noCommand = async (stage, callId, type) => check(`no_${type.replace(/\./g, '_')}_${stage}_prefix_ack`, !(await commands(callId)).some((item) => item.type === type), 'provider response remains prefix-gated');

class MissionSocket {
  constructor(url, cookie) {
    this.frames = [];
    this.waiters = [];
    this.ws = new WebSocket(url, cookie ? { headers: { Cookie: cookie } } : undefined);
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('Mission Control WebSocket failed')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        this.frames.push(frame);
        for (const waiter of [...this.waiters]) if (waiter(frame)) waiter.resolve(frame);
      } catch { /* unrelated terminal frame */ }
    });
    return this;
  }
  send(value) { this.ws.send(JSON.stringify(value)); }
  wait(predicate, label) {
    const old = this.frames.find(predicate);
    if (old) return Promise.resolve(old);
    return new Promise((resolve, reject) => {
      const waiter = (frame) => predicate(frame);
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== waiter);
        reject(new Error(`timeout waiting for ${label}`));
      }, 60_000);
      waiter.resolve = (frame) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((x) => x !== waiter);
        resolve(frame);
      };
      this.waiters.push(waiter);
    });
  }
  async select(workspaceId) {
    const request_id = randomUUID();
    this.send({ type: 'missioncontrol-select', protocol_version: 2, request_id, workspace_id: workspaceId });
    const reply = await this.wait((f) => f.type === 'missioncontrol-result' && f.op === 'select' && f.request_id === request_id, 'real Mission Control root selection');
    if (!reply.ok || !reply.thread?.id) throw new Error(`root selection refused: ${reply.code ?? 'unknown'}`);
    return reply.thread;
  }
  close() { this.ws.close(); }
}
function wsURL() {
  const ws = new URL(endpoint(base, '/ws'));
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  return ws;
}
function createWorkspace(label) {
  const value = JSON.parse(execFileSync(opt['muxterm-bin'], ['workspace', 'create', label, '--json'], { encoding: 'utf8', env: process.env }));
  if (!value.workspaceId) throw new Error('muxterm did not return created fixture workspace id');
  return value.workspaceId;
}
function text(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).filter(([k]) => ['text', 'content', 'input'].includes(k)).map(([, v]) => text(v)).join('\n');
  return '';
}
const readRecords = () => JSON.parse(fs.readFileSync(opt['provider-records'], 'utf8'));

let socket;
try {
  const stamp = randomUUID().slice(0, 8);
  const workspaceA = createWorkspace(`voice protocol A ${stamp}`);
  const workspaceB = createWorkspace(`voice protocol B ${stamp}`);
  check('fresh_disposable_workspaces', true, 'created through supplied muxterm CLI under inherited prepared environment', { count: 2 });

  socket = await new MissionSocket(wsURL(), jar.header()).open();
  const a = await socket.select(workspaceA);
  const b = await socket.select(workspaceB);
  check('real_ws_selected_roots', Boolean(a.runtime_session_id && a.runtime_generation && a.runtime_incarnation && b.id !== a.id), 'real WebSocket selections yielded distinct runtime roots', { a_root: sha(a.id), b_root: sha(b.id) });
  await socket.select(workspaceA);

  const missing = await json(endpoint(base, '/api/missioncontrol/voice/lease'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base.origin }, body: JSON.stringify({}) });
  check('voice_version_refusal', missing.response.status === 409 && missing.body.code === 'voice_protocol_unsupported', 'missing v3 is refused before ownership');
  const wrongVersion = await json(endpoint(base, '/api/missioncontrol/voice/lease'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base.origin }, body: JSON.stringify({ protocol_version: 2 }) });
  check('voice_wrong_version_refusal', wrongVersion.response.status === 409 && wrongVersion.body.code === 'voice_protocol_unsupported', 'non-v3 protocol version is refused before ownership');

  const leaseA = await voice('/api/missioncontrol/voice/lease', a);
  check('claim_lease_A', leaseA.response.status === 201 && leaseA.body.lease?.state === 'active' && Boolean(leaseA.body.control_token), 'server issued exact A lease and tab capability');
  const tokenA = leaseA.body.control_token;
  const lease = leaseA.body.lease;
  const mintA = await voice('/api/missioncontrol/voice/attachment/token', a, { lease_epoch: lease.lease_epoch, focus_epoch: lease.focus_epoch }, tokenA);
  check('mint_scoped_A', mintA.response.status === 201 && mintA.body.microphone_admission === false, 'real server minted muted scoped candidate');
  const sdpA = await voice('/api/missioncontrol/voice/attachment/sdp', a, { lease_epoch: lease.lease_epoch, focus_epoch: lease.focus_epoch, attachment_epoch: mintA.body.attachment_epoch, session_id: mintA.body.session_id, sdp: 'v=0\r\ns=PROTOCOL_FIXTURE_NOT_BROWSER_NEGOTIATION\r\n' }, tokenA);
  check('sdp_fixture_only_and_sideband_connected', sdpA.response.ok && sdpA.body.provider_call_id && sdpA.body.microphone_admission === false, 'server observed fixture Location call ID; SDP is protocol fixture only');
  const callA = sdpA.body.provider_call_id;
  const sideband = await fixtureControl('inspect', callA);
  check('sideband_survives_sdp_http_end', sideband.connected === true, 'real server sideband remains WSS-connected after SDP HTTP response ended');

  let cursor = 0;
  const eventsA = async () => {
    const response = await voice('/api/missioncontrol/voice/events', a, { lease_epoch: lease.lease_epoch, focus_epoch: lease.focus_epoch, attachment_epoch: mintA.body.attachment_epoch, cursor }, tokenA);
    if (!response.response.ok) throw new Error(`event poll refused ${response.body.code ?? response.response.status}`);
    cursor = response.body.cursor;
    return response.body.events;
  };
  const route = (await eventsA()).find((e) => e.type === 'prefix_request' && e.kind === 'route');
  check('route_prefix_notice', Boolean(route?.nonce), 'owner long-poll received route prefix request');
  await noCommand('route', callA, 'response.create');
  const routeAck = await voice('/api/missioncontrol/voice/prefix/ack', a, { lease_epoch: lease.lease_epoch, focus_epoch: lease.focus_epoch, attachment_epoch: mintA.body.attachment_epoch, prefix_nonce: route.nonce }, tokenA);
  check('route_nonce_ack_protocol_only', routeAck.body.media_admission === true, 'nonce ACK is protocol-only and not spoken-prefix evidence');

  const capture = await voice('/api/missioncontrol/voice/capture/begin', a, { lease_epoch: lease.lease_epoch, focus_epoch: lease.focus_epoch, attachment_epoch: mintA.body.attachment_epoch }, tokenA);
  check('reserve_capture_media_admission', capture.response.status === 201 && capture.body.media_enabled === false && capture.body.media_admission === true, 'server reserved capture without enabling media');
  const ended = await voice('/api/missioncontrol/voice/capture/end', a, { lease_epoch: lease.lease_epoch, focus_epoch: lease.focus_epoch, attachment_epoch: mintA.body.attachment_epoch, capture_id: capture.body.capture_id, capture_epoch: capture.body.capture_epoch }, tokenA);
  check('end_capture_before_provider_commit', ended.body.state === 'ended', 'capture end accepted before provider input commit');
  await fixtureControl('inject', callA, { type: 'input_audio_buffer.committed', item_id: 'fixture_input_A' });
  await fixtureControl('inject', callA, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'fixture_input_A' });
  const answerPrefix = (await eventsA()).find((e) => e.type === 'prefix_request' && e.kind === 'answer' && e.capture_id === capture.body.capture_id);
  check('answer_prefix_notice', Boolean(answerPrefix?.nonce), 'committed input after ended capture emitted answer prefix');
  await noCommand('answer', callA, 'response.create');
  const answerAck = await voice('/api/missioncontrol/voice/prefix/ack', a, { lease_epoch: lease.lease_epoch, focus_epoch: lease.focus_epoch, attachment_epoch: mintA.body.attachment_epoch, prefix_nonce: answerPrefix.nonce }, tokenA);
  check('answer_nonce_ack_protocol_only', answerAck.body.state === 'response_requested', 'answer prefix ACK is protocol-only');
  const create = await command(callA, 'response.create');
  check('metadata_bound_response_create', create.metadata_keys?.includes('muxterm_capture_id') && create.metadata_keys?.includes('muxterm_prefix_nonce') && create.metadata_keys?.includes('muxterm_attachment_epoch'), 'server emitted metadata-bound scoped response.create without exposing metadata values');

  const responseA = 'fixture_response_A';
  const metadata = create.metadata;
  check('reuse_actual_response_metadata', Boolean(metadata?.muxterm_capture_id && metadata?.muxterm_prefix_nonce && metadata?.muxterm_attachment_epoch), 'reused scoped metadata received from real sideband response.create through the private fixture control channel');
  await fixtureControl('inject', callA, { type: 'response.created', response: { id: responseA, metadata } });
  await fixtureControl('inject', callA, { type: 'response.output_item.added', response_id: responseA, item: { id: 'fixture_output_A', call_id: 'fixture_tool_A' } });
  const beforeRecords = readRecords().length;
  const finalCall = { type: 'response.function_call_arguments.done', response_id: responseA, item_id: 'fixture_output_A', name: 'ask_chief_of_staff', arguments: JSON.stringify({ request: 'A_CANARY=cobalt-otter' }) };
  await fixtureControl('inject', callA, finalCall);
  await command(callA, 'conversation.item.create');
  await fixtureControl('inject', callA, { type: 'response.done', response_id: responseA });
  const terminalA = await socket.wait((f) => f.type === 'missioncontrol-event' && f.thread_id === a.id && f.event?.ev === 'turn_end' && f.event?.persisted === true, 'A persisted terminal event');
  check('verified_mapping_admits_real_runtime_root', Boolean(terminalA), 'verified output-item mapping admitted work through catalog into actual A runtime');
  const added = readRecords().slice(beforeRecords).map((r) => text(r?.request?.input)).join('\n');
  check('provider_text_input_origin_canary_only', added.includes('A_CANARY=cobalt-otter') && !added.includes('B_CANARY='), 'originating A canary reached real text provider without B data');
  await fixtureControl('inject', callA, finalCall);
  await sleep(300);
  check('repeat_final_call_no_duplicate_root', readRecords().length === beforeRecords + 1, 'same mapped provider call did not create another text-provider root turn');

  const functionOutput = await command(callA, 'conversation.item.create');
  check('scoped_function_output_before_continuation', functionOutput.type === 'conversation.item.create', 'tool result emitted before continuation request');
  const continuationPrefix = (await eventsA()).find((e) => e.type === 'prefix_request' && e.kind === 'answer');
  check('continuation_prefix_after_tool_response_done', Boolean(continuationPrefix?.nonce), 'initial tool-only provider response produced continuation prefix');
  const continuationAck = await voice('/api/missioncontrol/voice/prefix/ack', a, { lease_epoch: lease.lease_epoch, focus_epoch: lease.focus_epoch, attachment_epoch: mintA.body.attachment_epoch, prefix_nonce: continuationPrefix.nonce }, tokenA);
  check('continuation_prefix_ack', continuationAck.body.state === 'response_requested', 'continuation remains gated by a second protocol-only prefix ACK');
  const creates = await eventually(async () => {
    const found = (await commands(callA)).filter((item) => item.type === 'response.create');
    return found.length >= 2 ? found : null;
  }, 'metadata-bound continuation response.create');
  check('no_legacy_unmetadata_continuation', creates.length === 2 && creates.every((item) => item.metadata_keys?.includes('muxterm_capture_id')), 'both scoped response requests carry correlation metadata; no legacy response.create was used');
  const continuationID = 'fixture_response_A_continuation';
  await fixtureControl('inject', callA, { type: 'response.created', response: { id: continuationID, metadata: creates[1].metadata } });

  const stopA = await voice('/api/missioncontrol/voice/stop', a, { lease_epoch: lease.lease_epoch, focus_epoch: lease.focus_epoch, attachment_epoch: mintA.body.attachment_epoch }, tokenA);
  check('drain_A_started', stopA.body.state === 'draining', 'server requested provider cancel/clear and browser drain');
  const drainCommands = await commands(callA);
  check('drain_sends_cancel_and_clear', drainCommands.some((x) => x.type === 'response.cancel') && drainCommands.some((x) => x.type === 'output_audio_buffer.clear'), 'same sideband received cancel and clear');
  const drain = (await eventsA()).find((e) => e.type === 'drain_request');
  const blockedTakeover = await voice('/api/missioncontrol/voice/lease', b, { takeover: true }, tokenA);
  check('takeover_blocked_without_browser_ack', blockedTakeover.response.status === 409, 'new target cannot claim while browser drain ACK is withheld');
  await fixtureControl('inject', callA, { type: 'response.cancelled', response_id: continuationID });
  await fixtureControl('inject', callA, { type: 'output_audio_buffer.cleared', response_id: continuationID });
  const drainAck = await voice('/api/missioncontrol/voice/drain/ack', a, { lease_epoch: lease.lease_epoch, focus_epoch: lease.focus_epoch, attachment_epoch: mintA.body.attachment_epoch, drain_nonce: drain.nonce }, tokenA);
  check('exact_drain_nonce_protocol_only', drainAck.response.ok, 'provided exact browser drain nonce; no physical sink proof claimed');
  const leaseB = await voice('/api/missioncontrol/voice/lease', b, { takeover: true }, tokenA);
  check('fresh_same_owner_takeover_B', leaseB.response.status === 201 && leaseB.body.lease?.correlation?.thread_id === b.id, 'fully drained same owner received explicit B lease');
  const mintB = await voice('/api/missioncontrol/voice/attachment/token', b, { lease_epoch: leaseB.body.lease.lease_epoch, focus_epoch: leaseB.body.lease.focus_epoch }, leaseB.body.control_token);
  check('fresh_B_session', mintB.response.status === 201 && mintB.body.session_id !== mintA.body.session_id, 'B mint is distinct from old A session');
  const sdpB = await voice('/api/missioncontrol/voice/attachment/sdp', b, { lease_epoch: leaseB.body.lease.lease_epoch, focus_epoch: leaseB.body.lease.focus_epoch, attachment_epoch: mintB.body.attachment_epoch, session_id: mintB.body.session_id, sdp: 'v=0\r\ns=PROTOCOL_FIXTURE_NOT_BROWSER_NEGOTIATION_B\r\n' }, leaseB.body.control_token);
  check('fresh_B_call_id', sdpB.response.ok && sdpB.body.provider_call_id !== callA, 'B received a distinct fixture provider call ID');
  const staleA = await voice('/api/missioncontrol/voice/attachment/sdp', a, { lease_epoch: lease.lease_epoch, focus_epoch: lease.focus_epoch, attachment_epoch: mintA.body.attachment_epoch, session_id: mintA.body.session_id, sdp: 'v=0\r\ns=stale-A\r\n' }, tokenA);
  check('old_A_ids_cannot_dispatch_B', staleA.response.status === 409, 'old attachment correlation/token cannot resume after B takeover');

  let cursorB = 0;
  const eventsB = async () => {
    const response = await voice('/api/missioncontrol/voice/events', b, { lease_epoch: leaseB.body.lease.lease_epoch, focus_epoch: leaseB.body.lease.focus_epoch, attachment_epoch: mintB.body.attachment_epoch, cursor: cursorB }, leaseB.body.control_token);
    if (!response.response.ok) throw new Error(`B event poll refused ${response.body.code ?? response.response.status}`);
    cursorB = response.body.cursor;
    return response.body.events;
  };
  const noAdmission = await voice('/api/missioncontrol/voice/capture/begin', b, { lease_epoch: leaseB.body.lease.lease_epoch, focus_epoch: leaseB.body.lease.focus_epoch, attachment_epoch: mintB.body.attachment_epoch }, leaseB.body.control_token);
  check('fresh_attachment_no_admission_before_route_ack', noAdmission.response.status === 409 && noAdmission.body.code === 'route_prefix_required', 'fresh B capture remains refused until route prefix ACK');
  const routeB = (await eventsB()).find((e) => e.type === 'prefix_request' && e.kind === 'route');
  await voice('/api/missioncontrol/voice/prefix/ack', b, { lease_epoch: leaseB.body.lease.lease_epoch, focus_epoch: leaseB.body.lease.focus_epoch, attachment_epoch: mintB.body.attachment_epoch, prefix_nonce: routeB.nonce }, leaseB.body.control_token);
  const captureB = await voice('/api/missioncontrol/voice/capture/begin', b, { lease_epoch: leaseB.body.lease.lease_epoch, focus_epoch: leaseB.body.lease.focus_epoch, attachment_epoch: mintB.body.attachment_epoch }, leaseB.body.control_token);
  await voice('/api/missioncontrol/voice/capture/end', b, { lease_epoch: leaseB.body.lease.lease_epoch, focus_epoch: leaseB.body.lease.focus_epoch, attachment_epoch: mintB.body.attachment_epoch, capture_id: captureB.body.capture_id, capture_epoch: captureB.body.capture_epoch }, leaseB.body.control_token);
  const callB = sdpB.body.provider_call_id;
  await fixtureControl('inject', callB, { type: 'input_audio_buffer.committed', item_id: 'fixture_input_B' });
  const answerB = (await eventsB()).find((e) => e.type === 'prefix_request' && e.kind === 'answer');
  await voice('/api/missioncontrol/voice/prefix/ack', b, { lease_epoch: leaseB.body.lease.lease_epoch, focus_epoch: leaseB.body.lease.focus_epoch, attachment_epoch: mintB.body.attachment_epoch, prefix_nonce: answerB.nonce }, leaseB.body.control_token);
  await command(callB, 'response.create');
  await fixtureControl('inject', callB, { type: 'response.created', response: { id: 'stale_response', metadata: { muxterm_capture_id: 'unknown_capture', muxterm_prefix_nonce: 'unknown_nonce', muxterm_attachment_epoch: '0' } } });
  await fixtureControl('inject', callB, { type: 'response.output_item.added', response_id: 'unknown_response', item: { id: 'unknown_item', call_id: 'unknown_call' } });
  const fenceCommands = await eventually(async () => {
    const seen = await commands(callB);
    return seen.some((item) => item.type === 'response.cancel') && seen.some((item) => item.type === 'output_audio_buffer.clear');
  }, 'unknown provider item fence');
  check('unknown_item_metadata_stale_epoch_fence', fenceCommands === true, 'bad metadata/epoch and unknown item fenced B and requested cancellation/clear before any work admission');

  blocked('background_A_completion_after_fixture_transport_loss', 'A completion needs a deliberately delayed real text-provider response; this prepared-driver contract provides no delay control, and the driver will not kill product processes.');
  blocked('voice_approval_cancel_text_only', 'the backend emits the text-controls-only scoped reply, but a fresh mapped control-call capture is not available after the required B fence.');
  blocked('H10_browser_prefix_audio', 'external Chrome has no local SpeechSynthesis voices; this driver does not fake a browser prefix.');
  blocked('H11_live_acoustic', 'not authorized and no live microphone/acoustic proof is attempted.');
  run.status = 'PASS_BACKEND_PROTOCOL_ONLY';
} catch (error) {
  run.errors.push(String(error?.stack ?? error));
} finally {
  socket?.close();
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'results.json'), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify({ status: run.status, mode: run.mode }));
process.exitCode = run.status === 'PASS_BACKEND_PROTOCOL_ONLY' ? 0 : 1;