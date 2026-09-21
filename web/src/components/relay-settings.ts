import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';

type RelayStatus = { url: string; host: string; displayName: string; configured: boolean; available: boolean; detail?: string };

@customElement('mux-relay-settings')
export class RelaySettings extends LitElement {
  static override styles = css`
    :host { display: block; margin-bottom: 28px; color: var(--chrome-text); }
    h3 { font-size: 14px; color: var(--chrome-text-bright); margin: 0 0 10px; }
    p { font-size: 12px; line-height: 1.6; color: var(--chrome-text-muted); }
    form { display: grid; gap: 12px; }
    label { display: grid; gap: 5px; font-size: 12px; }
    input { box-sizing: border-box; width: 100%; padding: 8px 10px; border-radius: 5px;
      border: 1px solid var(--chrome-border); background: var(--chrome-bg); color: var(--chrome-text-bright); font: inherit; }
    input:focus-visible, button:focus-visible { outline: 2px solid var(--chrome-accent, #a78bfa); outline-offset: 2px; }
    .actions { display: flex; gap: 8px; }
    button { padding: 7px 12px; border: 1px solid var(--chrome-border); border-radius: 5px;
      background: var(--chrome-bg); color: var(--chrome-text-bright); cursor: pointer; font: inherit; font-size: 12px; }
    button:disabled { opacity: .5; cursor: default; }
    .message { font-size: 12px; line-height: 1.5; margin-top: 10px; }
  `;
  @state() private _status: RelayStatus | null = null;
  @state() private _url = '';
  @state() private _id = '';
  @state() private _name = '';
  @state() private _token = '';
  @state() private _busy = false;
  @state() private _message = '';
  override connectedCallback(): void { super.connectedCallback(); void this._load(); }
  override disconnectedCallback(): void { this._token = ''; super.disconnectedCallback(); }
  private async _request(method = 'GET', body?: unknown): Promise<RelayStatus> {
    const options: RequestInit = { method, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(apiPath('/api/relay'), options);
    if (!response.ok) throw new Error((await response.text()).trim() || 'Relay settings are unavailable.');
    return response.json() as Promise<RelayStatus>;
  }
  private _apply(status: RelayStatus): void {
    this._status = status; this._url = status.url; this._id = status.host.replace(/^sandbox:/, ''); this._name = status.displayName;
  }
  private async _load(): Promise<void> {
    try { this._apply(await this._request()); }
    catch (error) { this._message = error instanceof Error ? error.message : 'Could not load relay settings.'; }
  }
  private async _save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this._busy || !this._status?.available) return;
    this._busy = true; this._message = '';
    try {
      this._apply(await this._request('PUT', { url: this._url.trim(), host: `sandbox:${this._id.trim().replace(/^sandbox:/, '')}`, displayName: this._name.trim(), token: this._token }));
      this._token = ''; this._message = 'Broker verified. Connection saved and added to the sidebar.';
    } catch (error) { this._message = error instanceof Error ? error.message : 'Could not save relay connection.'; }
    finally { this._busy = false; }
  }
  private async _disconnect(): Promise<void> {
    if (this._busy || !this._status?.available) return;
    this._busy = true;
    try { this._apply(await this._request('DELETE')); this._token = ''; this._message = 'Local connection removed. The sandbox was not deleted.'; }
    catch (error) { this._message = error instanceof Error ? error.message : 'Could not remove relay connection.'; }
    finally { this._busy = false; }
  }
  override render() {
    const disabled = this._busy || !this._status?.available;
    return html`
      <h3>Sandbox relay</h3>
      <p>Connect to a running sandbox through its HTTPS broker. Provision the sandbox and enroll its worker before connecting.</p>
      ${this._status?.detail ? html`<p role="note">${this._status.detail}</p>` : ''}
      <form @submit=${(event: SubmitEvent) => void this._save(event)}>
        <label>Broker URL<input type="url" required placeholder="https://broker.example" .value=${this._url} ?disabled=${disabled}
          @input=${(e: Event) => { this._url = (e.target as HTMLInputElement).value; }}></label>
        <label>Sandbox ID<input required placeholder="Sandbox ID from your broker" .value=${this._id} ?disabled=${disabled}
          @input=${(e: Event) => { this._id = (e.target as HTMLInputElement).value; }}></label>
        <label>Display name<input maxlength="100" placeholder="My sandbox" .value=${this._name} ?disabled=${disabled}
          @input=${(e: Event) => { this._name = (e.target as HTMLInputElement).value; }}></label>
        <label>Entra access token<input type="password" autocomplete="off" spellcheck="false" .value=${this._token} ?disabled=${disabled}
          placeholder=${this._status?.configured ? 'Leave blank to keep the token for this broker and sandbox' : 'Paste your broker access token'}
          @input=${(e: Event) => { this._token = (e.target as HTMLInputElement).value; }}></label>
        <p>The token is stored privately on this machine and is never returned to the browser. To renew it, paste a new token and save.
          Changing the broker or sandbox requires a new token. Worker enrollment expires after one hour and is renewed separately.</p>
        <div class="actions">
          <button type="submit" ?disabled=${disabled}>${this._busy ? 'Checking…' : 'Save and connect'}</button>
          ${this._status?.configured ? html`<button type="button" ?disabled=${disabled} @click=${() => void this._disconnect()}>Disconnect relay</button>` : ''}
        </div>
      </form>
      ${this._message ? html`<div class="message" role="status">${this._message}</div>` : ''}
    `;
  }
}
