import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import '../ui/button.js';
import '../ui/feedback.js';
import '../ui/page-intro.js';
import '../ui/text-field.js';
import type { MuxUITextField } from '../ui/text-field.js';

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
    .titlebar { box-sizing:border-box; height:var(--mux-titlebar-height,44px); flex:none; display:flex; align-items:center; gap:7px; min-width:0; padding:0 max(12px,var(--wco-right-inset,0px)) 0 16px; border-bottom:1px solid var(--chrome-border); background:var(--mux-titlebar-bg,var(--chrome-bar)); font-size:13px; }
    .titlebar .section-name,.titlebar .divider { color:var(--ui-text-muted); }
    .titlebar strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    @media (display-mode: window-controls-overlay) { .titlebar { -webkit-app-region:drag; } }
    .content { flex:1; overflow:auto; padding:22px 28px 40px; }
    h2 { margin:0 0 12px; font-size:14px; }
    .section { max-width:900px; margin:0 0 28px; }
    .search { display:flex; gap:9px; margin-bottom:13px; }
    mux-ui-text-field { width:100%; }
    .list { border:1px solid var(--chrome-border); border-radius:10px; overflow:hidden; background:var(--chrome-bar); }
    .row { display:flex; align-items:center; gap:15px; padding:12px 15px; border-bottom:1px solid var(--chrome-border); }
    .row:last-child { border-bottom:0; }
    .body { min-width:0; flex:1; }
    .name { font-weight:650; } .meta { color:var(--ui-text-muted); font-size:11px; overflow-wrap:anywhere; }
    .actions { display:flex; align-items:center; gap:10px; flex:none; }
    a { color:var(--chrome-accent); font-size:12px; }
    .content > mux-ui-feedback { margin-bottom:var(--ui-space-5); }
    .footnote { max-width:900px; padding-top:10px; border-top:1px solid var(--chrome-border); color:var(--ui-text-muted); font-size:11px; }
    @media(max-width:767.98px) { .titlebar { display:none; } }
    @media(max-width:600px) { .content { padding:17px 16px; } .row { align-items:flex-start; flex-direction:column; gap:8px; } }
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
      <header class="titlebar"><span class="section-name">Tools</span><span class="divider" aria-hidden="true">›</span><strong>Skills</strong></header>
      <mux-ui-page-intro heading="Skills" description="Find and install shared skills for your chats."></mux-ui-page-intro>
      <div class="content">
        ${this.error ? html`<mux-ui-feedback kind="error" appearance="panel">${this.error}</mux-ui-feedback>` : nothing}
        ${!this.error && this.notice ? html`<mux-ui-feedback kind="success" appearance="panel">${this.notice}</mux-ui-feedback>` : nothing}
        <section class="section"><h2>Installed</h2><div class="list">
          ${this.loading ? html`<mux-ui-feedback kind="loading">Loading skills…</mux-ui-feedback>` : this.installed.length ? this.installed.map(skill => html`
            <div class="row"><div class="body"><div class="name">${skill.name}</div><div class="meta">${skill.source || 'Local skill'} · ${skill.agents?.length ? skill.agents.join(', ') : 'Shared skills directory'}</div></div></div>`) : html`<mux-ui-feedback>No shared skills installed yet.</mux-ui-feedback>`}
        </div></section>
        <section class="section"><h2>Discover</h2><div class="search"><mux-ui-text-field type="search" aria-label="Search skills" placeholder="Search skills by name or task" .value=${this.query} @input=${(event:Event) => this.onQuery((event.target as MuxUITextField).value)}></mux-ui-text-field></div>
          <div class="list">${this.searching ? html`<mux-ui-feedback kind="loading">Searching…</mux-ui-feedback>` : this.query.trim().length < 2 ? html`<mux-ui-feedback>Enter at least two characters to search the skills catalog.</mux-ui-feedback>` : this.results.length ? this.results.map(skill => {
            // Keep this UI hint aligned with skillSlug in internal/server/skills.go.
            const installable = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(skill.id);
            const alreadyInstalled = installedIDs.has(skill.id);
            const nameInUse = !alreadyInstalled && installedSlugs.has(skill.id.split('/')[2]);
            const installTitle = nameInUse ? 'A skill with this name is installed from another source' : alreadyInstalled ? 'Already installed' : installable ? 'Install for all chat harnesses' : 'This source cannot be installed from the app';
            return html`<div class="row"><div class="body"><div class="name">${skill.name}</div><div class="meta">${skill.source} · ${skill.installs.toLocaleString()} installs</div></div><div class="actions"><a href=${`https://skills.sh/${encodeURI(skill.id)}`} target="_blank" rel="noopener noreferrer">Details</a><mux-ui-button size="small" ?disabled=${!installable || !!this.installing || alreadyInstalled || nameInUse} ?busy=${this.installing === skill.id} title=${installTitle} @click=${() => void this.install(skill)}>${alreadyInstalled ? 'Installed' : nameInUse ? 'Name in use' : this.installing === skill.id ? 'Installing…' : 'Install'}</mux-ui-button></div></div>`;
          }) : html`<mux-ui-feedback>No skills found.</mux-ui-feedback>`}</div>
        </section>
        <p class="footnote">Skills installed here are shared with Codex, Claude, and Amplifier chats. ACP harness support is being developed separately.</p>
      </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-skills': MuxSkills } }
