import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';
import '../ui/choice-item.js';
import '../ui/choice-picker.js';
import type { MuxUIRangeField } from '../ui/range-field.js';
import '../ui/range-field.js';
import '../ui/switch.js';

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
  @property({ type:Boolean }) operator = false;
  @property({ type:Boolean }) turnBusy = false;
  @state() private settings?: Settings;
  @state() private loading = false;
  @state() private error = '';
  private requestVersion = 0;
  static styles = css`
    ${subtleScrollbars}
    :host { display:flex; align-items:center; flex:1; min-width:0; justify-content:space-between; gap:var(--ui-space-4); font:var(--ui-text-sm)/1.4 var(--ui-font-sans); }
    .picker { min-width:0; }
    .model-picker { margin-left:auto; }
    .heading { padding:var(--ui-space-4) var(--ui-space-5) var(--ui-space-3); color:var(--ui-text-muted); font-size:var(--ui-text-xs); font-weight:700; letter-spacing:.09em; text-transform:uppercase; }
    .divider { height:1px; margin:var(--ui-space-4) var(--ui-space-3); background:var(--ui-border); }
    .group { margin:var(--ui-space-1) var(--ui-space-2) var(--ui-space-4); }
    .model-list { max-height:190px; overflow-y:auto; }
    .notice { padding:var(--ui-space-4) var(--ui-space-5); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .error { color:var(--ui-danger-text); padding:var(--ui-space-4) var(--ui-space-5); overflow-wrap:anywhere; }
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
    } catch (error) { if (this.sessionId === sessionId && this.requestVersion === version) this.error = error instanceof Error ? error.message : String(error); }
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
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.loading = false; this.pending(false); }
  }
  private async toggleOperator() {
    if (this.loading || !this.sessionId) return;
    this.loading = true; this.error = '';
    try {
      const chat = await sdkChats.operator(this.sessionId, { enabled: !this.operator });
      this.dispatchEvent(new CustomEvent<SDKChat>('operator-changed', { detail:chat, bubbles:true, composed:true }));
    } catch (error) { this.error = String(error); }
    finally { this.loading = false; }
  }
  private operatorControl() {
    return html`<div class="divider"></div><div class="heading">Operator</div><mux-ui-switch layout="row" label="Operator mode" description="Coordinate other chats as lanes" .checked=${this.operator} ?disabled=${this.loading} @change=${() => void this.toggleOperator()}></mux-ui-switch>`;
  }
  /** Amplifier has no permission switch to offer -- its tool access comes from
   *  the composed bundle. What it does have, and nothing else exposed, is its
   *  own mode system, so that takes this slot. */
  private modePicker(s: Settings) {
    const active = s.mode || '';
    const options = s.modeOptions || [];
    return html`
      <mux-ui-choice-picker class="picker permission-picker" label="Amplifier mode and operator" .summary=${`${modeLabel(active)}${this.operator ? ' · Operator' : ''}`} placement="above" appearance="plain" panel-align="left">
        <div class="heading">Mode</div>
        ${this.choice('Default', 'No overlay — the bundle exactly as composed', active === '', true, () => void this.select({ mode:'' }))}
        ${options.map(option => this.choice(modeLabel(option.name), option.description || '', active === option.name, true, () => void this.select({ mode:option.name })))}
        ${options.length ? nothing : html`<div class="notice">This bundle composes no modes.</div>`}
        ${this.operatorControl()}
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      </mux-ui-choice-picker>`;
  }
  private choice(name: string, hint: string, selected: boolean, available: boolean, action: () => void) {
    return html`<mux-ui-choice-item .label=${name} .description=${available ? hint : 'Unavailable for this harness'} ?selected=${selected} ?disabled=${!available || this.loading || this.turnBusy} @click=${action}></mux-ui-choice-item>`;
  }
  override render() {
    const s = this.settings;
    if (!s) return html`<span class="notice ${this.error ? 'error' : ''}" role=${this.error ? 'alert' : 'status'}>${this.error || 'Loading controls…'}</span>`;
    const model = s.models.find(item => item.id === s.model);
    const models = model ? s.models : s.model ? [{ id:s.model, label:s.model, efforts:[] }, ...s.models] : s.models;
    const efforts = model?.efforts || [];
    const effortIndex = Math.max(0, efforts.indexOf(s.effort || model?.defaultEffort || efforts[0]));
    const permission = s.permission || 'full-permission';
    const mode = s.mode || 'agent';
    return html`
      ${this.harness === 'amplifier' ? this.modePicker(s) : html`
      <mux-ui-choice-picker class="picker permission-picker" label="Permission, mode and operator" .summary=${`${permissionLabels[permission]} · ${mode === 'plan' ? 'Plan' : 'Agent'}${this.operator ? ' · Operator' : ''}`} placement="above" appearance="plain" panel-align="left">
        <div class="heading">Permission</div>
        ${(['read-only','workspace-write','full-permission'] as const).map(value => this.choice(permissionLabels[value], permissionHints[value], permission === value, s.permissions.includes(value), () => void this.select({ permission:value, ...(this.harness === 'claude' ? { mode:value === 'read-only' ? 'plan' : 'agent' } : {}) })))}
        <div class="divider"></div><div class="heading">Mode</div>
        ${this.choice('Agent', 'Work with the selected permission', mode === 'agent', s.modes.includes('agent') && (this.harness !== 'claude' || permission !== 'read-only'), () => void this.select({ mode:'agent' }))}
        ${this.choice('Plan', 'Explore and prepare a plan', mode === 'plan', s.modes.includes('plan') && (this.harness !== 'claude' || permission === 'read-only'), () => void this.select({ mode:'plan' }))}
        ${this.operatorControl()}
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      </mux-ui-choice-picker>`}
      <mux-ui-choice-picker class="picker model-picker" label="Provider, model and thinking" .summary=${model?.label || s.model || this.harness} placement="above" appearance="plain" panel-align="right">
        ${this.harness === 'amplifier' ? html`<div class="heading">Bundle</div>${(s.bundles || []).map(value => this.choice(value, '', s.bundle === value, true, () => void this.select({ bundle:value })))}<div class="divider"></div><div class="heading">Provider</div>${(s.providers || []).map(value => this.choice(providerLabel(value), '', s.provider === value, true, () => void this.select({ provider:value })))}` : html`<div class="heading">Provider</div><div class="notice">${this.harness === 'codex' ? 'OpenAI' : this.harness === 'claude' ? 'Anthropic' : 'Configured in agent'} · managed by ${this.harness}</div>`}
        <div class="divider"></div><div class="heading">Model</div>
        <div class="model-list">${models.length ? models.map(item => this.choice(item.label, item.id, s.model === item.id, true, () => void this.select({ model:item.id, effort:item.defaultEffort || '' }))) : html`<div class="notice">No models advertised by this harness.</div>`}</div>
        ${efforts.length > 1 ? html`<div class="divider"></div><mux-ui-range-field label="Thinking" accessible-label="Thinking effort" .min=${0} .max=${efforts.length - 1} .value=${effortIndex} .valueLabels=${efforts} .minLabel=${efforts[0]} .maxLabel=${efforts[efforts.length - 1]} ?disabled=${this.loading || this.turnBusy} @change=${(event:Event) => void this.select({ effort:efforts[(event.target as MuxUIRangeField).value] })}></mux-ui-range-field>` : nothing}
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      </mux-ui-choice-picker>`;
  }
}
