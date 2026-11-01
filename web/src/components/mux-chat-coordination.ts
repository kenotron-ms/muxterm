import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { sdkChats } from '../lib/sdk-chats.js';
import '../ui/button.js';
import '../ui/text-field.js';
import '../ui/text-area.js';
import '../ui/select.js';
import '../ui/switch.js';
import type { MuxUITextField } from '../ui/text-field.js';
import type { MuxUITextArea } from '../ui/text-area.js';
import type { MuxUISelect } from '../ui/select.js';

type WorkUpdate = { id:string; at:string; sessionId?:string; linkedSessionId?:string; text:string; status?:string; progress?:string; outcome?:string; evidence?:string[] };
type WorkItem = { id:string; title:string; brief:string; status:string; progress?:string; outcome?:string; ownerSessionId:string; sessionIds:string[]; updatedAt:string; updates?:WorkUpdate[] };
type Subscription = { id:string; sources:string[]; topics:string[] };
type InboxEvent = { id:string; sourceSessionId:string; topic:string; at:string; event:{ type:string; text?:string; message?:string; workId?:string } };

@customElement('mux-chat-coordination')
export class MuxChatCoordination extends LitElement {
  @property() sessionId = '';
  @property() remoteHost = '';
  @state() private view: 'work' | 'inbox' | 'subscriptions' = 'work';
  @state() private work: WorkItem[] = [];
  @state() private detail?: WorkItem;
  @state() private inbox: InboxEvent[] = [];
  @state() private subscriptions: Subscription[] = [];
  @state() private selectedSources: string[] = [];
  @state() private selectedTopics: string[] = ['lifecycle', 'work'];
  @state() private workParticipants: string[] = [];
  @state() private workTitle = '';
  @state() private brief = '';
  @state() private updateText = '';
  @state() private updateStatus = '';
  @state() private linkedSession = '';
  @state() private error = '';
  @state() private pending = false;
  private cursor = '0';
  private poll?: number;
  private loading = false;
  private createRef = '';
  private updateRef = '';
  private linkRef = '';
  private refreshKey = 0;

