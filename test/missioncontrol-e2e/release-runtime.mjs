#!/usr/bin/env node
/*
 * Private prepared-environment race driver.  It controls only browser UI and
 * the provider-edge fixture's file barrier; an operator, not this process,
 * captures a nonfatal SIGUSR1 profile in a tagged integration candidate.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const usage = `Usage:
  node test/missioncontrol-e2e/release-runtime.mjs \\
    --base-url <URL> --muxterm-bin <path> --provider-records <private JSON> \\
    --barrier-dir <private directory> --output <private directory> \\
    --source-ref <40-git-sha|64-source-archive-sha256> --accept-disposable-fixtures \\
    [--hold-open-file <private release file> --goroutine-profile <private profile file>]
    [--playwright-module <absolute path>]

Start provider_fixture.py with --barrier-dir matching this driver and configure
the already-running candidate with missioncontrol.text_worker_cap=1.  This
driver never starts, stops, signals, or inspects product processes.`;

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]; if (key === '--help' || key === '-h') return { help: true };
    if (!key?.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const name = key.slice(2);
    if (name === 'accept-disposable-fixtures' || name === 'headed') { out[name] = true; continue; }
    const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    out[name] = value;
  }
  return out;
}
const opt = parse(process.argv.slice(2));
if (opt.help) { console.log(usage); process.exit(0); }
if (opt['source-sha'] && opt['source-ref']) throw new Error('supply only --source-ref');
opt['source-ref'] ??= opt['source-sha'];
for (const name of ['base-url', 'muxterm-bin', 'provider-records', 'barrier-dir', 'output', 'source-ref']) if (!opt[name]) throw new Error(`--${name} is required\n${usage}`);
if (!opt['accept-disposable-fixtures']) throw new Error('--accept-disposable-fixtures is required');
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(opt['source-ref'])) throw new Error('invalid_source_reference');
if (opt['hold-open-file'] && (!opt['goroutine-profile'] || !path.isAbsolute(opt['goroutine-profile']))) throw new Error('hold_requires_absolute_goroutine_profile');
if (opt['goroutine-profile'] && fs.existsSync(opt['goroutine-profile'])) throw new Error('goroutine_profile_must_be_fresh');
for (const name of ['muxterm-bin', 'provider-records', 'barrier-dir']) if (!fs.existsSync(opt[name])) throw new Error(`missing prepared ${name}`);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const output = path.resolve(opt.output);
if (!path.relative(repo, output).startsWith('..')) throw new Error('output_must_be_private_and_outside_repository');
if (opt['playwright-module'] && !path.isAbsolute(opt['playwright-module'])) throw new Error('--playwright-module must be an absolute path');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const sourceReference = /^[0-9a-f]{40}$/i.test(opt['source-ref'])
  ? { type: 'git_commit_sha', value: opt['source-ref'].toLowerCase() }
  : { type: 'source_archive_sha256', value: opt['source-ref'].toLowerCase() };
const report = { format: 'missioncontrol-release-runtime-race-v1', status: 'FAIL', source_reference: sourceReference, expected_active_subscriptions: 1, admitted_cycles: 0, checks: {}, diagnostics: { console: [], page_errors: [], websocket: [], protocol: [], controls: [] }, errors: [] };
const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
const pause = (n) => new Promise((resolve) => setTimeout(resolve, n));
async function eventually(fn, label, timeout = 60_000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await pause(50); }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last.message}` : ''}`);
}
function records() { const value = JSON.parse(fs.readFileSync(opt['provider-records'], 'utf8')); if (!Array.isArray(value)) throw new Error('provider_records_not_array'); return value; }
function put(file, text = '') { fs.writeFileSync(file, text, { mode: 0o600 }); }
function pass(name, evidence = {}) { report.checks[name] = { status: 'PASS', ...evidence }; }
let browser;
try {
  const startRecords = records().length, stamp = randomUUID().slice(0, 12);
  const labelA = `MC runtime A ${stamp}`, labelB = `MC runtime B ${stamp}`;
  for (const label of [labelA, labelB]) execFileSync(opt['muxterm-bin'], ['workspace', 'create', label, '--json'], { encoding: 'utf8', env: process.env });
  const { chromium } = createRequire(import.meta.url)(opt['playwright-module'] ?? 'playwright');
  browser = await chromium.launch({ channel: opt['browser-channel'] ?? 'chrome', headless: !opt.headed, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const frames = [];
  const frameTimes = new WeakMap();
  page.on('console', (message) => report.diagnostics.console.push({ type: message.type(), text: message.text(), at_ms: Date.now() }));
  page.on('pageerror', (error) => report.diagnostics.page_errors.push({ message: String(error?.stack ?? error), at_ms: Date.now() }));
  function protocolFrame(direction, frame) {
    if (frame?.type !== 'missioncontrol-result' && frame?.type !== 'missioncontrol-event' && !String(frame?.type ?? '').startsWith('missioncontrol-')) return;
    const capabilities = frame.capabilities && typeof frame.capabilities === 'object'
      ? { text_threads: frame.capabilities.text_threads === true, approval: frame.capabilities.approval === true, cancel: frame.capabilities.cancel === true, reset: frame.capabilities.reset === true, archive: frame.capabilities.archive === true }
      : undefined;
    const selectionShape = frame.op === 'select' || frame.type === 'missioncontrol-select'
      ? {
          history_array: Array.isArray(frame.history),
          thread_seq_numeric: Number.isSafeInteger(frame.thread_seq) && frame.thread_seq >= 0,
          replay_events_array: Array.isArray(frame.replay_events),
          gap_boolean: typeof frame.gap === 'boolean',
          draft_ref_present: typeof frame.draft_ref === 'string' && frame.draft_ref.length > 0,
        }
      : undefined;
    report.diagnostics.protocol.push({
      direction,
      at_ms: Date.now(),
      type: frame.type,
      op: frame.op,
      request_id_sha256: typeof frame.request_id === 'string' ? sha(frame.request_id).slice(0, 16) : undefined,
      ok: frame.ok === true,
      enabled: frame.enabled === true,
      code: frame.code,
      thread_kind: frame.thread?.kind,
      runtime_generation: frame.thread?.runtime_generation ?? frame.runtime_generation,
      thread_seq: frame.thread_seq,
      capabilities,
      selection_shape: selectionShape,
    });
  }
  page.on('websocket', (socket) => {
    const entry = { url: socket.url(), opened_at_ms: Date.now(), closed_at_ms: null };
    report.diagnostics.websocket.push(entry);
    socket.on('close', () => { entry.closed_at_ms = Date.now(); });
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (frame.type !== 'missioncontrol-result' && frame.type !== 'missioncontrol-event') return;
        // Keep only control-plane transition fields. History, event payloads,
        // provider requests, and prompt text are deliberately excluded.
        frameTimes.set(frame, Date.now());
        frames.push(frame);
        protocolFrame('received', frame);
      } catch {}
    });
    socket.on('framesent', ({ payload }) => {
      try { protocolFrame('sent', JSON.parse(String(payload))); } catch {}
    });
  });
  async function captureControls(phase) {
    const controls = await page.evaluate(() => {
      const findAll = (root, selector, found = []) => {
        if (root instanceof Element && root.matches(selector)) found.push(root);
        for (const child of root.children ?? []) findAll(child, selector, found);
        if (root instanceof Element && root.shadowRoot) findAll(root.shadowRoot, selector, found);
        return found;
      };
      const all = (selector) => findAll(document.documentElement, selector);
      const composer = all('[data-thread-composer]')[0];
      const selector = all('[data-thread-context-selector]')[0];
      const app = all('mux-app')[0];
      const cos = all('mux-cos')[0];
      return {
        selector_count: all('[data-thread-context-selector]').length,
        selector_visible: selector instanceof HTMLElement && !!(selector.offsetWidth || selector.offsetHeight || selector.getClientRects().length),
        composer_count: all('[data-thread-composer]').length,
        composer_enabled: composer instanceof HTMLTextAreaElement ? !composer.disabled : null,
        mux_app_present: app !== undefined,
        mux_cos_present: cos !== undefined,
      };
    });
    const controlsFrames = frames.map((frame) => {
      const capabilities = frame.type === 'missioncontrol-result' && frame.op === 'capabilities' && frame.capabilities && typeof frame.capabilities === 'object'
        ? { text_threads: frame.capabilities.text_threads === true, approval: frame.capabilities.approval === true, cancel: frame.capabilities.cancel === true, reset: frame.capabilities.reset === true, archive: frame.capabilities.archive === true }
        : undefined;
      return {
        received_at_ms: frameTimes.get(frame) ?? null,
        type: frame.type,
        op: frame.type === 'missioncontrol-result' ? frame.op : undefined,
        ok: frame.type === 'missioncontrol-result' ? frame.ok === true : undefined,
        enabled: frame.type === 'missioncontrol-result' ? frame.enabled === true : undefined,
        code: frame.type === 'missioncontrol-result' ? frame.code : undefined,
        thread_kind: frame.type === 'missioncontrol-result' && frame.thread ? frame.thread.kind : undefined,
        runtime_generation: frame.type === 'missioncontrol-result' && frame.thread ? frame.thread.runtime_generation : frame.runtime_generation,
        thread_seq: frame.thread_seq,
        capabilities,
      };
    });
    report.diagnostics.controls.push({ phase, at_ms: Date.now(), ...controls, frames: controlsFrames });
  }
  await page.goto(opt['base-url'], { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Mission Control/ }).first().click();
  await page.locator('[data-thread-context-selector]').waitFor({ state: 'visible' });
  async function settleSelected(label) {
    const composer = page.locator('[data-thread-composer]');
    try {
      await eventually(async () => (await composer.isVisible()) && (await composer.isEnabled()) && (await page.locator('[data-thread-context-selector]').innerText()).includes(label), `rendered selected composer for ${label}`);
    } catch (error) {
      await captureControls(`selected_composer_unsettled:${label}`);
      throw error;
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await captureControls(`selected_composer_settled:${label}`);
  }
  function highestObservedThreadSeq(threadID) {
    const sequences = frames.filter((f) => f.type === 'missioncontrol-event' && f.thread_id === threadID && Number.isSafeInteger(f.thread_seq)).map((f) => f.thread_seq);
    return sequences.length ? Math.max(...sequences) : null;
  }
  async function select(label, priorServerEventSeq = null) {
    const start = frames.length; await page.locator('[data-thread-context-selector]').click();
    const option = page.locator('[data-thread-context-option]', { hasText: label }); await option.waitFor({ state: 'visible' }); await option.click();
    const talk = page.locator('[data-thread-talk-here]'); await talk.waitFor({ state: 'visible' }); await talk.click();
    const selection = await eventually(() => frames.slice(start).find((f) => f.op === 'select' && f.ok && f.thread?.display_name === label), `select ${label}`);
    if (!Number.isSafeInteger(selection.thread_seq) || selection.thread_seq < 0) throw new Error('select_snapshot_missing_numeric_thread_seq');
    if (priorServerEventSeq !== null && selection.thread_seq < priorServerEventSeq) throw new Error(`select_snapshot_thread_seq_regressed:${selection.thread_seq}<${priorServerEventSeq}`);
    await settleSelected(label);
    return selection;
  }
  async function selectAttempt(label, expectedCode) {
    const start = frames.length; await page.locator('[data-thread-context-selector]').click();
    const option = page.locator('[data-thread-context-option]', { hasText: label }); await option.waitFor({ state: 'visible' }); await option.click();
    const talk = page.locator('[data-thread-talk-here]'); await talk.waitFor({ state: 'visible' }); await talk.click();
    return eventually(() => frames.slice(start).find((f) => f.op === 'select' && f.ok === false && f.code === expectedCode), `select refusal ${label}/${expectedCode}`);
  }
  async function send(selection, text, terminal = true) {
    const start = frames.length, composer = page.locator('[data-thread-composer]'); await composer.fill(text); await composer.press('Enter');
    const receipt = await eventually(() => frames.slice(start).find((f) => f.op === 'turn' && f.ok && f.turn_id), 'turn receipt');
    if (terminal) {
      const ended = await eventually(() => frames.slice(start).find((f) => f.type === 'missioncontrol-event' && f.thread_id === selection.thread.id && f.event?.turn_id === receipt.turn_id && f.event?.ev === 'turn_end'), 'terminal turn');
      if (ended.event.persisted !== true || ended.event.error) throw new Error('turn_not_successfully_persisted');
    }
    return { start, receipt };
  }
  const a = await select(labelA);
  const token = `runtime-${stamp}`;
  const aSeedText = `A_CANARY=cobalt-otter FIXTURE_CANARY_A FIXTURE_LATE_TURN=${token}`;
  const aSeed = await send(a, aSeedText, false);
  await eventually(() => fs.existsSync(path.join(opt['barrier-dir'], `${token}.ready`)), 'provider late-turn barrier');
  const refused = await selectAttempt(labelB, 'worker_capacity');
  if (!(await page.locator('[data-thread-context-selector]').innerText()).includes(labelA)) throw new Error('A_selection_changed_after_B_capacity_refusal');
  if (frames.slice(aSeed.start).some((f) => f.type === 'missioncontrol-event' && f.thread_id === a.thread.id && f.event?.turn_id === aSeed.receipt.turn_id && f.event?.ev === 'turn_end')) throw new Error('A_finished_before_B_selection_refusal');
  pass('concurrent_B_selection_capacity_refused_A_remains_selected_streaming', { fixture_barrier: true, refusal_code: refused.code, selected_A_sha256: sha(a.thread.id) });
  put(path.join(opt['barrier-dir'], `${token}.release`), 'release\n');
  await eventually(() => frames.find((f) => f.type === 'missioncontrol-event' && f.thread_id === a.thread.id && f.event?.turn_id === aSeed.receipt.turn_id && f.event?.ev === 'turn_end' && f.event?.persisted === true && !f.event?.error), 'released successful A terminal turn');
  const b = await select(labelB);
  await send(b, 'B_CANARY=amber-kite FIXTURE_CANARY_B');
  const priorAEventSeq = highestObservedThreadSeq(a.thread.id);
  const reselectedA = await select(labelA, priorAEventSeq);
  pass('reselect_snapshot_boundary_sequence_monotonic', { field: 'thread_seq', prior_server_event_seq: priorAEventSeq, snapshot_boundary_sequence: reselectedA.thread_seq });
  for (let cycle = 0; cycle < 6; cycle += 1) {
    const target = cycle % 2 ? a : b;
    const active = await select(cycle % 2 ? labelA : labelB, highestObservedThreadSeq(target.thread.id));
    await send(active, `${cycle % 2 ? 'A' : 'B'}_RACE_CANARY_${cycle} FIXTURE_CANARY_${cycle % 2 ? 'A' : 'B'}`);
    report.admitted_cycles += 1;
  }
  const finalA = await select(labelA);
  const cancelToken = `cancel-${randomUUID().slice(0, 12)}`;
  const held = await send(finalA, `FIXTURE_LATE_TURN=${cancelToken} FIXTURE_CANCEL_STREAM`, false);
  await eventually(() => fs.existsSync(path.join(opt['barrier-dir'], `${cancelToken}.ready`)), 'cancellable streamed delta');
  const cancelStart = frames.length;
  await page.locator(`[data-thread-cancel="${held.receipt.turn_id}"]`).click();
  await eventually(() => frames.slice(cancelStart).find((f) =>
    f.op === 'cancel' && f.ok === true && f.turn_id === held.receipt.turn_id), 'scoped cancel receipt');
  await eventually(() => frames.slice(cancelStart).find((f) =>
    f.type === 'missioncontrol-event' && f.thread_id === finalA.thread.id &&
    f.event?.turn_id === held.receipt.turn_id && f.event?.ev === 'turn_end'), 'cancelled stream terminal');
  put(path.join(opt['barrier-dir'], `${cancelToken}.release`), 'release\n');
  pass('held_stream_cancel_uses_exact_selected_turn', { scoped_receipt: true, terminal_observed: true });
  const composer = page.locator('[data-thread-composer]');
  if (!await page.getByText(aSeedText, { exact: true }).count()) throw new Error('A_canary_not_retained_after_evictions');
  if (await page.getByText(/B_RACE_CANARY_/).count()) throw new Error('B_history_rendered_while_A_selected');
  if (!await composer.isEnabled()) throw new Error('final_A_composer_not_enabled');
  const added = records().slice(startRecords);
  const streaming = added.filter((row) => row?.request?.stream === true).length;
  // Two seeds, one request per completed cycle, and the explicit cancel turn.
  if (added.length < 3 + report.admitted_cycles || streaming !== added.length) throw new Error(`provider_records_insufficient_or_nonstreaming:${added.length}/${streaming}`);
  for (let cycle = 0; cycle < 6; cycle += 1) {
    const own = cycle % 2 ? 'A_CANARY=cobalt-otter' : 'B_CANARY=amber-kite';
    const other = cycle % 2 ? 'B_CANARY=amber-kite' : 'A_CANARY=cobalt-otter';
    const input = added.map((row) => JSON.stringify(row?.request?.input ?? '')).find((value) => value.includes(`${cycle % 2 ? 'A' : 'B'}_RACE_CANARY_${cycle}`));
    if (!input?.includes(own) || input.includes(other)) throw new Error(`provider_cycle_context_not_isolated:${cycle}`);
  }
  if (frames.filter((f) => f.type === 'missioncontrol-event').length < 12) throw new Error('insufficient_real_missioncontrol_events');
  pass('real_streaming_provider_records_and_events', { provider_receipts: added.length, streaming_flags: streaming, event_count: frames.filter((f) => f.type === 'missioncontrol-event').length });
  pass('final_A_selected_after_evictions', { expected_active_subscriptions: 1, admitted_cycles: report.admitted_cycles });
  if (opt['hold-open-file']) {
    const marker = path.join(output, 'settled.json');
    put(marker, `${JSON.stringify({ status: 'SETTLED', expected_active_subscriptions: 1, admitted_cycles: report.admitted_cycles })}\n`);
    await eventually(() => fs.existsSync(opt['goroutine-profile']), 'nonfatal candidate SIGUSR1 profile', 60_000);
    const profileStat = fs.statSync(opt['goroutine-profile']);
    if (profileStat.size > 16 * 1024 * 1024 || profileStat.mtimeMs < fs.statSync(marker).mtimeMs) throw new Error('invalid_or_stale_goroutine_profile');
    const profile = fs.readFileSync(opt['goroutine-profile'], 'utf8');
    const stacks = profile.split(/^goroutine \d+ /m).slice(1);
    const forwarders = stacks.filter((stack) =>
      /\.attachMissionControlSubscription\.func\d+\(/.test(stack.split('\ncreated by ')[0])).length;
    const openSockets = report.diagnostics.websocket.filter((socket) => socket.closed_at_ms === null).length;
    if (openSockets !== 1 || forwarders !== 1) throw new Error(`subscription_profile_mismatch:${openSockets}/${forwarders}`);
    pass('nonfatal_subscription_profile_after_evictions', {
      profile_sha256: createHash('sha256').update(profile).digest('hex'),
      goroutine_count: stacks.length,
      active_browser_sockets: openSockets,
      subscription_forwarders: forwarders,
      admitted_cycles: report.admitted_cycles,
      observer: 'SIGUSR1_integration_verification_build_only',
    });
    pass('operator_stack_capture_window', { settled_marker: marker, release_file: path.resolve(opt['hold-open-file']), timeout_seconds: 60, operator_action: 'nonfatal SIGUSR1 profile collected; driver sends no signals' });
    await eventually(() => fs.existsSync(path.resolve(opt['hold-open-file'])), 'operator hold-open release', 60_000);
  }
  report.status = 'PASS';
} catch (error) { report.errors.push(String(error?.stack ?? error)); }
finally { if (browser) await browser.close(); fs.writeFileSync(path.join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); }
console.log(JSON.stringify({ status: report.status, output: path.join(output, 'results.json') }));
process.exitCode = report.status === 'PASS' ? 0 : 1;