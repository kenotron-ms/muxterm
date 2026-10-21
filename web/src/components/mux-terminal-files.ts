import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ArrowLeft, ChevronRight, Eye, EyeOff, FileText, Folder, Home, RefreshCw, X } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { icon } from '../lib/icons.js';

type Entry = { name: string; dir: boolean; size: number };
type Listing = { path: string; entries: Entry[]; truncated: boolean };
type Preview = { path: string; name: string; size: number; text: string; tooLarge: boolean; binary: boolean };

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

@customElement('mux-terminal-files')
export class MuxTerminalFiles extends LitElement {
  static styles = css`
    ${subtleScrollbars}
    :host { display:flex; flex-direction:column; min-width:0; height:100%; color:var(--chrome-text-bright); font:12px/1.4 Inter,system-ui,sans-serif; }
    button { color:inherit; font:inherit; cursor:pointer; }
    .header { box-sizing:border-box; height:var(--mux-titlebar-height,44px); flex:none; display:flex; align-items:center; gap:8px; padding:0 max(8px,var(--wco-right-inset,0px)) 0 16px; border-bottom:1px solid var(--chrome-border); background:var(--mux-titlebar-bg,var(--chrome-bar)); }
    .header strong { flex:1; font-size:12px; font-weight:650; }
    .icon-button { width:28px; height:28px; display:grid; place-items:center; border:0; border-radius:6px; background:transparent; color:var(--chrome-text-dim); }
    .icon-button:hover,.icon-button:focus-visible { background:var(--chrome-hover); color:var(--chrome-text-bright); }
    .icon-button:disabled { opacity:.45; cursor:default; }
    .location { min-height:40px; display:flex; align-items:center; gap:7px; padding:0 12px; border-bottom:1px solid var(--chrome-border); color:var(--chrome-text-dim); }
    .location span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .location .path { flex:1; }
    .body { flex:1; min-height:0; overflow:auto; padding:7px; }
    .entry { width:100%; min-height:34px; display:flex; align-items:center; gap:9px; padding:0 9px; border:0; border-radius:6px; background:transparent; text-align:left; }
    .entry:hover,.entry:focus-visible { background:var(--chrome-hover); }
    .entry svg { flex:none; color:var(--chrome-text-dim); }
    .entry.directory svg { color:var(--chrome-accent); }
    .entry .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .entry .size { flex:none; color:var(--chrome-text-dim); font-size:11px; }
    .message { margin:12px; color:var(--chrome-text-dim); overflow-wrap:anywhere; }
    .message.error { color:var(--mux-error,#f7768e); }
    .preview-header { display:flex; align-items:center; gap:8px; padding:7px 9px 10px; border-bottom:1px solid var(--chrome-border); }
    .preview-header strong { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .preview-header small { color:var(--chrome-text-dim); }
    pre { margin:0; padding:12px 9px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--chrome-text-bright); font:12px/1.5 ui-monospace,SFMono-Regular,monospace; }
  `;

