import type * as Monaco from 'monaco-editor';
import { ensureMonacoStyles, loadMonaco } from './mux-monaco-source.js';

type Runtime = typeof Monaco;

/** Read-only Git comparison for the Chats Changes tab. */
export class MuxMonacoDiff extends HTMLElement {
  private oldText = '';
  private newText = '';
  private filePath = '';
  private repository = '';
  private editor: Monaco.editor.IStandaloneDiffEditor | null = null;
  private original: Monaco.editor.ITextModel | null = null;
  private modified: Monaco.editor.ITextModel | null = null;
  private modelKey = '';
  private resizeObserver: ResizeObserver | null = null;
  private generation = 0;

  set originalText(value: string) { if (value !== this.oldText) { this.oldText = value; this.syncModels(); } }
  set modifiedText(value: string) { if (value !== this.newText) { this.newText = value; this.syncModels(); } }
  set path(value: string) { if (value !== this.filePath) { this.filePath = value; this.syncModels(); } }
  set repo(value: string) { if (value !== this.repository) { this.repository = value; this.syncModels(); } }

  connectedCallback(): void {
    const generation = ++this.generation;
    const host = document.createElement('div');
    host.className = 'monaco-diff-host';
    this.replaceChildren(host);
    void loadMonaco().then(({ monaco, stylesheet }) => {
      if (!this.isConnected || generation !== this.generation) return;
      ensureMonacoStyles(this.getRootNode(), stylesheet);
      this.editor = monaco.editor.createDiffEditor(host, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: host.clientWidth > 900,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        fontSize: 12,
      });
      this.buildModels(monaco);
      this.resizeObserver = new ResizeObserver(() => this.editor?.updateOptions({ renderSideBySide: host.clientWidth > 900 }));
      this.resizeObserver.observe(host);
    }).catch(() => {
      if (this.isConnected && generation === this.generation) host.textContent = 'Could not load diff viewer.';
    });
  }

  disconnectedCallback(): void {
    this.generation++;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.editor?.dispose();
    this.editor = null;
    this.original?.dispose(); this.original = null;
    this.modified?.dispose(); this.modified = null;
    this.modelKey = '';
  }

  private buildModels(monaco: Runtime): void {
    this.original?.dispose(); this.modified?.dispose();
    const path = this.filePath || 'untitled';
    const prefix = `/muxterm-change/${encodeURIComponent(this.repository)}`;
    this.modelKey = `${this.repository}\u0000${path}`;
    this.original = monaco.editor.createModel(this.oldText, undefined, monaco.Uri.file(`${prefix}/before/${path}`));
    this.modified = monaco.editor.createModel(this.newText, undefined, monaco.Uri.file(`${prefix}/after/${path}`));
    this.editor?.setModel({ original: this.original, modified: this.modified });
  }

  private syncModels(): void {
    if (!this.editor) return;
    if (!this.original || this.modelKey !== `${this.repository}\u0000${this.filePath || 'untitled'}`) {
      void loadMonaco().then(({ monaco: runtime }) => { if (this.editor) this.buildModels(runtime); });
      return;
    }
    if (this.original.getValue() !== this.oldText) this.original.setValue(this.oldText);
    if (this.modified?.getValue() !== this.newText) this.modified?.setValue(this.newText);
  }
}

customElements.define('mux-monaco-diff', MuxMonacoDiff);

declare global {
  interface HTMLElementTagNameMap { 'mux-monaco-diff': MuxMonacoDiff }
}
