import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { Archive, ArchiveRestore, ChevronRight, Unlink2 } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { chatMarkdownPolicy } from '../lib/chat-markdown-policy.js';
import { icon } from '../lib/icons.js';
import { laneIcon } from '../lib/lane-icon.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import { sdkChats, sdkHarnessLabel, type SDKChat } from '../lib/sdk-chats.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';

type Snapshot = { operator: SDKChat; lanes: SDKChat[] };
type LaneFilter = 'all' | 'attention' | 'running' | 'done';

@customElement('mux-operator-status')
export class MuxOperatorStatus extends LitElement {
  @property() sessionId = '';
  @state() private snapshot?: Snapshot;
  @state() private error = '';
  @state() private expandedLane = '';
  @state() private filter: LaneFilter = 'all';
  @state() private pendingLane = '';
  private poll?: number;
  private requestVersion = 0;

  static styles = css`
    ${subtleScrollbars}
    :host { display:block; width:100%; min-width:0; height:100%; overflow:auto; box-sizing:border-box; padding:18px; background:var(--chrome-body); color:var(--chrome-text-bright); font:12px/1.5 system-ui,sans-serif; }
    * { box-sizing:border-box; }
    h2,p { margin:0; }
    h2 { font-size:17px; line-height:1.25; font-weight:650; }
    .head { margin-bottom:16px; }
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
    .table-scroll { width:100%; min-width:0; overflow:hidden; border:1px solid var(--chrome-border); border-radius:8px; background:var(--chrome-bar); }
    table { width:100%; border-collapse:collapse; table-layout:fixed; }
    col.lane-col { width:auto; }
    col.progress-col { width:196px; }
    col.action-col { width:52px; }
    th { padding:10px 12px 8px; color:var(--chrome-text-dim); font-size:11px; font-weight:500; text-align:left; border-bottom:1px solid var(--chrome-border); }
    td { padding:11px 12px; border-top:1px solid color-mix(in srgb,var(--chrome-border) 65%,transparent); vertical-align:middle; min-width:0; }
    td:last-child { padding:6px 10px 6px 4px; }
    tbody tr:first-child td { border-top:0; }
    tr.lane-row:hover,tr.lane-row.expanded { background:var(--chrome-hover); }
    button { font:inherit; cursor:pointer; }
    button:focus-visible { outline:2px solid var(--chrome-accent); outline-offset:2px; }
    .lane-toggle { display:flex; align-items:center; gap:8px; width:100%; min-width:0; border:0; padding:0; background:none; color:var(--chrome-text-bright); text-align:left; }
    .chevron { display:inline-flex; flex:none; color:var(--chrome-text-dim); transition:transform .15s; }
    .expanded .chevron { transform:rotate(90deg); }
    .lane-primary { display:block; min-width:0; flex:1; }
    .lane-title { min-width:0; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; font-size:12px; }
    .lane-meta { display:flex; align-items:center; gap:8px; margin-top:2px; white-space:nowrap; }
    .harness { color:var(--chrome-text-dim); font-size:10px; }
    .archived-label { color:var(--chrome-accent); }
    .state { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; color:var(--chrome-text-dim); font-size:10px; }
    .state::before { content:''; width:6px; height:6px; flex:none; border-radius:50%; background:currentColor; }
    .state.working,.state.starting { color:var(--chrome-accent); }
    .state.ready { color:var(--mux-ok,#55b981); }
    .state.failed,.state.uncertain,.state.stopped { color:var(--chrome-danger); }
    .progress-cell { text-align:left; }
    .meter { display:grid; gap:4px; width:100%; min-width:0; color:var(--chrome-accent); }
    .meter.ready { color:var(--mux-ok,#55b981); }
    .meter.failed,.meter.uncertain,.meter.stopped { color:var(--chrome-danger); }
    .meter-head { display:flex; align-items:baseline; justify-content:space-between; gap:6px; min-width:0; font-variant-numeric:tabular-nums; }
    .progress-value { color:var(--chrome-text-bright); font-size:12px; font-weight:650; white-space:nowrap; }
    .progress-basis { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--chrome-text-dim); font-size:10px; }
    .track { display:block; height:5px; overflow:hidden; border-radius:6px; background:color-mix(in srgb,var(--chrome-border) 75%,transparent); }
    .fill { display:block; height:100%; border-radius:inherit; background:currentColor; }
    .meter-time { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--chrome-text-dim); font-size:10px; font-variant-numeric:tabular-nums; }
    .open { display:grid; place-items:center; width:32px; height:32px; border:1px solid transparent; border-radius:7px; padding:6px; background:none; color:var(--chrome-text-dim); }
    .open:hover { border-color:var(--chrome-border); background:var(--chrome-hover); color:var(--chrome-accent); }
    .open:focus-visible { color:var(--chrome-accent); }
    .detail td { padding:0 12px 11px 32px; background:color-mix(in srgb,var(--chrome-hover) 55%,var(--chrome-bar)); border-top:0; }
    .message { padding:12px 0 13px; border-top:1px solid var(--chrome-border); color:var(--chrome-text-bright); font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
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
    .detail-actions { display:flex; flex-wrap:wrap; align-items:center; gap:12px; border-top:1px solid var(--chrome-border); padding:8px 0 0; }
    .detail-actions button { display:inline-flex; align-items:center; gap:5px; min-height:25px; border:0; border-radius:4px; padding:2px 0; background:none; color:var(--chrome-text-dim); font-size:11px; }
    .detail-actions button:hover { color:var(--chrome-text-bright); }
    .detail-actions button:disabled { opacity:.5; cursor:default; }
    .detail-actions .archive-action { margin-left:auto; }
    @media(max-width:560px) { :host { padding:12px; } col.progress-col { width:122px; } col.action-col { width:40px; } th,td { padding-left:7px; padding-right:7px; } td:last-child { padding:6px 4px; } .lane-toggle { gap:3px; } .meter-time { display:none; } .progress-basis { font-size:9px; } }
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
      if (this.sessionId === operatorId && this.snapshot) this.snapshot = { ...this.snapshot, lanes:this.snapshot.lanes.map(row => row.id === lane.id ? { ...row, archived } : row) };
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
  private timingDisplay(lane: SDKChat) {
    const timing = lane.timing;
    if (this.isStopped(lane)) return '';
    if (lane.state === 'ready') return timing?.actualSeconds ? this.duration(timing.actualSeconds) : '';
    if (lane.state !== 'working' && lane.state !== 'starting') return '';
    if (timing?.remainingLowSeconds !== undefined && timing.remainingHighSeconds !== undefined) return `~${this.duration(timing.remainingLowSeconds)}–${this.duration(timing.remainingHighSeconds)} left`;
    if (timing?.sampleSize && timing.effortLowSeconds !== undefined && timing.effortHighSeconds !== undefined && !timing.elapsedSeconds) return `~${this.duration(timing.effortLowSeconds)}–${this.duration(timing.effortHighSeconds)} total`;
    return '';
  }
  private timingHelp(lane: SDKChat) {
    if (this.isStopped(lane)) return 'The latest turn was stopped.';
    if (lane.state === 'ready') return lane.timing?.actualSeconds ? 'Elapsed time for the latest completed turn.' : 'Elapsed time is unavailable for this turn.';
    if (lane.state !== 'working' && lane.state !== 'starting') return 'No estimate for this lane state.';
    const timing = lane.timing;
    if (!timing || timing.sampleSize < 8) return 'No estimate: fewer than eight completed turns.';
    return `Approximate range from ${timing.sampleSize} ${timing.broadHistory ? 'recent' : 'similar'} completed turns. Time may vary.`;
  }
  private progress(lane: SDKChat) {
    const done = lane.laneTodos?.filter(todo => todo.status === 'completed' || todo.status === 'done').length || 0;
    const total = lane.laneTodos?.length || 0;
    if (total > 0) {
      const percent = done === total ? 100 : Math.min(99, Math.round(done / total * 100));
      return { percent, value:`${percent}%`, basis:`${done}/${total} tasks`, help:`${done} of ${total} reported tasks complete.` };
    }
    if (lane.state === 'ready' && lane.lastTurnOutcome === 'completed') {
      return { percent:100, value:'100%', basis:'run ended', help:'The latest turn completed. No task list was reported.' };
    }
    const timing = lane.timing;
    const elapsed = timing?.elapsedSeconds || 0;
    if ((lane.state === 'working' || lane.state === 'starting') && timing && timing.sampleSize >= 8 && (timing.survivorCount || 0) >= 5 && elapsed > 0 && timing.remainingLowSeconds !== undefined && timing.remainingHighSeconds !== undefined) {
      const remainingMidpoint = (timing.remainingLowSeconds + timing.remainingHighSeconds) / 2;
      const percent = Math.min(90, Math.max(5, Math.round(elapsed / (elapsed + remainingMidpoint) * 100)));
      return { percent, value:`~${percent}%`, basis:'time estimate', help:`Approximate time-based progress from ${timing.sampleSize} completed turns, bounded to 5–90%. This does not measure completed tasks. ${this.timingHelp(lane)}` };
    }
    return { percent:0, value:'—', basis:'unknown', help:'No completed task count or reliable progress estimate is available.' };
  }
  private meter(lane: SDKChat) {
    const progress = this.progress(lane);
    const time = this.timingDisplay(lane);
    return html`<div class="meter ${this.isStopped(lane) ? 'stopped' : lane.state}" aria-label=${`${lane.title}: ${progress.value}, ${progress.basis}. ${progress.help}`} title=${progress.help}>
      <span class="meter-head"><span class="progress-value">${progress.value}</span><span class="progress-basis">${progress.basis}</span></span>
      <span class="track" aria-hidden="true"><span class="fill" style=${`width:${progress.percent}%`}></span></span>
      ${time ? html`<span class="meter-time">${time}</span>` : nothing}
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
          <colgroup><col class="lane-col"><col class="progress-col"><col class="action-col"></colgroup>
          <thead><tr><th scope="col">Lane</th><th scope="col">Progress</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead>
          <tbody>${visible.map(lane => {
            const expanded = this.expandedLane === lane.id;
            const detailId = `operator-lane-${lane.id}`;
            return html`<tr class="lane-row ${expanded ? 'expanded' : ''}">
              <td><button class="lane-toggle" aria-label=${`${expanded ? 'Collapse' : 'Expand'} ${lane.title}`} aria-expanded=${expanded} aria-controls=${detailId} @click=${() => { this.expandedLane = expanded ? '' : lane.id; }}><span class="chevron" aria-hidden="true">${icon(ChevronRight,{size:14})}</span><span class="lane-primary" title=${lane.title}><span class="lane-title">${lane.title}</span><span class="lane-meta"><span class="harness">${sdkHarnessLabel(lane.harness)}</span><span class="state ${this.isStopped(lane) ? 'stopped' : lane.state}">${this.isStopped(lane) ? 'Stopped' : lane.state === 'ready' ? 'Ready' : lane.state === 'uncertain' ? 'Uncertain' : lane.state === 'starting' ? 'Starting' : lane.state === 'failed' ? 'Failed' : 'Working'}</span>${lane.archived ? html`<span class="archived-label">Archived</span>` : nothing}</span></span></button></td>
              <td class="progress-cell">${this.meter(lane)}</td>
              <td><button class="open" aria-label=${`Open lane chat: ${lane.title}`} title="Open lane chat" @click=${() => this.open(lane.id)}>${laneIcon(17)}</button></td>
            </tr>${expanded ? html`<tr class="detail"><td colspan="3"><div class="message" id=${detailId}>${this.message(lane)}</div>
              <div class="detail-actions"><button aria-label=${`Unlink ${lane.title} from operator`} ?disabled=${!!this.pendingLane} @click=${() => void this.unlink(lane)}>${icon(Unlink2,{size:13})} Unlink lane</button>
                <button class="archive-action" aria-label=${`${lane.archived ? 'Restore' : 'Archive'} chat ${lane.title}`} ?disabled=${!!this.pendingLane} @click=${() => void this.setArchived(lane, !lane.archived)}>${icon(lane.archived ? ArchiveRestore : Archive,{size:13})} ${lane.archived ? 'Restore chat' : 'Archive chat'}</button></div>
            </td></tr>` : nothing}`;
          })}</tbody>
        </table></div>` : html`<div class="empty">${this.filter === 'attention' ? 'No lanes need attention.' : this.filter === 'running' ? 'No lanes are running.' : 'No lanes are done yet.'}</div>`}` : html`<div class="empty"><p>No lanes yet.</p><p class="hint">Ask the operator in chat to start a lane or attach an existing chat.</p></div>`}`}`;
  }
}
