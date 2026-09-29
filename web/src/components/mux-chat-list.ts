import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Ellipsis, Folder, FolderOpen } from 'lucide';
import { icon } from '../lib/icons.js';
import { sdkChats, type SDKChat, type SDKProject } from '../lib/sdk-chats.js';

interface ChatGroup { id: string; name: string; project?: SDKProject; chats: SDKChat[]; archived?: boolean }

@customElement('mux-chat-workspace')
export class MuxChatWorkspace extends LitElement {
  @property({ attribute: false }) model!: ChatGroup;
  @property() selectedSession = '';
  @state() private open = true;
  @state() private menuOpen = false;
  @state() private error = '';
  @state() private renamingId = '';
  @state() private renameDraft = '';

  private readonly closeMenuOnOutsidePointer = (event: PointerEvent) => {
    if (this.menuOpen && !event.composedPath().includes(this)) this.menuOpen = false;
  };
  private readonly closeMenuOnEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') this.menuOpen = false;
  };

  override connectedCallback() {
    super.connectedCallback();
    if (this.model?.archived) this.open = false;
    document.addEventListener('pointerdown', this.closeMenuOnOutsidePointer);
    document.addEventListener('keydown', this.closeMenuOnEscape);
  }
  override disconnectedCallback() {
    document.removeEventListener('pointerdown', this.closeMenuOnOutsidePointer);
    document.removeEventListener('keydown', this.closeMenuOnEscape);
    super.disconnectedCallback();
  }

  static styles = css`
    :host { display:block; margin:2px 0; font:12px/1.35 system-ui,sans-serif; color:var(--chrome-text-bright,#d8dce5); }
    button { font:inherit; color:inherit; border:0; cursor:pointer; background:transparent; }
    .row,.chat-row { display:flex; align-items:center; min-height:30px; border-radius:6px; position:relative; }
    .row:hover,.chat-row:hover { background:rgba(255,255,255,.07); }
    .group { display:flex; align-items:center; gap:7px; flex:1; min-width:0; padding:5px 5px; text-align:left; }
    .folder,.chevron { display:inline-flex; align-items:center; justify-content:center; flex:none; line-height:0; }
    .folder { width:17px; color:#aab8d8; }
    .chevron { width:14px; color:var(--chrome-text-dim,#9299a5); }
    .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    .archived .name { color:var(--chrome-text-dim,#aab2c1); }
    .more,.action { display:inline-flex; align-items:center; justify-content:center; width:25px; height:25px; flex:none; border-radius:5px; color:var(--chrome-text-dim,#aab2c1); }
    .more:hover,.action:hover { background:rgba(255,255,255,.1); color:inherit; }
    .menu { position:absolute; z-index:20; top:28px; right:4px; min-width:165px; padding:5px; background:var(--chrome-bar,#252b38); border:1px solid var(--chrome-border,#3b4355); border-radius:8px; }
    .menu button { width:100%; padding:8px; text-align:left; border-radius:5px; }
    .menu button:hover { background:rgba(255,255,255,.09); }
    .chats { margin:0 0 5px; }
    .chat { flex:1; min-width:0; min-height:28px; padding:3px 5px; text-align:left; border-radius:6px; display:flex; align-items:center; gap:7px; }
    .chat[selected] { background:rgba(122,162,247,.16); }
    .status { width:6px; height:6px; border-radius:50%; background:#697386; flex:none; }
    .status.working { background:#7dcba1; }
    .title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:550; }
    .harness { color:var(--chrome-text-dim,#aab2c1); font-size:10px; flex:none; text-transform:lowercase; }
    .rename-input { flex:1; min-width:0; margin:3px 5px; border:1px solid #8aa9eb; border-radius:4px; padding:3px 5px; background:var(--chrome-bar,#252b38); color:inherit; font:inherit; }
    .error { color:#e6a5a5; padding:5px; }
  `;

  private async removeProject() {
    this.menuOpen = false;
    if (!this.model.project) return;
    try { await sdkChats.removeProject(this.model.id); }
    catch (error) { this.error = String(error); }
  }
  private openChat(chat: SDKChat) {
    this.dispatchEvent(new CustomEvent('chat-open', { detail:{sessionId:chat.id}, bubbles:true, composed:true }));
  }
  private async saveRename() {
    const id = this.renamingId;
    const title = this.renameDraft.trim();
    if (!id || !title) return;
    try { await sdkChats.rename(id, title); this.renamingId = ''; this.error = ''; }
    catch (error) { this.error = String(error); }
  }
  private async toggleArchive(chat: SDKChat) {
    try { await sdkChats.setArchived(chat.id, !chat.archived); this.error = ''; }
    catch (error) { this.error = String(error); }
  }

  override render() {
    const group = this.model;
    return html`
      <div class="row ${group.archived ? 'archived' : ''}">
        <button class="group" title=${group.project?.path || group.name} aria-expanded=${this.open} @click=${() => { this.open = !this.open; this.menuOpen = false; }}>
          <span class="folder">${icon(this.open ? FolderOpen : Folder, { size: 16 })}</span>
          <span class="name">${group.name}</span>
          <span class="chevron">${icon(this.open ? ChevronDown : ChevronRight, { size: 14 })}</span>
        </button>
        ${group.project ? html`<button class="more" aria-label=${`More options for ${group.name}`} aria-expanded=${this.menuOpen} @click=${() => { this.menuOpen = !this.menuOpen; }}>${icon(Ellipsis, { size: 16 })}</button>` : nothing}
        ${this.menuOpen ? html`<div class="menu" role="menu"><button role="menuitem" @click=${() => void this.removeProject()}>Remove this project</button></div>` : nothing}
      </div>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${this.open ? html`<div class="chats">${repeat(group.chats, chat => chat.id, chat => html`
        <div class="chat-row">
          ${this.renamingId === chat.id ? html`<input class="rename-input" aria-label="Chat name" .value=${this.renameDraft} @input=${(e: Event) => { this.renameDraft = (e.target as HTMLInputElement).value; }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') void this.saveRename(); if (e.key === 'Escape') this.renamingId = ''; }}><button class="action" aria-label="Save chat name" @click=${() => void this.saveRename()}>✓</button>` : html`
            <button class="chat" ?selected=${this.selectedSession === chat.id} title=${`${chat.title}\n${chat.projectPath || 'Folder unknown'}`} @click=${() => this.openChat(chat)}>
              <span class="status ${chat.state}" title=${chat.state}></span>
              <span class="title">${chat.title}</span>
              <span class="harness">${chat.harness}</span>
            </button>
            <button class="action" aria-label=${`Rename ${chat.title}`} title="Rename chat" @click=${() => { this.renamingId = chat.id; this.renameDraft = chat.title; }}>✎</button>
            <button class="action" aria-label=${`${chat.archived ? 'Restore' : 'Archive'} ${chat.title}`} title=${chat.archived ? 'Restore chat' : 'Archive chat'} @click=${() => void this.toggleArchive(chat)}>${icon(chat.archived ? ArchiveRestore : Archive, { size: 14 })}</button>`}
        </div>`)}
      </div>` : nothing}
    `;
  }
}

