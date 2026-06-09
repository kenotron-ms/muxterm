#!/usr/bin/env node
/**
 * browser-tab.mjs — E2E for the browser pane feature.
 *
 * Verifies five scenarios against a running muxterm server:
 *   1. [⌂] button opens a port popover → browser pane created with correct title/iframe.
 *   2. Proxied HTTP content is reachable at /p/PORT/.
 *   3. Browser pane survives a muxterm page reload (state-restored from sessiond).
 *   4. Closing the browser pane removes it from the workspace after reload.
 *   5. Pressing Escape in the popover dismisses it without creating a new pane.
 *
 * Usage:  node web/e2e/browser-tab.mjs [--url http://localhost:8080]
 *
 * Exit codes: 0 = all passed, 1 = at least one test failed, 2 = setup error.
 *
 * Prereqs: playwright-cli installed globally; muxterm dev server running at --url.
 */

import { execFileSync } from 'node:child_process';

// ── arg parsing ──────────────────────────────────────────────────────────────
let url = 'http://localhost:8080';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && i + 1 < argv.length) url = argv[++i];
  else if (argv[i].startsWith('--url=')) url = argv[i].slice('--url='.length);
}

// ── playwright-cli helpers ───────────────────────────────────────────────────
function pcli(...args) {
  return execFileSync('playwright-cli', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** Call playwright-cli --raw eval and return raw stdout. */
function peval(js) {
  return execFileSync('playwright-cli', ['--raw', 'eval', js], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** Evaluate JS in the page and JSON.parse the (possibly double-encoded) result. */
function pevalJson(js) {
  const raw = peval(js);
  const start = raw.indexOf('{');
  const arrStart = raw.indexOf('[');
  // pick whichever bracket appears first as the JSON root
  let s = start;
  if (arrStart !== -1 && (start === -1 || arrStart < start)) s = arrStart;
  const openCh = raw[s];
  const closeCh = openCh === '{' ? '}' : ']';
  const e = raw.lastIndexOf(closeCh);
  if (s === -1 || e === -1) throw new Error(`No JSON in eval output:\n${raw}`);
  const slice = raw.slice(s, e + 1);
  try { return JSON.parse(slice); }
  catch {
    // double-encoded: parse the surrounding quoted string first
    const q = raw.indexOf('"');
    const q2 = raw.lastIndexOf('"');
    return JSON.parse(JSON.parse(raw.slice(q, q2 + 1)));
  }
}

function sleep(ms) { execFileSync('sleep', [String(ms / 1000)]); }

// ── page-side helpers, prepended to every eval that needs them ───────────────
const HELPERS = `
  function _dock() {
    const app = document.querySelector('mux-app');
    if (!app) return null;
    return (app.shadowRoot || app).querySelector('mux-dock');
  }
  function hasBrowserPanel() {
    const dock = _dock();
    if (!dock || !dock._panels) return false;
    for (const [, panel] of dock._panels.entries()) {
      const t = panel.title;
      if (typeof t === 'string' && /^:\\d+$/.test(t)) return true;
    }
    return false;
  }
  function getBrowserPaneIframeSrc() {
    const surface = document.querySelector('mux-browser-surface');
    if (!surface || !surface.shadowRoot) return null;
    const iframe = surface.shadowRoot.querySelector('iframe');
    return iframe ? iframe.src : null;
  }
`;

/** Poll `js` (page-side expression) every 300 ms until truthy or timeout. */
function waitFor(js, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = peval(`${HELPERS}; JSON.stringify(!!(${js}))`).trim();
      if (result === 'true' || result === '"true"') return;
    } catch { /* ignore transient errors, keep polling */ }
    sleep(300);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function runTest(name, fn) {
  console.log(`\nTest: ${name}`);
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} —`, err.message);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
try {
  pcli('open', url);
  sleep(1500); // allow first composition + auto-spawned pane to settle

  // ── Test 1: browser pane opens from [⌂] button ───────────────────────────
  runTest('browser pane opens from [⌂] button', () => {
    // Click the browser icon button
    pcli('eval', `document.querySelector('[title="Open browser pane"]').click()`);
    sleep(300);

    // Verify the popover appeared
    const popoverPresent = peval(`JSON.stringify(!!document.querySelector('.mux-browser-popover'))`).trim();
    assert(popoverPresent.includes('true'), '.mux-browser-popover did not appear');

    // Fill the port input with 9002 and press Enter.
    // Supports either a dedicated #mux-browser-port-input or the generic popover input.
    pcli('eval', `
      const input = document.querySelector('#mux-browser-port-input')
                 || document.querySelector('.mux-browser-popover input[type="number"]');
      if (!input) throw new Error('port input not found in popover');
      input.value = '9002';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    `);
    sleep(1500); // wait for pane creation + websocket round-trip

    // Assert panel with title ':9002' exists
    const titles = pevalJson(
      `${HELPERS}; JSON.stringify([...(_dock()?._panels?.values() ?? [])].map(p => p.title))`,
    );
    assert(Array.isArray(titles) && titles.includes(':9002'),
      `panel ':9002' not found; got: ${JSON.stringify(titles)}`);

    // Assert <mux-browser-surface> is in the DOM
    const hasSurface = peval(`JSON.stringify(!!document.querySelector('mux-browser-surface'))`).trim();
    assert(hasSurface.includes('true'), '<mux-browser-surface> not found in DOM');

    // Assert iframe src contains '/p/9002/'
    const iframeSrc = peval(`${HELPERS}; JSON.stringify(getBrowserPaneIframeSrc())`).trim();
    assert(iframeSrc.includes('/p/9002/'),
      `iframe src should contain '/p/9002/', got: ${iframeSrc}`);
  });

  // ── Test 2: proxied HTTP content loads in browser pane ───────────────────
  runTest('proxied HTTP content loads in browser pane', () => {
    // Kick off a health-check fetch in the page, store result in a window flag.
    pcli('eval', `
      window.__healthOk = null;
      fetch('/p/9002/api/health')
        .then(r => { window.__healthOk = r.ok; })
        .catch(() => { window.__healthOk = false; });
    `);
    waitFor(`window.__healthOk === true`, 10000);
  });

  // ── Test 3: browser pane survives muxterm page reload ────────────────────
  runTest('browser pane survives muxterm page reload', () => {
    pcli('reload');
    sleep(3000); // allow reconnect + state restore
    waitFor(`hasBrowserPanel()`, 8000);
    const titles = pevalJson(
      `${HELPERS}; JSON.stringify([...(_dock()?._panels?.values() ?? [])].map(p => p.title))`,
    );
    assert(Array.isArray(titles) && titles.includes(':9002'),
      `panel ':9002' not found after reload; got: ${JSON.stringify(titles)}`);
  });

  // ── Test 4: close-pane removes browser pane from workspace ───────────────
  runTest('close-pane removes browser pane from workspace', () => {
    // Close the browser panel via its dockview panel API.
    pcli('eval', `${HELPERS};
      const entry = [...(_dock()?._panels?.entries() ?? [])].find(([, p]) => p.title === ':9002');
      if (!entry) throw new Error('browser panel :9002 not found');
      entry[1].api.close();
    `);
    sleep(500);
    pcli('reload');
    sleep(1500);

    const panelsAfter = pevalJson(
      `${HELPERS}; JSON.stringify([...(_dock()?._panels?.values() ?? [])].map(p => p.title))`,
    );
    assert(Array.isArray(panelsAfter) && !panelsAfter.includes(':9002'),
      `panel ':9002' should be absent after close+reload; got: ${JSON.stringify(panelsAfter)}`);
  });

  // ── Test 5: [⌂] button Escape dismisses popover without creating a pane ──
  runTest('[⌂] button Escape dismisses popover without creating a pane', () => {
    const countBefore = pevalJson(
      `${HELPERS}; JSON.stringify([...(_dock()?._panels?.keys() ?? [])].length)`,
    );

    // Open the popover
    pcli('eval', `document.querySelector('[title="Open browser pane"]').click()`);
    sleep(300);

    const popoverPresent = peval(`JSON.stringify(!!document.querySelector('.mux-browser-popover'))`).trim();
    assert(popoverPresent.includes('true'), '.mux-browser-popover did not appear');

    // Press Escape to dismiss
    pcli('eval', `
      const input = document.querySelector('#mux-browser-port-input')
                 || document.querySelector('.mux-browser-popover input[type="number"]');
      if (input) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    `);
    sleep(300);

    // Verify popover is gone
    const popoverGone = peval(`JSON.stringify(!document.querySelector('.mux-browser-popover'))`).trim();
    assert(popoverGone.includes('true'), '.mux-browser-popover should be gone after Escape');

    // Assert panel count is unchanged (no new pane was created)
    const countAfter = pevalJson(
      `${HELPERS}; JSON.stringify([...(_dock()?._panels?.keys() ?? [])].length)`,
    );
    assert(countBefore === countAfter,
      `panel count should be unchanged: before=${countBefore}, after=${countAfter}`);
  });

  // ── summary ───────────────────────────────────────────────────────────────
  console.log('');
  if (failed > 0) {
    console.error(`${failed} test(s) FAILED, ${passed} passed`);
    process.exit(1);
  }
  console.log(`ALL ${passed} TESTS PASSED`);
  process.exit(0);
} catch (err) {
  console.error('SETUP ERROR:', err.message);
  process.exit(2);
} finally {
  try { execFileSync('playwright-cli', ['close'], { stdio: 'ignore' }); } catch { /* ignore */ }
}
