#!/usr/bin/env node
/**
 * Runs the voice-orb transition evidence in a real browser and prints the
 * result. This is the harness behind the K1-K6 numbers in PR #75.
 *
 *   node docs/research/voice-orb-evidence.mjs
 *   node docs/research/voice-orb-evidence.mjs --json
 *   node docs/research/voice-orb-evidence.mjs --raw    # unreduced per-frame samples
 *
 * It opens docs/research/voice-orb-mock.html in headless Chrome, calls the
 * page's own window.__orbEvidence(), and reports what came back. The page
 * samples getComputedStyle every frame across all six transitions plus an
 * interrupt, so these are measured values from a live compositor — not the
 * engine's own arithmetic, and not an inspection of the CSS.
 *
 * Zero dependencies: Chrome DevTools Protocol over Node's built-in WebSocket.
 * Chrome runs against a throwaway user-data-dir and throwaway XDG dirs, and
 * everything is removed on exit.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, 'voice-orb-mock.html');
const JSON_OUT = process.argv.includes('--json');
const RAW_OUT = process.argv.includes('--raw');

const CHROME = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  .map((n) => ['/usr/bin/' + n, '/usr/local/bin/' + n])
  .flat()
  .find((p) => existsSync(p));

if (!CHROME) {
  console.error('no chrome/chromium found on PATH');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

/** Minimal CDP client: id-matched request/response over one WebSocket. */
function cdp(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let next = 1;
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e.message ?? 'unknown'))));
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = next++;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

let chrome = null;
let profile = null;
let xdg = null;

async function teardown() {
  if (chrome && !chrome.killed) {
    chrome.kill('SIGTERM');
    await sleep(300);
    if (!chrome.killed) chrome.kill('SIGKILL');
  }
  for (const d of [profile, xdg]) if (d) await rm(d, { recursive: true, force: true });
}

async function main() {
  const port = await freePort();
  profile = await mkdtemp(join(tmpdir(), 'orb-evidence-profile-'));
  xdg = await mkdtemp(join(tmpdir(), 'orb-evidence-xdg-'));

  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-size=1400,1000',
      '--no-sandbox',
      'about:blank',
    ],
    {
      stdio: 'ignore',
      // Throwaway XDG dirs: nothing this harness runs may touch the real
      // ~/.local/share, and in particular never muxterm's restore snapshot.
      env: { ...process.env, XDG_RUNTIME_DIR: xdg, XDG_DATA_HOME: xdg, XDG_CONFIG_HOME: xdg },
    },
  );

  // Wait for the debugging endpoint.
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(100);
    }
  }
  if (!version) throw new Error('chrome devtools endpoint never came up');

  const browser = cdp(version.webSocketDebuggerUrl);
  await browser.ready;
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.id === targetId);
  if (!target) throw new Error('page target not found');

  const page = cdp(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: pathToFileURL(PAGE).href });

  // Wait for the engine to exist and the rAF loop to be running.
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(100);
    const r = await page.send('Runtime.evaluate', {
      expression: 'typeof window.__orbEvidence === "function" && !!window.__orb',
      returnByValue: true,
    });
    up = r.result.value === true;
  }
  if (!up) throw new Error('page never finished loading __orbEvidence');
  await sleep(600); // let the oscillators settle into a steady state

  if (RAW_OUT) {
    const code = await rawDump(page);
    page.close();
    browser.close();
    return code;
  }

  const r = await page.send('Runtime.evaluate', {
    expression: 'window.__orbEvidence()',
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000,
  });
  if (r.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails));

  const { text, results } = r.result.value;
  const failed = results.some((row) => Object.values(row.checks).some((c) => !c.ok));

  if (JSON_OUT) console.log(JSON.stringify(results, null, 2));
  else {
    console.log(`chrome: ${version.Browser}`);
    console.log(`page:   ${PAGE}`);
    console.log('');
    console.log(text);
  }

  page.close();
  browser.close();
  return failed ? 1 : 0;
}

/**
 * Prints the unreduced per-frame series: what getComputedStyle and
 * getBoundingClientRect actually returned on each frame of a transition.
 */
async function rawDump(page) {
  const specs = [
    { title: 'T4  speaking -> listening   (the transition under complaint)',
      spec: { from: 'speaking', to: 'listening' } },
    { title: 'K3  speaking -> listening, INTERRUPTED by thinking at 140ms',
      spec: { from: 'speaking', to: 'listening', interruptWith: 'thinking', interruptAfter: 140, ms: 640 } },
  ];
  let bad = 0;
  for (const { title, spec } of specs) {
    const r = await page.send('Runtime.evaluate', {
      expression: `window.__orbRawSamples(${JSON.stringify(spec)})`,
      awaitPromise: true, returnByValue: true, timeout: 60000,
    });
    if (r.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails));
    const { endpoints, rows, spec: got } = r.result.value;

    console.log('');
    console.log('='.repeat(96));
    console.log(title);
    console.log('='.repeat(96));
    console.log(`glow      ${endpoints.glow_from.toFixed(4)} -> ${endpoints.glow_to.toFixed(4)}` +
                `      K2 interval: every sample must lie inside ` +
                `[${Math.min(endpoints.glow_from, endpoints.glow_to).toFixed(4)}, ` +
                `${Math.max(endpoints.glow_from, endpoints.glow_to).toFixed(4)}]`);
    console.log(`rect band ${endpoints.rect_band.toFixed(4)}      (achievable range of the rendered box across both states)`);
    if (got.interruptWith) console.log(`interrupt fired at ${got.firedAt.toFixed(1)}ms -> ${got.interruptWith}`);
    console.log('');
    console.log('    ms   phase           rect      d(rect)     glow     d(glow)   tint[from] tint[to]   colour(r,g,b)      K2');
    console.log('  ' + '-'.repeat(94));

    let prev = null;
    const lo = Math.min(endpoints.glow_from, endpoints.glow_to) - 0.002;
    const hi = Math.max(endpoints.glow_from, endpoints.glow_to) + 0.002;
    for (const row of rows) {
      const dRect = prev ? row.rect - prev.rect : null;
      const dGlow = prev ? row.glow - prev.glow : null;
      const inBand = got.interruptWith ? '-' : (row.glow >= lo && row.glow <= hi ? 'ok' : 'OUT');
      if (inBand === 'OUT') bad++;
      const seam = got.firedAt != null && prev && prev.phase === 'transition' && row.phase === 'post-interrupt';
      console.log(
        '  ' + (row.ms == null ? '  --' : row.ms.toFixed(1).padStart(6)) +
        '   ' + row.phase.padEnd(15) +
        row.rect.toFixed(5).padStart(8) +
        (dRect == null ? '        --' : (dRect >= 0 ? '  +' : '  ') + dRect.toFixed(5)).padStart(11) +
        row.glow.toFixed(5).padStart(10) +
        (dGlow == null ? '       --' : (dGlow >= 0 ? '  +' : '  ') + dGlow.toFixed(5)).padStart(11) +
        row.tintFrom.toFixed(4).padStart(11) + row.tintTo.toFixed(4).padStart(9) +
        '   ' + row.colour.map(c => Math.round(c).toString().padStart(3)).join(',') +
        '   ' + inBand + (seam ? '   <-- SEAM: state changed on this frame' : ''));
      prev = row;
    }
  }
  console.log('');
  console.log(bad === 0
    ? 'K2: 0 samples outside the interval between the two states.'
    : `K2: ${bad} samples OUTSIDE the interval.`);
  return bad === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error('evidence run failed:', e.message);
  code = 2;
} finally {
  await teardown();
}
process.exit(code);
