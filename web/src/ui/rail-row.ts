import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** Compact selectable row for file, change and page rails. The inner button
 * keeps native activation; tree owners handle cross-row arrow navigation. */
@customElement('mux-ui-rail-row')
export class MuxUIRailRow extends LitElement {
  @property() label = '';
  @property() detail = '';
  @property() tooltip = '';
  @property({ type:Number }) depth = 0;
  @property({ type:Number }) level = 1;
  @property({ type:Boolean, reflect:true }) selected = false;
  @property({ type:Boolean, reflect:true }) tree = false;
  @property({ type:Boolean, reflect:true }) directory = false;
  @property({ type:Boolean, reflect:true, attribute:'reserve-chevron' }) reserveChevron = false;
  @property({ reflect:true }) variant: 'default' | 'root' = 'default';
  @property({ attribute:'detail-tone', reflect:true }) detailTone: 'muted' | 'accent' = 'muted';
  @property({ type:Boolean }) expanded = false;

  static override styles = css`
    :host { display:block; min-width:0; color:var(--ui-text); font:var(--ui-text-xs) var(--ui-font-sans); }
    button { box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-3); width:100%; min-width:0; min-height:var(--ui-control-sm); padding:0 var(--ui-space-5) 0 calc(var(--ui-space-4) + var(--ui-row-depth)*var(--ui-space-6)); border:0; background:transparent; color:inherit; text-align:left; font:inherit; cursor:pointer; }
    button:hover { background:var(--ui-surface-hover); }
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:-2px; }
    :host([selected]) button { background:color-mix(in srgb,var(--ui-accent) 17%,var(--ui-surface-hover)); box-shadow:inset 2px 0 var(--ui-accent); }
    :host([variant='root']) button { background:color-mix(in srgb,var(--ui-surface-base) 67%,var(--ui-surface-raised)); font-weight:600; }
    :host([variant='root']) button:hover { background:var(--ui-surface-hover); }
    .chevron,.icon { display:flex; align-items:center; justify-content:center; flex:none; color:var(--ui-text-muted); }
    .chevron { display:none; width:var(--ui-space-6); }
    :host([tree]) .chevron,:host([reserve-chevron]) .chevron { display:flex; }
    .icon { width:var(--ui-space-7); color:var(--ui-accent); }
    :host([directory]) .icon { color:color-mix(in srgb,var(--ui-accent) 65%,var(--ui-warning)); }
    .label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .detail { flex:none; color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-mono); white-space:nowrap; }
    :host([detail-tone='accent']) .detail { color:var(--ui-accent); font-weight:700; }
    @media (pointer:coarse) { button { min-height:var(--ui-control-lg); } }
  `;

  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('button')?.focus(options); }
  override click(): void { this.renderRoot.querySelector('button')?.click(); }

  override render() {
    return html`<button type="button" role=${this.tree ? 'treeitem' : nothing}
      aria-level=${this.tree ? this.level : nothing}
      aria-expanded=${this.tree && this.directory ? String(this.expanded) : nothing}
      aria-selected=${this.tree ? String(this.selected) : nothing}
      aria-current=${!this.tree && this.selected ? 'true' : nothing}
      title=${this.tooltip || this.label} style=${`--ui-row-depth:${this.depth}`}>
      <span class="chevron"><slot name="chevron"></slot></span>
      <span class="icon"><slot name="icon"></slot></span>
      <span class="label">${this.label}</span>
      ${this.detail ? html`<span class="detail">${this.detail}</span>` : nothing}
    </button>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-ui-rail-row': MuxUIRailRow }
}
