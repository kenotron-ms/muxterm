import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, html, css, unsafeCSS, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { store } from '../state.js';
import type { SessiondWorkspaceCompletion } from '../types.js';
import { workspaceLabel } from '../lib/workspace-label.js';
import './mux-chat-list.js';
import { homeSessions } from '../lib/home-sessions.js';
import type { SessionRunState } from '../lib/session-state.js';
import { needsInputByWorkspace } from '../lib/session-state.js';
import { icon } from '../lib/icons.js';
import { CalendarClock, ChevronDown, Plug, Plus, Puzzle, Settings, SquareTerminal } from 'lucide';
import '../ui/nav-item.js';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../lib/sidebar-width.js';
import { instanceLabel } from '../lib/instance-identity.js';
import { previewStore, type PreviewEntry, type PreviewMode } from '../lib/preview-store.js';
import { renderTile, fontReady } from '../lib/preview-canvas.js';
import { tileHash, type PreviewTile } from '../lib/preview-tile.js';
import { PREVIEW_CELL } from '../lib/fonts.js';
import { paletteAnsiArray, resolvePalette } from '../lib/theme.js';
import { parseHostRef, isRemoteId } from '../lib/host-ref.js';
import { remotesStore, type HostConnState } from '../lib/remotes-store.js';
import { apiPath } from '../lib/base-path.js';
import {
  fetchUpdateStatus,
  type UpdateStatus,
} from '../lib/update.js';

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
  /**
   * Set when this workspace is holding a finished lane's result.
   *
   * Such a workspace has zero panes and is deliberately NOT reaped, so
   * without this it would render as a bare "0 panes" card and say nothing
   * about the lane that just finished in it — which is the silence this
   * whole feature exists to break.
   */
  completion: SessiondWorkspaceCompletion | null;
  /** Declared lanes occupying this terminal workspace. */
  lanes: string[];
  /** Highest-signal declared session state in this workspace. */
  sessionState: SessionRunState | null;
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
    sig += `|${c.visual}|${c.title}|${c.extra}|${c.hint}|${c.needs}|${c.paneCount}|${c.sessionState ?? ''}`;
  }
  return sig;
}

// ---------------------------------------------------------------------------
// Host groups
//
// The sidebar answers "where is my stuff", which is a spatial question, so it
// is the ONE surface that groups by machine (ux D1). EVERY reachable machine
// gets a group, the local one included, in every connection state -- a browser
// with no remotes sees exactly one group rather than an ungrouped list.
//
// That uniformity is load-bearing, not cosmetic. The group is what carries a
// machine's "+ New workspace", so a rendering mode with no groups in it is a
// rendering mode where that button has nowhere to live but the sidebar root --
// which is the bug this replaced. One shape in all states, one place the
// button can be.
// ---------------------------------------------------------------------------

/** One machine's section of the workspace list. */
interface HostGroup {
  /** HostRef.ID, or '' for the local daemon. */
  host: string;
  /** Header label. The display NAME, never the id (ux D7). */
  name: string;
  /** Connection state, or null for local — local is not a remote (ux D2). */
  state: HostConnState | null;
  /** ms epoch the current state began; 0 when unknown. */
  since: number;
  cards: CardState[];
  /** This machine's share of the Start card's needs-input total. */
  needs: number;
}

/**
 * Split the cards into per-machine groups.
 *
 * Order is local first, then `remotesStore.hosts` (sorted by id), which is the
 * same stable order the server merges its workspace list in — so a push can
 * never reshuffle the sidebar.
 *
 * A connected host with no workspaces still gets a group: the group is what
 * carries that machine's "+ New workspace". The one host that is dropped is an
 * `unreachable` one with nothing on it, which lives in settings rather than
 * here (ux failure table). An unreachable host that DOES hold workspaces keeps
 * its group, because workspaces ghost, never vanish (ux D8).
 */
function groupCards(cards: CardState[], localName: string): HostGroup[] {
  const byHost = new Map<string, CardState[]>();
  for (const card of cards) {
    const { host } = parseHostRef(card.id);
    const list = byHost.get(host);
    if (list) list.push(card);
    else byHost.set(host, [card]);
  }

  const take = (host: string): CardState[] => {
    const list = byHost.get(host) ?? [];
    byHost.delete(host);
    return list;
  };
  const group = (
    host: string,
    name: string,
    state: HostConnState | null,
    since: number,
    groupCardList: CardState[],
  ): HostGroup => ({
    host,
    name,
    state,
    since,
    cards: groupCardList,
    needs: groupCardList.reduce((sum, c) => sum + c.needs, 0),
  });

  const groups: HostGroup[] = [group('', localName, null, 0, take(''))];
  for (const host of remotesStore.hosts) {
    const hostCards = take(host.id);
    if (host.state === 'unreachable' && hostCards.length === 0) continue;
    groups.push(group(host.id, host.name, host.state, host.since, hostCards));
  }
  // Anything left names a host this browser holds cards for but has no frame
  // for. It should not happen; dropping the cards on the floor if it does
  // would make a workspace disappear, so they get a group of their own.
  for (const host of [...byHost.keys()].sort()) {
    groups.push(group(host, host, 'never-connected', 0, take(host)));
  }
  return groups;
}

