#!/usr/bin/env node
/**
 * dock-tab-stress.mjs — Stress test: tab selection persistence across page refresh.
 *
 * Opens the dock-tabs.html static fixture (a minimal dockview-style panel with three
 * tabs: Alpha, Beta, Gamma), cycles through tab sequences, refreshes the page, and
 * verifies that the last selected tab is always correctly restored.
 *
 * Each iteration:
 *   1. Click through a sequence of tabs (e.g. Alpha → Beta → Alpha → Gamma)
 *   2. Record the last tab in the sequence (the expected tab after refresh)
 *   3. Refresh the page
 *   4. Assert all three of:
 *        a. localStorage entry = expected tab
 *        b. DOM .tab.active     = expected tab
 *        c. DOM .panel.active   = expected tab
 *
 * Usage:
 *   node web/e2e/dock-tab-stress.mjs [options]
 *
 * Options:
 *   --url URL     Path to dock-tabs.html fixture — accepts file:// URLs or http:// URLs.
 *                 Default: file://<absolute-path-to-web/e2e/fixtures/dock-tabs.html>
 *   --count N     Number of refresh iterations (default: 10)
 *   --timeout MS  Max wait for fixture to load after each refresh (default: 2000)
 *
 * Exit codes:
 *   0 — all iterations passed
 *   1 — at least one iteration failed (wrong tab restored)
 *   2 — setup error (fixture not found, playwright-cli missing)
 *
 * Prerequisites:
 *   playwright-cli installed: npm install -g @playwright/cli@latest
 *   (muxterm server is NOT required — this fixture is purely static HTML)
 */

import { execFileSync } from 'node:child_process';
import { existsSync }   from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── fixture path ─────────────────────────────────────────────────────────────

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ABS    = path.resolve(__dirname, 'fixtures', 'dock-tabs.html');
const FIXTURE_DEFAULT = `file://${FIXTURE_ABS}`;

// ── arg parsing ─────────────────────────────────────────────────────────────

let urlArg     = FIXTURE_DEFAULT;
let countArg   = 10;
let timeoutArg = 2000;

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

// ── tab sequences ────────────────────────────────────────────────────────────
//
// Each entry represents one iteration's tab-clicking pattern.
// The last tab in the sequence is the one that must survive the refresh.
// Sequences cover: all three tabs as endpoints, back-and-forth swaps,
// and chains of length 2-4 to exercise the "last one wins" invariant.

const SEQUENCES = [
  { tabs: ['alpha', 'beta', 'alpha', 'beta'],       last: 'beta'  }, // back-and-forth → beta
  { tabs: ['beta', 'gamma'],                         last: 'gamma' }, // short → gamma
  { tabs: ['gamma', 'alpha', 'beta', 'alpha'],      last: 'alpha' }, // three-tab → alpha
  { tabs: ['alpha', 'gamma', 'beta', 'gamma'],      last: 'gamma' }, // three-tab → gamma
  { tabs: ['gamma', 'beta'],                         last: 'beta'  }, // short → beta
  { tabs: ['alpha', 'beta', 'gamma'],               last: 'gamma' }, // forward sweep → gamma
  { tabs: ['gamma', 'beta', 'alpha'],               last: 'alpha' }, // reverse sweep → alpha
  { tabs: ['beta', 'alpha', 'beta'],                last: 'beta'  }, // back-and-forth → beta
  { tabs: ['alpha', 'gamma'],                        last: 'gamma' }, // skip beta → gamma
  { tabs: ['gamma', 'alpha', 'gamma', 'alpha'],     last: 'alpha' }, // multi-swap → alpha
];

// ── playwright-cli helpers ───────────────────────────────────────────────────

function pcli(...args) {
  return execFileSync('playwright-cli', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 15_000,
  });
}

