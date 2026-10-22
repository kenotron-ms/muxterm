import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ArrowLeft, ChevronDown, ChevronRight, ChevronsDownUp, Code2, Copy, Download, ExternalLink, File, FileImage, FileJson, FileText, Folder, FolderOpen, GitCompare, Maximize2, MessageCircleQuestionMark, Minimize2, Network, NotebookPen, Plus, RefreshCw, Search, Trash2, X, type IconNode } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { icon } from '../lib/icons.js';
import { parseMarkdown } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import type { PartialBlock } from '@blocknote/core';
import './mux-sdk-pdf-preview.js';
import './mux-monaco-source.js';
import './mux-monaco-diff.js';
import './mux-operator-status.js';
import '../ui/button.js';
import '../ui/dialog.js';
import '../ui/menu.js';
import '../ui/rail-row.js';
import '../ui/select.js';
import '../ui/tab-strip.js';
import type { TabStripItem } from '../ui/tab-strip.js';
import '../ui/text-field.js';
import type { MuxUISelect } from '../ui/select.js';
import type { MuxUITextField } from '../ui/text-field.js';
import type { MuxUIRailRow } from '../ui/rail-row.js';
type Artifact = {
  path: string; name: string; size: number; modified: number;
  kind: 'markdown' | 'text' | 'image' | 'download'; contentType: string;
  text: string; tooLarge: boolean; maxBytes: number; binary: boolean;
};

type Entry = { name: string; dir: boolean; size: number; modified: number };
type Listing = { root: string; path: string; entries: Entry[]; truncated: boolean };
type FileSnapshot = { artifact: Artifact; localSource: string; pdfBytes: Uint8Array<ArrayBuffer> | null };
type SearchResult = { path: string; name: string; size: number };
type ChangeRepo = { root: string; name: string; branch: string };
type ChangedFile = { repo: string; path: string; status: string };
type ChangeDetail = { repo: string; path: string; before: string; after: string; binary?: boolean; tooLarge?: boolean };
type PageBlockType = 'text' | 'heading' | 'heading2' | 'heading3' | 'bullet' | 'numbered' | 'check' | 'code' | 'quote' | 'divider' | 'instructions' | 'image' | 'file' | 'page';
type PageBlock = { id: string; type: PageBlockType; text: string; checked?: boolean; attachmentId?: string; childPageId?: string };
type NotePage = { id: string; parentId?: string; title: string; blocks: PageBlock[]; content?: PartialBlock[] };

function legacyPageContent(blocks: PageBlock[]): PartialBlock[] {
  const converted = blocks.map((block): PartialBlock => {
    const attachment = block.attachmentId ? apiPath(`/api/sdk-chat-attachments/${encodeURIComponent(block.attachmentId)}`) : '';
    if (block.type === 'image' && attachment) return { type:'image', props:{url:attachment, caption:block.text} };
    if (block.type === 'file' && attachment) return { type:'file', props:{url:attachment, caption:block.text, name:block.text} };
    if (block.type === 'divider') return { type:'divider' };
    if (block.type === 'page' && block.childPageId) return { type:'paragraph', content:[{type:'link', href:`#muxterm-page-${block.childPageId}`, content:`↗ ${block.text || 'Untitled'}`}] };
    if (block.type.startsWith('heading')) return { type:'heading', props:{level:block.type === 'heading' ? 1 : block.type === 'heading2' ? 2 : 3}, content:block.text };
    if (block.type === 'bullet') return { type:'bulletListItem', content:block.text };
    if (block.type === 'numbered') return { type:'numberedListItem', content:block.text };
    if (block.type === 'check') return { type:'checkListItem', props:{checked:!!block.checked}, content:block.text };
    if (block.type === 'code') return { type:'codeBlock', content:block.text };
    if (block.type === 'quote') return { type:'quote', content:block.text };
    return { type:'paragraph', content:block.type === 'instructions' ? `Assistant instructions: ${block.text}` : block.text };
  });
  return converted.length ? converted : [{type:'paragraph'}];
}
type UtilityTabId = 'new' | 'files' | 'status' | 'changes' | 'pages';
type UtilityTab = { id: string; kind: UtilityTabId; pageId?: string; filePath?: string };
const TABS_KEY = 'muxterm.sdk.utility.tabs.';
const TAB_GLYPHS: Record<UtilityTabId, IconNode> = { new:Plus, changes:GitCompare, files:Folder, status:Network, pages:NotebookPen };

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileGlyph(name: string, directory = false, open = false): IconNode {
  if (directory) return open ? FolderOpen : Folder;
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/i.test(name)) return FileImage;
  if (/\.(json|jsonc|toml|ya?ml)$/i.test(name)) return FileJson;
  if (/\.(tsx?|jsx?|go|py|rs|sh|css|html?)$/i.test(name)) return Code2;
  if (/\.(md|txt|csv|tsv|log)$/i.test(name)) return FileText;
  return File;
}

