/**
 * applet-prs.ts -- every open pull request across the worktrees Mission Control
 * is showing.
 *
 * The user's complaint this exists to answer, in their words: "when a lane
 * finishes I have no idea what PRs exist". A list assembled from live sessions
 * cannot answer it -- a lane that exited takes its row, and its `pr` field,
 * with it at exactly the moment you want to know (design D2). So this applet
 * scans REPOSITORIES, not sessions, and remembers the repositories it has seen.
 *
 * THREE THINGS THE CONTRACT ASKS FOR:
 *
 *   1. IT POLLS ONLY WHILE ACTIVE. The host keeps every applet mounted, so an
 *      inactive Pull Requests must issue ZERO requests -- see _sync(), which
 *      owns both the interval and the in-flight abort.
 *
 *   2. IT OWNS ITS OWN CONTROL. `dismissed (N)` is rendered by THIS element,
 *      above its own list, from this file's styles -- not by the host, which
 *      owns only the tab strip (lib/applet-registry.ts). The DISMISS control
 *      stays where it always was: on the row, because a control that puts
 *      something away belongs next to the thing it puts away (D3.9).
 *
 *   3. IT USES THE HOST'S ONE EMPTY/ERROR IDIOM, including for `gh` not being
 *      authenticated -- which is a degraded state to SHOW, in the server's own
 *      words, not zero pull requests to imply.
 *
 * TOKENS ARE NOT RE-DECLARED. --ink-*, --edge, --surface, --need/--work/--ok/
 * --fail, --mono and the --r/--s/--t/--lh scales inherit into this shadow root
 * from <mux-cos>'s :host (theme.ts:349). Nothing here invents a colour.
 */

import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { GitPullRequest, X } from 'lucide';
import { icon } from '../../lib/icons.js';
import {
  registerApplet,
  type AppletAttentionDetail,
  type AppletElement,
} from '../../lib/applet-registry.js';
import { appletControlStyles, appletToggle } from '../../lib/applet-controls.js';
import { appletEmpty, appletError, appletStateStyles } from '../mux-applets.js';
import { fetchPRs, type PRChecks, type PRListing, type PullRequest } from '../../lib/prs-api.js';
import { homeSessions } from '../../lib/home-sessions.js';
import { isRemoteId } from '../../lib/host-ref.js';

/**
 * THE ROOTS ARE REMEMBERED, AND THAT IS THE POINT.
 *
 * Roots come from the browser: the distinct project paths of LOCAL fleet
 * sessions, UNION every root this browser has scanned before. A lane that
 * exited takes its row out of the fleet, so a scan built from the fleet alone
 * would forget that repository the moment the work finished -- which is
 * precisely the moment the pull request it opened becomes interesting.
 * Remembering the root is what keeps its repo in the scan after the lane is
 * gone.
 *
 * WHAT THIS IS NOT, named honestly: a browser-local memory dies with the
 * browser profile, is invisible to every other client, and cannot attribute a
 * pull request to the lane that opened it -- no GitHub API can answer that, and
 * only the lane knows. The durable answer is a WATCHLIST OWNED BY SESSIOND, fed
 * by `muxterm session report --pr N` (which nothing calls today) plus a repo
 * scan, delivered on the channel the fleet already pushes on -- design
 * docs/design/mission-control.md D2. This applet is deliberately the smaller
 * thing that works now, and it is shaped so the bigger one can replace its data
 * source without changing a row.
 */
const ROOTS_KEY = 'muxterm.applet.prs.roots';

/** Dismissed keys ("owner/name#number"). See dismiss() for why they never
 * come back on their own. */
const DISMISSED_KEY = 'muxterm.applet.prs.dismissed';

/** Matches prsMaxRoots in internal/server/prs_api.go, which silently drops the
 * tail: capping here means the roots that survive are the ones we chose. */
const MAX_ROOTS = 12;

