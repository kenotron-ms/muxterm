import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { Send } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { rememberChatHost, remoteChatPath } from '../lib/remote-chat-routes.js';
import { icon } from '../lib/icons.js';
import type { SDKChat } from '../lib/sdk-chats.js';
import './mux-sdk-chat.js';
import '../ui/button.js';
import '../ui/feedback.js';
import '../ui/text-area.js';
import type { MuxUITextArea } from '../ui/text-area.js';

@customElement('mux-side-chat')
export class MuxSideChat extends LitElement {
  @property() sessionId = '';
  @property() remoteHost = '';
  @property() tabId = '';
  @property() chatId = '';
  @property() draft = '';
  @property({ attribute:false }) onChatCreated?: (tabId: string, chat: SDKChat) => void;
  @state() private question = '';
  @state() private sending = false;
  @state() private error = '';

  static styles = css`
    :host { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-sm)/1.5 var(--ui-font-sans); }
    .conversation { position:relative; flex:1; min-height:0; }
    .empty-chat { display:flex; flex:1; min-height:0; flex-direction:column; }
    .empty-body { box-sizing:border-box; display:flex; flex:1; min-height:0; align-items:center; justify-content:center; padding:var(--ui-space-7); text-align:center; }
    .empty-body > div { max-width:var(--ui-side-chat-start-width); }
    .empty-body h2 { margin:0 0 var(--ui-space-2); font:600 var(--ui-text-lg)/1.35 var(--ui-font-sans); }
    .empty-body p { margin:0; color:var(--ui-text-muted); }
    form { box-sizing:border-box; width:100%; max-width:var(--ui-chat-transcript-width); margin:0 auto; padding:var(--ui-space-5) var(--ui-space-7) var(--ui-space-7); }
    .composer { border:1px solid var(--ui-border); border-radius:var(--ui-radius-xl); background:var(--ui-surface-raised); padding:var(--ui-space-3); box-shadow:var(--ui-shadow-control); }
    mux-ui-text-area { width:100%; }
    .form-actions { display:flex; justify-content:flex-end; margin-top:var(--ui-space-2); }
    mux-ui-feedback { display:block; margin-bottom:var(--ui-space-3); }
    @media(max-width:767.98px) { form { padding:var(--ui-space-4) var(--ui-space-5) var(--ui-space-5); } }
  `;

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('tabId')) {
      this.question = this.draft;
      this.sending = false;
      this.error = '';
    }
  }

  focusQuestion() {
    void this.updateComplete.then(() => this.renderRoot.querySelector<MuxUITextArea>('mux-ui-text-area')?.focus());
  }

  private setQuestion(value: string) {
    this.question = value;
    this.dispatchEvent(new CustomEvent('side-chat-draft', { detail:{tabId:this.tabId, draft:value}, bubbles:true, composed:true }));
  }

  private async ask() {
    const prompt = this.question.trim();
    if (!prompt || this.sending) return;
    const parent = this.sessionId;
    const tabId = this.tabId;
    this.sending = true;
    this.error = '';
    try {
      const response = await fetch(apiPath(remoteChatPath(this.remoteHost, '/api/sdk-chats')), {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({sideParentId:parent, prompt}),
      });
      if (!response.ok) throw new Error(await response.text());
      const chat = await response.json() as SDKChat;
      rememberChatHost(chat.id, this.remoteHost);
      this.onChatCreated?.(tabId, chat);
      if (this.tabId === tabId) { this.chatId = chat.id; this.question = ''; }
    } catch (error) {
      if (this.tabId === tabId) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.tabId === tabId) this.sending = false;
    }
  }

  override render() {
    return this.chatId ? html`<div class="conversation"><mux-sdk-chat side-mode .sessionId=${this.chatId}></mux-sdk-chat></div>` : html`<div class="empty-chat">
      <div class="empty-body"><div><h2>Ask about this chat</h2><p>Start a side conversation while the main chat continues.</p></div></div>
      <form @submit=${(event: SubmitEvent) => { event.preventDefault(); void this.ask(); }}>
        ${this.error ? html`<mux-ui-feedback kind="error" density="compact">${this.error}</mux-ui-feedback>` : nothing}
        <div class="composer"><mux-ui-text-area aria-label="Side chat question" placeholder="Ask a question…" .rows=${3} .value=${this.question} @input=${(event: Event) => this.setQuestion((event.target as MuxUITextArea).value)} @keydown=${(event: KeyboardEvent) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void this.ask(); } }}></mux-ui-text-area>
          <div class="form-actions"><mux-ui-button variant="primary" ?disabled=${!this.question.trim() || this.sending} ?busy=${this.sending} @click=${() => void this.ask()}>${icon(Send,{size:15})} Ask</mux-ui-button></div></div>
      </form>
    </div>`;
  }
}