@customElement('mux-chat-list')
export class MuxChatList extends LitElement {
  @state() private version = 0;
  private unsubs: (() => void)[] = [];
  static styles = css`
    :host { display:block; color:var(--chrome-text-dim,#9299a5); font:12px/1.35 system-ui,sans-serif; }
    .heading { padding:9px 5px 3px; font-size:10px; letter-spacing:.1em; text-transform:uppercase; }
  `;
  override connectedCallback() {
    super.connectedCallback();
    const update = () => this.version++;
    this.unsubs = [sdkChats.subscribe(update)];
    void sdkChats.refresh();
  }
  override disconnectedCallback() { this.unsubs.forEach(unsub => unsub()); this.unsubs = []; super.disconnectedCallback(); }
  override render() {
    void this.version;
    const projects = [...sdkChats.projects].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const chats = [...sdkChats.chats].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    const active = chats.filter(chat => !chat.archived);
    const groups: ChatGroup[] = projects.map(project => ({ id:project.id, name:project.name, project,
      chats:active.filter(chat => chat.workspaceId === project.id) }));
    groups.push({ id:'ungrouped', name:'Ungrouped', chats:active.filter(chat =>
      !chat.workspaceId || !projects.some(project => project.id === chat.workspaceId)) });
    groups.push({ id:'archived', name:`Archived (${chats.length - active.length})`, archived:true, chats:chats.filter(chat => chat.archived) });
    return html`<div class="heading">Chats</div>${repeat(groups, group => group.id, group => html`<mux-chat-workspace .model=${group} .selectedSession=${(window as Window & { muxSelectedSDKChat?: string }).muxSelectedSDKChat ?? ''}></mux-chat-workspace>`)}`;
  }
}
