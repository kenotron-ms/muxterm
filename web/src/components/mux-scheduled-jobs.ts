import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';

type Job = { id:string; chatId:string; name:string; brief:string; revision:number; schedule:string; scheduleLabel?:string; timezone:string; enabled:boolean; nextRun?:string; activeRunId?:string; lastRunId?:string; latestRun?:Run; createdAt:string };
type Log = { at:string; kind:string; message:string };
type Run = { id:string; jobId:string; chatId:string; trigger:string; scheduledAt?:string; revision:number; status:string; startedAt:string; finishedAt?:string; summary?:string; logs?:Log[] };
function timeLabel(value?: string): string { return value ? new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : '—'; }
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
    :host { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; overflow:hidden; background:var(--chrome-body); color:var(--chrome-text-bright); font:13px/1.5 system-ui,sans-serif; }
    button, input, select, textarea { font:inherit; } button { cursor:pointer; }
    .top { display:flex; justify-content:space-between; align-items:center; gap:20px; padding:20px 28px; border-bottom:1px solid var(--chrome-border); background:var(--chrome-bar); }
    .eyebrow { color:var(--chrome-accent); font-size:10px; letter-spacing:.13em; text-transform:uppercase; font-weight:700; }
    h1 { margin:1px 0 1px; font-size:22px; letter-spacing:-.02em; } .subtitle { color:var(--chrome-text-dim); font-size:12px; }
    .primary { border:1px solid var(--chrome-accent); border-radius:7px; padding:8px 12px; background:var(--chrome-accent); color:var(--chrome-body); font-weight:650; }
    .content { flex:1; min-height:0; overflow:auto; padding:22px 28px 40px; }
    .summary { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px; }
    .summary span { border:1px solid var(--chrome-border); border-radius:8px; padding:9px 12px; min-width:110px; background:var(--chrome-bar); }
    .summary strong { display:block; font-size:16px; } .summary small { color:var(--chrome-text-dim); }
    .toolbar { display:flex; gap:9px; margin-bottom:13px; }
    .toolbar input, .toolbar select, .editor input, .editor textarea, .editor select { box-sizing:border-box; border:1px solid var(--chrome-border); border-radius:7px; padding:8px 10px; background:var(--chrome-bar); color:var(--chrome-text-bright); }
    .toolbar input { flex:1; min-width:140px; } .toolbar select { min-width:125px; }
    .table-wrap { border:1px solid var(--chrome-border); border-radius:10px; overflow:auto; background:var(--chrome-bar); }
    table { width:100%; border-collapse:collapse; min-width:830px; } th { color:var(--chrome-text-dim); text-align:left; font-size:10px; letter-spacing:.06em; text-transform:uppercase; font-weight:650; background:var(--chrome-hover); }
    th,td { padding:12px 14px; border-bottom:1px solid var(--chrome-border); vertical-align:middle; } tr:last-child td { border-bottom:0; }
    td { font-size:12px; } td small { display:block; color:var(--chrome-text-dim); max-width:290px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    td .job-name { display:block; border:0; padding:0; background:transparent; color:var(--chrome-text-bright); text-align:left; font-weight:680; }
    td .job-name:hover, .link:hover { color:var(--chrome-accent); text-decoration:underline; }
    .status { display:inline-flex; align-items:center; gap:5px; border-radius:999px; padding:3px 8px; background:var(--chrome-hover); font-size:11px; white-space:nowrap; }
    .status::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--mux-ok); }
    .status.paused::before { background:var(--chrome-text-dim); } .status.running::before { background:var(--chrome-accent); } .status.attention::before { background:var(--mux-warn); }
    .schedule { font:11px ui-monospace,monospace; } .schedule small { margin-top:2px; }
    .row-actions { display:flex; align-items:center; gap:5px; white-space:nowrap; }
    .row-actions button, .history button, .editor .actions button, .panel-title button { border:1px solid var(--chrome-border); border-radius:6px; padding:5px 8px; background:transparent; color:var(--chrome-text-bright); font-size:11px; }
    button:hover { background:var(--chrome-hover); } button:disabled { opacity:.5; cursor:default; }
    .link { border:0!important; padding:0!important; background:transparent!important; color:var(--chrome-accent)!important; }
    .empty { padding:24px; color:var(--chrome-text-dim); text-align:center; }
    .error { border:1px solid var(--chrome-danger); border-radius:7px; padding:8px 10px; margin-bottom:12px; color:var(--chrome-danger); }
    .history { display:grid; grid-template-columns:minmax(230px,34%) minmax(0,1fr); margin-top:19px; border:1px solid var(--chrome-border); border-radius:10px; min-height:250px; max-height:450px; overflow:hidden; background:var(--chrome-bar); }
    .run-list { overflow:auto; border-right:1px solid var(--chrome-border); } .run-detail { overflow:auto; min-width:0; padding:15px; }
    .panel-title { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid var(--chrome-border); font-weight:650; }
    .run-row { display:block; width:100%; text-align:left; border:0!important; border-bottom:1px solid var(--chrome-border)!important; border-radius:0!important; padding:9px 12px!important; }
    .run-row.active { background:var(--chrome-hover); } .run-row small { display:block; color:var(--chrome-text-dim); }
    .run-detail h3 { margin:0 0 4px; font-size:14px; } .run-detail p { margin:0 0 12px; color:var(--chrome-text-dim); }
    .log { display:grid; grid-template-columns:100px 85px minmax(0,1fr); gap:7px; padding:8px 0; border-top:1px solid var(--chrome-border); font-size:11px; overflow-wrap:anywhere; }
    .log time, .log .kind { color:var(--chrome-text-dim); font:10px ui-monospace,monospace; }
    .editor-backdrop { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:20px; background:#000a; z-index:5; }
    .editor { box-sizing:border-box; width:min(620px,100%); max-height:90vh; overflow:auto; border:1px solid var(--chrome-border); border-radius:12px; padding:23px; background:var(--chrome-bar); box-shadow:0 20px 70px #0009; }
    .editor h2 { margin:0 0 3px; font-size:19px; } .editor p { color:var(--chrome-text-dim); margin:0 0 14px; font-size:12px; }
    .editor label { display:block; margin:13px 0 0; font-weight:600; font-size:12px; } .editor label input, .editor label select, .editor textarea { display:block; width:100%; margin-top:5px; font-weight:400; }
    .editor textarea { height:125px; resize:vertical; line-height:1.5; } .editor .hint { color:var(--chrome-text-dim); font-size:11px; margin-top:4px; }
    .editor .inline { display:grid; grid-template-columns:1fr 1fr; gap:12px; } .editor .check { display:flex; align-items:center; gap:8px; } .editor .check input { width:auto; margin:0; }
    .editor .actions { display:flex; justify-content:flex-end; gap:8px; margin-top:21px; } .editor .actions button:last-child { border-color:var(--chrome-accent); background:var(--chrome-accent); color:var(--chrome-body); font-weight:650; }
    @media(max-width:700px) { .top { padding:14px; } .content { padding:15px; } .table-wrap { border:0; background:transparent; } table,thead,tbody,tr,td { display:block; min-width:0; } thead { display:none; } tr { margin-bottom:11px; border:1px solid var(--chrome-border); border-radius:9px; background:var(--chrome-bar); } td { padding:7px 12px; border:0; } .history { grid-template-columns:1fr; max-height:none; } .run-list { max-height:210px; border-right:0; border-bottom:1px solid var(--chrome-border); } .editor .inline { grid-template-columns:1fr; } }
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
  private async openHistory(job:Job) { this.selectedJob=job.id; this.detail=undefined; await this.refresh(); await this.loadRun(this.runs[job.id]?.[0]); }
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
      const payload={chatId:this.formChat,name:this.formName.trim(),brief:this.formBrief.trim(),schedule:naturalSchedule(this.formSchedule),scheduleLabel:this.formSchedule.trim(),timezone:this.formZone.trim(),enabled:this.formEnabled};
      await this.request<Job>(this.editorJob ? `/api/sdk-jobs/${this.editorJob}` : '/api/sdk-jobs',{method:this.editorJob?'PATCH':'POST',body:JSON.stringify(payload)});
      this.editorOpen=false; await this.refresh();
    } catch(error) { this.error=String(error); } finally { this.busy=''; }
  }
  private emit(type:string,detail?:object) { this.dispatchEvent(new CustomEvent(type,{bubbles:true,composed:true,detail})); }
  // The selected option is marked directly because a new chat can arrive in
  // the option list after Lit first assigns the select element's value.
  override render() {
    const rows=this.jobs.filter(job=>`${job.name} ${job.brief}`.toLowerCase().includes(this.query.toLowerCase()) && (this.statusFilter==='all'||this.status(job).toLowerCase().replace(' ','-')===this.statusFilter));
    const priority=(job:Job)=>({'Needs attention':0,'Running':1,'Active':2,'Paused':3})[this.status(job)] ?? 4;
    rows.sort((a,b)=>priority(a)-priority(b) || Date.parse(a.nextRun||'')-Date.parse(b.nextRun||'') || a.name.localeCompare(b.name));
    const active=this.jobs.filter(job=>job.enabled).length;
    const attention=this.jobs.filter(job=>this.status(job)==='Needs attention').length;
    const current=this.jobs.find(job=>job.id===this.selectedJob);
    return html`<header class="top"><div><div class="eyebrow">Automation</div><h1>Scheduled jobs</h1><div class="subtitle">Repeatable work in persistent conversations</div></div><button class="primary" @click=${()=>void this.openEditorForChat()}>＋ New job</button></header>
      <main class="content">${this.error?html`<div class="error" role="alert">${this.error}</div>`:nothing}
      <div class="summary"><span><strong>${this.jobs.length}</strong><small>Total jobs</small></span><span><strong>${active}</strong><small>Active schedules</small></span><span><strong>${attention}</strong><small>Need attention</small></span></div>
      <div class="toolbar"><input type="search" aria-label="Search scheduled jobs" placeholder="Search jobs" .value=${this.query} @input=${(event:InputEvent)=>{this.query=(event.target as HTMLInputElement).value;}}><select aria-label="Filter jobs by status" .value=${this.statusFilter} @change=${(event:Event)=>{this.statusFilter=(event.target as HTMLSelectElement).value;}}><option value="all">All statuses</option><option value="active">Active</option><option value="paused">Paused</option><option value="running">Running</option><option value="needs-attention">Needs attention</option></select></div>
      <div class="table-wrap"><table><thead><tr><th>Job</th><th>Status</th><th>Schedule</th><th>Next run</th><th>Last run</th><th>Actions</th></tr></thead><tbody>${rows.map(job=>{const last=this.latest(job),status=this.status(job),chatState=this.chatFor(job)?.state;return html`<tr><td><button class="job-name" @click=${()=>this.emit('chat-open',{sessionId:job.chatId})}>${job.name}</button><small title=${job.brief}>${job.brief}</small></td><td><span class="status ${status==='Needs attention'?'attention':status.toLowerCase()}">${status}</span></td><td class="schedule" title=${job.schedule}>${job.scheduleLabel || job.schedule}<small>${job.timezone} · ${job.schedule}</small></td><td>${job.enabled?timeLabel(job.nextRun):'—'}</td><td>${last?html`${timeLabel(last.startedAt)}<small>${last.trigger} · ${last.status}</small>`:'Never'}</td><td><div class="row-actions"><button title=${chatState==='working'?'Wait for the job chat to finish its current turn':'Start a manual run'} @click=${()=>void this.runNow(job)} ?disabled=${!!job.activeRunId||chatState==='working'||chatState==='starting'||chatState==='uncertain'||!!this.busy}>Run now</button><button @click=${()=>void this.openHistory(job)}>History</button><button @click=${()=>void this.toggle(job)}>${job.enabled?'Pause':'Resume'}</button><button @click=${()=>void this.openEditorForChat(job.chatId)}>Edit</button></div></td></tr>`})}</tbody></table>${!rows.length?html`<div class="empty">${this.jobs.length?'No jobs match your filters.':'No scheduled jobs yet. Start a chat, then review its schedule and standing instructions.'}</div>`:nothing}</div>
      ${current?html`<section class="history" aria-label="Run history for ${current.name}"><div class="run-list"><div class="panel-title">${current.name} · runs <button @click=${()=>{this.selectedJob='';this.detail=undefined;}} aria-label="Close run history">×</button></div>${(this.runs[current.id]||[]).map(run=>html`<button class="run-row ${this.detail?.id===run.id?'active':''}" @click=${()=>void this.loadRun(run)}><strong>${run.trigger==='manual'?'Manual':'Scheduled'} · ${run.status}</strong><small>${timeLabel(run.startedAt)} · brief v${run.revision}</small></button>`)}${!this.runs[current.id]?.length?html`<div class="empty">No runs yet.</div>`:nothing}</div><div class="run-detail">${this.detail?html`<h3>${this.detail.trigger==='manual'?'Manual':'Scheduled'} run · ${this.detail.status}</h3><p>${timeLabel(this.detail.startedAt)}${this.detail.finishedAt?` → ${timeLabel(this.detail.finishedAt)}`:''} · brief revision ${this.detail.revision}</p>${this.detail.summary?html`<p>${this.detail.summary}</p>`:nothing}<button @click=${()=>this.emit('chat-open',{sessionId:current.chatId})}>Open job chat</button><h3 style="margin-top:18px">Run log</h3>${(this.detail.logs||[]).map(log=>html`<div class="log"><time>${new Date(log.at).toLocaleTimeString()}</time><span class="kind">${log.kind}</span><span>${log.message}</span></div>`)}`:html`<div class="empty">Select a run to read its log.</div>`}</div></section>`:nothing}
      </main>${this.editorOpen?html`<div class="editor-backdrop"><div class="editor" role="dialog" aria-modal="true" aria-label=${this.editorJob?'Edit scheduled job':'Review scheduled job'}><h2>${this.editorJob?'Edit scheduled job':'Review scheduled job'}</h2><p>The chat remains this job’s conversation. Scheduled runs use its agent permissions to run tools and change project files, even while you are away.</p>${this.error?html`<div class="error" role="alert">${this.error}</div>`:nothing}${this.editorJob?html`<label>Conversation<input aria-label="Job conversation" .value=${sdkChats.chats.find(chat=>chat.id===this.formChat)?.title||this.formChat} readonly></label>`:html`<label>Conversation<select aria-label="Job conversation" @change=${(event:Event)=>this.selectChat((event.target as HTMLSelectElement).value)}><option value="" ?selected=${!this.formChat}>Choose a chat</option>${this.availableChats().map(chat=>html`<option value=${chat.id} ?selected=${chat.id===this.formChat}>${chat.title} · ${chat.projectPath}</option>`)}</select></label>`}${!this.editorJob?html`<button class="link" @click=${()=>this.emit('job-new')}>Start a new chat for this job</button>`:nothing}<label>Job name<input aria-label="Job name" .value=${this.formName} @input=${(event:InputEvent)=>{this.formName=(event.target as HTMLInputElement).value;}}></label><label>Standing instructions<textarea aria-label="Standing instructions" .value=${this.formBrief} @input=${(event:InputEvent)=>{this.formBrief=(event.target as HTMLTextAreaElement).value;}}></textarea></label><button class="link" @click=${()=>void this.useLatestChatAnswer()} ?disabled=${!this.formChat||!!this.busy}>Use the latest chat answer as a draft</button><div class="hint">Review the draft before saving. Changes apply to future runs; active runs keep their previous revision.</div><div class="inline"><label>When should it run?<input aria-label="Job schedule" .value=${this.formSchedule} @input=${(event:InputEvent)=>{this.formSchedule=(event.target as HTMLInputElement).value;}}><div class="hint">Examples: weekdays at 9am, every day at 6pm, every hour, or five-field cron.</div></label><label>Time zone<input aria-label="Job time zone" .value=${this.formZone} @input=${(event:InputEvent)=>{this.formZone=(event.target as HTMLInputElement).value;}}><div class="hint">IANA zone, such as America/New_York.</div></label></div><label class="check"><input type="checkbox" .checked=${this.formEnabled} @change=${(event:Event)=>{this.formEnabled=(event.target as HTMLInputElement).checked;}}>Enable schedule</label><div class="actions"><button @click=${()=>{this.editorOpen=false;this.error='';}}>Cancel</button><button @click=${()=>void this.saveEditor()} ?disabled=${!!this.busy||!this.formChat||!this.formName.trim()||!this.formBrief.trim()}>${this.editorJob?'Save changes':'Create job'}</button></div></div></div>`:nothing}`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-scheduled-jobs': MuxScheduledJobs } }
