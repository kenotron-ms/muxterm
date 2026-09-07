#!/usr/bin/env node
/**
 * markdown-stream.mjs -- C1..C10 and ST1..ST6, proven in a REAL BROWSER
 * against a RUNNING DEV INSTANCE, on the real <mux-cos> chat pane.
 *
 * WHY THIS EXISTS ALONGSIDE THE VITEST SUITE. The unit tests render Lit into
 * happy-dom, which is a very good imitation of a browser and is not one. This
 * script proves the same claims where it actually matters: Chrome, the real
 * <mux-cos> element with its real shadow styles, the real cos-store, and
 * frames shaped exactly like the ones internal/server/cos.go sends. Nothing is
 * stubbed except the socket, and the socket is not what is being tested.
 *
 * Every streaming assertion feeds text in CHUNKS through cosStore.handleFrame
 * and reads the DOM BETWEEN chunks. A check that only looked at the finished
 * message could not tell this renderer from a static one.
 *
 * Usage:
 *   tools/mdstream-dev/up.sh
 *   node web/e2e/markdown-stream.mjs [--url URL] [--cdp URL] [--shot DIR]
 *
 * Exit codes:
 *   0 -- every claim held
 *   1 -- a claim failed (the failing claim is printed)
 *   2 -- setup error: dev server or browser not reachable
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : fallback;
};

const APP_URL = argOf('--url', 'http://127.0.0.1:5199/');
const CDP_URL = argOf('--cdp', 'http://127.0.0.1:9333');
const SHOT_DIR = argOf('--shot', '');

/**
 * --frames [ST1|ST2|ST3|ST4|all] -- print the INTERMEDIATE DOM, delta by delta.
 *
 * The verdict ledger says whether ST1..ST4 hold. This says WHY, by showing the
 * thing those items are actually about: what the reader sees while the message
 * is still half-written. A summary of mid-stream behaviour is not mid-stream
 * behaviour, so this is a named reproduction rather than a paragraph -- run
 * `node web/e2e/markdown-stream.mjs --frames ST2` and read the table forming.
 */
const FRAMES = (() => {
  const i = args.indexOf('--frames');
  if (i < 0) return null;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next.toUpperCase() : 'ALL';
})();

