#!/usr/bin/env node
/**
 * xterm-refresh-stress.mjs — Stress test: page refresh stability for xterm.js + sessiond.
 *
 * Navigates to the muxterm app, refreshes the page --count times, and verifies
 * each iteration:
 *
 *   1. The terminal becomes ready within --timeout ms (default: 3000)
 *   2. The terminal buffer contains no garbled escape sequences (isClean check)
 *
 * "Ready" is defined as: mux-terminal._termInst exists AND
 * at least one non-whitespace line is present in the xterm.js buffer.
 *
 * Usage:
 *   node web/e2e/xterm-refresh-stress.mjs [options]
 *
 * Options:
 *   --url URL       Base URL of running muxterm server  (default: http://localhost:9090)
 *   --count N       Number of refresh iterations        (default: 10)
 *   --timeout MS    Max wait for terminal-ready (ms)    (default: 3000)
 *
 * Exit codes:
 *   0 — all iterations passed
 *   1 — at least one iteration failed (timeout or garbled text)
 *   2 — setup error (server unreachable, terminal never appeared on initial load)
 *
 * Prerequisites:
 *   muxterm server running at --url
 *   playwright-cli installed: npm install -g @playwright/cli@latest
 */

import { execFileSync } from 'node:child_process';

// ── arg parsing ─────────────────────────────────────────────────────────────

let urlArg     = 'http://localhost:9090';
let countArg   = 10;
let timeoutArg = 3000;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--url'     && i + 1 < argv.length) { urlArg     = argv[++i]; continue; }
  if (a === '--count'   && i + 1 < argv.length) { countArg   = parseInt(argv[++i], 10); continue; }
  if (a === '--timeout' && i + 1 < argv.length) { timeoutArg = parseInt(argv[++i], 10); continue; }
  if (a.startsWith('--url='))     { urlArg     = a.slice(6);  continue; }
  if (a.startsWith('--count='))   { countArg   = parseInt(a.slice(8),  10); continue; }
  if (a.startsWith('--timeout=')) { timeoutArg = parseInt(a.slice(10), 10); continue; }
}

// ── playwright-cli helpers ───────────────────────────────────────────────────

/**
 * Run a playwright-cli command, returning stdout as a string.
 * Throws on non-zero exit.
 */
function pcli(...args) {
  return execFileSync('playwright-cli', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 30_000,
  });
}

/**
 * Evaluate a browser-side JavaScript script and parse the result as JSON.
 *
 * The script must use `return` to produce its value, e.g.:
 *   const x = document.title;
 *   return { title: x };
 *
 * Returns null if the script throws, times out, or the result is null/undefined.
 */
function pcliEvalJson(script) {
  // Wrap in an IIFE and JSON.stringify the result so --raw gives us parseable output
  const evalScript = `JSON.stringify((function(){\n${script}\n})())`;
  try {
    const raw = execFileSync('playwright-cli', ['--raw', 'eval', evalScript], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 10_000,
    }).trim();

    if (!raw || raw === 'null' || raw === 'undefined') return null;

    // Direct parse
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }

    // playwright-cli sometimes double-encodes: the JSON string is itself
    // wrapped in outer quotes → JSON.parse the outer quotes first.
    if (parsed === undefined && raw.startsWith('"') && raw.endsWith('"')) {
      try { parsed = JSON.parse(JSON.parse(raw)); } catch { /* ignore */ }
    }

    if (parsed === undefined || parsed === null) return null;

    // If the result was itself a JSON string (e.g. JSON.stringify returned a string
    // that playwright-cli wrapped again), unwrap one more level.
    if (typeof parsed === 'string') {
      try { return JSON.parse(parsed); } catch { return null; }
    }

    return parsed;
  } catch {
    return null;
  }
}

// ── browser-side terminal check script ──────────────────────────────────────
//
// Accesses the xterm.js buffer via mux-terminal._termInst, handles both
// shadow-DOM and light-DOM layouts for mux-app / mux-dock.
//
// IMPORTANT: backslash sequences are intentionally doubled (\\x1b, \\n, ...)
// so that after template-literal evaluation the script delivered to
// playwright-cli contains single backslashes (valid JS regex / string escapes).

const TERMINAL_CHECK_SCRIPT = `
function isClean(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return !/\\x1b/.test(text)        // no ESC (CSI, OSC, DCS, SS3, RIS, …)
      && !/\\$\\$\\$\\$/.test(text)  // no measurement-leak artifacts
      && !/~~~~/.test(text)         // no xterm sizing garbage
      && !/\\ufffd/.test(text);     // no unicode replacement chars
}

// Resolve mux-dock — supports both shadow-DOM and light-DOM configurations.
const app = document.querySelector('mux-app');
if (!app) return null;

const appRoot = app.shadowRoot || app;
const dock    = appRoot.querySelector('mux-dock');
if (!dock) return null;

const dockRoot = dock.shadowRoot || dock;
const muxTerm  = dockRoot.querySelector('mux-terminal');
if (!muxTerm || !muxTerm._termInst) return null;

// Read all lines from the xterm.js buffer.
const buf = muxTerm._termInst.buffer.active;
let text = '';
for (let i = 0; i < buf.length; i++) {
  const line = buf.getLine(i);
  if (line) text += line.translateToString(true) + '\\n';
}

// Not ready yet — buffer is empty or all whitespace.
if (!text || !text.trim()) return null;

return {
  ok:      true,
  isClean: isClean(text),
  sample:  text.substring(0, 100).replace(/\\n+/g, ' ').trim(),
};
`;

