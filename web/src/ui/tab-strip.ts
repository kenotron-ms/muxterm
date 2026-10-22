import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { Plus, X } from 'lucide';
import { icon } from '../lib/icons.js';

export interface TabStripItem {
  id: string;
  label: string;
  title?: string;
  icon?: TemplateResult;
}

/** A closable tab row with roving focus and automatic selection on arrow keys.
 * The owner keeps tab content and persistence; this element owns tab controls. */
@customElement('mux-ui-tab-strip')
export class MuxUITabStrip extends LitElement {
  @property({ attribute: false }) tabs: TabStripItem[] = [];
  @property({ attribute: 'active-id' }) activeId = '';
  @property({ attribute: 'accessible-label' }) accessibleLabel = 'Tabs';

  static override styles = css`
    :host { box-sizing:border-box; display:flex; align-items:center; flex:none; gap:var(--ui-space-2); min-width:0; min-height:var(--ui-nav-height); padding:var(--ui-space-2) max(var(--ui-space-4),var(--wco-right-inset,0)) var(--ui-space-2) var(--ui-space-4); border-bottom:1px solid var(--ui-border); background:var(--ui-surface-nav); color:var(--ui-text); font:var(--ui-text-xs) var(--ui-font-sans); }
    .tabs { display:flex; align-items:center; flex:1; min-width:0; gap:var(--ui-space-2); overflow-x:auto; }
    .tab { box-sizing:border-box; display:flex; align-items:center; flex:0 1 var(--ui-tab-max-width); min-width:var(--ui-tab-min-width); min-height:var(--ui-control-md); border:1px solid transparent; border-radius:var(--ui-radius-lg); color:var(--ui-text-muted); }
    .tab:not(:first-child):not(.active) { border-left-color:var(--ui-border); border-radius:0; }
    .tab:hover { background:var(--ui-surface-hover); color:var(--ui-text); }
    .tab.active { border-color:var(--ui-border); background:var(--ui-surface-base); color:var(--ui-text); box-shadow:0 var(--ui-space-1) var(--ui-space-3) color-mix(in srgb,var(--ui-text) 7%,transparent); }
    button { box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; flex:none; min-height:var(--ui-control-sm); padding:0; border:0; border-radius:var(--ui-radius-md); background:transparent; color:inherit; cursor:pointer; }
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:-2px; }
    button:hover { background:var(--ui-surface-hover); }
    .select { flex:1; justify-content:flex-start; gap:var(--ui-space-4); min-width:0; min-height:var(--ui-control-md); padding:0 var(--ui-space-3) 0 var(--ui-space-5); font-weight:500; }
    .select svg { flex:none; }
    .select span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .close { width:var(--ui-control-sm); visibility:hidden; }
    .tab.active .close,.tab:hover .close,.tab:focus-within .close { visibility:visible; }
    .add { width:var(--ui-control-md); min-height:var(--ui-control-md); }
    @media (display-mode:window-controls-overlay) { :host { -webkit-app-region:no-drag; app-region:no-drag; } }
    @media (pointer:coarse) {
      .tab,.select,.close,.add { min-height:var(--ui-control-lg); }
      .close,.add { width:var(--ui-control-lg); }
      .close { visibility:visible; }
    }
  `;

  private emit(name: string, id?: string) {
    this.dispatchEvent(new CustomEvent(name, { detail:id ? {id} : undefined, bubbles:true, composed:true }));
  }

  private focusTab(id: string) {
    void this.updateComplete.then(() => {
      if (!this.isConnected) return;
      for (const button of this.renderRoot.querySelectorAll<HTMLButtonElement>('button[role="tab"]')) {
        if (button.dataset.id === id) { button.focus(); button.scrollIntoView({block:'nearest',inline:'nearest'}); break; }
      }
    });
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has('activeId')) this.renderRoot.querySelector('.tab.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }

  private focusSelectedAfterChange() {
    window.requestAnimationFrame(() => { if (this.isConnected) this.focusTab(this.activeId); });
  }

  private onTabKeydown(event: KeyboardEvent, id: string) {
    const index = this.tabs.findIndex(tab => tab.id === id);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % this.tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + this.tabs.length - 1) % this.tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = this.tabs.length - 1;
    else if (event.key === 'Delete') {
      event.preventDefault();
      this.emit('tab-close', id);
      this.focusSelectedAfterChange();
      return;
    } else return;
    event.preventDefault();
    const nextId = this.tabs[next].id;
    this.emit('tab-select', nextId);
    this.focusTab(nextId);
  }

  override render() {
    return html`<div class="tabs" role="tablist" aria-label=${this.accessibleLabel}>
      ${this.tabs.map(tab => html`<div class="tab ${tab.id === this.activeId ? 'active' : ''}">
        <button class="select" type="button" role="tab" data-id=${tab.id} title=${tab.title || tab.label}
          aria-selected=${String(tab.id === this.activeId)} tabindex=${tab.id === this.activeId ? 0 : -1}
          @click=${() => this.emit('tab-select',tab.id)} @keydown=${(event:KeyboardEvent) => this.onTabKeydown(event,tab.id)}>
          ${tab.icon || nothing}<span>${tab.label}</span>
        </button>
        <button class="close" type="button" aria-label=${`Close ${tab.label} tab`} title=${`Close ${tab.label} tab`}
          @click=${() => { this.emit('tab-close',tab.id); this.focusSelectedAfterChange(); }}>${icon(X,{size:13})}</button>
      </div>`)}
    </div><button class="add" type="button" aria-label="New tab" title="New tab" aria-keyshortcuts="Control+T" @click=${() => this.emit('tab-add')}>${icon(Plus,{size:17})}</button>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-ui-tab-strip': MuxUITabStrip }
}
