import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** A labelled group and optional divider inside a Choice Picker. */
@customElement('mux-ui-choice-section')
export class MuxUIChoiceSection extends LitElement {
  @property() heading = '';
  @property() description = '';
  @property({ type:Boolean, reflect:true }) separated = false;

  static override styles = css`
    :host { display:block; min-width:0; font-family:var(--ui-font-sans); }
    .divider { height:var(--ui-divider-thickness); margin:var(--ui-space-4) var(--ui-space-3) var(--ui-space-2); background:var(--ui-border); }
    .heading {
      padding:var(--ui-space-3) var(--ui-space-5);
      color:var(--ui-text-muted); font-size:var(--ui-text-xs); font-weight:700;
      letter-spacing:.09em; text-transform:uppercase;
    }
    .description { padding:0 var(--ui-space-5) var(--ui-space-4); color:var(--ui-text-muted); font-size:var(--ui-text-xs); line-height:1.4; }
  `;

  override render() {
    return html`${this.separated ? html`<div class="divider" aria-hidden="true"></div>` : nothing}
      <div role=${this.heading ? 'group' : nothing} aria-labelledby=${this.heading ? 'heading' : nothing}>
        ${this.heading ? html`<div class="heading" id="heading">${this.heading}</div>` : nothing}
        ${this.description ? html`<div class="description">${this.description}</div>` : nothing}
        <slot></slot>
      </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-choice-section': MuxUIChoiceSection } }
