import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';
import '../ui/button.js';
import '../ui/dialog.js';
import '../ui/feedback.js';
import '../ui/nav-item.js';
import '../ui/page-intro.js';
import '../ui/screen-header.js';
import '../ui/select.js';
import '../ui/status-badge.js';
import '../ui/switch.js';
import '../ui/text-area.js';
import '../ui/text-field.js';
import type { MuxUISwitch } from '../ui/switch.js';
import type { MuxUISelect } from '../ui/select.js';
import type { MuxUITextArea } from '../ui/text-area.js';
import type { MuxUITextField } from '../ui/text-field.js';

type WorkTrigger = { events:string[]; projectIds?:string[]; labels?:string[] };
type WorkEvent = { workId:string; type:string; revision:number; title:string; summary?:string; blockedReason?:string; outcome?:string };
type Job = { id:string; chatId:string; name:string; brief:string; revision:number; schedule:string; scheduleLabel?:string; timezone:string; workTrigger?:WorkTrigger; enabled:boolean; nextRun?:string; activeRunId?:string; lastRunId?:string; latestRun?:Run; createdAt:string };
type Log = { at:string; kind:string; message:string };
type Run = { id:string; jobId:string; chatId:string; trigger:string; scheduledAt?:string; workEvent?:WorkEvent; revision:number; status:string; startedAt:string; finishedAt?:string; summary?:string; logs?:Log[] };
function runLabel(run:Run):string { return run.workEvent ? `Work ${run.workEvent.type} · ${run.workEvent.title}` : run.trigger === 'manual' ? 'Manual' : 'Scheduled'; }
function timeLabel(value?: string): string { return value && !value.startsWith('0001-') ? new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : '—'; }
function naturalSchedule(input: string): string {
  const phrase = input.trim().toLowerCase();
  if (phrase === 'every hour' || phrase === 'hourly') return '0 * * * *';
  if (phrase === 'every day' || phrase === 'daily') return '0 9 * * *';
  const match = /^(every day|daily|weekdays|every weekday) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(phrase);
  if (!match) return input.trim();
  let hour = Number(match[2]); const minute = Number(match[3] || '0');
  if (hour > 23 || minute > 59 || (match[4] && (hour < 1 || hour > 12))) return input.trim();
  if (match[4] === 'pm' && hour < 12) hour += 12;
  if (match[4] === 'am' && hour === 12) hour = 0;
  return `${minute} ${hour} * * ${match[1].includes('weekday') ? '1-5' : '*'}`;
}

@customElement('mux-scheduled-jobs')
export class MuxScheduledJobs extends LitElement {
  @property() createFromChat = '';
  @state() private jobs: Job[] = [];
  @state() private runs: Record<string,Run[]> = {};
  @state() private detail?: Run;
  @state() private selectedJob = '';
  @state() private query = '';
  @state() private statusFilter = 'all';
  @state() private error = '';
  @state() private busy = '';
  @state() private editorOpen = false;
  @state() private editorJob = '';
  @state() private editorChat?: SDKChat;
  @state() private formChat = '';
  @state() private formName = '';
  @state() private formBrief = '';
  @state() private formSchedule = 'weekdays at 9am';
  @state() private formScheduleEnabled = true;
  @state() private formEvents: string[] = [];
  @state() private formProject = '';
  @state() private formLabels = '';
  @state() private formZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  @state() private formEnabled = true;
  private timer?: number;
  private lastCreateFromChat = '';
  private availableChats(): SDKChat[] {
    const chats=[...sdkChats.chats];
    if (this.editorChat && !chats.some(chat=>chat.id===this.editorChat?.id)) chats.unshift(this.editorChat);
    return chats.filter(chat => !chat.archived && !this.jobs.some(job => job.chatId === chat.id));
  }

