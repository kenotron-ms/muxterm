import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ToastTone } from '../lib/toast.js';

@customElement('mux-toast')
export class MuxToast extends LitElement {
  @state() private message = '';
  @state() private tone: ToastTone = 'error';
  private timer?: number;

  static styles = css`
    :host { position:fixed; z-index:950; bottom:24px; left:50%; transform:translateX(-50%); width:max-content; max-width:min(440px,calc(100vw - 32px)); pointer-events:none; }
    .toast { box-sizing:border-box; display:flex; align-items:center; gap:12px; min-height:44px; padding:10px 12px 10px 14px; border:1px solid var(--chrome-border); border-left:3px solid var(--chrome-danger); border-radius:8px; background:var(--chrome-bar); color:var(--chrome-text-bright); box-shadow:0 8px 24px #0007; font:13px/1.4 system-ui,sans-serif; pointer-events:auto; }
    .toast.info { border-left-color:var(--chrome-accent); }
    span { overflow-wrap:anywhere; }
    button { flex:none; border:0; border-radius:4px; background:transparent; color:inherit; font:inherit; cursor:pointer; padding:2px 5px; }
    button:hover { background:var(--chrome-hover); }
    button:focus-visible { outline:2px solid var(--chrome-accent); }
  `;

  override connectedCallback(): void { super.connectedCallback(); window.addEventListener('muxterm-toast', this.onToast); }
  override disconnectedCallback(): void { window.removeEventListener('muxterm-toast', this.onToast); if (this.timer) window.clearTimeout(this.timer); super.disconnectedCallback(); }
  private readonly onToast = (event: Event): void => {
    const detail = (event as CustomEvent<{message:string;tone:ToastTone}>).detail;
    if (!detail?.message) return;
    this.message = detail.message;
    this.tone = detail.tone;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.message = ''; this.timer = undefined; }, 5000);
  };
  override render() { return this.message ? html`<div class="toast ${this.tone}" role="alert"><span>${this.message}</span><button type="button" aria-label="Dismiss notification" @click=${() => { this.message = ''; if (this.timer) window.clearTimeout(this.timer); }}>×</button></div>` : nothing; }
}
