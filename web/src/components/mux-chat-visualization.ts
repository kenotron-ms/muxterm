import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';

const MAX_HTML_BYTES = 2 << 20;

// Match the Visualize skill's static resource allowlist. The srcdoc iframe has
// an opaque origin because its sandbox deliberately omits allow-same-origin.
const RESOURCE_SOURCES = 'blob: data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://esm.sh https://fonts.bunny.net https://fonts.googleapis.com https://fonts.gstatic.com https://unpkg.com';
const WIDGET_SOURCE = 'https://persistent.oaistatic.com/plugins/visualize/';
const PREVIEW_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${RESOURCE_SOURCES} ${WIDGET_SOURCE}; style-src 'unsafe-inline' ${RESOURCE_SOURCES}; img-src ${RESOURCE_SOURCES}; font-src ${RESOURCE_SOURCES}; media-src ${RESOURCE_SOURCES}; worker-src blob:; connect-src blob: data:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">`;

const PREVIEW_STYLES = `
  :root {
    --card: color-mix(in srgb, var(--foreground) 5%, var(--background));
    --card-foreground: var(--foreground);
    --popover: var(--secondary);
    --popover-foreground: var(--foreground);
    --secondary-foreground: var(--foreground);
    --muted: color-mix(in srgb, var(--foreground) 10%, transparent);
    --accent: color-mix(in srgb, var(--primary) 15%, var(--background));
    --accent-foreground: var(--primary);
    --input: var(--border);
    --ring: var(--primary);
    --blue: light-dark(rgb(51 156 255), rgb(131 195 255));
    --orange: light-dark(rgb(226 85 7), rgb(251 106 34));
    --green: light-dark(rgb(0 162 64), rgb(64 201 119));
    --red: light-dark(rgb(224 46 42), rgb(255 103 100));
    --purple: light-dark(rgb(146 79 247), rgb(173 123 249));
    --yellow: light-dark(rgb(255 195 0), rgb(255 210 64));
    --viz-series-1: var(--primary);
    --viz-series-2: light-dark(rgb(243 136 59), rgb(245 154 86));
    --viz-series-3: light-dark(rgb(93 201 119), rgb(116 213 139));
    --viz-series-4: light-dark(rgb(235 119 177), rgb(240 143 192));
    --viz-series-5: light-dark(rgb(155 121 236), rgb(170 145 239));
    --viz-series-6: light-dark(rgb(58 185 177), rgb(90 203 194));
    --viz-bg: transparent;
    --viz-panel: var(--card);
    --viz-border: var(--border);
    --viz-text: var(--foreground);
    --viz-muted: var(--muted-foreground);
    --viz-accent: var(--primary);
    --viz-accent-text: var(--primary-foreground);
    --viz-accent-bg: var(--accent);
    --viz-warning: var(--destructive);
    --font-size-base: 16px;
    --font-sans: system-ui, -apple-system, 'Segoe UI', sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; color: var(--foreground); background: var(--background); font: 16px/1.5 var(--font-sans); }
  button, input, select, textarea { font: inherit; }
  button { cursor: pointer; }
  a { color: var(--primary); }
  h1, h2, h3, p { margin: 0; }
  h1, h2, h3, strong { font-weight: 500; }
  .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; color: var(--foreground); background: var(--secondary); }
  .btn-primary { border-color: var(--primary); color: var(--primary-foreground); background: var(--primary); }
  .btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .card { min-width: 0; padding: 12px; overflow: hidden; border-radius: 16px; color: var(--card-foreground); background: var(--card); }
  .widget { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; color: var(--foreground); background: var(--background); }
  .text-muted { color: var(--muted-foreground); }
  .tabular-nums { font-variant-numeric: tabular-nums; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
`;

