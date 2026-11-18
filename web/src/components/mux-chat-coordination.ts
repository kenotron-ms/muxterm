import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { sdkChats } from '../lib/sdk-chats.js';
import '../ui/button.js';
import type { MuxUISelect } from '../ui/select.js';
import '../ui/select.js';

type WorkActor = { kind:'chat' | 'human' | 'external-tool'; sessionId?:string };
type WorkDispatch = { clientRef:string; sessionId:string; state:string; detail?:string };
type WorkUpdate = { id:string; at:string; actor?:WorkActor; sessionId?:string; linkedSessionId?:string; text:string; status?:string; progress?:string; nextAction?:string; outcome?:string; evidence?:string[]; ownerSessionId?:string; reviewerSessionId?:string; blockedReason?:string; dependsOn?:string[]; labels?:string[] };
type WorkItem = { id:string; title:string; brief:string; status:string; progress?:string; nextAction?:string; outcome?:string; createdBy:WorkActor; ownerSessionId:string; reviewerSessionId?:string; acceptanceCriteria?:string; blockedReason?:string; dependsOn:string[]; waitingOn:string[]; labels:string[]; dispatch?:WorkDispatch; revision:number; sessionIds:string[]; projectIds:string[]; updatedAt:string; updates?:WorkUpdate[] };