  @state() private path = '.';
  @state() private listing?: Listing;
  @state() private preview?: Preview;
  @state() private loading = false;
  @state() private error = '';
  @state() private showHidden = false;
  private request = 0;
  private abort?: AbortController;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadDirectory('.');
  }

  override disconnectedCallback(): void {
    this.abort?.abort();
    super.disconnectedCallback();
  }

  private async loadDirectory(path: string): Promise<void> {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const request = ++this.request;
    this.path = path;
    this.preview = undefined;
    this.loading = true;
    this.error = '';
    try {
      const query = new URLSearchParams({ path });
      const response = await fetch(apiPath(`/api/terminal/files?${query}`), { signal: controller.signal });
      if (!response.ok) throw new Error(`Folder unavailable (${response.status})`);
      const listing = await response.json() as Listing;
      if (request === this.request) this.listing = listing;
    } catch (error) {
      if (request === this.request && !controller.signal.aborted) this.error = String(error);
    } finally {
      if (request === this.request) this.loading = false;
    }
  }

  private async openFile(path: string): Promise<void> {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const request = ++this.request;
    this.loading = true;
    this.error = '';
    try {
      const query = new URLSearchParams({ path });
      const response = await fetch(apiPath(`/api/terminal/file?${query}`), { signal: controller.signal });
      if (!response.ok) throw new Error(`File unavailable (${response.status})`);
      const preview = await response.json() as Preview;
      if (request === this.request) this.preview = preview;
    } catch (error) {
      if (request === this.request && !controller.signal.aborted) this.error = String(error);
    } finally {
      if (request === this.request) this.loading = false;
    }
  }

  private parentPath(): string {
    if (this.path === '.') return '.';
    const parts = this.path.split('/');
    parts.pop();
    return parts.join('/') || '.';
  }

  override render() {
    const location = this.path === '.' ? '~/' : `~/${this.path}/`;
    return html`
      <div class="header">
        <strong>Files</strong>
        <button class="icon-button" aria-label="${this.showHidden ? 'Hide hidden files' : 'Show hidden files'}" title="${this.showHidden ? 'Hide hidden files' : 'Show hidden files'}" aria-pressed="${this.showHidden}" @click=${() => { this.showHidden = !this.showHidden; }}>${icon(this.showHidden ? EyeOff : Eye,{size:15})}</button>
        <button class="icon-button" aria-label="Refresh files" title="Refresh" @click=${() => void this.loadDirectory(this.path)}>${icon(RefreshCw,{size:15})}</button>
        <button class="icon-button" aria-label="Close file explorer" title="Close" @click=${() => this.dispatchEvent(new CustomEvent('close',{bubbles:true,composed:true}))}>${icon(X,{size:16})}</button>
      </div>
      <div class="location">
        <button class="icon-button" aria-label="Home folder" title="Home folder" @click=${() => void this.loadDirectory('.')}>${icon(Home,{size:15})}</button>
        <button class="icon-button" aria-label="Parent folder" title="Parent folder" ?disabled=${this.path === '.'} @click=${() => void this.loadDirectory(this.parentPath())}>${icon(ArrowLeft,{size:15})}</button>
        <span class="path" title=${location}>${location}</span>
      </div>
      <div class="body">
        ${this.error ? html`<p class="message error" role="alert">${this.error}</p>` : ''}
        ${this.loading ? html`<p class="message">Loading…</p>` : this.preview ? html`
          <div class="preview-header">
            <button class="icon-button" aria-label="Back to files" title="Back to files" @click=${() => { this.preview = undefined; }}>${icon(ArrowLeft,{size:15})}</button>
            ${icon(FileText,{size:16})}
            <strong title=${this.preview.path}>${this.preview.name}</strong>
            <small>${readableSize(this.preview.size)}</small>
          </div>
          ${this.preview.tooLarge ? html`<p class="message">This file is too large to preview.</p>`
            : this.preview.binary ? html`<p class="message">Preview unavailable for this file.</p>`
            : html`<pre>${this.preview.text}</pre>`}
        ` : this.listing ? html`
          ${this.listing.entries.filter(entry => this.showHidden || !entry.name.startsWith('.')).map(entry => {
            const path = this.path === '.' ? entry.name : `${this.path}/${entry.name}`;
            return html`<button class="entry ${entry.dir ? 'directory' : ''}" title=${entry.name} @click=${() => void (entry.dir ? this.loadDirectory(path) : this.openFile(path))}>
              ${icon(entry.dir ? Folder : FileText,{size:16})}
              <span class="name">${entry.name}</span>
              ${entry.dir ? icon(ChevronRight,{size:14}) : html`<span class="size">${readableSize(entry.size)}</span>`}
            </button>`;
          })}
          ${!this.listing.entries.some(entry => this.showHidden || !entry.name.startsWith('.')) ? html`<p class="message">This folder is empty.</p>` : ''}
          ${this.listing.truncated ? html`<p class="message">Showing the first 500 entries.</p>` : ''}
        ` : ''}
      </div>
    `;
  }
}
