import { LitElement, html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import './layout.js';
import './region-tabstrip.js';
import './browser-surface.js';
import './settings-surface.js';
import { isTerminalSurface, type SurfaceKind, type SessionInfo } from '../types.js';
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

    .blank-terminal {
      width: 100%;
      height: 100%;
      background: #1a1b26;
      padding: 6px 8px;
      box-sizing: border-box;
      display: flex;
      align-items: flex-start;
    }

    .blank-cursor {
      display: inline-block;
      width: 7px;
      height: 1.2em;
      background: #c0caf5;
      animation: cursor-blink 1s step-end infinite;
    }

    @keyframes cursor-blink {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0; }
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

  @property({ attribute: false })
  sessions: SessionInfo[] = [];

  @property({ type: String, attribute: 'active-session' })
  activeSession = '';

  @property({ type: String })
  surfaceKind: SurfaceKind = 'terminal';

  @property({ type: String, attribute: 'browser-url' })
  browserUrl?: string;

  @property({ type: String, attribute: 'server-addr' })
  serverAddr?: string;

  @property({ type: Boolean })
  isOnlyRegion = false;

  @property({ type: Boolean })
  showPendingTerminal = false;

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
        .sessionName="${this.sessionName}"
        .windows="${this.windows}"
        .activeWindowId="${this.activeWindowId}"
        .sessions="${this.sessions}"
        .activeSession="${this.activeSession}"
        .isDriver="${this.surfaceKind === 'driver'}"
        .isOnlyRegion="${this.isOnlyRegion}"
        @tab-select="${this._forwardEvent}"
        @tab-close="${this._forwardEvent}"
        @tab-new="${this._forwardEvent}"
        @open-session-picker="${this._forwardEvent}"
        @region-maximize="${this._forwardEvent}"
        @region-action="${this._forwardEvent}"
        @session-selected="${this._forwardEvent}"
        @new-session="${this._forwardEvent}"
      ></mux-region-tabstrip>
      <div class="body">
        ${isTerminalSurface(this.surfaceKind)
          ? this.showPendingTerminal
            ? html`<div class="blank-terminal"><span class="blank-cursor"></span></div>`
            : html`<mux-layout
                layout-string="${this.layoutString}"
                active-pane-id="${this.activePaneId}"
              ></mux-layout>`
          : this.surfaceKind === 'browser'
            ? html`<mux-browser-surface
                .url="${this.browserUrl ?? 'about:blank'}"
              ></mux-browser-surface>`
            : html`<mux-settings-surface
                .serverAddr="${this.serverAddr ?? location.host}"
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
