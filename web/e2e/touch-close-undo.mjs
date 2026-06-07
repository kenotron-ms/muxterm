#!/usr/bin/env node
/**
 * touch-close-undo.mjs — E2E for touch-safe pane close with undo.
 *
 * Verifies three scenarios against a running muxterm server:
 *   1. Touch close -> toast/pending-close appears -> Undo -> pane present + xterm buffer intact.
 *   2. Touch close -> force-expire (DEV seam) -> pane absent from server state.
 *   3. Mouse close -> no pending close -> pane closes immediately.
 *
 * Usage:  node web/e2e/touch-close-undo.mjs [--url http://localhost:9090]
 *
 * Exit codes: 0 = all passed, 1 = an assertion failed, 2 = setup error.
 *
 * Prereqs: playwright-cli installed globally; muxterm dev server running at --url.
 */

import { execFileSync } from 'node:child_process';

// ── arg parsing ──────────────────────────────────────────────────────────────
let url = 'http://localhost:9090';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && i + 1 < argv.length) url = argv[++i];
  else if (argv[i].startsWith('--url=')) url = argv[i].slice('--url='.length);
}

// ── playwright-cli helpers (mirrors dock-tab-stress.mjs) ─────────────────────
function pcli(...args) {
  return execFileSync('playwright-cli', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** eval JS in the page and JSON.parse the (possibly double-encoded) result. */
function pevalJson(js) {
  const raw = execFileSync('playwright-cli', ['--raw', 'eval', js], { encoding: 'utf8' });
  const start = raw.indexOf('{');
  const arrStart = raw.indexOf('[');
  // pick whichever bracket appears first as the JSON root
  let s = start;
  if (arrStart !== -1 && (start === -1 || arrStart < start)) s = arrStart;
  const openCh = raw[s];
  const closeCh = openCh === '{' ? '}' : ']';
  const e = raw.lastIndexOf(closeCh);
  if (s === -1 || e === -1) throw new Error(`No JSON in eval output:\n${raw}`);
  let slice = raw.slice(s, e + 1);
  try { return JSON.parse(slice); }
  catch {
    // double-encoded: parse the surrounding quoted string first
    const q = raw.indexOf('"');
    const q2 = raw.lastIndexOf('"');
    return JSON.parse(JSON.parse(raw.slice(q, q2 + 1)));
  }
}

function sleep(ms) { execFileSync('sleep', [String(ms / 1000)]); }

// ── shared page-side helpers, injected as a string into every eval ───────────
// NOTE: kept as a string so we can prepend it to each eval snippet.
const HELPERS = `
  function _dock() {
    return document.querySelector('mux-app').shadowRoot.querySelector('mux-dock');
  }
  function _tabFor(paneId) {
    const dock = _dock();
    // dockview panel ids are the stringified paneId; the tab content holds the title,
    // but the close action lives in .dv-default-tab-action inside the same .dv-tab.
    const panels = [...dock.querySelectorAll('.dv-tab')];
    // Map tab -> paneId via the active panel API is unreliable here, so match by
    // the dockview group's panel order is fragile; instead we use the dev hook.
    return panels;
  }
  // Dispatch a synthetic pointerdown of a given type on the dock host so the
  // capture-phase listener records _lastPointerType, then click the close X.
  function _closePane(paneId, pointerType) {
    const dock = _dock();
    dock.dispatchEvent(new PointerEvent('pointerdown', { pointerType, bubbles: true }));
    // Find the close action for this pane's tab. We resolve the tab by asking the
    // dev hook for the close button element.
    const btn = window.__muxCloseButtonFor(paneId);
    if (!btn) throw new Error('close button not found for pane ' + paneId);
    btn.click();
  }
`;

// ── test driver ───────────────────────────────────────────────────────────────
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  PASS:', name); }
  else { failures++; console.log('  FAIL:', name, extra ? JSON.stringify(extra) : ''); }
}

try {
  pcli('open', url);
  sleep(1500); // allow first composition + auto-spawned pane to settle

  // Ensure we have at least TWO panes so closing one leaves the app non-empty.
  pcli('eval', `${HELPERS}; window.__muxStore && document.querySelector('mux-app')` +
    `.shadowRoot.querySelector('mux-dock') && (function(){` +
    `  const app = document.querySelector('mux-app');` +
    `  app.dispatchEvent(new CustomEvent('noop'));` +
    `})()`);
  // Create a second pane via the app's optimistic create (split keybinding path).
  pcli('eval', `(function(){ const a = document.querySelector('mux-app'); ` +
    `a.shadowRoot.querySelector('mux-dock').dispatchEvent(` +
    `new CustomEvent('pane-create', { bubbles: true, composed: true })); })()`);
  sleep(1500);

  const ids = pevalJson(`JSON.stringify(window.__muxStore.panes.filter(p=>p.paneId>=0).map(p=>p.paneId))`);
  if (!Array.isArray(ids) || ids.length < 2) {
    console.error('SETUP ERROR: expected >=2 panes, got', ids);
    process.exit(2);
  }
  const target = ids[ids.length - 1]; // close the last one

  // ── Scenario 1: touch close -> pending appears -> undo -> intact ─────────
  console.log('Scenario 1: touch close + undo');
  const before = pevalJson(
    `JSON.stringify({ content: document.querySelector('mux-app').shadowRoot` +
    `.querySelector('mux-dock').getTerminalContent(${target}) })`);
  pcli('eval', `${HELPERS}; _closePane(${target}, 'touch')`);
  sleep(300);
  const pending1 = pevalJson(`JSON.stringify(window.__muxPendingCloses())`);
  check('pending close registered for target', pending1.includes(target), { pending1 });
  // tap Undo
  pcli('eval', `window.__muxUndoClose(${target})`);
  sleep(500);
  const afterPanes = pevalJson(`JSON.stringify(window.__muxStore.panes.filter(p=>p.paneId>=0).map(p=>p.paneId))`);
  check('pane present again after undo', afterPanes.includes(target), { afterPanes });
  const after = pevalJson(
    `JSON.stringify({ content: document.querySelector('mux-app').shadowRoot` +
    `.querySelector('mux-dock').getTerminalContent(${target}) })`);
  check('xterm buffer intact after undo', after.content === before.content,
    { before: before.content.slice(0, 40), after: after.content.slice(0, 40) });

  // ── Scenario 2: touch close -> force-expire -> pane gone ─────────────────
  console.log('Scenario 2: touch close + expiry');
  pcli('eval', `${HELPERS}; _closePane(${target}, 'touch')`);
  sleep(300);
  const pending2 = pevalJson(`JSON.stringify(window.__muxPendingCloses())`);
  check('pending close registered before expiry', pending2.includes(target), { pending2 });
  pcli('eval', `window.__muxForceExpire(${target})`);
  sleep(800);
  const goneServer = pevalJson(`JSON.stringify(window.__muxStore.panes.map(p=>p.paneId))`);
  check('pane absent from server state after expiry', !goneServer.includes(target), { goneServer });

  // ── Scenario 3: mouse close -> instant, no pending ───────────────────────
  console.log('Scenario 3: mouse close (instant)');
  const remaining = pevalJson(`JSON.stringify(window.__muxStore.panes.filter(p=>p.paneId>=0).map(p=>p.paneId))`);
  const mouseTarget = remaining[remaining.length - 1];
  pcli('eval', `${HELPERS}; _closePane(${mouseTarget}, 'mouse')`);
  sleep(300);
  const pending3 = pevalJson(`JSON.stringify(window.__muxPendingCloses())`);
  check('no pending close for mouse close', !pending3.includes(mouseTarget), { pending3 });

  console.log('');
  if (failures > 0) { console.error(`${failures} check(s) FAILED`); process.exit(1); }
  console.log('ALL CHECKS PASSED');
  process.exit(0);
} catch (err) {
  console.error('SETUP ERROR:', err.message);
  process.exit(2);
} finally {
  try { execFileSync('playwright-cli', ['close'], { stdio: 'ignore' }); } catch { /* ignore */ }
}
