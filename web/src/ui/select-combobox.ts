import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ChevronDown } from 'lucide';
import { icon } from '../lib/icons.js';
import { listboxIndexForKey } from './listbox.js';
import './listbox-option.js';

export interface SelectComboboxOption {
  value: string;
  label: string;
  description?: string;
  icon?: TemplateResult;
  separatorBefore?: boolean;
}

let nextComboboxId = 0;

/** A select-only combobox. Its button and options share a shadow root so
 * aria-controls and aria-activedescendant resolve to the actual listbox rows. */
@customElement('mux-ui-select-combobox')
export class MuxUISelectCombobox extends LitElement {
  @property() label = '';
  @property() value = '';
  @property() placeholder = 'Select an option';
  @property({ attribute:false }) options: SelectComboboxOption[] = [];
  @property({ reflect:true }) appearance: 'tinted' | 'outlined' = 'outlined';
  @property({ type:Boolean, reflect:true }) disabled = false;
  @state() private open = false;
  @state() private activeIndex = 0;
  private readonly listboxId = `ui-select-combobox-${++nextComboboxId}`;

  static override styles = css`
    :host { display:inline-block; position:relative; min-width:0; max-width:var(--ui-picker-trigger-compact-width); font-family:var(--ui-font-sans); }
    button { box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-3); width:100%; min-width:0; min-height:var(--ui-control-md); padding:0 var(--ui-space-4); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); color:var(--ui-text); font:600 var(--ui-text-sm)/1.3 var(--ui-font-sans); text-align:left; cursor:pointer; }
    :host([appearance='tinted']) button { background:var(--ui-surface-tinted); }
    button:hover,button[aria-expanded='true'] { border-color:var(--ui-accent); }
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    button:disabled { opacity:.5; cursor:default; }
    .icon { display:flex; flex:none; color:var(--ui-accent); }
    .value { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .chevron { display:flex; flex:none; margin-left:auto; color:var(--ui-text-muted); }
    mux-ui-listbox { --ui-listbox-width:var(--ui-picker-trigger-width); }
  `;

  private readonly onOutsidePointer = (event: PointerEvent) => {
    if (this.open && !event.composedPath().includes(this)) this.open = false;
  };
  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('pointerdown',this.onOutsidePointer);
  }
  override disconnectedCallback(): void {
    document.removeEventListener('pointerdown',this.onOutsidePointer);
    super.disconnectedCallback();
  }
  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('button')?.focus(options); }
  override click(): void { this.renderRoot.querySelector('button')?.click(); }

  private openListbox(): void {
    this.activeIndex = Math.max(0,this.options.findIndex(option => option.value === this.value));
    this.open = true;
  }
  private select(value: string): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent('change',{detail:{value},bubbles:true,composed:true}));
    this.focus();
  }
  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.open) {
      event.preventDefault();
      event.stopPropagation();
      this.open = false;
      return;
    }
    if (event.key === 'Tab' && this.open) { this.open = false; return; }
    if ((event.key === 'Enter' || event.key === ' ') && this.open) {
      event.preventDefault();
      this.select(this.options[this.activeIndex]?.value ?? this.value);
      return;
    }
    const next = listboxIndexForKey(event.key,this.open ? this.activeIndex : Math.max(0,this.options.findIndex(option => option.value === this.value)),this.options.length);
    if (next === null) return;
    event.preventDefault();
    this.open = true;
    this.activeIndex = next;
  }
  override updated(): void {
    if (this.open) this.renderRoot.querySelector(`#${this.listboxId}-option-${this.activeIndex}`)?.scrollIntoView({block:'nearest'});
  }
  override render() {
    const selected = this.options.find(option => option.value === this.value);
    return html`<button type="button" role="combobox" aria-label=${this.label || nothing} aria-haspopup="listbox" aria-expanded=${this.open}
      aria-controls=${this.open ? this.listboxId : nothing}
      aria-activedescendant=${this.open ? `${this.listboxId}-option-${this.activeIndex}` : nothing}
      ?disabled=${this.disabled}
      @click=${() => { if (this.open) this.open = false; else this.openListbox(); }}
      @keydown=${this.onKeyDown}>
      ${selected?.icon ? html`<span class="icon" aria-hidden="true">${selected.icon}</span>` : nothing}
      <span class="value">${selected?.label || this.placeholder}</span>
      <span class="chevron" aria-hidden="true">${icon(ChevronDown,{size:16})}</span>
    </button>${this.open ? html`<mux-ui-listbox id=${this.listboxId} label=${this.label}>
      ${this.options.map((option,index) => html`${option.separatorBefore ? html`<div role="separator"></div>` : nothing}<mux-ui-listbox-option
        id=${`${this.listboxId}-option-${index}`} .label=${option.label} .description=${option.description ?? ''}
        ?selected=${this.value === option.value} ?active=${this.activeIndex === index} show-check
        @click=${() => this.select(option.value)}>${option.icon ? html`<span slot="icon">${option.icon}</span>` : nothing}</mux-ui-listbox-option>`)}
    </mux-ui-listbox>` : nothing}`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-select-combobox': MuxUISelectCombobox } }
