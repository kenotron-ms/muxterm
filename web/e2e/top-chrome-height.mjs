#!/usr/bin/env node
/**
 * top-chrome-height.mjs -- the title bar and the sidebar header are ONE height,
 * proven in a REAL BROWSER against the REAL components.
 *
 * WHY A MEASUREMENT AND NOT A UNIT TEST. The claim is not "theme.ts emits a
 * string". The claim is "these two surfaces render at the same height, and they
 * do so BECAUSE they read one token". Only a browser with the real shadow
 * styles, the real cascade and the real box model can answer that. The vitest
 * assertion in theme.test.ts guards a different and narrower failure -- the
 * token's NAME disappearing, after which both surfaces would silently fall back
 * to their own local defaults and agree by luck rather than by construction.
 *
 * M3 is the load-bearing one. M1 alone cannot distinguish "both read the token"
 * from "both happen to be 44px today", so M3 moves the token to a value nothing
 * else in the tree uses and requires BOTH surfaces to follow it.
 *
 * WHAT THIS DOES NOT START, deliberately: no muxterm server and no sessiond.
 * Nothing here reads muxterm's config, runtime dir, sessiond socket or the
 * crash-restore snapshot, because nothing here is muxterm -- it is a frontend
 * dev server and a throwaway Chrome. Production on 9090/8311 is unreachable
 * from this process. Ports below are neither those nor 8313 (dev-local's).
 *
 * Usage:
 *   cd web && npx vite --port 5211 --strictPort --host 127.0.0.1 &
 *   google-chrome --headless=new --remote-debugging-port=9345 \
 *     --user-data-dir="$(mktemp -d)" --no-sandbox --window-size=1280,900 about:blank &
 *   node web/e2e/top-chrome-height.mjs
 *
 * Exit codes:
 *   0 -- every claim held
 *   1 -- a claim failed (the failing claim is printed)
 *   2 -- setup error: dev server or browser not reachable
 */

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : fallback;
};

const APP_URL = argOf('--url', 'http://127.0.0.1:5211/');
const CDP_URL = argOf('--cdp', 'http://127.0.0.1:9345');

// ---------------------------------------------------------------------------
// CDP plumbing -- same shape as web/e2e/markdown-stream.mjs.
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
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

