/**
 * applet-dashboard.ts -- the fleet, as an applet.
 *
 * This is <mux-cos>'s right-hand column, moved wholesale and otherwise
 * unchanged: the same store, the same grouping, the same fixed-height cards,
 * the same `home-open` event. Nothing about how it LOOKS is new here. What is
 * new is three things the applet contract asks for:
 *
 *   1. IT GOES QUIET WHEN INACTIVE. The host keeps every applet mounted, so
 *      an applet that kept working would re-render a hidden tree forever.
 *      _sync() is the rule: an inactive Dashboard renders nothing, polls
 *      nothing and animates nothing.
 *
 *      With ONE named exception, and it is the only one in the file: the
 *      fleet subscription is held while CONNECTED rather than while ACTIVE,
 *      so an unseen tab can still notice that a lane went blocked. The
 *      argument for it, and its cost, are on _onFleet.
 *
 *   2. IT RENDERS ONE SESSION CARD. The old cards|tiles choice changed only
 *      whether a terminal-text thumbnail was appended to the same metadata
 *      strip. It did not represent a second object or workflow, so that
 *      distinction is gone. A session now has one heading/body/disclosure
 *      anatomy at every width.
 *
 *   3. IT KEEPS THE SHEET'S JOB. Portrait puts the applet HOST inside
 *      <mux-cos>'s bottom sheet, so this element is the same one the desktop
 *      mounts, in a shorter container, told `narrow`. It used to be a separate
 *      `insheet` flag on a SECOND instance of this element that the sheet
 *      mounted by tag; the flag went when the second instance did, because
 *      "I am in the sheet" and "I am on a phone" were never two facts.
 *
 * TOKENS ARE NOT RE-DECLARED. --ink-*, --edge, --surface, --need/--work/--ok/
 * --fail, --mono and the --r/--s/--t/--lh scales are all declared on
 * <mux-cos>'s :host, and custom properties inherit into shadow roots
 * (theme.ts:349), so they arrive here for free and cannot drift. Only
 * The card-specific geometry stays local to this shadow root.
 */

import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LayoutGrid } from 'lucide';
import {
  registerApplet,
  type AppletAttentionDetail,
  type AppletElement,
} from '../../lib/applet-registry.js';
import { homeSessions } from '../../lib/home-sessions.js';
import {
  HOME_GROUPS,
  groupFor,
  isKnownHarness,
  progressLine,
  todoFraction,
  todoPercent,
  type HomeGroup,
  type SessionState,
} from '../../lib/session-state.js';
import type { SessiondMessage, SessionTranscriptTurn } from '../../types.js';

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
  'Needs input': 'needs attention',
  Running: 'working',
  Completed: 'finished',
};

/** Visual reading order from the approved mockup: motion, intervention, outcome. */
const DISPLAY_GROUPS: readonly HomeGroup[] = ['Running', 'Needs input', 'Completed'];

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

@customElement('applet-dashboard')
export class AppletDashboard extends LitElement implements AppletElement {
  /**
   * Set by <mux-applets>. FALSE means hidden but still mounted, and the
   * obligation that comes with it is _sync(): no subscription, no timer, no
   * work of any kind until it is true again.
   */
  @property({ type: Boolean }) active = false;

  /**
   * Portrait, handed down from the host. Reflected, per the contract, so the
   * thumbnail rule below is one CSS selector rather than a branch.
   */
  @property({ type: Boolean, reflect: true }) narrow = false;

  /** Deep-link target. Nothing in the fleet defines one yet; see updated(). */
  @property({ attribute: false }) target: string | null = null;

  /** Bumped by the homeSessions subscription, and only while active. */
  @state() private _fleetVersion = 0;
  @state() private _detailSessionId: string | null = null;
  @state() private _transcriptTurns: SessionTranscriptTurn[] = [];
  @state() private _transcriptCursor = '';
  @state() private _transcriptError = '';
  @state() private _transcriptLoading = false;
  @state() private _transcriptMeta = '';
  @state() private _transcriptArchived = false;
  @state() private _transcriptDetached = false;
  @state() private _transcriptTruncated = false;
  @state() private _expandedTodo: string | null = null;

  private _unsubFleet: (() => void) | null = null;

