#!/usr/bin/env node
/**
 * published-doc.mjs -- the public document page, proven in a REAL BROWSER
 * against a RUNNING muxterm, with NO CREDENTIAL of any kind.
 *
 * WHAT IT PROVES, and why each claim needs a browser rather than a curl:
 *
 *   P1 an anonymous browser renders a published markdown file as a document
 *      -- curl can show the shell arrived; only a browser shows that the
 *      renderer ran, that the script loaded from the unauthenticated asset
 *      route, and that the CSP did not block it.
 *   P2 markup inside the published file is TEXT -- no <script> executes and no
 *      onerror fires. This is the claim that cannot be made from headers.
 *   P3 the page is LIVE: edit the file on disk, reload the same URL, and the
 *      document changes with no re-publish.
 *   P4 when the guard fires (the file replaced by a symlink), the browser sees
 *      the refusal, not the new target.
 *   P5 a revoked link, in a browser, says so plainly.
 *
 * Usage:
 *   node web/e2e/published-doc.mjs --base http://127.0.0.1:8314 \
 *        --token <local server token> --file /tmp/pub-fixtures/e2e.md \
 *        [--cdp http://127.0.0.1:9333] [--shot DIR]
 *
 * The token is the same-user local token from the runtime dir's server.url;
 * it is used ONLY for the owner-side publish/revoke calls. Every page load in
 * this script is made by a browser that has never seen it.
 *
 * Exit codes: 0 every claim held; 1 a claim failed; 2 setup error.
 */
import { writeFileSync, mkdirSync, writeFileSync as write } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : fallback;
};

const BASE = argOf('--base', 'http://127.0.0.1:8314');
const CDP = argOf('--cdp', 'http://127.0.0.1:9333');
const TOKEN = argOf('--token', '');
const FILE = argOf('--file', '/tmp/pub-fixtures/e2e.md');
const SHOT_DIR = argOf('--shot', '');

// ---------------------------------------------------------------------------
// A very small CDP client, same shape as web/e2e/markdown-stream.mjs.
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

  async goto(url) {
    await this.send('Page.navigate', { url });
    // Poll for the document to settle rather than racing a load event.
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const ready = await this.eval('document.readyState === "complete"').catch(() => false);
      if (ready) break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  async shot(name) {
    if (!SHOT_DIR) return;
    mkdirSync(SHOT_DIR, { recursive: true });
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.data, 'base64'));
  }
}

// ---------------------------------------------------------------------------
// Owner-side calls. Authenticated; the browser never sees this token.
// ---------------------------------------------------------------------------
const owner = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
};

const results = [];
const claim = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};

const V1 = `# Published live

This document is served **from disk on every request**.

- a reload shows edits
- nothing was copied at publish time

## Markup inside the file must stay TEXT

<script>window.__XSS_RAN__ = true;</script>
<img src=x onerror="window.__XSS_RAN__ = true">

| claim | state |
|---|---|
| renders | yes |
`;

const V2 = V1.replace('# Published live', '# Published live -- EDITED AFTER THE LINK WAS SENT').concat(
  '\n## A section appended after publishing\n',
);

