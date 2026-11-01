import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { sdkChats } from '../lib/sdk-chats.js';

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

  static styles = css`
    :host { display:block; height:100%; overflow:auto; box-sizing:border-box; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-sm)/1.5 var(--ui-font-sans); }
    * { box-sizing:border-box; }
    button,input,textarea,select { font:inherit; }
    button { cursor:pointer; }
    .wrap { max-width:820px; margin:0 auto; padding:var(--ui-space-7); }
    header { display:flex; align-items:flex-start; gap:var(--ui-space-5); justify-content:space-between; }
    h2 { margin:0; font-size:var(--ui-text-2xl); line-height:1.2; }
    h3 { margin:0 0 var(--ui-space-3); font-size:var(--ui-text-md); }
    p { margin:0; }
    .muted { color:var(--ui-text-muted); }
    .tabs { display:flex; flex-wrap:wrap; gap:4px; margin:var(--ui-space-6) 0; border-bottom:1px solid var(--ui-border); }
    .tabs button { border:0; border-bottom:2px solid transparent; padding:8px 12px; color:var(--ui-text-muted); background:transparent; }
    .tabs button[aria-selected="true"] { color:var(--ui-text); border-color:var(--ui-accent); }
    .toolbar { display:flex; gap:var(--ui-space-3); align-items:center; flex-wrap:wrap; margin-bottom:var(--ui-space-5); }
    .action { border:1px solid var(--ui-border-strong); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); color:var(--ui-text); padding:5px 10px; }
    .action.primary { background:var(--ui-accent); border-color:var(--ui-accent); color:var(--ui-on-accent,#fff); }
    .action:disabled { opacity:.5; cursor:default; }
    .card { border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); padding:var(--ui-space-5); margin-bottom:var(--ui-space-4); }
    .card-head { display:flex; gap:var(--ui-space-4); align-items:center; justify-content:space-between; }
    .card-head strong { overflow-wrap:anywhere; }
    .badge { display:inline-block; border:1px solid var(--ui-border-strong); border-radius:20px; color:var(--ui-text-muted); padding:1px 7px; font-size:var(--ui-text-xs); white-space:nowrap; }
    .card p { margin-top:var(--ui-space-3); overflow-wrap:anywhere; white-space:pre-wrap; }
    .card small { display:block; color:var(--ui-text-muted); margin-top:var(--ui-space-3); }
    .form { display:grid; gap:var(--ui-space-3); margin-top:var(--ui-space-5); }
    input,textarea,select { width:100%; color:var(--ui-text); background:var(--ui-surface-base); border:1px solid var(--ui-border-strong); border-radius:var(--ui-radius-md); padding:7px 9px; }
    textarea { min-height:75px; resize:vertical; }
    label { display:block; color:var(--ui-text-muted); }
    label input,label textarea,label select { margin-top:4px; color:var(--ui-text); }
    .checks { display:flex; flex-wrap:wrap; gap:6px 12px; }
    .checks label { display:inline-flex; gap:5px; align-items:center; color:var(--ui-text); }
    .checks input { width:auto; margin:0; }
    .error { color:var(--ui-danger,#d55454); margin:var(--ui-space-3) 0; }
    .empty { color:var(--ui-text-muted); padding:var(--ui-space-7) 0; }
    .events { display:grid; gap:var(--ui-space-3); }
    .event { border-left:2px solid var(--ui-accent); padding:5px 11px; background:var(--ui-surface-raised); }
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
  private path(path: string) { return apiPath(remoteChatPath(this.remoteHost, path)); }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.path(path), {cache:'no-store', ...init});
    if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
    return await response.json() as T;
  }
  private async refresh() {
    if (!this.sessionId || this.loading) return;
    this.loading = true;
    try {
      const work = await this.request<{work:WorkItem[]}>(`/api/sdk-work?session_id=${encodeURIComponent(this.sessionId)}`);
      const subs = await this.request<{subscriptions:Subscription[]}>(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/subscriptions`);
      this.work = work.work;
      this.subscriptions = subs.subscriptions;
      if (this.detail) this.detail = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(this.detail.id)}`);
      for (let page = 0; page < 10; page++) {
        const batch = await this.request<{events:InboxEvent[]; cursor:number; hasMore:boolean}>(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/inbox?after=${this.cursor}&limit=500`);
        this.cursor = String(batch.cursor);
        if (batch.events.length) this.inbox = [...this.inbox, ...batch.events].slice(-100);
        if (!batch.hasMore) break;
      }
      this.error = '';
    } catch (error) { this.error = String(error); }
    finally { this.loading = false; }
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
    await this.mutate(`/api/sdk-work/${encodeURIComponent(this.detail.id)}/updates`, {clientRef:crypto.randomUUID(), sessionId:this.sessionId, linkedSessionId:this.linkedSession});
    if (!this.error) this.linkedSession = '';
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
      ${this.work.length ? this.work.map(item => html`<article class="card"><div class="card-head"><strong>${item.title}</strong><span class="badge">${item.status}</span></div>${item.progress ? html`<p>${item.progress}</p>` : item.brief ? html`<p class="muted">${item.brief}</p>` : nothing}<small>Updated ${new Date(item.updatedAt).toLocaleString()}</small><button class="action" @click=${() => { this.detail = item; void this.refresh(); }}>Inspect progress</button></article>`) : html`<p class="empty">No work records linked to this session.</p>`}
      ${this.detail ? html`<section class="card"><div class="card-head"><h3>${this.detail.title}</h3><button class="action" @click=${() => { this.detail = undefined; }}>Close</button></div><p>${this.detail.brief}</p><p><span class="badge">${this.detail.status}</span> ${this.detail.progress || ''}</p>${this.detail.outcome ? html`<p><strong>Outcome:</strong> ${this.detail.outcome}</p>` : nothing}<p class="muted">Sessions: ${[this.detail.ownerSessionId,...this.detail.sessionIds].map(id => this.sessionTitle(id)).join(', ')}</p><div class="toolbar"><select aria-label="Session to link" .value=${this.linkedSession} @change=${(event:Event) => { this.linkedSession=(event.target as HTMLSelectElement).value; }}><option value="">Add a session…</option>${sdkChats.chats.filter(chat => chat.id !== this.detail?.ownerSessionId && !this.detail?.sessionIds.includes(chat.id)).map(chat => html`<option value=${chat.id}>${chat.title}</option>`)}</select><button class="action" ?disabled=${this.pending || !this.linkedSession} @click=${() => void this.linkSession()}>Link session</button></div><h3>Updates</h3>${this.detail.updates?.length ? this.detail.updates.map(update => html`<div class="event"><div class="meta">${new Date(update.at).toLocaleString()} · ${update.sessionId ? this.sessionTitle(update.sessionId) : 'User'} ${update.status || ''}</div><p>${update.text || update.progress || update.outcome || (update.linkedSessionId ? `Linked ${this.sessionTitle(update.linkedSessionId)}` : '')}</p>${update.evidence?.length ? html`<small>Evidence: ${update.evidence.join(', ')}</small>` : nothing}</div>`) : html`<p class="muted">No updates yet.</p>`}<div class="form"><label>Progress update<textarea .value=${this.updateText} @input=${(event:InputEvent) => { this.updateText=(event.target as HTMLTextAreaElement).value; }}></textarea></label><label>Status<select .value=${this.updateStatus} @change=${(event:Event) => { this.updateStatus=(event.target as HTMLSelectElement).value; }}><option value="">Keep current status</option>${['open','active','blocked','done','cancelled'].map(status => html`<option value=${status}>${status}</option>`)}</select></label><button class="action primary" ?disabled=${this.pending || (!this.updateText.trim() && !this.updateStatus)} @click=${() => void this.addUpdate()}>Record update</button></div></section>` : nothing}
      <section class="card"><h3>New work record</h3><p class="muted">Record a task here, then message any participating sessions.</p><div class="form"><label>Title<input .value=${this.workTitle} @input=${(event:InputEvent) => { this.workTitle=(event.target as HTMLInputElement).value; }}></label><label>Brief<textarea .value=${this.brief} @input=${(event:InputEvent) => { this.brief=(event.target as HTMLTextAreaElement).value; }}></textarea></label><div><strong>Participating sessions</strong><div class="checks">${sdkChats.chats.filter(chat => chat.id !== this.sessionId && !chat.archived).map(chat => html`<label><input type="checkbox" .checked=${this.workParticipants.includes(chat.id)} @change=${(event:Event) => this.toggleParticipant(chat.id,(event.target as HTMLInputElement).checked)}>${chat.title}</label>`)}</div></div><button class="action primary" ?disabled=${this.pending || !this.workTitle.trim()} @click=${() => void this.createWork()}>Create work</button></div></section>`;
  }
  private inboxView() {
    return html`<div class="toolbar"><strong>Session inbox</strong><span class="muted">${this.inbox.length} recent events</span><button class="action" @click=${() => void this.refresh()}>Refresh</button></div>${this.inbox.length ? html`<div class="events">${[...this.inbox].reverse().map(item => html`<article class="event"><div class="meta">${new Date(item.at).toLocaleString()} · ${item.topic} · <button class="action" @click=${() => this.openSession(item.sourceSessionId)}>${this.sessionTitle(item.sourceSessionId)}</button> · ${item.event.type}</div><p>${item.event.text || item.event.message || item.event.workId || ''}</p></article>`)}</div>` : html`<p class="empty">No subscribed events yet. Add a subscription to receive future events.</p>`}`;
  }
  private subscriptionsView() {
    const sources = sdkChats.chats.filter(chat => chat.id !== this.sessionId && !chat.archived);
    return html`<div class="toolbar"><strong>Subscriptions</strong><span class="muted">${this.subscriptions.length} active</span></div>${this.subscriptions.map(sub => html`<article class="card"><div class="card-head"><strong>${sub.sources.map(id => this.sessionTitle(id)).join(', ')}</strong><button class="action" ?disabled=${this.pending} @click=${() => void this.removeSubscription(sub.id)}>Remove</button></div><p class="muted">${sub.topics.join(' · ')}</p></article>`)}<section class="card"><h3>Subscribe to sessions</h3><p class="muted">Events from selected sessions will appear in this session’s inbox. Subscribing does not wake the agent.</p><div class="form"><div><strong>Sources</strong><div class="checks">${sources.map(chat => html`<label><input type="checkbox" .checked=${this.selectedSources.includes(chat.id)} @change=${(event:Event) => this.toggleSource(chat.id,(event.target as HTMLInputElement).checked)}>${chat.title}</label>`)}</div></div><div><strong>Topics</strong><div class="checks">${['lifecycle','input','goal','work','session','error'].map(topic => html`<label><input type="checkbox" .checked=${this.selectedTopics.includes(topic)} @change=${(event:Event) => this.toggleTopic(topic,(event.target as HTMLInputElement).checked)}>${topic}</label>`)}</div></div><button class="action primary" ?disabled=${this.pending || !this.selectedSources.length || !this.selectedTopics.length} @click=${() => void this.subscribe()}>Subscribe</button></div></section>`;
  }
  override render() {
    return html`<div class="wrap"><header><div><h2>Coordination</h2><p class="muted">Work, events, and sessions linked to this chat.</p></div></header>${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}<nav class="tabs" aria-label="Coordination views">${(['work','inbox','subscriptions'] as const).map(view => html`<button aria-selected=${String(this.view === view)} @click=${() => { this.view=view; }}>${view === 'work' ? 'Work' : view === 'inbox' ? 'Inbox' : 'Subscriptions'}</button>`)}</nav>${this.view === 'work' ? this.workView() : this.view === 'inbox' ? this.inboxView() : this.subscriptionsView()}</div>`;
  }
}
