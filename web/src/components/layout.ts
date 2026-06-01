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
      /* Do NOT set z-index here — keep z-index:auto so mux-resize-handle's
         z-index:10 can win during drag without needing a stacking-context battle. */
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

  /** Live drag state. Plain object — not @state, so no re-renders during drag. */
  private _drag: {
    delta: number; // cumulative pixel delta from drag start (updated on every pointermove)
    containerPx: number; // split container size in pixels at drag start
    leftChars: number; // left child size in chars at drag start
    rightChars: number; // right child size in chars at drag start
    leftId: number; // first-leaf pane ID of left child
    rightId: number; // first-leaf pane ID of right child
    leftChild: LayoutNode; // full left child node (for width/height of other axis)
    rightChild: LayoutNode; // full right child node
    isH: boolean; // horizontal split?
    handleEl: HTMLElement; // the handle DOM element (for direct transform)
  } | null = null;

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
      const flex = childSize / totalSize;

      items.push(
        html`<div class="pane-wrapper" style="flex: ${flex}">
          ${this._renderNode(child)}
        </div>`,
      );

      // Insert resize handle between children (not after last)
      if (i < node.children.length - 1) {
        const leftChild = node.children[i];
        const rightChild = node.children[i + 1];
        const isH = node.direction === 'horizontal';
        const leftChars = isH ? leftChild.width : leftChild.height;
        const rightChars = isH ? rightChild.width : rightChild.height;
        const leftId = this._firstLeafId(leftChild);
        const rightId = this._firstLeafId(rightChild);

        items.push(
          html`<mux-resize-handle
            direction="${node.direction}"
            @resize-drag-start="${(e: Event) => {
              const handleEl = e.currentTarget as HTMLElement;
              const splitEl = handleEl.parentElement!;
              this._drag = {
                delta: 0,
                containerPx: isH ? splitEl.clientWidth : splitEl.clientHeight,
                leftChars,
                rightChars,
                leftId,
                rightId,
                leftChild,
                rightChild,
                isH,
                handleEl,
              };
            }}"
            @resize-drag="${(e: CustomEvent<{ deltaX: number; deltaY: number }>) => {
              if (!this._drag || this._drag.leftId !== leftId) return;
              const delta = isH ? e.detail.deltaX : e.detail.deltaY;
              this._drag.delta = delta;
              // Move handle element directly via CSS transform — NO Lit re-render.
              // User sees the handle sliding; pane content stays frozen.
              this._drag.handleEl.style.transform = isH
                ? `translateX(${delta}px)`
                : `translateY(${delta}px)`;
            }}"
            @resize-drag-end="${() => {
              if (!this._drag || this._drag.leftId !== leftId) return;
              const {
                delta,
                containerPx,
                leftChars: lChars,
                rightChars: rChars,
                leftChild: lc,
                rightChild: rc,
                isH: h,
                handleEl,
              } = this._drag;

              // Reset handle transform — it will land at the new position once
              // Lit re-renders from the server-confirmed %layout-change.
              handleEl.style.transform = '';
              this._drag = null;

              // Compute new sizes (clamp to minimum 1 char each side)
              const totalChars = lChars + rChars;
              const charsPerPx = containerPx > 0 ? totalChars / containerPx : 1;
              const newL = Math.max(
                1,
                Math.min(totalChars - 1, lChars + Math.round(delta * charsPerPx)),
              );
              const newR = totalChars - newL;

              const cellDelta = newL - lChars;
              if (cellDelta === 0) return; // no movement

              const dir = h
                ? (cellDelta > 0 ? 'R' : 'L')
                : (cellDelta > 0 ? 'D' : 'U');
              const amount = Math.abs(cellDelta);

              // OPTIMISTIC UPDATE — apply new flex ratios directly to the DOM so
              // the split snaps to the dropped position instantly, before the
              // server round-trip completes. When %layout-change arrives, Lit
              // re-renders with the server-confirmed proportions (idempotent).
              const leftWrapper = handleEl.previousElementSibling as HTMLElement | null;
              const rightWrapper = handleEl.nextElementSibling as HTMLElement | null;
              if (leftWrapper) leftWrapper.style.flex = String(newL);
              if (rightWrapper) rightWrapper.style.flex = String(newR);

              // Fire ONE relative resize command to tmux.
              this.dispatchEvent(
                new CustomEvent('pane-resize-request', {
                  bubbles: true,
                  composed: true,
                  detail: { paneId: leftId, dir, amount },
                }),
              );
            }}"
          ></mux-resize-handle>`,
        );
      }
    }

    return html`<div class="${dirClass}">${items}</div>`;
  }

  private _firstLeafId(node: LayoutNode): number {
    if (node.type === 'leaf') return node.paneId;
    return this._firstLeafId(node.children[0]);
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