// ---------------------------------------------------------------------------
// Harness: mount the REAL elements with the REAL theme tokens applied the way
// app.ts applies them, and expose measuring functions.
// ---------------------------------------------------------------------------
const HARNESS = `(async () => {
  const { applyThemeTokens, resolvePalette } = await import('/src/lib/theme.ts');

  // Define-once. After vite has HMR'd a component, it serves that module from a
  // timestamped URL, so a plain import here would be a SECOND module instance
  // and Lit's @customElement would throw on the duplicate define. Whoever got
  // there first wins; either way the registry holds the current source.
  const need = async (tag, path) => {
    if (!customElements.get(tag)) {
      try { await import(path); } catch (e) { if (!customElements.get(tag)) throw e; }
    }
    await customElements.whenDefined(tag);
  };
  await need('mux-title-bar', '/src/components/title-bar.ts');
  await need('mux-sidebar', '/src/components/mux-sidebar.ts');

  // The production path: exactly what app.ts calls at startup.
  applyThemeTokens(resolvePalette('tokyo-night'));

  document.body.innerHTML = '';
  document.body.style.margin = '0';

  const bar = document.createElement('mux-title-bar');
  const side = document.createElement('mux-sidebar');
  // The sidebar rail needs a width to lay out in; height must NOT be
  // constrained, or .header's height would be a consequence of the harness
  // rather than of the token.
  side.style.display = 'block';
  side.style.width = '260px';
  document.body.append(bar, side);

  await bar.updateComplete;
  await side.updateComplete;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const header = () => side.shadowRoot.querySelector('.header');

  window.__tc = {
    // Rounded to 3dp: getBoundingClientRect is subpixel and 44 can arrive as
    // 43.999999. Rounding here would hide a real 1px difference; it only hides
    // float noise.
    heights: () => ({
      titleBar: +bar.getBoundingClientRect().height.toFixed(3),
      sidebarHeader: +header().getBoundingClientRect().height.toFixed(3),
    }),

    // What each element RESOLVED the shared token to, read from the element
    // itself -- so this reflects the cascade as each surface actually sees it,
    // not what :root was set to.
    tokenAt: () => ({
      titleBar: getComputedStyle(bar).getPropertyValue('--mux-titlebar-height').trim(),
      sidebarHeader: getComputedStyle(header()).getPropertyValue('--mux-titlebar-height').trim(),
      root: getComputedStyle(document.documentElement).getPropertyValue('--mux-titlebar-height').trim(),
      dock: getComputedStyle(document.documentElement).getPropertyValue('--mux-dock-height').trim(),
    }),

    // The declared height of each surface, as authored. Proves the two rules
    // name the same custom property rather than two different ones.
    declared: () => ({
      titleBarNavH: getComputedStyle(bar).getPropertyValue('--nav-h').trim(),
      sidebarHeaderHeight: getComputedStyle(header()).height,
      sidebarBoxSizing: getComputedStyle(header()).boxSizing,
      titleBarBoxSizing: getComputedStyle(bar).boxSizing,
    }),

    // env(safe-area-inset-top) is not readable directly; measure it via a probe
    // whose padding is that env value. On this headless desktop it should be 0,
    // which is WHY the two heights can be equal here at all.
    safeAreaTop: () => {
      const p = document.createElement('div');
      p.style.cssText = 'position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top, 0px)';
      document.body.appendChild(p);
      const v = getComputedStyle(p).paddingTop;
      p.remove();
      return v;
    },

    // The causal test. Move the token; both surfaces must follow.
    setToken: async (v) => {
      document.documentElement.style.setProperty('--mux-titlebar-height', v);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    clearToken: async () => {
      applyThemeTokens(resolvePalette('tokyo-night'));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
  };
  return 'ready';
})()`;

// ---------------------------------------------------------------------------

