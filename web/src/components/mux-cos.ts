/**
 * mux-cos.ts -- Mission Control. ONE surface.
 *
 * Not a peer of <mux-home>: it IS home. The left column is a conversation with
 * the chief of staff; the right column is <mux-applets>, a tab strip over a
 * stack of applets, of which the Dashboard applet is the fleet -- the same
 * rows home used to render, from the same store. A draggable divider between
 * them says how much of each you want, and one topbar spans both.
 *
 * An OVERLAY covering .main-pane. The dock underneath is NEVER unmounted:
 * dockview's layout persistence and the attached workspace's live-colour
 * previews both depend on it staying mounted and laid out.
 *
 * WHAT THIS SURFACE DOES NOT HAVE, each removed on purpose:
 *
 *   - no status pip. \"The chief of staff is up\" is not a thing a human is
 *     here to look at; if it is down, the conversation says so where the
 *     answer would have been.
 *   - NO COUNTS, anywhere. Not sessions, not groups (\"wants you\", never
 *     \"wants you . 2\"), not messages. A number that is only ever glanced at
 *     is a number that teaches you to stop reading the words next to it.
 *   - no second composer. Home used to carry a new-session bar; the
 *     conversation's composer is now the only input on the surface, because
 *     \"describe a problem\" and \"start a session\" turned out to be the same
 *     sentence typed into two boxes.
 *   - no animation. No pulse, no throb, no orb.
 *
 * THE ONE INVARIANT WORTH A COMMENT OF ITS OWN: dragging the divider must not
 * change a card's HEIGHT. Only the column count and the scroll extent may
 * move. That invariant now lives with the grid it constrains, in
 * applets/applet-dashboard.ts -- but it is a property of THIS divider, so it
 * is named here too: a card whose text is allowed to wrap re-flows its
 * neighbours on every pointermove, and the whole right column jitters under
 * the hand that is dragging.
 *
 * PRESENTATIONAL over one store, read-only here: cosStore for the
 * conversation. Session state belongs to the Dashboard applet now, which
 * subscribes to homeSessions itself and only while it is on screen. This file
 * imports no socket and parses no wire frame, and reports intent through
 * events only: `home-dismiss` (Esc) and `fleet-state` (the mobile sheet opened
 * or closed, so the title bar's button can say so). `home-open` still leaves
 * this element -- the SAME event <mux-home> fires when a card is activated --
 * but it is now dispatched by the applet and passes THROUGH here on its way to
 * app.ts, which is why the sheet listens for it rather than firing it.
 *
 * Tokens are mux-home's, verbatim. This is a new surface in an existing app,
 * not a new visual language.
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { icon } from '../lib/icons.js';
import { ArrowUp, Check, ChevronDown, Ellipsis, Mic, Square, TriangleAlert, X } from 'lucide';
import {
  cosStore,
  shortToolName,
  type CosApproval,
  type CosBlock,
  type CosTurn,
} from '../lib/cos-store.js';
import {
  clampDashboardSplit,
  persistDashboardSplit,
  restoreDashboardSplit,
} from '../lib/dashboard-split.js';
import { voiceInputController, type VoiceState } from '../lib/voice-input-controller.js';
import {
  voiceSessionController,
  type VoiceSessionSnapshot,
} from '../lib/voice-session-controller.js';
import './mux-voice-orb.js';
import './mux-applets.js';
// The portrait sheet renders a SECOND instance of the Dashboard applet
// directly, outside the applet host: in portrait the whole right-hand region
// is display:none and the fleet is a bottom sheet instead.
import './applets/applet-dashboard.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';

/**
 * One markdown parser per text block, for as long as the block exists.
 *
 * Keyed by the BLOCK OBJECT rather than by turn id and index because that is
 * the identity cos-store actually preserves: a delta does `block.text += ...`
 * on the same object, and a reconcile that cannot append pushes a NEW one. So
 * a parser follows its block through every delta, and is collected with it --
 * no cache to invalidate, no key to get wrong, and no growth when the
 * housekeeping menu clears the transcript.
 */
const parsers = new WeakMap<object, MarkdownStream>();

function renderMarkdown(block: object, text: string, streaming: boolean): TemplateResult {
  let s = parsers.get(block);
  if (!s) {
    s = new MarkdownStream();
    parsers.set(block, s);
  }
  return renderSegments(s.update(text, streaming));
}

