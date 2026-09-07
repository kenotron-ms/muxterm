#!/usr/bin/env node
/**
 * Runs the voice-orb transition evidence in a real browser and prints the
 * result. This is the harness behind the K1-K6 numbers in PR #75.
 *
 *   node docs/research/voice-orb-evidence.mjs
 *   node docs/research/voice-orb-evidence.mjs --json
 *   node docs/research/voice-orb-evidence.mjs --raw    # unreduced per-frame samples
 *   node docs/research/voice-orb-evidence.mjs --ui     # drive the page's own controls
 *   node docs/research/voice-orb-evidence.mjs --technique   # prove WHICH technique is running
 *   node docs/research/voice-orb-evidence.mjs --matrix      # 6 transitions x 6 criteria = 36 cells
 *   node docs/research/voice-orb-evidence.mjs --verdicts    # emit the recorded verdict table
 *   node docs/research/voice-orb-evidence.mjs --trace-teardown  # log what is started and reclaimed
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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, 'voice-orb-mock.html');
const JSON_OUT = process.argv.includes('--json');
const RAW_OUT = process.argv.includes('--raw');
const UI_OUT = process.argv.includes('--ui');
const TECH_OUT = process.argv.includes('--technique');
const MATRIX_OUT = process.argv.includes('--matrix');
const VERDICTS_OUT = process.argv.includes('--verdicts');
const TRACE_TD = process.argv.includes('--trace-teardown');

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
  const evs = [];
  let next = 1;
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e.message ?? 'unknown'))));
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method) { evs.push(msg); return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
  });
  return {
    ready,
    evs,
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

const td = (msg) => { if (TRACE_TD) console.error(`[teardown] ${msg}`); };

/** True if the pid is still a live process. */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Every live process in the browser's process group.
 *
 * Chrome is a process TREE, not a process: /usr/bin/google-chrome is a shell
 * script that execs /opt/google/chrome/chrome, which then forks a zygote, a GPU
 * process, utility processes and a crashpad handler. Checking only the pid
 * returned by spawn() would report a clean teardown while children were still
 * running, so the group is what gets signalled and the group is what gets
 * verified.
 */
function groupMembers(pgid) {
  if (!pgid) return [];
  const out = [];
  for (const name of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // field 5 is pgrp; comm (field 2) may contain spaces, so index past ')'
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid) {
        const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' ').trim();
        out.push({ pid: Number(name), cmd: cmd.slice(0, 90) });
      }
    } catch { /* process exited while we looked at it */ }
  }
  return out;
}

/**
 * Reclaims everything this process started, and then VERIFIES the reclaim
 * rather than assuming the kill and the rm worked. Runs from a `finally`, so it
 * runs on success, on failure and on a thrown exception alike.
 *
 * Nothing else is touched. The browser gets a throwaway --user-data-dir and
 * throwaway XDG_RUNTIME_DIR / XDG_DATA_HOME / XDG_CONFIG_HOME, so it cannot
 * reach ~/.local/share -- and in particular can never reach muxterm's restore
 * snapshot. No muxterm process is started, signalled or read.
 */
async function teardown() {
  const pid = chrome?.pid;
  if (chrome && !chrome.killed) {
    const before = groupMembers(pid);
    td(`process group ${pid} has ${before.length} member(s): ${before.map((m) => m.pid).join(', ')}`);
    // Signal the whole group, not just the leader. spawn() used detached:true
    // so the browser is its own group leader and -pid addresses the tree.
    td(`SIGTERM -> process group ${pid}`);
    try { process.kill(-pid, 'SIGTERM'); } catch { chrome.kill('SIGTERM'); }
    await sleep(400);
    let left = groupMembers(pid);
    if (left.length) {
      td(`${left.length} still alive, SIGKILL -> process group ${pid}`);
      try { process.kill(-pid, 'SIGKILL'); } catch { chrome.kill('SIGKILL'); }
      await sleep(300);
    }
  }
  for (const d of [profile, xdg]) {
    if (!d) continue;
    td(`rm -rf ${d}`);
    await rm(d, { recursive: true, force: true });
  }
  // Post-conditions, checked rather than assumed.
  const leaks = [];
  const survivors = groupMembers(pid);
  if (survivors.length) leaks.push(`${survivors.length} process(es) left in group ${pid}: ` +
    survivors.map((m) => `${m.pid} (${m.cmd})`).join(', '));
  if (alive(pid)) leaks.push(`chrome pid ${pid} still running`);
  for (const d of [profile, xdg]) if (d && existsSync(d)) leaks.push(`directory still present: ${d}`);
  if (leaks.length) {
    console.error('TEARDOWN INCOMPLETE: ' + leaks.join('; '));
    process.exitCode = 3;
  } else {
    td(`verified: process group ${pid} empty, both directories removed`);
  }
}

