import { LitElement, css, html, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { CalendarClock, ChevronLeft, ChevronRight, PanelLeft, Plug, Plus, Puzzle, Settings, SquareTerminal } from 'lucide';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { icon } from '../lib/icons.js';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../lib/sidebar-width.js';
import { fetchUpdateStatus, type UpdateStatus } from '../lib/update.js';
import { macAppVersion } from '../lib/mac-app.js';
import '../ui/button.js';
import '../ui/nav-item.js';
import './mux-chat-list.js';

/** Persistent destinations, chat groups, and actions beside the current workspace. */
@customElement('mux-sidebar')
export class MuxSidebar extends LitElement {
  static override styles = css`
    ${subtleScrollbars}
    :host {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      box-sizing: border-box;
      position: relative;
      overflow: hidden;
      width: auto;
      min-width: ${unsafeCSS(String(SIDEBAR_MIN_WIDTH))}px;
      max-width: ${unsafeCSS(String(SIDEBAR_MAX_WIDTH))}px;
      height: 100%;
      border-right: 0;
      background: var(--ui-surface-raised);
      color: var(--ui-text);
      font-family: var(--ui-font-sans);
    }
    .header {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      flex: none;
      height: var(--ui-nav-height);
      gap: var(--ui-space-1);
      padding: 0 var(--ui-space-3) 0 max(var(--ui-space-3), var(--wco-left-inset, 0px));
      background: var(--ui-surface-nav);
      color: var(--ui-text);
      font: var(--ui-text-md)/1.25 var(--ui-font-sans);
    }
    .header .history { display:flex; align-items:center; gap:var(--ui-space-1); margin-left:auto; }
    :host([collapsed]) { width:var(--ui-control-lg); min-width:var(--ui-control-lg); max-width:var(--ui-control-lg); border-right:1px solid var(--ui-shell-divider); }
    :host([collapsed]) .header { padding:0; justify-content:center; }
    :host([collapsed]) .history,
    :host([collapsed]) .nav-actions,
    :host([collapsed]) .tab-content,
    :host([collapsed]) .footer { display:none; }
    :host([drawer]) .header { display: none; }
    .nav-actions {
      display: flex;
      flex-direction: column;
      flex: none;
      gap: var(--ui-space-1);
      padding: var(--ui-space-5) var(--ui-space-3) 0;
    }
    .tab-content {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 0 var(--ui-space-3) var(--ui-space-6);
    }
    .footer {
      flex: none;
      padding: var(--ui-space-4) var(--ui-space-3) var(--ui-space-5);
    }
    .drawer-footer-actions { display: none; }
    :host([drawer]) .nav-actions {
      gap: 0;
      padding: var(--ui-space-4) 0 0;
    }
    :host([drawer]) .nav-actions mux-ui-nav-item {
      --ui-nav-row-height: var(--ui-sidebar-nav-row-height);
      --ui-nav-icon-size: 20px;
      --ui-nav-font-size: var(--ui-sidebar-item-font-size);
      --ui-nav-icon-label-gap: var(--ui-sidebar-nav-icon-label-gap);
      --ui-nav-horizontal-padding: var(--ui-sidebar-nav-horizontal-padding);
    }
    :host([drawer]) .tab-content {
      padding: 0 var(--ui-sidebar-content-inset) calc(var(--ui-sidebar-footer-control-size) + env(safe-area-inset-bottom, 0px) + var(--ui-space-5) + var(--ui-space-8));
    }
    :host([drawer]) .chat-scroll {
      margin-top: var(--ui-sidebar-nav-divider-gap);
      padding-top: var(--ui-space-6);
      border-top: 1px solid var(--ui-border);
    }
    :host([drawer]) mux-chat-list {
      --ui-text-sm: var(--ui-sidebar-item-font-size);
      --ui-list-row-font-weight: 450;
      --ui-list-row-group-font-weight: 500;
      --ui-sidebar-section-font-size: var(--ui-sidebar-section-label-font-size);
    }
    :host([drawer]) .drawer-footer-actions {
      position: absolute;
      z-index: var(--ui-z-menu);
      inset: auto 0 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 var(--ui-space-8) calc(env(safe-area-inset-bottom, 0px) + var(--ui-space-5));
      isolation: isolate;
    }
    :host([drawer]) .drawer-footer-actions::before {
      position: absolute;
      z-index: var(--ui-z-backdrop);
      inset: auto 0 calc(-1 * (env(safe-area-inset-bottom, 0px) + var(--ui-space-5)));
      height: calc(var(--ui-sidebar-footer-control-size) + env(safe-area-inset-bottom, 0px) + var(--ui-space-5) + var(--ui-space-8));
      background: linear-gradient(to bottom, transparent, var(--ui-surface-nav) 70%);
      content: "";
      pointer-events: none;
    }
    :host([drawer]) .drawer-footer-actions mux-ui-button {
      flex: none;
      height: var(--ui-sidebar-footer-control-size);
    }
    :host([drawer]) .drawer-new-chat {
      width: var(--ui-sidebar-new-chat-width);
    }
    :host([drawer]) .drawer-new-chat::part(button) {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      min-height: 100%;
      gap: var(--ui-space-3);
      padding: 0 var(--ui-space-6);
      border: 0;
      border-radius: var(--ui-radius-pill);
      background: var(--ui-accent);
      color: var(--ui-on-accent);
      font: 500 var(--ui-sidebar-item-font-size)/1.25 var(--ui-font-sans);
    }
    :host([drawer]) .drawer-new-chat::part(button):active { background: color-mix(in srgb, var(--ui-accent) 82%, black); }
    :host([drawer]) .drawer-settings {
      width: var(--ui-sidebar-footer-control-size);
    }
    :host([drawer]) .drawer-settings::part(button) {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      min-height: 100%;
      padding: 0;
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius-pill);
      background: var(--ui-surface-raised);
      color: var(--ui-text);
    }
    :host([drawer]) .drawer-new-chat .lucide-icon,
    :host([drawer]) .drawer-settings .lucide-icon { width: var(--ui-icon-md); height: var(--ui-icon-md); }
    :host([drawer]) .drawer-footer-actions mux-ui-button::part(button):focus-visible { outline: 2px solid var(--ui-focus); outline-offset: 2px; }
  `;

  @property({ type: Boolean }) newChatActive = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ type: Boolean }) terminalActive = false;
  @property({ type: Boolean }) jobsActive = false;
  @property({ type: Boolean }) connectionsActive = false;
  @property({ type: Boolean }) skillsActive = false;
  @property({ type: String }) selectedSDKChat = '';
  /** The phone drawer has a title bar of its own above this component. */
  @property({ type: Boolean, reflect: true }) drawer = false;
  @state() private updateStatus: UpdateStatus | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('muxterm-update-checked', this.onUpdateChecked);
  }

  override disconnectedCallback(): void {
    window.removeEventListener('muxterm-update-checked', this.onUpdateChecked);
    super.disconnectedCallback();
  }

  override firstUpdated(): void {
    void fetchUpdateStatus()
      .then((status) => { if (this.isConnected) this.updateStatus = status; })
      .catch(() => { /* The footer omits the version when status is unavailable. */ });
  }

  private onUpdateChecked = (event: Event): void => {
    this.updateStatus = (event as CustomEvent<UpdateStatus>).detail;
  };

  private renderFooter() {
    if (this.drawer) {
      return html`<div class="drawer-footer-actions">
        <mux-ui-button class="drawer-new-chat" variant="primary" size="large" accessible-label="New chat" aria-current=${this.newChatActive ? 'page' : nothing}
          @click=${() => this.dispatchEvent(new CustomEvent('chat-new', { bubbles: true, composed: true }))}>
          ${icon(Plus, { size: 20 })}<span>New chat</span>
        </mux-ui-button>
        <mux-ui-button class="drawer-settings" icon-only size="large" variant="secondary" accessible-label="Settings" tooltip="Settings"
          @click=${() => this.dispatchEvent(new CustomEvent('launcher-action', { detail: { action: 'settings' }, bubbles: true, composed: true }))}>
          ${icon(Settings, { size: 20 })}
        </mux-ui-button>
      </div>`;
    }
    const version = macAppVersion() || this.updateStatus?.currentVersion;
    const description = version ? version.startsWith('v') ? version : `v${version}` : '';
    return html`<div class="footer"><mux-ui-nav-item label="Settings" description=${description}
      @click=${() => this.dispatchEvent(new CustomEvent('launcher-action', { detail: { action: 'settings' }, bubbles: true, composed: true }))}>
      <span slot="icon">${icon(Settings, { size: 16 })}</span>
    </mux-ui-nav-item></div>`;
  }

  override render() {
    const navActions = [
      { label: 'New Chat', icon: Plus, active: this.newChatActive, event: 'chat-new' },
      { label: 'Terminal', icon: SquareTerminal, active: this.terminalActive, event: 'terminal-open' },
      { label: 'Scheduled jobs', icon: CalendarClock, active: this.jobsActive, event: 'jobs-open' },
      { label: 'Customizations', icon: Plug, active: this.connectionsActive, event: 'connections-open' },
      { label: 'Skills', icon: Puzzle, active: this.skillsActive, event: 'skills-open' },
    ].filter(action => !this.drawer || action.event !== 'chat-new');
    const nav = html`<nav class="nav-actions" aria-label="Sidebar actions">
      ${navActions.map(action => html`
        <mux-ui-nav-item label=${action.label} ?active=${action.active}
          @click=${() => this.dispatchEvent(new CustomEvent(action.event, { bubbles: true, composed: true }))}>
          <span slot="icon">${icon(action.icon, { size: this.drawer ? 20 : 16 })}</span>
        </mux-ui-nav-item>
      `)}
    </nav>`;

    return html`
      <div class="header">
        <mux-ui-button icon-only size="small" variant="quiet" tone="muted" accessible-label=${this.collapsed ? 'Show sidebar' : 'Hide sidebar'} tooltip=${this.collapsed ? 'Show sidebar' : 'Hide sidebar'} @click=${() => this.dispatchEvent(new CustomEvent('sidebar-toggle', { bubbles:true, composed:true }))}>${icon(PanelLeft,{size:17})}</mux-ui-button>
        <div class="history">
          <mux-ui-button icon-only size="small" variant="quiet" tone="muted" accessible-label="Back" tooltip="Back" @click=${() => window.history.back()}>${icon(ChevronLeft,{size:17})}</mux-ui-button>
          <mux-ui-button icon-only size="small" variant="quiet" tone="muted" accessible-label="Forward" tooltip="Forward" @click=${() => window.history.forward()}>${icon(ChevronRight,{size:17})}</mux-ui-button>
        </div>
      </div>
      ${this.drawer
        ? html`<div class="tab-content">${nav}<div class="chat-scroll"><mux-chat-list drawer .selectedSession=${this.selectedSDKChat}></mux-chat-list></div></div>`
        : html`${nav}<div class="tab-content"><mux-chat-list .selectedSession=${this.selectedSDKChat}></mux-chat-list></div>`}
      ${this.renderFooter()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-sidebar': MuxSidebar }
}
