/**
 * applet-files.ts -- the worktree, as an applet.
 *
 * One directory at a time, annotated with git status, over /api/files. What it
 * is NOT is a file viewer: no row opens a file this round, because reading a
 * file is a second endpoint, a second empty state and a syntax-highlighted
 * scroller, and none of that is what "which of my eleven worktrees is dirty"
 * needs.
 *
 * THREE THINGS THE CONTRACT ASKS FOR, and they are the reason this file is
 * shaped the way it is:
 *
 *   1. IT GOES QUIET WHEN INACTIVE. The host keeps every applet mounted, so
 *      _sync() is the whole rule: fetch while active and connected, hold
 *      nothing at all otherwise -- no timer, and no in-flight request either
 *      (the AbortController is what makes the second half true rather than
 *      merely intended).
 *
 *   2. IT OWNS ITS OWN CONTROL. `changed only` is this applet's rail, painted
 *      by the HOST in the host's `.toggle` vocabulary at the end of the tab
 *      strip.
 *
 *   3. IT USES THE HOST'S ONE EMPTY/ERROR IDIOM. appletEmpty/appletError render
 *      into THIS shadow root, where the host's styles are not in scope, which
 *      is why appletStateStyles is pulled into the styles below.
 *
 * TOKENS ARE NOT RE-DECLARED. --ink-*, --edge, --surface, --need/--ok/--fail,
 * --mono and the --r/--s/--t/--lh scales inherit into this shadow root from
 * <mux-cos>'s :host (theme.ts:349). Nothing here invents a colour.
 */

import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { CornerLeftUp, File as FileGlyph, Folder } from 'lucide';
import { icon } from '../../lib/icons.js';
import { registerApplet, type AppletElement } from '../../lib/applet-registry.js';
import { appletEmpty, appletError, appletStateStyles } from '../mux-applets.js';
import {
  fetchFiles,
  type FileEntry,
  type FileStatus,
  type FilesListing,
} from '../../lib/files-api.js';
import { homeSessions } from '../../lib/home-sessions.js';
import { isRemoteId } from '../../lib/host-ref.js';
import {
  absoluteURL,
  fetchPublications,
  formatTimeLeft,
  publishFile,
  revokePublication,
  statusWord,
  type Publication,
} from '../../lib/publications-api.js';

/**
 * A place this applet can be rooted at.
 *
 * `machine` is '' for this machine and is NOT decoration: a root's real
 * identity is (machine, path), because /home/ken/workspace/muxterm means a
 * different directory on every box in the fleet. This round can only read local
 * files -- /api/files runs in this server process -- so every root built here
 * carries '', and remote roots slot into the same row shape unchanged when
 * read-only cross-machine file operations land. Nothing downstream indexes a
 * root by its path alone.
 */
export interface FilesRoot {
  path: string;
  machine: string;
}

/**
 * WHY A PICKER AND NOT A SINGLE ROOT.
 *
 * A single root is wrong within a day on this machine: there are eleven
 * worktrees on it, each a legitimate answer to "the files", and any one of them
 * chosen as THE root makes the applet useless for the other ten. The active
 * pane's cwd was the other candidate and it is worse -- it changes the meaning
 * of a tab every time focus moves, which is the failure mode design D3.10 names
 * for pane-scoped applets.
 *
 * So the applet is rooted at a CHOICE over roots it can prove exist: the
 * distinct project paths of the LIVE FLEET, filtered to local sessions, plus
 * the server's own cwd as the answer when the fleet is empty. Remote sessions
 * are excluded on purpose -- offering a root that cannot be opened is a lie,
 * and it is the exact lie a fleet view is there to stop telling.
 */
const PATH_KEY = 'muxterm.applet.files.path';
const CHANGED_ONLY_KEY = 'muxterm.applet.files.changedOnly';

/** The stored directory, or null when nothing has been chosen yet. */
function loadPath(): string | null {
  try {
    const stored = localStorage.getItem(PATH_KEY);
    if (stored) return stored;
  } catch {
    /* private mode / storage disabled: still usable, just not sticky */
  }
  return null;
}

function savePath(p: string): void {
  try {
    localStorage.setItem(PATH_KEY, p);
  } catch {
    /* not sticky; not fatal */
  }
}

