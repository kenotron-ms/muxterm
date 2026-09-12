#!/usr/bin/env node
/*
 * Portable, prepared-environment E2E proof for threaded Mission Control text.
 * Prerequisites: a disposable server/sessiond/sidecar environment configured
 * to use provider_fixture.py, and an installed Playwright module.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const usage = `Usage:
  node test/missioncontrol-e2e/run.mjs \\
    --base-url <URL> --muxterm-bin <path> --provider-records <path> \\
    --output <directory> --source-sha <40-hex> --accept-disposable-fixtures

The runner creates two harmless disposable workspaces. It never starts or
stops a server, session daemon, sidecar, browser-owned workspace, or lane.
Playwright must already be installed; use --playwright-module <module-or-path>
when it is not resolvable from this script.`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'accept-disposable-fixtures' || key === 'headed') {
      options[key] = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[key] = value;
  }
  return options;
}

function fail(message) {
  throw new Error(message);
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashId(value) {
  if (typeof value !== 'string' || !value) fail('missing non-empty runtime identity');
  return sha(value);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(callback, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  fail(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function flattenText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenText).join('\n');
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([key]) => ['text', 'content', 'input', 'instructions'].includes(key))
      .map(([, item]) => flattenText(item))
      .join('\n');
  }
  return '';
}

function recordsSince(file, start) {
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(records) || records.length < start) fail('provider record file was replaced during run');
  return records.slice(start);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage);
  process.exit(0);
}
for (const required of ['base-url', 'muxterm-bin', 'provider-records', 'output', 'source-sha']) {
  if (!args[required]) fail(`--${required} is required\n${usage}`);
}
if (!args['accept-disposable-fixtures']) fail(`--accept-disposable-fixtures is required\n${usage}`);
if (!/^[0-9a-f]{40}$/i.test(args['source-sha'])) fail('--source-sha must be a 40-character hexadecimal commit SHA');
if (!fs.existsSync(args['muxterm-bin'])) fail('--muxterm-bin does not exist');
if (!fs.existsSync(args['provider-records'])) fail('--provider-records must be created by provider_fixture.py before running');

const output = path.resolve(args.output);
const providerStart = JSON.parse(fs.readFileSync(args['provider-records'], 'utf8'));
if (!Array.isArray(providerStart)) fail('--provider-records is not a JSON array');
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(args['playwright-module'] ?? 'playwright'));
} catch (error) {
  fail(`Playwright is an explicit prerequisite; install or pass --playwright-module: ${error.message}`);
}

const run = {
  format: 'missioncontrol-text-e2e-v1',
  status: 'FAIL',
  source_sha: args['source-sha'].toLowerCase(),
  checks: {},
  identities: {},
  errors: [],
};
const pass = (name, evidence) => { run.checks[name] = { status: 'PASS', evidence }; };
const check = (condition, name, evidence) => {
  if (!condition) fail(`${name}: assertion failed`);
  pass(name, evidence);
};
let browser;

try {
  const nonce = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const labelA = `MC review fixture A ${nonce}`;
  const labelB = `MC review fixture B ${nonce}`;
  for (const label of [labelA, labelB]) {
    execFileSync(args['muxterm-bin'], ['workspace', 'create', label, '--json'], { encoding: 'utf8' });
  }
  pass('fresh_disposable_workspaces_created', { count: 2 });

  browser = await chromium.launch({
    channel: args['browser-channel'] ?? 'chrome',
    headless: !args.headed,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const frames = [];
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    try {
      const frame = JSON.parse(String(payload));
      if (frame.type === 'missioncontrol-result' || frame.type === 'missioncontrol-event') frames.push(frame);
    } catch { /* non-JSON WebSocket frames are unrelated */ }
  }));
  await page.goto(args['base-url'], { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Mission Control/ }).first().click();
  await page.locator('[data-thread-context-selector]').waitFor({ state: 'visible', timeout: 30_000 });

  async function select(label) {
    const start = frames.length;
    await page.locator('[data-thread-context-selector]').click();
    const option = page.locator('button.context-option', { hasText: label });
    await option.waitFor({ state: 'visible', timeout: 30_000 });
    await option.click();
    await page.locator('[data-thread-talk-here]').click();
    const acknowledgement = await eventually(
      () => frames.slice(start).find((frame) =>
        frame.op === 'select' && frame.ok === true && frame.thread?.display_name === label),
      `selection acknowledgement for ${label}`,
    );
    const composer = page.locator('[data-thread-composer]');
    await eventually(async () =>
      (await composer.isVisible()) && (await composer.isEnabled()) &&
      (await page.locator('[data-thread-context-selector]').innerText()).includes(label),
    `selected enabled composer for ${label}`);
    check(
      Boolean(acknowledgement.thread?.runtime_session_id && acknowledgement.thread?.runtime_incarnation && acknowledgement.draft_ref),
      'real_runtime_session_and_snapshot_identity',
      {
        runtime_session_id_sha256: hashId(acknowledgement.thread.runtime_session_id),
        runtime_incarnation_sha256: hashId(acknowledgement.thread.runtime_incarnation),
        draft_ref_sha256: hashId(acknowledgement.draft_ref),
      },
    );
    return acknowledgement;
  }

  async function terminalFor(selection, start, turnId) {
    const terminal = await eventually(
      () => frames.slice(start).find((frame) =>
        frame.type === 'missioncontrol-event' &&
        frame.thread_id === selection.thread.id &&
        frame.event?.turn_id === turnId &&
        frame.event?.ev === 'turn_end'),
      'persisted terminal event',
    );
    if (terminal.event.persisted !== true || terminal.event.error) fail('terminal turn was not persisted successfully');
    return terminal;
  }

  async function send(selection, text, waitForTerminal = true) {
    const start = frames.length;
    const composer = page.locator('[data-thread-composer]');
    await composer.fill(text);
    if (await composer.inputValue() !== text) fail('composer did not retain the typed text');
    await composer.press('Enter');
    const receipt = await eventually(
      () => frames.slice(start).find((frame) => frame.op === 'turn' && frame.ok === true && frame.turn_id),
      'turn receipt',
    );
    if (waitForTerminal) await terminalFor(selection, start, receipt.turn_id);
    return { receipt, start };
  }

  const a = await select(labelA);
  await send(a, 'A_CANARY=cobalt-otter FIXTURE_CANARY_A');
  const b = await select(labelB);
  await send(b, 'B_CANARY=amber-kite FIXTURE_CANARY_B');
  await select(labelA);
  await send(a, 'Recall only the originating canary.');

  const visibleA = await page.getByText('A_CANARY=cobalt-otter FIXTURE_CANARY_A', { exact: true }).count();
  check(visibleA > 0, 'originating_A_canary_rendered', { visible_prompt_count: visibleA });

  const composer = page.locator('[data-thread-composer]');
  await composer.fill('A_DRAFT_PORTABLE');
  await select(labelB);
  await composer.fill('B_DRAFT_PORTABLE');
  await select(labelA);
  check(await composer.inputValue() === 'A_DRAFT_PORTABLE', 'per_thread_draft_restored', { restored: true });

  const todo = await send(a, 'FIXTURE_TODO_CALL');
  const todoStart = await eventually(() => frames.slice(todo.start).find((frame) =>
    frame.type === 'missioncontrol-event' && frame.thread_id === a.thread.id &&
    frame.event?.turn_id === todo.receipt.turn_id && frame.event?.ev === 'tool_start' && frame.event?.name === 'todo'),
  'todo tool_start');
  const todoEnd = await eventually(() => frames.slice(todo.start).find((frame) =>
    frame.type === 'missioncontrol-event' && frame.thread_id === a.thread.id &&
    frame.event?.ev === 'tool_end' && frame.event?.call_id === todoStart.event.call_id && frame.event?.ok === true),
  'todo tool_end correlated by call_id');
  pass('genuine_todo_tool_call', { call_id_sha256: hashId(todoEnd.event.call_id) });

  await select(labelB);
  const goal = await send(b, 'FIXTURE_GOAL_CALL', false);
  const goalStart = await eventually(() => frames.slice(goal.start).find((frame) =>
    frame.type === 'missioncontrol-event' && frame.thread_id === b.thread.id &&
    frame.event?.turn_id === goal.receipt.turn_id && frame.event?.ev === 'tool_start' && frame.event?.name === 'thread_goal'),
  'thread_goal tool_start');
  const approval = await eventually(() => frames.slice(goal.start).find((frame) =>
    frame.type === 'missioncontrol-event' && frame.thread_id === b.thread.id &&
    frame.event?.turn_id === goal.receipt.turn_id && frame.event?.ev === 'approval_request' && frame.event?.tool === 'thread_goal'),
  'scoped approval request');
  await page.reload({ waitUntil: 'domcontentloaded' });
  const approve = page.locator(`[data-thread-approval="approve:${goal.receipt.turn_id}:${approval.event.request_id}"]`);
  await approve.waitFor({ state: 'visible', timeout: 60_000 });
  await approve.click();
  const goalEnd = await eventually(() => frames.slice(goal.start).find((frame) =>
    frame.type === 'missioncontrol-event' && frame.thread_id === b.thread.id &&
    frame.event?.ev === 'tool_end' && frame.event?.call_id === goalStart.event.call_id && frame.event?.ok === true),
  'thread_goal tool_end correlated by call_id');
  await terminalFor(b, goal.start, goal.receipt.turn_id);
  pass('genuine_scoped_approval_pair_restored_after_reload', {
    call_id_sha256: hashId(goalEnd.event.call_id),
    approval_id_sha256: hashId(approval.event.request_id),
  });

  const providerRecords = recordsSince(args['provider-records'], providerStart.length);
  const requestText = providerRecords.map((record) => flattenText(record?.request?.input));
  const aInitial = requestText.find((text) => text.includes('FIXTURE_CANARY_A') && !text.includes('Recall only'));
  const bInitial = requestText.find((text) => text.includes('FIXTURE_CANARY_B'));
  const aRecall = requestText.find((text) => text.includes('Recall only the originating canary.'));
  check(
    Boolean(aInitial?.includes('FIXTURE_CANARY_A') && !aInitial.includes('FIXTURE_CANARY_B') &&
      bInitial?.includes('FIXTURE_CANARY_B') && !bInitial.includes('FIXTURE_CANARY_A') &&
      aRecall?.includes('FIXTURE_CANARY_A') && !aRecall.includes('FIXTURE_CANARY_B')),
    'provider_inputs_scoped_to_originating_thread',
    { A_initial_has_A: true, A_initial_has_B: false, B_initial_has_B: true, B_initial_has_A: false, A_followup_has_A: true, A_followup_has_B: false },
  );

  if (args.screenshot) {
    const screenshot = path.resolve(args.screenshot);
    await page.locator('mux-cos').screenshot({ path: screenshot });
    pass('sanitized_chat_region_capture', {
      crop: 'mux-cos host rectangle; excludes terminal and browser chrome',
      sha256: sha(fs.readFileSync(screenshot)),
    });
  }
  run.status = 'PASS';
} catch (error) {
  run.errors.push(String(error?.stack ?? error));
} finally {
  if (browser) await browser.close();
  writeJson(path.join(output, 'results.json'), run);
}

console.log(JSON.stringify({ status: run.status, output: path.join(output, 'results.json') }));
process.exitCode = run.status === 'PASS' ? 0 : 1;