/**
 * ONE MINUTE, FIXED, and only while this tab is showing.
 *
 * NOT the adaptive 20s-while-checks-are-running / 2-5min-otherwise cadence from
 * design D2: that cadence belongs to the sessiond-owned watchlist, which polls
 * on behalf of every attached browser and can afford to be clever about it.
 * A per-tab poller being clever would just mean N tabs being clever N times.
 */
const POLL_MS = 60_000;

function loadRoots(): string[] {
  try {
    const raw = localStorage.getItem(ROOTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v !== '');
  } catch {
    /* private mode, or something else wrote nonsense here: start empty */
  }
  return [];
}

function saveRoots(roots: readonly string[]): void {
  try {
    localStorage.setItem(ROOTS_KEY, JSON.stringify(roots));
  } catch {
    /* not sticky; not fatal */
  }
}

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string' && v !== ''));
  } catch {
    /* private mode, or something else wrote nonsense here: nothing dismissed */
  }
  return new Set();
}

function saveDismissed(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...keys]));
  } catch {
    /* not sticky; not fatal */
  }
}

/**
 * Coarse age, applet-dashboard's age() shape -- eight lines of formatting for
 * one string, against an ISO timestamp rather than unix seconds because that is
 * what `gh` reports. '' for anything unparseable rather than "56y".
 */
