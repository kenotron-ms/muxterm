#!/usr/bin/env node
/*
 * Private DTU-only single-Mission-Control integration driver. Product browser,
 * WebSocket, WebRTC, and sessiond are real; provider/recognition media are
 * disposable fixtures and are never acoustic or physical-microphone proof.
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
    [--playwright-module <module-or-absolute-path>] [--known-lane-session-id <id> --known-lane-machine <id>]

Requires an already-running disposable DTU. REALRTC_SYNTHETIC_MEDIA and
SCRIPTED_RECOGNITION_API are not acoustic/STT proof.`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (!key.startsWith('--')) throw new Error('invalid_argument');
    const name = key.slice(2);
    if (name === 'accept-disposable-fixtures' || name === 'headed') { out[name] = true; continue; }
    const value = argv[++i];
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
    try { const value = await fn(); if (value) return value; } catch { /* bounded retry */ }
    await wait(100);
  }
  throw new Error(`timeout_${label}`);
}
function writePrivate(name, value) {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function wav(file) {
  const rate = 48_000; const samples = rate / 2; const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 1200), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, b, { mode: 0o600 });
}
function providerRecords() { const rows = JSON.parse(fs.readFileSync(opt['provider-records'], 'utf8')); if (!Array.isArray(rows)) throw new Error('provider_records_schema_invalid'); return rows; }
function inputText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(inputText).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => ['text', 'content', 'input'].includes(key)).map(([, item]) => inputText(item)).join('\n');
  return '';
}
async function fixtureControl(operation, extra = {}) {
  const response = await fetch(new URL('/__fixture/control', fixture), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, ...extra }) });
  return { response, body: await response.json().catch(() => ({})) };
}
async function fixtureOK(operation, extra = {}) { const reply = await fixtureControl(operation, extra); if (!reply.response.ok) throw new Error(`fixture_${operation}_${reply.response.status}`); return reply.body; }
function createWorkspace(label) {
  const out = JSON.parse(execFileSync(opt['muxterm-bin'], ['workspace', 'create', label, '--json'], { encoding: 'utf8', env: process.env }));
  if (typeof out.workspaceId !== 'string' || !out.workspaceId) throw new Error('workspace_create_shape_invalid');
  return out.workspaceId;
}
function createPane(workspaceId) {
  const out = JSON.parse(execFileSync(opt['muxterm-bin'], ['pane', 'create', '--workspace', workspaceId, '--cmd', '/bin/sh', '--cmd', '-c', '--cmd', 'printf fixture-pane; exec /bin/sh', '--json'], { encoding: 'utf8', env: process.env }));
  if (!Number.isSafeInteger(out.paneId) || out.paneId < 1) throw new Error('pane_create_shape_invalid');
  return out.paneId;
}

const sourceReference = /^[0-9a-f]{40}$/i.test(opt['source-sha']) ? { type: 'git_sha', value: opt['source-sha'].toLowerCase() } : { type: 'source_archive_sha256', value: opt['source-sha'].toLowerCase() };
const run = { format: 'missioncontrol-app-voice-e2e-v3', mode: ['REALRTC_SYNTHETIC_MEDIA_NO_PHYSICAL_MIC', 'SCRIPTED_PROVIDER', 'SCRIPTED_RECOGNITION_API'], status: 'FAIL', source_reference: sourceReference, limitations: ['Synthetic software media only; not acoustic.', 'Recognition/provider events are fixture edges; not cloud or physical STT.'], checks: {}, errors: [] };
let stage = 'setup'; let firstFailure = ''; let browser; let page; let peerPage; const peerPages = new Set();
const protocolEvents = [];
function recordProtocol(direction, payload) {
  try {
    const frame = JSON.parse(String(payload));
    if (typeof frame.type !== 'string' || !(frame.type.startsWith('app-voice-') || frame.type.startsWith('cos-') || frame.type.startsWith('missioncontrol-'))) return;
    const row = { direction, type: frame.type };
    for (const key of ['code', 'action', 'client_ref']) if (typeof frame[key] === 'string' && /^[a-z0-9_-]{1,128}$/i.test(frame[key])) row[key] = frame[key];
    if (protocolEvents.length === 256) protocolEvents.shift(); protocolEvents.push(row);
  } catch { /* never persist payloads, credentials, SDP, or prompts */ }
}
const pass = (name, evidence = {}) => { run.checks[name] = { status: 'PASS', ...evidence }; };
function gate(name, condition, evidence = {}) { if (condition) return pass(name, evidence); if (!firstFailure) firstFailure = name; run.checks[name] = { status: 'FAIL', ...evidence }; throw new Error(`assertion_${name}`); }

