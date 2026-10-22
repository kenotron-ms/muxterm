import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseURL = process.env.STORYBOOK_URL || 'http://127.0.0.1:6006';
const outputDir = process.env.STORYBOOK_REVIEW_DIR || new URL('../storybook-static/review-screenshots/', import.meta.url).pathname;
const chromePath = process.env.CHROME_PATH;
const captures = [
  { file: 'theme-lab-desktop.png', id: 'foundations-theme-lab--custom-palette', width: 1200, height: 800, ready: 'mux-ui-page-intro', readyText: 'Project workspace' },
  { file: 'tokens-layer-order.png', id: 'foundations-tokens--semantic-scale', width: 1200, height: 900, ready: 'section', readyText: 'Layer order' },
  { file: 'action-tile-phone.png', id: 'primitives-action-tile--phone', width: 390, height: 844, ready: 'mux-ui-action-tile' },
  { file: 'breadcrumb-phone.png', id: 'primitives-breadcrumb--phone-path', width: 390, height: 844, ready: 'mux-ui-breadcrumb' },
  { file: 'navigation-status-desktop.png', id: 'primitives-navigation-item--descriptions-and-status', width: 1200, height: 800, ready: 'mux-ui-nav-item' },
  { file: 'status-badges-desktop.png', id: 'foundations-status-badge--all-states', width: 1200, height: 800, ready: 'mux-ui-status-badge' },
  { file: 'command-search-phone.png', id: 'primitives-command-search--phone-results', width: 390, height: 844, ready: 'mux-ui-command-search' },
  { file: 'choice-picker-phone.png', id: 'components-choice-picker--phone-sheet', width: 390, height: 844, ready: 'mux-ui-choice-picker[open]', readyText: 'GPT-6-Astra' },
  { file: 'choice-picker-pending-summary.png', id: 'components-choice-picker--pending-summary', width: 900, height: 400, ready: 'mux-ui-choice-picker', readyText: 'Choose an option' },
  { file: 'action-menu-phone.png', id: 'components-action-menu--phone-sheet', width: 390, height: 844, ready: 'mux-ui-menu' },
  { file: 'menu-item-desktop.png', id: 'components-menu-item--actions', width: 1200, height: 800, ready: 'mux-ui-menu-item', readyText: 'Remove project' },
  { file: 'chat-project-actions-phone.png', id: 'composites-chat-list--phone-project-actions', width: 390, height: 844, ready: 'mux-ui-menu-item', readyText: 'Remove project' },
  { file: 'chat-project-error-desktop.png', id: 'composites-chat-list--project-action-error', width: 1200, height: 800, ready: 'mux-ui-feedback[kind="error"]', readyText: 'Could not update this project. Try again.' },
  { file: 'chat-project-error-phone.png', id: 'composites-chat-list--phone-project-action-error', width: 390, height: 844, ready: 'mux-ui-feedback[kind="error"]', readyText: 'Could not update this project. Try again.' },
  { file: 'chat-project-editor-error-phone.png', id: 'composites-chat-list--phone-edit-project-error', width: 390, height: 844, ready: 'mux-ui-dialog[open] mux-ui-feedback[kind="error"]', readyText: 'Could not update this project. Try again.' },
  { file: 'chat-pinned-error-phone.png', id: 'composites-chat-list--phone-pinned-action-error', width: 390, height: 844, ready: 'mux-ui-feedback[kind="error"]', readyText: 'Could not unpin Atlas: Could not update this project. Try again.' },
  { file: 'utility-file-actions-desktop.png', id: 'screens-utility--file-open-actions', width: 1200, height: 800, ready: 'mux-ui-menu-item', readyText: 'Download file' },
  { file: 'utility-file-actions-phone.png', id: 'screens-utility--phone-file-open-actions', width: 390, height: 844, ready: 'mux-ui-menu-item', readyText: 'Download file' },
  { file: 'listbox-phone.png', id: 'components-listbox--phone-sheet', width: 390, height: 844, ready: 'mux-ui-listbox' },
  { file: 'title-bar-phone.png', id: 'composites-title-bar--mobile-workspace', width: 390, height: 844, ready: 'mux-title-bar' },
  { file: 'microphone-error-desktop.png', id: 'composites-microphone-button--error-toast', width: 1200, height: 800, ready: 'mux-mic-button' },
  { file: 'reconnect-desktop.png', id: 'patterns-reconnect-overlay--fatal', width: 1200, height: 800, ready: 'mux-reconnect-overlay .overlay' },
  { file: 'new-chat-desktop.png', id: 'screens-new-chat--ungrouped', width: 1200, height: 800, ready: 'mux-new-chat' },
  { file: 'chat-desktop.png', id: 'screens-chat--conversation', width: 1200, height: 800, ready: 'mux-sdk-chat' },
  { file: 'jobs-desktop.png', id: 'screens-scheduled-jobs--statuses', width: 1200, height: 800, ready: 'mux-scheduled-jobs' },
  { file: 'skills-desktop.png', id: 'screens-skills--installed', width: 1200, height: 800, ready: 'mux-skills' },
  { file: 'connections-google-desktop.png', id: 'screens-connections--google-tool-selection', width: 1200, height: 800, ready: 'mux-connections', readyText: 'Choose a Google service' },
  { file: 'connections-microsoft-phone.png', id: 'screens-connections--phone-microsoft-ready', width: 390, height: 844, ready: 'mux-connections', readyText: 'Personal Microsoft account' },
  { file: 'settings-appearance-phone.png', id: 'screens-settings--phone-appearance', width: 390, height: 844, ready: 'mux-settings-surface', readyText: 'Appearance' },
  { file: 'project-editor-phone.png', id: 'composites-chat-list--phone-edit-project', width: 390, height: 844, ready: 'mux-ui-dialog[open]' },
  { file: 'operator-lane-phone.png', id: 'composites-operator-status--phone-expanded-lane', width: 390, height: 844, ready: 'mux-operator-status .detail' },
  { file: 'pane-picker-phone.png', id: 'composites-mobile-pane-picker--many-panes', width: 390, height: 844, ready: 'mux-pane-picker .sheet:popover-open' },
  { file: 'page-chart-bar-desktop.png', id: 'composites-page-visualization--bar', width: 1000, height: 700, ready: 'mux-blocknote-page .page-widget', readyText: 'Requests handled' },
  { file: 'page-chart-line-desktop.png', id: 'composites-page-visualization--line', width: 1000, height: 700, ready: 'mux-blocknote-page .page-widget', readyText: 'Requests handled' },
  { file: 'page-chart-dark-document.png', id: 'composites-page-visualization--dark-document', width: 1000, height: 700, ready: 'mux-blocknote-page .page-widget', readyText: 'Requests handled' },
  { file: 'page-chart-phone.png', id: 'composites-page-visualization--phone', width: 390, height: 844, ready: 'mux-blocknote-page .page-widget', readyText: 'Requests handled' },
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
      if (capture.readyText) await page.getByText(capture.readyText, { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
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
await writeFile(join(outputDir, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Muxterm Storybook review screenshots</title><style>body{font:16px/1.5 system-ui;margin:3rem;max-width:55rem}li{margin:.5rem 0}</style><h1>Muxterm Storybook review screenshots</h1><p>Captured from this artifact's Storybook build in Chromium. Screens are fixture states; live session behavior is described in the pull request.</p><ul>${links}</ul></html>\n`);
