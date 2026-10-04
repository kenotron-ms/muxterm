import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';

type ModelOption = { id: string; label: string; efforts: string[]; defaultEffort?: string };
type ModeOption = { name: string; description?: string; source?: string };
type Settings = { model: string; effort: string; models: ModelOption[]; bundle?: string; provider?: string; bundles?: string[]; providers?: string[]; permission: string; mode: string; permissions: string[]; modes: string[]; modeOptions?: ModeOption[] };
const permissionLabels: Record<string, string> = { 'read-only':'Read only', 'workspace-write':'Workspace write', 'full-permission':'Full permission' };
const permissionHints: Record<string, string> = { 'read-only':'Inspect and plan without writing files', 'workspace-write':'Edit files in this workspace', 'full-permission':'Access the full environment' };
// Amplifier mode names are file stems (plan, careful, explore), so they arrive
// lowercase and are capitalised here to sit alongside the other picker entries.
const modeLabel = (value: string) => value ? value.charAt(0).toUpperCase() + value.slice(1) : 'Default';
const providerLabel = (value: string) => value === 'provider-anthropic' ? 'Anthropic' : value === 'provider-openai' ? 'OpenAI' : value.replace(/^provider-/, '');

@customElement('mux-sdk-chat-settings')
export class MuxSDKChatSettings extends LitElement {
  @property() sessionId = '';
  @property() harness = '';
  @property({ type:Boolean }) turnBusy = false;
  @state() private settings?: Settings;
  @state() private loading = false;
  @state() private error = '';
  private requestVersion = 0;
  private readonly closePickersOnOutsidePointer = (event: PointerEvent) => {
    const path = event.composedPath();
    this.renderRoot.querySelectorAll<HTMLDetailsElement>('.picker[open]').forEach(picker => {
      if (!path.includes(picker)) picker.open = false;
    });
  };
  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.closePickersOnOutsidePointer);
  }
  override disconnectedCallback() {
    document.removeEventListener('pointerdown', this.closePickersOnOutsidePointer);
    super.disconnectedCallback();
  }
  static styles = css`
    ${subtleScrollbars}
    :host { display:flex; align-items:center; flex:1; min-width:0; justify-content:space-between; gap:8px; font:12px/1.4 system-ui,sans-serif; }
    .picker { position:relative; min-width:0; }
    .model-picker { margin-left:auto; }
    summary { display:flex; align-items:center; height:32px; max-width:min(290px,40vw); box-sizing:border-box; padding:0 10px; border:1px solid transparent; border-radius:10px; color:var(--chrome-text-bright,#d9def0); cursor:pointer; list-style:none; white-space:nowrap; }
    summary::-webkit-details-marker { display:none; }
    summary:hover, summary:focus-visible, details[open] summary { background:var(--chrome-hover); border-color:var(--chrome-border,#41485f); outline:none; }
    .summary-text { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .panel { position:absolute; z-index:30; bottom:40px; width:min(350px,calc(100vw - 44px)); max-height:min(72vh,640px); overflow:auto; box-sizing:border-box; padding:8px; border:1px solid var(--chrome-border,#41485f); border-radius:16px; background:var(--chrome-bar,#202632); box-shadow:0 20px 60px rgba(0,0,0,.45); }
    .permission-picker .panel { left:0; }
    .model-picker .panel { right:0; }
    .heading { padding:9px 10px 5px; color:var(--chrome-text-dim,#9aa3b8); font-size:10px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; }
    .divider { height:1px; margin:7px 5px; background:var(--chrome-border,#41485f); }
    .choice { display:flex; align-items:center; gap:9px; width:100%; min-height:37px; border:0; border-radius:9px; padding:7px 10px; background:transparent; color:var(--chrome-text-bright,#d9def0); font:inherit; text-align:left; cursor:pointer; }
    .choice:hover:not(:disabled), .choice:focus-visible { background:var(--chrome-hover); outline:none; }
    .choice.selected { background:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 15%,transparent); }
    .choice:disabled { opacity:.46; cursor:default; }
    .choice-main { display:grid; gap:2px; min-width:0; flex:1; }
    .choice-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .hint { color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    .check { color:var(--chrome-accent,#9bb8f7); font-weight:700; }
    .group { margin:2px 4px 8px; }
    .model-list { max-height:190px; overflow-y:auto; }
    .slider { padding:4px 10px 13px; }
    .slider-header { display:flex; justify-content:space-between; gap:8px; font-weight:600; }
    input[type=range] { width:100%; margin:12px 0 4px; accent-color:var(--chrome-accent,#9bb8f7); cursor:pointer; }
    .slider-ends { display:flex; justify-content:space-between; color:var(--chrome-text-dim,#9aa3b8); font-size:10px; }
    .notice { padding:9px 10px; color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    .error { color:var(--chrome-danger); padding:7px 10px; overflow-wrap:anywhere; }
    .busy { opacity:.55; }
  `;
  override updated(changed: Map<string, unknown>) {
    if (changed.has('sessionId') && this.sessionId) { this.settings = undefined; this.error = ''; void this.load(this.sessionId); }
  }
  private pending(value: boolean) { this.dispatchEvent(new CustomEvent('settings-pending', { detail:value, bubbles:true, composed:true })); }
  private async load(sessionId: string) {
    const version = ++this.requestVersion;
    this.loading = true;
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(sessionId)}/settings`));
      if (!response.ok) throw new Error(await response.text());
      const settings = await response.json() as Settings;
      if (this.sessionId === sessionId && this.requestVersion === version) this.settings = settings;
    } catch (error) { if (this.sessionId === sessionId && this.requestVersion === version) this.error = String(error); }
    finally { if (this.requestVersion === version) this.loading = false; }
  }
  private async select(change: Record<string, string>) {
    if (this.loading || this.turnBusy || !this.settings) return;
    this.loading = true; this.error = ''; this.pending(true);
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/settings`), { method:'PATCH', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(change) });
      if (!response.ok) throw new Error(await response.text());
      this.settings = await response.json() as Settings;
      this.dispatchEvent(new CustomEvent('settings-changed', { detail:this.settings, bubbles:true, composed:true }));
    } catch (error) { this.error = String(error); }
    finally { this.loading = false; this.pending(false); }
  }
  /** Amplifier has no permission switch to offer -- its tool access comes from
   *  the composed bundle. What it does have, and nothing else exposed, is its
   *  own mode system, so that takes this slot. */
  private modePicker(s: Settings) {
    const active = s.mode || '';
    const options = s.modeOptions || [];
    return html`
      <details class="picker permission-picker" aria-label="Amplifier mode"><summary><span class="summary-text">${modeLabel(active)}</span></summary><div class="panel">
        <div class="heading">Mode</div>
        ${this.choice('Default', 'No overlay — the bundle exactly as composed', active === '', true, () => void this.select({ mode:'' }))}
        ${options.map(option => this.choice(modeLabel(option.name), option.description || '', active === option.name, true, () => void this.select({ mode:option.name })))}
        ${options.length ? nothing : html`<div class="notice">This bundle composes no modes.</div>`}
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      </div></details>`;
  }
  private choice(name: string, hint: string, selected: boolean, available: boolean, action: () => void) {
    return html`<button class="choice ${selected ? 'selected' : ''}" ?disabled=${!available || this.loading || this.turnBusy} @click=${action}><span class="choice-main"><span class="choice-name">${name}</span><span class="hint">${available ? hint : 'Unavailable for this harness'}</span></span>${selected ? html`<span class="check">✓</span>` : nothing}</button>`;
  }
  override render() {
    const s = this.settings;
    if (!s) return html`<span class="notice ${this.error ? 'error' : ''}">${this.error || 'Loading controls…'}</span>`;
    const model = s.models.find(item => item.id === s.model);
    const models = model ? s.models : s.model ? [{ id:s.model, label:s.model, efforts:[] }, ...s.models] : s.models;
    const efforts = model?.efforts || [];
    const effortIndex = Math.max(0, efforts.indexOf(s.effort || model?.defaultEffort || efforts[0]));
    const permission = s.permission || 'full-permission';
    const mode = s.mode || 'agent';
    return html`
      ${this.harness === 'amplifier' ? this.modePicker(s) : html`
      <details class="picker permission-picker" aria-label="Permission and mode"><summary><span class="summary-text">${permissionLabels[permission]} · ${mode === 'plan' ? 'Plan' : 'Agent'}</span></summary><div class="panel">
        <div class="heading">Permission</div>
        ${(['read-only','workspace-write','full-permission'] as const).map(value => this.choice(permissionLabels[value], permissionHints[value], permission === value, s.permissions.includes(value), () => void this.select({ permission:value, ...(this.harness === 'claude' ? { mode:value === 'read-only' ? 'plan' : 'agent' } : {}) })))}
        <div class="divider"></div><div class="heading">Mode</div>
        ${this.choice('Agent', 'Work with the selected permission', mode === 'agent', s.modes.includes('agent') && (this.harness !== 'claude' || permission !== 'read-only'), () => void this.select({ mode:'agent' }))}
        ${this.choice('Plan', 'Explore and prepare a plan', mode === 'plan', s.modes.includes('plan') && (this.harness !== 'claude' || permission === 'read-only'), () => void this.select({ mode:'plan' }))}
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      </div></details>`}
      <details class="picker model-picker" aria-label="Provider, model and thinking"><summary><span class="summary-text">${model?.label || s.model || this.harness}</span></summary><div class="panel">
        ${this.harness === 'amplifier' ? html`<div class="heading">Bundle</div>${(s.bundles || []).map(value => this.choice(value, '', s.bundle === value, true, () => void this.select({ bundle:value })))}<div class="divider"></div><div class="heading">Provider</div>${(s.providers || []).map(value => this.choice(providerLabel(value), '', s.provider === value, true, () => void this.select({ provider:value })))}` : html`<div class="heading">Provider</div><div class="notice">${this.harness === 'codex' ? 'OpenAI' : 'Anthropic'} · managed by ${this.harness}</div>`}
        <div class="divider"></div><div class="heading">Model</div>
        <div class="model-list">${models.length ? models.map(item => this.choice(item.label, item.id, s.model === item.id, true, () => void this.select({ model:item.id, effort:item.defaultEffort || '' }))) : html`<div class="notice">No models advertised by this harness.</div>`}</div>
        ${efforts.length > 1 ? html`<div class="divider"></div><div class="slider"><div class="slider-header"><span>Thinking</span><span>${efforts[effortIndex]}</span></div><input type="range" aria-label="Thinking effort" min="0" max=${efforts.length - 1} step="1" .value=${String(effortIndex)} ?disabled=${this.loading || this.turnBusy} @change=${(event: Event) => void this.select({ effort:efforts[Number((event.target as HTMLInputElement).value)] })}><div class="slider-ends"><span>${efforts[0]}</span><span>${efforts[efforts.length - 1]}</span></div></div>` : nothing}
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      </div></details>`;
  }
}
