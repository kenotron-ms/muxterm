import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { sdkChats, sdkHarnessLabel, type SDKChat, type SDKHarnessName } from '../lib/sdk-chats.js';

type Snapshot = { operator: SDKChat; lanes: SDKChat[] };
const harnesses: SDKHarnessName[] = ['codex', 'claude', 'amplifier', 'pi', 'opencode', 'deepseek'];

@customElement('mux-operator-status')
export class MuxOperatorStatus extends LitElement {
  @property() sessionId = '';
  @state() private snapshot?: Snapshot;
  @state() private error = '';
  @state() private busy = false;
  @state() private selected = '';
  @state() private harness: SDKHarnessName = 'codex';
  @state() private task = '';
  private poll?: number;

  static styles = css`
    :host { display:block; height:100%; overflow:auto; box-sizing:border-box; padding:20px; background:var(--chrome-body); color:var(--chrome-text-bright); font:13px/1.5 system-ui,sans-serif; }
    * { box-sizing:border-box; }
    h2,h3,p { margin:0; }
    .head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:18px; }
    h2 { font-size:18px; line-height:1.2; }
    .head p,.hint { color:var(--chrome-text-dim); font-size:12px; margin-top:5px; }
    button,select,textarea { font:inherit; }
    button { cursor:pointer; }
    .quiet,.action { border:1px solid var(--chrome-border); border-radius:7px; padding:6px 10px; background:var(--chrome-bar); color:var(--chrome-text-bright); }
    .quiet:hover,.action:hover { border-color:var(--chrome-accent); }
    .action { background:color-mix(in srgb,var(--chrome-accent) 17%,var(--chrome-bar)); }
    .error { padding:9px; margin-bottom:12px; border:1px solid var(--chrome-danger); border-radius:7px; color:var(--chrome-danger); white-space:pre-wrap; }
    .summary { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 14px; }
    .summary span { border:1px solid var(--chrome-border); border-radius:99px; padding:3px 9px; color:var(--chrome-text-dim); }
    .summary strong { color:var(--chrome-text-bright); }
    .lanes { display:grid; grid-template-columns:minmax(0,1fr); gap:10px; }
    .lane { min-width:0; overflow:hidden; border:1px solid var(--chrome-border); border-radius:10px; padding:12px; background:var(--chrome-bar); }
    .lane-top { min-width:0; display:flex; align-items:center; gap:8px; }
    .dot { flex:none; width:8px; height:8px; border-radius:50%; background:var(--chrome-text-dim); }
    .dot.working,.dot.starting { background:var(--chrome-accent); box-shadow:0 0 0 3px color-mix(in srgb,var(--chrome-accent) 17%,transparent); }
    .dot.failed,.dot.uncertain { background:var(--chrome-danger); }
    .dot.ready { background:var(--mux-ok,#55b981); }
    .lane strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .lane small { color:var(--chrome-text-dim); margin-left:auto; white-space:nowrap; }
    .lane p { margin-top:6px; overflow-wrap:anywhere; }
    .lane .output { color:var(--chrome-text-dim); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-wrap; }
    .progress-line { display:flex; justify-content:space-between; gap:8px; color:var(--chrome-text-dim); font-size:11px; margin-top:10px; }
    .progress-track { height:6px; border-radius:99px; background:var(--chrome-border); overflow:hidden; margin-top:5px; }
    .progress-fill { height:100%; background:var(--chrome-accent); border-radius:inherit; }
    .todos { margin:10px 0 0; padding-left:20px; color:var(--chrome-text-dim); }
    .todos li { margin:3px 0; }
    .todos li.done { text-decoration:line-through; opacity:.7; }
    .lane-actions { display:flex; gap:9px; margin-top:10px; }
    .lane-actions button { border:0; padding:0; background:none; color:var(--chrome-accent); }
    .lane-actions button:hover { text-decoration:underline; }
    .empty { padding:24px 14px; border:1px dashed var(--chrome-border); border-radius:9px; color:var(--chrome-text-dim); text-align:center; }
    .add { margin-top:20px; border-top:1px solid var(--chrome-border); padding-top:17px; }
    h3 { font-size:13px; margin-bottom:8px; }
    .row { display:flex; gap:7px; align-items:center; margin-top:8px; }
    select,textarea { min-width:0; border:1px solid var(--chrome-border); border-radius:7px; background:var(--chrome-bar); color:var(--chrome-text-bright); padding:7px 9px; }
    select { flex:1; }
    textarea { display:block; width:100%; min-height:74px; resize:vertical; }
    .hint { margin:6px 0 13px; }
    button:disabled { opacity:.5; cursor:default; }
    @media(max-width:470px) { :host { padding:14px; } .row { flex-wrap:wrap; } .row select { flex-basis:100%; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    void sdkChats.refresh();
    void this.load();
    this.poll = window.setInterval(() => { if (!document.hidden) void this.load(); }, 2500);
  }
  override disconnectedCallback() { if (this.poll) window.clearInterval(this.poll); super.disconnectedCallback(); }
  private async load() {
    if (!this.sessionId) return;
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/operator`), {cache:'no-store'});
      if (!response.ok) throw new Error(await response.text());
      this.snapshot = await response.json() as Snapshot;
    } catch (error) { this.error = String(error); }
  }
  private async updateOperator(change: {enabled?:boolean; laneIds?:string[]}) {
    this.busy = true; this.error = '';
    try { await sdkChats.operator(this.sessionId, change); await this.load(); }
    catch (error) { this.error = String(error); }
    finally { this.busy = false; }
  }
  private async addExisting() {
    if (!this.selected || !this.snapshot) return;
    this.busy = true; this.error = '';
    try { await sdkChats.linkOperatorLane(this.sessionId, this.selected); await this.load(); }
    catch (error) { this.error = String(error); }
    finally { this.busy = false; }
    this.selected = '';
  }
  private async createLane() {
    if (!this.task.trim() || !this.snapshot) return;
    this.busy = true; this.error = '';
    try {
      const operator = this.snapshot.operator;
      await sdkChats.create({workspaceId:operator.workspaceId, projectPath:operator.projectPath, harness:this.harness, provider:'', prompt:this.task.trim(), operatorId:this.sessionId});
      this.task = '';
      await this.load();
    } catch (error) { this.error = String(error); }
    finally { this.busy = false; }
  }
  private open(id:string) { this.dispatchEvent(new CustomEvent('chat-open',{detail:{sessionId:id},bubbles:true,composed:true})); }
  override render() {
    const operator = this.snapshot?.operator;
    const lanes = this.snapshot?.lanes || [];
    const available = sdkChats.chats.filter(chat => chat.id !== this.sessionId && !operator?.operatorLanes?.includes(chat.id) && !chat.archived);
    const attention = lanes.filter(chat => chat.state === 'failed' || chat.state === 'uncertain').length;
    const working = lanes.filter(chat => chat.state === 'working' || chat.state === 'starting').length;
    return html`<div class="head"><div><h2>Operator status</h2><p>Live progress from linked chats, across harnesses.</p></div>${operator?.operator ? html`<button class="quiet" @click=${() => void this.updateOperator({enabled:false})} ?disabled=${this.busy}>End operator mode</button>` : nothing}</div>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${!operator ? html`<div class="empty">Loading operator status…</div>` : !operator.operator ? html`<div class="empty"><p>This chat can coordinate other chats as lanes.</p><p class="hint">Promote it to see their hook-backed status here and give it standing operator instructions.</p><button class="action" @click=${() => void this.updateOperator({enabled:true})} ?disabled=${this.busy}>Make this chat an operator</button></div>` : html`
      <div class="summary"><span><strong>${lanes.length}</strong> lanes</span><span><strong>${working}</strong> working</span><span><strong>${attention}</strong> need attention</span></div>
      <div class="lanes">${lanes.length ? lanes.map(lane => html`<article class="lane"><div class="lane-top"><span class="dot ${lane.state}"></span><strong title=${lane.title}>${lane.title}</strong><small>${sdkHarnessLabel(lane.harness)}</small></div><p>${lane.lastActivity || lane.state}</p><div class="progress-line"><span>${lane.laneProgressSource === 'todos' ? 'Todo progress' : 'Turn estimate'}</span><strong>${lane.laneProgress ?? 0}%</strong></div><div class="progress-track" role="progressbar" aria-label=${`${lane.title} progress`} aria-valuenow=${lane.laneProgress ?? 0} aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style=${`width:${lane.laneProgress ?? 0}%`}></div></div>${lane.laneTodos?.length ? html`<ul class="todos">${lane.laneTodos.map(todo => html`<li class=${todo.status === 'completed' || todo.status === 'done' ? 'done' : ''}>${todo.text} · ${todo.status || 'pending'}</li>`)}</ul>` : nothing}${lane.laneReport || lane.lastOutput ? html`<p class="output">${lane.laneReport || lane.lastOutput}</p>` : nothing}<div class="lane-actions"><button @click=${() => this.open(lane.id)}>Open chat</button><button @click=${() => void this.updateOperator({laneIds:(operator.operatorLanes || []).filter(id => id !== lane.id)})} ?disabled=${this.busy}>Remove lane</button></div></article>`) : html`<div class="empty">No lanes yet. Attach a chat or start one below.</div>`}</div>
      <section class="add"><h3>Attach an existing chat</h3><div class="row"><select aria-label="Chat to attach" .value=${this.selected} @change=${(event:Event) => { this.selected=(event.target as HTMLSelectElement).value; }}><option value="">Choose a chat…</option>${available.map(chat => html`<option value=${chat.id}>${chat.title} · ${sdkHarnessLabel(chat.harness)}</option>`)}</select><button class="action" @click=${() => void this.addExisting()} ?disabled=${this.busy || !this.selected || lanes.length >= 12}>Attach</button></div></section>
      <section class="add"><h3>Start a new lane</h3><p class="hint">It starts in this chat’s project. Its status appears here when the harness reports activity.</p><textarea aria-label="Lane task" placeholder="What should this lane do?" .value=${this.task} @input=${(event:InputEvent) => { this.task=(event.target as HTMLTextAreaElement).value; }}></textarea><div class="row"><select aria-label="Lane harness" .value=${this.harness} @change=${(event:Event) => { this.harness=(event.target as HTMLSelectElement).value as SDKHarnessName; }}>${harnesses.map(harness => html`<option value=${harness}>${sdkHarnessLabel(harness)}</option>`)}</select><button class="action" @click=${() => void this.createLane()} ?disabled=${this.busy || !this.task.trim() || lanes.length >= 12}>Start lane</button></div></section>`}`;
  }
}
