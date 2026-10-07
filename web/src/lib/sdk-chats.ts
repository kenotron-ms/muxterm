import { apiPath } from './base-path.js';
export type SDKHarnessName = 'codex' | 'claude' | 'amplifier' | 'pi' | 'opencode' | 'deepseek';
export function sdkHarnessLabel(harness: SDKHarnessName): string {
  return { codex:'Codex', claude:'Claude Code', amplifier:'Amplifier', pi:'Pi', opencode:'OpenCode', deepseek:'DeepSeek Harness' }[harness];
}
export interface SDKChat { id: string; workspaceId?: string; terminalWorkspaceId?: string; projectPath: string; sourceFolders?: string[]; title: string; harness: SDKHarnessName; provider?: string; nativeId?: string; state: string; createdAt: string; updatedAt?: string; lastActivity?: string; lastOutput?: string; archived?: boolean; pinned?: boolean; workMode?: 'local' | 'worktree'; approval?: string; goal?: string; goalState?: string; goalReason?: string; goalSummary?: string; operator?: boolean; operatorLanes?: string[]; laneTodos?: {text:string;status:string}[]; laneProgress?: number; laneProgressSource?: 'todos' | 'estimate'; laneReport?: string }
export interface SDKProject { id: string; name: string; path: string; sourceFolders?: string[]; pinned?: boolean }
export interface FolderListing { path: string; base: string; parent: string; folders: string[] }
class SDKChatStore {
  chats: SDKChat[] = [];
  projects: SDKProject[] = [];
  private listeners = new Set<() => void>();
  private nameEvents?: EventSource;
  private refreshGeneration = 0;
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    if (!this.nameEvents) {
      this.nameEvents = new EventSource(apiPath('/api/sdk-chat-names/events'));
      this.nameEvents.onopen = () => { void this.refresh(); };
      this.nameEvents.onmessage = () => { void this.refresh(); };
    }
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) { this.nameEvents?.close(); this.nameEvents = undefined; }
    };
  }
  async refresh() {
    const generation = ++this.refreshGeneration;
    const [response, projects] = await Promise.all([fetch(apiPath('/api/sdk-chats')), fetch(apiPath('/api/sdk-projects'))]);
    if (!response.ok || !projects.ok) return;
    const [chats, projectRows] = await Promise.all([response.json() as Promise<SDKChat[]>, projects.json() as Promise<SDKProject[]>]);
    if (generation !== this.refreshGeneration) return;
    this.chats = chats;
    this.projects = projectRows;
    for (const fn of this.listeners) fn();
  }
  async create(request: { workspaceId?: string; projectPath?: string; workMode?: 'local' | 'worktree'; harness: string; provider: string; prompt: string; attachments?: string[]; operatorId?: string }) {
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
  async setArchived(id: string, archived: boolean) {
    const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived }) });
    if (!response.ok) throw new Error(await response.text());
    await this.refresh();
  }
  async setPinned(id: string, pinned: boolean) {
    const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }) });
    if (!response.ok) throw new Error(await response.text());
    await this.refresh();
  }
  async setTerminalWorkspace(id: string, terminalWorkspaceId: string) {
    const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}`), { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({terminalWorkspaceId}) });
    if (!response.ok) throw new Error(await response.text());
    await this.refresh();
  }
  async operator(id: string, change: { enabled?: boolean; laneIds?: string[] }): Promise<SDKChat> {
    const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}/operator`), { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(change) });
    if (!response.ok) throw new Error(await response.text());
    const chat = await response.json() as SDKChat;
    await this.refresh();
    return chat;
  }
  async linkOperatorLane(id: string, laneId: string): Promise<SDKChat> {
    const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}/operator`), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({laneId}) });
    if (!response.ok) throw new Error(await response.text());
    const chat = await response.json() as SDKChat;
    await this.refresh();
    return chat;
  }
  async createProject(path: string, name = '', sourceFolders: string[] = []) {
    const response = await fetch(apiPath('/api/sdk-projects'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, name, sourceFolders }) });
    if (!response.ok) throw new Error(await response.text());
    const project = await response.json() as SDKProject;
    await this.refresh();
    return project;
  }
  async updateProject(id: string, changes: Partial<Pick<SDKProject, 'name' | 'path' | 'sourceFolders' | 'pinned'>>) {
    const response = await fetch(apiPath(`/api/sdk-projects/${encodeURIComponent(id)}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
    if (!response.ok) throw new Error(await response.text());
    await this.refresh();
  }
  async removeProject(id: string) {
    const response = await fetch(apiPath(`/api/sdk-projects/${encodeURIComponent(id)}`), { method: 'DELETE' });
    if (!response.ok) throw new Error(await response.text());
    await this.refresh();
  }
  async moveChat(sessionId: string, projectId: string): Promise<void> {
    const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(sessionId)}/project`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId }),
    });
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
