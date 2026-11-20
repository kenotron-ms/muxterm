import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ArrowLeft, FileText, Folder, ListTodo, MessageSquare, Plus, Search, Terminal, X } from 'lucide';
import { icon } from '../lib/icons.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { remotesStore } from '../lib/remotes-store.js';
import { sdkChats, type SDKChat, type SDKProject } from '../lib/sdk-chats.js';

export type PaletteScope = 'all' | 'files';
export type PaletteTarget =
  | { kind:'chat'; chat:SDKChat }
  | { kind:'project'; project:SDKProject }
  | { kind:'file'; project:SDKProject; path:string; chat?:SDKChat }
  | { kind:'work'; id:string; title:string; project:SDKProject; chat?:SDKChat }
  | { kind:'action'; action:'new-chat'|'new-workspace'|'terminal'|'jobs'|'connections'|'skills' };

type Row = { key:string; title:string; context:string; kind:string; target:PaletteTarget; score:number; glyph:typeof Search };
type FileResult = { path:string; name:string };
type WorkResult = { id:string; title:string; projectIds:string[]; status:string };
const RECENT_KEY = 'muxterm.palette.recent';
const ACTIONS: Row[] = [
  {key:'action:new-chat',title:'New chat',context:'Start a conversation',kind:'Action',target:{kind:'action',action:'new-chat'},score:0,glyph:Plus},
  {key:'action:new-workspace',title:'New terminal workspace',context:'Create a workspace',kind:'Action',target:{kind:'action',action:'new-workspace'},score:0,glyph:Plus},
  {key:'action:terminal',title:'Terminal',context:'Open terminal',kind:'Place',target:{kind:'action',action:'terminal'},score:0,glyph:Terminal},
  {key:'action:jobs',title:'Scheduled jobs',context:'Open scheduled jobs',kind:'Place',target:{kind:'action',action:'jobs'},score:0,glyph:ListTodo},
  {key:'action:connections',title:'Connections',context:'Open connections',kind:'Place',target:{kind:'action',action:'connections'},score:0,glyph:Folder},
  {key:'action:skills',title:'Skills',context:'Open skills',kind:'Place',target:{kind:'action',action:'skills'},score:0,glyph:Folder},
];

function rank(query:string, title:string, context:string): number {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const name = title.toLocaleLowerCase();
  const detail = context.toLocaleLowerCase();
  if (!words.every(word => name.includes(word) || detail.includes(word))) return -1;
  return words.reduce((score, word) => score + (name === word ? 120 : name.startsWith(word) ? 80 : name.includes(word) ? 50 : 15), 0);
}

@customElement('mux-global-palette')
export class MuxGlobalPalette extends LitElement {
  @property({type:Boolean,reflect:true}) open = false;
  @property() scope: PaletteScope = 'all';
  @state() private query = '';
  @state() private active = 0;
  @state() private remoteRows: Row[] = [];
  @state() private loading = false;
  @state() private warnings: string[] = [];
  @state() private inventoryVersion = 0;
  private timer?: number;
  private abort?: AbortController;
  private generation = 0;
  private recentRows = new Map<string,Row>();
  private unsubscribe?: () => void;
  private unsubscribeRemote?: () => void;
  private syncViewport=() => {
    const viewport=window.visualViewport;
    this.style.setProperty('--palette-visible-height',`${Math.round(viewport?.height||window.innerHeight)}px`);
    this.style.setProperty('--palette-visible-top',`${Math.round(viewport?.offsetTop||0)}px`);
  };

