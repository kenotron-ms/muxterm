import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ArrowUp, Folder } from 'lucide';
import { icon } from '../lib/icons.js';
import type { MuxUITextField } from './text-field.js';
import './button.js';
import './text-field.js';

export interface FolderBrowserListing { path: string; parent: string; folders: string[] }

@customElement('mux-ui-folder-browser')
export class MuxUIFolderBrowser extends LitElement {
  @property({ attribute:false }) listing?: FolderBrowserListing;
  @property({ type:Boolean, attribute:'allow-new-folder' }) allowNewFolder = false;
  @property({ attribute:'choose-label' }) chooseLabel = 'Choose this folder';
  @state() private newFolderName = '';

  static styles = css`
    :host { display:block; min-width:0; border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); color:var(--ui-text); font:var(--ui-text-sm)/1.4 var(--ui-font-sans); overflow:hidden; }
    .head { display:flex; align-items:center; gap:var(--ui-space-2); padding:var(--ui-space-2); border-bottom:1px solid var(--ui-border); }
    .path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--ui-font-mono,ui-monospace,monospace); font-size:var(--ui-text-xs); }
    .folders { max-height:calc(var(--ui-control-md) * 5); overflow:auto; padding:var(--ui-space-2); }
    .entry { box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-3); width:100%; min-height:var(--ui-control-md); padding:var(--ui-space-2) var(--ui-space-3); border:0; border-radius:var(--ui-radius-sm); background:transparent; color:var(--ui-text); font:inherit; text-align:left; cursor:pointer; }
    .entry:hover { background:var(--ui-surface-hover); }
    .entry:focus-visible { outline:2px solid var(--ui-focus); outline-offset:-2px; }
    .entry svg { color:var(--ui-text-muted); }
    .empty { padding:var(--ui-space-3); color:var(--ui-text-muted); }
    .create { display:flex; align-items:center; gap:var(--ui-space-2); padding:var(--ui-space-3); border-top:1px solid var(--ui-border); }
    .create mux-ui-text-field { flex:1; min-width:0; }
    @media(max-width:480px) { .head { flex-wrap:wrap; } .path { flex-basis:calc(100% - var(--ui-control-md) - var(--ui-space-2)); } .head mux-ui-button:last-child { margin-left:auto; } .create { flex-wrap:wrap; } .create mux-ui-button { margin-left:auto; } }
  `;

  private emitPath(type: 'folder-navigate' | 'folder-choose' | 'folder-use-new', path: string) {
    this.dispatchEvent(new CustomEvent(type, { detail:{path}, bubbles:true, composed:true }));
  }

  override render() {
    const listing = this.listing;
    if (!listing) return nothing;
    const newName = this.newFolderName.trim();
    const validNewName = !!newName && newName !== '.' && newName !== '..' && !newName.includes('/');
    return html`<div class="head">
      <mux-ui-button variant="quiet" size="small" icon-only accessible-label="Parent folder" @click=${() => this.emitPath('folder-navigate',listing.parent)}>${icon(ArrowUp,{size:16})}</mux-ui-button>
      <span class="path" title=${listing.path}>${listing.path}</span>
      <mux-ui-button variant="secondary" size="small" @click=${() => this.emitPath('folder-choose',listing.path)}>${this.chooseLabel}</mux-ui-button>
    </div><div class="folders" role="group" aria-label="Folders in ${listing.path}">
      ${listing.folders.length ? listing.folders.map(name => html`<button class="entry" type="button" @click=${() => this.emitPath('folder-navigate',`${listing.path.replace(/\/$/,'')}/${name}`)}>${icon(Folder,{size:16})}<span>${name}</span></button>`) : html`<div class="empty">No subfolders</div>`}
    </div>${this.allowNewFolder ? html`<div class="create">
      <mux-ui-text-field aria-label="New folder name" placeholder="New folder name" .value=${this.newFolderName} @input=${(event:Event) => { this.newFolderName=(event.target as MuxUITextField).value; }} @keydown=${(event:KeyboardEvent) => { if (event.key === 'Enter' && validNewName) this.emitPath('folder-use-new',`${listing.path.replace(/\/$/,'')}/${newName}`); }}></mux-ui-text-field>
      <mux-ui-button size="small" ?disabled=${!validNewName} @click=${() => this.emitPath('folder-use-new',`${listing.path.replace(/\/$/,'')}/${newName}`)}>Use new folder</mux-ui-button>
    </div>` : nothing}`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-folder-browser': MuxUIFolderBrowser } }
