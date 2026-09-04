/**
 * mux-home.ts — the home view.
 *
 * The surface a human lands on to see which sessions want them, before picking
 * a workspace to work in. Takes the whole right side. NO TITLE BAR: the sidebar
 * already says where you are, so content starts at the top edge.
 *
 * Four sections, in this order, with these exact words:
 *   Needs input · Working · Ready for review · Completed
 * They are Claude Code's agent-view group names, inherited deliberately —
 * including the non-1:1 mapping onto session state (an open PR wins; Completed
 * merges done + failed + stopped). `groupFor()` in session-state.ts owns that
 * placement; this file never re-derives it.
 *
 * PRESENTATIONAL. It is handed `sessions` and reports intent through events.
 * It imports no socket, no store, no daemon — which is exactly why the
 * standalone fixture demo can mount this same component with no backend.
 *
 *   home-open      { sessionId, paneId, workspaceId }  Enter / click a tile
 *   home-action    { sessionId, paneId, workspaceId, action }  an ask button
 *   home-dismiss   {}                                   Esc
 */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  HOME_GROUPS,
  groupFor,
  shortProject,
  type HomeGroup,
  type SessionState,
} from '../lib/session-state.js';
import { TILE_COLS, TILE_ROWS, tileForSession, tileLinesFor } from '../lib/home-tile.js';
import { renderTile, fontReady } from '../lib/preview-canvas.js';
import { PREVIEW_CELL } from '../lib/fonts.js';
import { paletteAnsiArray, resolvePalette } from '../lib/theme.js';
import { NEEDS_GLYPH } from './mux-start-card.js';

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------

export type HomeView = 'tiles' | 'cards';

/**
 * localStorage, not the server config.
 *
 * This is a per-eyeball display preference with no server-side meaning, and
 * putting it in config.toml would make it a machine-wide setting that a second
 * browser silently overwrites. Key is namespaced so it cannot collide.
 */
const VIEW_KEY = 'muxterm.home.view';

function loadView(): HomeView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'tiles' ? 'tiles' : 'cards';
  } catch {
    return 'cards'; // private mode / storage disabled: still usable, just not sticky
  }
}

function saveView(v: HomeView): void {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* not sticky; not fatal */
  }
}

// ---------------------------------------------------------------------------
// Asks and actions
// ---------------------------------------------------------------------------

export type HomeAction = 'approve' | 'deny' | 'reply' | 'open';

interface Choice {
  id: HomeAction;
  label: string;
  primary?: boolean;
}

/**
 * The buttons an ask offers.
 *
 * ⚠ These are derived from `waitingFor`, which is a five-value enum. The
 * mockup shows the session's OWN option text ("Wrap" / "Replace") — that needs
 * a `choices[]` field the SessionState contract does not carry today. Until it
 * does, a generic-but-correct verb is the honest answer; inventing the
 * session's options here would put words in its mouth.
 */
function choicesFor(s: SessionState): Choice[] {
  switch (s.waitingFor) {
    case 'permission prompt':
      return [
        { id: 'approve', label: 'Approve', primary: true },
        { id: 'deny', label: 'Deny' },
        { id: 'open', label: 'Open ↗' },
      ];
    case 'sandbox request':
    case 'worker request':
      return [
        { id: 'approve', label: 'Allow', primary: true },
        { id: 'deny', label: 'Deny' },
        { id: 'open', label: 'Open ↗' },
      ];
    case 'input needed':
      return [
        { id: 'reply', label: 'Reply…', primary: true },
        { id: 'open', label: 'Open ↗' },
      ];
    case 'dialog open':
    default:
      return [{ id: 'open', label: 'Open ↗', primary: true }];
  }
}

