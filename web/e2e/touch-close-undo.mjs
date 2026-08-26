#!/usr/bin/env node
/**
 * Activity-aware close E2E (the filename is retained for compatibility).
 *
 * Requires a browser build and sessiond that both implement the correlated
 * close-intent/close-confirm contract. This artifact deliberately exercises the
 * integrated service; frontend-only lanes should syntax-check it but must not
 * run it against an older shared daemon.
 *
 * Coverage:
 *   1. A busy pane opens one Cancel-default modal without removing its panel,
 *      terminal, or layout. Cancel preserves the live pane and content.
 *   2. An invalid confirmation dismisses its stale modal, leaves the pane
 *      live, and cannot issue a fresh close intent.
 *   3. Confirm keeps the pane locally present until a deliberately delayed
 *      authoritative pane-closed broadcast is released; close-outcome alone
 *      cannot remove the pane.
 *   4. Narrow/mobile pane and workspace rows expose sibling close controls with
 *      44x44 touch targets and route both targets through the shared modal.
 *   5. Confirming the attached workspace recovers exactly once to a surviving
 *      workspace after workspace-closed plus workspace-list.
 *   6. The removed mux-undo-toast never appears.
 *
 * Usage: node web/e2e/touch-close-undo.mjs [--url http://localhost:9090]
 * Exit codes: 0 = passed, 1 = assertion failure, 2 = setup/integration error.
 */

import { execFileSync } from 'node:child_process';

let url = 'http://localhost:9090';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && i + 1 < argv.length) url = argv[++i];
  else if (argv[i].startsWith('--url=')) url = argv[i].slice('--url='.length);
}

