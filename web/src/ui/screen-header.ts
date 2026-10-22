import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** Desktop location strip above a screen's Page Intro. The app's phone title
 * bar supplies location at narrow widths, so this duplicate is hidden there. */
@customElement('mux-ui-screen-header')
export class MuxUIScreenHeader extends LitElement {
  @property() section = '';
  @property() heading = '';
  @property() label = '';
  @property({ type:Boolean, reflect:true, attribute:'with-section-icon' }) withSectionIcon = false;

  static override styles = css`
    :host { box-sizing:border-box; display:block; flex:none; min-width:0; color:var(--ui-text); font:var(--ui-text-md)/1.5 var(--ui-font-sans); }
    header { box-sizing:border-box; height:var(--ui-nav-height); display:flex; align-items:center; gap:var(--ui-space-4); min-width:0; padding:0 max(var(--ui-space-5),var(--wco-right-inset,0)) 0 var(--ui-space-6); border-bottom:1px solid var(--ui-border); background:var(--ui-surface-nav); }
    .section { display:inline-flex; align-items:center; gap:var(--ui-space-3); min-width:0; max-width:38%; overflow:hidden; white-space:nowrap; color:var(--ui-text-muted); }
    :host([with-section-icon]) .section { font-size:var(--ui-text-sm); font-weight:500; }
    .section-icon { display:inline-flex; flex:none; }
    .section-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .divider { flex:none; color:var(--ui-text-muted); }
    strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    @media (max-width:767.98px) { :host { display:none; } }
    @media (display-mode:window-controls-overlay) { header { -webkit-app-region:drag; } }
  `;

  override render() {
    return html`<header aria-label=${this.label || nothing}><span class="section">${this.withSectionIcon ? html`<span class="section-icon" aria-hidden="true"><slot name="section-icon"></slot></span>` : nothing}<span class="section-label">${this.section}</span></span><span class="divider" aria-hidden="true">›</span><strong>${this.heading}</strong></header>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-screen-header': MuxUIScreenHeader } }