  static override styles = css`
    :host {
      position:absolute; inset:0; z-index:var(--ui-z-screen); display:flex; flex-direction:column; overflow:hidden;
      background:var(--ui-surface-base); color:var(--ui-text);
      font:var(--ui-text-md)/1.5 var(--ui-font-sans);
    }
    .content { flex:1; min-height:0; overflow:auto; padding:var(--ui-space-7) var(--ui-space-9) var(--ui-space-10); }
    .content > mux-ui-feedback { margin-bottom:var(--ui-space-5); }
    .summary { display:flex; gap:var(--ui-space-5); flex-wrap:wrap; margin-bottom:var(--ui-space-7); }
    .summary span {
      border:1px solid var(--ui-border); border-radius:var(--ui-radius-md);
      padding:var(--ui-space-4) var(--ui-space-5); min-width:var(--ui-jobs-summary-min-width); background:var(--ui-surface-raised);
    }
    .summary strong { display:block; font-size:var(--ui-text-xl); }
    .summary small { color:var(--ui-text-muted); }
    .toolbar { display:flex; gap:var(--ui-space-4); margin-bottom:var(--ui-space-5); }
    .toolbar mux-ui-text-field { flex:1; min-width:var(--ui-jobs-search-min-width); }
    .toolbar mux-ui-select { width:var(--ui-jobs-filter-width); }
    .table-wrap { border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); overflow:auto; background:var(--ui-surface-raised); }
    table { width:100%; border-collapse:collapse; min-width:var(--ui-jobs-table-min-width); }
    th { color:var(--ui-text-muted); text-align:left; font-size:var(--ui-text-xs); letter-spacing:.06em; text-transform:uppercase; font-weight:650; background:var(--ui-surface-hover); }
    th,td { padding:var(--ui-space-5) var(--ui-space-6); border-bottom:1px solid var(--ui-border); vertical-align:middle; }
    tr:last-child td { border-bottom:0; }
    td { font-size:var(--ui-text-sm); }
    td small { display:block; color:var(--ui-text-muted); max-width:var(--ui-jobs-description-width); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .schedule { font:var(--ui-text-xs) var(--ui-font-mono); }
    .schedule small { margin-top:var(--ui-space-1); }
    .row-actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--ui-space-3); }
    .history {
      display:grid; grid-template-columns:minmax(230px,34%) minmax(0,1fr);
      margin-top:var(--ui-space-7); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg);
      min-height:var(--ui-jobs-history-min-height); max-height:var(--ui-jobs-history-max-height); overflow:hidden; background:var(--ui-surface-raised);
    }
    .run-list { overflow:auto; border-right:1px solid var(--ui-border); }
    .run-list mux-ui-nav-item { border-bottom:1px solid var(--ui-border); }
    .run-detail { overflow:auto; min-width:0; padding:var(--ui-space-6); }
    .panel-title {
      display:flex; align-items:center; justify-content:space-between;
      padding:var(--ui-space-5) var(--ui-space-6); border-bottom:1px solid var(--ui-border); font-weight:650;
    }
    .run-detail h3 { margin:0 0 var(--ui-space-2); font-size:var(--ui-text-lg); }
    .run-detail p { margin:0 0 var(--ui-space-5); color:var(--ui-text-muted); }
    .log {
      display:grid; grid-template-columns:100px 85px minmax(0,1fr); gap:var(--ui-space-3);
      padding:var(--ui-space-4) 0; border-top:1px solid var(--ui-border);
      font-size:var(--ui-text-xs); overflow-wrap:anywhere;
    }
    .log time,.log .kind { color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-mono); }
    .editor {
      box-sizing:border-box; height:100%; min-height:0; overflow:auto;
      padding:var(--ui-space-8); background:var(--ui-surface-overlay);
    }
    .editor h2 { margin:0 0 var(--ui-space-2); font-size:var(--ui-text-2xl); }
    .editor > p { margin:0 0 var(--ui-space-6); color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
    .editor mux-ui-feedback { margin-bottom:var(--ui-space-5); }
    .editor .field { margin-top:var(--ui-space-6); }
    .editor .inline { display:grid; grid-template-columns:1fr 1fr; gap:var(--ui-space-5); }
    .editor mux-ui-switch { margin-top:var(--ui-space-6); }
    .editor .hint { color:var(--ui-text-muted); font-size:var(--ui-text-xs); margin-top:var(--ui-space-2); }
    .editor .trigger-group { margin-top:var(--ui-space-6); padding:var(--ui-space-5); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); }
    .editor .trigger-group h3 { margin:0; font-size:var(--ui-text-md); }
    .editor .trigger-group mux-ui-switch { margin-top:var(--ui-space-4); }
    .editor .trigger-group .field { margin-top:var(--ui-space-4); }
    .editor .actions { display:flex; justify-content:flex-end; gap:var(--ui-space-4); margin-top:var(--ui-space-8); }
    @media(max-width:700px) {
      .content { padding:var(--ui-space-6); }
      .toolbar { flex-wrap:wrap; }
      .toolbar mux-ui-text-field,.toolbar mux-ui-select { flex:1 1 100%; width:100%; }
      .table-wrap { border:0; background:transparent; }
      table,thead,tbody,tr,td { display:block; min-width:0; }
      thead { display:none; }
      tr { margin-bottom:var(--ui-space-5); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); }
      td { padding:var(--ui-space-4) var(--ui-space-5); border:0; }
      td[data-label]::before { content:attr(data-label); display:block; margin-bottom:var(--ui-space-1); color:var(--ui-text-muted); font-size:var(--ui-text-xs); text-transform:uppercase; letter-spacing:.04em; }
      .history { grid-template-columns:1fr; max-height:none; }
      .run-list { max-height:var(--ui-jobs-run-list-max-height); border-right:0; border-bottom:1px solid var(--ui-border); }
      .editor .inline { grid-template-columns:1fr; }
    }
  `;

