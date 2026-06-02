import { LitElement, html, css, unsafeCSS } from 'lit';
import type { PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import type { Window, SessionInfo } from '../types.js';
import { CHROME } from '../lib/theme.js';
import type { RegionAction } from './region-menu.js';
import './region-menu.js';
import { icon } from '../lib/icons.js';
import { Check, ChevronDown, Ellipsis, Maximize2, Plus, X } from 'lucide';

@customElement('mux-region-tabstrip')
export class MuxRegionTabstrip extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .strip {
      display: flex;
      align-items: center;
      background: ${unsafeCSS(CHROME.bar)};
      height: 36px;
      padding: 0 4px;
      gap: 2px;
      user-select: none;
      flex-shrink: 0;
      overflow: hidden;
    }

    /* Session chip */
    .session-chip {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: ${unsafeCSS(CHROME.textDim)};
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .session-chip:hover {
      background: ${unsafeCSS(CHROME.hover)};
      color: ${unsafeCSS(CHROME.textBright)};
    }

    /* Driver: session chip uses driverAccent color */
    .strip.driver .session-chip {
      color: ${unsafeCSS(CHROME.driverAccent)};
    }

    /* Tabs container */
    .tabs {
      display: flex;
      align-items: stretch;
      height: 100%;
      gap: 1px;
      min-width: 0;
      overflow: hidden;
    }

    /* Individual tab */
    .tab {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0 10px;
      background: transparent;
      border: none;
      border-top: 2px solid transparent;
      cursor: pointer;
      font-size: 13px;
      color: ${unsafeCSS(CHROME.textDim)};
      font-family: inherit;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .tab:hover {
      background: ${unsafeCSS(CHROME.hover)};
      color: ${unsafeCSS(CHROME.textBright)};
    }

    /* Active tab: top accent line + body background (seamless with body) */
    .tab.active {
      border-top: 2px solid ${unsafeCSS(CHROME.accent)};
      background: ${unsafeCSS(CHROME.body)};
      color: ${unsafeCSS(CHROME.textBright)};
    }

    /* Driver: active tab uses driverAccent */
    .strip.driver .tab.active {
      border-top: 2px solid ${unsafeCSS(CHROME.driverAccent)};
    }

    /* File icon */
    .file-icon {
      font-size: 11px;
      opacity: 0.7;
    }

    /* Close button — visibility:hidden until tab hover */
    .tab-close {
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      cursor: pointer;
      visibility: hidden;
      color: ${unsafeCSS(CHROME.textDim)};
    }

    .tab:hover .tab-close {
      visibility: visible;
    }

    .tab-close:hover {
      color: ${unsafeCSS(CHROME.danger)};
    }

    /* Dirty dot for running windows */
    .dirty-dot {
      font-size: 10px;
      color: ${unsafeCSS(CHROME.accent)};
    }

    /* Tab add button */
    .tab-add {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      font-size: 18px;
      color: ${unsafeCSS(CHROME.textDim)};
      background: transparent;
      border: none;
      cursor: pointer;
      flex-shrink: 0;
    }

    .tab-add:hover {
      color: ${unsafeCSS(CHROME.textBright)};
      background: ${unsafeCSS(CHROME.hover)};
      border-radius: 4px;
    }

    /* Pending tab placeholder — shown while waiting for server confirmation */
    .tab-pending {
      font-style: italic;
      opacity: 0.6;
      color: ${unsafeCSS(CHROME.textDim)};
      padding: 0 12px;
      display: flex;
      align-items: center;
      font-size: 12px;
      animation: tab-pulse 1s ease-in-out infinite alternate;
    }

    @keyframes tab-pulse {
      from { opacity: 0.4; }
      to   { opacity: 0.8; }
    }

    /* Spacer */
    .spacer {
      flex: 1;
    }

    /* Controls */
    .controls {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }

    .maximize-btn,
    .more-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      background: transparent;
      border: none;
      color: ${unsafeCSS(CHROME.textDim)};
      cursor: pointer;
      border-radius: 4px;
    }

    .maximize-btn:hover,
    .more-btn:hover {
      background: ${unsafeCSS(CHROME.hover)};
      color: ${unsafeCSS(CHROME.textBright)};
    }

    .more-btn.open {
      background: ${unsafeCSS(CHROME.hover)};
      color: ${unsafeCSS(CHROME.textBright)};
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }

    button .lucide-icon {
      pointer-events: none;
    }

    /* Inline session dropdown (formerly mux-session-picker inline mode). */
    .dropdown {
      min-width: 208px;
      background: #16161e;
      border: 1px solid #2a2e3f;
      border-radius: 9px;
      padding: 5px;
      box-shadow: 0 18px 46px rgba(0, 0, 0, 0.6);
      font-size: 13px;
    }

    .mi {
      display: flex;
      align-items: center;
      gap: 9px;
      width: 100%;
      padding: 8px 10px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #c0caf5;
      cursor: pointer;
      text-align: left;
      font-size: 13px;
    }

    .mi:hover {
      background: #1f2335;
    }

    .mi.sel {
      background: #283457;
    }

    .mi.dim {
      color: #565f89;
    }

    .mi.dim:hover {
      background: #1f2335;
      color: #c0caf5;
    }

    .ck {
      width: 14px;
      flex-shrink: 0;
      color: #9ece6a;
      display: flex;
      align-items: center;
    }

    .sname {
      flex: 1;
    }

    .kbd {
      margin-left: auto;
      color: #565f89;
      font-size: 11px;
      flex-shrink: 0;
    }

    .sep {
      height: 1px;
      background: #2a2e3f;
      margin: 5px 6px;
    }
  `;

  @property({ type: String })
  sessionName = '';

  @property({ attribute: false })
  windows: Window[] = [];

  @property({ type: Number })
  activeWindowId = 0;

  @property({ type: Boolean })
  isDriver = false;

  @property({ attribute: false })
  runningWindowIds: number[] = [];

  /** Sessions list for the inline session dropdown. */
  @property({ attribute: false })
  sessions: SessionInfo[] = [];

  /** The currently-active session name (used to show a checkmark). */
  @property({ type: String })
  activeSession = '';

  /** True when this is the only region — disables "Close region" in the menu. */
  @property({ type: Boolean })
  isOnlyRegion = false;

  // Fix 4: optimistic tab selection — shows the clicked tab as active
  // immediately without waiting for the server round-trip.
  @state() private _optimisticWindowId: number | null = null;

  // Optimistic close — hide a tab immediately on click, before the server
  // confirms the window is gone.  Cleaned up in updated() once confirmed.
  @state() private _closingWindowIds = new Set<number>();

  // Optimistic new-tab — shows a placeholder while waiting for server confirmation.
  @state() private _pendingCount = 0;

  // Region ⋯ menu state, managed here so we can position it correctly.
  @state() private _menuOpen = false;
  @state() private _menuRect: { top: number; right: number } | null = null;

  // Session dropdown state — toggles when the session chip is clicked.
  @state() private _showSessionDropdown = false;
  @state() private _sessionDropdownRect: { top: number; left: number } | null = null;

  /** Bound so it can be removed in disconnectedCallback. Closes both menus. */
  private _onOutsideMenuClick = (e: MouseEvent): void => {
    if ((this._menuOpen || this._showSessionDropdown) && !e.composedPath().includes(this)) {
      this._menuOpen = false;
      this._menuRect = null;
      this._showSessionDropdown = false;
      this._sessionDropdownRect = null;
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('mousedown', this._onOutsideMenuClick);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('mousedown', this._onOutsideMenuClick);
  }

  /** Fix 4: reset optimistic state once the server confirms the new activeWindowId.
   *  Also cleans up _closingWindowIds once the server confirms those windows are gone. */
  protected override updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);
    if (changedProperties.has('activeWindowId') && this._optimisticWindowId !== null) {
      this._optimisticWindowId = null;
    }
    if (changedProperties.has('windows')) {
      const prev = changedProperties.get('windows') as Window[] | undefined;
      const gained = (this.windows?.length ?? 0) - (prev?.length ?? 0);
      if (gained > 0) {
        this._pendingCount = Math.max(0, this._pendingCount - gained);
      }
      if (this._closingWindowIds.size > 0) {
        const liveIds = new Set(this.windows.map((w) => w.id));
        const confirmed = [...this._closingWindowIds].filter((id) => !liveIds.has(id));
        if (confirmed.length > 0) {
          this._closingWindowIds = new Set(
            [...this._closingWindowIds].filter((id) => liveIds.has(id)),
          );
        }
      }
    }
  }

  private _emit(name: string, detail?: Record<string, unknown>): void {
    this.dispatchEvent(
      new CustomEvent(name, {
        bubbles: true,
        composed: true,
        ...(detail ? { detail } : {}),
      }),
    );
  }

  private _onChipClick(): void {
    if (this._showSessionDropdown) {
      this._showSessionDropdown = false;
      this._sessionDropdownRect = null;
      return;
    }
    const btn = this.shadowRoot?.querySelector<HTMLElement>('.session-chip');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      this._sessionDropdownRect = { top: rect.bottom + 2, left: rect.left };
    }
    this._showSessionDropdown = true;
  }

  /** Handle a session pick from the inline session dropdown. */
  private _onSessionPickerSelected = (name: string): void => {
    this._showSessionDropdown = false;
    this._sessionDropdownRect = null;
    this._emit('session-selected', { name });
  };

  /** Handle "New session…" from the inline session dropdown. */
  private _onSessionPickerNewSession = (): void => {
    this._showSessionDropdown = false;
    this._sessionDropdownRect = null;
    this._emit('new-session', {});
  };

  private _onTabClick(windowId: number): void {
    // Fix 4: set optimistic state immediately so the active indicator moves
    // without waiting for the server round-trip (~100 ms).
    this._optimisticWindowId = windowId;
    this._emit('tab-select', { windowId });
  }

  private _onTabNew(): void {
    this._pendingCount++;
    this._emit('tab-new');
  }

  private _onMaximize(): void {
    this._emit('region-maximize');
  }

  /** Fix 6: capture the ⋯ button position so we can position the menu with
   *  position:fixed (escaping any overflow:hidden ancestors). */
  private _onMenuOpen(): void {
    if (this._menuOpen) {
      this._menuOpen = false;
      this._menuRect = null;
      return;
    }
    const btn = this.shadowRoot?.querySelector<HTMLElement>('.more-btn');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      this._menuRect = { top: rect.bottom + 4, right: window.innerWidth - rect.right };
    }
    this._menuOpen = true;
  }

  /** Fix 6: handle region-action from the inline menu, close it, and bubble
   *  the action up so workspace.ts can respond. */
  private _onRegionAction(e: Event): void {
    e.stopPropagation();
    this._menuOpen = false;
    this._menuRect = null;
    const ev = e as CustomEvent<{ action: RegionAction }>;
    this._emit('region-action', { action: ev.detail.action });
  }

  render() {
    const stripClass = `strip${this.isDriver ? ' driver' : ''}`;

    // Fix 4: use the optimistic window id (if set) to show immediate feedback,
    // fall back to the server-authoritative activeWindowId.
    const effectiveActiveId = this._optimisticWindowId ?? this.activeWindowId;

    return html`
      <div class="${stripClass}">
        <button class="session-chip" @click="${this._onChipClick}">
          ${this.sessionName} ${icon(ChevronDown, { size: 12 })}
        </button>

        <div class="tabs">
          ${this.windows.filter((w) => !this._closingWindowIds.has(w.id)).map((w) => {
            const isActive = w.id === effectiveActiveId;
            const isRunning = this.runningWindowIds.includes(w.id);
            return html`
              <button
                class="tab${isActive ? ' active' : ''}"
                data-window-id="${w.id}"
                @click="${() => this._onTabClick(w.id)}"
              >
                <span class="file-icon">▪</span>
                ${w.name}
                ${isRunning
                  ? html`<span class="dirty-dot">●</span>`
                  : html`<span
                      class="tab-close"
                      @click="${(e: Event) => {
                        // Fix 3: stop propagation so the parent tab button's
                        // click handler (which would select the tab) doesn't also fire.
                        e.stopPropagation();
                        // Optimistically hide the tab right now so the UI is
                        // instant; updated() will clean up once the server confirms.
                        this._closingWindowIds = new Set([...this._closingWindowIds, w.id]);
                        this._emit('tab-close', { windowId: w.id });
                      }}"
                    >${icon(X, { size: 12 })}</span>`}
              </button>
            `;
          })}
          ${Array.from({ length: this._pendingCount }, () => html`
            <span class="tab tab-pending">opening…</span>
          `)}
        </div>

        <button class="tab-add" @click="${this._onTabNew}">+</button>

        <div class="spacer"></div>

        <div class="controls">
          <button class="maximize-btn" @click="${this._onMaximize}">${icon(Maximize2, { size: 14 })}</button>
          <button
            class="more-btn${this._menuOpen ? ' open' : ''}"
            @click="${this._onMenuOpen}"
          >${icon(Ellipsis, { size: 14 })}</button>
        </div>
      </div>

      ${this._menuOpen && this._menuRect
        ? html`<div
            style="${styleMap({
              position: 'fixed',
              top: `${this._menuRect.top}px`,
              right: `${this._menuRect.right}px`,
              zIndex: '1500',
              maxHeight: '80vh',
              overflowY: 'auto',
            })}"
          >
            <mux-region-menu
              .isOnlyRegion="${this.isOnlyRegion}"
              @region-action="${this._onRegionAction}"
            ></mux-region-menu>
          </div>`
        : ''}

      ${this._showSessionDropdown && this._sessionDropdownRect
        ? html`<div
            class="session-dropdown"
            style="${styleMap({
              position: 'fixed',
              top: `${this._sessionDropdownRect.top}px`,
              left: `${this._sessionDropdownRect.left}px`,
              zIndex: '2000',
            })}"
          >
            <div class="dropdown">
              ${this.sessions.map(
                (s, i) => html`
                  <button
                    class="mi ${s.name === this.activeSession ? 'sel' : ''}"
                    @click="${() => this._onSessionPickerSelected(s.name)}"
                  >
                    <span class="ck">
                      ${s.name === this.activeSession ? icon(Check, { size: 12 }) : ''}
                    </span>
                    <span class="sname">${s.name}</span>
                    ${i < 2 ? html`<span class="kbd">⌃⇧${i + 1}</span>` : ''}
                  </button>
                `,
              )}
              <div class="sep"></div>
              <button class="mi dim" @click="${this._onSessionPickerNewSession}">
                <span class="ck"></span>
                ${icon(Plus, { size: 12 })}
                <span>New session…</span>
              </button>
            </div>
          </div>`
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-region-tabstrip': MuxRegionTabstrip;
  }
}
