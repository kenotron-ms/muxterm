import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';

const MAX_HTML_BYTES = 2 << 20;

// A srcdoc iframe has an opaque origin without allow-same-origin. The CSP also
// keeps generated HTML from reaching the app, local services, or arbitrary URLs.
const PREVIEW_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;

@customElement('mux-chat-visualization')
export class MuxChatVisualization extends LitElement {
  @property() path = '';
  @property() projectPath = '';
  @property() sessionId = '';
  @property() remoteHost = '';
  @property({ reflect: true }) mode = '';
  @state() private source = '';
  @state() private error = '';
  private request?: AbortController;

  static styles = css`
    :host { display:block; margin:var(--ui-space-6) 0 var(--ui-space-8); max-width:100%; }
    .card { overflow:hidden; border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); }
    .bar { display:flex; align-items:center; gap:var(--ui-space-4); padding:var(--ui-space-3) var(--ui-space-5); border-bottom:1px solid var(--ui-border); font:var(--ui-text-sm)/1.4 var(--ui-font-sans); }
    .title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    iframe { display:block; width:100%; height:26em; border:0; background:var(--ui-surface-base); }
    :host([mode="wide"]) iframe { height:33em; }
    .message { padding:var(--ui-space-6); color:var(--ui-text-muted); font:var(--ui-text-sm)/1.5 var(--ui-font-sans); }
  `;

  override connectedCallback() { super.connectedCallback(); if (this.hasUpdated) void this.load(); }
  override disconnectedCallback() { this.request?.abort(); super.disconnectedCallback(); }
  override willUpdate(changed: Map<string, unknown>) {
    if (this.isConnected && (changed.has('path') || changed.has('projectPath') || changed.has('sessionId') || changed.has('remoteHost'))) void this.load();
  }

  private relativePath(): string | null {
    const root = this.projectPath.replace(/\/+$/, '');
    const prefix = root ? `${root}/` : this.projectPath === '/' ? '/' : '';
    if (!prefix || !this.path.startsWith(prefix)) return null;
    const relative = this.path.slice(prefix.length);
    return relative && !relative.split('/').includes('..') && /\.html?$/i.test(relative) ? relative : null;
  }

  private async load() {
    this.request?.abort();
    this.source = '';
    this.error = '';
    const relative = this.relativePath();
    if (!relative || !this.sessionId) { this.error = 'This visualization is outside the chat project or is not an HTML file.'; return; }
    const request = new AbortController();
    this.request = request;
    const base = `/api/sdk-chats/${encodeURIComponent(this.sessionId)}/utility/raw`;
    const url = apiPath(remoteChatPath(this.remoteHost, base)) + `?${new URLSearchParams({ path: relative, max_bytes: String(MAX_HTML_BYTES) })}`;
    try {
      const response = await fetch(url, { signal: request.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 413 ? 'The HTML file is too large to preview.' : `File unavailable (${response.status}).`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_HTML_BYTES) throw new Error('The HTML file is too large to preview.');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // Keep the doctype first so generated layouts render in standards mode.
      const doctype = /^\s*<!doctype[^>]*>/i.exec(source)?.[0];
      if (!request.signal.aborted) this.source = doctype
        ? doctype + PREVIEW_CSP + source.slice(doctype.length)
        : '<!doctype html>' + PREVIEW_CSP + source;
    } catch (error) {
      if (!request.signal.aborted) this.error = error instanceof Error ? error.message : 'Could not load visualization.';
    }
  }

  override render() {
    const title = this.path.split('/').pop() || 'Visualization';
    return html`<div class="card"><div class="bar"><span class="title" title=${this.path}>${title}</span></div>
      ${this.source ? html`<iframe title=${title} sandbox="allow-scripts" .srcdoc=${this.source}></iframe>` : html`<div class="message">${this.error || 'Loading visualization…'}</div>`}
    </div>`;
  }
}