/** The ask, written out. */
function askFor(s: SessionState): string {
  const doing = s.doing?.trim() ?? '';
  const reason = s.waitingFor ?? 'input needed';
  if (doing === '') return `${reason[0]?.toUpperCase()}${reason.slice(1)}.`;
  return `${reason[0]?.toUpperCase()}${reason.slice(1)} — ${doing}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Coarse age. Returns '' for an unset timestamp rather than "56y ago" — the
 * fixture carries updatedAt: 0, and so will any producer that hasn't wired the
 * clock yet.
 */
function age(updatedAt: number, nowSec: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const d = Math.max(0, Math.floor(nowSec - updatedAt));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

/** State mark class — one vocabulary for tiles, cards and rows. */
function markClass(s: SessionState): string {
  const g = groupFor(s);
  if (g === 'Needs input') return 'm-need';
  if (g === 'Working') return 'm-work';
  if (g === 'Ready for review') return 'm-done';
  return s.state === 'failed' ? 'm-fail' : 'm-none';
}

const TILE_W = TILE_COLS * PREVIEW_CELL.w;
const TILE_H = TILE_ROWS * PREVIEW_CELL.h;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement('mux-home')
export class MuxHome extends LitElement {
  /** Every session, ungrouped. Grouping is this component's job. */
  @property({ attribute: false }) sessions: readonly SessionState[] = [];

  /** Palette name, for the tile renderer. Matches config.theme.palette. */
  @property({ type: String }) palette = 'tokyo-night';

  /**
   * True when these rows came from the committed development fixture rather
   * than a live producer. Shown, not hidden: a home view that looks live but
   * isn't would be worse than no home view.
   */
  @property({ type: Boolean }) fixture = false;

  @state() private _view: HomeView = loadView();
  @state() private _cursor = 0;
  @state() private _peek = false;
  /** null = probing, false = fall back to text, true = draw the bitmap tile. */
  @state() private _fontOk: boolean | null = null;

  private _now = Math.floor(Date.now() / 1000);

  static styles = css`
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    :host {
      display: block;
      position: absolute;
      inset: 0;
      z-index: 5;
      background: var(--chrome-body);
      color: var(--chrome-text-bright);
      overflow: auto;
      font-size: 15px;
      line-height: 1.6;
      outline: none;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      /* Section accents. Named after what they mean, not what colour they are. */
      --need: var(--mux-warn);
      --work: var(--mux-ansi-6);
      --ok: var(--mux-ok);
      --fail: var(--mux-error);
      --goalc: var(--chrome-driver-accent);
      --surface: var(--chrome-bar);
      --mute: var(--chrome-text-dim);
      --dim: var(--mux-fg);
    }

    .home {
      padding: 16px 18px 40px;
      max-width: 1180px;
      outline: none;
    }

    /* ── first section heading + view toggle ─────────────────────────── */
    .sect {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      margin-bottom: 12px;
    }
    .sect .st {
      font-size: 18px;
      font-weight: 640;
      letter-spacing: -0.018em;
    }
    .sect .st .c {
      color: var(--mute);
      font-weight: 500;
    }
    .sect .ss {
      font-family: var(--mono);
      font-size: 10.5px;
      color: var(--mute);
      margin-top: 2px;
    }
    .sect .sp {
      margin-left: auto;
    }

    .seg {
      display: inline-flex;
      border: 1px solid var(--chrome-border);
      border-radius: 7px;
      overflow: hidden;
      background: var(--surface);
    }
    .seg button {
      font-family: var(--mono);
      font-size: 10.5px;
      padding: 5px 11px;
      background: transparent;
      border: none;
      color: var(--mute);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      line-height: 1.4;
    }
    .seg button + button {
      border-left: 1px solid var(--chrome-border);
    }
    .seg button:hover {
      color: var(--chrome-text-bright);
    }
    .seg button.on {
      background: color-mix(in srgb, var(--chrome-accent) 18%, var(--surface));
      color: var(--chrome-accent);
    }

    /* ── subsequent section headings ─────────────────────────────────── */
    .sect2 {
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.11em;
      text-transform: uppercase;
      color: var(--mute);
      margin: 22px 0 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--chrome-border);
      display: flex;
      justify-content: space-between;
    }

    /* ── zero state ──────────────────────────────────────────────────── */
    .allclear {
      display: flex;
      align-items: center;
      gap: 10px;
      border: 1px solid var(--chrome-border);
      border-radius: 8px;
      background: var(--surface);
      padding: 14px 16px;
      color: var(--mute);
      font-size: 13px;
    }
    .allclear .mark {
      font-family: var(--mono);
      font-size: 14px;
      color: var(--mute);
    }

    /* ── CARDS ───────────────────────────────────────────────────────── */
    .cards {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .item {
      border: 1px solid color-mix(in srgb, var(--need) 40%, var(--chrome-border));
      background: color-mix(in srgb, var(--need) 7%, var(--surface));
      border-radius: 8px;
      padding: 11px 13px;
      cursor: pointer;
    }
    .item.on,
    .rowc.on,
    .tl.on {
      outline: 1px solid var(--chrome-accent);
      outline-offset: 1px;
    }
    .ih {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 5px;
      flex-wrap: wrap;
    }
    .iname {
      font-size: 13px;
      font-weight: 640;
      color: var(--chrome-text-bright);
    }
    .iloc {
      margin-left: auto;
      font-family: var(--mono);
      font-size: 9.5px;
      color: var(--mute);
    }
    .iask {
      font-size: 12.5px;
      color: var(--dim);
      line-height: 1.5;
      margin-bottom: 9px;
    }
    .opts {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .mode {
      font-family: var(--mono);
      font-size: 8px;
      padding: 1px 5px;
      border-radius: 2px;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .mode.goal {
      background: color-mix(in srgb, var(--goalc) 18%, transparent);
      color: var(--goalc);
      border: 1px solid color-mix(in srgb, var(--goalc) 45%, transparent);
    }
    .mode.plain {
      background: var(--surface);
      color: var(--mute);
      border: 1px solid var(--chrome-border);
    }

    .btn {
      font-family: var(--mono);
      font-size: 10.5px;
      padding: 4px 10px;
      border-radius: 4px;
      background: var(--surface);
      border: 1px solid var(--chrome-border);
      color: var(--dim);
      cursor: pointer;
    }
    .btn:hover {
      border-color: var(--chrome-accent);
      color: var(--chrome-accent);
    }
    .btn.pri {
      background: color-mix(in srgb, var(--ok) 14%, var(--surface));
      border-color: color-mix(in srgb, var(--ok) 45%, transparent);
      color: var(--ok);
    }
    .btn.pri:hover {
      border-color: var(--ok);
    }

    /* ── ROWS (non-blocking groups, cards mode) ──────────────────────── */
    .rowc {
      display: grid;
      grid-template-columns: 14px 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 7px 11px;
      border: 1px solid var(--chrome-border);
      border-radius: 7px;
      background: var(--surface);
      margin-bottom: 5px;
      cursor: pointer;
    }
    .rowc .rn {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--chrome-text-bright);
      display: flex;
      gap: 7px;
      align-items: center;
      flex-wrap: wrap;
    }
    .rowc .rd {
      font-size: 11px;
      color: var(--mute);
      margin-top: 1px;
    }
    .rowc .rr {
      text-align: right;
      font-family: var(--mono);
      font-size: 9.5px;
      color: var(--mute);
      white-space: nowrap;
    }

    .mark {
      font-size: 11px;
      text-align: center;
      line-height: 1;
    }
    .m-need {
      color: var(--need);
    }
    .m-work {
      color: var(--work);
    }
    .m-done {
      color: var(--ok);
    }
    .m-fail {
      color: var(--fail);
    }
    .m-none {
      color: var(--mute);
    }

    .pr {
      font-family: var(--mono);
      font-size: 9.5px;
      padding: 1px 6px;
      border-radius: 3px;
      border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent);
      color: var(--ok);
      background: color-mix(in srgb, var(--ok) 12%, transparent);
    }

    /* ── TILES ───────────────────────────────────────────────────────── */
    .tiles {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 9px;
    }
    .tl {
      border: 1px solid var(--chrome-border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--mux-bg);
      cursor: pointer;
      display: flex;
      flex-direction: column;
    }
    .tl:hover {
      border-color: var(--chrome-accent);
    }
    .tl.need {
      border-color: color-mix(in srgb, var(--need) 45%, var(--chrome-border));
    }
    .tl.fail {
      border-color: color-mix(in srgb, var(--fail) 45%, var(--chrome-border));
    }
    .tl .th {
      padding: 5px 8px;
      background: var(--surface);
      border-bottom: 1px solid var(--chrome-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      font-size: 10px;
    }
    .tl .tn {
      color: var(--chrome-text-bright);
      font-weight: 600;
      font-size: 10.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tl .tbody {
      padding: 6px 8px;
      height: ${TILE_H + 12}px;
      overflow: hidden;
    }
    .tl canvas {
      display: block;
      image-rendering: pixelated;
    }
    .tl pre.tbtext {
      margin: 0;
      font-family: var(--mono);
      font-size: 8px;
      line-height: 1.6;
      color: var(--mute);
      white-space: pre;
      overflow: hidden;
    }
    .tl .tf {
      padding: 4px 8px;
      border-top: 1px solid var(--chrome-border);
      font-family: var(--mono);
      font-size: 8.5px;
      color: var(--mute);
      display: flex;
      justify-content: space-between;
      gap: 6px;
      margin-top: auto;
    }
    .tl .ta {
      padding: 5px 8px;
      border-top: 1px solid var(--chrome-border);
      display: flex;
      gap: 4px;
    }
    .tl .ta .btn {
      font-size: 9px;
      padding: 3px 7px;
    }

    /* ── peek ────────────────────────────────────────────────────────── */
    .peek {
      border-left: 2px solid var(--chrome-accent);
      background: var(--surface);
      border-radius: 0 6px 6px 0;
      padding: 8px 12px;
      margin: 4px 0 10px;
      font-size: 11.5px;
      color: var(--dim);
    }
    .peek dt {
      font-family: var(--mono);
      font-size: 9px;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--mute);
      margin-top: 5px;
    }
    .peek dd {
      margin: 1px 0 0;
    }
    .peek .path {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--mute);
    }

    /* ── footers ─────────────────────────────────────────────────────── */
    .fixture-note {
      margin-top: 26px;
      padding: 7px 11px;
      border-left: 2px solid var(--mux-warn);
      background: color-mix(in srgb, var(--mux-warn) 7%, transparent);
      font-family: var(--mono);
      font-size: 10px;
      color: var(--mute);
    }
    .keyhelp {
      margin-top: 14px;
      font-family: var(--mono);
      font-size: 9.5px;
      color: var(--mute);
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
    }
    .keyhelp kbd {
      font-family: var(--mono);
      border: 1px solid var(--chrome-border);
      border-bottom-width: 2px;
      border-radius: 3px;
      padding: 0 4px;
      color: var(--dim);
    }
  `;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    this._now = Math.floor(Date.now() / 1000);
    void fontReady().then((ok) => {
      this._fontOk = ok;
    });
    // The home view is not a terminal, so it takes the keyboard. Focus lands on
    // the scroller itself; j/k/Space/Enter/Esc are handled there.
    void this.updateComplete.then(() => this.focusView());
  }

  /** Give the view keyboard focus. Called by the app when home is opened. */
  focusView(): void {
    this.renderRoot.querySelector<HTMLElement>('.home')?.focus();
  }

  override updated(): void {
    this._paintTiles();
  }

  // -------------------------------------------------------------------------
  // Tiles
  // -------------------------------------------------------------------------

  private _paintTiles(): void {
    if (this._view !== 'tiles' || this._fontOk !== true) return;
    const palette = resolvePalette(this.palette);
    const ansi = paletteAnsiArray(palette);
    const byId = new Map(this.sessions.map((s) => [s.sessionId, s]));

    for (const canvas of this.renderRoot.querySelectorAll<HTMLCanvasElement>(
      'canvas[data-session]',
    )) {
      const s = byId.get(canvas.dataset['session'] ?? '');
      if (!s) continue;
      const g = groupFor(s);
      const ink =
        g === 'Needs input'
          ? palette.yellow
          : g === 'Working'
            ? palette.cyan
            : g === 'Ready for review'
              ? palette.green
              : s.state === 'failed'
                ? palette.red
                : palette.white;
      // mono: the stand-in tile has no per-cell colour to honour, and the ink
      // carries the state instead. Swapping in a real per-pane tile means
      // dropping `mono` and passing the tile's own fg/bg through.
      renderTile(canvas, tileForSession(s), {
        palette: ansi,
        fg: ink,
        bg: palette.background,
        mono: true,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  /** Sessions in display order — the j/k traversal order, across sections. */
  private _flat(): SessionState[] {
    const out: SessionState[] = [];
    for (const g of HOME_GROUPS) {
      for (const s of this.sessions) {
        if (groupFor(s) === g) out.push(s);
      }
    }
    return out;
  }

  private _move(delta: number): void {
    const n = this._flat().length;
    if (n === 0) return;
    this._cursor = Math.min(n - 1, Math.max(0, this._cursor + delta));
    void this.updateComplete.then(() => {
      this.renderRoot
        .querySelector<HTMLElement>('.on')
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  private _onKeyDown = (e: KeyboardEvent): void => {
    // Never swallow a chord — ctrl+` toggles home, and the browser's own
    // shortcuts must keep working.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        this._move(1);
        return;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        this._move(-1);
        return;
      case ' ':
        e.preventDefault();
        this._peek = !this._peek;
        return;
      case 'Enter': {
        e.preventDefault();
        const s = this._flat()[this._cursor];
        if (s) this._open(s);
        return;
      }
      case 'Escape':
        e.preventDefault();
        this.dispatchEvent(
          new CustomEvent('home-dismiss', { bubbles: true, composed: true }),
        );
        return;
      default:
        return;
    }
  };

  private _open(s: SessionState): void {
    this.dispatchEvent(
      new CustomEvent('home-open', {
        detail: { sessionId: s.sessionId, paneId: s.paneId, workspaceId: s.workspaceId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _act(e: Event, s: SessionState, action: HomeAction): void {
    e.stopPropagation();
    if (action === 'open') {
      this._open(s);
      return;
    }
    this.dispatchEvent(
      new CustomEvent('home-action', {
        detail: {
          sessionId: s.sessionId,
          paneId: s.paneId,
          workspaceId: s.workspaceId,
          action,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _setView(v: HomeView): void {
    if (this._view === v) return;
    this._view = v;
    saveView(v);
  }

  private _focusIndex(s: SessionState): number {
    return this._flat().findIndex((x) => x.sessionId === s.sessionId);
  }

  private _onItemClick(s: SessionState): void {
    this._cursor = Math.max(0, this._focusIndex(s));
    this._open(s);
  }

  // -------------------------------------------------------------------------
  // Render pieces
  // -------------------------------------------------------------------------

  private _modeChip(s: SessionState): TemplateResult {
    return html`<span class="mode ${s.mode}">${s.mode}</span>`;
  }

  private _loc(s: SessionState): string {
    const a = age(s.updatedAt, this._now);
    const base = `${s.workspaceId} · p${s.paneId}`;
    return a ? `${base} · ${a}` : base;
  }

  private _peekBlock(s: SessionState): TemplateResult | '' {
    if (!this._peek) return '';
    const knows = s.knows ?? [];
    return html`
      <dl class="peek">
        ${s.project
          ? html`<dt>project</dt>
              <dd class="path">${shortProject(s.project)} — ${s.project}</dd>`
          : ''}
        ${s.doneMeans
          ? html`<dt>done means</dt>
              <dd>${s.doneMeans}</dd>`
          : ''}
        ${knows.length > 0
          ? html`<dt>knows (${knows.length})</dt>
              ${knows.map((k) => html`<dd class="path">${k}</dd>`)}`
          : ''}
        ${!s.project && !s.doneMeans && knows.length === 0
          ? html`<dd>Nothing further declared.</dd>`
          : ''}
      </dl>
    `;
  }

  /** A blocking session, written out with its buttons. */
  private _askCard(s: SessionState, focused: boolean): TemplateResult {
    return html`
      <div
        class="item ${focused ? 'on' : ''}"
        @click="${() => this._onItemClick(s)}"
      >
        <div class="ih">
          <span class="iname">${s.name}</span>
          ${this._modeChip(s)}
          <span class="iloc">${this._loc(s)}</span>
        </div>
        <div class="iask">${askFor(s)}</div>
        <div class="opts">
          ${choicesFor(s).map(
            (c) => html`<button
              type="button"
              class="btn ${c.primary ? 'pri' : ''}"
              @click="${(e: Event) => this._act(e, s, c.id)}"
            >${c.label}</button>`,
          )}
        </div>
      </div>
      ${focused ? this._peekBlock(s) : ''}
    `;
  }

  /** A non-blocking session, one compact row. */
  private _row(s: SessionState, focused: boolean): TemplateResult {
    const a = age(s.updatedAt, this._now);
    return html`
      <div class="rowc ${focused ? 'on' : ''}" @click="${() => this._onItemClick(s)}">
        <span class="mark ${markClass(s)}">${NEEDS_GLYPH}</span>
        <div>
          <div class="rn">${s.name} ${this._modeChip(s)}</div>
          <div class="rd">${s.doing ?? ''}</div>
        </div>
        <div class="rr">
          ${s.pr && s.pr > 0
            ? html`<span class="pr">#${s.pr}</span><br />`
            : html`${s.workspaceId} · p${s.paneId}<br />`}
          ${a || '—'}
        </div>
      </div>
      ${focused ? this._peekBlock(s) : ''}
    `;
  }

  /** A session as a terminal-preview thumbnail. */
  private _tile(s: SessionState, focused: boolean): TemplateResult {
    const g = groupFor(s);
    const needs = g === 'Needs input';
    const cls = `tl ${needs ? 'need' : ''} ${s.state === 'failed' ? 'fail' : ''} ${
      focused ? 'on' : ''
    }`;

    let body: TemplateResult;
    if (this._fontOk === false) {
      // The 5x8 bitmap font is unusable. A 5x8 grid in fallback monospace is
      // unreadable garbage, so show the same lines as plain text instead.
      body = html`<pre class="tbtext">${tileLinesFor(s).join('\n')}</pre>`;
    } else {
      // Sized here as well as in renderTile() so the box is right on the very
      // first frame, before any pixels exist.
      body = html`<canvas
        data-session="${s.sessionId}"
        style="width:${TILE_W}px;height:${TILE_H}px"
      ></canvas>`;
    }

    return html`
      <div class="${cls}" @click="${() => this._onItemClick(s)}">
        <div class="th">
          <span class="tn">${s.name}</span>
          <span class="mark ${markClass(s)}">${NEEDS_GLYPH}</span>
        </div>
        <div class="tbody">${body}</div>
        <div class="tf">
          <span>${s.workspaceId} · p${s.paneId}</span>
          <span>${age(s.updatedAt, this._now) || s.mode}</span>
        </div>
        ${needs
          ? html`<div class="ta">
              ${choicesFor(s)
                .filter((c) => c.id !== 'open')
                .slice(0, 2)
                .map(
                  (c) => html`<button
                    type="button"
                    class="btn ${c.primary ? 'pri' : ''}"
                    @click="${(e: Event) => this._act(e, s, c.id)}"
                  >${c.label}</button>`,
                )}
            </div>`
          : ''}
      </div>
    `;
  }

  private _renderMembers(members: SessionState[], group: HomeGroup): TemplateResult {
    const flat = this._flat();
    const focusedId = flat[this._cursor]?.sessionId;
    const isFocused = (s: SessionState): boolean => s.sessionId === focusedId;

    if (this._view === 'tiles') {
      return html`<div class="tiles">
        ${members.map((s) => this._tile(s, isFocused(s)))}
      </div>`;
    }
    if (group === 'Needs input') {
      return html`<div class="cards">
        ${members.map((s) => this._askCard(s, isFocused(s)))}
      </div>`;
    }
    return html`${members.map((s) => this._row(s, isFocused(s)))}`;
  }

  override render() {
    const all = this.sessions;
    const byGroup = new Map<HomeGroup, SessionState[]>(
      HOME_GROUPS.map((g) => [g, [] as SessionState[]]),
    );
    for (const s of all) byGroup.get(groupFor(s))?.push(s);

    const needs = byGroup.get('Needs input') ?? [];
    const others = all.length - needs.length;
    const spread = new Set(needs.map((s) => s.workspaceId)).size;

    return html`
      <div class="home" tabindex="0" @keydown="${this._onKeyDown}">
        <!-- No title bar, by design: the sidebar already says where you are. -->
        <div class="sect">
          <div>
            <div class="st">
              Needs input <span class="c">· ${needs.length}</span>
            </div>
            <div class="ss">
              ${others === 1 ? '1 other' : `${others} others`} working or completed${spread >
              1
                ? ` · across ${spread} workspaces`
                : ''}
            </div>
          </div>
          <div class="sp">
            <div class="seg" role="group" aria-label="Home view mode">
              <button
                type="button"
                class="${this._view === 'tiles' ? 'on' : ''}"
                aria-pressed="${this._view === 'tiles' ? 'true' : 'false'}"
                @click="${() => this._setView('tiles')}"
              ><span>▦</span> Tiles</button>
              <button
                type="button"
                class="${this._view === 'cards' ? 'on' : ''}"
                aria-pressed="${this._view === 'cards' ? 'true' : 'false'}"
                @click="${() => this._setView('cards')}"
              ><span>▤</span> Cards</button>
            </div>
          </div>
        </div>

        ${needs.length === 0
          ? html`<div class="allclear">
              <span class="mark">${NEEDS_GLYPH}</span>
              <span>
                Nothing is waiting on you.${all.length > 0
                  ? ` ${all.length} session${all.length === 1 ? '' : 's'} tracked.`
                  : ''}
              </span>
            </div>`
          : this._renderMembers(needs, 'Needs input')}

        ${HOME_GROUPS.slice(1).map((g) => {
          const members = byGroup.get(g) ?? [];
          if (members.length === 0) return '';
          return html`
            <div class="sect2">
              <span>${g} · ${members.length}</span><span>—</span>
            </div>
            ${this._renderMembers(members, g)}
          `;
        })}

        ${this.fixture
          ? html`<div class="fixture-note">
              fixture data — FIXTURE_SESSIONS, not a live producer
            </div>`
          : ''}

        <div class="keyhelp">
          <span><kbd>j</kbd>/<kbd>k</kbd> move</span>
          <span><kbd>space</kbd> peek</span>
          <span><kbd>enter</kbd> open pane</span>
          <span><kbd>esc</kbd> dismiss</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-home': MuxHome;
  }
}
