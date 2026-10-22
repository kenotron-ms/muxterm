import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sdkChats, sdkHarnessLabel, type FolderListing, type SDKHarnessName } from '../lib/sdk-chats.js';
import { apiPath } from '../lib/base-path.js';
import { ArrowUp, ChevronDown, Folder, Paperclip, Plus, X } from 'lucide';
import { icon } from '../lib/icons.js';
import '../ui/button.js';
import '../ui/choice-item.js';
import { choicePickerSheetStyles, closeChoicePickerOnEscape } from '../ui/choice-picker-pattern.js';
import '../ui/dialog.js';
import '../ui/feedback.js';
import type { MuxUIRangeField } from '../ui/range-field.js';
import '../ui/range-field.js';
import '../ui/select.js';
import '../ui/switch.js';
import '../ui/text-field.js';
import type { MuxUISelect } from '../ui/select.js';
import type { MuxUITextField } from '../ui/text-field.js';
import { nativeTextareaSizing, syncTextareaSizing } from '../lib/textarea-sizing.js';

type ProviderName = 'openai' | 'anthropic' | 'configured';
type StartOption = { harness: SDKHarnessName; provider: ProviderName };
type ModelOption = { id: string; label: string; efforts: string[]; defaultEffort?: string };
type ChatCatalog = { model: string; effort: string; defaultModel?: string; models: ModelOption[]; bundle?: string; provider?: string; bundles?: string[]; providers?: string[] };
const providerLabel = (value: string) => value === 'provider-openai' ? 'OpenAI' : value === 'provider-anthropic' ? 'Anthropic' : value.replace(/^provider-/, '');
const SETUP_AGENTS = [
  { name:'Codex', command:'curl -fsSL https://chatgpt.com/codex/install.sh | sh', login:'codex login', docs:'https://learn.chatgpt.com/docs/codex/cli' },
  { name:'Claude Code', command:'curl -fsSL https://claude.ai/install.sh | bash', login:'claude', docs:'https://code.claude.com/docs/en/setup' },
  { name:'OpenCode · ACP', command:'curl -fsSL https://opencode.ai/install | bash', login:'opencode', docs:'https://opencode.ai/docs/' },
  { name:'Pi · ACP', command:'npm install -g @mariozechner/pi-coding-agent pi-acp', login:'pi', docs:'https://github.com/svkozak/pi-acp' },
  { name:'DeepSeek Harness · ACP', command:'npm install -g @deepseek-ai/dsh', login:'dsh web', docs:'https://github.com/deepseek-ai/deepseek-harness' },
  { name:'Amplifier', command:'uv tool install git+https://github.com/microsoft/amplifier', login:'amplifier init', docs:'https://github.com/microsoft/amplifier/blob/main/docs/USER_ONBOARDING.md' },
] as const;
type Attachment = { localId: string; file: File; id?: string; kind?: string; preview?: string; uploading: boolean; error?: string };

