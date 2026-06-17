import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { CHROME, PALETTES } from '../lib/theme.js';
import { FONT_FAMILIES } from '../lib/fonts.js';
import type { ResolvedConfig } from '../lib/config.js';

// ── Theme card display metadata ──────────────────────────────────────────────

interface ThemeCard {
  id: string;
  label: string;
}

const DARK_THEMES: ThemeCard[] = [
  { id: 'tokyo-night', label: 'Tokyo Night' },
  { id: 'catppuccin',  label: 'Catppuccin'  },
  { id: 'gruvbox',     label: 'Gruvbox'     },
  { id: 'dracula',     label: 'Dracula'     },
  { id: 'nord',        label: 'Nord'        },
];

const LIGHT_THEMES: ThemeCard[] = [
  { id: 'solarized-light', label: 'Solarized' },
  { id: 'one-light',       label: 'One Light' },
  { id: 'github-light',    label: 'GitHub'    },
];

/**
 * mux-settings-surface — Phase 5 two-column settings panel.
 *
 * Layout: narrow sidebar (Appearance / Notifications) + content area.
 * Changes apply immediately and are persisted via the parent's PATCH call.
 *
 * Events:
 *   config-change  { config: ResolvedConfig }  — emitted on every user change
 *   close                                       — emitted when × is clicked
 */
