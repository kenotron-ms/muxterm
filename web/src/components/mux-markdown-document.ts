import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import '../ui/button.js';
import { parseMarkdown, type MdSegment } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';

const SEGMENTS_PER_CHUNK = 32;
const CHUNKS_PER_BATCH = 4;
const WORKER_THRESHOLD = 128 * 1024;

@customElement('mux-markdown-chunk')
class MuxMarkdownChunk extends LitElement {
  @property({ attribute:false }) segments: MdSegment[] = [];
  override createRenderRoot() { return this; }

  override render() { return renderSegments(this.segments); }
}

/** A file preview keeps its own render state so utility chrome updates never rebuild it. */
@customElement('mux-markdown-document')
export class MuxMarkdownDocument extends LitElement {
  @property({ attribute:false }) source = '';
  @property() name = '';
  private chunks: MdSegment[][] = [];
  private visibleChunks = 0;
  private parsing = false;
  private error = '';
  private worker?: Worker;
  private observer?: IntersectionObserver;

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    if (this.parsing && !this.worker && this.source) { this.parseSource(); this.requestUpdate(); }
  }

  override disconnectedCallback() {
    this.worker?.terminate();
    this.worker = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has('source')) this.parseSource();
  }

  private parseSource() {
    this.worker?.terminate();
    this.worker = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    this.chunks = [];
    this.visibleChunks = 0;
    this.error = '';
    const source = this.source;
    if (!source) { this.parsing = false; return; }
    this.parsing = true;
    if (source.length < WORKER_THRESHOLD) {
      try { this.acceptSegments(parseMarkdown(source)); }
      catch (error) { this.fail(error); }
      return;
    }
    let worker: Worker;
    try { worker = new Worker(new URL('../lib/markdown-document-worker.ts', import.meta.url), { type:'module' }); }
    catch (error) { this.fail(error); return; }
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<{ segments?: MdSegment[]; error?: string }>) => {
      if (this.worker !== worker || this.source !== source) return;
      worker.terminate();
      this.worker = undefined;
      if (event.data.error) this.fail(event.data.error);
      else this.acceptSegments(event.data.segments || []);
    };
    worker.onerror = () => {
      if (this.worker !== worker) return;
      worker.terminate();
      this.worker = undefined;
      this.fail('Markdown parsing failed');
    };
    try { worker.postMessage({ source }); }
    catch (error) { worker.terminate(); this.worker = undefined; this.fail(error); }
  }

  private acceptSegments(segments: MdSegment[]) {
    this.chunks = [];
    for (let i = 0; i < segments.length; i += SEGMENTS_PER_CHUNK)
      this.chunks.push(segments.slice(i, i + SEGMENTS_PER_CHUNK));
    this.visibleChunks = Math.min(CHUNKS_PER_BATCH, this.chunks.length);
    this.parsing = false;
    this.requestUpdate();
  }

  private fail(error: unknown) {
    this.error = error instanceof Error ? error.message : String(error);
    this.parsing = false;
    this.requestUpdate();
  }

  private showMore() {
    if (this.visibleChunks >= this.chunks.length) return;
    this.visibleChunks = Math.min(this.chunks.length, this.visibleChunks + CHUNKS_PER_BATCH);
    this.requestUpdate();
  }

  override updated() {
    this.observer?.disconnect();
    const more = this.querySelector<HTMLElement>('.markdown-more');
    if (!more) return;
    this.observer ??= new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) this.showMore();
    }, { root:this.closest('.viewer-body'), rootMargin:'600px' });
    this.observer.observe(more);
  }

  override render() {
    return html`
      ${this.parsing ? html`<div class="sandbox-note" role="status">Preparing Markdown preview…</div>` : nothing}
      ${this.error ? html`<div class="sandbox-note" role="alert">Preview unavailable: ${this.error}. View source to read this file.</div>` : nothing}
      <article class="document-view" aria-label=${`Preview of ${this.name}`}>
        ${repeat(this.chunks.slice(0, this.visibleChunks), chunk => chunk[0]?.key, chunk => html`<mux-markdown-chunk .segments=${chunk}></mux-markdown-chunk>`)}
      </article>
      ${this.visibleChunks < this.chunks.length ? html`<div class="markdown-more"><mux-ui-button size="small" variant="secondary" @click=${() => this.showMore()}>Show more Markdown</mux-ui-button></div>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-markdown-document': MuxMarkdownDocument;
    'mux-markdown-chunk': MuxMarkdownChunk;
  }
}
