import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MessageSquare, Square } from 'lucide';
import { icon } from '../lib/icons.js';
import type { SDKVoiceState } from '../lib/sdk-voice-session.js';

export type VoiceEntry = { role: 'user' | 'assistant' | 'task' | 'error'; text: string; at?: string };

/** The conversation surface for the single voice connection owned by a main chat. */
@customElement('mux-voice-companion')
export class MuxVoiceCompanion extends LitElement {
  @property({ attribute: false }) entries: VoiceEntry[] = [];
  @property() voiceState: SDKVoiceState = 'idle';
  @property({ type:Number }) startedAt = 0;
  @property({ type: Boolean }) available = false;
  @property({ type: Boolean }) canStart = true;
  @property() error = '';
  @state() private seconds = 0;
  private ticker?: number;

  static override styles = css`
    :host { display:flex; flex-direction:column; height:100%; min-width:0; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-sm)/1.5 var(--ui-font-sans); }
    .conversation { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:var(--ui-space-5); padding:var(--ui-space-6); }
    .empty { flex:1; display:flex; align-items:center; justify-content:center; color:var(--ui-text-muted); text-align:center; }
    .entry { max-width:86%; overflow-wrap:anywhere; }
    .speaker { margin-bottom:var(--ui-space-1); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .message { padding:var(--ui-space-3) var(--ui-space-4); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); white-space:pre-wrap; }
    .user { align-self:flex-end; }
    .user .speaker { text-align:right; }
    .user .message { background:var(--ui-surface-raised); }
    .assistant .message { background:var(--ui-chat-assistant-surface); color:var(--ui-chat-assistant-text); }
    .task { align-self:stretch; max-width:none; color:var(--ui-text-muted); }
    .task .speaker { display:flex; align-items:center; gap:var(--ui-space-2); margin-bottom:0; min-height:var(--ui-chat-tool-row-height); }
    .task .message { margin-left:calc(15px + var(--ui-space-2)); border:0; background:none; padding:0; color:var(--ui-text); }
    .error { align-self:stretch; max-width:none; color:var(--ui-danger); }
    .control-wrap { padding:var(--ui-space-3) var(--ui-space-4) var(--ui-space-4); }
    .control { box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-3); width:100%; height:50px; padding:5px 6px 5px var(--ui-space-5); border:1px solid var(--ui-border); border-radius:999px; background:var(--ui-surface-raised); color:var(--ui-text-muted); box-shadow:var(--ui-shadow-control); }
    .label { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font:400 14px/1.3 var(--ui-font-sans); }
    .wave { display:flex; align-items:center; justify-content:center; gap:2px; height:26px; flex:none; color:var(--ui-accent); }
    .wave i { display:block; width:2px; height:5px; border-radius:2px; background:currentColor; transition:height .07s ease-out; }
    .time { min-width:34px; font:400 12px/1.3 var(--ui-font-sans); font-variant-numeric:tabular-nums; }
    button { display:grid; place-items:center; flex:none; width:38px; height:38px; border:0; border-radius:50%; background:var(--ui-danger); color:white; cursor:pointer; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    button:focus-visible { outline:2px solid var(--ui-accent); outline-offset:2px; }
    .record-dot { display:block; width:12px; height:12px; border-radius:50%; background:currentColor; }
    @media (prefers-reduced-motion:reduce) { .wave i { transition:none; } }
  `;

  override updated(changed: Map<string, unknown>) {
    if (changed.has('voiceState') || changed.has('startedAt')) {
      if (this.voiceState !== 'idle' && this.startedAt && !this.ticker) {
        this.seconds = Math.floor((Date.now() - this.startedAt) / 1000);
        this.ticker = window.setInterval(() => { this.seconds = Math.floor((Date.now() - this.startedAt) / 1000); }, 1000);
      } else if (this.voiceState === 'idle' && this.ticker) {
        window.clearInterval(this.ticker);
        this.ticker = undefined;
        this.seconds = 0;
      }
    }
    if (changed.has('entries')) {
      const body = this.renderRoot.querySelector<HTMLElement>('.conversation');
      if (body && body.scrollHeight - body.scrollTop - body.clientHeight < 140) body.scrollTop = body.scrollHeight;
    }
  }

  override disconnectedCallback() {
    window.clearInterval(this.ticker);
    this.ticker = undefined;
    super.disconnectedCallback();
  }

  setLevels(levels: readonly number[]) {
    this.renderRoot.querySelectorAll<HTMLElement>('.wave i').forEach((bar, index) => {
      const position = index / 17;
      const sample = position * 3;
      const low = Math.floor(sample);
      const level = (levels[low] || 0) * (1 - sample + low) + (levels[Math.min(3, low + 1)] || 0) * (sample - low);
      const rhythm = .45 + .55 * Math.abs(Math.sin(index * 1.9));
      bar.style.height = `${Math.round(4 + level * 21 * rhythm)}px`;
    });
  }

  private toggle() { this.dispatchEvent(new CustomEvent('voice-toggle', { bubbles:true, composed:true })); }

  override render() {
    const active = this.voiceState !== 'idle';
    const label = this.voiceState === 'connecting' ? 'Connecting…' : this.voiceState === 'speaking' ? 'Speaking…' : active ? 'Listening…' : this.entries.length ? 'Voice paused' : 'Start voice';
    const elapsed = `${Math.floor(this.seconds / 60)}:${String(this.seconds % 60).padStart(2, '0')}`;
    return html`<div class="conversation" aria-label="Voice conversation">
      ${this.entries.length ? this.entries.map(entry => html`<div class="entry ${entry.role}">
        <div class="speaker">${entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Voice' : entry.role === 'task' ? html`${icon(MessageSquare,{size:15})} Sent to task chat` : 'Voice'}</div>
        <div class="message">${entry.text.trimEnd()}</div>
      </div>`) : html`<div class="empty">${this.available ? 'Start speaking to Voice' : 'Voice is unavailable'}</div>`}
      ${this.error ? html`<div class="entry error" role="alert">${this.error}</div>` : nothing}
    </div><div class="control-wrap"><div class="control">
      <span class="label" role="status" aria-live="polite">${label}</span>
      ${active ? html`<span class="wave" aria-hidden="true">${Array.from({length:18}, () => html`<i></i>`)}</span><span class="time" aria-label=${`${this.seconds} seconds`}>${elapsed}</span>` : nothing}
      <button type="button" aria-label=${active ? 'Stop voice mode' : 'Start voice mode'} title=${active ? 'Stop voice mode' : 'Start voice mode'} ?disabled=${!active && (!this.available || !this.canStart)} @click=${this.toggle}>
        ${active ? icon(Square,{size:16}) : html`<span class="record-dot"></span>`}
      </button>
    </div></div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-voice-companion': MuxVoiceCompanion } }
