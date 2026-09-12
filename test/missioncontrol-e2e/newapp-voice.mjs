#!/usr/bin/env node
/*
 * Private DTU-only app voice proof. It drives the product UI and real browser
 * WebRTC only; the relay peer and provider sideband are deliberately fixture
 * edges. Synthetic media and scripted recognition are never acoustic/STT proof.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { createRequire } from 'node:module';

const usage = `Usage:
  node test/missioncontrol-e2e/newapp-voice.mjs \\
    --base-url <URL> --fixture-url <https://loopback> --fixture-ca <PEM> \\
    --muxterm-bin <path> --provider-records <private JSON> --output <private directory> \\
    --source-sha <40-hex> --accept-disposable-fixtures [--playwright-module <module-or-absolute-path>]

Requires an already-running isolated browser/server/sessiond/sideband DTU and
realtimefixture --rtc-relay. This driver never starts, stops, or kills product
processes. REALRTC_SYNTHETIC_MEDIA uses Chrome fake-device/software WAV input;
SCRIPTED_PROVIDER and SCRIPTED_RECOGNITION_API are not acoustic voice or STT.`;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return { help: true };
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const name = key.slice(2);
    if (name === 'accept-disposable-fixtures' || name === 'headed') {
      result[name] = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    result[name] = value;
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage);
  process.exit(0);
}
for (const name of ['base-url', 'fixture-url', 'fixture-ca', 'muxterm-bin', 'provider-records', 'output', 'source-sha']) {
  if (!options[name]) throw new Error(`--${name} is required\n${usage}`);
}
if (!options['accept-disposable-fixtures']) throw new Error(`--accept-disposable-fixtures is required\n${usage}`);
if (!/^[0-9a-f]{40}$/i.test(options['source-sha'])) throw new Error('--source-sha must be a 40-character hexadecimal commit SHA');
if (!fs.existsSync(options['fixture-ca']) || !fs.existsSync(options['muxterm-bin']) || !fs.existsSync(options['provider-records'])) {
  throw new Error('fixture CA, muxterm binary, and provider records must already exist');
}
if (typeof tls.setDefaultCACertificates !== 'function' || typeof tls.getCACertificates !== 'function') {
  throw new Error('Node 22.19+ TLS CA APIs are required; refusing an insecure certificate bypass');
}
tls.setDefaultCACertificates([...tls.getCACertificates('default'), fs.readFileSync(options['fixture-ca'], 'utf8')]);

const base = new URL(options['base-url']);
const fixture = new URL(options['fixture-url']);
if (fixture.protocol !== 'https:' || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(fixture.hostname)) {
  throw new Error('--fixture-url must be HTTPS on loopback');
}
const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const output = path.resolve(options.output);
const outputRelative = path.relative(repository, output);
if (outputRelative === '' || (!outputRelative.startsWith(`..${path.sep}`) && outputRelative !== '..')) {
  throw new Error('--output must be a private directory outside the repository');
}

const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function eventually(callback, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last.message}` : ''}`);
}
function privateOutput(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function softwareWav(file) {
  const sampleRate = 48_000;
  const samples = sampleRate / 2;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    bytes.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 1600), 44 + index * 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
}
function records() {
  const parsed = JSON.parse(fs.readFileSync(options['provider-records'], 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('provider records are not a JSON array');
  return parsed;
}
async function control(operation, extra = {}) {
  const response = await fetch(new URL('/__fixture/control', fixture), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, ...extra }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 404) throw new Error(`fixture ${operation} refused (${response.status})`);
  return { response, body };
}
async function fixtureCommands(callId) {
  return (await control('inspect', { call_id: callId })).body.commands ?? [];
}
async function command(callId, type, predicate = () => true) {
  return eventually(async () => (await fixtureCommands(callId)).find((item) => item.type === type && predicate(item)), `fixture command ${type}`);
}
async function inject(callId, event) {
  const { response } = await control('inject', { call_id: callId, event });
  if (!response.ok) throw new Error('fixture sideband injection was refused');
}
function createWorkspace(label) {
  const reply = JSON.parse(execFileSync(options['muxterm-bin'], ['workspace', 'create', label, '--json'], { encoding: 'utf8', env: process.env }));
  if (typeof reply.workspaceId !== 'string' || !reply.workspaceId) throw new Error('muxterm CLI did not return a fixture workspace ID');
  return reply.workspaceId;
}
function firstOutput(commands, required = () => true) {
  return [...commands].reverse().find((item) => item.type === 'conversation.item.create' && item.output && required(item.output))?.output;
}
function responseMetadata(item) {
  if (!item?.metadata || !item.metadata.muxterm_capture_id && !item.metadata.app_voice_capture_id) {
    throw new Error('fixture did not observe capture-bound response metadata');
  }
  return item.metadata;
}

const run = {
  format: 'missioncontrol-app-voice-e2e-v1',
  mode: ['REALRTC_SYNTHETIC_MEDIA', 'SCRIPTED_PROVIDER', 'SCRIPTED_RECOGNITION_API'],
  status: 'FAIL',
  source_sha: options['source-sha'].toLowerCase(),
  limitations: [
    'Synthetic Chrome fake-device/software WAV media; not acoustic voice.',
    'Provider sideband and SpeechRecognition API events are scripted fixtures; not cloud/physical STT.',
    'No SDP, IP address, token, credential, prompt, or transcript text is written to this result.',
  ],
  checks: {},
  errors: [],
};
let firstFailure = '';
let browser;
let owner;
let peerPage;
const pass = (name, evidence = {}) => { run.checks[name] = { status: 'PASS', ...evidence }; };
const blocked = (name, reason) => {
  if (!run.checks[name]) run.checks[name] = { status: 'BLOCKED', reason };
};
function gate(name, condition, evidence = {}) {
  if (condition) return pass(name, evidence);
  if (!firstFailure) firstFailure = name;
  run.checks[name] = { status: 'FAIL', ...evidence };
  throw new Error(`${name}: assertion failed`);
}
function remaining(reason) {
  for (const name of [
    'app_observe_inventory_and_revision', 'navigate_app_authoritative_ui_ack', 'composer_draft_set_without_submit',
    'submit_thread_turn_visible_confirmation_and_A_only_dispatch', 'rapid_navigation_refuses_pending_submit',
    'same_provider_bridge_survives_A_B', 'lobby_pane_applet_navigation_preserves_bridge',
    'two_browser_takeover_drain', 'owner_disconnect_fences_lease',
    'replayed_sdp_and_cross_origin_refused', 'dictation_late_events_fenced',
  ]) blocked(name, reason);
}

try {
  const providerStart = records().length;
  const stamp = randomUUID().slice(0, 8);
  const workspaceA = createWorkspace(`app voice fixture A ${stamp}`);
  const workspaceB = createWorkspace(`app voice fixture B ${stamp}`);
  pass('fresh_disposable_workspaces_created', { count: 2 });

  const wav = path.join(output, 'synthetic-input.wav');
  softwareWav(wav);
  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require(options['playwright-module'] ?? path.resolve(repository, 'test/voice-e2e/node_modules/playwright-core')));
  } catch (error) {
    throw new Error(`Playwright is an explicit prerequisite; install or pass --playwright-module: ${error.message}`);
  }
  browser = await chromium.launch({
    channel: 'chrome',
    headless: !options.headed,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await context.newPage();
  await owner.addInitScript(() => {
    class ScriptedRecognition extends EventTarget {
      constructor() { super(); (window.__appVoiceRecognition ??= []).push(this); }
      start() {}
      stop() {}
      abort() {}
      continuous = false;
      interimResults = false;
      onresult = null;
      onerror = null;
      onend = null;
    }
    window.SpeechRecognition = ScriptedRecognition;
    window.webkitSpeechRecognition = ScriptedRecognition;
  });
  const responses = [];
  owner.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/app/voice/')) {
      responses.push({ path: new URL(response.url()).pathname, status: response.status() });
    }
  });
  const missionFrames = [];
  owner.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    try {
      const frame = JSON.parse(String(payload));
      if (frame.type === 'missioncontrol-result' || frame.type === 'missioncontrol-event') missionFrames.push(frame);
    } catch { /* unrelated socket frame */ }
  }));
  await owner.goto(base.href, { waitUntil: 'domcontentloaded' });
  await owner.getByRole('button', { name: /Mission Control/ }).first().click();
  await owner.locator('[data-thread-context-selector]').waitFor({ state: 'visible', timeout: 30_000 });

  async function select(label) {
    const start = missionFrames.length;
    await owner.locator('[data-thread-context-selector]').click();
    const option = owner.locator('button.context-option', { hasText: label });
    await option.waitFor({ state: 'visible', timeout: 30_000 });
    await option.click();
    await owner.locator('[data-thread-talk-here]').click();
    return eventually(
      () => missionFrames.slice(start).find((frame) => frame.op === 'select' && frame.ok === true && frame.thread?.display_name === label),
      `authoritative selection for ${label}`,
    );
  }
  const a = await select(`app voice fixture A ${stamp}`);
  const b = await select(`app voice fixture B ${stamp}`);
  await select(`app voice fixture A ${stamp}`);
  gate('real_ui_thread_selection', Boolean(a.thread?.id && a.thread?.runtime_session_id && b.thread?.id && a.thread.id !== b.thread.id), {
    A_thread_sha256: sha(a.thread?.id ?? ''),
    B_thread_sha256: sha(b.thread?.id ?? ''),
  });

  peerPage = await context.newPage();
  await peerPage.goto('about:blank');
  const voiceButton = owner.locator('mux-cos').locator('button.cbtn.voice').first();
  await voiceButton.click();
  const pending = await eventually(async () => {
    const reply = await control('pending_offer');
    return reply.response.ok ? reply.body : null;
  }, 'real browser offer captured by private relay');
  gate('browser_sdp_offer_captured_without_logging_sdp', typeof pending.call_id === 'string' && typeof pending.offer_sdp === 'string', {
    call_id_sha256: sha(pending.call_id ?? ''),
  });
  const answer = await peerPage.evaluate(async (offer) => {
    const peer = new RTCPeerConnection();
    const received = [];
    window.__appVoicePeer = { peer, received };
    peer.ondatachannel = ({ channel }) => {
      channel.onmessage = (event) => {
        try { received.push(JSON.parse(String(event.data)).type ?? 'unknown'); } catch { received.push('non_json'); }
      };
      channel.onopen = () => {
        channel.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture-peer' } }));
        channel.send(JSON.stringify({ type: 'session.updated', session: { type: 'realtime' } }));
      };
    };
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    window.__appVoicePeer.audio = audio;
    window.__appVoicePeer.oscillator = oscillator;
    for (const track of destination.stream.getTracks()) peer.addTrack(track, destination.stream);
    await peer.setRemoteDescription({ type: 'offer', sdp: offer });
    const local = await peer.createAnswer();
    await peer.setLocalDescription(local);
    await new Promise((resolve) => {
      if (peer.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(resolve, 10_000);
      peer.addEventListener('icegatheringstatechange', () => {
        if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
    return peer.localDescription.sdp;
  }, pending.offer_sdp);
  const answerReply = await control('answer_sdp', { call_id: pending.call_id, answer_sdp: answer });
  gate('private_relay_answer_accepted', answerReply.response.ok === true);
  await eventually(() => responses.some((item) => item.path === '/api/app/voice/sdp' && item.status >= 200 && item.status < 300), 'product SDP response');
  await eventually(() => peerPage.evaluate(() => window.__appVoicePeer?.peer.connectionState === 'connected'), 'browser DTLS/ICE connection');
  const peerEvents = await peerPage.evaluate(() => window.__appVoicePeer?.received ?? []);
  gate('real_webrtc_dtls_ice_and_data_channel', peerEvents.includes('session.update'), { received_event_types: peerEvents.slice(0, 8) });
  const callId = pending.call_id;
  await eventually(async () => (await control('inspect', { call_id: callId })).body.connected === true, 'server sideband WSS connection');
  pass('sideband_wss_connected_after_real_sdp', { call_id_sha256: sha(callId) });

  await inject(callId, { type: 'input_audio_buffer.committed', item_id: 'fixture_input' });
  await inject(callId, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'fixture_input', transcript: 'synthetic' });
  const firstCreate = await command(callId, 'response.create');
  const firstMetadata = responseMetadata(firstCreate);
  await inject(callId, { type: 'response.created', response: { id: 'fixture_response_observe', metadata: firstMetadata } });
  await inject(callId, {
    type: 'response.function_call_arguments.done',
    response_id: 'fixture_response_observe',
    item: { id: 'fixture_item_observe', call_id: 'fixture_call_observe' },
    name: 'app_observe',
    arguments: '{}',
  });
  await command(callId, 'conversation.item.create', (item) => Boolean(item.output?.revision));
  const observed = firstOutput(await fixtureCommands(callId), (item) => Boolean(item.revision && item.active));
  gate('app_observe_inventory_and_revision', Boolean(observed?.revision && observed?.active), { revision: observed?.revision ?? 0 });
  await inject(callId, { type: 'response.done', response_id: 'fixture_response_observe' });

  await inject(callId, { type: 'input_audio_buffer.committed', item_id: 'fixture_input_navigation' });
  const navCreate = await eventually(async () => {
    const items = (await fixtureCommands(callId)).filter((item) => item.type === 'response.create');
    return items.length > 1 ? items.at(-1) : null;
  }, 'navigation response request');
  await inject(callId, { type: 'response.created', response: { id: 'fixture_response_navigation', metadata: responseMetadata(navCreate) } });
  await inject(callId, {
    type: 'response.function_call_arguments.done',
    response_id: 'fixture_response_navigation',
    item: { id: 'fixture_item_navigation', call_id: 'fixture_call_navigation' },
    name: 'navigate_app',
    arguments: JSON.stringify({ expected_revision: observed.revision, target: { kind: 'workspace', workspace_id: workspaceB } }),
  });
  const navOutput = await eventually(async () => firstOutput(await fixtureCommands(callId), (item) => item.selected_target?.workspace_id === workspaceB), 'navigate_app UI acknowledgement');
  gate('navigate_app_authoritative_ui_ack', navOutput.selected_target?.workspace_id === workspaceB, { workspace_id_sha256: sha(workspaceB) });
  await inject(callId, { type: 'response.done', response_id: 'fixture_response_navigation' });

  await select(`app voice fixture A ${stamp}`);
  const sdpCountBeforeNavigation = responses.filter((item) => item.path === '/api/app/voice/sdp').length;
  const liveButton = owner.locator('mux-cos').locator('button.cbtn.voice.live').first();
  gate('same_provider_bridge_survives_A_B', await liveButton.count() === 1 && sdpCountBeforeNavigation === 1, { sdp_exchanges: sdpCountBeforeNavigation });

  // Web Speech itself requires a service outside the DTU. This API-edge stub is
  // only used to prove the product's capture identity fence, never recognition.
  await owner.locator('mux-cos').getByRole('button', { name: 'Type instead, without ending the spoken conversation' }).click();
  const dictate = owner.locator('mux-cos').getByRole('button', { name: 'Dictate' });
  await dictate.click();
  await select(`app voice fixture B ${stamp}`);
  const lateDraft = await owner.evaluate(() => {
    const recognition = window.__appVoiceRecognition?.at(-1);
    const result = { 0: { 0: { transcript: 'late synthetic final' }, length: 1, isFinal: true }, length: 1 };
    recognition?.onresult?.({ results: result, resultIndex: 0 });
    recognition?.onend?.(new Event('end'));
    return true;
  });
  await select(`app voice fixture A ${stamp}`);
  gate('dictation_late_events_fenced', lateDraft === true && await owner.locator('[data-thread-composer]').inputValue() === '', {
    classification: 'SCRIPTED_RECOGNITION_API_NOT_ACOUSTIC',
  });

  // Current app observation is fetched through the provider sideband, not from
  // an injected product store, then used to request a real existing draft setter.
  await inject(callId, { type: 'input_audio_buffer.committed', item_id: 'fixture_input_draft' });
  const draftCreate = await eventually(async () => {
    const items = (await fixtureCommands(callId)).filter((item) => item.type === 'response.create');
    return items.length > 2 ? items.at(-1) : null;
  }, 'draft response request');
  await inject(callId, { type: 'response.created', response: { id: 'fixture_response_draft_observe', metadata: responseMetadata(draftCreate) } });
  await inject(callId, {
    type: 'response.function_call_arguments.done', response_id: 'fixture_response_draft_observe',
    item: { id: 'fixture_item_draft_observe', call_id: 'fixture_call_draft_observe' }, name: 'app_observe', arguments: '{}',
  });
  const current = await eventually(async () => firstOutput(await fixtureCommands(callId), (item) => Boolean(item.active?.composer?.channel_id)), 'current app observation');
  await inject(callId, { type: 'response.done', response_id: 'fixture_response_draft_observe' });
  await inject(callId, { type: 'input_audio_buffer.committed', item_id: 'fixture_input_draft_set' });
  const setCreate = await eventually(async () => {
    const items = (await fixtureCommands(callId)).filter((item) => item.type === 'response.create');
    return items.length > 3 ? items.at(-1) : null;
  }, 'draft set response request');
  await inject(callId, { type: 'response.created', response: { id: 'fixture_response_draft_set', metadata: responseMetadata(setCreate) } });
  await inject(callId, {
    type: 'response.function_call_arguments.done', response_id: 'fixture_response_draft_set',
    item: { id: 'fixture_item_draft_set', call_id: 'fixture_call_draft_set' }, name: 'composer_draft',
    arguments: JSON.stringify({ expected_revision: current.revision, mode: 'set', target: {
      kind: 'composer', ...current.active.composer,
    }, text: 'APP_VOICE_DRAFT_ONLY' }),
  });
  await eventually(() => owner.locator('[data-thread-composer]').inputValue().then((value) => value === 'APP_VOICE_DRAFT_ONLY'), 'actual composer draft set');
  gate('composer_draft_set_without_submit', records().length === providerStart, { provider_turns_created: 0 });
  await inject(callId, { type: 'response.done', response_id: 'fixture_response_draft_set' });

  const active = current.active.composer;
  if (!a.thread?.machine_id) throw new Error('selected A thread did not expose required machine_id; submit_thread_turn remains blocked');
  await inject(callId, { type: 'input_audio_buffer.committed', item_id: 'fixture_input_submit' });
  const submitCreate = await eventually(async () => {
    const items = (await fixtureCommands(callId)).filter((item) => item.type === 'response.create');
    return items.length > 4 ? items.at(-1) : null;
  }, 'submit response request');
  await inject(callId, { type: 'response.created', response: { id: 'fixture_response_submit', metadata: responseMetadata(submitCreate) } });
  await inject(callId, {
    type: 'response.function_call_arguments.done', response_id: 'fixture_response_submit',
    item: { id: 'fixture_item_submit', call_id: 'fixture_call_submit' }, name: 'submit_thread_turn',
    arguments: JSON.stringify({ expected_revision: current.revision, target: {
      kind: 'thread_turn', ...active, machine_id: a.thread.machine_id,
    }, text: 'APP_VOICE_A_ONLY' }),
  });
  const confirm = owner.locator('mux-cos').getByTestId('app-voice-submit-confirm');
  await confirm.waitFor({ state: 'visible', timeout: 10_000 });
  await confirm.click();
  await command(callId, 'conversation.item.create', (item) => Boolean(item.output?.turn_id));
  const newRecords = records().slice(providerStart);
  gate('submit_thread_turn_visible_confirmation_and_A_only_dispatch', newRecords.length > 0, {
    A_thread_sha256: sha(a.thread.id),
    B_thread_sha256: sha(b.thread.id),
    provider_turn_count: newRecords.length,
  });
  await inject(callId, { type: 'response.done', response_id: 'fixture_response_submit' });
  remaining('not exercised by this bounded core flow; the DTU parent may extend these with stable final UI selectors');
  run.status = 'PASS';
} catch (error) {
  if (!firstFailure) firstFailure = 'runner_setup_or_transport';
  // Do not copy provider/browser error bodies into an artifact: they can
  // contain private prompts, endpoint detail, or credential-shaped values.
  run.errors.push('gated flow failed; inspect private DTU process logs');
  remaining(firstFailure ? `not run after gated failure: ${firstFailure}` : 'not run after runner setup failure');
} finally {
  await peerPage?.evaluate(async () => {
    window.__appVoicePeer?.oscillator?.stop();
    await window.__appVoicePeer?.audio?.close();
    window.__appVoicePeer?.peer?.close();
  }).catch(() => {});
  await browser?.close();
  if (firstFailure) run.first_failure = firstFailure;
  privateOutput(path.join(output, 'results.json'), run);
}
console.log(JSON.stringify({ status: run.status, mode: run.mode }));
process.exitCode = run.status === 'PASS' ? 0 : 1;