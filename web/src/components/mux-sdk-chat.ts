import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';
import { apiPath } from '../lib/base-path.js';

type Event = { type: string; text?: string; name?: string; toolId?: string; message?: string; kind?: string; raw?: unknown };
type Block = { kind: 'user' | 'assistant' | 'tool' | 'error'; text: string; name?: string; id?: string; done?: boolean };
@customElement('mux-sdk-chat')
export class MuxSDKChat extends LitElement {
  @property() sessionId = '';
  @state() private chat?: SDKChat;
  @state() private blocks: Block[] = [];
  @state() private draft = '';
  @state() private error = '';
  @state() private busy = false;
  @state() private drawerOpen = false;
  private stream?: EventSource;
  private parsers = new Map<number, MarkdownStream>();
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
    .tool { border-left:2px solid #7384a5; padding:5px 12px; color:var(--chrome-text-dim,#b2bdd3); font:12px ui-monospace,monospace; }
    .block.tool > .tool { border-left-color:transparent; }
    .tool-name { color:#b7c9ed; }
    .error { color:#e6a5a5; }
    .composer-wrap { padding:0 clamp(24px,8vw,120px) 18px; }
    .composer { max-width:780px; margin:auto; display:flex; align-items:flex-end; gap:10px; border:1px solid var(--chrome-border,#41485f); border-radius:16px; background:rgba(0,0,0,.15); padding:11px 12px; }
    textarea { flex:1; min-width:0; resize:none; border:0; outline:none; background:transparent; color:inherit; font:inherit; height:46px; }
    .send { width:31px; height:31px; border-radius:50%; border:0; background:#9bb8f7; color:#152032; font-size:18px; }
    .send:disabled { opacity:.38; }
    .drawer { width:min(32vw,420px); min-width:220px; border-left:1px solid var(--chrome-border,#343a4c); background:var(--chrome-bar,#202632); }
    @media(max-width:700px) { .drawer { position:absolute; right:0; top:44px; bottom:0; width:min(80vw,420px); box-shadow:-10px 0 30px #0008; } }
  `;
  override connectedCallback() { super.connectedCallback(); this.connect(); }
  override disconnectedCallback() { this.stream?.close(); super.disconnectedCallback(); }
  override willUpdate(changed: Map<string, unknown>) { if (changed.has('sessionId')) this.connect(); }
  private connect() {
    if (!this.isConnected || !this.sessionId) return;
    this.stream?.close(); this.blocks = []; this.parsers.clear(); this.error = ''; this.chat = sdkChats.chats.find(c => c.id === this.sessionId);
    const source = new EventSource(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/events`));
    source.addEventListener('snapshot', e => { this.chat = JSON.parse((e as MessageEvent).data) as SDKChat; });
    source.addEventListener('sdk', e => this.onEvent(JSON.parse((e as MessageEvent).data) as Event));
    source.onerror = () => { this.error = 'Connection to the chat stream was interrupted.'; };
    this.stream = source;
  }
  private onEvent(event: Event) {
    const blocks = [...this.blocks];
    if (event.type === 'input.accepted') { blocks.push({ kind:'user', text:event.text || '' }); this.busy = true; }
    else if (event.type === 'assistant.delta') {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'assistant' && !last.done) blocks[blocks.length - 1] = { ...last, text:last.text + (event.text || '') };
      else blocks.push({ kind:'assistant', text:event.text || '' });
    } else if (event.type === 'tool.started') blocks.push({ kind:'tool', text:'Running', name:event.name || 'Tool', id:event.toolId });
    else if (event.type === 'tool.completed') {
      let index = -1; for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'tool' && blocks[i].id === event.toolId && !blocks[i].done) { index = i; break; }
      if (index >= 0) blocks[index] = { ...blocks[index], done:true, text:'Completed' };
      else blocks.push({ kind:'tool', text:'Completed', name:event.name || 'Tool', id:event.toolId, done:true });
    } else if (event.type === 'turn.completed') { this.busy = false; for (const b of blocks) if (b.kind === 'assistant') b.done = true; void sdkChats.refresh(); }
    else if (event.type === 'error' || event.type === 'session.uncertain') { blocks.push({ kind:'error', text:event.message || 'Session error' }); this.busy = false; void sdkChats.refresh(); }
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
  private async send() {
    const content = this.draft.trim(); if (!content || this.busy) return;
    this.draft = '';
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}`), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ kind:'user', source:'browser', id:crypto.randomUUID(), content }) });
      if (!response.ok) throw new Error(await response.text());
    } catch (error) { this.error = String(error); this.draft = content; }
  }
  override render() { return html`
    <div class="topbar"><h1 title=${this.chat?.title || 'Chat'}>${this.chat?.title || 'Chat'}</h1><span class="meta">${this.chat?.harness || ''} · ${this.chat?.projectPath || ''}</span><button class="drawer-toggle" aria-label=${this.drawerOpen ? 'Close right drawer' : 'Open right drawer'} aria-expanded=${this.drawerOpen} @click=${() => { this.drawerOpen = !this.drawerOpen; }}>▥</button></div>
    <div class="layout"><div class="chat"><div class="body">
      ${this.blocks.length ? this.blocks.map((b, i) => html`<div class="block ${b.kind}">${b.kind === 'user' ? html`<div class="bubble">${b.text}</div>` : b.kind === 'assistant' ? html`<div class="speaker">${this.chat?.harness}</div><div class="text">${this.markdown(b, i)}</div>` : b.kind === 'tool' ? html`<div class="tool"><span class="tool-name">${b.name}</span> · ${b.text}</div>` : html`<div class="error">${b.text}</div>`}</div>`) : html`<div class="block">Starting the SDK session…</div>`}
      ${this.error ? html`<div class="block error" role="alert">${this.error}</div>` : nothing}
    </div><div class="composer-wrap"><div class="composer"><textarea placeholder="Message ${this.chat?.harness || 'agent'}…" .value=${this.draft} @input=${(e: InputEvent) => { this.draft = (e.target as HTMLTextAreaElement).value; }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea><button class="send" aria-label="Send message" ?disabled=${!this.draft.trim() || this.busy} @click=${() => void this.send()}>↑</button></div></div></div>
      ${this.drawerOpen ? html`<aside class="drawer" aria-label="Right drawer" data-dockview-host-seam></aside>` : nothing}
    </div>`; }
}
