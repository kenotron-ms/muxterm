import { LitElement, html, render, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { DockviewComponent, type IContentRenderer, type ITabRenderer, type TabPartInitParameters, type SerializedDockview } from 'dockview-core';
import { Folder, GitPullRequest, ListTodo, Route, type IconNode } from 'lucide';
import dockviewCss from 'dockview-core/dist/styles/dockview.css?inline';
import { apiPath } from '../lib/base-path.js';
import { icon } from '../lib/icons.js';
import { parseMarkdown } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import './mux-sdk-pdf-preview.js';
type Artifact = {
  path: string; name: string; size: number; modified: number;
  kind: 'markdown' | 'text' | 'image' | 'download'; contentType: string;
  text: string; tooLarge: boolean; maxBytes: number; binary: boolean;
};

type Task = { content: string; status: string };
type Entry = { name: string; dir: boolean; size: number; modified: number };
type Listing = { root: string; path: string; entries: Entry[]; truncated: boolean };
type Pull = { number: number; title: string; state: string; branch: string; url: string };
type TrajectoryEvent = { type: string; at?: string; text?: string; name?: string; toolId?: string; raw?: unknown; kind?: string; failed?: boolean; complete?: boolean; message?: string; childSessionId?: string; agent?: string };
type TrajectoryRecord = { id: number; turn: number; kind: string; label: string; start?: number; end?: number; input?: unknown; output?: unknown; status: string; childId?: string; toolId?: string };
const KEY = 'muxterm.sdk.utility.layout.';
const TAB_ICONS: Record<string, IconNode> = { plan: ListTodo, files: Folder, pr: GitPullRequest, trajectory: Route };

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tableRows(source: string, separator: string): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const pushCell = () => { if (row.length < 30) row.push(cell); cell = ''; };
  const pushRow = () => { pushCell(); if (row.some(value => value !== '')) rows.push(row); row = []; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { if (cell.length < 4000) cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else if (cell.length < 4000) cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === separator) pushCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      pushRow();
      if (rows.length >= 201) return { rows, truncated: i < source.length - 1 };
    } else if (cell.length < 4000) cell += char;
  }
  if (cell !== '' || row.length) pushRow();
  return { rows, truncated: false };
}

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
  private fileQuery = '';
  private fileSort: 'name' | 'recent' | 'size' = 'name';
  private filesRailOpen = true;
  private fileMode: 'preview' | 'source' = 'preview';
  private interactivePreview = false;
  private localSource = '';
  private pdfBytes: Uint8Array<ArrayBuffer> | null = null;
  private fileAbort?: AbortController;
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
    this.fileAbort?.abort();
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
  showPanel(id: 'plan' | 'files' | 'pr' | 'trajectory'): void {
    this.dv?.panels.find(panel => panel.id === id)?.api.setActive();
  }
  private previewURL(path: string, maxBytes: number): string {
    return `${this.endpoint('raw', path)}&max_bytes=${maxBytes}`;
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
    this.fileAbort?.abort();
    const controller = new AbortController();
    this.fileAbort = controller;
    this.selected = path; this.artifact = undefined; this.fileError = '';
    this.localSource = ''; this.pdfBytes = null; this.fileMode = 'preview'; this.interactivePreview = false;
    try { localStorage.setItem(this.fileKey(), path); } catch { /* private browsing */ }
    const current = ++this.pendingFile;
    this.paintAll();
    try {
      const response = await fetch(this.endpoint('file', path), { signal: controller.signal });
      if (!response.ok) throw new Error(`File unavailable (${response.status})`);
      const result = await response.json() as Artifact;
      if (current !== this.pendingFile || controller.signal.aborted) return;
      this.artifact = result;
      this.paintAll();
      const ext = result.name.toLowerCase().split('.').pop();
      if (!result.tooLarge && result.size <= 2 * 1024 * 1024 && (ext === 'html' || ext === 'htm' || ext === 'svg')) {
        const raw = await fetch(this.previewURL(path, 2 * 1024 * 1024), { signal: controller.signal });
        if (raw.ok) {
          const bytes = await raw.arrayBuffer();
          if (current === this.pendingFile && !controller.signal.aborted) {
            try { this.localSource = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
            catch { this.fileError = 'This file is not UTF-8 text.'; }
          }
        }
      } else if (!result.tooLarge && result.size <= 8 * 1024 * 1024 && ext === 'pdf') {
        const raw = await fetch(this.previewURL(path, 8 * 1024 * 1024), { signal: controller.signal });
        if (raw.ok) {
          const bytes = new Uint8Array(await raw.arrayBuffer());
          if (current === this.pendingFile && !controller.signal.aborted) this.pdfBytes = bytes;
        }
      }
    } catch (error) { if (current === this.pendingFile && !controller.signal.aborted) this.fileError = String(error); }
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
  private askAboutFile() {
    if (!this.selected) return;
    this.dispatchEvent(new CustomEvent('sdk-file-reference', { bubbles: true, composed: true, detail: {
      path: this.selected, modified: this.artifact?.modified,
      selected: window.getSelection()?.toString().trim().slice(0, 600) || '',
    } }));
  }
  private fileBody(): TemplateResult {
    const file = this.artifact;
    if (!file) return html`<div class="file-empty">${this.fileError || (this.selected ? 'Opening file…' : 'Choose a file to preview it here.')}</div>`;
    if (file.tooLarge) return html`<div class="file-empty">This file is too large to preview. Download it to inspect the full contents.</div>`;
    const extension = file.name.toLowerCase().split('.').pop();
    if (this.fileMode === 'source') return html`<pre class="source-view">${extension === 'html' || extension === 'htm' || extension === 'svg' ? this.localSource : file.text}</pre>`;
    if (extension === 'pdf') return this.pdfBytes ? html`<mux-sdk-pdf-preview .bytes=${this.pdfBytes}></mux-sdk-pdf-preview>` : html`<div class="file-empty">${this.fileError || 'Loading PDF preview…'}</div>`;
    if (extension === 'html' || extension === 'htm' || extension === 'svg') {
      if (!this.localSource) return html`<div class="file-empty">${this.fileError || 'Loading preview…'}</div>`;
      const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src ${this.interactivePreview ? "'unsafe-inline'" : "'none'"}; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;
      return html`<div class="sandbox-note">${this.interactivePreview ? 'Scripts enabled for this preview' : 'Static preview · scripts disabled'}${!this.interactivePreview ? html` <button @click=${() => { this.interactivePreview = true; this.paintAll(); }}>Run preview</button>` : nothing}</div><iframe class="document-frame" title=${`Preview of ${file.name}`} sandbox=${this.interactivePreview ? 'allow-scripts' : ''} .srcdoc=${policy + this.localSource}></iframe>`;
    }
    if (file.kind === 'image') return html`<div class="image-view"><img src=${this.endpoint('raw', this.selected)} alt=${file.name}></div>`;
    if (file.binary || file.kind === 'download') return html`<div class="file-empty">Preview unavailable for this file type.</div>`;
    if (extension === 'csv' || extension === 'tsv') {
      const data = tableRows(file.text, extension === 'tsv' ? '\t' : ',');
      return html`<div class="table-view"><table><tbody>${data.rows.map((row, index) => html`<tr>${row.map(value => index === 0 ? html`<th>${value}</th>` : html`<td>${value}</td>`)}</tr>`)}</tbody></table>${data.truncated ? html`<p class="empty">Showing the first 200 rows.</p>` : nothing}</div>`;
    }
    if (file.kind === 'markdown') return html`<div class="markdown document-view">${renderSegments(parseMarkdown(file.text))}</div>`;
    return html`<pre class="source-view">${file.text}</pre>`;
  }
  private filesView() {
    const listing = this.listing;
    const folder = listing?.path || '.';
    const segments = folder === '.' ? [] : folder.split('/');
    const entries = [...(listing?.entries || [])].filter(entry => entry.name.toLowerCase().includes(this.fileQuery.toLowerCase()));
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || (this.fileSort === 'recent' ? b.modified - a.modified : this.fileSort === 'size' ? b.size - a.size : a.name.localeCompare(b.name)));
    const file = this.artifact;
    return html`<section class="files-panel ${this.filesRailOpen ? '' : 'rail-closed'}">
      ${this.filesRailOpen ? html`<div class="browser"><div class="browser-heading"><div><h2>Project files</h2><div class="root" title=${listing?.root || this.projectPath}>${listing?.root || this.projectPath || 'Project folder'}</div></div><button class="icon-button" aria-label="Hide file browser" title="Hide file browser" @click=${() => { this.filesRailOpen = false; this.paintAll(); }}>☰</button></div>
        <nav class="breadcrumbs" aria-label="File path"><button @click=${() => void this.loadDirectory('.')}>Project</button>${segments.map((part, index) => html`<span>/</span><button @click=${() => void this.loadDirectory(segments.slice(0, index + 1).join('/'))}>${part}</button>`)}</nav>
        <div class="browser-tools"><input type="search" aria-label="Search files in current folder" placeholder="Search this folder" .value=${this.fileQuery} @input=${(event: InputEvent) => { this.fileQuery = (event.target as HTMLInputElement).value; this.paintAll(); }}><select aria-label="Sort files" .value=${this.fileSort} @change=${(event: Event) => { this.fileSort = (event.target as HTMLSelectElement).value as typeof this.fileSort; this.paintAll(); }}><option value="name">Name</option><option value="recent">Recent</option><option value="size">Size</option></select></div>
        <div class="file-list" role="list">${segments.length ? html`<button class="file-entry parent" @click=${() => void this.loadDirectory(segments.slice(0, -1).join('/') || '.')}><span class="file-glyph">↰</span><span class="file-name">Parent folder</span></button>` : nothing}
          ${entries.map(entry => { const path = folder === '.' ? entry.name : `${folder}/${entry.name}`; return html`<button class="file-entry ${this.selected === path ? 'selected' : ''}" title=${path} @click=${() => void (entry.dir ? this.loadDirectory(path) : this.openFile(path))}><span class="file-glyph">${entry.dir ? '▸' : '▤'}</span><span class="file-name">${entry.name}</span><span class="file-size">${entry.dir ? '' : readableSize(entry.size)}</span></button>`; })}
          ${this.error ? html`<p class="empty">${this.error}</p>` : nothing}${!this.error && !entries.length ? html`<p class="empty">${this.fileQuery ? 'No matching files.' : 'This folder is empty.'}</p>` : nothing}${listing?.truncated ? html`<p class="empty">Showing the first 500 items in this folder.</p>` : nothing}
        </div><div class="touched-files"><h3>From this chat</h3>${this.touched.length ? this.touched.map(path => html`<button class="touched-entry" title=${path} @click=${() => void this.openFile(path)}>${path}</button>`) : html`<p class="empty">Files used by this chat appear here.</p>`}</div></div>` : nothing}
      <div class="viewer"><header class="viewer-header"><button class="icon-button" aria-label=${this.filesRailOpen ? 'Hide file browser' : 'Show file browser'} title=${this.filesRailOpen ? 'Hide file browser' : 'Show file browser'} @click=${() => { this.filesRailOpen = !this.filesRailOpen; this.paintAll(); }}>☰</button><div class="viewer-title"><h2>${file?.name || (this.selected ? this.selected.split('/').pop() : 'Preview')}</h2><span title=${this.selected}>${this.selected || 'Select a file from your project'}</span></div>${file ? html`<span class="viewer-meta">${readableSize(file.size)}</span>` : nothing}</header>
        ${file ? html`<div class="viewer-actions">${!file.binary && !file.tooLarge && (file.kind === 'markdown' || file.kind === 'text' || /\.(html?|svg)$/i.test(file.name)) ? html`<div class="view-switch"><button class=${this.fileMode === 'preview' ? 'active' : ''} @click=${() => { this.fileMode = 'preview'; this.paintAll(); }}>Preview</button><button class=${this.fileMode === 'source' ? 'active' : ''} @click=${() => { this.fileMode = 'source'; this.paintAll(); }}>Source</button></div>` : nothing}<span class="action-spacer"></span><button @click=${() => this.askAboutFile()}>Ask about file</button><a href=${this.endpoint('raw', this.selected)} download=${file.name}>Download</a></div>` : nothing}
        <div class="viewer-body">${this.fileBody()}</div></div></section>`;
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
    mux-sdk-utility { display:block; min-width:0; height:100%; background:var(--chrome-bar); color:var(--chrome-text-bright); font:13px/1.5 system-ui,sans-serif; }
    mux-sdk-utility * { scrollbar-width:thin; scrollbar-color:color-mix(in srgb,var(--chrome-text-dim,#9aa3b8) 34%,transparent) transparent; }
    mux-sdk-utility *::-webkit-scrollbar { width:6px; height:6px; }
    mux-sdk-utility *::-webkit-scrollbar-track { background:transparent; }
    mux-sdk-utility *::-webkit-scrollbar-thumb { background:color-mix(in srgb,var(--chrome-text-dim,#9aa3b8) 34%,transparent); border-radius:999px; }
    mux-sdk-utility *::-webkit-scrollbar-thumb:hover { background:color-mix(in srgb,var(--chrome-text-dim,#9aa3b8) 58%,transparent); }
    mux-sdk-utility .utility-dock { width:100%; height:100%; }
    mux-sdk-utility .dv-dockview {
      --dv-background-color:var(--chrome-bar);
      --dv-group-view-background-color:var(--chrome-bar);
      --dv-tabs-and-actions-container-background-color:var(--chrome-bar);
      --dv-activegroup-visiblepanel-tab-background-color:var(--chrome-hover);
      --dv-inactivegroup-visiblepanel-tab-background-color:var(--chrome-bar);
      --dv-activegroup-hiddenpanel-tab-background-color:var(--chrome-bar);
      --dv-inactivegroup-hiddenpanel-tab-background-color:var(--chrome-bar);
      --dv-activegroup-visiblepanel-tab-color:var(--chrome-text-bright);
      --dv-inactivegroup-visiblepanel-tab-color:var(--chrome-text-dim);
      --dv-activegroup-hiddenpanel-tab-color:var(--chrome-text-dim);
      --dv-inactivegroup-hiddenpanel-tab-color:var(--chrome-text-dim);
      --dv-tab-divider-color:var(--chrome-border);
      --dv-separator-border:1px solid var(--chrome-border);
    }
    mux-sdk-utility .dv-tab { padding-inline:14px; }
    mux-sdk-utility .utility-tab-label { display:inline-flex; align-items:center; gap:5px; }
    mux-sdk-utility .utility-tab-icon { display:inline-flex; flex:none; align-items:center; }
    mux-sdk-utility .utility-panel { width:100%; height:100%; overflow:auto; container-type:inline-size; }
    mux-sdk-utility h2 { font-size:14px; margin:0 0 12px; } mux-sdk-utility h2 small { font-size:11px; color:var(--chrome-text-dim); font-weight:400; margin-left:8px; }
    mux-sdk-utility h3 { font-size:12px; margin:18px 0 7px; } mux-sdk-utility .utility-content { padding:20px; }
    mux-sdk-utility .empty { color:var(--chrome-text-dim); line-height:1.6; } mux-sdk-utility a { color:var(--chrome-accent); }
    mux-sdk-utility .task-list { padding-left:18px; } mux-sdk-utility .task-list li { margin:10px 0; } mux-sdk-utility .task-state { color:var(--chrome-accent); font-size:11px; margin-right:9px; text-transform:capitalize; }
    mux-sdk-utility .files-panel { display:grid; grid-template-columns:minmax(220px,35%) minmax(0,1fr); height:100%; min-width:0; overflow:hidden; }
    mux-sdk-utility .files-panel.rail-closed { grid-template-columns:minmax(0,1fr); }
    mux-sdk-utility .browser { display:flex; flex-direction:column; min-width:0; min-height:0; border-right:1px solid var(--chrome-border); background:color-mix(in srgb,var(--chrome-body) 55%,var(--chrome-bar)); }
    mux-sdk-utility .browser-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; padding:15px 13px 10px; }
    mux-sdk-utility .browser-heading h2 { margin:0 0 2px; font-size:13px; }
    mux-sdk-utility .root { color:var(--chrome-text-dim); max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:10px/1.4 ui-monospace,monospace; }
    mux-sdk-utility .icon-button { flex:none; width:28px; height:28px; padding:0; border:1px solid var(--chrome-border); border-radius:6px; background:transparent; color:var(--chrome-text-dim); }
    mux-sdk-utility .icon-button:hover { color:var(--chrome-text-bright); background:var(--chrome-hover); }
    mux-sdk-utility .breadcrumbs { display:flex; align-items:center; gap:4px; overflow:auto; white-space:nowrap; padding:0 13px 10px; color:var(--chrome-text-dim); }
    mux-sdk-utility .breadcrumbs button { border:0; padding:2px 1px; background:transparent; color:var(--chrome-accent); font:11px system-ui,sans-serif; }
    mux-sdk-utility .browser-tools { display:flex; gap:6px; padding:0 10px 10px; }
    mux-sdk-utility .browser-tools input, mux-sdk-utility .browser-tools select { box-sizing:border-box; min-width:0; border:1px solid var(--chrome-border); border-radius:6px; background:var(--chrome-bar); color:var(--chrome-text-bright); padding:6px 7px; font:11px system-ui,sans-serif; }
    mux-sdk-utility .browser-tools input { flex:1; } mux-sdk-utility .browser-tools select { width:75px; }
    mux-sdk-utility .file-list { flex:1; min-height:0; overflow:auto; padding:3px 7px 10px; border-top:1px solid var(--chrome-border); }
    mux-sdk-utility .file-entry { display:flex; align-items:center; gap:7px; width:100%; min-height:33px; border:0; border-radius:6px; padding:4px 7px; background:transparent; color:var(--chrome-text-bright); text-align:left; font:12px system-ui,sans-serif; }
    mux-sdk-utility .file-entry:hover, mux-sdk-utility .file-entry.selected { background:var(--chrome-hover); }
    mux-sdk-utility .file-entry.selected { box-shadow:inset 2px 0 var(--chrome-accent); }
    mux-sdk-utility .file-glyph { flex:none; width:17px; color:var(--chrome-accent); text-align:center; }
    mux-sdk-utility .file-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .file-size { color:var(--chrome-text-dim); font:10px ui-monospace,monospace; white-space:nowrap; }
    mux-sdk-utility .touched-files { max-height:28%; min-height:65px; overflow:auto; border-top:1px solid var(--chrome-border); padding:7px 10px 10px; }
    mux-sdk-utility .touched-files h3 { margin:0 0 4px; font-size:11px; color:var(--chrome-text-dim); text-transform:uppercase; letter-spacing:.05em; }
    mux-sdk-utility .touched-entry { display:block; width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; padding:4px 5px; border:0; border-radius:4px; color:var(--chrome-text-bright); background:transparent; font:11px ui-monospace,monospace; }
    mux-sdk-utility .touched-entry:hover { background:var(--chrome-hover); }
    mux-sdk-utility .touched-files .empty, mux-sdk-utility .file-list .empty { margin:8px; font-size:11px; }
    mux-sdk-utility .viewer { display:flex; flex-direction:column; min-width:0; min-height:0; }
    mux-sdk-utility .viewer-header { display:flex; align-items:center; gap:10px; min-height:55px; box-sizing:border-box; border-bottom:1px solid var(--chrome-border); padding:7px 14px; }
    mux-sdk-utility .viewer-title { flex:1; min-width:0; } mux-sdk-utility .viewer-title h2 { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:0; font-size:13px; }
    mux-sdk-utility .viewer-title span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--chrome-text-dim); font:10px ui-monospace,monospace; }
    mux-sdk-utility .viewer-meta { color:var(--chrome-text-dim); font:10px ui-monospace,monospace; white-space:nowrap; }
    mux-sdk-utility .viewer-actions { display:flex; align-items:center; gap:8px; min-height:45px; box-sizing:border-box; border-bottom:1px solid var(--chrome-border); padding:7px 13px; }
    mux-sdk-utility .viewer-actions button, mux-sdk-utility .viewer-actions a, mux-sdk-utility .sandbox-note button { border:1px solid var(--chrome-border); border-radius:6px; background:var(--chrome-bar); color:var(--chrome-text-bright); padding:5px 8px; text-decoration:none; font:11px system-ui,sans-serif; white-space:nowrap; }
    mux-sdk-utility .viewer-actions button:hover, mux-sdk-utility .viewer-actions a:hover, mux-sdk-utility .sandbox-note button:hover { background:var(--chrome-hover); }
    mux-sdk-utility .view-switch { display:flex; } mux-sdk-utility .view-switch button { border-radius:0; } mux-sdk-utility .view-switch button:first-child { border-radius:6px 0 0 6px; } mux-sdk-utility .view-switch button:last-child { border-radius:0 6px 6px 0; border-left:0; }
    mux-sdk-utility .view-switch button.active { color:var(--chrome-accent); background:var(--chrome-hover); }
    mux-sdk-utility .action-spacer { flex:1; }
    mux-sdk-utility .viewer-body { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; }
    mux-sdk-utility .file-empty { margin:auto; padding:20px; max-width:340px; text-align:center; color:var(--chrome-text-dim); }
    mux-sdk-utility .source-view { box-sizing:border-box; flex:1; margin:0; padding:20px; overflow:auto; white-space:pre; color:var(--chrome-text-bright); font:12px/1.6 ui-monospace,monospace; tab-size:2; }
    mux-sdk-utility .document-view { padding:18px 25px; overflow-wrap:anywhere; }
    mux-sdk-utility .document-view pre { padding:10px; background:var(--chrome-body); overflow:auto; }
    mux-sdk-utility .image-view { display:flex; justify-content:center; align-items:flex-start; padding:18px; }
    mux-sdk-utility .image-view img { max-width:100%; max-height:calc(100vh - 200px); object-fit:contain; }
    mux-sdk-utility .table-view { flex:1; overflow:auto; padding:12px; } mux-sdk-utility .table-view table { border-collapse:collapse; font:11px/1.5 system-ui,sans-serif; }
    mux-sdk-utility .table-view th, mux-sdk-utility .table-view td { border:1px solid var(--chrome-border); padding:5px 9px; max-width:320px; min-width:65px; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
    mux-sdk-utility .table-view th { position:sticky; top:0; background:var(--chrome-bar); font-weight:650; }
    mux-sdk-utility .sandbox-note { display:flex; align-items:center; gap:8px; padding:8px 13px; border-bottom:1px solid var(--chrome-border); color:var(--chrome-text-dim); font-size:11px; }
    mux-sdk-utility .document-frame { display:block; box-sizing:border-box; flex:1; width:100%; min-height:300px; border:0; background:#fff; }
    mux-sdk-utility mux-sdk-pdf-preview { display:block; flex:1; min-height:0; }
    mux-sdk-utility .pr-number { font-size:24px; font-weight:700; } mux-sdk-utility .pr-number span { font-size:11px; color:var(--chrome-accent); font-weight:500; } mux-sdk-utility .branch { color:var(--chrome-text-dim); }
    mux-sdk-utility .trajectory-overview { position:relative; height:36px; margin:14px 0 4px; background:var(--chrome-body); border:1px solid var(--chrome-border); border-radius:6px; overflow:hidden; }
    mux-sdk-utility .trajectory-mark { position:absolute; top:5px; height:26px; border:0; border-radius:3px; background:var(--chrome-accent); opacity:.85; min-width:2px; padding:0; }
    mux-sdk-utility .trajectory-mark.tool { background:var(--mux-warn); top:10px; height:16px; } mux-sdk-utility .trajectory-mark.thinking { background:var(--chrome-driver-accent); top:14px; height:10px; }
    mux-sdk-utility .trajectory-mark.sub-agent { background:var(--mux-ok); top:7px; height:22px; }
    mux-sdk-utility .trajectory-scale { color:var(--chrome-text-dim); font:10px ui-monospace,monospace; margin-bottom:14px; }
    mux-sdk-utility .trajectory-search { width:100%; box-sizing:border-box; border:1px solid var(--chrome-border); border-radius:6px; padding:7px 9px; background:var(--chrome-body); color:inherit; margin-bottom:12px; }
    mux-sdk-utility .trajectory-ledger { border-top:1px solid var(--chrome-border); }
    mux-sdk-utility .trajectory-turn { padding:8px 3px 5px; color:var(--chrome-text-bright); background:var(--chrome-hover); border-bottom:1px solid var(--chrome-border); font-size:11px; font-weight:650; }
    mux-sdk-utility .trajectory-row { display:grid; grid-template-columns:70px 65px minmax(0,1fr) 60px; gap:6px; align-items:start; width:100%; padding:8px 4px; border:0; border-bottom:1px solid var(--chrome-border); background:transparent; color:inherit; text-align:left; cursor:pointer; font:11px/1.4 system-ui,sans-serif; }
    mux-sdk-utility .trajectory-row:hover, mux-sdk-utility .trajectory-row.selected { background:var(--chrome-hover); }
    mux-sdk-utility .trajectory-time, mux-sdk-utility .trajectory-duration { color:var(--chrome-text-dim); font:10px/1.5 ui-monospace,monospace; }
    mux-sdk-utility .trajectory-kind { color:var(--chrome-accent); } mux-sdk-utility .trajectory-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .trajectory-inspector { margin-top:18px; border-top:1px solid var(--chrome-border); padding-top:4px; } mux-sdk-utility .trajectory-inspector pre { max-height:260px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--chrome-body); padding:10px; border-radius:6px; font:11px/1.5 ui-monospace,monospace; }
    @container(max-width:520px) { mux-sdk-utility .files-panel { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(170px,38%) minmax(0,1fr); } mux-sdk-utility .files-panel.rail-closed { grid-template-rows:minmax(0,1fr); } mux-sdk-utility .browser { border-right:0; border-bottom:1px solid var(--chrome-border); } }
  `;
}
