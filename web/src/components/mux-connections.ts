import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import '../ui/button.js';
import '../ui/feedback.js';
import '../ui/nav-item.js';
import '../ui/page-intro.js';
import '../ui/screen-header.js';
import '../ui/status-badge.js';
import '../ui/text-field.js';
import '../ui/select.js';
import '../ui/switch.js';
import '../ui/confirmation.js';
import type { StatusTone } from '../ui/status-badge.js';
import type { MuxUITextField } from '../ui/text-field.js';
import type { MuxUISelect } from '../ui/select.js';
import type { MuxUISwitch } from '../ui/switch.js';

type Service = { id:string; name:string; group:string; description:string; docsUrl:string; endpoint?:string; availability:string; scopes?:string[]; readTools?:string[] };
type GitHubState = { state:string; enabled:boolean; ghInstalled:boolean; serverInstalled:boolean; signedIn:boolean; toolCount:number; checkedAt?:string; error:string; installing:boolean; loginState:string; loginCode:string; loginError:string };
type ConnectionsResponse = { catalog:Service[]; github:GitHubState };
type RemoteTool = { name:string; description?:string };
type RemoteConnection = { id:string; provider?:string; name:string; endpoint:string; state:string; toolCount:number; checkedAt?:string; error?:string; discoveredTools:RemoteTool[]; allowedTools:string[] };
type RemoteResponse = { items:RemoteConnection[]; callbackUrl:string };
type MicrosoftProfile = { state:'disconnected'|'pending'|'ready'|'needs-attention'; loginState:string; userCode:string; verificationUrl:string; error:string; toolCount:number; checkedAt?:string };
type MicrosoftState = { personal:MicrosoftProfile };
type LegacyWorkIQ = { savedAuthorization:boolean };
type PendingConfirmation = { heading:string; description:string; confirmLabel:string; busyKey:string; action:()=>Promise<unknown> };

@customElement('mux-connections')
export class MuxConnections extends LitElement {
  private loginPoll?:number;
  private refreshAbort?:AbortController;
  private autoCheckAfterLogin=false;
  @property() initialSelection = 'github';
  @state() private data?:ConnectionsResponse;
  @state() private remotes?:RemoteResponse;
  @state() private microsoft?:MicrosoftState;
  @state() private legacyWorkIQ?:LegacyWorkIQ;
  @state() private selected='github';
  @state() private googleService='gmail';
  @state() private busy='';
  @state() private error='';
  @state() private allowedDraft:Record<string,string[]>={};
  @state() private googleClientID='';
  @state() private googleClientSecret='';
  @state() private confirmation?:PendingConfirmation;

