import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { workspaceLabel } from './workspace-picker.js';
import './launcher-menu.js';
import { icon } from '../lib/icons.js';
import { Download, Ellipsis } from 'lucide';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../lib/sidebar-width.js';
import { instanceLabel } from '../lib/instance-identity.js';
import {
  fetchUpdateStatus,
  applyUpdate,
  UpdateEndpointMissingError,
  type UpdateStatus,
} from '../lib/update.js';

// ---------------------------------------------------------------------------
// Self-update footer
// ---------------------------------------------------------------------------

/** UI phase of the footer's update control. */
type UpdatePhase = 'idle' | 'checking' | 'updating' | 'failed';

/** Poll cadence while waiting for the restarted server to report a new version. */
const UPDATE_POLL_INTERVAL_MS = 1000;
/** Give up after this many polls (~60s) and surface a failure. */
const UPDATE_POLL_MAX_ATTEMPTS = 60;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement('mux-sidebar')
export class MuxSidebar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: var(--chrome-bar);
      border-right: 1px solid var(--chrome-border);
      min-width: ${unsafeCSS(String(SIDEBAR_MIN_WIDTH))}px;
      max-width: ${unsafeCSS(String(SIDEBAR_MAX_WIDTH))}px;
      height: 100%;
      position: relative;
      overflow: hidden;
      user-select: none;
      box-sizing: border-box;
      flex-shrink: 0;
    }

    .header {
      padding: 10px 12px 8px;
      font-size: 13px;
      font-weight: 700;
      color: var(--chrome-text-bright);
      letter-spacing: 0.06em;
      border-bottom: 1px solid var(--chrome-border);
      /* Falls back to transparent (i.e. the sidebar's own --chrome-bar shows
         through) unless the user picked a custom title-bar color in Settings. */
      background: var(--mux-titlebar-bg, transparent);
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .header > span {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .launcher-btn {
      width: 26px;
      height: 22px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--mux-text-bright, #c0caf5);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      flex-shrink: 0;
    }

    .launcher-btn:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .menu-anchor {
      position: absolute;
      top: 38px;
      left: 8px;
      z-index: 1500;
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
      pointer-events: none;
    }

    .tab-content {
      flex: 1;
      overflow-y: auto;
      padding: 6px 0;
    }

    /* ---- workspace cards ---- */

    .ws-card {
      padding: 7px 10px;
      margin: 2px 6px;
      border-radius: 5px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.12s, border-color 0.12s;
    }

    .ws-card:hover {
      background: var(--chrome-hover);
    }

    .ws-card.active {
      background: var(--chrome-hover);
      border-color: var(--chrome-accent);
    }

    .ws-header {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .dot {
      font-size: 7px;
      flex-shrink: 0;
      line-height: 1;
    }

    .dot.active {
      color: var(--chrome-accent);
    }

    .dot.inactive {
      color: var(--chrome-text-dim);
    }

    .ws-name {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
      color: var(--chrome-text-bright);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .ws-rename-input {
      flex: 1;
      background: var(--chrome-body);
      border: 1px solid var(--chrome-accent);
      border-radius: 3px;
      color: var(--chrome-text-bright);
      font: inherit;
      font-size: 13px;
      padding: 1px 5px;
      outline: none;
      min-width: 0;
    }

    .ws-rename-input:focus {
      box-shadow: 0 0 0 2px var(--chrome-accent)33;
    }

    .ws-remove-btn {
      flex-shrink: 0;
      background: transparent;
      border: none;
      color: var(--chrome-text-dim);
      cursor: pointer;
      padding: 1px 3px;
      border-radius: 3px;
      font-size: 13px;
      line-height: 1;
      opacity: 0;
      transition: opacity 0.12s, color 0.12s;
    }

    .ws-card:hover .ws-remove-btn,
    .ws-card.active .ws-remove-btn,
    .ws-remove-btn:focus-visible {
      opacity: 1;
    }

    .ws-remove-btn:hover {
      color: var(--chrome-danger);
    }

    .ws-remove-btn:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }

    @media (pointer: coarse) {
      .ws-remove-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        padding: 0;
        opacity: 1;
      }
    }

    .ws-hint {
      font-size: 11px;
      color: var(--chrome-text-dim);
      margin-top: 2px;
      padding-left: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .new-ws-btn {
      display: block;
      width: calc(100% - 12px);
      margin: 6px 6px 4px;
      padding: 7px 10px;
      background: transparent;
      border: 1px dashed var(--chrome-text-dim);
      border-radius: 5px;
      color: var(--chrome-accent);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s;
    }

    .new-ws-btn:hover {
      border-color: var(--chrome-accent);
      background: var(--chrome-hover);
    }

    /* ---- update footer (pinned; never scrolls with .tab-content) ---- */

    .footer {
      flex-shrink: 0;
      padding: 8px 12px 10px;
      border-top: 1px solid var(--chrome-border);
    }

    .footer-line {
      font-size: 12px;
      color: var(--chrome-text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .footer-note {
      font-size: 11px;
      color: var(--chrome-text-dim);
      margin-top: 2px;
      overflow-wrap: anywhere;
    }

    .update-btn {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      margin-top: 6px;
      padding: 6px 10px;
      background: transparent;
      border: 1px solid var(--chrome-accent);
      border-radius: 5px;
      color: var(--chrome-accent);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }

    .update-btn:hover {
      background: var(--chrome-hover);
    }

    .update-btn:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }

    .update-btn:disabled {
      cursor: default;
      opacity: 0.55;
      border-color: var(--chrome-border);
      color: var(--chrome-text-dim);
    }

    .update-btn:disabled:hover {
      background: transparent;
    }
  `;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  @state() private _version = 0;
  @state() private _renaming: string | null = null;
  @state() private _menuOpen = false;

  /** Server-reported update status; null until the first check resolves. */
  @state() private _updateStatus: UpdateStatus | null = null;
  @state() private _updatePhase: UpdatePhase = 'idle';
  @state() private _updateError = '';

  private _unsub: (() => void) | null = null;
  private _updatePollTimer: number | null = null;
  private _updatePollAttempts = 0;

  private _onOutsideClick = (e: MouseEvent): void => {
    if (this._menuOpen && !e.composedPath().includes(this)) {
      this._menuOpen = false;
    }
  };

  private _onLauncherAction(e: Event): void {
    e.stopPropagation();
    this._menuOpen = false;
    const customEvent = e as CustomEvent;
    this.dispatchEvent(new CustomEvent('launcher-action', {
      bubbles: true,
      composed: true,
      detail: customEvent.detail,
    }));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('mousedown', this._onOutsideClick);

    // Subscribe to store changes and trigger re-render by bumping _version.
    this._unsub = store.subscribe(() => {
      this._version++;
    });
  }

  override disconnectedCallback(): void {
    document.removeEventListener('mousedown', this._onOutsideClick);
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
    this._clearUpdatePoll();
  }

  /** One status check, after first paint — the footer never blocks rendering. */
  override firstUpdated(): void {
    this._updatePhase = 'checking';
    void fetchUpdateStatus()
      .then((status) => {
        this._updateStatus = status;
      })
      .catch(() => {
        // Status unknown (offline, old server): the footer stays empty.
      })
      .finally(() => {
        if (this._updatePhase === 'checking') this._updatePhase = 'idle';
      });
  }

  // ---------------------------------------------------------------------------
  // Self-update
  // ---------------------------------------------------------------------------

  /** Starts (or retries) the update. Safe to call from both button states. */
  private _onUpdateClick(): void {
    if (this._updatePhase === 'updating') return;
    const previousVersion = this._updateStatus?.currentVersion ?? '';
    this._updatePhase = 'updating';
    this._updateError = '';
    this._updatePollAttempts = 0;
    void applyUpdate()
      .then(() => {
        // Binary replaced; the server restarts ~500ms later.
        this._scheduleUpdatePoll(previousVersion);
      })
      .catch((e: unknown) => {
        this._updatePhase = 'failed';
        this._updateError = e instanceof Error ? e.message : String(e);
      });
  }

  private _clearUpdatePoll(): void {
    if (this._updatePollTimer !== null) {
      window.clearTimeout(this._updatePollTimer);
      this._updatePollTimer = null;
    }
  }

  private _scheduleUpdatePoll(previousVersion: string): void {
    this._clearUpdatePoll();
    this._updatePollTimer = window.setTimeout(() => {
      this._updatePollTimer = null;
      void this._pollForRestart(previousVersion);
    }, UPDATE_POLL_INTERVAL_MS);
  }

  /**
   * Waits for the restarted server to report a different currentVersion, then
   * reloads. Poll failures are EXPECTED while the server is down and are
   * swallowed — only the attempt budget running out counts as a failure.
   */
  private async _pollForRestart(previousVersion: string): Promise<void> {
    if (!this.isConnected || this._updatePhase !== 'updating') return;
    this._updatePollAttempts++;
    try {
      const status = await fetchUpdateStatus();
      if (status.currentVersion !== '' && status.currentVersion !== previousVersion) {
        window.location.reload();
        return;
      }
    } catch (e: unknown) {
      // A 404 means an HTTP server is back up but has no update endpoint —
      // the restart landed on a build predating this feature, so the update
      // worked. Reload rather than time out and cry failure.
      if (e instanceof UpdateEndpointMissingError) {
        window.location.reload();
        return;
      }
      // Otherwise the server is still restarting; connection errors are normal.
    }
    if (!this.isConnected || this._updatePhase !== 'updating') return;
    if (this._updatePollAttempts >= UPDATE_POLL_MAX_ATTEMPTS) {
      this._updatePhase = 'failed';
      this._updateError = 'Update did not complete in time';
      return;
    }
    this._scheduleUpdatePoll(previousVersion);
  }

  // ---------------------------------------------------------------------------
  // Workspace helpers
  // ---------------------------------------------------------------------------

  private _onWsClick(wsId: string): void {
    store.ackWorkspace(wsId);
    this.dispatchEvent(
      new CustomEvent('workspace-switch', {
        detail: { workspaceId: wsId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onNewWs(): void {
    this.dispatchEvent(
      new CustomEvent('workspace-create', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onWsRemove(e: Event, wsId: string, name: string): void {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('workspace-close', {
        detail: { workspaceId: wsId, name },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _startRename(e: Event, wsId: string): void {
    e.stopPropagation();
    this._renaming = wsId;
    requestAnimationFrame(() => {
      const input = this.shadowRoot?.querySelector<HTMLInputElement>('.ws-rename-input');
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  private _finishRename(e: Event, wsId: string): void {
    const name = (e.target as HTMLInputElement).value.trim();
    this._renaming = null;
    if (name) {
      this.dispatchEvent(
        new CustomEvent('workspace-rename', {
          detail: { workspaceId: wsId, name },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private _onRenameKeyDown(e: KeyboardEvent, wsId: string): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const name = (e.target as HTMLInputElement).value.trim();
      this._renaming = null;
      if (name) {
        this.dispatchEvent(
          new CustomEvent('workspace-rename', {
            detail: { workspaceId: wsId, name },
            bubbles: true,
            composed: true,
          }),
        );
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this._renaming = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Workspace render
  // ---------------------------------------------------------------------------

  private _renderWorkspaces() {
    const activeWsId = store.attached ?? '';
    const panes = store.panes;

    return html`
      ${store.workspaces.map((ws) => {
        const isActive = ws.workspaceId === activeWsId;
        const label = workspaceLabel(ws);

        // Hint row: active pane title + extra pane count (only for the attached workspace).
        let hintText = '';
        if (isActive && panes.length > 0) {
          const activePane =
            panes.find((p) => p.paneId === store.activePaneId) ?? panes[0];
          const title = activePane.title ?? '';
          const extra = panes.length - 1;
          hintText = extra > 0 ? `${title}  +${extra}` : title;
        }

        return html`
          <div
            class="ws-card ${isActive ? 'active' : ''}"
            @click="${() => this._onWsClick(ws.workspaceId)}"
          >
            <div class="ws-header">
              <span class="dot ${isActive ? 'active' : 'inactive'}">●</span>
              ${this._renaming === ws.workspaceId
                ? html`<input
                    class="ws-rename-input"
                    type="text"
                    .value="${label}"
                    @keydown="${(e: KeyboardEvent) =>
                      this._onRenameKeyDown(e, ws.workspaceId)}"
                    @blur="${(e: Event) => this._finishRename(e, ws.workspaceId)}"
                    @click="${(e: Event) => e.stopPropagation()}"
                  />`
                : html`<span
                    class="ws-name"
                    @dblclick="${(e: Event) => this._startRename(e, ws.workspaceId)}"
                    >${label}</span
                  >`}
              <button
                type="button"
                class="ws-remove-btn"
                title="Close workspace"
                aria-label="Close workspace ${label}"
                @click="${(e: Event) => this._onWsRemove(e, ws.workspaceId, label)}"
              >×</button>
            </div>
            ${hintText
              ? html`<div class="ws-hint">${hintText}</div>`
              : ''}
          </div>
        `;
      })}
      <button class="new-ws-btn" @click="${() => this._onNewWs()}">
        + New workspace
      </button>
    `;
  }

  // ---------------------------------------------------------------------------
  // Footer render
  // ---------------------------------------------------------------------------

  private _renderFooter() {
    // Failure survives a stale/unknown status, so it is checked first.
    if (this._updatePhase === 'failed') {
      return html`
        <div class="footer">
          <div class="footer-line">Update failed</div>
          <div class="footer-note">${this._updateError}</div>
          <button class="update-btn" @click="${() => this._onUpdateClick()}">
            ${icon(Download, { size: 14 })}Retry
          </button>
        </div>
      `;
    }

    const status = this._updateStatus;
    if (!status) return ''; // check still in flight (or it failed): show nothing

    const versionLine = status.currentVersion
      ? `muxterm ${status.currentVersion}`
      : 'muxterm';

    if (this._updatePhase === 'updating') {
      return html`
        <div class="footer">
          <div class="footer-line">${versionLine}</div>
          <button class="update-btn" disabled>
            ${icon(Download, { size: 14 })}Updating…
          </button>
          <div class="footer-note">downloading and restarting…</div>
        </div>
      `;
    }

    // Dev build: nothing actionable, by design.
    if (status.devBuild) {
      return html`
        <div class="footer">
          <div class="footer-line">${versionLine}</div>
          <div class="footer-note">${status.reason || 'dev build — updates disabled'}</div>
        </div>
      `;
    }

    if (status.canUpdate) {
      const label = status.latestVersion ? `Update to ${status.latestVersion}` : 'Update';
      return html`
        <div class="footer">
          <div class="footer-line">${versionLine}</div>
          <button class="update-btn" @click="${() => this._onUpdateClick()}">
            ${icon(Download, { size: 14 })}${label}
          </button>
        </div>
      `;
    }

    // Newer release exists but this install cannot self-update (Homebrew,
    // unsupported platform): the server's reason, muted and non-actionable.
    if (status.updateAvailable) {
      return html`
        <div class="footer">
          <div class="footer-line">${versionLine}</div>
          <div class="footer-note">
            ${status.reason || 'update available — updates not supported here'}
          </div>
        </div>
      `;
    }

    // A failed release check is NOT "up to date" — we never learned what the
    // latest version is. Saying otherwise would be a lie the user can't see
    // through.
    return html`
      <div class="footer">
        <div class="footer-line">${versionLine}</div>
        <div class="footer-note">
          ${status.error ? 'update check unavailable' : 'up to date'}
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  override render() {
    void this._version; // suppress unused-variable lint; triggers re-render on store change
    return html`
      <div class="header">
        <span title="${window.location.hostname}">${instanceLabel()}</span>
        <button
          class="launcher-btn"
          title="Open menu"
          @click="${() => { this._menuOpen = !this._menuOpen; }}"
        >${icon(Ellipsis, { size: 15 })}</button>
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu
                @launcher-action="${(e: Event) => this._onLauncherAction(e)}"
              ></mux-launcher-menu>
            </div>`
          : ''}
      </div>
      <div class="tab-content">
        ${this._renderWorkspaces()}
      </div>
      ${this._renderFooter()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-sidebar': MuxSidebar;
  }
}
