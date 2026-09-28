export interface SDKChatSession {
  id: string;
  workspaceId: string;
  projectPath: string;
  harness: 'codex' | 'claude' | 'amplifier';
  title: string;
  state: string;
  createdAt: string;
}
export interface SDKChatEvent {
  seq: number;
  session_id: string;
  type: string;
  text?: string;
  kind?: string;
  input_id?: string;
  tool?: string;
  tool_id?: string;
  detail?: {id?: string; command?: string; aggregated_output?: string; content?: unknown};
  message?: string;
}
class SDKChatStore {
  sessions: SDKChatSession[] = [];
  selected = '';
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit() { for (const listener of this.listeners) listener(); }
  async refresh() {
    const response = await fetch('/api/sdk-chats');
    if (!response.ok) throw new Error(`SDK chats: ${response.status}`);
    const rows = await response.json() as SDKChatSession[];
    // A refresh that began before Create must not erase the newly accepted row.
    this.sessions = [...rows, ...this.sessions.filter(local => !rows.some(row => row.id === local.id))];
    this.emit();
  }
  select(id: string) { this.selected = id; this.emit(); }
  mark(id: string, state: string) {
    const session=this.sessions.find(s=>s.id===id);
    if(session && session.state!==state) {session.state=state;this.emit();}
  }
  async create(input: {workspaceId: string; projectPath: string; harness: string; prompt: string}) {
    const response = await fetch('/api/sdk-chats', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input) });
    const data = await response.json() as SDKChatSession & { error?: string };
    if (!response.ok) throw new Error(data.error || `SDK chat: ${response.status}`);
    this.sessions = [...this.sessions, data]; this.select(data.id);
    return data;
  }
}
export const sdkChatStore = new SDKChatStore();
