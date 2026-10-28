import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { Archive, ArchiveRestore, Check, Ellipsis, Folder, FolderOpen, FolderPlus, MessageCircle, MessageSquare, Network, Pencil, Pin, PinOff, Plus, Settings2, Trash2, X } from 'lucide';
import { icon } from '../lib/icons.js';
import { laneIcon } from '../lib/lane-icon.js';
import { sdkChats, sdkHarnessLabel, type SDKChat, type SDKHarnessName, type SDKProject } from '../lib/sdk-chats.js';
import { apiPath } from '../lib/base-path.js';
import type { MuxUITextField } from '../ui/text-field.js';
import type { MuxUIDialog } from '../ui/dialog.js';
import type { MuxUIMenu } from '../ui/menu.js';
import '../ui/text-field.js';
import '../ui/button.js';
import '../ui/dialog.js';
import '../ui/feedback.js';
import '../ui/list-row.js';
import '../ui/menu.js';
import './mux-folder-picker.js';
import codexMark from '../assets/harness/codex.svg?url';
import claudeMark from '../assets/harness/claude.svg?url';
import copilotMark from '../assets/harness/copilot.svg?url';
import amplifierMark from '../assets/harness/amplifier.png?url';
import piMark from '../assets/harness/pi.svg?url';
import opencodeMark from '../assets/harness/opencode.svg?url';
import deepseekMark from '../assets/harness/deepseek.svg?url';
import geminiMark from '../assets/harness/gemini.svg?url';

const harnessMarks: Record<SDKHarnessName, string> = {
  codex: codexMark, claude: claudeMark, copilot: copilotMark, amplifier: amplifierMark,
  pi: piMark, opencode: opencodeMark, deepseek: deepseekMark, gemini: geminiMark, antigravity: geminiMark,
};

function harnessMark(chat: SDKChat, className = 'chat-icon') {
  return html`<span slot="icon" class="${className} harness-mark ${chat.state}" style=${`--harness-mark:url("${harnessMarks[chat.harness]}")`} title=${`${sdkHarnessLabel(chat.harness)} · ${chat.state}`}></span>`;
}