  static styles = css`
    :host { display:block; height:100%; overflow:auto; box-sizing:border-box; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-sm)/1.5 var(--ui-font-sans); }
    * { box-sizing:border-box; }
    .wrap { max-width:var(--ui-chat-content-width); margin:0 auto; padding:var(--ui-space-7); }
    header { display:flex; align-items:flex-start; gap:var(--ui-space-5); justify-content:space-between; }
    h2 { margin:0; font-size:var(--ui-text-2xl); line-height:1.2; }
    h3 { margin:0 0 var(--ui-space-3); font-size:var(--ui-text-md); }
    p { margin:0; }
    .muted { color:var(--ui-text-muted); }
    .tabs { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); margin:var(--ui-space-6) 0; border-bottom:1px solid var(--ui-border); }
    .tabs mux-ui-button { border-bottom:var(--ui-divider-thickness) solid transparent; }
    .tabs mux-ui-button[pressed] { border-color:var(--ui-accent); }
    .toolbar { display:flex; gap:var(--ui-space-3); align-items:center; flex-wrap:wrap; margin-bottom:var(--ui-space-5); }
    .card { border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); padding:var(--ui-space-5); margin-bottom:var(--ui-space-4); }
    .card-head { display:flex; gap:var(--ui-space-4); align-items:center; justify-content:space-between; }
    .card-head strong { overflow-wrap:anywhere; }
    .badge { display:inline-block; border:1px solid var(--ui-border-strong); border-radius:var(--ui-radius-pill); color:var(--ui-text-muted); padding:var(--ui-space-1) var(--ui-space-5); font-size:var(--ui-text-xs); white-space:nowrap; }
    .card p { margin-top:var(--ui-space-3); overflow-wrap:anywhere; white-space:pre-wrap; }
    .card small { display:block; color:var(--ui-text-muted); margin-top:var(--ui-space-3); }
    .form { display:grid; gap:var(--ui-space-3); margin-top:var(--ui-space-5); }
    .form mux-ui-text-field,.form mux-ui-text-area,.form mux-ui-select { display:block; min-width:0; }
    .checks { display:flex; flex-wrap:wrap; gap:var(--ui-space-3) var(--ui-space-5); }
    .error { color:var(--ui-danger); margin:var(--ui-space-3) 0; }
    .empty { color:var(--ui-text-muted); padding:var(--ui-space-7) 0; }
    .events { display:grid; gap:var(--ui-space-3); }
    .event { border-left:var(--ui-divider-thickness) solid var(--ui-accent); padding:var(--ui-space-3) var(--ui-space-5); background:var(--ui-surface-raised); }
    .event .meta { color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .event p { white-space:pre-wrap; overflow-wrap:anywhere; }
    @media(max-width:550px) { .wrap { padding:var(--ui-space-5); } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.poll = window.setInterval(() => { if (!document.hidden) void this.refresh(); }, 3000);
  }
  override disconnectedCallback() {
    if (this.poll) window.clearInterval(this.poll);
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues<this>) {
    if (changed.has('sessionId') || changed.has('remoteHost')) {
      this.refreshKey++;
      this.cursor = '0';
      this.inbox = [];
      this.work = [];
      this.detail = undefined;
      this.subscriptions = [];
      this.selectedSources = [];
      this.workParticipants = [];
      this.workTitle = '';
      this.brief = '';
      this.updateText = '';
      this.updateStatus = '';
      this.linkedSession = '';
      this.createRef = '';
      this.updateRef = '';
      this.linkRef = '';
      this.loading = false;
      void this.refresh();
    }
  }
  private path(path: string) { return apiPath(remoteChatPath(this.remoteHost, path)); }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.path(path), {cache:'no-store', ...init});
    if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
    return await response.json() as T;
  }
  private async refresh() {
    if (!this.sessionId || this.loading) return;
    const key = this.refreshKey;
    const sessionId = this.sessionId;
    this.loading = true;
    try {
      const work = await this.request<{work:WorkItem[]}>(`/api/sdk-work?session_id=${encodeURIComponent(sessionId)}`);
      if (key !== this.refreshKey) return;
      const subs = await this.request<{subscriptions:Subscription[]}>(`/api/sdk-chats/${encodeURIComponent(sessionId)}/subscriptions`);
      if (key !== this.refreshKey) return;
      this.work = work.work;
      this.subscriptions = subs.subscriptions;
      if (this.detail) {
        const detail = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(this.detail.id)}`);
        if (key !== this.refreshKey) return;
        this.detail = detail;
      }
      for (let page = 0; page < 10; page++) {
        const batch = await this.request<{events:InboxEvent[]; cursor:number; hasMore:boolean}>(`/api/sdk-chats/${encodeURIComponent(sessionId)}/inbox?after=${this.cursor}&limit=500`);
        if (key !== this.refreshKey) return;
        this.cursor = String(batch.cursor);
        if (batch.events.length) this.inbox = [...this.inbox, ...batch.events].slice(-100);
        if (!batch.hasMore) break;
      }
      this.error = '';
    } catch (error) { if (key === this.refreshKey) this.error = String(error); }
    finally { if (key === this.refreshKey) this.loading = false; }
  }
  private async mutate(path: string, body: unknown, method = 'POST') {
    this.pending = true;
    try {
      await this.request(path, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
      this.error = '';
      await this.refresh();
    } catch (error) { this.error = String(error); }
    finally { this.pending = false; }
  }
  private async createWork() {
    if (!this.workTitle.trim()) return;
    this.createRef ||= crypto.randomUUID();
    await this.mutate('/api/sdk-work', {clientRef:this.createRef, title:this.workTitle.trim(), brief:this.brief.trim(), ownerSessionId:this.sessionId, sessionIds:this.workParticipants});
    if (!this.error) { this.workTitle = ''; this.brief = ''; this.workParticipants = []; this.createRef = ''; }
  }
  private async addUpdate() {
    if (!this.detail || (!this.updateText.trim() && !this.updateStatus)) return;
    this.updateRef ||= crypto.randomUUID();
    await this.mutate(`/api/sdk-work/${encodeURIComponent(this.detail.id)}/updates`, {clientRef:this.updateRef, sessionId:this.sessionId, text:this.updateText.trim(), status:this.updateStatus});
    if (!this.error) { this.updateText = ''; this.updateStatus = ''; this.updateRef = ''; }
  }
  private async linkSession() {
    if (!this.detail || !this.linkedSession) return;
    this.linkRef ||= crypto.randomUUID();
    await this.mutate(`/api/sdk-work/${encodeURIComponent(this.detail.id)}/updates`, {clientRef:this.linkRef, sessionId:this.sessionId, linkedSessionId:this.linkedSession});
    if (!this.error) { this.linkedSession = ''; this.linkRef = ''; }
  }
  private async subscribe() {
    if (!this.selectedSources.length || !this.selectedTopics.length) return;
    await this.mutate(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/subscriptions`, {sources:this.selectedSources, topics:this.selectedTopics});
  }
  private async removeSubscription(id:string) {
    this.pending = true;
    try {
      await this.request(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/subscriptions/${encodeURIComponent(id)}`, {method:'DELETE'});
      this.error = '';
      await this.refresh();
    } catch (error) { this.error = String(error); }
    finally { this.pending = false; }
  }
  private toggleSource(id:string, checked:boolean) { this.selectedSources = checked ? [...this.selectedSources, id] : this.selectedSources.filter(value => value !== id); }
  private toggleTopic(id:string, checked:boolean) { this.selectedTopics = checked ? [...this.selectedTopics, id] : this.selectedTopics.filter(value => value !== id); }
  private toggleParticipant(id:string, checked:boolean) { this.workParticipants = checked ? [...this.workParticipants, id] : this.workParticipants.filter(value => value !== id); }
  private sessionTitle(id:string) { return sdkChats.chats.find(chat => chat.id === id)?.title || id.slice(0,8); }
  private openSession(id:string) { this.dispatchEvent(new CustomEvent('chat-open', {detail:{sessionId:id}, bubbles:true, composed:true})); }

  private workView() {
    return html`<div class="toolbar"><strong>Work records</strong><span class="muted">${this.work.length} linked to this session</span></div>
      ${this.work.length ? this.work.map(item => html`<article class="card"><div class="card-head"><strong>${item.title}</strong><span class="badge">${item.status}</span></div>${item.progress ? html`<p>${item.progress}</p>` : item.brief ? html`<p class="muted">${item.brief}</p>` : nothing}<small>Updated ${new Date(item.updatedAt).toLocaleString()}</small><mux-ui-button size="small" variant="secondary" @click=${() => { this.detail = item; void this.refresh(); }}>Inspect progress</mux-ui-button></article>`) : html`<p class="empty">No work records linked to this session.</p>`}
      ${this.detail ? html`<section class="card"><div class="card-head"><h3>${this.detail.title}</h3><mux-ui-button size="small" variant="secondary" @click=${() => { this.detail = undefined; }}>Close</mux-ui-button></div><p>${this.detail.brief}</p><p><span class="badge">${this.detail.status}</span> ${this.detail.progress || ''}</p>${this.detail.outcome ? html`<p><strong>Outcome:</strong> ${this.detail.outcome}</p>` : nothing}<p class="muted">Sessions: ${[this.detail.ownerSessionId,...this.detail.sessionIds].map(id => this.sessionTitle(id)).join(', ')}</p><div class="toolbar"><mux-ui-select aria-label="Session to link" .value=${this.linkedSession} .options=${[{value:'',label:'Add a session…'},...sdkChats.chats.filter(chat => chat.id !== this.detail?.ownerSessionId && !this.detail?.sessionIds.includes(chat.id)).map(chat => ({value:chat.id,label:chat.title}))]} @change=${(event:Event) => { this.linkedSession=(event.target as MuxUISelect).value; }}></mux-ui-select><mux-ui-button size="small" variant="secondary" ?disabled=${this.pending || !this.linkedSession} @click=${() => void this.linkSession()}>Link session</mux-ui-button></div><h3>Updates</h3>${this.detail.updates?.length ? this.detail.updates.map(update => html`<div class="event"><div class="meta">${new Date(update.at).toLocaleString()} · ${update.sessionId ? this.sessionTitle(update.sessionId) : 'User'} ${update.status || ''}</div><p>${update.text || update.progress || update.outcome || (update.linkedSessionId ? `Linked ${this.sessionTitle(update.linkedSessionId)}` : '')}</p>${update.evidence?.length ? html`<small>Evidence: ${update.evidence.join(', ')}</small>` : nothing}</div>`) : html`<p class="muted">No updates yet.</p>`}<div class="form"><mux-ui-text-area label="Progress update" .value=${this.updateText} @input=${(event:InputEvent) => { this.updateText=(event.target as MuxUITextArea).value; }}></mux-ui-text-area><mux-ui-select label="Status" .value=${this.updateStatus} .options=${[{value:'',label:'Keep current status'},...['open','active','blocked','done','cancelled'].map(status => ({value:status,label:status}))]} @change=${(event:Event) => { this.updateStatus=(event.target as MuxUISelect).value; }}></mux-ui-select><mux-ui-button size="small" variant="primary" ?disabled=${this.pending || (!this.updateText.trim() && !this.updateStatus)} @click=${() => void this.addUpdate()}>Record update</mux-ui-button></div></section>` : nothing}
      <section class="card"><h3>New work record</h3><p class="muted">Record a task here, then message any participating sessions.</p><div class="form"><mux-ui-text-field label="Title" .value=${this.workTitle} @input=${(event:InputEvent) => { this.workTitle=(event.target as MuxUITextField).value; }}></mux-ui-text-field><mux-ui-text-area label="Brief" .value=${this.brief} @input=${(event:InputEvent) => { this.brief=(event.target as MuxUITextArea).value; }}></mux-ui-text-area><div><strong>Participating sessions</strong><div class="checks">${sdkChats.chats.filter(chat => chat.id !== this.sessionId && !chat.archived).map(chat => html`<mux-ui-switch .label=${chat.title} .checked=${this.workParticipants.includes(chat.id)} @change=${(event:CustomEvent<{checked:boolean}>) => this.toggleParticipant(chat.id,event.detail.checked)}></mux-ui-switch>`)}</div></div><mux-ui-button size="small" variant="primary" ?disabled=${this.pending || !this.workTitle.trim()} @click=${() => void this.createWork()}>Create work</mux-ui-button></div></section>`;
  }
  private inboxView() {
    return html`<div class="toolbar"><strong>Session inbox</strong><span class="muted">${this.inbox.length} recent events</span><mux-ui-button size="small" variant="secondary" @click=${() => void this.refresh()}>Refresh</mux-ui-button></div>${this.inbox.length ? html`<div class="events">${[...this.inbox].reverse().map(item => html`<article class="event"><div class="meta">${new Date(item.at).toLocaleString()} · ${item.topic} · <mux-ui-button size="small" variant="secondary" @click=${() => this.openSession(item.sourceSessionId)}>${this.sessionTitle(item.sourceSessionId)}</mux-ui-button> · ${item.event.type}</div><p>${item.event.text || item.event.message || item.event.workId || ''}</p></article>`)}</div>` : html`<p class="empty">No subscribed events yet. Add a subscription to receive future events.</p>`}`;
  }
  private subscriptionsView() {
    const sources = sdkChats.chats.filter(chat => chat.id !== this.sessionId && !chat.archived);
    return html`<div class="toolbar"><strong>Subscriptions</strong><span class="muted">${this.subscriptions.length} active</span></div>${this.subscriptions.map(sub => html`<article class="card"><div class="card-head"><strong>${sub.sources.map(id => this.sessionTitle(id)).join(', ')}</strong><mux-ui-button size="small" variant="secondary" ?disabled=${this.pending} @click=${() => void this.removeSubscription(sub.id)}>Remove</mux-ui-button></div><p class="muted">${sub.topics.join(' · ')}</p></article>`)}<section class="card"><h3>Subscribe to sessions</h3><p class="muted">Events from selected sessions will appear in this session’s inbox. Subscribing does not wake the agent.</p><div class="form"><div><strong>Sources</strong><div class="checks">${sources.map(chat => html`<mux-ui-switch .label=${chat.title} .checked=${this.selectedSources.includes(chat.id)} @change=${(event:CustomEvent<{checked:boolean}>) => this.toggleSource(chat.id,event.detail.checked)}></mux-ui-switch>`)}</div></div><div><strong>Topics</strong><div class="checks">${['lifecycle','input','goal','work','session','error'].map(topic => html`<mux-ui-switch .label=${topic} .checked=${this.selectedTopics.includes(topic)} @change=${(event:CustomEvent<{checked:boolean}>) => this.toggleTopic(topic,event.detail.checked)}></mux-ui-switch>`)}</div></div><mux-ui-button size="small" variant="primary" ?disabled=${this.pending || !this.selectedSources.length || !this.selectedTopics.length} @click=${() => void this.subscribe()}>Subscribe</mux-ui-button></div></section>`;
  }
  override render() {
    return html`<div class="wrap"><header><div><h2>Coordination</h2><p class="muted">Work, events, and sessions linked to this chat.</p></div></header>${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}<nav class="tabs" aria-label="Coordination views">${(['work','inbox','subscriptions'] as const).map(view => html`<mux-ui-button size="small" variant="quiet" toggle ?pressed=${this.view === view} @click=${() => { this.view=view; }}>${view === 'work' ? 'Work' : view === 'inbox' ? 'Inbox' : 'Subscriptions'}</mux-ui-button>`)}</nav>${this.view === 'work' ? this.workView() : this.view === 'inbox' ? this.inboxView() : this.subscriptionsView()}</div>`;
  }
}
