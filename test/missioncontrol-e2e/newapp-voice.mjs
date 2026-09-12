#!/usr/bin/env node
/*
 * Private DTU-only app-voice integration driver. The product browser and
 * WebRTC implementation are real. The peer, provider events, and recognition
 * edge are fixtures: synthetic media/recognition are never acoustic or STT.
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
    --source-sha <40-git-sha|64-source-archive-sha256> --accept-disposable-fixtures \\
    [--playwright-module <module-or-absolute-path>]

Requires an already-running isolated browser/server/sessiond/sideband DTU and
realtimefixture --rtc-relay. It never starts or stops product processes.
REALRTC_SYNTHETIC_MEDIA and SCRIPTED_RECOGNITION_API are not acoustic/STT proof.`;

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return { help: true };
    if (!key.startsWith('--')) throw new Error('invalid_argument');
    const name = key.slice(2);
    if (name === 'accept-disposable-fixtures' || name === 'headed') { out[name] = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('missing_argument_value');
    out[name] = value;
  }
  return out;
}
const opt = parseArgs(process.argv.slice(2));
if (opt.help) { console.log(usage); process.exit(0); }
for (const name of ['base-url', 'fixture-url', 'fixture-ca', 'muxterm-bin', 'provider-records', 'output', 'source-sha']) {
  if (!opt[name]) throw new Error(`required_${name}`);
}
if (!opt['accept-disposable-fixtures']) throw new Error('disposable_fixture_consent_required');
if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(opt['source-sha'])) throw new Error('invalid_source_reference');
if (!fs.existsSync(opt['fixture-ca']) || !fs.existsSync(opt['muxterm-bin']) || !fs.existsSync(opt['provider-records'])) throw new Error('missing_prepared_fixture_input');
if (typeof tls.setDefaultCACertificates !== 'function' || typeof tls.getCACertificates !== 'function') throw new Error('node_22_19_tls_required');
tls.setDefaultCACertificates([...tls.getCACertificates('default'), fs.readFileSync(opt['fixture-ca'], 'utf8')]);

const base = new URL(opt['base-url']);
const fixture = new URL(opt['fixture-url']);
if (fixture.protocol !== 'https:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(fixture.hostname)) throw new Error('fixture_must_be_loopback_https');
const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const output = path.resolve(opt.output);
const outside = path.relative(repository, output);
if (outside === '' || (!outside.startsWith(`..${path.sep}`) && outside !== '..')) throw new Error('output_must_be_private_and_outside_repository');

const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch { /* private runner errors stay private */ }
    await wait(100);
  }
  throw new Error(`timeout_${label}`);
}
function writePrivate(name, value) {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function wav(file) {
  const rate = 48_000;
  const samples = rate / 2;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 1200), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, buffer, { mode: 0o600 });
}
function providerRecords() {
  const rows = JSON.parse(fs.readFileSync(opt['provider-records'], 'utf8'));
  if (!Array.isArray(rows)) throw new Error('provider_records_schema_invalid');
  return rows;
}
function inputText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(inputText).join('\n');
  if (value && typeof value === 'object') return Object.entries(value)
    .filter(([key]) => ['text', 'content', 'input'].includes(key))
    .map(([, item]) => inputText(item)).join('\n');
  return '';
}
async function fixtureControl(operation, extra = {}) {
  const response = await fetch(new URL('/__fixture/control', fixture), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, ...extra }),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
