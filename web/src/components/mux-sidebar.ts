import { LitElement, html, css, unsafeCSS, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { workspaceLabel } from './workspace-picker.js';
import './launcher-menu.js';
import './mux-start-card.js';
import { NEEDS_GLYPH } from './mux-start-card.js';
import { homeSessions } from '../lib/home-sessions.js';
import { needsInputByWorkspace, needsInputCount } from '../lib/session-state.js';
import { icon } from '../lib/icons.js';
import { Download, Ellipsis, SquareTerminal } from 'lucide';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../lib/sidebar-width.js';
import { instanceLabel } from '../lib/instance-identity.js';
import { previewStore, type PreviewEntry, type PreviewMode } from '../lib/preview-store.js';
import { renderTile, fontReady } from '../lib/preview-canvas.js';
import { tileHash, type PreviewTile } from '../lib/preview-tile.js';
import { PREVIEW_CELL } from '../lib/fonts.js';
import { paletteAnsiArray, resolvePalette } from '../lib/theme.js';
import {
  fetchUpdateStatus,
  applyUpdate,
  UpdateEndpointMissingError,
  type UpdateStatus,
} from '../lib/update.js';

// ---------------------------------------------------------------------------
// Self-update footer
// ---------------------------------------------------------------------------

/** UI phase of the footer's update control. */
type UpdatePhase = 'idle' | 'checking' | 'updating' | 'failed';

/** Poll cadence while waiting for the restarted server to report a new version. */
const UPDATE_POLL_INTERVAL_MS = 1000;
/** Give up after this many polls (~60s) and surface a failure. */
const UPDATE_POLL_MAX_ATTEMPTS = 60;

// ---------------------------------------------------------------------------
// Live workspace previews
// ---------------------------------------------------------------------------

/** `.ws-card` horizontal margin per side. Mirrors the CSS below. */
const CARD_MARGIN_X = 6;
/** `.ws-card` border width per side. Mirrors the CSS below. */
const CARD_BORDER = 1;

/**
 * Column clamp for a preview tile. Below 24 the crop stops being readable at
 * all; above 80 there is nothing more to show, because the daemon's canonical
 * push is 80 columns wide.
 */
const PREVIEW_MIN_COLS = 24;
const PREVIEW_MAX_COLS = 80;

/** ResizeObserver debounce: dragging the sidebar emits a resize every frame. */
const RESIZE_DEBOUNCE_MS = 120;

/**
 * Minimum contrast against the terminal background for preview ink.
 * At 8px with 1px strokes, dim colours are simply not there — a terminal at
 * 14px puts roughly 3x the ink into a glyph and the tile has no such budget.
 */
const PREVIEW_CONTRAST_FLOOR = 4.5;

/**
 * Is the 5x8 bitmap preview font usable?
 *
 * Probed once per page (not per component instance) and remembered. `false`
 * means every card must fall back to the text layout: a 5x8 grid drawn in
 * fallback monospace at 8px is unreadable garbage, never "slightly worse".
 *
 * `null` (still probing) renders the preview LAYOUT optimistically but draws
 * nothing, so the common success case never shows a layout jump.
 */
let previewFontOk: boolean | null = null;
let previewFontProbe: Promise<boolean> | null = null;

function probePreviewFont(): Promise<boolean> {
  previewFontProbe ??= fontReady().then((ok) => {
    previewFontOk = ok;
    return ok;
  });
  return previewFontProbe;
}

/** Which body a preview card shows. */
type CardVisual = 'tile' | 'pending' | 'empty';

/** Everything `_renderWorkspaces()` needs about one workspace, computed once. */
interface CardState {
  id: string;
  label: string;
  active: boolean;
  bell: boolean;
  visual: CardVisual;
  /** Non-null only when `visual === 'tile'`. */
  entry: PreviewEntry | null;
  /** Corner chip: active pane title. */
  title: string;
  /** Corner chip: panes beyond the previewed one. */
  extra: number;
  /** Text hint line, used only by the no-preview fallback card. */
  hint: string;
  /**
   * This workspace's share of the Start card's Needs-input count.
   *
   * Comes from needsInputByWorkspace() over the SAME session set the Start
   * card counts, so the total and the badges are arithmetically incapable of
   * disagreeing. Never compute this any other way.
   */
  needs: number;
  /** Panes in this workspace — shown instead of a badge when needs === 0. */
  paneCount: number;
}

/**
 * True when every cell of the tile is a space.
 *
 * A pane with nothing on screen yields a well-formed EMPTY tile rather than an
 * error, following the daemon's empty-not-error precedent, so "blank" is the
 * signal to show an icon instead of a convincingly-terminal-looking void.
 */
function tileIsBlank(tile: PreviewTile): boolean {
  for (const line of tile.lines) {
    for (let i = 0; i < line.length; i++) {
      if (line.charCodeAt(i) !== 32) return false;
    }
  }
  return true;
}

/**
 * A complete description of the DOM `_renderWorkspaces()` would produce.
 *
 * The preview tick compares this against the last rendered value and bumps the
 * Lit render only when it differs. Tile CONTENT is deliberately absent: it
 * changes at ~6 Hz and must never rebuild DOM — see `_onPreviewTick`.
 */
function cardsSignature(cards: CardState[], mode: PreviewMode, cols: number): string {
  let sig = `${mode}/${cols}`;
  for (const c of cards) {
    sig += `\u0000${c.id}|${c.label}|${c.active ? 1 : 0}${c.bell ? 1 : 0}`;
    sig += `|${c.visual}|${c.title}|${c.extra}|${c.hint}|${c.needs}|${c.paneCount}`;
  }
  return sig;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement('mux-sidebar')
export class MuxSidebar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: var(--chrome-bar);
      border-right: 1px solid var(--chrome-border);
      min-width: ${unsafeCSS(String(SIDEBAR_MIN_WIDTH))}px;
      max-width: ${unsafeCSS(String(SIDEBAR_MAX_WIDTH))}px;
      height: 100%;
      position: relative;
      overflow: hidden;
      user-select: none;
      box-sizing: border-box;
      flex-shrink: 0;
    }

    .header {
      padding: 10px 12px 8px;
      font-size: 13px;
      font-weight: 700;
      color: var(--chrome-text-bright);
      letter-spacing: 0.06em;
      border-bottom: 1px solid var(--chrome-border);
      /* Falls back to transparent (i.e. the sidebar's own --chrome-bar shows
         through) unless the user picked a custom title-bar color in Settings. */
      background: var(--mux-titlebar-bg, transparent);
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .header > span {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .launcher-btn {
      width: 26px;
      height: 22px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--mux-text-bright, #c0caf5);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      flex-shrink: 0;
    }

    .launcher-btn:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .menu-anchor {
      position: absolute;
      top: 38px;
      left: 8px;
      z-index: 1500;
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
      pointer-events: none;
    }

    .tab-content {
      flex: 1;
      overflow-y: auto;
      padding: 6px 0;
    }

    .sb-heading {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 9px;
      letter-spacing: 0.11em;
      text-transform: uppercase;
      color: var(--chrome-text-dim);
      margin: 10px 0 6px 9px;
    }

    /* ---- workspace cards ---- */

    .ws-card {
      padding: 7px 10px;
      margin: 2px 6px;
      border-radius: 5px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.12s, border-color 0.12s;
    }

    .ws-card:hover {
      background: var(--chrome-hover);
    }

    .ws-card.active {
      background: var(--chrome-hover);
      border-color: var(--chrome-accent);
    }

    .ws-header {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .dot {
      font-size: 7px;
      flex-shrink: 0;
      line-height: 1;
    }

    .dot.active {
      color: var(--chrome-accent);
    }

    .dot.inactive {
      color: var(--chrome-text-dim);
    }

    .ws-name {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
      color: var(--chrome-text-bright);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .ws-rename-input {
      flex: 1;
      background: var(--chrome-body);
      border: 1px solid var(--chrome-accent);
      border-radius: 3px;
      color: var(--chrome-text-bright);
      font: inherit;
      font-size: 13px;
      padding: 1px 5px;
      outline: none;
      min-width: 0;
    }

    .ws-rename-input:focus {
      box-shadow: 0 0 0 2px var(--chrome-accent)33;
    }

    /* Needs-input badge. Its number is this workspace's share of the Start
       card total — both come from needsInputByWorkspace(). */
    .ws-needs {
      flex-shrink: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 9px;
      line-height: 1.5;
      color: var(--mux-warn);
      background: color-mix(in srgb, var(--mux-warn) 18%, transparent);
      border: 1px solid color-mix(in srgb, var(--mux-warn) 45%, transparent);
      padding: 0 5px;
      border-radius: 8px;
      white-space: nowrap;
    }

    /* Zero needs is not a zero badge: a plain pane count, and nothing warm. */
    .ws-panes {
      flex-shrink: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 9px;
      line-height: 1.5;
      color: var(--chrome-text-dim);
      white-space: nowrap;
    }

    .ws-remove-btn {
      flex-shrink: 0;
      background: transparent;
      border: none;
      color: var(--chrome-text-dim);
      cursor: pointer;
      padding: 1px 3px;
      border-radius: 3px;
      font-size: 13px;
      line-height: 1;
      opacity: 0;
      transition: opacity 0.12s, color 0.12s;
    }

    .ws-card:hover .ws-remove-btn,
    .ws-card.active .ws-remove-btn,
    .ws-remove-btn:focus-visible {
      opacity: 1;
    }

    .ws-remove-btn:hover {
      color: var(--chrome-danger);
    }

    .ws-remove-btn:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }

    @media (pointer: coarse) {
      .ws-remove-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        padding: 0;
        opacity: 1;
      }
    }

    .ws-hint {
      font-size: 11px;
      color: var(--chrome-text-dim);
      margin-top: 2px;
      padding-left: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ---- workspace cards: live preview variant ----
       Everything above stays exactly as it was: it is what renders when
       previews are off or the bitmap font failed to load. */

    .ws-card.preview {
      position: relative;
      /* Own stacking context: keeps the scrim/header/chip z-order below purely
         local, so a card can never paint over its neighbours. */
      z-index: 0;
      padding: 0;
      margin: 3px 6px;
      border-radius: 6px;
      overflow: hidden;
      /* The card is a little SCREEN, not a list row. --mux-bg (the terminal
         background) rather than --chrome-bar is the single detail that makes
         it read that way, so the hover/active list-row fills are cancelled
         below rather than inherited. */
      background: var(--mux-bg);
      /* A visible bezel is REQUIRED, not decorative. --mux-bg and --chrome-bar
         are near-identical in dark palettes (tokyo-night measures 1.05:1 --
         effectively the same luminance), so a transparent border leaves an
         idle card with no edge at all and it dissolves into the sidebar.
         Ghosting the canvas does not help: it dims the tile's CONTENT, not the
         card's boundary. --chrome-border alone is only 1.34:1 here, so the
         resting bezel is mixed toward --chrome-text-dim for ~1.8:1 in both
         light and dark. */
      border-color: color-mix(in srgb, var(--chrome-border) 60%, var(--chrome-text-dim));
      /* Lifts the card off the panel so it reads as a screen sitting ON the
         sidebar rather than a region cut out of it. */
      box-shadow: 0 1px 3px -1px rgba(0, 0, 0, 0.5);
      transition: border-color 0.12s, box-shadow 0.12s;
    }

    .ws-card.preview:hover,
    .ws-card.preview.active {
      background: var(--mux-bg);
    }

    .ws-card.preview:not(.active):hover {
      border-color: var(--chrome-text-dim);
    }

    .ws-card.preview.active {
      border-color: var(--chrome-accent);
      box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--chrome-accent) 40%, transparent);
    }

    /* Scrim, over the TOP of the tile. Not arbitrary: after bottom-anchoring
       the crop, the top rows hold the OLDEST content, so the chrome covers the
       least valuable pixels on the card. */
    .ws-card.preview.full::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 24px;
      background: linear-gradient(
        to bottom,
        var(--chrome-bar),
        color-mix(in srgb, var(--chrome-bar) 55%, transparent) 60%,
        transparent
      );
      pointer-events: none;
      z-index: 1;
    }

    .ws-card.preview .ws-header {
      box-sizing: border-box;
      padding: 0 6px;
      min-height: 24px;
      position: relative;
      z-index: 2;
    }

    .ws-card.preview.full .ws-header {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      /* Does more work than the scrim for legibility over arbitrary tile
         content; inherited by the dot and the close x. */
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
    }

    /* compact: 6 rows is 48px, and a 24px scrim over that is half the card, so
       the header is stacked above the tile instead of overlaid. */
    .ws-card.preview.compact .ws-header {
      background: var(--chrome-bar);
    }

    .ws-card.preview .ws-name {
      font-size: 12px;
      font-weight: 600;
    }

    .dot.bell {
      color: var(--mux-bell);
    }

    .ws-screen {
      position: relative;
      overflow: hidden;
      /* Height is set inline to rows * PREVIEW_CELL.h so the full tile box is
         reserved from the first paint and nothing shifts when a tile lands. */
    }

    .ws-canvas {
      display: block;
    }

    /* Ghosting the idle cards IS the hierarchy (the workspace you are in is
       live and vivid, the others are monochrome pushes), and it also separates
       --mux-bg from --chrome-bar in dark palettes where they sit close. */
    .ws-card.preview:not(.active) .ws-canvas {
      filter: saturate(0.25) opacity(0.55);
      transition: filter 0.12s;
    }

    .ws-card.preview:not(.active):hover .ws-canvas {
      filter: saturate(0.5) opacity(0.85);
    }

    .ws-placeholder {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--chrome-text-dim);
      font-size: 13px;
      letter-spacing: 3px;
      pointer-events: none;
    }

    /* Bottom-right: we crop the bottom-LEFT of the pane, so the right end of
       the last row sits past a typical prompt line — statistically the
       emptiest region of the tile. */
    .ws-chip {
      position: absolute;
      bottom: 4px;
      right: 4px;
      max-width: 62%;
      box-sizing: border-box;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 10px;
      line-height: 1.4;
      color: var(--chrome-text-dim);
      background: color-mix(in srgb, var(--chrome-bar) 80%, transparent);
      backdrop-filter: blur(2px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
      z-index: 2;
    }

    .ws-card.preview.active .ws-chip-extra {
      color: var(--chrome-accent);
    }

    .new-ws-btn {
      display: block;
      width: calc(100% - 12px);
      margin: 6px 6px 4px;
      padding: 7px 10px;
      background: transparent;
      border: 1px dashed var(--chrome-text-dim);
      border-radius: 5px;
      color: var(--chrome-accent);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s;
    }

    .new-ws-btn:hover {
      border-color: var(--chrome-accent);
      background: var(--chrome-hover);
    }

    /* ---- update footer (pinned; never scrolls with .tab-content) ---- */

    .footer {
      flex-shrink: 0;
      padding: 8px 12px 10px;
      border-top: 1px solid var(--chrome-border);
    }

    .footer-line {
      font-size: 12px;
      color: var(--chrome-text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .footer-note {
      font-size: 11px;
      color: var(--chrome-text-dim);
      margin-top: 2px;
      overflow-wrap: anywhere;
    }

    .update-btn {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      margin-top: 6px;
      padding: 6px 10px;
      background: transparent;
      border: 1px solid var(--chrome-accent);
      border-radius: 5px;
      color: var(--chrome-accent);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }

    .update-btn:hover {
      background: var(--chrome-hover);
    }

    .update-btn:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }

    .update-btn:disabled {
      cursor: default;
      opacity: 0.55;
      border-color: var(--chrome-border);
      color: var(--chrome-text-dim);
    }

    .update-btn:disabled:hover {
      background: transparent;
    }
  `;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** True while the home view is the thing on screen. Drives the Start card. */
  @property({ type: Boolean }) homeActive = false;

  /** Key chord shown on the Start card, e.g. "ctrl+`". */
  @property({ type: String }) homeKey = '';

  @state() private _version = 0;
  @state() private _renaming: string | null = null;
  @state() private _menuOpen = false;

  /**
   * Tile width in columns, derived from the measured card. 0 = not measured
   * yet. Reactive because the canvas element's CSS size comes out of the
   * template — but it only ever changes on a debounced resize, never per tick.
   */
  @state() private _cols = 0;

  /** Server-reported update status; null until the first check resolves. */
  @state() private _updateStatus: UpdateStatus | null = null;
  @state() private _updatePhase: UpdatePhase = 'idle';
  @state() private _updateError = '';

  private _unsub: (() => void) | null = null;
  private _updatePollTimer: number | null = null;
  private _updatePollAttempts = 0;

  // --- preview plumbing ------------------------------------------------------

  private _unsubPreview: (() => void) | null = null;
  private _unsubSessions: (() => void) | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _resizeTimer: number | null = null;

  /** Last cards handed to `render()`; `updated()` paints from exactly these. */
  private _cards: CardState[] = [];
  /** `cardsSignature()` of `_cards`, i.e. of the DOM currently on screen. */
  private _cardSig = '';
  /** Canvas per workspace, repopulated from the DOM in `updated()`. */
  private _canvases = new Map<string, HTMLCanvasElement>();
  /**
   * Last-drawn key per canvas ELEMENT rather than per workspace id: Lit reuses
   * card DOM by position, so a canvas can be handed to a different workspace
   * when the list reorders and a workspace-keyed hash would then claim a stale
   * bitmap was current.
   */
  private _drawn = new WeakMap<HTMLCanvasElement, string>();

  private _onOutsideClick = (e: MouseEvent): void => {
    if (this._menuOpen && !e.composedPath().includes(this)) {
      this._menuOpen = false;
    }
  };

  private _onLauncherAction(e: Event): void {
    e.stopPropagation();
    this._menuOpen = false;
    const customEvent = e as CustomEvent;
    this.dispatchEvent(new CustomEvent('launcher-action', {
      bubbles: true,
      composed: true,
      detail: customEvent.detail,
    }));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('mousedown', this._onOutsideClick);

    // Subscribe to store changes and trigger re-render by bumping _version.
    this._unsub = store.subscribe(() => {
      this._version++;
    });

    // Session state (Start card total + per-workspace badges). Low rate — one
    // frame per session state change — so a plain re-render is the right cost.
    this._unsubSessions = homeSessions.subscribe(() => {
      this._version++;
    });

    // Preview tiles arrive at ~6 Hz. This callback deliberately does NOT bump
    // _version — see _onPreviewTick.
    this._unsubPreview = previewStore.subscribe(this._onPreviewTick);

    // One probe per page, remembered. Until it resolves we render the preview
    // layout but draw nothing; if it resolves false every card falls back to
    // the text layout permanently.
    if (previewFontOk === null) {
      void probePreviewFont().then(() => {
        this._version++;
      });
    }
  }

  override disconnectedCallback(): void {
    document.removeEventListener('mousedown', this._onOutsideClick);
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
    this._unsubPreview?.();
    this._unsubPreview = null;
    this._unsubSessions?.();
    this._unsubSessions = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (this._resizeTimer !== null) {
      window.clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
    this._canvases.clear();
    this._cards = [];
    this._clearUpdatePoll();
  }

  /** One status check, after first paint — the footer never blocks rendering. */
  override firstUpdated(): void {
    this._observeCardWidth();

    this._updatePhase = 'checking';
    void fetchUpdateStatus()
      .then((status) => {
        this._updateStatus = status;
      })
      .catch(() => {
        // Status unknown (offline, old server): the footer stays empty.
      })
      .finally(() => {
        if (this._updatePhase === 'checking') this._updatePhase = 'idle';
      });
  }

  /**
   * Canvas refs are collected here, after Lit has committed the DOM, and the
   * tiles are drawn imperatively. The preview tick then reuses these refs
   * without going through Lit at all.
   */
  override updated(): void {
    this._collectCanvases();
    this._paintAll(this._cards);
  }

  // ---------------------------------------------------------------------------
  // Self-update
  // ---------------------------------------------------------------------------

  /** Starts (or retries) the update. Safe to call from both button states. */
  private _onUpdateClick(): void {
    if (this._updatePhase === 'updating') return;
    const previousVersion = this._updateStatus?.currentVersion ?? '';
    this._updatePhase = 'updating';
    this._updateError = '';
    this._updatePollAttempts = 0;
    void applyUpdate()
      .then(() => {
        // Binary replaced; the server restarts ~500ms later.
        this._scheduleUpdatePoll(previousVersion);
      })
      .catch((e: unknown) => {
        this._updatePhase = 'failed';
        this._updateError = e instanceof Error ? e.message : String(e);
      });
  }

  private _clearUpdatePoll(): void {
    if (this._updatePollTimer !== null) {
      window.clearTimeout(this._updatePollTimer);
      this._updatePollTimer = null;
    }
  }

  private _scheduleUpdatePoll(previousVersion: string): void {
    this._clearUpdatePoll();
    this._updatePollTimer = window.setTimeout(() => {
      this._updatePollTimer = null;
      void this._pollForRestart(previousVersion);
    }, UPDATE_POLL_INTERVAL_MS);
  }

  /**
   * Waits for the restarted server to report a different currentVersion, then
   * reloads. Poll failures are EXPECTED while the server is down and are
   * swallowed — only the attempt budget running out counts as a failure.
   */
  private async _pollForRestart(previousVersion: string): Promise<void> {
    if (!this.isConnected || this._updatePhase !== 'updating') return;
    this._updatePollAttempts++;
    try {
      const status = await fetchUpdateStatus();
      if (status.currentVersion !== '' && status.currentVersion !== previousVersion) {
        window.location.reload();
        return;
      }
    } catch (e: unknown) {
      // A 404 means an HTTP server is back up but has no update endpoint —
      // the restart landed on a build predating this feature, so the update
      // worked. Reload rather than time out and cry failure.
      if (e instanceof UpdateEndpointMissingError) {
        window.location.reload();
        return;
      }
      // Otherwise the server is still restarting; connection errors are normal.
    }
    if (!this.isConnected || this._updatePhase !== 'updating') return;
    if (this._updatePollAttempts >= UPDATE_POLL_MAX_ATTEMPTS) {
      this._updatePhase = 'failed';
      this._updateError = 'Update did not complete in time';
      return;
    }
    this._scheduleUpdatePoll(previousVersion);
  }

  // ---------------------------------------------------------------------------
  // Live preview plumbing
  // ---------------------------------------------------------------------------

  /** Tile height in rows, or 0 when previews are off or unrenderable. */
  private get _previewRows(): number {
    // A 5x8 grid in fallback monospace at 8px is unreadable garbage, so a
    // failed font is exactly as good as previews being switched off.
    if (previewFontOk === false) return 0;
    return previewStore.rows;
  }

  private _observeCardWidth(): void {
    const container = this.shadowRoot?.querySelector('.tab-content');
    if (!container || typeof ResizeObserver === 'undefined') {
      this._measureCardWidth();
      return;
    }
    this._resizeObserver = new ResizeObserver(this._onCardResize);
    this._resizeObserver.observe(container);
  }

  private _onCardResize = (): void => {
    // The first measurement is applied immediately: it lands before paint, so
    // the card is born at the right width instead of visibly re-flowing.
    if (this._cols === 0) {
      this._measureCardWidth();
      return;
    }
    if (this._resizeTimer !== null) window.clearTimeout(this._resizeTimer);
    this._resizeTimer = window.setTimeout(() => {
      this._resizeTimer = null;
      this._measureCardWidth();
    }, RESIZE_DEBOUNCE_MS);
  };

  /**
   * Columns from the REAL measured card width, never a constant: dragging the
   * sidebar wider must reveal more columns, not more rows, which is the correct
   * semantics for "a window onto the bottom-left of a pane".
   */
  private _measureCardWidth(): void {
    const root = this.shadowRoot;
    if (!root) return;

    const screen = root.querySelector('.ws-screen');
    let inner = screen ? screen.clientWidth : 0;
    if (inner <= 0) {
      // No card on screen yet (no workspaces, or previews off): derive from the
      // scroll container minus the card's own margins and borders.
      const container = root.querySelector('.tab-content');
      if (!container) return;
      inner = container.clientWidth - 2 * (CARD_MARGIN_X + CARD_BORDER);
    }
    if (inner <= 0) return;

    const cols = Math.min(
      PREVIEW_MAX_COLS,
      Math.max(PREVIEW_MIN_COLS, Math.floor(inner / PREVIEW_CELL.w)),
    );
    if (cols !== this._cols) this._cols = cols;
  }

  /**
   * previewStore fires at ~6 Hz. Bumping _version here would rebuild every
   * card's DOM several times a second, which is the one thing this component
   * must not do — so the tick compares the STRUCTURE of the cards against what
   * is on screen and only re-renders when that actually changed (a workspace
   * appeared, a card gained its first tile, the chip's pane title moved).
   * Otherwise it draws straight to the existing canvases.
   */
  private _onPreviewTick = (): void => {
    const cards = this._computeCards();
    if (cardsSignature(cards, previewStore.mode, this._cols) !== this._cardSig) {
      this._version++;
      return;
    }
    this._paintAll(cards);
  };

  private _collectCanvases(): void {
    this._canvases.clear();
    const root = this.shadowRoot;
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLCanvasElement>('canvas.ws-canvas')) {
      const id = el.dataset['ws'];
      if (id) this._canvases.set(id, el);
    }
  }

  /** Draw every card that has a tile, skipping anything already on screen. */
  private _paintAll(cards: CardState[]): void {
    // Never draw before the bitmap font is confirmed usable.
    if (previewFontOk !== true) return;

    const paletteName = store.config.theme.palette;
    const palette = resolvePalette(paletteName);
    const ansi = paletteAnsiArray(palette);

    for (const card of cards) {
      const entry = card.entry;
      if (card.visual !== 'tile' || !entry) continue;
      const canvas = this._canvases.get(card.id);
      if (!canvas) continue;

      // Identical key means identical pixels, so the redraw can be skipped
      // outright — subscribe() fires far faster than the content changes.
      const key = [
        tileHash(entry.tile),
        `${entry.tile.cols}x${entry.tile.rows}`,
        entry.live ? 'live' : 'mono',
        paletteName,
      ].join(':');
      if (this._drawn.get(canvas) === key) continue;
      this._drawn.set(canvas, key);

      renderTile(canvas, entry.tile, {
        palette: ansi,
        fg: palette.foreground,
        bg: palette.background,
        // Detached workspaces render monochrome. The asymmetry IS the visual
        // hierarchy — the workspace you are in is live and vivid, the others
        // are ghosted — not a limitation of the push path.
        mono: !entry.live,
        contrastFloor: PREVIEW_CONTRAST_FLOOR,
      });
    }
  }

  /** Everything the workspace list needs, resolved once per render/tick. */
  private _computeCards(): CardState[] {
    const activeWsId = store.attached ?? '';
    const panes = store.panes;
    const activePaneId = store.activePaneId;
    // ONE derivation, shared with the Start card total below. See CardState.needs.
    const needsByWs = needsInputByWorkspace(homeSessions.sessions);
    const rows = this._previewRows;
    const cols = this._cols;
    const previewOn = rows > 0 && cols > 0;
    const activePane = panes.find((p) => p.paneId === activePaneId);

    return store.workspaces.map((ws) => {
      const id = ws.workspaceId;
      const active = id === activeWsId;
      const entry = previewOn ? previewStore.get(id, cols, rows) : null;

      const paneId = entry ? entry.paneId : activePaneId;

      let visual: CardVisual = 'pending';
      if (entry) visual = tileIsBlank(entry.tile) ? 'empty' : 'tile';

      let title = entry?.title ?? '';
      if (title === '' && active) title = activePane?.title ?? '';
      // sessiond does not capture OSC 0/2 titles yet (pane.go: "a later
      // phase"), so Title is empty for essentially every pane. Without a
      // fallback the chip would never appear and the card would lose the pane
      // identity entirely. `Pane N` is the convention mux-dock and
      // mux-pane-picker already use for an untitled pane.
      if (title === '' && paneId >= 0) title = `Pane ${paneId}`;
      const extra = Math.max(0, (active ? panes.length : ws.paneCount) - 1);

      // Today's hint line, preserved verbatim for the no-preview fallback card.
      let hint = '';
      if (active && panes.length > 0) {
        const t = (activePane ?? panes[0]).title ?? '';
        hint = panes.length > 1 ? `${t}  +${panes.length - 1}` : t;
      }

      return {
        id,
        label: workspaceLabel(ws),
        active,
        bell: store.workspaceBellActive(id),
        visual,
        entry: visual === 'tile' ? entry : null,
        title,
        extra,
        hint,
        needs: needsByWs.get(id) ?? 0,
        paneCount: active ? panes.length : ws.paneCount,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Workspace helpers
  // ---------------------------------------------------------------------------

  /** The Start card is the way back to home from anywhere. */
  private _onStartClick(): void {
    this.dispatchEvent(
      new CustomEvent('home-show', { bubbles: true, composed: true }),
    );
  }

  private _onWsClick(wsId: string): void {
    store.ackWorkspace(wsId);
    this.dispatchEvent(
      new CustomEvent('workspace-switch', {
        detail: { workspaceId: wsId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onNewWs(): void {
    this.dispatchEvent(
      new CustomEvent('workspace-create', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onWsRemove(e: Event, wsId: string, name: string): void {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('workspace-close', {
        detail: { workspaceId: wsId, name },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _startRename(e: Event, wsId: string): void {
    e.stopPropagation();
    this._renaming = wsId;
    requestAnimationFrame(() => {
      const input = this.shadowRoot?.querySelector<HTMLInputElement>('.ws-rename-input');
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  private _finishRename(e: Event, wsId: string): void {
    const name = (e.target as HTMLInputElement).value.trim();
    this._renaming = null;
    if (name) {
      this.dispatchEvent(
        new CustomEvent('workspace-rename', {
          detail: { workspaceId: wsId, name },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private _onRenameKeyDown(e: KeyboardEvent, wsId: string): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const name = (e.target as HTMLInputElement).value.trim();
      this._renaming = null;
      if (name) {
        this.dispatchEvent(
          new CustomEvent('workspace-rename', {
            detail: { workspaceId: wsId, name },
            bubbles: true,
            composed: true,
          }),
        );
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this._renaming = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Workspace render
  // ---------------------------------------------------------------------------

  /** Dot + name (or rename input) + close x. Shared by both card layouts. */
  private _renderHeader(card: CardState) {
    // The bell producer only ever fires for pushed preview frames, so this
    // class is inert on the no-preview card and the header stays one renderer.
    const dotClass = card.bell ? 'bell' : card.active ? 'active' : 'inactive';
    return html`
      <div class="ws-header">
        <span class="dot ${dotClass}">●</span>
        ${this._renaming === card.id
          ? html`<input
              class="ws-rename-input"
              type="text"
              .value="${card.label}"
              @keydown="${(e: KeyboardEvent) => this._onRenameKeyDown(e, card.id)}"
              @blur="${(e: Event) => this._finishRename(e, card.id)}"
              @click="${(e: Event) => e.stopPropagation()}"
            />`
          : html`<span
              class="ws-name"
              @dblclick="${(e: Event) => this._startRename(e, card.id)}"
              >${card.label}</span
            >`}
        ${card.needs > 0
          ? html`<span
              class="ws-needs"
              title="${card.needs} session${card.needs === 1 ? '' : 's'} need input"
              >${NEEDS_GLYPH} ${card.needs}</span
            >`
          : html`<span class="ws-panes"
              >${card.paneCount} pane${card.paneCount === 1 ? '' : 's'}</span
            >`}
        <button
          type="button"
          class="ws-remove-btn"
          title="Close workspace"
          aria-label="Close workspace ${card.label}"
          @click="${(e: Event) => this._onWsRemove(e, card.id, card.label)}"
        >×</button>
      </div>
    `;
  }

  /** Previews off, or the bitmap font failed: today's exact card. */
  private _renderTextCard(card: CardState) {
    return html`
      <div
        class="ws-card ${card.active ? 'active' : ''}"
        @click="${() => this._onWsClick(card.id)}"
      >
        ${this._renderHeader(card)}
        ${card.hint ? html`<div class="ws-hint">${card.hint}</div>` : ''}
      </div>
    `;
  }

  private _renderPreviewCard(card: CardState, rows: number, cols: number, compact: boolean) {
    const tileW = cols * PREVIEW_CELL.w;
    const tileH = rows * PREVIEW_CELL.h;

    let body: TemplateResult;
    if (card.visual === 'tile') {
      // Sized here as well as in renderTile() so the box is right on the very
      // first frame, before any pixels exist.
      body = html`<canvas
        class="ws-canvas"
        data-ws="${card.id}"
        style="width:${tileW}px;height:${tileH}px"
      ></canvas>`;
    } else if (card.visual === 'pending') {
      body = html`<div class="ws-placeholder">···</div>`;
    } else {
      // Nothing on screen in this pane; an icon is honest and looks better
      // than a convincingly-terminal-shaped void.
      body = html`<div class="ws-placeholder">
        ${icon(SquareTerminal, { size: 24 })}
      </div>`;
    }

    // Written on one line: the chip is nowrap + ellipsis, so template
    // indentation would show up as leading/trailing space inside it.
    const extra =
      card.extra > 0 ? html`<span class="ws-chip-extra"> +${card.extra}</span>` : '';
    const chip =
      card.title !== '' || card.extra > 0
        ? html`<div class="ws-chip">${card.title}${extra}</div>`
        : '';

    return html`
      <div
        class="ws-card preview ${compact ? 'compact' : 'full'} ${card.active ? 'active' : ''}"
        @click="${() => this._onWsClick(card.id)}"
      >
        ${this._renderHeader(card)}
        <div class="ws-screen" style="height:${tileH}px">${body}</div>
        ${chip}
      </div>
    `;
  }

  private _renderWorkspaces() {
    const rows = this._previewRows;
    const cols = this._cols;
    // Recorded so the preview tick can tell a structural change from a mere
    // content change without re-rendering to find out.
    const cards = this._computeCards();
    this._cards = cards;
    this._cardSig = cardsSignature(cards, previewStore.mode, cols);

    // Deliberately NOT gated on `cols`: the card box (and its reserved tile
    // height) must exist from the very first paint, so an unmeasured card
    // renders the placeholder at full height rather than the text layout and
    // then visibly reflowing once the ResizeObserver reports.
    const previewOn = rows > 0;
    const compact = previewStore.mode === 'compact';

    return html`
      ${cards.map((card) =>
        previewOn
          ? this._renderPreviewCard(card, rows, cols, compact)
          : this._renderTextCard(card),
      )}
      <button class="new-ws-btn" @click="${() => this._onNewWs()}">
        + New workspace
      </button>
    `;
  }

  // ---------------------------------------------------------------------------
  // Footer render
  // ---------------------------------------------------------------------------

  private _renderFooter() {
    // Failure survives a stale/unknown status, so it is checked first.
    if (this._updatePhase === 'failed') {
      return html`
        <div class="footer">
          <div class="footer-line">Update failed</div>
          <div class="footer-note">${this._updateError}</div>
          <button class="update-btn" @click="${() => this._onUpdateClick()}">
            ${icon(Download, { size: 14 })}Retry
          </button>
        </div>
      `;
    }

    const status = this._updateStatus;
    if (!status) return ''; // check still in flight (or it failed): show nothing

    const versionLine = status.currentVersion
      ? `muxterm ${status.currentVersion}`
      : 'muxterm';

    if (this._updatePhase === 'updating') {
      return html`
        <div class="footer">
          <div class="footer-line">${versionLine}</div>
          <button class="update-btn" disabled>
            ${icon(Download, { size: 14 })}Updating…
          </button>
          <div class="footer-note">downloading and restarting…</div>
        </div>
      `;
    }

    // Dev build: nothing actionable, by design.
    if (status.devBuild) {
      return html`
        <div class="footer">
          <div class="footer-line">${versionLine}</div>
          <div class="footer-note">${status.reason || 'dev build — updates disabled'}</div>
        </div>
      `;
    }

    if (status.canUpdate) {
      const label = status.latestVersion ? `Update to ${status.latestVersion}` : 'Update';
      return html`
        <div class="footer">
          <div class="footer-line">${versionLine}</div>
          <button class="update-btn" @click="${() => this._onUpdateClick()}">
            ${icon(Download, { size: 14 })}${label}
          </button>
        </div>
      `;
    }

    // Newer release exists but this install cannot self-update (Homebrew,
    // unsupported platform): the server's reason, muted and non-actionable.
    if (status.updateAvailable) {
      return html`
        <div class="footer">
          <div class="footer-line">${versionLine}</div>
          <div class="footer-note">
            ${status.reason || 'update available — updates not supported here'}
          </div>
        </div>
      `;
    }

    // A failed release check is NOT "up to date" — we never learned what the
    // latest version is. Saying otherwise would be a lie the user can't see
    // through.
    return html`
      <div class="footer">
        <div class="footer-line">${versionLine}</div>
        <div class="footer-note">
          ${status.error ? 'update check unavailable' : 'up to date'}
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  override render() {
    void this._version; // suppress unused-variable lint; triggers re-render on store change
    return html`
      <div class="header">
        <span title="${window.location.hostname}">${instanceLabel()}</span>
        <button
          class="launcher-btn"
          title="Open menu"
          @click="${() => { this._menuOpen = !this._menuOpen; }}"
        >${icon(Ellipsis, { size: 15 })}</button>
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu
                @launcher-action="${(e: Event) => this._onLauncherAction(e)}"
              ></mux-launcher-menu>
            </div>`
          : ''}
      </div>
      <div class="tab-content">
        <mux-start-card
          .count="${needsInputCount(homeSessions.sessions)}"
          .spread="${needsInputByWorkspace(homeSessions.sessions).size}"
          .active="${this.homeActive}"
          .hint="${this.homeKey}"
          @start-click="${() => this._onStartClick()}"
        ></mux-start-card>
        <div class="sb-heading">workspaces</div>
        ${this._renderWorkspaces()}
      </div>
      ${this._renderFooter()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-sidebar': MuxSidebar;
  }
}
