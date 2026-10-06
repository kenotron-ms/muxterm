import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ChevronDown, ChevronRight, ChevronsDownUp, Code2, File, FileImage, FileJson, FileText, Folder, FolderOpen, GitCompare, Maximize2, Minimize2, NotebookPen, Plus, RefreshCw, Search, Terminal, Trash2, X, type IconNode } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { store } from '../state.js';
import { icon } from '../lib/icons.js';
import { parseMarkdown } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import type { PartialBlock } from '@blocknote/core';
import './mux-sdk-pdf-preview.js';
import './mux-monaco-source.js';
import './mux-monaco-diff.js';
import './mux-chat-terminal.js';
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
type UtilityTabId = 'new' | 'files' | 'changes' | 'terminal' | 'pages';
type UtilityTab = { id: string; kind: UtilityTabId; paneId?: number; pageId?: string; filePath?: string };
const TABS_KEY = 'muxterm.sdk.utility.tabs.';
const TAB_GLYPHS: Record<UtilityTabId, IconNode> = { new:Plus, changes:GitCompare, files:Folder, terminal:Terminal, pages:NotebookPen };

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
  @property() chatTitle = '';
  @property() terminalWorkspaceId = '';
  @property({ type: Boolean }) focused = false;
  @property({ attribute: false }) touched: string[] = [];
  private tabs: UtilityTab[] = [{ id: crypto.randomUUID(), kind: 'new' }];
  private activeTabId = this.tabs[0].id;
  private get activeTab(): UtilityTabId { return this.tabs.find(tab => tab.id === this.activeTabId)?.kind || 'new'; }
  private get currentTab(): UtilityTab { return this.tabs.find(tab => tab.id === this.activeTabId) || this.tabs[0]; }
  private railWidths = { files: 240, changes: 240, pages: 240 };
  private resizingRail: keyof typeof this.railWidths | null = null;
  private unsubscribeStore?: () => void;
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
  private terminalRetryTimer?: number;
  private terminalRetryCount = 0;
  private terminalCreatePending = false;
  private error = '';
  private fileError = '';
  private pendingFile = 0;
  private pathKey() { return `muxterm.sdk.utility.path.${this.sessionId}`; }
  private fileKey() { return `muxterm.sdk.utility.file.${this.sessionId}`; }
  private pageKey() { return `muxterm.sdk.utility.page.${this.sessionId}`; }

  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    try {
      const saved = JSON.parse(localStorage.getItem(TABS_KEY + this.sessionId) || 'null') as { tabs?: (UtilityTab | { id: string; kind: 'web' })[]; activeTabId?: string } | null;
      const valid = new Set<string>(['new','files','changes','terminal','pages','web']);
      if (saved?.tabs?.length && saved.tabs.length <= 30 && saved.tabs.every(tab => typeof tab.id === 'string' && valid.has(tab.kind))) {
        this.tabs = saved.tabs.map(tab => tab.kind === 'web' ? { id:tab.id, kind:'new' } : tab);
        this.activeTabId = this.tabs.some(tab => tab.id === saved.activeTabId) ? saved.activeTabId! : this.tabs[0].id;
        if (saved.tabs.some(tab => tab.kind === 'web')) this.saveTabs();
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
    if (this.activeTab === 'terminal') queueMicrotask(() => this.requestChatTerminal());
    this.unsubscribeStore = store.subscribe(() => { if (this.activeTab === 'terminal') { this.assignTerminalPane(); this.paintAll(); } });
  }
  override disconnectedCallback() {
    this.fileAbort?.abort();
    this.changeAbort?.abort();
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.quickAbort?.abort();
    if (this.quickTimer) window.clearTimeout(this.quickTimer);
    if (this.pageSaveTimer) { window.clearTimeout(this.pageSaveTimer); void this.savePages(); }
    if (this.pagesPollTimer) window.clearInterval(this.pagesPollTimer);
    if (this.terminalRetryTimer) window.clearTimeout(this.terminalRetryTimer);
    super.disconnectedCallback();
  }
  override render() {
    const tab = this.currentTab;
    return html`<style>${this.surfaceCSS}</style><div class="utility-tabs" role="tablist" aria-label="Chat tools">${this.tabs.map(item => html`<div class="utility-tab ${item.id === tab.id ? 'active' : ''}"><button role="tab" title=${item.filePath || this.tabTitle(item)} aria-selected=${String(item.id === tab.id)} @click=${() => this.selectTab(item.id)}>${icon(item.kind === 'files' && item.filePath ? fileGlyph(item.filePath) : TAB_GLYPHS[item.kind],{size:14})}<span>${this.tabTitle(item)}</span></button><button class="tab-close" aria-label=${`Close ${this.tabTitle(item)} tab`} @click=${() => this.closeTab(item.id)}>${icon(X,{size:13})}</button></div>`)}<button class="tab-add" aria-label="New tab" title="New tab" @click=${() => this.addTab()} aria-keyshortcuts="Control+T">${icon(Plus,{size:17})}</button></div><div class="utility-body" role="tabpanel" aria-label=${this.tabTitle(tab)}>${tab.kind === 'new' ? this.newTabView() : tab.kind === 'files' ? this.filesView() : tab.kind === 'changes' ? this.changesView() : tab.kind === 'terminal' ? this.terminalView(tab) : this.pagesView()}</div>`;
  }
  private tabTitle(tab: UtilityTab): string {
    if (tab.kind === 'new') return 'New tab';
    if (tab.kind === 'files') return tab.filePath?.split('/').pop() || 'Files';
    if (tab.kind === 'pages') return this.pages?.find(page => page.id === tab.pageId)?.title || 'Page';
    return ({ changes:'Changes', terminal:'Terminal' } as Record<string,string>)[tab.kind] || 'Tab';
  }
  private saveTabs() { try { localStorage.setItem(TABS_KEY + this.sessionId, JSON.stringify({ tabs:this.tabs, activeTabId:this.activeTabId })); } catch { /* private browsing */ } }
  private migrateLegacyFile(): boolean {
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
    if (tab.kind === 'terminal') { this.terminalRetryCount = 0; this.assignTerminalPane(); this.requestChatTerminal(); }
    else if (this.terminalRetryTimer) { window.clearTimeout(this.terminalRetryTimer); this.terminalRetryTimer = undefined; }
    return fileLoad;
  }
  private endpoint(kind: string, path?: string) {
    const base = `/api/sdk-chats/${encodeURIComponent(this.sessionId)}/utility/${kind}`;
    return apiPath(base) + (path ? `?${new URLSearchParams({path})}` : '');
  }
  showPanel(id: UtilityTabId): void {
    const existing = this.tabs.find(tab => tab.kind === id);
    if (existing) this.selectTab(existing.id);
    else this.addTab(id);
  }
  private chooseTool(kind: 'terminal' | 'files' | 'changes' | 'pages') {
    const current = this.currentTab;
    if (kind === 'terminal') {
      const existing = this.tabs.some(tab => tab.kind === 'terminal');
      this.terminalCreatePending = existing;
      current.kind = 'terminal'; this.saveTabs(); this.activateTab(current); this.paintAll();
      return;
    }
    current.kind = kind;
    if (kind === 'pages') {
      if (!this.pages) { void this.loadPages().then(() => { const page = this.newPage(); current.pageId = page.id; this.saveTabs(); }); }
      else { const page = this.newPage(); current.pageId = page.id; }
    } else this.activateTab(current);
    this.saveTabs(); this.paintAll();
  }
  private newTabView(): TemplateResult {
    return html`<section class="new-tab-surface"><div class="new-tab-home"><h2>Tools</h2><div class="new-tab-tools"><button @click=${() => this.chooseTool('terminal')}>${icon(Terminal,{size:16})}<span>Terminal</span></button><button @click=${() => this.chooseTool('files')}>${icon(Folder,{size:16})}<span>Files</span></button><button @click=${() => this.chooseTool('changes')}>${icon(GitCompare,{size:16})}<span>Changes</span></button><button @click=${() => this.chooseTool('pages')}>${icon(NotebookPen,{size:16})}<span>New page</span></button></div></div></section>`;
  }
  private assignTerminalPane() {
    if (!this.terminalWorkspaceId || store.attached !== this.terminalWorkspaceId) return;
    const panes = store.panes.filter(pane => pane.paneId >= 0);
    const claimed = new Set(this.tabs.filter(tab => tab.kind === 'terminal' && tab.paneId !== undefined).map(tab => tab.paneId));
    let changed = false;
    for (const tab of this.tabs.filter(tab => tab.kind === 'terminal' && tab.paneId === undefined)) {
      const pane = panes.find(item => !claimed.has(item.paneId));
      if (!pane) break;
      tab.paneId = pane.paneId; claimed.add(pane.paneId); changed = true;
    }
    if (changed) this.saveTabs();
    if (this.terminalCreatePending) {
      this.terminalCreatePending = false;
      if (this.currentTab.kind === 'terminal' && this.currentTab.paneId === undefined)
        this.dispatchEvent(new CustomEvent('pane-create',{bubbles:true,composed:true}));
    }
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
      this.expandAncestors(listing.path);
      this.expandedDirs.add(listing.path);
      try { localStorage.setItem(this.pathKey(), listing.path); } catch { /* private browsing */ }
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
  private showQuickOpen() {
    this.quickAbort?.abort();
    if (this.quickTimer) window.clearTimeout(this.quickTimer);
    if (this.currentTab.kind !== 'files') this.showPanel('files');
    this.quickOpen = true;
    this.quickQuery = '';
    this.quickResults = [];
    this.quickIndex = 0;
    this.quickLoading = false;
    this.quickTruncated = false;
    this.quickError = '';
    this.paintAll();
    queueMicrotask(() => this.querySelector<HTMLInputElement>('.quick-open input')?.focus());
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
    const width = Math.round(Math.max(160, Math.min(box.width - 230, event.clientX - box.left)));
    this.railWidths[this.resizingRail] = width;
    panel.style.setProperty('--rail-width', `${width}px`);
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
    this.railWidths[key] = Math.max(160, Math.min(900, this.railWidths[key] + (event.key === 'ArrowRight' ? 20 : -20)));
    (event.currentTarget as HTMLElement).closest<HTMLElement>('.split-panel')?.style.setProperty('--rail-width', `${this.railWidths[key]}px`);
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
      rows.push(html`<button class="file-entry ${this.selected === path ? 'selected' : ''} ${entry.dir ? 'directory' : ''}" role="treeitem" aria-level=${depth + 1} aria-expanded=${entry.dir ? String(expanded) : nothing} aria-selected=${String(this.selected === path)} data-path=${path} style=${`--depth:${depth}`} title=${path} @click=${() => void (entry.dir ? this.toggleDirectory(path) : this.openFile(path))}>
        <span class="tree-chevron">${entry.dir ? icon(expanded ? ChevronDown : ChevronRight, { size: 13 }) : nothing}</span><span class="file-glyph">${icon(fileGlyph(entry.name, entry.dir, expanded), { size: 16 })}</span><span class="file-name">${entry.name}</span>${!entry.dir ? html`<span class="file-size">${readableSize(entry.size)}</span>` : nothing}</button>`);
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
    const target = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!target) return;
    const items = [...this.querySelectorAll<HTMLElement>('.file-list [role="treeitem"]')];
    const index = items.indexOf(target);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowDown') items[Math.min(items.length - 1, index + 1)]?.focus();
    else if (event.key === 'ArrowUp') items[Math.max(0, index - 1)]?.focus();
    else if (event.key === 'ArrowRight' && target.getAttribute('aria-expanded') === 'false') void this.toggleDirectory(target.dataset.path || '');
    else if (event.key === 'ArrowLeft') {
      if (target.getAttribute('aria-expanded') === 'true') void this.toggleDirectory(target.dataset.path || '');
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
  private filesView() {
    const file = this.artifact;
    const hasAlternateView = !!file && !file.binary && !file.tooLarge && (file.kind === 'markdown' || /\.(csv|tsv|html?|svg)$/i.test(file.name));
    const projectName = (this.projectPath || this.listing?.root || 'Project').split('/').filter(Boolean).pop() || 'Project';
    const segments = this.selected.split('/').filter(Boolean);
    const tree = this.treeRows('.');
    return html`<section class="files-panel split-panel ${this.filesRailOpen ? '' : 'rail-closed'}" style=${`--rail-width:${this.railWidths.files}px`} @keydown=${(event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); this.showQuickOpen(); }
      if (event.key === 'Escape' && this.quickOpen) this.hideQuickOpen();
    }}>
      ${this.filesRailOpen ? html`<div class="browser">
        <div class="browser-heading"><div class="explorer-label">EXPLORER</div><div class="explorer-actions"><button class="icon-button" aria-label="Quick open file" title="Quick Open · Ctrl+P" @click=${() => this.showQuickOpen()}>${icon(Search,{size:15})}</button><button class="icon-button" aria-label="Refresh file tree" title="Refresh file tree" @click=${() => void this.refreshTree()}>${icon(RefreshCw,{size:15})}</button><button class="icon-button" aria-label="Collapse folders" title="Collapse folders" @click=${() => { this.expandedDirs = new Set(['.']); this.paintAll(); }}>${icon(ChevronsDownUp,{size:15})}</button></div></div>
        <button class="project-heading" @click=${() => { if (this.expandedDirs.has('.')) this.expandedDirs.delete('.'); else this.expandedDirs.add('.'); this.paintAll(); }} aria-expanded=${String(this.expandedDirs.has('.'))}>${icon(this.expandedDirs.has('.') ? ChevronDown : ChevronRight,{size:14})}<span>${projectName}</span></button>
        <div class="project-path" title=${this.listing?.root || this.projectPath}>${this.listing?.root || this.projectPath}</div>
        <div class="browser-tools"><span class="search-symbol">${icon(Search,{size:14})}</span><input type="search" aria-label="Filter visible files" placeholder="Filter visible files" .value=${this.fileQuery} @input=${(event: InputEvent) => { this.fileQuery = (event.target as HTMLInputElement).value; this.paintAll(); }}><select aria-label="Sort files" .value=${this.fileSort} @change=${(event: Event) => { this.fileSort = (event.target as HTMLSelectElement).value as typeof this.fileSort; this.paintAll(); }}><option value="name">Name</option><option value="recent">Recent</option><option value="size">Size</option></select></div>
        <div class="file-list" role="tree" aria-label="Project files" @keydown=${(event: KeyboardEvent) => this.onTreeKey(event)}>${this.expandedDirs.has('.') ? tree : nothing}${this.error ? html`<p class="empty">${this.error}</p>` : nothing}${this.listing && !tree.length ? html`<p class="empty">${this.fileQuery ? 'No files match this filter.' : 'This folder is empty.'}</p>` : nothing}${[...this.directoryCache.values()].some(item => item.truncated) ? html`<p class="empty">Some folders show only their first 500 entries.</p>` : nothing}</div>
        ${this.touched.length ? html`<div class="touched-files"><h3>FROM THIS CHAT <span>${this.touched.length}</span></h3>${this.touched.map(path => html`<button class="touched-entry" title=${path} @click=${() => void this.revealFile(path)}>${icon(fileGlyph(path),{size:14})}<span>${path}</span></button>`)}</div>` : nothing}
      </div>` : nothing}
      ${this.filesRailOpen ? html`<div class="vertical-resizer" role="separator" aria-label="Resize file explorer" aria-orientation="vertical" tabindex="0" @pointerdown=${(event: PointerEvent) => this.startRailResize(event,'files')} @pointermove=${(event: PointerEvent) => this.moveRailResize(event)} @pointerup=${(event: PointerEvent) => this.endRailResize(event)} @lostpointercapture=${(event: PointerEvent) => this.endRailResize(event)} @keydown=${(event: KeyboardEvent) => this.keyRailResize(event,'files')}></div>` : nothing}
      <div class="viewer">
        <div class="single-file-bar"><button class="rail-toggle" aria-label=${this.filesRailOpen ? 'Hide file browser' : 'Show file browser'} title=${this.filesRailOpen ? 'Hide file browser' : 'Show file browser'} @click=${() => { this.filesRailOpen = !this.filesRailOpen; this.paintAll(); }}>${icon(this.filesRailOpen ? ChevronRight : Folder,{size:15})}</button>${this.selected ? html`${icon(fileGlyph(this.selected),{size:15})}<strong title=${this.selected}>${this.selected.split('/').pop()}</strong><button class="icon-button" aria-label="Close file" title="Close file" @click=${() => this.closeTab(this.currentTab.id)}>${icon(X,{size:14})}</button>` : html`<span class="single-file-empty">No file open</span>`}</div>
        <div class="viewer-header"><nav class="viewer-path" aria-label="Open file path">${segments.length ? html`<button @click=${() => void this.loadDirectory('.')}>${projectName}</button>${segments.map((part,index) => html`<span>›</span>${index < segments.length-1 ? html`<button @click=${() => void this.loadDirectory(segments.slice(0,index+1).join('/'))}>${part}</button>` : html`<strong>${part}</strong>`}`)}` : html`<span>Open a file to preview it</span>`}</nav><button class="icon-button" aria-label="Refresh open file" title="Refresh open file" ?disabled=${!this.selected} @click=${() => void this.openFile(this.selected, true)}>${icon(RefreshCw,{size:15})}</button><button class="icon-button" aria-label=${this.focused ? 'Show chat beside files' : 'Focus file viewer'} title=${this.focused ? 'Show chat beside files' : 'Focus file viewer'} @click=${() => this.dispatchEvent(new CustomEvent('sdk-file-focus',{bubbles:true,composed:true}))}>${icon(this.focused ? Minimize2 : Maximize2,{size:15})}</button></div>
        ${file ? html`<div class="viewer-actions">${hasAlternateView ? html`<div class="view-switch"><button class=${this.fileMode === 'preview' ? 'active' : ''} @click=${() => this.setFileMode('preview')}>Preview</button><button class=${this.fileMode === 'source' ? 'active' : ''} @click=${() => this.setFileMode('source')}>Source</button></div>` : html`<span class="mode-label">${file.kind === 'image' || file.name.endsWith('.pdf') ? 'Preview' : 'Source'}</span>`}<span class="action-spacer"></span><button @click=${() => this.askAboutFile()}>Ask about file</button><a href=${this.endpoint('raw', this.selected)} download=${file.name}>Download</a></div>` : nothing}
        <div class="viewer-body">${this.selected ? this.fileBody() : html`<div class="welcome-file">${icon(FolderOpen,{size:35})}<h2>Explore this project</h2><p>Choose a file from the explorer or search by name across the project.</p><button @click=${() => this.showQuickOpen()}>${icon(Search,{size:15})} Quick Open <kbd>Ctrl P</kbd></button></div>`}</div>
        ${file ? html`<div class="file-status"><span>${fileLanguage(file.name)}</span>${!file.binary && !file.tooLarge && file.text ? html`<span>${file.text.split('\n').length} lines</span>` : nothing}<span class="status-spacer"></span><span>${readableSize(file.size)}</span><span>Read only</span></div>` : nothing}
      </div>
      ${this.quickOpen ? html`<div class="quick-overlay" @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.hideQuickOpen(); }}><div class="quick-open" role="dialog" aria-label="Quick Open"><div class="quick-input">${icon(Search,{size:18})}<input type="search" aria-label="Search project files" placeholder="Search files by name…" .value=${this.quickQuery} @input=${(event: InputEvent) => this.searchQuickOpen((event.target as HTMLInputElement).value)} @keydown=${(event: KeyboardEvent) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); this.quickIndex = Math.max(0,Math.min(this.quickResults.length-1,this.quickIndex+(event.key === 'ArrowDown' ? 1 : -1))); this.paintAll(); } else if (event.key === 'Enter' && this.quickResults[this.quickIndex]) { event.preventDefault(); void this.revealFile(this.quickResults[this.quickIndex].path); } }}><kbd>ESC</kbd></div><div class="quick-results">${this.quickLoading ? html`<p>Searching project…</p>` : this.quickError ? html`<p>${this.quickError}</p>` : this.quickResults.length ? this.quickResults.map((result,index) => html`<button class=${index === this.quickIndex ? 'active' : ''} @mouseenter=${() => { this.quickIndex = index; }} @click=${() => void this.revealFile(result.path)}>${icon(fileGlyph(result.name),{size:16})}<span><strong>${result.name}</strong><small>${result.path}</small></span><em>${readableSize(result.size)}</em></button>`) : html`<p>${this.quickQuery.trim().length < 2 ? 'Type at least two characters to search the project.' : 'No matching files.'}</p>`}${this.quickTruncated && !this.quickLoading ? html`<p>Showing the first matches. Narrow your search for more.</p>` : nothing}</div></div></div>` : nothing}
    </section>`;
  }
  private changesView(): TemplateResult {
    const changes = this.changes;
    const detail = this.changeDetail;
    return html`<section class="changes-panel split-panel" style=${`--rail-width:${this.railWidths.changes}px`}><div class="changes-list"><header><div><strong>CHANGES</strong><span>${changes?.changes.length ?? 0}</span></div><button class="icon-button" aria-label="Refresh changes" title="Refresh changes" @click=${() => void this.loadChanges()}>${icon(RefreshCw,{size:15})}</button></header>
      ${this.changesError ? html`<p class="empty">${this.changesError}</p>` : !changes ? html`<p class="empty">Loading Git changes…</p>` : changes.repos.length ? changes.repos.map(repo => html`<div class="change-repo"><div class="change-repo-title"><strong>${repo.name}</strong><span>${repo.branch || 'detached HEAD'}</span></div>${changes.changes.filter(change => change.repo === repo.root).length ? changes.changes.filter(change => change.repo === repo.root).map(change => html`<button class="change-row ${this.selectedChange?.repo === change.repo && this.selectedChange?.path === change.path ? 'selected' : ''}" title=${change.path} @click=${() => void this.openChange(change)}>${icon(fileGlyph(change.path),{size:15})}<span>${change.path}</span><em>${change.status.trim() || 'M'}</em></button>`) : html`<p class="empty">No changes</p>`}</div>`) : html`<p class="empty">No Git repository in this chat’s project folders.</p>`}
      ${changes?.truncated ? html`<p class="empty">Showing the first changes. Refresh after narrowing the project.</p>` : nothing}
    </div><div class="vertical-resizer" role="separator" aria-label="Resize changes list" aria-orientation="vertical" tabindex="0" @pointerdown=${(event: PointerEvent) => this.startRailResize(event,'changes')} @pointermove=${(event: PointerEvent) => this.moveRailResize(event)} @pointerup=${(event: PointerEvent) => this.endRailResize(event)} @lostpointercapture=${(event: PointerEvent) => this.endRailResize(event)} @keydown=${(event: KeyboardEvent) => this.keyRailResize(event,'changes')}></div><div class="change-viewer"><header><span>${this.selectedChange?.path || 'Select a changed file'}</span>${this.selectedChange ? html`<small>${this.selectedChange.status.trim() || 'Modified'}</small>` : nothing}</header>${!this.selectedChange ? html`<div class="change-empty">${icon(GitCompare,{size:34})}<h2>Review project changes</h2><p>Select a file to compare it with HEAD.</p></div>` : !detail ? html`<div class="change-empty">Loading diff…</div>` : detail.tooLarge ? html`<div class="change-empty">This file is too large for the diff viewer.</div>` : detail.binary ? html`<div class="change-empty">Binary changes cannot be shown as text.</div>` : html`<mux-monaco-diff .repo=${detail.repo} .path=${detail.path} .originalText=${detail.before} .modifiedText=${detail.after}></mux-monaco-diff>`}</div></section>`;
  }
  private terminalView(tab: UtilityTab): TemplateResult {
    const active = !!this.terminalWorkspaceId && store.attached === this.terminalWorkspaceId;
    const paneExists = active && store.panes.some(pane => pane.paneId === tab.paneId);
    return html`<section class="terminal-panel"><div class="terminal-content">${paneExists ? html`<mux-chat-terminal .paneId=${tab.paneId!}></mux-chat-terminal>` : html`<div class="terminal-empty">${active ? 'Opening terminal pane…' : this.terminalWorkspaceId ? 'Opening this chat’s terminal…' : 'Creating this chat’s terminal…'}<button @click=${() => this.requestChatTerminal()}>Retry</button></div>`}</div></section>`;
  }
  private requestChatTerminal(force = false) {
    if (!this.sessionId || !this.projectPath) return;
    this.dispatchEvent(new CustomEvent('chat-terminal-open',{detail:{chatId:this.sessionId,title:this.chatTitle,projectPath:this.projectPath,workspaceId:this.terminalWorkspaceId,force},bubbles:true,composed:true}));
    this.scheduleTerminalRetry();
  }
  private scheduleTerminalRetry() {
    if (this.activeTab !== 'terminal') return;
    if (this.terminalWorkspaceId && store.attached === this.terminalWorkspaceId && store.panes.some(pane => pane.paneId >= 0)) {
      if (this.terminalRetryTimer) window.clearTimeout(this.terminalRetryTimer);
      this.terminalRetryTimer = undefined;
      this.terminalRetryCount = 0;
      return;
    }
    if (this.terminalRetryTimer) return;
    if (this.terminalRetryCount >= 3) return;
    this.terminalRetryTimer = window.setTimeout(() => {
      this.terminalRetryTimer = undefined;
      this.terminalRetryCount++;
      if (this.isConnected && this.activeTab === 'terminal') this.requestChatTerminal(true);
    }, 2500);
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
  private deletePage(page: NotePage) {
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
    if (!window.confirm(message)) return;
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
      rows.push(html`<button class="page-list-item ${page.id === this.pageId ? 'selected' : ''}" style=${`--page-depth:${depth}`} title=${page.title || 'Untitled'} @click=${() => this.selectPage(page.id)}><span class="page-list-glyph">${icon(NotebookPen,{size:15})}</span><span class="page-list-name">${page.title || 'Untitled'}</span></button>`);
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
    if (this.activeTab === 'terminal') {
      const previousPane = this.currentTab.paneId;
      this.assignTerminalPane();
      if (this.currentTab.paneId !== previousPane) this.paintAll();
      this.requestChatTerminal();
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
      <div class="page-editor"><div class="page-toolbar"><div><button aria-label=${this.pagesRailOpen ? 'Hide pages list' : 'Show pages list'} title=${this.pagesRailOpen ? 'Hide pages list' : 'Show pages list'} @click=${() => { this.pagesRailOpen = !this.pagesRailOpen; this.paintAll(); }}>${icon(NotebookPen,{size:15})}</button>${parent ? html`<button class="page-parent" @click=${() => this.selectPage(parent.id)}>${parent.title}</button><span>›</span>` : nothing}<span>${page?.title || 'Pages'}</span></div><div class="page-toolbar-actions"><span>${this.pageSaving ? 'Saving…' : 'Saved'}</span>${page ? html`<button class="page-delete" aria-label=${`Delete page ${page.title || 'Untitled'}`} title=${this.pagesConflict ? 'Reload pages before deleting' : 'Delete page'} ?disabled=${this.pagesConflict} @click=${() => this.deletePage(page)}>${icon(Trash2,{size:15})}</button>` : nothing}</div></div>
      ${page ? html`<div class="page-canvas"><div class="page-paper"><textarea class="page-title" aria-label="Page title" placeholder="Untitled" rows="1" .value=${page.title} @input=${(event: InputEvent) => { page.title = (event.target as HTMLTextAreaElement).value; this.growPageField(event); this.schedulePageSave(); }}></textarea><mux-blocknote-page .content=${page.content?.length ? page.content : legacyPageContent(page.blocks)} .pageId=${page.id} .documentEpoch=${this.pagesRenderEpoch} @click=${(event: MouseEvent) => this.openPageLink(event)} @page-content-change=${(event: CustomEvent<PartialBlock[]>) => { page.content = event.detail; this.schedulePageSave(); }} @page-command=${(event: CustomEvent<'page' | 'generate' | 'visualize'>) => this.pageCommand(page,event.detail)}></mux-blocknote-page><button class="page-subpage" @click=${() => this.newPage(page.id)}>＋ New subpage</button></div></div>` : html`<div class="page-no-selection">${icon(NotebookPen,{size:32})}<h2>Pages</h2><p>Create a document for this chat.</p><button @click=${() => this.newPage()}>New page</button></div>`}</div>
    </section>`;
  }
  private surfaceCSS = `
    mux-sdk-utility { display:flex; flex-direction:column; min-width:0; height:100%; background:var(--chrome-bar); color:var(--chrome-text-bright); font:13px/1.5 system-ui,sans-serif; }
    mux-sdk-utility * { scrollbar-width:thin; scrollbar-color:color-mix(in srgb,var(--chrome-text-dim,#9aa3b8) 34%,transparent) transparent; }
    mux-sdk-utility *::-webkit-scrollbar { width:6px; height:6px; }
    mux-sdk-utility *::-webkit-scrollbar-track { background:transparent; }
    mux-sdk-utility *::-webkit-scrollbar-thumb { background:color-mix(in srgb,var(--chrome-text-dim,#9aa3b8) 34%,transparent); border-radius:999px; }
    mux-sdk-utility *::-webkit-scrollbar-thumb:hover { background:color-mix(in srgb,var(--chrome-text-dim,#9aa3b8) 58%,transparent); }
    mux-sdk-utility .utility-tabs { display:flex; align-items:center; flex:none; gap:4px; min-height:38px; box-sizing:border-box; padding:4px 8px; border-bottom:1px solid var(--chrome-border); background:color-mix(in srgb,var(--chrome-bar) 84%,var(--chrome-body)); overflow-x:auto; }
    mux-sdk-utility .utility-tab { display:flex; align-items:center; flex:0 1 210px; min-width:120px; height:29px; border:1px solid transparent; border-radius:8px; color:var(--chrome-text-dim); }
    mux-sdk-utility .utility-tab:not(:first-child):not(.active) { border-left-color:var(--chrome-border); border-radius:0; }
    mux-sdk-utility .utility-tab:hover { background:var(--chrome-hover); color:var(--chrome-text-bright); }
    mux-sdk-utility .utility-tab.active { border-color:var(--chrome-border); background:var(--chrome-body); color:var(--chrome-text-bright); box-shadow:0 1px 4px #0001; }
    mux-sdk-utility .utility-tab button { display:flex; align-items:center; justify-content:flex-start; gap:7px; min-width:0; height:100%; border:0; background:transparent; color:inherit; cursor:pointer; }
    mux-sdk-utility .utility-tab [role=tab] { flex:1; padding:0 5px 0 10px; font:500 11px system-ui,sans-serif; }
    mux-sdk-utility .utility-tab [role=tab] svg { flex:none; }
    mux-sdk-utility .utility-tab [role=tab] span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .utility-tab .tab-close { flex:none; width:23px; justify-content:center; opacity:0; }
    mux-sdk-utility .utility-tab:hover .tab-close, mux-sdk-utility .utility-tab.active .tab-close { opacity:.7; }
    mux-sdk-utility .tab-add { display:flex; align-items:center; justify-content:center; flex:none; width:27px; height:27px; border:0; border-radius:7px; background:transparent; color:var(--chrome-text-dim); cursor:pointer; }
    mux-sdk-utility .tab-add:hover { background:var(--chrome-hover); color:var(--chrome-text-bright); }
    mux-sdk-utility .new-tab-surface { box-sizing:border-box; width:100%; height:100%; padding:28px 0; background:var(--chrome-body); }
    mux-sdk-utility .new-tab-home { width:min(680px,calc(100% - 44px)); margin:0 auto; }
    mux-sdk-utility .new-tab-home h2 { margin:0 0 12px; color:var(--chrome-text-dim); font:600 11px system-ui,sans-serif; }
    mux-sdk-utility .new-tab-tools { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }
    mux-sdk-utility .new-tab-tools button { display:flex; align-items:center; gap:10px; min-width:0; height:37px; padding:0 12px; border:1px solid var(--chrome-border); border-radius:9px; background:var(--chrome-bar); color:var(--chrome-text-bright); text-align:left; font:500 11px system-ui,sans-serif; cursor:pointer; }
    mux-sdk-utility .new-tab-tools button:hover { border-color:var(--chrome-accent); }
    mux-sdk-utility .utility-body { flex:1; min-height:0; min-width:0; overflow:hidden; container-type:inline-size; }
    mux-sdk-utility .utility-placeholder { display:flex; align-items:center; justify-content:center; width:100%; height:100%; color:var(--chrome-text-dim); }
    mux-sdk-utility .empty { color:var(--chrome-text-dim); line-height:1.6; } mux-sdk-utility a { color:var(--chrome-accent); }
    mux-sdk-utility .files-panel, mux-sdk-utility .changes-panel, mux-sdk-utility .pages-panel { display:grid; grid-template-columns:clamp(180px,var(--rail-width),45%) 6px minmax(0,1fr); height:100%; min-width:0; overflow:hidden; position:relative; background:var(--chrome-body); }
    mux-sdk-utility .files-panel.rail-closed { grid-template-columns:minmax(0,1fr); }
    mux-sdk-utility .browser { display:flex; flex-direction:column; min-width:0; min-height:0; background:color-mix(in srgb,var(--chrome-body) 78%,var(--chrome-bar)); }
    mux-sdk-utility .browser-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; height:34px; padding:0 9px 0 16px; }
    mux-sdk-utility .explorer-label { color:var(--chrome-text-dim); font:600 10px system-ui,sans-serif; letter-spacing:.13em; }
    mux-sdk-utility .explorer-actions { display:flex; align-items:center; gap:2px; }
    mux-sdk-utility .icon-button, mux-sdk-utility .rail-toggle { display:inline-flex; align-items:center; justify-content:center; flex:none; width:28px; height:26px; padding:0; border:0; border-radius:4px; background:transparent; color:var(--chrome-text-dim); cursor:pointer; }
    mux-sdk-utility .icon-button:hover, mux-sdk-utility .rail-toggle:hover { color:var(--chrome-text-bright); background:var(--chrome-hover); }
    mux-sdk-utility .icon-button:disabled { opacity:.4; cursor:default; }
    mux-sdk-utility .project-heading { display:flex; align-items:center; gap:3px; width:100%; min-height:28px; padding:0 11px; border:0; background:color-mix(in srgb,var(--chrome-body) 67%,var(--chrome-bar)); color:var(--chrome-text-bright); text-align:left; font:650 11px system-ui,sans-serif; text-transform:uppercase; letter-spacing:.025em; cursor:pointer; }
    mux-sdk-utility .project-heading span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .project-path { padding:4px 13px 8px 28px; color:var(--chrome-text-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:10px ui-monospace,monospace; }
    mux-sdk-utility .browser-tools { display:flex; align-items:center; gap:4px; margin:0 9px 7px; border:1px solid var(--chrome-border); border-radius:5px; background:var(--chrome-body); color:var(--chrome-text-dim); }
    mux-sdk-utility .search-symbol { display:flex; margin-left:7px; }
    mux-sdk-utility .browser-tools input { flex:1; min-width:0; height:25px; padding:0 2px; border:0; outline:0; background:transparent; color:var(--chrome-text-bright); font:11px system-ui,sans-serif; }
    mux-sdk-utility .browser-tools select { width:55px; min-width:0; height:25px; padding:0 2px; border:0; border-left:1px solid var(--chrome-border); background:transparent; color:var(--chrome-text-dim); font:10px system-ui,sans-serif; }
    mux-sdk-utility .file-list { flex:1; min-height:0; overflow:auto; padding:2px 0 10px; }
    mux-sdk-utility .file-entry { display:flex; align-items:center; gap:5px; width:100%; min-height:24px; border:0; padding:0 11px 0 calc(8px + var(--depth)*14px); background:transparent; color:var(--chrome-text-bright); text-align:left; font:11px system-ui,sans-serif; cursor:pointer; }
    mux-sdk-utility .file-entry:hover { background:var(--chrome-hover); }
    mux-sdk-utility .file-entry.selected { background:color-mix(in srgb,var(--chrome-accent) 17%,var(--chrome-hover)); box-shadow:inset 2px 0 var(--chrome-accent); }
    mux-sdk-utility .tree-chevron, mux-sdk-utility .file-glyph { display:flex; align-items:center; justify-content:center; flex:none; width:14px; color:var(--chrome-text-dim); }
    mux-sdk-utility .file-glyph { width:17px; color:var(--chrome-accent); }
    mux-sdk-utility .directory .file-glyph { color:color-mix(in srgb,var(--chrome-accent) 65%,#f5c566); }
    mux-sdk-utility .file-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .file-size { color:var(--chrome-text-dim); font:9px ui-monospace,monospace; white-space:nowrap; }
    mux-sdk-utility .touched-files { max-height:25%; min-height:50px; overflow:auto; border-top:1px solid var(--chrome-border); padding:8px 0; }
    mux-sdk-utility .touched-files h3 { display:flex; justify-content:space-between; margin:0 12px 6px; font-size:10px; color:var(--chrome-text-dim); letter-spacing:.09em; }
    mux-sdk-utility .touched-entry { display:flex; align-items:center; gap:7px; width:100%; overflow:hidden; text-align:left; padding:5px 13px; border:0; color:var(--chrome-text-bright); background:transparent; font:10px ui-monospace,monospace; cursor:pointer; }
    mux-sdk-utility .touched-entry:hover { background:var(--chrome-hover); }
    mux-sdk-utility .touched-entry svg { flex:none; color:var(--chrome-accent); }
    mux-sdk-utility .touched-entry span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .file-list .empty { margin:12px 15px; color:var(--chrome-text-dim); font:11px/1.5 system-ui,sans-serif; }
    mux-sdk-utility .viewer { display:flex; flex-direction:column; min-width:0; min-height:0; background:var(--chrome-body); }
    mux-sdk-utility .single-file-bar { display:flex; align-items:center; gap:8px; flex:none; min-height:34px; border-bottom:1px solid var(--chrome-border); background:var(--chrome-bar); }
    mux-sdk-utility .single-file-bar > svg { flex:none; color:var(--chrome-accent); }
    mux-sdk-utility .single-file-bar strong { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:600 11px system-ui,sans-serif; }
    mux-sdk-utility .single-file-bar .icon-button { margin-right:5px; }
    mux-sdk-utility .single-file-empty { color:var(--chrome-text-dim); font:11px system-ui,sans-serif; }
    mux-sdk-utility .rail-toggle { height:33px; width:35px; border-radius:0; border-right:1px solid var(--chrome-border); }
    mux-sdk-utility .viewer-header { display:flex; align-items:center; gap:4px; min-height:31px; box-sizing:border-box; border-bottom:1px solid var(--chrome-border); padding:2px 7px 2px 13px; }
    mux-sdk-utility .viewer-path { display:flex; align-items:center; gap:5px; flex:1; min-width:0; overflow:hidden; white-space:nowrap; color:var(--chrome-text-dim); font:10px system-ui,sans-serif; }
    mux-sdk-utility .viewer-path button { border:0; padding:0; background:transparent; color:var(--chrome-text-dim); cursor:pointer; }
    mux-sdk-utility .viewer-path button:hover { color:var(--chrome-accent); }
    mux-sdk-utility .viewer-path strong { overflow:hidden; text-overflow:ellipsis; color:var(--chrome-text-bright); font-weight:500; }
    mux-sdk-utility .viewer-actions { display:flex; align-items:center; gap:6px; min-height:35px; box-sizing:border-box; border-bottom:1px solid var(--chrome-border); padding:3px 10px; }
    mux-sdk-utility .viewer-actions button, mux-sdk-utility .viewer-actions a, mux-sdk-utility .sandbox-note button { border:1px solid var(--chrome-border); border-radius:4px; background:var(--chrome-bar); color:var(--chrome-text-bright); padding:4px 7px; text-decoration:none; font:10px system-ui,sans-serif; white-space:nowrap; cursor:pointer; }
    mux-sdk-utility .viewer-actions button:hover, mux-sdk-utility .viewer-actions a:hover, mux-sdk-utility .sandbox-note button:hover { background:var(--chrome-hover); }
    mux-sdk-utility .view-switch { display:flex; } mux-sdk-utility .view-switch button { border-radius:0; } mux-sdk-utility .view-switch button:first-child { border-radius:4px 0 0 4px; } mux-sdk-utility .view-switch button:last-child { border-radius:0 4px 4px 0; border-left:0; }
    mux-sdk-utility .view-switch button.active { color:var(--chrome-accent); background:var(--chrome-hover); }
    mux-sdk-utility .mode-label { color:var(--chrome-text-dim); font:10px system-ui,sans-serif; }
    mux-sdk-utility .action-spacer, mux-sdk-utility .status-spacer { flex:1; }
    mux-sdk-utility .viewer-body { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; }
    mux-sdk-utility .file-empty { margin:auto; padding:20px; max-width:340px; text-align:center; color:var(--chrome-text-dim); }
    mux-sdk-utility mux-monaco-source { display:block; flex:1; min-height:0; min-width:0; }
    mux-sdk-utility mux-monaco-source .monaco-host { width:100%; height:100%; }
    mux-sdk-utility .file-status { display:flex; align-items:center; gap:15px; flex:none; min-height:22px; padding:0 10px; border-top:1px solid var(--chrome-border); background:var(--chrome-bar); color:var(--chrome-text-dim); font:10px system-ui,sans-serif; }
    mux-sdk-utility .file-status span:first-child { color:var(--chrome-accent); }
    mux-sdk-utility .welcome-file { display:flex; flex:1; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:25px; color:var(--chrome-text-dim); text-align:center; }
    mux-sdk-utility .welcome-file svg { color:var(--chrome-accent); }
    mux-sdk-utility .welcome-file h2 { margin:3px 0 0; color:var(--chrome-text-bright); font-size:17px; }
    mux-sdk-utility .welcome-file p { max-width:290px; margin:0; font:12px/1.5 system-ui,sans-serif; }
    mux-sdk-utility .welcome-file button { display:flex; align-items:center; gap:8px; margin-top:6px; padding:7px 10px; border:1px solid var(--chrome-border); border-radius:5px; background:var(--chrome-bar); color:var(--chrome-text-bright); font:11px system-ui,sans-serif; cursor:pointer; }
    mux-sdk-utility kbd { border:1px solid var(--chrome-border); border-radius:3px; padding:1px 4px; color:var(--chrome-text-dim); font:10px ui-monospace,monospace; }
    mux-sdk-utility .quick-overlay { position:absolute; inset:0; z-index:20; display:flex; justify-content:center; align-items:flex-start; padding:36px 15px; background:color-mix(in srgb,#000 38%,transparent); }
    mux-sdk-utility .quick-open { width:min(560px,100%); max-height:min(480px,75%); display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--chrome-border); border-radius:8px; background:var(--chrome-body); box-shadow:0 15px 45px #0005; }
    mux-sdk-utility .quick-input { display:flex; align-items:center; gap:10px; padding:10px 12px; border-bottom:1px solid var(--chrome-border); color:var(--chrome-accent); }
    mux-sdk-utility .quick-input input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--chrome-text-bright); font:14px system-ui,sans-serif; }
    mux-sdk-utility .quick-results { overflow:auto; padding:5px; }
    mux-sdk-utility .quick-results p { margin:14px; color:var(--chrome-text-dim); font:11px system-ui,sans-serif; }
    mux-sdk-utility .quick-results button { display:flex; align-items:center; gap:9px; width:100%; padding:7px 9px; border:0; border-radius:5px; background:transparent; color:var(--chrome-text-bright); text-align:left; cursor:pointer; }
    mux-sdk-utility .quick-results button:hover, mux-sdk-utility .quick-results button.active { background:var(--chrome-hover); }
    mux-sdk-utility .quick-results button > svg { flex:none; color:var(--chrome-accent); }
    mux-sdk-utility .quick-results button span { display:flex; flex:1; flex-direction:column; gap:2px; min-width:0; }
    mux-sdk-utility .quick-results button strong, mux-sdk-utility .quick-results button small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .quick-results button strong { font:12px system-ui,sans-serif; }
    mux-sdk-utility .quick-results button small, mux-sdk-utility .quick-results button em { color:var(--chrome-text-dim); font:10px ui-monospace,monospace; }
    mux-sdk-utility .document-view { box-sizing:border-box; width:100%; max-width:840px; margin:0 auto; padding:clamp(22px,4vw,48px) clamp(20px,5vw,56px) 64px; color:var(--chrome-text-bright); font:14px/1.72 system-ui,sans-serif; overflow-wrap:break-word; }
    mux-sdk-utility .document-view > :first-child { margin-top:0; }
    mux-sdk-utility .document-view > :last-child { margin-bottom:0; }
    mux-sdk-utility .document-view .md-p { margin:0 0 1.15em; }
    mux-sdk-utility .document-view .md-h { margin:1.75em 0 .55em; color:var(--chrome-text-bright); font-weight:700; line-height:1.3; overflow-wrap:break-word; }
    mux-sdk-utility .document-view h1.md-h { margin-top:0; padding-bottom:.35em; border-bottom:1px solid var(--chrome-border); font-size:2em; letter-spacing:-.025em; }
    mux-sdk-utility .document-view h2.md-h { padding-bottom:.28em; border-bottom:1px solid var(--chrome-border); font-size:1.5em; letter-spacing:-.015em; }
    mux-sdk-utility .document-view h3.md-h { font-size:1.25em; }
    mux-sdk-utility .document-view h4.md-h { font-size:1.08em; }
    mux-sdk-utility .document-view h5.md-h, mux-sdk-utility .document-view h6.md-h { font-size:1em; }
    mux-sdk-utility .document-view strong { font-weight:700; }
    mux-sdk-utility .document-view .md-link { color:var(--chrome-accent); text-decoration:underline; text-underline-offset:3px; }
    mux-sdk-utility .document-view .md-link:hover { color:var(--chrome-text-bright); }
    mux-sdk-utility .document-view .md-code { padding:.13em .35em; border:1px solid var(--chrome-border); border-radius:4px; background:var(--chrome-bar); font:.9em/1.45 ui-monospace,monospace; }
    mux-sdk-utility .document-view .md-pre { box-sizing:border-box; max-width:100%; margin:0 0 1.4em; padding:15px 18px; overflow:auto; border:1px solid var(--chrome-border); border-radius:8px; background:var(--chrome-bar); }
    mux-sdk-utility .document-view .md-pre[data-lang]:not([data-lang=""])::before { content:attr(data-lang); display:block; margin:0 0 9px; color:var(--chrome-text-dim); font:10px/1.4 system-ui,sans-serif; text-transform:uppercase; letter-spacing:.07em; }
    mux-sdk-utility .document-view .md-pre code { font:12.5px/1.6 ui-monospace,monospace; white-space:pre; }
    mux-sdk-utility .document-view .md-ul, mux-sdk-utility .document-view .md-ol { margin:0 0 1.2em; padding-left:1.8em; }
    mux-sdk-utility .document-view .md-li { padding-left:.2em; margin:.3em 0; }
    mux-sdk-utility .document-view .md-li .md-p { margin:0; }
    mux-sdk-utility .document-view .md-li > .md-ul, mux-sdk-utility .document-view .md-li > .md-ol { margin:.35em 0 .5em; }
    mux-sdk-utility .document-view .md-quote { margin:0 0 1.3em; padding:.15em 0 .15em 1.15em; border-left:3px solid var(--chrome-accent); color:var(--chrome-text-dim); }
    mux-sdk-utility .document-view .md-quote > :last-child { margin-bottom:0; }
    mux-sdk-utility .document-view .md-hr { margin:2em 0; border:0; border-top:1px solid var(--chrome-border); }
    mux-sdk-utility .document-view .md-tablewrap { max-width:100%; overflow-x:auto; margin:0 0 1.5em; border:1px solid var(--chrome-border); border-radius:8px; }
    mux-sdk-utility .document-view .md-table { width:100%; border-collapse:collapse; font-size:13px; line-height:1.5; }
    mux-sdk-utility .document-view .md-th, mux-sdk-utility .document-view .md-td { padding:9px 12px; border-bottom:1px solid var(--chrome-border); text-align:left; vertical-align:top; overflow-wrap:normal; }
    mux-sdk-utility .document-view .md-th + .md-th, mux-sdk-utility .document-view .md-td + .md-td { border-left:1px solid var(--chrome-border); }
    mux-sdk-utility .document-view .md-table tr:last-child .md-td { border-bottom:0; }
    mux-sdk-utility .document-view .md-th { background:var(--chrome-bar); font-weight:650; white-space:nowrap; }
    mux-sdk-utility .document-view .md-img { display:block; max-width:100%; height:auto; margin:0 0 1.3em; border-radius:7px; }
    mux-sdk-utility .image-view { display:flex; justify-content:center; align-items:flex-start; padding:18px; }
    mux-sdk-utility .image-view img { max-width:100%; max-height:calc(100vh - 200px); object-fit:contain; }
    mux-sdk-utility .table-view { flex:1; overflow:auto; padding:12px; } mux-sdk-utility .table-view table { border-collapse:collapse; font:11px/1.5 system-ui,sans-serif; }
    mux-sdk-utility .table-view th, mux-sdk-utility .table-view td { border:1px solid var(--chrome-border); padding:5px 9px; max-width:320px; min-width:65px; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
    mux-sdk-utility .table-view th { position:sticky; top:0; background:var(--chrome-bar); font-weight:650; }
    mux-sdk-utility .sandbox-note { display:flex; align-items:center; gap:8px; padding:8px 13px; border-bottom:1px solid var(--chrome-border); color:var(--chrome-text-dim); font-size:11px; }
    mux-sdk-utility .document-frame { display:block; box-sizing:border-box; flex:1; width:100%; min-height:300px; border:0; background:#fff; }
    mux-sdk-utility mux-sdk-pdf-preview { display:block; flex:1; min-height:0; }
    mux-sdk-utility .vertical-resizer { position:relative; cursor:col-resize; background:var(--chrome-border); touch-action:none; }
    mux-sdk-utility .vertical-resizer:hover, mux-sdk-utility .vertical-resizer:focus-visible { background:var(--chrome-accent); outline:0; }
    mux-sdk-utility .changes-list { min-width:0; min-height:0; overflow:auto; background:color-mix(in srgb,var(--chrome-body) 78%,var(--chrome-bar)); }
    mux-sdk-utility .changes-list > header { display:flex; justify-content:space-between; align-items:center; height:38px; padding:0 9px 0 14px; border-bottom:1px solid var(--chrome-border); color:var(--chrome-text-dim); font:600 10px system-ui,sans-serif; letter-spacing:.1em; }
    mux-sdk-utility .changes-list > header div { display:flex; align-items:center; gap:8px; }
    mux-sdk-utility .changes-list > header span { border-radius:10px; padding:1px 5px; background:var(--chrome-hover); }
    mux-sdk-utility .change-repo-title { display:flex; flex-direction:column; gap:2px; padding:11px 13px 7px; color:var(--chrome-text-bright); font:11px system-ui,sans-serif; }
    mux-sdk-utility .change-repo-title span { color:var(--chrome-text-dim); font:10px ui-monospace,monospace; }
    mux-sdk-utility .change-row { display:flex; align-items:center; gap:7px; width:100%; min-height:27px; padding:3px 10px 3px 15px; border:0; background:transparent; color:var(--chrome-text-bright); text-align:left; font:11px system-ui,sans-serif; cursor:pointer; }
    mux-sdk-utility .change-row:hover, mux-sdk-utility .change-row.selected { background:var(--chrome-hover); }
    mux-sdk-utility .change-row.selected { box-shadow:inset 2px 0 var(--chrome-accent); }
    mux-sdk-utility .change-row svg { flex:none; color:var(--chrome-accent); }
    mux-sdk-utility .change-row span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .change-row em { flex:none; color:var(--chrome-accent); font:700 10px ui-monospace,monospace; }
    mux-sdk-utility .change-viewer { display:flex; flex-direction:column; min-width:0; min-height:0; }
    mux-sdk-utility .change-viewer > header { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:38px; padding:0 13px; border-bottom:1px solid var(--chrome-border); font:11px ui-monospace,monospace; }
    mux-sdk-utility .change-viewer > header span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .change-viewer > header small { color:var(--chrome-accent); }
    mux-sdk-utility .change-empty { display:flex; flex:1; flex-direction:column; align-items:center; justify-content:center; gap:7px; padding:25px; color:var(--chrome-text-dim); text-align:center; }
    mux-sdk-utility .change-empty svg { color:var(--chrome-accent); }
    mux-sdk-utility .change-empty h2 { margin:0; color:var(--chrome-text-bright); font-size:16px; }
    mux-sdk-utility .change-empty p { margin:0; font:12px system-ui,sans-serif; }
    mux-sdk-utility mux-monaco-diff { display:block; flex:1; min-height:0; min-width:0; }
    mux-sdk-utility mux-monaco-diff .monaco-diff-host { width:100%; height:100%; }
    mux-sdk-utility .terminal-panel { display:flex; flex-direction:column; width:100%; height:100%; min-width:0; min-height:0; background:var(--chrome-body); }
    mux-sdk-utility .terminal-panel > header { display:flex; align-items:center; justify-content:space-between; flex:none; min-height:40px; padding:0 9px 0 12px; border-bottom:1px solid var(--chrome-border); }
    mux-sdk-utility .terminal-workspace { display:flex; align-items:center; gap:8px; min-width:0; color:var(--chrome-accent); }
    mux-sdk-utility .terminal-workspace strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--chrome-text-bright); font:600 11px system-ui,sans-serif; }
    mux-sdk-utility .terminal-content { flex:1; min-height:0; min-width:0; }
    mux-sdk-utility .terminal-content mux-chat-terminal { display:block; width:100%; height:100%; }
    mux-sdk-utility .terminal-empty { display:flex; align-items:center; justify-content:center; flex-direction:column; gap:12px; height:100%; color:var(--chrome-text-dim); text-align:center; }
    mux-sdk-utility .terminal-empty button { border:1px solid var(--chrome-border); border-radius:6px; padding:6px 10px; background:var(--chrome-bar); color:var(--chrome-text-bright); cursor:pointer; }
    mux-sdk-utility .pages-list { display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; background:color-mix(in srgb,var(--chrome-body) 78%,var(--chrome-bar)); }
    mux-sdk-utility .pages-list .browser-heading { flex:none; }
    mux-sdk-utility .pages-list .empty, mux-sdk-utility .pages-error { margin:14px; font:11px/1.5 system-ui,sans-serif; color:var(--chrome-text-dim); }
    mux-sdk-utility .pages-error { color:#e59393; }
    mux-sdk-utility .page-list-rows { flex:1; min-height:0; overflow:auto; padding:2px 0 10px; }
    mux-sdk-utility .page-list-item { display:flex; align-items:center; gap:5px; box-sizing:border-box; width:100%; min-width:0; min-height:24px; padding:0 11px 0 calc(8px + var(--page-depth)*14px); border:0; background:transparent; color:var(--chrome-text-bright); text-align:left; font:11px system-ui,sans-serif; cursor:pointer; }
    mux-sdk-utility .page-list-item:hover { background:var(--chrome-hover); }
    mux-sdk-utility .page-list-item.selected { background:color-mix(in srgb,var(--chrome-accent) 17%,var(--chrome-hover)); box-shadow:inset 2px 0 var(--chrome-accent); }
    mux-sdk-utility .page-list-glyph { display:flex; align-items:center; justify-content:center; flex:none; width:17px; color:var(--chrome-accent); }
    mux-sdk-utility .page-list-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .page-editor { display:flex; flex-direction:column; min-width:0; min-height:0; overflow:auto; }
    mux-sdk-utility .page-editor-top { display:flex; align-items:center; justify-content:space-between; min-height:38px; padding:0 18px; border-bottom:1px solid var(--chrome-border); color:var(--chrome-text-dim); font:11px system-ui,sans-serif; }
    mux-sdk-utility .page-editor-top span:first-child { display:flex; align-items:center; gap:7px; }
    mux-sdk-utility .page-paper { width:min(720px,100%); box-sizing:border-box; margin:0 auto; padding:44px clamp(20px,8%,75px) 80px; }
    mux-sdk-utility .page-title { display:block; width:100%; min-height:75px; resize:none; overflow:hidden; border:0; outline:0; margin-bottom:22px; background:transparent; color:var(--chrome-text-bright); font:700 clamp(25px,3vw,36px)/1.3 system-ui,sans-serif; }
    mux-sdk-utility .page-new-button { margin-top:10px; border:1px solid var(--chrome-border); border-radius:5px; padding:7px 12px; background:var(--chrome-bar); color:var(--chrome-text-bright); cursor:pointer; }
    mux-sdk-utility .pages-panel { background:#fff; color:#232323; }
    mux-sdk-utility .pages-panel.rail-closed { grid-template-columns:minmax(0,1fr); }
    mux-sdk-utility .pages-panel .vertical-resizer { background:var(--chrome-border); }
    mux-sdk-utility .pages-panel .vertical-resizer:hover, mux-sdk-utility .pages-panel .vertical-resizer:focus-visible { background:var(--chrome-accent); }
    mux-sdk-utility .page-editor { background:#fff; color:#202124; }
    mux-sdk-utility .page-toolbar { display:flex; justify-content:space-between; align-items:center; flex:none; min-height:42px; padding:0 14px; border-bottom:1px solid #eeeeee; color:#777; font:11px system-ui,sans-serif; }
    mux-sdk-utility .page-toolbar > div { display:flex; align-items:center; gap:7px; min-width:0; }
    mux-sdk-utility .page-toolbar > div > span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .page-toolbar-actions { flex:none; }
    mux-sdk-utility .page-toolbar .page-delete:hover { color:#b42318; background:#fff0ed; border-color:#ffd5cc; }
    mux-sdk-utility .page-toolbar .page-delete:disabled { opacity:.4; cursor:not-allowed; }
    mux-sdk-utility .page-toolbar button { display:inline-flex; align-items:center; justify-content:center; flex:none; width:28px; height:28px; border:1px solid #ebebeb; border-radius:9px; background:#fff; color:#555; cursor:pointer; }
    mux-sdk-utility .page-toolbar button:hover { background:#f3f3f3; }
    mux-sdk-utility .page-toolbar .page-parent { width:auto; max-width:130px; border:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mux-sdk-utility .page-canvas { flex:1; overflow:auto; min-height:0; }
    mux-sdk-utility .page-paper { width:min(720px,100%); margin:0 auto; padding:42px clamp(16px,6%,70px) 100px clamp(64px,8%,75px); }
    mux-sdk-utility .page-title { min-height:42px; margin:0 0 49px; color:#202124; font:700 27px/1.28 system-ui,sans-serif; }
    mux-sdk-utility .page-subpage { margin:20px 0 0; border:0; background:transparent; color:#868d92; font:12px system-ui,sans-serif; cursor:pointer; }
    mux-sdk-utility .page-subpage:hover { color:#202124; }
    mux-sdk-utility .page-no-selection { display:flex; align-items:center; justify-content:center; flex:1; flex-direction:column; gap:8px; color:#777; }
    mux-sdk-utility .page-no-selection h2 { margin:0; color:#202124; }
    mux-sdk-utility .page-no-selection p { margin:0; }
    mux-sdk-utility .page-no-selection button { margin-top:9px; border:1px solid #ddd; border-radius:7px; padding:7px 12px; background:#fff; color:#333; cursor:pointer; }
    @container(max-width:520px) { mux-sdk-utility .files-panel, mux-sdk-utility .changes-panel, mux-sdk-utility .pages-panel { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(170px,38%) minmax(0,1fr); } mux-sdk-utility .files-panel.rail-closed, mux-sdk-utility .pages-panel.rail-closed { grid-template-rows:minmax(0,1fr); } mux-sdk-utility .vertical-resizer { display:none; } mux-sdk-utility .browser, mux-sdk-utility .changes-list, mux-sdk-utility .pages-list { border-bottom:1px solid var(--chrome-border); } }
  `;
}
