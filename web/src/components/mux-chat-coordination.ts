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
const queueLanes: {id:QueueLane; title:string}[] = [
  {id:'attention',title:'Needs attention'},
  {id:'review',title:'Ready for review'},
  {id:'active',title:'In progress'},
  {id:'dispatching',title:'Starting'},
  {id:'ready',title:'Ready to start'},
  {id:'waiting',title:'Waiting for other work'},
  {id:'finished',title:'Finished'},
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
  @state() private showFilters = false;
  @state() private error = '';
  private poll?: number;
  private loading = false;
  private refreshKey = 0;

  static styles = css`
    :host { display:block; height:100%; overflow:auto; box-sizing:border-box; container-type:inline-size; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-sm)/1.55 var(--ui-font-sans); }
    * { box-sizing:border-box; }
    .wrap { max-width:950px; margin:0 auto; padding:var(--ui-space-8); }
    h2,h3,p { margin:0; }
    h2 { font-size:var(--ui-text-xl); line-height:1.2; letter-spacing:-.025em; }
    h3 { font-size:var(--ui-text-md); }
    .meta,.muted { color:var(--ui-text-muted); }
    .overview { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--ui-space-2); margin:var(--ui-space-8) 0 var(--ui-space-5); }
    .overview .meta { font-size:var(--ui-text-sm); }
    .filters { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); }
    .filter-toggle { margin-left:auto; }
    .filter-panel { padding:var(--ui-space-4); margin-top:var(--ui-space-3); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); }
    .filter-panel .filters { margin-bottom:var(--ui-space-3); }
    .field-filters { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); }
    .field-filters mux-ui-select { flex:1 1 170px; min-width:0; }
    .lane { margin-top:var(--ui-space-9); }
    .lane-heading { display:flex; align-items:center; gap:var(--ui-space-2); margin-bottom:var(--ui-space-5); }
    .lane-heading h3 { flex:1; }
    .lane-heading .count { color:var(--ui-text-muted); font-size:var(--ui-text-xs); font-variant-numeric:tabular-nums; }
    .lane-mark { display:inline-grid; place-items:center; width:25px; height:25px; flex:none; border-radius:var(--ui-radius-md); background:color-mix(in srgb,var(--ui-accent) 16%,var(--ui-surface-raised)); color:var(--ui-accent); font-weight:700; }
    .lane-mark.attention { background:color-mix(in srgb,var(--ui-danger) 13%,var(--ui-surface-raised)); color:var(--ui-danger); }
    .lane-mark.review,.lane-mark.waiting { background:color-mix(in srgb,var(--ui-warning) 14%,var(--ui-surface-raised)); color:var(--ui-warning); }
    .lane-mark.finished { background:color-mix(in srgb,var(--ui-success) 14%,var(--ui-surface-raised)); color:var(--ui-success); }
    .work-row { margin-bottom:var(--ui-space-5); }
    .work-open { display:block; width:100%; }
    .work-open::part(button) { display:block; width:100%; min-width:0; padding:var(--ui-space-6) var(--ui-space-7); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); color:var(--ui-text); text-align:left; white-space:normal; font:inherit; }
    .work-open:hover::part(button) { border-color:var(--ui-accent); background:var(--ui-surface-hover); }
    .work-open strong { display:block; font-size:var(--ui-text-md); line-height:1.35; font-weight:650; overflow-wrap:anywhere; }
    .summary { display:block; margin-top:var(--ui-space-1); color:var(--ui-text-muted); overflow-wrap:anywhere; }
    .row-foot { display:flex; flex-wrap:wrap; align-items:center; gap:var(--ui-space-2); margin-top:var(--ui-space-3); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .meta { font-size:var(--ui-text-xs); overflow-wrap:anywhere; }
    .chat-link,.work-link { color:var(--ui-accent); text-decoration:underline; text-underline-offset:2px; }
    .chat-link:hover,.work-link:hover { color:var(--ui-text); }
    .empty { padding:var(--ui-space-8) var(--ui-space-5); border:1px dashed var(--ui-border-strong); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); color:var(--ui-text-muted); }
    .empty strong { display:block; margin-bottom:var(--ui-space-2); color:var(--ui-text); font-size:var(--ui-text-md); }
    .detail-head { margin-bottom:var(--ui-space-6); }
    .detail-title { font-size:clamp(1.5rem,4cqw,2rem); line-height:1.2; overflow-wrap:anywhere; }
    .detail-intro { margin-top:var(--ui-space-3); color:var(--ui-text-muted); font-size:var(--ui-text-md); white-space:pre-wrap; overflow-wrap:anywhere; }
    .detail-subtitle { display:flex; flex-wrap:wrap; align-items:center; gap:var(--ui-space-2); margin-bottom:var(--ui-space-4); }
    .state-pill { display:inline-flex; align-items:center; border:1px solid var(--ui-border-strong); border-radius:999px; padding:1px var(--ui-space-3); color:var(--ui-text); font-size:var(--ui-text-xs); font-weight:650; }
    .state-pill.attention { border-color:var(--ui-danger); color:var(--ui-danger); }
    .state-pill.active,.state-pill.ready { border-color:var(--ui-accent); color:var(--ui-accent); }
    .detail-grid { display:grid; grid-template-columns:1fr; gap:var(--ui-space-5); align-items:start; margin-top:var(--ui-space-6); }
    .detail-main { min-width:0; }
    .situation { padding:0 0 var(--ui-space-7); border-bottom:1px solid var(--ui-border); }
    .situation h3 { margin-bottom:var(--ui-space-3); color:var(--ui-accent); }
    .situation.attention h3 { color:var(--ui-danger); }
    .situation.waiting h3,.situation.review h3 { color:var(--ui-warning); }
    .situation p + p { margin-top:var(--ui-space-3); }
    .detail-section { padding-bottom:var(--ui-space-5); margin-bottom:var(--ui-space-5); border-bottom:1px solid var(--ui-border); }
    .detail-section p { margin-top:var(--ui-space-2); white-space:pre-wrap; overflow-wrap:anywhere; }
    .detail-section h3,.side-section h3 { font-size:var(--ui-text-sm); font-weight:650; }
    .detail-side { min-width:0; }
    .side-section { padding-bottom:var(--ui-space-3); margin-bottom:var(--ui-space-3); border-bottom:1px solid var(--ui-border); }
    .side-section p { margin-top:var(--ui-space-1); overflow-wrap:anywhere; }
    .chip { display:inline-block; border:1px solid var(--ui-border-strong); border-radius:999px; padding:0 var(--ui-space-2); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .activity { margin-top:var(--ui-space-6); }
    .activity h3 { padding-bottom:var(--ui-space-3); border-bottom:1px solid var(--ui-border-strong); }
    .entry { border-bottom:1px solid var(--ui-border); padding:var(--ui-space-4) 0; }
    .entry p { margin-top:var(--ui-space-2); white-space:pre-wrap; overflow-wrap:anywhere; }
    .more-details { margin-top:var(--ui-space-6); padding-top:var(--ui-space-3); border-top:1px solid var(--ui-border); }
    .more-details summary { color:var(--ui-text-muted); cursor:pointer; }
    .more-details summary:hover { color:var(--ui-text); }
    .more-details dl { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:var(--ui-space-2) var(--ui-space-4); margin:var(--ui-space-4) 0 0; font-size:var(--ui-text-xs); overflow-wrap:anywhere; }
    .more-details dt { color:var(--ui-text-muted); }
    .more-details dd { margin:0; min-width:0; }
    .error { color:var(--ui-danger); margin:var(--ui-space-3) 0; }
    @container (min-width:760px) { .detail-grid { grid-template-columns:minmax(0,1fr) 220px; gap:var(--ui-space-8); } }
    @container (max-width:430px) { .wrap { padding:var(--ui-space-7); } .work-open::part(button) { padding:var(--ui-space-6); } }
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
      this.showFilters = false;
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
    this.scrollTop = 0;
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
  private actorLabel(actor?:WorkActor, legacySessionId?:string) { return actor?.kind === 'chat' && actor.sessionId ? this.chatLink(actor.sessionId) : actor?.kind === 'human' ? 'Browser' : actor?.kind === 'external-tool' ? 'External tool' : legacySessionId ? this.chatLink(legacySessionId) : 'Unknown'; }
  private creatorLabel(item:WorkItem) { return item.createdBy?.kind === 'human' ? 'Added from the browser' : this.actorLabel(item.createdBy); }
  private dispatchLabel(item:WorkItem) { const dispatch=item.dispatch; return dispatch ? html`${dispatch.state === 'failed' ? 'Failed kickoff for' : dispatch.state === 'preparing' ? 'Preparing' : dispatch.state === 'claimed' ? 'Claimed by' : dispatch.state === 'uncertain' ? 'Check' : 'Sent to'} ${this.chatLink(dispatch.sessionId)}` : nothing; }
  private dependencyLabel(id:string) { return this.work.find(item => item.id === id)?.title || id.slice(0,8); }
  private async openDependency(id:string) {
    const item = this.work.find(candidate => candidate.id === id);
    if (item) { this.openDetail(item); return; }
    try { this.detail = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(id)}`); this.scrollTop = 0; }
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
  private queueHint(item:WorkItem) {
    if (item.waitingOn?.length) return `Waiting for ${item.waitingOn.map(id => this.dependencyLabel(id)).join(', ')}`;
    if (item.blockedReason) return item.blockedReason;
    if (item.dispatch?.state === 'failed' || item.dispatch?.state === 'uncertain') return item.dispatch.detail || 'The start needs checking.';
    if (item.progress) return item.progress;
    if (item.nextAction) return `Next: ${item.nextAction}`;
    return item.brief || 'No details yet.';
  }
  private clearFilters() {
    if (this.scope !== 'all') this.selectScope('all');
    this.projectFilter = '';
    this.labelFilter = '';
    this.filter = 'open';
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
    const needsLook = narrowed.filter(item => ['attention','review'].includes(this.queueLane(item))).length;
    const filtersApplied = this.scope !== 'all' || !!this.projectFilter || !!this.labelFilter;
    return html`<div class="overview"><p class="meta">${needsLook ? html`<strong>${needsLook}</strong> ${needsLook === 1 ? 'thing needs a look' : 'things need a look'}` : html`${narrowed.length} ${narrowed.length === 1 ? 'item' : 'items'} in the pile`}</p></div>
      <div class="filters" aria-label="Filter work">${(['open','all','done'] as const).map(filter => html`<mux-ui-button size="small" variant="quiet" toggle .pressed=${this.filter === filter} @click=${() => { this.filter=filter; }}>${filter === 'open' ? 'Open' : filter === 'all' ? 'All' : 'Finished'}</mux-ui-button>`)}<mux-ui-button class="filter-toggle" size="small" variant="quiet" toggle .pressed=${this.showFilters} @click=${() => { this.showFilters = !this.showFilters; }}>Filters${filtersApplied ? ' •' : ''}</mux-ui-button></div>
      ${this.showFilters ? html`<div class="filter-panel"><div class="filters" aria-label="Work scope"><mux-ui-button size="small" variant="quiet" toggle .pressed=${this.scope === 'all'} @click=${() => this.selectScope('all')}>All work</mux-ui-button><mux-ui-button size="small" variant="quiet" toggle .pressed=${this.scope === 'folder'} @click=${() => this.selectScope('folder')}>${this.projectId ? 'This project' : 'This chat'}</mux-ui-button></div><div class="field-filters"><mux-ui-select size="small" aria-label="Filter by project" .value=${this.projectFilter} .options=${[{value:'',label:'All projects'},...projectIds.map(id => ({value:id,label:this.projectName(id)}))]} @change=${(event:Event) => this.selectProjectFilter((event.target as MuxUISelect).value)}></mux-ui-select><mux-ui-select size="small" aria-label="Filter by label" .value=${this.labelFilter} .options=${[{value:'',label:'All labels'},...labels.map(label => ({value:label,label}))]} @change=${(event:Event) => { this.labelFilter=(event.target as MuxUISelect).value; }}></mux-ui-select></div>${filtersApplied ? html`<mux-ui-button size="small" variant="quiet" @click=${this.clearFilters}>Clear filters</mux-ui-button>` : nothing}</div>` : nothing}
      ${visible.length ? queueLanes.map(lane => {
        const items = visible.filter(item => this.queueLane(item) === lane.id);
        const mark = ({attention:'!',review:'✓',active:'↗',dispatching:'↗',ready:'○',waiting:'…',finished:'✓'} as Record<QueueLane,string>)[lane.id];
        return items.length ? html`<section class="lane" aria-label=${lane.title}><div class="lane-heading"><span class="lane-mark ${lane.id}" aria-hidden="true">${mark}</span><h3>${lane.title}</h3><span class="count">${items.length}</span></div>${items.map(item => html`<div class="work-row"><mux-ui-button class="work-open" full-width variant="quiet" @click=${() => this.openDetail(item)}><strong>${item.title}</strong><span class="summary">${this.queueHint(item)}</span>${item.ownerSessionId || item.projectIds?.length || item.labels?.length ? html`<span class="row-foot">${item.ownerSessionId ? html`<span>${this.sessionTitle(item.ownerSessionId)}</span>` : nothing}${item.projectIds?.map(id => html`<span>${this.projectName(id)}</span>`)}${item.labels?.slice(0,2).map(label => html`<span class="chip">${label}</span>`)}</span>` : nothing}</mux-ui-button></div>`)}</section>` : nothing;
      }) : html`<div class="empty"><strong>${this.work.length ? 'Nothing here with these filters.' : 'A little room for what’s next.'}</strong><p>${this.work.length ? 'Try another view or clear the filters.' : 'Ask a chat to add something to Work.'}</p>${this.work.length ? html`<mux-ui-button size="small" variant="quiet" @click=${this.clearFilters}>Clear filters</mux-ui-button>` : nothing}</div>`}`;
  }
  private workDetail() {
    const item = this.detail;
    if (!item) return nothing;
    const updates = [...(item.updates || [])].reverse();
    const lane = this.queueLane(item);
    const dispatchNeedsCheck = item.dispatch?.state === 'failed' || item.dispatch?.state === 'uncertain';
    const situationTitle = item.status === 'blocked' || dispatchNeedsCheck ? 'Needs attention' : item.waitingOn?.length ? 'Waiting for' : item.status === 'done' ? 'Result' : item.status === 'review' ? 'Ready for review' : item.progress ? 'Latest progress' : item.status === 'open' && !item.ownerSessionId ? 'Ready for a chat to pick up' : 'What’s happening';
    return html`<div class="detail-head"><mux-ui-button size="small" variant="quiet" @click=${() => { this.detail=undefined; this.scrollTop=0; }}>← All work</mux-ui-button></div>
      <div class="detail-subtitle"><span class="state-pill ${lane}">${queueLanes.find(candidate => candidate.id === lane)?.title}</span></div>
      <h2 class="detail-title">${item.title}</h2>
      ${item.brief ? html`<p class="detail-intro">${item.brief}</p>` : nothing}
      <div class="detail-grid"><main class="detail-main"><section class="situation ${lane}"><h3>${situationTitle}</h3>
        ${item.status === 'blocked' ? html`<p>${item.blockedReason || 'This work is blocked; no reason has been added yet.'}</p>` : dispatchNeedsCheck ? html`<p>${item.dispatch?.detail || 'The start needs checking.'}</p>` : item.waitingOn?.length ? html`<p>${this.dependencyLinks(item.waitingOn)}</p>` : item.status === 'done' && item.outcome ? html`<p>${item.outcome}</p>` : item.progress ? html`<p>${item.progress}</p>` : item.status === 'review' ? html`<p>The work is ready for someone to review.</p>` : item.status === 'open' && !item.ownerSessionId ? html`<p>No chat is working on this yet.</p>` : html`<p>No updates yet.</p>`}
        ${item.nextAction ? html`<p><strong>Next:</strong> ${item.nextAction}</p>` : nothing}</section>
        ${item.acceptanceCriteria ? html`<section class="detail-section" style="margin-top:var(--ui-space-6)"><h3>What done looks like</h3><p>${item.acceptanceCriteria}</p></section>` : nothing}
      </main><aside class="detail-side" aria-label="Work context">
          ${item.ownerSessionId ? html`<section class="side-section"><h3>Working on it</h3><p>${this.chatLink(item.ownerSessionId)}</p></section>` : nothing}
          ${item.reviewerSessionId ? html`<section class="side-section"><h3>Reviewing</h3><p>${this.chatLink(item.reviewerSessionId)}</p></section>` : nothing}
          ${item.dispatch ? html`<section class="side-section"><h3>Start</h3><p>${this.dispatchLabel(item)}</p></section>` : nothing}
          ${item.projectIds?.length ? html`<section class="side-section"><h3>Project</h3><p>${this.projectNames(item)}</p></section>` : nothing}
          ${item.labels?.length ? html`<section class="side-section"><h3>Labels</h3><p>${item.labels.map(label => html`<span class="chip">${label}</span>`)}</p></section>` : nothing}
          ${item.dependsOn?.length ? html`<section class="side-section"><h3>Related work</h3><p>${this.dependencyLinks(item.dependsOn)}</p></section>` : nothing}
        </aside></div>
      <section class="activity"><h3>Updates</h3>${updates.length ? updates.map(update => html`<div class="entry"><div class="meta">${this.actorLabel(update.actor, update.sessionId)} · ${this.date(update.at)}${update.status ? ` · ${this.statusName(update.status)}` : ''}</div><p>${update.text || update.progress || update.outcome || (update.ownerSessionId !== undefined ? html`Working on it: ${update.ownerSessionId ? this.chatLink(update.ownerSessionId) : 'No chat assigned'}` : update.reviewerSessionId !== undefined ? html`Reviewing: ${update.reviewerSessionId ? this.chatLink(update.reviewerSessionId) : 'No reviewer assigned'}` : update.dependsOn !== undefined ? html`Related work: ${update.dependsOn.length ? this.dependencyLinks(update.dependsOn) : 'Cleared'}` : update.labels !== undefined ? `Labels: ${update.labels.length ? update.labels.join(', ') : 'Cleared'}` : update.nextAction !== undefined ? `Next: ${update.nextAction || 'Cleared'}` : update.blockedReason ? update.blockedReason : update.linkedSessionId ? html`Linked ${this.chatLink(update.linkedSessionId)}` : update.status ? this.statusName(update.status) : 'Update recorded')}</p>${update.evidence?.length ? html`<p class="meta">Evidence: ${update.evidence.join(', ')}</p>` : nothing}</div>`) : html`<p class="muted" style="margin-top:var(--ui-space-4)">No updates yet.</p>`}</section>
      <details class="more-details"><summary>More details</summary><dl><dt>Work ID</dt><dd>${item.id}</dd><dt>Revision</dt><dd>${item.revision}</dd><dt>Added by</dt><dd>${this.creatorLabel(item)}</dd><dt>Added</dt><dd>${this.date(item.createdAt)}</dd><dt>Last updated</dt><dd>${this.date(item.updatedAt)}</dd>${item.sessionIds?.length ? html`<dt>Linked chats</dt><dd>${item.sessionIds.map((id,index) => html`${index ? ', ' : ''}${this.chatLink(id)}`)}</dd>` : nothing}</dl></details>`;
  }
  override render() {
    return html`<div class="wrap">${this.detail ? nothing : html`<header><h2>Work</h2></header>`}${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}${this.detail ? this.workDetail() : this.workList()}</div>`;
  }
}
