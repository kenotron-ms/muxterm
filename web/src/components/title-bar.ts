import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { CHROME } from '../lib/theme.js';
import './launcher-menu.js';

@customElement('mux-title-bar')
export class MuxTitleBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: ${unsafeCSS(CHROME.bar)};
      border-bottom: 1px solid ${unsafeCSS(CHROME.border)};
      height: 32px;
      padding: 0 8px;
      flex-shrink: 0;
      user-select: none;
      position: relative;
      /* Structure ready for env(titlebar-area-*) WCO — apply here when needed */
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 6px;
      color: ${unsafeCSS(CHROME.textBright)};
      font-size: 13px;
      font-weight: 600;
    }

    .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: ${unsafeCSS(CHROME.accent)};
      flex-shrink: 0;
    }

    .right {
      display: flex;
      align-items: center;
      position: relative;
    }

    .launcher-btn {
      width: 28px;
      height: 24px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: ${unsafeCSS(CHROME.textBright)};
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-family: inherit;
    }

    .launcher-btn:hover {
      background: ${unsafeCSS(CHROME.hover)};
    }

    .menu-anchor {
      position: absolute;
      top: 28px;
      right: 0;
      z-index: 1500;
    }
  `;

  @state()
  private _menuOpen = false;

  private _toggleMenu(): void {
    this._menuOpen = !this._menuOpen;
  }

  private _onLauncherAction(e: Event): void {
    // Stop the original event from propagating further out of our shadow root
    e.stopPropagation();
    // Close the menu
    this._menuOpen = false;
    // Re-dispatch the event upward (bubbles, composed)
    const customEvent = e as CustomEvent;
    this.dispatchEvent(
      new CustomEvent('launcher-action', {
        bubbles: true,
        composed: true,
        detail: customEvent.detail,
      }),
    );
  }

  render() {
    return html`
      <div class="brand">
        <span class="brand-dot"></span>
        <span>muxterm</span>
      </div>
      <div class="right">
        <button
          class="launcher-btn"
          title="Open menu"
          @click=${this._toggleMenu}
        >⋯</button>
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu
                @launcher-action=${this._onLauncherAction}
              ></mux-launcher-menu>
            </div>`
          : ''}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-title-bar': MuxTitleBar;
  }
}
