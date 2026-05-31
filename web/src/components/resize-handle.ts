import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('mux-resize-handle')
export class MuxResizeHandle extends LitElement {
  static styles = css`
    :host {
      display: block;
      flex-shrink: 0;
    }

    :host([direction="horizontal"]) {
      width: 4px;
      cursor: col-resize;
    }

    :host([direction="vertical"]) {
      height: 4px;
      cursor: row-resize;
    }

    .handle {
      width: 100%;
      height: 100%;
      background: #292e42;
      transition: background 0.15s;
    }

    .handle:hover,
    .handle.dragging {
      background: #7aa2f7;
    }
  `;

  @property({ type: String, reflect: true })
  direction: 'horizontal' | 'vertical' = 'horizontal';

  private _dragging = false;
  private _startX = 0;
  private _startY = 0;

  private _onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    this._dragging = true;
    this._startX = e.clientX;
    this._startY = e.clientY;
    this.requestUpdate();

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const onPointerMove = (moveEvent: PointerEvent): void => {
      this.dispatchEvent(
        new CustomEvent('resize-drag', {
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
      this.requestUpdate();
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onPointerUp);
    };

    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerup', onPointerUp);
  };

  render() {
    return html`<div
      class="handle ${this._dragging ? 'dragging' : ''}"
      @pointerdown="${this._onPointerDown}"
    ></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-resize-handle': MuxResizeHandle;
  }
}