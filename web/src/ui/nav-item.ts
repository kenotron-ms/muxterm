import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { StatusTone } from './status-badge.js';

/** A destination row for app navigation. The native button owns focus and
 * keyboard behavior; the active destination is exposed with aria-current. */
@customElement('mux-ui-nav-item')
export class MuxUINavItem extends LitElement {
  @property() label = '';
  @property() description = '';
  @property({ reflect: true }) variant: 'default' | 'section' = 'default';
  @property({ attribute:'status-tone', reflect:true }) statusTone: StatusTone | '' = '';
  @property({ type: Boolean, reflect: true }) active = false;
  @state() private hasIcon = false;

  static override styles = css`
    :host { display:block; box-sizing:border-box; font-family:var(--ui-font-sans); }
    button {
      box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-5);
      width:100%; min-height:var(--ui-control-md); padding:0 var(--ui-space-5);
      border:0; border-radius:var(--ui-radius-md); background:transparent;
      color:var(--ui-text-muted); text-align:left;
      font:500 var(--ui-text-md)/1.25 var(--ui-font-sans); cursor:pointer;
    }
    button:hover { background:var(--ui-surface-hover); color:var(--ui-text); }
    :host([active]) button { background:var(--ui-nav-selected); color:var(--ui-text); }
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:-2px; }
    .icon { display:inline-flex; align-items:center; justify-content:center; flex:none; width:var(--ui-icon-sm); height:var(--ui-icon-sm); color:currentColor; }
    .icon[hidden] { display:none; }
    .copy { flex:1; min-width:0; }
    .label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .description { display:none; margin-top:var(--ui-space-1); color:var(--ui-text-muted); font-size:var(--ui-text-xs); font-weight:400; line-height:1.35; }
    button.described { min-height:var(--ui-row-touch); padding:var(--ui-space-4) var(--ui-space-5); }
    button.described .label { display:block; font-weight:600; }
    button.described .description { display:-webkit-box; overflow:hidden; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
    :host([variant='section']) button { min-height:var(--ui-control-md); padding:var(--ui-space-4) var(--ui-space-6); border-radius:0; }
    :host([variant='section'][active]) button { box-shadow:inset 3px 0 var(--ui-accent); }
    .status { display:none; flex:none; width:var(--ui-status-dot-size); height:var(--ui-status-dot-size); border-radius:50%; background:var(--ui-text-muted); }
    :host([status-tone='neutral']) .status,:host([status-tone='success']) .status,:host([status-tone='warning']) .status,:host([status-tone='info']) .status { display:block; }
    :host([status-tone='success']) .status { background:var(--ui-success); }
    :host([status-tone='warning']) .status { background:var(--ui-warning); }
    :host([status-tone='info']) .status { background:var(--ui-accent); }
    @media (max-width:767.98px) {
      :host([variant='section']) { display:inline-flex; flex:none; }
      :host([variant='section']) button { width:auto; min-height:var(--ui-control-lg); padding:0 var(--ui-space-5); border-bottom:2px solid transparent; white-space:nowrap; }
      :host([variant='section'][active]) button { background:transparent; box-shadow:none; border-bottom-color:var(--ui-accent); }
    }
    @media (pointer:coarse) { button { min-height:var(--ui-control-lg); } }
  `;

  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('button')?.focus(options); }
  override click(): void { this.renderRoot.querySelector('button')?.click(); }
  private onIconSlotChange(event: Event): void { this.hasIcon = (event.target as HTMLSlotElement).assignedElements({flatten:true}).length > 0; }
  override render() {
    return html`<button class=${this.description ? 'described' : ''} type="button" title=${this.label} aria-current=${this.active ? 'page' : 'false'}>
      <span class="icon" aria-hidden="true" ?hidden=${!this.hasIcon && !this.querySelector('[slot="icon"]')}><slot name="icon" @slotchange=${this.onIconSlotChange}></slot></span>
      <span class="copy"><span class="label">${this.label}</span>${this.description ? html`<span class="description">${this.description}</span>` : ''}</span>
      <span class="status" aria-hidden="true"></span>
    </button>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-nav-item': MuxUINavItem } }
