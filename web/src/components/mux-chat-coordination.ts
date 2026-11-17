import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { sdkChats } from '../lib/sdk-chats.js';
import '../ui/button.js';
import { MuxUISelect } from '../ui/select.js';

type WorkActor = { kind:'chat' | 'human' | 'external-tool'; sessionId?:string };
type WorkUpdate = { id:string; at:string; actor?:WorkActor; sessionId?:string; linkedSessionId?:string; text:string; status?:string; progress?:string; outcome?:string; evidence?:string[]; ownerSessionId?:string; reviewerSessionId?:string; blockedReason?:string };
type WorkItem = { id:string; title:string; brief:string; status:string; progress?:string; outcome?:string; createdBy:WorkActor; ownerSessionId:string; reviewerSessionId?:string; acceptanceCriteria?:string; blockedReason?:string; revision:number; sessionIds:string[]; projectIds:string[]; updatedAt:string; updates?:WorkUpdate[] };

@customElement('mux-chat-coordination')
export class MuxChatCoordination extends LitElement {
  @property() sessionId = '';
  @property() projectId = '';
  @property() remoteHost = '';
  @state() private work: WorkItem[] = [];
  @state() private detail?: WorkItem;
  @state() private filter: 'open' | 'all' | 'done' = 'open';
  @state() private scope: 'folder' | 'all' = 'folder';
  @state() private error = '';
  @state() private ownerDraft = '';
  @state() private reviewerDraft = '';
  @state() private blockerDraft = '';
  @state() private saving = false;
  private poll?: number;
  private loading = false;
  private refreshKey = 0;

