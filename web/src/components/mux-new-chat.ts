import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sdkChats, type FolderListing } from '../lib/sdk-chats.js';
import { apiPath } from '../lib/base-path.js';
import { harnessLabel, type HarnessName } from '../lib/harness.js';
import { ChevronDown, Folder, Plus } from 'lucide';
import { icon } from '../lib/icons.js';

type ProviderName = 'openai' | 'anthropic' | 'configured';
type StartOption = { harness: HarnessName; provider: ProviderName };
type Attachment = { localId: string; file: File; id?: string; kind?: string; preview?: string; uploading: boolean; error?: string };

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
  @state() private startOptions?: StartOption[];
  @state() private prompt = '';
  @state() private listing?: FolderListing;
  @state() private pickerOpen = false;
  @state() private locationOpen = false;
  @state() private projectPickerOpen = false;
  @state() private busy = false;
  @state() private error = '';
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
    if (this.pickerOpen && !inside('.picker') && !inside('.browse')) this.pickerOpen = false;
    if (this.locationOpen && !inside('.location-settings')) this.locationOpen = false;
  };

  static styles = css`
    ${subtleScrollbars}
    :host { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; background:var(--chrome-body); color:var(--chrome-text-bright); font:13px/1.5 system-ui,sans-serif; }
    .top { padding:14px 24px; border-bottom:1px solid var(--chrome-border,#343a4c); font-size:14px; font-weight:600; display:flex; justify-content:space-between; align-items:center; }
    .top button { border:0; background:transparent; color:inherit; cursor:pointer; }
    .main { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; align-items:center; padding:24px; }
    .content { width:min(100%,780px); }
    h1 { font-size:28px; font-weight:600; margin:0 0 20px; }
    .controls { display:flex; align-items:center; flex-wrap:wrap; gap:7px; padding-bottom:9px; border-bottom:1px solid var(--chrome-border,#475067); }
    label { display:flex; flex-direction:column; gap:5px; color:var(--chrome-text-dim,#a9b0c0); font-size:11px; }
    .controls label { display:block; }
    .controls .project { min-width:0; }
    .controls .harness { min-width:0; }
    .worktree-toggle { display:inline-flex; align-items:center; gap:7px; height:31px; margin-left:auto; padding:0 3px 0 8px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--chrome-text-dim,#a9b0c0); font-size:12px; white-space:nowrap; }
    .worktree-toggle:hover:not(:disabled),.worktree-toggle:focus-visible { background:var(--chrome-hover); color:var(--chrome-text-bright,#e2e6f1); outline:none; }
    .worktree-toggle:disabled { opacity:.45; cursor:default; }
    .worktree-toggle .track { display:flex; align-items:center; box-sizing:border-box; width:29px; height:17px; padding:2px; border:1px solid var(--chrome-border,#475067); border-radius:999px; background:var(--chrome-body); transition:background .15s; }
    .worktree-toggle .thumb { width:11px; height:11px; border-radius:50%; background:var(--chrome-text-dim,#a9b0c0); transition:transform .15s; }
    .worktree-toggle[aria-checked="true"] { color:var(--chrome-text-bright,#e2e6f1); }
    .worktree-toggle[aria-checked="true"] .track { border-color:var(--chrome-accent,#9bb8f7); background:var(--chrome-accent,#9bb8f7); }
    .worktree-toggle[aria-checked="true"] .thumb { background:var(--chrome-body); transform:translateX(12px); }
    .composer-actions { display:flex; align-items:center; gap:7px; padding-top:8px; border-top:1px solid var(--chrome-border,#475067); }
    .composer-actions .send { margin-left:auto; }
    select,input { box-sizing:border-box; width:100%; height:37px; border:1px solid var(--chrome-border,#475067); border-radius:8px; background:var(--chrome-bar,#252a39); color:var(--chrome-text-bright,#e2e6f1); padding:7px 9px; font:13px system-ui,sans-serif; }
    select { appearance:none; padding-right:29px; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23a9b9d6' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 8px center; }
    .controls select { height:31px; max-width:130px; padding:3px 29px 3px 9px; font-size:12px; }
    select:hover,.browse:hover { border-color:var(--chrome-accent,#9bb8f7); }
    select:focus-visible,input:focus-visible,.browse:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .project-picker { position:relative; }
    .project-trigger { box-sizing:border-box; width:auto; max-width:150px; height:31px; display:flex; align-items:center; gap:6px; padding:0 9px; border:1px solid var(--chrome-border,#475067); border-radius:8px; background:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 9%,var(--chrome-bar,#252a39)); color:var(--chrome-text-bright,#e2e6f1); font-size:12px; font-weight:600; text-align:left; }
    .project-trigger:hover,.project-trigger[aria-expanded="true"] { border-color:var(--chrome-accent,#9bb8f7); }
    .project-trigger:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .project-trigger .project-name { flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .project-trigger .project-symbol { display:flex; color:var(--chrome-accent,#9bb8f7); }
    .project-trigger .down { display:flex; margin-left:auto; color:var(--chrome-text-dim,#a9b0c0); }
    .project-options { position:absolute; z-index:20; top:36px; left:0; width:270px; max-width:min(270px,calc(100vw - 72px)); max-height:280px; overflow:auto; padding:5px; border:1px solid var(--chrome-border,#475067); border-radius:10px; background:var(--chrome-bar,#252a39); box-shadow:0 12px 30px #0009; }
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
    .picker button:hover { background:var(--chrome-hover); }
    .picker-create { display:flex; gap:6px; padding:8px; border-bottom:1px solid var(--chrome-border,#475067); }
    .picker-create input { flex:1; }
    .folder-entry { display:block; width:100%; text-align:left; }
    .composer { position:relative; display:flex; flex-direction:column; gap:9px; border:1px solid var(--chrome-border,#475067); border-radius:18px; background:var(--chrome-bar,#202632); padding:15px 14px 10px; transition:border-color .15s,box-shadow .15s; }
    .composer:focus-within { border-color:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 58%,var(--chrome-border,#475067)); box-shadow:0 0 0 2px color-mix(in srgb,var(--chrome-accent,#9bb8f7) 14%,transparent); }
    textarea { box-sizing:border-box; display:block; width:100%; min-width:0; min-height:100px; height:100px; max-height:220px; resize:none; border:0; outline:0; padding:3px 0; color:inherit; background:transparent; font:16px/1.55 system-ui,sans-serif; overflow-y:auto; }
    textarea::placeholder { color:var(--chrome-text-dim,#a9b0c0); opacity:.8; }
    .attachments { display:flex; flex-wrap:wrap; gap:8px; }
    .attachment { position:relative; display:flex; align-items:center; gap:9px; min-width:0; max-width:min(100%,230px); padding:5px 28px 5px 5px; border:1px solid var(--chrome-border,#41485f); border-radius:10px; background:var(--chrome-bar,#202632); }
    .attachment img { flex:none; width:52px; height:52px; object-fit:cover; border-radius:6px; background:var(--chrome-body); }
    .attachment .filename { min-width:0; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
    .attachment .status { color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    .attachment .status.failed { color:var(--chrome-danger); }
    .attachment button { position:absolute; top:4px; right:4px; width:22px; height:22px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--chrome-text-dim,#9aa3b8); font-size:18px; line-height:20px; }
    .attachment button:hover { background:var(--chrome-hover); color:inherit; }
    .attach-button { flex:none; width:34px; height:34px; display:grid; place-items:center; border:0; border-radius:9px; padding:0; background:transparent; color:var(--chrome-text-bright,#d9def0); }
    .attach-button svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
    .attach-button:hover,.attach-button:focus-visible { background:var(--chrome-hover); outline:none; }
    .file-input { display:none; }
    .drop-overlay { position:absolute; inset:8px; z-index:10; display:grid; place-items:center; border:2px dashed var(--chrome-accent); border-radius:16px; background:color-mix(in srgb, var(--chrome-body) 92%, transparent); color:var(--chrome-text-bright); font-size:22px; pointer-events:none; }
    .send { flex:none; width:34px; height:34px; border:0; border-radius:10px; background:var(--chrome-accent); color:var(--chrome-body); font-size:20px; line-height:1; }
    .send:hover:not(:disabled) { filter:brightness(1.1); }
    .send:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .send:disabled { opacity:.4; cursor:default; }
    .error { margin:10px 0; color:var(--chrome-danger); }
    .receipt { display:flex; align-items:center; gap:8px; margin:12px 2px 0; color:var(--chrome-text-dim,#a9b0c0); font-size:12px; }
    .receipt::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--chrome-accent,#9bb8f7); animation:receipt-pulse 1.35s ease-in-out infinite; }
    @keyframes receipt-pulse { 50% { opacity:.35; transform:scale(.7); } }
    @media (prefers-reduced-motion:reduce) { .receipt::before { animation:none; } }
    .location-settings { position:relative; min-width:0; }
    .location-settings summary { display:flex; align-items:center; gap:6px; box-sizing:border-box; max-width:230px; height:31px; padding:0 9px; border:1px solid var(--chrome-border,#475067); border-radius:8px; cursor:pointer; color:var(--chrome-text-bright,#e2e6f1); font-size:12px; white-space:nowrap; list-style:none; }
    .location-settings .folder-symbol { display:flex; flex:none; color:var(--chrome-accent,#9bb8f7); }
    .location-settings .folder-label { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .location-settings summary::-webkit-details-marker { display:none; }
    .location-settings summary:hover,.location-settings[open] summary { border-color:var(--chrome-accent,#9bb8f7); }
    .location-fields { position:absolute; z-index:20; top:37px; left:0; display:grid; gap:9px; box-sizing:border-box; width:min(400px,calc(100vw - 72px)); max-height:300px; overflow:auto; padding:11px; border:1px solid var(--chrome-border,#475067); border-radius:10px; background:var(--chrome-bar,#252a39); box-shadow:0 12px 30px #0009; }
    .location-note { margin:0; color:var(--chrome-text-dim,#a9b0c0); font-size:11px; }
    @media(max-width:550px) { .main { padding:16px; } h1 { font-size:24px; } .controls { gap:6px; } .controls select { max-width:125px; } .project-trigger { max-width:135px; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('dragover', this.preventFileNavigation);
    window.addEventListener('drop', this.preventFileNavigation);
    window.addEventListener('drop', this.resetDrop);
    window.addEventListener('dragend', this.resetDrop);
    this.harness = this.initialHarness;
    void this.loadStartOptions();
    if (this.initialFolder) this.folder = this.initialFolder;
    if (this.initialProject) this.projectId = this.initialProject;
    document.addEventListener('pointerdown', this.closeDropdowns);
    this.unsub = sdkChats.subscribe(() => this.requestUpdate());
    void sdkChats.refresh().then(() => { const project = sdkChats.projects.find(p => p.id === this.projectId); if (project) this.folder = project.path; });
    void sdkChats.folders().then(listing => { this.listing = listing; if (!this.folder) this.folder = listing.base; }).catch(error => { this.error = String(error); });
  }
  override disconnectedCallback() {
    this.unsub?.();
    document.removeEventListener('pointerdown', this.closeDropdowns);
    window.removeEventListener('dragover', this.preventFileNavigation);
    window.removeEventListener('drop', this.preventFileNavigation);
    window.removeEventListener('drop', this.resetDrop);
    window.removeEventListener('dragend', this.resetDrop);
    for (const item of this.attachments) if (item.preview) URL.revokeObjectURL(item.preview);
    super.disconnectedCallback();
  }
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
  }
  private onHarnessChange(value: HarnessName) {
    const option = this.startOptions?.find(item => item.harness === value);
    if (!option) return;
    this.harness = option.harness;
    this.provider = option.provider;
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
      else this.error = 'No chat harness is ready on this server.';
    } catch (error) {
      if (this.isConnected) this.error = error instanceof Error ? error.message : String(error);
    }
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
    const prompt = this.prompt.trim();
    if ((!prompt && !this.attachments.length) || this.busy || !this.startOptions?.some(item => item.harness === this.harness && item.provider === this.provider) || this.attachments.some(a => a.uploading || a.error)) return;
    this.busy = true; this.error = '';
    try {
      await this.updateComplete;
      let workspaceId: string | undefined;
      if (this.projectId === 'new') {
        if (!this.folder.startsWith('/')) throw new Error('Choose an absolute folder for the new project.');
        workspaceId = (await sdkChats.createProject(this.folder, this.projectName.trim())).id;
      } else if (this.projectId !== 'ungrouped') workspaceId = this.projectId;
      const chat = await sdkChats.create({ workspaceId, projectPath:this.folder, workMode:this.workMode, harness:this.harness, provider:this.provider, prompt, attachments:this.attachments.map(a => a.id!) });
      this.dispatchEvent(new CustomEvent('chat-created', { detail:{sessionId:chat.id}, bubbles:true, composed:true }));
    } catch (error) { this.error = error instanceof Error ? error.message.trim() : String(error); }
    finally { this.busy = false; }
  }
  override render() {
    const selectedProject = sdkChats.projects.find(project => project.id === this.projectId);
    return html`
    <div class="top">New Chat <button type="button" @click=${() => this.dispatchEvent(new CustomEvent('chat-cancel', { bubbles:true, composed:true }))}>Use terminal instead</button></div>
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
        <details class="location-settings" ?open=${this.locationOpen} @toggle=${(e: Event) => { this.locationOpen = (e.target as HTMLDetailsElement).open; }}><summary title=${this.folder}><span class="folder-symbol">${icon(Folder,{size:14})}</span><span class="folder-label">${this.locationLabel()}</span></summary>
          <div class="location-fields">
            <label class="folder">${this.projectId === 'ungrouped' ? 'Folder' : 'Primary folder'}<div class="folder-line"><input aria-label="Primary folder" .value=${this.folder} ?readonly=${this.projectId !== 'ungrouped' && this.projectId !== 'new'} @input=${(e:Event) => { this.folder = (e.target as HTMLInputElement).value; this.onFolderChanged(); }}>${this.projectId === 'ungrouped' || this.projectId === 'new' ? html`<button class="browse" aria-label="Browse server folders" @click=${() => void this.browse()}>Browse</button>` : nothing}</div></label>
            ${this.projectId === 'new' ? html`<label>Project name <input aria-label="Project name" placeholder="Defaults to the folder name" .value=${this.projectName} @input=${(e:Event) => { this.projectName = (e.target as HTMLInputElement).value; }}></label>` : nothing}
            ${this.pickerOpen && this.listing ? html`<div class="picker" aria-label="Server folder picker"><div class="picker-head"><button aria-label="Parent folder" @click=${() => void this.browse(this.listing!.parent)}>↑</button><span>${this.listing.path}</span><button @click=${() => { this.pickerOpen = false; }}>Choose this folder</button></div><div class="picker-create"><input aria-label="New folder name" placeholder="New folder name" .value=${this.newFolderName} @input=${(e:Event) => { this.newFolderName = (e.target as HTMLInputElement).value; }}><button @click=${() => { if (!this.newFolderName.trim() || this.newFolderName.includes('/')) return; this.folder = `${this.listing!.path.replace(/\/$/,'')}/${this.newFolderName.trim()}`; this.onFolderChanged(); this.pickerOpen = false; }}>Use new folder</button></div>${this.listing.folders.map(name => html`<button class="folder-entry" @click=${() => void this.browse(`${this.listing!.path.replace(/\/$/,'')}/${name}`)}>▸ ${name}</button>`)}</div>` : nothing}
            <p class="location-note">${this.workMode === 'worktree' ? 'A separate Git worktree will be created from this project’s primary folder.' : this.projectId === 'ungrouped' ? 'This chat will use the chosen folder.' : 'This chat will use the project’s primary folder.'}${selectedProject?.sourceFolders?.length ? ` ${selectedProject.sourceFolders.length} additional source ${selectedProject.sourceFolders.length === 1 ? 'folder is' : 'folders are'} available at their existing paths.` : ''}</p>
          </div>
        </details>
        ${this.startOptions?.length ? html`<label class="harness"><select aria-label="Harness" .value=${this.harness} @change=${(e:Event) => this.onHarnessChange((e.target as HTMLSelectElement).value as HarnessName)}>${this.startOptions.map(option => html`<option value=${option.harness} ?selected=${this.harness === option.harness}>${harnessLabel(option.harness)}</option>`)}</select></label>` : nothing}
        <button class="worktree-toggle" type="button" role="switch" aria-label="Use a separate Git worktree" aria-checked=${this.workMode === 'worktree'} title=${this.projectId === 'ungrouped' || this.projectId === 'new' ? 'Choose an existing project to use a worktree' : 'Start this chat in a separate Git worktree'} ?disabled=${this.projectId === 'ungrouped' || this.projectId === 'new'} @click=${() => { this.workMode = this.workMode === 'worktree' ? 'local' : 'worktree'; }}><span>Worktree</span><span class="track" aria-hidden="true"><span class="thumb"></span></span></button>
        </div>
        ${this.attachments.length ? html`<div class="attachments" aria-label="Attached files">${this.attachments.map(a => html`<div class="attachment">${a.preview ? html`<img src=${a.preview} alt="">` : nothing}<span class="filename">${a.file.name}</span><span class="status ${a.error ? 'failed' : ''}">${a.error || (a.uploading ? 'Uploading…' : 'Ready')}</span><button aria-label=${`Remove ${a.file.name}`} @click=${() => this.removeAttachment(a.localId)}>×</button></div>`)}</div>` : nothing}
        <textarea aria-label="First message" placeholder="Describe what you want to work on…" .value=${this.prompt} @input=${(e:Event) => { this.prompt = (e.target as HTMLTextAreaElement).value; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea>
        <div class="composer-actions"><input class="file-input" type="file" multiple aria-label="Choose files to attach" @change=${this.onPick}><button class="attach-button" aria-label="Attach files or images" title="Attach files or images" @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>('.file-input')?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg></button><button class="send" aria-label="Send message" ?disabled=${(!this.prompt.trim() && !this.attachments.length) || this.busy || !this.startOptions?.length || this.attachments.some(a => a.uploading || !!a.error)} @click=${() => void this.send()}>↑</button></div>

        ${this.dropActive ? html`<div class="drop-overlay" role="status">Drop files to attach</div>` : nothing}
      </div>
      ${this.busy ? html`<div class="receipt" role="status">Message received · Creating chat…</div>` : nothing}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
    </div></div>
  `; }
}
