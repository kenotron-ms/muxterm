/**
 * home-demo.ts — the standalone home-view preview.
 *
 * NO DAEMON, NO WEBSOCKET, NO <mux-app>. This entry mounts the real
 * <mux-home> and the real <mux-start-card> against FIXTURE_SESSIONS and
 * nothing else, so the thing you click in a browser is the thing that ships.
 *
 * The sidebar around them is a mock — the app's <mux-sidebar> is bound to the
 * sessiond store and cannot run backend-free. Its Start card and its badges,
 * however, are the real component and the real helper
 * (needsInputByWorkspace), so the invariant on display here — Start count ==
 * sum of badges — is the same invariant the app enforces.
 *
 * Build:  npx vite build --config vite.demo.config.ts     (from web/)
 * Serve:  any static server rooted at web/dist-demo/
 */

import '../components/mux-home.js';
import '../components/mux-start-card.js';
import { NEEDS_GLYPH } from '../components/mux-start-card.js';
import type { MuxHome } from '../components/mux-home.js';
import type { MuxStartCard } from '../components/mux-start-card.js';
import {
  FIXTURE_SESSIONS,
  needsInputByWorkspace,
  needsInputCount,
  type SessionState,
} from '../lib/session-state.js';
import { applyChromeTokens, applyThemeTokens, resolvePalette, PALETTES } from '../lib/theme.js';
import { installHomeToggle } from '../lib/keybindings.js';

// The preview @font-face lives in demo/index.html, NOT here — injecting it
// from this module is too late: <mux-home> upgrades when the import above is
// evaluated and probes document.fonts immediately, so a rule added in boot()
// loses the race and every tile falls back to text. See the comment there.

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * The zero state, derived from the same fixture rather than hand-written, so
 * "all clear" is provably the same sessions with nothing blocked. Zero is the
 * state the user is trying to reach; it has to be viewable.
 */
const ALL_CLEAR: SessionState[] = FIXTURE_SESSIONS.map((s) =>
  s.state === 'blocked'
    ? { ...s, state: 'working' as const, waitingFor: undefined, doing: 'answered — carrying on' }
    : s,
);

/**
 * A fuller board, DEMO-ONLY.
 *
 * FIXTURE_SESSIONS holds five rows, which means tiles mode shows one or two
 * thumbnails per section and the grid never fills — an honest picture of the
 * fixture, but a misleading picture of the design, which is meant to be read
 * as a wall. These extra rows exist so the tile grid can be looked at as
 * intended. They are NOT part of the SessionState contract's fixture and must
 * not leak back into session-state.ts.
 */
const CROWD: SessionState[] = [
  ...FIXTURE_SESSIONS,
  {
    sessionId: 'fx-flaky-bisect', paneId: 11, workspaceId: 'flaky',
    project: '/home/ken/workspace/muxterm', name: 'flaky-bisect', mode: 'goal',
    state: 'blocked', waitingFor: 'worker request',
    doing: 'provider throttled 3x, no forward progress', updatedAt: 0,
  },
  {
    sessionId: 'fx-fleet-subscription', paneId: 5, workspaceId: 'cos',
    project: '/home/ken/workspace/muxterm', name: 'fleet-subscription', mode: 'goal',
    state: 'working', doing: 'drafting the additive protocol message', updatedAt: 0,
  },
  {
    sessionId: 'fx-hook-events', paneId: 6, workspaceId: 'cos',
    project: '/home/ken/amplifier', name: 'hook-events', mode: 'goal',
    state: 'working', doing: 'wiring session:start in __init__.py', updatedAt: 0,
  },
  {
    sessionId: 'fx-resize-parity', paneId: 13, workspaceId: 'parity',
    project: '/home/ken/workspace/muxterm', name: 'resize-parity', mode: 'goal',
    state: 'working', doing: 'go test ./... — 4 of 9 packages', updatedAt: 0,
  },
  {
    sessionId: 'fx-preview-per-pane', paneId: 12, workspaceId: 'flaky',
    project: '/home/ken/workspace/muxterm', name: 'preview-per-pane', mode: 'goal',
    state: 'failed', doing: 'the 250ms gate assumption was wrong', updatedAt: 0,
  },
  {
    sessionId: 'fx-docs-sweep', paneId: 8, workspaceId: 'infra',
    project: '/home/ken/workspace/muxterm', name: 'docs-sweep', mode: 'plain',
    state: 'done', doing: '8 files, +214 -67', pr: 49, updatedAt: 0,
  },
];

const SCENARIOS: Record<string, SessionState[]> = {
  busy: FIXTURE_SESSIONS,
  crowd: CROWD,
  clear: ALL_CLEAR,
  empty: [],
};

type ScenarioId = keyof typeof SCENARIOS;

// ---------------------------------------------------------------------------
// Mock workspaces
// ---------------------------------------------------------------------------

interface MockWorkspace {
  id: string;
  panes: number;
}

/** Workspaces the fixture's sessions live in, plus one with nothing to say. */
const WORKSPACES: MockWorkspace[] = [
  { id: 'parity', panes: 4 },
  { id: 'cos', panes: 3 },
  { id: 'infra', panes: 2 },
  { id: 'flaky', panes: 1 },
];

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const qs = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`home-demo: missing ${sel}`);
  return el;
};

let scenario: ScenarioId = 'busy';
let selectedWs: string | null = null;

