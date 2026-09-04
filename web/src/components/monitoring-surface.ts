import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import type { SessiondWorkspaceInfo, SessiondPaneInfo, PaneStatus } from '../types.js';

/**
 * mux-monitoring-surface — Monitoring view displaying all tracked tabs
 * grouped by workspace with status and haiku summaries for Needs-Input tabs.
 *
 * Layout: header + scrollable content area showing workspace sections.
 *
 * Events:
 *   close  — emitted when × is clicked
 */
@customElement('mux-monitoring-surface')
export class MuxMonitoringSurface extends LitElement {
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

    /* ── Content area ── */
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 24px 28px 40px;
    }

    /* ── Workspace sections ── */
    .workspace-section {
      margin-bottom: 32px;
    }

    .workspace-section:last-child {
      margin-bottom: 0;
    }

    .workspace-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--chrome-text-bright);
      margin: 0 0 12px 0;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--chrome-border);
    }

    /* ── Pane cards ── */
    .pane-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .pane-card {
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      padding: 12px 14px;
      transition: background 0.12s, border-color 0.12s;
    }

    .pane-card:hover {
      background: var(--chrome-hover);
    }

    .pane-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }

    .pane-title {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
      color: var(--chrome-text-bright);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-badge {
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      flex-shrink: 0;
    }

    .status-badge.needs-input {
      background: var(--chrome-accent, #7aa2f7);
      color: var(--chrome-body, #1a1b26);
    }

    .status-badge.running {
      background: var(--mux-ok, #9ece6a);
      color: var(--chrome-body, #1a1b26);
    }

    .status-badge.completed {
      background: var(--chrome-text-dim, #565f89);
      color: var(--chrome-text-bright, #c0caf5);
    }

    /* ── Haiku summary ── */
    .haiku-summary {
      font-size: 12px;
      color: var(--chrome-text-dim);
      line-height: 1.6;
      font-style: italic;
      padding: 8px 10px;
      background: var(--chrome-body);
      border-left: 3px solid var(--chrome-accent);
      border-radius: 4px;
      margin-top: 8px;
      white-space: pre-line;
    }

    .haiku-loading {
      font-size: 11px;
      color: var(--chrome-text-dim);
      margin-top: 8px;
      font-style: italic;
    }

    /* ── Empty state ── */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--chrome-text-dim);
    }

    .empty-state-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    .empty-state-title {
      font-size: 16px;
      font-weight: 600;
      margin: 0 0 8px 0;
      color: var(--chrome-text-bright);
    }

    .empty-state-desc {
      font-size: 13px;
      margin: 0;
      line-height: 1.5;
    }
  `;

  @state() private _version = 0;
  @state() private _haikuCache: Map<number, string> = new Map();
  @state() private _haikuLoading: Set<number> = new Set();

  private _unsub: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Subscribe to store changes and trigger re-render by bumping _version.
    this._unsub = store.subscribe(() => {
      this._version++;
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  /**
   * Generate a haiku-style summary for a Needs-Input pane.
   * This is a placeholder - will be implemented with actual AI call.
   */
  private async _generateHaiku(paneId: number, title: string): Promise<string> {
    // Check cache first
    if (this._haikuCache.has(paneId)) {
      return this._haikuCache.get(paneId)!;
    }

    // Mark as loading
    this._haikuLoading.add(paneId);
    this._version++;

    try {
      // TODO: Implement actual AI call to generate haiku
      // For now, return a placeholder haiku based on pane title
      await new Promise(resolve => setTimeout(resolve, 500)); // Simulate API call

      const haiku = `Terminal awaits\n${title || 'Unnamed pane'} sits idle\nInput needed here`;
      
      this._haikuCache.set(paneId, haiku);
      return haiku;
    } finally {
      this._haikuLoading.delete(paneId);
      this._version++;
    }
  }

  private _renderPaneCard(pane: SessiondPaneInfo, workspace: SessiondWorkspaceInfo) {
    const meta = store.getPaneMetadata(pane.paneId);
    const title = pane.title || `Pane ${pane.paneId}`;
    const status = meta.status;

    // Get cached haiku or trigger generation for Needs-Input panes
    let haiku = this._haikuCache.get(pane.paneId);
    const isLoading = this._haikuLoading.has(pane.paneId);

    if (status === 'needs-input' && !haiku && !isLoading) {
      // Trigger haiku generation asynchronously
      this._generateHaiku(pane.paneId, title).catch(console.error);
    }

    return html`
      <div class="pane-card">
        <div class="pane-header">
          <span class="pane-title" title="${title}">${title}</span>
          <span class="status-badge ${status}">${this._formatStatus(status)}</span>
        </div>
        ${status === 'needs-input'
          ? isLoading
            ? html`<div class="haiku-loading">Generating summary...</div>`
            : haiku
              ? html`<div class="haiku-summary">${haiku}</div>`
              : ''
          : ''}
      </div>
    `;
  }

  private _formatStatus(status: PaneStatus): string {
    switch (status) {
      case 'needs-input':
        return 'Needs Input';
      case 'running':
        return 'Running';
      case 'completed':
        return 'Completed';
      default:
        return status;
    }
  }

  private _renderWorkspaceSection(workspace: SessiondWorkspaceInfo) {
    // Get all panes for this workspace that are tracked
    const panes = store.panes.filter(pane => {
      const meta = store.getPaneMetadata(pane.paneId);
      return meta.tracked;
    });

    if (panes.length === 0) {
      return html``;
    }

    const wsName = workspace.name || workspace.workspaceId;

    return html`
      <div class="workspace-section">
        <h3 class="workspace-title">${wsName}</h3>
        <div class="pane-list">
          ${panes.map(pane => this._renderPaneCard(pane, workspace))}
        </div>
      </div>
    `;
  }

  private _renderContent() {
    void this._version; // suppress unused-variable lint; triggers re-render on store change

    const workspaces = store.workspaces;
    
    // Check if we have any tracked panes
    const hasTrackedPanes = store.panes.some(pane => {
      const meta = store.getPaneMetadata(pane.paneId);
      return meta.tracked;
    });

    if (!hasTrackedPanes) {
      return html`
        <div class="empty-state">
          <div class="empty-state-icon">📊</div>
          <h3 class="empty-state-title">No Tracked Tabs</h3>
          <p class="empty-state-desc">
            Tracked tabs will appear here when created by MCP services or agents.
          </p>
        </div>
      `;
    }

    return html`
      ${workspaces.map(ws => this._renderWorkspaceSection(ws))}
    `;
  }

  override render() {
    return html`
      <div class="header">
        <h2>Monitoring</h2>
        <button class="close-btn" title="Close" @click="${this._close}">×</button>
      </div>
      <div class="content">
        ${this._renderContent()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-monitoring-surface': MuxMonitoringSurface;
  }
}
