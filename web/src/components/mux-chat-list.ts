import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { sdkChats, type SDKChat, type SDKProject } from '../lib/sdk-chats.js';
import { homeSessions } from '../lib/home-sessions.js';
import { store } from '../state.js';
import { isRemoteId } from '../lib/host-ref.js';
import { harnessLabel } from '../lib/harness.js';

interface LaneRow { kind: 'lane'; id: string; title: string; path: string; harness: string; state: string; origin: string; workspaceId: string; paneId: number; terminal: boolean; updatedAt: number }
interface ChatRow { kind: 'chat'; id: string; chat: SDKChat; path: string; title: string; harness: string; state: string; updatedAt: number }
type SessionRow = ChatRow | LaneRow;
interface ChatGroup { id: string; name: string; project?: SDKProject; rows: SessionRow[] }

function projectFor(path: string, projects: SDKProject[]): SDKProject | undefined {
  return projects.filter(project => path === project.path || path.startsWith(project.path.replace(/\/$/, '') + '/'))
    .sort((a, b) => b.path.length - a.path.length || a.id.localeCompare(b.id))[0];
}

function laneOrigin(origin: string): string {
  if (origin.startsWith('trigger:')) return `Automation · ${origin.slice(8)}`;
  if (origin === 'trigger') return 'Automation';
  if (origin === 'cli') return 'Started from CLI';
  if (origin === 'agent') return 'Started by agent';
  if (origin === 'browser') return 'Started in browser';
  return origin || 'Origin unknown';
}

function folderLabel(path: string): string {
  return path.replace(/\/$/, '').split('/').pop() || path || 'Unknown';
}

