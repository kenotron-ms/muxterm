import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';
import { apiPath } from '../lib/base-path.js';
import './mux-sdk-chat-settings.js';
import './mux-sdk-utility.js';

type DisplayAttachment = { id: string; name: string; kind: string };
type SDKEvent = { type: string; at?: string; text?: string; name?: string; toolId?: string; inputId?: string; inputIds?: string[]; message?: string; kind?: string; raw?: unknown; failed?: boolean; complete?: boolean; attachments?: DisplayAttachment[]; childSessionId?: string; parentSessionId?: string; agent?: string };
type AgentLeg = { task: string; reply: string; status: string };
type AgentView = { id: string; parentId: string; name: string; status: string; progress: string; legs: AgentLeg[] };
type Block = { key: number; kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'error' | 'status'; text: string; name?: string; id?: string; done?: boolean; input?: unknown; output?: unknown; failed?: boolean; attachments?: DisplayAttachment[] };
import { icon } from '../lib/icons.js';
import { Brain, Check, ChevronRight, CircleX, Terminal, LoaderCircle } from 'lucide';

type Attachment = { localId: string; file: File; id?: string; kind?: string; preview?: string; error?: string; uploading: boolean };
@customElement('mux-sdk-chat')
export class MuxSDKChat extends LitElement {
  @property() sessionId = '';
  @state() private chat?: SDKChat;
  @state() private blocks: Block[] = [];
  @state() private trajectory: SDKEvent[] = [];
  @state() private selectedAgent = '';
  @state() private agentDraft = '';
  @state() private agentNotice = '';
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
    .breadcrumbs { display:flex; align-items:center; gap:7px; min-width:0; }
    .breadcrumbs button { border:0; padding:4px; border-radius:5px; background:transparent; color:#a9c5fa; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:240px; }
    .breadcrumbs button:hover { background:#35445f; }
    .agent-list { max-width:760px; width:100%; box-sizing:border-box; align-self:center; margin:0 0 24px; padding:14px; border:1px solid #41485f; border-radius:10px; background:#222b3c; }
    .agent-list h2 { margin:0 0 8px; font-size:12px; color:#c0cdeb; }
    .agent-link { width:100%; display:flex; align-items:center; gap:8px; border:0; border-radius:6px; padding:7px; background:transparent; color:#d9def0; text-align:left; }
    .agent-link:hover { background:#35445f; } .agent-link span:last-child { margin-left:auto; color:#9aa9c0; font-size:11px; }
    .agent-chat { max-width:760px; width:100%; align-self:center; }
    .agent-chat .instruction { padding:13px 16px; border-radius:15px; background:#293a56; margin:10px 0 24px auto; max-width:82%; white-space:pre-wrap; }
    .agent-chat .reply { padding:13px 16px; border-radius:12px; background:#222b3c; white-space:pre-wrap; }
    .agent-chat .reply pre { white-space:pre-wrap; overflow-wrap:anywhere; }
    .agent-notice { color:#aabbd6; font-size:12px; }
    h1 { font-size:14px; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .meta { margin-left:auto; color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    button { font:inherit; cursor:pointer; }
    .drawer-toggle { border:0; background:transparent; color:#9cbaf5; padding:7px; }
    .layout { display:flex; flex:1; min-height:0; }
    .chat { flex:1; min-width:0; display:flex; flex-direction:column; }
    .body { flex:1; min-height:0; overflow:auto; padding:36px 24px 48px; display:flex; flex-direction:column; scrollbar-gutter:stable; }
    .block { max-width:760px; width:100%; align-self:center; margin-bottom:28px; box-sizing:border-box; }
    .block.tool, .block.thinking { margin-bottom:4px; }
    .block.tool + .block.assistant, .block.thinking + .block.assistant { margin-top:18px; }
    .user { display:flex; justify-content:flex-end; }
    .bubble { max-width:min(82%,660px); padding:10px 15px; border-radius:17px; background:rgba(122,162,247,.13); white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; line-height:1.55; }
    .bubble img { display:block; max-width:min(100%,240px); max-height:180px; border-radius:9px; margin-top:8px; object-fit:contain; }
    .bubble a { display:block; margin-top:7px; color:#b7c9ed; }
    .speaker { color:var(--chrome-text-dim,#9aa3b8); font-size:12px; font-weight:600; margin-bottom:10px; text-transform:capitalize; }
    .text { color:var(--chrome-text-bright,#d9def0); font-size:14px; line-height:1.68; overflow-wrap:anywhere; }
    .text > :first-child { margin-top:0; }
    .text > :last-child { margin-bottom:0; }
    .text .md-p { margin:0 0 15px; }
    .text .md-h { line-height:1.32; margin:25px 0 11px; font-weight:650; color:var(--chrome-text-bright,#d9def0); }
    .text h1.md-h { font-size:1.45em; }
    .text h2.md-h { font-size:1.25em; }
    .text h3.md-h { font-size:1.12em; }
    .text h4.md-h, .text h5.md-h, .text h6.md-h { font-size:1em; }
    .text strong { color:var(--chrome-text-bright,#d9def0); font-weight:700; }
    .text .md-code { padding:.13em .38em; border:1px solid var(--chrome-border,#41485f); border-radius:5px; background:var(--chrome-bar,#202632); font: .91em/1.4 ui-monospace,monospace; }
    .text .md-pre { box-sizing:border-box; max-width:100%; overflow:auto; margin:0 0 18px; padding:16px 18px; border:1px solid var(--chrome-border,#41485f); border-radius:12px; background:var(--chrome-bar,#202632); }
    .text .md-pre[data-lang]:not([data-lang=""])::before { content:attr(data-lang); display:block; margin:-4px 0 12px; color:var(--chrome-text-dim,#9aa3b8); font:11px/1.4 system-ui,sans-serif; text-transform:uppercase; letter-spacing:.04em; }
    .text .md-pre code { color:inherit; font:12.5px/1.6 ui-monospace,monospace; white-space:pre; }
    .text .md-pre[data-streaming] { border-bottom-color:var(--chrome-accent,#9bb8f7); }
    .text .md-link { color:var(--chrome-accent,#9bb8f7); text-decoration:underline; text-underline-offset:3px; }
    .text .md-ul, .text .md-ol { margin:0 0 16px; padding-left:25px; }
    .text .md-li { margin:5px 0; }
    .text .md-li .md-p { margin:0; }
    .text .md-quote { margin:0 0 16px; padding-left:15px; border-left:2px solid var(--chrome-border,#41485f); color:var(--chrome-text-dim,#9aa3b8); }
    .text .md-hr { margin:24px 0; border:0; border-top:1px solid var(--chrome-border,#41485f); }
    .text .md-tablewrap { max-width:100%; overflow:auto; margin:0 0 18px; }
    .text .md-table { border-collapse:collapse; }
    .text .md-th, .text .md-td { padding:8px 12px; border:1px solid var(--chrome-border,#41485f); text-align:left; }
    .text .md-th { background:var(--chrome-bar,#202632); }
    details.support { color:var(--chrome-text-dim,#b2bdd3); font-size:12px; }
    details.support summary { cursor:pointer; display:flex; align-items:center; gap:8px; min-height:30px; max-width:100%; box-sizing:border-box; list-style:none; }
    details.support summary::-webkit-details-marker { display:none; }
    details.support summary:focus-visible { outline:2px solid #9bb8f7; outline-offset:2px; border-radius:5px; }
    .support .chevron { display:inline-flex; flex:none; opacity:.6; transition:transform .15s ease; }
    .support[open] .chevron { transform:rotate(90deg); }
    .support .kind-icon, .support .state-icon { display:inline-flex; align-items:center; flex:none; }
    .support .summary-name { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .support .summary-hint { margin-left:auto; flex:none; color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    .tool-hint { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    details.support.thinking { max-width:min(100%,650px); }
    details.support.thinking summary { color:#aaa1c4; padding:1px 3px; gap:7px; width:max-content; max-width:100%; }
    .thinking .kind-icon { color:#a99bd0; }
    .thinking .summary-name { font-style:italic; }
    .thinking .summary-hint { color:#88849c; margin-left:0; }
    details.support.tool { border:1px solid var(--chrome-border,#41485f); border-radius:7px; background:rgba(122,162,247,.035); max-width:560px; }
    details.support.tool summary { color:#b7c9ed; padding:2px 9px; }
    .tool .kind-icon { color:#8da6d2; }
    .tool .summary-name { font:600 11px/1.4 ui-monospace,monospace; }
    .tool .summary-hint { display:flex; align-items:center; gap:4px; }
    .tool.completed .summary-hint { color:#9aaac9; }
    .tool.failed { border-color:rgba(230,165,165,.35); }
    .tool.failed .summary-hint { color:#e6a5a5; }
    .tool.running .summary-hint { color:#b7c9ed; }
    .detail { padding:4px 12px 11px; max-width:100%; }
    details.support[open] { width:100%; }
    .thinking .detail { padding:3px 12px 8px 22px; border-left:1px solid #6f648c; margin-left:10px; }
    .detail-label { color:#9cbaf5; font-weight:600; margin:9px 0 4px; }
    .detail pre { margin:0; padding:8px 10px; border-radius:6px; background:rgba(0,0,0,.2); white-space:pre-wrap; overflow-wrap:anywhere; max-height:420px; overflow:auto; color:var(--chrome-text-bright,#d9def0); font:12px/1.5 ui-monospace,monospace; }
    .truncation { padding:6px 10px 0; color:#d7bc8b; font:11px/1.5 ui-monospace,monospace; }
    .error { color:#e6a5a5; }
    .composer-wrap { padding:0 24px 18px; }
    .attachments { display:flex; flex-wrap:wrap; gap:8px; padding:0 0 11px; }
    .attachment { position:relative; display:flex; align-items:center; gap:9px; min-width:0; max-width:min(100%,230px); padding:5px 28px 5px 5px; border:1px solid var(--chrome-border,#41485f); border-radius:10px; background:var(--chrome-bar,#202632); }
    .attachment img { flex:none; width:52px; height:52px; object-fit:cover; border-radius:6px; background:rgba(255,255,255,.05); }
    .attachment .filename { min-width:0; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
    .attachment .status { color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    .attachment .status.failed { color:#f0aaa8; }
    .attachment button { position:absolute; top:4px; right:4px; width:22px; height:22px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--chrome-text-dim,#9aa3b8); font-size:18px; line-height:20px; }
    .attachment button:hover { background:rgba(255,255,255,.1); color:inherit; }
    .attach-button { flex:none; width:34px; height:34px; display:grid; place-items:center; border:0; border-radius:9px; padding:0; background:transparent; color:var(--chrome-text-bright,#d9def0); }
    .attach-button svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
    .attach-button:hover, .attach-button:focus-visible { background:var(--chrome-bar,#202632); outline:none; }
    .file-input { display:none; }
    .drop-overlay { position:absolute; inset:8px; z-index:10; display:grid; place-items:center; border:2px dashed #9bb8f7; border-radius:16px; background:rgba(25,35,60,.92); color:#d9e5ff; font-size:22px; pointer-events:none; }
    .composer { box-sizing:border-box; max-width:760px; margin:auto; border:1px solid var(--chrome-border,#41485f); border-radius:18px; background:var(--chrome-bar,#202632); padding:13px 14px 9px; box-shadow:0 8px 28px rgba(0,0,0,.08); transition:border-color .15s,box-shadow .15s; }
    .composer:focus-within { border-color:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 58%,var(--chrome-border,#41485f)); box-shadow:0 0 0 2px color-mix(in srgb,var(--chrome-accent,#9bb8f7) 14%,transparent); }
    .composer-row { display:flex; }
    .composer-controls { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-top:7px; min-height:34px; }
    .composer-controls .send, .composer-controls .stop { margin-left:auto; }
    textarea { display:block; flex:1; min-width:0; resize:none; border:0; outline:none; background:transparent; color:inherit; font:14px/1.55 system-ui,sans-serif; min-height:34px; height:34px; max-height:220px; padding:3px 0; box-sizing:border-box; overflow-y:auto; }
    textarea::placeholder { color:var(--chrome-text-dim,#9aa3b8); opacity:.8; }
    .send, .stop { flex:none; width:34px; height:34px; display:grid; place-items:center; border-radius:10px; }
    .send { border:0; background:var(--chrome-accent,#9bb8f7); color:#152032; font-size:20px; line-height:1; }
    .send:hover:not(:disabled) { filter:brightness(1.1); }
    .send:disabled { opacity:.38; cursor:default; }
    .stop { border:1px solid #bd7280; background:#8c3d4e; color:white; font-size:15px; }
    .stop:hover:not(:disabled) { background:#a34c5d; }
    .stop:disabled { opacity:.6; }
    .steer { margin-left:auto; border:1px solid var(--chrome-border,#41485f); border-radius:9px; background:transparent; color:var(--chrome-text-bright,#d9def0); padding:6px 10px; }
    .steer + .stop { margin-left:0; }
    .composer button:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .status { color:#e6bd8d; font-size:12px; }
    .drawer { position:relative; flex:none; width:var(--utility-width); min-width:0; border-left:1px solid var(--chrome-border,#343a4c); background:var(--chrome-bar,#202632); animation:drawer-in .16s ease-out; }
    .drawer-resizer { position:absolute; z-index:2; left:-5px; top:0; bottom:0; width:10px; cursor:col-resize; touch-action:none; }
    .drawer-resizer:hover, .drawer-resizer:focus-visible { background:rgba(155,184,247,.25); outline:none; }
    @keyframes drawer-in { from { transform:translateX(18px); opacity:.55; } to { transform:translateX(0); opacity:1; } }
    @media(max-width:700px) { .body { padding:24px 16px 32px; } .composer-wrap { padding:0 12px 12px; } .drawer { position:absolute; right:0; top:44px; bottom:0; box-shadow:-10px 0 30px #0008; } }
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
  override updated(changed: Map<string, unknown>) {
    if (changed.has('draft')) this.sizeTextarea();
  }
  private sizeTextarea() {
    const textarea = this.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) return;
    textarea.style.height = '34px';
    textarea.style.height = `${Math.min(220, Math.max(34, textarea.scrollHeight))}px`;
  }
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
    this.stream?.close(); this.blocks = []; this.trajectory = []; this.selectedAgent = ''; this.parsers.clear(); this.expanded.clear(); this.nextBlockKey = 0; this.turnStart = 0; this.completedInputAnchors.clear(); this.error = ''; this.settingsPending = false; this.chat = sdkChats.chats.find(c => c.id === this.sessionId);
    const source = new EventSource(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/events`));
    source.addEventListener('snapshot', e => { this.chat = JSON.parse((e as MessageEvent).data) as SDKChat; this.busy = this.chat.state === 'working'; });
    source.addEventListener('sdk', e => this.onEvent(JSON.parse((e as MessageEvent).data) as SDKEvent));
    source.onerror = () => { this.error = 'Connection to the chat stream was interrupted.'; };
    this.stream = source;
  }
  private onEvent(event: SDKEvent) {
    if (['input.accepted', 'assistant.delta', 'thinking.delta', 'tool.started', 'tool.completed', 'delegate.spawned', 'delegate.completed', 'delegate.message', 'turn.completed', 'turn.cancelled', 'turn.continued', 'error'].includes(event.type))
      this.trajectory = [...this.trajectory, event];
    const blocks = [...this.blocks];
    if (event.type === 'input.accepted') {
      if (event.kind === 'steer') {
        const last = blocks[blocks.length - 1];
        if (last?.kind === 'assistant') blocks[blocks.length - 1] = { ...last, done:true };
        blocks.push({ key:++this.nextBlockKey, kind:'user', text:event.text || '' });
      } else {
        // The harness can stream a fast reply before its send receipt arrives.
        const anchor = event.inputId ? this.completedInputAnchors.get(event.inputId) : undefined;
        let at = anchor === undefined ? this.turnStart : blocks.findIndex(b => b.key === anchor);
        if (at < 0) at = this.turnStart;
        while (blocks[at]?.kind === 'user') at++;
        blocks.splice(at, 0, { key:++this.nextBlockKey, kind:'user', text:event.text || '', attachments:event.attachments || [] });
        if (at < this.turnStart) this.turnStart++;
      }
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
    else if (event.type === 'session.renamed') { void sdkChats.refresh(); }
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
      const item: Attachment = { localId: crypto.randomUUID(), file, preview:file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined, uploading: true };
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
      if (payload.kind !== 'image' && item.preview) URL.revokeObjectURL(item.preview);
      this.attachments = this.attachments.map(a => a.localId === item.localId
        ? { ...a, id: payload.id, kind: payload.kind, preview:payload.kind === 'image' ? item.preview : undefined, uploading: false } : a);
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
    if (result.status === 'failed' || result.is_error === true || result.isError === true || result.error) return true;
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) return true;
    const output = result.output;
    return !!output && typeof output === 'object' && typeof (output as Record<string, unknown>).returncode === 'number'
      && (output as Record<string, unknown>).returncode !== 0;
  }
  private agents(): AgentView[] {
    const delegates = this.trajectory.filter(event => event.type === 'delegate.spawned');
    const byId = new Map<string, AgentView>();
    const add = (id: string, name: string, parentId: string) => {
      let agent = byId.get(id);
      if (!agent) { agent = { id, name, parentId, status:'Running', progress:'', legs:[] }; byId.set(id, agent); }
      if (name && name !== 'Agent') agent.name = name;
      return agent;
    };
    for (const block of this.blocks.filter(block => block.kind === 'tool' && /^(delegate|Agent|Task|subAgentActivity)$/i.test(block.name || ''))) {
      const input = this.toolInput(block.input);
      const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      if (block.name === 'subAgentActivity' && fields.kind !== 'started') continue;
      const spawned = delegates.find(event => event.toolId === block.id);
      const output = this.toolOutput(block.output);
      const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
      const body = result.output && typeof result.output === 'object' ? result.output as Record<string, unknown> : result;
      const id = spawned?.childSessionId || (typeof body.session_id === 'string' ? body.session_id : '') || (typeof fields.agentThreadId === 'string' ? fields.agentThreadId : '') || block.id || String(block.key);
      const name = (typeof fields.agent === 'string' ? fields.agent : '') || (typeof fields.subagent_type === 'string' ? fields.subagent_type : '') || spawned?.agent || (typeof fields.agentPath === 'string' ? fields.agentPath : '') || block.name || 'Agent';
      const task = fields.instruction || fields.prompt || fields.description || fields.task || fields.message || fields.agentPath;
      const reply = body.response || body.output || output;
      const agent = add(id, name, spawned?.parentSessionId || this.sessionId);
      const status = block.done ? this.toolFailed(block) ? 'Failed' : 'Completed' : 'Running';
      agent.legs.push({ task:typeof task === 'string' ? task : this.detail(input), reply:block.done && block.name !== 'subAgentActivity' ? this.detail(reply) : '', status });
      agent.status = status;
    }
    for (const event of delegates) if (event.childSessionId) add(event.childSessionId, event.agent || 'Agent', event.parentSessionId || this.sessionId);
    for (const event of this.trajectory) if (event.childSessionId) {
      const agent = byId.get(event.childSessionId);
      if (!agent) continue;
      if (event.type === 'delegate.message') agent.progress = event.complete ? event.text || '' : agent.progress + (event.text || '');
      if (event.type === 'delegate.completed') agent.status = event.failed ? 'Failed' : 'Completed';
    }
    return [...byId.values()];
  }
  private async steerAgent() {
    const agent = this.agents().find(item => item.id === this.selectedAgent);
    const message = this.agentDraft.trim();
    if (!agent || !message) return;
    const content = `Please steer delegated agent ${agent.name} (${agent.id}) with this instruction: ${message}`;
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}`), { method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ kind:this.busy ? 'steer' : 'user', source:'browser', id:crypto.randomUUID(), content }) });
      if (!response.ok) throw new Error(await response.text());
      this.agentDraft = '';
      this.agentNotice = 'Steering request sent to the root session.';
    } catch (error) { this.agentNotice = String(error); }
  }
  private support(block: Block) {
    const thinking = block.kind === 'thinking';
    const input = this.toolInput(block.input);
    const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const hint = fields.command || fields.file_path || fields.path || fields.url;

    const failed = !thinking && this.toolFailed(block);
    const output = block.done ? this.detail(this.toolOutput(block.output)) : 'Running…';
    const truncated = output.match(/\n(… truncated after [^\n]+)$/);
    const state = failed ? 'Failed' : block.done ? 'Completed' : 'Running';
    return html`<details class="support ${thinking ? 'thinking' : `tool ${failed ? 'failed' : block.done ? 'completed' : 'running'}`}" ?open=${this.expanded.has(block.key)} @toggle=${(e: globalThis.Event) => {
      if ((e.currentTarget as HTMLDetailsElement).open) this.expanded.add(block.key); else this.expanded.delete(block.key);
    }}><summary><span class="chevron" aria-hidden="true">${icon(ChevronRight, { size: 12 })}</span><span class="kind-icon" aria-hidden="true">${icon(thinking ? Brain : Terminal, { size: 13 })}</span><span class="summary-name">${thinking ? 'Thinking' : block.name || 'Tool'}</span>${!thinking && typeof hint === 'string' ? html`<span class="tool-hint" title=${hint}>${hint}</span>` : nothing}<span class="summary-hint">${thinking ? `${block.text.length} characters` : html`<span class="state-icon" aria-hidden="true">${icon(failed ? CircleX : block.done ? Check : LoaderCircle, { size: 12 })}</span>${state}`}</span></summary><div class="detail">${thinking
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
    <div class="topbar">${this.selectedAgent ? html`<nav class="breadcrumbs" aria-label="Agent lineage"><button @click=${() => { this.selectedAgent=''; this.agentNotice=''; }}>${this.chat?.title || 'Root session'}</button><span>›</span><strong>${this.agents().find(agent => agent.id === this.selectedAgent)?.name || 'Agent'}</strong></nav>` : html`<h1 title=${this.chat?.title || 'Chat'}>${this.chat?.title || 'Chat'}</h1>`}<span class="meta">${this.chat?.harness || ''} · ${sdkChats.projects.find(project => project.id === this.chat?.workspaceId)?.name || 'Ungrouped'}</span><button class="drawer-toggle" aria-label=${this.drawerOpen ? 'Close right drawer' : 'Open right drawer'} aria-expanded=${this.drawerOpen} @click=${this.openDrawer}>▥</button></div>
    <div class="layout" @dragenter=${this.onDragEnter} @dragover=${this.onDragOver} @dragleave=${this.onDragLeave} @drop=${this.onDrop}><div class="chat"><div class="body">
      ${this.selectedAgent ? (() => { const agent=this.agents().find(item => item.id === this.selectedAgent); return agent ? html`<div class="agent-chat"><div class="speaker">${agent.name} · ${agent.status}</div>${agent.legs.map(leg => html`<div class="instruction">${leg.task}</div><div class="reply">${leg.reply || agent.progress || 'The delegated agent is working. Its result returns through the root session.'}</div>`)}${!agent.legs.length ? html`<div class="reply">${agent.progress || 'The native harness reported this agent. Its result returns through the root session.'}</div>` : nothing}</div>` : html`<div class="block">Agent unavailable in this session.</div>`; })() : html`${this.agents().length ? html`<section class="agent-list" aria-label="Delegated sub-agents"><h2>Delegated sub-agents</h2>${this.agents().map(agent => html`<button class="agent-link" @click=${() => { this.selectedAgent=agent.id; this.agentNotice=''; }}><span>↳</span><span>${agent.name}</span><span>${agent.status}</span></button>`)}</section>` : nothing}${this.blocks.length ? this.blocks.map(b => html`<div class="block ${b.kind}">${b.kind === 'user' ? this.userBubble(b) : b.kind === 'assistant' ? html`<div class="speaker">${this.chat?.harness}</div><div class="text">${this.markdown(b, b.key)}</div>` : b.kind === 'tool' || b.kind === 'thinking' ? this.support(b) : html`<div class="${b.kind}">${b.text}</div>`}</div>`) : html`<div class="block">Starting the SDK session…</div>`}`}
      ${this.error ? html`<div class="block error" role="alert">${this.error}</div>` : nothing}
    </div><div class="composer-wrap"><div class="composer" @paste=${this.onPaste}>
      ${this.selectedAgent ? html`<div class="composer-row"><textarea aria-label="Steer delegated agent through root" placeholder="Ask the root to steer this agent…" .value=${this.agentDraft} @input=${(e: InputEvent) => { this.agentDraft=(e.target as HTMLTextAreaElement).value; }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.steerAgent(); } }}></textarea></div><div class="composer-controls"><span class="agent-notice">${this.agentNotice}</span>${this.busy ? html`<button class="stop" aria-label="Stop root turn and delegated agent" title="Stop root turn and delegated agent" ?disabled=${this.stopping} @click=${() => void this.stop()}>■</button>` : nothing}<button class="steer" @click=${() => void this.steerAgent()} ?disabled=${!this.agentDraft.trim()}>Send to root ↗</button></div>` : html`
      ${this.attachments.length ? html`<div class="attachments" aria-label="Attached files">${this.attachments.map(a => html`<div class="attachment">
        ${a.preview ? html`<img src=${a.preview} alt=${a.file.name}>` : nothing}
        <span class="filename" title=${a.file.name}>${a.file.name}</span>
        <span class="status ${a.error ? 'failed' : ''}" role=${a.error ? 'alert' : 'status'}>${a.error || (a.uploading ? 'Uploading…' : '')}</span>
        <button aria-label=${`Remove ${a.file.name}`} @click=${() => this.removeAttachment(a.localId)}>×</button>
      </div>`)}</div>` : nothing}
      <div class="composer-row"><textarea aria-label=${this.busy ? 'Steer running turn' : 'Message'} placeholder=${this.busy ? 'Steer this turn…' : `Message ${this.chat?.harness || 'agent'}…`} .value=${this.draft} @input=${(e: InputEvent) => { this.draft = (e.target as HTMLTextAreaElement).value; }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea></div>
      <div class="composer-controls"><input class="file-input" type="file" multiple @change=${this.onPick} aria-label="Choose files to attach"><button class="attach-button" aria-label="Attach files or images" title="Attach files or images" @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>('.file-input')?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg></button><mux-sdk-chat-settings .sessionId=${this.sessionId} .harness=${this.chat?.harness || ''} .turnBusy=${this.busy} @settings-pending=${(e: CustomEvent<boolean>) => { this.settingsPending = e.detail; }}></mux-sdk-chat-settings>${this.busy ? html`${this.draft.trim() ? html`<button class="steer" aria-label="Steer running turn" ?disabled=${this.stopping || this.attachments.length > 0} @click=${() => void this.send()}>Steer ↗</button>` : nothing}<button class="stop" aria-label="Stop current turn" title="Stop current turn" ?disabled=${this.stopping} @click=${() => void this.stop()}>■</button>` : html`<button class="send" aria-label="Send message" ?disabled=${(!this.draft.trim() && !this.attachments.length) || this.settingsPending || this.attachments.some(a => a.uploading || !!a.error)} @click=${() => void this.send()}>↑</button>`}</div>`}


    </div></div></div>
      ${this.drawerOpen ? html`<aside class="drawer" aria-label="Right drawer" style=${`--utility-width:${this.drawerWidth}px`}><div class="drawer-resizer" role="separator" aria-label="Resize right drawer" aria-orientation="vertical" tabindex="0" @pointerdown=${this.startDrawerResize} @pointermove=${this.moveDrawerResize} @pointerup=${this.endDrawerResize} @lostpointercapture=${this.endDrawerResize} @keydown=${(e: KeyboardEvent) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const {min,max}=this.widthLimits(); this.drawerWidth=Math.round(Math.max(min,Math.min(max,this.drawerWidth+(e.key === 'ArrowLeft' ? 20 : -20)))); try { localStorage.setItem(this.drawerKey(),String(this.drawerWidth)); } catch { /* private browsing */ } e.preventDefault(); } }}></div><mux-sdk-utility .sessionId=${this.sessionId} .projectPath=${this.chat?.projectPath || ''} .harness=${this.chat?.harness || ''} .tasks=${this.planTasks()} .touched=${this.touchedFiles()} .events=${this.trajectory}></mux-sdk-utility></aside>` : nothing}
    </div>${this.dropActive ? html`<div class="drop-overlay" role="status">Drop files to attach</div>` : nothing}`; }
}
