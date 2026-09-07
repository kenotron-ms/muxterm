#!/usr/bin/env node
/**
 * VERIFICATION HARNESS - a headless browser that drives one chief-of-staff turn
 * and reports, in numbers, how much of the reply survived. See README.md for
 * scenarios, modes and isolation rules.
 *
 *   node drive.mjs "<prompt>" [--mode plain|s1|s3|s4|s5] [--label N] [--out DIR]
 *        [--url URL] [--timeout MS] [--settle MS] [--viewport WxH] [--headed]
 *
 * THREE LAYERS, because "it didn't render" does not say where the bytes went:
 *   1 WIRE    every cos-* frame the browser received (page.on('websocket')).
 *   2 DOM     text of p.say inside <mux-cos>'s shadow root, PER TURN.
 *   3 SCREEN  geometry: is the end of the answer inside .chatbody's visible box.
 * Layer 3 exists because layers 1-2 kept saying 100% while a user saw nothing.
 * It reads geometry only - the component's private _pinned is deliberately not
 * consulted, because a test that asks the code what it believes cannot catch
 * the code believing something false.
 *
 * WAITING FOR THE TURN TO END IS NOT DONE THROUGH THE BROWSER. In s1 the page
 * that submitted the turn is gone, and in every mode the browser's idea of
 * "finished" is the thing under test. repro-sidecar.py appends a record to
 * turns.jsonl when it emits turn_end; that file is the server-side truth. It
 * also writes the exact payload it sent, so expected bytes are read, never
 * re-derived: a disagreement between harness and product stays visible.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

// --- args ------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0].startsWith('--')) {
  console.error('usage: drive.mjs "<prompt>" [--mode plain|s1|s3|s4|s5] [--label N]'
    + ' [--out DIR] [--url URL] [--timeout MS] [--settle MS] [--viewport WxH] [--headed]');
  process.exit(2);
}
const scenario = argv[0];
const flag = (n, d) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : d);
const mode = String(flag('mode', 'plain')).toLowerCase();
if (!['plain', 's1', 's3', 's4', 's5'].includes(mode)) {
  console.error(`unknown --mode ${mode}`);
  process.exit(2);
}
const label = flag('label', scenario.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run');
const outDir = flag('out', '/tmp/cos-repro/run');
const url = flag('url', 'http://127.0.0.1:9390/');
const timeoutMs = Number(flag('timeout', '60000'));
// A report snapped mid-render would blame the product for the harness being
// impatient, so the DOM gets this long to stop changing.
const settleCapMs = Number(flag('settle', '20000'));
const sidecarDir = process.env.MUXTERM_REPRO_DIR || '/tmp/cos-repro';
// "Is the reply on screen" is only a question if there is a fold, and a tall
// browser hides the fold behind sheer height. 1280x800 is a laptop.
const vp = /^(\d+)x(\d+)$/.exec(String(flag('viewport', '1280x800')));
if (!vp) { console.error('--viewport wants WxH'); process.exit(2); }
const viewport = { width: Number(vp[1]), height: Number(vp[2]) };
// The component's own threshold (mux-cos.ts _onScroll), reused so this and the
// code under test mean the same thing by "at the bottom".
const PIN_PX = 48;
const AWAY_FRAC = 0.33;      // how far into the payload s4/s5 act
const AWAY_AFTER_MS = 800;   // how long after the first delta s1/s3 act

fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, `report-${label}.json`);
const consoleFd = fs.openSync(path.join(outDir, `console-${label}.log`), 'w');

const t0 = Date.now();
const ms = () => Date.now() - t0;
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const timeline = [];
const mark = (what, extra) => {
  timeline.push({ atMs: ms(), what, ...(extra || {}) });
  console.log(`  [${String(ms()).padStart(6)}ms] ${what} ${extra ? JSON.stringify(extra) : ''}`);
};

// --- layer 1: the wire -----------------------------------------------------

/** Every cos-* frame received, ACROSS EVERY PAGE this run opens: an away
 *  scenario has more than one, and "which browser saw it" is half the answer. */
const received = [];
let socketClosed = false;
let socketClosedAt = 0;