  /**
   * How many sessions wanted a human at the last notification. An INTEGER, and
   * that is the entire cost of the always-on listener -- see _onFleet.
   *
   * Not reactive: it is a comparison baseline, not something anything draws.
   */
  private _needsInput = 0;

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
      --fleet-panel: #121824;
      --fleet-raised-top: #1a2230;
      --fleet-raised-bottom: #151c28;
      --fleet-edge: #2b3548;
      --fleet-muted: #8c99ad;
      --fleet-body: #c8d0dd;
      --fleet-shadow: 0 8px 22px #05070b44;
      --fleet-detail-shadow: 0 18px 48px #0008;
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
    .fleet-top {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: var(--s-6);
      margin-bottom: 20px;
    }
    .fleet-top h1 {
      margin: 0 0 3px;
      color: var(--ink-1);
      font-size: 22px;
      line-height: 1.2;
    }
    .fleet-sub,
    .fleet-hint {
      color: var(--fleet-muted);
      font-size: 12px;
    }
    .fleet-hint { font-size: 11px; }
    /* A phone is narrower than the padding was designed for: --s-6 on both
       sides of a 393px screen is 8% of it spent on nothing. */
    :host([narrow]) .body {
      padding: var(--s-5) var(--s-4);
    }
    .grp {
      font-family: var(--mono);
      font-size: 10.5px;
      font-weight: 600;
      line-height: 1;
      letter-spacing: 0.11em;
      text-transform: uppercase;
      color: var(--ink-3);
      padding: 22px 0 9px;
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
      /* Containing block for .bar, which is absolutely positioned precisely so
         that it costs no height: --meta-h is a contract, and a card that grew
         to show progress would make the fleet harder to scan.

         THE CARD, NOT .meta, and that is not arbitrary. The height above is a
         BORDER-box height, so this card's inner box is 72px while .meta
         declares 74px -- .meta has always overflowed its parent by exactly the
         top and bottom borders, invisibly, because the overflowing strip was
         empty padding. Anchoring the bar to .meta put it entirely inside that
         strip, and the overflow:hidden on this rule then clipped every pixel
         of it: the bar was in the DOM, 2px tall, 40% filled, and drawn
         nowhere. Measured, not guessed -- its bottom edge sat 2px below the
         card's inner bottom edge, at every width. */
      position: relative;
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

    /* -- TODO PROGRESS ----------------------------------------------------
       Two marks, both of which cost ZERO height, because --meta-h is a
       contract and not a starting point.

       The FRACTION is typographic and leads the line it shares with the
       task text, so it is the part that survives when the text ellipsises
       -- which on a phone is most of the time. Mono with tabular figures so
       a column of cards has its slashes in a line rather than dancing by a
       pixel per digit; that alignment is the whole reason it is not just
       set in the body face.

       The BAR is the same number for the eye rather than the reader, for
       scanning many lanes at once. It is drawn in ink, not in a state
       colour: colour here would be a second, weaker encoding of what the
       fraction already says exactly, and the standing rule is that colour
       never carries meaning alone. It is 2px along the card's bottom edge,
       not a rounded chip and not an accented border -- and it is drawn at a
       FRACTION of the card's width, which is what stops a partial bar from
       reading as a border at all. */
    .card .frac {
      font-family: var(--mono);
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.02em;
      color: var(--ink-1);
      margin-right: var(--s-3);
    }
    .card .bar {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 2px;
      background: color-mix(in srgb, var(--ink-3) 28%, transparent);
    }
    .card .bar > i {
      display: block;
      height: 100%;
      /* Ink at 72%: a confident mark rather than a hint, but still quieter
         than the text above it, and derived from the theme's own ink so it
         holds its contrast in a light palette and a dark one alike.
         No transition: this moves when a lane revises its plan, which is
         news. An animated slide would read as the card doing something. */
      background: color-mix(in srgb, var(--ink-2) 72%, transparent);
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
    :host([narrow]) .thumb {
      display: none;
    }

    .fzero {
      font-size: var(--t-ui);
      line-height: var(--lh-body);
      color: var(--ink-3);
      padding: var(--s-4) var(--s-1);
    }
    .detail {
      margin-bottom: var(--s-5);
      padding: var(--s-5);
      border: 1px solid var(--chrome-border);
      border-left: 3px solid var(--chrome-accent);
      background: var(--chrome-raised);
      color: var(--ink-2);
      font-size: 11.5px;
    }
    .detail-head { display: flex; justify-content: space-between; gap: var(--s-4); color: var(--ink-1); font-weight: 600; }
    .detail button { border: 0; background: transparent; color: var(--ink-3); cursor: pointer; }
    .detail dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--s-2) var(--s-4); margin: var(--s-4) 0 0; }
    .detail dt { color: var(--ink-3); }
    .detail dd { margin: 0; overflow-wrap: anywhere; }
    .transcript-head { display: flex; justify-content: space-between; align-items: center; margin-top: var(--s-5); color: var(--ink-1); font-weight: 600; }
    .transcript-note, .transcript-error { margin: var(--s-3) 0 0; color: var(--ink-3); }
    .transcript-error { color: var(--fail); }
    .transcript { list-style: none; margin: var(--s-3) 0 0; padding: 0; display: grid; gap: var(--s-3); max-height: 18rem; overflow: auto; }
    .transcript li { display: grid; gap: var(--s-1); border-left: 2px solid var(--edge); padding-left: var(--s-3); }
    .transcript b { color: var(--ink-3); font-size: 10px; text-transform: uppercase; }
    .transcript span { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink-1); }

    /* One fleet object, with actual card anatomy. The former tiles mode was
       this same metadata strip plus a terminal thumbnail; it did not change
       the session model or the available actions, so the meaningless toggle
       and its second geometry are intentionally gone. */
    .grid,
    :host([view='tiles']) .grid {
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: var(--s-5);
    }
    .card,
    :host([view='tiles']) .card {
      height: auto;
      min-height: 154px;
      display: block;
      overflow: hidden;
      border: 1px solid var(--edge);
      border-radius: 10px;
      background: var(--fleet-panel);
      box-shadow: var(--fleet-shadow);
      cursor: default;
    }
    .card { border-color: var(--fleet-edge); }
    .card.work { border-color: #355465; }
    .card.need { border-color: color-mix(in srgb, var(--need) 45%, var(--fleet-edge)); }
    .card.fail { border-color: color-mix(in srgb, var(--fail) 45%, var(--fleet-edge)); }
    .card.done { border-color: color-mix(in srgb, var(--ok) 35%, var(--fleet-edge)); }
    .card-head {
      height: 54px;
      padding: 11px 13px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 24px;
      gap: var(--s-4);
      align-items: center;
      border-bottom: 1px solid #273043;
      background: linear-gradient(180deg, var(--fleet-raised-top), var(--fleet-raised-bottom));
    }
    .card-open {
      min-width: 0;
      padding: 0;
      border: 0;
      background: none;
      text-align: left;
      color: inherit;
      cursor: pointer;
      display: grid;
      gap: 3px;
    }
    .card .n,
    .card .m,
    .card .g {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card .n { font-size: 13px; font-weight: 700; }
    .card.work .n { font-weight: 800; }
    .card .m { font-size: 10px; color: var(--fleet-muted); }
    .status,
    .card-close {
      grid-column: 2;
      grid-row: 1;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      place-items: center;
    }
    .status {
      display: grid;
      color: var(--edge);
      background: color-mix(in srgb, currentColor 14%, transparent);
    }
    .work .status { color: var(--work); }
    .need .status { color: var(--need); }
    .fail .status { color: var(--fail); }
    .done .status { color: var(--ok); }
    .card-close {
      display: none;
      border: 0;
      background: var(--chrome-hover);
      color: var(--ink-2);
      cursor: pointer;
      font-size: 16px;
    }
    .card:has(.card-close):hover .status { display: none; }
    .card:hover .card-close { display: grid; }
    .card-body { padding: 12px 13px 10px; }
    .card .g {
      height: 40px;
      min-height: 40px;
      color: var(--fleet-body);
      font-size: 13px;
      white-space: normal;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .progress {
      display: flex;
      align-items: center;
      gap: var(--s-4);
      margin-top: 10px;
    }
    .card .frac { flex: none; margin: 0; font-size: 11px; font-weight: 650; }
    .track {
      height: 4px;
      flex: 1;
      overflow: hidden;
      border-radius: 4px;
      background: color-mix(in srgb, var(--ink-3) 22%, transparent);
    }
    .track i { display: block; height: 100%; background: currentColor; }
    .work .track { color: var(--work); }
    .need .track { color: var(--need); }
    .fail .track { color: var(--fail); }
    .done .track { color: var(--ok); }
    .todo-toggle {
      width: 100%;
      margin-top: 10px;
      padding: 8px 0 2px;
      border: 0;
      border-top: 1px solid var(--edge);
      background: none;
      color: #aeb9ca;
      display: flex;
      justify-content: space-between;
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .chevron { transition: transform var(--dur) ease; }
    .todo-toggle[aria-expanded='true'] .chevron { transform: rotate(180deg); }
    .todo-list {
      list-style: none;
      margin: 9px 0 2px;
      padding: 0;
      display: grid;
      gap: 7px;
      font-size: 11px;
    }
    .todo-list li { display: grid; grid-template-columns: 15px 1fr; gap: 6px; color: #aeb8c8; }
    .todo-list .complete { text-decoration: line-through; }
    .todo-list .current { color: var(--ink-1); font-weight: 600; }

    /* Drill-in is a two-part workspace, not the compact card stretched wide. */
    .detail {
      padding: 0;
      margin: 14px 0 22px;
      border: 1px solid #3a465b;
      border-radius: 12px;
      background: #111824;
      overflow: hidden;
      box-shadow: var(--fleet-detail-shadow);
    }
    .detail-head {
      min-height: 68px;
      padding: 16px 18px;
      align-items: center;
      background: #192130;
      border-bottom: 1px solid var(--fleet-edge);
      font-size: 13px;
    }
    .detail-identity { min-width: 0; flex: 1; display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 14px; align-items: center; }
    .detail-copy { min-width: 0; }
    .detail-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-1); font-size: 17px; font-weight: 700; }
    .detail-meta { display: block; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fleet-muted); font: 10px/1.35 var(--mono); font-weight: 400; }
    .detail-state { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; color: var(--work); background: color-mix(in srgb, currentColor 14%, transparent); }
    .detail.need .detail-state { color: var(--need); }
    .detail.fail .detail-state { color: var(--fail); }
    .detail.done .detail-state { color: var(--ok); }
    .detail-head > span:last-child { flex: none; display: flex; align-items: center; gap: var(--s-3); }
    .detail-head .open-terminal {
      padding: var(--s-3) var(--s-5);
      border: 1px solid color-mix(in srgb, var(--work) 60%, var(--edge));
      border-radius: var(--r-ctl);
      background: color-mix(in srgb, var(--work) 14%, var(--surface));
      color: var(--ink-1);
      font-weight: 600;
    }
    .detail-head .detail-close { width: 28px; height: 28px; font-size: 17px; }
    .final-message {
      margin: 0;
      padding: 16px 18px 18px;
      border-bottom: 1px solid var(--fleet-edge);
      background: #121a27;
    }
    .final-message figcaption {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 9px;
      color: var(--fleet-muted);
      font-size: 11px;
      letter-spacing: .09em;
      text-transform: uppercase;
    }
    .final-message cite {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #aeb8c8;
      font-style: normal;
      letter-spacing: 0;
      text-transform: none;
    }
    .final-message blockquote {
      max-height: 20rem;
      margin: 0;
      padding: 13px 15px;
      overflow: auto;
      border: 1px solid #2b3850;
      border-left: 3px solid var(--ok);
      border-radius: 7px;
      background: #0e1520;
      color: #d2d9e5;
      font: 12px/1.55 var(--mono);
      overflow-wrap: anywhere;
      user-select: text;
      white-space: pre-wrap;
    }
    .detail.fail .final-message blockquote { border-left-color: var(--fail); }
    .detail.need .final-message blockquote { border-left-color: var(--need); }
    .detail-main { display: grid; grid-template-columns: minmax(220px, .75fr) minmax(360px, 1.6fr); }
    .detail-summary { padding: 18px; border-right: 1px solid var(--fleet-edge); }
    .detail-summary h3, .history h3 { margin: 0 0 14px; color: var(--fleet-muted); font-size: 11px; letter-spacing: .09em; text-transform: uppercase; }
    .detail-summary dl { margin-top: 0; }
    .detail-summary dl { grid-template-columns: 72px minmax(0, 1fr); gap: 8px; font-size: 12px; }
    .detail-summary .summary-todo { margin-top: 20px; }
    .detail-todo { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; font-size: 11px; }
    .detail-todo li { display: grid; grid-template-columns: 15px 1fr; gap: 6px; color: #aeb8c8; }
    .detail-todo .current { color: var(--ink-1); font-weight: 650; }
    .history { padding: 18px; min-width: 0; }
    .transcript-head { margin-top: 0; }
    .history-actions { display: flex; align-items: center; gap: var(--s-3); }
    .history-refresh { color: var(--ink-3) !important; padding: var(--s-2) var(--s-3) !important; }
    .transcript { max-height: 22rem; gap: 12px; }
    .transcript li {
      grid-template-columns: 62px minmax(0, 1fr);
      gap: 12px;
      border-left: 0;
      padding: 0;
      align-items: start;
    }
    .transcript b { padding-top: var(--s-2); }
    .transcript span { padding: 10px 12px; border: 1px solid #283247; border-radius: 7px; background: #151c29; color: #cbd3df; }
    .transcript li.agent span, .transcript li.assistant span { border-left: 2px solid var(--work); }
    .transcript li.tool span { background: #101620; color: #99a6ba; font: 11px/1.45 var(--mono); }
    .archive-row { margin-top: 14px; padding-top: 11px; border-top: 1px solid #283143; text-align: right; }
    .archive-action { color: color-mix(in srgb, var(--fail) 60%, var(--ink-3)) !important; }
    @media (max-width: 700px) {
      .grid, :host([view='tiles']) .grid { grid-template-columns: 1fr; }
      .detail-main { grid-template-columns: 1fr; }
      .detail-summary { border-right: 0; border-bottom: 1px solid var(--edge); }
      .fleet-hint { display: none; }
    }
  `;

  // -------------------------------------------------------------------------
  // The inactive rule, and its one exception
  // -------------------------------------------------------------------------

  override connectedCallback(): void {
    // This is where the fleet subscription starts, regardless of `active`.
    super.connectedCallback();
    window.addEventListener('session-transcript-result', this._onTranscriptResult as EventListener);
    this._sync();
  }

  override disconnectedCallback(): void {
    // isConnected is already false here, so this is the unsubscribe branch.
    this._sync();
    window.removeEventListener('session-transcript-result', this._onTranscriptResult as EventListener);
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
   * THE OBLIGATION the applet contract puts on an applet: an inactive
   * Dashboard renders nothing and holds nothing that costs anything. The host
   * keeps this element mounted and merely hides it, so without this an unseen
   * Dashboard would re-render on every session change for the life of the app.
   *
   * The subscription itself is keyed to CONNECTED, not to ACTIVE. That is the
   * exception, and _onFleet is where it is argued.
   */
  private _sync(): void {
    if (this.isConnected && !this._unsubFleet) {
      // The fleet's ONE seam -- home-sessions.ts, the same store <mux-home>,
      // the Dashboard card and the title-bar dot all read.
      //
      // BASELINE FIRST. The flag is a RISE, so the first notification has to
      // compare against the fleet as it is right now; starting at zero would
      // make attaching to a fleet that already has two blocked lanes look like
      // two lanes just blocked, and flag news that is not news.
      this._needsInput = this.needsInput;
      this._unsubFleet = homeSessions.subscribe(this._onFleet);
    } else if (!this.isConnected && this._unsubFleet) {
      this._unsubFleet();
      this._unsubFleet = null;
    }
    // Adopt the store's CURRENT state on reactivation, not just its next
    // change. While inactive this element deliberately drops every
    // notification on the floor (_onFleet), and it is parked wholesale by
    // cache() when the Dashboard surface closes, so the fleet on screen is the
    // fleet as it was when you left -- typically "Nothing is running" -- until
    // something forces a re-render. Reading the store on reactivation is what
    // makes lanes spawned in the meantime show up the moment you look, which
    // is the whole promise of the surface.
    if (this.active && this.isConnected) this._onFleet();
  }

  /**
   * A fleet change. Two different jobs, and which one runs is `active`.
   *
   * ACTIVE: refresh the clock and re-render, exactly as before.
   *
   * INACTIVE: count the sessions that want a human, and if that count ROSE,
   * say so. Nothing else. No _fleetVersion bump, so lit never schedules an
   * update; no render, so no DOM is touched; no fetch, no timer, no animation.
   * An inactive Dashboard's entire response to a fleet change is one integer
   * comparison.
   *
   * THIS IS THE FILE'S ONE EXCEPTION TO THE CONTRACT'S TEETH, and it is worth
   * naming precisely rather than leaving for someone to find. The rule is: an
   * inactive applet stops polling, stops animating, and holds no open
   * connection. A subscription to a store that already exists is none of those
   * three -- it opens nothing, polls nothing and paints nothing; it is a
   * callback in a Set that some other component's data was going to fire
   * anyway. And without it this surface cannot tell you that a lane went
   * blocked while you were reading a diff on another tab, which is the entire
   * point of the flag: a flag you only get when you look is not a flag.
   *
   * THE COST, NAMED: it is a listener, and listeners are how "costs nothing"
   * turns into "costs everything" one reasonable exception at a time. A future
   * applet that wants one has to make this same argument -- opens nothing,
   * polls nothing, paints nothing, and the feature is impossible without it.
   * Three out of four is not the argument.
   */
  private _onFleet = (): void => {
    const n = this.needsInput;
    const rose = n > this._needsInput;
    this._needsInput = n;

    if (!this.active) {
      if (rose) this._raiseAttention(n);
      return;
    }
    this._now = Math.floor(Date.now() / 1000);
    this._fleetVersion++;
  };

  /** For the host's benefit: how many sessions want a human right now. */
  get needsInput(): number {
    let n = 0;
    for (const s of homeSessions.sessions) if (groupFor(s) === 'Needs input') n++;
    return n;
  }

  /**
   * Tell the host something here wants attention. The host decides what that
   * means -- a dot on this tab, or the surface moving -- and this applet has
   * no say in it and nothing to escalate with (applet-registry.ts).
   *
   * composed, because there are two shadow boundaries between here and the
   * host when this element is in the applet stack. The SHEET instance in
   * <mux-cos> also fires this; nothing above it listens, because events go up
   * and the applet host is sideways from there.
   */
  private _raiseAttention(count: number): void {
    this.dispatchEvent(
      new CustomEvent<AppletAttentionDetail>('applet-attention', {
        detail: { applet: 'dashboard', count },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Intent
  // -------------------------------------------------------------------------

  /**
   * One session. Activation dispatches `home-open` -- byte-identical to what
   * <mux-home> fires, so app.ts's one handler opens the workspace and focuses
   * the pane for either surface. bubbles AND composed, because it now has two
   * shadow boundaries to cross: this applet's and <mux-cos>'s.
   */
  private _openPane(s: SessionState): void {
    const opening = this._detailSessionId !== s.sessionId;
    this._detailSessionId = this._detailSessionId === s.sessionId ? null : s.sessionId;
    if (opening || this._detailSessionId === null) this._clearTranscriptDetail();
    if (this._detailSessionId) this._requestTranscript(s.sessionId);
  }

  private _clearTranscriptDetail(): void {
    this._transcriptTurns = [];
    this._transcriptCursor = '';
    this._transcriptError = '';
    this._transcriptLoading = false;
    this._transcriptMeta = '';
    this._transcriptArchived = false;
    this._transcriptDetached = false;
    this._transcriptTruncated = false;
  }

  private _openTerminal(s: SessionState): void {
    if (s.paneId === null || s.workspaceId === null) return;
    this.dispatchEvent(
      new CustomEvent('home-open', {
        detail: { sessionId: s.sessionId, paneId: s.paneId, workspaceId: s.workspaceId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _closeTerminal(s: SessionState): void {
    if (s.paneId === null || s.workspaceId === null) return;
    this.dispatchEvent(new CustomEvent('pane-close', {
      detail: { targetKind: 'pane', workspaceId: s.workspaceId, paneId: s.paneId },
      bubbles: true,
      composed: true,
    }));
  }

  private _requestTranscript(sessionId: string): void {
    this._transcriptLoading = true;
    this.dispatchEvent(new CustomEvent('session-transcript-request', {
      detail: { sessionId, cursor: this._transcriptCursor }, bubbles: true, composed: true,
    }));
  }

  private _onTranscriptResult = (event: CustomEvent<SessiondMessage>): void => {
    const msg = event.detail;
    if (!this._detailSessionId || msg.sessionId !== this._detailSessionId) return;
    this._transcriptLoading = false;
    this._transcriptError = msg.transcriptError ?? '';
    if (!msg.unchanged) this._transcriptTurns = msg.transcriptTurns ?? [];
    this._transcriptCursor = msg.transcriptCursor ?? this._transcriptCursor;
    this._transcriptArchived = msg.transcriptArchived === true;
    if (!msg.unchanged) {
      this._transcriptDetached = msg.transcriptDetached === true;
      this._transcriptTruncated = msg.transcriptTruncated === true;
    }
    this._transcriptMeta = [
      this._transcriptArchived ? 'archived' : '', this._transcriptDetached ? 'detached' : '',
      this._transcriptTruncated ? 'bounded tail' : '',
    ].filter(Boolean).join(' · ');
  };

  private _setArchived(sessionId: string): void {
    this.dispatchEvent(new CustomEvent('session-archive-request', {
      detail: { sessionId, archived: !this._transcriptArchived }, bubbles: true, composed: true,
    }));
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  override render(): TemplateResult {
    const sessions = homeSessions.sessions;
    const workspaces = new Set(sessions.map((s) => s.workspaceId).filter(Boolean)).size;
    return html`<div class="body">
      <header class="fleet-top">
        <div><h1>Fleet</h1><div class="fleet-sub">${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} across ${workspaces} ${workspaces === 1 ? 'workspace' : 'workspaces'}</div></div>
        <div class="fleet-hint">Click a card heading to inspect it</div>
      </header>
      ${this._renderDetail()}${this._renderFleet()}
    </div>`;
  }

  private _renderDetail(): TemplateResult | typeof nothing {
    if (!this._detailSessionId) return nothing;
    const s = homeSessions.sessions.find((row) => row.sessionId === this._detailSessionId);
    if (!s) return nothing;
    const detailBits = [s.harness, s.label, age(s.updatedAt, this._now) ? `updated ${age(s.updatedAt, this._now)} ago` : ''].filter(Boolean);
    const remaining = s.todo ? Math.max(0, s.todo.total - s.todo.done - (s.todo.current ? 1 : 0)) : 0;
    return html`<section class="detail ${stateClass(s)}" aria-label="Session detail">
      <div class="detail-head"><span class="detail-identity"><span class="detail-state" aria-hidden="true">●</span><span class="detail-copy"><span class="detail-title">${s.name}</span><span class="detail-meta">${detailBits.join(' · ')}</span></span></span><span>${s.paneId !== null && s.workspaceId !== null ? html`<button class="open-terminal" type="button" @click="${() => this._openTerminal(s)}">Open terminal ↗</button>` : nothing}<button class="detail-close" type="button" aria-label="Close session detail" @click="${() => { this._detailSessionId = null; }}">×</button></span></div>
      ${groupFor(s) === 'Completed' && s.summary ? html`
        <figure class="final-message" aria-label="Final message from ${s.name}">
          <figcaption><span>Final message</span><cite>${s.name}</cite></figcaption>
          <blockquote>${s.summary}</blockquote>
        </figure>
      ` : nothing}
      <div class="detail-main">
        <aside class="detail-summary">
          <h3>Session</h3>
          <dl>
            ${s.todo ? html`<dt>Progress</dt><dd><strong>${s.todo.done} of ${s.todo.total} complete</strong></dd>` : nothing}
            ${s.todo?.current ? html`<dt>Current</dt><dd>${s.todo.current}</dd>` : nothing}
            ${s.project ? html`<dt>Project</dt><dd>${s.project}</dd>` : nothing}
            <dt>Terminal</dt><dd>${s.paneId === null ? 'no terminal' : `${s.workspaceId} · pane ${s.paneId}`}</dd>
            ${s.pr ? html`<dt>Pull request</dt><dd><strong>PR #${s.pr}</strong></dd>` : nothing}
            ${s.knows?.length ? html`<dt>Artifacts</dt><dd>${s.knows.length} ${s.knows.length === 1 ? 'path' : 'paths'}</dd>` : nothing}
          </dl>
          ${s.todo ? html`<h3 class="summary-todo">Todo list</h3><ul class="detail-todo">
            ${s.todo.done > 0 ? html`<li><span>✓</span><span>${s.todo.done} completed</span></li>` : nothing}
            ${s.todo.current ? html`<li class="current"><span>●</span><span>${s.todo.current}</span></li>` : nothing}
            ${remaining > 0 ? html`<li><span>○</span><span>${remaining} remaining</span></li>` : nothing}
          </ul>` : nothing}
        </aside>
        <section class="history">
          <div class="transcript-head"><h3>History${this._transcriptMeta ? ` · ${this._transcriptMeta}` : ''}</h3><span class="history-actions"><button class="history-refresh" type="button" @click="${() => this._requestTranscript(s.sessionId)}">↻ Refresh</button></span></div>
          ${this._transcriptLoading ? html`<p class="transcript-note">Importing bounded native history…</p>` : nothing}
          ${this._transcriptError ? html`<p class="transcript-error">${this._transcriptError}</p>` : nothing}
          ${!this._transcriptLoading && !this._transcriptError && this._transcriptTurns.length === 0 ? html`<p class="transcript-note">No readable turns in the imported tail.</p>` : nothing}
          <ol class="transcript">${this._transcriptTurns.map((turn) => html`<li class="${turn.role}"><b>${turn.role}${turn.tool ? ` · ${turn.tool}` : ''}</b><span>${turn.text ?? ''}</span></li>`)}</ol>
          <div class="archive-row"><button class="archive-action" type="button" @click="${() => this._setArchived(s.sessionId)}">${this._transcriptArchived ? 'Unarchive session' : 'Archive session'}</button></div>
        </section>
      </div>
    </section>`;
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
    const freshness = homeSessions.snapshotStatus;

    if (total === 0) {
      if (freshness === 'loading') {
        return html`<div class="fzero">Loading Fleet…</div>`;
      }
      if (freshness === 'partial') {
        return html`<div class="fzero">Fleet sources are incomplete. No session state is complete yet.</div>`;
      }
      if (freshness === 'unavailable') {
        return html`<div class="fzero">Fleet status is unavailable from this muxterm daemon.</div>`;
      }
      return html`<div class="fzero">
        Nothing is running. Describe a problem on the left and the lanes it
        starts appear here.
      </div>`;
    }

    return html`
      ${homeSessions.source === 'fixture' ? html`<div class="fx">fixture</div>` : nothing}
      ${freshness === 'partial'
        ? html`<div class="fzero">Fleet sources are incomplete; showing the latest rows.</div>`
        : nothing}
      ${freshness === 'unavailable'
        ? html`<div class="fzero">Fleet status is unavailable; showing its last known rows.</div>`
        : nothing}
      ${DISPLAY_GROUPS.map((g) => {
        const members = byGroup.get(g) ?? [];
        if (members.length === 0) return nothing;
        return html`
          <h2 class="grp">${GROUP_LABEL[g]} · ${members.length}</h2>
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
    bits.push(s.workspaceId ?? 'no terminal');
    const a = age(s.updatedAt, this._now);
    if (a) bits.push(a);
    if (s.pr) bits.push(`PR #${s.pr}`);
    if (s.knows?.length) bits.push(`${s.knows.length} ${s.knows.length === 1 ? 'artifact' : 'artifacts'}`);
    // THE HONEST FALLBACK, and it is the whole of it: both of these return ''
    // for a session that keeps no todo list, and '' renders nothing at all.
    // Such a card shows exactly what it showed before this feature existed --
    // the `doing` line, no fraction, no bar. Drawing "0/0" or an empty track
    // instead would claim the lane has a plan and has finished none of it,
    // which is a STALLED lane; most interactive sessions never call the todo
    // tool, so that lie would be the common case rather than the rare one.
    const frac = todoFraction(s);
    const line = progressLine(s);
    const pct = todoPercent(s);
    const expanded = this._expandedTodo === s.sessionId;
    const remaining = s.todo ? Math.max(0, s.todo.total - s.todo.done - (s.todo.current ? 1 : 0)) : 0;
    return html`
      <article class="card ${stateClass(s)} ${expanded ? 'expanded' : ''}">
        <header class="card-head">
          <button class="card-open" type="button" title="${s.name}" @click="${() => this._openPane(s)}">
            <span class="n">${s.name}</span>
            <span class="m">${bits.join(' \u00b7 ')}</span>
          </button>
          <span class="status" aria-hidden="true">●</span>
          ${s.paneId !== null && s.workspaceId !== null ? html`
            <button class="card-close" type="button" aria-label="Close ${s.name}" title="Close terminal" @click="${() => this._closeTerminal(s)}">×</button>
          ` : nothing}
        </header>
        <div class="card-body">
          <div class="g">${line || 'No current activity reported.'}</div>
          ${frac ? html`
            <div class="progress"><span class="frac" aria-label="${frac} tasks done">${frac}</span><span class="track"><i style="width:${pct}%"></i></span></div>
            <button class="todo-toggle" type="button" aria-expanded="${expanded}" @click="${() => { this._expandedTodo = expanded ? null : s.sessionId; }}">
              <span>Todo list</span><span class="chevron">⌄</span>
            </button>
            ${expanded ? html`<ul class="todo-list">
              ${s.todo!.done > 0 ? html`<li class="complete"><span>✓</span><span>${s.todo!.done} completed</span></li>` : nothing}
              ${s.todo!.current ? html`<li class="current"><span>●</span><span>${s.todo!.current}</span></li>` : nothing}
              ${remaining > 0 ? html`<li><span>○</span><span>${remaining} remaining</span></li>` : nothing}
              ${s.todo!.done === s.todo!.total ? html`<li class="current"><span>✓</span><span>All tasks complete</span></li>` : nothing}
            </ul>` : nothing}
          ` : nothing}
        </div>
      </article>
    `;
  }
}

/**
 * The manifest: a tab, and nothing about what is under it. cards|tiles is
 * rendered by the element itself, in _renderControls().
 */
registerApplet({
  id: 'dashboard',
  label: 'Dashboard',
  icon: LayoutGrid,
  element: 'applet-dashboard',
  order: 10,
});

declare global {
  interface HTMLElementTagNameMap {
    'applet-dashboard': AppletDashboard;
  }
}
