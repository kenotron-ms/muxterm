import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';

type Provider = { id: string; source: string; envName: string; configured: boolean; credentialAvailable: boolean; model: string };
type Connection = { id: string; module: string };
type Setup = { cliInstalled: boolean; setupSupported?: boolean; primary: string; providers: Provider[]; order: Connection[]; githubCliAvailable?: boolean; isolatedProfile?: boolean; error?: string };

const choices = [
  { id: 'github-copilot', name: 'GitHub Copilot', detail: 'Copilot subscription · GitHub sign-in or token' },
  { id: 'anthropic', name: 'Anthropic', detail: 'Claude models · Anthropic API key' },
  { id: 'openai', name: 'OpenAI', detail: 'GPT models · OpenAI API key' },
  { id: 'gemini', name: 'Google Gemini', detail: 'Gemini models · Google API key' },
];
const otherProviders = [
  'ChatGPT Subscription', 'OpenAI Compatible API', 'Azure OpenAI', 'Ollama', 'vLLM',
];

@customElement('mux-ai-providers')
export class MuxAIProviders extends LitElement {
  @property({ type: Boolean }) firstRun = false;
  @state() private setup?: Setup;
  @state() private selected = 'github-copilot';
  @state() private credentialSource: 'environment' | 'private-key' | 'github-cli' = 'private-key';
  @state() private apiKey = '';
  @state() private model = '';
  @state() private busy = '';
  @state() private message = '';
  @state() private connected = '';