/** Installed before any page script runs, and it does ONE thing: keep a handle
 *  on every WebSocket the app constructs. s5 has to kill the app's OWN socket
 *  and the constructor is the only handle on it. A subclass, so the app's
 *  handlers and `instanceof` keep working. */
const INIT_SCRIPT = () => {
  const Native = window.WebSocket;
  window.__cosSockets = [];
  window.WebSocket = class extends Native {
    constructor(...a) { super(...a); window.__cosSockets.push(this); }
  };
};

async function makeContext() {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(INIT_SCRIPT);
  return ctx;
}

function instrument(page, tag) {
  page.on('console', (m) => fs.writeSync(consoleFd, `[${ms()}ms][${tag}] ${m.type()}: ${m.text()}\n`));
  page.on('pageerror', (e) => fs.writeSync(consoleFd, `[${ms()}ms][${tag}] pageerror: ${e?.stack || e}\n`));
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      const text = typeof frame.payload === 'string' ? frame.payload : null;
      if (!text || text[0] !== '{') return;
      let p = null;
      try { p = JSON.parse(text); } catch { return; }
      // cos-* only: terminal output is the bulk of the traffic and is not what
      // this harness is about.
      if (typeof p.type !== 'string' || !p.type.startsWith('cos-')) return;
      const ev = p.event && typeof p.event === 'object' ? p.event : null;
      received.push({
        t: ms(), page: tag, bytes: Buffer.byteLength(text), type: p.type,
        ev: ev ? String(ev.ev ?? '') : '', turn_id: ev ? String(ev.turn_id ?? '') : '',
        event: ev, turns: p.type === 'cos-history' ? p.turns : null,
      });
    });
    ws.on('close', () => { socketClosed = true; socketClosedAt = ms(); });
  });
}

const TERMINAL = new Set(['turn_end', 'cancelled']);
const terminalFrame = (turnId) => received.find((f) => f.type === 'cos-event' && f.event
  && (!turnId || !f.turn_id || f.turn_id === turnId)
  && (TERMINAL.has(f.ev) || (f.ev === 'error' && (f.event.fatal === true || f.event.code === 'busy')))) || null;

/** Bytes of payload the WIRE has carried to any page so far. */
const wireDeltaBytes = () => received.reduce((n, f) =>
  (f.ev === 'delta' && typeof f.event?.text === 'string' ? n + f.event.text.length : n), 0);

// --- layers 2 and 3, in ONE page function ----------------------------------
//
// One function, and therefore ONE rule for which turn is "this turn": the DOM
// read and the geometry read must never be able to answer about different turns.
// The target is the turn carrying THIS turn's MARKER-START; when the reply is
// gone entirely there is no marker, so the fallback is the turn whose prompt was
// typed - exactly the case that has to stay measurable. Per turn and not per
// document, because an away scenario ends with several turns on screen (a
// history replay, or the same turn rendered twice) and a whole-transcript byte
// count would score a duplicate as a success.
//
// arg.geo forces layout, so the polling loops leave it off; only the final read
// asks for it.

