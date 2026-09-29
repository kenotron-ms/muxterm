import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';

type ModelOption = { id: string; label: string; efforts: string[]; defaultEffort?: string };
type Settings = { model: string; effort: string; models: ModelOption[]; bundle?: string; provider?: string; bundles?: string[]; providers?: string[] };
const providerLabel = (provider: string) => provider === 'provider-anthropic' ? 'Anthropic' : provider === 'provider-openai' ? 'OpenAI' : provider;
const primaryProviders = ['provider-anthropic', 'provider-openai'];

@customElement('mux-sdk-chat-settings')
export class MuxSDKChatSettings extends LitElement {
  @property() sessionId = '';
  @property() harness = '';
  @property({ type:Boolean }) turnBusy = false;
  @state() private settings?: Settings;
  @state() private loading = false;
  @state() private error = '';
  private requestVersion = 0;
  static styles = css`
    :host { display:flex; align-items:center; flex-wrap:wrap; gap:4px 10px; min-width:0; font:12px system-ui,sans-serif; }
    label { display:flex; align-items:center; gap:5px; color:var(--chrome-text-dim,#9aa3b8); white-space:nowrap; }
    select { max-width:190px; min-width:58px; height:30px; padding:2px 20px 2px 5px; color:var(--chrome-text-bright,#d9def0); background:transparent; border:1px solid transparent; border-radius:7px; font:inherit; cursor:pointer; }
    select:hover, select:focus-visible { background:rgba(255,255,255,.06); border-color:var(--chrome-border,#41485f); outline:none; }
    select:disabled { opacity:.5; cursor:not-allowed; }
    .advanced { position:relative; }
    .advanced summary { display:flex; align-items:center; gap:6px; max-width:190px; height:30px; padding:0 7px; border-radius:7px; color:var(--chrome-text-dim,#9aa3b8); cursor:pointer; list-style:none; }
    .advanced summary::-webkit-details-marker { display:none; }
    .advanced summary:hover, .advanced summary:focus-visible, .advanced[open] summary { background:rgba(255,255,255,.06); color:var(--chrome-text-bright,#d9def0); outline:none; }
    .advanced summary span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .advanced summary::after { content:'⌄'; font-size:15px; }
    .advanced-panel { position:absolute; z-index:12; left:0; bottom:35px; display:grid; gap:9px; width:max-content; max-width:min(310px,80vw); padding:12px; border:1px solid var(--chrome-border,#41485f); border-radius:11px; background:var(--chrome-bar,#202632); box-shadow:0 16px 40px rgba(0,0,0,.35); }
    .advanced-panel label { justify-content:space-between; gap:14px; }
    .advanced-panel select { max-width:190px; border-color:var(--chrome-border,#41485f); }
    .status { color:var(--chrome-text-dim,#9aa3b8); }
    .error { color:#f1aaaa; white-space:normal; }
  `;
  override updated(changed: Map<string, unknown>) {
    if (changed.has('sessionId') && this.sessionId) {
      this.settings = undefined; this.error = '';
      void this.load(this.sessionId);
    }
  }
  private pending(value: boolean) {
    this.dispatchEvent(new CustomEvent('settings-pending', { detail:value, bubbles:true, composed:true }));
  }
  private async load(sessionId: string) {
    const version = ++this.requestVersion;
    this.loading = true;
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(sessionId)}/settings`));
      if (!response.ok) throw new Error(await response.text());
      const settings = await response.json() as Settings;
      if (this.sessionId === sessionId && this.requestVersion === version) this.settings = settings;
    } catch (error) {
      if (this.sessionId === sessionId && this.requestVersion === version) this.error = String(error);
    } finally { if (this.requestVersion === version) this.loading = false; }
  }
  private async select(change: Record<string, string>) {
    if (this.loading || this.turnBusy || !this.settings) return;
    this.loading = true; this.error = ''; this.pending(true);
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/settings`), {
        method:'PATCH', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(change),
      });
      if (!response.ok) throw new Error(await response.text());
      this.settings = await response.json() as Settings;
      this.dispatchEvent(new CustomEvent('settings-changed', { detail:this.settings, bubbles:true, composed:true }));
    } catch (error) { this.error = String(error); }
    finally { this.loading = false; this.pending(false); }
  }
  override render() {
    const settings = this.settings;
    if (!settings) return html`<span class="${this.error ? 'error' : 'status'}">${this.error || 'Loading settings…'}</span>`;
    const selectedModel = settings.models.find(model => model.id === settings.model);
    const models = selectedModel ? settings.models : [{ id:settings.model, label:settings.model, efforts:[] }, ...settings.models];
    const disabled = this.loading || this.turnBusy;
    return html`
      ${models.length ? html`<label>Model <select aria-label="Model" .value=${settings.model} ?disabled=${disabled} @change=${(event: Event) => {
        const model = (event.target as HTMLSelectElement).value;
        const option = settings.models.find(item => item.id === model);
        void this.select({ model, effort:option?.defaultEffort || '' });
      }}>${models.map(model => html`<option value=${model.id} ?selected=${model.id === settings.model}>${model.label}</option>`)}</select></label>` : nothing}
      ${selectedModel?.efforts?.length ? html`<label>Thinking <select aria-label="Thinking effort" .value=${settings.effort || ''} ?disabled=${disabled} @change=${(event: Event) => void this.select({ effort:(event.target as HTMLSelectElement).value })}>
        <option value="" ?selected=${!settings.effort}>Default</option>${selectedModel.efforts.map(effort => html`<option value=${effort} ?selected=${effort === settings.effort}>${effort}</option>`)}
      </select></label>` : nothing}
      ${this.harness === 'amplifier' ? html`<details class="advanced"><summary aria-label="Amplifier bundle and provider" title="Bundle and provider"><span>${settings.bundle || 'Bundle'} · ${providerLabel(settings.provider || 'Provider')}</span></summary><div class="advanced-panel">
        <label>Bundle <select aria-label="Amplifier bundle" .value=${settings.bundle || ''} ?disabled=${disabled} @change=${(event: Event) => void this.select({ bundle:(event.target as HTMLSelectElement).value })}>
          ${(settings.bundles || []).map(bundle => html`<option value=${bundle} ?selected=${bundle === settings.bundle}>${bundle}</option>`)}
        </select></label>
        <label>Provider <select aria-label="Amplifier provider" .value=${settings.provider || ''} ?disabled=${disabled} @change=${(event: Event) => void this.select({ provider:(event.target as HTMLSelectElement).value })}>
          ${[...new Set([...primaryProviders, ...(settings.providers || [])])].map(provider => {
            const available = (settings.providers || []).includes(provider);
            return html`<option value=${provider} ?selected=${provider === settings.provider} ?disabled=${!available}>${providerLabel(provider)}${available ? '' : ' — unavailable for this bundle'}</option>`;
          })}
        </select></label></div></details>` : nothing}
      ${this.loading ? html`<span class="status">Applying…</span>` : nothing}
      ${this.error ? html`<span class="error" role="alert">${this.error}</span>` : nothing}`;
  }
}
