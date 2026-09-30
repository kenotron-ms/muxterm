import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sdkChats, type FolderListing } from '../lib/sdk-chats.js';
import { LAUNCHABLE_HARNESSES, harnessLabel, type HarnessName } from '../lib/harness.js';
import { ChevronDown, Folder, Plus } from 'lucide';
import { icon } from '../lib/icons.js';

type ProviderName = 'openai' | 'anthropic' | 'configured';
const PROVIDERS: { value: ProviderName; label: string; harnesses: HarnessName[] }[] = [
  { value: 'openai', label: 'OpenAI', harnesses: ['codex', 'amplifier'] },
  { value: 'anthropic', label: 'Anthropic', harnesses: ['claude', 'amplifier'] },
  { value: 'configured', label: 'Configured (Amplifier)', harnesses: ['amplifier'] },
];
const providerFor = (harness: HarnessName): ProviderName =>
  harness === 'codex' ? 'openai' : harness === 'claude' ? 'anthropic' : 'configured';
const providerAvailable = (harness: HarnessName, provider: ProviderName): boolean =>
  PROVIDERS.some(choice => choice.value === provider && choice.harnesses.includes(harness));

@customElement('mux-new-chat')
export class MuxNewChat extends LitElement {
  @property() initialHarness: HarnessName = 'codex';
  @property() initialFolder = '';
  @property() initialProject = '';
  @state() private projectId = 'ungrouped';
  @state() private folder = '';
  @state() private workMode: 'local' | 'worktree' = 'local';
  @state() private projectName = '';
  @state() private newFolderName = '';
  @state() private harness: HarnessName = 'codex';
  @state() private provider: ProviderName = 'openai';
  @state() private providerNotice = '';
  @state() private prompt = '';
  @state() private listing?: FolderListing;
  @state() private pickerOpen = false;
  @state() private locationOpen = false;
  @state() private projectPickerOpen = false;
  @state() private busy = false;
  @state() private error = '';
  private unsub?: () => void;
  private readonly closeProjectPicker = (event: PointerEvent) => {
    if (!event.composedPath().includes(this)) this.projectPickerOpen = false;
  };

