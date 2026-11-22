import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { sdkHarnessLabel, type SDKChat, type SDKHarnessName } from '../lib/sdk-chats.js';
import type { MuxUIRangeField } from '../ui/range-field.js';
import '../ui/choice-item.js';
import '../ui/choice-list.js';
import '../ui/choice-picker.js';
import '../ui/choice-section.js';
import '../ui/feedback.js';
import '../ui/range-field.js';

export type SideChatSelection = { harness: SDKHarnessName; provider: string; bundle: string; model: string; effort: string };
type StartOption = { harness: SDKHarnessName; provider: string };
type ModelOption = { id: string; label: string; efforts: string[]; defaultEffort?: string };
type Catalog = { model: string; effort: string; defaultModel?: string; models: ModelOption[]; bundle?: string; provider?: string; bundles?: string[]; providers?: string[] };
const storageKey = (parentId: string, tabId: string) => `muxterm-side-chat-selection:v1:${parentId}:${tabId}`;
const providerLabel = (value: string) => ({ 'provider-openai':'OpenAI', 'provider-anthropic':'Anthropic' })[value] || value.replace(/^provider-/, '');

@customElement('mux-side-chat-start-settings')
export class MuxSideChatStartSettings extends LitElement {
  @property() parentId = '';
  @property() remoteHost = '';
  @property() tabId = '';
  @state() private options: StartOption[] = [];
  @state() private catalog?: Catalog;
  @state() private selection?: SideChatSelection;
  @state() private loading = true;
  @state() private error = '';
  private requestVersion = 0;
  private loadedKey = '';
  private parent?: SDKChat;

  static styles = css`
    :host { display:flex; flex:1 1 auto; min-width:0; align-items:center; flex-wrap:wrap; gap:var(--ui-space-1); font:var(--ui-text-sm)/1.4 var(--ui-font-sans); }
    .picker { min-width:0; max-width:100%; }
    .agent-picker { flex:0 1 auto; }
    .model-picker { flex:1 1 145px; }
    .picker::part(summary) { min-height:var(--ui-control-md); padding:0 var(--ui-space-3); }
    .error { flex:1 1 100%; }
    @media(pointer:coarse) { .picker::part(summary) { min-height:var(--ui-control-lg); } }
    @media(max-width:390px) { .model-picker { flex-basis:100%; } }
  `;

