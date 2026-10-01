import { LitElement, html, render, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { DockviewComponent, type IContentRenderer, type ITabRenderer, type TabPartInitParameters, type SerializedDockview } from 'dockview-core';
import { Folder, GitPullRequest, ListTodo, Route, type IconNode } from 'lucide';
import dockviewCss from 'dockview-core/dist/styles/dockview.css?inline';
import { apiPath } from '../lib/base-path.js';
import { icon } from '../lib/icons.js';
import { parseMarkdown } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import type { Artifact } from '../lib/artifact-api.js';

type Task = { content: string; status: string };
type Entry = { name: string; dir: boolean };
type Listing = { root: string; path: string; entries: Entry[] };
type Pull = { number: number; title: string; state: string; branch: string; url: string };
type TrajectoryEvent = { type: string; at?: string; text?: string; name?: string; toolId?: string; raw?: unknown; kind?: string; failed?: boolean; complete?: boolean; message?: string; childSessionId?: string; agent?: string };
type TrajectoryRecord = { id: number; turn: number; kind: string; label: string; start?: number; end?: number; input?: unknown; output?: unknown; status: string; childId?: string; toolId?: string };
const KEY = 'muxterm.sdk.utility.layout.';
const TAB_ICONS: Record<string, IconNode> = { plan: ListTodo, files: Folder, pr: GitPullRequest, trajectory: Route };

class UtilityPanel implements IContentRenderer {
  readonly element = document.createElement('div');
  constructor(readonly id: string, readonly owner: MuxSDKUtility) {
    this.element.className = 'utility-panel';
    this.element.setAttribute('aria-label', `${id} panel`);
  }
  init() { this.owner.paint(this); }
}

class UtilityTab implements ITabRenderer {
  readonly element = document.createElement('div');
  private readonly label = document.createElement('div');
  private readonly glyph = document.createElement('span');
  private readonly title = document.createElement('span');
  private titleChanged?: { dispose(): void };
  constructor() {
    this.element.className = 'dv-default-tab';
    this.label.className = 'dv-default-tab-content utility-tab-label';
    this.glyph.className = 'utility-tab-icon';
    this.glyph.setAttribute('aria-hidden', 'true');
    this.label.append(this.glyph, this.title);
    this.element.appendChild(this.label);
    this.element.addEventListener('mousedown', event => {
      if (event.button === 1) { event.preventDefault(); event.stopPropagation(); }
    });
  }
  init(params: TabPartInitParameters) {
    const nodes = TAB_ICONS[params.api.id];
    if (nodes) render(icon(nodes, { size: 14 }), this.glyph);
    else this.glyph.hidden = true;
    this.title.textContent = params.title;
    this.titleChanged = params.api.onDidTitleChange(({title}) => { this.title.textContent = title; });
  }
  dispose() { this.titleChanged?.dispose(); }
}

@customElement('mux-sdk-utility')
export class MuxSDKUtility extends LitElement {
  @property() sessionId = '';
  @property() projectPath = '';
  @property() harness = '';
  @property({ attribute: false }) tasks: Task[] = [];
  @property({ attribute: false }) touched: string[] = [];
  @property({ attribute: false }) events: TrajectoryEvent[] = [];
  private dv?: DockviewComponent;
  private panels = new Map<string, UtilityPanel>();
  private observer?: ResizeObserver;
  private listing?: Listing;
  private selected = '';
  private artifact?: Artifact;
  private pr?: Pull;
  private error = '';
  private fileError = '';
  private pendingFile = 0;
  private trajectorySearch = '';
  private selectedRecord = -1;
  private pathKey() { return `muxterm.sdk.utility.path.${this.sessionId}`; }
  private fileKey() { return `muxterm.sdk.utility.file.${this.sessionId}`; }

  // Dockview owns the light DOM below; Lit never reconciles its tabs or groups.
  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    this.classList.add('dockview-theme-abyss');
    const style = document.createElement('style');
    style.textContent = `${dockviewCss}\n${this.surfaceCSS}`;
    this.appendChild(style);
    const host = document.createElement('div'); host.className = 'utility-dock'; this.appendChild(host);
    this.dv = new DockviewComponent(host, { defaultTabComponent:'utility-tab', createTabComponent: () => new UtilityTab(), createComponent: opts => {
      const panel = new UtilityPanel(opts.id, this); this.panels.set(opts.id, panel); return panel;
    }});
    let restored = false;
    try {
      const saved = localStorage.getItem(KEY + this.sessionId);
      if (saved) this.dv.fromJSON(JSON.parse(saved) as SerializedDockview);
      restored = !!saved;
    } catch { /* A stale layout falls back to the standard three tabs. */ }
    for (const [id, title] of [['plan','Plan'], ['files','Files'], ['pr','PR'], ['trajectory','Trajectory']]) {
      if (!this.dv.panels.some(p => p.id === id)) this.dv.addPanel({ id, component:id, title });
    }
    if (!restored) this.dv.panels.find(p => p.id === 'plan')?.api.setActive();
    this.dv.onDidLayoutChange(() => { try { localStorage.setItem(KEY + this.sessionId, JSON.stringify(this.dv?.toJSON())); } catch { /* storage unavailable */ } });
    this.observer = new ResizeObserver(() => this.dv?.layout(host.clientWidth, host.clientHeight));
    this.observer.observe(host);
    let folder = '.', file = '';
    try { folder = localStorage.getItem(this.pathKey()) || '.'; file = localStorage.getItem(this.fileKey()) || ''; } catch { /* private browsing */ }
    void this.loadDirectory(folder);
    if (file) void this.openFile(file);
    void this.loadPR();
  }
  override disconnectedCallback() {
    this.observer?.disconnect();
    this.dv?.dispose(); this.dv = undefined;
    this.panels.clear();
    super.disconnectedCallback();
  }
  override updated() { this.paintAll(); }
  private endpoint(kind: string, path?: string) {
    const base = `/api/sdk-chats/${encodeURIComponent(this.sessionId)}/utility/${kind}`;
    return apiPath(base) + (path ? `?${new URLSearchParams({path})}` : '');
  }
  private async loadDirectory(path: string) {
    this.error = '';
    try {
      const response = await fetch(this.endpoint('files', path));
      if (!response.ok) throw new Error(`Folder unavailable (${response.status})`);
      this.listing = await response.json() as Listing;
      try { localStorage.setItem(this.pathKey(), this.listing.path); } catch { /* private browsing */ }
    } catch (error) { this.error = String(error); }
    this.paintAll();
  }
  private async openFile(path: string) {
    this.selected = path; this.artifact = undefined; this.fileError = '';
    try { localStorage.setItem(this.fileKey(), path); } catch { /* private browsing */ }
    const current = ++this.pendingFile;
    this.paintAll();
    try {
      const response = await fetch(this.endpoint('file', path));
      if (!response.ok) throw new Error(`File unavailable (${response.status})`);
      const result = await response.json() as Artifact;
      if (current === this.pendingFile) this.artifact = result;
    } catch (error) { if (current === this.pendingFile) this.fileError = String(error); }
    this.paintAll();
  }
  private async loadPR() {
    try { const response = await fetch(this.endpoint('pr')); if (response.ok) this.pr = await response.json() as Pull; }
    catch { /* An absent PR has its own honest empty state. */ }
    this.paintAll();
  }
  paint(panel: UtilityPanel) {
    if (panel.id === 'plan') render(this.planView(), panel.element);
    if (panel.id === 'files') render(this.filesView(), panel.element);
    if (panel.id === 'pr') render(this.prView(), panel.element);
    if (panel.id === 'trajectory') render(this.trajectoryView(), panel.element);
  }
  private paintAll() { for (const panel of this.panels.values()) this.paint(panel); }
  private planView() { return html`<section class="utility-content"><h2>Plan <small>${this.harness}</small></h2>${this.tasks.length
    ? html`<ol class="task-list">${this.tasks.map(task => html`<li><span class="task-state">${task.status}</span><span>${task.content}</span></li>`)}</ol>`
    : html`<p class="empty">No task list has been shared by this chat yet.</p>`}</section>`; }
  private filesView() {
    const listing = this.listing;
    const parent = listing?.path === '.' ? '' : listing?.path.split('/').slice(0,-1).join('/') || '.';
    const artifact = this.artifact;
    return html`<section class="files-panel"><div class="browser"><h2>Files</h2><div class="root" title=${listing?.root || this.projectPath}>${listing?.root || this.projectPath}</div>
      <div class="path">${listing?.path === '.' ? '/' : `/${listing?.path}`}</div>
      ${parent ? html`<button class="entry" @click=${() => void this.loadDirectory(parent)}>↰ &nbsp; ..</button>` : nothing}
      ${listing?.entries.map(e => html`<button class="entry ${this.selected === (listing.path === '.' ? e.name : `${listing.path}/${e.name}`) ? 'selected' : ''}" @click=${() => { const p = listing.path === '.' ? e.name : `${listing.path}/${e.name}`; void (e.dir ? this.loadDirectory(p) : this.openFile(p)); }}>${e.dir ? '▸' : '·'} &nbsp; ${e.name}</button>`)}
      ${this.error ? html`<p class="empty">${this.error}</p>` : nothing}
      <h3>Produced or touched</h3>${this.touched.length ? this.touched.map(p => html`<button class="entry" @click=${() => void this.openFile(p)}>${p}</button>`) : html`<p class="empty">No file paths were reported by this chat yet.</p>`}</div>
      <div class="viewer"><h2>${artifact?.name || (this.selected || 'Viewer')}</h2>${artifact ? artifact.tooLarge ? html`<p class="empty">Too large to display.</p>` : artifact.binary || artifact.kind === 'download' ? html`<p class="empty">This file cannot be rendered safely. <a href=${this.endpoint('raw', this.selected)} download>Download file</a></p>` : artifact.kind === 'image' ? html`<img src=${this.endpoint('raw', this.selected)} alt=${artifact.name}>` : artifact.kind === 'markdown' ? html`<div class="markdown">${renderSegments(parseMarkdown(artifact.text))}</div>` : html`<pre>${artifact.text}</pre>` : html`<p class="empty">${this.fileError || (this.selected ? 'Opening file…' : 'Select a file to inspect it.')}</p>`}</div></section>`;
  }
  private prView() { const pr = this.pr; return html`<section class="utility-content"><h2>Pull request</h2><p class="branch">Branch · ${pr?.branch || 'unknown'}</p>${pr?.number
    ? html`<div class="pr-number">#${pr.number} <span>${pr.state || 'State unavailable'}</span></div><h3>${pr.title || 'Untitled pull request'}</h3>${pr.url?.startsWith('https://') ? html`<a href=${pr.url} target="_blank" rel="noopener noreferrer">Open pull request ↗</a>` : nothing}`
    : html`<p class="empty">No pull request is associated with this project branch.</p>`}</section>`; }
  private trajectoryRecords(): TrajectoryRecord[] {
    const records: TrajectoryRecord[] = [];
    let turn = 0;
    for (const event of this.events) {
      const at = event.at ? Date.parse(event.at) : undefined;
      if (event.type === 'input.accepted') {
        turn++;
        records.push({ id:records.length, turn, kind:'User', label:event.text || '(attachment)', start:at, input:event.text, status:'accepted' });
      } else if (event.type === 'assistant.delta' || event.type === 'thinking.delta') {
        const kind = event.type === 'assistant.delta' ? 'Assistant' : 'Thinking';
        const last = records[records.length - 1];
        if (last?.kind === kind && last.status === 'streaming') {
          last.label += event.text || ''; last.output = last.label; last.end = at;
        } else records.push({ id:records.length, turn, kind, label:event.text || '', start:at, end:at, output:event.text, status:'streaming' });
      } else if (event.type === 'tool.started') {
        records.push({ id:records.length, turn, kind:'Tool', label:event.name || 'Tool', start:at, input:event.raw, status:'running' });
      } else if (event.type === 'tool.completed') {
        const target = [...records].reverse().find(row => row.kind === 'Tool' && row.status === 'running' && row.label === (event.name || 'Tool'));
        if (target) { target.end = at; target.output = event.raw; target.status = event.failed ? 'failed' : 'completed'; }
        else records.push({ id:records.length, turn, kind:'Tool', label:event.name || 'Tool', end:at, output:event.raw, status:event.failed ? 'failed' : 'completed' });
        const child = [...records].reverse().find(row => row.kind === 'Sub-agent' && row.toolId === event.toolId);
        if (child && child.output === undefined) child.output = event.raw;
      } else if (event.type === 'delegate.spawned') {
        records.push({ id:records.length, turn, kind:'Sub-agent', label:event.agent || 'Agent', start:at, input:event.childSessionId, status:'running', childId:event.childSessionId, toolId:event.toolId });
      } else if (event.type === 'delegate.message') {
        const target = [...records].reverse().find(row => row.kind === 'Sub-agent' && row.childId === event.childSessionId);
        if (target) target.output = event.complete ? event.text : String(target.output || '') + (event.text || '');
      } else if (event.type === 'delegate.completed') {
        const target = [...records].reverse().find(row => row.kind === 'Sub-agent' && row.childId === event.childSessionId && row.status === 'running');
        if (target) { target.end = at; target.status = event.failed ? 'failed' : 'completed'; }
      } else if (event.type === 'turn.completed' || event.type === 'turn.cancelled' || event.type === 'error') {
        for (const row of records) if (row.turn === turn && row.status === 'streaming') row.status = 'completed';
        records.push({ id:records.length, turn, kind:'Step', label:event.type === 'error' ? event.message || 'Error' : event.type === 'turn.cancelled' ? 'Stopped' : 'Completed', end:at, status:event.type });
      }
    }
    return records;
  }
  private trajectoryView() {
    const records = this.trajectoryRecords();
    const dated = records.filter(row => row.start !== undefined || row.end !== undefined);
    const first = Math.min(...dated.map(row => row.start ?? row.end ?? Infinity));
    const last = Math.max(...dated.map(row => row.end ?? row.start ?? -Infinity));
    const span = Math.max(1, last - first);
    const query = this.trajectorySearch.toLowerCase();
    const visible = records.filter(row => !query || `${row.kind} ${row.label} ${JSON.stringify(row.input || '')} ${JSON.stringify(row.output || '')}`.toLowerCase().includes(query));
    const selected = records.find(row => row.id === this.selectedRecord);
    const detail = (value: unknown) => value === undefined ? 'Unavailable from harness' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return html`<section class="utility-content trajectory"><h2>Trajectory</h2><p class="empty">Turn ledger and recorded timing</p>
      ${dated.length ? html`<div class="trajectory-overview" aria-label="Timing overview">${dated.map(row => html`<button class="trajectory-mark ${row.kind.toLowerCase()}" style=${`left:${((row.start ?? row.end ?? first)-first)/span*100}%;width:${Math.max(2,((row.end ?? row.start ?? first)-(row.start ?? row.end ?? first))/span*100)}%`} title=${`${row.kind}: ${row.label.slice(0,80)}`} @click=${() => { this.selectedRecord=row.id; this.paintAll(); }}></button>`)}</div><div class="trajectory-scale">${new Date(first).toLocaleTimeString()} → ${new Date(last).toLocaleTimeString()}</div>` : nothing}
      <input class="trajectory-search" type="search" aria-label="Search trajectory" placeholder="Search records" .value=${this.trajectorySearch} @input=${(e: InputEvent) => { this.trajectorySearch=(e.target as HTMLInputElement).value; this.paintAll(); }}>
      ${visible.length ? html`<div class="trajectory-ledger">${visible.map((row, index) => html`${(index === 0 || visible[index-1].turn !== row.turn) ? html`<div class="trajectory-turn">Turn ${row.turn || 1}</div>` : nothing}<button class="trajectory-row ${this.selectedRecord === row.id ? 'selected' : ''}" @click=${() => { this.selectedRecord=row.id; this.paintAll(); }}><span class="trajectory-time">${row.start === undefined ? '—' : new Date(row.start).toLocaleTimeString()}</span><span class="trajectory-kind">${row.kind}</span><span class="trajectory-label">${row.label.slice(0,180)}</span><span class="trajectory-duration">${row.start !== undefined && row.end !== undefined && row.status !== 'running' ? `${Math.max(0,row.end-row.start)} ms` : row.status}</span></button>`)}</div>` : html`<p class="empty">${records.length ? 'No matching records.' : 'No session activity recorded yet.'}</p>`}
      ${selected ? html`<div class="trajectory-inspector"><h3>${selected.kind} · Turn ${selected.turn}</h3><p>${selected.status}${selected.start !== undefined ? ` · ${new Date(selected.start).toLocaleString()}` : ''}</p><h3>Input</h3><pre>${detail(selected.input)}</pre><h3>Output</h3><pre>${detail(selected.output)}</pre></div>` : nothing}
    </section>`;
  }
  private surfaceCSS = `
    mux-sdk-utility { display:block; min-width:0; height:100%; background:#202632; color:#d9def0; font:13px/1.5 system-ui,sans-serif; }
    mux-sdk-utility * { scrollbar-width:thin; scrollbar-color:color-mix(in srgb,var(--chrome-text-dim,#9aa3b8) 34%,transparent) transparent; }
    mux-sdk-utility *::-webkit-scrollbar { width:6px; height:6px; }
    mux-sdk-utility *::-webkit-scrollbar-track { background:transparent; }
    mux-sdk-utility *::-webkit-scrollbar-thumb { background:color-mix(in srgb,var(--chrome-text-dim,#9aa3b8) 34%,transparent); border-radius:999px; }
    mux-sdk-utility *::-webkit-scrollbar-thumb:hover { background:color-mix(in srgb,var(--chrome-text-dim,#9aa3b8) 58%,transparent); }
    mux-sdk-utility .utility-dock { width:100%; height:100%; }
    mux-sdk-utility .dv-dockview { --dv-background-color:#202632; --dv-tabs-and-actions-container-background-color:#252c3a; --dv-activegroup-visiblepanel-tab-background-color:#35445f; --dv-inactivegroup-visiblepanel-tab-background-color:#2b3548; --dv-activegroup-visiblepanel-tab-color:#eef2ff; --dv-inactivegroup-visiblepanel-tab-color:#c1cbdd; --dv-separator-border:1px solid #41485f; }
    mux-sdk-utility .dv-tab { padding-inline:14px; }
    mux-sdk-utility .utility-tab-label { display:inline-flex; align-items:center; gap:5px; }
    mux-sdk-utility .utility-tab-icon { display:inline-flex; flex:none; align-items:center; }
    mux-sdk-utility .utility-panel { width:100%; height:100%; overflow:auto; }
    mux-sdk-utility h2 { font-size:14px; margin:0 0 12px; } mux-sdk-utility h2 small { font-size:11px; color:#96a4bc; font-weight:400; margin-left:8px; }
    mux-sdk-utility h3 { font-size:12px; margin:18px 0 7px; } mux-sdk-utility .utility-content { padding:20px; }
    mux-sdk-utility .empty { color:#aab5ca; line-height:1.6; } mux-sdk-utility a { color:#abc7ff; }
    mux-sdk-utility .task-list { padding-left:18px; } mux-sdk-utility .task-list li { margin:10px 0; } mux-sdk-utility .task-state { color:#9bb8f7; font-size:11px; margin-right:9px; text-transform:capitalize; }
    mux-sdk-utility .files-panel { display:grid; grid-template-columns:minmax(125px,36%) minmax(0,1fr); min-height:100%; }
    mux-sdk-utility .browser { border-right:1px solid #41485f; padding:16px 10px; min-width:0; } mux-sdk-utility .viewer { min-width:0; padding:16px; overflow:auto; }
    mux-sdk-utility .root { color:#98a8c2; overflow-wrap:anywhere; font:11px/1.4 ui-monospace,monospace; }
    mux-sdk-utility .path { margin:10px 0; color:#b8c8e4; font:11px ui-monospace,monospace; overflow-wrap:anywhere; }
    mux-sdk-utility .entry { display:block; width:100%; text-align:left; border:0; background:transparent; color:#d9def0; padding:5px 7px; border-radius:5px; cursor:pointer; overflow-wrap:anywhere; font:12px/1.4 system-ui,sans-serif; }
    mux-sdk-utility .entry:hover, mux-sdk-utility .entry.selected { background:#35445f; }
    mux-sdk-utility .viewer img { max-width:100%; height:auto; } mux-sdk-utility .viewer pre { white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.5 ui-monospace,monospace; }
    mux-sdk-utility .markdown { overflow-wrap:anywhere; } mux-sdk-utility .markdown pre { padding:10px; background:#151b28; overflow:auto; }
    mux-sdk-utility .pr-number { font-size:24px; font-weight:700; } mux-sdk-utility .pr-number span { font-size:11px; color:#9bb8f7; font-weight:500; } mux-sdk-utility .branch { color:#aab5ca; }
    mux-sdk-utility .trajectory-overview { position:relative; height:36px; margin:14px 0 4px; background:#151b28; border:1px solid #41485f; border-radius:6px; overflow:hidden; }
    mux-sdk-utility .trajectory-mark { position:absolute; top:5px; height:26px; border:0; border-radius:3px; background:#7896d9; opacity:.85; min-width:2px; padding:0; }
    mux-sdk-utility .trajectory-mark.tool { background:#c2a570; top:10px; height:16px; } mux-sdk-utility .trajectory-mark.thinking { background:#aa93ca; top:14px; height:10px; }
    mux-sdk-utility .trajectory-mark.sub-agent { background:#79bdab; top:7px; height:22px; }
    mux-sdk-utility .trajectory-scale { color:#97a5bc; font:10px ui-monospace,monospace; margin-bottom:14px; }
    mux-sdk-utility .trajectory-search { width:100%; box-sizing:border-box; border:1px solid #41485f; border-radius:6px; padding:7px 9px; background:#151b28; color:inherit; margin-bottom:12px; }
    mux-sdk-utility .trajectory-ledger { border-top:1px solid #41485f; }
    mux-sdk-utility .trajectory-turn { padding:8px 3px 5px; color:#b4c4e2; background:#242e3e; border-bottom:1px solid #41485f; font-size:11px; font-weight:650; }
    mux-sdk-utility .trajectory-row { display:grid; grid-template-columns:70px 65px minmax(0,1fr) 60px; gap:6px; align-items:start; width:100%; padding:8px 4px; border:0; border-bottom:1px solid #394354; background:transparent; color:inherit; text-align:left; cursor:pointer; font:11px/1.4 system-ui,sans-serif; }
    mux-sdk-utility .trajectory-row:hover, mux-sdk-utility .trajectory-row.selected { background:#35445f; }
    mux-sdk-utility .trajectory-time, mux-sdk-utility .trajectory-duration { color:#9aa9c0; font:10px/1.5 ui-monospace,monospace; }
    mux-sdk-utility .trajectory-kind { color:#9bb8f7; } mux-sdk-utility .trajectory-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .trajectory-inspector { margin-top:18px; border-top:1px solid #41485f; padding-top:4px; } mux-sdk-utility .trajectory-inspector pre { max-height:260px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; background:#151b28; padding:10px; border-radius:6px; font:11px/1.5 ui-monospace,monospace; }
    @media(max-width:560px) { mux-sdk-utility .files-panel { grid-template-columns:1fr; } mux-sdk-utility .browser { border-right:0; border-bottom:1px solid #41485f; max-height:40vh; overflow:auto; } }
  `;
}
