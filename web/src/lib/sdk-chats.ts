import { apiPath } from './base-path.js';
import { remotesStore } from './remotes-store.js';
import { chatHost, projectHost, rememberChatHost, rememberProjectHost, remoteChatPath } from './remote-chat-routes.js';
export type SDKHarnessName = 'codex' | 'claude' | 'copilot' | 'amplifier' | 'pi' | 'opencode' | 'deepseek' | 'gemini' | 'antigravity';
export function sdkHarnessLabel(harness: SDKHarnessName): string {
  return { codex:'Codex', claude:'Claude Code', copilot:'GitHub Copilot', amplifier:'Amplifier', pi:'Pi', opencode:'OpenCode', deepseek:'DeepSeek Harness', gemini:'Gemini CLI', antigravity:'Antigravity' }[harness];
}
export interface SDKLaneTiming { category: 'review' | 'focused' | 'cross_stack' | 'operational'; classification: 'openai_decisions' | 'anthropic' | 'historical_only'; sampleSize: number; broadHistory?: boolean; effortLowSeconds?: number; effortHighSeconds?: number; elapsedSeconds?: number; remainingLowSeconds?: number; remainingHighSeconds?: number; survivorCount?: number; actualSeconds?: number }
export interface SDKChat { id: string; remoteHost?: string; workspaceId?: string; terminalWorkspaceId?: string; projectPath: string; sourceFolders?: string[]; title: string; harness: SDKHarnessName; provider?: string; nativeId?: string; state: string; createdAt: string; updatedAt?: string; lastActivity?: string; lastOutput?: string; lastTurnOutcome?: 'completed' | 'cancelled'; archived?: boolean; pinned?: boolean; workMode?: 'local' | 'worktree'; approval?: string; goal?: string; goalState?: string; goalReason?: string; goalSummary?: string; operator?: boolean; operatorLanes?: string[]; laneTodos?: {text:string;status:string}[]; laneReport?: string; timing?: SDKLaneTiming; branchPending?: boolean }
export interface SDKProject { id: string; remoteHost?: string; name: string; path: string; managedFolder?: boolean; sourceFolders?: string[]; pinned?: boolean }
export interface SDKRemoteHost { id: string; name: string; state: string }
export interface FolderListing { path: string; base: string; parent: string; folders: string[] }
class SDKChatStore {
  chats: SDKChat[] = [];
  projects: SDKProject[] = [];
  remoteHosts: SDKRemoteHost[] = [];
  archivedCount = 0;
  private archivedCache = new Map<string, SDKChat>();
  private listeners = new Set<() => void>();
  private nameEvents?: EventSource;
  private remoteUnsub?: () => void;
  private refreshGeneration = 0;
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    if (!this.nameEvents) {
      this.nameEvents = new EventSource(apiPath('/api/sdk-chat-names/events'));
      this.nameEvents.onopen = () => { void this.refresh(); };
      this.nameEvents.onmessage = () => { void this.refresh(); };
      this.remoteUnsub = remotesStore.subscribe(() => { void this.refresh(); });
    }
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) { this.nameEvents?.close(); this.nameEvents = undefined; this.remoteUnsub?.(); this.remoteUnsub = undefined; }
    };
  }
  async refresh() {
    const generation = ++this.refreshGeneration;
    const [response, projects, remotes] = await Promise.all([
      fetch(apiPath('/api/sdk-chats?archived=false')),
      fetch(apiPath('/api/sdk-projects')),
      fetch(apiPath('/api/remotes')),
    ]);
    if (!response.ok || !projects.ok) return;
    const [localChats, localProjects] = await Promise.all([response.json() as Promise<SDKChat[]>, projects.json() as Promise<SDKProject[]>]);
    const remoteRows = remotes.ok ? await remotes.json() as {connected?:SDKRemoteHost[];discovered?:SDKRemoteHost[];errors?:SDKRemoteHost[]} : {};
    const hosts = [...(remoteRows.connected || []), ...(remoteRows.discovered || []), ...(remoteRows.errors || [])];
    if (generation !== this.refreshGeneration) return;
    this.remoteHosts = hosts;
    this.archivedCount = Number(response.headers.get('X-Archived-Count') || 0);
    for (const chat of localChats) this.archivedCache.delete(chat.id);
    const previousChats = this.chats.filter(chat => chat.remoteHost && hosts.some(host => host.id === chat.remoteHost));
    const previousProjects = this.projects.filter(project => project.remoteHost && hosts.some(host => host.id === project.remoteHost));
    this.chats = [...localChats, ...this.archivedCache.values(), ...previousChats];
    this.projects = [...localProjects, ...previousProjects];
    for (const fn of this.listeners) fn();
    const remoteResults = await Promise.all(hosts.map(async host => {
      try {
        const [chatResponse, projectResponse] = await Promise.all([
          fetch(apiPath(remoteChatPath(host.id, '/api/sdk-chats?archived=false'))),
          fetch(apiPath(remoteChatPath(host.id, '/api/sdk-projects'))),
        ]);
        if (!chatResponse.ok || !projectResponse.ok) throw new Error('Remote chat backend unavailable');
        return { host:{...host, state:'connected'}, chats: await chatResponse.json() as SDKChat[], projects: await projectResponse.json() as SDKProject[], archived: Number(chatResponse.headers.get('X-Archived-Count') || 0) };
      } catch {
        return { host:{...host, state:'unreachable'}, chats: previousChats.filter(chat => chat.remoteHost === host.id), projects: previousProjects.filter(project => project.remoteHost === host.id), archived: 0 };
      }
    }));
    if (generation !== this.refreshGeneration) return;
    this.remoteHosts = remoteResults.map(result => result.host);
    this.archivedCount += remoteResults.reduce((sum, result) => sum + result.archived, 0);
    const activeChats = [...localChats, ...remoteResults.flatMap(result => result.chats.map(chat => ({...chat, remoteHost: result.host.id})))];
    for (const chat of activeChats) this.archivedCache.delete(chat.id);
    this.chats = [...activeChats, ...this.archivedCache.values()];
    this.projects = [...localProjects, ...remoteResults.flatMap(result => result.projects.map(project => ({...project, remoteHost: result.host.id})))];
    for (const chat of this.chats) rememberChatHost(chat.id, chat.remoteHost || '');
    for (const project of this.projects) rememberProjectHost(project.id, project.remoteHost || '');
    for (const fn of this.listeners) fn();
  }
  async archived(page = 0, query = ''): Promise<{ chats: SDKChat[]; total: number }> {
    const size = 25;
    const sources = ['', ...this.remoteHosts.filter(host => host.state === 'connected').map(host => host.id)];
    const load = async (host: string) => {
      const rows: SDKChat[] = [];
      let total = 0;
      for (let index = 0; index <= page; index++) {
        if (index > 0 && index * size >= total) break;
        const params = new URLSearchParams({archived:'true', page:String(index), q:query});
        const response = await fetch(apiPath(remoteChatPath(host, `/api/sdk-chats?${params}`)));
        if (!response.ok) throw new Error(await response.text());
        const result = await response.json() as {chats:SDKChat[];total:number};
        total = result.total;
        rows.push(...result.chats.map(chat => ({...chat, remoteHost:host || undefined})));
      }
      return {rows,total};
    };
    const local = await load('');
    const remote = await Promise.allSettled(sources.slice(1).map(load));
    const available = [local, ...remote.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])];
    const all = available.flatMap(result => result.rows).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const chats = all.slice(page * size, (page + 1) * size);
    for (const chat of chats) {
      this.archivedCache.delete(chat.id);
      this.archivedCache.set(chat.id,chat);
      rememberChatHost(chat.id,chat.remoteHost || '');
    }
    while (this.archivedCache.size > 75) this.archivedCache.delete(this.archivedCache.keys().next().value!);
    this.chats = [...this.chats.filter(chat => !chat.archived), ...this.archivedCache.values()];
    return {chats,total:available.reduce((sum,result) => sum + result.total,0)};
  }
  async create(request: { remoteHost?: string; workspaceId?: string; projectPath?: string; workMode?: 'local' | 'worktree'; harness: string; provider: string; bundle?: string; model?: string; effort?: string; prompt: string; attachments?: string[]; operatorId?: string }) {
    const host = request.remoteHost || (request.workspaceId ? projectHost(request.workspaceId) : '');
    const response = await fetch(apiPath(remoteChatPath(host, '/api/sdk-chats')), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    if (!response.ok) throw new Error(await response.text());
    const chat = {...await response.json() as SDKChat, remoteHost: host || undefined};
    rememberChatHost(chat.id, host);
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
  async unlinkOperatorLane(operatorId: string, laneId: string): Promise<SDKChat> {
    const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(operatorId)}/operator`), { method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({laneId}) });
    if (!response.ok) throw new Error(await response.text());
    const operator = await response.json() as SDKChat;
    await this.refresh();
    return operator;
  }
  async createProject(path: string, name = '', sourceFolders: string[] = [], createFolder = false, managedFolder = false, host = '') {
    const response = await fetch(apiPath(remoteChatPath(host, '/api/sdk-projects')), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, name, sourceFolders, createFolder, managedFolder }) });
    if (!response.ok) throw new Error(await response.text());
    const project = {...await response.json() as SDKProject, remoteHost: host || undefined};
    rememberProjectHost(project.id, host);
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
    if (projectId && chatHost(sessionId) !== projectHost(projectId)) throw new Error('Choose a project on the same machine as this chat.');
    const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(sessionId)}/project`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId }),
    });
    if (!response.ok) throw new Error(await response.text());
    await this.refresh();
  }
  async folders(path = '', host = ''): Promise<FolderListing> {
    const response = await fetch(apiPath(remoteChatPath(host, `/api/sdk-folders${path ? `?path=${encodeURIComponent(path)}` : ''}`)));
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<FolderListing>;
  }
}
export const sdkChats = new SDKChatStore();
