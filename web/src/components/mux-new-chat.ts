import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sdkChats, sdkHarnessLabel, type FolderListing, type SDKHarnessName } from '../lib/sdk-chats.js';
import { apiPath } from '../lib/base-path.js';
import { ArrowUp, Folder, Paperclip, Plus, X } from 'lucide';
import { icon } from '../lib/icons.js';
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
import type { SelectComboboxOption } from '../ui/select-combobox.js';
import '../ui/select-combobox.js';
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
  { name:'Codex', command:'npm install -g @openai/codex@latest', login:'codex login', docs:'https://developers.openai.com/codex/cli/' },
  { name:'Claude Code', command:'curl -fsSL https://claude.ai/install.sh | bash', login:'claude', docs:'https://code.claude.com/docs/en/setup' },
  { name:'OpenCode · ACP', command:'curl -fsSL https://opencode.ai/install | bash', login:'opencode', docs:'https://opencode.ai/docs/' },
  { name:'Pi · ACP', command:'npm install -g @mariozechner/pi-coding-agent pi-acp', login:'pi', docs:'https://github.com/svkozak/pi-acp' },
  { name:'DeepSeek Harness · ACP', command:'npm install -g @deepseek-ai/dsh', login:'dsh web', docs:'https://github.com/deepseek-ai/deepseek-harness' },
  { name:'Gemini CLI · ACP', command:'npm install -g @google/gemini-cli', login:'NO_BROWSER=true gemini', docs:'https://geminicli.com/docs/get-started/authentication/' },
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
  @state() private busy = false;
  @state() private error = '';
  @state() private copiedSetup = '';
  @state() private setupOpen = false;
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
    if (this.pickerOpen && !inside('.location-settings')) this.pickerOpen = false;
  };
  private closeLocation() {
    this.locationOpen = false;
    this.pickerOpen = false;
    void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLElement>('.location-trigger')?.focus());
  }

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
    .controls mux-ui-select { max-width:var(--ui-new-chat-harness-width); }
    .project mux-ui-select-combobox { max-width:var(--ui-picker-trigger-compact-width); }
    .folder { display:grid; gap:var(--ui-space-3); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .folder-line { display:flex; align-items:center; gap:var(--ui-space-3); }
    .folder-line mux-ui-text-field { flex:1; min-width:0; }
    mux-ui-folder-browser { margin-bottom:var(--ui-space-4); }
    .composer { position:relative; display:flex; flex-direction:column; gap:var(--ui-space-4); border:1px solid var(--ui-border); border-radius:var(--ui-radius-2xl); background:var(--ui-surface-raised); padding:var(--ui-space-6) var(--ui-space-6) var(--ui-space-5); transition:border-color var(--ui-motion-fast),box-shadow var(--ui-motion-fast); }
    .composer:focus-within { border-color:color-mix(in srgb,var(--ui-accent) 58%,var(--ui-border)); box-shadow:0 0 0 2px color-mix(in srgb,var(--ui-accent) 14%,transparent); }
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
    .setup-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(var(--ui-new-chat-setup-card-width),1fr)); gap:var(--ui-space-5); }
    .setup-card { padding:var(--ui-space-6); border:1px solid var(--ui-border); border-radius:var(--ui-radius-xl); background:var(--ui-surface-raised); }
    .setup-card h2 { margin:0 0 var(--ui-space-4); font-size:var(--ui-text-xl); }
    .setup-card code { display:block; min-height:var(--ui-control-lg); padding:var(--ui-space-4); border-radius:var(--ui-radius-md); overflow-wrap:anywhere; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-sm)/1.45 var(--ui-font-mono); }
    .setup-card p { margin:var(--ui-space-4) 0; color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
    .setup-actions { display:flex; align-items:center; gap:var(--ui-space-5); margin-top:var(--ui-space-5); }
    .setup-actions a { color:var(--ui-accent); text-decoration:none; }
    .setup-refresh { margin-top:var(--ui-space-6); }
    .setup-terminal { margin-bottom:var(--ui-space-6); }
    .setup-back { margin-bottom:var(--ui-space-6); }
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
      .controls mux-ui-select { max-width:var(--ui-new-chat-harness-phone-width); }
      .location-trigger::part(button) { min-height:var(--ui-control-lg); }
      .location-fields { padding-bottom:max(var(--ui-space-6),env(safe-area-inset-bottom)); }
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
    try { this.listing = await sdkChats.folders(path); this.pickerOpen = true; this.error = ''; }
    catch (error) { this.error = String(error); }
  }
  private onFolderChanged() {
    const selected = sdkChats.projects.find(p => p.id === this.projectId);
    if (selected && selected.path !== this.folder) this.projectId = 'new';
    if (this.catalogTimer) window.clearTimeout(this.catalogTimer);
    this.catalogTimer = window.setTimeout(() => { this.catalogTimer = undefined; void this.loadCatalog(); }, 400);
  }
  private locationLabel() {
    if (sdkChats.projects.find(project => project.id === this.projectId)?.managedFolder) return 'No folder';
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
  private projectOptions(): SelectComboboxOption[] {
    return [
      {value:'ungrouped',label:'Ungrouped',description:'Choose a folder for this chat',icon:icon(Folder,{size:16})},
      ...sdkChats.projects.map(project => ({value:project.id,label:project.name,description:project.managedFolder ? 'No folder' : project.path,icon:icon(Folder,{size:16})})),
      {value:'new',label:'New project',description:'Choose its primary folder',icon:icon(Plus,{size:16}),separatorBefore:true},
    ];
  }
  private onProjectChange(value: string) {
    this.projectId = value;
    if (value === 'new') this.locationOpen = true;
    const project = sdkChats.projects.find(p => p.id === value);
    if (project) this.folder = project.path;
    else if (value === 'ungrouped' && this.listing) this.folder = this.listing.base;
    if (value === 'ungrouped' || value === 'new' || project?.managedFolder) this.workMode = 'local';
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
    return html`<mux-ui-choice-picker class="chat-picker bundle-picker" label="Bundle" .summary=${this.bundle || 'Bundle'} placement="below" panel-align="left">
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
    return html`<mux-ui-choice-picker class="chat-picker settings-picker" label="Provider, model and thinking" .summary=${`${modelLabel}${this.effort ? ` · ${this.effort}` : ''}`} placement="below" panel-align="right">
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
    try {
      const response = await fetch(apiPath('/api/sdk-chat-start-options'));
      if (!response.ok) throw new Error(await response.text());
      const options = await response.json() as StartOption[];
      if (!this.isConnected) return;
      this.startOptions = options;
      const selected = options.find(item => item.harness === this.initialHarness) || options[0];
      if (selected) { this.setupOpen = false; this.onHarnessChange(selected.harness); }
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
    return html`<mux-ui-screen-header .section=${projectName} heading="New chat" label="New chat" with-section-icon><span slot="section-icon">${icon(Folder,{size:14})}</span></mux-ui-screen-header>`;
  }

  override render() {
    const selectedProject = sdkChats.projects.find(project => project.id === this.projectId);
    const projectName = selectedProject?.name || (this.projectId === 'new' ? this.projectName || 'New project' : 'Ungrouped');
    const models = this.catalog?.models || [];
    const selectedModel = models.find(item => item.id === this.model);
    const efforts = selectedModel?.efforts?.length ? selectedModel.efforts : this.harness === 'codex' && this.model ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : [];
    if (this.startOptions?.length === 0 || this.setupOpen) return html`
      ${this.renderTopbar(projectName)}
      <div class="main setup"><div class="content">
        ${this.startOptions?.length ? html`<mux-ui-button class="setup-back" variant="quiet" @click=${() => { this.setupOpen = false; }}>Back to chat</mux-ui-button>` : nothing}
        <h1>${this.startOptions?.length ? 'Add a coding agent' : 'Choose your coding agent'}</h1>
        <p class="setup-intro">Install or update an agent in a terminal, sign in to its provider, then refresh this list. Muxterm uses the agent installed on your computer, including its version.</p>
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
        <div class="project"><mux-ui-select-combobox label="Project" appearance="tinted" .value=${this.projectId} .options=${this.projectOptions()} @change=${(event:CustomEvent<{value:string}>) => this.onProjectChange(event.detail.value)}></mux-ui-select-combobox></div>
        <div class="location-settings"><mux-ui-button class="location-trigger" variant="secondary" haspopup="dialog" .expanded=${this.locationOpen} accessible-label=${`Chat location: ${this.locationLabel()}`} tooltip=${selectedProject?.managedFolder ? 'Stored privately by Muxterm' : this.folder} @click=${() => { this.locationOpen = true; }}><span slot="leading" class="folder-symbol">${icon(Folder,{size:14})}</span><span class="folder-label">${this.locationLabel()}</span></mux-ui-button>
          ${this.locationOpen ? html`<mux-ui-dialog size="compact" presentation="adaptive" label="Chat location" open @dismiss=${this.closeLocation}>
          <div class="location-fields">
            <div class="location-head"><h2>Chat location</h2><mux-ui-button icon-only variant="quiet" size="small" accessible-label="Close chat location" @click=${this.closeLocation}>${icon(X,{size:17})}</mux-ui-button></div>
            ${selectedProject?.managedFolder ? nothing : html`<div class="folder"><span>${this.projectId === 'ungrouped' ? 'Folder' : 'Primary folder'}</span><div class="folder-line"><mux-ui-text-field aria-label="Primary folder" .value=${this.folder} ?readonly=${this.projectId !== 'ungrouped' && this.projectId !== 'new'} @input=${(e:Event) => { this.folder = (e.target as MuxUITextField).value; this.onFolderChanged(); }}></mux-ui-text-field>${this.projectId === 'ungrouped' || this.projectId === 'new' ? html`<mux-ui-button size="small" accessible-label="Browse server folders" @click=${() => void this.browse()}>Browse</mux-ui-button>` : nothing}</div></div>`}
            ${this.projectId === 'new' ? html`<mux-ui-text-field label="Project name" aria-label="Project name" placeholder="Defaults to the folder name" .value=${this.projectName} @input=${(e:Event) => { this.projectName = (e.target as MuxUITextField).value; }}></mux-ui-text-field>` : nothing}
            ${this.pickerOpen && this.listing ? html`<mux-ui-folder-browser aria-label="Server folder picker" .listing=${this.listing} allow-new-folder @folder-navigate=${(event:CustomEvent<{path:string}>) => void this.browse(event.detail.path)} @folder-choose=${(event:CustomEvent<{path:string}>) => { this.folder = event.detail.path; this.onFolderChanged(); this.pickerOpen = false; }} @folder-use-new=${(event:CustomEvent<{path:string}>) => { this.folder = event.detail.path; this.onFolderChanged(); this.pickerOpen = false; }}></mux-ui-folder-browser>` : nothing}
            <p class="location-note">${this.workMode === 'worktree' ? 'A separate Git worktree will be created from this project’s primary folder.' : selectedProject?.managedFolder ? 'No visible folder. New chats use this project’s private Muxterm storage.' : this.projectId === 'ungrouped' ? 'This chat will use the chosen folder.' : 'This chat will use the project’s primary folder.'}${selectedProject?.sourceFolders?.length ? ` ${selectedProject.sourceFolders.length} additional source ${selectedProject.sourceFolders.length === 1 ? 'folder is' : 'folders are'} available at their existing paths.` : ''}</p>
            <div class="location-actions"><mux-ui-button variant="primary" @click=${this.closeLocation}>Done</mux-ui-button></div>
          </div>
          </mux-ui-dialog>` : nothing}
        </div>
        ${this.startOptions?.length ? html`<mux-ui-select class="harness" aria-label="Harness" .value=${this.harness} .options=${this.startOptions.map(option => ({ value:option.harness, label:sdkHarnessLabel(option.harness) }))} @change=${(e:Event) => this.onHarnessChange((e.target as MuxUISelect).value as SDKHarnessName)}></mux-ui-select>` : nothing}
        <mux-ui-button size="small" variant="quiet" @click=${() => { this.setupOpen = true; }}>Add agent</mux-ui-button>
        ${this.harness === 'amplifier' && this.catalog ? this.renderBundlePicker() : nothing}
        ${this.catalog ? this.renderModelPicker(models, selectedModel, efforts) : nothing}
        ${this.catalogLoading ? html`<mux-ui-feedback kind="loading" density="compact">Loading models…</mux-ui-feedback>` : nothing}
        <mux-ui-switch label="Worktree" accessible-label="Use a separate Git worktree" .checked=${this.workMode === 'worktree'} .tooltip=${this.projectId === 'ungrouped' || this.projectId === 'new' || selectedProject?.managedFolder ? 'Choose a project with a Git folder to use a worktree' : 'Start this chat in a separate Git worktree'} ?disabled=${this.projectId === 'ungrouped' || this.projectId === 'new' || !!selectedProject?.managedFolder} @change=${(event:CustomEvent<{checked:boolean}>) => { this.workMode = event.detail.checked ? 'worktree' : 'local'; }}></mux-ui-switch>
        </div>
        ${this.attachments.length ? html`<div class="attachments" role="list" aria-label="Attached files">${this.attachments.map(a => html`<mux-ui-attachment role="listitem" file-name=${a.file.name} preview-url=${a.preview ?? ''} state=${a.error ? 'error' : a.uploading ? 'uploading' : 'ready'} error=${a.error ?? ''} @attachment-remove=${() => this.removeAttachment(a.localId)}></mux-ui-attachment>`)}</div>` : nothing}
        <div class="textarea-sizing ${nativeTextareaSizing ? 'native-textarea-sizing' : 'legacy-textarea-sizing'}"><textarea aria-label="First message" placeholder="Describe what you want to work on…" .value=${this.prompt} @input=${this.onPromptInput} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea><div class="textarea-mirror" aria-hidden="true"></div></div>
        <div class="composer-actions"><input class="file-input" type="file" multiple aria-label="Choose files to attach" @change=${this.onPick}><mux-ui-button icon-only variant="quiet" accessible-label="Attach files or images" tooltip="Attach files or images" @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>('.file-input')?.click()}>${icon(Paperclip,{size:18})}</mux-ui-button><mux-ui-button class="send" icon-only variant="primary" accessible-label="Send message" ?disabled=${(!this.promptHasContent && !this.attachments.length) || this.busy || this.catalogLoading || !this.catalog || (this.customModel && !this.model.trim()) || !this.startOptions?.some(item => item.harness === this.harness) || this.attachments.some(a => a.uploading || !!a.error)} @click=${() => void this.send()}>${icon(ArrowUp,{size:18})}</mux-ui-button></div>

        ${this.dropActive ? html`<div class="drop-overlay" role="status">Drop files to attach</div>` : nothing}
      </div>
      ${this.harness === 'gemini' ? html`<mux-ui-feedback kind="info" appearance="panel">Choose Google sign-in or a detected GEMINI_API_KEY in Settings → AI, then retry loading models. For terminal sign-in, run <code>NO_BROWSER=true gemini</code> and follow Gemini CLI's prompts.<mux-ui-button slot="action" size="small" variant="secondary" @click=${() => this.dispatchEvent(new CustomEvent('workspace-create', { detail:{host:''}, bubbles:true, composed:true }))}>Open terminal</mux-ui-button></mux-ui-feedback>` : nothing}
      ${this.busy ? html`<div class="receipt" role="status">Message received · Creating chat…</div>` : nothing}
      ${this.catalogError ? html`<mux-ui-feedback kind="error" appearance="panel">Could not load models: ${this.catalogError}<mux-ui-button slot="action" size="small" @click=${() => void this.loadCatalog()}>Retry</mux-ui-button></mux-ui-feedback>` : nothing}
      ${this.error ? html`<mux-ui-feedback kind="error" appearance="panel">${this.error}</mux-ui-feedback>` : nothing}
    </div></div>
  `; }
}
