import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseURL = process.env.STORYBOOK_URL || 'http://127.0.0.1:6006';
const outputDir = process.env.STORYBOOK_REVIEW_DIR || new URL('../storybook-static/review-screenshots/', import.meta.url).pathname;
const chromePath = process.env.CHROME_PATH;
const captures = [
  { file: 'theme-lab-desktop.png', id: 'foundations-theme-lab--custom-palette', width: 1200, height: 800, ready: 'mux-ui-page-intro' },
  { file: 'connections-google-desktop.png', id: 'screens-connections--google-tool-selection', width: 1200, height: 800, ready: 'mux-connections' },
  { file: 'connections-microsoft-phone.png', id: 'screens-connections--phone-microsoft-ready', width: 390, height: 844, ready: 'mux-connections' },
  { file: 'settings-appearance-phone.png', id: 'screens-settings--phone-appearance', width: 390, height: 844, ready: 'mux-settings-surface' },
  { file: 'project-editor-phone.png', id: 'composites-chat-list--phone-edit-project', width: 390, height: 844, ready: 'mux-ui-dialog' },
  { file: 'operator-lane-phone.png', id: 'composites-operator-status--phone-expanded-lane', width: 390, height: 844, ready: 'mux-operator-status .detail' },
  { file: 'pane-picker-phone.png', id: 'composites-mobile-pane-picker--many-panes', width: 390, height: 844, ready: 'mux-pane-picker' },
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
try {
  for (const capture of captures) {
    const page = await browser.newPage({ viewport: { width: capture.width, height: capture.height }, deviceScaleFactor: 1 });
    try {
      const url = `${baseURL}/iframe.html?id=${capture.id}&viewMode=story`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator(capture.ready).first().waitFor({ state: 'visible', timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(outputDir, capture.file), fullPage: true });
      console.log(`${capture.file}: ${url}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

const links = captures.map(capture => `<li><a href="${capture.file}">${capture.file}</a> — <a href="../iframe.html?id=${capture.id}&amp;viewMode=story">open story</a></li>`).join('\n');
await writeFile(join(outputDir, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Muxterm Storybook review screenshots</title><style>body{font:16px/1.5 system-ui;margin:3rem;max-width:55rem}li{margin:.5rem 0}</style><h1>Muxterm Storybook review screenshots</h1><p>Captured from this artifact's Storybook build in Chromium. Screens are fixture states; live sessiond behavior is described in the pull request.</p><ul>${links}</ul></html>\n`);
