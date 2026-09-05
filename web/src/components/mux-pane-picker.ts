/**
 * mux-pane-picker.ts — the narrow-mode breadcrumb, and the PANE SHEET it opens.
 *
 * Surface 2 of docs/designs/2026-09-05-mobile-navigation-design.md.
 *
 * What changed from the dropdown this replaces:
 *
 *   - Workspaces are GONE from here. They live in the drawer now (Surface 1).
 *     One flat unscrollable list was doing two different jobs; splitting them
 *     is what makes both legible.
 *   - It is a bottom sheet, not a top-anchored dropdown. The bar is at the top
 *     because that is where you look; the list is at the bottom because that
 *     is where a thumb can reach.
 *   - `max-height: 60dvh` with the list scrolling INSIDE it. The dropdown had
 *     no max-height and no scroll container, which is the bug that hid the
 *     last pane once you had five of them.
 *   - `+ New pane` moved out of the title bar and became the FIRST row, pinned
 *     outside the scroller so its position never depends on the pane count or
 *     the scroll offset.
 *
 * Native Popover API (D1): top layer, light dismiss, Escape, focus management
 * and one-at-a-time, none of it hand-rolled. The trigger and the sheet are in
 * the same shadow root, so `popovertarget` resolves and no open/close state is
 * kept here at all.
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { workspaceLabel } from '../lib/workspace-label.js';
import { icon } from '../lib/icons.js';
import { Plus, X } from 'lucide';

/** DESIGN.md: U+25CF, prepended to a label with a 4px gap, in --mux-bell. */
const BELL_DOT = '●';
/** The current-pane mark in the sheet's fixed 24px check gutter. */
const CHECK_MARK = '✓';

