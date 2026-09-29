import { apiPath } from './base-path.js';
export interface SDKChat { id: string; workspaceId?: string; projectPath: string; title: string; harness: 'codex' | 'claude' | 'amplifier'; provider?: string; nativeId?: string; state: string; createdAt: string }
export interface SDKProject { id: string; name: string; path: string }
export interface FolderListing { path: string; base: string; parent: string; folders: string[] }
class SDKChatStore {
  chats: SDKChat[] = [];
  projects: SDKProject[] = [];
  private listeners = new Set<() => void>();
  private nameEvents?: EventSource;
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    if (!this.nameEvents) {
      this.nameEvents = new EventSource(apiPath('/api/sdk-chat-names/events'));
      this.nameEvents.onmessage = () => { void this.refresh(); };
    }
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) { this.nameEvents?.close(); this.nameEvents = undefined; }
    };
  }
  async refresh() {
    const [response, projects] = await Promise.all([fetch(apiPath('/api/sdk-chats')), fetch(apiPath('/api/sdk-projects'))]);
    if (!response.ok || !projects.ok) return;
    this.chats = await response.json() as SDKChat[];
    this.projects = await projects.json() as SDKProject[];
    for (const fn of this.listeners) fn();
  }
  async create(request: { workspaceId?: string; projectPath?: string; harness: string; provider: string; prompt: string }) {
    const response = await fetch(apiPath('/api/sdk-chats'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    if (!response.ok) throw new Error(await response.text());
    const chat = await response.json() as SDKChat;
    await this.refresh();
    return chat;
  }
  async rename(id: string, title: string) {
    const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    if (!response.ok) throw new Error(await response.text());
    await this.refresh();
  }
  async createProject(path: string, name = '') {
    const response = await fetch(apiPath('/api/sdk-projects'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, name }) });
    if (!response.ok) throw new Error(await response.text());
    const project = await response.json() as SDKProject;
    await this.refresh();
    return project;
  }
  async removeProject(id: string) {
    const response = await fetch(apiPath(`/api/sdk-projects/${encodeURIComponent(id)}`), { method: 'DELETE' });
    if (!response.ok) throw new Error(await response.text());
    await this.refresh();
  }
  async folders(path = ''): Promise<FolderListing> {
    const response = await fetch(apiPath(`/api/sdk-folders${path ? `?path=${encodeURIComponent(path)}` : ''}`));
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<FolderListing>;
  }
}
export const sdkChats = new SDKChatStore();
