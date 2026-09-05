/**
 * title-bar.ts — the NARROW-mode nav bar.
 *
 *     ☰³    ● muxterm    project › ●build ▾    🎤    ⋯
 *     │                  │                     │     │
 *     │                  │                     │     └── launcher, as a SHEET
 *     │                  │                     └──────── mic (unchanged)
 *     │                  └────────────────────────────── pane sheet
 *     └───────────────────────────────────────────────── workspace drawer
 *
 * Surface geometry from docs/designs/2026-09-05-mobile-navigation-design.md:
 * the bar is at the TOP because that is where you look, and everything it
 * opens renders at the BOTTOM because that is where a thumb can reach.
 *
 * Two things left this bar:
 *
 *   `+` new pane   → the pane sheet's first pinned row. "Show me the panes"
 *                    and "make another one" are the same errand, and moving
 *                    it buys back the width the breadcrumb needs.
 *   the launcher   → a bottom sheet with 56px rows. Its buttons were
 *                    `padding: 6px 10px` ≈ 26px, below the touch floor.
 *
 * One thing arrived: the hamburger, carrying the needs-input badge (D4). On
 * desktop the Start card's count is always visible in the sidebar; behind a
 * closed drawer it is not, so the count comes out to the bar. The drawer
 * itself lives in <mux-app> (it is <mux-sidebar> in a different container),
 * so the hamburger reports the intent and app.ts owns the popover.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import './launcher-menu.js';
import './mux-pane-picker.js';
import './mic-button.js';
import './mux-start-card.js';
import { NEEDS_GLYPH } from './mux-start-card.js';
import { icon } from '../lib/icons.js';
import { Ellipsis, Menu } from 'lucide';
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
    .drawer-btn {
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
    .drawer-btn:hover {
      background: var(--chrome-hover);
    }

    /* D4 — the one piece of genuinely new visual design in the nav.
       At zero it is ABSENT, never a grey zero: mux-start-card.ts's own
       zero-state rule, applied to the bar. */
    .needs-badge {
      position: absolute;
      top: 3px;
      right: 1px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      line-height: 1.3;
      color: var(--mux-warn);
      background: color-mix(in srgb, var(--mux-warn) 16%, var(--chrome-bar));
      border: 1px solid color-mix(in srgb, var(--mux-warn) 45%, transparent);
      border-radius: 3px;
      padding: 0 2px;
      pointer-events: none;
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
   * Sessions waiting on a human.
   *
   * MUST be needsInputCount() over homeSessions — the same call, over the same
   * list, that <mux-start-card> is handed in mux-sidebar. Derived in both
   * places from one source rather than passed around, so the badge on the
   * hamburger and the number behind the drawer cannot disagree.
   */
  private get _needsCount(): number {
    void this._sessionVersion;
    return needsInputCount(homeSessions.sessions);
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

  render() {
    const needs = this._needsCount;

    return html`
      <button
        class="drawer-btn"
        type="button"
        title="Workspaces"
        aria-label="${needs > 0
          ? `${needs} sessions need input. Open workspaces.`
          : 'Open workspaces'}"
        aria-expanded="${this.drawerOpen ? 'true' : 'false'}"
        @click="${this._toggleDrawer}"
      >
        ${icon(Menu, { size: 20 })}
        ${needs > 0
          ? html`<span class="needs-badge">${NEEDS_GLYPH}${needs}</span>`
          : ''}
      </button>
      <div class="brand">
        <span class="brand-dot"></span>
        <span title="${window.location.hostname}">${instanceLabel()}</span>
        <span class="brand-sha">${__GIT_SHA__}</span>
      </div>
      <mux-pane-picker></mux-pane-picker>
      <div class="right">
        <mux-mic-button></mux-mic-button>
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
