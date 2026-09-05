/**
 * mobile-demo.ts — the mobile-navigation MOCKUP.
 *
 * NO DAEMON, NO WEBSOCKET, NO <mux-app>. This entry renders the nine states
 * of docs/designs/2026-09-05-mobile-navigation-design.md against fixtures, so
 * the drawer, the sheet, the two pane-picker variants and the D7 tile grid can
 * be TAPPED on a real phone before any of them is built for real.
 *
 * What is real here, and what is a mock:
 *
 *   REAL   <mux-home>, <mux-start-card>, the theme tokens, and the whole
 *          preview pipeline (tileFromLines -> renderTile at a 5x8 cell). What
 *          you look at is what those components actually do at 390px.
 *   MOCK   the nav bar, the drawer chrome, the pane sheet and the terminal
 *          behind them. <mux-sidebar> is bound to the sessiond store and
 *          cannot run backend-free, so the drawer here reproduces its layout
 *          rather than mounting it. The design's claim is that the drawer IS
 *          <mux-sidebar> in a different container; this mockup exists to test
 *          whether that container is right, not to prove the claim.
 *
 * Responsive by design, and it is the same page either way:
 *
 *   >= 900px   a CONTACT SHEET — all nine states side by side in phone
 *              frames, live and interactive, for review on a desktop.
 *   <  900px   FULL-BLEED — one state filling the viewport with a floating
 *              chip bar to switch, for review with a thumb.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE D7 STATES DO NOT MOUNT <mux-home>  (states 6, 8, 9)
 *
 * States 5 and 7 mount the REAL <mux-home>, because they show what it already
 * does. States 6, 8 and 9 show what D7 PROPOSES it should do, and the
 * component cannot be made to do that from outside. Both cheaper routes were
 * tried against the built page in Chromium first, and both failed measurably:
 *
 *   A. Set a custom property on the host and let the shadow styles pick it
 *      up. There is no property to set. Walking every rule in mux-home's
 *      adopted sheet, the only var() anywhere near the geometry is `.home`'s
 *      `max-width: calc(896px + 2 * var(--s-6))` — and --s-6 is the global
 *      spacing token, so bending it to move the page measure would move every
 *      pad in the component too. `.tiles`' track is the literal
 *      `repeat(auto-fill, 218px)`; computed style reads back "218px". There
 *      is no hook, and adding one is a change to a production file.
 *
 *   B. Append a CSSStyleSheet to the shadow root via adoptedStyleSheets and
 *      restate the grid. This half-works, and the half that fails is the
 *      important half. Injecting
 *          .tiles { grid-template-columns: repeat(1, 1fr) }
 *      moved the computed track from 218px to 342px — and the canvas inside
 *      it stayed exactly 200px, because tile WIDTH in mux-home is not CSS: it
 *      is `tileForSession()` at a fixed TILE_COLS = 40, and renderTile()
 *      writes `canvas.style.width = cols * 5` on every paint. Setting the
 *      canvas to 600px from outside and then triggering one Lit update put it
 *      straight back to 200px, because `updated()` -> `_paintTiles()` runs on
 *      every render. Route B therefore shows a full-width tile box with a
 *      40-column terminal marooned in it — which is not D7, it is an argument
 *      against D7 drawn by accident.
 *
 * So: route C. The tile grid below is a standalone surface that reuses the
 * REAL tileFromLines() -> renderTile() pipeline at the REAL 5x8 PREVIEW_CELL
 * and the real tokens, and restates only mux-home's tile CHROME (see the .d7
 * block in demo-mobile/index.html, whose class names are mux-home's own so
 * the two can be diffed by name). Nothing in web/src/components or
 * web/src/lib is touched.
 *
 * The one production-file change D7 needs and this mockup stands in for:
 * TILE_COLS/TILE_ROWS become parameters of `tileLinesFor()` in home-tile.ts,
 * and `.tiles` becomes `repeat(var(--tile-cols), 1fr)` in mux-home.ts.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Build:  npx vite build --config vite.mobile-demo.config.ts   (from web/)
 * Serve:  any static server rooted at web/dist-mobile-demo/
 */

import '../components/mux-home.js';
import '../components/mux-start-card.js';
import { NEEDS_GLYPH } from '../components/mux-start-card.js';
import type { MuxHome } from '../components/mux-home.js';
import {
  groupFor,
  HOME_GROUPS,
  needsInputByWorkspace,
  needsInputCount,
  type SessionState,
} from '../lib/session-state.js';
import { TILE_COLS, TILE_ROWS } from '../lib/home-tile.js';
import {
  applyChromeTokens,
  applyThemeTokens,
  paletteAnsiArray,
  resolvePalette,
  PALETTES,
} from '../lib/theme.js';
import { tileFromLines, type PreviewTile } from '../lib/preview-tile.js';
import { renderTile, fontReady } from '../lib/preview-canvas.js';
import { PREVIEW_CELL } from '../lib/fonts.js';
import { Ellipsis, Menu, Mic, Plus, X } from 'lucide';
import type { IconNode } from 'lucide';

// The preview @font-face lives in demo-mobile/index.html, NOT here — injecting
// it from this module is too late: <mux-home> upgrades when the import above is
// evaluated and probes document.fonts immediately, so a rule added in boot()
// loses the race and every tile falls back to text. See the comment there.

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Preview tile height, in cells. 13 is preview-store's `full` mode, so a
 * drawer card is the same window onto a pane that the desktop sidebar shows.
 */
const PREVIEW_ROWS = 13;

/**
 * Column clamp, mirroring mux-sidebar.ts. Below 24 the crop stops being
 * readable; above 80 there is nothing more to show, because the daemon's
 * canonical push is 80 columns wide. Card width buys COLUMNS, never scale —
 * a wider card renders more terminal at the same crisp 5x8 cell.
 */
const PREVIEW_MIN_COLS = 24;
const PREVIEW_MAX_COLS = 80;

/** The one breakpoint this page has: contact sheet above it, phone below. */
const CONTACT_SHEET_MIN_WIDTH = 900;

/** DESIGN.md: U+25CF, prepended to a label with a 4px gap, in --mux-bell. */
const BELL_DOT = '●';
/** The current-pane mark in the sheet's fixed 24px check gutter. */
const CHECK_MARK = '✓';

// ---------------------------------------------------------------------------
// Fixtures — a real dev's machine, on a Tuesday
// ---------------------------------------------------------------------------

interface MockPane {
  id: number;
  title: string;
  /** Unacknowledged bell. Renders the dot; does not change the pane's group. */
  pending?: boolean;
}

/**
 * Panes of the attached workspace. SIX of them, deliberately: today's dropdown
 * has no max-height and no scroll container, so the bug the sheet fixes only
 * shows up when the list is longer than the sheet is tall.
 */
const PROJECT_PANES: MockPane[] = [
  { id: 1, title: 'build' },
  { id: 2, title: 'server' },
  { id: 3, title: 'logs', pending: true },
  { id: 4, title: 'test-watch' },
  { id: 5, title: 'psql' },
  { id: 6, title: 'shell' },
];

/** The pane the breadcrumb names and the sheet checks. */
const CURRENT_PANE = PROJECT_PANES[0] as MockPane;

/** One line of fixture terminal output, with the ANSI index it renders in. */
interface Line {
  text: string;
  /** ANSI palette index 0..15. Absent = default foreground. */
  ansi?: number;
}

interface MockWorkspace {
  id: string;
  /** Exactly PREVIEW_ROWS lines of plausible output for the preview canvas. */
  lines: Line[];
}

const WORKSPACES: MockWorkspace[] = [
  {
    id: 'project',
    lines: [
      { text: '$ npm run build', ansi: 4 },
      { text: '' },
      { text: '> muxterm-web@0.0.1 build', ansi: 8 },
      { text: '> tsc --noEmit && vite build', ansi: 8 },
      { text: '' },
      { text: 'vite v6.0.0 building for production...' },
      { text: '412 modules transformed.', ansi: 2 },
      { text: 'dist/index.html            1.24 kB', ansi: 8 },
      { text: 'dist/assets/index.css     18.91 kB', ansi: 8 },
      { text: 'dist/assets/index.js     486.33 kB', ansi: 8 },
      { text: 'built in 3.41s', ansi: 2 },
      { text: '' },
      { text: '$ ', ansi: 4 },
    ],
  },
  {
    id: 'notes',
    lines: [
      { text: '  1 # mobile navigation', ansi: 6 },
      { text: '  2' },
      { text: '  3 ## the finding' },
      { text: '  4 on a phone you cannot reach' },
      { text: '  5 home at all. the sidebar is' },
      { text: '  6 gated on isWide, and a phone' },
      { text: '  7 has no keyboard chord.' },
      { text: '  8' },
      { text: '  9 ## three surfaces' },
      { text: ' 10 - drawer   left, full height' },
      { text: ' 11 - sheet    bottom, panes' },
      { text: ' 12 - launcher bottom, menu' },
      { text: '"NOTES.md" 42L, 1.6K', ansi: 3 },
    ],
  },
  {
    id: 'infra',
    lines: [
      { text: '$ journalctl -u caddy -f', ansi: 4 },
      { text: 'caddy: serving initial config' },
      { text: 'caddy: certificate obtained', ansi: 2 },
      { text: 'caddy: GET  /             200  1.4ms', ansi: 8 },
      { text: 'caddy: GET  /assets/i.js  200  0.9ms', ansi: 8 },
      { text: 'caddy: GET  /ws           101  0.6ms', ansi: 8 },
      { text: 'caddy: WARN tls handshake error', ansi: 3 },
      { text: 'caddy:      remote 10.0.0.14:52918', ansi: 3 },
      { text: 'caddy: GET  /             200  1.1ms', ansi: 8 },
      { text: '' },
      { text: '$ sudo systemctl reload caddy', ansi: 4 },
      { text: '[sudo] password for ken:', ansi: 5 },
      { text: '' },
    ],
  },
  {
    id: 'scratch',
    // Nine blank lines, then four of content: tileFromLines anchors on the
    // BOTTOM, so an idle shell reads as an idle shell rather than an error.
    lines: [
      { text: '' },
      { text: '' },
      { text: '' },
      { text: '' },
      { text: '' },
      { text: '' },
      { text: '' },
      { text: '' },
      { text: '' },
      { text: '$ cd /tmp/scratch', ansi: 4 },
      { text: '$ ls', ansi: 4 },
      { text: 'notes.txt  probe.py' },
      { text: '$ ', ansi: 4 },
    ],
  },
];

