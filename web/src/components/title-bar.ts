/**
 * title-bar.ts -- the NARROW-mode nav bar.
 *
 * TWO SHAPES, because the bar now serves two surfaces.
 *
 * Over a PANE it is what it always was: the drawer button, the brand, the
 * pane breadcrumb, the mic, and the launcher.
 *
 * Over the DASHBOARD it says only where you are and what it can open:
 *
 *     [drawer]  Dashboard                        [fleet]  [launcher]
 *
 * Three things are ABSENT in that second shape, each on purpose. The brand:
 * the Dashboard is a place, and a place gets a name, not a logo. The pane
 * breadcrumb: there is no pane under the Dashboard to be a crumb of. The mic:
 * voice moved down beside the composer, where the thumb already is and where
 * the words it produces are going to land -- dictating from the top of the
 * screen into a box at the bottom of it was always a guess about intent.
 *
 * THE BADGES ARE DOTS, not numbers. The Dashboard shows no counts anywhere,
 * and a bar that still counted would be the one place a number survived --
 * which is worse than either choice made consistently. A dot answers the only
 * question a closed drawer or an unopened sheet can be asked: is there
 * something behind you that wants you.
 *
 * Surface geometry from docs/designs/2026-09-05-mobile-navigation-design.md:
 * the bar is at the TOP because that is where you look, and everything it
 * opens renders at the BOTTOM because that is where a thumb can reach.
 *
 * The fleet sheet itself lives in <mux-cos>'s shadow root, so `popovertarget`
 * cannot reach it from here -- the attribute resolves ids within the
 * INVOKER's root, the same wall the workspace drawer runs into. The intent
 * goes up as `fleet-toggle` and app.ts calls the method; everything the
 * Popover API provides is unaffected by which side asks.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import './launcher-menu.js';
import './mux-pane-picker.js';
import './mic-button.js';
import './mux-start-card.js';
import { icon } from '../lib/icons.js';
import { Ellipsis, LayoutGrid, Menu } from 'lucide';
import { instanceLabel } from '../lib/instance-identity.js';
import { homeSessions } from '../lib/home-sessions.js';
import { needsInputCount } from '../lib/session-state.js';

@customElement('mux-title-bar')
export class MuxTitleBar extends LitElement {
  static styles = css`
    :host {
      --scrim: color-mix(in srgb, var(--chrome-body) 62%, transparent);
      --nav-h: var(--mux-dock-height, 44px);

      display: flex;
      align-items: center;
      gap: 2px;
      background: var(--mux-titlebar-bg, var(--chrome-bar));
      border-bottom: 1px solid var(--chrome-border);
      /* D9. viewport-fit=cover has been set for as long as index.html has had
         a viewport meta and env(safe-area-inset-*) appeared in zero files; on
         a notched phone in landscape this bar started under the notch. The
         height GROWS by the inset rather than eating into the 44px row, so
         every target in here keeps its full touch size. */
      height: calc(var(--nav-h) + env(safe-area-inset-top, 0px));
      padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) 0
        env(safe-area-inset-left, 0px);
      box-sizing: border-box;
      flex-shrink: 0;
      user-select: none;
      position: relative;
      /* Structure ready for env(titlebar-area-*) WCO — apply here when needed */
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      /* Yields to the breadcrumb: on a 360px screen the pane name is the
         thing you navigate with and the host name is the thing you already
         know. */
      flex: 0 1 auto;
      overflow: hidden;
      color: var(--chrome-text-bright);
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
    }

    .brand > span {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--chrome-accent);
      flex-shrink: 0;
    }

    .brand-sha {
      font-size: 10px;
      font-weight: 400;
      font-family: monospace;
      color: var(--chrome-text-dim);
      letter-spacing: 0;
    }

    /* The + button left this bar so the breadcrumb could have its width back.
       Measured at 390px, .brand was taking 130px against the breadcrumb's 117
       and handing the win straight back: flex: 0 1 auto shrinks, but its basis
       is its content, so a long host name still outbids the one control in
       the bar you actually navigate with. Cap it, and drop the build sha --
       on a phone that is a dev detail, and the launcher's About still has it. */
    @media (max-width: 480px) {
      .brand {
        max-width: 33%;
      }

      .brand-sha {
        display: none;
      }
    }

    .right {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: none;
      position: relative;
    }

    .launcher-btn,
    .drawer-btn,
    .fleet-btn {
      position: relative;
      width: var(--nav-h);
      height: var(--nav-h);
      flex: none;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--chrome-text-bright);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-family: inherit;
    }

    .launcher-btn:hover,
    .drawer-btn:hover,
    .fleet-btn:hover {
      background: var(--chrome-hover);
    }

    /* D4, restated as a DOT. It used to be a count; the Dashboard shows no
       counts anywhere, and one surviving number in the nav bar would be
       worse than either choice made consistently. At zero it is ABSENT,
       never a grey dot: mux-start-card.ts's own zero-state rule, applied to
       the bar. */
    .needs-dot {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--mux-warn);
      pointer-events: none;
    }

    /* The Dashboard's own title. Takes the space the brand and the
       breadcrumb between them used to, because on this surface neither has
       anything to say. */
    .title {
      flex: 1;
      min-width: 0;
      font-size: 13.5px;
      font-weight: 600;
      line-height: 1;
      color: var(--chrome-text-bright);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0 6px;
    }

    .fleet-btn[aria-expanded='true'] {
      background: var(--chrome-hover);
    }

    /* The launcher sheet's scrim. ::backdrop belongs to the popover element,
       which lives in THIS root, so the rule does too. A tint rather than a
       blackout, matching the pane sheet. */
    mux-launcher-menu::backdrop {
      background: var(--scrim);
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

  /**
   * True while the workspace drawer is open. Owned by <mux-app> (the drawer
   * is its <mux-sidebar>); this element only reports it as `aria-expanded`.
   */
  @property({ type: Boolean }) drawerOpen = false;

  /**
   * True while the Dashboard is the thing on screen. Owned by <mux-app>,
   * which owns the overlay; this element only changes shape for it.
   */
  @property({ type: Boolean }) dashboardActive = false;

  /**
   * True while the Dashboard's fleet sheet is open. Mirrored from the
   * popover's own toggle event by app.ts rather than set by whatever asked
   * it to open, so light dismiss and Escape -- which no handler of ours ever
   * sees -- cannot leave the button out of step with what is on screen.
   */
  @property({ type: Boolean }) fleetOpen = false;

  /** Bumped when the session list changes, so the badge re-derives. */
  @state() private _sessionVersion = 0;

  private _unsubSessions: (() => void) | null = null;

  /** Bound handler so we can remove it in disconnectedCallback. */
  private _onOpenLauncher = (): void => {
    const menu = this.shadowRoot?.querySelector<HTMLElement>('mux-launcher-menu');
    try {
      menu?.showPopover();
    } catch {
      /* already open */
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('open-launcher', this._onOpenLauncher);
    // Same source the Start card counts from — see _needsCount.
    this._unsubSessions = homeSessions.subscribe(() => {
      this._sessionVersion++;
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('open-launcher', this._onOpenLauncher);
    this._unsubSessions?.();
    this._unsubSessions = null;
  }

  /**
   * The launcher sheet is a popover, so open/close is the browser's business
   * now (light dismiss, Escape, one-at-a-time, focus). The host attribute E2E
   * selectors key on is kept in sync from the popover's own toggle event
   * rather than from a component flag, which would only be a second copy of a
   * truth the browser already holds.
   */
  private _onLauncherToggle(e: Event): void {
    this.toggleAttribute('data-launcher-open', (e as ToggleEvent).newState === 'open');
  }

  /**
   * Whether anything is waiting on a human.
   *
   * Derived from needsInputCount() over homeSessions -- the same call, over
   * the same list, that <mux-start-card> is handed in mux-sidebar -- and then
   * reduced to a BOOLEAN, because the bar draws a dot and a dot has only two
   * states. Deriving it here from the one source rather than being passed a
   * number keeps this indicator and the Dashboard card incapable of
   * disagreeing about what "needs input" means.
   */
  private get _needs(): boolean {
    void this._sessionVersion;
    return needsInputCount(homeSessions.sessions) > 0;
  }

  private _closeLauncher(): void {
    const menu = this.shadowRoot?.querySelector<HTMLElement>('mux-launcher-menu');
    try {
      menu?.hidePopover();
    } catch {
      /* already closed */
    }
  }

  private _onLauncherAction(e: Event): void {
    // Stop the original event from propagating further out of our shadow root
    e.stopPropagation();
    this._closeLauncher();
    // Re-dispatch the event upward (bubbles, composed)
    const customEvent = e as CustomEvent;
    this.dispatchEvent(
      new CustomEvent('launcher-action', {
        bubbles: true,
        composed: true,
        detail: customEvent.detail,
      }),
    );
  }

  /**
   * The drawer is <mux-sidebar> inside a popover in <mux-app>'s shadow root,
   * so `popovertarget` cannot reach it from here — the attribute resolves ids
   * within the INVOKER's root. The intent goes up instead and app.ts calls
   * togglePopover(); everything the Popover API provides (top layer, light
   * dismiss, Escape, focus) is unaffected by which side calls it.
   */
  private _toggleDrawer(): void {
    this.dispatchEvent(
      new CustomEvent('drawer-toggle', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * "Show me the fleet." The sheet is <mux-cos>'s, in its shadow root, so
   * this reports the intent and app.ts calls the method on the element --
   * exactly the arrangement the workspace drawer already uses, and for the
   * same cross-root reason.
   */
  private _toggleFleet(): void {
    this.dispatchEvent(
      new CustomEvent('fleet-toggle', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const needs = this._needs;

    return html`
      <button
        class="drawer-btn"
        type="button"
        title="Workspaces"
        aria-label="${needs
          ? 'Sessions need input. Open workspaces.'
          : 'Open workspaces'}"
        aria-expanded="${this.drawerOpen ? 'true' : 'false'}"
        @click="${this._toggleDrawer}"
      >
        ${icon(Menu, { size: 20 })}
        ${needs ? html`<span class="needs-dot"></span>` : ''}
      </button>
      ${this.dashboardActive
        ? html`<span class="title">Dashboard</span>`
        : html`
            <div class="brand">
              <span class="brand-dot"></span>
              <span title="${window.location.hostname}">${instanceLabel()}</span>
              <span class="brand-sha">${__GIT_SHA__}</span>
            </div>
            <mux-pane-picker></mux-pane-picker>
          `}
      <div class="right">
        ${this.dashboardActive
          ? html`<button
              class="fleet-btn"
              type="button"
              title="Fleet"
              aria-label="${needs ? 'Sessions need input. Show the fleet.' : 'Show the fleet'}"
              aria-expanded="${this.fleetOpen ? 'true' : 'false'}"
              @click="${this._toggleFleet}"
            >
              ${icon(LayoutGrid, { size: 18 })}
              ${needs ? html`<span class="needs-dot"></span>` : ''}
            </button>`
          : html`<mux-mic-button></mux-mic-button>`}
        <button
          class="launcher-btn"
          type="button"
          title="Open menu"
          popovertarget="launcher-sheet"
        >${icon(Ellipsis, { size: 16 })}</button>
      </div>
      <mux-launcher-menu
        id="launcher-sheet"
        popover="auto"
        sheet
        .showCreateWorkspace="${true}"
        @toggle="${this._onLauncherToggle}"
        @launcher-action="${this._onLauncherAction}"
      ></mux-launcher-menu>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-title-bar': MuxTitleBar;
  }
}
