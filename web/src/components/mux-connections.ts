import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';

type Service = { id:string; name:string; group:string; description:string; docsUrl:string; endpoint?:string; availability:string; scopes?:string[]; readTools?:string[] };
type GitHubState = { state:string; enabled:boolean; ghInstalled:boolean; serverInstalled:boolean; signedIn:boolean; toolCount:number; checkedAt?:string; error:string; installing:boolean; loginState:string; loginCode:string; loginError:string };
type ConnectionsResponse = { catalog:Service[]; github:GitHubState };
type RemoteTool = { name:string; description?:string };
type RemoteConnection = { id:string; provider?:string; name:string; endpoint:string; state:string; toolCount:number; checkedAt?:string; error?:string; discoveredTools:RemoteTool[]; allowedTools:string[] };
type RemoteResponse = { items:RemoteConnection[]; callbackUrl:string };
type WorkIQState = { installed:boolean; enabled:boolean };

@customElement('mux-connections')
export class MuxConnections extends LitElement {
  private loginPoll?:number;
  private autoCheckAfterLogin=false;
  @property() initialSelection = 'github';
  @state() private data?:ConnectionsResponse;
  @state() private remotes?:RemoteResponse;
  @state() private workiq?:WorkIQState;
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
  @state() private googleClientID='';
  @state() private googleClientSecret='';

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
  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.loginPoll) window.clearTimeout(this.loginPoll);
  }
  private async request<T>(path:string, init?:RequestInit):Promise<T> {
    const response=await fetch(apiPath(path), {...init, headers:{'Content-Type':'application/json',...init?.headers}});
    if (!response.ok) throw new Error((await response.text()).trim() || `Request failed (${response.status})`);
    return response.json() as Promise<T>;
  }
  private async refresh() {
    try { [this.data,this.remotes,this.workiq]=await Promise.all([this.request<ConnectionsResponse>('/api/connections'),this.request<RemoteResponse>('/api/connections/remote'),this.request<WorkIQState>('/api/connections/workiq')]); }
    catch(error) { this.error=String(error); }
    if (this.loginPoll) window.clearTimeout(this.loginPoll);
    if (this.isConnected && ['waiting','pending'].includes(this.data?.github.loginState||'')) this.loginPoll=window.setTimeout(()=>void this.refresh(),2000);
    if (this.isConnected && this.autoCheckAfterLogin && this.data?.github.loginState==='complete' && this.data.github.signedIn) {
      this.autoCheckAfterLogin=false;
      void this.run('check',()=>this.request('/api/connections/github/check',{method:'POST'}));
    }
  }
  private selectService(id:string) {
    if (this.selected===id) return;
    this.googleClientID='';
    this.googleClientSecret='';
    this.selected=id;
  }
  private serviceDotClass(service:Service) {
    if (service.id==='github') {
      return this.data?.github.state==='ready'?'ready':this.data?.github.state==='needs-attention'?'attention':'';
    }
    if (service.group==='Microsoft 365') return this.workiq?.enabled?(this.workiq.installed?'ready':'attention'):'';
    const items=this.remotes?.items.filter(item=>item.provider===service.id)??[];
    if (items.some(item=>item.state==='needs-attention')) return 'attention';
    if (items.some(item=>item.state==='ready'&&item.allowedTools.length>0)) return 'ready';
    return '';
  }
  private async run(name:string, action:()=>Promise<unknown>) {
    this.busy=name; this.error='';
    try { await action(); } catch(error) { this.error=error instanceof Error?error.message:String(error); }
    finally { await this.refresh(); this.busy=''; }
  }
  private check() { void this.run('check',async()=>{
    await this.request('/api/connections/github/install',{method:'POST'});
    await this.request('/api/connections/github/check',{method:'POST'});
  }); }
  private connectGitHub() { void this.run('github-connect',async()=>{
    await this.request('/api/connections/github/install',{method:'POST'});
    const github=(await this.request<ConnectionsResponse>('/api/connections')).github;
    if (!github.signedIn) {
      this.autoCheckAfterLogin=true;
      await this.request('/api/connections/github/login',{method:'POST'});
      return;
    }
    await this.request('/api/connections/github/check',{method:'POST'});
  }); }
  private cancelGitHubLogin() { this.autoCheckAfterLogin=false; void this.run('github-cancel',()=>this.request('/api/connections/github/login',{method:'DELETE'})); }
  private disconnect() {
    if (!window.confirm('Disable GitHub tools for new chats? Your GitHub CLI login stays signed in.')) return;
    void this.run('disconnect',()=>this.request('/api/connections/github',{method:'DELETE'}));
  }
  private createRemote() { void this.run('remote-create',async()=>{
    await this.request('/api/connections/remote',{method:'POST',body:JSON.stringify({name:this.remoteName,endpoint:this.remoteEndpoint,issuerURL:this.remoteIssuer,clientID:this.remoteClientID,clientSecret:this.remoteClientSecret,scopes:this.remoteScopes})});
    this.remoteName='';this.remoteEndpoint='';this.remoteIssuer='';this.remoteClientID='';this.remoteClientSecret='';this.remoteScopes='';
  }); }
  private createGoogle(service:Service) { void this.run('google-create',async()=>{
    await this.request('/api/connections/remote',{method:'POST',body:JSON.stringify({provider:service.id,clientID:this.googleClientID.trim(),clientSecret:this.googleClientSecret})});
    this.googleClientID='';this.googleClientSecret='';
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
      ${this.remotes?.items.filter(item=>!item.provider).map(item=>html`<div class="box"><div class="head"><strong>${item.name}</strong><span class="badge ${item.state==='ready'?'ready':item.state==='needs-attention'?'attention':''}">${item.state==='ready'?'Ready':item.state==='authorized'?'Authorized':item.state==='needs-attention'?'Needs attention':'Sign in required'}</span></div><p class="note"><code>${item.endpoint}</code></p><p class="note">${item.state==='ready'?`${item.toolCount} tools discovered; ${item.allowedTools.length} enabled for chats.`:item.error||'Authorize, then check access to discover tools.'}</p><div class="actions"><button class="action primary" ?disabled=${!!this.busy} @click=${()=>this.authorizeRemote(item.id)}>${item.state==='authorization-required'?'Authorize':'Reauthorize'}</button><button class="action" ?disabled=${!!this.busy||item.state==='authorization-required'} @click=${()=>this.checkRemote(item.id)}>Check tools</button><button class="action" ?disabled=${!!this.busy} @click=${()=>this.removeRemote(item.id)}>Remove</button></div>
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
      <p class="note">This is bring-your-own OAuth setup. Service providers may define additional access requirements and charges.</p>`;
  }
  private googleDetail(service:Service) {
    const items=this.remotes?.items.filter(item=>item.provider===service.id)??[];
    const ready=items.some(item=>item.state==='ready'&&item.allowedTools.length>0);
    return html`<div class="head"><h2>${service.name}</h2><span class="badge ${ready?'ready':''}">${ready?'Ready':'Developer preview · setup required'}</span></div>
      <p class="lead">${service.description}. Connect through Google's official service using a Web OAuth client from your Google Cloud project.</p>
      <div class="box"><strong>Before connecting</strong><p class="note">Join the Google Workspace Developer Preview, enable the product and connector APIs in your Cloud project, configure the OAuth consent screen, and register this exact callback URL on a Web OAuth client. External apps may need test users and scope verification.</p>
        <label>Callback URL<input aria-label="Google callback URL" readonly .value=${this.remotes?.callbackUrl||''}></label>
        <label>Service endpoint<input aria-label="Google service endpoint" readonly .value=${service.endpoint||''}></label>
        <p class="note">Muxterm requests these read-only scopes. Google may classify access to mail or files as sensitive or restricted, requiring additional review:</p>
        <ul>${service.scopes?.map(scope=>html`<li><code>${scope}</code></li>`)}</ul>
        <p class="note">Only these read tools can be enabled after a successful check: ${service.readTools?.join(', ')}. Newly discovered tools stay off. Google still controls the account grant, and data returned by tools can contain untrusted instructions.</p>
        <div class="actions"><a class="action" href=${service.docsUrl} target="_blank" rel="noopener noreferrer">Google setup guide ↗</a></div></div>
      ${items.map(item=>html`<div class="box"><div class="head"><strong>${item.name} connection</strong><span class="badge ${item.state==='ready'?'ready':item.state==='needs-attention'?'attention':''}">${item.state==='ready'?(item.allowedTools.length?'Ready':'Choose tools'):item.state==='authorized'?'Authorized · check tools':item.state==='needs-attention'?'Needs attention':'Sign in required'}</span></div>
        <p class="note">${item.error||(item.state==='ready'?`${item.toolCount} approved read tools found; ${item.allowedTools.length} enabled for chats.`:item.state==='authorized'?'Check service access to discover read tools.':'Sign in, then check service access to discover read tools.')}</p>
        <div class="actions"><button class="action primary" ?disabled=${!!this.busy} @click=${()=>this.authorizeRemote(item.id)}>${item.state==='authorization-required'?'Sign in with Google':'Reauthorize'}</button><button class="action" ?disabled=${!!this.busy||item.state==='authorization-required'} @click=${()=>this.checkRemote(item.id)}>Check tools</button><button class="action" ?disabled=${!!this.busy} @click=${()=>this.removeRemote(item.id)}>Remove</button></div>
        ${item.discoveredTools?.length?html`<h3>Enable read tools for chats</h3><p class="note">These tools are off until you save your selection. Enabled tools appear in new chats across all harnesses.</p>${item.discoveredTools.map(tool=>html`<label><input type="checkbox" .checked=${(this.allowedDraft[item.id]??item.allowedTools).includes(tool.name)} @change=${(e:Event)=>this.toggleRemoteTool(item,tool.name,(e.target as HTMLInputElement).checked)}><strong>${tool.name}</strong>${tool.description?html`<small> — ${tool.description}</small>`:nothing}</label>`)}<button class="action" ?disabled=${!!this.busy||!this.allowedDraft[item.id]} @click=${()=>this.saveRemoteTools(item)}>Save enabled tools</button>`:nothing}</div>`)}
      <div class="box"><strong>Add ${service.name}</strong><p class="note">Enter the client ID and secret from the Web OAuth client registered with the callback URL above. Authorization and a live tool check are required before this connection is ready.</p>
        <label>Client ID<input aria-label="Google client ID" autocomplete="off" .value=${this.googleClientID} @input=${(e:Event)=>this.googleClientID=(e.target as HTMLInputElement).value}></label>
        <label>Client secret<input aria-label="Google client secret" type="password" autocomplete="off" .value=${this.googleClientSecret} @input=${(e:Event)=>this.googleClientSecret=(e.target as HTMLInputElement).value}></label>
        <div class="actions"><button class="action primary" ?disabled=${!!this.busy||!this.googleClientID.trim()||!this.googleClientSecret.trim()} @click=${()=>this.createGoogle(service)}>Save app details</button></div></div>
      <p class="note">Google's service is in Developer Preview. A saved app registration or public endpoint alone does not establish access. Refresh tokens for external apps in Testing mode can expire after seven days.</p>`;
  }
  private githubDetail(g:GitHubState) {
    const status=g.state==='ready'?'Ready':g.state==='needs-attention'?'Needs attention':g.state==='setup-required'?'Setup required':g.enabled?'Enabled · check tools':'Ready to connect';
    return html`<div class="head"><h2>GitHub</h2><span class="badge ${g.state==='ready'?'ready':g.state==='needs-attention'?'attention':''}">${status}</span></div>
      <p class="lead">Use repositories, issues, and pull requests in new chats through GitHub’s official local service.</p>
      <div class="box"><strong>Set up GitHub</strong>
        <p class="note">Muxterm installs the official GitHub service and GitHub CLI for your account when needed. Downloads are pinned and verified before use. Nothing is installed system-wide.</p>
        <p class="note">GitHub service: ${g.serverInstalled?'available':'needed'} · Sign-in helper: ${g.ghInstalled?'available':'needed'} · GitHub account: ${g.signedIn?'signed in':'sign in required'}</p>
        ${g.state!=='ready'?html`<div class="actions"><button class="action primary" ?disabled=${!!this.busy||g.installing||g.loginState==='waiting'||g.loginState==='pending'} @click=${this.connectGitHub}>${this.busy==='github-connect'||g.installing?'Setting up GitHub…':g.loginState==='waiting'||g.loginState==='pending'?'Waiting for GitHub…':'Connect GitHub'}</button></div>`:nothing}
        ${g.loginState==='pending'&&g.loginCode?html`<p class="note">Open GitHub’s sign-in page and enter this one-time code: <strong><code>${g.loginCode}</code></strong></p><div class="actions"><a class="action" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">Open GitHub sign-in ↗</a></div>`:nothing}
        ${g.loginState==='waiting'?html`<p class="note">Preparing a sign-in code…</p>`:nothing}
        ${g.loginState==='waiting'||g.loginState==='pending'?html`<div class="actions"><button class="action" ?disabled=${!!this.busy} @click=${this.cancelGitHubLogin}>Cancel sign-in</button></div>`:nothing}
        ${g.loginState==='error'?html`<p class="note">${g.loginError}</p>`:nothing}
      </div>
      <div class="box"><strong>Use in chats</strong>
        <p class="note">Muxterm uses your GitHub CLI login when starting GitHub’s service. Muxterm stores only whether you enabled this connection; GitHub CLI stores its own authorization. The service exposes read-only repository, issue, and pull request tools.</p>
        ${g.state==='ready'?html`<p class="note">${g.toolCount} tools verified. They are available in new Codex, Claude, and Amplifier chats.</p>`:g.error?html`<p class="note">${g.error}</p>`:nothing}
        <div class="actions">${g.enabled?html`<button class="action" ?disabled=${!!this.busy||!g.ghInstalled||!g.serverInstalled||!g.signedIn} @click=${this.check}>Check tools again</button>`:nothing}
          ${g.enabled?html`<button class="action" ?disabled=${!!this.busy} @click=${this.disconnect}>Disable for new chats</button>`:nothing}</div>
      </div>
      <p class="note">Your GitHub CLI login may have broader permissions than the read-only tools shown here. Disabling this connection does not sign out GitHub CLI or revoke its authorization. <a target="_blank" rel="noopener noreferrer" href="https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md">Service configuration ↗</a></p>`;
  }
  private workIQDetail(service:Service) {
    const w=this.workiq!;
    const enabled=w.enabled;
    return html`<div class="head"><h2>${service.name}</h2><span class="badge ${enabled?(w.installed?'ready':'attention'):''}">${enabled?(w.installed?'Enabled for new chats':'CLI missing'):w.installed?'Available to enable':'Install required'}</span></div>
      <p class="lead">${service.description}. One Microsoft Work IQ server covers OneDrive, Outlook Mail, Outlook Calendar, and other Microsoft 365 data. Enabling any of these cards enables that same server in new Codex, Claude, and Amplifier chats.</p>
      <div class="box"><strong>Use Microsoft's Work IQ CLI</strong>
        <p class="note">Install the official CLI so <code>workiq</code> is on muxterm's PATH: <code>npm install -g @microsoft/workiq</code>. Then review and accept its license with <code>workiq accept-eula</code> and sign in with <code>workiq auth login</code>. Run these commands in your own terminal; muxterm does not perform these steps.</p>
        <p class="note">Your organization must grant Entra admin consent, assign you to a Copilot Credits billing plan, and allow Work IQ access. Work IQ handles its own sign-in; muxterm does not request an Entra app, client secret, or Microsoft token.</p>
        <p class="note">This enables the vendor server's full available tool set across Microsoft 365. Work IQ may offer actions beyond reading files, mail, or meetings. Microsoft account permissions and tenant policies still apply, and usage may incur charges.</p>
        <div class="actions"><button class="action ${enabled?'':'primary'}" ?disabled=${!!this.busy||(!w.installed&&!enabled)} @click=${()=>void this.run('workiq-toggle',()=>this.request('/api/connections/workiq',{method:enabled?'DELETE':'POST'}))}>${enabled?'Disable in new chats':'Enable in new chats'}</button><a class="action" href=${service.docsUrl} target="_blank" rel="noopener noreferrer">Microsoft setup guide ↗</a></div>
      </div><p class="note">Enabled means the CLI is available to new chats; it does not confirm Microsoft sign-in or tenant access. Disabling this entry does not revoke credentials stored by Work IQ. Running chats keep their current tools.</p>`;
  }
  override render() {
    const groups=['Developer','Microsoft 365','Google Workspace'];
    const service=this.data?.catalog.find(item=>item.id===this.selected);
    return html`<header><div class="eyebrow">Services</div><h1>Connections</h1><p>Bring your services into chats.</p></header>
      <div class="layout"><nav class="catalog" aria-label="Connection catalog"><div class="group">Your services</div><button class="service ${this.selected==='remote'?'active':''}" aria-current=${this.selected==='remote'?'page':'false'} @click=${()=>this.selectService('remote')}><span><strong>Remote services</strong><small>Add a public service</small></span><i class="dot ${this.remotes?.items.some(item=>!item.provider&&item.state==='needs-attention')?'attention':this.remotes?.items.some(item=>!item.provider&&item.state==='ready')?'ready':''}"></i></button>${groups.map(group=>html`<div class="group">${group}</div>${this.data?.catalog.filter(item=>item.group===group).map(item=>html`<button class="service ${item.id===this.selected?'active':''}" aria-current=${item.id===this.selected?'page':'false'} @click=${()=>this.selectService(item.id)}><span><strong>${item.name}</strong><small>${item.description}</small></span><i class="dot ${this.serviceDotClass(item)}"></i></button>`)}`)}</nav>
        <main><div class="detail">${this.error?html`<div class="error" role="alert">${this.error}</div>`:nothing}${!this.data||!this.remotes||!this.workiq?html`<p>Loading connections…</p>`:this.selected==='remote'?this.remoteDetail():service?.id==='github'?this.githubDetail(this.data.github):service?.group==='Microsoft 365'?this.workIQDetail(service):service?.group==='Google Workspace'?this.googleDetail(service):nothing}</div></main></div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-connections':MuxConnections } }
