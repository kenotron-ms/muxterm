import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { sdkChats } from '../lib/sdk-chats.js';
import '../ui/button.js';

type WorkUpdate = { id:string; at:string; sessionId?:string; linkedSessionId?:string; text:string; status?:string; progress?:string; outcome?:string; evidence?:string[] };
type WorkItem = { id:string; title:string; brief:string; status:string; progress?:string; outcome?:string; ownerSessionId:string; sessionIds:string[]; updatedAt:string; updates?:WorkUpdate[] };

@customElement('mux-chat-coordination')
export class MuxChatCoordination extends LitElement {
  @property() sessionId = '';
  @property() remoteHost = '';
  @state() private work: WorkItem[] = [];
  @state() private detail?: WorkItem;
  @state() private filter: 'open' | 'all' | 'done' = 'open';
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
    .overview { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-4); margin:var(--ui-space-7) 0 var(--ui-space-5); }
    .overview p { color:var(--ui-text-muted); }
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
    .error { color:var(--ui-danger); margin:var(--ui-space-3) 0; }
    @media(max-width:550px) { .wrap { padding:var(--ui-space-5); } .issue::part(button) { padding-inline:0; } .issue .status { display:none; } }
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
    if (changed.has('sessionId') || changed.has('remoteHost')) {
      this.refreshKey++;
      this.work = [];
      this.detail = undefined;
      this.filter = 'open';
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
  private async refresh() {
    if (!this.sessionId || this.loading) return;
    const key = this.refreshKey;
    this.loading = true;
    try {
      const result = await this.request<{work:WorkItem[]}>('/api/sdk-work');
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
  private statusName(status: string) { return ({active:'In progress',open:'Open',blocked:'Blocked',done:'Done',cancelled:'Cancelled'} as Record<string,string>)[status] || status; }
  private sessionTitle(id:string) { return sdkChats.chats.find(chat => chat.id === id)?.title || id.slice(0,8); }

  private issueList() {
    const ordered = [...this.work].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    const openCount = ordered.filter(item => item.status !== 'done' && item.status !== 'cancelled').length;
    const visible = ordered.filter(item => this.filter === 'all' || (this.filter === 'done' ? item.status === 'done' || item.status === 'cancelled' : item.status !== 'done' && item.status !== 'cancelled'));
    return html`<div class="overview"><p>${openCount} open · ${this.work.length} total</p></div>
      <div class="filters" aria-label="Filter issues">${(['open','all','done'] as const).map(filter => html`<mux-ui-button class="filter" size="small" variant="quiet" toggle .pressed=${this.filter === filter} @click=${() => { this.filter=filter; }}>${filter === 'open' ? 'Open' : filter === 'all' ? 'All' : 'Done'}</mux-ui-button>`)}</div>
      ${visible.length ? html`<div class="list">${visible.map(item => html`<mux-ui-button class="issue" full-width variant="quiet" @click=${() => { this.detail=item; void this.refresh(); }}><span class="status-dot ${item.status}" aria-hidden="true"></span><span class="issue-main"><strong>${item.title}</strong><span class="summary">${item.progress || item.brief || 'No progress yet'}</span><span class="meta">${this.date(item.updatedAt)} · ${[item.ownerSessionId,...item.sessionIds].length} ${[item.ownerSessionId,...item.sessionIds].length === 1 ? 'chat' : 'chats'}</span></span><span class="status">${this.statusName(item.status)}</span></mux-ui-button>`)}</div>` : html`<div class="empty"><strong>${this.work.length ? 'No issues in this view' : 'No issues yet'}</strong>${this.work.length ? 'Choose another filter to see them.' : 'Issues will appear here as agents record shared work.'}</div>`}`;
  }
  private issueDetail() {
    const item = this.detail;
    if (!item) return nothing;
    const updates = [...(item.updates || [])].reverse();
    return html`<div class="detail-head"><mux-ui-button size="small" variant="quiet" @click=${() => { this.detail=undefined; }}>← All issues</mux-ui-button><span class="status">${this.statusName(item.status)}</span></div>
      <h2>${item.title}</h2><p class="detail-lead">${item.brief || 'No description yet.'}</p>
      <div class="progress"><strong>Current progress</strong><p>${item.progress || 'No progress recorded yet.'}</p>${item.outcome ? html`<p><strong>Outcome:</strong> ${item.outcome}</p>` : nothing}</div>
      <p class="meta">Updated ${this.date(item.updatedAt)} · ${[item.ownerSessionId,...item.sessionIds].map(id => this.sessionTitle(id)).join(', ')}</p>
      <section class="timeline"><h3>Activity</h3>${updates.length ? updates.map(update => html`<div class="entry"><div class="meta">${this.date(update.at)} · ${update.sessionId ? this.sessionTitle(update.sessionId) : 'User'}${update.status ? ` · ${this.statusName(update.status)}` : ''}</div><p>${update.text || update.progress || update.outcome || (update.linkedSessionId ? `Linked ${this.sessionTitle(update.linkedSessionId)}` : 'Update recorded')}</p>${update.evidence?.length ? html`<p class="meta">Evidence: ${update.evidence.join(', ')}</p>` : nothing}</div>`) : html`<div class="empty">No activity yet.</div>`}</section>`;
  }
  override render() {
    return html`<div class="wrap"><header><h2>Issues</h2><p class="intro">Shared work and its current status.</p></header>${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}${this.detail ? this.issueDetail() : this.issueList()}</div>`;
  }
}
