package server

import (
	"html/template"
	"net"
	"net/http"
	"net/url"
)

func connectionSetupSecure(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	address := net.ParseIP(parsed.Hostname())
	return parsed.Scheme == "https" || parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || address != nil && address.IsLoopback())
}

func (server *Server) handleConnectionSetupPage(writer http.ResponseWriter, request *http.Request) {
	owner := server.connectionSetupIdentity(request)
	if owner == "" {
		http.Error(writer, "Sign into this Muxterm in this browser first", http.StatusUnauthorized)
		return
	}
	registry := server.connectionSetups
	registry.mu.Lock()
	setup := registry.owned(request.PathValue("setup"), owner)
	if setup == nil {
		registry.mu.Unlock()
		http.Error(writer, "Setup not found or expired", http.StatusNotFound)
		return
	}
	data := server.connectionSetupPublic(setup)
	delete(data, "credential_handle")
	data["upload_url"] = server.connectionsCallbackBase() + "/api/connections/setups/" + setup.ID + "/credentials"
	data["can_upload"] = connectionSetupSecure(setup.Callback) && (setup.State == "awaiting-credentials" || setup.State == "credentials-ready")
	registry.mu.Unlock()
	nonce, err := randomURLSafeString(24)
	if err != nil {
		http.Error(writer, "Cannot open private setup", http.StatusInternalServerError)
		return
	}
	data["nonce"] = nonce
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'nonce-"+nonce+"'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'")
	_ = connectionSetupPage.Execute(writer, data)
}

var connectionSetupPage = template.Must(template.New("private-connection-setup").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private connection setup · Muxterm</title>
<style nonce="{{.nonce}}">
:root{color-scheme:dark;font:14px/1.6 system-ui,sans-serif;color:#edf1f7;background:#11151c}*{box-sizing:border-box}body{margin:0;padding:32px 20px}main{max-width:640px;margin:auto}header{border-bottom:1px solid #364252;padding-bottom:20px;margin-bottom:24px}h1{font-size:26px;margin:0}h2{font-size:16px;margin:20px 0 4px}p{color:#a0abba;margin:8px 0 16px}code{overflow-wrap:anywhere;font-size:12px}label{display:block;margin:18px 0 6px}input:not([type=checkbox]),select{display:block;width:100%;padding:10px;background:#1b222d;color:#edf1f7;border:1px solid #364252;border-radius:6px;font:inherit}button{font:inherit;padding:10px 16px;border:0;border-radius:6px;background:#a9e9cb;color:#14251d;font-weight:650;cursor:pointer}button:disabled{opacity:.5;cursor:default}a{color:#a9e9cb}.target{border-left:2px solid #a9e9cb;padding-left:14px;margin:14px 0}.target p{margin:2px 0}ul{padding-left:20px}#message{white-space:pre-wrap}#message.error{color:#ffb6ac}input:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid #a9e9cb;outline-offset:3px}[hidden]{display:none!important}
</style></head><body><main>
<header><h1>Private connection setup</h1><p>Review the destination. Keep credentials out of your agent chat.</p></header>
{{range .targets}}<section class="target"><strong>{{.name}}</strong><p>Service: <code>{{.endpoint}}</code></p><p>OAuth issuer: <code>{{.issuer}}</code></p></section>{{end}}
<h2>Register this exact callback</h2><code id="callback">{{.callback_url}}</code>
<h2>Requested scopes</h2><ul>{{range .scopes}}<li><code>{{.}}</code></li>{{end}}</ul>
{{if .notice}}<p>{{.notice}}</p>{{end}}
<p>This setup expires after 15 minutes. Uploading approves only these destinations. It does not sign you in, enable tools, or replace an existing connection.</p>
<p><strong>Pause Browser Assistant before selecting a file or entering credentials.</strong> If this browser is not signed into Muxterm, sign in before continuing. The page contains no third-party scripts.</p>
{{if .can_upload}}
<form id="credentials" data-upload="{{.upload_url}}" autocomplete="off">
<label for="format">Credential format</label><select id="format">{{if eq .provider "google"}}<option value="google-web-json">Google Web OAuth client JSON</option>{{else}}<option value="oauth-client-json">OAuth client JSON (client_id and client_secret)</option>{{end}}<option value="manual">Enter client ID and secret</option></select>
<div id="file-fields"><label for="file">Registration file</label><input id="file" type="file" accept=".json,application/json" required><p>The file is sent directly to this Muxterm, not to the agent. Your original file remains on this computer.</p></div>
<div id="manual-fields" hidden><label for="client-id">Client ID</label><input id="client-id" maxlength="512" autocomplete="off"><label for="client-secret">Client secret</label><input id="client-secret" type="password" maxlength="2048" autocomplete="new-password"></div>
<label><input id="approved" type="checkbox" required> I approve these destinations and scopes, and confirm this client has the exact callback registered.</label>
<button type="submit">Approve credentials</button>
</form>
{{else}}<p>This setup is no longer accepting credentials, or its callback is not HTTPS or localhost. Ask your agent to check its state and deployment URL.</p>{{end}}
<p id="message" role="status" aria-live="polite"></p>
<p>The agent receives only an opaque receipt. After submission, close credential-bearing Cloud Console pages before re-enabling Browser Assistant. Uploaded credentials stay temporarily in server memory; only configured connections are saved to Muxterm’s private credential storage.</p>
<script nonce="{{.nonce}}">
const form=document.getElementById('credentials');
if(form){
const format=document.getElementById('format');
const file=document.getElementById('file');
const clientID=document.getElementById('client-id');
const secret=document.getElementById('client-secret');
const message=document.getElementById('message');
format.addEventListener('change',()=>{const manual=format.value==='manual';document.getElementById('file-fields').hidden=manual;document.getElementById('manual-fields').hidden=!manual;file.required=!manual;clientID.required=manual;secret.required=manual;file.value='';clientID.value='';secret.value='';});
form.addEventListener('submit',async event=>{
event.preventDefault();
const button=form.querySelector('button');button.disabled=true;message.className='';message.textContent='';
try{
let payload={format:format.value,approved:document.getElementById('approved').checked};
if(format.value==='manual'){payload.client_id=clientID.value;payload.client_secret=secret.value;}
else{const selected=file.files[0];if(!selected||selected.size>32768)throw new Error('Choose an OAuth registration JSON file no larger than 32 KiB.');payload.document=await selected.text();}
const response=await fetch(form.dataset.upload,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json','X-Muxterm-Browser-Request':'1'},body:JSON.stringify(payload)});
payload=null;
if(!response.ok)throw new Error(await response.text());
form.reset();form.remove();message.textContent='Credentials approved. Close any secret-bearing pages, then tell your agent to check this setup and finish configuration. Browser access can remain paused.';
}catch(error){file.value='';secret.value='';message.className='error';message.textContent=error.message;button.disabled=false;}
});
}
</script></main></body></html>`))
