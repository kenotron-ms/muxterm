#!/usr/bin/env node
/*
 * VISUAL_FIXTURE_ONLY browser driver for the app-wide voice controls.
 *
 * This is deliberately not an audio/WebRTC test. It connects to a prepared
 * real muxterm server/sessiond, but it never clicks a voice enable/stop/mute
 * control and never installs fake media, a provider, or a controller/store
 * override. The active rendering fixture is permitted only through public Lit
 * `snapshot` properties on the shared voice components.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const usage = `Usage:
  node test/missioncontrol-e2e/voice-ui.mjs \\
    --base-url <URL> --muxterm-bin <path> --output <private directory> \\
    --source-sha <tested source archive SHA-256> --playwright-module <module-or-path> \\
    [--candidate-manifest <controlled JSON>] [--headed]

VISUAL_FIXTURE_ONLY. A prepared, already-running muxterm server and sessiond
are required. This driver creates two harmless workspaces through the supplied
candidate CLI, launches a browser, and never starts or stops a product process.
It never requests microphone access and never starts app voice.`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!argument.startsWith('--')) throw new Error('unexpected_argument');
    const name = argument.slice(2);
    if (name === 'headed') {
      options.headed = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('missing_argument_value');
    options[name] = value;
  }
  return options;
}

function isOutside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`);
}

function safeError(error) {
  const message = String(error?.message ?? '')
    .replace(/[^a-zA-Z0-9_ .:/()[\]-]/g, '')
    .slice(0, 180);
  return {
    type: error?.name || 'Error',
    detail: message || 'unspecified_error',
  };
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256FileFromCli(file) {
  const output = execFileSync('sha256sum', [file], { encoding: 'utf8' }).trim();
  const digest = output.split(/\s+/, 1)[0]?.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest ?? '')) throw new Error('sha256sum_output_invalid');
  return digest;
}

function validSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function parseCandidateManifest(file) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('candidate_manifest_unreadable_json');
  }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
    throw new Error('candidate_manifest_shape_invalid');
  }
  for (const field of ['archive_sha256', 'binary_sha256', 'asset_sha256']) {
    if (!validSha256(manifest[field])) throw new Error(`candidate_manifest_${field}_invalid`);
  }
  if (typeof manifest.asset_path !== 'string') throw new Error('candidate_manifest_asset_path_invalid');
  const assetPath = manifest.asset_path;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(assetPath);
  } catch {
    throw new Error('candidate_manifest_asset_path_invalid');
  }
  if (
    !assetPath.startsWith('/assets/') ||
    /[\\?#]/.test(assetPath) ||
    decodedPath.slice('/assets/'.length).split('/').some((part) => part === '.' || part === '..' || part === '')
  ) {
    throw new Error('candidate_manifest_asset_path_not_local');
  }
  return {
    archive_sha256: manifest.archive_sha256.toLowerCase(),
    binary_sha256: manifest.binary_sha256.toLowerCase(),
    asset_path: assetPath,
    asset_sha256: manifest.asset_sha256.toLowerCase(),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(callback, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`timeout_${label}_${last ? safeError(last).type : 'none'}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage);
  process.exit(0);
}
for (const name of ['base-url', 'muxterm-bin', 'output', 'source-sha', 'playwright-module']) {
  if (!args[name]) throw new Error(`required_${name}`);
}
if (!validSha256(args['source-sha'])) throw new Error('invalid_source_sha');
if (!fs.existsSync(args['muxterm-bin'])) throw new Error('missing_muxterm_bin');
const candidateManifest = args['candidate-manifest']
  ? parseCandidateManifest(path.resolve(args['candidate-manifest']))
  : null;

const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const output = path.resolve(args.output);
if (!isOutside(repository, output)) throw new Error('output_must_be_outside_repository');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });

const report = {
  format: 'missioncontrol-voice-ui-v2',
  mode: 'VISUAL_FIXTURE_ONLY',
  status: 'FAIL',
  source_sha: args['source-sha'].toLowerCase(),
  limitations: [
    'Visual fixture only; no live app voice session, microphone, RTC, or provider proof.',
    'The visual fixture never invokes voiceSessionController, a store, history, or a product test backdoor.',
    'Physical software-keyboard visualViewport behavior cannot be created by this driver.',
    'SCRIPTED_POINTER_CANCEL is a DOM-event cleanup check, not trusted hardware input.',
  ],
  checks: {},
  screenshots: {},
  errors: [],
};
const pass = (name, evidence = {}) => { report.checks[name] = { status: 'PASS', ...evidence }; };
const fail = (name, evidence = {}) => { report.checks[name] = { status: 'FAIL', ...evidence }; };
const blocked = (name, reason) => {
  if (!report.checks[name]) report.checks[name] = { status: 'BLOCKED', reason };
};

function writeReport() {
  fs.writeFileSync(path.join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
}

function createWorkspace(label) {
  const response = JSON.parse(execFileSync(
    args['muxterm-bin'],
    ['workspace', 'create', label, '--json'],
    { encoding: 'utf8', env: process.env },
  ));
  if (typeof response.workspaceId !== 'string' || response.workspaceId.length === 0) {
    throw new Error('workspace_create_shape_invalid');
  }
  return response.workspaceId;
}

async function componentFixture(snapshot) {
  /*
   * This function is serialized into the page. It walks open shadow roots only
   * to find actual rendered custom elements. It mutates only their documented
   * public presentation property, and mounts a test-owned label under mux-app.
   */
  let banner = document.body.querySelector('[data-voice-visual-fixture-banner]');
  if (!banner) {
    banner = document.createElement('div');
    banner.setAttribute('data-voice-visual-fixture-banner', '');
    banner.textContent = 'PUBLIC SNAPSHOT RENDER ONLY - no live microphone or provider';
    Object.assign(banner.style, {
      position: 'fixed', bottom: '8px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '1601', maxWidth: 'calc(100vw - 24px)', boxSizing: 'border-box',
      textAlign: 'center', padding: '4px 8px', font: '600 11px system-ui',
      color: '#111', background: '#ffd', border: '1px solid #886', borderRadius: '4px',
      pointerEvents: 'none',
    });
    document.body.append(banner);
  }
  const root = document.querySelector('mux-app');
  const findAll = (node, selector, found = []) => {
    if (!(node instanceof Element || node instanceof ShadowRoot || node instanceof Document)) return found;
    if (node instanceof Element && node.matches(selector)) found.push(node);
    for (const child of node.children ?? []) findAll(child, selector, found);
    if (node instanceof Element && node.shadowRoot) findAll(node.shadowRoot, selector, found);
    return found;
  };
  if (!root) return { ready: false, reason: 'mux_app_not_found' };
  const bubbles = findAll(root, 'mux-voice-mode-bubble');
  const buttons = findAll(root, 'mux-voice-mode-button');
  const bubble = bubbles[0];
  if (!bubble || !('snapshot' in bubble)) {
    return {
      ready: false,
      reason: 'public_bubble_snapshot_property_not_exposed',
      bubble_count: bubbles.length,
      button_count: buttons.length,
    };
  }
  bubble.snapshot = snapshot;
  for (const button of buttons) button.snapshot = snapshot;
  await Promise.all([...bubbles, ...buttons].map((element) => element.updateComplete ?? Promise.resolve()));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { ready: true, bubble_count: bubbles.length, button_count: buttons.length };
}

