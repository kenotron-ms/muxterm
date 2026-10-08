import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { Archive, ArchiveRestore, Check, Ellipsis, Folder, FolderOpen, FolderPlus, MessageSquare, Network, Pencil, Pin, PinOff, Plus, Settings2, Trash2, X } from 'lucide';
import { icon } from '../lib/icons.js';
import { laneIcon } from '../lib/lane-icon.js';
import { sdkChats, type FolderListing, type SDKChat, type SDKProject } from '../lib/sdk-chats.js';

interface ChatGroup { id: string; name: string; project?: SDKProject; chats: SDKChat[]; laneIds: Set<string>; archived?: boolean }

// The input is already newest-first. Partitioning keeps that order within
// each section without changing the separate Pinned or Archived sections.
function operatorsFirst(chats: SDKChat[]): SDKChat[] {
  return [...chats.filter(chat => chat.operator), ...chats.filter(chat => !chat.operator)];
}

@customElement('mux-chat-workspace')
export class MuxChatWorkspace extends LitElement {
  @property({ attribute: false }) model!: ChatGroup;
  @property() selectedSession = '';
  @state() private open = true;
  @state() private menuFor = '';
  @state() private contextMenu = false;
  @state() private movingChatId = '';
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
    const path = event.composedPath();
    const menu = this.renderRoot.querySelector('.menu');
    const trigger = this.menuFor === 'project' ? this.renderRoot.querySelector('.row .action.more') : null;
    if (this.menuFor && ![menu, trigger].some(el => el !== null && path.includes(el))) this.closeMenu();
    const browser = this.renderRoot.querySelector('.browser');
    const browseButtons = this.renderRoot.querySelectorAll('[aria-label="Browse primary folders"], [aria-label="Browse source folders"]');
    if (this.editListing && !(browser && path.includes(browser)) && ![...browseButtons].some(el => path.includes(el))) {
      this.editListing = undefined;
    }
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
  override willUpdate(changed: Map<string, unknown>) {
    // Archiving the selected chat updates this group's model. Keep the user's
    // Archived folder expansion choice instead of opening it as a side effect.
    if (!this.model?.archived && (changed.has('selectedSession') || changed.has('model')) && this.model?.chats.some(chat => chat.id === this.selectedSession)) this.open = true;
  }
  override updated(changed: Map<string, unknown>) {
    if ((changed.has('selectedSession') || changed.has('model')) && this.selectedSession) {
      this.renderRoot.querySelector<HTMLElement>('.chat-row[selected]')?.scrollIntoView({ block:'nearest' });
    }
  }
  reveal() { this.open = true; this.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

  static styles = css`
    ${subtleScrollbars}
    :host { display:block; margin:2px 0; font:12px/1.35 system-ui,sans-serif; color:var(--chrome-text-bright,#d8dce5); }
    button { font:inherit; color:inherit; border:0; cursor:pointer; background:transparent; }
    .row,.chat-row { display:flex; align-items:center; min-height:30px; border-radius:6px; position:relative; }
    .row:hover,.chat-row:hover { background:var(--chrome-hover); }
    .group { display:flex; align-items:center; gap:7px; flex:1; min-width:0; padding:5px; text-align:left; }
    .folder { display:inline-flex; align-items:center; justify-content:center; flex:none; line-height:0; }
    .folder { width:17px; color:var(--chrome-text-dim); }
    .name,.title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .name { font-weight:600; }
    .archived .name { color:var(--chrome-text-dim,#aab2c1); }
    .action { display:inline-flex; align-items:center; justify-content:center; width:25px; height:25px; flex:none; border-radius:5px; color:var(--chrome-text-dim,#aab2c1); opacity:0; }
    .row:hover .action,.row:focus-within .action { opacity:1; }
    .chat-row .action { display:none; opacity:1; }
    .chat-row .action.more { display:inline-flex; }
    .chat-row:hover .action,.chat-row:has(.chat:focus-visible) .action { display:inline-flex; }
    .action:hover { background:var(--chrome-hover); color:inherit; }
    .more { opacity:1; }
    .menu { position:absolute; z-index:30; top:28px; right:4px; min-width:180px; max-height:280px; overflow:auto; padding:5px; background:var(--chrome-bar,#252b38); border:1px solid var(--chrome-border,#3b4355); border-radius:9px; box-shadow:0 12px 28px #0008; }
    .menu.context { top:20px; right:12px; }
    .menu button { display:flex; align-items:center; gap:9px; width:100%; padding:8px; text-align:left; border-radius:5px; }
    .menu button:hover { background:var(--chrome-hover); }
    .menu .danger { color:var(--chrome-danger); }
    .chats { margin:0 0 5px; }
    .chat { flex:1; min-width:0; min-height:28px; padding:3px 5px; text-align:left; border-radius:6px; display:flex; align-items:center; gap:7px; }
    .chat-row[selected] { background:color-mix(in srgb, var(--chrome-accent) 18%, var(--chrome-bar)); }
    .status { width:6px; height:6px; border-radius:50%; background:var(--chrome-text-dim); flex:none; }
    .status.working { background:var(--mux-ok); }
    .status.operator { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:0; background:none; color:var(--chrome-accent); }
    .status.operator.working { background:none; color:var(--mux-ok); }
    .status.operator.failed,.status.operator.uncertain { color:var(--chrome-danger); }
    .status.lane { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:0; background:none; color:var(--chrome-text-dim); }
    .status.lane.starting,.status.lane.working { background:none; color:var(--chrome-accent); }
    .status.lane.ready { color:var(--mux-ok,#55b981); }
    .status.lane.failed,.status.lane.uncertain { color:var(--chrome-danger); }
    .title { font-weight:400; }
    .harness { color:var(--chrome-text-dim,#aab2c1); font-size:10px; flex:none; text-transform:lowercase; }
    .chat-row:hover .harness,.chat-row:has(.chat:focus-visible) .harness { display:none; }
    .rename-input,.editor input { min-width:0; border:1px solid var(--chrome-border); border-radius:5px; padding:6px 7px; background:var(--chrome-bar); color:inherit; font:inherit; }
    .rename-input { flex:1; margin:3px 5px; }
    .editor { margin:4px 5px 10px 20px; padding:12px; border:1px solid var(--chrome-border,#3b4355); border-radius:9px; background:var(--chrome-bar,#252b38); display:grid; gap:9px; }
    .editor label { display:grid; gap:4px; color:var(--chrome-text-dim,#aab2c1); font-size:11px; }
    .editor input { width:100%; box-sizing:border-box; color:var(--chrome-text-bright,#d8dce5); }
    .source { display:flex; align-items:center; gap:4px; }
    .source input { flex:1; }
    .editor-actions { display:flex; justify-content:flex-end; gap:6px; }
    .editor-actions button,.add-source { padding:5px 7px; border-radius:5px; }
    .editor-actions button:hover,.add-source:hover { background:var(--chrome-hover); }
    .browser { display:grid; max-height:200px; overflow:auto; border:1px solid var(--chrome-border,#3b4355); border-radius:6px; padding:4px; }
    .browser button { padding:5px 7px; border-radius:4px; text-align:left; }
    .browser button:hover { background:var(--chrome-hover); }
    .browser-head { display:flex; align-items:center; gap:4px; }
    .browser-head span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .error { color:var(--chrome-danger); padding:5px; }
  `;

  private closeMenu() { this.menuFor = ''; this.contextMenu = false; this.movingChatId = ''; }
  private showContext(event: MouseEvent, target: string) {
    event.preventDefault();
    this.menuFor = target;
    this.contextMenu = true;
    this.movingChatId = '';
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
    if (!chat.archived) {
      const linked = sdkChats.chats.some(parent => parent.operator && parent.operatorLanes?.includes(chat.id));
      if (linked && !confirm(`Archive "${chat.title}"? It will stay linked to its operator and remain visible in Operator Status.`)) return;
    }
    try { await sdkChats.setArchived(chat.id, !chat.archived); this.error = ''; }
    catch (error) { this.error = String(error); }
  }
  private async moveChat(chat: SDKChat, projectId: string) {
    this.closeMenu();
    try { await sdkChats.moveChat(chat.id, projectId); this.error = ''; }
    catch (error) { this.error = `Could not move chat: ${String(error)}`; }
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
    if (this.movingChatId === chat.id) return html`<div class="menu context" role="menu" aria-label="Move chat to project">
      <button role="menuitem" @click=${() => { this.movingChatId = ''; }}>← Back</button>
      ${chat.workspaceId ? html`<button role="menuitem" @click=${() => void this.moveChat(chat, '')}>Move to Ungrouped</button>` : nothing}
      ${sdkChats.projects.filter(project => project.id !== chat.workspaceId).map(project => html`<button role="menuitem" @click=${() => void this.moveChat(chat, project.id)}>Move to ${project.name}</button>`)}
    </div>`;
    return html`<div class="menu context" role="menu">
      <button role="menuitem" @click=${() => this.openChat(chat)}>${icon(MessageSquare,{size:14})} Open chat</button>
      <button role="menuitem" @click=${() => void this.pinChat(chat)}>${icon(chat.pinned ? PinOff : Pin,{size:14})} ${chat.pinned ? 'Unpin chat' : 'Pin chat'}</button>
      <button role="menuitem" @click=${() => this.startRename(chat.id, chat.title)}>${icon(Pencil,{size:14})} Rename chat</button>
      <button role="menuitem" @click=${() => { this.movingChatId = chat.id; }}>Move to project…</button>
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
          ${!group.archived ? html`<button class="action" aria-label=${`New chat in ${group.name}`} title=${`New chat in ${group.name}`} @click=${() => this.newProjectChat()}>${icon(Plus,{size:15})}</button>` : nothing}
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
        <div class="chat-row" ?selected=${this.selectedSession === chat.id} @contextmenu=${(e:MouseEvent) => this.showContext(e,chat.id)}>
          ${this.renamingId === chat.id ? html`<input class="rename-input" aria-label="Chat name" .value=${this.renameDraft} @input=${(e:Event) => { this.renameDraft = (e.target as HTMLInputElement).value; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter') void this.saveRename(); if (e.key === 'Escape') this.renamingId = ''; }}><button class="action more" aria-label="Save chat name" @click=${() => void this.saveRename()}>${icon(Check,{size:14})}</button>` : html`
            <button class="chat" title=${`${chat.operator ? 'Operator · ' : group.laneIds.has(chat.id) ? 'Lane · ' : ''}${chat.title}\n${chat.projectPath || 'Folder unknown'}`} @click=${() => this.openChat(chat)}>
              <span class="status ${chat.operator ? 'operator' : group.laneIds.has(chat.id) ? 'lane' : ''} ${chat.state}" title=${chat.operator ? `Operator · ${chat.state}` : group.laneIds.has(chat.id) ? `Lane · ${chat.state}` : chat.state}>${chat.operator ? icon(Network,{size:13}) : group.laneIds.has(chat.id) ? laneIcon(14) : nothing}</span><span class="title">${chat.title}</span><span class="harness">${chat.harness}</span>
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
  @state() private pinError = '';
  @property() selectedSession = '';
  private unsub?: () => void;
  private readonly onChatOpen = (event: Event) => {
    const id = (event as CustomEvent<{ sessionId: string }>).detail?.sessionId;
    if (id) this.selectedSession = id;
  };
  static styles = css`
    ${subtleScrollbars}
    :host { display:block; color:var(--chrome-text-dim,#9299a5); font:12px/1.35 system-ui,sans-serif; }
    .heading { padding:9px 5px 3px; font-size:10px; letter-spacing:.1em; text-transform:uppercase; }
    .pinned { margin-bottom:8px; padding-bottom:7px; border-bottom:1px solid var(--chrome-border,#3b4355); }
    .pin-row { width:100%; display:flex; align-items:center; min-height:29px; padding:2px 3px; border-radius:6px; color:var(--chrome-text-bright,#d8dce5); }
    .pin-row:hover,.pin-row:focus-within { background:var(--chrome-hover); }
    .pin-link { display:flex; align-items:center; gap:8px; min-width:0; flex:1; min-height:25px; border:0; border-radius:4px; padding:2px; background:transparent; color:inherit; text-align:left; font:12px system-ui,sans-serif; cursor:pointer; }
    .pin-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pin-icon { display:flex; flex:none; color:var(--chrome-text-dim); }
    .pin-icon.lane.starting,.pin-icon.lane.working { color:var(--chrome-accent); }
    .pin-icon.lane.ready { color:var(--mux-ok,#55b981); }
    .pin-icon.lane.failed,.pin-icon.lane.uncertain { color:var(--chrome-danger); }
    .pin-unpin { display:grid; place-items:center; flex:none; width:26px; height:26px; border:0; border-radius:5px; padding:4px; background:transparent; color:var(--chrome-text-dim); opacity:0; cursor:pointer; }
    .pin-row:hover .pin-unpin,.pin-row:focus-within .pin-unpin { opacity:1; }
    .pin-unpin:hover { background:color-mix(in srgb,var(--chrome-border) 45%,transparent); color:var(--chrome-text-bright); }
    .pin-link:focus-visible,.pin-unpin:focus-visible { outline:2px solid var(--chrome-accent); outline-offset:1px; }
    .pin-error { margin:3px 5px 8px; color:var(--chrome-danger); }
    @media(hover:none) { .pin-unpin { opacity:1; } }
  `;
  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('chat-open', this.onChatOpen);
    this.unsub=sdkChats.subscribe(() => this.version++);
    void sdkChats.refresh();
  }
  override disconnectedCallback() { this.removeEventListener('chat-open', this.onChatOpen); this.unsub?.(); super.disconnectedCallback(); }
  private locateProject(id: string) {
    this.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace').forEach(row => { if (row.model.id === id) row.reveal(); });
  }
  private async unpin(kind: 'project' | 'chat', id: string, name: string) {
    try {
      if (kind === 'project') await sdkChats.updateProject(id, { pinned:false });
      else await sdkChats.setPinned(id, false);
      this.pinError = '';
    } catch (error) { this.pinError = `Could not unpin ${name}: ${String(error)}`; }
  }
  override render() {
    void this.version;
    const projects = [...sdkChats.projects].sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const chats = [...sdkChats.chats].sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    const active = chats.filter(chat => !chat.archived);
    const laneIds = new Set(chats.filter(chat => chat.operator).flatMap(chat => chat.operatorLanes || []));
    const groups: ChatGroup[] = projects.map(project => ({ id:project.id, name:project.name, project, chats:operatorsFirst(active.filter(chat => chat.workspaceId === project.id)), laneIds }));
    groups.push({ id:'ungrouped', name:'Ungrouped', chats:operatorsFirst(active.filter(chat => !chat.workspaceId || !projects.some(project => project.id === chat.workspaceId))), laneIds });
    groups.push({ id:'archived', name:`Archived (${chats.length-active.length})`, archived:true, chats:chats.filter(chat => chat.archived), laneIds });
    const pinned = [
      ...projects.filter(project => project.pinned).map(project => ({ kind:'project' as const, id:project.id, name:project.name, operator:false, lane:false, state:'' })),
      ...active.filter(chat => chat.pinned).map(chat => ({ kind:'chat' as const, id:chat.id, name:chat.title, operator:!!chat.operator, lane:laneIds.has(chat.id), state:chat.state })),
    ];
    return html`
      ${pinned.length ? html`<div class="pinned"><div class="heading">Pinned</div>${pinned.map(item => html`<div class="pin-row"><button class="pin-link" title=${item.name} @click=${() => item.kind === 'project' ? this.locateProject(item.id) : this.dispatchEvent(new CustomEvent('chat-open', { detail:{sessionId:item.id}, bubbles:true, composed:true }))}><span class="pin-icon ${item.lane && !item.operator ? `lane ${item.state}` : ''}">${item.lane && !item.operator ? laneIcon(15) : icon(item.kind === 'project' ? Folder : item.operator ? Network : MessageSquare,{size:15})}</span><span class="pin-name">${item.name}</span></button><button class="pin-unpin" aria-label=${`Unpin ${item.kind} ${item.name}`} title=${`Unpin ${item.kind}`} @click=${() => void this.unpin(item.kind,item.id,item.name)}>${icon(PinOff,{size:14})}</button></div>`)}</div>` : nothing}
      ${this.pinError ? html`<div class="pin-error" role="alert">${this.pinError}</div>` : nothing}
      <div class="heading">Chats</div>
      ${repeat(groups, group => group.id, group => html`<mux-chat-workspace .model=${group} .selectedSession=${this.selectedSession}></mux-chat-workspace>`)}
    `;
  }
}
