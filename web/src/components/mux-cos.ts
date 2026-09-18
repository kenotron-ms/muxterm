/**
 * mux-cos.ts -- Mission Control. ONE surface.
 *
 * Not a peer of <mux-home>: it IS home. The left column is a conversation with
 * Operator; the right column is <mux-applets>, a tab strip over a
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
 *   - no status pip. \"Operator is up\" is not a thing a human is
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
 * PRESENTATIONAL over the conversation coordinator, read-only here: it renders
 * the one persistent conversation. Session state belongs to the Dashboard applet now, which
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
import { ArrowUp, Check, ChevronDown, Ellipsis, FileText, Mic, Paperclip, Square, TriangleAlert, X } from 'lucide';
import type { AppletChangedDetail, AppletId } from '../lib/applet-registry.js';
import {
  shortToolName,
  type CosComposerIdentity,
  type CosApproval,
  type CosBlock,
  type CosTurn,
} from '../lib/cos-store.js';
import { cosStore } from '../lib/cos-store.js';
import {
  humanBytes,
  isImageMedia,
  type CosAttachmentRef,
  type CosDraftAttachment,
} from '../lib/cos-attachments.js';
import { ASSISTANT_ALIAS, ASSISTANT_NAME } from '../lib/assistant-identity.js';
import {
  clampDashboardSplit,
  persistDashboardSplit,
  restoreDashboardSplit,
} from '../lib/dashboard-split.js';
import {
  voiceInputController,
  type ComposerDictationCapture,
  type VoiceState,
  type VoiceTranscriptPayload,
} from '../lib/voice-input-controller.js';
import {
  voiceSessionController,
  type VoiceSessionSnapshot,
} from '../lib/voice-session-controller.js';
import './mux-voice-orb.js';
// ONE applet host, in one of two containers: the right-hand region in
// landscape, the bottom sheet in portrait. This file imports no applet: the
// host owns the registry and mounts whatever is in it, which is the whole
// reason a new applet costs the phone nothing.
import './mux-applets.js';
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

function isSessionLive(snapshot: VoiceSessionSnapshot): boolean {
  return snapshot.state !== 'idle' && snapshot.state !== 'blocked';
}

function voiceControlLabel(snapshot: VoiceSessionSnapshot): string {
  if (isSessionLive(snapshot)) return 'End the spoken conversation';
  switch (snapshot.blockedReason) {
    case 'microphone-permission-denied':
      return 'Allow microphone access in browser settings to use Voice Mode';
    case 'insecure-context':
      return 'Use a secure browser context to use Voice Mode';
    case 'browser-unsupported':
      return 'Use a supported browser to use Voice Mode';
    default:
      return 'Talk to Operator';
  }
}

interface HeldVoiceComposer {
  readonly identity: CosComposerIdentity;
  readonly draft: string;
  readonly start: number;
  readonly end: number;
  readonly focused: boolean;
}

let heldVoiceComposer: HeldVoiceComposer | null = null;

function sameComposerIdentity(a: CosComposerIdentity, b: CosComposerIdentity): boolean {
  return a.channelId === b.channelId &&
    a.threadId === b.threadId &&
    a.runtimeSessionId === b.runtimeSessionId &&
    a.runtimeGeneration === b.runtimeGeneration &&
    a.runtimeIncarnation === b.runtimeIncarnation &&
    a.draftRef === b.draftRef;
}

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

  /** Bumped by the conversation coordinator and by the approval ticker. */
  @state() private _version = 0;

  /**
   * Draft ownership lives in the one persistent CosStore conversation.
   */
  private get _draft(): string {
    return cosStore.draft;
  }

  private set _draft(value: string) {
    cosStore.setDraft(value);
    this.requestUpdate();
  }

  @state() private _showThinking = new Set<string>();
  @state() private _menuOpen = false;
  /** Which housekeeping action is awaiting a yes. null = none pending. */
  @state() private _confirm: Housekeeping | null = null;
  @state() private _voice: VoiceState = voiceInputController.getState();
  @state() private _voiceSession: VoiceSessionSnapshot = voiceSessionController.snapshot();
  @state() private _textMode = false;
  @state() private _primaryMenuOpen = false;
  /**
   * Drag depth, not a boolean: dragenter/dragleave fire for every child the
   * pointer crosses, so a plain flag flickers the highlight off the moment the
   * cursor passes over the textarea inside the drop zone.
   */
  private _dragDepth = 0;
  @state() private _dropActive = false;
  /** The last thing said about attachments, announced politely once. */
  @state() private _attachNotice = '';
  private _heldVoiceComposer: HeldVoiceComposer | null = null;
  /** Last value whose inline textarea geometry was deliberately settled. */
  private _sizedDraft: string | null = null;

  /**
   * Whether the portrait applet sheet is open.
   *
   * Its ONLY job is to tell the applet host inside the sheet whether anyone
   * can see it -- a closed sheet must not leave a subscription running, for
   * exactly the reason a hidden applet must not. It used to say that to one
   * hardcoded Dashboard; it says it to the host now, which spends it on every
   * applet at once (`dormant`, in mux-applets.ts). The browser owns
   * open/closed (see _onSheetToggle); this mirrors it.
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
  private _unsubVoiceSession: (() => void) | null = null;
  private _unsubTranscript: (() => void) | null = null;
  private _ticker: ReturnType<typeof setInterval> | undefined;
  private _primaryHoldTimer: ReturnType<typeof setTimeout> | undefined;
  private _suppressPrimaryClick = false;

  /** False once the reader scrolls up: streaming must not yank them back down. */
  private _pinned = true;

  /** Live divider drag. null when the grip is not held. */
  private _drag: { pointerId: number } | null = null;

  /** Live sheet drag. `moved` separates a drag from a tap on the handle. */
  private _sheetDrag: { pointerId: number; moved: boolean } | null = null;
  private _detent: SheetDetent = 'half';
  /** True only for a dictation session this chat composer itself started. */
  private _chatDictationActive = false;
  /** Immutable capture identity used to reject late A results while B is visible. */
  private _chatDictationCapture: ComposerDictationCapture | null = null;
  private _activeApplet: AppletId | '' = '';

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
      /* D3. The top row is THE shared top-chrome height token -- the same one
         <mux-title-bar> reads as --nav-h and <mux-sidebar>'s .header reads as
         its height. This surface sits in the same top row as that sidebar
         header, side by side, so a literal here (it was 52px) is an 8px step
         between two things a person sees as one bar.

         WHY THE TRACK AND NOT .topbar. .topbar is grid-area: top, so this
         track is a hard floor and ceiling on it: an explicit height on .topbar
         cannot win against a track that disagrees, it can only sit inside one
         and leave a gap above the divider. The track is where the height is
         actually decided, so the token goes here and .topbar stretches to it.
         Declaring it in both places would be two places to forget, which is
         the exact failure the token exists to prevent.

         box-sizing is already handled: the shadow-root reset at the top of
         this stylesheet makes everything in here border-box, so the 1px
         border-bottom sits INSIDE the row rather than adding a pixel to it.
         (mux-sidebar has to say so itself because it has no such reset.) */
      grid-template-rows: var(--mux-titlebar-height, var(--mux-dock-height, 44px)) minmax(0, 1fr);
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

      /* Height of the fade the transcript scrolls under, above the composer.
         ONE token, for the same reason --mux-titlebar-height is one: the fade
         is drawn by .comp::before and the transcript has to reserve room for
         it inside its own scroller, and two literals that must agree are two
         places to forget. Read by .comp::before (the fade itself) and by
         .chatbody's padding-bottom (the room under it). */
      --chat-fade: 22px;

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
       button), the divider has nothing to divide, and the applets live in the
       bottom sheet until asked for. */
    :host([narrow]) {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
      grid-template-areas: 'chat';
    }
    /* No .dash here: in portrait that region is not rendered at all, rather
       than rendered and hidden. The distinction is the applet host's whole
       subscription rule -- a host inside a display:none region is still a
       mounted host with an ACTIVE applet in it, polling for a strip of screen
       nobody can see. Hiding a thing does not stop it working. */
    :host([narrow]) .topbar,
    :host([narrow]) .grip {
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

    /* -- TOPBAR ----------------------------------------------------------
       Its HEIGHT is not here: it is the "top" grid track on :host, which is
       --mux-titlebar-height, shared with <mux-title-bar> and <mux-sidebar>'s
       .header. Do not add a height to this rule -- a height that disagrees
       with the track cannot win it, it only opens a gap above the divider.
       Read the comment on grid-template-rows above before changing either. */
    .topbar {
      grid-area: top;
      display: flex;
      align-items: center;
      gap: var(--s-5);
      position: relative;
      padding: 0 var(--s-6) 0 var(--main-header-inline-padding, var(--s-7));
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

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: none;
    }

    .dots {
      font: inherit;
      color: var(--ink-3);
      background: transparent;
      border: 0;
      width: 44px;
      height: 44px;
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
    /* THE ROOM UNDER THE LAST LINE. The bottom padding is the ordinary gap
       (--s-4 / --s-3) PLUS the height of the fade, because the fade is drawn
       over this scroller's last --chat-fade pixels: without the extra, a
       reader scrolled all the way down lands the final line UNDER the
       gradient and reads it at a fraction of its contrast.
       It has to be padding on the SCROLLER'S OWN CONTENT BOX -- that is what
       is counted in scrollHeight, so it is what moves where scrollTop bottoms
       out. Margin on the last child, or padding on .chat, changes nothing
       about where the content stops relative to the mask. scroll-padding is
       also the wrong tool: it steers scrollIntoView and snapping, and does
       not move the end of the scroll range, which is exactly what both the
       reader's own scroll-to-bottom and the pinned-follow write in updated()
       (scrollTop = scrollHeight) land on. */
    .chatbody {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: var(--s-7) var(--s-7) calc(var(--chat-fade) + var(--s-4));
      display: flex;
      flex-direction: column;
      gap: var(--s-7);
    }
    :host([narrow]) .chatbody {
      padding: var(--s-6) var(--s-6) calc(var(--chat-fade) + var(--s-3));
      gap: var(--s-6);
    }

    .turn {
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
      min-width: 0;
    }
    .who {
      display: block;
      flex: none;
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
      width: 100%;
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
      overflow-wrap: anywhere;
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
      box-sizing: border-box;
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
      min-width: 0;
    }
    .md .md-table {
      border-collapse: collapse;
      font-size: 0.94em;
      max-width: none;
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
      /* Same token .chatbody reserves room for. Change it in one place. */
      height: var(--chat-fade);
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
    .cbox.live,
    .cbox.solo {
      border-color: color-mix(in srgb, var(--chrome-accent) 55%, transparent);
    }
    /* THE COMPOSER, DURING A CALL. It has only the intentional compact size
       needed by the orb. It must never inherit a stale multiline textarea
       height from the text composer it replaced. */
    .cbox.solo {
      position: relative;
      align-items: center;
      justify-content: center;
      padding: 0;
      min-height: 72px;
    }
    /* THE WAY BACK TO THE KEYBOARD, without hanging up.
       A NAVIGATION control, and built to read as one: no fill, no ring, no
       30px slot -- a plain word, dim, parked at the edge. Absolutely positioned
       so it takes NO layout space: the box stays pinned to the height the log
       gave up, and the orb stays centred on both axes exactly as it was before
       this existed. */
    .tomode {
      position: absolute;
      right: var(--s-5);
      top: 50%;
      transform: translateY(-50%);
      border: 0;
      background: transparent;
      color: var(--ink-3);
      font: inherit;
      font-size: var(--t-meta);
      line-height: 1;
      padding: var(--s-2) var(--s-3);
      border-radius: 8px;
      cursor: pointer;
      max-width: calc(50% - 48px);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .tomode:hover {
      color: var(--ink-1);
      background: var(--chrome-hover);
    }
    /* Pausing preserves the call and only fences media. It mirrors the typing
       affordance on the opposite edge so it does not turn the takeover back
       into a status/control panel. */
    .voicepause {
      position: absolute;
      left: var(--s-5);
      top: 50%;
      transform: translateY(-50%);
      border: 0;
      background: transparent;
      color: var(--ink-3);
      font: inherit;
      font-size: var(--t-meta);
      line-height: 1;
      padding: var(--s-2) var(--s-3);
      border-radius: 8px;
      cursor: pointer;
      max-width: calc(50% - 48px);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .voicepause:hover {
      color: var(--ink-1);
      background: var(--chrome-hover);
    }
    /* MICROPHONE OPEN, said in words. The orb beside it animates, but an
       animation is not a statement -- a text box on screen with a live
       microphone behind it has to SAY so. Takes the crow's spare width, so
       it adds no row and no height. */
    .micon {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      margin-right: auto;
      flex: 0 1 auto;
      min-width: 0;
      color: var(--chrome-accent);
      font-size: var(--t-meta);
      white-space: nowrap;
    }
    .micword {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .micdot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--chrome-accent);
      flex: none;
      animation: micbreath 2s ease-in-out infinite;
    }
    @keyframes micbreath {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.35;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .micdot {
        animation: none;
      }
    }
    .micback {
      border: 0;
      background: transparent;
      color: var(--ink-3);
      font: inherit;
      font-size: var(--t-meta);
      line-height: 1;
      padding: var(--s-2) var(--s-3);
      border-radius: 8px;
      cursor: pointer;
      flex: 0 4 auto;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .micback:hover {
      color: var(--ink-1);
      background: var(--chrome-hover);
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

    /* ---- attachments ------------------------------------------------------
       The staged strip sits ABOVE the textarea, inside the same box, so the
       files and the words that will be sent with them read as one message
       rather than as a tray parked next to one. */
    .cbox.dropping {
      border-color: var(--chrome-accent);
      border-style: dashed;
    }
    .dropnote {
      font-size: var(--t-meta);
      color: var(--chrome-accent);
      padding-bottom: var(--s-2);
    }
    .achips,
    .tattach {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: var(--s-2);
    }
    .tattach {
      margin-top: var(--s-3);
    }
    .achip,
    .tchip {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      max-width: 100%;
      min-width: 0;
      padding: 2px var(--s-2) 2px 2px;
      border: 1px solid var(--edge);
      border-radius: 10px;
      background: color-mix(in srgb, var(--surface) 70%, transparent);
      font-size: var(--t-meta);
      color: var(--ink-2);
    }
    .achip.failed {
      border-color: color-mix(in srgb, var(--danger, #e5484d) 60%, transparent);
      color: var(--ink-2);
    }
    .achip.uploading {
      opacity: 0.85;
    }
    .athumb {
      width: 26px;
      height: 26px;
      border-radius: 7px;
      object-fit: cover;
      flex: none;
      display: block;
    }
    .aicon {
      width: 26px;
      height: 26px;
      display: grid;
      place-items: center;
      flex: none;
      color: var(--ink-3);
    }
    .aname {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 18ch;
      min-width: 0;
    }
    .ameta {
      color: var(--ink-3);
      flex: none;
      white-space: nowrap;
      max-width: 28ch;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .adrop {
      width: 22px;
      height: 22px;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--ink-3);
      cursor: pointer;
      display: grid;
      place-items: center;
      padding: 0;
      flex: none;
    }
    .adrop:hover,
    .adrop:focus-visible {
      color: var(--ink-1);
      background: color-mix(in srgb, var(--ink-1) 10%, transparent);
    }
    /* The file input is a mechanism, not a control: the paperclip button is
       what a person sees and what a screen reader announces. Hidden without
       display:none, which would make .click() a no-op in some browsers. */
    .afile {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }
    .asr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    /* Touch targets. A 22px close affordance is fine under a mouse and is
       below the comfortable minimum under a thumb, which is the input method
       the portrait layout exists for. */
    @media (pointer: coarse) {
      .adrop {
        width: 30px;
        height: 30px;
      }
      .aname {
        max-width: 12ch;
      }
    }
    .ctext:disabled {
      cursor: not-allowed;
      opacity: 0.62;
    }
    .crow {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      justify-content: flex-end;
      position: relative;
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
    .cbtn.send:hover:not([disabled]) {
      background: var(--chrome-text-bright);
    }
    .cbtn.send[disabled] {
      background: transparent;
      color: var(--ink-3);
      cursor: default;
    }
    .primary-menu {
      position: absolute;
      right: 0;
      bottom: calc(100% + var(--s-2));
      z-index: 2;
      min-width: 190px;
      padding: var(--s-1);
      border: 1px solid var(--edge);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 8px 22px rgb(0 0 0 / 20%);
    }
    .primary-menu button {
      width: 100%;
      min-height: 44px;
      border: 0;
      border-radius: 6px;
      padding: var(--s-2) var(--s-3);
      background: transparent;
      color: var(--ink-1);
      font: inherit;
      font-size: var(--t-meta);
      text-align: left;
      cursor: pointer;
    }
    .primary-menu button:hover,
    .primary-menu button:focus-visible {
      outline: none;
      background: var(--chrome-hover);
    }
    .primary-help {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
    }
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
    .cbtn.voice[disabled] {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .cbtn.voice.live mux-voice-orb {
      --orb-d: 24px;
    }
    .cbtn.voice .voice-status-sr {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .cbtn.voice.solo {
      width: 64px;
      height: 64px;
    }
    .cbtn.voice.solo mux-voice-orb {
      --orb-box: 64px;
      --orb-d: 52px;
    }
    /* Listening. A filled red STOP, no ring, no pulse -- the square is the
       international \"press this to make it stop\" and needs no help. */
    .cbtn.rec,
    .cbtn.rec:hover {
      background: var(--fail);
      color: var(--chrome-body);
    }
    @media (pointer: coarse), (any-pointer: coarse) {
      .cbtn {
        width: 44px;
        height: 44px;
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
      /* The home indicator, once, for every applet -- on the SHEET rather than
         inside each applet's scroller, so content scrolls up to the bar and
         stops there instead of under it, and no applet has to know the inset
         exists. Zero on a browser without one, which is the default's job. */
      padding: 0 0 env(safe-area-inset-bottom, 0px);
      /* NO display in this rule -- it belongs in :popover-open below.
         A closed popover is display: none by UA rule; an unconditional
         author display here OVERRIDES that, so the sheet is never actually
         hidden, only pushed off-screen by translate. A box-shadow paints
         OUTSIDE its element's box, so a 34px blur at -12px on a box whose top
         edge sits at the viewport bottom spills 46px UP -- a dark band along
         the bottom of a screen with no sheet on it. */
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
      display: flex;
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
    /* THE HOST FILLS WHAT THE HANDLE LEAVES. There is no scroller here: the
       applet inside owns its own, the same one it owns on the desktop, and a
       scroller inside a scroller is how a bottom sheet stops responding to the
       drag that opened it. */
    .sheet mux-applets {
      flex: 1;
      /* Load-bearing: without it a flex item refuses to shrink below its
         content and the bounded height this sheet exists to provide
         silently does not happen. */
      min-height: 0;
    }
    /* Portrait is CARDS ONLY -- a tile is a terminal thumbnail and needs
       width to say anything. The rule that enforces it USED to live here, as
       .pslist .thumb; a thumbnail is now inside the applet's shadow root
       where this selector cannot reach it, so the applet keys off the narrow
       the host already hands it. See applet-dashboard's :host([narrow]) .thumb. */
  `;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('mousedown', this._onOutsideClick);
    this._unsub = cosStore.subscribe(() => {
      this._syncTicker();
      this._version++;
    });
    // Session state is the Dashboard APPLET's subscription now. It is held
    // while that applet is CONNECTED rather than while it is on screen, so an
    // unseen tab can still notice a lane going blocked; the argument for that
    // exception, and the adopt-current-state-on-reattach reasoning, moved with
    // it to applet-dashboard's _onFleet() and _sync().
    this._unsubVoice = voiceInputController.onStateChange((s) => {
      this._voice = s;
      if (s !== 'listening') {
        this._chatDictationActive = false;
        this._chatDictationCapture = null;
      }
    });
    this._unsubTranscript = voiceInputController.onTranscript((p) => {
      this._takeTranscript(p);
    });
    this._heldVoiceComposer = heldVoiceComposer;
    this._unsubVoiceSession = voiceSessionController.subscribe((snapshot) => {
      const wasActive = isSessionLive(this._voiceSession);
      this._voiceSession = snapshot;
      const nowActive = isSessionLive(snapshot);
      if (!wasActive && nowActive && !this._heldVoiceComposer) {
        this._holdVoiceComposer();
        this._textMode = false;
        this._hideSheet();
      } else if (wasActive && !nowActive) {
        this._releaseVoiceComposer();
      }
    });
    this._voiceSession = voiceSessionController.snapshot();
    if (!isSessionLive(this._voiceSession) && this._heldVoiceComposer) {
      this._releaseVoiceComposer();
    }
    document.addEventListener('keydown', this._onDocKey);
    this._syncTicker();
    this.style.setProperty('--chat-w', `${this._split}%`);
  }

  override disconnectedCallback(): void {
    document.removeEventListener('mousedown', this._onOutsideClick);
    document.removeEventListener('keydown', this._onDocKey);
    this._unsub?.();
    this._unsub = null;
    this._unsubVoice?.();
    this._unsubVoice = null;
    this._unsubTranscript?.();
    this._unsubTranscript = null;
    this._unsubVoiceSession?.();
    this._unsubVoiceSession = null;
    if (this._ticker !== undefined) clearInterval(this._ticker);
    this._ticker = undefined;
    if (this._primaryHoldTimer !== undefined) clearTimeout(this._primaryHoldTimer);
    this._primaryHoldTimer = undefined;
    // Only OUR session. An unconditional abort here would kill a dictation
    // the title bar's mic started against a terminal pane.
    if (this._chatDictationActive && this._voice === 'listening') {
      voiceInputController.invalidateComposerChannel(this._chatDictationCapture?.channelId ?? '');
    }
    this._chatDictationActive = false;
    this._chatDictationCapture = null;
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

  private _syncTicker(): void {
    if (cosStore.approvals.length > 0) {
      if (this._ticker === undefined) {
        this._ticker = setInterval(() => {
          if (cosStore.approvals.length > 0) this._version++;
          else {
            clearInterval(this._ticker);
            this._ticker = undefined;
          }
        }, 1000);
      }
      return;
    }
    if (this._ticker !== undefined) {
      clearInterval(this._ticker);
      this._ticker = undefined;
    }
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

  get activeApplet(): AppletId | '' {
    return this._activeApplet;
  }

  override updated(): void {
    // Follow the stream only while the reader is at the bottom. Yanking the
    // scroller down under someone who deliberately scrolled up to re-read a
    // tool line is the fastest way to make a streaming surface unusable.
    this._syncComposerHeight();
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
      ${this.narrow
        ? this._renderSheet()
        : html`<div class="dash" @applet-changed="${this._onAppletChanged}"><mux-applets></mux-applets></div>`}
    `;
  }

  private _renderTopbar(): TemplateResult {
    return html`
      <div class="topbar">
        <h1
          title="Mission Control — you're talking with ${ASSISTANT_NAME}. Nickname: ${ASSISTANT_ALIAS}."
        >Mission Control</h1>
        <span class="spacer"></span>
        <div class="topbar-actions">
          <button
            class="dots ${this._menuOpen ? 'on' : ''}"
            type="button"
            aria-label="Conversation options"
            aria-expanded="${this._menuOpen ? 'true' : 'false'}"
            @click="${this._toggleMenu}"
          >${icon(Ellipsis, { size: 16 })}</button>
        </div>
        ${this._menuOpen ? this._renderMenu() : nothing}
      </div>
    `;
  }

  /**
   * The only thread switcher. It lives beside the shared surface title and
   * asks for a second, explicit Talk here action before it transmits a select
   * request; terminal/workspace navigation never reaches this path.
   */
  private _renderMenu(): TemplateResult {
    const any = cosStore.hasMessages;
    return html`
      <div class="menu" role="menu">
        <button type="button" role="menuitem" ?disabled="${!any}" @click="${() => this._ask(7)}">Clear messages older than 7 days</button>
        <button type="button" role="menuitem" ?disabled="${!any}" @click="${() => this._ask(30)}">Clear messages older than 30 days</button>
        <div class="msep"></div>
        <button type="button" role="menuitem" class="danger" ?disabled="${!any}" @click="${() => this._ask('all')}">Clear all messages</button>
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
        <p class="sub">Describe a problem and ${ASSISTANT_NAME} will help.</p>
      </div>
    `;
  }

  private _renderTurn(t: CosTurn): TemplateResult {
    const asks = cosStore.approvals.filter((a) => a.turnId === t.id);
    const live = t.status === 'pending' || t.status === 'streaming';
    return html`
      ${t.prompt || t.attachments.length > 0
        ? html`<div class="turn you">
            <div class="who">YOU</div>
            <div class="bd">
              ${t.prompt ? html`<p class="say">${t.prompt}</p>` : nothing}
              ${t.attachments.length > 0 ? this._renderTurnAttachments(t.attachments) : nothing}
            </div>
          </div>`
        : nothing}
      <div class="turn cos">
        <div class="who">OPERATOR</div>
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

  /**
   * The files a message carried, under the words that came with it.
   *
   * A thumbnail appears only for an image THIS tab uploaded and still holds a
   * local object URL for. A replayed turn shows the same chip without one,
   * which is the truth: those bytes are on the server's disk, deliberately not
   * fetchable, and inventing a placeholder image would imply otherwise.
   */
  private _renderTurnAttachments(refs: readonly CosAttachmentRef[]): TemplateResult {
    return html`
      <ul class="tattach" aria-label="Attachments">
        ${refs.map(
          (ref) => html`
            <li class="tchip">
              ${ref.previewUrl && isImageMedia(ref.mediaType)
                ? html`<img class="athumb" src="${ref.previewUrl}" alt="" />`
                : html`<span class="aicon" aria-hidden="true">${icon(FileText, { size: 13 })}</span>`}
              <span class="aname" title="${ref.path || ref.name}">${ref.name}</span>
              <span class="ameta">${ref.size}</span>
            </li>
          `,
        )}
      </ul>
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
    return html`
      <div class="${cls}" title="${b.summary || b.name}">
        <span class="ok">${b.done ? (b.ok ? '\u2713' : '\u2717') : '\u00b7'}</span>
        <span class="tname">${shortToolName(b.name) || 'tool'}</span>
        <span class="targs">${b.summary && b.done ? b.summary : b.args}</span>
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
    const pending = a.answered !== '';
    const enabled = cosStore.canAnswer(a.turnId, a.requestId);
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
                  data-thread-approval="approve:${a.turnId}:${a.requestId}"
                  ?disabled="${pending || !enabled}"
                  @click="${() => cosStore.answer(a.requestId, true)}"
                >${pending ? 'sending…' : 'approve'}</button>
                <button
                  class="btn no"
                  type="button"
                  data-thread-approval="deny:${a.turnId}:${a.requestId}"
                  ?disabled="${pending || !enabled}"
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
    if (bits.length === 0) return nothing;
    return html`
      <div class="foot">
        <span>${bits.join(' \u00b7 ')}</span>
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
      ? `${ASSISTANT_NAME} forgets this conversation entirely. Running lanes are unaffected \u2014 no session is stopped, closed or altered \u2014 and it will not drop a message about a lane that is still alive.`
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

  private _renderVoiceControl(solo = false): TemplateResult {
    const snapshot = this._voiceSession;
    const active = isSessionLive(snapshot);
    const blocked = snapshot.blockedReason !== null;
    const orbState = snapshot.state === 'idle' || snapshot.state === 'blocked' ? 'asleep' : snapshot.state;
    const label = voiceControlLabel(snapshot);
    return html`
      <button
        class="cbtn voice ${active ? 'live' : ''} ${solo ? 'solo' : ''}"
        type="button"
        title="${label}"
        aria-label="${label}"
        aria-pressed="${active ? 'true' : 'false'}"
        data-voice-state="${snapshot.state}"
        ?disabled="${blocked}"
        @click="${this._toggleSession}"
      >
        <mux-voice-orb .state="${orbState}" .level="${snapshot.level}"></mux-voice-orb>
      </button>
    `;
  }

  private _renderVoiceComposer(): TemplateResult {
    return html`
      <div class="comp">
        <div class="cbox solo">
          ${this._renderVoiceControl(true)}
          <button
            class="tomode"
            type="button"
            title="Type instead, without ending the conversation"
            aria-label="Type instead, without ending the spoken conversation"
            @click="${this._toText}"
          >type instead</button>
        </div>
      </div>
    `;
  }

  /**
   * Voice borrows the empty Send slot. A draft keeps Send available, dictation
   * stays distinct, and the same typed composer can be restored temporarily
   * without ending an active spoken conversation.
   */
  private _renderComposer(): TemplateResult {
    const voiceActive = isSessionLive(this._voiceSession);
    const call = voiceActive;
    if (call && !this._textMode) return this._renderVoiceComposer();
    const negotiating = cosStore.negotiating;
    const activeTurn = cosStore.activeTurn;
    const busy = cosStore.busy;
    const admissionPending = cosStore.admissionPending;
    const draftPresent = this._draft.trim().length > 0;
    const draftAdmissionPending = cosStore.draftAdmissionPending;
    // Each send owns an independent receipt. Do not make a person wait for one
    // round trip before queuing an edited next message, but never admit the
    // exact same unchanged draft twice before its receipt.
    const policy = cosStore.attachmentPolicy;
    const staged = cosStore.attachments;
    const stagedReady = cosStore.attachmentsReady.length > 0;
    const stagedBusy = cosStore.attachmentsBusy;
    const stagedFailed = cosStore.attachmentsFailed;
    // An attachment is a message on its own, so it makes Send available the
    // same way typed text does -- which also means the empty Send slot the
    // voice orb borrows is only empty when there is genuinely nothing to send.
    const anythingToSend = draftPresent || stagedReady;
    const ready = anythingToSend && !stagedBusy && !stagedFailed &&
      cosStore.textSubmissionAvailable && !draftAdmissionPending;
    const locked = !cosStore.textSubmissionAvailable;
    const listening = !voiceActive && !negotiating && this._voice === 'listening';
    const primaryLabel = anythingToSend
      ? stagedBusy
        ? 'Waiting for attachments to finish uploading'
        : stagedFailed
          ? 'Remove the attachment that could not be added, then send'
          : draftAdmissionPending ? 'Sending message' : activeTurn ? 'Queue message after active turn' : 'Send'
      : activeTurn ? 'Stop active turn' : admissionPending ? 'Sending' : 'Send';
    return html`
      <div class="comp">
        <div
          class="cbox ${listening || voiceActive ? 'live' : ''} ${this._dropActive ? 'dropping' : ''}"
          @dragenter="${this._onDragEnter}"
          @dragover="${this._onDragOver}"
          @dragleave="${this._onDragLeave}"
          @drop="${this._onDrop}"
        >
          ${staged.length > 0 ? this._renderStagedAttachments(staged) : nothing}
          ${this._dropActive
            ? html`<div class="dropnote" aria-hidden="true">Drop to attach</div>`
            : nothing}
          <textarea
            class="ctext"
            data-thread-composer
            rows="1"
            autocomplete="off"
            spellcheck="false"
            placeholder="Message Mission Control…"
            aria-label="Message Mission Control"
            ?disabled="${locked}"
            .value="${this._draft}"
            @input="${this._onDraft}"
            @keydown="${this._onKey}"
            @paste="${this._onPaste}"
          ></textarea>
          <div class="crow">
            ${voiceActive
              ? html`
                  <span class="micon">
                    <span class="micdot"></span><span class="micword">microphone open</span>
                  </span>
                  <button
                    class="micback"
                    type="button"
                    title="Back to the orb, without ending the conversation"
                    aria-label="Back to the orb, without ending the spoken conversation"
                    @click="${this._toVoice}"
                  >back to the orb</button>
                `
              : nothing}
            ${policy.enabled && !voiceActive
              ? html`<button
                    class="cbtn attach"
                    type="button"
                    title="Attach a file"
                    aria-label="Attach a file"
                    ?disabled="${locked || cosStore.attachmentSlotsLeft === 0}"
                    @click="${this._openFilePicker}"
                  >${icon(Paperclip, { size: 15 })}</button>
                  <input
                    class="afile"
                    type="file"
                    multiple
                    tabindex="-1"
                    aria-hidden="true"
                    accept="${policy.accept.join(',')}"
                    @change="${this._onFilesChosen}"
                  />`
              : nothing}
            ${!voiceActive && !negotiating && cosStore.composerIdentity.channelId !== 'none' && voiceInputController.isSupported()
              ? html`<button
                  class="cbtn ${listening ? 'rec' : ''}"
                  type="button"
                  title="${listening ? 'Stop dictating' : 'Dictate'}"
                  aria-label="${listening ? 'Stop dictating' : 'Dictate'}"
                  aria-pressed="${listening ? 'true' : 'false'}"
                  @click="${this._toggleDictation}"
                >${listening ? icon(Square, { size: 13 }) : icon(Mic, { size: 16 })}</button>`
              : nothing}
            ${!voiceActive ? this._renderVoiceControl() : nothing}
            <!--
              The empty Send slot belongs to the voice orb, and it is empty
              only when there is genuinely nothing to send. A message that is
              ready in the person's eyes but BLOCKED -- an upload still in
              flight, or a row that failed -- keeps a visible, disabled Send
              whose label says why, rather than making the control vanish and
              leaving them to guess.
            -->
            ${busy || voiceActive || ready || admissionPending || !voiceSessionController.isSupported() ||
            (anythingToSend && (stagedBusy || stagedFailed))
              ? html`<button
                  class="cbtn send primary-control"
                  type="button"
                  aria-label="${primaryLabel}"
                  aria-haspopup="${activeTurn && draftPresent ? 'menu' : 'false'}"
                  aria-expanded="${this._primaryMenuOpen ? 'true' : 'false'}"
                  aria-describedby="${activeTurn && draftPresent ? 'composer-primary-help' : nothing}"
                  ?disabled="${!ready && !activeTurn}"
                  @pointerdown="${this._onPrimaryPointerDown}"
                  @pointerup="${this._onPrimaryPointerUp}"
                  @pointercancel="${this._onPrimaryPointerCancel}"
                  @keydown="${this._onPrimaryControlKey}"
                  @click="${this._onPrimaryClick}"
                >${icon(!draftPresent && activeTurn ? Square : ArrowUp, { size: 15 })}</button>
                ${activeTurn && draftPresent
                  ? html`<span id="composer-primary-help" class="primary-help">Press Down Arrow or hold to open actions including Stop active turn.</span>`
                  : nothing}
                ${this._primaryMenuOpen && activeTurn
                  ? html`<div class="primary-menu" role="menu" aria-label="Composer actions">
                      <button
                        role="menuitem"
                        type="button"
                        @keydown="${this._onPrimaryMenuKey}"
                        @click="${this._stopGeneration}"
                      >Stop active turn</button>
                    </div>`
                  : nothing}`
              : nothing}
          </div>
        </div>
      </div>
    `;
  }

  // -------------------------------------------------------------------------
  // The applet sheet (portrait)
  // -------------------------------------------------------------------------

  /**
   * THE APPLET HOST, in the container a phone has room for.
   *
   * Not a second copy of one applet -- the host itself, the same element the
   * desktop region holds, with the same tab strip over the same registry. It
   * used to be `<applet-dashboard insheet>`, written here by tag, which is why
   * three of the four applets could not be reached on a phone at all. Nothing
   * in this file names an applet now, so the fifth one appears here the day it
   * registers itself and this method does not change.
   *
   * `dormant` is the old `_sheetOpen` rule, generalised: it said "a closed
   * sheet must not leave a subscription running" about the one applet that was
   * in here, and it has to mean the same thing about four. The host spends it
   * on all of them at once.
   *
   * The sheet no longer scrolls; each applet owns its own scroller, exactly as
   * it does on the desktop, so there is one geometry for both containers and
   * no `insheet` special case to keep in step.
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
        aria-label="Applets"
        @toggle="${this._onSheetToggle}"
        @home-open="${this._hideSheet}"
        @applet-changed="${this._onAppletChanged}"
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
            aria-label="Close the applets"
            @click="${this._hideSheet}"
          >${icon(X, { size: 14 })}</button>
        </div>
        <mux-applets narrow .dormant="${!this._sheetOpen}"></mux-applets>
      </div>
    `;
  }

  /**
   * The applet showing in the sheet changed. The ONE thing the sheet does
   * about it: an applet that says it is for reading gets the full detent,
   * because half a phone screen of prose under a tab strip is a preview of
   * reading rather than reading. See AppletManifest.roomy.
   *
   * It does not shrink back for the others. Coming out of the Viewer into
   * Files and having the surface drop to half under the finger that just
   * switched tabs is the yank this file spends so much of itself avoiding, and
   * the drag handle is right there for someone who wants the room back.
   */
  private _onAppletChanged = (e: Event): void => {
    const detail = (e as CustomEvent<AppletChangedDetail>).detail;
    if (detail?.applet) this._activeApplet = detail.applet;
    if (detail?.roomy === true) this._setDetent('full');
  };

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
    if (!this._menuOpen && !this._primaryMenuOpen) return;
    const path = e.composedPath();
    const pressed = (sel: string): boolean => {
      const el = this.renderRoot.querySelector(sel);
      return el !== null && path.includes(el);
    };
    if (
      pressed('.menu') ||
      pressed('.dots') ||
      pressed('.primary-menu') ||
      pressed('.primary-control')
    ) {
      return;
    }
    this._menuOpen = false;
    this._primaryMenuOpen = false;
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
    if (el.value.trim() === '') {
      el.style.height = '';
      el.style.overflowY = '';
      this._sizedDraft = el.value;
      return;
    }
    el.style.height = 'auto';
    const max = Number.parseFloat(getComputedStyle(el).maxHeight);
    const height = Number.isFinite(max) ? Math.min(el.scrollHeight, max) : el.scrollHeight;
    el.style.height = `${height}px`;
    el.style.overflowY = el.scrollHeight > height ? 'auto' : 'hidden';
    this._sizedDraft = el.value;
  }

  private _resetComposerHeight(): void {
    const el = this.renderRoot.querySelector<HTMLTextAreaElement>('.ctext');
    if (!el) return;
    el.style.height = '';
    el.style.overflowY = '';
    this._sizedDraft = el.value;
  }

  private _syncComposerHeight(): void {
    const el = this.renderRoot.querySelector<HTMLTextAreaElement>('.ctext');
    if (!el || this._sizedDraft === el.value) return;
    this._fit(el);
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
      if (
        this._menuOpen ||
        this._primaryMenuOpen ||
        this._confirm !== null
      ) {
        e.preventDefault();
        this._menuOpen = false;
        this._primaryMenuOpen = false;
        this._confirm = null;
        return;
      }
      // In live text mode, hiding Mission Control would leave the microphone
      // and the only visible voice controls behind. Exit through the normal
      // controller instead; its release path preserves this draft and caret.
      if (this._textMode && isSessionLive(this._voiceSession)) {
        e.preventDefault();
        voiceSessionController.stop();
        return;
      }
      this.dispatchEvent(new CustomEvent('home-dismiss', { bubbles: true, composed: true }));
    }
  };

  private _submit = (): void => {
    const prompt = this._draft.trim();
    // An attachment is enough on its own; words are not required beside it.
    if (!prompt && cosStore.attachmentsReady.length === 0) return;
    if (cosStore.attachmentsBusy) {
      this._attachNotice = 'Waiting for attachments to finish uploading.';
      return;
    }
    if (cosStore.attachmentsFailed) {
      this._attachNotice = 'Remove the attachment that could not be added, then send.';
      return;
    }
    // The store retains this draft until the server sends a real turn receipt.
    // A missing receipt is uncertainty, not proof that the user's words were sent.
    if (!cosStore.send(prompt)) return;
    this._pinned = true;
    // The store retains the text until its server receipt, but the input must
    // immediately return to its compact editing geometry. The receipt/replay
    // path later clears the value authoritatively.
    this._resetComposerHeight();
  };

  // -------------------------------------------------------------------------
  // Attachments
  //
  // Three ways in, one path through. A picked file, a dropped file, and a
  // pasted image all end at cosStore.addAttachmentFiles, which is where every
  // policy decision and every visible refusal lives. Nothing here reads a
  // file's bytes: the browser hands a File to an upload, and the id that comes
  // back is all this component ever holds.
  // -------------------------------------------------------------------------

  private _renderStagedAttachments(rows: readonly CosDraftAttachment[]): TemplateResult {
    return html`
      <ul class="achips" aria-label="Attachments on this message">
        ${rows.map(
          (row) => html`
            <li class="achip ${row.status}">
              ${row.previewUrl && row.status !== 'failed'
                ? html`<img class="athumb" src="${row.previewUrl}" alt="" />`
                : html`<span class="aicon" aria-hidden="true">${icon(
                    row.status === 'failed' ? TriangleAlert : FileText,
                    { size: 13 },
                  )}</span>`}
              <span class="aname" title="${row.name}">${row.name}</span>
              <span class="ameta">
                ${row.status === 'uploading'
                  ? `${Math.round(row.progress * 100)}%`
                  : row.status === 'failed'
                    ? row.message
                    : humanBytes(row.size)}
              </span>
              <button
                class="adrop"
                type="button"
                aria-label="Remove ${row.name}"
                @click="${() => this._removeAttachment(row.localId)}"
              >${icon(X, { size: 12 })}</button>
            </li>
          `,
        )}
      </ul>
      <!--
        One polite live region for the whole strip. Per-chip announcements
        would talk over a person dropping four files at once, which is the
        case this exists to serve.
      -->
      <div class="asr" role="status" aria-live="polite">${this._attachSummary(rows)}</div>
    `;
  }

  private _attachSummary(rows: readonly CosDraftAttachment[]): string {
    if (this._attachNotice) return this._attachNotice;
    const failed = rows.filter((r) => r.status === 'failed');
    if (failed.length > 0) {
      return failed.length === 1
        ? `An attachment could not be added: ${failed[0].message}`
        : `${failed.length} attachments could not be added. First: ${failed[0].message}`;
    }
    const busy = rows.filter((r) => r.status === 'uploading').length;
    if (busy > 0) return `Uploading ${busy} attachment${busy === 1 ? '' : 's'}.`;
    if (rows.length > 0) return `${rows.length} attachment${rows.length === 1 ? '' : 's'} ready to send.`;
    return '';
  }

  private _removeAttachment(localId: string): void {
    const row = cosStore.attachments.find((a) => a.localId === localId);
    cosStore.removeAttachment(localId);
    this._attachNotice = row ? `Removed ${row.name}.` : '';
    // Focus must not fall to the document when the chip under it disappears.
    this.updateComplete.then(() => {
      const next = this.renderRoot.querySelector<HTMLElement>('.achip .adrop')
        ?? this.renderRoot.querySelector<HTMLElement>('.cbtn.attach')
        ?? this.renderRoot.querySelector<HTMLElement>('.ctext');
      next?.focus();
    }).catch(() => {});
  }

  private _openFilePicker = (): void => {
    this._attachNotice = '';
    this.renderRoot.querySelector<HTMLInputElement>('.afile')?.click();
  };

  private _onFilesChosen = (e: Event): void => {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    // Reset first: picking the same file twice in a row must re-fire change.
    input.value = '';
    this._accept(files);
  };

  /**
   * Paste. `clipboardData.files` is what carries a screenshot from the system
   * clipboard, and it is EMPTY for an ordinary text paste -- so this never
   * interferes with pasting words into the draft, and only calls
   * preventDefault when it is actually taking a file.
   */
  private _onPaste = (e: ClipboardEvent): void => {
    if (!cosStore.attachmentPolicy.enabled) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    this._accept(files);
  };

  private _onDragEnter = (e: DragEvent): void => {
    if (!this._draggingFiles(e)) return;
    e.preventDefault();
    this._dragDepth++;
    this._dropActive = true;
  };

  private _onDragOver = (e: DragEvent): void => {
    if (!this._draggingFiles(e)) return;
    // Without this the browser navigates away to the dropped file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  private _onDragLeave = (e: DragEvent): void => {
    if (!this._draggingFiles(e)) return;
    this._dragDepth = Math.max(0, this._dragDepth - 1);
    if (this._dragDepth === 0) this._dropActive = false;
  };

  private _onDrop = (e: DragEvent): void => {
    if (!this._draggingFiles(e)) return;
    e.preventDefault();
    this._dragDepth = 0;
    this._dropActive = false;
    this._accept(Array.from(e.dataTransfer?.files ?? []));
  };

  /**
   * Only a drag that actually carries files is ours. Dragging selected text,
   * a link, or one of muxterm's own draggable pane handles across the composer
   * must not light up a drop zone that would refuse it.
   */
  private _draggingFiles(e: DragEvent): boolean {
    if (!cosStore.attachmentPolicy.enabled) return false;
    const types = e.dataTransfer?.types;
    return !!types && Array.from(types).includes('Files');
  }

  private _accept(files: readonly File[]): void {
    if (files.length === 0) return;
    this._attachNotice = '';
    cosStore.addAttachmentFiles(files);
  }

  private _stopGeneration = (): void => {
    this._primaryMenuOpen = false;
    const active = cosStore.activeTurn;
    if (active) cosStore.cancel(active.id);
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLTextAreaElement>('.ctext')?.focus();
    });
  };

  private _onPrimaryPointerDown = (): void => {
    if (!cosStore.activeTurn || this._draft.trim() === '') return;
    if (this._primaryHoldTimer !== undefined) clearTimeout(this._primaryHoldTimer);
    this._primaryHoldTimer = setTimeout(() => {
      this._primaryHoldTimer = undefined;
      this._suppressPrimaryClick = true;
      this._primaryMenuOpen = true;
    }, 550);
  };

  private _onPrimaryPointerUp = (): void => {
    if (this._primaryHoldTimer !== undefined) {
      clearTimeout(this._primaryHoldTimer);
      this._primaryHoldTimer = undefined;
    }
  };

  private _onPrimaryPointerCancel = (): void => {
    this._onPrimaryPointerUp();
    // A long press opens the compact Stop menu and suppresses its trailing
    // click. Pointer cancellation has no trailing click, so retaining that
    // bit would wrongly swallow the next deliberate Send/Stop action.
    this._suppressPrimaryClick = false;
  };

  private _onPrimaryControlKey = (e: KeyboardEvent): void => {
    if (!cosStore.activeTurn || this._draft.trim() === '') return;
    if (e.key === 'ArrowDown' || (e.altKey && e.key === 'ArrowDown')) {
      e.preventDefault();
      this._primaryMenuOpen = true;
      void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>('.primary-menu button')?.focus());
    }
  };

  private _onPrimaryMenuKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    this._primaryMenuOpen = false;
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLButtonElement>('.primary-control')?.focus();
    });
  };

  private _onPrimaryClick = (): void => {
    if (this._suppressPrimaryClick) {
      this._suppressPrimaryClick = false;
      return;
    }
    // A direct primary activation after its menu was opened is Send/Stop, not
    // a request to leave a stale duplicate menu over the composer.
    this._primaryMenuOpen = false;
    // An attachment is a message, so the primary control has to agree with
    // the render path about what "there is something to send" means. Reading
    // only the draft here made the Send arrow do NOTHING for an
    // attachment-only message -- and, with a turn running, made the control
    // labelled "Queue message after active turn" cancel that turn instead.
    if (this._draft.trim() !== '' || cosStore.attachmentsReady.length > 0) {
      this._submit();
      return;
    }
    this._stopGeneration();
  };

  private _toggleSession = (): void => {
    if (isSessionLive(this._voiceSession)) {
      voiceSessionController.stop();
      return;
    }
    void voiceSessionController.start();
  };

  private _holdVoiceComposer(replace = false): void {
    if (heldVoiceComposer && !replace) {
      this._heldVoiceComposer = heldVoiceComposer;
      return;
    }
    const el = this.renderRoot.querySelector<HTMLTextAreaElement>('.ctext');
    const held: HeldVoiceComposer = {
      identity: cosStore.composerIdentity,
      draft: cosStore.draft,
      start: el?.selectionStart ?? 0,
      end: el?.selectionEnd ?? 0,
      focused: this.shadowRoot?.activeElement === el,
    };
    heldVoiceComposer = held;
    this._heldVoiceComposer = held;
  }

  private _releaseVoiceComposer(): void {
    const held = this._heldVoiceComposer ?? heldVoiceComposer;
    this._heldVoiceComposer = null;
    if (!held) return;
    if (heldVoiceComposer === held) heldVoiceComposer = null;
    if (!sameComposerIdentity(held.identity, cosStore.composerIdentity)) return;
    const wasSolo = !this._textMode;
    this._textMode = false;
    // Takeover never changes the store draft. Keep any explicit draft edit
    // requested during voice instead of overwriting it with an older snapshot.
    const draftUnchanged = cosStore.draft === held.draft;
    const wasOnOrb = this.shadowRoot?.activeElement?.classList.contains('voice') === true;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector<HTMLTextAreaElement>('.ctext');
      if (!el) return;
      this._fit(el);
      if (wasSolo && draftUnchanged) {
        el.setSelectionRange(
          Math.min(held.start, el.value.length),
          Math.min(held.end, el.value.length),
        );
      }
      if (wasSolo && (held.focused || wasOnOrb)) el.focus();
    });
  }

  /** Bring back the keyboard without dropping the active spoken conversation. */
  private _toText = (): void => {
    const held = this._heldVoiceComposer ?? heldVoiceComposer;
    this._textMode = true;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector<HTMLTextAreaElement>('.ctext');
      if (!el) return;
      this._fit(el);
      el.setSelectionRange(
        Math.min(held?.start ?? 0, el.value.length),
        Math.min(held?.end ?? 0, el.value.length),
      );
      el.focus();
    });
  };

  /** Return to the orb while retaining the active spoken conversation. */
  private _toVoice = (): void => {
    this._holdVoiceComposer(true);
    this._textMode = false;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLButtonElement>('.cbtn.voice.solo')?.focus();
    });
  };

  /** Escape ends only a solo voice takeover, never an escape sent to a pane. */
  private _onDocKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !isSessionLive(this._voiceSession) || this._textMode) return;
    const from = e.composedPath()[0];
    const mine = e.composedPath().includes(this);
    const nowhere =
      from === document.body || from === document.documentElement || from === document;
    if (!mine && !nowhere) return;
    if (this._menuOpen || this._primaryMenuOpen || this._confirm !== null) {
      e.preventDefault();
      this._menuOpen = false;
      this._primaryMenuOpen = false;
      this._confirm = null;
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    voiceSessionController.stop();
  };

  private _toggleDictation = (): void => {
    if (cosStore.negotiating) return;
    if (this._voice === 'listening') {
      if (this._chatDictationActive) voiceInputController.stop();
      return;
    }
    const composer = cosStore.composerIdentity;
    if (composer.channelId === 'none') return;
    const capture = voiceInputController.startComposer(composer.channelId);
    if (!capture) return;
    this._chatDictationActive = true;
    this._chatDictationCapture = capture;
  };

  /**
   * A finished transcript.
   *
   * It fills the COMPOSER; it does not send. Dictation is unreliable enough
   * that firing a turn off the back of it would make the surface feel like it
   * acts on things you did not say -- and the box is right there to fix a
   * word in before pressing send.
   */
  private _takeTranscript(payload: VoiceTranscriptPayload): void {
    if (payload.target !== 'composer' || payload.kind !== 'final') return;
    const capture = this._chatDictationCapture;
    const composer = cosStore.composerIdentity;
    if (
      !capture ||
      composer.channelId !== capture.channelId ||
      payload.channelId !== capture.channelId ||
      payload.captureId !== capture.captureId ||
      payload.sttEventGeneration !== capture.sttEventGeneration
    ) {
      return;
    }
    const t = payload.text.trim();
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
