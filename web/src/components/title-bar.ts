import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';
import './launcher-menu.js';
import './mux-pane-picker.js';
import { icon } from '../lib/icons.js';
import { Ellipsis, Plus } from 'lucide';

@customElement('mux-title-bar')
export class MuxTitleBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--chrome-bar);
      border-bottom: 1px solid var(--chrome-border);
      height: var(--mux-dock-height, 44px);
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
      color: var(--chrome-text-bright);
      font-size: 13px;
      font-weight: 600;
    }

    .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--chrome-accent);
      flex-shrink: 0;
    }

    .brand-sha {
      font-size: 10px;
      font-weight: 400;
      font-family: monospace;
      color: var(--chrome-text-dim);
      letter-spacing: 0;
    }

    .right {
      display: flex;
      align-items: center;
      gap: 4px;
      position: relative;
    }

    .launcher-btn,
    .pane-btn {
      width: 44px;
      height: 44px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--chrome-text-bright);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-family: inherit;
    }

    .launcher-btn:hover,
    .pane-btn:hover {
      background: var(--chrome-hover);
    }

    .menu-anchor {
      position: absolute;
      top: 100%;
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
    if (this._menuOpen && !e.composedPath().includes(this)) {
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

  private _onWorkspaceSwitch(e: Event): void {
    e.stopPropagation();
    const customEvent = e as CustomEvent;
    this.dispatchEvent(
      new CustomEvent('workspace-switch', {
        bubbles: true,
        composed: true,
        detail: customEvent.detail,
      }),
    );
  }

  private _requestNewPane(): void {
    this.dispatchEvent(
      new CustomEvent('pane-create-request', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <div class="brand">
        <span class="brand-dot"></span>
        <span>muxterm</span>
        <span class="brand-sha">${__GIT_SHA__}</span>
      </div>
      <mux-pane-picker @workspace-switch="${this._onWorkspaceSwitch}"></mux-pane-picker>
      <div class="right">
        <button
          class="pane-btn"
          title="New pane"
          aria-label="New pane"
          @click="${this._requestNewPane}"
        >${icon(Plus, { size: 20 })}</button>
        <button
          class="launcher-btn"
          title="Open menu"
          @click="${this._toggleMenu}"
        >${icon(Ellipsis, { size: 16 })}</button>
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu
                .showCreateWorkspace="${true}"
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
