import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';

type Settings = { bundle: string; provider: string; model: string; bundles: string[]; providers: string[] };

@customElement('mux-amplifier-settings')
export class MuxAmplifierSettings extends LitElement {
  @property() sessionId = '';
  @property({ type: Boolean }) turnBusy = false;
  @state() private open = false;
  @state() private loading = false;
  @state() private settings?: Settings;
  @state() private bundle = '';
  @state() private provider = '';
  @state() private error = '';
  static styles = css`
    :host { position:relative; display:block; min-width:0; font:12px system-ui,sans-serif; }
    button, select { font:inherit; }
    button { cursor:pointer; color:inherit; background:transparent; border:1px solid #58637c; border-radius:7px; padding:5px 9px; }
    .summary { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#d9e5ff; background:#283852; }
    .summary:hover, .summary:focus-visible { background:#3b5278; }
    .panel { position:absolute; left:0; bottom:34px; width:260px; z-index:10; padding:14px; background:#252b39; border:1px solid #4b556b; border-radius:9px; box-shadow:0 12px 24px #0008; }
    label { display:block; margin:9px 0; color:#c3cce0; }
    select { display:block; box-sizing:border-box; width:100%; margin-top:4px; padding:6px; color:#e4e9f4; background:#171c28; border:1px solid #58637c; border-radius:5px; }
    .note { color:#9ca9c4; margin:8px 0; }
    .error { color:#f1aaaa; white-space:pre-wrap; overflow-wrap:anywhere; }
  `;
  override updated(changed: Map<string, unknown>) {
    if (changed.has('sessionId') && this.sessionId) {
      this.open = false; this.settings = undefined; this.bundle = ''; this.provider = ''; this.error = '';
      this.pending(false);
      void this.load(this.sessionId);
    }
  }
  private pending(value: boolean) {
    this.dispatchEvent(new CustomEvent('settings-pending', { detail:value, bubbles:true, composed:true }));
  }
  private async load(sessionId: string) {
    this.loading = true;
    try {
      const res = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(sessionId)}/settings`));
      if (!res.ok) throw new Error(await res.text());
      const settings = await res.json() as Settings;
      if (this.sessionId !== sessionId) return;
      this.settings = settings;
      this.bundle = this.settings.bundle;
      this.provider = this.settings.provider;
    } catch (error) { if (this.sessionId === sessionId) this.error = String(error); }
    finally { this.loading = false; }
  }
  private async save() {
    if (this.loading || this.turnBusy) return;
    this.loading = true; this.error = '';
    try {
      const res = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/settings`), {
        method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ bundle:this.bundle, provider:this.provider }),
      });
      if (!res.ok) throw new Error(await res.text());
      this.settings = await res.json() as Settings;
      this.bundle = this.settings.bundle;
      this.provider = this.settings.provider;
      this.dispatchEvent(new CustomEvent('settings-changed', { detail:this.settings, bubbles:true, composed:true }));
      this.pending(false);
      this.open = false;
    } catch (error) { this.error = String(error); }
    finally { this.loading = false; }
  }
  override render() { return html`
    <button class="summary" aria-label="Change Amplifier bundle and provider" aria-expanded=${this.open} @click=${() => { this.open = !this.open; if (this.open && !this.settings && !this.loading) void this.load(this.sessionId); }}>Bundle: ${this.settings?.bundle || (this.loading ? 'Loading…' : 'Unavailable')} · Provider: ${this.settings?.provider || '—'} ▾</button>
    ${this.open ? html`<div class="panel" aria-label="Amplifier settings">
      ${this.loading && !this.settings ? html`Loading…` : nothing}
      ${this.settings ? html`
        <label>Bundle<select .value=${this.bundle} @change=${(e: Event) => { this.bundle = (e.target as HTMLSelectElement).value; this.pending(true); }}>
          ${this.settings.bundles.map(v => html`<option value=${v} ?selected=${this.bundle === v}>${v}</option>`)}
        </select></label>
        <label>Provider<select .value=${this.provider} @change=${(e: Event) => { this.provider = (e.target as HTMLSelectElement).value; this.pending(true); }}>
          ${this.settings.providers.map(v => html`<option value=${v} ?selected=${this.provider === v}>${v}</option>`)}
        </select></label>
        <div class="note">${this.settings.model}</div>
        <button ?disabled=${this.loading || this.turnBusy} @click=${() => void this.save()}>Apply to chat</button>
        ${this.bundle !== this.settings.bundle || this.provider !== this.settings.provider ? html`<div class="note">Apply this selection before sending.</div>` : nothing}
        ${this.turnBusy ? html`<div class="note">Finish this turn before switching.</div>` : nothing}
      ` : nothing}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
    </div>` : nothing}`; }
}
