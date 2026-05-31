import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Window } from '../types.js';
import { CHROME } from '../lib/theme.js';

@customElement('mux-region-tabstrip')
export class MuxRegionTabstrip extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .strip {
      display: flex;
      align-items: center;
      background: ${unsafeCSS(CHROME.bar)};
      height: 36px;
      padding: 0 4px;
      gap: 2px;
      user-select: none;
      flex-shrink: 0;
      overflow: hidden;
    }

    /* Session chip */
    .session-chip {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: ${unsafeCSS(CHROME.textDim)};
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .session-chip:hover {
      background: ${unsafeCSS(CHROME.hover)};
      color: ${unsafeCSS(CHROME.textBright)};
    }

    /* Driver: session chip uses driverAccent color */
    .strip.driver .session-chip {
      color: ${unsafeCSS(CHROME.driverAccent)};
    }

    /* Tabs container */
    .tabs {
      display: flex;
      align-items: stretch;
      height: 100%;
      gap: 1px;
      min-width: 0;
      overflow: hidden;
    }

    /* Individual tab */
    .tab {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0 10px;
      background: transparent;
      border: none;
      border-top: 2px solid transparent;
      cursor: pointer;
      font-size: 13px;
      color: ${unsafeCSS(CHROME.textDim)};
      font-family: inherit;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .tab:hover {
      background: ${unsafeCSS(CHROME.hover)};
      color: ${unsafeCSS(CHROME.textBright)};
    }

    /* Active tab: top accent line + body background (seamless with body) */
    .tab.active {
      border-top: 2px solid ${unsafeCSS(CHROME.accent)};
      background: ${unsafeCSS(CHROME.body)};
      color: ${unsafeCSS(CHROME.textBright)};
    }

    /* Driver: active tab uses driverAccent */
    .strip.driver .tab.active {
      border-top: 2px solid ${unsafeCSS(CHROME.driverAccent)};
    }

    /* File icon */
    .file-icon {
      font-size: 11px;
      opacity: 0.7;
    }

    /* Close button — visibility:hidden until tab hover */
    .tab-close {
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      visibility: hidden;
      color: ${unsafeCSS(CHROME.textDim)};
    }

    .tab:hover .tab-close {
      visibility: visible;
    }

    .tab-close:hover {
      color: ${unsafeCSS(CHROME.danger)};
    }

    /* Dirty dot for running windows */
    .dirty-dot {
      font-size: 10px;
      color: ${unsafeCSS(CHROME.accent)};
    }

    /* Tab add button */
    .tab-add {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      font-size: 18px;
      color: ${unsafeCSS(CHROME.textDim)};
      background: transparent;
      border: none;
      cursor: pointer;
      flex-shrink: 0;
    }

    .tab-add:hover {
      color: ${unsafeCSS(CHROME.textBright)};
      background: ${unsafeCSS(CHROME.hover)};
      border-radius: 4px;
    }

    /* Spacer */
    .spacer {
      flex: 1;
    }

    /* Controls */
    .controls {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }

    .maximize-btn,
    .more-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      background: transparent;
      border: none;
      color: ${unsafeCSS(CHROME.textDim)};
      font-size: 14px;
      cursor: pointer;
      border-radius: 4px;
    }

    .maximize-btn:hover,
    .more-btn:hover {
      background: ${unsafeCSS(CHROME.hover)};
      color: ${unsafeCSS(CHROME.textBright)};
    }
  `;

  @property({ type: String })
  sessionName = '';

  @property({ attribute: false })
  windows: Window[] = [];

  @property({ type: Number })
  activeWindowId = 0;

  @property({ type: Boolean })
  isDriver = false;

  @property({ attribute: false })
  runningWindowIds: number[] = [];

  private _emit(name: string, detail?: Record<string, unknown>): void {
    this.dispatchEvent(
      new CustomEvent(name, {
        bubbles: true,
        composed: true,
        ...(detail ? { detail } : {}),
      }),
    );
  }

  private _onChipClick(): void {
    this._emit('open-session-picker');
  }

  private _onTabClick(windowId: number): void {
    this._emit('tab-select', { windowId });
  }

  private _onTabNew(): void {
    this._emit('tab-new');
  }

  private _onMaximize(): void {
    this._emit('region-maximize');
  }

  private _onMenuOpen(): void {
    this._emit('region-menu-open');
  }

  render() {
    const stripClass = `strip${this.isDriver ? ' driver' : ''}`;

    return html`
      <div class=${stripClass}>
        <button class="session-chip" @click=${this._onChipClick}>
          ${this.sessionName} ▾
        </button>

        <div class="tabs">
          ${this.windows.map((w) => {
            const isActive = w.id === this.activeWindowId;
            const isRunning = this.runningWindowIds.includes(w.id);
            return html`
              <button
                class="tab${isActive ? ' active' : ''}"
                data-window-id=${w.id}
                @click=${() => this._onTabClick(w.id)}
              >
                <span class="file-icon">■</span>
                ${w.name}
                ${isRunning
                  ? html`<span class="dirty-dot">●</span>`
                  : html`<span class="tab-close">×</span>`}
              </button>
            `;
          })}
        </div>

        <button class="tab-add" @click=${this._onTabNew}>+</button>

        <div class="spacer"></div>

        <div class="controls">
          <button class="maximize-btn" @click=${this._onMaximize}>⊡</button>
          <button class="more-btn" @click=${this._onMenuOpen}>⋯</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-region-tabstrip': MuxRegionTabstrip;
  }
}