function pcli(...args) {
  return execFileSync('playwright-cli', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const HELPERS = `
  function _app() {
    return document.querySelector('mux-app');
  }
  function _dock() {
    return _app()?.shadowRoot?.querySelector('mux-dock') ?? null;
  }
  function _modal() {
    return _app()?.shadowRoot?.querySelector('close-confirmation-modal') ?? null;
  }
  function _dialog() {
    return _modal()?.shadowRoot?.querySelector('dialog') ?? null;
  }
  function _activeCloseButton() {
    return _dock()?.querySelector('.dv-tab.dv-active-tab button.dv-default-tab-action')
      ?? _dock()?.querySelector('button.dv-default-tab-action')
      ?? null;
  }
  function _mobilePicker() {
    const titleBar = _app()?.shadowRoot?.querySelector('mux-title-bar');
    return titleBar?.shadowRoot?.querySelector('mux-pane-picker') ?? null;
  }
`;

function evalJson(expression) {
  const raw = execFileSync(
    'playwright-cli',
    ['--raw', 'eval', `${HELPERS}; JSON.stringify(${expression})`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ).trim();
  let parsed = JSON.parse(raw);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return parsed;
}

function waitFor(condition, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = evalJson(`({ ok: Boolean(${condition}) })`);
      if (last.ok) return;
    } catch {
      // A Lit render can temporarily replace a queried element; poll again.
    }
    pause(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
  } else {
    failures++;
    console.error(`  FAIL: ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

function shellOctalText(text) {
  return Array.from(
    text,
    (character) => `\\${character.codePointAt(0).toString(8).padStart(3, '0')}`,
  ).join('');
}

function startBusyCommand(marker) {
  const paneId = evalJson('window.__muxStore.activePaneId');
  pcli('eval', `${HELPERS}; window.__muxRegistry.peek(${paneId}).focus()`);
  // The terminal's local echo contains only octal escapes, never the marker.
  // Seeing the literal marker therefore proves printf started executing.
  pcli('type', `printf '${shellOctalText(marker)}\\n'; sleep 90`);
  pcli('press', 'Enter');
  waitFor(
    `_dock().getTerminalContent(${paneId}).includes('${marker}')`,
    `busy command marker ${marker}`,
  );
  return paneId;
}

function holdPaneClosedBroadcast(workspaceId, paneId) {
  pcli(
    'eval',
    `${HELPERS}; (() => {
      const socket = _app()?._socket;
      if (!socket || typeof socket.onSessiondMessage !== 'function') {
        throw new Error('mux socket sessiond callback is unavailable');
      }
      const state = {
        socket,
        originalOnSessiondMessage: socket.onSessiondMessage,
        held: [],
        closeOutcomeSeen: false,
      };
      window.__muxCloseE2EPaneHold = state;
      socket.onSessiondMessage = (message) => {
        if (
          message.type === 'pane-closed' &&
          message.workspaceId === ${JSON.stringify(workspaceId)} &&
          message.paneId === ${paneId}
        ) {
          state.held.push(message);
          return;
        }
        if (
          message.type === 'close-outcome' &&
          message.targetKind === 'pane' &&
          message.workspaceId === ${JSON.stringify(workspaceId)} &&
          message.paneId === ${paneId} &&
          message.closeStatus === 'closed'
        ) {
          state.closeOutcomeSeen = true;
        }
        state.originalOnSessiondMessage(message);
      };
    })()`,
  );
}

function releasePaneClosedBroadcast() {
  pcli(
    'eval',
    `${HELPERS}; (() => {
      const state = window.__muxCloseE2EPaneHold;
      if (!state) throw new Error('pane-closed broadcast hold is unavailable');
      state.socket.onSessiondMessage = state.originalOnSessiondMessage;
      const held = state.held.splice(0);
      delete window.__muxCloseE2EPaneHold;
      for (const message of held) state.originalOnSessiondMessage(message);
    })()`,
  );
}

function interceptInvalidCloseConfirmation() {
  pcli(
    'eval',
    `${HELPERS}; (() => {
      const socket = _app()?._socket;
      if (
        !socket ||
        typeof socket.closeIntent !== 'function' ||
        typeof socket.closeConfirm !== 'function'
      ) {
        throw new Error('mux close request methods are unavailable');
      }
      const state = {
        socket,
        originalCloseIntent: socket.closeIntent,
        originalCloseConfirm: socket.closeConfirm,
        closeIntentCount: 0,
        closeConfirmCount: 0,
      };
      window.__muxCloseE2EInvalidTicket = state;
      socket.closeIntent = (...args) => {
        state.closeIntentCount++;
        return state.originalCloseIntent.apply(socket, args);
      };
      socket.closeConfirm = (_ticket, target) => {
        state.closeConfirmCount++;
        return Promise.resolve({
          type: 'close-outcome',
          cid: 1,
          ...target,
          closeStatus: 'failed',
          failureCode: 'invalid-close-ticket',
          error: 'The close confirmation is no longer valid.',
        });
      };
    })()`,
  );
}

function restoreInvalidCloseConfirmation() {
  return evalJson(`(() => {
    const state = window.__muxCloseE2EInvalidTicket;
    if (!state) throw new Error('invalid close-ticket interceptor is unavailable');
    state.socket.closeIntent = state.originalCloseIntent;
    state.socket.closeConfirm = state.originalCloseConfirm;
    delete window.__muxCloseE2EInvalidTicket;
    return {
      closeIntentCount: state.closeIntentCount,
      closeConfirmCount: state.closeConfirmCount,
    };
  })()`);
}

function countRecoveryAttaches(workspaceId) {
  pcli(
    'eval',
    `${HELPERS}; (() => {
      const socket = _app()?._socket;
      if (!socket || typeof socket.attachWithBreakpoint !== 'function') {
        throw new Error('mux socket workspace attach is unavailable');
      }
      const state = {
        socket,
        originalAttachWithBreakpoint: socket.attachWithBreakpoint,
        attachCount: 0,
      };
      window.__muxCloseE2ERecovery = state;
      socket.attachWithBreakpoint = (targetWorkspaceId, breakpoint) => {
        if (targetWorkspaceId === ${JSON.stringify(workspaceId)}) state.attachCount++;
        return state.originalAttachWithBreakpoint.call(socket, targetWorkspaceId, breakpoint);
      };
    })()`,
  );
}

function restoreRecoveryAttaches() {
  return evalJson(`(() => {
    const state = window.__muxCloseE2ERecovery;
    if (!state) throw new Error('workspace recovery attach counter is unavailable');
    state.socket.attachWithBreakpoint = state.originalAttachWithBreakpoint;
    delete window.__muxCloseE2ERecovery;
    return state.attachCount;
  })()`);
}

let exitCode = 0;
try {
  pcli('open', url);
  waitFor(
    `_app() && window.__muxStore && _dock() && window.__muxStore.panes.some((p) => p.paneId >= 0)`,
    'initial composition',
    15_000,
  );

  const initialCount = evalJson(
    'window.__muxStore.panes.filter((pane) => pane.paneId >= 0).length',
  );
  if (initialCount < 2) {
    pcli(
      'eval',
      `${HELPERS}; _dock().dispatchEvent(new CustomEvent('pane-create', { bubbles: true, composed: true }))`,
    );
    waitFor(
      `window.__muxStore.panes.filter((pane) => pane.paneId >= 0).length >= 2`,
      'second pane',
    );
  }

  console.log('Scenario 1: busy pane intent and Cancel');
  const paneId = startBusyCommand('CLOSE_E2E_BUSY');
  const before = evalJson(`(() => {
    const dock = _dock();
    return {
      content: dock.getTerminalContent(${paneId}),
      layout: JSON.stringify(dock._dv.toJSON()),
      panelCount: dock._panels.size,
      terminalPresent: window.__muxRegistry.peek(${paneId}) !== null,
    };
  })()`);

  pcli('eval', `${HELPERS}; _activeCloseButton().click()`);
  waitFor(
    `_dialog()?.open && _modal().shadowRoot.querySelector('h2')?.textContent === 'Close pane?'`,
    'pane confirmation modal',
  );
  waitFor(
    `_modal().shadowRoot.activeElement?.classList.contains('cancel')`,
    'Cancel initial focus',
  );

  const warned = evalJson(`(() => {
    const dock = _dock();
    return {
      modalCount: _app().shadowRoot.querySelectorAll('close-confirmation-modal').length,
      paneInStore: window.__muxStore.panes.some((pane) => pane.paneId === ${paneId}),
      panelPresent: dock._panels.has(${paneId}),
      terminalPresent: window.__muxRegistry.peek(${paneId}) !== null,
      content: dock.getTerminalContent(${paneId}),
      layout: JSON.stringify(dock._dv.toJSON()),
      undoPresent: _app().shadowRoot.querySelector('mux-undo-toast') !== null,
    };
  })()`);
  check('exactly one pane modal is open', warned.modalCount === 1, warned);
  check('busy pane remains in authoritative store', warned.paneInStore, warned);
  check('busy dock panel remains mounted', warned.panelPresent, warned);
  check('busy terminal remains registered', warned.terminalPresent, warned);
  check('busy terminal content is preserved while warned', warned.content === before.content);
  check('layout is unchanged while warned', warned.layout === before.layout);
  check('no Undo toast is rendered', !warned.undoPresent);

  pcli(
    'eval',
    `${HELPERS}; _dock().dispatchEvent(new CustomEvent('pane-close', {
      detail: { workspaceId: window.__muxStore.attached, paneId: ${paneId} },
      bubbles: true,
      composed: true
    }))`,
  );
  const duplicate = evalJson(`({
    modalCount: _app().shadowRoot.querySelectorAll('close-confirmation-modal').length,
    cancelFocused: _modal().shadowRoot.activeElement?.classList.contains('cancel') === true
  })`);
  check('duplicate intent does not stack a dialog', duplicate.modalCount === 1, duplicate);
  check('duplicate intent focuses Cancel', duplicate.cancelFocused, duplicate);

  pcli('eval', `${HELPERS}; _modal().shadowRoot.querySelector('.cancel').click()`);
  waitFor(`!_modal()`, 'pane modal dismissal');
  const cancelled = evalJson(`(() => {
    const dock = _dock();
    return {
      paneInStore: window.__muxStore.panes.some((pane) => pane.paneId === ${paneId}),
      panelPresent: dock._panels.has(${paneId}),
      terminalPresent: window.__muxRegistry.peek(${paneId}) !== null,
      content: dock.getTerminalContent(${paneId}),
      layout: JSON.stringify(dock._dv.toJSON()),
    };
  })()`);
  check('Cancel keeps the pane live', cancelled.paneInStore && cancelled.panelPresent, cancelled);
  check('Cancel keeps the terminal live', cancelled.terminalPresent, cancelled);
  check('Cancel preserves terminal content', cancelled.content === before.content);
  check('Cancel preserves layout', cancelled.layout === before.layout);

  console.log('Scenario 2: invalid confirmation is non-destructive');
  pcli('eval', `${HELPERS}; _activeCloseButton().click()`);
  waitFor(`_dialog()?.open`, 'invalid pane confirmation modal');
  interceptInvalidCloseConfirmation();
  pcli('eval', `${HELPERS}; _modal().shadowRoot.querySelector('.destructive').click()`);
  waitFor(
    `!_modal() && _app().shadowRoot.querySelector('.close-alert')?.textContent.includes('target is still open')`,
    'invalid confirmation recovery alert',
  );
  const invalidTicket = evalJson(`(() => ({
    modalPresent: _modal() !== null,
    alert: _app().shadowRoot.querySelector('.close-alert')?.textContent ?? '',
    paneInStore: window.__muxStore.panes.some((pane) => pane.paneId === ${paneId}),
    panelPresent: _dock()._panels.has(${paneId}),
    terminalPresent: window.__muxRegistry.peek(${paneId}) !== null,
  }))()`);
  const invalidTicketCalls = restoreInvalidCloseConfirmation();
  check(
    'invalid confirmation does not issue a fresh close intent',
    invalidTicketCalls.closeIntentCount === 0 && invalidTicketCalls.closeConfirmCount === 1,
    invalidTicketCalls,
  );
  check(
    'invalid confirmation keeps the pane structurally live',
    invalidTicket.paneInStore && invalidTicket.panelPresent && invalidTicket.terminalPresent,
    invalidTicket,
  );
  check(
    'invalid confirmation expires the modal and asks for a new close gesture',
    !invalidTicket.modalPresent && invalidTicket.alert.includes('target is still open'),
    invalidTicket,
  );

  console.log('Scenario 3: close-outcome cannot remove without pane-closed');
  pcli('eval', `${HELPERS}; _activeCloseButton().click()`);
  waitFor(`_dialog()?.open`, 'second pane confirmation modal');
  const paneWorkspaceId = evalJson('window.__muxStore.attached');
  holdPaneClosedBroadcast(paneWorkspaceId, paneId);
  const immediatelyAfterConfirm = evalJson(`(() => {
    _modal().shadowRoot.querySelector('.destructive').click();
    return {
      paneInStore: window.__muxStore.panes.some((pane) => pane.paneId === ${paneId}),
      panelPresent: _dock()._panels.has(${paneId}),
      terminalPresent: window.__muxRegistry.peek(${paneId}) !== null,
    };
  })()`);
  check(
    'confirm does not synchronously remove pane structure',
    immediatelyAfterConfirm.paneInStore &&
      immediatelyAfterConfirm.panelPresent &&
      immediatelyAfterConfirm.terminalPresent,
    immediatelyAfterConfirm,
  );
  waitFor(
    `window.__muxCloseE2EPaneHold?.closeOutcomeSeen === true
      && window.__muxCloseE2EPaneHold?.held.length === 1
      && !_modal()`,
    'successful close-outcome with held pane-closed broadcast',
    15_000,
  );
  const replyOnly = evalJson(`({
    paneInStore: window.__muxStore.panes.some((pane) => pane.paneId === ${paneId}),
    panelPresent: _dock()._panels.has(${paneId}),
    terminalPresent: window.__muxRegistry.peek(${paneId}) !== null,
    heldPaneClosed: window.__muxCloseE2EPaneHold?.held.length ?? 0,
    closeOutcomeSeen: window.__muxCloseE2EPaneHold?.closeOutcomeSeen === true,
  })`);
  check(
    'successful close-outcome alone does not remove pane structure',
    replyOnly.closeOutcomeSeen &&
      replyOnly.heldPaneClosed === 1 &&
      replyOnly.paneInStore &&
      replyOnly.panelPresent &&
      replyOnly.terminalPresent,
    replyOnly,
  );
  releasePaneClosedBroadcast();
  waitFor(
    `!window.__muxStore.panes.some((pane) => pane.paneId === ${paneId})
      && !_dock()._panels.has(${paneId})
      && window.__muxRegistry.peek(${paneId}) === null`,
    'pane-closed broadcast reconciliation',
    15_000,
  );
  check('confirmed pane is removed after broadcast', true);

  console.log('Scenario 4: narrow/mobile pane and workspace close controls');
  pcli('resize', '390', '844');
  waitFor(`_mobilePicker()`, 'mobile pane picker');

  const mobilePaneId = startBusyCommand('CLOSE_E2E_MOBILE_BUSY');
  pcli('eval', `${HELPERS}; _mobilePicker().shadowRoot.querySelector('.breadcrumb').click()`);
  waitFor(
    `_mobilePicker().shadowRoot.querySelector('.dropdown')`,
    'mobile picker dropdown',
  );
  const mobileControls = evalJson(`(() => {
    const root = _mobilePicker().shadowRoot;
    const activePaneRow = [...root.querySelectorAll('.picker-row')]
      .find((row) => row.querySelector('.pane-item.active'));
    const activeWorkspaceRow = [...root.querySelectorAll('.picker-row')]
      .find((row) => row.querySelector('.ws-item.active'));
    const paneClose = activePaneRow?.querySelector('.pane-close');
    const workspaceClose = activeWorkspaceRow?.querySelector('.workspace-close');
    const paneRect = paneClose?.getBoundingClientRect();
    const workspaceRect = workspaceClose?.getBoundingClientRect();
    return {
      paneClosePresent: Boolean(paneClose),
      workspaceClosePresent: Boolean(workspaceClose),
      paneSize: paneRect ? [paneRect.width, paneRect.height] : [0, 0],
      workspaceSize: workspaceRect ? [workspaceRect.width, workspaceRect.height] : [0, 0],
      nestedButton: Boolean(root.querySelector('button button')),
    };
  })()`);
  check('mobile pane close affordance is present', mobileControls.paneClosePresent, mobileControls);
  check(
    'mobile workspace close affordance is present with the current workspace',
    mobileControls.workspaceClosePresent,
    mobileControls,
  );
  check(
    'mobile pane close target is at least 44x44',
    mobileControls.paneSize[0] >= 44 && mobileControls.paneSize[1] >= 44,
    mobileControls,
  );
  check(
    'mobile workspace close target is at least 44x44',
    mobileControls.workspaceSize[0] >= 44 && mobileControls.workspaceSize[1] >= 44,
    mobileControls,
  );
  check('mobile picker has no nested buttons', !mobileControls.nestedButton, mobileControls);

  pcli('eval', `${HELPERS}; (() => {
    const root = _mobilePicker().shadowRoot;
    const row = [...root.querySelectorAll('.picker-row')]
      .find((candidate) => candidate.querySelector('.pane-item.active'));
    row.querySelector('.pane-close').click();
  })()`);
  waitFor(
    `_dialog()?.open && _modal().shadowRoot.querySelector('h2')?.textContent === 'Close pane?'`,
    'mobile pane confirmation',
  );
  const mobilePaneWarned = evalJson(`({
    paneInStore: window.__muxStore.panes.some((pane) => pane.paneId === ${mobilePaneId}),
    panelPresent: _dock()._panels.has(${mobilePaneId})
  })`);
  check(
    'mobile pane close keeps the busy pane live before confirmation',
    mobilePaneWarned.paneInStore && mobilePaneWarned.panelPresent,
    mobilePaneWarned,
  );
  pcli('eval', `${HELPERS}; _modal().shadowRoot.querySelector('.cancel').click()`);
  waitFor(`!_modal()`, 'mobile pane modal dismissal');

  const closingWorkspaceId = evalJson('window.__muxStore.attached');
  const survivorName = `Close E2E survivor ${Date.now()}`;
  pcli(
    'eval',
    `${HELPERS}; _app()._socket.createWorkspace(${JSON.stringify(survivorName)})`,
  );
  waitFor(
    `window.__muxStore.workspaces.some(
      (workspace) => workspace.name === ${JSON.stringify(survivorName)}
    )`,
    'survivor workspace creation',
  );
  const survivorId = evalJson(
    `window.__muxStore.workspaces.find(
      (workspace) => workspace.name === ${JSON.stringify(survivorName)}
    ).workspaceId`,
  );
  waitFor(
    `window.__muxStore.attached === ${JSON.stringify(survivorId)}`,
    'new survivor workspace attachment',
  );
  // Workspace creation intentionally attaches its new workspace. Return to the
  // busy original before exercising the attached-workspace close path.
  pcli(
    'eval',
    `${HELPERS}; _app()._socket.attachWithBreakpoint(
      ${JSON.stringify(closingWorkspaceId)},
      window.innerWidth < 768 ? 'narrow' : 'wide'
    )`,
  );
  waitFor(
    `window.__muxStore.attached === ${JSON.stringify(closingWorkspaceId)}
      && window.__muxStore.panes.some((pane) => pane.paneId === ${mobilePaneId})`,
    'busy workspace reattachment',
  );

  pcli('eval', `${HELPERS}; _mobilePicker().shadowRoot.querySelector('.breadcrumb').click()`);
  waitFor(`_mobilePicker().shadowRoot.querySelector('.dropdown')`, 'reopened mobile picker');
  pcli('eval', `${HELPERS}; (() => {
    const root = _mobilePicker().shadowRoot;
    const row = [...root.querySelectorAll('.picker-row')]
      .find((candidate) => candidate.querySelector('.ws-item.active'));
    row.querySelector('.workspace-close').click();
  })()`);
  waitFor(
    `_dialog()?.open && _modal().shadowRoot.querySelector('h2')?.textContent === 'Close workspace?'`,
    'mobile workspace confirmation',
  );
  const workspaceWarned = evalJson(`({
    workspacePresent: window.__muxStore.workspaces.some(
      (workspace) => workspace.workspaceId === ${JSON.stringify(closingWorkspaceId)}
    ),
    panePresent: window.__muxStore.panes.some((pane) => pane.paneId === ${mobilePaneId}),
    modalCount: _app().shadowRoot.querySelectorAll('close-confirmation-modal').length
  })`);
  check(
    'mobile workspace close opens one shared modal',
    workspaceWarned.modalCount === 1,
    workspaceWarned,
  );
  check(
    'mobile workspace and pane remain live before confirmation',
    workspaceWarned.workspacePresent && workspaceWarned.panePresent,
    workspaceWarned,
  );
  countRecoveryAttaches(survivorId);
  pcli('eval', `${HELPERS}; _modal().shadowRoot.querySelector('.destructive').click()`);
  waitFor(
    `window.__muxStore.attached === ${JSON.stringify(survivorId)}
      && !window.__muxStore.workspaces.some(
        (workspace) => workspace.workspaceId === ${JSON.stringify(closingWorkspaceId)}
      )
      && window.__muxCloseE2ERecovery?.attachCount >= 1`,
    'authoritative survivor workspace recovery',
    15_000,
  );
  pause(750);
  const workspaceRecovery = evalJson(`({
    attached: window.__muxStore.attached,
    closedWorkspacePresent: window.__muxStore.workspaces.some(
      (workspace) => workspace.workspaceId === ${JSON.stringify(closingWorkspaceId)}
    ),
    survivorPresent: window.__muxStore.workspaces.some(
      (workspace) => workspace.workspaceId === ${JSON.stringify(survivorId)}
    ),
    attachCount: window.__muxCloseE2ERecovery?.attachCount ?? -1,
  })`);
  const recoveryAttachCount = restoreRecoveryAttaches();
  check(
    'workspace close recovers to the intended survivor',
    workspaceRecovery.attached === survivorId &&
      !workspaceRecovery.closedWorkspacePresent &&
      workspaceRecovery.survivorPresent,
    workspaceRecovery,
  );
  check(
    'workspace close performs exactly one survivor attach',
    recoveryAttachCount === 1,
    workspaceRecovery,
  );

  const noUndo = evalJson(
    `_app().shadowRoot.querySelector('mux-undo-toast') === null`,
  );
  check('Undo UI remains absent across all close surfaces', noUndo);

  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    exitCode = 1;
  } else {
    console.log('ALL CHECKS PASSED');
  }
} catch (error) {
  console.error('SETUP/INTEGRATION ERROR:', error instanceof Error ? error.message : error);
  exitCode = 2;
} finally {
  try {
    execFileSync('playwright-cli', ['close'], { stdio: 'ignore' });
  } catch {
    // Ignore cleanup failure; the assertion/setup result is authoritative.
  }
}

process.exitCode = exitCode;