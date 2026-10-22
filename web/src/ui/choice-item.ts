import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** A selectable row for menus with short labels and optional help text. */
@customElement('mux-ui-choice-item')
export class MuxUIChoiceItem extends LitElement {
  @property() label = '';
  @property() description = '';
  @property({ type:Boolean, reflect:true }) selected = false;
  @property({ type:Boolean, reflect:true }) disabled = false;

  static override styles = css`
    :host { display:block; min-width:0; width:100%; font-family:var(--ui-font-sans); }
    button {
      box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-4);
      width:100%; min-height:var(--ui-control-md); padding:var(--ui-space-3) var(--ui-space-5);
      border:0; border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text);
      font:var(--ui-text-sm)/1.4 var(--ui-font-sans); text-align:left; cursor:pointer;
    }
    button:hover:not(:disabled) { background:var(--ui-surface-hover); }
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:-2px; }
    button:disabled { opacity:.5; cursor:default; }
    :host([selected]) button { background:var(--ui-nav-selected); }
    .copy { display:grid; gap:var(--ui-space-1); min-width:0; flex:1; }
    .label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    .description { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .check { flex:none; color:var(--ui-accent); font-weight:700; }
    @media(pointer:coarse) { button { min-height:var(--ui-control-lg); } }
  `;

  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('button')?.focus(options); }
  override click(): void { if (!this.disabled) this.renderRoot.querySelector('button')?.click(); }

  override render() {
    return html`<button type="button" aria-pressed=${String(this.selected)} aria-label=${this.label || nothing}
      aria-describedby=${this.description ? 'description' : nothing} ?disabled=${this.disabled}>
      <span class="copy"><span class="label">${this.label}</span>${this.description ? html`<span class="description" id="description">${this.description}</span>` : nothing}</span>
      ${this.selected ? html`<span class="check" aria-hidden="true">✓</span>` : nothing}
    </button>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-choice-item': MuxUIChoiceItem } }
