/**
 * The automated end-to-end proof for realtime voice.
 *
 * WHY THIS EXISTS
 *
 * The only honest proof that a spoken conversation works is a spoken
 * conversation. But a proof that requires a person to sit at a microphone is
 * a proof nobody re-runs, and one that cannot run in CI at all. So this
 * harness drives the REAL browser code path with a real WAV file in place of
 * a mic, against the REAL realtime endpoint, and reads back what was
 * actually heard and said.
 *
 * A successful WebRTC handshake proves nothing on its own. What is asserted
 * here is audio in BOTH directions:
 *
 *   1. an ephemeral secret is minted server-side                     (C2)
 *   2. a real WebRTC session is established against the endpoint     (C4)
 *   3. pre-synthesized speech is fed in place of a microphone
 *   4. the INPUT transcript comes back — the model HEARD it
 *   5. a real chief-of-staff action runs, server-side, via a tool    (C5)
 *   6. audio frames and an OUTPUT transcript come back — it SPOKE
 *
 * ISOLATION
 *
 * Everything runs against throwaway XDG_RUNTIME_DIR, XDG_DATA_HOME and
 * XDG_CONFIG_HOME on a port of its own. The production instance on 8311 and
 * its sessiond are never touched, and ~/.local/share/muxterm is never read
 * or written — overriding only XDG_RUNTIME_DIR leaves the crash-restore
 * snapshot resolving to the production path, which is how a dev run
 * corrupts what production would restore.
 *
 * USAGE
 *
 *   npm install
 *   node run.mjs [--headed] [--keep]
 */

import { chromium } from 'playwright-core';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize } from './synthesize.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

const ARGS = new Set(process.argv.slice(2));
const HEADED = ARGS.has('--headed');
const KEEP = ARGS.has('--keep');

// A port nothing else on this machine uses. Production is 8311 and its
// fronting proxy is 9090; `make dev-local` is 8313; `make dev` is 9091.
const PORT = Number(process.env.VOICE_E2E_PORT ?? 8319);
const BASE = `http://127.0.0.1:${PORT}`;

const ENDPOINT =
  process.env.VOICE_E2E_ENDPOINT ??
  readKeysEnv('OPENAI_BASE_URL') ??
  'https://amplifier-model-hosting.openai.azure.com/openai/v1';
const MODEL = process.env.VOICE_E2E_MODEL ?? 'gpt-realtime-2.1';

// What the harness "says". Phrased to make the model reach for the chief of
// staff rather than answer from its own knowledge: it is a question about
// THIS machine, which the realtime model has no way to answer alone.
const UTTERANCE =
  process.env.VOICE_E2E_UTTERANCE ??
  'Please ask the chief of staff what the current working directory is, and then say the answer out loud.';

const steps = [];
const started = Date.now();
let proc = null;
let browser = null;
let tmp = null;

main().catch(async (err) => {
  fail('unexpected', err?.stack ?? String(err));
  await diagnose();
  report(false);
  await teardown();
  process.exit(1);
});

/** On failure, dump what the two sides actually saw. */
async function diagnose() {
  try {
    const body = await fetchJSON(`${BASE}/api/cos/voice/trace`);
    console.log('\n\x1b[2msideband trace:\x1b[0m');
    for (const t of body.traces ?? []) {
      console.log(`  ${t.at} ${t.kind}${t.name ? ' ' + t.name : ''}${t.detail ? ' — ' + t.detail : ''}`);
    }
  } catch (e) {
    console.log('  (trace unavailable: ' + e.message + ')');
  }
  try {
    const page = (await browser?.contexts()?.[0]?.pages()) ?? [];
    if (page[0]) {
      const log = await page[0].evaluate(() => window.__muxterm.voiceSession.log());
      console.log('\x1b[2mtranscript log:\x1b[0m');
      for (const e of log) console.log(`  ${e.dir}: ${e.text}`);
    }
  } catch {
    /* browser already gone */
  }
}

