import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { icon } from '../lib/icons.js';
import { GripHorizontal, GripVertical } from 'lucide';

@customElement('mux-region-divider')
export class MuxRegionDivider extends LitElement {
  static styles = css`
    :host {
      display: block;
      flex-shrink: 0;
    }

    :host([direction='horizontal']) {
      width: 12px;
      cursor: col-resize;
    }

    :host([direction='vertical']) {
      height: 8px;
      cursor: row-resize;
    }

    .handle {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #1f2335;
      color: #565f89;
      transition: background 0.15s;
      user-select: none;
    }

    .handle:hover,
    .handle.dragging {
      background: #292e42;
      color: #7aa2f7;
    }

    :host([direction='horizontal']) .handle::after {
      content: '';
      display: block;
      width: 2px;
      height: 24px;
      background: #414868;
      border-radius: 1px;
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }
  `;

  @property({ type: String, reflect: true })
  direction: 'horizontal' | 'vertical' = 'horizontal';

  @state()
  private _dragging = false;

  private _startX = 0;
  private _startY = 0;

  private _onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    this._dragging = true;

    this._startX = e.clientX;
    this._startY = e.clientY;

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const onPointerMove = (moveEvent: PointerEvent): void => {
      this.dispatchEvent(
        new CustomEvent('region-resize-drag', {
          bubbles: true,
          composed: true,
          detail: {
            deltaX: moveEvent.clientX - this._startX,
            deltaY: moveEvent.clientY - this._startY,
          },
        }),
      );
    };

    const onPointerUp = (): void => {
      this._dragging = false;
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onPointerUp);
      this.dispatchEvent(
        new CustomEvent('region-resize-end', {
          bubbles: true,
          composed: true,
        }),
      );
    };

    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerup', onPointerUp);
  };

  render() {
    // horizontal direction = vertical divider bar (splits left/right) → GripVertical dots
    // vertical direction = horizontal divider bar (splits top/bottom) → GripHorizontal dots
    const gripIcon = this.direction === 'horizontal'
      ? icon(GripVertical, { size: 10 })
      : icon(GripHorizontal, { size: 10 });
    return html`<div
      class="handle ${this._dragging ? 'dragging' : ''}"
      @pointerdown="${this._onPointerDown}"
    >${gripIcon}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-region-divider': MuxRegionDivider;
  }
}