@customElement('mux-pane-picker')
export class MuxPanePicker extends LitElement {
  static styles = css`
    :host {
      /* Derived, never invented. --edge is deliberately a heavier mix than
         --chrome-border: the scroll edge has to out-weigh the hairline
         between two rows, and two steps of difference is what makes it read
         at a glance. --scrim is a TINT, not a blackout — the terminal behind
         a non-modal surface stays visibly alive. */
      --edge: color-mix(in srgb, var(--chrome-border) 40%, var(--chrome-text-dim));
      --scrim: color-mix(in srgb, var(--chrome-body) 62%, transparent);
      /* The nav-bar/icon-button floor, and the list-row height. 56 rather
         than 44 for rows: 44 is the floor for a target you AIM at, and this
         is a list you scan and stab at while walking. */
      --nav-h: 44px;
      --row-h: 56px;
      --sheet-dur: 120ms;

      position: relative;
      display: flex;
      align-items: center;
      flex: 1;
      min-width: 0;
      min-height: var(--nav-h);
      justify-content: flex-start;
    }

    /* Narrow-only. Wide mode has the dockview tab strip and the sidebar; this
       exists precisely because mux-dock hides its tabs below 769px. */
    @media (min-width: 769px) {
      :host {
        display: none;
      }
    }

    /* Someone who asked for less motion asked for less motion. The sheet
       still opens and closes — instantly. */
    @media (prefers-reduced-motion: reduce) {
      :host {
        --sheet-dur: 0ms;
      }

      .sheet {
        transition: none;
      }
    }

    button {
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
      padding: 0;
    }

    /* ── the breadcrumb ─────────────────────────────────────────────────── */

    .breadcrumb {
      flex: 1;
      min-width: 0;
      min-height: var(--nav-h);
      display: flex;
      align-items: center;
      gap: 4px; /* DESIGN.md: 4px between the bell dot and its label */
      padding: 0 6px;
      border-radius: 8px;
      color: var(--chrome-text-bright);
      font-size: 0.85rem;
      overflow: hidden;
      white-space: nowrap;
    }

    .breadcrumb:hover,
    .breadcrumb:active {
      background: var(--chrome-hover);
    }

    .ws-name,
    .sep,
    .caret {
      flex: none;
      color: var(--chrome-text-dim);
    }

    .ws-name {
      max-width: 40%;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pane-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bell-dot {
      flex: none;
      font-size: 9px;
      color: var(--mux-bell);
    }

    /* ── the sheet ──────────────────────────────────────────────────────── */

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
      max-height: 60dvh;
      background: var(--chrome-bar);
      color: var(--chrome-text-bright);
      border: 1px solid var(--chrome-border);
      border-right: 0;
      border-bottom: 0;
      border-left: 0;
      border-radius: 16px 16px 0 0;
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.4);
      translate: 0 100%;
      transition:
        translate var(--sheet-dur) ease,
        display var(--sheet-dur) allow-discrete,
        overlay var(--sheet-dur) allow-discrete;
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

    /* The pinned block: grab handle, heading, "+ New pane". flex: none, so it
       keeps its height while .pane-list absorbs the rest of the 60dvh — that
       is what makes it genuinely not scroll rather than merely appear not to. */
    .sheet-head {
      flex: none;
      /* THE SCROLL EDGE. 2px of --edge against the 1px --chrome-border
         hairline between two rows, so the boundary reads without waiting for
         motion to reveal it. */
      border-bottom: 2px solid var(--edge);
    }

    .grab {
      width: 36px;
      height: 4px;
      border-radius: 2px;
      background: var(--chrome-text-dim);
      margin: 8px auto 2px;
    }

    .sheet-title {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      letter-spacing: 0.11em;
      text-transform: uppercase;
      color: var(--chrome-text-dim);
      padding: 6px 12px 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* "+ New pane" — the shared 56px action row. */
    .rowbtn {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: var(--row-h);
      padding: 0 12px;
      font-size: 13px;
      text-align: left;
      background: color-mix(in srgb, var(--chrome-accent) 10%, transparent);
      color: var(--chrome-accent);
    }

    .rowbtn:hover,
    .rowbtn:active {
      background: color-mix(in srgb, var(--chrome-accent) 18%, transparent);
    }

    .rowbtn .lucide-icon {
      color: var(--chrome-accent);
    }

    .pane-list {
      flex: 1;
      /* Load-bearing. Without min-height: 0 a flex item refuses to shrink
         below its content, the sheet grows past its own max-height, and the
         bounded height this surface exists to provide silently does not
         happen. */
      min-height: 0;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      /* D9, on the SCROLLER rather than the sheet: the inset is the strip a
         thumb cannot reach, so the last row has to scroll up clear of the
         home indicator instead of resting under it — and the pinned block
         must not be shoved up by a notch it does not touch. */
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }

    .pane-row {
      display: grid;
      /* pick | gap | 44x44 close. The gap is real estate, not decoration: a
         thumb aiming at "switch to logs" must not kill it. */
      grid-template-columns: 1fr 8px var(--nav-h);
      align-items: center;
      min-height: var(--row-h);
      padding-right: 6px;
      border-bottom: 1px solid var(--chrome-border);
    }

    .pane-item {
      min-width: 0;
      min-height: var(--row-h);
      display: flex;
      align-items: center;
      gap: 4px;
      text-align: left;
      font-size: 13px;
      color: var(--chrome-text-bright);
    }

    .pane-item:hover,
    .pane-item:active {
      background: var(--chrome-hover);
    }

    .check {
      flex: none;
      width: 24px; /* the fixed 24px check gutter */
      text-align: center;
      color: var(--chrome-accent);
    }

    .pane-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .row-close {
      width: var(--nav-h);
      height: var(--nav-h);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      color: var(--chrome-text-dim);
    }

    .row-close:hover,
    .row-close:active {
      color: var(--chrome-danger);
      background: var(--chrome-hover);
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }

    button .lucide-icon {
      pointer-events: none;
    }
  `;

  @state() private _version = 0;

