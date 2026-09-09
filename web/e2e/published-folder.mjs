#!/usr/bin/env node
/**
 * published-folder.mjs -- a published FOLDER, browsed in a REAL BROWSER with
 * NO CREDENTIAL of any kind.
 *
 * WHAT IT PROVES, and why each claim needs a browser rather than a curl:
 *
 *   F1 an anonymous browser renders the folder's root as a DOCUMENT -- the
 *      README rendered, not its source. curl can show the shell arrived; only
 *      a browser shows the renderer ran, loaded its script from the
 *      unauthenticated asset route, and was not blocked by the CSP.
 *   F2 RELATIVE LINKS BETWEEN PAGES WORK. This is what separates a wiki from
 *      a file dump: click a link in one published page, land on another
 *      published page, rendered. Two hops and back, by clicking.
 *   F3 an IMAGE inside the folder actually LOADS (naturalWidth > 0). Without
 *      this the wiki case fails, and it cannot be seen from a header.
 *   F4 an image from OUTSIDE the folder does NOT load and is not even
 *      requested -- a published document cannot be a beacon reporting who
 *      opened the link.
 *   F5 in-tree links stay in the tab (a site); external links still open in a
 *      new tab with rel=noopener (somebody else's web).
 *   F6 the generated directory listing is navigable: root -> guide/ -> deep/.
 *   F7 a revoked tree says so plainly, everywhere in it, immediately.
 *
 * Usage:
 *   node web/e2e/published-folder.mjs --base http://127.0.0.1:8451 \
 *        --token <local server token> --root /tmp/pubfolder-fixtures/wiki \
 *        [--cdp http://127.0.0.1:9334] [--shot DIR]
 *
 * The token is used ONLY for the owner-side publish/revoke calls. Every page
 * load in this script is made by a browser that has never seen it.
 *
 * Exit codes: 0 every claim held; 1 a claim failed; 2 setup error.
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : fallback;
};

const BASE = argOf('--base', 'http://127.0.0.1:8451');
const CDP = argOf('--cdp', 'http://127.0.0.1:9334');
const TOKEN = argOf('--token', '');
const ROOT = argOf('--root', '/tmp/pubfolder-fixtures/wiki');
const SHOT_DIR = argOf('--shot', '');

// ---------------------------------------------------------------------------
// A very small CDP client, same shape as web/e2e/published-doc.mjs.
// ---------------------------------------------------------------------------
class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  requests = [];

  static async attach(base) {
    const targets = await (await fetch(`${base}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target in the browser');
    const c = new Cdp();
    await c.#connect(page.webSocketDebuggerUrl);
    await c.send('Page.enable');
    await c.send('Network.enable');
    return c;
  }

  #connect(url) {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(url);
      this.#ws.onopen = () => resolve();
      this.#ws.onerror = (e) => reject(new Error(`cdp socket: ${e.message ?? 'failed'}`));
      this.#ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.method === 'Network.requestWillBeSent') {
          this.requests.push(msg.params.request.url);
          return;
        }
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

  async settle() {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const ready = await this.eval('document.readyState === "complete"').catch(() => false);
      if (ready) break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.settle();
  }

  /** Click the first anchor whose visible text matches, then wait. */
  async clickLink(text) {
    const ok = await this.eval(`(() => {
      const a = [...document.querySelectorAll('a')].find(
        (el) => el.textContent.trim() === ${JSON.stringify(text)});
      if (!a) return false;
      a.click();
      return true;
    })()`);
    if (!ok) throw new Error(`no link labelled ${JSON.stringify(text)} on ${await this.eval('location.pathname')}`);
    await this.settle();
    return true;
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

async function main() {
  const pub = await owner('POST', '/api/publications/folder', { path: ROOT });
  const base = `${BASE}/p/${pub.id}/`;
  console.log(`published ${ROOT} -> ${base}  (${pub.file_count} files, ${pub.excluded} excluded)\n`);

  const cdp = await Cdp.attach(CDP);
  try {
    // -- F1 -------------------------------------------------------------
    await cdp.goto(base);
    await cdp.shot('01-root');
    const rootText = await cdp.eval('document.getElementById("doc")?.innerText ?? ""');
    const rootH1 = await cdp.eval('document.querySelector("#doc h1")?.textContent ?? ""');
    const rootStrong = await cdp.eval('!!document.querySelector("#doc strong")');
    claim(
      'F1 root renders as a document, unauthenticated',
      rootH1.trim() === 'Test Wiki' && rootStrong && !rootText.includes('# Test Wiki'),
      `h1=${JSON.stringify(rootH1.trim())} strong=${rootStrong} raw-markdown-visible=${rootText.includes('# Test Wiki')}`,
    );

    // -- F3 / F4 --------------------------------------------------------
    const imgs = await cdp.eval(`[...document.querySelectorAll('#doc img')].map(
      (i) => ({ src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight }))`);
    const inTree = imgs.find((i) => (i.src ?? '').includes('/img/dot.png'));
    claim(
      'F3 an image INSIDE the folder loads',
      !!inTree && inTree.w > 0 && inTree.h > 0,
      `src=${inTree?.src} naturalWidth=${inTree?.w} naturalHeight=${inTree?.h}`,
    );
    const external = imgs.find((i) => (i.src ?? '').includes('tracker.example'));
    const trackerFetched = cdp.requests.some((u) => u.includes('tracker.example'));
    const altShown = (await cdp.eval('document.getElementById("doc").innerText')).includes('tracker');
    claim(
      'F4 an image OUTSIDE the folder is neither drawn nor requested',
      !external && !trackerFetched && altShown,
      `img-element=${!!external} network-request=${trackerFetched} alt-text-shown=${altShown}`,
    );

    // -- F5 -------------------------------------------------------------
    const linkShapes = await cdp.eval(`[...document.querySelectorAll('#doc a')].map(
      (a) => ({ text: a.textContent.trim(), href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') }))`);
    const treeLink = linkShapes.find((l) => l.text === 'The setup guide');
    const extLink = linkShapes.find((l) => l.text === 'example');
    claim(
      'F5 in-tree links stay in the tab; external links open away with noopener',
      !!treeLink && treeLink.target === null && treeLink.href.startsWith(`/p/${pub.id}/`) &&
        !!extLink && extLink.target === '_blank' && (extLink.rel ?? '').includes('noopener'),
      `in-tree=${JSON.stringify(treeLink)} external=${JSON.stringify(extLink)}`,
    );

    // -- F2 -------------------------------------------------------------
    await cdp.clickLink('The setup guide');
    await cdp.shot('02-setup');
    let path = await cdp.eval('location.pathname');
    let body = await cdp.eval('document.getElementById("doc").innerText');
    const hop1 = path === `/p/${pub.id}/guide/setup.md` && body.includes('MARKER-SETUP-PAGE');

    await cdp.clickLink('more');
    await cdp.shot('03-deep');
    path = await cdp.eval('location.pathname');
    body = await cdp.eval('document.getElementById("doc").innerText');
    const hop2 = path === `/p/${pub.id}/guide/deep/more.md` && body.includes('MARKER-DEEP-PAGE');

    claim(
      'F2 relative links between pages navigate and render (two hops)',
      hop1 && hop2,
      `hop1=${hop1} hop2=${hop2} landed=${path}`,
    );

    // -- F6 -------------------------------------------------------------
    await cdp.goto(base);
    await cdp.clickLink('guide/');
    const guidePath = await cdp.eval('location.pathname');
    const listed = await cdp.eval(
      `[...document.querySelectorAll('.pub-list a')].map((a) => a.textContent.trim())`);
    await cdp.clickLink('deep/');
    const deepPath = await cdp.eval('location.pathname');
    const deepListed = await cdp.eval(
      `[...document.querySelectorAll('.pub-list a')].map((a) => a.textContent.trim())`);
    claim(
      'F6 the generated listing is navigable, root -> guide/ -> deep/',
      guidePath === `/p/${pub.id}/guide/` && deepPath === `/p/${pub.id}/guide/deep/` &&
        listed.includes('setup.md') && deepListed.includes('more.md'),
      `guide=${guidePath} listed=${JSON.stringify(listed)} deep=${deepPath} listed=${JSON.stringify(deepListed)}`,
    );

    // -- excluded content is nowhere in any rendered page ----------------
    await cdp.goto(base);
    const wholePage = await cdp.eval('document.documentElement.innerHTML');
    const leaks = ['SECRET-IN-HISTORY', 'super-secret-env-value', 'MARKER-PEM',
      'MARKER-NODE-MODULES', 'TOP-SECRET-OUTSIDE'].filter((s) => wholePage.includes(s));
    claim(
      'F0 nothing excluded appears anywhere in the rendered tree',
      leaks.length === 0,
      leaks.length ? `LEAKED: ${leaks.join(', ')}` : 'no .git, .env, key material, node_modules or out-of-root content',
    );

    // -- F7 -------------------------------------------------------------
    await owner('DELETE', `/api/publications/${pub.id}`);
    await cdp.goto(`${base}guide/setup.md`);
    const revokedDeep = await cdp.eval('document.body.innerText');
    await cdp.goto(base);
    const revokedRoot = await cdp.eval('document.body.innerText');
    await cdp.shot('04-revoked');
    claim(
      'F7 revoking kills the WHOLE tree at once, in words',
      revokedRoot.includes('not valid') && revokedDeep.includes('not valid'),
      `root=${JSON.stringify(revokedRoot.trim().slice(0, 60))} deep-page=${JSON.stringify(revokedDeep.trim().slice(0, 40))}`,
    );
  } finally {
    // Never leave a publication standing, whatever happened above.
    await owner('DELETE', '/api/publications').catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} claims held`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`setup error: ${e.message}`);
  process.exit(2);
});
