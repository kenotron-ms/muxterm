import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { CHROME } from '../lib/theme.js';
import { workspaceLabel } from './workspace-picker.js';

@customElement('mux-pane-picker')
export class MuxPanePicker extends LitElement {
  static styles = css`
    :host {
      position: relative;
      display: flex;
      align-items: center;
      flex: 1;
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
      min-height: 32px;
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
      background: ${unsafeCSS(CHROME.bar)};
      border: 1px solid ${unsafeCSS(CHROME.border)};
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
      color: ${unsafeCSS(CHROME.textDim)};
      padding: 4px 8px 2px;
      pointer-events: none;
    }

    .section-divider {
      height: 1px;
      background: ${unsafeCSS(CHROME.border)};
      margin: 4px 4px;
    }

    .ws-item {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
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
      width: 100%;
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
              ${workspaces.length > 1 ? html`
                <div class="section-label">Workspaces</div>
                ${workspaces.map((w) => {
                  const isActive = w.workspaceId === attached;
                  const hasBell = !isActive && store.workspaceBellActive(w.workspaceId);
                  return html`
                    <button
                      class="ws-item ${isActive ? 'active' : ''}"
                      @click="${() => this._selectWorkspace(w.workspaceId)}"
                    >
                      ${hasBell
                        ? html`<span class="bell-dot">●</span>`
                        : html`<span class="bell-spacer"></span>`}
                      <span class="pane-label">${workspaceLabel(w)}</span>
                      <span class="check">✓</span>
                    </button>
                  `;
                })}
                <div class="section-divider"></div>
                <div class="section-label">Panes</div>
              ` : ''}
              ${validPanes.map((p) => {
                const isActive = p.paneId === activePaneId;
                const hasBell = store.paneBellActive(p.paneId);
                const label = p.title ?? `Pane ${p.paneId}`;
                return html`
                  <button
                    class="pane-item ${isActive ? 'active' : ''}"
                    @click="${() => this._selectPane(p.paneId)}"
                  >
                    ${hasBell
                      ? html`<span class="bell-dot">●</span>`
                      : html`<span class="bell-spacer"></span>`}
                    <span class="pane-label">${label}</span>
                    <span class="check">✓</span>
                  </button>
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
