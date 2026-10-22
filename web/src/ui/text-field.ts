import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type TextFieldType = 'text' | 'search' | 'email' | 'url' | 'password';
export type TextFieldSize = 'small' | 'medium';

/** A labeled single-line field with native input semantics and form value. */
@customElement('mux-ui-text-field')
export class MuxUITextField extends LitElement {
  static formAssociated = true;

  @property() label = '';
  @property() description = '';
  @property() error = '';
  @property() placeholder = '';
  @property() value = '';
  @property() name = '';
  @property() type: TextFieldType = 'text';
  @property({ reflect:true }) size: TextFieldSize = 'medium';
  @property() autocomplete = '';
  @property({ attribute: 'aria-label' }) accessibleLabel = '';
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: Boolean, reflect: true }) required = false;
  @property({ type: Boolean, reflect: true }) readonly = false;

  private readonly internals = this.attachInternals();
  private defaultValue = '';

  static override styles = css`
    :host { display:block; min-width:0; color:var(--ui-text); font:var(--ui-text-md)/1.4 var(--ui-font-sans); }
    label { display:block; margin-bottom:var(--ui-space-3); font-weight:600; }
    input {
      box-sizing:border-box;
      display:block;
      width:100%;
      min-width:0;
      min-height:var(--ui-control-md);
      padding:0 var(--ui-space-5);
      border:1px solid var(--ui-border);
      border-radius:var(--ui-radius-md);
      outline:none;
      background:var(--ui-surface-raised);
      color:var(--ui-text);
      font:inherit;
    }
    input::placeholder { color:var(--ui-text-muted); opacity:1; }
    :host([size='small']) input { min-height:var(--ui-control-sm); padding:0 var(--ui-space-4); font-size:var(--ui-text-sm); }
    input:hover:not(:disabled) { border-color:var(--ui-text-muted); }
    input:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    input:read-only { color:var(--ui-text-muted); }
    :host([invalid]) input { border-color:var(--ui-danger); }
    input:disabled { opacity:.5; cursor:default; }
    .description, .error { margin:var(--ui-space-3) 0 0; font-size:var(--ui-text-sm); }
    .description { color:var(--ui-text-muted); }
    .error { color:var(--ui-danger); }
    @media (pointer:coarse) { input,:host([size='small']) input { min-height:var(--ui-control-lg); } }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.defaultValue = this.getAttribute('value') ?? this.value;
    this.internals.setFormValue(this.value);
  }

  protected override updated(): void {
    this._syncValidity();
  }

  private _syncValidity(): void {
    const input = this.renderRoot.querySelector('input');
    if (!input) return;
    this.toggleAttribute('invalid', Boolean(this.error) || !input.validity.valid);
    if (this.error) this.internals.setValidity({ customError:true }, this.error, input);
    else if (!input.validity.valid) this.internals.setValidity({ customError:true }, input.validationMessage, input);
    else this.internals.setValidity({});
  }

  private _onInput(event: InputEvent): void {
    this.value = (event.target as HTMLInputElement).value;
    this.internals.setFormValue(this.value);
    this._syncValidity();
  }

  formResetCallback(): void {
    this.value = this.defaultValue;
    this.internals.setFormValue(this.value);
  }

  formDisabledCallback(disabled: boolean): void {
    this.disabled = disabled;
  }

  override focus(options?: FocusOptions): void {
    this.renderRoot.querySelector('input')?.focus(options);
  }

  select(): void {
    this.renderRoot.querySelector('input')?.select();
  }

  override render() {
    const describedBy = [this.description && 'description', this.error && 'error'].filter(Boolean).join(' ');
    return html`
      ${this.label ? html`<label for="input">${this.label}${this.required ? ' *' : ''}</label>` : nothing}
      <input id="input" .value=${this.value} type=${this.type} placeholder=${this.placeholder}
        autocomplete=${this.autocomplete || nothing} ?disabled=${this.disabled} ?readonly=${this.readonly}
        ?required=${this.required} aria-label=${this.accessibleLabel || nothing}
        aria-invalid=${String(Boolean(this.error))} aria-describedby=${describedBy || nothing}
        @input=${this._onInput}>
      ${this.description ? html`<p id="description" class="description">${this.description}</p>` : nothing}
      ${this.error ? html`<p id="error" class="error">${this.error}</p>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-ui-text-field': MuxUITextField }
}