@customElement('mux-settings-surface')
export class MuxSettingsSurface extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: ${unsafeCSS(CHROME.body)};
      color: ${unsafeCSS(CHROME.textBright)};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      box-sizing: border-box;
      overflow: hidden;
    }

    /* ── Header bar ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px 14px;
      border-bottom: 1px solid ${unsafeCSS(CHROME.border)};
      flex-shrink: 0;
    }

    .header h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: ${unsafeCSS(CHROME.textBright)};
    }

    .close-btn {
      background: transparent;
      border: none;
      color: ${unsafeCSS(CHROME.textDim)};
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 3px 7px;
      border-radius: 4px;
      transition: color 0.1s, background 0.1s;
    }
    .close-btn:hover {
      color: ${unsafeCSS(CHROME.textBright)};
      background: ${unsafeCSS(CHROME.hover)};
    }

    /* ── Body: sidebar + content ── */
    .body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* ── Sidebar ── */
    .sidebar {
      width: 156px;
      flex-shrink: 0;
      border-right: 1px solid ${unsafeCSS(CHROME.border)};
      padding: 12px 0;
      overflow-y: auto;
    }

    .sidebar-item {
      display: block;
      width: 100%;
      padding: 9px 18px;
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
      color: ${unsafeCSS(CHROME.textDim)};
      text-align: left;
      border-radius: 0;
      transition: color 0.1s, background 0.1s;
    }
    .sidebar-item:hover {
      color: ${unsafeCSS(CHROME.textBright)};
      background: ${unsafeCSS(CHROME.hover)};
    }
    .sidebar-item.active {
      color: ${unsafeCSS(CHROME.textBright)};
      background: ${unsafeCSS(CHROME.hover)};
      font-weight: 500;
    }

    /* ── Content area ── */
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 24px 28px 40px;
    }

    /* ── Section headings ── */
    .section-title {
      margin: 0 0 16px 0;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: ${unsafeCSS(CHROME.textDim)};
    }

    .section-gap {
      margin-top: 32px;
    }

    /* ── Theme card grid ── */
    .theme-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 4px;
    }

    .theme-card {
      position: relative;
      cursor: pointer;
      border-radius: 8px;
      border: 2px solid transparent;
      overflow: hidden;
      transition: border-color 0.15s, transform 0.1s;
      user-select: none;
    }
    .theme-card:hover {
      transform: translateY(-1px);
    }
    .theme-card.active {
      border-color: ${unsafeCSS(CHROME.accent)};
    }

    .card-inner {
      padding: 8px 9px 6px;
      font-size: 9px;
      font-family: 'JetBrainsMonoNerdFont', 'SF Mono', monospace;
      line-height: 1.6;
    }

    .card-topbar {
      display: flex;
      gap: 4px;
      margin-bottom: 6px;
    }
    .card-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .dot-r { background: #ff5f57; }
    .dot-y { background: #febc2e; }
    .dot-g { background: #28c840; }

    .card-prompt { margin-bottom: 1px; }
    .card-files  { margin-top: 1px; }

    .card-cursor {
      display: inline-block;
      width: 6px;
      height: 10px;
      vertical-align: text-bottom;
      margin-top: 1px;
    }

    .card-label {
      font-size: 10px;
      text-align: center;
      padding: 5px 6px 6px;
      color: ${unsafeCSS(CHROME.textDim)};
      background: ${unsafeCSS(CHROME.bar)};
    }
    .theme-card.active .card-label {
      color: ${unsafeCSS(CHROME.textBright)};
    }

    .card-check {
      position: absolute;
      top: 5px;
      right: 7px;
      font-size: 10px;
      color: ${unsafeCSS(CHROME.accent)};
      font-weight: 700;
    }

    /* ── Font family radios ── */
    .font-radios {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .font-radio-label {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .font-radio-label:hover {
      background: ${unsafeCSS(CHROME.hover)};
    }

    .font-radio-label input[type="radio"] {
      accent-color: ${unsafeCSS(CHROME.accent)};
      width: 14px;
      height: 14px;
      cursor: pointer;
      flex-shrink: 0;
    }

    .font-radio-name {
      flex: 1;
      color: ${unsafeCSS(CHROME.textBright)};
    }

    /* ── Font size slider ── */
    .size-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 10px;
      margin-top: 4px;
    }

    .size-label {
      color: ${unsafeCSS(CHROME.textDim)};
      width: 64px;
      flex-shrink: 0;
    }

    input[type="range"] {
      flex: 1;
      accent-color: ${unsafeCSS(CHROME.accent)};
      height: 4px;
      cursor: pointer;
    }

    .size-value {
      width: 28px;
      text-align: right;
      color: ${unsafeCSS(CHROME.textBright)};
      font-feature-settings: 'tnum';
    }

    /* ── Font preview line ── */
    .font-preview {
      margin: 10px 0 0 10px;
      padding: 8px 12px;
      background: ${unsafeCSS(CHROME.bar)};
      border: 1px solid ${unsafeCSS(CHROME.border)};
      border-radius: 6px;
      font-size: 12px;
      color: ${unsafeCSS(CHROME.textBright)};
      overflow: hidden;
      white-space: nowrap;
    }

    /* ── Notifications section ── */
    .notif-block {
      max-width: 480px;
    }

    .notif-description {
      color: ${unsafeCSS(CHROME.textDim)};
      line-height: 1.55;
      margin: 0 0 14px 0;
    }

    .notif-btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 14px;
      border-radius: 6px;
      border: 1px solid ${unsafeCSS(CHROME.accent)};
      background: transparent;
      color: ${unsafeCSS(CHROME.accent)};
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .notif-btn:hover {
      background: ${unsafeCSS(CHROME.accent)};
      color: ${unsafeCSS(CHROME.body)};
    }

    .notif-status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: ${unsafeCSS(CHROME.textDim)};
      font-size: 13px;
    }
    .notif-status.granted {
      color: #9ece6a; /* tokyo-night green */
    }
    .notif-status.denied {
      color: ${unsafeCSS(CHROME.danger)};
    }

    .notif-help-link {
      display: inline-block;
      margin-top: 6px;
      font-size: 11px;
      color: ${unsafeCSS(CHROME.accent)};
      text-decoration: none;
    }
    .notif-help-link:hover {
      text-decoration: underline;
    }

    .notif-hint {
      margin-top: 8px;
      font-size: 11px;
      color: ${unsafeCSS(CHROME.textDim)};
      line-height: 1.5;
    }

    .notif-test-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 11px;
      border-radius: 6px;
      border: 1px solid ${unsafeCSS(CHROME.border)};
      background: transparent;
      color: ${unsafeCSS(CHROME.textDim)};
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: border-color 0.12s, color 0.12s;
    }
    .notif-test-btn:hover {
      border-color: ${unsafeCSS(CHROME.accent)};
      color: ${unsafeCSS(CHROME.textBright)};
    }

    /* ── Theme section label ── */
    .theme-section-label {
      grid-column: 1 / -1;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: ${unsafeCSS(CHROME.textDim)};
      padding-top: 8px;
    }

    .divider {
      height: 1px;
      background: ${unsafeCSS(CHROME.border)};
      margin: 22px 0;
    }

    /* ── Bell radios ── */
    .bell-radios {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .bell-radio-label {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      padding: 7px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .bell-radio-label:hover {
      background: ${unsafeCSS(CHROME.hover)};
    }

    .bell-radio-label input[type="radio"] {
      accent-color: ${unsafeCSS(CHROME.accent)};
      width: 14px;
      height: 14px;
      margin-top: 1px;
      cursor: pointer;
      flex-shrink: 0;
    }

    .bell-radio-text {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .bell-radio-name {
      color: ${unsafeCSS(CHROME.textBright)};
    }

    .bell-radio-desc {
      font-size: 11px;
      color: ${unsafeCSS(CHROME.textDim)};
    }
  `;

  @property({ attribute: false }) config: ResolvedConfig | null = null;
  @property({ type: String }) serverAddr = '';

  @state() private _section: 'appearance' | 'notifications' = 'appearance';
  @state() private _notifPermission: NotificationPermission | 'unsupported' = 'default';
  @state() private _notifRequesting = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this._refreshNotifPermission();
  }

  private _refreshNotifPermission(): void {
    if (!('Notification' in window)) {
      this._notifPermission = 'unsupported';
    } else {
      this._notifPermission = Notification.permission;
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private _emit(partial: Partial<ResolvedConfig>): void {
    if (!this.config) return;
    const next: ResolvedConfig = { ...this.config, ...partial };
    this.dispatchEvent(new CustomEvent('config-change', {
      detail: { config: next },
      bubbles: true,
      composed: true,
    }));
  }

  private _setTheme(palette: string): void {
    this._emit({ theme: { palette } });
  }

  private _setFontFamily(family: string): void {
    if (!this.config) return;
    this._emit({ font: { ...this.config.font, family } });
  }

  private _setFontSize(size: number): void {
    if (!this.config) return;
    this._emit({ font: { ...this.config.font, size } });
  }

  private _setBell(bell: ResolvedConfig['terminal']['bell']): void {
    if (!this.config) return;
    this._emit({ terminal: { ...this.config.terminal, bell } });
  }

  private _sendTestNotification(): void {
    try {
      new Notification('muxterm', {
        body: 'Notifications are working! You\'ll see this when a terminal bell fires in a background pane.',
        tag: 'muxterm-test',
        silent: false,
      });
    } catch (e) {
      console.error('muxterm: test notification failed:', e);
    }
  }

  private async _requestNotificationPermission(): Promise<void> {
    if (this._notifRequesting) return;
    this._notifRequesting = true;
    try {
      const result = await Notification.requestPermission();
      this._notifPermission = result;
    } catch {
      this._notifPermission = 'unsupported';
    } finally {
      this._notifRequesting = false;
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  private _renderThemeGroup(cards: ThemeCard[], current: string) {
    return cards.map(card => {
          const palette = PALETTES[card.id];
          if (!palette) return html``;
          const isActive = current === card.id;
          return html`
            <div
              class="theme-card ${isActive ? 'active' : ''}"
              title="${card.label}"
              @click="${() => this._setTheme(card.id)}"
            >
              <div class="card-inner" style="background:${palette.background}">
                <div class="card-topbar">
                  <span class="card-dot dot-r"></span>
                  <span class="card-dot dot-y"></span>
                  <span class="card-dot dot-g"></span>
                </div>
                <div class="card-prompt">
                  <span style="color:${palette.blue}">~/proj</span>
                  <span style="color:${palette.green}"> main</span>
                </div>
                <div class="card-files">
                  <span style="color:${palette.blue}">src/ </span><span style="color:${palette.green}">run.sh</span>
                </div>
                <div class="card-prompt" style="color:${palette.foreground}">$ ls</div>
                <span class="card-cursor" style="background:${palette.cursor}"></span>
              </div>
              <div class="card-label">${card.label}</div>
              ${isActive ? html`<div class="card-check">✓</div>` : ''}
            </div>
          `;
        });
  }

  private _renderThemeCards() {
    const current = this.config?.theme.palette ?? 'tokyo-night';
    return html`
      <div class="theme-grid">
        ${this._renderThemeGroup(DARK_THEMES, current)}
      </div>
      <p class="section-title" style="margin-top:16px">Light</p>
      <div class="theme-grid">
        ${this._renderThemeGroup(LIGHT_THEMES, current)}
      </div>
    `;
  }



  private _renderFontPicker() {
    const cfg = this.config;
    if (!cfg) return html``;
    const family = cfg.font.family;
    const size = cfg.font.size;

    return html`
      <div class="font-radios">
        ${FONT_FAMILIES.map(f => html`
          <label class="font-radio-label">
            <input
              type="radio"
              name="font-family"
              .checked="${family === f.id}"
              @change="${() => this._setFontFamily(f.id)}"
            />
            <span class="font-radio-name" style="font-family:'${f.id}',monospace">${f.label}</span>
          </label>
        `)}
      </div>
      <div class="size-row">
        <span class="size-label">Size</span>
        <input
          type="range"
          min="8" max="24" step="1"
          .value="${String(size)}"
          @input="${(e: Event) => {
            const v = parseInt((e.target as HTMLInputElement).value, 10);
            this._setFontSize(v);
          }}"
        />
        <span class="size-value">${size}</span>
      </div>
      <div
        class="font-preview"
        style="font-family:'${family}',monospace;font-size:${size}px"
      >The quick brown fox jumps $ █</div>
    `;
  }

  private _renderNotifPermission() {
    const perm = this._notifPermission;

    if (perm === 'unsupported') {
      return html`
        <p class="notif-description">
          Desktop notifications are not supported in this browser.
        </p>
      `;
    }

    if (perm === 'granted') {
      return html`
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="notif-status granted">✓ Desktop Notifications: Enabled</span>
          <button class="notif-test-btn" @click="${() => this._sendTestNotification()}">
            Send test notification
          </button>
        </div>
        <p class="notif-hint" style="margin-top:8px">
          Notifications appear when a bell fires in a background pane.
          If the test notification doesn't appear, check
          <strong>System Settings → Notifications → [your browser]</strong>
          and make sure "Allow Notifications" is on. macOS Focus / Do Not Disturb
          also suppresses them.
        </p>
      `;
    }

    if (perm === 'denied') {
      return html`
        <span class="notif-status denied">
          Blocked by browser — update in browser settings
        </span>
        <br>
        <a
          class="notif-help-link"
          href="https://support.google.com/chrome/answer/3220216"
          target="_blank"
          rel="noopener noreferrer"
        >How to re-enable notifications →</a>
      `;
    }

    // default: not yet requested (or dismissed without choosing)
    return html`
      <button
        class="notif-btn"
        ?disabled="${this._notifRequesting}"
        @click="${() => this._requestNotificationPermission()}"
      >${this._notifRequesting ? 'Waiting for browser…' : 'Enable Desktop Notifications'}</button>
      ${this._notifRequesting ? html`
        <p class="notif-hint">
          Look for a permission prompt in your browser's address bar or toolbar.
        </p>
      ` : ''}
    `;
  }

  private _renderAppearance() {
    const cfg = this.config;
    if (!cfg) return html``;
    return html`
      <p class="section-title">Theme</p>
      ${this._renderThemeCards()}

      <div class="section-gap">
        <p class="section-title">Font</p>
        ${this._renderFontPicker()}
      </div>
    `;
  }

  private _renderNotifications() {
    const cfg = this.config;
    if (!cfg) return html``;
    const bell = cfg.terminal.bell;

    return html`
      <div class="notif-block">
        <p class="section-title">Desktop Alerts</p>
        <p class="notif-description">
          Allow muxterm to send desktop notifications when a terminal needs your attention.
        </p>
        ${this._renderNotifPermission()}
      </div>

      <div class="divider"></div>

      <p class="section-title">Bell</p>
      <div class="bell-radios">
        <label class="bell-radio-label">
          <input
            type="radio"
            name="bell"
            .checked="${bell === 'visual'}"
            @change="${() => this._setBell('visual')}"
          />
          <div class="bell-radio-text">
            <span class="bell-radio-name">Visual</span>
            <span class="bell-radio-desc">Flash the pane tab</span>
          </div>
        </label>
        <label class="bell-radio-label">
          <input
            type="radio"
            name="bell"
            .checked="${bell === 'audible'}"
            @change="${() => this._setBell('audible')}"
          />
          <div class="bell-radio-text">
            <span class="bell-radio-name">Audible</span>
            <span class="bell-radio-desc">Play the system bell sound</span>
          </div>
        </label>
        <label class="bell-radio-label">
          <input
            type="radio"
            name="bell"
            .checked="${bell === 'off'}"
            @change="${() => this._setBell('off')}"
          />
          <div class="bell-radio-text">
            <span class="bell-radio-name">Off</span>
            <span class="bell-radio-desc">Silence all bell events</span>
          </div>
        </label>
      </div>
    `;
  }

  override render() {
    if (!this.config) return html``;

    return html`
      <div class="header">
        <h2>Settings</h2>
        <button class="close-btn" title="Close" @click="${this._close}">×</button>
      </div>
      <div class="body">
        <nav class="sidebar">
          <button
            class="sidebar-item ${this._section === 'appearance' ? 'active' : ''}"
            @click="${() => { this._section = 'appearance'; }}"
          >Appearance</button>
          <button
            class="sidebar-item ${this._section === 'notifications' ? 'active' : ''}"
            @click="${() => { this._section = 'notifications'; }}"
          >Notifications</button>
        </nav>
        <div class="content">
          ${this._section === 'appearance'
            ? this._renderAppearance()
            : this._renderNotifications()}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-settings-surface': MuxSettingsSurface;
  }
}
