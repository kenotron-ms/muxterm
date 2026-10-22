import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';

/** A bounded, scrollable group of choices inside a picker section. */
@customElement('mux-ui-choice-list')
export class MuxUIChoiceList extends LitElement {
  static override styles = css`
    ${subtleScrollbars}
    :host { display:block; max-height:var(--ui-choice-list-max-height); overflow-y:auto; }
  `;

  override render() { return html`<slot></slot>`; }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-choice-list': MuxUIChoiceList } }
