import { LitElement, html, css, unsafeCSS } from 'lit';
import type { PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import type { Window, SessionInfo } from '../types.js';
import { CHROME } from '../lib/theme.js';
import type { RegionAction } from './region-menu.js';
import './region-menu.js';
import './session-picker.js';
import { icon } from '../lib/icons.js';
import { ChevronDown, Ellipsis, Maximize2, X } from 'lucide';

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

  // Region ⋯ menu state, managed here so we can position it correctly.
  @state() private _menuOpen = false;
  @state() private _menuRect: { top: number; right: number } | null = null;

  // Session dropdown state — toggles when the session chip is clicked.
  @state() private _showSessionDropdown = false;
  @state() private _sessionDropdownRect: { top: number; left: number } | null = null;

  /** Bound so it can be removed in disconnectedCallback. Closes both menus. */
  private _onOutsideMenuClick = (e: MouseEvent): void => {
    if ((this._menuOpen || this._showSessionDropdown) && !this.contains(e.target as Node)) {
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

  /** Fix 4: reset optimistic state once the server confirms the new activeWindowId. */
  protected override updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);
    if (changedProperties.has('activeWindowId') && this._optimisticWindowId !== null) {
      this._optimisticWindowId = null;
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

  /** Handle session-selected from the inline session picker. */
  private _onSessionPickerSelected = (e: Event): void => {
    e.stopPropagation();
    this._showSessionDropdown = false;
    this._sessionDropdownRect = null;
    const ev = e as CustomEvent<{ name: string }>;
    this._emit('session-selected', { name: ev.detail.name });
  };

  /** Handle new-session from the inline session picker. */
  private _onSessionPickerNewSession = (e: Event): void => {
    e.stopPropagation();
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
          ${this.windows.map((w) => {
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
                        this._emit('tab-close', { windowId: w.id });
                      }}"
                    >${icon(X, { size: 12 })}</span>`}
              </button>
            `;
          })}
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
            style="${styleMap({
              position: 'fixed',
              top: `${this._sessionDropdownRect.top}px`,
              left: `${this._sessionDropdownRect.left}px`,
              zIndex: '2000',
            })}"
          >
            <mux-session-picker
              .inline="${true}"
              .sessions="${this.sessions}"
              .currentSession="${this.activeSession}"
              @session-selected="${this._onSessionPickerSelected}"
              @new-session="${this._onSessionPickerNewSession}"
              @close-picker="${() => {
                this._showSessionDropdown = false;
                this._sessionDropdownRect = null;
              }}"
            ></mux-session-picker>
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