function loadChangedOnly(): boolean {
  try {
    return localStorage.getItem(CHANGED_ONLY_KEY) === '1';
  } catch {
    /* private mode / storage disabled: the filter starts off */
  }
  return false;
}

function saveChangedOnly(v: boolean): void {
  try {
    localStorage.setItem(CHANGED_ONLY_KEY, v ? '1' : '0');
  } catch {
    /* not sticky; not fatal */
  }
}

/**
 * THE STATUS COLUMN. One character, fixed width, in front of every row --
 * including the unchanged ones, which get a blank of the same width so the
 * column cannot jitter as a worktree gets dirty under you.
 *
 * The letter is the point: colour alone fails for the ~8% of men who cannot
 * separate --need from --ok, and it fails again on a screenshot pasted into a
 * ticket. The letters are git's own (M A D ? R U), so anyone who has read
 * `git status --short` already knows them, and the full word is on the mark's
 * title for anyone who has not.
 */
const STATUS_MARK: Record<FileStatus, string> = {
  '': '',
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: '?',
  renamed: 'R',
  conflicted: 'U',
};

const STATUS_WORD: Record<FileStatus, string> = {
  '': '',
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  untracked: 'untracked',
  renamed: 'renamed',
  conflicted: 'conflicted',
};

/** Colour class per status. --need/--ok/--fail/--ink-3; nothing invented. */
const STATUS_CLASS: Record<FileStatus, string> = {
  '': '',
  modified: 'st-need',
  renamed: 'st-need',
  added: 'st-ok',
  deleted: 'st-fail',
  conflicted: 'st-fail',
  untracked: 'st-dim',
};

interface Crumb {
  label: string;
  path: string;
}

/**
 * Every ancestor of an absolute path, root first, the path itself last.
 *
 * POSIX separators, matching the server this talks to. A Windows volume root
 * would want a second spelling here; nothing in muxterm has needed one yet and
 * inventing it blind would be worse than the one-line change later.
 */
