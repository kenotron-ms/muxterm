/**
 * applet-prs.ts -- the pull requests muxterm's own sessions opened.
 *
 * THE USER'S WORDS, twice, because between them they are the whole spec:
 *
 *   "a lane might have closed out, but I don't know what PRs have been opened
 *    that we know about"
 *   "Just a shortcut collector."
 *
 * So: a list of pull requests THIS MACHINE'S SESSIONS PRODUCED, that outlives
 * the sessions, and gets you to one in a single click. Not a review tool. There
 * is no diff, no approve, no merge, and deliberately no close.
 *
 * ── WHAT THIS APPLET USED TO DO, AND WHY IT IS GONE ────────────────────────
 *
 * It scanned REPOSITORIES. It collected worktree paths from live sessions plus
 * a localStorage memory of paths it had seen, sent them to the server as
 * `?root=`, and had the server resolve each to a repo and `gh pr list` it. That
 * failed loudly and constantly with
 *
 *   /home/ken -- fatal: not a git repository (or any of the parent
 *                directories): .git
 *
 * because every session on this machine reports `/home/ken` as its project
 * path: a lane cds into its worktree after launch, so the recorded path names
 * no repository at all.
 *
 * A BETTER DIRECTORY WOULD NOT HAVE FIXED IT. The lanes work in many worktrees
 * across many branches and some touch other repositories entirely, so no single
 * directory's repo is the answer -- and a repo scan cannot say which pull
 * requests came out of sessions here, which is the actual question. Worse, the
 * memory was browser-local, so it died with the browser profile and was
 * invisible to every other client.
 *
 * The list is now COLLECTED SERVER-SIDE from what sessions declared, and stored
 * durably (internal/server/prs_store.go). This element renders it. It sends no
 * scope, remembers nothing in localStorage, and holds no state that a reload or
 * a second tab would disagree with.
 *
 * ── THREE THINGS THE APPLET CONTRACT ASKS FOR ──────────────────────────────
 *
 *   1. IT POLLS ONLY WHILE ACTIVE. The host keeps every applet mounted, so an
 *      inactive Pull Requests must issue ZERO requests -- see _sync(), which
 *      owns both the interval and the in-flight abort.
 *   2. IT OWNS ITS OWN CONTROLS. The filter and the dismissed toggle are
 *      rendered by THIS element, into THIS shadow root, from this file's
 *      styles. The host owns the tab strip and nothing else
 *      (lib/applet-registry.ts).
 *   3. IT DEGRADES INSTEAD OF ERRORING. A row with no status renders with its
 *      number, title and link and says "status unavailable". The defect this
 *      replaced showed an error instead of what it knew; an applet that errors
 *      out over a failed status fetch would be the same defect wearing a
 *      different message.
 *
 * ── THE STATUS MARKER IS TYPOGRAPHY, NOT CHROME ────────────────────────────
 *
 * Rows are a LIST separated by hairlines: no rounded card, and specifically no
 * bolded border down one side as the status signal. State is carried by a glyph
 * in a fixed gutter column, the state WORD in the row's meta line, and a wash
 * of opacity on settled rows -- three signals, so colour is never alone, and
 * the gutter is one character wide so it survives the narrowest divider.
 *
 * TOKENS ARE NOT RE-DECLARED. --ink-*, --edge, --need/--work/--ok/--fail,
 * --mono and the --s/--t/--lh scales inherit into this shadow root from
 * <mux-cos>'s :host (theme.ts:349). Nothing here invents a colour.
 */

import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { GitPullRequest } from 'lucide';
import {
  registerApplet,
  type AppletAttentionDetail,
  type AppletElement,
} from '../../lib/applet-registry.js';
import { appletControlStyles, appletToggle } from '../../lib/applet-controls.js';
import { appletEmpty, appletError, appletStateStyles } from '../mux-applets.js';
import { dismissPR, fetchPRs, type CollectedPR, type PRListing } from '../../lib/prs-api.js';

/**
 * ONE MINUTE, FIXED, and only while this tab is showing.
 *
 * The server caches pull-request state for five minutes and refreshes at most
 * a batch of twelve per request, so this poll is cheap by construction: most
 * of them are a read of an in-memory list.
 */