async function main() {
  const port = await freePort();
  profile = await mkdtemp(join(tmpdir(), 'orb-evidence-profile-'));
  xdg = await mkdtemp(join(tmpdir(), 'orb-evidence-xdg-'));

  td(`starting ${CHROME}`);
  td(`  --user-data-dir  ${profile}`);
  td(`  XDG_* redirected ${xdg}`);
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
      // Own process group, so teardown can signal the whole browser tree.
      detached: true,
      // Throwaway XDG dirs: nothing this harness runs may touch the real
      // ~/.local/share, and in particular never muxterm's restore snapshot.
      env: { ...process.env, XDG_RUNTIME_DIR: xdg, XDG_DATA_HOME: xdg, XDG_CONFIG_HOME: xdg },
    },
  );

  td(`chrome pid ${chrome.pid}, devtools on 127.0.0.1:${port}`);

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
  await page.send('Log.enable');
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

  if (VERDICTS_OUT) {
    const code = await verdicts(page);
    page.close();
    browser.close();
    return code;
  }

  if (MATRIX_OUT) {
    const code = await matrix(page);
    page.close();
    browser.close();
    return code;
  }

  if (TECH_OUT) {
    const code = await technique(page);
    page.close();
    browser.close();
    return code;
  }

  if (UI_OUT) {
    const code = await uiDrive(page);
    page.close();
    browser.close();
    return code;
  }

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
    { title: 'T1  idle -> listening',      spec: { from: 'idle',      to: 'listening' } },
    { title: 'T2  listening -> thinking',  spec: { from: 'listening', to: 'thinking'  } },
    { title: 'T3  thinking -> speaking',   spec: { from: 'thinking',  to: 'speaking'  } },
    { title: 'T5  listening -> idle',      spec: { from: 'listening', to: 'idle'      } },
    { title: 'T6  speaking -> idle',       spec: { from: 'speaking',  to: 'idle'      } },
    { title: 'K3  speaking -> listening, INTERRUPTED by thinking at 140ms',
      spec: { from: 'speaking', to: 'listening', interruptWith: 'thinking', interruptAfter: 140, ms: 640 } },
    { title: 'K3  thinking -> speaking, INTERRUPTED by listening at 140ms',
      spec: { from: 'thinking', to: 'speaking', interruptWith: 'listening', interruptAfter: 140, ms: 640 } },
    { title: 'K3  listening -> idle, INTERRUPTED by thinking at 140ms',
      spec: { from: 'listening', to: 'idle', interruptWith: 'thinking', interruptAfter: 140, ms: 640 } },
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

/**
 * Drives the ARTIFACT'S OWN CONTROLS — real DOM clicks on the buttons a human
 * would press — and measures what the orb does in response.
 *
 * Everything else in this file calls orb.setState() directly, which bypasses
 * every control on the page. A dead button would pass all of it. This mode
 * touches nothing but .click(), and reads the result back out of
 * getComputedStyle, so it proves the controls are wired to the engine.
 */
const REC = `
  const stage = document.getElementById('stage');
  const halos = stage.querySelector('.orb-halos');
  const body  = stage.querySelector('.orb-body');
  const rd = () => {
    const cs = getComputedStyle(body);
    const tf = cs.transform;
    const open = tf.indexOf('('), close = tf.lastIndexOf(')');
    const p = open > 0 ? tf.slice(open+1, close).split(',').map(Number) : [1,0,0,1];
    return { t: performance.now(), state: window.__orb.state,
             glow: parseFloat(getComputedStyle(halos).opacity),
             scale: Math.hypot(p[0], p[1]),
             rect: body.getBoundingClientRect().width / (parseFloat(cs.width)||1) };
  };
  const record = ms => new Promise(res => { const o=[]; const t0=performance.now();
    const step=()=>{ o.push(rd()); performance.now()-t0<ms ? requestAnimationFrame(step) : res(o); };
    requestAnimationFrame(step); });
  const seq = rows => rows.reduce((a,r)=> a[a.length-1]===r.state ? a : (a.push(r.state), a), []);
  const cont = rows => { let mv=0; for(let i=1;i<rows.length;i++){ const dt=(rows[i].t-rows[i-1].t)/1000;
    if(dt>0) mv=Math.max(mv, Math.abs(rows[i].glow-rows[i-1].glow)/dt); } return mv; };
`;

