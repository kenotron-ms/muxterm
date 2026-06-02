import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { Check, Plus, Pencil, X } from 'lucide';
import { icon } from '../lib/icons.js';
import type { SessiondWorkspaceInfo } from '../types.js';

/**
 * Human-readable label for a workspace: prefer the explicit name, otherwise
 * fall back to a stable id-based label.
 */
export function workspaceLabel(ws: SessiondWorkspaceInfo): string {
  return ws.name && ws.name.length > 0 ? ws.name : `Workspace ${ws.workspaceId}`;
}

@customElement('mux-workspace-picker')
export class MuxWorkspacePicker extends LitElement {
  static styles = css`
    .overlay {
      position: fixed;
      inset: 0;
      background: transparent;
      display: flex;
      align-items: flex-end;
      justify-content: flex-start;
      padding: 0 0 32px 12px;
      z-index: 2000;
    }

    .picker {
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 8px;
      padding: 16px;
      min-width: 280px;
      max-width: 420px;
      max-height: 70vh;
      overflow-y: auto;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    h2 {
      margin: 0 0 16px 0;
      color: #cdd6f4;
      font-size: 18px;
      font-weight: 600;
    }

    .ws-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .ws-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 12px 16px;
      background: #181825;
      border: 1px solid #45475a;
      border-radius: 6px;
      cursor: pointer;
      color: #cdd6f4;
      font-size: 14px;
      font-family: inherit;
      text-align: left;
      transition: border-color 0.15s;
    }

    .ws-item:hover {
      border-color: #89b4fa;
    }

    .ws-item.sel {
      border-color: #89b4fa;
      background: #283457;
    }

    .ck {
      width: 14px;
      flex-shrink: 0;
      color: #9ece6a;
      display: flex;
      align-items: center;
    }

    .ws-name {
      font-weight: 600;
      flex: 1;
    }

    .ws-meta {
      color: #6c7086;
      font-size: 12px;
    }

    .row-action {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      border: none;
      background: transparent;
      color: #6c7086;
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
    }

    .row-action:hover {
      background: #313244;
      color: #cdd6f4;
    }

    .ws-new {
      display: flex;
      align-items: center;
      gap: 9px;
      width: 100%;
      margin-top: 12px;
      padding: 10px 16px;
      border: 1px dashed #45475a;
      border-radius: 6px;
      background: transparent;
      color: #89b4fa;
      cursor: pointer;
      font-size: 14px;
      font-family: inherit;
      text-align: left;
    }

    .ws-new:hover {
      border-color: #89b4fa;
      background: #1f2335;
    }
  `;

  @property({ attribute: false })
  workspaces: SessiondWorkspaceInfo[] = [];

  @property({ type: String })
  currentWorkspaceId = '';

  private _emit(name: string, detail?: unknown): void {
    this.dispatchEvent(
      new CustomEvent(name, {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }

  private _onSelect(workspaceId: string): void {
    this._emit('workspace-selected', { workspaceId });
  }

  private _onCreate(): void {
    this._emit('workspace-create');
  }

  private _onRename(e: Event, workspaceId: string): void {
    e.stopPropagation();
    const name = window.prompt('Rename workspace:')?.trim() ?? '';
    this._emit('workspace-rename', { workspaceId, name });
  }

  private _onClose(e: Event, workspaceId: string): void {
    e.stopPropagation();
    this._emit('workspace-close', { workspaceId });
  }

  private _onOverlayClick(): void {
    this._emit('close-picker');
  }

  render() {
    return html`
      <div class="overlay" @click="${this._onOverlayClick}">
        <div class="picker" @click="${(e: Event) => e.stopPropagation()}">
          <h2>Workspaces</h2>
          <div class="ws-list">
            ${this.workspaces.map((w) => {
              const current = w.workspaceId === this.currentWorkspaceId;
              return html`
                <button
                  class="ws-item ${current ? 'sel' : ''}"
                  @click="${() => this._onSelect(w.workspaceId)}"
                >
                  <span class="ck">${current ? icon(Check, { size: 12 }) : ''}</span>
                  <span class="ws-name">${workspaceLabel(w)}</span>
                  <span class="ws-meta">${w.paneCount} ${w.paneCount === 1 ? 'pane' : 'panes'}</span>
                  <button
                    class="row-action ws-rename"
                    title="Rename"
                    @click="${(e: Event) => this._onRename(e, w.workspaceId)}"
                  >
                    ${icon(Pencil, { size: 14 })}
                  </button>
                  <button
                    class="row-action ws-close"
                    title="Close"
                    @click="${(e: Event) => this._onClose(e, w.workspaceId)}"
                  >
                    ${icon(X, { size: 14 })}
                  </button>
                </button>
              `;
            })}
          </div>
          <button class="ws-new" @click="${this._onCreate}">
            ${icon(Plus, { size: 14 })}
            <span>New workspace…</span>
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-workspace-picker': MuxWorkspacePicker;
  }
}
