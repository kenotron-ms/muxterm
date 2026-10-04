import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';

type Service = { id:string; name:string; group:string; description:string; docsUrl:string; endpoint?:string; availability:string };
type GitHubState = { state:string; enabled:boolean; ghInstalled:boolean; serverInstalled:boolean; signedIn:boolean; toolCount:number; checkedAt?:string; error:string };
type ConnectionsResponse = { catalog:Service[]; github:GitHubState };
type RemoteTool = { name:string; description?:string };
type RemoteConnection = { id:string; name:string; endpoint:string; state:string; toolCount:number; checkedAt?:string; error?:string; discoveredTools:RemoteTool[]; allowedTools:string[] };
type RemoteResponse = { items:RemoteConnection[]; callbackUrl:string };

@customElement('mux-connections')
export class MuxConnections extends LitElement {
  @property() initialSelection: 'github' | 'remote' = 'github';
  @state() private data?:ConnectionsResponse;
  @state() private remotes?:RemoteResponse;
  @state() private selected='github';
  @state() private busy='';
  @state() private error='';
  @state() private remoteName='';
  @state() private remoteEndpoint='';
  @state() private remoteIssuer='';
  @state() private allowedDraft:Record<string,string[]>={};
  @state() private remoteClientID='';
  @state() private remoteClientSecret='';
  @state() private remoteScopes='';