try {
  stage = 'fixtures';
  const providerStart = providerRecords().length;
  const stamp = randomUUID().slice(0, 8);
  const workspaceA = createWorkspace(`single cos fixture A ${stamp}`);
  const workspaceB = createWorkspace(`single cos fixture B ${stamp}`);
  const paneB = createPane(workspaceB);
  pass('fresh_disposable_workspaces_created', { count: 2 });

  stage = 'browser'; wav(path.join(output, 'synthetic-input.wav'));
  const require = createRequire(import.meta.url); const playwrightModule = opt['playwright-module'] ?? path.resolve(repository, 'test/voice-e2e/node_modules/playwright-core');
  const { chromium } = require(playwrightModule);
  browser = await chromium.launch({ channel: 'chrome', headless: !opt.headed, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(output, 'synthetic-input.wav')}`] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); page = await context.newPage();
  await page.addInitScript(() => {
    const media = { streams: [], peers: [], audioContexts: [], audioElements: [] };
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await gum(...args); media.streams.push(stream); return stream; };
    const NativePeer = window.RTCPeerConnection;
    function ObservedPeer(...args) { const peer = new NativePeer(...args); media.peers.push(peer); return peer; }
    Object.setPrototypeOf(ObservedPeer, NativePeer); ObservedPeer.prototype = NativePeer.prototype; window.RTCPeerConnection = ObservedPeer;
    const NativeAudio = window.Audio;
    function ObservedAudio(...args) { const audio = new NativeAudio(...args); media.audioElements.push(audio); return audio; }
    Object.setPrototypeOf(ObservedAudio, NativeAudio); ObservedAudio.prototype = NativeAudio.prototype; window.Audio = ObservedAudio;
    window.__fixtureMedia = media;
  });
  const frames = []; const voiceResponses = []; const postPaths = []; const browserErrors = [];
  page.on('websocket', (socket) => { socket.on('framesent', ({ payload }) => recordProtocol('sent', payload)); socket.on('framereceived', ({ payload }) => { recordProtocol('received', payload); try { const f = JSON.parse(String(payload)); if (typeof f.type === 'string' && f.type.startsWith('cos-')) frames.push({ ...f, _receivedAt: Date.now() }); } catch {} }); });
  page.on('response', (response) => { if (new URL(response.url()).pathname.startsWith('/api/app/voice/')) voiceResponses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  page.on('request', (request) => { if (request.method() === 'POST') postPaths.push(new URL(request.url()).pathname); });
  page.on('pageerror', (error) => browserErrors.push(error?.name ?? 'BrowserError'));

  stage = 'single_cos_boot'; const bootAt = Date.now();
  await page.goto(base.href, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const label = document.createElement('div');
    label.textContent = 'REALRTC_SYNTHETIC_MEDIA_NO_PHYSICAL_MIC';
    Object.assign(label.style, { position: 'fixed', left: '4px', bottom: '4px', zIndex: '9999', padding: '4px', background: '#fff4cc', color: '#111', font: '11px system-ui', pointerEvents: 'none' });
    document.body.append(label);
  });
  await wait(500);
  gate('startup_has_no_eager_cos_or_multichannel_traffic', !protocolEvents.some((x) => x.type === 'cos-subscribe' || x.type.startsWith('missioncontrol-')));
  await page.getByRole('button', { name: /Mission Control/ }).first().click();
  const composer = page.locator('[data-thread-composer]');
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  await eventually(() => frames.find((f) => f.type === 'cos-subscribe-result' && f.ok === true && f.conversation?.id && f.conversation?.session_id && Number.isSafeInteger(f.conversation?.generation) && f.conversation?.generation > 0 && f.conversation?.incarnation), 'cos_conversation_identity');
  const subscribe = frames.find((f) => f.type === 'cos-subscribe-result' && f.ok === true);
  const identity = subscribe.conversation;
  gate('one_single_cos_surface_without_thread_picker', await page.locator('[data-thread-context-selector]').count() === 0 && await page.locator('mux-cos').getByText('Lobby', { exact: true }).count() === 0 && await composer.getAttribute('placeholder') === 'Message Mission Control…', { nav_to_ready_ms: Date.now() - bootAt, conversation_id_sha256: sha(identity.id), generation: identity.generation });
  await page.screenshot({ path: path.join(output, 'mission-control-desktop.png') });

  stage = 'cos_turn'; const canary = `ECHO_SINGLE_COS_${stamp}`;
  const mutationStart = await page.locator('mux-cos').evaluate((element) => {
    window.__mcMutationCount = 0;
    window.__mcMutationObserver?.disconnect();
    window.__mcMutationObserver = new MutationObserver((rows) => { window.__mcMutationCount += rows.length; });
    window.__mcMutationObserver.observe(element.shadowRoot ?? element, { subtree: true, childList: true, characterData: true });
    return performance.now();
  });
  await composer.fill(canary); await page.locator('mux-cos button[aria-label="Send"]').click();
  await eventually(() => frames.find((f) => f.type === 'cos-turn-result' && f.ok === true), 'cos_turn_receipt');
  await eventually(() => frames.find((f) => f.type === 'cos-event' && f.event?.ev === 'turn_end'), 'cos_turn_end');
  const providerText = providerRecords().slice(providerStart).map((record) => inputText(record.request?.input)).join('\n');
  gate('native_cos_turn_receipt_and_terminal_event', providerText.includes(canary) && await page.locator('mux-cos').getByText(canary).count() > 0);
  const beforeIdleFrames = frames.length; const beforeIdleMutations = await page.evaluate(() => window.__mcMutationCount ?? 0); await wait(2000);
  gate('idle_single_cos_has_no_periodic_traffic_or_rerender_loop', frames.length === beforeIdleFrames && (await page.evaluate(() => window.__mcMutationCount ?? 0)) === beforeIdleMutations, { observation_started_ms: Math.round(mutationStart) });
  gate('no_multichannel_frames_sent', !protocolEvents.some((x) => x.direction === 'sent' && x.type.startsWith('missioncontrol-')));

  stage = 'refresh_persistence';
  const beforeReload = frames.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Mission Control/ }).first().click();
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  const refreshed = await eventually(() => frames.slice(beforeReload).find((f) =>
    f.type === 'cos-subscribe-result' && f.ok === true && f.conversation?.id === identity.id &&
    f.conversation?.session_id === identity.session_id), 'refresh_same_cos_identity');
  const history = await eventually(() => frames.slice(beforeReload).find((f) =>
    f.type === 'cos-history' && JSON.stringify(f.turns ?? []).includes(canary)), 'refresh_cos_history_canary');
  gate('refresh_preserves_native_cos_identity_and_history', Boolean(refreshed && history), {
    conversation_id_sha256: sha(identity.id), session_id_sha256: sha(identity.session_id),
  });

  stage = 'responsive_and_workspace_navigation';
  await composer.fill('DRAFT_SURVIVES_NAVIGATION');
  await page.getByText(`single cos fixture B ${stamp}`, { exact: true }).first().click();
  await eventually(() => page.locator('mux-dock').count().then(Boolean), 'workspace_b_visible');
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: /Mission Control/ }).first().click();
  await composer.waitFor({ state: 'visible' });
  gate('workspace_navigation_does_not_rebind_single_conversation_or_draft', await composer.inputValue() === 'DRAFT_SURVIVES_NAVIGATION' && frames.filter((f) => f.type === 'cos-subscribe-result').at(-1)?.conversation?.id === identity.id);
  await page.screenshot({ path: path.join(output, 'mission-control-portrait.png') });
  await page.setViewportSize({ width: 844, height: 390 }); await page.screenshot({ path: path.join(output, 'mission-control-landscape.png') });
  await page.setViewportSize({ width: 1280, height: 900 });

  async function connectSyntheticPeer(offer) {
    const peer = await context.newPage(); peerPages.add(peer); await peer.goto('about:blank');
    const answer = await peer.evaluate(async (sdp) => {
      const peerConnection = new RTCPeerConnection(); const events = [];
      window.__fixturePeer = { peerConnection, events, channel: null, audio: new AudioContext() };
      peerConnection.ondatachannel = ({ channel }) => { window.__fixturePeer.channel = channel; channel.onmessage = (e) => { try { events.push(JSON.parse(String(e.data)).type ?? 'unknown'); } catch { events.push('non_json'); } }; channel.onopen = () => channel.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture-peer' } })); };
      const oscillator = window.__fixturePeer.audio.createOscillator(); const destination = window.__fixturePeer.audio.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start(); window.__fixturePeer.oscillator = oscillator;
      for (const track of destination.stream.getTracks()) peerConnection.addTrack(track, destination.stream);
      await peerConnection.setRemoteDescription({ type: 'offer', sdp }); await peerConnection.setLocalDescription(await peerConnection.createAnswer());
      await new Promise((resolve) => { if (peerConnection.iceGatheringState === 'complete') return resolve(); const timer = setTimeout(resolve, 10_000); peerConnection.addEventListener('icegatheringstatechange', () => { if (peerConnection.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } }); });
      return peerConnection.localDescription.sdp;
    }, offer);
    return { peer, answer };
  }

  stage = 'real_rtc';
  const startVoice = page.locator('mux-cos [data-voice-mode-button][aria-label="Start voice mode"]:visible');
  gate('one_mission_control_header_voice_control', await startVoice.count() === 1);
  const mint = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/app/voice/token' && response.request().method() === 'POST');
  await startVoice.click(); const minted = await mint; const mintedBody = await minted.json();
  gate('provider_mint_observed_without_secret_persistence', minted.ok() && typeof mintedBody?.session_id === 'string' && mintedBody.session_id.length > 0, { provider_session_sha256: sha(mintedBody?.session_id ?? '') });
  const pending = await eventually(async () => { const reply = await fixtureControl('pending_offer'); return reply.response.ok && typeof reply.body.offer_sdp === 'string' ? reply.body : null; }, 'pending_offer');
  const peer = await connectSyntheticPeer(pending.offer_sdp); peerPage = peer.peer;
  await fixtureOK('answer_sdp', { call_id: pending.call_id, answer_sdp: peer.answer });
  await eventually(() => peerPage.evaluate(() => window.__fixturePeer.peerConnection.connectionState === 'connected'), 'real_rtc_connected');
  const bubble = page.locator('mux-voice-mode-bubble [data-voice-mode-bubble]:visible');
  await eventually(() => bubble.count().then((n) => n === 1), 'one_live_bubble');
  const bubbleControl = page.locator('mux-voice-mode-bubble [data-voice-mode-button]:visible');
  const circles = await bubbleControl.locator('mux-voice-mode-icon svg circle').count();
  gate('real_rtc_single_outline_live_bubble', await bubbleControl.count() === 1 && circles === 0 && await bubbleControl.evaluate((button) => getComputedStyle(button).borderTopWidth !== '0px'), { classification: 'REALRTC_SYNTHETIC_MEDIA_NO_PHYSICAL_MIC' });
  await page.screenshot({ path: path.join(output, 'REAL-RTC-SYNTHETIC-MEDIA-NO-PHYSICAL-MIC-active-bubble.png') });

  stage = 'pause_resume'; const tokenCount = voiceResponses.filter((x) => x.path === '/api/app/voice/token').length; const endCount = postPaths.filter((x) => x === '/api/app/voice/end').length;
  await bubbleControl.click(); await eventually(() => bubble.getAttribute('data-paused').then((state) => state === 'true'), 'bubble_paused');
  gate('bubble_pause_preserves_peer_and_detaches_sender_track', await page.evaluate(() => {
    const media = window.__fixtureMedia; const peer = media.peers[0]; const stream = media.streams[0];
    return peer?.connectionState === 'connected' && stream?.getAudioTracks().every((track) => !track.enabled) &&
      peer.getSenders().filter((sender) => sender.track?.kind === 'audio').length === 0 &&
      media.audioElements.every((audio) => audio.paused && audio.muted);
  }), { provider_end_requests: postPaths.filter((x) => x === '/api/app/voice/end').length - endCount });
  await page.screenshot({ path: path.join(output, 'pause-bubble.png') });
  await bubbleControl.press('Space'); await eventually(() => page.evaluate(() => {
    const media = window.__fixtureMedia; return media.streams[0]?.getAudioTracks().every((track) => track.enabled) &&
      media.peers[0]?.getSenders().some((sender) => sender.track === media.streams[0].getAudioTracks()[0]) &&
      media.audioElements.every((audio) => !audio.paused && !audio.muted);
  }), 'bubble_resumed');
  gate('bubble_resume_preserves_provider_session', voiceResponses.filter((x) => x.path === '/api/app/voice/token').length === tokenCount && await peerPage.evaluate(() => window.__fixturePeer.peerConnection.connectionState === 'connected'));

  stage = 'generation_stop';
  const slowPrompt = `SINGLE_COS_SLOW_STREAM_${stamp}`;
  const slowStart = Date.now();
  const eventStart = frames.length;
  await composer.fill(slowPrompt);
  await page.locator('mux-cos button[aria-label="Send"]').click();
  await page.locator('mux-cos button[aria-label="Stop generating"]').waitFor({ state: 'visible', timeout: 15_000 });
  const firstDelta = await eventually(() => frames.slice(eventStart).find((f) => f.type === 'cos-event' && f.event?.ev === 'delta'), 'slow_turn_first_delta');
  const endBeforeStop = postPaths.filter((x) => x === '/api/app/voice/end').length;
  await page.locator('mux-cos button[aria-label="Stop generating"]').click();
  const terminal = await eventually(() => frames.slice(eventStart).find((f) =>
    f.type === 'cos-event' && ['turn_cancelled', 'cancelled', 'turn_end'].includes(f.event?.ev)), 'slow_turn_terminal');
  await page.locator('mux-cos button[aria-label="Send"]').waitFor({ state: 'visible', timeout: 15_000 });
  gate('single_composer_stop_cancels_generation_without_ending_voice', Boolean(terminal) &&
    postPaths.filter((x) => x === '/api/app/voice/end').length === endBeforeStop &&
    await bubble.count() === 1, {
      submit_to_first_delta_ms: firstDelta._receivedAt - slowStart,
      submit_to_terminal_ms: terminal._receivedAt - slowStart,
    });

  stage = 'drag_exit'; const box = await bubbleControl.boundingBox(); if (!box) throw new Error('bubble_box_missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, { steps: 3 });
  const exitTarget = page.locator('mux-voice-mode-bubble [data-voice-mode-exit-target]:visible');
  await eventually(() => exitTarget.count().then(Boolean), 'exit_drop_target_visible');
  const exitBox = await exitTarget.boundingBox(); if (!exitBox) throw new Error('exit_drop_target_box_missing');
  await page.mouse.move(exitBox.x + exitBox.width / 2, exitBox.y + exitBox.height / 2, { steps: 10 });
  gate('drag_exit_target_highlighted', await exitTarget.evaluate((target) => target.getAttribute('data-active') === 'true' || target.classList.contains('active')));
  await page.screenshot({ path: path.join(output, 'drag-exit-highlight.png') }); await page.mouse.up();
  await eventually(() => bubble.count().then((n) => n === 0), 'bubble_hidden_after_exit');
  gate('drag_to_exit_closes_native_media_and_provider_session', await page.evaluate(() => window.__fixtureMedia.peers.every((item) => item.connectionState === 'closed')) && postPaths.filter((x) => x === '/api/app/voice/end').length === endCount + 1);
  gate('no_browser_runtime_errors', browserErrors.length === 0, { error_names: browserErrors });
  run.status = 'PASS';
} catch (error) {
  if (!firstFailure) firstFailure = `stage_${stage}`;
  run.errors.push(`stage:${stage}`, `error_type:${error?.name ?? 'Error'}`);
  const message = String(error?.message ?? ''); if (/^[a-zA-Z0-9_.: -]{1,160}$/.test(message)) run.errors.push(`detail:${message}`);
} finally {
  await page?.evaluate(() => window.__mcMutationObserver?.disconnect()).catch(() => {});
  for (const page of peerPages) { await page.evaluate(async () => { window.__fixturePeer?.oscillator?.stop(); await window.__fixturePeer?.audio?.close(); window.__fixturePeer?.peerConnection?.close(); }).catch(() => {}); await page.close().catch(() => {}); }
  await browser?.close(); if (firstFailure) run.first_failure = firstFailure; run.protocol_events = protocolEvents; writePrivate('results.json', run);
}
console.log(JSON.stringify({ status: run.status, source_reference: run.source_reference.type }));
process.exitCode = run.status === 'PASS' ? 0 : 1;
