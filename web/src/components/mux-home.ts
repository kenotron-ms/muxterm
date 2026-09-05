/**
 * mux-home.ts — the home view.
 *
 * The surface a human lands on to see which sessions want them, before picking
 * a workspace to work in. Takes the whole right side. NO TITLE BAR: the sidebar
 * already says where you are, so content starts at the top edge.
 *
 * Four sections, in this order, with these exact words:
 *   Needs input · Running · Completed
 * A lifecycle, not a taxonomy: anything launched enters Running and leaves it
 * in exactly one of two directions — it wants you, or it is over. Completed
 * merges done + failed + stopped, because "how did it end?" is a property of
 * the row, not a reason to sit in a different group. `groupFor()` in
 * session-state.ts owns that placement; this file never re-derives it.
 *
 * PRESENTATIONAL. It is handed `sessions` and reports intent through events.
 * It imports no socket, no store, no daemon — which is exactly why the
 * standalone fixture demo can mount this same component with no backend.
 *
 *   home-open      { sessionId, paneId, workspaceId }  Enter / click a tile
 *   home-action    { sessionId, paneId, workspaceId, action }  an ask button
 *   home-dismiss   {}                                   Esc
 */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  HOME_GROUPS,
  groupFor,
  isKnownHarness,
  shortProject,
  type HomeGroup,
  type SessionState,
} from '../lib/session-state.js';
import {
  LAUNCHABLE_HARNESSES,
  harnessLabel,
  type HarnessName,
} from '../lib/harness.js';
import { TILE_COLS, TILE_ROWS, tileForSession, tileLinesFor } from '../lib/home-tile.js';
import { renderTile, fontReady } from '../lib/preview-canvas.js';
import { PREVIEW_CELL } from '../lib/fonts.js';
import { paletteAnsiArray, resolvePalette } from '../lib/theme.js';
import { icon } from '../lib/icons.js';
import { ArrowUp, LayoutGrid, Rows3 } from 'lucide';
import { NEEDS_GLYPH } from './mux-start-card.js';

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------

export type HomeView = 'tiles' | 'cards';

/**
 * localStorage, not the server config.
 *
 * This is a per-eyeball display preference with no server-side meaning, and
 * putting it in config.toml would make it a machine-wide setting that a second
 * browser silently overwrites. Key is namespaced so it cannot collide.
 */
const VIEW_KEY = 'muxterm.home.view';

function loadView(): HomeView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'tiles' ? 'tiles' : 'cards';
  } catch {
    return 'cards'; // private mode / storage disabled: still usable, just not sticky
  }
}

function saveView(v: HomeView): void {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* not sticky; not fatal */
  }
}

// ---------------------------------------------------------------------------
// Asks and actions
// ---------------------------------------------------------------------------

export type HomeAction = 'approve' | 'deny' | 'reply' | 'open';

interface Choice {
  id: HomeAction;
  label: string;
  primary?: boolean;
}

/**
 * The buttons an ask offers.
 *
 * ⚠ These are derived from `waitingFor`, which is a five-value enum. The
 * mockup shows the session's OWN option text ("Wrap" / "Replace") — that needs
 * a `choices[]` field the SessionState contract does not carry today. Until it
 * does, a generic-but-correct verb is the honest answer; inventing the
 * session's options here would put words in its mouth.
 */
function choicesFor(s: SessionState): Choice[] {
  switch (s.waitingFor) {
    case 'permission prompt':
      return [
        { id: 'approve', label: 'Approve', primary: true },
        { id: 'deny', label: 'Deny' },
        { id: 'open', label: 'Open' },
      ];
    case 'sandbox request':
    case 'worker request':
      return [
        { id: 'approve', label: 'Allow', primary: true },
        { id: 'deny', label: 'Deny' },
        { id: 'open', label: 'Open' },
      ];
    case 'input needed':
      return [
        { id: 'reply', label: 'Reply…', primary: true },
        { id: 'open', label: 'Open' },
      ];
    case 'dialog open':
    default:
      return [{ id: 'open', label: 'Open', primary: true }];
  }
}

/**
 * The ask, written out.
 *
 * An autonomous lane can reach this group without a `waitingFor` at all: it is
 * here because its loop stopped SHORT of its own condition, not because it
 * asked a question. Falling through to "input needed" there would misdescribe
 * why it wants you -- nobody typed a prompt for you to answer, the run simply
 * ran out of turns. Said plainly instead, so the row explains itself.
 */
