import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
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

  // Local size overrides: key = `${leftPaneId}:${rightPaneId}:${direction}`, value = [leftFlex, rightFlex]
  @state() private _localFlex = new Map<string, [number, number]>();

  // Drag-start sizes: same key, value = [initialLeftChars, initialRightChars, totalContainerPx]
  private _dragInit = new Map<string, [number, number, number]>();

  // True while the user holds a resize handle — prevents server layout-change events
  // from snapping the layout back mid-drag. Not @state: no re-render needed.
  private _isDragging = false;

  // Populated on drag-end with what we sent to the server.
  // _localFlex is only cleared when an incoming layoutString matches this.
  private _expectedAfterResize = new Map<number, { width: number; height: number }>();

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

  override updated(changedProperties: Map<PropertyKey, unknown>): void {
    if (!changedProperties.has('layoutString')) return;
    if (this._isDragging) return; // never reconcile during active drag
    if (this._localFlex.size === 0) return; // nothing to reconcile

    if (this._expectedAfterResize.size > 0) {
      // We sent a resize to the server. Only clear when the incoming layout
      // reflects the expected dimensions (within 2-char tolerance).
      // Stale pre-resize layouts are ignored to prevent the snap-back jump.
      try {
        const tree = parseLayout(this.layoutString);
        let confirmed = true;
        for (const [paneId, expected] of this._expectedAfterResize) {
          const actual = this._findPaneDimensions(tree, paneId);
          if (actual === null) continue; // pane not in layout — treat as confirmed
          if (
            Math.abs(actual.width - expected.width) > 2 ||
            Math.abs(actual.height - expected.height) > 2
          ) {
            confirmed = false;
            break;
          }
        }
        if (confirmed) {
          this._localFlex = new Map();
          this._expectedAfterResize = new Map();
        }
        // Not confirmed → stale layout update. Keep _localFlex active.
      } catch {
        // Parse error — clear and reset to be safe
        this._localFlex = new Map();
        this._expectedAfterResize = new Map();
      }
    } else {
      // No pending resize confirmation — reconcile normally
      this._localFlex = new Map();
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

      // Compute effective flex, with local drag override if present
      let flex = childSize / totalSize;

      // Check if this child is the LEFT of an overridden pair
      if (i < node.children.length - 1) {
        const nextChild = node.children[i + 1];
        const key = `${this._firstLeafId(child)}:${this._firstLeafId(nextChild)}:${node.direction}`;
        const ov = this._localFlex.get(key);
        if (ov) flex = ov[0];
      }
      // Check if this child is the RIGHT of an overridden pair
      if (i > 0) {
        const prevChild = node.children[i - 1];
        const key = `${this._firstLeafId(prevChild)}:${this._firstLeafId(child)}:${node.direction}`;
        const ov = this._localFlex.get(key);
        if (ov) flex = ov[1];
      }

      items.push(
        html`<div class="pane-wrapper" style="flex: ${flex}">
          ${this._renderNode(child)}
        </div>`,
      );

      // Insert resize handle between children (not after last)
      if (i < node.children.length - 1) {
        const leftChild = child;
        const rightChild = node.children[i + 1];
        const leftSize = isHorizontal ? leftChild.width : leftChild.height;
        const rightSize = isHorizontal ? rightChild.width : rightChild.height;
        const leftId = this._firstLeafId(leftChild);
        const rightId = this._firstLeafId(rightChild);
        const hkey = `${leftId}:${rightId}:${node.direction}`;

        items.push(
          html`<mux-resize-handle
            direction="${node.direction}"
            @resize-drag-start="${(e: Event) => {
              this._isDragging = true;
              const handleEl = e.currentTarget as HTMLElement;
              const splitEl = handleEl.parentElement!;
              const containerPx = isHorizontal ? splitEl.clientWidth : splitEl.clientHeight;
              this._dragInit.set(hkey, [leftSize, rightSize, containerPx]);
            }}"
            @resize-drag="${(e: CustomEvent<{ deltaX: number; deltaY: number }>) => {
              const init = this._dragInit.get(hkey);
              if (!init) return;
              const [initL, initR, containerPx] = init;
              const delta = isHorizontal ? e.detail.deltaX : e.detail.deltaY;
              const totalChars = initL + initR;
              const charsPerPx = containerPx > 0 ? totalChars / containerPx : 1;

              // New sizes in chars (clamped to minimum 1)
              const newL = Math.max(1, initL + Math.round(delta * charsPerPx));
              const newR = Math.max(1, totalChars - newL);
              const total = newL + newR;

              // Instant local flex override — triggers immediate re-render (no server call during drag)
              this._localFlex = new Map(this._localFlex.set(hkey, [newL / total, newR / total]));
            }}"
            @resize-drag-end="${() => {
              this._isDragging = false;

              // Compute final sizes from current _localFlex override
              const flex = this._localFlex.get(hkey);
              const init = this._dragInit.get(hkey);
              if (flex && init) {
                const totalChars =
                  (isHorizontal ? leftChild.width : leftChild.height) +
                  (isHorizontal ? rightChild.width : rightChild.height);
                const newL = Math.max(1, Math.round(flex[0] * totalChars));
                const newR = Math.max(1, totalChars - newL);

                // Fire ONE server resize on drop
                this.dispatchEvent(
                  new CustomEvent('pane-resize-request', {
                    bubbles: true,
                    composed: true,
                    detail: {
                      leftPaneId: leftId,
                      rightPaneId: rightId,
                      direction: node.direction,
                      leftWidth: isHorizontal ? newL : leftChild.width,
                      leftHeight: isHorizontal ? leftChild.height : newL,
                      rightWidth: isHorizontal ? newR : rightChild.width,
                      rightHeight: isHorizontal ? rightChild.height : newR,
                    },
                  }),
                );

                // Record what we expect the server to confirm so updated()
                // can ignore stale pre-resize layouts and avoid the snap-back jump.
                this._expectedAfterResize.set(leftId, {
                  width: isHorizontal ? newL : leftChild.width,
                  height: isHorizontal ? leftChild.height : newL,
                });
              }

              this._dragInit.delete(hkey);
              // Keep _localFlex until layoutString prop updates (server will confirm)
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

  private _findPaneDimensions(
    node: LayoutNode,
    paneId: number,
  ): { width: number; height: number } | null {
    if (node.type === 'leaf') {
      return node.paneId === paneId ? { width: node.width, height: node.height } : null;
    }
    for (const child of node.children) {
      const result = this._findPaneDimensions(child, paneId);
      if (result !== null) return result;
    }
    return null;
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