  override connectedCallback() { super.connectedCallback(); void this.refresh(); this.timer = window.setInterval(() => void this.refresh(), 5000); }
  override disconnectedCallback() { if (this.timer) clearInterval(this.timer); super.disconnectedCallback(); }
  override updated() {
    if (this.createFromChat && this.createFromChat !== this.lastCreateFromChat) {
      this.lastCreateFromChat = this.createFromChat;
      void this.openEditorForChat(this.createFromChat);
    }
  }
  private async request<T>(path:string, init?:RequestInit):Promise<T> {
    const response = await fetch(apiPath(path), { ...init, headers: { 'Content-Type':'application/json', ...init?.headers } });
    if (!response.ok) throw new Error((await response.text()).trim() || `Request failed (${response.status})`);
    return response.json() as Promise<T>;
  }
  private async refresh() {
    try {
      const jobs = await this.request<Job[]>('/api/sdk-jobs');
      await sdkChats.refresh();
      this.jobs = jobs;
      if (this.selectedJob && jobs.some(job => job.id === this.selectedJob)) {
        this.runs = {...this.runs, [this.selectedJob]: await this.request<Run[]>(`/api/sdk-jobs/${this.selectedJob}/runs`)};
      }
      if (this.selectedJob && !jobs.some(job => job.id === this.selectedJob)) this.selectedJob = '';
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
  }
  private chatFor(job:Job):SDKChat|undefined { return sdkChats.chats.find(chat => chat.id === job.chatId); }
  private latest(job:Job):Run|undefined { return job.latestRun; }
  private status(job:Job):string { const latest=this.latest(job); return job.activeRunId ? 'Running' : latest && ['failed','outcome-unknown'].includes(latest.status) ? 'Needs attention' : !job.enabled ? 'Paused' : 'Active'; }
  private async openHistory(job:Job) {
    this.selectedJob=job.id; this.detail=undefined;
    await this.refresh(); await this.loadRun(this.runs[job.id]?.[0]);
    await this.updateComplete;
    this.renderRoot.querySelector('.history')?.scrollIntoView({block:'start'});
  }
  private async loadRun(run?:Run) { if (!run) { this.detail=undefined; return; } try { this.detail=await this.request<Run>(`/api/sdk-jobs/${run.jobId}/runs/${run.id}`); } catch(error) { this.error=String(error); } }
  private async runNow(job:Job) { this.busy=job.id; this.error=''; try { await this.request<Run>(`/api/sdk-jobs/${job.id}/run`,{method:'POST'}); await this.refresh(); await this.openHistory(job); } catch(error) { this.error=String(error); } finally { this.busy=''; } }
  private async toggle(job:Job) { this.busy=job.id; this.error=''; try { await this.request<Job>(`/api/sdk-jobs/${job.id}`,{method:'PATCH',body:JSON.stringify({enabled:!job.enabled})}); await this.refresh(); } catch(error) { this.error=String(error); } finally { this.busy=''; } }
  private async openEditorForChat(chatID = '') {
    await this.refresh();
    const existing=this.jobs.find(job=>job.chatId===chatID);
    let chat=sdkChats.chats.find(item=>item.id===chatID);
    if (chatID && !chat) {
      try { chat=await this.request<SDKChat>(`/api/sdk-chats/${encodeURIComponent(chatID)}`); }
      catch(error) { this.error=error instanceof Error?error.message:String(error); return; }
    }
    this.editorChat=chat;
    this.editorJob=existing?.id || ''; this.formChat=chatID;
    this.formName=existing?.name || chat?.title || '';
    this.formBrief=existing?.brief || '';
    this.formSchedule=existing?.scheduleLabel || existing?.schedule || 'weekdays at 9am';
    this.formScheduleEnabled=existing ? !!existing.schedule : true;
    this.formEvents=[...(existing?.workTrigger?.events || [])];
    this.formProject=existing?.workTrigger?.projectIds?.[0] || '';
    this.formLabels=(existing?.workTrigger?.labels || []).join(', ');
    this.formZone=existing?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this.formEnabled=existing?.enabled ?? true;
    this.editorOpen=true;
  }
  private selectChat(chatID:string) {
    const chat=this.availableChats().find(item=>item.id===chatID);
    if (chat) this.editorChat=chat;
    this.formChat=chatID;
    if (!this.formName.trim()) this.formName=chat?.title || '';
  }
  private async useLatestChatAnswer() {
    if (!this.formChat) return;
    const chatID=this.formChat;
    this.busy='chat-draft'; this.error='';
    try {
      const page=await this.request<{events:{type:string; text?:string; kind?:string}[]}>(`/api/sdk-chats/${encodeURIComponent(chatID)}/history?view=messages`);
      if (this.formChat!==chatID) return;
      let start=0;
      for (let i=page.events.length-1;i>=0;i--) {
        if (page.events[i].type==='input.accepted' && page.events[i].kind==='user') { start=i+1; break; }
      }
      const answer=page.events.slice(start).filter(event=>event.type==='assistant.delta').map(event=>event.text||'').join('').trim();
      if (!answer) throw new Error('This chat has no assistant answer yet. Continue the conversation, then try again.');
      this.formBrief=answer.slice(0,10000);
    } catch(error) { this.error=error instanceof Error?error.message:String(error); }
    finally { this.busy=''; }
  }
  private async saveEditor() {
    this.busy='editor'; this.error='';
    try {
      if (!this.formScheduleEnabled && !this.formEvents.length) throw new Error('Choose a schedule or at least one Work event.');
      const labels=this.formLabels.split(',').map(label=>label.trim()).filter(Boolean);
      const payload={chatId:this.formChat,name:this.formName.trim(),brief:this.formBrief.trim(),schedule:this.formScheduleEnabled?naturalSchedule(this.formSchedule):'',scheduleLabel:this.formScheduleEnabled?this.formSchedule.trim():'',timezone:this.formZone.trim(),workTrigger:this.formEvents.length?{events:this.formEvents,projectIds:this.formProject?[this.formProject]:[],labels}:null,enabled:this.formEnabled};
      await this.request<Job>(this.editorJob ? `/api/sdk-jobs/${this.editorJob}` : '/api/sdk-jobs',{method:this.editorJob?'PATCH':'POST',body:JSON.stringify(payload)});
      this.editorOpen=false; await this.refresh();
    } catch(error) { this.error=String(error); } finally { this.busy=''; }
  }
  private toggleEvent(event:string, enabled:boolean) {
    this.formEvents=enabled ? [...this.formEvents,event] : this.formEvents.filter(value=>value!==event);
  }
  private emit(type:string,detail?:object) { this.dispatchEvent(new CustomEvent(type,{bubbles:true,composed:true,detail})); }
  private renderJobRow(job: Job) {
    const last = this.latest(job);
    const status = this.status(job);
    const chatState = this.chatFor(job)?.state;
    const runDisabled = !!job.activeRunId || chatState === 'working' || chatState === 'starting'
      || chatState === 'uncertain' || !!this.busy;
    return html`
      <tr>
        <td data-label="Job">
          <mux-ui-button class="job-name" size="small" variant="quiet"
            @click=${() => this.emit('chat-open', { sessionId:job.chatId })}>${job.name}</mux-ui-button>
          <small title=${job.brief}>${job.brief}</small>
        </td>
        <td data-label="Status"><mux-ui-status-badge dot
          tone=${status === 'Needs attention' ? 'warning' : status === 'Running' ? 'info' : status === 'Active' ? 'success' : 'neutral'}
          >${status}</mux-ui-status-badge></td>
        <td class="schedule" data-label="Triggers" title=${job.schedule}>
          ${job.workTrigger ? html`Work: ${job.workTrigger.events.join(', ')}<small>${job.workTrigger.projectIds?.length ? `Project: ${job.workTrigger.projectIds.map(id=>sdkChats.projects.find(project=>project.id===id)?.name || id).join(', ')} · ` : ''}${job.workTrigger.labels?.length ? `Labels: ${job.workTrigger.labels.join(', ')}` : 'All labels'}</small>` : nothing}
          ${job.schedule ? html`${job.scheduleLabel || job.schedule}<small>${job.timezone} · ${job.schedule}</small>` : nothing}
        </td>
        <td data-label="Next run">${job.enabled ? job.schedule ? timeLabel(job.nextRun) : 'On matching event' : '—'}</td>
        <td data-label="Last run">${last ? html`${timeLabel(last.startedAt)}<small>${runLabel(last)} · ${last.status}</small>` : 'Never'}</td>
        <td data-label="Actions"><div class="row-actions">
          <mux-ui-button size="small" variant="secondary"
            tooltip=${chatState === 'working' ? 'Wait for the job chat to finish its current turn' : 'Start a manual run'}
            ?disabled=${runDisabled} @click=${() => void this.runNow(job)}>Run now</mux-ui-button>
          <mux-ui-button size="small" variant="secondary" @click=${() => void this.openHistory(job)}>History</mux-ui-button>
          <mux-ui-button size="small" variant="secondary" ?disabled=${!!this.busy}
            @click=${() => void this.toggle(job)}>${job.enabled ? 'Pause' : 'Resume'}</mux-ui-button>
          <mux-ui-button size="small" variant="secondary" ?disabled=${!!this.busy}
            @click=${() => void this.openEditorForChat(job.chatId)}>Edit</mux-ui-button>
        </div></td>
      </tr>
    `;
  }

  private renderHistory(current: Job) {
    return html`<section class="history" aria-label="Run history for ${current.name}">
      <div class="run-list">
        <div class="panel-title">${current.name} · runs
          <mux-ui-button size="small" variant="quiet" icon-only accessible-label="Close run history"
            @click=${() => { this.selectedJob = ''; this.detail = undefined; }}>×</mux-ui-button>
        </div>
        ${(this.runs[current.id] || []).map(run => html`
          <mux-ui-nav-item
            label=${`${runLabel(run)} · ${run.status}`}
            description=${`${timeLabel(run.startedAt)} · brief v${run.revision}`}
            ?active=${this.detail?.id === run.id}
            @click=${() => void this.loadRun(run)}></mux-ui-nav-item>
        `)}
        ${!this.runs[current.id]?.length ? html`<mux-ui-feedback align="center">No runs yet.</mux-ui-feedback>` : nothing}
      </div>
      <div class="run-detail">
        ${this.detail ? html`
          <h3>${runLabel(this.detail)} · ${this.detail.status}</h3>
          <p>${timeLabel(this.detail.startedAt)}${this.detail.finishedAt ? ` → ${timeLabel(this.detail.finishedAt)}` : ''} · brief revision ${this.detail.revision}</p>
          ${this.detail.workEvent ? html`<p>Work ${this.detail.workEvent.workId} · item revision ${this.detail.workEvent.revision}. ${this.detail.workEvent.summary || this.detail.workEvent.blockedReason || this.detail.workEvent.outcome || ''}</p>` : nothing}
          ${this.detail.summary ? html`<p>${this.detail.summary}</p>` : nothing}
          <mux-ui-button size="small" variant="secondary"
            @click=${() => this.emit('chat-open', { sessionId:current.chatId })}>Open job chat</mux-ui-button>
          <h3 style="margin-top:var(--ui-space-7)">Run log</h3>
          ${(this.detail.logs || []).map(log => html`<div class="log">
            <time>${new Date(log.at).toLocaleTimeString()}</time>
            <span class="kind">${log.kind}</span><span>${log.message}</span>
          </div>`)}
        ` : html`<mux-ui-feedback align="center">Select a run to read its log.</mux-ui-feedback>`}
      </div>
    </section>`;
  }

  private renderEditor() {
    const editing = !!this.editorJob;
    const title = editing ? 'Edit job' : 'Create job';
    const conversation = sdkChats.chats.find(chat => chat.id === this.formChat)?.title || this.formChat;
    const chatOptions = [
      { value:'', label:'Choose a chat' },
      ...this.availableChats().map(chat => ({ value:chat.id, label:`${chat.title} · ${chat.projectPath}` })),
    ];
    return html`<mux-ui-dialog class="job-editor" open label=${title}
      @dismiss=${() => { this.editorOpen = false; this.error = ''; }}>
      <div class="editor">
        <h2>${title}</h2>
        <p>The chat remains this job’s conversation. Runs use its existing agent permissions and Work tools.</p>
        ${this.error ? html`<mux-ui-feedback kind="error" appearance="panel">${this.error}</mux-ui-feedback>` : nothing}
        <div class="field">
          ${editing
            ? html`<mux-ui-text-field label="Conversation" .value=${conversation} readonly></mux-ui-text-field>`
            : html`<mux-ui-select label="Conversation" .value=${this.formChat} .options=${chatOptions}
                @change=${(event:Event) => this.selectChat((event.target as MuxUISelect).value)}></mux-ui-select>`}
        </div>
        ${!editing ? html`<mux-ui-button class="field" size="small" variant="quiet"
          @click=${() => this.emit('job-new')}>Start a new chat for this job</mux-ui-button>` : nothing}
        <mux-ui-text-field class="field" label="Job name" .value=${this.formName}
          @input=${(event:InputEvent) => { this.formName = (event.target as MuxUITextField).value; }}></mux-ui-text-field>
        <mux-ui-text-area class="field" label="Standing instructions" .value=${this.formBrief}
          @input=${(event:InputEvent) => { this.formBrief = (event.target as MuxUITextArea).value; }}></mux-ui-text-area>
        <mux-ui-button class="field" size="small" variant="quiet" ?disabled=${!this.formChat || !!this.busy}
          @click=${() => void this.useLatestChatAnswer()}>Use the latest chat answer as a draft</mux-ui-button>
        <div class="hint">Review the draft before saving. Changes apply to future runs; active runs keep their previous revision.</div>
        <section class="trigger-group" aria-label="Schedule trigger">
          <h3>Schedule</h3>
          <mux-ui-switch layout="row" label="Run on a schedule" .checked=${this.formScheduleEnabled}
            @change=${(event:Event) => { this.formScheduleEnabled = (event.target as MuxUISwitch).checked; }}></mux-ui-switch>
        ${this.formScheduleEnabled ? html`<div class="inline">
          <mux-ui-text-field class="field" label="When should it run?"
            description="Examples: weekdays at 9am, every day at 6pm, every hour, or five-field cron."
            .value=${this.formSchedule}
            @input=${(event:InputEvent) => { this.formSchedule = (event.target as MuxUITextField).value; }}></mux-ui-text-field>
          <mux-ui-text-field class="field" label="Time zone" description="IANA zone, such as America/New_York."
            .value=${this.formZone}
            @input=${(event:InputEvent) => { this.formZone = (event.target as MuxUITextField).value; }}></mux-ui-text-field>
        </div>` : nothing}
        </section>
        <section class="trigger-group" aria-label="Work event trigger">
          <h3>Work events</h3>
          <div class="hint">Run when an item enters a selected state. Each transition starts at most one run; updates made by this job are ignored.</div>
          ${([['review','Enters review'],['blocked','Becomes blocked'],['done','Completes']] as const).map(([event,label])=>html`
            <mux-ui-switch layout="row" label=${label} .checked=${this.formEvents.includes(event)}
              @change=${(change:Event) => this.toggleEvent(event,(change.target as MuxUISwitch).checked)}></mux-ui-switch>`)}
          ${this.formEvents.length ? html`
            <mux-ui-select class="field" label="Project filter" description="Optional. Match items in this project."
              .value=${this.formProject} .options=${[{value:'',label:'All projects'},...sdkChats.projects.filter(project=>!project.remoteHost).map(project=>({value:project.id,label:project.name}))]}
              @change=${(event:Event) => { this.formProject=(event.target as MuxUISelect).value; }}></mux-ui-select>
            <mux-ui-text-field class="field" label="Label filters" description="Optional. Comma separated; an item must have every label."
              .value=${this.formLabels} @input=${(event:InputEvent) => { this.formLabels=(event.target as MuxUITextField).value; }}></mux-ui-text-field>
          ` : nothing}
        </section>
        <mux-ui-switch layout="row" label="Enable job" description="Allow automatic schedule and Work event runs"
          .checked=${this.formEnabled} ?disabled=${!!this.busy}
          @change=${(event:Event) => { this.formEnabled = (event.target as MuxUISwitch).checked; }}></mux-ui-switch>
        <div class="actions">
          <mux-ui-button variant="secondary" @click=${() => { this.editorOpen = false; this.error = ''; }}>Cancel</mux-ui-button>
          <mux-ui-button variant="primary" ?busy=${this.busy === 'editor'}
            ?disabled=${!!this.busy || !this.formChat || !this.formName.trim() || !this.formBrief.trim()}
            @click=${() => void this.saveEditor()}>${editing ? 'Save changes' : 'Create job'}</mux-ui-button>
        </div>
      </div>
    </mux-ui-dialog>`;
  }

  override render() {
    const rows = this.jobs.filter(job => `${job.name} ${job.brief}`.toLowerCase().includes(this.query.toLowerCase())
      && (this.statusFilter === 'all' || this.status(job).toLowerCase().replace(' ', '-') === this.statusFilter));
    const priority = (job:Job) => ({'Needs attention':0,'Running':1,'Active':2,'Paused':3})[this.status(job)] ?? 4;
    rows.sort((a,b) => priority(a)-priority(b) || Date.parse(a.nextRun || '')-Date.parse(b.nextRun || '') || a.name.localeCompare(b.name));
    const active = this.jobs.filter(job => job.enabled).length;
    const attention = this.jobs.filter(job => this.status(job) === 'Needs attention').length;
    const current = this.jobs.find(job => job.id === this.selectedJob);
    const statusOptions = [
      { value:'all', label:'All statuses' }, { value:'active', label:'Active' },
      { value:'paused', label:'Paused' }, { value:'running', label:'Running' },
      { value:'needs-attention', label:'Needs attention' },
    ];
    return html`
      <mux-ui-screen-header section="Automation" heading="Jobs"></mux-ui-screen-header>
      <mux-ui-page-intro heading="Jobs" description="Run on a schedule or when Work changes">
        <mux-ui-button slot="action" variant="primary" @click=${() => void this.openEditorForChat()}>＋ New job</mux-ui-button>
      </mux-ui-page-intro>
      <main class="content">
        ${this.error ? html`<mux-ui-feedback kind="error" appearance="panel">${this.error}</mux-ui-feedback>` : nothing}
        <div class="summary"><span><strong>${this.jobs.length}</strong><small>Total jobs</small></span>
          <span><strong>${active}</strong><small>Enabled jobs</small></span>
          <span><strong>${attention}</strong><small>Need attention</small></span></div>
        <div class="toolbar">
          <mux-ui-text-field type="search" aria-label="Search scheduled jobs" placeholder="Search jobs"
            .value=${this.query} @input=${(event:InputEvent) => { this.query = (event.target as MuxUITextField).value; }}></mux-ui-text-field>
          <mux-ui-select aria-label="Filter jobs by status" .value=${this.statusFilter} .options=${statusOptions}
            @change=${(event:Event) => { this.statusFilter = (event.target as MuxUISelect).value; }}></mux-ui-select>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Job</th><th>Status</th><th>Triggers</th><th>Next run</th><th>Last run</th><th>Actions</th></tr></thead>
          <tbody>${rows.map(job => this.renderJobRow(job))}</tbody>
        </table>
        ${!rows.length ? html`<mux-ui-feedback align="center">${this.jobs.length ? 'No jobs match your filters.' : 'No jobs yet. Use New job to choose a chat or start one.'}</mux-ui-feedback>` : nothing}
        </div>
        ${current ? this.renderHistory(current) : nothing}
      </main>
      ${this.editorOpen ? this.renderEditor() : nothing}
    `;
  }

}

declare global { interface HTMLElementTagNameMap { 'mux-scheduled-jobs': MuxScheduledJobs } }