const ARCHIVE_PAGE_SIZE = 25;
const ARCHIVE_ROW_HEIGHT = 32;
interface ChatGroup { id: string; name: string; project?: SDKProject; chats: SDKChat[]; laneIds: Set<string>; archived?: boolean; archiveStart?: number; total?: number; loading?: boolean; archiveError?: string }
interface RemoteChatSnapshot { host: string; name?: string; sessions?: SDKChat[]; projects?: SDKProject[]; port?: number; error?: string }
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
  @state() private error = '';
  @state() private renamingId = '';
  @state() private renameDraft = '';
  @state() private pendingConfirmation?: PendingConfirmation;

  private readonly onOutsidePointer = (event: PointerEvent) => {
    const path = event.composedPath();
    const menu = this.renderRoot.querySelector('mux-ui-menu');
    const trigger = this.menuFor === 'project' ? this.renderRoot.querySelector('.row .action.more') : this.renderRoot.querySelector(`.chat-row .action.more[data-chat-id="${CSS.escape(this.menuFor)}"]`);
    if (this.menuFor && ![menu, trigger].some(el => el !== null && path.includes(el))) this.closeMenu();
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
    .archive-list { box-sizing:border-box; max-height:var(--ui-chat-edit-max-height); overflow-y:auto; overscroll-behavior:contain; }
    .archive-list .chat-row { height:var(--ui-space-9); min-height:var(--ui-space-9); }
    .archive-spacer { pointer-events:none; }
    .archive-status { padding:var(--ui-space-3); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .chat-row[selected] { background:var(--ui-nav-selected); }
    .chat-icon { width:var(--ui-space-6); height:var(--ui-space-6); display:inline-flex; align-items:center; justify-content:center; flex:none; color:var(--ui-text-muted); }
    .harness-mark { background:currentColor; -webkit-mask:var(--harness-mark) center/contain no-repeat; mask:var(--harness-mark) center/contain no-repeat; }
    .harness-mark.working { color:var(--ui-success); }
    .harness-mark.blocked,.harness-mark.failed { color:var(--ui-danger); }
    .row:has(.rename-input):focus-within,.chat-row:has(.rename-input):focus-within { outline:none; }
    .status { width:var(--ui-status-dot-size); height:var(--ui-status-dot-size); border-radius:50%; background:var(--ui-text-muted); flex:none; }
    .status.working { background:var(--ui-success); }
    .status.operator { display:inline-flex; align-items:center; justify-content:center; width:var(--ui-icon-xs); height:var(--ui-icon-xs); border-radius:0; background:none; color:var(--ui-accent); }
    .status.operator.working { background:none; color:var(--ui-success); }
    .status.operator.failed,.status.operator.uncertain { color:var(--ui-danger); }
    .status.lane { display:inline-flex; align-items:center; justify-content:center; width:var(--ui-icon-xs); height:var(--ui-icon-xs); border-radius:0; background:none; color:var(--ui-text-muted); }
    .status.lane.starting,.status.lane.working { background:none; color:var(--ui-accent); }
    .status.lane.ready { color:var(--ui-success); }
    .status.lane.failed,.status.lane.uncertain { color:var(--ui-danger); }
    .status.chat { display:inline-flex; align-items:center; justify-content:center; width:var(--ui-icon-xs); height:var(--ui-icon-xs); border-radius:0; background:none; color:var(--ui-text-muted); }
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
    this.error = '';
    this.editing = true;
    void this.updateComplete.then(async () => {
      await this.renderRoot.querySelector<MuxUIDialog>('mux-ui-dialog')?.updateComplete;
      this.renderRoot.querySelector<MuxUITextField>('.editor mux-ui-text-field')?.focus();
    });
  }
  private async saveProject() {
    try {
      await sdkChats.updateProject(this.model.id, { name:this.editName.trim(), ...(this.model.project?.managedFolder ? {} : {path:this.editPath.trim()}) });
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
      <mux-ui-menu-item @click=${() => this.startEdit()}>${icon(Settings2,{size:14})} Edit folder</mux-ui-menu-item>
      <mux-ui-menu-item @click=${() => void this.pinProject()}>${icon(p.pinned ? PinOff : Pin,{size:14})} ${p.pinned ? 'Unpin project' : 'Pin project'}</mux-ui-menu-item>
      <mux-ui-menu-item tone="danger" @click=${() => this.requestRemoveProject()}>${icon(Trash2,{size:14})} Remove from Sessions</mux-ui-menu-item>
    </mux-ui-menu>`;
  }
  private chatMenu(chat: SDKChat) {
    if (this.movingChatId === chat.id) return html`<mux-ui-menu class="context" label="Move chat to project" @menu-dismiss=${this.dismissMenu}>
      <mux-ui-menu-item @click=${() => { this.movingChatId = ''; }}>← Back</mux-ui-menu-item>
      ${chat.workspaceId ? html`<mux-ui-menu-item @click=${() => void this.moveChat(chat, '')}>Move to Chat</mux-ui-menu-item>` : nothing}
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
        <mux-ui-list-row class="group" variant="group" label=${group.name} tooltip=${group.project?.managedFolder ? group.name : group.project?.path || group.name} expandable .expanded=${this.open} ?muted=${group.archived} @click=${() => { this.open = !this.open; this.closeMenu(); if (group.archived) this.dispatchEvent(new CustomEvent(this.open ? 'archive-open' : 'archive-close', { bubbles:true, composed:true })); }}>
          <span slot="icon" class="folder">${icon(group.archived ? Archive : group.id === 'ungrouped' ? MessageCircle : this.open ? FolderOpen : Folder, { size: 16 })}</span>
        </mux-ui-list-row>
          ${!group.archived ? html`<mux-ui-button class="action new-chat" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`New chat in ${group.name}`} tooltip=${`New chat in ${group.name}`} @click=${() => this.newProjectChat()}>${icon(Plus,{size:15})}</mux-ui-button>` : nothing}
          ${group.project ? html`
            <mux-ui-button class="action" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`${group.project.pinned ? 'Unpin' : 'Pin'} ${group.name}`} tooltip=${group.project.pinned ? 'Unpin project' : 'Pin project'} @click=${() => void this.pinProject()}>${icon(group.project.pinned ? PinOff : Pin,{size:14})}</mux-ui-button>
            <mux-ui-button class="action" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`Edit ${group.name}`} tooltip="Edit project" @click=${() => this.startEdit()}>${icon(Pencil,{size:14})}</mux-ui-button>
            <mux-ui-button class="action more" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`Project options for ${group.name}`} tooltip="Project options" haspopup="menu" .expanded=${this.menuFor === 'project'} @click=${() => { this.menuFor = this.menuFor === 'project' ? '' : 'project'; this.contextMenu = false; }}>${icon(Ellipsis,{size:16})}</mux-ui-button>` : nothing}
        ${this.menuFor === 'project' && group.project ? this.projectMenu() : nothing}
      </div>
      ${this.editing && group.project ? html`<mux-ui-dialog size="compact" presentation="adaptive" label="Edit folder" open @dismiss=${() => { this.editing=false; this.error=''; }}><div class="editor">
        <div class="editor-head"><h2>Edit folder</h2><mux-ui-button variant="quiet" size="small" icon-only accessible-label="Close folder editor" @click=${() => { this.editing=false; this.error=''; }}>${icon(X,{size:18})}</mux-ui-button></div>
        <mux-ui-text-field label="Project name" aria-label="Edit project name" .value=${this.editName} @input=${(e:Event) => { this.editName = (e.target as MuxUITextField).value; }}></mux-ui-text-field>
        ${group.project.managedFolder ? html`<p class="editor-intro">This project uses Muxterm’s private storage.</p>` : html`<label class="field-label">Project folder<mux-folder-picker field label="Project folder" .value=${this.editPath} .base=${this.editPath} @folder-selected=${(event:CustomEvent<{path:string}>) => { this.editPath = event.detail.path; }}></mux-folder-picker></label>`}
        ${this.error ? html`<mux-ui-feedback kind="error" appearance="panel" density="compact">${this.error}</mux-ui-feedback>` : nothing}
        <div class="editor-actions"><mux-ui-button size="small" variant="quiet" @click=${() => { this.editing=false; this.error=''; }}>Cancel</mux-ui-button><mux-ui-button size="small" variant="primary" ?disabled=${!this.editName.trim() || (!group.project.managedFolder && !this.editPath.trim())} @click=${() => void this.saveProject()}>Save folder</mux-ui-button></div>
      </div></mux-ui-dialog>` : nothing}
      ${this.pendingConfirmation ? html`<mux-ui-dialog size="compact" presentation="adaptive" label=${this.pendingConfirmation.kind === 'remove-project' ? 'Remove project' : 'Archive linked chat'} open @dismiss=${() => { this.pendingConfirmation=undefined; }}><div class="confirmation">
        <h2>${this.pendingConfirmation.kind === 'remove-project' ? 'Remove project?' : 'Archive chat?'}</h2>
        <p>${this.pendingConfirmation.kind === 'remove-project'
          ? `Remove “${this.pendingConfirmation.name}” from Sessions? Its chats will move to Chat. The folder stays on disk.`
          : `Archive “${this.pendingConfirmation.name}”? It will be removed from its operator's lanes.`}</p>
        <div class="confirmation-actions"><mux-ui-button variant="secondary" @click=${() => { this.pendingConfirmation=undefined; }}>Cancel</mux-ui-button><mux-ui-button variant="danger" @click=${() => void this.confirmPendingAction()}>${this.pendingConfirmation.kind === 'remove-project' ? 'Remove project' : 'Archive chat'}</mux-ui-button></div>
      </div></mux-ui-dialog>` : nothing}
      ${this.error && !this.editing ? html`<mux-ui-feedback kind="error" appearance="panel" density="compact">${this.error}</mux-ui-feedback>` : nothing}
      ${this.open ? html`<div class=${group.archived ? 'chats archive-list' : 'chats'} role=${group.archived ? 'region' : nothing} aria-label=${group.archived ? 'Archived sessions' : nothing} @scroll=${group.archived ? (event:Event) => this.dispatchEvent(new CustomEvent('archive-visible', {detail:{index:Math.floor((event.target as HTMLElement).scrollTop / ARCHIVE_ROW_HEIGHT)},bubbles:true,composed:true})) : nothing}>
        ${group.archived ? html`<div class="archive-spacer" style=${`height:${(group.archiveStart || 0) * ARCHIVE_ROW_HEIGHT}px`}></div>` : nothing}
        ${repeat(group.chats, chat => chat.id, chat => html`
        <div class="chat-row" ?selected=${this.selectedSession === chat.id} @contextmenu=${(e:MouseEvent) => this.showContext(e,chat.id)}>
          ${this.renamingId === chat.id ? html`<mux-ui-text-field class="rename-input" aria-label="Chat name" .value=${this.renameDraft} @input=${(e:Event) => { this.renameDraft = (e.target as MuxUITextField).value; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter') void this.saveRename(); if (e.key === 'Escape') this.renamingId = ''; }}></mux-ui-text-field><mux-ui-button class="rename-save" variant="quiet" size="small" icon-only accessible-label="Save chat name" @click=${() => void this.saveRename()}>${icon(Check,{size:14})}</mux-ui-button>` : html`
            <mux-ui-list-row class="chat" label=${chat.title} tooltip=${`${chat.operator ? 'Operator · ' : group.laneIds.has(chat.id) ? 'Lane · ' : ''}${chat.title}\n${group.project?.managedFolder ? 'No folder' : chat.projectPath || 'Folder unknown'}`} ?selected=${this.selectedSession === chat.id} @click=${() => this.openChat(chat)}>
              ${chat.operator || group.laneIds.has(chat.id) ? html`<span slot="icon" class="status ${chat.operator ? 'operator' : 'lane'} ${chat.state}" title=${chat.operator ? `Operator · ${chat.state}` : `Lane · ${chat.state}`}>${chat.operator ? icon(Network,{size:13}) : laneIcon(14)}</span>` : harnessMark(chat)}
            </mux-ui-list-row>
            <mux-ui-button class="action" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`${chat.pinned ? 'Unpin' : 'Pin'} ${chat.title}`} tooltip=${chat.pinned ? 'Unpin chat' : 'Pin chat'} @click=${() => void this.pinChat(chat)}>${icon(chat.pinned ? PinOff : Pin,{size:14})}</mux-ui-button>
            <mux-ui-button class="action" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`${chat.archived ? 'Restore' : 'Archive'} ${chat.title}`} tooltip=${chat.archived ? 'Restore chat' : 'Archive chat'} @click=${() => void this.toggleArchive(chat)}>${icon(chat.archived ? ArchiveRestore : Archive,{size:14})}</mux-ui-button>`}
          ${this.renamingId === chat.id ? nothing : html`<mux-ui-button class="action more" icon-only size="small" variant="quiet" tone="muted" data-chat-id=${chat.id} accessible-label=${`Options for ${chat.title}`} tooltip="Chat options" haspopup="menu" .expanded=${this.menuFor === chat.id} @click=${() => { this.menuFor = this.menuFor === chat.id ? '' : chat.id; this.contextMenu = false; }}>${icon(Ellipsis,{size:16})}</mux-ui-button>`}
          ${this.menuFor === chat.id ? this.chatMenu(chat) : nothing}
        </div>`)}
        ${group.archived ? html`<div class="archive-spacer" style=${`height:${Math.max(0,(group.total || 0) - (group.archiveStart || 0) - group.chats.length) * ARCHIVE_ROW_HEIGHT}px`}></div>${group.loading ? html`<div class="archive-status" role="status">Loading archived sessions…</div>` : group.archiveError ? html`<div class="archive-status" role="alert">${group.archiveError}</div>` : !group.total ? html`<div class="archive-status">No archived sessions</div>` : nothing}` : nothing}
      </div>` : nothing}
    `;
  }
}

@customElement('mux-chat-list')
export class MuxChatList extends LitElement {
  @state() private version = 0;
  @state() private pinError = '';
  @state() private archiveRows: SDKChat[] = [];
  @state() private archiveStart = 0;
  @state() private archiveTotal = 0;
  @state() private archiveLoading = false;
  @state() private archiveError = '';
  private archiveGeneration = 0;
  private archiveExpanded = false;
  private archiveAnchorPage = 0;
  private archivePages = new Map<number, SDKChat[]>();
  private archivePending = new Set<number>();
  private lastArchivedCount = 0;
  @state() private projectDialogOpen = false;
  @state() private projectName = '';
  @state() private projectFolderName = '';
  @state() private projectParent = '';
  @state() private projectError = '';
  @state() private projectCreating = false;
  @property() selectedSession = '';
  private unsub?: () => void;
  @state() private remoteSnapshots = new Map<string, RemoteChatSnapshot>();
  private remoteTimer?: number;
  private remoteOpen = new Set<string>();
  private remoteProjectOpen = new Set<string>();
  private readonly receiveRemoteChats = (event: Event) => {
    const snapshot = (event as CustomEvent<RemoteChatSnapshot>).detail;
    if (!snapshot || !this.remoteSnapshots.has(snapshot.host)) return;
    const previous = this.remoteSnapshots.get(snapshot.host);
    this.remoteSnapshots = new Map(this.remoteSnapshots).set(snapshot.host, {...snapshot, name:previous?.name});
  };
  private readonly receiveRemoteError = (event: Event) => {
    const {host,error} = (event as CustomEvent<{host:string;error:string}>).detail;
    const previous = this.remoteSnapshots.get(host);
    if (previous) this.remoteSnapshots = new Map(this.remoteSnapshots).set(host, {...previous,error});
  };
  private readonly browserReady = () => { void this.refreshRemoteChats(); };
  private async refreshRemoteChats() {
    const bridge = window.__muxtermDesktopBrowser;
    if (!bridge) return;
    try {
      const response = await fetch(apiPath('/api/remotes'));
      if (!response.ok) return;
      const rows = (await response.json() as {connected?: {id:string;name:string}[]}).connected || [];
      const next = new Map<string,RemoteChatSnapshot>();
      for (const row of rows) {
        if (!row.id.startsWith('ssh:')) continue;
        next.set(row.id, {...this.remoteSnapshots.get(row.id), host:row.id, name:row.name});
        if (!this.remoteSnapshots.has(row.id)) this.remoteOpen.add(row.id);
        bridge.send({type:'remote-chats',host:row.id});
      }
      this.remoteSnapshots = next;
    } catch { /* Remotes settings shows server errors. */ }
  }
  private readonly onChatOpen = (event: Event) => {
    const id = (event as CustomEvent<{ sessionId: string }>).detail?.sessionId;
    if (id) this.selectedSession = id;
  };
  static styles = css`
    ${subtleScrollbars}
    :host { display:block; color:var(--ui-text-muted); font:var(--ui-text-sm)/1.35 var(--ui-font-sans); }
    .heading { padding:var(--ui-space-4) var(--ui-space-2) var(--ui-space-1); font-size:inherit; font-weight:600; letter-spacing:0; text-transform:none; }
    .heading-row { display:flex; align-items:center; justify-content:space-between; }
    .heading-actions { display:flex; align-items:center; }
    .pinned { margin-bottom:var(--ui-space-4); }
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
    .project-form { display:grid; gap:var(--ui-space-5); padding:var(--ui-space-6); color:var(--ui-text); }
    .project-form h2 { margin:0; font-size:var(--ui-text-xl); }
    .project-form .field-label { display:grid; gap:var(--ui-space-2); color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
    .project-form mux-folder-picker { --folder-list-height:var(--ui-picker-trigger-compact-width); }
    .project-preview { overflow-wrap:anywhere; color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
    .project-actions { display:flex; justify-content:flex-end; gap:var(--ui-space-3); }
    .remote-heading { margin-top:var(--ui-space-4); }
    .remote-group { margin:0 0 var(--ui-space-3); }
    .remote-folder { display:flex; width:100%; }
    .remote-children { margin-left:var(--ui-space-6); }
    .remote-project { margin-left:var(--ui-space-5); }
    .remote-note { padding:var(--ui-space-1) var(--ui-space-2); font-size:var(--ui-text-xs); overflow-wrap:anywhere; }
    @media(hover:none), (max-width:550px) { .pin-unpin { opacity:1; } }
  `;
  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('chat-open', this.onChatOpen);
    this.lastArchivedCount = sdkChats.archivedCount;
    this.unsub=sdkChats.subscribe(() => {
      this.version++;
      if (this.archiveExpanded && sdkChats.archivedCount !== this.lastArchivedCount) this.refreshArchive();
      this.lastArchivedCount = sdkChats.archivedCount;
    });
    void sdkChats.refresh();
    window.addEventListener('muxterm-remote-chats', this.receiveRemoteChats);
    window.addEventListener('muxterm-remote-chat-error', this.receiveRemoteError);
    window.addEventListener('muxterm-browser-ready', this.browserReady);
    void this.refreshRemoteChats();
    this.remoteTimer = window.setInterval(() => void this.refreshRemoteChats(), 30000);
  }
  override disconnectedCallback() {
    this.removeEventListener('chat-open', this.onChatOpen);
    window.removeEventListener('muxterm-remote-chats', this.receiveRemoteChats);
    window.removeEventListener('muxterm-remote-chat-error', this.receiveRemoteError);
    window.removeEventListener('muxterm-browser-ready', this.browserReady);
    window.clearInterval(this.remoteTimer);
    this.unsub?.();
    super.disconnectedCallback();
  }

  private renderRemoteChat(snapshot: RemoteChatSnapshot, chat: SDKChat) {
    return html`<mux-ui-list-row class="remote-chat" label=${chat.title || 'Untitled chat'} tooltip=${`${chat.harness} · ${chat.state} · ${snapshot.name || snapshot.host}`}
      @click=${() => window.__muxtermDesktopBrowser?.send({type:'open-remote-chat',host:snapshot.host,chatId:chat.id})}>
      <span slot="icon" class="pin-icon">${icon(MessageSquare,{size:15})}</span>
    </mux-ui-list-row>`;
  }

  private renderRemoteSessions() {
    if (!this.remoteSnapshots.size) return nothing;
    return html`<div class="heading remote-heading">Remote sessions</div>${[...this.remoteSnapshots.values()].map(snapshot => {
      const open = this.remoteOpen.has(snapshot.host);
      const sessions = snapshot.sessions || [];
      const projects = snapshot.projects || [];
      return html`<div class="remote-group"><mux-ui-list-row class="remote-folder" variant="group" expandable .expanded=${open} label=${snapshot.name || snapshot.host}
        @click=${() => { if (open) this.remoteOpen.delete(snapshot.host); else this.remoteOpen.add(snapshot.host); this.requestUpdate(); }}>
        <span slot="icon">${icon(open ? FolderOpen : Folder,{size:16})}</span>
      </mux-ui-list-row>${open ? html`<div class="remote-children">
        ${snapshot.error ? html`<div class="remote-note" role="alert">${snapshot.error}</div>` : nothing}
        ${projects.map(project => {
          const key = `${snapshot.host}/${project.id}`;
          const projectOpen = !this.remoteProjectOpen.has(key);
          const chats = sessions.filter(chat => chat.workspaceId === project.id);
          return html`<mux-ui-list-row class="remote-folder" variant="group" expandable .expanded=${projectOpen} label=${project.name}
            @click=${() => { if (projectOpen) this.remoteProjectOpen.add(key); else this.remoteProjectOpen.delete(key); this.requestUpdate(); }}>
            <span slot="icon">${icon(projectOpen ? FolderOpen : Folder,{size:15})}</span>
          </mux-ui-list-row>${projectOpen ? html`<div class="remote-project">${chats.map(chat => this.renderRemoteChat(snapshot,chat))}</div>` : nothing}`;
        })}
        ${sessions.filter(chat => !chat.workspaceId || !projects.some(project => project.id === chat.workspaceId)).map(chat => this.renderRemoteChat(snapshot,chat))}
        ${!snapshot.error && !sessions.length ? html`<div class="remote-note">No remote chats</div>` : nothing}
      </div>` : nothing}</div>`;
    })}`;
  }
  private openArchive() {
    this.archiveExpanded = true;
    this.archiveAnchorPage = 0;
    this.refreshArchive();
  }
  private refreshArchive() {
    this.archiveGeneration++;
    this.archivePages.clear();
    this.archivePending.clear();
    this.archiveRows = [];
    this.archiveStart = this.archiveAnchorPage * ARCHIVE_PAGE_SIZE;
    this.archiveError = '';
    void this.ensureArchivePage(this.archiveAnchorPage);
  }
  private showArchiveWindow() {
    for (const page of this.archivePages.keys()) if (Math.abs(page - this.archiveAnchorPage) > 1) this.archivePages.delete(page);
    const page = this.archivePages.has(this.archiveAnchorPage) ? this.archiveAnchorPage
      : this.archivePages.has(this.archiveAnchorPage - 1) ? this.archiveAnchorPage - 1
      : this.archivePages.has(this.archiveAnchorPage + 1) ? this.archiveAnchorPage + 1 : -1;
    if (page < 0) { this.archiveRows = []; this.archiveStart = this.archiveAnchorPage * ARCHIVE_PAGE_SIZE; }
    else {
      let first = page, last = page;
      while (this.archivePages.has(first - 1) && first > this.archiveAnchorPage - 1) first--;
      while (this.archivePages.has(last + 1) && last < this.archiveAnchorPage + 1) last++;
      this.archiveStart = first * ARCHIVE_PAGE_SIZE;
      this.archiveRows = Array.from({length:last-first+1}, (_,i) => this.archivePages.get(first+i) || []).flat();
    }
    this.archiveLoading = !this.archivePages.has(this.archiveAnchorPage) && this.archivePending.has(this.archiveAnchorPage);
  }
  private async ensureArchivePage(page:number) {
    if (!this.archiveExpanded || page < 0 || (this.archiveTotal > 0 && page * ARCHIVE_PAGE_SIZE >= this.archiveTotal) || this.archivePages.has(page) || this.archivePending.has(page)) return;
    const generation = this.archiveGeneration;
    this.archivePending.add(page);
    this.showArchiveWindow();
    try {
      const result = await sdkChats.archived(page);
      if (generation !== this.archiveGeneration || !this.archiveExpanded) return;
      this.archiveTotal = result.total;
      this.archivePages.set(page, result.chats);
      this.archiveError = '';
    } catch (error) { if (generation === this.archiveGeneration) this.archiveError = error instanceof Error ? error.message : String(error); }
    finally { if (generation === this.archiveGeneration) { this.archivePending.delete(page); this.showArchiveWindow(); } }
  }
  private onArchiveVisible(index:number) {
    const page = Math.floor(index / ARCHIVE_PAGE_SIZE);
    if (page !== this.archiveAnchorPage) { this.archiveAnchorPage = page; this.showArchiveWindow(); }
    void this.ensureArchivePage(page);
    if (index % ARCHIVE_PAGE_SIZE >= 8) void this.ensureArchivePage(page + 1);
    if (index % ARCHIVE_PAGE_SIZE <= 5) void this.ensureArchivePage(page - 1);
  }
  private closeArchive() {
    this.archiveExpanded = false; this.archiveGeneration++;
    this.archivePages.clear(); this.archivePending.clear();
    this.archiveRows = []; this.archiveStart = 0; this.archiveTotal = 0; this.archiveAnchorPage = 0; this.archiveLoading = false; this.archiveError = '';
  }
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
  private async openProjectDialog() {
    this.projectName = '';
    this.projectFolderName = '';
    this.projectError = '';
    this.projectDialogOpen = true;
    try { this.projectParent = (await sdkChats.folders()).base; }
    catch (error) { this.projectError = errorMessage(error); }
    void this.updateComplete.then(() => this.shadowRoot?.querySelector<MuxUITextField>('.project-form mux-ui-text-field')?.focus());
  }
  private closeProjectDialog() {
    if (!this.projectCreating) this.projectDialogOpen = false;
  }
  private async createProject() {
    if (this.projectCreating) return;
    const name = this.projectFolderName.trim();
    const parent = this.projectParent.trim().replace(/\/+$/, '') || '/';
    if (!name || name.length > 80 || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      this.projectError = 'Choose a folder name without slashes.';
      return;
    }
    if (!parent.startsWith('/')) {
      this.projectError = 'Enter an absolute parent folder path.';
      return;
    }
    this.projectCreating = true;
    this.projectError = '';
    try {
      const path = `${parent === '/' ? '' : parent}/${name}`;
      const project = await sdkChats.createProject(path, this.projectName.trim() || name, [], true);
      this.projectDialogOpen = false;
      this.dispatchEvent(new CustomEvent('chat-new-project', { detail:{projectId:project.id}, bubbles:true, composed:true }));
    } catch (error) { this.projectError = errorMessage(error); }
    finally { this.projectCreating = false; }
  }
  override render() {
    void this.version;
    const projects = [...sdkChats.projects].sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const chats = [...sdkChats.chats].sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    const active = chats.filter(chat => !chat.archived);
    const laneIds = new Set(chats.filter(chat => chat.operator).flatMap(chat => chat.operatorLanes || []));
    const groups: ChatGroup[] = projects.map(project => ({ id:project.id, name:project.name, project, chats:chatsByRole(active.filter(chat => chat.workspaceId === project.id), laneIds), laneIds }));
    const ungrouped = chatsByRole(active.filter(chat => !chat.workspaceId || !projects.some(project => project.id === chat.workspaceId)), laneIds);
    groups.unshift({ id:'ungrouped', name:'Chat', chats:ungrouped, laneIds });
    groups.push({ id:'archived', name:'Archived', archived:true, chats:this.archiveRows, laneIds, archiveStart:this.archiveStart, total:this.archiveTotal, loading:this.archiveLoading, archiveError:this.archiveError });
    const pinned = [
      ...projects.filter(project => project.pinned).map(project => ({ kind:'project' as const, id:project.id, name:project.name, operator:false, lane:false, state:'' })),
      ...active.filter(chat => chat.pinned).map(chat => ({ kind:'chat' as const, id:chat.id, name:chat.title, operator:!!chat.operator, lane:laneIds.has(chat.id), state:chat.state, chat })),
    ];
    return html`
      ${pinned.length ? html`<div class="pinned"><div class="heading">Pinned</div>${pinned.map(item => html`<div class="pin-row" ?selected=${item.kind === 'chat' && this.selectedSession === item.id}><mux-ui-list-row class="pin-link" label=${item.name} tooltip=${item.name} ?selected=${item.kind === 'chat' && this.selectedSession === item.id} @click=${() => item.kind === 'project' ? this.locateProject(item.id) : this.dispatchEvent(new CustomEvent('chat-open', { detail:{sessionId:item.id}, bubbles:true, composed:true }))}>${item.kind === 'project' ? html`<span slot="icon" class="pin-icon">${icon(Folder,{size:15})}</span>` : item.operator || item.lane ? html`<span slot="icon" class="pin-icon ${item.lane && !item.operator ? `lane ${item.state}` : ''}">${item.lane && !item.operator ? laneIcon(15) : icon(Network,{size:15})}</span>` : harnessMark(item.chat, 'pin-icon')}</mux-ui-list-row><mux-ui-button class="pin-unpin" icon-only size="small" variant="quiet" tone="muted" accessible-label=${`Unpin ${item.kind} ${item.name}`} tooltip=${`Unpin ${item.kind}`} @click=${() => void this.unpin(item.kind,item.id,item.name)}>${icon(PinOff,{size:14})}</mux-ui-button></div>`)}</div>` : nothing}
      <div class="heading-row"><div class="heading">Sessions</div><div class="heading-actions"><mux-ui-button icon-only size="small" variant="quiet" tone="muted" accessible-label="New folder" tooltip="New folder" @click=${() => void this.openProjectDialog()}>${icon(FolderPlus,{size:16})}</mux-ui-button></div></div>
      ${this.pinError ? html`<mux-ui-feedback class="pin-feedback" kind="error" appearance="panel" density="compact">${this.pinError}</mux-ui-feedback>` : nothing}
      ${repeat(groups, group => group.id, group => html`<mux-chat-workspace .model=${group} .selectedSession=${this.selectedSession} @archive-open=${() => this.openArchive()} @archive-visible=${(event:CustomEvent<{index:number}>) => this.onArchiveVisible(event.detail.index)} @archive-close=${() => this.closeArchive()}></mux-chat-workspace>`)}
      ${this.renderRemoteSessions()}
      ${this.projectDialogOpen ? html`<mux-ui-dialog open size="compact" presentation="adaptive" label="New folder" .dismissable=${!this.projectCreating} @dismiss=${() => this.closeProjectDialog()}><div class="project-form">
        <h2>New folder</h2>
        <label class="field-label">Parent folder<mux-folder-picker inline label="Parent folder" .value=${this.projectParent} .base=${this.projectParent} @folder-selected=${(event:CustomEvent<{path:string}>) => { this.projectParent=event.detail.path; }}></mux-folder-picker></label>
        <mux-ui-text-field label="New folder name" aria-label="New folder name" autocomplete="off" placeholder="Folder name" .value=${this.projectFolderName} @input=${(event:Event) => { this.projectFolderName=(event.target as MuxUITextField).value; }} @keydown=${(event:KeyboardEvent) => { if (event.key === 'Enter') void this.createProject(); }}></mux-ui-text-field>
        <mux-ui-text-field label="Project name (optional)" aria-label="Project name" placeholder="Use folder name" .value=${this.projectName} @input=${(event:Event) => { this.projectName=(event.target as MuxUITextField).value; }}></mux-ui-text-field>
        ${this.projectError ? html`<mux-ui-feedback kind="error" appearance="panel" density="compact">${this.projectError}</mux-ui-feedback>` : nothing}
        <div class="project-actions"><mux-ui-button variant="quiet" ?disabled=${this.projectCreating} @click=${() => this.closeProjectDialog()}>Cancel</mux-ui-button><mux-ui-button variant="primary" ?disabled=${this.projectCreating || !this.projectFolderName.trim() || !this.projectParent.trim()} @click=${() => void this.createProject()}>${this.projectCreating ? 'Creating…' : 'Create folder'}</mux-ui-button></div>
      </div></mux-ui-dialog>` : nothing}
    `;
  }
}
