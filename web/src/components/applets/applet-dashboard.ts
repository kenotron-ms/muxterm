/**
 * applet-dashboard.ts -- the fleet, as an applet.
 *
 * This is <mux-cos>'s right-hand column, moved wholesale and otherwise
 * unchanged: the same store, the same grouping, the same fixed-height cards,
 * the same `home-open` event. Nothing about how it LOOKS is new here. What is
 * new is three things the applet contract asks for:
 *
 *   1. IT GOES QUIET WHEN INACTIVE. The host keeps every applet mounted, so
 *      an applet that kept its subscription would keep re-rendering a hidden
 *      tree forever. _sync() is the whole rule: subscribed while active and
 *      connected, unsubscribed otherwise. Nothing else in here polls, ticks
 *      or animates, so an inactive Dashboard costs exactly nothing.
 *
 *   2. IT OWNS ITS OWN CONTROL. cards|tiles used to sit in the surface's
 *      topbar, where it was the only control there and meant nothing to
 *      anything but the fleet. It is now this applet's `rail`, painted by the
 *      host in the host's vocabulary at the end of the tab strip.
 *
 *   3. IT KEEPS THE SHEET'S JOB. Portrait renders a SECOND instance of this
 *      element inside <mux-cos>'s bottom sheet, with `insheet` set. That flag
 *      is what suppresses terminal thumbnails (a tile needs width to say
 *      anything) and hands the scroller back to the sheet.
 *
 * TOKENS ARE NOT RE-DECLARED. --ink-*, --edge, --surface, --need/--work/--ok/
 * --fail, --mono and the --r/--s/--t/--lh scales are all declared on
 * <mux-cos>'s :host, and custom properties inherit into shadow roots
 * (theme.ts:349), so they arrive here for free and cannot drift. Only
 * --meta-h/--thumb-h are declared below, because they are not theme at all --
 * they are THIS grid's fixed-height contract, and they belong with the grid.
 */

import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LayoutGrid, Rows3 } from 'lucide';
import { icon } from '../../lib/icons.js';
import { registerApplet, type AppletElement } from '../../lib/applet-registry.js';
import { homeSessions } from '../../lib/home-sessions.js';
import {
  HOME_GROUPS,
  groupFor,
  isKnownHarness,
  type HomeGroup,
  type SessionState,
} from '../../lib/session-state.js';
import { tileLinesFor } from '../../lib/home-tile.js';

/** Which way the fleet draws itself. Desktop only -- portrait is cards. */
export type FleetView = 'cards' | 'tiles';

/**
 * localStorage, not the server config -- mux-home's VIEW_KEY reasoning
 * verbatim: this is a per-eyeball display preference with no server-side
 * meaning, and config.toml would make it machine-wide.
 *
 * NAMESPACED under the applet that owns it. The old key was flat
 * ('muxterm.dashboard.fleetView'), which was fine while the Dashboard was the
 * whole surface and stops being fine the moment a second applet wants a
 * preference of its own -- at which point the flat spelling is already a
 * convention and every later key inherits the ambiguity. Renaming it now,
 * while there is exactly one, costs a five-line migration; renaming it later
 * costs an argument.
 */
const VIEW_KEY = 'muxterm.applet.dashboard.view';

/** The pre-applet spelling. Read once, rewritten, and removed. */
const LEGACY_VIEW_KEY = 'muxterm.dashboard.fleetView';

function loadView(): FleetView {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    if (stored === 'tiles' || stored === 'cards') return stored;
    // ONE-TIME MIGRATION: whoever had picked tiles keeps tiles.
    const legacy = localStorage.getItem(LEGACY_VIEW_KEY);
    if (legacy === 'tiles' || legacy === 'cards') {
      localStorage.setItem(VIEW_KEY, legacy);
      localStorage.removeItem(LEGACY_VIEW_KEY);
      return legacy;
    }
  } catch {
    /* private mode / storage disabled: still usable, just not sticky */
  }
  return 'cards';
}

function saveView(v: FleetView): void {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* not sticky; not fatal */
  }
}

/**
 * The group headings, in the mockup's words.
 *
 * HOME_GROUPS remains the SOURCE of the grouping -- groupFor() decides which
 * bucket a row lands in and this file never re-derives it. Only the LABEL is
 * local, because the Dashboard speaks in the second person ("wants you")
 * where a list view names a state ("Needs input"), and the mockup is the
 * approved copy.
 */
const GROUP_LABEL: Record<HomeGroup, string> = {
  'Needs input': 'wants you',
  Running: 'working',
  Completed: 'done',
};

