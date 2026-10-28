import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sdkChats, sdkHarnessLabel, type FolderListing, type SDKHarnessName } from '../lib/sdk-chats.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { ArrowUp, Check, ChevronDown, Folder, MessageCircle, Network, Plus } from 'lucide';
import { icon } from '../lib/icons.js';
import { chatComposerAttachment } from './chat-composer-attachment.js';
import '../ui/button.js';
import '../ui/attachment.js';
import '../ui/choice-item.js';
import '../ui/choice-list.js';
import '../ui/choice-picker.js';
import '../ui/choice-section.js';
import '../ui/dialog.js';
import '../ui/feedback.js';
import '../ui/screen-header.js';
import '../ui/folder-browser.js';
import type { MuxUIRangeField } from '../ui/range-field.js';
import '../ui/range-field.js';
import '../ui/switch.js';
import '../ui/text-field.js';
import '../ui/menu-item.js';
import type { MuxUITextField } from '../ui/text-field.js';
import { nativeTextareaSizing, syncTextareaSizing } from '../lib/textarea-sizing.js';
import { pastedImageFiles, readClipboardImageFiles } from '../lib/clipboard-images.js';
import './mux-folder-picker.js';

type ProviderName = 'openai' | 'anthropic' | 'configured';
type StartOption = { harness: SDKHarnessName; provider: ProviderName };
type ModelOption = { id: string; label: string; efforts: string[]; defaultEffort?: string };
type ChatCatalog = { model: string; effort: string; defaultModel?: string; models: ModelOption[]; bundle?: string; provider?: string; bundles?: string[]; providers?: string[] };
const providerLabel = (value: string) => value === 'provider-openai' ? 'OpenAI' : value === 'provider-anthropic' ? 'Anthropic' : value.replace(/^provider-/, '');
type Attachment = { localId: string; file: File; id?: string; kind?: string; preview?: string; uploading: boolean; error?: string };

@customElement('mux-new-chat')
export class MuxNewChat extends LitElement {
  @property({ type: Boolean, reflect: true }) compact = false;
  @property() initialHarness: SDKHarnessName = 'codex';
  @property() initialFolder = '';
  @property() initialProject = '';
  @property() initialRemoteHost = '';
  @property() initialPrompt = '';
  @state() private projectId = 'ungrouped';
  @state() private remoteHost = '';
  @state() private folder = '';
  @state() private workMode: 'local' | 'worktree' = 'local';
  @state() private projectName = '';
  @state() private projectParent = '';
  @state() private projectFolderName = '';
  @state() private projectDialogOpen = false;
  @state() private projectCreating = false;
  @state() private projectError = '';
  @state() private folderSelecting = false;
  @state() private harness: SDKHarnessName = 'codex';
  @state() private provider = 'openai';
  @state() private bundle = '';
  @state() private model = '';
  @state() private effort = '';
  @state() private customModel = false;
  @state() private catalog?: ChatCatalog;
  @state() private catalogLoading = false;
  @state() private catalogError = '';
  private catalogVersion = 0;
  private startOptionsVersion = 0;
  private catalogHarness = '';
  private catalogPath = '';
  private catalogTimer?: number;
  @state() private startOptions?: StartOption[];
  @state() private prompt = '';
  @state() private promptHasContent = false;
  private promptTimer?: number;
  private pendingPrompt?: string;
  @state() private listing?: FolderListing;
  @state() private pickerOpen = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private clipboardError = '';
  @state() private attachments: Attachment[] = [];
  @state() private dropActive = false;
  private dragDepth = 0;
  private hasFiles(event: DragEvent) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
  private preventFileNavigation = (event: DragEvent) => { if (this.hasFiles(event)) event.preventDefault(); };
  private resetDrop = () => { this.dragDepth = 0; this.dropActive = false; };
  private unsub?: () => void;
  private readonly closeDropdowns = (event: PointerEvent) => {
    const path = event.composedPath();
    const inside = (selector: string) => {
      const element = this.renderRoot.querySelector(selector);
      return element !== null && path.includes(element);
    };
    if (this.pickerOpen && !inside('.project-picker')) this.pickerOpen = false;
  };

