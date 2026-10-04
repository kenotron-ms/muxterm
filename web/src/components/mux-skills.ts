import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';

type InstalledSkill = { name:string; scope:string; agents:string[]; source:string; sourceUrl:string };
type CatalogSkill = { id:string; name:string; source:string; installs:number };

@customElement('mux-skills')
export class MuxSkills extends LitElement {
  @state() private installed: InstalledSkill[] = [];
  @state() private results: CatalogSkill[] = [];
  @state() private query = '';
  @state() private loading = true;
  @state() private searching = false;
  @state() private installing = '';
  @state() private error = '';
  @state() private notice = '';
  private searchTimer?: number;
  private searchGeneration = 0;
  private refreshGeneration = 0;

  static override styles = css`
    :host { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; overflow:hidden; background:var(--chrome-body); color:var(--chrome-text-bright); font:13px/1.5 system-ui,sans-serif; }
    button,input { font:inherit; } button { cursor:pointer; }
    .top { padding:20px 28px; border-bottom:1px solid var(--chrome-border); background:var(--chrome-bar); }
    .eyebrow { color:var(--chrome-accent); font-size:10px; letter-spacing:.13em; text-transform:uppercase; font-weight:700; }
    h1 { margin:1px 0; font-size:22px; letter-spacing:-.02em; }
    .subtitle,.hint { color:var(--chrome-text-dim); font-size:12px; }
    .content { flex:1; overflow:auto; padding:22px 28px 40px; }
    h2 { margin:0 0 12px; font-size:14px; }
    .section { max-width:900px; margin:0 0 28px; }
    .search { display:flex; gap:9px; margin-bottom:13px; }
    input { box-sizing:border-box; flex:1; min-width:0; border:1px solid var(--chrome-border); border-radius:7px; padding:9px 11px; background:var(--chrome-bar); color:var(--chrome-text-bright); }
    .list { border:1px solid var(--chrome-border); border-radius:10px; overflow:hidden; background:var(--chrome-bar); }
    .row { display:flex; align-items:center; gap:15px; padding:12px 15px; border-bottom:1px solid var(--chrome-border); }
    .row:last-child { border-bottom:0; }
    .body { min-width:0; flex:1; }
    .name { font-weight:650; } .meta { color:var(--chrome-text-dim); font-size:11px; overflow-wrap:anywhere; }
    .actions { display:flex; align-items:center; gap:10px; flex:none; }
    a { color:var(--chrome-accent); font-size:12px; }
    button { border:1px solid var(--chrome-border); border-radius:7px; padding:6px 10px; background:transparent; color:var(--chrome-text-bright); }
    button:hover { background:var(--chrome-hover); } button:disabled { opacity:.55; cursor:default; }
    .empty { padding:20px; color:var(--chrome-text-dim); }
    .error { color:var(--chrome-danger); margin:0 0 12px; }
    .notice { color:var(--mux-ok); margin:0 0 12px; }
    .footnote { max-width:900px; padding-top:10px; border-top:1px solid var(--chrome-border); color:var(--chrome-text-dim); font-size:11px; }
    @media(max-width:600px) { .top { padding:16px; } .content { padding:17px 16px; } .row { align-items:flex-start; flex-direction:column; gap:8px; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    if (this.query.trim().length >= 2) void this.search(this.query.trim());
  }
  override disconnectedCallback() {
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.refreshGeneration++;
    this.searchGeneration++;
    this.searching = false;
    super.disconnectedCallback();
  }

  private async refresh(): Promise<boolean | undefined> {
    const generation = ++this.refreshGeneration;
    this.loading = true;
    try {
      const response = await fetch(apiPath('/api/skills'));
      if (!response.ok) throw new Error(await response.text());
      const installed: unknown = await response.json();
      if (!Array.isArray(installed)) throw new Error('invalid installed skills response');
      if (generation !== this.refreshGeneration || !this.isConnected) return;
      this.installed = installed as InstalledSkill[]; this.error = '';
      return true;
    } catch (error) {
      if (generation !== this.refreshGeneration || !this.isConnected) return;
      this.error = `Could not load installed skills: ${String(error)}`;
      return false;
    }
    finally { if (generation === this.refreshGeneration) this.loading = false; }
  }

  private onQuery(value: string) {
    this.query = value;
    this.notice = '';
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    if (value.trim().length < 2) { this.results = []; this.searching = false; this.searchGeneration++; return; }
    this.searchTimer = window.setTimeout(() => void this.search(value.trim()), 250);
  }

  private async search(query: string) {
    const generation = ++this.searchGeneration;
    this.searching = true;
    try {
      const response = await fetch(apiPath(`/api/skills/search?q=${encodeURIComponent(query)}`));
      if (!response.ok) throw new Error(await response.text());
      const results: unknown = await response.json();
      if (!Array.isArray(results)) throw new Error('invalid skills catalog response');
      if (generation === this.searchGeneration) { this.results = results as CatalogSkill[]; this.error = ''; }
    } catch (error) { if (generation === this.searchGeneration) this.error = `Search failed: ${String(error)}`; }
    finally { if (generation === this.searchGeneration) this.searching = false; }
  }

  private async install(skill: CatalogSkill) {
    this.installing = skill.id;
    this.notice = ''; this.error = '';
    try {
      const response = await fetch(apiPath('/api/skills/install'), { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ id:skill.id }) });
      if (!response.ok) throw new Error(await response.text());
      if (!this.isConnected) return;
      const refreshed = await this.refresh();
      if (!this.isConnected) return;
      if (refreshed === true) this.notice = `${skill.name} is installed for new chats in Codex, Claude, and Amplifier.`;
      else if (refreshed === false) {
        this.notice = '';
        this.error = `${skill.name} was installed, but the installed skills list could not be refreshed. Reopen Skills to reload it.`;
      }
    } catch (error) { if (this.isConnected) this.error = `Install failed: ${String(error)}`; }
    finally { this.installing = ''; }
  }

  override render() {
    // The pinned CLI reports `name` as the folder slug and `source` as owner/repo.
    const installedSlugs = new Set(this.installed.map(skill => skill.name));
    const installedIDs = new Set(this.installed.filter(skill => skill.source).map(skill => `${skill.source}/${skill.name}`));
    return html`
      <div class="top"><div class="eyebrow">Extend your chats</div><h1>Skills</h1><div class="subtitle">Find and install shared skills for your chat harnesses.</div></div>
      <div class="content">
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
        ${!this.error && this.notice ? html`<div class="notice" role="status">${this.notice}</div>` : nothing}
        <section class="section"><h2>Installed</h2><div class="list">
          ${this.loading ? html`<div class="empty">Loading skills…</div>` : this.installed.length ? this.installed.map(skill => html`
            <div class="row"><div class="body"><div class="name">${skill.name}</div><div class="meta">${skill.source || 'Local skill'} · ${skill.agents?.length ? skill.agents.join(', ') : 'Shared skills directory'}</div></div></div>`) : html`<div class="empty">No shared skills installed yet.</div>`}
        </div></section>
        <section class="section"><h2>Discover</h2><div class="search"><input aria-label="Search skills" placeholder="Search skills by name or task" .value=${this.query} @input=${(event:Event) => this.onQuery((event.target as HTMLInputElement).value)}></div>
          <div class="list">${this.searching ? html`<div class="empty">Searching…</div>` : this.query.trim().length < 2 ? html`<div class="empty">Enter at least two characters to search the skills catalog.</div>` : this.results.length ? this.results.map(skill => {
            // Keep this UI hint aligned with skillSlug in internal/server/skills.go.
            const installable = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(skill.id);
            const alreadyInstalled = installedIDs.has(skill.id);
            const nameInUse = !alreadyInstalled && installedSlugs.has(skill.id.split('/')[2]);
            const installTitle = nameInUse ? 'A skill with this name is installed from another source' : alreadyInstalled ? 'Already installed' : installable ? 'Install for all chat harnesses' : 'This source cannot be installed from the app';
            return html`<div class="row"><div class="body"><div class="name">${skill.name}</div><div class="meta">${skill.source} · ${skill.installs.toLocaleString()} installs</div></div><div class="actions"><a href=${`https://skills.sh/${encodeURI(skill.id)}`} target="_blank" rel="noopener noreferrer">Details</a><button ?disabled=${!installable || !!this.installing || alreadyInstalled || nameInUse} title=${installTitle} @click=${() => void this.install(skill)}>${alreadyInstalled ? 'Installed' : nameInUse ? 'Name in use' : this.installing === skill.id ? 'Installing…' : 'Install'}</button></div></div>`;
          }) : html`<div class="empty">No skills found.</div>`}</div>
        </section>
        <p class="footnote">Skills installed here are shared with Codex, Claude, and Amplifier chats. ACP harness support is being developed separately.</p>
      </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-skills': MuxSkills } }
