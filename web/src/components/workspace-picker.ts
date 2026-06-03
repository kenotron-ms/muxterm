import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { Check, Plus, Pencil, X, RotateCcw } from 'lucide';
import { icon } from '../lib/icons.js';
import type { SessiondWorkspaceInfo } from '../types.js';

/**
 * Human-readable label for a workspace: prefer the explicit name, otherwise
 * fall back to a stable id-based label.
 */
export function workspaceLabel(ws: SessiondWorkspaceInfo): string {
  if (ws.name && ws.name.length > 0) return ws.name;
  const n = ws.workspaceId.replace(/\D/g, '');
  return `workspace ${n || ws.workspaceId}`;
}

export interface PickerErroredMutation {
  id: string;
  workspaceId?: string;
  kind?: string;
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
      padding: 8px;
      width: max-content;
      min-width: 220px;
      max-width: 360px;
      max-height: 70vh;
      overflow-y: auto;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    h2 {
      margin: 4px 8px 8px;
      color: #6c7086;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .ws-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .ws-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 8px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: #cdd6f4;
      font-size: 14px;
      transition: background-color 0.12s;
    }

    .ws-item:hover {
      background: #2a2b3c;
    }

    .ws-item.sel {
      background: #283457;
    }

    .ws-item.errored {
      border-color: #f38ba8;
      background: #3a2230;
    }

    .ws-err-msg {
      color: #f38ba8;
      font-size: 12px;
      margin-right: 4px;
    }

    .ws-item.errored .row-action {
      color: #f38ba8;
    }

    .ws-sel {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      padding: 0;
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .ws-check {
      width: 16px;
      flex-shrink: 0;
      color: #9ece6a;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .ws-name {
      font-weight: 500;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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
      opacity: 0;
      transition: opacity 0.12s, color 0.12s, background-color 0.12s;
    }

    .ws-item:hover .row-action,
    .ws-item.sel .row-action {
      opacity: 1;
    }

    .row-action:hover {
      background: #45475a;
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

    .ws-new:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      border-color: #45475a;
      background: transparent;
    }
  `;

  @property({ attribute: false })
  workspaces: SessiondWorkspaceInfo[] = [];

  @property({ type: String })
  currentWorkspaceId = '';

  @property({ attribute: false })
  erroredMutations: PickerErroredMutation[] = [];

  @property({ type: Boolean })
  createPending = false;

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

  private _onRetry(e: Event, mutationId: string): void {
    e.stopPropagation();
    this._emit('workspace-retry', { mutationId });
  }

  private _onDismiss(e: Event, mutationId: string): void {
    e.stopPropagation();
    this._emit('workspace-dismiss', { mutationId });
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
              const errored = this.erroredMutations.find((m) => m.workspaceId === w.workspaceId);
              return html`
                <div class="ws-item ${current ? 'sel' : ''} ${errored ? 'errored' : ''}">
                  <button
                    class="ws-sel"
                    @click="${() => this._onSelect(w.workspaceId)}"
                  >
                    <span class="ws-check">${current ? icon(Check, { size: 12 }) : ''}</span>
                    <span class="ws-name">${workspaceLabel(w)}</span>
                    <span class="ws-meta">${w.paneCount} ${w.paneCount === 1 ? 'pane' : 'panes'}</span>
                  </button>
                  ${errored
                    ? html`
                        <span class="ws-err-msg">failed</span>
                        <button
                          class="row-action ws-retry"
                          title="Retry"
                          @click="${(e: Event) => this._onRetry(e, errored.id)}"
                        >
                          ${icon(RotateCcw, { size: 14 })}
                        </button>
                        <button
                          class="row-action ws-dismiss"
                          title="Dismiss"
                          @click="${(e: Event) => this._onDismiss(e, errored.id)}"
                        >
                          ${icon(X, { size: 14 })}
                        </button>
                      `
                    : html`
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
                      `}
                </div>
              `;
            })}
          </div>
          <button class="ws-new" ?disabled="${this.createPending}" @click="${this._onCreate}">
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
