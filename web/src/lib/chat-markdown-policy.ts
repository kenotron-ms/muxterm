import { html, type TemplateResult } from 'lit';
import { apiPath } from './base-path.js';
import type { MdLinkPolicy } from './markdown-view.js';
import { sdkChats, type SDKChat } from './sdk-chats.js';

const RASTER_IMAGE = /\.(?:png|jpe?g|gif|webp|avif)$/i;
const CHAT_HASH = /^#chat=([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f-]{27,})$/i;
const CHAT_MENTION = /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[“"][^”"]{1,160}[”"]/gi;

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
  return html`<a class="md-link md-chat-link" href=${`#chat=${encodeURIComponent(chat.id)}`}
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
  image: localImage,
  remoteImages: true,
  reference: (href, label) => {
    const chat = chatFromHref(href);
    return chat ? chatLink(chat, label || chat.title) : null;
  },
  referenceText: linkedChatMentions,
};
