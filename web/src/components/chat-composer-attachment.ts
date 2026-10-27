import { html } from 'lit';
import { Paperclip } from 'lucide';
import { icon } from '../lib/icons.js';
import '../ui/choice-item.js';
import '../ui/choice-list.js';
import '../ui/choice-picker.js';
import '../ui/choice-section.js';

/** The same attachment choices in new chats and existing conversations. */
export function chatComposerAttachment(onPick: (event: Event) => void, onChooseFiles: () => void, onPasteImage: () => void) {
  const choose = (event: Event) => {
    (event.currentTarget as HTMLElement).closest('mux-ui-choice-picker')?.close();
    onChooseFiles();
  };
  const paste = (event: Event) => {
    (event.currentTarget as HTMLElement).closest('mux-ui-choice-picker')?.close();
    onPasteImage();
  };
  return html`<input class="file-input" type="file" multiple @change=${onPick} aria-label="Choose files to attach"><mux-ui-choice-picker class="attach-picker" icon-only label="Add attachment" placement="above" appearance="plain" panel-align="left"><span slot="summary-icon">${icon(Paperclip,{size:16})}</span><mux-ui-choice-section heading="Add to message"><mux-ui-choice-list><mux-ui-choice-item label="Choose files or images" @click=${choose}></mux-ui-choice-item><mux-ui-choice-item label="Paste image from clipboard" @click=${paste}></mux-ui-choice-item></mux-ui-choice-list></mux-ui-choice-section></mux-ui-choice-picker>`;
}
