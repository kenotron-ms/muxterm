import { LitElement, html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import './layout.js';

@customElement('mux-region')
export class MuxRegion extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #1a1b26;
      min-width: 120px;
      min-height: 80px;
    }

    .header {
      height: 26px;
      padding: 0 8px;
      font-size: 12px;
      color: #a9b1d6;
      background: #16161e;
      border-bottom: 1px solid #292e42;
      flex-shrink: 0;
      display: flex;
      align-items: center;
    }

    .session {
      color: #7aa2f7;
    }

    .spacer {
      flex: 1;
    }

    button {
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 0;
      font-size: 12px;
    }

    .body {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
  `;

  @property({ type: String, attribute: 'region-id' })
  regionId = '';

  @property({ type: String, attribute: 'surface-id' })
  surfaceId = '';

  @property({ type: String, attribute: 'session-name' })
  sessionName = '';

  @property({ type: String, attribute: 'window-name' })
  windowName = '';

  @property({ type: String, attribute: 'layout-string' })
  layoutString = '';

  @property({ type: Number, attribute: 'active-pane-id' })
  activePaneId = -1;

  @query('.body')
  private _body!: HTMLElement;

  get bodyElement(): HTMLElement {
    return this._body;
  }

  private _onMaximize(): void {
    this.dispatchEvent(
      new CustomEvent('region-maximize', {
        bubbles: true,
        composed: true,
        detail: { regionId: this.regionId },
      }),
    );
  }

  render() {
    return html`
      <div class="header">
        <span class="session">${this.sessionName}</span>
        <span>&nbsp;${this.windowName}</span>
        <span class="spacer"></span>
        <button
          data-action="maximize"
          title="Maximize region"
          @click=${this._onMaximize}
        >⊡</button>
      </div>
      <div class="body">
        <mux-layout
          layout-string=${this.layoutString}
          active-pane-id=${this.activePaneId}
        ></mux-layout>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-region': MuxRegion;
  }
}
