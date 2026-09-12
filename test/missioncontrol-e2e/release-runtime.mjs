#!/usr/bin/env node
/*
 * Private prepared-environment race driver.  It controls only browser UI and
 * the provider-edge fixture's file barrier; an operator, not this process,
 * may capture SIGQUIT stacks while --hold-open-file is present.
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
    [--hold-open-file <private release file>] [--playwright-module <absolute path>]

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
for (const name of ['muxterm-bin', 'provider-records', 'barrier-dir']) if (!fs.existsSync(opt[name])) throw new Error(`missing prepared ${name}`);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const output = path.resolve(opt.output);
if (!path.relative(repo, output).startsWith('..')) throw new Error('output_must_be_private_and_outside_repository');
if (opt['playwright-module'] && !path.isAbsolute(opt['playwright-module'])) throw new Error('--playwright-module must be an absolute path');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const sourceReference = /^[0-9a-f]{40}$/i.test(opt['source-ref'])
  ? { type: 'git_commit_sha', value: opt['source-ref'].toLowerCase() }
  : { type: 'source_archive_sha256', value: opt['source-ref'].toLowerCase() };
const report = { format: 'missioncontrol-release-runtime-race-v1', status: 'FAIL', source_reference: sourceReference, expected_active_subscriptions: 1, admitted_cycles: 0, checks: {}, errors: [] };
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
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => { try { const frame = JSON.parse(String(payload)); if (frame.type === 'missioncontrol-result' || frame.type === 'missioncontrol-event') frames.push(frame); } catch {} }));
  await page.goto(opt['base-url'], { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Mission Control/ }).first().click();
  await page.locator('[data-thread-context-selector]').waitFor({ state: 'visible' });
  async function settleSelected(label) {
    const composer = page.locator('[data-thread-composer]');
    await eventually(async () => (await composer.isVisible()) && (await composer.isEnabled()) && (await page.locator('[data-thread-context-selector]').innerText()).includes(label), `rendered selected composer for ${label}`);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
  await select(labelA);
  const composer = page.locator('[data-thread-composer]');
  if (!await page.getByText(aSeedText, { exact: true }).count()) throw new Error('A_canary_not_retained_after_evictions');
  if (await page.getByText(/B_RACE_CANARY_/).count()) throw new Error('B_history_rendered_while_A_selected');
  if (!await composer.isEnabled()) throw new Error('final_A_composer_not_enabled');
  const added = records().slice(startRecords);
  const streaming = added.filter((row) => row?.request?.stream === true).length;
  // Two seed turns plus one turn per completed eviction cycle. Selection
  // itself does not call the provider and must not be counted as a ninth turn.
  if (added.length < 2 + report.admitted_cycles || streaming !== added.length) throw new Error(`provider_records_insufficient_or_nonstreaming:${added.length}/${streaming}`);
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
    pass('operator_stack_capture_window', { settled_marker: marker, release_file: path.resolve(opt['hold-open-file']), timeout_seconds: 60, operator_action: 'capture candidate SIGQUIT stacks now; driver sends no signals' });
    await eventually(() => fs.existsSync(path.resolve(opt['hold-open-file'])), 'operator hold-open release', 60_000);
  }
  report.status = 'PASS';
} catch (error) { report.errors.push(String(error?.stack ?? error)); }
finally { if (browser) await browser.close(); fs.writeFileSync(path.join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); }
console.log(JSON.stringify({ status: report.status, output: path.join(output, 'results.json') }));
process.exitCode = report.status === 'PASS' ? 0 : 1;