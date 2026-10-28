import { LitElement, css, html, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { CalendarClock, Globe2, Plug, Plus, Puzzle, Settings, SquareTerminal } from 'lucide';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { icon } from '../lib/icons.js';
import { instanceLabel } from '../lib/instance-identity.js';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../lib/sidebar-width.js';
import { fetchUpdateStatus, type UpdateStatus } from '../lib/update.js';
import { macAppVersion } from '../lib/mac-app.js';
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
      border-right: 1px solid var(--ui-border);
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
      padding: 0 var(--ui-space-5) 0 max(var(--ui-space-5), var(--wco-left-inset, 0px));
      border-bottom: 1px solid var(--ui-border);
      background: var(--ui-surface-nav);
      color: var(--ui-text);
      font: 700 var(--ui-text-md)/1.25 var(--ui-font-sans);
    }
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
  `;

  @property({ type: Boolean }) newChatActive = false;
  @property({ type: Boolean }) terminalActive = false;
  @property({ type: Boolean }) browserActive = false;
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
      ...(macAppVersion() ? [{ label: 'Browser', icon: Globe2, active: this.browserActive, event: 'browser-open' }] : []),
      { label: 'Scheduled jobs', icon: CalendarClock, active: this.jobsActive, event: 'jobs-open' },
      { label: 'Connections', icon: Plug, active: this.connectionsActive, event: 'connections-open' },
      { label: 'Skills', icon: Puzzle, active: this.skillsActive, event: 'skills-open' },
    ];

    return html`
      <div class="header"><span title=${window.location.hostname}>${instanceLabel()}</span></div>
      <nav class="nav-actions" aria-label="Sidebar actions">
        ${navActions.map(action => html`
          <mux-ui-nav-item label=${action.label} ?active=${action.active}
            @click=${() => this.dispatchEvent(new CustomEvent(action.event, { bubbles: true, composed: true }))}>
            <span slot="icon">${icon(action.icon, { size: 16 })}</span>
          </mux-ui-nav-item>
        `)}
      </nav>
      <div class="tab-content"><mux-chat-list .selectedSession=${this.selectedSDKChat}></mux-chat-list></div>
      ${this.renderFooter()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-sidebar': MuxSidebar }
}
