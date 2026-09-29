import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sdkChats, type FolderListing } from '../lib/sdk-chats.js';
import { LAUNCHABLE_HARNESSES, harnessLabel, type HarnessName } from '../lib/harness.js';

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
  @state() private projectId = 'ungrouped';
  @state() private folder = '';
  @state() private projectName = '';
  @state() private newFolderName = '';
  @state() private harness: HarnessName = 'codex';
  @state() private provider: ProviderName = 'openai';
  @state() private providerNotice = '';
  @state() private prompt = '';
  @state() private listing?: FolderListing;
  @state() private pickerOpen = false;
  @state() private busy = false;
  @state() private error = '';
  private unsub?: () => void;

  static styles = css`
    :host { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; background:var(--chrome-bg,#1a1c28); color:var(--chrome-text-bright,#e2e6f1); font:13px/1.5 system-ui,sans-serif; }
    .top { padding:14px 24px; border-bottom:1px solid var(--chrome-border,#343a4c); font-size:14px; font-weight:600; }
    .main { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; align-items:center; padding:24px; }
    .content { width:min(100%,780px); }
    h1 { font-size:28px; font-weight:600; margin:0 0 30px; }
    .controls { display:flex; flex-wrap:wrap; gap:9px; margin-bottom:14px; }
    label { display:flex; flex-direction:column; gap:5px; color:var(--chrome-text-dim,#a9b0c0); font-size:11px; }
    .project { min-width:160px; flex:1; }
    .folder { min-width:220px; flex:2; }
    .harness,.provider { min-width:125px; flex:1; }
    select,input { box-sizing:border-box; width:100%; height:37px; border:1px solid var(--chrome-border,#475067); border-radius:8px; background:var(--chrome-bar,#252a39); color:var(--chrome-text-bright,#e2e6f1); padding:7px 9px; font:13px system-ui,sans-serif; }
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
    .composer { display:flex; align-items:flex-end; gap:10px; border:1px solid var(--chrome-border,#475067); border-radius:16px; background:rgba(0,0,0,.15); padding:12px; }
    textarea { flex:1; min-width:0; min-height:66px; max-height:220px; resize:vertical; border:0; outline:0; color:inherit; background:transparent; font:14px/1.5 system-ui,sans-serif; }
    .send { width:34px; height:34px; border:0; border-radius:50%; background:#9bb8f7; color:#152032; font-size:19px; }
    .send:disabled { opacity:.4; cursor:default; }
    .error { margin:10px 0; color:#e6a5a5; }
    .hint { margin:10px 3px; color:var(--chrome-text-dim,#a9b0c0); font-size:11px; }
    .provider-note { margin:-6px 0 14px; color:var(--chrome-text-dim,#a9b0c0); font-size:11px; }
    .provider-change { color:var(--chrome-text-bright,#e2e6f1); }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.unsub = sdkChats.subscribe(() => this.requestUpdate());
    void sdkChats.refresh();
    void sdkChats.folders().then(listing => { this.listing = listing; if (!this.folder) this.folder = listing.path; }).catch(error => { this.error = String(error); });
  }
  override disconnectedCallback() { this.unsub?.(); super.disconnectedCallback(); }
  override firstUpdated() { this.shadowRoot?.querySelector('textarea')?.focus(); }
  private async browse(path = this.folder) {
    try { this.listing = await sdkChats.folders(path); this.folder = this.listing.path; this.onFolderChanged(); this.pickerOpen = true; this.error = ''; }
    catch (error) { this.error = String(error); }
  }
  private onFolderChanged() {
    const selected = sdkChats.projects.find(p => p.id === this.projectId);
    if (selected && selected.path !== this.folder) this.projectId = 'new';
  }
  private onProjectChange(value: string) {
    this.projectId = value;
    const project = sdkChats.projects.find(p => p.id === value);
    if (project) this.folder = project.path;
    else if (value === 'ungrouped' && this.listing) this.folder = this.listing.base;
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
      let workspaceId: string | undefined;
      if (this.projectId === 'new') {
        if (!this.folder.startsWith('/')) throw new Error('Choose an absolute folder for the new project.');
        workspaceId = (await sdkChats.createProject(this.folder, this.projectName.trim())).id;
      } else if (this.projectId !== 'ungrouped') workspaceId = this.projectId;
      const chat = await sdkChats.create({ workspaceId, projectPath:this.folder, harness:this.harness, provider:this.provider, prompt });
      this.dispatchEvent(new CustomEvent('chat-created', { detail:{sessionId:chat.id}, bubbles:true, composed:true }));
    } catch (error) { this.error = String(error); }
    finally { this.busy = false; }
  }
  override render() { return html`
    <div class="top">New Chat</div>
    <div class="main"><div class="content">
      <h1>What are we working on?</h1>
      <div class="controls">
        <label class="project">Project<select aria-label="Project" .value=${this.projectId} @change=${(e:Event) => this.onProjectChange((e.target as HTMLSelectElement).value)}>
          <option value="ungrouped" ?selected=${this.projectId === 'ungrouped'}>Ungrouped</option>
          ${sdkChats.projects.map(p => html`<option value=${p.id} ?selected=${this.projectId === p.id}>${p.name}</option>`)}
          <option value="new" ?selected=${this.projectId === 'new'}>＋ New project</option>
        </select></label>
        <label class="folder">Folder<div class="folder-line"><input aria-label="Folder" .value=${this.folder} @input=${(e:Event) => { this.folder = (e.target as HTMLInputElement).value; this.onFolderChanged(); }}><button class="browse" aria-label="Browse server folders" @click=${() => void this.browse()}>Browse</button></div></label>
        <label class="harness">Harness<select aria-label="Harness" .value=${this.harness} @change=${(e:Event) => this.onHarnessChange((e.target as HTMLSelectElement).value as HarnessName)}>${LAUNCHABLE_HARNESSES.map(h => html`<option value=${h} ?selected=${this.harness === h}>${harnessLabel(h)}</option>`)}</select></label>
        <label class="provider">Provider<select aria-label="Provider" .value=${this.provider} @change=${(e:Event) => this.onProviderChange((e.target as HTMLSelectElement).value as ProviderName)}>
          ${PROVIDERS.map(provider => html`<option value=${provider.value} ?selected=${this.provider === provider.value} ?disabled=${!providerAvailable(this.harness, provider.value)} title=${providerAvailable(this.harness, provider.value) ? '' : `Unavailable for ${harnessLabel(this.harness)}`}>${provider.label}${providerAvailable(this.harness, provider.value) ? '' : ` — unavailable for ${harnessLabel(this.harness)}`}</option>`)}
        </select></label>
      </div>
      <div class="provider-note" role="status">${this.providerNotice ? html`<span class="provider-change">${this.providerNotice}</span>` : this.harness === 'amplifier' ? 'Amplifier uses the selected provider from its configured bundle.' : `Providers unavailable for ${harnessLabel(this.harness)} remain visible in the list.`}</div>
      ${this.projectId === 'new' ? html`<label>Project name <input aria-label="Project name" placeholder="Defaults to the folder name" .value=${this.projectName} @input=${(e:Event) => { this.projectName = (e.target as HTMLInputElement).value; }}></label>` : nothing}
      ${this.pickerOpen && this.listing ? html`<div class="picker" aria-label="Server folder picker"><div class="picker-head"><button aria-label="Parent folder" @click=${() => void this.browse(this.listing!.parent)}>↑</button><span>${this.listing.path}</span><button @click=${() => { this.pickerOpen = false; }}>Choose this folder</button></div><div class="picker-create"><input aria-label="New folder name" placeholder="New folder name" .value=${this.newFolderName} @input=${(e:Event) => { this.newFolderName = (e.target as HTMLInputElement).value; }}><button @click=${() => { if (!this.newFolderName.trim() || this.newFolderName.includes('/')) return; this.folder = `${this.listing!.path.replace(/\/$/,'')}/${this.newFolderName.trim()}`; this.onFolderChanged(); this.pickerOpen = false; }}>Use new folder</button></div>${this.listing.folders.map(name => html`<button class="folder-entry" @click=${() => void this.browse(`${this.listing!.path.replace(/\/$/,'')}/${name}`)}>▸ ${name}</button>`)}</div>` : nothing}
      <div class="composer"><textarea aria-label="First message" placeholder="Ask anything…" .value=${this.prompt} @input=${(e:Event) => { this.prompt = (e.target as HTMLTextAreaElement).value; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea><button class="send" aria-label="Send message" ?disabled=${!this.prompt.trim() || this.busy} @click=${() => void this.send()}>↑</button></div>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      <div class="hint">Your first message starts the session. New folders are created when you send.</div>
    </div></div>
  `; }
}