const WORKSPACE_BY_ID = new Map(WORKSPACES.map((w) => [w.id, w]));

/** The workspace the mock app is attached to — the one that paints live. */
const ACTIVE_WS = 'project';

/**
 * The fleet, for <mux-home> AND for every needs-input number on screen.
 *
 * ONE source of truth. The hamburger badge, the Start card count, the group
 * headings and the workspace bell dots are all derived from this list below;
 * nothing carries a hand-written count that could drift away from the rows it
 * claims to describe.
 *
 * WHY IT IS THIS BIG. Fifteen sessions, and the size is load-bearing rather
 * than decorative.
 *
 * D7's column table tops out at five, and a fixture whose largest group held
 * three could never show a full five-wide row — so state 9 could show the CAP
 * but not what the cap BUYS, and its empty tracks read as exactly the dead
 * gutter D7 exists to kill. `Running` therefore holds seven: five across plus
 * two wrapped at the cap, four plus three at 1200px. `Needs input` holds five,
 * which fills the widest row exactly and leaves no remainder — the other case
 * worth being able to look at.
 *
 * The `doing` and `doneMeans` strings are deliberately of DIFFERENT lengths,
 * roughly 30 to 75 characters. A tile wraps them at (terminal columns - 2), so
 * a fixture of uniform-length text would wrap identically at 43, 53 and 68
 * columns and the whole point of measuring the track would be invisible. The
 * spread is what makes "a wider tile truncates less" something you can see
 * rather than something this file asserts.
 *
 * Pane ids agree with the workspaces that claim them: `project` uses exactly
 * the six panes PROJECT_PANES declares, so the pane sheet in state 3 and the
 * tiles in state 6 cannot disagree about what is running where.
 */
const SESSIONS: SessionState[] = [
  // ── Needs input: one in `project`, two in `infra` ──────────────────────
  {
    sessionId: 'mx-log-rotate',
    paneId: 3,
    workspaceId: 'project',
    harness: 'amplifier',
    project: '/home/ken/workspace/muxterm',
    name: 'log-rotate',
    mode: 'autonomous',
    state: 'blocked',
    waitingFor: 'permission prompt',
    doing: 'wants to delete 2.1 GB under /var/log',
    updatedAt: 0,
  },
  {
    sessionId: 'mx-caddy-tls',
    paneId: 9,
    workspaceId: 'infra',
    harness: 'claude',
    project: '/home/ken/infra',
    name: 'caddy-tls',
    mode: 'interactive',
    state: 'blocked',
    waitingFor: 'input needed',
    doing: 'which hostname should the cert cover?',
    updatedAt: 0,
  },
  {
    sessionId: 'mx-fleet-upgrade',
    paneId: 10,
    workspaceId: 'infra',
    harness: 'codex',
    project: '/home/ken/infra',
    name: 'fleet-upgrade',
    mode: 'autonomous',
    state: 'stopped',
    doing: 'loop ran out of turns at host 4 of 7',
    doneMeans: 'every host on 0.9.2 and answering /healthz',
    updatedAt: 0,
  },
  {
    // 'sandbox request' — the third of the five WaitingFor values, and the one
    // with the longest ask. At 43 columns it wraps to three lines and the
    // "> waiting for you..." footer falls off the bottom; at 68 it does not.
    // That difference is the D7 argument, drawn by a real row.
    sessionId: 'mx-secrets-rotate',
    paneId: 13,
    workspaceId: 'infra',
    harness: 'claude',
    project: '/home/ken/infra',
    name: 'secrets-rotate',
    mode: 'autonomous',
    state: 'blocked',
    waitingFor: 'sandbox request',
    doing: 'wants to read /etc/muxterm/secrets.env, outside the workspace root',
    updatedAt: 0,
  },
  {
    // The second autonomous+stopped row, in a THIRD workspace: the drawer
    // needs more than one bell to show that the dots are per-workspace rather
    // than a single global alarm.
    sessionId: 'mx-vale-lint',
    paneId: 8,
    workspaceId: 'notes',
    harness: 'opencode',
    project: '/home/ken/workspace/muxterm',
    name: 'vale-lint',
    mode: 'autonomous',
    state: 'stopped',
    doing: 'style pass stopped at 3 of 11 files, vale exited 2',
    doneMeans: 'every doc under docs/ clean against the style guide',
    updatedAt: 0,
  },
  // ── Running ───────────────────────────────────────────────────────────
  {
    sessionId: 'mx-drawer-popover',
    paneId: 1,
    workspaceId: 'project',
    harness: 'amplifier',
    project: '/home/ken/workspace/muxterm',
    name: 'drawer-popover',
    mode: 'autonomous',
    state: 'working',
    doing: 'moving the sidebar into a popover container',
    doneMeans: 'drawer opens at 390px; check:fast clean',
    updatedAt: 0,
  },
  {
    sessionId: 'mx-safe-area',
    paneId: 4,
    workspaceId: 'project',
    harness: 'claude',
    project: '/home/ken/workspace/muxterm',
    name: 'safe-area',
    mode: 'autonomous',
    state: 'working',
    doing: 'env(safe-area-inset-*) on every anchored edge',
    updatedAt: 0,
  },
  {
    sessionId: 'mx-nightly-smoke',
    paneId: 11,
    workspaceId: 'infra',
    // Not a harness muxterm has heard of — a shell script reporting through
    // `muxterm session report --harness ci-runner`. Neutral badge, real row.
    harness: 'ci-runner',
    project: '/home/ken/infra',
    name: 'nightly-smoke',
    mode: 'autonomous',
    state: 'working',
    doing: 'stage 3 of 6 — reconnect matrix',
    doneMeans: 'all six stages green',
    updatedAt: 0,
  },
  {
    // The SHORT row. Its one line fits at every width in the table, which is
    // what makes the long rows next to it legible as a wrap rather than as
    // "the tiles are just like that".
    sessionId: 'mx-dns-cutover',
    paneId: 12,
    workspaceId: 'infra',
    harness: 'claude',
    project: '/home/ken/infra',
    name: 'dns-cutover',
    mode: 'interactive',
    state: 'working',
    doing: 'lowering TTLs ahead of the move',
    updatedAt: 0,
  },
  {
    sessionId: 'mx-db-index-audit',
    paneId: 5,
    workspaceId: 'project',
    harness: 'codex',
    project: '/home/ken/workspace/muxterm',
    name: 'db-index-audit',
    mode: 'autonomous',
    state: 'working',
    doing: 'EXPLAIN on the 40 slowest queries in the last 24h',
    doneMeans: 'every seq scan over 10k rows indexed or explained',
    updatedAt: 0,
  },
  {
    sessionId: 'mx-flake-hunt',
    paneId: 6,
    workspaceId: 'project',
    harness: 'amplifier',
    project: '/home/ken/workspace/muxterm',
    name: 'flake-hunt',
    mode: 'autonomous',
    state: 'working',
    doing: 're-running the reconnect matrix, run 14 of 50',
    doneMeans: '50 clean runs in a row, or a reproducer',
    updatedAt: 0,
  },
  {
    sessionId: 'mx-graph-server',
    paneId: 14,
    workspaceId: 'infra',
    harness: 'amplifier',
    project: '/home/ken/infra',
    name: 'graph-server',
    mode: 'autonomous',
    state: 'working',
    doing: 'porting the preview push to the new per-pane fan-out',
    doneMeans: 'six clients, one encode per frame',
    updatedAt: 0,
  },
  // ── Completed ─────────────────────────────────────────────────────────
  {
    sessionId: 'mx-pane-sheet',
    paneId: 2,
    workspaceId: 'project',
    harness: 'codex',
    project: '/home/ken/workspace/muxterm',
    name: 'pane-sheet',
    mode: 'autonomous',
    state: 'done',
    doing: '6 files, +341 -216',
    pr: 63,
    updatedAt: 0,
  },
  {
    // interactive + stopped is a session RESTING, not one that broke. It must
    // never surface as needing input — that distinction is the whole reason
    // `mode` is on the wire, so the fixture exercises it.
    sessionId: 'mx-design-notes',
    paneId: 7,
    workspaceId: 'notes',
    harness: 'claude',
    project: '/home/ken/workspace/muxterm',
    name: 'design-notes',
    mode: 'interactive',
    state: 'stopped',
    doing: 'turn ended, waiting for you — normal, not an alarm',
    updatedAt: 0,
  },
  {
    // The only `failed` row, and the fixture had none until the grid grew:
    // markClass has an m-fail branch and .tl gets a red border for it, and
    // NOTHING on screen was exercising either.
    //
    // It also guards the other half of the mode contract. `failed` is a
    // VERDICT — the lane finished and the answer was no — so it belongs in
    // Completed and must NOT ring the bell, even though it is autonomous and
    // has stopped producing. `scratch` therefore stays the bell-free workspace
    // in the drawer while still having something in it.
    sessionId: 'mx-scratch-probe',
    paneId: 15,
    workspaceId: 'scratch',
    harness: 'codex',
    project: '/tmp/scratch',
    name: 'scratch-probe',
    mode: 'autonomous',
    state: 'failed',
    doing: 'goal evaluator said no: 3 of 7 checks still red after four tries',
    updatedAt: 0,
  },
];

// ── The derived numbers. Four places on screen, one computation. ──────────
const NEEDS_TOTAL = needsInputCount(SESSIONS);
const NEEDS_BY_WS = needsInputByWorkspace(SESSIONS);

/** Sessions per home group, for the group headings. Same predicate, one place. */
const GROUP_SIZES = new Map(
  HOME_GROUPS.map((g) => [g, SESSIONS.filter((s) => groupFor(s) === g).length]),
);

/**
 * Panes per workspace, for the drawer chip. DERIVED, never declared.
 *
 * It was declared, and it had already drifted: `infra` claimed two panes while
 * three sessions named it as their home, and the fixture grew to six. A
 * workspace cannot have fewer panes than it has sessions — every session runs
 * IN a pane — so that floor is the number, counted off the sessions themselves.
 *
 * The attached workspace is the exception, and for the opposite reason: it has
 * an explicit pane list (PROJECT_PANES) that the pane sheet in state 3 renders
 * row by row, so its chip must agree with that list rather than with a count.
 * The two must never disagree in front of the person reviewing this.
 */
