import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';
import { apiPath } from '../lib/base-path.js';
import './mux-sdk-chat-settings.js';
import './mux-sdk-utility.js';

type DisplayAttachment = { id: string; name: string; kind: string };
type SDKEvent = { type: string; text?: string; name?: string; toolId?: string; inputId?: string; inputIds?: string[]; message?: string; kind?: string; raw?: unknown; failed?: boolean; attachments?: DisplayAttachment[] };
type Block = { key: number; kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'error' | 'status'; text: string; name?: string; id?: string; done?: boolean; input?: unknown; output?: unknown; failed?: boolean; attachments?: DisplayAttachment[] };

type Attachment = { localId: string; file: File; id?: string; kind?: string; preview?: string; error?: string; uploading: boolean };
@customElement('mux-sdk-chat')
export class MuxSDKChat extends LitElement {
  @property() sessionId = '';
  @state() private chat?: SDKChat;
  @state() private blocks: Block[] = [];
  @state() private draft = '';
  @state() private error = '';
  @state() private busy = false;
  @state() private stopping = false;
  @state() private drawerOpen = false;
  @state() private drawerWidth = 0;
  private resizingDrawer = false;
  @state() private attachments: Attachment[] = [];
  @state() private dropActive = false;
  @state() private settingsPending = false;
  private dragDepth = 0;
  private stream?: EventSource;
  private unsubscribeChats?: () => void;
  private parsers = new Map<number, MarkdownStream>();
  private preventFileNavigation = (event: DragEvent) => { if (this.hasFiles(event)) event.preventDefault(); };
  private resetDrop = () => { this.dragDepth = 0; this.dropActive = false; };
  private expanded = new Set<number>();
  private nextBlockKey = 0;
  private turnStart = 0;
  private completedInputAnchors = new Map<string, number>();
  static styles = css`
    :host { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; background:var(--chrome-bg,#1a1c28); color:var(--chrome-text-bright,#d9def0); font:13px/1.55 system-ui,sans-serif; }
    .topbar { min-height:44px; display:flex; align-items:center; gap:12px; padding:0 22px; border-bottom:1px solid var(--chrome-border,#343a4c); }
    h1 { font-size:14px; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .meta { margin-left:auto; color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    button { font:inherit; cursor:pointer; }
    .drawer-toggle { border:0; background:transparent; color:#9cbaf5; padding:7px; }
    .layout { display:flex; flex:1; min-height:0; }
    .chat { flex:1; min-width:0; display:flex; flex-direction:column; }
    .body { flex:1; min-height:0; overflow:auto; padding:32px clamp(24px,8vw,120px) 55px; display:flex; flex-direction:column; }
    .block { max-width:780px; width:100%; align-self:center; margin-bottom:22px; }
    .block.tool, .block.thinking { margin-bottom:5px; }
    .block.tool + .block.assistant, .block.thinking + .block.assistant { margin-top:17px; }
    .user { display:flex; justify-content:flex-end; }
    .bubble { max-width:min(82%,660px); padding:10px 14px; border-radius:15px; background:rgba(122,162,247,.14); white-space:pre-wrap; overflow-wrap:anywhere; }
    .bubble img { display:block; max-width:min(100%,320px); max-height:260px; border-radius:9px; margin-top:8px; object-fit:contain; }
    .bubble a { display:block; margin-top:7px; color:#b7c9ed; }
    .speaker { color:var(--chrome-text-dim,#9aa3b8); font-size:11px; margin-bottom:7px; }
    .text { overflow-wrap:anywhere; }
    .text :is(p,pre) { margin:0 0 10px; }
    details.support { color:var(--chrome-text-dim,#9aa3b8); font-size:12px; }
    details.support summary { cursor:pointer; display:flex; align-items:center; gap:8px; min-height:24px; width:fit-content; max-width:100%; list-style:none; }
    details.support summary::-webkit-details-marker { display:none; }
    .tool-hint { color:var(--chrome-text-dim,#9aa3b8); overflow-wrap:anywhere; }

    details.support summary:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .support-icon { flex:none; width:14px; text-align:center; font:13px/1 ui-monospace,monospace; }
    .support-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .support-meta { flex:none; font-size:11px; }
    .support-chevron { flex:none; font-size:10px; opacity:.7; transition:transform .15s ease; }
    details.support[open] .support-chevron { transform:rotate(90deg); }
    details.support.thinking { border-left:2px solid color-mix(in srgb,var(--chrome-text-dim,#9aa3b8) 55%,transparent); padding-left:9px; }
    details.support.thinking summary { color:var(--chrome-text-dim,#9aa3b8); font-style:italic; }
    details.support.thinking .support-icon { font-style:normal; }
    details.support.thinking .support-meta { opacity:.78; font-style:normal; }
    details.support.tool summary { padding:2px 9px 2px 7px; border:1px solid var(--chrome-border,#41485f); border-radius:5px; background:var(--chrome-bar,#202632); color:#b7c9ed; font-style:normal; }
    details.support.tool .support-icon { color:#9cbaf5; }
    details.support.tool .support-title { font-weight:600; }
    details.support.tool .support-meta { color:var(--chrome-text-dim,#9aa3b8); }
    details.support.tool.failed summary { border-color:color-mix(in srgb,#e6a5a5 45%,var(--chrome-border,#41485f)); }
    details.support.tool.failed .support-icon, details.support.tool.failed .support-meta { color:#e6a5a5; }
    .detail { padding:7px 12px 10px; max-width:100%; }
    details.support[open] { width:100%; }
    details.support.tool[open] .detail { border-left:1px solid var(--chrome-border,#41485f); margin-left:7px; }
    .detail-label { color:#9cbaf5; font-weight:600; margin:9px 0 4px; }
    .detail pre { margin:0; padding:8px 10px; border-radius:6px; background:rgba(0,0,0,.2); white-space:pre-wrap; overflow-wrap:anywhere; max-height:420px; overflow:auto; color:var(--chrome-text-bright,#d9def0); font:12px/1.5 ui-monospace,monospace; }
    .truncation { padding:6px 10px 0; color:#d7bc8b; font:11px/1.5 ui-monospace,monospace; }
    .error { color:#e6a5a5; }
    .composer-wrap { padding:0 clamp(24px,8vw,120px) 18px; }
    .attachments { display:flex; flex-wrap:wrap; gap:8px; padding:0 0 9px; }
    .attachment { display:flex; align-items:center; gap:8px; max-width:100%; padding:6px 8px; border:1px solid var(--chrome-border,#41485f); border-radius:10px; background:var(--chrome-bar,#202632); }
    .attachment img { width:96px; height:72px; object-fit:contain; border-radius:6px; background:#fff; }
    .attachment .filename { max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .attachment .status { color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    .attachment .status.failed { color:#f0aaa8; }
    .attachment button { background:transparent; color:inherit; border:0; font-size:18px; }
    .attach-button { flex:none; height:38px; display:flex; align-items:center; gap:7px; align-self:center; border:1px solid #829ad0; border-radius:11px; padding:0 12px; background:#344b70; color:#fff; font-size:13px; font-weight:650; white-space:nowrap; }
    .attach-button svg { width:19px; height:19px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
    .attach-button:hover, .attach-button:focus-visible { background:#3b5278; outline:2px solid #9bb8f7; outline-offset:2px; }
    .file-input { display:none; }
    .drop-overlay { position:absolute; inset:8px; z-index:10; display:grid; place-items:center; border:2px dashed #9bb8f7; border-radius:16px; background:rgba(25,35,60,.92); color:#d9e5ff; font-size:22px; pointer-events:none; }
    .composer { max-width:780px; margin:auto; border:1px solid var(--chrome-border,#41485f); border-radius:16px; background:rgba(0,0,0,.15); padding:11px 12px; }
    .composer-row { display:flex; align-items:flex-start; gap:8px; }
    .composer-controls { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:7px; min-height:31px; }

    .composer-controls .send { margin-left:auto; }
    textarea { flex:1; min-width:0; resize:none; border:0; outline:none; background:transparent; color:inherit; font:inherit; min-height:38px; height:38px; padding:9px 0 0; box-sizing:border-box; }
    .send { width:31px; height:31px; border-radius:50%; border:0; background:#9bb8f7; color:#152032; font-size:18px; }
    .send:disabled { opacity:.38; }
    .stop { width:38px; height:38px; margin-left:auto; border-radius:50%; border:1px solid #ed9898; background:#aa3f4a; color:white; font-size:18px; font-weight:700; }
    .stop:disabled { opacity:.6; }
    .steer { margin-left:auto; border:1px solid #9bb8f7; border-radius:9px; background:#293c60; color:#e5edff; padding:6px 10px; font-weight:600; }
    .steer + .stop { margin-left:0; }
    .status { color:#e6bd8d; font-size:12px; }
    .drawer { position:relative; flex:none; width:var(--utility-width); min-width:0; border-left:1px solid var(--chrome-border,#343a4c); background:var(--chrome-bar,#202632); animation:drawer-in .16s ease-out; }
    .drawer-resizer { position:absolute; z-index:2; left:-5px; top:0; bottom:0; width:10px; cursor:col-resize; touch-action:none; }
    .drawer-resizer:hover, .drawer-resizer:focus-visible { background:rgba(155,184,247,.25); outline:none; }
    @keyframes drawer-in { from { transform:translateX(18px); opacity:.55; } to { transform:translateX(0); opacity:1; } }
    @media(max-width:700px) { .drawer { position:absolute; right:0; top:44px; bottom:0; box-shadow:-10px 0 30px #0008; } }
  `;
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('dragover', this.preventFileNavigation);
    window.addEventListener('drop', this.preventFileNavigation);
    window.addEventListener('drop', this.resetDrop);
    window.addEventListener('dragend', this.resetDrop);
    this.unsubscribeChats = sdkChats.subscribe(() => this.requestUpdate());
    this.connect();
  }
  override disconnectedCallback() {
    window.removeEventListener('dragover', this.preventFileNavigation);
    window.removeEventListener('drop', this.preventFileNavigation);
    window.removeEventListener('drop', this.resetDrop);
    window.removeEventListener('dragend', this.resetDrop);
    this.unsubscribeChats?.();
    this.stream?.close();
    for (const a of this.attachments) if (a.preview) URL.revokeObjectURL(a.preview);
    super.disconnectedCallback();
  }
  override willUpdate(changed: Map<string, unknown>) { if (changed.has('sessionId')) this.connect(); }
  private drawerKey() { return `muxterm.sdk.utility.width.${this.sessionId}`; }
  private widthLimits() {
    const available = this.shadowRoot?.querySelector<HTMLElement>('.layout')?.clientWidth || this.clientWidth || window.innerWidth;
    return { min: Math.min(280, available * .6), max: available <= 700 ? available * .9 : Math.max(280, available - 480), available };
  }
  private openDrawer() {
    if (this.drawerOpen) { this.drawerOpen = false; return; }
    const { min, max, available } = this.widthLimits();
    let stored = 0;
    try { stored = Number(localStorage.getItem(this.drawerKey())) || 0; } catch { /* private browsing */ }
    this.drawerWidth = Math.round(Math.max(min, Math.min(max, stored || available / 2)));
    this.drawerOpen = true;
  }
  private startDrawerResize(event: PointerEvent) {
    event.preventDefault();
    this.resizingDrawer = true;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
  }
  private moveDrawerResize(event: PointerEvent) {
    if (!this.resizingDrawer) return;
    const { min, max } = this.widthLimits();
    const right = this.shadowRoot?.querySelector<HTMLElement>('.layout')?.getBoundingClientRect().right || window.innerWidth;
    this.drawerWidth = Math.round(Math.max(min, Math.min(max, right - event.clientX)));
  }
  private endDrawerResize() {
    if (!this.resizingDrawer) return;
    this.resizingDrawer = false;
    try { localStorage.setItem(this.drawerKey(), String(this.drawerWidth)); } catch { /* private browsing */ }
  }
  private planTasks(): { content: string; status: string }[] {
    let latest: { content: string; status: string }[] = [];
    for (const block of this.blocks) {
      if (block.kind !== 'tool' || !/update_plan|todowrite|tool-todo|(^|[:_ ])todo($|[:_ ])/i.test(block.name || '')) continue;
      let raw = block.input;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = {}; } }
      const fields = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const result = block.output && typeof block.output === 'object' ? block.output as Record<string, unknown> : {};
      const resultBody = result.output && typeof result.output === 'object' ? result.output as Record<string, unknown> : {};
      const items = resultBody.todos || fields.plan || fields.todos || fields.tasks;
      if (!Array.isArray(items)) continue;
      const parsed = items.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const row = item as Record<string, unknown>;
        const content = row.step || row.content || row.task || row.title;
        return typeof content === 'string' && content.trim() ? [{ content, status: typeof row.status === 'string' ? row.status : 'pending' }] : [];
      });
      if (parsed.length) latest = parsed;
    }
    return latest;
  }
  private touchedFiles(): string[] {
    const found = new Set<string>();
    const root = this.chat?.projectPath?.replace(/\/$/, '') || '';
    const add = (candidate: unknown) => {
      if (typeof candidate !== 'string' || !candidate) return;
      const rel = root && candidate.startsWith(root + '/') ? candidate.slice(root.length + 1) : candidate;
      if (!rel.startsWith('/') && !rel.split('/').includes('..') && rel !== '.') found.add(rel);
    };
    for (const block of this.blocks) {
      if (block.kind !== 'tool') continue;
      const raw = block.input;
      if (!raw || typeof raw !== 'object') continue;
      const data = raw as Record<string, unknown>;
      add(data.file_path); add(data.path);
      for (const source of [data.patch, data.code, data.source, data.input]) {
        if (typeof source !== 'string') continue;
        for (const match of source.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) add(match[1]);
      }
    }
    return [...found].slice(-30).reverse();
  }
  private connect() {
    if (!this.isConnected || !this.sessionId) return;
    this.stream?.close(); this.blocks = []; this.parsers.clear(); this.expanded.clear(); this.nextBlockKey = 0; this.turnStart = 0; this.completedInputAnchors.clear(); this.error = ''; this.settingsPending = false; this.chat = sdkChats.chats.find(c => c.id === this.sessionId);
    const source = new EventSource(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/events`));
    source.addEventListener('snapshot', e => { this.chat = JSON.parse((e as MessageEvent).data) as SDKChat; this.busy = this.chat.state === 'working'; });
    source.addEventListener('sdk', e => this.onEvent(JSON.parse((e as MessageEvent).data) as SDKEvent));
    source.onerror = () => { this.error = 'Connection to the chat stream was interrupted.'; };
    this.stream = source;
  }
  private onEvent(event: SDKEvent) {
    const blocks = [...this.blocks];
    if (event.type === 'input.accepted') {
      // The harness can stream a fast reply before its send receipt arrives.
      const anchor = event.inputId ? this.completedInputAnchors.get(event.inputId) : undefined;
      let at = anchor === undefined ? this.turnStart : blocks.findIndex(b => b.key === anchor);
      if (at < 0) at = this.turnStart;
      while (blocks[at]?.kind === 'user') at++;
      blocks.splice(at, 0, { key:++this.nextBlockKey, kind:'user', text:event.text || '', attachments:event.attachments || [] });
      if (at < this.turnStart) this.turnStart++;
      this.busy = true;
    }
    else if (event.type === 'assistant.delta') {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'assistant' && !last.done) blocks[blocks.length - 1] = { ...last, text:last.text + (event.text || '') };
      else blocks.push({ key:++this.nextBlockKey, kind:'assistant', text:event.text || '' });
    } else if (event.type === 'thinking.delta') {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'thinking') blocks[blocks.length - 1] = { ...last, text:last.text + (event.text || '') };
      else blocks.push({ key:++this.nextBlockKey, kind:'thinking', text:event.text || '' });
    } else if (event.type === 'tool.started') {
      // Text before a tool call was an interim progress note, not the final answer.
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'assistant' && !last.done) blocks[blocks.length - 1] = { ...last, kind:'thinking', done:true };
      const existing = blocks.findIndex(b => b.kind === 'tool' && b.id === event.toolId && !b.done);
      if (existing >= 0) blocks[existing] = { ...blocks[existing], name:event.name || blocks[existing].name, input:event.raw ?? blocks[existing].input };
      else blocks.push({ key:++this.nextBlockKey, kind:'tool', text:'Running', name:event.name || 'Tool', id:event.toolId, input:event.raw });
    }
    else if (event.type === 'tool.completed') {
      let index = -1; for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'tool' && blocks[i].id === event.toolId && !blocks[i].done) { index = i; break; }
      if (index >= 0) blocks[index] = { ...blocks[index], done:true, text:event.failed ? 'Failed' : 'Completed', failed:event.failed,
        output:event.raw };
      else blocks.push({ key:++this.nextBlockKey, kind:'tool', text:event.failed ? 'Failed' : 'Completed', name:event.name || 'Tool', id:event.toolId, done:true, failed:event.failed,
        output:event.raw });
    } else if (event.type === 'tool.result') {
      let index = -1; for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'tool' && blocks[i].id === event.toolId) { index = i; break; }
      if (index >= 0) blocks[index] = { ...blocks[index], output:event.raw, done:true };
    } else if (event.type === 'turn.continued') {
      for (const b of blocks) if (b.kind === 'assistant') b.done = true;
    } else if (event.type === 'turn.completed') {
      this.busy = false;
      for (const b of blocks) if (b.kind === 'assistant') b.done = true;
      const anchor = blocks[this.turnStart]?.key;
      if (anchor !== undefined) for (const id of event.inputIds || []) this.completedInputAnchors.set(id, anchor);
      this.turnStart = blocks.length;
      void sdkChats.refresh();
    }
    else if (event.type === 'turn.cancelled') {
      this.busy = false;
      this.stopping = false;
      for (const b of blocks) if (b.kind === 'assistant') b.done = true;
      blocks.push({ key:++this.nextBlockKey, kind:'status', text:'Stopped by you · partial output kept' });
      this.turnStart = blocks.length;
      void sdkChats.refresh();
    }
    else if (event.type === 'error' || event.type === 'session.uncertain') { blocks.push({ key:++this.nextBlockKey, kind:'error', text:event.message || 'Session error' }); this.turnStart = blocks.length; this.busy = false; void sdkChats.refresh(); }
    this.blocks = blocks;
    const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
    const follow = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 100;
    if (follow) void this.updateComplete.then(() => { const b = this.shadowRoot?.querySelector<HTMLElement>('.body'); if (b) b.scrollTop = b.scrollHeight; });
  }
  private markdown(block: Block, index: number) {
    let parser = this.parsers.get(index);
    if (!parser) { parser = new MarkdownStream(); this.parsers.set(index, parser); }
    return renderSegments(parser.update(block.text, !block.done));
  }
  private userBubble(block: Block) {
    return html`<div class="bubble">${block.text}${block.attachments?.map(attachment => attachment.kind === 'image'
      ? html`<img src=${apiPath(`/api/sdk-chat-attachments/${encodeURIComponent(attachment.id)}`)} alt=${attachment.name} loading="lazy">`
      : html`<a href=${apiPath(`/api/sdk-chat-attachments/${encodeURIComponent(attachment.id)}`)} target="_blank" rel="noopener">${attachment.name}</a>`)}</div>`;
  }
  private hasFiles(event: DragEvent) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
  private onDragEnter(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth++; this.dropActive = true; }
  private onDragOver(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; this.dropActive = true; }
  private onDragLeave(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth = Math.max(0, this.dragDepth - 1); if (!this.dragDepth) this.dropActive = false; }
  private onDrop(event: DragEvent) {
    if (!this.hasFiles(event)) return;
    event.preventDefault(); event.stopPropagation(); this.resetDrop();
    this.addFiles(Array.from(event.dataTransfer?.files || []));
  }
  private onPick(event: Event) {
    const input = event.target as HTMLInputElement;
    this.addFiles(Array.from(input.files || [])); input.value = '';
  }
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
      // The upload response is authoritative about image versus generic file.
      const item: Attachment = { localId: crypto.randomUUID(), file, uploading: true };
      this.attachments = [...this.attachments, item];
      void this.upload(item);
    }
  }
  private async upload(item: Attachment) {
    const form = new FormData(); form.append('file', item.file);
    try {
      const response = await fetch(apiPath('/api/sdk-chat-attachments'), {
        method: 'POST', headers: { 'X-Muxterm-Chat-Attachment': '1' }, body: form,
      });
      const body = await response.text();
      let payload: { id?: string; kind?: string; reason?: string } = {};
      try { payload = JSON.parse(body) as typeof payload; } catch { /* Preserve non-JSON server errors below. */ }
      if (!response.ok) throw new Error(payload.reason || body.trim() || `Upload failed (${response.status})`);
      if (!payload.id || !payload.kind) throw new Error('Upload response lacked attachment details');
      if (!this.attachments.some(a => a.localId === item.localId)) return;
      const preview = payload.kind === 'image' ? URL.createObjectURL(item.file) : undefined;
      this.attachments = this.attachments.map(a => a.localId === item.localId
        ? { ...a, id: payload.id, kind: payload.kind, preview, uploading: false } : a);
    } catch (error) {
      if (!this.attachments.some(a => a.localId === item.localId)) return;
      this.attachments = this.attachments.map(a => a.localId === item.localId
        ? { ...a, uploading: false, error: error instanceof Error ? error.message : String(error) } : a);
    }
  }
  private removeAttachment(localId: string) {
    const item = this.attachments.find(a => a.localId === localId);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    this.attachments = this.attachments.filter(a => a.localId !== localId);
  }
  private detail(value: unknown): string {
    if (value == null) return 'No detail was supplied by the harness.';
    let rendered: string;
    if (typeof value === 'string') rendered = value || '(empty)';
    else if (Array.isArray(value)) rendered = value.map(item => item && typeof item === 'object' && 'text' in item
      ? String((item as { text: unknown }).text) : JSON.stringify(item, null, 2)).join('\n');
    else rendered = JSON.stringify(value, null, 2) || String(value);
    const limit = 12000;
    return rendered.length > limit ? `${rendered.slice(0, limit)}\n… truncated after ${limit.toLocaleString()} characters (${rendered.length.toLocaleString()} total)` : rendered;
  }
  private toolInput(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    const raw = value as Record<string, unknown>;
    if (raw.type === 'tool_use') return raw.input;
    if (raw.type === 'commandExecution') return { command:raw.command, cwd:raw.cwd };
    if (raw.type === 'mcpToolCall') return { server:raw.server, tool:raw.tool, arguments:raw.arguments };
    return value;
  }
  private toolOutput(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    const raw = value as Record<string, unknown>;
    if (raw.type === 'tool_result') return raw.content;
    if (raw.type === 'commandExecution') return `Exit code: ${raw.exitCode ?? 'unknown'} · ${raw.status || 'unknown'}\n\n${raw.aggregatedOutput || ''}`;
    if (raw.type === 'mcpToolCall') return { result:raw.result, error:raw.error, status:raw.status };
    if (typeof raw.output === 'string') return `Exit code: ${raw.exitCode ?? 'unknown'} · ${raw.status || 'unknown'}\n\n${raw.output}`;
    if (raw.output && typeof raw.output === 'object') {
      const output = raw.output as Record<string, unknown>;
      if (typeof output.content === 'string') return output.content;
      if ('stdout' in output || 'stderr' in output) return `Exit code: ${output.returncode ?? 'unknown'}\n${output.stderr ? `stderr:\n${output.stderr}\n` : ''}\n${output.stdout || ''}`;
    }
    return value;
  }
  private toolFailed(block: Block): boolean {
    if (block.failed) return true;
    if (!block.done || !block.output || typeof block.output !== 'object') return false;
    const result = block.output as Record<string, unknown>;
    if (result.status === 'failed' || result.is_error === true || result.isError === true) return true;
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) return true;
    const output = result.output;
    return !!output && typeof output === 'object' && typeof (output as Record<string, unknown>).returncode === 'number'
      && (output as Record<string, unknown>).returncode !== 0;
  }
  private support(block: Block) {
    const thinking = block.kind === 'thinking';
    const input = this.toolInput(block.input);
    const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const hint = fields.command || fields.file_path || fields.path || fields.url;

    const failed = !thinking && this.toolFailed(block);
    const words = block.text.trim().split(/\s+/).filter(Boolean).length;
    const output = block.done ? this.detail(this.toolOutput(block.output)) : 'Running…';
    const truncated = output.match(/\n(… truncated after [^\n]+)$/);
    return html`<details class="support ${thinking ? 'thinking' : 'tool'} ${failed ? 'failed' : ''}" ?open=${this.expanded.has(block.key)} @toggle=${(e: globalThis.Event) => {
      if ((e.currentTarget as HTMLDetailsElement).open) this.expanded.add(block.key); else this.expanded.delete(block.key);
    }}><summary><span class="support-icon" aria-hidden="true">${thinking ? '◌' : failed ? '×' : block.done ? '›' : '·'}</span><span class="support-title">${thinking ? 'Thinking' : block.name || 'Tool'}</span>${!thinking && typeof hint === 'string' ? html`<span class="tool-hint">${hint}</span>` : nothing}<span class="support-meta">${thinking ? `${words} words` : block.done ? failed ? 'Failed' : 'Succeeded' : 'Running'}</span><span class="support-chevron" aria-hidden="true">▸</span></summary><div class="detail">${thinking
      ? html`<pre>${block.text}</pre>`
      : html`<div class="detail-label">Tool</div><pre>${block.name || 'Tool'}</pre><div class="detail-label">Input arguments</div><pre>${this.detail(input)}</pre><div class="detail-label">Output / result</div><pre>${truncated ? output.slice(0, -truncated[0].length) : output}</pre>${truncated ? html`<div class="truncation">${truncated[1]}</div>` : nothing}`}
    </div></details>`;
  }
  private async send() {
    const content = this.draft.trim();
    if ((!content && !this.attachments.length) || this.stopping || this.settingsPending || this.attachments.some(a => a.uploading || a.error) || (this.busy && this.attachments.length > 0)) return;
    const kind = this.busy ? 'steer' : 'user';
    const sent = this.attachments;
    this.draft = '';
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}`), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ kind, source:'browser', id:crypto.randomUUID(), content, attachments: sent.map(a => a.id) }) });
      if (!response.ok) throw new Error(await response.text());
      for (const item of sent) if (item.preview) URL.revokeObjectURL(item.preview);
      this.attachments = this.attachments.filter(a => !sent.includes(a));
      this.error = '';
    } catch (error) { this.error = String(error); this.draft = content; }
  }
  private async stop() {
    if (!this.busy || this.stopping) return;
    this.stopping = true;
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/interrupt`), { method:'POST' });
      if (!response.ok) throw new Error(await response.text());
      this.error = '';
    } catch (error) { this.error = String(error); }
    finally { this.stopping = false; }
  }
  override render() { return html`
    <div class="topbar"><h1 title=${this.chat?.title || 'Chat'}>${this.chat?.title || 'Chat'}</h1><span class="meta">${this.chat?.harness || ''} · ${sdkChats.projects.find(project => project.id === this.chat?.workspaceId)?.name || 'Ungrouped'}</span><button class="drawer-toggle" aria-label=${this.drawerOpen ? 'Close right drawer' : 'Open right drawer'} aria-expanded=${this.drawerOpen} @click=${this.openDrawer}>▥</button></div>
    <div class="layout" @dragenter=${this.onDragEnter} @dragover=${this.onDragOver} @dragleave=${this.onDragLeave} @drop=${this.onDrop}><div class="chat"><div class="body">
      ${this.blocks.length ? this.blocks.map(b => html`<div class="block ${b.kind}">${b.kind === 'user' ? this.userBubble(b) : b.kind === 'assistant' ? html`<div class="speaker">${this.chat?.harness}</div><div class="text">${this.markdown(b, b.key)}</div>` : b.kind === 'tool' || b.kind === 'thinking' ? this.support(b) : html`<div class="${b.kind}">${b.text}</div>`}</div>`) : html`<div class="block">Starting the SDK session…</div>`}
      ${this.error ? html`<div class="block error" role="alert">${this.error}</div>` : nothing}
    </div><div class="composer-wrap"><div class="composer" @paste=${this.onPaste}>
      ${this.attachments.length ? html`<div class="attachments" aria-label="Attached files">${this.attachments.map(a => html`<div class="attachment">
        ${a.kind === 'image' && a.preview ? html`<img src=${a.preview} alt=${a.file.name}>` : nothing}
        <span class="filename" title=${a.file.name}>${a.file.name}</span>
        <span class="status ${a.error ? 'failed' : ''}" role=${a.error ? 'alert' : 'status'}>${a.error || (a.uploading ? 'Uploading…' : '')}</span>
        <button aria-label=${`Remove ${a.file.name}`} @click=${() => this.removeAttachment(a.localId)}>×</button>
      </div>`)}</div>` : nothing}
      <div class="composer-row"><input class="file-input" type="file" multiple @change=${this.onPick} aria-label="Choose files to attach"><button class="attach-button" aria-label="Attach files or images" title="Attach files or images" @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>('.file-input')?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>Attach</button><textarea aria-label=${this.busy ? 'Steer running turn' : 'Message'} placeholder=${this.busy ? 'Steer this turn…' : `Message ${this.chat?.harness || 'agent'}…`} .value=${this.draft} @input=${(e: InputEvent) => { this.draft = (e.target as HTMLTextAreaElement).value; }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea></div>
      <div class="composer-controls"><mux-sdk-chat-settings .sessionId=${this.sessionId} .harness=${this.chat?.harness || ''} .turnBusy=${this.busy} @settings-pending=${(e: CustomEvent<boolean>) => { this.settingsPending = e.detail; }}></mux-sdk-chat-settings>${this.busy ? html`${this.draft.trim() ? html`<button class="steer" aria-label="Steer running turn" ?disabled=${this.stopping || this.attachments.length > 0} @click=${() => void this.send()}>Steer ↗</button>` : nothing}<button class="stop" aria-label="Stop current turn" title="Stop current turn" ?disabled=${this.stopping} @click=${() => void this.stop()}>■</button>` : html`<button class="send" aria-label="Send message" ?disabled=${(!this.draft.trim() && !this.attachments.length) || this.settingsPending || this.attachments.some(a => a.uploading || !!a.error)} @click=${() => void this.send()}>↑</button>`}</div>


    </div></div></div>
      ${this.drawerOpen ? html`<aside class="drawer" aria-label="Right drawer" style=${`--utility-width:${this.drawerWidth}px`}><div class="drawer-resizer" role="separator" aria-label="Resize right drawer" aria-orientation="vertical" tabindex="0" @pointerdown=${this.startDrawerResize} @pointermove=${this.moveDrawerResize} @pointerup=${this.endDrawerResize} @lostpointercapture=${this.endDrawerResize} @keydown=${(e: KeyboardEvent) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const {min,max}=this.widthLimits(); this.drawerWidth=Math.round(Math.max(min,Math.min(max,this.drawerWidth+(e.key === 'ArrowLeft' ? 20 : -20)))); try { localStorage.setItem(this.drawerKey(),String(this.drawerWidth)); } catch { /* private browsing */ } e.preventDefault(); } }}></div><mux-sdk-utility .sessionId=${this.sessionId} .projectPath=${this.chat?.projectPath || ''} .harness=${this.chat?.harness || ''} .tasks=${this.planTasks()} .touched=${this.touchedFiles()}></mux-sdk-utility></aside>` : nothing}
    </div>${this.dropActive ? html`<div class="drop-overlay" role="status">Drop files to attach</div>` : nothing}`; }
}
