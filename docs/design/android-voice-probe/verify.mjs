#!/usr/bin/env node
/*
 * verify.mjs -- proves the probe is a working instrument before anyone is
 * asked to run it on a phone.
 *
 * It cannot test the thing the probe exists to test: there is no way to turn
 * a headless browser's screen off. What it CAN do, and does, is prove that
 * every instrument fires -- microphone granted and analysed, tone generated
 * and played, AudioWorklet frame counters advancing, wake lock acquired,
 * MediaSession registered, service worker capabilities measured, event trail
 * persisted to localStorage, freeze/resume observed, report rendered.
 *
 * An instrument that has never been seen to move is not evidence.
 *
 * Usage:
 *   # 1. serve the probe
 *   python3 serve.py 8478 &
 *   # 2. launch a headless Chrome with a fake microphone
 *   google-chrome --headless=new --remote-debugging-port=9333 \
 *       --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
 *       --autoplay-policy=no-user-gesture-required \
 *       --user-data-dir=$(mktemp -d) about:blank &
 *   # 3. drive it
 *   node verify.mjs 9333 http://127.0.0.1:8478/index.html
 *
 * Requires Node 22+ (uses the built-in global WebSocket). No dependencies.
 */

const CDP_PORT = process.argv[2] ? Number(process.argv[2]) : 9333;
const TARGET_URL = process.argv[3] || 'http://127.0.0.1:8478/index.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        c.pending.get(m.id)(m);
        c.pending.delete(m.id);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        c.logs.push(
          m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
        );
      } else if (m.method === 'Runtime.exceptionThrown') {
        c.logs.push(
          'EXCEPTION: ' +
            (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text),
        );
      } else if (m.method === 'Log.entryAdded') {
        c.logs.push(m.params.entry.level + ' [' + m.params.entry.source + '] ' + m.params.entry.text);
      }
    };
    return c;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, (m) =>
        m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result),
      );
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        'eval threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text),
      );
    }
    return r.result.value;
  }
}

const checks = [];
function check(ok, label, detail) {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target on CDP port ' + CDP_PORT);

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  console.log('\n== navigate ==');
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(2500);

  const boot = await cdp.eval(`({
    title: document.title,
    secure: window.isSecureContext,
    displayMode: window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
    hasStart: !!document.getElementById('startBtn'),
    banner: document.getElementById('secureBanner').textContent.trim().slice(0, 100),
  })`);
  console.log(JSON.stringify(boot, null, 2));
  check(boot.title.includes('voice probe'), 'page loads');
  check(boot.secure === true, 'secure context', 'isSecureContext=' + boot.secure);
  check(boot.hasStart, 'START button present');

  console.log('\n== start the run ==');
  await cdp.eval(`document.getElementById('startBtn').click(); 'clicked'`);
  await sleep(10000);

  const live = await cdp.eval(`({
    state:  document.getElementById('lState').textContent,
    vis:    document.getElementById('lVis').textContent,
    wake:   document.getElementById('lWake').textContent,
    mic:    document.getElementById('lMic').textContent,
    micRms: document.getElementById('lMicRms').textContent,
    outRms: document.getElementById('lOutRms').textContent,
    drift:  document.getElementById('lDrift').textContent,
    frames: document.getElementById('lFrames').textContent,
    hb:     document.getElementById('lHb').textContent,
    events: document.getElementById('lEvents').textContent,
  })`);
  console.log(JSON.stringify(live, null, 2));

  const names = await cdp.eval(`JSON.parse(localStorage.getItem('avp.events') || '[]').map(e => e.e)`);
  console.log('event names:', JSON.stringify(names));
  const hb = await cdp.eval(`JSON.parse(localStorage.getItem('avp.hb') || 'null')`);
  console.log('last heartbeat:', JSON.stringify(hb));

  check(live.state === 'running', 'run started', 'state=' + live.state);
  check(names.includes('mic.granted'), 'microphone capture opened');
  check(names.includes('audioctx.created'), 'AudioContext created');
  check(names.includes('worklet.ready'), 'AudioWorklet loaded');
  check(names.includes('audio.play.ok'), 'MediaStream <audio> element playing');
  check(names.includes('mediasession.ready'), 'MediaSession registered');
  check(
    names.includes('wakelock.acquired') || names.includes('wakelock.rejected') || names.includes('wakelock.unsupported'),
    'wake lock path exercised',
  );
  check(names.includes('sw.capabilities'), 'service worker answered the capability probe');
  check(Number(live.hb) >= 8, 'heartbeat ticking', live.hb + ' ticks in ~10s');
  check(hb && hb.wl && hb.wl.frames > 0, 'worklet frame counters advancing', hb?.wl ? hb.wl.frames + ' frames' : 'none');
  check(Number(live.outRms) > 0.001, 'speaker level non-zero', 'outRms=' + live.outRms);
  check(Number(live.micRms) > 0.0001, 'microphone level non-zero', 'micRms=' + live.micRms);
  check(hb && hb.ac > 5, 'audio clock advancing', 'ctx.currentTime=' + hb?.ac);

  console.log('\n== freeze / resume cycle ==');
  let frozeOk = false;
  try {
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await sleep(4000);
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    frozeOk = true;
  } catch (e) {
    console.log('  (Page.setWebLifecycleState unavailable: ' + e.message.slice(0, 80) + ')');
  }
  await sleep(4000);
  const names2 = await cdp.eval(`JSON.parse(localStorage.getItem('avp.events') || '[]').map(e => e.e)`);
  console.log('event names after freeze:', JSON.stringify(names2));
  if (frozeOk) {
    check(names2.includes('freeze'), 'freeze event captured and persisted');
    check(names2.includes('resume'), 'resume event captured and persisted');
    check(names2.includes('gap'), 'heartbeat gap detected across the freeze');
    const gap = await cdp.eval(
      `(JSON.parse(localStorage.getItem('avp.events')||'[]').filter(e=>e.e==='gap').slice(-1)[0]||null)`,
    );
    console.log('  last gap:', JSON.stringify(gap));
    check(
      gap && typeof gap.d.audioOverWall === 'number',
      'audio-clock-vs-wall-clock ratio measured across the gap',
      gap ? 'ratio=' + gap.d.audioOverWall : '',
    );
  }

  console.log('\n== report ==');
  await cdp.eval(`document.getElementById('reportBtn').click(); 'ok'`);
  await sleep(600);
  const verdicts = await cdp.eval(
    `Array.from(document.querySelectorAll('#verdicts .verdict')).map(d => d.className.replace('verdict ','').toUpperCase() + ' | ' + d.querySelector('b').textContent)`,
  );
  verdicts.forEach((v) => console.log('   ' + v));
  const report = await cdp.eval(`document.getElementById('reportOut').textContent`);
  check(verdicts.length >= 6, 'verdicts rendered', verdicts.length + ' lines');
  check(report.length > 1500, 'text report rendered', report.length + ' chars');
  check(report.includes('EVENT TRAIL'), 'report contains the event trail');
  check(report.includes('service worker capabilities'), 'report contains the measured SW capabilities');

  console.log('\n===== REPORT =====\n' + report.slice(0, 6000));

  const errs = cdp.logs.filter((l) => /EXCEPTION|error \[/i.test(l));
  console.log('\n===== CONSOLE (' + cdp.logs.length + ' lines, errors below) =====');
  errs.slice(0, 20).forEach((l) => console.log('  ' + l));
  check(errs.length === 0, 'no uncaught page errors', errs.length + ' error lines');

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n===== ${checks.length - failed.length}/${checks.length} checks passed =====`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS FAILURE:', e);
  process.exit(2);
});