const READ = `(arg) => {
  const q = (selector) => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.matches(selector)) out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);           // by hand rather than Playwright's piercing CSS,
    return out;               // so the traversal cannot be the surprise
  };
  const txt = (e) => e.textContent ?? '';
  const squash = (s) => s.replace(/\\s+/g, ' ').trim();

  const els = q('.turn.cos');
  const turns = els.map((el) => {
    const says = Array.from(el.querySelectorAll('p.say')).map(txt);
    const text = says.join('');
    const prev = el.previousElementSibling;
    const pn = prev?.classList?.contains('you') ? prev.querySelector('p.say') : null;
    return {
      prompt: pn ? txt(pn) : '',
      sayBytes: text.length,
      sayNodes: says.length,
      thoughtNodes: el.querySelectorAll('p.thought').length,
      toolNodes: el.querySelectorAll('.tool').length,
      waiting: Array.from(el.querySelectorAll('.waiting')).map((e) => squash(txt(e))),
      notices: Array.from(el.querySelectorAll('.notice, .fatal')).map((e) => squash(txt(e))),
      // _renderFoot returns nothing while a turn is pending or streaming, so no
      // footer IS the rendered definition of "still live".
      live: el.querySelectorAll('.foot').length === 0,
      hasMarker: arg.markerStart ? text.includes(arg.markerStart) : false,
      _text: text,
    };
  });
  let i = -1;
  for (let k = 0; k < turns.length; k += 1) if (turns[k].hasMarker) i = k;
  if (i < 0 && arg.prompt) {
    for (let k = 0; k < turns.length; k += 1) if (turns[k].prompt === arg.prompt) i = k;
  }
  if (i < 0 && turns.length) i = turns.length - 1;
  const text = i >= 0 ? turns[i]._text : '';
  for (const t of turns) delete t._text;

  const out = {
    target: i,
    turn: i >= 0 ? turns[i] : null,
    text: arg.wantText ? text : '',
    bytes: text.length,
    cosTurnCount: turns.length,
    turnsWithThisPrompt: arg.prompt ? turns.filter((t) => t.prompt === arg.prompt).length : 0,
    liveTurns: turns.filter((t) => t.live).length,
    muxCosPresent: q('mux-cos').length > 0,
  };
  if (!arg.geo) return out;

  const body = q('.chatbody')[0];
  if (!body) return { ...out, screen: { ok: false, why: 'no .chatbody in the DOM' } };
  const br = body.getBoundingClientRect();
  // The visible box is the scroller's box intersected with the window: a
  // chatbody hanging off the bottom of a short window is not readable either.
  const vis = { top: Math.max(br.top, 0), bottom: Math.min(br.bottom, window.innerHeight) };
  const frac = (r) => (!r || r.height <= 0 ? 0
    : Math.round((Math.max(0, Math.min(r.bottom, vis.bottom) - Math.max(r.top, vis.top)) / r.height) * 1000) / 1000);
  const S = {
    ok: true,
    scrollTop: Math.round(body.scrollTop),
    scrollHeight: body.scrollHeight,
    clientHeight: body.clientHeight,
    clientWidth: body.clientWidth,
    distanceFromBottom: Math.round(body.scrollHeight - body.scrollTop - body.clientHeight),
    visibleBox: { top: Math.round(vis.top), bottom: Math.round(vis.bottom) },
  };
  if (i < 0) return { ...out, screen: S };

  const says = Array.from(els[i].querySelectorAll('p.say'));
  const say = (arg.markerStart && says.find((e) => (e.textContent || '').includes(arg.markerStart)))
    || says[says.length - 1] || null;
  if (say) {
    const r = say.getBoundingClientRect();
    S.say = { found: true, heightPx: Math.round(r.height), visibleFraction: frac(r),
              fullyBelowFold: r.top >= vis.bottom - 1 };
  } else {
    S.say = { found: false };
  }
  // Where a marker SITS, from a Range over the text itself. This is the only
  // honest way to ask "could the user see the end of the reply".
  const rect = (needle) => {
    if (!say || !needle) return null;
    const w = document.createTreeWalker(say, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const at = n.data.indexOf(needle);
      if (at < 0) continue;
      const rg = document.createRange();
      rg.setStart(n, at); rg.setEnd(n, at + needle.length);
      return rg.getBoundingClientRect();
    }
    return null;
  };
  for (const [key, needle] of [['markerStart', arg.markerStart], ['markerEnd', arg.markerEnd]]) {
    const r = rect(needle);
    S[key] = r ? { found: true, visible: r.bottom <= vis.bottom + 1 && r.top >= vis.top - 1,
                   pxBelowFold: Math.round(r.top - vis.bottom) }
               : { found: false, visible: false };
  }
  // The last block with any of itself inside the box: what makes "the thinking
  // block is the last thing visible" a measurement rather than an impression.
  const bd = els[i].querySelector('.bd') || els[i];
  const seen = Array.from(bd.children)
    .map((c) => ({ cls: String(c.className || ''), visibleFraction: frac(c.getBoundingClientRect()),
                   head: squash(txt(c)).slice(0, 48) }))
    .filter((b) => b.visibleFraction > 0.02);
  S.lastVisibleBlock = seen.length ? seen[seen.length - 1] : null;
  return { ...out, screen: S };
}`;

