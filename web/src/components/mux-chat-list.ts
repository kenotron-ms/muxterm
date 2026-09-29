import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { Archive, ArchiveRestore, Check, Ellipsis, Folder, FolderOpen, FolderPlus, MessageSquare, Pencil, Pin, PinOff, Plus, Settings2, Trash2, X } from 'lucide';
import { icon } from '../lib/icons.js';
import { sdkChats, type FolderListing, type SDKChat, type SDKProject } from '../lib/sdk-chats.js';

interface ChatGroup { id: string; name: string; project?: SDKProject; chats: SDKChat[]; archived?: boolean }

@customElement('mux-chat-workspace')
export class MuxChatWorkspace extends LitElement {
  @property({ attribute: false }) model!: ChatGroup;
  @property() selectedSession = '';
  @state() private open = true;
  @state() private menuFor = '';
  @state() private contextMenu = false;
  @state() private editing = false;
  @state() private editName = '';
  @state() private editPath = '';
  @state() private editFolders: string[] = [];
  @state() private newSource = '';
  @state() private editListing?: FolderListing;
  @state() private browseTarget: 'primary' | 'source' = 'source';
  @state() private error = '';
  @state() private renamingId = '';
  @state() private renameDraft = '';

  private readonly onOutsidePointer = (event: PointerEvent) => {
    if (!event.composedPath().includes(this)) { this.menuFor = ''; this.contextMenu = false; }
  };
  private readonly onEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { this.menuFor = ''; this.contextMenu = false; this.renamingId = ''; }
  };
  override connectedCallback() {
    super.connectedCallback();
    if (this.model?.archived) this.open = false;
    document.addEventListener('pointerdown', this.onOutsidePointer);
    document.addEventListener('keydown', this.onEscape);
  }
  override disconnectedCallback() {
    document.removeEventListener('pointerdown', this.onOutsidePointer);
    document.removeEventListener('keydown', this.onEscape);
    super.disconnectedCallback();
  }
  reveal() { this.open = true; this.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

  static styles = css`
    :host { display:block; margin:2px 0; font:12px/1.35 system-ui,sans-serif; color:var(--chrome-text-bright,#d8dce5); }
    button { font:inherit; color:inherit; border:0; cursor:pointer; background:transparent; }
    .row,.chat-row { display:flex; align-items:center; min-height:30px; border-radius:6px; position:relative; }
    .row:hover,.chat-row:hover { background:rgba(255,255,255,.07); }
    .group { display:flex; align-items:center; gap:7px; flex:1; min-width:0; padding:5px; text-align:left; }
    .folder { display:inline-flex; align-items:center; justify-content:center; flex:none; line-height:0; }
    .folder { width:17px; color:#aab8d8; }
    .name,.title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .name { font-weight:600; }
    .archived .name { color:var(--chrome-text-dim,#aab2c1); }
    .action { display:inline-flex; align-items:center; justify-content:center; width:25px; height:25px; flex:none; border-radius:5px; color:var(--chrome-text-dim,#aab2c1); opacity:0; }
    .row:hover .action,.chat-row:hover .action,.row:focus-within .action,.chat-row:focus-within .action { opacity:1; }
    .action:hover { background:rgba(255,255,255,.12); color:inherit; }
    .more { opacity:1; }
    .menu { position:absolute; z-index:30; top:28px; right:4px; min-width:180px; padding:5px; background:var(--chrome-bar,#252b38); border:1px solid var(--chrome-border,#3b4355); border-radius:9px; box-shadow:0 12px 28px #0008; }
    .menu.context { top:20px; right:12px; }
    .menu button { display:flex; align-items:center; gap:9px; width:100%; padding:8px; text-align:left; border-radius:5px; }
    .menu button:hover { background:rgba(255,255,255,.09); }
    .menu .danger { color:#e6a5a5; }
    .chats { margin:0 0 5px; }
    .chat { flex:1; min-width:0; min-height:28px; padding:3px 5px; text-align:left; border-radius:6px; display:flex; align-items:center; gap:7px; }
    .chat[selected] { background:rgba(122,162,247,.16); }
    .status { width:6px; height:6px; border-radius:50%; background:#697386; flex:none; }
    .status.working { background:#7dcba1; }
    .title { font-weight:550; }
    .harness { color:var(--chrome-text-dim,#aab2c1); font-size:10px; flex:none; text-transform:lowercase; }
    .rename-input,.editor input { min-width:0; border:1px solid #60749b; border-radius:5px; padding:6px 7px; background:var(--chrome-bar,#252b38); color:inherit; font:inherit; }
    .rename-input { flex:1; margin:3px 5px; }
    .editor { margin:4px 5px 10px 20px; padding:12px; border:1px solid var(--chrome-border,#3b4355); border-radius:9px; background:var(--chrome-bar,#252b38); display:grid; gap:9px; }
    .editor label { display:grid; gap:4px; color:var(--chrome-text-dim,#aab2c1); font-size:11px; }
    .editor input { width:100%; box-sizing:border-box; color:var(--chrome-text-bright,#d8dce5); }
    .source { display:flex; align-items:center; gap:4px; }
    .source input { flex:1; }
    .editor-actions { display:flex; justify-content:flex-end; gap:6px; }
    .editor-actions button,.add-source { padding:5px 7px; border-radius:5px; }
    .editor-actions button:hover,.add-source:hover { background:rgba(255,255,255,.1); }
    .browser { display:grid; max-height:200px; overflow:auto; border:1px solid var(--chrome-border,#3b4355); border-radius:6px; padding:4px; }
    .browser button { padding:5px 7px; border-radius:4px; text-align:left; }
    .browser button:hover { background:rgba(255,255,255,.1); }
    .browser-head { display:flex; align-items:center; gap:4px; }
    .browser-head span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .error { color:#e6a5a5; padding:5px; }
  `;

  private closeMenu() { this.menuFor = ''; this.contextMenu = false; }
  private showContext(event: MouseEvent, target: string) {
    event.preventDefault();
    this.menuFor = target;
    this.contextMenu = true;
  }
  private startRename(id: string, title: string) {
    this.closeMenu();
    this.renamingId = id;
    this.renameDraft = title;
    void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLInputElement>('.rename-input')?.focus());
  }
  private async saveRename() {
    const id = this.renamingId;
    const title = this.renameDraft.trim();
    if (!id || !title) return;
    try {
      if (id === 'project') await sdkChats.updateProject(this.model.id, { name: title });
      else await sdkChats.rename(id, title);
      this.renamingId = ''; this.error = '';
    } catch (error) { this.error = String(error); }
  }
  private startEdit() {
    const project = this.model.project;
    if (!project) return;
    this.closeMenu();
    this.editName = project.name;
    this.editPath = project.path;
    this.editFolders = [...(project.sourceFolders ?? [])];
    this.newSource = '';
    this.editListing = undefined;
    this.editing = true;
  }
  private async browseFolder(target: 'primary' | 'source', path: string) {
    try { this.editListing = await sdkChats.folders(path); this.browseTarget = target; this.error = ''; }
    catch (error) { this.error = String(error); }
  }
  private selectFolder() {
    if (!this.editListing) return;
    if (this.browseTarget === 'primary') this.editPath = this.editListing.path;
    else this.newSource = this.editListing.path;
    this.editListing = undefined;
  }
  private addSource() {
    const path = this.newSource.trim();
    if (!path) return;
    if (!this.editFolders.includes(path) && path !== this.editPath) this.editFolders = [...this.editFolders, path];
    this.newSource = '';
  }
  private async saveProject() {
    this.addSource();
    try {
      await sdkChats.updateProject(this.model.id, { name:this.editName.trim(), path:this.editPath.trim(), sourceFolders:this.editFolders });
      this.editing = false; this.error = '';
    } catch (error) { this.error = String(error); }
  }
  private async removeProject() {
    this.closeMenu();
    if (!this.model.project || !confirm(`Remove project "${this.model.name}"? Its chats will stay in Ungrouped.`)) return;
    try { await sdkChats.removeProject(this.model.id); } catch (error) { this.error = String(error); }
  }
  private async pinProject() {
    this.closeMenu();
    try { await sdkChats.updateProject(this.model.id, { pinned: !this.model.project?.pinned }); this.error = ''; }
    catch (error) { this.error = String(error); }
  }
  private async pinChat(chat: SDKChat) {
    this.closeMenu();
    try { await sdkChats.setPinned(chat.id, !chat.pinned); this.error = ''; }
    catch (error) { this.error = String(error); }
  }
  private async toggleArchive(chat: SDKChat) {
    this.closeMenu();
    try { await sdkChats.setArchived(chat.id, !chat.archived); this.error = ''; }
    catch (error) { this.error = String(error); }
  }
  private openChat(chat: SDKChat) {
    this.closeMenu();
    this.dispatchEvent(new CustomEvent('chat-open', { detail:{sessionId:chat.id}, bubbles:true, composed:true }));
  }
  private newProjectChat() {
    this.closeMenu();
    this.dispatchEvent(new CustomEvent('chat-new-project', { detail:{projectId:this.model.id}, bubbles:true, composed:true }));
  }
  private projectMenu() {
    const p = this.model.project!;
    return html`<div class="menu ${this.contextMenu ? 'context' : ''}" role="menu">
      <button role="menuitem" @click=${() => this.newProjectChat()}>${icon(Plus,{size:14})} New chat</button>
      <button role="menuitem" @click=${() => this.startEdit()}>${icon(Settings2,{size:14})} Edit project and folders</button>
      <button role="menuitem" @click=${() => this.startRename('project',p.name)}>${icon(Pencil,{size:14})} Rename project</button>
      <button role="menuitem" @click=${() => void this.pinProject()}>${icon(p.pinned ? PinOff : Pin,{size:14})} ${p.pinned ? 'Unpin project' : 'Pin project'}</button>
      <button class="danger" role="menuitem" @click=${() => void this.removeProject()}>${icon(Trash2,{size:14})} Remove project</button>
    </div>`;
  }
  private chatMenu(chat: SDKChat) {
    return html`<div class="menu context" role="menu">
      <button role="menuitem" @click=${() => this.openChat(chat)}>${icon(MessageSquare,{size:14})} Open chat</button>
      <button role="menuitem" @click=${() => void this.pinChat(chat)}>${icon(chat.pinned ? PinOff : Pin,{size:14})} ${chat.pinned ? 'Unpin chat' : 'Pin chat'}</button>
      <button role="menuitem" @click=${() => this.startRename(chat.id, chat.title)}>${icon(Pencil,{size:14})} Rename chat</button>
      <button role="menuitem" @click=${() => void this.toggleArchive(chat)}>${icon(chat.archived ? ArchiveRestore : Archive,{size:14})} ${chat.archived ? 'Restore chat' : 'Archive chat'}</button>
    </div>`;
  }
  override render() {
    const group = this.model;
    return html`
      <div class="row ${group.archived ? 'archived' : ''}" @contextmenu=${(e:MouseEvent) => { if (group.project) this.showContext(e, 'project'); }}>
        ${this.renamingId === 'project' ? html`<input class="rename-input" aria-label="Project name" .value=${this.renameDraft} @input=${(e:Event) => { this.renameDraft = (e.target as HTMLInputElement).value; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter') void this.saveRename(); if (e.key === 'Escape') this.renamingId = ''; }}><button class="action more" aria-label="Save project name" @click=${() => void this.saveRename()}>${icon(Check,{size:14})}</button>` : html`
          <button class="group" title=${group.project?.path || group.name} aria-expanded=${this.open} @click=${() => { this.open = !this.open; this.closeMenu(); }}>
            <span class="folder">${icon(this.open ? FolderOpen : Folder, { size: 16 })}</span>
            <span class="name">${group.name}</span>
          </button>
          ${group.project ? html`
            <button class="action" aria-label=${`${group.project.pinned ? 'Unpin' : 'Pin'} ${group.name}`} title=${group.project.pinned ? 'Unpin project' : 'Pin project'} @click=${() => void this.pinProject()}>${icon(group.project.pinned ? PinOff : Pin,{size:14})}</button>
            <button class="action" aria-label=${`Rename ${group.name}`} title="Rename project" @click=${() => this.startRename('project',group.name)}>${icon(Pencil,{size:14})}</button>
            <button class="action more" aria-label=${`Project options for ${group.name}`} aria-expanded=${this.menuFor === 'project'} @click=${() => { this.menuFor = this.menuFor === 'project' ? '' : 'project'; this.contextMenu = false; }}>${icon(Ellipsis,{size:16})}</button>` : nothing}`}
        ${this.menuFor === 'project' && group.project ? this.projectMenu() : nothing}
      </div>
      ${this.editing && group.project ? html`<div class="editor" aria-label="Edit project">
        <label>Project name<input aria-label="Edit project name" .value=${this.editName} @input=${(e:Event) => { this.editName = (e.target as HTMLInputElement).value; }}></label>
        <label>Primary folder<div class="source"><input aria-label="Primary source folder" .value=${this.editPath} @input=${(e:Event) => { this.editPath = (e.target as HTMLInputElement).value; }}><button aria-label="Browse primary folders" title="Browse folders" @click=${() => void this.browseFolder('primary',this.editPath)}>${icon(Folder,{size:15})}</button></div></label>
        <label>Additional source folders</label>
        ${this.editFolders.map((folder,index) => html`<div class="source"><input aria-label=${`Source folder ${index+1}`} .value=${folder} @input=${(e:Event) => { const next=[...this.editFolders]; next[index]=(e.target as HTMLInputElement).value; this.editFolders=next; }}><button aria-label=${`Remove source folder ${index+1}`} @click=${() => { this.editFolders=this.editFolders.filter((_,i)=>i!==index); }}>${icon(X,{size:14})}</button></div>`)}
        <div class="source"><input aria-label="Add source folder path" placeholder="/absolute/path/to/source" .value=${this.newSource} @input=${(e:Event) => { this.newSource=(e.target as HTMLInputElement).value; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter') this.addSource(); }}><button aria-label="Browse source folders" title="Browse folders" @click=${() => void this.browseFolder('source',this.newSource || this.editPath)}>${icon(Folder,{size:15})}</button><button class="add-source" aria-label="Add source folder" title="Add source folder" @click=${() => this.addSource()}>${icon(FolderPlus,{size:15})}</button></div>
        ${this.editListing ? html`<div class="browser" aria-label="Folder browser"><div class="browser-head"><button aria-label="Parent folder" @click=${() => void this.browseFolder(this.browseTarget,this.editListing!.parent)}>↑</button><span title=${this.editListing.path}>${this.editListing.path}</span><button @click=${() => this.selectFolder()}>Choose</button></div>${this.editListing.folders.map(folder => html`<button @click=${() => void this.browseFolder(this.browseTarget,`${this.editListing!.path.replace(/\/$/,'')}/${folder}`)}>▸ ${folder}</button>`)}</div>` : nothing}
        <div class="editor-actions"><button @click=${() => { this.editing=false; this.error=''; }}>Cancel</button><button @click=${() => void this.saveProject()}>Save project</button></div>
      </div>` : nothing}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${this.open ? html`<div class="chats">${repeat(group.chats, chat => chat.id, chat => html`
        <div class="chat-row" @contextmenu=${(e:MouseEvent) => this.showContext(e,chat.id)}>
          ${this.renamingId === chat.id ? html`<input class="rename-input" aria-label="Chat name" .value=${this.renameDraft} @input=${(e:Event) => { this.renameDraft = (e.target as HTMLInputElement).value; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter') void this.saveRename(); if (e.key === 'Escape') this.renamingId = ''; }}><button class="action more" aria-label="Save chat name" @click=${() => void this.saveRename()}>${icon(Check,{size:14})}</button>` : html`
            <button class="chat" ?selected=${this.selectedSession === chat.id} title=${`${chat.title}\n${chat.projectPath || 'Folder unknown'}`} @click=${() => this.openChat(chat)}>
              <span class="status ${chat.state}" title=${chat.state}></span><span class="title">${chat.title}</span><span class="harness">${chat.harness}</span>
            </button>
            <button class="action" aria-label=${`${chat.pinned ? 'Unpin' : 'Pin'} ${chat.title}`} title=${chat.pinned ? 'Unpin chat' : 'Pin chat'} @click=${() => void this.pinChat(chat)}>${icon(chat.pinned ? PinOff : Pin,{size:14})}</button>
            <button class="action" aria-label=${`${chat.archived ? 'Restore' : 'Archive'} ${chat.title}`} title=${chat.archived ? 'Restore chat' : 'Archive chat'} @click=${() => void this.toggleArchive(chat)}>${icon(chat.archived ? ArchiveRestore : Archive,{size:14})}</button>`}
          ${this.menuFor === chat.id ? this.chatMenu(chat) : nothing}
        </div>`)}
      </div>` : nothing}
    `;
  }
}

@customElement('mux-chat-list')
export class MuxChatList extends LitElement {
  @state() private version = 0;
  @state() private selectedSession = '';
  private unsub?: () => void;
  private readonly onChatOpen = (event: Event) => {
    const id = (event as CustomEvent<{ sessionId: string }>).detail?.sessionId;
    if (id) this.selectedSession = id;
  };
  static styles = css`
    :host { display:block; color:var(--chrome-text-dim,#9299a5); font:12px/1.35 system-ui,sans-serif; }
    .heading { padding:9px 5px 3px; font-size:10px; letter-spacing:.1em; text-transform:uppercase; }
    .pinned { margin-bottom:8px; padding-bottom:7px; border-bottom:1px solid var(--chrome-border,#3b4355); }
    .pin-row { width:100%; display:flex; align-items:center; gap:8px; min-height:29px; padding:4px 5px; border:0; border-radius:6px; background:transparent; color:var(--chrome-text-bright,#d8dce5); text-align:left; font:12px system-ui,sans-serif; cursor:pointer; }
    .pin-row:hover { background:rgba(255,255,255,.07); }
    .pin-row span:not(.pin-icon) { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pin-icon { display:flex; flex:none; color:#aab8d8; }
  `;
  override connectedCallback() {
    super.connectedCallback();
    this.selectedSession = (window as Window & { muxSelectedSDKChat?: string }).muxSelectedSDKChat ?? '';
    this.addEventListener('chat-open', this.onChatOpen);
    this.unsub=sdkChats.subscribe(() => {
      this.selectedSession = (window as Window & { muxSelectedSDKChat?: string }).muxSelectedSDKChat ?? this.selectedSession;
      this.version++;
    });
    void sdkChats.refresh();
  }
  override disconnectedCallback() { this.removeEventListener('chat-open', this.onChatOpen); this.unsub?.(); super.disconnectedCallback(); }
  private locateProject(id: string) {
    this.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace').forEach(row => { if (row.model.id === id) row.reveal(); });
  }
  override render() {
    void this.version;
    const projects = [...sdkChats.projects].sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const chats = [...sdkChats.chats].sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    const active = chats.filter(chat => !chat.archived);
    const groups: ChatGroup[] = projects.map(project => ({ id:project.id, name:project.name, project, chats:active.filter(chat => chat.workspaceId === project.id) }));
    groups.push({ id:'ungrouped', name:'Ungrouped', chats:active.filter(chat => !chat.workspaceId || !projects.some(project => project.id === chat.workspaceId)) });
    groups.push({ id:'archived', name:`Archived (${chats.length-active.length})`, archived:true, chats:chats.filter(chat => chat.archived) });
    const pinned = [
      ...projects.filter(project => project.pinned).map(project => ({ kind:'project' as const, id:project.id, name:project.name })),
      ...active.filter(chat => chat.pinned).map(chat => ({ kind:'chat' as const, id:chat.id, name:chat.title })),
    ];
    return html`
      ${pinned.length ? html`<div class="pinned"><div class="heading">Pinned</div>${pinned.map(item => html`<button class="pin-row" title=${item.name} @click=${() => item.kind === 'project' ? this.locateProject(item.id) : this.dispatchEvent(new CustomEvent('chat-open', { detail:{sessionId:item.id}, bubbles:true, composed:true }))}><span class="pin-icon">${icon(item.kind === 'project' ? Folder : MessageSquare,{size:15})}</span><span>${item.name}</span></button>`)}</div>` : nothing}
      <div class="heading">Chats</div>
      ${repeat(groups, group => group.id, group => html`<mux-chat-workspace .model=${group} .selectedSession=${this.selectedSession}></mux-chat-workspace>`)}
    `;
  }
}
