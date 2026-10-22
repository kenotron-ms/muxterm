import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export interface BreadcrumbItem { id:string; label:string; actionLabel?:string }

/** A path through a document or project. Ancestors are native buttons;
 * the last item names the current location. The owner handles navigation. */
@customElement('mux-ui-breadcrumb')
export class MuxUIBreadcrumb extends LitElement {
  @property({ attribute:false }) items: BreadcrumbItem[] = [];
  @property() label = 'Breadcrumb';
  @property({ reflect:true }) appearance: 'app' | 'document' = 'app';
  @property() placeholder = '';
  private sizeObserver?: ResizeObserver;
  private scrollFrame = 0;

  static override styles = css`
    :host { display:block; flex:1; min-width:0; font-family:var(--ui-font-sans); }
    nav { min-width:0; overflow-x:auto; scrollbar-width:none; }
    nav::-webkit-scrollbar { display:none; }
    ol { display:flex; align-items:center; gap:var(--ui-space-3); width:max-content; min-width:0; min-height:var(--ui-control-sm); margin:0; padding:0; list-style:none; white-space:nowrap; }
    li { display:flex; align-items:center; gap:var(--ui-space-3); min-width:0; }
    button { max-width:var(--ui-breadcrumb-ancestor-max-width); min-height:var(--ui-control-sm); overflow:hidden; border:0; padding:0; background:transparent; color:var(--ui-text-muted); text-overflow:ellipsis; white-space:nowrap; font:500 var(--ui-text-xs) var(--ui-font-sans); cursor:pointer; }
    button:hover { color:var(--ui-accent); }
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; border-radius:var(--ui-radius-sm); }
    .separator { color:var(--ui-text-muted); }
    [aria-current] { max-width:var(--ui-breadcrumb-current-max-width); overflow:hidden; color:var(--ui-text); text-overflow:ellipsis; white-space:nowrap; font:600 var(--ui-text-xs) var(--ui-font-sans); }
    :host([appearance='document']) button { color:var(--ui-document-muted); }
    :host([appearance='document']) button:hover { color:var(--ui-document-accent); }
    :host([appearance='document']) .separator { color:var(--ui-document-muted); }
    :host([appearance='document']) ol { width:100%; }
    :host([appearance='document']) li:last-child { flex:1; overflow:hidden; }
    :host([appearance='document']) li:last-child [aria-current] { max-width:100%; }
    :host([appearance='document']) [aria-current] { color:var(--ui-document-text); }
    .placeholder { color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-sans); }
    @media (pointer:coarse) { button { box-sizing:border-box; min-width:var(--ui-control-lg); min-height:var(--ui-control-lg); padding:0 var(--ui-space-3); } ol { min-height:var(--ui-control-lg); } }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.updateComplete.then(() => { if (this.isConnected) this.observeSize(); });
  }

  private observeSize(): void {
    const nav = this.renderRoot.querySelector('nav');
    if (nav) {
      this.sizeObserver?.disconnect();
      this.sizeObserver = new ResizeObserver(() => this.revealCurrent());
      this.sizeObserver.observe(nav);
    }
  }

  override disconnectedCallback(): void {
    this.sizeObserver?.disconnect();
    cancelAnimationFrame(this.scrollFrame);
    super.disconnectedCallback();
  }

  private revealCurrent(): void {
    cancelAnimationFrame(this.scrollFrame);
    if (this.appearance === 'document') return;
    this.scrollFrame = requestAnimationFrame(() => {
      const nav = this.renderRoot.querySelector('nav');
      if (this.isConnected && nav) nav.scrollLeft = nav.scrollWidth;
    });
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('items') || changed.has('appearance')) this.revealCurrent();
  }

  override render() {
    return html`<nav aria-label=${this.label}><ol>
      ${this.items.length ? this.items.map((item,index) => html`<li>
        ${index ? html`<span class="separator" aria-hidden="true">›</span>` : nothing}
        ${index === this.items.length-1
          ? html`<span aria-current="page" title=${item.label}>${item.label}</span>`
          : html`<button type="button" title=${item.label} aria-label=${item.actionLabel || item.label}
              @click=${() => this.dispatchEvent(new CustomEvent('breadcrumb-navigate',{bubbles:true,composed:true,detail:{id:item.id}}))}>${item.label}</button>`}
      </li>`) : html`<li class="placeholder">${this.placeholder}</li>`}
    </ol></nav>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-breadcrumb': MuxUIBreadcrumb } }