@customElement('mux-chat-coordination')
export class MuxChatCoordination extends LitElement {
  @property() sessionId = '';
  @property() projectId = '';
  @property() remoteHost = '';
  @state() private work: WorkItem[] = [];
  @state() private detail?: WorkItem;
  @state() private filter: 'open' | 'all' | 'done' = 'open';
  @state() private scope: 'folder' | 'all' = 'folder';
  @state() private projectFilter = '';
  @state() private labelFilter = '';
  @state() private error = '';
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
    .field-filters { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); margin-bottom:var(--ui-space-4); }
    .field-filters mux-ui-select { flex:1 1 var(--ui-dock-tab-min-width); min-width:0; }
    .filter[pressed] { color:var(--ui-accent); }
    .list { border-top:1px solid var(--ui-border); }
    .issue { border-bottom:1px solid var(--ui-border); padding:var(--ui-space-4) var(--ui-space-2); }
    .issue-open::part(button) { display:flex; align-items:flex-start; justify-content:flex-start; gap:var(--ui-space-4); width:100%; border:0; border-radius:0; padding:0; background:transparent; color:var(--ui-text); text-align:left; white-space:normal; font:inherit; }
    .issue-open:hover::part(button) { color:var(--ui-accent); }
    .issue .issue-main { flex:1; min-width:0; }
    .issue strong { display:block; font-weight:650; overflow-wrap:anywhere; }
    .summary { display:block; margin-top:var(--ui-space-1); color:var(--ui-text-muted); overflow-wrap:anywhere; }
    .meta { font-size:var(--ui-text-xs); }
    .issue .meta { display:block; margin-top:var(--ui-space-2); }
    .chat-link { color:var(--ui-accent); text-decoration:underline; text-underline-offset:2px; }
    .chat-link:hover { color:var(--ui-text); }
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
    .facts { display:grid; gap:var(--ui-space-2); margin:var(--ui-space-4) 0; }
    .facts p { white-space:pre-wrap; overflow-wrap:anywhere; }
    .facts strong { color:var(--ui-text); }
    .blocker { border-left:3px solid var(--ui-danger); padding:var(--ui-space-2) var(--ui-space-4); margin:var(--ui-space-5) 0; background:var(--ui-surface-raised); white-space:pre-wrap; }
    .error { color:var(--ui-danger); margin:var(--ui-space-3) 0; }
    @media(max-width:550px) { .wrap { padding:var(--ui-space-5); } .issue { padding-inline:0; } .issue .status { display:none; } }
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
      this.projectFilter = '';
      this.labelFilter = '';
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
    void this.refresh();
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
  private sessionTitle(id:string) { return sdkChats.chats.find(chat => chat.id === id && (chat.remoteHost || '') === this.remoteHost)?.title || id.slice(0,8); }
  private chatLink(id:string) { return html`<a class="chat-link" href=${`#chat=${encodeURIComponent(id)}${this.remoteHost ? `&host=${encodeURIComponent(this.remoteHost)}` : ''}`} title=${`Open chat ${this.sessionTitle(id)}`}>${this.sessionTitle(id)}</a>`; }
  private actorLabel(actor?:WorkActor, legacySessionId?:string) { return actor?.kind === 'chat' && actor.sessionId ? this.chatLink(actor.sessionId) : actor?.kind === 'human' ? 'Browser user' : actor?.kind === 'external-tool' ? 'External tool' : legacySessionId ? this.chatLink(legacySessionId) : 'Unknown'; }
  private creatorLabel(item:WorkItem) { return this.actorLabel(item.createdBy); }
  private ownerLabel(item:WorkItem) { return item.ownerSessionId ? this.chatLink(item.ownerSessionId) : 'Unassigned'; }
  private dispatchLabel(item:WorkItem) { const dispatch=item.dispatch; return dispatch ? dispatch.state === 'failed' ? 'Failed to start' : dispatch.state === 'preparing' ? 'Preparing chat' : html`${dispatch.state === 'claimed' ? 'Claimed by' : dispatch.state === 'uncertain' ? 'Check' : 'Sent to'} ${this.chatLink(dispatch.sessionId)}` : nothing; }
  private dependencyLabel(id:string) { return this.work.find(item => item.id === id)?.title || id.slice(0,8); }
  private async openDependency(id:string) {
    const item = this.work.find(candidate => candidate.id === id);
    if (item) { this.openDetail(item); return; }
    try { this.detail = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(id)}`); }
    catch (error) { this.error = String(error); }
  }
  private dependencyLinks(ids:string[]) { return ids.map((id, index) => html`${index ? ', ' : ''}<a class="chat-link" href="#" @click=${(event:Event) => { event.preventDefault(); void this.openDependency(id); }} title=${`Open work ${id}`}>${this.dependencyLabel(id)}</a>`); }
  private selectScope(scope:'folder' | 'all') {
    if (scope === this.scope) return;
    this.refreshKey++;
    this.loading = false;
    this.scope = scope;
    this.projectFilter = '';
    this.work = [];
    this.detail = undefined;
    void this.refresh();
  }
  private selectProjectFilter(id:string) {
    if (id && this.scope !== 'all') this.selectScope('all');
    this.projectFilter = id;
  }
  private projectName(id:string) { return sdkChats.projects.find(project => project.id === id && (project.remoteHost || '') === this.remoteHost)?.name || id.slice(0,8); }
  private projectNames(item:WorkItem) {
    return item.projectIds?.length ? item.projectIds.map(id => this.projectName(id)).join(', ') : 'No folder';
  }

  private issueList() {
    const ordered = [...this.work].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    const projectIds = [...new Set([...sdkChats.projects.filter(project => (project.remoteHost || '') === this.remoteHost).map(project => project.id), ...ordered.flatMap(item => item.projectIds || [])])].sort((a,b) => this.projectName(a).localeCompare(this.projectName(b)));
    const labels = [...new Set(ordered.flatMap(item => item.labels || []))].sort();
    const narrowed = ordered.filter(item => (!this.projectFilter || item.projectIds?.includes(this.projectFilter)) && (!this.labelFilter || item.labels?.includes(this.labelFilter)));
    const openCount = narrowed.filter(item => item.status !== 'done' && item.status !== 'cancelled').length;
    const visible = narrowed.filter(item => this.filter === 'all' || (this.filter === 'done' ? item.status === 'done' || item.status === 'cancelled' : item.status !== 'done' && item.status !== 'cancelled'));
    return html`<div class="overview"><p>${openCount} open · ${narrowed.length} total</p><div class="filters" aria-label="Issue scope"><mux-ui-button size="small" variant="quiet" toggle .pressed=${this.scope === 'folder'} @click=${() => this.selectScope('folder')}>${this.projectId ? 'This folder' : 'This chat'}</mux-ui-button><mux-ui-button size="small" variant="quiet" toggle .pressed=${this.scope === 'all'} @click=${() => this.selectScope('all')}>All issues</mux-ui-button></div></div>
      <div class="filters" aria-label="Filter issues">${(['open','all','done'] as const).map(filter => html`<mux-ui-button class="filter" size="small" variant="quiet" toggle .pressed=${this.filter === filter} @click=${() => { this.filter=filter; }}>${filter === 'open' ? 'Open' : filter === 'all' ? 'All' : 'Done'}</mux-ui-button>`)}</div>
      <div class="field-filters"><mux-ui-select size="small" aria-label="Filter by project" .value=${this.projectFilter} .options=${[{value:'',label:'All projects'},...projectIds.map(id => ({value:id,label:this.projectName(id)}))]} @change=${(event:Event) => this.selectProjectFilter((event.target as MuxUISelect).value)}></mux-ui-select><mux-ui-select size="small" aria-label="Filter by label" .value=${this.labelFilter} .options=${[{value:'',label:'All labels'},...labels.map(label => ({value:label,label}))]} @change=${(event:Event) => { this.labelFilter=(event.target as MuxUISelect).value; }}></mux-ui-select></div>
      ${visible.length ? html`<div class="list">${visible.map(item => html`<div class="issue"><mux-ui-button class="issue-open" full-width variant="quiet" @click=${() => this.openDetail(item)}><span class="status-dot ${item.status}" aria-hidden="true"></span><span class="issue-main"><strong>${item.title}</strong><span class="summary">${item.waitingOn?.length ? `Waiting on ${item.waitingOn.length} prerequisite${item.waitingOn.length === 1 ? '' : 's'}` : item.nextAction || item.progress || item.brief || 'No progress yet'}</span></span><span class="status">${this.statusName(item.status)}</span></mux-ui-button><span class="meta">Owner: ${this.ownerLabel(item)} · Created by ${this.creatorLabel(item)}${item.dispatch && item.dispatch.state !== 'claimed' ? html` · Kickoff: ${this.dispatchLabel(item)}` : nothing} · ${this.projectNames(item)}${item.labels?.length ? ` · ${item.labels.join(', ')}` : ''}</span></div>`)}</div>` : html`<div class="empty"><strong>${this.work.length ? 'No issues in this view' : 'No issues yet'}</strong>${this.work.length ? 'Choose another filter to see them.' : 'Issues will appear here as agents record shared work.'}</div>`}`;
  }
  private issueDetail() {
    const item = this.detail;
    if (!item) return nothing;
    const updates = [...(item.updates || [])].reverse();
    return html`<div class="detail-head"><mux-ui-button size="small" variant="quiet" @click=${() => { this.detail=undefined; }}>← All issues</mux-ui-button><span class="status">${this.statusName(item.status)}</span></div>
      <h2>${item.title}</h2><p class="detail-lead">${item.brief || 'No description yet.'}</p>
      <div class="facts"><p><strong>Created by:</strong> ${this.creatorLabel(item)}</p><p><strong>Owner:</strong> ${this.ownerLabel(item)}</p>${item.dispatch ? html`<p><strong>Kickoff:</strong> ${this.dispatchLabel(item)}${item.dispatch.detail ? ` · ${item.dispatch.detail}` : ''}</p>` : nothing}${item.labels?.length ? html`<p><strong>Labels:</strong> ${item.labels.join(', ')}</p>` : nothing}${item.dependsOn?.length ? html`<p><strong>Depends on:</strong> ${this.dependencyLinks(item.dependsOn)}</p>` : nothing}${item.waitingOn?.length ? html`<p><strong>Waiting on:</strong> ${this.dependencyLinks(item.waitingOn)}</p>` : nothing}${item.nextAction ? html`<p><strong>Next action:</strong> ${item.nextAction}</p>` : nothing}${item.acceptanceCriteria ? html`<p><strong>Acceptance criteria:</strong> ${item.acceptanceCriteria}</p>` : nothing}<p><strong>Reviewer:</strong> ${item.reviewerSessionId ? this.chatLink(item.reviewerSessionId) : 'Unassigned'}</p>${item.sessionIds?.length ? html`<p><strong>Participants:</strong> ${item.sessionIds.map((id, index) => html`${index ? ', ' : ''}${this.chatLink(id)}`)}</p>` : nothing}<p class="meta">Updated ${this.date(item.updatedAt)} · Folders: ${this.projectNames(item)}</p></div>
      ${item.status === 'blocked' ? html`<div class="blocker"><strong>Blocked:</strong> ${item.blockedReason}</div>` : nothing}
      <div class="progress"><strong>Current progress</strong><p>${item.progress || 'No progress recorded yet.'}</p>${item.outcome ? html`<p><strong>Outcome:</strong> ${item.outcome}</p>` : nothing}</div>
      <section class="timeline"><h3>Activity</h3>${updates.length ? updates.map(update => html`<div class="entry"><div class="meta">${this.date(update.at)} · ${this.actorLabel(update.actor, update.sessionId)}${update.status ? ` · ${this.statusName(update.status)}` : ''}</div><p>${update.text || update.progress || update.outcome || (update.ownerSessionId !== undefined ? html`Owner: ${update.ownerSessionId ? this.chatLink(update.ownerSessionId) : 'Unassigned'}` : update.reviewerSessionId !== undefined ? html`Reviewer: ${update.reviewerSessionId ? this.chatLink(update.reviewerSessionId) : 'Unassigned'}` : update.dependsOn !== undefined ? html`Dependencies: ${update.dependsOn.length ? this.dependencyLinks(update.dependsOn) : 'Cleared'}` : update.labels !== undefined ? `Labels: ${update.labels.length ? update.labels.join(', ') : 'Cleared'}` : update.nextAction !== undefined ? `Next action: ${update.nextAction || 'Cleared'}` : update.blockedReason ? update.blockedReason : update.linkedSessionId ? html`Linked ${this.chatLink(update.linkedSessionId)}` : update.status ? this.statusName(update.status) : 'Update recorded')}</p>${update.evidence?.length ? html`<p class="meta">Evidence: ${update.evidence.join(', ')}</p>` : nothing}</div>`) : html`<div class="empty">No activity yet.</div>`}</section>`;
  }
  override render() {
    return html`<div class="wrap"><header><h2>Issues</h2><p class="intro">Shared work and its current status.</p></header>${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}${this.detail ? this.issueDetail() : this.issueList()}</div>`;
  }
}
