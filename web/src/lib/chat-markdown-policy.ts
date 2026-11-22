import { html, type TemplateResult } from 'lit';
import { apiPath } from './base-path.js';
import type { MdLinkPolicy } from './markdown-view.js';
import { sdkChats, type SDKChat } from './sdk-chats.js';

const RASTER_IMAGE = /\.(?:png|jpe?g|gif|webp|avif)$/i;
const CHAT_HASH = /^#chat=([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f-]{27,})(?:&host=[^&#]+)?$/i;
const CHAT_MENTION = /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[“"][^”"]{1,160}[”"]/gi;
// Codex app-server exposes these IDs in message text without a URL mapping.
const CODEX_CITATION = /cite(turn\d+(?:search|view)\d+(?:turn\d+(?:search|view)\d+)*)/g;
const WORK_MENTION = /Work #\d+|(?:Work\s+)?[0-9a-f]{32}/gi;

export type WorkReference = { id: string; reference: string; title: string; remoteHost: string };

function chatForSession(value: string): SDKChat | undefined {
  return sdkChats.chats.find(chat => chat.id.toLowerCase() === value.toLowerCase() || chat.nativeId?.toLowerCase() === value.toLowerCase());
}

function chatReference(value: string): SDKChat | undefined {
  const direct = chatForSession(value);
  if (direct) return direct;
  const title = value.replace(/^[“"]|[”"]$/g, '');
  const matches = sdkChats.chats.filter(chat => chat.title === title && title !== 'New chat');
  return matches.length === 1 ? matches[0] : undefined;
}

function chatFromHref(href: string): SDKChat | undefined {
  const raw = href.trim();
  if (raw.startsWith('chat:')) return chatForSession(raw.slice(5));
  let hash = raw;
  if (!raw.startsWith('#')) {
    try {
      const url = new URL(raw, document.baseURI);
      if (url.origin !== location.origin || url.pathname !== new URL('.', document.baseURI).pathname) return undefined;
      hash = url.hash;
    } catch { return undefined; }
  }
  const id = CHAT_HASH.exec(hash)?.[1];
  return id ? chatForSession(id) : undefined;
}

function chatLink(chat: SDKChat, label: string): TemplateResult {
  return html`<a class="md-link md-chat-link" href=${`#chat=${encodeURIComponent(chat.id)}${chat.remoteHost ? `&host=${encodeURIComponent(chat.remoteHost)}` : ''}`}
    draggable="false"
    title=${`Open chat: ${chat.title}`} aria-label=${`Open chat: ${chat.title}`}
    @click=${(event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      (event.currentTarget as HTMLElement).dispatchEvent(new CustomEvent('chat-open', {
        detail: { sessionId: chat.id }, bubbles: true, composed: true,
      }));
    }}><span aria-hidden="true">↗</span> ${label}</a>`;
}

function linkedChatMentions(text: string): unknown {
  const parts: unknown[] = [];
  const titles = sdkChats.chats.map(chat => chat.title)
    .filter(title => title.length >= 12 && title !== 'New chat' && sdkChats.chats.filter(chat => chat.title === title).length === 1)
    .sort((a, b) => b.length - a.length)
    .map(title => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const mentions = new RegExp(`${CHAT_MENTION.source}${titles.length ? `|${titles.join('|')}` : ''}`, 'gi');
  let end = 0;
  for (const match of text.matchAll(mentions)) {
    const chat = chatReference(match[0]);
    if (!chat || match.index === undefined) continue;
    if (!/^[“"]/.test(match[0]) && (/[\p{L}\p{N}]/u.test(text[match.index - 1] ?? '') || /[\p{L}\p{N}]/u.test(text[match.index + match[0].length] ?? ''))) continue;
    if (match.index > end) parts.push(text.slice(end, match.index));
    parts.push(chatLink(chat, match[0]));
    end = match.index + match[0].length;
  }
  if (!parts.length) return text;
  if (end < text.length) parts.push(text.slice(end));
  return parts;
}

function linkedChatReferences(text: string): unknown {
  const parts: unknown[] = [];
  let end = 0;
  for (const match of text.matchAll(CODEX_CITATION)) {
    if (match.index === undefined) continue;
    if (match.index > end) parts.push(linkedChatMentions(text.slice(end, match.index)));
    const references = match[1].split('');
    parts.push(html`<span class="citation-unavailable" role="note"
      title=${`Codex did not provide source links for ${references.join(', ')}`}
      aria-label=${`${references.length} source link${references.length === 1 ? '' : 's'} unavailable`}>[${references.length === 1 ? 'source' : `${references.length} sources`} unavailable]</span>`);
    end = match.index + match[0].length;
  }
  if (!parts.length) return linkedChatMentions(text);
  if (end < text.length) parts.push(linkedChatMentions(text.slice(end)));
  return parts;
}

/** Resolve a local Markdown image through the existing authenticated viewer. */
function localImage(raw: string): string | null {
  const value = raw.trim();
  if ((!value.startsWith('/') || value.startsWith('//')) && !value.startsWith('~/')) return null;
  let path: string;
  try { path = decodeURI(value); }
  catch { return null; }
  if (!RASTER_IMAGE.test(path)) return null;
  return `${apiPath('/api/artifact/raw')}?${new URLSearchParams({ path, max_bytes: String(8 << 20) }).toString()}`;
}

export const chatMarkdownPolicy: MdLinkPolicy = {
  draggable: false,
  diagrams: true,
  image: localImage,
  remoteImages: true,
  reference: (href, label) => {
    const chat = chatFromHref(href);
    return chat ? chatLink(chat, label || chat.title) : null;
  },
  referenceText: linkedChatReferences,
};

/** The server-provided index is the authority; unknown text is left untouched. */
export function chatMarkdownPolicyForWork(
  items: readonly WorkReference[], sessionId: string, chatHost: string,
  open: (item: WorkReference, trigger: HTMLElement) => void,
): MdLinkPolicy {
  const byReference = new Map<string, WorkReference>();
  const counts = new Map<string, number>();
  for (const item of items) {
    byReference.set(item.id.toLowerCase(), item);
    counts.set(item.reference.toLowerCase(), (counts.get(item.reference.toLowerCase()) || 0) + 1);
  }
  for (const item of items) if (counts.get(item.reference.toLowerCase()) === 1) byReference.set(item.reference.toLowerCase(), item);
  const workLink = (item: WorkReference): TemplateResult => {
    const hash = new URLSearchParams({chat:sessionId, work:item.id});
    if (chatHost) hash.set('host', chatHost);
    if (item.remoteHost && item.remoteHost !== chatHost) hash.set('workHost', item.remoteHost);
    const hostLabel = item.remoteHost ? ` on ${item.remoteHost}` : '';
    return html`<a class="md-link md-work-link" href=${`#${hash}`} draggable="false"
      title=${`Open ${item.reference}${hostLabel}: ${item.title}`}
      aria-label=${`Open ${item.reference}${hostLabel} in Work pane: ${item.title}`}
      @click=${(event: MouseEvent) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        open(item, event.currentTarget as HTMLElement);
      }}>${item.reference}${item.remoteHost ? html` <span class="md-work-host">${item.remoteHost}</span>` : ''}</a>`;
  };
  const linkedText = (text: string): unknown => {
    const parts: unknown[] = [];
    let end = 0;
    for (const match of text.matchAll(WORK_MENTION)) {
      if (match.index === undefined || match.index < end) continue;
      const start = match.index;
      const before = text[start - 1] || '';
      const after = text[start + match[0].length] || '';
      if (/[\p{L}\p{N}/?=#:]/u.test(before) || /[\p{L}\p{N}/]/u.test(after)) continue;
      const item = byReference.get(match[0].replace(/^Work\s+(?=[0-9a-f]{32}$)/i, '').toLowerCase());
      if (!item) continue;
      if (start > end) parts.push(linkedChatReferences(text.slice(end, start)));
      parts.push(workLink(item));
      end = start + match[0].length;
    }
    if (!parts.length) return linkedChatReferences(text);
    if (end < text.length) parts.push(linkedChatReferences(text.slice(end)));
    return parts;
  };
  const workFromHref = (href: string): WorkReference | undefined => {
    const raw = href.trim();
    if (raw.startsWith('work:')) {
      try { return byReference.get(decodeURIComponent(raw.slice(5)).toLowerCase()); }
      catch { return undefined; }
    }
    if (!raw.startsWith('#')) return undefined;
    const params = new URLSearchParams(raw.slice(1));
    if ((params.has('chat') && params.get('chat') !== sessionId) || (params.has('host') && params.get('host') !== chatHost)) return undefined;
    const item = byReference.get((params.get('work') || '').toLowerCase());
    if (params.has('workHost') && params.get('workHost') !== item?.remoteHost) return undefined;
    return item;
  };
  return {
    ...chatMarkdownPolicy,
    referenceText: linkedText,
    reference: (href, label) => {
      const work = workFromHref(href);
      if (work) return workLink(work);
      return chatMarkdownPolicy.reference?.(href, label) || null;
    },
  };
}
