import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
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

import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { store, type MuxStore } from '../state.js';
import { icon } from '../lib/icons.js';
import { Plus, X } from 'lucide';

/** DESIGN.md: U+25CF attention mark in the semantic attention color. */
const BELL_DOT = '●';
/** The current-pane mark in the sheet's fixed 24px check gutter. */
const CHECK_MARK = '✓';

@customElement('mux-pane-picker')
export class MuxPanePicker extends LitElement {
  /** Storybook may supply an isolated session store; the app uses its shared store. */
  @property({ attribute: false }) paneStore: MuxStore = store;
  static styles = css`
    ${subtleScrollbars}
    :host {
      position: relative;
      display: flex;
      align-items: center;
      flex: 1;
      min-width: 0;
      min-height: var(--ui-control-lg);
      justify-content: flex-start;
    }

    /* Narrow-only. At 768px Dockview's wide tabs are visible. */
    @media (min-width: 768px) {
      :host {
        display: none;
      }
    }

    /* Someone who asked for less motion asked for less motion. The sheet
       still opens and closes — instantly. */
    @media (prefers-reduced-motion: reduce) {
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
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:-2px; }

    /* ── the breadcrumb ─────────────────────────────────────────────────── */

    .breadcrumb {
      flex: 1;
      min-width: 0;
      min-height: var(--ui-control-lg);
      display: flex;
      align-items: center;
      gap: var(--ui-space-2);
      padding: 0 var(--ui-space-3);
      border-radius: var(--ui-radius-lg);
      color: var(--ui-text);
      font-size: var(--ui-text-md);
      overflow: hidden;
      white-space: nowrap;
    }

    .breadcrumb:hover,
    .breadcrumb:active {
      background: var(--ui-surface-hover);
    }

    .caret {
      flex: none;
      color: var(--ui-text-muted);
    }

    .pane-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bell-dot {
      flex: none;
      font-size: var(--ui-attention-mark-size);
      color: var(--ui-attention);
    }

    /* ── the sheet ──────────────────────────────────────────────────────── */

    .sheet {
      position: fixed;
      inset: auto 0 0 0;
      width: auto;
      max-width: none;
      margin: 0;
      padding: 0;
      /* NO display in this rule -- it belongs in :popover-open below.
         A closed popover is display: none by UA rule; an unconditional
         author display here OVERRIDES that, so the sheet is never actually
         hidden, only pushed off-screen by translate -- and its box-shadow,
         which paints OUTSIDE the box, stays on the bottom edge of a screen
         with no pane sheet on it. */
      flex-direction: column;
      overflow: hidden;
      max-height: 60dvh;
      background: var(--ui-surface-raised);
      color: var(--ui-text);
      border: 1px solid var(--ui-border);
      border-right: 0;
      border-bottom: 0;
      border-left: 0;
      border-radius: var(--ui-radius-xl) var(--ui-radius-xl) 0 0;
      box-shadow: var(--ui-shadow-sheet);
      translate: 0 100%;
      transition:
        translate var(--ui-motion-fast) ease,
        display var(--ui-motion-fast) allow-discrete,
        overlay var(--ui-motion-fast) allow-discrete;
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
      background: var(--ui-backdrop-sheet);
    }

    /* The pinned block: grab handle, heading, "+ New pane". flex: none, so it
       keeps its height while .pane-list absorbs the rest of the 60dvh — that
       is what makes it genuinely not scroll rather than merely appear not to. */
    .sheet-head {
      flex: none;
      /* A stronger border separates the pinned action from scrollable rows. */
      border-bottom: 2px solid var(--ui-border-strong);
    }

    .grab {
      width: var(--ui-control-md);
      height: var(--ui-space-2);
      border-radius: var(--ui-radius-pill);
      background: var(--ui-text-muted);
      margin: var(--ui-space-4) auto var(--ui-space-1);
    }

    .sheet-title {
      font-family: var(--ui-font-mono);
      font-size: var(--ui-text-xs);
      letter-spacing: 0.11em;
      text-transform: uppercase;
      color: var(--ui-text-muted);
      padding: var(--ui-space-3) var(--ui-space-5) var(--ui-space-2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* "+ New pane" — the shared 56px action row. */
    .rowbtn {
      display: flex;
      align-items: center;
      gap: var(--ui-space-4);
      width: 100%;
      min-height: var(--ui-row-touch);
      padding: 0 var(--ui-space-5);
      font-size: var(--ui-text-md);
      text-align: left;
      background: color-mix(in srgb, var(--ui-accent) 10%, transparent);
      color: var(--ui-accent);
    }

    .rowbtn:hover,
    .rowbtn:active {
      background: color-mix(in srgb, var(--ui-accent) 18%, transparent);
    }

    .rowbtn .lucide-icon {
      color: var(--ui-accent);
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
      padding-bottom: env(safe-area-inset-bottom, 0);
    }

    .pane-row {
      display: grid;
      /* pick | gap | 44x44 close. The gap is real estate, not decoration: a
         thumb aiming at "switch to logs" must not kill it. */
      grid-template-columns: 1fr var(--ui-space-4) var(--ui-control-lg);
      align-items: center;
      min-height: var(--ui-row-touch);
      padding-right: var(--ui-space-3);
      border-bottom: 1px solid var(--ui-border);
    }

    .pane-item {
      min-width: 0;
      min-height: var(--ui-row-touch);
      display: flex;
      align-items: center;
      gap: var(--ui-space-2);
      text-align: left;
      font-size: var(--ui-text-md);
      color: var(--ui-text);
    }

    .pane-item.active { background:color-mix(in srgb,var(--ui-accent) 10%,transparent); }

    .pane-item:hover,
    .pane-item:active {
      background: var(--ui-surface-hover);
    }

    .check {
      flex: none;
      width: var(--ui-space-8);
      text-align: center;
      color: var(--ui-accent);
    }

    .pane-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .row-close {
      width: var(--ui-control-lg);
      height: var(--ui-control-lg);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--ui-radius-lg);
      color: var(--ui-text-muted);
    }

    .row-close:hover,
    .row-close:active {
      color: var(--ui-danger-text);
      background: var(--ui-surface-hover);
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

  private _subscribeStore(): void {
    this._unsubscribe?.();
    this._unsubscribe = this.paneStore.subscribe(() => {
      this._version++;
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._subscribeStore();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (this.isConnected && changed.has('paneStore')) this._subscribeStore();
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
    this.paneStore.ackPane(paneId);
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

    const { panes, activePaneId, attached } = this.paneStore;
    const validPanes = panes.filter((p) => p.paneId >= 0);
    const activePane = validPanes.find((p) => p.paneId === activePaneId) ?? validPanes[0];

    // Active pane display name.
    const activePaneName = activePane?.title ?? (activePane ? `Pane ${activePane.paneId}` : '—');

    const activeBell = activePane ? this.paneStore.paneBellActive(activePane.paneId) : false;

    return html`
      <button
        class="breadcrumb"
        type="button"
        popovertarget="pane-sheet"
        aria-label="Choose pane"
      >
        ${activeBell ? html`<span class="bell-dot">${BELL_DOT}</span>` : ''}
        <span class="pane-name">${activePaneName}</span>
        <span class="caret" aria-hidden="true">▾</span>
      </button>

      <div id="pane-sheet" class="sheet" popover="auto" aria-label="Panes">
        <div class="sheet-head">
          <div class="grab"></div>
          <div class="sheet-title">Panes</div>
          <button class="rowbtn" type="button" @click="${this._createPane}">
            ${icon(Plus, { size: 18 })}<span>New pane</span>
          </button>
        </div>
        <div class="pane-list">
          ${validPanes.map((p) => {
            const isActive = p.paneId === activePane?.paneId;
            const hasBell = this.paneStore.paneBellActive(p.paneId);
            const label = p.title ?? `Pane ${p.paneId}`;
            return html`
              <div class="pane-row">
                <button
                  type="button"
                  class="pane-item ${isActive ? 'active' : ''}"
                  aria-label="Switch to pane ${label}${hasBell ? ', needs attention' : ''}"
                  aria-current=${isActive ? 'true' : nothing}
                  @click="${() => this._selectPane(p.paneId)}"
                >
                  <span class="check" aria-hidden="true">${isActive ? CHECK_MARK : ''}</span>
                  ${hasBell ? html`<span class="bell-dot" aria-hidden="true">${BELL_DOT}</span>` : ''}
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
