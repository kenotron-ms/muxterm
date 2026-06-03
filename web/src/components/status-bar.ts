import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ChevronUp, Target } from 'lucide';
import { CHROME } from '../lib/theme.js';
import { icon } from '../lib/icons.js';
import { workspaceLabel } from './workspace-picker.js';
import type { SessiondWorkspaceInfo } from '../types.js';

@customElement('mux-status-bar')
export class MuxStatusBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      justify-content: space-between;
      background: ${unsafeCSS(CHROME.bar)};
      border-top: 1px solid ${unsafeCSS(CHROME.border)};
      height: 24px;
      padding: 0 12px;
      font-size: 12px;
      color: ${unsafeCSS(CHROME.textDim)};
      flex-shrink: 0;
      user-select: none;
    }

    .left,
    .right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .workspace-switcher {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--mux-accent);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }

    .workspace-switcher:hover {
      color: #cdd6f4;
    }

    .connected {
      color: var(--mux-ok);
    }

    .disconnected {
      color: var(--mux-error);
    }

    .reconnecting {
      color: var(--mux-warn);
    }

    .goal {
      display: flex;
      align-items: center;
      gap: 4px;
      color: ${unsafeCSS(CHROME.driverAccent)};
      font-weight: 600;
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }
  `;

  @property({ attribute: false })
  workspaces: SessiondWorkspaceInfo[] = [];

  @property({ type: String })
  currentWorkspaceId = '';

  @property({ type: String })
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

  @property({ type: Boolean })
  driverActive = false;

  private _statusText(): string {
    switch (this.connectionStatus) {
      case 'connected':
        return 'connected';
      case 'disconnected':
        return 'disconnected';
      case 'reconnecting':
        return 'reconnecting';
    }
  }

  private _currentLabel(): string {
    const ws = this.workspaces.find((w) => w.workspaceId === this.currentWorkspaceId);
    if (ws) return workspaceLabel(ws);
    // Defense-in-depth: if the workspace isn't in the list yet (e.g. during the
    // optimistic-create window before the workspace-created echo lands), derive
    // the id-based label rather than leaking the raw id string "w3".
    if (this.currentWorkspaceId) {
      return workspaceLabel({ workspaceId: this.currentWorkspaceId, paneCount: 0 });
    }
    return 'no workspace';
  }

  private _onSwitcherClick(): void {
    this.dispatchEvent(
      new CustomEvent('open-workspace-picker', { bubbles: true, composed: true }),
    );
  }

  render() {
    return html`
      <div class="left">
        <button
          class="workspace-switcher"
          title="Switch workspace"
          @click="${this._onSwitcherClick}"
        >
          <span class="ws-label">${this._currentLabel()}</span>
          ${icon(ChevronUp, { size: 12 })}
        </button>
      </div>
      <div class="right">
        ${this.driverActive
          ? html`<span class="goal">${icon(Target, { size: 12 })} goal</span>`
          : ''}
        <span class="${this.connectionStatus}">${this._statusText()}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-status-bar': MuxStatusBar;
  }
}