  override connectedCallback() { super.connectedCallback(); void this.load(); }
  override updated(changed: Map<string, unknown>) {
    if ((changed.has('parentId') || changed.has('remoteHost') || changed.has('tabId')) && this.loadedKey !== `${this.remoteHost}:${this.parentId}:${this.tabId}`) void this.load();
  }
  override disconnectedCallback() { this.requestVersion++; super.disconnectedCallback(); }
  private announce(selection: SideChatSelection | null) {
    this.dispatchEvent(new CustomEvent<SideChatSelection | null>('side-start-selection', { detail:selection, bubbles:true, composed:true }));
  }
  private savedSelection(): SideChatSelection | undefined {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey(this.parentId, this.tabId)) || 'null') as SideChatSelection | null;
      return value && typeof value.harness === 'string' && typeof value.provider === 'string' && typeof value.model === 'string' && typeof value.effort === 'string' ? value : undefined;
    } catch { return undefined; }
  }
  private persist(selection: SideChatSelection) {
    try { localStorage.setItem(storageKey(this.parentId, this.tabId), JSON.stringify(selection)); } catch { /* Selection remains in memory. */ }
  }
  private async load() {
    if (!this.isConnected || !this.parentId || !this.tabId) return;
    const key = `${this.remoteHost}:${this.parentId}:${this.tabId}`;
    if (this.loadedKey === key) return;
    this.loadedKey = key;
    const version = ++this.requestVersion;
    this.loading = true; this.error = ''; this.announce(null);
    try {
      const [parentResponse, optionsResponse] = await Promise.all([
        fetch(apiPath(remoteChatPath(this.remoteHost, `/api/sdk-chats/${encodeURIComponent(this.parentId)}`))),
        fetch(apiPath(remoteChatPath(this.remoteHost, '/api/sdk-chat-start-options'))),
      ]);
      if (!parentResponse.ok) throw new Error((await parentResponse.text()).trim() || 'Main chat unavailable');
      if (!optionsResponse.ok) throw new Error((await optionsResponse.text()).trim() || 'Available agents could not be loaded');
      const parent = await parentResponse.json() as SDKChat;
      const options = await optionsResponse.json() as StartOption[];
      if (!this.isConnected || version !== this.requestVersion) return;
      if (!options.length) throw new Error('No supported agents are available on this host');
      this.parent = parent;
      this.options = options;
      const saved = this.savedSelection();
      const choice = options.find(option => option.harness === saved?.harness && option.provider === saved.provider)
        || options.find(option => option.harness === parent.harness && option.provider === parent.provider)
        || options[0];
      await this.loadCatalog({ harness:choice.harness, provider:choice.provider, bundle:saved?.harness === choice.harness && saved.provider === choice.provider ? saved.bundle : parent.harness === choice.harness ? parent.bundle || '' : '', model:saved?.harness === choice.harness && saved.provider === choice.provider ? saved.model : parent.harness === choice.harness ? parent.model || '' : '', effort:saved?.harness === choice.harness && saved.provider === choice.provider ? saved.effort : parent.harness === choice.harness ? parent.effort || '' : '' }, version);
    } catch (error) {
      if (this.isConnected && version === this.requestVersion) { this.error = error instanceof Error ? error.message : String(error); this.loading = false; this.announce(null); }
    }
  }
  private async loadCatalog(requested: SideChatSelection, version = ++this.requestVersion) {
    this.loading = true; this.error = ''; this.announce(null);
    try {
      const params = new URLSearchParams({ harness:requested.harness, projectPath:this.parent?.projectPath || '', bundle:requested.bundle, provider:requested.harness === 'amplifier' ? requested.provider === 'configured' ? '' : requested.provider : '' });
      const response = await fetch(apiPath(remoteChatPath(this.remoteHost, `/api/sdk-chat-catalog?${params}`)));
      if (!response.ok) throw new Error((await response.text()).trim() || 'Model catalog unavailable');
      const catalog = await response.json() as Catalog;
      if (!this.isConnected || version !== this.requestVersion) return;
      const bundle = requested.harness === 'amplifier' && catalog.bundles?.includes(requested.bundle) ? requested.bundle : catalog.bundle || '';
      const provider = requested.harness === 'amplifier' && catalog.providers?.includes(requested.provider) ? requested.provider : requested.harness === 'amplifier' ? catalog.provider || requested.provider : requested.provider;
      const candidate = catalog.models.find(item => item.id === requested.model);
      const model = candidate ? requested.model : catalog.model || catalog.defaultModel || '';
      const modelOption = catalog.models.find(item => item.id === model);
      const efforts = modelOption?.efforts || [];
      const effort = efforts.includes(requested.effort) ? requested.effort : modelOption?.defaultEffort || (efforts.includes(catalog.effort) ? catalog.effort : efforts[0] || '');
      this.catalog = catalog;
      this.selection = { harness:requested.harness, provider, bundle, model, effort };
      this.persist(this.selection);
      this.announce(this.selection);
      this.loading = false;
    } catch (error) {
      if (this.isConnected && version === this.requestVersion) { this.error = error instanceof Error ? error.message : String(error); this.loading = false; this.announce(null); }
    }
  }
  private chooseModel(item: ModelOption) {
    if (!this.selection) return;
    const effort = item.efforts.includes(this.selection.effort) ? this.selection.effort : item.defaultEffort || item.efforts[0] || '';
    this.selection = { ...this.selection, model:item.id, effort };
    this.persist(this.selection); this.announce(this.selection);
  }
  private chooseEffort(effort: string) {
    if (!this.selection) return;
    this.selection = { ...this.selection, effort };
    this.persist(this.selection); this.announce(this.selection);
  }
  override render() {
    const selection = this.selection;
    const catalog = this.catalog;
    if (!selection || !catalog) return html`<mux-ui-feedback class="error" kind=${this.error ? 'error' : 'loading'} density="compact">${this.error || 'Loading agents and models…'}</mux-ui-feedback>`;
    const selectedModel = catalog.models.find(item => item.id === selection.model);
    const efforts = selectedModel?.efforts || [];
    const effortIndex = Math.max(0, efforts.indexOf(selection.effort));
    return html`
      <mux-ui-choice-picker class="picker agent-picker" label="Side chat agent" .summary=${sdkHarnessLabel(selection.harness)} placement="above" appearance="plain" panel-align="left">
        <mux-ui-choice-section heading="Available agents"><mux-ui-choice-list>
          ${this.options.map(option => html`<mux-ui-choice-item .label=${sdkHarnessLabel(option.harness)} .description=${option.provider} ?selected=${selection.harness === option.harness && selection.provider === option.provider} ?disabled=${this.loading} @click=${() => void this.loadCatalog({ harness:option.harness, provider:option.provider, bundle:'', model:'', effort:'' })}></mux-ui-choice-item>`)}
        </mux-ui-choice-list></mux-ui-choice-section>
      </mux-ui-choice-picker>
      <mux-ui-choice-picker class="picker model-picker" label="Side chat model and thinking" .summary=${`${selectedModel?.label || selection.model || catalog.defaultModel || 'Default'}${selection.effort ? ` · ${selection.effort}` : ''}`} placement="above" appearance="plain" panel-align="right">
        <mux-ui-choice-section heading="Provider" .description=${selection.harness === 'amplifier' ? '' : providerLabel(selection.provider)}>
          ${selection.harness === 'amplifier' ? (catalog.providers || []).map(provider => html`<mux-ui-choice-item .label=${providerLabel(provider)} ?selected=${selection.provider === provider} ?disabled=${this.loading} @click=${() => void this.loadCatalog({ ...selection, provider, model:'', effort:'' })}></mux-ui-choice-item>`) : nothing}
        </mux-ui-choice-section>
        ${selection.harness === 'amplifier' ? html`<mux-ui-choice-section heading="Bundle" separated>${(catalog.bundles || []).map(bundle => html`<mux-ui-choice-item .label=${bundle} ?selected=${selection.bundle === bundle} ?disabled=${this.loading} @click=${() => void this.loadCatalog({ ...selection, bundle, model:'', effort:'' })}></mux-ui-choice-item>`)}</mux-ui-choice-section>` : nothing}
        <mux-ui-choice-section heading="Model" separated><mux-ui-choice-list>
          ${catalog.models.map(item => html`<mux-ui-choice-item .label=${item.label} .description=${item.id} ?selected=${selection.model === item.id} ?disabled=${this.loading} @click=${() => this.chooseModel(item)}></mux-ui-choice-item>`)}
        </mux-ui-choice-list></mux-ui-choice-section>
        ${efforts.length > 1 ? html`<mux-ui-choice-section heading="Thinking" separated><mux-ui-range-field label="Thinking" accessible-label="Side chat thinking effort" .min=${0} .max=${efforts.length - 1} .value=${effortIndex} .valueLabels=${efforts} .minLabel=${efforts[0]} .maxLabel=${efforts[efforts.length - 1]} ?disabled=${this.loading} @input=${(event:Event) => this.chooseEffort(efforts[(event.target as MuxUIRangeField).value])}></mux-ui-range-field></mux-ui-choice-section>` : nothing}
        ${this.error ? html`<mux-ui-feedback kind="error" density="compact">${this.error}</mux-ui-feedback>` : nothing}
      </mux-ui-choice-picker>
    `;
  }
}
