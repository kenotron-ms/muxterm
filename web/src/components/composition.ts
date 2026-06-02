import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import type { Arrangement } from '../lib/layout.js';
import './pane.js';

/**
 * mux-composition — live render surface for the sessiond multiplexer.
 *
 * Given an {@link Arrangement} computed by the responsive engine, this element
 * mounts one `mux-pane` host per VISIBLE pane. Each mux-pane attaches its
 * persistent xterm.js terminal from the terminalRegistry, so output frames and
 * keystrokes flow through the existing pane-host mechanism — composition only
 * decides which panes render and how they are laid out.
 *
 *   tiling  (wide / medium) → visible panes side-by-side as flex tiles
 *   tabbed  (narrow)        → a tab strip over the single visible pane
 *
 * Selecting a tab emits `pane-select` ({ paneId }); the app turns that into the
 * client-local active-pane choice (there is no sessiond select-pane message).
 */
@customElement('mux-composition')
export class MuxComposition extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #1a1b26;
    }

    .tiles {
      display: flex;
      flex-direction: row;
      flex: 1;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    .tile {
      display: flex;
      flex: 1 1 0;
      min-width: 40px;
      overflow: hidden;
    }

    .body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    .tabstrip {
      display: flex;
      flex-direction: row;
      gap: 2px;
      background: #16161e;
      border-bottom: 1px solid #1f2335;
      overflow-x: auto;
    }

    .tab {
      padding: 6px 14px;
      font: inherit;
      font-size: 13px;
      color: #565f89;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
    }

    .tab.active {
      color: #c0caf5;
      border-bottom-color: #7aa2f7;
    }
  `;

  @property({ attribute: false })
  arrangement: Arrangement = { mode: 'tiling', order: [], visible: [], active: null };

  private _select(paneId: number): void {
    this.dispatchEvent(
      new CustomEvent('pane-select', {
        bubbles: true,
        composed: true,
        detail: { paneId },
      }),
    );
  }

  private _renderPane(paneId: number) {
    // Key by paneId so Lit gives every distinct pane its own dedicated shell
    // element; the terminal lives in terminalRegistry and survives remount.
    return keyed(
      paneId,
      html`<mux-pane
        pane-id="${paneId}"
        ?active="${paneId === this.arrangement.active}"
      ></mux-pane>`,
    );
  }

  render() {
    const { mode, order, visible, active } = this.arrangement;
    if (visible.length === 0) return html``;

    if (mode === 'tabbed') {
      return html`
        <div class="tabstrip">
          ${order.map(
            (id) => html`<button
              class="tab ${id === active ? 'active' : ''}"
              @click="${() => this._select(id)}"
            >
              ${id}
            </button>`,
          )}
        </div>
        <div class="body">${visible.map((id) => this._renderPane(id))}</div>
      `;
    }

    return html`<div class="tiles">
      ${visible.map((id) => html`<div class="tile">${this._renderPane(id)}</div>`)}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-composition': MuxComposition;
  }
}