const PANES_BY_WS = new Map<string, number>(
  WORKSPACES.map((w) => {
    if (w.id === ACTIVE_WS) return [w.id, PROJECT_PANES.length];
    const ids = new Set(
      SESSIONS.filter((s) => s.workspaceId === w.id).map((s) => s.paneId),
    );
    return [w.id, Math.max(1, ids.size)];
  }),
);

/** The terminal behind everything. Segments so it can carry ANSI colour. */
interface Seg {
  t: string;
  ansi?: number;
}

const TERM_SCREEN: Seg[][] = [
  [{ t: '$ ', ansi: 4 }, { t: 'npm run build' }],
  [{ t: '' }],
  [{ t: '> muxterm-web@0.0.1 build', ansi: 8 }],
  [{ t: '> tsc --noEmit && vite build', ansi: 8 }],
  [{ t: '' }],
  [{ t: 'vite v6.0.0 ', ansi: 5 }, { t: 'building for production...' }],
  [{ t: '✓ ', ansi: 2 }, { t: '412 modules transformed.' }],
  [{ t: 'dist/index.html            1.24 kB', ansi: 8 }],
  [{ t: 'dist/assets/index-Ck3f2a.css     18.91 kB', ansi: 8 }],
  [{ t: 'dist/assets/index-Bq9x71.js     486.33 kB', ansi: 8 }],
  [{ t: '✓ built in 3.41s', ansi: 2 }],
  [{ t: '' }],
  [{ t: '$ ', ansi: 4 }, { t: 'go build ./... && ./bin/muxterm --dev' }],
  [{ t: 'listening on ', ansi: 8 }, { t: 'http://127.0.0.1:8311', ansi: 6 }],
  [{ t: 'sessiond ready — socket /run/user/1000/muxterm', ansi: 8 }],
  [{ t: '' }],
  [{ t: '$ ', ansi: 4 }],
];

// ---------------------------------------------------------------------------
// Tiny DOM helpers
//
// Plain DOM, not Lit: these are mockup chrome, not components, and keeping
// them out of a shadow root means the page's one .lucide-icon rule covers
// every icon instead of each element needing its own copy.
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function qs<T extends Element>(sel: string): T {
  const found = document.querySelector<T>(sel);
  if (!found) throw new Error(`mobile-demo: missing ${sel}`);
  return found;
}

type AttrMap = Record<string, string | number | undefined>;

/**
 * A lucide icon as inline SVG markup.
 *
 * lib/icons.ts returns a Lit TemplateResult, which this file has no way to
 * render; the icon DATA is the same, so this rebuilds the same <svg> from it.
 * Input is lucide's own static tables — there is no user data in here.
 */
function svgMarkup(nodes: IconNode, size: number): string {
  const body = nodes
    .map(([tag, attrs]) => {
      const pairs = Object.entries(attrs as AttrMap)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}="${String(v)}"`)
        .join(' ');
      return `<${tag} ${pairs} />`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"` +
    ` viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"` +
    ` stroke-linecap="round" stroke-linejoin="round" class="lucide-icon"` +
    ` aria-hidden="true">${body}</svg>`
  );
}

function iconButton(cls: string, nodes: IconNode, label: string, size = 18): HTMLButtonElement {
  const btn = el('button', cls);
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.innerHTML = svgMarkup(nodes, size);
  return btn;
}

/**
 * The in-frame A/B toggle: one label, N pill buttons, one of them pressed.
 *
 * Shared by state 2 (where "+ New workspace" pins) and state 6 (tile rows),
 * because both are open questions in the design doc rendered as both answers
 * rather than argued. One control, so the two cannot drift into looking like
 * different KINDS of question when they are the same kind.
 *
 * Returns a `sync` the caller invokes after the state changes, rather than
 * reading the state itself: the owner of the value is the caller, and a
 * toggle that kept its own copy would be a second source of truth for
 * something already stored elsewhere.
 */
function abToggle<T>(
  label: string,
  options: { value: T; label: string }[],
  read: () => T,
  pick: (value: T) => void,
): { el: HTMLElement; sync: () => void } {
  const seg = el('div', 'abseg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', label);
  seg.appendChild(el('span', '', label));

  const buttons: { value: T; btn: HTMLButtonElement }[] = [];
  for (const o of options) {
    const btn = el('button', '', o.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (read() === o.value) return;
      pick(o.value);
    });
    seg.appendChild(btn);
    buttons.push({ value: o.value, btn });
  }

  const sync = (): void => {
    for (const b of buttons) {
      b.btn.setAttribute('aria-pressed', b.value === read() ? 'true' : 'false');
    }
  };
  sync();

  return { el: seg, sync };
}

/** The shared 56px action row: "+ New workspace" and "+ New pane". */
function rowButton(label: string, accent: boolean): HTMLButtonElement {
  const btn = el('button', `rowbtn${accent ? ' accent' : ''}`);
  btn.type = 'button';
  btn.innerHTML = svgMarkup(Plus, 18);
  btn.appendChild(el('span', '', label));
  return btn;
}

let uid = 0;
const nextId = (prefix: string): string => `${prefix}-${++uid}`;

// ---------------------------------------------------------------------------
// Previews — the real pipeline, at the real cell
// ---------------------------------------------------------------------------

/** null = still probing, false = the bitmap font is unusable. */
let previewFontOk: boolean | null = null;

/**
 * A workspace's tile, coloured.
 *
 * tileFromLines() is the real sanitiser and the real crop; it produces a
 * MONOCHROME tile, because the wire format it was written for is monochrome.
 * The fixture declares an ANSI index per line, and this re-attaches it to the
 * tile's own `fg` field so renderTile draws it the way the attached workspace
 * draws its live tile. Without it, "the active card is full-colour" — the
 * asymmetry that IS the drawer's visual hierarchy — has nothing to show.
 */
function tileForWorkspace(ws: MockWorkspace, cols: number, rows: number): PreviewTile {
  const tile = tileFromLines(
    ws.lines.map((l) => l.text),
    cols,
    rows,
  );
  // Mirror tileFromLines' anchoring: it takes the LAST `rows` source lines and
  // pads the shortfall at the TOP, so the colour has to travel the same way or
  // it lands on the wrong row.
  const start = Math.max(0, ws.lines.length - rows);
  const taken = ws.lines.slice(start, start + rows);
  const pad = rows - taken.length;

  const fg: Int8Array[] = [];
  for (let y = 0; y < rows; y++) {
    const row = new Int8Array(cols);
    const src = taken[y - pad];
    row.fill(src && src.ansi !== undefined ? src.ansi : -1);
    fg.push(row);
  }
  return { ...tile, fg };
}

/**
 * Paint every preview canvas currently in the document.
 *
 * Columns come from the MEASURED card, never a constant — a wider drawer must
 * reveal more terminal, not bigger pixels. A canvas inside a closed popover
 * measures 0 and is skipped; the surface's `toggle` handler calls back here.
 */
function repaintPreviews(): void {
  const palette = resolvePalette(paletteName);
  const ansi = paletteAnsiArray(palette);

  for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas.ws-canvas')) {
    const ws = WORKSPACE_BY_ID.get(canvas.dataset['ws'] ?? '');
    const screen = canvas.parentElement;
    if (!ws || !screen) continue;

    const placeholder = screen.querySelector<HTMLElement>('.ws-ph');
    if (previewFontOk === false) {
      // A 5x8 grid drawn in fallback monospace at 8px is unreadable garbage,
      // so a failed font is exactly as good as previews being switched off.
      if (placeholder) placeholder.textContent = 'no preview font';
      continue;
    }
    if (previewFontOk !== true) continue;

    const inner = screen.clientWidth;
    if (inner <= 0) continue; // drawer closed — nothing to measure yet

    const cols = Math.min(
      PREVIEW_MAX_COLS,
      Math.max(PREVIEW_MIN_COLS, Math.floor(inner / PREVIEW_CELL.w)),
    );
    renderTile(canvas, tileForWorkspace(ws, cols, PREVIEW_ROWS), {
      palette: ansi,
      fg: palette.foreground,
      bg: palette.background,
    });
    placeholder?.remove();
  }
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

interface NavBar {
  bar: HTMLElement;
  /** Opens the workspace drawer. Carries the needs-input badge (D4). */
  hamburger: HTMLElement;
  /** Opens the pane sheet. Absent in the <select> variant. */
  crumb: HTMLElement;
}

/**
 * The nav bar.
 *
 *     ☰³      project › ●build ▾        🎤    ⋯
 *
 * The `+` new-pane button is deliberately GONE: it moved into the pane sheet,
 * next to the panes it is about to join, which buys back the width the
 * breadcrumb needs.
 */
