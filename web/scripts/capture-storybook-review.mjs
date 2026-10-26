import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseURL = process.env.STORYBOOK_URL || 'http://127.0.0.1:6006';
const outputDir = process.env.STORYBOOK_REVIEW_DIR || new URL('../storybook-static/review-screenshots/', import.meta.url).pathname;
const chromePath = process.env.CHROME_PATH;
const captures = [
  { file: 'theme-lab-desktop.png', id: 'foundations-theme-lab--custom-palette', width: 1200, height: 800, ready: 'mux-ui-page-intro', readyText: 'Project workspace' },
  { file: 'tokens-layer-order.png', id: 'foundations-tokens--semantic-scale', width: 1200, height: 900, ready: 'section', readyText: 'Layer order' },
  { file: 'screen-header-desktop.png', id: 'patterns-screen-header--standard', width: 1200, height: 600, ready: 'mux-ui-screen-header', readyText: 'Skills' },
  { file: 'screen-header-workspace.png', id: 'patterns-screen-header--with-workspace', width: 1200, height: 600, ready: 'mux-ui-screen-header', readyText: 'New chat' },
  { file: 'screen-header-actions-desktop.png', id: 'patterns-screen-header--action-toolbar', width: 1200, height: 600, ready: 'mux-ui-screen-header[with-actions]' },
  { file: 'screen-header-actions-phone.png', id: 'patterns-screen-header--phone-action-toolbar', width: 390, height: 844, ready: 'mux-ui-screen-header[with-actions]' },
  { file: 'screen-header-actions-light.png', id: 'patterns-screen-header--light-action-toolbar', width: 1200, height: 600, ready: 'mux-ui-screen-header[with-actions]' },
  { file: 'screen-header-actions-long.png', id: 'patterns-screen-header--long-action-toolbar', width: 900, height: 600, ready: 'mux-ui-screen-header[with-actions]' },
  { file: 'screen-header-long-labels.png', id: 'patterns-screen-header--long-labels', width: 900, height: 600, ready: 'mux-ui-screen-header', readyText: 'Scheduled jobs' },
  { file: 'action-tile-phone.png', id: 'primitives-action-tile--phone', width: 390, height: 844, ready: 'mux-ui-action-tile' },
  { file: 'breadcrumb-phone.png', id: 'primitives-breadcrumb--phone-path', width: 390, height: 844, ready: 'mux-ui-breadcrumb' },
  { file: 'navigation-status-desktop.png', id: 'primitives-navigation-item--descriptions-and-status', width: 1200, height: 800, ready: 'mux-ui-nav-item' },
  { file: 'navigation-danger-desktop.png', id: 'primitives-navigation-item--danger-status', width: 1200, height: 600, ready: 'mux-ui-nav-item[status-tone="danger"]' },
  { file: 'attachment-ready-desktop.png', id: 'components-attachment--ready', width: 1200, height: 600, ready: 'mux-ui-attachment[state="ready"]' },
  { file: 'attachment-failed-desktop.png', id: 'components-attachment--failed', width: 1200, height: 600, ready: 'mux-ui-attachment[state="error"]' },
  { file: 'attachment-image-desktop.png', id: 'components-attachment--image-preview', width: 1200, height: 600, ready: 'mux-ui-attachment[preview-url]' },
  { file: 'attachment-phone.png', id: 'components-attachment--phone', width: 390, height: 844, ready: 'mux-ui-attachment' },
  { file: 'status-badges-desktop.png', id: 'foundations-status-badge--all-states', width: 1200, height: 800, ready: 'mux-ui-status-badge' },
  { file: 'status-inline-desktop.png', id: 'foundations-status-badge--inline-states', width: 1200, height: 600, ready: 'mux-ui-status-badge[appearance="plain"]' },
  { file: 'status-inline-phone.png', id: 'foundations-status-badge--phone-inline-states', width: 390, height: 844, ready: 'mux-ui-status-badge[appearance="plain"]' },
  { file: 'status-inline-light.png', id: 'foundations-status-badge--light-inline-states', width: 1200, height: 600, ready: 'mux-ui-status-badge[appearance="plain"]' },
  { file: 'voice-bars-resting.png', id: 'components-voice-bars--resting', width: 1200, height: 600, ready: 'mux-ui-voice-bars' },
  { file: 'voice-bars-speaking.png', id: 'components-voice-bars--speaking', width: 1200, height: 600, ready: 'mux-ui-voice-bars' },
  { file: 'shell-feedback-desktop.png', id: 'patterns-feedback--inline-shell-error', width: 1200, height: 600, ready: 'mux-ui-feedback[layout="inline"]' },
  { file: 'shell-feedback-phone.png', id: 'patterns-feedback--phone-inline-shell-error', width: 390, height: 844, ready: 'mux-ui-feedback[layout="inline"]' },
  { file: 'shell-feedback-long-desktop.png', id: 'patterns-feedback--long-inline-shell-error', width: 1200, height: 600, ready: 'mux-ui-feedback[layout="inline"]' },
  { file: 'button-links-desktop.png', id: 'foundations-actions-button--navigation-links', width: 1200, height: 600, ready: 'mux-ui-button[href]' },
  { file: 'button-links-phone.png', id: 'foundations-actions-button--phone-navigation-links', width: 390, height: 844, ready: 'mux-ui-button[href]' },
  { file: 'command-search-phone.png', id: 'primitives-command-search--phone-results', width: 390, height: 844, ready: 'mux-ui-command-search' },
  { file: 'choice-picker-phone.png', id: 'components-choice-picker--phone-sheet', width: 390, height: 844, ready: 'mux-ui-choice-picker[open]', readyText: 'GPT-6-Astra' },
  { file: 'choice-picker-beside-buttons.png', id: 'components-choice-picker--beside-buttons', width: 900, height: 400, ready: 'mux-ui-choice-picker', readyText: 'Choose project' },
  { file: 'choice-picker-pending-summary.png', id: 'components-choice-picker--pending-summary', width: 900, height: 400, ready: 'mux-ui-choice-picker', readyText: 'Choose an option' },
  { file: 'action-menu-phone.png', id: 'components-action-menu--phone-sheet', width: 390, height: 844, ready: 'mux-ui-menu' },
  { file: 'menu-item-desktop.png', id: 'components-menu-item--actions', width: 1200, height: 800, ready: 'mux-ui-menu-item', readyText: 'Remove project' },
  { file: 'chat-project-actions-phone.png', id: 'composites-chat-list--phone-project-actions', width: 390, height: 844, ready: 'mux-ui-menu-item', readyText: 'Remove project' },
  { file: 'chat-operator-lane-status-desktop.png', id: 'composites-chat-list--operator-and-lane-status', width: 1200, height: 800, ready: 'mux-chat-list .status.operator' },
  { file: 'chat-operator-lane-status-phone.png', id: 'composites-chat-list--phone-operator-and-lane-status', width: 390, height: 844, ready: 'mux-chat-list .status.operator' },
  { file: 'chat-project-error-desktop.png', id: 'composites-chat-list--project-action-error', width: 1200, height: 800, ready: 'mux-ui-feedback[kind="error"]', readyText: 'Could not update this project. Try again.' },
  { file: 'chat-project-error-phone.png', id: 'composites-chat-list--phone-project-action-error', width: 390, height: 844, ready: 'mux-ui-feedback[kind="error"]', readyText: 'Could not update this project. Try again.' },
  { file: 'chat-project-editor-error-phone.png', id: 'composites-chat-list--phone-edit-project-error', width: 390, height: 844, ready: 'mux-ui-dialog[open] mux-ui-feedback[kind="error"]', readyText: 'Could not update this project. Try again.' },
  { file: 'chat-pinned-error-phone.png', id: 'composites-chat-list--phone-pinned-action-error', width: 390, height: 844, ready: 'mux-ui-feedback[kind="error"]', readyText: 'Could not unpin Atlas: Could not update this project. Try again.' },
  { file: 'utility-file-actions-desktop.png', id: 'screens-utility--file-open-actions', width: 1200, height: 800, ready: 'mux-ui-menu-item', readyText: 'Download file' },
  { file: 'utility-file-actions-phone.png', id: 'screens-utility--phone-file-open-actions', width: 390, height: 844, ready: 'mux-ui-menu-item', readyText: 'Download file' },
  { file: 'utility-pages-desktop.png', id: 'screens-utility--pages', width: 1200, height: 800, ready: 'mux-sdk-utility .page-title' },
  { file: 'utility-pages-phone.png', id: 'screens-utility--phone-pages', width: 390, height: 844, ready: 'mux-sdk-utility .page-title' },
  { file: 'listbox-phone.png', id: 'components-listbox--phone-sheet', width: 390, height: 844, ready: 'mux-ui-listbox' },
  { file: 'title-bar-phone.png', id: 'composites-title-bar--mobile-workspace', width: 390, height: 844, ready: 'mux-title-bar' },
  { file: 'dock-attention-session-desktop.png', id: 'composites-terminal-dock--attention-and-session', width: 1200, height: 700, ready: '.mux-bell-prefix' },
  { file: 'dock-title-change-desktop.png', id: 'composites-terminal-dock--title-change-keeps-status', width: 1200, height: 700, ready: '.dv-tab', readyText: 'Renamed shell' },
  { file: 'microphone-error-desktop.png', id: 'composites-microphone-button--error-toast', width: 1200, height: 800, ready: 'mux-mic-button' },
  { file: 'reconnect-desktop.png', id: 'patterns-reconnect-overlay--fatal', width: 1200, height: 800, ready: 'mux-reconnect-overlay .overlay' },
  { file: 'new-chat-desktop.png', id: 'screens-new-chat--chat', width: 1200, height: 800, ready: 'mux-new-chat' },
  { file: 'new-chat-folder-desktop.png', id: 'screens-new-chat--folder', width: 1200, height: 800, ready: 'mux-new-chat', readyText: 'What would you like to do?' },
  { file: 'new-chat-folder-phone.png', id: 'screens-new-chat--phone-worktree', width: 390, height: 844, ready: 'mux-new-chat', readyText: 'What would you like to do?' },
  { file: 'new-chat-attachment-desktop.png', id: 'screens-new-chat--attachment-ready', width: 1200, height: 800, ready: 'mux-new-chat mux-ui-attachment[state="ready"]' },
  { file: 'new-chat-attachment-phone.png', id: 'screens-new-chat--phone-attachment', width: 390, height: 844, ready: 'mux-new-chat mux-ui-attachment[state="ready"]' },
  { file: 'new-chat-attachment-error.png', id: 'screens-new-chat--attachment-upload-failed', width: 1200, height: 800, ready: 'mux-new-chat mux-ui-attachment[state="error"]' },
  { file: 'chat-desktop.png', id: 'screens-chat--conversation', width: 1200, height: 800, ready: 'mux-sdk-chat' },
  { file: 'chat-scroll-bottom.png', id: 'screens-chat--scroll-to-bottom', width: 1200, height: 700, ready: 'mux-ui-button.scroll-bottom' },
  { file: 'chat-recovery-desktop.png', id: 'screens-chat--recovery-required', width: 1200, height: 800, ready: 'mux-ui-feedback.recovery' },
  { file: 'chat-recovery-phone.png', id: 'screens-chat--phone-recovery-required', width: 390, height: 844, ready: 'mux-ui-feedback.recovery' },
  { file: 'chat-recovery-light.png', id: 'screens-chat--light-recovery-required', width: 1200, height: 800, ready: 'mux-ui-feedback.recovery' },
  { file: 'chat-attachment-desktop.png', id: 'screens-chat--file-attached', width: 1200, height: 800, ready: 'mux-sdk-chat mux-ui-attachment[state="ready"]' },
  { file: 'chat-attachment-phone.png', id: 'screens-chat--phone-file-attached', width: 390, height: 844, ready: 'mux-sdk-chat mux-ui-attachment[state="ready"]' },
  { file: 'chat-attachment-error.png', id: 'screens-chat--file-upload-failed', width: 1200, height: 800, ready: 'mux-sdk-chat mux-ui-attachment[state="error"]' },
  { file: 'chat-header-phone.png', id: 'screens-chat--embedded-phone-chat', width: 390, height: 844, ready: 'mux-ui-screen-header[with-actions]' },
  { file: 'chat-header-agent-desktop.png', id: 'screens-chat--delegated-work-open', width: 1200, height: 800, ready: 'mux-ui-screen-header[with-actions] mux-ui-breadcrumb[slot="heading"]' },
  { file: 'chat-linked-report-desktop.png', id: 'screens-chat--linked-reports', width: 1200, height: 800, ready: 'mux-ui-status-badge[appearance="plain"]', readyText: 'Ready' },
  { file: 'chat-linked-report-phone.png', id: 'screens-chat--phone-linked-reports', width: 390, height: 844, ready: 'mux-ui-status-badge[appearance="plain"]', readyText: 'Ready' },
  { file: 'chat-linked-report-failed-desktop.png', id: 'screens-chat--failed-linked-report', width: 1200, height: 800, ready: 'mux-ui-status-badge[appearance="plain"]', readyText: 'Failed' },
  { file: 'jobs-desktop.png', id: 'screens-scheduled-jobs--statuses', width: 1200, height: 800, ready: 'mux-scheduled-jobs' },
  { file: 'jobs-phone.png', id: 'screens-scheduled-jobs--phone-statuses', width: 390, height: 844, ready: 'mux-scheduled-jobs' },
  { file: 'skills-desktop.png', id: 'screens-skills--installed', width: 1200, height: 800, ready: 'mux-skills' },
  { file: 'skills-phone.png', id: 'screens-skills--phone-installed', width: 390, height: 844, ready: 'mux-skills' },
  { file: 'connections-google-desktop.png', id: 'screens-connections--google-tool-selection', width: 1200, height: 800, ready: 'mux-connections', readyText: 'Choose a Google service' },
  { file: 'connections-google-pending-desktop.png', id: 'screens-connections--google-sign-in-pending', width: 1200, height: 800, ready: 'mux-ui-nav-item[status-tone="info"]', readyText: 'Sign-in in progress' },
  { file: 'connections-google-pending-phone.png', id: 'screens-connections--phone-google-sign-in-pending', width: 390, height: 844, ready: 'mux-ui-nav-item[status-tone="info"]', readyText: 'Sign-in in progress' },
  { file: 'connections-google-finish-setup-desktop.png', id: 'screens-connections--google-finish-setup', width: 1200, height: 800, ready: 'mux-ui-nav-item[status-tone="info"]' },
  { file: 'connections-google-choose-tools-desktop.png', id: 'screens-connections--google-choose-tools', width: 1200, height: 800, ready: 'mux-ui-nav-item[status-tone="info"]', readyText: 'Choose tools' },
  { file: 'connections-google-guide-desktop.png', id: 'screens-connections--google-manual-entry', width: 1200, height: 800, ready: 'mux-ui-button[href]' },
  { file: 'connections-github-sign-in-desktop.png', id: 'screens-connections--git-hub-device-code', width: 1200, height: 800, ready: 'mux-ui-button[href]' },
  { file: 'connections-microsoft-sign-in-phone.png', id: 'screens-connections--phone-microsoft-pending', width: 390, height: 844, ready: 'mux-ui-button[href]' },
  { file: 'connections-microsoft-phone.png', id: 'screens-connections--phone-microsoft-ready', width: 390, height: 844, ready: 'mux-connections', readyText: 'Personal Microsoft account' },
  { file: 'settings-appearance-phone.png', id: 'screens-settings--phone-appearance', width: 390, height: 844, ready: 'mux-settings-surface', readyText: 'Appearance' },
  { file: 'settings-notifications-enabled-desktop.png', id: 'screens-settings--notifications-enabled', width: 1200, height: 800, ready: 'mux-ui-status-badge[tone="success"]', readyText: 'Enabled' },
  { file: 'settings-notifications-blocked-phone.png', id: 'screens-settings--phone-notifications-blocked', width: 390, height: 844, ready: 'mux-ui-feedback[kind="warning"]', readyText: 'Check again' },
  { file: 'settings-remotes-error-desktop.png', id: 'screens-settings--remotes-load-error', width: 1200, height: 800, ready: 'mux-ui-feedback[kind="error"]', readyText: 'Retry' },
  { file: 'settings-remotes-error-phone.png', id: 'screens-settings--phone-remotes-load-error', width: 390, height: 844, ready: 'mux-ui-feedback[kind="error"]', readyText: 'Retry' },
  { file: 'settings-add-host-error-phone.png', id: 'screens-settings--phone-remotes-add-error', width: 390, height: 844, ready: 'mux-ui-feedback[kind="error"]', readyText: 'That host address could not be added.' },
  { file: 'settings-ai-error-desktop.png', id: 'screens-settings--ai-connection-error', width: 1200, height: 800, ready: 'mux-ui-feedback[kind="error"]', readyText: 'Could not reach Anthropic. Check your connection.' },
  { file: 'settings-version-error-desktop.png', id: 'screens-settings--about-check-error', width: 1200, height: 800, ready: 'mux-ui-feedback[kind="error"]', readyText: 'Could not check the version. Try again.' },
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
    const page = await browser.newPage({ viewport: { width: capture.width, height: capture.height }, deviceScaleFactor: 1, hasTouch: capture.width <= 430 });
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