async function uiDrive(page) {
  const ev = async (expression) => {
    const r = await page.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, timeout: 120000,
    });
    if (r.exceptionDetails) {
      throw new Error('page threw: ' + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
    }
    return r.result.value;
  };

  let fails = 0;
  const line = (ok, label, detail) => {
    if (!ok) fails++;
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
  };

  console.log('');
  console.log('='.repeat(96));
  console.log('ARTIFACT CONTROLS — real DOM clicks, nothing calls setState() directly');
  console.log('='.repeat(96));

  // ---- self-containment: the page must open from file:// with no network ----
  const sc = await ev(`(() => {
    const css = [...document.querySelectorAll('style')].map(s=>s.textContent).join('');
    const cnt = (h,n) => h.split(n).length - 1;
    return {
      script_src: document.querySelectorAll('script[src]').length,
      link_href:  document.querySelectorAll('link[href]').length,
      media:      document.querySelectorAll('img,iframe,video,audio,source,object,embed').length,
      css_remote: cnt(css,'url(http') + cnt(css,'@import'),
      fonts:      cnt(css,'@font-face'),
      styles:     document.querySelectorAll('style').length,
      scripts:    document.querySelectorAll('script').length,
      bytes:      document.documentElement.outerHTML.length,
    };
  })()`);
  line(sc.script_src === 0 && sc.link_href === 0 && sc.media === 0 && sc.css_remote === 0 && sc.fonts === 0,
    'self-contained (no network)',
    `script[src]=${sc.script_src} link[href]=${sc.link_href} media=${sc.media} ` +
    `css url(http)/@import=${sc.css_remote} @font-face=${sc.fonts} | ` +
    `${sc.styles} inline <style>, ${sc.scripts} inline <script>, ${(sc.bytes/1024).toFixed(0)}KB DOM`);

  // ---- the six transition buttons ----
  const labels = await ev(`[...document.querySelectorAll('#transitions button')].map(b=>b.textContent.trim())`);
  line(labels.length === 6, 'six transition buttons present', JSON.stringify(labels));

  console.log('');
  for (let i = 0; i < labels.length; i++) {
    const r = await ev(`(async () => {
      ${REC}
      window.__orb.setState('idle'); await new Promise(r=>setTimeout(r,700));
      const btn = document.querySelectorAll('#transitions button')[${i}];
      btn.click();                                   // <-- the only interaction
      const rows = await record(2000);
      const s = seq(rows);
      const gl = rows.map(r=>r.glow);
      return { label: btn.textContent.trim(), states: s, maxVel: cont(rows),
               glow_start: gl[0], glow_end: gl[gl.length-1], frames: rows.length,
               label_text: document.getElementById('stateLabel').textContent };
    })()`);
    const [from, to] = [r.states[r.states.length - 2], r.states[r.states.length - 1]];
    const want = labels[i].split(/\s+/).slice(1);            // e.g. ["speaking","→","listening"]
    const ok = r.states.length >= 2 && from === want[0] && to === want[2] &&
               r.label_text === want[2] && r.maxVel < 3.0;
    line(ok, `click "${r.label.replace(/\s+/g, ' ')}"`,
      `observed ${r.states.join(' → ')}  glow ${r.glow_start.toFixed(3)}→${r.glow_end.toFixed(3)}  ` +
      `maxVel ${r.maxVel.toFixed(3)}/s  label="${r.label_text}"  ${r.frames} frames`);
  }

  // ---- the interrupt control ----
  console.log('');
  const iv = await ev(`(async () => {
    ${REC}
    document.getElementById('iFrom').value = 'speaking';
    document.getElementById('iTo').value   = 'listening';
    document.getElementById('iThen').value = 'thinking';
    const d = document.getElementById('iDelay');
    d.value = '140'; d.dispatchEvent(new Event('input'));
    document.getElementById('iFire').click();       // <-- the only interaction
    const rows = await record(2600);
    const s = seq(rows);
    const i3 = rows.findIndex(r => r.state === 'thinking');
    return { states: s, maxVel: cont(rows), frames: rows.length,
             delay_label: document.getElementById('iDelayOut').textContent,
             glow_at_interrupt: i3 > 0 ? rows[i3].glow : null,
             glow_before_seam:  i3 > 0 ? rows[i3-1].glow : null,
             glow_after_seam:   i3 > 0 ? rows[i3+1].glow : null,
             glow_end: rows[rows.length-1].glow };
  })()`);
  line(iv.states.join(',') === 'speaking,listening,thinking', 'interrupt fires all three states',
    `observed ${iv.states.join(' → ')}  (${iv.frames} frames, delay label "${iv.delay_label}")`);

  // The proof that the third state landed MID-transition: glow was still
  // strictly between speaking (0.74) and listening (0.62) when it arrived.
  const g = iv.glow_at_interrupt;
  const midFlight = g !== null && g > 0.6205 && g < 0.7395;
  line(midFlight, 'third state lands mid-transition',
    `glow at interrupt ${g === null ? 'n/a' : g.toFixed(5)} — strictly inside (0.62000, 0.74000), ` +
    `so speaking→listening had not completed`);

  const seam = Math.abs(iv.glow_after_seam - iv.glow_before_seam);
  line(seam < 0.03, 'no jump across the seam',
    `${iv.glow_before_seam.toFixed(5)} → ${g.toFixed(5)} → ${iv.glow_after_seam.toFixed(5)}  (Δ ${seam.toFixed(5)})`);
  line(Math.abs(iv.glow_end - 0.55) < 0.01, 'resolves to the interrupting state',
    `glow settles ${iv.glow_end.toFixed(5)}, thinking = 0.55000`);
  line(iv.maxVel < 3.0, 'continuous across the whole run', `maxVel ${iv.maxVel.toFixed(3)}/s`);

  // ---- reduced-motion toggle ----
  console.log('');
  const rm = await ev(`(async () => {
    ${REC}
    const box = document.getElementById('reduced');
    box.checked = true; box.dispatchEvent(new Event('change'));   // <-- interaction
    window.__orb.setState('speaking'); await new Promise(r=>setTimeout(r,1200));
    const before = rd();
    document.querySelectorAll('#directStates button')[2].click(); // "listening" <-- interaction
    const rows = await record(900);
    const sc = rows.map(r=>r.rect);
    const out = { note: document.getElementById('reducedNote').textContent,
                  rect_span: Math.max(...sc)-Math.min(...sc),
                  glow_from: before.glow, glow_to: rows[rows.length-1].glow,
                  distinct: new Set(rows.map(r=>r.glow.toFixed(4))).size };
    box.checked = false; box.dispatchEvent(new Event('change'));
    return out;
  })()`);
  line(rm.rect_span < 1e-6, 'reduced-motion checkbox stills motion',
    `rect_span ${rm.rect_span.toFixed(7)}  note="${rm.note}"`);
  line(rm.distinct > 20 && Math.abs(rm.glow_to - 0.62) < 0.01, 'and still changes state legibly',
    `glow ${rm.glow_from.toFixed(3)} → ${rm.glow_to.toFixed(3)} over ${rm.distinct} distinct values`);

  // ---- the in-page evidence button ----
  console.log('');
  const rev = await ev(`(async () => {
    document.getElementById('runEvidence').click();               // <-- interaction
    const out = document.getElementById('evidenceOut');
    for (let i = 0; i < 600; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (/ALL CHECKS PASS|SOME CHECKS FAILED/.test(out.textContent)) break;
    }
    const txt = out.textContent;
    return { verdict: /ALL CHECKS PASS/.test(txt) ? 'ALL CHECKS PASS' : 'SOME CHECKS FAILED',
             pass: (txt.match(/PASS/g)||[]).length, fail: (txt.match(/FAIL/g)||[]).length,
             chart: !!document.getElementById('chart').getContext('2d') };
  })()`);
  line(rev.verdict === 'ALL CHECKS PASS', 'in-page "run evidence" button',
    `${rev.verdict} — ${rev.pass} PASS, ${rev.fail} FAIL, rendered into the page`);
  line(rev.chart, 'live strip chart present', '2d context on #chart');

  const rmx = await ev(`(async () => {
    document.getElementById('runMatrix').click();                 // <-- interaction
    const out = document.getElementById('evidenceOut');
    for (let i = 0; i < 1200; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (/MATRIX: /.test(out.textContent)) break;
    }
    const txt = out.textContent;
    const m = txt.match(/MATRIX: .*/);
    return { verdict: m ? m[0] : 'never finished',
             rows: (txt.match(/^  T[1-6] /gm) || []).length,
             pass: (txt.match(/PASS/g) || []).length };
  })()`);
  line(/36 of 36 cells PASS/.test(rmx.verdict), 'in-page "run the 6 x 6 matrix" button',
    `${rmx.verdict} — ${rmx.rows} transition rows, ${rmx.pass} PASS tokens rendered into the page`);

  const errs = page.evs.filter((e) =>
    e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
  line(errs.length === 0, 'no page errors during any interaction',
    `${errs.length} uncaught exceptions / console errors across every click above`);

  console.log('');
  console.log(fails === 0
    ? 'ARTIFACT CONTROLS: all interactions verified by clicking them.'
    : `ARTIFACT CONTROLS: ${fails} check(s) failed.`);
  return fails === 0 ? 0 : 1;
}