function buildNavBar(variant: 'crumb' | 'select'): NavBar {
  const bar = el('div', 'navbar');

  const hamburger = iconButton(
    'nav-btn',
    Menu,
    NEEDS_TOTAL > 0
      ? `${NEEDS_TOTAL} sessions need input. Open workspaces.`
      : 'Open workspaces',
    20,
  );
  // D4: at zero the badge is ABSENT, not a grey zero — mux-start-card.ts:68's
  // rule, applied to the bar.
  if (NEEDS_TOTAL > 0) {
    hamburger.appendChild(el('span', 'needs-badge', `${NEEDS_GLYPH}${NEEDS_TOTAL}`));
  }
  bar.appendChild(hamburger);

  let crumb: HTMLElement;
  if (variant === 'crumb') {
    const btn = el('button', 'crumb');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Panes in ${ACTIVE_WS}`);
    btn.appendChild(el('span', 'ws', ACTIVE_WS));
    btn.appendChild(el('span', 'sep', '›'));
    btn.appendChild(el('span', 'bell', BELL_DOT));
    btn.appendChild(el('span', 'pane', CURRENT_PANE.title));
    btn.appendChild(el('span', 'caret', '▾'));
    bar.appendChild(btn);
    crumb = btn;
  } else {
    // Variant B. A REAL <select>, not a look-alike: tapping it has to open the
    // genuine OS sheet, which is the entire question this state asks.
    const wrap = el('div', 'crumb-wrap');
    wrap.appendChild(el('span', 'ws', ACTIVE_WS));
    wrap.appendChild(el('span', 'sep', '›'));
    const sel = el('select', 'crumb-select');
    sel.setAttribute('aria-label', `Panes in ${ACTIVE_WS}`);
    for (const pane of PROJECT_PANES) {
      const opt = el('option');
      opt.value = String(pane.id);
      // Options are STRINGS. No bell dot, no ✕, no pane count — that is the
      // trade, and the caption under the bar says so out loud.
      opt.textContent = pane.title;
      sel.appendChild(opt);
    }
    sel.value = String(CURRENT_PANE.id);
    wrap.appendChild(sel);
    bar.appendChild(wrap);
    crumb = sel;
  }

  bar.appendChild(iconButton('nav-btn', Mic, 'Voice input', 18));
  bar.appendChild(iconButton('nav-btn', Ellipsis, 'More', 18));

  return { bar, hamburger, crumb };
}

/** The terminal behind everything. Dimmed whenever a surface is open. */
function buildTerminal(dim: boolean): HTMLElement {
  const term = el('div', `term${dim ? ' dim' : ''}`);
  term.setAttribute('aria-hidden', 'true');

  TERM_SCREEN.forEach((line, i) => {
    const row = el('div');
    for (const seg of line) {
      const span = el('span', '', seg.t);
      if (seg.ansi !== undefined) span.style.color = `var(--mux-ansi-${seg.ansi})`;
      row.appendChild(span);
    }
    if (i === TERM_SCREEN.length - 1) row.appendChild(el('span', 'cur', ' '));
    if (row.childNodes.length === 0) row.textContent = '\u00a0';
    term.appendChild(row);
  });

  return term;
}

/** A caption that lives INSIDE the frame, because it is about that screen. */
function buildNote(text: string): HTMLElement {
  return el('div', 'note', text);
}

// ---------------------------------------------------------------------------
// Surface 1 — the workspace drawer
// ---------------------------------------------------------------------------

function buildWorkspaceCard(ws: MockWorkspace): HTMLElement {
  const active = ws.id === ACTIVE_WS;
  const pending = NEEDS_BY_WS.get(ws.id) ?? 0;

  const card = el('div', `ws-card${active ? ' active' : ''}`);

  const head = el('div', 'ws-head');
  const open = el('button', 'ws-open');
  open.type = 'button';
  open.setAttribute('aria-label', `Switch to workspace ${ws.id}`);
  if (pending > 0) open.appendChild(el('span', 'ws-bell', BELL_DOT));
  open.appendChild(el('span', 'ws-name', ws.id));
  const panes = PANES_BY_WS.get(ws.id) ?? 0;
  open.appendChild(el('span', 'ws-panes', `${panes} pane${panes === 1 ? '' : 's'}`));
  head.appendChild(open);
  head.appendChild(iconButton('ws-close', X, `Close workspace ${ws.id}`, 16));
  card.appendChild(head);

  const screen = el('div', 'ws-screen');
  // Reserve the whole tile box from the first paint, so nothing shifts when a
  // canvas lands.
  screen.style.height = `${PREVIEW_ROWS * PREVIEW_CELL.h}px`;
  const canvas = document.createElement('canvas');
  canvas.className = 'ws-canvas';
  canvas.dataset['ws'] = ws.id;
  screen.appendChild(canvas);
  screen.appendChild(el('div', 'ws-ph', '· · ·'));
  card.appendChild(screen);

  return card;
}

/**
 * Where "+ New workspace" pins. Open question 1 of the design doc.
 *
 * Module-level, so flipping it survives the rebuild a palette change causes
 * and so the contact sheet and the phone agree about which variant is on
 * screen. Defaults to `last` — the current design loads, and the toggle is
 * how you go and look at the alternative.
 */
type NewWsPos = 'first' | 'last';
let newWsPos: NewWsPos = 'last';

/**
 * The drawer: the sidebar, in a different container.
 *
 * Start card pinned at the top (it is the home button, and it is the same
 * control that means "home" on desktop), the workspace cards scrolling in the
 * middle, and "+ New workspace" pinned OUTSIDE that scroller — at whichever
 * end `newWsPos` currently says.
 *
 * Both slots exist in the DOM at all times and the button MOVES between them.
 * Rebuilding the drawer per variant would work too, but this way the thing
 * being compared is provably the same element in a different place rather
 * than two elements that are meant to match.
 */
function buildDrawer(): { drawer: HTMLElement; syncPos: () => void } {
  const drawer = el('div', 'drawer');
  drawer.setAttribute('aria-label', 'Workspaces');

  const start = document.createElement('mux-start-card');
  start.count = NEEDS_TOTAL;
  start.spread = NEEDS_BY_WS.size;
  // Home is not the thing on screen in this state — the terminal is.
  start.active = false;
  // The hint chip carries the desktop chord. A phone has none, so it is
  // suppressed rather than shown as a key nobody can press.
  start.hint = '';
  drawer.appendChild(start);

  // Directly under the Start card and ABOVE the "Workspaces" heading: the
  // action belongs to the list it creates into, so it sits outside the label
  // for that list rather than between the label and its first row.
  const slotFirst = el('div', 'drawer-act first');
  drawer.appendChild(slotFirst);

  drawer.appendChild(el('div', 'sb-heading', 'Workspaces'));

  const list = el('div', 'ws-list');
  for (const ws of WORKSPACES) list.appendChild(buildWorkspaceCard(ws));
  drawer.appendChild(list);

  const slotLast = el('div', 'drawer-act last');
  drawer.appendChild(slotLast);

  const button = rowButton('New workspace', false);
  const syncPos = (): void => {
    (newWsPos === 'first' ? slotFirst : slotLast).appendChild(button);
  };
  syncPos();

  return { drawer, syncPos };
}

// ---------------------------------------------------------------------------
// Surface 2 — the pane sheet
// ---------------------------------------------------------------------------

function buildPaneRow(pane: MockPane): HTMLElement {
  const row = el('div', 'pane-row');

  const pick = el('button', 'pane-pick');
  pick.type = 'button';
  pick.setAttribute('aria-label', `Switch to pane ${pane.title}`);
  pick.appendChild(
    el('span', 'pane-check', pane.id === CURRENT_PANE.id ? CHECK_MARK : ''),
  );
  if (pane.pending) pick.appendChild(el('span', 'pane-bell', BELL_DOT));
  pick.appendChild(el('span', 'pane-title', pane.title));
  row.appendChild(pick);

  // The middle grid column is the gap: a thumb aiming at "switch to logs" must
  // not land on the ✕ that kills it.
  row.appendChild(el('span'));
  row.appendChild(iconButton('pane-close', X, `Close pane ${pane.title}`, 16));

  return row;
}

/**
 * The pane sheet — variant A, approved.
 *
 * Two blocks, and the split is the point:
 *
 *   .sheet-head   grab handle, heading, "+ New pane".  PINNED.
 *   ═══════════   heavier divider: the scroll edge
 *   .pane-list    the panes.  SCROLLS.
 *
 * "+ New pane" was the last row of the scrolling list. As a last row its
 * position depended on how many panes existed and where the list happened to
 * be scrolled — at six panes on a short phone it sat below the fold, which
 * makes it the one control in the sheet you cannot build muscle memory for.
 * First and pinned, it is always in the same place.
 *
 * The cost is real and the design doc states it: the top of a bottom sheet is
 * the farthest part of it from a thumb. At max-height 60dvh that edge still
 * lands around 40% down the screen — a shorter reach than the title-bar `+`
 * it replaces.
 */
function buildPaneSheet(): HTMLElement {
  const sheet = el('div', 'sheet');
  sheet.setAttribute('aria-label', `Panes in ${ACTIVE_WS}`);

  const head = el('div', 'sheet-head');
  head.appendChild(el('div', 'grab'));
  head.appendChild(el('div', 'sheet-title', `Panes · ${ACTIVE_WS}`));
  head.appendChild(rowButton('New pane', true));
  sheet.appendChild(head);

  const list = el('div', 'pane-list');
  for (const pane of PROJECT_PANES) list.appendChild(buildPaneRow(pane));
  sheet.appendChild(list);

  return sheet;
}

// ---------------------------------------------------------------------------
// Mounting a surface — one markup, two containers
// ---------------------------------------------------------------------------

type SurfaceMode = 'popover' | 'pinned';

/**
 * Attach a surface to a screen.
 *
 * `popover` is the real mechanism from D1: top layer, light dismiss, Escape,
 * one-at-a-time, all for free. It is what the phone gets, and it is the thing
 * being evaluated.
 *
 * `pinned` exists for ONE reason: a popover is promoted to the browser's top
 * layer, which is above the whole page — inside a contact sheet it would
 * escape its phone frame and cover the review. Same element, same styles, held
 * open inside the frame instead. The design is not forked; only its container
 * is.
 */
function mountSurface(
  screen: HTMLElement,
  surface: HTMLElement,
  trigger: HTMLElement,
  mode: SurfaceMode,
): void {
  if (mode === 'pinned') {
    surface.classList.add('pinned');
    screen.appendChild(el('div', 'scrim'));
    screen.appendChild(surface);
    return;
  }

  const id = nextId('surface');
  surface.id = id;
  surface.setAttribute('popover', 'auto');
  trigger.setAttribute('popovertarget', id);
  surface.addEventListener('toggle', () => repaintPreviews());
  screen.appendChild(surface);

  // The state IS the surface, so it opens on arrival. Dismissing it (tap
  // outside, Escape) and re-opening from the hamburger is the point: that
  // round trip is the behaviour the Popover API is being trusted with.
  const api = surface as HTMLElement & { showPopover?: () => void };
  requestAnimationFrame(() => {
    try {
      api.showPopover?.();
    } catch {
      /* already open, or no Popover API — the trigger still works */
    }
  });
}

// ---------------------------------------------------------------------------
// The home states — the REAL component
// ---------------------------------------------------------------------------

type HomeViewName = 'tiles' | 'cards';

/**
 * <mux-home> keeps its Tiles/Cards choice in a private field seeded from
 * localStorage and exposes no property for it. Rather than reach into the
 * component's internals — or copy its private storage key here, where it would
 * rot in silence — the mockup presses the component's OWN segmented control,
 * which is what a user does. If that control ever moves, the frame falls back
 * to the persisted default instead of breaking.
 */
function forceHomeView(home: MuxHome, view: HomeViewName): void {
  void home.updateComplete.then(() => {
    const buttons = home.shadowRoot?.querySelectorAll<HTMLButtonElement>('.seg button');
    if (!buttons) return;
    for (const btn of buttons) {
      const label = (btn.textContent ?? '').trim().toLowerCase();
      if (label.includes(view) && btn.getAttribute('aria-pressed') !== 'true') btn.click();
    }
  });
}

function buildHomeStage(view: HomeViewName): HTMLElement {
  const stage = el('div', 'stage');
  const home = document.createElement('mux-home');
  home.sessions = SESSIONS;
  home.fixture = true;
  home.palette = paletteName;
  home.workspaces = WORKSPACES.map((w) => ({ id: w.id, name: w.id }));
  stage.appendChild(home);
  forceHomeView(home, view);
  return stage;
}

// ---------------------------------------------------------------------------
// D7 — the width-driven tile grid
//
// Two derivations, in this order, and neither of them is a constant:
//
//   1. COLUMN COUNT comes from the frame's own measured width, through the
//      table below. Measured, because the contact sheet renders several
//      differently-sized frames on one page and each has to pick for itself;
//      a media query would ask the browser window and every frame would agree
//      with every other one, proving nothing. A hardcoded count per state
//      would be worse still — the mockup would assert the answer it exists to
//      demonstrate.
//
//   2. TERMINAL COLUMNS come from the resulting track's measured pixel width,
//      divided by the 5px cell and clamped to the sidebar's 24..80 band. This
//      is D1 of 2026-09-02-sidebar-live-preview-design.md applied to home:
//      width buys COLUMNS, never scale. A wider tile shows more characters
//      per line at the same crisp cell; the canvas is never stretched.
// ---------------------------------------------------------------------------

/**
 * D7's column table, keyed on the frame's measured width in CSS pixels.
 *
 * Highest band first — `colsForWidth` returns the first one it clears.
 */
const D7_COLUMNS: readonly { min: number; cols: number }[] = [
  { min: 1400, cols: 5 }, // cap
  { min: 1100, cols: 4 },
  { min: 840, cols: 3 }, // phone landscape (844) lands here
  { min: 600, cols: 2 },
  { min: 0, cols: 1 }, // portrait phone — the tile spans the width
];

function colsForWidth(px: number): number {
  for (const band of D7_COLUMNS) if (px >= band.min) return band.cols;
  return 1;
}

/**
 * The tile's own chrome, per side, mirroring mux-home.ts:184-186 (both values
 * are module-private there, and both are restated in the .d7 CSS block).
 */
const TILE_PAD = 8;
const TILE_BORDER = 1;

/** Terminal columns a track that wide can carry, at the real 5px cell. */
function termColsForInner(innerPx: number): number {
  return Math.min(
    PREVIEW_MAX_COLS,
    Math.max(PREVIEW_MIN_COLS, Math.floor(innerPx / PREVIEW_CELL.w)),
  );
}

/**
 * Rows the tile would have if it kept TODAY's aspect instead of its content.
 *
 * The cell is square-ish and fixed, so locking the pixel aspect ratio is the
 * same thing as locking the cols:rows ratio: 40:9 today, hence 68 columns ->
 * 15 rows. D7 rejects this in favour of a content-derived 9; state 6 renders
 * it anyway, because the blank rows it produces ARE the argument and a claim
 * nobody can see is a claim nobody can check.
 */
function aspectRows(cols: number): number {
  return Math.max(1, Math.round((cols * TILE_ROWS) / TILE_COLS));
}

// ── The tile's lines, at an arbitrary width ────────────────────────────────
//
// home-tile.ts wraps at the module constant TILE_COLS and pads to TILE_ROWS.
// This is that function with the two as parameters — which is exactly the
// production change D7 asks for, staged here because home-tile.ts is a
// production file and this is still a mockup. Behaviour is otherwise
// identical, deliberately: same greedy wrap, same hard-split for an
// over-long word, same bottom padding, same ASCII-only vocabulary.

/** Body indent, mirroring how a terminal transcript reads. home-tile.ts:35. */
const IND = '  ';

/** Greedy word wrap to `width`, prefixed with `indent`. Never returns ''. */
function wrapAt(text: string, width: number, indent: string): string[] {
  const budget = Math.max(1, width - indent.length);
  const words = text.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [];

  const out: string[] = [];
  let line = '';
  for (const word of words) {
    if (word.length > budget) {
      if (line !== '') {
        out.push(indent + line);
        line = '';
      }
      let rest = word;
      while (rest.length > budget) {
        out.push(indent + rest.slice(0, budget));
        rest = rest.slice(budget);
      }
      line = rest;
      continue;
    }
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= budget) {
      line += ` ${word}`;
    } else {
      out.push(indent + line);
      line = word;
    }
  }
  if (line !== '') out.push(indent + line);
  return out;
}

/** A session's tile text at `cols` x `rows`. Padded at the BOTTOM. */
function tileLinesAt(s: SessionState, cols: number, rows: number): string[] {
  const out: string[] = [];

  switch (groupFor(s)) {
    case 'Needs input':
      out.push(`? ${s.waitingFor ?? 'input needed'}`);
      out.push('');
      out.push(...wrapAt(s.doing ?? 'waiting for a decision', cols, IND));
      out.push('');
      out.push(`${IND}> waiting for you...`);
      break;

    case 'Running':
      out.push('* running');
      out.push('');
      out.push(...wrapAt(s.doing ?? '', cols, IND));
      if (s.doneMeans) {
        out.push('');
        out.push(...wrapAt(`done means: ${s.doneMeans}`, cols, IND));
      }
      break;

    case 'Completed': {
      const head = s.state === 'failed' ? 'x failed' : `. ${s.state}`;
      out.push(s.pr && s.pr > 0 ? `${head} - PR #${s.pr}` : head);
      out.push('');
      out.push(...wrapAt(s.doing ?? '', cols, IND));
      break;
    }
  }

  const trimmed = out.slice(0, rows);
  while (trimmed.length < rows) trimmed.push('');
  return trimmed;
}

