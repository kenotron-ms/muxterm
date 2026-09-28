import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { homeSessions } from '../lib/home-sessions.js';
import type { SessionTranscriptTurn, SessiondMessage } from '../types.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';

@customElement('mux-session-chat')
export class MuxSessionChat extends LitElement {
  @property() workspaceId = '';
  @property({ type:Number }) paneId = 0;
  @property() fallbackTitle = 'New chat';
  @property() fallbackHarness = '';
  @state() private revision = 0;
  @state() private turns: SessionTranscriptTurn[] = [];
  @state() private transcriptError = '';
  private unsubscribe: (() => void) | null = null;
  private sessionId = '';
  private parsers = new Map<number, MarkdownStream>();

  static styles = css`
    :host { position:absolute; inset:0; z-index:5; display:flex; flex-direction:column; background:var(--chrome-bar,#20242b); color:var(--ink-2,#e7e8ec); font:13px/1.5 system-ui,sans-serif; }
    * { box-sizing:border-box; }
    header { height:48px; flex:none; padding:0 20px; border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent); display:flex; align-items:center; gap:12px; }
    header strong { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
    header small { color:var(--chrome-text-dim,#9ca2ab); font:11px ui-monospace,monospace; }
    button { cursor:pointer; font:inherit; }
    .terminal { border:0; background:transparent; color:var(--chrome-text-dim,#aeb5bd); }
    .terminal:hover { color:inherit; }
    .messages { flex:1; overflow:auto; padding:28px max(24px,calc((100% - 760px)/2)); }
    .message { margin:0 0 25px; max-width:100%; overflow-wrap:anywhere; white-space:pre-wrap; }
    .message.user { margin-left:auto; width:max-content; max-width:85%; background:color-mix(in srgb,currentColor 9%,transparent); padding:11px 15px; border-radius:17px; }
    .message.assistant { line-height:1.65; }
    .message.tool { color:var(--chrome-text-dim,#aeb5bd); font-size:12px; }
    .note { color:var(--chrome-text-dim,#aeb5bd); text-align:center; margin-top:14vh; }
    .composer { width:min(760px,calc(100% - 40px)); margin:0 auto 22px; display:flex; gap:8px; border:1px solid color-mix(in srgb,currentColor 18%,transparent); border-radius:18px; background:color-mix(in srgb,currentColor 5%,transparent); padding:9px; }
    textarea { flex:1; min-height:38px; max-height:150px; resize:vertical; background:transparent; border:0; outline:0; color:inherit; padding:8px; font:inherit; }
    .send { align-self:flex-end; background:var(--ink-2,#edf0f4); color:var(--chrome-bar,#20242b); border:0; border-radius:50%; width:34px; height:34px; font-size:20px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe = homeSessions.subscribe(() => { this.revision++; this.refresh(); });
    window.addEventListener('session-transcript-result', this.onTranscript as EventListener);
    this.refresh();
  }
  disconnectedCallback(): void {
    super.disconnectedCallback(); this.unsubscribe?.(); this.unsubscribe = null;
    window.removeEventListener('session-transcript-result', this.onTranscript as EventListener);
  }
  updated(changed: Map<string, unknown>): void {
    if (changed.has('workspaceId') || changed.has('paneId')) this.refresh();
  }
  private get session() { return homeSessions.sessions.find(s => s.workspaceId === this.workspaceId && s.paneId === this.paneId); }
  private refresh(): void {
    const id = this.session?.sessionId ?? '';
    if (id !== this.sessionId) { this.sessionId = id; this.turns = []; this.parsers.clear(); }
    if (id) this.dispatchEvent(new CustomEvent('session-transcript-request', { detail:{sessionId:id}, bubbles:true, composed:true }));
  }
  private onTranscript = (event: CustomEvent<SessiondMessage>): void => {
    const msg = event.detail;
    if (!this.sessionId || msg.sessionId !== this.sessionId) return;
    this.transcriptError = msg.transcriptError ?? '';
    if (!msg.unchanged) this.turns = msg.transcriptTurns ?? [];
  };
  private send(): void {
    const input = this.renderRoot.querySelector('textarea');
    const text = input?.value.trim();
    if (!text) return;
    this.dispatchEvent(new CustomEvent('session-chat-send', { detail:{workspaceId:this.workspaceId,paneId:this.paneId,text}, bubbles:true, composed:true }));
    if (input) input.value = '';
  }
  private renderTurn(turn: SessionTranscriptTurn, index: number) {
    if (turn.role !== 'assistant') return html`<div class="message ${turn.role}">${turn.text ?? turn.tool ?? ''}</div>`;
    let parser = this.parsers.get(index);
    if (!parser) { parser = new MarkdownStream(); this.parsers.set(index, parser); }
    return html`<div class="message assistant">${renderSegments(parser.update(turn.text ?? '', false), { resolve: () => null })}</div>`;
  }
  render() {
    void this.revision;
    const session = this.session;
    return html`<header><strong>${this.fallbackTitle || session?.name || 'New chat'}</strong><small>${(session?.harness ?? this.fallbackHarness) || 'starting'}${session?.state ? ` · ${session.state}` : ''}</small><button class="terminal" @click=${() => this.dispatchEvent(new CustomEvent('session-chat-terminal',{bubbles:true,composed:true}))}>Open terminal ↗</button></header>
      <div class="messages">${this.turns.length ? this.turns.map((turn,index) => turn.role === 'user' && turn.text?.trimStart().startsWith('<system-reminder') ? nothing : this.renderTurn(turn,index)) : html`<div class="note">${this.transcriptError || 'The session is starting. Its conversation appears here as it reports turns.'}</div>`}</div>
      <div class="composer"><textarea aria-label="Message" placeholder="Message ${session?.harness ?? this.fallbackHarness ?? 'session'}" @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } }}></textarea><button class="send" title="Send message" @click=${this.send}>↑</button></div>`;
  }
}
