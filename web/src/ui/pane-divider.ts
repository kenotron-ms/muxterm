import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';

/** The shared vertical seam for pane boundaries. Owners handle resize events. */
@customElement('mux-ui-pane-divider')
export class MuxUIPaneDivider extends LitElement {
  static override styles = css`
    :host {
      box-sizing: border-box;
      display: block;
      position: relative;
      z-index: var(--ui-z-drag-overlay);
      flex: none;
      width: var(--ui-divider-thickness);
      min-width: 0;
      height: 100%;
      background: transparent;
      cursor: col-resize;
      touch-action: none;
      -webkit-app-region: no-drag;
      app-region: no-drag;
    }
    :host::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: calc((var(--ui-divider-thickness) - var(--ui-chat-resize-handle-width)) / 2);
      width: var(--ui-chat-resize-handle-width);
      background: transparent;
    }
    :host::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: var(--ui-divider-thickness);
      background: var(--ui-shell-divider);
      pointer-events: none;
    }
    :host(:hover)::after, :host(:focus-visible)::after { background: var(--ui-accent); }
    :host(:focus-visible) { outline: none; }
    :host([fixed]) { cursor: default; touch-action: auto; }
    :host([fixed])::before { display: none; }
  `;

  override render() { return html``; }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-pane-divider': MuxUIPaneDivider } }
