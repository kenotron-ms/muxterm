import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { sdkChats, sdkHarnessLabel, type SDKChat } from '../lib/sdk-chats.js';

type Snapshot = { operator: SDKChat; lanes: SDKChat[] };

@customElement('mux-operator-status')
export class MuxOperatorStatus extends LitElement {
  @property() sessionId = '';
  @state() private snapshot?: Snapshot;
  @state() private error = '';
  @state() private busy = false;
  private poll?: number;

  static styles = css`
    :host { display:block; height:100%; overflow:auto; box-sizing:border-box; padding:20px; background:var(--chrome-body); color:var(--chrome-text-bright); font:13px/1.5 system-ui,sans-serif; }
    * { box-sizing:border-box; }
    h2,h3,p { margin:0; }
    .head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:18px; }
    h2 { font-size:18px; line-height:1.2; }
    .head p,.hint { color:var(--chrome-text-dim); font-size:12px; margin-top:5px; }
    button { font:inherit; cursor:pointer; }
    .action { border:1px solid var(--chrome-border); border-radius:7px; padding:6px 10px; background:var(--chrome-bar); color:var(--chrome-text-bright); }
    .action:hover { border-color:var(--chrome-accent); }
    .action { background:color-mix(in srgb,var(--chrome-accent) 17%,var(--chrome-bar)); }
    .mode-control { flex:none; display:flex; align-items:center; gap:8px; border:0; padding:3px 0; background:none; color:var(--chrome-text-dim); font-size:11px; }
    .mode-control:hover,.mode-control:focus-visible { color:var(--chrome-text-bright); }
    .mode-switch { width:30px; height:18px; padding:3px; border-radius:99px; background:var(--chrome-border); transition:background .15s; }
    .mode-switch::after { content:''; display:block; width:12px; height:12px; border-radius:50%; background:var(--chrome-text-bright); transition:transform .15s; }
    .mode-control[aria-checked="true"] .mode-switch { background:var(--chrome-accent); }
    .mode-control[aria-checked="true"] .mode-switch::after { transform:translateX(12px); background:var(--chrome-body); }
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
    .hint { margin:6px 0 13px; }
    .empty .hint { margin:8px 0 0; }
    button:disabled { opacity:.5; cursor:default; }
    @media(max-width:470px) { :host { padding:14px; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
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
  private async updateOperator(enabled: boolean) {
    this.busy = true; this.error = '';
    try { await sdkChats.operator(this.sessionId, { enabled }); await this.load(); }
    catch (error) { this.error = String(error); }
    finally { this.busy = false; }
  }
  private open(id:string) { this.dispatchEvent(new CustomEvent('chat-open',{detail:{sessionId:id},bubbles:true,composed:true})); }
  override render() {
    const operator = this.snapshot?.operator;
    const lanes = this.snapshot?.lanes || [];
    const attention = lanes.filter(chat => chat.state === 'failed' || chat.state === 'uncertain').length;
    const working = lanes.filter(chat => chat.state === 'working' || chat.state === 'starting').length;
    return html`<div class="head"><div><h2>Operator status</h2><p>Ask this chat to manage lanes. Their progress appears here.</p></div>${operator?.operator ? html`<button class="mode-control" role="switch" aria-label="Operator mode" aria-checked="true" title="Turn off operator mode" @click=${() => void this.updateOperator(false)} ?disabled=${this.busy}><span>Operator mode</span><span class="mode-switch" aria-hidden="true"></span></button>` : nothing}</div>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${!operator ? html`<div class="empty">Loading operator status…</div>` : !operator.operator ? html`<div class="empty"><p>This chat can coordinate other chats as lanes.</p><p class="hint">Promote it to see their hook-backed status here and give it standing operator instructions.</p><button class="action" @click=${() => void this.updateOperator(true)} ?disabled=${this.busy}>Make this chat an operator</button></div>` : html`
      <div class="summary"><span><strong>${lanes.length}</strong> lanes</span><span><strong>${working}</strong> working</span><span><strong>${attention}</strong> need attention</span></div>
      <div class="lanes">${lanes.length ? lanes.map(lane => html`<article class="lane"><div class="lane-top"><span class="dot ${lane.state}"></span><strong title=${lane.title}>${lane.title}</strong><small>${sdkHarnessLabel(lane.harness)}</small></div><p>${lane.lastActivity || lane.state}</p><div class="progress-line"><span>${lane.laneProgressSource === 'todos' ? 'Todo progress' : 'Turn estimate'}</span><strong>${lane.laneProgress ?? 0}%</strong></div><div class="progress-track" role="progressbar" aria-label=${`${lane.title} progress`} aria-valuenow=${lane.laneProgress ?? 0} aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style=${`width:${lane.laneProgress ?? 0}%`}></div></div>${lane.laneTodos?.length ? html`<ul class="todos">${lane.laneTodos.map(todo => html`<li class=${todo.status === 'completed' || todo.status === 'done' ? 'done' : ''}>${todo.text} · ${todo.status || 'pending'}</li>`)}</ul>` : nothing}${lane.laneReport || lane.lastOutput ? html`<p class="output">${lane.laneReport || lane.lastOutput}</p>` : nothing}<div class="lane-actions"><button @click=${() => this.open(lane.id)}>Open chat</button></div></article>`) : html`<div class="empty"><p>No lanes yet.</p><p class="hint">Ask the operator in chat to start a lane or attach an existing chat.</p></div>`}</div>`}`;
  }
}