function crumbsFor(abs: string): Crumb[] {
  const out: Crumb[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of abs.split('/')) {
    if (part === '') continue;
    acc += `/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

/** The last two segments of a path -- enough to tell eleven worktrees apart. */
function shortRoot(p: string): string {
  const parts = p.split('/').filter((s) => s !== '');
  return parts.slice(-2).join('/') || p;
}

@customElement('applet-files')
export class AppletFiles extends LitElement implements AppletElement {
  /**
   * Set by <mux-applets>. FALSE means hidden but still mounted, and the
   * obligation that comes with it is _sync(): no request, no timer, no work of
   * any kind until it is true again.
   */
  @property({ type: Boolean }) active = false;

  /** Portrait, handed down from the host. */
  @property({ type: Boolean }) narrow = false;

  /** Deep-link target. Nothing navigates here yet; see updated(). */
  @property({ attribute: false }) target: string | null = null;

  /**
   * The rail's filter. Public because the RAIL reads it, and the rail is
   * rendered by the host in the host's shadow root.
   */
  @state() changedOnly = loadChangedOnly();

  @state() private _listing: FilesListing | null = null;
  @state() private _error = '';
  @state() private _loading = false;

  /** Bumped by the fleet subscription: the root picker is derived from it. */
  @state() private _fleetVersion = 0;

  // ── Publishing ───────────────────────────────────────────────────────────
  //
  // Everything published from THIS machine, not just from this directory: a
  // row has to know it is exposed, and the answer to "is this file public"
  // does not live in the directory listing.
  @state() private _pubs: Publication[] = [];
  /** One sentence from the server when a publish or revoke was refused. */
  @state() private _pubError = '';
  /**
   * The absolute path of the file whose publish is awaiting confirmation.
   *
   * A CONFIRM STEP EXISTS ON PURPOSE. Every other control in this applet
   * navigates; this one puts a file on the public internet, and the row is one
   * mis-click away from the row above it. The confirmation is inline and
   * typographic rather than a modal, and it SAYS WHAT IT MEANS -- anyone with
   * the link, live, and for how long -- because "are you sure?" is not
   * informed consent.
   */
  @state() private _confirming: string | null = null;
  /** Path with a request in flight, so the row can stop taking clicks. */
  @state() private _busy = '';
  /** Path whose link was just copied; clears itself after a moment. */
  @state() private _copied = '';

  /** Where we are, or want to be. null means "the server's cwd". */
  private _path: string | null = loadPath();

  /**
   * The server's own working directory, which is only ever learned by asking
   * for NO path -- so it joins the candidate roots once something has actually
   * needed it, which is exactly the case where the fleet had nothing to offer.
   */
  private _serverCwd = '';

  /** True when what is rendered is not what should be. See _sync(). */
  private _stale = true;

  private _abort: AbortController | null = null;
  private _unsubFleet: (() => void) | null = null;

  /** Guard for the deferred adoption below: once per class, not per element. */
  private static _stateStylesAdopted = false;

  /**
   * THE HOST'S EMPTY/ERROR CSS, ADOPTED LATE ON PURPOSE.
   *
   * appletStateStyles lives in the host module, and the host imports this file
   * for its registerApplet() side effect -- so the two modules are an ES module
   * CYCLE, and in a cycle the imported module's BODY runs AFTER this one's.
   * `static styles = [appletStateStyles, ...]` would therefore read a const
   * still in its temporal dead zone and throw at load, taking the whole app
   * with it: ReactiveElement reads `styles` from finalize(), which the
   * observedAttributes getter calls, which customElements.define() calls -- and
   * @customElement runs define() inside this very module body
   * (reactive-element.js:207-209, 416).
   *
   * appletEmpty/appletError are function DECLARATIONS, hoisted and initialized
   * before any module body runs, so calling them from render() is safe with no
   * ceremony at all. Only the const needs deferring, and first construction is
   * the earliest moment that is guaranteed to be after both bodies have run.
   *
   * The alternative -- a second copy of `.applet-state` in this file -- is
   * exactly the drift the host exported the block to prevent.
   */
  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    const ctor = this.constructor as typeof AppletFiles;
    if (!ctor._stateStylesAdopted) {
      ctor._stateStylesAdopted = true;
      ctor.elementStyles = [...ctor.elementStyles, appletStateStyles];
    }
    return super.createRenderRoot();
  }

  static override styles = css`
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

    .body {
      height: 100%;
      overflow-y: auto;
      padding: var(--s-6);
    }

    /* ── WHERE YOU ARE ───────────────────────────────────────────────── */
    .head {
      display: flex;
      align-items: baseline;
      gap: var(--s-4);
      min-width: 0;
      padding: 0 var(--s-1) var(--s-3);
    }
    .crumbs {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      min-width: 0;
      font-family: var(--mono);
      font-size: 11px;
      line-height: var(--lh-tight);
      color: var(--ink-3);
    }
    .crumb {
      font: inherit;
      color: var(--ink-3);
      background: transparent;
      border: 0;
      padding: 1px 2px;
      border-radius: var(--r-chip);
      cursor: pointer;
    }
    .crumb:hover {
      color: var(--ink-1);
      background: var(--chrome-hover);
    }
    .crumb:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: -1px;
    }
    .sep {
      opacity: 0.45;
    }
    .here {
      padding: 1px 2px;
      color: var(--ink-1);
      font-weight: 600;
    }
    .branch {
      margin-left: auto;
      flex: none;
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: var(--lh-tight);
      color: var(--ink-3);
    }
    /* git had nothing to say and says why. The listing is NOT hidden. */
    .note {
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: var(--lh-tight);
      color: var(--ink-3);
      padding: 0 var(--s-1) var(--s-4);
    }

    /* ── WHICH ROOT ──────────────────────────────────────────────────── */
    .pick {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      min-width: 0;
      padding: 0 var(--s-1) var(--s-5);
    }
    .pick .lbl {
      flex: none;
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: 1;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--ink-3);
    }
    .pick select {
      font: inherit;
      font-family: var(--mono);
      font-size: 11px;
      line-height: var(--lh-tight);
      color: var(--ink-2);
      background: var(--surface);
      border: 1px solid var(--edge);
      border-radius: var(--r-ctl);
      padding: 3px var(--s-3);
      min-width: 0;
      max-width: 100%;
      cursor: pointer;
    }
    .pick select:hover {
      color: var(--ink-1);
    }
    .pick select:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }

    /* ── THE LISTING ─────────────────────────────────────────────────── */
    .tree {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      width: 100%;
      min-width: 0;
      text-align: left;
      font: inherit;
      font-size: 12px;
      line-height: 1.4;
      color: var(--ink-2);
      background: transparent;
      border: 0;
      border-radius: var(--r-ctl);
      padding: 3px var(--s-4);
    }
    /* Only directories navigate, so only directories look pressable. A
       file row is quiet, NOT disabled: it is not a broken control, it is
       simply a name -- same ink, same size, no cursor promise. */
    button.row {
      cursor: pointer;
    }
    button.row:hover {
      background: var(--chrome-hover);
    }
    button.row:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: -2px;
    }
    .mark {
      flex: none;
      width: 14px;
      text-align: center;
      font-family: var(--mono);
      font-size: 9.5px;
      font-weight: 700;
      line-height: 1;
      color: var(--ink-3);
    }
    .st-need {
      color: var(--need);
    }
    .st-ok {
      color: var(--ok);
    }
    .st-fail {
      color: var(--fail);
    }
    .st-dim {
      color: var(--ink-3);
    }
    .ic {
      flex: none;
      display: grid;
      place-items: center;
      color: var(--ink-3);
    }
    .nm {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--mono);
    }
    /* A row git has something to say about is BRIGHT; an unchanged one is
       dim. The mark carries which kind of change; this carries that there
       is one, at a glance and from across the room. */
    .row.chg .nm {
      color: var(--ink-1);
    }
    .row.st-fail .nm {
      text-decoration: line-through;
      text-decoration-color: color-mix(in srgb, var(--fail) 55%, transparent);
    }

    /* ── PUBLISHED ────────────────────────────────────────────────────────
       A file with a live public URL is marked TYPOGRAPHICALLY and with a
       whole-row wash: the ↗ marker, the word in accent ink, brighter name,
       heavier weight. Deliberately NOT a rounded card with one bolded edge --
       that reads as generic chrome and carries no information the word
       "public" does not already carry. */
    .row.published {
      background: color-mix(in srgb, var(--chrome-accent) 9%, transparent);
    }
    .row.published .nm {
      color: var(--ink-1);
      font-weight: 600;
    }
    .row.pubbroken {
      background: color-mix(in srgb, var(--fail) 10%, transparent);
    }
    .row.confirm {
      background: color-mix(in srgb, var(--need) 12%, transparent);
    }

    .pub {
      margin-left: auto;
      flex: none;
      display: flex;
      align-items: center;
      gap: var(--s-2, 4px);
      font-family: var(--mono);
      font-size: 10.5px;
      line-height: 1;
      white-space: nowrap;
    }
    .pubmark {
      color: var(--chrome-accent);
      font-weight: 700;
    }
    .pubmark.bad,
    .publbl.bad {
      color: var(--fail);
    }
    .publbl {
      color: var(--chrome-accent);
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .left {
      color: var(--ink-3);
    }
    .warnline {
      color: var(--ink-2);
      letter-spacing: 0.02em;
    }

    .act {
      font: inherit;
      font-family: var(--mono);
      font-size: 10.5px;
      line-height: 1;
      color: var(--ink-3);
      background: transparent;
      border: 0;
      padding: 2px 4px;
      border-radius: var(--r-chip);
      cursor: pointer;
    }
    .act:hover:not(:disabled) {
      color: var(--ink-1);
      background: var(--chrome-hover);
    }
    .act:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: -1px;
    }
    .act:disabled {
      cursor: default;
      opacity: 0.55;
    }
    .act.go {
      color: var(--chrome-accent);
      font-weight: 600;
    }
    .act.warn:hover:not(:disabled) {
      color: var(--fail);
    }
    /* The offer is quiet until the row is under the pointer or holds focus.
       opacity rather than display, so the button stays in the tab order and a
       keyboard user reveals it by arriving at it. */
    .act.quiet {
      opacity: 0;
    }
    .row:hover .act.quiet,
    .row:focus-within .act.quiet {
      opacity: 1;
    }
    @media (hover: none) {
      /* No pointer to hover with: the offer is simply always visible. */
      .act.quiet {
        opacity: 1;
      }
    }

    /* One sentence, in the server's own words, when a publish or revoke was
       refused. It sits above the tree because it is about an ACTION, not about
       the listing -- the listing is still perfectly good. */
    .puberr {
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: var(--lh-tight);
      color: var(--fail);
      padding: 0 var(--s-1) var(--s-4);
      overflow-wrap: anywhere;
    }

    /* First read of a directory. Not an empty state and not an error --
       just the honest word for "the request is out". */
    .hint {
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
    // isConnected is already false here, so this is the "go quiet" branch.
    this._sync();
    super.disconnectedCallback();
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('active')) this._sync();
    // The contract says an applet consumes its target and clears it back to
    // null. Nothing dispatches a `path:` target yet, so consuming it IS
    // clearing it -- but it still has to be cleared, or a stale one fires the
    // next time this tab is shown.
    if (changed.has('target') && this.target !== null) this.target = null;
  }

  /**
   * THE ONE OBLIGATION the applet contract puts on an applet.
   *
   * THERE IS NO BACKGROUND POLL, deliberately. A directory listing that
   * refreshes itself while you are not looking is cost with no benefit -- the
   * files did not move because a timer fired -- and a manual `refresh` control
   * would be a fourth thing in a strip that should stay quiet. So the refresh
   * IS re-activation: going inactive marks the listing stale, and coming back
   * fetches. Between those two moments this applet holds nothing at all: no
   * timer to clear (there is none to hold), and no request either, because
   * anything in flight is aborted here rather than left to land on a hidden
   * tree.
   */
  private _sync(): void {
    const want = this.active && this.isConnected;
    if (want) {
      // The fleet is where the candidate roots come from, so the picker has to
      // hear about a lane that starts while this tab is open.
      if (!this._unsubFleet) this._unsubFleet = homeSessions.subscribe(this._onFleet);
      if (this._stale && !this._loading) void this._load(this._path, true);
      return;
    }
    if (this._unsubFleet) {
      this._unsubFleet();
      this._unsubFleet = null;
    }
    this._abort?.abort();
    this._abort = null;
    this._loading = false;
    this._stale = true;
  }

  private _onFleet = (): void => {
    this._fleetVersion++;
  };

  // -------------------------------------------------------------------------
  // Roots
  // -------------------------------------------------------------------------

  /**
   * The roots this applet is willing to open, in a STABLE order.
   *
   * Distinct `project` paths of the live fleet, LOCAL ONLY -- a session whose
   * workspace id carries a host qualifier (host-ref.ts) lives on another
   * machine, and /api/files can only read this one. Sorted rather than left in
   * fleet order so the picker does not reshuffle every time a lane starts or
   * ends. The server's cwd, once known, goes last: it is the fallback, not a
   * project.
   */
  private _candidateRoots(): FilesRoot[] {
    void this._fleetVersion; // read so Lit re-renders the picker on fleet change
    const seen = new Set<string>();
    const out: FilesRoot[] = [];
    for (const s of homeSessions.sessions) {
      if (isRemoteId(s.workspaceId)) continue;
      const p = s.project?.trim() ?? '';
      if (p === '' || seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, machine: '' });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    if (this._serverCwd !== '' && !seen.has(this._serverCwd)) {
      out.push({ path: this._serverCwd, machine: '' });
    }
    return out;
  }

  /** The candidate root the current directory sits under; longest wins. */
  private _rootOf(path: string): string | null {
    let best: string | null = null;
    for (const r of this._candidateRoots()) {
      if (path !== r.path && !path.startsWith(`${r.path}/`)) continue;
      if (best === null || r.path.length > best.length) best = r.path;
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Fetching
  // -------------------------------------------------------------------------

  /**
   * Read one directory. `path` null means "the server's cwd".
   *
   * `fallback` is the answer to the one failure that is not the user's fault:
   * the stored path was deleted, or its worktree was pruned, between one visit
   * and the next. Rather than showing an error over a directory nobody chose on
   * purpose, fall back ONCE to the first candidate root -- and the last one is
   * always the server's cwd, so the retry terminates.
   */
  private async _load(path: string | null, fallback: boolean): Promise<void> {
    const ctrl = new AbortController();
    this._abort?.abort();
    this._abort = ctrl;
    this._loading = true;

    try {
      const listing = await fetchFiles(path ?? undefined, ctrl.signal);
      if (this._abort !== ctrl) return; // superseded; the newer load owns the view
      this._abort = null;
      this._loading = false;
      this._stale = false;
      this._error = '';
      this._listing = listing;
      // Adopt the server's CLEANED path rather than what was asked for, so a
      // ".." out of a symlinked worktree persists the directory that was
      // actually read.
      if (path === null) this._serverCwd = listing.path;
      this._path = listing.path;
      savePath(listing.path);
      void this._loadPubs();
    } catch (err) {
      if (this._abort !== ctrl) return; // aborted or superseded: not ours to report
      this._abort = null;
      this._loading = false;
      const msg = err instanceof Error ? err.message : String(err);
      const next = fallback ? this._fallbackFrom(path) : undefined;
      if (next !== undefined) {
        void this._load(next, false);
        return;
      }
      this._stale = false;
      this._error = msg;
    }
  }

  /** The first candidate root that is not the one that just failed; the
   * server's cwd (null) when there is no other. `undefined` means "stop". */
  private _fallbackFrom(failed: string | null): string | null | undefined {
    if (failed === null) return undefined; // the cwd itself failed: nowhere left
    const alt = this._candidateRoots().find((r) => r.path !== failed);
    return alt ? alt.path : null;
  }

  // -------------------------------------------------------------------------
  // Intent
  // -------------------------------------------------------------------------

  /** Go somewhere. The fetch is the navigation; there is nothing else to do. */
  private _go(path: string): void {
    if (path === '' || path === this._path) return;
    this._path = path;
    this._stale = true;
    this._sync();
  }

  /** appletError's retry, and the only manual refresh there is. */
  private _retry = (): void => {
    this._stale = true;
    this._sync();
  };

  /**
   * Called by the rail, which the HOST renders in the HOST's shadow root --
   * hence public, and hence the event: the host has no other way to know the
   * control it painted now says something different.
   */
  setChangedOnly(v: boolean): void {
    if (this.changedOnly === v) return;
    this.changedOnly = v;
    saveChangedOnly(v);
    this.dispatchEvent(new CustomEvent('applet-rail-changed', { bubbles: true, composed: true }));
  }

  private _onPickRoot = (e: Event): void => {
    const el = e.target as HTMLSelectElement;
    if (el.value !== '') this._go(el.value);
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  override render(): TemplateResult {
    const l = this._listing;
    return html`
      <div class="body">
        ${l ? this._renderHead(l) : nothing} ${this._renderPicker(l)}
        ${this._pubError === '' ? nothing : html`<div class="puberr">${this._pubError}</div>`}
        ${this._renderBody(l)}
      </div>
    `;
  }

  private _renderHead(l: FilesListing): TemplateResult {
    const crumbs = crumbsFor(l.path);
    const last = crumbs.length - 1;
    return html`
      <div class="head">
        <div class="crumbs">
          ${crumbs.map((c, i) =>
            i === last
              ? html`<span class="here">${c.label}</span>`
              : html`<button
                    type="button"
                    class="crumb"
                    title="${c.path}"
                    @click="${() => this._go(c.path)}"
                  >${c.label}</button
                  >${c.path === '/' ? nothing : html`<span class="sep">/</span>`}`,
          )}
        </div>
        ${l.gitAvailable && l.branch !== ''
          ? html`<span class="branch" title="Current branch">${l.branch}</span>`
          : nothing}
      </div>
      ${!l.gitAvailable && l.gitError !== ''
        ? html`<div class="note">${l.gitError} -- listing without git status.</div>`
        : nothing}
    `;
  }

  /**
   * The root picker, in the applet BODY.
   *
   * Not the rail: the rail is shared chrome painted by the host in the host's
   * vocabulary, and a <select> is not in that vocabulary (applet-registry.ts:60
   * -- an applet cannot put a control in the rail the host has no style for).
   */
  private _renderPicker(l: FilesListing | null): TemplateResult | typeof nothing {
    const roots = this._candidateRoots();
    if (roots.length === 0) return nothing;
    const here = l?.path ?? '';
    const at = here === '' ? null : this._rootOf(here);
    return html`
      <div class="pick">
        <span class="lbl" id="root-lbl">root</span>
        <select aria-labelledby="root-lbl" title="${at ?? here}" @change="${this._onPickRoot}">
          ${at === null && here !== ''
            ? html`<option value="" disabled .selected="${true}">${shortRoot(here)}</option>`
            : nothing}
          ${roots.map(
            (r) =>
              html`<option value="${r.path}" .selected="${r.path === at}" title="${r.path}">
                ${shortRoot(r.path)}
              </option>`,
          )}
        </select>
      </div>
    `;
  }

  private _renderBody(l: FilesListing | null): TemplateResult {
    if (this._error !== '') return appletError(this._error, this._retry);
    if (!l) return html`<div class="hint">Reading&hellip;</div>`;

    const rows = this.changedOnly ? l.entries.filter((e) => e.status !== '') : l.entries;
    // The ".." row is navigation, not content: it belongs above whatever the
    // directory turned out to hold, including nothing.
    const up =
      l.parent !== ''
        ? html`<button type="button" class="row dir" @click="${() => this._go(l.parent)}">
            <span class="mark"></span>
            <span class="ic">${icon(CornerLeftUp, { size: 13 })}</span>
            <span class="nm">..</span>
          </button>`
        : nothing;

    if (rows.length === 0) {
      return html`
        <div class="tree">${up}</div>
        ${l.entries.length === 0
          ? appletEmpty('This directory is empty.')
          : appletEmpty('Nothing in this directory has changed.')}
      `;
    }
    return html`<div class="tree">${up}${rows.map((e) => this._renderEntry(e, l.path))}</div>`;
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /**
   * Refresh the publication list. Failure is DELIBERATELY SILENT for the list
   * (a server too old to know the route, or a transient error, must not cost
   * the user their file listing) but never for an action -- _publish and
   * _revoke report in words.
   */
  private async _loadPubs(): Promise<void> {
    try {
      this._pubs = await fetchPublications();
    } catch {
      this._pubs = [];
    }
  }

  /**
   * The publication for `path`, if any.
   *
   * Matched on the PINNED path first and the requested path second, because
   * the server publishes what a path RESOLVES to: publishing
   * /w/current/doc.md through a symlinked directory pins /w/real/doc.md, and
   * the row the user clicked is the one they typed.
   */
  private _pubFor(path: string): Publication | undefined {
    return this._pubs.find((p) => p.path === path || p.requestedPath === path);
  }

  private async _publish(path: string): Promise<void> {
    this._confirming = null;
    this._busy = path;
    this._pubError = '';
    try {
      await publishFile(path);
      await this._loadPubs();
    } catch (err) {
      this._pubError = err instanceof Error ? err.message : String(err);
    } finally {
      this._busy = '';
    }
  }

  private async _revoke(p: Publication): Promise<void> {
    this._busy = p.path;
    this._pubError = '';
    try {
      await revokePublication(p.id);
      await this._loadPubs();
    } catch (err) {
      this._pubError = err instanceof Error ? err.message : String(err);
    } finally {
      this._busy = '';
    }
  }

  /**
   * Copy the link.
   *
   * navigator.clipboard needs a secure context, which muxterm has over https
   * and on loopback but NOT over plain http to a LAN address -- a real
   * deployment shape. So a failure is not swallowed: the URL is put on screen
   * as selectable text instead, which is worse than a copy and much better
   * than a button that silently does nothing.
   */
  private async _copy(p: Publication): Promise<void> {
    const url = absoluteURL(p);
    try {
      await navigator.clipboard.writeText(url);
      this._copied = p.path;
      window.setTimeout(() => {
        if (this._copied === p.path) this._copied = '';
      }, 1600);
    } catch {
      this._pubError = `could not reach the clipboard from this page. The link is ${url}`;
    }
  }

  /**
   * The trailing zone of a file row.
   *
   * ⛔ NO CARD, NO SIDE BORDER. Published state is carried by a typographic
   * marker, the ink, the weight, and a whole-row wash -- see the .pub* rules in
   * styles. A rounded card with one bolded edge reads as generic chrome and
   * says nothing that the word "public" in accent ink does not already say.
   */
  private _renderPub(path: string): TemplateResult {
    const busy = this._busy === path;
    const pub = this._pubFor(path);

    if (pub) {
      const word = statusWord(pub);
      const bad = pub.status !== 'ok';
      const left = pub.status === 'ok' ? formatTimeLeft(pub.secondsLeft) : '';
      return html`<span class="pub">
        <span class="${bad ? 'pubmark bad' : 'pubmark'}" aria-hidden="true">↗</span>
        <span class="${bad ? 'publbl bad' : 'publbl'}" title="${pub.statusDetail || absoluteURL(pub)}"
          >${word}</span
        >
        ${left === '' ? nothing : html`<span class="left">${left}</span>`}
        <button
          type="button"
          class="act"
          ?disabled="${busy}"
          title="Copy the public link"
          @click="${() => void this._copy(pub)}"
        >
          ${this._copied === path ? 'copied' : 'copy link'}
        </button>
        <button
          type="button"
          class="act warn"
          ?disabled="${busy}"
          title="Stop serving this link. It cannot recall anything already read."
          @click="${() => void this._revoke(pub)}"
        >
          revoke
        </button>
      </span>`;
    }

    if (this._confirming === path) {
      return html`<span class="pub confirming">
        <span class="warnline">anyone with the link · live · 24h</span>
        <button
          type="button"
          class="act go"
          ?disabled="${busy}"
          @click="${() => void this._publish(path)}"
        >
          publish
        </button>
        <button type="button" class="act" @click="${() => (this._confirming = null)}">cancel</button>
      </span>`;
    }

    return html`<span class="pub">
      <button
        type="button"
        class="act quiet"
        ?disabled="${busy}"
        title="Publish this file to a public URL anyone with the link can read"
        @click="${() => (this._confirming = path)}"
      >
        ${busy ? 'publishing…' : 'publish'}
      </button>
    </span>`;
  }

  private _renderEntry(e: FileEntry, dir: string): TemplateResult {
    const cls = [
      'row',
      e.dir ? 'dir' : 'file',
      e.status === '' ? '' : 'chg',
      STATUS_CLASS[e.status],
    ]
      .filter((c) => c !== '')
      .join(' ');
    const mark = html`<span
      class="${e.status === '' ? 'mark' : `mark ${STATUS_CLASS[e.status]}`}"
      title="${STATUS_WORD[e.status] || nothing}"
      >${STATUS_MARK[e.status]}</span
    >`;
    const glyph = html`<span class="ic">${icon(e.dir ? Folder : FileGlyph, { size: 13 })}</span>`;
    const name = html`<span class="nm">${e.name}</span>`;
    // A directory navigates; a file is a name plus its publishing state. The
    // name is still not a control -- there is no file viewer this round -- but
    // the row now carries one, at its trailing edge.
    if (!e.dir) {
      const path = dir.endsWith('/') ? `${dir}${e.name}` : `${dir}/${e.name}`;
      const pub = this._pubFor(path);
      const rowCls = [
        cls,
        pub ? (pub.status === 'ok' ? 'published' : 'pubbroken') : '',
        this._confirming === path ? 'confirm' : '',
      ]
        .filter((c) => c !== '')
        .join(' ');
      return html`<div class="${rowCls}" title="${e.name}">
        ${mark}${glyph}${name}${this._renderPub(path)}
      </div>`;
    }
    const path = dir.endsWith('/') ? `${dir}${e.name}` : `${dir}/${e.name}`;
    return html`<button type="button" class="${cls}" title="${path}" @click="${() => this._go(path)}">
      ${mark}${glyph}${name}
    </button>`;
  }
}

/**
 * The manifest. `rail` is one toggle -- `changed only` -- rendered into the
 * HOST's shadow root with the HOST's `.toggle` styles, calling back into this
 * element. Nothing destructive lives here (D3.9).
 */
registerApplet({
  id: 'files',
  label: 'Files',
  icon: Folder,
  element: 'applet-files',
  order: 20,
  rail: (el: AppletElement): TemplateResult => {
    const f = el as AppletFiles;
    return html`
      <button
        type="button"
        class="${f.changedOnly ? 'toggle on' : 'toggle'}"
        aria-pressed="${f.changedOnly ? 'true' : 'false'}"
        title="Show only what git has something to say about"
        @click="${() => f.setChangedOnly(!f.changedOnly)}"
      >changed only</button>
    `;
  },
});

declare global {
  interface HTMLElementTagNameMap {
    'applet-files': AppletFiles;
  }
}