// ── Tile chrome ───────────────────────────────────────────────────────────

/** mux-home.ts:162 markClass, re-derived: it is module-private there. */
function markClassFor(s: SessionState): string {
  const g = groupFor(s);
  if (g === 'Needs input') return 'm-need';
  if (g === 'Running') return 'm-work';
  if (s.state === 'failed') return 'm-fail';
  if (s.state === 'done') return 'm-done';
  return 'm-none';
}

/**
 * The two buttons a tile offers. mux-home's `_tile` takes `choicesFor(s)`,
 * drops `open` and keeps the first two; `choicesFor` is module-private, so
 * this is that table with `open` already removed.
 */
function tileActions(s: SessionState): { label: string; primary?: boolean }[] {
  switch (s.waitingFor) {
    case 'permission prompt':
      return [{ label: 'Approve', primary: true }, { label: 'Deny' }];
    case 'sandbox request':
    case 'worker request':
      return [{ label: 'Allow', primary: true }, { label: 'Deny' }];
    case 'input needed':
      return [{ label: 'Reply\u2026', primary: true }];
    default:
      return [];
  }
}

/** One tile, in the DOM shape of mux-home's `_tile()`. */
interface D7Tile {
  s: SessionState;
  /** The grid item. Its offsetWidth IS the track, so it is what gets measured. */
  tl: HTMLElement;
  tbody: HTMLElement;
  canvas: HTMLCanvasElement;
  fallback: HTMLPreElement;
}

function buildD7Tile(s: SessionState): D7Tile {
  const needs = groupFor(s) === 'Needs input';
  const tl = el(
    'div',
    `tl ${needs ? 'need' : ''} ${s.state === 'failed' ? 'fail' : ''}`.trim(),
  );

  const th = el('div', 'th');
  th.appendChild(el('span', 'name', s.name));
  th.appendChild(el('span', `mark ${markClassFor(s)}`, NEEDS_GLYPH));
  tl.appendChild(th);

  const tbody = el('div', 'tbody');
  const canvas = document.createElement('canvas');
  const fallback = el('pre', 'tbtext');
  fallback.hidden = true;
  tbody.appendChild(canvas);
  tbody.appendChild(fallback);
  tl.appendChild(tbody);

  const tf = el('div', 'meta tf');
  tf.appendChild(el('span', '', `${s.workspaceId} \u00b7 p${s.paneId}`));
  // Every fixture carries updatedAt: 0, so mux-home's own `age() || s.mode`
  // resolves to the mode here too. Same expression, same answer.
  tf.appendChild(el('span', '', s.mode));
  tl.appendChild(tf);

  const actions = needs ? tileActions(s).slice(0, 2) : [];
  if (actions.length > 0) {
    const ta = el('div', 'ta');
    for (const a of actions) {
      const btn = el('button', `btn${a.primary ? ' pri' : ''}`, a.label);
      btn.type = 'button';
      ta.appendChild(btn);
    }
    tl.appendChild(ta);
  }

  return { s, tl, tbody, canvas, fallback };
}

// ── A measured frame ──────────────────────────────────────────────────────

type RowMode = 'content' | 'aspect';

/** What one `applyD7` pass worked out. All of it read back, none of it assumed. */
interface D7Measure {
  frameW: number;
  cols: number;
  track: number;
  inner: number;
  termCols: number;
  rows: number;
  /** Worst trailing run of blank rows across the frame's tiles. */
  blank: number;
  /** Tiles in the fullest FIRST row, counted off the laid-out grid. */
  rowFill: number;
  /** The group that filled it, and how many tiles it holds in total. */
  rowGroup: string;
  rowGroupN: number;
}

/**
 * How many tiles actually sit in a grid's first row, and it is COUNTED rather
 * than assumed to be `min(members, cols)`.
 *
 * The point of state 9 is to show a genuinely full row at the 5-column cap. A
 * count derived from the same arithmetic that set `--tile-cols` would agree
 * with itself no matter what the browser did with the tracks; comparing
 * offsetTop asks the layout instead, so a grid that silently wrapped early
 * would show up as a smaller number rather than as a confident wrong one.
 */
function firstRowCount(grid: HTMLElement): number {
  const tiles = [...grid.children] as HTMLElement[];
  const first = tiles[0];
  if (!first) return 0;
  const top = first.offsetTop;
  return tiles.filter((t) => t.offsetTop === top).length;
}

