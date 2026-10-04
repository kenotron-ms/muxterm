import { LitElement, html, css, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Bounded PDF bytes are drawn to a canvas; the browser's PDF plugin is never embedded. */
@customElement('mux-sdk-pdf-preview')
export class MuxSDKPdfPreview extends LitElement {
  @property({ attribute: false }) bytes: Uint8Array<ArrayBuffer> | null = null;
  @state() private _page = 1;
  @state() private _pages = 0;
  @state() private _zoom = 1;
  @state() private _error = '';
  private _document: PDFDocumentProxy | null = null;
  private _loadingTask: PDFDocumentLoadingTask | null = null;
  private _renderTask: RenderTask | null = null;
  private _generation = 0;
  private _resize: ResizeObserver | null = null;

  static override styles = css`
    :host { display: flex; flex: 1; flex-direction: column; min-height: 0; color: var(--chrome-text-bright); }
    .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--chrome-border); color: var(--chrome-text-dim); font: 12px ui-monospace, monospace; }
    button { border: 1px solid var(--chrome-border); border-radius: 6px; background: var(--chrome-bar); color: var(--chrome-text-bright); padding: 4px 8px; cursor: pointer; }
    button:disabled { opacity: .45; cursor: default; }
    button:focus-visible { outline: 2px solid var(--chrome-accent); outline-offset: 2px; }
    .page { flex: 1; min-height: 0; overflow: auto; padding: 18px; background: var(--chrome-body); text-align: center; }
    canvas { display: block; max-width: 100%; margin: 0 auto; box-shadow: 0 8px 28px #0005; background: white; }
    .status { padding: 20px; color: var(--chrome-text-dim); }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this._resize = new ResizeObserver(() => { void this._paint(); });
    this._resize.observe(this);
  }

  override disconnectedCallback(): void {
    this._generation++;
    this._renderTask?.cancel();
    void this._loadingTask?.destroy();
    this._resize?.disconnect();
    this._resize = null;
    super.disconnectedCallback();
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('bytes')) void this._open();
    else {
      const stateChanges = changed as Map<string, unknown>;
      if (stateChanges.has('_page') || stateChanges.has('_zoom')) void this._paint();
    }
  }

  private async _open(): Promise<void> {
    const generation = ++this._generation;
    this._renderTask?.cancel();
    void this._loadingTask?.destroy();
    this._document = null;
    this._loadingTask = null;
    this._page = 1;
    this._pages = 0;
    this._error = '';
    if (!this.bytes) return;
    try {
      const pdfjs = await import('pdfjs-dist');
      if (generation !== this._generation) return;
      pdfjs.GlobalWorkerOptions.workerSrc = workerURL;
      const task = pdfjs.getDocument({ data: this.bytes.slice() });
      this._loadingTask = task;
      const document = await task.promise;
      if (generation !== this._generation) { void task.destroy(); return; }
      this._document = document;
      this._pages = document.numPages;
      await this.updateComplete;
      await this._paint();
    } catch (error) {
      if (generation === this._generation) this._error = error instanceof Error ? error.message : 'Could not read this PDF.';
    }
  }

  private async _paint(): Promise<void> {
    const document = this._document;
    const canvas = this.renderRoot.querySelector<HTMLCanvasElement>('canvas');
    if (!document || !canvas) return;
    this._renderTask?.cancel();
    const generation = this._generation;
    const pageNumber = this._page;
    try {
      const page = await document.getPage(pageNumber);
      if (generation !== this._generation || pageNumber !== this._page) return;
      const first = page.getViewport({ scale: 1 });
      const available = Math.max(240, this.getBoundingClientRect().width - 48);
      const scale = Math.min(2, available / first.width) * this._zoom;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * pixelRatio });
      const limited = Math.min(1, 4096 / Math.max(viewport.width, viewport.height));
      const finalViewport = limited < 1 ? page.getViewport({ scale: scale * pixelRatio * limited }) : viewport;
      canvas.width = Math.ceil(finalViewport.width);
      canvas.height = Math.ceil(finalViewport.height);
      canvas.style.width = `${finalViewport.width / pixelRatio}px`;
      canvas.style.height = `${finalViewport.height / pixelRatio}px`;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable.');
      const task = page.render({ canvasContext: context, canvas, viewport: finalViewport });
      this._renderTask = task;
      await task.promise;
    } catch (error) {
      if (generation === this._generation && !(error instanceof Error && error.name === 'RenderingCancelledException')) {
        this._error = error instanceof Error ? error.message : 'Could not draw this page.';
      }
    }
  }

  override render(): TemplateResult {
    return html`
      <div class="toolbar" aria-label="PDF controls">
        <button type="button" ?disabled="${this._page <= 1}" @click="${() => { this._page--; }}" aria-label="Previous page">Previous</button>
        <span>Page ${this._page} of ${this._pages || '…'}</span>
        <button type="button" ?disabled="${this._page >= this._pages}" @click="${() => { this._page++; }}" aria-label="Next page">Next</button>
        <button type="button" ?disabled="${this._zoom <= .5}" @click="${() => { this._zoom = Math.max(.5, this._zoom - .25); }}" aria-label="Zoom out">−</button>
        <span>${Math.round(this._zoom * 100)}%</span>
        <button type="button" ?disabled="${this._zoom >= 2}" @click="${() => { this._zoom = Math.min(2, this._zoom + .25); }}" aria-label="Zoom in">+</button>
      </div>
      <div class="page">${this._error ? html`<div class="status" role="alert">${this._error}</div>` : html`<canvas aria-label="PDF page ${this._page}"></canvas>`}</div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-sdk-pdf-preview': MuxSDKPdfPreview } }
