import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Folder } from 'lucide';
import { icon } from '../lib/icons.js';
import { sdkChats, type FolderListing } from '../lib/sdk-chats.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';

/** Selects one server folder. Rows select a folder; chevrons browse inside it. */
@customElement('mux-folder-picker')
export class MuxFolderPicker extends LitElement {
  @property() value = '';
  @property() remoteHost = '';
  @property() base = '';
  @property() label = 'Folder';
  @property({ type:Boolean, reflect:true }) field = false;
  @property({ type:Boolean, reflect:true }) inline = false;
  @state() private open = false;
  @state() private listing?: FolderListing;
  @state() private loading = false;
  @state() private error = '';
  @state() private above = false;
  private readonly onOutsidePointer = (event:PointerEvent) => {
    if (this.open && !event.composedPath().includes(this)) this.open = false;
  };

  static styles = css`
    ${subtleScrollbars}
    :host { display:inline-block; position:relative; min-width:0; font:var(--ui-text-sm)/1.4 var(--ui-font-sans); color:var(--ui-text); }
    :host([field]) { display:block; width:100%; }
    :host([inline]) { display:block; width:100%; }
    button { font:inherit; cursor:pointer; }
    .trigger { box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-3); width:100%; max-width:var(--ui-new-chat-location-width); height:var(--ui-control-sm); padding:0 var(--ui-space-4); border:1px solid transparent; border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text-muted); text-align:left; }
    .trigger:hover,.trigger[aria-expanded='true'] { background:var(--ui-surface-hover); color:var(--ui-text); }
    .trigger:focus-visible,.row:focus-visible,.browse:focus-visible,.up:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    .trigger svg { flex:none; }
    .trigger .path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    :host([field]) .trigger { max-width:none; height:var(--ui-control-md); border-color:var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); color:var(--ui-text); }
    .menu { position:absolute; z-index:var(--ui-z-menu); top:calc(100% + var(--ui-space-3)); left:0; box-sizing:border-box; width:min(var(--ui-mobile-drawer-width),calc(100vw - var(--ui-control-lg))); max-height:min(var(--ui-menu-max-height),60dvh); overflow:auto; padding:var(--ui-space-3); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); box-shadow:var(--ui-shadow-menu); }
    .menu.above { top:auto; bottom:calc(100% + var(--ui-space-3)); }
    :host([field]) .menu { width:100%; }
    :host([inline]) .menu { position:static; width:100%; max-height:min(var(--folder-list-height,var(--ui-menu-max-height)),40dvh); box-shadow:none; }
    .head { position:sticky; top:calc(-1 * var(--ui-space-3)); z-index:var(--ui-z-local); display:flex; align-items:center; gap:var(--ui-space-3); min-height:var(--ui-control-md); padding:0 var(--ui-space-2) var(--ui-space-3); border-bottom:1px solid var(--ui-border); background:var(--ui-surface-raised); color:var(--ui-text-muted); }
    .head span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--ui-text-xs); }
    .up,.browse { display:grid; place-items:center; flex:none; width:var(--ui-control-sm); height:var(--ui-control-sm); padding:0; border:0; border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text-muted); }
    .up:hover,.browse:hover { background:var(--ui-surface-hover); color:var(--ui-text); }
    .row-line { display:flex; align-items:center; }
    .row { display:flex; align-items:center; gap:var(--ui-space-4); flex:1; min-width:0; min-height:var(--ui-control-md); padding:var(--ui-space-3) var(--ui-space-4); border:0; border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text); text-align:left; }
    .row:hover,.row[selected] { background:var(--ui-surface-hover); }
    .row .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .row svg { flex:none; color:var(--ui-text-muted); }
    .row .check svg { color:var(--ui-accent); }
    .empty,.error { padding:var(--ui-space-4); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .error { color:var(--ui-danger-text); }
    @media (max-width:550px) { .menu { left:0; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.onOutsidePointer);
    if (this.inline) void this.browse(this.value || this.base);
  }
  override updated(changed: Map<string, unknown>) {
    if (changed.has('remoteHost') && this.inline && this.isConnected) void this.browse(this.value || this.base);
  }
  override disconnectedCallback() {
    document.removeEventListener('pointerdown', this.onOutsidePointer);
    super.disconnectedCallback();
  }
  private displayPath(path:string) {
    if (!path) return 'Choose a folder';
    const base = this.base.replace(/\/+$/, '');
    if (base && path === base) return base.split('/').filter(Boolean).at(-1) || '/';
    if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1);
    return path;
  }
  private async browse(path:string) {
    this.loading = true;
    this.error = '';
    try {
      const listing = await sdkChats.folders(path, this.remoteHost);
      this.listing = { ...listing, folders:[...listing.folders].sort((a,b) => Number(a.startsWith('.')) - Number(b.startsWith('.')) || a.localeCompare(b)) };
    }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.loading = false; }
  }
  private toggle() {
    this.open = !this.open;
    if (this.open) {
      const bounds = this.getBoundingClientRect();
      this.above = window.innerHeight - bounds.bottom < 380 && bounds.top > window.innerHeight - bounds.bottom;
      void this.browse(this.value || this.base);
    }
  }
  private select(path:string) {
    this.value = path;
    this.open = false;
    this.dispatchEvent(new CustomEvent('folder-selected', { detail:{path}, bubbles:true, composed:true }));
  }
  override render() {
    const current = this.listing;
    return html`
      ${this.inline ? nothing : html`<button class="trigger" type="button" aria-label=${this.label} aria-haspopup="menu" aria-expanded=${this.open} title=${this.value} @click=${this.toggle}>${icon(Folder,{size:15})}<span class="path">${this.displayPath(this.value)}</span>${this.field ? icon(ChevronDown,{size:14}) : nothing}</button>`}
      ${this.open || this.inline ? html`<div class=${this.above && !this.inline ? 'menu above' : 'menu'} role=${this.inline ? 'group' : 'menu'} aria-label="Folders" @keydown=${(event:KeyboardEvent) => { if (event.key === 'Escape' && !this.inline) { this.open = false; this.renderRoot.querySelector<HTMLButtonElement>('.trigger')?.focus(); } }}>
        ${current ? html`<div class="head"><button class="up" type="button" aria-label="Parent folder" title="Parent folder" ?disabled=${current.path === current.parent} @click=${() => void this.browse(current.parent)}>${icon(ArrowLeft,{size:16})}</button><span title=${current.path}>${current.path}</span></div>
          <div class="row-line"><button class="row" role="menuitemradio" aria-checked=${this.value === current.path} ?selected=${this.value === current.path} @click=${() => this.select(current.path)}>${icon(Folder,{size:15})}<span class="name">Use this folder</span>${this.value === current.path ? html`<span class="check">${icon(Check,{size:15})}</span>` : nothing}</button></div>
          ${current.folders.map(name => { const path = `${current.path.replace(/\/$/,'')}/${name}`; return html`<div class="row-line"><button class="row" role="menuitemradio" aria-checked=${this.value === path} ?selected=${this.value === path} title=${path} @click=${() => this.select(path)}>${icon(Folder,{size:15})}<span class="name">${name}</span>${this.value === path ? html`<span class="check">${icon(Check,{size:15})}</span>` : nothing}</button><button class="browse" type="button" aria-label=${`Browse inside ${name}`} title=${`Browse inside ${name}`} @click=${() => void this.browse(path)}>${icon(ChevronRight,{size:15})}</button></div>`; })}
          ${!current.folders.length ? html`<div class="empty">No folders inside</div>` : nothing}` : this.loading ? html`<div class="empty">Loading folders…</div>` : nothing}
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      </div>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-folder-picker': MuxFolderPicker } }
