/**
 * mux-start-card.ts -- the sidebar's Mission Control card.
 *
 * Sits above the workspace cards. It is the door to Mission Control from
 * anywhere, and it says one thing beyond its own name: whether anything is
 * waiting on you.
 *
 * IT SHOWS NO COUNT. It used to show a 26px number, and the number is gone on
 * purpose: Mission Control shows no counts anywhere -- not sessions, not groups,
 * not messages -- and the sidebar is not allowed to be the one place a number
 * survived. What replaced it is a dot, present or absent.
 *
 * The zero state is designed, not defaulted, and that survives the change:
 * zero is the state the user is trying to reach, so it is the calmest thing on
 * screen -- no dot, no ring, no warm border, nothing animated. Anything that
 * draws the eye at zero teaches the user to stop looking at the card entirely,
 * which costs the whole feature.
 *
 * `count`, `spread` and `split` are still PROPERTIES carrying numbers rather
 * than booleans, because they are the numbers the caller already has and
 * reducing them here keeps every caller (the app sidebar, the drawer, and the
 * two standalone demos) handing over the same thing it always did. Nothing
 * renders them.
 *
 * The per-machine split survives the no-count rule, because it never carried a
 * count worth keeping: what it is for is saying WHICH machine wants you, and
 * distinguishing "nothing waiting there" from "I cannot currently see". A dot,
 * a `?`, or nothing -- the same three states the card itself has.
 *
 * Presentational only -- it is handed a count and reports clicks. It is shared
 * verbatim by the app sidebar and the standalone fixture demo, which is the
 * point: the thing the user previews is the thing that ships.
 */

import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** The needs-input mark. Shared so the card and the badges never diverge. */
export const NEEDS_GLYPH = '✽';

/**
 * RAIL ENTRY OUTER GEOMETRY -- Mission Control's own, exported rather than
 * repeated.
 *
 * This card is the FIRST entry in the sidebar rail, and it is no longer the
 * only one: the rail's "New Session" and "Connect machine" rows are the same
 * kind of thing and are styled by the same rules (railEntryStyles below).
 * Those rows are plain buttons inside <mux-sidebar>'s shadow root, so they
 * cannot inherit this card's `:host` margin -- they have to set it -- and a
 * second hand-typed `8px 9px 5px` in that file is exactly how three rows that
 * are supposed to sit on one set of edges end up on two.
 *
 * TOP is the gap ABOVE the first entry in the rail. EDGE is the side inset.
 * GAP is the space BELOW each entry, and therefore the space BETWEEN stacked
 * entries -- which is why a sibling entry takes `0 EDGE GAP` rather than the
 * card's full `TOP EDGE GAP`, and the stack keeps the rhythm the card already
 * established instead of gaining a top margin per row.
 */
export const RAIL_ENTRY_TOP = '8px';
export const RAIL_ENTRY_EDGE = '9px';
export const RAIL_ENTRY_GAP = '5px';

/**
 * THE RAIL ENTRY'S OWN STYLING -- font, size, weight, height, padding, hover
 * and selected state.
 *
 * Exported because <mux-sidebar> renders sibling entries ("New Session",
 * "Connect machine") that must be indistinguishable from this one. They import
 * this block and use the same class names -- `.start`, `.mc-mark`, `.mc-name`
 * -- so there is ONE definition of what a rail entry looks like and one
 * definition of how it looks when it is the current view (`.here`). A parallel
 * block in the sidebar would be a second answer to the same question.
 *
 * NOT included here, deliberately: `:host` (it means <mux-sidebar> itself in
 * the other shadow root -- see the margin constants above) and the card's
 * legacy `.head`/`.kb`/`.name`/`.dot`/`.lbl`/`.split` rules, which name
 * nothing this card renders any more and nothing a sibling entry has.
 *
 * Rule ORDER inside this block is load-bearing and is preserved verbatim from
 * when it lived inline: the later `.start, .start.zero` block overrides the
 * earlier warn-tinted one, which is why a bare `class="start"` and
 * `class="start zero"` render identically today.
 */
