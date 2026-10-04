import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';

type MemoryEntry = { id: string; text: string; createdAt: string; updatedAt: string };
type MemoryDocument = { enabled: boolean; entries: MemoryEntry[] };

@customElement('mux-memory')
export class MuxMemory extends LitElement {
  @state() private document: MemoryDocument = { enabled: false, entries: [] };
  @state() private draft = '';
  @state() private editId = '';
  @state() private editText = '';
  @state() private busy = false;
  @state() private error = '';
  private loadGeneration = 0;

  static override styles = css`
    :host { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; overflow:hidden; background:var(--chrome-body); color:var(--chrome-text-bright); font:13px/1.5 system-ui,sans-serif; }
    * { box-sizing:border-box; }
    button, textarea, input { font:inherit; }
    button { cursor:pointer; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:20px 28px; border-bottom:1px solid var(--chrome-border); background:var(--chrome-bar); }
    .eyebrow { color:var(--chrome-accent); font-size:10px; letter-spacing:.13em; text-transform:uppercase; font-weight:700; }
    h1 { margin:1px 0; font-size:22px; letter-spacing:-.02em; }
    .subtitle, .hint { color:var(--chrome-text-dim); font-size:12px; }
    .content { flex:1; min-height:0; overflow:auto; padding:22px 28px 40px; max-width:860px; width:100%; }
    .panel, .entry, .note { border:1px solid var(--chrome-border); border-radius:10px; background:var(--chrome-bar); padding:16px; margin-bottom:14px; }
    .panel-head { display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h2 { margin:0 0 4px; font-size:15px; }
    p { margin:4px 0 0; }
    .switch { display:flex; align-items:center; gap:8px; white-space:nowrap; font-weight:600; }
    .switch input { accent-color:var(--chrome-accent); width:17px; height:17px; }
    textarea { display:block; resize:vertical; min-height:74px; width:100%; padding:10px; border:1px solid var(--chrome-border); border-radius:7px; background:var(--chrome-body); color:var(--chrome-text-bright); }
    .form-actions, .entry-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:9px; }
    .form-actions .hint { margin-right:auto; }
    button { border:1px solid var(--chrome-border); border-radius:7px; padding:7px 11px; background:var(--chrome-hover); color:var(--chrome-text-bright); }
    button.primary { background:var(--chrome-accent); border-color:var(--chrome-accent); color:var(--chrome-body); font-weight:650; }
    button.danger { color:var(--mux-warn); }
    button:disabled { opacity:.5; cursor:default; }
    .entry p { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
    .entry-actions { margin-top:12px; }
    .error { border:1px solid var(--mux-warn); border-radius:7px; padding:10px; margin-bottom:14px; color:var(--mux-warn); }
    .empty { color:var(--chrome-text-dim); padding:12px 0; }
    .note { color:var(--chrome-text-dim); background:transparent; font-size:12px; }
    @media(max-width:600px) { .top { padding:17px; } .content { padding:16px; } .panel-head { align-items:flex-start; flex-direction:column; } }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    try {
      const response = await fetch(apiPath('/api/memory'), { credentials:'same-origin', cache:'no-store' });
      if (!response.ok) throw new Error(await response.text());
      const document = await response.json() as MemoryDocument;
      if (generation === this.loadGeneration) { this.document = document; this.error = ''; }
    } catch (error) {
      if (generation === this.loadGeneration) this.error = String(error);
    }
  }

  private async change(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: object): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    try {
      const response = await fetch(apiPath(path), { method, credentials:'same-origin', headers:body ? { 'Content-Type':'application/json' } : undefined, body:body ? JSON.stringify(body) : undefined });
      if (!response.ok) throw new Error((await response.text()).trim());
      this.document = await response.json() as MemoryDocument;
      this.draft = '';
      this.editId = '';
      this.editText = '';
    } catch (error) { this.error = String(error); }
    finally { this.busy = false; }
  }

  override render() {
    return html`
      <div class="top"><div><div class="eyebrow">Personal context</div><h1>Memory</h1><div class="subtitle">Facts and preferences you choose to share with every chat harness.</div></div></div>
      <main class="content">
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
        <section class="panel"><div class="panel-head"><div><h2>Use memory in chats</h2><p class="hint">When on, saved memories are included with future chat turns across Codex, Claude, and Amplifier.</p></div><label class="switch"><input type="checkbox" aria-label="Use memory in chats" .checked=${this.document.enabled} ?disabled=${this.busy} @change=${(event:Event) => void this.change('PATCH','/api/memory',{enabled:(event.target as HTMLInputElement).checked})}>${this.document.enabled ? 'On' : 'Off'}</label></div></section>
        <section class="panel"><h2>Add a memory</h2><p class="hint">Add durable facts or preferences. Do not save passwords, tokens, or other secrets here.</p><textarea aria-label="New memory" maxlength="500" placeholder="For example: I prefer concise summaries with links to source files." .value=${this.draft} @input=${(event:Event) => { this.draft = (event.target as HTMLTextAreaElement).value; }}></textarea><div class="form-actions"><span class="hint">${this.draft.length}/500 · Up to 30 memories, 3 KB total</span><button class="primary" ?disabled=${this.busy || !this.draft.trim() || this.document.entries.length >= 30} @click=${() => void this.change('POST','/api/memory',{text:this.draft.trim()})}>Save memory</button></div></section>
        <h2>Saved memories (${this.document.entries.length})</h2>
        ${this.document.entries.length ? this.document.entries.map(entry => html`<div class="entry">${this.editId === entry.id ? html`<textarea aria-label="Edit memory" maxlength="500" .value=${this.editText} @input=${(event:Event) => { this.editText = (event.target as HTMLTextAreaElement).value; }}></textarea><div class="entry-actions"><button @click=${() => { this.editId=''; }}>Cancel</button><button class="primary" ?disabled=${this.busy || !this.editText.trim()} @click=${() => void this.change('PATCH',`/api/memory/${entry.id}`,{text:this.editText.trim()})}>Save</button></div>` : html`<p>${entry.text}</p><div class="entry-actions"><button ?disabled=${this.busy} @click=${() => { this.editId=entry.id; this.editText=entry.text; }}>Edit</button><button class="danger" ?disabled=${this.busy} @click=${() => void this.change('DELETE',`/api/memory/${entry.id}`)}>Delete</button></div>`}</div>`) : html`<div class="empty">No memories saved yet.</div>`}
        <div class="note">Stored only on this machine. Changes affect future turns; earlier chat transcripts may still contain context that was previously sent.</div>
      </main>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-memory': MuxMemory } }