async function main() {
  let cdp;
  try {
    cdp = await Cdp.attach(CDP);
  } catch (e) {
    console.error(`setup: cannot reach a browser at ${CDP}: ${e.message}`);
    process.exit(2);
  }

  write(FILE, V1);
  const pub = await owner('POST', '/api/publications', { path: FILE });
  const url = `${BASE}/p/${pub.id}`;
  console.log(`\npublished ${pub.id}\n  path ${pub.path}\n  url  ${url}\n`);

  // --- P1: an anonymous browser renders it ---------------------------------
  await cdp.goto(url);
  await cdp.shot('01-rendered');
  const dom = await cdp.eval(`JSON.stringify({
    h1: document.querySelector('#doc h1')?.textContent ?? null,
    headings: [...document.querySelectorAll('#doc h1,#doc h2')].map(e => e.textContent),
    listItems: [...document.querySelectorAll('#doc li')].map(e => e.textContent.trim()),
    tableCells: [...document.querySelectorAll('#doc td,#doc th')].map(e => e.textContent.trim()),
    strong: [...document.querySelectorAll('#doc strong')].map(e => e.textContent),
    scriptEls: document.querySelectorAll('#doc script').length,
    imgEls: document.querySelectorAll('#doc img').length,
    xssRan: !!window.__XSS_RAN__,
    text: document.getElementById('doc').innerText.slice(0, 400)
  })`).then(JSON.parse);

  claim(
    'B1 renders as a document, unauthenticated',
    dom.h1 === 'Published live' && dom.headings.length >= 2 && dom.listItems.length === 2,
    `h1=${JSON.stringify(dom.h1)} headings=${dom.headings.length} li=${dom.listItems.length} tableCells=${dom.tableCells.length}`,
  );
  claim(
    'B2 markdown emphasis and tables really rendered',
    dom.strong.length >= 1 && dom.tableCells.length >= 4,
    `strong=${JSON.stringify(dom.strong)} cells=${JSON.stringify(dom.tableCells)}`,
  );
  claim(
    'B3 markup in the file is TEXT: no script element, no img element, no handler ran',
    dom.scriptEls === 0 && dom.imgEls === 0 && dom.xssRan === false,
    `script=${dom.scriptEls} img=${dom.imgEls} window.__XSS_RAN__=${dom.xssRan}`,
  );

  // --- P3: live -------------------------------------------------------------
  write(FILE, V2);
  await cdp.goto(url);
  await cdp.shot('02-after-edit');
  const after = await cdp.eval(`JSON.stringify({
    h1: document.querySelector('#doc h1')?.textContent ?? null,
    lastH2: [...document.querySelectorAll('#doc h2')].pop()?.textContent ?? null
  })`).then(JSON.parse);
  claim(
    'B4 LIVE: the same URL shows the edit, with no re-publish',
    after.h1.includes('EDITED AFTER THE LINK WAS SENT') &&
      after.lastH2 === 'A section appended after publishing',
    `h1=${JSON.stringify(after.h1)} lastH2=${JSON.stringify(after.lastH2)}`,
  );

  // --- P4: the guard, seen from the browser ---------------------------------
  const { execSync } = await import('node:child_process');
  const secret = '/tmp/pub-fixtures/e2e-secret.md';
  write(secret, '# SECRET\n\nE2E-SECRET-PAYLOAD must never reach the page.\n');
  execSync(`rm -f ${JSON.stringify(FILE)} && ln -s ${JSON.stringify(secret)} ${JSON.stringify(FILE)}`);
  await cdp.goto(url);
  await cdp.shot('03-identity-refusal');
  const refused = await cdp.eval(`JSON.stringify({
    body: document.body.innerText.slice(0, 300),
    leak: document.documentElement.outerHTML.includes('E2E-SECRET-PAYLOAD')
  })`).then(JSON.parse);
  claim(
    'B5 file replaced by a symlink: the browser gets a refusal, never the new target',
    refused.leak === false && /not the file that was published/.test(refused.body),
    JSON.stringify(refused.body.split('\n').filter(Boolean).slice(0, 2)),
  );

  // --- P5: revocation, seen from the browser --------------------------------
  execSync(`rm -f ${JSON.stringify(FILE)}`);
  write(FILE, V1);
  const pub2 = await owner('POST', '/api/publications', { path: FILE });
  const url2 = `${BASE}/p/${pub2.id}`;
  await cdp.goto(url2);
  const beforeRevoke = await cdp.eval(`document.querySelector('#doc h1')?.textContent ?? null`);
  await owner('DELETE', `/api/publications/${pub2.id}`);
  await cdp.goto(url2);
  await cdp.shot('04-revoked');
  const afterRevoke = await cdp.eval(`document.body.innerText.slice(0, 200)`);
  claim(
    'B6 revoked link: the browser is told plainly, immediately',
    beforeRevoke === 'Published live' && /This link is not valid/.test(afterRevoke),
    `before=${JSON.stringify(beforeRevoke)} after=${JSON.stringify(afterRevoke.split('\n').filter(Boolean)[1] ?? '')}`,
  );

  // --- the two public routes vs everything else, by NAVIGATION --------------
  //
  // Navigation rather than fetch() on purpose: every public response carries
  // `default-src 'none'`, which blocks connect-src too, so an in-page fetch is
  // refused by the page's own CSP before it reaches the network. That is the
  // CSP working; it just makes fetch the wrong instrument here.
  await cdp.goto(`${BASE}/p/_asset/doc.js`);
  const assetBody = await cdp.eval(`document.body.innerText.slice(0, 4000)`);
  await cdp.goto(`${BASE}/api/files`);
  // A browser sends Accept: text/html, so AuthMiddleware.deny redirects it to
  // the login page instead of answering the JSON 401 a curl gets. Landing
  // anywhere but /api/files IS the refusal, so assert on where it landed --
  // and on the fact that no directory listing came back.
  const apiLanded = await cdp.eval(`JSON.stringify({
    path: location.pathname,
    body: document.body.innerText.slice(0, 120)
  })`).then(JSON.parse);
  claim(
    'B7 the anonymous browser gets the renderer, and is refused everywhere else',
    assetBody.length > 500 && apiLanded.path !== '/api/files' && !/\"entries\"|\"gitAvailable\"/.test(apiLanded.body),
    `/p/_asset/doc.js -> ${assetBody.length} chars of script; /api/files -> bounced to ${apiLanded.path} (${JSON.stringify(apiLanded.body.split('\n').filter(Boolean)[1] ?? '')})`,
  );

  await owner('DELETE', '/api/publications');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} claims held`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`error: ${e.stack ?? e.message}`);
  process.exit(2);
});
