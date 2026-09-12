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
 * PRESENTATIONAL over the conversation coordinator, read-only here: it picks
 * a legacy CosStore or the committed catalog thread. Session state belongs to
 * the Dashboard applet now, which
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
import type { AppletChangedDetail, AppletId } from '../lib/applet-registry.js';
import {
  shortToolName,
  type CosApproval,
  type CosBlock,
  type CosTurn,
} from '../lib/cos-store.js';
import {
  threadStore,
  type ThreadAttention,
  type ThreadContextOption,
  type ThreadControlTarget,
  type ThreadSummary,
} from '../lib/thread-store.js';
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
import type { MuxApplets } from './mux-applets.js';
import './voice-mode-button.js';
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

/** A catalog observation timestamp, never a claim that remote work is fresh. */
function observedAt(iso: string): string {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? new Date(value).toLocaleString() : iso;
}

function compactText(text: string, limit = 280): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** What the housekeeping menu offers. `days` is the cut, or 'all'. */
type Housekeeping = 7 | 30 | 'all';
type ThreadControlConfirmation = Readonly<{
  action: 'reset' | 'archive';
  target: ThreadControlTarget;
}>;

export type AppVoiceSubmitConfirmationOutcome = 'confirmed' | 'declined' | 'unavailable';

interface AppVoiceSubmitConfirmation {
  readonly operationId: string;
  readonly label: string;
  readonly text: string;
  readonly resolve: (outcome: AppVoiceSubmitConfirmationOutcome) => void;
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
   * Draft ownership lives in threadStore so switching A -> B -> A restores
   * the thread's own sentence rather than one component-global value.
   */
  private get _draft(): string {
    return threadStore.draft;
  }

  private set _draft(value: string) {
    threadStore.setDraft(value);
  }

