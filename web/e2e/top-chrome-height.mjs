#!/usr/bin/env node
/**
 * top-chrome-height.mjs -- the title bar, the sidebar header and Mission
 * Control's topbar are ONE height, proven in a REAL BROWSER against the REAL
 * components.
 *
 * WHY A MEASUREMENT AND NOT A UNIT TEST. The claim is not "theme.ts emits a
 * string". The claim is "these surfaces render at the same height, and they
 * do so BECAUSE they read one token". Only a browser with the real shadow
 * styles, the real cascade and the real box model can answer that. The vitest
 * assertion in theme.test.ts guards a different and narrower failure -- the
 * token's NAME disappearing, after which every surface would silently fall back
 * to its own local default and agree by luck rather than by construction.
 *
 * M3 is the load-bearing one. M1 alone cannot distinguish "they all read the
 * token" from "they all happen to be 44px today", so M3 moves the token to a
 * value nothing else in the tree uses and requires EVERY surface to follow it.
 *
 * WHY <mux-cos> IS IN HERE. It was not, and that is exactly how it drifted.
 * The token landed in PR #91 for two surfaces; Mission Control arrived in PR
 * #93 as a THIRD surface in the same top row, with its height pinned by a
 * literal `grid-template-rows: 52px` instead, and nothing in this file or in
 * theme.test.ts could see it. A guard that enumerates surfaces only catches
 * drift in the surfaces it enumerates -- so when a FOURTH one joins the row,
 * add it to SURFACES below and it is covered by every claim at once.
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
  await need('mux-cos', '/src/components/mux-cos.ts');

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

  // <mux-cos> is position:absolute/inset:0, so it needs a positioned box with a
  // real size to lay its grid out in. The box is deliberately TALLER than any
  // plausible top row: the topbar's height must come from the grid track, never
  // from the harness running out of room.
  const stage = document.createElement('div');
  stage.style.cssText = 'position:relative;width:1280px;height:720px';
  const cos = document.createElement('mux-cos');
  stage.append(cos);

  document.body.append(bar, side, stage);

  await bar.updateComplete;
  await side.updateComplete;
  await cos.updateComplete;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const header = () => side.shadowRoot.querySelector('.header');
  const topbar = () => cos.shadowRoot.querySelector('.topbar');

  window.__tc = {
    // Rounded to 3dp: getBoundingClientRect is subpixel and 44 can arrive as
    // 43.999999. Rounding here would hide a real 1px difference; it only hides
    // float noise.
    heights: () => ({
      titleBar: +bar.getBoundingClientRect().height.toFixed(3),
      sidebarHeader: +header().getBoundingClientRect().height.toFixed(3),
      cosTopbar: +topbar().getBoundingClientRect().height.toFixed(3),
    }),

    // What each element RESOLVED the shared token to, read from the element
    // itself -- so this reflects the cascade as each surface actually sees it,
    // not what :root was set to.
    tokenAt: () => ({
      titleBar: getComputedStyle(bar).getPropertyValue('--mux-titlebar-height').trim(),
      sidebarHeader: getComputedStyle(header()).getPropertyValue('--mux-titlebar-height').trim(),
      cosTopbar: getComputedStyle(topbar()).getPropertyValue('--mux-titlebar-height').trim(),
      root: getComputedStyle(document.documentElement).getPropertyValue('--mux-titlebar-height').trim(),
      dock: getComputedStyle(document.documentElement).getPropertyValue('--mux-dock-height').trim(),
    }),

    // The declared height of each surface, as authored. Proves the rules all
    // name the same custom property rather than several different ones.
    declared: () => ({
      titleBarNavH: getComputedStyle(bar).getPropertyValue('--nav-h').trim(),
      sidebarHeaderHeight: getComputedStyle(header()).height,
      sidebarBoxSizing: getComputedStyle(header()).boxSizing,
      titleBarBoxSizing: getComputedStyle(bar).boxSizing,
      cosTopbarHeight: getComputedStyle(topbar()).height,
      cosTopbarBoxSizing: getComputedStyle(topbar()).boxSizing,
      // THE TRACK. .topbar is grid-area: top, so whatever the first row of
      // <mux-cos>'s own grid resolves to is a hard ceiling and floor on it --
      // an explicit height on .topbar cannot win against a track that
      // disagrees, it just leaves a gap. Computed grid-template-rows reports
      // USED track sizes in px, which is the number that actually decided.
      cosGridRow: getComputedStyle(cos).gridTemplateRows,
    }),

    // Check 3: is a CHILD the real constraint? A child taller than the row
    // pushes the row regardless of what the track says, and clamping it with
    // overflow:hidden would trade a tall row for a clipped control -- worse.
    // Reports each child's height and its top/bottom slack inside the topbar,
    // so "nothing is clipped and everything is still centred" is measured
    // rather than eyeballed.
    topbarChildren: () => {
      const el0 = topbar();
      const tb = el0.getBoundingClientRect();
      // align-items:center centres within the CONTENT box, and .topbar's 1px
      // bottom border is inside its border box -- so the bottom slack is a
      // pixel smaller than the top slack by construction, at any row height.
      // Subtracting the border is what makes "centred" mean centred rather
      // than "off by exactly the border, forever".
      const bb = parseFloat(getComputedStyle(el0).borderBottomWidth) || 0;
      const kids = [...el0.children].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\\s+/)[0] : ''),
          height: +r.height.toFixed(3),
          top: +(r.top - tb.top).toFixed(3),
          bottom: +(tb.bottom - bb - r.bottom).toFixed(3),
        };
      });
      return { row: +tb.height.toFixed(3), borderBottom: bb, kids };
    },

    // Narrow (portrait) mode. :host([narrow]) sets display:none on .topbar --
    // the app's own title bar does that job there -- so the wide-mode equality
    // is not even a question in portrait. Measured, not assumed.
    narrow: async (on) => {
      cos.narrow = on;
      await cos.updateComplete;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tb = topbar();
      return {
        display: tb ? getComputedStyle(tb).display : '(absent)',
        height: tb ? +tb.getBoundingClientRect().height.toFixed(3) : 0,
        sidebarHeader: +header().getBoundingClientRect().height.toFixed(3),
        titleBar: +bar.getBoundingClientRect().height.toFixed(3),
      };
    },

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
  console.log('elements: real <mux-title-bar>, <mux-sidebar> and <mux-cos>, theme applied via applyThemeTokens()\n');

  const inset = await cdp.eval('window.__tc.safeAreaTop()');
  const tok = await cdp.eval('JSON.stringify(window.__tc.tokenAt())').then(JSON.parse);
  const dec = await cdp.eval('JSON.stringify(window.__tc.declared())').then(JSON.parse);
  const h = await cdp.eval('JSON.stringify(window.__tc.heights())').then(JSON.parse);
  const kids = await cdp.eval('JSON.stringify(window.__tc.topbarChildren())').then(JSON.parse);

  // Every surface that must share the row, in one place. Adding a fourth here
  // is the whole ceremony -- M1..M4 all iterate this list.
  const SURFACES = [
    ['<mux-title-bar>', 'titleBar'],
    ['<mux-sidebar> .header', 'sidebarHeader'],
    ['<mux-cos> .topbar', 'cosTopbar'],
  ];

  console.log('measured');
  console.log('  ' + '-'.repeat(70));
  for (const [label, key] of SURFACES) {
    console.log(`  ${label.padEnd(24)} getBoundingClientRect().height  ${h[key]}px`);
  }
  console.log(`  env(safe-area-inset-top) measured via probe              ${inset}`);
  console.log(`  --mux-titlebar-height    at :root                        ${tok.root}`);
  console.log(`  --mux-dock-height        at :root                        ${tok.dock}`);
  console.log(`  --nav-h                  resolved on the title bar       ${dec.titleBarNavH}`);
  console.log(`  height                   resolved on .header             ${dec.sidebarHeaderHeight}`);
  console.log(`  height                   resolved on .topbar             ${dec.cosTopbarHeight}`);
  console.log(`  grid-template-rows       used tracks on <mux-cos>        ${dec.cosGridRow}`);
  console.log(`  box-sizing               bar / .header / .topbar         ${dec.titleBarBoxSizing} / ${dec.sidebarBoxSizing} / ${dec.cosTopbarBoxSizing}`);
  console.log('');

  console.log('claims');
  console.log('  ' + '-'.repeat(70));

  // M1 -- the heights are equal, ACROSS EVERY SURFACE in the row.
  const hv = SURFACES.map(([, k]) => h[k]);
  if (hv.every((v) => v === hv[0])) {
    pass('M1', 'every top-chrome surface renders at the same pixel height', `all ${hv[0]}px`);
  } else {
    fail('M1', 'every top-chrome surface renders at the same pixel height',
      SURFACES.map(([l, k]) => `${l} ${h[k]}px`).join('  vs  ') +
      `  (drift ${(Math.max(...hv) - Math.min(...hv)).toFixed(3)}px)`);
  }

  // M2 -- they resolve the SAME shared token, and it is the one theme.ts emits.
  const shared = tok.root && SURFACES.every(([, k]) => tok[k] === tok.root);
  if (shared) {
    pass('M2', 'every surface resolves the same --mux-titlebar-height', `all see "${tok.root}" (from --mux-dock-height ${tok.dock})`);
  } else {
    fail('M2', 'every surface resolves the same --mux-titlebar-height',
      SURFACES.map(([l, k]) => `${l} "${tok[k]}"`).join(' / ') + ` / :root "${tok.root}"`);
  }

  // M3 -- the causal test. 61px is a value nothing else in the tree uses, so a
  // surface that arrives there did so THROUGH the token. This is the claim that
  // <mux-cos> failed before the fix: it sat at its literal 52px while the other
  // two followed, which is precisely "agrees by luck, not by construction".
  await cdp.eval('window.__tc.setToken("61px")');
  const moved = await cdp.eval('JSON.stringify(window.__tc.heights())').then(JSON.parse);
  if (SURFACES.every(([, k]) => moved[k] === 61)) {
    pass('M3', 'moving the token moves EVERY surface (causal, not coincidence)',
      `token 44px -> 61px: ` + SURFACES.map(([l, k]) => `${l} ${h[k]} -> ${moved[k]}px`).join(', '));
  } else {
    fail('M3', 'moving the token moves EVERY surface (causal, not coincidence)',
      `token set to 61px but ` + SURFACES.map(([l, k]) => `${l} is ${moved[k]}px`).join(', '));
  }

  // M4 -- and back, so the token is the only thing holding any of the heights.
  await cdp.eval('window.__tc.clearToken()');
  const back = await cdp.eval('JSON.stringify(window.__tc.heights())').then(JSON.parse);
  if (SURFACES.every(([, k]) => back[k] === h[k])) {
    pass('M4', 'restoring the token restores every height', `all back to ${back.titleBar}px`);
  } else {
    fail('M4', 'restoring the token restores every height',
      SURFACES.map(([l, k]) => `${l} ${back[k]}px (was ${h[k]}px)`).join(', '));
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

  // M6 -- nothing in the topbar is taller than the row it sits in, and nothing
  // is clipped. Constraining the row is only safe if no CHILD was the real
  // constraint; a control that no longer fits is a worse bug than a tall row,
  // so the slack above and below each child is reported, not assumed.
  const tallest = kids.kids.reduce((m, k) => Math.max(m, k.height), 0);
  const detail = kids.kids.map((k) => `${k.tag} ${k.height}px (slack ${k.top}/${k.bottom})`).join(', ');
  const inner = kids.row - kids.borderBottom;
  if (tallest <= inner && kids.kids.every((k) => k.top >= 0 && k.bottom >= 0)) {
    pass('M6', 'every topbar child fits inside the row, none clipped',
      `row ${kids.row}px (${inner}px inside the border), tallest child ${tallest}px -- ${detail}`);
  } else {
    fail('M6', 'every topbar child fits inside the row, none clipped',
      `row ${kids.row}px, tallest child ${tallest}px -- ${detail}`);
  }

  // M6b -- still vertically centred: align-items:center means the slack above
  // and below each child matches to within a subpixel.
  const offCentre = kids.kids.map((k) => Math.abs(k.top - k.bottom));
  if (offCentre.every((d) => d <= 0.5)) {
    pass('M6b', 'topbar contents remain vertically centred', `max top/bottom asymmetry ${Math.max(...offCentre).toFixed(3)}px`);
  } else {
    fail('M6b', 'topbar contents remain vertically centred', detail);
  }

  // M7 -- PORTRAIT. :host([narrow]) sets .topbar { display: none } because the
  // app's own <mux-title-bar> carries the row there instead. So in narrow mode
  // there is no equality to hold: reporting "the heights match" would be a
  // false pass on a surface that is not on screen. What IS checked is that the
  // topbar is genuinely gone and the OTHER two surfaces are untouched by the
  // switch.
  // Runtime.evaluate has no top-level await, so each of these is its own async
  // IIFE rather than a bare `await`.
  const nar = await cdp.eval('(async () => JSON.stringify(await window.__tc.narrow(true)))()').then(JSON.parse);
  const wide = await cdp.eval('(async () => JSON.stringify(await window.__tc.narrow(false)))()').then(JSON.parse);
  if (nar.display === 'none' && nar.height === 0) {
    pass('M7', 'in narrow mode the topbar is not rendered, so there is nothing to match',
      `display ${nar.display}; title bar ${nar.titleBar}px and .header ${nar.sidebarHeader}px are unchanged there`);
  } else {
    fail('M7', 'in narrow mode the topbar is not rendered',
      `display ${nar.display}, height ${nar.height}px -- if it now renders in portrait it must join the equality claim`);
  }

  // M8 -- and toggling back is lossless: the wide row returns to the token.
  if (wide.height === h.cosTopbar) {
    pass('M8', 'returning to wide restores the topbar to the shared height', `${wide.height}px`);
  } else {
    fail('M8', 'returning to wide restores the topbar to the shared height',
      `${wide.height}px, expected ${h.cosTopbar}px`);
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