export const railEntryStyles = css`
  .start {
    border: 1px solid var(--mux-warn);
    border-radius: 8px;
    background: color-mix(in srgb, var(--mux-warn) 10%, var(--chrome-bar));
    padding: 9px 10px 8px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    text-align: left;
    width: 100%;
    display: block;
    font: inherit;
    color: inherit;
  }

  .start:hover {
    border-color: var(--mux-warn);
    background: color-mix(in srgb, var(--mux-warn) 16%, var(--chrome-bar));
  }

  /* Home is on screen: "you are here".
     This is LOCATION, not alarm, so it is drawn in --chrome-accent -- the
     same token .ws-card.active uses for the workspace you are in -- and
     OUTSIDE the border, which keeps meaning what it meant (grey = calm,
     warn = needs input). The ring used to be tinted from the card's own
     border/warn colour, and in the zero state that resolved to exactly
     --chrome-border, i.e. the colour already on the card's edge: measured
     rgb(41,46,66) ring on a rgb(31,35,53) fill, ~1.1:1. The selected state
     rendered as nothing at all, while the workspace card below kept the
     bright accent -- so the sidebar said you were in the workspace while
     home was on screen. mux-sidebar demotes that card via
     :host([home-active]) so exactly one thing claims "you are here". */
  .start.here {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--chrome-accent) 55%, transparent);
  }

  /* ── The zero state. Nothing here is warm, bright, or animated. ── */
  .start.zero {
    border-color: var(--chrome-border);
    background: var(--chrome-bar);
  }

  .start.zero:hover {
    background: var(--chrome-hover);
    border-color: var(--chrome-border);
  }

  /* At zero the card's own border is --chrome-border, which barely separates
     it from the panel, so the ring would float off an invisible edge. The
     accent picks the edge up.

     The second selector is not redundant. Alone, .start.zero.here is (0,3,0)
     and ties .start.zero:hover above, so it wins on source order only --
     hovering the card you are already on could silently take the accent
     back. .start.zero.here:hover is (0,4,0) and settles it on specificity
     instead, where a reorder cannot reach it. */
  .start.zero.here,
  .start.zero.here:hover {
    border-color: var(--chrome-accent);
  }

  .start,
  .start.zero {
    box-sizing: border-box;
    height: 36px;
    padding: 0 9px;
    border: 1px solid var(--chrome-border);
    border-radius: 7px;
    background: var(--sidebar-panel, var(--chrome-body));
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .start:hover,
  .start.zero:hover { background: var(--sidebar-hover, var(--chrome-hover)); border-color: var(--sidebar-edge, var(--chrome-border)); }
  .start.here,
  .start.zero.here,
  .start.zero.here:hover {
    border-color: color-mix(in srgb, var(--chrome-accent) 58%, var(--sidebar-edge, var(--chrome-border)));
    background: color-mix(in srgb, var(--chrome-accent) 9%, var(--sidebar-panel, var(--chrome-body)));
    box-shadow: none;
  }
  /* The entry's leading mark. Mission Control's is the ⌘ glyph; a sibling
     entry puts a Lucide icon here instead, and the icon inherits this colour
     because icons.ts draws with stroke="currentColor". */
  .mc-mark { color: var(--chrome-accent); font-weight: 800; }
  /* Font family is inherited -- .start sets font: inherit -- so this is the
     whole of a rail entry's type: 12px / 760. */
  .mc-name { font-size: 12px; font-weight: 760; color: var(--sidebar-bright, var(--chrome-text-bright)); }
  .mc-state {
    margin-left: auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--chrome-accent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--chrome-accent) 9%, transparent);
  }
`;

/**
 * One machine's contribution to the fleet-wide attention.
 *
 * `count: null` is the load-bearing case: it means "this host is not currently
 * connected", and it renders `?`. It does NOT mean zero, and the type refuses
 * to let a caller conflate them. Any other value is reduced to present/absent
 * on the way to the screen -- the number itself is never rendered, here or
 * anywhere else on this card.
 */
export interface StartSplitRow {
  /** Display label for the machine. The local one is named too, here only:
   *  the split is a comparison, and an unlabelled row is not comparable. */
  name: string;
  /** Sessions waiting on a human there, or null if we cannot currently see. */
  count: number | null;
}

@customElement('mux-start-card')
export class MuxStartCard extends LitElement {
  /** Sessions waiting on a human. MUST be needsInputCount() over the same set
   *  the workspace badges are derived from — see mux-sidebar. */
  @property({ type: Number }) count = 0;

  /** How many workspaces contribute to `count`. Only shown when > 0. */
  @property({ type: Number }) spread = 0;

  /** True when Mission Control is the thing currently on screen. */
  @property({ type: Boolean }) active = false;

  /** Key chord shown in the corner, e.g. "ctrl+`". Empty hides the chip. */
  @property({ type: String }) hint = '';

  /**
   * Per-machine split of `count` (ux D5). EMPTY BY DEFAULT, and an empty split
   * renders nothing at all -- which is what makes a browser with no remotes see
   * exactly today's card, down to the last marker comment (see render()).
   *
   * `count` above stays the total over the whole union, not the sum of the rows
   * below: a host that just connected contributes to the headline immediately,
   * and a host that just dropped keeps contributing whatever it last reported.
   * The split is where the uncertainty is spoken, not the number.
   */
  @property({ attribute: false }) split: StartSplitRow[] = [];

