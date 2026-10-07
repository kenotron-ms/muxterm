import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ArrowUpRight, ChevronRight } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { chatMarkdownPolicy } from '../lib/chat-markdown-policy.js';
import { icon } from '../lib/icons.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import { sdkHarnessLabel, type SDKChat } from '../lib/sdk-chats.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';

type Snapshot = { operator: SDKChat; lanes: SDKChat[] };
const barHeights = [7, 11, 8, 14, 10, 16, 9, 13, 11, 17, 12, 15];

@customElement('mux-operator-status')
export class MuxOperatorStatus extends LitElement {
  @property() sessionId = '';
  @state() private snapshot?: Snapshot;
  @state() private error = '';
  @state() private expandedLane = '';
  private poll?: number;

  static styles = css`
    ${subtleScrollbars}
    :host { display:block; height:100%; overflow:auto; box-sizing:border-box; padding:20px; background:var(--chrome-body); color:var(--chrome-text-bright); font:12px/1.5 system-ui,sans-serif; }
    * { box-sizing:border-box; }
    h2,p { margin:0; }
    h2 { font-size:17px; line-height:1.25; font-weight:650; }
    .head { margin-bottom:17px; }
    .head p,.hint { margin-top:4px; color:var(--chrome-text-dim); }
    .summary { margin:0 0 12px; color:var(--chrome-text-dim); font-variant-numeric:tabular-nums; }
    .summary strong { color:var(--chrome-text-bright); font-weight:650; }
    .summary .sep { padding:0 7px; color:var(--chrome-border); }
    .error { padding:9px; margin-bottom:12px; border:1px solid var(--chrome-danger); border-radius:7px; color:var(--chrome-danger); white-space:pre-wrap; }
    .empty { padding:24px 14px; border:1px dashed var(--chrome-border); border-radius:9px; color:var(--chrome-text-dim); text-align:center; }
    .empty .hint { margin-top:7px; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    .table-scroll { width:100%; overflow-x:auto; border:1px solid var(--chrome-border); border-radius:9px; background:var(--chrome-bar); }
    table { width:100%; min-width:390px; border-collapse:collapse; table-layout:fixed; }
    col.lane-col { width:auto; }
    col.state-col { width:76px; }
    col.progress-col { width:101px; }
    col.action-col { width:36px; }
    th { padding:9px 10px 7px; color:var(--chrome-text-dim); font-size:11px; font-weight:500; text-align:left; border-bottom:1px solid var(--chrome-border); }
    th:nth-child(3) { text-align:right; }
    td { padding:9px 10px; border-top:1px solid color-mix(in srgb,var(--chrome-border) 65%,transparent); vertical-align:middle; }
    tbody tr:first-child td { border-top:0; }
    tr.lane-row:hover,tr.lane-row.expanded { background:var(--chrome-hover); }
    button { font:inherit; cursor:pointer; }
    button:focus-visible { outline:2px solid var(--chrome-accent); outline-offset:2px; }
    .lane-toggle { display:flex; align-items:center; gap:6px; width:100%; min-width:0; border:0; padding:0; background:none; color:var(--chrome-text-bright); text-align:left; }
    .chevron { display:inline-flex; flex:none; color:var(--chrome-text-dim); transition:transform .15s; }
    .expanded .chevron { transform:rotate(90deg); }
    .lane-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    .harness { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--chrome-text-dim); font-size:10px; }
    .state { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; color:var(--chrome-text-dim); font-size:11px; }
    .state::before { content:''; width:6px; height:6px; flex:none; border-radius:50%; background:currentColor; }
    .state.working,.state.starting { color:var(--chrome-accent); }
    .state.ready { color:var(--mux-ok,#55b981); }
    .state.failed,.state.uncertain { color:var(--chrome-danger); }
    .progress-cell { text-align:right; }
    .meter { display:inline-flex; align-items:center; justify-content:flex-end; gap:7px; width:100%; color:var(--chrome-accent); }
    .meter.ready { color:var(--mux-ok,#55b981); }
    .meter.failed,.meter.uncertain { color:var(--chrome-danger); }
    .bars { display:inline-flex; align-items:end; gap:2px; height:17px; }
    .bars span { display:block; width:3px; flex:none; border-radius:2px 2px 0 0; background:color-mix(in srgb,var(--chrome-border) 82%,transparent); }
    .bars span.filled { background:currentColor; }
    .percent { min-width:29px; color:var(--chrome-text-dim); font-size:10px; font-variant-numeric:tabular-nums; }
    .open { display:grid; place-items:center; width:24px; height:24px; border:0; border-radius:5px; padding:0; background:none; color:var(--chrome-text-dim); }
    .open:hover { background:var(--chrome-hover); color:var(--chrome-accent); }
    .detail td { padding:0 11px 13px 28px; background:var(--chrome-hover); border-top:0; }
    .message { padding:10px 11px; border-left:2px solid var(--chrome-accent); background:var(--chrome-bar); color:var(--chrome-text-bright); font-size:12px; line-height:1.55; overflow-wrap:anywhere; }
    .message > :first-child,.message .md-p:first-child { margin-top:0; }
    .message > :last-child,.message .md-p:last-child { margin-bottom:0; }
    .message .md-p { margin:0 0 9px; }
    .message .md-h { margin:12px 0 6px; font-size:13px; line-height:1.3; }
    .message .md-ul,.message .md-ol { margin:6px 0 9px; padding-left:20px; }
    .message .md-li { margin:3px 0; }
    .message .md-code { padding:1px 3px; border-radius:3px; background:var(--chrome-hover); font:11px ui-monospace,monospace; }
    .message .md-pre { max-width:100%; overflow:auto; padding:8px; border-radius:5px; background:var(--chrome-body); font:11px/1.45 ui-monospace,monospace; }
    .message .md-quote { margin:7px 0; padding-left:9px; border-left:2px solid var(--chrome-border); color:var(--chrome-text-dim); }
    .message .md-link { color:var(--chrome-accent); }
    .message .md-img { max-width:100%; max-height:240px; object-fit:contain; }
    .message .md-tablewrap { max-width:100%; overflow:auto; }
    .message .md-table { border-collapse:collapse; }
    .message .md-th,.message .md-td { padding:4px 7px; border:1px solid var(--chrome-border); }
    .message-placeholder { color:var(--chrome-text-dim); }
    @media(max-width:470px) { :host { padding:14px; } }
    @media(prefers-reduced-motion:reduce) { .chevron { transition:none; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.poll = window.setInterval(() => { if (!document.hidden) void this.load(); }, 2500);
  }
  override disconnectedCallback() {
    if (this.poll) window.clearInterval(this.poll);
    super.disconnectedCallback();
  }
  override updated(changed: Map<string, unknown>) {
    if (changed.has('sessionId')) {
      this.snapshot = undefined;
      this.expandedLane = '';
      void this.load();
    }
  }
  private async load() {
    const id = this.sessionId;
    if (!id) return;
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}/operator`), { cache:'no-store' });
      if (!response.ok) throw new Error(await response.text());
      const snapshot = await response.json() as Snapshot;
      if (this.sessionId === id) { this.snapshot = snapshot; this.error = ''; }
    } catch (error) { if (this.sessionId === id) this.error = String(error); }
  }
  private open(id: string) {
    this.dispatchEvent(new CustomEvent('chat-open', { detail:{sessionId:id}, bubbles:true, composed:true }));
  }
  private message(lane: SDKChat) {
    const latest = lane.laneReport || lane.lastOutput;
    return latest
      ? renderSegments(new MarkdownStream().update(latest, false), chatMarkdownPolicy)
      : html`<p class="message-placeholder">No message from this lane yet.</p>`;
  }
  private meter(lane: SDKChat) {
    const percent = Math.max(0, Math.min(100, lane.laneProgress ?? 0));
    const source = lane.laneProgressSource === 'todos' ? 'Todo progress' : 'Turn estimate';
    return html`<div class="meter ${lane.state}" role="progressbar" aria-label=${`${lane.title}: ${source}`} aria-valuenow=${percent} aria-valuemin="0" aria-valuemax="100" title=${`${source}: ${percent}%`}>
      <span class="bars" aria-hidden="true">${barHeights.map((height, index) => html`<span class=${index < Math.ceil(percent * barHeights.length / 100) ? 'filled' : ''} style=${`height:${height}px`}></span>`)}</span>
      <span class="percent" aria-hidden="true">${percent}%</span>
    </div>`;
  }
  override render() {
    const operator = this.snapshot?.operator;
    const lanes = this.snapshot?.lanes || [];
    const attention = lanes.filter(chat => chat.state === 'failed' || chat.state === 'uncertain').length;
    const working = lanes.filter(chat => chat.state === 'working' || chat.state === 'starting').length;
    return html`<div class="head"><h2>Operator status</h2><p>Lane progress and latest replies.</p></div>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${!operator ? html`<div class="empty">Loading operator status…</div>` : !operator.operator ? html`<div class="empty"><p>Operator mode is off.</p><p class="hint">Turn it on from the permission and mode menu in the chat composer.</p></div>` : html`
        <p class="summary"><strong>${lanes.length}</strong> lanes<span class="sep">/</span><strong>${working}</strong> working<span class="sep">/</span><strong>${attention}</strong> need attention</p>
        ${lanes.length ? html`<div class="table-scroll"><table aria-label="Operator lanes">
          <colgroup><col class="lane-col"><col class="state-col"><col class="progress-col"><col class="action-col"></colgroup>
          <thead><tr><th scope="col">Lane</th><th scope="col">State</th><th scope="col">Progress</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead>
          <tbody>${lanes.map(lane => {
            const expanded = this.expandedLane === lane.id;
            const detailId = `operator-lane-${lane.id}`;
            return html`<tr class="lane-row ${expanded ? 'expanded' : ''}">
              <td><button class="lane-toggle" aria-label=${`${expanded ? 'Collapse' : 'Expand'} ${lane.title}`} aria-expanded=${expanded} aria-controls=${detailId} @click=${() => { this.expandedLane = expanded ? '' : lane.id; }}><span class="chevron" aria-hidden="true">${icon(ChevronRight,{size:14})}</span><span class="lane-name" title=${lane.title}>${lane.title}<span class="harness">${sdkHarnessLabel(lane.harness)}</span></span></button></td>
              <td><span class="state ${lane.state}">${lane.state === 'ready' ? 'Ready' : lane.state === 'uncertain' ? 'Uncertain' : lane.state === 'starting' ? 'Starting' : lane.state === 'failed' ? 'Failed' : 'Working'}</span></td>
              <td class="progress-cell">${this.meter(lane)}</td>
              <td><button class="open" aria-label=${`Open chat: ${lane.title}`} title="Open chat" @click=${() => this.open(lane.id)}>${icon(ArrowUpRight,{size:15})}</button></td>
            </tr>${expanded ? html`<tr class="detail"><td colspan="4"><div class="message" id=${detailId}>${this.message(lane)}</div></td></tr>` : nothing}`;
          })}</tbody>
        </table></div>` : html`<div class="empty"><p>No lanes yet.</p><p class="hint">Ask the operator in chat to start a lane or attach an existing chat.</p></div>`}`}`;
  }
}