  static styles = css`
    :host { position:fixed; inset:0; z-index:var(--ui-z-sheet); display:none; color:var(--ui-text); font:var(--ui-text-sm) var(--ui-font-sans); }
    :host([open]) { display:block; }
    * { box-sizing:border-box; }
    dialog { position:fixed; inset:0; width:100vw; max-width:none; height:100dvh; max-height:none; margin:0; border:0; padding:0; overflow:visible; background:transparent; color:inherit; }
    dialog::backdrop { background:transparent; }
    .scrim { position:absolute; inset:0; background:color-mix(in srgb, var(--ui-surface-base) 58%, transparent); backdrop-filter:blur(3px); }
    .panel { position:relative; display:flex; flex-direction:column; width:min(var(--ui-palette-width),calc(100vw - var(--ui-space-10))); max-height:min(var(--ui-palette-width),calc(100dvh - var(--ui-space-15))); margin:var(--ui-space-12) auto 0; overflow:hidden; border:1px solid var(--ui-border); border-radius:var(--ui-radius-xl); background:var(--ui-surface-raised); box-shadow:var(--ui-shadow-side-strong); }
    .top { display:flex; align-items:center; gap:var(--ui-space-3); min-height:var(--ui-palette-top-height); padding:var(--ui-space-3) var(--ui-space-4); border-bottom:1px solid var(--ui-border); }
    .search-icon { display:flex; flex:none; color:var(--ui-accent); }
    input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--ui-text); font:500 var(--ui-text-lg) var(--ui-font-sans); }
    input::placeholder { color:var(--ui-text-muted); }
    .scope { flex:none; color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .close { display:flex; align-items:center; justify-content:center; flex:none; min-width:var(--ui-control-md); min-height:var(--ui-control-md); border:0; border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text-muted); cursor:pointer; }
    .close:hover,.close:focus-visible { background:var(--ui-surface-hover); color:var(--ui-text); outline:2px solid var(--ui-focus); }
    .back-icon { display:none; }
    .body { min-height:var(--ui-palette-body-min-height); overflow:auto; padding:var(--ui-space-3); overscroll-behavior:contain; }
    .group { margin:var(--ui-space-3) var(--ui-space-3) var(--ui-space-2); color:var(--ui-text-muted); font-size:var(--ui-text-xs); font-weight:600; }
    .row { display:flex; align-items:center; width:100%; min-height:var(--ui-palette-row-height); gap:var(--ui-space-4); padding:var(--ui-space-2) var(--ui-space-3); border:0; border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text); text-align:left; cursor:pointer; }
    .row[aria-selected="true"],.row:hover { background:var(--ui-nav-selected); }
    .row:focus-visible { outline:2px solid var(--ui-focus); outline-offset:-2px; }
    .glyph { display:flex; align-items:center; justify-content:center; flex:none; width:var(--ui-palette-glyph-size); height:var(--ui-palette-glyph-size); border-radius:var(--ui-radius-md); background:var(--ui-surface-base); color:var(--ui-accent); }
    .main { display:flex; flex-direction:column; min-width:0; flex:1; gap:var(--ui-space-1); }
    .title,.context { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .title { font-weight:600; }
    .context { color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .kind { flex:none; color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .status { margin:var(--ui-space-5); color:var(--ui-text-muted); line-height:1.5; }
    .warning { margin:var(--ui-space-2) var(--ui-space-5); color:var(--ui-warning); font-size:var(--ui-text-xs); }
    .footer { display:flex; justify-content:space-between; gap:var(--ui-space-3); padding:var(--ui-space-3) var(--ui-space-5); border-top:1px solid var(--ui-border); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    @media(max-width:600px) {
      .panel { width:100vw; height:var(--palette-visible-height,100dvh); max-height:var(--palette-visible-height,100dvh); margin:var(--palette-visible-top,0px) 0 0; border:0; border-radius:0; padding-top:env(safe-area-inset-top,0px); padding-bottom:env(safe-area-inset-bottom,0px); }
      .top { min-height:var(--ui-palette-phone-top-height); padding:var(--ui-space-2) max(var(--ui-space-3),env(safe-area-inset-right,0px)) var(--ui-space-2) max(var(--ui-space-3),env(safe-area-inset-left,0px)); }
      .back-icon { display:flex; }
      .close-icon { display:none; }
      .close { min-width:var(--ui-control-lg); min-height:var(--ui-control-lg); }
      .body { flex:1; min-height:0; padding:var(--ui-space-2); }
      .row { min-height:var(--ui-row-touch); }
      .footer { padding-bottom:max(var(--ui-space-3),env(safe-area-inset-bottom,0px)); }
    }
  `;

