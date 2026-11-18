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
type WorkItem = { id:string; title:string; brief:string; status:string; progress?:string; nextAction?:string; outcome?:string; createdBy:WorkActor; ownerSessionId:string; reviewerSessionId?:string; acceptanceCriteria?:string; blockedReason?:string; dependsOn:string[]; waitingOn:string[]; labels:string[]; dispatch?:WorkDispatch; revision:number; sessionIds:string[]; projectIds:string[]; createdAt:string; updatedAt:string; updates?:WorkUpdate[] };
type QueueLane = 'attention' | 'review' | 'active' | 'dispatching' | 'ready' | 'waiting' | 'finished';
const queueLanes: {id:QueueLane; title:string; description:string}[] = [
  {id:'attention',title:'Needs attention',description:'Blocked work or a kickoff that needs checking'},
  {id:'review',title:'Ready for review',description:'Implementation reported; review is next'},
  {id:'active',title:'In progress',description:'A chat is working on these items'},
  {id:'dispatching',title:'Starting',description:'A kickoff has been sent to a chat'},
  {id:'ready',title:'Ready to start',description:'Open work with no unfinished prerequisites'},
  {id:'waiting',title:'Waiting on work',description:'Prerequisites must finish first'},
  {id:'finished',title:'Finished',description:'Done or cancelled work'},
];

@customElement('mux-chat-coordination')
export class MuxChatCoordination extends LitElement {
  @property() sessionId = '';
  @property() projectId = '';
  @property() remoteHost = '';
  @state() private work: WorkItem[] = [];
  @state() private detail?: WorkItem;
  @state() private filter: 'open' | 'all' | 'done' = 'open';
  @state() private scope: 'folder' | 'all' = 'all';
  @state() private projectFilter = '';
  @state() private labelFilter = '';
  @state() private error = '';
  private poll?: number;
  private loading = false;
  private refreshKey = 0;