function pcliEvalJson(script) {
  const evalScript = `JSON.stringify((function(){\n${script}\n})())`;
  try {
    const raw = execFileSync('playwright-cli', ['--raw', 'eval', evalScript], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 8_000,
    }).trim();

    if (!raw || raw === 'null' || raw === 'undefined') return null;

    // Direct parse
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }

    // Handle playwright-cli double-encoding: outer "..." wraps JSON string
    if (parsed === undefined && raw.startsWith('"') && raw.endsWith('"')) {
      try { parsed = JSON.parse(JSON.parse(raw)); } catch { /* ignore */ }
    }

    if (parsed === undefined || parsed === null) return null;
    if (typeof parsed === 'string') {
      try { return JSON.parse(parsed); } catch { return null; }
    }
    return parsed;
  } catch {
    return null;
  }
}

// ── timing helpers ───────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Poll for window.__test.getState() until it's available and consistent,
 * or until timeoutMs elapses.
 */
async function waitForFixtureState(timeoutMs) {
  const POLL_SCRIPT = `
    if (typeof window.__test !== 'object' || !window.__test) return null;
    const s = window.__test.getState();
    if (!s || !s.consistent) return null;
    return s;
  `;
  const start    = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const state = pcliEvalJson(POLL_SCRIPT);
    if (state) return { ok: true, ms: Date.now() - start, ...state };
    await sleep(60);
  }
  return { ok: false, ms: timeoutMs };
}

// ── formatting helpers ───────────────────────────────────────────────────────

