import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { Archive, ArchiveRestore, Check, Ellipsis, Folder, FolderOpen, FolderPlus, MessageSquare, Network, Pencil, Pin, PinOff, Plus, Settings2, Trash2, X } from 'lucide';
import { icon } from '../lib/icons.js';
import { laneIcon } from '../lib/lane-icon.js';
import { sdkChats, sdkHarnessLabel, type FolderListing, type SDKChat, type SDKHarnessName, type SDKProject } from '../lib/sdk-chats.js';
import type { MuxUITextField } from '../ui/text-field.js';
import type { MuxUIDialog } from '../ui/dialog.js';
import type { MuxUIMenu } from '../ui/menu.js';
import '../ui/text-field.js';
import '../ui/button.js';
import '../ui/dialog.js';
import '../ui/feedback.js';
import '../ui/folder-browser.js';
import '../ui/list-row.js';
import '../ui/menu.js';
import codexMark from '../assets/harness/codex.svg?url';
import claudeMark from '../assets/harness/claude.svg?url';
import amplifierMark from '../assets/harness/amplifier.png?url';
import piMark from '../assets/harness/pi.svg?url';
import opencodeMark from '../assets/harness/opencode.svg?url';
import deepseekMark from '../assets/harness/deepseek.svg?url';

const harnessMarks: Record<SDKHarnessName, string> = {
  codex: codexMark, claude: claudeMark, amplifier: amplifierMark,
  pi: piMark, opencode: opencodeMark, deepseek: deepseekMark,
};

function harnessMark(chat: SDKChat, className = 'chat-icon') {
  return html`<span slot="icon" class="${className} harness-mark ${chat.state}" style=${`--harness-mark:url("${harnessMarks[chat.harness]}")`} title=${`${sdkHarnessLabel(chat.harness)} · ${chat.state}`}></span>`;
}

interface ChatGroup { id: string; name: string; project?: SDKProject; chats: SDKChat[]; laneIds: Set<string>; archived?: boolean }
type PendingConfirmation =
  | { kind:'remove-project'; id:string; name:string }
  | { kind:'archive-linked-chat'; id:string; name:string };

