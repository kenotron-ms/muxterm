import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { store } from '../state.js';
import { homeSessions } from '../lib/home-sessions.js';
import { LAUNCHABLE_HARNESSES, harnessLabel, type HarnessName } from '../lib/harness.js';
import { sdkChatStore } from '../lib/sdk-chat-store.js';

interface ChatRow {
  id: string;
  paneId: number;
  title: string;
  harness: HarnessName;
  status: string;
}
interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  chats: ChatRow[];
}

// A workspace owns its disclosure state. The parent reuses this model object
// until one of its visible fields changes, so another workspace's state tick
// never asks this element to render or replaces its DOM.
@customElement('mux-chat-workspace')
export class MuxChatWorkspace extends LitElement {
  @property({ attribute: false }) model!: WorkspaceRow;
  @property() selectedWorkspace = '';
  @property({ type: Number }) selectedPane = 0;
  @property() selectedChat = '';
  @state() private open = true;

  static styles = css`
    :host { display: block; margin: 2px 6px; font: 12px/1.35 system-ui, sans-serif; color: var(--chrome-text-bright, #d8dce5); }
    button { font: inherit; color: inherit; border: 0; cursor: pointer; background: transparent; }
    .workspace { display: flex; align-items: center; width: 100%; min-height: 38px; gap: 7px; padding: 4px 7px; text-align: left; border-radius: 6px; }
    .workspace:hover, .chat:hover { background: rgba(255,255,255,.07); }
    .chevron { width: 12px; color: var(--chrome-text-dim, #9299a5); flex: none; }
    .identity { min-width: 0; flex: 1; }
    .name, .path, .title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .name { font-weight: 600; }
    .path { font-size: 10px; color: var(--chrome-text-dim, #9299a5); }
    .chats { margin: 1px 0 7px 20px; }
    .chat { width: 100%; min-height: 31px; padding: 5px 8px; text-align: left; border-radius: 6px; display: flex; align-items: center; gap: 6px; }
    .chat[selected] { background: rgba(122,162,247,.16); color: var(--chrome-text-bright, #e6ebff); }
    .title { flex: 1; min-width: 0; }
    .harness { flex: none; color: var(--chrome-text-dim, #9299a5); font-size: 10px; }
    .status { width: 5px; height: 5px; border-radius: 50%; background: #697386; flex: none; }
    .status.working { background: #7dcba1; }
    .status.blocked { background: #e9b56a; }
    .status.uncertain, .status.error { background: #e9b56a; }
    .empty { color: var(--chrome-text-dim, #9299a5); padding: 7px 8px; font-size: 11px; }
  `;

  override render() {
    const row = this.model;
    return html`
      <button class="workspace" title=${row.path} aria-expanded=${this.open} @click=${() => { this.open = !this.open; }}>
        <span class="chevron">${this.open ? '⌄' : '›'}</span>
        <span class="identity"><span class="name">${row.name}</span><span class="path">${row.path}</span></span>
      </button>
      ${this.open ? html`<div class="chats">
        ${repeat(row.chats, chat => chat.id, chat => html`
          <button class="chat" ?selected=${chat.id.startsWith('sdk:') ? this.selectedChat === chat.id.slice(4) : this.selectedWorkspace === row.id && this.selectedPane === chat.paneId}
            title=${chat.title} @click=${() => this.dispatchEvent(new CustomEvent('chat-open', {
              detail: { workspaceId: row.id, paneId: chat.paneId, sessionId: chat.id.startsWith('sdk:') ? chat.id.slice(4) : undefined }, bubbles: true, composed: true,
            }))}>
            <span class="status ${chat.status}" title=${chat.status || 'Live session'}></span>
            <span class="title">${chat.title}</span><span class="harness">${harnessLabel(chat.harness)}</span>
          </button>`)}
        ${row.chats.length === 0 ? html`<div class="empty">No chats yet</div>` : nothing}
      </div>` : nothing}
    `;
  }
}

@customElement('mux-chat-list')
export class MuxChatList extends LitElement {
  @state() private version = 0;
  @state() private creating = false;
  @state() private workspaceId = 'new';
  @state() private folder = '';
  @state() private harness: HarnessName = 'codex';
  @state() private prompt = '';
  private unsubs: Array<() => void> = [];
  private cached = new Map<string, { signature: string; row: WorkspaceRow }>();