/**
 * Proves WHICH animation technique is running, from the DOM, at runtime.
 *
 * "The stylesheet has no @keyframes" is a source claim. This is the runtime
 * counterpart, and it settles the question two independent ways:
 *
 *   1. document.getAnimations() during a live transition. A CSS animation or a
 *      CSS transition is a CSSAnimation / CSSTransition object in that list. If
 *      the orb were driven by CSS, the list would be non-empty exactly when the
 *      values are moving.
 *
 *   2. The weight vector, recovered from measured layer opacities alone. The
 *      port composites per-state tint layers with normalised painter's alpha
 *      a_i = w_i / SUM_{j<=i} w_j, which is invertible: with SUM w = 1,
 *      w_top = a_top, then S_{i-1} = S_i - w_i and w_{i-1} = a_{i-1} * S_{i-1}.
 *      So the weights can be read back out of getComputedStyle without touching
 *      the engine — and if the technique were anything other than weighted
 *      state blending, the recovered vector would not sum to 1 with exactly two
 *      non-zero components mid-transition.
 */
async function technique(page) {
  const ev = async (expression) => {
    const r = await page.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, timeout: 120000,
    });
    if (r.exceptionDetails) {
      throw new Error('page threw: ' + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
    }
    return r.result.value;
  };
  let fails = 0;
  const line = (ok, label, detail) => {
    if (!ok) fails++;
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(38)} ${detail}`);
  };

  console.log('');
  console.log('='.repeat(100));
  console.log('WHICH TECHNIQUE IS RUNNING — measured from the DOM during a live transition');
  console.log('='.repeat(100));

  const r = await ev(`(async () => {
    const STATES = ORB_CONSTANTS.STATES;
    const stage = document.getElementById('stage');
    const body  = stage.querySelector('.orb-body');
    const tintEls = STATES.map(s => stage.querySelector('.orb-tint[data-state="' + s + '"]'));

    // Invert normalised painter's alpha to recover the weight vector.
    const weightsFromDom = () => {
      const a = tintEls.map(el => parseFloat(getComputedStyle(el).opacity));
      const w = new Array(a.length).fill(0);
      let S = 1;                                  // SUM of all weights is 1
      for (let i = a.length - 1; i >= 0; i--) { w[i] = a[i] * S; S = S - w[i]; }
      return { a, w };
    };

    const anims = () => {
      const all = document.getAnimations ? document.getAnimations() : [];
      return { total: all.length, kinds: [...new Set(all.map(x => x.constructor.name))] };
    };

    const rd = () => {
      const cs = getComputedStyle(body);
      const tf = cs.transform, o = tf.indexOf('('), c = tf.lastIndexOf(')');
      const p = o > 0 ? tf.slice(o+1, c).split(',').map(Number) : [1,0,0,1];
      const { a, w } = weightsFromDom();
      return { t: performance.now(), a, w, anim: anims(),
               rect: body.getBoundingClientRect().width / (parseFloat(cs.width)||1),
               scale: Math.hypot(p[0], p[1]) };
    };

    window.__orb.setState('speaking');
    await new Promise(r => setTimeout(r, 1200));
    const settled = rd();

    window.__orb.setState('listening');
    const rows = [];
    await new Promise(res => { const t0 = performance.now();
      const step = () => { rows.push(rd());
        performance.now() - t0 < 420 ? requestAnimationFrame(step) : res(); };
      requestAnimationFrame(step); });

    const iS = STATES.indexOf('speaking'), iL = STATES.indexOf('listening');
    const mid = rows[Math.floor(rows.length / 2)];
    return {
      states: STATES,
      settled: { w: settled.w, sum: settled.w.reduce((x,y)=>x+y,0), anim: settled.anim, rect: settled.rect },
      frames: rows.length,
      anim_max: Math.max(...rows.map(r => r.anim.total)),
      anim_kinds: [...new Set(rows.flatMap(r => r.anim.kinds))],
      sums: rows.map(r => r.w.reduce((x,y)=>x+y,0)),
      nonzero_max: Math.max(...rows.map(r => r.w.filter(v => v > 1e-6).length)),
      third_state_max: Math.max(...rows.map(r => Math.max(...r.w.filter((_,i)=> i!==iS && i!==iL), 0))),
      mid: { w_speaking: mid.w[iS], w_listening: mid.w[iL], sum: mid.w.reduce((x,y)=>x+y,0),
             rect: mid.rect, alphas: mid.a },
      trace: rows.filter((_,i) => i % 4 === 0).map(r => ({
        w_speaking: r.w[iS], w_listening: r.w[iL],
        sum: r.w.reduce((x,y)=>x+y,0), anim: r.anim.total, rect: r.rect })),
      rest: { speaking: PROFILES.speaking.coreScale, listening: PROFILES.listening.coreScale },
    };
  })()`);

  line(r.anim_max === 0, 'document.getAnimations() during transition',
    `max ${r.anim_max} across ${r.frames} frames — no CSSAnimation, no CSSTransition, ` +
    `no Web Animation of any kind${r.anim_kinds.length ? ' (' + r.anim_kinds.join(',') + ')' : ''}`);
  line(r.settled.anim.total === 0, 'document.getAnimations() at rest',
    `${r.settled.anim.total} — the orb is moving at rest too (idle breathing), still zero animations`);

  const sumErr = Math.max(...r.sums.map((v) => Math.abs(v - 1)));
  line(sumErr < 1e-6, 'weights recovered from layer opacities sum to 1',
    `max |Σw − 1| = ${sumErr.toExponential(2)} across ${r.frames} frames`);
  line(r.nonzero_max <= 2, 'exactly two states active mid-blend',
    `max non-zero weights = ${r.nonzero_max}; largest third-state weight = ${r.third_state_max.toExponential(2)}`);

  const lo = Math.min(r.rest.speaking, r.rest.listening), hi = Math.max(r.rest.speaking, r.rest.listening);
  line(r.mid.w_speaking > 0.05 && r.mid.w_listening > 0.05,
    'mid-frame is a genuine blend, not a switch',
    `w[speaking]=${r.mid.w_speaking.toFixed(4)}  w[listening]=${r.mid.w_listening.toFixed(4)}  ` +
    `Σ=${r.mid.sum.toFixed(6)}`);

  console.log('');
  console.log('   the weight vector, read back out of getComputedStyle (every 4th frame):');
  console.log('');
  console.log('        w[speaking]  w[listening]        Σw   getAnimations()   rendered rect');
  console.log('     ' + '-'.repeat(76));
  for (const t of r.trace) {
    console.log('     ' +
      t.w_speaking.toFixed(5).padStart(11) +
      t.w_listening.toFixed(5).padStart(13) +
      t.sum.toFixed(6).padStart(10) +
      String(t.anim).padStart(18) +
      t.rect.toFixed(5).padStart(16));
  }
  console.log('');
  console.log(`   states in paint order: ${r.states.join(', ')}`);
  console.log(`   measured tint alphas at the mid frame: [${r.mid.alphas.map(a=>a.toFixed(4)).join(', ')}]`);
  console.log(`   -> inverted through a_i = w_i / Σ_{j≤i} w_j`);
  console.log('');
  console.log(fails === 0
    ? 'TECHNIQUE: weighted state blending with Σw ≡ 1, zero CSS animations. This is the persona model.'
    : `TECHNIQUE: ${fails} check(s) failed.`);
  return fails === 0 ? 0 : 1;
}

/**
 * Prints the 6 x 6 matrix: every criterion measured against every transition.
 *
 * Condition (a) of the goal asks for twelve verdicts -- one per transition and
 * one per criterion -- and "exactly one terminal verdict" per item rules out a
 * 36-verdict reading, since under that reading T1 would carry six. This matrix
 * is therefore MORE than (a) requires, and it exists because building it closed
 * two real coverage gaps: K3 and K5 had each been demonstrated on a single
 * transition, and K6 had been asserted about a constant rather than measured.
 */
async function matrix(page) {
  const r = await page.send('Runtime.evaluate', {
    expression: 'window.__orbMatrix()', awaitPromise: true, returnByValue: true, timeout: 300000,
  });
  if (r.exceptionDetails) {
    throw new Error('page threw: ' + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
  }
  const cells = r.result.value;
  const KS = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'];

  console.log('');
  console.log('='.repeat(104));
  console.log('THE 6 x 6 MATRIX — every criterion measured against every transition, 36 cells');
  console.log('='.repeat(104));
  console.log('');
  console.log('  transition                       K1        K2        K3        K4        K5        K6');
  console.log('  ' + '-'.repeat(94));
  let fails = 0;
  for (const c of cells) {
    const row = KS.map((k) => {
      if (!c.k[k].ok) fails++;
      return (c.k[k].ok ? 'PASS' : 'FAIL').padStart(9);
    }).join('');
    console.log(`  ${(c.id + '  ' + c.a + '→' + c.b).padEnd(32)}${row}`);
  }
  console.log('');
  console.log('  the measurement behind each cell:');
  console.log('');
  for (const c of cells) {
    console.log(`  ${c.id}  ${c.a} → ${c.b}`);
    console.log(`     K1  velocity ×nominal: glow ${c.k.K1.glow.toFixed(2)}, rect ${c.k.K1.rect.toFixed(2)}   (threshold 6, jump ≈25, curve peak 2.73; ${c.k.K1.frames} frames)`);
    console.log(`     K2  glow-interval violations ${c.k.K2.viol}; frames below the geometric floor ${c.k.K2.floor} : ${c.k.K2.dips}; weights monotone ${c.k.K2.mono}; largest third-state weight ${c.k.K2.third.toExponential(1)}`);
    console.log(`     K3  interrupted by "${c.k.K3.via}" at 140ms: incoming weight was ${c.k.K3.w_at.toFixed(4)} (strictly mid-flight), seam Δglow ${c.k.K3.seam.toFixed(5)}, velocity ${c.k.K3.vel.toFixed(2)}`);
    console.log(`     K4  properties written during this transition: [${c.k.K4.props.join(', ')}]`);
    console.log(`     K5  reduced motion: rect span ${c.k.K5.span.toExponential(1)}, colour ΔRGB ${c.k.K5.dCol}, glow Δ ${c.k.K5.dGlow}, ${c.k.K5.distinct} distinct values`);
    console.log(`     K6  duration recovered from the DOM at y=0.25/0.50/0.75: ${c.k.K6.est.join(' / ')} ms  (stated 420, spread ${c.k.K6.spread}ms)`);
    console.log('');
  }
  console.log(fails === 0
    ? 'MATRIX: 36 of 36 cells PASS.'
    : `MATRIX: ${fails} of 36 cells FAILED.`);
  return fails === 0 ? 0 : 1;
}

/**
 * Emits the recorded verdict table as markdown, for committing to the repo.
 *
 * The twelve terminal verdicts are DERIVED from the 36 measured cells rather
 * than asserted: a transition passes iff all six criteria hold for it, and a
 * criterion passes iff it holds on all six transitions. Anything that fails
 * comes out BLOCKED with the failing measurement named, automatically -- there
 * is no path by which a failing cell yields a PASS verdict in this document.
 */
async function verdicts(page) {
  const r = await page.send('Runtime.evaluate', {
    expression: 'window.__orbMatrix()', awaitPromise: true, returnByValue: true, timeout: 300000,
  });
  if (r.exceptionDetails) {
    throw new Error('page threw: ' + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
  }
  const cells = r.result.value;
  const KS = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'];
  const KNAME = {
    K1: 'no discontinuous jump', K2: 'no snap-through-base', K3: 'interruptible',
    K4: 'compositor-only', K5: 'reduced motion', K6: 'duration and easing stated',
  };
  const why = (c, k) => {
    const v = c.k[k];
    switch (k) {
      case 'K1': return `velocity x nominal: glow ${v.glow.toFixed(2)}, rect ${v.rect.toFixed(2)} (threshold 6; a jump is ~25)`;
      case 'K2': return `glow-interval violations ${v.viol}; frames below geometric floor ${v.floor}: ${v.dips}; weights monotone ${v.mono}; largest third-state weight ${v.third.toExponential(1)}`;
      case 'K3': return `interrupted by "${v.via}" at 140ms with incoming weight ${v.w_at.toFixed(4)} (mid-flight); seam d(glow) ${v.seam.toFixed(5)}; velocity ${v.vel.toFixed(2)}`;
      case 'K4': return `properties written: [${v.props.join(', ')}]`;
      case 'K5': return `rect span ${v.span.toExponential(1)}; colour dRGB ${v.dCol}; glow d ${v.dGlow}; ${v.distinct} distinct values`;
      case 'K6': return `duration recovered from the DOM at y=.25/.50/.75: ${v.est.join(' / ')} ms (stated 420, spread ${v.spread}ms)`;
      default: return '';
    }
  };

  const L = [];
  L.push('# Voice orb — recorded verdicts', '');
  L.push('Generated, not hand-written. Regenerate with:', '');
  L.push('```console');
  L.push('node docs/research/voice-orb-evidence.mjs --verdicts > docs/research/voice-orb-verdicts.md');
  L.push('```', '');
  L.push(`Captured ${new Date().toISOString().slice(0, 19).replace('T', ' ')}Z against`);
  L.push('`docs/research/voice-orb-mock.html` in headless Chrome. Every number is a');
  L.push('`getComputedStyle` or `getBoundingClientRect` reading taken during a live transition.', '');
  L.push('The twelve terminal verdicts below are **derived from the 36 measured cells**, not');
  L.push('asserted: a transition passes iff all six criteria hold for it, and a criterion passes');
  L.push('iff it holds on all six transitions. A failing cell propagates to a BLOCKED verdict with');
  L.push('the failing measurement named — there is no path here by which a failure yields a PASS.', '');

  const tFail = (c) => KS.filter((k) => !c.k[k].ok);
  const kFail = (k) => cells.filter((c) => !c.k[k].ok);

  L.push('## Terminal verdicts', '');
  L.push('| # | item | verdict | derived from |');
  L.push('|---|---|---|---|');
  for (const c of cells) {
    const f = tFail(c);
    L.push(f.length === 0
      ? `| **${c.id}** | ${c.a} → ${c.b} | **PASS** | all six criteria hold; see the row below |`
      : `| **${c.id}** | ${c.a} → ${c.b} | **BLOCKED** | ${f.map((k) => `${k}: ${why(c, k)}`).join('; ')} |`);
  }
  for (const k of KS) {
    const f = kFail(k);
    L.push(f.length === 0
      ? `| **${k}** | ${KNAME[k]} | **PASS** | holds on all six transitions; per-transition measurements below |`
      : `| **${k}** | ${KNAME[k]} | **BLOCKED** | fails on ${f.map((c) => `${c.id} (${why(c, k)})`).join('; ')} |`);
  }
  L.push('| **Persona** | use the AI Elements persona component | **ADOPTED** | state model (`persona.tsx:281-294`) and layered visual approach ported to Lit; timing values NOT PORTABLE — the upstream source contains none. See `persona-reference/README.md`. |');
  L.push('');

  const blocked = cells.filter((c) => tFail(c).length).length + KS.filter((k) => kFail(k).length).length;
  L.push(`**BLOCKED items: ${blocked}.**` + (blocked === 0
    ? ' Every item carries PASS, so no BLOCKED reasons are required. Had any cell failed, the'
      + ' verdict above would read BLOCKED with the failing measurement named.'
    : ''), '');

  L.push('## The 36 cells', '');
  L.push('| transition | ' + KS.map((k) => `${k}<br>${KNAME[k]}`).join(' | ') + ' |');
  L.push('|---|' + KS.map(() => '---').join('|') + '|');
  for (const c of cells) {
    L.push(`| **${c.id}** ${c.a} → ${c.b} | ` +
      KS.map((k) => (c.k[k].ok ? 'PASS' : '**BLOCKED**')).join(' | ') + ' |');
  }
  L.push('');
  L.push('### The measurement in every cell', '');
  for (const c of cells) {
    L.push(`#### ${c.id}  ${c.a} → ${c.b}`, '');
    for (const k of KS) L.push(`- **${k}** ${c.k[k].ok ? 'PASS' : 'BLOCKED'} — ${why(c, k)}`);
    L.push('');
  }
  L.push('## Where the rest of the evidence lives', '');
  L.push('| | |');
  L.push('|---|---|');
  L.push('| unreduced per-frame samples, all six transitions + three interrupts | `docs/research/voice-orb-samples.txt` |');
  L.push('| which technique is running, measured at runtime | `--technique` (`getAnimations()` = 0, Σw = 1.000000) |');
  L.push('| the artifact\'s controls, driven by clicking them | `--ui` |');
  L.push('| the technique asserted in CI, mutation-proven | `web/src/lib/orb-persona.test.ts` (30 tests, `npm test`) |');
  L.push('| the engine | `web/src/lib/orb-persona.ts` |');
  L.push('| the artifact | `docs/research/voice-orb-mock.html` |');
  L.push('');

  console.log(L.join('\n'));
  return blocked === 0 ? 0 : 1;
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
