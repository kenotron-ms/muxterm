import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ArrowLeft, Plus, Send } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { rememberChatHost, remoteChatPath } from '../lib/remote-chat-routes.js';
import { icon } from '../lib/icons.js';
import type { SDKChat } from '../lib/sdk-chats.js';
import './mux-sdk-chat.js';
import '../ui/button.js';
import '../ui/feedback.js';
import '../ui/text-area.js';
import '../ui/rail-row.js';
import type { MuxUITextArea } from '../ui/text-area.js';

@customElement('mux-side-chat')
export class MuxSideChat extends LitElement {
  @property() sessionId = '';
  @property() remoteHost = '';
  @state() private chats: SDKChat[] = [];
  @state() private selectedId = '';
  @state() private question = '';
  @state() private loading = false;
  @state() private sending = false;
  @state() private error = '';

  static styles = css`
    :host { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-sm)/1.5 var(--ui-font-sans); }
    .header { display:flex; align-items:center; gap:var(--ui-space-2); flex:none; min-height:var(--ui-control-lg); padding:var(--ui-space-2) var(--ui-space-4); border-bottom:1px solid var(--ui-border); }
    .header strong { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .conversation { position:relative; flex:1; min-height:0; }
    .start { box-sizing:border-box; flex:1; min-height:0; overflow:auto; padding:var(--ui-space-7) var(--ui-space-5); }
    .intro { max-width:var(--ui-side-chat-start-width); margin:0 auto var(--ui-space-7); }
    .intro h2 { margin:0 0 var(--ui-space-2); font:600 var(--ui-text-lg)/1.35 var(--ui-font-sans); }
    .intro p { margin:0; color:var(--ui-text-muted); }
    form { display:flex; flex-direction:column; gap:var(--ui-space-3); max-width:var(--ui-side-chat-start-width); margin:auto; }
    mux-ui-text-area { width:100%; }
    .form-actions { display:flex; justify-content:flex-end; }
    .recent { max-width:var(--ui-side-chat-start-width); margin:var(--ui-space-9) auto 0; }
    .recent h3 { margin:0 0 var(--ui-space-3); color:var(--ui-text-muted); font:600 var(--ui-text-xs)/1.4 var(--ui-font-sans); text-transform:uppercase; letter-spacing:.08em; }
    .recent-list { display:flex; flex-direction:column; gap:var(--ui-space-1); }
    .recent-list mux-ui-rail-row { width:100%; }
    mux-ui-feedback { display:block; max-width:var(--ui-side-chat-start-width); margin:var(--ui-space-4) auto; }
  `;

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) void this.loadChats();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('sessionId') && this.sessionId) void this.loadChats();
  }

  prepareQuestion(prompt = '') {
    this.selectedId = '';
    this.question = prompt;
    void this.updateComplete.then(() => this.renderRoot.querySelector<MuxUITextArea>('mux-ui-text-area')?.focus());
  }

  private async loadChats() {
    const parent = this.sessionId;
    if (!parent) return;
    this.loading = true;
    try {
      const path = remoteChatPath(this.remoteHost, `/api/sdk-chats?sideParentId=${encodeURIComponent(parent)}`);
      const response = await fetch(apiPath(path));
      if (!response.ok) throw new Error(await response.text());
      const chats = await response.json() as SDKChat[];
      if (this.sessionId !== parent) return;
      for (const chat of chats) rememberChatHost(chat.id, this.remoteHost);
      this.chats = chats.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
      this.error = '';
    } catch (error) {
      if (this.sessionId === parent) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.sessionId === parent) this.loading = false;
    }
  }

  private async ask() {
    const prompt = this.question.trim();
    if (!prompt || this.sending) return;
    const parent = this.sessionId;
    this.sending = true;
    this.error = '';
    try {
      const response = await fetch(apiPath(remoteChatPath(this.remoteHost, '/api/sdk-chats')), {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({sideParentId:parent, prompt}),
      });
      if (!response.ok) throw new Error(await response.text());
      const chat = await response.json() as SDKChat;
      if (this.sessionId !== parent) return;
      rememberChatHost(chat.id, this.remoteHost);
      this.chats = [chat, ...this.chats];
      this.selectedId = chat.id;
      this.question = '';
    } catch (error) {
      if (this.sessionId === parent) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.sessionId === parent) this.sending = false;
    }
  }

  override render() {
    const selected = this.chats.find(chat => chat.id === this.selectedId);
    return html`<div class="header">
      ${selected ? html`<mux-ui-button icon-only size="small" variant="quiet" accessible-label="Back to side chats" tooltip="Back to side chats" @click=${() => { this.selectedId = ''; void this.loadChats(); }}>${icon(ArrowLeft,{size:16})}</mux-ui-button>` : nothing}
      <strong>${selected?.title || 'Side chat'}</strong>
      ${selected ? html`<mux-ui-button icon-only size="small" variant="quiet" accessible-label="New side chat" tooltip="New side chat" @click=${() => { this.selectedId = ''; }}>${icon(Plus,{size:16})}</mux-ui-button>` : nothing}
    </div>
    ${selected ? html`<div class="conversation"><mux-sdk-chat side-mode .sessionId=${selected.id}></mux-sdk-chat></div>` : html`<div class="start">
      <div class="intro"><h2>Ask without interrupting</h2><p>Ask a focused question about the main chat. This conversation stays here while the main work continues.</p></div>
      <form @submit=${(event: SubmitEvent) => { event.preventDefault(); void this.ask(); }}>
        <mux-ui-text-area aria-label="Side chat question" placeholder="What would you like to understand?" .rows=${4} .value=${this.question} @input=${(event: Event) => { this.question = (event.target as MuxUITextArea).value; }} @keydown=${(event: KeyboardEvent) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void this.ask(); } }}></mux-ui-text-area>
        <div class="form-actions"><mux-ui-button variant="primary" ?disabled=${!this.question.trim() || this.sending} ?busy=${this.sending} @click=${() => void this.ask()}>${icon(Send,{size:15})} Ask</mux-ui-button></div>
      </form>
      ${this.error ? html`<mux-ui-feedback kind="error" density="compact">${this.error}</mux-ui-feedback>` : nothing}
      ${this.chats.length ? html`<div class="recent"><h3>Earlier side chats</h3><div class="recent-list">${this.chats.map(chat => html`<mux-ui-rail-row .label=${chat.title || 'Side chat'} @click=${() => { this.selectedId = chat.id; }}></mux-ui-rail-row>`)}</div></div>` : this.loading ? html`<mux-ui-feedback kind="loading" density="compact">Loading side chats…</mux-ui-feedback>` : nothing}
    </div>`}`;
  }
}
