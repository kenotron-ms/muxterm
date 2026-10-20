import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';

type BrowserConnection = { id: string; name: string; lastSeen: string; control?: { origin: string; managed: boolean } };
type BrowserRequest = { id: string; status: string; snapshot?: unknown; result?: unknown; error?: string };

@customElement('mux-browser-assistant')
export class MuxBrowserAssistant extends LitElement {
  @state() private items: BrowserConnection[] = [];
  @state() private pairing?: { code: string; expiresAt: string };
  @state() private result?: BrowserRequest;
  @state() private error = '';
  @state() private busy = false;
  private timer?: number;

  static override styles = css`
    :host { display: block; font: inherit; color: var(--chrome-text-bright); }
    h2 { font-size: 20px; margin: 0 0 10px; } h3 { font-size: 13px; margin: 20px 0 8px; }
    p { line-height: 1.6; color: var(--chrome-text-dim); } code, pre { overflow-wrap: anywhere; white-space: pre-wrap; }
    button { font: inherit; cursor: pointer; padding: 8px 12px; border: 1px solid var(--chrome-border); border-radius: 6px; background: var(--chrome-hover); color: var(--chrome-text-bright); }
    button:disabled { opacity: .5; cursor: wait; } .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .connection { padding: 14px 0; border-bottom: 1px solid var(--chrome-border); } .error { color: var(--chrome-danger); }
    .code { display: block; user-select: all; padding: 12px; background: var(--chrome-bar); border: 1px solid var(--chrome-border); }
  `;

  override connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.timer = window.setInterval(() => { if (!this.busy) void this.refresh(); }, 3000);
  }
  override disconnectedCallback() { super.disconnectedCallback(); window.clearInterval(this.timer); delete document.body.dataset.muxtermBrowserPairing; }

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(apiPath(`/api/browser-assistant${path}`), {
      method, headers: { 'Content-Type': 'application/json', 'X-Muxterm-Browser-Request': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error((await response.text()).trim());
    return response.json() as Promise<T>;
  }
  private async refresh() {
    try {
      const items = (await this.request<{ items: BrowserConnection[] }>('/connections')).items;
      if (items.length > this.items.length) { this.pairing = undefined; delete document.body.dataset.muxtermBrowserPairing; }
      this.items = items;
      if (this.result?.status === 'pending' || this.result?.status === 'running') this.result = await this.request<BrowserRequest>(`/requests/${this.result.id}`);
    } catch (error) { this.error = String(error); }
  }
  private async run(action: () => Promise<void>) {
    this.busy = true; this.error = '';
    try { await action(); await this.refresh(); } catch (error) { this.error = String(error); }
    finally { this.busy = false; }
  }
  override render() {
    return html`<h2>Browser Assistant</h2>
      <p>Connect your browser, then turn on Browser access in the extension. Agents can navigate and interact with the current browser window. Other windows stay outside their control. This window shares your Chrome profile’s sign-ins and site permissions; use a separate profile for stronger separation. Pairing alone grants no control.</p>
      <h3>Load the development extension</h3>
      <p><a href="https://github.com/kenotron-ms/muxterm/releases/latest/download/muxterm-browser-assistant-dev.zip" target="_blank" rel="noopener noreferrer">Download the development extension</a> from GitHub Releases and extract it. On your laptop, open <code>chrome://extensions</code>, enable Developer mode, choose Load unpacked, and select the extracted <code>browser-assistant</code> folder. Pin Browser Assistant to the toolbar.</p>
      <p>Use HTTPS for remote pairing. LAN HTTP requires an explicit development opt-in. Access has no timer; browser restarts pause it. This prototype’s pairings do not survive a Muxterm server restart.</p>
      <button ?disabled=${this.busy} @click=${() => void this.run(async () => {
        this.pairing = await this.request('/pairings', 'POST');
        document.body.dataset.muxtermBrowserPairing = JSON.stringify({ base: new URL('.', document.baseURI).href, code: this.pairing?.code });
      })}>Connect browser</button>
      ${this.pairing ? html`<p>Click Browser Assistant in your browser toolbar, then choose Connect. No address or code to paste.</p>
        <details><summary>Manual pairing fallback</summary><p>Instance: <code>${new URL('.', document.baseURI).href}</code></p><code class="code">${this.pairing.code}</code></details>
        <p>This connection request expires ${new Date(this.pairing.expiresAt).toLocaleTimeString()}. Keep it private.</p>` : nothing}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      <h3>Paired browsers</h3>
      ${this.items.length ? this.items.map(item => html`<div class="connection"><strong>${item.name}</strong>
        <p>Last contact ${new Date(item.lastSeen).toLocaleTimeString()}</p>
        <p>${item.control ? item.control.managed ? 'Connected · this browser window is shared' : `Connected · ${item.control.origin}` : 'Connected · Browser access paused'}</p>
        <div class="actions"><button ?disabled=${this.busy || !item.control} @click=${() => void this.run(async () => { this.result = await this.request(`/connections/${item.id}/commands`, 'POST', {reason: 'Verify real browser automation from Connections', command: {action: 'inspect'}}); })}>Inspect controlled tab</button>
        <button ?disabled=${this.busy || !item.control} @click=${() => void this.run(async () => { await this.request(`/connections/${item.id}/control`, 'DELETE'); })}>Stop control</button>
        <button ?disabled=${this.busy} @click=${() => void this.run(async () => { await this.request(`/connections/${item.id}`, 'DELETE'); this.result = undefined; })}>Revoke browser</button></div></div>`) : html`<p>No browsers paired. Create a code and enter it in your local extension.</p>`}
      ${this.result ? html`<h3>Latest request: ${this.result.status}</h3>
        ${this.result.snapshot || this.result.result ? html`<pre>${JSON.stringify(this.result.snapshot || this.result.result, null, 2)}</pre>` : nothing}
        ${this.result.error ? html`<p class="error">${this.result.error}</p>` : nothing}` : nothing}
      <p>Agent tools: <code>browser_action</code>, <code>get_browser_action</code>, and <code>stop_browser_control</code>. Agents can open and switch tabs inside the shared window. “Control this tab” limits navigation to that site. All agents on the current shared-owner instance share access. No arbitrary agent scripts are accepted.</p>`;
  }
}