@customElement('mux-new-chat')
export class MuxNewChat extends LitElement {
  @property({ type: Boolean, reflect: true }) compact = false;
  @property() initialHarness: SDKHarnessName = 'codex';
  @property() initialFolder = '';
  @property() initialProject = '';
  @property() initialPrompt = '';
  @state() private projectId = 'ungrouped';
  @state() private folder = '';
  @state() private workMode: 'local' | 'worktree' = 'local';
  @state() private projectName = '';
  @state() private newFolderName = '';
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
  @state() private locationOpen = false;
  @state() private projectPickerOpen = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private copiedSetup = '';
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
    if (this.projectPickerOpen && !inside('.project-picker')) this.projectPickerOpen = false;
    if (this.pickerOpen && !inside('.location-settings')) this.pickerOpen = false;
    this.renderRoot.querySelectorAll<HTMLDetailsElement>('.chat-picker[open]').forEach(picker => {
      if (!path.includes(picker)) picker.open = false;
    });
  };

  static styles = css`
    ${subtleScrollbars}
    :host { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; background:var(--ui-surface-base); color:var(--ui-text); font:13px/1.5 system-ui,sans-serif; }
    .topbar { box-sizing:border-box; height:var(--ui-nav-height); flex:none; display:flex; align-items:center; gap:9px; min-width:0; padding:0 max(12px,var(--wco-right-inset,0px)) 0 16px; border-bottom:1px solid var(--ui-border); background:var(--ui-surface-nav); }
    .topbar .project { display:inline-flex; align-items:center; gap:7px; min-width:0; max-width:38%; color:var(--ui-text-muted); font:500 12px Inter,system-ui,sans-serif; white-space:nowrap; }
    .topbar .project span { overflow:hidden; text-overflow:ellipsis; }
    .topbar .divider { flex:none; color:var(--ui-text-muted); }
    .topbar strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    @media (max-width:767.98px) { .topbar { display:none; } }
    @media (display-mode: window-controls-overlay) { .topbar { -webkit-app-region:drag; } }
    .main { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; align-items:center; padding:24px; overflow:auto; }
    .main.setup { justify-content:flex-start; }
    .content { width:min(100%,780px); }
    h1 { font-size:28px; font-weight:600; margin:0 0 20px; }
    .controls { display:flex; align-items:center; flex-wrap:wrap; gap:7px; padding-bottom:9px; border-bottom:1px solid var(--ui-border); }
    label { display:flex; flex-direction:column; gap:5px; color:var(--ui-text-muted); font-size:11px; }
    .controls label { display:block; }
    .controls .project { min-width:0; }
    .controls .harness { min-width:0; }
    .chat-picker { position:relative; min-width:0; }
    .chat-picker summary { display:flex; align-items:center; box-sizing:border-box; height:31px; max-width:170px; padding:0 29px 0 9px; border:1px solid var(--ui-border); border-radius:8px; background:var(--ui-surface-raised); color:var(--ui-text); cursor:pointer; font-size:12px; list-style:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .chat-picker summary::-webkit-details-marker { display:none; }
    .chat-picker summary::after { content:'⌄'; position:absolute; right:10px; color:var(--ui-text-muted); }
    .chat-picker summary:hover,.chat-picker[open] summary { border-color:var(--ui-accent); }
    .chat-picker .panel { position:absolute; z-index:30; top:37px; width:min(350px,calc(100vw - 44px)); max-height:min(48vh,340px); overflow:auto; box-sizing:border-box; padding:8px; border:1px solid var(--ui-border); border-radius:14px; background:var(--ui-surface-raised); box-shadow:var(--ui-shadow-overlay); }
    .bundle-picker .panel { left:0; }
    .settings-picker .panel { right:0; }
    .chat-picker .heading { padding:8px 10px 5px; color:var(--ui-text-muted); font-size:10px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; }
    .chat-picker .divider { height:1px; margin:7px 5px; background:var(--ui-border); }
    .chat-picker .hint { color:var(--ui-text-muted); font-size:11px; }
    .chat-picker .model-list { max-height:180px; overflow-y:auto; }
    .chat-picker .custom-model { width:calc(100% - 20px); margin:6px 10px; }
    .catalog-status { color:var(--ui-text-muted); font-size:11px; }
    .controls mux-ui-switch { margin-left:auto; }
    .composer-actions { display:flex; align-items:center; gap:7px; padding-top:8px; border-top:1px solid var(--ui-border); }
    .composer-actions .send { margin-left:auto; }
    .controls mux-ui-select { max-width:150px; }
    .project-picker { position:relative; }
    .project-trigger { box-sizing:border-box; width:auto; max-width:150px; height:31px; display:flex; align-items:center; gap:6px; padding:0 9px; border:1px solid var(--ui-border); border-radius:8px; background:color-mix(in srgb,var(--ui-accent) 9%,var(--ui-surface-raised)); color:var(--ui-text); font-size:12px; font-weight:600; text-align:left; }
    .project-trigger:hover,.project-trigger[aria-expanded="true"] { border-color:var(--ui-accent); }
    .project-trigger:focus-visible { outline:2px solid var(--ui-accent); outline-offset:2px; }
    .project-trigger .project-name { flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .project-trigger .project-symbol { display:flex; color:var(--ui-accent); }
    .project-trigger .down { display:flex; margin-left:auto; color:var(--ui-text-muted); }
    .project-options { position:absolute; z-index:20; top:36px; left:0; width:270px; max-width:min(270px,calc(100vw - 72px)); max-height:280px; overflow:auto; padding:5px; border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); box-shadow:var(--ui-shadow-menu); }
    .project-option { width:100%; display:flex; align-items:center; gap:9px; padding:8px; border:0; border-radius:6px; background:transparent; color:var(--ui-text); text-align:left; }
    .project-option:hover,.project-option[selected] { background:color-mix(in srgb,var(--ui-accent) 15%,transparent); }
    .project-option .option-copy { flex:1; min-width:0; display:grid; gap:1px; }
    .project-option .option-copy strong,.project-option .option-copy small { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .project-option .option-copy small { color:var(--ui-text-muted); font-size:10px; }
    .project-option svg { flex:none; color:var(--ui-accent); }
    .project-divider { height:1px; margin:4px 6px; background:var(--ui-border); }
    .folder { display:grid; gap:var(--ui-space-3); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .folder-line { display:flex; align-items:center; gap:var(--ui-space-3); }
    .folder-line mux-ui-text-field { flex:1; min-width:0; }
    button { cursor:pointer; font:inherit; }
    .picker { max-height:240px; overflow:auto; border:1px solid var(--ui-border); border-radius:9px; margin:0 0 14px; background:var(--ui-surface-raised); }
    .picker-head { display:flex; align-items:center; gap:8px; padding:8px; border-bottom:1px solid var(--ui-border); }
    .picker-head span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .picker button { border:0; color:inherit; background:transparent; padding:6px 10px; border-radius:5px; }
    .picker button:hover { background:var(--ui-surface-hover); }
    .picker-create { display:flex; align-items:center; gap:var(--ui-space-3); padding:var(--ui-space-4); border-bottom:1px solid var(--ui-border); }
    .picker-create mux-ui-text-field { flex:1; }
    .folder-entry { display:block; width:100%; text-align:left; }
    .composer { position:relative; display:flex; flex-direction:column; gap:9px; border:1px solid var(--ui-border); border-radius:18px; background:var(--ui-surface-raised); padding:15px 14px 10px; transition:border-color .15s,box-shadow .15s; }
    .composer:focus-within { border-color:color-mix(in srgb,var(--ui-accent) 58%,var(--ui-border)); box-shadow:0 0 0 2px color-mix(in srgb,var(--ui-accent) 14%,transparent); }
    .textarea-sizing { position:relative; width:100%; min-width:0; min-height:56px; max-height:220px; font:16px/1.55 system-ui,sans-serif; }
    textarea { box-sizing:border-box; display:block; width:100%; min-width:0; min-height:56px; max-height:220px; resize:none; border:0; outline:0; padding:3px 0; color:inherit; background:transparent; font:inherit; overflow-y:auto; }
    .native-textarea-sizing textarea { field-sizing:content; height:auto; }
    .legacy-textarea-sizing textarea { position:absolute; inset:0; height:100%; min-height:0; max-height:none; }
    .textarea-mirror { box-sizing:border-box; width:100%; min-height:56px; max-height:220px; padding:3px 0; visibility:hidden; white-space:pre-wrap; overflow-wrap:break-word; overflow-y:auto; }
    .native-textarea-sizing .textarea-mirror { display:none; }
    textarea::placeholder { color:var(--ui-text-muted); opacity:.8; }
    .attachments { display:flex; flex-wrap:wrap; gap:8px; }
    .attachment { position:relative; display:flex; align-items:center; gap:9px; min-width:0; max-width:min(100%,230px); padding:5px 28px 5px 5px; border:1px solid var(--ui-border); border-radius:10px; background:var(--ui-surface-raised); }
    .attachment img { flex:none; width:52px; height:52px; object-fit:cover; border-radius:6px; background:var(--ui-surface-base); }
    .attachment .filename { min-width:0; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
    .attachment .status { color:var(--ui-text-muted); font-size:11px; }
    .attachment .status.failed { color:var(--ui-danger-text); }
    .attachment button { position:absolute; top:4px; right:4px; width:22px; height:22px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--ui-text-muted); font-size:18px; line-height:20px; }
    .attachment button:hover { background:var(--ui-surface-hover); color:inherit; }
    .file-input { display:none; }
    .drop-overlay { position:absolute; inset:8px; z-index:10; display:grid; place-items:center; border:2px dashed var(--ui-accent); border-radius:16px; background:color-mix(in srgb, var(--ui-surface-base) 92%, transparent); color:var(--ui-text); font-size:22px; pointer-events:none; }
    .main > .content > mux-ui-feedback { margin:var(--ui-space-5) 0; }
    .setup-intro { margin:0 0 18px; color:var(--ui-text-muted); font-size:14px; }
    .setup-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:10px; }
    .setup-card { padding:15px; border:1px solid var(--ui-border); border-radius:13px; background:var(--ui-surface-raised); }
    .setup-card h2 { margin:0 0 8px; font-size:15px; }
    .setup-card code { display:block; min-height:42px; padding:8px; border-radius:7px; overflow-wrap:anywhere; background:var(--ui-surface-base); color:var(--ui-text); font:12px/1.45 ui-monospace,SFMono-Regular,monospace; }
    .setup-card p { margin:9px 0; color:var(--ui-text-muted); font-size:12px; }
    .setup-actions { display:flex; align-items:center; gap:12px; margin-top:10px; }
    .setup-actions a { color:var(--ui-accent); text-decoration:none; }
    .setup-refresh { margin-top:var(--ui-space-6); }
    .setup-terminal { margin-bottom:var(--ui-space-6); }
    .receipt { display:flex; align-items:center; gap:8px; margin:12px 2px 0; color:var(--ui-text-muted); font-size:12px; }
    .receipt::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--ui-accent); animation:receipt-pulse 1.35s ease-in-out infinite; }
    @keyframes receipt-pulse { 50% { opacity:.35; transform:scale(.7); } }
    @media (prefers-reduced-motion:reduce) { .receipt::before { animation:none; } }
    .location-settings { min-width:0; }
    .location-trigger { display:flex; align-items:center; gap:6px; box-sizing:border-box; max-width:230px; height:31px; padding:0 9px; border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text); font-size:var(--ui-text-sm); white-space:nowrap; }
    .location-settings .folder-symbol { display:flex; flex:none; color:var(--ui-accent); }
    .location-settings .folder-label { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .location-trigger:hover,.location-trigger[aria-expanded="true"] { border-color:var(--ui-accent); }
    .location-trigger:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    .location-fields { display:grid; gap:var(--ui-space-5); box-sizing:border-box; max-height:min(80dvh,var(--ui-dialog-compact-max-height)); overflow:auto; padding:var(--ui-space-6); }
    .location-head { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-5); }
    .location-head h2 { margin:0; color:var(--ui-text); font-size:var(--ui-text-xl); }
    .location-actions { display:flex; justify-content:flex-end; border-top:1px solid var(--ui-border); padding-top:var(--ui-space-5); }
    .location-note { margin:0; color:var(--ui-text-muted); font-size:11px; }
    @media(max-width:550px) {
      .main { padding:16px; }
      h1 { font-size:24px; }
      .controls { position:relative; gap:6px; }
      .controls mux-ui-select { max-width:125px; }
      .project-trigger { max-width:135px; }
      .location-fields { padding-bottom:max(var(--ui-space-6),env(safe-area-inset-bottom)); }
    }
    ${choicePickerSheetStyles}
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
    void this.loadStartOptions();
    if (this.initialFolder) this.folder = this.initialFolder;
    if (this.initialProject) this.projectId = this.initialProject;
    document.addEventListener('pointerdown', this.closeDropdowns);
    this.unsub = sdkChats.subscribe(() => this.requestUpdate());
    void sdkChats.refresh().then(() => { const project = sdkChats.projects.find(p => p.id === this.projectId); if (project) this.folder = project.path; });
    void sdkChats.folders().then(listing => { this.listing = listing; if (!this.folder) { this.folder = listing.base; void this.loadCatalog(); } }).catch(error => { this.error = String(error); });
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
  private async browse(path = this.folder) {
    try { this.listing = await sdkChats.folders(path); if (this.listing.path === path) { this.folder = this.listing.path; this.onFolderChanged(); } this.pickerOpen = true; this.error = ''; }
    catch (error) { this.error = String(error); }
  }
  private onFolderChanged() {
    const selected = sdkChats.projects.find(p => p.id === this.projectId);
    if (selected && selected.path !== this.folder) this.projectId = 'new';
    if (this.catalogTimer) window.clearTimeout(this.catalogTimer);
    this.catalogTimer = window.setTimeout(() => { this.catalogTimer = undefined; void this.loadCatalog(); }, 400);
  }
  private locationLabel() {
    if (!this.folder) return 'Choose a folder';
    const clean = (path: string) => {
      if (!path.startsWith('/')) return path;
      const parts: string[] = [];
      for (const part of path.split('/')) {
        if (part === '..') parts.pop();
        else if (part && part !== '.') parts.push(part);
      }
      return `/${parts.join('/')}`;
    };
    const folder = clean(this.folder);
    const base = this.listing?.base ? clean(this.listing.base) : '';
    if (base && folder === base) return base.split('/').filter(Boolean).at(-1) || '/';
    if (base && folder.startsWith(base === '/' ? '/' : `${base}/`)) return folder.slice(base === '/' ? 1 : base.length + 1);
    return folder;
  }
  private onProjectChange(value: string) {
    this.projectId = value;
    this.projectPickerOpen = false;
    if (value === 'new') this.locationOpen = true;
    const project = sdkChats.projects.find(p => p.id === value);
    if (project) this.folder = project.path;
    else if (value === 'ungrouped' && this.listing) this.folder = this.listing.base;
    if (value === 'ungrouped' || value === 'new') this.workMode = 'local';
    void this.loadCatalog();
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
    const previous = this.catalogHarness === this.harness && this.catalogPath === path ? this.catalog : undefined;
    const previousModel = this.model;
    const previousEffort = this.effort;
    this.catalogLoading = true;
    this.catalogError = '';
    this.catalog = previous;
    const params = new URLSearchParams({ harness:this.harness, projectPath:path, bundle:this.bundle, provider:this.harness === 'amplifier' ? this.provider === 'configured' ? '' : this.provider : '' });
    try {
      const response = await fetch(apiPath(`/api/sdk-chat-catalog?${params}`));
      if (!response.ok) throw new Error((await response.text()).trim());
      const catalog = await response.json() as ChatCatalog;
      if (!this.isConnected || version !== this.catalogVersion) return;
      this.catalog = catalog;
      this.catalogHarness = this.harness;
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
    return html`<details class="chat-picker choice-picker-sheet bundle-picker" aria-label="Bundle" @keydown=${closeChoicePickerOnEscape}><summary>${this.bundle || 'Bundle'}</summary><div class="panel">
      <div class="heading">Bundle</div>
      ${(this.catalog?.bundles || []).map(value => this.pickerChoice(value, '', this.bundle === value, () => { this.bundle = value; this.provider = 'configured'; void this.loadCatalog(); }))}
      ${this.catalogLoading ? html`<div class="catalog-status" role="status">Loading models…</div>` : nothing}
    </div></details>`;
  }
  private renderModelPicker(models: ModelOption[], selectedModel: ModelOption | undefined, efforts: string[]) {
    const effortIndex = Math.max(0, efforts.indexOf(this.effort || selectedModel?.defaultEffort || efforts[0]));
    const modelLabel = selectedModel?.label || this.model || (this.catalog?.defaultModel ? `Default (${this.catalog.defaultModel})` : 'Model');
    return html`<details class="chat-picker choice-picker-sheet settings-picker" aria-label="Provider, model and thinking" @keydown=${closeChoicePickerOnEscape}><summary>${modelLabel}${this.effort ? ` · ${this.effort}` : ''}</summary><div class="panel">
      <div class="heading">Provider</div>
      ${this.harness === 'amplifier' ? (this.catalog?.providers || []).map(value => this.pickerChoice(providerLabel(value), '', this.provider === value, () => { this.provider = value; void this.loadCatalog(); })) : html`<div class="hint">${this.harness === 'codex' ? 'OpenAI' : this.harness === 'claude' ? 'Anthropic' : 'Configured in agent'} · managed by ${sdkHarnessLabel(this.harness)}</div>`}
      <div class="divider"></div><div class="heading">Model</div>
      <div class="model-list">
        ${this.harness !== 'amplifier' ? this.pickerChoice(this.catalog?.defaultModel ? `Harness default (${this.catalog.defaultModel})` : 'Harness default', '', !this.customModel && !this.model, () => this.onModelChange('')) : nothing}
        ${this.model && !selectedModel && !this.customModel ? this.pickerChoice(this.model, '', true, () => this.onModelChange(this.model)) : nothing}
        ${models.map(item => this.pickerChoice(item.label, item.id, !this.customModel && this.model === item.id, () => this.onModelChange(item.id)))}
        ${this.pickerChoice('Other model ID…', '', this.customModel, () => this.onModelChange('__custom__'))}
      </div>
      ${this.customModel ? html`<mux-ui-text-field class="custom-model" aria-label="Model ID" placeholder="Model ID" .value=${this.model} @input=${(event:Event) => { this.model = (event.target as MuxUITextField).value; }}></mux-ui-text-field>` : nothing}
      ${efforts.length > 1 ? html`<div class="divider"></div><mux-ui-range-field label="Thinking" accessible-label="Thinking effort" .min=${0} .max=${efforts.length - 1} .value=${effortIndex} .valueLabels=${efforts} .minLabel=${efforts[0]} .maxLabel=${efforts[efforts.length - 1]} @input=${(event:Event) => { this.effort = efforts[(event.target as MuxUIRangeField).value]; }}></mux-ui-range-field>` : nothing}
      ${this.catalogLoading ? html`<div class="catalog-status" role="status">Loading models…</div>` : nothing}
    </div></details>`;
  }
  private async loadStartOptions() {
    try {
      const response = await fetch(apiPath('/api/sdk-chat-start-options'));
      if (!response.ok) throw new Error(await response.text());
      const options = await response.json() as StartOption[];
      if (!this.isConnected) return;
      this.startOptions = options;
      const selected = options.find(item => item.harness === this.initialHarness) || options[0];
      if (selected) this.onHarnessChange(selected.harness);
      else this.error = '';
    } catch (error) {
      if (this.isConnected) this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private async copySetup(command: string, name: string) {
    try { await navigator.clipboard.writeText(command); this.copiedSetup = name; this.error = ''; }
    catch { this.error = 'Could not copy the command. Select it above and copy it manually.'; }
  }
  private onDragEnter(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth++; this.dropActive = true; }
  private onDragOver(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; this.dropActive = true; }
  private onDragLeave(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth = Math.max(0, this.dragDepth - 1); if (!this.dragDepth) this.dropActive = false; }
  private onDrop(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); event.stopPropagation(); this.resetDrop(); this.addFiles(Array.from(event.dataTransfer?.files || [])); }
  private onPick(event: Event) { const input = event.target as HTMLInputElement; this.addFiles(Array.from(input.files || [])); input.value = ''; }
  private onPaste(event: ClipboardEvent) {
    const images = Array.from(event.clipboardData?.items || [])
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile()).filter((file): file is File => file !== null);
    if (!images.length) return;
    event.preventDefault();
    this.addFiles(images.map((file, index) => new File([file],
      `Pasted image ${new Date().toISOString().replace(/[:.]/g, '-')}${images.length > 1 ? `-${index + 1}` : ''}.${file.type.split('/')[1] || 'png'}`,
      { type: file.type })));
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
      const response = await fetch(apiPath('/api/sdk-chat-attachments'), { method:'POST', headers:{'X-Muxterm-Chat-Attachment':'1'}, body:form });
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
    if ((!prompt && !this.attachments.length) || this.busy || this.catalogLoading || !this.catalog || (this.customModel && !this.model.trim()) || !this.startOptions?.some(item => item.harness === this.harness) || this.attachments.some(a => a.uploading || a.error)) return;
    this.busy = true; this.error = '';
    try {
      await this.updateComplete;
      let workspaceId: string | undefined;
      if (this.projectId === 'new') {
        if (!this.folder.startsWith('/')) throw new Error('Choose an absolute folder for the new project.');
        workspaceId = (await sdkChats.createProject(this.folder, this.projectName.trim())).id;
      } else if (this.projectId !== 'ungrouped') workspaceId = this.projectId;
      const chat = await sdkChats.create({ workspaceId, projectPath:this.folder, workMode:this.workMode, harness:this.harness, provider:this.provider, bundle:this.bundle, model:this.model.trim(), effort:this.effort, prompt, attachments:this.attachments.map(a => a.id!) });
      this.dispatchEvent(new CustomEvent('chat-created', { detail:{sessionId:chat.id}, bubbles:true, composed:true }));
    } catch (error) { this.error = error instanceof Error ? error.message.trim() : String(error); }
    finally { this.busy = false; }
  }
  private renderTopbar(projectName: string) {
    return html`<header class="topbar" aria-label="New chat"><span class="project">${icon(Folder, { size: 14 })}<span>${projectName}</span></span><span class="divider" aria-hidden="true">›</span><strong>New chat</strong></header>`;
  }

  override render() {
    const selectedProject = sdkChats.projects.find(project => project.id === this.projectId);
    const projectName = selectedProject?.name || (this.projectId === 'new' ? this.projectName || 'New project' : 'Ungrouped');
    const models = this.catalog?.models || [];
    const selectedModel = models.find(item => item.id === this.model);
    const efforts = selectedModel?.efforts?.length ? selectedModel.efforts : this.harness === 'codex' && this.model ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : [];
    if (this.startOptions?.length === 0) return html`
      ${this.renderTopbar(projectName)}
      <div class="main setup"><div class="content">
        <h1>Choose your coding agent</h1>
        <p class="setup-intro">Install an agent in a terminal, sign in to its provider, then refresh this list. Muxterm will use the agent already on your computer.</p>
        <mux-ui-button class="setup-terminal" variant="secondary" @click=${() => this.dispatchEvent(new CustomEvent('workspace-create', { detail:{host:''}, bubbles:true, composed:true }))}>Open a terminal in muxterm</mux-ui-button>
        <div class="setup-list">${SETUP_AGENTS.map(agent => html`
          <section class="setup-card"><h2>${agent.name}</h2>
            <code>${agent.command}</code>
            <p>After installing, run <strong>${agent.login}</strong> to connect your account.</p>
            <div class="setup-actions"><mux-ui-button size="small" variant="secondary" @click=${() => void this.copySetup(agent.command, agent.name)}>${this.copiedSetup === agent.name ? 'Copied' : 'Copy install command'}</mux-ui-button><a href=${agent.docs} target="_blank" rel="noopener noreferrer">Setup guide ↗</a></div>
          </section>`)}</div>
        <mux-ui-button class="setup-refresh" variant="secondary" @click=${() => void this.loadStartOptions()}>Refresh installed agents</mux-ui-button>
        ${this.error ? html`<mux-ui-feedback kind="error" appearance="panel">${this.error}</mux-ui-feedback>` : nothing}
      </div></div>`;
    return html`
    ${this.renderTopbar(projectName)}
    <div class="main"><div class="content">
      <h1>What would you like to do?</h1>
      <div class="composer" @paste=${this.onPaste} @dragenter=${this.onDragEnter} @dragover=${this.onDragOver} @dragleave=${this.onDragLeave} @drop=${this.onDrop}>
        <div class="controls">
        <div class="project"><div class="project-picker"><button class="project-trigger" role="combobox" aria-label="Project" aria-expanded=${this.projectPickerOpen} aria-controls="project-options" @click=${() => { this.projectPickerOpen = !this.projectPickerOpen; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Escape') this.projectPickerOpen = false; if (e.key === 'ArrowDown') this.projectPickerOpen = true; }}><span class="project-symbol">${icon(this.projectId === 'new' ? Plus : Folder,{size:15})}</span><span class="project-name">${selectedProject?.name || (this.projectId === 'new' ? 'New project' : 'Ungrouped')}</span><span class="down">${icon(ChevronDown,{size:16})}</span></button>
          ${this.projectPickerOpen ? html`<div id="project-options" class="project-options" role="listbox" aria-label="Projects">
            <button class="project-option" role="option" aria-selected=${this.projectId === 'ungrouped'} ?selected=${this.projectId === 'ungrouped'} @click=${() => this.onProjectChange('ungrouped')}>${icon(Folder,{size:16})}<span class="option-copy"><strong>Ungrouped</strong><small>Choose a folder for this chat</small></span></button>
            ${sdkChats.projects.map(p => html`<button class="project-option" role="option" aria-selected=${this.projectId === p.id} ?selected=${this.projectId === p.id} title=${p.path} @click=${() => this.onProjectChange(p.id)}>${icon(Folder,{size:16})}<span class="option-copy"><strong>${p.name}</strong><small>${p.path}</small></span></button>`)}
            <div class="project-divider"></div><button class="project-option" role="option" aria-selected=${this.projectId === 'new'} ?selected=${this.projectId === 'new'} @click=${() => this.onProjectChange('new')}>${icon(Plus,{size:16})}<span class="option-copy"><strong>New project</strong><small>Choose its primary folder</small></span></button>
          </div>` : nothing}
        </div></div>
        <div class="location-settings"><button class="location-trigger" type="button" aria-haspopup="dialog" aria-expanded=${this.locationOpen} aria-label="Chat location" title=${this.folder} @click=${() => { this.locationOpen = true; }}><span class="folder-symbol">${icon(Folder,{size:14})}</span><span class="folder-label">${this.locationLabel()}</span></button>
          ${this.locationOpen ? html`<mux-ui-dialog size="compact" presentation="adaptive" label="Chat location" open @dismiss=${() => { this.locationOpen = false; this.pickerOpen = false; }}>
          <div class="location-fields">
            <div class="location-head"><h2>Chat location</h2><mux-ui-button icon-only variant="quiet" size="small" accessible-label="Close chat location" @click=${() => { this.locationOpen = false; this.pickerOpen = false; }}>${icon(X,{size:17})}</mux-ui-button></div>
            <div class="folder"><span>${this.projectId === 'ungrouped' ? 'Folder' : 'Primary folder'}</span><div class="folder-line"><mux-ui-text-field aria-label="Primary folder" .value=${this.folder} ?readonly=${this.projectId !== 'ungrouped' && this.projectId !== 'new'} @input=${(e:Event) => { this.folder = (e.target as MuxUITextField).value; this.onFolderChanged(); }}></mux-ui-text-field>${this.projectId === 'ungrouped' || this.projectId === 'new' ? html`<mux-ui-button size="small" accessible-label="Browse server folders" @click=${() => void this.browse()}>Browse</mux-ui-button>` : nothing}</div></div>
            ${this.projectId === 'new' ? html`<mux-ui-text-field label="Project name" aria-label="Project name" placeholder="Defaults to the folder name" .value=${this.projectName} @input=${(e:Event) => { this.projectName = (e.target as MuxUITextField).value; }}></mux-ui-text-field>` : nothing}
            ${this.pickerOpen && this.listing ? html`<div class="picker" aria-label="Server folder picker"><div class="picker-head"><button aria-label="Parent folder" @click=${() => void this.browse(this.listing!.parent)}>↑</button><span>${this.listing.path}</span><button @click=${() => { this.pickerOpen = false; }}>Choose this folder</button></div><div class="picker-create"><mux-ui-text-field aria-label="New folder name" placeholder="New folder name" .value=${this.newFolderName} @input=${(e:Event) => { this.newFolderName = (e.target as MuxUITextField).value; }}></mux-ui-text-field><mux-ui-button size="small" @click=${() => { if (!this.newFolderName.trim() || this.newFolderName.includes('/')) return; this.folder = `${this.listing!.path.replace(/\/$/,'')}/${this.newFolderName.trim()}`; this.onFolderChanged(); this.pickerOpen = false; }}>Use new folder</mux-ui-button></div>${this.listing.folders.map(name => html`<button class="folder-entry" @click=${() => void this.browse(`${this.listing!.path.replace(/\/$/,'')}/${name}`)}>▸ ${name}</button>`)}</div>` : nothing}
            <p class="location-note">${this.workMode === 'worktree' ? 'A separate Git worktree will be created from this project’s primary folder.' : this.projectId === 'ungrouped' ? 'This chat will use the chosen folder.' : 'This chat will use the project’s primary folder.'}${selectedProject?.sourceFolders?.length ? ` ${selectedProject.sourceFolders.length} additional source ${selectedProject.sourceFolders.length === 1 ? 'folder is' : 'folders are'} available at their existing paths.` : ''}</p>
            <div class="location-actions"><mux-ui-button variant="primary" @click=${() => { this.locationOpen = false; this.pickerOpen = false; }}>Done</mux-ui-button></div>
          </div>
          </mux-ui-dialog>` : nothing}
        </div>
        ${this.startOptions?.length ? html`<mux-ui-select class="harness" aria-label="Harness" .value=${this.harness} .options=${this.startOptions.map(option => ({ value:option.harness, label:sdkHarnessLabel(option.harness) }))} @change=${(e:Event) => this.onHarnessChange((e.target as MuxUISelect).value as SDKHarnessName)}></mux-ui-select>` : nothing}
        ${this.harness === 'amplifier' && this.catalog ? this.renderBundlePicker() : nothing}
        ${this.catalog ? this.renderModelPicker(models, selectedModel, efforts) : nothing}
        ${this.catalogLoading ? html`<span class="catalog-status" role="status">Loading models…</span>` : nothing}
        <mux-ui-switch label="Worktree" accessible-label="Use a separate Git worktree" .checked=${this.workMode === 'worktree'} .tooltip=${this.projectId === 'ungrouped' || this.projectId === 'new' ? 'Choose an existing project to use a worktree' : 'Start this chat in a separate Git worktree'} ?disabled=${this.projectId === 'ungrouped' || this.projectId === 'new'} @change=${(event:CustomEvent<{checked:boolean}>) => { this.workMode = event.detail.checked ? 'worktree' : 'local'; }}></mux-ui-switch>
        </div>
        ${this.attachments.length ? html`<div class="attachments" aria-label="Attached files">${this.attachments.map(a => html`<div class="attachment">${a.preview ? html`<img src=${a.preview} alt="">` : nothing}<span class="filename">${a.file.name}</span><span class="status ${a.error ? 'failed' : ''}">${a.error || (a.uploading ? 'Uploading…' : 'Ready')}</span><button aria-label=${`Remove ${a.file.name}`} @click=${() => this.removeAttachment(a.localId)}>×</button></div>`)}</div>` : nothing}
        <div class="textarea-sizing ${nativeTextareaSizing ? 'native-textarea-sizing' : 'legacy-textarea-sizing'}"><textarea aria-label="First message" placeholder="Describe what you want to work on…" .value=${this.prompt} @input=${this.onPromptInput} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea><div class="textarea-mirror" aria-hidden="true"></div></div>
        <div class="composer-actions"><input class="file-input" type="file" multiple aria-label="Choose files to attach" @change=${this.onPick}><mux-ui-button icon-only variant="quiet" accessible-label="Attach files or images" tooltip="Attach files or images" @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>('.file-input')?.click()}>${icon(Paperclip,{size:18})}</mux-ui-button><mux-ui-button class="send" icon-only variant="primary" accessible-label="Send message" ?disabled=${(!this.promptHasContent && !this.attachments.length) || this.busy || this.catalogLoading || !this.catalog || (this.customModel && !this.model.trim()) || !this.startOptions?.some(item => item.harness === this.harness) || this.attachments.some(a => a.uploading || !!a.error)} @click=${() => void this.send()}>${icon(ArrowUp,{size:18})}</mux-ui-button></div>

        ${this.dropActive ? html`<div class="drop-overlay" role="status">Drop files to attach</div>` : nothing}
      </div>
      ${this.busy ? html`<div class="receipt" role="status">Message received · Creating chat…</div>` : nothing}
      ${this.catalogError ? html`<mux-ui-feedback kind="error" appearance="panel">Could not load models: ${this.catalogError}<mux-ui-button slot="action" size="small" @click=${() => void this.loadCatalog()}>Retry</mux-ui-button></mux-ui-feedback>` : nothing}
      ${this.error ? html`<mux-ui-feedback kind="error" appearance="panel">${this.error}</mux-ui-feedback>` : nothing}
    </div></div>
  `; }
}