  private _unsubscribe: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._unsubscribe = store.subscribe(() => {
      this._version++;
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  /** Dismiss the sheet after an action that changes what is on screen. */
  private _closeSheet(): void {
    const sheet = this.shadowRoot?.querySelector<HTMLElement>('.sheet');
    // hidePopover() throws if the popover is already closed; a picked row can
    // arrive via keyboard on an already-dismissed sheet.
    try {
      sheet?.hidePopover();
    } catch {
      /* already closed */
    }
  }

  private _selectPane(paneId: number): void {
    this._closeSheet();
    store.ackPane(paneId);
    this.dispatchEvent(
      new CustomEvent('pane-select', {
        detail: { paneId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _closePane(e: Event, workspaceId: string | null, paneId: number): void {
    e.stopPropagation();
    if (!workspaceId) return;
    this._closeSheet();
    this.dispatchEvent(
      new CustomEvent('pane-close', {
        detail: { workspaceId, paneId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * The same intent the title bar's `+` used to emit, from the place the
   * design moved it to: "show me the panes" and "make another one" are the
   * same errand, so the control lives next to the list it creates into.
   */
  private _createPane(): void {
    this._closeSheet();
    this.dispatchEvent(
      new CustomEvent('pane-create-request', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    // Suppress unused-variable lint — _version is read to create a reactive
    // dependency so store subscription bumps trigger re-renders.
    void this._version;

    const { panes, activePaneId, workspaces, attached } = store;
    const validPanes = panes.filter((p) => p.paneId >= 0);
    const activePane = validPanes.find((p) => p.paneId === activePaneId);

    // Workspace label: prefer named workspace, fall back to attached id.
    const ws = workspaces.find((w) => w.workspaceId === attached);
    const wsName = ws ? workspaceLabel(ws) : (attached ?? '');

    // Active pane display name.
    const activePaneName =
      activePane?.title ?? (activePaneId >= 0 ? `Pane ${activePaneId}` : '—');

    const activeBell = activePaneId >= 0 && store.paneBellActive(activePaneId);

    return html`
      <button
        class="breadcrumb"
        type="button"
        popovertarget="pane-sheet"
        aria-label="Panes in ${wsName}"
      >
        <span class="ws-name">${wsName}</span>
        <span class="sep">›</span>
        ${activeBell ? html`<span class="bell-dot">${BELL_DOT}</span>` : ''}
        <span class="pane-name">${activePaneName}</span>
        <span class="caret">▾</span>
      </button>

      <div id="pane-sheet" class="sheet" popover="auto" aria-label="Panes in ${wsName}">
        <div class="sheet-head">
          <div class="grab"></div>
          <div class="sheet-title">Panes · ${wsName}</div>
          <button class="rowbtn" type="button" @click="${this._createPane}">
            ${icon(Plus, { size: 18 })}<span>New pane</span>
          </button>
        </div>
        <div class="pane-list">
          ${validPanes.map((p) => {
            const isActive = p.paneId === activePaneId;
            const hasBell = store.paneBellActive(p.paneId);
            const label = p.title ?? `Pane ${p.paneId}`;
            return html`
              <div class="pane-row">
                <button
                  type="button"
                  class="pane-item ${isActive ? 'active' : ''}"
                  aria-label="Switch to pane ${label}"
                  @click="${() => this._selectPane(p.paneId)}"
                >
                  <span class="check">${isActive ? CHECK_MARK : ''}</span>
                  ${hasBell ? html`<span class="bell-dot">${BELL_DOT}</span>` : ''}
                  <span class="pane-label">${label}</span>
                </button>
                <span></span>
                <button
                  type="button"
                  class="row-close pane-close"
                  aria-label="Close pane ${label}"
                  title="Close pane"
                  @click="${(e: Event) => this._closePane(e, attached, p.paneId)}"
                >${icon(X, { size: 16 })}</button>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-pane-picker': MuxPanePicker;
  }
}
