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
async function commands(callId) { return (await fixtureOK('inspect', { call_id: callId })).commands ?? []; }
async function nextCommand(callId, after, type, predicate = () => true) {
  return eventually(async () => (await commands(callId)).slice(after).find((item) => item.type === type && predicate(item)), `command_${type}`);
}
function appMetadata(command) {
  const metadata = command?.metadata;
  if (!metadata || typeof metadata.app_voice_capture_id !== 'string' || !metadata.app_voice_capture_id ||
    typeof metadata.app_voice_response_nonce !== 'string' || !metadata.app_voice_response_nonce) throw new Error('missing_app_capture_metadata');
  return metadata;
}
function activeComposerTarget(active) {
  const composer = active?.composer;
  if (!composer || typeof composer.channel_id !== 'string' || typeof composer.thread_id !== 'string' ||
    !Number.isSafeInteger(composer.runtime_generation) || typeof composer.draft_ref !== 'string') throw new Error('missing_active_composer_target');
  return {
    kind: 'composer',
    channel_id: composer.channel_id,
    thread_id: composer.thread_id,
    runtime_session_id: composer.runtime_session_id,
    runtime_generation: composer.runtime_generation,
    runtime_incarnation: composer.runtime_incarnation,
    draft_ref: composer.draft_ref,
  };
}
function activeThreadTarget(active) {
  const composer = active?.composer;
  if (!composer) throw new Error('missing_active_thread_target');
  return {
    kind: 'thread_turn',
    channel_id: composer.channel_id,
    thread_id: composer.thread_id,
    runtime_session_id: composer.runtime_session_id,
    runtime_generation: composer.runtime_generation,
    runtime_incarnation: composer.runtime_incarnation,
    draft_ref: composer.draft_ref,
  };
}
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
let stage = 'setup'; let firstFailure = ''; let browser; let page; let peerPage; let frames = []; const peerPages = new Set();
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
  frames = []; const voiceResponses = []; const postPaths = []; const browserErrors = [];
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
  const composer = page.locator('[data-thread-composer]');
  await wait(500);
  const missionControlVisibleAtBoot = await page.locator('mux-cos:visible').count() === 1;
  const bootSubscribes = protocolEvents.filter((x) => x.direction === 'sent' && x.type === 'cos-subscribe').length;
  const bootMultichannel = protocolEvents.filter((x) => x.direction === 'sent' && x.type.startsWith('missioncontrol-')).length;
  gate(
    'startup_has_only_visible_single_conversation_subscription',
    bootMultichannel === 0 && (missionControlVisibleAtBoot ? bootSubscribes === 1 : bootSubscribes === 0),
    { mission_control_visible: missionControlVisibleAtBoot, cos_subscribe_count: bootSubscribes, multichannel_count: bootMultichannel },
  );
  if (!missionControlVisibleAtBoot) await page.getByRole('button', { name: /Mission Control/ }).first().click();
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
  const turnReceipt = await eventually(() => frames.find((f) => f.type === 'cos-turn-result' && f.ok === true && typeof f.turn_id === 'string' && f.turn_id), 'cos_turn_receipt');
  const terminalTurn = await eventually(() => frames.find((f) =>
    f.type === 'cos-event' && f.event?.turn_id === turnReceipt.turn_id && f.event?.ev === 'turn_end' &&
    f.event?.persisted === true), 'persisted_cos_turn_end');
  const providerText = providerRecords().slice(providerStart).map((record) => inputText(record.request?.input)).join('\n');
  gate('native_cos_turn_receipt_and_persisted_terminal_event', providerText.includes(canary) &&
    await page.locator('mux-cos').getByText(canary).count() > 0 && terminalTurn.event.persisted === true, {
    turn_id_sha256: sha(turnReceipt.turn_id), persisted: terminalTurn.event.persisted === true,
  });
  const beforeIdleFrames = frames.length; const beforeIdleMutations = await page.evaluate(() => window.__mcMutationCount ?? 0); await wait(2000);
  gate('idle_single_cos_has_no_periodic_traffic_or_rerender_loop', frames.length === beforeIdleFrames && (await page.evaluate(() => window.__mcMutationCount ?? 0)) === beforeIdleMutations, { observation_started_ms: Math.round(mutationStart) });
  gate('no_multichannel_frames_sent', !protocolEvents.some((x) => x.direction === 'sent' && x.type.startsWith('missioncontrol-')));

  stage = 'refresh_persistence';
  const beforeReload = frames.length;
  const sentBeforeReload = protocolEvents.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const label = document.createElement('div');
    label.textContent = 'REALRTC_SYNTHETIC_MEDIA_NO_PHYSICAL_MIC';
    Object.assign(label.style, { position: 'fixed', left: '4px', bottom: '4px', zIndex: '9999', padding: '4px', background: '#fff4cc', color: '#111', font: '11px system-ui', pointerEvents: 'none' });
    document.body.append(label);
  });
  if (await page.locator('mux-cos:visible').count() !== 1) {
    await page.getByRole('button', { name: /Mission Control/ }).first().click();
  }
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  const refreshed = await eventually(() => frames.slice(beforeReload).find((f) =>
    f.type === 'cos-subscribe-result' && f.ok === true && f.conversation?.id === identity.id &&
    f.conversation?.session_id === identity.session_id), 'refresh_same_cos_identity');
  const history = await eventually(() => frames.slice(beforeReload).find((f) =>
    f.type === 'cos-history' && JSON.stringify(f.turns ?? []).includes(canary)), 'refresh_cos_history_canary');
  const reloadSubscribes = protocolEvents.slice(sentBeforeReload).filter((frame) =>
    frame.direction === 'sent' && frame.type === 'cos-subscribe').length;
  gate('refresh_preserves_native_cos_identity_and_history', Boolean(refreshed && history) && reloadSubscribes === 1, {
    conversation_id_sha256: sha(identity.id), session_id_sha256: sha(identity.session_id),
    cos_subscribe_count: reloadSubscribes,
  });

  stage = 'responsive_and_workspace_navigation';
  await composer.fill('DRAFT_SURVIVES_NAVIGATION');
  stage = 'workspace_navigation_desktop_click';
  await page.locator(`mux-sidebar .ws-card[data-workspace-id="${workspaceB}"]`).click();
  await page.locator('mux-dock:not([aria-hidden])').waitFor({ state: 'visible', timeout: 30_000 });
  stage = 'workspace_navigation_portrait_drawer';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Open workspaces/ }).click();
  await page.locator('mux-sidebar:visible').waitFor({ state: 'visible', timeout: 10_000 });
  stage = 'workspace_navigation_portrait_mission_control';
  await page.locator('mux-sidebar mux-start-card button').click();
  await composer.waitFor({ state: 'visible' });
  // The popover's closing transition keeps it in the top layer briefly.
  // Inspect the settled product layout, not a frame mid-navigation.
  await page.locator('.drawer').waitFor({ state: 'hidden' });
  await eventually(() => page.locator('mux-cos').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.hasAttribute('narrow') && rect.left >= 0 &&
      rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1;
  }), 'portrait_conversation_layout_settled');
  gate('workspace_navigation_does_not_rebind_single_conversation_or_draft', await composer.inputValue() === 'DRAFT_SURVIVES_NAVIGATION' && frames.filter((f) => f.type === 'cos-subscribe-result').at(-1)?.conversation?.id === identity.id);
  await page.screenshot({ path: path.join(output, 'mission-control-portrait.png') });
  await page.setViewportSize({ width: 844, height: 390 });
  await eventually(() => page.locator('mux-cos').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1;
  }), 'landscape_conversation_layout_settled');
  await page.screenshot({ path: path.join(output, 'mission-control-landscape.png') });
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
  const callId = pending.call_id;
  await eventually(() => peerPage.evaluate(() => window.__fixturePeer.peerConnection.connectionState === 'connected'), 'real_rtc_connected');
  const bubble = page.locator('mux-voice-mode-bubble [data-voice-mode-bubble]:visible');
  await eventually(() => bubble.count().then((n) => n === 1), 'one_live_bubble');
  const bubbleControl = page.locator('mux-voice-mode-bubble [data-voice-mode-button]:visible');
  const circles = await bubbleControl.locator('mux-voice-mode-icon svg circle').count();
  gate('real_rtc_single_outline_live_bubble', await bubbleControl.count() === 1 && circles === 0 && await bubbleControl.evaluate((button) => getComputedStyle(button).borderTopWidth !== '0px'), { classification: 'REALRTC_SYNTHETIC_MEDIA_NO_PHYSICAL_MIC' });
  await page.screenshot({ path: path.join(output, 'REAL-RTC-SYNTHETIC-MEDIA-NO-PHYSICAL-MIC-active-bubble.png') });

  const mediaSnapshot = () => page.evaluate(() => {
    const media = window.__fixtureMedia;
    const stream = media.streams[0];
    const peer = media.peers[0];
    const inputTracks = stream?.getAudioTracks() ?? [];
    const senders = peer?.getSenders() ?? [];
    const audioSenders = senders.filter((sender) => sender.track?.kind === 'audio');
    const sinks = media.audioElements;
    return {
      peerCount: media.peers.length,
      connectionState: peer?.connectionState ?? '',
      inputTrackCount: inputTracks.length,
      enabledFlags: inputTracks.map((track) => track.enabled),
      senderTracksNull: audioSenders.length === 0,
      sinkCount: sinks.length,
      sinkPaused: sinks.map((audio) => audio.paused),
      sinkMuted: sinks.map((audio) => audio.muted),
      senderRestored: inputTracks.length > 0 && senders.some((sender) => sender.track === inputTracks[0]),
    };
  });

  stage = 'pause_resume'; const tokenCount = voiceResponses.filter((x) => x.path === '/api/app/voice/token').length; const endCount = postPaths.filter((x) => x === '/api/app/voice/end').length;
  await bubbleControl.click(); await eventually(() => bubble.getAttribute('data-paused').then((state) => state === 'true'), 'bubble_paused');
  const pauseStartedAt = Date.now();
  let pausedMedia;
  try {
    pausedMedia = await eventually(async () => {
      const state = await mediaSnapshot();
      return state.peerCount === 1 && state.connectionState === 'connected' &&
        state.inputTrackCount > 0 && state.enabledFlags.every((enabled) => !enabled) &&
        state.senderTracksNull && state.sinkCount > 0 &&
        state.sinkPaused.every(Boolean) && state.sinkMuted.every(Boolean) ? state : null;
    }, 'native_pause_media_settled', 5_000);
  } catch (error) {
    run.checks.native_pause_media_settled = { status: 'FAIL', snapshot: await mediaSnapshot() };
    throw error;
  }
  gate('bubble_pause_preserves_peer_and_detaches_sender_track', true, {
    ...pausedMedia,
    pause_settle_ms: Date.now() - pauseStartedAt,
    provider_end_requests: postPaths.filter((x) => x === '/api/app/voice/end').length - endCount,
  });
  await page.screenshot({ path: path.join(output, 'pause-bubble.png') });
  stage = 'resume_native_media';
  const resumeStartedAt = Date.now();
  await bubbleControl.press('Space');
  let resumedMedia;
  try {
    resumedMedia = await eventually(async () => {
      const state = await mediaSnapshot();
      return state.peerCount === 1 && state.connectionState === 'connected' &&
        state.inputTrackCount > 0 && state.enabledFlags.every(Boolean) &&
        state.senderRestored && state.sinkCount > 0 &&
        state.sinkPaused.every((paused) => !paused) && state.sinkMuted.every((muted) => !muted) ? state : null;
    }, 'native_resume_media_settled', 5_000);
  } catch (error) {
    run.checks.native_resume_media_settled = { status: 'FAIL', snapshot: await mediaSnapshot() };
    throw error;
  }
  gate('bubble_resume_preserves_provider_session',
    voiceResponses.filter((x) => x.path === '/api/app/voice/token').length === tokenCount &&
    postPaths.filter((x) => x === '/api/app/voice/end').length === endCount &&
    await peerPage.evaluate(() => window.__fixturePeer.peerConnection.connectionState === 'connected'), {
      ...resumedMedia, resume_settle_ms: Date.now() - resumeStartedAt,
    });

  stage = 'voice_workspace_round_trip';
  const navigationTokens = voiceResponses.filter((x) => x.path === '/api/app/voice/token').length;
  const navigationSDP = voiceResponses.filter((x) => x.path === '/api/app/voice/sdp').length;
  await page.locator(`mux-sidebar .ws-card[data-workspace-id="${workspaceB}"]`).click();
  await page.locator('mux-dock:not([aria-hidden])').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('mux-sidebar mux-start-card button').click();
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  gate('voice_workspace_round_trip_preserves_native_peer_and_provider_session',
    await peerPage.evaluate(() => window.__fixturePeer.peerConnection.connectionState === 'connected') &&
    voiceResponses.filter((x) => x.path === '/api/app/voice/token').length === navigationTokens &&
    voiceResponses.filter((x) => x.path === '/api/app/voice/sdp').length === navigationSDP, {
      token_requests: navigationTokens,
      sdp_requests: navigationSDP,
    });

  let appUtteranceNumber = 0;
  async function beginAppUtterance(name, args) {
    appUtteranceNumber += 1;
    const sequence = appUtteranceNumber;
    const before = (await commands(callId)).length;
    const responseId = `fixture_app_response_${sequence}`;
    const itemId = `fixture_app_item_${sequence}`;
    const functionCallId = `fixture_app_function_${sequence}`;
    await fixtureOK('inject', { call_id: callId, event: { type: 'input_audio_buffer.committed', item_id: `fixture_app_input_${sequence}` } });
    const initial = await nextCommand(callId, before, 'response.create', (row) =>
      typeof row.metadata?.app_voice_capture_id === 'string' && typeof row.metadata?.app_voice_response_nonce === 'string');
    const metadata = appMetadata(initial);
    gate(`app_voice_capture_binding_${sequence}`, Boolean(metadata.app_voice_capture_id && metadata.app_voice_response_nonce), { metadata_field_count: Object.keys(metadata).length });
    await fixtureOK('inject', { call_id: callId, event: { type: 'response.created', response: { id: responseId, metadata } } });
    await fixtureOK('inject', { call_id: callId, event: { type: 'response.output_item.added', response_id: responseId, item: { type: 'function_call', id: itemId, call_id: functionCallId } } });
    const outputStart = (await commands(callId)).length;
    const final = { type: 'response.function_call_arguments.done', response_id: responseId, item_id: itemId, name, arguments: JSON.stringify(args) };
    await fixtureOK('inject', { call_id: callId, event: final });
    return { sequence, responseId, functionCallId, metadata, outputStart, final };
  }
  async function finishAppUtterance(pending) {
    const output = await nextCommand(callId, pending.outputStart, 'conversation.item.create',
      (row) => row.function_call_id === pending.functionCallId && row.output);
    gate(`app_voice_function_output_binding_${pending.sequence}`, output.function_call_id === pending.functionCallId);
    await fixtureOK('inject', { call_id: callId, event: { type: 'response.done', response_id: pending.responseId } });
    const continuation = await nextCommand(callId, pending.outputStart, 'response.create', (row) =>
      row.metadata?.app_voice_capture_id === pending.metadata.app_voice_capture_id &&
      typeof row.metadata?.app_voice_response_nonce === 'string' &&
      row.metadata.app_voice_response_nonce !== pending.metadata.app_voice_response_nonce);
    const continuationId = `${pending.responseId}_continuation`;
    await fixtureOK('inject', { call_id: callId, event: { type: 'response.created', response: { id: continuationId, metadata: continuation.metadata } } });
    await fixtureOK('inject', { call_id: callId, event: { type: 'response.done', response_id: continuationId } });
    return { ...pending, output: output.output };
  }
  async function appUtterance(name, args) {
    return finishAppUtterance(await beginAppUtterance(name, args));
  }

  stage = 'app_observe_current_cos';
  const observed = await appUtterance('app_observe', {});
  const observation = observed.output;
  const activeComposer = observation?.active?.composer;
  gate('app_observe_returns_current_one_cos_root_and_native_workspace_inventory',
    observation?.threads_count === 1 &&
    observation?.workspaces_count >= 2 &&
    Array.isArray(observation?.ids) && observation.ids.includes(identity.id) &&
    observation.ids.includes(workspaceA) && observation.ids.includes(workspaceB) &&
    activeComposer?.thread_id === identity.id &&
    activeComposer?.runtime_session_id === identity.session_id &&
    activeComposer?.runtime_generation === identity.generation &&
    activeComposer?.runtime_incarnation === identity.incarnation, {
      cos_root_sha256: sha(identity.id),
      workspace_inventory_count: observation?.workspaces_count ?? -1,
      thread_inventory_count: observation?.threads_count ?? -1,
    });

  stage = 'app_voice_composer_draft';
  const draftText = `APP_VOICE_DRAFT_${stamp}`;
  const providerBeforeDraft = providerRecords().length;
  const drafted = await appUtterance('composer_draft', {
    expected_revision: observation.revision,
    mode: 'set',
    target: activeComposerTarget(observation.active),
    text: draftText,
  });
  await eventually(() => composer.inputValue().then((value) => value === draftText), 'app_voice_draft_set');
  gate('composer_draft_sets_authoritative_active_composer_without_cos_request',
    drafted.output?.channel_id === activeComposer.channel_id &&
    providerRecords().length === providerBeforeDraft, {
      provider_cos_requests: providerRecords().length - providerBeforeDraft,
    });

  stage = 'app_voice_submit_current_cos';
  const submitObserved = await appUtterance('app_observe', {});
  const submitObservation = submitObserved.output;
  const submitMissing = ['channel_id', 'thread_id', 'runtime_session_id', 'runtime_generation', 'runtime_incarnation', 'draft_ref']
    .filter((field) => submitObservation?.active?.composer?.[field] === undefined || submitObservation.active.composer[field] === '');
  gate('submit_thread_turn_canonical_active_target_fields_present', submitMissing.length === 0, {
    missing_field_count: submitMissing.length,
    missing_field_codes: submitMissing,
  });
  const submitCanary = `APP_VOICE_COS_CANARY_${stamp}`;
  const cosAdmissionsBeforeSubmit = frames.filter((frame) => frame.type === 'cos-turn-result').length;
  const providerBeforeSubmit = providerRecords().length;
  const pendingSubmit = await beginAppUtterance('submit_thread_turn', {
    expected_revision: submitObservation.revision,
    target: activeThreadTarget(submitObservation.active),
    text: submitCanary,
  });
  const confirmation = page.locator('mux-cos').getByTestId('app-voice-submit-confirm');
  await confirmation.waitFor({ state: 'visible', timeout: 10_000 });
  await confirmation.click();
  const submitted = await finishAppUtterance(pendingSubmit);
  const turn = await eventually(() => frames.slice().reverse().find((frame) =>
    frame.type === 'cos-turn-result' && frame.ok === true && frame.turn_id === submitted.output?.turn_id), 'app_voice_cos_turn_receipt');
  const persisted = await eventually(() => frames.slice().reverse().find((frame) =>
    frame.type === 'cos-event' && frame.event?.turn_id === turn.turn_id && frame.event?.ev === 'turn_end' && frame.event?.persisted === true), 'app_voice_cos_turn_persisted');
  await eventually(() => providerRecords().slice(providerBeforeSubmit).some((record) => inputText(record.request?.input).includes(submitCanary)), 'app_voice_cos_provider_canary');
  gate('submit_thread_turn_confirms_and_persists_exact_current_cos_turn',
    submitted.output?.thread_id === identity.id &&
    persisted.event.persisted === true &&
    providerRecords().slice(providerBeforeSubmit).some((record) => inputText(record.request?.input).includes(submitCanary)), {
      turn_id_sha256: sha(turn.turn_id),
      provider_cos_requests: providerRecords().length - providerBeforeSubmit,
      cos_admissions: frames.filter((frame) => frame.type === 'cos-turn-result').length - cosAdmissionsBeforeSubmit,
    });

  stage = 'app_voice_duplicate_bound_call';
  const duplicateCommandsBefore = (await commands(callId)).length;
  const duplicateAdmissionsBefore = frames.filter((frame) => frame.type === 'cos-turn-result').length;
  const duplicateProviderBefore = providerRecords().length;
  await fixtureOK('inject', { call_id: callId, event: pendingSubmit.final });
  await wait(500);
  gate('exact_duplicate_bound_call_has_no_extra_cos_admission',
    (await commands(callId)).slice(duplicateCommandsBefore).length === 0 &&
    frames.filter((frame) => frame.type === 'cos-turn-result').length === duplicateAdmissionsBefore &&
    providerRecords().length === duplicateProviderBefore, {
      extra_cos_admissions: frames.filter((frame) => frame.type === 'cos-turn-result').length - duplicateAdmissionsBefore,
      extra_provider_cos_requests: providerRecords().length - duplicateProviderBefore,
    });

  stage = 'app_voice_unknown_transcript_refusal';
  const providerBeforeUnknownTranscript = providerRecords().length;
  const unknownTranscript = await appUtterance('read_lane_transcript', {
    machine: 'unknown-fixture-machine',
    session_id: 'unknown-fixture-session',
    last_n: 1,
  });
  gate('unknown_remote_session_transcript_refuses_without_fallback',
    unknownTranscript.output?.status === 'refused' &&
    providerRecords().length === providerBeforeUnknownTranscript, {
      refusal_code: unknownTranscript.output?.refusal_code ?? 'unclassified',
      provider_cos_requests: providerRecords().length - providerBeforeUnknownTranscript,
    });

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
  gate('drag_exit_target_highlighted', await exitTarget.getAttribute('data-highlighted') === 'true');
  await page.screenshot({ path: path.join(output, 'drag-exit-highlight.png') }); await page.mouse.up();
  await eventually(() => bubble.count().then((n) => n === 0), 'bubble_hidden_after_exit');
  gate('drag_to_exit_closes_native_media_and_provider_session', await page.evaluate(() => window.__fixtureMedia.peers.every((item) => item.connectionState === 'closed')) && postPaths.filter((x) => x === '/api/app/voice/end').length === endCount + 1);
  gate('no_browser_runtime_errors', browserErrors.length === 0, { error_names: browserErrors });
  run.status = 'PASS';
} catch (error) {
  if (!firstFailure) firstFailure = `stage_${stage}`;
  run.errors.push(`stage:${stage}`, `error_type:${error?.name ?? 'Error'}`);
  const message = String(error?.message ?? ''); if (/^[a-zA-Z0-9_.: -]{1,160}$/.test(message)) run.errors.push(`detail:${message}`);
  const subscribeFailure = frames?.slice().reverse().find((frame) => frame.type === 'cos-subscribe-result' && frame.ok !== true);
  const safeCode = typeof subscribeFailure?.code === 'string' && /^[a-z0-9_-]{1,96}$/i.test(subscribeFailure.code)
    ? subscribeFailure.code
    : '';
  if (safeCode) run.errors.push(`cos_subscribe_code:${safeCode}`);
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  await page?.evaluate(() => window.__mcMutationObserver?.disconnect()).catch(() => {});
  for (const page of peerPages) { await page.evaluate(async () => { window.__fixturePeer?.oscillator?.stop(); await window.__fixturePeer?.audio?.close(); window.__fixturePeer?.peerConnection?.close(); }).catch(() => {}); await page.close().catch(() => {}); }
  await browser?.close(); if (firstFailure) run.first_failure = firstFailure; run.protocol_events = protocolEvents; writePrivate('results.json', run);
}
console.log(JSON.stringify({ status: run.status, source_reference: run.source_reference.type }));
process.exitCode = run.status === 'PASS' ? 0 : 1;
