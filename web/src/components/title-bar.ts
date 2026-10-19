/** Narrow-mode navigation bar. */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import './launcher-menu.js';
import './mux-pane-picker.js';
import './mic-button.js';
import { icon } from '../lib/icons.js';
import { Ellipsis, Menu, MessageSquare, SquarePen } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { homeSessions } from '../lib/home-sessions.js';
import { needsInputCount } from '../lib/session-state.js';

@customElement('mux-title-bar')
export class MuxTitleBar extends LitElement {
  static styles = css`
    :host {
      --scrim: color-mix(in srgb, var(--chrome-body) 62%, transparent);
      /* D3. The ONE top-chrome height token, shared with <mux-sidebar>'s
         .header. Change it in theme.ts and both surfaces move together; there
         is no second place to forget. */
      --nav-h: var(--mux-titlebar-height, var(--mux-dock-height, 44px));

      display: flex;
      align-items: center;
      gap: 2px;
      background: var(--wco-narrow-bg, var(--mux-titlebar-bg, var(--chrome-bar)));
      border-bottom: 1px solid var(--chrome-border);
      /* D9. viewport-fit=cover has been set for as long as index.html has had
         a viewport meta and env(safe-area-inset-*) appeared in zero files; on
         a notched phone in landscape this bar started under the notch. The
         height GROWS by the inset rather than eating into the 44px row, so
         every target in here keeps its full touch size. */
      height: calc(var(--nav-h) + env(safe-area-inset-top, 0px));
      padding: env(safe-area-inset-top, 0px)
        max(env(safe-area-inset-right, 0px), var(--wco-right-inset, 0px)) 0
        max(env(safe-area-inset-left, 0px), var(--wco-left-inset, 0px));
      box-sizing: border-box;
      flex-shrink: 0;
      user-select: none;
      position: relative;
    }

    :host([window-chrome]) {
      --nav-h: env(titlebar-area-height, 44px);
      position: fixed;
      top: env(titlebar-area-y, 0px);
      left: env(titlebar-area-x, 0px);
      width: env(titlebar-area-width, 100%);
      height: env(titlebar-area-height, 44px);
      padding: 0 8px;
      border: 0;
      z-index: 50;
      -webkit-app-region: drag;
      app-region: drag;
    }
    :host([window-chrome]) button,
    :host([window-chrome]) mux-pane-picker,
    :host([window-chrome]) mux-mic-button,
    :host([window-chrome]) mux-launcher-menu {
      -webkit-app-region: no-drag;
      app-region: no-drag;
    }
    :host([window-chrome]) .chat-title { font-weight: 500; }
    :host([window-chrome]) .brand { font-weight: 500; }
    :host([window-chrome]) .brand-sha { display: none; }
    :host([window-chrome]) .window-new-chat {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      height: var(--nav-h);
      padding: 0 10px;
      color: var(--chrome-text-bright);
      background: transparent;
      border: 0;
      border-radius: 6px;
      font: 400 13px/1 system-ui, sans-serif;
      cursor: pointer;
    }
    .window-new-chat:hover { background: var(--chrome-hover); }
    @media (max-width: 640px) {
      .window-new-chat span { display: none; }
    }

    @media (display-mode: window-controls-overlay) {
      :host { -webkit-app-region: drag; }
      button, mux-pane-picker, mux-mic-button, mux-launcher-menu {
        -webkit-app-region: no-drag;
      }
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

    .brand-logo {
      width: 20px;
      height: 20px;
      border-radius: 5px;
      flex-shrink: 0;
    }

    .brand-sha {
      font-size: 10px;
      font-weight: 400;
      font-family: monospace;
      color: var(--chrome-text-dim);
      letter-spacing: 0;
    }

    .chat-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0 6px;
      color: var(--chrome-text-bright);
      font-size: 13.5px;
      font-weight: 600;
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
    .side-chat-btn,
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
    .side-chat-btn:hover,
    .drawer-btn:hover {
      background: var(--chrome-hover);
    }
    .side-chat-btn[aria-pressed="true"] { color:var(--chrome-accent); background:var(--chrome-hover); }

    /* Show an attention dot only when a session needs input. */
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

  @property({ type: String }) chatTitle = '';

  /** Wide workspace chrome reuses this title bar without a drawer control. */
  @property({ type: Boolean, reflect: true }) desktop = false;

  /** The dock supplies the wide workspace menu when panes exist. */
  @property({ type: Boolean }) dockActionsVisible = false;
  @property({ type: Boolean }) sideChatAvailable = false;
  @property({ type: Boolean }) sideChatOpen = false;

  /** Bumped when the session list changes, so the badge re-derives. */
  @state() private _sessionVersion = 0;

  private _unsubSessions: (() => void) | null = null;

  /** Bound handler so we can remove it in disconnectedCallback. */
  private _onOpenLauncher = (): void => {
    if (this.getClientRects().length === 0) return;
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

  /** Whether any terminal session needs input. */
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

  render() {
    const needs = this._needs;

    return html`
      ${this.desktop
        ? ''
        : html`<button
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
          </button>`}
      ${this.chatTitle
        ? html`<span class="chat-title">${this.chatTitle}</span>`
        : html`<div class="brand">
            <img class="brand-logo" src="${apiPath('/icons/icon.svg')}" alt="">
            <span>Muxterm</span>
            <span class="brand-sha">${__GIT_SHA__}</span>
          </div><mux-pane-picker></mux-pane-picker>`}
      <div class="right">
        ${this.hasAttribute('window-chrome') ? html`<button class="window-new-chat" type="button" aria-label="New chat"
          @click=${() => this.dispatchEvent(new CustomEvent('chat-new', { bubbles: true, composed: true }))}
        >${icon(SquarePen, { size: 16 })}<span>New chat</span></button>` : ''}
        ${this.desktop || this.chatTitle ? '' : html`<mux-mic-button></mux-mic-button>`}
        ${this.sideChatAvailable ? html`<button class="side-chat-btn" type="button" aria-label="Open side chat" title="Open side chat" aria-pressed=${this.sideChatOpen} @click=${() => this.dispatchEvent(new CustomEvent('terminal-chat-toggle',{bubbles:true,composed:true}))}>${icon(MessageSquare,{size:17})}</button>` : ''}
        ${this.desktop && this.dockActionsVisible
          ? ''
          : html`<button
                class="launcher-btn"
                type="button"
                title="Open menu"
                popovertarget="launcher-sheet"
              >${icon(Ellipsis, { size: 16 })}</button>`}
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