/** mm:ss for the approval countdown. Clamped at zero, never negative. */
function clock(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** What the housekeeping menu offers. `days` is the cut, or 'all'. */
type Housekeeping = 7 | 30 | 'all';

/** The sheet's resting sizes. Continuous while dragging; these on release. */
type SheetDetent = 'half' | 'full';

/** Below this fraction of the viewport, releasing the handle DISMISSES. */
const SHEET_DISMISS_AT = 0.22;
/** Above this fraction, releasing the handle snaps to full rather than half. */
const SHEET_FULL_AT = 0.75;
/** The strip the full sheet leaves uncovered -- one nav bar. */
const SHEET_FULL_INSET = 44;

@customElement('mux-cos')
export class MuxCos extends LitElement {
  /**
   * Portrait. Handed down from app.ts's own breakpoint rather than measured
   * here, so the Dashboard, the dock and the title bar can never disagree
   * about which layout is on screen.
   *
   * Reflected so the CSS can key on it -- the surface collapses to a single
   * conversation column and the fleet moves into the bottom sheet.
   */
  @property({ type: Boolean, reflect: true }) narrow = false;

  /** Bumped by the cosStore subscription and by the approval ticker. */
  @state() private _version = 0;

  @state() private _draft = '';
  @state() private _showThinking = new Set<string>();
  @state() private _menuOpen = false;
  /** Which housekeeping action is awaiting a yes. null = none pending. */
  @state() private _confirm: Housekeeping | null = null;
  @state() private _voice: VoiceState = voiceInputController.getState();
  /**
   * The LIVE session, which is a different thing from _voice above.
   *
   * _voice is dictation: free, one utterance, fills the box. This is a
   * metered two-way conversation. They are separate controls on purpose and
   * neither one drives the other.
   */
  @state() private _session: VoiceSessionSnapshot = voiceSessionController.snapshot();

  /**
   * Whether the portrait fleet sheet is open.
   *
   * Its ONLY job is to tell the Dashboard applet inside the sheet whether it
   * is active -- a closed sheet must not leave a subscription running, for
   * exactly the reason a hidden applet must not. The browser owns open/closed
   * (see _onSheetToggle); this mirrors it.
   */
  @state() private _sheetOpen = false;

  /**
   * Divider position, as a percent of the surface width. Persisted.
   *
   * NOT @state, deliberately. render() does not read it -- the divider moves
   * by writing --chat-w on the host (see _gripMove) precisely so that dragging
   * costs one CSS custom property and not a Lit update. As @state it scheduled
   * a full re-render on every pointermove: the whole transcript and every
   * fleet card rebuilt sixty times a second, and updated() then read
   * scrollHeight (a forced synchronous layout) and yanked a pinned reader to
   * the bottom for each one. The direct style write existed to avoid exactly
   * that, and the decorator quietly defeated it.
   */
  private _split = restoreDashboardSplit();

  private _unsub: (() => void) | null = null;
  private _unsubVoice: (() => void) | null = null;
  private _unsubTranscript: (() => void) | null = null;
  private _unsubSession: (() => void) | null = null;
  private _ticker: ReturnType<typeof setInterval> | undefined;

  /** False once the reader scrolls up: streaming must not yank them back down. */
  private _pinned = true;

  /** Live divider drag. null when the grip is not held. */
  private _drag: { pointerId: number } | null = null;

  /** Live sheet drag. `moved` separates a drag from a tap on the handle. */
  private _sheetDrag: { pointerId: number; moved: boolean } | null = null;
  private _detent: SheetDetent = 'half';

  static styles = css`
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    /* === TOKENS ============================================================
       mux-home's scales, verbatim. Every size, colour, gap and radius below
       is read from here; no rule invents one of its own. */
    :host {
      position: absolute;
      inset: 0;
      z-index: 6;
      background: var(--chrome-body);
      overflow: hidden;
      outline: none;
      color: var(--ink-2);
      font-size: var(--t-ui);
      line-height: var(--lh-body);

      /* ONE surface, two columns and a shared bar across the top. The
         divider is a real 5px grid track, not an overlay: a track can be
         dragged without any element moving under the pointer. */
      display: grid;
      grid-template-columns: var(--chat-w) 5px minmax(0, 1fr);
      grid-template-rows: 52px minmax(0, 1fr);
      grid-template-areas:
        'top top top'
        'chat grip dash';

      --chat-w: 46%;

      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

      --t-meta: 10px;
      --t-ui: 12px;
      --t-name: 13px;
      --t-body: 13.5px;
      --t-input: 13.5px;

      --lh-tight: 1.25;
      --lh-body: 1.5;

      --s-1: 2px;
      --s-2: 4px;
      --s-3: 6px;
      --s-4: 8px;
      --s-5: 12px;
      --s-6: 16px;
      --s-7: 24px;

      --r-chip: 3px;
      --r-ctl: 5px;
      --r-card: 8px;

      --ink-1: var(--chrome-text-bright);
      --ink-2: color-mix(in srgb, var(--chrome-text-bright) 78%, var(--chrome-text-dim));
      --ink-3: color-mix(in srgb, var(--chrome-text-dim) 55%, var(--chrome-text-bright));

      --surface: var(--chrome-bar);
      --edge: color-mix(in srgb, var(--chrome-border) 40%, var(--chrome-text-dim));
      --scrim: color-mix(in srgb, var(--chrome-body) 62%, transparent);

      --need: var(--mux-warn);
      --work: var(--mux-ansi-6);
      --ok: var(--mux-ok);
      --fail: var(--mux-error);
      --autonomous: var(--chrome-driver-accent);

      --dur: 120ms;
      --ctl: 28px;
    }

    /* 16px is iOS Safari's focus-zoom threshold and index.html sets no
       maximum-scale, so on a touch device this is load-bearing, not taste.
       Desktop keeps the mockup's 13.5px. */
    @media (pointer: coarse) {
      :host {
        --t-input: 16px;
      }
    }

    /* Nothing on this surface animates by design (see the file header). The
       only transitions are colour/fill on hover and the sheet's own height,
       and someone who asked for less motion asked for less motion. */
    @media (prefers-reduced-motion: reduce) {
      :host {
        --dur: 0ms;
      }
      .sheet {
        transition: none;
      }
    }

    /* PORTRAIT. One column: the conversation. The topbar's job is done by
       the app's title bar (which says \"Dashboard\" and carries the fleet
       button), the divider has nothing to divide, and the fleet lives in the
       bottom sheet until asked for. */
    :host([narrow]) {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
      grid-template-areas: 'chat';
    }
    :host([narrow]) .topbar,
    :host([narrow]) .grip,
    :host([narrow]) .dash {
      display: none;
    }

    h1,
    h2 {
      margin: 0;
      font-size: inherit;
      font-weight: inherit;
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
      pointer-events: none;
    }

    /* -- TOPBAR ---------------------------------------------------------- */
    .topbar {
      grid-area: top;
      display: flex;
      align-items: center;
      gap: var(--s-5);
      position: relative;
      padding: 0 var(--s-6) 0 var(--s-7);
      border-bottom: 1px solid var(--chrome-border);
      background: var(--chrome-body);
    }
    .topbar h1 {
      font-size: 14px;
      font-weight: 600;
      line-height: 1;
      letter-spacing: 0.01em;
      color: var(--ink-1);
      flex: none;
    }
    .spacer {
      flex: 1;
      min-width: 0;
    }

    .dots {
      font: inherit;
      color: var(--ink-3);
      background: transparent;
      border: 0;
      width: var(--ctl);
      height: var(--ctl);
      display: grid;
      place-items: center;
      border-radius: var(--r-ctl);
      cursor: pointer;
      flex: none;
    }
    .dots:hover,
    .dots.on {
      background: var(--chrome-hover);
      color: var(--ink-1);
    }

    .dots:focus-visible,
    .btn:focus-visible,
    .cbtn:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }

    /* -- HOUSEKEEPING MENU ------------------------------------------------ */
    .menu {
      position: absolute;
      top: calc(100% + 4px);
      right: var(--s-6);
      z-index: 30;
      min-width: 288px;
      background: var(--surface);
      border: 1px solid var(--edge);
      border-radius: var(--r-card);
      padding: var(--s-3);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
    }
    .menu button {
      display: flex;
      width: 100%;
      align-items: center;
      gap: var(--s-5);
      text-align: left;
      font: inherit;
      font-size: 12.5px;
      line-height: 1.3;
      color: var(--ink-1);
      background: transparent;
      border: 0;
      padding: 9px var(--s-4);
      border-radius: var(--r-ctl);
      cursor: pointer;
    }
    .menu button:hover {
      background: var(--chrome-hover);
    }
    .menu button[disabled] {
      color: var(--ink-3);
      cursor: default;
    }
    .menu button[disabled]:hover {
      background: transparent;
    }
    .menu button.danger {
      color: var(--fail);
    }
    .menu button.danger:hover:not([disabled]) {
      background: color-mix(in srgb, var(--fail) 14%, var(--surface));
    }
    .msep {
      height: 1px;
      background: var(--chrome-border);
      margin: var(--s-3) var(--s-4);
    }

    /* -- CONVERSATION ----------------------------------------------------- */
    .chat {
      grid-area: chat;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }
    .chatbody {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: var(--s-7) var(--s-7) var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-7);
    }
    :host([narrow]) .chatbody {
      padding: var(--s-6) var(--s-6) var(--s-3);
      gap: var(--s-6);
    }

    .turn {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      gap: var(--s-5);
      align-items: start;
    }
    /* Portrait has no 42px to spare for a gutter, so the speaker label goes
       above its own words instead of beside them. */
    :host([narrow]) .turn {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--s-2);
    }
    .who {
      font-family: var(--mono);
      font-size: 10.5px;
      line-height: 1.8;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ink-3);
      user-select: none;
    }
    .turn.cos .who {
      color: var(--chrome-accent);
    }
    .bd {
      display: flex;
      flex-direction: column;
      gap: var(--s-5);
      min-width: 0;
    }
    .say {
      margin: 0;
      font-size: var(--t-body);
      line-height: var(--lh-body);
      color: var(--ink-1);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .turn.you .say {
      color: var(--ink-2);
    }

    /* -- MARKDOWN --------------------------------------------------------- *
     *
     * A rendered message is BLOCKS now, so pre-wrap is wrong for it: each
     * block owns its own whitespace, and leaving pre-wrap on would add the
     * source's newlines back on top of the paragraphs it just became. The
     * user's own prompt is still plain text and keeps it.
     *
     * min-width: 0 on the container is what stops a long code line or a wide
     * table from forcing the whole chat column wider than the pane. The
     * scrollers below then take the overflow, which is the ONE requirement
     * these styles have to meet rather than merely look nice: a code block
     * still being written must not push the conversation off screen.
     */
    .say.md,
    .thought.md {
      white-space: normal;
      min-width: 0;
    }
    .md > *:first-child {
      margin-top: 0;
    }
    .md > *:last-child {
      margin-bottom: 0;
    }
    .md .md-p {
      margin: 0 0 var(--s-4);
      overflow-wrap: anywhere;
    }
    .md .md-p:last-child {
      margin-bottom: 0;
    }
    .md .md-h {
      margin: var(--s-5) 0 var(--s-3);
      line-height: var(--lh-tight);
      font-weight: 600;
      color: var(--ink-1);
    }
    .md h1.md-h {
      font-size: 1.3em;
    }
    .md h2.md-h {
      font-size: 1.18em;
    }
    .md h3.md-h {
      font-size: 1.08em;
    }
    .md h4.md-h,
    .md h5.md-h,
    .md h6.md-h {
      font-size: 1em;
      color: var(--ink-2);
    }
    .md strong {
      font-weight: 650;
      color: var(--chrome-text-bright, var(--ink-1));
    }
    .md em {
      font-style: italic;
    }
    .md .md-code {
      font-family: var(--mono);
      font-size: 0.92em;
      padding: 0.1em 0.34em;
      border-radius: var(--r-ctl);
      background: var(--chrome-hover);
      overflow-wrap: anywhere;
    }
    .md .md-pre {
      margin: 0 0 var(--s-4);
      padding: var(--s-4);
      border: 1px solid var(--chrome-border);
      border-radius: var(--r-card);
      background: var(--chrome-bar);
      /* The block scrolls; the conversation does not reflow around it. */
      overflow-x: auto;
      max-width: 100%;
    }
    .md .md-pre code {
      font-family: var(--mono);
      font-size: 0.92em;
      line-height: var(--lh-tight);
      white-space: pre;
      color: var(--ink-1);
    }
    /* A fence whose closer has not arrived. Said quietly -- the reader can see
       the block growing; this only keeps the seam from looking finished. */
    .md .md-pre[data-streaming] {
      border-bottom-color: var(--chrome-accent);
    }
    .md .md-link {
      color: var(--chrome-accent);
      text-decoration: underline;
      text-underline-offset: 2px;
      overflow-wrap: anywhere;
    }
    .md .md-ul,
    .md .md-ol {
      margin: 0 0 var(--s-4);
      padding-left: var(--s-6);
    }
    .md .md-li {
      margin: var(--s-2) 0;
    }
    .md .md-li > .md-p {
      margin: 0;
    }
    .md .md-li .md-ul,
    .md .md-li .md-ol {
      margin: var(--s-2) 0 0;
    }
    .md .md-quote {
      margin: 0 0 var(--s-4);
      padding: 0 0 0 var(--s-4);
      border-left: 2px solid var(--chrome-border);
      color: var(--ink-2);
    }
    .md .md-hr {
      margin: var(--s-5) 0;
      border: 0;
      border-top: 1px solid var(--chrome-border);
    }
    .md .md-tablewrap {
      margin: 0 0 var(--s-4);
      overflow-x: auto;
      max-width: 100%;
    }
    .md .md-table {
      border-collapse: collapse;
      font-size: 0.94em;
    }
    .md .md-th,
    .md .md-td {
      padding: var(--s-2) var(--s-4);
      border: 1px solid var(--chrome-border);
      text-align: left;
      vertical-align: top;
    }
    .md .md-th {
      background: var(--chrome-bar);
      font-weight: 600;
      white-space: nowrap;
    }

    /* The state between \"sent\" and the first token. Said in words, in the
       same dimmed monospace idiom as a tool line -- there is no spinner and
       no dot that breathes. */
    .waiting {
      font-family: var(--mono);
      font-size: var(--t-ui);
      line-height: var(--lh-tight);
      color: var(--ink-3);
      padding: var(--s-1) 0;
    }

    /* -- TOOL ACTIVITY ---------------------------------------------------- */
    .tool {
      display: flex;
      align-items: baseline;
      gap: var(--s-4);
      font-family: var(--mono);
      font-size: 11.5px;
      line-height: 1.5;
      color: var(--ink-3);
      min-width: 0;
    }
    .tool .ok {
      color: var(--ok);
      flex: none;
    }
    .tool.fail .ok {
      color: var(--fail);
    }
    .tool .tname {
      color: var(--ink-2);
      flex: none;
    }
    .tool .targs {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.75;
    }
    .tool .ms {
      margin-left: auto;
      padding-left: var(--s-4);
      flex: none;
      opacity: 0.7;
      font-variant-numeric: tabular-nums;
    }

    /* -- THINKING --------------------------------------------------------- */
    .think {
      border-left: 2px solid var(--edge);
      padding-left: var(--s-5);
    }
    .think summary {
      list-style: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: var(--s-2);
      font-family: var(--mono);
      font-size: var(--t-meta);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ink-3);
    }
    .think summary::-webkit-details-marker {
      display: none;
    }
    .think summary:hover {
      color: var(--ink-2);
    }
    .think .thought {
      margin: var(--s-3) 0 0;
      font-size: 12.5px;
      line-height: var(--lh-body);
      color: var(--ink-3);
      font-style: italic;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    /* -- ASK / CONFIRM ---------------------------------------------------- */
    .ask,
    .confirm {
      border-radius: var(--r-card);
      padding: var(--s-6);
      display: flex;
      flex-direction: column;
      gap: var(--s-5);
    }
    .ask {
      border: 1px solid color-mix(in srgb, var(--need) 48%, transparent);
      background: color-mix(in srgb, var(--need) 9%, var(--surface));
    }
    .ask.settled {
      border-color: var(--edge);
      background: var(--surface);
    }
    .confirm {
      border: 1px solid color-mix(in srgb, var(--fail) 48%, transparent);
      background: color-mix(in srgb, var(--fail) 9%, var(--surface));
    }
    .ask .h {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      font-size: var(--t-name);
      font-weight: 600;
      line-height: 1;
      color: var(--need);
    }
    .ask.settled .h {
      color: var(--ink-3);
    }
    .confirm .h {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      font-size: var(--t-name);
      font-weight: 600;
      line-height: 1;
      color: var(--fail);
    }
    .ask .d,
    .confirm .d {
      margin: 0;
      font-size: 12.5px;
      line-height: var(--lh-body);
      color: var(--ink-2);
      overflow-wrap: anywhere;
    }
    .ask-tool {
      font-family: var(--mono);
      font-weight: 600;
      color: var(--ink-1);
      overflow-wrap: anywhere;
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--s-4);
      flex-wrap: wrap;
    }
    .btn {
      font: inherit;
      font-size: var(--t-ui);
      font-weight: 600;
      line-height: 1;
      padding: 8px 13px;
      border-radius: var(--r-ctl);
      cursor: pointer;
      border: 1px solid var(--edge);
      background: var(--surface);
      color: var(--ink-1);
    }
    .btn:hover:not([disabled]) {
      border-color: var(--chrome-accent);
    }
    .btn.pri {
      background: color-mix(in srgb, var(--ok) 20%, var(--surface));
      border-color: color-mix(in srgb, var(--ok) 55%, transparent);
    }
    .btn.no {
      color: var(--ink-2);
    }
    .btn.danger {
      color: var(--fail);
      border-color: color-mix(in srgb, var(--fail) 50%, transparent);
    }
    .btn[disabled] {
      opacity: 0.5;
      cursor: default;
    }
    .clock {
      margin-left: auto;
      font-family: var(--mono);
      font-size: 11.5px;
      line-height: 1;
      color: var(--ink-3);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .clock.soon {
      color: var(--fail);
    }
    .verdict {
      font-family: var(--mono);
      font-size: var(--t-ui);
      color: var(--ink-2);
      display: inline-flex;
      align-items: center;
      gap: var(--s-3);
    }

    /* -- TURN FOOTER / NOTICES -------------------------------------------- */
    .foot {
      display: flex;
      align-items: center;
      gap: var(--s-4);
      font-family: var(--mono);
      font-size: var(--t-meta);
      color: var(--ink-3);
      font-variant-numeric: tabular-nums;
    }
    .foot .cost {
      margin-left: auto;
    }
    .notice {
      font-size: var(--t-ui);
      color: var(--ink-3);
      border-left: 2px solid var(--edge);
      padding-left: var(--s-5);
    }
    .fatal {
      font-size: var(--t-ui);
      color: var(--fail);
      border: 1px solid var(--fail);
      border-radius: var(--r-ctl);
      background: color-mix(in srgb, var(--fail) 8%, var(--surface));
      padding: var(--s-4) var(--s-5);
    }

    /* -- EMPTY STATE ------------------------------------------------------ */
    .zero {
      display: flex;
      flex-direction: column;
      gap: var(--s-5);
      padding: var(--s-4) 0;
    }
    .lede {
      font-size: 18px;
      font-weight: 600;
      line-height: var(--lh-tight);
      color: var(--ink-1);
      letter-spacing: -0.01em;
    }
    .sub {
      margin: 0;
      font-size: var(--t-ui);
      color: var(--ink-3);
      max-width: 52ch;
    }

    /* -- COMPOSER ---------------------------------------------------------
       ONE rounded box. The controls live INSIDE it, at the bottom right,
       because they act on the thing above them. */
    .comp {
      position: relative;
      flex: none;
      padding: var(--s-4) var(--s-7) max(var(--s-6), env(safe-area-inset-bottom));
      background: var(--chrome-body);
    }
    :host([narrow]) .comp {
      padding: var(--s-3) var(--s-5) max(var(--s-5), env(safe-area-inset-bottom));
    }
    /* NO BORDER RULE above the composer. A hard line there cuts the
       conversation off mid-thought; a short fade says \"this scrolls under\"
       without drawing anything. */
    .comp::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: 100%;
      height: 22px;
      pointer-events: none;
      background: linear-gradient(to top, var(--chrome-body), transparent);
    }
    .cbox {
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--edge);
      border-radius: 14px;
      padding: var(--s-5) var(--s-5) var(--s-4);
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
    }
    .cbox:focus-within,
    .cbox.live {
      border-color: color-mix(in srgb, var(--chrome-accent) 55%, transparent);
    }
    .ctext {
      width: 100%;
      resize: none;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--ink-1);
      font: inherit;
      font-size: var(--t-input);
      line-height: 1.5;
      min-height: 21px;
      max-height: 120px;
      overflow-y: auto;
      display: block;
    }
    .ctext::placeholder {
      color: var(--ink-3);
    }
    .crow {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      justify-content: flex-end;
    }
    .cbtn {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      flex: none;
      display: grid;
      place-items: center;
      border: 0;
      background: transparent;
      color: var(--ink-3);
      cursor: pointer;
      padding: 0;
    }
    .cbtn:hover:not([disabled]) {
      background: var(--chrome-hover);
      color: var(--ink-1);
    }
    .cbtn.send {
      background: var(--ink-1);
      color: var(--chrome-body);
    }
    /* The voice control occupies the same 30px slot the send arrow does, so
       swapping between them does not reflow the composer row. The orb is
       sized to the slot; its halos overflow it, which is the intended look. */
    .cbtn.voice {
      background: transparent;
      overflow: visible;
    }
    .cbtn.voice mux-voice-orb {
      --orb-box: 30px;
      --orb-d: 22px;
      pointer-events: none;
    }
    .cbtn.voice:hover {
      background: transparent;
    }
    .cbtn.voice.live mux-voice-orb {
      --orb-d: 24px;
    }
    .cbtn.send:hover:not([disabled]) {
      background: var(--chrome-text-bright);
    }
    .cbtn.send[disabled] {
      background: transparent;
      color: var(--ink-3);
      cursor: default;
    }
    /* Listening. A filled red STOP, no ring, no pulse -- the square is the
       international \"press this to make it stop\" and needs no help. */
    .cbtn.rec,
    .cbtn.rec:hover {
      background: var(--fail);
      color: var(--chrome-body);
    }
    @media (pointer: coarse) {
      .cbtn {
        width: 40px;
        height: 40px;
      }
    }

    /* -- DIVIDER ---------------------------------------------------------- */
    .grip {
      grid-area: grip;
      background: var(--chrome-border);
      cursor: col-resize;
      position: relative;
      touch-action: none;
    }
    .grip:hover,
    .grip.drag {
      background: var(--chrome-accent);
    }
    /* The hit area is wider than the line. 5px is a visible rule; 15px is
       something a pointer can actually catch. */
    .grip::after {
      content: '';
      position: absolute;
      inset: 0 -5px;
      cursor: col-resize;
    }

    /* -- THE APPLET REGION ------------------------------------------------
       Formerly the fleet, in this shadow root. It is now one grid area
       handed whole to <mux-applets>: the tab strip must not scroll away, and
       the applet body owns its own scroller, so this element gives the host
       the full area and nothing else. */
    .dash {
      grid-area: dash;
      background: var(--chrome-bar);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }
    .dash mux-applets {
      flex: 1;
      min-height: 0;
      min-width: 0;
    }

    /* -- THE FLEET SHEET (portrait) ---------------------------------------
       Surface 3 of the mobile navigation design, and the SAME idiom as
       <mux-pane-picker>: native Popover API, so the top layer, light
       dismiss, Escape, focus and one-at-a-time are the browser's job and
       not a z-index ladder of ours. What this one adds is DETENTS. */
    .sheet {
      position: fixed;
      inset: auto 0 0 0;
      width: auto;
      max-width: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      height: 56dvh;
      background: var(--chrome-bar);
      color: var(--ink-1);
      border: 0;
      border-top: 1px solid var(--edge);
      border-radius: 16px 16px 0 0;
      box-shadow: 0 -12px 34px rgba(0, 0, 0, 0.55);
      translate: 0 100%;
      transition:
        height 0.32s cubic-bezier(0.32, 0.72, 0, 1),
        translate var(--dur) ease,
        display var(--dur) allow-discrete,
        overlay var(--dur) allow-discrete;
    }
    .sheet[data-state='full'] {
      height: calc(100dvh - ${SHEET_FULL_INSET}px);
    }
    .sheet:popover-open {
      translate: 0 0;
    }
    @starting-style {
      .sheet:popover-open {
        translate: 0 100%;
      }
    }
    .sheet::backdrop {
      background: var(--scrim);
    }
    /* While a finger is on the handle the height is written inline, frame by
       frame. A transition here would fight the pointer. */
    .sheet.dragging {
      transition: none;
    }
    .pshandle {
      position: relative;
      flex: none;
      height: 34px;
      display: grid;
      place-items: center;
      touch-action: none;
      cursor: grab;
    }
    .pshandle:active {
      cursor: grabbing;
    }
    .grab {
      width: 38px;
      height: 4px;
      border-radius: 2px;
      background: var(--edge);
    }
    .psx {
      position: absolute;
      right: var(--s-4);
      top: 50%;
      transform: translateY(-50%);
      width: 26px;
      height: 26px;
      border-radius: 50%;
      border: 0;
      background: transparent;
      color: var(--ink-3);
      display: grid;
      place-items: center;
      cursor: pointer;
      padding: 0;
    }
    .psx:hover {
      background: var(--chrome-hover);
      color: var(--ink-1);
    }
    .pslist {
      flex: 1;
      /* Load-bearing: without it a flex item refuses to shrink below its
         content and the bounded height this sheet exists to provide
         silently does not happen. */
      min-height: 0;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      padding: 0 var(--s-5) var(--s-6);
      padding-bottom: max(var(--s-6), env(safe-area-inset-bottom, 0px));
    }
    /* Portrait is CARDS ONLY -- a tile is a terminal thumbnail and needs
       width to say anything. The rule that enforces it USED to live here, as
       .pslist .thumb; a thumbnail is now inside the applet's shadow root
       where this selector cannot reach it, so the applet is handed insheet
       and suppresses its own thumbs. See applet-dashboard's
       :host([insheet]) .thumb. */
  `;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('mousedown', this._onOutsideClick);
    this._unsub = cosStore.subscribe(() => {
      this._version++;
    });
    // Session state is the Dashboard APPLET's subscription now, held only
    // while that applet is on screen. The adopt-current-state-on-reattach
    // reasoning moved with it, to applet-dashboard's _sync().
    this._unsubVoice = voiceInputController.onStateChange((s) => {
      this._voice = s;
    });
    this._unsubTranscript = voiceInputController.onTranscript((p) => {
      this._takeTranscript(p.text);
    });
    this._unsubSession = voiceSessionController.subscribe((s) => {
      this._session = s;
    });
    this._session = voiceSessionController.snapshot();
    // One second is the whole resolution of an mm:ss countdown, and the
    // ticker only runs while something is counting: an idle Dashboard costs
    // no timer.
    this._ticker = setInterval(() => {
      if (cosStore.approvals.length > 0) this._version++;
    }, 1000);
    this.style.setProperty('--chat-w', `${this._split}%`);
  }

  override disconnectedCallback(): void {
    document.removeEventListener('mousedown', this._onOutsideClick);
    this._unsub?.();
    this._unsub = null;
    this._unsubVoice?.();
    this._unsubVoice = null;
    this._unsubTranscript?.();
    this._unsubTranscript = null;
    this._unsubSession?.();
    this._unsubSession = null;
    // The live session is NOT stopped here. This element is parked by
    // cache() when the Dashboard closes, and hanging up a conversation
    // because a panel was collapsed would be the wrong reading of that
    // entirely -- the microphone stays live and the orb reappears in the
    // state the conversation is actually in when the panel reopens.
    if (this._ticker !== undefined) clearInterval(this._ticker);
    this._ticker = undefined;
    // Only OUR session. An unconditional abort here would kill a dictation
    // the title bar's mic started against a terminal pane.
    if (this._voice === 'listening') voiceInputController.invalidateIfActive();
    // NO DRAG MAY OUTLIVE THE DETACH. This element is parked by cache(), not
    // destroyed, so a _drag left non-null is still non-null when the Dashboard
    // reopens -- and _gripMove checks nothing else. Moving the mouse across
    // the grip with no button held would then resize the panel out from under
    // someone who never pressed anything.
    this._endDrags();
    // The divider position was only ever written in _gripUp, so a drag
    // interrupted by closing the Dashboard threw away the position the user
    // had just chosen.
    persistDashboardSplit(this._split);
    super.disconnectedCallback();
  }

  /** Cancel any drag in progress and leave no half-dragged DOM behind. */
  private _endDrags(): void {
    if (this._drag) {
      this._drag = null;
      this.renderRoot.querySelector<HTMLElement>('.grip')?.classList.remove('drag');
    }
    if (this._sheetDrag) {
      this._sheetDrag = null;
      const sheet = this._sheet;
      if (sheet) {
        sheet.classList.remove('dragging');
        // The inline height is the drag's, and _handleUp is what normally
        // clears it; without this the sheet reopens at whatever height the
        // interrupted gesture left it.
        sheet.style.height = '';
      }
    }
  }

  /** Put the caret in the box. Called by the app when the Dashboard opens. */
  focusComposer(): void {
    this.renderRoot.querySelector<HTMLTextAreaElement>('.ctext')?.focus();
  }

  override updated(): void {
    // Follow the stream only while the reader is at the bottom. Yanking the
    // scroller down under someone who deliberately scrolled up to re-read a
    // tool line is the fastest way to make a streaming surface unusable.
    if (!this._pinned) return;
    const el = this.renderRoot.querySelector<HTMLElement>('.chatbody');
    if (el) el.scrollTop = el.scrollHeight;
  }

  private _onScroll = (e: Event): void => {
    const el = e.target as HTMLElement;
    this._pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // -------------------------------------------------------------------------
  // The divider
  // -------------------------------------------------------------------------

  private _gripDown = (e: PointerEvent): void => {
    const grip = e.currentTarget as HTMLElement;
    this._drag = { pointerId: e.pointerId };
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('drag');
    e.preventDefault();
  };

  /**
   * Live resize.
   *
   * Written straight to the host's `--chat-w` rather than through @state: the
   * only thing that changes is one grid track, and a Lit update per
   * pointermove would re-render the whole transcript and every card sixty
   * times a second to move a line five pixels.
   */
  private _gripMove = (e: PointerEvent): void => {
    if (!this._drag) return;
    const r = this.getBoundingClientRect();
    if (r.width <= 0) return;
    this._split = clampDashboardSplit(((e.clientX - r.left) / r.width) * 100);
    this.style.setProperty('--chat-w', `${this._split.toFixed(1)}%`);
  };

  private _gripUp = (e: PointerEvent): void => {
    if (!this._drag) return;
    const grip = e.currentTarget as HTMLElement;
    try {
      grip.releasePointerCapture(this._drag.pointerId);
    } catch {
      /* the capture is already gone; releasing twice is not an error worth one */
    }
    grip.classList.remove('drag');
    this._drag = null;
    persistDashboardSplit(this._split);
  };

  // -------------------------------------------------------------------------
  // The fleet sheet (portrait)
  // -------------------------------------------------------------------------

  private get _sheet(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.sheet');
  }

  /** The title bar's fleet button. Open at HALF; a full sheet is a choice. */
  toggleFleet(): void {
    const sheet = this._sheet;
    if (!sheet) return;
    try {
      if (sheet.matches(':popover-open')) {
        sheet.hidePopover();
        this._sheetOpen = false;
      } else {
        this._setDetent('half');
        sheet.showPopover();
        // Set BEFORE the toggle event arrives so the applet inside subscribes
        // and adopts the store in the same update that reveals it -- opening
        // the sheet onto one frame of "Nothing is running" is a lie.
        this._sheetOpen = true;
      }
    } catch {
      /* raced with a light dismiss; the toggle event below settles the truth */
    }
  }

  private _hideSheet = (): void => {
    try {
      this._sheet?.hidePopover();
    } catch {
      /* already closed */
    }
    this._sheetOpen = false;
  };

  private _setDetent(d: SheetDetent): void {
    this._detent = d;
    const sheet = this._sheet;
    if (!sheet) return;
    sheet.style.height = '';
    sheet.dataset['state'] = d;
  }

  /**
   * The browser owns open/closed (light dismiss and Escape never reach a
   * handler of ours), so the button's state is mirrored FROM the popover
   * rather than set by whatever asked it to open.
   */
  private _onSheetToggle = (e: Event): void => {
    const open = (e as ToggleEvent).newState === 'open';
    // Authoritative, including for the closes nothing of ours asked for --
    // light dismiss and Escape. A sheet closed that way must still put the
    // applet inside it back to sleep.
    this._sheetOpen = open;
    this.dispatchEvent(
      new CustomEvent('fleet-state', { detail: { open }, bubbles: true, composed: true }),
    );
  };

  private _handleDown = (e: PointerEvent): void => {
    // The dismiss button LIVES INSIDE the drag handle, and without this guard
    // it is unclickable: pointerdown on the X bubbles here, this handler
    // captures the pointer, and every later event -- including the mouseup
    // that would have completed the click -- retargets to the handle. The
    // button's @click never fires and the tap reads as a detent toggle
    // instead. Caught by trying to close the sheet with the X and watching it
    // grow to full instead.
    if ((e.target as HTMLElement | null)?.closest('.psx')) return;
    const handle = e.currentTarget as HTMLElement;
    this._sheetDrag = { pointerId: e.pointerId, moved: false };
    handle.setPointerCapture(e.pointerId);
    this._sheet?.classList.add('dragging');
    e.preventDefault();
  };

  private _handleMove = (e: PointerEvent): void => {
    if (!this._sheetDrag) return;
    const sheet = this._sheet;
    if (!sheet) return;
    this._sheetDrag.moved = true;
    const vh = window.innerHeight;
    const h = Math.max(0, Math.min(vh - SHEET_FULL_INSET, vh - e.clientY));
    sheet.style.height = `${h}px`;
  };

  /**
   * Release. A tap toggles half<->full; a drag snaps to the nearest detent,
   * and dragging most of the way down dismisses -- the gesture that put the
   * sheet where it is can also put it away, which is why there is no separate
   * \"close\" affordance to learn beyond the X.
   */
  private _handleUp = (e: PointerEvent): void => {
    const drag = this._sheetDrag;
    if (!drag) return;
    this._sheetDrag = null;
    const handle = e.currentTarget as HTMLElement;
    try {
      handle.releasePointerCapture(drag.pointerId);
    } catch {
      /* already released */
    }
    const sheet = this._sheet;
    if (!sheet) return;
    sheet.classList.remove('dragging');
    if (!drag.moved) {
      this._setDetent(this._detent === 'half' ? 'full' : 'half');
      return;
    }
    const pct = sheet.getBoundingClientRect().height / Math.max(1, window.innerHeight);
    sheet.style.height = '';
    if (pct < SHEET_DISMISS_AT) {
      this._hideSheet();
      // The detent it will re-open at, not the one it was dragged to.
      this._detent = 'half';
      sheet.dataset['state'] = 'half';
      return;
    }
    this._setDetent(pct < SHEET_FULL_AT ? 'half' : 'full');
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  override render(): TemplateResult {
    void this._version; // read so Lit re-renders on every store notification
    return html`
      ${this._renderTopbar()}
      <div class="chat">
        <div class="chatbody" @scroll="${this._onScroll}">
          ${this._renderThread()}
        </div>
        ${this._renderComposer()}
      </div>
      <div
        class="grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the conversation"
        title="Drag to resize"
        @pointerdown="${this._gripDown}"
        @pointermove="${this._gripMove}"
        @pointerup="${this._gripUp}"
        @pointercancel="${this._gripUp}"
      ></div>
      <div class="dash"><mux-applets .narrow="${this.narrow}"></mux-applets></div>
      ${this.narrow ? this._renderSheet() : nothing}
    `;
  }

  private _renderTopbar(): TemplateResult {
    return html`
      <div class="topbar">
        <h1>Mission Control</h1>
        <span class="spacer"></span>
        <button
          class="dots ${this._menuOpen ? 'on' : ''}"
          type="button"
          aria-label="Conversation options"
          aria-expanded="${this._menuOpen ? 'true' : 'false'}"
          @click="${this._toggleMenu}"
        >${icon(Ellipsis, { size: 16 })}</button>
        ${this._menuOpen ? this._renderMenu() : nothing}
      </div>
    `;
  }

  /**
   * Housekeeping. No counts -- see the file header -- so the items say what
   * they will do and the confirm says what it costs, and neither offers a
   * number to weigh the decision against.
   */
  private _renderMenu(): TemplateResult {
    const any = cosStore.hasMessages;
    return html`
      <div class="menu" role="menu">
        <button
          type="button"
          role="menuitem"
          ?disabled="${!any}"
          @click="${() => this._ask(7)}"
        >Clear messages older than 7 days</button>
        <button
          type="button"
          role="menuitem"
          ?disabled="${!any}"
          @click="${() => this._ask(30)}"
        >Clear messages older than 30 days</button>
        <div class="msep"></div>
        <button
          type="button"
          role="menuitem"
          class="danger"
          ?disabled="${!any}"
          @click="${() => this._ask('all')}"
        >Clear all messages</button>
      </div>
    `;
  }

  private _renderThread(): TemplateResult {
    const turns = cosStore.turns;
    const fault = cosStore.fault;
    return html`
      ${turns.length === 0 && !this._confirm ? this._renderZero() : nothing}
      ${turns.map((t) => this._renderTurn(t))}
      ${fault && fault.fatal
        ? html`<div class="fatal" role="alert">${fault.message}</div>`
        : nothing}
      ${fault && !fault.fatal ? html`<div class="notice">${fault.message}</div>` : nothing}
      ${this._confirm !== null ? this._renderConfirm(this._confirm) : nothing}
    `;
  }

  private _renderZero(): TemplateResult {
    return html`
      <div class="zero">
        <div class="lede">What needs you?</div>
        <p class="sub">
          Describe a problem and your chief of staff splits it, routes it, and
          starts the lanes. What it starts shows up on the right.
        </p>
      </div>
    `;
  }

  private _renderTurn(t: CosTurn): TemplateResult {
    const asks = cosStore.approvals.filter((a) => a.turnId === t.id);
    const live = t.status === 'pending' || t.status === 'streaming';
    return html`
      ${t.prompt
        ? html`<div class="turn you">
            <div class="who">you</div>
            <div class="bd"><p class="say">${t.prompt}</p></div>
          </div>`
        : nothing}
      <div class="turn cos">
        <div class="who">cos</div>
        <div class="bd">
          ${t.blocks.map((b, i) => this._renderBlock(t, b, i))}
          ${live && t.blocks.length === 0
            ? html`<div class="waiting">working...</div>`
            : nothing}
          <!--
            A turn CAN legitimately end with no reply: the loop stops after a
            tool result and the model never speaks again, so turn_end carries
            an empty response. Rendering that as nothing at all is accurate
            and unusable -- it is pixel-for-pixel identical to a reply that
            was lost on the wire, and it has been read as exactly that. Say
            which one it was. 'cancelled' and 'failed' already say so in the
            footer; 'done' is the silent case, so it is the only one here.
          -->
          ${!live && t.status === 'done' && !t.blocks.some((b) => b.kind === 'text')
            ? html`<div class="waiting">ended without a reply</div>`
            : nothing}
          ${asks.map((a) => this._renderAsk(a))}
          ${t.notices.map((n) => html`<div class="notice">${n}</div>`)}
          ${this._renderFoot(t)}
        </div>
      </div>
    `;
  }

  private _renderBlock(t: CosTurn, b: CosBlock, i: number): TemplateResult {
    // Only the LAST block of a live turn is still being written. An earlier
    // one is finished even though the turn is not, so it gets its final,
    // unspeculated render immediately rather than waiting for turn_end.
    const live = t.status === 'pending' || t.status === 'streaming';
    const streaming = live && i === t.blocks.length - 1;

    if (b.kind === 'text') {
      return html`<div class="say md">${renderMarkdown(b, b.text, streaming)}</div>`;
    }
    if (b.kind === 'thinking') {
      const key = `${t.id}:${i}`;
      const open = this._showThinking.has(key);
      return html`
        <details class="think" ?open="${open}" @toggle="${(e: Event) => this._onThink(key, e)}">
          <summary>${icon(ChevronDown, { size: 11 })} thinking</summary>
          <div class="thought md">${renderMarkdown(b, b.text, streaming)}</div>
        </details>
      `;
    }
    const cls = b.done && !b.ok ? 'tool fail' : 'tool';
    const right = b.done ? (b.ms > 0 ? `${b.ms}ms` : b.ok ? 'ok' : 'failed') : '...';
    return html`
      <div class="${cls}" title="${b.summary || b.name}">
        <span class="ok">${b.done ? (b.ok ? '\u2713' : '\u2717') : '\u00b7'}</span>
        <span class="tname">${shortToolName(b.name) || 'tool'}</span>
        <span class="targs">${b.summary && b.done ? b.summary : b.args}</span>
        <span class="ms">${right}</span>
      </div>
    `;
  }

  /**
   * The approval. Its countdown renders the sidecar's own timer, and a
   * timeout there resolves to DENIED -- so running out is safe, and saying
   * how long is left is honesty rather than pressure.
   */
  private _renderAsk(a: CosApproval): TemplateResult {
    const left = a.deadline - Date.now();
    const settled = a.answered !== '';
    return html`
      <div class="ask ${settled ? 'settled' : ''}" role="alertdialog" aria-label="Approval requested">
        <div class="h">
          ${icon(TriangleAlert, { size: 13 })} approve
          <span class="ask-tool">${shortToolName(a.tool) || a.tool}</span>
        </div>
        ${a.detail ? html`<p class="d">${a.detail}</p>` : nothing}
        <div class="row">
          ${settled
            ? html`<span class="verdict">${icon(Check, { size: 12 })} ${a.answered}</span>`
            : html`
                <button
                  class="btn pri"
                  type="button"
                  @click="${() => cosStore.answer(a.requestId, true)}"
                >approve</button>
                <button
                  class="btn no"
                  type="button"
                  @click="${() => cosStore.answer(a.requestId, false)}"
                >deny</button>
                <span class="clock ${left < 30000 ? 'soon' : ''}">${clock(left)} left</span>
              `}
        </div>
      </div>
    `;
  }

  private _renderFoot(t: CosTurn): TemplateResult | typeof nothing {
    if (t.status === 'pending' || t.status === 'streaming') return nothing;
    const bits: string[] = [];
    if (t.status === 'cancelled') bits.push('cancelled');
    if (t.status === 'failed') bits.push(t.error || 'failed');
    if (t.ms > 0) bits.push(`${(t.ms / 1000).toFixed(1)}s`);
    if (bits.length === 0 && !t.costUsd) return nothing;
    return html`
      <div class="foot">
        <span>${bits.join(' \u00b7 ')}</span>
        ${t.costUsd ? html`<span class="cost">$${t.costUsd}</span>` : nothing}
      </div>
    `;
  }

  /**
   * The confirm, rendered INTO the conversation rather than as a modal.
   *
   * Both promises the store actually keeps are stated here, because a
   * destructive action a user cannot predict the blast radius of is one they
   * will simply never take.
   */
  private _renderConfirm(which: Housekeeping): TemplateResult {
    const all = which === 'all';
    const head = all
      ? 'Clear all messages?'
      : `Clear messages older than ${which} days?`;
    const detail = all
      ? 'Your chief of staff forgets this conversation entirely. Running lanes are unaffected \u2014 no session is stopped, closed or altered \u2014 and it will not drop a message about a lane that is still alive.'
      : 'Anything older goes. Running lanes are unaffected \u2014 no session is stopped, closed or altered \u2014 and it will not drop a message about a lane that is still alive.';
    return html`
      <div class="turn">
        <div class="who"></div>
        <div class="bd">
          <div class="confirm" role="alertdialog" aria-label="${head}">
            <div class="h">${icon(TriangleAlert, { size: 13 })} ${head}</div>
            <p class="d">${detail}</p>
            <div class="row">
              <button class="btn danger" type="button" @click="${this._doClear}">
                ${all ? 'Clear everything' : 'Clear them'}
              </button>
              <button
                class="btn no"
                type="button"
                @click="${() => {
                  this._confirm = null;
                }}"
              >Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * The composer's send slot, when there is nothing to send.
   *
   * `ready` is false whenever the box is empty, and the send button was
   * already `?disabled` in exactly that case -- a DEAD AFFORDANCE sitting in
   * the most reachable position on the surface. So the slot is swapped
   * rather than greyed out: text present, send arrow; box empty, the voice
   * control. No new chrome is added anywhere, and a control that did nothing
   * becomes the front door to the feature.
   *
   * The mic button to its left is untouched. Dictation and a live session
   * are different jobs -- one is free and fills the box for you to check,
   * the other is metered and acts -- and they must not share a control.
   */
  private _renderVoiceControl(): TemplateResult {
    const s = this._session;
    const active = s.state !== 'idle' && s.state !== 'error';
    const orbState =
      s.state === 'idle' || s.state === 'error' ? 'asleep' : s.state;
    const label = active ? 'End the spoken conversation' : 'Talk to the chief of staff';
    return html`
      <button
        class="cbtn voice ${active ? 'live' : ''}"
        type="button"
        title="${s.state === 'error' && s.error ? s.error : label}"
        aria-label="${label}"
        aria-pressed="${active ? 'true' : 'false'}"
        data-voice-state="${s.state}"
        @click="${this._toggleSession}"
      >
        <mux-voice-orb .state="${orbState}" .level="${s.level}"></mux-voice-orb>
      </button>
    `;
  }

  private _toggleSession = (): void => {
    void voiceSessionController.toggle();
  };

  private _renderComposer(): TemplateResult {
    const ready = this._draft.trim().length > 0;
    const listening = this._voice === 'listening';
    const busy = cosStore.busy;
    const last = cosStore.turns[cosStore.turns.length - 1];
    return html`
      <div class="comp">
        <div class="cbox ${listening ? 'live' : ''}">
          <textarea
            class="ctext"
            rows="1"
            autocomplete="off"
            spellcheck="false"
            placeholder="describe a problem\u2026"
            aria-label="Describe a problem"
            .value="${this._draft}"
            @input="${this._onDraft}"
            @keydown="${this._onKey}"
          ></textarea>
          <div class="crow">
            ${busy && last
              ? html`<button
                  class="btn no"
                  type="button"
                  @click="${() => cosStore.cancel(last.id)}"
                >stop</button>`
              : nothing}
            ${voiceInputController.isSupported()
              ? html`<button
                  class="cbtn ${listening ? 'rec' : ''}"
                  type="button"
                  title="${listening ? 'Stop dictating' : 'Dictate'}"
                  aria-label="${listening ? 'Stop dictating' : 'Dictate'}"
                  aria-pressed="${listening ? 'true' : 'false'}"
                  @click="${this._toggleVoice}"
                >${listening ? icon(Square, { size: 13 }) : icon(Mic, { size: 16 })}</button>`
              : nothing}
            ${ready || !voiceSessionController.isSupported()
              ? html`<button
                  class="cbtn send"
                  type="button"
                  aria-label="Send"
                  ?disabled="${!ready}"
                  @click="${this._submit}"
                >${icon(ArrowUp, { size: 15 })}</button>`
              : this._renderVoiceControl()}
          </div>
        </div>
      </div>
    `;
  }

  // -------------------------------------------------------------------------
  // The fleet sheet (portrait)
  // -------------------------------------------------------------------------

  /**
   * A SECOND instance of the Dashboard applet, not the one in the applet
   * host: in portrait the whole right-hand region is display:none and the
   * fleet is this sheet instead. `insheet` is what tells it so -- the sheet
   * owns the scroller and portrait draws no thumbnails.
   *
   * `home-open` is caught HERE rather than fired here. Opening a pane used to
   * close the sheet as part of the same method; the applet dispatches the
   * event now, so the sheet listens for it on its way past.
   */
  private _renderSheet(): TemplateResult {
    return html`
      <div
        class="sheet"
        popover="auto"
        data-state="half"
        aria-label="Fleet"
        @toggle="${this._onSheetToggle}"
        @home-open="${this._hideSheet}"
      >
        <div
          class="pshandle"
          @pointerdown="${this._handleDown}"
          @pointermove="${this._handleMove}"
          @pointerup="${this._handleUp}"
          @pointercancel="${this._handleUp}"
        >
          <span class="grab"></span>
          <button
            class="psx"
            type="button"
            aria-label="Close the fleet"
            @click="${this._hideSheet}"
          >${icon(X, { size: 14 })}</button>
        </div>
        <div class="pslist">
          <applet-dashboard insheet .active="${this._sheetOpen}"></applet-dashboard>
        </div>
      </div>
    `;
  }

  // -------------------------------------------------------------------------
  // Intent
  // -------------------------------------------------------------------------

  private _toggleMenu = (e: Event): void => {
    e.stopPropagation();
    this._menuOpen = !this._menuOpen;
  };

  /**
   * Dismiss the housekeeping menu on a press anywhere outside it.
   *
   * <mux-sidebar> installs the same document listener for the same reason. The
   * PREDICATE differs on purpose: that menu's outside is outside the element,
   * while this one floats over its own component, so
   * `!composedPath().includes(this)` would leave it hanging over the fleet,
   * the transcript and the composer -- everything a user is likely to press
   * next. What counts as outside here is "not the menu, and not the button
   * that opened it".
   *
   * mousedown rather than click: the toggle stops propagation on the click,
   * and a press that starts a drag or lands on a scrollbar never produces one.
   * The dots button is excluded so its own click still closes the menu instead
   * of re-opening what this had just closed.
   */
  private _onOutsideClick = (e: MouseEvent): void => {
    if (!this._menuOpen) return;
    const path = e.composedPath();
    const pressed = (sel: string): boolean => {
      const el = this.renderRoot.querySelector(sel);
      return el !== null && path.includes(el);
    };
    if (pressed('.menu') || pressed('.dots')) return;
    this._menuOpen = false;
  };

  private _ask(which: Housekeeping): void {
    this._menuOpen = false;
    this._confirm = which;
    this._pinned = true;
  }

  private _doClear = (): void => {
    const which = this._confirm;
    this._confirm = null;
    if (which === null) return;
    cosStore.clear(which);
  };

  private _onThink(key: string, e: Event): void {
    const open = (e.target as HTMLDetailsElement).open;
    const next = new Set(this._showThinking);
    if (open) next.add(key);
    else next.delete(key);
    this._showThinking = next;
  }

  private _onDraft = (e: Event): void => {
    const el = e.target as HTMLTextAreaElement;
    this._draft = el.value;
    this._fit(el);
  };

  /**
   * Grow with the text up to the CSS max-height, then scroll. Passing an
   * empty value back through here is what returns the box to one row --
   * without it, sending a long prompt leaves a tall EMPTY composer behind,
   * because the inline height outlives the value it was measured from.
   */
  private _fit(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  private _onKey = (e: KeyboardEvent): void => {
    // The Dashboard is not a terminal, but the app around it is: never let a
    // keystroke meant for this box reach a pane.
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._submit();
      return;
    }
    if (e.key === 'Escape') {
      // Escape unwinds one layer at a time. Only a composer with nothing
      // pending in front of it leaves the surface.
      if (this._menuOpen || this._confirm !== null) {
        e.preventDefault();
        this._menuOpen = false;
        this._confirm = null;
        return;
      }
      this.dispatchEvent(new CustomEvent('home-dismiss', { bubbles: true, composed: true }));
    }
  };

  private _submit = (): void => {
    const prompt = this._draft.trim();
    if (!prompt) return;
    // The store refuses when the socket is not open. Clearing the box anyway
    // would take the sentence away on exactly the occasion nothing was sent
    // with it, which is when the user most needs it back.
    if (!cosStore.send(prompt)) return;
    this._draft = '';
    this._pinned = true;
    void this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector<HTMLTextAreaElement>('.ctext');
      if (el) this._fit(el);
    });
  };

  private _toggleVoice = (): void => {
    if (this._voice === 'listening') voiceInputController.stop();
    else voiceInputController.start();
  };

  /**
   * A finished transcript.
   *
   * It fills the COMPOSER; it does not send. Dictation is unreliable enough
   * that firing a turn off the back of it would make the surface feel like it
   * acts on things you did not say -- and the box is right there to fix a
   * word in before pressing send.
   */
  private _takeTranscript(text: string): void {
    const t = text.trim();
    if (!t) return;
    this._draft = this._draft.trim() === '' ? t : `${this._draft.trimEnd()} ${t}`;
    void this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector<HTMLTextAreaElement>('.ctext');
      if (el) {
        this._fit(el);
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }

}

declare global {
  interface HTMLElementTagNameMap {
    'mux-cos': MuxCos;
  }
}