/** "12s" / "4m" / "2h" — the age of a host's current state. */
function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function hostTypeLabel(host: string): 'Local' | 'SSH' | 'Remote daemon' {
  if (host === '') return 'Local';
  return /^ssh:[^/]+$/.test(host) ? 'SSH' : 'Remote daemon';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement('mux-sidebar')
export class MuxSidebar extends LitElement {
  static styles = css`
    ${subtleScrollbars}
    :host {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      box-sizing: border-box;
      position: relative;
      overflow: hidden;
      width: auto;
      min-width: ${unsafeCSS(String(SIDEBAR_MIN_WIDTH))}px;
      max-width: ${unsafeCSS(String(SIDEBAR_MAX_WIDTH))}px;
      height: 100%;
      border-right: 1px solid var(--ui-border);
      background: var(--ui-surface-raised);
      color: var(--ui-text);
      font-family: var(--ui-font-sans);
    }
    .header {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      flex: none;
      height: var(--ui-nav-height);
      padding: 0 var(--ui-space-5);
      border-bottom: 1px solid var(--ui-border);
      background: var(--ui-surface-nav);
      color: var(--ui-text);
      font: 700 var(--ui-text-md)/1.25 var(--ui-font-sans);
    }
    :host([drawer]) .header { display: none; }
    .nav-actions {
      display: flex;
      flex-direction: column;
      flex: none;
      gap: var(--ui-space-1);
      padding: var(--ui-space-5) var(--ui-space-3) 0;
    }
    .tab-content {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 0 var(--ui-space-3) var(--ui-space-6);
    }
    .footer {
      flex: none;
      padding: var(--ui-space-4) var(--ui-space-3) var(--ui-space-5);
      border-top: 1px solid var(--ui-border);
    }
  `;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  @property({ type: Boolean }) newChatActive = false;
  @property({ type: Boolean }) terminalActive = false;
  @property({ type: Boolean }) jobsActive = false;
  @property({ type: Boolean }) connectionsActive = false;
  @property({ type: Boolean }) skillsActive = false;
  @property({ type: String }) selectedSDKChat = '';

  /**
   * Render as the narrow-mode DRAWER rather than as the desktop column.
   *
   * Presentation only — the content is identical, which is the whole claim of
   * Surface 1: the drawer IS this component, in a different container. Two
   * things change, both because of what is around it rather than what is in
   * it:
   *
   *   - the header goes. The nav bar directly above already carries the
   *     instance label and the launcher, and the header's 26x22 launcher
   *     button is half a touch target.
   *   - "+ New workspace" pins OUTSIDE the scroller. In a 340px drawer with
   *     four workspaces it is otherwise below the fold, which is the one
   *     thing a muscle-memory target cannot be.
   */
  @property({ type: Boolean, reflect: true }) drawer = false;

  /**
   * False when these cards are not on screen — i.e. a closed drawer (D6).
   *
   * `preview-store` already refuses to run the 6 Hz live tick in a hidden
   * TAB, but a closed drawer is the same condition with the tab visible, so
   * that gate never fires and a phone would repaint canvases nobody can see,
   * on a battery. The store's ticker is also gated on having at least one
   * subscriber, so the cheapest correct implementation of "gate on visible &&
   * (isWide || drawerOpen)" is for this component to stop being a subscriber
   * — which needs no change to preview-store at all.
   *
   * Defaults to true: the desktop column is always on screen.
   */
  @property({ type: Boolean }) previewsVisible = true;
  /** Wide workspace chrome provides the launcher in its top title bar. */
  @property({ type: Boolean }) showLauncher = true;

  @state() private _version = 0;
  @state() private _renaming: string | null = null;

  /**
   * Tile width in columns, derived from the measured card. 0 = not measured
   * yet. Reactive because the canvas element's CSS size comes out of the
   * template — but it only ever changes on a debounced resize, never per tick.
   */
  @state() private _cols = 0;

  /** Server-reported update status; null until the first check resolves. */
  @state() private _updateStatus: UpdateStatus | null = null;

  /** Host groups the user explicitly collapsed during this page session. */
  @state() private _collapsed = new Set<string>();

  /** User-authored workspace order. Machine membership never changes here;
   *  the array only ranks siblings and is durable across reloads. */
  private _workspaceOrder: string[] = (() => {
    try {
      const value = JSON.parse(localStorage.getItem('muxterm.sidebar.workspace-order') ?? '[]');
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  })();
  @state() private _draggingWorkspace: string | null = null;
  @state() private _dropBeforeWorkspace: string | null = null;
  private _dragJustEnded = false;

  /** Hosts already given their default collapse state. Not reactive. */
  private _seededHosts = new Set<string>();

  private _unsub: (() => void) | null = null;
  private _unsubRemotes: (() => void) | null = null;
  /** 1 Hz clock, live ONLY while a `.stale-banner` age is on screen. */
  private _ageTimer: number | null = null;
  /** Set by the render that just ran: is any banner age displayed? */
  private _ageTicking = false;

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

  @state() private _previewWorkspaceId: string | null = null;
  @state() private _previewState: 'hidden' | 'loading' | 'ready' | 'unavailable' = 'hidden';
  @state() private _previewEntry: PreviewEntry | null = null;
  @state() private _previewMessage = '';
  private _previewAbort: AbortController | null = null;
  private _previewTimer: number | null = null;
  private _previewDismissTimer: number | null = null;
  private _previewGeneration = 0;
  private _previewTooltipHovered = false;
  private _previewVisualViewport: VisualViewport | null = null;
  /** Touch activation focuses the row before its click; do not treat that as keyboard intent. */
  private _touchFocusGuard = false;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('muxterm-update-checked', this._onUpdateChecked);

    // Subscribe to store changes and trigger re-render by bumping _version.
    this._unsub = store.subscribe(() => {
      this._version++;
    });

    // Session state (Start card total + per-workspace badges). Low rate — one
    // frame per session state change — so a plain re-render is the right cost.
    this._unsubSessions = homeSessions.subscribe(() => {
      this._version++;
    });

    // Per-host connection state. One frame per transition, so a plain
    // re-render is right here too. A browser with no remotes never receives
    // one, so this callback never fires and the sidebar renders exactly as it
    // does today.
    this._seedCollapsed();
    this._unsubRemotes = remotesStore.subscribe(() => {
      this._seedCollapsed();
      this._version++;
    });

    // One probe per page, remembered. Until it resolves we render the preview
    // layout but draw nothing; if it resolves false every card falls back to
    // the text layout permanently.
    if (previewFontOk === null) {
      void probePreviewFont().then(() => {
        this._version++;
      });
    }
    window.addEventListener('keydown', this._onPreviewKeyDown, true);
    window.addEventListener('resize', this._onPreviewViewportChange);
    window.addEventListener('scroll', this._onPreviewViewportChange, true);
    this._previewVisualViewport = window.visualViewport;
    this._previewVisualViewport?.addEventListener('resize', this._onPreviewViewportChange);
    this._previewVisualViewport?.addEventListener('scroll', this._onPreviewViewportChange);
  }

  override disconnectedCallback(): void {
    window.removeEventListener('muxterm-update-checked', this._onUpdateChecked);
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
    this._unsubPreview?.();
    this._unsubPreview = null;
    this._unsubSessions?.();
    this._unsubSessions = null;
    this._unsubRemotes?.();
    this._unsubRemotes = null;
    window.removeEventListener('keydown', this._onPreviewKeyDown, true);
    window.removeEventListener('resize', this._onPreviewViewportChange);
    window.removeEventListener('scroll', this._onPreviewViewportChange, true);
    this._previewVisualViewport?.removeEventListener('resize', this._onPreviewViewportChange);
    this._previewVisualViewport?.removeEventListener('scroll', this._onPreviewViewportChange);
    this._previewVisualViewport = null;
    this._dismissPreview(true);
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (this._resizeTimer !== null) {
      window.clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
    if (this._ageTimer !== null) {
      window.clearInterval(this._ageTimer);
      this._ageTimer = null;
    }
    this._canvases.clear();
    this._cards = [];
  }

  override firstUpdated(): void {
    this._observeCardWidth();
    void fetchUpdateStatus()
      .then((status) => {
        this._updateStatus = status;
      })
      .catch(() => {
        // Status unknown (offline, old server): the footer stays empty.
      });
  }

  /**
   * Canvas refs are collected here, after Lit has committed the DOM, and the
   * tiles are drawn imperatively. The preview tick then reuses these refs
   * without going through Lit at all.
   */
  override updated(changed: Map<PropertyKey, unknown>): void {
    this._collectCanvases();
    this._paintAll(this._cards);
    this._syncAgeTicker();
    if (this._previewState !== 'hidden') {
      void this.updateComplete.then(() => {
        if (this._previewState !== 'hidden') this._positionPreviewTooltip();
      });
    }
  }

  /**
   * The `.stale-banner` says "Disconnected 12s ago", which is only true if
   * something advances it. Gated on the render having produced one, so with
   * no remotes — and with remotes that are all connected — there is no timer
   * at all rather than a second-by-second re-render nobody can see.
   */
  private _syncAgeTicker(): void {
    const want = this._ageTicking;
    if (want === (this._ageTimer !== null)) return;
    if (want) {
      this._ageTimer = window.setInterval(() => {
        this._version++;
      }, 1000);
    } else if (this._ageTimer !== null) {
      window.clearInterval(this._ageTimer);
      this._ageTimer = null;
    }
  }

  /** Record newly seen remotes without moving or collapsing their groups. */
  private _seedCollapsed(): void {
    for (const host of remotesStore.hosts) {
      if (this._seededHosts.has(host.id)) continue;
      this._seededHosts.add(host.id);
    }
  }

  /**
   * D6's gate, expressed as "am I a preview subscriber?".
   *
   * preview-store.ts's `_syncTicker()` already runs the 6 Hz rAF loop only
   * while `_subscribers.size > 0`, and `subscribe()`/its disposer both call
   * it — so dropping the subscription while the drawer is shut stops the tick
   * outright rather than merely ignoring it. The daemon's PUSHED tiles are
   * unaffected: they are event-driven and keep landing in the store, so the
   * cards are current the moment the drawer opens again.
   */
  private _syncPreviewSubscription(): void {
    const want = this.previewsVisible;
    if (want === (this._unsubPreview !== null)) return;
    if (want) {
      this._unsubPreview = previewStore.subscribe(this._onPreviewTick);
      // Tiles moved on while we were not listening, and the cards were
      // display:none so nothing measured. Re-render once on the way back in.
      this._version++;
    } else {
      this._unsubPreview?.();
      this._unsubPreview = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Self-update
  // ---------------------------------------------------------------------------

  private _onUpdateChecked = (event: Event): void => {
    this._updateStatus = (event as CustomEvent<UpdateStatus>).detail;
  };

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
    const cards = this._orderedCards(this._computeCards());
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
        completion: ws.completion ?? null,
        lanes: homeSessions.sessions.filter((session) => session.workspaceId === id)
          .map((session) => `${session.name} · p${session.paneId ?? '?'}`),
        sessionState:
          homeSessions.sessions.find((session) => session.workspaceId === id && session.state === 'blocked')?.state ??
          homeSessions.sessions.find((session) => session.workspaceId === id && session.state === 'working')?.state ??
          homeSessions.sessions.find((session) => session.workspaceId === id && session.state === 'failed')?.state ??
          homeSessions.sessions.find((session) => session.workspaceId === id)?.state ??
          null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Workspace helpers
  // ---------------------------------------------------------------------------

  private _anchorForPreview(workspaceId: string): HTMLElement | null {
    for (const row of this.shadowRoot?.querySelectorAll<HTMLElement>('.ws-card[data-workspace-id]') ?? []) {
      if (row.dataset['workspaceId'] === workspaceId) return row;
    }
    return null;
  }

  private _clearPreviewTimers(): void {
    if (this._previewTimer !== null) {
      window.clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
    if (this._previewDismissTimer !== null) {
      window.clearTimeout(this._previewDismissTimer);
      this._previewDismissTimer = null;
    }
  }

  private _dismissPreview(immediate: boolean): void {
    this._clearPreviewTimers();
    if (!immediate && this._previewTooltipHovered) return;
    this._previewGeneration++;
    this._previewAbort?.abort();
    this._previewAbort = null;
    const tooltip = this.shadowRoot?.querySelector<HTMLElement>('[data-workspace-preview-tooltip]');
    try {
      tooltip?.hidePopover();
    } catch {
      // Older browsers may not implement the Popover API.
    }
    this._previewWorkspaceId = null;
    this._previewEntry = null;
    this._previewMessage = '';
    this._previewState = 'hidden';
  }

  private _schedulePreviewDismiss(): void {
    this._clearPreviewTimers();
    this._previewDismissTimer = window.setTimeout(() => {
      this._previewDismissTimer = null;
      if (!this._previewTooltipHovered) this._dismissPreview(true);
    }, 140);
  }

  private _beginPreview(workspaceId: string): void {
    if (previewStore.mode === 'off') return;
    this._clearPreviewTimers();
    if (
      this._previewWorkspaceId === workspaceId &&
      this._previewState !== 'hidden' &&
      this._previewState !== 'unavailable'
    ) return;
    this._previewGeneration++;
    const generation = this._previewGeneration;
    this._previewAbort?.abort();
    const controller = new AbortController();
    this._previewAbort = controller;
    this._previewWorkspaceId = workspaceId;
    this._previewEntry = null;
    this._previewMessage = '';
    this._previewState = 'loading';
    this._previewTimer = window.setTimeout(() => {
      this._previewTimer = null;
      if (generation !== this._previewGeneration || !this._anchorForPreview(workspaceId)) return;
      void this._loadPreview(workspaceId, generation, controller.signal);
    }, 150);
  }

  private async _loadPreview(workspaceId: string, generation: number, signal: AbortSignal): Promise<void> {
    try {
      const entry = await previewStore.request(workspaceId, signal);
      if (generation !== this._previewGeneration || signal.aborted) return;
      if (!entry || entry.tile.cols <= 0 || entry.tile.rows <= 0) throw new Error('Preview unavailable');
      if (!(await fontReady())) throw new Error('Preview unavailable');
      if (generation !== this._previewGeneration || signal.aborted) return;
      this._previewEntry = entry;
      this._previewState = 'ready';
      this._previewMessage = '';
    } catch {
      if (generation !== this._previewGeneration || signal.aborted) return;
      this._previewEntry = null;
      this._previewMessage = 'Preview unavailable';
      this._previewState = 'unavailable';
    }
  }

  private _onPreviewPointerEnter = (event: PointerEvent, workspaceId: string): void => {
    if (event.pointerType === 'touch') return;
    this._beginPreview(workspaceId);
  };

  private _onPreviewPointerDown = (event: PointerEvent): void => {
    this._touchFocusGuard = event.pointerType === 'touch';
  };

  private _onPreviewPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') this._touchFocusGuard = false;
  };

  private _onPreviewPointerLeave = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    this._schedulePreviewDismiss();
  };

  private _onPreviewFocusIn = (_event: FocusEvent, workspaceId: string): void => {
    if (this._touchFocusGuard) return;
    this._beginPreview(workspaceId);
  };

  private _onPreviewFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && (event.currentTarget as HTMLElement).contains(next)) return;
    this._dismissPreview(true);
  };

  private _onPreviewKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') {
      this._touchFocusGuard = false;
      return;
    }
    if (event.key === 'Escape' && this._previewState !== 'hidden') {
      event.preventDefault();
      event.stopPropagation();
      this._dismissPreview(true);
    }
  };

  private _onPreviewViewportChange = (): void => {
    if (this._previewState !== 'hidden') this._dismissPreview(true);
  };

  private _onPreviewTooltipEnter = (): void => {
    this._previewTooltipHovered = true;
    if (this._previewDismissTimer !== null) {
      window.clearTimeout(this._previewDismissTimer);
      this._previewDismissTimer = null;
    }
  };

  private _onPreviewTooltipLeave = (): void => {
    this._previewTooltipHovered = false;
    this._schedulePreviewDismiss();
  };

  private _paintPreviewTooltip(): void {
    const entry = this._previewEntry;
    const canvas = this.shadowRoot?.querySelector<HTMLCanvasElement>('[data-workspace-preview-canvas]');
    if (!entry || !canvas) return;
    const naturalW = entry.tile.cols * PREVIEW_CELL.w;
    const naturalH = entry.tile.rows * PREVIEW_CELL.h;
    const viewport = window.visualViewport;
    const maxOuterW = Math.max(80, (viewport?.width ?? window.innerWidth) - 24);
    const maxOuterH = Math.max(48, (viewport?.height ?? window.innerHeight) - 24);
    // The tooltip contributes 16px of padding; calculate the fit before
    // rendering so renderTile bounds the native backing grid as well as CSS.
    const scale = Math.min(
      1,
      Math.max(1 / naturalW, (maxOuterW - 16) / naturalW),
      Math.max(1 / naturalH, (maxOuterH - 16) / naturalH),
    );
    const palette = resolvePalette(store.config.theme.palette);
    renderTile(canvas, entry.tile, {
      palette: paletteAnsiArray(palette),
      fg: palette.foreground,
      bg: palette.background,
      contrastFloor: 0,
      mono: false,
      scale,
    });
  }

  private _positionPreviewTooltip(): void {
    const tooltip = this.shadowRoot?.querySelector<HTMLElement>('[data-workspace-preview-tooltip]');
    const workspaceId = this._previewWorkspaceId;
    if (!tooltip || !workspaceId) return;
    if (this._previewState === 'ready') this._paintPreviewTooltip();
    const anchor = this._anchorForPreview(workspaceId);
    if (!anchor) {
      this._dismissPreview(true);
      return;
    }
    try {
      tooltip.showPopover();
    } catch {
      // The fixed fallback still provides the preview on older browsers.
    }
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? window.innerWidth);
    const bottom = top + (viewport?.height ?? window.innerHeight);
    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    let x = anchorRect.right + 8;
    let y = anchorRect.top;
    if (x + tooltipRect.width > right - 8) x = anchorRect.left - tooltipRect.width - 8;
    if (x < left + 8) x = Math.min(right - tooltipRect.width - 8, anchorRect.left);
    if (y + tooltipRect.height > bottom - 8) y = bottom - tooltipRect.height - 8;
    y = Math.max(top + 8, y);
    tooltip.style.left = `${Math.max(left + 8, x)}px`;
    tooltip.style.top = `${y}px`;
  }

  private _renderPreviewTooltip() {
    if (this._previewState === 'hidden') return '';
    return html`
      <div
        id="workspace-preview-tooltip"
        class="preview-tooltip"
        popover="manual"
        role="tooltip"
        data-workspace-preview-tooltip
        data-workspace-preview-state="${this._previewState}"
        @pointerenter="${this._onPreviewTooltipEnter}"
        @pointerleave="${this._onPreviewTooltipLeave}"
      >
        <div class="preview-tooltip-frame">
          ${this._previewState === 'ready'
            ? html`<canvas data-workspace-preview-canvas></canvas>`
            : html`<span class="preview-tooltip-message">${this._previewState === 'loading' ? 'Loading preview…' : this._previewMessage}</span>`}
        </div>
      </div>
    `;
  }

  private _onWsClick(wsId: string): void {
    if (this._dragJustEnded) {
      this._dragJustEnded = false;
      return;
    }
    this._touchFocusGuard = false;
    this._dismissPreview(true);
    store.ackWorkspace(wsId);
    this.dispatchEvent(
      new CustomEvent('workspace-switch', {
        detail: { workspaceId: wsId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _orderedCards(cards: CardState[]): CardState[] {
    const rank = new Map(this._workspaceOrder.map((id, index) => [id, index]));
    return cards
      .map((card, index) => ({ card, index }))
      .sort((a, b) => {
        const ar = rank.get(a.card.id);
        const br = rank.get(b.card.id);
        if (ar === undefined && br === undefined) return a.index - b.index;
        if (ar === undefined) return 1;
        if (br === undefined) return -1;
        return ar - br;
      })
      .map(({ card }) => card);
  }

  private _onWorkspaceDragStart(event: DragEvent, workspaceId: string): void {
    this._dismissPreview(true);
    this._draggingWorkspace = workspaceId;
    event.dataTransfer?.setData('text/plain', workspaceId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  private _onWorkspaceDragOver(event: DragEvent, workspaceId: string): void {
    const source = this._draggingWorkspace;
    if (!source || source === workspaceId) return;
    if (parseHostRef(source).host !== parseHostRef(workspaceId).host) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this._dropBeforeWorkspace = workspaceId;
  }

  private _onWorkspaceDrop(event: DragEvent, workspaceId: string): void {
    event.preventDefault();
    const source = this._draggingWorkspace;
    if (!source || source === workspaceId) return this._onWorkspaceDragEnd();
    const cards = this._orderedCards(this._computeCards());
    const host = parseHostRef(source).host;
    const siblings = cards.filter((card) => parseHostRef(card.id).host === host).map((card) => card.id);
    const from = siblings.indexOf(source);
    const to = siblings.indexOf(workspaceId);
    if (from < 0 || to < 0) return this._onWorkspaceDragEnd();
    siblings.splice(from, 1);
    siblings.splice(siblings.indexOf(workspaceId), 0, source);
    const siblingSet = new Set(siblings);
    const others = this._workspaceOrder.filter((id) => !siblingSet.has(id));
    this._workspaceOrder = [...others, ...siblings];
    localStorage.setItem('muxterm.sidebar.workspace-order', JSON.stringify(this._workspaceOrder));
    this._version++;
    this._onWorkspaceDragEnd();
  }

  private _onWorkspaceDragEnd(): void {
    if (this._draggingWorkspace) this._dragJustEnded = true;
    this._draggingWorkspace = null;
    this._dropBeforeWorkspace = null;
  }

  /**
   * A host group's own "+ New workspace" — the ONLY create affordance in the
   * list, once per group, local group included.
   *
   * The group IS the choice of machine (Decision 3) — there is no picker to
   * open and no host to guess. `host` is '' for the local group, and app.ts
   * resolves a missing `detail.host` and an explicit '' to the same empty
   * string, so local create is byte-identical to what the old root-level
   * button sent; the button only moved to the machine it always created on.
   */
  private _onNewWsOn(host: string): void {
    this.dispatchEvent(
      new CustomEvent('workspace-create', {
        detail: { host },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Retry a dropped host now instead of waiting out the backoff.
   *
   * One door, POST, already idempotent: reconnecting is the server's job and
   * this only asks it to stop waiting. There is no local success state to
   * keep — the answer arrives as the next host-state frame, which is the same
   * path an automatic reconnect takes.
   */
  private _onRetryHost(e: Event, hostId: string): void {
    e.stopPropagation();
    void fetch(apiPath(`/api/remotes/${encodeURIComponent(hostId)}/connect`), {
      method: 'POST',
    }).catch(() => {
      // Offline, or the server is gone. The reconnect loop is still running
      // on its own schedule; inventing an error state here would claim this
      // click was the only thing that could have worked.
    });
  }

  private _toggleGroup(host: string): void {
    const next = new Set(this._collapsed);
    if (!next.delete(host)) next.add(host);
    this._collapsed = next;
  }

  private _onGroupKeyDown(e: KeyboardEvent, host: string): void {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    this._toggleGroup(host);
  }

  /** Every machine starts open; only an explicit user toggle collapses it. */
  private _isCollapsed(host: string): boolean {
    return this._collapsed.has(host);
  }

  private _onWsRemove(e: Event, wsId: string, name: string): void {
    e.stopPropagation();
    this._touchFocusGuard = false;
    this._dismissPreview(true);
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
    const dotClass = card.bell ? 'bell' : card.sessionState ?? (card.active ? 'active' : 'inactive');
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
              title="${card.lanes.length ? `${card.label}: ${card.lanes.join(', ')}` : card.label}"
              >${card.label}${card.lanes.length ? html`<span class="ws-lane"> · ${card.lanes[0]}${card.lanes.length > 1 ? ` +${card.lanes.length - 1}` : ''}</span>` : ''}</span
            >`}
        <span class="ws-panes" aria-label="${card.paneCount} panes">${card.paneCount}</span>
        <button
          type="button"
          class="ws-remove-btn"
          title="${card.completion ? 'Dismiss finished lane' : 'Close workspace'}"
          aria-label="${card.completion
            ? `Dismiss finished lane ${card.completion.lane}`
            : `Close workspace ${card.label}`}"
          @click="${(e: Event) => this._onWsRemove(e, card.id, card.label)}"
        >×</button>
      </div>
    `;
  }

  /**
   * The finished-lane chip: verdict, PR, and the lane's own name.
   *
   * It takes the slot the pane count would occupy, because "0 panes" on a
   * workspace whose lane just finished is the least useful sentence the
   * sidebar could say. The `title` attribute carries the summary and the tail
   * of the lane's final output, so the completion record is READABLE from the
   * notification itself rather than only being discoverable elsewhere.
   *
   * The verdict word is never softened: a lane that crashed says `failed` and
   * a lane that exited with no verdict says `no verdict`. A badge that reads
   * the same for a success and a startup crash would be worse than nothing,
   * because it would be believed.
   */
  private _renderCompletion(completion: SessiondWorkspaceCompletion) {
    const verdict =
      completion.outcome === 'completed'
        ? 'done'
        : completion.outcome === 'failed'
          ? 'failed'
          : completion.outcome === 'stopped'
            ? 'stopped'
            : 'no verdict';
    const detail = [
      `${completion.lane}: ${completion.summary || verdict}`,
      completion.prUrl ? `\n${completion.prUrl}` : '',
      completion.output ? `\n\n${completion.output}` : '',
    ].join('');
    return html`<span
      class="ws-completion ${completion.outcome}"
      role="status"
      aria-label="Lane ${completion.lane} ${verdict}"
      title="${detail}"
      >${verdict}${completion.pr ? html` #${completion.pr}` : ''}</span
    >`;
  }

  /**
   * `remote ` when this workspace lives on another machine, `''` when it does
   * not — and `''` is every workspace until a remote is connected, which is
   * what keeps the class attribute byte-identical to today's.
   */
  private _remoteClass(card: CardState): string {
    return isRemoteId(card.id) ? 'remote ' : '';
  }

  /** Previews off, or the bitmap font failed: today's exact card. */
  private _renderTextCard(card: CardState) {
    const dragging = this._draggingWorkspace === card.id;
    const dropBefore = this._dropBeforeWorkspace === card.id;
    return html`
      <div
        class="ws-card ${this._remoteClass(card)}${card.active ? 'active ' : ''}${card.sessionState === 'working' ? 'live ' : ''}${dragging ? 'dragging ' : ''}${dropBefore ? 'drop-before' : ''}"
        data-workspace-id="${card.id}"
        draggable="true"
        role="button"
        tabindex="0"
        aria-describedby="${this._previewWorkspaceId === card.id && this._previewState !== 'hidden'
          ? 'workspace-preview-tooltip'
          : ''}"
        @pointerdown="${this._onPreviewPointerDown}"
        @pointercancel="${this._onPreviewPointerCancel}"
        @pointerenter="${(e: PointerEvent) => this._onPreviewPointerEnter(e, card.id)}"
        @pointerleave="${this._onPreviewPointerLeave}"
        @dragstart="${(e: DragEvent) => this._onWorkspaceDragStart(e, card.id)}"
        @dragover="${(e: DragEvent) => this._onWorkspaceDragOver(e, card.id)}"
        @drop="${(e: DragEvent) => this._onWorkspaceDrop(e, card.id)}"
        @dragend="${() => this._onWorkspaceDragEnd()}"
        @focusin="${(e: FocusEvent) => this._onPreviewFocusIn(e, card.id)}"
        @focusout="${this._onPreviewFocusOut}"
        @keydown="${(e: KeyboardEvent) => {
          if (e.key === 'Escape') this._onPreviewKeyDown(e);
          else if (
            (e.key === 'Enter' || e.key === ' ') &&
            !(e.target as Element).closest('button,input')
          ) {
            e.preventDefault();
            this._onWsClick(card.id);
          }
        }}"
        @click="${() => this._onWsClick(card.id)}"
      >
        ${this._renderHeader(card)}
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
        class="ws-card preview ${compact ? 'compact' : 'full'} ${this._remoteClass(card)}${card.active ? 'active' : ''}"
        @click="${() => this._onWsClick(card.id)}"
      >
        ${this._renderHeader(card)}
        <div class="ws-screen" style="height:${tileH}px">${body}</div>
        ${chip}
      </div>
    `;
  }

  /** One machine's section: header, then its cards (ux D1). */
  private _renderHostGroup(
    group: HostGroup,
  ) {
    const collapsed = this._isCollapsed(group.host);
    const remote = group.host !== '';
    // Local has no connection state, so it is never stale (ux D2).
    const stale = group.state !== null && group.state !== 'connected';
    // "Disconnected 12s ago" is a statement about a link that was up. A host
    // that has never connected has nothing to count from.
    const dropped =
      group.state === 'reconnecting' || group.state === 'unreachable';
    if (dropped) this._ageTicking = true;

    const headClass = ['hg-head', collapsed ? 'collapsed' : '']
      .filter(Boolean)
      .join(' ');
    const bodyClass = ['hg-body', collapsed ? 'hidden' : '', stale ? 'stale' : '']
      .filter(Boolean)
      .join(' ');

    return html`
      <div class="hostgroup">
        <div
          class="${headClass}"
          role="button"
          tabindex="0"
          aria-expanded="${collapsed ? 'false' : 'true'}"
          @click="${() => this._toggleGroup(group.host)}"
          @keydown="${(e: KeyboardEvent) => this._onGroupKeyDown(e, group.host)}"
        >
          <div class="hg-ident">
            <span class="hg-name ${remote ? 'remote' : ''}">${group.name}</span>
            <span class="hg-type">${hostTypeLabel(group.host)}</span>
          </div>
          <span class="hg-status ${group.state ?? 'local'}">${group.state ?? 'local'}</span>
          <span class="hg-chev" aria-hidden="true">${icon(ChevronDown, { size: 13 })}</span>
          <button
            type="button"
            class="hg-remove-btn"
            title="Machine action — meaning undecided"
            aria-label="Machine action unavailable"
            @click="${(e: Event) => e.stopPropagation()}"
          >×</button>
        </div>
        <div class="${bodyClass}">
          ${dropped
            ? html`<div class="stale-banner">
                <span class="spin">⟳</span>
                <span>Disconnected ${ageLabel(Date.now() - group.since)} ago</span>
                <button
                  class="retry-btn"
                  @click="${(e: Event) => this._onRetryHost(e, group.host)}"
                >retry</button>
              </div>`
            : ''}
          ${group.cards.map((card) => this._renderTextCard(card))}
          <button
            class="new-ws-btn${remote ? ' remote' : ''}"
            @click="${() => this._onNewWsOn(group.host)}"
          >
            ＋ New workspace on ${group.name}
          </button>
        </div>
      </div>
    `;
  }

  private _renderWorkspaces() {
    const cols = this._cols;
    // Recorded so the preview tick can tell a structural change from a mere
    // content change without re-rendering to find out.
    const cards = this._orderedCards(this._computeCards());
    this._cards = cards;
    this._cardSig = cardsSignature(cards, previewStore.mode, cols);

    // Recomputed every render: a host that stopped being dropped must stop
    // the 1 Hz clock, and only the render knows.
    this._ageTicking = false;

    // Once the list is grouped, EVERY "+ New workspace" lives inside the group
    // it creates on -- local included. A bottom one would be the local group's
    // button orphaned below every remote group, reading as a second, duplicate
    // copy of the remote group's own button directly above it. The only thing
    // that belongs after the groups is the affordance that adds a NEW group.
    const groups = groupCards(cards, instanceLabel());
    return html`<div class="workspace-groups ${cards.length >= 20 ? 'busy' : ''}">
      ${groups.map((group) => this._renderHostGroup(group))}
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Footer render
  // ---------------------------------------------------------------------------

  private _renderFooter() {
    const version = this._updateStatus?.currentVersion;
    const description = version ? version.startsWith('v') ? version : `v${version}` : '';
    return html`<div class="footer"><mux-ui-nav-item label="Settings" description=${description}
      @click=${() => this.dispatchEvent(new CustomEvent('launcher-action', { detail: { action: 'settings' }, bubbles: true, composed: true }))}>
      <span slot="icon">${icon(Settings, { size: 16 })}</span>
    </mux-ui-nav-item></div>`;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  override render() {
    void this._version; // suppress unused-variable lint; triggers re-render on store change

    const navActions = [
      { label: 'New Chat', icon: Plus, active: this.newChatActive, event: 'chat-new' },
      { label: 'Terminal', icon: SquareTerminal, active: this.terminalActive, event: 'terminal-open' },
      { label: 'Scheduled jobs', icon: CalendarClock, active: this.jobsActive, event: 'jobs-open' },
      { label: 'Connections', icon: Plug, active: this.connectionsActive, event: 'connections-open' },
      { label: 'Skills', icon: Puzzle, active: this.skillsActive, event: 'skills-open' },
    ];

    return html`
      <div class="header">
        <span title="${window.location.hostname}">${instanceLabel()}</span>
      </div>
      <nav class="nav-actions" aria-label="Sidebar actions">
        ${navActions.map(action => html`
          <mux-ui-nav-item label=${action.label} ?active=${action.active} @click=${() => this.dispatchEvent(new CustomEvent(action.event, { bubbles: true, composed: true }))}>
            <span slot="icon">${icon(action.icon, { size: 16 })}</span>
          </mux-ui-nav-item>
        `)}
      </nav>
      <div class="tab-content">
        <mux-chat-list .selectedSession=${this.selectedSDKChat}></mux-chat-list>
      </div>
      ${this._renderFooter()}
      ${this._renderPreviewTooltip()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-sidebar': MuxSidebar;
  }
}
