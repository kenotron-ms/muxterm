import { store } from '../state.js';
import { homeSessions } from '../lib/home-sessions.js';
import { workspaceLabel } from '../lib/workspace-label.js';
import type { SessiondWorkspaceInfo } from '../types.js';
import type { HarnessName } from '../lib/harness.js';

const harnesses = new Set<string>(['amplifier', 'claude', 'codex']);

/** A small, keyed DOM island. Feed updates patch text/classes in place. */
export class MuxChatList extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private rows = new Map<string, HTMLDetailsElement>();
  private unsubscribe: Array<() => void> = [];
  private list!: HTMLDivElement;
  private workspaceSelect!: HTMLSelectElement;
  private dialog!: HTMLDialogElement;
  private revealCreatedChat = false;
  private chatsBeforeCreate = new Set<string>();

  connectedCallback(): void {
    this.rows.clear();
    this.root.innerHTML = `<style>
      :host { display:block; color:var(--chrome-text,#c8cbd0); font:12px/1.35 system-ui,sans-serif; }
      * { box-sizing:border-box; }
      .head { display:flex; align-items:center; justify-content:space-between; padding:12px 10px 5px; color:var(--chrome-text-dim,#9299a3); font-size:10px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; }
      button { color:inherit; font:inherit; cursor:pointer; }
      .add { border:0; background:transparent; border-radius:5px; font-size:19px; line-height:18px; width:22px; height:22px; }
      .add:hover, summary:hover, .chat:hover { background:color-mix(in srgb,var(--chrome-text,#ccc) 10%,transparent); }
      .list { max-height:min(48vh,440px); overflow:auto; scrollbar-width:thin; padding:0 6px 5px; }
      details { margin:1px 0; }
      summary { list-style:none; display:flex; gap:6px; align-items:center; padding:6px 5px; border-radius:5px; cursor:pointer; min-height:30px; }
      summary::-webkit-details-marker { display:none; }
      .chev { display:inline-block; width:9px; color:var(--chrome-text-dim,#9299a3); transition:transform .12s; font-size:10px; }
      details[open] .chev { transform:rotate(90deg); }
      .wsname { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
      .path { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:-2px 0 3px 21px; color:var(--chrome-text-dim,#9299a3); font:10px ui-monospace,monospace; }
      .chats { padding:0 0 2px 15px; }
      .chat { width:100%; border:0; background:transparent; text-align:left; display:flex; align-items:center; gap:6px; border-radius:5px; padding:6px 7px; min-height:29px; }
      .chat.selected { background:color-mix(in srgb,var(--chrome-accent,#779bec) 19%,transparent); color:var(--chrome-text,#fff); }
      .title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
      .badge { color:var(--chrome-text-dim,#9299a3); font:10px ui-monospace,monospace; }
      .empty { color:var(--chrome-text-dim,#9299a3); padding:6px 9px 8px 21px; font-size:11px; }
      dialog { width:min(420px,calc(100vw - 28px)); border:1px solid #464c57; border-radius:12px; background:#20242b; color:#edf0f4; box-shadow:0 24px 80px #0009; padding:20px; }
      dialog::backdrop { background:#0009; }
      h2 { margin:0 0 17px; font-size:18px; font-weight:600; }
      label { display:block; margin:12px 0 5px; color:#b9c0cb; font-size:11px; }
      input, select { width:100%; border:1px solid #505864; border-radius:6px; padding:9px 10px; background:#16191e; color:#f0f2f5; font:13px system-ui,sans-serif; }
      .actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
      .actions button { border:1px solid #505864; border-radius:6px; padding:7px 12px; background:#30353e; }
      .actions .start { background:#d8e8ff; color:#17202b; border-color:#d8e8ff; font-weight:600; }
    </style>
    <div class="head"><span>Chats</span><button class="add" title="New chat" aria-label="New chat">+</button></div>
    <div class="list" aria-label="Workspace chats"></div>
    <dialog aria-label="New chat"><form method="dialog"><h2>New chat</h2>
      <label for="workspace">Workspace</label><select id="workspace"></select>
      <div class="new-folder"><label for="folder">Project folder</label><input id="folder" required placeholder="/home/you/project" autocomplete="off"></div>
      <label for="harness">Harness</label><select id="harness"><option value="amplifier">Amplifier</option><option value="claude">Claude</option><option value="codex">Codex</option></select>
      <label for="prompt">First message</label><input id="prompt" required placeholder="What would you like to work on?" autocomplete="off">
      <div class="actions"><button value="cancel">Cancel</button><button class="start" value="start">Start chat</button></div>
    </form></dialog>`;
    this.list = this.root.querySelector('.list')!;
    this.dialog = this.root.querySelector('dialog')!;
    this.workspaceSelect = this.root.querySelector('#workspace')!;
    this.root.querySelector('.add')!.addEventListener('click', () => this.openCreate());
    this.workspaceSelect.addEventListener('change', () => this.toggleFolder());
    this.dialog.addEventListener('close', () => this.submit());
    this.unsubscribe = [store.subscribe(() => this.patch()), homeSessions.subscribe(() => this.patch())];
    this.patch();
  }

  disconnectedCallback(): void { for (const fn of this.unsubscribe) fn(); this.unsubscribe = []; }

  openCreate(): void {
    const workspaces = store.workspaces.filter(ws => ws.projectPath);
    this.workspaceSelect.replaceChildren();
    for (const ws of workspaces) {
      const option = new Option(`${workspaceLabel(ws)} · ${ws.projectPath}`, ws.workspaceId);
      this.workspaceSelect.add(option);
    }
    this.workspaceSelect.add(new Option('＋ New workspace', 'new'));
    this.workspaceSelect.value = workspaces.find(ws => ws.workspaceId === store.attached)?.workspaceId ?? 'new';
    this.toggleFolder();
    this.dialog.showModal();
  }

  private toggleFolder(): void {
    const isNew = this.workspaceSelect.value === 'new';
    const folder = this.root.querySelector<HTMLInputElement>('#folder')!;
    (this.root.querySelector('.new-folder') as HTMLElement).hidden = !isNew;
    folder.required = isNew;
  }

  private submit(): void {
    if (this.dialog.returnValue !== 'start') return;
    const form = this.dialog.querySelector('form')!;
    if (!form.reportValidity()) { this.dialog.showModal(); return; }
    const workspaceId = this.workspaceSelect.value;
    const projectPath = this.root.querySelector<HTMLInputElement>('#folder')!.value.trim();
    const harness = this.root.querySelector<HTMLSelectElement>('#harness')!.value as HarnessName;
    const prompt = this.root.querySelector<HTMLInputElement>('#prompt')!.value.trim();
    if (!prompt || (workspaceId === 'new' && !projectPath.startsWith('/'))) { this.dialog.showModal(); return; }
    this.chatsBeforeCreate = new Set([...this.root.querySelectorAll<HTMLButtonElement>('.chat')].map(button => `${button.closest('details')?.dataset.workspaceId}:${button.dataset.paneId}`));
    this.revealCreatedChat = true;
    this.dispatchEvent(new CustomEvent('chat-create', { detail: { workspaceId, projectPath, harness, prompt }, bubbles:true, composed:true }));
    this.root.querySelector<HTMLInputElement>('#prompt')!.value = '';
  }

  private patch(): void {
    if (!this.isConnected || !this.list) return;
    const workspaces = store.workspaces.filter(ws => ws.projectPath);
    const live = new Set(workspaces.map(ws => ws.workspaceId));
    for (const [id, row] of this.rows) if (!live.has(id)) { row.remove(); this.rows.delete(id); }
    for (const ws of workspaces) {
      let row = this.rows.get(ws.workspaceId);
      if (!row) {
        row = document.createElement('details');
        row.dataset.workspaceId = ws.workspaceId;
        row.innerHTML = '<summary><span class="chev">▶</span><span class="wsname"></span></summary><span class="path"></span><div class="chats"></div>';
        row.open = true;
        this.rows.set(ws.workspaceId, row);
        this.list.append(row);
      }
      const name = row.querySelector('.wsname')!;
      if (name.textContent !== workspaceLabel(ws)) name.textContent = workspaceLabel(ws);
      const path = row.querySelector<HTMLElement>('.path')!;
      if (path.textContent !== ws.projectPath) path.textContent = ws.projectPath ?? '';
      path.title = ws.projectPath ?? '';
      this.patchChats(row, ws);
    }
  }

  private patchChats(row: HTMLDetailsElement, ws: SessiondWorkspaceInfo): void {
    const container = row.querySelector<HTMLElement>('.chats')!;
    const sessions = homeSessions.sessions.filter(s => s.workspaceId === ws.workspaceId && s.paneId !== null && harnesses.has(s.harness ?? ''));
    const panes = ws.panes ?? [];
    const chats = panes.flatMap(pane => {
      const session = sessions.find(s => s.paneId === pane.paneId);
      const harness = session?.harness ?? pane.harness;
      if (!harnesses.has(harness ?? '')) return [];
      return [{ paneId:pane.paneId, harness:harness!, title:pane.title || session?.name || 'New chat', state:session?.state ?? 'working' }];
    });
    const keys = new Set(chats.map(c => String(c.paneId)));
    for (const element of container.querySelectorAll<HTMLButtonElement>('.chat')) if (!keys.has(element.dataset.paneId!)) element.remove();
    for (const chat of chats) {
      let button = [...container.querySelectorAll<HTMLButtonElement>('.chat')].find(el => el.dataset.paneId === String(chat.paneId));
      if (!button) {
        button = document.createElement('button');
        button.className = 'chat'; button.dataset.paneId = String(chat.paneId);
        button.innerHTML = '<span class="title"></span><span class="badge"></span>';
        button.addEventListener('click', () => this.dispatchEvent(new CustomEvent('chat-open', { detail:{ workspaceId:ws.workspaceId, paneId:chat.paneId, title:button!.querySelector('.title')?.textContent ?? 'New chat', harness:button!.querySelector('.badge')?.textContent?.split(' · ')[0] ?? '' }, bubbles:true, composed:true })));
        container.append(button);
      }
      const title = button.querySelector('.title')!;
      if (title.textContent !== chat.title) title.textContent = chat.title;
      const badge = button.querySelector('.badge')!;
      const label = `${chat.harness} · ${chat.state}`;
      if (badge.textContent !== label) badge.textContent = label;
      button.classList.toggle('selected', store.attached === ws.workspaceId && store.activePaneId === chat.paneId);
      if (this.revealCreatedChat && !this.chatsBeforeCreate.has(`${ws.workspaceId}:${chat.paneId}`) && button.classList.contains('selected')) {
        row.open = true;
        button.scrollIntoView({ block: 'nearest' });
        this.revealCreatedChat = false;
      }
    }
    let empty = container.querySelector<HTMLElement>('.empty');
    if (chats.length === 0 && !empty) { empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No chats yet'; container.append(empty); }
    if (chats.length > 0) empty?.remove();
  }
}

customElements.define('mux-chat-list', MuxChatList);