  @state() private _showThinking = new Set<string>();
  @state() private _menuOpen = false;
  @state() private _contextOpen = false;
  @state() private _contextCandidate = '';
  /** Which housekeeping action is awaiting a yes. null = none pending. */
  @state() private _confirm: Housekeeping | null = null;
  /** Scoped reset/archive confirmation with its immutable selected target. */
  @state() private _threadConfirm: ThreadControlConfirmation | null = null;
  /** The exact scoped request in flight; also closes the pre-render double-click gap. */
  @state() private _threadControlPending: ThreadControlConfirmation | null = null;
  @state() private _voice: VoiceState = voiceInputController.getState();
  @state() private _dictationNotice = '';
  @state() private _appVoiceConfirmation: AppVoiceSubmitConfirmation | null = null;

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
  private _unsubTranscript: (() => void) | null = null;
  private _unsubVoiceError: (() => void) | null = null;
  private _unsubSelectionWillChange: (() => void) | null = null;
  private _unsubSelectionSettled: (() => void) | null = null;
  private _ticker: ReturnType<typeof setInterval> | undefined;

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
  private _userSelectionPending = false;
  private _activeApplet: AppletId | '' = '';
  private _voiceAppletOperationId = '';
  private _appletOperationWaiter:
    | {
        readonly operationId: string;
        readonly applet: AppletId;
        readonly resolve: (ok: boolean) => void;
        readonly signal: AbortSignal;
        readonly onAbort: () => void;
      }
    | null = null;

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
    .context {
      position: relative;
      display: flex;
      align-items: center;
      gap: var(--s-3);
      min-width: 0;
      flex: 0 1 auto;
    }
    .context-trigger {
      display: inline-flex;
      align-items: center;
      gap: var(--s-2);
      min-width: 0;
      max-width: min(42vw, 390px);
      font: inherit;
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: 1;
      color: var(--ink-2);
      background: var(--surface);
      border: 1px solid var(--edge);
      border-radius: var(--r-ctl);
      padding: 6px var(--s-3);
      cursor: pointer;
    }
    .context-trigger:hover,
    .context-trigger[aria-expanded='true'] {
      color: var(--ink-1);
      border-color: var(--chrome-accent);
    }
    .context-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .context-badge,
    .context-row-badge {
      flex: none;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--need);
    }
    .context-status {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--mono);
      font-size: var(--t-meta);
      color: var(--ink-3);
    }
    .context-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 31;
      width: min(360px, calc(100vw - var(--s-7) - var(--s-6)));
      padding: var(--s-3);
      background: var(--surface);
      border: 1px solid var(--edge);
      border-radius: var(--r-card);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
    }
    .context-heading,
    .context-empty {
      padding: var(--s-3) var(--s-4);
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: var(--lh-tight);
      color: var(--ink-3);
    }
    .context-list {
      max-height: min(48vh, 320px);
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
    }
    .context-option {
      display: flex;
      width: 100%;
      align-items: flex-start;
      gap: var(--s-3);
      padding: 8px var(--s-4);
      color: var(--ink-2);
      background: transparent;
      border: 0;
      border-radius: var(--r-ctl);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .context-option:hover,
    .context-option[aria-pressed='true'] {
      color: var(--ink-1);
      background: var(--chrome-hover);
    }
    .context-option-main {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .context-option-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--mono);
      font-size: var(--t-ui);
    }
    .context-option-detail {
      font-size: var(--t-meta);
      line-height: var(--lh-tight);
      color: var(--ink-3);
      overflow-wrap: anywhere;
    }
    .context-option-detail.refused {
      color: var(--fail);
    }
    .context-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--s-3);
      margin-top: var(--s-3);
      padding: var(--s-3) var(--s-1) 0;
      border-top: 1px solid var(--edge);
    }
    .context-talk {
      font: inherit;
      font-size: var(--t-ui);
      font-weight: 600;
      line-height: 1;
      padding: 7px 11px;
      border: 1px solid color-mix(in srgb, var(--ok) 55%, transparent);
      border-radius: var(--r-ctl);
      color: var(--ink-1);
      background: color-mix(in srgb, var(--ok) 20%, var(--surface));
      cursor: pointer;
    }
    .context-talk[disabled] {
      opacity: 0.5;
      cursor: default;
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
    .context-trigger:focus-visible,
    .context-option:focus-visible,
    .context-talk:focus-visible,
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
    .thread-unread {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: var(--lh-tight);
      color: var(--ink-3);
      border-left: 2px solid var(--need);
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
    .ctext:disabled {
      cursor: not-allowed;
      opacity: 0.62;
    }
    .crow {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      justify-content: flex-end;
    }
    .threaded-voice,
    .threaded-status {
      min-width: 0;
      margin-right: auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: 1.3;
      color: var(--ink-3);
    }
    .threaded-voice {
      color: var(--need);
    }
    .threaded-release {
      font: inherit;
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: 1;
      color: var(--ink-2);
      background: transparent;
      border: 0;
      padding: var(--s-2) var(--s-3);
      border-radius: var(--r-chip);
      cursor: pointer;
    }
    .threaded-release:hover {
      color: var(--ink-1);
      background: var(--chrome-hover);
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
    this._unsub = threadStore.subscribe(() => {
      this._settleThreadControlPending();
      this._version++;
    });
    this._settleThreadControlPending();
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
    this._unsubVoiceError = voiceInputController.onError((message) => {
      this._dictationNotice = message;
    });
    this._unsubSelectionWillChange = threadStore.onSelectionWillChange((from, to) => {
      const capture = this._chatDictationCapture;
      if (capture && capture.channelId === from && from !== to) {
        voiceInputController.invalidateComposerChannel(from);
      }
    });
    this._unsubSelectionSettled = threadStore.onSelectionSettled(() => {
      if (!this._userSelectionPending) return;
      this._userSelectionPending = false;
      this.dispatchEvent(new CustomEvent('app-voice-observation', { bubbles: true, composed: true }));
    });
    // One second is the whole resolution of an mm:ss countdown, and the
    // ticker only runs while something is counting: an idle Dashboard costs
    // no timer.
    this._ticker = setInterval(() => {
      if (threadStore.approvals.length > 0) this._version++;
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
    this._unsubVoiceError?.();
    this._unsubVoiceError = null;
    this._unsubSelectionWillChange?.();
    this._unsubSelectionWillChange = null;
    this._unsubSelectionSettled?.();
    this._unsubSelectionSettled = null;
    if (this._ticker !== undefined) clearInterval(this._ticker);
    this._ticker = undefined;
    // Only OUR session. An unconditional abort here would kill a dictation
    // the title bar's mic started against a terminal pane.
    if (this._chatDictationActive && this._voice === 'listening') {
      voiceInputController.invalidateComposerChannel(this._chatDictationCapture?.channelId ?? '');
    }
    this._chatDictationActive = false;
    this._chatDictationCapture = null;
    this._userSelectionPending = false;
    this._settleAppVoiceConfirmation('unavailable');
    this._settleAppletOperationWaiter(false);
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

  get activeApplet(): AppletId | '' {
    return this._activeApplet;
  }

  /** Resolves only a registered applet through its existing host. */
  navigateAppletForAppVoice(
    applet: AppletId,
    target: string | undefined,
    operationId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const host = this.renderRoot.querySelector<MuxApplets>('mux-applets');
    if (!host || signal.aborted) return Promise.resolve(false);
    this._voiceAppletOperationId = operationId;
    return new Promise<boolean>((resolve) => {
      this._settleAppletOperationWaiter(false);
      const onAbort = () => this.cancelAppVoiceNavigation(operationId);
      const waiter = { operationId, applet, resolve, signal, onAbort };
      this._appletOperationWaiter = waiter;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        this.cancelAppVoiceNavigation(operationId);
        return;
      }
      host.show(applet, target, operationId);
      if (this._activeApplet === applet) {
        this._settleAppletOperationWaiter(true, waiter);
      }
    });
  }

  cancelAppVoiceNavigation(operationId: string): void {
    const waiter = this._appletOperationWaiter;
    if (!waiter || waiter.operationId !== operationId) return;
    this._settleAppletOperationWaiter(false, waiter);
  }

  private _settleAppletOperationWaiter(
    ok: boolean,
    expected?: NonNullable<MuxCos['_appletOperationWaiter']>,
  ): void {
    const waiter = this._appletOperationWaiter;
    if (!waiter || (expected && waiter !== expected)) return;
    this._appletOperationWaiter = null;
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    if (this._voiceAppletOperationId === waiter.operationId) this._voiceAppletOperationId = '';
    waiter.resolve(ok);
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
        ${threadStore.threaded ? this._renderContextSelector() : nothing}
        <span class="spacer"></span>
        <mux-voice-mode-button></mux-voice-mode-button>
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
   * The only thread switcher. It lives beside the shared surface title and
   * asks for a second, explicit Talk here action before it transmits a select
   * request; terminal/workspace navigation never reaches this path.
   */
  private _renderContextSelector(): TemplateResult {
    const options = threadStore.contexts;
    const candidate = options.find((option) => option.key === this._contextCandidate);
    const status = threadStore.contextStatus;
    return html`
      <div class="context">
        <button
          class="context-trigger"
          type="button"
          data-thread-context-selector
          aria-label="Conversation context: ${threadStore.contextLabel}${threadStore.hasUnread ? ', unread updates' : ''}"
          aria-expanded="${this._contextOpen ? 'true' : 'false'}"
          aria-controls="thread-context-menu"
          @click="${this._toggleContext}"
        >
          <span class="context-label">Context: ${threadStore.contextLabel}</span>
          ${threadStore.hasUnread
            ? html`<span class="context-badge" aria-hidden="true"></span>`
            : nothing}
          ${icon(ChevronDown, { size: 12 })}
        </button>
        ${status
          ? html`<span class="context-status" data-thread-context-status role="status">${status}</span>`
          : nothing}
        ${this._contextOpen
          ? html`
              <div
                class="context-menu"
                id="thread-context-menu"
                data-thread-context-menu
                role="dialog"
                aria-label="Choose conversation context"
                @keydown="${this._onContextListKey}"
              >
                <div class="context-heading">Choose a context, then talk there.</div>
                ${options.length > 0
                  ? html`
                      <ul class="context-list" aria-label="Conversation contexts">
                        ${options.map((option) => this._renderContextOption(option))}
                      </ul>
                    `
                  : html`<div class="context-empty" role="status">Loading real contexts…</div>`}
                <div class="context-actions">
                  <button
                    class="context-talk"
                    type="button"
                    data-thread-talk-here
                    ?disabled="${!candidate || !threadStore.canSelect}"
                    @click="${this._talkHere}"
                  >Talk here</button>
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private _renderContextOption(option: ThreadContextOption): TemplateResult {
    const selected = option.key === this._contextCandidate;
    const detail = option.detail;
    return html`
      <li>
        <button
          class="context-option"
          type="button"
          data-thread-context-option="${option.key}"
          aria-pressed="${selected ? 'true' : 'false'}"
          aria-current="${option.threadId !== '' && option.threadId === threadStore.selectedThreadId ? 'true' : 'false'}"
          aria-label="${option.unread ? `${option.label}, unread updates` : option.label}"
          @click="${() => {
            this._contextCandidate = option.key;
          }}"
        >
          <span class="context-option-main">
            <span class="context-option-name">${option.label}</span>
            ${detail
              ? html`<span class="context-option-detail ${option.refused ? 'refused' : ''}">${detail}</span>`
              : nothing}
          </span>
          ${option.unread ? html`<span class="context-row-badge" aria-hidden="true"></span>` : nothing}
        </button>
      </li>
    `;
  }

  /**
   * Housekeeping. No counts -- see the file header -- so the items say what
   * they will do and the confirm says what it costs, and neither offers a
   * number to weigh the decision against.
   */
  private _renderMenu(): TemplateResult {
    if (threadStore.threaded) {
      const noScopedControls =
        !threadStore.resetAvailable &&
        !threadStore.archiveAvailable &&
        !(threadStore.archiveSupported && threadStore.controlTarget?.kind === 'lobby');
      return html`
        <div class="menu" role="menu">
          ${threadStore.resetAvailable
            ? html`
                <button
                  type="button"
                  role="menuitem"
                  data-thread-reset
                  @click="${() => this._askThreadControl('reset')}"
                >Reset this context</button>
              `
            : nothing}
          ${threadStore.archiveAvailable
            ? html`
                <button
                  type="button"
                  role="menuitem"
                  class="danger"
                  data-thread-archive
                  @click="${() => this._askThreadControl('archive')}"
                >Archive this context</button>
              `
            : nothing}
          ${threadStore.archiveSupported && threadStore.controlTarget?.kind === 'lobby'
            ? html`<button type="button" role="menuitem" disabled>Lobby cannot be archived</button>`
            : nothing}
          ${noScopedControls
            ? html`<button type="button" role="menuitem" disabled>
                Thread controls are unavailable in text preview
              </button>`
            : nothing}
          <button
            type="button"
            role="menuitem"
            data-thread-migration-preview
            ?disabled="${threadStore.migrationPreviewPending}"
            @click="${this._previewMigration}"
          >${threadStore.migrationPreviewPending
            ? 'Opening migration preview…'
            : 'Preview catalog migration / rollback'}</button>
          <button type="button" role="menuitem" disabled>
            Clear messages is unavailable in text preview
          </button>
        </div>
      `;
    }
    const any = threadStore.hasMessages;
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
    const turns = threadStore.turns;
    const fault = threadStore.fault;
    return html`
      ${this._renderAttentionNotice()}
      ${this._renderLobbySummaries()}
      ${turns.length === 0 && !this._confirm && !this._threadConfirm ? this._renderZero() : nothing}
      ${turns.map((t) => this._renderTurn(t))}
      ${this._renderRootState()}
      ${threadStore.threaded && threadStore.hasUnread
        ? html`
            <div class="thread-unread" data-thread-unread role="status">
              Updates are waiting in another context. Open Context to choose where to talk.
            </div>
          `
        : nothing}
      ${fault && fault.fatal
        ? html`<div class="fatal" role="alert">${fault.message}</div>`
        : nothing}
      ${fault && !fault.fatal ? html`<div class="notice">${fault.message}</div>` : nothing}
      ${threadStore.threaded && this._threadConfirm !== null
        ? this._renderThreadConfirm(this._threadConfirm)
        : nothing}
      ${this._appVoiceConfirmation ? this._renderAppVoiceConfirmation(this._appVoiceConfirmation) : nothing}
      ${!threadStore.threaded && this._confirm !== null ? this._renderConfirm(this._confirm) : nothing}
    `;
  }

  /**
   * One durable item at a time: dismissal reveals the next catalog item. No
   * incoming record opens a context, Viewer, microphone, or approval prompt.
   */
  private _renderAttentionNotice(): TemplateResult | typeof nothing {
    const attention = threadStore.attention[0];
    if (!attention) return nothing;
    return html`
      <div class="notice" data-thread-attention="${attention.id}" aria-label="Queued attention">
        <div><strong>Attention queued</strong></div>
        <div>
          From ${attention.label} · observed
          <time datetime="${attention.observedAt}" title="${attention.observedAt}"
            >${observedAt(attention.observedAt)}</time
          >
        </div>
        <div>${attention.reason}</div>
        ${attention.canViewDetail
          ? nothing
          : html`<div>${attention.detailUnavailable}</div>`}
        <div class="row">
          <button
            class="btn pri"
            type="button"
            data-thread-attention-view="${attention.id}"
            title="${attention.canViewDetail ? 'Open a read-only Viewer detail for this context' : attention.detailUnavailable}"
            ?disabled="${!attention.canViewDetail || attention.detailPending}"
            @click="${() => threadStore.viewAttentionDetail(attention.id)}"
          >${attention.detailPending ? 'opening detail…' : 'View detail'}</button>
          <button
            class="btn no"
            type="button"
            data-thread-attention-talk="${attention.id}"
            ?disabled="${!threadStore.canSelect}"
            @click="${() => this._talkAttention(attention)}"
          >Talk here</button>
          <button
            class="btn no"
            type="button"
            data-thread-attention-dismiss="${attention.id}"
            ?disabled="${attention.acknowledging}"
            @click="${() => threadStore.acknowledgeAttention(attention.id)}"
          >${attention.acknowledging ? 'dismissing…' : 'Dismiss'}</button>
        </div>
      </div>
    `;
  }

  /** Bounded terminal extracts are context, not a claim that remote work is current. */
  private _renderLobbySummaries(): TemplateResult | typeof nothing {
    const summaries = threadStore.lobbySummaries;
    if (summaries.length === 0) return nothing;
    return html`
      <div class="notice" data-thread-summaries aria-label="Completed work extracts">
        <div><strong>Completed-work extracts</strong></div>
        <div>Bounded provenance records; observed time is not a freshness claim.</div>
        ${summaries.map((summary) => this._renderSummary(summary))}
      </div>
    `;
  }

  private _renderSummary(summary: ThreadSummary): TemplateResult {
    return html`
      <div data-thread-summary="${summary.id}">
        <div>
          ${summary.label} · observed
          <time datetime="${summary.observedAt}" title="${summary.observedAt}"
            >${observedAt(summary.observedAt)}</time
          >
          · extract${summary.truncated ? ' (display truncated)' : ''}
        </div>
        <div>${summary.text}</div>
      </div>
    `;
  }

  /** Per-root tool snapshots stay inside the transcript; they are not a dashboard. */
  private _renderRootState(): TemplateResult | typeof nothing {
    const root = threadStore.rootState;
    if (!root) return nothing;
    return html`
      <div class="notice" data-thread-root-state aria-label="Context tracking state">
        <div><strong>Context tracking</strong></div>
        ${root.goal
          ? html`<div title="${root.goal}">Goal: ${compactText(root.goal)}</div>`
          : nothing}
        ${root.goal ? html`<div>Goal tracking only; autonomous scheduling is unavailable.</div>` : nothing}
        ${root.todos.length > 0
          ? html`
              <div>Todo:</div>
              ${root.todos.map(
                (todo) => html`<div data-thread-todo-status="${todo.status}">
                  [${todo.status}] ${compactText(todo.activeForm || todo.content, 200)}
                </div>`,
              )}
            `
          : nothing}
      </div>
    `;
  }

  private _renderZero(): TemplateResult {
    if (threadStore.negotiating) {
      return html`
        <div class="zero">
          <div class="lede">Connecting to ${ASSISTANT_NAME}…</div>
          <p class="sub">Checking whether this server offers real text-thread contexts.</p>
        </div>
      `;
    }
    if (threadStore.threaded && threadStore.selectionPending) {
      return html`
        <div class="zero">
          <div class="lede">Opening context…</div>
          <p class="sub">Waiting for the server's authoritative history and draft reference.</p>
        </div>
      `;
    }
    return html`
      <div class="zero">
        <div class="lede">What needs you?</div>
        <p class="sub">
          Describe a problem and ${ASSISTANT_NAME} splits it, routes it, and
          starts the lanes. What it starts shows up on the right.
        </p>
      </div>
    `;
  }

  private _renderTurn(t: CosTurn): TemplateResult {
    const asks = threadStore.approvals.filter((a) => a.turnId === t.id);
    const live = t.status === 'pending' || t.status === 'streaming';
    const cancelling = threadStore.threaded && threadStore.isControlPending('cancel', t.id);
    return html`
      ${t.prompt
        ? html`<div class="turn you">
            <div class="who">you</div>
            <div class="bd"><p class="say">${t.prompt}</p></div>
          </div>`
        : nothing}
      <div class="turn cos">
        <div class="who">${ASSISTANT_NAME.toLowerCase()}</div>
        <div class="bd">
          ${t.blocks.map((b, i) => this._renderBlock(t, b, i))}
          ${live && t.blocks.length === 0
            ? html`<div class="waiting">working...</div>`
            : nothing}
          ${threadStore.threaded && (threadStore.canCancel(t.id) || cancelling)
            ? html`
                <button
                  class="btn no"
                  type="button"
                  data-thread-cancel="${t.id}"
                  ?disabled="${cancelling}"
                  @click="${() => threadStore.cancel(t.id)}"
                >${cancelling ? 'stopping…' : 'stop this turn'}</button>
              `
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
          ${threadStore.threaded && asks.length > 0 && !threadStore.approvalAvailable
            ? html`<div class="notice">Approvals are unavailable in text preview.</div>`
            : asks.map((a) => this._renderAsk(a))}
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
    const pending = threadStore.threaded && threadStore.isControlPending('approval', a.requestId);
    const enabled = !threadStore.threaded || threadStore.canAnswer(a.turnId, a.requestId);
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
                  @click="${() => threadStore.answer(a.turnId, a.requestId, true)}"
                >${pending ? 'sending…' : 'approve'}</button>
                <button
                  class="btn no"
                  type="button"
                  data-thread-approval="deny:${a.turnId}:${a.requestId}"
                  ?disabled="${pending || !enabled}"
                  @click="${() => threadStore.answer(a.turnId, a.requestId, false)}"
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

  /** One scoped destructive control, shown with the exact target before send. */
  private _renderThreadConfirm(confirm: ThreadControlConfirmation): TemplateResult {
    const pending = this._threadControlPending !== null;
    const resetting = confirm.action === 'reset';
    const head = resetting
      ? `Reset ${confirm.target.label}?`
      : `Archive ${confirm.target.label}?`;
    const detail = resetting
      ? 'This resets only this conversation context. It does not change terminals, workspaces, lanes, or applets. Its current draft binding is cleared and you must explicitly select the new generation.'
      : 'This archives only this conversation context. It does not change terminals, workspaces, lanes, or applets. Its history remains an immutable reference.';
    return html`
      <div class="turn">
        <div class="who"></div>
        <div class="bd">
          <div class="confirm" role="alertdialog" aria-label="${head}">
            <div class="h">${icon(TriangleAlert, { size: 13 })} ${head}</div>
            <p class="d">${detail}</p>
            <div class="row">
              <button
                class="btn danger"
                type="button"
                data-thread-confirm="${confirm.action}:${confirm.target.threadId}:${confirm.target.generation}"
                ?disabled="${pending}"
                @click="${() => this._doThreadControl(confirm)}"
              >${resetting ? 'Reset this context' : 'Archive this context'}</button>
              <button
                class="btn no"
                type="button"
                @click="${() => {
                  this._threadConfirm = null;
                }}"
              >Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private _renderAppVoiceConfirmation(confirm: AppVoiceSubmitConfirmation): TemplateResult {
    return html`
      <div class="turn" data-app-voice-submit-confirmation>
        <div class="who"></div>
        <div class="bd">
          <div class="confirm" role="alertdialog" aria-label="Confirm voice-requested work">
            <div class="h">${icon(TriangleAlert, { size: 13 })} Send voice-requested work?</div>
            <p class="d">Target: ${confirm.label}</p>
            <p class="d">${confirm.text}</p>
            <p class="d">Voice-requested work is never autonomous. Confirming sends this exact text only to this exact visible conversation.</p>
            <div class="row">
              <button
                class="btn pri"
                type="button"
                data-testid="app-voice-submit-confirm"
                @click="${() => this._settleAppVoiceConfirmation('confirmed')}"
              >Send</button>
              <button
                class="btn no"
                type="button"
                data-testid="app-voice-submit-decline"
                @click="${() => this._settleAppVoiceConfirmation('declined')}"
              >Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * App voice is controlled by the persistent root bubble. The text composer
   * and its context selector stay mounted for every app voice state.
   */
  private _renderComposer(): TemplateResult {
    const threaded = threadStore.threaded;
    const negotiating = threadStore.negotiating;
    const ready = this._draft.trim().length > 0 && (!threaded || threadStore.inputEnabled);
    const locked = negotiating || (threaded && !threadStore.inputEnabled);
    const listening = !negotiating && this._voice === 'listening';
    const busy = threadStore.busy;
    const last = threadStore.turns[threadStore.turns.length - 1];
    const notice = threadStore.composerNotice;
    const storageNotice = threadStore.storageNotice;
    const placeholder = threaded
      ? threadStore.selectionPending
        ? 'waiting for context…'
        : 'message this context…'
      : negotiating
        ? 'checking text threads…'
        : 'describe a problem…';
    return html`
      <div class="comp">
        <div class="cbox ${listening ? 'live' : ''}">
          <textarea
            class="ctext"
            data-thread-composer
            rows="1"
            autocomplete="off"
            spellcheck="false"
            placeholder="${placeholder}"
            aria-label="${threaded ? 'Message the selected conversation context' : 'Describe a problem'}"
            ?disabled="${locked}"
            .value="${this._draft}"
            @input="${this._onDraft}"
            @keydown="${this._onKey}"
          ></textarea>
          <div class="crow">
            ${notice
              ? html`<span class="threaded-status" data-thread-composer-status role="status">${notice}</span>`
              : nothing}
            ${this._dictationNotice
              ? html`<span class="threaded-status" data-voice-dictation-status role="status">${this._dictationNotice}</span>`
              : nothing}
            ${storageNotice ? html`<span class="threaded-status" role="status">${storageNotice}</span>` : nothing}
            ${threaded && threadStore.hasUncertainTurn
              ? html`
                  <button
                    class="threaded-release"
                    type="button"
                    data-thread-release-uncertain
                    @click="${this._releaseUncertainDraft}"
                  >Enable a new send</button>
                `
              : nothing}
            ${!threaded && !negotiating && busy && last
              ? html`<button
                  class="btn no"
                  type="button"
                  @click="${() => threadStore.cancel(last.id)}"
                >stop</button>`
              : nothing}
            ${!negotiating && threadStore.composerIdentity.channelId !== 'none' && voiceInputController.isSupported()
              ? html`<button
                  class="cbtn ${listening ? 'rec' : ''}"
                  type="button"
                  title="${listening ? 'Stop dictating' : 'Dictate'}"
                  aria-label="${listening ? 'Stop dictating' : 'Dictate'}"
                  aria-pressed="${listening ? 'true' : 'false'}"
                  @click="${this._toggleVoice}"
                >${listening ? icon(Square, { size: 13 }) : icon(Mic, { size: 16 })}</button>`
              : nothing}
            ${negotiating || ready
              ? html`<button
                  class="cbtn send"
                  type="button"
                  aria-label="Send"
                  ?disabled="${!ready}"
                  @click="${this._submit}"
                >${icon(ArrowUp, { size: 15 })}</button>`
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
    if (detail?.applet) {
      this._activeApplet = detail.applet;
      if (this._voiceAppletOperationId && this._appletOperationWaiter?.applet === detail.applet) {
        this._settleAppletOperationWaiter(true);
      } else {
        this.dispatchEvent(new CustomEvent('app-voice-user-navigation', { bubbles: true, composed: true }));
        this.dispatchEvent(new CustomEvent('app-voice-observation', { bubbles: true, composed: true }));
      }
    }
    if (detail?.roomy === true) this._setDetent('full');
  };

  /** Visible, human-only confirmation for a provider-requested work turn. */
  requestAppVoiceSubmitConfirmation(
    operationId: string,
    label: string,
    text: string,
  ): Promise<AppVoiceSubmitConfirmationOutcome> {
    if (this._appVoiceConfirmation !== null || !operationId || !text.trim()) {
      return Promise.resolve('unavailable');
    }
    return new Promise<AppVoiceSubmitConfirmationOutcome>((resolve) => {
      this._appVoiceConfirmation = { operationId, label, text, resolve };
      this._pinned = true;
    });
  }

  cancelAppVoiceSubmitConfirmation(operationId: string): void {
    if (this._appVoiceConfirmation?.operationId !== operationId) return;
    this._settleAppVoiceConfirmation('unavailable');
  }

  private _settleAppVoiceConfirmation(outcome: AppVoiceSubmitConfirmationOutcome): void {
    const confirmation = this._appVoiceConfirmation;
    if (!confirmation) return;
    this._appVoiceConfirmation = null;
    confirmation.resolve(outcome);
  }

  // -------------------------------------------------------------------------
  // Intent
  // -------------------------------------------------------------------------

  private _toggleContext = (e: Event): void => {
    e.stopPropagation();
    if (!threadStore.threaded) return;
    this._contextOpen = !this._contextOpen;
    this._menuOpen = false;
    if (!this._contextOpen) return;
    const options = threadStore.contexts;
    const current = options.find((option) => option.threadId === threadStore.selectedThreadId);
    this._contextCandidate = current?.key ?? options[0]?.key ?? '';
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLButtonElement>('.context-option')?.focus();
    });
  };

  private _talkHere = (): void => {
    const option = threadStore.contexts.find((item) => item.key === this._contextCandidate);
    if (!option) return;
    this._userSelectionPending = true;
    this.dispatchEvent(new CustomEvent('app-voice-user-navigation', { bubbles: true, composed: true }));
    if (!threadStore.select(option.target)) {
      this._userSelectionPending = false;
      return;
    }
    this._contextOpen = false;
    this._threadConfirm = null;
    this._pinned = true;
  };

  private _onContextListKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this._contextOpen = false;
      this.renderRoot.querySelector<HTMLButtonElement>('.context-trigger')?.focus();
      return;
    }
    let delta = 0;
    if (e.key === 'ArrowDown') delta = 1;
    else if (e.key === 'ArrowUp') delta = -1;
    else if (e.key === 'Home') delta = -Infinity;
    else if (e.key === 'End') delta = Infinity;
    else return;
    const choices = [
      ...this.renderRoot.querySelectorAll<HTMLButtonElement>('.context-option'),
    ];
    if (choices.length === 0) return;
    e.preventDefault();
    const from = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('.context-option') : null;
    const at = from ? choices.indexOf(from) : 0;
    const next =
      delta === -Infinity ? 0 : delta === Infinity ? choices.length - 1 : (at + delta + choices.length) % choices.length;
    choices[next]?.focus();
  };

  private _toggleMenu = (e: Event): void => {
    e.stopPropagation();
    this._menuOpen = !this._menuOpen;
    this._contextOpen = false;
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
    if (!this._menuOpen && !this._contextOpen) return;
    const path = e.composedPath();
    const pressed = (sel: string): boolean => {
      const el = this.renderRoot.querySelector(sel);
      return el !== null && path.includes(el);
    };
    if (
      pressed('.menu') ||
      pressed('.dots') ||
      pressed('.context-menu') ||
      pressed('.context-trigger')
    ) {
      return;
    }
    this._menuOpen = false;
    this._contextOpen = false;
  };

  private _ask(which: Housekeeping): void {
    if (threadStore.threaded) return;
    this._menuOpen = false;
    this._confirm = which;
    this._pinned = true;
  }

  private _doClear = (): void => {
    const which = this._confirm;
    this._confirm = null;
    if (which === null) return;
    threadStore.clear(which);
  };

  private _askThreadControl(action: 'reset' | 'archive'): void {
    const target = threadStore.controlTarget;
    if (!target) return;
    if (action === 'reset' && !threadStore.resetAvailable) return;
    if (action === 'archive' && !threadStore.archiveAvailable) return;
    this._menuOpen = false;
    this._threadConfirm = { action, target };
    this._pinned = true;
  }

  private _doThreadControl = (confirm: ThreadControlConfirmation): void => {
    if (this._threadControlPending !== null) return;
    this._threadControlPending = confirm;
    this._threadConfirm = null;
    const sent = confirm.action === 'reset'
      ? threadStore.reset(confirm.target)
      : threadStore.archive(confirm.target);
    // A synchronous transmit/validation rejection creates no store pending
    // record, so only this exact rejected attempt may clear the local guard.
    if (!sent) this._threadControlPending = null;
  };

  private _settleThreadControlPending(): void {
    const pending = this._threadControlPending;
    if (!pending || threadStore.isThreadControlPending(pending.action, pending.target)) return;
    // The store removed this exact request only after its matching result (or
    // disconnect cleanup), never because another context's control settled.
    this._threadControlPending = null;
  }

  /** Explicit context switch from a queued record; no attention event calls this. */
  private _talkAttention = (attention: ThreadAttention): void => {
    this._userSelectionPending = true;
    this.dispatchEvent(new CustomEvent('app-voice-user-navigation', { bubbles: true, composed: true }));
    if (!threadStore.select({ kind: 'thread', threadId: attention.threadId })) {
      this._userSelectionPending = false;
      return;
    }
    this._threadConfirm = null;
    this._pinned = true;
  };

  /** The backend endpoint is metadata-only; Viewer opens only after this click. */
  private _previewMigration = (): void => {
    this._menuOpen = false;
    if (threadStore.migrationPreview()) this._pinned = true;
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
      if (
        this._menuOpen ||
        this._contextOpen ||
        this._confirm !== null ||
        this._threadConfirm !== null
      ) {
        e.preventDefault();
        this._menuOpen = false;
        this._contextOpen = false;
        this._confirm = null;
        this._threadConfirm = null;
        return;
      }
      this.dispatchEvent(new CustomEvent('home-dismiss', { bubbles: true, composed: true }));
    }
  };

  private _submit = (): void => {
    const prompt = this._draft.trim();
    if (!prompt) return;
    // In threaded mode the coordinator retains this draft until the server
    // sends a real turn receipt. A missing receipt is uncertainty, not proof
    // that the user's words were sent.
    if (!threadStore.send(prompt)) return;
    this._pinned = true;
    void this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector<HTMLTextAreaElement>('.ctext');
      if (el) this._fit(el);
    });
  };

  private _releaseUncertainDraft = (): void => {
    threadStore.releaseUncertainDraft();
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLTextAreaElement>('.ctext')?.focus();
    });
  };

  private _toggleVoice = (): void => {
    if (threadStore.negotiating) return;
    if (this._voice === 'listening') {
      if (this._chatDictationActive) voiceInputController.stop();
      return;
    }
    const composer = threadStore.composerIdentity;
    if (composer.channelId === 'none') return;
    const capture = voiceInputController.startComposer(composer.channelId);
    if (!capture) return;
    this._dictationNotice = '';
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
    const composer = threadStore.composerIdentity;
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
