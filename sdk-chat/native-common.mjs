import { connectorServers } from './acp-stream.mjs';
import { readFile } from 'node:fs/promises';

export function nativeConnectors(session) {
  return session.catalog ? [] : connectorServers(process.env.MUXTERM_CHAT_MCP_BIN, session.originFile);
}

export function inputText(input) {
  const attachments = input.attachments || [];
  if (!attachments.length) return input.content;
  return `${input.content || 'Please inspect the attached files.'}\n\nAttached files (absolute paths):\n${attachments.map(item => `- ${item.path}`).join('\n')}`;
}

export async function nativeImageBlocks(input) {
  const blocks = [];
  for (const item of input.attachments || []) {
    if (item.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.contentType)) continue;
    const bytes = await readFile(item.path);
    blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType: item.contentType,
      name: item.name });
  }
  return blocks;
}

export function acceptInput(session, emit, input) {
  emit(session.id, 'input.accepted', { inputId: input.id, kind: input.kind, source: input.source,
    text: input.displayContent || input.content,
    attachments: (input.attachments || []).map(({ id, name, kind }) => ({ id, name, kind })) });
}

export const simpleTitle = cmd => ({ name: cmd.mode === 'read' ? '' : cmd.name || '',
  source: cmd.mode === 'manual' ? 'manual' : cmd.mode === 'read' ? '' : 'generated' });