  static styles = css`
    :host { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; background:var(--chrome-bg,#1a1c28); color:var(--chrome-text-bright,#e2e6f1); font:13px/1.5 system-ui,sans-serif; }
    .top { padding:14px 24px; border-bottom:1px solid var(--chrome-border,#343a4c); font-size:14px; font-weight:600; }
    .main { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; align-items:center; padding:24px; }
    .content { width:min(100%,780px); }
    h1 { font-size:28px; font-weight:600; margin:0 0 20px; }
    .controls { display:flex; align-items:center; flex-wrap:wrap; gap:7px; border-top:1px solid var(--chrome-border,#475067); padding-top:9px; }
    label { display:flex; flex-direction:column; gap:5px; color:var(--chrome-text-dim,#a9b0c0); font-size:11px; }
    .controls label { display:block; }
    .controls .project { min-width:0; }
    .controls .where,.controls .harness,.controls .provider { min-width:0; }
    .controls .send { margin-left:auto; }
    select,input { box-sizing:border-box; width:100%; height:37px; border:1px solid var(--chrome-border,#475067); border-radius:8px; background:var(--chrome-bar,#252a39); color:var(--chrome-text-bright,#e2e6f1); padding:7px 9px; font:13px system-ui,sans-serif; }
    select { appearance:none; padding-right:29px; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23a9b9d6' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 8px center; }
    .controls select { height:31px; max-width:155px; padding:3px 29px 3px 9px; font-size:12px; }
    select:hover,.browse:hover { border-color:var(--chrome-accent,#9bb8f7); }
    select:focus-visible,input:focus-visible,.browse:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .project-picker { position:relative; }
    .project-trigger { box-sizing:border-box; width:auto; max-width:190px; height:31px; display:flex; align-items:center; gap:6px; padding:0 9px; border:1px solid var(--chrome-border,#475067); border-radius:8px; background:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 9%,var(--chrome-bar,#252a39)); color:var(--chrome-text-bright,#e2e6f1); font-size:12px; font-weight:600; text-align:left; }
    .project-trigger:hover,.project-trigger[aria-expanded="true"] { border-color:var(--chrome-accent,#9bb8f7); }
    .project-trigger:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .project-trigger .project-name { flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .project-trigger .project-symbol { display:flex; color:var(--chrome-accent,#9bb8f7); }
    .project-trigger .down { display:flex; margin-left:auto; color:var(--chrome-text-dim,#a9b0c0); }
    .project-options { position:absolute; z-index:20; bottom:36px; left:0; width:270px; max-width:min(270px,calc(100vw - 72px)); max-height:280px; overflow:auto; padding:5px; border:1px solid var(--chrome-border,#475067); border-radius:10px; background:var(--chrome-bar,#252a39); box-shadow:0 12px 30px #0009; }
    .project-option { width:100%; display:flex; align-items:center; gap:9px; padding:8px; border:0; border-radius:6px; background:transparent; color:var(--chrome-text-bright,#e2e6f1); text-align:left; }
    .project-option:hover,.project-option[selected] { background:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 15%,transparent); }
    .project-option .option-copy { flex:1; min-width:0; display:grid; gap:1px; }
    .project-option .option-copy strong,.project-option .option-copy small { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .project-option .option-copy small { color:var(--chrome-text-dim,#a9b0c0); font-size:10px; }
    .project-option svg { flex:none; color:var(--chrome-accent,#9bb8f7); }
    .project-divider { height:1px; margin:4px 6px; background:var(--chrome-border,#475067); }
    .folder-line { display:flex; gap:6px; }
    .folder-line input { flex:1; min-width:0; }
    button { cursor:pointer; font:inherit; }
    .browse { border:1px solid var(--chrome-border,#475067); border-radius:8px; color:inherit; background:var(--chrome-bar,#252a39); padding:0 10px; }
    .picker { max-height:240px; overflow:auto; border:1px solid var(--chrome-border,#475067); border-radius:9px; margin:0 0 14px; background:var(--chrome-bar,#252a39); }
    .picker-head { display:flex; align-items:center; gap:8px; padding:8px; border-bottom:1px solid var(--chrome-border,#475067); }
    .picker-head span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .picker button { border:0; color:inherit; background:transparent; padding:6px 10px; border-radius:5px; }
    .picker button:hover { background:rgba(255,255,255,.09); }
    .picker-create { display:flex; gap:6px; padding:8px; border-bottom:1px solid var(--chrome-border,#475067); }
    .picker-create input { flex:1; }
    .folder-entry { display:block; width:100%; text-align:left; }
    .composer { display:flex; flex-direction:column; gap:9px; border:1px solid var(--chrome-border,#475067); border-radius:18px; background:var(--chrome-bar,#202632); padding:15px 14px 10px; transition:border-color .15s,box-shadow .15s; }
    .composer:focus-within { border-color:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 58%,var(--chrome-border,#475067)); box-shadow:0 0 0 2px color-mix(in srgb,var(--chrome-accent,#9bb8f7) 14%,transparent); }
    textarea { box-sizing:border-box; display:block; width:100%; min-width:0; min-height:100px; height:100px; max-height:220px; resize:none; border:0; outline:0; padding:3px 0; color:inherit; background:transparent; font:16px/1.55 system-ui,sans-serif; overflow-y:auto; }
    textarea::placeholder { color:var(--chrome-text-dim,#a9b0c0); opacity:.8; }
    .send { flex:none; width:34px; height:34px; border:0; border-radius:10px; background:var(--chrome-accent,#9bb8f7); color:#152032; font-size:20px; line-height:1; }
    .send:hover:not(:disabled) { filter:brightness(1.1); }
    .send:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .send:disabled { opacity:.4; cursor:default; }
    .error { margin:10px 0; color:#e6a5a5; }
    .receipt { display:flex; align-items:center; gap:8px; margin:12px 2px 0; color:var(--chrome-text-dim,#a9b0c0); font-size:12px; }
    .receipt::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--chrome-accent,#9bb8f7); animation:receipt-pulse 1.35s ease-in-out infinite; }
    @keyframes receipt-pulse { 50% { opacity:.35; transform:scale(.7); } }
    @media (prefers-reduced-motion:reduce) { .receipt::before { animation:none; } }
    .location-settings { border-top:1px solid var(--chrome-border,#475067); padding-top:7px; }
    .location-settings summary { cursor:pointer; color:var(--chrome-text-dim,#a9b0c0); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .location-fields { display:grid; gap:9px; padding:11px 0 4px; }
    .location-note { margin:0; color:var(--chrome-text-dim,#a9b0c0); font-size:11px; }
    .provider-note { margin:0 2px; color:var(--chrome-text-dim,#a9b0c0); font-size:11px; }
    .provider-change { color:var(--chrome-text-bright,#e2e6f1); }
    @media(max-width:550px) { .main { padding:16px; } h1 { font-size:24px; } .controls { gap:6px; } .controls select { max-width:125px; } .project-trigger { max-width:135px; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.harness = this.initialHarness;
    this.provider = providerFor(this.harness);
    if (this.initialFolder) this.folder = this.initialFolder;
    if (this.initialProject) this.projectId = this.initialProject;
    document.addEventListener('pointerdown', this.closeProjectPicker);
    this.unsub = sdkChats.subscribe(() => this.requestUpdate());
    void sdkChats.refresh().then(() => { const project = sdkChats.projects.find(p => p.id === this.projectId); if (project) this.folder = project.path; });
    void sdkChats.folders().then(listing => { this.listing = listing; if (!this.folder) this.folder = listing.base; }).catch(error => { this.error = String(error); });
  }
  override disconnectedCallback() { this.unsub?.(); document.removeEventListener('pointerdown', this.closeProjectPicker); super.disconnectedCallback(); }
  override firstUpdated() { this.shadowRoot?.querySelector('textarea')?.focus(); }
  override updated(changed: Map<string, unknown>) { if (changed.has('prompt')) this.sizeTextarea(); }
  private sizeTextarea() {
    const textarea = this.shadowRoot?.querySelector('textarea');
    if (!textarea) return;
    textarea.style.height = '100px';
    textarea.style.height = `${Math.min(220, Math.max(100, textarea.scrollHeight))}px`;
  }
  private async browse(path = this.folder) {
    try { this.listing = await sdkChats.folders(path); if (this.listing.path === path) { this.folder = this.listing.path; this.onFolderChanged(); } this.pickerOpen = true; this.error = ''; }
    catch (error) { this.error = String(error); }
  }
  private onFolderChanged() {
    const selected = sdkChats.projects.find(p => p.id === this.projectId);
    if (selected && selected.path !== this.folder) this.projectId = 'new';
  }
  private onProjectChange(value: string) {
    this.projectId = value;
    this.projectPickerOpen = false;
    if (value === 'new') this.locationOpen = true;
    const project = sdkChats.projects.find(p => p.id === value);
    if (project) this.folder = project.path;
    else if (value === 'ungrouped' && this.listing) this.folder = this.listing.base;
    if (value === 'ungrouped' || value === 'new') this.workMode = 'local';
  }
  private onHarnessChange(value: HarnessName) {
    this.harness = value;
    if (!providerAvailable(value, this.provider)) {
      this.provider = providerFor(value);
      this.providerNotice = `Provider changed to ${PROVIDERS.find(provider => provider.value === this.provider)!.label} for ${harnessLabel(value)}.`;
    } else this.providerNotice = '';
  }
  private onProviderChange(value: ProviderName) {
    if (providerAvailable(this.harness, value)) {
      this.provider = value;
      this.providerNotice = '';
    }
  }
  private async send() {
    const prompt = this.prompt.trim();
    if (!prompt || this.busy) return;
    if (!providerAvailable(this.harness, this.provider)) {
      this.error = 'Choose a provider available for the selected harness.';
      return;
    }
    this.busy = true; this.error = '';
    try {
      await this.updateComplete;
      let workspaceId: string | undefined;
      if (this.projectId === 'new') {
        if (!this.folder.startsWith('/')) throw new Error('Choose an absolute folder for the new project.');
        workspaceId = (await sdkChats.createProject(this.folder, this.projectName.trim())).id;
      } else if (this.projectId !== 'ungrouped') workspaceId = this.projectId;
      const chat = await sdkChats.create({ workspaceId, projectPath:this.folder, workMode:this.workMode, harness:this.harness, provider:this.provider, prompt });
      this.dispatchEvent(new CustomEvent('chat-created', { detail:{sessionId:chat.id}, bubbles:true, composed:true }));
    } catch (error) { this.error = String(error); }
    finally { this.busy = false; }
  }
  override render() {
    const selectedProject = sdkChats.projects.find(project => project.id === this.projectId);
    return html`
    <div class="top">New Chat</div>
    <div class="main"><div class="content">
      <h1>What would you like to do?</h1>
      <div class="composer">
        <textarea aria-label="First message" placeholder="Describe what you want to work on…" .value=${this.prompt} @input=${(e:Event) => { this.prompt = (e.target as HTMLTextAreaElement).value; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea>
        <div class="controls">
        <div class="project"><div class="project-picker"><button class="project-trigger" role="combobox" aria-label="Project" aria-expanded=${this.projectPickerOpen} aria-controls="project-options" @click=${() => { this.projectPickerOpen = !this.projectPickerOpen; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Escape') this.projectPickerOpen = false; if (e.key === 'ArrowDown') this.projectPickerOpen = true; }}><span class="project-symbol">${icon(this.projectId === 'new' ? Plus : Folder,{size:15})}</span><span class="project-name">${selectedProject?.name || (this.projectId === 'new' ? 'New project' : 'Ungrouped')}</span><span class="down">${icon(ChevronDown,{size:16})}</span></button>
          ${this.projectPickerOpen ? html`<div id="project-options" class="project-options" role="listbox" aria-label="Projects">
            <button class="project-option" role="option" aria-selected=${this.projectId === 'ungrouped'} ?selected=${this.projectId === 'ungrouped'} @click=${() => this.onProjectChange('ungrouped')}>${icon(Folder,{size:16})}<span class="option-copy"><strong>Ungrouped</strong><small>Choose a folder for this chat</small></span></button>
            ${sdkChats.projects.map(p => html`<button class="project-option" role="option" aria-selected=${this.projectId === p.id} ?selected=${this.projectId === p.id} title=${p.path} @click=${() => this.onProjectChange(p.id)}>${icon(Folder,{size:16})}<span class="option-copy"><strong>${p.name}</strong><small>${p.path}</small></span></button>`)}
            <div class="project-divider"></div><button class="project-option" role="option" aria-selected=${this.projectId === 'new'} ?selected=${this.projectId === 'new'} @click=${() => this.onProjectChange('new')}>${icon(Plus,{size:16})}<span class="option-copy"><strong>New project</strong><small>Choose its primary folder</small></span></button>
          </div>` : nothing}
        </div></div>
        <label class="where"><select aria-label="Where to work" .value=${this.workMode} @change=${(e:Event) => { this.workMode = (e.target as HTMLSelectElement).value as 'local' | 'worktree'; }}><option value="local">Local folder</option><option value="worktree" ?disabled=${this.projectId === 'ungrouped' || this.projectId === 'new'}>New worktree</option></select></label>
        <label class="harness"><select aria-label="Harness" .value=${this.harness} @change=${(e:Event) => this.onHarnessChange((e.target as HTMLSelectElement).value as HarnessName)}>${LAUNCHABLE_HARNESSES.map(h => html`<option value=${h} ?selected=${this.harness === h}>${harnessLabel(h)}</option>`)}</select></label>
        <label class="provider"><select aria-label="Provider" .value=${this.provider} @change=${(e:Event) => this.onProviderChange((e.target as HTMLSelectElement).value as ProviderName)}>
          ${PROVIDERS.map(provider => html`<option value=${provider.value} ?selected=${this.provider === provider.value} ?disabled=${!providerAvailable(this.harness, provider.value)} title=${providerAvailable(this.harness, provider.value) ? '' : `Unavailable for ${harnessLabel(this.harness)}`}>${provider.label}${providerAvailable(this.harness, provider.value) ? '' : ` — unavailable for ${harnessLabel(this.harness)}`}</option>`)}
        </select></label>
        <button class="send" aria-label="Send message" ?disabled=${!this.prompt.trim() || this.busy} @click=${() => void this.send()}>↑</button>
        </div>
        <details class="location-settings" ?open=${this.locationOpen} @toggle=${(e: Event) => { this.locationOpen = (e.target as HTMLDetailsElement).open; }}><summary title=${this.folder}>${this.projectId === 'new' ? 'Set up new project' : `Working in ${this.folder || 'choose a folder'}`}</summary>
          <div class="location-fields">
            <label class="folder">${this.projectId === 'ungrouped' ? 'Folder' : 'Primary folder'}<div class="folder-line"><input aria-label="Primary folder" .value=${this.folder} ?readonly=${this.projectId !== 'ungrouped' && this.projectId !== 'new'} @input=${(e:Event) => { this.folder = (e.target as HTMLInputElement).value; this.onFolderChanged(); }}>${this.projectId === 'ungrouped' || this.projectId === 'new' ? html`<button class="browse" aria-label="Browse server folders" @click=${() => void this.browse()}>Browse</button>` : nothing}</div></label>
            ${this.projectId === 'new' ? html`<label>Project name <input aria-label="Project name" placeholder="Defaults to the folder name" .value=${this.projectName} @input=${(e:Event) => { this.projectName = (e.target as HTMLInputElement).value; }}></label>` : nothing}
            ${this.pickerOpen && this.listing ? html`<div class="picker" aria-label="Server folder picker"><div class="picker-head"><button aria-label="Parent folder" @click=${() => void this.browse(this.listing!.parent)}>↑</button><span>${this.listing.path}</span><button @click=${() => { this.pickerOpen = false; }}>Choose this folder</button></div><div class="picker-create"><input aria-label="New folder name" placeholder="New folder name" .value=${this.newFolderName} @input=${(e:Event) => { this.newFolderName = (e.target as HTMLInputElement).value; }}><button @click=${() => { if (!this.newFolderName.trim() || this.newFolderName.includes('/')) return; this.folder = `${this.listing!.path.replace(/\/$/,'')}/${this.newFolderName.trim()}`; this.onFolderChanged(); this.pickerOpen = false; }}>Use new folder</button></div>${this.listing.folders.map(name => html`<button class="folder-entry" @click=${() => void this.browse(`${this.listing!.path.replace(/\/$/,'')}/${name}`)}>▸ ${name}</button>`)}</div>` : nothing}
            <p class="location-note">${this.workMode === 'worktree' ? 'A separate Git worktree will be created from this project’s primary folder.' : this.projectId === 'ungrouped' ? 'This chat will use the chosen folder.' : 'This chat will use the project’s primary folder.'}${selectedProject?.sourceFolders?.length ? ` ${selectedProject.sourceFolders.length} additional source ${selectedProject.sourceFolders.length === 1 ? 'folder is' : 'folders are'} available at their existing paths.` : ''}</p>
          </div>
        </details>
      </div>
      ${this.providerNotice ? html`<div class="provider-note" role="status"><span class="provider-change">${this.providerNotice}</span></div>` : nothing}
      ${this.busy ? html`<div class="receipt" role="status">Message received · Creating chat…</div>` : nothing}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
    </div></div>
  `; }
}