function displayHarness(harness: string): string {
  return harness === 'codex' || harness === 'claude' || harness === 'amplifier' ? harnessLabel(harness) : harness || 'Harness unknown';
}

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
    .chat-row { display:flex; align-items:flex-start; border-radius:6px; }
    .chat-row:hover { background:rgba(255,255,255,.07); }
    .chat { flex:1; min-width:0; min-height:55px; padding:5px 8px; text-align:left; border-radius:6px; display:flex; align-items:flex-start; gap:6px; }
    .chat.lane { border-left:2px solid #7dcba1; }
    .chat[selected] { background:rgba(122,162,247,.16); }
    .body { flex:1; min-width:0; }
    .title { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    .details { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--chrome-text-dim,#aab2c1); font-size:10px; }
    .location { color:var(--chrome-text-bright,#d8dce5); }
    .origin { color:#a8d9bd; }
    .kind { color:#a8d9bd; font-size:10px; flex:none; }
    .status { width:5px; height:5px; margin-top:6px; border-radius:50%; background:#697386; flex:none; }
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

  private openRow(row: SessionRow) {
    if (row.kind === 'chat') {
      this.dispatchEvent(new CustomEvent('chat-open', { detail:{sessionId:row.id}, bubbles:true, composed:true }));
    } else if (row.terminal) {
      this.dispatchEvent(new CustomEvent('home-open', { detail:{workspaceId:row.workspaceId, paneId:row.paneId}, bubbles:true, composed:true }));
    }
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
        <button class="group" title=${row.project?.path || 'Sessions outside known projects'} aria-expanded=${this.open} @click=${() => { this.open = !this.open; this.menuOpen = false; }}>
          ${row.project ? this.open ? html`<svg class="folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 20l3-9h15l-3 9H3Z"/></svg>` : html`<svg class="folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z"/></svg>` : html`<span aria-hidden="true">◌</span>`}
          <span class="name">${row.name}</span><span class="chevron">${this.open ? '⌄' : '›'}</span>
        </button>
        ${row.project ? html`<button class="more" aria-label="${`More options for ${row.name}`}" aria-expanded=${this.menuOpen} @click=${() => { this.menuOpen = !this.menuOpen; }}>⋯</button>` : nothing}
        ${this.menuOpen ? html`<div class="menu" role="menu"><button role="menuitem" @click=${() => void this.removeProject()}>Remove this project</button></div>` : nothing}
      </div>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${this.open ? html`<div class="chats">${repeat(row.rows, item => `${item.kind}:${item.id}`, item => html`
        <div class="chat-row">
        ${item.kind === 'chat' && this.renamingId === item.id ? html`<input class="rename-input" aria-label="Chat name" .value=${this.renameDraft} @input=${(e: Event) => { this.renameDraft = (e.target as HTMLInputElement).value; }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') void this.saveRename(); if (e.key === 'Escape') this.renamingId = ''; }}><button class="rename-chat" style="opacity:1" aria-label="Save chat name" @click=${() => void this.saveRename()}>✓</button>` : html`
        <button class="chat ${item.kind}" ?selected=${this.selectedSession === item.id} ?disabled=${item.kind === 'lane' && !item.terminal} title=${`${item.title}\n${item.path || 'Folder unknown'}`} @click=${() => this.openRow(item)}>
          <span class="status ${item.state}" title=${item.state}></span>
          <span class="body"><span class="title">${item.title}</span>
            <span class="details">${row.project?.name || 'Ungrouped'} · ${displayHarness(item.harness)}</span>
            <span class="details location" title=${item.path || 'Folder unknown'}>Folder: ${folderLabel(item.path)}</span>
            ${item.kind === 'lane' ? html`<span class="details">${item.terminal ? `Live terminal · ${item.workspaceId} / pane ${item.paneId}` : 'Terminal unavailable'}</span><span class="details origin" title=${laneOrigin(item.origin)}>${laneOrigin(item.origin)}</span>` : nothing}
          </span><span class="kind">${item.kind === 'lane' ? 'Lane' : 'Chat'}</span>
        </button>${item.kind === 'chat' ? html`<button class="rename-chat" aria-label=${`Rename ${item.title}`} title="Rename chat" @click=${() => { this.renamingId = item.id; this.renameDraft = item.title; }}>✎</button>` : nothing}`}
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
    .heading { padding:9px 12px 3px; font-size:10px; letter-spacing:.1em; text-transform:uppercase; }
  `;
  override connectedCallback() {
    super.connectedCallback();
    const update = () => this.version++;
    this.unsubs = [sdkChats.subscribe(update), homeSessions.subscribe(update), store.subscribe(update)];
    void sdkChats.refresh();
  }
  override disconnectedCallback() { this.unsubs.forEach(unsub => unsub()); this.unsubs = []; super.disconnectedCallback(); }
  override render() {
    void this.version;
    const projects = [...sdkChats.projects].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const rows: SessionRow[] = sdkChats.chats.map(chat => ({ kind:'chat', id:chat.id, chat, path:chat.projectPath, title:chat.title, harness:chat.harness, state:chat.state, updatedAt:Date.parse(chat.createdAt) || 0 }));
    const reportedPanes = new Set<string>();
    for (const session of homeSessions.sessions) {
      const workspaceId = session.workspaceId || '';
      const paneId = session.paneId;
      // Fleet also reports SDK Chats, which have no terminal coordinates and
      // already have a Chat row above. They must not become phantom Lanes.
      if (!workspaceId || paneId === null) continue;
      reportedPanes.add(`${workspaceId}:${paneId}`);
      const workspace = store.workspaces.find(ws => ws.workspaceId === workspaceId);
      const pane = workspace?.panes?.find(pane => pane.paneId === paneId);
      const terminal = isRemoteId(workspaceId) || !!pane;
      rows.push({ kind:'lane', id:session.sessionId, path:session.project || pane?.cwd || workspace?.projectPath || '',
        title:session.name || session.label || pane?.title || `Pane ${paneId ?? '?'}`, harness:session.harness || pane?.harness || '', state:session.state,
        origin:session.origin || pane?.origin || '', workspaceId, paneId:paneId ?? 0, terminal,
        updatedAt:(session.updatedAt || 0) * 1000 });
    }
    // Pane inventory arrives before the harness's own Fleet declaration.
    for (const workspace of store.workspaces) for (const pane of workspace.panes || []) {
      if (!pane.harness || reportedPanes.has(`${workspace.workspaceId}:${pane.paneId}`)) continue;
      rows.push({ kind:'lane', id:`${workspace.workspaceId}:${pane.paneId}`, path:pane.cwd || workspace.projectPath || '', title:pane.title || `${workspace.name || workspace.workspaceId} · pane ${pane.paneId}`,
        harness:pane.harness, state:'working', origin:pane.origin || '', workspaceId:workspace.workspaceId, paneId:pane.paneId, terminal:true, updatedAt:0 });
    }
    // Keep live terminals visible ahead of historical Chats even before the
    // harness publishes a Fleet timestamp. The pane inventory has no clock.
    rows.sort((a, b) => Number(b.kind === 'lane' && b.terminal) - Number(a.kind === 'lane' && a.terminal)
      || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const groups: ChatGroup[] = projects.map(project => ({ id:project.id, name:project.name, project,
      rows:rows.filter(row => row.kind === 'chat' ? row.chat.workspaceId === project.id : projectFor(row.path, projects)?.id === project.id) }));
    groups.push({ id:'ungrouped', name:'Ungrouped', rows:rows.filter(row => row.kind === 'chat'
      ? !row.chat.workspaceId || !projects.some(project => project.id === row.chat.workspaceId)
      : !projectFor(row.path, projects)) });
    return html`<div class="heading">Chats</div>${repeat(groups, group => group.id, group => html`<mux-chat-workspace .model=${group} .selectedSession=${(window as Window & { muxSelectedSDKChat?: string }).muxSelectedSDKChat ?? ''}></mux-chat-workspace>`)}`;
  }
}