async function fixtureOK(operation, extra = {}) {
  const reply = await fixtureControl(operation, extra);
  if (!reply.response.ok) throw new Error(`fixture_${operation}_${reply.response.status}`);
  return reply.body;
}
async function commands(callId) { return (await fixtureOK('inspect', { call_id: callId })).commands ?? []; }
async function nextCommand(callId, after, type, predicate = () => true) {
  return eventually(async () => (await commands(callId)).slice(after).find((item) => item.type === type && predicate(item)), `command_${type}`);
}
function createWorkspace(label) {
  const out = JSON.parse(execFileSync(opt['muxterm-bin'], ['workspace', 'create', label, '--json'], { encoding: 'utf8', env: process.env }));
  if (typeof out.workspaceId !== 'string' || !out.workspaceId) throw new Error('workspace_create_shape_invalid');
  return out.workspaceId;
}
function appMetadata(command) {
  const metadata = command?.metadata;
  if (!metadata || typeof metadata.app_voice_capture_id !== 'string' || !metadata.app_voice_capture_id) throw new Error('missing_app_capture_metadata');
  return metadata;
}
function composerTarget(active) {
  const source = active?.composer;
  if (!source) throw new Error('missing_active_composer');
  return {
    kind: 'composer',
    channel_id: source.channel_id,
    thread_id: source.thread_id,
    runtime_generation: source.runtime_generation,
    draft_ref: source.draft_ref,
  };
}
function threadTarget(active, machineID) {
  const source = active?.composer;
  if (!source || !machineID) throw new Error('missing_thread_target_identity');
  return {
    kind: 'thread_turn',
    channel_id: source.channel_id,
    thread_id: source.thread_id,
    runtime_session_id: source.runtime_session_id,
    runtime_generation: source.runtime_generation,
    runtime_incarnation: source.runtime_incarnation,
    draft_ref: source.draft_ref,
    machine_id: machineID,
  };
}

const sourceReference = /^[0-9a-f]{40}$/i.test(opt['source-sha'])
  ? { type: 'git_sha', value: opt['source-sha'].toLowerCase() }
  : { type: 'source_archive_sha256', value: opt['source-sha'].toLowerCase() };
const run = {
  format: 'missioncontrol-app-voice-e2e-v2',
  mode: ['REALRTC_SYNTHETIC_MEDIA', 'SCRIPTED_PROVIDER', 'SCRIPTED_RECOGNITION_API'],
  status: 'FAIL',
  source_reference: sourceReference,
  limitations: ['Synthetic software media only; not acoustic.', 'Recognition/provider events are fixture edges; not cloud or physical STT.'],
  checks: {},
  errors: [],
};
let stage = 'setup';
let firstFailure = '';
let browser;
let peerPage;
const pass = (name, evidence = {}) => { run.checks[name] = { status: 'PASS', ...evidence }; };
const blocked = (name, reason) => { if (!run.checks[name]) run.checks[name] = { status: 'BLOCKED', reason }; };
function gate(name, condition, evidence = {}) {
  if (condition) return pass(name, evidence);
  if (!firstFailure) firstFailure = name;
  run.checks[name] = { status: 'FAIL', ...evidence };
  throw new Error(`assertion_${name}`);
}
function blockRemainder(reason) {
  for (const name of ['pane_applet_navigation_preserves_bridge', 'rapid_navigation_refuses_pending_submit', 'two_browser_takeover_drain', 'owner_disconnect_fences_lease', 'replayed_sdp_and_cross_origin_refused', 'known_lane_transcript_attribution']) blocked(name, reason);
}

