#!/usr/bin/env node

// Capture the real browser and installed WCO PWA against the isolated dev-local
// server. A dedicated Chrome profile keeps installation away from daily use.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const url = 'http://127.0.0.1:8313/';
const out = process.argv[2];
const chatId = process.argv[3];
if (!out || !path.resolve(out).startsWith('/home/ken/artifacts/')) {
  console.error('Usage: node web/scripts/capture-window-modes.mjs /home/ken/artifacts/<task-directory> [chat-id]');
  process.exit(2);
}
if (chatId && !/^[0-9a-f]{32}$/.test(chatId)) {
  console.error('chat-id must be a 32-character hexadecimal ID from a fresh dev-local chat');
  process.exit(2);
}
const pageUrl = chatId ? `${url}#chat=${chatId}` : url;

await mkdir(out, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(out, 'chrome-profile'), {
  channel: 'chrome',
  headless: false,
  viewport: null,
  args: [
    '--window-size=1485,900',
    '--enable-devtools-pwa-handler',
    '--enable-features=DesktopPWAsWindowControlsOverlayWithNoToggle',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const describe = (page) => page.evaluate(() => {
  const findDeep = (root, selector) => {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const element of root.querySelectorAll('*')) {
      if (!element.shadowRoot) continue;
      const nested = findDeep(element.shadowRoot, selector);
      if (nested) return nested;
    }
    return null;
  };
  const app = document.querySelector('mux-app');
  const header = findDeep(document, 'mux-ui-screen-header');
  const row = header?.shadowRoot?.querySelector('header');
  const strip = findDeep(document, 'mux-ui-tab-strip');
  const selectedTab = strip?.shadowRoot?.querySelector('.tab.active');
  const tabButton = selectedTab?.querySelector('.select');
  const closeButton = selectedTab?.querySelector('.close');
  const gutter = app?.shadowRoot?.querySelector('.sidebar-gutter');
  const overlay = navigator.windowControlsOverlay;
  return {
    viewportWidth: window.innerWidth,
    outerWidth: window.outerWidth,
    displayMode: ['browser', 'standalone', 'window-controls-overlay']
      .find((mode) => matchMedia(`(display-mode: ${mode})`).matches) ?? 'unknown',
    overlayVisible: overlay?.visible ?? false,
    titlebarArea: overlay?.getTitlebarAreaRect().toJSON() ?? null,
    headerHeight: row?.getBoundingClientRect().height ?? null,
    headerPadding: row ? getComputedStyle(row).padding : null,
    gutterHeaderRuleHeight: gutter ? getComputedStyle(gutter, '::after').height : null,
    tabStripHeight: strip?.getBoundingClientRect().height ?? null,
    tabStripPadding: strip ? getComputedStyle(strip).padding : null,
    tabFontSize: tabButton ? getComputedStyle(tabButton).fontSize : null,
    tabBackground: selectedTab ? getComputedStyle(selectedTab).backgroundColor : null,
    closeBackground: closeButton ? getComputedStyle(closeButton).backgroundColor : null,
  };
});

const openChatTools = async (page) => {
  if (!chatId) return;
  const open = page.getByRole('button', { name: 'Open utility pane' });
  if (await open.isVisible()) await open.click();
  await page.getByRole('tab', { name: 'Files' }).waitFor();
};

const verifyLayout = (state, mode) => {
  if (state.headerHeight !== 44 || state.gutterHeaderRuleHeight !== '44px') {
    throw new Error(`${mode}: title row or sidebar rule differs from 44px`);
  }
  if (chatId && (state.tabStripHeight !== 44 || state.tabFontSize !== '12px'
    || state.tabBackground !== 'rgba(0, 0, 0, 0)'
    || state.closeBackground !== 'rgba(0, 0, 0, 0)')) {
    throw new Error(`${mode}: utility tab height, type, or fill differs from the reviewed design`);
  }
};

try {
  const web = context.pages()[0] ?? await context.newPage();
  await web.goto(pageUrl);
  await web.locator('mux-app').waitFor();
  await openChatTools(web);
  const webState = await describe(web);
  if (webState.displayMode !== 'browser') throw new Error(`Expected browser mode; got ${webState.displayMode}`);
  verifyLayout(webState, 'web');
  if (webState.headerPadding !== '0px 12px 0px 16px') {
    throw new Error(`web: unexpected breadcrumb or control padding: ${webState.headerPadding}`);
  }
  await web.screenshot({ path: path.join(out, 'web.png') });

  const client = await context.newCDPSession(web);
  await client.send('PWA.install', { manifestId: url });
  await client.send('PWA.changeAppUserSettings', { manifestId: url, displayMode: 'standalone' });
  const appPagePromise = context.waitForEvent('page', { timeout: 15000 });
  await client.send('PWA.launch', { manifestId: url, url: pageUrl });
  const pwa = await appPagePromise;
  const pwaClient = await context.newCDPSession(pwa);
  const { windowId } = await pwaClient.send('Browser.getWindowForTarget');
  await pwaClient.send('Browser.setWindowBounds', {
    windowId, bounds: { width: 1485, height: 900 },
  });
  await pwa.locator('mux-app').waitFor();
  await pwa.waitForFunction(() => matchMedia('(display-mode: window-controls-overlay)').matches);
  await pwa.waitForTimeout(300);
  await openChatTools(pwa);
  const pwaState = await describe(pwa);
  if (!pwaState.overlayVisible) throw new Error('Installed PWA did not show window controls overlay');
  verifyLayout(pwaState, 'WCO PWA');
  if (chatId && Number.parseFloat(pwaState.tabStripPadding.split(' ')[1]) <= 8) {
    throw new Error('WCO PWA: utility tabs did not reserve window control space');
  }
  await pwa.screenshot({ path: path.join(out, 'wco-pwa.png') });

  const summary = { url: pageUrl, web: webState, pwa: pwaState };
  await writeFile(path.join(out, 'layout.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await context.close();
}
