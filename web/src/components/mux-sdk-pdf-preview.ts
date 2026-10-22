import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import '../ui/button.js';
import '../ui/feedback.js';

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
    :host { display:flex; flex:1; flex-direction:column; min-height:0; color:var(--ui-text); font:var(--ui-text-md)/1.5 var(--ui-font-sans); }
    .toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:var(--ui-space-4); padding:var(--ui-space-4) var(--ui-space-5); border-top:1px solid var(--ui-border); background:var(--ui-surface-raised); color:var(--ui-text-muted); }
    .controls { display:flex; align-items:center; gap:var(--ui-space-4); }
    .zoom { margin-left:auto; }
    .count { white-space:nowrap; font:var(--ui-text-sm) var(--ui-font-mono); }
    .page { flex:1; min-height:0; overflow:auto; padding:var(--ui-space-7); background:var(--ui-surface-base); text-align:center; }
    .page:focus-visible { outline:2px solid var(--ui-focus); outline-offset:-2px; }
    canvas { display:block; max-width:100%; margin:0 auto; box-shadow:var(--ui-shadow-menu); background:var(--ui-document-surface); }
    mux-ui-feedback { margin:auto; max-width:36ch; }
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
      ${this._document ? html`<div class="toolbar" role="group" aria-label="PDF controls">
        <div class="controls"><mux-ui-button size="small" variant="quiet" ?disabled=${this._page <= 1 || !this._document} @click=${() => { this._page--; }}>Previous</mux-ui-button>
        <span class="count" aria-live="polite">Page ${this._page} of ${this._pages || '…'}</span>
        <mux-ui-button size="small" variant="quiet" ?disabled=${this._page >= this._pages || !this._document} @click=${() => { this._page++; }}>Next</mux-ui-button></div>
        <div class="controls zoom"><mux-ui-button size="small" variant="quiet" icon-only accessible-label="Zoom out" ?disabled=${this._zoom <= .5 || !this._document} @click=${() => { this._zoom = Math.max(.5, this._zoom - .25); }}>−</mux-ui-button>
        <span class="count">${Math.round(this._zoom * 100)}%</span>
        <mux-ui-button size="small" variant="quiet" icon-only accessible-label="Zoom in" ?disabled=${this._zoom >= 2 || !this._document} @click=${() => { this._zoom = Math.min(2, this._zoom + .25); }}>+</mux-ui-button></div>
      </div>` : nothing}
      <div class="page" role="region" aria-label="PDF preview" tabindex=${this._document ? '0' : '-1'}>${this._error ? html`<mux-ui-feedback kind="error" appearance="panel">${this._error}</mux-ui-feedback>` : !this.bytes ? html`<mux-ui-feedback kind="empty" appearance="panel" align="center">Choose a PDF to preview.</mux-ui-feedback>` : !this._document ? html`<mux-ui-feedback kind="loading" appearance="panel">Loading PDF preview…</mux-ui-feedback>` : html`<canvas role="img" aria-label="PDF page ${this._page}"></canvas>`}</div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-sdk-pdf-preview': MuxSDKPdfPreview } }