function sessions(): SessionState[] {
  return SCENARIOS[scenario] ?? [];
}

function renderSidebar(): void {
  const list = sessions();
  const byWs = needsInputByWorkspace(list);

  const card = qs<MuxStartCard>('mux-start-card');
  card.count = needsInputCount(list);
  card.spread = byWs.size;
  card.active = selectedWs === null;
  card.hint = 'ctrl+`';

  const host = qs<HTMLElement>('#ws-list');
  host.textContent = '';
  for (const ws of WORKSPACES) {
    const needs = byWs.get(ws.id) ?? 0;
    const el = document.createElement('div');
    el.className = `ws-card ${selectedWs === ws.id ? 'active' : ''}`;
    el.innerHTML =
      `<span class="dot ${selectedWs === ws.id ? 'on' : ''}">●</span>` +
      `<span class="ws-name"></span>` +
      (needs > 0
        ? `<span class="ws-needs">${NEEDS_GLYPH} ${needs}</span>`
        : `<span class="ws-panes">${ws.panes} pane${ws.panes === 1 ? '' : 's'}</span>`);
    // Name via textContent, never innerHTML — a workspace name is user data.
    const nameEl = el.querySelector('.ws-name');
    if (nameEl) nameEl.textContent = ws.id;
    el.addEventListener('click', () => {
      selectedWs = ws.id;
      render();
    });
    host.appendChild(el);
  }

  // The arithmetic the sidebar promises, stated out loud so it can be checked
  // by eye in one pass.
  const sum = [...byWs.values()].reduce((a, b) => a + b, 0);
  qs<HTMLElement>('#invariant').textContent =
    `start ${needsInputCount(list)} = sum of badges ${sum}${
      needsInputCount(list) === sum ? ' ✓' : ' ✗ MISMATCH'
    }`;
}

function renderMain(): void {
  const main = qs<HTMLElement>('#main');
  const home = qs<MuxHome>('mux-home');
  const stand = qs<HTMLElement>('#dock-stand-in');

  if (selectedWs === null) {
    home.style.display = '';
    stand.style.display = 'none';
    home.sessions = sessions();
    home.fixture = true;
    home.focusView();
  } else {
    // A workspace is selected: in the app the dock takes over here. The demo
    // has no terminals, so it says so rather than faking one.
    home.style.display = 'none';
    stand.style.display = '';
    qs<HTMLElement>('#stand-in-ws').textContent = selectedWs;
  }
  main.dataset['mode'] = selectedWs === null ? 'home' : 'dock';
}

function render(): void {
  renderSidebar();
  renderMain();
}

function applyPalette(name: string): void {
  applyThemeTokens(resolvePalette(name));
  applyChromeTokens(name);
  const home = document.querySelector<MuxHome>('mux-home');
  if (home) home.palette = name;
}

function boot(): void {
  // Palette picker — proves the view is built from --mux-*/--chrome-* tokens
  // and not from the mockup's hard-coded hexes.
  const sel = qs<HTMLSelectElement>('#palette');
  for (const name of Object.keys(PALETTES)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = 'tokyo-night';
  sel.addEventListener('change', () => applyPalette(sel.value));
  applyPalette('tokyo-night');

  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-scenario]')) {
    btn.addEventListener('click', () => {
      scenario = (btn.dataset['scenario'] ?? 'busy') as ScenarioId;
      selectedWs = null;
      for (const b of document.querySelectorAll<HTMLButtonElement>('[data-scenario]')) {
        b.classList.toggle('on', b === btn);
      }
      render();
    });
  }

  qs<MuxStartCard>('mux-start-card').addEventListener('start-click', () => {
    selectedWs = null;
    render();
  });

  const home = qs<MuxHome>('mux-home');
  home.addEventListener('home-dismiss', () => {
    // Esc from home in the demo has nowhere to go; say so instead of doing
    // nothing silently.
    flash('Esc — in the app this returns you to the dock.');
  });
  home.addEventListener('home-open', (e) => {
    const d = (e as CustomEvent<{ workspaceId: string; paneId: number }>).detail;
    flash(`Open ${d.workspaceId} · pane ${d.paneId} — in the app this focuses that pane.`);
  });
  home.addEventListener('home-action', (e) => {
    const d = (e as CustomEvent<{ action: string; sessionId: string }>).detail;
    flash(`"${d.action}" on ${d.sessionId} — STUB. Needs \`muxterm pane send\` (issue #47).`);
  });

  // The REAL installHomeToggle, not a look-alike — so the chord you try in the
  // preview is the code path the app runs, capture phase and all.
  //
  // The probe input next to it exists to prove the other half of the contract:
  // a BARE backtick must still type a backtick. Type in it. If ` inserts a
  // character and ctrl+` does not, the interception is correctly scoped.
  installHomeToggle('ctrl+`', () => {
    selectedWs = selectedWs === null ? WORKSPACES[0]!.id : null;
    render();
    flash(selectedWs === null ? 'ctrl+` — home' : `ctrl+\` — workspace ${selectedWs}`);
  });

  render();
}

let flashTimer: number | undefined;
function flash(msg: string): void {
  const el = qs<HTMLElement>('#flash');
  el.textContent = msg;
  el.classList.add('on');
  if (flashTimer !== undefined) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => el.classList.remove('on'), 3200);
}

boot();
