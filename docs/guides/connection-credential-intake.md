# Shared OAuth credential intake

Agents can guide app registration without taking custody of client IDs or secrets
in their chat/tool transcripts. The shared workflow supports Google Workspace
presets and compatible generic remote MCP services using pre-registered OAuth
clients. It does not register an app with a provider automatically.

## Agent tools

1. `prepare_connection` fixes the destinations, issuer, scopes and exact callback.
   It returns an authenticated `private_upload_url` and a setup ID valid for
   15 minutes. This is an intake expiry, not a Browser Assistant access timeout.
2. The user pauses Browser Assistant, opens that URL while signed into the same
   Muxterm as the same owner, uploads a file or enters credentials, reviews the
   metadata, and approves. Files come from the browser's computer, not an arbitrary
   server path. The original downloaded file remains on that computer.
3. `check_connection` with `setup_id` returns redacted state and, once approved,
   an opaque `credential_handle`.
4. `configure_connection` takes only `setup_id` and `credential_handle`. It verifies
   public OAuth metadata and saves all selected connections atomically. It creates
   new IDs, never overwrites existing connections, and repeating a successful call
   with the same handle returns the same IDs until expiry.
5. `check_connection` with a returned `connection_id` reads existing authorization
   and tool-discovery state. It does not make a fresh service request. The user
   separately authorizes the account, checks tools, and explicitly enables tools
   through Connections.

Use `cancel_connection_setup` to discard an abandoned setup. It does not remove
configured connections or revoke provider credentials. An expired or canceled
setup requires a fresh private upload. Check state before retrying an uncertain
configuration response; do not create another registration speculatively.

Public-metadata examples:

```json
{"provider":"google","services":["gmail","google-drive"]}
```

```json
{
  "provider":"remote-oauth",
  "name":"Example service",
  "endpoint":"https://mcp.example.com/mcp",
  "issuer_url":"https://identity.example.com",
  "scopes":["service.read"]
}
```

These tools are local to the addressed Muxterm server. They reject nonlocal machine
selection. The browser and agent must resolve to the same authenticated owner; an
agent's server-local token does not impersonate a different signed-in user.

## Private formats

- Google: the downloaded **Web application** OAuth JSON, containing `web.client_id`,
  `web.client_secret` and the exact callback in `web.redirect_uris`. Desktop,
  service-account and wrong-callback files are rejected. Imported endpoint URLs
  are not trusted. Eligibility for Workspace MCP services remains a separate gate.
- Generic remote OAuth: flat JSON containing only `client_id` and `client_secret`.
- Either adapter: manual client ID and secret entry on the private page.

Both fields are currently required by this intake. Public clients without a secret,
dynamic registration, API keys, service accounts and provider-specific credential
formats other than Google's Web JSON are not implemented. Provider-specific browser
guidance can reuse this intake when the connector uses compatible remote OAuth.

## Security boundaries

Upload requires HTTPS or localhost, existing Muxterm authentication, matching owner,
same-origin request and CSRF header, and explicit approval. Plain LAN HTTP is not
accepted for credential upload. The page has a restrictive nonce-based CSP, no
third-party scripts, no framing, no caching and no referrer transmission. Secrets
are never accepted as arguments to these four agent tools. Do not inspect or
screenshot credential-bearing pages, automate secret entry, or read secret files
to verify success. Stop Browser Assistant before private entry and close secret
pages before re-enabling access.

Pending credentials stay in server memory and are discarded on cancellation,
expiry or successful configuration; restart also discards pending setups. This is
not a claim of cryptographic memory erasure. Configured credentials use the existing
private `remote.json` storage (0700 directory, 0600 file), not encryption at rest.
They persist independently of the setup's lifetime. The opaque handle is owner-bound
and is not a provider token, but should still be treated as a temporary capability.

The existing public-HTTPS, DNS/IP pinning, TLS validation and OAuth PKCE metadata
checks remain in force. Metadata discovery happens before the atomic save; failure
leaves the setup retryable without partial connections. No account authorization,
provider tool calls or tool enablement happens during configuration.

This adds owner-bound intake and status receipts, not a server-wide multi-tenant
credential vault. Other existing connection APIs retain their current authorization
model. Do not treat this as full multi-user isolation or protection from agents
with unrestricted filesystem or browser access.