function age(updatedAt: string, nowSec: number): string {
  const ms = Date.parse(updatedAt);
  if (!Number.isFinite(ms)) return '';
  const d = Math.max(0, Math.floor(nowSec - ms / 1000));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

/** Colour class for the number and the checks chip. '' is no checks at all,
 * which is not the same claim as passing, so it gets no colour. */
function checksClass(checks: string): string {
  if (checks === 'passing') return 'b-ok';
  if (checks === 'failing') return 'b-fail';
  if (checks === 'pending') return 'b-need';
  return '';
}

/** GitHub's review decision, in this view's words and colours. An unknown
 * value renders verbatim and uncoloured rather than disappearing. */
function reviewChip(decision: string): { label: string; cls: string } {
  switch (decision) {
    case 'APPROVED':
      return { label: 'approved', cls: 'b-ok' };
    case 'CHANGES_REQUESTED':
      return { label: 'changes requested', cls: 'b-fail' };
    case 'REVIEW_REQUIRED':
      return { label: 'review required', cls: 'b-need' };
    default:
      return { label: decision.toLowerCase().replace(/_/g, ' '), cls: '' };
  }
}

@customElement('applet-prs')
export class AppletPRs extends LitElement implements AppletElement {
  /**
   * Set by <mux-applets>. FALSE means hidden but still mounted, and the
   * obligation that comes with it is _sync(): no interval, no request.
   */
  @property({ type: Boolean }) active = false;

  /** Portrait, handed down from the host. */
  @property({ type: Boolean }) narrow = false;

  /** Deep-link target. The form is `pr:<number>`; nothing dispatches one yet. */
  @property({ attribute: false }) target: string | null = null;

  /**
   * Whether the dismissed rows are showing. Public because the RAIL reads it,
   * and the rail is rendered by the host in the host's shadow root.
   */
  @state() showDismissed = false;

  @state() private _listing: PRListing | null = null;
  @state() private _error = '';
  @state() private _loading = false;
  @state() private _dismissed: ReadonlySet<string> = loadDismissed();

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _abort: AbortController | null = null;

  /**
   * Checks as of the PREVIOUS poll, keyed by "owner/name#number".
   *
   * null until the first listing lands, and that distinction is load-bearing:
   * "turned failing" is a TRANSITION, and the first poll has nothing to have
   * turned from. Seeding it silently is why opening this tab on three
   * long-since-red pull requests flags nothing -- none of that is news.
   */
  private _prevChecks: Map<string, PRChecks> | null = null;

  /** Clock for the ages. Re-read on every landing rather than ticked: a row's
   * age only becomes interesting when the poll brought something new. */
  private _now = Math.floor(Date.now() / 1000);

  /** Guard for the deferred adoption below: once per class, not per element. */
  private static _stateStylesAdopted = false;

  /**
   * The host's empty/error CSS, adopted at first construction rather than in
   * `static styles` -- this module and the host are an ES module cycle, so the
   * host's `const` is still in its temporal dead zone while this class is being
   * defined. The long version of this reasoning is in applet-files.ts.
   */
  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    const ctor = this.constructor as typeof AppletPRs;
    if (!ctor._stateStylesAdopted) {
      ctor._stateStylesAdopted = true;
      ctor.elementStyles = [...ctor.elementStyles, appletStateStyles];
    }
    return super.createRenderRoot();
  }

  static override styles = [
    appletControlStyles,
    css`
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

    .body {
      height: 100%;
      overflow-y: auto;
      padding: var(--s-6);
    }

    /* Repo heading, and the dismissed section's heading: one vocabulary. */
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

    .list {
      display: flex;
      flex-direction: column;
      gap: var(--s-4);
    }

    /* ── ONE PULL REQUEST ─────────────────────────────────────────────── */
    .pr {
      display: flex;
      align-items: stretch;
      background: var(--surface);
      border: 1px solid var(--chrome-border);
      border-left: 3px solid var(--edge);
      border-radius: var(--r-card);
      overflow: hidden;
      transition: border-color var(--dur) ease, background var(--dur) ease;
    }
    .pr:hover {
      background: var(--chrome-hover);
    }
    .pr.b-ok {
      border-left-color: var(--ok);
    }
    .pr.b-need {
      border-left-color: var(--need);
    }
    .pr.b-fail {
      border-left-color: var(--fail);
    }
    /* A dismissed row is present, quiet, and clearly put down. */
    .pr.dis {
      opacity: 0.62;
      border-style: dashed;
    }
    .core {
      flex: 1;
      min-width: 0;
      padding: 9px var(--s-5);
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .l1 {
      display: flex;
      align-items: center;
      gap: var(--s-4);
      min-width: 0;
      flex-wrap: wrap;
    }
    .num {
      flex: none;
      font-family: var(--mono);
      font-size: 11.5px;
      font-weight: 700;
      line-height: var(--lh-tight);
      font-variant-numeric: tabular-nums;
      color: var(--ink-3);
    }
    .num.b-ok {
      color: var(--ok);
    }
    .num.b-need {
      color: var(--need);
    }
    .num.b-fail {
      color: var(--fail);
    }
    .ttl {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12.5px;
      font-weight: 600;
      line-height: var(--lh-tight);
      color: var(--ink-1);
      text-decoration: none;
    }
    .ttl:hover {
      text-decoration: underline;
    }
    .ttl:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
      border-radius: var(--r-chip);
    }
    .l2 {
      display: flex;
      align-items: center;
      gap: var(--s-4);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--mono);
      font-size: 10.5px;
      line-height: var(--lh-tight);
      color: var(--ink-3);
    }

    /* ONE badge geometry; a modifier supplies colour and nothing else. */
    .badge {
      flex: none;
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: var(--lh-tight);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 1px var(--s-2);
      border: 1px solid var(--edge);
      border-radius: var(--r-chip);
      color: var(--ink-3);
      white-space: nowrap;
    }
    .badge.b-ok {
      color: var(--ok);
      background: color-mix(in srgb, var(--ok) 12%, transparent);
      border-color: color-mix(in srgb, var(--ok) 45%, transparent);
    }
    .badge.b-need {
      color: var(--need);
      background: color-mix(in srgb, var(--need) 12%, transparent);
      border-color: color-mix(in srgb, var(--need) 45%, transparent);
    }
    .badge.b-fail {
      color: var(--fail);
      background: color-mix(in srgb, var(--fail) 12%, transparent);
      border-color: color-mix(in srgb, var(--fail) 45%, transparent);
    }

    /* THE DISMISS AFFORDANCE. One target, at the trailing edge, full row
       height, so it is never hunted for and never hit on the way somewhere. */
    .dz {
      flex: none;
      width: 34px;
      border: 0;
      border-left: 1px solid var(--chrome-border);
      background: transparent;
      color: var(--ink-3);
      cursor: pointer;
      display: grid;
      place-items: center;
    }
    .dz:hover {
      background: color-mix(in srgb, var(--fail) 16%, transparent);
      color: var(--fail);
    }
    .dz:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: -2px;
    }
    .undo {
      flex: none;
      align-self: center;
      margin-right: var(--s-5);
      font: inherit;
      font-family: var(--mono);
      font-size: 10.5px;
      line-height: 1;
      color: var(--ink-2);
      background: transparent;
      border: 1px solid var(--edge);
      border-radius: var(--r-ctl);
      padding: 4px var(--s-4);
      cursor: pointer;
    }
    .undo:hover {
      color: var(--ink-1);
      border-color: var(--chrome-accent);
    }
    .undo:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }

    /* What dismissal means, in words, where it is done. */
    .dnote {
      margin: 0 0 var(--s-4);
      padding: 0 var(--s-1);
      font-size: 11.5px;
      line-height: var(--lh-body);
      color: var(--ink-3);
    }
    /* A root that did not resolve, or a poll that failed. Never hidden. */
    .note {
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: var(--lh-tight);
      color: var(--ink-3);
      padding: var(--s-3) var(--s-1) 0;
      overflow-wrap: anywhere;
    }
    .hint {
      font-size: var(--t-ui);
      line-height: var(--lh-body);
      color: var(--ink-3);
      padding: var(--s-4) var(--s-1);
    }
  `,
  ];

  // -------------------------------------------------------------------------
  // The inactive rule
  // -------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    this._sync();
  }

  override disconnectedCallback(): void {
    // isConnected is already false here, so this is the "go quiet" branch.
    this._sync();
    super.disconnectedCallback();
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('active')) this._sync();
    // The contract says an applet consumes its target and clears it back to
    // null. Nothing dispatches `pr:<number>` yet, so consuming it IS clearing
    // it -- but it still has to be cleared, or a stale one fires the next time
    // this tab is shown.
    if (changed.has('target') && this.target !== null) this.target = null;
  }

  /**
   * THE ONE OBLIGATION the applet contract puts on an applet, and the only
   * applet here that actually polls.
   *
   * Active: fetch once immediately -- the reason to open this tab is to see the
   * state NOW, not in a minute -- then every POLL_MS. Inactive or disconnected:
   * the interval is cleared and NULLED, and anything already in flight is
   * ABORTED. An inactive Pull Requests must issue zero requests, and "zero"
   * includes the one that was already on the wire when the tab changed.
   */
  private _sync(): void {
    const want = this.active && this.isConnected;
    if (want) {
      if (this._timer === null) {
        void this._load();
        this._timer = setInterval(() => void this._load(), POLL_MS);
      }
      return;
    }
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._abort?.abort();
    this._abort = null;
    this._loading = false;
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  /**
   * The roots to scan: LIVE FLEET first, then everything remembered, distinct,
   * capped at MAX_ROOTS most-recent.
   *
   * Local sessions only -- a session whose workspace id carries a host
   * qualifier (host-ref.ts) has a project path on another machine, and this
   * server would resolve it against its own filesystem or not at all.
   *
   * Fleet-first is what makes the cap an MRU: a root in the fleet right now was
   * seen most recently by definition, so the one that falls off the end is the
   * one nobody has worked in for the longest.
   *
   * Re-derived on every poll rather than from a fleet subscription: nothing
   * this applet DRAWS comes from the fleet, so a lane starting mid-minute
   * changes the next scan and nothing on screen.
   */
  private _roots(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const s of homeSessions.sessions) {
      if (isRemoteId(s.workspaceId)) continue;
      const p = s.project?.trim() ?? '';
      if (p === '' || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    for (const p of loadRoots()) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out.slice(0, MAX_ROOTS);
  }

  private async _load(): Promise<void> {
    const roots = this._roots();
    // Remember before asking: a root is worth keeping because a lane ran there,
    // not because gh happened to like it.
    saveRoots(roots);

    const ctrl = new AbortController();
    this._abort?.abort();
    this._abort = ctrl;
    this._loading = true;

    try {
      const listing = await fetchPRs(roots, ctrl.signal);
      if (this._abort !== ctrl) return; // superseded; the newer load owns the view
      this._abort = null;
      this._loading = false;
      this._now = Math.floor(Date.now() / 1000);
      this._error = '';
      this._listing = listing;
      this._flagNewlyFailing(listing);
    } catch (err) {
      if (this._abort !== ctrl) return; // aborted or superseded: not ours to report
      this._abort = null;
      this._loading = false;
      // A transport failure, never a gh failure -- gh's own troubles arrive as
      // a 200 body with available:false. The last good list stays on screen
      // with a note under it; one blip must not blank a list you were reading.
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * A pull request whose checks WENT red since the last poll.
   *
   * Only the transition counts. A pull request that has been failing for an
   * hour is not news, and re-flagging it every minute would teach the reader
   * to ignore the flag -- which is the only way this feature can actually
   * fail. A key that was absent last time IS news: it either just appeared or
   * just came back, and either way this is the first red we have seen on it.
   *
   * A DISMISSED PULL REQUEST NEVER FLAGS. You put that row down; it does not
   * get to tap you on the shoulder (D3.5). It is still recorded in the map, so
   * picking it back up later does not manufacture a transition out of a state
   * that never changed.
   *
   * WHAT THIS DOES NOT DO YET, said plainly rather than left to be found:
   * this applet polls ONLY while active, and a load still in flight when the
   * tab changes is aborted before it can land (_sync). So very nearly every
   * flag it raises is for the tab you are already on -- and the host drops
   * those, correctly, because you are looking at it. The diff is dormant, not
   * decorative: the moment pull-request state arrives from something that
   * keeps watching while you are elsewhere -- the sessiond-owned watchlist of
   * design D2, pushed on the channel the fleet already uses -- this raises the
   * flag with no further thought.
   *
   * ADDING A BACKGROUND POLL TO MAKE IT FIRE SOONER IS THE WRONG FIX. It would
   * be every open tab polling GitHub on your behalf, which is the exact thing
   * D2 exists to replace, and it would break the contract's teeth (an inactive
   * applet issues zero requests) to buy a flag a minute early.
   */
  private _flagNewlyFailing(l: PRListing): void {
    // gh missing or logged out. An unavailable listing observed NOTHING about
    // any pull request's checks, so recording its empty list as the new
    // baseline would make every red PR look freshly red the moment gh comes
    // back. Leave the previous poll's map exactly where it is.
    if (!l.available) return;

    const prev = this._prevChecks;
    const next = new Map<string, PRChecks>();
    let fresh = 0;
    for (const p of l.prs) {
      next.set(p.key, p.checks);
      if (p.checks !== 'failing' || this._dismissed.has(p.key)) continue;
      // prev === null is the first listing: nothing has turned yet.
      if (prev !== null && prev.get(p.key) !== 'failing') fresh++;
    }
    this._prevChecks = next;
    if (fresh === 0) return;

    this.dispatchEvent(
      new CustomEvent<AppletAttentionDetail>('applet-attention', {
        detail: { applet: 'prs', count: fresh },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Intent
  // -------------------------------------------------------------------------

  /** How many dismissed rows the CURRENT listing actually holds. It must count
   * what the panel would show, not what storage holds: "dismissed (7)" over
   * two rows is a lie about both numbers. */
  get dismissedCount(): number {
    const prs = this._listing?.prs ?? [];
    return prs.reduce((n, p) => (this._dismissed.has(p.key) ? n + 1 : n), 0);
  }

  /** Show or hide the panel of pull requests you put down. */
  setShowDismissed(v: boolean): void {
    if (this.showDismissed === v) return;
    this.showDismissed = v;
  }

  /**
   * Stop showing a pull request here.
   *
   * A DISMISSED PR NEVER COMES BACK AUTOMATICALLY -- not when its checks go
   * red, not when it is approved, not when a later scan finds it again (D3.5).
   * A dismissal that undoes itself is not a dismissal, and the person who put
   * this row down is the only one who gets to pick it up: the `undo` button in
   * the dismissed panel. The set is keyed by the SERVER's `key`
   * ("owner/name#number") because a number alone collides across repos.
   *
   * Nothing is ever pruned from the set. A closed PR's key costs a few bytes;
   * dropping it would mean a reopened PR reappearing, which is the one
   * behaviour this method exists to prevent.
   */
  dismiss(key: string): void {
    if (key === '' || this._dismissed.has(key)) return;
    const next = new Set(this._dismissed);
    next.add(key);
    this._dismissed = next;
    saveDismissed(next);
  }

  /** Pick it back up. The only way a dismissed row returns. */
  undismiss(key: string): void {
    if (!this._dismissed.has(key)) return;
    const next = new Set(this._dismissed);
    next.delete(key);
    this._dismissed = next;
    saveDismissed(next);
  }

  private _retry = (): void => {
    void this._load();
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  override render(): TemplateResult {
    return html`<div class="body">${this._renderControls()}${this._renderBody()}</div>`;
  }

  /**
   * THIS APPLET'S OWN CONTROL, in this applet's own body.
   *
   * Absent entirely when nothing is dismissed -- a control for an empty set is
   * one more thing to read on a surface that should stay quiet -- which is
   * also why the rule goes with it.
   */
  private _renderControls(): TemplateResult | typeof nothing {
    const n = this.dismissedCount;
    if (n === 0) return nothing;
    return html`
      <div class="controls">
        ${appletToggle({
          label: `dismissed (${n})`,
          on: this.showDismissed,
          title: 'Show the pull requests you put down',
          onToggle: () => this.setShowDismissed(!this.showDismissed),
        })}
      </div>
      <div class="controls-rule"></div>
    `;
  }

  private _renderBody(): TemplateResult {
    const l = this._listing;
    if (!l) {
      if (this._error !== '') return appletError(this._error, this._retry);
      return html`<div class="hint">Reading&hellip;</div>`;
    }

    // gh missing, or gh not logged in. The server said so in a sentence a
    // person can act on; showing "no pull requests" instead would be
    // confidently wrong.
    if (!l.available) {
      return appletError(l.error || 'The GitHub CLI is not available.', this._retry);
    }

    // Zero repos means neither the fleet nor anything remembered resolved to a
    // GitHub checkout, AND the server's own working directory is not one
    // either -- the server falls back to its cwd when we name no roots, and
    // stays silent about it when it is not a checkout.
    if (l.repos.length === 0) {
      return appletEmpty(
        'No git repositories yet. Start a lane in a repo and its pull requests show up here.',
      );
    }

    const visible = l.prs.filter((p) => !this._dismissed.has(p.key));
    const gone = l.prs.filter((p) => this._dismissed.has(p.key));
    // Whether the repo is worth saying on a row. Computed over EVERY row, not
    // the visible ones, so dismissing the last PR of a repo does not silently
    // change what the remaining rows say about themselves.
    const multi = new Set(l.prs.map((p) => p.repo)).size > 1;

    const main =
      l.prs.length === 0
        ? appletEmpty('No open pull requests.')
        : visible.length === 0
          ? appletEmpty('Every open pull request here has been dismissed.')
          : this._renderGroups(visible, multi);

    return html`
      ${main} ${this._renderDismissed(gone, multi)} ${this._renderNotes(l)}
    `;
  }

  /** Rows in the server's order (number descending), grouped by repo when
   * there is more than one. Group order is first appearance, so the grouping
   * never re-sorts what the server already sorted. */
  private _renderGroups(prs: readonly PullRequest[], multi: boolean): TemplateResult {
    if (!multi) {
      return html`<div class="list">${prs.map((p) => this._renderRow(p, multi, false))}</div>`;
    }
    const order: string[] = [];
    const byRepo = new Map<string, PullRequest[]>();
    for (const p of prs) {
      let bucket = byRepo.get(p.repo);
      if (!bucket) {
        bucket = [];
        byRepo.set(p.repo, bucket);
        order.push(p.repo);
      }
      bucket.push(p);
    }
    return html`
      ${order.map(
        (repo) => html`
          <h2 class="grp">${repo}</h2>
          <div class="list">
            ${(byRepo.get(repo) ?? []).map((p) => this._renderRow(p, multi, false))}
          </div>
        `,
      )}
    `;
  }

  private _renderRow(p: PullRequest, multi: boolean, dismissed: boolean): TemplateResult {
    const tone = checksClass(p.checks);
    const meta: string[] = [];
    if (multi) meta.push(p.repo);
    if (p.headRefName !== '') meta.push(p.headRefName);
    if (p.author !== '') meta.push(p.author);
    const a = age(p.updatedAt, this._now);
    if (a !== '') meta.push(a);

    const rowCls = ['pr', tone, dismissed ? 'dis' : ''].filter((c) => c !== '').join(' ');
    const numCls = tone === '' ? 'num' : `num ${tone}`;

    return html`
      <div class="${rowCls}">
        <div class="core">
          <div class="l1">
            <span class="${numCls}">#${p.number}</span>
            <a
              class="ttl"
              href="${p.url}"
              target="_blank"
              rel="noopener"
              title="${`${p.repo}#${p.number} \u2014 ${p.title}`}"
              >${p.title}</a
            >
            ${p.isDraft ? html`<span class="badge">draft</span>` : nothing}
            ${p.checks !== '' ? html`<span class="badge ${tone}">${p.checks}</span>` : nothing}
            ${this._reviewBadge(p)}
          </div>
          <div class="l2">${meta.join(' \u00b7 ')}</div>
        </div>
        ${dismissed
          ? html`<button
              type="button"
              class="undo"
              title="${`Show #${p.number} here again`}"
              @click="${() => this.undismiss(p.key)}"
            >undo</button>`
          : html`<button
              type="button"
              class="dz"
              title="${`Stop showing #${p.number} here`}"
              aria-label="${`Dismiss ${p.repo}#${p.number}`}"
              @click="${() => this.dismiss(p.key)}"
            >${icon(X, { size: 14 })}</button>`}
      </div>
    `;
  }

  private _reviewBadge(p: PullRequest): TemplateResult | typeof nothing {
    if (p.reviewDecision === '') return nothing;
    const { label, cls } = reviewChip(p.reviewDecision);
    return html`<span class="${cls === '' ? 'badge' : `badge ${cls}`}">${label}</span>`;
  }

  private _renderDismissed(
    gone: readonly PullRequest[],
    multi: boolean,
  ): TemplateResult | typeof nothing {
    if (!this.showDismissed || gone.length === 0) return nothing;
    return html`
      <h2 class="grp">dismissed</h2>
      <p class="dnote">
        Dismissed is muxterm state and never GitHub state: these pull requests
        are untouched on GitHub -- muxterm has simply stopped showing them here.
      </p>
      <div class="list">${gone.map((p) => this._renderRow(p, multi, true))}</div>
    `;
  }

  /**
   * The dim footnotes: a root that did not resolve to a GitHub repo, and a poll
   * that failed while an older list is still on screen. Neither hides anything
   * and neither is hidden.
   */
  private _renderNotes(l: PRListing): TemplateResult {
    const bad = l.repos.filter((r) => r.error !== '');
    return html`
      ${bad.map((r) => html`<div class="note">${r.root} -- ${r.error}</div>`)}
      ${this._error !== ''
        ? html`<div class="note" role="alert">${this._error} -- showing the last list that arrived.</div>`
        : nothing}
    `;
  }
}

/**
 * The manifest: a tab, and nothing about what is under it. `dismissed (N)` is
 * rendered by the element itself, in _renderControls().
 */
registerApplet({
  id: 'prs',
  label: 'Pull Requests',
  icon: GitPullRequest,
  element: 'applet-prs',
  order: 30,
});

declare global {
  interface HTMLElementTagNameMap {
    'applet-prs': AppletPRs;
  }
}