  /**
   * [railEntryStyles, then this card's own leftovers.]
   *
   * The rail-entry rules -- `.start`, `.mc-mark`, `.mc-name`, `.mc-state` --
   * moved verbatim into the exported block at the top of this file so the
   * sidebar's sibling entries share them. Everything below names an element
   * this card no longer renders (`.head`, `.kb`, `.name`, `.dot`, `.lbl`,
   * `.split`, `.splitrow`); it is left in place, in its original relative
   * order, rather than swept up in a change about a button.
   *
   * Cascade is unchanged: the only rules here that mention `.start` are
   * DESCENDANT selectors (`.start.zero .head`, `.start.zero .split`) whose
   * subjects are `.head` and `.split`, so they neither compete with nor are
   * competed with by anything in railEntryStyles.
   */
  static styles = [
    railEntryStyles,
    css`
    :host {
      display: block;
      margin: ${unsafeCSS(RAIL_ENTRY_TOP)} ${unsafeCSS(RAIL_ENTRY_EDGE)} ${unsafeCSS(RAIL_ENTRY_GAP)};
    }

    .head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 9px;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--mux-warn);
    }

    .start.zero .head {
      color: var(--chrome-text-dim);
    }

    /* The keycap hint is how the shortcut gets learned, so it has to be
       readable. At 8.5px a backtick is a two-pixel tick and the chip reads as
       an empty box -- caught in a screenshot review, not by any check. */
    .kb {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10.5px;
      line-height: 1.3;
      letter-spacing: 0;
      text-transform: none;
      color: var(--chrome-text-dim);
      border: 1px solid var(--sidebar-edge, var(--chrome-border));
      border-radius: 3px;
      padding: 0 5px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* The card's own name. It replaced a 26px count, and it is deliberately
       the size of a label rather than a headline: this is a door, and a door
       does not need to shout to be found. */
    .name {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 14px;
      font-weight: 600;
      line-height: 1.3;
      margin-top: 2px;
      color: var(--chrome-text-bright);
    }

    /* The one signal left. Present or absent, never a number, never a zero.
       --mux-warn is the same token the group heading, the workspace badge and
       the nav bar's dot use, so the four cannot say different things. */
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--mux-warn);
      flex-shrink: 0;
    }

    .lbl {
      font-size: 11px;
      color: var(--chrome-text-dim);
      margin-top: 1px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── The fleet split (ux D5) ─────────────────────────────────────────────
       Present only when there is more than one machine to report on, so a
       single-machine user never sees a row that says the number twice. */
    .split {
      margin-top: 4px;
      padding-top: 5px;
      border-top: 1px solid color-mix(in srgb, var(--mux-warn) 22%, transparent);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .start.zero .split {
      border-top-color: var(--chrome-border);
    }
    .splitrow {
      display: flex;
      align-items: center;
      gap: 5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 9.5px;
      color: var(--chrome-text-dim);
    }
    .splitrow .nm {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* The per-machine signal, and it obeys the same rule as the card above:
       present or absent, never a number. Smaller than the card's own dot
       because it is subordinate to it -- the card says "someone wants you",
       the row says "it is that one". */
    .splitrow .dot {
      width: 5px;
      height: 5px;
    }
    /* A machine we cannot see. Its "?" is deliberately the DIM colour, not the
       warn colour: an unknown is not an alarm, and colouring it like a signal
       would make a disconnected host look like work waiting. It is the only
       glyph left in the split, and it is not a count. */
    .splitrow .mk {
      font-weight: 600;
      color: var(--chrome-text-dim);
      flex-shrink: 0;
    }
  `,
  ];

  private _onClick(): void {
    this.dispatchEvent(new CustomEvent('start-click', { bubbles: true, composed: true }));
  }

  override render() {
    const zero = this.count === 0;
    const need = zero ? 'Nothing needs input.' : 'Sessions need input.';
    const cls = `start ${zero ? 'zero' : ''} ${this.active ? 'here' : ''}`;
    return html`
      <button
        type="button"
        class="${cls}"
        title="Mission Control${this.hint ? ` · ${this.hint}` : ''}"
        aria-label="${this.active ? `${need} Mission Control, current view.` : `${need} Go to Mission Control.`}"
        aria-current="${this.active ? 'page' : 'false'}"
        @click="${this._onClick}"
      >
        <span class="mc-mark">⌘</span>
        <span class="mc-name">Mission Control</span>
        ${zero ? '' : html`<span class="mc-state" aria-hidden="true"></span>`}
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-start-card': MuxStartCard;
  }
}