let failures = 0;
const pass = (id, what, detail) => console.log(`  PASS  ${id}  ${what}${detail ? `\n            ${detail}` : ''}`);
const fail = (id, what, detail) => {
  failures++;
  console.log(`  FAIL  ${id}  ${what}${detail ? `\n            ${detail}` : ''}`);
};

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
  // A FRESH document every run. The custom-element registry is per-document and
  // Lit's @customElement throws on a second define, so a re-run against a page
  // vite had already HMR'd would die installing the harness rather than
  // measuring anything. about:blank first, then a cache-busted URL.
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await new Promise((r) => setTimeout(r, 300));
  const url = APP_URL + (APP_URL.includes('?') ? '&' : '?') + 'tc=' + Date.now();
  await cdp.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 2500));

  const ready = await cdp.eval(HARNESS).catch((e) => {
    console.error(`setup: harness failed to install: ${e.message}`);
    process.exit(2);
  });
  if (ready !== 'ready') {
    console.error('setup: harness did not report ready');
    process.exit(2);
  }

  const ua = (await cdp.eval('navigator.userAgent')).match(/Chrome\/[\d.]+/)?.[0];
  console.log(`\nreal browser: ${ua}   page: ${url}`);
  console.log('elements: real <mux-title-bar> and real <mux-sidebar>, theme applied via applyThemeTokens()\n');

  const inset = await cdp.eval('window.__tc.safeAreaTop()');
  const tok = await cdp.eval('JSON.stringify(window.__tc.tokenAt())').then(JSON.parse);
  const dec = await cdp.eval('JSON.stringify(window.__tc.declared())').then(JSON.parse);
  const h = await cdp.eval('JSON.stringify(window.__tc.heights())').then(JSON.parse);

  console.log('measured');
  console.log('  ' + '-'.repeat(70));
  console.log(`  <mux-title-bar>          getBoundingClientRect().height  ${h.titleBar}px`);
  console.log(`  <mux-sidebar> .header    getBoundingClientRect().height  ${h.sidebarHeader}px`);
  console.log(`  env(safe-area-inset-top) measured via probe              ${inset}`);
  console.log(`  --mux-titlebar-height    at :root                        ${tok.root}`);
  console.log(`  --mux-dock-height        at :root                        ${tok.dock}`);
  console.log(`  --nav-h                  resolved on the title bar       ${dec.titleBarNavH}`);
  console.log(`  height                   resolved on .header             ${dec.sidebarHeaderHeight}`);
  console.log(`  box-sizing               title bar / .header             ${dec.titleBarBoxSizing} / ${dec.sidebarBoxSizing}`);
  console.log('');

  console.log('claims');
  console.log('  ' + '-'.repeat(70));

  // M1 -- the heights are equal.
  if (h.titleBar === h.sidebarHeader) {
    pass('M1', 'the two surfaces render at the same pixel height', `both ${h.titleBar}px`);
  } else {
    fail('M1', 'the two surfaces render at the same pixel height',
      `title bar ${h.titleBar}px vs sidebar header ${h.sidebarHeader}px (drift ${Math.abs(h.titleBar - h.sidebarHeader)}px)`);
  }

  // M2 -- both resolve the SAME shared token, and it is the one theme.ts emits.
  const shared = tok.titleBar && tok.titleBar === tok.sidebarHeader && tok.titleBar === tok.root;
  if (shared) {
    pass('M2', 'both surfaces resolve the same --mux-titlebar-height', `both see "${tok.titleBar}" (from --mux-dock-height ${tok.dock})`);
  } else {
    fail('M2', 'both surfaces resolve the same --mux-titlebar-height',
      `title bar "${tok.titleBar}" / .header "${tok.sidebarHeader}" / :root "${tok.root}"`);
  }

  // M3 -- the causal test. 61px is a value nothing else in the tree uses, so a
  // surface that arrives there did so THROUGH the token.
  await cdp.eval('window.__tc.setToken("61px")');
  const moved = await cdp.eval('JSON.stringify(window.__tc.heights())').then(JSON.parse);
  if (moved.titleBar === 61 && moved.sidebarHeader === 61) {
    pass('M3', 'moving the token moves BOTH surfaces (causal, not coincidence)',
      `token 44px -> 61px: title bar ${h.titleBar} -> ${moved.titleBar}px, .header ${h.sidebarHeader} -> ${moved.sidebarHeader}px`);
  } else {
    fail('M3', 'moving the token moves BOTH surfaces (causal, not coincidence)',
      `token set to 61px but title bar is ${moved.titleBar}px and .header is ${moved.sidebarHeader}px`);
  }

  // M4 -- and back, so the token is the only thing holding either height.
  await cdp.eval('window.__tc.clearToken()');
  const back = await cdp.eval('JSON.stringify(window.__tc.heights())').then(JSON.parse);
  if (back.titleBar === h.titleBar && back.sidebarHeader === h.sidebarHeader) {
    pass('M4', 'restoring the token restores both heights', `both back to ${back.titleBar}px`);
  } else {
    fail('M4', 'restoring the token restores both heights',
      `title bar ${back.titleBar}px, .header ${back.sidebarHeader}px, expected ${h.titleBar}px`);
  }

  // M5 -- the safe-area caveat, stated as a measurement rather than assumed.
  // The title bar is height: calc(var(--nav-h) + env(safe-area-inset-top)). On a
  // notched device it is LEGITIMATELY taller than the token; the equality above
  // holds here because the inset measured 0px. Recording that makes the claim
  // honest about where it does and does not apply.
  if (inset === '0px') {
    pass('M5', 'the safe-area inset is 0px here, so title bar == token exactly',
      'on a notched device the bar is token + inset BY DESIGN and would exceed .header by the inset');
  } else {
    fail('M5', 'the safe-area inset is 0px here', `probe measured padding-top ${inset}`);
  }

  console.log('');
  if (failures) {
    console.log(`${failures} claim(s) FAILED`);
    process.exit(1);
  }
  console.log('all claims held');
  process.exit(0);
}

main().catch((e) => {
  console.error(`unexpected: ${e.stack ?? e.message}`);
  process.exit(2);
});
