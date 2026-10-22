import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';

export type ChoicePickerPlacement = 'below' | 'above';
export type ChoicePickerAppearance = 'outlined' | 'plain';

/** A compact choice popover that presents as a bottom sheet on phones.
 * Slotted content keeps selection and data changes with the owning screen. */
@customElement('mux-ui-choice-picker')
export class MuxUIChoicePicker extends LitElement {
  private static readonly openPickers = new Set<MuxUIChoicePicker>();
  @property() label = '';
  @property() summary = '';
  @property({ reflect:true }) placement: ChoicePickerPlacement = 'below';
  @property({ reflect:true }) appearance: ChoicePickerAppearance = 'outlined';
  @property({ attribute:'panel-align', reflect:true }) panelAlign: 'left' | 'right' = 'left';
  @property({ type:Boolean, reflect:true }) open = false;

  static override styles = css`
    ${subtleScrollbars}
    :host { position:relative; display:block; min-width:0; font-family:var(--ui-font-sans); }
    :host([open]) { z-index:var(--ui-z-sheet); }
    details { min-width:0; }
    summary {
      box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-3);
      max-width:var(--ui-picker-trigger-width); min-height:var(--ui-control-md);
      padding:0 var(--ui-space-5); border:1px solid transparent;
      border-radius:var(--ui-radius-lg); color:var(--ui-text);
      font:var(--ui-text-sm)/1.4 var(--ui-font-sans); cursor:pointer; list-style:none;
    }
    summary::-webkit-details-marker { display:none; }
    summary:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    .summary-label { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .chevron { flex:none; margin-left:auto; color:var(--ui-text-muted); }
    :host([appearance='outlined']) summary { max-width:var(--ui-picker-trigger-compact-width); border-color:var(--ui-border); background:var(--ui-surface-raised); }
    :host([appearance='outlined']) summary:hover,:host([appearance='outlined'][open]) summary { border-color:var(--ui-accent); }
    :host([appearance='plain']) summary:hover,:host([appearance='plain'][open]) summary { background:var(--ui-surface-hover); border-color:var(--ui-border); }
    .panel {
      box-sizing:border-box; position:absolute; z-index:var(--ui-z-menu); width:min(var(--ui-picker-width),calc(100vw - var(--ui-space-11)));
      max-height:min(72dvh,var(--ui-dialog-height)); overflow:auto; padding:var(--ui-space-4);
      border:1px solid var(--ui-border); border-radius:var(--ui-radius-xl);
      background:var(--ui-surface-raised); background-image:var(--ui-overlay-backdrop-image); box-shadow:var(--ui-shadow-overlay);
    }
    :host([placement='below']) .panel { top:calc(var(--ui-control-md) + var(--ui-space-1)); max-height:min(48dvh,var(--ui-picker-compact-height)); }
    :host([placement='above']) .panel { bottom:calc(var(--ui-control-md) + var(--ui-space-2)); }
    :host([panel-align='left']) .panel { left:0; }
    :host([panel-align='right']) .panel { right:0; }
    @media(max-width:700px) {
      :host([placement]) .panel {
        position:fixed; z-index:var(--ui-z-sheet); inset:auto 0 0; width:100vw; max-width:none;
        max-height:min(78dvh,var(--ui-dialog-height)); padding:var(--ui-space-6);
        border-radius:var(--ui-radius-xl) var(--ui-radius-xl) 0 0;
        border-bottom:0; box-shadow:var(--ui-shadow-sheet);
      }
      .panel::before {
        content:''; display:block; width:var(--ui-control-md); height:var(--ui-space-2);
        margin:0 auto var(--ui-space-5); border-radius:var(--ui-radius-pill);
        background:var(--ui-border);
      }
    }
  `;

  private readonly closeOnOutsidePointer = (event: PointerEvent): void => {
    if (this.open && !event.composedPath().includes(this)) this.close();
  };
  private readonly closeOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.open || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    this.close(true);
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.closeOnOutsidePointer);
    document.addEventListener('keydown', this.closeOnEscape);
  }
  override disconnectedCallback(): void {
    MuxUIChoicePicker.openPickers.delete(this);
    document.removeEventListener('pointerdown', this.closeOnOutsidePointer);
    document.removeEventListener('keydown', this.closeOnEscape);
    super.disconnectedCallback();
  }

  override updated(): void {
    const details = this.renderRoot.querySelector('details');
    if (details && details.open !== this.open) details.open = this.open;
  }
  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('summary')?.focus(options); }

  close(restoreFocus = false): void {
    MuxUIChoicePicker.openPickers.delete(this);
    this.open = false;
    const details = this.renderRoot.querySelector('details');
    if (details) details.open = false;
    if (restoreFocus) this.focus();
  }

  private onToggle(event: Event): void {
    this.open = (event.target as HTMLDetailsElement).open;
    if (this.open) {
      for (const picker of MuxUIChoicePicker.openPickers) {
        if (picker !== this) picker.close();
      }
      MuxUIChoicePicker.openPickers.add(this);
    } else {
      MuxUIChoicePicker.openPickers.delete(this);
    }
  }

  override render() {
    const summary = this.summary.trim() || this.label.trim() || 'Choose an option';
    return html`<details ?open=${this.open} @toggle=${this.onToggle}>
      <summary aria-label=${this.label ? `${this.label}: ${this.summary.trim() || 'Choose an option'}` : summary}><span class="summary-label">${summary}</span><span class="chevron" aria-hidden="true">⌄</span></summary>
      <div class="panel"><slot></slot></div>
    </details>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-choice-picker': MuxUIChoicePicker } }