  static styles = css`
    :host { display:block; height:100%; overflow:auto; box-sizing:border-box; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-sm)/1.5 var(--ui-font-sans); }
    * { box-sizing:border-box; }
    .wrap { max-width:1100px; margin:0 auto; padding:var(--ui-space-7); }
    h2,h3,p { margin:0; }
    h2 { font-size:var(--ui-text-xl); line-height:1.25; letter-spacing:-.02em; }
    h3 { font-size:var(--ui-text-md); }
    .intro,.meta,.muted { color:var(--ui-text-muted); }
    .intro { margin-top:var(--ui-space-2); }
    .overview { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--ui-space-4); margin:var(--ui-space-7) 0 var(--ui-space-4); }
    .overview .filters { margin-bottom:0; }
    .filters { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); margin-bottom:var(--ui-space-4); }
    .field-filters { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); margin-bottom:var(--ui-space-5); }
    .field-filters mux-ui-select { flex:1 1 var(--ui-dock-tab-min-width); min-width:0; }
    .queue-summary { display:flex; flex-wrap:wrap; gap:var(--ui-space-2) var(--ui-space-5); padding:var(--ui-space-3) 0; border-block:1px solid var(--ui-border); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .queue-summary strong { color:var(--ui-text); font-variant-numeric:tabular-nums; }
    .lane { margin-top:var(--ui-space-6); }
    .lane-heading { display:flex; align-items:baseline; gap:var(--ui-space-3); padding-bottom:var(--ui-space-2); border-bottom:1px solid var(--ui-border-strong); }
    .lane-heading span { color:var(--ui-text-muted); font-size:var(--ui-text-xs); font-variant-numeric:tabular-nums; }
    .lane-description { margin:var(--ui-space-2) 0; color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .work-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--ui-space-3); align-items:start; border-bottom:1px solid var(--ui-border); padding:var(--ui-space-3) var(--ui-space-2); }
    .work-row:hover { background:var(--ui-surface-hover); }
    .work-open::part(button) { width:100%; min-width:0; display:block; border:0; border-radius:0; padding:0; background:transparent; color:var(--ui-text); text-align:left; white-space:normal; font:inherit; }
    .work-open:hover::part(button) { color:var(--ui-accent); }
    .work-open strong { display:block; font-weight:650; overflow-wrap:anywhere; }
    .summary { display:block; margin-top:var(--ui-space-1); color:var(--ui-text-muted); overflow-wrap:anywhere; }
    .meta { font-size:var(--ui-text-xs); overflow-wrap:anywhere; }
    .work-row .meta { grid-column:1 / -1; }
    .chat-link,.work-link { color:var(--ui-accent); text-decoration:underline; text-underline-offset:2px; }
    .chat-link:hover,.work-link:hover { color:var(--ui-text); }
    .status { color:var(--ui-text-muted); font-size:var(--ui-text-xs); white-space:nowrap; }
    .empty { padding:var(--ui-space-7) var(--ui-space-2); color:var(--ui-text-muted); }
    .empty strong { display:block; margin-bottom:var(--ui-space-2); color:var(--ui-text); }
    .detail-head { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-4); margin-bottom:var(--ui-space-6); }
    .detail-title { font-size:clamp(1.35rem,3vw,2rem); line-height:1.25; overflow-wrap:anywhere; }
    .detail-number { color:var(--ui-text-muted); font-weight:400; }
    .detail-subtitle { display:flex; flex-wrap:wrap; align-items:center; gap:var(--ui-space-2); margin-top:var(--ui-space-3); padding-bottom:var(--ui-space-5); border-bottom:1px solid var(--ui-border); color:var(--ui-text-muted); }
    .state-pill { display:inline-flex; align-items:center; border:1px solid var(--ui-border-strong); border-radius:999px; padding:1px var(--ui-space-3); color:var(--ui-text); font-size:var(--ui-text-xs); font-weight:650; }
    .state-pill.attention { border-color:var(--ui-danger); color:var(--ui-danger); }
    .state-pill.active,.state-pill.ready { border-color:var(--ui-accent); color:var(--ui-accent); }
    .detail-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(190px,250px); gap:var(--ui-space-7); align-items:start; margin-top:var(--ui-space-6); }
    .detail-main { min-width:0; }
    .description,.detail-section { padding-bottom:var(--ui-space-5); margin-bottom:var(--ui-space-5); border-bottom:1px solid var(--ui-border); }
    .description p,.detail-section p { margin-top:var(--ui-space-3); white-space:pre-wrap; overflow-wrap:anywhere; }
    .detail-section h3,.side-section h3 { font-size:var(--ui-text-sm); font-weight:650; }
    .side-section { padding-bottom:var(--ui-space-4); margin-bottom:var(--ui-space-4); border-bottom:1px solid var(--ui-border); }
    .side-section p { margin-top:var(--ui-space-2); overflow-wrap:anywhere; }
    .side-section .muted { font-size:var(--ui-text-xs); }
    .chip { display:inline-block; margin:var(--ui-space-1) var(--ui-space-1) 0 0; border:1px solid var(--ui-border); border-radius:999px; padding:0 var(--ui-space-2); font-size:var(--ui-text-xs); }
    .blocker { border-left:3px solid var(--ui-danger); padding:var(--ui-space-3) var(--ui-space-4); background:var(--ui-surface-raised); white-space:pre-wrap; }
    .activity { margin-top:var(--ui-space-7); }
    .activity h3 { padding-bottom:var(--ui-space-3); border-bottom:1px solid var(--ui-border-strong); }
    .entry { position:relative; border-bottom:1px solid var(--ui-border); padding:var(--ui-space-4) 0; }
    .entry p { margin-top:var(--ui-space-2); white-space:pre-wrap; overflow-wrap:anywhere; }
    .error { color:var(--ui-danger); margin:var(--ui-space-3) 0; }
    @media(max-width:700px) { .detail-grid { grid-template-columns:1fr; gap:0; } }
    @media(max-width:550px) { .wrap { padding:var(--ui-space-5); } .work-row { padding-inline:0; } .work-row .status { display:none; } }
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
      this.scope = 'all';
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
  private dispatchLabel(item:WorkItem) { const dispatch=item.dispatch; return dispatch ? html`${dispatch.state === 'failed' ? 'Failed kickoff for' : dispatch.state === 'preparing' ? 'Preparing' : dispatch.state === 'claimed' ? 'Claimed by' : dispatch.state === 'uncertain' ? 'Check' : 'Sent to'} ${this.chatLink(dispatch.sessionId)}` : nothing; }
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
    return item.projectIds?.length ? item.projectIds.map(id => this.projectName(id)).join(', ') : 'No project';
  }

  private queueLane(item:WorkItem): QueueLane {
    if (item.status === 'done' || item.status === 'cancelled') return 'finished';
    if (item.status === 'blocked' || item.dispatch?.state === 'failed' || item.dispatch?.state === 'uncertain') return 'attention';
    if (item.status === 'review') return 'review';
    if (item.status === 'active') return 'active';
    if (item.waitingOn?.length) return 'waiting';
    if (item.dispatch && (item.dispatch.state === 'preparing' || item.dispatch.state === 'sent')) return 'dispatching';
    return 'ready';
  }
  private workList() {
    const ordered = [...this.work].sort((a,b) => (a.createdAt || a.updatedAt).localeCompare(b.createdAt || b.updatedAt) || a.id.localeCompare(b.id));
    const projectIds = [...new Set([...sdkChats.projects.filter(project => (project.remoteHost || '') === this.remoteHost).map(project => project.id), ...ordered.flatMap(item => item.projectIds || [])])].sort((a,b) => this.projectName(a).localeCompare(this.projectName(b)));
    const labels = [...new Set(ordered.flatMap(item => item.labels || []))].sort();
    const narrowed = ordered.filter(item => (!this.projectFilter || item.projectIds?.includes(this.projectFilter)) && (!this.labelFilter || item.labels?.includes(this.labelFilter)));
    const visible = narrowed.filter(item => this.filter === 'all' || (this.filter === 'done' ? this.queueLane(item) === 'finished' : this.queueLane(item) !== 'finished'));
    const counts = new Map(queueLanes.map(lane => [lane.id, narrowed.filter(item => this.queueLane(item) === lane.id).length]));
    return html`<div class="overview"><p class="meta">${narrowed.length} work item${narrowed.length === 1 ? '' : 's'} in this view</p><div class="filters" aria-label="Work scope"><mux-ui-button size="small" variant="quiet" toggle .pressed=${this.scope === 'folder'} @click=${() => this.selectScope('folder')}>${this.projectId ? 'This project' : 'This chat'}</mux-ui-button><mux-ui-button size="small" variant="quiet" toggle .pressed=${this.scope === 'all'} @click=${() => this.selectScope('all')}>All work</mux-ui-button></div></div>
      <div class="filters" aria-label="Filter work">${(['open','all','done'] as const).map(filter => html`<mux-ui-button size="small" variant="quiet" toggle .pressed=${this.filter === filter} @click=${() => { this.filter=filter; }}>${filter === 'open' ? 'Open' : filter === 'all' ? 'All' : 'Finished'}</mux-ui-button>`)}</div>
      <div class="field-filters"><mux-ui-select size="small" aria-label="Filter by project" .value=${this.projectFilter} .options=${[{value:'',label:'All projects'},...projectIds.map(id => ({value:id,label:this.projectName(id)}))]} @change=${(event:Event) => this.selectProjectFilter((event.target as MuxUISelect).value)}></mux-ui-select><mux-ui-select size="small" aria-label="Filter by label" .value=${this.labelFilter} .options=${[{value:'',label:'All labels'},...labels.map(label => ({value:label,label}))]} @change=${(event:Event) => { this.labelFilter=(event.target as MuxUISelect).value; }}></mux-ui-select></div>
      <div class="queue-summary" aria-label="Queue overview">${queueLanes.filter(lane => lane.id !== 'finished' || this.filter !== 'open').map(lane => html`<span><strong>${counts.get(lane.id)}</strong> ${lane.title.toLowerCase()}</span>`)}</div>
      ${visible.length ? queueLanes.map(lane => {
        const items = visible.filter(item => this.queueLane(item) === lane.id);
        return items.length ? html`<section class="lane" aria-label=${lane.title}><div class="lane-heading"><h3>${lane.title}</h3><span>${items.length}</span></div><p class="lane-description">${lane.description}</p>${items.map(item => html`<div class="work-row"><mux-ui-button class="work-open" full-width variant="quiet" @click=${() => this.openDetail(item)}><strong>${item.title}</strong><span class="summary">${item.waitingOn?.length ? `Waiting on ${item.waitingOn.length} prerequisite${item.waitingOn.length === 1 ? '' : 's'}` : item.blockedReason || item.nextAction || item.progress || item.brief || 'No next action recorded'}</span></mux-ui-button><span class="status">${this.statusName(item.status)}</span><span class="meta">#${item.id.slice(0,8)} · ${this.ownerLabel(item)} · ${this.projectNames(item)}${item.labels?.length ? html` · ${item.labels.map(label => html`<span class="chip">${label}</span>`)}` : nothing}</span></div>`)}</section>` : nothing;
      }) : html`<div class="empty"><strong>${this.work.length ? 'No work in this view' : 'No work yet'}</strong>${this.work.length ? 'Choose another filter to see it.' : 'Ask a chat to record a work item to start the pile.'}</div>`}`;
  }
  private workDetail() {
    const item = this.detail;
    if (!item) return nothing;
    const updates = [...(item.updates || [])].reverse();
    const lane = this.queueLane(item);
    return html`<div class="detail-head"><mux-ui-button size="small" variant="quiet" @click=${() => { this.detail=undefined; }}>← Back to work</mux-ui-button><span class="meta">Revision ${item.revision}</span></div>
      <h2 class="detail-title">${item.title} <span class="detail-number">#${item.id.slice(0,8)}</span></h2>
      <div class="detail-subtitle"><span class="state-pill ${lane}">${queueLanes.find(candidate => candidate.id === lane)?.title}</span><span>Created by ${this.creatorLabel(item)}${item.createdAt ? html` on ${this.date(item.createdAt)}` : nothing}</span></div>
      <div class="detail-grid"><main class="detail-main"><section class="description"><h3>Description</h3><p>${item.brief || 'No description recorded.'}</p></section>
        ${item.acceptanceCriteria ? html`<section class="detail-section"><h3>Acceptance criteria</h3><p>${item.acceptanceCriteria}</p></section>` : nothing}
        ${item.status === 'blocked' ? html`<section class="detail-section blocker"><h3>Blocked</h3><p>${item.blockedReason || 'No reason recorded.'}</p></section>` : nothing}
        <section class="detail-section"><h3>Current state</h3><p><strong>Progress:</strong> ${item.progress || 'No progress recorded yet.'}</p><p><strong>Next action:</strong> ${item.nextAction || 'Not recorded yet.'}</p>${item.outcome ? html`<p><strong>Outcome:</strong> ${item.outcome}</p>` : nothing}</section>
        <section class="activity"><h3>Activity</h3>${updates.length ? updates.map(update => html`<div class="entry"><div class="meta">${this.actorLabel(update.actor, update.sessionId)} · ${this.date(update.at)}${update.status ? ` · ${this.statusName(update.status)}` : ''}</div><p>${update.text || update.progress || update.outcome || (update.ownerSessionId !== undefined ? html`Owner: ${update.ownerSessionId ? this.chatLink(update.ownerSessionId) : 'Unassigned'}` : update.reviewerSessionId !== undefined ? html`Reviewer: ${update.reviewerSessionId ? this.chatLink(update.reviewerSessionId) : 'Unassigned'}` : update.dependsOn !== undefined ? html`Dependencies: ${update.dependsOn.length ? this.dependencyLinks(update.dependsOn) : 'Cleared'}` : update.labels !== undefined ? `Labels: ${update.labels.length ? update.labels.join(', ') : 'Cleared'}` : update.nextAction !== undefined ? `Next action: ${update.nextAction || 'Cleared'}` : update.blockedReason ? update.blockedReason : update.linkedSessionId ? html`Linked ${this.chatLink(update.linkedSessionId)}` : update.status ? this.statusName(update.status) : 'Update recorded')}</p>${update.evidence?.length ? html`<p class="meta">Evidence: ${update.evidence.join(', ')}</p>` : nothing}</div>`) : html`<div class="empty">No activity yet.</div>`}</section></main>
        <aside class="detail-side" aria-label="Work details"><section class="side-section"><h3>Owner</h3><p>${this.ownerLabel(item)}</p></section><section class="side-section"><h3>Reviewer</h3><p>${item.reviewerSessionId ? this.chatLink(item.reviewerSessionId) : html`<span class="muted">Unassigned</span>`}</p></section>
          ${item.dispatch ? html`<section class="side-section"><h3>Kickoff</h3><p>${this.dispatchLabel(item)}</p>${item.dispatch.detail ? html`<p class="muted">${item.dispatch.detail}</p>` : nothing}</section>` : nothing}
          <section class="side-section"><h3>Project</h3><p>${this.projectNames(item)}</p></section><section class="side-section"><h3>Labels</h3><p>${item.labels?.length ? item.labels.map(label => html`<span class="chip">${label}</span>`) : html`<span class="muted">None</span>`}</p></section>
          <section class="side-section"><h3>Dependencies</h3><p>${item.dependsOn?.length ? this.dependencyLinks(item.dependsOn) : html`<span class="muted">None</span>`}</p>${item.waitingOn?.length ? html`<p class="muted">Still waiting on ${this.dependencyLinks(item.waitingOn)}</p>` : nothing}</section>
          ${item.sessionIds?.length ? html`<section class="side-section"><h3>Linked chats</h3><p>${item.sessionIds.map((id,index) => html`${index ? ', ' : ''}${this.chatLink(id)}`)}</p></section>` : nothing}
          <p class="meta">Updated ${this.date(item.updatedAt)}</p>
        </aside></div>`;
  }
  override render() {
    return html`<div class="wrap">${this.detail ? nothing : html`<header><h2>Work</h2><p class="intro">The work pile and current handoffs.</p></header>`}${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}${this.detail ? this.workDetail() : this.workList()}</div>`;
  }
}
