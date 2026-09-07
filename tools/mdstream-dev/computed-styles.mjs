#!/usr/bin/env node
/**
 * computed-styles.mjs -- what the browser RESOLVED, for the things a
 * screenshot cannot be trusted on.
 *
 * Vision models are unreliable about typography at screenshot resolution --
 * a 13px italic run and a 13px roman run look alike to them. So the visual
 * claims that hinge on computed CSS are read back from the browser instead of
 * guessed at from a picture.
 */
const CDP = process.argv[2] ?? 'http://127.0.0.1:9333';

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    p(msg);
  }
};
const send = (method, params) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result.result.value;
};

const out = await evaluate(`(async () => {
  const md = window.__md;
  await md.reset();
  await md.start();
  await md.delta([
    '# Release notes',
    '',
    'This is **bold** and *italic* with \\u0060code\\u0060 and [a link](https://example.com/r).',
    '',
    '- bullet',
    '',
    '1. numbered',
    '',
    '| lane | state |',
    '| --- | --- |',
    '| alpha | working |',
    '',
    '> quoted',
    '',
    '\\u0060\\u0060\\u0060go',
    'func main() { println("x") }',
    '\\u0060\\u0060\\u0060',
  ].join('\\n'));
  await md.end();
  const say = md.say();
  const pick = (sel, props) => {
    const el = say.querySelector(sel);
    if (!el) return { sel, missing: true };
    const cs = getComputedStyle(el);
    const o = { sel, text: el.textContent.trim().slice(0, 24) };
    for (const p of props) o[p] = cs[p];
    return o;
  };
  const pre = say.querySelector('pre.md-pre');
  return {
    rows: [
      pick('strong', ['fontWeight']),
      pick('em', ['fontStyle']),
      pick('code.md-code', ['fontFamily', 'backgroundColor']),
      pick('pre.md-pre code', ['fontFamily', 'whiteSpace']),
      pick('a.md-link', ['textDecorationLine', 'color']),
      pick('ul.md-ul', ['listStyleType', 'paddingLeft']),
      pick('ol.md-ol', ['listStyleType']),
      pick('table.md-table', ['borderCollapse']),
      pick('th.md-th', ['borderTopWidth', 'fontWeight']),
      pick('h1.md-h', ['fontSize', 'fontWeight']),
      pick('blockquote.md-quote', ['borderLeftWidth', 'borderLeftStyle']),
    ],
    overflow: {
      preScrollW: pre.scrollWidth,
      preClientW: pre.clientWidth,
      preOverflowX: getComputedStyle(pre).overflowX,
      sayW: Math.round(say.getBoundingClientRect().width),
      widestChildW: Math.max(...[...say.children].map((c) => Math.round(c.getBoundingClientRect().width))),
    },
  };
})()`);

console.log('\ncomputed styles, read back from Chrome:\n');
for (const r of out.rows) {
  if (r.missing) {
    console.log(`  MISSING  ${r.sel}`);
    continue;
  }
  const { sel, text, ...props } = r;
  console.log(
    `  ${sel.padEnd(22)} ${JSON.stringify(text).padEnd(26)} ${Object.entries(props)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ')}`,
  );
}
console.log('\noverflow containment:');
console.log(`  <pre> scrollWidth=${out.overflow.preScrollW} clientWidth=${out.overflow.preClientW} overflow-x=${out.overflow.preOverflowX}`);
console.log(`  message width=${out.overflow.sayW}  widest child=${out.overflow.widestChildW}  (child must not exceed message)`);

ws.close();
process.exit(0);
