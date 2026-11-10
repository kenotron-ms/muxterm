import { LitElement, css, html } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { customElement, property } from 'lit/decorators.js';
import type { SDKChat } from '../lib/sdk-chats.js';
import type { MuxSDKChat } from './mux-sdk-chat.js';
import './mux-sdk-chat.js';

@customElement('mux-side-chat')
export class MuxSideChat extends LitElement {
  @property() sessionId = '';
  @property() remoteHost = '';
  @property() tabId = '';
  @property() chatId = '';
  @property() draft = '';
  @property({ attribute:false }) onChatCreated?: (tabId: string, chat: SDKChat) => void;

  static styles = css`
    :host { position:relative; display:flex; height:100%; min-height:0; }
    mux-sdk-chat { flex:1; min-width:0; }
  `;

  focusQuestion() {
    void this.updateComplete.then(() => this.renderRoot.querySelector<MuxSDKChat>('mux-sdk-chat')?.focusComposer());
  }

  private chatCreated = (tabId: string, chat: SDKChat) => {
    this.onChatCreated?.(tabId, chat);
    if (this.tabId === tabId) this.chatId = chat.id;
  };

  override render() {
    return keyed(this.tabId, html`<mux-sdk-chat side-mode .sessionId=${this.chatId} .sideParentId=${this.sessionId} .sideRemoteHost=${this.remoteHost} .sideTabId=${this.tabId} .initialSideDraft=${this.draft} .onSideChatCreated=${this.chatCreated}></mux-sdk-chat>`);
  }
}
