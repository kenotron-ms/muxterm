#!/usr/bin/env node
/*
 * Prepared-environment regression gate for App Voice endpointing and the
 * always-available text composer. The product browser, WebSocket, WebRTC, and
 * server sideband are real. The provider edge and microphone are deliberately
 * synthetic; this proves protocol and interaction ordering, not physical audio
 * quality or a cloud provider.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { createRequire } from 'node:module';

const usage = `Usage:
  node test/missioncontrol-e2e/app-voice-regression.mjs \\
    --base-url <URL> --fixture-url <https://loopback> --fixture-ca <PEM> \\
    --output <private directory> --barrier-dir <private directory> \\
    --source-sha <40-git-sha|64-source-archive-sha256> \\
    --accept-disposable-fixtures [--playwright-module <module-or-absolute-path>]`;

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return { help: true };
    if (!key.startsWith('--')) throw new Error('invalid_argument');
    const name = key.slice(2);
    if (name === 'accept-disposable-fixtures' || name === 'headed') {
      out[name] = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('missing_argument_value');
    out[name] = value;
  }
  return out;
}

const opt = parseArgs(process.argv.slice(2));
if (opt.help) {
  console.log(usage);
  process.exit(0);
}
for (const key of ['base-url', 'fixture-url', 'fixture-ca', 'output', 'barrier-dir', 'source-sha']) {
  if (!opt[key]) throw new Error(`required_${key}`);
}
if (!opt['accept-disposable-fixtures']) throw new Error('disposable_fixture_consent_required');
if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(opt['source-sha'])) throw new Error('invalid_source_reference');
if (!fs.existsSync(opt['fixture-ca'])) throw new Error('fixture_ca_missing');
if (typeof tls.setDefaultCACertificates !== 'function' || typeof tls.getCACertificates !== 'function') {
  throw new Error('node_22_19_tls_required');
}
tls.setDefaultCACertificates([...tls.getCACertificates('default'), fs.readFileSync(opt['fixture-ca'], 'utf8')]);

const base = new URL(opt['base-url']);
const fixture = new URL(opt['fixture-url']);
if (fixture.protocol !== 'https:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(fixture.hostname)) {
  throw new Error('fixture_must_be_loopback_https');
}
const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const output = path.resolve(opt.output);
if (!path.relative(repository, output).startsWith('..')) throw new Error('output_must_be_private_and_outside_repository');
if (!path.isAbsolute(opt['barrier-dir'])) throw new Error('barrier_dir_must_be_absolute');
const barrierDir = path.resolve(opt['barrier-dir']);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // A short fixture ordering race is not a pass.
    }
    await wait(50);
  }
  throw new Error(`timeout_${label}`);
}
function writePrivate(name, value) {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function safeHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
async function fixtureControl(operation, extra = {}) {
  const response = await fetch(new URL('/__fixture/control', fixture), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, ...extra }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`fixture_${operation}_${response.status}`);
  return body;
}

const report = {
  format: 'app-voice-endpoint-and-composer-regression-v1',
  mode: ['REAL_BROWSER', 'REAL_WEBRTC_SYNTHETIC_MEDIA', 'SCRIPTED_REALTIME_EVENTS'],
  status: 'FAIL',
  source_reference: /^[0-9a-f]{40}$/i.test(opt['source-sha'])
    ? { type: 'git_sha', value: opt['source-sha'].toLowerCase() }
    : { type: 'source_archive_sha256', value: opt['source-sha'].toLowerCase() },
  limitations: [
    'Synthetic browser media and provider events only; no physical microphone proof.',
    'No live Azure/OpenAI credential or provider proof.',
  ],
  checks: {},
  errors: [],
};
const pass = (name, evidence = {}) => { report.checks[name] = { status: 'PASS', ...evidence }; };
function gate(name, condition, evidence = {}) {
  if (!condition) throw new Error(`assertion_${name}`);
  pass(name, evidence);
}

let browser;
let firstFailure = '';
let stage = 'setup';
try {
  const require = createRequire(import.meta.url);
  const playwrightModule = opt['playwright-module'] ?? 'playwright';
  const { chromium } = require(playwrightModule);
  browser = await chromium.launch({
    channel: 'chrome',
    headless: !opt.headed,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const frames = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (frame.type === 'cos-turn') frames.push({ direction: 'sent', type: frame.type, at: Date.now() });
      } catch {
        // Terminal output is unrelated.
      }
    });
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (
          frame.type === 'cos-subscribe-result' ||
          frame.type === 'cos-turn-result' ||
          frame.type === 'cos-queue' ||
          frame.type === 'cos-event'
        ) {
          // Preserve only response identity/status in private test memory; no
          // prompt or transcript is ever written to test evidence.
          frames.push({
            direction: 'received',
            type: frame.type,
            turn_id: typeof frame.turn_id === 'string' ? frame.turn_id : '',
            items: Array.isArray(frame.items)
              ? frame.items.map((item) => ({ turn_id: item?.turn_id, status: item?.status }))
              : [],
            ok: frame.ok === true,
            event: frame.event && typeof frame.event === 'object'
              ? {
                  ev: frame.event.ev,
                  turn_id: frame.event.turn_id,
                  persisted: frame.event.persisted,
                }
              : null,
            at: Date.now(),
          });
        }
      } catch {
        // Terminal output is unrelated.
      }
    });
  });
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error?.name ?? 'BrowserError'));

  // Holding the status endpoint makes the first view a realistic slow voice
  // availability bootstrap. The page must still expose a normal text editor.
  let releaseStatus;
  const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
  let statusObserved;
  const statusObservedGate = new Promise((resolve) => { statusObserved = resolve; });
  await page.route('**/api/voice/settings', async (route) => {
    statusObserved();
    await statusGate;
    await route.continue();
  });
  stage = 'fresh_boot';
  await page.goto(base.href, { waitUntil: 'domcontentloaded' });
  if (await page.locator('mux-cos:visible').count() !== 1) {
    await page.getByRole('button', { name: /Mission Control/ }).first().click();
  }
  const composer = page.locator('[data-thread-composer]');
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  await composer.focus();
  const activeBarrierToken = `appvoice-${randomUUID().replaceAll('-', '')}`;
  await composer.fill(`VOICE_BOOTSTRAP_TEXT_CANARY FIXTURE_LATE_TURN=${activeBarrierToken}`);
  gate(
    'text_composer_is_editable_while_voice_availability_is_pending',
    await composer.isEnabled() && await composer.inputValue() === `VOICE_BOOTSTRAP_TEXT_CANARY FIXTURE_LATE_TURN=${activeBarrierToken}`,
    { voice_status: 'pending', physical_microphone: false },
  );
  // The WebSocket is independent of the held voice HTTP request. Wait only for
  // its real subscription handshake, then prove that Send is not held behind
  // the microphone/provider bootstrap.
  await eventually(
    () => frames.find((frame) => frame.direction === 'received' && frame.type === 'cos-subscribe-result'),
    'cos_subscription_while_voice_pending',
  );
  const initialAdmissionFrames = frames.length;
  await composer.press('Enter');
  await composer.press('Enter');
  const turnSent = await eventually(
    () => frames.slice(initialAdmissionFrames).find((frame) => frame.direction === 'sent' && frame.type === 'cos-turn'),
    'text_turn_sent_while_voice_pending',
  );
  const turnReceipt = await eventually(
    () => frames.find((frame) => frame.direction === 'received' && frame.type === 'cos-turn-result' && frame.ok && frame.turn_id),
    'text_turn_admitted_while_voice_pending',
  );
  const queuedOrActive = await eventually(
    () => frames.find((frame) => frame.direction === 'received' && frame.type === 'cos-queue' &&
      frame.items.some((item) => item.turn_id === turnReceipt.turn_id && ['queued', 'active'].includes(item.status))),
    'text_turn_visible_in_server_queue',
  );
  gate(
    'text_submits_into_operator_fifo_while_voice_is_pending',
    Boolean(turnSent && turnReceipt && queuedOrActive),
    { admission: 'server_receipt_and_queue_projection' },
  );
  gate(
    'unchanged_draft_is_not_admitted_twice_before_its_receipt',
    frames.slice(initialAdmissionFrames).filter((frame) => frame.direction === 'sent' && frame.type === 'cos-turn').length === 1,
  );
  const voiceControlAvailable = await eventually(
    async () => await page.locator('mux-cos button[aria-label="Start voice mode"]:visible').count() === 1,
    'voice_control_while_operator_work_exists',
  );
  gate(
    'voice_control_remains_available_while_operator_work_exists',
    Boolean(voiceControlAvailable),
    { operator_state: 'queued_or_active' },
  );
  await eventually(
    () => frames.find((frame) =>
      frame.type === 'cos-event' && frame.event?.turn_id === turnReceipt.turn_id && frame.event.ev === 'turn_start',
    ),
    'held_operator_turn_started',
  );
  await eventually(
    () => fs.existsSync(path.join(barrierDir, `${activeBarrierToken}.ready`)),
    'held_operator_turn_fixture_ready',
  );
  const primaryControl = page.locator('mux-cos button.primary-control:visible');
  gate(
    'active_turn_empty_draft_uses_the_single_primary_stop_control',
    await page.locator('mux-cos button[aria-label="Stop active turn"]:visible').count() === 1 &&
      await primaryControl.getAttribute('aria-label') === 'Stop active turn',
  );
  await composer.fill('VOICE_QUEUE_ONE');
  await primaryControl.waitFor({ state: 'visible' });
  gate(
    'active_turn_draft_prioritizes_queue_not_stop',
    await primaryControl.getAttribute('aria-label') === 'Queue message after active turn',
  );
  await primaryControl.press('ArrowDown');
  const stopMenuItem = page.locator('mux-cos [role="menuitem"]:visible');
  await stopMenuItem.waitFor({ state: 'visible' });
  gate(
    'draft_queue_state_has_one_keyboard_reachable_stop_action',
    await stopMenuItem.count() === 1 && await stopMenuItem.innerText() === 'Stop active turn',
  );
  await stopMenuItem.press('Escape');
  await stopMenuItem.waitFor({ state: 'hidden' });
  // A cancelled long-press has no trailing click to suppress. The next
  // deliberate primary activation must still submit the current draft.
  await primaryControl.dispatchEvent('pointerdown');
  await wait(600);
  await primaryControl.dispatchEvent('pointercancel');
  await stopMenuItem.waitFor({ state: 'visible' });
  await stopMenuItem.press('Escape');
  await stopMenuItem.waitFor({ state: 'hidden' });
  const queueOneFrames = frames.length;
  await primaryControl.click();
  const queueOneReceipt = await eventually(
    () => frames.slice(queueOneFrames).find((frame) =>
      frame.type === 'cos-turn-result' && frame.ok && frame.turn_id,
    ),
    'first_queued_turn_admitted',
  );
  gate('cancelled_long_press_does_not_swallow_next_primary_submission', Boolean(queueOneReceipt));
  await composer.fill('VOICE_QUEUE_TWO');
  const queueTwoFrames = frames.length;
  await composer.press('Enter');
  const queueTwoReceipt = await eventually(
    () => frames.slice(queueTwoFrames).find((frame) =>
      frame.type === 'cos-turn-result' && frame.ok && frame.turn_id,
    ),
    'second_queued_turn_admitted',
  );
  const orderedQueue = await eventually(
    () => frames.find((frame) =>
      frame.type === 'cos-queue' &&
      frame.items.map((item) => item.turn_id).join(',') ===
        [turnReceipt.turn_id, queueOneReceipt.turn_id, queueTwoReceipt.turn_id].join(',') &&
      frame.items.map((item) => item.status).join(',') === 'active,queued,queued',
    ),
    'ordered_server_queue_projection',
  );
  gate('multiple_text_submissions_are_durable_and_ordered_behind_active_work', Boolean(orderedQueue));

  // The queue is server-owned. A reconnecting browser rebuilds the same active
  // and pending order from its compact server projection before it sees a new
  // turn event.
  await statusObservedGate;
  const statusResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/voice/settings');
  releaseStatus();
  await statusResponse;
  await page.unroute('**/api/voice/settings');
  stage = 'queue_refresh';
  const refreshFrames = frames.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (await page.locator('mux-cos:visible').count() !== 1) {
    await page.getByRole('button', { name: /Mission Control/ }).first().click();
  }
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  const recoveredQueue = await eventually(
    () => frames.slice(refreshFrames).find((frame) =>
      frame.type === 'cos-queue' &&
      frame.items.map((item) => item.turn_id).join(',') ===
        [turnReceipt.turn_id, queueOneReceipt.turn_id, queueTwoReceipt.turn_id].join(',') &&
      frame.items.map((item) => item.status).join(',') === 'active,queued,queued',
    ),
    'ordered_queue_recovered_after_refresh',
  );
  gate('accepted_queue_order_survives_browser_refresh', Boolean(recoveredQueue));
  await primaryControl.waitFor({ state: 'visible' });
  gate(
    'refreshed_active_turn_keeps_one_primary_stop_control',
    await primaryControl.getAttribute('aria-label') === 'Stop active turn' &&
      await page.locator('mux-cos button[aria-label="Stop active turn"]:visible').count() === 1,
  );
  const stopFrames = frames.length;
  await primaryControl.click();
  const cancelledActive = await eventually(
    () => frames.slice(stopFrames).find((frame) =>
      frame.type === 'cos-event' &&
      frame.event?.turn_id === turnReceipt.turn_id &&
      (frame.event.ev === 'turn_cancelled' || frame.event.ev === 'cancelled'),
    ),
    'active_turn_cancelled',
  );
  const queueOneStarted = await eventually(
    () => frames.slice(stopFrames).find((frame) =>
      frame.type === 'cos-event' && frame.event?.turn_id === queueOneReceipt.turn_id && frame.event.ev === 'turn_start',
    ),
    'first_queued_turn_started_after_active_stop',
  );
  const queueTwoStarted = await eventually(
    () => frames.slice(stopFrames).find((frame) =>
      frame.type === 'cos-event' && frame.event?.turn_id === queueTwoReceipt.turn_id && frame.event.ev === 'turn_start',
    ),
    'second_queued_turn_started_after_first',
  );
  await eventually(
    () => frames.slice(stopFrames).find((frame) =>
      frame.type === 'cos-event' && frame.event?.turn_id === queueTwoReceipt.turn_id && frame.event.ev === 'turn_end',
    ),
    'second_queued_turn_completed',
  );
  gate(
    'stop_controls_only_active_turn_and_preserves_ordered_queue',
    frames.indexOf(cancelledActive) < frames.indexOf(queueOneStarted) &&
      frames.indexOf(queueOneStarted) < frames.indexOf(queueTwoStarted),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  gate('portrait_composer_remains_in_view', await composer.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.bottom <= window.innerHeight + 1;
  }));
  await page.setViewportSize({ width: 844, height: 390 });
  gate('landscape_composer_remains_in_view', await composer.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.bottom <= window.innerHeight + 1;
  }));
  await page.setViewportSize({ width: 1280, height: 900 });

  // Voice borrows only an empty primary-send slot. The actual server receipt
  // already cleared this accepted draft; the explicit fill is a no-op safeguard.
  await composer.fill('');
  const start = page.locator('mux-cos button[aria-label="Start voice mode"]:visible');
  await start.waitFor({ state: 'visible', timeout: 30_000 });

  // A provider mint failure is a Voice Mode failure only. The ordinary composer
  // remains usable and its next submission still reaches the real COS queue.
  stage = 'mint_failure';
  await page.route('**/api/app/voice/token', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: '{"error":"fixture_unavailable"}',
  }));
  await start.click();
  const retry = page.locator('mux-cos button[aria-label="Retry voice mode"]:visible');
  await retry.waitFor({ state: 'visible', timeout: 10_000 });
  const mintFailureText = 'Voice session could not start. Try again.';
  gate(
    'provider_mint_failure_has_one_safe_retry_message',
    await page.locator('mux-cos').getByText(mintFailureText, { exact: true }).count() === 1 &&
      !/fixture_unavailable|provider.*error/i.test(await page.locator('mux-cos').innerText()),
  );
  const mintFailureFrameStart = frames.length;
  await composer.fill('VOICE_MINT_FAILURE_TEXT_CANARY');
  gate('text_composer_remains_editable_after_provider_mint_failure', await composer.isEnabled());
  await composer.press('Enter');
  await eventually(
    () => frames.slice(mintFailureFrameStart).find((frame) =>
      frame.direction === 'received' && frame.type === 'cos-turn-result' && frame.ok,
    ),
    'text_turn_admitted_after_mint_failure',
  );
  gate('text_submission_survives_provider_mint_failure', true);
  await page.unroute('**/api/app/voice/token');
  await wait(150);

  // Do not use a physical device for this branch. A native-shaped denied media
  // promise proves the browser controller's error normalization and leaves the
  // real synthetic-media run below untouched.
  stage = 'microphone_denied';
  await page.evaluate(() => {
    const devices = navigator.mediaDevices;
    const original = devices.getUserMedia.bind(devices);
    Object.defineProperty(window, '__restoreAppVoiceMedia', {
      configurable: true,
      value: () => Object.defineProperty(devices, 'getUserMedia', {
        configurable: true,
        value: original,
      }),
    });
    Object.defineProperty(devices, 'getUserMedia', {
      configurable: true,
      value: async () => { throw new DOMException('denied by fixture', 'NotAllowedError'); },
    });
  });
  await retry.click();
  await retry.waitFor({ state: 'visible', timeout: 10_000 });
  const microphoneDeniedText = 'Microphone permission was denied. Allow it, then try again.';
  gate(
    'microphone_denial_has_one_safe_retry_message',
    await page.locator('mux-cos').getByText(microphoneDeniedText, { exact: true }).count() === 1 &&
      !/denied by fixture|NotAllowedError/i.test(await page.locator('mux-cos').innerText()),
  );
  const microphoneFailureFrameStart = frames.length;
  await composer.fill('VOICE_MIC_DENIED_TEXT_CANARY');
  gate('text_composer_remains_editable_after_microphone_denial', await composer.isEnabled());
  await composer.press('Enter');
  await eventually(
    () => frames.slice(microphoneFailureFrameStart).find((frame) =>
      frame.direction === 'received' && frame.type === 'cos-turn-result' && frame.ok,
    ),
    'text_turn_admitted_after_microphone_denial',
  );
  gate('text_submission_survives_microphone_denial', true);
  await page.evaluate(() => window.__restoreAppVoiceMedia?.());
  await wait(150);

  let releaseMint;
  const mintGate = new Promise((resolve) => { releaseMint = resolve; });
  let mintObserved;
  const mintObservedGate = new Promise((resolve) => { mintObserved = resolve; });
  await page.route('**/api/app/voice/token', async (route) => {
    mintObserved();
    await mintGate;
    await route.continue();
  });
  stage = 'mint_pending';
  await retry.click();
  await composer.waitFor({ state: 'visible' });
  await composer.fill('VOICE_MINT_PENDING_TEXT_CANARY');
  gate(
    'text_composer_stays_editable_while_provider_mint_is_pending',
    await composer.isEnabled() && await composer.inputValue() === 'VOICE_MINT_PENDING_TEXT_CANARY',
    { mint: 'held_at_browser_route' },
  );
  await mintObservedGate;
  const mintResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/app/voice/token');
  releaseMint();
  await mintResponse;
  await page.unroute('**/api/app/voice/token');

  stage = 'realtime_connection';
  const pending = await eventually(async () => {
    const reply = await fixtureControl('pending_offer');
    return typeof reply.offer_sdp === 'string' ? reply : null;
  }, 'pending_offer');
  const peer = await context.newPage();
  await peer.goto('about:blank');
  const answer = await peer.evaluate(async (offer) => {
    const connection = new RTCPeerConnection();
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    for (const track of destination.stream.getTracks()) connection.addTrack(track, destination.stream);
    connection.ondatachannel = ({ channel }) => {
      channel.onopen = () => channel.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture-peer' } }));
    };
    await connection.setRemoteDescription({ type: 'offer', sdp: offer });
    await connection.setLocalDescription(await connection.createAnswer());
    await new Promise((resolve) => {
      if (connection.iceGatheringState === 'complete') return resolve();
      connection.addEventListener('icegatheringstatechange', () => {
        if (connection.iceGatheringState === 'complete') resolve();
      });
      setTimeout(resolve, 10_000);
    });
    window.__appVoiceRegressionPeer = { connection, audio, oscillator };
    return connection.localDescription.sdp;
  }, pending.offer_sdp);
  await fixtureControl('answer_sdp', { call_id: pending.call_id, answer_sdp: answer });
  const callID = pending.call_id;
  await eventually(async () => (await fixtureControl('inspect', { call_id: callID })).connected === true, 'sideband_connected');
  // Live Voice Mode intentionally takes over the empty composer, but the
  // existing "type instead" bridge must restore a real editable composer
  // without ending the provider session.
  const typeInstead = page.locator('mux-cos button[aria-label="Type instead, without ending the spoken conversation"]:visible');
  await typeInstead.waitFor({ state: 'visible', timeout: 10_000 });
  await typeInstead.click();
  await composer.waitFor({ state: 'visible', timeout: 10_000 });
  gate(
    'voice_takeover_retains_explicit_editable_text_bridge',
    await composer.isEnabled() &&
      await page.locator('mux-cos button[aria-label="Back to the orb, without ending the spoken conversation"]:visible').count() === 1,
  );
  await page.locator('mux-cos button[aria-label="Back to the orb, without ending the spoken conversation"]:visible').click();
  await typeInstead.waitFor({ state: 'visible', timeout: 10_000 });
  gate('voice_takeover_returns_to_same_live_conversation', await (async () => (await fixtureControl('inspect', { call_id: callID })).connected)());
  const inspect = () => fixtureControl('inspect', { call_id: callID });
  const responseCreates = async () => {
    const commands = (await inspect()).commands;
    return (Array.isArray(commands) ? commands : []).filter((entry) => entry?.type === 'response.create');
  };
  const inject = (event) => fixtureControl('inject', { call_id: callID, event });
  const assertNoResponse = async (label, baseline, duration) => {
    await wait(duration);
    gate(label, (await responseCreates()).length === baseline, { response_create_count: baseline, waited_ms: duration });
  };

  const configuration = (await inspect()).turn_detection ?? {};
  gate(
    'v032_server_vad_compatibility_configuration_is_explicit',
    configuration.type === 'server_vad' &&
      configuration.threshold === 0.5 &&
      configuration.prefix_padding_ms === 300 &&
      configuration.silence_duration_ms === 500 &&
      configuration.interrupt_response === true &&
      configuration.create_response === false,
    { profile: 'server_vad', silence_duration_ms: configuration.silence_duration_ms ?? null },
  );

  stage = 'endpoint_hysteresis';
  const beforeGrace = (await responseCreates()).length;
  await inject({ type: 'input_audio_buffer.speech_started', item_id: 'utterance-a' });
  // The configured provider owns the 500ms endpoint grace. A normal 200ms
  // pause and a partial transcript do not produce its stop/commit pair, so
  // neither can create a correlated response.
  await wait(200);
  await inject({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'utterance-a', delta: 'partial' });
  await assertNoResponse('no_response_at_current_short_pause_threshold', beforeGrace, 100);
  await inject({ type: 'input_audio_buffer.speech_started', item_id: 'utterance-b' });
  await assertNoResponse('resumed_speech_cancels_provider_endpoint_grace', beforeGrace, 300);
  // At the documented 500ms threshold, the provider emits the endpoint.
  // The local gate still needs both terminal VAD events: a partial after
  // speech_stopped cannot bypass the server-owned boundary.
  await wait(500);
  await inject({ type: 'input_audio_buffer.speech_stopped', item_id: 'utterance-b' });
  await inject({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'utterance-b', delta: 'partial-final' });
  await assertNoResponse('partial_transcript_after_vad_stop_does_not_bypass_commit', beforeGrace, 100);
  await inject({ type: 'input_audio_buffer.committed', item_id: 'utterance-b' });
  const finalRequest = await eventually(async () => {
    const entries = await responseCreates();
    return entries.length === beforeGrace + 1 ? entries.at(-1) : null;
  }, 'one_final_response_after_provider_endpoint');
  gate('one_final_response_after_deliberate_endpoint', (await responseCreates()).length === beforeGrace + 1, {
    response_metadata_keys: Object.keys(finalRequest.metadata ?? []).sort(),
  });
  await inject({ type: 'response.created', response: { id: 'response-final', metadata: finalRequest.metadata } });
  // A direct status question must reach the real Operator bridge and produce
  // exactly one correlated conversational reply—not worker narration.
  const statusItem = 'operator-status-item';
  const statusCall = 'operator-status-call';
  const beforeStatusReply = (await responseCreates()).length;
  await inject({
    type: 'response.output_item.added',
    response_id: 'response-final',
    item: { type: 'function_call', id: statusItem, call_id: statusCall },
  });
  const statusArguments = {
    type: 'response.function_call_arguments.done',
    response_id: 'response-final',
    item_id: statusItem,
    name: 'ask_chief_of_staff',
    arguments: JSON.stringify({ request: 'What is Operator status? FIXTURE_CANARY_B' }),
  };
  await inject(statusArguments);
  await eventually(async () => {
    const commands = (await inspect()).commands;
    return (Array.isArray(commands) ? commands : []).find((entry) =>
      entry?.type === 'conversation.item.create' && entry?.function_call_id === statusCall,
    );
  }, 'direct_voice_status_function_output');
  await inject({ type: 'response.done', response: { id: 'response-final' } });
  const statusReply = await eventually(async () => {
    const entries = await responseCreates();
    return entries.length === beforeStatusReply + 1 ? entries.at(-1) : null;
  }, 'one_direct_status_reply');
  gate(
    'direct_voice_status_question_gets_exactly_one_conversational_reply',
    Boolean(statusReply),
  );
  await inject({ type: 'response.created', response: { id: 'response-status', metadata: statusReply.metadata } });
  await inject({ type: 'response.done', response: { id: 'response-status' } });

  // A dropped observer connection must reconnect the same provider call while
  // no playback is unresolved, so subsequent direct handoff remains available.
  stage = 'sideband_reattach';
  const connectionEpoch = Number((await inspect()).connection_epoch ?? 0);
  await fixtureControl('close', { call_id: callID });
  const reattached = await eventually(async () => {
    const snapshot = await inspect();
    return snapshot.connected === true && Number(snapshot.connection_epoch ?? 0) > connectionEpoch;
  }, 'sideband_reattached_without_unresolved_playback');
  gate('sideband_reconnect_preserves_voice_turns_when_playback_is_settled', Boolean(reattached));

  // A separate request uses the direct long-work handoff. Its function output
  // is delivered, but its routine acceptance is never turned into speech.
  const beforeDispatchReply = (await responseCreates()).length;
  await inject({ type: 'input_audio_buffer.speech_started', item_id: 'dispatch-utterance' });
  await inject({ type: 'input_audio_buffer.speech_stopped', item_id: 'dispatch-utterance' });
  await inject({ type: 'input_audio_buffer.committed', item_id: 'dispatch-utterance' });
  const dispatchRequest = await eventually(async () => {
    const entries = await responseCreates();
    return entries.length === beforeDispatchReply + 1 ? entries.at(-1) : null;
  }, 'direct_voice_dispatch_input');
  await inject({ type: 'response.created', response: { id: 'response-dispatch', metadata: dispatchRequest.metadata } });
  const dispatchItem = 'operator-dispatch-item';
  const dispatchCall = 'operator-dispatch-call';
  const afterDispatchInput = (await responseCreates()).length;
  await inject({
    type: 'response.output_item.added',
    response_id: 'response-dispatch',
    item: { type: 'function_call', id: dispatchItem, call_id: dispatchCall },
  });
  const dispatchArguments = {
    type: 'response.function_call_arguments.done',
    response_id: 'response-dispatch',
    item_id: dispatchItem,
    name: 'dispatch_chief_of_staff',
    arguments: JSON.stringify({ request: `VOICE_OPERATOR_HANDOFF_${randomUUID().slice(0, 8)}` }),
  };
  await inject(dispatchArguments);
  await eventually(async () => {
    const commands = (await inspect()).commands;
    return (Array.isArray(commands) ? commands : []).find((entry) =>
      entry?.type === 'conversation.item.create' && entry?.function_call_id === dispatchCall,
    );
  }, 'direct_voice_to_operator_function_output');
  await assertNoResponse('routine_operator_dispatch_does_not_speak_acknowledgement', afterDispatchInput, 250);
  await inject(dispatchArguments);
  await assertNoResponse('duplicate_direct_voice_handoff_does_not_repeat_output_or_speech', afterDispatchInput, 250);
  pass('direct_voice_to_operator_handoff_executes_quietly', { acknowledgement: 'function_output_only' });
  await inject({ type: 'response.done', response: { id: 'response-dispatch' } });

  stage = 'noise_and_echo';
  const beforeNoise = (await responseCreates()).length;
  await inject({ type: 'input_audio_buffer.speech_started', item_id: 'noise-only' });
  await inject({ type: 'input_audio_buffer.speech_stopped', item_id: 'noise-only' });
  await assertNoResponse('low_level_noise_without_provider_commit_does_not_respond', beforeNoise, 650);
  await inject({ type: 'output_audio_buffer.started', response_id: 'assistant-playback' });
  // response.done ends generation, not WebRTC delivery. Audio can still
  // drain, so the echo guard remains armed until output-buffer stop.
  await inject({ type: 'response.done', response: { id: 'assistant-playback' } });
  await inject({ type: 'input_audio_buffer.speech_started', item_id: 'echo-only' });
  await inject({ type: 'input_audio_buffer.speech_stopped', item_id: 'echo-only' });
  await inject({ type: 'input_audio_buffer.committed', item_id: 'echo-only' });
  await assertNoResponse('response_done_drain_echo_never_becomes_a_user_turn', beforeNoise, 650);
  await inject({ type: 'output_audio_buffer.stopped', response_id: 'assistant-playback' });

  stage = 'deliberate_barge_in';
  const beforeBarge = (await responseCreates()).length;
  await inject({ type: 'output_audio_buffer.started', response_id: 'assistant-barge' });
  await inject({ type: 'input_audio_buffer.speech_started', item_id: 'barge-in' });
  await inject({ type: 'input_audio_buffer.speech_stopped', item_id: 'barge-in' });
  await inject({ type: 'input_audio_buffer.committed', item_id: 'barge-in' });
  await assertNoResponse('raw_barge_speech_waits_for_provider_playback_clear', beforeBarge, 150);
  await inject({ type: 'output_audio_buffer.cleared', response_id: 'assistant-barge' });
  await inject({ type: 'response.done', response: { id: 'assistant-barge' } });
  const bargeRequest = await eventually(async () => {
    const entries = await responseCreates();
    return entries.length === beforeBarge + 1 ? entries.at(-1) : null;
  }, 'deliberate_barge_response');
  gate('deliberate_user_barge_in_remains_interruptible', Boolean(bargeRequest), { confirmation: 'output_audio_buffer.cleared' });
  await inject({ type: 'response.created', response: { id: 'response-barge', metadata: bargeRequest.metadata } });
  await inject({ type: 'response.done', response: { id: 'response-barge' } });

  // A provider can report a barge cancellation without a later
  // output_audio_buffer.cleared. That has the same deliberate-interruption
  // meaning and must not reject the user turn or strand the previous result.
  stage = 'cancelled_only_barge_in';
  const beforeCancelledBarge = (await responseCreates()).length;
  await inject({ type: 'output_audio_buffer.started', response_id: 'assistant-cancelled-only' });
  await inject({ type: 'input_audio_buffer.speech_started', item_id: 'barge-cancelled-only' });
  await inject({ type: 'input_audio_buffer.speech_stopped', item_id: 'barge-cancelled-only' });
  await inject({ type: 'input_audio_buffer.committed', item_id: 'barge-cancelled-only' });
  await assertNoResponse('raw_cancelled_only_barge_waits_for_provider_confirmation', beforeCancelledBarge, 150);
  await inject({ type: 'response.cancelled', response: { id: 'assistant-cancelled-only' } });
  const cancelledBargeRequest = await eventually(async () => {
    const entries = await responseCreates();
    return entries.length === beforeCancelledBarge + 1 ? entries.at(-1) : null;
  }, 'cancelled_only_barge_response');
  gate('cancelled_only_barge_in_remains_interruptible', Boolean(cancelledBargeRequest), { confirmation: 'response.cancelled' });
  await inject({ type: 'response.created', response: { id: 'response-cancelled-barge', metadata: cancelledBargeRequest.metadata } });
  await inject({ type: 'response.done', response: { id: 'response-cancelled-barge' } });

  const visibleText = await page.locator('mux-cos').innerText();
  gate('no_raw_voice_lease_or_provider_debug_is_visible', !/AppVoiceLeaseEnded|input_audio_buffer|response\.create|provider_ended/i.test(visibleText));
  stage = 'normal_voice_exit';
  await page.locator('mux-cos button[aria-label="Exit voice mode"]:visible').click();
  await composer.waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('mux-cos button[aria-label="Start voice mode"]:visible').waitFor({ state: 'visible', timeout: 10_000 });
  gate(
    'normal_voice_lease_exit_returns_to_composer_without_debug_clutter',
    await composer.isEnabled() &&
      !/AppVoiceLeaseEnded|input_audio_buffer|response\.create|provider_ended/i.test(await page.locator('mux-cos').innerText()),
  );
  // Run the compact control against a separate Android Chrome-class browser
  // context, not merely a desktop viewport resized to portrait dimensions.
  stage = 'android_touch_layout';
  const mobileContext = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(base.href, { waitUntil: 'domcontentloaded' });
  if (await mobilePage.locator('mux-cos:visible').count() !== 1) {
    await mobilePage.getByRole('button', { name: /Mission Control/ }).first().click();
  }
  const mobileComposer = mobilePage.locator('[data-thread-composer]');
  await mobileComposer.waitFor({ state: 'visible', timeout: 30_000 });
  await mobileComposer.fill('MOBILE_TOUCH_LAYOUT_CANARY');
  const mobilePrimary = mobilePage.locator('mux-cos button.primary-control:visible');
  const portraitBox = await mobilePrimary.boundingBox();
  gate(
    'android_portrait_primary_control_has_touch_target_and_accessible_send_name',
    await mobilePage.evaluate(() => matchMedia('(any-pointer: coarse)').matches) &&
      portraitBox !== null && portraitBox.width >= 44 && portraitBox.height >= 44 &&
      await mobilePrimary.getAttribute('aria-label') === 'Send' &&
      await mobileComposer.evaluate((node) => node.getBoundingClientRect().bottom <= window.innerHeight + 1),
  );
  await mobilePage.screenshot({ path: path.join(output, 'composer-voice-regression-android-portrait.png') });
  await mobilePage.setViewportSize({ width: 844, height: 390 });
  gate(
    'android_landscape_composer_and_primary_control_remain_in_view',
    await mobileComposer.evaluate((node) => node.getBoundingClientRect().bottom <= window.innerHeight + 1) &&
      await mobilePrimary.evaluate((node) => node.getBoundingClientRect().bottom <= window.innerHeight + 1),
  );
  await mobilePage.screenshot({ path: path.join(output, 'composer-voice-regression-android-landscape.png') });
  await mobileContext.close();
  gate('no_browser_runtime_errors', browserErrors.length === 0, { error_names: browserErrors });
  await page.screenshot({ path: path.join(output, 'composer-voice-regression-desktop.png') });
  await peer.evaluate(async () => {
    window.__appVoiceRegressionPeer?.oscillator?.stop();
    await window.__appVoiceRegressionPeer?.audio?.close();
    window.__appVoiceRegressionPeer?.connection?.close();
  });
  await peer.close();
  report.status = 'PASS';
} catch (error) {
  firstFailure = stage;
  report.errors.push(`stage:${stage}`, `error_type:${error?.name ?? 'Error'}`);
  const message = String(error?.message ?? '');
  if (/^[a-zA-Z0-9_.: -]{1,180}$/.test(message)) report.errors.push(`detail:${message}`);
} finally {
  report.first_failure = firstFailure || undefined;
  writePrivate('results.json', report);
  await browser?.close();
}
console.log(JSON.stringify({ status: report.status, source_reference: report.source_reference.type }));
process.exitCode = report.status === 'PASS' ? 0 : 1;