const read = (page, arg) =>
  page.evaluate(`(${READ})(${JSON.stringify({ prompt: scenario, ...arg })})`).catch((e) => ({
    target: -1, turn: null, text: '', bytes: 0, cosTurnCount: 0, turnsWithThisPrompt: 0,
    liveTurns: 0, muxCosPresent: false, readError: String(e?.message || e),
  }));

// One deep walk for the composer, reused: presence, focus and typing all need
// the same element, and s3's Escape only raises `home-dismiss` if it is focused.
const COMPOSER = `(() => {
  const w = (r) => { for (const e of r.querySelectorAll('*')) {
    if (e.matches('textarea.ctext')) return e;
    if (e.shadowRoot) { const f = w(e.shadowRoot); if (f) return f; } } return null; };
  return w(document);
})()`;
const composerPresent = (p) => p.evaluate(`${COMPOSER} !== null`).catch(() => false);
const focusComposer = (p) => p.evaluate(`${COMPOSER}?.focus()`).catch(() => {});

/** The Dashboard IS home (app.ts _onDashboardShow), reachable two ways. */
async function openDashboard(page) {
  if (await composerPresent(page)) return 'already-open';
  await page.keyboard.press('Control+`');          // config.ts keys.toggleHome
  await sleep(600);
  if (await composerPresent(page)) return 'ctrl+`';
  // The event both the chord and the sidebar's Start card ultimately raise.
  await page.evaluate(`document.querySelector('mux-app')
    ?.dispatchEvent(new CustomEvent('home-show', { bubbles: true, composed: true }))`);
  await sleep(800);
  return (await composerPresent(page)) ? 'home-show-event' : '';
}

// --- the sidecar's own record ----------------------------------------------

const turnsJsonl = path.join(sidecarDir, 'turns.jsonl');

function sidecarRecords(prompt) {
  let raw = '';
  try { raw = fs.readFileSync(turnsJsonl, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.prompt === prompt) out.push(rec);
    } catch { /* a half-written line: it will be complete next poll */ }
  }
  return out;
}

/** Block until the SIDECAR says this turn is over.
 *
 *  `before` is the record count taken BEFORE the prompt was submitted, and it is
 *  a parameter rather than a first poll for a reason: an s6-nostream turn
 *  finishes in about a millisecond, so a count taken on entry can already
 *  include this turn's own record - and the wait would then look for a SECOND
 *  one until the timeout, reporting an instant turn as a hung one. */
async function waitForSidecarTurn(prompt, deadline, before) {
  while (Date.now() < deadline) {
    const recs = sidecarRecords(prompt);
    if (recs.length > before) return recs[recs.length - 1];
    await sleep(250);
  }
  const recs = sidecarRecords(prompt);
  return recs.length > before ? recs[recs.length - 1] : null;
}

/** The size the prompt asks for, before the turn has produced one. */
function requestedSize(prompt) {
  const m = /size:(\d+)/i.exec(prompt);
  if (m) return Number(m[1]);
  if (/s6-histcap/i.test(prompt)) return 3000;
  if (/s6-empty/i.test(prompt)) return 0;
  return 40000;
}

// --- run -------------------------------------------------------------------

const report = { scenario, mode, label, url, viewport, startedAt: new Date().toISOString() };
let exitCode = 0;
let context = null;
let page = null;
const contexts = [];
const browser = await chromium.launch({ headless: !argv.includes('--headed') });

async function bootPage(tag, ctx) {
  const p = await ctx.newPage();
  instrument(p, tag);
  const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);   // let the app boot, connect its socket and settle
  return { page: p, status: resp ? resp.status() : 0 };
}