const POLL_MS = 60_000;

/** Which rows the list is showing. */
type PRFilter = 'open' | 'all';

/**
 * The gutter glyph per state. Distinct in SHAPE, not merely in colour: a
 * filled dot for live work, a tick for landed, a cross for abandoned, a
 * question mark for "we could not ask". The state word is on the row as well,
 * so nobody has to know this alphabet.
 */
function stateGlyph(p: CollectedPR): string {
  if (p.state === 'MERGED') return '\u2714'; // ✔
  if (p.state === 'CLOSED') return '\u2715'; // ✕
  if (p.state === 'OPEN') return p.isDraft ? '\u25cc' : '\u25cf'; // ◌ ●
  return '?';
}

/** Tone class for the glyph and the state word. Never the only signal. */
function stateTone(p: CollectedPR): string {
  if (p.state === 'MERGED') return 't-ok';
  if (p.state === 'CLOSED') return 't-fail';
  if (p.state === 'OPEN') return p.isDraft ? '' : 't-work';
  return '';
}

/** The state, in words. This is what carries the meaning; the glyph decorates
 * it and the colour reinforces it. */
function stateWord(p: CollectedPR): string {
  if (p.state === 'MERGED') return 'merged';
  if (p.state === 'CLOSED') return 'closed';
  if (p.state === 'OPEN') return p.isDraft ? 'draft' : 'open';
  return 'status unavailable';
}

/**
 * An OPEN pull request, for filtering purposes, INCLUDES one whose status we
 * could not fetch.
 *
 * Deliberate: the default view must never hide a row because the network was
 * down. A row we cannot ask about is more likely to still be open than not,
 * and being wrong in that direction shows one extra row -- being wrong in the
 * other direction hides work.
 */
function looksOpen(p: CollectedPR): boolean {
  return p.state === 'OPEN' || p.state === '';
}