  static styles = css`
    ${subtleScrollbars}
    :host { position:absolute; inset:0; z-index:var(--ui-z-screen); display:flex; flex-direction:column; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-md)/1.5 var(--ui-font-sans); }
    .main { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; align-items:center; padding:var(--ui-space-8); overflow:auto; }
    .main.setup { justify-content:flex-start; }
    .content { width:min(100%,var(--ui-chat-content-width)); }
    h1 { font-size:var(--ui-text-4xl); font-weight:600; margin:0 0 var(--ui-space-7); }
    .controls { display:flex; align-items:center; flex-wrap:wrap; gap:var(--ui-space-3); padding-bottom:var(--ui-space-4); border-bottom:1px solid var(--ui-border); }
    label { display:flex; flex-direction:column; gap:var(--ui-space-2); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .controls label { display:block; }
    .controls .project { min-width:0; }
    .controls .harness { min-width:0; }
    .chat-picker .custom-model { width:calc(100% - var(--ui-space-8)); margin:var(--ui-space-3) var(--ui-space-5); }
    .controls mux-ui-switch { margin-left:auto; }
    .composer-actions { display:flex; align-items:center; gap:var(--ui-space-3); padding-top:var(--ui-space-4); border-top:1px solid var(--ui-border); }
    .composer-actions .send { margin-left:auto; }
    .project mux-ui-select-combobox { max-width:var(--ui-picker-trigger-compact-width); }
    .folder { display:grid; gap:var(--ui-space-3); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .folder-line { display:flex; align-items:center; gap:var(--ui-space-3); }
    .folder-line mux-ui-text-field { flex:1; min-width:0; }
    mux-ui-folder-browser { margin-bottom:var(--ui-space-4); }
    .composer { position:relative; display:flex; flex-direction:column; gap:var(--ui-space-4); border:1px solid var(--ui-border); border-radius:var(--ui-radius-2xl); background:var(--ui-surface-raised); padding:var(--ui-space-6) var(--ui-space-6) var(--ui-space-5); transition:border-color var(--ui-motion-fast),box-shadow var(--ui-motion-fast); }
    .textarea-sizing { position:relative; width:100%; min-width:0; min-height:var(--ui-composer-input-min-height); max-height:var(--ui-composer-input-max-height); font:var(--ui-text-xl)/1.55 var(--ui-font-sans); }
    textarea { box-sizing:border-box; display:block; width:100%; min-width:0; min-height:var(--ui-composer-input-min-height); max-height:var(--ui-composer-input-max-height); resize:none; border:0; outline:0; padding:var(--ui-space-1) 0; color:inherit; background:transparent; font:inherit; overflow-y:auto; }
    .native-textarea-sizing textarea { field-sizing:content; height:auto; }
    .legacy-textarea-sizing textarea { position:absolute; inset:0; height:100%; min-height:0; max-height:none; }
    .textarea-mirror { box-sizing:border-box; width:100%; min-height:var(--ui-composer-input-min-height); max-height:var(--ui-composer-input-max-height); padding:var(--ui-space-1) 0; visibility:hidden; white-space:pre-wrap; overflow-wrap:break-word; overflow-y:auto; }
    .native-textarea-sizing .textarea-mirror { display:none; }
    textarea::placeholder { color:var(--ui-text-muted); opacity:.8; }
    .attachments { display:flex; flex-wrap:wrap; gap:var(--ui-space-4); }
    .file-input { display:none; }
    .drop-overlay { position:absolute; inset:var(--ui-space-4); z-index:var(--ui-z-drag-overlay); display:grid; place-items:center; border:2px dashed var(--ui-accent); border-radius:var(--ui-radius-xl); background:color-mix(in srgb, var(--ui-surface-base) 92%, transparent); color:var(--ui-text); font-size:var(--ui-text-2xl); pointer-events:none; }
    .main > .content > mux-ui-feedback { margin:var(--ui-space-5) 0; }
    .setup-intro { margin:0 0 var(--ui-space-7); color:var(--ui-text-muted); font-size:var(--ui-text-lg); }
    .setup-refresh { margin-top:var(--ui-space-6); }
    .receipt { display:flex; align-items:center; gap:var(--ui-space-4); margin:var(--ui-space-5) var(--ui-space-1) 0; color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
    .receipt::before { content:''; width:var(--ui-attention-mark-size); height:var(--ui-attention-mark-size); border-radius:50%; background:var(--ui-accent); animation:receipt-pulse var(--ui-motion-pulse) ease-in-out infinite; }
    @keyframes receipt-pulse { 50% { opacity:.35; transform:scale(.7); } }
    @media (prefers-reduced-motion:reduce) { .receipt::before { animation:none; } }
    .location-settings { min-width:0; }
    .location-trigger { min-width:0; max-width:var(--ui-new-chat-location-width); }
    .location-trigger::part(button) { min-width:0; justify-content:flex-start; }
    .location-settings .folder-symbol { display:flex; flex:none; color:var(--ui-accent); }
    .location-settings .folder-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .location-fields { display:grid; gap:var(--ui-space-5); box-sizing:border-box; max-height:min(80dvh,var(--ui-dialog-compact-max-height)); overflow:auto; padding:var(--ui-space-6); }
    .location-head { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-5); }
    .location-head h2 { margin:0; color:var(--ui-text); font-size:var(--ui-text-xl); }
    .location-actions { display:flex; justify-content:flex-end; border-top:1px solid var(--ui-border); padding-top:var(--ui-space-5); }
    .location-note { margin:0; color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    @media(max-width:550px) {
      .main { padding:var(--ui-space-6); }
      h1 { font-size:var(--ui-text-3xl); }
      .controls { position:relative; gap:var(--ui-space-3); }
      .location-trigger::part(button) { min-height:var(--ui-control-lg); }
      .location-fields { padding-bottom:max(var(--ui-space-6),env(safe-area-inset-bottom)); }
    }
    .content { width:min(100%,var(--ui-chat-transcript-width)); }
    h1 { margin-bottom:var(--ui-space-6); }
    .composer { gap:var(--ui-space-3); padding:var(--ui-space-5) var(--ui-space-5) var(--ui-space-3); border-radius:var(--ui-radius-xl) var(--ui-radius-xl) 0 0; box-shadow:var(--ui-shadow-control); }
    .composer-actions { gap:var(--ui-space-2); min-height:var(--ui-control-md); padding:0; border:0; }
    .composer-actions .attach-picker,.composer-actions .send { width:var(--ui-control-md); height:var(--ui-control-md); }
    .composer-actions .send::part(button) { width:var(--ui-control-sm); height:var(--ui-control-sm); min-height:var(--ui-control-sm); margin:auto; border-radius:50%; }
    .composer-actions .agent-picker { max-width:var(--ui-new-chat-harness-width); }
    .composer-actions .agent-picker::part(summary) { min-height:var(--ui-control-md); }
    .composer-actions .chat-picker { flex:1 1 0; min-width:var(--ui-control-md); max-width:var(--ui-picker-trigger-compact-width); }
    .composer-actions .chat-picker::part(summary) { width:100%; min-height:var(--ui-control-md); }
    .composer-actions .loading-models { color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .composer-actions.has-bundle { display:grid; grid-template-columns:var(--ui-control-md) minmax(0,1fr) minmax(0,1fr) var(--ui-control-md); }
    .composer-actions.has-bundle .attach-picker { grid-column:1; grid-row:1; }
    .composer-actions.has-bundle .agent-picker { grid-column:2/4; grid-row:1; }
    .composer-actions.has-bundle .send { grid-column:4; grid-row:1; margin-left:0; }
    .composer-actions.has-bundle .bundle-picker { grid-column:1/3; grid-row:2; }
    .composer-actions.has-bundle .settings-picker { grid-column:3/5; grid-row:2; }
    .composer-actions.has-bundle .chat-picker { width:100%; max-width:none; }
    .context-bar { display:flex; align-items:center; gap:var(--ui-space-2); min-height:var(--ui-control-md); padding:var(--ui-space-1) var(--ui-space-2); border:1px solid var(--ui-border); border-top:0; border-radius:0 0 var(--ui-radius-xl) var(--ui-radius-xl); background:var(--ui-surface-raised); }
    .context-bar .spacer { flex:1; }
    .project-picker { position:relative; min-width:0; }
    .project-trigger { display:flex; align-items:center; gap:var(--ui-space-2); max-width:var(--ui-new-chat-location-width); min-height:var(--ui-control-sm); padding:0 var(--ui-space-2); border:0; border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text-muted); font:inherit; font-size:var(--ui-text-sm); cursor:pointer; }
    .project-trigger:hover,.project-trigger[aria-expanded="true"] { background:var(--ui-surface-hover); color:var(--ui-text); }
    .project-trigger:focus-visible { outline:2px solid var(--ui-focus); }
    .project-trigger span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .project-options { position:absolute; z-index:var(--ui-z-menu); bottom:calc(100% + var(--ui-space-2)); left:0; box-sizing:border-box; width:min(var(--ui-mobile-drawer-width),calc(100vw - var(--ui-control-lg))); max-height:min(var(--ui-dialog-height),75dvh); overflow:auto; padding:var(--ui-space-2); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-overlay); box-shadow:var(--ui-shadow-menu); --folder-list-height:var(--ui-new-chat-location-width); }
    .project-options mux-folder-picker { display:block; width:100%; }
    .project-options mux-folder-picker::part(menu) { border:0; }
    .project-option { display:flex; align-items:center; gap:var(--ui-space-3); width:100%; min-height:var(--ui-control-md); padding:var(--ui-space-2); border:0; border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text); text-align:left; font:inherit; cursor:pointer; }
    .project-option:hover,.project-option[selected] { background:var(--ui-surface-hover); }
    .project-option .option-copy { display:grid; gap:var(--ui-space-px); flex:1; min-width:0; }
    .project-option .option-copy small { color:var(--ui-text-muted); }
    .project-option .selected-icon { margin-left:auto; color:var(--ui-accent); }
    .remote-status { width:var(--ui-status-dot-size); height:var(--ui-status-dot-size); flex:none; border-radius:50%; background:var(--ui-text-muted); }
    .remote-status.connected { background:var(--ui-success); }
    .project-divider { height:var(--ui-divider-thickness); margin:var(--ui-space-2) 0; background:var(--ui-border); }
    .new-folder-form { display:grid; gap:var(--ui-space-5); padding:var(--ui-space-6); color:var(--ui-text); }
    .new-folder-form h2 { margin:0; font-size:var(--ui-text-xl); }
    .new-folder-form .field-label { display:grid; gap:var(--ui-space-2); color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
    .new-folder-form .optional { color:var(--ui-text-muted); font-weight:400; }
    .new-folder-form .actions { display:flex; justify-content:flex-end; gap:var(--ui-space-3); }
    .context-bar mux-ui-switch { margin-left:auto; }
    @media(max-width:550px) {
      .composer-actions { flex-wrap:wrap; }
      .composer-actions .chat-picker { max-width:var(--ui-dock-rename-max-width); }
      .context-bar { min-height:var(--ui-control-lg); }
      .project-trigger,.project-option { min-height:var(--ui-control-lg); }
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('dragover', this.preventFileNavigation);
    window.addEventListener('drop', this.preventFileNavigation);
    window.addEventListener('drop', this.resetDrop);
    window.addEventListener('dragend', this.resetDrop);
    this.harness = this.initialHarness;
    if (this.initialPrompt) {
      this.prompt = this.initialPrompt;
      this.promptHasContent = !!this.initialPrompt.trim();
    }
    this.remoteHost = this.initialRemoteHost;
    void this.loadStartOptions();
    if (this.initialFolder) this.folder = this.initialFolder;
    if (this.initialProject) this.projectId = this.initialProject;
    document.addEventListener('pointerdown', this.closeDropdowns);
    this.unsub = sdkChats.subscribe(() => this.requestUpdate());
    void sdkChats.refresh().then(() => { const project = sdkChats.projects.find(p => p.id === this.projectId && (p.remoteHost || '') === this.remoteHost); if (project && this.folder !== project.path) { this.folder = project.path; void this.loadCatalog(); } });
    void sdkChats.folders('', this.remoteHost).then(listing => { this.listing = listing; if (!this.folder) { this.folder = listing.base; void this.loadCatalog(); } }).catch(error => { this.error = String(error); });
  }
  override disconnectedCallback() {
    this.flushPrompt();
    this.unsub?.();
    document.removeEventListener('pointerdown', this.closeDropdowns);
    window.removeEventListener('dragover', this.preventFileNavigation);
    window.removeEventListener('drop', this.preventFileNavigation);
    window.removeEventListener('drop', this.resetDrop);
    window.removeEventListener('dragend', this.resetDrop);
    for (const item of this.attachments) if (item.preview) URL.revokeObjectURL(item.preview);
    if (this.catalogTimer) window.clearTimeout(this.catalogTimer);
    super.disconnectedCallback();
  }
  override firstUpdated() {
    const textarea = this.shadowRoot?.querySelector('textarea');
    if (textarea) { syncTextareaSizing(textarea); textarea.focus(); }
  }
  private onPromptInput(event: InputEvent) {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    const value = textarea.value;
    this.pendingPrompt = value;
    this.promptHasContent = !!value.trim();
    if (this.promptTimer) window.clearTimeout(this.promptTimer);
    this.promptTimer = window.setTimeout(() => this.flushPrompt(), 700);
    syncTextareaSizing(textarea);
  }
  private flushPrompt(): string {
    if (this.pendingPrompt === undefined) return this.prompt;
    const value = this.pendingPrompt;
    if (this.promptTimer) window.clearTimeout(this.promptTimer);
    this.promptTimer = undefined;
    this.pendingPrompt = undefined;
    this.prompt = value;
    return value;
  }
  private selectChat() {
    if (this.remoteHost) {
      for (const item of this.attachments) if (item.preview) URL.revokeObjectURL(item.preview);
      this.attachments = [];
    }
    this.catalogVersion++;
    this.startOptionsVersion++;
    this.catalog = undefined;
    this.startOptions = undefined;
    this.remoteHost = '';
    this.projectId = 'ungrouped';
    this.folder = '';
    this.listing = undefined;
    this.workMode = 'local';
    this.pickerOpen = false;
    void sdkChats.folders().then(listing => { if (!this.remoteHost) { this.listing = listing; this.folder = listing.base; void this.loadStartOptions(); } });
  }
  private async selectFolder(path: string) {
    if (this.folderSelecting) return;
    this.folderSelecting = true;
    this.error = '';
    try {
      let project = sdkChats.projects.find(item => !item.managedFolder && item.path === path && (item.remoteHost || '') === this.remoteHost);
      if (!project) project = await sdkChats.createProject(path, '', [], false, false, this.remoteHost);
      this.projectId = project.id;
      this.folder = project.path;
      this.pickerOpen = false;
      void this.loadCatalog();
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.folderSelecting = false; }
  }
  private openProjectDialog() {
    this.pickerOpen = false;
    this.projectParent = this.listing?.base || this.folder || '';
    this.projectFolderName = '';
    this.projectName = '';
    this.projectError = '';
    this.projectDialogOpen = true;
  }
  private closeProjectDialog() { if (!this.projectCreating) this.projectDialogOpen = false; }
  private validNewFolderName(name: string) { return !!name && name.length <= 80 && name !== '.' && name !== '..' && !/[\\/]/.test(name); }
  private async createProject() {
    if (this.projectCreating) return;
    const name = this.projectFolderName.trim();
    if (!this.validNewFolderName(name) || !this.projectParent.startsWith('/')) {
      this.projectError = 'Choose a parent folder and a folder name without slashes.';
      return;
    }
    this.projectCreating = true;
    this.projectError = '';
    try {
      const parent = this.projectParent.replace(/\/+$/, '') || '/';
      const path = `${parent === '/' ? '' : parent}/${name}`;
      const project = await sdkChats.createProject(path, this.projectName.trim() || name, [], true, false, this.remoteHost);
      this.projectId = project.id;
      this.folder = project.path;
      this.projectDialogOpen = false;
      void this.loadCatalog();
    } catch (error) { this.projectError = error instanceof Error ? error.message : String(error); }
    finally { this.projectCreating = false; }
  }
  private async chooseRemoteHost(host: string) {
    if (host === this.remoteHost) { this.pickerOpen = false; return; }
    this.catalogVersion++;
    this.startOptionsVersion++;
    this.remoteHost = host;
    this.projectId = 'ungrouped';
    this.folder = '';
    this.listing = undefined;
    this.workMode = 'local';
    this.pickerOpen = false;
    for (const item of this.attachments) if (item.preview) URL.revokeObjectURL(item.preview);
    this.attachments = [];
    this.catalog = undefined;
    this.startOptions = undefined;
    try {
      const listing = await sdkChats.folders('', host);
      if (this.remoteHost !== host) return;
      this.listing = listing;
      this.folder = listing.base;
      await this.loadStartOptions();
    } catch (error) { if (this.remoteHost === host) this.error = error instanceof Error ? error.message : String(error); }
  }
  private chooseProject(project: { id:string; path:string; remoteHost?:string }) {
    const host = project.remoteHost || '';
    if (host !== this.remoteHost) {
      for (const item of this.attachments) if (item.preview) URL.revokeObjectURL(item.preview);
      this.attachments = [];
    }
    this.catalogVersion++;
    this.startOptionsVersion++;
    this.remoteHost = host;
    this.projectId = project.id;
    this.folder = project.path;
    this.workMode = 'local';
    this.pickerOpen = false;
    this.catalog = undefined;
    this.startOptions = undefined;
    void sdkChats.folders('', this.remoteHost).then(listing => { if (this.projectId === project.id) this.listing = listing; });
    void this.loadStartOptions();
  }
  private onHarnessChange(value: SDKHarnessName) {
    const option = this.startOptions?.find(item => item.harness === value);
    if (!option) return;
    this.harness = option.harness;
    this.provider = option.provider;
    this.bundle = '';
    this.model = '';
    this.effort = '';
    this.customModel = false;
    void this.loadCatalog();
  }
  private async loadCatalog() {
    if (!this.startOptions?.some(item => item.harness === this.harness)) return;
    const version = ++this.catalogVersion;
    const path = this.folder || this.listing?.base || '';
    const previous = this.catalogHarness === `${this.remoteHost}:${this.harness}` && this.catalogPath === path ? this.catalog : undefined;
    const previousModel = this.model;
    const previousEffort = this.effort;
    this.catalogLoading = true;
    this.catalogError = '';
    this.catalog = previous;
    const params = new URLSearchParams({ harness:this.harness, projectPath:path, bundle:this.bundle, provider:this.harness === 'amplifier' ? this.provider === 'configured' ? '' : this.provider : '' });
    try {
      const response = await fetch(apiPath(remoteChatPath(this.remoteHost, `/api/sdk-chat-catalog?${params}`)));
      if (!response.ok) throw new Error((await response.text()).trim());
      const catalog = await response.json() as ChatCatalog;
      if (!this.isConnected || version !== this.catalogVersion) return;
      this.catalog = catalog;
      this.catalogHarness = `${this.remoteHost}:${this.harness}`;
      this.catalogPath = path;
      this.bundle = catalog.bundle || '';
      this.provider = this.harness === 'amplifier' ? catalog.provider || 'configured' : this.provider;
      this.model = catalog.model || '';
      this.effort = catalog.effort || '';
      this.customModel = false;
    } catch (error) {
      if (this.isConnected && version === this.catalogVersion) {
        if (previous) {
          this.catalog = previous;
          this.bundle = previous.bundle || '';
          this.provider = previous.provider || this.provider;
          this.model = previousModel;
          this.effort = previousEffort;
        }
        this.catalogError = error instanceof Error ? error.message : String(error);
      }
    } finally { if (version === this.catalogVersion) this.catalogLoading = false; }
  }
  private onModelChange(value: string) {
    this.customModel = value === '__custom__';
    this.model = this.customModel ? '' : value;
    this.effort = '';
  }
  private pickerChoice(name: string, hint: string, selected: boolean, action: () => void) {
    return html`<mux-ui-choice-item .label=${name} .description=${hint} ?selected=${selected} ?disabled=${this.catalogLoading} @click=${action}></mux-ui-choice-item>`;
  }
  private renderBundlePicker() {
    return html`<mux-ui-choice-picker class="chat-picker bundle-picker" label="Bundle" .summary=${this.bundle || 'Bundle'} placement="above" panel-align="left">
      <mux-ui-choice-section heading="Bundle">
        ${(this.catalog?.bundles || []).map(value => this.pickerChoice(value, '', this.bundle === value, () => { this.bundle = value; this.provider = 'configured'; void this.loadCatalog(); }))}
        ${this.catalogLoading ? html`<mux-ui-feedback kind="loading" density="compact">Loading models…</mux-ui-feedback>` : nothing}
      </mux-ui-choice-section>
    </mux-ui-choice-picker>`;
  }
  private renderModelPicker(models: ModelOption[], selectedModel: ModelOption | undefined, efforts: string[]) {
    const effortIndex = Math.max(0, efforts.indexOf(this.effort || selectedModel?.defaultEffort || efforts[0]));
    const modelLabel = selectedModel?.label || this.model || (this.catalog?.defaultModel ? `Default (${this.catalog.defaultModel})` : 'Model');
    const providerDescription = this.harness === 'codex' ? 'OpenAI' : this.harness === 'claude' ? 'Anthropic' : 'Configured in agent';
    return html`<mux-ui-choice-picker class="chat-picker settings-picker" label="Provider, model and thinking" .summary=${`${modelLabel}${this.effort ? ` · ${this.effort}` : ''}`} placement="above" panel-align="right">
      <mux-ui-choice-section heading="Provider" .description=${this.harness === 'amplifier' ? '' : `${providerDescription} · managed by ${sdkHarnessLabel(this.harness)}`}>
        ${this.harness === 'amplifier' ? (this.catalog?.providers || []).map(value => this.pickerChoice(providerLabel(value), '', this.provider === value, () => { this.provider = value; void this.loadCatalog(); })) : nothing}
      </mux-ui-choice-section>
      <mux-ui-choice-section heading="Model" separated>
        <mux-ui-choice-list>
          ${this.harness !== 'amplifier' ? this.pickerChoice(this.catalog?.defaultModel ? `Harness default (${this.catalog.defaultModel})` : 'Harness default', '', !this.customModel && !this.model, () => this.onModelChange('')) : nothing}
          ${this.model && !selectedModel && !this.customModel ? this.pickerChoice(this.model, '', true, () => this.onModelChange(this.model)) : nothing}
          ${models.map(item => this.pickerChoice(item.label, item.id, !this.customModel && this.model === item.id, () => this.onModelChange(item.id)))}
          ${this.pickerChoice('Other model ID…', '', this.customModel, () => this.onModelChange('__custom__'))}
        </mux-ui-choice-list>
        ${this.customModel ? html`<mux-ui-text-field class="custom-model" aria-label="Model ID" placeholder="Model ID" .value=${this.model} @input=${(event:Event) => { this.model = (event.target as MuxUITextField).value; }}></mux-ui-text-field>` : nothing}
      </mux-ui-choice-section>
      ${efforts.length > 1 ? html`<mux-ui-choice-section separated><mux-ui-range-field label="Thinking" accessible-label="Thinking effort" .min=${0} .max=${efforts.length - 1} .value=${effortIndex} .valueLabels=${efforts} .minLabel=${efforts[0]} .maxLabel=${efforts[efforts.length - 1]} @input=${(event:Event) => { this.effort = efforts[(event.target as MuxUIRangeField).value]; }}></mux-ui-range-field></mux-ui-choice-section>` : nothing}
      ${this.catalogLoading ? html`<mux-ui-feedback kind="loading" density="compact">Loading models…</mux-ui-feedback>` : nothing}
    </mux-ui-choice-picker>`;
  }
  private async loadStartOptions() {
    const version = ++this.startOptionsVersion;
    const host = this.remoteHost;
    try {
      const response = await fetch(apiPath(remoteChatPath(this.remoteHost, '/api/sdk-chat-start-options')));
      if (!response.ok) throw new Error(await response.text());
      const options = await response.json() as StartOption[];
      if (!this.isConnected || version !== this.startOptionsVersion || host !== this.remoteHost) return;
      this.startOptions = options;
      const selected = options.find(item => item.harness === this.initialHarness) || options[0];
      if (selected) this.onHarnessChange(selected.harness);
      else this.error = '';
    } catch (error) {
      if (this.isConnected && version === this.startOptionsVersion && host === this.remoteHost) this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private openAgentSettings() {
    this.dispatchEvent(new CustomEvent('launcher-action', { detail:{action:'settings',section:'ai'}, bubbles:true, composed:true }));
  }
  private onDragEnter(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth++; this.dropActive = true; }
  private onDragOver(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; this.dropActive = true; }
  private onDragLeave(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth = Math.max(0, this.dragDepth - 1); if (!this.dragDepth) this.dropActive = false; }
  private onDrop(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); event.stopPropagation(); this.resetDrop(); this.addFiles(Array.from(event.dataTransfer?.files || [])); }
  private onPick(event: Event) { const input = event.target as HTMLInputElement; this.addFiles(Array.from(input.files || [])); input.value = ''; }
  private onPaste(event: ClipboardEvent) {
    const images = pastedImageFiles(event);
    if (!images.length) return;
    event.preventDefault();
    this.clipboardError = '';
    this.addFiles(images);
  }
  private async pasteImageFromClipboard() {
    this.clipboardError = '';
    try { this.addFiles(await readClipboardImageFiles()); }
    catch (error) { this.clipboardError = error instanceof Error ? error.message : String(error); }
  }
  private addFiles(files: File[]) {
    for (const file of files) {
      const item: Attachment = { localId:crypto.randomUUID(), file, preview:file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined, uploading:true };
      this.attachments = [...this.attachments, item];
      void this.upload(item);
    }
  }
  private async upload(item: Attachment) {
    const form = new FormData(); form.append('file', item.file);
    try {
      const response = await fetch(apiPath(remoteChatPath(this.remoteHost, '/api/sdk-chat-attachments')), { method:'POST', headers:{'X-Muxterm-Chat-Attachment':'1'}, body:form });
      const body = await response.text();
      let payload: { id?: string; kind?: string; reason?: string } = {};
      try { payload = JSON.parse(body) as typeof payload; } catch { /* Preserve server text for errors. */ }
      if (!response.ok) throw new Error(payload.reason || body.trim() || `Upload failed (${response.status})`);
      if (!payload.id || !payload.kind) throw new Error('Upload response lacked attachment details');
      if (!this.attachments.some(a => a.localId === item.localId)) return;
      if (payload.kind !== 'image' && item.preview) URL.revokeObjectURL(item.preview);
      this.attachments = this.attachments.map(a => a.localId === item.localId
        ? { ...a, id:payload.id, kind:payload.kind, preview:payload.kind === 'image' ? item.preview : undefined, uploading:false } : a);
    } catch (error) {
      if (!this.attachments.some(a => a.localId === item.localId)) return;
      this.attachments = this.attachments.map(a => a.localId === item.localId
        ? { ...a, uploading:false, error:error instanceof Error ? error.message : String(error) } : a);
    }
  }
  private removeAttachment(localId: string) {
    const item = this.attachments.find(a => a.localId === localId);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    this.attachments = this.attachments.filter(a => a.localId !== localId);
  }
  private async send() {
    const prompt = this.flushPrompt().trim();
    if ((!prompt && !this.attachments.length) || this.busy || this.folderSelecting || this.catalogLoading || !this.catalog || (this.customModel && !this.model.trim()) || !this.startOptions?.some(item => item.harness === this.harness) || this.attachments.some(a => a.uploading || a.error)) return;
    this.busy = true; this.error = '';
    try {
      await this.updateComplete;
      const workspaceId = this.projectId === 'ungrouped' ? undefined : this.projectId;
      const chat = await sdkChats.create({ remoteHost:this.remoteHost, workspaceId, projectPath:this.folder, workMode:this.workMode, harness:this.harness, provider:this.provider, bundle:this.bundle, model:this.model.trim(), effort:this.effort, prompt, attachments:this.attachments.map(a => a.id!) });
      this.dispatchEvent(new CustomEvent('chat-created', { detail:{sessionId:chat.id}, bubbles:true, composed:true }));
    } catch (error) { this.error = error instanceof Error ? error.message.trim() : String(error); }
    finally { this.busy = false; }
  }
  private renderTopbar(projectName: string) {
    return html`<mux-ui-screen-header .section=${projectName} heading="New chat" label="New chat" with-section-icon><span slot="section-icon">${icon(this.remoteHost ? Network : this.projectId === 'ungrouped' ? MessageCircle : Folder,{size:14})}</span></mux-ui-screen-header>`;
  }

  override render() {
    const selectedProject = sdkChats.projects.find(project => project.id === this.projectId && (project.remoteHost || '') === this.remoteHost);
    const projectName = selectedProject?.name || (this.remoteHost ? sdkChats.remoteHosts.find(host => host.id === this.remoteHost)?.name || 'Remote chat' : 'Chat');
    const models = this.catalog?.models || [];
    const selectedModel = models.find(item => item.id === this.model);
    const efforts = selectedModel?.efforts?.length ? selectedModel.efforts : this.harness === 'codex' && this.model ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : [];
    if (this.startOptions?.length === 0) return html`
      ${this.renderTopbar(projectName)}
      <div class="main setup"><div class="content">
        <h1>Choose your coding agent</h1>
        <p class="setup-intro">Set up an agent in Settings, then refresh this list to start a chat.</p>
        <mux-ui-button variant="primary" @click=${this.openAgentSettings}>Open agent settings</mux-ui-button>
        <mux-ui-button class="setup-refresh" variant="secondary" @click=${() => void this.loadStartOptions()}>Refresh installed agents</mux-ui-button>
        ${this.error ? html`<mux-ui-feedback kind="error" appearance="panel">${this.error}</mux-ui-feedback>` : nothing}
      </div></div>`;
    return html`
    ${this.renderTopbar(projectName)}
    <div class="main"><div class="content">
      <h1>What would you like to do?</h1>
      <div class="composer" @paste=${this.onPaste} @dragenter=${this.onDragEnter} @dragover=${this.onDragOver} @dragleave=${this.onDragLeave} @drop=${this.onDrop}>
        ${this.attachments.length ? html`<div class="attachments" role="list" aria-label="Attached files">${this.attachments.map(a => html`<mux-ui-attachment role="listitem" file-name=${a.file.name} preview-url=${a.preview ?? ''} state=${a.error ? 'error' : a.uploading ? 'uploading' : 'ready'} error=${a.error ?? ''} @attachment-remove=${() => this.removeAttachment(a.localId)}></mux-ui-attachment>`)}</div>` : nothing}
        ${this.clipboardError ? html`<mux-ui-feedback kind="error" density="compact">${this.clipboardError}</mux-ui-feedback>` : nothing}
        <div class="textarea-sizing ${nativeTextareaSizing ? 'native-textarea-sizing' : 'legacy-textarea-sizing'}"><textarea aria-label="First message" placeholder="Describe what you want to work on…" .value=${this.prompt} @input=${this.onPromptInput} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea><div class="textarea-mirror" aria-hidden="true"></div></div>
        <div class="composer-actions ${this.harness === 'amplifier' ? 'has-bundle' : ''}">
          <input class="file-input" type="file" multiple aria-label="Choose files to attach" @change=${this.onPick}>
          ${chatComposerAttachment(() => this.shadowRoot?.querySelector<HTMLInputElement>('.file-input')?.click(), () => void this.pasteImageFromClipboard())}
          ${this.startOptions?.length ? html`<mux-ui-choice-picker class="agent-picker" label="Agent" .summary=${sdkHarnessLabel(this.harness)} placement="above" appearance="plain" panel-align="left">
            <mux-ui-choice-section heading="Available agents"><mux-ui-choice-list>${this.startOptions.map(option => html`<mux-ui-choice-item .label=${sdkHarnessLabel(option.harness)} ?selected=${this.harness === option.harness} @click=${(event:Event) => { this.onHarnessChange(option.harness); (event.currentTarget as HTMLElement).closest('mux-ui-choice-picker')?.close(); }}></mux-ui-choice-item>`)}</mux-ui-choice-list></mux-ui-choice-section>
            <mux-ui-choice-section separated><mux-ui-choice-item label="Add or manage agents…" @click=${(event:Event) => { (event.currentTarget as HTMLElement).closest('mux-ui-choice-picker')?.close(); this.openAgentSettings(); }}></mux-ui-choice-item><mux-ui-choice-item label="Refresh installed agents" @click=${(event:Event) => { (event.currentTarget as HTMLElement).closest('mux-ui-choice-picker')?.close(); void this.loadStartOptions(); }}></mux-ui-choice-item></mux-ui-choice-section>
          </mux-ui-choice-picker>` : nothing}
          ${this.harness === 'amplifier' && this.catalog ? this.renderBundlePicker() : nothing}
          ${this.catalog ? this.renderModelPicker(models, selectedModel, efforts) : nothing}
          ${this.catalogLoading ? html`<span class="loading-models" role="status">Loading models…</span>` : nothing}
          <mux-ui-button class="send" size="small" icon-only variant="primary" accessible-label="Send message" ?disabled=${(!this.promptHasContent && !this.attachments.length) || this.busy || this.folderSelecting || this.catalogLoading || !this.catalog || (this.customModel && !this.model.trim()) || !this.startOptions?.some(item => item.harness === this.harness) || this.attachments.some(a => a.uploading || !!a.error)} @click=${() => void this.send()}>${icon(ArrowUp,{size:16})}</mux-ui-button>
        </div>

