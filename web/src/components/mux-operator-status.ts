import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { Archive, ArchiveRestore, Check, Circle, LoaderCircle, ChevronRight, Unlink2 } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { chatMarkdownPolicy } from '../lib/chat-markdown-policy.js';
import { icon } from '../lib/icons.js';
import { laneIcon } from '../lib/lane-icon.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import { sdkChats, sdkHarnessLabel, type SDKChat } from '../lib/sdk-chats.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import '../ui/button.js';
import '../ui/feedback.js';
import '../ui/filter-chip.js';
import '../ui/status-badge.js';
import type { StatusTone } from '../ui/status-badge.js';
import { visuallyHidden } from '../ui/visually-hidden.js';

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
  private unsubscribeChats?: () => void;

  static styles = css`
    ${subtleScrollbars}
    :host { display:block; width:100%; min-width:0; height:100%; overflow:auto; box-sizing:border-box; padding:var(--ui-space-7); background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-md)/1.5 var(--ui-font-sans); }
    * { box-sizing:border-box; }
    h2,p { margin:0; }
    h2 { font-size:var(--ui-text-xl); line-height:1.25; font-weight:650; }
    .head { margin-bottom:var(--ui-space-6); }
    .head p,.hint { margin-top:var(--ui-space-2); color:var(--ui-text-muted); }
    .checklist { list-style:none; margin:var(--ui-space-6) 0; padding:0; font:var(--ui-text-xl)/1.5 var(--ui-font-sans); }
    .todo { display:flex; align-items:baseline; gap:var(--ui-space-5); padding:var(--ui-space-5) 0; border-bottom:1px solid var(--ui-border); overflow-wrap:anywhere; }
    .todo-icon { display:inline-flex; flex:none; align-self:flex-start; margin-top:var(--ui-space-2); }
    .todo-label { min-width:0; }
    .todo-state { display:block; color:var(--ui-text-muted); font-size:inherit; }
    .todo.completed .todo-icon { color:var(--ui-success); }
    .todo.in_progress { color:var(--ui-accent); }
    .self-progress { max-width:var(--ui-operator-summary-width); font:var(--ui-text-xl)/1.5 var(--ui-font-sans); }
    .self-progress progress { display:block; width:100%; height:var(--ui-progress-height); margin-top:var(--ui-space-4); accent-color:var(--ui-accent); }
    .summary { margin:0 0 var(--ui-space-5); color:var(--ui-text-muted); font-variant-numeric:tabular-nums; }
    .summary strong { color:var(--ui-text); font-weight:650; }
    .summary .sep { padding:0 var(--ui-space-3); color:var(--ui-border); }
    .filters { display:flex; flex-wrap:wrap; gap:var(--ui-space-3); margin:0 0 var(--ui-space-5); }
    mux-ui-feedback { margin-bottom:var(--ui-space-5); }
    mux-ui-feedback .hint { margin-top:var(--ui-space-3); }
    .sr-only { ${visuallyHidden} }
    .table-scroll { width:100%; min-width:0; overflow:hidden; border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); }
    table { width:100%; border-collapse:collapse; table-layout:fixed; }
    col.lane-col { width:auto; }
    col.progress-col { width:var(--ui-lane-progress-column-width); }
    col.action-col { width:var(--ui-lane-action-column-width); }
    th { padding:var(--ui-space-5) var(--ui-space-5) var(--ui-space-4); color:var(--ui-text-muted); font-size:var(--ui-text-xs); font-weight:500; text-align:left; border-bottom:1px solid var(--ui-border); }
    td { padding:var(--ui-space-5); border-top:1px solid color-mix(in srgb,var(--ui-border) 65%,transparent); vertical-align:middle; min-width:0; }
    td:last-child { padding:var(--ui-space-3) var(--ui-space-5) var(--ui-space-3) var(--ui-space-2); }
    tbody tr:first-child td { border-top:0; }
    tr.lane-row:hover,tr.lane-row.expanded { background:var(--ui-surface-hover); }
    .lane-toggle { width:100%; min-width:0; }
    .lane-toggle::part(button) { justify-content:flex-start; gap:var(--ui-space-4); min-width:0; padding:0; border:0; background:transparent; color:var(--ui-text); text-align:left; font:inherit; }
    .chevron { display:inline-flex; flex:none; color:var(--ui-text-muted); transition:transform .15s; }
    .expanded .chevron { transform:rotate(90deg); }
    .lane-primary { display:block; min-width:0; flex:1; }
    .lane-title { min-width:0; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; font-size:var(--ui-text-md); }
    .lane-meta { display:flex; align-items:center; flex-wrap:wrap; gap:var(--ui-space-3); margin-top:var(--ui-space-2); }
    .harness { color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .archived-label { color:var(--ui-accent); }
    .progress-cell { text-align:left; }
    .meter { display:grid; gap:var(--ui-space-2); width:100%; min-width:0; color:var(--ui-accent); }
    .meter.ready { color:var(--ui-success); }
    .meter.failed { color:var(--ui-danger); }
    .meter.uncertain,.meter.stopped { color:var(--ui-warning); }
    .meter-head { display:flex; align-items:baseline; justify-content:space-between; gap:var(--ui-space-3); min-width:0; font-variant-numeric:tabular-nums; }
    .progress-value { color:var(--ui-text); font-size:var(--ui-text-sm); font-weight:650; white-space:nowrap; }
    .progress-basis { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .track { display:block; height:var(--ui-progress-compact-height); overflow:hidden; border-radius:var(--ui-radius-md); background:color-mix(in srgb,var(--ui-border) 75%,transparent); }
    .fill { display:block; height:100%; border-radius:inherit; background:currentColor; }
    .meter-time { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ui-text-muted); font-size:var(--ui-text-xs); font-variant-numeric:tabular-nums; }
    .detail td { padding:0 var(--ui-space-5) var(--ui-space-5) var(--ui-space-9); background:color-mix(in srgb,var(--ui-surface-hover) 55%,var(--ui-surface-raised)); border-top:0; }
    .message { padding:var(--ui-space-5) 0; border-top:1px solid var(--ui-border); color:var(--ui-text); font-size:var(--ui-text-sm); line-height:1.6; overflow-wrap:anywhere; }
    .message > :first-child,.message .md-p:first-child { margin-top:0; }
    .message > :last-child,.message .md-p:last-child { margin-bottom:0; }
    .message .md-p { margin:0 0 var(--ui-space-4); }
    .message .md-h { margin:var(--ui-space-5) 0 var(--ui-space-3); font-size:var(--ui-text-md); line-height:1.3; }
    .message .md-ul,.message .md-ol { margin:var(--ui-space-3) 0 var(--ui-space-4); padding-left:var(--ui-space-7); }
    .message .md-li { margin:var(--ui-space-1) 0; }
    .message .md-code { padding:var(--ui-space-1) var(--ui-space-2); border-radius:var(--ui-radius-sm); background:var(--ui-surface-hover); font:var(--ui-text-xs) var(--ui-font-mono); }
    .message .md-pre { max-width:100%; overflow:auto; padding:var(--ui-space-4); border-radius:var(--ui-radius-md); background:var(--ui-surface-base); font:var(--ui-text-xs)/1.45 var(--ui-font-mono); }
    .message .md-quote { margin:var(--ui-space-4) 0; padding-left:var(--ui-space-4); border-left:2px solid var(--ui-border); color:var(--ui-text-muted); }
    .message .md-link { color:var(--ui-accent); }
    .message .md-img { max-width:100%; max-height:var(--ui-lane-media-height); object-fit:contain; }
    .message .md-tablewrap { max-width:100%; overflow:auto; }
    .message .md-table { border-collapse:collapse; }
    .message .md-th,.message .md-td { padding:var(--ui-space-2) var(--ui-space-4); border:1px solid var(--ui-border); }
    .message-placeholder { color:var(--ui-text-muted); }
    .detail-actions { display:flex; flex-wrap:wrap; align-items:center; gap:var(--ui-space-5); border-top:1px solid var(--ui-border); padding:var(--ui-space-4) 0 0; }
    .detail-actions .archive-action { margin-left:auto; }
    @media(max-width:560px) { :host { padding:var(--ui-space-5); } col.progress-col { width:var(--ui-lane-progress-column-phone-width); } col.action-col { width:var(--ui-lane-action-column-width); } th,td { padding-left:var(--ui-space-4); padding-right:var(--ui-space-4); } td:last-child { padding:var(--ui-space-3) var(--ui-space-2); } .lane-toggle::part(button) { gap:var(--ui-space-2); } .lane-title { white-space:normal; overflow-wrap:anywhere; line-height:1.3; } .meter-head { display:grid; gap:var(--ui-space-1); } .meter-time { display:none; } .progress-basis { font-size:var(--ui-text-xs); } }
    @media(prefers-reduced-motion:reduce) { .chevron { transition:none; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.unsubscribeChats = sdkChats.subscribe(() => {
      const current = sdkChats.chats.find(chat => chat.id === this.sessionId);
      const shown = this.snapshot?.operator;
      if (current && shown && JSON.stringify(current.operatorLanes || []) !== JSON.stringify(shown.operatorLanes || [])) void this.load();
    });
    this.poll = window.setInterval(() => { if (!document.hidden) void this.load(); }, 2500);
  }
  override disconnectedCallback() {
    if (this.poll) window.clearInterval(this.poll);
    this.unsubscribeChats?.();
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
      if (this.sessionId === operatorId && this.snapshot) {
        this.snapshot = archived
          ? { operator:{ ...this.snapshot.operator, operatorLanes:this.snapshot.operator.operatorLanes?.filter(id => id !== lane.id) }, lanes:this.snapshot.lanes.filter(row => row.id !== lane.id) }
          : { ...this.snapshot, lanes:this.snapshot.lanes.map(row => row.id === lane.id ? { ...row, archived } : row) };
        if (archived) this.expandedLane = '';
      }
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
    return html`<mux-ui-filter-chip .count=${count} ?pressed=${this.filter === value} @click=${() => this.chooseFilter(value)}>${label}</mux-ui-filter-chip>`;
  }
  private isStopped(lane: SDKChat) {
    return lane.state === 'ready' && lane.lastTurnOutcome === 'cancelled';
  }
  private statusTone(lane: SDKChat): StatusTone {
    if (lane.state === 'failed') return 'danger';
    if (lane.state === 'uncertain' || this.isStopped(lane)) return 'warning';
    if (lane.state === 'ready') return 'success';
    if (lane.state === 'working' || lane.state === 'starting') return 'info';
    return 'neutral';
  }
  private needsAttention(lane: SDKChat) {
    return lane.state === 'failed' || lane.state === 'uncertain' || this.isStopped(lane);
  }
  private checklist(chat: SDKChat) {
    const todos = chat.laneTodos || [];
    const completed = todos.filter(todo => todo.status === 'completed' || todo.status === 'done').length;
    return html`<div class="head"><h2>Task progress</h2><p>${chat.title}</p></div>
      ${todos.length ? html`<div class="self-progress"><span>${completed} of ${todos.length} tasks complete</span><progress aria-label="Completed tasks" max=${todos.length} value=${completed}></progress></div>
        <ul class="checklist" aria-label="Task checklist">${todos.map(todo => {
          const done = todo.status === 'completed' || todo.status === 'done';
          const active = todo.status === 'in_progress' || todo.status === 'inProgress';
          const label = done ? 'Completed' : active ? 'In progress' : 'Pending';
          return html`<li class="todo ${done ? 'completed' : active ? 'in_progress' : 'pending'}" aria-current=${active ? 'step' : nothing}><span class="todo-icon" aria-hidden="true">${icon(done ? Check : active ? LoaderCircle : Circle,{size:18})}</span><span class="todo-label">${todo.text}<span class="todo-state">${label}</span></span></li>`;
        })}</ul>` : html`<mux-ui-feedback appearance="panel" align="center"><strong>No task list reported yet.</strong><p class="hint">The checklist appears when the agent uses its plan or TODO tool.</p></mux-ui-feedback>`}`;
  }
  override render() {
    const operator = this.snapshot?.operator;
    const lanes = this.snapshot?.lanes || [];
    const attention = lanes.filter(chat => this.needsAttention(chat)).length;
    const working = lanes.filter(chat => chat.state === 'working' || chat.state === 'starting').length;
    const done = lanes.filter(chat => chat.state === 'ready' && !this.isStopped(chat)).length;
    const visible = lanes.filter(chat => this.filter === 'all' || (this.filter === 'attention' ? this.needsAttention(chat) : this.filter === 'running' ? chat.state === 'working' || chat.state === 'starting' : chat.state === 'ready' && !this.isStopped(chat)));
    if (operator && !operator.operator) return html`${this.error ? html`<mux-ui-feedback kind="error" appearance="panel">${this.error}</mux-ui-feedback>` : nothing}${this.checklist(operator)}`;
    return html`<div class="head"><h2>Operator status</h2><p>Lane work, timing ranges, and latest replies.</p></div>
      ${this.error ? html`<mux-ui-feedback kind="error" appearance="panel">${this.error}</mux-ui-feedback>` : nothing}
      ${!operator ? this.error ? nothing : html`<mux-ui-feedback kind="loading" align="center">Loading operator status…</mux-ui-feedback>` : !operator.operator ? html`<mux-ui-feedback appearance="panel" align="center"><strong>Operator mode is off.</strong><p class="hint">Turn it on from the permission and mode menu in the chat composer.</p></mux-ui-feedback>` : html`
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
              <td><mux-ui-button class="lane-toggle" variant="quiet" full-width accessible-label=${`${expanded ? 'Collapse' : 'Expand'} ${lane.title}`} expandable .expanded=${expanded} .controls=${detailId} @click=${() => { this.expandedLane = expanded ? '' : lane.id; }}><span class="chevron" aria-hidden="true">${icon(ChevronRight,{size:14})}</span><span class="lane-primary" title=${lane.title}><span class="lane-title">${lane.title}</span><span class="lane-meta"><span class="harness">${sdkHarnessLabel(lane.harness)}</span><mux-ui-status-badge dot .tone=${this.statusTone(lane)}>${this.isStopped(lane) ? 'Stopped' : lane.state === 'ready' ? 'Ready' : lane.state === 'uncertain' ? 'Uncertain' : lane.state === 'starting' ? 'Starting' : lane.state === 'failed' ? 'Failed' : 'Working'}</mux-ui-status-badge>${lane.archived ? html`<span class="archived-label">Archived</span>` : nothing}</span></span></mux-ui-button></td>
              <td class="progress-cell">${this.meter(lane)}</td>
              <td><mux-ui-button icon-only size="small" variant="quiet" accessible-label=${`Open lane chat: ${lane.title}`} tooltip="Open lane chat" @click=${() => this.open(lane.id)}>${laneIcon(17)}</mux-ui-button></td>
            </tr>${expanded ? html`<tr class="detail"><td colspan="3"><div class="message" id=${detailId}>${this.message(lane)}</div>
              <div class="detail-actions"><mux-ui-button variant="quiet" size="small" accessible-label=${`Unlink ${lane.title} from operator`} ?disabled=${!!this.pendingLane} @click=${() => void this.unlink(lane)}>${icon(Unlink2,{size:13})} Unlink lane</mux-ui-button>
                <mux-ui-button class="archive-action" variant="quiet" size="small" accessible-label=${`${lane.archived ? 'Restore' : 'Archive'} chat ${lane.title}`} ?disabled=${!!this.pendingLane} @click=${() => void this.setArchived(lane, !lane.archived)}>${icon(lane.archived ? ArchiveRestore : Archive,{size:13})} ${lane.archived ? 'Restore chat' : 'Archive chat'}</mux-ui-button></div>
            </td></tr>` : nothing}`;
          })}</tbody>
        </table></div>` : html`<mux-ui-feedback align="center">${this.filter === 'attention' ? 'No lanes need attention.' : this.filter === 'running' ? 'No lanes are running.' : 'No lanes are done yet.'}</mux-ui-feedback>`}` : html`<mux-ui-feedback appearance="panel" align="center"><strong>No lanes yet.</strong><p class="hint">Open a chat’s goal ledger to link it to this operator. Goal proposals need human approval or explicit operator start authorization.</p></mux-ui-feedback>`}`}`;
  }
}
