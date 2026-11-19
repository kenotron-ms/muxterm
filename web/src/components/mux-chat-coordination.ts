import { LitElement, css, html, nothing, svg, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { sdkChats } from '../lib/sdk-chats.js';
import { parseMarkdown } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import '../ui/button.js';
import '../ui/range-field.js';
import '../ui/select.js';
import './work-goal-review.js';
import type { MuxUIRangeField } from '../ui/range-field.js';
import type { MuxUISelect } from '../ui/select.js';

type WorkActor = { kind: 'chat' | 'human' | 'external-tool'; sessionId?: string };
type WorkDispatch = { clientRef: string; sessionId: string; state: string; detail?: string };
type WorkUpdate = { id: string; at: string; actor?: WorkActor; sessionId?: string; linkedSessionId?: string; summary?: string; text: string; title?: string; brief?: string; acceptanceCriteria?: string; goalCondition?: string; goalApproved?: boolean; status?: string; readiness?: string; progress?: string; nextAction?: string; outcome?: string; evidence?: string[]; ownerSessionId?: string; blockedReason?: string; needsHuman?: boolean };
type WorkItem = { id: string; title: string; brief: string; source?: string; status: string; readiness?: string; heldByHuman?: boolean; needsHuman?: boolean; progress?: string; nextAction?: string; outcome?: string; createdBy: WorkActor; ownerSessionId: string; reviewerSessionId?: string; acceptanceCriteria?: string; goalCondition?: string; goalRevision?: number; goalApprovedRevision?: number; blockedReason?: string; dependsOn: string[]; waitingOn: string[]; labels: string[]; dispatch?: WorkDispatch; revision: number; sessionIds: string[]; projectIds: string[]; updatedAt: string; createdAt: string; updates?: WorkUpdate[] };
type WorkControl = { projectId: string; paused: boolean; parallelism: number; version: number; active: number };

function activityPreview(value: string): string {
  const plain = value.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(^|\n)\s*(?:#{1,6}\s+|[-*]\s+)/g, '$1')
    .replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim();
  const end = plain.search(/[.!?](?=\s|$)/);
  const sentence = end >= 0 && end < 160 ? plain.slice(0, end + 1) : plain;
  const characters = [...sentence];
  if (characters.length <= 160) return sentence;
  return characters.slice(0, 157).join('').replace(/\s+\S*$/, '').trimEnd() + '…';
}

const icon = (name: 'work' | 'folder' | 'play' | 'pause' | 'chevron' | 'back' | 'clock' | 'check' | 'chat' | 'wait' | 'alert' | 'flag') => {
  const paths = {
    work: svg`<path d="M13 5h8M13 12h8M13 19h8m-18-2 2 2 4-4"/><rect x="3" y="4" width="6" height="6" rx="1"/>`,
    folder: svg`<path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"/>`,
    play: svg`<path d="M6 4.5a1 1 0 0 1 1.5-.86l12 7a1.6 1.6 0 0 1 0 2.72l-12 7A1 1 0 0 1 6 19.5z"/>`,
    pause: svg`<rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/>`,
    chevron: svg`<path d="m6 9 6 6 6-6"/>`,
    back: svg`<path d="m15 18-6-6 6-6"/>`,
    clock: svg`<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
    check: svg`<path d="m4 12 5 5L20 6"/>`,
    chat: svg`<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3a8.5 8.5 0 0 1 8.5 8.5z"/>`,
    wait: svg`<path d="M7 4h10M7 20h10M8 4c0 4 4 4 4 8s-4 4-4 8m8-16c0 4-4 4-4 8s4 4 4 8"/>`,
    alert: svg`<path d="m10.3 3.9-8.1 14a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3l-8.1-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>`,
    flag: svg`<path d="M5 21V4m0 1c5-3 9 3 14 0v11c-5 3-9-3-14 0"/>`,
  };
  return html`<svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};

@customElement('mux-chat-coordination')
export class MuxChatCoordination extends LitElement {
  @property() sessionId = '';
  @property() projectId = '';
  @property() remoteHost = '';
  @state() private work: WorkItem[] = [];
  @state() private detail?: WorkItem;
  @state() private control?: WorkControl;
  @state() private filter: 'open' | 'all' | 'finished' = 'open';
  @state() private labelFilter = '';
  @state() private collapsed: Record<string, boolean> = {};
  @state() private error = '';
  private poll?: number;
  private loading = false;
  private refreshKey = 0;

  static styles = css`
    :host { display:block; height:100%; overflow:auto; box-sizing:border-box; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-lg)/1.55 var(--ui-font-sans); }
    * { box-sizing:border-box; }

    .wrap { max-width:var(--ui-chat-content-width); margin:0 auto; padding:var(--ui-space-9) var(--ui-space-9) var(--ui-space-13); }
    .detail-view { max-width:var(--ui-work-detail-width); }
    h2,h3,p { margin:0; }
    h2 { font-size:var(--ui-text-3xl); line-height:1.15; letter-spacing:-.035em; }
    h3 { font-size:var(--ui-text-md); line-height:1.35; }
    .top { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--ui-space-7); }
    .project { display:flex; align-items:center; gap:var(--ui-space-4); margin-top:var(--ui-space-4); color:var(--ui-text-muted); font-size:var(--ui-text-md); }
    .icon { flex:none; }
    .top .icon { color:var(--ui-accent); }
    .controls { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--ui-space-6); margin:var(--ui-space-7) 0 var(--ui-space-8); }
    .controls-main { display:flex; align-items:center; gap:var(--ui-space-5); }
    .play { flex:none; }
    .active-count { color:var(--ui-text-muted); font-size:var(--ui-text-md); }
    .parallel { display:flex; align-items:center; color:var(--ui-text-muted); }
    .parallel mux-ui-range-field { width:var(--ui-work-parallel-width); }

    .filters { display:flex; align-items:center; gap:var(--ui-space-7); margin:var(--ui-space-7) 0 0; color:var(--ui-text-muted); font-size:var(--ui-text-md); }
    .filter::part(button) { padding-inline:var(--ui-space-3); }
    .filter[selected] { color:var(--ui-text); font-weight:700; }
    .label-filter { margin-left:auto; max-width:var(--ui-work-filter-width); }
    .attention { padding:var(--ui-space-8); margin:var(--ui-space-7) 0 var(--ui-space-9); border-radius:var(--ui-radius-xl); background:color-mix(in srgb, var(--ui-warning) 11%, var(--ui-surface-raised)); }
    .attention-item + .attention-item { margin-top:var(--ui-space-7); }
    .attention .kind { display:flex; align-items:center; gap:var(--ui-space-4); color:var(--ui-warning); font-size:var(--ui-text-md); font-weight:700; }
    .attention .kind.review { color:var(--ui-accent); }
    .attention .kind.blocked { color:var(--ui-danger); }
    .attention mux-ui-button::part(button),.row mux-ui-button::part(button) { justify-content:flex-start; padding:0; min-height:0; white-space:normal; text-align:left; }
    .attention mux-ui-button:hover,.row mux-ui-button:hover { color:var(--ui-accent); }
    .attention h3 { margin-top:var(--ui-space-3); font-size:var(--ui-text-lg); }
    .attention p,.row p { margin-top:var(--ui-space-2); color:var(--ui-text-muted); font-size:var(--ui-text-md); overflow-wrap:anywhere; }
    .group { margin-top:var(--ui-space-8); }
    .group-head { display:block; width:100%; }
    .group-head::part(button) { display:flex; justify-content:flex-start; gap:var(--ui-space-4); min-height:0; padding:0; white-space:normal; font-size:var(--ui-text-lg); font-weight:700; }
    .group-head .count { margin-left:auto; color:var(--ui-text-muted); font-size:var(--ui-text-xs); font-weight:500; }
    .group-head .chevron { color:var(--ui-text-muted); transform:rotate(0); transition:transform .15s ease; }
    .group-head:not([expanded]) .chevron { transform:rotate(-90deg); }
    .group-body { padding-top:var(--ui-space-3); }
    .row { padding:var(--ui-space-5) var(--ui-space-4) var(--ui-space-5) var(--ui-space-8); border-radius:var(--ui-radius-lg); }
    .row:hover { background:var(--ui-surface-hover); }
    .row .kind { display:flex; align-items:center; gap:var(--ui-space-3); color:var(--ui-text-muted); font-size:var(--ui-text-md); font-weight:650; }
    .row .kind.working { color:var(--ui-accent); }
    .row .kind.waiting { color:var(--ui-warning); }
    .row .kind.blocked { color:var(--ui-danger); }
    .row .kind.ready { color:var(--ui-success); }
    .row strong { display:block; margin-top:var(--ui-space-2); font-size:var(--ui-text-lg); font-weight:650; }
    .row .meta { margin-top:var(--ui-space-2); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .empty { padding:var(--ui-space-8) 0; color:var(--ui-text-muted); }
    .empty strong { display:block; color:var(--ui-text); }
    .back { display:block; width:max-content; margin-bottom:var(--ui-space-7); color:var(--ui-text); }
    .back:hover { color:var(--ui-accent); }
    .detail-project { margin:0 0 var(--ui-space-8); }
    .status { display:flex; align-items:center; gap:var(--ui-space-3); width:max-content; margin-bottom:var(--ui-space-4); color:var(--ui-accent); font-size:var(--ui-text-md); font-weight:700; }
    .status.waiting { color:var(--ui-warning); }
    .status.blocked { color:var(--ui-danger); }
    .status.done { color:var(--ui-success); }
    .lead { margin-top:var(--ui-space-4); color:var(--ui-text-muted); font-size:var(--ui-text-lg); line-height:1.62; white-space:pre-wrap; overflow-wrap:anywhere; }
    .next { margin-top:var(--ui-space-9); padding:var(--ui-space-7) var(--ui-space-8); border-radius:var(--ui-radius-xl); background:color-mix(in srgb,var(--ui-accent) 9%,var(--ui-surface-raised)); }
    .next h3 { color:var(--ui-accent); }
    .next.blocked { background:color-mix(in srgb,var(--ui-danger) 8%,var(--ui-surface-raised)); }
    .next.blocked h3 { color:var(--ui-danger); }
    .next p { margin-top:var(--ui-space-4); font-size:var(--ui-text-lg); white-space:pre-wrap; overflow-wrap:anywhere; }
    mux-work-goal-review { margin-top:var(--ui-space-9); }
    .section { margin-top:var(--ui-space-9); }
    .section h3 { margin-bottom:var(--ui-space-4); }
    .section p { color:var(--ui-text-muted); white-space:pre-wrap; overflow-wrap:anywhere; }
    .facts { display:flex; flex-wrap:wrap; gap:var(--ui-space-5) var(--ui-space-7); margin-top:var(--ui-space-9); color:var(--ui-text-muted); font-size:var(--ui-text-md); }
    .facts span { display:inline-flex; align-items:center; gap:var(--ui-space-2); }
    .facts .icon { width:var(--ui-icon-sm); height:var(--ui-icon-sm); }
    a { color:var(--ui-accent); text-decoration:underline; text-underline-offset:var(--ui-space-2); }
    .tags { display:flex; flex-wrap:wrap; gap:var(--ui-space-4); margin-top:var(--ui-space-4); }
    .tag { display:inline-flex; border-radius:var(--ui-radius-md); padding:var(--ui-space-2) var(--ui-space-5); background:var(--ui-surface-raised); color:var(--ui-text); font-size:var(--ui-text-md); font-weight:600; }
    .timeline { position:relative; list-style:none; margin:var(--ui-space-6) 0 0; padding:0; }
    .timeline:before { content:''; position:absolute; left:var(--ui-space-5); top:var(--ui-space-6); bottom:var(--ui-space-8); width:var(--ui-space-px); background:var(--ui-border); }
    .timeline > li { position:relative; display:grid; grid-template-columns:var(--ui-space-8) minmax(0,1fr); gap:var(--ui-space-5); padding:0 0 var(--ui-space-7); }
    .timeline-icon { display:grid; place-items:center; width:var(--ui-space-8); height:var(--ui-space-8); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); color:var(--ui-accent); }
    .timeline-icon .icon { width:var(--ui-space-6); height:var(--ui-space-6); }
    .timeline time { color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .timeline > li > div > strong { display:block; margin-top:var(--ui-space-1); font-weight:650; }
    .timeline p { margin-top:var(--ui-space-2); color:var(--ui-text-muted); overflow-wrap:anywhere; }
    .activity-summary { max-width:65ch; line-height:1.5; }
    .activity-full { margin-top:var(--ui-space-2); }
    .activity-full > summary { width:max-content; max-width:100%; color:var(--ui-accent); font-size:var(--ui-text-md); font-weight:600; cursor:pointer; }
    .activity-full > summary:hover { text-decoration:underline; text-underline-offset:var(--ui-space-2); }
    .activity-markdown { max-width:70ch; margin-top:var(--ui-space-3); color:var(--ui-text-muted); overflow-wrap:anywhere; }
    .activity-markdown > :first-child { margin-top:0; }
    .activity-markdown .md-p { margin:var(--ui-space-3) 0 0; white-space:normal; }
    .activity-markdown .md-ul,.activity-markdown .md-ol { margin:var(--ui-space-3) 0; padding-left:var(--ui-space-7); }
    .activity-markdown .md-li + .md-li { margin-top:var(--ui-space-2); }
    .activity-markdown .md-li .md-p { margin:0; }
    .activity-markdown .md-code { padding:var(--ui-space-px) var(--ui-space-2); border-radius:var(--ui-radius-sm); background:var(--ui-surface-raised); color:var(--ui-text); font:var(--ui-text-md) var(--ui-font-mono); }
    .activity-markdown .md-pre { max-width:100%; padding:var(--ui-space-4); overflow:auto; border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); font:var(--ui-text-md) var(--ui-font-mono); }
    .activity-markdown .md-quote { margin:var(--ui-space-3) 0; padding-left:var(--ui-space-4); border-left:var(--ui-space-px) solid var(--ui-border); }
    .activity-markdown .md-tablewrap { max-width:100%; overflow:auto; }
    .activity-markdown .md-table { border-collapse:collapse; }
    .activity-markdown .md-th,.activity-markdown .md-td { padding:var(--ui-space-2) var(--ui-space-3); border-bottom:var(--ui-space-px) solid var(--ui-border); text-align:left; }
    .activity-markdown .md-h { margin:var(--ui-space-4) 0 var(--ui-space-2); font-size:var(--ui-text-lg); }
    .activity-evidence { margin-top:var(--ui-space-3); font-size:var(--ui-text-md); }
    .error { margin:var(--ui-space-5) 0; color:var(--ui-danger); }
    :focus-visible { outline:var(--ui-space-1) solid var(--ui-accent); outline-offset:var(--ui-space-2); }
    @media(max-width:560px) { .wrap { padding:var(--ui-space-8) var(--ui-space-7) var(--ui-control-lg); } .controls { align-items:flex-start; } .parallel { width:100%; justify-content:flex-start; } .parallel mux-ui-range-field { width:100%; } .label-filter { max-width:var(--ui-work-filter-width); } }
    @media(prefers-reduced-motion:reduce) { .group-head .chevron { transition:none; } }
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
      this.loading = false;
      this.work = [];
      this.detail = undefined;
      this.control = undefined;
      this.labelFilter = '';
      void this.refresh();
    }
  }
  private path(path: string) { return apiPath(remoteChatPath(this.remoteHost, path)); }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.path(path), { cache: 'no-store', ...init });
    if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
    return await response.json() as T;
  }
  private async refresh() {
    if (this.loading || (!this.projectId && !this.detail)) return;
    const key = this.refreshKey;
    this.loading = true;
    try {
      if (!this.projectId) {
        const selected = this.detail;
        if (!selected) return;
        const detail = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(selected.id)}`);
        if (key !== this.refreshKey || this.detail?.id !== detail.id) return;
        this.detail = detail;
      } else {
        const [items, control] = await Promise.all([
          this.request<{work: WorkItem[]}>(`/api/sdk-work?project_id=${encodeURIComponent(this.projectId)}`),
          this.request<WorkControl>(`/api/sdk-projects/${encodeURIComponent(this.projectId)}/work-control`),
        ]);
        if (key !== this.refreshKey) return;
        this.work = items.work;
        this.control = control;
        if (this.detail) {
          const detail = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(this.detail.id)}`);
          if (key !== this.refreshKey) return;
          this.detail = detail;
        }
      }
      this.error = '';
    } catch (error) { if (key === this.refreshKey) this.error = String(error); }
    finally { if (key === this.refreshKey) this.loading = false; }
  }
  private async changeControl(changes: {paused?: boolean; parallelism?: number}) {
    if (!this.projectId || !this.control) return;
    try {
      this.control = await this.request<WorkControl>(`/api/sdk-projects/${encodeURIComponent(this.projectId)}/work-control`, { method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...changes, expectedVersion: this.control.version}) });
      this.error = '';
    } catch (error) { this.error = String(error); void this.refresh(); }
  }
  private projectName() { return sdkChats.projects.find(project => project.id === this.projectId && (project.remoteHost || '') === this.remoteHost)?.name || 'This project'; }
  private sessionTitle(id: string) { return sdkChats.chats.find(chat => chat.id === id && (chat.remoteHost || '') === this.remoteHost)?.title || id.slice(0, 8); }
  private chatLink(id: string) { return html`<a href=${`#chat=${encodeURIComponent(id)}${this.remoteHost ? `&host=${encodeURIComponent(this.remoteHost)}` : ''}`} title=${`Open ${this.sessionTitle(id)}`}>${this.sessionTitle(id)}</a>`; }
  private actor(actor?: WorkActor) { return actor?.kind === 'chat' && actor.sessionId ? this.chatLink(actor.sessionId) : actor?.kind === 'human' ? 'You' : 'Muxterm'; }
  private date(value: string) { return new Date(value).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'}); }
  private attention(item: WorkItem) { return (item.status === 'review' && !item.reviewerSessionId) || (item.status === 'blocked' && !!item.needsHuman) || (item.status === 'open' && !!item.goalCondition && item.goalApprovedRevision !== item.goalRevision) || item.dispatch?.state === 'uncertain' || item.dispatch?.state === 'failed'; }
  private status(item: WorkItem) {
    if (item.status === 'done') return 'Finished';
    if (item.status === 'cancelled') return 'Cancelled';
    if (item.status === 'review') return 'Ready for review';
    if (item.status === 'blocked') return item.needsHuman ? 'Needs a decision' : 'Blocked';
    if (item.waitingOn?.length) return 'Waiting for other work';
    if (item.readiness === 'held') return 'On hold';
    if (item.status === 'open' && (!item.goalCondition || item.goalApprovedRevision !== item.goalRevision)) return item.goalCondition ? 'Goal needs review' : 'Needs goal draft';
    if (item.readiness !== 'ready') return 'Draft';
    if (item.status === 'active' || item.ownerSessionId || item.dispatch) return 'In motion';
    return 'Ready to start';
  }
  private statusIcon(item: WorkItem): 'play' | 'wait' | 'alert' | 'check' | 'clock' | 'flag' {
    if (item.status === 'blocked' || item.dispatch?.state === 'uncertain' || item.dispatch?.state === 'failed') return 'alert';
    if (item.status === 'done' || item.status === 'review') return 'check';
    if (item.waitingOn?.length || item.readiness === 'held') return 'wait';
    if (item.status === 'active' || item.ownerSessionId || item.dispatch) return 'play';
    return item.readiness === 'ready' ? 'flag' : 'clock';
  }
  private summary(item: WorkItem) { return item.blockedReason || item.nextAction || item.progress || item.brief || 'Open to see the details.'; }
  private openDetail(item: WorkItem) { this.detail = item; void this.refresh(); }
  showWorkItem(id: string) { void this.openDependency(id); }
  private async openDependency(id: string) {
    const found = this.work.find(item => item.id === id);
    if (found) { this.openDetail(found); return; }
    const key = this.refreshKey;
    try {
      const item = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(id)}`);
      if (key === this.refreshKey) this.detail = item;
    } catch (error) { if (key === this.refreshKey) this.error = String(error); }
  }
  private dependencyLinks(ids: string[]) { return ids.map((id, index) => html`${index ? ', ' : ''}<a href="#" @click=${(event: Event) => { event.preventDefault(); void this.openDependency(id); }}>${this.work.find(item => item.id === id)?.title || id.slice(0,8)}</a>`); }
  private controls() { const control = this.control; return html`<div class="controls"><div class="controls-main"><mux-ui-button class="play" icon-only variant="secondary" ?disabled=${!control} accessible-label=${control?.paused ? 'Continue project work' : 'Pause project work'} title=${control?.paused ? 'Continue project work' : 'Pause project work'} @click=${() => void this.changeControl({paused: !control?.paused})}>${icon(control?.paused ? 'play' : 'pause')}</mux-ui-button><span class="active-count">${control?.active ?? 0} in motion${control?.paused ? ' · paused' : ''}</span></div><div class="parallel"><mux-ui-range-field label="Parallel" accessible-label="Parallel work in this project" .min=${1} .max=${8} .value=${control?.parallelism ?? 4} .valueLabels=${["1 at once", "2 at once", "3 at once", "4 at once", "5 at once", "6 at once", "7 at once", "8 at once"]} ?disabled=${!control} @change=${(event: Event) => void this.changeControl({parallelism: (event.target as MuxUIRangeField).value})}></mux-ui-range-field></div></div>`; }
  private group(title: string, key: string, items: WorkItem[]) {
    if (!items.length) return nothing;
    const open = !this.collapsed[key];
    return html`<section class="group"><mux-ui-button class="group-head" variant="quiet" expandable ?expanded=${open} @click=${() => { this.collapsed = {...this.collapsed, [key]: open}; }}><span class="chevron">${icon('chevron')}</span>${title}<span class="count">${items.length}</span></mux-ui-button>${open ? html`<div class="group-body">${items.map(item => html`<div class="row"><span class=${`kind ${item.status === 'blocked' ? 'blocked' : item.waitingOn?.length ? 'waiting' : key === 'motion' ? 'working' : key === 'ready' ? 'ready' : ''}`}>${icon(this.statusIcon(item))}${this.status(item)}</span><mux-ui-button variant="quiet" @click=${() => this.openDetail(item)}><strong>${item.title}</strong></mux-ui-button><p>${this.summary(item)}</p>${item.ownerSessionId ? html`<div class="meta">With ${this.chatLink(item.ownerSessionId)}</div>` : nothing}</div>`)}</div>` : nothing}</section>`;
  }
  private list() {
    const labels = [...new Set(this.work.flatMap(item => item.labels || []))].sort();
    const selected = this.work.filter(item => (!this.labelFilter || item.labels?.includes(this.labelFilter)) && (this.filter === 'all' || (this.filter === 'finished' ? item.status === 'done' || item.status === 'cancelled' : item.status !== 'done' && item.status !== 'cancelled')));
    const attention = selected.filter(item => this.attention(item));
    const other = selected.filter(item => !this.attention(item));
    const motion = other.filter(item => item.status === 'active' || (item.status === 'open' && (item.ownerSessionId || item.dispatch)));
    const ready = other.filter(item => item.status === 'open' && item.readiness === 'ready' && !!item.goalCondition && item.goalApprovedRevision === item.goalRevision && !item.waitingOn?.length && !item.ownerSessionId && !item.dispatch);
    const waiting = other.filter(item => !motion.includes(item) && !ready.includes(item) && item.status !== 'done' && item.status !== 'cancelled');
    const finished = other.filter(item => item.status === 'done' || item.status === 'cancelled');
    return html`<nav class="filters" aria-label="Work filter">${(['open','all','finished'] as const).map(filter => html`<mux-ui-button class="filter" variant="quiet" size="small" ?selected=${this.filter === filter} @click=${() => { this.filter = filter; }}>${filter === 'open' ? 'Open' : filter === 'all' ? 'All' : 'Finished'}</mux-ui-button>`)}${labels.length ? html`<mux-ui-select class="label-filter" size="small" aria-label="Filter by label" .value=${this.labelFilter} .options=${[{value:"",label:"All labels"},...labels.map(label => ({value:label,label}))]} @change=${(event: Event) => { this.labelFilter = (event.target as MuxUISelect).value; }}></mux-ui-select>` : nothing}</nav>${this.controls()}${attention.length ? html`<section class="attention" aria-label="Needs your attention">${attention.map(item => html`<div class="attention-item"><span class=${`kind ${item.status === 'review' ? 'review' : item.status === 'blocked' ? 'blocked' : ''}`}>${icon(this.statusIcon(item))}${this.status(item)}</span><mux-ui-button variant="quiet" @click=${() => this.openDetail(item)}><h3>${item.title}</h3></mux-ui-button><p>${this.summary(item)}</p></div>`)}</section>` : nothing}${this.group('In motion','motion',motion)}${this.group('Ready to start','ready',ready)}${this.group('Waiting & blocked','waiting',waiting)}${this.group('Finished','finished',finished)}${!selected.length ? html`<div class="empty"><strong>${this.work.length ? 'Nothing in this view' : 'No work here yet'}</strong><p>${this.work.length ? 'Try another filter.' : 'Ask a chat to capture an item for this project.'}</p></div>` : nothing}`;
  }
  private timelineEntry(update: WorkUpdate) {
    const mark = update.status === 'done' || update.status === 'review' || update.goalApproved ? 'check' : update.status === 'blocked' ? 'alert' : update.status === 'active' ? 'play' : update.readiness === 'ready' ? 'flag' : update.linkedSessionId || update.ownerSessionId ? 'chat' : 'clock';
    const title = update.goalApproved ? 'Goal approved' : update.goalCondition ? 'Goal drafted' : update.status === 'done' ? 'Work completed' : update.status === 'blocked' ? 'Blocked' : update.status === 'review' ? 'Ready for review' : update.status === 'active' ? 'Work started' : update.status ? 'Work updated' : update.readiness === 'ready' ? 'Marked ready' : update.readiness === 'held' ? 'Put on hold' : html`Update from ${this.actor(update.actor)}`;
    const body = update.text || update.progress || update.outcome || update.blockedReason || '';
    const summary = update.summary?.trim() || activityPreview(body);
    const expanded = !!body && (!!update.summary && update.summary.trim() !== body.trim() || body.length > 160 || body.includes('\n'));
    const fallback = update.goalCondition ? 'Condition ready for review.' : update.ownerSessionId ? html`Claimed by ${this.chatLink(update.ownerSessionId)}` : update.linkedSessionId ? html`Linked ${this.chatLink(update.linkedSessionId)}` : update.readiness ? `Readiness: ${update.readiness}` : 'Record updated';
    const evidence = update.evidence?.length ? html`<p class="activity-evidence">Evidence: ${update.evidence.join(', ')}</p>` : nothing;
    const content = expanded
      ? html`<p class="activity-summary">${summary}</p><details class="activity-full"><summary>Read full update</summary><div class="activity-markdown">${renderSegments(parseMarkdown(body))}${evidence}</div></details>`
      : body ? html`<div class="activity-markdown">${renderSegments(parseMarkdown(body))}${evidence}</div>`
        : html`<p class="activity-summary">${summary || fallback}</p>${evidence}`;
    return html`<li><span class="timeline-icon">${icon(mark)}</span><div><time>${this.date(update.at)}</time><strong>${title}</strong>${content}</div></li>`;
  }
  private detailView() {
    const item = this.detail;
    if (!item) return nothing;
    const updates = [...(item.updates || [])].reverse();
    const state = this.status(item);
    const stateClass = item.status === 'blocked' ? 'blocked' : item.status === 'done' ? 'done' : item.waitingOn?.length ? 'waiting' : '';
    return html`<article class="detail-view">
      ${this.projectId ? html`<mux-ui-button class="back" variant="quiet" size="small" @click=${() => { this.detail = undefined; }}>${icon('back')}Back to work</mux-ui-button><div class="project detail-project">${icon('folder')}${this.projectName()}</div>` : nothing}
      <div class=${`status ${stateClass}`}>${icon(this.statusIcon(item))}${state}</div>
      <h2>${item.title}</h2>
      <p class="lead">${item.brief || 'No description yet.'}</p>
      ${item.status === 'open' || item.goalCondition ? html`<mux-work-goal-review .item=${item} .remoteHost=${this.remoteHost} @work-goal-updated=${(event:CustomEvent<WorkItem>) => { this.detail=event.detail; void this.refresh(); }}></mux-work-goal-review>` : nothing}
      ${item.nextAction || item.blockedReason ? html`<section class=${`next ${item.status === 'blocked' ? 'blocked' : ''}`}><h3>${item.status === 'blocked' ? 'What is needed' : 'Next move'}</h3><p>${item.blockedReason || item.nextAction}</p></section>` : nothing}
      ${item.progress ? html`<section class="section"><h3>Where things stand</h3><p>${item.progress.length > 160 || item.progress.includes('\n') ? activityPreview(item.progress) : item.progress}</p></section>` : nothing}
      ${item.acceptanceCriteria ? html`<section class="section"><h3>How we'll know it worked</h3><p>${item.acceptanceCriteria}</p></section>` : nothing}
      ${item.outcome ? html`<section class="section"><h3>Outcome</h3><p>${item.outcome}</p></section>` : nothing}
      ${item.ownerSessionId || item.dispatch?.sessionId ? html`<section class="section"><h3>Who's on it</h3><p>${this.chatLink(item.ownerSessionId || item.dispatch!.sessionId)}</p></section>` : nothing}
      ${item.dependsOn?.length ? html`<section class="section"><h3>Before this can start</h3><p>${this.dependencyLinks(item.dependsOn)}${item.waitingOn?.length ? ` · ${item.waitingOn.length} still in progress` : ' · all complete'}</p></section>` : nothing}
      <section class="section"><h3>Recent activity</h3><ol class="timeline">${updates.length ? updates.map(update => this.timelineEntry(update)) : html`<li><span class="timeline-icon">${icon('work')}</span><div><time>${this.date(item.createdAt)}</time><strong>Added to work</strong><p>${item.source || 'Created for this project.'}</p></div></li>`}</ol></section>
      ${item.labels?.length ? html`<section class="section"><h3>Labels</h3><div class="tags">${item.labels.map(label => html`<span class="tag">${label}</span>`)}</div></section>` : nothing}
      <div class="facts"><span>Created by ${this.actor(item.createdBy)}</span><span>Updated ${this.date(item.updatedAt)}</span></div>
    </article>`;
  }
  override render() {
    return html`<div class="wrap"><div class="top"><div>${this.detail ? nothing : html`<h2>Work</h2><div class="project">${icon('folder')}${this.projectName()}</div>`}</div></div>${!this.projectId && !this.detail ? html`<div class="empty"><strong>Choose a project to see its work.</strong></div>` : this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}${this.detail ? this.detailView() : this.projectId ? this.list() : nothing}</div>`;
  }
}