async function main() {
  let browser;
  let page;
  let fixtureReady = false;
  let bubbleHandle;
  const activeSnapshot = {
    state: 'listening', available: true, supported: true, level: 0, muted: false, canMute: true,
    heard: '', spoken: '', error: '',
  };
  const failureShot = async (name) => {
    if (!page) return;
    try {
      const file = path.join(output, `failure-${name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      report.screenshots[`failure-${name}`] = path.basename(file);
    } catch (error) {
      report.errors.push({ stage: `failure_screenshot_${name}`, ...safeError(error) });
    }
  };
  const tryCheck = async (name, callback, options = {}) => {
    try {
      const evidence = await callback();
      pass(name, evidence && typeof evidence === 'object' ? evidence : {});
      return true;
    } catch (error) {
      if (options.blocked) blocked(name, options.blocked);
      else fail(name, { error: safeError(error) });
      await failureShot(name);
      return false;
    }
  };

  try {
    const base = new URL(args['base-url']);
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('base_url_protocol_invalid');
    const require = createRequire(import.meta.url);
    let chromium;
    try {
      ({ chromium } = require(args['playwright-module']));
    } catch (error) {
      throw new Error(`playwright_module_unavailable_${safeError(error).type}`);
    }

    if (!candidateManifest) {
      blocked('source_attribution', 'candidate_manifest_not_supplied');
    } else {
      await tryCheck('source_attribution', async () => {
        if (args['source-sha'].toLowerCase() !== candidateManifest.archive_sha256) {
          throw new Error('source_sha_does_not_match_manifest_archive');
        }
        const binarySha256 = sha256FileFromCli(args['muxterm-bin']);
        if (binarySha256 !== candidateManifest.binary_sha256) {
          throw new Error('candidate_binary_sha256_mismatch');
        }
        const assetURL = new URL(candidateManifest.asset_path, base);
        if (assetURL.origin !== base.origin || assetURL.pathname !== candidateManifest.asset_path) {
          throw new Error('candidate_manifest_asset_url_not_local');
        }
        const response = await fetch(assetURL);
        if (!response.ok) throw new Error(`candidate_asset_fetch_${response.status}`);
        const assetSha256 = hashBytes(Buffer.from(await response.arrayBuffer()));
        if (assetSha256 !== candidateManifest.asset_sha256) {
          throw new Error('candidate_asset_sha256_mismatch');
        }
        return {
          archive_sha256: candidateManifest.archive_sha256,
          binary_sha256: binarySha256,
          asset_path: candidateManifest.asset_path,
          asset_sha256: assetSha256,
        };
      });
    }

    const nonce = randomUUID().slice(0, 8);
    const firstWorkspace = createWorkspace(`voice ui fixture A ${nonce}`);
    const secondWorkspace = createWorkspace(`voice ui fixture B ${nonce}`);
    pass('fresh_harmless_workspaces_created', {
      count: 2,
      workspace_ids_sha256: [hash(firstWorkspace), hash(secondWorkspace)],
    });

    browser = await chromium.launch({
      channel: args['browser-channel'] ?? 'chrome',
      headless: !args.headed,
      args: ['--no-sandbox'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    const sockets = [];
    page.on('websocket', (socket) => sockets.push(socket));
    page.on('pageerror', (error) => report.errors.push({ stage: 'pageerror', ...safeError(error) }));
    await page.goto(base.href, { waitUntil: 'domcontentloaded' });
    await eventually(() => page.locator('mux-app').count(), 'real_mux_app');
    await eventually(() => sockets.length > 0, 'real_sessiond_websocket', 8_000);
    await eventually(() => page.locator('mux-sidebar:visible .ws-card').count(), 'workspace_composition_render', 8_000);
    pass('real_browser_app_and_sessiond_connected', { websocket: 'observed', render: 'workspace_composition' });

    const isMobile = async () => page.evaluate(() => window.innerWidth < 768);
    const openMobileDrawer = async () => {
      const launcher = page.locator('mux-title-bar:visible')
        .getByRole('button', { name: /Open workspaces|Sessions need input\. Open workspaces/i });
      await launcher.waitFor({ state: 'visible', timeout: 8_000 });
      const drawer = page.locator('.drawer:popover-open').first();
      if (!await drawer.isVisible().catch(() => false)) await launcher.click({ timeout: 8_000 });
      await drawer.waitFor({ state: 'visible', timeout: 8_000 });
      const sidebar = drawer.locator('mux-sidebar').first();
      await sidebar.waitFor({ state: 'visible', timeout: 8_000 });
      return sidebar;
    };
    const activeSidebar = async () => {
      if (await isMobile()) return openMobileDrawer();
      const sidebar = page.locator('.content-area > mux-sidebar:visible').first();
      await sidebar.waitFor({ state: 'visible', timeout: 8_000 });
      return sidebar;
    };
    const openWorkspace = async (label) => {
      const sidebar = await activeSidebar();
      const card = sidebar.locator('.ws-card').filter({ hasText: label }).first();
      await card.waitFor({ state: 'visible', timeout: 8_000 });
      await card.click({ timeout: 8_000 });
      if (await isMobile()) {
        await page.locator('.drawer:popover-open').waitFor({ state: 'hidden', timeout: 8_000 });
      } else {
        await eventually(() => card.evaluate((node) => node.classList.contains('active')), 'workspace_active', 8_000);
      }
    };
    const openMissionControl = async () => {
      const sidebar = await activeSidebar();
      const target = sidebar.getByRole('button', { name: /Go to Mission Control|Mission Control, current view/i }).first();
      await target.waitFor({ state: 'visible', timeout: 8_000 });
      const label = await target.getAttribute('aria-label');
      if (!label?.includes('current view')) await target.click();
      if (await isMobile()) {
        await page.locator('.drawer:popover-open').waitFor({ state: 'hidden', timeout: 8_000 });
      }
      await page.locator('mux-cos:visible').waitFor({ state: 'visible', timeout: 8_000 });
      if (await isMobile()) {
        await page.locator('mux-title-bar:visible').getByText('Mission Control', { exact: true })
          .waitFor({ state: 'visible', timeout: 8_000 });
      } else {
        await page.locator('mux-cos:visible').getByRole('heading', { name: 'Mission Control', exact: true })
          .waitFor({ state: 'visible', timeout: 8_000 });
      }
    };
    const applyFixture = async () => {
      const applied = await page.evaluate(componentFixture, activeSnapshot);
      if (!applied.ready) throw new Error(applied.reason);
      return applied;
    };
    const validateView = async (name) => {
      const desktopMissionControl = name === 'desktop-mission-control.png';
      const header = desktopMissionControl
        ? page.locator('mux-cos:visible .topbar').first()
        : page.locator('mux-title-bar:visible').first();
      const voice = header.locator('mux-voice-mode-button').locator('[data-voice-mode-button]');
      const ellipsis = desktopMissionControl
        ? header.getByRole('button', { name: 'Conversation options', exact: true })
        : header.locator('button[title="Open menu"]');
      if (await header.count() !== 1 || await voice.count() !== 1 || await ellipsis.count() !== 1) {
        throw new Error('header_voice_or_ellipsis_count_invalid');
      }
      const [voiceBox, ellipsisBox] = await Promise.all([voice.boundingBox(), ellipsis.boundingBox()]);
      if (!voiceBox || !ellipsisBox || voiceBox.width < 44 || voiceBox.height < 44 || voiceBox.x >= ellipsisBox.x) {
        throw new Error('header_voice_geometry_invalid');
      }
      pass(`view_${name}_header_voice_before_ellipsis_44px`, {
        voice_width: voiceBox.width,
        voice_height: voiceBox.height,
      });
      return { header: desktopMissionControl ? 'mission_control_topbar' : 'titlebar' };
    };
    const capture = async (name, width, height, destination) => {
      try {
        await page.setViewportSize({ width, height });
        await destination();
        await applyFixture();
        await validateView(name);
        await page.screenshot({ path: path.join(output, name), fullPage: false });
        report.screenshots[name] = {
          status: 'PASS',
          active_visual_fixture: fixtureReady,
          viewport: `${width}x${height}`,
        };
      } catch (error) {
        report.screenshots[name] = { status: 'FAIL', error: safeError(error), viewport: `${width}x${height}` };
        await failureShot(`capture-${name.replace('.png', '')}`);
      }
    };

    // A non-target, already-rendered row is the readiness action. It avoids
    // making the first requested candidate navigation a whole-run gate.
    await tryCheck('initial_real_workspace_row_ready', async () => {
      const row = page.locator('mux-sidebar:visible .ws-card').first();
      await row.waitFor({ state: 'visible', timeout: 8_000 });
      await row.click({ timeout: 8_000 });
      return { source: 'visible_mux_sidebar_workspace_row' };
    });
    const fixture = await page.evaluate(componentFixture, activeSnapshot);
    if (fixture.ready) {
      fixtureReady = true;
      pass('public_bubble_snapshot_fixture', fixture);
      bubbleHandle = await page.locator('mux-voice-mode-bubble').elementHandle();
    } else {
      blocked('public_bubble_snapshot_fixture', fixture.reason);
      blocked('active_visual_bubble_and_menu', 'requires a public bubble snapshot property');
      blocked('mouse_drag_snap_clamp', 'requires a visible active visual bubble');
      blocked('fixture_state_variants', 'requires a public bubble snapshot property');
      blocked('fixture_navigation_identity_and_normalized_position', 'requires a visible active visual bubble');
    }
    blocked('software_keyboard_visualviewport', 'A physical software keyboard cannot be invoked or mocked as real visualViewport evidence.');
    blocked('actual_mute_stop_media_cleanup', 'Visual fixture intentionally never invokes mute or stop; no media/network cleanup claim is made.');

    // Each requested screenshot is independently attempted; a failed navigation
    // cannot prevent the remaining three captures.
    await capture('desktop-workspace.png', 1280, 900, () => openWorkspace(`voice ui fixture A ${nonce}`));
    await capture('desktop-mission-control.png', 1280, 900, openMissionControl);
    await capture('mobile-workspace.png', 390, 844, () => openWorkspace(`voice ui fixture B ${nonce}`));
    await capture('mobile-mission-control.png', 390, 844, openMissionControl);

    await tryCheck('one_visible_mobile_header_voice_button_before_ellipsis_44px', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openWorkspace(`voice ui fixture B ${nonce}`);
      const headerButton = page.locator('mux-title-bar mux-voice-mode-button [data-voice-mode-button]');
      const ellipsis = page.locator('mux-title-bar button[title="Open menu"]');
      if (await headerButton.count() !== 1) throw new Error('header_voice_button_count_not_one');
      const [buttonBox, ellipsisBox] = await Promise.all([headerButton.boundingBox(), ellipsis.boundingBox()]);
      if (!buttonBox || !ellipsisBox || buttonBox.width < 44 || buttonBox.height < 44 || buttonBox.x >= ellipsisBox.x) {
        throw new Error('header_voice_button_geometry_invalid');
      }
      return { button_box: { width: buttonBox.width, height: buttonBox.height } };
    });

    await tryCheck('settings_modal_opens_without_configuration_write', async () => {
      const launcher = page.locator('mux-title-bar button[title="Open menu"]');
      await launcher.click();
      const settings = page.getByRole('button', { name: 'Settings', exact: true }).first();
      await settings.waitFor({ state: 'visible', timeout: 10_000 });
      await settings.click();
      await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
      if (fixtureReady) {
        const levels = await page.evaluate(() => {
          const app = document.querySelector('mux-app');
          const bubble = app?.shadowRoot?.querySelector('mux-voice-mode-bubble');
          const modal = app?.shadowRoot?.querySelector('.overlay-backdrop');
          return {
            bubble: Number(getComputedStyle(bubble).zIndex),
            modal: Number(getComputedStyle(modal).zIndex),
          };
        });
        if (!Number.isFinite(levels.bubble) || !Number.isFinite(levels.modal) || levels.bubble >= levels.modal) {
          throw new Error('visual_bubble_not_below_settings_modal');
        }
      }
      await page.keyboard.press('Escape');
      return { interaction: 'open_and_escape_only', visual_modal_layer: fixtureReady ? 'checked' : 'fixture_unavailable' };
    });

    await tryCheck('composer_keeps_dictation_without_mode_control', async () => {
      await openMissionControl();
      const contextSelector = page.locator('mux-cos:visible').locator('[data-thread-context-selector]');
      if (await contextSelector.count()) {
        await contextSelector.click();
        const option = page.locator('mux-cos:visible').locator('[data-thread-context-option]').first();
        await option.waitFor({ state: 'visible', timeout: 10_000 });
        await option.click();
        const talkHere = page.locator('mux-cos:visible').locator('[data-thread-talk-here]');
        await talkHere.waitFor({ state: 'visible', timeout: 10_000 });
        if (await talkHere.isDisabled()) throw new Error('real_thread_context_not_selectable');
        await talkHere.click();
      }
      const composer = page.locator('mux-cos:visible').locator('[data-thread-composer]');
      await composer.waitFor({ state: 'visible', timeout: 10_000 });
      await composer.waitFor({ state: 'attached', timeout: 10_000 });
      await eventually(async () => await composer.isEnabled(), 'real_composer_channel_ready', 10_000);
      const dictate = page.locator('mux-cos:visible').getByRole('button', { name: 'Dictate', exact: true });
      if (await dictate.count() !== 1) throw new Error('dictation_control_not_unique_after_real_context_selection');
      // This is the actual composer container, identified from its semantic
      // textarea; no retired voice class selector is used.
      const modeInsideComposer = await composer.evaluate((node) =>
        node.parentElement?.parentElement?.querySelectorAll('mux-voice-mode-button').length ?? 0);
      if (modeInsideComposer !== 0) throw new Error('voice_mode_present_in_composer');
      return { dictation_controls: 1, composer_channel: 'real_selected_context_or_default' };
    });

    if (fixtureReady) {
      const bubbleMain = page.locator('mux-voice-mode-bubble').locator('mux-voice-mode-button.bubble-main');
      const bubbleButton = bubbleMain.locator('[data-voice-mode-button]');
      const bubbleBox = async () => {
        const box = await page.locator('mux-voice-mode-bubble [data-voice-mode-bubble]').boundingBox();
        if (!box) throw new Error('bubble_not_visible');
        return box;
      };
      await tryCheck('public_snapshot_bubble_geometry', async () => {
        const [bubble, main, status] = await Promise.all([
          bubbleBox(),
          bubbleMain.boundingBox(),
          page.locator('mux-voice-mode-bubble [data-voice-mode-bubble] [role="status"]').boundingBox(),
        ]);
        if (!main || !status || Math.abs(main.width - 60) > 0.5 || Math.abs(main.height - 60) > 0.5 ||
          Math.abs(bubble.width - 84) > 0.5 || bubble.height < 88 || status.y < main.y + main.height) {
          throw new Error('public_snapshot_bubble_60_84x88_geometry_invalid');
        }
        return { main: '60px circular', bubble: `${bubble.width}x${bubble.height}`, status: 'below_main' };
      });
      await tryCheck('mouse_drag_snap_clamp', async () => {
        await openWorkspace(`voice ui fixture A ${nonce}`);
        let box = await bubbleBox();
        await page.mouse.move(box.x + 20, box.y + 20);
        await page.mouse.down();
        await page.mouse.move(1, 2, { steps: 3 });
        await page.mouse.up();
        await eventually(async () => await page.locator('mux-voice-mode-bubble [data-voice-mode-bubble]').getAttribute('data-edge') === 'left', 'snap_left');
        box = await bubbleBox();
        await page.mouse.move(box.x + 20, box.y + 20);
        await page.mouse.down();
        await page.mouse.move(9_999, 9_999, { steps: 3 });
        await page.mouse.up();
        await eventually(async () => {
          const moved = await bubbleBox();
          const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
          return moved.x >= 0 && moved.y >= 0 &&
            moved.x + moved.width <= viewport.width && moved.y + moved.height <= viewport.height;
        }, 'mouse_clamp');
        return { mouse_drag: 'trusted_playwright_mouse_input', clamp: 'current_viewport' };
      });

      await tryCheck('bubble_menu_dock_keyboard_and_terminal_focus', async () => {
        await bubbleButton.click();
        const dialog = page.getByRole('dialog', { name: 'Voice mode controls', exact: true });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.press('ArrowRight');
        if (await page.locator('mux-voice-mode-bubble [data-voice-mode-bubble]').getAttribute('data-edge') !== 'right') {
          throw new Error('keyboard_dock_right_failed');
        }
        const terminal = page.locator('textarea.xterm-helper-textarea').first();
        if (await terminal.count()) {
          await terminal.focus();
          const before = await page.evaluate(() => document.activeElement?.className ?? '');
          const box = await bubbleBox();
          await page.mouse.move(box.x + 20, box.y + 20);
          await page.mouse.down();
          await page.mouse.move(box.x + 30, box.y + 30);
          await page.mouse.up();
          const after = await page.evaluate(() => document.activeElement?.className ?? '');
          if (before !== after) throw new Error('drag_stole_terminal_focus');
        }
        return { menu: 'opened', keyboard_dock: 'right', terminal_focus: 'checked_when_present' };
      });

      await tryCheck('fixture_state_variants', async () => {
        for (const snapshot of [
          { ...activeSnapshot, state: 'connecting' },
          { ...activeSnapshot, state: 'error' },
          { ...activeSnapshot, muted: true },
        ]) {
          const applied = await page.evaluate(componentFixture, snapshot);
          if (!applied.ready) throw new Error('fixture_state_apply_failed');
        }
        await page.evaluate(componentFixture, activeSnapshot);
        return { states: ['connecting', 'error', 'muted'] };
      });

      await tryCheck('fixture_navigation_identity_and_normalized_position', async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openWorkspace(`voice ui fixture B ${nonce}`);
        await openMissionControl();
        const sameAfterMissionControl = await page.evaluate((original) => original === document.querySelector('mux-app')?.shadowRoot?.querySelector('mux-voice-mode-bubble'), bubbleHandle);
        const fleet = page.locator('mux-title-bar:visible').getByRole('button', { name: /Show the fleet|Sessions need input\. Show the fleet/i });
        await fleet.click();
        const appletSheet = page.locator('mux-cos:visible .sheet:popover-open');
        await appletSheet.waitFor({ state: 'visible', timeout: 8_000 });
        await appletSheet.getByRole('button', { name: 'Close the applets', exact: true }).click();
        await appletSheet.waitFor({ state: 'hidden', timeout: 8_000 });
        await openWorkspace(`voice ui fixture B ${nonce}`);
        const sameAfterWorkspace = await page.evaluate((original) => original === document.querySelector('mux-app')?.shadowRoot?.querySelector('mux-voice-mode-bubble'), bubbleHandle);
        if (!sameAfterMissionControl || !sameAfterWorkspace) throw new Error('bubble_dom_identity_changed');
        await page.setViewportSize({ width: 844, height: 390 });
        const box = await bubbleBox();
        if (box.x < 0 || box.y < 0 || box.x + box.width > 844 || box.y + box.height > 390) throw new Error('landscape_clamp_failed');
        return { dom_ref_identity: 'preserved', mobile_navigation: 'workspace_mission_control_applets_workspace', landscape: '844x390' };
      });

      await tryCheck('reduced_motion_disables_snap_transition', async () => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const box = await bubbleBox();
        await page.mouse.move(box.x + 20, box.y + 20);
        await page.mouse.down();
        await page.mouse.move(5, Math.min(360, box.y + 20), { steps: 2 });
        await page.mouse.up();
        const snapping = await page.locator('mux-voice-mode-bubble [data-voice-mode-bubble]').getAttribute('data-snapping');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        if (snapping === 'true') throw new Error('snap_transition_present_under_reduced_motion');
        return { media: 'prefers-reduced-motion: reduce' };
      });
      await tryCheck('SCRIPTED_POINTER_CANCEL', async () => {
        await openWorkspace(`voice ui fixture A ${nonce}`);
        const openDialog = page.getByRole('dialog', { name: 'Voice mode controls', exact: true });
        if (await openDialog.isVisible().catch(() => false)) await openDialog.press('Escape');
        const box = await bubbleBox();
        await page.mouse.move(box.x + 20, box.y + 20);
        await page.mouse.down();
        await page.evaluate(() => {
          const main = document.querySelector('mux-app')?.shadowRoot
            ?.querySelector('mux-voice-mode-bubble')?.shadowRoot
            ?.querySelector('mux-voice-mode-button.bubble-main');
          if (!main) throw new Error('bubble_main_not_found_for_pointercancel');
          main.dispatchEvent(new PointerEvent('pointercancel', {
            bubbles: true, composed: true, pointerId: 1, pointerType: 'mouse',
          }));
        });
        await page.mouse.up();
        await bubbleButton.focus();
        await page.keyboard.press('Enter');
        await page.getByRole('dialog', { name: 'Voice mode controls', exact: true })
          .waitFor({ state: 'visible', timeout: 10_000 });
        return { input: 'synthetic_DOM_pointercancel_matching_trusted_mouse_pointer_1', keyboard: 'Enter_opens_menu' };
      });
    }

    const failures = Object.values(report.checks).filter((check) => check.status === 'FAIL');
    const blockers = Object.values(report.checks).filter((check) => check.status === 'BLOCKED');
    report.status = failures.length ? 'FAIL' : blockers.length ? 'BLOCKED' : 'PASS';
  } catch (error) {
    report.errors.push({ stage: 'runner', ...safeError(error) });
    report.status = 'FAIL';
    await failureShot('runner');
  } finally {
    await browser?.close();
    writeReport();
  }
}

await main();
console.log(JSON.stringify({ status: report.status, mode: report.mode }));
process.exitCode = report.status === 'PASS' ? 0 : 1;