function pad(s, n) { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

function formatRow(i, status, sequence, expected, actual, notes) {
  const seqStr    = sequence.join('→');
  const actualStr = actual ?? '–';
  return `  ${lpad(i, 3)}  ${pad(status, 6)}  ${pad(seqStr, 28)}  ${pad(expected, 7)}  ${pad(actualStr, 7)}  ${notes}`;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Verify playwright-cli
  try {
    execFileSync('playwright-cli', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    console.error('ERROR: playwright-cli not found.');
    console.error('Install: npm install -g @playwright/cli@latest');
    process.exit(2);
  }

  // Verify fixture exists (for file:// URLs)
  if (urlArg.startsWith('file://')) {
    const localPath = urlArg.slice(7);
    if (!existsSync(localPath)) {
      console.error(`ERROR: fixture not found at ${localPath}`);
      console.error('Run from the muxterm root directory.');
      process.exit(2);
    }
  }

  console.log('\ndock-tab-stress: testing tab selection persistence across page refreshes');
  console.log(`  fixture: ${urlArg}`);
  console.log(`  count:   ${countArg} refresh iterations`);
  console.log(`  timeout: ${timeoutArg}ms per fixture load\n`);

  // ── open fixture and clear any stale state ────────────────────────────────
  console.log('Opening fixture...');
  try {
    pcli('open', urlArg);
  } catch {
    console.error(`ERROR: could not open ${urlArg}`);
    process.exit(2);
  }

  // Clear localStorage from any previous run, then reload for a clean slate
  pcliEvalJson(`
    localStorage.removeItem('dock-tabs-fixture:active');
    localStorage.removeItem('dock-tabs-fixture:load-count');
    return 'cleared';
  `);
  pcli('reload');

  // Confirm the fixture loaded cleanly
  const initial = await waitForFixtureState(timeoutArg);
  if (!initial.ok) {
    console.error(`ERROR: fixture did not load or window.__test is unavailable (${timeoutArg}ms)`);
    console.error('Check that the dock-tabs.html fixture is accessible at the given URL.');
    process.exit(2);
  }
  console.log(`  fixture loaded — default active tab: ${initial.stored ?? '?'}\n`);

  // ── header ────────────────────────────────────────────────────────────────
  console.log(
    `  ${'#'.padStart(3)}  ${'STATUS'.padEnd(6)}  ${'SEQUENCE'.padEnd(28)}  ${'EXPECT'.padEnd(7)}  ${'ACTUAL'.padEnd(7)}  NOTES`
  );
  console.log('  ' + '─'.repeat(72));

  const results = [];

  // ── iteration loop ────────────────────────────────────────────────────────
  for (let i = 1; i <= countArg; i++) {
    const seq      = SEQUENCES[(i - 1) % SEQUENCES.length];
    const expected = seq.last;

    // Click each tab in the sequence
    let clickOk = true;
    for (const tab of seq.tabs) {
      try {
        pcli('click', `.tab[data-tab-id="${tab}"]`);
      } catch {
        clickOk = false;
        break;
      }
      // Brief pause so localStorage is written before the next click
      await sleep(80);
    }

    if (!clickOk) {
      results.push({ i, passed: false, seq: seq.tabs, expected, actual: null, notes: 'click failed' });
      console.log(formatRow(i, 'FAIL', seq.tabs, expected, null, 'could not click tab'));
      continue;
    }

    // Confirm the correct tab is active before refreshing (sanity-check clicks worked)
    const preRefreshState = pcliEvalJson(`
      if (typeof window.__test !== 'object') return null;
      return window.__test.getState();
    `);

    if (!preRefreshState || preRefreshState.stored !== expected) {
      const got = preRefreshState?.stored ?? 'unknown';
      results.push({ i, passed: false, seq: seq.tabs, expected, actual: got, notes: 'pre-refresh mismatch' });
      console.log(formatRow(i, 'FAIL', seq.tabs, expected, got, `pre-refresh: stored=${got}`));
      continue;
    }

    // Refresh and verify
    pcli('reload');
    const postRefreshState = await waitForFixtureState(timeoutArg);

    if (!postRefreshState.ok) {
      results.push({ i, passed: false, seq: seq.tabs, expected, actual: null, notes: 'load timeout' });
      console.log(formatRow(i, 'FAIL', seq.tabs, expected, null, `load timeout >${timeoutArg}ms`));
      continue;
    }

    const actual  = postRefreshState.stored;
    const domTab  = postRefreshState.domTab;
    const domPanel = postRefreshState.domPanel;
    const allAgree = actual === expected && domTab === expected && domPanel === expected;

    if (allAgree) {
      results.push({ i, passed: true, seq: seq.tabs, expected, actual, notes: '' });
      console.log(formatRow(i, 'PASS', seq.tabs, expected, actual, `dom:${domTab} panel:${domPanel}`));
    } else {
      const notes = [];
      if (actual !== expected)   notes.push(`stored=${actual}`);
      if (domTab !== expected)   notes.push(`domTab=${domTab}`);
      if (domPanel !== expected) notes.push(`panel=${domPanel}`);
      results.push({ i, passed: false, seq: seq.tabs, expected, actual, notes: notes.join(' ') });
      console.log(formatRow(i, 'FAIL', seq.tabs, expected, actual, notes.join(' ')));
    }
  }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log('  ' + '─'.repeat(72));

  const passed  = results.filter(r => r.passed).length;
  const failed  = results.filter(r => !r.passed).length;
  const endings = results.reduce((acc, r) => {
    acc[r.expected] = (acc[r.expected] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`\nSummary: ${passed}/${countArg} iterations PASSED`);
  if (failed > 0) {
    const failedItems = results.filter(r => !r.passed);
    console.log(`  Failed iterations: ${failedItems.map(r => r.i).join(', ')}`);
    failedItems.forEach(r => {
      console.log(`    #${r.i}: sequence=${r.seq.join('→')}  expected=${r.expected}  actual=${r.actual ?? '–'}  (${r.notes})`);
    });
  }
  console.log(`  Tab distribution: ${Object.entries(endings).map(([k, v]) => `${k}×${v}`).join(', ')}`);

  // Clean up localStorage and close browser
  try {
    pcliEvalJson(`
      localStorage.removeItem('dock-tabs-fixture:active');
      localStorage.removeItem('dock-tabs-fixture:load-count');
      return 'cleaned';
    `);
  } catch { /* best-effort */ }
  try { pcli('close'); } catch { /* best-effort */ }

  if (failed > 0) {
    console.log(`\nFAIL — ${failed} of ${countArg} iterations: last selected tab was not restored`);
    process.exit(1);
  } else {
    console.log(`\nPASS — all ${countArg} iterations: last selected tab correctly restored after refresh`);
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\nUnhandled error:', err.message ?? err);
  try { execFileSync('playwright-cli', ['close'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(2);
});