        ${this.dropActive ? html`<div class="drop-overlay" role="status">Drop files to attach</div>` : nothing}
      </div>
      <div class="context-bar">
        <div class="project-picker"><button class="project-trigger" type="button" aria-label="Session location" aria-haspopup="menu" aria-expanded=${this.pickerOpen} @click=${() => { this.pickerOpen = !this.pickerOpen; }}>
          ${icon(this.remoteHost ? Network : this.projectId === 'ungrouped' ? MessageCircle : Folder,{size:15})}<span>${selectedProject?.name || (this.remoteHost ? sdkChats.remoteHosts.find(host => host.id === this.remoteHost)?.name || 'Remote chat' : 'Chat')}</span>${icon(ChevronDown,{size:14})}
        </button>
        ${this.pickerOpen ? html`<div class="project-options" role="menu" aria-label="Session location">
          <button class="project-option" role="menuitemradio" aria-checked=${this.projectId === 'ungrouped' && !this.remoteHost} ?selected=${this.projectId === 'ungrouped' && !this.remoteHost} @click=${this.selectChat}>${icon(MessageCircle,{size:16})}<span class="option-copy"><strong>Chat</strong><small>No project folder</small></span>${this.projectId === 'ungrouped' && !this.remoteHost ? html`<span class="selected-icon">${icon(Check,{size:15})}</span>` : nothing}</button>
          <div class="project-divider"></div>
          ${sdkChats.remoteHosts.map(host => html`<button class="project-option" role="menuitem" ?disabled=${host.state !== 'connected'} @click=${() => void this.chooseRemoteHost(host.id)}>${icon(Network,{size:16})}<span class="option-copy"><strong>${host.name}</strong><small>${host.state === 'connected' ? 'Browse folders on this machine' : host.state}</small></span><span class="remote-status ${host.state}" aria-label=${host.state}></span></button>${sdkChats.projects.filter(project => project.remoteHost === host.id).map(project => html`<button class="project-option" role="menuitem" @click=${() => this.chooseProject(project)}>${icon(Network,{size:16})}<span class="option-copy"><strong>${project.name}</strong><small>${project.path}</small></span></button>`)}`)}
          ${sdkChats.remoteHosts.length ? html`<div class="project-divider"></div>` : nothing}
          <mux-folder-picker inline label="Folders" .remoteHost=${this.remoteHost} .value=${this.projectId === 'ungrouped' || selectedProject?.managedFolder ? '' : this.folder} .base=${this.listing?.base || ''} @folder-selected=${(event:CustomEvent<{path:string}>) => void this.selectFolder(event.detail.path)}></mux-folder-picker>
          <div class="project-divider"></div>
          <mux-ui-menu-item @click=${this.openProjectDialog}>${icon(Plus,{size:16})}<strong>New folder</strong></mux-ui-menu-item>
        </div>` : nothing}</div>
        <div class="spacer"></div>
        <mux-ui-switch label="Worktree" accessible-label="Use a separate Git worktree" .checked=${this.workMode === 'worktree'} .tooltip=${this.projectId === 'ungrouped' || selectedProject?.managedFolder ? 'Choose a project with a Git folder to use a worktree' : 'Start this chat in a separate Git worktree'} ?disabled=${this.projectId === 'ungrouped' || !!selectedProject?.managedFolder} @change=${(event:CustomEvent<{checked:boolean}>) => { this.workMode = event.detail.checked ? 'worktree' : 'local'; }}></mux-ui-switch>
      </div>
      ${this.projectDialogOpen ? html`<mux-ui-dialog open size="compact" presentation="adaptive" label="New folder" .dismissable=${!this.projectCreating} @dismiss=${this.closeProjectDialog}><div class="new-folder-form">
        <h2>New folder</h2>
        <label class="field-label">Parent folder<mux-folder-picker inline label="Parent folder" .remoteHost=${this.remoteHost} .value=${this.projectParent} .base=${this.listing?.base || ''} @folder-selected=${(event:CustomEvent<{path:string}>) => { this.projectParent = event.detail.path; }}></mux-folder-picker></label>
        <mux-ui-text-field label="New folder name" aria-label="New folder name" placeholder="Folder name" .value=${this.projectFolderName} @input=${(event:Event) => { this.projectFolderName = (event.target as MuxUITextField).value; }}></mux-ui-text-field>
        <mux-ui-text-field label="Project name (optional)" aria-label="Project name" placeholder="Use folder name" .value=${this.projectName} @input=${(event:Event) => { this.projectName = (event.target as MuxUITextField).value; }}></mux-ui-text-field>
        ${this.projectError ? html`<mux-ui-feedback kind="error" appearance="panel" density="compact">${this.projectError}</mux-ui-feedback>` : nothing}
        <div class="actions"><mux-ui-button variant="quiet" ?disabled=${this.projectCreating} @click=${this.closeProjectDialog}>Cancel</mux-ui-button><mux-ui-button variant="primary" ?disabled=${this.projectCreating || !this.projectParent || !this.validNewFolderName(this.projectFolderName.trim())} @click=${() => void this.createProject()}>${this.projectCreating ? 'Creating…' : 'Create folder'}</mux-ui-button></div>
      </div></mux-ui-dialog>` : nothing}
      ${this.busy ? html`<div class="receipt" role="status">Message received · Creating chat…</div>` : nothing}
      ${this.catalogError ? html`<mux-ui-feedback kind="error" appearance="panel">Could not load models: ${this.catalogError}<mux-ui-button slot="action" size="small" @click=${() => void this.loadCatalog()}>Retry</mux-ui-button></mux-ui-feedback>` : nothing}
      ${this.error ? html`<mux-ui-feedback kind="error" appearance="panel">${this.error}</mux-ui-feedback>` : nothing}
    </div></div>
  `; }
}
