import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** A labeled multiline field with a native textarea and form value. */
@customElement('mux-ui-text-area')
export class MuxUITextArea extends LitElement {
  static formAssociated = true;

  @property() label = '';
  @property() description = '';
  @property() error = '';
  @property() placeholder = '';
  @property() value = '';
  @property() name = '';
  @property({ attribute: 'aria-label' }) accessibleLabel = '';
  @property({ type: Number }) rows = 5;
  @property({ type: Number }) maxLength = -1;
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: Boolean, reflect: true }) required = false;
  @property({ type: Boolean, reflect: true }) readonly = false;

  private readonly internals = this.attachInternals();
  private defaultValue = '';

  static override styles = css`
    :host { display:block; min-width:0; color:var(--ui-text); font:var(--ui-text-md)/1.4 var(--ui-font-sans); }
    label { display:block; margin-bottom:var(--ui-space-3); font-weight:600; }
    textarea {
      box-sizing:border-box; display:block; width:100%; min-width:0;
      min-height:calc(var(--ui-control-md) * 2); padding:var(--ui-space-4) var(--ui-space-5);
      border:1px solid var(--ui-border); border-radius:var(--ui-radius-md);
      outline:none; resize:vertical; background:var(--ui-surface-raised);
      color:var(--ui-text); font:inherit; line-height:1.5;
    }
    textarea::placeholder { color:var(--ui-text-muted); opacity:1; }
    textarea:hover:not(:disabled) { border-color:var(--ui-text-muted); }
    textarea:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    textarea:read-only { color:var(--ui-text-muted); }
    :host([invalid]) textarea { border-color:var(--ui-danger); }
    textarea:disabled { opacity:.5; cursor:default; }
    .description,.error { margin:var(--ui-space-3) 0 0; font-size:var(--ui-text-sm); }
    .description { color:var(--ui-text-muted); }
    .error { color:var(--ui-danger-text); }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.defaultValue = this.getAttribute('value') ?? this.value;
    this.internals.setFormValue(this.value);
  }

  protected override updated(): void { this.syncValidity(); }

  private syncValidity(): void {
    const field = this.renderRoot.querySelector('textarea');
    if (!field) return;
    const message = this.error || (field.validity.valid ? '' : field.validationMessage);
    this.toggleAttribute('invalid', Boolean(message));
    this.internals.setValidity(message ? { customError:true } : {}, message, field);
  }

  private onInput(event: InputEvent): void {
    this.value = (event.target as HTMLTextAreaElement).value;
    this.internals.setFormValue(this.value);
    this.syncValidity();
  }

  formResetCallback(): void {
    this.value = this.defaultValue;
    this.internals.setFormValue(this.value);
  }

  formDisabledCallback(disabled: boolean): void { this.disabled = disabled; }
  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('textarea')?.focus(options); }
  select(): void { this.renderRoot.querySelector('textarea')?.select(); }

  override render() {
    const describedBy = [this.description && 'description', this.error && 'error'].filter(Boolean).join(' ');
    return html`
      ${this.label ? html`<label for="field">${this.label}${this.required ? ' *' : ''}</label>` : nothing}
      <textarea id="field" .value=${this.value} rows=${this.rows} maxlength=${this.maxLength >= 0 ? this.maxLength : nothing} placeholder=${this.placeholder}
        ?disabled=${this.disabled} ?readonly=${this.readonly} ?required=${this.required}
        aria-label=${this.accessibleLabel || nothing} aria-invalid=${String(Boolean(this.error))}
        aria-describedby=${describedBy || nothing} @input=${this.onInput}></textarea>
      ${this.description ? html`<p id="description" class="description">${this.description}</p>` : nothing}
      ${this.error ? html`<p id="error" class="error">${this.error}</p>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-text-area': MuxUITextArea } }
