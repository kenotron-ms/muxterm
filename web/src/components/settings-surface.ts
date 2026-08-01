import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { PALETTES } from '../lib/theme.js';
import { FONT_FAMILIES } from '../lib/fonts.js';
import type { ResolvedConfig } from '../lib/config.js';
import {
  instanceLabel,
  restoreTitlebarColor,
  persistTitlebarColor,
  applyTitlebarColor,
} from '../lib/instance-identity.js';

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
      background: var(--chrome-body);
      color: var(--chrome-text-bright);
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
      border-bottom: 1px solid var(--chrome-border);
      flex-shrink: 0;
    }

    .header h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--chrome-text-bright);
    }

    .close-btn {
      background: transparent;
      border: none;
      color: var(--chrome-text-dim);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 3px 7px;
      border-radius: 4px;
      transition: color 0.1s, background 0.1s;
    }
    .close-btn:hover {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
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
      border-right: 1px solid var(--chrome-border);
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
      color: var(--chrome-text-dim);
      text-align: left;
      border-radius: 0;
      transition: color 0.1s, background 0.1s;
    }
    .sidebar-item:hover {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
    }
    .sidebar-item.active {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
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
      color: var(--chrome-text-dim);
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
      border-color: var(--chrome-accent);
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
      color: var(--chrome-text-dim);
      background: var(--chrome-bar);
    }
    .theme-card.active .card-label {
      color: var(--chrome-text-bright);
    }

    .card-check {
      position: absolute;
      top: 5px;
      right: 7px;
      font-size: 10px;
      color: var(--chrome-accent);
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
      background: var(--chrome-hover);
    }

    .font-radio-label input[type="radio"] {
      accent-color: var(--chrome-accent);
      width: 14px;
      height: 14px;
      cursor: pointer;
      flex-shrink: 0;
    }

    .font-radio-name {
      flex: 1;
      color: var(--chrome-text-bright);
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
      color: var(--chrome-text-dim);
      width: 64px;
      flex-shrink: 0;
    }

    input[type="range"] {
      flex: 1;
      accent-color: var(--chrome-accent);
      height: 4px;
      cursor: pointer;
    }

    .size-value {
      width: 28px;
      text-align: right;
      color: var(--chrome-text-bright);
      font-feature-settings: 'tnum';
    }

    /* ── Font preview line ── */
    .font-preview {
      margin: 10px 0 0 10px;
      padding: 8px 12px;
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      font-size: 12px;
      color: var(--chrome-text-bright);
      overflow: hidden;
      white-space: nowrap;
    }

    /* ── Notifications section ── */
    .notif-block {
      max-width: 480px;
    }

    .notif-description {
      color: var(--chrome-text-dim);
      line-height: 1.55;
      margin: 0 0 14px 0;
    }

    .notif-btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 14px;
      border-radius: 6px;
      border: 1px solid var(--chrome-accent);
      background: transparent;
      color: var(--chrome-accent);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .notif-btn:hover {
      background: var(--chrome-accent);
      color: var(--chrome-body);
    }

    .notif-status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--chrome-text-dim);
      font-size: 13px;
    }
    .notif-status.granted {
      color: #9ece6a; /* tokyo-night green */
    }
    .notif-status.denied {
      color: var(--chrome-danger);
    }

    .notif-help-link {
      display: inline-block;
      margin-top: 6px;
      font-size: 11px;
      color: var(--chrome-accent);
      text-decoration: none;
    }
    .notif-help-link:hover {
      text-decoration: underline;
    }

    .notif-hint {
      margin-top: 8px;
      font-size: 11px;
      color: var(--chrome-text-dim);
      line-height: 1.5;
    }

    .notif-test-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 11px;
      border-radius: 6px;
      border: 1px solid var(--chrome-border);
      background: transparent;
      color: var(--chrome-text-dim);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: border-color 0.12s, color 0.12s;
    }
    .notif-test-btn:hover {
      border-color: var(--chrome-accent);
      color: var(--chrome-text-bright);
    }

    /* ── Theme section label ── */
    .theme-section-label {
      grid-column: 1 / -1;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--chrome-text-dim);
      padding-top: 8px;
    }

    .divider {
      height: 1px;
      background: var(--chrome-border);
      margin: 22px 0;
    }

    /* ── Title bar color picker ── */
    .titlebar-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .titlebar-swatch {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      border: 1px solid var(--chrome-border);
      padding: 0;
      cursor: pointer;
      flex-shrink: 0;
      /* Native color input chrome varies a lot by browser — strip it down
         to just the swatch so it matches the rest of the UI. */
      -webkit-appearance: none;
      appearance: none;
      background: none;
    }
    .titlebar-swatch::-webkit-color-swatch-wrapper {
      padding: 0;
    }
    .titlebar-swatch::-webkit-color-swatch {
      border: none;
      border-radius: 7px;
    }

    .titlebar-reset-btn {
      background: transparent;
      border: 1px solid var(--chrome-border);
      color: var(--chrome-text-dim);
      border-radius: 6px;
      padding: 7px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: border-color 0.1s, color 0.1s;
    }
    .titlebar-reset-btn:hover {
      border-color: var(--chrome-accent);
      color: var(--chrome-text-bright);
    }

    .titlebar-hint {
      font-size: 12px;
      color: var(--chrome-text-dim);
      margin: 0;
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
      background: var(--chrome-hover);
    }

    .bell-radio-label input[type="radio"] {
      accent-color: var(--chrome-accent);
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
      color: var(--chrome-text-bright);
    }

    .bell-radio-desc {
      font-size: 11px;
      color: var(--chrome-text-dim);
    }
  `;

  @property({ attribute: false }) config: ResolvedConfig | null = null;
  @property({ type: String }) serverAddr = '';

  @state() private _section: 'appearance' | 'notifications' = 'appearance';
  @state() private _notifPermission: NotificationPermission | 'unsupported' = 'default';
  @state() private _notifRequesting = false;
  // Per-browser (localStorage), not server config — distinguishes this
  // machine's window/PWA from other muxterm instances. See instance-identity.ts.
  @state() private _titlebarColor: string | null = restoreTitlebarColor();

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

  /** Applies + persists a new title-bar accent color immediately (no server round trip). */
  private _setTitlebarColor(color: string): void {
    this._titlebarColor = color;
    persistTitlebarColor(color);
    applyTitlebarColor(color);
  }

  /** Clears the custom title-bar color, reverting to the current theme's default. */
  private _resetTitlebarColor(): void {
    this._titlebarColor = null;
    persistTitlebarColor(null);
    applyTitlebarColor(null);
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

      <div class="section-gap">
        <p class="section-title">Title Bar Color</p>
        ${this._renderTitlebarColorPicker()}
      </div>
    `;
  }

  /** Live --chrome-bar value (theme's current default), as a fallback swatch
   *  seed when no custom title-bar color has been picked yet. Native
   *  <input type="color"> requires an exact 6-digit hex, which is what every
   *  built-in theme's `bar` token already is (see theme.ts CHROME_DARK/LIGHT). */
  private get _currentChromeBarHex(): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--chrome-bar').trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#16161e';
  }

  private _renderTitlebarColorPicker() {
    const color = this._titlebarColor;
    return html`
      <div class="titlebar-row">
        <input
          class="titlebar-swatch"
          type="color"
          title="Pick a title bar color"
          .value="${color ?? this._currentChromeBarHex}"
          @input="${(e: Event) => this._setTitlebarColor((e.target as HTMLInputElement).value)}"
        />
        <button class="titlebar-reset-btn" @click="${() => this._resetTitlebarColor()}">
          Use theme default
        </button>
      </div>
      <p class="titlebar-hint" style="margin-top:8px">
        Only affects this browser on <strong>${instanceLabel()}</strong> — handy for
        telling multiple muxterm instances apart at a glance.
      </p>
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