/**
 * Left-edge state colour class -- DUPLICATED from mux-home.ts's markClass()
 * with eyes open. The class names and their colours have to live in this
 * shadow root anyway (mux-home's `.m-need` is unreachable from here), so
 * sharing the function would still leave two copies of the CSS and buy only
 * the five-line mapping. What MUST agree between the two surfaces is which
 * group a row is in, and that is groupFor() -- imported, never re-derived.
 */
function stateClass(s: SessionState): string {
  const g = groupFor(s);
  if (g === 'Needs input') return 'need';
  if (g === 'Running') return 'work';
  if (s.state === 'failed') return 'fail';
  if (s.state === 'done') return 'done';
  return '';
}

/**
 * Coarse age, mux-home's age() verbatim -- duplicated for the same reason as
 * stateClass: eight lines of formatting against a lib module for one string.
 * '' for an unset timestamp rather than "56y ago".
 */
function age(updatedAt: number, nowSec: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const d = Math.max(0, Math.floor(nowSec - updatedAt));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

/** Thumbnail geometry. Six lines is what fits the 84px thumb strip. */
const THUMB_COLS = 44;
const THUMB_ROWS = 6;

@customElement('applet-dashboard')
export class AppletDashboard extends LitElement implements AppletElement {
  /**
   * Set by <mux-applets>. FALSE means hidden but still mounted, and the
   * obligation that comes with it is _sync(): no subscription, no timer, no
   * work of any kind until it is true again.
   */
  @property({ type: Boolean }) active = false;

  /** Portrait, handed down from the host. */
  @property({ type: Boolean }) narrow = false;

  /** Deep-link target. Nothing in the fleet defines one yet; see updated(). */
  @property({ attribute: false }) target: string | null = null;

  /**
   * Rendered inside <mux-cos>'s portrait sheet rather than in the applet
   * host. Reflected so the CSS can key on it. The sheet owns the scroller and
   * portrait shows no thumbnails, and both of those are this flag.
   */
  @property({ type: Boolean, reflect: true }) insheet = false;

  /**
   * Cards or tiles. Reflected to the host so the grid's minmax and the thumb
   * strip are pure CSS -- the segmented control writes ONE attribute and the
   * layout follows, rather than every card re-rendering to a different shape.
   */
  @property({ type: String, reflect: true }) view: FleetView = loadView();

  /** Bumped by the homeSessions subscription. */
  @state() private _fleetVersion = 0;

  private _unsubFleet: (() => void) | null = null;

  /**
   * Clock for the fleet's ages. Refreshed when the fleet changes rather than
   * on a timer of its own: a row's age only becomes interesting when
   * something about the fleet moved, and mux-home takes the same reading once
   * and does not tick it at all.
   */
  private _now = Math.floor(Date.now() / 1000);

  static styles = css`
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    :host {
      display: block;
      min-width: 0;
      color: var(--ink-2);
      font-size: var(--t-ui);
      line-height: var(--lh-body);

      /* THE FIXED-HEIGHT CONTRACT. A card is exactly this tall in cards mode
         and exactly this plus the thumb strip in tiles mode, at every
         divider position. Three ellipsised lines plus their gaps plus the
         padding: 16 + 15 + 15 + 8 + 20. Written here rather than inline so
         the two modes and the mobile sheet cannot drift apart. */
      --meta-h: 74px;
      --thumb-h: 84px;
    }

    /* The icon() helper emits this class; the rule is per-shadow-root. */
    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
      pointer-events: none;
    }

    h2 {
      margin: 0;
      font-size: inherit;
      font-weight: inherit;
    }

    /* -- FLEET ------------------------------------------------------------ */
    .body {
      height: 100%;
      overflow-y: auto;
      padding: var(--s-6);
    }
    /* In the sheet the SHEET scrolls. A scroller inside a scroller is how a
       bottom sheet stops responding to the drag that opened it. */
    :host([insheet]) .body {
      height: auto;
      overflow: visible;
      padding: 0;
    }
    .grp {
      font-family: var(--mono);
      font-size: 10.5px;
      font-weight: 600;
      line-height: 1;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--ink-3);
      padding: var(--s-6) var(--s-1) var(--s-4);
    }
    .grp:first-child {
      padding-top: 0;
    }
    /* A fixture-populated fleet must never be mistaken for a live one. */
    .fx {
      font-family: var(--mono);
      font-size: var(--t-meta);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--need);
      padding: 0 var(--s-1) var(--s-4);
    }

    /* THE GRID. auto-fill + minmax is the whole reason a card's height does
       not move when the divider does: a narrower column drops a TRACK, it
       does not squeeze the cards that are left. */
    .grid {
      display: grid;
      gap: var(--s-4);
      grid-template-columns: repeat(auto-fill, minmax(214px, 1fr));
    }
    :host([view='tiles']) .grid {
      grid-template-columns: repeat(auto-fill, minmax(252px, 1fr));
    }

    .card {
      font: inherit;
      text-align: left;
      width: 100%;
      /* FIXED. Not min-height, not aspect-ratio, not content. */
      height: var(--meta-h);
      background: var(--surface);
      border: 1px solid var(--chrome-border);
      border-left: 3px solid var(--edge);
      border-radius: var(--r-card);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      cursor: pointer;
      padding: 0;
      color: var(--ink-2);
      transition: border-color var(--dur) ease, background var(--dur) ease;
    }
    :host([view='tiles']) .card {
      height: calc(var(--meta-h) + var(--thumb-h));
    }
    .card:hover {
      background: var(--chrome-hover);
    }
    .card:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }
    .card.need {
      border-left-color: var(--need);
    }
    .card.work {
      border-left-color: var(--work);
    }
    .card.done {
      border-left-color: var(--ok);
    }
    .card.fail {
      border-left-color: var(--fail);
    }
    .card .meta {
      flex: none;
      height: var(--meta-h);
      padding: 10px var(--s-5);
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
      min-width: 0;
      overflow: hidden;
    }
    /* Every line ellipsises. A line allowed to wrap is a card allowed to
       change height, and that is the one thing this grid must never do. */
    .card .n,
    .card .m,
    .card .g {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card .n {
      font-size: 12.5px;
      font-weight: 600;
      line-height: var(--lh-tight);
      color: var(--ink-1);
    }
    .card .m {
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.35;
      color: var(--ink-3);
    }
    .card .g {
      font-size: 11.5px;
      line-height: 1.35;
      color: var(--ink-2);
    }
    .thumb {
      display: none;
      flex: 1;
      min-height: 0;
      background: var(--chrome-body);
      border-top: 1px solid var(--chrome-border);
      font-family: var(--mono);
      font-size: 9.5px;
      line-height: 1.35;
      color: var(--ink-3);
      padding: 7px 9px;
      margin: 0;
      overflow: hidden;
      white-space: pre-wrap;
    }
    :host([view='tiles']) .thumb {
      display: block;
    }
    /* Portrait is CARDS ONLY -- a tile is a terminal thumbnail and needs
       width to say anything. Belt and braces with the render side, and the
       reason this lives HERE rather than on the sheet: the sheet's rule is in
       another shadow root now and cannot reach in. */
    :host([insheet]) .thumb {
      display: none;
    }

    .fzero {
      font-size: var(--t-ui);
      line-height: var(--lh-body);
      color: var(--ink-3);
      padding: var(--s-4) var(--s-1);
    }
  `;

  // -------------------------------------------------------------------------
  // The inactive rule
  // -------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    this._sync();
  }

  override disconnectedCallback(): void {
    // isConnected is already false here, so this is the unsubscribe branch.
    this._sync();
    super.disconnectedCallback();
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('active')) this._sync();
    // The contract says an applet consumes its target and clears it back to
    // null. Nothing in the fleet defines a target form yet, so consuming it
    // IS clearing it -- but it still has to be cleared, or a stale one fires
    // the next time the tab is shown.
    if (changed.has('target') && this.target !== null) this.target = null;
  }

  /**
   * THE ONE OBLIGATION the applet contract puts on an applet: hold the
   * subscription only while active AND connected, and hold nothing at all
   * otherwise. The host keeps this element mounted and merely hides it, so
   * without this an unseen Dashboard would re-render on every session change
   * for the whole life of the app.
   */
  private _sync(): void {
    const want = this.active && this.isConnected;
    if (want && !this._unsubFleet) {
      // The fleet's ONE seam -- home-sessions.ts, the same store <mux-home>,
      // the Dashboard card and the title-bar dot all read.
      this._unsubFleet = homeSessions.subscribe(this._onFleet);
      // Adopt the store's CURRENT state, not just its next change. This
      // element is kept mounted and inactive when another tab is showing (and
      // is parked wholesale by cache() when the Dashboard surface closes), so
      // every session that starts, blocks or ends while it is inactive
      // arrives unheard. Re-subscribing alone only registers for the NEXT
      // notification, so coming back rendered the fleet as it was when you
      // left -- typically "Nothing is running" -- until some unrelated change
      // forced a re-render. Reading the store on reactivation is what makes
      // lanes spawned in the meantime show up the moment you look, which is
      // the whole promise of the surface.
      this._onFleet();
      return;
    }
    if (!want && this._unsubFleet) {
      this._unsubFleet();
      this._unsubFleet = null;
    }
  }

  private _onFleet = (): void => {
    this._now = Math.floor(Date.now() / 1000);
    this._fleetVersion++;
  };

  // -------------------------------------------------------------------------
  // Intent
  // -------------------------------------------------------------------------

  /**
   * Called by the rail, which the HOST renders in the HOST's shadow root --
   * hence public, and hence the event: the host has no other way to know the
   * control it painted now says something different.
   */
  setView(v: FleetView): void {
    if (this.view === v) return;
    this.view = v;
    saveView(v);
    this.dispatchEvent(
      new CustomEvent('applet-rail-changed', { bubbles: true, composed: true }),
    );
  }

  /**
   * One session. Activation dispatches `home-open` -- byte-identical to what
   * <mux-home> fires, so app.ts's one handler opens the workspace and focuses
   * the pane for either surface. bubbles AND composed, because it now has two
   * shadow boundaries to cross: this applet's and <mux-cos>'s.
   */
  private _openPane(s: SessionState): void {
    this.dispatchEvent(
      new CustomEvent('home-open', {
        detail: { sessionId: s.sessionId, paneId: s.paneId, workspaceId: s.workspaceId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  override render(): TemplateResult {
    return html`<div class="body">${this._renderFleet()}</div>`;
  }

  /**
   * What is running, live.
   *
   * Grouping is groupFor()'s -- the SAME function <mux-home> calls, imported
   * rather than re-implemented, so the two surfaces cannot disagree about
   * what "wants you" means. HOME_GROUPS gives the order.
   */
  private _renderFleet(): TemplateResult {
    void this._fleetVersion; // read so Lit re-renders on every fleet change
    const byGroup = new Map<HomeGroup, SessionState[]>(
      HOME_GROUPS.map((g) => [g, [] as SessionState[]]),
    );
    for (const s of homeSessions.sessions) byGroup.get(groupFor(s))?.push(s);
    const total = homeSessions.sessions.length;

    if (total === 0) {
      return html`<div class="fzero">
        Nothing is running. Describe a problem on the left and the lanes it
        starts appear here.
      </div>`;
    }

    return html`
      ${homeSessions.source === 'fixture' ? html`<div class="fx">fixture</div>` : nothing}
      ${HOME_GROUPS.map((g) => {
        const members = byGroup.get(g) ?? [];
        if (members.length === 0) return nothing;
        return html`
          <h2 class="grp">${GROUP_LABEL[g]}</h2>
          <div class="grid">
            ${members.map((s) => this._renderCard(s))}
          </div>
        `;
      })}
    `;
  }

  private _renderCard(s: SessionState): TemplateResult {
    const bits: string[] = [];
    if (s.harness) bits.push(isKnownHarness(s.harness) ? s.harness : `${s.harness}?`);
    if (s.mode === 'autonomous') bits.push('autonomous');
    bits.push(s.workspaceId);
    const a = age(s.updatedAt, this._now);
    if (a) bits.push(a);
    const doing = s.doing?.trim() ?? '';
    // Portrait is cards only. Gated here as well as in CSS so a phone never
    // even builds the six lines of text it would not draw.
    const thumb = !this.insheet && this.view === 'tiles';
    return html`
      <button
        type="button"
        class="card ${stateClass(s)}"
        title="${s.name}"
        @click="${() => this._openPane(s)}"
      >
        <div class="meta">
          <div class="n">${s.label || s.name}</div>
          <div class="m">${bits.join(' \u00b7 ')}</div>
          ${doing ? html`<div class="g">${doing}</div>` : nothing}
        </div>
        ${thumb
          ? html`<pre class="thumb">${tileLinesFor(s, THUMB_COLS, THUMB_ROWS).join('\n')}</pre>`
          : nothing}
      </button>
    `;
  }
}

/**
 * The manifest. `rail` is cards|tiles -- the control that used to sit in the
 * surface's topbar, next to nothing it had anything to do with. It renders
 * into the HOST's shadow root with the HOST's `.seg` styles, and calls back
 * into this element.
 */
registerApplet({
  id: 'dashboard',
  label: 'Dashboard',
  icon: LayoutGrid,
  element: 'applet-dashboard',
  order: 10,
  rail: (el: AppletElement): TemplateResult => {
    const d = el as AppletDashboard;
    return html`
      <div class="seg" role="group" aria-label="Fleet view">
        <button
          type="button"
          class="${d.view === 'cards' ? 'on' : ''}"
          aria-pressed="${d.view === 'cards' ? 'true' : 'false'}"
          @click="${() => d.setView('cards')}"
        >${icon(Rows3, { size: 12 })} cards</button>
        <button
          type="button"
          class="${d.view === 'tiles' ? 'on' : ''}"
          aria-pressed="${d.view === 'tiles' ? 'true' : 'false'}"
          @click="${() => d.setView('tiles')}"
        >${icon(LayoutGrid, { size: 12 })} tiles</button>
      </div>
    `;
  },
});

declare global {
  interface HTMLElementTagNameMap {
    'applet-dashboard': AppletDashboard;
  }
}
