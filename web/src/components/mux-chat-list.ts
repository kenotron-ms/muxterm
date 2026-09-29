import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { sdkChats, type SDKChat, type SDKProject } from '../lib/sdk-chats.js';
import { harnessLabel } from '../lib/harness.js';

interface ChatGroup { id: string; name: string; project?: SDKProject; chats: SDKChat[] }

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
    document.addEventListener('pointerdown', this.closeMenuOnOutsidePointer);
    document.addEventListener('keydown', this.closeMenuOnEscape);
  }

  override disconnectedCallback() {
    document.removeEventListener('pointerdown', this.closeMenuOnOutsidePointer);
    document.removeEventListener('keydown', this.closeMenuOnEscape);
    super.disconnectedCallback();
  }

  static styles = css`
    :host { display:block; margin:2px 6px; font:12px/1.35 system-ui,sans-serif; color:var(--chrome-text-bright,#d8dce5); }
    button { font:inherit; color:inherit; border:0; cursor:pointer; background:transparent; }
    .row { display:flex; align-items:center; min-height:36px; border-radius:7px; position:relative; }
    .row:hover,.chat:hover { background:rgba(255,255,255,.07); }
    .group { display:flex; align-items:center; gap:8px; flex:1; min-width:0; padding:6px 8px; text-align:left; }
    .folder { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.7; flex:none; color:#aab8d8; }
    .chevron { width:10px; color:var(--chrome-text-dim,#9299a5); flex:none; }
    .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    .ungrouped { margin-top:12px; padding-top:9px; border-top:1px solid var(--chrome-border,#3b4355); color:var(--chrome-text-dim,#aab2c1); }
    .ungrouped .name { font-size:10px; letter-spacing:.09em; text-transform:uppercase; }
    .more { padding:4px 8px; border-radius:5px; margin-right:3px; font-size:17px; line-height:16px; }
    .more:hover { background:rgba(255,255,255,.1); }
    .menu { position:absolute; z-index:20; top:30px; right:4px; min-width:165px; padding:5px; background:var(--chrome-bar,#252b38); border:1px solid var(--chrome-border,#3b4355); border-radius:8px; box-shadow:0 9px 25px #0008; }
    .menu button { width:100%; padding:8px; text-align:left; border-radius:5px; }
    .menu button:hover { background:rgba(255,255,255,.09); }
    .chats { margin:0 0 6px 24px; }
    .chat-row { display:flex; align-items:center; border-radius:6px; }
    .chat-row:hover { background:rgba(255,255,255,.07); }
    .chat { flex:1; min-width:0; min-height:31px; padding:5px 8px; text-align:left; border-radius:6px; display:flex; align-items:center; gap:6px; }
    .chat[selected] { background:rgba(122,162,247,.16); }
    .title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .harness { color:var(--chrome-text-dim,#9299a5); font-size:10px; }
    .status { width:5px; height:5px; border-radius:50%; background:#697386; flex:none; }
    .status.working { background:#7dcba1; }
    .rename-chat { flex:none; opacity:0; padding:4px 7px; border-radius:5px; }
    .chat-row:hover .rename-chat,.rename-chat:focus-visible { opacity:1; }
    .rename-chat:hover { background:rgba(255,255,255,.1); }
    .rename-input { width:100%; min-width:0; border:1px solid #8aa9eb; border-radius:4px; padding:3px 5px; background:var(--chrome-bar,#252b38); color:inherit; font:inherit; }
    .error { color:#e6a5a5; padding:5px; }
  `;

  private async removeProject() {
    this.menuOpen = false;
    if (!this.model.project) return;
    try { await sdkChats.removeProject(this.model.id); }
    catch (error) { this.error = String(error); }
  }

  private async saveRename() {
    const id = this.renamingId;
    const title = this.renameDraft.trim();
    if (!id || !title) return;
    try { await sdkChats.rename(id, title); this.renamingId = ''; this.error = ''; }
    catch (error) { this.error = String(error); }
  }

  override render() {
    const row = this.model;
    return html`
      <div class="row ${row.project ? '' : 'ungrouped'}">
        <button class="group" title=${row.project?.name || 'Chats without a project'} aria-expanded=${this.open} @click=${() => { this.open = !this.open; this.menuOpen = false; }}>
          ${row.project ? this.open ? html`<svg class="folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 20l3-9h15l-3 9H3Z"/></svg>` : html`<svg class="folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z"/></svg>` : html`<span aria-hidden="true">◌</span>`}
          <span class="name">${row.name}</span><span class="chevron">${this.open ? '⌄' : '›'}</span>
        </button>
        ${row.project ? html`<button class="more" aria-label="${`More options for ${row.name}`}" aria-expanded=${this.menuOpen} @click=${() => { this.menuOpen = !this.menuOpen; }}>⋯</button>` : nothing}
        ${this.menuOpen ? html`<div class="menu" role="menu"><button role="menuitem" @click=${() => void this.removeProject()}>Remove this project</button></div>` : nothing}
      </div>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${this.open ? html`<div class="chats">${repeat(row.chats, chat => chat.id, chat => html`
        <div class="chat-row">
          ${this.renamingId === chat.id ? html`<input class="rename-input" aria-label="Chat name" .value=${this.renameDraft} @input=${(e: Event) => { this.renameDraft = (e.target as HTMLInputElement).value; }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') void this.saveRename(); if (e.key === 'Escape') this.renamingId = ''; }}><button class="rename-chat" style="opacity:1" aria-label="Save chat name" @click=${() => void this.saveRename()}>✓</button>` : html`
            <button class="chat" ?selected=${this.selectedSession === chat.id} title=${chat.title} @click=${() => this.dispatchEvent(new CustomEvent('chat-open', { detail:{sessionId:chat.id}, bubbles:true, composed:true }))}>
              <span class="status ${chat.state}" title=${chat.state}></span><span class="title">${chat.title}</span><span class="harness">${harnessLabel(chat.harness)}</span>
            </button><button class="rename-chat" aria-label=${`Rename ${chat.title}`} title="Rename chat" @click=${() => { this.renamingId = chat.id; this.renameDraft = chat.title; }}>✎</button>`}
        </div>`)}
      </div>` : nothing}
    `;
  }
}

@customElement('mux-chat-list')
export class MuxChatList extends LitElement {
  @state() private version = 0;
  private unsub?: () => void;
  static styles = css`
    :host { display:block; color:var(--chrome-text-dim,#9299a5); font:12px/1.35 system-ui,sans-serif; }
    .heading { padding:9px 12px 3px; font-size:10px; letter-spacing:.1em; text-transform:uppercase; }
  `;
  override connectedCallback() { super.connectedCallback(); this.unsub = sdkChats.subscribe(() => this.version++); void sdkChats.refresh(); }
  override disconnectedCallback() { this.unsub?.(); super.disconnectedCallback(); }
  override render() {
    void this.version;
    const projects = [...sdkChats.projects].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const chats = [...sdkChats.chats].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const projectIds = new Set(projects.map(project => project.id));
    const groups: ChatGroup[] = projects.map(project => ({ id:project.id, name:project.name, project, chats:chats.filter(chat => chat.workspaceId === project.id) }));
    groups.push({ id:'ungrouped', name:'Ungrouped', chats:chats.filter(chat => !chat.workspaceId || !projectIds.has(chat.workspaceId)) });
    return html`<div class="heading">Chats</div>${repeat(groups, group => group.id, group => html`<mux-chat-workspace .model=${group} .selectedSession=${(window as Window & { muxSelectedSDKChat?: string }).muxSelectedSDKChat ?? ''}></mux-chat-workspace>`)}`;
  }
}
