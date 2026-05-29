import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Window } from '../types.js';

@customElement('mux-tab-bar')
export class MuxTabBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      background: #16161e;
      border-bottom: 1px solid #292e42;
      height: 36px;
      padding: 0 8px;
      gap: 2px;
      user-select: none;
      flex-shrink: 0;
    }

    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 6px 6px 0 0;
      cursor: pointer;
      font-size: 13px;
      color: #565f89;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
    }

    .tab:hover {
      color: #a9b1d6;
      background: #1a1b26;
    }

    .tab.active {
      color: #c0caf5;
      background: #1a1b26;
      border-bottom: 2px solid #7aa2f7;
    }

    .tab-close {
      display: none;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
    }

    .tab:hover .tab-close {
      display: inline;
    }

    .tab-close:hover {
      color: #f7768e;
    }

    .tab-add {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      font-size: 18px;
      color: #565f89;
      background: transparent;
      border: none;
      cursor: pointer;
    }

    .spacer {
      flex: 1;
    }

    .title {
      color: #565f89;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
  `;

  @property({ attribute: false })
  windows: Window[] = [];

  @property({ type: String, attribute: 'active-window-id' })
  activeWindowId = '';

  private _selectWindow(windowId: number): void {
    this.dispatchEvent(
      new CustomEvent('tab-select', {
        bubbles: true,
        composed: true,
        detail: { windowId },
      }),
    );
  }

  private _closeWindow(e: Event, windowId: number): void {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('tab-close', {
        bubbles: true,
        composed: true,
        detail: { windowId },
      }),
    );
  }

  private _newWindow(): void {
    this.dispatchEvent(
      new CustomEvent('tab-new', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <span class="title">muxterm</span>
      ${this.windows.map(
        (w) => html`
          <button
            class="tab ${String(w.id) === this.activeWindowId ? 'active' : ''}"
            @click=${() => this._selectWindow(w.id)}
          >
            ${w.name}
            <span class="tab-close" @click=${(e: Event) => this._closeWindow(e, w.id)}>&times;</span>
          </button>
        `,
      )}
      <button class="tab-add" @click=${this._newWindow}>+</button>
      <div class="spacer"></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-tab-bar': MuxTabBar;
  }
}