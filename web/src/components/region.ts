import { LitElement, html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import './layout.js';
import './region-tabstrip.js';
import './browser-surface.js';
import './settings-surface.js';
import { isTerminalSurface, type SurfaceKind } from '../types.js';
import type { Window } from '../types.js';

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

  @property({ attribute: false })
  windows: Window[] = [];

  @property({ type: Number, attribute: 'active-window-id' })
  activeWindowId = 0;

  @property({ type: String })
  surfaceKind: SurfaceKind = 'terminal';

  @property({ type: String, attribute: 'browser-url' })
  browserUrl?: string;

  @property({ type: String, attribute: 'server-addr' })
  serverAddr?: string;

  @query('.body')
  private _body!: HTMLElement;

  get bodyElement(): HTMLElement {
    return this._body;
  }

  private _forwardEvent(e: Event): void {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent(e.type, {
        bubbles: true,
        composed: true,
        detail: (e as CustomEvent).detail,
      }),
    );
  }

  render() {
    return html`
      <mux-region-tabstrip
        .sessionName=${this.sessionName}
        .windows=${this.windows}
        .activeWindowId=${this.activeWindowId}
        .isDriver=${this.surfaceKind === 'driver'}
        @tab-select=${this._forwardEvent}
        @tab-close=${this._forwardEvent}
        @tab-new=${this._forwardEvent}
        @open-session-picker=${this._forwardEvent}
        @region-maximize=${this._forwardEvent}
        @region-menu-open=${this._forwardEvent}
      ></mux-region-tabstrip>
      <div class="body">
        ${isTerminalSurface(this.surfaceKind)
          ? html`<mux-layout
              layout-string=${this.layoutString}
              active-pane-id=${this.activePaneId}
            ></mux-layout>`
          : this.surfaceKind === 'browser'
            ? html`<mux-browser-surface
                .url=${this.browserUrl ?? 'about:blank'}
              ></mux-browser-surface>`
            : html`<mux-settings-surface
                .serverAddr=${this.serverAddr ?? location.host}
              ></mux-settings-surface>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-region': MuxRegion;
  }
}