function fileLanguage(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() || '';
  return ({ ts:'TypeScript', tsx:'TypeScript React', js:'JavaScript', jsx:'JavaScript React', go:'Go', py:'Python', rs:'Rust', md:'Markdown', json:'JSON', css:'CSS', html:'HTML', svg:'SVG', sh:'Shell', yaml:'YAML', yml:'YAML', toml:'TOML', csv:'CSV', tsv:'TSV', pdf:'PDF', png:'Image', jpg:'Image', jpeg:'Image', webp:'Image' } as Record<string,string>)[extension] || 'Plain Text';
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

@customElement('mux-sdk-utility')
export class MuxSDKUtility extends LitElement {
  @property() sessionId = '';
  @property() projectPath = '';
  @property({ type: Boolean, reflect: true, attribute: 'terminal-mode' }) terminalMode = false;
  @property({ type: Boolean }) focused = false;
  @property({ attribute: false }) touched: string[] = [];
  private tabs: UtilityTab[] = [{ id: crypto.randomUUID(), kind: 'files' }];
  private activeTabId = this.tabs[0].id;
  private get activeTab(): UtilityTabId { return this.tabs.find(tab => tab.id === this.activeTabId)?.kind || 'new'; }
  private get currentTab(): UtilityTab { return this.tabs.find(tab => tab.id === this.activeTabId) || this.tabs[0]; }
  private railWidths = { files: 240, changes: 240, pages: 240 };
  private resizingRail: keyof typeof this.railWidths | null = null;
  private listing?: Listing;
  private directoryCache = new Map<string, Listing>();
  private expandedDirs = new Set<string>(['.']);
  private fileSnapshots = new Map<string, FileSnapshot>();
  private fileModes = new Map<string, 'preview' | 'source'>();
  private quickOpen = false;
  private quickQuery = '';
  private quickResults: SearchResult[] = [];
  private quickLoading = false;
  private quickTruncated = false;
  private quickError = '';
  private quickIndex = 0;
  private quickTimer?: number;
  private quickAbort?: AbortController;
  private directoryRequest = 0;
  private selected = '';
  private artifact?: Artifact;
  private fileQuery = '';
  private fileSort: 'name' | 'recent' | 'size' = 'name';
  private filesRailOpen = true;
  private fileMode: 'preview' | 'source' = 'preview';
  private fileMenuOpen = false;
  private fileActionNotice = '';
  private fileActionTimer?: number;
  private interactivePreview = false;
  private localSource = '';
  private pdfBytes: Uint8Array<ArrayBuffer> | null = null;
  private fileAbort?: AbortController;
  private changes?: { repos: ChangeRepo[]; changes: ChangedFile[]; truncated: boolean };
  private changesError = '';
  private selectedChange?: ChangedFile;
  private changeDetail?: ChangeDetail;
  private changeAbort?: AbortController;
  private pages?: NotePage[];
  private pagesVersion = 0;
  private pagesRenderEpoch = 0;
  private pagesPollTimer?: number;
  private pagesError = '';
  private pageId = '';
  private pageSaveTimer?: number;
  private pageSaveQueue: Promise<void> = Promise.resolve();
  private pageSaving = false;
  private pagesConflict = false;
  private pagesRailOpen = true;
  private pendingPageDeletion?: { id:string; message:string };
  private error = '';
  private fileError = '';
  private pendingFile = 0;
  private pathKey() { return `muxterm.sdk.utility.path.${this.sessionId}`; }
  private fileKey() { return `muxterm.sdk.utility.file.${this.sessionId}`; }
  private pageKey() { return `muxterm.sdk.utility.page.${this.sessionId}`; }

  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    if (this.terminalMode) {
      this.tabs = [{ id:crypto.randomUUID(), kind:'files' }];
      this.activeTabId = this.tabs[0].id;
      void this.restoreExplorer('.');
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(TABS_KEY + this.sessionId) || 'null') as { tabs?: { id: string; kind: string; pageId?: string; filePath?: string }[]; activeTabId?: string } | null;
      const valid = new Set<string>(['new','files','status','changes','terminal','pages','web']);
      if (saved?.tabs?.length && saved.tabs.length <= 30 && saved.tabs.every(tab => typeof tab.id === 'string' && valid.has(tab.kind))) {
        this.tabs = saved.tabs.map(tab => ({ id:tab.id, kind:(tab.kind === 'web' || tab.kind === 'terminal' ? 'new' : tab.kind) as UtilityTabId, pageId:tab.pageId, filePath:tab.filePath }));
        this.activeTabId = this.tabs.some(tab => tab.id === saved.activeTabId) ? saved.activeTabId! : this.tabs[0].id;
        if (saved.tabs.some(tab => tab.kind === 'web' || tab.kind === 'terminal')) this.saveTabs();
      }
      for (const key of ['files','changes','pages'] as const) {
        const width = Number(localStorage.getItem(`muxterm.sdk.utility.rail.${key}.${this.sessionId}`));
        if (Number.isFinite(width) && width >= 160 && width <= 900) this.railWidths[key] = width;
      }
    } catch { /* storage unavailable */ }
    let folder = '.';
    try { folder = localStorage.getItem(this.pathKey()) || '.'; } catch { /* private browsing */ }
    try { this.pageId = localStorage.getItem(this.pageKey()) || ''; } catch { /* private browsing */ }
    void this.restoreExplorer(folder);
    if (this.currentTab.kind === 'files' && this.currentTab.filePath) void this.loadFile(this.currentTab.filePath);
    if (this.activeTab === 'changes') void this.loadChanges();
    if (this.activeTab === 'pages') void this.loadPages();
    this.pagesPollTimer = window.setInterval(() => { if (this.activeTab === 'pages' && this.pages && !this.pageSaving && !this.pagesConflict) void this.refreshPages(); }, 2500);
  }
  override disconnectedCallback() {
    this.fileAbort?.abort();
    this.changeAbort?.abort();
    this.quickAbort?.abort();
    if (this.quickTimer) window.clearTimeout(this.quickTimer);
    if (this.pageSaveTimer) { window.clearTimeout(this.pageSaveTimer); void this.savePages(); }
    if (this.pagesPollTimer) window.clearInterval(this.pagesPollTimer);
    if (this.fileActionTimer) window.clearTimeout(this.fileActionTimer);
    super.disconnectedCallback();
  }
  override render() {
    if (this.terminalMode) return html`<style>${this.surfaceCSS}</style><div class="terminal-files-header"><strong>Files</strong><button class="icon-button" aria-label="Close file explorer" @click=${() => this.dispatchEvent(new CustomEvent('close',{bubbles:true,composed:true}))}>${icon(X,{size:16})}</button></div><div class="utility-body" aria-label="Files">${this.filesView()}</div>`;
    const tab = this.currentTab;
    return html`<style>${this.surfaceCSS}</style><mux-ui-tab-strip accessible-label="Chat tools" .tabs=${this.tabs.map((item):TabStripItem => ({id:item.id,label:this.tabTitle(item),title:item.filePath || this.tabTitle(item),icon:icon(item.kind === 'files' && item.filePath ? fileGlyph(item.filePath) : TAB_GLYPHS[item.kind],{size:14})}))} .activeId=${tab.id} @tab-select=${(event:CustomEvent<{id:string}>) => this.selectTab(event.detail.id)} @tab-close=${(event:CustomEvent<{id:string}>) => this.closeTab(event.detail.id)} @tab-add=${() => this.addTab()}></mux-ui-tab-strip><div class="utility-body" role="tabpanel" aria-label=${this.tabTitle(tab)}>${tab.kind === 'new' ? this.newTabView() : tab.kind === 'files' ? this.filesView() : tab.kind === 'status' ? html`<mux-operator-status .sessionId=${this.sessionId}></mux-operator-status>` : tab.kind === 'changes' ? this.changesView() : this.pagesView()}</div>`;
  }
  private tabTitle(tab: UtilityTab): string {
    if (tab.kind === 'new') return 'New tab';
    if (tab.kind === 'files') return tab.filePath?.split('/').pop() || 'Files';
    if (tab.kind === 'pages') return this.pages?.find(page => page.id === tab.pageId)?.title || 'Page';
    return ({ status:'Status', changes:'Changes' } as Record<string,string>)[tab.kind] || 'Tab';
  }
  private saveTabs() { if (this.terminalMode) return; try { localStorage.setItem(TABS_KEY + this.sessionId, JSON.stringify({ tabs:this.tabs, activeTabId:this.activeTabId })); } catch { /* private browsing */ } }
  private migrateLegacyFile(): boolean {
    if (this.terminalMode) return false;
    if (!this.sessionId) return false;
    let path = '';
    try { path = localStorage.getItem(this.fileKey()) || ''; } catch { return false; }
    if (!path) return false;
    if (path.startsWith('/')) {
      const root = this.projectPath.replace(/\/+$/, '');
      if (!root || !path.startsWith(`${root}/`)) return false;
      path = path.slice(root.length + 1);
    }
    const inserted = !this.tabs.some(tab => tab.kind === 'files' && tab.filePath === path);
    if (inserted) {
      const emptyFileTab = this.tabs.find(tab => tab.kind === 'files' && !tab.filePath);
      if (emptyFileTab) emptyFileTab.filePath = path;
      else this.tabs = [...this.tabs, { id:crypto.randomUUID(), kind:'files', filePath:path }];
      this.saveTabs();
    }
    try { localStorage.removeItem(this.fileKey()); } catch { /* private browsing */ }
    return inserted;
  }
  private addTab(kind: UtilityTabId = 'new'): UtilityTab {
    const tab: UtilityTab = { id:crypto.randomUUID(), kind };
    this.tabs = [...this.tabs,tab]; this.activeTabId = tab.id; this.saveTabs();
    void this.activateTab(tab); this.paintAll(); return tab;
  }
  private selectTab(id: string) {
    const tab = this.tabs.find(item => item.id === id); if (!tab) return;
    this.activeTabId = id; this.saveTabs(); void this.activateTab(tab); this.paintAll();
  }
  private closeTab(id: string) {
    const index = this.tabs.findIndex(tab => tab.id === id); if (index < 0) return;
    const wasActive = this.activeTabId === id;
    this.tabs = this.tabs.filter(tab => tab.id !== id);
    if (!this.tabs.length) this.tabs = [{ id:crypto.randomUUID(), kind:'new' }];
    if (wasActive) this.activeTabId = this.tabs[Math.min(index,this.tabs.length-1)].id;
    this.saveTabs(); if (wasActive) void this.activateTab(this.currentTab); this.paintAll();
  }
  private activateTab(tab: UtilityTab, refreshFile = false) {
    const fileLoad = tab.kind === 'files' && tab.filePath ? this.loadFile(tab.filePath, refreshFile) : undefined;
    if (!fileLoad) this.resetFileView();
    if (tab.kind === 'pages' && tab.pageId) this.pageId = tab.pageId;
    if (tab.kind === 'changes' && !this.changes) void this.loadChanges();
    if (tab.kind === 'pages' && !this.pages) void this.loadPages();
    return fileLoad;
  }
  private endpoint(kind: string, path?: string) {
    const base = this.terminalMode ? `/api/terminal/${kind}` : `/api/sdk-chats/${encodeURIComponent(this.sessionId)}/utility/${kind}`;
    return apiPath(base) + (path ? `?${new URLSearchParams({path})}` : '');
  }
  showPanel(id: UtilityTabId): void {
    const existing = this.tabs.find(tab => tab.kind === id);
    if (existing) this.selectTab(existing.id);
    else this.addTab(id);
  }
  private chooseTool(kind: 'files' | 'status' | 'changes' | 'pages') {
    const current = this.currentTab;
    current.kind = kind;
    if (kind === 'pages') {
      if (!this.pages) { void this.loadPages().then(() => { const page = this.newPage(); current.pageId = page.id; this.saveTabs(); }); }
      else { const page = this.newPage(); current.pageId = page.id; }
    } else this.activateTab(current);
    this.saveTabs(); this.paintAll();
  }
  private newTabView(): TemplateResult {
    return html`<section class="new-tab-surface"><div class="new-tab-home"><h2>Tools</h2><div class="new-tab-tools"><button @click=${() => this.chooseTool('files')}>${icon(Folder,{size:16})}<span>Files</span></button><button @click=${() => this.chooseTool('status')}>${icon(Network,{size:16})}<span>Status</span></button><button @click=${() => this.chooseTool('changes')}>${icon(GitCompare,{size:16})}<span>Changes</span></button><button @click=${() => this.chooseTool('pages')}>${icon(NotebookPen,{size:16})}<span>New page</span></button></div></div></section>`;
  }
  private async loadChanges() {
    this.changesError = '';
    try {
      const response = await fetch(this.endpoint('changes'));
      if (!response.ok) throw new Error(`Changes unavailable (${response.status})`);
      this.changes = await response.json() as { repos: ChangeRepo[]; changes: ChangedFile[]; truncated: boolean };
      if (this.selectedChange && !this.changes.changes.some(row => row.repo === this.selectedChange?.repo && row.path === this.selectedChange?.path)) {
        this.selectedChange = undefined; this.changeDetail = undefined;
      }
    } catch (error) { this.changesError = String(error); }
    this.paintAll();
  }
  private async openChange(change: ChangedFile) {
    this.changeAbort?.abort();
    const controller = new AbortController();
    this.changeAbort = controller;
    this.selectedChange = change; this.changeDetail = undefined;
    this.paintAll();
    try {
      const query = new URLSearchParams({ repo: change.repo, path: change.path });
      const response = await fetch(`${this.endpoint('change')}?${query}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Diff unavailable (${response.status})`);
      const detail = await response.json() as ChangeDetail;
      if (!controller.signal.aborted) this.changeDetail = detail;
    } catch { if (!controller.signal.aborted) this.changeDetail = { repo: change.repo, path: change.path, before: '', after: '', binary: true }; }
    this.paintAll();
  }
  async showFile(path: string): Promise<void> {
    await this.revealFile(path);
  }
  private previewURL(path: string, maxBytes: number): string {
    return `${this.endpoint('raw', path)}&max_bytes=${maxBytes}`;
  }
  private async restoreExplorer(folder: string) {
    await this.loadDirectory('.');
    let path = '';
    for (const part of folder.split('/').filter(part => part !== '.')) {
      path = path ? `${path}/${part}` : part;
      await this.loadDirectory(path);
    }
  }
  private async revealFile(path: string) {
    let folder = '';
    for (const part of path.split('/').slice(0, -1)) {
      folder = folder ? `${folder}/${part}` : part;
      await this.loadDirectory(folder);
    }
    await this.openFile(path);
    this.hideQuickOpen();
  }
  private async refreshTree() {
    const expanded = [...this.expandedDirs].filter(path => path !== '.').sort((a, b) => a.split('/').length - b.split('/').length);
    const current = this.listing?.path || '.';
    this.directoryCache.clear();
    await this.loadDirectory('.');
    for (const path of expanded) await this.loadDirectory(path);
    if (current !== '.') await this.loadDirectory(current);
    if (this.selected) await this.openFile(this.selected, true);
  }
  private async loadDirectory(path: string, refresh = false) {
    if (this.terminalMode && this.selected) this.backToTerminalFiles();
    const request = ++this.directoryRequest;
    this.error = '';
    try {
      let listing = !refresh ? this.directoryCache.get(path) : undefined;
      if (!listing) {
        const response = await fetch(this.endpoint('files', path));
        if (!response.ok) throw new Error(`Folder unavailable (${response.status})`);
        listing = await response.json() as Listing;
        this.directoryCache.set(listing.path, listing);
      }
      if (request !== this.directoryRequest) return;
      this.listing = listing;
      if (this.terminalMode) this.projectPath = listing.root;
      this.expandAncestors(listing.path);
      this.expandedDirs.add(listing.path);
      if (!this.terminalMode) try { localStorage.setItem(this.pathKey(), listing.path); } catch { /* private browsing */ }
    } catch (error) { if (request === this.directoryRequest) this.error = String(error); }
    this.paintAll();
  }
  private expandAncestors(path: string) {
    this.expandedDirs.add('.');
    let parent = '';
    for (const part of path.split('/').filter(part => part !== '.')) {
      parent = parent ? `${parent}/${part}` : part;
      this.expandedDirs.add(parent);
    }
  }
  private async toggleDirectory(path: string) {
    if (this.expandedDirs.has(path)) {
      this.expandedDirs.delete(path);
      this.paintAll();
      return;
    }
    this.expandedDirs.add(path);
    await this.loadDirectory(path);
  }
  private async openFile(path: string, refresh = false) {
    if (this.terminalMode) {
      this.tabs[0].filePath = path;
      await this.loadFile(path, refresh);
      return;
    }
    const current = this.currentTab;
    let tab = this.tabs.find(item => item.kind === 'files' && item.filePath === path);
    if (!tab) tab = current.kind === 'files' && !current.filePath ? current : this.tabs.find(item => item.kind === 'files' && !item.filePath);
    if (tab) tab.filePath = path;
    else { tab = { id:crypto.randomUUID(), kind:'files', filePath:path }; this.tabs = [...this.tabs,tab]; }
    this.activeTabId = tab.id;
    this.saveTabs();
    await this.activateTab(tab, refresh);
  }
  private async loadFile(path: string, refresh = false) {
    this.fileAbort?.abort();
    this.fileMenuOpen = false;
    const controller = new AbortController();
    this.fileAbort = controller;
    this.selected = path; this.fileError = '';
    this.fileMode = this.fileModes.get(path) || 'preview'; this.interactivePreview = false;
    const snapshot = !refresh ? this.fileSnapshots.get(path) : undefined;
    this.artifact = snapshot?.artifact;
    this.localSource = snapshot?.localSource || '';
    this.pdfBytes = snapshot?.pdfBytes || null;
    this.expandAncestors(path.split('/').slice(0, -1).join('/') || '.');
    const current = ++this.pendingFile;
    this.paintAll();
    try {
      const response = await fetch(this.endpoint('file', path), { signal: controller.signal });
      if (!response.ok) throw new Error(`File unavailable (${response.status})`);
      const result = await response.json() as Artifact;
      if (current !== this.pendingFile || controller.signal.aborted) return;
      this.artifact = result;
      this.fileSnapshots.set(path, { artifact: result, localSource: '', pdfBytes: null });
      this.paintAll();
      const ext = result.name.toLowerCase().split('.').pop();
      if (!result.tooLarge && result.size <= 2 * 1024 * 1024 && (ext === 'html' || ext === 'htm' || ext === 'svg')) {
        const raw = await fetch(this.previewURL(path, 2 * 1024 * 1024), { signal: controller.signal });
        if (raw.ok) {
          const bytes = await raw.arrayBuffer();
          if (current === this.pendingFile && !controller.signal.aborted) {
            try { this.localSource = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
            catch { this.fileError = 'This file is not UTF-8 text.'; }
            this.fileSnapshots.set(path, { artifact: result, localSource: this.localSource, pdfBytes: null });
          }
        }
      } else if (!result.tooLarge && result.size <= 8 * 1024 * 1024 && ext === 'pdf') {
        const raw = await fetch(this.previewURL(path, 8 * 1024 * 1024), { signal: controller.signal });
        if (raw.ok) {
          const bytes = new Uint8Array(await raw.arrayBuffer());
          if (current === this.pendingFile && !controller.signal.aborted) {
            this.pdfBytes = bytes;
            this.fileSnapshots.set(path, { artifact: result, localSource: '', pdfBytes: bytes });
          }
        }
      }
    } catch (error) { if (current === this.pendingFile && !controller.signal.aborted) this.fileError = String(error); }
    this.paintAll();
  }
  private resetFileView() {
    this.fileAbort?.abort(); this.pendingFile++;
    this.selected = ''; this.artifact = undefined; this.localSource = ''; this.pdfBytes = null; this.fileError = '';
  }
  private backToTerminalFiles() {
    this.tabs[0].filePath = undefined;
    this.resetFileView();
    this.paintAll();
  }
  private showQuickOpen() {
    this.quickAbort?.abort();
    if (this.quickTimer) window.clearTimeout(this.quickTimer);
    if (this.currentTab.kind !== 'files') this.showPanel('files');
    this.fileMenuOpen = false;
    this.quickOpen = true;
    this.quickQuery = '';
    this.quickResults = [];
    this.quickIndex = 0;
    this.quickLoading = false;
    this.quickTruncated = false;
    this.quickError = '';
    this.paintAll();
    void this.updateComplete.then(() => requestAnimationFrame(() => this.querySelector<HTMLInputElement>('.quick-open input')?.focus()));
  }
  private hideQuickOpen() {
    this.quickAbort?.abort();
    if (this.quickTimer) window.clearTimeout(this.quickTimer);
    this.quickOpen = false;
    this.quickLoading = false;
    this.paintAll();
  }
  private searchQuickOpen(query: string) {
    this.quickQuery = query;
    this.quickIndex = 0;
    this.quickResults = [];
    this.quickError = '';
    this.quickTruncated = false;
    this.quickAbort?.abort();
    if (this.quickTimer) window.clearTimeout(this.quickTimer);
    this.quickLoading = query.trim().length >= 2;
    this.paintAll();
    if (!this.quickLoading) return;
    this.quickTimer = window.setTimeout(async () => {
      const controller = new AbortController();
      this.quickAbort = controller;
      try {
        const response = await fetch(`${this.endpoint('search')}?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Search unavailable (${response.status})`);
        const result = await response.json() as { results: SearchResult[]; truncated: boolean };
        if (!controller.signal.aborted && this.quickQuery === query) {
          this.quickResults = result.results;
          this.quickTruncated = result.truncated;
        }
      } catch { if (!controller.signal.aborted) this.quickError = 'File search is unavailable. Try again.'; }
      if (!controller.signal.aborted) { this.quickLoading = false; this.paintAll(); }
    }, 180);
  }
  private paintAll() { this.requestUpdate(); }
  private startRailResize(event: PointerEvent, key: keyof typeof this.railWidths) {
    if (event.button !== 0) return;
    event.preventDefault();
    this.resizingRail = key;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  private moveRailResize(event: PointerEvent) {
    if (!this.resizingRail) return;
    const panel = (event.currentTarget as HTMLElement).closest<HTMLElement>('.split-panel');
    if (!panel) return;
    const box = panel.getBoundingClientRect();
    const distance = this.resizingRail === 'files' ? box.right - event.clientX : event.clientX - box.left;
    const width = Math.round(Math.max(160, Math.min(box.width - 230, distance)));
    this.railWidths[this.resizingRail] = width;
    panel.style.setProperty('--rail-width', `${width}px`);
    (event.currentTarget as HTMLElement).setAttribute('aria-valuenow', String(width));
  }
  private endRailResize(event: PointerEvent) {
    const key = this.resizingRail;
    if (!key) return;
    this.resizingRail = null;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    try { localStorage.setItem(`muxterm.sdk.utility.rail.${key}.${this.sessionId}`, String(this.railWidths[key])); } catch { /* private browsing */ }
  }
  private keyRailResize(event: KeyboardEvent, key: keyof typeof this.railWidths) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 20 : -20;
    this.railWidths[key] = Math.max(160, Math.min(900, this.railWidths[key] + (key === 'files' ? -direction : direction)));
    (event.currentTarget as HTMLElement).closest<HTMLElement>('.split-panel')?.style.setProperty('--rail-width', `${this.railWidths[key]}px`);
    (event.currentTarget as HTMLElement).setAttribute('aria-valuenow', String(this.railWidths[key]));
    try { localStorage.setItem(`muxterm.sdk.utility.rail.${key}.${this.sessionId}`, String(this.railWidths[key])); } catch { /* private browsing */ }
  }
  private askAboutFile() {
    if (!this.selected) return;
    this.dispatchEvent(new CustomEvent('sdk-file-reference', { bubbles: true, composed: true, detail: {
      path: this.selected, modified: this.artifact?.modified,
      selected: this.querySelector('mux-monaco-source')?.getSelectedText()
        || window.getSelection()?.toString().trim().slice(0, 600) || '',
    } }));
  }
  private sourceView(source: string): TemplateResult {
    return html`<mux-monaco-source .scope=${this.sessionId} .path=${this.selected} .source=${source} aria-label=${`Source of ${this.artifact?.name || this.selected}`}></mux-monaco-source>`;
  }
  private fileBody(): TemplateResult {
    const file = this.artifact;
    if (!file) return html`<div class="file-empty">${this.fileError || (this.selected ? 'Opening file…' : 'Choose a file to preview it here.')}</div>`;
    if (file.tooLarge) return html`<div class="file-empty">This file is too large to preview. Download it to inspect the full contents.</div>`;
    const extension = file.name.toLowerCase().split('.').pop();
    if (this.fileMode === 'source') return this.sourceView(extension === 'html' || extension === 'htm' || extension === 'svg' ? this.localSource : file.text);
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
    if (file.kind === 'markdown') return html`<article class="document-view" aria-label=${`Preview of ${file.name}`}>${renderSegments(parseMarkdown(file.text))}</article>`;
    return this.sourceView(file.text);
  }
  private treeRows(folder: string, depth = 0): TemplateResult[] {
    const listing = this.directoryCache.get(folder);
    if (!listing) return [];
    const query = this.fileQuery.toLowerCase().trim();
    const entries = [...listing.entries].sort((a, b) => Number(b.dir) - Number(a.dir) || (this.fileSort === 'recent' ? b.modified - a.modified : this.fileSort === 'size' ? b.size - a.size : a.name.localeCompare(b.name)));
    const rows: TemplateResult[] = [];
    for (const entry of entries) {
      const path = folder === '.' ? entry.name : `${folder}/${entry.name}`;
      const expanded = entry.dir && this.expandedDirs.has(path);
      if (query && !entry.name.toLowerCase().includes(query) && !(entry.dir && this.treeContainsMatch(path, query))) continue;
      rows.push(html`<mux-ui-rail-row tree ?directory=${entry.dir} ?selected=${this.selected === path} .expanded=${expanded} .level=${depth + 1} .depth=${depth} label=${entry.name} detail=${entry.dir ? '' : readableSize(entry.size)} tooltip=${path} data-path=${path} @click=${() => void (entry.dir ? this.toggleDirectory(path) : this.openFile(path))}>
        ${entry.dir ? html`<span slot="chevron">${icon(expanded ? ChevronDown : ChevronRight, { size: 13 })}</span>` : nothing}
        <span slot="icon">${icon(fileGlyph(entry.name, entry.dir, expanded), { size: 16 })}</span>
      </mux-ui-rail-row>`);
      if (expanded) rows.push(...this.treeRows(path, depth + 1));
    }
    return rows;
  }
  private treeContainsMatch(path: string, query: string): boolean {
    const listing = this.directoryCache.get(path);
    return !!listing?.entries.some(entry => entry.name.toLowerCase().includes(query) || (entry.dir && this.treeContainsMatch(`${path}/${entry.name}`, query)));
  }
  private onTreeKey(event: KeyboardEvent) {
    if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
    const target = (event.target as HTMLElement).closest<MuxUIRailRow>('mux-ui-rail-row[tree]');
    if (!target) return;
    const items = [...this.querySelectorAll<MuxUIRailRow>('.file-list mux-ui-rail-row[tree]')];
    const index = items.indexOf(target);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowDown') items[Math.min(items.length - 1, index + 1)]?.focus();
    else if (event.key === 'ArrowUp') items[Math.max(0, index - 1)]?.focus();
    else if (event.key === 'ArrowRight' && target.directory && !target.expanded) void this.toggleDirectory(target.dataset.path || '');
    else if (event.key === 'ArrowLeft') {
      if (target.directory && target.expanded) void this.toggleDirectory(target.dataset.path || '');
      else {
        const parent = target.dataset.path?.split('/').slice(0, -1).join('/');
        if (parent) items.find(item => item.dataset.path === parent)?.focus();
        else this.querySelector<HTMLElement>('.project-heading')?.focus();
      }
    }
  }
  private setFileMode(mode: 'preview' | 'source') {
    this.fileMode = mode;
    this.fileModes.set(this.selected, mode);
    this.paintAll();
  }
  private toggleFileMode() {
    this.setFileMode(this.fileMode === 'preview' ? 'source' : 'preview');
  }
  private filePathOnHost(): string {
    if (!this.projectPath.startsWith('/') || !this.selected || this.selected.startsWith('/') || this.selected.split('/').includes('..')) return '';
    return `${this.projectPath.replace(/\/+$/, '')}/${this.selected}`;
  }
  private vsCodeURL(): string {
    if (!['localhost','127.0.0.1','[::1]'].includes(window.location.hostname)) return '';
    const path = this.filePathOnHost();
    return path ? `vscode://file${path.split('/').map(encodeURIComponent).join('/')}` : '';
  }
  private showFileActionNotice(message: string) {
    this.fileActionNotice = message;
    if (this.fileActionTimer) window.clearTimeout(this.fileActionTimer);
    this.fileActionTimer = window.setTimeout(() => { this.fileActionNotice = ''; this.paintAll(); }, 2400);
    this.paintAll();
  }
  private async copyFilePath() {
    const path = this.filePathOnHost();
    if (!path) return;
    try { await navigator.clipboard.writeText(path); this.showFileActionNotice('File path copied'); }
    catch { this.showFileActionNotice('Could not copy file path'); }
  }
  private openFileInBrowser() {
    const file = this.artifact;
    if (!file) return;
    if (file.kind === 'image') { window.open(this.endpoint('raw', this.selected), '_blank', 'noopener'); return; }
    if (file.kind === 'download' && !file.name.toLowerCase().endsWith('.pdf')) return;
    const bytes = this.pdfBytes;
    const text = file.name.toLowerCase().endsWith('.pdf') ? null : /\.(html?|svg)$/i.test(file.name) ? this.localSource || file.text : file.text;
    if (!bytes && (file.tooLarge || file.binary || text === null)) return;
    // Keep source text inert in a new tab; rich HTML/SVG rendering stays in the sandboxed preview.
    const blob = bytes ? new Blob([bytes], { type:'application/pdf' }) : new Blob([text || ''], { type:'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  private fileHeader(projectName: string, segments: string[], file: Artifact | undefined, hasAlternateView: boolean): TemplateResult {
    const canOpenInBrowser = !!file && (file.kind === 'image' || !!this.pdfBytes || (!file.tooLarge && !file.binary && (file.kind === 'markdown' || file.kind === 'text')));
    const vsCodeURL = this.vsCodeURL();
    return html`<div class="viewer-header">
      ${this.terminalMode ? html`<button class="icon-button" aria-label="Back to files" title="Back to files" @click=${() => this.backToTerminalFiles()}>${icon(ArrowLeft,{size:15})}</button>` : nothing}
      <nav class="viewer-path" aria-label="Open file path">${segments.length ? html`<button @click=${() => void this.loadDirectory('.')}>${projectName}</button>${segments.map((part,index) => html`<span>›</span>${index < segments.length-1 ? html`<button @click=${() => void this.loadDirectory(segments.slice(0,index+1).join('/'))}>${part}</button>` : html`<strong>${part}</strong>`}`)}` : html`<span>Open a file to preview it</span>`}</nav>
      <div class="file-header-actions">
        ${file && !this.terminalMode ? html`<button class="icon-button" aria-label="Ask about file" title="Ask about file" @click=${() => this.askAboutFile()}>${icon(MessageCircleQuestionMark,{size:15})}</button>` : nothing}
        ${hasAlternateView ? html`<button class="file-action-button" aria-label=${this.fileMode === 'preview' ? 'View source' : 'View preview'} @click=${() => this.toggleFileMode()}>${icon(Code2,{size:14})}<span>${this.fileMode === 'preview' ? 'View source' : 'View preview'}</span></button>` : nothing}
        ${!this.terminalMode ? html`<button class="icon-button file-browser-toggle ${this.filesRailOpen ? 'active' : ''}" aria-label=${this.filesRailOpen ? 'Hide file browser' : 'Show file browser'} title=${this.filesRailOpen ? 'Hide file browser' : 'Show file browser'} aria-pressed=${String(this.filesRailOpen)} @click=${() => { this.filesRailOpen = !this.filesRailOpen; this.fileMenuOpen = false; this.paintAll(); }}>${icon(Folder,{size:15})}</button>` : nothing}
        ${file ? html`<div class="file-open-wrap">
          <button class="file-open-button" aria-label="Open file options" title="Open file options" aria-haspopup="menu" aria-expanded=${String(this.fileMenuOpen)} @click=${() => { this.fileMenuOpen = !this.fileMenuOpen; this.paintAll(); }}>${icon(ExternalLink,{size:14})}<span>Open</span>${icon(ChevronDown,{size:13})}</button>
          ${this.fileMenuOpen ? html`<mux-ui-menu class="file-open-menu" label="Open file" @menu-dismiss=${(event:CustomEvent<{restoreFocus:boolean}>) => { this.fileMenuOpen = false; this.paintAll(); if (event.detail.restoreFocus) queueMicrotask(() => this.querySelector<HTMLButtonElement>('.file-open-button')?.focus()); }}>
            ${canOpenInBrowser ? html`<button role="menuitem" @click=${() => { this.fileMenuOpen = false; this.openFileInBrowser(); }}>${icon(ExternalLink,{size:14})}Open in browser tab</button>` : nothing}
            ${vsCodeURL ? html`<a role="menuitem" href=${vsCodeURL} @click=${() => { this.fileMenuOpen = false; }}>${icon(Code2,{size:14})}Open with VS Code</a>` : nothing}
            <div role="separator"></div>
            <button role="menuitem" @click=${() => { this.fileMenuOpen = false; void this.copyFilePath(); }}>${icon(Copy,{size:14})}Copy file path</button>
            <a role="menuitem" href=${this.endpoint('raw', this.selected)} download=${file.name} @click=${() => { this.fileMenuOpen = false; }}>${icon(Download,{size:14})}Download file</a>
            <div role="separator"></div>
            <button role="menuitem" @click=${() => { this.fileMenuOpen = false; void this.openFile(this.selected, true); }}>${icon(RefreshCw,{size:14})}Refresh file</button>
            ${!this.terminalMode ? html`<button role="menuitem" @click=${() => { this.fileMenuOpen = false; this.dispatchEvent(new CustomEvent('sdk-file-focus',{bubbles:true,composed:true})); }}>${icon(this.focused ? Minimize2 : Maximize2,{size:14})}${this.focused ? 'Show chat beside files' : 'Focus file viewer'}</button>` : nothing}
            <button role="menuitem" @click=${() => { this.fileMenuOpen = false; if (this.terminalMode) this.backToTerminalFiles(); else this.closeTab(this.currentTab.id); }}>${icon(X,{size:14})}Close file</button>
          </mux-ui-menu>` : nothing}
        </div>` : nothing}
      </div>
    </div>`;
  }
  private filesView() {
    const file = this.artifact;
    const hasAlternateView = !!file && !file.binary && !file.tooLarge && (file.kind === 'markdown' || /\.(csv|tsv|html?|svg)$/i.test(file.name));
    const projectName = (this.projectPath || this.listing?.root || 'Project').split('/').filter(Boolean).pop() || 'Project';
    const segments = this.selected.split('/').filter(Boolean);
    const tree = this.treeRows('.');
    return html`<section class="files-panel split-panel ${this.filesRailOpen ? '' : 'rail-closed'} ${this.terminalMode && this.selected ? 'terminal-preview' : ''}" style=${`--rail-width:${this.railWidths.files}px`} @click=${(event: MouseEvent) => { if (this.fileMenuOpen && !(event.target as HTMLElement).closest(".file-open-wrap")) { this.fileMenuOpen = false; this.paintAll(); } }} @keydown=${(event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); this.showQuickOpen(); }
      if (event.key === 'Escape' && !this.quickOpen && this.fileMenuOpen) { this.fileMenuOpen = false; this.paintAll(); queueMicrotask(() => this.querySelector<HTMLButtonElement>('.file-open-button')?.focus()); }
    }}>
      <div class="viewer">
        ${this.fileHeader(projectName, segments, file, hasAlternateView)}
        <div class="viewer-body">${this.selected ? this.fileBody() : html`<div class="welcome-file">${icon(FolderOpen,{size:35})}<h2>Explore this project</h2><p>Choose a file from the explorer or search by name across the project.</p><button @click=${() => this.showQuickOpen()}>${icon(Search,{size:15})} Quick Open <kbd>Ctrl P</kbd></button></div>`}</div>
        ${file ? html`<div class="file-status"><span>${fileLanguage(file.name)}</span>${!file.binary && !file.tooLarge && file.text ? html`<span>${file.text.split('\n').length} lines</span>` : nothing}<span class="status-spacer"></span><span class="file-action-notice" role="status">${this.fileActionNotice}</span><span>${readableSize(file.size)}</span><span>Read only</span></div>` : nothing}
      </div>
      ${this.filesRailOpen ? html`<div class="vertical-resizer" role="separator" aria-label="Resize file explorer" aria-orientation="vertical" tabindex="0" @pointerdown=${(event: PointerEvent) => this.startRailResize(event,'files')} @pointermove=${(event: PointerEvent) => this.moveRailResize(event)} @pointerup=${(event: PointerEvent) => this.endRailResize(event)} @lostpointercapture=${(event: PointerEvent) => this.endRailResize(event)} @keydown=${(event: KeyboardEvent) => this.keyRailResize(event,'files')}></div>` : nothing}
      ${this.filesRailOpen ? html`<div class="browser">
        <div class="browser-heading"><div class="explorer-label">FILES</div><div class="explorer-actions"><button class="icon-button" aria-label="Quick open file" title="Quick Open · Ctrl+P" @click=${() => this.showQuickOpen()}>${icon(Search,{size:15})}</button><button class="icon-button" aria-label="Refresh file tree" title="Refresh file tree" @click=${() => void this.refreshTree()}>${icon(RefreshCw,{size:15})}</button><button class="icon-button" aria-label="Collapse folders" title="Collapse folders" @click=${() => { this.expandedDirs = new Set(['.']); this.paintAll(); }}>${icon(ChevronsDownUp,{size:15})}</button></div></div>
        <div class="browser-tools"><mux-ui-text-field size="small" type="search" aria-label="Filter visible files" placeholder="Filter files…" .value=${this.fileQuery} @input=${(event: InputEvent) => { this.fileQuery = (event.target as MuxUITextField).value; this.paintAll(); }}></mux-ui-text-field><mux-ui-select size="small" aria-label="Sort files" .value=${this.fileSort} .options=${[{value:'name',label:'Name'},{value:'recent',label:'Recent'},{value:'size',label:'Size'}]} @change=${(event: Event) => { this.fileSort = (event.target as MuxUISelect).value as typeof this.fileSort; this.paintAll(); }}></mux-ui-select></div>
        ${this.touched.length ? html`<div class="touched-files"><h3>Changed files <span>${this.touched.length}</span></h3>${this.touched.map(path => html`<mux-ui-rail-row reserve-chevron label=${path} tooltip=${path} @click=${() => void this.revealFile(path)}><span slot="icon">${icon(fileGlyph(path),{size:14})}</span></mux-ui-rail-row>`)}</div>` : nothing}
        <button class="project-heading" title=${this.listing?.root || this.projectPath} @click=${() => { if (this.expandedDirs.has('.')) this.expandedDirs.delete('.'); else this.expandedDirs.add('.'); this.paintAll(); }} aria-expanded=${String(this.expandedDirs.has('.'))}><span class="tree-chevron">${icon(this.expandedDirs.has('.') ? ChevronDown : ChevronRight,{size:13})}</span><span class="file-glyph">${icon(Folder,{size:16})}</span><span class="file-name">${this.terminalMode ? 'Home · ~/' : 'All files'}</span></button>
        <div class="file-list" role="tree" aria-label=${this.terminalMode ? 'Home files' : 'Project files'} @keydown=${(event: KeyboardEvent) => this.onTreeKey(event)}>${this.expandedDirs.has('.') ? tree : nothing}${this.error ? html`<p class="empty">${this.error}</p>` : nothing}${this.listing && !tree.length ? html`<p class="empty">${this.fileQuery ? 'No files match this filter.' : 'This folder is empty.'}</p>` : nothing}${[...this.directoryCache.values()].some(item => item.truncated) ? html`<p class="empty">Some folders show only their first 500 entries.</p>` : nothing}</div>
      </div>` : nothing}
      ${this.quickOpen ? html`<mux-ui-dialog class="quick-dialog" open size="compact" presentation="adaptive" label="Quick Open" @dismiss=${() => this.hideQuickOpen()}><div class="quick-open"><div class="quick-input">${icon(Search,{size:18})}<input type="search" aria-label="Search project files" placeholder="Search files by name…" .value=${this.quickQuery} @input=${(event: InputEvent) => this.searchQuickOpen((event.target as HTMLInputElement).value)} @keydown=${(event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.hideQuickOpen(); } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); this.quickIndex = Math.max(0,Math.min(this.quickResults.length-1,this.quickIndex+(event.key === 'ArrowDown' ? 1 : -1))); this.paintAll(); } else if (event.key === 'Enter' && this.quickResults[this.quickIndex]) { event.preventDefault(); void this.revealFile(this.quickResults[this.quickIndex].path); } }}><kbd>ESC</kbd></div><div class="quick-results">${this.quickLoading ? html`<p>Searching project…</p>` : this.quickError ? html`<p>${this.quickError}</p>` : this.quickResults.length ? this.quickResults.map((result,index) => html`<button class=${index === this.quickIndex ? 'active' : ''} @mouseenter=${() => { this.quickIndex = index; }} @click=${() => void this.revealFile(result.path)}>${icon(fileGlyph(result.name),{size:16})}<span><strong>${result.name}</strong><small>${result.path}</small></span><em>${readableSize(result.size)}</em></button>`) : html`<p>${this.quickQuery.trim().length < 2 ? 'Type at least two characters to search the project.' : 'No matching files.'}</p>`}${this.quickTruncated && !this.quickLoading ? html`<p>Showing the first matches. Narrow your search for more.</p>` : nothing}</div></div></mux-ui-dialog>` : nothing}
    </section>`;
  }
  private changesView(): TemplateResult {
    const changes = this.changes;
    const detail = this.changeDetail;
    return html`<section class="changes-panel split-panel" style=${`--rail-width:${this.railWidths.changes}px`}><div class="changes-list"><header><div><strong>CHANGES</strong><span>${changes?.changes.length ?? 0}</span></div><mux-ui-button variant="quiet" size="small" icon-only accessible-label="Refresh changes" tooltip="Refresh changes" @click=${() => void this.loadChanges()}>${icon(RefreshCw,{size:15})}</mux-ui-button></header>
      ${this.changesError ? html`<p class="empty">${this.changesError}</p>` : !changes ? html`<p class="empty">Loading Git changes…</p>` : changes.repos.length ? changes.repos.map(repo => html`<div class="change-repo"><div class="change-repo-title"><strong>${repo.name}</strong><span>${repo.branch || 'detached HEAD'}</span></div>${changes.changes.filter(change => change.repo === repo.root).length ? changes.changes.filter(change => change.repo === repo.root).map(change => html`<mux-ui-rail-row label=${change.path} detail=${change.status.trim() || 'M'} detail-tone="accent" tooltip=${change.path} ?selected=${this.selectedChange?.repo === change.repo && this.selectedChange?.path === change.path} @click=${() => void this.openChange(change)}><span slot="icon">${icon(fileGlyph(change.path),{size:15})}</span></mux-ui-rail-row>`) : html`<p class="empty">No changes</p>`}</div>`) : html`<p class="empty">No Git repository in this chat’s project folders.</p>`}
      ${changes?.truncated ? html`<p class="empty">Showing the first changes. Refresh after narrowing the project.</p>` : nothing}
    </div><div class="vertical-resizer" role="separator" aria-label="Resize changes list" aria-orientation="vertical" tabindex="0" @pointerdown=${(event: PointerEvent) => this.startRailResize(event,'changes')} @pointermove=${(event: PointerEvent) => this.moveRailResize(event)} @pointerup=${(event: PointerEvent) => this.endRailResize(event)} @lostpointercapture=${(event: PointerEvent) => this.endRailResize(event)} @keydown=${(event: KeyboardEvent) => this.keyRailResize(event,'changes')}></div><div class="change-viewer"><header><span>${this.selectedChange?.path || 'Select a changed file'}</span>${this.selectedChange ? html`<small>${this.selectedChange.status.trim() || 'Modified'}</small>` : nothing}</header>${!this.selectedChange ? html`<div class="change-empty">${icon(GitCompare,{size:34})}<h2>Review project changes</h2><p>Select a file to compare it with HEAD.</p></div>` : !detail ? html`<div class="change-empty">Loading diff…</div>` : detail.tooLarge ? html`<div class="change-empty">This file is too large for the diff viewer.</div>` : detail.binary ? html`<div class="change-empty">Binary changes cannot be shown as text.</div>` : html`<mux-monaco-diff .repo=${detail.repo} .path=${detail.path} .originalText=${detail.before} .modifiedText=${detail.after}></mux-monaco-diff>`}</div></section>`;
  }
  private async loadPages() {
    this.pagesError = '';
    try {
      await import('./mux-blocknote-page.js');
      const response = await fetch(this.endpoint('pages'));
      if (!response.ok) throw new Error(`Pages unavailable (${response.status})`);
      const doc = await response.json() as { pages: NotePage[]; version?: number };
      this.pages = doc.pages || [];
      this.pagesVersion = doc.version || 0;
      this.pagesConflict = false;
      if (!this.pages.some(page => page.id === this.pageId)) this.pageId = this.pages[0]?.id || '';
    } catch (error) { this.pagesError = String(error); }
    this.paintAll();
  }
  private async refreshPages() {
    try {
      const response = await fetch(this.endpoint('pages'));
      if (!response.ok) return;
      const doc = await response.json() as { pages: NotePage[]; version?: number };
      if ((doc.version || 0) <= this.pagesVersion || this.pageSaving) return;
      this.pages = doc.pages || [];
      this.pagesVersion = doc.version || 0;
      this.pagesRenderEpoch++;
      if (!this.pages.some(page => page.id === this.pageId)) this.pageId = this.pages[0]?.id || '';
      this.paintAll();
    } catch { /* refresh on next poll */ }
  }
  private schedulePageSave() {
    if (this.pageSaveTimer) window.clearTimeout(this.pageSaveTimer);
    this.pageSaving = true;
    this.pageSaveTimer = window.setTimeout(() => { this.pageSaveTimer = undefined; void this.savePages(); }, 500);
  }
  private savePages() {
    this.pageSaveQueue = this.pageSaveQueue.catch(() => {}).then(async () => {
      const snapshot = JSON.stringify({ version:this.pagesVersion, pages:this.pages || [] });
      const response = await fetch(this.endpoint('pages'), { method:'PUT', headers:{'Content-Type':'application/json'}, body:snapshot });
      if (!response.ok) { if (response.status === 409) this.pagesConflict = true; throw new Error(response.status === 409 ? 'Page changed elsewhere. Your edits are still here; reload after copying them.' : `Could not save pages (${response.status})`); }
      const result = await response.json() as { version?: number };
      this.pagesVersion = result.version || 0;
      this.pagesError = '';
      this.pageSaving = false;
      this.paintAll();
    }).catch(error => { this.pagesError = String(error); this.pageSaving = false; this.paintAll(); });
    return this.pageSaveQueue;
  }
  private newPage(parentId = '') {
    const page: NotePage = { id:crypto.randomUUID(), parentId:parentId || undefined, title:'Untitled', blocks:[], content:[{type:'paragraph'}] };
    this.pages = [...(this.pages || []), page];
    this.selectPage(page.id);
    this.schedulePageSave();
    this.paintAll();
    void this.updateComplete.then(() => this.querySelector<HTMLTextAreaElement>('.page-title')?.focus());
    return page;
  }
  private requestDeletePage(page: NotePage) {
    if (!this.pages || this.pagesConflict) return;
    const deleted = new Set([page.id]);
    for (let size = -1; size !== deleted.size;) {
      size = deleted.size;
      for (const child of this.pages) if (child.parentId && deleted.has(child.parentId)) deleted.add(child.id);
    }
    const descendants = deleted.size - 1;
    const title = page.title || 'Untitled';
    const message = descendants
      ? `Delete “${title}” and its ${descendants} subpage${descendants === 1 ? '' : 's'}? This cannot be undone.`
      : `Delete “${title}”? This cannot be undone.`;
    this.pendingPageDeletion = { id:page.id, message };
    this.paintAll();
  }
  private deletePage() {
    const page = this.pages?.find(item => item.id === this.pendingPageDeletion?.id);
    if (!page || !this.pages || this.pagesConflict) return;
    this.pendingPageDeletion = undefined;
    const deleted = new Set([page.id]);
    for (let size = -1; size !== deleted.size;) {
      size = deleted.size;
      for (const child of this.pages) if (child.parentId && deleted.has(child.parentId)) deleted.add(child.id);
    }
    this.pages = this.pages.filter(item => !deleted.has(item.id));
    const next = page.parentId && this.pages.some(item => item.id === page.parentId)
      ? page.parentId : this.pages[0]?.id || '';
    if (deleted.has(this.pageId)) this.pageId = next;
    for (const tab of this.tabs) if (tab.kind === 'pages' && tab.pageId && deleted.has(tab.pageId)) tab.pageId = next;
    this.saveTabs();
    try { localStorage.setItem(this.pageKey(), this.pageId); } catch { /* private browsing */ }
    this.pagesRenderEpoch++;
    this.schedulePageSave();
    this.paintAll();
  }
  private pageRows(parentId = '', depth = 0): TemplateResult[] {
    if (depth > 8) return [];
    const rows: TemplateResult[] = [];
    for (const page of (this.pages || []).filter(item => (item.parentId || '') === parentId)) {
      rows.push(html`<mux-ui-rail-row label=${page.title || 'Untitled'} tooltip=${page.title || 'Untitled'} .depth=${depth} ?selected=${page.id === this.pageId} @click=${() => this.selectPage(page.id)}><span slot="icon">${icon(NotebookPen,{size:15})}</span></mux-ui-rail-row>`);
      rows.push(...this.pageRows(page.id, depth + 1));
    }
    return rows;
  }
  private selectPage(id: string) {
    this.pageId = id;
    if (this.currentTab.kind === 'pages') { this.currentTab.pageId = id; this.saveTabs(); }
    try { localStorage.setItem(this.pageKey(),id); } catch { /* private browsing */ }
    this.paintAll();
  }
  private openPageLink(event: MouseEvent) {
    const link = event.composedPath().find(node => node instanceof HTMLAnchorElement && node.getAttribute('href')?.startsWith('#muxterm-page-')) as HTMLAnchorElement | undefined;
    const id = link?.getAttribute('href')?.slice('#muxterm-page-'.length);
    if (id && this.pages?.some(page => page.id === id)) { event.preventDefault(); this.selectPage(id); }
  }
  private pageCommand(page: NotePage, kind: 'page' | 'generate' | 'visualize') {
    if (kind === 'page') { this.newPage(page.id); return; }
    this.dispatchEvent(new CustomEvent('sdk-page-prompt', { detail:{pageId:page.id,title:page.title,kind}, bubbles:true, composed:true }));
  }
  override updated() {
    if (this.migrateLegacyFile()) {
      if (this.currentTab.kind === 'files' && this.currentTab.filePath) void this.loadFile(this.currentTab.filePath);
      this.paintAll();
    }
    if (this.activeTab !== 'pages') return;
    for (const field of this.querySelectorAll<HTMLTextAreaElement>('.page-title')) {
      field.style.height = 'auto';
      field.style.height = `${Math.max(field.scrollHeight, 42)}px`;
    }
  }
  private growPageField(event: InputEvent) {
    const field = event.target as HTMLTextAreaElement;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }
  private pagesView(): TemplateResult {
    const page = this.pages?.find(item => item.id === this.pageId);
    const parent = page?.parentId ? this.pages?.find(item => item.id === page.parentId) : undefined;
    return html`<section class="pages-panel split-panel ${this.pagesRailOpen ? '' : 'rail-closed'}" style=${`--rail-width:${this.railWidths.pages}px`}>
      ${this.pagesRailOpen ? html`<div class="pages-list"><div class="browser-heading"><div class="explorer-label">PAGES</div><div class="explorer-actions"><button class="icon-button" aria-label="New page" title="New page" @click=${() => this.newPage()}>${icon(Plus,{size:15})}</button></div></div><div class="page-list-rows">${this.pagesError ? html`<p class="pages-error">${this.pagesError}</p>` : nothing}${!this.pages ? html`<p class="empty">Loading pages…</p>` : this.pages.length ? this.pageRows() : html`<p class="empty">Create a page to start writing.</p>`}</div></div>` : nothing}
      ${this.pagesRailOpen ? html`<div class="vertical-resizer" role="separator" aria-label="Resize page list" aria-orientation="vertical" tabindex="0" @pointerdown=${(event: PointerEvent) => this.startRailResize(event,'pages')} @pointermove=${(event: PointerEvent) => this.moveRailResize(event)} @pointerup=${(event: PointerEvent) => this.endRailResize(event)} @lostpointercapture=${(event: PointerEvent) => this.endRailResize(event)} @keydown=${(event: KeyboardEvent) => this.keyRailResize(event,'pages')}></div>` : nothing}
      <div class="page-editor"><div class="page-toolbar"><div><button aria-label=${this.pagesRailOpen ? 'Hide pages list' : 'Show pages list'} title=${this.pagesRailOpen ? 'Hide pages list' : 'Show pages list'} @click=${() => { this.pagesRailOpen = !this.pagesRailOpen; this.paintAll(); }}>${icon(NotebookPen,{size:15})}</button>${parent ? html`<button class="page-parent" @click=${() => this.selectPage(parent.id)}>${parent.title}</button><span>›</span>` : nothing}<span>${page?.title || 'Pages'}</span></div><div class="page-toolbar-actions"><span>${this.pageSaving ? 'Saving…' : 'Saved'}</span>${page ? html`<button class="page-delete" aria-label=${`Delete page ${page.title || 'Untitled'}`} title=${this.pagesConflict ? 'Reload pages before deleting' : 'Delete page'} ?disabled=${this.pagesConflict} @click=${() => this.requestDeletePage(page)}>${icon(Trash2,{size:15})}</button>` : nothing}</div></div>
      ${page ? html`<div class="page-canvas"><div class="page-paper"><textarea class="page-title" aria-label="Page title" placeholder="Untitled" rows="1" .value=${page.title} @input=${(event: InputEvent) => { page.title = (event.target as HTMLTextAreaElement).value; this.growPageField(event); this.schedulePageSave(); }}></textarea><mux-blocknote-page .content=${page.content?.length ? page.content : legacyPageContent(page.blocks)} .pageId=${page.id} .documentEpoch=${this.pagesRenderEpoch} @click=${(event: MouseEvent) => this.openPageLink(event)} @page-content-change=${(event: CustomEvent<PartialBlock[]>) => { page.content = event.detail; this.schedulePageSave(); }} @page-command=${(event: CustomEvent<'page' | 'generate' | 'visualize'>) => this.pageCommand(page,event.detail)}></mux-blocknote-page><button class="page-subpage" @click=${() => this.newPage(page.id)}>＋ New subpage</button></div></div>` : html`<div class="page-no-selection">${icon(NotebookPen,{size:32})}<h2>Pages</h2><p>Create a document for this chat.</p><button @click=${() => this.newPage()}>New page</button></div>`}</div>
      <mux-ui-dialog size="compact" presentation="adaptive" label="Delete page" ?open=${!!this.pendingPageDeletion} @dismiss=${() => { this.pendingPageDeletion = undefined; this.paintAll(); }}><div class="page-delete-dialog"><h2>Delete page?</h2><p>${this.pendingPageDeletion?.message || ''}</p><div class="page-delete-actions"><mux-ui-button variant="secondary" @click=${() => { this.pendingPageDeletion = undefined; this.paintAll(); }}>Cancel</mux-ui-button><mux-ui-button variant="danger" @click=${() => this.deletePage()}>Delete page</mux-ui-button></div></div></mux-ui-dialog>
    </section>`;
  }
  private surfaceCSS = `
    mux-sdk-utility { display:flex; flex-direction:column; min-width:0; height:100%; background:var(--ui-surface-raised); color:var(--ui-text); font:var(--ui-text-md)/1.5 var(--ui-font-sans); }
    mux-sdk-utility * { scrollbar-width:thin; scrollbar-color:color-mix(in srgb,var(--ui-text-muted) 34%,transparent) transparent; }
    mux-sdk-utility *::-webkit-scrollbar { width:6px; height:6px; }
    mux-sdk-utility *::-webkit-scrollbar-track { background:transparent; }
    mux-sdk-utility *::-webkit-scrollbar-thumb { background:color-mix(in srgb,var(--ui-text-muted) 34%,transparent); border-radius:var(--ui-radius-pill); }
    mux-sdk-utility *::-webkit-scrollbar-thumb:hover { background:color-mix(in srgb,var(--ui-text-muted) 58%,transparent); }
    mux-sdk-utility .new-tab-surface { box-sizing:border-box; width:100%; height:100%; padding:var(--ui-space-9) 0; background:var(--ui-surface-base); }
    mux-sdk-utility .new-tab-home { width:min(680px,calc(100% - 44px)); margin:0 auto; }
    mux-sdk-utility .new-tab-home h2 { margin:0 0 var(--ui-space-5); color:var(--ui-text-muted); font:600 var(--ui-text-xs) var(--ui-font-sans); }
    mux-sdk-utility .new-tab-tools { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--ui-space-4); }
    mux-sdk-utility .new-tab-tools button { display:flex; align-items:center; gap:var(--ui-space-5); min-width:0; height:37px; padding:0 var(--ui-space-5); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); color:var(--ui-text); text-align:left; font:500 var(--ui-text-xs) var(--ui-font-sans); cursor:pointer; }
    mux-sdk-utility .new-tab-tools button:hover { border-color:var(--ui-accent); }
    mux-sdk-utility .utility-body { flex:1; min-height:0; min-width:0; overflow:hidden; container-type:inline-size; }
    mux-sdk-utility .utility-placeholder { display:flex; align-items:center; justify-content:center; width:100%; height:100%; color:var(--ui-text-muted); }
    mux-sdk-utility .empty { color:var(--ui-text-muted); line-height:1.6; } mux-sdk-utility a { color:var(--ui-accent); }
    mux-sdk-utility .files-panel, mux-sdk-utility .changes-panel, mux-sdk-utility .pages-panel { display:grid; grid-template-columns:clamp(180px,var(--rail-width),45%) 6px minmax(0,1fr); height:100%; min-width:0; overflow:hidden; position:relative; background:var(--ui-surface-base); }
    mux-sdk-utility .files-panel { grid-template-columns:minmax(0,1fr) 6px clamp(180px,var(--rail-width),45%); }
    mux-sdk-utility .files-panel.rail-closed { grid-template-columns:minmax(0,1fr); }
    mux-sdk-utility .browser { display:flex; flex-direction:column; min-width:0; min-height:0; background:color-mix(in srgb,var(--ui-surface-base) 78%,var(--ui-surface-raised)); }
    mux-sdk-utility .files-panel .browser { border-left:1px solid var(--ui-border); background:var(--ui-surface-base); }
    mux-sdk-utility .files-panel .browser-heading { height:42px; flex:none; }
    mux-sdk-utility .browser-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-4); height:34px; padding:0 var(--ui-space-4) 0 var(--ui-space-6); }
    mux-sdk-utility .explorer-label { color:var(--ui-text-muted); font:600 var(--ui-text-xs) var(--ui-font-sans); letter-spacing:.13em; }
    mux-sdk-utility .explorer-actions { display:flex; align-items:center; gap:var(--ui-space-1); }
    mux-sdk-utility .icon-button, mux-sdk-utility .rail-toggle { display:inline-flex; align-items:center; justify-content:center; flex:none; width:28px; height:26px; padding:0; border:0; border-radius:var(--ui-radius-sm); background:transparent; color:var(--ui-text-muted); cursor:pointer; }
    mux-sdk-utility .icon-button:hover, mux-sdk-utility .rail-toggle:hover { color:var(--ui-text); background:var(--ui-surface-hover); }
    mux-sdk-utility .icon-button:disabled { opacity:.4; cursor:default; }
    mux-sdk-utility .project-heading { display:flex; align-items:center; gap:var(--ui-space-3); width:100%; min-height:28px; padding:0 var(--ui-space-5) 0 var(--ui-space-4); border:0; background:color-mix(in srgb,var(--ui-surface-base) 67%,var(--ui-surface-raised)); color:var(--ui-text); text-align:left; font:600 var(--ui-text-xs) var(--ui-font-sans); cursor:pointer; }
    mux-sdk-utility .project-heading span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .browser-tools { display:flex; align-items:stretch; gap:var(--ui-space-3); margin:0 var(--ui-space-4) var(--ui-space-3); }
    mux-sdk-utility .files-panel .browser-tools { margin-top:var(--ui-space-2); margin-bottom:var(--ui-space-5); }
    mux-sdk-utility .browser-tools mux-ui-text-field { flex:1; min-width:0; }
    mux-sdk-utility .browser-tools mux-ui-select { flex:none; width:var(--ui-dock-tab-min-width); }
    mux-sdk-utility .file-list { flex:1; min-height:0; overflow:auto; padding:var(--ui-space-1) 0 var(--ui-space-5); }
    mux-sdk-utility .tree-chevron, mux-sdk-utility .file-glyph { display:flex; align-items:center; justify-content:center; flex:none; width:14px; color:var(--ui-text-muted); }
    mux-sdk-utility .file-glyph { width:17px; color:var(--ui-accent); }
    mux-sdk-utility .file-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .touched-files { max-height:25%; min-height:50px; overflow:auto; border-bottom:1px solid var(--ui-border); padding:var(--ui-space-1) 0 var(--ui-space-4); }
    mux-sdk-utility .touched-files h3 { display:flex; justify-content:space-between; margin:0 var(--ui-space-5) var(--ui-space-3); font:600 var(--ui-text-xs) var(--ui-font-sans); color:var(--ui-text-muted); }
    mux-sdk-utility .file-list .empty { margin:var(--ui-space-5) var(--ui-space-6); color:var(--ui-text-muted); font:var(--ui-text-xs)/1.5 var(--ui-font-sans); }
    mux-sdk-utility .viewer { display:flex; flex-direction:column; min-width:0; min-height:0; background:var(--ui-surface-base); }
    mux-sdk-utility .viewer-header { display:flex; align-items:center; gap:var(--ui-space-4); flex:none; min-height:42px; box-sizing:border-box; border-bottom:1px solid var(--ui-border); padding:var(--ui-space-1) var(--ui-space-4) var(--ui-space-1) var(--ui-space-6); background:var(--ui-surface-raised); }
    mux-sdk-utility .viewer-path { display:flex; align-items:center; gap:var(--ui-space-3); flex:1; min-width:0; overflow:hidden; white-space:nowrap; color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-sans); }
    mux-sdk-utility .viewer-path button { border:0; padding:0; background:transparent; color:var(--ui-text-muted); cursor:pointer; }
    mux-sdk-utility .viewer-path button:hover { color:var(--ui-accent); }
    mux-sdk-utility .viewer-path strong { overflow:hidden; text-overflow:ellipsis; color:var(--ui-text); font-weight:500; }
    mux-sdk-utility .file-header-actions { display:flex; align-items:center; gap:var(--ui-space-3); flex:none; }
    mux-sdk-utility .file-header-actions .active { color:var(--ui-accent); background:color-mix(in srgb,var(--ui-accent) 12%,var(--ui-surface-raised)); }
    mux-sdk-utility .file-action-button, mux-sdk-utility .file-open-button { display:inline-flex; align-items:center; justify-content:center; gap:var(--ui-space-3); min-height:27px; border:1px solid var(--ui-border); border-radius:var(--ui-radius-sm); padding:0 var(--ui-space-4); background:var(--ui-surface-raised); color:var(--ui-text); font:var(--ui-text-xs) var(--ui-font-sans); white-space:nowrap; cursor:pointer; }
    mux-sdk-utility .file-action-button:hover, mux-sdk-utility .file-open-button:hover { background:var(--ui-surface-hover); }
    mux-sdk-utility .file-open-wrap { position:relative; }
    mux-sdk-utility .file-open-menu { --ui-menu-offset-y:calc(var(--ui-control-sm) + var(--ui-space-1)); --ui-menu-offset-x:0; --ui-menu-width:var(--ui-toast-min-width); }
    mux-sdk-utility .file-open-menu svg { flex:none; color:var(--ui-text-muted); }
    mux-sdk-utility .sandbox-note button { border:1px solid var(--ui-border); border-radius:var(--ui-radius-sm); background:var(--ui-surface-raised); color:var(--ui-text); padding:var(--ui-space-2) var(--ui-space-4); text-decoration:none; font:var(--ui-text-xs) var(--ui-font-sans); white-space:nowrap; cursor:pointer; }
    mux-sdk-utility .sandbox-note button:hover { background:var(--ui-surface-hover); }
    mux-sdk-utility .status-spacer { flex:1; }
    mux-sdk-utility .viewer-body { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; }
    mux-sdk-utility .file-empty { margin:auto; padding:var(--ui-space-7); max-width:340px; text-align:center; color:var(--ui-text-muted); }
    mux-sdk-utility mux-monaco-source { display:block; flex:1; min-height:0; min-width:0; }
    mux-sdk-utility mux-monaco-source .monaco-host { width:100%; height:100%; }
    mux-sdk-utility .file-status { display:flex; align-items:center; gap:var(--ui-space-6); flex:none; min-height:22px; padding:0 var(--ui-space-5); border-top:1px solid var(--ui-border); background:var(--ui-surface-raised); color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-sans); }
    mux-sdk-utility .file-status span:first-child { color:var(--ui-accent); }
    mux-sdk-utility .welcome-file { display:flex; flex:1; flex-direction:column; align-items:center; justify-content:center; gap:var(--ui-space-5); padding:var(--ui-space-8); color:var(--ui-text-muted); text-align:center; }
    mux-sdk-utility .welcome-file svg { color:var(--ui-accent); }
    mux-sdk-utility .welcome-file h2 { margin:var(--ui-space-1) 0 0; color:var(--ui-text); font-size:var(--ui-text-xl); }
    mux-sdk-utility .welcome-file p { max-width:290px; margin:0; font:var(--ui-text-sm)/1.5 var(--ui-font-sans); }
    mux-sdk-utility .welcome-file mux-ui-button { margin-top:var(--ui-space-3); }
    mux-sdk-utility kbd { border:1px solid var(--ui-border); border-radius:var(--ui-radius-sm); padding:calc(var(--ui-space-1) / 2) var(--ui-space-2); color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-mono); }
    mux-sdk-utility .quick-open { width:100%; max-height:min(480px,75dvh); display:flex; flex-direction:column; overflow:hidden; }
    mux-sdk-utility .quick-input { display:flex; align-items:center; gap:var(--ui-space-5); padding:var(--ui-space-5) var(--ui-space-5); border-bottom:1px solid var(--ui-border); color:var(--ui-accent); }
    mux-sdk-utility .quick-input input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--ui-text); font:var(--ui-text-lg) var(--ui-font-sans); }
    mux-sdk-utility .quick-results { overflow:auto; padding:var(--ui-space-3); }
    mux-sdk-utility .quick-results p { margin:var(--ui-space-6); color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-sans); }
    mux-sdk-utility .quick-results button { display:flex; align-items:center; gap:var(--ui-space-4); width:100%; padding:var(--ui-space-4) var(--ui-space-4); border:0; border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text); text-align:left; cursor:pointer; }
    mux-sdk-utility .quick-results button:hover, mux-sdk-utility .quick-results button.active { background:var(--ui-surface-hover); }
    mux-sdk-utility .quick-results button > svg { flex:none; color:var(--ui-accent); }
    mux-sdk-utility .quick-results button span { display:flex; flex:1; flex-direction:column; gap:var(--ui-space-1); min-width:0; }
    mux-sdk-utility .quick-results button strong, mux-sdk-utility .quick-results button small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .quick-results button strong { font:var(--ui-text-sm) var(--ui-font-sans); }
    mux-sdk-utility .quick-results button small, mux-sdk-utility .quick-results button em { color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-mono); }
    mux-sdk-utility .document-view { box-sizing:border-box; width:100%; max-width:840px; margin:0 auto; padding:var(--ui-space-6) clamp(var(--ui-space-7),5vw,var(--ui-space-12)) var(--ui-space-13); color:var(--ui-text); font:var(--ui-text-lg)/1.48 var(--ui-font-sans); overflow-wrap:break-word; }
    mux-sdk-utility .document-view > :first-child { margin-top:0; }
    mux-sdk-utility .document-view > :last-child { margin-bottom:0; }
    mux-sdk-utility .document-view .md-p { margin:0 0 var(--ui-space-3); }
    mux-sdk-utility .document-view .md-h { margin:var(--ui-space-4) 0 var(--ui-space-2); color:var(--ui-text); font-weight:650; line-height:1.3; overflow-wrap:break-word; }
    mux-sdk-utility .document-view h1.md-h { margin-top:0; margin-bottom:var(--ui-space-3); font-size:var(--ui-text-3xl); letter-spacing:-.025em; white-space:normal; overflow:visible; text-overflow:clip; }
    mux-sdk-utility .document-view h2.md-h { font-size:var(--ui-text-2xl); letter-spacing:-.015em; }
    mux-sdk-utility .document-view h3.md-h { font-size:var(--ui-text-xl); }
    mux-sdk-utility .document-view h4.md-h { font-size:var(--ui-text-xl); }
    mux-sdk-utility .document-view h5.md-h, mux-sdk-utility .document-view h6.md-h { font-size:var(--ui-text-lg); }
    mux-sdk-utility .document-view strong { font-weight:700; }
    mux-sdk-utility .document-view .md-link { color:var(--ui-accent); text-decoration:underline; text-underline-offset:3px; }
    mux-sdk-utility .document-view .md-link:hover { color:var(--ui-text); }
    mux-sdk-utility .document-view .md-code { padding:calc(var(--ui-space-1) / 2) var(--ui-space-1); border:1px solid var(--ui-border); border-radius:var(--ui-radius-sm); background:var(--ui-surface-raised); font:var(--ui-text-sm)/1.45 var(--ui-font-mono); }
    mux-sdk-utility .document-view .md-pre { box-sizing:border-box; max-width:100%; margin:0 0 var(--ui-space-4); padding:var(--ui-space-6) var(--ui-space-7); overflow:auto; border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); }
    mux-sdk-utility .document-view .md-pre[data-lang]:not([data-lang=""])::before { content:attr(data-lang); display:block; margin:0 0 var(--ui-space-4); color:var(--ui-text-muted); font:var(--ui-text-xs)/1.4 var(--ui-font-sans); text-transform:uppercase; letter-spacing:.07em; }
    mux-sdk-utility .document-view .md-pre code { font:var(--ui-text-sm)/1.6 var(--ui-font-mono); white-space:pre; }
    mux-sdk-utility .document-view .md-ul, mux-sdk-utility .document-view .md-ol { margin:0 0 var(--ui-space-3); padding-left:var(--ui-space-4); }
    mux-sdk-utility .document-view .md-li { padding-left:calc(var(--ui-space-1) / 2); margin:var(--ui-space-1) 0; }
    mux-sdk-utility .document-view .md-li .md-p { margin:0; }
    mux-sdk-utility .document-view .md-li > .md-ul, mux-sdk-utility .document-view .md-li > .md-ol { margin:var(--ui-space-1) 0 var(--ui-space-2); }
    mux-sdk-utility .document-view .md-quote { margin:0 0 var(--ui-space-4); padding:calc(var(--ui-space-1) / 2) 0 calc(var(--ui-space-1) / 2) var(--ui-space-3); border-left:3px solid var(--ui-accent); color:var(--ui-text-muted); }
    mux-sdk-utility .document-view .md-quote > :last-child { margin-bottom:0; }
    mux-sdk-utility .document-view .md-hr { margin:var(--ui-space-4) 0; border:0; border-top:1px solid var(--ui-border); }
    mux-sdk-utility .document-view .md-tablewrap { max-width:100%; overflow-x:auto; margin:0 0 var(--ui-space-4); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); }
    mux-sdk-utility .document-view .md-table { width:100%; border-collapse:collapse; font-size:var(--ui-text-md); line-height:1.5; }
    mux-sdk-utility .document-view .md-th, mux-sdk-utility .document-view .md-td { padding:var(--ui-space-4) var(--ui-space-5); border-bottom:1px solid var(--ui-border); text-align:left; vertical-align:top; overflow-wrap:normal; }
    mux-sdk-utility .document-view .md-th + .md-th, mux-sdk-utility .document-view .md-td + .md-td { border-left:1px solid var(--ui-border); }
    mux-sdk-utility .document-view .md-table tr:last-child .md-td { border-bottom:0; }
    mux-sdk-utility .document-view .md-th { background:var(--ui-surface-raised); font-weight:650; white-space:nowrap; }
    mux-sdk-utility .document-view .md-img { display:block; max-width:100%; height:auto; margin:0 0 var(--ui-space-4); border-radius:var(--ui-radius-md); }
    mux-sdk-utility .image-view { display:flex; justify-content:center; align-items:flex-start; padding:var(--ui-space-7); }
    mux-sdk-utility .image-view img { max-width:100%; max-height:calc(100vh - 200px); object-fit:contain; }
    mux-sdk-utility .table-view { flex:1; overflow:auto; padding:var(--ui-space-5); } mux-sdk-utility .table-view table { border-collapse:collapse; font:var(--ui-text-xs)/1.5 var(--ui-font-sans); }
    mux-sdk-utility .table-view th, mux-sdk-utility .table-view td { border:1px solid var(--ui-border); padding:var(--ui-space-3) var(--ui-space-4); max-width:320px; min-width:65px; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
    mux-sdk-utility .table-view th { position:sticky; top:0; background:var(--ui-surface-raised); font-weight:650; }
    mux-sdk-utility .sandbox-note { display:flex; align-items:center; gap:var(--ui-space-4); padding:var(--ui-space-4) var(--ui-space-5); border-bottom:1px solid var(--ui-border); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    mux-sdk-utility .document-frame { display:block; box-sizing:border-box; flex:1; width:100%; min-height:300px; border:0; background:var(--ui-document-surface); }
    mux-sdk-utility mux-sdk-pdf-preview { display:block; flex:1; min-height:0; }
    mux-sdk-utility .vertical-resizer { position:relative; cursor:col-resize; background:var(--ui-border); touch-action:none; }
    mux-sdk-utility .vertical-resizer:hover, mux-sdk-utility .vertical-resizer:focus-visible { background:var(--ui-accent); outline:0; }
    mux-sdk-utility .changes-list { min-width:0; min-height:0; overflow:auto; background:color-mix(in srgb,var(--ui-surface-base) 78%,var(--ui-surface-raised)); }
    mux-sdk-utility .changes-list > header { display:flex; justify-content:space-between; align-items:center; height:38px; padding:0 var(--ui-space-4) 0 var(--ui-space-6); border-bottom:1px solid var(--ui-border); color:var(--ui-text-muted); font:600 var(--ui-text-xs) var(--ui-font-sans); letter-spacing:.1em; }
    mux-sdk-utility .changes-list > header div { display:flex; align-items:center; gap:var(--ui-space-4); }
    mux-sdk-utility .changes-list > header span { border-radius:var(--ui-radius-lg); padding:calc(var(--ui-space-1) / 2) var(--ui-space-3); background:var(--ui-surface-hover); }
    mux-sdk-utility .change-repo-title { display:flex; flex-direction:column; gap:var(--ui-space-1); padding:var(--ui-space-5) var(--ui-space-5) var(--ui-space-4); color:var(--ui-text); font:var(--ui-text-xs) var(--ui-font-sans); }
    mux-sdk-utility .change-repo-title span { color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-mono); }
    mux-sdk-utility .change-viewer { display:flex; flex-direction:column; min-width:0; min-height:0; }
    mux-sdk-utility .change-viewer > header { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-5); min-height:38px; padding:0 var(--ui-space-5); border-bottom:1px solid var(--ui-border); font:var(--ui-text-xs) var(--ui-font-mono); }
    mux-sdk-utility .change-viewer > header span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .change-viewer > header small { color:var(--ui-accent); }
    mux-sdk-utility .change-empty { display:flex; flex:1; flex-direction:column; align-items:center; justify-content:center; gap:var(--ui-space-4); padding:var(--ui-space-8); color:var(--ui-text-muted); text-align:center; }
    mux-sdk-utility .change-empty svg { color:var(--ui-accent); }
    mux-sdk-utility .change-empty h2 { margin:0; color:var(--ui-text); font-size:var(--ui-text-xl); }
    mux-sdk-utility .change-empty p { margin:0; font:var(--ui-text-sm) var(--ui-font-sans); }
    mux-sdk-utility mux-monaco-diff { display:block; flex:1; min-height:0; min-width:0; }
    mux-sdk-utility mux-monaco-diff .monaco-diff-host { width:100%; height:100%; }
    mux-sdk-utility .pages-list { display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; background:color-mix(in srgb,var(--ui-surface-base) 78%,var(--ui-surface-raised)); }
    mux-sdk-utility .pages-list .browser-heading { flex:none; }
    mux-sdk-utility .pages-list .empty, mux-sdk-utility .pages-error { margin:var(--ui-space-6); font:var(--ui-text-xs)/1.5 var(--ui-font-sans); color:var(--ui-text-muted); }
    mux-sdk-utility .pages-error { color:var(--ui-danger-text); }
    mux-sdk-utility .page-list-rows { flex:1; min-height:0; overflow:auto; padding:var(--ui-space-1) 0 var(--ui-space-5); }
    mux-sdk-utility .page-editor { display:flex; flex-direction:column; min-width:0; min-height:0; overflow:auto; }
    mux-sdk-utility .page-editor-top { display:flex; align-items:center; justify-content:space-between; min-height:38px; padding:0 var(--ui-space-7); border-bottom:1px solid var(--ui-border); color:var(--ui-text-muted); font:var(--ui-text-xs) var(--ui-font-sans); }
    mux-sdk-utility .page-editor-top span:first-child { display:flex; align-items:center; gap:var(--ui-space-4); }
    mux-sdk-utility .page-paper { width:min(720px,100%); box-sizing:border-box; margin:0 auto; padding:var(--ui-space-11) clamp(var(--ui-space-7),8%,var(--ui-space-14)) var(--ui-space-15); }
    mux-sdk-utility .page-title { display:block; width:100%; min-height:75px; resize:none; overflow:hidden; border:0; outline:0; margin-bottom:var(--ui-space-8); background:transparent; color:var(--ui-text); font:700 clamp(var(--ui-text-3xl),3vw,var(--ui-text-5xl))/1.3 var(--ui-font-sans); }
    mux-sdk-utility .page-new-button { margin-top:var(--ui-space-5); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); padding:var(--ui-space-4) var(--ui-space-5); background:var(--ui-surface-raised); color:var(--ui-text); cursor:pointer; }
    mux-sdk-utility .pages-panel { background:var(--ui-document-surface); color:var(--ui-document-text); }
    mux-sdk-utility .pages-panel.rail-closed { grid-template-columns:minmax(0,1fr); }
    mux-sdk-utility .pages-panel .vertical-resizer { background:var(--ui-border); }
    mux-sdk-utility .pages-panel .vertical-resizer:hover, mux-sdk-utility .pages-panel .vertical-resizer:focus-visible { background:var(--ui-accent); }
    mux-sdk-utility .page-editor { background:var(--ui-document-surface); color:var(--ui-document-text); }
    mux-sdk-utility .page-toolbar { display:flex; justify-content:space-between; align-items:center; flex:none; min-height:42px; padding:0 var(--ui-space-6); border-bottom:1px solid var(--ui-document-border); color:var(--ui-document-muted); font:var(--ui-text-xs) var(--ui-font-sans); }
    mux-sdk-utility .page-toolbar > div { display:flex; align-items:center; gap:var(--ui-space-4); min-width:0; }
    mux-sdk-utility .page-toolbar > div > span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .page-toolbar-actions { flex:none; }
    mux-sdk-utility .page-toolbar .page-delete:hover { color:var(--ui-danger); background:color-mix(in srgb,var(--ui-danger) 8%,var(--ui-document-surface)); border-color:color-mix(in srgb,var(--ui-danger) 28%,var(--ui-document-border)); }
    mux-sdk-utility .page-toolbar .page-delete:disabled { opacity:.4; cursor:not-allowed; }
    mux-sdk-utility .page-toolbar button { display:inline-flex; align-items:center; justify-content:center; flex:none; width:28px; height:28px; border:1px solid var(--ui-document-border); border-radius:var(--ui-radius-lg); background:var(--ui-document-surface); color:var(--ui-document-muted); cursor:pointer; }
    mux-sdk-utility .page-toolbar button:hover { background:var(--ui-document-hover); }
    mux-sdk-utility .page-toolbar .page-parent { width:auto; max-width:130px; border:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .page-canvas { flex:1; overflow:auto; min-height:0; }
    mux-sdk-utility .page-paper { width:min(720px,100%); margin:0 auto; padding:var(--ui-space-10) clamp(var(--ui-space-6),6%,var(--ui-space-14)) var(--ui-space-16) clamp(var(--ui-space-13),8%,var(--ui-space-14)); }
    mux-sdk-utility .page-title { min-height:42px; margin:0 0 var(--ui-space-11); color:var(--ui-document-text); font:700 var(--ui-text-4xl)/1.28 var(--ui-font-sans); }
    mux-sdk-utility .page-subpage { margin:var(--ui-space-7) 0 0; border:0; background:transparent; color:var(--ui-document-muted); font:var(--ui-text-sm) var(--ui-font-sans); cursor:pointer; }
    mux-sdk-utility .page-subpage:hover { color:var(--ui-document-text); }
    mux-sdk-utility .page-no-selection { display:flex; align-items:center; justify-content:center; flex:1; flex-direction:column; gap:var(--ui-space-4); color:var(--ui-document-muted); }
    mux-sdk-utility .page-no-selection h2 { margin:0; color:var(--ui-document-text); }
    mux-sdk-utility .page-no-selection p { margin:0; }
    mux-sdk-utility .page-no-selection button { margin-top:var(--ui-space-4); border:1px solid var(--ui-document-border); border-radius:var(--ui-radius-md); padding:var(--ui-space-4) var(--ui-space-5); background:var(--ui-document-surface); color:var(--ui-document-text); cursor:pointer; }
    mux-sdk-utility .page-delete-dialog { box-sizing:border-box; padding:var(--ui-space-7); background:var(--ui-surface-overlay); color:var(--ui-text); font:var(--ui-text-md)/1.5 var(--ui-font-sans); }
    mux-sdk-utility .page-delete-dialog h2 { margin:0; font-size:var(--ui-text-xl); }
    mux-sdk-utility .page-delete-dialog p { margin:var(--ui-space-4) 0 var(--ui-space-7); color:var(--ui-text-muted); }
    mux-sdk-utility .page-delete-actions { display:flex; justify-content:flex-end; gap:var(--ui-space-4); }
    @container(max-width:650px) { mux-sdk-utility .files-panel { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr) minmax(170px,38%); } mux-sdk-utility .files-panel.rail-closed { grid-template-rows:minmax(0,1fr); } mux-sdk-utility .files-panel .vertical-resizer { display:none; } mux-sdk-utility .files-panel .browser { border-left:0; border-top:1px solid var(--ui-border); } }
    @container(max-width:430px) { mux-sdk-utility .file-action-button span { display:none; } }
    @container(max-width:520px) { mux-sdk-utility .changes-panel, mux-sdk-utility .pages-panel { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(170px,38%) minmax(0,1fr); } mux-sdk-utility .pages-panel { grid-template-rows:minmax(96px,min(18%,144px)) minmax(0,1fr); } mux-sdk-utility .pages-panel.rail-closed { grid-template-rows:minmax(0,1fr); } mux-sdk-utility .pages-panel .page-paper { padding:var(--ui-space-8) var(--ui-space-6) var(--ui-space-13); } mux-sdk-utility .pages-panel .page-title { margin-bottom:var(--ui-space-8); font-size:var(--ui-text-3xl); } mux-sdk-utility .changes-panel .vertical-resizer, mux-sdk-utility .pages-panel .vertical-resizer { display:none; } mux-sdk-utility .changes-list, mux-sdk-utility .pages-list { border-bottom:1px solid var(--ui-border); } }
    mux-sdk-utility[terminal-mode] .terminal-files-header { box-sizing:border-box; height:var(--ui-nav-height); flex:none; display:flex; align-items:center; justify-content:space-between; padding:0 max(var(--ui-space-4),var(--wco-right-inset,0)) 0 var(--ui-space-6); border-bottom:1px solid var(--ui-border); background:var(--ui-surface-nav); font:650 var(--ui-text-sm) var(--ui-font-sans); }
    mux-sdk-utility[terminal-mode] .files-panel { display:block; }
    mux-sdk-utility[terminal-mode] .files-panel > .vertical-resizer { display:none; }
    mux-sdk-utility[terminal-mode] .files-panel > .browser { height:100%; border:0; }
    mux-sdk-utility[terminal-mode] .files-panel > .viewer { display:none; height:100%; }
    mux-sdk-utility[terminal-mode] .files-panel.terminal-preview > .browser { display:none; }
    mux-sdk-utility[terminal-mode] .files-panel.terminal-preview > .viewer { display:flex; }
  `;
}
