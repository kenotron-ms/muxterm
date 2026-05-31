import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { parseLayout } from '../lib/layout-parser.js';
import type { LayoutNode, LayoutSplit, LayoutLeaf } from '../types.js';
import './pane.js';
import './resize-handle.js';

@customElement('mux-layout')
export class MuxLayout extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex: 1;
      overflow: hidden;
      background: #1a1b26;
    }

    .split-h {
      display: flex;
      flex-direction: row;
      width: 100%;
      height: 100%;
    }

    .split-v {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }

    .pane-wrapper {
      position: relative;
      overflow: hidden;
      min-width: 40px;
      min-height: 20px;
    }

    .empty {
      display: flex;
      width: 100%;
      height: 100%;
      background: #1a1b26;
      /* No text — blank dark area while layout loads */
      color: transparent;
      font-size: 14px;
    }
  `;

  @property({ type: String, attribute: 'layout-string' })
  layoutString = '';

  @property({ type: Number, attribute: 'active-pane-id' })
  activePaneId = -1;

  render() {
    if (!this.layoutString) {
      return html`<div class="empty">No panes</div>`;
    }

    try {
      const tree = parseLayout(this.layoutString);
      return this._renderNode(tree);
    } catch {
      return html`<div class="empty">Layout error</div>`;
    }
  }

  private _renderNode(node: LayoutNode) {
    if (node.type === 'leaf') {
      return this._renderLeaf(node);
    }
    return this._renderSplit(node);
  }

  private _renderSplit(node: LayoutSplit) {
    const dirClass = node.direction === 'horizontal' ? 'split-h' : 'split-v';
    const isHorizontal = node.direction === 'horizontal';

    const totalSize = node.children.reduce(
      (sum, child) => sum + (isHorizontal ? child.width : child.height),
      0,
    );

    const items: unknown[] = [];
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const childSize = isHorizontal ? child.width : child.height;

      items.push(
        html`<div class="pane-wrapper" style="flex: ${childSize / totalSize}">
          ${this._renderNode(child)}
        </div>`,
      );

      // Insert resize handle between children (not after last)
      if (i < node.children.length - 1) {
        items.push(
          html`<mux-resize-handle
            direction="${node.direction}"
          ></mux-resize-handle>`,
        );
      }
    }

    return html`<div class="${dirClass}">${items}</div>`;
  }

  private _renderLeaf(node: LayoutLeaf) {
    // Key by paneId so Lit creates one mux-pane shell per distinct pane.
    // Without this, Lit reuses the same <mux-pane> element across window
    // switches — it just rewrites the pane-id attribute — so every window
    // ends up sharing ONE shell. Keying ensures each pane gets its own
    // dedicated shell element. The terminal itself lives in terminalRegistry
    // and survives unmounting/remounting intact (scrollback preserved).
    return keyed(
      node.paneId,
      html`<mux-pane
        pane-id="${node.paneId}"
        ?active="${node.paneId === this.activePaneId}"
      ></mux-pane>`,
    );
  }

  getPaneElement(paneId: number): Element | null {
    return this.shadowRoot?.querySelector(`mux-pane[pane-id="${paneId}"]`) ?? null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-layout': MuxLayout;
  }
}