  static override styles=css`
    :host { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; overflow:hidden; background:var(--chrome-body); color:var(--chrome-text-bright); font:13px/1.5 system-ui,sans-serif; }
    * { box-sizing:border-box; } button,input { font:inherit; } button { cursor:pointer; }
    header { padding:20px 28px; border-bottom:1px solid var(--chrome-border); background:var(--chrome-bar); }
    .eyebrow { color:var(--chrome-accent); font-size:10px; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }
    h1 { margin:2px 0; font-size:22px; letter-spacing:-.02em; } p { margin:0; color:var(--chrome-text-dim); }
    .layout { min-height:0; display:grid; grid-template-columns:minmax(220px,300px) minmax(0,1fr); flex:1; }
    .catalog { overflow:auto; border-right:1px solid var(--chrome-border); padding:18px 14px 26px; }
    .group { margin:13px 8px 7px; color:var(--chrome-text-dim); font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
    .service { width:100%; padding:10px 11px; display:flex; align-items:center; justify-content:space-between; gap:12px; background:transparent; border:1px solid transparent; border-radius:8px; color:var(--chrome-text-bright); text-align:left; }
    .service:hover,.service.active { background:var(--chrome-hover); } .service.active { border-color:var(--chrome-border); }
    .service strong { display:block; font-size:12px; } .service small { display:block; color:var(--chrome-text-dim); font-size:11px; }
    .dot { width:7px; height:7px; border-radius:50%; background:var(--chrome-text-dim); flex:none; }
    .dot.ready { background:var(--mux-ok); } .dot.attention { background:var(--mux-warn); }
    main { min-width:0; overflow:auto; padding:25px 30px 50px; } .detail { max-width:700px; }
    .head { display:flex; justify-content:space-between; align-items:center; gap:12px; }
    h2 { margin:0; font-size:20px; } h3 { margin:25px 0 8px; font-size:13px; } .badge { padding:3px 9px; border-radius:999px; background:var(--chrome-hover); white-space:nowrap; font-size:11px; }
    .badge.ready { color:var(--mux-ok); } .badge.attention { color:var(--mux-warn); }
    .lead { margin-top:9px; } .box { margin-top:19px; padding:17px; border:1px solid var(--chrome-border); border-radius:10px; background:var(--chrome-bar); }
    label { display:block; margin:13px 0; font-size:12px; font-weight:650; }
    input { display:block; width:100%; margin-top:5px; padding:8px 10px; border:1px solid var(--chrome-border); border-radius:7px; color:var(--chrome-text-bright); background:var(--chrome-body); }
    input[readonly] { color:var(--chrome-text-dim); }
    input[type=checkbox] { display:inline; width:auto; margin:0 7px 0 0; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
    button.action,a.action { display:inline-flex; align-items:center; justify-content:center; border:1px solid var(--chrome-border); border-radius:7px; padding:7px 12px; color:var(--chrome-text-bright); background:var(--chrome-hover); text-decoration:none; }
    button.action.primary { background:var(--chrome-accent); border-color:var(--chrome-accent); color:var(--chrome-body); font-weight:700; }
    button.action:disabled { opacity:.5; cursor:default; } a { color:var(--chrome-accent); }
    .error { margin:15px 0; padding:9px 11px; border:1px solid var(--chrome-danger); border-radius:7px; color:var(--chrome-danger); }
    .note { margin-top:11px; font-size:11px; } code { overflow-wrap:anywhere; }
    @media(max-width:700px) { header { padding:14px 16px; } .layout { grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr); } .catalog { display:flex; overflow:auto; border-right:0; border-bottom:1px solid var(--chrome-border); padding:9px; gap:4px; } .group { display:none; } .service { width:auto; min-width:150px; } main { padding:20px 16px 40px; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.selected = this.initialSelection;
    const url=new URL(window.location.href);
    const reason=url.searchParams.get('connection_error');
    if (reason==='denied') this.error='Authorization was cancelled.';
    else if (reason==='failed') this.error='Authorization did not complete. Please try again.';
    if (reason==='denied'||reason==='failed') {
      url.searchParams.delete('connection_error');
      window.history.replaceState(window.history.state,'',url.pathname+url.search+url.hash);
    }
    void this.refresh();
  }
  private async request<T>(path:string, init?:RequestInit):Promise<T> {
    const response=await fetch(apiPath(path), {...init, headers:{'Content-Type':'application/json',...init?.headers}});
    if (!response.ok) throw new Error((await response.text()).trim() || `Request failed (${response.status})`);
    return response.json() as Promise<T>;
  }
  private async refresh() { try { [this.data,this.remotes]=await Promise.all([this.request<ConnectionsResponse>('/api/connections'),this.request<RemoteResponse>('/api/connections/remote')]); } catch(error) { this.error=String(error); } }
  private async run(name:string, action:()=>Promise<unknown>) {
    this.busy=name; this.error='';
    try { await action(); } catch(error) { this.error=error instanceof Error?error.message:String(error); }
    finally { await this.refresh(); this.busy=''; }
  }
  private check() { void this.run('check',()=>this.request('/api/connections/github/check',{method:'POST'})); }
  private disconnect() {
    if (!window.confirm('Disable GitHub tools for new chats? Your GitHub CLI login stays signed in.')) return;
    void this.run('disconnect',()=>this.request('/api/connections/github',{method:'DELETE'}));
  }
  private createRemote() { void this.run('remote-create',async()=>{
    await this.request('/api/connections/remote',{method:'POST',body:JSON.stringify({name:this.remoteName,endpoint:this.remoteEndpoint,issuerURL:this.remoteIssuer,clientID:this.remoteClientID,clientSecret:this.remoteClientSecret,scopes:this.remoteScopes})});
    this.remoteName='';this.remoteEndpoint='';this.remoteIssuer='';this.remoteClientID='';this.remoteClientSecret='';this.remoteScopes='';
  }); }
  private authorizeRemote(id:string) { void this.run('remote-start',async()=>{
    const result=await this.request<{url:string}>(`/api/connections/remote/${encodeURIComponent(id)}/start`,{method:'POST'});
    window.location.assign(result.url);
  }); }
  private checkRemote(id:string) { void this.run('remote-check',()=>this.request(`/api/connections/remote/${encodeURIComponent(id)}/check`,{method:'POST'})); }
  private removeRemote(id:string) { if (!window.confirm('Remove this connection and its saved authorization?')) return;
    void this.run('remote-remove',async()=>{
      await this.request(`/api/connections/remote/${encodeURIComponent(id)}`,{method:'DELETE'});
      const next={...this.allowedDraft};delete next[id];this.allowedDraft=next;
    }); }
  private toggleRemoteTool(item:RemoteConnection,name:string,enabled:boolean) {
    const current=this.allowedDraft[item.id]??item.allowedTools;
    this.allowedDraft={...this.allowedDraft,[item.id]:enabled?[...current,name]:current.filter(tool=>tool!==name)};
  }
  private saveRemoteTools(item:RemoteConnection) { void this.run('remote-tools',async()=>{
    await this.request(`/api/connections/remote/${encodeURIComponent(item.id)}/tools`,{method:'PATCH',body:JSON.stringify({allowedTools:this.allowedDraft[item.id]??item.allowedTools})});
    const next={...this.allowedDraft};delete next[item.id];this.allowedDraft=next;
  }); }
  private remoteDetail() {
    return html`<div class="head"><h2>Remote services</h2><span class="badge">Your connections</span></div>
      <p class="lead">Connect a public HTTPS service using an OAuth app you control. Credentials and tokens stay on this machine. After checking access, choose exactly which tools chats may use.</p>
      <p class="note">Selected tools may change or delete data and can run without a separate muxterm confirmation. Grant only the OAuth scopes and tools you want all chat harnesses to use.</p>
      ${this.remotes?.items.map(item=>html`<div class="box"><div class="head"><strong>${item.name}</strong><span class="badge ${item.state==='ready'?'ready':item.state==='needs-attention'?'attention':''}">${item.state==='ready'?'Ready':item.state==='authorized'?'Authorized':item.state==='needs-attention'?'Needs attention':'Sign in required'}</span></div><p class="note"><code>${item.endpoint}</code></p><p class="note">${item.state==='ready'?`${item.toolCount} tools discovered; ${item.allowedTools.length} enabled for chats.`:item.error||'Authorize, then check access to discover tools.'}</p><div class="actions"><button class="action primary" ?disabled=${!!this.busy} @click=${()=>this.authorizeRemote(item.id)}>${item.state==='authorization-required'?'Authorize':'Reauthorize'}</button><button class="action" ?disabled=${!!this.busy||item.state==='authorization-required'} @click=${()=>this.checkRemote(item.id)}>Check tools</button><button class="action" ?disabled=${!!this.busy} @click=${()=>this.removeRemote(item.id)}>Remove</button></div>
      ${item.discoveredTools?.length?html`<h3>Tools available to enable</h3><p class="note">New tools are off until you select them. Enabled tools appear in new chats across all harnesses.</p>${item.discoveredTools.map(tool=>html`<label><input type="checkbox" .checked=${(this.allowedDraft[item.id]??item.allowedTools).includes(tool.name)} @change=${(e:Event)=>this.toggleRemoteTool(item,tool.name,(e.target as HTMLInputElement).checked)}><strong>${tool.name}</strong>${tool.description?html`<small> — ${tool.description}</small>`:nothing}</label>`)}<button class="action" ?disabled=${!!this.busy||!this.allowedDraft[item.id]} @click=${()=>this.saveRemoteTools(item)}>Save enabled tools</button>`:nothing}</div>`)}
      <div class="box"><strong>Add a remote service</strong><p class="note">Register a Web OAuth client with the exact callback URL below. The service must publish protected-resource metadata identifying its OAuth issuer and support PKCE.</p>
        <label>Callback URL<input aria-label="Remote callback URL" readonly .value=${this.remotes?.callbackUrl||''}></label>
        <label>Name<input aria-label="Remote service name" .value=${this.remoteName} @input=${(e:Event)=>this.remoteName=(e.target as HTMLInputElement).value}></label>
        <label>Service endpoint<input aria-label="Remote service endpoint" placeholder="https://service.example.com/endpoint" .value=${this.remoteEndpoint} @input=${(e:Event)=>this.remoteEndpoint=(e.target as HTMLInputElement).value}></label>
        <label>OAuth issuer URL, if the service advertises more than one<input aria-label="OAuth issuer URL" placeholder="https://login.example.com" .value=${this.remoteIssuer} @input=${(e:Event)=>this.remoteIssuer=(e.target as HTMLInputElement).value}></label>
        <label>Client ID<input aria-label="Remote client ID" autocomplete="off" .value=${this.remoteClientID} @input=${(e:Event)=>this.remoteClientID=(e.target as HTMLInputElement).value}></label>
        <label>Client secret, if required<input aria-label="Remote client secret" type="password" autocomplete="off" .value=${this.remoteClientSecret} @input=${(e:Event)=>this.remoteClientSecret=(e.target as HTMLInputElement).value}></label>
        <label>Scopes, separated by spaces<input aria-label="Remote OAuth scopes" .value=${this.remoteScopes} @input=${(e:Event)=>this.remoteScopes=(e.target as HTMLInputElement).value}></label>
        <div class="actions"><button class="action primary" ?disabled=${!!this.busy||!this.remoteName.trim()||!this.remoteEndpoint.trim()||!this.remoteClientID.trim()||!this.remoteScopes.trim()} @click=${this.createRemote}>Save connection</button></div></div>
      <p class="note">This is bring-your-own OAuth setup. Service operators may define additional access requirements and charges.</p>`;
  }
  private githubDetail(g:GitHubState) {
    const status=g.state==='ready'?'Ready':g.state==='needs-attention'?'Needs attention':g.state==='setup-required'?'Setup required':g.enabled?'Enabled · check tools':'Ready to connect';
    return html`<div class="head"><h2>GitHub</h2><span class="badge ${g.state==='ready'?'ready':g.state==='needs-attention'?'attention':''}">${status}</span></div>
      <p class="lead">Use repositories, issues, and pull requests in new chats through GitHub’s official local service.</p>
      <div class="box"><strong>Set up on this machine</strong>
        <p class="note">1. Install <code>gh</code> and <code>github-mcp-server</code> on the server running muxterm. 2. Sign in with <code>gh auth login --hostname github.com</code>. 3. Connect below to check the available tools.</p>
        <p class="note">GitHub CLI: ${g.ghInstalled?'installed':'missing'} · GitHub service: ${g.serverInstalled?'installed':'missing'} · GitHub CLI login: ${g.signedIn?'found':'missing'}</p>
        <div class="actions"><a class="action" target="_blank" rel="noopener noreferrer" href="https://cli.github.com/">Install GitHub CLI ↗</a><a class="action" target="_blank" rel="noopener noreferrer" href="https://github.com/github/github-mcp-server/releases">Install GitHub service ↗</a></div>
      </div>
      <div class="box"><strong>Use in chats</strong>
        <p class="note">Muxterm reads your existing GitHub CLI login when starting GitHub’s service. It stores only whether you enabled this connection, never a GitHub token. The service exposes read-only repository, issue, and pull request tools.</p>
        ${g.state==='ready'?html`<p class="note">${g.toolCount} tools verified. They are available in new chats across all harnesses.</p>`:g.error?html`<p class="note">${g.error}</p>`:nothing}
        <div class="actions"><button class="action primary" ?disabled=${!!this.busy||!g.ghInstalled||!g.serverInstalled||!g.signedIn} @click=${this.check}>${g.enabled?'Check tools again':'Connect GitHub'}</button>
          ${g.enabled?html`<button class="action" ?disabled=${!!this.busy} @click=${this.disconnect}>Disable for new chats</button>`:nothing}</div>
      </div>
      <p class="note">Your GitHub CLI login may have broader permissions than the read-only tools shown here. Disabling this connection does not sign out GitHub CLI or revoke its authorization. <a target="_blank" rel="noopener noreferrer" href="https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md">Service configuration ↗</a></p>`;
  }
  private otherDetail(service:Service) {
    const microsoft=service.group==='Microsoft 365';
    return html`<div class="head"><h2>${service.name}</h2><span class="badge">${microsoft?'Account setup':'Developer preview'}</span></div>
      <p class="lead">${service.description}.</p>
      <div class="box"><strong>${microsoft?'Microsoft 365 access':'Google Workspace setup'}</strong>
      <p class="note">${microsoft?'Microsoft Work IQ provides these services through an eligible Microsoft 365 tenant. Tenant admin enablement and Copilot Credits usage charges may apply. Its sign-in and policy are managed by Microsoft; review the terms and billing before use.':'Google’s official service is in Developer Preview. Join the preview, enable its API, register an OAuth client, and authorize this product’s requested scopes before using its endpoint with a chat harness.'}</p>
      ${service.endpoint?html`<label>Service endpoint<input aria-label="Service endpoint" readonly .value=${service.endpoint}></label>`:nothing}
      <div class="actions"><a class="action" href=${service.docsUrl} target="_blank" rel="noopener noreferrer">Setup instructions ↗</a>${microsoft?html`<a class="action" href="https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq-cli" target="_blank" rel="noopener noreferrer">Work IQ CLI ↗</a>`:nothing}</div></div>
      <p class="note">This service is listed for discovery. It is not connected in muxterm yet.</p>`;
  }
  override render() {
    const groups=['Developer','Microsoft 365','Google Workspace'];
    const service=this.data?.catalog.find(item=>item.id===this.selected);
    return html`<header><div class="eyebrow">Services</div><h1>Connections</h1><p>Bring your services into chats.</p></header>
      <div class="layout"><nav class="catalog" aria-label="Connection catalog"><div class="group">Your services</div><button class="service ${this.selected==='remote'?'active':''}" aria-current=${this.selected==='remote'?'page':'false'} @click=${()=>this.selected='remote'}><span><strong>Remote services</strong><small>Add a public service</small></span><i class="dot ${this.remotes?.items.some(item=>item.state==='needs-attention')?'attention':this.remotes?.items.some(item=>item.state==='ready')?'ready':''}"></i></button>${groups.map(group=>html`<div class="group">${group}</div>${this.data?.catalog.filter(item=>item.group===group).map(item=>html`<button class="service ${item.id===this.selected?'active':''}" aria-current=${item.id===this.selected?'page':'false'} @click=${()=>this.selected=item.id}><span><strong>${item.name}</strong><small>${item.description}</small></span><i class="dot ${item.id==='github'&&this.data?.github.state==='ready'?'ready':item.id==='github'&&this.data?.github.state==='needs-attention'?'attention':''}"></i></button>`)}`)}</nav>
        <main><div class="detail">${this.error?html`<div class="error" role="alert">${this.error}</div>`:nothing}${!this.data||!this.remotes?html`<p>Loading connections…</p>`:this.selected==='remote'?this.remoteDetail():service?.id==='github'?this.githubDetail(this.data.github):service?this.otherDetail(service):nothing}</div></main></div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-connections':MuxConnections } }
