import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { icon } from '../lib/icons.js';
import { Info, Keyboard, Monitor, Plus, RefreshCw } from 'lucide';

export type LauncherAction =
  | 'settings'
  | 'shortcuts'
  | 'reconnect'
  | 'about'
  | 'connect-machine'
  | 'new-workspace';

@customElement('mux-launcher-menu')
export class MuxLauncherMenu extends LitElement {
  static styles = css`
    ${subtleScrollbars}
    :host {
      --edge: color-mix(in srgb, var(--ui-border) 40%, var(--ui-text-muted));
      --row-h: var(--ui-row-touch);
      --sheet-dur: 120ms;

      display: block;
      background: var(--ui-surface-raised);
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius-md);
      box-shadow: var(--ui-shadow-menu);
      padding: var(--ui-space-2);
      min-width: 180px;
    }

    .divider {
      height: 1px;
      background: var(--ui-border);
      margin: var(--ui-space-2) 0;
    }

    button {
      display: flex;
      align-items: center;
      gap: var(--ui-space-4);
      width: 100%;
      padding: var(--ui-space-3) var(--ui-space-5);
      background: transparent;
      border: none;
      border-radius: var(--ui-radius-sm);
      color: var(--ui-text);
      font-size: var(--ui-text-md);
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      box-sizing: border-box;
    }

    button:hover {
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

    /* ── Surface 3: the same menu as a bottom sheet ─────────────────────────
       Set by the narrow-mode nav bar. A 6px/12px pad is ~26px tall,
       which is below the touch floor IN A MOBILE BAR; at 56px in a sheet the
       problem disappears. Same chrome as the pane sheet, so the two surfaces
       the bar opens read as one family.
       ──────────────────────────────────────────────────────────────────── */

    :host([sheet]) {
      position: fixed;
      inset: auto 0 0 0;
      width: auto;
      max-width: none;
      min-width: 0;
      max-height: 60dvh;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      margin: 0;
      padding: 0 0 env(safe-area-inset-bottom, 0px);
      border-right: 0;
      border-bottom: 0;
      border-left: 0;
      border-radius: var(--ui-radius-xl) var(--ui-radius-xl) 0 0;
      box-shadow: var(--ui-shadow-sheet);
      translate: 0 100%;
      transition:
        translate var(--sheet-dur) ease,
        display var(--sheet-dur) allow-discrete,
        overlay var(--sheet-dur) allow-discrete;
    }

    /* A closed popover is display: none by UA rule, but the display: block
       on :host above -- which the ANCHORED dropdown form of this menu needs --
       overrides it. Without this the closed sheet stays laid out, hidden only
       by translate, and its box-shadow (which paints OUTSIDE the box) keeps
       sitting on the bottom edge of a screen with no sheet on it. Scoped to
       [sheet] so the dropdown form is untouched; the display ... allow-discrete
       transition above still defers the flip until the slide-out has finished. */
    :host([sheet]:not(:popover-open)) {
      display: none;
    }

    :host([sheet]:popover-open) {
      translate: 0 0;
    }

    @starting-style {
      :host([sheet]:popover-open) {
        translate: 0 100%;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      :host([sheet]) {
        --sheet-dur: 0ms;
        transition: none;
      }
    }

    :host([sheet]) .grab {
      width: 36px;
      height: 4px;
      border-radius: 2px;
      background: var(--ui-text-muted);
      margin: 8px auto;
    }

    :host([sheet]) button {
      min-height: var(--row-h);
      padding: 0 12px;
      border-radius: 0;
      border-bottom: 1px solid var(--ui-border);
    }

    :host([sheet]) button:last-of-type {
      border-bottom: 0;
    }

    /* The one divider the menu keeps in sheet mode is the scroll-edge weight
       the pane sheet uses, so the two surfaces separate their groups the same
       way round. */
    :host([sheet]) .divider {
      height: 2px;
      background: var(--edge);
      margin: 0;
    }
  `;

  /**
   * Gated by the caller: <mux-title-bar> (narrow mode) sets this to `true` so
   * mobile users have a reachable "New workspace" action. <mux-sidebar>
   * (wide mode) leaves it at the default `false` — it already has its own
   * always-visible "+ New workspace" button, so surfacing it here too would
   * be a duplicate leaking into desktop.
   */
  @property({ type: Boolean })
  showCreateWorkspace = false;

  /**
   * Render as a bottom sheet instead of a dropdown. Reflected, because the
   * geometry above is selected with `:host([sheet])`.
   *
   * The CALLER decides, not a media query: the same element is a dropdown
   * anchored under the sidebar header on desktop and a sheet anchored to the
   * bottom of the viewport on a phone, and only the container knows which
   * box it is in.
   */
  @property({ type: Boolean, reflect: true })
  sheet = false;

  private _dispatch(action: LauncherAction): void {
    this.dispatchEvent(
      new CustomEvent('launcher-action', {
        bubbles: true,
        composed: true,
        detail: { action },
      }),
    );
  }

  render() {
    return html`
      ${this.sheet ? html`<div class="grab"></div>` : ''}
      ${this.showCreateWorkspace
        ? html`
            <button
              data-action="new-workspace"
              @click="${() => this._dispatch('new-workspace')}"
            >
              ${icon(Plus, { size: 14 })} New workspace
            </button>
            <div class="divider"></div>
          `
        : ''}
      <button data-action="connect-machine" @click="${() => this._dispatch('connect-machine')}">
        ${icon(Monitor, { size: 14 })} Connect machine
      </button>
      <button data-action="shortcuts" @click="${() => this._dispatch('shortcuts')}">
        ${icon(Keyboard, { size: 14 })} Keyboard Shortcuts
      </button>
      <button data-action="reconnect" @click="${() => this._dispatch('reconnect')}">
        ${icon(RefreshCw, { size: 14 })} Reconnect
      </button>
      <div class="divider"></div>
      <button data-action="about" @click="${() => this._dispatch('about')}">
        ${icon(Info, { size: 14 })} About
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-launcher-menu': MuxLauncherMenu;
  }
}
