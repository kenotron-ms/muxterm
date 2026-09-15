#!/usr/bin/env node
/**
 * Files applet upload verification through a running isolated muxterm and a
 * real Chromium page. It drives desktop drop and picker paths with browser
 * File/DataTransfer objects; every successful assertion hashes bytes written by
 * the real server. Nothing is mocked.
 *
 * Usage:
 *   node web/e2e/files-upload.mjs --base http://127.0.0.1:8313 \
 *     --cdp http://127.0.0.1:9335 --dir "$PWD/tmp/e2e-files-upload"
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const at = args.indexOf(name);
  if (at >= 0 && at + 1 < args.length) return args[at + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
};

const BASE = argOf('--base', 'http://127.0.0.1:8313');
const CDP = argOf('--cdp', 'http://127.0.0.1:9335');
const DIR = resolve(argOf('--dir', 'tmp/e2e-files-upload'));
const outside = '/tmp/muxterm-e2e-files-upload-outside';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const claims = [];
const claim = (id, ok, detail = '') => {
  claims.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? `  ${detail}` : ''}`);
};

class Cdp {
  #ws;
  #next = 0;
  #pending = new Map();

  static async attach(base) {
    const targets = await (await fetch(`${base}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('no page target in Chromium');
    const client = new Cdp();
    await client.#connect(page.webSocketDebuggerUrl);
    return client;
  }

  #connect(url) {
    return new Promise((resolvePromise, reject) => {
      this.#ws = new WebSocket(url);
      this.#ws.onopen = resolvePromise;
      this.#ws.onerror = () => reject(new Error('could not attach to Chromium CDP'));
      this.#ws.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.#next;
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      allowUnsafeEvalBlocklistedAPI: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  close() {
    this.#ws?.close();
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    // A document already at readyState=complete can otherwise satisfy the
    // first poll before CDP has committed the navigation.
    await sleep(150);
    for (let i = 0; i < 160; i++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      if (await this.eval('document.readyState === "complete"').catch(() => false)) return;
    }
    throw new Error('page did not settle');
  }
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function until(cdp, expression, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression).catch(() => false)) return true;
    await sleep(50);
  }
  return false;
}

const pageHelpers = `
  window.__deep = (selector, root = document) => {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        const found = window.__deep(selector, element.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };
  window.__files = () => {
    const all = [];
    const visit = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.tagName === 'APPLET-FILES') all.push(element);
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    return all.find((element) => element.active && element.getClientRects().length > 0)?.shadowRoot ?? null;
  };
  window.__showFiles = () => {
    const all = [];
    const visit = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.tagName === 'MUX-APPLETS') all.push(element);
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    all.forEach((element) => element.show('files'));
  };
  window.__uploadRows = () => [...(window.__files()?.querySelectorAll('.upload-row') ?? [])];
  window.__uploadRow = (name) => window.__uploadRows().find(
    (row) => row.querySelector('.upload-name')?.textContent?.trim() === name
  ) ?? null;
  window.__button = (row, text) => [...row.querySelectorAll('button')].find(
    (button) => button.textContent.trim() === text
  );
  window.__beginDrop = (items) => {
    const root = window.__files();
    const zone = root?.querySelector('.upload-zone');
    if (!zone) return false;
    const transfer = new DataTransfer();
    for (const [name, text] of items) transfer.items.add(new File([text], name));
    zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, composed: true, dataTransfer: transfer }));
    window.__pendingDrop = { zone, transfer };
    return true;
  };
  window.__finishDrop = () => {
    const pending = window.__pendingDrop;
    if (!pending) return false;
    pending.zone.dispatchEvent(new DragEvent('drop', { bubbles: true, composed: true, dataTransfer: pending.transfer }));
    window.__pendingDrop = null;
    return true;
  };
  window.__drop = (items) => window.__beginDrop(items) && window.__finishDrop();
  window.__pick = (name, text) => {
    const root = window.__files();
    const input = root?.querySelector('.upload-input');
    if (!input) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([text], name));
    Object.defineProperty(input, 'files', { value: transfer.files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  };
  window.__pickBytes = (name, bytes) => {
    const root = window.__files();
    const input = root?.querySelector('.upload-input');
    if (!input) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], name));
    Object.defineProperty(input, 'files', { value: transfer.files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  };
  true;
`;

async function openFiles(cdp) {
  await cdp.goto(`${BASE}/`);
  await cdp.eval(`localStorage.setItem('muxterm.applet.files.path', ${JSON.stringify(DIR)}); true`);
  await cdp.goto(`${BASE}/`);
  await cdp.eval(pageHelpers);
  await cdp.eval(`
    (() => {
      const side = window.__deep('mux-sidebar');
      (side ?? document.body).dispatchEvent(new CustomEvent('home-show', { bubbles: true, composed: true }));
      window.__showFiles();
      return true;
    })()
  `);
  if (!await until(cdp, `window.__files()?.querySelector('.upload-zone') !== null`)) {
    throw new Error('Files applet did not open');
  }
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(`${DIR}/collision.txt`, 'before-keep');
  writeFileSync(`${DIR}/replace.txt`, 'before-replace');
  symlinkSync(outside, `${DIR}/outside-link`);

  cdp = await Cdp.attach(CDP);
  await openFiles(cdp);
  const initial = await cdp.eval(`JSON.stringify({
    active: window.__files()?.host?.active ?? false,
    disabled: window.__files()?.querySelector('.upload-input')?.disabled ?? null,
    available: !window.__files()?.querySelector('.upload-why'),
    reason: window.__files()?.querySelector('.upload-why')?.textContent?.trim() ?? '',
  })`);
  console.log(`INFO  initial Files upload state ${initial}`);

  // A: multi-file desktop drop. The overlay is inspected before the synthetic
  // drop starts a real XHR stream. Hashes prove the server wrote actual bytes.
  const started = await cdp.eval(`window.__beginDrop([['drop-a.txt', 'drop A'], ['drop-b.txt', 'drop B']])`);
  const overlayShown = await until(cdp, `window.__files()?.querySelector('.upload-overlay') !== null`);
  const overlay = await cdp.eval(`window.__files()?.querySelector('.upload-overlay')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`);
  await cdp.eval('window.__finishDrop()');
  const dropped = await until(cdp, `
    ['drop-a.txt', 'drop-b.txt'].every((name) => window.__uploadRow(name)?.classList.contains('complete'))
  `);
  const dropBytes = existsSync(`${DIR}/drop-a.txt`) && existsSync(`${DIR}/drop-b.txt`) &&
    hash(readFileSync(`${DIR}/drop-a.txt`)) === hash('drop A') &&
    hash(readFileSync(`${DIR}/drop-b.txt`)) === hash('drop B');
  claim('A1 desktop valid-file drag shows the destination overlay', started && overlayShown && /^Upload to /.test(overlay));
  claim(
    'A2 multi-file desktop drop streams and atomically completes exact bytes',
    dropped && dropBytes,
  );
  claim('A3 list refresh follows completed server commit', await until(cdp, `
    [...(window.__files()?.querySelectorAll('.row.file') ?? [])].some((row) => row.textContent.includes('drop-a.txt'))
  `));

  // B: picker uses the identical queue and is laid out in both Android-class
  // portrait and landscape viewports. The test drives the actual input change.
  const picked = await cdp.eval(`window.__pick('picker.txt', 'picker payload')`);
  const pickerDone = await until(cdp, `window.__uploadRow('picker.txt')?.classList.contains('complete')`);
  claim('B1 picker enters the same completed queue', picked && pickerDone && readFileSync(`${DIR}/picker.txt`, 'utf8') === 'picker payload');
  for (const [label, width, height] of [['portrait', 412, 915], ['landscape', 915, 412]]) {
    // `mobile:false` keeps Chromium's CSS viewport at the requested Android
    // size; touch emulation below supplies the coarse-pointer behavior.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    let mobile = null;
    for (let attempt = 0; attempt < 3 && !mobile?.active; attempt++) {
      await cdp.eval(`(() => {
        const side = window.__deep('mux-sidebar');
        (side ?? document.body).dispatchEvent(new CustomEvent('home-show', { bubbles: true, composed: true }));
        const cos = window.__deep('mux-cos');
        if (cos?.shadowRoot?.querySelector('.sheet') && !cos.shadowRoot.querySelector('.sheet').matches(':popover-open')) cos.toggleFleet();
        return true;
      })()`);
      await sleep(120);
      await cdp.eval(`window.__showFiles(); true`);
      await until(cdp, `window.__files()?.querySelector('.upload-input') !== null`, 1200);
      mobile = await cdp.eval(`(() => {
      const input = window.__files()?.querySelector('.upload-input');
      const control = input?.parentElement;
      const box = control?.getBoundingClientRect();
      const cos = window.__deep('mux-cos');
      const sheet = cos?.shadowRoot?.querySelector('.sheet');
      return {
        active: window.__files()?.host?.active ?? false,
        width: box?.width ?? 0,
        height: box?.height ?? 0,
        right: box?.right ?? 0,
        innerWidth,
        hasSheet: !!sheet,
        sheetOpen: sheet?.matches(':popover-open') ?? false,
      };
      })()`);
    }
    claim(`B2 ${label} Files picker remains visible and reachable`, mobile.active && mobile.width > 0 && mobile.height > 0 && mobile.right <= width + 1, JSON.stringify(mobile));
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // C: throttle a real browser upload so the queue enters the in-flight state,
  // then cancel and reload. Both paths must leave neither a completed file nor
  // a controlled temporary artifact behind.
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: 32 * 1024,
  });
  await cdp.eval(`window.__pickBytes('cancelled.bin', 60 * 1024 * 1024)`);
  const uploading = await until(cdp, `window.__uploadRow('cancelled.bin')?.classList.contains('uploading')`);
  await cdp.eval(`window.__button(window.__uploadRow('cancelled.bin'), 'cancel')?.click(); true`);
  const cancelled = await until(cdp, `window.__uploadRow('cancelled.bin')?.classList.contains('cancelled')`);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await sleep(400);
  claim(
    'C1 cancelling an in-flight upload leaves no completed or temporary file',
    uploading && cancelled && !existsSync(`${DIR}/cancelled.bin`) && readdirSync(DIR).every((name) => !name.startsWith('.muxterm-upload-')),
  );

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: 32 * 1024,
  });
  await cdp.eval(`window.__pickBytes('reloaded.bin', 60 * 1024 * 1024)`);
  const reloading = await until(cdp, `window.__uploadRow('reloaded.bin')?.classList.contains('uploading')`);
  await cdp.eval(`location.reload(); true`);
  await sleep(500);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  const c2State = {
    reloading,
    fileExists: existsSync(`${DIR}/reloaded.bin`),
    tempFree: readdirSync(DIR).every((name) => !name.startsWith('.muxterm-upload-')),
  };
  claim(
    'C2 browser reload cancels an in-flight upload without a partial file',
    c2State.reloading && !c2State.fileExists && c2State.tempFree,
    JSON.stringify(c2State),
  );
  await openFiles(cdp);

  // E: default conflict never overwrites. Keep both receives the deterministic
  // server-selected visible name; Replace requires an extra confirmation.
  await cdp.eval(`window.__drop([['collision.txt', 'keep payload']])`);
  const conflict = await until(cdp, `window.__uploadRow('collision.txt')?.classList.contains('conflict')`);
  const collisionInfo = await cdp.eval(`(() => {
    const row = window.__uploadRow('collision.txt');
    return row ? { classes: [...row.classList], text: row.textContent.replace(/\\s+/g, ' ').trim() } : null;
  })()`);
  claim('E1 collision pauses with an explicit choice and does not overwrite', conflict && readFileSync(`${DIR}/collision.txt`, 'utf8') === 'before-keep', JSON.stringify(collisionInfo));
  if (!conflict) throw new Error('collision queue did not reach its conflict state');
  await cdp.eval(`window.__button(window.__uploadRow('collision.txt'), 'keep both')?.click(); true`);
  const kept = await until(cdp, `window.__uploadRow('collision (1).txt')?.classList.contains('complete')`);
  claim('E2 Keep both saves a deterministic available name', kept && readFileSync(`${DIR}/collision (1).txt`, 'utf8') === 'keep payload');

  await cdp.eval(`window.__drop([['replace.txt', 'replacement payload']])`);
  const replaceConflict = await until(cdp, `window.__uploadRow('replace.txt')?.classList.contains('conflict')`);
  await cdp.eval(`window.__button(window.__uploadRow('replace.txt'), 'replace')?.click(); true`);
  const confirmation = await until(cdp, `window.__uploadRow('replace.txt')?.classList.contains('replace-confirm')`);
  claim('E3 Replace exposes a separate explicit confirmation', replaceConflict && confirmation && readFileSync(`${DIR}/replace.txt`, 'utf8') === 'before-replace');
  await cdp.eval(`window.__button(window.__uploadRow('replace.txt'), 'replace file')?.click(); true`);
  const replaced = await until(cdp, `window.__uploadRow('replace.txt')?.classList.contains('complete')`);
  claim('E4 confirmed Replace atomically updates only the intended existing file', replaced && readFileSync(`${DIR}/replace.txt`, 'utf8') === 'replacement payload');

  // D/E: a text drop never arms the upload surface, and an archive name is
  // rejected by the same picker queue without a destination file.
  const textDrop = await cdp.eval(`(() => {
    const zone = window.__files()?.querySelector('.upload-zone');
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'not a file');
    zone?.dispatchEvent(new DragEvent('dragenter', { bubbles: true, composed: true, dataTransfer: transfer }));
    return window.__files()?.querySelector('.upload-overlay') === null;
  })()`);
  await cdp.eval(`window.__pick('not-an-archive.zip', 'PK\\u0003\\u0004fixture')`);
  const archiveRejected = await until(cdp, `window.__uploadRow('not-an-archive.zip')?.classList.contains('failed')`);
  claim('D1 text/URL-style drops do not become uploads', textDrop);
  claim('D2 archives are rejected without a destination file', archiveRejected && !existsSync(`${DIR}/not-an-archive.zip`));

  // D/E: Listing a symlink that resolves outside the configured root gets an
  // explicit unavailable answer. This is the actual same-origin route the
  // applet uses; the diagnostic intentionally contains no filesystem path.
  const outsideState = JSON.parse(await cdp.eval(`fetch('/api/files?path=' + encodeURIComponent(${JSON.stringify(`${DIR}/outside-link`)})).then((r) => r.text())`));
  claim(
    'D3 symlink traversal outside the configured root is unavailable',
    outsideState.upload?.available === false && /configured Explorer root/i.test(outsideState.upload?.reason ?? ''),
    JSON.stringify({ available: outsideState.upload?.available, reason: outsideState.upload?.reason }),
  );

  // The fixture stays only long enough for the caller to inspect a failure.
  // A passing run removes it in the finally block below.
  const failed = claims.filter((entry) => !entry.ok);
  console.log(`\\n${claims.length - failed.length}/${claims.length} claims held`);
  if (failed.length > 0) process.exitCode = 1;
}

let cdp;

main()
  .catch((error) => {
    console.error(`error: ${error.stack ?? error.message}`);
    process.exitCode = 2;
  })
  .finally(() => {
    // Never leave user-visible fixture data behind. The only retained evidence
    // is this script's PASS/FAIL output, which contains no files or paths.
    rmSync(DIR, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    cdp?.close();
  });