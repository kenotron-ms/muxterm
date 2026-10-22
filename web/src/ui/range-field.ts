import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** A labelled native range input with a consistent value and endpoint layout. */
@customElement('mux-ui-range-field')
export class MuxUIRangeField extends LitElement {
  @property() label = '';
  @property({ attribute:'accessible-label' }) accessibleLabel = '';
  @property({ attribute:false }) valueLabels: string[] = [];
  @property() unit = '';
  @property({ attribute:'min-label' }) minLabel = '';
  @property({ attribute:'max-label' }) maxLabel = '';
  @property({ type:Number }) min = 0;
  @property({ type:Number }) max = 100;
  @property({ type:Number }) step = 1;
  @property({ type:Number }) value = 0;
  @property({ type:Boolean, reflect:true }) disabled = false;
  @property({ reflect:true }) layout: 'stacked' | 'inline' = 'stacked';

  static override styles = css`
    :host { display:block; box-sizing:border-box; min-width:0; padding:var(--ui-space-3) var(--ui-space-5) var(--ui-space-5); color:var(--ui-text); font:var(--ui-text-sm)/1.4 var(--ui-font-sans); }
    :host([disabled]) { opacity:.55; }
    .field { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; column-gap:var(--ui-space-4); }
    .label { color:var(--ui-text); font-weight:600; }
    .value { text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
    input { grid-column:1/-1; box-sizing:border-box; width:100%; min-height:var(--ui-control-md); margin:var(--ui-space-2) 0 0; padding:0; accent-color:var(--ui-accent); cursor:pointer; }
    input:disabled { cursor:default; }
    input:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; border-radius:var(--ui-radius-sm); }
    .ends { grid-column:1/-1; display:flex; justify-content:space-between; gap:var(--ui-space-4); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .ends:empty { display:none; }
    :host([layout='inline']) { padding:var(--ui-space-3) var(--ui-space-5); }
    :host([layout='inline']) .field { grid-template-columns:var(--ui-row-touch) minmax(0,1fr) auto; gap:var(--ui-space-5); }
    :host([layout='inline']) .label { color:var(--ui-text-muted); font-weight:400; }
    :host([layout='inline']) input { grid-column:2; margin:0; }
    :host([layout='inline']) .value { grid-column:3; min-width:var(--ui-control-sm); }
    :host([layout='inline']) .ends { grid-column:2; }
    @media(max-width:700px) {
      :host([layout='inline']) .field { grid-template-columns:minmax(0,1fr) auto; gap:var(--ui-space-2); }
      :host([layout='inline']) input, :host([layout='inline']) .ends { grid-column:1/-1; }
      :host([layout='inline']) .value { grid-column:2; min-width:0; }
    }
  `;

  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('input')?.focus(options); }

  private updateValue(event: Event): void {
    event.stopPropagation();
    this.value = Number((event.target as HTMLInputElement).value);
    this.dispatchEvent(new CustomEvent(event.type, { detail:{ value:this.value }, bubbles:true, composed:true }));
  }

  override render() {
    const labelIndex = Math.round((this.value - this.min) / this.step);
    const displayValue = this.valueLabels[labelIndex] ?? `${this.value}${this.unit}`;
    return html`<div class="field">
      <span class="label">${this.label}</span>
      <span class="value">${displayValue}</span>
      <input type="range" aria-label=${this.accessibleLabel || this.label || nothing}
        aria-valuetext=${this.valueLabels.length ? displayValue : nothing} min=${this.min} max=${this.max} step=${this.step}
        .value=${String(this.value)} ?disabled=${this.disabled}
        @input=${this.updateValue} @change=${this.updateValue}>
      ${this.minLabel || this.maxLabel ? html`<div class="ends"><span>${this.minLabel}</span><span>${this.maxLabel}</span></div>` : nothing}
    </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-range-field': MuxUIRangeField } }