/** Coarse age from unix seconds, applet-dashboard's age() shape. */
function age(collectedAt: number, nowSec: number): string {
  if (!Number.isFinite(collectedAt) || collectedAt <= 0) return '';
  const d = Math.max(0, Math.floor(nowSec - collectedAt));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
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

  @state() private _filter: PRFilter = 'open';
  @state() private _showDismissed = false;
  @state() private _listing: PRListing | null = null;
  @state() private _error = '';
  /** The key whose dismiss button is armed and awaiting its second click. */
  @state() private _confirming = '';

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _abort: AbortController | null = null;

  /**
   * The keys seen as OPEN on the previous poll, or null before the first
   * listing lands. That null is load-bearing: "newly collected" is a
   * TRANSITION and the first poll has nothing to have transitioned from, so
   * opening this tab on nine long-standing pull requests flags nothing.
   */
  private _prevKeys: Set<string> | null = null;

  /** Clock for the ages. Re-read on every landing rather than ticked. */
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

    /* Section heading -- the dismissed panel. */
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

    /* ── ONE PULL REQUEST ───────────────────────────────────────────────
       A LIST ROW, NOT A CARD. Hairline separators, no radius, no border on
       any side but the one that separates it from the next row -- state is
       carried by the gutter glyph, the state word, and the settled wash. */
    .list {
      display: flex;
      flex-direction: column;
    }
    .pr {
      display: grid;
      grid-template-columns: 1.6ch minmax(0, 1fr) auto;
      align-items: baseline;
      column-gap: var(--s-4);
      padding: var(--s-4) var(--s-1);
      border-bottom: 1px solid var(--edge);
    }
    .pr:last-child {
      border-bottom: 0;
    }
    .pr:hover {
      background: var(--chrome-hover);
    }
    /* THE SETTLED WASH. A merged or closed pull request is done: it stays
       legible and stops competing with the ones that still need something. */
    .pr.settled {
      opacity: 0.66;
    }
    /* A dismissed row, in its own panel: quieter still. */
    .pr.dis {
      opacity: 0.5;
    }

    /* THE GUTTER. One character wide, fixed, so every row's number starts at
       the same column and the marker survives the narrowest layout. */
    .mark {
      font-family: var(--mono);
      font-size: 11px;
      line-height: var(--lh-tight);
      text-align: center;
      color: var(--ink-3);
      user-select: none;
    }
    .mark.t-work {
      color: var(--work);
    }
    .mark.t-ok {
      color: var(--ok);
    }
    .mark.t-fail {
      color: var(--fail);
    }

    .core {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    /* ONE TARGET, ONE ACTION: the number and the title are the same link. */
    .go {
      display: flex;
      align-items: baseline;
      gap: var(--s-4);
      min-width: 0;
      text-decoration: none;
      color: inherit;
    }
    .go:hover .ttl {
      text-decoration: underline;
    }
    .go:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }
    .num {
      flex: none;
      font-family: var(--mono);
      font-size: 11.5px;
      font-weight: 700;
      line-height: var(--lh-tight);
      font-variant-numeric: tabular-nums;
      color: var(--ink-2);
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
    }
    /* A row with no title yet still needs something on the line. */
    .ttl.unknown {
      font-weight: 500;
      font-style: italic;
      color: var(--ink-3);
    }

    /* THE META LINE. Where the state is stated IN WORDS, so the gutter colour
       is never carrying meaning by itself. */
    .meta {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 0 var(--s-4);
      min-width: 0;
      font-family: var(--mono);
      font-size: 10.5px;
      line-height: var(--lh-tight);
      color: var(--ink-3);
    }
    .meta .st {
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .meta .st.t-work {
      color: var(--work);
    }
    .meta .st.t-ok {
      color: var(--ok);
    }
    .meta .st.t-fail {
      color: var(--fail);
    }
    .meta .sep {
      color: var(--edge);
    }
    .meta .lane {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }

    /* THE DISMISS CONTROL. Two steps: the second click is the one that
       commits, so the row cannot be lost to a stray click -- there is no
       undo. The armed state says the word, because a bare glyph is exactly
       where a control that puts something away starts looking like a control
       that closes something. */
    .dz {
      flex: none;
      align-self: center;
      font: inherit;
      font-family: var(--mono);
      font-size: 10.5px;
      line-height: 1;
      color: var(--ink-3);
      background: transparent;
      border: 0;
      padding: 4px var(--s-2);
      cursor: pointer;
      white-space: nowrap;
    }
    .dz:hover {
      color: var(--ink-1);
    }
    .dz.armed {
      color: var(--fail);
      font-weight: 700;
      box-shadow: inset 0 -2px 0 var(--fail);
    }
    .dz:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }

    /* Footnotes: what dismissal means, a degraded status fetch, a poll that
       failed. None of them ever hides a row, and none of them is hidden. */
    .note {
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: var(--lh-body);
      color: var(--ink-3);
      padding: var(--s-4) var(--s-1) 0;
      overflow-wrap: anywhere;
    }
    .dnote {
      margin: 0;
      padding: var(--s-4) var(--s-1) 0;
      font-size: 11.5px;
      line-height: var(--lh-body);
      color: var(--ink-3);
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
   * Active: fetch once immediately -- the reason to open this tab is to see the
   * list NOW -- then every POLL_MS. Inactive or disconnected: the interval is
   * cleared and NULLED, and anything in flight is ABORTED. "Zero requests"
   * includes the one already on the wire when the tab changed.
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
    // An armed dismiss does not stay armed across a tab change: coming back to
    // find a row one click from gone is not what anyone left behind.
    this._confirming = '';
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async _load(): Promise<void> {
    const ctrl = new AbortController();
    this._abort?.abort();
    this._abort = ctrl;

    try {
      const listing = await fetchPRs(ctrl.signal);
      if (this._abort !== ctrl) return; // superseded; the newer load owns the view
      this._abort = null;
      this._now = Math.floor(Date.now() / 1000);
      this._error = '';
      this._listing = listing;
      this._flagNewlyCollected(listing);
    } catch (err) {
      if (this._abort !== ctrl) return; // aborted or superseded: not ours to report
      this._abort = null;
      // A TRANSPORT failure. gh's own troubles arrive as a 200 body carrying
      // the full list. The last good list stays on screen with a note under
      // it: one blip must not blank a list you were reading.
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * A pull request that appeared since the last poll -- a lane finished and
   * left one behind.
   *
   * Only the transition counts, and only for rows that are not dismissed: you
   * put that row down, so it does not get to tap you on the shoulder. The
   * first listing flags nothing (see _prevKeys).
   */
  private _flagNewlyCollected(l: PRListing): void {
    const prev = this._prevKeys;
    const next = new Set<string>();
    let fresh = 0;
    for (const p of l.prs) {
      next.add(p.key);
      if (p.dismissed || !looksOpen(p)) continue;
      if (prev !== null && !prev.has(p.key)) fresh++;
    }
    this._prevKeys = next;
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

  /**
   * Stop showing a pull request here.
   *
   * TWO CLICKS. The first arms the control and the second commits, because
   * dismissal is durable, server-side and has no undo: a row lost to a stray
   * click would be gone from every browser, permanently.
   *
   * IT CHANGES NOTHING ON GITHUB -- see dismissPR and the note under the list.
   * The row is removed from the store's visible set; the pull request is not
   * closed, merged or touched.
   *
   * The row disappears optimistically so the click feels like it did
   * something, and the next poll -- which reads the durable answer -- is what
   * makes it true. A failure puts it straight back with the reason underneath.
   */
  private _dismiss(key: string): void {
    if (this._confirming !== key) {
      this._confirming = key;
      return;
    }
    this._confirming = '';
    const l = this._listing;
    if (l) {
      this._listing = {
        ...l,
        prs: l.prs.map((p) => (p.key === key ? { ...p, dismissed: true } : p)),
      };
    }
    void dismissPR(key).then(
      () => void this._load(),
      (err: unknown) => {
        this._error = err instanceof Error ? err.message : String(err);
        void this._load();
      },
    );
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
   * THIS APPLET'S OWN CONTROLS, IN THIS APPLET'S OWN BODY.
   *
   * The host owns the tab strip and has no slot for these; that is the applet
   * contract, and it is why adding a filter here is a zero-line change to
   * <mux-applets>.
   *
   * Absent entirely until there is something to filter: a control row above an
   * empty list is one more thing to read on a surface that should stay quiet.
   */
  private _renderControls(): TemplateResult | typeof nothing {
    const all = this._listing?.prs.filter((p) => !p.dismissed) ?? [];
    const gone = this._listing?.prs.filter((p) => p.dismissed) ?? [];
    if (all.length === 0 && gone.length === 0) return nothing;
    const openCount = all.filter(looksOpen).length;
    return html`
      <div class="controls">
        ${appletToggle({
          label: `open (${openCount})`,
          on: this._filter === 'open',
          title:
            'Show pull requests that are still open, including any whose status could not be fetched',
          onToggle: () => {
            this._filter = 'open';
          },
        })}
        ${appletToggle({
          label: `all (${all.length})`,
          on: this._filter === 'all',
          title: 'Show every collected pull request, merged and closed included',
          onToggle: () => {
            this._filter = 'all';
          },
        })}
        ${gone.length > 0
          ? appletToggle({
              label: `dismissed (${gone.length})`,
              on: this._showDismissed,
              title: 'Show the pull requests you put down. They are untouched on GitHub',
              onToggle: () => {
                this._showDismissed = !this._showDismissed;
              },
            })
          : nothing}
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

    const live = l.prs.filter((p) => !p.dismissed);
    const gone = l.prs.filter((p) => p.dismissed);
    const visible = this._filter === 'open' ? live.filter(looksOpen) : live;

    const main =
      l.prs.length === 0
        ? appletEmpty(
            'No pull requests collected yet. When a lane here opens one, it is recorded and stays on this list after the lane is gone.',
          )
        : visible.length === 0
          ? appletEmpty(
              this._filter === 'open'
                ? 'Nothing open. Switch to "all" for the ones that merged or closed.'
                : 'Every collected pull request has been dismissed.',
            )
          : html`<div class="list">${visible.map((p) => this._renderRow(p, false))}</div>`;

    return html`
      ${main}${this._renderDismissed(gone)}${this._renderNotes(l, live.length)}
    `;
  }

  private _renderRow(p: CollectedPR, dismissed: boolean): TemplateResult {
    const tone = stateTone(p);
    const settled = p.state === 'MERGED' || p.state === 'CLOSED';
    const cls = ['pr', settled ? 'settled' : '', dismissed ? 'dis' : '']
      .filter((c) => c !== '')
      .join(' ');

    const title = p.title !== '' ? p.title : 'title not known yet';
    const label = `${p.repo !== '' ? p.repo : 'unknown repository'}#${p.number} \u2014 ${title}`;

    const meta: TemplateResult[] = [
      html`<span class="${tone === '' ? 'st' : `st ${tone}`}">${stateWord(p)}</span>`,
    ];
    if (p.repo !== '') meta.push(html`<span>${p.repo}</span>`);
    if (p.lane !== '') meta.push(html`<span class="lane" title="${p.lane}">${p.lane}</span>`);
    const a = age(p.collectedAt, this._now);
    if (a !== '') meta.push(html`<span title="when muxterm collected it">${a}</span>`);

    const head = html`
      <span class="num">#${p.number}</span>
      <span class="${p.title !== '' ? 'ttl' : 'ttl unknown'}">${title}</span>
    `;

    return html`
      <div class="${cls}">
        <span class="${tone === '' ? 'mark' : `mark ${tone}`}" aria-hidden="true"
          >${stateGlyph(p)}</span
        >
        <span class="core">
          ${p.url !== ''
            ? html`<a class="go" href="${p.url}" target="_blank" rel="noopener" title="${label}"
                >${head}</a
              >`
            : html`<span class="go" title="${label}">${head}</span>`}
          <span class="meta">${this._joinMeta(meta)}</span>
        </span>
        ${dismissed ? nothing : this._renderDismiss(p)}
      </div>
    `;
  }

  /** Meta parts with a dim separator between them. */
  private _joinMeta(parts: readonly TemplateResult[]): TemplateResult[] {
    const out: TemplateResult[] = [];
    parts.forEach((part, i) => {
      if (i > 0) out.push(html`<span class="sep" aria-hidden="true">\u00b7</span>`);
      out.push(part);
    });
    return out;
  }

  private _renderDismiss(p: CollectedPR): TemplateResult {
    const armed = this._confirming === p.key;
    return html`<button
      type="button"
      class="${armed ? 'dz armed' : 'dz'}"
      title="${armed
        ? `Click again to remove #${p.number} from this list. The pull request is not closed or changed on GitHub.`
        : `Remove #${p.number} from this list. It does not close or change the pull request on GitHub.`}"
      aria-label="${armed
        ? `Confirm removing ${p.key} from this list`
        : `Remove ${p.key} from this list (does not change it on GitHub)`}"
      @click="${() => this._dismiss(p.key)}"
    >${armed ? 'remove?' : 'dismiss'}</button>`;
  }

  private _renderDismissed(gone: readonly CollectedPR[]): TemplateResult | typeof nothing {
    if (!this._showDismissed || gone.length === 0) return nothing;
    return html`
      <h2 class="grp">dismissed</h2>
      <p class="dnote">
        Dismissed is muxterm state and never GitHub state: these pull requests are
        untouched on GitHub -- muxterm has simply stopped listing them here.
      </p>
      <div class="list">${gone.map((p) => this._renderRow(p, true))}</div>
    `;
  }

  /**
   * The footnotes. A degraded status fetch and a failed poll are stated HERE,
   * under a list that still shows everything it knows -- never in place of it.
   * That is the entire correction this applet exists to make.
   */
  private _renderNotes(l: PRListing, liveCount: number): TemplateResult {
    return html`
      ${liveCount > 0
        ? html`<p class="dnote">
            Dismissing removes a row from this list only. It never closes, merges or
            changes anything on GitHub.
          </p>`
        : nothing}
      ${!l.statusAvailable && l.statusError !== ''
        ? html`<div class="note">${l.statusError}. Rows below show the last state muxterm knew.</div>`
        : nothing}
      ${this._error !== ''
        ? html`<div class="note" role="alert">${this._error} -- showing the last list that arrived.</div>`
        : nothing}
    `;
  }
}

/**
 * The manifest: a tab, and nothing about what is under it. The filter and the
 * dismissed toggle are rendered by the element itself, in _renderControls().
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