// ---------------------------------------------------------------------------
// A very small CDP client. No dependency: Node has WebSocket and fetch.
// ---------------------------------------------------------------------------

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();

  static async attach(base) {
    const targets = await (await fetch(`${base}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target in the browser');
    const c = new Cdp();
    await c.#connect(page.webSocketDebuggerUrl);
    return c;
  }

  #connect(url) {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(url);
      this.#ws.onopen = () => resolve();
      this.#ws.onerror = (e) => reject(new Error(`cdp socket: ${e.message ?? 'failed'}`));
      this.#ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Run an async function body in the page and return its JSON value. */
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlocklistedAPI: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page threw: ${d.exception?.description ?? d.text}`);
    }
    return r.result.value;
  }

  close() {
    this.#ws?.close();
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

/**
 * Every check made in this file, tagged with the item it belongs to.
 *
 * The sixteen-verdict ledger at the bottom is DERIVED from this list rather
 * than written out by hand. A check that is added, removed or renamed moves
 * its item's verdict with it, so the summary cannot quietly disagree with the
 * checks it summarises -- which is the only way a summary is worth reading.
 */
const checks = [];

function claim(id, what, ok, detail = '') {
  checks.push({ id, what, ok, detail });
  if (ok) {
    passed++;
    console.log(`  PASS  ${id.padEnd(5)} ${what}`);
  } else {
    failures.push(`${id} ${what}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL  ${id.padEnd(5)} ${what}${detail ? `\n          ${detail}` : ''}`);
  }
}

/** The closed list. Sixteen items, no more, and each gets exactly one verdict. */
const SUITE = 'node web/e2e/markdown-stream.mjs';
const ITEMS = [
  ['C1', 'bold', SUITE],
  ['C2', 'italic', SUITE],
  ['C3', 'inline code', SUITE],
  ['C4', 'fenced code block', SUITE],
  ['C5', 'link', SUITE],
  ['C6', 'bullet list', SUITE],
  ['C7', 'numbered list', SUITE],
  ['C8', 'table', SUITE],
  ['C9', 'heading', SUITE],
  ['C10', 'blockquote', SUITE],
  ['ST1', 'unclosed fence renders as a code block in progress', `${SUITE} --frames ST1`],
  ['ST2', 'incomplete table renders progressively', `${SUITE} --frames ST2`],
  ['ST3', 'incomplete emphasis neither flashes nor swallows', `${SUITE} --frames ST3`],
  ['ST4', 'no re-mount flicker', `${SUITE} --frames ST4`],
  ['ST5', 'render cost is linear in message length', SUITE],
  ['ST6', 'convergence: streamed == pasted', SUITE],
];

/**
 * Print one terminal verdict per item, and return true when all sixteen pass.
 *
 * SANITIZATION IS A GATE, NOT A ROW. The brief is explicit that it is "a
 * requirement of every PASS above, not a separate item": a construct that
 * renders beautifully and injects unsanitized HTML has not passed. So a failed
 * SAN check does not fail a seventeenth item -- it BLOCKS all sixteen, because
 * every one of them was only ever conditionally true.
 */
function ledger() {
  const san = checks.filter((c) => c.id.startsWith('SAN'));
  const sanFailed = san.filter((c) => !c.ok);

  console.log('\n' + '='.repeat(96));
  console.log('THE SIXTEEN VERDICTS -- one per item, derived from the checks above');
  console.log('='.repeat(96));
  console.log(`ITEM  ${'WHAT'.padEnd(52)}CHECKS  VERDICT`);
  console.log('-'.repeat(96));

  let allPass = true;
  for (const [id, what, repro] of ITEMS) {
    const mine = checks.filter((c) => c.id === id);
    let v, why = '';
    if (sanFailed.length > 0) {
      v = 'BLOCKED';
      why = `sanitization gate failed: ${sanFailed.map((c) => c.id).join(', ')}`;
    } else if (mine.length === 0) {
      v = 'BLOCKED';
      why = 'no check was run for this item';
    } else if (mine.some((c) => !c.ok)) {
      v = 'BLOCKED';
      why = mine.filter((c) => !c.ok).map((c) => c.what).join('; ');
    } else {
      v = 'PASS';
    }
    if (v !== 'PASS') allPass = false;
    console.log(`${id.padEnd(5)} ${what.padEnd(52)}${String(mine.length).padEnd(8)}${v}${why ? `\n      -> ${why}` : ''}`);
    console.log(`      repro: ${repro}`);
  }

  console.log('-'.repeat(96));
  const pass = ITEMS.filter(([id]) => sanFailed.length === 0 && checks.some((c) => c.id === id) && !checks.some((c) => c.id === id && !c.ok)).length;
  console.log(`${ITEMS.length} items, ${pass} PASS, ${ITEMS.length - pass} BLOCKED`);
  console.log(`sanitization gate: ${san.length} checks, ${sanFailed.length} failed ` +
    `(a failure here BLOCKS all sixteen -- it is a requirement of every PASS, not a row of its own)`);

  // Coverage is asserted, not assumed: no item may be missing or duplicated.
  const covered = ITEMS.filter(([id]) => checks.some((c) => c.id === id)).map(([id]) => id);
  const want = ITEMS.map(([id]) => id);
  const stray = [...new Set(checks.map((c) => c.id))].filter((id) => !want.includes(id) && !id.startsWith('SAN'));
  console.log(
    JSON.stringify(covered) === JSON.stringify(want) && stray.length === 0
      ? 'coverage: exactly the sixteen required items, each with at least one check, no strays'
      : `coverage: MISMATCH -- covered ${JSON.stringify(covered)} stray ${JSON.stringify(stray)}`,
  );
  return allPass && JSON.stringify(covered) === JSON.stringify(want) && stray.length === 0;
}

// ---------------------------------------------------------------------------
// The harness that gets installed in the page
// ---------------------------------------------------------------------------

const HARNESS = `
(async () => {
  const { cosStore } = await import('/src/lib/cos-store.ts');
  await import('/src/components/mux-cos.ts');
  await customElements.whenDefined('mux-cos');

  // The real element, mounted for real. Off-screen sizing only; nothing about
  // the render path is bypassed.
  const el = document.createElement('mux-cos');
  el.style.cssText = 'position:absolute;inset:0;width:1280px;height:1600px;';
  document.body.innerHTML = '';
  document.body.appendChild(el);
  await el.updateComplete;

  let turnSeq = 0;

  const frame = (event) =>
    cosStore.handleFrame({ type: 'cos-event', event, replay: false });

  const api = {
    /** Start a fresh turn and return its id. */
    async start(prompt) {
      const id = 'T' + (++turnSeq);
      frame({ ev: 'turn_start', turn_id: id, prompt: prompt || 'evidence' });
      await el.updateComplete;
      api.turn = id;
      return id;
    },
    /** One delta -- exactly what the sidecar sends, one chunk at a time. */
    async delta(text) {
      frame({ ev: 'delta', turn_id: api.turn, text });
      await el.updateComplete;
    },
    async end(response) {
      frame({ ev: 'turn_end', turn_id: api.turn, response: response ?? undefined, ok: true });
      await el.updateComplete;
    },
    /** The assistant message under test: the LAST one in the pane. */
    say() {
      const all = el.shadowRoot.querySelectorAll('.turn.cos .say.md');
      return all[all.length - 1] || null;
    },
    /** The chat pane's own DOM, inside the real shadow root. */
    q(sel) {
      const say = api.say();
      return say ? say.querySelectorAll(sel) : [];
    },
    /** Visible text of the assistant's message, whitespace collapsed. */
    seen() {
      const say = api.say();
      return (say ? say.textContent : '').replace(/\\s+/g, ' ').trim();
    },
    tags() {
      const say = api.say();
      return say ? [...say.children].map((c) => c.tagName.toLowerCase()) : [];
    },
    /**
     * The rendered DOM as an indented tree, for --frames.
     *
     * Prints an element's own text only when it has no children, so the tree
     * shows WHERE text sits rather than repeating every ancestor's textContent.
     */
    tree() {
      const say = api.say();
      if (!say) return '(nothing rendered yet)';
      const out = [];
      const walk = (e, d) => {
        const at = [...e.attributes].map((a) => a.name + (a.value ? '="' + a.value + '"' : '')).sort().join(' ');
        const kids = [...e.children];
        out.push(
          '  '.repeat(d) + '<' + e.tagName.toLowerCase() + (at ? ' ' + at : '') + '>' +
          (kids.length ? '' : '  ' + JSON.stringify((e.textContent || '').replace(/\\s+/g, ' ').trim())),
        );
        for (const c of kids) walk(c, d + 1);
      };
      for (const c of say.children) walk(c, 0);
      return out.join('\\n');
    },
    /** Structure + text, for the streamed-vs-pasted comparison. */
    shape() {
      const say = api.say();
      if (!say) return '';
      const out = [];
      const walk = (e, d) => {
        const attrs = [...e.attributes].map((a) => a.name + '="' + a.value + '"').sort().join(' ');
        const text = (e.textContent || '').replace(/\\s+/g, ' ').trim();
        out.push('  '.repeat(d) + '<' + e.tagName.toLowerCase() + (attrs ? ' ' + attrs : '') + '> ' + JSON.stringify(text));
        for (const c of e.children) walk(c, d + 1);
      };
      for (const c of say.children) walk(c, 0);
      return out.join('\\n');
    },
    /** Wipe the transcript between claims. */
    async reset() {
      // cos-clear-result deliberately keeps turns that are still in flight, so
      // a turn left streaming would survive the clear and every later claim
      // would read ITS dom. End it first.
      if (api.turn) frame({ ev: 'turn_end', turn_id: api.turn, ok: true });
      cosStore.clear('all');
      cosStore.handleFrame({ type: 'cos-clear-result', ok: true });
      cosStore.handleFrame({ type: 'cos-history', turns: [], reason: 'prune' });
      await el.updateComplete;
    },
    el,
  };

  window.__md = api;
  return 'ready';
})()
`;

// ---------------------------------------------------------------------------
// --frames: the intermediate state, printed
// ---------------------------------------------------------------------------

/**
 * ST1..ST4 are claims about half-written messages, so each dump below feeds
 * text in CHUNKS and prints the real DOM after EVERY ONE. A reader can see for
 * themselves that the <pre> exists before the closing fence arrives, that the
 * table has rows before the delimiter row does, and that the same DOM nodes
 * carry the growing content.
 */
const FRAME_DUMPS = {
  ST1: {
    title: 'ST1  unclosed fence -- DOM after every delta',
    run: async (cdp) => {
      const out = await cdp.eval(`(async () => {
        const md = window.__md; await md.reset(); await md.start(); const o = [];
        for (const c of ['Here is the fix.\\n\\n','\\u0060\\u0060\\u0060go\\n','func main() {\\n','  println("a")\\n','}\\n','\\u0060\\u0060\\u0060']) {
          await md.delta(c); const say = md.say(), pre = say.querySelector('pre.md-pre');
          o.push({ c, tree: md.tree(), ticks: md.seen().includes('\\u0060'),
            sibs: [...say.children].map(x=>x.tagName.toLowerCase()).join(','),
            open: pre ? pre.hasAttribute('data-streaming') : null,
            fits: pre ? Math.round(pre.getBoundingClientRect().width) <= Math.round(say.getBoundingClientRect().width) : null });
        } return o; })()`);
      for (const f of out) {
        console.log(`\n--- after delta ${JSON.stringify(f.c)}   [fence still open: ${f.open}]`);
        console.log(f.tree.split('\n').map((l) => '    ' + l).join('\n'));
        console.log(`    backticks visible: ${f.ticks}   siblings: ${f.sibs}   block fits in message: ${f.fits}`);
      }
      console.log(`\n  ${out.filter((f) => f.open).length} of ${out.length} frames were mid-fence.`);
      console.log(`  frames showing literal backticks: ${out.filter((f) => f.ticks).length}`);
    },
  },
  ST2: {
    title: 'ST2  incomplete table -- DOM after every delta',
    run: async (cdp) => {
      const out = await cdp.eval(`(async () => {
        const md = window.__md; await md.reset(); await md.start(); const o = [];
        for (const c of ['| lane ','| state |\\n','| --- ','| --- |\\n','| alpha ','| working |\\n','| beta | done |\\n']) {
          await md.delta(c); const w = md.say().querySelector('.md-tablewrap'), tb = md.say().querySelector('table.md-table');
          o.push({ c, tree: md.tree(), pipes: md.seen().includes('|'),
            speculative: w ? w.hasAttribute('data-streaming') : null,
            th: tb ? [...tb.querySelectorAll('th')].map(x=>x.textContent.trim()).join('|') : '',
            rows: tb ? tb.querySelectorAll('tbody tr').length : 0 });
        } return o; })()`);
      for (const f of out) {
        console.log(`\n--- after delta ${JSON.stringify(f.c)}   [delimiter row synthesized: ${f.speculative}]`);
        console.log(f.tree.split('\n').map((l) => '    ' + l).join('\n'));
        console.log(`    pipes visible: ${f.pipes}   header: [${f.th}]   body rows: ${f.rows}`);
      }
      console.log(`\n  ${out.filter((f) => f.speculative).length} of ${out.length} frames rendered a table GFM could not yet see.`);
      console.log(`  frames showing literal pipes: ${out.filter((f) => f.pipes).length}`);
      console.log(`  body rows over time: ${out.map((f) => f.rows).join(' -> ')} (never decreases)`);
    },
  },
  ST3: {
    title: 'ST3  incomplete emphasis -- every character-frame',
    run: async (cdp) => {
      const out = await cdp.eval(`(async () => {
        const md = window.__md; await md.reset(); await md.start();
        const text = 'ok **bold** and *lean* end'; const o = []; let typed = '';
        for (const ch of text) { await md.delta(ch); typed += ch;
          o.push({ typed, seen: md.seen(), dom: md.tree().replace(/\\n\\s*/g, ' | ') }); }
        return o; })()`);
      console.log('\n  typed so far                  visible text                 rendered DOM');
      console.log('  ' + '-'.repeat(84));
      for (const f of out)
        console.log(`  ${JSON.stringify(f.typed).padEnd(30)}${JSON.stringify(f.seen).padEnd(29)}${f.dom}`);
      const letters = (x) => x.replace(/[^0-9A-Za-z ]/g, '').replace(/\s+/g, ' ').trim();
      console.log(`\n  frames with * or _ visible: ${out.filter((f) => /[*_]/.test(f.seen)).length} of ${out.length}`);
      console.log(`  frames where a typed letter went missing: ${out.filter((f) => letters(f.seen) !== letters(f.typed)).length} of ${out.length}`);
    },
  },
  ST4: {
    title: 'ST4  no re-mount -- node identity while content grows',
    run: async (cdp) => {
      const out = await cdp.eval(`(async () => {
        const md = window.__md; await md.reset(); await md.start();
        await md.delta('First paragraph.\\n\\n');
        const p0 = md.say().querySelector('p.md-p');
        await md.delta('\\u0060\\u0060\\u0060js\\n'); await md.delta('const a = 1;\\n');
        const pre0 = md.say().querySelector('pre.md-pre'), c0 = pre0.querySelector('code');
        const o = [];
        const snap = (at) => { const s = md.say();
          o.push({ at, pre: s.querySelector('pre.md-pre')===pre0, code: s.querySelector('pre.md-pre code')===c0,
            p: s.querySelector('p.md-p')===p0, lines: s.querySelector('pre code').textContent.split('\\n').length,
            open: s.querySelector('pre.md-pre').hasAttribute('data-streaming') }); };
        for (let i = 2; i <= 9; i++) { await md.delta('const v'+i+' = '+i+';\\n'); snap('delta ' + i); }
        await md.delta('\\u0060\\u0060\\u0060'); snap('closing fence');
        await md.end(); snap('turn_end');
        return o; })()`);
      console.log('\n  after            <pre> same?  <code> same?  <p> same?  code lines  fence open');
      console.log('  ' + '-'.repeat(84));
      for (const r of out)
        console.log(`  ${r.at.padEnd(17)}${String(r.pre).padEnd(13)}${String(r.code).padEnd(13)}${String(r.p).padEnd(11)}${String(r.lines).padEnd(12)}${r.open}`);
      const rebuilt = out.filter((r) => !r.pre || !r.code || !r.p).length;
      console.log(`\n  node references were captured at the first delta and compared with === thereafter.`);
      console.log(`  rebuilds: ${rebuilt} of ${out.length * 3} identity comparisons`);
      console.log(`  content grew to ${out[out.length - 1].lines} lines inside nodes that were never replaced.`);
    },
  },
};

async function dumpFrames(cdp, which) {
  const ids = which === 'ALL' ? Object.keys(FRAME_DUMPS) : [which];
  for (const idKey of ids) {
    const d = FRAME_DUMPS[idKey];
    if (!d) {
      console.error(`unknown frame dump ${JSON.stringify(idKey)} -- try ${Object.keys(FRAME_DUMPS).join(', ')} or all`);
      return 2;
    }
    console.log('');
    console.log('='.repeat(84));
    console.log(d.title);
    console.log('='.repeat(84));
    await d.run(cdp);
  }
  return 0;
}

// ---------------------------------------------------------------------------

const CONSTRUCTS = [
  ['C1', 'bold', 'plain **loud** plain', 'strong', 'loud', ['*']],
  ['C2', 'italic', 'plain *lean* plain', 'em', 'lean', ['*']],
  ['C3', 'inline code', 'run `make dev-local` now', 'code.md-code', 'make dev-local', ['`']],
  ['C4', 'fenced code block', '```go\nfunc main() {}\n```', 'pre.md-pre code', 'func main() {}', ['```']],
  ['C5', 'link', 'see [the docs](https://example.com/a) here', 'a.md-link', 'the docs', ['](']],
  ['C6', 'bullet list', '- alpha\n- beta\n- gamma', 'ul.md-ul > li', 'alpha', ['- ']],
  ['C7', 'numbered list', '1. first\n2. second', 'ol.md-ol > li', 'first', ['1. ']],
  ['C8', 'table', '| lane | state |\n| --- | --- |\n| a | working |', 'table.md-table td', 'a', ['|']],
  ['C9', 'heading', '## A Real Heading', 'h2.md-h', 'A Real Heading', ['#']],
  ['C10', 'blockquote', '> a quoted remark', 'blockquote.md-quote', 'a quoted remark', ['> ']],
];

async function main() {
  let cdp;
  try {
    cdp = await Cdp.attach(CDP_URL);
  } catch (e) {
    console.error(`setup: cannot reach the browser at ${CDP_URL}: ${e.message}`);
    process.exit(2);
  }

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: APP_URL });
  await new Promise((r) => setTimeout(r, 2500));

  const ready = await cdp.eval(HARNESS).catch((e) => {
    console.error(`setup: harness failed to install: ${e.message}`);
    process.exit(2);
  });
  if (ready !== 'ready') {
    console.error('setup: harness did not report ready');
    process.exit(2);
  }

  console.log(`\nrunning against ${APP_URL} in ${(await cdp.eval('navigator.userAgent')).match(/Chrome\/[\d.]+/)?.[0]}`);

  if (FRAMES) {
    const rc = await dumpFrames(cdp, FRAMES);
    cdp.close();
    process.exit(rc);
  }
  console.log('');

  // -- C1..C10 -------------------------------------------------------------
  console.log('C1..C10 -- constructs render as formatting, in the real chat pane');
  for (const [id, name, src, sel, expect, forbidden] of CONSTRUCTS) {
    const r = await cdp.eval(`(async () => {
      const md = window.__md;
      await md.reset();
      await md.start();
      await md.delta(${JSON.stringify(src)});
      await md.end();
      const nodes = md.q(${JSON.stringify(sel)});
      return { count: nodes.length, text: nodes[0] ? nodes[0].textContent.trim() : null, seen: md.seen() };
    })()`);
    const leaked = forbidden.filter((f) => r.seen.includes(f));
    claim(
      id,
      `${name} -> ${sel}`,
      r.count > 0 && r.text === expect && leaked.length === 0,
      r.count === 0
        ? `no ${sel} in the pane`
        : r.text !== expect
          ? `got ${JSON.stringify(r.text)}, wanted ${JSON.stringify(expect)}`
          : `source leaked into the visible text: ${JSON.stringify(leaked)} in ${JSON.stringify(r.seen)}`,
    );
  }

  // -- sanitization --------------------------------------------------------
  console.log('\nSANITIZATION -- markup in a message stays text');
  const evil = await cdp.eval(`(async () => {
    const md = window.__md;
    await md.reset();
    await md.start();
    window.__pwned = false;
    for (const c of [
      '<script>window.__pwned=true</scr' + 'ipt>\\n\\n',
      '<img src=x onerror="window.__pwned=true">\\n\\n',
      '[click](javascript:window.__pwned=true)\\n\\n',
      '<iframe src="https://evil.example"></iframe>\\n\\n',
      '![p](https://tracker.example/p.png)\\n',
    ]) await md.delta(c);
    await md.end();
    const say = md.say();
    const handlers = [];
    for (const n of say.querySelectorAll('*'))
      for (const a of n.attributes) if (a.name.toLowerCase().startsWith('on')) handlers.push(n.tagName + '/' + a.name);
    return {
      pwned: window.__pwned,
      script: say.querySelectorAll('script').length,
      img: say.querySelectorAll('img').length,
      iframe: say.querySelectorAll('iframe').length,
      anchors: [...say.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      handlers,
      seen: md.seen(),
    };
  })()`);
  claim('SAN1', 'no script executed', evil.pwned === false, `window.__pwned = ${evil.pwned}`);
  claim('SAN2', 'no script/img/iframe element created',
    evil.script === 0 && evil.img === 0 && evil.iframe === 0,
    `script=${evil.script} img=${evil.img} iframe=${evil.iframe}`);
  claim('SAN3', 'no javascript: link is clickable', evil.anchors.length === 0, JSON.stringify(evil.anchors));
  claim('SAN4', 'no on* handler on any element', evil.handlers.length === 0, JSON.stringify(evil.handlers));
  claim('SAN5', 'the markup is still readable as text', evil.seen.includes('<script>'), JSON.stringify(evil.seen.slice(0, 60)));

  // -- ST1 -----------------------------------------------------------------
  console.log('\nST1..ST6 -- streaming behaviours, observed BETWEEN chunks');
  const st1 = await cdp.eval(`(async () => {
    const md = window.__md; await md.reset(); await md.start();
    const frames = [];
    await md.delta('Here is the fix.\\n\\n');
    for (const c of ['\\u0060\\u0060\\u0060go\\n', 'func main() {\\n', '  println("a")\\n', '  println("b")\\n']) {
      await md.delta(c);
      const pre = md.say().querySelector('pre.md-pre');
      frames.push({
        chunk: c,
        hasPre: !!pre,
        streaming: pre ? pre.hasAttribute('data-streaming') : null,
        backticks: md.seen().includes('\\u0060'),
        tags: md.tags(),
        preWidth: pre ? pre.getBoundingClientRect().width : 0,
        bodyWidth: md.say().getBoundingClientRect().width,
      });
    }
    await md.delta('}\\n\\u0060\\u0060\\u0060');
    const pre = md.say().querySelector('pre.md-pre');
    return { frames, closedStreaming: pre.hasAttribute('data-streaming'), code: pre.textContent };
  })()`);
  claim('ST1', 'unclosed fence is a <pre> in every intermediate frame',
    st1.frames.every((f) => f.hasPre && f.streaming === true),
    JSON.stringify(st1.frames.map((f) => ({ pre: f.hasPre, streaming: f.streaming }))));
  claim('ST1', 'no literal backticks in any intermediate frame',
    st1.frames.every((f) => !f.backticks));
  claim('ST1', 'surrounding layout intact: paragraph stays a sibling, block does not overflow',
    st1.frames.every((f) => f.tags[0] === 'p' && f.tags[1] === 'pre' && f.preWidth <= f.bodyWidth + 1),
    JSON.stringify(st1.frames.map((f) => ({ tags: f.tags, pre: Math.round(f.preWidth), body: Math.round(f.bodyWidth) }))));
  claim('ST1', 'the closer clears the in-progress marker', st1.closedStreaming === false);

  // -- ST2 -----------------------------------------------------------------
  const st2 = await cdp.eval(`(async () => {
    const md = window.__md; await md.reset(); await md.start();
    const frames = [];
    for (const c of ['| lane ', '| state |\\n', '| --- ', '| --- |\\n', '| alpha ', '| working |\\n', '| beta | done |\\n']) {
      await md.delta(c);
      const t = md.say().querySelector('table.md-table');
      frames.push({
        chunk: c,
        hasTable: !!t,
        th: t ? [...t.querySelectorAll('th')].map((x) => x.textContent.trim()) : [],
        rows: t ? t.querySelectorAll('tbody tr').length : 0,
        pipes: md.seen().includes('|'),
      });
    }
    return frames;
  })()`);
  claim('ST2', 'a table exists in every intermediate frame',
    st2.every((f) => f.hasTable), JSON.stringify(st2.map((f) => f.hasTable)));
  claim('ST2', 'no literal pipes in any intermediate frame',
    st2.every((f) => !f.pipes), JSON.stringify(st2.filter((f) => f.pipes).map((f) => f.chunk)));
  claim('ST2', 'does not collapse: header present throughout, rows only grow',
    st2.every((f, i) => f.th.length > 0 && f.rows >= (st2[i - 1]?.rows ?? 0)),
    JSON.stringify(st2.map((f) => ({ th: f.th, rows: f.rows }))));

  // -- ST3 -----------------------------------------------------------------
  const st3 = await cdp.eval(`(async () => {
    const md = window.__md; await md.reset(); await md.start();
    const text = 'status: **working** and *lean* too';
    const bad = [];
    let typed = '';
    for (const ch of text) {
      await md.delta(ch);
      const seen = md.seen();
      typed += ch;
      const letters = (s) => s.replace(/[^0-9A-Za-z ]/g, '').replace(/\\s+/g, ' ').trim();
      if (/[*_]/.test(seen)) bad.push({ at: typed, why: 'punctuation visible', seen });
      if (letters(seen) !== letters(typed)) bad.push({ at: typed, why: 'text swallowed', seen });
    }
    const say = md.say();
    return { bad, strong: !!say.querySelector('strong'), em: !!say.querySelector('em') };
  })()`);
  claim('ST3', 'no asterisk or underscore ever flashes, character by character',
    st3.bad.filter((b) => b.why === 'punctuation visible').length === 0,
    JSON.stringify(st3.bad.filter((b) => b.why === 'punctuation visible').slice(0, 3)));
  claim('ST3', 'no text is swallowed by an open delimiter',
    st3.bad.filter((b) => b.why === 'text swallowed').length === 0,
    JSON.stringify(st3.bad.filter((b) => b.why === 'text swallowed').slice(0, 3)));
  claim('ST3', 'the emphasis is real once closed', st3.strong && st3.em);

  // -- ST4 -----------------------------------------------------------------
  const st4 = await cdp.eval(`(async () => {
    const md = window.__md; await md.reset(); await md.start();
    await md.delta('The first paragraph.\\n\\n');
    const firstP = md.say().querySelector('p.md-p');
    await md.delta('\\u0060\\u0060\\u0060js\\n');
    await md.delta('const a = 1;\\n');
    const pre = md.say().querySelector('pre.md-pre');
    const code = pre.querySelector('code');
    const rebuilds = [];
    for (let i = 2; i < 14; i++) {
      await md.delta('const v' + i + ' = ' + i + ';\\n');
      const say = md.say();
      if (say.querySelector('pre.md-pre') !== pre) rebuilds.push('pre@' + i);
      if (say.querySelector('pre.md-pre code') !== code) rebuilds.push('code@' + i);
      if (say.querySelector('p.md-p') !== firstP) rebuilds.push('p@' + i);
    }
    await md.delta('\\u0060\\u0060\\u0060');
    await md.end();
    const say = md.say();
    if (say.querySelector('pre.md-pre') !== pre) rebuilds.push('pre@end');
    if (say.querySelector('p.md-p') !== firstP) rebuilds.push('p@end');
    return { rebuilds, lines: say.querySelector('pre code').textContent.split('\\n').length };
  })()`);
  claim('ST4', 'no element is torn down and rebuilt across 12 chunks or at turn_end',
    st4.rebuilds.length === 0, JSON.stringify(st4.rebuilds));

  // -- ST5 -----------------------------------------------------------------
  const st5 = await cdp.eval(`(async () => {
    const { MarkdownStream } = await import('/src/lib/markdown-stream.ts');
    const build = (n) => {
      const parts = []; let len = 0; let i = 0;
      while (len < n) {
        const p = i % 4 === 3
          ? '\\u0060\\u0060\\u0060ts\\n' + Array.from({length:6},(_,k)=>'const v'+i+'_'+k+' = f('+k+');').join('\\n') + '\\n\\u0060\\u0060\\u0060'
          : 'Paragraph ' + i + ' with **weight**, a \\u0060symbol\\u0060 and [a ref](https://example.com/' + i + ') and prose to give it length.';
        parts.push(p); len += p.length + 2; i++;
      }
      return parts.join('\\n\\n');
    };
    const once = (text) => {
      const s = new MarkdownStream();
      const t0 = performance.now();
      for (let i = 12; i < text.length; i += 12) s.update(text.slice(0, i), true);
      s.update(text, false);
      return { ms: performance.now() - t0, lexed: s.stats.charsLexed };
    };
    // Warm the JIT on every size first, so no sample below is the cold one.
    for (const n of [2000, 4000, 8000, 16000]) { once(build(n)); once(build(n)); }
    const rows = [];
    for (const n of [2000, 4000, 8000, 16000]) {
      const text = build(n);
      let best = Infinity, lexed = 0;
      for (let r = 0; r < 5; r++) { const o = once(text); if (o.ms < best) best = o.ms; lexed = o.lexed; }
      let naive = 0; for (let i = 12; i < text.length; i += 12) naive += i; naive += text.length;
      rows.push({ n: text.length, lexed, perChar: +(lexed/text.length).toFixed(2), naive, ms: +best.toFixed(2) });
    }
    return rows;
  })()`);
  console.log('\n  ST5 measured in Chrome (chunk = 12 chars):');
  for (const r of st5)
    console.log(`    n=${String(r.n).padStart(6)}  lexed=${String(r.lexed).padStart(8)}  lexed/n=${String(r.perChar).padStart(5)}  naive=${String(r.naive).padStart(10)}  ${String(r.ms).padStart(6)}ms`);
  const flat = st5.every((r) => r.perChar < st5[0].perChar * 1.6);
  const growth = st5[3].ms / st5[2].ms;
  claim('ST5', 'per-character lex cost does not grow with message length', flat,
    JSON.stringify(st5.map((r) => r.perChar)));
  claim('ST5', 'doubling the message does not quadruple the time', growth < 3,
    `n=8000 ${st5[2].ms}ms -> n=16000 ${st5[3].ms}ms = ${growth.toFixed(2)}x`);
  claim('ST5', 'far less work than re-parsing every delta',
    st5[3].naive / st5[3].lexed > 20, `${(st5[3].naive / st5[3].lexed).toFixed(0)}x less`);

  // -- ST6 -----------------------------------------------------------------
  const MESSAGE = [
    '# Release notes',
    '',
    'This build is **faster** and *smaller*; see `bench.md` and [the report](https://example.com/r).',
    '',
    '- first bullet',
    '- second bullet with **weight**',
    '',
    '1. step one',
    '2. step two',
    '',
    '| lane | state |',
    '| --- | --- |',
    '| alpha | working |',
    '| beta | done |',
    '',
    '> A quoted remark.',
    '',
    '```go',
    'func main() {',
    '\tprintln("hi")',
    '}',
    '```',
    '',
    'Closing paragraph.',
  ].join('\n');

  const st6 = await cdp.eval(`(async () => {
    const md = window.__md;
    const text = ${JSON.stringify(MESSAGE)};
    // 1. streamed in, small random chunks
    await md.reset(); await md.start();
    let s = 7; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < text.length; ) { const k = 1 + Math.floor(rnd() * 9); await md.delta(text.slice(i, i + k)); i += k; }
    await md.end();
    const streamed = md.shape();
    const streamedText = md.seen();
    // 2. the same message pasted in as one delta
    await md.reset(); await md.start();
    await md.delta(text);
    await md.end();
    return { streamed, pasted: md.shape(), streamedText, pastedText: md.seen() };
  })()`);
  claim('ST6', 'streamed-in DOM is identical to pasted-in DOM', st6.streamed === st6.pasted,
    st6.streamed === st6.pasted ? '' : `first difference:\n${firstDiff(st6.streamed, st6.pasted)}`);
  claim('ST6', 'and the visible text is identical too', st6.streamedText === st6.pastedText);


  // -- DEPTH: the edge cases, run in the same browser ------------------------
  console.log('\nDEPTH -- edge cases, cache correctness, and the safety boundary');

  const CORPUS = [
    ['all ten constructs', MESSAGE],
    ['dangling emphasis at the end', 'this ends with **an open delimiter'],
    ['dangling fence at the end', 'intro\n\n```py\nx = 1\ny = 2'],
    ['dangling table at the end', 'intro\n\n| a | b |'],
    ['header and delimiter only', '| a | b |\n| --- | --- |'],
    ['half-typed link at the end', 'go to [the docs](https://exam'],
    ['unopened bracket at the end', 'see [the doc'],
    ['nested list', '- outer\n  - inner one\n  - inner two\n- outer two'],
    ['loose list', '- one\n\n- two\n\n- three'],
    ['list then paragraph', '- one\n- two\n\nAfter the list.'],
    ['fence containing markdown', '```\n# not a heading\n**not bold**\n| not | a table |\n```'],
    ['fence containing blank lines', '```py\ndef a():\n\n    return 1\n\n```'],
    ['consecutive fences', '```\na\n```\n\n```\nb\n```'],
    ['html in the text', 'before <script>alert(1)</script> after'],
    ['pipes in prose', 'run `ls | wc -l`, or a | b, or |leading'],
    ['emphasis edge cases', 'a*b*c and 2*3 and some_var and __x__ and *** and **'],
    ['blockquote with a list', '> - a\n> - b\n\nafter'],
    ['heading then text', '## Title\ntext right below'],
    ['blank line runs', 'para one\n\n\n\npara two\n\n\n'],
    ['crlf line endings', 'para one\r\n\r\npara two\r\n'],
    ['unicode and emoji', 'h\u00e9llo **w\u00f6rld** \u2705 \u65e5\u672c\u8a9e `\u30b3\u30fc\u30c9`'],
    ['only whitespace', '   \n\n  \n'],
    ['single character', 'x'],
  ];

  const corpus = await cdp.eval(`(async () => {
    const md = window.__md;
    const cases = ${JSON.stringify(CORPUS)};
    const bad = [];
    for (const [name, text] of cases) {
      // pasted
      await md.reset(); await md.start(); await md.delta(text); await md.end();
      const pasted = md.shape();
      // streamed, pseudo-random chunks
      await md.reset(); await md.start();
      let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
      for (let i = 0; i < text.length; ) { const k = 1 + Math.floor(rnd() * 9); await md.delta(text.slice(i, i + k)); i += k; }
      await md.end();
      if (md.shape() !== pasted) bad.push({ name, mode: 'chunked' });
      // streamed, one character at a time
      await md.reset(); await md.start();
      for (const ch of text) await md.delta(ch);
      await md.end();
      if (md.shape() !== pasted) bad.push({ name, mode: 'per-character' });
    }
    return { total: cases.length, bad };
  })()`);
  claim('ST6', `streamed == pasted for all ${corpus.total} corpus messages, chunked AND per-character`,
    corpus.bad.length === 0, JSON.stringify(corpus.bad));

  const fuzz = await cdp.eval(`(async () => {
    const { MarkdownStream, parseMarkdown } = await import('/src/lib/markdown-stream.ts');
    const text = ${JSON.stringify(MESSAGE)};
    const expected = JSON.stringify(parseMarkdown(text).map((s) => s.tokens));
    const bad = [];
    for (let seed = 1; seed <= 200; seed++) {
      let s = seed >>> 0;
      const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
      const st = new MarkdownStream();
      let acc = '';
      while (acc.length < text.length) {
        acc = text.slice(0, acc.length + 1 + Math.floor(rnd() * 9));
        st.update(acc, true);
      }
      const got = JSON.stringify(st.update(text, false).map((x) => x.tokens));
      if (got !== expected) bad.push(seed);
    }
    return bad;
  })()`);
  claim('ST6', 'the incremental cache survives 200 random chunkings token-for-token',
    fuzz.length === 0, `diverging seeds: ${JSON.stringify(fuzz.slice(0, 5))}`);

  const depth = await cdp.eval(`(async () => {
    const { MarkdownStream, parseMarkdown, speculate, fastFenceToken } = await import('/src/lib/markdown-stream.ts');
    const { isSafeHref } = await import('/src/lib/markdown-view.ts');
    const { marked } = await import('/node_modules/marked/lib/marked.esm.js');
    const O = { gfm: true, breaks: true, pedantic: false };
    const out = {};

    // The fence shortcut must AGREE with the lexer it replaces.
    out.fence = [];
    for (const o of ['\\u0060\\u0060\\u0060', '\\u0060\\u0060\\u0060js', '\\u0060\\u0060\\u0060  js  extra info ', '\\u0060\\u0060\\u0060\\u0060', '~~~', '~~~py'])
      for (const b of ['', 'a', 'a\\n', 'a\\nb', 'a\\nb\\n', 'a\\n\\nb\\n', '\\n\\na\\n', '  indented\\n\\ttabbed\\n', '# not a heading\\n**not bold**\\n'])
        for (const sep of ['', '\\n']) {
          const src = o + sep + b;
          const lexed = marked.lexer(src, O);
          if (lexed.length !== 1 || lexed[0].type !== 'code') continue;
          const fast = fastFenceToken(src);
          if (!fast || fast.lang !== lexed[0].lang || fast.text !== lexed[0].text)
            out.fence.push({ src, fast: fast && { lang: fast.lang, text: fast.text }, lexed: { lang: lexed[0].lang, text: lexed[0].text } });
        }

    // speculate() must be the identity on text that is already balanced.
    out.identity = [];
    for (const s of ['plain words', 'a **bold** b', 'a \\u0060code\\u0060 b', 'a [link](https://x.example) b', '- one\\n- two', '> quoted', '# heading', '| a | b |\\n| --- | --- |\\n| 1 | 2 |'])
      if (speculate(s) !== s) out.identity.push({ s, got: speculate(s) });

    // The href allow-list.
    out.href = [];
    for (const [u, want] of [['https://a.example', true], ['http://a.example', true], ['mailto:a@b.example', true], ['  HTTPS://A.EXAMPLE  ', true],
      ['javascript:alert(1)', false], ['JaVaScRiPt:alert(1)', false], ['data:text/html,x', false], ['vbscript:x', false],
      ['file:///etc/passwd', false], ['//evil.example', false], ['/api/shutdown', false], ['relative/path', false], ['', false]])
      if (isSafeHref(u) !== want) out.href.push({ u, want, got: isSafeHref(u) });

    // A closed segment is lexed once, however many deltas land after it.
    const st = new MarkdownStream();
    st.update('Paragraph one.\\n\\n', true);
    st.update('Paragraph one.\\n\\nParagraph two.\\n\\n', true);
    let acc = 'Paragraph one.\\n\\nParagraph two.\\n\\nParagraph three begins';
    st.update(acc, true);
    const before = st.stats.segmentLexes;
    for (let i = 0; i < 40; i++) { acc += ' word' + i; st.update(acc, true); }
    out.lexesAfter40Deltas = st.stats.segmentLexes - before;

    // A store that REPLACES text instead of appending must still be right.
    const st2 = new MarkdownStream();
    st2.update('one **two** three\\n\\nand more', true);
    const replaced = '# Different\\n\\nEntirely *other* text.';
    const after = JSON.stringify(st2.update(replaced, false).map((x) => x.tokens));
    out.reset = { resets: st2.stats.fullResets, matches: after === JSON.stringify(parseMarkdown(replaced).map((x) => x.tokens)) };
    return out;
  })()`);
  claim('ST1', 'the fence shortcut agrees with the lexer it replaces, across 108 shapes',
    depth.fence.length === 0, JSON.stringify(depth.fence.slice(0, 2)));
  claim('ST6', 'speculate() is the identity on balanced text',
    depth.identity.length === 0, JSON.stringify(depth.identity));
  claim('SAN6', 'the href allow-list refuses every scheme that is not http/https/mailto',
    depth.href.length === 0, JSON.stringify(depth.href));
  claim('ST5', 'closed segments are never re-lexed: 40 deltas cost 40 lexes, not 120',
    depth.lexesAfter40Deltas === 40, `got ${depth.lexesAfter40Deltas}`);
  claim('ST6', 'a wholesale text replacement resets the cache and still renders correctly',
    depth.reset.resets > 0 && depth.reset.matches, JSON.stringify(depth.reset));

  const extraStreaming = await cdp.eval(`(async () => {
    const md = window.__md;
    const run = async (text, watch) => {
      await md.reset(); await md.start();
      const seen = [];
      for (const ch of text) { await md.delta(ch); seen.push(watch()); }
      await md.end();
      return { seen, final: md.seen(), say: md.say() };
    };
    // A pipe in prose is not a table.
    const a = await run('run \\u0060ls | wc -l\\u0060 to count them', () => !!md.say().querySelector('table'));
    // Arithmetic and snake_case are left alone.
    const b = await run('use 2*3 and some_var_name here', () => md.seen());
    // A half-typed link is never clickable to a partial address.
    const hrefs = [];
    const c = await run('see [the docs](https://example.com/guide) now',
      () => { for (const x of md.say().querySelectorAll('a')) hrefs.push(x.getAttribute('href')); return md.seen(); });
    // An unclosed inline code span never shows its backtick.
    const d = await run('run \\u0060make dev\\u0060 now', () => md.seen().includes('\\u0060'));
    return {
      pipeProse: { anyTable: a.seen.some(Boolean), final: a.final },
      arithmetic: { final: b.final, emphasised: !!b.say.querySelector('em, strong') },
      link: { hrefs: [...new Set(hrefs)], brackets: c.seen.some((s) => /[\\[\\]()]/.test(s)), label: c.say.querySelector('a') && c.say.querySelector('a').textContent },
      codespan: { anyBacktick: d.seen.some(Boolean), text: d.say.querySelector('code') && d.say.querySelector('code').textContent },
    };
  })()`);
  claim('ST2', 'a pipe in prose is never mistaken for a table',
    !extraStreaming.pipeProse.anyTable && extraStreaming.pipeProse.final.includes('ls | wc -l'),
    JSON.stringify(extraStreaming.pipeProse));
  claim('ST3', 'arithmetic and snake_case are left alone, never speculatively emphasised',
    extraStreaming.arithmetic.final === 'use 2*3 and some_var_name here' && !extraStreaming.arithmetic.emphasised,
    JSON.stringify(extraStreaming.arithmetic));
  claim('ST3', 'a half-typed link shows its label, and only the COMPLETE address is ever clickable',
    !extraStreaming.link.brackets &&
      extraStreaming.link.hrefs.length === 1 &&
      extraStreaming.link.hrefs[0] === 'https://example.com/guide' &&
      extraStreaming.link.label === 'the docs',
    JSON.stringify(extraStreaming.link));
  claim('ST3', 'an unclosed inline code span never shows its backtick',
    !extraStreaming.codespan.anyBacktick && extraStreaming.codespan.text === 'make dev',
    JSON.stringify(extraStreaming.codespan));

  // The safety argument is structural, so assert it structurally.
  {
    const { readFileSync } = await import('node:fs');
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const offenders = [];
    for (const f of ['web/src/lib/markdown-view.ts', 'web/src/lib/markdown-stream.ts']) {
      const src = strip(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'));
      for (const [re, why] of [
        [/unsafe-html|unsafeHTML|unsafeSVG/, 'imports unsafeHTML'],
        [/\.innerHTML\s*=/, 'assigns innerHTML'],
        [/insertAdjacentHTML/, 'uses insertAdjacentHTML'],
        [/document\.write/, 'calls document.write'],
        [/marked\.parse|\bparseInline\b/, 'calls marked.parse (which returns an HTML string)'],
      ]) if (re.test(src)) offenders.push(`${f} ${why}`);
    }
    claim('SAN7', 'no module on this path ever builds an HTML string or touches innerHTML',
      offenders.length === 0, JSON.stringify(offenders));
  }

  // -- a screenshot, because "renders correctly" is also a thing you look at
  if (SHOT_DIR) {
    mkdirSync(SHOT_DIR, { recursive: true });
    await cdp.eval(`(async () => {
      const md = window.__md; await md.reset(); await md.start();
      await md.delta(${JSON.stringify(MESSAGE)}); await md.end();
      return true;
    })()`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const path = `${SHOT_DIR}/chat-pane-markdown.png`;
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
    console.log(`\n  screenshot: ${path}`);
  }

  cdp.close();

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  ${f}`);
  }

  // The ledger is the LAST thing printed and the thing the exit code answers
  // to. A run that leaves any item without exactly one PASS is a failed run,
  // even if every individual check happened to pass.
  const allGreen = ledger();
  process.exit(allGreen ? 0 : 1);
}

function firstDiff(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `  line ${i}\n  streamed: ${la[i]}\n  pasted:   ${lb[i]}`;
  }
  return '(none)';
}

main().catch((e) => {
  console.error(`error: ${e.stack ?? e.message}`);
  process.exit(2);
});
