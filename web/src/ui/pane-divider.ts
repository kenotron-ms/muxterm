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
      flex: none;
      width: var(--ui-chat-resize-handle-width);
      min-width: 0;
      height: 100%;
      background: transparent;
      cursor: col-resize;
      touch-action: none;
      -webkit-app-region: no-drag;
      app-region: no-drag;
    }
    :host::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: calc(50% - var(--ui-divider-thickness) / 2);
      width: var(--ui-divider-thickness);
      background: var(--ui-shell-divider);
      pointer-events: none;
    }
    :host(:hover)::after, :host(:focus-visible)::after { background: var(--ui-accent); }
    :host(:focus-visible) { outline: none; }
    :host([compact]) {
      width: var(--ui-pane-divider-track-width);
      background: var(--ui-surface-raised);
    }
    :host([compact])::after { left: auto; right: 0; }
    :host([fixed]) { width: var(--ui-divider-thickness); cursor: default; touch-action: auto; }
    :host([fixed])::after { left: 0; }
  `;

  override render() { return html``; }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-pane-divider': MuxUIPaneDivider } }