  static styles = css`
    :host { display:block; height:100%; overflow:auto; box-sizing:border-box; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-sm)/1.5 var(--ui-font-sans); }
    * { box-sizing:border-box; }
    .wrap { max-width:var(--ui-chat-content-width); margin:0 auto; padding:var(--ui-space-7); }
    h2,h3,p { margin:0; }
    h2 { font-size:var(--ui-text-xl); line-height:1.2; letter-spacing:-.02em; }
    h3 { font-size:var(--ui-text-md); }
    .intro,.meta { color:var(--ui-text-muted); }
    .intro { margin-top:var(--ui-space-2); }
    .overview { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--ui-space-4); margin:var(--ui-space-7) 0 var(--ui-space-5); }
    .overview p { color:var(--ui-text-muted); }
    .overview .filters { margin-bottom:0; }
    .filters { display:flex; gap:var(--ui-space-2); margin-bottom:var(--ui-space-4); }
    .filter[pressed] { color:var(--ui-accent); }
    .list { border-top:1px solid var(--ui-border); }
    .issue::part(button) { display:flex; align-items:flex-start; justify-content:flex-start; gap:var(--ui-space-4); width:100%; border:0; border-bottom:1px solid var(--ui-border); border-radius:0; padding:var(--ui-space-5) var(--ui-space-2); background:transparent; color:var(--ui-text); text-align:left; white-space:normal; font:inherit; }
    .issue:hover::part(button) { background:var(--ui-surface-hover); }
    .issue .issue-main { flex:1; min-width:0; }
    .issue strong { display:block; font-weight:650; overflow-wrap:anywhere; }
    .summary { display:block; margin-top:var(--ui-space-1); color:var(--ui-text-muted); overflow-wrap:anywhere; }
    .meta { font-size:var(--ui-text-xs); }
    .issue .meta { display:block; margin-top:var(--ui-space-2); }
    .status-dot { flex:none; width:var(--ui-space-5); height:var(--ui-space-5); margin-top:var(--ui-space-2); border:2px solid var(--ui-border-strong); border-radius:50%; }
    .status-dot.active { border-color:var(--ui-accent); background:var(--ui-accent); }
    .status-dot.blocked { border-color:var(--ui-danger); background:var(--ui-danger); }
    .status-dot.done { border-color:var(--ui-accent); background:color-mix(in srgb,var(--ui-accent) 30%,transparent); }
    .status { flex:none; color:var(--ui-text-muted); font-size:var(--ui-text-xs); white-space:nowrap; }
    .empty { padding:var(--ui-space-8) var(--ui-space-2); color:var(--ui-text-muted); border-top:1px solid var(--ui-border); }
    .empty strong { display:block; margin-bottom:var(--ui-space-2); color:var(--ui-text); }
    .detail-head { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-4); margin:var(--ui-space-7) 0 var(--ui-space-4); }
    .detail-lead { margin:var(--ui-space-5) 0; overflow-wrap:anywhere; white-space:pre-wrap; }
    .progress { border-left:3px solid var(--ui-accent); padding:var(--ui-space-2) var(--ui-space-4); margin:var(--ui-space-5) 0; background:var(--ui-surface-raised); overflow-wrap:anywhere; }
    .timeline { margin-top:var(--ui-space-6); border-top:1px solid var(--ui-border); }
    .timeline h3 { padding:var(--ui-space-5) 0 var(--ui-space-2); }
    .entry { border-bottom:1px solid var(--ui-border); padding:var(--ui-space-4) 0; }
    .entry p { margin-top:var(--ui-space-2); white-space:pre-wrap; overflow-wrap:anywhere; }
    .ownership { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--ui-space-4); margin:var(--ui-space-5) 0; }
    .ownership .field { min-width:0; }
    .ownership mux-ui-button { margin-top:var(--ui-space-2); }
    .facts { display:grid; gap:var(--ui-space-2); margin:var(--ui-space-4) 0; }
    .facts p { white-space:pre-wrap; overflow-wrap:anywhere; }
    .facts strong { color:var(--ui-text); }
    .blocker { border-left:3px solid var(--ui-danger); padding:var(--ui-space-2) var(--ui-space-4); margin:var(--ui-space-5) 0; background:var(--ui-surface-raised); white-space:pre-wrap; }
    .actions { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); margin:var(--ui-space-4) 0; }
    .blocker-input { width:100%; min-height:var(--ui-control-lg); resize:vertical; padding:var(--ui-space-3); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); color:var(--ui-text); font:inherit; }
    .error { color:var(--ui-danger); margin:var(--ui-space-3) 0; }
    @media(max-width:550px) { .wrap { padding:var(--ui-space-5); } .issue::part(button) { padding-inline:0; } .issue .status { display:none; } .ownership { grid-template-columns:1fr; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.poll = window.setInterval(() => { if (!document.hidden) void this.refresh(); }, 3000);
  }
  override disconnectedCallback() {
    if (this.poll) window.clearInterval(this.poll);
    this.refreshKey++;
    this.loading = false;
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues<this>) {
    if (changed.has('sessionId') || changed.has('projectId') || changed.has('remoteHost')) {
      this.refreshKey++;
      this.work = [];
      this.detail = undefined;
      this.filter = 'open';
      this.scope = 'folder';
      this.loading = false;
      void this.refresh();
    }
  }
  private path(path: string) { return apiPath(remoteChatPath(this.remoteHost, path)); }
  private async request<T>(path: string): Promise<T> {
    const response = await fetch(this.path(path), {cache:'no-store'});
    if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
    return await response.json() as T;
  }
  private openDetail(item:WorkItem) {
    this.detail = item;
    this.ownerDraft = item.ownerSessionId || '';
    this.reviewerDraft = item.reviewerSessionId || '';
    this.blockerDraft = item.blockedReason || '';
    void this.refresh();
  }
  private async updateItem(change:Record<string,unknown>) {
    const item = this.detail;
    if (!item || this.saving) return;
    this.saving = true;
    this.error = '';
    try {
      const response = await fetch(this.path(`/api/sdk-work/${encodeURIComponent(item.id)}/updates`), {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({clientRef:crypto.randomUUID(), ...change}),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
      const updated = await response.json() as WorkItem;
      this.detail = updated;
      this.ownerDraft = updated.ownerSessionId || '';
      this.reviewerDraft = updated.reviewerSessionId || '';
      this.blockerDraft = updated.blockedReason || '';
      void this.refresh();
    } catch (error) {
      await this.refresh();
      this.error = String(error);
    } finally { this.saving = false; }
  }
  private async refresh() {
    if (!this.sessionId || this.loading) return;
    const key = this.refreshKey;
    this.loading = true;
    try {
      const query = this.scope === 'all' ? '' : this.projectId ? `?project_id=${encodeURIComponent(this.projectId)}` : `?session_id=${encodeURIComponent(this.sessionId)}`;
      const result = await this.request<{work:WorkItem[]}>(`/api/sdk-work${query}`);
      if (key !== this.refreshKey) return;
      this.work = result.work;
      if (this.detail) {
        const detail = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(this.detail.id)}`);
        if (key !== this.refreshKey) return;
        this.detail = detail;
      }
      this.error = '';
    } catch (error) { if (key === this.refreshKey) this.error = String(error); }
    finally { if (key === this.refreshKey) this.loading = false; }
  }
  private date(value: string) { return new Date(value).toLocaleString(undefined, {dateStyle:'medium',timeStyle:'short'}); }
  private statusName(status: string) { return ({active:'In progress',open:'Open',blocked:'Blocked',review:'Ready for review',done:'Done',cancelled:'Cancelled'} as Record<string,string>)[status] || status; }
  private sessionTitle(id:string) { return sdkChats.chats.find(chat => chat.id === id)?.title || id.slice(0,8); }
  private actorName(actor?:WorkActor, legacySessionId?:string) { return actor?.kind === 'chat' && actor.sessionId ? this.sessionTitle(actor.sessionId) : actor?.kind === 'human' ? 'Browser user' : actor?.kind === 'external-tool' ? 'External tool' : legacySessionId ? this.sessionTitle(legacySessionId) : 'Unknown'; }
  private creatorName(item:WorkItem) { return this.actorName(item.createdBy); }
  private ownerName(item:WorkItem) { return item.ownerSessionId ? this.sessionTitle(item.ownerSessionId) : 'Unassigned'; }
  private sessionOptions() { return [{value:'',label:'Unassigned'}, ...sdkChats.chats.filter(chat => (chat.remoteHost || '') === this.remoteHost && (!chat.archived || chat.id === this.detail?.ownerSessionId || chat.id === this.detail?.reviewerSessionId)).map(chat => ({value:chat.id,label:chat.title || chat.id.slice(0,8)}))]; }
  private selectScope(scope:'folder' | 'all') {
    if (scope === this.scope) return;
    this.refreshKey++;
    this.loading = false;
    this.scope = scope;
    this.work = [];
    this.detail = undefined;
    void this.refresh();
  }
  private projectNames(item:WorkItem) {
    return item.projectIds?.length ? item.projectIds.map(id => sdkChats.projects.find(project => project.id === id && (project.remoteHost || '') === this.remoteHost)?.name || id.slice(0,8)).join(', ') : 'No folder';
  }

  private issueList() {
    const ordered = [...this.work].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    const openCount = ordered.filter(item => item.status !== 'done' && item.status !== 'cancelled').length;
    const visible = ordered.filter(item => this.filter === 'all' || (this.filter === 'done' ? item.status === 'done' || item.status === 'cancelled' : item.status !== 'done' && item.status !== 'cancelled'));
    return html`<div class="overview"><p>${openCount} open · ${this.work.length} total</p><div class="filters" aria-label="Issue scope"><mux-ui-button size="small" variant="quiet" toggle .pressed=${this.scope === 'folder'} @click=${() => this.selectScope('folder')}>${this.projectId ? 'This folder' : 'This chat'}</mux-ui-button><mux-ui-button size="small" variant="quiet" toggle .pressed=${this.scope === 'all'} @click=${() => this.selectScope('all')}>All issues</mux-ui-button></div></div>
      <div class="filters" aria-label="Filter issues">${(['open','all','done'] as const).map(filter => html`<mux-ui-button class="filter" size="small" variant="quiet" toggle .pressed=${this.filter === filter} @click=${() => { this.filter=filter; }}>${filter === 'open' ? 'Open' : filter === 'all' ? 'All' : 'Done'}</mux-ui-button>`)}</div>
      ${visible.length ? html`<div class="list">${visible.map(item => html`<mux-ui-button class="issue" full-width variant="quiet" @click=${() => this.openDetail(item)}><span class="status-dot ${item.status}" aria-hidden="true"></span><span class="issue-main"><strong>${item.title}</strong><span class="summary">${item.progress || item.brief || 'No progress yet'}</span><span class="meta">Owner: ${this.ownerName(item)} · Created by ${this.creatorName(item)} · ${this.projectNames(item)}</span></span><span class="status">${this.statusName(item.status)}</span></mux-ui-button>`)}</div>` : html`<div class="empty"><strong>${this.work.length ? 'No issues in this view' : 'No issues yet'}</strong>${this.work.length ? 'Choose another filter to see them.' : 'Issues will appear here as agents record shared work.'}</div>`}`;
  }
  private issueDetail() {
    const item = this.detail;
    if (!item) return nothing;
    const updates = [...(item.updates || [])].reverse();
    return html`<div class="detail-head"><mux-ui-button size="small" variant="quiet" @click=${() => { this.detail=undefined; }}>← All issues</mux-ui-button><span class="status">${this.statusName(item.status)}</span></div>
      <h2>${item.title}</h2><p class="detail-lead">${item.brief || 'No description yet.'}</p>
      <div class="facts"><p><strong>Created by:</strong> ${this.creatorName(item)}</p><p><strong>Owner:</strong> ${this.ownerName(item)}</p>${item.acceptanceCriteria ? html`<p><strong>Acceptance criteria:</strong> ${item.acceptanceCriteria}</p>` : nothing}<p><strong>Reviewer:</strong> ${item.reviewerSessionId ? this.sessionTitle(item.reviewerSessionId) : 'Unassigned'}</p><p class="meta">Updated ${this.date(item.updatedAt)} · Folders: ${this.projectNames(item)}</p></div>
      <div class="ownership"><div class="field"><mux-ui-select label="Assign owner" .value=${this.ownerDraft} .options=${this.sessionOptions()} ?disabled=${this.saving} @change=${(event:Event) => { this.ownerDraft=(event.target as MuxUISelect).value; }}></mux-ui-select><mux-ui-button size="small" variant="secondary" ?disabled=${this.saving || this.ownerDraft === (item.ownerSessionId || '')} @click=${() => void this.updateItem({ownerSessionId:this.ownerDraft,expectedRevision:item.revision})}>Save owner</mux-ui-button></div><div class="field"><mux-ui-select label="Reviewer" .value=${this.reviewerDraft} .options=${this.sessionOptions()} ?disabled=${this.saving} @change=${(event:Event) => { this.reviewerDraft=(event.target as MuxUISelect).value; }}></mux-ui-select><mux-ui-button size="small" variant="secondary" ?disabled=${this.saving || this.reviewerDraft === (item.reviewerSessionId || '')} @click=${() => void this.updateItem({reviewerSessionId:this.reviewerDraft,expectedRevision:item.revision})}>Save reviewer</mux-ui-button></div></div>
      ${item.status === 'blocked' ? html`<div class="blocker"><strong>Blocked:</strong> ${item.blockedReason}</div>` : nothing}
      <div class="progress"><strong>Current progress</strong><p>${item.progress || 'No progress recorded yet.'}</p>${item.outcome ? html`<p><strong>Outcome:</strong> ${item.outcome}</p>` : nothing}</div>
      <div class="actions">${item.status === 'blocked' ? html`<mux-ui-button size="small" variant="secondary" ?disabled=${this.saving} @click=${() => void this.updateItem({status:'active'})}>Resume work</mux-ui-button>` : item.status === 'open' || item.status === 'active' ? html`<mux-ui-button size="small" variant="secondary" ?disabled=${this.saving} @click=${() => void this.updateItem({status:'review'})}>Ready for review</mux-ui-button>` : nothing}${item.status !== 'done' && item.status !== 'cancelled' ? html`<mux-ui-button size="small" variant="secondary" ?disabled=${this.saving} @click=${() => void this.updateItem({status:'done'})}>Mark done</mux-ui-button>` : nothing}</div>
      ${item.status !== 'done' && item.status !== 'cancelled' ? html`<label for="work-blocker">Blocker</label><textarea id="work-blocker" class="blocker-input" .value=${this.blockerDraft} @input=${(event:Event) => { this.blockerDraft=(event.target as HTMLTextAreaElement).value; }} placeholder="What needs to happen before work can continue?"></textarea><div class="actions"><mux-ui-button size="small" variant="secondary" ?disabled=${this.saving || !this.blockerDraft.trim()} @click=${() => void this.updateItem({status:'blocked',blockedReason:this.blockerDraft.trim()})}>Mark blocked</mux-ui-button></div>` : nothing}
      <section class="timeline"><h3>Activity</h3>${updates.length ? updates.map(update => html`<div class="entry"><div class="meta">${this.date(update.at)} · ${this.actorName(update.actor, update.sessionId)}${update.status ? ` · ${this.statusName(update.status)}` : ''}</div><p>${update.text || update.progress || update.outcome || (update.ownerSessionId !== undefined ? `Owner: ${update.ownerSessionId ? this.sessionTitle(update.ownerSessionId) : 'Unassigned'}` : update.reviewerSessionId !== undefined ? `Reviewer: ${update.reviewerSessionId ? this.sessionTitle(update.reviewerSessionId) : 'Unassigned'}` : update.blockedReason ? update.blockedReason : update.linkedSessionId ? `Linked ${this.sessionTitle(update.linkedSessionId)}` : update.status ? this.statusName(update.status) : 'Update recorded')}</p>${update.evidence?.length ? html`<p class="meta">Evidence: ${update.evidence.join(', ')}</p>` : nothing}</div>`) : html`<div class="empty">No activity yet.</div>`}</section>`;
  }
  override render() {
    return html`<div class="wrap"><header><h2>Issues</h2><p class="intro">Shared work and its current status.</p></header>${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}${this.detail ? this.issueDetail() : this.issueList()}</div>`;
  }
}