// The input is already newest-first. Keep that order within each role while
// leaving Pinned and Archived as separate sections.
function chatsByRole(chats: SDKChat[], laneIds: Set<string>): SDKChat[] {
  return [
    ...chats.filter(chat => chat.operator),
    ...chats.filter(chat => !chat.operator && laneIds.has(chat.id)),
    ...chats.filter(chat => !chat.operator && !laneIds.has(chat.id)),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  @state() private pendingConfirmation?: PendingConfirmation;

  private readonly onOutsidePointer = (event: PointerEvent) => {
    const path = event.composedPath();
    const menu = this.renderRoot.querySelector('mux-ui-menu');
    const trigger = this.menuFor === 'project' ? this.renderRoot.querySelector('.row .action.more') : this.renderRoot.querySelector(`.chat-row .action.more[data-chat-id="${CSS.escape(this.menuFor)}"]`);
    if (this.menuFor && ![menu, trigger].some(el => el !== null && path.includes(el))) this.closeMenu();
    const browser = this.renderRoot.querySelector('mux-ui-folder-browser');
    const browseButtons = this.renderRoot.querySelectorAll('mux-ui-button[accessible-label="Browse primary folders"], mux-ui-button[accessible-label="Browse source folders"]');
    if (this.editListing && !(browser && path.includes(browser)) && ![...browseButtons].some(el => path.includes(el))) {
      this.editListing = undefined;
    }
  };
  private readonly onEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { this.menuFor = ''; this.contextMenu = false; this.renamingId = ''; }
  };
  override connectedCallback() {
    super.connectedCallback();
    if (this.model?.archived || (this.model?.id === 'ungrouped' && !this.model.chats.some(chat => chat.id === this.selectedSession))) this.open = false;
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
    if (!this.model?.archived && changed.has('selectedSession') && this.model?.chats.some(chat => chat.id === this.selectedSession)) this.open = true;
  }
  override updated(changed: Map<string, unknown>) {
    if ((changed.has('selectedSession') || changed.has('model')) && this.selectedSession) {
      this.renderRoot.querySelector<HTMLElement>('.chat-row[selected]')?.scrollIntoView({ block:'nearest' });
    }
    if (changed.has('movingChatId') && this.menuFor) requestAnimationFrame(() => this.renderRoot.querySelector<MuxUIMenu>('mux-ui-menu')?.focusFirst());
  }
  reveal() { this.open = true; this.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

  static styles = css`
    ${subtleScrollbars}
    :host { display:block; margin:0 0 var(--ui-space-5); font:var(--ui-text-sm)/1.35 var(--ui-font-sans); color:var(--ui-text); }
    button { font:inherit; color:inherit; border:0; cursor:pointer; background:transparent; }
    .row,.chat-row { display:flex; align-items:center; min-height:var(--ui-control-md); border-radius:var(--ui-radius-md); position:relative; }
    .row:hover,.chat-row:hover { background:var(--ui-surface-hover); }
    .folder { display:inline-flex; align-items:center; justify-content:center; flex:none; line-height:0; }
    .folder { width:var(--ui-space-6); color:var(--ui-text-muted); }
    .action { flex:none; opacity:0; }
    .row:hover .action,.row:focus-within .action { opacity:1; }
    .chat-row .action { display:none; opacity:1; }
    .chat-row .action.more { display:none; }
    .chat-row:hover .action,.chat-row:has(.chat:focus-within) .action { display:inline-flex; }
    .row:has(mux-ui-menu) .action.more,.chat-row:has(mux-ui-menu) .action.more { display:inline-flex; opacity:1; }
    mux-ui-menu.context { --ui-menu-offset-y:var(--ui-space-7); --ui-menu-offset-x:var(--ui-space-5); }
    .chats { margin:0 0 var(--ui-space-2); padding-left:var(--ui-space-8); }
    .chat-row[selected] { background:var(--ui-nav-selected); }
    .chat-icon { width:var(--ui-space-6); height:var(--ui-space-6); display:inline-flex; align-items:center; justify-content:center; flex:none; color:var(--ui-text-muted); }
    .harness-mark { background:currentColor; -webkit-mask:var(--harness-mark) center/contain no-repeat; mask:var(--harness-mark) center/contain no-repeat; }
    .harness-mark.working { color:var(--ui-success); }
    .harness-mark.blocked,.harness-mark.failed { color:var(--ui-danger); }
    .row:has(.rename-input):focus-within,.chat-row:has(.rename-input):focus-within { outline:none; }
    .status { width:6px; height:6px; border-radius:50%; background:var(--ui-text-muted); flex:none; }
    .status.working { background:var(--ui-success); }
    .status.operator { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:0; background:none; color:var(--ui-accent); }
    .status.operator.working { background:none; color:var(--ui-success); }
    .status.operator.failed,.status.operator.uncertain { color:var(--ui-danger); }
    .status.lane { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:0; background:none; color:var(--ui-text-muted); }
    .status.lane.starting,.status.lane.working { background:none; color:var(--ui-accent); }
    .status.lane.ready { color:var(--ui-success); }
    .status.lane.failed,.status.lane.uncertain { color:var(--ui-danger); }
    .status.chat { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:0; background:none; color:var(--ui-text-muted); }
    .status.chat.working { color:var(--ui-success); }
    .status.chat.failed,.status.chat.uncertain { color:var(--ui-danger); }
    .rename-input { flex:1; min-width:0; margin:var(--ui-space-1) var(--ui-space-2); }
    .rename-save { flex:none; margin-right:var(--ui-space-2); }
    .editor { box-sizing:border-box; width:100%; max-height:calc(80dvh - var(--ui-space-8)); overflow:auto; padding:var(--ui-space-6); display:grid; gap:var(--ui-space-4); background:var(--ui-surface-overlay); }
    .editor-head { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-4); }
    .editor-head h2 { margin:0; font-size:var(--ui-text-xl); line-height:1.25; }
    .editor-intro { margin:0 0 var(--ui-space-2); color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
    .editor mux-ui-text-field { width:100%; }
    .field-label { color:var(--ui-text-muted); font-size:var(--ui-text-md); font-weight:600; }
    .source { display:flex; align-items:center; gap:var(--ui-space-2); }
    .source mux-ui-text-field { flex:1; }
    .editor-actions { display:flex; justify-content:flex-end; gap:var(--ui-space-2); margin-top:var(--ui-space-3); }
    .confirmation { box-sizing:border-box; padding:var(--ui-space-7); background:var(--ui-surface-overlay); color:var(--ui-text); font:var(--ui-text-md)/1.5 var(--ui-font-sans); }
    .confirmation h2 { margin:0; font-size:var(--ui-text-xl); }
    .confirmation p { margin:var(--ui-space-4) 0 var(--ui-space-7); color:var(--ui-text-muted); }
    .confirmation-actions { display:flex; justify-content:flex-end; gap:var(--ui-space-4); }
    @media(max-width:550px) {
      .row .action,.chat-row .action { display:none; opacity:1; }
      .row .action.more,.chat-row .action.more,.row:not(:has(.action.more)) .action.new-chat { display:inline-flex; }
      .chat-row:hover .action:not(.more),.chat-row:has(.chat:focus-within) .action:not(.more) { display:none; }
    }
    @media(max-width:700px) { .editor { max-height:calc(100dvh - env(safe-area-inset-top) - var(--ui-space-8)); padding:var(--ui-space-5) var(--ui-space-5) calc(var(--ui-space-5) + env(safe-area-inset-bottom)); } }
  `;

  private closeMenu() { this.menuFor = ''; this.contextMenu = false; this.movingChatId = ''; }
  private dismissMenu(event: CustomEvent<{restoreFocus:boolean}>) {
    const target = this.menuFor;
    this.closeMenu();
    if (!event.detail.restoreFocus) return;
    void this.updateComplete.then(() => {
      const row = target === 'project' ? this.renderRoot.querySelector('.row') : [...this.renderRoot.querySelectorAll('.chat-row')].find(element => element.querySelector('.action.more')?.getAttribute('data-chat-id') === target);
      (row?.querySelector<HTMLElement>('.action.more') || row?.querySelector<HTMLElement>('.chat'))?.focus();
    });
  }
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
    void this.updateComplete.then(() => this.shadowRoot?.querySelector<MuxUITextField>('.rename-input')?.focus());
  }
  private async saveRename() {
    const id = this.renamingId;
    const title = this.renameDraft.trim();
    if (!id || !title) return;
    try {
      await sdkChats.rename(id, title);
      this.renamingId = ''; this.error = '';
    } catch (error) { this.error = errorMessage(error); }
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
    this.error = '';
    this.editing = true;
    void this.updateComplete.then(async () => {
      await this.renderRoot.querySelector<MuxUIDialog>('mux-ui-dialog')?.updateComplete;
      this.renderRoot.querySelector<MuxUITextField>('.editor mux-ui-text-field')?.focus();
    });
  }
  private async browseFolder(target: 'primary' | 'source', path: string) {
    try { this.editListing = await sdkChats.folders(path); this.browseTarget = target; this.error = ''; }
    catch (error) { this.error = errorMessage(error); }
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
    } catch (error) { this.error = errorMessage(error); }
  }
  private requestRemoveProject() {
    this.closeMenu();
    if (!this.model.project) return;
    this.pendingConfirmation = { kind:'remove-project', id:this.model.id, name:this.model.name };
  }
  private async confirmPendingAction() {
    const pending = this.pendingConfirmation;
    if (!pending) return;
    this.pendingConfirmation = undefined;
    try {
      if (pending.kind === 'remove-project') await sdkChats.removeProject(pending.id);
      else await sdkChats.setArchived(pending.id, true);
      this.error = '';
    } catch (error) { this.error = errorMessage(error); }
  }
  private async pinProject() {
    this.closeMenu();
    try { await sdkChats.updateProject(this.model.id, { pinned: !this.model.project?.pinned }); this.error = ''; }
    catch (error) { this.error = errorMessage(error); }
  }
  private async pinChat(chat: SDKChat) {
    this.closeMenu();
    try { await sdkChats.setPinned(chat.id, !chat.pinned); this.error = ''; }
    catch (error) { this.error = errorMessage(error); }
  }
  private async toggleArchive(chat: SDKChat) {
    this.closeMenu();
    if (!chat.archived) {
      const linked = sdkChats.chats.some(parent => parent.operator && parent.operatorLanes?.includes(chat.id));
      if (linked) {
        this.pendingConfirmation = { kind:'archive-linked-chat', id:chat.id, name:chat.title };
        return;
      }
    }
    try { await sdkChats.setArchived(chat.id, !chat.archived); this.error = ''; }
    catch (error) { this.error = errorMessage(error); }
  }
  private async moveChat(chat: SDKChat, projectId: string) {
    this.closeMenu();
    try { await sdkChats.moveChat(chat.id, projectId); this.error = ''; }
    catch (error) { this.error = `Could not move chat: ${errorMessage(error)}`; }
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
    return html`<mux-ui-menu class=${this.contextMenu ? 'context' : ''} label="Project actions" @menu-dismiss=${this.dismissMenu}>
      <mux-ui-menu-item @click=${() => this.newProjectChat()}>${icon(Plus,{size:14})} New chat</mux-ui-menu-item>
      <mux-ui-menu-item @click=${() => this.startEdit()}>${icon(Settings2,{size:14})} Edit project and folders</mux-ui-menu-item>
      <mux-ui-menu-item @click=${() => this.startEdit()}>${icon(Pencil,{size:14})} Rename project</mux-ui-menu-item>
      <mux-ui-menu-item @click=${() => void this.pinProject()}>${icon(p.pinned ? PinOff : Pin,{size:14})} ${p.pinned ? 'Unpin project' : 'Pin project'}</mux-ui-menu-item>
      <mux-ui-menu-item tone="danger" @click=${() => this.requestRemoveProject()}>${icon(Trash2,{size:14})} Remove project</mux-ui-menu-item>
    </mux-ui-menu>`;
  }
  private chatMenu(chat: SDKChat) {
    if (this.movingChatId === chat.id) return html`<mux-ui-menu class="context" label="Move chat to project" @menu-dismiss=${this.dismissMenu}>
      <mux-ui-menu-item @click=${() => { this.movingChatId = ''; }}>← Back</mux-ui-menu-item>
      ${chat.workspaceId ? html`<mux-ui-menu-item @click=${() => void this.moveChat(chat, '')}>Move to Ungrouped</mux-ui-menu-item>` : nothing}
      ${sdkChats.projects.filter(project => project.id !== chat.workspaceId).map(project => html`<mux-ui-menu-item @click=${() => void this.moveChat(chat, project.id)}>Move to ${project.name}</mux-ui-menu-item>`)}
    </mux-ui-menu>`;
    return html`<mux-ui-menu class="context" label="Chat actions" @menu-dismiss=${this.dismissMenu}>
      <mux-ui-menu-item @click=${() => this.openChat(chat)}>${icon(MessageSquare,{size:14})} Open chat</mux-ui-menu-item>
      <mux-ui-menu-item @click=${() => void this.pinChat(chat)}>${icon(chat.pinned ? PinOff : Pin,{size:14})} ${chat.pinned ? 'Unpin chat' : 'Pin chat'}</mux-ui-menu-item>
      <mux-ui-menu-item @click=${() => this.startRename(chat.id, chat.title)}>${icon(Pencil,{size:14})} Rename chat</mux-ui-menu-item>
      <mux-ui-menu-item @click=${() => { this.movingChatId = chat.id; }}>Move to project…</mux-ui-menu-item>
      <mux-ui-menu-item @click=${() => void this.toggleArchive(chat)}>${icon(chat.archived ? ArchiveRestore : Archive,{size:14})} ${chat.archived ? 'Restore chat' : 'Archive chat'}</mux-ui-menu-item>
    </mux-ui-menu>`;
  }
  override render() {
    const group = this.model;
    return html`
      <div class="row ${group.archived ? 'archived' : ''}" @contextmenu=${(e:MouseEvent) => { if (group.project) this.showContext(e, 'project'); }}>
        <mux-ui-list-row class="group" variant="group" label=${group.name} tooltip=${group.project?.path || group.name} expandable .expanded=${this.open} ?muted=${group.archived} @click=${() => { this.open = !this.open; this.closeMenu(); }}>
          <span slot="icon" class="folder">${icon(this.open ? FolderOpen : Folder, { size: 16 })}</span>
        </mux-ui-list-row>
          ${!group.archived ? html`<mux-ui-button class="action new-chat" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`New chat in ${group.name}`} tooltip=${`New chat in ${group.name}`} @click=${() => this.newProjectChat()}>${icon(Plus,{size:15})}</mux-ui-button>` : nothing}
          ${group.project ? html`
            <mux-ui-button class="action" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`${group.project.pinned ? 'Unpin' : 'Pin'} ${group.name}`} tooltip=${group.project.pinned ? 'Unpin project' : 'Pin project'} @click=${() => void this.pinProject()}>${icon(group.project.pinned ? PinOff : Pin,{size:14})}</mux-ui-button>
            <mux-ui-button class="action" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`Edit ${group.name}`} tooltip="Edit project" @click=${() => this.startEdit()}>${icon(Pencil,{size:14})}</mux-ui-button>
            <mux-ui-button class="action more" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`Project options for ${group.name}`} tooltip="Project options" haspopup="menu" .expanded=${this.menuFor === 'project'} @click=${() => { this.menuFor = this.menuFor === 'project' ? '' : 'project'; this.contextMenu = false; }}>${icon(Ellipsis,{size:16})}</mux-ui-button>` : nothing}
        ${this.menuFor === 'project' && group.project ? this.projectMenu() : nothing}
      </div>
      ${this.editing && group.project ? html`<mux-ui-dialog size="compact" presentation="adaptive" label="Edit project" open @dismiss=${() => { this.editing=false; this.error=''; this.editListing=undefined; }}><div class="editor">
        <div class="editor-head"><h2>Edit project</h2><mux-ui-button variant="quiet" size="small" icon-only accessible-label="Close project editor" @click=${() => { this.editing=false; this.error=''; }}>${icon(X,{size:18})}</mux-ui-button></div>
        <p class="editor-intro">Set the name and folders used by chats in this project.</p>
        <mux-ui-text-field label="Project name" aria-label="Edit project name" .value=${this.editName} @input=${(e:Event) => { this.editName = (e.target as MuxUITextField).value; }}></mux-ui-text-field>
        <span class="field-label">Primary folder</span><div class="source"><mux-ui-text-field aria-label="Primary source folder" .value=${this.editPath} @input=${(e:Event) => { this.editPath = (e.target as MuxUITextField).value; }}></mux-ui-text-field><mux-ui-button variant="quiet" size="small" icon-only accessible-label="Browse primary folders" tooltip="Browse folders" @click=${() => void this.browseFolder('primary',this.editPath)}>${icon(Folder,{size:15})}</mux-ui-button></div>
        <span class="field-label">Additional source folders</span>
        ${this.editFolders.map((folder,index) => html`<div class="source"><mux-ui-text-field aria-label=${`Source folder ${index+1}`} .value=${folder} @input=${(e:Event) => { const next=[...this.editFolders]; next[index]=(e.target as MuxUITextField).value; this.editFolders=next; }}></mux-ui-text-field><mux-ui-button variant="quiet" size="small" icon-only accessible-label=${`Remove source folder ${index+1}`} @click=${() => { this.editFolders=this.editFolders.filter((_,i)=>i!==index); }}>${icon(X,{size:14})}</mux-ui-button></div>`)}
        <div class="source"><mux-ui-text-field aria-label="Add source folder path" placeholder="/absolute/path/to/source" .value=${this.newSource} @input=${(e:Event) => { this.newSource=(e.target as MuxUITextField).value; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter') this.addSource(); }}></mux-ui-text-field><mux-ui-button variant="quiet" size="small" icon-only accessible-label="Browse source folders" tooltip="Browse folders" @click=${() => void this.browseFolder('source',this.newSource || this.editPath)}>${icon(Folder,{size:15})}</mux-ui-button><mux-ui-button variant="quiet" size="small" icon-only accessible-label="Add source folder" tooltip="Add source folder" @click=${() => this.addSource()}>${icon(FolderPlus,{size:15})}</mux-ui-button></div>
        ${this.editListing ? html`<mux-ui-folder-browser aria-label="Folder browser" .listing=${this.editListing} choose-label="Choose" @folder-navigate=${(event:CustomEvent<{path:string}>) => void this.browseFolder(this.browseTarget,event.detail.path)} @folder-choose=${() => this.selectFolder()}></mux-ui-folder-browser>` : nothing}
        ${this.error ? html`<mux-ui-feedback kind="error" appearance="panel" density="compact">${this.error}</mux-ui-feedback>` : nothing}
        <div class="editor-actions"><mux-ui-button size="small" variant="quiet" @click=${() => { this.editing=false; this.error=''; }}>Cancel</mux-ui-button><mux-ui-button size="small" variant="primary" ?disabled=${!this.editName.trim() || !this.editPath.trim()} @click=${() => void this.saveProject()}>Save project</mux-ui-button></div>
      </div></mux-ui-dialog>` : nothing}
      ${this.pendingConfirmation ? html`<mux-ui-dialog size="compact" presentation="adaptive" label=${this.pendingConfirmation.kind === 'remove-project' ? 'Remove project' : 'Archive linked chat'} open @dismiss=${() => { this.pendingConfirmation=undefined; }}><div class="confirmation">
        <h2>${this.pendingConfirmation.kind === 'remove-project' ? 'Remove project?' : 'Archive chat?'}</h2>
        <p>${this.pendingConfirmation.kind === 'remove-project'
          ? `Remove “${this.pendingConfirmation.name}”? Its chats will stay in Ungrouped.`
          : `Archive “${this.pendingConfirmation.name}”? It will be removed from its operator's lanes.`}</p>
        <div class="confirmation-actions"><mux-ui-button variant="secondary" @click=${() => { this.pendingConfirmation=undefined; }}>Cancel</mux-ui-button><mux-ui-button variant="danger" @click=${() => void this.confirmPendingAction()}>${this.pendingConfirmation.kind === 'remove-project' ? 'Remove project' : 'Archive chat'}</mux-ui-button></div>
      </div></mux-ui-dialog>` : nothing}
      ${this.error && !this.editing ? html`<mux-ui-feedback kind="error" appearance="panel" density="compact">${this.error}</mux-ui-feedback>` : nothing}
      ${this.open ? html`<div class="chats">${repeat(group.chats, chat => chat.id, chat => html`
        <div class="chat-row" ?selected=${this.selectedSession === chat.id} @contextmenu=${(e:MouseEvent) => this.showContext(e,chat.id)}>
          ${this.renamingId === chat.id ? html`<mux-ui-text-field class="rename-input" aria-label="Chat name" .value=${this.renameDraft} @input=${(e:Event) => { this.renameDraft = (e.target as MuxUITextField).value; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter') void this.saveRename(); if (e.key === 'Escape') this.renamingId = ''; }}></mux-ui-text-field><mux-ui-button class="rename-save" variant="quiet" size="small" icon-only accessible-label="Save chat name" @click=${() => void this.saveRename()}>${icon(Check,{size:14})}</mux-ui-button>` : html`
            <mux-ui-list-row class="chat" label=${chat.title} tooltip=${`${chat.operator ? 'Operator · ' : group.laneIds.has(chat.id) ? 'Lane · ' : ''}${chat.title}\n${chat.projectPath || 'Folder unknown'}`} ?selected=${this.selectedSession === chat.id} @click=${() => this.openChat(chat)}>
              ${chat.operator || group.laneIds.has(chat.id) ? html`<span slot="icon" class="status ${chat.operator ? 'operator' : 'lane'} ${chat.state}" title=${chat.operator ? `Operator · ${chat.state}` : `Lane · ${chat.state}`}>${chat.operator ? icon(Network,{size:13}) : laneIcon(14)}</span>` : harnessMark(chat)}
            </mux-ui-list-row>
            <mux-ui-button class="action" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`${chat.pinned ? 'Unpin' : 'Pin'} ${chat.title}`} tooltip=${chat.pinned ? 'Unpin chat' : 'Pin chat'} @click=${() => void this.pinChat(chat)}>${icon(chat.pinned ? PinOff : Pin,{size:14})}</mux-ui-button>
            <mux-ui-button class="action" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`${chat.archived ? 'Restore' : 'Archive'} ${chat.title}`} tooltip=${chat.archived ? 'Restore chat' : 'Archive chat'} @click=${() => void this.toggleArchive(chat)}>${icon(chat.archived ? ArchiveRestore : Archive,{size:14})}</mux-ui-button>`}
          ${this.renamingId === chat.id ? nothing : html`<mux-ui-button class="action more" icon-only size="small" variant="quiet" tone="muted" data-chat-id=${chat.id} accessible-label=${`Options for ${chat.title}`} tooltip="Chat options" haspopup="menu" .expanded=${this.menuFor === chat.id} @click=${() => { this.menuFor = this.menuFor === chat.id ? '' : chat.id; this.contextMenu = false; }}>${icon(Ellipsis,{size:16})}</mux-ui-button>`}
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
    :host { display:block; color:var(--ui-text-muted); font:var(--ui-text-sm)/1.35 var(--ui-font-sans); }
    .heading { padding:var(--ui-space-4) var(--ui-space-2) var(--ui-space-1); font-size:inherit; font-weight:600; letter-spacing:0; text-transform:none; }
    .pinned { margin-bottom:var(--ui-space-4); padding-bottom:var(--ui-space-4); border-bottom:1px solid var(--ui-border); }
    .pin-row { box-sizing:border-box; width:100%; display:flex; align-items:center; min-height:var(--ui-control-md); padding:var(--ui-space-1) var(--ui-space-2); border-radius:var(--ui-radius-md); color:var(--ui-text); }
    .pin-row:hover,.pin-row:focus-within { background:var(--ui-surface-hover); }
    .pin-row[selected] { background:var(--ui-nav-selected); }
    .pin-icon { display:flex; flex:none; width:var(--ui-space-6); height:var(--ui-space-6); align-items:center; justify-content:center; color:var(--ui-text-muted); }
    .pin-icon.harness-mark { background:currentColor; -webkit-mask:var(--harness-mark) center/contain no-repeat; mask:var(--harness-mark) center/contain no-repeat; }
    .pin-icon.harness-mark.working { color:var(--ui-success); }
    .pin-icon.harness-mark.blocked,.pin-icon.harness-mark.failed { color:var(--ui-danger); }
    .pin-icon.lane.starting,.pin-icon.lane.working { color:var(--ui-accent); }
    .pin-icon.lane.ready { color:var(--ui-success); }
    .pin-icon.lane.failed,.pin-icon.lane.uncertain { color:var(--ui-danger); }
    .pin-unpin { flex:none; opacity:0; }
    .pin-row:hover .pin-unpin,.pin-row:focus-within .pin-unpin { opacity:1; }
    .pin-feedback { margin:var(--ui-space-1) var(--ui-space-2) var(--ui-space-4); }
    @media(hover:none), (max-width:550px) { .pin-unpin { opacity:1; } }
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
    } catch (error) { this.pinError = `Could not unpin ${name}: ${errorMessage(error)}`; }
  }
  override render() {
    void this.version;
    const projects = [...sdkChats.projects].sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const chats = [...sdkChats.chats].sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    const active = chats.filter(chat => !chat.archived);
    const laneIds = new Set(chats.filter(chat => chat.operator).flatMap(chat => chat.operatorLanes || []));
    const groups: ChatGroup[] = projects.map(project => ({ id:project.id, name:project.name, project, chats:chatsByRole(active.filter(chat => chat.workspaceId === project.id), laneIds), laneIds }));
    const ungrouped = chatsByRole(active.filter(chat => !chat.workspaceId || !projects.some(project => project.id === chat.workspaceId)), laneIds);
    if (ungrouped.length) groups.push({ id:'ungrouped', name:'Ungrouped', chats:ungrouped, laneIds });
    groups.push({ id:'archived', name:'Archived', archived:true, chats:chats.filter(chat => chat.archived), laneIds });
    const pinned = [
      ...projects.filter(project => project.pinned).map(project => ({ kind:'project' as const, id:project.id, name:project.name, operator:false, lane:false, state:'' })),
      ...active.filter(chat => chat.pinned).map(chat => ({ kind:'chat' as const, id:chat.id, name:chat.title, operator:!!chat.operator, lane:laneIds.has(chat.id), state:chat.state, chat })),
    ];
    return html`
      ${pinned.length ? html`<div class="pinned"><div class="heading">Pinned</div>${pinned.map(item => html`<div class="pin-row" ?selected=${item.kind === 'chat' && this.selectedSession === item.id}><mux-ui-list-row class="pin-link" label=${item.name} tooltip=${item.name} ?selected=${item.kind === 'chat' && this.selectedSession === item.id} @click=${() => item.kind === 'project' ? this.locateProject(item.id) : this.dispatchEvent(new CustomEvent('chat-open', { detail:{sessionId:item.id}, bubbles:true, composed:true }))}>${item.kind === 'project' ? html`<span slot="icon" class="pin-icon">${icon(Folder,{size:15})}</span>` : item.operator || item.lane ? html`<span slot="icon" class="pin-icon ${item.lane && !item.operator ? `lane ${item.state}` : ''}">${item.lane && !item.operator ? laneIcon(15) : icon(Network,{size:15})}</span>` : harnessMark(item.chat, 'pin-icon')}</mux-ui-list-row><mux-ui-button class="pin-unpin" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`Unpin ${item.kind} ${item.name}`} tooltip=${`Unpin ${item.kind}`} @click=${() => void this.unpin(item.kind,item.id,item.name)}>${icon(PinOff,{size:14})}</mux-ui-button></div>`)}</div>` : nothing}
      ${this.pinError ? html`<mux-ui-feedback class="pin-feedback" kind="error" appearance="panel" density="compact">${this.pinError}</mux-ui-feedback>` : nothing}
      ${repeat(groups, group => group.id, group => html`<mux-chat-workspace .model=${group} .selectedSession=${this.selectedSession}></mux-chat-workspace>`)}
    `;
  }
}
