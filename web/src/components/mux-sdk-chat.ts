import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';
import { apiPath } from '../lib/base-path.js';
import './mux-amplifier-settings.js';

type SDKEvent = { type: string; text?: string; name?: string; toolId?: string; inputId?: string; inputIds?: string[]; message?: string; kind?: string; raw?: unknown; failed?: boolean };
type Block = { key: number; kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'error'; text: string; name?: string; id?: string; done?: boolean; input?: unknown; output?: unknown; failed?: boolean };
type Attachment = { localId: string; file: File; id?: string; kind?: string; preview?: string; error?: string; uploading: boolean };
@customElement('mux-sdk-chat')
export class MuxSDKChat extends LitElement {
  @property() sessionId = '';
  @state() private chat?: SDKChat;
  @state() private blocks: Block[] = [];
  @state() private draft = '';
  @state() private error = '';
  @state() private busy = false;
  @state() private drawerOpen = false;
  @state() private attachments: Attachment[] = [];
  @state() private dropActive = false;
  @state() private settingsPending = false;
  private dragDepth = 0;
  private stream?: EventSource;
  private parsers = new Map<number, MarkdownStream>();
  private preventFileNavigation = (event: DragEvent) => { if (this.hasFiles(event)) event.preventDefault(); };
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
    .body { flex:1; min-height:0; overflow:auto; padding:32px clamp(24px,8vw,120px) 55px; display:flex; flex-direction:column; gap:24px; }
    .block { max-width:780px; width:100%; align-self:center; }
    .user { display:flex; justify-content:flex-end; }
    .bubble { max-width:min(82%,660px); padding:10px 14px; border-radius:15px; background:rgba(122,162,247,.14); white-space:pre-wrap; overflow-wrap:anywhere; }
    .speaker { color:var(--chrome-text-dim,#9aa3b8); font-size:11px; margin-bottom:7px; }
    .text { overflow-wrap:anywhere; }
    .text :is(p,pre) { margin:0 0 10px; }
    details.support { border:1px solid var(--chrome-border,#41485f); border-radius:9px; background:rgba(122,162,247,.045); color:var(--chrome-text-dim,#b2bdd3); font-size:12px; }
    details.support summary { cursor:pointer; padding:7px 11px; color:#b7c9ed; list-style:none; }
    details.support summary::-webkit-details-marker { display:none; }
    details.support summary::before { content:'▸'; display:inline-block; margin-right:8px; }
    details.support[open] summary::before { transform:rotate(90deg); }
    .detail { padding:0 12px 10px; }
    .detail-label { color:#9cbaf5; font-weight:600; margin:9px 0 4px; }
    .detail pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; max-height:420px; overflow:auto; color:var(--chrome-text-bright,#d9def0); font:12px/1.5 ui-monospace,monospace; }
    .error { color:#e6a5a5; }
    .composer-wrap { padding:0 clamp(24px,8vw,120px) 18px; }
    .attachments { display:flex; flex-wrap:wrap; gap:8px; padding:0 0 9px; }
    .attachment { display:flex; align-items:center; gap:8px; max-width:100%; padding:6px 8px; border:1px solid var(--chrome-border,#41485f); border-radius:10px; background:var(--chrome-bar,#202632); }
    .attachment img { width:44px; height:44px; object-fit:cover; border-radius:6px; }
    .attachment .filename { max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .attachment .status { color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    .attachment .status.failed { color:#f0aaa8; }
    .attachment button { background:transparent; color:inherit; border:0; font-size:18px; }
    .attach-button { flex:none; height:38px; display:flex; align-items:center; gap:5px; border:1px solid #66799f; border-radius:11px; padding:0 10px; background:#283852; color:#e4edff; font-size:12px; font-weight:600; }
    .attach-button svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
    .attach-button:hover, .attach-button:focus-visible { background:#3b5278; outline:2px solid #9bb8f7; outline-offset:2px; }
    .file-input { display:none; }
    .drop-overlay { position:absolute; inset:8px; z-index:10; display:grid; place-items:center; border:2px dashed #9bb8f7; border-radius:16px; background:rgba(25,35,60,.92); color:#d9e5ff; font-size:22px; pointer-events:none; }
    .composer { max-width:780px; margin:auto; border:1px solid var(--chrome-border,#41485f); border-radius:16px; background:rgba(0,0,0,.15); padding:11px 12px; }
    .composer-row { display:flex; align-items:flex-end; gap:10px; }
    .composer-controls { display:flex; align-items:center; margin-top:8px; padding-top:8px; border-top:1px solid var(--chrome-border,#41485f); }
    textarea { flex:1; min-width:0; resize:none; border:0; outline:none; background:transparent; color:inherit; font:inherit; height:46px; }
    .send { width:31px; height:31px; border-radius:50%; border:0; background:#9bb8f7; color:#152032; font-size:18px; }
    .send:disabled { opacity:.38; }
    .drawer { width:min(32vw,420px); min-width:220px; border-left:1px solid var(--chrome-border,#343a4c); background:var(--chrome-bar,#202632); }
    @media(max-width:700px) { .drawer { position:absolute; right:0; top:44px; bottom:0; width:min(80vw,420px); box-shadow:-10px 0 30px #0008; } }
  `;
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('dragover', this.preventFileNavigation);
    window.addEventListener('drop', this.preventFileNavigation);
    this.connect();
  }
  override disconnectedCallback() {
    window.removeEventListener('dragover', this.preventFileNavigation);
    window.removeEventListener('drop', this.preventFileNavigation);
    this.stream?.close();
    for (const a of this.attachments) if (a.preview) URL.revokeObjectURL(a.preview);
    super.disconnectedCallback();
  }
  override willUpdate(changed: Map<string, unknown>) { if (changed.has('sessionId')) this.connect(); }
  private connect() {
    if (!this.isConnected || !this.sessionId) return;
    this.stream?.close(); this.blocks = []; this.parsers.clear(); this.expanded.clear(); this.nextBlockKey = 0; this.turnStart = 0; this.completedInputAnchors.clear(); this.error = ''; this.settingsPending = false; this.chat = sdkChats.chats.find(c => c.id === this.sessionId);
    const source = new EventSource(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/events`));
    source.addEventListener('snapshot', e => { this.chat = JSON.parse((e as MessageEvent).data) as SDKChat; });
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
      blocks.splice(at, 0, { key:++this.nextBlockKey, kind:'user', text:event.text || '' });
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
      blocks.push({ key:++this.nextBlockKey, kind:'tool', text:'Running', name:event.name || 'Tool', id:event.toolId, input:event.raw });
    }
    else if (event.type === 'tool.completed') {
      let index = -1; for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'tool' && blocks[i].id === event.toolId && !blocks[i].done) { index = i; break; }
      const toolUse = !!event.raw && typeof event.raw === 'object' && (event.raw as { type?: string }).type === 'tool_use';
      if (index >= 0) blocks[index] = { ...blocks[index], done:true, text:event.failed ? 'Failed' : 'Completed', failed:event.failed,
        input:toolUse ? event.raw : blocks[index].input || event.raw, output:toolUse ? blocks[index].output : event.raw };
      else blocks.push({ key:++this.nextBlockKey, kind:'tool', text:event.failed ? 'Failed' : 'Completed', name:event.name || 'Tool', id:event.toolId, done:true, failed:event.failed,
        input:toolUse ? event.raw : undefined, output:toolUse ? undefined : event.raw });
    } else if (event.type === 'tool.result') {
      let index = -1; for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'tool' && blocks[i].id === event.toolId) { index = i; break; }
      if (index >= 0) blocks[index] = { ...blocks[index], output:event.raw, done:true };
    } else if (event.type === 'turn.completed') {
      this.busy = false;
      for (const b of blocks) if (b.kind === 'assistant') b.done = true;
      const anchor = blocks[this.turnStart]?.key;
      if (anchor !== undefined) for (const id of event.inputIds || []) this.completedInputAnchors.set(id, anchor);
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
  private hasFiles(event: DragEvent) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
  private onDragEnter(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth++; this.dropActive = true; }
  private onDragOver(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; this.dropActive = true; }
  private onDragLeave(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth = Math.max(0, this.dragDepth - 1); if (!this.dragDepth) this.dropActive = false; }
  private onDrop(event: DragEvent) {
    if (!this.hasFiles(event)) return;
    event.preventDefault(); event.stopPropagation(); this.dragDepth = 0; this.dropActive = false;
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
      const isImage = file.type.startsWith('image/');
      const item: Attachment = { localId: crypto.randomUUID(), file, kind: isImage ? 'image' : undefined,
        preview: isImage ? URL.createObjectURL(file) : undefined, uploading: true };
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
      this.attachments = this.attachments.map(a => a.localId === item.localId
        ? { ...a, id: payload.id, kind: payload.kind, uploading: false } : a);
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
    if (typeof value === 'string') rendered = value;
    else rendered = JSON.stringify(value, null, 2) || String(value);
    const limit = 12000;
    return rendered.length > limit ? `${rendered.slice(0, limit)}\n… truncated (${rendered.length - limit} more characters)` : rendered;
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
    if (raw.output && typeof raw.output === 'object') {
      const output = raw.output as Record<string, unknown>;
      if ('stdout' in output || 'stderr' in output) return `Exit code: ${output.returncode ?? 'unknown'}\n${output.stderr ? `stderr:\n${output.stderr}\n` : ''}\n${output.stdout || ''}`;
    }
    return value;
  }
  private support(block: Block, index: number) {
    const thinking = block.kind === 'thinking';
    const label = thinking ? `Thinking · ${block.text.length} characters` : `${block.name || 'Tool'} · ${block.text}`;
    return html`<details class="support" ?open=${this.expanded.has(index)} @toggle=${(e: globalThis.Event) => {
      if ((e.currentTarget as HTMLDetailsElement).open) this.expanded.add(index); else this.expanded.delete(index);
    }}><summary>${label}</summary><div class="detail">${thinking
      ? html`<pre>${block.text}</pre>`
      : html`<div class="detail-label">Input arguments</div><pre>${this.detail(this.toolInput(block.input))}</pre><div class="detail-label">Output / result</div><pre>${block.done ? this.detail(this.toolOutput(block.output)) : 'Running…'}</pre>`}
    </div></details>`;
  }
  private async send() {
    const content = this.draft.trim();
    if ((!content && !this.attachments.length) || this.busy || this.settingsPending || this.attachments.some(a => a.uploading || a.error)) return;
    const sent = this.attachments;
    this.draft = '';
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}`), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ kind:'user', source:'browser', id:crypto.randomUUID(), content, attachments: sent.map(a => a.id) }) });
      if (!response.ok) throw new Error(await response.text());
      for (const item of sent) if (item.preview) URL.revokeObjectURL(item.preview);
      this.attachments = this.attachments.filter(a => !sent.includes(a));
      this.error = '';
    } catch (error) { this.error = String(error); this.draft = content; }
  }
  override render() { return html`
    <div class="topbar"><h1 title=${this.chat?.title || 'Chat'}>${this.chat?.title || 'Chat'}</h1><span class="meta">${this.chat?.harness || ''} · ${this.chat?.projectPath || ''}</span><button class="drawer-toggle" aria-label=${this.drawerOpen ? 'Close right drawer' : 'Open right drawer'} aria-expanded=${this.drawerOpen} @click=${() => { this.drawerOpen = !this.drawerOpen; }}>▥</button></div>
    <div class="layout" @dragenter=${this.onDragEnter} @dragover=${this.onDragOver} @dragleave=${this.onDragLeave} @drop=${this.onDrop}><div class="chat"><div class="body">
      ${this.blocks.length ? this.blocks.map(b => html`<div class="block ${b.kind}">${b.kind === 'user' ? html`<div class="bubble">${b.text}</div>` : b.kind === 'assistant' ? html`<div class="speaker">${this.chat?.harness}</div><div class="text">${this.markdown(b, b.key)}</div>` : b.kind === 'tool' || b.kind === 'thinking' ? this.support(b, b.key) : html`<div class="error">${b.text}</div>`}</div>`) : html`<div class="block">Starting the SDK session…</div>`}
      ${this.error ? html`<div class="block error" role="alert">${this.error}</div>` : nothing}
    </div><div class="composer-wrap"><div class="composer">
      ${this.attachments.length ? html`<div class="attachments" aria-label="Attached files">${this.attachments.map(a => html`<div class="attachment">
        ${a.kind === 'image' && a.preview ? html`<img src=${a.preview} alt=${a.file.name}>` : nothing}
        <span class="filename" title=${a.file.name}>${a.file.name}</span>
        <span class="status ${a.error ? 'failed' : ''}" role=${a.error ? 'alert' : 'status'}>${a.error || (a.uploading ? 'Uploading…' : '')}</span>
        <button aria-label=${`Remove ${a.file.name}`} @click=${() => this.removeAttachment(a.localId)}>×</button>
      </div>`)}</div>` : nothing}
      <div class="composer-row"><input class="file-input" type="file" multiple @change=${this.onPick} aria-label="Choose files to attach"><button class="attach-button" aria-label="Attach files or images" title="Attach files or images" @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>('.file-input')?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>Attach</button><textarea placeholder="Message ${this.chat?.harness || 'agent'}…" .value=${this.draft} @paste=${this.onPaste} @input=${(e: InputEvent) => { this.draft = (e.target as HTMLTextAreaElement).value; }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea><button class="send" aria-label="Send message" ?disabled=${(!this.draft.trim() && !this.attachments.length) || this.busy || this.settingsPending || this.attachments.some(a => a.uploading || !!a.error)} @click=${() => void this.send()}>↑</button></div>
      ${this.chat?.harness === 'amplifier' ? html`<div class="composer-controls"><mux-amplifier-settings .sessionId=${this.sessionId} .turnBusy=${this.busy} @settings-pending=${(e: CustomEvent<boolean>) => { this.settingsPending = e.detail; }}></mux-amplifier-settings></div>` : nothing}
    </div></div></div>
      ${this.drawerOpen ? html`<aside class="drawer" aria-label="Right drawer" data-dockview-host-seam></aside>` : nothing}
    </div>${this.dropActive ? html`<div class="drop-overlay" role="status">Drop files to attach</div>` : nothing}`; }
}