function previewTheme(element: Element): string {
  const styles = getComputedStyle(element);
  const colors: Record<string, string> = {
    '--background': '--ui-surface-base',
    '--foreground': '--ui-text',
    '--primary': '--ui-accent',
    '--primary-foreground': '--ui-on-accent',
    '--secondary': '--ui-surface-raised',
    '--muted-foreground': '--ui-text-muted',
    '--destructive': '--ui-danger',
    '--border': '--ui-border',
  };
  const variables = Object.entries(colors).map(([name, token]) => {
    const value = styles.getPropertyValue(token).trim();
    return CSS.supports('color', value) ? `${name}:${value};` : '';
  }).join('');
  const scheme = getComputedStyle(document.documentElement).colorScheme === 'light' ? 'light' : 'dark';
  return `:root{color-scheme:${scheme};${variables}}`;
}

function previewDocument(source: string, theme: string): string {
  const themeBridge = `<script>window.addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='muxterm.visualization.theme'&&typeof event.data.css==='string')document.getElementById('muxterm-visualization-theme').textContent=event.data.css});document.addEventListener('DOMContentLoaded',()=>{const report=()=>parent.postMessage({type:'muxterm.visualization.height',height:document.body.scrollHeight},'*');new ResizeObserver(report).observe(document.body);report()})</script>`;
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">${PREVIEW_CSP}<style id="muxterm-visualization-theme">${theme}</style><style>${PREVIEW_STYLES}</style>${themeBridge}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(source)?.[0];
  if (doctype) return doctype + head + source.slice(doctype.length);
  if (/^\s*<html\b/i.test(source)) return '<!doctype html>' + head + source;
  return `<!doctype html><html><head>${head}</head><body>${source}</body></html>`;
}

@customElement('mux-chat-visualization')
export class MuxChatVisualization extends LitElement {
  @property() path = '';
  @property() projectPath = '';
  @property() sessionId = '';
  @property() remoteHost = '';
  @property({ reflect: true }) mode = '';
  @state() private source = '';
  @state() private error = '';
  private theme = '';
  private request?: AbortController;
  private themeObserver?: MutationObserver;

  static styles = css`
    :host { display:block; margin:var(--ui-space-6) 0 var(--ui-space-8); max-width:100%; }
    .card { overflow:hidden; border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); }
    .bar { display:flex; align-items:center; gap:var(--ui-space-4); padding:var(--ui-space-3) var(--ui-space-5); border-bottom:1px solid var(--ui-border); font:var(--ui-text-sm)/1.4 var(--ui-font-sans); }
    .title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    iframe { display:block; width:100%; height:26em; border:0; background:var(--ui-surface-base); }
    .message { padding:var(--ui-space-6); color:var(--ui-text-muted); font:var(--ui-text-sm)/1.5 var(--ui-font-sans); }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.theme = previewTheme(this);
    this.themeObserver = new MutationObserver(() => { this.theme = previewTheme(this); this.sendTheme(); });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    window.addEventListener('message', this.onFrameMessage);
    if (this.hasUpdated) void this.load();
  }
  override disconnectedCallback() { this.request?.abort(); this.themeObserver?.disconnect(); window.removeEventListener('message', this.onFrameMessage); super.disconnectedCallback(); }
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

  private sendTheme() {
    this.renderRoot.querySelector('iframe')?.contentWindow?.postMessage({ type: 'muxterm.visualization.theme', css: this.theme }, '*');
  }

  private readonly onFrameMessage = (event: MessageEvent) => {
    const frame = this.renderRoot.querySelector('iframe');
    if (event.source !== frame?.contentWindow || event.data?.type !== 'muxterm.visualization.height') return;
    const height = event.data.height;
    if (typeof height === 'number' && Number.isFinite(height)) frame.style.height = `${Math.max(200, Math.min(1600, Math.ceil(height)))}px`;
  };

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
      if (!request.signal.aborted) this.source = previewDocument(source, this.theme);
    } catch (error) {
      if (!request.signal.aborted) this.error = error instanceof Error ? error.message : 'Could not load visualization.';
    }
  }

  override render() {
    const title = this.path.split('/').pop() || 'Visualization';
    return html`<div class="card"><div class="bar"><span class="title" title=${this.path}>${title}</span></div>
      ${this.source ? html`<iframe title=${title} sandbox="allow-scripts" referrerpolicy="no-referrer" .srcdoc=${this.source} @load=${this.sendTheme}></iframe>` : html`<div class="message">${this.error || 'Loading visualization…'}</div>`}
    </div>`;
  }
}
