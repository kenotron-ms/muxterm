import { apiPath } from './base-path.js';
export interface SDKChat { id: string; workspaceId?: string; projectPath: string; title: string; harness: 'codex' | 'claude' | 'amplifier'; nativeId?: string; state: string; createdAt: string }
class SDKChatStore {
  chats: SDKChat[] = [];
  private listeners = new Set<() => void>();
  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async refresh() {
    const response = await fetch(apiPath('/api/sdk-chats'));
    if (!response.ok) return;
    this.chats = await response.json() as SDKChat[];
    for (const fn of this.listeners) fn();
  }
  async create(request: { workspaceId?: string; projectPath: string; harness: string; prompt: string }) {
    const response = await fetch(apiPath('/api/sdk-chats'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    if (!response.ok) throw new Error(await response.text());
    const chat = await response.json() as SDKChat;
    await this.refresh();
    return chat;
  }
}
export const sdkChats = new SDKChatStore();