  static override styles=css`
    ${subtleScrollbars}
    :host { position:absolute; inset:0; z-index:var(--ui-z-screen); display:flex; flex-direction:column; overflow:hidden; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-md)/1.5 var(--ui-font-sans); }
    * { box-sizing:border-box; } button { font:inherit; cursor:pointer; }
    mux-ui-page-intro { flex:none; }
    p { margin:0; color:var(--ui-text-muted); }
    .layout { min-height:0; display:flex; flex-direction:column; flex:1; }
    .catalog { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--ui-space-3); flex:none; padding:var(--ui-space-5) var(--ui-space-7); border-bottom:1px solid var(--ui-border); background:var(--ui-surface-nav); }
    .catalog mux-ui-nav-item { min-width:0; }
    main { min-width:0; overflow:auto; padding:var(--ui-space-8) var(--ui-space-7) var(--ui-space-12); } .detail { max-width:var(--ui-connection-content-width); margin:auto; }
    .head { display:flex; justify-content:space-between; align-items:center; gap:var(--ui-space-5); }
    h2 { margin:0; font-size:var(--ui-text-xl); } h3 { margin:var(--ui-space-8) 0 var(--ui-space-3); font-size:var(--ui-text-md); }
    .lead { margin-top:var(--ui-space-4); } .box { margin-top:var(--ui-space-7); padding:var(--ui-space-6); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); }
    details.box summary { cursor:pointer; font-weight:650; } details.box summary:focus-visible { outline:2px solid var(--ui-focus); outline-offset:var(--ui-space-1); }
    mux-ui-text-field { margin:var(--ui-space-5) 0; --ui-surface-raised:var(--ui-surface-base); }
    .tool-choices { display:grid; gap:var(--ui-space-2); margin:var(--ui-space-5) 0; }
    .actions { display:flex; flex-wrap:wrap; gap:var(--ui-space-4); margin-top:var(--ui-space-6); }
    a { color:var(--ui-accent); }
    .detail > mux-ui-feedback { margin:var(--ui-space-5) 0; }
    .note { margin-top:var(--ui-space-5); font-size:var(--ui-text-xs); } code { overflow-wrap:anywhere; }
    .device-code { display:inline-block; margin-top:var(--ui-space-5); padding:var(--ui-space-4) var(--ui-space-5); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-base); color:var(--ui-text); font:700 var(--ui-text-2xl) var(--ui-font-mono); letter-spacing:.12em; user-select:all; }
    .provider-intro { margin:0 0 var(--ui-space-7); padding-bottom:var(--ui-space-6); border-bottom:1px solid var(--ui-border); }
    .provider-intro h2 { font-size:var(--ui-text-2xl); }
    .provider-intro p { margin-top:var(--ui-space-2); }
    .service-picker { max-width:var(--ui-connection-service-picker-width); margin:var(--ui-space-7) 0; }
    .setup-section { margin-top:var(--ui-space-6); padding-top:var(--ui-space-6); border-top:1px solid var(--ui-border); }
    @media(max-width:700px) { .catalog { gap:var(--ui-space-1); padding:var(--ui-space-2); } .catalog mux-ui-nav-item { min-width:0; } main { padding:var(--ui-space-6) var(--ui-space-5) var(--ui-space-10); } .provider-intro { margin-bottom:var(--ui-space-5); } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    const initial=this.initialSelection;
    this.selected = initial==='github'?'github':initial==='microsoft'||['onedrive','outlook-mail','outlook-calendar'].includes(initial)?'microsoft':initial==='google'||['gmail','google-drive','google-calendar','google-docs','google-sheets','google-slides'].includes(initial)?'google':'github';
    if (initial.startsWith('google-')||initial==='gmail') this.googleService=initial;
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
    this.loginPoll=undefined;
    this.refreshAbort?.abort();
    this.refreshAbort=undefined;
    this.autoCheckAfterLogin=false;
    this.allowedDraft={};
  }
  private async request<T>(path:string, init?:RequestInit):Promise<T> {
    const response=await fetch(apiPath(path), {...init, headers:{'Content-Type':'application/json',...init?.headers}});
    if (!response.ok) {
      const body=(await response.text()).trim();
      let message=body;
      try {
        const parsed=JSON.parse(body) as {error?:unknown};
        if (typeof parsed.error==='string') message=parsed.error;
      } catch { /* Plain-text server errors remain readable. */ }
      throw new Error(message || `Request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
  }
  private async refresh() {
    this.refreshAbort?.abort();
    const abort=new AbortController();
    this.refreshAbort=abort;
    try {
      const legacy=this.request<LegacyWorkIQ>('/api/connections/workiq',{signal:abort.signal}).catch(()=>({savedAuthorization:false}));
      const [data,remotes,microsoft,legacyWorkIQ]=await Promise.all([this.request<ConnectionsResponse>('/api/connections',{signal:abort.signal}),this.request<RemoteResponse>('/api/connections/remote',{signal:abort.signal}),this.request<MicrosoftState>('/api/connections/microsoft',{signal:abort.signal}),legacy]);
      if (abort.signal.aborted || !this.isConnected) return;
      [this.data,this.remotes,this.microsoft,this.legacyWorkIQ]=[data,remotes,microsoft,legacyWorkIQ];
    }
    catch(error) { if (abort.signal.aborted || !this.isConnected) return; this.error=error instanceof Error?error.message:String(error); }
    finally { if (this.refreshAbort===abort) this.refreshAbort=undefined; }
    if (this.loginPoll) window.clearTimeout(this.loginPoll);
    if (this.isConnected && (['waiting','pending'].includes(this.data?.github.loginState||'') || Object.values(this.microsoft??{}).some(profile=>profile.state==='pending'))) this.loginPoll=window.setTimeout(()=>void this.refresh(),2000);
    if (this.isConnected && this.autoCheckAfterLogin && this.data?.github.loginState==='complete' && this.data.github.signedIn) {
      this.autoCheckAfterLogin=false;
      void this.run('check',()=>this.request('/api/connections/github/check',{method:'POST'}));
    }
  }
  private retry() { this.error=''; void this.refresh(); }
  private selectService(id:string) {
    if (this.selected===id) return;
    this.googleClientID='';
    this.googleClientSecret='';
    this.selected=id;
  }
  private providerStatusTone(id:'github'|'microsoft'|'google'):StatusTone {
    if(id==='github') return this.statusTone(this.data?.github.state||'');
    if(id==='microsoft') return this.statusTone(this.microsoft?.personal.state||'');
    const services=this.data?.catalog.filter(service=>service.group==='Google Workspace')??[];
    if(services.some(service=>this.serviceStatusTone(service)==='warning')) return 'warning';
    if(services.some(service=>this.serviceStatusTone(service)==='success')) return 'success';
    return services.some(service=>this.serviceStatusTone(service)==='info')?'info':'neutral';
  }
  private providerStatusLabel(id:'github'|'microsoft'|'google'):string {
    if (!this.data || !this.remotes || !this.microsoft) return 'Status unavailable';
    const tone = this.providerStatusTone(id);
    if (tone === 'success') return 'Ready';
    if (tone === 'warning') return 'Needs attention';
    if (tone === 'info') {
      if (id === 'google') {
        const serviceIds=new Set(this.data.catalog.filter(service=>service.group==='Google Workspace').map(service=>service.id));
        const items=this.remotes.items.filter(item=>item.provider&&serviceIds.has(item.provider));
        if (!items.some(item=>item.state==='pending')) return 'Finish setup';
      }
      return 'Sign-in in progress';
    }
    return 'Not connected';
  }
  private serviceStatusTone(service:Service):StatusTone {
    if (service.id==='github') {
      return this.statusTone(this.data?.github.state||'');
    }
    if (service.group==='Microsoft personal') return this.statusTone(this.microsoft?.personal.state||'');
    const items=this.remotes?.items.filter(item=>item.provider===service.id)??[];
    if (items.some(item=>item.state==='needs-attention')) return 'warning';
    if (items.some(item=>item.state==='ready'&&item.allowedTools.length>0)) return 'success';
    if (items.some(item=>['pending','authorized','ready'].includes(item.state))) return 'info';
    return 'neutral';
  }
  private async run(name:string, action:()=>Promise<unknown>) {
    this.busy=name; this.error='';
    try { await action(); } catch(error) { this.error=error instanceof Error?error.message:String(error); }
    finally { await this.refresh(); this.busy=''; }
  }
  private askConfirmation(confirmation:PendingConfirmation):void { this.confirmation=confirmation; }
  private cancelConfirmation():void { if (!this.busy) this.confirmation=undefined; }
  private confirmConfirmation():void {
    const confirmation=this.confirmation;
    if (!confirmation || this.busy) return;
    void this.run(confirmation.busyKey,confirmation.action).then(()=>{
      if (this.confirmation===confirmation) this.confirmation=undefined;
    });
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
    this.askConfirmation({heading:'Disable GitHub?',description:'New chats will lose access to GitHub tools. Your GitHub CLI login stays signed in.',confirmLabel:'Disable GitHub',busyKey:'disconnect',action:()=>this.request('/api/connections/github',{method:'DELETE'})});
  }
  private connectMicrosoft() { void this.run('microsoft-personal',()=>this.request('/api/connections/microsoft/personal/connect',{method:'POST'})); }
  private cancelMicrosoft() { void this.run('microsoft-personal-cancel',()=>this.request('/api/connections/microsoft/personal/connect',{method:'DELETE'})); }
  private checkMicrosoft() { void this.run('microsoft-personal-check',()=>this.request('/api/connections/microsoft/personal/check',{method:'POST'})); }
  private disconnectMicrosoft() {
    this.askConfirmation({heading:'Disconnect Microsoft?',description:'This removes the saved account authorization. New chats will lose access to Microsoft mail, calendar and files.',confirmLabel:'Disconnect account',busyKey:'microsoft-personal-disconnect',action:()=>this.request('/api/connections/microsoft/personal',{method:'DELETE'})});
  }
  private removeLegacyWorkIQ() {
    this.askConfirmation({heading:'Remove old authorization?',description:'The previous Work IQ authorization will be removed from this machine. It no longer supplies tools to new chats.',confirmLabel:'Remove authorization',busyKey:'workiq-remove',action:()=>this.request('/api/connections/workiq',{method:'DELETE'})});
  }
  private createGoogle(service:Service) { void this.run('google-create',async()=>{
    await this.request('/api/connections/remote',{method:'POST',body:JSON.stringify({provider:service.id,clientID:this.googleClientID.trim(),clientSecret:this.googleClientSecret})});
    this.googleClientID='';this.googleClientSecret='';
  }); }
  private startGoogleSetup(service:Service) {
    const existing=this.remotes?.items.some(item=>item.provider===service.id)??false;
    const prompt=`Help me ${existing?'review and, if needed, redo':'set up'} ${service.name} in this Muxterm using Browser Assistant. Start by checking whether my Google account and Cloud project are eligible for the Google Workspace Developer Preview MCP service. Ask me which account and project to use; inspect existing registrations before creating another one.

Use prepare_connection with provider "google" and services ["${service.id}"] on this Muxterm. Compare its exact callback, endpoint, and scopes with these displayed values:
Callback: ${this.remotes?.callbackUrl||'Check the Customizations page'}
Endpoint: ${service.endpoint||'Check the Customizations page'}
Scopes: ${service.scopes?.join(', ')||'Check the Customizations page'}

Guide me through the Google Cloud Console using my paired Browser Assistant. Stop before any client secret appears. I will pause browser access and upload the Web OAuth JSON or enter credentials on the private Muxterm setup page. Never put a client ID, secret, registration file, or its contents in chat or agent tools. Then use check_connection and the opaque credential handle to configure the connection. Guide me through Google sign-in, checking tools, and choosing which read tools to enable. Do not read mail content just to verify setup.

If I already have a connection, check its status first. Do not remove or replace it without my agreement. If the setup tools are unavailable, guide me through the existing private manual entry instead. If the Google account is ineligible, explain the blocker and stop.`;
    this.dispatchEvent(new CustomEvent('connection-setup-chat',{detail:{prompt},bubbles:true,composed:true}));
  }
  private authorizeRemote(id:string) { void this.run('remote-start',async()=>{
    const result=await this.request<{url:string}>(`/api/connections/remote/${encodeURIComponent(id)}/start`,{method:'POST'});
    window.location.assign(result.url);
  }); }
  private checkRemote(id:string) { void this.run('remote-check',()=>this.request(`/api/connections/remote/${encodeURIComponent(id)}/check`,{method:'POST'})); }
  private removeRemote(id:string) {
    const name=this.remotes?.items.find(item=>item.id===id)?.name || 'this connection';
    this.askConfirmation({heading:`Remove ${name}?`,description:'This removes the connection and its saved authorization. New chats will lose access to its tools.',confirmLabel:'Remove connection',busyKey:'remote-remove',action:async()=>{
      await this.request(`/api/connections/remote/${encodeURIComponent(id)}`,{method:'DELETE'});
      const next={...this.allowedDraft};delete next[id];this.allowedDraft=next;
    }});
  }
  private toggleRemoteTool(item:RemoteConnection,name:string,enabled:boolean) {
    const current=this.allowedDraft[item.id]??item.allowedTools;
    this.allowedDraft={...this.allowedDraft,[item.id]:enabled?[...current,name]:current.filter(tool=>tool!==name)};
  }
  private saveRemoteTools(item:RemoteConnection) { void this.run('remote-tools',async()=>{
    await this.request(`/api/connections/remote/${encodeURIComponent(item.id)}/tools`,{method:'PATCH',body:JSON.stringify({allowedTools:this.allowedDraft[item.id]??item.allowedTools})});
    const next={...this.allowedDraft};delete next[item.id];this.allowedDraft=next;
  }); }
  private statusTone(state:string):StatusTone {
    return state==='ready'?'success':state==='needs-attention'?'warning':state==='authorized'||state==='pending'?'info':'neutral';
  }
  private googleDetail(service:Service) {
    const items=this.remotes?.items.filter(item=>item.provider===service.id)??[];
    const ready=items.some(item=>item.state==='ready'&&item.allowedTools.length>0);
    return html`<div class="head"><h2>${service.name}</h2><mux-ui-status-badge tone=${ready?'success':'neutral'}>${ready?'Ready':'Preview · setup required'}</mux-ui-status-badge></div>
      <p class="lead">${service.description}. Connect through Google's official service using a Web OAuth client from your Google Cloud project.</p>
      <div class="box"><strong>${items.length?'Need to set up again?':'Set up with an agent'}</strong><p class="note">An agent can guide the Cloud registration in your paired browser. You enter credentials privately and choose when to authorize access.</p>
        <div class="actions"><mux-ui-button variant="primary" @click=${()=>this.startGoogleSetup(service)}>${items.length?'Open setup chat again':'Open setup chat'}</mux-ui-button></div></div>
      <details class="box"><summary>Setup requirements and manual entry</summary>
      <section class="setup-section"><strong>Preview requirements</strong><p class="note">These official Google services require an enrolled Google Workspace account and Cloud project. This setup is not a supported route for a personal @gmail.com account. Google does not allow preview services in public apps before general availability. <a href="https://developers.google.com/workspace/preview" target="_blank" rel="noopener noreferrer">Read the requirements</a></p></section>
      <section class="setup-section"><strong>Before connecting</strong><p class="note">For permitted preview testing, enable the product and connector APIs in your enrolled Cloud project, configure the OAuth consent screen, and register this exact callback URL on a Web OAuth client. External apps may need test users and scope verification.</p>
        <mux-ui-text-field label="Callback URL" aria-label="Google callback URL" readonly .value=${this.remotes?.callbackUrl||''}></mux-ui-text-field>
        <mux-ui-text-field label="Service endpoint" aria-label="Google service endpoint" readonly .value=${service.endpoint||''}></mux-ui-text-field>
        <p class="note">Muxterm requests these read-only scopes. Google may classify access to mail or files as sensitive or restricted, requiring additional review:</p>
        <ul>${service.scopes?.map(scope=>html`<li><code>${scope}</code></li>`)}</ul>
        <p class="note">Only these read tools can be enabled after a successful check: ${service.readTools?.join(', ')}. Newly discovered tools stay off. Google still controls the account grant, and data returned by tools can contain untrusted instructions.</p>
        <div class="actions"><mux-ui-button href=${service.docsUrl} target="_blank" variant="secondary">Google setup guide</mux-ui-button></div></section>
      <section class="setup-section"><strong>Add ${service.name} manually</strong><p class="note">Enter the client ID and secret from the Web OAuth client registered with the callback URL above. Authorization and a live tool check are required before this connection is ready.</p>
        <mux-ui-text-field label="Client ID" aria-label="Google client ID" autocomplete="off" .value=${this.googleClientID} @input=${(e:Event)=>this.googleClientID=(e.target as MuxUITextField).value}></mux-ui-text-field>
        <mux-ui-text-field label="Client secret" aria-label="Google client secret" type="password" autocomplete="off" .value=${this.googleClientSecret} @input=${(e:Event)=>this.googleClientSecret=(e.target as MuxUITextField).value}></mux-ui-text-field>
        <div class="actions"><mux-ui-button variant="primary" ?disabled=${!!this.busy||!this.googleClientID.trim()||!this.googleClientSecret.trim()} @click=${()=>this.createGoogle(service)}>Save app details</mux-ui-button></div></section></details>
      ${items.map(item=>html`<div class="box"><div class="head"><strong>${item.name} connection</strong><mux-ui-status-badge tone=${item.state==='ready'&&!item.allowedTools.length?'warning':this.statusTone(item.state)}>${item.state==='ready'?(item.allowedTools.length?'Ready':'Choose tools'):item.state==='authorized'?'Authorized · check tools':item.state==='pending'?'Sign-in in progress':item.state==='needs-attention'?'Needs attention':'Sign in required'}</mux-ui-status-badge></div>
        <p class="note">${item.error||(item.state==='ready'?`${item.toolCount} approved read tools found; ${item.allowedTools.length} enabled for chats.`:item.state==='authorized'?'Check service access to discover read tools.':'Sign in, then check service access to discover read tools.')}</p>
        <div class="actions"><mux-ui-button variant="primary" ?disabled=${!!this.busy} @click=${()=>this.authorizeRemote(item.id)}>${item.state==='authorization-required'?'Sign in with Google':'Reauthorize'}</mux-ui-button><mux-ui-button variant="secondary" ?disabled=${!!this.busy||item.state==='authorization-required'} @click=${()=>this.checkRemote(item.id)}>Check tools</mux-ui-button><mux-ui-button variant="secondary" ?disabled=${!!this.busy} @click=${()=>this.removeRemote(item.id)}>Remove</mux-ui-button></div>
        ${item.discoveredTools?.length?html`<h3>Enable read tools for chats</h3><p class="note">These tools are off until you save your selection. Enabled tools appear in new chats across all harnesses.</p>
          <div class="tool-choices">${item.discoveredTools.map(tool=>html`<mux-ui-switch layout="row" .label=${tool.name} .description=${tool.description??''}
            .checked=${(this.allowedDraft[item.id]??item.allowedTools).includes(tool.name)} ?disabled=${!!this.busy}
            @change=${(event:Event)=>this.toggleRemoteTool(item,tool.name,(event.target as MuxUISwitch).checked)}></mux-ui-switch>`)}</div>
          <mux-ui-button variant="secondary" ?disabled=${!!this.busy||!this.allowedDraft[item.id]} @click=${()=>this.saveRemoteTools(item)}>Save enabled tools</mux-ui-button>`:nothing}</div>`)}
      <p class="note">Google's service is in Developer Preview. A saved app registration or public endpoint alone does not establish access. Refresh tokens for external apps in Testing mode can expire after seven days.</p>`;
  }
  private githubDetail(g:GitHubState) {
    const status=g.state==='ready'?'Ready':g.state==='needs-attention'?'Needs attention':g.state==='setup-required'?'Setup required':g.enabled?'Enabled · check tools':'Ready to connect';
    return html`<div class="head"><h2>GitHub</h2><mux-ui-status-badge tone=${this.statusTone(g.state)}>${status}</mux-ui-status-badge></div>
      <p class="lead">Use repositories, issues, and pull requests in new chats through GitHub.</p>
      <div class="box"><strong>Set up GitHub</strong>
        <p class="note">Muxterm installs the official GitHub service and GitHub CLI for your account when needed. Downloads are pinned and verified before use. Nothing is installed system-wide. First setup may take a few minutes.</p>
        <p class="note">GitHub service: ${g.serverInstalled?'available':'needed'} · Sign-in helper: ${g.ghInstalled?'available':'needed'} · GitHub account: ${g.signedIn?'signed in':'sign in required'}</p>
        ${g.state!=='ready'?html`<div class="actions"><mux-ui-button variant="primary" ?disabled=${!!this.busy||g.installing||g.loginState==='waiting'||g.loginState==='pending'} @click=${this.connectGitHub}>${this.busy==='github-connect'||g.installing?'Setting up GitHub…':g.loginState==='waiting'||g.loginState==='pending'?'Waiting for GitHub…':'Connect GitHub'}</mux-ui-button></div>`:nothing}
        ${g.loginState==='pending'&&g.loginCode?html`<p class="note">Open GitHub’s sign-in page and enter this one-time code: <strong><code>${g.loginCode}</code></strong></p><div class="actions"><mux-ui-button href="https://github.com/login/device" target="_blank" variant="secondary">Open GitHub sign-in ↗</mux-ui-button></div>`:nothing}
        ${g.loginState==='waiting'?html`<p class="note">Preparing a sign-in code…</p>`:nothing}
        ${g.loginState==='waiting'||g.loginState==='pending'?html`<div class="actions"><mux-ui-button variant="secondary" ?disabled=${!!this.busy} @click=${this.cancelGitHubLogin}>Cancel sign-in</mux-ui-button></div>`:nothing}
        ${g.loginState==='error'?html`<p class="note">${g.loginError}</p>`:nothing}
      </div>
      <div class="box"><strong>Use in chats</strong>
        <p class="note">Muxterm uses your GitHub CLI login when starting GitHub’s service. Muxterm stores only whether you enabled this connection; GitHub CLI stores its own authorization. The service exposes read-only repository, issue, and pull request tools.</p>
        ${g.state==='ready'?html`<p class="note">${g.toolCount} tools verified. They are available in new Codex, Claude, and Amplifier chats.</p>`:g.error?html`<p class="note">${g.error}</p>`:nothing}
        <div class="actions">${g.enabled?html`<mux-ui-button variant="secondary" ?disabled=${!!this.busy||!g.ghInstalled||!g.serverInstalled||!g.signedIn} @click=${this.check}>Check tools again</mux-ui-button>`:nothing}
          ${g.enabled?html`<mux-ui-button variant="secondary" ?disabled=${!!this.busy} @click=${this.disconnect}>Disable for new chats</mux-ui-button>`:nothing}</div>
      </div>
      <p class="note">Your GitHub CLI login may have broader permissions than the read-only tools shown here. Disabling this connection does not sign out GitHub CLI or revoke its authorization. <a target="_blank" rel="noopener noreferrer" href="https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md">Service configuration ↗</a></p>`;
  }
  private microsoftProfile() {
    const profile=this.microsoft?.personal;
    if (!profile) return nothing;
    const ready=profile.state==='ready';
    const pending=profile.state==='pending';
    const attention=profile.state==='needs-attention';
    return html`<div class="box"><div class="head"><strong>Personal Microsoft account</strong><mux-ui-status-badge tone=${this.statusTone(profile.state)}>${ready?'Ready':pending?'Waiting for sign-in':attention?'Needs attention':'Not connected'}</mux-ui-status-badge></div>
      <p class="note">Use Outlook.com, Hotmail, or personal OneDrive.</p>
      ${pending?html`<p class="note">Enter this one-time code at Microsoft’s sign-in page:</p>
        ${profile.userCode?html`<code class="device-code" aria-label="Microsoft sign-in code">${profile.userCode}</code>`:html`<p class="note">${profile.loginState==='installing'?'Installing the connection…':'Preparing a sign-in code…'}</p>`}
        <p class="note">This page updates when sign-in completes.</p>
        <div class="actions">${profile.userCode&&profile.verificationUrl?html`<mux-ui-button href=${profile.verificationUrl} target="_blank" variant="primary">Open Microsoft sign-in ↗</mux-ui-button>`:nothing}<mux-ui-button variant="secondary" ?disabled=${!!this.busy} @click=${this.cancelMicrosoft}>Cancel sign-in</mux-ui-button></div>`:nothing}
      ${attention?html`<p class="note">${profile.error}</p>`:nothing}
      ${ready?html`<p class="note">${profile.toolCount>0?`${profile.toolCount} read-only tools are available`:'Read-only tools are enabled'} for new Codex, Claude, and Amplifier chats.</p>`:nothing}
      ${!pending?html`<div class="actions"><mux-ui-button variant="primary" ?disabled=${!!this.busy} @click=${this.connectMicrosoft}>${ready?'Sign in again':this.busy==='microsoft-personal'?'Installing…':attention?'Try sign-in again':'Connect account'}</mux-ui-button>
        ${ready?html`<mux-ui-button variant="secondary" ?disabled=${!!this.busy} @click=${this.checkMicrosoft}>Check access</mux-ui-button>`:nothing}
        ${ready||attention?html`<mux-ui-button variant="secondary" ?disabled=${!!this.busy} @click=${this.disconnectMicrosoft}>Disconnect</mux-ui-button>`:nothing}</div>`:nothing}
    </div>`;
  }
  private microsoftDetail() {
    return html`<div class="head"><h2>Microsoft</h2></div>
      <p class="lead">Connect one account for Outlook mail and calendar, plus OneDrive files. Muxterm offers a one-time code that works on a headless machine.</p>
      ${this.microsoftProfile()}
      ${this.legacyWorkIQ?.savedAuthorization?html`<div class="box"><strong>Previous Work IQ authorization</strong><p class="note">The old Work IQ connection no longer supplies tools to new chats. Its saved authorization remains on this machine until you remove it.</p><div class="actions"><mux-ui-button variant="secondary" ?disabled=${!!this.busy} @click=${this.removeLegacyWorkIQ}>Remove old authorization</mux-ui-button></div></div>`:nothing}
      <p class="note">Muxterm uses one public Microsoft app registration for personal accounts. The community service manages sign-in and stores authorization on this machine. Mail, calendar, and file tools are read-only. <a href="https://github.com/Softeria/ms-365-mcp-server" target="_blank" rel="noopener noreferrer">About the service ↗</a></p>`;
  }
  private googleProviderDetail() {
    const services=this.data?.catalog.filter(service=>service.group==='Google Workspace')??[];
    const selected=services.find(service=>service.id===this.googleService)??services[0];
    return html`<div class="provider-intro"><h2>Google</h2><p>Choose a Workspace service to connect with an enrolled account and Cloud project.</p></div>
      ${services.length?html`<mux-ui-select class="service-picker" label="Choose a Google service" .value=${selected.id} .options=${services.map(service=>({value:service.id,label:service.name}))} @change=${(event:Event)=>{this.googleService=(event.target as MuxUISelect).value;this.googleClientID='';this.googleClientSecret='';}}></mux-ui-select>${this.googleDetail(selected)}`:html`<mux-ui-feedback kind="empty">No Google services are available.</mux-ui-feedback>`}`;
  }
  override render() {
    return html`<mux-ui-screen-header section="Services" heading="Customizations"></mux-ui-screen-header>
      <mux-ui-page-intro heading="Customizations" description="Choose an account to make its tools available in new chats."></mux-ui-page-intro>
      <div class="layout"><nav class="catalog" aria-label="Providers">
        <mux-ui-nav-item label="Google" status-tone=${this.providerStatusTone('google')} status-label=${this.providerStatusLabel('google')} ?active=${this.selected==='google'} @click=${()=>this.selectService('google')}></mux-ui-nav-item>
        <mux-ui-nav-item label="Microsoft" status-tone=${this.providerStatusTone('microsoft')} status-label=${this.providerStatusLabel('microsoft')} ?active=${this.selected==='microsoft'} @click=${()=>this.selectService('microsoft')}></mux-ui-nav-item>
        <mux-ui-nav-item label="GitHub" status-tone=${this.providerStatusTone('github')} status-label=${this.providerStatusLabel('github')} ?active=${this.selected==='github'} @click=${()=>this.selectService('github')}></mux-ui-nav-item></nav>
        <main><div class="detail">${this.error?html`<mux-ui-feedback kind="error" appearance="panel">${this.error}<mux-ui-button slot="action" variant="secondary" @click=${this.retry}>Try again</mux-ui-button></mux-ui-feedback>`:nothing}
          ${!this.data||!this.remotes||!this.microsoft?this.error?nothing:html`<mux-ui-feedback kind="loading">Loading connections…</mux-ui-feedback>`:this.selected==='github'?this.githubDetail(this.data.github):this.selected==='microsoft'?this.microsoftDetail():this.googleProviderDetail()}</div></main></div>
      ${this.confirmation?html`<mux-ui-confirmation open .heading=${this.confirmation.heading} .description=${this.confirmation.description}
        .confirmLabel=${this.confirmation.confirmLabel} .busy=${!!this.busy}
        @confirmation-cancel=${this.cancelConfirmation} @confirmation-confirm=${this.confirmConfirmation}></mux-ui-confirmation>`:nothing}`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-connections':MuxConnections } }
