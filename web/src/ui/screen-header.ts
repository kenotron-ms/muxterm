import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** Shared screen location and control row. Most screens hide it on phones,
 * where the app title bar supplies location. Active Chat controls can keep it
 * visible there without repeating the workspace section. */
@customElement('mux-ui-screen-header')
export class MuxUIScreenHeader extends LitElement {
  @property() section = '';
  @property() heading = '';
  @property() label = '';
  @property({ type:Boolean, reflect:true, attribute:'with-section-icon' }) withSectionIcon = false;
  @property({ type:Boolean, reflect:true, attribute:'with-actions' }) withActions = false;
  @property({ type:Boolean, reflect:true, attribute:'with-leading' }) withLeading = false;
  @property({ type:Boolean, reflect:true, attribute:'show-on-phone' }) showOnPhone = false;

  static override styles = css`
    :host { box-sizing:border-box; display:block; flex:none; min-width:0; color:var(--ui-text); font:var(--ui-text-md)/1.5 var(--ui-font-sans); }
    header { box-sizing:border-box; height:var(--ui-nav-height); display:flex; align-items:center; gap:var(--ui-space-4); min-width:0; padding:0 var(--ui-screen-header-padding-right,max(var(--ui-space-5),var(--wco-right-inset,0px))) 0 var(--ui-space-6); border-bottom:1px solid var(--ui-border); background:var(--ui-surface-nav); }
    .section { display:inline-flex; align-items:center; gap:var(--ui-space-3); min-width:0; max-width:38%; overflow:hidden; white-space:nowrap; color:var(--ui-text-muted); }
    :host([with-section-icon]) .section { font-size:var(--ui-text-sm); font-weight:500; }
    .section-icon { display:flex; align-items:center; justify-content:center; flex:none; width:var(--ui-icon-xs); height:var(--ui-icon-xs); }
    slot[name='section-icon']::slotted(*) { display:flex; align-items:center; justify-content:center; width:100%; height:100%; line-height:0; }
    .section-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .divider { flex:none; color:var(--ui-text-muted); }
    .heading { display:flex; align-items:center; flex:1; min-width:0; overflow:hidden; }
    slot[name='heading'] { display:flex; align-items:center; min-width:0; overflow:hidden; }
    strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    slot[name='actions'] { display:flex; align-items:center; flex:none; margin-left:auto; }
    slot[name='leading'] { display:flex; align-items:center; flex:none; }
    @media (max-width:767.98px) {
      :host(:not([show-on-phone])) { display:none; }
      :host([show-on-phone]) .section,:host([show-on-phone]) .divider { display:none; }
      :host([show-on-phone]) header { gap:var(--ui-space-3); padding-left:var(--ui-space-5); padding-right:var(--ui-space-5); }
      :host([show-on-phone]) header { height:calc(var(--ui-nav-height) + env(safe-area-inset-top, 0px)); padding-top:env(safe-area-inset-top, 0px); }
    }
    @media (display-mode:window-controls-overlay) { header { -webkit-app-region:drag; } }
    @media (display-mode:window-controls-overlay) { slot[name='actions']::slotted(*),slot[name='leading']::slotted(*) { -webkit-app-region:no-drag; } }
  `;

  override render() {
    return html`<header aria-label=${this.label || nothing}>${this.withLeading ? html`<slot name="leading"></slot>` : nothing}<span class="section">${this.withSectionIcon ? html`<span class="section-icon" aria-hidden="true"><slot name="section-icon"></slot></span>` : nothing}<span class="section-label">${this.section}</span></span><span class="divider" aria-hidden="true">›</span><span class="heading"><slot name="heading"><strong>${this.heading}</strong></slot></span>${this.withActions ? html`<slot name="actions"></slot>` : nothing}</header>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-screen-header': MuxUIScreenHeader } }
