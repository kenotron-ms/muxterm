import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** A compact destination or disclosure in a list with sibling row actions.
 * The inner button owns focus and keyboard activation; the list owner keeps
 * navigation and any actions beside the row. */
@customElement('mux-ui-list-row')
export class MuxUIListRow extends LitElement {
  @property() label = '';
  @property() tooltip = '';
  @property({ reflect:true }) variant: 'item' | 'group' = 'item';
  @property({ type:Boolean, reflect:true }) selected = false;
  @property({ type:Boolean, reflect:true }) muted = false;
  @property({ type:Boolean }) expandable = false;
  @property({ type:Boolean }) expanded = false;

  static override styles = css`
    :host { display:flex; flex:1; min-width:0; color:var(--ui-text); font:var(--ui-text-sm)/1.35 var(--ui-font-sans); }
    button { box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-4); width:100%; min-width:0; min-height:var(--ui-control-sm); padding:var(--ui-space-1) var(--ui-space-2); border:0; border-radius:var(--ui-radius-md); background:transparent; color:inherit; text-align:left; font:inherit; font-weight:550; cursor:pointer; }
    :host([variant='group']) button { min-height:var(--ui-control-md); padding:0 var(--ui-space-3); font-weight:500; }
    button:hover { background:var(--ui-surface-hover); }
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:-2px; }
    :host([selected]) button { background:var(--ui-nav-selected); }
    :host([muted]) button { color:var(--ui-text-muted); }
    .icon { display:inline-flex; align-items:center; justify-content:center; flex:none; width:var(--ui-space-6); height:var(--ui-space-6); color:var(--ui-text-muted); }
    .label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    @media(pointer:coarse) { button,:host([variant='group']) button { min-height:var(--ui-control-lg); } }
  `;

  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('button')?.focus(options); }
  override click(): void { this.renderRoot.querySelector('button')?.click(); }

  override render() {
    return html`<button type="button" title=${this.tooltip || this.label}
      aria-current=${this.selected ? 'true' : nothing}
      aria-expanded=${this.expandable ? String(this.expanded) : nothing}>
      <span class="icon" aria-hidden="true"><slot name="icon"></slot></span>
      <span class="label">${this.label}</span>
    </button>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-list-row': MuxUIListRow } }
