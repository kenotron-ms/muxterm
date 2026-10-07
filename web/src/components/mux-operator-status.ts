import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { Archive, ArchiveRestore, ArrowUpRight, ChevronRight, Unlink2 } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { chatMarkdownPolicy } from '../lib/chat-markdown-policy.js';
import { icon } from '../lib/icons.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import { sdkChats, sdkHarnessLabel, type SDKChat } from '../lib/sdk-chats.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';

type Snapshot = { operator: SDKChat; lanes: SDKChat[] };
type LaneFilter = 'all' | 'attention' | 'running' | 'done';
const barHeights = [7, 11, 8, 14, 10, 16, 9, 13, 11, 17, 12, 15];

@customElement('mux-operator-status')
export class MuxOperatorStatus extends LitElement {
  @property() sessionId = '';
  @state() private snapshot?: Snapshot;
  @state() private error = '';
  @state() private expandedLane = '';
  @state() private filter: LaneFilter = 'all';
  @state() private archiveConfirmLane = '';
  @state() private pendingLane = '';
  private poll?: number;
  private requestVersion = 0;

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
    .filters { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 12px; }
    .filter { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--chrome-border); border-radius:6px; padding:4px 8px; background:transparent; color:var(--chrome-text-dim); font-size:11px; }
    .filter:hover { background:var(--chrome-hover); color:var(--chrome-text-bright); }
    .filter.active { border-color:color-mix(in srgb,var(--chrome-accent) 50%,var(--chrome-border)); background:color-mix(in srgb,var(--chrome-accent) 10%,transparent); color:var(--chrome-text-bright); }
    .filter-count { color:var(--chrome-text-dim); font-variant-numeric:tabular-nums; }
    .error { padding:9px; margin-bottom:12px; border:1px solid var(--chrome-danger); border-radius:7px; color:var(--chrome-danger); white-space:pre-wrap; }
    .empty { padding:24px 14px; border:1px dashed var(--chrome-border); border-radius:9px; color:var(--chrome-text-dim); text-align:center; }
    .empty .hint { margin-top:7px; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    .table-scroll { width:100%; overflow-x:auto; border:1px solid var(--chrome-border); border-radius:9px; background:var(--chrome-bar); }
    table { width:100%; min-width:390px; border-collapse:collapse; table-layout:fixed; }
    col.lane-col { width:auto; }
    col.state-col { width:76px; }
    col.progress-col { width:145px; }
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
    .archived-label { color:var(--chrome-accent); }
    .state { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; color:var(--chrome-text-dim); font-size:11px; }
    .state::before { content:''; width:6px; height:6px; flex:none; border-radius:50%; background:currentColor; }
    .state.working,.state.starting { color:var(--chrome-accent); }
    .state.ready { color:var(--mux-ok,#55b981); }
    .state.failed,.state.uncertain,.state.stopped { color:var(--chrome-danger); }
    .progress-cell { text-align:right; }
    .meter { display:inline-flex; align-items:center; justify-content:flex-end; gap:7px; width:100%; color:var(--chrome-accent); }
    .meter.ready { color:var(--mux-ok,#55b981); }
    .meter.failed,.meter.uncertain,.meter.stopped { color:var(--chrome-danger); }
    .bars { display:inline-flex; align-items:end; gap:2px; height:17px; }
    .bars span { display:block; width:3px; flex:none; border-radius:2px 2px 0 0; background:color-mix(in srgb,var(--chrome-border) 82%,transparent); }
    .bars span.filled { background:currentColor; }
    .time-label { min-width:75px; color:var(--chrome-text-dim); font-size:10px; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .timing-note { margin:0 0 8px; color:var(--chrome-text-dim); font-size:11px; line-height:1.45; }
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
    .detail-actions { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:9px 0 0; }
    .detail-actions button,.archive-confirm button { display:inline-flex; align-items:center; gap:5px; min-height:26px; border:1px solid var(--chrome-border); border-radius:5px; padding:3px 7px; background:var(--chrome-bar); color:var(--chrome-text-dim); font-size:11px; }
    .detail-actions button:hover,.archive-confirm button:hover { background:var(--chrome-body); color:var(--chrome-text-bright); }
    .detail-actions button:disabled,.archive-confirm button:disabled { opacity:.5; cursor:default; }
    .detail-actions .archive-action { margin-left:auto; }
    .archive-confirm { margin-top:9px; padding:9px 10px; border:1px solid color-mix(in srgb,var(--chrome-danger) 38%,var(--chrome-border)); border-radius:6px; background:var(--chrome-bar); }
    .archive-confirm p { margin:0 0 8px; color:var(--chrome-text-bright); }
    .archive-confirm .buttons { display:flex; gap:6px; }
    .archive-confirm .confirm-archive { border-color:var(--chrome-danger); color:var(--chrome-danger); }
    .archive-confirm .confirm-archive:hover { background:color-mix(in srgb,var(--chrome-danger) 12%,var(--chrome-bar)); color:var(--chrome-danger); }
    @media(max-width:470px) { :host { padding:14px; } }
    @media(prefers-reduced-motion:reduce) { .chevron { transition:none; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.poll = window.setInterval(() => { if (!document.hidden) void this.load(); }, 2500);
  }
  override disconnectedCallback() {
    if (this.poll) window.clearInterval(this.poll);
    this.requestVersion++;
    super.disconnectedCallback();
  }
  override updated(changed: Map<string, unknown>) {
    if (changed.has('sessionId')) {
      this.requestVersion++;
      this.snapshot = undefined;
      this.expandedLane = '';
      this.archiveConfirmLane = '';
      this.filter = 'all';
      this.error = '';
      void this.load();
    }
  }
  private async load() {
    const id = this.sessionId;
    if (!id || this.pendingLane) return;
    const version = ++this.requestVersion;
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}/operator`), { cache:'no-store' });
      if (!response.ok) throw new Error(await response.text());
      const snapshot = await response.json() as Snapshot;
      if (this.sessionId === id && version === this.requestVersion) {
        this.snapshot = snapshot;
        if (this.expandedLane && !snapshot.lanes.some(lane => lane.id === this.expandedLane)) this.expandedLane = '';
        this.error = '';
      }
    } catch (error) { if (this.sessionId === id && version === this.requestVersion) this.error = String(error); }
  }
  private chooseFilter(filter: LaneFilter) {
    this.filter = filter;
    this.expandedLane = '';
    this.archiveConfirmLane = '';
  }
  private async unlink(lane: SDKChat) {
    if (this.pendingLane) return;
    const operatorId = this.sessionId;
    this.requestVersion++;
    this.pendingLane = lane.id;
    this.error = '';
    try {
      const operator = await sdkChats.unlinkOperatorLane(operatorId, lane.id);
      if (this.sessionId === operatorId) {
        this.snapshot = { operator, lanes:(this.snapshot?.lanes || []).filter(row => row.id !== lane.id) };
        this.expandedLane = '';
        this.archiveConfirmLane = '';
      }
    } catch (error) { if (this.sessionId === operatorId) this.error = `Could not unlink lane: ${String(error)}`; }
    finally { this.pendingLane = ''; void this.load(); }
  }
  private async setArchived(lane: SDKChat, archived: boolean) {
    if (this.pendingLane) return;
    const operatorId = this.sessionId;
    this.requestVersion++;
    this.pendingLane = lane.id;
    this.error = '';
    try {
      await sdkChats.setArchived(lane.id, archived);
      if (this.sessionId === operatorId) this.archiveConfirmLane = '';
    } catch (error) { if (this.sessionId === operatorId) this.error = `Could not ${archived ? 'archive' : 'restore'} chat: ${String(error)}`; }
    finally { this.pendingLane = ''; void this.load(); }
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
  private duration(seconds: number) {
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600 * 10) / 10}h`;
  }
  private timingLabel(lane: SDKChat) {
    const timing = lane.timing;
    if (this.isStopped(lane)) return 'Stopped';
    if (lane.state === 'ready') return timing?.actualSeconds ? `Done in ${this.duration(timing.actualSeconds)}` : 'Done';
    if (lane.state !== 'working' && lane.state !== 'starting') return 'Time unknown';
    if (timing?.remainingLowSeconds !== undefined && timing.remainingHighSeconds !== undefined) return `~${this.duration(timing.remainingLowSeconds)}–${this.duration(timing.remainingHighSeconds)} left`;
    if (timing?.sampleSize && timing.effortLowSeconds !== undefined && timing.effortHighSeconds !== undefined && !timing.elapsedSeconds) return `~${this.duration(timing.effortLowSeconds)}–${this.duration(timing.effortHighSeconds)}`;
    return timing?.sampleSize ? 'Time uncertain' : 'No history yet';
  }
  private timingNote(lane: SDKChat) {
    const timing = lane.timing;
    if (!timing || timing.sampleSize < 8) return 'Timing unavailable: fewer than eight completed human turns in recent history. Whole goal runs have too little history for a separate estimate.';
    const category = { review:'review', focused:'focused change', cross_stack:'cross-stack change', operational:'operational change' }[timing.category];
    const source = { openai_decisions:'OpenAI Decisions', anthropic:'Anthropic', historical_only:'request wording' }[timing.classification];
    const basis = timing.broadHistory ? 'all request types (too few comparable examples)' : `comparable ${category} requests`;
    const range = `${this.duration(timing.effortLowSeconds || 0)}–${this.duration(timing.effortHighSeconds || 0)}`;
    const elapsed = timing.elapsedSeconds ? ` Elapsed: ${this.duration(timing.elapsedSeconds)}.` : '';
    const remaining = timing.elapsedSeconds && (timing.survivorCount || 0) < 5 ? ' Too few longer examples remain for a useful remaining-time range.' : timing.survivorCount ? ` Remaining range uses ${timing.survivorCount} examples that ran longer than elapsed time.` : '';
    return `Timing basis: ${timing.sampleSize} completed human turns in the last 180 days, ${basis}; observed middle 80%: ${range}. Classified by ${source}.${elapsed}${remaining} Turn timing is an uncertain guide to this work; whole goal runs have too little history for a separate estimate.`;
  }
  private meter(lane: SDKChat) {
    const done = lane.laneTodos?.filter(todo => todo.status === 'completed' || todo.status === 'done').length || 0;
    const total = lane.laneTodos?.length || 0;
    const todoCount = total > 0;
    const elapsed = lane.timing?.elapsedSeconds || 0;
    const high = lane.timing?.effortHighSeconds || 0;
    const filled = todoCount ? Math.round(done / total * barHeights.length) : lane.state === 'ready' && !this.isStopped(lane) ? barHeights.length : lane.state === 'working' && high > 0 ? Math.min(barHeights.length, Math.max(1, Math.round(elapsed / high * barHeights.length))) : lane.state === 'working' ? 1 : 0;
    const label = todoCount ? `${done}/${total} tasks` : this.timingLabel(lane);
    const meaning = todoCount ? 'completed tasks' : lane.state === 'working' && high > 0 ? 'elapsed time against the upper historical range; not percent complete' : 'lane state';
    return html`<div class="meter ${this.isStopped(lane) ? 'stopped' : lane.state}" aria-label=${`${lane.title}: ${label}; bars show ${meaning}`} title=${meaning}>
      <span class="bars" aria-hidden="true">${barHeights.map((height, index) => html`<span class=${index < filled ? 'filled' : ''} style=${`height:${height}px`}></span>`)}</span>
      <span class="time-label">${label}</span>
    </div>`;
  }
  private filterButton(value: LaneFilter, label: string, count: number) {
    return html`<button class="filter ${this.filter === value ? 'active' : ''}" aria-pressed=${this.filter === value} @click=${() => this.chooseFilter(value)}>${label}<span class="filter-count">${count}</span></button>`;
  }
  private isStopped(lane: SDKChat) {
    return lane.state === 'ready' && lane.lastTurnOutcome === 'cancelled';
  }
  private needsAttention(lane: SDKChat) {
    return lane.state === 'failed' || lane.state === 'uncertain' || this.isStopped(lane);
  }
  override render() {
    const operator = this.snapshot?.operator;
    const lanes = this.snapshot?.lanes || [];
    const attention = lanes.filter(chat => this.needsAttention(chat)).length;
    const working = lanes.filter(chat => chat.state === 'working' || chat.state === 'starting').length;
    const done = lanes.filter(chat => chat.state === 'ready' && !this.isStopped(chat)).length;
    const visible = lanes.filter(chat => this.filter === 'all' || (this.filter === 'attention' ? this.needsAttention(chat) : this.filter === 'running' ? chat.state === 'working' || chat.state === 'starting' : chat.state === 'ready' && !this.isStopped(chat)));
    return html`<div class="head"><h2>Operator status</h2><p>Lane work, timing ranges, and latest replies.</p></div>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${!operator ? html`<div class="empty">Loading operator status…</div>` : !operator.operator ? html`<div class="empty"><p>Operator mode is off.</p><p class="hint">Turn it on from the permission and mode menu in the chat composer.</p></div>` : html`
        <p class="summary"><strong>${lanes.length}</strong> lanes<span class="sep">/</span><strong>${working}</strong> working<span class="sep">/</span><strong>${attention}</strong> need attention</p>
        ${lanes.length ? html`<div class="filters" role="group" aria-label="Filter operator lanes">
          ${this.filterButton('all', 'All', lanes.length)}
          ${this.filterButton('attention', 'Needs attention', attention)}
          ${this.filterButton('running', 'Running', working)}
          ${this.filterButton('done', 'Done', done)}
        </div>${visible.length ? html`<div class="table-scroll"><table aria-label="Operator lanes">
          <colgroup><col class="lane-col"><col class="state-col"><col class="progress-col"><col class="action-col"></colgroup>
          <thead><tr><th scope="col">Lane</th><th scope="col">State</th><th scope="col">Time / tasks</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead>
          <tbody>${visible.map(lane => {
            const expanded = this.expandedLane === lane.id;
            const detailId = `operator-lane-${lane.id}`;
            return html`<tr class="lane-row ${expanded ? 'expanded' : ''}">
              <td><button class="lane-toggle" aria-label=${`${expanded ? 'Collapse' : 'Expand'} ${lane.title}`} aria-expanded=${expanded} aria-controls=${detailId} @click=${() => { this.expandedLane = expanded ? '' : lane.id; this.archiveConfirmLane = ''; }}><span class="chevron" aria-hidden="true">${icon(ChevronRight,{size:14})}</span><span class="lane-name" title=${lane.title}>${lane.title}<span class="harness">${sdkHarnessLabel(lane.harness)}${lane.archived ? html` <span class="archived-label">· Archived</span>` : nothing}</span></span></button></td>
              <td><span class="state ${this.isStopped(lane) ? 'stopped' : lane.state}">${this.isStopped(lane) ? 'Stopped' : lane.state === 'ready' ? 'Ready' : lane.state === 'uncertain' ? 'Uncertain' : lane.state === 'starting' ? 'Starting' : lane.state === 'failed' ? 'Failed' : 'Working'}</span></td>
              <td class="progress-cell">${this.meter(lane)}</td>
              <td><button class="open" aria-label=${`Open chat: ${lane.title}`} title="Open chat" @click=${() => this.open(lane.id)}>${icon(ArrowUpRight,{size:15})}</button></td>
            </tr>${expanded ? html`<tr class="detail"><td colspan="4"><p class="timing-note">${this.timingNote(lane)}</p><div class="message" id=${detailId}>${this.message(lane)}</div>
              <div class="detail-actions"><button aria-label=${`Unlink ${lane.title} from operator`} ?disabled=${!!this.pendingLane} @click=${() => void this.unlink(lane)}>${icon(Unlink2,{size:13})} Unlink lane</button>
                <button class="archive-action" aria-label=${`${lane.archived ? 'Restore' : 'Archive'} chat ${lane.title}`} ?disabled=${!!this.pendingLane} @click=${() => lane.archived ? void this.setArchived(lane, false) : this.archiveConfirmLane = lane.id}>${icon(lane.archived ? ArchiveRestore : Archive,{size:13})} ${lane.archived ? 'Restore chat' : 'Archive chat'}</button></div>
              ${this.archiveConfirmLane === lane.id && !lane.archived ? html`<div class="archive-confirm"><p>Archive “${lane.title}”? It stays linked here and can keep reporting.</p><div class="buttons"><button @click=${() => { this.archiveConfirmLane = ''; }}>Cancel</button><button class="confirm-archive" ?disabled=${!!this.pendingLane} @click=${() => void this.setArchived(lane, true)}>Archive chat</button></div></div>` : nothing}
            </td></tr>` : nothing}`;
          })}</tbody>
        </table></div>` : html`<div class="empty">${this.filter === 'attention' ? 'No lanes need attention.' : this.filter === 'running' ? 'No lanes are running.' : 'No lanes are done yet.'}</div>`}` : html`<div class="empty"><p>No lanes yet.</p><p class="hint">Ask the operator in chat to start a lane or attach an existing chat.</p></div>`}`}`;
  }
}
