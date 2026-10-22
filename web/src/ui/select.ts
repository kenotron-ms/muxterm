import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export interface SelectOption { value:string; label:string; disabled?:boolean }
export type SelectSize = 'small' | 'medium';

/** A labeled native select whose options are supplied as data. The inner
 * select keeps browser keyboard and assistive-technology behavior. */
@customElement('mux-ui-select')
export class MuxUISelect extends LitElement {
  static formAssociated = true;

  @property() label = '';
  @property() description = '';
  @property() error = '';
  @property() value = '';
  @property() name = '';
  @property({ reflect:true }) size: SelectSize = 'medium';
  @property({ attribute:'aria-label' }) accessibleLabel = '';
  @property({ attribute:false }) options: ReadonlyArray<SelectOption> = [];
  @property({ type:Boolean, reflect:true }) disabled = false;
  @property({ type:Boolean, reflect:true }) required = false;

  private readonly internals = this.attachInternals();
  private defaultValue = '';

  static override styles = css`
    :host { display:block; min-width:0; color:var(--ui-text); font:var(--ui-text-md)/1.4 var(--ui-font-sans); }
    label { display:block; margin-bottom:var(--ui-space-3); font-weight:600; }
    select {
      box-sizing:border-box; display:block; width:100%; min-width:0;
      min-height:var(--ui-control-md); padding:0 var(--ui-space-5);
      border:1px solid var(--ui-border); border-radius:var(--ui-radius-md);
      outline:none; background:var(--ui-surface-raised); color:var(--ui-text);
      font:inherit; cursor:pointer;
    }
    select:hover:not(:disabled) { border-color:var(--ui-text-muted); }
    :host([size='small']) select { min-height:var(--ui-control-sm); padding:0 var(--ui-space-4); font-size:var(--ui-text-sm); }
    select:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    :host([invalid]) select { border-color:var(--ui-danger); }
    select:disabled { opacity:.5; cursor:default; }
    .description,.error { margin:var(--ui-space-3) 0 0; font-size:var(--ui-text-sm); }
    .description { color:var(--ui-text-muted); }
    .error { color:var(--ui-danger-text); }
    @media(pointer:coarse) { select,:host([size='small']) select { min-height:var(--ui-control-lg); } }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.defaultValue = this.getAttribute('value') ?? this.value;
    this.internals.setFormValue(this.value);
  }

  protected override updated(): void {
    const field = this.renderRoot.querySelector('select');
    if (!field) return;
    if (field.value !== this.value) field.value = this.value;
    this.syncValidity();
  }

  private syncValidity(): void {
    const field = this.renderRoot.querySelector('select');
    if (!field) return;
    const message = this.error || (field.validity.valid ? '' : field.validationMessage);
    this.toggleAttribute('invalid', Boolean(message));
    this.internals.setValidity(message ? { customError:true } : {}, message, field);
  }

  private onChange(event: Event): void {
    event.stopPropagation();
    this.value = (event.target as HTMLSelectElement).value;
    this.internals.setFormValue(this.value);
    this.syncValidity();
    this.dispatchEvent(new Event('change', { bubbles:true, composed:true }));
  }

  formResetCallback(): void {
    this.value = this.defaultValue;
    this.internals.setFormValue(this.value);
  }

  formDisabledCallback(disabled: boolean): void { this.disabled = disabled; }
  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('select')?.focus(options); }

  override render() {
    const describedBy = [this.description && 'description', this.error && 'error'].filter(Boolean).join(' ');
    return html`
      ${this.label ? html`<label for="field">${this.label}${this.required ? ' *' : ''}</label>` : nothing}
      <select id="field" .value=${this.value} ?disabled=${this.disabled} ?required=${this.required}
        aria-label=${this.accessibleLabel || nothing} aria-invalid=${String(Boolean(this.error))}
        aria-describedby=${describedBy || nothing} @change=${this.onChange}>
        ${this.options.map(option=>html`<option value=${option.value} ?disabled=${option.disabled} ?selected=${option.value===this.value}>${option.label}</option>`)}
      </select>
      ${this.description ? html`<p id="description" class="description">${this.description}</p>` : nothing}
      ${this.error ? html`<p id="error" class="error">${this.error}</p>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-select': MuxUISelect } }