interface D7Frame {
  /** Readout key. Also what the in-frame caption calls itself. */
  label: string;
  /** The stand-in viewport. Its offsetWidth drives the column count. */
  root: HTMLElement;
  /** Carries --tile-cols. */
  page: HTMLElement;
  /** The measured caption, rewritten on every pass. */
  caption: HTMLElement;
  tiles: D7Tile[];
  /** One entry per group grid, so row occupancy can be MEASURED off the DOM. */
  grids: { group: string; el: HTMLElement; n: number }[];
  rowMode: RowMode;
  /** Skips a pass that would compute exactly what is already on screen. */
  lastKey: string;
  scheduled: boolean;
  ro?: ResizeObserver;
  /** Repaints the rows A/B control after a toggle. */
  syncSeg?: () => void;
}

/** Every frame currently in the document. Rebuilt with the page. */
const d7Frames: D7Frame[] = [];

/** The latest measurement per frame, for the contact sheet's readout. */
const d7Readout = new Map<string, D7Measure>();

/**
 * Work out what this frame should be, applying --tile-cols on the way because
 * the track cannot be measured until the grid has been told how many there
 * are. Every number here comes from the laid-out DOM.
 *
 * offsetWidth, never getBoundingClientRect(): the former is the element's
 * LAYOUT width and the latter is its painted size. They are the same today,
 * and they would stop being the same the moment anyone wrapped a frame in a
 * transform to make it fit — at which point the whole readout would quietly
 * start reporting the scale factor instead of the design. The price is that
 * offsetWidth is a rounded integer, so a 1fr track of 262.656px reads back as
 * 263 and the derived canvas can overhang its track by a fraction of a pixel;
 * `.tl` clips, and half a pixel is not worth a wrong measurement semantic.
 */
/** Geometry only. The blank-row and row-fill counts need a painted frame. */
type D7Geometry = Omit<D7Measure, 'blank' | 'rowFill' | 'rowGroup' | 'rowGroupN'>;

function deriveD7(frame: D7Frame, rows: number | null): D7Geometry {
  const frameW = frame.root.offsetWidth;
  const cols = colsForWidth(frameW);
  frame.page.style.setProperty('--tile-cols', String(cols));

  const first = frame.tiles[0];
  const track = first ? first.tl.offsetWidth : 0;
  const inner = Math.max(0, track - 2 * TILE_BORDER - 2 * TILE_PAD);
  const termCols = termColsForInner(inner);

  return {
    frameW,
    cols,
    track,
    inner,
    termCols,
    rows: rows ?? (frame.rowMode === 'aspect' ? aspectRows(termCols) : TILE_ROWS),
  };
}

/** Reserve the body box before any pixels exist, exactly as mux-home does. */
function applyBodyHeight(frame: D7Frame, rows: number): void {
  const h = `${rows * PREVIEW_CELL.h + 2 * TILE_PAD}px`;
  for (const t of frame.tiles) t.tbody.style.height = h;
}

function paintD7(frame: D7Frame, m: D7Measure): number {
  const palette = resolvePalette(paletteName);
  const ansi = paletteAnsiArray(palette);
  let worstBlank = 0;

  for (const t of frame.tiles) {
    const lines = tileLinesAt(t.s, m.termCols, m.rows);

    let trailing = 0;
    for (let i = lines.length - 1; i >= 0 && (lines[i] ?? '').trim() === ''; i--) trailing++;
    if (trailing > worstBlank) worstBlank = trailing;

    if (previewFontOk === false) {
      // A 5x8 grid in fallback monospace is unreadable garbage, so show the
      // same lines as plain text — mux-home.ts:1305 makes the same choice.
      t.canvas.hidden = true;
      t.fallback.hidden = false;
      t.fallback.textContent = lines.join('\n');
      continue;
    }
    t.canvas.hidden = false;
    t.fallback.hidden = true;

    const g = groupFor(t.s);
    const ink =
      g === 'Needs input'
        ? palette.yellow
        : g === 'Running'
          ? palette.cyan
          : t.s.state === 'failed'
            ? palette.red
            : t.s.state === 'done'
              ? palette.green
              : palette.white;

    renderTile(t.canvas, tileFromLines(lines, m.termCols, m.rows), {
      palette: ansi,
      fg: ink,
      bg: palette.background,
      mono: true,
    });
  }

  return worstBlank;
}

function captionD7(frame: D7Frame, m: D7Measure): void {
  const cap = frame.caption;
  cap.textContent = '';
  cap.appendChild(
    el(
      'b',
      '',
      `${m.cols} col${m.cols === 1 ? '' : 's'} \u00b7 ${m.termCols} terminal cols \u00b7 ` +
        `${m.inner}px track`,
    ),
  );
  cap.appendChild(
    document.createTextNode(
      ` \u2014 measured, not declared: ${m.frameW}px frame \u2192 ${m.cols} \u00d7 1fr ` +
        `\u2192 ${m.track}px each \u2212 ${2 * TILE_PAD + 2 * TILE_BORDER}px chrome ` +
        `= ${m.inner}px \u00f7 ${PREVIEW_CELL.w}px cell = ${m.termCols} cols, ` +
        `${m.rows} rows` +
        (frame.rowMode === 'aspect'
          ? `. ASPECT-LOCKED at today's ${TILE_COLS}:${TILE_ROWS} \u2014 up to ` +
            `${m.blank} of ${m.rows} rows come out blank, which is why D7 does not do this.`
          : `. Rows are content-derived (TILE_ROWS), not aspect-locked \u2014 up to ` +
            `${m.blank} of ${m.rows} spare.`),
    ),
  );

  // Row occupancy, counted off the laid-out grid.
  //
  // This used to explain a shortfall: the fixture's largest group held three,
  // so at four and five columns the fullest row left empty tracks and the
  // caption had to say why they were not the dead gutter D7 exists to kill.
  // The fixture now carries enough sessions to fill the widest row in the
  // table, so the explanation is replaced by the measurement it was standing
  // in for — and if a row ever fails to fill again, this says so rather than
  // going quiet.
  const wrapped = m.rowGroupN - m.rowFill;
  cap.appendChild(
    document.createTextNode(
      ` Fullest row: ${m.rowFill} of ${m.cols} track${m.cols === 1 ? '' : 's'}` +
        ` (${m.rowGroup}, ${m.rowGroupN} tiles` +
        (wrapped > 0 ? ` \u2014 ${m.rowFill} across plus ${wrapped} wrapped).` : ').') +
        (m.rowFill < m.cols
          ? ` No group here has ${m.cols} sessions, so the row does not fill;` +
            ` the empty tracks are the grid keeping its shape, not width going to waste.`
          : ''),
    ),
  );
}

function applyD7(frame: D7Frame): void {
  if (frame.tiles.length === 0) return;

  const probe = deriveD7(frame, null);
  const key = `${probe.frameW}|${frame.rowMode}`;
  if (key === frame.lastKey) return;
  frame.lastKey = key;

  // Writing the body height can add or remove this frame's vertical
  // scrollbar, which narrows the track, which changes the derivation that
  // produced the height. Settle it rather than paint a stale frame; two
  // passes cover every case here and the third is the belt.
  let m = probe;
  for (let pass = 0; pass < 3; pass++) {
    applyBodyHeight(frame, m.rows);
    const again = deriveD7(frame, null);
    if (again.termCols === m.termCols && again.rows === m.rows) {
      m = again;
      break;
    }
    m = again;
  }

  const full: D7Measure = { ...m, blank: 0, rowFill: 0, rowGroup: '', rowGroupN: 0 };
  full.blank = paintD7(frame, full);

  // After the paint, so the grids have their final heights and offsetTop is
  // the settled one. The fullest row wins; ties go to the bigger group, which
  // is the one whose wrap is worth looking at.
  for (const g of frame.grids) {
    const n = firstRowCount(g.el);
    if (n > full.rowFill || (n === full.rowFill && g.n > full.rowGroupN)) {
      full.rowFill = n;
      full.rowGroup = g.group;
      full.rowGroupN = g.n;
    }
  }

  captionD7(frame, full);
  d7Readout.set(frame.label, full);
  renderReadout();
}

function scheduleD7(frame: D7Frame): void {
  if (frame.scheduled) return;
  frame.scheduled = true;
  requestAnimationFrame(() => {
    frame.scheduled = false;
    applyD7(frame);
  });
}

/** Force every frame to recompute — palette change, font arrival, A/B flip. */
function repaintD7(): void {
  for (const frame of d7Frames) {
    frame.lastKey = '';
    applyD7(frame);
  }
}

/** Tear the observers down before the page is rebuilt under them. */
function resetD7(): void {
  for (const frame of d7Frames) frame.ro?.disconnect();
  d7Frames.length = 0;
  d7Readout.clear();
}

// ── Building one ──────────────────────────────────────────────────────────

interface TileAppOptions {
  /** Readout key, e.g. '6 · portrait 390'. */
  label: string;
  /** The phone frames carry the nav bar; the desktop panels do not. */
  navbar?: boolean;
  /** The rows A/B control. State 6 only — one place to make the point. */
  rowsToggle?: boolean;
  /** An honesty line above the caption, for simulated widths. */
  note?: string;
}

/**
 * The rows A/B control.
 *
 * Not a settings toggle: it is the evidence for a design decision. D7 says an
 * aspect-locked 68-column tile would be 15 rows tall with most of them blank.
 * Flip this and count them.
 */
function buildRowsToggle(frame: D7Frame): HTMLElement {
  const t = abToggle<RowMode>(
    'rows',
    [
      { value: 'content', label: `${TILE_ROWS} (content)` },
      { value: 'aspect', label: 'aspect-locked' },
    ],
    () => frame.rowMode,
    (mode) => {
      frame.rowMode = mode;
      frame.lastKey = '';
      frame.syncSeg?.();
      applyD7(frame);
    },
  );
  frame.syncSeg = t.sync;
  return t.el;
}

/**
 * Fill a flex-column host with the D7 tile surface.
 *
 * `host` is a `.screen` inside a phone bezel, or a `.d7-panel` standing in for
 * a wider window. Same surface either way — only the box around it differs,
 * which is the entire point of a width-driven layout.
 */
