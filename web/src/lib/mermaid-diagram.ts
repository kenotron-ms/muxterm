import { LitElement, css, html } from 'lit';

let nextDiagramId = 0;
let renderQueue: Promise<void> = Promise.resolve();
let mermaidLoader: Promise<typeof import('mermaid')['default']> | undefined;

function loadMermaid(): Promise<typeof import('mermaid')['default']> {
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
    });
    return mermaid;
  });
  return mermaidLoader;
}

/** A persistent element lets a growing Markdown fence update without replacing its DOM. */
class MermaidDiagram extends LitElement {
  static properties = {
    source: { type: String },
    streaming: { type: Boolean },
  };

  static styles = css`
    :host { display: block; min-width: 0; margin: 0.75em 0; }
    figure { margin: 0; overflow-x: auto; }
    img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
    .fallback { border: 1px solid var(--line, #bbb); border-radius: 6px; overflow: hidden; }
    .label { padding: 0.5em 0.75em; font: 0.8em sans-serif; color: var(--ink-2, #555); }
    pre { margin: 0; padding: 0.75em; overflow-x: auto; white-space: pre; font: 0.85em/1.5 monospace; }
  `;

  source = '';
  streaming = false;
  private imageUrl = '';
  private imageWidth = 640;
  private failed = false;
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (!changed.has('source') && !changed.has('streaming')) return;
    if (changed.has('source')) {
      ++this.revision;
      this.failed = false;
    }
    if (!this.source.trim()) {
      this.imageUrl = '';
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    // Sample the latest source at a fixed interval. Resetting the timer on
    // every delta would postpone all rendering until the stream ends.
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enqueueRender(this.revision, this.source);
    }, 120);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    ++this.revision;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated && !this.imageUrl && this.source.trim()) {
      this.enqueueRender(this.revision, this.source);
    }
  }

  private enqueueRender(revision: number, source: string): void {
    renderQueue = renderQueue.then(async () => {
      if (revision !== this.revision || !this.isConnected) return;
      try {
        const mermaid = await loadMermaid();
        if (revision !== this.revision || !this.isConnected) return;
        const { svg } = await mermaid.render(`mux-mermaid-${++nextDiagramId}`, source);
        if (revision !== this.revision || !this.isConnected) return;
        // An SVG in an <img> is inert: diagram text cannot become chat DOM.
        // Mermaid uses width="100%"; give the image its viewBox width so a
        // narrow diagram does not inflate its labels to fill the chat column.
        const width = Number(svg.match(/\bviewBox="[\d.eE+-]+\s+[\d.eE+-]+\s+([\d.eE+-]+)/)?.[1]);
        this.imageWidth = Number.isFinite(width) && width > 0 ? Math.min(width, 10000) : 640;
        this.imageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      } catch {
        if (revision !== this.revision || !this.isConnected) return;
        if (!this.streaming) this.imageUrl = '';
        this.failed = true;
      }
      this.requestUpdate();
    });
  }

  protected render() {
    if (this.imageUrl) return html`<figure><img src=${this.imageUrl} alt="Mermaid diagram" style=${`width:${this.imageWidth}px`} /></figure>`;
    return html`<div class="fallback">
      <div class="label">${this.failed && !this.streaming ? 'Could not render Mermaid diagram' : 'Mermaid diagram'}</div>
      <pre><code>${this.source}</code></pre>
    </div>`;
  }
}

customElements.define('mux-mermaid-diagram', MermaidDiagram);
