import { createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote, type DefaultReactSuggestionItem } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { BlockNoteSchema, type PartialBlock } from '@blocknote/core';
import blockNoteCSS from '@blocknote/core/style.css?inline';
import mantineCSS from '@blocknote/mantine/style.css?inline';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { visualizationBlock, visualizationCSS } from './page-visualization.js';

const pageSchema = BlockNoteSchema.create().extend({ blockSpecs:{ visualization:visualizationBlock } });
type EditorPageContent = PartialBlock<typeof pageSchema.blockSchema, typeof pageSchema.inlineContentSchema, typeof pageSchema.styleSchema>[];

type PageContent = PartialBlock[];
type PageCommand = 'page' | 'generate' | 'visualize';

async function uploadFile(file: File, remoteHost: string): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(apiPath(remoteChatPath(remoteHost, '/api/sdk-chat-attachments')), {
    method: 'POST', headers: { 'X-Muxterm-Chat-Attachment': '1' }, body: form,
  });
  if (!response.ok) throw new Error(`Upload failed (${response.status})`);
  const result = await response.json() as { id?: string };
  if (!result.id) throw new Error('Upload response lacked an attachment ID');
  return apiPath(remoteChatPath(remoteHost, `/api/sdk-chat-attachments/${encodeURIComponent(result.id)}`));
}

function PageEditor({ content, changed, command, remoteHost }: { content: PageContent; changed: (content: PageContent) => void; command: (command: PageCommand) => void; remoteHost: string }) {
  const editor = useCreateBlockNote({ schema:pageSchema, initialContent: (content.length ? content : [{ type: 'paragraph' }]) as EditorPageContent, uploadFile:(file) => uploadFile(file, remoteHost) });
  type ViewProps = { editor: typeof editor; theme: 'light'; onChange: () => void; slashMenu: boolean; children?: ReactNode };
  const View = BlockNoteView as unknown as ComponentType<ViewProps>;
  return createElement(View, {
    editor, theme: 'light', onChange: () => changed(editor.document as unknown as PageContent), slashMenu: false,
  },
  createElement(SuggestionMenuController, {
    triggerCharacter: '/',
    getItems: async (query: string) => {
      const custom: DefaultReactSuggestionItem[] = [
        { title:'Generate', subtext:'Describe what you want to write', group:'Generate', icon:createElement('span',null,'✧'), onItemClick:()=>command('generate') },
        { title:'Visualize', subtext:'Create an interactive visualization', group:'Generate', icon:createElement('span',null,'◇'), onItemClick:()=>command('visualize') },
        { title:'Page', subtext:'Create a page inside this one', group:'Create', icon:createElement('span',null,'▤'), onItemClick:()=>command('page') },
      ];
      return filterSuggestionItems([...custom,...getDefaultReactSlashMenuItems(editor)], query);
    },
  }));
}

/** A React island keeps BlockNote's editor lifecycle independent from Lit saves. */
export class MuxBlockNotePage extends HTMLElement {
  private root: Root | null = null;
  private mount?: HTMLDivElement;
  private currentPageId = '';
  private currentRemoteHost = '';
  private currentContent: PageContent = [];
  private currentEpoch = 0;
  private editorObserver?: MutationObserver;

  set remoteHost(value: string) { this.currentRemoteHost = value; }
  set pageId(value: string) {
    if (value === this.currentPageId) return;
    this.currentPageId = value;
    this.renderEditor();
  }
  set content(value: PageContent) { this.currentContent = value; }
  set documentEpoch(value: number) { if (value === this.currentEpoch) return; this.currentEpoch = value; this.renderEditor(); }

  connectedCallback(): void {
    if (this.root) return;
    const shadow = this.shadowRoot || this.attachShadow({ mode: 'open' });
    if (!this.shadowRoot?.querySelector('style')) {
      const style = document.createElement('style');
      style.textContent = `${blockNoteCSS}\n${mantineCSS}\n${visualizationCSS}\n:host{display:block;min-height:100px}.bn-container{--bn-colors-editor-background:var(--ui-document-surface);--bn-colors-editor-text:var(--ui-document-text);background:transparent!important;color:var(--ui-document-text)!important}.bn-editor{padding-inline:0!important}`;
      shadow.append(style);
    }
    // BlockNote owns the inner textbox and replaces it when a page changes.
    // Name each new editor as it appears in this island's shadow root.
    this.editorObserver = new MutationObserver(() => {
      const editor = shadow.querySelector<HTMLElement>('.tiptap[role="textbox"]');
      if (editor && !editor.hasAttribute('aria-label')) editor.setAttribute('aria-label', 'Page content');
    });
    this.editorObserver.observe(shadow, {childList:true, subtree:true});
    const mount = document.createElement('div');
    shadow.append(mount);
    this.mount = mount;
    this.root = createRoot(mount);
    this.renderEditor();
  }

  disconnectedCallback(): void {
    this.editorObserver?.disconnect();
    this.editorObserver = undefined;
    const root = this.root;
    const mount = this.mount;
    this.root = null;
    this.mount = undefined;
    queueMicrotask(() => { root?.unmount(); mount?.remove(); });
  }

  private renderEditor(): void {
    if (!this.root || !this.currentPageId) return;
    this.root.render(createElement(PageEditor, {
      key: `${this.currentPageId}:${this.currentEpoch}`,
      content: this.currentContent,
      remoteHost: this.currentRemoteHost,
      changed: (content: PageContent) => this.dispatchEvent(new CustomEvent('page-content-change', { detail: content, bubbles: true, composed: true })),
      command: (command: PageCommand) => this.dispatchEvent(new CustomEvent('page-command', { detail: command, bubbles: true, composed: true })),
    }));
  }
}

customElements.define('mux-blocknote-page', MuxBlockNotePage);

declare global {
  interface HTMLElementTagNameMap { 'mux-blocknote-page': MuxBlockNotePage }
}