function fillTileApp(host: HTMLElement, o: TileAppOptions): void {
  if (o.navbar) host.appendChild(buildNavBar('crumb').bar);
  if (o.note) host.appendChild(buildNote(o.note));

  const root = el('div', 'd7');
  const page = el('div', 'd7-page');
  root.appendChild(page);

  const frame: D7Frame = {
    label: o.label,
    root,
    page,
    caption: el('div', 'note measure'),
    tiles: [],
    grids: [],
    rowMode: 'content',
    lastKey: '',
    scheduled: false,
  };

  // Grouped exactly as mux-home groups: three sections, in HOME_GROUPS order,
  // each with its own grid. Empty groups are omitted rather than shown as a
  // heading over nothing, and the heading carries its count in mux-home's own
  // `${group} · ${n}` form (mux-home.ts:1439) — the third place the fixture's
  // one grouping predicate has to show up and agree.
  for (const group of HOME_GROUPS) {
    const members = SESSIONS.filter((s) => groupFor(s) === group);
    if (members.length === 0) continue;
    page.appendChild(el('div', 'd7-h', `${group} \u00b7 ${GROUP_SIZES.get(group) ?? 0}`));
    const grid = el('div', 'tiles');
    for (const s of members) {
      const tile = buildD7Tile(s);
      frame.tiles.push(tile);
      grid.appendChild(tile.tl);
    }
    page.appendChild(grid);
    frame.grids.push({ group, el: grid, n: members.length });
  }

  if (o.rowsToggle) host.appendChild(buildRowsToggle(frame));
  host.appendChild(frame.caption);
  host.appendChild(root);

  d7Frames.push(frame);
  if (typeof ResizeObserver === 'undefined') {
    // No observer: measure once on the next frame and live with it. Every
    // browser this mockup targets has one; this is not a silent fallback.
    requestAnimationFrame(() => applyD7(frame));
    return;
  }
  frame.ro = new ResizeObserver(() => scheduleD7(frame));
  frame.ro.observe(root);
}

/**
 * A panel standing in for a window this page is not being viewed in.
 *
 * `width` is the panel's GENUINE layout width — the column logic measures it
 * and gets a real answer. When the reviewing viewport is narrower, the strip
 * around it scrolls; it is never scaled down to fit, because a transform
 * would report a shrunken width to the measurement this whole state exists to
 * prove, and would blur the 5px cells while it did so.
 */
function buildSimPanel(width: number, o: TileAppOptions): HTMLElement {
  const panel = el('div', 'd7-panel');
  panel.style.width = `${width}px`;
  fillTileApp(panel, o);
  return panel;
}

function buildSimStrip(...panels: HTMLElement[]): HTMLElement {
  const strip = el('div', 'd7-strip');
  for (const p of panels) strip.appendChild(p);
  return strip;
}

// ---------------------------------------------------------------------------
// The nine states
// ---------------------------------------------------------------------------

/**
 * How the contact sheet frames a state.
 *
 *   phone            390x844 portrait bezel (the default)
 *   phone-landscape  844x390 — the SAME phone, rotated, notch on the left
 *   panels           plain rounded panels; `build` returns the strip itself
 */
type FrameKind = 'phone' | 'phone-landscape' | 'panels';

interface MockState {
  id: string;
  n: number;
  /** Chip label in the full-bleed switcher. */
  label: string;
  /** Caption headline in the contact sheet. */
  title: string;
  /** Caption body in the contact sheet. */
  caption: string;
  /** Default 'phone'. */
  frame?: FrameKind;
  build(mode: SurfaceMode): HTMLElement;
}

function screenEl(): HTMLElement {
  return el('div', 'screen');
}

const STATES: MockState[] = [
  {
    id: 'closed',
    n: 1,
    label: 'closed',
    title: 'Nav bar / closed',
    caption:
      'The resting state. 44px of chrome plus the safe-area inset, and nothing else. ' +
      'It is here to show what the navigation model COSTS when you are not using it.',
    build() {
      const s = screenEl();
      s.appendChild(buildNavBar('crumb').bar);
      s.appendChild(buildTerminal(false));
      return s;
    },
  },
  {
    id: 'drawer',
    n: 2,
    label: 'drawer',
    title: 'Workspace drawer',
    caption:
      'min(86vw, 340px), full height, over a scrim, with the terminal still visible and ' +
      'dimmed on the right — the drawer is NON-modal by design and that has to read ' +
      'visually. Start card on top is the home button. Previews are the real pipeline: ' +
      'card width buys columns, not scale. ' +
      'OPEN QUESTION 1, as an A/B: the pane sheet just moved “+ New pane” to first-and-' +
      'pinned, so should “+ New workspace” follow it? Consistency argues first; reach and ' +
      'desktop parity argue last. It is pinned outside the scroller either way — only the ' +
      'end changes. Defaults to last, which is today’s design.',
    build(mode) {
      const s = screenEl();
      const { drawer, syncPos } = buildDrawer();

      const toggle = abToggle<NewWsPos>(
        '+ New workspace',
        [
          { value: 'last', label: 'last (today)' },
          { value: 'first', label: 'first' },
        ],
        () => newWsPos,
        (pos) => {
          newWsPos = pos;
          syncPos();
          toggle.sync();
        },
      );
      // Above the nav bar rather than inside the drawer: it is mockup chrome
      // asking a question ABOUT the drawer, and putting it inside the surface
      // under review would make it look like part of what is being reviewed.
      s.appendChild(toggle.el);

      const nav = buildNavBar('crumb');
      s.appendChild(nav.bar);
      s.appendChild(buildTerminal(true));
      mountSurface(s, drawer, nav.hamburger, mode);
      return s;
    },
  },
  {
    id: 'sheet',
    n: 3,
    label: 'sheet',
    title: 'Pane sheet — variant A, APPROVED',
    caption:
      'Bottom sheet, max-height 60dvh, six panes, and the last one is always reachable — ' +
      'today\u2019s dropdown has no max-height at all, which is the bug that hides it. ' +
      'Measured: on this 844-tall frame 60dvh is 506px, the pinned block takes 93px and ' +
      'all six rows fit in the remaining 413px, so nothing scrolls. On a 667-tall phone ' +
      '(SE) the sheet clamps to 400px, the list gets 306px for 342px of rows and scrolls ' +
      'by 36px. The bounded height is doing its job in BOTH cases; only the short phone ' +
      'shows it moving. 56px rows, each ✕ in its own 44×44 box with a gap from the ' +
      'row\u2019s tap surface. ' +
      '“+ New pane” is now the FIRST row and pinned outside the scroller, under a heavier ' +
      'divider that marks the scroll edge without waiting for motion to reveal it. As a ' +
      'last row its position depended on the pane count and the scroll offset — at six ' +
      'panes it sat below the fold, which is the one thing a muscle-memory target cannot ' +
      'do. Scroll the list: the pinned block does not move.',
    build(mode) {
      const s = screenEl();
      const nav = buildNavBar('crumb');
      s.appendChild(nav.bar);
      s.appendChild(buildTerminal(true));
      mountSurface(s, buildPaneSheet(), nav.crumb, mode);
      return s;
    },
  },
  {
    id: 'select',
    n: 4,
    label: 'select',
    title: 'Pane picker — variant B, REJECTED (kept as the record)',
    caption:
      'NOT a live A/B any more. Variant A won on the device; this is kept so the trade is ' +
      'legible rather than forgotten. What it gets for free is real: the genuine OS sheet ' +
      '— the iOS wheel, the Android dialog — correct by construction, zero CSS, and no ' +
      'touch-target bug is possible. What it cannot do is the reason it lost: a <select> ' +
      'option is a STRING, so there is no per-row ✕ to close a pane, no bell dot marking ' +
      'the pane that wants you, and no pane count. Every one of those is a thing the sheet ' +
      'shows and this cannot be made to show at any price.',
    build() {
      const s = screenEl();
      s.appendChild(buildNavBar('select').bar);
      s.appendChild(
        buildNote(
          'REJECTED — kept as the record of the trade. Real OS sheet, but options are ' +
            'strings: no ✕, no bell dot, no pane count.',
        ),
      );
      s.appendChild(buildTerminal(false));
      return s;
    },
  },
  {
    id: 'home-cards',
    n: 5,
    label: 'cards',
    title: 'Home · cards',
    caption:
      'The REAL <mux-home>, laying itself out at 390px, warts included. D7 proposes this ' +
      'as the narrow-width default: a card row is one line and scans faster than a grid ' +
      'that is one column wide.',
    build() {
      const s = screenEl();
      s.appendChild(buildNavBar('crumb').bar);
      s.appendChild(buildHomeStage('cards'));
      return s;
    },
  },
  {
    id: 'home-tiles',
    n: 6,
    label: 'tiles',
    title: 'Home · tiles — portrait, 1 column (D7)',
    caption:
      'D7 applied. One 1fr track, so the tile spans the content width, and the terminal ' +
      'inside it is measured from that track at the same 5px cell — width buys COLUMNS, ' +
      'not scale. Every number in the caption inside the frame is read back off the ' +
      'laid-out DOM. Flip the rows control to see the alternative D7 rejected: locking ' +
      'today\u2019s aspect makes the same tile far taller and pads the difference with blanks.',
    build() {
      const s = screenEl();
      fillTileApp(s, { label: '6 \u00b7 portrait 390', navbar: true, rowsToggle: true });
      return s;
    },
  },
  {
    id: 'home-keyboard',
    n: 7,
    label: 'keyboard',
    title: 'Home · composer focused',
    caption:
      'A 300px block stands in for the on-screen keyboard, so the question "does the ' +
      'sticky composer survive?" can be answered by looking. D8 adds ' +
      'interactive-widget=resizes-content so the real keyboard shrinks the layout ' +
      'viewport exactly like this.',
    build() {
      const s = screenEl();
      s.appendChild(buildNavBar('crumb').bar);
      s.appendChild(
        buildNote(
          'SIMULATION. The grey block below is a 300px keyboard reserve, not a keyboard.',
        ),
      );
      s.appendChild(buildHomeStage('cards'));
      s.appendChild(el('div', 'kbd-reserve', 'on-screen keyboard · 300px'));
      return s;
    },
  },
  {
    id: 'tiles-landscape',
    n: 8,
    label: 'landscape',
    title: 'Home · tiles — landscape 844×390 (D7)',
    frame: 'phone-landscape',
    caption:
      'The same phone, rotated. 844 clears the 840 band, so the SAME code that gave one ' +
      'column at 390 gives three here — nothing in this frame knows which state it is. ' +
      'Note the notch on the short left edge and the page inset that follows it (D9): ' +
      'landscape is the case where a missing safe-area inset actually shows.',
    build(mode) {
      const s = screenEl();
      if (mode === 'pinned') {
        // The bezel around this frame is genuinely 844 wide, so nothing is
        // simulated here and nothing claims to be.
        fillTileApp(s, { label: '8 · landscape 844', navbar: true });
        return s;
      }
      // Full-bleed on a phone that is 390px wide and cannot become 844. The
      // panel keeps its real width and the viewport scrolls over it, so the
      // measurement stays true and the cells stay crisp.
      s.appendChild(
        buildNote(
          'SIMULATED WIDTH. Your screen is not 844px, so this panel is 844px and the ' +
            'view scrolls sideways over it. The panel\u2019s real layout width is what ' +
            'picks the columns — nothing here is scaled and nothing is hardcoded.',
        ),
      );
      const sim = el('div', 'd7-sim');
      sim.appendChild(buildSimStrip(buildSimPanel(844, { label: '8 · landscape 844' })));
      s.appendChild(sim);
      return s;
    },
  },
  {
    id: 'tiles-wide',
    n: 9,
    label: 'wide',
    title: 'Home · tiles — 1200px → 4 cols, 1400px → 5 cols (D7)',
    frame: 'panels',
    caption:
      'The top of the table, and the cap. Two panels on one page, each measuring itself: ' +
      '1200 lands in the 1100–1399 band and 1400 hits the ≥1400 cap. Both show a ' +
      'genuinely FULL row — Running holds seven sessions, so it is 4 across plus 3 ' +
      'wrapped at 1200 and 5 across plus 2 at 1400, and Needs input fills the ' +
      'five-wide row exactly. That is what makes the cap judgeable rather than just ' +
      'stated: a row that never fills cannot tell you whether five is one too many. ' +
      'Plain panels rather than phone bezels, because these are a tablet and a desktop ' +
      'window. Neither is scaled — the strip scrolls if your window cannot hold both, ' +
      'so the tracks stay true and the cells stay at exactly 5px.',
    build(mode) {
      const strip = buildSimStrip(
        buildSimPanel(1200, { label: '9 · wide 1200' }),
        buildSimPanel(1400, { label: '9 · wide 1400' }),
      );
      if (mode === 'pinned') return strip;

      // Full-bleed: the same two panels at the same real widths, inside the
      // phone, scrolled rather than shrunk.
      const s = screenEl();
      s.appendChild(
        buildNote(
          'SIMULATED WIDTHS. These panels are genuinely 1200px and 1400px wide and your ' +
            'screen is not; scroll sideways. The widths are real, so the column counts ' +
            'are real — 4, then 5, each with a full row and a wrapped remainder.',
        ),
      );
      const sim = el('div', 'd7-sim');
      sim.appendChild(strip);
      s.appendChild(sim);
      return s;
    },
  },
];

