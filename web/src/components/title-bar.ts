import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';
import { CHROME } from '../lib/theme.js';
import './launcher-menu.js';
import { icon } from '../lib/icons.js';
import { Ellipsis } from 'lucide';

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

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }

    button .lucide-icon {
      pointer-events: none;
    }
  `;

  @state()
  private _menuOpen = false;

  /** Bound handler so we can remove it in disconnectedCallback. */
  private _onOpenLauncher = (): void => {
    this._menuOpen = true;
  };

  /** Fix 5: close the launcher menu when the user clicks anywhere outside
   *  the title-bar element. */
  private _onOutsideClick = (e: MouseEvent): void => {
    if (this._menuOpen && !this.contains(e.target as Node)) {
      this._menuOpen = false;
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('open-launcher', this._onOpenLauncher);
    document.addEventListener('mousedown', this._onOutsideClick);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('open-launcher', this._onOpenLauncher);
    document.removeEventListener('mousedown', this._onOutsideClick);
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('_menuOpen')) {
      this.toggleAttribute('data-launcher-open', this._menuOpen);
    }
  }

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
          @click="${this._toggleMenu}"
        >${icon(Ellipsis, { size: 16 })}</button>
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu
                @launcher-action="${this._onLauncherAction}"
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