  static styles = css`
    :host { display: block; color: var(--chrome-text-bright, #d8dce5); font: 12px/1.35 system-ui, sans-serif; }
    .heading { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px 3px; color: var(--chrome-text-dim, #9299a5); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
    button { font: inherit; cursor: pointer; }
    .add { border: 0; background: transparent; color: var(--chrome-text-bright, #d8dce5); font-size: 20px; line-height: 18px; border-radius: 4px; width: 23px; height: 23px; }
    .add:hover { background: rgba(255,255,255,.08); }
    .hint { color: var(--chrome-text-dim, #9299a5); margin: 8px 15px 12px; }
    .overlay { position: fixed; inset: 0; z-index: 10000; background: rgba(8,10,16,.62); display: grid; place-items: center; }
    .dialog { box-sizing: border-box; width: min(440px, calc(100vw - 28px)); padding: 20px; border: 1px solid var(--chrome-border, #3b4355); border-radius: 12px; background: var(--chrome-bar, #202632); box-shadow: 0 20px 70px #0008; }
    h2 { font-size: 17px; margin: 0 0 17px; letter-spacing: 0; }
    label { display: block; margin: 13px 0 6px; color: var(--chrome-text-dim, #a4adbc); font-size: 11px; }
    select, input, textarea { box-sizing: border-box; width: 100%; border: 1px solid var(--chrome-border, #3b4355); border-radius: 7px; background: rgba(0,0,0,.2); color: var(--chrome-text-bright, #ecf0f7); font: 13px system-ui, sans-serif; padding: 10px; outline: none; }
    select:focus, input:focus, textarea:focus { border-color: #7aa2f7; }
    textarea { min-height: 92px; resize: vertical; }
    .harnesses { display: flex; gap: 6px; }
    .harnesses button { flex: 1; min-width: 0; padding: 8px 4px; border: 1px solid var(--chrome-border, #3b4355); border-radius: 6px; color: var(--chrome-text-bright, #d8dce5); background: transparent; }
    .harnesses button[aria-pressed="true"] { border-color: #7aa2f7; background: rgba(122,162,247,.15); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    .actions button { border: 0; border-radius: 7px; padding: 9px 13px; color: #e9edf6; background: rgba(255,255,255,.08); }
    .actions .start { background: #6d8fdb; color: #111827; font-weight: 650; }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.unsubs = [store.subscribe(() => this.version++), homeSessions.subscribe(() => this.version++), sdkChatStore.subscribe(() => this.version++)];
    void sdkChatStore.refresh().catch(error => console.error(error));
  }
  override disconnectedCallback() {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    super.disconnectedCallback();
  }

  private rows(): WorkspaceRow[] {
    const rows: WorkspaceRow[] = [];
    for (const ws of store.workspaces) {
      if (!ws.projectPath) continue; // legacy terminal workspaces retain their existing navigation
      const sessions = homeSessions.sessions.filter(s => s.workspaceId === ws.workspaceId);
      const chats: ChatRow[] = [];
      for (const pane of ws.panes ?? []) {
        const session = sessions.find(s => s.paneId === pane.paneId);
        const harness = pane.harness ?? session?.harness;
        if (harness !== 'amplifier' && harness !== 'claude' && harness !== 'codex') continue;
        chats.push({ id: `pane:${pane.paneId}`, paneId: pane.paneId, title: session?.name || pane.title || 'New chat', harness: harness as HarnessName, status: session?.state ?? '' });
      }
      for (const chat of sdkChatStore.sessions) {
        if (chat.workspaceId !== ws.workspaceId) continue;
        chats.push({ id: `sdk:${chat.id}`, paneId: 0, title: chat.title, harness: chat.harness, status: chat.state });
      }
      const parts = ws.projectPath.split('/').filter(Boolean);
      const name = ws.name || parts[parts.length - 1] || ws.projectPath;
      const signature = JSON.stringify([name, ws.projectPath, chats]);
      const previous = this.cached.get(ws.workspaceId);
      if (previous?.signature === signature) rows.push(previous.row);
      else {
        const row = { id: ws.workspaceId, name, path: ws.projectPath, chats };
        this.cached.set(ws.workspaceId, { signature, row });
        rows.push(row);
      }
    }
    for (const id of this.cached.keys()) if (!rows.some(row => row.id === id)) this.cached.delete(id);
    return rows;
  }

  private submit() {
    const projectPath = this.folder.trim();
    if (this.workspaceId === 'new' && !projectPath.startsWith('/')) return;
    if (!this.prompt.trim()) return;
    this.dispatchEvent(new CustomEvent('chat-create', {
      detail: { workspaceId: this.workspaceId === 'new' ? null : this.workspaceId,
        projectPath: this.workspaceId === 'new' ? projectPath : undefined,
        harness: this.harness, prompt: this.prompt.trim() }, bubbles: true, composed: true,
    }));
    this.creating = false;
    this.prompt = '';
  }

  override render() {
    void this.version;
    const rows = this.rows();
    return html`
      <div class="heading"><span>Chats</span><button class="add" aria-label="New chat" title="New chat" @click=${() => { this.creating = true; }}>＋</button></div>
      ${rows.length ? repeat(rows, row => row.id, row => html`
        <mux-chat-workspace .model=${row} .selectedWorkspace=${store.attached ?? ''} .selectedPane=${store.activePaneId ?? 0} .selectedChat=${sdkChatStore.selected}></mux-chat-workspace>
      `) : html`<div class="hint">Choose a folder and start a chat.</div>`}
      ${this.creating ? html`<div class="overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) this.creating = false; }}>
        <form class="dialog" @submit=${(e: Event) => { e.preventDefault(); this.submit(); }}>
          <h2>New chat</h2>
          <label for="workspace">Workspace</label>
          <select id="workspace" .value=${this.workspaceId} @change=${(e: Event) => { this.workspaceId = (e.target as HTMLSelectElement).value; }}>
            <option value="new">＋ New workspace</option>
            ${rows.map(row => html`<option value=${row.id}>${row.name} · ${row.path}</option>`)}
          </select>
          ${this.workspaceId === 'new' ? html`<label for="folder">Project folder</label><input id="folder" type="text" required placeholder="/home/ken/work/my-project" .value=${this.folder} @input=${(e: Event) => { this.folder = (e.target as HTMLInputElement).value; }}>` : nothing}
          <label>Harness</label><div class="harnesses">${LAUNCHABLE_HARNESSES.map(h => html`<button type="button" aria-pressed=${this.harness === h} @click=${() => { this.harness = h; }}>${harnessLabel(h)}</button>`)}</div>
          <label for="prompt">First message</label><textarea id="prompt" required placeholder="What would you like to work on?" .value=${this.prompt} @input=${(e: Event) => { this.prompt = (e.target as HTMLTextAreaElement).value; }}></textarea>
          <div class="actions"><button type="button" @click=${() => { this.creating = false; }}>Cancel</button><button class="start" type="submit">Start chat ↗</button></div>
        </form>
      </div>` : nothing}
    `;
  }
}
