/**
 * Runtime proof of the three mandatory properties of the web-side bridge half.
 *
 * Run:  node --experimental-strip-types native-bridge.test.mjs
 *
 * This is a design artifact, not part of the web app's test suite. It exists so
 * the claims in docs/design/webview-wrapper.md W4.5 are demonstrated rather than
 * asserted:
 *
 *   1. absent by default   — no wrapper, no behaviour, no throw
 *   2. capability-gated    — an old wrapper announces less and is handled
 *   3. timeouts, not hangs — a command with no reply resolves, it does not hang
 */

import assert from 'node:assert/strict';
import * as bridge from './native-bridge.ts';

const V = 1;
let failures = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((e) => {
      failures++;
      console.log(`  FAIL ${name}\n       ${e.message}`);
    });
}

/** A fake host channel with the same two members the wrapper injects. */
function makeHost({ autoReady = null, replies = {} } = {}) {
  const sent = [];
  const host = {
    postMessage(data) {
      const env = JSON.parse(data);
      sent.push(env);
      const reply = replies[env.type];
      if (reply && env.id) {
        queueMicrotask(() =>
          host.onmessage?.({ data: JSON.stringify({ v: V, type: env.type, id: env.id, payload: reply }) }),
        );
      }
    },
    onmessage: null,
  };
  if (autoReady) {
    queueMicrotask(() =>
      host.onmessage?.({ data: JSON.stringify({ v: V, type: 'ready', payload: autoReady }) }),
    );
  }
  return { host, sent };
}

const ANDROID_READY = {
  platform: 'android',
  appVersion: '0.1.0',
  capabilities: ['voice.fgs', 'osSettings'],
};

console.log('\n1. absent by default');

await check('install() in a browser-like env finds nothing', () => {
  bridge._resetForTest();
  bridge.install();
  assert.equal(bridge.available(), false);
  assert.deepEqual([...bridge.capabilities()], []);
  assert.equal(bridge.has('voice.fgs'), false);
});

await check('every method is a safe no-op with no wrapper', async () => {
  bridge._resetForTest();
  assert.equal(await bridge.startVoiceService('s1'), false);
  bridge.stopVoiceService('s1');
  bridge.reportVoiceState('listening');
  bridge.keepAwake(true);
  bridge.openOsSettings('microphone');
  bridge.log('info', 'nothing should happen');
});

console.log('\n2. capability-gated, not version-gated');

await check('ready announces capabilities and they gate the API', async () => {
  bridge._resetForTest();
  const { host, sent } = makeHost({ autoReady: ANDROID_READY, replies: { 'voice.start': { ok: true } } });
  const seen = [];
  bridge.subscribe((e) => seen.push(e.type));
  bridge._installForTest(host);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(bridge.available(), true);
  assert.ok(seen.includes('ready'));
  assert.equal(bridge.has('voice.fgs'), true);
  assert.equal(bridge.has('wakeWord'), false, 'a capability not announced is absent');

  assert.equal(await bridge.startVoiceService('s1'), true);
  assert.equal(sent.at(-1).type, 'voice.start');
  assert.equal(sent.at(-1).v, V);
});

await check('an older wrapper announcing less is handled, not version-checked', async () => {
  bridge._resetForTest();
  const { host, sent } = makeHost({
    autoReady: { platform: 'android', appVersion: '0.0.1', capabilities: [] },
  });
  bridge._installForTest(host);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(bridge.available(), true);
  assert.equal(await bridge.startVoiceService('s1'), false, 'no voice.fgs capability -> false');
  bridge.reportVoiceState('speaking');
  assert.equal(sent.length, 0, 'nothing is sent for an unannounced capability');
});

await check('an unknown envelope version is dropped, never guessed at', async () => {
  bridge._resetForTest();
  const { host } = makeHost();
  const seen = [];
  bridge.subscribe((e) => seen.push(e.type));
  bridge._installForTest(host);
  host.onmessage({ data: JSON.stringify({ v: 99, type: 'ready', payload: ANDROID_READY }) });
  assert.deepEqual(seen, []);
  assert.deepEqual([...bridge.capabilities()], []);
});

await check('an unknown message type from a newer wrapper is dropped, not thrown', async () => {
  bridge._resetForTest();
  const { host } = makeHost({ autoReady: ANDROID_READY });
  bridge._installForTest(host);
  await new Promise((r) => setTimeout(r, 0));
  host.onmessage({ data: JSON.stringify({ v: V, type: 'future.thing', payload: {} }) });
  host.onmessage({ data: 'not json at all' });
  assert.equal(bridge.available(), true, 'still healthy after garbage');
});

console.log('\n3. timeouts, not hangs');

await check('a command with no reply resolves false rather than hanging', async () => {
  bridge._resetForTest();
  const { host } = makeHost({ autoReady: ANDROID_READY }); // no replies configured
  bridge._installForTest(host);
  await new Promise((r) => setTimeout(r, 0));

  const started = Date.now();
  const ok = await bridge.startVoiceService('s1');
  const elapsed = Date.now() - started;
  assert.equal(ok, false);
  assert.ok(elapsed >= 1900 && elapsed < 4000, `resolved by timeout, took ${elapsed}ms`);
});

console.log('\n4. events the page could not learn any other way');

await check('mic.silenced and mic.resumed reach subscribers', async () => {
  bridge._resetForTest();
  const { host } = makeHost({ autoReady: ANDROID_READY });
  const seen = [];
  bridge.subscribe((e) => seen.push(e.type));
  bridge._installForTest(host);
  await new Promise((r) => setTimeout(r, 0));
  host.onmessage({ data: JSON.stringify({ v: V, type: 'mic.silenced', payload: {} }) });
  host.onmessage({ data: JSON.stringify({ v: V, type: 'mic.resumed', payload: {} }) });
  host.onmessage({ data: JSON.stringify({ v: V, type: 'voice.stopRequested', payload: {} }) });
  assert.deepEqual(seen, ['ready', 'mic.silenced', 'mic.resumed', 'voice.stopRequested']);
});

await check('a throwing listener does not stop the others or reach native', async () => {
  bridge._resetForTest();
  const { host } = makeHost({ autoReady: ANDROID_READY });
  const seen = [];
  bridge.subscribe(() => {
    throw new Error('bad listener');
  });
  bridge.subscribe((e) => seen.push(e.type));
  bridge._installForTest(host);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen, ['ready']);
});

await check('an attachment crosses as a URL, never as bytes', async () => {
  bridge._resetForTest();
  const { host } = makeHost({ autoReady: ANDROID_READY });
  let got = null;
  bridge.subscribe((e) => {
    if (e.type === 'attachment') got = e;
  });
  bridge._installForTest(host);
  await new Promise((r) => setTimeout(r, 0));
  host.onmessage({
    data: JSON.stringify({
      v: V,
      type: 'attachment',
      payload: { kind: 'photo', mime: 'image/jpeg', url: 'content://io.ampbox.muxterm/x.jpg' },
    }),
  });
  assert.equal(got.url, 'content://io.ampbox.muxterm/x.jpg');
  assert.equal(got.bytes, undefined, 'no binary payload in the envelope');
});

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
