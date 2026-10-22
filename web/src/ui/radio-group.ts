import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
  fontFamily?: string;
  disabled?: boolean;
}

/** One native radio group for mutually exclusive settings choices. */
@customElement('mux-ui-radio-group')
export class MuxUIRadioGroup extends LitElement {
  static formAssociated = true;

  @property() label = '';
  @property({ attribute:'aria-label' }) accessibleLabel = '';
  @property() name = '';
  @property() value = '';
  @property({ attribute:false }) options: ReadonlyArray<RadioOption> = [];
  @property({ type:Boolean, reflect:true }) disabled = false;

  private readonly internals = this.attachInternals();
  private defaultValue = '';

  static override styles = css`
    :host { display:block; min-width:0; color:var(--ui-text); font:var(--ui-text-md)/1.4 var(--ui-font-sans); }
    fieldset { display:grid; gap:var(--ui-space-1); min-width:0; margin:0; padding:0; border:0; }
    legend { margin-bottom:var(--ui-space-3); padding:0; font-weight:600; }
    label { box-sizing:border-box; display:flex; align-items:flex-start; gap:var(--ui-space-4); width:100%; min-height:var(--ui-control-md); padding:var(--ui-space-3) var(--ui-space-5); border-radius:var(--ui-radius-md); cursor:pointer; }
    label:hover:not(:has(input:disabled)) { background:var(--ui-surface-hover); }
    label:has(input:checked) { background:var(--ui-nav-selected); }
    label:has(input:focus-visible) { outline:2px solid var(--ui-focus); outline-offset:-2px; }
    label:has(input:disabled) { opacity:.5; cursor:default; }
    input { width:var(--ui-space-5); height:var(--ui-space-5); flex:none; margin:var(--ui-space-1) 0 0; accent-color:var(--ui-accent); cursor:inherit; }
    .copy { display:grid; gap:var(--ui-space-1); min-width:0; }
    .name { overflow-wrap:anywhere; }
    input:checked + .copy .name { font-weight:650; }
    .description { color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
    @media(pointer:coarse) { label { min-height:var(--ui-control-lg); } }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.defaultValue = this.getAttribute('value') ?? this.value;
    this.internals.setFormValue(this.value);
  }

  private onChange(event: Event): void {
    event.stopPropagation();
    this.value = (event.target as HTMLInputElement).value;
    this.internals.setFormValue(this.value);
    this.dispatchEvent(new CustomEvent('change', { detail:{value:this.value}, bubbles:true, composed:true }));
  }

  formResetCallback(): void { this.value = this.defaultValue; this.internals.setFormValue(this.value); }
  formDisabledCallback(disabled: boolean): void { this.disabled = disabled; }
  override focus(options?: FocusOptions): void {
    (this.renderRoot.querySelector<HTMLInputElement>('input:checked') ?? this.renderRoot.querySelector<HTMLInputElement>('input'))?.focus(options);
  }

  override render() {
    return html`<fieldset aria-label=${this.accessibleLabel || nothing} ?disabled=${this.disabled}>
      ${this.label ? html`<legend>${this.label}</legend>` : nothing}
      ${this.options.map(option => html`<label><input type="radio" name=${this.name || 'choice'} value=${option.value} ?checked=${option.value === this.value} ?disabled=${this.disabled || !!option.disabled} @change=${this.onChange}><span class="copy"><span class="name" style=${styleMap({fontFamily:option.fontFamily ? `'${option.fontFamily}', monospace` : undefined})}>${option.label}</span>${option.description ? html`<span class="description">${option.description}</span>` : nothing}</span></label>`)}
    </fieldset>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-radio-group': MuxUIRadioGroup } }
