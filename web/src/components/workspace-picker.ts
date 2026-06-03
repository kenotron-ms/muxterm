import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
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
      min-width: 240px;
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

    .ws-item:hover { background: #2a2b3c; }
    .ws-item.sel  { background: #283457; }

    .ws-item.errored {
      border-color: #f38ba8;
      background: #3a2230;
    }

    .ws-err-msg {
      color: #f38ba8;
      font-size: 12px;
      margin-right: 4px;
    }

    .ws-item.errored .row-action { color: #f38ba8; }

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
    .ws-item.sel   .row-action { opacity: 1; }

    /* Touch devices: no hover, always show actions */
    @media (pointer: coarse) {
      .row-action { opacity: 1; }
    }

    .row-action:hover {
      background: #45475a;
      color: #cdd6f4;
    }

    /* Shared inline input (used by both rename and create form) */
    .ws-edit-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
    }

    .ws-edit-input {
      flex: 1;
      background: #313244;
      border: 1px solid #89b4fa;
      border-radius: 4px;
      color: #cdd6f4;
      font: inherit;
      font-size: 14px;
      padding: 3px 8px;
      outline: none;
      min-width: 0;
    }

    .ws-edit-input:focus {
      box-shadow: 0 0 0 2px rgba(137, 180, 250, 0.25);
    }

    .ws-edit-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Create form — appears at the bottom instead of the "New workspace" button */
    .ws-create-form {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .ws-create-form .ws-edit-input {
      width: 100%;
    }

    .ws-create-actions {
      display: flex;
      gap: 6px;
    }

    .ws-create-btn {
      flex: 1;
      padding: 8px 12px;
      background: #89b4fa;
      color: #1e1e2e;
      border: none;
      border-radius: 6px;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.12s;
    }

    .ws-create-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .ws-create-btn:not(:disabled):hover {
      opacity: 0.85;
    }

    .ws-create-cancel {
      padding: 8px 12px;
      background: transparent;
      color: #6c7086;
      border: 1px solid #45475a;
      border-radius: 6px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }

    .ws-create-cancel:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .ws-create-cancel:not(:disabled):hover {
      background: #2a2b3c;
      color: #cdd6f4;
    }

    /* "New workspace" button — shown when form is hidden */
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

  @property({ attribute: false })
  erroredMutations: PickerErroredMutation[] = [];

  @property({ type: Boolean })
  createPending = false;

  // Rename state
  @state() private _editingId: string | null = null;
  @state() private _editingValue = '';

  // Create form state
  @state() private _showCreateForm = false;
  @state() private _createName = '';

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    // Close create form when server confirms the workspace was created.
    if (changed.has('createPending') && !this.createPending && this._showCreateForm) {
      this._showCreateForm = false;
      this._createName = '';
    }
    // Auto-focus create input when form opens.
    if (changed.has('_showCreateForm') && this._showCreateForm) {
      requestAnimationFrame(() => {
        this.shadowRoot?.querySelector<HTMLInputElement>('.ws-create-input')?.focus();
      });
    }
    // Auto-focus rename input when edit row opens.
    if (changed.has('_editingId') && this._editingId !== null) {
      requestAnimationFrame(() => {
        this.shadowRoot?.querySelector<HTMLInputElement>('.ws-edit-input')?.focus();
        this.shadowRoot?.querySelector<HTMLInputElement>('.ws-edit-input')?.select();
      });
    }
  }

  private _emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  private _onSelect(workspaceId: string): void {
    this._editingId = null;
    this._emit('workspace-selected', { workspaceId });
  }

  // Create form
  private _onCreate(): void {
    this._showCreateForm = true;
  }

  private _onCreateKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') { e.preventDefault(); this._submitCreate(); }
    if (e.key === 'Escape') { e.preventDefault(); this._cancelCreate(); }
  }

  private _submitCreate(): void {
    const name = this._createName.trim();
    if (!name || this.createPending) return;
    this._emit('workspace-create', { name });
    // createPending will go true (set by parent), form stays open showing spinner.
    // updated() will close the form when createPending goes back to false.
  }

  private _cancelCreate(): void {
    this._showCreateForm = false;
    this._createName = '';
  }

  // Rename
  private _onRename(e: Event, workspaceId: string, currentLabel: string): void {
    e.stopPropagation();
    this._editingId = workspaceId;
    this._editingValue = currentLabel;
  }

  private _onEditKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') { e.preventDefault(); this._commitEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); this._cancelEdit(); }
  }

  private _commitEdit(): void {
    const name = this._editingValue.trim();
    const workspaceId = this._editingId;
    this._editingId = null;
    this._editingValue = '';
    if (workspaceId) this._emit('workspace-rename', { workspaceId, name });
  }

  private _cancelEdit(): void {
    this._editingId = null;
    this._editingValue = '';
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
    this._editingId = null;
    this._cancelCreate();
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
              const editing = this._editingId === w.workspaceId;
              const errored = this.erroredMutations.find((m) => m.workspaceId === w.workspaceId);
              const label = workspaceLabel(w);
              return html`
                <div class="ws-item ${current ? 'sel' : ''} ${errored ? 'errored' : ''}">
                  ${editing
                    ? html`
                        <span class="ws-check"></span>
                        <div class="ws-edit-row">
                          <input
                            class="ws-edit-input"
                            type="text"
                            .value="${this._editingValue}"
                            @input="${(e: Event) => { this._editingValue = (e.target as HTMLInputElement).value; }}"
                            @keydown="${this._onEditKeyDown}"
                            @click="${(e: Event) => e.stopPropagation()}"
                          />
                          <button class="row-action" title="Confirm" @click="${(e: Event) => { e.stopPropagation(); this._commitEdit(); }}">${icon(Check, { size: 14 })}</button>
                          <button class="row-action" title="Cancel"  @click="${(e: Event) => { e.stopPropagation(); this._cancelEdit(); }}">${icon(X, { size: 14 })}</button>
                        </div>
                      `
                    : html`
                        <button class="ws-sel" @click="${() => this._onSelect(w.workspaceId)}">
                          <span class="ws-check">${current ? icon(Check, { size: 12 }) : ''}</span>
                          <span class="ws-name">${label}</span>
                          <span class="ws-meta">${w.paneCount} ${w.paneCount === 1 ? 'pane' : 'panes'}</span>
                        </button>
                        ${errored
                          ? html`
                              <span class="ws-err-msg">failed</span>
                              <button class="row-action" title="Retry"   @click="${(e: Event) => this._onRetry(e, errored.id)}">${icon(RotateCcw, { size: 14 })}</button>
                              <button class="row-action" title="Dismiss" @click="${(e: Event) => this._onDismiss(e, errored.id)}">${icon(X, { size: 14 })}</button>
                            `
                          : html`
                              <button class="row-action" title="Rename" @click="${(e: Event) => this._onRename(e, w.workspaceId, label)}">${icon(Pencil, { size: 14 })}</button>
                              <button class="row-action" title="Close"  @click="${(e: Event) => this._onClose(e, w.workspaceId)}">${icon(X, { size: 14 })}</button>
                            `}
                      `}
                </div>
              `;
            })}
          </div>

          ${this._showCreateForm
            ? html`
                <div class="ws-create-form">
                  <input
                    class="ws-create-input ws-edit-input"
                    type="text"
                    placeholder="Workspace name"
                    .value="${this._createName}"
                    ?disabled="${this.createPending}"
                    @input="${(e: Event) => { this._createName = (e.target as HTMLInputElement).value; }}"
                    @keydown="${this._onCreateKeyDown}"
                    @click="${(e: Event) => e.stopPropagation()}"
                  />
                  <div class="ws-create-actions">
                    <button
                      class="ws-create-btn"
                      ?disabled="${this.createPending || !this._createName.trim()}"
                      @click="${(e: Event) => { e.stopPropagation(); this._submitCreate(); }}"
                    >
                      ${this.createPending ? 'Creating…' : 'Create'}
                    </button>
                    <button
                      class="ws-create-cancel"
                      ?disabled="${this.createPending}"
                      @click="${(e: Event) => { e.stopPropagation(); this._cancelCreate(); }}"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              `
            : html`
                <button class="ws-new" @click="${this._onCreate}">
                  ${icon(Plus, { size: 14 })}
                  <span>New workspace…</span>
                </button>
              `}
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