  static styles = css`
    :host { display:block; container-type:inline-size; color:var(--chrome-text-bright); font:13px/1.5 system-ui,sans-serif; }
    .layout { display:grid; grid-template-columns:minmax(185px, .72fr) minmax(285px, 1.28fr); gap:24px; }
    .choices { display:flex; flex-direction:column; border-top:1px solid var(--chrome-border); }
    .choice { display:grid; gap:2px; width:100%; padding:14px 14px; border:0; border-bottom:1px solid var(--chrome-border); border-left:3px solid transparent; background:transparent; color:inherit; text-align:left; cursor:pointer; }
    .choice:hover { background:var(--chrome-hover); }
    .choice[aria-pressed="true"] { border-left-color:var(--chrome-accent); background:color-mix(in srgb,var(--chrome-accent) 8%,var(--chrome-body)); }
    .choice b { font-size:14px; }
    .choice small,.muted { color:var(--chrome-text-dim); }
    .choice em { font-size:11px; font-style:normal; color:var(--chrome-accent); }
    .editor { padding:23px; border:1px solid var(--chrome-border); border-radius:12px; background:var(--chrome-bar); }
    h2 { margin:0 0 4px; font-size:21px; letter-spacing:-.025em; }
    p { margin:0 0 18px; }
    .field { display:grid; gap:6px; margin:14px 0; }
    .field > span { font-size:12px; font-weight:650; }
    input:not([type=radio]) { box-sizing:border-box; width:100%; min-height:37px; padding:8px 10px; border:1px solid var(--chrome-border); border-radius:7px; background:var(--chrome-body); color:var(--chrome-text-bright); font:inherit; }
    .radio { display:flex; gap:10px; align-items:center; margin:9px 0; cursor:pointer; }
    .radio input { accent-color:var(--chrome-accent); }
    .actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:18px; }
    button.action { min-height:34px; padding:6px 13px; border:1px solid var(--chrome-border); border-radius:7px; background:var(--chrome-body); color:var(--chrome-text-bright); font:inherit; cursor:pointer; }
    button.primary { border-color:var(--chrome-accent); background:var(--chrome-accent); color:var(--chrome-body); font-weight:650; }
    button:disabled { opacity:.5; cursor:default; }
    .message { margin:15px 0 0; color:var(--mux-error); }
    .success { margin:15px 0 0; color:var(--chrome-accent); }
    .footnote { margin:18px 0 0; font-size:11px; color:var(--chrome-text-dim); }
    .profile-notice { margin:0 0 17px; padding:10px 13px; border:1px solid var(--chrome-border); border-radius:8px; background:var(--chrome-bar); color:var(--chrome-text-dim); }
    .order { margin:0 0 20px; padding:16px 18px; border:1px solid var(--chrome-border); border-radius:10px; background:var(--chrome-bar); }
    .order h3 { margin:0 0 4px; font-size:15px; }
    .order p { margin:0 0 10px; color:var(--chrome-text-dim); }
    .order-row { display:flex; align-items:center; gap:8px; padding:7px 0; border-top:1px solid var(--chrome-border); }
    .order-row span { flex:1; min-width:0; }
    .order-row b { color:var(--chrome-accent); margin-right:7px; }
    .order-row button { min-width:30px; min-height:30px; border:1px solid var(--chrome-border); border-radius:6px; background:var(--chrome-body); color:var(--chrome-text-bright); cursor:pointer; }
    .order-row button:disabled { opacity:.4; cursor:default; }
    @container (max-width:600px) { .layout { grid-template-columns:minmax(0,1fr); gap:16px; } .choices { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); } .choice { padding:9px 7px; } .choice b { font-size:12px; } .choice small { display:none; } .editor { padding:18px; } }
    @media(max-width:650px) { .layout { grid-template-columns:1fr; gap:16px; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    void this.refresh();
  }

  private emitReady() {
    this.dispatchEvent(new CustomEvent('provider-ready', {
      detail: { ready: this.connected !== '' && this.setup?.primary === this.connected },
      bubbles: true, composed: true,
    }));
  }

  private async refresh() {
    try {
      const response = await fetch(apiPath('/api/amplifier-provider-setup'), { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not read Amplifier provider settings.');
      const initial = this.setup === undefined;
      this.setup = await response.json() as Setup;
      if (this.setup?.error) this.message = this.setup.error;
      if (initial && choices.some(choice => choice.id === this.setup?.primary)) this.selected = this.setup!.primary;
      const current = this.setup?.providers.find(provider => provider.id === this.selected);
      if (current?.source && !this.apiKey) this.credentialSource = 'environment';
      else if (initial && this.selected === 'github-copilot' && this.setup?.githubCliAvailable) this.credentialSource = 'github-cli';
      this.model = current?.model || '';
      this.emitReady();
    } catch (error) { this.message = error instanceof Error ? error.message : String(error); }
  }

  private select(id: string) {
    this.selected = id;
    this.apiKey = '';
    this.connected = '';
    this.message = '';
    const current = this.setup?.providers.find(provider => provider.id === id);
    this.credentialSource = current?.source === 'environment' || current?.source === 'amplifier-keys' ? 'environment' : id === 'github-copilot' && this.setup?.githubCliAvailable ? 'github-cli' : 'private-key';
    this.model = current?.model || '';
    this.emitReady();
  }

  private async save() {
    if (this.busy) return;
    this.busy = 'save';
    this.message = '';
    this.connected = '';
    try {
      const response = await fetch(apiPath('/api/amplifier-provider-setup/save'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: this.selected, credentialSource: this.credentialSource,
          apiKey: this.credentialSource === 'private-key' ? this.apiKey : '', model: this.model,
        }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || 'Could not save provider.');
      this.apiKey = '';
      this.setup = await response.json() as Setup;
      this.credentialSource = 'environment';
      await this.check();
    } catch (error) { this.message = error instanceof Error ? error.message : String(error); }
    finally { this.busy = ''; this.emitReady(); }
  }

  private async move(id: string, direction: -1 | 1) {
    const current = this.setup?.order.map(connection => connection.id) || [];
    const index = current.indexOf(id);
    if (index < 0 || index + direction < 0 || index + direction >= current.length || this.busy) return;
    const next = [...current];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    this.busy = 'reorder'; this.message = '';
    try {
      const response = await fetch(apiPath('/api/amplifier-provider-setup/reorder'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: next, expectedIds: current }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || 'Could not change provider order.');
      this.setup = await response.json() as Setup;
      this.message = 'Provider priority saved.';
      this.emitReady();
    } catch (error) { this.message = error instanceof Error ? error.message : String(error); await this.refresh(); }
    finally { this.busy = ''; }
  }

  private async install() {
    if (this.busy) return;
    this.busy = 'install';
    this.message = '';
    try {
      const response = await fetch(apiPath('/api/amplifier-provider-setup/install'), { method: 'POST' });
      if (!response.ok) throw new Error((await response.text()).trim() || 'Could not install Amplifier.');
      this.setup = await response.json() as Setup;
      this.message = '';
    } catch (error) { this.message = error instanceof Error ? error.message : String(error); }
    finally { this.busy = ''; }
  }

  private async check() {
    if (this.busy === 'check') return;
    this.busy = 'check';
    this.connected = '';
    this.message = '';
    try {
      const response = await fetch(apiPath('/api/amplifier-provider-setup/check'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: this.selected }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || 'Could not reach this provider.');
      const result = await response.json() as { ok: boolean; modelCount: number };
      if (!result.ok || result.modelCount < 1) throw new Error('No models were available.');
      this.connected = this.selected;
      this.message = `Connection checked. ${result.modelCount} models available.`;
      this.emitReady();
    } catch (error) { this.message = error instanceof Error ? error.message : String(error); }
    finally { this.busy = ''; this.emitReady(); }
  }

  override render() {
    const current = this.setup?.providers.find(provider => provider.id === this.selected);
    const choice = choices.find(item => item.id === this.selected)!;
    return html`${this.setup?.isolatedProfile ? html`<p class="profile-notice" role="note">This preview uses a separate Amplifier profile. Credentials in your normal ~/.amplifier/keys.env are not visible here. Your usual Muxterm installation can read that file without importing or displaying its keys.</p>` : nothing}
    ${this.setup?.order?.length ? html`<section class="order" aria-label="Provider priority"><h3>Provider priority</h3><p>Amplifier tries the first connection first when routing does not choose a provider. Model routing can select another connection.</p>${this.setup.order.map((connection, index) => html`<div class="order-row"><span>${index === 0 ? html`<b>First choice</b>` : html`<b>${index + 1}.</b>`}${choices.find(item => item.id === connection.id)?.name || connection.id}</span><button title=${`Move ${connection.id} up`} aria-label=${`Move ${connection.id} up`} ?disabled=${!!this.busy || index === 0} @click=${() => void this.move(connection.id, -1)}>↑</button><button title=${`Move ${connection.id} down`} aria-label=${`Move ${connection.id} down`} ?disabled=${!!this.busy || index === this.setup!.order.length - 1} @click=${() => void this.move(connection.id, 1)}>↓</button></div>`)}</section>` : nothing}<div class="layout">
      <div class="choices" role="group" aria-label="AI providers">${choices.map(item => {
        const found = this.setup?.providers.find(provider => provider.id === item.id);
        return html`<button class="choice" aria-pressed=${this.selected === item.id} @click=${() => this.select(item.id)}><b>${item.name}</b><small>${item.detail}</small><em>${this.setup?.primary === item.id ? 'First choice' : found?.configured ? found.credentialAvailable ? 'Configured' : 'Credential missing' : found?.source ? 'Key found' : 'Set up'}</em></button>`;
      })}</div>
      <section class="editor" aria-label=${`${choice.name} configuration`}>
        <h2>${choice.name}</h2><p class="muted">Connect Amplifier to your ${choice.name} account.</p>
        ${!this.setup ? html`<p role="status">Checking Amplifier…</p>` : !this.setup.cliInstalled || this.setup.setupSupported === false ? html`<p role="alert">${this.setup.cliInstalled ? 'This Amplifier installation predates graphical provider management. ' + (current?.source === 'amplifier-keys' ? `${current.envName} was found in Amplifier keys.env, and will remain there during the update.` : 'Your existing Amplifier credentials will remain in your profile during the update.') : this.setup.error || 'Install Amplifier to manage providers.'}</p><button class="action primary" ?disabled=${!!this.busy} @click=${() => void this.install()}>${this.busy === 'install' ? 'Preparing Amplifier…' : this.setup.cliInstalled ? 'Update Amplifier' : 'Install Amplifier'}</button>${this.message ? html`<p class="message" role="alert">${this.message}</p>` : nothing}` : html`
          <p class="muted">${this.setup.primary === this.selected ? 'This connection is first in your provider order.' : 'Saving this connection keeps the current provider order. Move it above to change priority.'}</p>
          <div class="field"><span>Credential</span>
            ${this.selected === 'github-copilot' && this.setup.githubCliAvailable ? html`<label class="radio"><input type="radio" name="credential" .checked=${this.credentialSource === 'github-cli'} @change=${() => { this.credentialSource = 'github-cli'; this.apiKey = ''; }}>Use GitHub CLI sign-in (token saved privately)</label>` : nothing}
            <label class="radio"><input type="radio" name="credential" .checked=${this.credentialSource === 'environment'} @change=${() => { this.credentialSource = 'environment'; this.apiKey = ''; }}>Use ${current?.envName} from the environment or Amplifier keys</label>
            <label class="radio"><input type="radio" name="credential" .checked=${this.credentialSource === 'private-key'} @change=${() => this.credentialSource = 'private-key'}>Enter a new ${this.selected === 'github-copilot' ? 'GitHub token' : 'API key'}</label>
          </div>
          ${this.credentialSource === 'private-key' ? html`<label class="field"><span>${this.selected === 'github-copilot' ? 'GitHub token' : 'API key'}</span><input type="password" autocomplete="new-password" .value=${this.apiKey} @input=${(event: Event) => this.apiKey = (event.target as HTMLInputElement).value}></label>` : this.credentialSource === 'github-cli' ? html`<p class="muted">Your GitHub CLI sign-in is available. Amplifier will save its token privately when you configure Copilot.</p>` : html`<p class="muted">${current?.source === 'amplifier-keys' ? `${current.envName} was found in Amplifier keys.env. The key stays on this computer.` : current?.source === 'environment' ? `${current.envName} was found in Muxterm's environment. The key stays on this computer.` : `${current?.envName} is not available in this profile. Enter a key to save it privately.`}</p>`}
          <label class="field"><span>Default model (optional)</span><input .value=${this.model} placeholder="Use Amplifier's model default" @input=${(event: Event) => this.model = (event.target as HTMLInputElement).value}></label>
          <div class="actions"><button class="action primary" ?disabled=${!!this.busy || (this.credentialSource === 'private-key' && !this.apiKey)} @click=${() => void this.save()}>${this.busy === 'save' ? 'Saving…' : current?.configured ? 'Save changes' : 'Configure'}</button><button class="action" ?disabled=${!!this.busy || !current?.configured} @click=${() => void this.check()}>${this.busy === 'check' ? 'Checking…' : 'Check connection'}</button><button class="action" ?disabled=${!!this.busy} @click=${() => void this.refresh()}>Refresh</button></div>
          ${this.message ? html`<p class=${this.connected === this.selected ? 'success' : 'message'} role=${this.connected === this.selected ? 'status' : 'alert'}>${this.message}</p>` : nothing}
          <p class="footnote">Settings are saved in Amplifier. A connection check contacts the provider to list available models. Amplifier also supports ${otherProviders.join(', ')}; their setup needs additional account or endpoint fields.</p>
        `}
      </section>
    </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ai-providers': MuxAIProviders } }
