import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { IconNode } from 'lucide';
import { icon } from '../lib/icons.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { listboxIndexForKey } from './listbox.js';
import './listbox-option.js';

export interface CommandSearchItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  icon?: IconNode;
}

/** Search and keyboard selection for command palettes and quick-open dialogs.
 * The feature owns its data source and handles selected item IDs. */
@customElement('mux-ui-command-search')
export class MuxUICommandSearch extends LitElement {
  @property() query = '';
  @property() placeholder = 'Search…';
  @property({ attribute:'aria-label' }) accessibleLabel = 'Search';
  @property({ attribute:false }) items: CommandSearchItem[] = [];
  @property({ type:Boolean }) loading = false;
  @property() error = '';
  @property() emptyMessage = 'No matches.';
  @property() hint = 'Type to search.';
  @property() footer = '';
  @state() private activeIndex = 0;

  static override styles = css`
    ${subtleScrollbars}
    :host { display:flex; flex-direction:column; width:100%; max-height:min(var(--ui-command-search-max-height),75dvh); overflow:hidden; color:var(--ui-text); font:var(--ui-text-sm) var(--ui-font-sans); }
    .search { display:flex; align-items:center; gap:var(--ui-space-5); padding:var(--ui-space-5); border-bottom:1px solid var(--ui-border); color:var(--ui-accent); }
    .search-icon { flex:none; display:flex; }
    input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--ui-text); font:var(--ui-text-lg) var(--ui-font-sans); }
    input::placeholder { color:var(--ui-text-muted); opacity:1; }
    input:focus-visible { outline:2px solid var(--ui-focus); outline-offset:var(--ui-space-1); border-radius:var(--ui-radius-sm); }
    kbd { flex:none; border:1px solid var(--ui-border); border-radius:var(--ui-radius-sm); padding:calc(var(--ui-space-1) / 2) var(--ui-space-2); color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-mono); }
    .results { min-height:0; overflow:auto; padding:var(--ui-space-3); }
    mux-ui-listbox { position:static; width:100%; max-height:none; padding:0; border:0; border-radius:0; box-shadow:none; background:transparent; }
    mux-ui-listbox-option { border-radius:var(--ui-radius-md); }
    mux-ui-listbox-option::part(row) { min-height:var(--ui-control-lg); }
    .item-icon { display:flex; }
    .item-detail { flex:none; align-self:center; padding:0 var(--ui-space-3); color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-mono); }
    p { margin:var(--ui-space-6); color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-sans); }
    .error { color:var(--ui-danger); }
    .footer { margin:var(--ui-space-3) var(--ui-space-6); }
    @media (pointer:coarse) { .search { min-height:var(--ui-control-lg); } }
  `;

  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('input')?.focus(options); }

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles:true, composed:true }));
  }

  private onInput(event: InputEvent): void {
    this.query = (event.target as HTMLInputElement).value;
    this.activeIndex = 0;
    this.emit('query-change', { query:this.query });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.emit('dismiss');
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = listboxIndexForKey(event.key, this.activeIndex, this.items.length);
      if (next !== null) { event.preventDefault(); this.activeIndex = next; this.renderRoot.querySelector(`#option-${next}`)?.scrollIntoView({ block:'nearest' }); }
      return;
    }
    if (event.key === 'Enter' && this.items[this.activeIndex]) {
      event.preventDefault();
      this.emit('item-select', { id:this.items[this.activeIndex].id });
    }
  }

  override render() {
    const hasItems = !this.loading && !this.error && this.items.length > 0;
    const active = Math.min(this.activeIndex, this.items.length - 1);
    return html`<div class="search"><span class="search-icon" aria-hidden="true"><slot name="icon"></slot></span><input type="search" role="combobox" aria-autocomplete="list" aria-label=${this.accessibleLabel} aria-controls=${hasItems ? 'results' : nothing} aria-expanded=${String(hasItems)} aria-activedescendant=${hasItems ? `option-${active}` : nothing} placeholder=${this.placeholder} .value=${this.query} @input=${this.onInput} @keydown=${this.onKeyDown}><kbd aria-hidden="true">ESC</kbd></div>
      <div class="results">${this.loading ? html`<p role="status">Searching…</p>` : this.error ? html`<p class="error" role="alert">${this.error}</p>` : hasItems ? html`<mux-ui-listbox id="results" label=${this.accessibleLabel} presentation="embedded">${this.items.map((item,index) => html`<mux-ui-listbox-option id=${`option-${index}`} .label=${item.label} .description=${item.description || ''} ?active=${index === active} @mouseenter=${() => { this.activeIndex = index; }} @click=${() => this.emit('item-select', { id:item.id })}>${item.icon ? html`<span class="item-icon" slot="icon">${icon(item.icon,{size:16})}</span>` : nothing}${item.detail ? html`<span class="item-detail" slot="detail">${item.detail}</span>` : nothing}</mux-ui-listbox-option>`)}</mux-ui-listbox>` : html`<p role="status">${this.query.trim() ? this.emptyMessage : this.hint}</p>`}${this.footer && !this.loading ? html`<p class="footer">${this.footer}</p>` : nothing}</div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-command-search': MuxUICommandSearch } }