try {
  stage = 'prepared_records';
  const providerStart = providerRecords().length;
  const stamp = randomUUID().slice(0, 8);
  const labelA = `app voice fixture A ${stamp}`;
  const labelB = `app voice fixture B ${stamp}`;
  const workspaceA = createWorkspace(labelA);
  const workspaceB = createWorkspace(labelB);
  pass('fresh_disposable_workspaces_created', { count: 2 });

  stage = 'browser_launch';
  wav(path.join(output, 'synthetic-input.wav'));
  const require = createRequire(import.meta.url);
  const playwrightModule = opt['playwright-module'] ?? path.resolve(repository, 'test/voice-e2e/node_modules/playwright-core');
  const { chromium } = require(playwrightModule);
  browser = await chromium.launch({
    channel: 'chrome', headless: !opt.headed,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(output, 'synthetic-input.wav')}`],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const instances = [];
    class FixtureSpeechRecognition extends EventTarget {
      constructor() { super(); instances.push(this); }
      continuous = false; interimResults = false; onresult = null; onerror = null; onend = null;
      start() { this.started = (this.started ?? 0) + 1; }
      stop() { this.stopped = (this.stopped ?? 0) + 1; queueMicrotask(() => this.onend?.(new Event('end'))); }
      abort() { this.aborted = (this.aborted ?? 0) + 1; queueMicrotask(() => this.onend?.(new Event('end'))); }
    }
    window.__fixtureSpeech = {
      instances,
      emit(index, text, final) {
        const instance = instances[index];
        const result = { 0: { 0: { transcript: text }, length: 1, isFinal: final }, length: 1 };
        instance?.onresult?.({ results: result, resultIndex: 0 });
      },
      end(index) { instances[index]?.onend?.(new Event('end')); },
    };
    window.SpeechRecognition = FixtureSpeechRecognition;
    window.webkitSpeechRecognition = FixtureSpeechRecognition;
  });
  const frames = [];
  const voiceResponses = [];
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    try {
      const frame = JSON.parse(String(payload));
      if (frame.type === 'missioncontrol-result' || frame.type === 'missioncontrol-event') frames.push(frame);
    } catch { /* unrelated transport */ }
  }));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/app/voice/')) voiceResponses.push({ path: url.pathname, status: response.status() });
  });
  await page.goto(base.href, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Mission Control/ }).first().click();
  await page.locator('[data-thread-context-selector]').waitFor({ state: 'visible', timeout: 30_000 });
  async function select(label) {
    const cursor = frames.length;
    await page.locator('[data-thread-context-selector]').click();
    const option = page.locator('button[data-thread-context-option]', { hasText: label });
    await option.waitFor({ state: 'visible', timeout: 30_000 });
    await option.click();
    await page.locator('[data-thread-talk-here]').click();
    const receipt = await eventually(() => frames.slice(cursor).find((frame) => frame.op === 'select' && frame.ok === true && frame.thread?.display_name === label), 'ui_select');
    // The WebSocket receipt is authoritative, but Playwright can receive it
    // before Lit has rendered the new composer. Do not fill/click an old DOM
    // element while its selected store identity is already changing.
    await eventually(async () =>
      (await page.locator('[data-thread-context-selector]').innerText()).includes(label) &&
      await page.locator('[data-thread-composer]').isVisible() &&
      await page.locator('[data-thread-composer]').isEnabled(), 'ui_composer_ready');
    await page.evaluate(() => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return receipt;
  }
  stage = 'real_ui_selection';
  const a = await select(labelA);
  const b = await select(labelB);
  await page.locator('[data-thread-composer]').fill('B_CANARY=amber-kite');
  await select(labelA);
  gate('real_ui_thread_selection', Boolean(a.thread?.id && a.thread?.machine_id && b.thread?.id && a.thread.id !== b.thread.id), { A_thread_sha256: sha(a.thread?.id ?? ''), B_thread_sha256: sha(b.thread?.id ?? '') });

  stage = 'dictation_before_conversation';
  const dictation = page.locator('mux-cos').getByRole('button', { name: 'Dictate' });
  await dictation.click();
  await eventually(() => page.evaluate(() => window.__fixtureSpeech.instances.length === 1 && window.__fixtureSpeech.instances[0].started === 1), 'dictation_start');
  await page.evaluate(() => { window.__fixtureSpeech.emit(0, 'ACCEPTED_A_DRAFT', true); window.__fixtureSpeech.end(0); });
  await eventually(() => page.locator('[data-thread-composer]').inputValue().then((text) => text.includes('ACCEPTED_A_DRAFT')), 'accepted_A_dictation');
  await dictation.click();
  await eventually(() => page.evaluate(() => window.__fixtureSpeech.instances.length === 2 && window.__fixtureSpeech.instances[1].started === 1), 'second_dictation_start');
  await select(labelB);
  await page.evaluate(() => { window.__fixtureSpeech.emit(1, 'LATE_A_PARTIAL', false); window.__fixtureSpeech.emit(1, 'LATE_A_FINAL', true); window.__fixtureSpeech.end(1); });
  gate('dictation_late_events_fenced', await page.locator('[data-thread-composer]').inputValue() === 'B_CANARY=amber-kite', { classification: 'SCRIPTED_RECOGNITION_API_NOT_ACOUSTIC' });
  await select(labelA);
  gate('accepted_A_dictation_retained', (await page.locator('[data-thread-composer]').inputValue()).includes('ACCEPTED_A_DRAFT'));

  stage = 'app_voice_start';
  const voice = page.locator('mux-cos').locator('button[data-voice-state]').first();
  await voice.click();
  const pending = await eventually(async () => {
    const reply = await fixtureControl('pending_offer');
    return reply.response.ok ? reply.body : null;
  }, 'pending_offer');
  gate('bounded_private_browser_offer', typeof pending.call_id === 'string' && typeof pending.offer_sdp === 'string', { call_id_sha256: sha(pending.call_id ?? '') });
  peerPage = await context.newPage();
  await peerPage.goto('about:blank');
  stage = 'real_rtc_peer_answer';
  const answer = await peerPage.evaluate(async (offer) => {
    const peer = new RTCPeerConnection();
    const events = [];
    window.__fixturePeer = { peer, events };
    peer.ondatachannel = ({ channel }) => {
      channel.onmessage = (event) => { try { events.push(JSON.parse(String(event.data)).type ?? 'unknown'); } catch { events.push('non_json'); } };
      channel.onopen = () => {
        channel.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture-peer' } }));
        channel.send(JSON.stringify({ type: 'session.updated', session: { type: 'realtime' } }));
      };
    };
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start();
    window.__fixturePeer.audio = audio; window.__fixturePeer.oscillator = oscillator;
    for (const track of destination.stream.getTracks()) peer.addTrack(track, destination.stream);
    await peer.setRemoteDescription({ type: 'offer', sdp: offer });
    await peer.setLocalDescription(await peer.createAnswer());
    await new Promise((resolve) => {
      if (peer.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(resolve, 10_000);
      peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
    });
    return peer.localDescription.sdp;
  }, pending.offer_sdp);
  await fixtureOK('answer_sdp', { call_id: pending.call_id, answer_sdp: answer });
  await eventually(() => voiceResponses.some((row) => row.path === '/api/app/voice/sdp' && row.status >= 200 && row.status < 300), 'product_sdp_success');
  await eventually(() => peerPage.evaluate(() => window.__fixturePeer.peer.connectionState === 'connected'), 'dtls_ice_connected');
  gate('real_webrtc_dtls_ice_datachannel', (await peerPage.evaluate(() => window.__fixturePeer.events)).includes('session.update'));
  const callId = pending.call_id;
  await eventually(() => fixtureOK('inspect', { call_id: callId }).then((row) => row.connected === true), 'sideband_wss');
  pass('REALRTC_SYNTHETIC_MEDIA', { call_id_sha256: sha(callId) });

  stage = 'A_B_lobby_navigation';
  const sdpBeforeNavigation = voiceResponses.filter((row) => row.path === '/api/app/voice/sdp').length;
  const tokenBeforeNavigation = voiceResponses.filter((row) => row.path === '/api/app/voice/token').length;
  await select(labelB);
  await page.locator('[data-thread-context-selector]').click();
  const lobby = page.locator('button[data-thread-context-option][aria-label="Lobby"]');
  await lobby.waitFor({ state: 'visible', timeout: 30_000 });
  await lobby.click();
  await page.locator('[data-thread-talk-here]').click();
  await eventually(() => page.locator('[data-thread-context-selector]').innerText().then((text) => text.includes('Lobby')), 'lobby_selection');
  await select(labelA);
  gate('A_B_lobby_navigation_preserves_one_token_sdp_call', voiceResponses.filter((row) => row.path === '/api/app/voice/sdp').length === sdpBeforeNavigation && voiceResponses.filter((row) => row.path === '/api/app/voice/token').length === tokenBeforeNavigation && (await page.locator('mux-cos').locator('button[data-voice-state]:not([data-voice-state="idle"]):not([data-voice-state="error"])').count()) === 1, { token_requests: tokenBeforeNavigation, sdp_requests: sdpBeforeNavigation, call_id_sha256: sha(callId) });

  stage = 'conversation_dictation_blocked';
  const recognitionsBefore = await page.evaluate(() => window.__fixtureSpeech.instances.length);
  const blockedMic = page.locator('mux-cos').getByRole('button', { name: 'Dictate' });
  gate('conversation_hides_or_blocks_dictation', await blockedMic.count() === 0 || await blockedMic.isDisabled());
  gate('conversation_mic_arbiter_no_hidden_recognition', await page.evaluate((before) => window.__fixtureSpeech.instances.length === before, recognitionsBefore));

  let responseNumber = 0;
  async function beginUtterance(name, args) {
    stage = `utterance_${name}`;
    const before = (await commands(callId)).length;
    responseNumber += 1;
    const responseID = `fixture_response_${responseNumber}`;
    const itemID = `fixture_item_${responseNumber}`;
    const functionCallID = `fixture_function_${responseNumber}`;
    gate(`transport_call_is_distinct_from_tool_call_${responseNumber}`, functionCallID !== callId);
    await fixtureOK('inject', { call_id: callId, event: { type: 'input_audio_buffer.committed', item_id: `fixture_input_${responseNumber}` } });
    const initial = await nextCommand(callId, before, 'response.create', (row) => typeof row.metadata?.app_voice_capture_id === 'string');
    const metadata = appMetadata(initial);
    await fixtureOK('inject', { call_id: callId, event: { type: 'response.created', response: { id: responseID, metadata } } });
    await fixtureOK('inject', { call_id: callId, event: { type: 'response.output_item.added', response_id: responseID, item: { type: 'function_call', id: itemID, call_id: functionCallID } } });
    const afterMap = (await commands(callId)).length;
    const final = { type: 'response.function_call_arguments.done', response_id: responseID, item_id: itemID, name, arguments: JSON.stringify(args) };
    await fixtureOK('inject', { call_id: callId, event: final });
    return { metadata, functionCallID, responseID, before, afterMap, final };
  }
  async function finishUtterance(pending) {
    const { metadata, functionCallID, responseID, afterMap } = pending;
    const output = await nextCommand(callId, afterMap, 'conversation.item.create', (row) => row.function_call_id === functionCallID && row.output);
    gate(`tool_output_call_binding_${responseNumber}`, output.function_call_id === functionCallID);
    await fixtureOK('inject', { call_id: callId, event: { type: 'response.done', response_id: responseID } });
    const continuation = await nextCommand(callId, afterMap, 'response.create', (row) => row.metadata?.app_voice_capture_id === metadata.app_voice_capture_id && row.metadata?.app_voice_response_nonce && row.metadata.app_voice_response_nonce !== metadata.app_voice_response_nonce);
    const continuationID = `${responseID}_continuation`;
    await fixtureOK('inject', { call_id: callId, event: { type: 'response.created', response: { id: continuationID, metadata: continuation.metadata } } });
    await fixtureOK('inject', { call_id: callId, event: { type: 'response.done', response_id: continuationID } });
    return { ...pending, output: output.output };
  }
  async function newUtterance(name, args) {
    return finishUtterance(await beginUtterance(name, args));
  }

  stage = 'app_observe_inventory';
  const observation = await newUtterance('app_observe', {});
  const inventory = observation.output;
  gate('app_observe_inventory_and_revision', Number.isSafeInteger(inventory?.revision) && inventory.revision > 0 && Number.isInteger(inventory?.machines_count) && Number.isInteger(inventory?.workspaces_count) && Number.isInteger(inventory?.threads_count) && Number.isInteger(inventory?.fleet_count) && inventory.active, { revision: inventory?.revision ?? 0, machines: inventory?.machines_count ?? -1, workspaces: inventory?.workspaces_count ?? -1, threads: inventory?.threads_count ?? -1, fleet: inventory?.fleet_count ?? -1 });

  stage = 'unknown_lane_transcript_refusal';
  const unknownTranscript = await newUtterance('read_lane_transcript', { machine: 'unknown-fixture-machine', session_id: 'unknown-fixture-session', last_n: 1 });
  gate('unknown_lane_transcript_refuses_without_local_fallback', unknownTranscript.output?.status === 'refused');

  stage = 'voice_workspace_navigation';
  const workspaceNavigation = await newUtterance('navigate_app', { expected_revision: inventory.revision, target: { kind: 'workspace', workspace_id: workspaceB } });
  gate('navigate_app_authoritative_workspace_ack', workspaceNavigation.output?.selected_target?.workspace_id === workspaceB, { workspace_id_sha256: sha(workspaceB) });
  stage = 'voice_thread_navigation';
  const afterWorkspaceObserve = await newUtterance('app_observe', {});
  const selectedThread = await newUtterance('navigate_app', { expected_revision: afterWorkspaceObserve.output.revision, target: { kind: 'thread', thread_id: a.thread.id, runtime_generation: a.thread.runtime_generation } });
  gate('navigate_app_authoritative_thread_ack', selectedThread.output?.selected_target?.thread_id === a.thread.id, { A_thread_sha256: sha(a.thread.id) });

  stage = 'fresh_observation_before_draft';
  const draftObservation = await newUtterance('app_observe', {});
  const draft = await newUtterance('composer_draft', { expected_revision: draftObservation.output.revision, mode: 'set', target: composerTarget(draftObservation.output.active), text: 'APP_VOICE_DRAFT_ONLY' });
  await eventually(() => page.locator('[data-thread-composer]').inputValue().then((text) => text === 'APP_VOICE_DRAFT_ONLY'), 'draft_set');
  gate('composer_draft_set_without_submit', draft.output?.channel_id === draftObservation.output.active.composer.channel_id && providerRecords().length === providerStart);

  stage = 'fresh_observation_before_submit';
  const submitObservation = await newUtterance('app_observe', {});
  const submitPending = await beginUtterance('submit_thread_turn', { expected_revision: submitObservation.output.revision, target: threadTarget(submitObservation.output.active, a.thread.machine_id), text: 'A_CANARY=cobalt-otter FIXTURE_APP_VOICE_A' });
  const confirm = page.locator('mux-cos').getByTestId('app-voice-submit-confirm');
  await confirm.waitFor({ state: 'visible', timeout: 10_000 });
  await confirm.click();
  const submit = await finishUtterance(submitPending);
  await eventually(async () => providerRecords().length > providerStart, 'text_provider_dispatch');
  const dispatched = providerRecords().slice(providerStart);
  if (!dispatched.every((record) => record && typeof record === 'object' && record.request && Object.hasOwn(record.request, 'input'))) throw new Error('provider_record_schema_invalid');
  const allText = dispatched.map((record) => inputText(record.request.input)).join('\n');
  gate('submit_thread_turn_visible_confirmation_and_A_only_dispatch', submit.output?.thread_id === a.thread.id && allText.includes('A_CANARY=cobalt-otter') && !allText.includes('B_CANARY=amber-kite'), { A_thread_sha256: sha(a.thread.id), B_thread_sha256: sha(b.thread.id), dispatched_requests: dispatched.length });

  stage = 'duplicate_final_no_effect';
  const duplicateBefore = (await commands(callId)).length;
  await fixtureOK('inject', { call_id: callId, event: submit.final });
  await wait(500);
  const duplicateCommands = (await commands(callId)).slice(duplicateBefore);
  gate('exact_duplicate_final_no_extra_effect_or_fence', duplicateCommands.length === 0 && providerRecords().length === providerStart + dispatched.length);
  blockRemainder('not executed by the bounded core flow; parent DTU may extend with final stable selectors');
  run.status = 'PASS';
} catch (error) {
  if (!firstFailure) firstFailure = `stage_${stage}`;
  run.errors.push(`stage:${stage}`);
  // Bounded harness diagnostics, never HTTP bodies, tokens, SDP or app history.
  run.errors.push(`error_type:${error?.name ?? 'Error'}`);
  const message = String(error?.message ?? '');
  if (/^[a-zA-Z0-9_.: -]{1,160}$/.test(message)) run.errors.push(`detail:${message}`);
  blockRemainder(`not run after gated failure: ${firstFailure}`);
} finally {
  await peerPage?.evaluate(async () => {
    window.__fixturePeer?.oscillator?.stop();
    await window.__fixturePeer?.audio?.close();
    window.__fixturePeer?.peer?.close();
  }).catch(() => {});
  await browser?.close();
  if (firstFailure) run.first_failure = firstFailure;
  writePrivate('results.json', run);
}
console.log(JSON.stringify({ status: run.status, source_reference: run.source_reference.type }));
process.exitCode = run.status === 'PASS' ? 0 : 1;