// ---------------------------------------------------------------------------
// Rendering the shell
// ---------------------------------------------------------------------------

let paletteName = 'tokyo-night';
let currentState = STATES[0].id;

const mql = window.matchMedia(`(min-width: ${CONTACT_SHEET_MIN_WIDTH}px)`);

/**
 * The D7 review instrument: measured frame width -> chosen column count ->
 * derived terminal columns, for every tile state on the page at once.
 *
 * One glance confirms the whole breakpoint table, which is the only way a
 * reader can tell the difference between "the mockup computed 3 columns at
 * 844" and "the mockup was told to show 3 columns in state 8". Each chip also
 * re-checks its own frame against `colsForWidth` and turns red if they
 * disagree — a check that should never fire, and is therefore worth having.
 */
function renderReadout(): void {
  const host = document.querySelector<HTMLElement>('#readout');
  if (!host) return; // full-bleed: the in-frame caption carries the numbers

  host.textContent = '';
  host.appendChild(el('span', '', 'D7 measured:'));

  if (d7Readout.size === 0) {
    host.appendChild(el('span', 'r', 'measuring\u2026'));
    return;
  }

  for (const [label, m] of d7Readout) {
    const expect = colsForWidth(m.frameW);
    const chip = el('span', `r${m.cols === expect ? '' : ' bad'}`);
    chip.appendChild(el('b', '', label));
    chip.appendChild(
      document.createTextNode(
        ` \u00b7 ${m.frameW}px \u2192 `,
      ),
    );
    chip.appendChild(el('i', '', `${m.cols} col${m.cols === 1 ? '' : 's'}`));
    chip.appendChild(
      document.createTextNode(
        ` \u00b7 ${m.track}px track \u2192 ${m.termCols}\u00d7${m.rows} cells` +
          // Row occupancy belongs here as much as the column count: it is the
          // difference between "the cap is 5" and "5 tiles actually sit in a
          // row", which is the thing state 9 is asked to prove.
          ` \u00b7 row ${m.rowFill}/${m.cols}` +
          (m.cols === expect ? '' : ` \u2717 table says ${expect}`),
      ),
    );
    host.appendChild(chip);
  }
}

function buildDeskbar(): HTMLElement {
  const bar = el('header', 'deskbar');
  bar.appendChild(el('span', 'tag', 'MOCKUP — no daemon, no websocket'));
  bar.appendChild(el('h1', '', `mobile navigation · ${STATES.length} states`));

  const label = el('label', '', 'palette ');
  const sel = el('select');
  for (const name of Object.keys(PALETTES)) {
    const opt = el('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = paletteName;
  sel.addEventListener('change', () => applyPalette(sel.value));
  label.appendChild(sel);
  bar.appendChild(label);

  bar.appendChild(
    el('span', '', `narrow the window below ${CONTACT_SHEET_MIN_WIDTH}px for the phone view`),
  );

  // The arithmetic the design promises, stated out loud so it can be checked
  // by eye in one pass: badge == Start card == Needs-input group heading ==
  // sum of the workspace bells.
  //
  // The bell sum walks WORKSPACES rather than NEEDS_BY_WS.values(). Summing
  // the map would agree with itself even if a session named a workspace the
  // drawer never renders — the badge would say 5 and four bells would be on
  // screen, and this check would still print a tick. Counting only what the
  // drawer can actually show closes that.
  const sum = WORKSPACES.reduce((n, w) => n + (NEEDS_BY_WS.get(w.id) ?? 0), 0);
  const group = GROUP_SIZES.get('Needs input') ?? 0;
  const ok = NEEDS_TOTAL === sum && NEEDS_TOTAL === group;
  bar.appendChild(
    el(
      'span',
      `grow ${ok ? 'inv' : ''}`,
      `hamburger ${NEEDS_GLYPH}${NEEDS_TOTAL} = start card ${NEEDS_TOTAL} = ` +
        `group heading ${group} = sum of workspace bells ${sum}` +
        `${ok ? ' ✓' : ' ✗ MISMATCH'} · ${SESSIONS.length} sessions, ` +
        `${HOME_GROUPS.map((g) => `${g} ${GROUP_SIZES.get(g) ?? 0}`).join(' / ')}`,
    ),
  );

  const readout = el('div', 'readout');
  readout.id = 'readout';
  bar.appendChild(readout);

  return bar;
}

function renderContactSheet(app: HTMLElement): void {
  app.appendChild(buildDeskbar());

  const grid = el('div', 'contact');
  for (const state of STATES) {
    const frame = state.frame ?? 'phone';
    const cell = el('figure', `cell frame-${frame}`);

    if (frame === 'panels') {
      // No bezel: the state's own build() returns the panels, because their
      // widths are the subject rather than the container.
      cell.appendChild(state.build('pinned'));
    } else {
      const phone = el('div', `phone${frame === 'phone-landscape' ? ' land' : ''}`);
      phone.appendChild(state.build('pinned'));
      phone.appendChild(el('div', 'notch'));
      cell.appendChild(phone);
    }

    const cap = el('figcaption');
    cap.appendChild(el('b', '', `${state.n} · ${state.title}`));
    cap.appendChild(document.createTextNode(state.caption));
    cell.appendChild(cap);

    grid.appendChild(cell);
  }
  app.appendChild(grid);
}

function renderFullBleed(app: HTMLElement): void {
  const state = STATES.find((s) => s.id === currentState) ?? STATES[0];
  app.appendChild(state.build('popover'));

  const switcher = el('nav', 'switcher');
  switcher.setAttribute('aria-label', 'Mockup state');
  for (const s of STATES) {
    const chip = el('button', `chip${s.id === state.id ? ' on' : ''}`, `${s.n} ${s.label}`);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', s.id === state.id ? 'true' : 'false');
    chip.addEventListener('click', () => {
      currentState = s.id;
      render();
    });
    switcher.appendChild(chip);
  }
  app.appendChild(switcher);
}

function render(): void {
  const app = qs<HTMLElement>('#app');
  // Every <mux-home> grabs focus on connect and the browser scrolls it into
  // view, so a rebuild would otherwise dump the reader at the last frame in
  // the contact sheet. Held and restored around the rebuild; on first render
  // that means the top, which is state 1, which is where a review starts.
  const keepScroll = window.scrollY;
  // The D7 frames observe their own elements; those elements are about to
  // stop existing, so their observers have to go with them.
  resetD7();
  app.textContent = '';

  const wide = mql.matches;
  app.className = wide ? 'mode-sheet' : 'mode-bleed';
  document.body.classList.toggle('bleed', !wide);

  if (wide) renderContactSheet(app);
  else renderFullBleed(app);

  requestAnimationFrame(() => {
    repaintPreviews();
    // The ResizeObserver fires on its own for every frame that just mounted,
    // but only after a layout; this makes the first paint deterministic
    // rather than one frame late.
    repaintD7();
    // <mux-home> takes the keyboard on connect (it is not a terminal, so that
    // is right in the app). Three of them in one contact sheet fight over it;
    // hand focus back to the document and put the page back where it was.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.tagName === 'MUX-HOME') active.blur();
    window.scrollTo(0, keepScroll);
  });
}

function applyPalette(name: string): void {
  paletteName = name;
  applyThemeTokens(resolvePalette(name));
  applyChromeTokens(name);
  // Canvases hold pixels, not tokens, so a palette change has to repaint them
  // — and <mux-home> needs its own `palette` property updated. A full rebuild
  // does both without a second code path.
  render();
}

function boot(): void {
  applyThemeTokens(resolvePalette(paletteName));
  applyChromeTokens(paletteName);

  void fontReady().then((ok) => {
    previewFontOk = ok;
    repaintPreviews();
    // The D7 tiles were drawn before the answer arrived; a `false` has to
    // swap every one of them to the text fallback.
    repaintD7();
  });

  mql.addEventListener('change', () => render());

  render();
}

boot();
