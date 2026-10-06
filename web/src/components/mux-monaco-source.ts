import type * as Monaco from 'monaco-editor';

type Runtime = typeof Monaco;
let runtime: Promise<{ monaco: Runtime; stylesheet: string }> | null = null;
const styledRoots = new WeakSet<ShadowRoot | Document>();

/** Load the editor and Vite workers only when a chat opens source. */
export function loadMonaco(): Promise<{ monaco: Runtime; stylesheet: string }> {
  runtime ??= Promise.all([
    import('monaco-editor'),
    import('../../node_modules/monaco-editor/min/vs/editor/editor.main.css?inline'),
    import('../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker'),
    import('../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js?worker'),
    import('../../node_modules/monaco-editor/esm/vs/language/css/css.worker.js?worker'),
    import('../../node_modules/monaco-editor/esm/vs/language/html/html.worker.js?worker'),
    import('../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js?worker'),
  ]).then(([monaco, stylesheet, editor, json, css, html, typescript]) => {
    self.MonacoEnvironment = {
      getWorker(_id: string, label: string): Worker {
        if (label === 'json') return new json.default();
        if (label === 'css' || label === 'scss' || label === 'less') return new css.default();
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new html.default();
        if (label === 'typescript' || label === 'javascript') return new typescript.default();
        return new editor.default();
      },
    };
    return { monaco, stylesheet: stylesheet.default };
  });
  return runtime;
}

export function ensureMonacoStyles(root: Node, stylesheet: string): void {
  if (!(root instanceof ShadowRoot || root instanceof Document) || styledRoots.has(root)) return;
  const style = document.createElement('style');
  style.textContent = stylesheet;
  if (root instanceof ShadowRoot) root.append(style);
  else root.head.append(style);
  styledRoots.add(root);
}

/** Chat Files' read-only source surface. Models are scoped by chat and path. */
export class MuxMonacoSource extends HTMLElement {
  private sourceText = '';
  private filePath = '';
  private chatId = '';
  private monaco: Runtime | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private model: Monaco.editor.ITextModel | null = null;
  private themeObserver: MutationObserver | null = null;
  private themeColors = '';
  private generation = 0;

  set source(value: string) { if (value !== this.sourceText) { this.sourceText = value; this.syncModel(); } }
  get source() { return this.sourceText; }
  set path(value: string) { if (value !== this.filePath) { this.filePath = value; this.syncModel(); } }
  get path() { return this.filePath; }
  set scope(value: string) { if (value !== this.chatId) { this.chatId = value; this.syncModel(); } }
  get scope() { return this.chatId; }

  getSelectedText(): string {
    const selection = this.editor?.getSelection();
    return selection && this.model ? this.model.getValueInRange(selection).trim().slice(0, 600) : '';
  }

  connectedCallback(): void {
    const generation = ++this.generation;
    const host = document.createElement('div');
    host.className = 'monaco-host';
    this.replaceChildren(host);
    void loadMonaco().then(({ monaco, stylesheet }) => {
      if (!this.isConnected || generation !== this.generation) return;
      ensureMonacoStyles(this.getRootNode(), stylesheet);
      this.monaco = monaco;
      this.model = monaco.editor.createModel(this.sourceText, undefined, this.modelURI(monaco));
      this.editor = monaco.editor.create(host, {
        model: this.model,
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        lineNumbers: 'on',
        renderLineHighlight: 'none',
        accessibilitySupport: 'auto',
      });
      this.themeObserver = new MutationObserver(() => this.syncTheme());
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      this.syncTheme();
    }).catch(() => {
      if (this.isConnected && generation === this.generation) host.textContent = 'Could not load source viewer.';
    });
  }

  disconnectedCallback(): void {
    this.generation++;
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.editor?.dispose();
    this.editor = null;
    this.model?.dispose();
    this.model = null;
    this.monaco = null;
    this.themeColors = '';
  }

  private modelURI(monaco: Runtime): Monaco.Uri {
    const name = this.filePath.split('/').pop() || 'untitled';
    return monaco.Uri.file(`/muxterm-chat/${encodeURIComponent(this.chatId)}/${encodeURIComponent(this.filePath)}/${name}`);
  }

  private syncModel(): void {
    const monaco = this.monaco;
    if (!monaco || !this.editor) return;
    const uri = this.modelURI(monaco);
    if (this.model?.uri.toString() !== uri.toString()) {
      this.model?.dispose();
      this.model = monaco.editor.createModel(this.sourceText, undefined, uri);
      this.editor.setModel(this.model);
    } else if (this.model.getValue() !== this.sourceText) {
      this.model.setValue(this.sourceText);
    }
  }

  private syncTheme(): void {
    const monaco = this.monaco;
    if (!monaco) return;
    const style = getComputedStyle(this);
    const background = style.getPropertyValue('--chrome-body').trim();
    const foreground = style.getPropertyValue('--chrome-text-bright').trim();
    const colors = `${background}\u0000${foreground}`;
    if (colors === this.themeColors) return;
    this.themeColors = colors;
    const rgb = /^#([0-9a-f]{6})$/i.exec(background)?.[1];
    const light = rgb ? parseInt(rgb.slice(0, 2), 16) + parseInt(rgb.slice(2, 4), 16) + parseInt(rgb.slice(4, 6), 16) > 384 : false;
    monaco.editor.defineTheme('muxterm-chat-source', {
      base: light ? 'vs' : 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': background || (light ? '#ffffff' : '#1a1b26'),
        'editor.foreground': foreground || (light ? '#1c1c1e' : '#c0caf5'),
      },
    });
    monaco.editor.setTheme('muxterm-chat-source');
  }
}

customElements.define('mux-monaco-source', MuxMonacoSource);

declare global {
  interface HTMLElementTagNameMap { 'mux-monaco-source': MuxMonacoSource }
}
