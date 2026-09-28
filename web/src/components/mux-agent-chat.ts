import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import { sdkChatStore, type SDKChatEvent } from '../lib/sdk-chat-store.js';

// The same transcript rhythm, markdown renderer and composer language as
// Operator. Its right edge is an empty mount seam for a later dockview host.
@customElement('mux-agent-chat')
export class MuxAgentChat extends LitElement {
  @property() sessionId = '';
  @state() private events: SDKChatEvent[] = [];
  @state() private draft = '';
  @state() private error = '';
  @state() private drawerOpen = false;
  private stream: EventSource | null = null;
  private parser = new MarkdownStream();
  private opened = '';

  static styles = css`
    :host { position:absolute; inset:0; z-index:4; display:flex; background:var(--chrome-bg,#1a1c28); color:var(--chrome-text-bright,#d9def0); font:13px/1.55 system-ui,sans-serif; }
    .chat { min-width:0; flex:1; display:flex; flex-direction:column; }
    .topbar { min-height:var(--mux-titlebar-height,44px); box-sizing:border-box; display:flex; align-items:center; gap:12px; padding:0 22px; border-bottom:1px solid var(--chrome-border,#343a4c); }
    h1 { font-size:14px; font-weight:650; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .meta { margin-left:auto; color:var(--chrome-text-dim,#8e95aa); font-size:11px; white-space:nowrap; }
    .drawer-toggle { border:0; background:transparent; color:#9cbaf5; padding:7px; cursor:pointer; font:inherit; }
    .body { flex:1; min-height:0; overflow:auto; padding:32px clamp(24px,8vw,120px) 55px; display:flex; flex-direction:column; gap:24px; }
    .turn { max-width:780px; width:100%; align-self:center; }
    .turn.user { display:flex; justify-content:flex-end; }
    .bubble { max-width:min(82%,660px); padding:10px 14px; border-radius:15px; background:rgba(122,162,247,.14); white-space:pre-wrap; overflow-wrap:anywhere; }
    .speaker { color:var(--chrome-text-dim,#9aa3b8); font-size:11px; margin-bottom:7px; }
    .text { overflow-wrap:anywhere; }
    .text :is(p,pre) { margin:0 0 10px; }
    .tool { padding:10px 13px; border:1px solid var(--chrome-border,#343a4c); border-radius:9px; color:var(--chrome-text-dim,#aeb7ca); background:rgba(255,255,255,.03); font:12px/1.4 ui-monospace,monospace; }
    .tool strong { color:var(--chrome-text-bright,#d9def0); }
    .note { align-self:center; max-width:780px; width:100%; color:var(--chrome-text-dim,#9aa3b8); font-size:12px; }
    .composer-wrap { padding:0 clamp(24px,8vw,120px) 18px; }
    .composer { max-width:780px; margin:auto; display:flex; align-items:flex-end; gap:10px; border:1px solid var(--chrome-border,#41485f); border-radius:16px; background:rgba(0,0,0,.15); padding:11px 12px; }
    textarea { flex:1; min-width:0; resize:none; border:0; outline:none; background:transparent; color:inherit; font:inherit; line-height:1.45; height:46px; }
    .send { width:31px; height:31px; flex:none; border-radius:50%; border:0; background:#9bb8f7; color:#152032; cursor:pointer; font-size:18px; }
    .send:disabled { opacity:.38; cursor:default; }
    .drawer { width:clamp(240px,28vw,420px); flex:none; border-left:1px solid var(--chrome-border,#343a4c); background:var(--chrome-bar,#202632); }
    @media (max-width:850px) { .drawer { position:absolute; inset:44px 0 0 auto; width:min(80vw,420px); box-shadow:-16px 0 35px #0007; } }
  `;
  override connectedCallback() { super.connectedCallback(); void this.open(); }
  override disconnectedCallback() { this.stream?.close(); this.stream=null; super.disconnectedCallback(); }
  override willUpdate(changed: Map<string,unknown>) { if (changed.has('sessionId') && this.opened !== this.sessionId) void this.open(); }
  private async open() {
    if (!this.isConnected || !this.sessionId || this.opened===this.sessionId) return;
    this.opened=this.sessionId; this.stream?.close(); this.events=[]; this.error=''; this.parser=new MarkdownStream();
    try {
      const response=await fetch(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}`);
      const data=await response.json() as {events?:SDKChatEvent[];error?:string};
      if (!response.ok) throw new Error(data.error || `SDK chat: ${response.status}`);
      if (this.opened!==this.sessionId) return;
      this.events=data.events||[];
      const after=this.events[this.events.length-1]?.seq||0;
      this.stream=new EventSource(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/events?after=${after}`);
      this.stream.onmessage=(message) => {
        const event=JSON.parse(message.data) as SDKChatEvent;
        if (event.seq <= (this.events[this.events.length-1]?.seq||0)) return;
        this.events=[...this.events,event];
        if(event.type==='input.accepted') sdkChatStore.mark(this.sessionId,'working');
        if(event.type==='turn.completed') sdkChatStore.mark(this.sessionId,'ready');
        if(event.type==='error') sdkChatStore.mark(this.sessionId,event.message?.includes('uncertain')?'uncertain':'error');
        if (event.type==='error') this.error=event.message||'The SDK turn failed';
        const body=this.shadowRoot?.querySelector<HTMLElement>('.body');
        const follow=!body || body.scrollHeight-body.scrollTop-body.clientHeight<120;
        if (follow) void this.updateComplete.then(() => {const current=this.shadowRoot?.querySelector<HTMLElement>('.body');if(current)current.scrollTop=current.scrollHeight;});
      };
    } catch (error) { this.error=String(error); }
  }
  private async send() {
    const content=this.draft.trim();if (!content) return;
    this.draft='';this.error='';
    try {
      const response=await fetch(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/send`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'user',content})});
      if (!response.ok) {const data=await response.json() as {error?:string};throw new Error(data.error||`Send failed: ${response.status}`);}
    } catch (error) {this.draft=content;this.error=String(error);}
  }
  private renderEvents() {
    const rows: Array<{kind:'user'|'assistant'|'tool'|'note'; text:string; state?:string; id?:string; output?:string}> = [];
    for (const event of this.events) {
      if (event.type==='input.accepted' && event.kind==='user') rows.push({kind:'user',text:event.text||''});
      else if (event.type==='assistant.delta') {
        const last=rows[rows.length-1];if(last?.kind==='assistant')last.text+=event.text||'';else rows.push({kind:'assistant',text:event.text||''});
      } else if (event.type==='tool.started') rows.push({kind:'tool',text:event.detail?.command||event.tool||'Tool call',state:'running',id:event.tool_id||event.detail?.id});
      else if (event.type==='tool.completed') {
        const id=event.tool_id||event.detail?.id;
        const row=rows.find(candidate=>candidate.kind==='tool'&&candidate.id===id);
        if(row){row.state='completed';row.output=event.detail?.aggregated_output?.trim();}
        else rows.push({kind:'tool',text:event.detail?.command||event.tool||'Tool call',state:'completed',id,output:event.detail?.aggregated_output?.trim()});
      }
      else if (event.type==='error') rows.push({kind:'note',text:event.message||'SDK error'});
    }
    return rows.map(row => {
      if (row.kind==='user') return html`<div class="turn user"><div class="bubble">${row.text}</div></div>`;
      if (row.kind==='tool') return html`<div class="turn tool"><strong>${row.text}</strong> · ${row.state}${row.output?html`<div>${row.output}</div>`:nothing}</div>`;
      if (row.kind==='note') return html`<div class="note">${row.text}</div>`;
      this.parser=new MarkdownStream();return html`<div class="turn assistant"><div class="speaker">${this.session()?.harness||'Assistant'}</div><div class="text">${renderSegments(this.parser.update(row.text,false))}</div></div>`;
    });
  }
  private session() {return sdkChatStore.sessions.find(s=>s.id===this.sessionId);}
  override render() {
    const session=this.session();
    return html`<div class="chat">
      <div class="topbar"><h1 title=${session?.title||'Chat'}>${session?.title||'Chat'}</h1><span class="meta">${session?.harness||''} · ${session?.projectPath||''}</span><button class="drawer-toggle" aria-label="Toggle right drawer" aria-expanded=${this.drawerOpen} @click=${()=>this.drawerOpen=!this.drawerOpen}>${this.drawerOpen?'Hide drawer':'Show drawer'}</button></div>
      <div class="body">${this.renderEvents()}${this.events.length===0&&!this.error?html`<div class="note">Starting SDK session…</div>`:nothing}${this.error?html`<div class="note">${this.error}</div>`:nothing}</div>
      <div class="composer-wrap"><div class="composer"><textarea placeholder="Message ${session?.harness||'assistant'}…" .value=${this.draft} @input=${(e:Event)=>this.draft=(e.target as HTMLTextAreaElement).value} @keydown=${(e:KeyboardEvent)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void this.send();}}}></textarea><button class="send" aria-label="Send message" ?disabled=${!this.draft.trim()} @click=${()=>void this.send()}>↑</button></div></div>
    </div>${this.drawerOpen?html`<aside class="drawer" aria-label="Right drawer"></aside>`:nothing}`;
  }
}
