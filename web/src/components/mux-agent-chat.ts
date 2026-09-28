import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { homeSessions } from '../lib/home-sessions.js';
import { terminalRegistry } from '../lib/terminal-registry.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import type { SessionTranscriptTurn } from '../types.js';

// The shell-backed session remains mounted in mux-dock underneath this view.
// This surface uses the same transcript journal and markdown renderer as the
// Operator conversation where the harness provides readable turns. A live
// terminal view is available for prompts and full-screen harness controls.
@customElement('mux-agent-chat')
export class MuxAgentChat extends LitElement {
  @property() workspaceId = '';
  @property({ type: Number }) paneId = 0;
  @property() title = 'Chat';
  @property() harness = '';
  @property() projectPath = '';
  @state() private draft = '';
  @state() private turns: SessionTranscriptTurn[] = [];
  @state() private screen = '';
  @state() private transcriptError = '';
  private cursor = '';
  private sessionId = '';
  private lastRequestAt = 0;
  private unsub: (() => void) | null = null;
  private screenSubscription: { dispose(): void } | null = null;
  private screenPane = 0;
  private screenFrame = 0;
  private parsers = new Map<number, MarkdownStream>();

  static styles = css`
    :host { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column; background: var(--chrome-bg, #1a1c28); color: var(--chrome-text-bright, #d9def0); font: 13px/1.55 system-ui, sans-serif; }
    .topbar { min-height: var(--mux-titlebar-height, 44px); box-sizing: border-box; display: flex; align-items: center; gap: 12px; padding: 0 22px; border-bottom: 1px solid var(--chrome-border, #343a4c); }
    h1 { font-size: 14px; font-weight: 650; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { margin-left: auto; color: var(--chrome-text-dim, #8e95aa); font-size: 11px; white-space: nowrap; }
    .terminal { border: 0; background: transparent; color: #9cbaf5; padding: 7px; cursor: pointer; font: inherit; }
    .body { flex: 1; min-height: 0; overflow: auto; padding: 32px clamp(24px, 8vw, 120px) 55px; display: flex; flex-direction: column; gap: 24px; }
    .turn { max-width: 780px; width: 100%; align-self: center; }
    .turn.user { display: flex; justify-content: flex-end; }
    .bubble { max-width: min(82%, 660px); padding: 10px 14px; border-radius: 15px; background: rgba(122,162,247,.14); white-space: pre-wrap; overflow-wrap: anywhere; }
    .speaker { color: var(--chrome-text-dim, #9aa3b8); font-size: 11px; margin-bottom: 7px; }
    .assistant .text { overflow-wrap: anywhere; }
    .assistant .text :is(p, pre) { margin: 0 0 10px; }
    .live { border-top: 1px solid var(--chrome-border, #343a4c); padding-top: 18px; color: var(--chrome-text-dim, #9aa3b8); }
    .live pre { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; color: var(--chrome-text-bright, #d9def0); margin: 8px 0 0; }
    .note { align-self: center; max-width: 780px; width: 100%; color: var(--chrome-text-dim, #9aa3b8); font-size: 12px; }
    .composer-wrap { padding: 0 clamp(24px, 8vw, 120px) 18px; }
    .composer { max-width: 780px; margin: auto; display: flex; align-items: flex-end; gap: 10px; border: 1px solid var(--chrome-border, #41485f); border-radius: 16px; background: rgba(0,0,0,.15); padding: 11px 12px; }
    textarea { flex: 1; min-width: 0; resize: none; border: 0; outline: none; background: transparent; color: inherit; font: inherit; line-height: 1.45; height: 46px; }
    .send { width: 31px; height: 31px; flex: none; border-radius: 50%; border: 0; background: #9bb8f7; color: #152032; cursor: pointer; font-size: 18px; }
    .send:disabled { opacity: .38; cursor: default; }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.unsub = homeSessions.subscribe(() => this.syncSession());
    window.addEventListener('session-transcript-result', this.onTranscript as EventListener);
    this.syncSession();
  }
  override disconnectedCallback() {
    this.unsub?.();
    this.unsub = null;
    window.removeEventListener('session-transcript-result', this.onTranscript as EventListener);
    this.screenSubscription?.dispose();
    this.screenSubscription = null;
    if (this.screenFrame) cancelAnimationFrame(this.screenFrame);
    this.screenFrame = 0;
    super.disconnectedCallback();
  }
  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('workspaceId') || changed.has('paneId')) {
      this.sessionId = '';
      this.cursor = '';
      this.lastRequestAt = 0;
      this.turns = [];
      this.parsers.clear();
      this.syncSession();
      this.screenSubscription?.dispose();
      this.screenSubscription = null;
    }
  }
  override updated() {
    if (this.screenSubscription && this.screenPane === this.paneId) return;
    const term = terminalRegistry.getTerminal(this.paneId);
    if (!term) return;
    this.screenSubscription?.dispose();
    this.screenPane = this.paneId;
    this.screenSubscription = term.onWriteParsed(() => {
      if (this.screenFrame) return;
      this.screenFrame = requestAnimationFrame(() => {
        this.screenFrame = 0;
        this.readScreen();
      });
    });
    this.readScreen();
  }
  private syncSession() {
    const row = homeSessions.sessions.find(s => s.workspaceId === this.workspaceId && s.paneId === this.paneId);
    if (!row) return;
    if (row.sessionId !== this.sessionId) {
      this.sessionId = row.sessionId;
      this.cursor = '';
      this.turns = [];
      this.lastRequestAt = 0;
    }
    if (Date.now() - this.lastRequestAt < 5000) return;
    this.lastRequestAt = Date.now();
    this.dispatchEvent(new CustomEvent('session-transcript-request', {
      detail: { sessionId: row.sessionId, cursor: this.cursor }, bubbles: true, composed: true,
    }));
  }
  private onTranscript = (event: CustomEvent) => {
    const result = event.detail as { sessionId?: string; transcriptTurns?: SessionTranscriptTurn[]; transcriptCursor?: string; transcriptError?: string; unchanged?: boolean };
    if (!this.sessionId || result.sessionId !== this.sessionId) return;
    if (!result.unchanged && result.transcriptTurns) {
      this.turns = result.transcriptTurns;
      this.parsers.clear();
    }
    this.cursor = result.transcriptCursor ?? this.cursor;
    this.transcriptError = result.transcriptError ?? '';
  };
  private readScreen() {
    const term = terminalRegistry.getTerminal(this.paneId);
    if (!term) return;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    const start = Math.max(0, buffer.baseY - 3);
    for (let i = start; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    const text = lines.join('\n').trim();
    if (text !== this.screen) {
      const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
      const follow = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 100;
      this.screen = text;
      if (follow) void this.updateComplete.then(() => {
        const current = this.shadowRoot?.querySelector<HTMLElement>('.body');
        if (current) current.scrollTop = current.scrollHeight;
      });
    }
  }
  private send() {
    const message = this.draft.trim();
    if (!message) return;
    this.dispatchEvent(new CustomEvent('agent-chat-send', {
      detail: { workspaceId: this.workspaceId, paneId: this.paneId, text: message }, bubbles: true, composed: true,
    }));
    this.draft = '';
  }
  private markdown(turn: SessionTranscriptTurn, index: number) {
    let parser = this.parsers.get(index);
    if (!parser) { parser = new MarkdownStream(); this.parsers.set(index, parser); }
    return renderSegments(parser.update(turn.text ?? '', false));
  }
  override render() {
    const hasTurns = this.turns.length > 0;
    return html`
      <div class="topbar"><h1 title=${this.title}>${this.title}</h1><span class="meta">${this.harness} · ${this.projectPath}</span><button class="terminal" @click=${() => this.dispatchEvent(new CustomEvent('agent-chat-terminal', { bubbles: true, composed: true }))}>Terminal ↗</button></div>
      <div class="body">
        ${hasTurns ? this.turns.map((turn, i) => html`<div class="turn ${turn.role === 'user' ? 'user' : 'assistant'}">
          ${turn.role === 'user' ? html`<div class="bubble">${turn.text}</div>` : html`<div><div class="speaker">${this.harness}</div><div class="text">${this.markdown(turn, i)}</div></div>`}
        </div>`) : nothing}
        ${this.screen ? html`<div class="turn live"><div class="speaker">${hasTurns ? 'Live terminal' : 'Live session'}</div><pre>${this.screen}</pre></div>` : html`<div class="note">Starting the live session…</div>`}
        ${this.transcriptError && !this.screen ? html`<div class="note">${this.transcriptError}</div>` : nothing}
      </div>
      <div class="composer-wrap"><div class="composer"><textarea placeholder="Message ${this.harness}…" .value=${this.draft} @input=${(e: Event) => { this.draft = (e.target as HTMLTextAreaElement).value; }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } }}></textarea><button class="send" aria-label="Send message" ?disabled=${!this.draft.trim()} @click=${this.send}>↑</button></div></div>
    `;
  }
}