// ── timing helpers ───────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Poll the terminal check script until the terminal is ready or timeoutMs elapses.
 * Returns { ok, ms, isClean, sample } where ok=false means timeout.
 */
async function waitForTerminal(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = pcliEvalJson(TERMINAL_CHECK_SCRIPT);
    if (result && result.ok) {
      return { ok: true, ms: deadline - timeoutMs + timeoutMs - (deadline - Date.now()), ...result };
    }
    await sleep(80);
  }
  return { ok: false, ms: timeoutMs, isClean: false, sample: '' };
}

/**
 * Same as waitForTerminal but also records the elapsed ms precisely.
 */
async function pollTerminalWithTiming(timeoutMs) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const result = pcliEvalJson(TERMINAL_CHECK_SCRIPT);
    if (result && result.ok) {
      return { ok: true, ms: Date.now() - start, ...result };
    }
    await sleep(80);
  }
  return { ok: false, ms: timeoutMs, isClean: false, sample: '' };
}

// ── formatting helpers ───────────────────────────────────────────────────────

function pad(s, n) { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

function formatRow(i, status, timeStr, cleanStr, sample) {
  return `  ${lpad(i, 3)}  ${pad(status, 6)}  ${pad(timeStr, 12)}  ${pad(cleanStr, 10)}  "${sample}"`;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nxterm-refresh-stress: testing xterm.js + sessiond across page refreshes');
  console.log(`  url:     ${urlArg}`);
  console.log(`  count:   ${countArg} refresh iterations`);
  console.log(`  timeout: ${timeoutArg}ms per iteration\n`);

  // Verify playwright-cli is available
  try {
    execFileSync('playwright-cli', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    console.error('ERROR: playwright-cli not found.');
    console.error('Install: npm install -g @playwright/cli@latest');
    process.exit(2);
  }

  // ── initial load ──────────────────────────────────────────────────────────
  console.log('Opening browser...');
  try {
    pcli('open', urlArg);
  } catch (err) {
    console.error(`ERROR: could not open ${urlArg}`);
    console.error('Is the muxterm server running?');
    process.exit(2);
  }

  console.log('Waiting for initial terminal...');
  const initial = await pollTerminalWithTiming(timeoutArg);
  if (!initial.ok) {
    console.error(`ERROR: terminal never appeared on initial load (waited ${timeoutArg}ms)`);
    console.error('Check that sessiond is running and the WebSocket connects.');
    process.exit(2);
  }

  console.log(`  terminal ready in ${initial.ms}ms`);
  if (!initial.isClean) {
    console.warn(`  WARNING: initial content has garbled escape sequences`);
    console.warn(`  sample: "${initial.sample}"`);
  }
  console.log();

  // ── iteration header ──────────────────────────────────────────────────────
  console.log(`  ${'#'.padStart(3)}  ${'STATUS'.padEnd(6)}  ${'READY'.padEnd(12)}  ${'CONTENT'.padEnd(10)}  SAMPLE`);
  console.log('  ' + '─'.repeat(62));

  const results = [];

  // ── refresh loop ──────────────────────────────────────────────────────────
  for (let i = 1; i <= countArg; i++) {
    // Reload the page (blocks until DOMContentLoaded + load events fire)
    try {
      pcli('reload');
    } catch {
      // If reload fails mid-session, treat as a timeout failure
      results.push({ i, passed: false, timedOut: true, ms: timeoutArg, isClean: false, sample: '' });
      console.log(formatRow(i, 'FAIL', 'reload-err', '–', 'reload failed'));
      continue;
    }

    // Poll for terminal content (WebSocket reconnects + xterm.js reinits asynchronously)
    const result = await pollTerminalWithTiming(timeoutArg);

    const timedOut = !result.ok;
    const passed   = result.ok && result.isClean;

    results.push({ i, passed, timedOut, ms: result.ms, isClean: result.isClean, sample: result.sample });

    const status   = passed   ? 'PASS' : 'FAIL';
    const timeStr  = timedOut ? `TIMEOUT` : `${result.ms}ms`;
    const cleanStr = timedOut ? '–' : (result.isClean ? 'clean' : 'GARBLED');
    const sample   = result.sample ? result.sample.substring(0, 30) : '–';

    console.log(formatRow(i, status, timeStr, cleanStr, sample));
  }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log('  ' + '─'.repeat(62));

  const passed   = results.filter(r => r.passed).length;
  const timedOut = results.filter(r => r.timedOut).length;
  const garbled  = results.filter(r => !r.timedOut && !r.isClean).length;
  const times    = results.filter(r => r.ok).map(r => r.ms);

  const avgMs = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  const minMs = times.length ? Math.min(...times) : 0;
  const maxMs = times.length ? Math.max(...times) : 0;

  console.log(`\nSummary: ${passed}/${countArg} iterations PASSED`);
  if (timedOut > 0) console.log(`  Timeouts (>${timeoutArg}ms): ${timedOut}`);
  if (garbled > 0)  console.log(`  Garbled content:        ${garbled}`);
  if (times.length) console.log(`  Time to ready:          min=${minMs}ms  avg=${avgMs}ms  max=${maxMs}ms`);

  // Close the browser cleanly
  try { pcli('close'); } catch { /* best-effort */ }

  if (passed < countArg) {
    console.log(`\nFAIL — ${countArg - passed} of ${countArg} iterations failed`);
    process.exit(1);
  } else {
    console.log(`\nPASS — all ${countArg} iterations: terminal clean and ready within ${timeoutArg}ms`);
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\nUnhandled error:', err.message ?? err);
  try { execFileSync('playwright-cli', ['close'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(2);
});