try {
  context = await makeContext();
  contexts.push(context);
  const booted = await bootPage('A', context);
  page = booted.page;
  report.httpStatus = booted.status;
  report.dashboardOpenedVia = await openDashboard(page);
  if (!report.dashboardOpenedVia) throw new Error('could not find the cos composer');
  mark('dashboard open', { status: booted.status, via: report.dashboardOpenedVia });

  // The subscribe is what boots the sidecar; wait for the server to say so.
  for (let i = 0; i < 150 && !received.some((f) => f.type === 'cos-subscribe-result'); i += 1) {
    await sleep(200);
  }
  report.subscribed = received.some((f) => f.type === 'cos-subscribe-result');

  // Typed through a real input event so Lit's @input updates _draft (mux-cos.ts
  // _onDraft); pressing Enter is what a user does.
  await page.evaluate(`((text) => {
    const ta = ${COMPOSER};
    ta.focus();
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  })(${JSON.stringify(scenario)})`);
  await sleep(200);
  const recordsBefore = sidecarRecords(scenario).length;   // BEFORE Enter
  const submittedAt = ms();
  await page.keyboard.press('Enter');
  mark('submitted');

  const deadline = Date.now() + timeoutMs;
  const wantBytes = Math.max(1, Math.round(requestedSize(scenario) * AWAY_FRAC));

  /** Wait until the stream is demonstrably running (first delta anywhere). */
  async function waitForStreamStart() {
    while (Date.now() < deadline) {
      if (received.some((f) => f.ev === 'delta')) return true;
      if ((await read(page, {})).bytes > 0) return true;
      await sleep(100);
    }
    return false;
  }

  /** Wait until roughly `wantBytes` of the payload has arrived. */
  async function waitForFraction() {
    while (Date.now() < deadline) {
      const n = wireDeltaBytes();
      if (n >= wantBytes) return { reached: n, via: 'wire' };
      if (terminalFrame('')) return { reached: n, via: 'turn-already-ended' };
      await sleep(100);
    }
    return { reached: 0, via: 'timeout' };
  }

  // --- the away action ------------------------------------------------------
  report.away = { mode };
  if (mode === 's1') {
    report.away.streamStarted = await waitForStreamStart();
    await sleep(AWAY_AFTER_MS);
    report.away.domBytesWhenClosed = (await read(page, {})).bytes;
    report.away.wireBytesWhenClosed = wireDeltaBytes();
    mark('closing the whole context (page gone)', report.away);
    await context.close();
    context = null;
    page = null;
  } else if (mode === 's3') {
    report.away.streamStarted = await waitForStreamStart();
    await sleep(AWAY_AFTER_MS);
    // Escape IN THE COMPOSER raises `home-dismiss` (mux-cos.ts), which app.ts
    // binds to _onDashboardHide; pressed anywhere else it does nothing.
    await focusComposer(page);
    await page.keyboard.press('Escape');
    await sleep(500);
    const gone = await read(page, {});
    report.away.muxCosLeftTheDom = gone.muxCosPresent === false;
    if (gone.muxCosPresent) report.away.warning = 'Escape did not take <mux-cos> out of the DOM';
    mark('dashboard dismissed (Escape)', { left: report.away.muxCosLeftTheDom });
  } else if (mode === 's4') {
    const frac = await waitForFraction();
    report.away.bytesBeforeReload = frac.reached;
    report.away.fractionVia = frac.via;
    mark('reloading mid-stream', { bytes: frac.reached, target: wantBytes });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);
    report.away.dashboardReopenedVia = await openDashboard(page);
    mark('dashboard reopened after reload', { via: report.away.dashboardReopenedVia });
  } else if (mode === 's5') {
    const frac = await waitForFraction();
    report.away.bytesBeforeKill = frac.reached;
    report.away.fractionVia = frac.via;
    const killed = await page.evaluate(`(() => {
      const socks = window.__cosSockets || [];
      let n = 0;
      for (const s of socks) if (s.readyState <= 1) { s.close(4001, 'repro-kill'); n += 1; }
      return { killed: n, socketsBefore: socks.length };
    })()`);
    report.away.socketKill = killed;
    mark('websocket killed from inside the page', { ...killed, bytes: frac.reached });
    // Let the app's own backoff (ws.ts _scheduleReconnect) do its job.
    const reDeadline = Math.min(deadline, Date.now() + 60000);
    let re = null;
    while (Date.now() < reDeadline) {
      const st = await page.evaluate(`(() => { const s = window.__cosSockets || [];
        return { sockets: s.length, open: s.filter((x) => x.readyState === 1).length }; })()`)
        .catch(() => null);
      if (st && st.sockets > killed.socketsBefore && st.open > 0) { re = st; break; }
      await sleep(200);
    }
    report.away.reconnected = re !== null;
    mark('reconnect', { ok: re !== null, state: re });
  }

  // --- the turn is over, server-side ----------------------------------------
  const rec = await waitForSidecarTurn(scenario, deadline, recordsBefore);
  report.sidecarRecord = rec;
  report.sidecarTurnDoneAtMs = ms();
  if (!rec) report.sidecarMissingReason = `no record in ${turnsJsonl} within ${timeoutMs}ms`;
  const turnId = rec?.turn_id || received.find((f) => f.ev === 'turn_start')?.turn_id || '';
  report.turnId = turnId;
  mark('sidecar reports turn over', { turn_id: turnId, bytes: rec?.actual_bytes });

  // s1: a FRESH page. Only the server's history replay can put the answer here.
  if (mode === 's1') {
    context = await makeContext();
    contexts.push(context);
    page = (await bootPage('B', context)).page;
    report.away.freshDashboardVia = await openDashboard(page);
    if (!report.away.freshDashboardVia) throw new Error('fresh page: no cos composer');
    mark('fresh dashboard open', { via: report.away.freshDashboardVia });
  } else if (mode === 's3') {
    report.away.dashboardReopenedVia = await openDashboard(page);
    if (!report.away.dashboardReopenedVia) throw new Error('s3: could not reopen the dashboard');
    mark('dashboard reopened', { via: report.away.dashboardReopenedVia });
  }

  // Keep waiting for the browser's own terminal event - which is the claim under
  // test, so absent is a RESULT, not an error. Two ways to stop, and the
  // difference matters: a browser still chewing through a backlog is not
  // finished however long it takes (that lag IS the measurement on a 4MB reply),
  // so arriving frames keep the wait alive; a browser that has received nothing
  // for graceMs after the sidecar finished has nothing more coming. Progress is
  // measured ON THE WIRE, in this process, deliberately not by polling the DOM:
  // reading a 4MB transcript out of the page is real work for the renderer being
  // timed.
  const graceMs = Number(process.env.MUXTERM_REPRO_TERMINAL_GRACE_MS || '15000');
  let term = null;
  let why = 'timeout';
  let lastSeen = -1;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    term = terminalFrame(turnId);
    if (term) { why = 'terminal event arrived'; break; }
    if (received.length !== lastSeen) { lastSeen = received.length; lastChange = Date.now(); }
    if (rec && Date.now() - lastChange > graceMs) {
      why = `sidecar finished and no cos frame reached the browser for ${graceMs}ms`;
      break;
    }
    await sleep(500);
  }
  report.terminalEvent = term ? { ev: term.ev, atMs: term.t, page: term.page } : null;
  report.terminalWaitEndedBecause = why;
  mark('browser terminal event', term ? { ev: term.ev, page: term.page } : { seen: false, why });

  // --- settle ---------------------------------------------------------------
  const settleStart = Date.now();
  let stable = 0;
  let last = -1;
  report.settled = false;
  while (Date.now() - settleStart < settleCapMs) {
    const d = await read(page, {});
    if (d.bytes === last) { if (++stable >= 3) { report.settled = true; break; } }
    else { stable = 0; last = d.bytes; }
    await sleep(500);
  }
  report.settleMs = Date.now() - settleStart;

  // --- expected, straight from what the sidecar recorded --------------------
  // s6-empty's correct expectation IS the empty string, so "0 bytes were sent"
  // must not read as "nobody knows what was sent": the file is the authority.
  let expected = null;
  const payloadFile = turnId ? path.join(sidecarDir, `payload-${turnId}.txt`) : '';
  if (payloadFile && fs.existsSync(payloadFile)) {
    expected = fs.readFileSync(payloadFile, 'utf8');
    report.expectedFrom = payloadFile;
  } else {
    report.expectedMissingReason = payloadFile
      ? `no such file: ${payloadFile} (the sidecar never reached turn_end)`
      : 'no turn id could be resolved';
  }
  const chunks = (s) => (s.match(/\[\[chunk-\d{4}\]\]/g) || []).length;
  const markerStart = turnId ? `MARKER-START-${turnId}` : '';
  const markerEnd = turnId ? `MARKER-END-${turnId}` : '';
  report.expected = expected === null ? null
    : { bytes: expected.length, chunkTokens: chunks(expected) };

  const fin = await read(page, { markerStart, markerEnd, wantText: true, geo: true });
  const say = fin.text;
  const T = fin.turn || {};

  // --- layer 1 --------------------------------------------------------------
  const cos = received.filter((f) => f.type.startsWith('cos-'));
  const byEv = {};
  const byPage = {};
  let wireDelta = '';
  let wireTurnEnd = '';
  let turnEnds = 0;
  for (const f of cos) {
    if (f.type !== 'cos-event') continue;
    byEv[f.ev || '?'] = (byEv[f.ev || '?'] || 0) + 1;
    byPage[f.page] = (byPage[f.page] || 0) + 1;
    if (!f.event || (turnId && f.turn_id && f.turn_id !== turnId)) continue;
    if (f.ev === 'delta' && typeof f.event.text === 'string') wireDelta += f.event.text;
    else if (f.ev === 'turn_end' && typeof f.event.response === 'string') {
      wireTurnEnd = f.event.response;
      turnEnds += 1;
    }
  }
  // A history replay arrives as its own frame type, not as cos-event. In s1/s4
  // it is the ONLY way the answer can reach a page that missed the stream.
  let histText = 0;
  let histBlocks = 0;
  const histFrames = cos.filter((f) => f.type === 'cos-history');
  for (const f of histFrames) {
    for (const t of f.turns || []) {
      for (const b of t.blocks || []) {
        histBlocks += 1;
        if (b.kind === 'text') histText += (b.text || '').length;
      }
    }
  }
  report.wire = {
    cosFrameCount: cos.length,
    cosFrameBytes: cos.reduce((a, f) => a + f.bytes, 0),
    largestFrameBytes: cos.reduce((a, f) => Math.max(a, f.bytes), 0),
    eventsByEv: byEv,
    eventFramesByPage: byPage,
    deltaBytes: wireDelta.length,
    turnEndResponseBytes: wireTurnEnd.length,
    turnEndReachedBrowser: turnEnds > 0,
    turnEndMatchesExpected: expected === null ? null : wireTurnEnd === expected,
    historyFrames: histFrames.length,
    historyBlocks: histBlocks,
    historyTextBytes: histText,
    socketClosed,
    socketClosedDuringTurn: socketClosed && socketClosedAt >= submittedAt,
  };

  // --- layer 2 --------------------------------------------------------------
  report.dom = {
    ...T,
    sayBytes: say.length,
    targetTurnIndex: fin.target,
    targetFoundBy: fin.target < 0 ? 'none' : T.hasMarker ? 'marker' : 'prompt-or-last',
    cosTurnsRendered: fin.cosTurnCount,
    turnsWithThisPrompt: fin.turnsWithThisPrompt,
    liveTurnsStillRendered: fin.liveTurns,
    endedWithoutAReply: (T.waiting || []).includes('ended without a reply'),
    hasMarkerStart: expected === null ? null : say.includes(markerStart),
    hasMarkerEnd: expected === null ? null : say.includes(markerEnd),
    chunkTokens: chunks(say),
    matchesExpected: expected === null ? null : say === expected,
    firstDivergenceAt: null,
  };
  delete report.dom.prompt;
  if (expected !== null && say !== expected) {
    let i = 0;
    const n = Math.min(expected.length, say.length);
    while (i < n && expected[i] === say[i]) i += 1;
    report.dom.firstDivergenceAt = i;
    report.dom.expectedAround = expected.slice(Math.max(0, i - 60), i + 60);
    report.dom.domAround = say.slice(Math.max(0, i - 60), i + 60);
  }

  // --- layer 3 --------------------------------------------------------------
  const S = fin.screen || { ok: false, why: 'geometry not read' };
  report.screen = {
    ...S,
    markerEndVisible: S.ok && S.markerEnd ? S.markerEnd.visible : null,
    // Following, inferred FROM GEOMETRY ONLY: what the user ends up seeing, not
    // what the code believed about itself.
    followingAtEnd: S.ok ? S.distanceFromBottom <= PIN_PX : null,
  };

  fs.writeFileSync(path.join(outDir, `dom-${label}.txt`), say);
  await page.screenshot({ path: path.join(outDir, `shot-${label}.png`) }).catch(() => {});

  // --- verdict --------------------------------------------------------------
  const exp = report.expected;
  const lostOnWire = !!exp && wireTurnEnd.length < exp.bytes && wireDelta.length < exp.bytes
    && histText < exp.bytes;
  report.verdict = {
    rendered: exp ? report.dom.matchesExpected === true : null,
    where: !exp ? 'unknown (no expected payload)'
      : exp.bytes === 0 ? 'n/a - this turn had no reply to lose'
      : lostOnWire ? 'WIRE - the payload never reached the browser'
      : report.dom.sayBytes < exp.bytes ? 'DOM - the browser received it, the DOM does not show it'
      : 'nowhere - full payload present in the DOM',
    // IN THE DOM and ON THE SCREEN are different claims.
    onScreen: S.ok ? report.screen.markerEndVisible === true : null,
    duplicateTurns: report.dom.turnsWithThisPrompt > 1,
    stuckLive: report.dom.liveTurnsStillRendered > 0,
  };

  const pct = exp && exp.bytes ? `${((say.length / exp.bytes) * 100).toFixed(2)}%` : 'n/a';
  console.log(['', '='.repeat(72),
    `SCENARIO ${scenario}  mode=${mode}  turn=${turnId || '(none)'}`,
    `EXPECTED ${exp ? `${exp.bytes}B, ${exp.chunkTokens} chunk tokens` : report.expectedMissingReason}`,
    `WIRE     delta ${wireDelta.length}B  turn_end ${wireTurnEnd.length}B reached=${turnEnds > 0}`
      + `  history ${histFrames.length} frame(s)/${histBlocks} blocks/${histText}B  by ev ${JSON.stringify(byEv)}`,
    `DOM      p.say ${say.length}B in ${T.sayNodes ?? 0} node(s) = ${pct} of expected`
      + `  (turn #${fin.target} of ${fin.cosTurnCount} by ${report.dom.targetFoundBy})`,
    `         markers ${report.dom.hasMarkerStart}/${report.dom.hasMarkerEnd}`
      + `  chunks ${report.dom.chunkTokens}/${exp ? exp.chunkTokens : '?'}`
      + `  identical ${report.dom.matchesExpected}  divergence@ ${report.dom.firstDivergenceAt}`,
    `         thoughts ${T.thoughtNodes ?? 0}  tools ${T.toolNodes ?? 0}`
      + `  waiting ${JSON.stringify(T.waiting || [])}  stuckLive ${fin.liveTurns}`,
    S.ok ? `SCREEN   .chatbody ${S.clientWidth}x${S.clientHeight}  scrollHeight ${S.scrollHeight}`
      + `  distFromBottom ${S.distanceFromBottom}px  following ${report.screen.followingAtEnd}\n`
      + `         MARKER-END on screen: ${report.screen.markerEndVisible}`
      + (S.markerEnd?.found ? ` (${S.markerEnd.pxBelowFold}px below fold)` : ' (not in the DOM)')
      + `  last visible: ${S.lastVisibleBlock ? `${S.lastVisibleBlock.cls} "${S.lastVisibleBlock.head}"` : 'NONE'}`
      : `SCREEN   UNMEASURED: ${S.why}`,
    `VERDICT  rendered ${report.verdict.rendered}  onScreen ${report.verdict.onScreen}`
      + `  lost: ${report.verdict.where}`,
    `         settled ${report.settled} in ${report.settleMs}ms  report ${reportPath}`,
    '='.repeat(72)].join('\n'));

  if (report.verdict.rendered !== true) exitCode = 1;
  // Complete in the DOM and off the screen is a FAILURE, or a matrix reads as
  // all-green. A turn with no reply is exempt: there is no MARKER-END to see.
  if (exp && exp.bytes > 0 && report.verdict.onScreen === false) exitCode = 1;
} catch (err) {
  report.harnessError = String(err?.stack || err);
  console.error(`\nHARNESS ERROR: ${report.harnessError}`);
  exitCode = 3;
} finally {
  report.wallMs = ms();
  report.timeline = timeline;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.closeSync(consoleFd);
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close().catch(() => {});
}

process.exit(exitCode);