function askFor(s: SessionState): string {
  const doing = s.doing?.trim() ?? '';
  const stoppedShort = s.mode === 'autonomous' && s.state === 'stopped';
  const reason = s.waitingFor ?? (stoppedShort ? 'loop stopped short of its goal' : 'input needed');
  if (doing === '') return `${reason[0]?.toUpperCase()}${reason.slice(1)}.`;
  return `${reason[0]?.toUpperCase()}${reason.slice(1)} — ${doing}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Coarse age. Returns '' for an unset timestamp rather than "56y ago" — the
 * fixture carries updatedAt: 0, and so will any producer that hasn't wired the
 * clock yet.
 */
function age(updatedAt: number, nowSec: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const d = Math.max(0, Math.floor(nowSec - updatedAt));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

/** State mark class — one vocabulary for tiles, cards and rows. */
function markClass(s: SessionState): string {
  const g = groupFor(s);
  if (g === 'Needs input') return 'm-need';
  if (g === 'Running') return 'm-work';
  if (s.state === 'failed') return 'm-fail';
  if (s.state === 'done') return 'm-done';
  return 'm-none';
}

// ---------------------------------------------------------------------------
// Geometry
//
// The view's one measure is DERIVED from the preview tile, not chosen: the
// content column is exactly four tiles wide, so the tiles grid fills it
// precisely and cards, rows and the composer all sit on the same rails. Change
// TILE_COLS and every one of these follows.
// ---------------------------------------------------------------------------

const TILE_W = TILE_COLS * PREVIEW_CELL.w;
const TILE_H = TILE_ROWS * PREVIEW_CELL.h;

/** `.tl .tbody` padding, per side. Mirrors `--s-4` in the CSS below. */
const TILE_PAD = 8;
/** `.tl` border width, per side. */
const TILE_BORDER = 1;
/** Gap between tiles. Mirrors `--s-4`. */
const TILE_GAP = 8;
/** Outer width of one tile, canvas plus its own chrome. */
const TILE_BOX = TILE_W + 2 * TILE_PAD + 2 * TILE_BORDER;
/** The content measure: four tiles and the three gaps between them. */
const PAGE_W = 4 * TILE_BOX + 3 * TILE_GAP;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement('mux-home')
export class MuxHome extends LitElement {
  /** Every session, ungrouped. Grouping is this component's job. */
  @property({ attribute: false }) sessions: readonly SessionState[] = [];

  /** Palette name, for the tile renderer. Matches config.theme.palette. */
  @property({ type: String }) palette = 'tokyo-night';

  /**
   * True when these rows came from the committed development fixture rather
   * than a live producer. Shown, not hidden: a home view that looks live but
   * isn't would be worse than no home view.
   */
  @property({ type: Boolean }) fixture = false;

  /** Workspaces offered as targets in the new-session bar. */
  @property({ attribute: false }) workspaces: readonly { id: string; name: string }[] = [];

  @state() private _draft = '';
  @state() private _target = '';
  /**
   * Which coding-agent CLI the new pane runs. The composer starts a SESSION in
   * that harness -- it does not open a shell and type at it -- so this is the
   * program, not a label.
   */
  @state() private _harness: 'amplifier' | 'claude' = 'amplifier';
  @state() private _view: HomeView = loadView();
  @state() private _cursor = 0;
  @state() private _peek = false;
  /** null = probing, false = fall back to text, true = draw the bitmap tile. */
  @state() private _fontOk: boolean | null = null;

  private _now = Math.floor(Date.now() / 1000);

  static styles = css`
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    /* ═══════════════════════════════════════════════════════════════════
       TOKENS

       Every size, colour, gap and radius below this block is read from
       here. No rule invents one of its own.

       The scales are small on purpose. This view previously carried 32
       distinct px values and 15 distinct font sizes, each chosen locally
       — which is what made it read as assembled rather than designed.
       ═══════════════════════════════════════════════════════════════════ */
    :host {
      display: block;
      position: absolute;
      inset: 0;
      z-index: 5;
      background: var(--chrome-body);
      overflow: auto;
      outline: none;
      /* The component root carries the base text style, not .home: the
         composer is .home's SIBLING (it has to be, to be sticky against the
         scroller), so anything set on .home leaves the composer inheriting
         the document's 16px and its hint renders a third larger than the
         same hint in the keyhelp strip. */
      color: var(--ink-2);
      font-size: var(--t-ui);
      line-height: var(--lh-body);

      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

      /* ── Type ──────────────────────────────────────────────────────
         Four steps for the list, one per ROLE, and every value is one
         mux-sidebar or mux-start-card already uses — this view borrows the
         house's sizes instead of minting its own:

           meta 10px   mux-sidebar .ws-chip
           ui   12px   mux-sidebar .new-ws-btn / .footer-line / .update-btn
           name 13px   mux-sidebar .header / .ws-name
           lede 18px   the single headline

         meta is 10px, not the sidebar's 9px, and the difference is the
         house's own hard-won lesson: mux-start-card records that at 8.5px
         "a backtick is a two-pixel tick and the chip reads as an empty
         box", and uses 10.5px for the one string a user has to READ. 9px
         carries a two-glyph badge in a 200px rail; it does not carry
         "parity . p1" or a keycap in an 896px column.

         Weights are the closed CSS set 400 / 500 / 600, written literally:
         wrapping a standard weight in a custom property adds indirection
         and no information. (The old code used 640, which is not a weight
         the system-ui stack in index.html has, and rounds to 700.) */
      --t-meta: 10px;
      --t-ui: 12px;
      --t-name: 13px;
      --t-lede: 18px;
      /* The composer field, and only the composer field. 16px is iOS
         Safari's focus-zoom threshold: below it, tapping the box zooms the
         whole page and the user has to pinch back out. index.html sets no
         maximum-scale and ships apple-mobile-web-app-capable, so this is
         load-bearing on a phone, not taste. */
      --t-input: 16px;
      /* MEASURED, not chosen — the only such size here. The fallback tile
         is a ${TILE_COLS}-column text grid that has to fit ${TILE_W}px; at
         a typical 0.6em monospace advance the largest size that fits is
         ${TILE_W} / ${TILE_COLS} / 0.6, floored to a whole pixel. */
      --t-grid: 8px;

      --lh-tight: 1.25; /* headline, names, one-line chrome */
      --lh-body: 1.5; /* anything you read a sentence of */

      /* ── Space ─────────────────────────────────────────────────────
         4px base, with a 2px half-step and a 6px 1.5-step. Not the
         textbook 8px-only grid: muxterm is dense, and 6px is the single
         most common gap in mux-sidebar. An 8px ladder would inflate this
         view straight out of the house's rhythm. */
      --s-1: 2px;
      --s-2: 4px;
      --s-3: 6px;
      --s-4: 8px;
      --s-5: 12px;
      --s-6: 16px;
      --s-7: 24px;

      --r-chip: 3px; /* badges, keycaps */
      --r-ctl: 5px; /* buttons, select, segmented control */
      --r-card: 8px; /* cards, rows, tiles, the composer */

      /* ── Ink ───────────────────────────────────────────────────────
         Three levels, measured against --chrome-body in the default dark
         chrome:

           ink-1  10.6:1  names and the headline — what you SCAN
           ink-2   8.2:1  what a session is doing — what you READ
           ink-3   5.4:1  metadata: ids, ages, badges, hints

         ink-2 and ink-3 are mixes of the CHROME text tokens, never of the
         terminal palette. The level ink-2 replaces was --mux-fg, the
         terminal foreground: fine-looking in tokyo-night (8.1:1) and a
         genuine AA failure in solarized-light (3.99:1), because a terminal
         foreground is tuned for the terminal background, not for chrome.
         The level ink-3 replaces was --chrome-text-dim at 2.76:1 — below
         AA everywhere it was used, which was most of this view. */
      --ink-1: var(--chrome-text-bright);
      --ink-2: color-mix(in srgb, var(--chrome-text-bright) 78%, var(--chrome-text-dim));
      --ink-3: color-mix(in srgb, var(--chrome-text-dim) 55%, var(--chrome-text-bright));

      --surface: var(--chrome-bar);
      /* --chrome-border alone measures 1.27:1 on --chrome-body: a line
         nobody can see, costing a declaration and buying nothing. Lifted
         toward the dim text colour — the same move mux-sidebar makes for
         its preview bezel, and for the same reason. */
      --edge: color-mix(in srgb, var(--chrome-border) 40%, var(--chrome-text-dim));

      /* ── State ─── named for meaning, not for colour ─────────────── */
      --need: var(--mux-warn);
      --work: var(--mux-ansi-6);
      --ok: var(--mux-ok);
      --fail: var(--mux-error);
      --autonomous: var(--chrome-driver-accent);

      --dur: 120ms;
      --ctl: 28px; /* compact control box; 44px on a coarse pointer */

      /* The composer's resting height, from its own parts rather than a
         guess. The hard-coded 92px clearance this replaces was ~30px short
         of the box it was clearing, so the last row sat underneath it. */
      --composer-h: calc(
        2 * var(--t-input) * var(--lh-body) + 2 * var(--s-5) + var(--s-4) + var(--ctl)
      );
    }

    /* Nothing here animates position or size — these are colour and fill
       transitions on hover and focus. Honoured anyway: someone who asked
       for less motion asked for less motion. */
    @media (prefers-reduced-motion: reduce) {
      :host {
        --dur: 0ms;
      }
    }

    /* Real headings, so a screen reader can navigate the fleet by section.
       Sizing stays with the .lede / .group classes. */
    h1,
    h2 {
      margin: 0;
      font-size: inherit;
      font-weight: inherit;
    }

    kbd {
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: var(--lh-tight);
      border: 1px solid var(--edge);
      border-radius: var(--r-chip);
      padding: 0 var(--s-2);
      color: var(--ink-2);
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
      pointer-events: none;
    }

    .home {
      /* One measure for the whole view: exactly four preview tiles wide
         (see PAGE_W). Derived rather than chosen, so the tiles grid fills
         the column exactly and the composer sits on the same rails as the
         list above it. */
      max-width: calc(${PAGE_W}px + 2 * var(--s-6));
      margin-inline: auto;
      padding: var(--s-6) var(--s-6) calc(var(--composer-h) + var(--s-6) + var(--s-7));
      outline: none;
    }

    /* ── SHARED ROLE CLASSES ────────────────────────────────────────────
       One vocabulary for a session, used identically by the ask card, the
       compact row and the tile.

       Before this, a session NAME was 13px/640 in a card, 12.5px/600 in a
       row and 10.5px/600 in a tile; what it was DOING was 12.5px in one
       place and 11px in another; where it lived was 9.5px here and 8.5px
       there. The same fact, styled three ways, because each view mode was
       written separately. That — not any single value — is most of why
       this view read as sloppy. */
    .name {
      font-size: var(--t-name);
      font-weight: 600;
      line-height: var(--lh-tight);
      color: var(--ink-1);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .doing {
      font-size: var(--t-ui);
      line-height: var(--lh-body);
      color: var(--ink-2);
    }
    .meta {
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: var(--lh-tight);
      color: var(--ink-3);
      white-space: nowrap;
    }
    /* The name line: name first, then whatever badges qualify it. */
    .nrow {
      display: flex;
      align-items: center;
      gap: var(--s-4);
      flex-wrap: wrap;
    }

    /* One badge geometry. There used to be three near-identical ones. */
    .badge {
      font-family: var(--mono);
      font-size: var(--t-meta);
      line-height: var(--lh-tight);
      padding: 0 var(--s-2);
      border: 1px solid transparent;
      border-radius: var(--r-chip);
      color: var(--ink-3);
      white-space: nowrap;
    }
    /* Only the EXCEPTIONAL mode is decorated. "interactive" is the default,
       and a default needs no box; "autonomous" changes what silence means
       (see SessionMode in session-state.ts), and that is worth a chip. */
    .badge.autonomous {
      color: var(--autonomous);
      background: color-mix(in srgb, var(--autonomous) 18%, transparent);
      border-color: color-mix(in srgb, var(--autonomous) 45%, transparent);
    }
    /* A harness muxterm has never heard of still renders, verbatim — the
       dashed edge is muxterm saying it has no opinion about the runner. */
    .badge.unknown {
      border-style: dashed;
      border-color: var(--edge);
    }
    .badge.pr {
      color: var(--ok);
      background: color-mix(in srgb, var(--ok) 12%, transparent);
      border-color: color-mix(in srgb, var(--ok) 45%, transparent);
    }

    .mark {
      font-size: var(--t-name);
      line-height: var(--lh-tight);
      text-align: center;
    }
    .m-need {
      color: var(--need);
    }
    .m-work {
      color: var(--work);
    }
    .m-done {
      color: var(--ok);
    }
    .m-fail {
      color: var(--fail);
    }
    .m-none {
      color: var(--ink-3);
    }

    /* ── CONTROLS ─────────────────────────────────────────────────────
       font: inherit, rather than the monospace this view was using:
       buttons in muxterm are sans (mux-sidebar .new-ws-btn, .update-btn). */
    .btn {
      font: inherit;
      font-size: var(--t-ui);
      line-height: var(--lh-tight);
      /* Matches mux-sidebar's .update-btn / .new-ws-btn, which are the
         house's other two text buttons. */
      padding: var(--s-3) var(--s-5);
      border: 1px solid var(--edge);
      border-radius: var(--r-ctl);
      background: var(--surface);
      color: var(--ink-2);
      cursor: pointer;
      transition: border-color var(--dur) ease, color var(--dur) ease;
    }
    .btn:hover {
      border-color: var(--chrome-accent);
      color: var(--ink-1);
    }
    /* The affirmative action. Colour lives in the fill and the edge; the
       LABEL stays ink-1. Green-on-green measured 2.32:1 in solarized-light
       and is 8.4:1 this way even in tokyo-night, where it was 7.4:1. */
    .btn.pri {
      background: color-mix(in srgb, var(--ok) 14%, var(--surface));
      border-color: color-mix(in srgb, var(--ok) 45%, transparent);
      color: var(--ink-1);
    }
    .btn.pri:hover {
      border-color: var(--ok);
    }

    /* Every real control gets a designed focus ring. There were none: the
       ask buttons, the view toggle, the workspace select and the send
       button are all tabbable and had nothing to show for it. Same
       treatment as mux-sidebar's .update-btn / .ws-remove-btn. */
    .btn:focus-visible,
    .seg button:focus-visible,
    .wsel:focus-visible,
    .send:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }

    /* Fitts: a fingertip needs ~44px. Desktop keeps the compact geometry
       the rest of muxterm uses; only a coarse pointer pays for the space.
       mux-sidebar sets the same precedent for its close-x. */
    @media (pointer: coarse) {
      .btn,
      .wsel,
      .seg button {
        min-height: 44px;
        padding-inline: var(--s-5);
      }
      .send {
        width: 44px;
        height: 44px;
      }
    }

    /* ── HEADLINE + VIEW TOGGLE ─────────────────────────────────────── */
    .head {
      display: flex;
      align-items: flex-start;
      gap: var(--s-5);
      margin-bottom: var(--s-5);
    }
    .lede {
      font-size: var(--t-lede);
      font-weight: 600;
      letter-spacing: -0.01em;
      line-height: var(--lh-tight);
      color: var(--ink-1);
    }
    /* The count is the single most important number in the view, and it
       used to be the least legible thing in the headline (2.76:1). It now
       carries the same warn colour the sidebar's Start card and workspace
       badges use, so the two surfaces agree at a glance. */
    .lede .n {
      margin-left: var(--s-1);
      color: var(--need);
    }
    /* ...except at zero, where mux-start-card has already established that
       nothing should be warm: "anything that draws the eye at zero teaches
       the user to stop looking at the card entirely". */
    .lede .n.zero {
      color: var(--ink-3);
    }
    .sub {
      margin-top: var(--s-1);
      font-size: var(--t-ui);
      line-height: var(--lh-body);
      color: var(--ink-3);
    }
    .head .sp {
      margin-left: auto;
    }

    .seg {
      display: inline-flex;
      border: 1px solid var(--edge);
      border-radius: var(--r-ctl);
      overflow: hidden;
      background: var(--surface);
    }
    .seg button {
      font: inherit;
      font-size: var(--t-ui);
      line-height: var(--lh-tight);
      padding: var(--s-3) var(--s-5);
      background: transparent;
      border: none;
      color: var(--ink-3);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: var(--s-2);
      transition: color var(--dur) ease, background var(--dur) ease;
    }
    .seg button + button {
      border-left: 1px solid var(--edge);
    }
    .seg button:hover {
      color: var(--ink-1);
    }
    /* Selected state carries TWO cues, fill and ink, so it survives both
       colour-blindness and the light palettes — where an accent-coloured
       label measured 3.29:1. */
    .seg button.on {
      background: color-mix(in srgb, var(--chrome-accent) 18%, var(--surface));
      color: var(--ink-1);
    }

    /* ── GROUP HEADINGS ───────────────────────────────────────────────
       Identical to mux-sidebar's .sb-heading, because it is the identical
       role. The full-width rule underneath is gone: at 1.27:1 it was a
       heavy gesture nobody could see, arguing with a heading nobody could
       read. Letter-spacing and the space above do the separating. */
    .group {
      font-family: var(--mono);
      font-size: var(--t-meta);
      letter-spacing: 0.11em;
      text-transform: uppercase;
      color: var(--ink-3);
      margin: var(--s-7) 0 var(--s-4);
    }

    /* ── ZERO STATE ─────────────────────────────────────────────────── */
    .allclear {
      display: flex;
      align-items: center;
      gap: var(--s-4);
      border: 1px solid var(--edge);
      border-radius: var(--r-card);
      background: var(--surface);
      padding: var(--s-5) var(--s-6);
      color: var(--ink-2);
    }

    /* ── LISTS ──────────────────────────────────────────────────────── */
    .list {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }
    .list.cards {
      gap: var(--s-4);
    }

    /* The cursor. Named "sel", not "on": "on" is already the segmented
       control's selected state, in this same shadow root. It is only
       accent-bright while the view actually holds the keyboard — otherwise
       j/k would look live when it isn't. */
    .sel {
      outline: 2px solid var(--edge);
      outline-offset: 2px;
    }
    /* :focus-within, not :focus -- keydown bubbles up to .home, so j/k stay
       live while focus sits on an Approve/Deny button inside a card, and the
       ring should say so. The composer is .home's sibling and stops
       propagation, so typing a prompt correctly dims the cursor. */
    .home:focus-within .sel {
      outline-color: var(--chrome-accent);
    }

    .item {
      border: 1px solid color-mix(in srgb, var(--need) 40%, var(--edge));
      background: color-mix(in srgb, var(--need) 7%, var(--surface));
      border-radius: var(--r-card);
      padding: var(--s-5);
      cursor: pointer;
      transition: background var(--dur) ease;
    }
    .item:hover {
      background: color-mix(in srgb, var(--need) 13%, var(--surface));
    }
    .item .loc {
      margin-left: auto;
    }
    .item .doing {
      margin: var(--s-2) 0 var(--s-4);
    }
    .opts {
      display: flex;
      gap: var(--s-3);
      flex-wrap: wrap;
    }

    .rowc {
      display: grid;
      grid-template-columns: var(--s-6) 1fr auto;
      gap: var(--s-4);
      /* start, not center: a row with a "doing" line is two lines tall, and
         centring left the state mark floating between them instead of
         leading the name it belongs to. Top-aligned, line 1 of the mark,
         the name and the right-hand metadata all read across together. */
      align-items: start;
      padding: var(--s-3) var(--s-5);
      border: 1px solid var(--edge);
      border-radius: var(--r-card);
      background: var(--surface);
      cursor: pointer;
      transition: background var(--dur) ease;
    }
    .rowc:hover {
      background: var(--chrome-hover);
    }
    .rowc .rmid {
      min-width: 0;
    }
    .rowc .rr {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: var(--s-1);
    }

    /* ── TILES ────────────────────────────────────────────────────────
       Fixed columns rather than 1fr, so a section holding one session
       shows one thumbnail at the same size as every other instead of a
       lone tile stretched across the row. auto-fill (not auto-fit) keeps
       the column structure when a section is short. No max-width any
       more: .home's measure IS four columns, so the grid fills it. */
    .tiles {
      display: grid;
      grid-template-columns: repeat(auto-fill, ${TILE_BOX}px);
      justify-content: start;
      gap: ${TILE_GAP}px;
    }
    .tl {
      border: 1px solid var(--edge);
      border-radius: var(--r-card);
      overflow: hidden;
      background: var(--mux-bg);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      transition: border-color var(--dur) ease;
    }
    .tl:hover {
      border-color: var(--chrome-accent);
    }
    .tl.need {
      border-color: color-mix(in srgb, var(--need) 45%, var(--edge));
    }
    .tl.fail {
      border-color: color-mix(in srgb, var(--fail) 45%, var(--edge));
    }
    .tl .th {
      padding: var(--s-3) ${TILE_PAD}px;
      background: var(--surface);
      border-bottom: 1px solid var(--edge);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--s-3);
    }
    .tl .tbody {
      padding: ${TILE_PAD}px;
      height: ${TILE_H + 2 * TILE_PAD}px;
      overflow: hidden;
    }
    .tl canvas {
      display: block;
      image-rendering: pixelated;
    }
    .tl pre.tbtext {
      margin: 0;
      font-family: var(--mono);
      font-size: var(--t-grid);
      line-height: var(--lh-body);
      color: var(--ink-3);
      white-space: pre;
      overflow: hidden;
    }
    .tl .tf {
      padding: var(--s-2) ${TILE_PAD}px;
      border-top: 1px solid var(--edge);
      display: flex;
      justify-content: space-between;
      gap: var(--s-3);
      margin-top: auto;
    }
    .tl .ta {
      padding: var(--s-3) ${TILE_PAD}px;
      border-top: 1px solid var(--edge);
      display: flex;
      gap: var(--s-2);
    }

    /* ── PEEK ─────────────────────────────────────────────────────────
       A left rule, because it is a detail OF the row above it. Nothing
       else in this view may use that form. */
    .peek {
      border-left: 2px solid var(--chrome-accent);
      background: var(--surface);
      border-radius: 0 var(--r-ctl) var(--r-ctl) 0;
      padding: var(--s-4) var(--s-5);
      margin: var(--s-1) 0 var(--s-4);
      color: var(--ink-2);
    }
    .peek dt {
      font-family: var(--mono);
      font-size: var(--t-meta);
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--ink-3);
      margin-top: var(--s-3);
    }
    .peek dt:first-of-type {
      margin-top: 0;
    }
    .peek dd {
      margin: var(--s-1) 0 0;
    }
    .peek .path {
      font-family: var(--mono);
      font-size: var(--t-meta);
      color: var(--ink-3);
    }

    /* ── FOOTERS ──────────────────────────────────────────────────────
       A boxed notice, NOT a left rule: that form already means "a detail
       of the row above" (.peek), and reusing it here made the fixture
       banner read as an unexplained orange bar stuck to the composer. */
    .fixture-note {
      margin-top: var(--s-7);
      padding: var(--s-3) var(--s-5);
      border: 1px solid color-mix(in srgb, var(--need) 45%, transparent);
      border-radius: var(--r-ctl);
      background: color-mix(in srgb, var(--need) 7%, transparent);
      font-family: var(--mono);
      font-size: var(--t-meta);
      color: var(--ink-2);
    }
    .keyhelp {
      margin-top: var(--s-6);
      display: flex;
      align-items: center;
      gap: var(--s-5);
      flex-wrap: wrap;
      color: var(--ink-3);
    }

    /* ── NEW-SESSION COMPOSER ─────────────────────────────────────────
       A task is not an object in muxterm — it is a session's FIRST prompt.
       So the composer is the whole of creating one, and it asks exactly
       two questions and offers one action: what to say, where to run it,
       go. Anything else in this box would be a fourth thing to decide
       before the first thing gets said. */
    .dispatch {
      position: sticky;
      bottom: 0;
      padding: 0 var(--s-6) var(--s-6);
      /* Full-bleed on purpose. The scrim used to be capped at the
         composer's own 780px, so on a wide window content scrolled past it
         un-faded down both sides of a 1180px column. */
      background: linear-gradient(to bottom, transparent, var(--chrome-body) 40%);
    }
    .composer {
      max-width: ${PAGE_W}px;
      margin-inline: auto;
      display: flex;
      flex-direction: column;
      gap: var(--s-4);
      padding: var(--s-5);
      border: 1px solid var(--edge);
      border-radius: var(--r-card);
      /* --surface: the same raised surface every other panel in this view,
         and in the sidebar, sits on. It used to be
         color-mix(--chrome-body 55%, black) — a colour that exists nowhere
         else in muxterm, mixed with a hardcoded literal, and a dark box on
         a light page in the three light palettes. */
      background: var(--surface);
      transition: border-color var(--dur) ease;
    }
    .composer:focus-within {
      border-color: var(--chrome-accent);
    }
    .prompt {
      width: 100%;
      resize: none;
      border: none;
      outline: none;
      background: transparent;
      color: var(--ink-1);
      font: inherit;
      font-size: var(--t-input);
      line-height: var(--lh-body);
      /* Eight lines, then scroll. Expressed in lines because that is what
         it means. */
      max-height: calc(8 * var(--t-input) * var(--lh-body));
      overflow-y: auto;
    }
    .prompt::placeholder {
      color: var(--ink-3);
    }
    .crow {
      display: flex;
      align-items: center;
      gap: var(--s-5);
    }
    /* Same box height as the send button, so the composer's footer reads as
       one row of controls rather than three things that happened to land on
       the same line. It also lets the native select centre its own label,
       which it was not doing with only vertical padding to work with. */
    .wsel {
      font: inherit;
      font-size: var(--t-ui);
      line-height: var(--lh-tight);
      height: var(--ctl);
      color: var(--ink-2);
      background: transparent;
      border: 1px solid var(--edge);
      border-radius: var(--r-ctl);
      padding: 0 var(--s-3);
      cursor: pointer;
      transition: border-color var(--dur) ease, color var(--dur) ease;
    }
    .wsel:hover {
      border-color: var(--chrome-accent);
      color: var(--ink-1);
    }
    .hint {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: var(--ink-3);
    }
    /* A phone has no Shift+Enter to tell anyone about. */
    @media (max-width: 560px) {
      .hint {
        display: none;
      }
    }
    .send {
      font: inherit;
      margin-left: auto;
      width: var(--ctl);
      height: var(--ctl);
      display: grid;
      place-items: center;
      border: 1px solid var(--chrome-accent);
      border-radius: 50%;
      background: var(--chrome-accent);
      color: var(--chrome-body);
      cursor: pointer;
      transition: background var(--dur) ease, border-color var(--dur) ease,
        color var(--dur) ease;
    }
    /* Empty draft: present but inert — an outline, not a ghost. The filled
       button used to dim to 25% opacity, which left the composer's only
       action nearly invisible while still occupying the space. */
    .send[disabled] {
      background: transparent;
      border-color: var(--edge);
      color: var(--ink-3);
      cursor: default;
    }
  `;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    this._now = Math.floor(Date.now() / 1000);
    void fontReady().then((ok) => {
      this._fontOk = ok;
    });
    // The home view is not a terminal, so it takes the keyboard. Focus lands on
    // the scroller itself; j/k/Space/Enter/Esc are handled there.
    void this.updateComplete.then(() => this.focusView());
  }

  /** Give the view keyboard focus. Called by the app when home is opened. */
  focusView(): void {
    // A surviving draft means the user was mid-sentence when they stepped away
    // -- the composer's state now outlives the toggle (cache() in app.ts). Put
    // the caret back at the end of what they typed rather than on the scroller,
    // where the next keystroke would be swallowed as j/k navigation.
    if (this._draft) {
      const box = this.renderRoot.querySelector<HTMLTextAreaElement>('.prompt');
      if (box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
        return;
      }
    }
    this.renderRoot.querySelector<HTMLElement>('.home')?.focus();
  }

  override updated(): void {
    this._paintTiles();
  }

  // -------------------------------------------------------------------------
  // Tiles
  // -------------------------------------------------------------------------

  private _paintTiles(): void {
    if (this._view !== 'tiles' || this._fontOk !== true) return;
    const palette = resolvePalette(this.palette);
    const ansi = paletteAnsiArray(palette);
    const byId = new Map(this.sessions.map((s) => [s.sessionId, s]));

    for (const canvas of this.renderRoot.querySelectorAll<HTMLCanvasElement>(
      'canvas[data-session]',
    )) {
      const s = byId.get(canvas.dataset['session'] ?? '');
      if (!s) continue;
      const g = groupFor(s);
      const ink =
        g === 'Needs input'
          ? palette.yellow
          : g === 'Running'
            ? palette.cyan
            : s.state === 'failed'
              ? palette.red
              : s.state === 'done'
                ? palette.green
                : palette.white;
      // mono: the stand-in tile has no per-cell colour to honour, and the ink
      // carries the state instead. Swapping in a real per-pane tile means
      // dropping `mono` and passing the tile's own fg/bg through.
      renderTile(canvas, tileForSession(s), {
        palette: ansi,
        fg: ink,
        bg: palette.background,
        mono: true,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  /** Sessions in display order — the j/k traversal order, across sections. */
  private _flat(): SessionState[] {
    const out: SessionState[] = [];
    for (const g of HOME_GROUPS) {
      for (const s of this.sessions) {
        if (groupFor(s) === g) out.push(s);
      }
    }
    return out;
  }

  private _move(delta: number): void {
    const n = this._flat().length;
    if (n === 0) return;
    this._cursor = Math.min(n - 1, Math.max(0, this._cursor + delta));
    void this.updateComplete.then(() => {
      this.renderRoot
        .querySelector<HTMLElement>('.sel')
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  private _onKeyDown = (e: KeyboardEvent): void => {
    // Never swallow a chord — ctrl+` toggles home, and the browser's own
    // shortcuts must keep working.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        this._move(1);
        return;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        this._move(-1);
        return;
      case ' ':
        e.preventDefault();
        this._peek = !this._peek;
        return;
      case 'Enter': {
        e.preventDefault();
        const s = this._flat()[this._cursor];
        if (s) this._open(s);
        return;
      }
      case 'Escape':
        e.preventDefault();
        this.dispatchEvent(
          new CustomEvent('home-dismiss', { bubbles: true, composed: true }),
        );
        return;
      default:
        return;
    }
  };

  private _open(s: SessionState): void {
    this.dispatchEvent(
      new CustomEvent('home-open', {
        detail: { sessionId: s.sessionId, paneId: s.paneId, workspaceId: s.workspaceId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _act(e: Event, s: SessionState, action: HomeAction): void {
    e.stopPropagation();
    if (action === 'open') {
      this._open(s);
      return;
    }
    this.dispatchEvent(
      new CustomEvent('home-action', {
        detail: {
          sessionId: s.sessionId,
          paneId: s.paneId,
          workspaceId: s.workspaceId,
          action,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _setView(v: HomeView): void {
    if (this._view === v) return;
    this._view = v;
    saveView(v);
  }

  private _focusIndex(s: SessionState): number {
    return this._flat().findIndex((x) => x.sessionId === s.sessionId);
  }

  private _onItemClick(s: SessionState): void {
    this._cursor = Math.max(0, this._focusIndex(s));
    this._open(s);
  }

  // -------------------------------------------------------------------------
  // Render pieces
  // -------------------------------------------------------------------------

  /**
   * The run-mode badge.
   *
   * Only `autonomous` gets one. `interactive` is the default contract -- a
   * session that ends its turn and waits is behaving correctly -- and a
   * default does not need a box around it. `autonomous` changes what silence
   * MEANS (see SessionMode in session-state.ts), and that earns a chip.
   * Decorating both said "here are two equal options"; decorating one says
   * "this one is different", which is the actual fact.
   */
  private _modeChip(s: SessionState): TemplateResult | '' {
    if (s.mode !== 'autonomous') return '';
    return html`<span class="badge autonomous" title="Runs a loop toward its own stop condition"
      >${s.mode}</span
    >`;
  }

  /**
   * The harness badge: which agent CLI is running this row.
   *
   * Nothing at all when the producer declared nothing -- an empty badge would
   * add a column of noise to say "no comment". A harness muxterm does not
   * recognize still renders, verbatim, because the alternative is a fleet view
   * that silently omits part of the fleet; the dashed edge is muxterm saying
   * it has no opinion about the runner, not that the row is suspect.
   */
  private _harnessChip(s: SessionState): TemplateResult | '' {
    if (!s.harness) return '';
    const known = isKnownHarness(s.harness);
    return html`<span
      class="badge ${known ? '' : 'unknown'}"
      title="${known ? s.harness : `${s.harness} — harness not recognized by muxterm`}"
      >${s.harness}</span
    >`;
  }

  private _loc(s: SessionState): string {
    const a = age(s.updatedAt, this._now);
    const base = `${s.workspaceId} · p${s.paneId}`;
    return a ? `${base} · ${a}` : base;
  }

  private _peekBlock(s: SessionState): TemplateResult | '' {
    if (!this._peek) return '';
    const knows = s.knows ?? [];
    return html`
      <dl class="peek">
        ${s.project
          ? html`<dt>project</dt>
              <dd class="path">${shortProject(s.project)} — ${s.project}</dd>`
          : ''}
        ${s.doneMeans
          ? html`<dt>done means</dt>
              <dd>${s.doneMeans}</dd>`
          : ''}
        ${knows.length > 0
          ? html`<dt>knows (${knows.length})</dt>
              ${knows.map((k) => html`<dd class="path">${k}</dd>`)}`
          : ''}
        ${!s.project && !s.doneMeans && knows.length === 0
          ? html`<dd>Nothing further declared.</dd>`
          : ''}
      </dl>
    `;
  }

  /**
   * A blocking session, written out with its buttons.
   *
   * No state mark here, deliberately. Every card in this section is by
   * definition waiting on you -- the heading above already said so -- and a
   * per-card glyph repeating it would be the loudest redundant thing on the
   * page. The rows and tiles carry the mark because THEY are mixed.
   */
  private _askCard(s: SessionState, focused: boolean): TemplateResult {
    return html`
      <div
        class="item ${focused ? 'sel' : ''}"
        aria-current="${focused ? 'true' : 'false'}"
        @click="${() => this._onItemClick(s)}"
      >
        <div class="nrow">
          <span class="name">${s.name}</span>
          ${this._harnessChip(s)}${this._modeChip(s)}
          <span class="meta loc">${this._loc(s)}</span>
        </div>
        <div class="doing">${askFor(s)}</div>
        <div class="opts">
          ${choicesFor(s).map(
            (c) => html`<button
              type="button"
              class="btn ${c.primary ? 'pri' : ''}"
              @click="${(e: Event) => this._act(e, s, c.id)}"
            >${c.label}</button>`,
          )}
        </div>
      </div>
      ${focused ? this._peekBlock(s) : ''}
    `;
  }

  /** A non-blocking session, one compact row. */
  private _row(s: SessionState, focused: boolean): TemplateResult {
    const a = age(s.updatedAt, this._now);
    const doing = s.doing?.trim() ?? '';
    return html`
      <div
        class="rowc ${focused ? 'sel' : ''}"
        aria-current="${focused ? 'true' : 'false'}"
        @click="${() => this._onItemClick(s)}"
      >
        <span class="mark ${markClass(s)}">${NEEDS_GLYPH}</span>
        <div class="rmid">
          <div class="nrow">
            <span class="name">${s.name}</span>
            ${this._harnessChip(s)}${this._modeChip(s)}
          </div>
          <!-- Omitted entirely when there is nothing to say. An empty div
               still took a line box and pushed the row taller for no text. -->
          ${doing ? html`<div class="doing">${doing}</div>` : ''}
        </div>
        <div class="meta rr">
          ${s.pr && s.pr > 0
            ? html`<span class="badge pr">#${s.pr}</span>`
            : html`<span>${s.workspaceId} · p${s.paneId}</span>`}
          <span>${a || '—'}</span>
        </div>
      </div>
      ${focused ? this._peekBlock(s) : ''}
    `;
  }

  /** A session as a terminal-preview thumbnail. */
  private _tile(s: SessionState, focused: boolean): TemplateResult {
    const g = groupFor(s);
    const needs = g === 'Needs input';
    const cls = `tl ${needs ? 'need' : ''} ${s.state === 'failed' ? 'fail' : ''} ${
      focused ? 'sel' : ''
    }`;

    let body: TemplateResult;
    if (this._fontOk === false) {
      // The 5x8 bitmap font is unusable. A 5x8 grid in fallback monospace is
      // unreadable garbage, so show the same lines as plain text instead.
      body = html`<pre class="tbtext">${tileLinesFor(s).join('\n')}</pre>`;
    } else {
      // Sized here as well as in renderTile() so the box is right on the very
      // first frame, before any pixels exist.
      body = html`<canvas
        data-session="${s.sessionId}"
        style="width:${TILE_W}px;height:${TILE_H}px"
      ></canvas>`;
    }

    return html`
      <div
        class="${cls}"
        aria-current="${focused ? 'true' : 'false'}"
        @click="${() => this._onItemClick(s)}"
      >
        <div class="th">
          <span class="name">${s.name}</span>
          <span class="mark ${markClass(s)}">${NEEDS_GLYPH}</span>
        </div>
        <div class="tbody">${body}</div>
        <div class="meta tf">
          <span>${s.workspaceId} · p${s.paneId}</span>
          <span>${age(s.updatedAt, this._now) || s.mode}</span>
        </div>
        ${needs
          ? html`<div class="ta">
              ${choicesFor(s)
                .filter((c) => c.id !== 'open')
                .slice(0, 2)
                .map(
                  (c) => html`<button
                    type="button"
                    class="btn ${c.primary ? 'pri' : ''}"
                    @click="${(e: Event) => this._act(e, s, c.id)}"
                  >${c.label}</button>`,
                )}
            </div>`
          : ''}
      </div>
    `;
  }

  private _renderMembers(members: SessionState[], group: HomeGroup): TemplateResult {
    const flat = this._flat();
    const focusedId = flat[this._cursor]?.sessionId;
    const isFocused = (s: SessionState): boolean => s.sessionId === focusedId;

    if (this._view === 'tiles') {
      return html`<div class="tiles">
        ${members.map((s) => this._tile(s, isFocused(s)))}
      </div>`;
    }
    if (group === 'Needs input') {
      return html`<div class="list cards">
        ${members.map((s) => this._askCard(s, isFocused(s)))}
      </div>`;
    }
    // The container owns the rhythm, not each row's own margin-bottom.
    return html`<div class="list">
      ${members.map((s) => this._row(s, isFocused(s)))}
    </div>`;
  }

  override render() {
    const all = this.sessions;
    const byGroup = new Map<HomeGroup, SessionState[]>(
      HOME_GROUPS.map((g) => [g, [] as SessionState[]]),
    );
    for (const s of all) byGroup.get(groupFor(s))?.push(s);

    const needs = byGroup.get('Needs input') ?? [];
    const others = all.length - needs.length;
    const spread = new Set(needs.map((s) => s.workspaceId)).size;

    // `spread` counts the workspaces the BLOCKED sessions are in, so it
    // belongs next to that count -- not tacked onto the "others" clause,
    // where the old copy put it and where it read as a claim about the
    // wrong number. Empty when there is nothing worth saying; a line that
    // says "0 others working or completed" is worse than no line.
    const clauses: string[] = [];
    if (spread > 1) clauses.push(`in ${spread} workspaces`);
    if (others > 0) {
      clauses.push(`${others} other${others === 1 ? '' : 's'} working or completed`);
    }
    const subline = clauses.join(' · ');

    return html`
      <div class="home" tabindex="0" @keydown="${this._onKeyDown}">
        <!-- No title bar, by design: the sidebar already says where you are. -->
        <div class="head">
          <div>
            <h1 class="lede">
              Needs input
              <span class="n ${needs.length === 0 ? 'zero' : ''}">· ${needs.length}</span>
            </h1>
            ${subline ? html`<div class="sub">${subline}</div>` : ''}
          </div>
          <div class="sp">
            <div class="seg" role="group" aria-label="Home view mode">
              <button
                type="button"
                class="${this._view === 'tiles' ? 'on' : ''}"
                aria-pressed="${this._view === 'tiles' ? 'true' : 'false'}"
                @click="${() => this._setView('tiles')}"
              >${icon(LayoutGrid, { size: 14 })} Tiles</button>
              <button
                type="button"
                class="${this._view === 'cards' ? 'on' : ''}"
                aria-pressed="${this._view === 'cards' ? 'true' : 'false'}"
                @click="${() => this._setView('cards')}"
              >${icon(Rows3, { size: 14 })} Cards</button>
            </div>
          </div>
        </div>

        ${needs.length === 0
          ? html`<div class="allclear">
              <span class="mark">${NEEDS_GLYPH}</span>
              <span>
                Nothing is waiting on you.${all.length > 0
                  ? ` ${all.length} session${all.length === 1 ? '' : 's'} tracked.`
                  : ''}
              </span>
            </div>`
          : this._renderMembers(needs, 'Needs input')}

        ${HOME_GROUPS.slice(1).map((g) => {
          const members = byGroup.get(g) ?? [];
          if (members.length === 0) return '';
          return html`
            <h2 class="group">${g} · ${members.length}</h2>
            ${this._renderMembers(members, g)}
          `;
        })}

        ${this.fixture
          ? html`<div class="fixture-note">
              fixture data — FIXTURE_SESSIONS, not a live producer
            </div>`
          : ''}

        <div class="keyhelp">
          <span><kbd>j</kbd>/<kbd>k</kbd> move</span>
          <span><kbd>space</kbd> peek</span>
          <span><kbd>enter</kbd> open pane</span>
          <span><kbd>esc</kbd> dismiss</span>
        </div>
      </div>

      ${this._renderDispatch()}
    `;
  }

  /**
   * The new-session bar.
   *
   * A "task" is not an object in this system -- it is a session's FIRST
   * prompt:submit. So creating one is literally typing that first prompt, and
   * this box is the whole of it.
   *
   * Sticky at the bottom rather than the top for three reasons: it matches the
   * terminal idiom the rest of muxterm lives in; it stays reachable when the
   * list is long; and it keeps "what needs me" as the thing your eye lands on
   * when home opens. The input is for after triage, not before.
   *
   * Two questions and one action, in that order: what to say, where to run it,
   * go. The shortcut hint is spelled with the same <kbd> keycaps the keyhelp
   * strip uses rather than bare arrow glyphs, so the view teaches its keyboard
   * in one voice instead of two.
   */
  private _renderDispatch() {
    const targets = this.workspaces.length ? this.workspaces : [];
    const ready = this._draft.trim().length > 0;
    return html`
      <div class="dispatch">
        <div class="composer">
          <textarea
            class="prompt"
            rows="2"
            autocomplete="off"
            spellcheck="false"
            placeholder="Start a session\u2026"
            aria-label="First prompt for a new session"
            .value="${this._draft}"
            @input="${this._onDraft}"
            @keydown="${this._onComposerKey}"
          ></textarea>
          <div class="crow">
            <select
              class="wsel"
              aria-label="Which coding agent to start"
              .value="${this._harness}"
              @change="${(e: Event) => {
                this._harness = (e.target as HTMLSelectElement)
                  .value as HarnessName;
              }}"
            >
              ${LAUNCHABLE_HARNESSES.map(
                (h) => html`<option value="${h}">${harnessLabel(h)}</option>`,
              )}
            </select>
            <select
              class="wsel"
              aria-label="Workspace to start it in"
              .value="${this._target}"
              @change="${(e: Event) => {
                this._target = (e.target as HTMLSelectElement).value;
              }}"
            >
              <option value="">New workspace</option>
              ${targets.map(
                (w) => html`<option value="${w.id}">${w.name || w.id}</option>`,
              )}
            </select>
            <!-- The chord is ONE keycap, not shift + enter as two: with two,
                 the middot separator read as part of the chord and the line
                 parsed as "start shift enter". -->
            <span class="hint">
              <kbd>enter</kbd> to start · <kbd>shift enter</kbd> for a new line
            </span>
            <button
              class="send"
              type="button"
              aria-label="Start session"
              ?disabled="${!ready}"
              @click="${this._submit}"
            >${icon(ArrowUp, { size: 15 })}</button>
          </div>
        </div>
      </div>
    `;
  }

  private _onDraft = (e: Event): void => {
    const el = e.target as HTMLTextAreaElement;
    this._draft = el.value;
    this._fitPrompt(el);
  };

  /**
   * Grow the composer with its text, the way a chat composer does, up to the
   * CSS max-height. Passing an empty string back through here is what returns
   * the box to its resting two rows -- without it, sending a long prompt left
   * a tall EMPTY composer behind, because the inline height it grew to
   * outlives the value it was measured from.
   */
  private _fitPrompt(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  private _onComposerKey = (e: KeyboardEvent): void => {
    // Stop home's j/k/space/enter navigation from firing while typing.
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._submit();
    }
  };

  private _submit = (): void => {
    const prompt = this._draft.trim();
    if (!prompt) return;
    // cancelable: the handler can refuse this dispatch -- there is no
    // connection to arrange it over, say -- and preventDefault() is how it
    // says so. Clearing the box unconditionally would take the sentence away
    // on exactly the occasions when nothing was started with it, which is
    // when the user most needs it back.
    const accepted = this.dispatchEvent(
      new CustomEvent('home-dispatch', {
        detail: {
          prompt,
          workspaceId: this._target || null,
          harness: this._harness,
        },
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    if (!accepted) return;
    this._draft = '';
    // Lit writes the cleared value on the next update; the inline height has
    // to be re-measured after that, not before.
    void this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector<HTMLTextAreaElement>('.prompt');
      if (el) this._fitPrompt(el);
    });
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-home': MuxHome;
  }
}
