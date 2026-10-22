import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** A labelled listbox option with an optional icon and descriptive second line. */
@customElement('mux-ui-listbox-option')
export class MuxUIListboxOption extends LitElement {
  @property() label = '';
  @property() description = '';
  @property({ type:Boolean, reflect:true }) selected = false;
  @property({ type:Boolean, reflect:true }) active = false;
  @property({ type:Boolean, reflect:true, attribute:'show-check' }) showCheck = false;
  @property({ reflect:true }) layout: 'stacked' | 'inline' = 'stacked';

  static override styles = css`
    :host { box-sizing:border-box; display:block; min-width:0; width:100%; cursor:pointer; font-family:var(--ui-font-sans); }
    .row {
      box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-4);
      min-height:var(--ui-control-md); padding:var(--ui-space-3) var(--ui-space-4);
      border-radius:var(--ui-radius-md); color:var(--ui-text);
    }
    :host(:hover) .row,:host([active]) .row { background:var(--ui-surface-hover); }
    :host([selected]) .row { background:var(--ui-nav-selected); }
    :host([active]) .row,:host(:focus-visible) .row { outline:2px solid var(--ui-focus); outline-offset:-2px; }
    ::slotted([slot='icon']) { display:flex; flex:none; color:var(--ui-accent); }
    .copy { display:grid; gap:var(--ui-space-1); flex:1; min-width:0; }
    .label { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:var(--ui-text-sm); font-weight:600; }
    .description { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .check { flex:none; color:var(--ui-accent); font-weight:700; }
    ::slotted([slot='detail']) { flex:none; }
    :host([layout='inline']) .copy { display:flex; align-items:baseline; gap:var(--ui-space-6); }
    :host([layout='inline']) .label { flex:none; min-width:var(--ui-space-16); color:var(--ui-accent); font:600 var(--ui-text-sm)/1.4 var(--ui-font-mono); }
    :host([layout='inline']) .description { flex:1; font-size:var(--ui-text-sm); }
    @media(pointer:coarse) { .row { min-height:var(--ui-control-lg); } }
    @media(max-width:700px) { :host([layout='inline']) .copy { display:grid; gap:var(--ui-space-1); } }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('role', 'option');
    this.tabIndex = -1;
  }
  override updated(): void {
    this.setAttribute('aria-selected', String(this.selected));
    // The option host and its description span live in different shadow trees.
    // Include both in the stable accessible name instead of an ID reference.
    const accessibleName = [this.label, this.description].filter(Boolean).join(', ');
    if (accessibleName) this.setAttribute('aria-label', accessibleName);
    else this.removeAttribute('aria-label');
  }
  override render() {
    return html`<div class="row" part="row"><slot name="icon"></slot><span class="copy"><span class="label">${this.label}</span>${this.description ? html`<span class="description">${this.description}</span>` : nothing}</span><slot name="detail"></slot>${this.selected && this.showCheck ? html`<span class="check" aria-hidden="true">✓</span>` : nothing}</div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-listbox-option': MuxUIListboxOption } }
