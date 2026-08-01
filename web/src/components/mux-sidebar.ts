import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { workspaceLabel } from './workspace-picker.js';
import './launcher-menu.js';
import { icon } from '../lib/icons.js';
import { Ellipsis } from 'lucide';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../lib/sidebar-width.js';

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
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
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
      transition: background 0.12s, border-color 0.12s, opacity 0.2s;
    }

    .ws-card:hover {
      background: var(--chrome-hover);
    }

    .ws-card.active {
      background: var(--chrome-hover);
      border-color: var(--chrome-accent);
    }

    .ws-card.pending-close {
      opacity: 0.35;
      pointer-events: none;
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
    .ws-card.active .ws-remove-btn {
      opacity: 1;
    }

    .ws-remove-btn:hover {
      color: var(--chrome-danger);
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
  `;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  @state() private _version = 0;
  @state() private _renaming: string | null = null;
  @state() private _pendingClose = new Set<string>();
  @state() private _menuOpen = false;

  private _unsub: (() => void) | null = null;

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
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Remove a workspace from the pending-close set (called by the parent to restore). */
  restoreWorkspace(wsId: string): void {
    const next = new Set(this._pendingClose);
    next.delete(wsId);
    this._pendingClose = next;
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
    const next = new Set(this._pendingClose);
    next.add(wsId);
    this._pendingClose = next;
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
        const isPendingClose = this._pendingClose.has(ws.workspaceId);
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
            class="ws-card ${isActive ? 'active' : ''} ${isPendingClose ? 'pending-close' : ''}"
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
                class="ws-remove-btn"
                title="Remove workspace"
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
  // Render
  // ---------------------------------------------------------------------------

  override render() {
    void this._version; // suppress unused-variable lint; triggers re-render on store change
    return html`
      <div class="header">
        <span>muxterm</span>
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
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-sidebar': MuxSidebar;
  }
}