async function main() {
  banner();

  // ── 0. credentials ──────────────────────────────────────────────────────
  // Never printed. Only its presence and length are reported.
  const token = await entraToken();
  ok('credential', `Entra token acquired (${token.length} chars), scope https://ai.azure.com/.default`);

  // ── 1. isolation ────────────────────────────────────────────────────────
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muxterm-voice-e2e-'));
  const runtimeDir = path.join(tmp, 'runtime');
  const dataDir = path.join(tmp, 'data');
  const configDir = path.join(tmp, 'config');
  for (const d of [runtimeDir, dataDir, path.join(configDir, 'muxterm')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(
    path.join(configDir, 'muxterm', 'config.toml'),
    [
      '[voice]',
      'enabled = true',
      `endpoint = "${ENDPOINT}"`,
      `model = "${MODEL}"`,
      'auth_mode = "entra"',
      'voice = "marin"',
      'sync_tool_timeout = "10s"',
      '',
    ].join('\n'),
  );
  ok('isolation', `throwaway XDG dirs under ${tmp}; production 8311 untouched`);

  // ── 2. the utterance ────────────────────────────────────────────────────
  const wavPath = path.join(tmp, 'utterance.wav');
  const synth = await synthesize({
    endpoint: ENDPOINT,
    model: MODEL,
    token,
    text: UTTERANCE,
    out: wavPath,
  });
  ok(
    'utterance',
    `${synth.seconds.toFixed(1)}s of synthesized speech at ${wavPath}\n         spoken text: "${synth.transcript}"`,
  );

  // ── 3. the server ───────────────────────────────────────────────────────
  await buildBinary();
  proc = await startServer({ runtimeDir, dataDir, configDir });
  ok('server', `muxterm serve on ${BASE} (pid ${proc.pid}), [voice] enabled`);

  // ── 4. the token endpoint (C2) ──────────────────────────────────────────
  const mint = await fetchJSON(`${BASE}/api/cos/voice/token`, { method: 'POST' });
  if (!mint.value || !mint.value.startsWith('ek_')) {
    throw new Error('the token endpoint returned no ephemeral secret: ' + JSON.stringify(mint));
  }
  ok(
    'C2 token',
    `POST /api/cos/voice/token minted ${mint.value.slice(0, 3)}… (${mint.value.length} chars), ` +
      `model ${mint.model}, auth_mode ${mint.auth_mode}, session ${mint.session_id.slice(0, 8)}…`,
  );

  // ── 5. the browser ──────────────────────────────────────────────────────
  browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      // %noloop is LOAD-BEARING. Without it Chromium replays the file
      // forever, so the harness "speaks" again every few seconds --
      // interrupting the assistant mid-answer through the very barge-in
      // support this feature is built on, and the answer is never heard.
      // The bug looks like a flaky model; it is a looping microphone.
      `--use-file-for-fake-audio-capture=${wavPath}%noloop`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__muxterm?.voiceSession, null, { timeout: 20_000 });

  // Open the Dashboard. ctrl+` is the documented shortcut, and opening it is
  // also what STARTS the chief-of-staff sidecar -- muxterm spawns the
  // amplifier session lazily off the first cos-subscribe, so a surface
  // nobody opened costs nothing. Doing it now lets the sidecar boot while
  // the WebRTC handshake happens.
  await page.keyboard.press('Control+`');
  await page.waitForFunction(
    () => !!document.querySelector('mux-app')?.shadowRoot?.querySelector('mux-cos'),
    null,
    { timeout: 15_000 },
  );
  ok('browser', 'Chromium up, muxterm loaded, Dashboard open, fake microphone armed with the WAV');

  // ── 6. the conversation (C4) ────────────────────────────────────────────
  // Started through the controller's own entry point, which is the same
  // code path the composer's voice control calls. Clicking the button
  // itself is covered separately below.
  await page.evaluate(() => window.__muxterm.voiceSession.start());
  await page.waitForFunction(
    () => {
      const s = window.__muxterm.voiceSession.snapshot();
      return s.state !== 'connecting' && s.state !== 'idle';
    },
    null,
    { timeout: 45_000 },
  );
  const afterConnect = await page.evaluate(() => ({
    snap: window.__muxterm.voiceSession.snapshot(),
    conn: window.__muxterm.voiceSession.connectionState(),
  }));
  if (afterConnect.snap.state === 'error') {
    throw new Error('the session failed to connect: ' + afterConnect.snap.error);
  }
  ok('C4 webrtc', `RTCPeerConnection ${afterConnect.conn}, session state "${afterConnect.snap.state}"`);

  // ── 7. did it HEAR? ─────────────────────────────────────────────────────
  await page.waitForFunction(() => window.__muxterm.voiceSession.snapshot().heard.length > 0, null, {
    timeout: 90_000,
  });
  // Every heard utterance, not just the latest: server VAD commits on a
  // pause, so one spoken sentence can legitimately arrive as two.
  const heardAll = await page.evaluate(() =>
    window.__muxterm.voiceSession
      .log()
      .filter((e) => e.dir === 'heard')
      .map((e) => e.text),
  );
  ok('heard', heardAll.map((t, i) => `input transcript ${i + 1}: "${t}"`).join('\n         '));

  // ── 8. did it SPEAK? ────────────────────────────────────────────────────
  await page.waitForFunction(
    () => window.__muxterm.voiceSession.log().some((e) => e.dir === 'spoke'),
    null,
    { timeout: 120_000 },
  );
  const spoken = await page.evaluate(() =>
    window.__muxterm.voiceSession
      .log()
      .filter((e) => e.dir === 'spoke')
      .map((e) => e.text),
  );
  ok('spoke', spoken.map((t, i) => `output transcript ${i + 1}: "${t}"`).join('\n         '));

  // ── 9. did AUDIO actually flow, both ways? ──────────────────────────────
  const stats = await page.evaluate(() => window.__muxterm.voiceSession.stats());
  if (!(stats.inboundBytes > 0 && stats.inboundPackets > 0)) {
    throw new Error(
      'no inbound audio: a handshake alone is not proof. stats=' + JSON.stringify(stats),
    );
  }
  if (!(stats.outboundBytes > 0)) {
    throw new Error('no outbound audio was sent. stats=' + JSON.stringify(stats));
  }
  ok(
    'audio both ways',
    `out ${stats.outboundBytes} bytes / ${stats.outboundPackets} pkts · ` +
      `in ${stats.inboundBytes} bytes / ${stats.inboundPackets} pkts · ` +
      `${stats.playedSamples} samples rendered`,
  );

  // ── 10. did a real chief-of-staff action run, server-side? (C5) ─────────
  const trace = await waitForTrace(120_000);
  const calls = trace.filter((t) => t.kind === 'tool_call');
  const results = trace.filter((t) => t.kind === 'tool_result');
  if (calls.length === 0) {
    throw new Error(
      'no tool ran server-side. The model heard and spoke, but never reached the chief of staff.',
    );
  }
  if (results.length === 0) {
    throw new Error(
      'a tool was called but never answered: the bridge did not complete a round trip. trace=' +
        JSON.stringify(trace),
    );
  }
  ok(
    'C5 bridge',
    `${calls.length} tool call(s) executed SERVER-SIDE over the sideband and ${results.length} answered: ` +
      calls.map((c) => c.name).join(', ') +
      `\n         sideband trace: ${trace.map((t) => t.kind + (t.name ? `(${t.name})` : '') + (t.detail ? `[${t.detail}]` : '')).join(' → ')}`,
  );

  // ── 10b. the ASYNCHRONOUS path (C5) ─────────────────────────────────────
  //
  // This is the half that matters most, and the half that is hardest to
  // fake. A real chief-of-staff turn on claude-opus-5 with 28 tools takes
  // tens of seconds; the synchronous path gives up after ten and hands off.
  // What is asserted here is the hand-off actually completing: an `inject`
  // on the sideband — the late answer being written into the realtime
  // session as its own utterance — followed by the model speaking it.
  //
  // The blocking design would show neither. It would show one tool call
  // that never returned.
  const withInject = await waitForTraceKind('inject', 300_000);
  if (!withInject.some((t) => t.kind === 'inject')) {
    throw new Error(
      'the chief of staff never finished, so the asynchronous path was never exercised. trace=' +
        JSON.stringify(withInject),
    );
  }
  ok(
    'C5 async path',
    'the late answer was injected into the live session as its own utterance\n         ' +
      `full trace: ${withInject.map((t) => t.kind + (t.name ? `(${t.name})` : '')).join(' → ')}`,
  );

  // Specifically an utterance that STARTED AFTER the injection, so this
  // cannot be satisfied by the hand-off line the model said while waiting.
  const injectedAt = Date.parse(withInject.find((t) => t.kind === 'inject').at);
  await page.waitForFunction(
    (after) =>
      window.__muxterm.voiceSession.log().some((e) => e.dir === 'spoke' && e.at > after),
    injectedAt,
    { timeout: 180_000 },
  );
  const everySpoken = await page.evaluate(() =>
    window.__muxterm.voiceSession
      .log()
      .filter((e) => e.dir === 'spoke')
      .map((e) => e.text),
  );
  const afterInject = await page.evaluate(
    (after) =>
      window.__muxterm.voiceSession
        .log()
        .filter((e) => e.dir === 'spoke' && e.at > after)
        .map((e) => e.text),
    injectedAt,
  );
  ok(
    'C5 spoken answer',
    `spoken AFTER the chief of staff's answer was injected: "${afterInject[afterInject.length - 1]}"` +
      `\n         (${everySpoken.length} spoken turns in total)`,
  );

  // ── 11. the composer entry point (C4) ───────────────────────────────────
  const control = await page.evaluate(() => {
    // <mux-cos> lives inside <mux-app>'s shadow root, so a plain
    // document.querySelector finds nothing at all.
    const cos = document.querySelector('mux-app')?.shadowRoot?.querySelector('mux-cos');
    const btn = cos?.shadowRoot?.querySelector('.cbtn.voice');
    const send = cos?.shadowRoot?.querySelector('.cbtn.send');
    const orb = btn?.querySelector('mux-voice-orb');
    return {
      present: !!btn,
      sendPresent: !!send,
      state: btn?.getAttribute('data-voice-state') ?? null,
      orb: !!orb,
      orbStage: !!orb?.shadowRoot?.querySelector('.orb-stage'),
      orbLayers: orb?.shadowRoot?.querySelectorAll('.orb-tint').length ?? 0,
    };
  });
  if (!control.present) throw new Error('the composer shows no voice control with an empty draft');
  if (control.sendPresent) throw new Error('the send arrow is still present; the slot was not swapped');
  if (!control.orbStage) throw new Error('<mux-voice-orb> rendered no stage');
  ok(
    'C3+C4 control',
    `empty draft → voice control in the send slot (send arrow absent), ` +
      `orb live in state "${control.state}" with ${control.orbLayers} tint layers`,
  );

  // typing swaps it back
  const swapped = await page.evaluate(async () => {
    const cos = document.querySelector('mux-app')?.shadowRoot?.querySelector('mux-cos');
    const ta = cos?.shadowRoot?.querySelector('textarea.ctext');
    ta.value = 'hello';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    return {
      send: !!cos?.shadowRoot?.querySelector('.cbtn.send'),
      voice: !!cos?.shadowRoot?.querySelector('.cbtn.voice'),
    };
  });
  if (!swapped.send || swapped.voice) {
    throw new Error('typing did not swap the slot back to the send arrow: ' + JSON.stringify(swapped));
  }
  ok('C4 swap', 'text in the box → send arrow returns, voice control stands down');

  // ── 12. narration (C6) ──────────────────────────────────────────────────
  //
  // Fed through cos-store's own frame handler — the same one the WebSocket
  // calls — so every gate a real event passes, this one passes too. A
  // turn_start dated a minute ago is what clears the "say nothing for the
  // first few seconds" gate without waiting a minute.
  await page.evaluate(() => {
    const v = window.__muxterm.voiceSession;
    v.feedCosEvent({ ev: 'turn_start', turn_id: 'narr-1' });
    return new Promise((r) => setTimeout(r, 50));
  });
  await page.waitForTimeout(7000); // clear NARRATION_AFTER_MS honestly
  await page.evaluate(() => {
    window.__muxterm.voiceSession.feedCosEvent({
      ev: 'tool_start',
      turn_id: 'narr-1',
      name: 'bash',
      args: {},
    });
  });
  await page.waitForFunction(
    () => window.__muxterm.voiceSession.log().some((e) => e.text?.startsWith('narrate:tool_start')),
    null,
    { timeout: 20_000 },
  );
  ok('C6 narration', 'a tool_start on the sidecar stream became a spoken progress note');

  // ── 13. voice approvals, browser half (C7) ──────────────────────────────
  //
  // The DECISION is not made here and cannot be: the gate is server-side,
  // in the sideband, where an answer must survive a two-step confirmation
  // before anything is transmitted (see internal/voice/approvals.go and its
  // tests). What is proven here is that an approval_request reaches the
  // spoken channel at all.
  await page.evaluate(() => {
    window.__muxterm.voiceSession.feedCosEvent({
      ev: 'approval_request',
      request_id: 'req-e2e-1',
      tool: 'bash',
      detail: 'remove a temporary directory',
    });
  });
  await page.waitForFunction(
    () =>
      window.__muxterm.voiceSession.log().some((e) => e.text?.startsWith('narrate:approval_request')),
    null,
    { timeout: 20_000 },
  );
  ok('C7 spoken approval', 'an approval_request reached the voice channel to be read aloud');

  // ── 14. no credential leaked to the browser ─────────────────────────────
  const leak = await page.evaluate(async (tok) => {
    const hay = [
      document.documentElement.outerHTML,
      JSON.stringify(window.localStorage),
      JSON.stringify(window.sessionStorage),
    ].join('\n');
    return hay.includes(tok);
  }, token);
  if (leak) throw new Error('the long-lived credential reached the browser');
  ok('no leak', 'the Entra token appears nowhere in the page, storage, or DOM');

  if (consoleErrors.length) {
    note('console', consoleErrors.slice(0, 5).join(' | '));
  }

  report(true);
  await teardown();
}

// ── helpers ────────────────────────────────────────────────────────────────

function readKeysEnv(key) {
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.config/muxterm/keys.env'), 'utf8');
    const m = txt.match(new RegExp('^' + key + '=(.*)$', 'm'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function entraToken() {
  const { stdout } = await execFileAsync('az', [
    'account',
    'get-access-token',
    '--scope',
    'https://ai.azure.com/.default',
    '--query',
    'accessToken',
    '-o',
    'tsv',
  ]);
  const t = stdout.trim();
  if (!t) throw new Error('az returned no token — run `az login`');
  return t;
}

async function buildBinary() {
  // The frontend FIRST. muxterm embeds web/dist at compile time, so a Go
  // build over a stale dist serves a browser bundle that predates the change
  // under test — which presents as the page simply not having the feature.
  await execFileAsync('npx', ['vite', 'build'], {
    cwd: path.join(REPO, 'web'),
    maxBuffer: 32 << 20,
  });
  await execFileAsync('go', ['build', '-o', 'bin/muxterm', './cmd/muxterm'], {
    cwd: REPO,
    maxBuffer: 32 << 20,
  });
}

async function startServer({ runtimeDir, dataDir, configDir }) {
  const logPath = path.join(tmp, 'muxterm.log');
  const log = fs.openSync(logPath, 'a');
  const child = spawn(path.join(REPO, 'bin/muxterm'), ['serve', '--addr', `127.0.0.1:${PORT}`, '--no-auth'], {
    cwd: REPO,
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDir,
      XDG_DATA_HOME: dataDir,
      XDG_CONFIG_HOME: configDir,
      // A transcript of its own. The production chief of staff's session is
      // never opened by this run.
      MUXTERM_COS_SESSION_ID: 'muxterm-cos-voice-e2e',
      INVOCATION_ID: '',
    },
    stdio: ['ignore', log, log],
  });
  child.logPath = logPath;

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error('the server never came up. log:\n' + fs.readFileSync(logPath, 'utf8').slice(-2000));
    }
    await sleep(250);
  }
}

async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  const body = await res.text();
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

/**
 * Wait for a COMPLETED tool round trip, not merely a call.
 *
 * A tool_call alone proves the model asked. What proves the bridge works is
 * a tool_result: the request reached the chief of staff, ran, and its answer
 * was written back into the realtime session.
 */
async function waitForTraceKind(kind, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  for (;;) {
    const body = await fetchJSON(`${BASE}/api/cos/voice/trace`);
    last = body.traces ?? [];
    if (last.some((t) => t.kind === kind)) return last;
    if (Date.now() > deadline) return last;
    await sleep(2000);
  }
}

async function waitForTrace(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  for (;;) {
    const body = await fetchJSON(`${BASE}/api/cos/voice/trace`);
    last = body.traces ?? [];
    if (last.some((t) => t.kind === 'tool_result')) return last;
    if (Date.now() > deadline) return last;
    await sleep(1000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function teardown() {
  const done = [];
  if (browser) {
    await browser.close().catch(() => {});
    done.push('chromium closed');
  }
  if (proc) {
    proc.kill('SIGTERM');
    await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(5000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    done.push(`muxterm pid ${proc.pid} stopped`);
  }
  if (tmp && !KEEP) {
    fs.rmSync(tmp, { recursive: true, force: true });
    done.push(`${tmp} removed`);
  } else if (tmp) {
    done.push(`${tmp} KEPT (--keep)`);
  }
  console.log('\n\x1b[2mteardown: ' + done.join(' · ') + '\x1b[0m');
}

function banner() {
  console.log('\n\x1b[1mmuxterm realtime voice — automated end-to-end run\x1b[0m');
  console.log(`\x1b[2mendpoint ${ENDPOINT}\n model    ${MODEL}\n port     ${PORT}\x1b[0m\n`);
}

function ok(step, detail) {
  steps.push({ step, ok: true });
  console.log(`\x1b[32m  PASS\x1b[0m  ${step.padEnd(16)} ${detail}`);
}

function fail(step, detail) {
  steps.push({ step, ok: false });
  console.log(`\x1b[31m  FAIL\x1b[0m  ${step.padEnd(16)} ${detail}`);
}

function note(step, detail) {
  console.log(`\x1b[33m  NOTE\x1b[0m  ${step.padEnd(16)} ${detail}`);
}

function report(pass) {
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    '\n' +
      (pass
        ? `\x1b[32m\x1b[1mEND-TO-END PASS\x1b[0m — ${steps.length} checks in ${secs}s. ` +
          'Audio flowed in both directions and a real chief-of-staff action ran server-side.'
        : `\x1b[31m\x1b[1mEND-TO-END FAIL\x1b[0m — after ${secs}s.`),
  );
}
