#!/usr/bin/env node
/**
 * files-publish.mjs -- the Files applet's publish affordance, driven in a REAL
 * BROWSER against a RUNNING muxterm.
 *
 * WHAT IT PROVES:
 *   F1 a file row offers `publish`, and the offer is quiet until the row is
 *      under the pointer or holds focus
 *   F2 the offer CONFIRMS before exposing anything, and the confirmation says
 *      what it means -- anyone with the link, live, 24h
 *   F3 confirming publishes: the row changes to the published state and the
 *      URL is real (fetched anonymously in a second, credential-free context)
 *   F4 the published state is TYPOGRAPHIC -- a marker, accent ink, heavier
 *      name, whole-row wash -- and carries NO rounded card with a bolded side
 *      border, which the user has ruled out as generic AI chrome
 *   F5 the link is copyable
 *   F6 revoke removes the state from the row AND kills the URL
 *   F7 a publication whose file was replaced shows as broken ON THE ROW
 *
 * Usage:
 *   node web/e2e/files-publish.mjs --base http://127.0.0.1:8314 \
 *        [--cdp http://127.0.0.1:9334] [--dir /tmp/pub-fixtures] [--shot DIR]
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : fallback;
};

const BASE = argOf('--base', 'http://127.0.0.1:8314');
const CDP = argOf('--cdp', 'http://127.0.0.1:9334');
const DIR = argOf('--dir', '/tmp/pub-fixtures-applet');
const SHOT_DIR = argOf('--shot', '');

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
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (await this.eval('document.readyState === "complete"').catch(() => false)) break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  async shot(name) {
    if (!SHOT_DIR) return;
    mkdirSync(SHOT_DIR, { recursive: true });
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.data, 'base64'));
  }
}

const results = [];
const claim = (id, ok, detail) => {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};

// A shadow-piercing query, defined once in the page and reused by every step.
const HELPERS = `
window.__deep = (sel, root = document) => {
  const found = root.querySelector(sel);
  if (found) return found;
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const hit = el.shadowRoot.querySelector(sel) ?? walk(el.shadowRoot);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root);
};
window.__filesRoot = () => window.__deep('applet-files')?.shadowRoot ?? null;
window.__row = (name) => {
  const r = window.__filesRoot();
  if (!r) return null;
  return [...r.querySelectorAll('.row.file')].find(
    (el) => el.querySelector('.nm')?.textContent?.trim() === name
  ) ?? null;
};
window.__rowInfo = (name) => {
  const row = window.__row(name);
  if (!row) return null;
  const cs = getComputedStyle(row);
  const nm = row.querySelector('.nm');
  const acts = [...row.querySelectorAll('.act')].map((b) => ({
    text: b.textContent.trim(),
    opacity: getComputedStyle(b).opacity,
  }));
  return {
    classes: [...row.classList],
    background: cs.backgroundColor,
    borderWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
    borderRadius: cs.borderRadius,
    nameColor: nm ? getComputedStyle(nm).color : '',
    nameWeight: nm ? getComputedStyle(nm).fontWeight : '',
    marker: row.querySelector('.pubmark')?.textContent?.trim() ?? '',
    label: row.querySelector('.publbl')?.textContent?.trim() ?? '',
    left: row.querySelector('.left')?.textContent?.trim() ?? '',
    warnline: row.querySelector('.warnline')?.textContent?.trim() ?? '',
    acts,
    text: row.innerText.replace(/\\s+/g, ' ').trim(),
  };
};
window.__clickAct = (name, label) => {
  const row = window.__row(name);
  if (!row) return 'no row';
  const b = [...row.querySelectorAll('.act')].find((x) => x.textContent.trim() === label);
  if (!b) return 'no button ' + label;
  b.click();
  return 'ok';
};
window.__clickDir = (name) => {
  const r = window.__filesRoot();
  if (!r) return 'no root';
  const row = [...r.querySelectorAll('.row.dir')].find(
    (el) => el.querySelector('.nm')?.textContent?.trim() === name
  );
  if (!row) return 'no dir ' + name;
  row.click();
  return 'ok';
};
window.__hover = (name) => {
  const row = window.__row(name);
  if (!row) return 'no row';
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  const b = row.querySelector('.act');
  if (b) b.focus();
  return 'ok';
};
true;
`;

const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let cdp;
  try {
    cdp = await Cdp.attach(CDP);
  } catch (e) {
    console.error(`setup: cannot reach a browser at ${CDP}: ${e.message}`);
    process.exit(2);
  }

  // A brand-new fixture directory for every run: AGENTS.md's verification
  // hygiene rule, applied to files rather than panes.
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/report.md`, '# Report\n\nA file worth sending to somebody.\n');
  writeFileSync(`${DIR}/swapped.md`, '# Innocuous\n\nnothing here yet\n');
  writeFileSync(`${DIR}/other.md`, '# Other\n\nnot published\n');

  // Land on the app, point the Files applet at the fixture directory through
  // its OWN persistence key, then reload so it opens there.
  await cdp.goto(`${BASE}/`);
  await cdp.eval(`localStorage.setItem('muxterm.applet.files.path', ${JSON.stringify(DIR)}), true`);
  await cdp.goto(`${BASE}/`);
  await cdp.eval(HELPERS);

  // Open the Dashboard the way the sidebar does.
  await cdp.eval(`
    (() => {
      const sb = window.__deep('mux-sidebar');
      (sb ?? document.body).dispatchEvent(
        new CustomEvent('home-show', { bubbles: true, composed: true })
      );
      return true;
    })()
  `);
  await settle(900);
  await cdp.eval(HELPERS);

  // Make sure the Files tab is the active applet.
  await cdp.eval(`
    (() => {
      const host = window.__deep('mux-applets');
      if (!host || !host.shadowRoot) return 'no host';
      const tab = [...host.shadowRoot.querySelectorAll('button')]
        .find((b) => b.textContent.trim().toLowerCase() === 'files');
      if (tab) tab.click();
      return 'ok';
    })()
  `);
  await settle(900);
  await cdp.eval(HELPERS);
  await cdp.shot('10-files-applet');

  const seen = await cdp.eval(`JSON.stringify({
    rows: [...(window.__filesRoot()?.querySelectorAll('.row.file') ?? [])]
      .map(r => r.querySelector('.nm')?.textContent?.trim()),
  })`).then(JSON.parse);
  if (!seen.rows.includes('report.md')) {
    console.error(`setup: the applet is not showing ${DIR}; rows = ${JSON.stringify(seen.rows)}`);
    process.exit(2);
  }

  // --- F1 the offer exists, and is quiet exactly when it should be ----------
  //
  // The rule is conditional, so the check is too: with a pointer the offer
  // hides until the row is hovered or holds focus; with NO pointer -- a touch
  // device, and headless Chrome, which reports (hover: none) -- there is
  // nothing to hover with, so it is simply always visible. Asserting the
  // pointer behaviour in a browser that has no pointer would be testing the
  // harness rather than the rule.
  const noHover = await cdp.eval(`matchMedia('(hover: none)').matches`);
  const quiet = await cdp.eval(`JSON.stringify(window.__rowInfo('report.md'))`).then(JSON.parse);
  await cdp.eval(`window.__hover('report.md')`);
  await settle(200);
  const hovered = await cdp.eval(`JSON.stringify(window.__rowInfo('report.md'))`).then(JSON.parse);
  const offered = quiet.acts.some((a) => a.text === 'publish');
  claim(
    `F1 a file row offers \`publish\`${noHover ? ', always visible with no pointer' : ', quiet until hover/focus'}`,
    offered &&
      (noHover
        ? quiet.acts[0].opacity === '1'
        : quiet.acts[0].opacity === '0' && hovered.acts[0].opacity === '1'),
    `(hover:none)=${noHover} resting opacity=${quiet.acts[0]?.opacity} focused opacity=${hovered.acts[0]?.opacity} acts=${JSON.stringify(quiet.acts.map((a) => a.text))}`,
  );

  // --- F2 it confirms, and the confirmation says what it means --------------
  await cdp.eval(`window.__clickAct('report.md', 'publish')`);
  await settle(300);
  await cdp.shot('11-confirm');
  const confirming = await cdp.eval(`JSON.stringify(window.__rowInfo('report.md'))`).then(JSON.parse);
  claim(
    'F2 publishing confirms first, and the confirmation states the exposure',
    /anyone with the link/.test(confirming.warnline) &&
      /live/.test(confirming.warnline) &&
      /24h/.test(confirming.warnline) &&
      confirming.acts.some((a) => a.text === 'cancel'),
    JSON.stringify(confirming.warnline),
  );

  // --- F3 confirming actually publishes -------------------------------------
  await cdp.eval(`window.__clickAct('report.md', 'publish')`);
  await settle(900);
  await cdp.eval(HELPERS);
  await cdp.shot('12-published');
  const published = await cdp.eval(`JSON.stringify(window.__rowInfo('report.md'))`).then(JSON.parse);
  const pubs = JSON.parse(await cdp.eval(`fetch('/api/publications').then(r => r.text())`));
  const mine = pubs.find((p) => p.path === `${DIR}/report.md`);
  const anon = mine ? await fetch(new URL(mine.url, BASE).toString()) : null;
  const anonBody = anon ? await anon.text() : '';
  claim(
    'F3 confirming publishes, and the URL really serves the file anonymously',
    published.classes.includes('published') &&
      !!mine &&
      anon.status === 200 &&
      /A file worth sending to somebody/.test(anonBody),
    `row=${JSON.stringify(published.text)} url=${mine?.url} anon=${anon?.status}`,
  );

  // --- F4 the published state is typographic, not a card --------------------
  const other = await cdp.eval(`JSON.stringify(window.__rowInfo('other.md'))`).then(JSON.parse);
  const noBorders = published.borderWidths.every((w) => w === '0px');
  claim(
    'F4 published state is typographic: marker + accent word + weight + row wash, no card',
    published.marker === '↗' &&
      published.label === 'public' &&
      /^\d+h$/.test(published.left) &&
      noBorders &&
      published.background !== other.background &&
      Number(published.nameWeight) > Number(other.nameWeight),
    `marker=${published.marker} label=${published.label} left=${published.left} weight ${other.nameWeight}->${published.nameWeight} wash ${other.background} -> ${published.background} borders=${JSON.stringify(published.borderWidths)}`,
  );

  // --- F5 the link is copyable ----------------------------------------------
  await cdp.send('Browser.grantPermissions', {
    origin: BASE,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  }).catch(() => {});
  // The Clipboard API refuses on an unfocused document, which a headless page
  // is by default.
  await cdp.send('Page.bringToFront').catch(() => {});
  await cdp.eval(`window.__clickAct('report.md', 'copy link')`);
  await settle(500);
  const afterCopy = await cdp.eval(`JSON.stringify(window.__rowInfo('report.md'))`).then(JSON.parse);
  const clip = await cdp.eval(`navigator.clipboard.readText().catch(() => '')`);
  // Either outcome is a pass, because BOTH are the specified behaviour: the
  // link reaches the clipboard, or the clipboard is unreachable and the URL is
  // put on screen as selectable text instead. A button that silently does
  // nothing is the only failure.
  const fallback = await cdp.eval(
    `window.__filesRoot()?.querySelector('.puberr')?.textContent?.trim() ?? ''`,
  );
  claim(
    'F5 the link is copyable, or the URL is shown when the clipboard is unreachable',
    afterCopy.acts.some((a) => a.text === 'copied') ||
      clip.includes('/p/') ||
      fallback.includes('/p/'),
    `label=${JSON.stringify(afterCopy.acts.map((a) => a.text))} clipboard=${JSON.stringify(clip)} fallback=${JSON.stringify(fallback)}`,
  );

  // --- F7 a broken publication shows as broken ON THE ROW --------------------
  const { execSync } = await import('node:child_process');
  await cdp.eval(`window.__hover('swapped.md')`);
  await cdp.eval(`window.__clickAct('swapped.md', 'publish')`);
  await settle(200);
  await cdp.eval(`window.__clickAct('swapped.md', 'publish')`);
  await settle(900);
  writeFileSync(`${DIR}/elsewhere.md`, '# elsewhere\n\nSWAPPED-SECRET\n');
  execSync(`rm -f ${JSON.stringify(`${DIR}/swapped.md`)} && ln -s ${JSON.stringify(`${DIR}/elsewhere.md`)} ${JSON.stringify(`${DIR}/swapped.md`)}`);
  // Re-read the directory the way a user would -- up to the parent and back
  // in -- rather than by poking a private method. A re-read is what refreshes
  // the publication state, and proving THAT is part of the claim.
  await cdp.eval(`window.__clickDir('..')`);
  await settle(800);
  await cdp.eval(HELPERS);
  await cdp.eval(`window.__clickDir(${JSON.stringify(DIR.split('/').pop())})`);
  await settle(1000);
  await cdp.eval(HELPERS);
  await cdp.shot('13-broken');
  const broken = await cdp.eval(`JSON.stringify(window.__rowInfo('swapped.md'))`).then(JSON.parse);
  claim(
    'F7 a publication whose file was replaced reads as broken on its row',
    broken !== null && broken.classes.includes('pubbroken') && broken.label === 'broken',
    `classes=${JSON.stringify(broken?.classes)} label=${broken?.label}`,
  );

  // --- F6 revoke ------------------------------------------------------------
  const url = new URL(mine.url, BASE).toString();
  await cdp.eval(`window.__clickAct('report.md', 'revoke')`);
  await settle(900);
  await cdp.eval(HELPERS);
  await cdp.shot('14-revoked');
  const revoked = await cdp.eval(`JSON.stringify(window.__rowInfo('report.md'))`).then(JSON.parse);
  const afterStatus = (await fetch(url)).status;
  claim(
    'F6 revoke clears the row and kills the URL immediately',
    !revoked.classes.includes('published') && revoked.label === '' && afterStatus === 404,
    `classes=${JSON.stringify(revoked.classes)} url now HTTP ${afterStatus}`,
  );

  await cdp.eval(`fetch('/api/publications', { method: 'DELETE' }).then(r => r.status)`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} claims held`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`error: ${e.stack ?? e.message}`);
  process.exit(2);
});
