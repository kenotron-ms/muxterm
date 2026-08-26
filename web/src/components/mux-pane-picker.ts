import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { workspaceLabel } from './workspace-picker.js';

@customElement('mux-pane-picker')
export class MuxPanePicker extends LitElement {
  static styles = css`
    :host {
      position: relative;
      display: flex;
      align-items: center;
      flex: 1;
      min-width: 0;
      min-height: 44px;
      justify-content: flex-end;
    }

    @media (min-width: 769px) {
      :host {
        display: none;
      }
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 44px;
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      font-size: 0.85rem;
      cursor: pointer;
      padding: 0 8px;
      max-width: 220px;
      white-space: nowrap;
      overflow: hidden;
    }

    .pane-name {
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bell-dot {
      color: var(--mux-bell, var(--mux-warn, #e0af68));
      flex-shrink: 0;
    }

    .bell-spacer {
      display: inline-block;
      width: 1em;
      flex-shrink: 0;
    }

    .dropdown {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      min-width: 200px;
      max-width: 300px;
      z-index: 2000;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      padding: 4px;
    }

    .section-label {
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--chrome-text-dim);
      padding: 4px 8px 2px;
      pointer-events: none;
    }

    .section-divider {
      height: 1px;
      background: var(--chrome-border);
      margin: 4px 4px;
    }

    .picker-row {
      display: flex;
      align-items: stretch;
      gap: 2px;
      width: 100%;
    }

    .ws-item {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
      min-height: 44px;
      padding: 6px 8px;
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      font-size: 0.85rem;
      cursor: pointer;
      border-radius: 4px;
      text-align: left;
    }

    .ws-item:hover {
      background: rgba(122, 162, 247, 0.12);
    }

    .ws-item.active {
      color: var(--mux-accent, #7aa2f7);
      font-weight: 600;
    }

    .pane-item {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
      min-height: 44px;
      padding: 6px 8px;
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      font-size: 0.85rem;
      cursor: pointer;
      border-radius: 4px;
      text-align: left;
    }

    .pane-item:hover {
      background: rgba(122, 162, 247, 0.12);
    }

    .pane-item.active {
      color: var(--mux-accent, #7aa2f7);
    }

    .row-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 44px;
      min-width: 44px;
      min-height: 44px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--chrome-text-dim);
      font: inherit;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    }

    .row-close:hover {
      background: rgba(247, 118, 142, 0.14);
      color: var(--chrome-danger);
    }

    .pane-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .check {
      opacity: 0;
      flex-shrink: 0;
    }

    .pane-item.active .check,
    .ws-item.active .check {
      opacity: 1;
    }

    @media (pointer: coarse) {
      .ws-item,
      .pane-item,
      .row-close {
        min-height: 44px;
      }

      .row-close {
        flex-basis: 44px;
        min-width: 44px;
      }
    }
  `;

  @state() private _open = false;
  @state() private _version = 0;

  private _unsubscribe: (() => void) | null = null;

  private _onOutsideClick = (e: MouseEvent): void => {
    if (this._open && !e.composedPath().includes(this)) {
      this._open = false;
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this._unsubscribe = store.subscribe(() => {
      this._version++;
    });
    document.addEventListener('mousedown', this._onOutsideClick);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
    document.removeEventListener('mousedown', this._onOutsideClick);
  }

  private _toggle(): void {
    this._open = !this._open;
  }

  private _selectPane(paneId: number): void {
    this._open = false;
    store.ackPane(paneId);
    this.dispatchEvent(
      new CustomEvent('pane-select', {
        detail: { paneId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _selectWorkspace(workspaceId: string): void {
    this._open = false;
    store.ackWorkspace(workspaceId);
    this.dispatchEvent(
      new CustomEvent('workspace-switch', {
        detail: { workspaceId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _closePane(e: Event, workspaceId: string | null, paneId: number): void {
    e.stopPropagation();
    if (!workspaceId) return;
    this._open = false;
    this.dispatchEvent(
      new CustomEvent('pane-close', {
        detail: { workspaceId, paneId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _closeWorkspace(e: Event, workspaceId: string): void {
    e.stopPropagation();
    this._open = false;
    this.dispatchEvent(
      new CustomEvent('workspace-close', {
        detail: { workspaceId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    // Suppress unused-variable lint — _version is read to create a reactive
    // dependency so store subscription bumps trigger re-renders.
    void this._version;

    const { panes, activePaneId, workspaces, attached } = store;
    const validPanes = panes.filter((p) => p.paneId >= 0);
    const activePane = validPanes.find((p) => p.paneId === activePaneId);

    // Workspace label: prefer named workspace, fall back to attached id.
    const ws = workspaces.find((w) => w.workspaceId === attached);
    const wsName = ws ? workspaceLabel(ws) : (attached ?? '');

    // Active pane display name.
    const activePaneName =
      activePane?.title ?? (activePaneId >= 0 ? `Pane ${activePaneId}` : '—');

    const activeBell = activePaneId >= 0 && store.paneBellActive(activePaneId);

    return html`
      <button class="breadcrumb" @click="${this._toggle}">
        <span>${wsName} ›</span>
        ${activeBell ? html`<span class="bell-dot">●</span>` : ''}
        <span class="pane-name">${activePaneName}</span>
        <span>▾</span>
      </button>
      ${this._open
        ? html`
            <div class="dropdown">
              ${workspaces.length > 0 ? html`
                <div class="section-label">Workspaces</div>
                ${workspaces.map((w) => {
                  const isActive = w.workspaceId === attached;
                  const hasBell = !isActive && store.workspaceBellActive(w.workspaceId);
                  const label = workspaceLabel(w);
                  return html`
                    <div class="picker-row">
                      <button
                        type="button"
                        class="ws-item ${isActive ? 'active' : ''}"
                        @click="${() => this._selectWorkspace(w.workspaceId)}"
                      >
                        ${hasBell
                          ? html`<span class="bell-dot">●</span>`
                          : html`<span class="bell-spacer"></span>`}
                        <span class="pane-label">${label}</span>
                        <span class="check">✓</span>
                      </button>
                      <button
                        type="button"
                        class="row-close workspace-close"
                        aria-label="Close workspace ${label}"
                        title="Close workspace"
                        @click="${(e: Event) => this._closeWorkspace(e, w.workspaceId)}"
                      >×</button>
                    </div>
                  `;
                })}
                <div class="section-divider"></div>
              ` : ''}
              <div class="section-label">Panes</div>
              ${validPanes.map((p) => {
                const isActive = p.paneId === activePaneId;
                const hasBell = store.paneBellActive(p.paneId);
                const label = p.title ?? `Pane ${p.paneId}`;
                return html`
                  <div class="picker-row">
                    <button
                      type="button"
                      class="pane-item ${isActive ? 'active' : ''}"
                      @click="${() => this._selectPane(p.paneId)}"
                    >
                      ${hasBell
                        ? html`<span class="bell-dot">●</span>`
                        : html`<span class="bell-spacer"></span>`}
                      <span class="pane-label">${label}</span>
                      <span class="check">✓</span>
                    </button>
                    <button
                      type="button"
                      class="row-close pane-close"
                      aria-label="Close pane ${label}"
                      title="Close pane"
                      @click="${(e: Event) => this._closePane(e, attached, p.paneId)}"
                    >×</button>
                  </div>
                `;
              })}
            </div>
          `
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-pane-picker': MuxPanePicker;
  }
}