  override connectedCallback() { super.connectedCallback(); this.unsubscribe=sdkChats.subscribe(() => { this.inventoryVersion++; if (this.open && this.query.trim().length>=2) this.search(); }); this.unsubscribeRemote=remotesStore.subscribe(() => { this.inventoryVersion++; }); window.visualViewport?.addEventListener('resize',this.syncViewport); window.visualViewport?.addEventListener('scroll',this.syncViewport); this.syncViewport(); }
  override disconnectedCallback() { this.unsubscribe?.(); this.unsubscribeRemote?.(); this.stopSearch(); window.visualViewport?.removeEventListener('resize',this.syncViewport); window.visualViewport?.removeEventListener('scroll',this.syncViewport); super.disconnectedCallback(); }
  override updated(changed:Map<string,unknown>) {
    if (changed.has('open')) {
      const dialog=this.renderRoot.querySelector('dialog');
      if (this.open) { this.syncViewport(); this.query=''; this.active=0; this.remoteRows=[]; this.warnings=[]; if (dialog && !dialog.open) dialog.showModal(); void sdkChats.refresh(); void this.updateComplete.then(() => this.renderRoot.querySelector('input')?.focus()); }
      else { this.stopSearch(); if (dialog?.open) dialog.close(); }
    }
    if (changed.has('scope') && this.open) { this.active=0; this.search(); }
  }
  private stopSearch() { window.clearTimeout(this.timer); this.abort?.abort(); this.generation++; this.loading=false; }
  private search() {
    this.stopSearch(); this.remoteRows=[]; this.warnings=[];
    const q=this.query.trim().slice(0,128);
    if (q.length<2) return;
    const generation=this.generation;
    this.loading=true;
    this.timer=window.setTimeout(() => void this.fetchMatches(q,generation),180);
  }
  private async fetchMatches(query:string,generation:number) {
    const controller=new AbortController(); this.abort=controller;
    let timedOut=false;
    const deadline=window.setTimeout(() => { timedOut=true; controller.abort(); },5000);
    const projects=[...sdkChats.projects];
    const hosts=['',...sdkChats.remoteHosts.filter(host => host.state==='connected').map(host => host.id)];
    const jobs: {label:string; promise:Promise<Row[]>}[]=[];
    if (this.scope==='all') {
      for (const host of hosts) jobs.push({label:`Sessions on ${host || 'Local'}`,promise:(async () => {
        const params=new URLSearchParams({archived:'true',page:'0',q:query});
        const response=await fetch(apiPath(remoteChatPath(host,`/api/sdk-chats?${params}`)),{signal:controller.signal});
        if (!response.ok) throw new Error('Archived sessions unavailable');
        const body=await response.json() as {chats:SDKChat[]};
        return (body.chats||[]).map(chat => this.chatRow({...chat,remoteHost:host||undefined}));
      })()});
      for (const host of hosts) {
        const ids=projects.filter(project => (project.remoteHost||'')===host).map(project => project.id);
        for (let start=0;start<ids.length;start+=32) jobs.push({label:`Work on ${host || 'Local'}`,promise:(async () => {
          const params=new URLSearchParams(); ids.slice(start,start+32).forEach(id => params.append('project_id',id));
          const response=await fetch(apiPath(remoteChatPath(host,`/api/sdk-work?${params}`)),{signal:controller.signal});
          if (!response.ok) throw new Error('Work search unavailable');
          const body=await response.json() as {work:WorkResult[]};
          return (body.work||[]).flatMap(item => {
            const project=projects.find(row => (row.remoteHost||'')===host && item.projectIds?.includes(row.id));
            if (!project) return [];
            const row=this.workRow(item,project);
            const score=rank(query,row.title,row.context);
            return score>=0 ? [{...row,score}] : [];
          }).sort((a,b) => b.score-a.score).slice(0,100);
        })()});
      }
    }
    // Bound concurrent filesystem scans; each server scan also has its own traversal cap.
    const scan=async (project:SDKProject):Promise<Row[]> => {
      const path=`/api/sdk-projects/${encodeURIComponent(project.id)}/utility/search?q=${encodeURIComponent(query)}`;
      const response=await fetch(apiPath(remoteChatPath(project.remoteHost||'',path)),{signal:controller.signal});
      if (!response.ok) throw new Error(`Files unavailable in ${project.name}`);
      const body=await response.json() as {results:FileResult[]};
      return (body.results||[]).slice(0,60).map(file => this.fileRow(file,project));
    };
    // Each worker claims an index before awaiting the scan, so no project is scanned twice.
    let nextProject=0;
    const fileWorker=async ():Promise<Row[]> => {
      const found:Row[]=[];
      while (nextProject<projects.length && !controller.signal.aborted) {
        const project=projects[nextProject++];
        try { found.push(...await scan(project)); }
        catch { if (!controller.signal.aborted) this.warnings=[...this.warnings,`${project.name}: files unavailable`]; }
      }
      return found;
    };
    for (let index=0;index<Math.min(4,projects.length);index++) jobs.push({label:'Files',promise:fileWorker()});
    const results=await Promise.allSettled(jobs.map(job => job.promise));
    window.clearTimeout(deadline);
    if (generation!==this.generation) return;
    if (controller.signal.aborted && !timedOut) { this.loading=false; return; }
    const previousRows=this.rows();
    const selectedKey=previousRows[Math.max(0,Math.min(this.active,previousRows.length-1))]?.key;
    this.remoteRows=results.flatMap(result => result.status==='fulfilled' ? result.value : []);
    const nextIndex=selectedKey ? this.rows().findIndex(row => row.key===selectedKey) : -1;
    this.active=nextIndex>=0 ? nextIndex : 0;
    this.warnings=[...new Set([...this.warnings,...results.flatMap((result,index) => result.status==='rejected' && !timedOut ? [`${jobs[index].label} is partly unavailable.`] : []),...(timedOut ? ['Search timed out; showing available results.'] : [])])];
    this.loading=false;
  }
  private context(project?:SDKProject, host?:string):string {
    const machine=host ? sdkChats.remoteHosts.find(row => row.id===host)?.name || host : 'Local';
    return project ? `${project.name} · ${machine}` : machine;
  }
  private chatRow(chat:SDKChat):Row {
    const project=sdkChats.projects.find(row => row.id===chat.workspaceId && (row.remoteHost||'')===(chat.remoteHost||''));
    return {key:`chat:${chat.remoteHost||'local'}:${chat.id}`,title:chat.title||'Untitled chat',context:`${this.context(project,chat.remoteHost)} · ${chat.archived?'Archived':chat.state}`,kind:'Session',target:{kind:'chat',chat},score:0,glyph:MessageSquare};
  }
  private fileRow(file:FileResult,project:SDKProject):Row {
    const chat=sdkChats.chats.find(row => row.workspaceId===project.id && (row.remoteHost||'')===(project.remoteHost||'') && !row.archived);
    return {key:`file:${project.remoteHost||'local'}:${project.id}:${file.path}`,title:file.name,context:`${file.path} · ${this.context(project,project.remoteHost)}`,kind:'File',target:{kind:'file',project,path:file.path,chat},score:0,glyph:FileText};
  }
  private workRow(item:WorkResult,project:SDKProject):Row {
    const chat=sdkChats.chats.find(row => row.workspaceId===project.id && (row.remoteHost||'')===(project.remoteHost||'') && !row.archived);
    return {key:`work:${project.remoteHost||'local'}:${item.id}`,title:item.title,context:`${this.context(project,project.remoteHost)} · ${item.status}`,kind:'Work',target:{kind:'work',id:item.id,title:item.title,project,chat},score:0,glyph:ListTodo};
  }
  private rows():Row[] {
    void this.inventoryVersion;
    const q=this.query.trim();
    const active=sdkChats.chats.filter(chat => !chat.archived).map(chat => this.chatRow(chat));
    const projects=sdkChats.projects.map(project => ({key:`project:${project.remoteHost||'local'}:${project.id}`,title:project.name,context:this.context(undefined,project.remoteHost),kind:'Project',target:{kind:'project',project} as PaletteTarget,score:0,glyph:Folder}));
    const rows=this.scope==='files' ? [...this.remoteRows] : [...active,...projects,...ACTIONS,...this.remoteRows];
    const unique=[...new Map(rows.map(row => [row.key,row])).values()];
    if (q) return unique.map(row => ({...row,score:rank(q,row.title,row.context)})).filter(row => row.score>=0).sort((a,b) => b.score-a.score || a.title.localeCompare(b.title)).slice(0,80);
    if (this.scope==='files') return [];
    let recent:string[]=[]; try { recent=JSON.parse(localStorage.getItem(RECENT_KEY)||'[]') as string[]; } catch { /* storage unavailable */ }
    const byKey=new Map(unique.map(row => [row.key,row]));
    const recalled=recent.map(key => byKey.get(key)||this.recentRows.get(key)).filter((row):row is Row => !!row);
    return [...recalled,...ACTIONS.filter(row => !recalled.some(recentRow => recentRow.key===row.key)),...active.slice(0,6).filter(row => !recalled.some(recentRow => recentRow.key===row.key))].slice(0,14);
  }
  private choose(row:Row) {
    this.recentRows.delete(row.key);
    this.recentRows.set(row.key,row);
    if (this.recentRows.size>12) {
      const oldest=this.recentRows.keys().next().value;
      if (oldest) this.recentRows.delete(oldest);
    }
    try { const previous=JSON.parse(localStorage.getItem(RECENT_KEY)||'[]') as string[]; localStorage.setItem(RECENT_KEY,JSON.stringify([row.key,...previous.filter(key => key!==row.key)].slice(0,12))); } catch { /* storage unavailable */ }
    this.dispatchEvent(new CustomEvent<PaletteTarget>('palette-select',{detail:row.target,bubbles:true,composed:true}));
  }
  private dismiss() { this.dispatchEvent(new CustomEvent('palette-dismiss',{bubbles:true,composed:true})); }
  private onKey(event:KeyboardEvent) {
    const rows=this.rows();
    const active=rows.length ? Math.max(0,Math.min(this.active,rows.length-1)) : -1;
    if (event.key==='Tab') {
      const controls=[...this.renderRoot.querySelectorAll<HTMLElement>('input,button')];
      if (event.shiftKey && this.shadowRoot?.activeElement===controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && this.shadowRoot?.activeElement===controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      return;
    }
    if (event.key==='ArrowDown') { event.preventDefault(); this.active=Math.min(rows.length-1,active+1); this.renderRoot.querySelector(`[data-index="${this.active}"]`)?.scrollIntoView({block:'nearest'}); }
    else if (event.key==='ArrowUp') { event.preventDefault(); this.active=Math.max(0,active-1); this.renderRoot.querySelector(`[data-index="${this.active}"]`)?.scrollIntoView({block:'nearest'}); }
    else if (event.key==='Enter' && active>=0) { event.preventDefault(); this.choose(rows[active]); }
  }
  override render() {
    const rows=this.rows();
    const active=rows.length ? Math.max(0,Math.min(this.active,rows.length-1)) : -1;
    const noQuery=!this.query.trim();
    const hostWarnings=remotesStore.hosts.filter(host => host.state==='unreachable'||host.state==='reconnecting').map(host => `${host.name} is unavailable; showing available results.`);
    return html`<dialog aria-label="Search and launch" @cancel=${(event:Event) => { event.preventDefault(); this.dismiss(); }}><div class="scrim" @click=${() => this.dismiss()}></div><section class="panel" @keydown=${(event:KeyboardEvent) => this.onKey(event)}>
      <div class="top"><span class="search-icon">${icon(Search,{size:20})}</span><input type="search" role="combobox" aria-autocomplete="list" aria-label=${this.scope==='files'?'Search project files':'Search sessions, files, Work, and projects'} aria-controls="results" aria-expanded=${String(this.open)} aria-activedescendant=${active>=0?`option-${active}`:nothing} placeholder=${this.scope==='files'?'Find a file…':'Search or jump to…'} autocomplete="off" .value=${this.query} @input=${(event:Event) => { this.query=(event.target as HTMLInputElement).value.slice(0,128); this.active=0; this.search(); }}><span class="scope">${this.scope==='files'?'Files':'All'}</span><button class="close" aria-label="Close search" @click=${() => this.dismiss()}><span class="back-icon">${icon(ArrowLeft,{size:20})}</span><span class="close-icon">${icon(X,{size:18})}</span></button></div>
      <div class="body" id="results" role="listbox" aria-label="Search results">${rows.length ? html`<div class="group">${noQuery?'Recent and places':'Results'}</div>${rows.map((row,index) => html`<button class="row" id=${`option-${index}`} role="option" aria-selected=${index===active?'true':'false'} data-index=${index} @mouseenter=${() => { this.active=index; }} @click=${() => this.choose(row)}><span class="glyph">${icon(row.glyph,{size:17})}</span><span class="main"><span class="title">${row.title}</span><span class="context">${row.context}</span></span><span class="kind">${row.kind}</span></button>`)}` : html`<p class="status" role="status">${this.loading?'Searching accessible places…':noQuery?'Type two letters to search files, or choose a recent place.':this.query.trim().length<2?'Type another letter to search files and Work.':'No matches. Try a session title, project, file name, or Work title.'}</p>`}${this.loading && rows.length ? html`<p class="status" role="status">Searching files and older sessions…</p>` : nothing}${[...new Set([...this.warnings,...hostWarnings])].map(warning => html`<p class="warning" role="alert">${warning}</p>`)}</div>
      <div class="footer"><span>${this.scope==='files'?'Files in accessible projects':'Sessions · Files · Work · Projects'}</span><span>↑ ↓ choose · Enter open · Esc close</span></div>
    </section></dialog>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-global-palette': MuxGlobalPalette } }
